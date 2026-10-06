import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SellableStock, StockLevels } from '@oto/shared';
import {
  inventoryItemToStockBody,
  levelsToInventory,
  loadSellableStock,
  sellableRestockAlerts,
} from '@/api/stock';
import { mapMenu, type ApiProduct } from '@/api/menu';
import { addOnStockView } from '@/components/till/AddOnsGrid';
import { entryEaches } from '@/components/mobile/stock/UnitQuantityInput';

/**
 * S2-14b round 2 — the stock module on the platform (plan §2.3), and the two
 * till-side handovers from round 1 (H2, the strip). Pure: `fetch` is stubbed
 * with the platform's answers where a read is needed.
 */

const BRANCH = '0192f000-0000-7000-8000-00000000b001';
const FOH = '0192f000-0000-7000-8000-00000000c001';
const BOH = '0192f000-0000-7000-8000-00000000c002';
const SOCKS = '0192f000-0000-7000-8000-0000000000a1';
const CAP = '0192f000-0000-7000-8000-0000000000a2';
const S = '0192f000-0000-7000-8000-0000000000d1';
const M = '0192f000-0000-7000-8000-0000000000d2';
const CAP_ITEM = '0192f000-0000-7000-8000-0000000000d3';

afterEach(() => {
  vi.unstubAllGlobals();
});

const level = (over: Partial<StockLevels['items'][number]>): StockLevels['items'][number] => ({
  id: CAP_ITEM,
  name: 'Oto Cap',
  sku: null,
  category: null,
  active: true,
  productId: CAP,
  variantId: null,
  variantLabel: null,
  unitCostSatang: 9000,
  lowStockThreshold: 6,
  parByLocation: { [FOH]: 10 },
  reorderPoint: 15,
  reorderPointNow: 15,
  reorderQuantity: 24,
  leadTimeDays: 7,
  supplierName: 'Bangkok Merch Co.',
  supplierContact: '02-555-0100',
  byLocation: { [FOH]: 7, [BOH]: 18 },
  total: 25,
  status: 'ok',
  groupId: CAP,
  itemSku: null,
  productKind: 'merch',
  units: [],
  photoUrl: null,
  showPhotoInPos: false,
  ...over,
});

const levels: StockLevels = {
  branchId: BRANCH,
  locations: [
    { id: FOH, name: 'FOH', type: 'rotation', sellPoint: true },
    { id: BOH, name: 'BOH', type: 'back_of_house', sellPoint: false },
  ],
  items: [
    level({}),
    level({
      id: M,
      name: 'Grip Socks',
      productId: SOCKS,
      variantId: 'm',
      variantLabel: 'M',
      groupId: SOCKS,
      byLocation: { [FOH]: 12 },
      total: 12,
      units: [{ code: 'dozen', label: 'Dozen', eaches: 12 }],
      productKind: 'addon',
    }),
    level({
      id: S,
      name: 'Grip Socks',
      productId: SOCKS,
      variantId: 's',
      variantLabel: 'S',
      groupId: SOCKS,
      byLocation: {},
      total: 0,
      units: [{ code: 'dozen', label: 'Dozen', eaches: 12 }],
      productKind: 'addon',
    }),
  ],
};

