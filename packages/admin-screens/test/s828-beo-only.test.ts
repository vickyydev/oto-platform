import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { LiftedAdminApi } from '../src/api/lifted-api';
import { createMenuCatalogueApi, type ApiMenu, type ApiProduct } from '../src/lifted/api/menu';
import { createMenuHelpers } from '../src/lifted/lib/menu';
import { formatWWPrice } from '../src/lifted/lib/pricingMode';
import type { MenuCategoryDef, MenuItem } from '../src/lifted/model/types';
import { MenuPanelWithPorts } from '../src/lifted/components/admin/menu/MenuPanel';

/**
 * SCRUM-828 — the Console's half of a BEO-only item: its menu reads the items
 * the BEO made (the till's read leaves them out), marks each "BEO only", and
 * an item edit carries the flag only when the item says, so the switch can
 * turn it off and an ordinary item's save never names it.
 */

const BRANCH = '01900000-0000-7000-8000-000000000001';

function product(over: Partial<ApiProduct>): ApiProduct {
  return {
    id: 'zz-item', kind: 'menu', code: null, categoryId: 'zz-category', name: 'ZZ TEST item', description: null,
    priceSatang: 12_500, priceWeekendSatang: null, costSatang: null, prepStationOverride: null, taxCategoryOverride: null,
    translations: null, sku: null, stockItemId: null, sortOrder: 0, active: true, archivedAt: null, linkedModifierGroupIds: [],
    ...over,
  };
}

const MENU: ApiMenu = {
  categories: [{ id: 'zz-category', code: 'PARTY-MENU', name: 'Party menu', parentId: null, taxableCategory: 'fnb', defaultPrepStation: 'kitchen', sortOrder: 0, translations: null, archivedAt: null }],
  modifierGroups: [],
  products: [
    product({ id: 'zz-cake', name: 'ZZ TEST unicorn cake', code: 'PARTY-ZZ828A01', priceSatang: 0, prepStationOverride: 'kitchen', beoOnly: true }),
    product({ id: 'zz-fries', name: 'ZZ TEST fries', code: 'CF-11', beoOnly: false }),
  ],
};

function host() {
  const gets: string[] = [];
  const api = {
    get: async (path: string) => { gets.push(path); return MENU; },
    post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), deleteWithBody: vi.fn(),
    href: (path: string) => path, getBlob: vi.fn(), postBlob: vi.fn(), getFile: vi.fn(),
  } as unknown as LiftedAdminApi;
  return { api, gets };
}

