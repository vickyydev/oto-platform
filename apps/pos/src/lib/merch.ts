import {
  ManualDiscount,
  MerchItem,
  MerchOrderLine,
  TaxConfig,
} from '@/types';
import { computeManualDiscount } from '@/lib/manualDiscount';
import { computeTaxBreakdown, groupTaxInputs, TaxBreakdown, TaxCategoryInput } from '@/lib/tax';
import { getTaxConfig } from '@/store/catalogStore';
import { RateMode, resolveRate, todayRateMode } from '@/lib/pricingMode';

// SEAM: pure retail/merch logic, mirroring lib/fnb.ts. Merch is flat-priced
// (no tier, no modifiers) and always taxed under the single 'merch' category,
// so its tax mapping is simpler than F&B's per-item effective category.

/** Flat unit price × qty. */
export function computeMerchLineTotal(
  item: MerchItem,
  qty: number,
  mode: RateMode = todayRateMode().mode,
): number {
  return resolveRate(item.price, mode) * qty;
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

/**
 * Group merch lines into taxable-category bases for the tax engine. Each line
 * routes to the item's taxCategoryOverride if set, otherwise the default 'merch'
 * category. Multiple lines with the same resolved category are summed by
 * groupTaxInputs so the engine sees one base per distinct tax bucket.
 */
export function merchTaxInputs(lines: MerchOrderLine[]): TaxCategoryInput[] {
  return groupTaxInputs(
    lines.map((l) => ({
      category: l.merchItem.taxCategoryOverride ?? 'merch',
      base: l.lineTotal,
    }))
  );
}

/**
 * Full merch order totals through the shared tax + service engine. Mirrors
 * computeFnbTotals: subtotal is the net of line totals, manual discounts come
 * off, and the engine returns service + tax + grand total. Merch credit spends
 * against this grand total (gross) like cash — handled by the caller.
 */
export function computeMerchTotals(
  lines: MerchOrderLine[],
  manualDiscounts: ManualDiscount[] = [],
  config: TaxConfig = getTaxConfig()
) {
  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const lineAmounts = Object.fromEntries(lines.map((l) => [l.id, l.lineTotal]));
  const manual = computeManualDiscount(manualDiscounts, subtotal, lineAmounts);
  const taxBreakdown = computeTaxBreakdown(merchTaxInputs(lines), manual.total, config);

  return {
    subtotal,
    manualDiscountAmount: manual.total,
    manualAmounts: manual.amounts,
    serviceChargeTotal: taxBreakdown.serviceChargeTotal,
    taxTotal: taxBreakdown.taxTotal,
    taxBreakdown,
    total: taxBreakdown.grandTotal,
  };
}

export type MerchTotals = ReturnType<typeof computeMerchTotals>;
export type { TaxBreakdown };
