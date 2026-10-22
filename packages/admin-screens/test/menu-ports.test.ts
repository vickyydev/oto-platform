import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuCategoryDef, MenuItem, MerchItem, ModifierGroup } from '../src/lifted/model/types';
import type { AdminApi } from '../src/api/admin-api';
import { readMenuCapabilities, readOperatorMenuCapability } from '../src/lifted/runtime/menu';
import { createMenuHelpers } from '../src/lifted/lib/menu';
import { formatWWPrice } from '../src/lifted/lib/pricingMode';

const host = vi.hoisted(() => ({
  branch: { branch: { id: 'zz-test-park', apiId: '01900000-0000-7000-8000-000000000001' as string | undefined } },
  session: { operator: { id: '01900000-0000-7000-8000-000000000002', name: 'ZZ TEST Manager', role: 'manager' }, can: () => true },
  catalog: {
    menuCategories: [{ id: 'zz-category', name: 'ZZ TEST Category', defaultPrepStation: 'kitchen', defaultTaxCategory: 'fnb', sortOrder: 0 }] as MenuCategoryDef[],
    menuItems: [
      { id: 'zz-shared-meal', name: 'ZZ TEST Shared meal', category: 'zz-category', price: { weekday: 12, weekend: 23 } },
      { id: 'zz-park-meal', name: 'ZZ TEST Park meal', category: 'zz-category', price: { weekday: 12, weekend: 23 } },
    ] as MenuItem[],
    merchItems: [
      { id: 'zz-shared-shirt', name: 'ZZ TEST Shared shirt', active: true, price: { weekday: 12, weekend: 23 } },
      { id: 'zz-park-shirt', name: 'ZZ TEST Park shirt', active: true, price: { weekday: 12, weekend: 23 } },
    ] as MerchItem[],
    inventory: [], discounts: [],
    modifierGroups: [{ id: 'zz-group', name: 'ZZ TEST Question', required: false, selectionType: 'single', options: [{ id: 'zz-option', name: 'ZZ TEST Answer', price: { weekday: 1, weekend: 2 } }] }] as ModifierGroup[],
    mutators: { upsertMenuCategory: vi.fn(), deleteMenuCategory: vi.fn(), upsertMenuItem: vi.fn(), upsertModifierGroup: vi.fn(), deleteModifierGroup: vi.fn() },
  },
  domain: { menu: {
    topLevelCategories: (rows: MenuCategoryDef[]) => rows.filter(row => !row.parentId),
    subCategoriesOf: (id: string, rows: MenuCategoryDef[]) => rows.filter(row => row.parentId === id),
    categoryPrepStation: (row: MenuCategoryDef) => row.defaultPrepStation,
    categoryTaxCategory: (row: MenuCategoryDef) => row.defaultTaxCategory,
  }, pricingMode: { formatWWPrice: (price: { weekday: number } | undefined) => String(price?.weekday ?? '') } },
  reads: { getActiveBranch: () => ({ id: 'zz-test-park', name: 'ZZ TEST Park' }) },
  toast: vi.fn(),
  transport: { get: vi.fn() },
  api: {
    catalogBridge: { apiBranchIdForSlug: vi.fn(), loadMenuFromApi: vi.fn(async () => true) },
    menu: { menuApi: { exportWorkbook: vi.fn(), importPreview: vi.fn(), importCommit: vi.fn() }, serverFieldsFor: vi.fn() },
    stock: { merchItemsWithStock: vi.fn(), refreshSellableStock: vi.fn(async () => {}), useSellableStockVersion: () => 0 },
  },
}));
vi.mock('../src/lifted/runtime/AdminScreenRuntime', () => ({
  useAdminScreenRuntime: () => host,
  useCatalogStore: () => host.catalog,
}));
import { CategoriesPanel } from '../src/lifted/components/admin/categories/CategoriesPanel';
import { ModifiersPanel } from '../src/lifted/components/admin/modifiers/ModifiersPanel';
import { MenuPanel, MenuPanelWithPorts } from '../src/lifted/components/admin/menu/MenuPanel';
import { MerchPanel, MerchPanelWithPorts } from '../src/lifted/components/admin/merch/MerchPanel';

