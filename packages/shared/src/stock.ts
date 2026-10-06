import { z } from 'zod';
import { addDaysToIsoDate } from './business-date';

/**
 * S2-14b — stock, the parts the till, the api and a box all need to agree on.
 * Plan: docs/progress/plans/stock/PLAN.md.
 *
 * Quantities are WHOLE EACHES everywhere. A pack ("Dozen = 12") exists only at
 * entry and on screen (`parsePackQuantity`, `formatInPacks`), ported from the
 * prototype's `lib/stockUnits.ts` with one correction the plan makes: an entry
 * that does not land on a whole each is refused, never rounded.
 */

/** The prototype's location types (`types.ts:787`). */
export const STOCK_LOCATION_TYPES = ['bulk', 'back_of_house', 'rotation'] as const;
export type StockLocationType = (typeof STOCK_LOCATION_TYPES)[number];

/**
 * THE CASCADE ORDER (plan §2.2). A sale takes from the sell point first, then
 * from the other places in the transfer-source order: back of house, then
 * bulk, then any other rotation shelf. The prototype had two orders that
 * disagreed — `adjustInventoryStock` cascaded in object-key order
 * (`catalogStore.ts:1260-1264`); the transfer flow sources BOH before bulk —
 * and the transfer order wins.
 */
export const STOCK_CASCADE_TYPE_ORDER: readonly StockLocationType[] = ['back_of_house', 'bulk', 'rotation'];

/** A stock-take difference above this is flagged (prototype `StockTakeFlow.tsx:102`; OD-S1). */
export const STOCK_TAKE_FLAG_THRESHOLD = 3;

/**
 * The most eaches one entry may name. Levels are Postgres `integer`s; a million
 * of anything is already far past every shelf the park has, so an entry above
 * it is a typo and is refused rather than stored.
 */
export const STOCK_MAX_EACHES = 1_000_000;

/** The prototype's "default" variant id for an item sold in one size (`types.ts:781`). */
export const STOCK_DEFAULT_VARIANT_ID = 'default';

/** Stock health of one size — `lib/inventory.ts:variantStatus`, unchanged. */
export type StockStatus = 'out' | 'low' | 'ok';

export function stockStatus(onHand: number, lowStockThreshold: number | null | undefined): StockStatus {
  if (onHand <= 0) return 'out';
  if (lowStockThreshold !== null && lowStockThreshold !== undefined && onHand <= lowStockThreshold) return 'low';
  return 'ok';
}

/** How the counter names one size: "Grip Socks S", or just "Oto Cap". */
export function stockSizeName(itemName: string, sizeLabel: string | null | undefined): string {
  return sizeLabel ? `${itemName} ${sizeLabel}` : itemName;
}

/**
 * THE REFUSAL, in the counter's words: "Only 3 Grip Socks S left", or
 * "Mascot Keyring is out of stock".
 */
export function stockShortMessage(name: string, available: number): string {
  return available <= 0 ? `${name} is out of stock` : `Only ${available} ${name} left`;
}

// --- Packs --------------------------------------------------------------------

export interface StockPack {
  /** What staff type and read, `Dozen`. */
  label: string;
  /** How many eaches one pack holds — a positive whole number. */
  eaches: number;
}

export type PackParse =
  | { ok: true; eaches: number }
  | { ok: false; reason: string };

/**
 * A quantity typed at a stock screen, in eaches.
 *
 *   "24"           → 24
 *   "2 cases"      → 2 × case
 *   "1 case + 3"   → case + 3
 *   "1.5 dozen"    → 18 — a part pack that lands on whole eaches is fine
 *   "1.3 dozen"    -> 16, rounding the combined total
 *   "0.5 + 0.5"    -> 1
 *   "-3"           -> 0
 *
 * Matches the approved quantity entry: negative segments floor at zero,
 * unrecognised labels are eaches, and the final total is rounded for review.
 */
export function parsePackQuantity(raw: string, packs: readonly StockPack[]): PackParse {
  const str = raw.trim().toLowerCase();
  if (!str) return { ok: true, eaches: 0 };
  let total = 0;
  for (const part of str.split('+').map((p) => p.trim())) {
    if (!part) continue;
    if (/^-?infinity$/i.test(part)) return { ok: false, reason: `"${part}" is not a number of things` };
    let segment: number | null = null;
    for (const pack of packs) {
      const label = pack.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`^(-?[\\d.]+)\\s*${label}s?$`).exec(part);
      if (match) {
        const count = parseFloat(match[1]!);
        if (!Number.isFinite(count)) return { ok: false, reason: `"${part}" is not a number of ${pack.label}s` };
        segment = count * pack.eaches;
        break;
      }
    }
    if (segment === null) {
      const n = parseFloat(part);
      segment = Number.isNaN(n) ? 0 : n;
    }
    // Non-finite quantities cannot be stored, even with lenient entry.
    if (!Number.isFinite(segment)) return { ok: false, reason: `"${part}" is not a number of things` };
    total += Math.max(0, segment);
  }
  total = Math.round(total);
  // A shelf count the database cannot hold is not a count anybody made.
  if (total > STOCK_MAX_EACHES) {
    return { ok: false, reason: `${total} is more than any shelf holds — check the quantity` };
  }
  return { ok: true, eaches: total };
}

