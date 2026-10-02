import { InventoryItem, InventoryVariant } from '@/types';

// Stock health of a single variant. The single source of truth for "out" vs
// "low" so the Inventory panel, the variant picker, and the sell surfaces all
// agree on what counts as needing attention.
export type VariantStatus = 'out' | 'low' | 'ok';

export function variantStatus(v: InventoryVariant): VariantStatus {
  if (v.stock <= 0) return 'out';
  if (v.lowStockThreshold !== undefined && v.stock <= v.lowStockThreshold) return 'low';
  return 'ok';
}

export interface RestockAlert {
  item: InventoryItem;
  variant: InventoryVariant;
  status: 'out' | 'low';
}

/**
 * Every variant across all inventory that is out of stock or at/below its low
 * threshold, out-of-stock first. Drives the "Needs restocking" summary and the
 * admin nav count badge so staff can't miss a depleted line.
 */
export function getRestockAlerts(inventory: InventoryItem[]): RestockAlert[] {
  const alerts: RestockAlert[] = [];
  for (const item of inventory) {
    for (const v of item.variants) {
      const s = variantStatus(v);
      if (s === 'out' || s === 'low') alerts.push({ item, variant: v, status: s });
    }
  }
  return alerts.sort((a, b) =>
    a.status === b.status ? 0 : a.status === 'out' ? -1 : 1,
  );
}

export function countRestockAlerts(inventory: InventoryItem[]): number {
  return getRestockAlerts(inventory).length;
}

export interface ReorderAlert {
  item: InventoryItem;
  /** For multi-variant items the flag is per-item (total stock), not per-variant.
   *  We attach the first variant as a representative for the "Add" action. */
  totalStock: number;
  reorderPoint: number;
}

/**
 * Items whose TOTAL on-hand stock is at or below their reorderPoint.
 * This is distinct from par-based transfer suggestions (which fire when a
 * location is below par but total stock may still be adequate).
 *
 * The prototype's static rule, on the device. The platform's own rule is the
 * one staff see: the mobile Alerts screen reads its attention rows
 * (`GET /branches/:id/stock/attention`, stock walkthrough F3), which follow
 * the item's average daily usage over the last 30 days × (lead time + 1 day),
 * rounded up, once it has that much
 * history (OD-27) and keep quiet while an open order covers the item. Nothing
 * on a staff screen reads this any more.
 */
export function getReorderAlerts(inventory: InventoryItem[]): ReorderAlert[] {
  const alerts: ReorderAlert[] = [];
  for (const item of inventory) {
    const rs = item.reorderSettings;
    if (!rs) continue;
    const totalStock = item.variants.reduce((s, v) => s + v.stock, 0);
    if (totalStock <= rs.reorderPoint) {
      alerts.push({ item, totalStock, reorderPoint: rs.reorderPoint });
    }
  }
  return alerts.sort((a, b) => a.totalStock - b.totalStock); // most urgent first
}

export function countReorderAlerts(inventory: InventoryItem[]): number {
  return getReorderAlerts(inventory).length;
}
