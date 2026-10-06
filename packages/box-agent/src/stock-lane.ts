import {
  STOCK_DEFAULT_VARIANT_ID,
  STOCK_LOCATION_TYPES,
  stockShortMessage,
  stockSizeName,
  type BridgeCart,
  type StockFiledMark,
  type StockLocationType,
  type StockSnapshotEntry,
  type StockSnapshotItem,
  type StockSnapshotPlace,
} from '@oto/shared';

/**
 * COUNTED STOCK WITH THE LINK DOWN — the arithmetic, with no I/O (S2-14b round
 * 3, plan `docs/progress/plans/stock/PLAN.md` §2.4).
 *
 * Its own module, as `wallet-lane.ts` is, so the guard has a cheap test
 * (`offline-stock-guard.test.ts`) and the bridge only does the reading and the
 * writing. The rules are the platform's guard at commit (`assertCartStock` in
 * `apps/api/src/services/stock.ts`), applied to the box's snapshot instead of
 * the live levels:
 *
 *   - a line takes the sizes it names: an add-on's `variantBreakdown` size by
 *     size, a shop or F&B line its one size, anything else the product's
 *     one-size item; a product the snapshot does not stock is not counted (the
 *     prototype's "no `inventoryItemId`");
 *   - a size the line does not name, or one this branch does not stock, is
 *     refused in the counter's words, as online;
 *   - what may be sold of a size is
 *
 *         snapshot total − this box's own counted shares of it whose sale
 *                          sits ABOVE the snapshot's filed mark
 *
 *     Each counted sale keeps its share per size WITH ITS OWN JOURNAL
 *     POSITION (epoch and `box_seq`, `StockShare`), on disk in the sale's own
 *     transaction, so a restart forgets nothing. The platform's snapshot says
 *     how far into this box's journal its levels reach (`boxFiled`). A share at
 *     or below the mark is in the levels already (or was filed aside and never
 *     will be); one above it is not. Never negative.
 *
 * WHY POSITIONS AND NOT TOTALS: comparing the box's all-time count with the
 * platform's all-time sum of this box's filed sales breaks for ever the first
 * time the two sets differ — a sale the platform filed that the box never
 * counted (no snapshot row at the time, a store re-provisioned under the same
 * box id) hides as many later unreflected sales, and a counted sale the
 * platform filed aside keeps the box refusing stock it has. A position is
 * either above the mark or not, whatever else either side has counted.
 */

/**
 * The `box_counter` scope this box's offline stock-taking sales are counted
 * in, per stock item, ACROSS ALL DAYS. No longer what the guard subtracts (the
 * shares above the filed mark are); kept as the running total a person reads
 * and as the ROW LOCK that serialises two sales of one size on this box: each
 * sale bumps it first, so a second sale's read of the open shares waits for
 * the first to commit.
 */
export const STOCK_TAKEN_TOTAL_SCOPE = 'stock_offline_taken_total';
/** The one "day" the all-days counter is kept under. */
export const STOCK_TAKEN_TOTAL_DAY = '1970-01-01';

/**
 * The runtime value holding one size's OPEN shares — those of this box's
 * counted sales no snapshot has yet been seen to reflect — as JSON. Pruned on
 * every write against the mark the sale was guarded with, so it holds an
 * outage's worth of sales, not the box's history.
 */
export const stockOpenKey = (stockItemId: string) => `stock_open:${stockItemId}`;

/** One counted sale's share of one size, with where in this box's journal the sale sits. */
export interface StockShare {
  saleId: string;
  journalEpoch: number;
  /** The highest position of the sale's own facts: the platform has the sale whole once its mark is here. */
  boxSeq: number;
  quantity: number;
}

