import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiftedAdminApi } from '../src/api/lifted-api';
import { createStockAdminApi, inventoryItemToStockBody, stockErrorWords } from '../src/lifted/api/stock';
import { InventoryPanelWithPorts } from '../src/lifted/components/admin/inventory/InventoryPanel';
import { StockAdjustTypePicker, stockAdjustProblem } from '../src/lifted/components/admin/inventory/StockAdjustModal';
import type { InventoryPanelPorts } from '../src/lifted/runtime/operations';

/**
 * SCRUM-1012 (E5) — every correction in Admin Inventory names its type
 * (delivery, found, recount, damaged, expired, theft, other) beside its reason,
 * and the help points deliveries to Receive in the stock module.
 */

const BRANCH = '01900000-0000-7000-8000-00000000a012';
const SIZE = '01900000-0000-7000-8000-00000000b012';

describe('the Adjust dialog asks the type of every correction', () => {
  it('offers the seven types, one tap each', () => {
    const html = renderToStaticMarkup(createElement(StockAdjustTypePicker, { value: 'found', onChange: () => undefined }));
    const labels = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Delivery', 'Found', 'Recount', 'Damaged', 'Expired', 'Theft', 'Other']);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Found</);
  });

  it('refuses a correction with no type, in the dialog’s words', () => {
    expect(stockAdjustProblem({ deltaStr: '-1', reasonType: null, reason: 'Torn' })).toBe('Pick the type of correction.');
    expect(stockAdjustProblem({ deltaStr: '', reasonType: 'damaged', reason: 'Torn' })).toBe('Enter a non-zero adjustment amount.');
    expect(stockAdjustProblem({ deltaStr: '-1', reasonType: 'damaged', reason: ' ' })).toBe('A reason is required.');
    expect(stockAdjustProblem({ deltaStr: '-1', reasonType: 'damaged', reason: 'Torn' })).toBeNull();
  });

  it('sends the type with the correction', async () => {
    const post = vi.fn(async () => ({ stockItemId: SIZE, delta: -1, movements: [] }));
    const transport = { post } as unknown as LiftedAdminApi;
    const { stockApi } = createStockAdminApi(transport, { writeThenRead: async (_branch, write) => write() });
    await stockApi.adjust(BRANCH, { stockItemId: SIZE, delta: -1, reasonType: 'theft', reason: 'Gone from the shelf' });
    expect(post).toHaveBeenCalledWith(
      `/branches/${BRANCH}/stock/adjustments`,
      { stockItemId: SIZE, delta: -1, reasonType: 'theft', reason: 'Gone from the shelf' },
      expect.anything(),
    );
  });
});

describe('Admin Inventory’s help', () => {
  it('points deliveries to Receive, not to Adjust', () => {
    const unexpected = vi.fn(async () => { throw new Error('Rendering cannot make a platform request.'); });
    const transport: LiftedAdminApi = { href: (path) => path, get: unexpected, post: unexpected, put: unexpected,
      patch: unexpected, delete: unexpected, deleteWithBody: unexpected, getBlob: unexpected, postBlob: unexpected, getFile: unexpected };
    const { stockApi } = createStockAdminApi(transport, { writeThenRead: async (_branch, write) => write() });
    const ports: InventoryPanelPorts = { branch: { id: 'zz-park', apiId: 'zz-park' },
      stock: { inventory: [{ id: 'zz-item', name: 'ZZ TEST Loss inventory', linkedKind: 'merch', linkedId: 'zz-product',
        variants: [{ id: 'zz-size', label: 'Default', stock: 7 }] }], locations: [], error: null },
      merchItems: [], addOns: [], menuItems: [], stockApi, inventoryItemToStockBody, stockErrorWords,
      catalogueSizesOf: () => [], reloadMenuInto: async () => {}, catalogueReady: true };
    const html = renderToStaticMarkup(createElement(InventoryPanelWithPorts, { ports })).replace(/\s+/g, ' ');
    expect(html).toContain('Deliveries go in through Receive in the stock module.');
    expect(html).toContain('Use &quot;Adjust&quot; for shrinkage or recount corrections and pick its type');
    expect(html).not.toContain('for receive,');
  });
});