/** Eaches as packs, largest first: 27 with Case = 24 → "1 Case + 3" (`formatInUnits`). */
export function formatInPacks(eaches: number, packs: readonly StockPack[]): string {
  if (!packs.length || eaches <= 0) return String(eaches);
  const sorted = [...packs].sort((a, b) => b.eaches - a.eaches);
  let remaining = eaches;
  const parts: string[] = [];
  for (const pack of sorted) {
    const count = Math.floor(remaining / pack.eaches);
    if (count > 0) {
      parts.push(`${count} ${pack.label}${count !== 1 ? 's' : ''}`);
      remaining -= count * pack.eaches;
    }
  }
  if (remaining > 0) parts.push(String(remaining));
  return parts.join(' + ') || String(eaches);
}

// --- What a sale line freezes -------------------------------------------------

/**
 * One stocked size a sale line takes, frozen on the line at commit
 * (`sale_line.payload.stock`): which stock item, which size, how many, and the
 * cost per each at that moment — so cost of goods is reportable later and the
 * finalise decrement does not depend on a link that may since have moved.
 */
export interface SaleLineStockShare {
  stockItemId: string;
  /** The size's id; null for an item sold in one size. */
  variantId: string | null;
  quantity: number;
  /** Satang per each; null when no cost is set. */
  unitCostSatang: number | null;
}

// --- What the till reads --------------------------------------------------------

export const SellableStockSizeSchema = z.object({
  /** The size's id within the product; null for a product sold in one size. */
  variantId: z.string().nullable(),
  label: z.string().nullable(),
  stockItemId: z.string().uuid(),
  /** Everything this branch holds of the size, every place counted (the guard's number). */
  available: z.number().int(),
  /** What the sell point holds. */
  atSellPoint: z.number().int(),
  lowStockThreshold: z.number().int().nullable(),
  status: z.enum(['out', 'low', 'ok']),
});
export type SellableStockSize = z.infer<typeof SellableStockSizeSchema>;

export const SellableStockProductSchema = z.object({
  productId: z.string().uuid(),
  name: z.string(),
  sizes: z.array(SellableStockSizeSchema),
});
export type SellableStockProduct = z.infer<typeof SellableStockProductSchema>;

export const SellableStockSchema = z.object({
  branchId: z.string().uuid(),
  sellPointId: z.string().uuid().nullable(),
  products: z.array(SellableStockProductSchema),
});
export type SellableStock = z.infer<typeof SellableStockSchema>;

// --- What the stock screens read --------------------------------------------------

/**
 * Cost per each is a manager's figure (it prices every order and the stock's
 * value): the level and ledger reads answer it only to an account that holds
 * `pos:stock:order` at the branch, and null to everyone else — the counter
 * included, the way the sale answer never carries it.
 */
export const StockPlaceViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.enum(STOCK_LOCATION_TYPES),
  sellPoint: z.boolean(),
});
export type StockPlaceView = z.infer<typeof StockPlaceViewSchema>;

export const StockLocationsSchema = z.object({
  locations: z.array(StockPlaceViewSchema.extend({ active: z.boolean() })),
});

