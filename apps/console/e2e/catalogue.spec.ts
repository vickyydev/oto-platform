import { expect, test, type Page } from '@playwright/test';

const PARK = '01900000-0000-7000-8000-000000000001';
const OTHER_PARK = '01900000-0000-7000-8000-000000000002';
const OPERATOR = '01900000-0000-7000-8000-000000000003';
const ACTOR = '01900000-0000-7000-8000-000000000004';
const TICKET = '01900000-0000-7000-8000-000000000005';
const ADDON = '01900000-0000-7000-8000-000000000006';
const CATEGORY = '01900000-0000-7000-8000-000000000007';
const access = ['app:console:access', 'app:pos:access', 'admin:branch:read', 'catalog:package:read', 'catalog:package:create', 'catalog:package:update', 'catalog:menu:read', 'catalog:menu:manage'];
interface Ticket {
  id: string; name: string; durationLabel: string; hours: number; prices: Record<string, { weekday: number; weekend: number }>;
  tierPricing: unknown; adultRules: unknown; creditRule: unknown; freebies: unknown; gateAccess: boolean; translations: unknown;
}
interface Tier { id: string; name: string; isDefault: boolean; requiresVerification: boolean; sortOrder: number }
interface Product {
  id: string; branchId: string | null; kind: string; categoryId: string; name: string; code: string | null; description: string | null;
  priceSatang: number; priceWeekendSatang: number | null; active: boolean; archivedAt: string | null;
  costSatang: number | null; stockItemId: string | null; prepStationOverride: string | null; taxCategoryOverride: string | null;
  translations: unknown; sortOrder: number; linkedModifierGroupIds: string[];
}