/** The product code the prototype's socks add-on (`a-socks`) is stocked under (`sale.ts`'s `SOCKS_CODE`). */
export const STOCK_SOCKS_CODE = 'AO-SOCKS';
export const PROTOTYPE_SOCKS_ADD_ON_ID = 'a-socks';

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** The `stock` scope's one item as the box holds it, read defensively; null when it is not one. */
export function readStockSnapshot(payload: unknown): StockSnapshotItem | null {
  const items = rec(payload)?.items;
  const item = rec(Array.isArray(items) ? items[0] : null);
  if (!item || !Array.isArray(item.items)) return null;
  const places: StockSnapshotPlace[] = [];
  for (const raw of Array.isArray(item.places) ? item.places : []) {
    const p = rec(raw);
    const id = str(p?.id);
    if (!p || !id) continue;
    const type = (STOCK_LOCATION_TYPES as readonly unknown[]).includes(p.type) ? (p.type as StockLocationType) : 'back_of_house';
    places.push({ id, name: str(p.name) ?? 'Shelf', type, sellPoint: p.sellPoint === true });
  }
  const entries: StockSnapshotEntry[] = [];
  for (const raw of item.items) {
    const e = rec(raw);
    const stockItemId = str(e?.stockItemId);
    const productId = str(e?.productId);
    if (!e || !stockItemId || !productId) continue;
    const levels: Record<string, number> = {};
    for (const [placeId, quantity] of Object.entries(rec(e.levels) ?? {})) {
      const q = int(quantity);
      if (q !== null) levels[placeId] = Math.max(0, q);
    }
    const summed = Object.values(levels).reduce((sum, q) => sum + q, 0);
    entries.push({
      stockItemId,
      productId,
      variantId: str(e.variantId),
      itemName: str(e.itemName) ?? 'This item',
      sizeLabel: str(e.sizeLabel),
      levels,
      total: Math.max(0, int(e.total) ?? summed),
    });
  }
  return {
    version: str(item.version) ?? '',
    generatedAt: str(item.generatedAt) ?? '',
    branchId: str(item.branchId) ?? '',
    sellPointId: str(item.sellPointId),
    places,
    items: entries,
    boxFiled: readFiledMark(item.boxFiled),
  };
}

/** The snapshot's filed mark, read defensively: null when it is not a whole one. */
function readFiledMark(value: unknown): StockFiledMark | null {
  const mark = rec(value);
  const journalEpoch = int(mark?.journalEpoch);
  const boxSeq = int(mark?.boxSeq);
  if (journalEpoch === null || journalEpoch < 1 || boxSeq === null || boxSeq < 0) return null;
  return { journalEpoch, boxSeq };
}

/** One size's open shares as the box keeps them, read defensively; a damaged entry is dropped. */
export function readStockShares(raw: string | null): StockShare[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: StockShare[] = [];
  for (const value of Array.isArray(parsed) ? parsed : []) {
    const s = rec(value);
    const saleId = str(s?.saleId);
    const journalEpoch = int(s?.journalEpoch);
    const boxSeq = int(s?.boxSeq);
    const quantity = int(s?.quantity);
    if (!saleId || journalEpoch === null || boxSeq === null || quantity === null || quantity <= 0) continue;
    out.push({ saleId, journalEpoch, boxSeq, quantity });
  }
  return out;
}

/**
 * IS THIS SHARE ALREADY IN THE SNAPSHOT'S LEVELS? `boxEpoch` is the epoch the
 * box seals on NOW (its store's `journalEpoch`).
 *
 *  - No mark: nothing is.
 *  - The mark's own epoch: at or below the mark is.
 *  - THE BOX'S CURRENT EPOCH, with the mark on any other: never. The platform
 *    can only have filed this journal's sales under this journal's epoch — a
 *    mark on a newer epoch the box has not adopted (the `reset_store` answer
 *    lost on the way back) says nothing about the sales the box keeps sealing
 *    on its own.
 *  - An epoch OLDER than the box's own, below the mark's: is — the platform
 *    has moved on from that journal (its sales were applied, or the store that
 *    held them is gone). Above the mark's: is not — a re-provisioned store
 *    starts clean, every sale of it unreflected until the platform says so.
 *  - `boxEpoch` unknown (the store could not say): cautious — a share on any
 *    epoch but the mark's is not reflected.
 */
export function shareReflected(
  share: Pick<StockShare, 'journalEpoch' | 'boxSeq'>,
  mark: StockFiledMark | null,
  boxEpoch: number | null,
): boolean {
  if (!mark) return false;
  if (share.journalEpoch === mark.journalEpoch) return share.boxSeq <= mark.boxSeq;
  if (boxEpoch === null || share.journalEpoch === boxEpoch) return false;
  return share.journalEpoch < mark.journalEpoch;
}

