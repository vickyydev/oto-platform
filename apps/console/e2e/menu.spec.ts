import { expect, test, type Page } from '@playwright/test';

const PARK = '01910000-0000-7000-8000-000000000001', OTHER = '01910000-0000-7000-8000-000000000002';
const OPERATOR = '01910000-0000-7000-8000-000000000003', ACTOR = '01910000-0000-7000-8000-000000000004';
const CATEGORY = '01910000-0000-7000-8000-000000000005', SHOP = '01910000-0000-7000-8000-000000000006';
const ITEM = '01910000-0000-7000-8000-000000000007', MERCH = '01910000-0000-7000-8000-000000000008';
const LIBRARY = '01910000-0000-7000-8000-000000000009', INLINE = '01910000-0000-7000-8000-00000000000a';
const OPTION = '01910000-0000-7000-8000-00000000000b', SIZE = 'zz-size-medium';
const grants = ['app:console:access', 'admin:branch:read', 'catalog:menu:read', 'catalog:menu:manage', 'catalog:menu:import'];
const translation = { th: { name: 'ZZ TEST preserved translation' } };
type Row = Record<string, unknown> & { id: string; name: string };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const menuPath = '/branches/' + PARK + '/menu';

async function fixture(page: Page, options: { branchOnly?: boolean; permissions?: string[]; sharedItem?: boolean } = {}) {
  // Model a backend session separately from its immutable account identity.
  let fixtureSessionActor: string | null = null, fixtureSessionId = '';
  const fixtureOperatorContext = (actor: string, operatorId: string, branchId: string | null) => {
    if (fixtureSessionActor !== actor) {
      fixtureSessionActor = actor;
      fixtureSessionId = crypto.randomUUID();
    }
    return { sessionId: fixtureSessionId, homeOperatorId: operatorId, effectiveOperatorId: operatorId,
      operatorOverride: null, branchId, stationId: null, revision: 0 };
  };

  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined; key: string | undefined }> = [];
  const errors: string[] = [];
  const controls = { refused: new Set<string>(), pending: new Map<string, Promise<void>>(), failedReads: new Map<string, number>(), delayedReads: new Map<string, Promise<void>>(), failAfterCreate: false };
  const parks = [PARK, OTHER].map((id, i) => ({ id, name: i ? 'ZZ TEST Other park' : 'ZZ TEST Menu park', code: 'zz-menu-' + i, timezone: 'Asia/Bangkok', country: 'TH', archived: false, address: null, openingHours: null, businessDayStart: '05:00:00' }));
  const categories: Row[] = [
    { id: CATEGORY, name: 'ZZ TEST Food', code: 'ZZ-FOOD', parentId: null, taxableCategory: 'fnb', defaultPrepStation: 'kitchen', effectiveTaxCategory: 'fnb', effectivePrepStation: 'kitchen', sortOrder: 0, translations: translation, archivedAt: null },
    { id: SHOP, name: 'ZZ TEST Shop', code: 'ZZ-SHOP', parentId: null, taxableCategory: 'merch', defaultPrepStation: 'none', effectiveTaxCategory: 'merch', effectivePrepStation: 'none', sortOrder: 1, translations: null, archivedAt: null },
  ];
  const groups: Row[] = [
    { id: LIBRARY, productId: null, name: 'ZZ TEST Shared choice', required: false, selectionType: 'single', minSelect: null, maxSelect: null, sortOrder: 0, translations: translation, options: [{ id: '01910000-0000-7000-8000-00000000000d', name: 'ZZ TEST Shared option', priceSatang: 123, priceWeekendSatang: 234, costSatang: 345, sortOrder: 0, translations: translation }] },
    { id: INLINE, productId: ITEM, name: 'ZZ TEST Inline choice', required: false, selectionType: 'single', minSelect: null, maxSelect: null, sortOrder: 0, translations: translation, options: [{ id: OPTION, name: 'ZZ TEST Inline option', priceSatang: 123, priceWeekendSatang: 234, costSatang: 345, sortOrder: 0, translations: translation }] },
  ];
  const base = { code: 'ZZ-MENU', description: 'ZZ TEST Hidden description', priceSatang: 12345, priceWeekendSatang: 16789, costSatang: 1234, active: true, archivedAt: null, stockItemId: null, stockLinks: [], prepStationOverride: null, taxCategoryOverride: null, translations: translation, sortOrder: 7, linkedModifierGroupIds: [LIBRARY], variants: [], sku: null };
  const products: Row[] = [
    { ...base, id: ITEM, branchId: options.sharedItem ? null : PARK, kind: 'menu', categoryId: CATEGORY, name: 'ZZ TEST Noodles' },
    { ...base, id: MERCH, branchId: PARK, kind: 'merch', categoryId: SHOP, name: 'ZZ TEST Shirt', code: 'ZZ-SHIRT', sku: 'ZZ-ITEM-SKU', linkedModifierGroupIds: [], variants: [{ id: SIZE, label: 'M', sku: 'ZZ-SIZE-SKU', barcode: '9999999912345' }] },
  ];
  page.on('pageerror', error => errors.push(error.name));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const method = request.method(), path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    calls.push({ method, path, body, key: request.headers()['idempotency-key'] });
    if (method === 'GET') {
      const wait = controls.delayedReads.get(path), fail = (controls.failedReads.get(path) ?? 0) > 0;
      controls.delayedReads.delete(path);
      if (fail) controls.failedReads.set(path, controls.failedReads.get(path)! - 1);
      await wait;
      if (fail) return route.fulfill({ status: 500, json: { error: { code: 'ZZ_TEST_READ', message: 'ZZ TEST Refresh refused.' } } });
    } else {
      await controls.pending.get(path);
      if (controls.refused.has(path)) return route.fulfill({ status: 409, json: { error: { code: 'ZZ_TEST_REFUSED', message: 'ZZ TEST Keep this draft.' } } });
    }
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext(ACTOR, OPERATOR, (parks[0])?.id ?? null), account: { id: ACTOR, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false }, employee: { id: ACTOR, name: 'ZZ TEST Menu administrator', nickname: null }, branch: parks[0], isPlatformAdmin: false, photoFileId: null, sessionLocked: false, preferences: { theme: 'light', language: 'en' } } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: (options.permissions ?? grants).map(permission => ({ permission, scopeType: options.branchOnly ? 'branch' : 'operator', scopeId: options.branchOnly ? PARK : OPERATOR })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: parks } });
    if (path === '/menu/discounts') return route.fulfill({ json: { discounts: [] } });
    if (/^\/branches\/[^/]+\/menu$/.test(path) && method === 'GET') return route.fulfill({ json: { branchId: path.split('/')[2], categories, products: path === menuPath ? products : [], modifierGroups: path === menuPath ? groups : [] } });
    const product = /^\/branches\/[^/]+\/menu\/products(?:\/([^/]+))?$/.exec(path);
    if (product) {
      if (method === 'POST') { const id = '01910000-0000-7000-8000-00000000000e'; products.push({ ...base, ...body, id, name: String(body?.name), branchId: PARK }); if (controls.failAfterCreate) controls.failedReads.set(menuPath, 1); return route.fulfill({ json: { id } }); }
      const row = products.find(value => value.id === product[1]);
      if (method === 'PATCH' && row) { Object.assign(row, body); if (body?.modifierGroupIds) row.linkedModifierGroupIds = body.modifierGroupIds; return route.fulfill({ json: { ok: true } }); }
      if (method === 'DELETE' && row) { products.splice(products.indexOf(row), 1); return route.fulfill({ json: { ok: true } }); }
    }
    const category = /^\/menu\/categories(?:\/([^/]+))?$/.exec(path);
    if (category && method === 'PATCH') { Object.assign(categories.find(row => row.id === category[1])!, body); return route.fulfill({ json: { ok: true } }); }
    const group = /^\/menu\/modifier-groups(?:\/([^/]+))?$/.exec(path);
    if (group && method === 'PATCH') { Object.assign(groups.find(row => row.id === group[1])!, body); return route.fulfill({ json: { ok: true } }); }
    if (path === menuPath + '/import/preview') {
      const filename = String(body?.filename);
      return route.fulfill({ json: { previewToken: 'ZZ_TEST_PREVIEW_' + filename, filename, counts: { create: 0, update: 1, archive: 0, unchanged: 0, ignored: 0 }, categories: { create: 0, update: 0, archive: 0, unchanged: 0 }, rows: [{ sheet: 'Menu items', row: 2, code: 'ZZ-MENU', name: 'ZZ TEST Preview ' + filename, action: 'update', changes: [{ field: 'price_weekday', from: '123.45', to: '234.56' }] }], errors: [], notice: 'ZZ TEST Omitted rows remain unchanged.' } });
    }
    if (path === menuPath + '/import/commit') return route.fulfill({ json: { created: 0, updated: 1, archived: 0, categoriesCreated: 0, categoriesUpdated: 0, categoriesArchived: 0 } });
    if (path === menuPath + '/export.xlsx') return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'content-disposition': 'attachment; filename="ZZ TEST exported menu.xlsx"' }, body: Buffer.from('ZZ TEST exported workbook') });
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST Outside this fixture.' } } });
  });
  return { calls, controls, products, categories, groups, errors };
}

