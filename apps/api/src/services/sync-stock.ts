import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  auditLog,
  box,
  product,
  sale,
  station,
  stockItem,
  stockLevel,
  stockLocation,
  stockMovement,
  syncCursor,
  type Db,
} from '@oto/db';
import {
  WALLET_SPENT_FACT,
  stockSizeName,
  type StockFiledMark,
  type StockLocationType,
  type StockSnapshotEntry,
  type StockSnapshotItem,
} from '@oto/shared';
import { audit } from './audit';
import type { BoxAuth } from './box';
import { raiseAlert } from './ops';
// Read-only use of the landed stock service: the branch's places in the order
// a sale takes from them. `applyMovements` stays the only writer of a level.
import { branchLocations } from './stock';
import type { ApplyResult, BatchScope, PreparedEvent } from './sync';
import type { Exec, Tx } from './tx';

/**
 * S2-14b ROUND 3 — COUNTED STOCK WITH THE LINK DOWN, the platform's half (plan
 * `docs/progress/plans/stock/PLAN.md` §2.4). The S2-14a wallets pattern
 * (`sync-wallet.ts`), for stock.
 *
 * Two things live here, one for each direction:
 *
 *   - THE `stock` CACHE SCOPE (`stockCacheItem`): the branch's level SNAPSHOT
 *     per stocked size and per place — the sell point and the others — with
 *     the platform's FILED MARK for this box (`boxFiled`: its epoch and the
 *     highest journal position applied), so the box subtracts exactly its own
 *     counted sales above the mark — those the levels do not yet reflect.
 *     Volatile (every sale moves it), so it rides neither the
 *     `catalogue` scope nor the bundle's version: a sale never churns the
 *     catalogue hash a box prices from (OD-8).
 *   - THE OVERSOLD CHECK (`withStockOversold`): an offline sale's stock is
 *     taken where the platform takes every sale's — at finalise
 *     (`takeStockForSale`), keyed by the sale's own deterministic line ids, so
 *     a replay, a restart mid-queue or the same sale under a new envelope takes
 *     nothing twice. Finalise never refuses: what the record did not hold is
 *     the movement's `shortfall` and the level floors at zero (0048). This
 *     reads those shortfalls back after each fact that can close a box's sale
 *     and raises ONE `stock_oversold` anomaly with ONE critical alert per short
 *     line and size — item, size, place, box, station, short quantity — the
 *     `wallet_overdraft` pattern. Exactly once: an audit row keyed by the line
 *     and the size is the marker, written in the transaction that raises it,
 *     under an advisory lock; a within-stock replay raises nothing.
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// --- The `stock` cache scope ----------------------------------------------------------

/**
 * THE LEVELS A COUNTER SELLS FROM WITH THE LINK DOWN — one item, applied
 * whole: every live, active stocked size of the branch that stocks a sellable,
 * in the catalogue's size order, with what each live place holds, and the
 * filed mark of this box's journal (`filedMarkOf`). A version of its own that
 * leaves out when it was built.
 *
 * Read in one repeatable-read transaction, so the levels and the box's mark
 * are one instant's: a sale applied between two reads would be in one and not
 * the other, and the box would subtract it twice or not at all.
 */
