import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  account,
  branch,
  employee,
  product,
  purchaseOrder,
  purchaseOrderLine,
  saleLine,
  stockAttention,
  stockItem,
  stockLevel,
  stockLocation,
  stockMovement,
  stockTake,
  stockTakeLine,
  stockUnit,
  type sale,
  type StockAttentionKind,
  type StockMovementKind,
} from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  partialStockLinkProblem,
  STOCK_CASCADE_TYPE_ORDER,
  STOCK_MAX_EACHES,
  STOCK_RULE_REORDER,
  stockRuleBelowPar,
  stockShortMessage,
  stockSizeName,
  stockStatus,
  stockTakeFlagged,
  type ProductStockLink,
  type PurchaseOrderAddBody,
  type PurchaseOrderView,
  type SaleLineStockShare,
  type SellableStock,
  type StockAdjustBody,
  type StockAdjustResult,
  type StockAttentionView,
  type StockItemBody,
  type StockLevels,
  type StockLocationType,
  type StockLocationView,
  type StockMovementView,
  type StockReceiveBody,
  type StockReceiveResult,
  type StockTakeBody,
  type StockTakeResult,
  type StockTransferBody,
  type StockTransferResult,
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
  // FOR SHARE, in id order: a size removal in flight (`saveStockItem`, FOR NO
  // KEY UPDATE) finishes first and this reads what it left. A size the manager
  // has since removed is on no screen and no count, so a unit put back on it
  // would be an each nobody can see: it is skipped — the same as a line sold
  // before the ledger — and named in the refund's audit for the office.
  const takenIds = [...new Set(taken.map((r) => r.stockItemId))];
  const archived = new Map(
    (takenIds.length
      ? await tx
          .select({ id: stockItem.id, name: stockItem.name, variantLabel: stockItem.variantLabel, archivedAt: stockItem.archivedAt })
          .from(stockItem)
          .where(inArray(stockItem.id, takenIds))
          .orderBy(asc(stockItem.id))
          .for('share')
      : []
    )
      .filter((r) => r.archivedAt !== null)
      .map((r) => [r.id, stockSizeName(r.name, r.variantLabel)] as const),
  );
  const drafts: MovementDraft[] = [];
  const skipped: Array<{ saleLineId: string | null; stockItemId: string; stockLocationId: string; quantity: number; item: string }> = [];
  for (const row of taken) {
    const back = -row.quantity + row.shortfall;
    if (back <= 0) continue;
    const removedName = archived.get(row.stockItemId);
    if (removedName !== undefined) {
      skipped.push({
        saleLineId: row.saleLineId,
        stockItemId: row.stockItemId,
        stockLocationId: row.stockLocationId,
        quantity: back,
        item: removedName,
      });
      continue;
    }
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
  if (applied.length > 0 || skipped.length > 0) {
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
        // Units the guest handed back to a size since removed from stock: not
        // put on any shelf. Add the size back and receive them to keep them.
        ...(skipped.length > 0
          ? { notRestocked: skipped.map((s) => ({ ...s, why: `${s.item} was removed from stock` })) }
          : {}),
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
  // H3 (round 2): all of a sized product's sizes, or none — a partial link
  // leaves the till offering a size no shelf stocks.
  const partial = partialStockLinkProblem(productRow.name, productRow.variants ?? [], links);
  if (partial) throw errors.badRequest(partial, { productId: productRow.id, links });
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

/**
 * What a stock item keeps in its `payload` (round 2, no migration): the group
 * its sizes share, the item's own product-line code, and the photo the stock
 * screens show.
 */
interface StockItemPayload {
  groupId?: string;
  itemSku?: string;
  photoUrl?: string;
  showPhotoInPos?: boolean;
}

function itemPayload(row: ItemRow): StockItemPayload {
  const p = row.payload;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as StockItemPayload) : {};
}

/**
 * THE KEY THAT MAKES SIZES ONE ITEM on the stock screens (the prototype's
 * `InventoryItem` with `variants`): the group the sizes were saved in, else the
 * product they stock — every seeded size of the Grip Socks shares its product —
 * else the row itself.
 */
export function stockGroupKey(row: ItemRow): string {
  const g = itemPayload(row).groupId;
  return typeof g === 'string' && g ? g : (row.productId ?? row.id);
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
  const ids = items.map((i) => i.id);
  const levels = ids.length ? await db.select().from(stockLevel).where(inArray(stockLevel.stockItemId, ids)) : [];
  const units = ids.length
    ? await db
        .select()
        .from(stockUnit)
        .where(and(inArray(stockUnit.stockItemId, ids), isNull(stockUnit.archivedAt)))
        .orderBy(desc(stockUnit.eaches), asc(stockUnit.code))
    : [];
  const productIds = [...new Set(items.flatMap((i) => (i.productId ? [i.productId] : [])))];
  const kinds = new Map(
    (productIds.length
      ? await db.select({ id: product.id, kind: product.kind }).from(product).where(inArray(product.id, productIds))
      : []
    ).map((p) => [p.id, p.kind as string]),
  );
  return {
    branchId,
    locations: locations.map((l) => ({ id: l.id, name: l.name, type: l.type, sellPoint: l.sellPoint })),
    items: items.map((i) => {
      const byLocation: Record<string, number> = {};
      for (const level of levels) if (level.stockItemId === i.id) byLocation[level.stockLocationId] = level.quantity;
      const total = locations.reduce((sum, l) => sum + (byLocation[l.id] ?? 0), 0);
      const extra = itemPayload(i);
      return {
        groupId: stockGroupKey(i),
        itemSku: extra.itemSku ?? null,
        productKind: i.productId ? (kinds.get(i.productId) ?? null) : null,
        units: units
          .filter((u) => u.stockItemId === i.id)
          .map((u) => ({ code: u.code, label: u.label, eaches: u.eaches })),
        photoUrl: extra.photoUrl ?? null,
        showPhotoInPos: extra.showPhotoInPos === true,
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

// =====================================================================================
// ROUND 2 — the stock module's own writes (plan §2.3, OD-S1, OD-S4, OD-S5).
//
// Every write below goes through `applyMovements`, the one writer of the level,
// in the caller's transaction, records an audit row with that transaction, and
// then re-reads the branch's low-stock attention (`syncStockAttention`) so the
// rows a person looks at move with the stock. Ported rules, each from the
// prototype (`imports/oto-pos/artifacts/oto-till/src`):
//
//   - a transfer clamps to what the source holds and logs what MOVED, never what
//     was asked (`catalogStore.ts:1298-1330`, `StockTransferFlow.tsx:85-109`);
//   - a delivery with no order needs a reason (`StockReplenishFlow.tsx:230`); one
//     against an order line is clamped to what is outstanding, into the place the
//     member of staff chose, and the order closes when every line is in
//     (`mockApi.ts:1837-1886`);
//   - an order is `to_order → ordered → received`; one open `to_order` per
//     supplier and branch, a repeat size merges, lines change only while
//     `to_order`, at least one each, and removing the last line deletes the order
//     (`mockApi.ts:1699-1801`); placing it stamps the date and the expected
//     arrival, today + the largest lead time (`StockPurchasing.tsx:303-315`);
//   - a count sets each counted shelf to what was counted, flags a difference
//     above three and adjusts with no approval gate (`StockTakeFlow.tsx:96-148`,
//     OD-S1); a branch's FIRST count is its opening (OD-S5);
//   - exactly one active sell point, only a FOH rotation place can be it, and it
//     can be neither retired nor retyped (`catalogStore.ts:1434-1447`,
//     `StockLocationsPanel.tsx:155-203`).
// =====================================================================================

/** Who is moving stock, at which branch. */
export interface StockActor {
  operatorId: string;
  branchId: string;
  accountId: string;
  requestId?: string | null;
  stationId?: string | null;
}

/** The branch's trading day now, and who moved it: the context every movement carries. */
async function movementContext(db: Exec, actor: StockActor, now: Date): Promise<MovementContext> {
  const [br] = await db
    .select({ operatorId: branch.operatorId, timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, actor.branchId))
    .limit(1);
  if (!br || br.operatorId !== actor.operatorId) throw errors.notFound('Branch not found');
  return {
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    businessDate: businessDate(now, br.timezone, parseDayStart(br.dayStart)),
    occurredAt: now,
    actorAccountId: actor.accountId,
    stationId: actor.stationId ?? null,
  };
}

/** How the counter names one stock item: "Grip Socks S". */
const sizeName = (item: ItemRow): string => stockSizeName(item.name, item.variantLabel);

/** How the counter is told a size it is putting eaches on was removed. */
const REMOVED_REFUSAL = {
  received: 'it cannot be received',
  counted: 'it cannot be counted',
  added: 'nothing can be added to it',
  moved: 'it cannot be moved',
  used:'it cannot be used',
} as const;

/**
 * This branch's live stock items, by id. A missing one is refused in plain words.
 *
 * `lockFor` — every path that PUTS EACHES ON an item (a delivery, a count, an
 * upward correction, a transfer's arrival) passes what it is doing. The items are then read FOR
 * SHARE, in id order: a size removal in flight (`saveStockItem`, FOR NO KEY
 * UPDATE) finishes first and the size it removed is refused in the counter's
 * words, or this write commits first and the removal sees the level and
 * refuses. The movement's own foreign key takes only KEY SHARE, which never
 * waits on the removal. Not in `applyMovements`: the offline replay calls it.
 */
async function loadBranchItems(
  db: Exec,
  actor: StockActor,
  ids: readonly string[],
  opts: { staffOperation?: boolean; lockFor?: Exclude<keyof typeof REMOVED_REFUSAL, 'used'> } = {},
): Promise<Map<string, ItemRow>> {
  const unique = [...new Set(ids)];
  const scope = and(
    inArray(stockItem.id, unique),
    eq(stockItem.operatorId, actor.operatorId),
    eq(stockItem.branchId, actor.branchId),
  );
  // Locked, the archived rows are read too: a size removed while this waited
  // is named and refused, not reported as unknown.
  const rows = !unique.length
    ? []
    : opts.lockFor
      ? await db.select().from(stockItem).where(scope).orderBy(asc(stockItem.id)).for('share')
      : await db.select().from(stockItem).where(and(scope, isNull(stockItem.archivedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) {
    const row = byId.get(id);
    if (!row) throw errors.notFound('That stock item is not one of this branch’s');
    if (row.archivedAt) {
      throw errors.conflict(
        'STOCK_ITEM_REMOVED',
        `${sizeName(row)} was removed from stock — ${REMOVED_REFUSAL[opts.lockFor ?? 'used']}; add the size back under Inventory first`,
        { stockItemId: id },
      );
    }
    // A retired item is hidden from staff stock operations (`types.ts:921`).
    if (opts.staffOperation && !row.active) {
      throw errors.conflict('STOCK_ITEM_RETIRED', `${sizeName(row)} is retired — reactivate it in Inventory first`, {
        stockItemId: id,
      });
    }
  }
  return byId;
}

/** One of this branch's places; a retired one is refused unless asked for. */
async function loadBranchLocation(
  db: Exec,
  actor: StockActor,
  locationId: string,
  opts: { allowRetired?: boolean; lock?: boolean } = {},
): Promise<LocationRow> {
  const query = db
    .select()
    .from(stockLocation)
    .where(
      and(
        eq(stockLocation.id, locationId),
        eq(stockLocation.operatorId, actor.operatorId),
        eq(stockLocation.branchId, actor.branchId),
        isNull(stockLocation.archivedAt),
      ),
    )
    .limit(1);
  // NO KEY: a sale writing a movement holds the place FOR KEY SHARE through the
  // foreign key, which a plain FOR UPDATE would wait on.
  const [row] = opts.lock ? await query.for('no key update') : await query;
  if (!row) throw errors.notFound('That stock place is not one of this branch’s');
  if (!opts.allowRetired && !row.active) {
    throw errors.conflict('STOCK_LOCATION_RETIRED', `${row.name} is retired — reactivate it first`, {
      locationId,
    });
  }
  return row;
}

// --- Transfers ------------------------------------------------------------------------

/**
 * MOVE STOCK between two places of the branch. Each line clamps to what the
 * source holds at this moment (the levels are locked first), and the pair of
 * movements — `transfer_out` and `transfer_in`, one transfer id — records what
 * actually moved. A line the source holds none of moves nothing; a transfer in
 * which nothing at all could move is refused, so nobody is told "Transfer done"
 * about an empty shelf.
 */
export async function transferStock(
  tx: Tx,
  actor: StockActor,
  body: StockTransferBody,
  now: Date,
): Promise<StockTransferResult> {
  if (body.fromLocationId === body.toLocationId) throw errors.badRequest('From and To must be different');
  const from = await loadBranchLocation(tx, actor, body.fromLocationId);
  const to = await loadBranchLocation(tx, actor, body.toLocationId);
  const requested = new Map<string, number>();
  for (const line of body.lines) requested.set(line.stockItemId, (requested.get(line.stockItemId) ?? 0) + line.quantity);
  const items = await loadBranchItems(tx, actor, [...requested.keys()], { staffOperation: true, lockFor: 'moved' });
  const levels = await lockLevels(
    tx,
    [...requested.keys()].flatMap((stockItemId) => [
      { stockItemId, stockLocationId: from.id },
      { stockItemId, stockLocationId: to.id },
    ]),
  );
  const transferId = newId();
  const drafts: MovementDraft[] = [];
  const lines: StockTransferResult['lines'] = [];
  for (const [stockItemId, asked] of requested) {
    const fromLevel = levels.get(pairKey(stockItemId, from.id)) ?? 0;
    const toLevel = levels.get(pairKey(stockItemId, to.id)) ?? 0;
    const moved = Math.min(asked, fromLevel);
    const item = items.get(stockItemId)!;
    if (moved > 0) {
      const shared = { stockItemId, transferId, unitCostSatang: item.unitCostSatang, reason: `${from.name} → ${to.name}` };
      drafts.push(
        { ...shared, stockLocationId: from.id, kind: 'transfer_out', quantity: -moved, actionId: `transfer:${transferId}:${stockItemId}:out` },
        { ...shared, stockLocationId: to.id, kind: 'transfer_in', quantity: moved, actionId: `transfer:${transferId}:${stockItemId}:in` },
      );
    }
    lines.push({ stockItemId, requested: asked, moved, fromLevel: fromLevel - moved, toLevel: toLevel + moved });
  }
  if (drafts.length === 0) {
    const names = lines.map((l) => sizeName(items.get(l.stockItemId)!)).join(', ');
    throw errors.conflict('STOCK_TRANSFER_EMPTY', `${from.name} holds no ${names} — nothing was moved`, {
      fromLocationId: from.id,
    });
  }
  await applyMovements(tx, await movementContext(tx, actor, now), drafts);
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'stock.transfer',
    entityType: 'stock_transfer',
    entityId: transferId,
    requestId: actor.requestId ?? null,
    after: { fromLocationId: from.id, toLocationId: to.id, lines },
  });
  await syncStockAttention(tx, actor, now);
  return { transferId, fromLocationId: from.id, toLocationId: to.id, lines };
}

// --- Receiving --------------------------------------------------------------------------

/** A DELIVERY WITH NO ORDER, into the place chosen, with the reason it came. */
export async function receiveStock(
  tx: Tx,
  actor: StockActor,
  body: StockReceiveBody,
  now: Date,
): Promise<StockReceiveResult> {
  const reason = body.reason.trim();
  if (!reason) throw errors.badRequest('Give a reason for stock arriving without an order');
  const item = (await loadBranchItems(tx, actor, [body.stockItemId], { staffOperation: true, lockFor: 'received' })).get(
    body.stockItemId,
  )!;
  const place = await loadBranchLocation(tx, actor, body.locationId);
  const receiptId = newId();
  const [applied] = await applyMovements(tx, await movementContext(tx, actor, now), [
    {
      stockItemId: item.id,
      stockLocationId: place.id,
      kind: 'receive',
      quantity: body.quantity,
      actionId: `receive:${receiptId}`,
      reason,
      unitCostSatang: item.unitCostSatang,
    },
  ]);
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'stock.receive',
    entityType: 'stock_item',
    entityId: item.id,
    requestId: actor.requestId ?? null,
    after: { locationId: place.id, quantity: body.quantity, reason, levelAfter: applied!.levelAfter },
  });
  await syncStockAttention(tx, actor, now);
  return { stockItemId: item.id, locationId: place.id, received: body.quantity, levelAfter: applied!.levelAfter };
}

/**
 * A MANAGER'S CORRECTION (the admin panel's Adjust). An increase lands in the
 * place named, else the sell point; a decrease takes from the place named, else
 * from the sell point first and then the cascade — the prototype's
 * `adjustInventoryStock` — and is refused, not clamped, past what is there: a
 * correction that silently corrected less than it said is not a correction.
 */
export async function adjustStock(
  tx: Tx,
  actor: StockActor,
  body: StockAdjustBody,
  now: Date,
): Promise<StockAdjustResult> {
  // An increase puts eaches on the item, so it holds the item against a size
  // removal (`loadBranchItems`); a decrease can only take what the locked
  // levels hold, which a removal (level 0 only) never races.
  const item = (await loadBranchItems(tx, actor, [body.stockItemId], body.delta > 0 ? { lockFor: 'added' } : {})).get(
    body.stockItemId,
  )!;
  const named = body.locationId ? await loadBranchLocation(tx, actor, body.locationId) : null;
  const places = named ? [named] : await branchLocations(tx, actor.branchId);
  if (places.length === 0) {
    throw errors.conflict('STOCK_NO_PLACE', 'This branch has no stock place yet — add one under Inventory → Locations');
  }
  const adjustmentId = newId();
  const reason = body.reason.trim();
  const draft = (locationId: string, quantity: number): MovementDraft => ({
    stockItemId: item.id,
    stockLocationId: locationId,
    kind: 'adjust',
    quantity,
    actionId: `adjust:${adjustmentId}:${locationId}`,
    reason,
    unitCostSatang: item.unitCostSatang,
  });
  const drafts: MovementDraft[] = [];
  if (body.delta > 0) {
    drafts.push(draft(places[0]!.id, body.delta));
  } else {
    const levels = await lockLevels(
      tx,
      places.map((p) => ({ stockItemId: item.id, stockLocationId: p.id })),
    );
    const held = places.reduce((sum, p) => sum + (levels.get(pairKey(item.id, p.id)) ?? 0), 0);
    let remaining = -body.delta;
    if (remaining > held) {
      throw errors.conflict(
        'STOCK_ADJUST_TOO_MANY',
        `${named ? named.name : 'This branch'} holds only ${held} ${sizeName(item)} — nothing was changed`,
        { held, delta: body.delta },
      );
    }
    for (const p of places) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, levels.get(pairKey(item.id, p.id)) ?? 0);
      if (take <= 0) continue;
      drafts.push(draft(p.id, -take));
      remaining -= take;
    }
  }
  const applied = await applyMovements(tx, await movementContext(tx, actor, now), drafts);
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'stock.adjust',
    entityType: 'stock_item',
    entityId: item.id,
    requestId: actor.requestId ?? null,
    after: { delta: body.delta, reason, movements: applied.map((m) => ({ locationId: m.stockLocationId, quantity: m.quantity })) },
  });
  await syncStockAttention(tx, actor, now);
  return {
    stockItemId: item.id,
    delta: body.delta,
    movements: applied.map((m) => ({ locationId: m.stockLocationId, quantity: m.quantity, levelAfter: m.levelAfter })),
  };
}

