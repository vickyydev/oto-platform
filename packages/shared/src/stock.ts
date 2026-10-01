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
