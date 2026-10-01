import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  product,
  saleLine,
  stockAttention,
  stockItem,
  stockLevel,
  stockLocation,
  stockMovement,
  type sale,
  type StockAttentionKind,
  type StockMovementKind,
} from '@oto/db';
import {
  newId,
  STOCK_CASCADE_TYPE_ORDER,
  stockShortMessage,
  stockSizeName,
  stockStatus,
  type ProductStockLink,
  type SaleLineStockShare,
  type SellableStock,
  type StockLevels,
  type StockLocationType,
  type StockMovementView,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { Exec, Tx } from './tx';

/**
 * S2-14b — STOCK: the ledger, its projection, and the two moments a sale meets
 * it. Plan: docs/progress/plans/stock/PLAN.md §2.1-§2.2.
 *
 * THE ONE WRITER. `applyMovements` is the only code that writes
 * `pos.stock_level`, and it writes the level in the same transaction as the
 * `pos.stock_movement` row that moves it — so the level is always the sum of its
 * movements. It locks the levels it touches `FOR UPDATE` in (item id, location
 * id) order — the `allocateReceipt` pattern, one fixed order so two tills never
 * deadlock on the same two shelves — and every movement carries an `action_id`
 * unique per operator, derived from what moved (a sale line, a refund line), so
 * a replay lands on the row that exists and moves nothing twice.
 *
 * THE TWO MOMENTS A SALE MEETS STOCK:
 *
 *   - AT COMMIT, a GUARD (`assertCartStock`): the cart is checked, per size and
 *     honouring an add-on's `variantBreakdown`, against everything this branch
 *     holds — the sell point and every other place, because the cascade will
 *     reach them. A shortage is refused in the counter's words ("Only 3 Grip
 *     Socks S left") and nothing is written. The prototype's guard
 *     (`pages/Till.tsx:2393-2440`) ignored the breakdown; this one does not.
 *   - AT FINALISE, a DECREMENT that NEVER REFUSES (`takeStockForSale`): a card
 *     can be approved long after commit, and an offline sale was paid hours
 *     ago. It takes from the sell point first, then back of house, then bulk
 *     (`STOCK_CASCADE_TYPE_ORDER`), from the levels it holds locked; whatever the
 *     record does not hold is the movement's `shortfall` plus a
 *     `stock_shortfall` attention row. A paid sale is never refused for stock.
 *
 * A REFUND puts back what its restock decision says (`restockForRefund`), to
 * the place each unit was taken from — not always the sell point, which was the
 * prototype's limitation (`mockApi.ts:2876-2960`).
 */

/** Sale-line kinds that can hold stock; admission and fees never sit on a shelf. */
export const STOCKED_LINE_KINDS = new Set(['socks', 'addon', 'merch_item', 'fnb_item']);

type ItemRow = typeof stockItem.$inferSelect;
type LocationRow = typeof stockLocation.$inferSelect;
type SaleRow = typeof sale.$inferSelect;

// --- The writer ------------------------------------------------------------------

/** One movement to write. `quantity` is signed, in eaches. */
export interface MovementDraft {
  stockItemId: string;
  stockLocationId: string;
  kind: StockMovementKind;
  quantity: number;
  /** Units a paid sale could not take from the record (sale kinds only). */
  shortfall?: number;
  /** Unique per operator; derived from what moved, so a replay is a no-op. */
  actionId: string;
  saleId?: string | null;
  saleLineId?: string | null;
  refundId?: string | null;
  purchaseOrderLineId?: string | null;
  stockTakeLineId?: string | null;
  transferId?: string | null;
  reason?: string | null;
  unitCostSatang?: number | null;
}

/** Who moved it, where and when — shared by every movement of one act. */
export interface MovementContext {
  operatorId: string;
  branchId: string;
  businessDate: string;
  occurredAt: Date;
  actorAccountId: string | null;
  stationId?: string | null;
  boxId?: string | null;
  offline?: boolean;
}

export interface AppliedMovement {
  id: string;
  actionId: string;
  stockItemId: string;
  stockLocationId: string;
  kind: StockMovementKind;
  quantity: number;
  shortfall: number;
  levelAfter: number;
}

const pairKey = (itemId: string, locationId: string) => `${itemId}|${locationId}`;

/**
 * Make sure a level row exists for every pair, then lock them all `FOR UPDATE`
 * in (item id, location id) order, and answer what each holds.
 */
export async function lockLevels(
  tx: Tx,
  pairs: ReadonlyArray<{ stockItemId: string; stockLocationId: string }>,
): Promise<Map<string, number>> {
  const unique = [...new Map(pairs.map((p) => [pairKey(p.stockItemId, p.stockLocationId), p])).values()].sort(
    (a, b) =>
      a.stockItemId === b.stockItemId
        ? a.stockLocationId.localeCompare(b.stockLocationId)
        : a.stockItemId.localeCompare(b.stockItemId),
  );
  const levels = new Map<string, number>();
  if (unique.length === 0) return levels;
  for (const pair of unique) {
    await tx
      .insert(stockLevel)
      .values({ id: newId(), stockItemId: pair.stockItemId, stockLocationId: pair.stockLocationId, quantity: 0 })
      .onConflictDoNothing({ target: [stockLevel.stockLocationId, stockLevel.stockItemId] });
  }
  const itemIds = [...new Set(unique.map((p) => p.stockItemId))];
  const locationIds = [...new Set(unique.map((p) => p.stockLocationId))];
  const rows = await tx
    .select({ stockItemId: stockLevel.stockItemId, stockLocationId: stockLevel.stockLocationId, quantity: stockLevel.quantity })
    .from(stockLevel)
    .where(and(inArray(stockLevel.stockItemId, itemIds), inArray(stockLevel.stockLocationId, locationIds)))
    .orderBy(asc(stockLevel.stockItemId), asc(stockLevel.stockLocationId))
    .for('update');
  for (const row of rows) levels.set(pairKey(row.stockItemId, row.stockLocationId), row.quantity);
  return levels;
}

/**
 * THE ONLY WRITER OF `pos.stock_level`. Writes each movement and moves its
 * level in this transaction; a draft whose `action_id` already exists is
 * skipped (a replay), and so is its level change.
 *
 * Refuses — throws — a movement that would take a level below zero. Callers
 * that must never refuse (the finalise decrement) plan within the levels they
 * hold locked, so this is the net under a planning bug, never the answer a
 * paid sale gets.
 */
export async function applyMovements(
  tx: Tx,
  ctx: MovementContext,
  drafts: readonly MovementDraft[],
): Promise<AppliedMovement[]> {
  if (drafts.length === 0) return [];
  const seen = new Set<string>();
  for (const d of drafts) {
    if (seen.has(d.actionId)) throw new Error(`two stock movements in one act share the action id ${d.actionId}`);
    seen.add(d.actionId);
  }
  const existing = await tx
    .select({ actionId: stockMovement.actionId })
    .from(stockMovement)
    .where(and(eq(stockMovement.operatorId, ctx.operatorId), inArray(stockMovement.actionId, [...seen])));
  const done = new Set(existing.map((r) => r.actionId));
  const fresh = drafts
    .filter((d) => !done.has(d.actionId))
    .sort((a, b) =>
      a.stockItemId === b.stockItemId
        ? a.stockLocationId.localeCompare(b.stockLocationId)
        : a.stockItemId.localeCompare(b.stockItemId),
    );
  if (fresh.length === 0) return [];

  const levels = await lockLevels(tx, fresh);
  const applied: AppliedMovement[] = [];
  for (const d of fresh) {
    if (!Number.isInteger(d.quantity) || !Number.isInteger(d.shortfall ?? 0)) {
      throw errors.badRequest('Stock moves in whole items only', { actionId: d.actionId });
    }
    const key = pairKey(d.stockItemId, d.stockLocationId);
    const before = levels.get(key) ?? 0;
    const after = before + d.quantity;
    if (after < 0) {
      throw errors.conflict('STOCK_LEVEL_NEGATIVE', 'That would take a shelf below nothing — nothing was moved', {
        stockItemId: d.stockItemId,
        stockLocationId: d.stockLocationId,
        level: before,
        quantity: d.quantity,
      });
    }
    const id = newId();
    const inserted = await tx
      .insert(stockMovement)
      .values({
        id,
        operatorId: ctx.operatorId,
        branchId: ctx.branchId,
        stockItemId: d.stockItemId,
        stockLocationId: d.stockLocationId,
        kind: d.kind,
        quantity: d.quantity,
        levelAfter: after,
        shortfall: d.shortfall ?? 0,
        actionId: d.actionId,
        saleId: d.saleId ?? null,
        saleLineId: d.saleLineId ?? null,
        refundId: d.refundId ?? null,
        purchaseOrderLineId: d.purchaseOrderLineId ?? null,
        stockTakeLineId: d.stockTakeLineId ?? null,
        transferId: d.transferId ?? null,
        reason: d.reason ?? null,
        unitCostSatang: d.unitCostSatang ?? null,
        businessDate: ctx.businessDate,
        actorAccountId: ctx.actorAccountId,
        stationId: ctx.stationId ?? null,
        boxId: ctx.boxId ?? null,
        offline: ctx.offline ?? false,
        occurredAt: ctx.occurredAt,
      })
      .onConflictDoNothing({ target: [stockMovement.operatorId, stockMovement.actionId] })
      .returning({ id: stockMovement.id });
    // Lost a race to the same action id: the other writer moved the level.
    if (!inserted[0]) continue;
    if (d.quantity !== 0) {
      await tx
        .update(stockLevel)
        .set({ quantity: after, updatedAt: ctx.occurredAt })
        .where(and(eq(stockLevel.stockItemId, d.stockItemId), eq(stockLevel.stockLocationId, d.stockLocationId)));
    }
    levels.set(key, after);
    applied.push({
      id,
      actionId: d.actionId,
      stockItemId: d.stockItemId,
      stockLocationId: d.stockLocationId,
      kind: d.kind,
      quantity: d.quantity,
      shortfall: d.shortfall ?? 0,
      levelAfter: after,
    });
  }
  return applied;
}

// --- Places -------------------------------------------------------------------------

function typeRank(type: string): number {
  const at = STOCK_CASCADE_TYPE_ORDER.indexOf(type as StockLocationType);
  return at === -1 ? STOCK_CASCADE_TYPE_ORDER.length : at;
}

/**
 * The branch's live places, in the order a sale takes from them: the sell point,
 * then back of house, then bulk, then any other rotation shelf (plan §2.2), and
 * by name within a type so the order is the same every time.
 */
export async function branchLocations(db: Exec, branchId: string): Promise<LocationRow[]> {
  const rows = await db
    .select()
    .from(stockLocation)
    .where(and(eq(stockLocation.branchId, branchId), eq(stockLocation.active, true), isNull(stockLocation.archivedAt)));
  return rows.sort((a, b) => {
    if (a.sellPoint !== b.sellPoint) return a.sellPoint ? -1 : 1;
    const rank = typeRank(a.type) - typeRank(b.type);
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/**
 * What the branch holds of each item: everywhere (`available`, the guard's
 * number) and at the sell point. Read without a lock — it is a check, and the
 * race it cannot see is the finalise decrement's to record.
 */
export async function availableFor(
  db: Exec,
  branchId: string,
  stockItemIds: readonly string[],
): Promise<Map<string, { available: number; atSellPoint: number }>> {
  const out = new Map<string, { available: number; atSellPoint: number }>();
  for (const id of stockItemIds) out.set(id, { available: 0, atSellPoint: 0 });
  if (stockItemIds.length === 0) return out;
  const rows = await db
    .select({
      stockItemId: stockLevel.stockItemId,
      quantity: stockLevel.quantity,
      sellPoint: stockLocation.sellPoint,
    })
    .from(stockLevel)
    .innerJoin(stockLocation, eq(stockLocation.id, stockLevel.stockLocationId))
    .where(
      and(
        inArray(stockLevel.stockItemId, [...stockItemIds]),
        eq(stockLocation.branchId, branchId),
        eq(stockLocation.active, true),
        isNull(stockLocation.archivedAt),
      ),
    );
  for (const row of rows) {
    const entry = out.get(row.stockItemId) ?? { available: 0, atSellPoint: 0 };
    entry.available += row.quantity;
    if (row.sellPoint) entry.atSellPoint += row.quantity;
    out.set(row.stockItemId, entry);
  }
  return out;
}

// --- A sale line's stock --------------------------------------------------------------

/** The part of a sale line the stock rules read. */
export interface StockLineInput {
  /** The line's id once written; absent at the guard. */
  id?: string;
  kind: string;
  productId: string | null;
  quantity: number;
  label?: string;
  payload: unknown;
}

interface LinePayloadView {
  variant?: { variantId: string; variantLabel?: string };
  variantBreakdown?: { variantId: string; variantLabel?: string; quantity: number }[];
  stock?: SaleLineStockShare[];
}

export interface LineStock {
  shares: SaleLineStockShare[];
  /**
   * Units of a stock-tracked product the line does not say the size of — an
   * add-on sold in sizes with no breakdown, or a breakdown short of the line.
   */
  unsized: number;
  /** A breakdown that names more units than the line sells. */
  oversized: number;
  /** The sizes, by label where the line carried one, that this branch does not stock. */
  unknownSizes: string[];
  /** How many units those unknown sizes account for. */
  unknownUnits: number;
  productId: string | null;
  productName: string | null;
}

export interface StockCatalogue {
  /** Live, active stock items of this branch, by product. */
  itemsByProduct: Map<string, ItemRow[]>;
  itemsById: Map<string, ItemRow>;
  productNames: Map<string, string>;
  /** Each product's size ids in the catalogue's order, for listing sizes the way the counter sees them. */
  sizeOrder: Map<string, string[]>;
}

/** The branch's stock items for these products — what a cart's lines resolve against. */
export async function loadStockCatalogue(
  db: Exec,
  branchId: string,
  productIds: readonly string[],
): Promise<StockCatalogue> {
  const ids = [...new Set(productIds)];
  const itemsByProduct = new Map<string, ItemRow[]>();
  const itemsById = new Map<string, ItemRow>();
  const productNames = new Map<string, string>();
  const sizeOrder = new Map<string, string[]>();
  if (ids.length === 0) return { itemsByProduct, itemsById, productNames, sizeOrder };
  const items = await db
    .select()
    .from(stockItem)
    .where(
      and(
        eq(stockItem.branchId, branchId),
        inArray(stockItem.productId, ids),
        eq(stockItem.active, true),
        isNull(stockItem.archivedAt),
      ),
    );
  for (const item of items) {
    itemsById.set(item.id, item);
    const list = itemsByProduct.get(item.productId!) ?? [];
    list.push(item);
    itemsByProduct.set(item.productId!, list);
  }
  const products = await db
    .select({ id: product.id, name: product.name, variants: product.variants })
    .from(product)
    .where(inArray(product.id, ids));
  for (const p of products) {
    productNames.set(p.id, p.name);
    sizeOrder.set(p.id, (p.variants ?? []).map((v) => v.id));
  }
  return { itemsByProduct, itemsById, productNames, sizeOrder };
}

/**
 * Which stocked sizes one sale line takes, and how many of each.
 *
 *   - an add-on with a `variantBreakdown` takes each size it names (the
 *     prototype's `recordSale`, `mockApi.ts:1316-1330`);
 *   - a shop or F&B line with a size takes that size;
 *   - anything else takes the product's one-size item.
 *
 * A product with no stock item at this branch is not stock-tracked and the
 * line takes nothing — the prototype's "no `inventoryItemId`" (`types.ts:216`).
 */
export function lineStock(line: StockLineInput, catalogue: StockCatalogue): LineStock {
  const empty: LineStock = {
    shares: [],
    unsized: 0,
    oversized: 0,
    unknownSizes: [],
    unknownUnits: 0,
    productId: line.productId,
    productName: line.productId ? (catalogue.productNames.get(line.productId) ?? null) : null,
  };
  if (!line.productId || !STOCKED_LINE_KINDS.has(line.kind) || line.quantity <= 0) return empty;
  const items = catalogue.itemsByProduct.get(line.productId);
  if (!items || items.length === 0) return empty;
  const payload = (line.payload ?? {}) as LinePayloadView;
  const share = (item: ItemRow, quantity: number): SaleLineStockShare => ({
    stockItemId: item.id,
    variantId: item.variantId,
    quantity,
    unitCostSatang: item.unitCostSatang,
  });
  const oneSize = items.find((i) => i.variantId === null);
  const sized = (variantId: string) => items.find((i) => i.variantId === variantId);

  const breakdown = (payload.variantBreakdown ?? []).filter((b) => b.quantity > 0);
  if (breakdown.length > 0) {
    const result: LineStock = { ...empty, shares: [] };
    let named = 0;
    for (const b of breakdown) {
      const item = sized(b.variantId) ?? (b.variantId === 'default' ? oneSize : undefined);
      named += b.quantity;
      if (!item) {
        result.unknownSizes.push(b.variantLabel?.trim() || b.variantId);
        result.unknownUnits += b.quantity;
        continue;
      }
      // One share per stock item, however the breakdown spelled it.
      const twin = result.shares.find((s) => s.stockItemId === item.id);
      if (twin) twin.quantity += b.quantity;
      else result.shares.push(share(item, b.quantity));
    }
    if (named < line.quantity) result.unsized = line.quantity - named;
    if (named > line.quantity) result.oversized = named - line.quantity;
    return result;
  }
  const variantId = payload.variant?.variantId;
  if (variantId) {
    const item = sized(variantId) ?? oneSize;
    if (item) return { ...empty, shares: [share(item, line.quantity)] };
    return {
      ...empty,
      unknownSizes: [payload.variant?.variantLabel?.trim() || variantId],
      unknownUnits: line.quantity,
    };
  }
  if (oneSize) return { ...empty, shares: [share(oneSize, line.quantity)] };
  return { ...empty, unsized: line.quantity };
}

/** Sizes the counter can choose from, for a refusal: "S, M, L". */
function sizeList(catalogue: StockCatalogue, productId: string | null): string {
  const items = productId ? (catalogue.itemsByProduct.get(productId) ?? []) : [];
  const order = (productId && catalogue.sizeOrder.get(productId)) || [];
  const rank = (variantId: string | null) => {
    const at = variantId ? order.indexOf(variantId) : -1;
    return at < 0 ? order.length : at;
  };
  return [...items]
    .sort((a, b) => rank(a.variantId) - rank(b.variantId))
    .filter((i) => i.variantLabel)
    .map((i) => i.variantLabel!)
    .join(', ');
}

/**
 * THE GUARD AT COMMIT. Refuses, in the counter's words and before anything is
 * written, a cart this branch cannot fill — per size, honouring an add-on's
 * breakdown, counting every place the cascade will reach.
 */
export async function assertCartStock(
  db: Exec,
  branchId: string,
  lines: readonly StockLineInput[],
): Promise<void> {
  const catalogue = await loadStockCatalogue(
    db,
    branchId,
    lines.flatMap((l) => (l.productId && STOCKED_LINE_KINDS.has(l.kind) ? [l.productId] : [])),
  );
  if (catalogue.itemsById.size === 0) return;
  const demand = new Map<string, number>();
  const sizeProblems: string[] = [];
  for (const line of lines) {
    const resolved = lineStock(line, catalogue);
    const name = resolved.productName ?? line.label ?? 'This item';
    if (resolved.unknownSizes.length > 0) {
      sizeProblems.push(
        `${name} has no size ${resolved.unknownSizes.join(', ')} in stock here — it comes in ${sizeList(catalogue, line.productId)}`,
      );
    }
    if (resolved.unsized > 0) {
      sizeProblems.push(`Choose a size for ${name} — it comes in ${sizeList(catalogue, line.productId)}`);
    }
    if (resolved.oversized > 0) {
      sizeProblems.push(`The sizes chosen for ${name} add up to more than the ${line.quantity} on the line`);
    }
    for (const s of resolved.shares) demand.set(s.stockItemId, (demand.get(s.stockItemId) ?? 0) + s.quantity);
  }
  if (sizeProblems.length > 0) {
    throw errors.conflict('STOCK_SIZE_REQUIRED', `${sizeProblems.join('. ')}. Nothing was saved.`, {
      problems: sizeProblems,
    });
  }
  const held = await availableFor(db, branchId, [...demand.keys()]);
  const shortages: { stockItemId: string; name: string; requested: number; available: number }[] = [];
  for (const [stockItemId, requested] of demand) {
    const available = held.get(stockItemId)?.available ?? 0;
    if (requested <= available) continue;
    const item = catalogue.itemsById.get(stockItemId)!;
    const productName = (item.productId && catalogue.productNames.get(item.productId)) || item.name;
    shortages.push({ stockItemId, name: stockSizeName(productName, item.variantLabel), requested, available });
  }
  if (shortages.length > 0) {
    throw errors.conflict(
      'STOCK_SHORT',
      `${shortages.map((s) => stockShortMessage(s.name, s.available)).join('. ')}. Nothing was saved.`,
      { shortages },
    );
  }
}

/** The shares a line freezes onto its payload at commit, or none when nothing is stocked. */
export async function stockSharesForLines(
  db: Exec,
  branchId: string,
  lines: readonly StockLineInput[],
): Promise<Array<SaleLineStockShare[] | null>> {
  const catalogue = await loadStockCatalogue(
    db,
    branchId,
    lines.flatMap((l) => (l.productId && STOCKED_LINE_KINDS.has(l.kind) ? [l.productId] : [])),
  );
  return lines.map((line) => {
    const shares = lineStock(line, catalogue).shares;
    return shares.length > 0 ? shares : null;
  });
}

// --- Attention ------------------------------------------------------------------------

async function raiseStockAttention(
  tx: Tx,
  input: {
    operatorId: string;
    branchId: string;
    stockItemId: string | null;
    kind: StockAttentionKind;
    dedupeKey: string;
    quantity: number;
    summary: string;
    detail: unknown;
    saleId?: string | null;
    saleLineId?: string | null;
  },
): Promise<void> {
  const inserted = await tx
    .insert(stockAttention)
    .values({
      id: newId(),
      operatorId: input.operatorId,
      branchId: input.branchId,
      stockItemId: input.stockItemId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      quantity: input.quantity,
      summary: input.summary,
      detail: input.detail as never,
      saleId: input.saleId ?? null,
      saleLineId: input.saleLineId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: stockAttention.id });
  if (inserted[0]) return;
  await tx
    .update(stockAttention)
    .set({ occurrences: sql`${stockAttention.occurrences} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(stockAttention.operatorId, input.operatorId),
        eq(stockAttention.dedupeKey, input.dedupeKey),
        isNull(stockAttention.resolvedAt),
      ),
    );
}

// --- The decrement at finalise -----------------------------------------------------------

export interface TakeStockResult {
  movements: AppliedMovement[];
  shortfalls: { saleLineId: string; stockItemId: string; shortfall: number }[];
  unsized: { saleLineId: string; quantity: number }[];
}

/**
 * THE DECREMENT, at both finalise points (`commitSale`'s ฿0 close and
 * `finaliseSale`). NEVER REFUSES: it takes what the record holds, in the
 * cascade order, and records the rest as a shortfall to look at.
 *
 * Once per line: a line that already has movements is skipped, and every
 * movement's action id is `sale:<sale line>:<stock item>:<location>`, derived
 * from the deterministic sale-line id — so a replayed finalise, a retried
 * press or a box's offline sale arriving twice moves nothing twice.
 */
export async function takeStockForSale(
  tx: Tx,
  saleRow: SaleRow,
  ctx: { actorAccountId: string | null; requestId?: string | null; offline: boolean; now: Date },
): Promise<TakeStockResult> {
  const result: TakeStockResult = { movements: [], shortfalls: [], unsized: [] };
  const lines = await tx
    .select({
      id: saleLine.id,
      kind: saleLine.kind,
      productId: saleLine.productId,
      quantity: saleLine.quantity,
      label: saleLine.label,
      payload: saleLine.payload,
      lineNo: saleLine.lineNo,
    })
    .from(saleLine)
    .where(eq(saleLine.saleId, saleRow.id))
    .orderBy(asc(saleLine.lineNo));
  const stocked = lines.filter((l) => l.productId && STOCKED_LINE_KINDS.has(l.kind) && l.quantity > 0);
  if (stocked.length === 0) return result;

  const already = await tx
    .selectDistinct({ saleLineId: stockMovement.saleLineId })
    .from(stockMovement)
    .where(eq(stockMovement.saleId, saleRow.id));
  const moved = new Set(already.map((r) => r.saleLineId));
  const todo = stocked.filter((l) => !moved.has(l.id));
  if (todo.length === 0) return result;

  // The shares frozen at commit where the line carries them; resolved now for
  // a line committed before the shares existed.
  const catalogue = await loadStockCatalogue(tx, saleRow.branchId, todo.map((l) => l.productId!));
  const plans = todo.map((line) => {
    const frozen = (line.payload as LinePayloadView | null)?.stock;
    if (Array.isArray(frozen) && frozen.length > 0) {
      return { line, shares: frozen, unsized: 0 };
    }
    const resolved = lineStock(line, catalogue);
    return { line, shares: resolved.shares, unsized: resolved.unsized + resolved.unknownUnits };
  });
  const itemIds = [...new Set(plans.flatMap((p) => p.shares.map((s) => s.stockItemId)))];
  const locations = await branchLocations(tx, saleRow.branchId);
  const levels = await lockLevels(
    tx,
    itemIds.flatMap((stockItemId) => locations.map((loc) => ({ stockItemId, stockLocationId: loc.id }))),
  );
  const sellPoint = locations.find((l) => l.sellPoint) ?? null;
  const kind: StockMovementKind = ctx.offline ? 'offline_sale' : 'sale';

  const drafts: MovementDraft[] = [];
  const shortfallsToRaise: { line: (typeof todo)[number]; share: SaleLineStockShare; shortfall: number }[] = [];
  for (const plan of plans) {
    for (const s of plan.shares) {
      let remaining = s.quantity;
      const lineDrafts: MovementDraft[] = [];
      for (const loc of locations) {
        if (remaining <= 0) break;
        const key = pairKey(s.stockItemId, loc.id);
        const level = levels.get(key) ?? 0;
        const take = Math.min(level, remaining);
        if (take <= 0) continue;
        levels.set(key, level - take);
        remaining -= take;
        lineDrafts.push({
          stockItemId: s.stockItemId,
          stockLocationId: loc.id,
          kind,
          quantity: -take,
          actionId: `sale:${plan.line.id}:${s.stockItemId}:${loc.id}`,
          saleId: saleRow.id,
          saleLineId: plan.line.id,
          unitCostSatang: s.unitCostSatang,
        });
      }
      if (remaining > 0) {
        // What the record did not hold is recorded where the sale takes from
        // first: the sell point, or the first place in the cascade.
        const where = sellPoint ?? locations[0] ?? null;
        if (where) {
          const existing = lineDrafts.find((d) => d.stockLocationId === where.id);
          if (existing) existing.shortfall = remaining;
          else {
            lineDrafts.push({
              stockItemId: s.stockItemId,
              stockLocationId: where.id,
              kind,
              quantity: 0,
              shortfall: remaining,
              actionId: `sale:${plan.line.id}:${s.stockItemId}:${where.id}`,
              saleId: saleRow.id,
              saleLineId: plan.line.id,
              unitCostSatang: s.unitCostSatang,
            });
          }
        }
        shortfallsToRaise.push({ line: plan.line, share: s, shortfall: remaining });
      }
      drafts.push(...lineDrafts);
    }
    if (plan.unsized > 0) result.unsized.push({ saleLineId: plan.line.id, quantity: plan.unsized });
  }

  const mctx: MovementContext = {
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    businessDate: saleRow.businessDate,
    occurredAt: ctx.now,
    actorAccountId: ctx.actorAccountId,
    stationId: saleRow.stationId,
    boxId: saleRow.boxId,
    offline: ctx.offline,
  };
  result.movements = await applyMovements(tx, mctx, drafts);

  for (const { line, share, shortfall } of shortfallsToRaise) {
    const item = catalogue.itemsById.get(share.stockItemId);
    const name = item
      ? stockSizeName((item.productId && catalogue.productNames.get(item.productId)) || item.name, item.variantLabel)
      : line.label;
    result.shortfalls.push({ saleLineId: line.id, stockItemId: share.stockItemId, shortfall });
    await raiseStockAttention(tx, {
      operatorId: saleRow.operatorId,
      branchId: saleRow.branchId,
      stockItemId: share.stockItemId,
      kind: 'stock_shortfall',
      dedupeKey: `shortfall:${line.id}:${share.stockItemId}`,
      quantity: shortfall,
      summary: `${shortfall} ${name} sold that the record did not hold${ctx.offline ? ' (sold offline)' : ''} — count the shelf`,
      detail: { saleId: saleRow.id, saleLineId: line.id, requested: share.quantity, shortfall, offline: ctx.offline },
      saleId: saleRow.id,
      saleLineId: line.id,
    });
  }
  for (const u of result.unsized) {
    const line = todo.find((l) => l.id === u.saleLineId)!;
    await raiseStockAttention(tx, {
      operatorId: saleRow.operatorId,
      branchId: saleRow.branchId,
      stockItemId: null,
      kind: 'size_unknown',
      dedupeKey: `size_unknown:${line.id}`,
      quantity: u.quantity,
      summary: `${u.quantity} ${line.label} sold with no size named, or a size not stocked here — nothing was taken off a shelf for them`,
      detail: { saleId: saleRow.id, saleLineId: line.id },
      saleId: saleRow.id,
      saleLineId: line.id,
    });
  }

  if (result.movements.length > 0 || result.shortfalls.length > 0 || result.unsized.length > 0) {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId,
      operatorId: saleRow.operatorId,
      branchId: saleRow.branchId,
      action: ctx.offline ? 'stock.offline_sale' : 'stock.sale',
      entityType: 'sale',
      entityId: saleRow.id,
      requestId: ctx.requestId ?? null,
      after: {
        movements: result.movements.map((m) => ({
          stockItemId: m.stockItemId,
          stockLocationId: m.stockLocationId,
          quantity: m.quantity,
          shortfall: m.shortfall,
          levelAfter: m.levelAfter,
        })),
        shortfalls: result.shortfalls,
        unsized: result.unsized,
      },
    });
  }
  return result;
}

// --- The restock on a refund -------------------------------------------------------------

/**
 * Put back what a refund's restock decision returns (`restockLineIds`,
 * `@oto/shared/refund.ts`) — to the PLACE each unit was taken from, the
 * sale's own movements read back. A unit the sale recorded as a shortfall goes
 * back where the shortfall was recorded (the sell point): the guest is handing
 * a real thing over the counter.
 *
 * Once per sale line, whichever refund carries it: the action id is
 * `restock:<sale line>:<stock item>:<location>`. A line sold before the ledger
 * existed has no movements and puts nothing back (OD-S5).
 */
export async function restockForRefund(
  tx: Tx,
  input: {
    operatorId: string;
    branchId: string;
    saleId: string;
    refundId: string;
    saleLineIds: readonly string[];
    businessDate: string;
    stationId: string | null;
    actorAccountId: string;
    requestId?: string | null;
    now: Date;
  },
): Promise<AppliedMovement[]> {
  if (input.saleLineIds.length === 0) return [];
  const taken = await tx
    .select({
      saleLineId: stockMovement.saleLineId,
      stockItemId: stockMovement.stockItemId,
      stockLocationId: stockMovement.stockLocationId,
      quantity: stockMovement.quantity,
      shortfall: stockMovement.shortfall,
      unitCostSatang: stockMovement.unitCostSatang,
    })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.saleId, input.saleId),
        inArray(stockMovement.saleLineId, [...input.saleLineIds]),
        inArray(stockMovement.kind, ['sale', 'offline_sale']),
      ),
    );
  const drafts: MovementDraft[] = [];
  for (const row of taken) {
    const back = -row.quantity + row.shortfall;
    if (back <= 0) continue;
    drafts.push({
      stockItemId: row.stockItemId,
      stockLocationId: row.stockLocationId,
      kind: 'refund',
      quantity: back,
      actionId: `restock:${row.saleLineId}:${row.stockItemId}:${row.stockLocationId}`,
      saleId: input.saleId,
      saleLineId: row.saleLineId,
      refundId: input.refundId,
      unitCostSatang: row.unitCostSatang,
    });
  }
  const applied = await applyMovements(
    tx,
    {
      operatorId: input.operatorId,
      branchId: input.branchId,
      businessDate: input.businessDate,
      occurredAt: input.now,
      actorAccountId: input.actorAccountId,
      stationId: input.stationId,
    },
    drafts,
  );
  if (applied.length > 0) {
    await audit.record(tx, {
      actorAccountId: input.actorAccountId,
      operatorId: input.operatorId,
      branchId: input.branchId,
      action: 'stock.refund',
      entityType: 'refund',
      entityId: input.refundId,
      requestId: input.requestId ?? null,
      after: {
        saleId: input.saleId,
        movements: applied.map((m) => ({
          stockItemId: m.stockItemId,
          stockLocationId: m.stockLocationId,
          quantity: m.quantity,
          levelAfter: m.levelAfter,
        })),
      },
    });
  }
  return applied;
}

// --- The catalogue link ------------------------------------------------------------------

/** Every live link from this branch's stock items to products, by product. */
export async function productStockLinks(
  db: Exec,
  branchId: string,
  productIds: readonly string[],
): Promise<Map<string, ProductStockLink[]>> {
  const out = new Map<string, ProductStockLink[]>();
  if (productIds.length === 0) return out;
  const rows = await db
    .select({ id: stockItem.id, productId: stockItem.productId, variantId: stockItem.variantId })
    .from(stockItem)
    .where(and(eq(stockItem.branchId, branchId), inArray(stockItem.productId, [...productIds]), isNull(stockItem.archivedAt)))
    .orderBy(asc(stockItem.variantId), asc(stockItem.id));
  for (const row of rows) {
    const list = out.get(row.productId!) ?? [];
    list.push({ variantId: row.variantId, stockItemId: row.id });
    out.set(row.productId!, list);
  }
  return out;
}

/**
 * WRITE a product's stock links at one branch: the list given replaces the
 * product's links there. Each stock item must be this branch's, live, and not
 * already stocking another product; each size must be one of the product's
 * own (`product.variants`), or null for a product in one size. The product's
 * own `stock_item_id` — the prototype's "set = tracked" marker — follows: the
 * one-size link, else the first size's, else null.
 */
export async function setProductStockLinks(
  tx: Tx,
  scope: { operatorId: string; branchId: string; accountId: string; requestId?: string | null },
  productRow: typeof product.$inferSelect,
  links: readonly ProductStockLink[],
): Promise<ProductStockLink[]> {
  const sizes = new Set((productRow.variants ?? []).map((v) => v.id));
  const seenSizes = new Set<string>();
  const seenItems = new Set<string>();
  for (const link of links) {
    const size = link.variantId ?? '';
    if (seenSizes.has(size)) {
      throw errors.badRequest(`"${productRow.name}" is linked to two stock items for the same size`, { variantId: link.variantId });
    }
    seenSizes.add(size);
    if (seenItems.has(link.stockItemId)) {
      throw errors.badRequest('One stock item cannot stock two sizes', { stockItemId: link.stockItemId });
    }
    seenItems.add(link.stockItemId);
    if (link.variantId !== null && !sizes.has(link.variantId)) {
      throw errors.badRequest(`"${productRow.name}" has no size "${link.variantId}"`, { variantId: link.variantId });
    }
  }
  const items = links.length
    ? await tx
        .select()
        .from(stockItem)
        .where(and(inArray(stockItem.id, links.map((l) => l.stockItemId)), eq(stockItem.operatorId, scope.operatorId)))
        // In id order, and NO KEY: a concurrent finalise holds these rows FOR KEY
        // SHARE through the level and movement foreign keys, which a plain FOR
        // UPDATE would wait on (and could deadlock with across two sizes). The
        // finalise must never be the one chosen to fail.
        .orderBy(asc(stockItem.id))
        .for('no key update')
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const link of links) {
    const item = byId.get(link.stockItemId);
    if (!item || item.archivedAt || item.branchId !== scope.branchId) {
      throw errors.badRequest('That stock item is not one of this branch’s', { stockItemId: link.stockItemId });
    }
    if (item.productId && item.productId !== productRow.id) {
      throw errors.conflict('STOCK_ITEM_LINKED', `"${item.name}" already stocks another item — unlink it there first`, {
        stockItemId: item.id,
        productId: item.productId,
      });
    }
  }
  const before = (await productStockLinks(tx, scope.branchId, [productRow.id])).get(productRow.id) ?? [];
  // Unlink first, so a size moving from one stock item to another never meets
  // `stock_item_sellable_unique` half-way.
  await tx
    .update(stockItem)
    .set({ productId: null, variantId: null, variantLabel: null, updatedAt: new Date() })
    .where(and(eq(stockItem.branchId, scope.branchId), eq(stockItem.productId, productRow.id)));
  for (const link of links) {
    const label = link.variantId ? (productRow.variants.find((v) => v.id === link.variantId)?.label ?? null) : null;
    await tx
      .update(stockItem)
      .set({ productId: productRow.id, variantId: link.variantId, variantLabel: label, updatedAt: new Date() })
      .where(eq(stockItem.id, link.stockItemId));
  }
  const marker = links.find((l) => l.variantId === null) ?? links[0] ?? null;
  await tx
    .update(product)
    .set({ stockItemId: marker?.stockItemId ?? null, updatedAt: new Date() })
    .where(eq(product.id, productRow.id));
  await audit.record(tx, {
    actorAccountId: scope.accountId,
    operatorId: scope.operatorId,
    branchId: scope.branchId,
    action: 'product.stock_links',
    entityType: 'product',
    entityId: productRow.id,
    requestId: scope.requestId ?? null,
    before: { links: before },
    after: { links },
  });
  return [...links];
}

// --- What the till reads -------------------------------------------------------------------

/**
 * Every stock-tracked product at the branch, each size with what the branch
 * holds of it — the answer the till's grids, its size pickers and its guard
 * read (`GET /branches/:branchId/stock/sellable`).
 */
export async function sellableStock(db: Exec, operatorId: string, branchId: string): Promise<SellableStock> {
  const items = await db
    .select()
    .from(stockItem)
    .where(
      and(
        eq(stockItem.operatorId, operatorId),
        eq(stockItem.branchId, branchId),
        eq(stockItem.active, true),
        isNull(stockItem.archivedAt),
        sql`${stockItem.productId} is not null`,
      ),
    );
  const locations = await branchLocations(db, branchId);
  const sellPoint = locations.find((l) => l.sellPoint) ?? null;
  const held = await availableFor(
    db,
    branchId,
    items.map((i) => i.id),
  );
  const productIds = [...new Set(items.map((i) => i.productId!))];
  const products = productIds.length
    ? await db
        .select({ id: product.id, name: product.name, variants: product.variants })
        .from(product)
        .where(inArray(product.id, productIds))
    : [];
  const out: SellableStock = { branchId, sellPointId: sellPoint?.id ?? null, products: [] };
  for (const p of products.sort((a, b) => a.name.localeCompare(b.name))) {
    const order = new Map(p.variants.map((v, i) => [v.id, i]));
    const own = items
      .filter((i) => i.productId === p.id)
      .sort((a, b) => (order.get(a.variantId ?? '') ?? -1) - (order.get(b.variantId ?? '') ?? -1));
    out.products.push({
      productId: p.id,
      name: p.name,
      sizes: own.map((i) => {
        const h = held.get(i.id) ?? { available: 0, atSellPoint: 0 };
        return {
          variantId: i.variantId,
          label: i.variantLabel ?? (i.variantId ? (p.variants.find((v) => v.id === i.variantId)?.label ?? i.variantId) : null),
          stockItemId: i.id,
          available: h.available,
          atSellPoint: h.atSellPoint,
          lowStockThreshold: i.lowStockThreshold,
          status: stockStatus(h.available, i.lowStockThreshold),
        };
      }),
    });
  }
  return out;
}

/** The branch's items with what each place holds — the stock screens' read. */
export async function stockLevelsOf(
  db: Exec,
  operatorId: string,
  branchId: string,
  /** Cost per each is answered only to a manager (`StockPlaceViewSchema`'s note). */
  view: { withCost: boolean },
): Promise<StockLevels> {
  const items = await db
    .select()
    .from(stockItem)
    .where(and(eq(stockItem.operatorId, operatorId), eq(stockItem.branchId, branchId), isNull(stockItem.archivedAt)))
    .orderBy(asc(stockItem.name), asc(stockItem.variantId));
  const locations = await branchLocations(db, branchId);
  const levels = items.length
    ? await db
        .select()
        .from(stockLevel)
        .where(inArray(stockLevel.stockItemId, items.map((i) => i.id)))
    : [];
  return {
    branchId,
    locations: locations.map((l) => ({ id: l.id, name: l.name, type: l.type, sellPoint: l.sellPoint })),
    items: items.map((i) => {
      const byLocation: Record<string, number> = {};
      for (const level of levels) if (level.stockItemId === i.id) byLocation[level.stockLocationId] = level.quantity;
      const total = locations.reduce((sum, l) => sum + (byLocation[l.id] ?? 0), 0);
      return {
        id: i.id,
        name: i.name,
        sku: i.sku,
        category: i.category,
        active: i.active,
        productId: i.productId,
        variantId: i.variantId,
        variantLabel: i.variantLabel,
        unitCostSatang: view.withCost ? i.unitCostSatang : null,
        lowStockThreshold: i.lowStockThreshold,
        parByLocation: i.parByLocation,
        reorderPoint: i.reorderPoint,
        reorderQuantity: i.reorderQuantity,
        leadTimeDays: i.leadTimeDays,
        supplierName: i.supplierName,
        supplierContact: i.supplierContact,
        byLocation,
        total,
        status: stockStatus(total, i.lowStockThreshold),
      };
    }),
  };
}

/** One item's ledger, newest first. */
export async function movementsOf(
  db: Exec,
  operatorId: string,
  branchId: string,
  filter: { stockItemId?: string; saleId?: string; limit: number },
  view: { withCost: boolean },
): Promise<StockMovementView[]> {
  const rows = await db
    .select()
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.operatorId, operatorId),
        eq(stockMovement.branchId, branchId),
        filter.stockItemId ? eq(stockMovement.stockItemId, filter.stockItemId) : undefined,
        filter.saleId ? eq(stockMovement.saleId, filter.saleId) : undefined,
      ),
    )
    .orderBy(sql`${stockMovement.createdAt} desc`, sql`${stockMovement.id} desc`)
    .limit(filter.limit);
  return rows.map((m) => ({
    id: m.id,
    stockItemId: m.stockItemId,
    stockLocationId: m.stockLocationId,
    kind: m.kind,
    quantity: m.quantity,
    levelAfter: m.levelAfter,
    shortfall: m.shortfall,
    saleId: m.saleId,
    saleLineId: m.saleLineId,
    refundId: m.refundId,
    transferId: m.transferId,
    reason: m.reason,
    unitCostSatang: view.withCost ? m.unitCostSatang : null,
    businessDate: m.businessDate,
    actorAccountId: m.actorAccountId,
    stationId: m.stationId,
    offline: m.offline,
    occurredAt: m.occurredAt.toISOString(),
    createdAt: m.createdAt.toISOString(),
  }));
}