test('Catalogue opens all four native menu administration pages with no write on entry', async ({ page }) => {
  const state = await fixture(page);
  for (const [path, native] of [['menu', 'Add item'], ['categories', 'F&B Categories'], ['modifiers', 'Shared modifier groups'], ['merch', 'Add item']]) {
    await page.goto('/catalogue/' + path);
    if (path === 'categories' || path === 'modifiers') await expect(page.getByRole('heading', { name: native, exact: true })).toBeVisible();
    else await expect(page.getByRole('button', { name: native, exact: true })).toBeVisible();
  }
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]); expect(state.errors).toEqual([]);
});

test('branch readers see native records but operator category, library and inline-group writes stay withheld', async ({ page }) => {
  const state = await fixture(page, { branchOnly: true, sharedItem: true });
  for (const [path, label] of [['categories', 'Add category'], ['modifiers', 'Add group']]) {
    await page.goto('/catalogue/' + path);
    await expect(page.getByText(path === 'categories' ? 'ZZ TEST Food' : 'ZZ TEST Shared choice', { exact: true }).first()).toBeVisible();
    for (const button of await page.getByRole('button', { name: label, exact: true }).all()) await expect(button).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Edit ZZ TEST/ })).toHaveCount(0);
  }
  await page.goto('/catalogue/menu');
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Noodles', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  for (const button of await page.getByRole('button', { name: 'Add group', exact: true }).all()) await expect(button).toBeDisabled();
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
  const operator = await page.context().newPage();
  try { await fixture(operator, { sharedItem: true }); await operator.goto('/catalogue/menu'); await expect(operator.getByRole('button', { name: 'Edit ZZ TEST Noodles', exact: true })).toBeVisible(); }
  finally { await operator.close(); }
});