async function fixture(page: Page, options: { scope?: 'branch' | 'operator'; scopeId?: string | null; permissions?: string[]; globalAddOn?: boolean } = {}) {
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

  const calls: Array<{ method: string; path: string; body: unknown; key: string | undefined }> = [];
  const runtimeErrors: string[] = [];
  const control = { refused: new Set<string>(), pending: new Map<string, Promise<void>>(), failedReads: new Map<string, number>(), delayedReads: new Map<string, Promise<void>>(), failReadbackAfterCreate: false, heldReadbackAfterCreate: null as Promise<void> | null };
  page.on('pageerror', error => runtimeErrors.push(error.name));
  const parks = [
    { id: PARK, name: 'ZZ TEST Central', code: 'zz-central', timezone: 'Asia/Bangkok', country: 'TH', archived: false, address: null, openingHours: null, businessDayStart: '05:00:00' },
    { id: OTHER_PARK, name: 'ZZ TEST Other park', code: 'zz-other', timezone: 'Asia/Bangkok', country: 'TH', archived: false, address: null, openingHours: null, businessDayStart: '05:00:00' },
  ];
  const tiers: Tier[] = [
    { id: 'tourist', name: 'ZZ TEST Standard', isDefault: true, requiresVerification: false, sortOrder: 0 },
    { id: 'resident', name: 'ZZ TEST Resident', isDefault: false, requiresVerification: true, sortOrder: 1 },
  ];
  const tickets: Record<string, Ticket[]> = {
    [PARK]: [{ id: TICKET, name: 'ZZ TEST Two hours', durationLabel: '2 hours', hours: 2, prices: { tourist: { weekday: 12345, weekend: 16789 } }, tierPricing: null, adultRules: { tourist: { kind: 'same_as_kid' } }, creditRule: null, freebies: [], gateAccess: false, translations: { th: { name: 'ZZ TEST translation' } } }],
    [OTHER_PARK]: [{ id: '01900000-0000-7000-8000-000000000008', name: 'ZZ TEST Other park ticket', durationLabel: '2 hours', hours: 2, prices: { tourist: { weekday: 22222, weekend: 33333 } }, tierPricing: null, adultRules: null, creditRule: null, freebies: [], gateAccess: false, translations: null }],
  };
  const products: Record<string, Product[]> = {
    [PARK]: [{ id: ADDON, branchId: options.globalAddOn ? null : PARK, kind: 'addon', categoryId: CATEGORY, name: 'ZZ TEST Locker extra', code: 'ZZ-LOCKER', description: 'ZZ TEST hidden description', priceSatang: 1234, priceWeekendSatang: 2345, active: true, archivedAt: null, costSatang: null, stockItemId: null, prepStationOverride: null, taxCategoryOverride: null, translations: null, sortOrder: 4, linkedModifierGroupIds: [] }],
    [OTHER_PARK]: [],
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const request = route.request(), method = request.method(), path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    calls.push({ method, path, body, key: request.headers()['idempotency-key'] });
    if (method === 'GET') {
      const failed = (control.failedReads.get(path) ?? 0) > 0, delayed = control.delayedReads.get(path);
      if (failed) control.failedReads.set(path, control.failedReads.get(path)! - 1);
      control.delayedReads.delete(path);
      await delayed;
      if (failed) return route.fulfill({ status: 500, json: { error: { code: 'ZZ_TEST_READBACK', message: 'ZZ TEST canonical refresh is unavailable.' } } });
    }
    if (method !== 'GET') {
      await control.pending.get(path);
      if (control.refused.has(path)) return route.fulfill({ status: 409, json: { error: { code: 'ZZ_TEST_REFUSED', message: 'ZZ TEST save was refused; keep the draft.' } } });
    }
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext(ACTOR, OPERATOR, (parks[0])?.id ?? null), account: { id: ACTOR, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false }, employee: { id: ACTOR, name: 'ZZ TEST Catalogue administrator', nickname: null }, branch: parks[0], isPlatformAdmin: false, photoFileId: null, sessionLocked: false, preferences: { theme: 'light', language: 'en' } } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: (options.permissions ?? access).map(permission => ({ permission, scopeType: options.scope ?? 'operator', scopeId: options.scopeId !== undefined ? options.scopeId : options.scope === 'branch' ? PARK : OPERATOR })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: parks } });
    if (path === '/menu/discounts' && method === 'GET') return route.fulfill({ json: { discounts: [] } });
    if (path === '/tiers' && method === 'GET') return route.fulfill({ json: { tiers } });
    if (path === '/tiers' && method === 'POST') { const code = body!.code as string; tiers.push({ id: code, name: body!.name as string, isDefault: false, requiresVerification: true, sortOrder: tiers.length }); return route.fulfill({ json: { id: code } }); }
    const tier = /^\/tiers\/([^/]+)$/.exec(path);
    if (tier) {
      const row = tiers.find(value => value.id === tier[1]);
      if (method === 'PATCH' && row) { Object.assign(row, body); if (body?.isDefault) for (const other of tiers) if (other !== row) other.isDefault = false; return route.fulfill({ json: { ok: true } }); }
      if (method === 'DELETE') { const index = tiers.findIndex(value => value.id === tier[1]); if (index >= 0) tiers.splice(index, 1); return route.fulfill({ json: { ok: true } }); }
    }
    const ticket = /^\/branches\/([^/]+)\/ticket-packages(?:\/([^/]+))?$/.exec(path);
    if (ticket) {
      const rows = tickets[ticket[1]!] ?? [];
      if (method === 'GET') return route.fulfill({ json: { packages: rows } });
      if (method === 'POST') {
        const id = '01900000-0000-7000-8000-000000000009'; rows.push({ ...(body as unknown as Ticket), id });
        const catalogue = '/branches/' + ticket[1] + '/ticket-packages';
        if (control.failReadbackAfterCreate || control.heldReadbackAfterCreate) control.failedReads.set(catalogue, 1);
        if (control.heldReadbackAfterCreate) control.delayedReads.set(catalogue, control.heldReadbackAfterCreate);
        return route.fulfill({ json: { id } });
      }
      if (method === 'PATCH') { Object.assign(rows.find(row => row.id === ticket[2])!, body); return route.fulfill({ json: { ok: true } }); }
      if (method === 'DELETE') { tickets[ticket[1]!] = rows.filter(row => row.id !== ticket[2]); return route.fulfill({ json: { ok: true } }); }
    }
    const menu = /^\/branches\/([^/]+)\/menu(?:\/products(?:\/([^/]+))?)?$/.exec(path);
    if (menu) {
      const rows = products[menu[1]!] ?? [];
      if (method === 'GET') return route.fulfill({ json: { branchId: menu[1], categories: [{ id: CATEGORY, name: 'ZZ TEST Add-ons', code: 'zz-addons', parentId: null, kind: 'addons', taxableCategory: 'addons', effectiveTaxCategory: 'addons', prepStation: null, effectivePrepStation: null, sortOrder: 0 }], products: rows, modifierGroups: [] } });
      if (method === 'PATCH') { Object.assign(rows.find(row => row.id === menu[2])!, body); return route.fulfill({ json: { ok: true } }); }
      if (method === 'DELETE') { products[menu[1]!] = rows.filter(row => row.id !== menu[2]); return route.fulfill({ json: { ok: true } }); }
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST action is outside this fixture.' } } });
  });
  return { calls, runtimeErrors, parks, tiers, tickets, products, control };
}