export async function stockCacheItem(
  db: Db,
  auth: Pick<BoxAuth, 'boxId' | 'operatorId' | 'branchId'>,
  now: Date = new Date(),
): Promise<StockSnapshotItem> {
  return db.transaction((tx) => stockCacheItemIn(tx, auth, now), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

async function stockCacheItemIn(
  db: Exec,
  auth: Pick<BoxAuth, 'boxId' | 'operatorId' | 'branchId'>,
  now: Date,
): Promise<StockSnapshotItem> {
  const locations = await branchLocations(db, auth.branchId);
  const items = await db
    .select()
    .from(stockItem)
    .where(
      and(
        eq(stockItem.operatorId, auth.operatorId),
        eq(stockItem.branchId, auth.branchId),
        eq(stockItem.active, true),
        isNull(stockItem.archivedAt),
        sql`${stockItem.productId} is not null`,
      ),
    );
  const itemIds = items.map((i) => i.id);
  const placeIds = locations.map((l) => l.id);
  const levels =
    itemIds.length && placeIds.length
      ? await db
          .select({ stockItemId: stockLevel.stockItemId, stockLocationId: stockLevel.stockLocationId, quantity: stockLevel.quantity })
          .from(stockLevel)
          .where(and(inArray(stockLevel.stockItemId, itemIds), inArray(stockLevel.stockLocationId, placeIds)))
      : [];
  const productIds = [...new Set(items.map((i) => i.productId!))];
  const products = productIds.length
    ? await db
        .select({ id: product.id, name: product.name, variants: product.variants })
        .from(product)
        .where(inArray(product.id, productIds))
    : [];
  const boxFiled = await filedMarkOf(db, auth.boxId);
  const levelOf = new Map(levels.map((l) => [`${l.stockItemId}|${l.stockLocationId}`, l.quantity]));

  const entries: StockSnapshotEntry[] = [];
  for (const p of [...products].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    const order = new Map((p.variants ?? []).map((v, i) => [v.id, i]));
    const own = items
      .filter((i) => i.productId === p.id)
      .sort(
        (a, b) =>
          (order.get(a.variantId ?? '') ?? -1) - (order.get(b.variantId ?? '') ?? -1) || a.id.localeCompare(b.id),
      );
    for (const i of own) {
      const byPlace: Record<string, number> = {};
      for (const l of locations) byPlace[l.id] = levelOf.get(`${i.id}|${l.id}`) ?? 0;
      entries.push({
        stockItemId: i.id,
        productId: p.id,
        variantId: i.variantId,
        itemName: p.name,
        sizeLabel:
          i.variantLabel ?? (i.variantId ? (p.variants.find((v) => v.id === i.variantId)?.label ?? i.variantId) : null),
        levels: byPlace,
        total: Object.values(byPlace).reduce((sum, q) => sum + q, 0),
      });
    }
  }
  const body = {
    branchId: auth.branchId,
    sellPointId: locations.find((l) => l.sellPoint)?.id ?? null,
    places: locations.map((l) => ({ id: l.id, name: l.name, type: l.type as StockLocationType, sellPoint: l.sellPoint })),
    items: entries,
    boxFiled,
  };
  return {
    version: sha256Hex(JSON.stringify(body)).slice(0, 16),
    generatedAt: now.toISOString(),
    ...body,
  };
}

/**
 * THE FILED MARK the snapshot carries for its box: the box's current journal
 * epoch and the highest position of it the push has applied
 * (`sync_cursor.last_box_seq` — the gapless prefix, moved in the transaction
 * that applies the events, so it never claims a sale whose stock is not yet in
 * the levels read beside it). A position filed aside in quarantine is passed
 * by the mark too: its stock was never taken, and the box stops counting it
 * once the mark is past it. An event applied above a stalled mark is counted
 * by the box until the mark heals — the cautious direction.
 *
 * Read in the snapshot's own repeatable-read transaction, so levels and mark
 * are one instant's. Zero on an epoch nothing has been pushed on yet.
 */
async function filedMarkOf(db: Exec, boxId: string): Promise<StockFiledMark> {
  const [row] = await db
    .select({ journalEpoch: box.currentEpoch, boxSeq: syncCursor.lastBoxSeq })
    .from(box)
    .leftJoin(syncCursor, and(eq(syncCursor.boxId, box.id), eq(syncCursor.journalEpoch, box.currentEpoch)))
    .where(eq(box.id, boxId))
    .limit(1);
  return { journalEpoch: row?.journalEpoch ?? 1, boxSeq: Number(row?.boxSeq ?? 0) };
}

// --- The oversold check ---------------------------------------------------------------

/** The facts that can close a box's sale, and so take its stock: the sale, a later tender, a wallet's credit. */
export const STOCK_CLOSING_FACTS: ReadonlySet<string> = new Set(['sale.finalised', 'payment.recorded', WALLET_SPENT_FACT]);

/** The alert's identity: one per short line and size, so a re-raise is one alert with more sightings. */
export function stockOversoldAlertKey(operatorId: string, saleLineId: string, stockItemId: string): string {
  return `stock.offline_oversold:${operatorId}:${saleLineId}:${stockItemId}`;
}

/** The audit row that marks one short line and size as raised: the exactly-once key. */
const OVERSOLD_AUDIT_ACTION = 'stock.offline_oversold';
const OVERSOLD_ENTITY = 'stock_oversold';
const oversoldEntityId = (saleLineId: string, stockItemId: string) => `${saleLineId}:${stockItemId}`;

interface ShortLine {
  saleLineId: string;
  stockItemId: string;
  stockLocationId: string;
  shortQuantity: number;
  takenQuantity: number;
}

/**
 * THE SALE'S SHORT LINES: per sale line and size, the units the record did not
 * hold (the shortfall the decrement recorded) and what it did take, from the
 * offline-sale movements — with the place the shortfall was recorded at.
 */
async function shortLinesOf(tx: Exec, operatorId: string, saleId: string): Promise<ShortLine[]> {
  const rows = await tx
    .select({
      saleLineId: stockMovement.saleLineId,
      stockItemId: stockMovement.stockItemId,
      stockLocationId: stockMovement.stockLocationId,
      quantity: stockMovement.quantity,
      shortfall: stockMovement.shortfall,
    })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.operatorId, operatorId),
        eq(stockMovement.saleId, saleId),
        eq(stockMovement.kind, 'offline_sale'),
      ),
    )
    .orderBy(asc(stockMovement.saleLineId), asc(stockMovement.stockItemId), asc(stockMovement.stockLocationId));
  const byKey = new Map<string, ShortLine>();
  for (const r of rows) {
    if (!r.saleLineId) continue;
    const key = `${r.saleLineId}|${r.stockItemId}`;
    const entry = byKey.get(key) ?? {
      saleLineId: r.saleLineId,
      stockItemId: r.stockItemId,
      stockLocationId: r.stockLocationId,
      shortQuantity: 0,
      takenQuantity: 0,
    };
    entry.takenQuantity += -r.quantity;
    if (r.shortfall > 0) {
      entry.shortQuantity += r.shortfall;
      entry.stockLocationId = r.stockLocationId;
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()].filter((l) => l.shortQuantity > 0);
}