describe('the platform’s levels as the prototype’s inventory', () => {
  it('one item per group, one variant per size, each variant id the size’s stock item id', () => {
    const inventory = levelsToInventory(levels);
    expect(inventory.map((i) => [i.id, i.name, i.linkedKind, i.variants.length])).toEqual([
      [CAP, 'Oto Cap', 'merch', 1],
      [SOCKS, 'Grip Socks', 'addon', 2],
    ]);
    const socks = inventory[1]!;
    expect(socks.variants.map((v) => [v.id, v.label, v.productVariantRef])).toEqual(
      expect.arrayContaining([
        [S, 'S', 's'],
        [M, 'M', 'm'],
      ]),
    );
    // Every live place is on every size, 0 where nothing is — the overview's
    // location filter and the transfer flow both read the keys.
    expect(socks.variants.find((v) => v.id === S)!.stockByLocation).toEqual({ [FOH]: 0, [BOH]: 0 });
    expect(socks.units).toEqual([{ id: 'dozen', label: 'Dozen', eaches: 12 }]);
    const cap = inventory[0]!;
    expect(cap.variants[0]).toMatchObject({ label: 'Default', stock: 25, lowStockThreshold: 6, parByLocation: { [FOH]: 10 } });
    expect(cap.reorderSettings).toEqual({
      reorderPoint: 15,
      leadTimeDays: 7,
      supplierName: 'Bangkok Merch Co.',
      supplierContact: '02-555-0100',
      reorderQty: 24,
    });
    expect(cap.unitCostTHB).toBe(90);
  });

  it('the admin form’s item goes back as the platform’s body, never with a stock figure', () => {
    const socks = levelsToInventory(levels)[1]!;
    const body = inventoryItemToStockBody(
      { ...socks, variants: [...socks.variants, { id: 'v-new', label: 'L', productVariantRef: 'l', stock: 99 }] },
      { existingSizeIds: new Set([S, M]), productSized: true },
    );
    expect(body.productId).toBe(SOCKS);
    expect(body.sizes.map((s) => [s.stockItemId ?? 'new', s.variantId, s.label])).toEqual(
      expect.arrayContaining([
        [S, 's', 'S'],
        [M, 'm', 'M'],
        ['new', 'l', 'L'],
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('"stock"');
    expect(body.units).toEqual([{ label: 'Dozen', eaches: 12 }]);
    expect(body.sizes.every((size) => size.startingStock === undefined)).toBe(true);
    const opening = inventoryItemToStockBody(socks, { existingSizeIds: new Set(), productSized: true, newItem: true });
    expect(opening.sizes.map((size) => size.startingStock)).toEqual(socks.variants.map((size) => size.stock));
  });
});

describe('quantity entry rounds the combined eaches for review', () => {
  const DOZEN = [{ id: 'dozen', label: 'Dozen', eaches: 12 }];
  it('takes packs and eaches, rounding a fractional total', () => {
    expect(entryEaches('1 dozen + 3', DOZEN)).toEqual({ eaches: 15, reason: null });
    expect(entryEaches('1.3 dozen', DOZEN)).toEqual({ eaches: 16, reason: null });
    // H1: an exponent past the float range is not a number of things.
    expect(Number.isNaN(entryEaches('1e400', DOZEN).eaches)).toBe(true);
  });
});

const sellable: SellableStock = {
  branchId: BRANCH,
  sellPointId: FOH,
  products: [
    {
      productId: SOCKS,
      name: 'Grip Socks',
      sizes: [
        { variantId: 's', label: 'S', stockItemId: S, available: 0, atSellPoint: 0, lowStockThreshold: 8, status: 'out' },
        { variantId: 'm', label: 'M', stockItemId: M, available: 5, atSellPoint: 5, lowStockThreshold: 8, status: 'low' },
      ],
    },
    {
      productId: CAP,
      name: 'Oto Cap',
      sizes: [{ variantId: null, label: null, stockItemId: CAP_ITEM, available: 25, atSellPoint: 7, lowStockThreshold: 6, status: 'ok' }],
    },
  ],
};

describe('the station header strip reads the platform', () => {
  it('names each out or low size from the platform’s counts, out first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sellable), { status: 200 })));
    expect(await loadSellableStock(BRANCH)).toBe(true);
    expect(sellableRestockAlerts()).toEqual([
      { name: 'Grip Socks', sizeLabel: 'S', status: 'out' },
      { name: 'Grip Socks', sizeLabel: 'M', status: 'low' },
    ]);
  });
});

const product = (over: Partial<ApiProduct>): ApiProduct => ({
  id: CAP,
  kind: 'addon',
  code: null,
  categoryId: null,
  name: 'Grip Socks',
  description: null,
  priceSatang: 5_000,
  priceWeekendSatang: null,
  costSatang: null,
  prepStationOverride: null,
  taxCategoryOverride: null,
  translations: null,
  sku: null,
  stockItemId: null,
  sortOrder: 0,
  active: true,
  archivedAt: null,
  linkedModifierGroupIds: [],
  ...over,
});

describe('H2 — a tracked add-on still asks for a size when the counts have not answered', () => {
  it('falls back to the catalogue’s sizes, uncounted, instead of a stepper with no size', () => {
    const ADDON = '0192f000-0000-7000-8000-0000000000e1';
    // The menu says it is tracked and sold in three sizes; the sellable read has
    // nothing for it (it has not answered for this product).
    mapMenu({
      categories: [],
      modifierGroups: [],
      products: [
        product({
          id: ADDON,
          stockLinks: [{ variantId: 's', stockItemId: S }],
          variants: [
            { id: 's', label: 'S' },
            { id: 'm', label: 'M' },
            { id: 'l', label: 'L' },
          ],
        }),
      ],
    } as never);
    const view = addOnStockView({ id: ADDON, inventoryItemId: ADDON });
    expect(view.counted).toBe(false);
    expect(view.inv?.variants.map((v) => [v.id, v.label])).toEqual([
      ['s', 'S'],
      ['m', 'M'],
      ['l', 'L'],
    ]);
    // Uncounted is not out: nothing is offered as "Out of stock".
    expect(view.inv!.variants.every((v) => v.stock > 0)).toBe(true);
  });

  it('an untracked add-on is left alone, and a counted one reads the platform', async () => {
    expect(addOnStockView({ id: 'a-free', inventoryItemId: undefined })).toEqual({ inv: null, counted: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sellable), { status: 200 })));
    await loadSellableStock(BRANCH);
    const view = addOnStockView({ id: SOCKS, inventoryItemId: SOCKS });
    expect(view.counted).toBe(true);
    expect(view.inv?.variants.map((v) => [v.id, v.stock])).toEqual([
      ['s', 0],
      ['m', 5],
    ]);
  });
});