function callbackSource(file: string, name: string): string {
  const text = readFileSync(new URL('../src/lifted/components/admin/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let answer: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) answer = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!answer) throw new Error('Native callback missing: ' + name);
  return ts.transpileModule('(' + answer + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, '');
}

describe('SCRUM-828 — BEO-only items in the Console', () => {
  it('the Console asks for the BEO-only items by name; the plain read (the till’s, the other pages’) does not', async () => {
    const { api, gets } = host();
    const menu = createMenuCatalogueApi(api);
    await menu.menuApi.load(BRANCH);
    await menu.menuApi.loadWithBeoOnly(BRANCH);
    expect(gets).toEqual([`/branches/${BRANCH}/menu`, `/branches/${BRANCH}/menu?includeBeoOnly=true`]);
    const page = readFileSync(new URL('../../../apps/console/src/pages/MenuCatalogue.tsx', import.meta.url), 'utf8');
    expect(page).toContain('menu.menuApi.loadWithBeoOnly(parkId)');
  });

  it('a BEO-only product is a menu item marked beoOnly; an ordinary one carries no flag', async () => {
    const { api } = host();
    const menu = createMenuCatalogueApi(api);
    const mapped = menu.mapMenu(await menu.menuApi.loadWithBeoOnly(BRANCH));
    expect(mapped.menuItems.find((i) => i.id === 'zz-cake')).toMatchObject({ name: 'ZZ TEST unicorn cake', beoOnly: true });
    expect(mapped.menuItems.find((i) => i.id === 'zz-fries')).not.toHaveProperty('beoOnly');
  });

  it('an edit sends the flag only when the item says: on, off, or not at all', async () => {
    const { api } = host();
    const menu = createMenuCatalogueApi(api);
    menu.mapMenu(await menu.menuApi.loadWithBeoOnly(BRANCH));
    const base: MenuItem = { id: 'zz-cake', name: 'ZZ TEST unicorn cake', category: 'zz-category', price: { weekday: 0, weekend: 0 } };
    expect(menu.menuItemToApiBody({ ...base, beoOnly: true })).toMatchObject({ beoOnly: true, code: 'PARTY-ZZ828A01' });
    expect(menu.menuItemToApiBody({ ...base, beoOnly: false })).toMatchObject({ beoOnly: false });
    expect(menu.menuItemToApiBody({ ...base, id: 'zz-fries' })).not.toHaveProperty('beoOnly');
  });

  it('the list shows "BEO only" on the item the BEO made, and on no other', () => {
    const categories: MenuCategoryDef[] = [{ id: 'zz-category', name: 'Party menu', defaultPrepStation: 'kitchen', defaultTaxCategory: 'fnb', sortOrder: 0 }];
    const items: MenuItem[] = [
      { id: 'zz-cake', name: 'ZZ TEST unicorn cake', category: 'zz-category', price: { weekday: 0, weekend: 0 }, beoOnly: true },
      { id: 'zz-fries', name: 'ZZ TEST fries', category: 'zz-category', price: { weekday: 125, weekend: 125 } },
    ];
    const menuHelpers = createMenuHelpers({ catalog: { getMenuCategories: () => categories, getModifierGroups: () => [] } });
    const html = renderToStaticMarkup(createElement(MenuPanelWithPorts, { ports: {
      menuItems: items, menuCategories: categories, modifierGroups: [], menuHelpers,
      branch: { id: 'zz-park', name: 'ZZ TEST Park' }, apiBranchId: BRANCH,
      fileApi: { exportWorkbook: vi.fn(), importPreview: vi.fn(), importCommit: vi.fn() },
      onImported: vi.fn(), toast: vi.fn(), formatWWPrice, upsertMenuItem: vi.fn(), deleteMenuItem: vi.fn(),
      upsertInventoryItem: vi.fn(), deleteInventoryItem: vi.fn(), canManageItem: () => true,
    } }));
    expect(html).toContain('data-testid="badge-beo-only-zz-cake"');
    expect(html).not.toContain('data-testid="badge-beo-only-zz-fries"');
    expect(html.match(/>BEO only</g)).toHaveLength(1);
  });

  it('the item form’s switch: on for a new item sends it, off on a BEO-only item sends it off, untouched on an ordinary item names nothing', () => {
    const run = (item: Partial<MenuItem> | null, beoOnly: boolean) =>
      (runInNewContext(callbackSource('menu/MenuItemForm.tsx', 'validate'), {
        item,
        form: { name: 'ZZ TEST cake', category: 'zz-category', price: { weekday: 1, weekend: 1 }, cost: '', groups: [], linkedGroupIds: [], prepStationOverride: '__default__', taxCategoryOverride: '__default__', trackStock: false, beoOnly },
        orderedCategories: [{ id: 'zz-category' }], modifierGroups: [], USE_DEFAULT: '__default__', setErrors: vi.fn(), slugId: (name: string) => name,
      }) as () => MenuItem)();
    expect(run(null, true).beoOnly).toBe(true);
    expect(run({ id: 'zz-cake', beoOnly: true }, false).beoOnly).toBe(false);
    expect(run({ id: 'zz-fries' }, false)).not.toHaveProperty('beoOnly');
    const form = readFileSync(new URL('../src/lifted/components/admin/menu/MenuItemForm.tsx', import.meta.url), 'utf8');
    expect(form).toContain('aria-label="BEO only"');
    expect(form).toContain('beoOnly: !!m.beoOnly');
  });
});
