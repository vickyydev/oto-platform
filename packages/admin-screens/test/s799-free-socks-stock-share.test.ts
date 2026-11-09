import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AdminApi } from '../src/api/admin-api';
import { createMenuCatalogueApi, stockShareOptionsOf, type ApiMenu, type ApiProduct } from '../src/lifted/api/menu';
import { AddOnStockShareField } from '../src/lifted/components/admin/addons/AddOnFormDialog';
import { QUICK_REASONS } from '../src/lifted/components/admin/inventory/StockAdjustModal';

/**
 * SCRUM-799 — the Console's half of "Free Socks are for inventory": the add-on
 * form's "Takes stock from" (the 0-baht Free Socks sells from the Regular Socks
 * shelf) and the Adjust dialog's "Complimentary / staff use" reason.
 */

const SHELF = '01900000-0000-7000-8000-00000000a799';
const GRIP_S = '01900000-0000-7000-8000-00000000b799';
const REGULAR = '01900000-0000-7000-8000-00000000c799';
const FREE = '01900000-0000-7000-8000-00000000d799';
const GRIP = '01900000-0000-7000-8000-00000000e799';

const addOn = (over: Partial<ApiProduct> & Pick<ApiProduct, 'id' | 'name'>): ApiProduct => ({
  kind: 'addon', code: null, categoryId: 'zz-addons', description: null, priceSatang: 0, priceWeekendSatang: null,
  costSatang: null, prepStationOverride: null, taxCategoryOverride: null, translations: null, sku: null,
  stockItemId: null, sortOrder: 0, active: true, archivedAt: null, linkedModifierGroupIds: [], stockLinks: [],
  stockShareItemId: null, ...over,
});

const menu: ApiMenu = {
  categories: [{
    id: 'zz-addons', code: 'ZZ-ADDONS', name: 'ZZ TEST Add-ons', parentId: null, taxableCategory: 'addons',
    defaultPrepStation: null, sortOrder: 0, translations: null, archivedAt: null,
  }],
  modifierGroups: [],
  products: [
    addOn({ id: REGULAR, name: 'ZZ TEST Regular Socks', priceSatang: 6000, stockItemId: SHELF, stockLinks: [{ variantId: null, stockItemId: SHELF }] }),
    addOn({ id: FREE, name: 'ZZ TEST Free Socks', stockItemId: SHELF, stockShareItemId: SHELF }),
    addOn({
      id: GRIP, name: 'ZZ TEST Grip Socks', priceSatang: 8000, stockItemId: GRIP_S,
      stockLinks: [{ variantId: 's', stockItemId: GRIP_S }, { variantId: 'm', stockItemId: '01900000-0000-7000-8000-00000000f799' }],
    }),
  ],
};

const noCalls: AdminApi = {
  get: async () => { throw new Error('no reads in this test'); },
  post: async () => { throw new Error('no writes in this test'); },
  patch: async () => { throw new Error('no writes in this test'); },
  put: async () => { throw new Error('no writes in this test'); },
  delete: async () => { throw new Error('no writes in this test'); },
};

describe('Takes stock from', () => {
  it('offers only one-size shelves that stock an item, named for that item', () => {
    expect(stockShareOptionsOf(menu.products)).toEqual([{ stockItemId: SHELF, productId: REGULAR, name: 'ZZ TEST Regular Socks' }]);
    expect(stockShareOptionsOf([{ ...menu.products[0]!, archivedAt: '2026-11-09T00:00:00.000Z' }])).toEqual([]);
  });

  it('reads the share onto the add-on and sends it only when the form changed it', () => {
    const catalogue = createMenuCatalogueApi(noCalls);
    const mapped = catalogue.mapMenu(menu);
    const free = mapped.addOns.find((a) => a.id === FREE)!;
    expect(free.stockShareItemId).toBe(SHELF);
    // It counts no stock of its own: Track stock stays off for it.
    expect(free.inventoryItemId).toBeUndefined();
    expect(mapped.addOns.find((a) => a.id === REGULAR)!.stockShareItemId).toBeUndefined();

    // A rename or a price edit leaves the platform's setting alone.
    expect(catalogue.addOnToApiBody({ ...free, name: 'ZZ TEST Free Socks (staff)' })).not.toHaveProperty('stockShareItemId');
    // Choosing "Nothing" stops it; choosing a shelf on a new add-on sets it.
    expect(catalogue.addOnToApiBody({ ...free, stockShareItemId: undefined })).toMatchObject({ stockShareItemId: null });
    expect(catalogue.addOnToApiBody({ id: 'zz-new', name: 'ZZ TEST Comp Socks', price: { weekday: 0, weekend: 0 }, stockShareItemId: SHELF }))
      .toMatchObject({ kind: 'addon', priceSatang: 0, stockShareItemId: SHELF });
    // No price change rides along: Regular Socks keeps its own.
    const regular = mapped.addOns.find((a) => a.id === REGULAR)!;
    expect(catalogue.addOnToApiBody(regular)).toMatchObject({ priceSatang: 6000 });
    expect(catalogue.addOnToApiBody(regular)).not.toHaveProperty('stockShareItemId');
  });

  it('renders the field in the form’s words and never offers the add-on its own shelf', () => {
    const options = stockShareOptionsOf(menu.products);
    const forFree = renderToStaticMarkup(createElement(AddOnStockShareField, { addOnId: FREE, options, value: SHELF, onChange: () => undefined }));
    expect(forFree).toContain('Takes stock from');
    expect(forFree).toContain('Each one sold takes one from ZZ TEST Regular Socks&#x27;s stock, whatever its price.');
    expect(forFree).toContain('Inventory → Adjust');
    const unset = renderToStaticMarkup(createElement(AddOnStockShareField, { addOnId: FREE, options, value: null, onChange: () => undefined }));
    expect(unset).toContain('For a free or complimentary version of a stocked item, like Free Socks');
    // Regular Socks' own form offers nothing but "Nothing".
    const own = renderToStaticMarkup(createElement(AddOnStockShareField, { addOnId: REGULAR, options, value: null, onChange: () => undefined }));
    expect(own).not.toContain('ZZ TEST Regular Socks');
  });
});

describe('the Adjust dialog', () => {
  it('offers "Complimentary / staff use" after the prototype’s four reasons', () => {
    expect(QUICK_REASONS).toEqual(['Received shipment', 'Inventory recount', 'Damaged / shrinkage', 'Staff use', 'Complimentary / staff use']);
  });
});