// --- Purchase orders ----------------------------------------------------------------------

type OrderRow = typeof purchaseOrder.$inferSelect;
type OrderLineRow = typeof purchaseOrderLine.$inferSelect;

/** What staff are called on screen: the nickname, else the name. */
async function staffNames(db: Exec, accountIds: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(accountIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: account.id, name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(inArray(account.id, ids));
  return new Map(rows.map((r) => [r.id, r.nickname || r.name || 'Staff']));
}

async function orderViews(db: Exec, orders: readonly OrderRow[]): Promise<PurchaseOrderView[]> {
  if (orders.length === 0) return [];
  const lines = await db
    .select()
    .from(purchaseOrderLine)
    .where(inArray(purchaseOrderLine.purchaseOrderId, orders.map((o) => o.id)))
    .orderBy(asc(purchaseOrderLine.createdAt), asc(purchaseOrderLine.id));
  const names = await staffNames(
    db,
    orders.flatMap((o) => [o.createdByAccountId, o.orderedByAccountId, o.receivedByAccountId]),
  );
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Staff') : null);
  return orders.map((o) => ({
    id: o.id,
    branchId: o.branchId,
    supplierName: o.supplierName,
    supplierContact: o.supplierContact,
    state: o.state,
    receiveLocationId: o.receiveLocationId,
    createdAt: o.createdAt.toISOString(),
    createdBy: nameOf(o.createdByAccountId),
    orderedAt: o.orderedAt ? o.orderedAt.toISOString() : null,
    orderedBy: nameOf(o.orderedByAccountId),
    expectedArrivalDate: o.expectedArrivalDate,
    receivedAt: o.receivedAt ? o.receivedAt.toISOString() : null,
    receivedBy: nameOf(o.receivedByAccountId),
    notes: o.notes,
    lines: lines
      .filter((l) => l.purchaseOrderId === o.id)
      .map((l) => ({
        id: l.id,
        stockItemId: l.stockItemId,
        itemName: l.itemName,
        variantLabel: l.variantLabel,
        orderedQuantity: l.orderedQuantity,
        receivedQuantity: l.receivedQuantity,
      })),
  }));
}

/** The branch's purchase orders, newest first (`getPurchaseOrders`). */
export async function listPurchaseOrders(db: Exec, operatorId: string, branchId: string): Promise<PurchaseOrderView[]> {
  const orders = await db
    .select()
    .from(purchaseOrder)
    .where(
      and(eq(purchaseOrder.operatorId, operatorId), eq(purchaseOrder.branchId, branchId), isNull(purchaseOrder.archivedAt)),
    )
    .orderBy(desc(purchaseOrder.createdAt), desc(purchaseOrder.id));
  return orderViews(db, orders);
}

async function loadOrder(tx: Tx, actor: StockActor, orderId: string): Promise<OrderRow> {
  const [row] = await tx
    .select()
    .from(purchaseOrder)
    .where(
      and(
        eq(purchaseOrder.id, orderId),
        eq(purchaseOrder.operatorId, actor.operatorId),
        eq(purchaseOrder.branchId, actor.branchId),
        isNull(purchaseOrder.archivedAt),
      ),
    )
    .limit(1)
    .for('no key update');
  if (!row) throw errors.notFound('That purchase order is not one of this branch’s');
  return row;
}

async function loadOrderLine(tx: Tx, order: OrderRow, lineId: string): Promise<OrderLineRow> {
  const [row] = await tx
    .select()
    .from(purchaseOrderLine)
    .where(and(eq(purchaseOrderLine.id, lineId), eq(purchaseOrderLine.purchaseOrderId, order.id)))
    .limit(1)
    .for('no key update');
  if (!row) throw errors.notFound('That line is not on this order');
  return row;
}

/** Lines change only while the order is still `to_order`. */
function assertToOrder(order: OrderRow): void {
  if (order.state === 'ordered') {
    throw errors.conflict(
      'PURCHASE_ORDER_PLACED',
      `The order to ${order.supplierName} is already placed — its lines can no longer change`,
      { orderId: order.id, state: order.state },
    );
  }
  if (order.state === 'received') {
    throw errors.conflict('PURCHASE_ORDER_RECEIVED', `The order to ${order.supplierName} is already received in full`, {
      orderId: order.id,
      state: order.state,
    });
  }
}

const UNKNOWN_SUPPLIER = 'Unknown supplier';

/**
 * PUT SIZES ON THE SUPPLIER'S OPEN ORDER (`addToPurchaseOrder`): the one order
 * still `to_order` to that supplier at this branch, created when there is none;
 * a size already on it has its quantity added rather than a second line. The
 * supplier is the item's own (its reorder settings), the prototype's
 * "Unknown supplier" when none is set.
 */
export async function addToPurchaseOrders(
  tx: Tx,
  actor: StockActor,
  body: PurchaseOrderAddBody,
  now: Date,
): Promise<PurchaseOrderView[]> {
  const wanted = new Map<string, number>();
  for (const line of body.lines) wanted.set(line.stockItemId, (wanted.get(line.stockItemId) ?? 0) + line.quantity);
  // FOR SHARE, in id order: a size removal in flight (`saveStockItem`, FOR NO
  // KEY UPDATE) finishes first and the read below no longer finds the size, or
  // this add commits first and the removal sees the line and refuses.
  await tx
    .select({ id: stockItem.id })
    .from(stockItem)
    .where(and(inArray(stockItem.id, [...wanted.keys()]), eq(stockItem.branchId, actor.branchId)))
    .orderBy(asc(stockItem.id))
    .for('share');
  const items = await loadBranchItems(tx, actor, [...wanted.keys()]);
  const bySupplier = new Map<string, { name: string; contact: string | null; lines: Array<[ItemRow, number]> }>();
  for (const [stockItemId, quantity] of wanted) {
    const item = items.get(stockItemId)!;
    const name = item.supplierName?.trim() || UNKNOWN_SUPPLIER;
    const key = name.toLowerCase();
    const group = bySupplier.get(key) ?? { name, contact: item.supplierContact, lines: [] };
    group.lines.push([item, quantity]);
    bySupplier.set(key, group);
  }
  const touched: string[] = [];
  for (const group of bySupplier.values()) {
    const openOrder = async () =>
      (
        await tx
          .select()
          .from(purchaseOrder)
          .where(
            and(
              eq(purchaseOrder.branchId, actor.branchId),
              eq(purchaseOrder.state, 'to_order'),
              isNull(purchaseOrder.archivedAt),
              sql`lower(${purchaseOrder.supplierName}) = lower(${group.name})`,
            ),
          )
          .limit(1)
          .for('no key update')
      )[0];
    let order = await openOrder();
    if (!order) {
      // `purchase_order_open_unique` makes a race between two tills land on one order.
      await tx
        .insert(purchaseOrder)
        .values({
          id: newId(),
          operatorId: actor.operatorId,
          branchId: actor.branchId,
          supplierName: group.name,
          supplierContact: group.contact,
          state: 'to_order',
          createdByAccountId: actor.accountId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      order = await openOrder();
    }
    if (!order) throw new Error('the open purchase order vanished between insert and read');
    const before = await tx.select().from(purchaseOrderLine).where(eq(purchaseOrderLine.purchaseOrderId, order.id));
    for (const [item, quantity] of group.lines) {
      const existing = before.find((l) => l.stockItemId === item.id);
      if (existing) {
        const next = existing.orderedQuantity + quantity;
        if (next > STOCK_MAX_EACHES) throw errors.badRequest(`${next} ${sizeName(item)} is more than one order can hold`);
        await tx
          .update(purchaseOrderLine)
          .set({ orderedQuantity: next, updatedAt: now })
          .where(eq(purchaseOrderLine.id, existing.id));
      } else {
        await tx.insert(purchaseOrderLine).values({
          id: newId(),
          operatorId: actor.operatorId,
          purchaseOrderId: order.id,
          stockItemId: item.id,
          itemName: item.name,
          variantLabel: item.variantLabel,
          orderedQuantity: quantity,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    await tx.update(purchaseOrder).set({ updatedAt: now }).where(eq(purchaseOrder.id, order.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: actor.branchId,
      action: 'purchase_order.add_lines',
      entityType: 'purchase_order',
      entityId: order.id,
      requestId: actor.requestId ?? null,
      before: { lines: before.map((l) => ({ stockItemId: l.stockItemId, orderedQuantity: l.orderedQuantity })) },
      after: { added: group.lines.map(([item, quantity]) => ({ stockItemId: item.id, quantity })) },
    });
    touched.push(order.id);
  }
  await syncStockAttention(tx, actor, now);
  const rows = await tx.select().from(purchaseOrder).where(inArray(purchaseOrder.id, touched));
  return orderViews(tx, rows);
}

async function orderView(db: Exec, orderId: string): Promise<PurchaseOrderView | null> {
  const rows = await db.select().from(purchaseOrder).where(eq(purchaseOrder.id, orderId));
  return (await orderViews(db, rows))[0] ?? null;
}

/** Change a line's quantity while the order is `to_order`; one each at least. */
export async function setPurchaseOrderLineQuantity(
  tx: Tx,
  actor: StockActor,
  orderId: string,
  lineId: string,
  quantity: number,
  now: Date,
): Promise<PurchaseOrderView> {
  const order = await loadOrder(tx, actor, orderId);
  assertToOrder(order);
  const line = await loadOrderLine(tx, order, lineId);
  if (!Number.isInteger(quantity) || quantity < 1) throw errors.badRequest('Order at least one');
  await tx.update(purchaseOrderLine).set({ orderedQuantity: quantity, updatedAt: now }).where(eq(purchaseOrderLine.id, line.id));
  await tx.update(purchaseOrder).set({ updatedAt: now }).where(eq(purchaseOrder.id, order.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'purchase_order.line_update',
    entityType: 'purchase_order',
    entityId: order.id,
    requestId: actor.requestId ?? null,
    before: { lineId, orderedQuantity: line.orderedQuantity },
    after: { lineId, orderedQuantity: quantity },
  });
  return (await orderView(tx, order.id))!;
}

/** Take a line off a `to_order` order; the last line going takes the order with it. */
export async function removePurchaseOrderLine(
  tx: Tx,
  actor: StockActor,
  orderId: string,
  lineId: string,
  now: Date,
): Promise<PurchaseOrderView | null> {
  const order = await loadOrder(tx, actor, orderId);
  assertToOrder(order);
  const line = await loadOrderLine(tx, order, lineId);
  await tx.delete(purchaseOrderLine).where(eq(purchaseOrderLine.id, line.id));
  const [left] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.purchaseOrderId, order.id));
  const deleted = (left?.n ?? 0) === 0;
  if (deleted) await tx.delete(purchaseOrder).where(eq(purchaseOrder.id, order.id));
  else await tx.update(purchaseOrder).set({ updatedAt: now }).where(eq(purchaseOrder.id, order.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: deleted ? 'purchase_order.delete' : 'purchase_order.line_remove',
    entityType: 'purchase_order',
    entityId: order.id,
    requestId: actor.requestId ?? null,
    before: { line: { id: line.id, stockItemId: line.stockItemId, orderedQuantity: line.orderedQuantity } },
    after: { orderDeleted: deleted },
  });
  await syncStockAttention(tx, actor, now);
  return deleted ? null : orderView(tx, order.id);
}

/**
 * PLACE THE ORDER with the supplier: `to_order → ordered`, stamped with who and
 * when, and the expected arrival — the date given, else today + the largest
 * lead time among its sizes (at least one day, as the prototype defaults).
 */
export async function markPurchaseOrderOrdered(
  tx: Tx,
  actor: StockActor,
  orderId: string,
  body: { expectedArrivalDate?: string; notes?: string },
  now: Date,
): Promise<PurchaseOrderView> {
  const order = await loadOrder(tx, actor, orderId);
  assertToOrder(order);
  const lines = await tx.select().from(purchaseOrderLine).where(eq(purchaseOrderLine.purchaseOrderId, order.id));
  if (lines.length === 0) throw errors.conflict('PURCHASE_ORDER_EMPTY', `The order to ${order.supplierName} has no lines`);
  const items = lines.length
    ? await tx.select({ lead: stockItem.leadTimeDays }).from(stockItem).where(inArray(stockItem.id, lines.map((l) => l.stockItemId)))
    : [];
  const ctx = await movementContext(tx, actor, now);
  const lead = Math.max(1, ...items.map((i) => i.lead ?? 1));
  const expected = body.expectedArrivalDate ?? addDaysToIsoDate(ctx.businessDate, lead);
  const notes = body.notes?.trim() ? body.notes.trim() : order.notes;
  await tx
    .update(purchaseOrder)
    .set({
      state: 'ordered',
      orderedAt: now,
      orderedByAccountId: actor.accountId,
      expectedArrivalDate: expected,
      notes,
      updatedAt: now,
    })
    .where(eq(purchaseOrder.id, order.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'purchase_order.ordered',
    entityType: 'purchase_order',
    entityId: order.id,
    requestId: actor.requestId ?? null,
    before: { state: order.state },
    after: { state: 'ordered', expectedArrivalDate: expected, notes },
  });
  return (await orderView(tx, order.id))!;
}

/**
 * RECEIVE AGAINST AN ORDER LINE, into the place the member of staff chose,
 * clamped to what is still outstanding on the line (an over-delivery is not
 * received against the order). The order closes, `received`, when every line is
 * in.
 */
export async function receivePurchaseOrderLine(
  tx: Tx,
  actor: StockActor,
  orderId: string,
  lineId: string,
  body: { quantity: number; locationId: string },
  now: Date,
): Promise<{ order: PurchaseOrderView; requested: number; received: number; levelAfter: number }> {
  const order = await loadOrder(tx, actor, orderId);
  if (order.state === 'to_order') {
    throw errors.conflict(
      'PURCHASE_ORDER_NOT_PLACED',
      `The order to ${order.supplierName} is not placed yet — mark it ordered first`,
      { orderId },
    );
  }
  if (order.state === 'received') {
    throw errors.conflict('PURCHASE_ORDER_RECEIVED', `The order to ${order.supplierName} is already received in full`, {
      orderId,
    });
  }
  const line = await loadOrderLine(tx, order, lineId);
  const place = await loadBranchLocation(tx, actor, body.locationId);
  const outstanding = line.orderedQuantity - line.receivedQuantity;
  const label = stockSizeName(line.itemName, line.variantLabel);
  if (outstanding <= 0) {
    throw errors.conflict(
      'PURCHASE_ORDER_LINE_RECEIVED',
      `All ${line.orderedQuantity} ${label} on this order are already in`,
      { lineId },
    );
  }
  const received = Math.min(body.quantity, outstanding);
  // FOR SHARE: waits out a size removal in flight (`saveStockItem` holds the
  // item FOR NO KEY UPDATE) and then reads what it left. A size taken off its
  // item is on no screen and no count, so a delivery booked to it would be lost.
  const [item] = await tx.select().from(stockItem).where(eq(stockItem.id, line.stockItemId)).limit(1).for('share');
  if (!item || item.archivedAt) {
    throw errors.conflict(
      'STOCK_ITEM_REMOVED',
      `${label} was removed from stock — it cannot be received; add the size back and order it again`,
      { lineId, stockItemId: line.stockItemId },
    );
  }
  const [applied] = await applyMovements(tx, await movementContext(tx, actor, now), [
    {
      stockItemId: line.stockItemId,
      stockLocationId: place.id,
      kind: 'receive',
      quantity: received,
      actionId: `po_receive:${line.id}:${newId()}`,
      purchaseOrderLineId: line.id,
      reason: `PO receipt: ${order.supplierName}`,
      unitCostSatang: item?.unitCostSatang ?? null,
    },
  ]);
  await tx
    .update(purchaseOrderLine)
    .set({ receivedQuantity: line.receivedQuantity + received, updatedAt: now })
    .where(eq(purchaseOrderLine.id, line.id));
  const lines = await tx.select().from(purchaseOrderLine).where(eq(purchaseOrderLine.purchaseOrderId, order.id));
  const allIn = lines.every((l) => l.receivedQuantity >= l.orderedQuantity);
  await tx
    .update(purchaseOrder)
    .set({
      receiveLocationId: order.receiveLocationId ?? place.id,
      updatedAt: now,
      ...(allIn ? { state: 'received' as const, receivedAt: now, receivedByAccountId: actor.accountId } : {}),
    })
    .where(eq(purchaseOrder.id, order.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'purchase_order.receive',
    entityType: 'purchase_order',
    entityId: order.id,
    requestId: actor.requestId ?? null,
    before: { lineId, receivedQuantity: line.receivedQuantity, state: order.state },
    after: {
      lineId,
      locationId: place.id,
      requested: body.quantity,
      received,
      receivedQuantity: line.receivedQuantity + received,
      state: allIn ? 'received' : order.state,
    },
  });
  await syncStockAttention(tx, actor, now);
  return { order: (await orderView(tx, order.id))!, requested: body.quantity, received, levelAfter: applied!.levelAfter };
}

// --- The stock take --------------------------------------------------------------------

/**
 * A COUNT. Each counted shelf is set to what was counted: the expected figure
 * is the record AT COMMIT (the levels locked), not the one on the counter's
 * screen when the count began, so a sale rung up meanwhile is not counted
 * twice. The difference is written as a `count` movement, flagged when it is
 * above three, and audited — no approval gate (OD-S1). The branch's first
 * count is its opening (OD-S5), whose lines are never flagged.
 */
export async function commitStockTake(
  tx: Tx,
  actor: StockActor,
  body: StockTakeBody,
  now: Date,
): Promise<StockTakeResult> {
  const seen = new Set<string>();
  for (const line of body.lines) {
    const key = pairKey(line.stockItemId, line.locationId);
    if (seen.has(key)) throw errors.badRequest('One shelf is counted twice in this take — count each item once per place');
    seen.add(key);
  }
  const items = await loadBranchItems(
    tx,
    actor,
    body.lines.map((l) => l.stockItemId),
    { lockFor: 'counted' },
  );
  const places = new Map<string, LocationRow>();
  for (const id of new Set(body.lines.map((l) => l.locationId))) places.set(id, await loadBranchLocation(tx, actor, id));
  // One count at a time per branch, so two first counts cannot both be "the opening".
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stock_take:${actor.branchId}`}))`);
  const [prior] = await tx
    .select({ id: stockTake.id })
    .from(stockTake)
    .where(and(eq(stockTake.branchId, actor.branchId), eq(stockTake.status, 'committed')))
    .limit(1);
  const opening = !prior;
  const levels = await lockLevels(
    tx,
    body.lines.map((l) => ({ stockItemId: l.stockItemId, stockLocationId: l.locationId })),
  );
  const takeId = newId();
  await tx.insert(stockTake).values({
    id: takeId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    status: 'committed',
    opening,
    countedByAccountId: actor.accountId,
    committedAt: now,
    note: body.note?.trim() || (opening ? 'Opening count' : null),
    createdAt: now,
    updatedAt: now,
  });
  const lines: StockTakeResult['lines'] = [];
  const drafts: MovementDraft[] = [];
  for (const line of body.lines) {
    const item = items.get(line.stockItemId)!;
    const expected = levels.get(pairKey(line.stockItemId, line.locationId)) ?? 0;
    const difference = line.countedQuantity - expected;
    // The opening sets the starting figure; it is not a variance against one,
    // so it is never flagged — the same as the seed's opening lines.
    const flagged = !opening && stockTakeFlagged(difference);
    const status = difference === 0 ? ('confirmed' as const) : ('adjusted' as const);
    const lineId = newId();
    await tx.insert(stockTakeLine).values({
      id: lineId,
      operatorId: actor.operatorId,
      stockTakeId: takeId,
      stockItemId: line.stockItemId,
      stockLocationId: line.locationId,
      expectedQuantity: expected,
      countedQuantity: line.countedQuantity,
      difference,
      flagged,
      status,
      countedByAccountId: actor.accountId,
      countedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (difference !== 0) {
      drafts.push({
        stockItemId: line.stockItemId,
        stockLocationId: line.locationId,
        kind: 'count',
        quantity: difference,
        actionId: `count:${lineId}`,
        stockTakeLineId: lineId,
        reason: `${opening ? 'Opening count' : 'Stock take'} — expected ${expected}, counted ${line.countedQuantity}${flagged ? ' (flagged)' : ''}`,
        unitCostSatang: item.unitCostSatang,
      });
    }
    lines.push({
      id: lineId,
      stockItemId: line.stockItemId,
      locationId: line.locationId,
      expectedQuantity: expected,
      countedQuantity: line.countedQuantity,
      difference,
      flagged,
      status,
    });
  }
  await applyMovements(tx, await movementContext(tx, actor, now), drafts);
  const flaggedLines = lines.filter((l) => l.flagged);
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: opening ? 'stock.opening_count' : 'stock.count',
    entityType: 'stock_take',
    entityId: takeId,
    requestId: actor.requestId ?? null,
    after: {
      opening,
      counted: lines.length,
      adjusted: lines.filter((l) => l.difference !== 0).length,
      flagged: flaggedLines.map((l) => ({
        stockItemId: l.stockItemId,
        name: sizeName(items.get(l.stockItemId)!),
        locationId: l.locationId,
        place: places.get(l.locationId)!.name,
        expected: l.expectedQuantity,
        counted: l.countedQuantity,
        difference: l.difference,
      })),
      lines,
    },
  });
  await syncStockAttention(tx, actor, now);
  return { id: takeId, opening, lines };
}

// --- Places -------------------------------------------------------------------------------

const locationView = (l: LocationRow): StockLocationView => ({
  id: l.id,
  name: l.name,
  type: l.type,
  sellPoint: l.sellPoint,
  active: l.active,
});

/** Every place of the branch, retired ones included when asked (the Locations panel). */
export async function listLocations(
  db: Exec,
  branchId: string,
  opts: { includeRetired: boolean },
): Promise<StockLocationView[]> {
  if (!opts.includeRetired) return (await branchLocations(db, branchId)).map(locationView);
  const rows = await db
    .select()
    .from(stockLocation)
    .where(and(eq(stockLocation.branchId, branchId), isNull(stockLocation.archivedAt)))
    .orderBy(desc(stockLocation.active), asc(stockLocation.name));
  return rows.map(locationView);
}

async function assertLocationNameFree(tx: Tx, actor: StockActor, name: string, exceptId: string | null): Promise<void> {
  const [clash] = await tx
    .select({ id: stockLocation.id })
    .from(stockLocation)
    .where(
      and(
        eq(stockLocation.branchId, actor.branchId),
        isNull(stockLocation.archivedAt),
        sql`lower(${stockLocation.name}) = lower(${name})`,
        exceptId ? ne(stockLocation.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (clash) throw errors.conflict('STOCK_LOCATION_NAME_TAKEN', `There is already a place called "${name}" here`);
}

/**
 * A NEW PLACE. A FOH rotation place becomes the sell point when the branch has
 * none, so a branch is never left without one once it has a counter shelf
 * (`StockLocationsPanel.tsx:168-178`).
 */
export async function createLocation(
  tx: Tx,
  actor: StockActor,
  body: { name: string; type: StockLocationType },
  now: Date,
): Promise<StockLocationView> {
  const name = body.name.trim();
  await assertLocationNameFree(tx, actor, name, null);
  const [current] = await tx
    .select({ id: stockLocation.id })
    .from(stockLocation)
    .where(
      and(
        eq(stockLocation.branchId, actor.branchId),
        eq(stockLocation.sellPoint, true),
        eq(stockLocation.active, true),
        isNull(stockLocation.archivedAt),
      ),
    )
    .limit(1);
  const id = newId();
  const sellPoint = body.type === 'rotation' && !current;
  await tx.insert(stockLocation).values({
    id,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    name,
    type: body.type,
    sellPoint,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await tx.select().from(stockLocation).where(eq(stockLocation.id, id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'stock_location.create',
    entityType: 'stock_location',
    entityId: id,
    requestId: actor.requestId ?? null,
    after: locationView(row!),
  });
  return locationView(row!);
}

/**
 * RENAME, RETYPE, RETIRE OR REACTIVATE a place. The sell point can be neither
 * retired nor retyped — another sell point first (`StockLocationsPanel.tsx:155-191`).
 */
export async function updateLocation(
  tx: Tx,
  actor: StockActor,
  locationId: string,
  patch: { name?: string; type?: StockLocationType; active?: boolean },
  now: Date,
): Promise<StockLocationView> {
  const loc = await loadBranchLocation(tx, actor, locationId, { allowRetired: true, lock: true });
  const isSellPoint = loc.sellPoint && loc.active;
  if (isSellPoint && patch.active === false) {
    throw errors.conflict(
      'STOCK_SELL_POINT_RETIRE',
      `${loc.name} is the sell point — set another sell point before retiring it`,
      { locationId },
    );
  }
  if (isSellPoint && patch.type && patch.type !== 'rotation') {
    throw errors.conflict(
      'STOCK_SELL_POINT_TYPE',
      `${loc.name} is the sell point, so it stays a FOH rotation place — set another sell point before changing its type`,
      { locationId },
    );
  }
  const name = patch.name?.trim();
  if (name && name.toLowerCase() !== loc.name.toLowerCase()) await assertLocationNameFree(tx, actor, name, loc.id);
  const next = {
    name: name ?? loc.name,
    type: patch.type ?? loc.type,
    active: patch.active ?? loc.active,
    sellPoint: loc.sellPoint,
  };
  // A place that was the sell point and comes back while another is, comes back as storage.
  if (next.active && !loc.active && loc.sellPoint) {
    const [other] = await tx
      .select({ id: stockLocation.id })
      .from(stockLocation)
      .where(
        and(
          eq(stockLocation.branchId, actor.branchId),
          eq(stockLocation.sellPoint, true),
          eq(stockLocation.active, true),
          isNull(stockLocation.archivedAt),
          ne(stockLocation.id, loc.id),
        ),
      )
      .limit(1);
    if (other) next.sellPoint = false;
  }
  if (next.type !== 'rotation') next.sellPoint = false;
  await tx
    .update(stockLocation)
    .set({ ...next, updatedAt: now })
    .where(eq(stockLocation.id, loc.id));
  const after = { ...locationView(loc), ...next };
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'stock_location.update',
    entityType: 'stock_location',
    entityId: loc.id,
    requestId: actor.requestId ?? null,
    before: locationView(loc),
    after,
  });
  await syncStockAttention(tx, actor, now);
  return after;
}

/**
 * MAKE A PLACE THE SELL POINT, clearing the flag everywhere else in the branch:
 * exactly one, and only an active FOH rotation place (`setStockLocationSellPoint`).
 */
export async function setSellPoint(tx: Tx, actor: StockActor, locationId: string, now: Date): Promise<StockLocationView> {
  const loc = await loadBranchLocation(tx, actor, locationId, { allowRetired: true, lock: true });
  if (loc.type !== 'rotation') {
    throw errors.conflict('STOCK_SELL_POINT_TYPE', 'Only a FOH rotation place can be the sell point', { locationId });
  }
  if (!loc.active) {
    throw errors.conflict('STOCK_LOCATION_RETIRED', `${loc.name} is retired — reactivate it before making it the sell point`, {
      locationId,
    });
  }
  const [before] = await tx
    .select({ id: stockLocation.id })
    .from(stockLocation)
    .where(and(eq(stockLocation.branchId, actor.branchId), eq(stockLocation.sellPoint, true), ne(stockLocation.id, loc.id)))
    .limit(1);
  // Clear first: `stock_location_sell_point_unique` allows one at a time.
  await tx
    .update(stockLocation)
    .set({ sellPoint: false, updatedAt: now })
    .where(and(eq(stockLocation.branchId, actor.branchId), eq(stockLocation.sellPoint, true), ne(stockLocation.id, loc.id)));
  await tx.update(stockLocation).set({ sellPoint: true, updatedAt: now }).where(eq(stockLocation.id, loc.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'stock_location.sell_point',
    entityType: 'stock_location',
    entityId: loc.id,
    requestId: actor.requestId ?? null,
    before: { sellPointLocationId: before?.id ?? null },
    after: { sellPointLocationId: loc.id },
  });
  return { ...locationView(loc), sellPoint: true };
}

// --- Items, sizes and packs ----------------------------------------------------------------

/** A slug for a pack's code: "Case of 24" → `case-of-24`. */
const packCode = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pack';

/**
 * A size may leave the form only when nothing is stranded by it: no place of
 * the branch — a retired one included, which `availableFor` skips — holds any
 * of it (a short, negative level counts too: only a count clears it), and no
 * open order still has some of it outstanding. Called under the item lock
 * `saveStockItem` takes, which the order paths' item locks serialise against.
 */
async function assertSizesRemovable(tx: Tx, branchId: string, removed: readonly ItemRow[]): Promise<void> {
  const ids = removed.map((r) => r.id);
  const levels = await tx
    .select({
      stockItemId: stockLevel.stockItemId,
      quantity: stockLevel.quantity,
      placeName: stockLocation.name,
      retired: sql<boolean>`(not ${stockLocation.active} or ${stockLocation.archivedAt} is not null)`,
    })
    .from(stockLevel)
    .innerJoin(stockLocation, eq(stockLocation.id, stockLevel.stockLocationId))
    .where(and(inArray(stockLevel.stockItemId, ids), eq(stockLocation.branchId, branchId), ne(stockLevel.quantity, 0)))
    .orderBy(asc(stockLocation.name), asc(stockLocation.id));
  for (const r of removed) {
    const mine = levels.filter((l) => l.stockItemId === r.id);
    if (mine.length === 0) continue;
    const held = mine.reduce((n, l) => n + l.quantity, 0);
    const where = mine.map((l) => `${l.quantity} at ${l.placeName}${l.retired ? ', retired' : ''}`).join('; ');
    const retired = mine.some((l) => l.retired);
    throw errors.conflict(
      'STOCK_SIZE_HOLDS_STOCK',
      `${sizeName(r)} still holds ${held} (${where}) — ${retired ? 'reactivate the place, then ' : ''}count it out or move it before removing the size`,
      { stockItemId: r.id, held, levels: mine.map((l) => ({ place: l.placeName, quantity: l.quantity, retired: l.retired })) },
    );
  }
  const [onOrder] = await tx
    .select({
      stockItemId: purchaseOrderLine.stockItemId,
      supplierName: purchaseOrder.supplierName,
      orderId: purchaseOrder.id,
      lineId: purchaseOrderLine.id,
    })
    .from(purchaseOrderLine)
    .innerJoin(purchaseOrder, eq(purchaseOrder.id, purchaseOrderLine.purchaseOrderId))
    .where(
      and(
        inArray(purchaseOrderLine.stockItemId, ids),
        eq(purchaseOrder.branchId, branchId),
        inArray(purchaseOrder.state, ['to_order', 'ordered']),
        isNull(purchaseOrder.archivedAt),
        sql`${purchaseOrderLine.orderedQuantity} > ${purchaseOrderLine.receivedQuantity}`,
      ),
    )
    .orderBy(asc(purchaseOrder.createdAt), asc(purchaseOrderLine.id))
    .limit(1);
  if (onOrder) {
    const r = removed.find((x) => x.id === onOrder.stockItemId)!;
    throw errors.conflict(
      'STOCK_SIZE_ON_ORDER',
      `${sizeName(r)} is on the open order to ${onOrder.supplierName} — receive or remove that line first`,
      { stockItemId: r.id, orderId: onOrder.orderId, lineId: onOrder.lineId },
    );
  }
}

/**
 * CREATE OR EDIT ONE STOCKED ITEM with its sizes — the admin Inventory form.
 *
 * One row per size, sharing a group (`payload.groupId`). A size's stock is
 * never written here: levels move only through movements, and a new item opens
 * with a count or a delivery (OD-S5). A size that still holds stock anywhere,
 * or is still wanted on an open order, cannot be removed (`assertSizesRemovable`). The link to the sellable goes through `setProductStockLinks`, so the
 * all-or-none rule for a sized product (H3) and the "one item per sellable"
 * rule are the catalogue link's own.
 */
export async function saveStockItem(
  tx: Tx,
  actor: StockActor,
  groupId: string | null,
  body: StockItemBody,
  now: Date,
): Promise<{ groupId: string; stockItemIds: string[] }> {
  const live = await tx
    .select()
    .from(stockItem)
    .where(and(eq(stockItem.branchId, actor.branchId), eq(stockItem.operatorId, actor.operatorId), isNull(stockItem.archivedAt)))
    .orderBy(asc(stockItem.id))
    .for('no key update');
  const existing = groupId ? live.filter((i) => stockGroupKey(i) === groupId) : [];
  if (groupId && existing.length === 0) throw errors.notFound('That stock item is not one of this branch’s');
  const key = groupId ?? newId();
  const name = body.name.trim();

  // The sizes are the item's own.
  const labels = new Set<string>();
  for (const size of body.sizes) {
    const label = size.label.trim().toLowerCase();
    if (labels.has(label)) throw errors.badRequest(`Two sizes are both called "${size.label.trim()}"`);
    labels.add(label);
    if (size.stockItemId && !existing.some((e) => e.id === size.stockItemId)) {
      throw errors.badRequest('A size on the form is not one of this item’s', { stockItemId: size.stockItemId });
    }
  }
  const places = new Set(
    (
      await tx
        .select({ id: stockLocation.id })
        .from(stockLocation)
        .where(and(eq(stockLocation.branchId, actor.branchId), isNull(stockLocation.archivedAt)))
    ).map((l) => l.id),
  );
  for (const size of body.sizes) {
    for (const locationId of Object.keys(size.parByLocation)) {
      if (!places.has(locationId)) throw errors.badRequest('A par is set for a place that is not this branch’s', { locationId });
    }
  }

  // The sellable it stocks.
  const productRow = body.productId
    ? (
        await tx
          .select()
          .from(product)
          .where(and(eq(product.id, body.productId), eq(product.operatorId, actor.operatorId), isNull(product.archivedAt)))
          .limit(1)
      )[0]
    : undefined;
  if (body.productId && (!productRow || (productRow.branchId && productRow.branchId !== actor.branchId))) {
    throw errors.badRequest('That product is not sold at this branch', { productId: body.productId });
  }
  if (productRow) {
    const problem = partialStockLinkProblem(productRow.name, productRow.variants ?? [], body.sizes);
    if (problem) throw errors.badRequest(problem, { productId: productRow.id });
    const other = live.find((i) => i.productId === productRow.id && !existing.some((e) => e.id === i.id));
    if (other) {
      throw errors.conflict(
        'STOCK_ITEM_LINKED',
        `"${productRow.name}" is already stocked by "${other.name}" — unlink it there first`,
        { productId: productRow.id, stockItemId: other.id },
      );
    }
  }

  // Sizes taken off the form: archived, and only when they hold nothing and no
  // open order still wants them — an archived item is on no screen, no count
  // reaches it and nothing brings it back, so whatever it held would be lost.
  const kept = new Set(body.sizes.flatMap((s) => (s.stockItemId ? [s.stockItemId] : [])));
  const removed = existing.filter((e) => !kept.has(e.id));
  if (removed.length > 0) await assertSizesRemovable(tx, actor.branchId, removed);

  // Unlink first, so a size moving between products never meets the unique index half-way.
  const previousProducts = [...new Set(existing.flatMap((e) => (e.productId ? [e.productId] : [])))];
  const scope = { operatorId: actor.operatorId, branchId: actor.branchId, accountId: actor.accountId, requestId: actor.requestId ?? null };
  for (const pid of previousProducts) {
    const [prev] = await tx.select().from(product).where(eq(product.id, pid)).limit(1);
    if (prev) await setProductStockLinks(tx, scope, prev, []);
  }
  if (removed.length > 0) {
    await tx
      .update(stockItem)
      .set({ archivedAt: now, active: false, productId: null, variantId: null, updatedAt: now })
      .where(inArray(stockItem.id, removed.map((r) => r.id)));
  }

  const payload: StockItemPayload = {
    groupId: key,
    ...(body.sku?.trim() ? { itemSku: body.sku.trim() } : {}),
    ...(body.photoUrl ? { photoUrl: body.photoUrl, showPhotoInPos: body.showPhotoInPos } : {}),
  };
  const shared = {
    name,
    category: body.category?.trim() || null,
    active: body.active,
    unitCostSatang: body.unitCostSatang,
    reorderPoint: body.reorder?.reorderPoint ?? null,
    reorderQuantity: body.reorder?.reorderQuantity ?? null,
    leadTimeDays: body.reorder?.leadTimeDays ?? null,
    supplierName: body.reorder?.supplierName.trim() ?? null,
    supplierContact: body.reorder?.supplierContact?.trim() || null,
    payload,
    updatedAt: now,
  };
  const ids: string[] = [];
  const links: ProductStockLink[] = [];
  for (const size of body.sizes) {
    const row = {
      ...shared,
      sku: size.sku?.trim() || null,
      variantLabel: productRow ? (size.variantId ? size.label.trim() : null) : size.label.trim(),
      lowStockThreshold: size.lowStockThreshold,
      parByLocation: size.parByLocation,
    };
    let id = size.stockItemId;
    if (id) {
      await tx.update(stockItem).set(row).where(eq(stockItem.id, id));
    } else {
      id = newId();
      await tx.insert(stockItem).values({
        ...row,
        id,
        operatorId: actor.operatorId,
        branchId: actor.branchId,
        createdAt: now,
      });
    }
    ids.push(id);
    if (productRow) links.push({ variantId: productRow.variants.length > 0 ? size.variantId : null, stockItemId: id });
  }
  if (productRow) await setProductStockLinks(tx, scope, productRow, links);

  // Packs: the item's, on every size (the prototype shares them across variants).
  const wantUnits = body.units.map((u) => ({ code: packCode(u.label), label: u.label.trim(), eaches: u.eaches }));
  const codes = new Set<string>();
  for (const u of wantUnits) {
    if (codes.has(u.code)) throw errors.badRequest(`Two packs are both called "${u.label}"`);
    codes.add(u.code);
  }
  const haveUnits = await tx
    .select()
    .from(stockUnit)
    .where(and(inArray(stockUnit.stockItemId, ids), isNull(stockUnit.archivedAt)));
  for (const id of ids) {
    const mine = haveUnits.filter((u) => u.stockItemId === id);
    const same =
      mine.length === wantUnits.length &&
      wantUnits.every((w) => mine.some((m) => m.code === w.code && m.label === w.label && m.eaches === w.eaches));
    if (same) continue;
    if (mine.length > 0) {
      await tx.update(stockUnit).set({ archivedAt: now, updatedAt: now }).where(inArray(stockUnit.id, mine.map((m) => m.id)));
    }
    if (wantUnits.length > 0) {
      await tx.insert(stockUnit).values(
        wantUnits.map((u) => ({ id: newId(), operatorId: actor.operatorId, stockItemId: id, ...u, createdAt: now, updatedAt: now })),
      );
    }
  }

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: groupId ? 'stock_item.update' : 'stock_item.create',
    entityType: 'stock_item',
    entityId: ids[0]!,
    requestId: actor.requestId ?? null,
    before: groupId
      ? {
          sizes: existing.map((e) => ({ id: e.id, label: e.variantLabel, productId: e.productId, active: e.active })),
        }
      : null,
    after: {
      groupId: key,
      stockItemIds: ids,
      removed: removed.map((r) => r.id),
      ...body,
      photoUrl: body.photoUrl ? '(photo)' : null,
    },
  });
  await syncStockAttention(tx, actor, now);
  return { groupId: key, stockItemIds: ids };
}

// --- Attention ------------------------------------------------------------------------------

/**
 * RE-READ THE BRANCH'S LOW-STOCK ATTENTION, so the rows a person looks at move
 * with the stock. One open row per stocked item and branch (all its sizes are
 * one item, as the prototype's Alerts shows them), carrying the rule that fired:
 *
 *   - "≤ reorder point" — the item's total, every size and place, at or below
 *     its reorder point (`lib/inventory.ts:getReorderAlerts`);
 *   - "Below par at FOH" — a size under its par at a place
 *     (`StockSuggestions.tsx:buildSuggestions`).
 *
 * SUPPRESSED while an open purchase order (to order or ordered, something
 * still outstanding) covers any of its sizes: the order is the answer, and a
 * second nag for it is noise. A row whose rule no longer fires is resolved;
 * the round-1 rows (`stock_shortfall`, `size_unknown`) are not touched here.
 */
export async function syncStockAttention(
  tx: Tx,
  scope: { operatorId: string; branchId: string; accountId?: string | null },
  now: Date,
): Promise<void> {
  const items = await tx
    .select()
    .from(stockItem)
    .where(
      and(
        eq(stockItem.operatorId, scope.operatorId),
        eq(stockItem.branchId, scope.branchId),
        eq(stockItem.active, true),
        isNull(stockItem.archivedAt),
      ),
    );
  const places = await branchLocations(tx, scope.branchId);
  const placeById = new Map(places.map((p) => [p.id, p]));
  const levels = items.length
    ? await tx
        .select({ stockItemId: stockLevel.stockItemId, stockLocationId: stockLevel.stockLocationId, quantity: stockLevel.quantity })
        .from(stockLevel)
        .where(inArray(stockLevel.stockItemId, items.map((i) => i.id)))
    : [];
  const levelOf = new Map(levels.map((l) => [pairKey(l.stockItemId, l.stockLocationId), l.quantity]));
  const covered = new Set(
    (
      await tx
        .select({ stockItemId: purchaseOrderLine.stockItemId })
        .from(purchaseOrderLine)
        .innerJoin(purchaseOrder, eq(purchaseOrder.id, purchaseOrderLine.purchaseOrderId))
        .where(
          and(
            eq(purchaseOrder.branchId, scope.branchId),
            inArray(purchaseOrder.state, ['to_order', 'ordered']),
            isNull(purchaseOrder.archivedAt),
            sql`${purchaseOrderLine.orderedQuantity} > ${purchaseOrderLine.receivedQuantity}`,
          ),
        )
    ).map((r) => r.stockItemId),
  );

  const groups = new Map<string, ItemRow[]>();
  for (const item of items) {
    const key = stockGroupKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  interface Wanted {
    stockItemId: string;
    kind: StockAttentionKind;
    rule: string;
    quantity: number;
    summary: string;
    detail: unknown;
  }
  const wanted = new Map<string, Wanted>();
  for (const [key, sizes] of groups) {
    sizes.sort((a, b) => a.id.localeCompare(b.id));
    const total = sizes.reduce(
      (sum, s) => sum + places.reduce((n, p) => n + (levelOf.get(pairKey(s.id, p.id)) ?? 0), 0),
      0,
    );
    const reorderPoint = sizes.find((s) => s.reorderPoint !== null)?.reorderPoint ?? null;
    const reorder = reorderPoint !== null && total <= reorderPoint;
    const belowPar: Array<{ stockItemId: string; size: string | null; place: string; level: number; par: number }> = [];
    for (const s of sizes) {
      for (const [locationId, par] of Object.entries(s.parByLocation ?? {})) {
        const place = placeById.get(locationId);
        if (!place || !(par > 0)) continue;
        const level = levelOf.get(pairKey(s.id, locationId)) ?? 0;
        if (level < par) belowPar.push({ stockItemId: s.id, size: s.variantLabel, place: place.name, level, par });
      }
    }
    if (!reorder && belowPar.length === 0) continue;
    if (sizes.some((s) => covered.has(s.id))) continue;
    const rules = [
      ...(reorder ? [STOCK_RULE_REORDER] : []),
      ...[...new Set(belowPar.map((b) => b.place))].map(stockRuleBelowPar),
    ];
    const name = sizes[0]!.name;
    wanted.set(`low_stock:${scope.branchId}:${key}`, {
      stockItemId: sizes[0]!.id,
      kind: reorder ? 'reorder' : 'low_stock',
      rule: rules.join(' · '),
      quantity: reorder ? Math.max(0, reorderPoint! - total) : Math.max(...belowPar.map((b) => b.par - b.level)),
      summary: reorder
        ? `${name}: ${total} on hand, at or below its reorder point of ${reorderPoint}`
        : `${name}: below par at ${[...new Set(belowPar.map((b) => b.place))].join(', ')}`,
      detail: { groupId: key, total, reorderPoint, belowPar },
    });
  }

  const open = await tx
    .select()
    .from(stockAttention)
    .where(
      and(
        eq(stockAttention.operatorId, scope.operatorId),
        eq(stockAttention.branchId, scope.branchId),
        inArray(stockAttention.kind, ['low_stock', 'reorder']),
        isNull(stockAttention.resolvedAt),
      ),
    );
  for (const row of open) {
    const want = wanted.get(row.dedupeKey);
    if (!want) {
      await tx
        .update(stockAttention)
        .set({ resolvedAt: now, resolvedByAccountId: scope.accountId ?? null, updatedAt: now })
        .where(eq(stockAttention.id, row.id));
      continue;
    }
    wanted.delete(row.dedupeKey);
    if (row.kind !== want.kind || row.rule !== want.rule || row.quantity !== want.quantity || row.summary !== want.summary) {
      await tx
        .update(stockAttention)
        .set({
          kind: want.kind,
          rule: want.rule,
          quantity: want.quantity,
          summary: want.summary,
          detail: want.detail as never,
          stockItemId: want.stockItemId,
          updatedAt: now,
        })
        .where(eq(stockAttention.id, row.id));
    }
  }
  for (const [dedupeKey, want] of wanted) {
    await tx
      .insert(stockAttention)
      .values({
        id: newId(),
        operatorId: scope.operatorId,
        branchId: scope.branchId,
        stockItemId: want.stockItemId,
        kind: want.kind,
        dedupeKey,
        rule: want.rule,
        quantity: want.quantity,
        summary: want.summary,
        detail: want.detail as never,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

/** The branch's open attention, low stock and the round-1 shortfalls alike, newest first. */
export async function listStockAttention(db: Exec, operatorId: string, branchId: string): Promise<StockAttentionView[]> {
  const rows = await db
    .select()
    .from(stockAttention)
    .where(
      and(eq(stockAttention.operatorId, operatorId), eq(stockAttention.branchId, branchId), isNull(stockAttention.resolvedAt)),
    )
    .orderBy(desc(stockAttention.updatedAt), desc(stockAttention.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    stockItemId: r.stockItemId,
    rule: r.rule,
    quantity: r.quantity,
    summary: r.summary,
    occurrences: r.occurrences,
    saleId: r.saleId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Somebody has looked: close one open attention row. A rule still firing raises a fresh one. */
export async function resolveStockAttention(tx: Tx, actor: StockActor, attentionId: string, now: Date): Promise<void> {
  const [row] = await tx
    .select()
    .from(stockAttention)
    .where(
      and(
        eq(stockAttention.id, attentionId),
        eq(stockAttention.operatorId, actor.operatorId),
        eq(stockAttention.branchId, actor.branchId),
      ),
    )
    .limit(1)
    .for('update');
  if (!row) throw errors.notFound('That stock alert is not one of this branch’s');
  if (row.resolvedAt) return;
  await tx
    .update(stockAttention)
    .set({ resolvedAt: now, resolvedByAccountId: actor.accountId, updatedAt: now })
    .where(eq(stockAttention.id, row.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'stock_attention.resolve',
    entityType: 'stock_attention',
    entityId: row.id,
    requestId: actor.requestId ?? null,
    before: { kind: row.kind, summary: row.summary },
    after: { resolved: true },
  });
}