export const StockLevelItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  category: z.string().nullable(),
  active: z.boolean(),
  productId: z.string().uuid().nullable(),
  variantId: z.string().nullable(),
  variantLabel: z.string().nullable(),
  unitCostSatang: z.number().int().nullable(),
  lowStockThreshold: z.number().int().nullable(),
  parByLocation: z.record(z.string(), z.number()),
  /** The reorder point set in Admin Inventory (the static rule). */
  reorderPoint: z.number().int().nullable(),
  /**
   * The item's reorder point TODAY by the platform's rule (`reorderPointFor`):
   * the static point until the item has `STOCK_TREND_HISTORY_DAYS` days of
   * sales, its usage from then on — the figure the low-stock attention fires
   * on, so every stock screen agrees with the Alerts tab. Every size of one
   * item carries the same figure; null while the item has none.
   */
  reorderPointNow: z.number().int().nullable(),
  reorderQuantity: z.number().int().nullable(),
  leadTimeDays: z.number().int().nullable(),
  supplierName: z.string().nullable(),
  supplierContact: z.string().nullable(),
  /** location id → what that place holds. */
  byLocation: z.record(z.string(), z.number().int()),
  total: z.number().int(),
  status: z.enum(['out', 'low', 'ok']),
  /**
   * S2-14b round 2 — the sizes of one stocked thing share this key, so the
   * stock screens show them as one item with sizes (the prototype's
   * `InventoryItem` with its `variants`): the linked product's id, else the
   * group the sizes were created in, else the row's own id.
   */
  groupId: z.string(),
  /** The item's own product-line code (`OTO-SOCK`); `sku` above is this size's. */
  itemSku: z.string().nullable(),
  /** What the linked product is — `merch`, `addon`, `menu` — or null when unlinked. */
  productKind: z.string().nullable(),
  /** Pack sizes for entry and display (`Dozen = 12`); quantities stay in eaches. */
  units: z.array(z.object({ code: z.string(), label: z.string(), eaches: z.number().int() })),
  /** A photo for the stock screens (a data URL), and whether the sell tile shows it too. */
  photoUrl: z.string().nullable(),
  showPhotoInPos: z.boolean(),
});
export type StockLevelItem = z.infer<typeof StockLevelItemSchema>;

export const StockLevelsSchema = z.object({
  branchId: z.string().uuid(),
  locations: z.array(StockPlaceViewSchema),
  items: z.array(StockLevelItemSchema),
});
export type StockLevels = z.infer<typeof StockLevelsSchema>;

export const StockMovementViewSchema = z.object({
  id: z.string().uuid(),
  stockItemId: z.string().uuid(),
  stockLocationId: z.string().uuid(),
  kind: z.string(),
  /** Signed, in eaches. */
  quantity: z.number().int(),
  levelAfter: z.number().int(),
  shortfall: z.number().int(),
  saleId: z.string().uuid().nullable(),
  saleLineId: z.string().uuid().nullable(),
  refundId: z.string().uuid().nullable(),
  transferId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  unitCostSatang: z.number().int().nullable(),
  businessDate: z.string(),
  actorAccountId: z.string().uuid().nullable(),
  stationId: z.string().uuid().nullable(),
  offline: z.boolean(),
  occurredAt: z.string(),
  createdAt: z.string(),
});
export type StockMovementView = z.infer<typeof StockMovementViewSchema>;

export const StockMovementsSchema = z.object({ movements: z.array(StockMovementViewSchema) });

/** A product's stock links, as the catalogue read and write carry them. */
export const ProductStockLinkSchema = z.object({
  variantId: z.string().min(1).max(32).nullable(),
  stockItemId: z.string().uuid(),
});
export type ProductStockLink = z.infer<typeof ProductStockLinkSchema>;

/**
 * H3 (round 2) — a product sold in sizes is stock-tracked in ALL of its sizes
 * or in NONE: a partial link leaves the till offering a size it cannot take off
 * any shelf. Answers the refusal in plain words, or null when the links are
 * whole. A product in one size takes one link with no size, or none.
 */
export function partialStockLinkProblem(
  productName: string,
  sizes: ReadonlyArray<{ id: string; label: string }>,
  links: ReadonlyArray<{ variantId: string | null }>,
): string | null {
  if (links.length === 0) return null;
  if (sizes.length === 0) {
    return links.length === 1 && links[0]!.variantId === null
      ? null
      : `"${productName}" is sold in one size — link one stock item with no size, or none`;
  }
  const linked = new Set(links.map((l) => l.variantId));
  const all = sizes.map((s) => s.label).join(', ');
  if (linked.has(null)) {
    return `"${productName}" comes in ${all} — link each size to its own stock item, not one for the whole item`;
  }
  const missing = sizes.filter((s) => !linked.has(s.id)).map((s) => s.label);
  if (missing.length > 0) {
    return `"${productName}" comes in ${all} — link all of its sizes or none (${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not linked)`;
  }
  return null;
}

// --- Round 2: the stock module's writes (plan §2.3) ----------------------------
//
// Every quantity is whole eaches, one or more, and never past what any shelf
// holds. Refusals are in the counter's words; the api is the rule and these
// shapes are only the door.

const StockId = z.string().uuid();
/** A quantity that moves stock: one each or more. */
const MovingEaches = z.number().int().min(1, 'Enter at least one').max(STOCK_MAX_EACHES);
const StockReason = z.string().trim().min(1, 'Give a reason').max(200);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date, yyyy-mm-dd');

