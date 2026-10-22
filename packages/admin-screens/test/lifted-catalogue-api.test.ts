import { describe, expect, it } from 'vitest';
import type { LiftedAdminApi, LiftedRequestOptions } from '../src/api/lifted-api';
import { createMenuApi, createMenuCatalogueApi, type ApiMenu, type ApiProduct } from '../src/lifted/api/menu';
import { createCatalogueAdminApi } from '../src/lifted/api/platform';
import { createCatalogBridge } from '../src/lifted/api/catalogBridge';
import type { CatalogHydration } from '../src/lifted/model/catalog';
import type { TicketType } from '../src/lifted/model/types';

type Call = { method: string; path: string; body?: unknown; options?: LiftedRequestOptions };
function menuFor(label: string): ApiMenu {
  const product: ApiProduct = {
    id: 'shared-item-id', kind: 'menu', code: `${label}-CODE`, categoryId: `${label}-category`,
    name: `${label} approved item`, description: `${label} stored description`, priceSatang: 12_500,
    priceWeekendSatang: null, costSatang: 4_000, prepStationOverride: null, taxCategoryOverride: null,
    translations: null, sku: `${label}-SKU`, stockItemId: null, sortOrder: label === 'A' ? 71 : 92,
    active: label !== 'A', archivedAt: null, linkedModifierGroupIds: [],
    variants: [{ id: `${label}-small`, label: 'Small' }, { id: `${label}-large`, label: 'Large' }],
  };
  return { products: [product], modifierGroups: [], categories: [{
    id: `${label}-category`, code: `${label}-CATEGORY`, name: 'Meals', parentId: null,
    taxableCategory: 'fnb', defaultPrepStation: 'kitchen', sortOrder: 0, translations: null, archivedAt: null,
  }] };
}

function hostFor(menu: ApiMenu) {
  const calls: Call[] = [];
  const state = { menu, holdPatch: null as (() => Promise<void>) | null };
  const request = async <T>(method: string, path: string, body?: unknown, options?: LiftedRequestOptions): Promise<T> => {
    calls.push({ method, path, body, options });
    if (method === 'PATCH') await state.holdPatch?.();
    if (method === 'GET') {
      if (path.endsWith('/menu')) return state.menu as T;
      if (path === '/menu/discounts') return { discounts: [] } as T;
      throw new Error(`Unexpected synthetic GET ${path}`);
    }
    return { id: 'shared-item-id', ok: true } as T;
  };
  const api: LiftedAdminApi = {
    get: (path, options) => request('GET', path, undefined, options),
    post: (path, body, options) => request('POST', path, body, options),
    put: (path, body, options) => request('PUT', path, body, options),
    patch: (path, body, options) => request('PATCH', path, body, options),
    delete: (path, options) => request('DELETE', path, undefined, options),
    deleteWithBody: (path, body, options) => request('DELETE', path, body, options),
    href: path => `/synthetic-host${path}`,
    getBlob: async () => new Blob(), postBlob: async () => new Blob(),
    getFile: async () => ({ blob: new Blob(), filename: null, contentType: null }),
  };
  return { api, calls, state };
}
const flush = async () => { for (let step = 0; step < 8; step++) await Promise.resolve(); };

it('gives each Console catalogue edit and withdrawal an idempotency key', async () => {
  const { api, calls } = hostFor(menuFor('A'));
  const catalogue = createCatalogueAdminApi(api);
  const menu = createMenuCatalogueApi(api);
  await catalogue.updateTier('student', { name: 'ZZ TEST renamed tier' });
  await catalogue.deleteTier('student');
  await catalogue.updatePackage('park', 'ticket', { name: 'ZZ TEST renamed ticket' });
  await catalogue.archivePackage('park', 'ticket');
  await menu.menuApi.updateProduct('park', 'addon', { name: 'ZZ TEST renamed add-on' });
  await menu.menuApi.archiveProduct('park', 'addon');
  expect(calls).toHaveLength(6);
  for (const call of calls) expect(call.options?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/i);
});