test('Catalogue opens the three native approved pages rather than the old POS placeholder', async ({ page }) => {
  const { calls, runtimeErrors } = await fixture(page, { scopeId: null });
  for (const [path, heading, control] of [
    ['/catalogue/tickets', 'Tickets', 'Add ticket type'],
    ['/catalogue/tiers', 'Tiers', 'Customer tiers'],
    ['/catalogue/add-ons', 'Add-ons', 'Add add-on'],
  ]) {
    await page.goto(path!);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    if (heading === 'Tiers') await expect(page.getByRole('heading', { name: control, exact: true })).toBeVisible();
    else await expect(page.getByRole('button', { name: control, exact: true })).toBeVisible();
  }
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test('branch-scoped tier and shared add-on offers preserve the existing operator-wide authority', async ({ page }) => {
  const { calls } = await fixture(page, { scope: 'branch', globalAddOn: true });
  await page.goto('/catalogue/tiers');
  await expect(page.getByRole('heading', { name: 'Customer tiers', exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Resident', { exact: true }).or(page.locator('input[value="ZZ TEST Resident"]')).first()).toBeVisible();
  for (const input of await page.getByPlaceholder('New tier (e.g. Student)').all())
    expect(await input.isDisabled() || await input.getAttribute('readonly') !== null).toBe(true);
  for (const button of await page.getByRole('button', { name: /^(Add|Make default|Requires proof|No proof|Move up|Move down|Remove tier)$/ }).all())
    await expect(button).toBeDisabled();
  await expect(page.locator('main input:not([readonly]):not([disabled])')).toHaveCount(0);
  await page.goto('/catalogue/add-ons');
  await expect(page.getByText('ZZ TEST Locker extra', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Locker extra', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete ZZ TEST Locker extra', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  const operatorPage = await page.context().newPage();
  try {
    const operator = await fixture(operatorPage, { globalAddOn: true });
    await operatorPage.goto('/catalogue/add-ons');
    await expect(operatorPage.getByRole('button', { name: 'Edit ZZ TEST Locker extra', exact: true })).toBeVisible();
    await expect(operatorPage.getByRole('button', { name: 'Delete ZZ TEST Locker extra', exact: true })).toBeVisible();
    expect(operator.calls.filter(call => call.method !== 'GET')).toEqual([]);
  } finally { await operatorPage.close(); }
});

test('ticket price edits preserve hidden rules and exact satang through canonical readback and reload', async ({ page }) => {
  const { calls, tickets } = await fixture(page);
  await page.goto('/catalogue/tickets');
  await page.getByRole('button', { name: 'Edit ZZ TEST Two hours', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit ticket type', exact: true });
  // Existing API satang amounts must remain valid before any unrelated name edit.
  for (const index of [1, 2]) {
    expect(await dialog.getByRole('spinbutton').nth(index).evaluate(input => {
      const price = input as HTMLInputElement;
      return { value: price.value, valid: price.checkValidity(), stepMismatch: price.validity.stepMismatch };
    })).toEqual({ value: index === 1 ? '123.45' : '167.89', valid: true, stepMismatch: false });
  }
  await dialog.getByLabel('Name', { exact: true }).fill('ZZ TEST Corrected ticket');
  // Hours is the first native number input; the following pair is the approved base tier price.
  await dialog.getByRole('spinbutton').nth(1).fill('234.56');
  await dialog.getByRole('spinbutton').nth(2).fill('278.90');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(tickets[PARK]![0]).toMatchObject({ name: 'ZZ TEST Corrected ticket', prices: { tourist: { weekday: 23456, weekend: 27890 } }, translations: { th: { name: 'ZZ TEST translation' } } });
  const writes = calls.filter(call => call.method !== 'GET');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ method: 'PATCH', path: '/branches/' + PARK + '/ticket-packages/' + TICKET, key: expect.stringMatching(/^[a-f0-9-]{36}$/i) });
  expect(writes[0]!.body).toHaveProperty('translations', { th: { name: 'ZZ TEST translation' } });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Corrected ticket', exact: true })).toBeVisible();
});

test('a refused ticket or add-on save keeps its native draft and succeeds only after a confirmed retry', async ({ page }) => {
  const { control, tickets, products } = await fixture(page);
  for (const [surface, oldName, title, target] of [
    ['tickets', 'ZZ TEST Two hours', 'Edit ticket type', '/branches/' + PARK + '/ticket-packages/' + TICKET],
    ['add-ons', 'ZZ TEST Locker extra', 'Edit add-on', '/branches/' + PARK + '/menu/products/' + ADDON],
  ]) {
    control.refused.add(target!);
    await page.goto('/catalogue/' + surface);
    await page.getByRole('button', { name: 'Edit ' + oldName, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true }), name = 'ZZ TEST Refused ' + surface;
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('ZZ TEST save was refused; keep the draft.', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name);
    expect(surface === 'tickets' ? tickets[PARK]![0]!.name : products[PARK]![0]!.name).toBe(oldName);
    control.refused.delete(target!);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit ' + name, exact: true })).toBeVisible();
  }
});

test('late ticket and add-on saves cannot close or erase a newly reopened native draft', async ({ page }) => {
  const { control, calls } = await fixture(page);
  for (const [surface, oldName, title, target] of [
    ['tickets', 'ZZ TEST Two hours', 'Edit ticket type', '/branches/' + PARK + '/ticket-packages/' + TICKET],
    ['add-ons', 'ZZ TEST Locker extra', 'Edit add-on', '/branches/' + PARK + '/menu/products/' + ADDON],
  ]) {
    let release!: () => void;
    control.pending.set(target!, new Promise<void>(resolve => { release = resolve; }));
    await page.goto('/catalogue/' + surface);
    await page.getByRole('button', { name: 'Edit ' + oldName, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await dialog.getByLabel('Name', { exact: true }).fill('ZZ TEST Old pending ' + surface);
    const dispatched = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname === '/api' + target);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await dispatched;
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Edit ' + oldName, exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('ZZ TEST New unsaved ' + surface);
    const returned = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api' + target);
    const readBack = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api' + (surface === 'tickets' ? '/branches/' + PARK + '/ticket-packages' : '/branches/' + PARK + '/menu'));
    release(); await (await returned).finished(); await (await readBack).finished(); control.pending.delete(target!);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('ZZ TEST New unsaved ' + surface);
    expect(calls.filter(call => call.method === 'PATCH' && call.path === target)).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});

test('operator tier failures retain a new name while original rename proof and default controls remain native', async ({ page }) => {
  const { control, tiers } = await fixture(page);
  control.refused.add('/tiers'); await page.goto('/catalogue/tiers');
  const input = page.getByPlaceholder('New tier (e.g. Student)'), name = 'ZZ TEST Student';
  await input.fill(name); await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('ZZ TEST save was refused; keep the draft.', { exact: true })).toBeVisible();
  await expect(input).toHaveValue(name); expect(tiers).toHaveLength(2);
  control.refused.delete('/tiers'); await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect.poll(() => tiers.some(tier => tier.name === name)).toBe(true);
  const tier = tiers.find(row => row.name === name)!;
  const row = page.getByTestId('tier-list').locator(':scope > div').filter({ has: page.getByText(tier.id, { exact: true }) });
  await row.getByRole('textbox').fill('ZZ TEST Renamed student'); await row.getByRole('textbox').blur();
  await expect.poll(() => tier.name).toBe('ZZ TEST Renamed student');
  await row.getByRole('button', { name: 'Requires proof', exact: true }).click();
  await expect.poll(() => tier.requiresVerification).toBe(false);
  await expect(row.getByRole('button', { name: 'Make default', exact: true })).toBeEnabled();
  await expect(row.getByRole('button', { name: 'Move up', exact: true })).toBeEnabled();
  await expect(row.getByRole('button', { name: 'Remove tier', exact: true })).toBeEnabled();
});

test('the native Add-ons phone card fits and inherited stock-on remains a local placeholder', async ({ page }) => {
  const { calls, products } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/catalogue/add-ons');
  const edit = page.getByRole('button', { name: 'Edit ZZ TEST Locker extra', exact: true });
  await expect(edit).toBeVisible();
  expect(await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ viewport: 390, document: 390 });
  expect(await edit.evaluate(button => {
    const card = button.closest('div.rounded-2xl')?.getBoundingClientRect();
    return Boolean(card && card.left >= 0 && card.right <= innerWidth);
  })).toBe(true);
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Edit add-on', exact: true });
  await expect(dialog.getByLabel('Track stock for this add-on', { exact: true })).not.toBeChecked();
  await dialog.getByLabel('Track stock for this add-on', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(products[PARK]![0]!.stockItemId).toBeNull();
  const writes = calls.filter(call => call.method !== 'GET');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.path).toBe('/branches/' + PARK + '/menu/products/' + ADDON);
  expect(writes[0]!.body).not.toHaveProperty('stockLinks');
  expect(writes[0]!.body).not.toHaveProperty('inventoryItemId');
});

test('direct Catalogue addresses preserve each existing read gate without catalogue requests', async ({ page }) => {
  const { calls } = await fixture(page, { permissions: ['app:console:access', 'admin:branch:read'] });
  for (const [surface, permission] of [['tickets', 'catalog:package:read'], ['tiers', 'catalog:package:read'], ['add-ons', 'catalog:menu:read']]) {
    await page.goto('/catalogue/' + surface);
    await expect(page.getByText(permission!, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Add ticket type|Add add-on|Add)$/ })).toHaveCount(0);
  }
  expect(calls.filter(call => call.method !== 'GET' || call.path.includes('ticket-packages') || call.path.includes('/menu') || call.path === '/tiers')).toEqual([]);
});

test('a ticket write from the previous page cannot reload over the current Add-ons catalogue', async ({ page }) => {
  const { control, calls } = await fixture(page);
  const target = '/branches/' + PARK + '/ticket-packages/' + TICKET;
  let release!: () => void;
  control.pending.set(target, new Promise<void>(resolve => { release = resolve; }));
  await page.goto('/catalogue/tickets');
  await page.getByRole('button', { name: 'Edit ZZ TEST Two hours', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit ticket type', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('ZZ TEST Old page ticket');
  const dispatched = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname === '/api' + target);
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await dispatched;
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const ticketReads = calls.filter(call => call.method === 'GET' && call.path === '/branches/' + PARK + '/ticket-packages').length;
  await page.getByRole('link', { name: 'Add-ons', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Locker extra', exact: true })).toBeVisible();
  const returned = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api' + target);
  release(); await (await returned).finished(); control.pending.delete(target);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(calls.filter(call => call.method === 'GET' && call.path === '/branches/' + PARK + '/ticket-packages')).toHaveLength(ticketReads);
  await expect(page.getByRole('heading', { name: 'Add-ons', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Locker extra', exact: true })).toBeVisible();
});

test('a confirmed ticket creation with a failed readback offers only a refresh retry', async ({ page }) => {
  const { control, calls, tickets } = await fixture(page);
  await page.goto('/catalogue/tickets');
  await page.getByRole('button', { name: 'Add ticket type', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add ticket type', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('ZZ TEST Committed once');
  await dialog.getByLabel('Duration label', { exact: true }).fill('2 hours');
  await dialog.getByLabel('Hours', { exact: true }).fill('2');
  control.failReadbackAfterCreate = true;
  await dialog.getByRole('button', { name: 'Add ticket type', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.method === 'POST').length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/^Saved, but /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add ticket type', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Committed once', exact: true })).toBeVisible();
  expect(tickets[PARK]!.filter(ticket => ticket.name === 'ZZ TEST Committed once')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'POST')[0]!.key).toMatch(/^[a-f0-9-]{36}$/i);
});

test('an old failed post-commit read cannot clear a newer successful read after a park round trip', async ({ page }) => {
  const { control, calls } = await fixture(page);
  await page.goto('/catalogue/tickets');
  await page.getByRole('button', { name: 'Add ticket type', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add ticket type', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('ZZ TEST Committed in original park');
  await dialog.getByLabel('Duration label', { exact: true }).fill('2 hours');
  await dialog.getByLabel('Hours', { exact: true }).fill('2');
  let release!: () => void;
  control.heldReadbackAfterCreate = new Promise<void>(resolve => { release = resolve; });
  const target = '/api/branches/' + PARK + '/ticket-packages';
  const oldRead = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === target);
  await dialog.getByRole('button', { name: 'Add ticket type', exact: true }).click(); await oldRead;
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('combobox', { name: 'Park', exact: true }).selectOption(OTHER_PARK);
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Other park ticket', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Park', exact: true }).selectOption(PARK);
  const committed = page.getByRole('button', { name: 'Edit ZZ TEST Committed in original park', exact: true });
  await expect(committed).toBeVisible();
  const returned = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === target && response.status() === 500);
  release(); await (await returned).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(committed).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add ticket type', exact: true })).toBeVisible();
  await expect(page.getByText(/^Saved, but /)).toHaveCount(0);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
});
