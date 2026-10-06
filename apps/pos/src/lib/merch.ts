import { MerchItem, MerchOrderLine, MerchVariant } from '@/types';

// SEAM: pure retail/merch logic, mirroring lib/fnb.ts. Merch is flat-priced
// (no tier, no modifiers) and always taxed under the single 'merch' category,
// so its tax mapping is simpler than F&B's per-item effective category.
//
// SCRUM-271 — THE SHOP'S MONEY IS NOT HERE ANY MORE. This file priced a row
// (`computeMerchLineTotal`) and totalled an order (`merchTaxInputs`,
// `computeMerchTotals`) with the prototype's baht arithmetic. A shop row is
// priced now by the shared item engine the platform prices it with —
// `merchLineTotal` in `lib/cartWire.ts` — and an order is totalled by
// `itemOrderTotals` there, in satang. What stays is sizes and stock.

/**
 * The sizes the platform sells an item in (S2-09b), in the order it lists them.
 * Empty for an item that comes in one size.
 */
export function merchSizes(item: MerchItem): MerchVariant[] {
  return item.variants ?? [];
}

/**
 * Whether adding this item needs a size chosen first: two sizes or more. An
 * item with one size, or none, sells exactly as it did before sizes existed.
 */
export function asksForSize(item: MerchItem): boolean {
  return merchSizes(item).length > 1;
}

/** True when an item has no units left to sell. */
export function isOutOfStock(item: MerchItem): boolean {
  // stock is optional — items without an inventory link are never blocked.
  return (item.stock ?? 1) <= 0;
}

/**
 * True when on-hand stock is at/below the item's low-stock threshold (but not
 * out). No threshold configured = never flagged.
 */
export function isLowStock(item: MerchItem): boolean {
  if (item.lowStockThreshold === undefined) return false;
  const s = item.stock ?? 1;
  return s > 0 && s <= item.lowStockThreshold;
}

/**
 * Units of `item` already committed to the cart (sum of its line quantities),
 * used to clamp how many more can be added before exceeding on-hand stock.
 */
export function qtyInCart(lines: MerchOrderLine[], itemId: string): number {
  return lines
    .filter((l) => l.merchItem.id === itemId)
    .reduce((sum, l) => sum + l.qty, 0);
}