/** Move stock between two places of the branch. Each line clamps to what the source holds. */
export const StockTransferBodySchema = z.object({
  fromLocationId: StockId,
  toLocationId: StockId,
  lines: z.array(z.object({ stockItemId: StockId, quantity: MovingEaches })).min(1).max(200),
});
export type StockTransferBody = z.infer<typeof StockTransferBodySchema>;

export const StockTransferResultSchema = z.object({
  transferId: StockId,
  fromLocationId: StockId,
  toLocationId: StockId,
  lines: z.array(
    z.object({
      stockItemId: StockId,
      requested: z.number().int(),
      /** What actually moved — the source's level when it held less than asked. */
      moved: z.number().int(),
      fromLevel: z.number().int(),
      toLevel: z.number().int(),
    }),
  ),
});
export type StockTransferResult = z.infer<typeof StockTransferResultSchema>;

/** A delivery with no purchase order: a reason is required (the prototype's Manual receive). */
export const StockReceiveBodySchema = z.object({
  stockItemId: StockId,
  locationId: StockId,
  quantity: MovingEaches,
  reason: StockReason,
});
export type StockReceiveBody = z.infer<typeof StockReceiveBodySchema>;

export const StockReceiveResultSchema = z.object({
  stockItemId: StockId,
  locationId: StockId,
  received: z.number().int(),
  levelAfter: z.number().int(),
});
export type StockReceiveResult = z.infer<typeof StockReceiveResultSchema>;

/**
 * A manager's correction — shrinkage, a damaged unit, staff use. Signed; a
 * place is optional: an increase lands at the sell point, a decrease takes from
 * the sell point first and then the cascade (the prototype's
 * `adjustInventoryStock`), and never past what the branch holds.
 */
export const StockAdjustBodySchema = z.object({
  stockItemId: StockId,
  locationId: StockId.optional(),
  delta: z
    .number()
    .int()
    .min(-STOCK_MAX_EACHES)
    .max(STOCK_MAX_EACHES)
    .refine((n) => n !== 0, 'Enter a non-zero adjustment amount'),
  reason: StockReason,
});
export type StockAdjustBody = z.infer<typeof StockAdjustBodySchema>;

export const StockAdjustResultSchema = z.object({
  stockItemId: StockId,
  delta: z.number().int(),
  movements: z.array(z.object({ locationId: StockId, quantity: z.number().int(), levelAfter: z.number().int() })),
});
export type StockAdjustResult = z.infer<typeof StockAdjustResultSchema>;

// --- Purchase orders -------------------------------------------------------------

export const PURCHASE_ORDER_STATE_VALUES = ['to_order', 'ordered', 'received'] as const;

export const PurchaseOrderLineViewSchema = z.object({
  id: StockId,
  stockItemId: StockId,
  itemName: z.string(),
  variantLabel: z.string().nullable(),
  orderedQuantity: z.number().int(),
  receivedQuantity: z.number().int(),
});
export type PurchaseOrderLineView = z.infer<typeof PurchaseOrderLineViewSchema>;

export const PurchaseOrderViewSchema = z.object({
  id: StockId,
  branchId: StockId,
  supplierName: z.string(),
  supplierContact: z.string().nullable(),
  state: z.enum(PURCHASE_ORDER_STATE_VALUES),
  receiveLocationId: StockId.nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  orderedAt: z.string().nullable(),
  orderedBy: z.string().nullable(),
  expectedArrivalDate: z.string().nullable(),
  receivedAt: z.string().nullable(),
  receivedBy: z.string().nullable(),
  notes: z.string().nullable(),
  lines: z.array(PurchaseOrderLineViewSchema),
});
export type PurchaseOrderView = z.infer<typeof PurchaseOrderViewSchema>;

export const PurchaseOrdersSchema = z.object({ orders: z.array(PurchaseOrderViewSchema) });

/**
 * Put sizes on the supplier's open order — the order to that supplier still
 * `to_order` at this branch, created when there is none; a size already on it
 * has its quantity added (the prototype's `addToPurchaseOrder`).
 */
export const PurchaseOrderAddBodySchema = z.object({
  lines: z.array(z.object({ stockItemId: StockId, quantity: MovingEaches })).min(1).max(50),
});
export type PurchaseOrderAddBody = z.infer<typeof PurchaseOrderAddBodySchema>;

export const PurchaseOrderLineQuantityBodySchema = z.object({ quantity: MovingEaches });

