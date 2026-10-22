import { describe, expect, it } from 'vitest';
import type { AdminApi } from '../src/api/admin-api';
import { createMenuCatalogueApi } from '../src/lifted/api/menu';
import type { MenuItem } from '../src/lifted/model/types';

describe('menu write recovery', () => {
  it('keeps explicit keys on shared category and modifier edits and archives', async () => {
    const writes: Array<{ path: string; key?: string }> = [];
    const api: AdminApi = {
      get: async <T>() => ({}) as T,
      post: async <T>() => ({ id: 'created' }) as T,
      put: async <T>() => ({ ok: true }) as T,
      patch: async <T>(path: string, _body?: unknown, options?: { idempotencyKey?: string }) => { writes.push({ path, key: options?.idempotencyKey }); return { ok: true } as T; },
      delete: async <T>(path: string, options?: { idempotencyKey?: string }) => { writes.push({ path, key: options?.idempotencyKey }); return { ok: true } as T; },
    };
    const { menuApi } = createMenuCatalogueApi(api);
    await menuApi.updateCategory('category', { name: 'ZZ TEST Rename' });
    await menuApi.archiveCategory('category');
    await menuApi.updateModifierGroup('group', { name: 'ZZ TEST Question' });
    await menuApi.archiveModifierGroup('group');
    expect(writes).toHaveLength(4);
    for (const write of writes) expect(write.key, write.path).toMatch(/^[a-f0-9-]{36}$/i);
  });

  it('does not create a second item or repeat an accepted inline group after a later group refuses', async () => {
    const writes: Array<{ method: string; path: string }> = [];
    let groups = 0;
    let refusal = true;
    const api: AdminApi = {
      get: async <T>(path: string) => (path.endsWith('/menu') ? { categories: [], modifierGroups: [], products: [] } : { discounts: [] }) as T,
      post: async <T>(path: string) => {
        writes.push({ method: 'POST', path });
        if (path.endsWith('/products')) return { id: 'created-product' } as T;
        groups++;
        if (groups === 2 && refusal) { refusal = false; throw new Error('ZZ TEST group refusal'); }
        return { id: `created-group-${groups}` } as T;
      },
      put: async <T>() => ({ ok: true }) as T,
      patch: async <T>(path: string) => { writes.push({ method: 'PATCH', path }); return { ok: true } as T; },
      delete: async <T>(path: string) => { writes.push({ method: 'DELETE', path }); return { ok: true } as T; },
    };
    const menu = createMenuCatalogueApi(api, { hydrateFromApi: () => undefined });
    const item: MenuItem = { id: 'local-draft', name: 'ZZ TEST Item', category: 'category', price: { weekday: 12.34, weekend: 23.45 }, modifierGroups: ['a', 'b'].map(id => ({ id, name: 'ZZ TEST ' + id, required: false, selectionType: 'single', options: [{ id: id + '-option', name: 'ZZ TEST answer', price: { weekday: 1.23, weekend: 2.34 } }] })) };
    await expect(menu.saveMenuItemToApi('park', 'park', item, false)).rejects.toThrow('ZZ TEST group refusal');
    await menu.saveMenuItemToApi('park', 'park', item, false);
    expect(writes.filter(write => write.path.endsWith('/products') && write.method === 'POST')).toHaveLength(1);
    expect(writes.filter(write => write.path === '/menu/modifier-groups' && write.method === 'POST')).toHaveLength(3);
    expect(writes.filter(write => write.method === 'PATCH').map(write => write.path)).toContain('/branches/park/menu/products/created-product');
  });

  it('retains hidden modifier language fields and shared ordering through a native rename', () => {
    const api: AdminApi = { get: async <T>() => ({}) as T, post: async <T>() => ({}) as T,
      put: async <T>() => ({}) as T, patch: async <T>() => ({}) as T, delete: async <T>() => ({}) as T };
    const menu = createMenuCatalogueApi(api);
    const group = { id: 'group', productId: null, name: 'ZZ TEST Question', required: false,
      selectionType: 'single' as const, minSelect: null, maxSelect: null, sortOrder: 17,
      translations: { th: { name: 'ZZ TEST translated question' } },
      options: [{ id: 'option', name: 'ZZ TEST Answer', priceSatang: 123, priceWeekendSatang: 234,
        costSatang: 56, sortOrder: 0, translations: { th: { name: 'ZZ TEST translated answer' } } }] };
    const mapped = menu.mapMenu({ categories: [], products: [], modifierGroups: [group] });
    const body = menu.modifierGroupToApiBody({ ...mapped.modifierGroups[0]!, name: 'ZZ TEST Renamed' });
    expect(body).toMatchObject({ sortOrder: 17, translations: group.translations,
      options: [{ priceSatang: 123, priceWeekendSatang: 234, costSatang: 56, translations: group.options[0]!.translations }] });
  });

  it('does not rewrite an unchanged inline question with sparse stored ordering during a product-only edit', async () => {
    const writes: string[] = [];
    const api: AdminApi = { get: async <T>() => ({}) as T, post: async <T>() => ({}) as T,
      put: async <T>() => ({}) as T, delete: async <T>() => ({}) as T,
      patch: async <T>(path: string) => { writes.push(path); return { ok: true } as T; } };
    const menu = createMenuCatalogueApi(api);
    const mapped = menu.mapMenu({ categories: [], products: [], modifierGroups: [{
      id: 'inline', productId: 'product', name: 'ZZ TEST Inline', required: false, selectionType: 'single',
      minSelect: null, maxSelect: null, sortOrder: 7, options: [{ id: 'option', name: 'ZZ TEST Choice', priceSatang: 123, priceWeekendSatang: null, costSatang: null, sortOrder: 0 }],
    }] });
    // The original mapper used by the native form has no sort-order field.
    expect(mapped.modifierGroups).toEqual([]);
    const inline = menu.apiGroupToGroup({ id: 'inline', productId: 'product', name: 'ZZ TEST Inline', required: false,
      selectionType: 'single', minSelect: null, maxSelect: null, sortOrder: 7,
      options: [{ id: 'option', name: 'ZZ TEST Choice', priceSatang: 123, priceWeekendSatang: null, costSatang: null, sortOrder: 0 }] });
    await menu.saveMenuItem('park', { id: 'product', name: 'ZZ TEST Price edit', category: 'category', price: { weekday: 23.45, weekend: 34.56 }, modifierGroups: [inline] }, true);
    expect(writes).toEqual(['/branches/park/menu/products/product']);
  });

  it('retires a completed create recovery cache before a later POS draft reuses the same name slug', async () => {
    const writes: string[] = [];
    const api: AdminApi = {
      get: async <T>(path: string) => (path.endsWith('/menu') ? { categories: [], modifierGroups: [], products: [] } : { discounts: [] }) as T,
      post: async <T>(path: string) => { writes.push('POST ' + path); return { id: 'created-' + writes.length } as T; },
      patch: async <T>(path: string) => { writes.push('PATCH ' + path); return { ok: true } as T; },
      put: async <T>() => ({}) as T, delete: async <T>() => ({}) as T,
    };
    const menu = createMenuCatalogueApi(api, { hydrateFromApi: () => undefined });
    const draft: MenuItem = { id: 'zz-test-soup', name: 'ZZ TEST Soup', category: 'category', price: { weekday: 12.34, weekend: 23.45 } };
    await menu.saveMenuItemToApi('park', 'park', draft, false);
    await menu.saveMenuItemToApi('park', 'park', { ...draft, price: { weekday: 34.56, weekend: 45.67 } }, false);
    expect(writes).toEqual(['POST /branches/park/menu/products', 'POST /branches/park/menu/products']);
  });

  it('stops a later inline write when the owning screen changes while the product save is pending', async () => {
    const writes: string[] = [];
    let active = true;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const api: AdminApi = { get: async <T>() => ({}) as T, put: async <T>() => ({}) as T, delete: async <T>() => ({}) as T,
      patch: async <T>(path: string) => { writes.push(path); await pending; return { ok: true } as T; },
      post: async <T>(path: string) => { writes.push(path); return { id: 'created-group' } as T; } };
    const menu = createMenuCatalogueApi(api);
    const saving = menu.saveMenuItem('park', { id: 'product', name: 'ZZ TEST Pending item', category: 'category', price: { weekday: 12, weekend: 23 }, modifierGroups: [{ id: 'new-group', name: 'ZZ TEST Question', required: false, selectionType: 'single', options: [] }] }, true, () => active);
    const result = expect(saving).rejects.toThrow('The catalogue changed.');
    await Promise.resolve(); active = false; release(); await result;
    expect(writes).toEqual(['/branches/park/menu/products/product']);
  });
});