test('native menu edits accept stored fractional costs and inline deltas while preserving translations and inherited defaults', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/catalogue/menu'); await page.getByRole('button', { name: 'Edit ZZ TEST Noodles', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit menu item', exact: true });
  for (const input of await dialog.locator('input[type="number"]').all()) expect(await input.evaluate(element => (element as HTMLInputElement).validity.stepMismatch)).toBe(false);
  await expect(dialog.getByLabel('Prep station', { exact: true })).toContainText('Use category default');
  await expect(dialog.getByLabel('Tax category', { exact: true })).toContainText('Use category default');
  await dialog.getByLabel('Name', { exact: true }).fill('ZZ TEST Renamed noodles');
  // Unchanged groups intentionally make no request; changing this native label exercises its own save.
  await dialog.getByRole('textbox', { name: 'Option name', exact: true }).fill('ZZ TEST Renamed inline option');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const product = state.calls.find(call => call.method === 'PATCH' && call.path === menuPath + '/products/' + ITEM);
  expect(product?.body).toMatchObject({ name: 'ZZ TEST Renamed noodles', priceSatang: 12345, priceWeekendSatang: 16789, costSatang: 1234, translations: translation, prepStationOverride: null, taxCategoryOverride: null, code: 'ZZ-MENU', description: 'ZZ TEST Hidden description', active: true, sortOrder: 7 });
  const inline = state.calls.find(call => call.method === 'PATCH' && call.path === '/menu/modifier-groups/' + INLINE);
  expect(inline?.body).toMatchObject({ translations: translation, options: [{ name: 'ZZ TEST Renamed inline option', priceSatang: 123, priceWeekendSatang: 234, costSatang: 345, translations: translation }] });
  expect(state.calls.filter(call => call.method !== 'GET').every(call => /^[a-f0-9-]{36}$/i.test(call.key ?? ''))).toBe(true);
});

test('refused category and modifier edits retain drafts and hidden translations until an explicit successful retry', async ({ page }) => {
  const state = await fixture(page);
  for (const [surface, oldName, title, label, target] of [
    ['categories', 'ZZ TEST Food', 'Edit category', 'Name', '/menu/categories/' + CATEGORY],
    ['modifiers', 'ZZ TEST Shared choice', 'Edit modifier group', 'Group name', '/menu/modifier-groups/' + LIBRARY],
  ]) {
    state.controls.refused.add(target!); await page.goto('/catalogue/' + surface);
    await page.getByRole('button', { name: 'Edit ' + oldName, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true }), next = 'ZZ TEST Refused ' + surface;
    await dialog.getByLabel(label!, { exact: true }).fill(next); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('ZZ TEST Keep this draft.', { exact: true })).toBeVisible(); await expect(dialog.getByLabel(label!, { exact: true })).toHaveValue(next);
    state.controls.refused.delete(target!); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect(state.calls.filter(call => call.method === 'PATCH' && call.path === target).at(-1)?.body).toMatchObject({ translations: translation });
    if (surface === 'modifiers') expect(state.calls.filter(call => call.method === 'PATCH' && call.path === target).at(-1)?.body).toMatchObject({ options: [{ translations: translation, priceSatang: 123, priceWeekendSatang: 234, costSatang: 345 }] });
  }
});