export const PurchaseOrderMarkOrderedBodySchema = z.object({
  /** Defaults to today + the largest lead time on the order. */
  expectedArrivalDate: IsoDate.optional(),
  notes: z.string().trim().max(500).optional(),
});

export const PurchaseOrderReceiveBodySchema = z.object({ quantity: MovingEaches, locationId: StockId });

export const PurchaseOrderReceiveResultSchema = z.object({
  order: PurchaseOrderViewSchema,
  requested: z.number().int(),
  /** Clamped to what was outstanding on the line. */
  received: z.number().int(),
  levelAfter: z.number().int(),
});

export const PurchaseOrderAnswerSchema = z.object({ order: PurchaseOrderViewSchema.nullable() });

// --- Stock take --------------------------------------------------------------------

export const StockTakeBodySchema = z.object({
  lines: z
    .array(
      z.object({
        stockItemId: StockId,
        locationId: StockId,
        countedQuantity: z.number().int().min(0, 'A count is never below nothing').max(STOCK_MAX_EACHES),
      }),
    )
    .min(1)
    .max(2000),
  note: z.string().trim().max(500).optional(),
});
export type StockTakeBody = z.infer<typeof StockTakeBodySchema>;

export const StockTakeLineViewSchema = z.object({
  id: StockId,
  stockItemId: StockId,
  locationId: StockId,
  expectedQuantity: z.number().int(),
  countedQuantity: z.number().int(),
  difference: z.number().int(),
  flagged: z.boolean(),
  status: z.enum(['pending', 'confirmed', 'adjusted']),
  /**
   * This shelf's place had never been counted: the line is that place's
   * OPENING (OD-S5, per place) — a starting figure, never flagged, and never a
   * discrepancy, shrinkage or variance.
   */
  opening: z.boolean(),
});
export type StockTakeLineView = z.infer<typeof StockTakeLineViewSchema>;

export const StockTakeResultSchema = z.object({
  id: StockId,
  /**
   * Every place this take counted was at its opening — its first count there
   * (OD-S5 is per place: a branch counts one place at a time). Each line says
   * so for its own place.
   */
  opening: z.boolean(),
  lines: z.array(StockTakeLineViewSchema),
});
export type StockTakeResult = z.infer<typeof StockTakeResultSchema>;

/**
 * Whether each place of the branch has been counted yet — asked by the count's
 * review screen BEFORE the commit, so it can say plainly that a place's first
 * count is its opening (sets the starting figures, flags nothing) instead of
 * warning of discrepancies the platform will not record.
 */
export const StockPlaceOpeningSchema = z.object({
  locationId: StockId,
  /**
   * False while the place has nothing on record — never counted, and no
   * movement (a transfer in, a delivery) ever changed what it holds: the next
   * count there is its opening. A place the ledger has stocked is opened even
   * before its first count, and that count is judged against the record.
   */
  opened: z.boolean(),
  /** When the place's record started (its first count or first movement); null while it has none. */
  openedAt: z.string().nullable(),
});
export type StockPlaceOpening = z.infer<typeof StockPlaceOpeningSchema>;

export const StockPlaceOpeningsSchema = z.object({ places: z.array(StockPlaceOpeningSchema) });
export type StockPlaceOpenings = z.infer<typeof StockPlaceOpeningsSchema>;

/** True when a count's difference is big enough to flag (prototype `StockTakeFlow.tsx:102`). */
export function stockTakeFlagged(difference: number): boolean {
  return Math.abs(difference) > STOCK_TAKE_FLAG_THRESHOLD;
}

// --- Setup: places and items --------------------------------------------------------

export const StockLocationViewSchema = StockPlaceViewSchema.extend({ active: z.boolean() });
export type StockLocationView = z.infer<typeof StockLocationViewSchema>;

export const StockLocationBodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  type: z.enum(STOCK_LOCATION_TYPES),
});
export const StockLocationPatchSchema = StockLocationBodySchema.partial().extend({ active: z.boolean().optional() });

export const StockItemSizeInputSchema = z.object({
  /** The size's own stock item when it already exists; absent for a new size. */
  stockItemId: StockId.optional(),
  /** The linked product's size id (`s`); null for a product sold in one size. */
  variantId: z.string().trim().min(1).max(32).nullable(),
  label: z.string().trim().min(1, 'Label required').max(40),
  sku: z.string().trim().max(60).nullable().optional(),
  lowStockThreshold: z.number().int().min(0, 'Threshold must be 0 or more').nullable(),
  /** Opening eaches on a new item only; recorded as a movement at the sell point. */
  startingStock: z.number().int().min(0).max(STOCK_MAX_EACHES).optional(),
  /** location id → par on that shelf. */
  parByLocation: z.record(StockId, z.number().int().min(0, 'Par must be 0 or more')),
});
export type StockItemSizeInput = z.infer<typeof StockItemSizeInputSchema>;