/** The units of one size this box sold that the snapshot does not yet reflect (`shareReflected`). */
export function unreflectedUnits(
  shares: readonly StockShare[],
  mark: StockFiledMark | null,
  boxEpoch: number | null,
): number {
  return shares.reduce((sum, s) => (shareReflected(s, mark, boxEpoch) ? sum : sum + Math.max(0, s.quantity)), 0);
}

/** What one line of the cart asks of the shelves, before sizes are resolved. */
export interface StockAsk {
  productId: string;
  /** What the counter calls the line where the snapshot has no name for it. */
  label: string;
  quantity: number;
  /** A shop or F&B line's size. */
  variant?: { variantId: string; variantLabel?: string } | null;
  /** An add-on split across sizes. */
  breakdown?: ReadonlyArray<{ variantId: string; variantLabel?: string; quantity: number }>;
}

/**
 * THE ASKS A CART MAKES, from the cart itself: each shop or F&B item, each
 * ticket line's socks and each add-on. `productOf` names the product an
 * add-on id is (null when the box's catalogue does not have it — an unknown
 * add-on is not counted, as on the platform); `socksProductId` is the product
 * the cart's socks are (the cart's own add-on id, else the park's `AO-SOCKS`).
 */
export function stockAsksOf(
  cart: BridgeCart,
  opts: { socksProductId: string | null; productOf: (id: string) => { id: string; name: string } | null },
): StockAsk[] {
  const asks: StockAsk[] = [];
  for (const item of cart.items) {
    const product = opts.productOf(item.productId);
    asks.push({
      productId: item.productId,
      label: product?.name ?? 'This item',
      quantity: item.quantity,
      variant: item.variant ? { variantId: item.variant.variantId, variantLabel: item.variant.variantLabel } : null,
    });
  }
  for (const line of cart.lines) {
    if ((line.socks ?? 0) > 0 && opts.socksProductId) {
      asks.push({
        productId: opts.socksProductId,
        label: opts.productOf(opts.socksProductId)?.name ?? cart.socks?.label ?? 'Socks',
        quantity: line.socks ?? 0,
      });
    }
    for (const addOn of line.addOns ?? []) {
      const product = opts.productOf(addOn.id);
      if (!product) continue;
      asks.push({
        productId: product.id,
        label: product.name,
        quantity: addOn.quantity,
        ...(addOn.variantBreakdown ? { breakdown: addOn.variantBreakdown } : {}),
      });
    }
  }
  return asks.filter((a) => a.quantity > 0);
}

/** The stocked sizes a cart takes, and what the counter must hear about sizes first. */
export interface StockPlan {
  /** Units per stocked size, in the order the cart first named them. */
  demand: Map<string, number>;
  /** "Choose a size for Grip Socks — it comes in S, M, L", one per problem line. */
  sizeProblems: string[];
  /** The products the cart asks for that the snapshot counts. */
  counted: Set<string>;
}

function entriesOf(snapshot: StockSnapshotItem, productId: string): StockSnapshotEntry[] {
  return snapshot.items.filter((e) => e.productId === productId);
}

/** The sizes the counter can choose from, for a refusal: "S, M, L", in the snapshot's order. */
function sizeList(entries: readonly StockSnapshotEntry[]): string {
  return entries
    .map((e) => e.sizeLabel)
    .filter((label): label is string => !!label)
    .join(', ');
}

/**
 * Which stocked sizes each ask takes — `lineStock` on the platform, over the
 * snapshot. A product the snapshot does not stock takes nothing.
 */
