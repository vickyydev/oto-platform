import type { StockLevels, StockLocationView, SellableStockProduct } from '@oto/shared';
import type { InventoryItem, InventoryVariant, StockLocation } from '../model/types';

type LevelItem = StockLevels['items'][number];

const linkedKindOf = (kind: string | null): InventoryItem['linkedKind'] =>
  kind === 'addon' || kind === 'menu' ? kind : 'merch';

/** The platform's levels as the prototype's inventory: one item per group, one variant per size. */
export function levelsToInventory(levels: StockLevels, byProduct: ReadonlyMap<string, SellableStockProduct>): InventoryItem[] {
  const live = levels.locations.map((l) => l.id);
  const groups = new Map<string, LevelItem[]>();
  for (const row of levels.items) groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row]);
  const out: InventoryItem[] = [];
  for (const [groupId, sizes] of groups) {
    const first = sizes[0]!;
    // Sizes in the catalogue's order (S, M, L) where the till knows it.
    const order = first.productId ? byProduct.get(first.productId)?.sizes.map((s) => s.stockItemId) : undefined;
    if (order) {
      const rank = (id: string) => {
        const at = order.indexOf(id);
        return at < 0 ? order.length : at;
      };
      sizes.sort((a, b) => rank(a.id) - rank(b.id));
    }
    const variants: InventoryVariant[] = sizes.map((s) => ({
      id: s.id,
      label: s.variantLabel ?? 'Default',
      ...(s.sku ? { sku: s.sku } : {}),
      ...(s.variantId ? { productVariantRef: s.variantId } : {}),
      stock: s.total,
      ...(s.lowStockThreshold !== null ? { lowStockThreshold: s.lowStockThreshold } : {}),
      stockByLocation: Object.fromEntries(live.map((id) => [id, s.byLocation[id] ?? 0])),
      ...(Object.keys(s.parByLocation).length > 0 ? { parByLocation: { ...s.parByLocation } } : {}),
    }));
    out.push({
      id: groupId,
      name: first.name,
      ...(first.itemSku ? { sku: first.itemSku } : {}),
      ...(first.category ? { category: first.category } : {}),
      active: sizes.some((s) => s.active),
      linkedKind: linkedKindOf(first.productKind),
      linkedId: first.productId ?? '',
      variants,
      branchId: levels.branchId,
      ...(first.units.length > 0 ? { units: first.units.map((u) => ({ id: u.code, label: u.label, eaches: u.eaches })) } : {}),
      ...(first.photoUrl ? { photoUrl: first.photoUrl, showPhotoInPos: first.showPhotoInPos } : {}),
      ...(first.reorderPoint !== null && first.supplierName
        ? {
            reorderSettings: {
              reorderPoint: first.reorderPoint,
              leadTimeDays: first.leadTimeDays ?? 1,
              supplierName: first.supplierName,
              ...(first.supplierContact ? { supplierContact: first.supplierContact } : {}),
              reorderQty: first.reorderQuantity ?? 1,
            },
          }
        : {}),
      ...(first.unitCostSatang !== null ? { unitCostTHB: first.unitCostSatang / 100 } : {}),
    });
  }
  return out;
}

export const stockLocationToView = (l: StockLocationView): StockLocation => ({
  id: l.id,
  name: l.name,
  type: l.type,
  ...(l.sellPoint ? { sellPoint: true } : {}),
  active: l.active,
});