export const StockItemBodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  sku: z.string().trim().max(60).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  active: z.boolean().default(true),
  /** The sellable it stocks; null leaves it unlinked (counted, never sold). */
  productId: StockId.nullable(),
  unitCostSatang: z.number().int().min(0).nullable(),
  reorder: z
    .object({
      reorderPoint: z.number().int().min(0, 'Reorder point must be 0 or more'),
      reorderQuantity: z.number().int().min(1, 'Reorder qty must be at least 1'),
      leadTimeDays: z.number().int().min(1, 'Lead time must be at least 1 day'),
      supplierName: z.string().trim().min(1, 'Supplier name is required').max(120),
      supplierContact: z.string().trim().max(120).nullable().optional(),
    })
    .nullable(),
  units: z
    .array(
      z.object({
        label: z.string().trim().min(1, 'Unit name required').max(30),
        eaches: z.number().int().min(1, 'A pack holds 1 or more').max(100_000),
      }),
    )
    .max(10),
  photoUrl: z.string().max(400_000).nullable().optional(),
  showPhotoInPos: z.boolean().default(false),
  sizes: z.array(StockItemSizeInputSchema).min(1).max(50),
});
export type StockItemBody = z.infer<typeof StockItemBodySchema>;

export const StockItemResultSchema = z.object({ groupId: z.string(), stockItemIds: z.array(StockId) });

// --- Attention ------------------------------------------------------------------------

/** One size under its par at one place, as the low-stock rule read it. */
export const StockAttentionBelowParSchema = z.object({
  stockItemId: StockId,
  /** The size's label; null for an item in one size. */
  size: z.string().nullable(),
  /** The place's id; null on a row written before the platform recorded it (match by `place`). */
  locationId: StockId.nullable(),
  place: z.string(),
  level: z.number().int(),
  par: z.number().int(),
});
export type StockAttentionBelowPar = z.infer<typeof StockAttentionBelowParSchema>;

/**
 * What a low-stock row's rule read when it fired — the figures the Alerts
 * screen shows, so the screen never works its own out (walkthrough F3).
 */
export const StockAttentionLowStockSchema = z.object({
  /** The stock screens' item: every size of it shares this key. */
  groupId: z.string(),
  /** Everything the item holds, every size and place. */
  total: z.number().int(),
  /** The point the total is held against (static or 30-day usage); null when the item has no reorder settings. */
  reorderPoint: z.number().int().nullable(),
  /** Which rule set the point: the item's own figure, or its last 30 days of usage (OD-27). */
  reorderRule: z.enum(['static', 'trend']),
  staticReorderPoint: z.number().int().nullable(),
  /** Units used in the 30 days before today, when the 30-day usage set the point. */
  usedInWindow: z.number().int().nullable(),
  /** True when the total is at or below the reorder point. */
  reorder: z.boolean(),
  belowPar: z.array(StockAttentionBelowParSchema),
});
export type StockAttentionLowStock = z.infer<typeof StockAttentionLowStockSchema>;

export const StockAttentionViewSchema = z.object({
  id: StockId,
  kind: z.enum(['stock_shortfall', 'size_unknown', 'low_stock', 'reorder']),
  stockItemId: StockId.nullable(),
  /** Which rule fired ("Below par at FOH", "≤ reorder point", "≤ reorder point (30-day usage)"). */
  rule: z.string().nullable(),
  quantity: z.number().int(),
  summary: z.string(),
  occurrences: z.number().int(),
  saleId: StockId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** A low-stock or reorder row's figures; null on a row a sale raised. */
  lowStock: StockAttentionLowStockSchema.nullable(),
});
export type StockAttentionView = z.infer<typeof StockAttentionViewSchema>;

export const StockAttentionsSchema = z.object({ attention: z.array(StockAttentionViewSchema) });

/** The words a low-stock attention carries for the rule that fired. */
export const STOCK_RULE_REORDER = '≤ reorder point';
export const stockRuleBelowPar = (placeName: string): string => `Below par at ${placeName}`;

// --- Round 4: the consumption-trend reorder rule (OD-27, plan §2.5) ------------------

/** Days of sale history an item needs before its reorder point comes from its usage. */
export const STOCK_TREND_HISTORY_DAYS = 30;
/** The rule's words on an attention row when the point came from the item's usage. */
export const STOCK_RULE_REORDER_TREND = '≤ reorder point (30-day usage)';