test('Merch keeps native drafts, stable size identifiers and barcodes without creating stock writes', async ({ page }) => {
  const state = await fixture(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/catalogue/merch'); await page.getByRole('button', { name: 'Edit ZZ TEST Shirt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit merch item', exact: true }), target = menuPath + '/products/' + MERCH;
  state.controls.refused.add(target); await dialog.getByLabel('Name *', { exact: true }).fill('ZZ TEST Refused shirt');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.getByText('ZZ TEST Keep this draft.', { exact: true })).toBeVisible();
  state.controls.refused.delete(target); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(state.calls.filter(call => call.method === 'PATCH' && call.path === target).at(-1)?.body).toMatchObject({ sku: 'ZZ-ITEM-SKU', variants: [{ id: SIZE, label: 'M', sku: 'ZZ-SIZE-SKU', barcode: '9999999912345' }] });
  expect(state.products.find(row => row.id === MERCH)).toMatchObject({ name: 'ZZ TEST Refused shirt', translations: translation });
  expect(state.calls.filter(call => call.method !== 'GET').every(call => call.path === target)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('an escaped import preview cannot replace a reopened dialog or submit the old file', async ({ page }) => {
  const state = await fixture(page), gate = deferred();
  state.controls.pending.set(menuPath + '/import/preview', gate.promise);
  await page.goto('/catalogue/menu'); await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('dialog', { name: 'Import menu', exact: true }).locator('input[type="file"]').setInputFiles({ name: 'ZZ TEST old.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('old') });
  await expect.poll(() => state.calls.filter(call => call.path.endsWith('/import/preview')).length).toBe(1);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Import', exact: true }).click();
  state.controls.pending.delete(menuPath + '/import/preview');
  const dialog = page.getByRole('dialog', { name: 'Import menu', exact: true });
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'ZZ TEST current.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('current') });
  await expect(dialog.getByText('ZZ TEST Preview ZZ TEST current.xlsx', { exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/import/preview') && response.request().postDataJSON().filename === 'ZZ TEST old.xlsx');
  gate.resolve(); await (await oldResponse).finished();
  await expect(dialog.getByText('ZZ TEST Preview ZZ TEST old.xlsx', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const commits = state.calls.filter(call => call.path.endsWith('/import/commit'));
  expect(commits).toHaveLength(1); expect(commits[0]?.body).toMatchObject({ filename: 'ZZ TEST current.xlsx', contentBase64: Buffer.from('current').toString('base64') });
});

test('confirmed creation with a failed canonical refresh offers read Retry without repeating the write', async ({ page }) => {
  const state = await fixture(page); state.controls.failAfterCreate = true;
  await page.goto('/catalogue/menu'); await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add menu item', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('ZZ TEST Confirmed new item');
  await dialog.getByLabel('Category', { exact: true }).click(); await page.getByRole('option', { name: 'ZZ TEST Food', exact: true }).click();
  const stock = dialog.getByRole('switch', { name: 'Track stock', exact: true }); if (await stock.isChecked()) await stock.click();
  await dialog.getByRole('button', { name: 'Add menu item', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Saved, but/)).toBeVisible(); await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Confirmed new item', exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.method === 'POST' && call.path === menuPath + '/products')).toHaveLength(1);
});

test('native export retains the workbook filename and read gates never offer a cost-bearing download', async ({ page }) => {
  const state = await fixture(page); await page.goto('/catalogue/menu');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('ZZ TEST exported menu.xlsx');
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
  const reader = await page.context().newPage();
  try {
    const limited = await fixture(reader, { permissions: ['app:console:access', 'catalog:menu:read'] }); await reader.goto('/catalogue/menu');
    await expect(reader.getByText('ZZ TEST Noodles', { exact: true }).first()).toBeVisible();
    for (const button of await reader.getByRole('button', { name: /^(Export|Import|Add item)$/ }).all()) await expect(button).toBeDisabled();
    await expect(reader.getByRole('button', { name: /^Edit ZZ TEST/ })).toHaveCount(0);
    expect(limited.calls.some(call => call.path.endsWith('/export.xlsx'))).toBe(false);
  } finally { await reader.close(); }
});