function saleIdOf(payload: unknown): string | null {
  const id = (payload as { saleId?: unknown } | null)?.saleId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * AFTER A FACT THAT CAN CLOSE A BOX'S SALE: any line of that sale the platform
 * filed short, raised ONCE — an anomaly on this event and a critical alert,
 * naming the item, its size, the place, the box, the station and how many were
 * sold that the record did not hold. A sale within stock, a sale still open,
 * or a shortfall already raised by an earlier push adds nothing.
 *
 * The alert goes on the pool as every alert a handler raises (`BatchScope.db`),
 * best-effort: an alert that cannot be written is logged, never thrown, so it
 * cannot quarantine the paid sale it is about. Its anomaly and audit row name
 * it either way.
 */
export async function withStockOversold(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  type: string,
  payload: unknown,
  result: ApplyResult,
): Promise<ApplyResult> {
  if (!STOCK_CLOSING_FACTS.has(type)) return result;
  const saleId = saleIdOf(payload);
  if (!saleId) return result;
  const operatorId = scope.auth.operatorId;
  const [row] = await tx
    .select({
      id: sale.id,
      operatorId: sale.operatorId,
      branchId: sale.branchId,
      status: sale.status,
      boxId: sale.boxId,
      stationId: sale.stationId,
      receiptNumber: sale.receiptNumber,
    })
    .from(sale)
    .where(eq(sale.id, saleId))
    .limit(1);
  if (!row || row.operatorId !== operatorId || row.status !== 'finalised') return result;
  const short = await shortLinesOf(tx, operatorId, saleId);
  if (short.length === 0) return result;

  const anomalies: NonNullable<ApplyResult['anomalies']> = [];
  const raises: Array<() => Promise<void>> = [];
  const boxName = `${scope.auth.name} (${scope.auth.slot})`;
  for (const line of short) {
    // ONE RAISE PER SHORT LINE AND SIZE, for ever: two pushes of the same
    // close (a lost answer, a store restored, a second fact closing the same
    // sale in one batch) serialise here, and the audit row is the marker.
    const entityId = oversoldEntityId(line.saleLineId, line.stockItemId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stock_oversold:${operatorId}:${entityId}`}, 0))`);
    const [raised] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, OVERSOLD_ENTITY),
          eq(auditLog.entityId, entityId),
          eq(auditLog.action, OVERSOLD_AUDIT_ACTION),
          eq(auditLog.operatorId, operatorId),
        ),
      )
      .limit(1);
    if (raised) continue;

    const [item] = await tx
      .select({ id: stockItem.id, name: stockItem.name, productId: stockItem.productId, variantId: stockItem.variantId, variantLabel: stockItem.variantLabel })
      .from(stockItem)
      .where(eq(stockItem.id, line.stockItemId))
      .limit(1);
    const [productRow] = item?.productId
      ? await tx.select({ name: product.name }).from(product).where(eq(product.id, item.productId)).limit(1)
      : [];
    const [place] = await tx
      .select({ name: stockLocation.name })
      .from(stockLocation)
      .where(eq(stockLocation.id, line.stockLocationId))
      .limit(1);
    const stationId = row.stationId ?? event.envelope.stationId ?? null;
    const [st] = stationId
      ? await tx.select({ name: station.name }).from(station).where(eq(station.id, stationId)).limit(1)
      : [];
    const itemName = productRow?.name ?? item?.name ?? 'An item';
    const sizeLabel = item?.variantLabel ?? null;
    const placeName = place?.name ?? 'the shelf';
    const stationName = st?.name ?? 'a counter';
    const sold = stockSizeName(itemName, sizeLabel);
    // Ordered so the Failures row's first facts are the ones a person reads:
    // what, which size, where, how many short, which box and counter.
    const detail = {
      itemName,
      sizeLabel,
      placeName,
      shortQuantity: line.shortQuantity,
      boxName,
      stationName,
      takenQuantity: line.takenQuantity,
      soldQuantity: line.takenQuantity + line.shortQuantity,
      receiptNumber: row.receiptNumber,
      saleId,
      saleLineId: line.saleLineId,
      stockItemId: line.stockItemId,
      stockLocationId: line.stockLocationId,
      boxId: row.boxId ?? scope.auth.boxId,
      stationId,
    };
    anomalies.push({ kind: 'stock_oversold', detail });
    await audit.record(tx, {
      actorAccountId: event.envelope.actorAccountId ?? null,
      operatorId,
      branchId: row.branchId,
      action: OVERSOLD_AUDIT_ACTION,
      entityType: OVERSOLD_ENTITY,
      entityId,
      actionId: event.envelope.actionId ?? null,
      requestId: null,
      sourceEventId: event.envelope.eventId,
      after: detail,
    });
    raises.push(async () => {
      try {
        await raiseAlert(
          scope.db,
          {
            key: stockOversoldAlertKey(operatorId, line.saleLineId, line.stockItemId),
            category: 'stock.offline_oversold',
            severity: 'critical',
            subject: `${sold} (${boxName})`,
            summary:
              `${line.shortQuantity} ${sold} sold offline at ${stationName} on ${boxName} that the stock record did not hold` +
              `${row.receiptNumber ? ` (receipt ${row.receiptNumber})` : ''} — usually two counters selling the same last units while both were offline. ` +
              `The sale is filed as it was taken and ${placeName} is at zero for it; count the shelf and correct the record.`,
            detail,
            operatorId,
            branchId: row.branchId,
          },
          { flapWindowSeconds: 0 },
        );
      } catch (err) {
        scope.log?.error(
          { err, saleId, stockItemId: line.stockItemId },
          'an offline oversell could not be alerted; its anomaly and audit row name it',
        );
      }
    });
  }
  for (const raise of raises) await raise();
  return anomalies.length ? { ...result, anomalies: [...(result.anomalies ?? []), ...anomalies] } : result;
}

/** The oversold raises recorded for a sale — read by tests and the closing audit. */
export async function stockOversoldRaisesOf(db: Exec, operatorId: string, saleLineId: string, stockItemId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.operatorId, operatorId),
        eq(auditLog.entityType, OVERSOLD_ENTITY),
        eq(auditLog.entityId, oversoldEntityId(saleLineId, stockItemId)),
        eq(auditLog.action, OVERSOLD_AUDIT_ACTION),
      ),
    );
}