export interface ReorderPointAnswer {
  /** Which rule set the point: the item's own figure, or its last 30 days of usage. */
  rule: 'static' | 'trend';
  /** The point the item's total is held against; null when the item has no reorder settings. */
  reorderPoint: number | null;
  /** The static figure the item carries, kept for the attention's detail. */
  staticPoint: number | null;
  /** Units used in the 30 days before today (sales net of refunds), when the trend fired. */
  usedInWindow: number | null;
}

/**
 * OD-27 — WHICH REORDER POINT HOLDS TODAY. Before an item has
 * `STOCK_TREND_HISTORY_DAYS` of sale history (its first sale movement at least
 * 30 business days before today) the static reorder point stands. From then on
 * the point is its average daily usage over the 30 days before today, times
 * its lead time, rounded UP to a whole each:
 *
 *     ceil(used in the 30 days × lead time / 30)
 *
 * Integer arithmetic throughout, so the same history always gives the same
 * point. An item with no reorder settings (no static point, or no lead time to
 * multiply by) has no reorder rule at all, as before.
 */
export function reorderPointFor(input: {
  staticPoint: number | null;
  leadTimeDays: number | null;
  /** The business date of the item's earliest sale movement; null when it has never sold. */
  firstSaleDate: string | null;
  /** Today's business date at the branch. */
  today: string;
  /** Units used in the 30 business days before today. */
  usedInWindow: number;
}): ReorderPointAnswer {
  const staticAnswer: ReorderPointAnswer = {
    rule: 'static',
    reorderPoint: input.staticPoint,
    staticPoint: input.staticPoint,
    usedInWindow: null,
  };
  if (input.staticPoint === null || input.leadTimeDays === null || input.firstSaleDate === null) return staticAnswer;
  const historyFrom = addDaysToIsoDate(input.firstSaleDate, STOCK_TREND_HISTORY_DAYS);
  if (historyFrom > input.today) return staticAnswer;
  const used = Math.max(0, Math.trunc(input.usedInWindow));
  const cover = input.leadTimeDays;
  return {
    rule: 'trend',
    reorderPoint: Math.ceil((used * cover) / STOCK_TREND_HISTORY_DAYS),
    staticPoint: input.staticPoint,
    usedInWindow: used,
  };
}

// --- Round 4: reports from the ledger (plan §2.5) ------------------------------------
//
// Every figure is read from `pos.stock_movement` (and the counts and orders the
// movements point at), so each report adds up to the movements it names. Cost
// figures are a manager's (`StockPlaceViewSchema`'s note): null to anyone else.

const ReportDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date, yyyy-mm-dd');

export const StockReportQuerySchema = z.object({
  /** Inclusive business dates. */
  from: ReportDate,
  to: ReportDate,
});
export type StockReportQuery = z.infer<typeof StockReportQuerySchema>;

const ReportSize = {
  stockItemId: z.string().uuid(),
  /** The item's name ("Grip Socks"). */
  name: z.string(),
  /** The size's label, or null for an item in one size. */
  variantLabel: z.string().nullable(),
  /** The sizes of one item share this key (the stock screens' item). */
  groupId: z.string(),
  /** What the linked product is — `merch`, `addon`, `menu` — or null when unlinked. */
  productKind: z.string().nullable(),
};

/**
 * One counted shelf of a stock take in the range — matched or not, as the
 * prototype's log keeps every take (`getStockTakeLog`). A place's opening — its
 * first count — is a starting figure, not a variance, and is left out (OD-S5).
 */
export const StockDiscrepancyRowSchema = z.object({
  id: z.string().uuid(),
  ...ReportSize,
  locationId: z.string().uuid(),
  locationName: z.string(),
  expectedQuantity: z.number().int(),
  countedQuantity: z.number().int(),
  difference: z.number().int(),
  flagged: z.boolean(),
  countedAt: z.string(),
  businessDate: z.string(),
});
export type StockDiscrepancyRow = z.infer<typeof StockDiscrepancyRowSchema>;

/** Sales net of refunds, per size. `sold` counts the units a paid sale took past the record too. */
export const StockUsageRowSchema = z.object({
  ...ReportSize,
  sold: z.number().int(),
  refunded: z.number().int(),
  net: z.number().int(),
  /** Of `sold`, what was sold with the link down. */
  soldOffline: z.number().int(),
  /** Cost of the net units at the cost frozen on each movement; null to a non-manager or when no cost was frozen. */
  costSatang: z.number().int().nullable(),
});
export type StockUsageRow = z.infer<typeof StockUsageRowSchema>;