function enabledButtonCount(html: string, label: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(match =>
    !/\bdisabled(?:\s|=|$)/.test(match[1] ?? '') && match[2]?.replace(/<[^>]+>/g, '').trim() === label).length;
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

beforeEach(() => {
  host.branch.branch.apiId = '01900000-0000-7000-8000-000000000001';
  host.api.catalogBridge.apiBranchIdForSlug.mockImplementation(() => host.branch.branch.apiId ?? null);
  host.api.menu.serverFieldsFor.mockImplementation((id: string) => ({ branchId: id.includes('shared') ? null : host.branch.branch.apiId }));
  host.api.stock.merchItemsWithStock.mockImplementation(() => host.catalog.merchItems);
  vi.clearAllMocks();
});

describe('Menu group native ports and inherited data', () => {
  it('withholds operator-wide category actions from a server-backed branch manager before canonical authority is known', () => {
    const html = renderToStaticMarkup(createElement(CategoriesPanel));
    expect(html).toContain('F&amp;B Categories');
    expect(html).toContain('ZZ TEST Category');
    expect(html).not.toContain('Add category');
    expect(html).not.toContain('aria-label="Edit');
    expect(html).not.toContain('aria-label="Delete');
    expect(host.transport.get).not.toHaveBeenCalled();
  });

  it('withholds operator-wide shared modifier actions from the same branch manager', () => {
    const html = renderToStaticMarkup(createElement(ModifiersPanel));
    expect(html).toContain('Shared modifier groups');
    expect(html).toContain('ZZ TEST Question');
    expect(html).not.toContain('Add group');
    expect(html).not.toContain('aria-label="Edit');
    expect(html).not.toContain('aria-label="Delete');
  });

  it('keeps unbacked prototype category and modifier controls without a request during render', () => {
    host.branch.branch.apiId = undefined;
    expect(renderToStaticMarkup(createElement(CategoriesPanel))).toContain('Add category');
    expect(renderToStaticMarkup(createElement(ModifiersPanel))).toContain('Add group');
    const menu = renderToStaticMarkup(createElement(MenuPanel));
    const merch = renderToStaticMarkup(createElement(MerchPanel));
    expect(enabledButtonCount(menu, 'Add item')).toBe(1);
    expect(menu).toContain('aria-label="Edit ZZ TEST Shared meal"');
    expect(enabledButtonCount(merch, 'Add item')).toBe(1);
    expect(merch).toContain('aria-label="Edit ZZ TEST Shared shirt"');
    expect(host.transport.get).not.toHaveBeenCalled();
  });

  it('offers no menu create, global-product edit or workbook action while live wrapper authority is pending', () => {
    const html = renderToStaticMarkup(createElement(MenuPanel));
    expect(html).toContain('ZZ TEST Shared meal');
    expect(enabledButtonCount(html, 'Add item')).toBe(0);
    expect(html).not.toContain('aria-label="Edit ZZ TEST Shared meal"');
    expect(enabledButtonCount(html, 'Export')).toBe(0);
    expect(enabledButtonCount(html, 'Import')).toBe(0);
    expect(host.transport.get).not.toHaveBeenCalled();
  });

  it('offers no merch create, global-product edit or retirement while live wrapper authority is pending', () => {
    const html = renderToStaticMarkup(createElement(MerchPanel));
    expect(html).toContain('ZZ TEST Shared shirt');
    expect(enabledButtonCount(html, 'Add item')).toBe(0);
    expect(html).not.toContain('aria-label="Edit ZZ TEST Shared shirt"');
    expect(html).not.toContain('aria-label="Retire ZZ TEST Shared shirt"');
    expect(host.transport.get).not.toHaveBeenCalled();
  });

  it('preserves existing menu display translations through a native name-only edit', () => {
    const item = { id: 'zz-item', translations: { th: { name: 'ZZ TEST translated name' } } };
    const validate = runInNewContext(callbackSource('menu/MenuItemForm.tsx', 'validate'), {
      item,
      form: { name: 'ZZ TEST Renamed', category: 'zz-category', price: { weekday: 12.34, weekend: 23.45 }, cost: '', groups: [], linkedGroupIds: [], prepStationOverride: '__default__', taxCategoryOverride: '__default__' },
      orderedCategories: [{ id: 'zz-category' }], modifierGroups: [], USE_DEFAULT: '__default__', setErrors: vi.fn(), slugId: vi.fn(),
    }) as () => { translations?: unknown };
    expect(validate().translations).toEqual(item.translations);
  });

  it('preserves existing category display translations through a native rename', async () => {
    const category = { id: 'zz-category', sortOrder: 0, translations: { th: { name: 'ZZ TEST translated category' } } };
    const onSave = vi.fn();
    const submit = runInNewContext(callbackSource('categories/CategoryFormDialog.tsx', 'handleSubmit'), {
      category, categories: [category], name: 'ZZ TEST Renamed category', isSub: false, parentId: '__none__',
      defaultPrepStation: 'kitchen', defaultTaxCategory: 'fnb', INHERIT: '__inherit__', setErrors: vi.fn(), onSave, onOpenChange: vi.fn(),
      savingRef: { current: false }, setSaving: vi.fn(), setSaveError: vi.fn(), mounted: { current: true }, targetRef: { current: category }, draft: 'same-draft', draftRef: { current: 'same-draft' },
    }) as (event: { preventDefault(): void }) => Promise<void>;
    await submit({ preventDefault() {} });
    expect(onSave.mock.calls[0]?.[0].translations).toEqual(category.translations);
  });

  it('keeps inherited defaults when opening an existing subcategory for a name-only edit', () => {
    const text = readFileSync(new URL('../src/lifted/components/admin/categories/CategoryFormDialog.tsx', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('category.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('setName(category?.name')) effect = node.arguments[0].getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(effect).toBeDefined();
    const prep = vi.fn(), tax = vi.fn();
    const run = runInNewContext(ts.transpileModule('(' + effect + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      open: true, category: { id: 'zz-sub', name: 'ZZ TEST Subcategory', parentId: 'zz-parent' }, defaultParentId: undefined,
      NO_PARENT: '__none__', INHERIT: '__inherit__', setName: vi.fn(), setParentId: vi.fn(), setDefaultPrepStation: prep, setDefaultTaxCategory: tax, setErrors: vi.fn(), setSaveError: vi.fn(),
    }) as () => void;
    run();
    expect(prep).toHaveBeenCalledWith('__inherit__');
    expect(tax).toHaveBeenCalledWith('__inherit__');
  });

  it('renders independent menu snapshots and existing stock wording without app contexts or file requests', () => {
    const items: MenuItem[] = [
      { id: 'zz-local', name: 'ZZ TEST Park lunch', category: 'zz-category', price: { weekday: 12.34, weekend: 23.45 } },
      { id: 'zz-shared', name: 'ZZ TEST Shared lunch', category: 'zz-category', price: { weekday: 10, weekend: 10 } },
    ];
    const fileApi = { exportWorkbook: vi.fn(), importPreview: vi.fn(), importCommit: vi.fn() };
    const menuHelpers = createMenuHelpers({ catalog: { getMenuCategories: () => host.catalog.menuCategories, getModifierGroups: () => host.catalog.modifierGroups } });
    const html = renderToStaticMarkup(createElement(MenuPanelWithPorts, { ports: {
      menuItems: items, menuCategories: host.catalog.menuCategories, modifierGroups: host.catalog.modifierGroups, menuHelpers,
      branch: { id: 'zz-park', name: 'ZZ TEST Park' }, apiBranchId: '01900000-0000-7000-8000-000000000001', fileApi,
      onImported: vi.fn(), toast: vi.fn(), formatWWPrice, upsertMenuItem: vi.fn(), deleteMenuItem: vi.fn(), upsertInventoryItem: vi.fn(), deleteInventoryItem: vi.fn(),
      canManageItem: item => item.id === 'zz-local',
    } }));
    expect(html).toContain('To start stock tracking, link the item in Inventory.');
    expect(html).toContain('ZZ TEST Shared lunch');
    expect(html).toContain('aria-label="Edit ZZ TEST Park lunch"');
    expect(html).not.toContain('aria-label="Edit ZZ TEST Shared lunch"');
    expect(fileApi.exportWorkbook).not.toHaveBeenCalled();
    expect(fileApi.importPreview).not.toHaveBeenCalled();
  });

  it('shows stock projections separately from raw merch metadata and withholds unmanageable row actions', () => {
    const item = { id: 'zz-merch', name: 'ZZ TEST Shirt', active: true, price: { weekday: 12.34, weekend: 23.45 } };
    const write = vi.fn();
    const html = renderToStaticMarkup(createElement(MerchPanelWithPorts, { ports: {
      merchItems: [item], shownItems: [{ ...item, stock: 2, lowStockThreshold: 3 }], formatWWPrice,
      upsertMerchItem: write, deleteMerchItem: write, upsertInventoryItem: write, deleteInventoryItem: write, canManageItem: () => false,
    } }));
    expect(html).toContain('Needs restocking (1)');
    expect(html).toContain('ZZ TEST Shirt');
    expect(html).not.toContain('aria-label="Edit ZZ TEST Shirt"');
    expect(html).not.toContain('aria-label="Retire ZZ TEST Shirt"');
    expect(write).not.toHaveBeenCalled();
    expect(item).not.toHaveProperty('stock');
  });

  it('offers operator writes only for the current canonical actor and its own operator scope', async () => {
    const account = { id: 'zz-actor', operatorId: 'zz-operator' };
    const calls: string[] = [];
    let permissions: unknown = [{ permission: 'catalog:menu:manage', scopeType: 'branch', scopeId: 'zz-park' }];
    const refuse = async <T,>(): Promise<T> => { throw new Error('Unexpected write'); };
    const api: AdminApi = { get: async <T,>(path: string): Promise<T> => { calls.push(path); return (path === '/me' ? { account } : { permissions }) as T; }, post: refuse, patch: refuse, put: refuse, delete: refuse };
    expect(await readOperatorMenuCapability(api, account.id)).toBe(false);
    permissions = [{ permission: 'catalog:menu:manage', scopeType: 'operator', scopeId: 'zz-other-operator' }];
    expect(await readOperatorMenuCapability(api, account.id)).toBe(false);
    permissions = [{ permission: 'catalog:menu:manage', scopeType: 'operator', scopeId: account.operatorId }];
    expect(await readOperatorMenuCapability(api, account.id)).toBe(true);
    expect(await readOperatorMenuCapability(api, 'zz-replaced-actor')).toBe(false);
    permissions = [{ permission: 'catalog:menu:manage', scopeType: 'operator', scopeId: null }];
    expect(await readOperatorMenuCapability(api, account.id)).toBe(true);
    permissions = { permission: 'catalog:menu:manage' };
    expect(await readOperatorMenuCapability(api, account.id)).toBe(false);
    expect(new Set(calls)).toEqual(new Set(['/me', '/me/permissions']));
  });

  it('separates the exact current park manage/import grants from global product authority', async () => {
    const account = { id: 'zz-actor', operatorId: 'zz-operator' };
    const park = 'zz-current-park';
    let permissions: unknown = [
      { permission: 'catalog:menu:manage', scopeType: 'branch', scopeId: park },
      { permission: 'catalog:menu:import', scopeType: 'branch', scopeId: 'zz-other-park' },
    ];
    const calls: string[] = [];
    const refuse = async <T,>(): Promise<T> => { throw new Error('Unexpected write'); };
    const api: AdminApi = { get: async <T,>(path: string): Promise<T> => { calls.push(path); return (path === '/me' ? { account } : { permissions }) as T; }, post: refuse, patch: refuse, put: refuse, delete: refuse };
    const branch = await readMenuCapabilities(api, account.id, park);
    expect(branch.canManage).toBe(false);
    expect(branch.canManageBranch).toBe(true);
    expect(branch.canImport).toBe(false);
    expect(branch.canManageProduct(park)).toBe(true);
    expect(branch.canManageProduct(null)).toBe(false);
    expect(branch.canManageProduct(undefined)).toBe(false);
    expect(branch.canManageProduct('zz-other-park')).toBe(false);
    expect(calls).toEqual(['/me', '/me/permissions']);
    permissions = [{ permission: 'catalog:menu:import', scopeType: 'branch', scopeId: park }];
    const importer = await readMenuCapabilities(api, account.id, park);
    expect(importer.canImport).toBe(true);
    expect(importer.canManageBranch).toBe(false);
    permissions = [{ permission: 'catalog:menu:manage', scopeType: 'operator', scopeId: null }];
    const operator = await readMenuCapabilities(api, account.id, park);
    expect(operator.canManage).toBe(true);
    expect(operator.canManageBranch).toBe(true);
    expect(operator.canManageProduct(null)).toBe(true);
    expect(operator.canManageProduct('zz-other-park')).toBe(false);
    expect(operator.canManageProduct(undefined)).toBe(false);
  });

  it('does not send the second native category reorder write after unmount', async () => {
    const first: MenuCategoryDef = { id: 'zz-first', name: 'ZZ TEST First', parentId: 'zz-parent', sortOrder: 0 };
    const second: MenuCategoryDef = { id: 'zz-second', name: 'ZZ TEST Second', parentId: 'zz-parent', sortOrder: 1 };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const write = vi.fn(async () => { await held; });
    const mounted = { current: true };
    const move = runInNewContext(callbackSource('categories/CategoriesPanel.tsx', 'moveSub'), {
      menuCategories: [first, second], subCategoriesOf: () => [first, second], mutators: { upsertMenuCategory: write },
      movingRef: { current: false }, manageRef: { current: true }, mounted, setMoving: vi.fn(), setWriteError: vi.fn(),
    }) as (category: MenuCategoryDef, direction: number) => Promise<void>;
    const pending = move(first, 1);
    expect(write).toHaveBeenCalledTimes(1);
    mounted.current = false;
    release();
    await pending;
    expect(write).toHaveBeenCalledTimes(1);
  });
});