describe('the stock screens are on the platform: the mock calls are gone from the claimed paths', () => {
  const SRC = join(import.meta.dirname, '..', 'src');
  const CLAIMED = [
    'components/mobile/stock/MobileStock.tsx',
    'components/mobile/stock/StockOverview.tsx',
    'components/mobile/stock/StockPurchasing.tsx',
    'components/mobile/stock/StockReplenishFlow.tsx',
    'components/mobile/stock/StockSuggestions.tsx',
    'components/mobile/stock/StockTakeFlow.tsx',
    'components/mobile/stock/StockTransferFlow.tsx',
    'components/mobile/stock/UnitQuantityInput.tsx',
    'components/admin/inventory/InventoryPanel.tsx',
    'components/admin/inventory/InventoryItemFormDialog.tsx',
    'components/admin/inventory/StockAdjustModal.tsx',
    'components/admin/inventory/StockLocationsPanel.tsx',
    'components/shared/StationHeader.tsx',
  ];

  it.each(CLAIMED)('%s reads and writes no in-memory stock', (file) => {
    const src = readFileSync(join(SRC, file), 'utf8');
    expect(src).not.toMatch(/from '@\/mockApi'/);
    expect(src).not.toMatch(/from '@\/store\/catalogStore'/);
    expect(src).not.toMatch(
      /recordInventoryAdjustment|transferStockBetweenLocations|addStockTransfer|addStockTakeRecord|getPurchaseOrders|addToPurchaseOrder\(|receivePurchaseOrderLine\(|markPurchaseOrderOrdered|upsertStockLocation|setStockLocationSellPoint|upsertInventoryItem/,
    );
    // The catalogue store is still where the sellables are named, but never the stock.
    if (src.includes('useCatalogStore')) {
      expect(src).not.toMatch(/\binventory\b[^;]*=\s*useCatalogStore|stockLocations[^;]*useCatalogStore|const \{[^}]*\b(inventory|stockLocations)\b[^}]*\} = useCatalogStore/);
    }
  });
});
