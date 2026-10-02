import { z } from 'zod';

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
  /** How many eaches one pack holds — a whole number above one. */
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
 *   "1.3 dozen"    → refused: 15.6 eaches is not a number of things
 *   "2.5"          → refused: there is no half an each
 *   "0.5 + 0.5"    → refused: each part is a number of things on its own
 *   "-3"           → refused: a count is never below nothing
 *
 * Port of `parseUnitCombo` (`lib/stockUnits.ts:16-55`): a segment whose label
 * matches no pack is read as eaches, as the prototype reads it (the parsed
 * figure is always shown before anything is confirmed). The prototype ROUNDED
 * the total and floored a negative at 0; this refuses both, because a rounded
 * or zeroed count is a count nobody made. Each part has to come to whole
 * eaches by itself, so halves cannot be smuggled in across two parts.
 */
export function parsePackQuantity(raw: string, packs: readonly StockPack[]): PackParse {
  const str = raw.trim().toLowerCase();
  if (!str) return { ok: true, eaches: 0 };
  let total = 0;
  for (const part of str.split('+').map((p) => p.trim())) {
    if (!part) continue;
    let segment: number | null = null;
    for (const pack of packs) {
      const label = pack.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`^(-?[\\d.]+)\\s*${label}s?$`).exec(part);
      if (match) {
        const count = Number(match[1]);
        if (!Number.isFinite(count)) return { ok: false, reason: `"${part}" is not a number of ${pack.label}s` };
        segment = count * pack.eaches;
        break;
      }
    }
    if (segment === null) {
      const n = parseFloat(part);
      if (Number.isNaN(n)) return { ok: false, reason: `"${part}" is not a quantity` };
      segment = n;
    }
    // "1e400" and "Infinity" parse to Infinity, and Infinity − Infinity is NaN,
    // which the whole-each check below would let through (round-1 re-check).
    if (!Number.isFinite(segment)) return { ok: false, reason: `"${part}" is not a number of things` };
    if (segment < 0) return { ok: false, reason: `"${part}" is below nothing — enter what is there, 0 or more` };
    // Floating point: 1.5 × 12 is exactly 18, but 0.1 × 30 is 3.0000000000000004.
    const nearest = Math.round(segment);
    if (Math.abs(segment - nearest) > 1e-9) {
      return {
        ok: false,
        reason: `"${part}" comes to ${Number(segment.toFixed(3))} — stock is counted in whole items, so enter a quantity that makes a whole number`,
      };
    }
    total += nearest;
  }
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
  reorderPoint: z.number().int().nullable(),
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
});
export type StockTakeLineView = z.infer<typeof StockTakeLineViewSchema>;

export const StockTakeResultSchema = z.object({
  id: StockId,
  /** The branch's first count: its opening position (OD-S5). */
  opening: z.boolean(),
  lines: z.array(StockTakeLineViewSchema),
});
export type StockTakeResult = z.infer<typeof StockTakeResultSchema>;

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
        eaches: z.number().int().min(2, 'A pack holds 2 or more').max(100_000),
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

export const StockAttentionViewSchema = z.object({
  id: StockId,
  kind: z.enum(['stock_shortfall', 'size_unknown', 'low_stock', 'reorder']),
  stockItemId: StockId.nullable(),
  /** Which rule fired ("Below par at FOH", "≤ reorder point"). */
  rule: z.string().nullable(),
  quantity: z.number().int(),
  summary: z.string(),
  occurrences: z.number().int(),
  saleId: StockId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StockAttentionView = z.infer<typeof StockAttentionViewSchema>;

export const StockAttentionsSchema = z.object({ attention: z.array(StockAttentionViewSchema) });

/** The words a low-stock attention carries for the rule that fired. */
export const STOCK_RULE_REORDER = '≤ reorder point';
export const stockRuleBelowPar = (placeName: string): string => `Below par at ${placeName}`;