export function planStock(asks: readonly StockAsk[], snapshot: StockSnapshotItem): StockPlan {
  const plan: StockPlan = { demand: new Map(), sizeProblems: [], counted: new Set() };
  const take = (entry: StockSnapshotEntry, quantity: number) => {
    plan.demand.set(entry.stockItemId, (plan.demand.get(entry.stockItemId) ?? 0) + quantity);
  };
  for (const ask of asks) {
    const entries = entriesOf(snapshot, ask.productId);
    if (entries.length === 0) continue;
    plan.counted.add(ask.productId);
    const name = entries[0]!.itemName || ask.label;
    const oneSize = entries.find((e) => e.variantId === null);
    const sized = (variantId: string) => entries.find((e) => e.variantId === variantId);
    const breakdown = (ask.breakdown ?? []).filter((b) => b.quantity > 0);
    if (breakdown.length > 0) {
      let named = 0;
      const unknown: string[] = [];
      for (const b of breakdown) {
        named += b.quantity;
        const entry = sized(b.variantId) ?? (b.variantId === STOCK_DEFAULT_VARIANT_ID ? oneSize : undefined);
        if (!entry) {
          unknown.push(b.variantLabel?.trim() || b.variantId);
          continue;
        }
        take(entry, b.quantity);
      }
      if (unknown.length > 0) {
        plan.sizeProblems.push(`${name} has no size ${unknown.join(', ')} in stock here — it comes in ${sizeList(entries)}`);
      }
      if (named < ask.quantity) plan.sizeProblems.push(`Choose a size for ${name} — it comes in ${sizeList(entries)}`);
      if (named > ask.quantity) {
        plan.sizeProblems.push(`The sizes chosen for ${name} add up to more than the ${ask.quantity} on the line`);
      }
      continue;
    }
    const variantId = ask.variant?.variantId;
    if (variantId) {
      const entry = sized(variantId) ?? oneSize;
      if (entry) take(entry, ask.quantity);
      else {
        plan.sizeProblems.push(
          `${name} has no size ${ask.variant?.variantLabel?.trim() || variantId} in stock here — it comes in ${sizeList(entries)}`,
        );
      }
      continue;
    }
    if (oneSize) take(oneSize, ask.quantity);
    else plan.sizeProblems.push(`Choose a size for ${name} — it comes in ${sizeList(entries)}`);
  }
  return plan;
}

/**
 * WHAT THIS BOX MAY STILL SELL OF ONE SIZE: the snapshot's total less this
 * box's own sales of it the snapshot does not yet reflect (`unreflected`, from
 * `unreflectedUnits`). Pure, and never negative.
 */
export function stockAvailable(entry: Pick<StockSnapshotEntry, 'total'>, unreflected: number): number {
  return Math.max(0, Math.max(0, entry.total) - Math.max(0, unreflected));
}

export interface StockShortage {
  stockItemId: string;
  /** "Grip Socks S". */
  name: string;
  requested: number;
  available: number;
}

/** Every size the plan wants more of than this box may sell, in the plan's order. */
export function stockShortages(
  demand: ReadonlyMap<string, number>,
  snapshot: StockSnapshotItem,
  unreflected: (stockItemId: string) => number,
): StockShortage[] {
  const out: StockShortage[] = [];
  for (const [stockItemId, requested] of demand) {
    const entry = snapshot.items.find((e) => e.stockItemId === stockItemId);
    if (!entry) continue;
    const available = stockAvailable(entry, unreflected(stockItemId));
    if (requested <= available) continue;
    out.push({ stockItemId, name: stockSizeName(entry.itemName, entry.sizeLabel), requested, available });
  }
  return out;
}

/** THE REFUSAL, in the counter's words: "Only 3 Grip Socks S left. Nothing was saved." */
export function stockShortRefusal(shortages: readonly StockShortage[]): string {
  return `${shortages.map((s) => stockShortMessage(s.name, s.available)).join('. ')}. Nothing was saved.`;
}

/** The size refusal, in the platform guard's words. */
export function stockSizeRefusal(problems: readonly string[]): string {
  return `${problems.join('. ')}. Nothing was saved.`;
}

/**
 * How long an unchanged `stock` copy goes before the agent writes it again
 * anyway, to keep its `appliedAt` near what the platform last confirmed — far
 * inside `STOCK_SNAPSHOT_REFUSE_AFTER_S`, and far from a write every tick.
 */
export const STOCK_SNAPSHOT_REWRITE_AFTER_MS = 15 * 60 * 1000;