/** Count variances and corrections down, per size: what left the shelves unsold. */
export const StockShrinkageRowSchema = z.object({
  ...ReportSize,
  /** Signed sum of the count movements (counted − expected), each place's opening excluded. */
  countVariance: z.number().int(),
  /** How many counts found the shelf short. */
  countedShort: z.number().int(),
  /** Sum of the corrections down (negative). */
  adjustedDown: z.number().int(),
  /** countVariance + adjustedDown. */
  total: z.number().int(),
  /** −Σ quantity × frozen cost over those movements; null to a non-manager. */
  lossSatang: z.number().int().nullable(),
  /** True when one of those movements carried no cost: the loss is understated. */
  costMissing: z.boolean(),
});
export type StockShrinkageRow = z.infer<typeof StockShrinkageRowSchema>;

export const StockPurchaseLineSchema = z.object({
  id: z.string().uuid(),
  stockItemId: z.string().uuid(),
  groupId: z.string(),
  productKind: z.string().nullable(),
  itemName: z.string(),
  variantLabel: z.string().nullable(),
  orderedQuantity: z.number().int(),
  receivedQuantity: z.number().int(),
  /** Units the ledger received against this line: equals `receivedQuantity`. */
  receivedInLedger: z.number().int(),
  /** The item's cost per each now, for the ordered value; null to a non-manager or when none is set. */
  unitCostSatang: z.number().int().nullable(),
  /** The received units at the cost frozen on each receipt; null to a non-manager. */
  receivedCostSatang: z.number().int().nullable(),
});
export type StockPurchaseLine = z.infer<typeof StockPurchaseLineSchema>;

export const StockPurchaseOrderRowSchema = z.object({
  id: z.string().uuid(),
  supplierName: z.string(),
  state: z.enum(PURCHASE_ORDER_STATE_VALUES),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  expectedArrivalDate: z.string().nullable(),
  lines: z.array(StockPurchaseLineSchema),
});
export type StockPurchaseOrderRow = z.infer<typeof StockPurchaseOrderRowSchema>;

/** What a size holds now and what it is worth: cost × on hand, "no cost set" flagged. */
export const StockValueRowSchema = z.object({
  ...ReportSize,
  /**
   * place id → what it holds: every live place, and a retired place that still
   * holds some (a manager may retire a shelf that is not the sell point while
   * stock sits on it — the record still holds those units).
   */
  byLocation: z.record(z.string(), z.number().int()),
  /** Σ of `byLocation`: what the record holds, so it equals the day's fact closing. */
  onHand: z.number().int(),
  /** Of `onHand`, the units on a retired place (0 when none) — told, so the total is never a surprise. */
  retiredOnHand: z.number().int(),
  unitCostSatang: z.number().int().nullable(),
  valueSatang: z.number().int().nullable(),
  /** No cost is set on the item (a manager sees this; to anyone else the cost is simply not shown). */
  noCostSet: z.boolean(),
});
export type StockValueRow = z.infer<typeof StockValueRowSchema>;

export const StockReportsSchema = z.object({
  branchId: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  /** False when the caller is not answered cost figures. */
  withCost: z.boolean(),
  discrepancies: z.array(StockDiscrepancyRowSchema),
  usage: z.array(StockUsageRowSchema),
  shrinkage: z.array(StockShrinkageRowSchema),
  purchases: z.array(StockPurchaseOrderRowSchema),
  value: z.array(StockValueRowSchema),
});
export type StockReports = z.infer<typeof StockReportsSchema>;

/**
 * COST OF GOODS from the ledger, per product: the units its sales took net of
 * refunds and their cost at the figure frozen on the sale line (and so on each
 * movement) when it sold — the profitability report's COGS (prototype
 * `lib/reporting.ts:423-475`, which read today's cost instead).
 */
export const StockCostOfGoodsRowSchema = z.object({
  productId: z.string().uuid(),
  name: z.string(),
  productKind: z.string().nullable(),
  /** Units sold net of refunds (a unit sold past the record counts: the guest has it). */
  quantity: z.number().int(),
  cogsSatang: z.number().int(),
  /** False when some of those units carried no frozen cost: the COGS is understated. */
  costTracked: z.boolean(),
});
export type StockCostOfGoodsRow = z.infer<typeof StockCostOfGoodsRowSchema>;

export const StockCostOfGoodsSchema = z.object({
  branchId: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  rows: z.array(StockCostOfGoodsRowSchema),
});
export type StockCostOfGoods = z.infer<typeof StockCostOfGoodsSchema>;