describe('the lifted catalogue adapters use their own host and canonical state', () => {
  it('keeps two menu caches independent and carries hidden server fields through an edit', () => {
    const left = hostFor(menuFor('A')), right = hostFor(menuFor('B'));
    const a = createMenuApi(left.api, { hydrateFromApi: () => undefined });
    const b = createMenuApi(right.api, { hydrateFromApi: () => undefined });
    const itemA = a.mapMenu(left.state.menu).menuItems[0]!;
    expect(b.menuIsServerBacked()).toBe(false);
    const itemB = b.mapMenu(right.state.menu).menuItems[0]!;
    expect(a.menuItemToApiBody(itemA)).toMatchObject({ code: 'A-CODE', description: 'A stored description', sortOrder: 71, active: false, priceSatang: 12_500, priceWeekendSatang: null });
    expect(b.menuItemToApiBody(itemB)).toMatchObject({ code: 'B-CODE', description: 'B stored description', sortOrder: 92, active: true });
    expect(a.catalogueSizesOf('shared-item-id').map(size => size.id)).toEqual(['A-small', 'A-large']);
    expect(b.catalogueSizesOf('shared-item-id').map(size => size.id)).toEqual(['B-small', 'B-large']);
    expect(a.categoryToApiBody(a.mapMenu(left.state.menu).categories[0]!)).toMatchObject({ code: 'A-CATEGORY' });
    expect(right.calls).toEqual([]);
  });

  it('serializes one host writes through readback while another host continues independently', async () => {
    const left = hostFor(menuFor('A')), right = hostFor(menuFor('B'));
    const aHydrations: CatalogHydration[] = [], bHydrations: CatalogHydration[] = [];
    const a = createMenuApi(left.api, { hydrateFromApi: value => aHydrations.push(value) });
    const b = createMenuApi(right.api, { hydrateFromApi: value => bHydrations.push(value) });
    const itemA = a.mapMenu(left.state.menu).menuItems[0]!, itemB = b.mapMenu(right.state.menu).menuItems[0]!;
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    left.state.holdPatch = () => { if (first) { first = false; return held; } return Promise.resolve(); };
    const aFirst = a.saveMenuItemToApi('branch-a', 'park-a', { ...itemA, name: 'First edit' }, true);
    const aSecond = a.saveMenuItemToApi('branch-a', 'park-a', { ...itemA, name: 'Second edit' }, true);
    const bWrite = b.saveMenuItemToApi('branch-b', 'park-b', itemB, true);
    try {
      await flush();
      expect(left.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
      expect(left.calls.some(call => call.method === 'GET')).toBe(false);
      expect(right.calls.some(call => call.method === 'PATCH')).toBe(true);
      await bWrite;
      expect(bHydrations).toHaveLength(1);
      expect(aHydrations).toEqual([]);
    } finally { release(); }
    await Promise.all([aFirst, aSecond]);
    expect(left.calls.map(call => call.method)).toEqual(['PATCH', 'GET', 'GET', 'PATCH', 'GET', 'GET']);
    expect(left.calls.filter(call => call.method === 'PATCH').map(call => call.path)).toEqual([
      '/branches/branch-a/menu/products/shared-item-id', '/branches/branch-a/menu/products/shared-item-id',
    ]);
    expect(aHydrations).toHaveLength(2);
    expect(aHydrations[1]).toMatchObject({ perBranch: { 'park-a': { menuItems: [{ name: 'A approved item', price: { weekday: 125, weekend: 125 } }] } } });
  });

  it('downloads through the injected file capability and preserves the approved missing-filename fallback', async () => {
    const host = hostFor(menuFor('A'));
    const paths: string[] = [];
    host.api.getFile = async path => { paths.push(path); return { blob: new Blob(['fixture workbook']), filename: null, contentType: null }; };
    const menu = createMenuApi(host.api, { hydrateFromApi: () => undefined });
    const download = await menu.fetchMenuWorkbook('branch-a');
    expect(paths).toEqual(['/branches/branch-a/menu/export.xlsx']);
    expect(download.filename).toBe('oto-menu.xlsx');
    expect(await download.blob.text()).toBe('fixture workbook');
    expect(host.calls).toEqual([]);
  });

  it('keeps unbacked POS catalogue edits local without calling a host transport', async () => {
    const host = hostFor(menuFor('A'));
    const bridge = createCatalogBridge(host.api, {
      getActiveBranch: () => ({ id: 'local-park' }), hydrateFromApi: () => undefined,
      setBranchTimezone: () => undefined,
      setBranchDayStart: () => undefined, setBranchRateMode: () => undefined,
      reloadMenuInto: async () => undefined, loadSellableStock: async () => false,
    });
    const ticket: TicketType = { id: 'local-ticket', name: 'ZZ TEST local ticket', durationLabel: '1 hour', hours: 1, prices: { regular: { weekday: 100, weekend: 120 } } };
    await bridge.saveTicketTypeToApi('local-park', ticket, false);
    await bridge.archiveTicketTypeInApi('local-park', ticket.id);
    expect(await bridge.loadMenuFromApi('local-park')).toBe(false);
    expect(bridge.apiBranchIdForSlug('local-park')).toBeNull();
    expect(host.calls).toEqual([]);
  });
});
