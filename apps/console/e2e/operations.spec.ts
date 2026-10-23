import { expect, test, type Page } from '@playwright/test';
import type { Permission } from '@oto/shared/permissions';
import type { StockLevels, WalletEntryView, WalletView } from '@oto/shared';
import type { ApiMember } from '@oto/admin-screens/lifted/api/platform';

const PARK = '01940000-0000-7000-8000-000000000001', OTHER = '01940000-0000-7000-8000-000000000002';
const OPERATOR = '01940000-0000-7000-8000-000000000003', ACTOR = '01940000-0000-7000-8000-000000000004';
const PERSON = '01940000-0000-7000-8000-000000000005', SECOND = '01940000-0000-7000-8000-000000000006';
const PRODUCT = '01940000-0000-7000-8000-000000000007', ITEM = '01940000-0000-7000-8000-000000000008';
const PLACE = '01940000-0000-7000-8000-000000000009', STORE = '01940000-0000-7000-8000-00000000000a';
const WALLET = '01940000-0000-7000-8000-00000000000b', CREATED = '01940000-0000-7000-8000-00000000000c';
const access: Permission[] = ['app:console:access', 'admin:branch:read', 'catalog:menu:read', 'catalog:package:read',
  'pos:stock:read', 'pos:stock:adjust', 'pos:stock:order', 'pos:member:read', 'pos:member:list', 'pos:member:create',
  'pos:member:update', 'pos:member:tier_downgrade', 'pos:wallet:read', 'pos:wallet:reactivate'];
const hold = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
type Body = Record<string, unknown>;
const person = (id = PERSON, nickname = 'ZZ TEST Ada'): ApiMember => ({ id, nickname, phone: '+66812340000', name: null,
  email: null, tierCode: 'regular', preferredChannel: null, notes: null, tierVerification: null, children: [] });

async function fixture(page: Page, options: { branchOnly?: boolean; omitted?: Permission[] } = {}) {
  const calls: Array<{ method: string; path: string; query: string; body: Body | undefined; key: string | undefined }> = [];
  const runtimeErrors: string[] = [], alerts: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.accept(); });
  const control = { actor: ACTOR, menuUnavailable: false, tiersUnavailable: false, noDefaultTier: false, reverseTiers: false,
    failStockReadAfterWrite: false, stockReadUnavailable: false,
    refused: new Set<string>(), uncertainOnce: new Set<string>(), pending: new Map<string, Promise<void>>() };
  const parks = [PARK, OTHER].map((id, i) => ({ id, name: i ? 'ZZ TEST Other operations park' : 'ZZ TEST Operations park',
    code: 'zz-operations-' + i, timezone: 'Asia/Bangkok', country: 'TH', archived: false, businessDayStart: '05:00:00' }));
  const locations = [{ id: PLACE, name: 'ZZ TEST Front counter', type: 'rotation', active: true, sellPoint: true },
    { id: STORE, name: 'ZZ TEST Retired store', type: 'bulk', active: false, sellPoint: false }];
  const levels: Record<string, StockLevels> = Object.fromEntries(parks.map<[string, StockLevels]>(park => [park.id, { branchId: park.id,
    locations: [{ id: PLACE, name: locations[0]!.name, type: 'rotation', sellPoint: true }],
    items: [{ id: ITEM, groupId: PRODUCT, name: park.id === PARK ? 'ZZ TEST Grip socks' : 'ZZ TEST Other stock', sku: null,
      category: 'ZZ TEST Shop', active: true, productId: PRODUCT, variantId: null, variantLabel: 'Default', unitCostSatang: 123,
      lowStockThreshold: 2, parByLocation: { [PLACE]: 12 }, reorderPoint: null, reorderPointNow: null, reorderQuantity: null,
      leadTimeDays: null, supplierName: null, supplierContact: null, byLocation: { [PLACE]: 7 }, total: 7, status: 'ok',
      itemSku: 'ZZ-TEST-SOCK', productKind: 'merch', units: [], photoUrl: null, showPhotoInPos: false }] }]));
  let members = [person()];
  const wallet: WalletView = { id: WALLET, branchId: PARK, memberId: PERSON, holderName: 'ZZ TEST Wallet holder', status: 'expired',
    balanceSatang: 0, keys: [{ kind: 'band', display: 'ZZTESTBAND' }], createdAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-20T00:00:00Z' };
  const ledger: WalletEntryView[] = [{ id: SECOND, kind: 'expire', source: 'expiry', amountSatang: -12345, balanceAfterSatang: 0,
    saleId: null, refundId: null, branchId: PARK, stationId: null, offline: false, businessDate: '2026-10-20', actorName: null,
    expiresAt: null, at: '2026-10-20T00:00:00Z' }];
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, ''), method = request.method();
    const body = request.postData() ? request.postDataJSON() as Body : undefined, operation = method + ' ' + path;
    calls.push({ method, path, query: url.search, body, key: request.headers()['idempotency-key'] });
    await control.pending.get(operation + url.search); await control.pending.get(operation);
    if (control.refused.has(operation)) return route.fulfill({ status: 409, json: { error: { code: 'ZZ_TEST_REFUSED', message: 'ZZ TEST Keep this operations draft.' } } });
    if (control.uncertainOnce.delete(operation)) return route.abort('failed');
    if (path === '/me') return route.fulfill({ json: { account: { id: control.actor, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false },
      employee: { id: control.actor, name: 'ZZ TEST Operations administrator', nickname: null }, branch: parks[0],
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false, preferences: { theme: 'light', language: 'en' } } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: access.filter(permission => !options.omitted?.includes(permission))
      .map(permission => ({ permission, scopeType: options.branchOnly ? 'branch' : 'operator', scopeId: options.branchOnly ? PARK : OPERATOR })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: parks } });
    if (path === '/tiers') {
      if (control.tiersUnavailable) return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_METADATA', message: 'ZZ TEST Tier metadata unavailable.' } } });
      const tiers = [{ id: 'regular', name: 'ZZ TEST Regular', isDefault: !control.noDefaultTier, requiresVerification: false, sortOrder: 0 },
        { id: 'resident', name: 'ZZ TEST Resident', isDefault: false, requiresVerification: true, sortOrder: 1 }];
      return route.fulfill({ json: { tiers: control.reverseTiers ? tiers.reverse() : tiers } });
    }
    const stock = /^\/branches\/([^/]+)\/stock\/(levels|locations|sellable|items)(?:\/([^/]+))?$/.exec(path);
    if (stock) {
      const branch = stock[1]!, area = stock[2]!, id = stock[3];
      if (area === 'levels') return control.stockReadUnavailable
        ? route.fulfill({ status: 503, json: { error: { code: 'ZZ_TEST_READBACK', message: 'ZZ TEST Stock readback unavailable.' } } })
        : route.fulfill({ json: levels[branch] });
      if (area === 'sellable') return route.fulfill({ json: { branchId: branch, sellPointId: PLACE, products: [] } });
      if (area === 'locations') {
        if (method === 'POST') { locations.push({ id: CREATED, name: String(body!.name), type: String(body!.type), active: true, sellPoint: false });
          if (control.failStockReadAfterWrite) control.stockReadUnavailable = true; }
        if (method === 'PATCH') Object.assign(locations.find(row => row.id === id)!, body);
        return route.fulfill({ json: method === 'GET' ? { locations } : { location: locations.find(row => row.id === (id ?? CREATED)) } });
      }
      if (area === 'items') {
        if (typeof body?.name === 'string') levels[branch]!.items[0]!.name = body.name;
        return route.fulfill({ json: { groupId: PRODUCT, stockItemIds: [ITEM] } });
      }
    }
    if (/^\/branches\/[^/]+\/menu$/.test(path)) {
      if (control.menuUnavailable) return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_METADATA', message: 'ZZ TEST Catalogue metadata unavailable.' } } });
      return route.fulfill({ json: { categories: [], modifierGroups: [], products: [{ id: PRODUCT, kind: 'merch', code: 'ZZ-SOCK', name: 'ZZ TEST Catalogue socks',
        categoryId: null, description: null, priceSatang: 2345, priceWeekendSatang: null, costSatang: 123, prepStationOverride: null,
        taxCategoryOverride: null, translations: null, sku: null, stockItemId: ITEM, sortOrder: 0, active: true, archivedAt: null,
        linkedModifierGroupIds: [], variants: [], stockLinks: [], branchId: PARK }] } });
    }
    if (path === '/members/tier-verifications') return route.fulfill({ json: { verifications: [{ id: SECOND, member: { id: PERSON, nickname: 'ZZ TEST Verified Ada', phone: '+66812340000' },
      fromTier: 'regular', toTier: 'resident', evidenceType: 'Residence permit', evidenceExpiresAt: '2027-01-01', expired: false,
      verifiedBy: 'ZZ TEST Document checker', branch: parks[0]!.name, note: 'ZZ TEST Evidence note', verifiedAt: '2026-10-23T01:02:00Z' }] } });
    if (path === '/members') {
      if (method === 'POST') { const created = person(String(body!.id), String(body!.nickname)); created.phone = String(body!.phone); members.push(created); return route.fulfill({ json: { member: created } }); }
      return route.fulfill({ json: { members: control.actor === ACTOR ? members : [person(SECOND, 'ZZ TEST Current person')] } });
    }
    const member = /^\/members\/([^/]+)$/.exec(path);
    if (member) {
      const row = members.find(item => item.id === member[1]) ?? person(SECOND, 'ZZ TEST Current person');
      if (method === 'PATCH') Object.assign(row, body);
      if (method === 'DELETE') members = members.filter(item => item.id !== member[1]);
      return route.fulfill({ json: method === 'DELETE' ? { ok: true } : { member: row } });
    }
    if (path === '/wallets/lookup') return route.fulfill({ json: { wallet, ledger } });
    if (path === '/wallets/' + WALLET + '/reactivate') {
      wallet.status = 'active'; wallet.balanceSatang = 12345; wallet.expiresAt = null;
      return route.fulfill({ json: { wallet, ledger, replayed: false } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_OUTSIDE', message: 'ZZ TEST Outside this operations fixture.' } } });
  });
  return { calls, control, levels, locations, runtimeErrors, alerts };
}
const writes = (state: Awaited<ReturnType<typeof fixture>>) => state.calls.filter(call => call.method !== 'GET');
const selectPark = (page: Page) => page.getByRole('combobox', { name: 'Park', exact: true });

test('the four native operations pages, their aliases and phone controls open without the POS runtime', async ({ page }) => {
  const state = await fixture(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/catalogue/inventory'); await expect(page.getByText('ZZ TEST Grip socks', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Locations/ }).click();
    await expect(page.getByText('ZZ TEST Front counter', { exact: true })).toBeVisible();
    await expect(page.getByText('ZZ TEST Retired store', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.goto('/members'); await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('Nickname', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').locator('input[type=tel]')).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel('Full name', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.goto('/tier-verifications'); await expect(page.getByText('ZZ TEST Verified Ada', { exact: true }).filter({ visible: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.goto('/reports/wallets'); await page.getByRole('textbox', { name: 'Wallet key', exact: true }).fill('ZZTESTBAND');
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    await expect(page.getByText('ZZ TEST Wallet holder', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reactivate ฿123.45', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  expect(state.calls.some(call => call.path.endsWith('/stock/locations') && call.query === '?all=true')).toBe(true);
  expect(writes(state)).toEqual([]); expect(state.runtimeErrors).toEqual([]);
});

test('Inventory keeps native item metadata, exact satang and size identity through a refusal and retry', async ({ page }) => {
  const state = await fixture(page), path = `/branches/${PARK}/stock/items/${PRODUCT}`;
  state.control.refused.add('PUT ' + path);
  await page.goto('/catalogue/inventory'); await page.getByRole('button', { name: 'Edit ZZ TEST Grip socks', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.locator('#inv-linkedid')).toHaveValue(PRODUCT);
  await expect(dialog.locator('#inv-linkedid').getByRole('option', { name: /ZZ TEST Catalogue socks/ })).toHaveCount(1);
  await dialog.getByLabel('Display name *', { exact: true }).fill('ZZ TEST Retained socks'); await dialog.locator('#inv-unitcost').fill('2.34');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.alerts.length).toBe(1); await expect(dialog.getByLabel('Display name *', { exact: true })).toHaveValue('ZZ TEST Retained socks');
  expect(writes(state)[0]!.body).toMatchObject({ name: 'ZZ TEST Retained socks', productId: PRODUCT, unitCostSatang: 234,
    sizes: [{ stockItemId: ITEM, label: 'Default', variantId: null, parByLocation: { [PLACE]: 12 } }] });
  expect((writes(state)[0]!.body!.sizes as Body[])[0]).not.toHaveProperty('startingStock');
  state.control.refused.delete('PUT ' + path); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText('ZZ TEST Retained socks', { exact: true })).toBeVisible();
  expect(writes(state).map(call => call.path)).toEqual([path, path]); expect(writes(state).every(call => !!call.key)).toBe(true);
});

test('native stock places create, rename and retire through their own park routes', async ({ page }) => {
  const state = await fixture(page); await page.goto('/catalogue/inventory'); await page.getByRole('button', { name: /^Locations/ }).click();
  await page.getByRole('button', { name: 'New location', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Location name *', { exact: true }).fill('ZZ TEST New store');
  await page.getByRole('dialog').getByLabel('Type *', { exact: true }).selectOption('back_of_house');
  await page.getByRole('button', { name: 'Create location', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit ZZ TEST New store', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Location name *', { exact: true }).fill('ZZ TEST Renamed store');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.getByText('ZZ TEST Renamed store', { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  await row.getByRole('button', { name: 'Active', exact: true }).click(); await expect(row.getByRole('button', { name: 'Retired', exact: true })).toBeVisible();
  expect(writes(state).map(call => ({ method: call.method, path: call.path, body: call.body }))).toEqual([
    { method: 'POST', path: `/branches/${PARK}/stock/locations`, body: { name: 'ZZ TEST New store', type: 'back_of_house' } },
    { method: 'PATCH', path: `/branches/${PARK}/stock/locations/${CREATED}`, body: { name: 'ZZ TEST Renamed store', type: 'back_of_house' } },
    { method: 'PATCH', path: `/branches/${PARK}/stock/locations/${CREATED}`, body: { active: false } },
  ]);
});

test('Members creates a native phone profile, patches only entered details and retains an edit refused by the server', async ({ page }) => {
  const state = await fixture(page); await page.goto('/catalogue/members'); await page.getByRole('button', { name: 'Add member', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Nickname', { exact: true }).fill('ZZ TEST New member');
  await dialog.locator('input[type=tel]').fill('812340001'); await dialog.getByLabel('Full name', { exact: true }).fill('ZZ TEST Full member');
  await dialog.getByRole('button', { name: 'Add member', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const createdId = writes(state)[0]!.body!.id;
  expect(writes(state).map(call => ({ method: call.method, path: call.path, body: call.body }))).toEqual([
    { method: 'POST', path: '/members', body: { id: expect.stringMatching(/^[a-f0-9-]{36}$/i), nickname: 'ZZ TEST New member', phone: '+66812340001' } },
    { method: 'PATCH', path: '/members/' + String(createdId), body: { name: 'ZZ TEST Full member' } },
  ]);
  state.control.refused.add('PATCH /members/' + PERSON);
  await page.getByRole('button', { name: 'Edit ZZ TEST Ada', exact: true }).filter({ visible: true }).click();
  await dialog.getByLabel('Notes', { exact: true }).fill('ZZ TEST Retain this note'); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog.getByText('Not saved — ZZ TEST Keep this operations draft.', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Notes', { exact: true })).toHaveValue('ZZ TEST Retain this note');
  state.control.refused.delete('PATCH /members/' + PERSON); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(writes(state).slice(2).map(call => call.body)).toEqual([{ notes: 'ZZ TEST Retain this note' }, { notes: 'ZZ TEST Retain this note' }]);
});

test('Wallet reactivation keeps one native action key on uncertain retry and sends the trimmed reason', async ({ page }) => {
  const state = await fixture(page), path = '/wallets/' + WALLET + '/reactivate'; state.control.uncertainOnce.add('POST ' + path);
  await page.goto('/wallets'); await page.getByRole('textbox', { name: 'Wallet key', exact: true }).fill('ZZTESTBAND');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await page.getByRole('button', { name: 'Reactivate ฿123.45', exact: true }).click(); await expect(page.getByText('Type why this credit is coming back.', { exact: true })).toBeVisible(); expect(writes(state)).toEqual([]);
  await page.getByRole('textbox', { name: 'Reason for reactivating', exact: true }).fill('  ZZ TEST Verified return  ');
  await page.getByRole('button', { name: 'Reactivate ฿123.45', exact: true }).click(); await expect(page.getByText("Couldn't reactivate", { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate ฿123.45', exact: true }).click(); await expect(page.getByText('Credit reactivated', { exact: true })).toBeVisible();
  const attempts = writes(state); expect(attempts).toHaveLength(2); expect(attempts.map(call => call.body)).toEqual([{ reason: 'ZZ TEST Verified return' }, { reason: 'ZZ TEST Verified return' }]);
  expect(attempts[0]!.key).toMatch(/^[a-f0-9-]{36}$/i); expect(attempts[1]!.key).toBe(attempts[0]!.key);
});

test('unavailable catalogue and tier metadata stay truthful and do not invent fallback configuration', async ({ page }) => {
  const state = await fixture(page); state.control.menuUnavailable = true;
  await page.goto('/inventory'); await expect(page.getByText(/Catalogue choices could not be read/)).toBeVisible();
  await expect(page.getByText('ZZ TEST Grip socks', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'New item', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Grip socks', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /^Locations/ }).click(); await expect(page.getByRole('button', { name: 'New location', exact: true })).toBeEnabled();
  state.control.tiersUnavailable = true; await page.goto('/members');
  await expect(page.getByRole('alert').getByText(/Member tier configuration could not be read/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
  await page.goto('/tier-verifications'); await expect(page.getByText(/Tier names could not be read/)).toBeVisible();
  await expect(page.getByText('ZZ TEST Verified Ada', { exact: true }).filter({ visible: true })).toBeVisible(); expect(writes(state)).toEqual([]);
});

test('a readable tier list without a default keeps the native first-by-sort-order fallback', async ({ page }) => {
  const state = await fixture(page); state.control.noDefaultTier = true; state.control.reverseTiers = true;
  await page.goto('/members'); await page.getByRole('button', { name: 'Add member', exact: true }).click();
  const tier = page.getByRole('dialog').getByRole('combobox', { name: 'Tier', exact: true });
  await expect(tier).toContainText('ZZ TEST Regular'); await tier.click();
  await expect(page.getByRole('option', { name: 'ZZ TEST Regular (no proof)', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'ZZ TEST Resident', exact: true })).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(2); expect(writes(state)).toEqual([]);
});

test('Add and cancel invalidate an older member edit without leaving its spinner or opening its late dialog', async ({ page }) => {
  const state = await fixture(page), pending = hold(); state.control.pending.set('GET /members/' + PERSON, pending.promise);
  await page.goto('/members'); const edit = page.getByRole('button', { name: 'Edit ZZ TEST Ada', exact: true }).filter({ visible: true });
  await edit.click(); await expect.poll(() => state.calls.filter(call => call.path === '/members/' + PERSON).length).toBe(1);
  await expect(edit).toBeDisabled(); await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Nickname', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(edit).toBeEnabled();
  const response = page.waitForResponse(answer => answer.request().method() === 'GET' && new URL(answer.url()).pathname === '/api/members/' + PERSON);
  pending.release(); await (await response).finished(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(edit).toBeEnabled();
  await edit.click(); await expect(page.getByRole('dialog').getByLabel('Nickname', { exact: true })).toHaveValue('ZZ TEST Ada');
  expect(state.calls.filter(call => call.path === '/members/' + PERSON)).toHaveLength(2); expect(writes(state)).toEqual([]);
});

test('a confirmed stock write with a failed readback stays visibly saved and Refresh does not repeat it', async ({ page }) => {
  const state = await fixture(page); state.control.failStockReadAfterWrite = true;
  await page.goto('/inventory'); await page.getByRole('button', { name: /^Locations/ }).click();
  await page.getByRole('button', { name: 'New location', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Location name *', { exact: true }).fill('ZZ TEST Confirmed store');
  await page.getByRole('button', { name: 'Create location', exact: true }).click();
  await expect(page.getByRole('alert').getByText(/Saved, but stock could not be read back/)).toBeVisible();
  expect(state.alerts).toEqual([]); expect(writes(state)).toHaveLength(1);
  state.control.stockReadUnavailable = false; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('ZZ TEST Grip socks', { exact: true })).toBeVisible(); expect(writes(state)).toHaveLength(1);
});

test('editing a wallet key masks its old holder immediately and rejects the late reactivation display', async ({ page }) => {
  const state = await fixture(page), pending = hold(), path = '/wallets/' + WALLET + '/reactivate';
  state.control.pending.set('POST ' + path, pending.promise);
  await page.goto('/wallets'); await page.getByRole('textbox', { name: 'Wallet key', exact: true }).fill('ZZTESTBAND');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reason for reactivating', exact: true }).fill('ZZ TEST Owner confirmed');
  await page.getByRole('button', { name: 'Reactivate ฿123.45', exact: true }).click(); await expect.poll(() => writes(state).length).toBe(1);
  await page.getByRole('textbox', { name: 'Wallet key', exact: true }).fill('ZZTESTDIFFERENT');
  await expect(page.getByText('ZZ TEST Wallet holder', { exact: true })).toHaveCount(0);
  const response = page.waitForResponse(answer => answer.request().method() === 'POST' && new URL(answer.url()).pathname === '/api' + path);
  pending.release(); await (await response).finished();
  await expect(page.getByText('ZZ TEST Wallet holder', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Credit reactivated', { exact: true })).toHaveCount(0); expect(writes(state)).toHaveLength(1);
});

test('changing park masks old Inventory immediately and a late old-actor create cannot dispatch its profile PATCH', async ({ page }) => {
  const state = await fixture(page), stockRead = hold(); state.control.pending.set(`GET /branches/${OTHER}/stock/levels`, stockRead.promise);
  await page.goto('/inventory'); await expect(page.getByText('ZZ TEST Grip socks', { exact: true })).toBeVisible();
  await selectPark(page).selectOption(OTHER); await expect(page.getByText('ZZ TEST Grip socks', { exact: true })).toHaveCount(0);
  stockRead.release(); await expect(page.getByText('ZZ TEST Other stock', { exact: true })).toBeVisible();
  const create = hold(); state.control.pending.set('POST /members', create.promise);
  await page.goto('/members'); await page.getByRole('button', { name: 'Add member', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Nickname', { exact: true }).fill('ZZ TEST Old actor draft');
  await dialog.locator('input[type=tel]').fill('812340002'); await dialog.getByLabel('Full name', { exact: true }).fill('ZZ TEST Must not be patched');
  await dialog.getByRole('button', { name: 'Add member', exact: true }).click(); await expect.poll(() => writes(state).filter(call => call.path === '/members').length).toBe(1);
  state.control.actor = SECOND; await page.evaluate(() => window.dispatchEvent(new Event('oto:session-locked')));
  await expect(page.getByText('ZZ TEST Current person', { exact: true }).filter({ visible: true })).toBeVisible();
  const response = page.waitForResponse(answer => answer.request().method() === 'POST' && new URL(answer.url()).pathname === '/api/members');
  create.release(); await (await response).finished(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes(state).filter(call => call.method === 'PATCH')).toEqual([]); expect(state.runtimeErrors).toEqual([]);
});

test('page guards keep their inherited grants and branch stock readers receive no sibling park choice', async ({ page }) => {
  const state = await fixture(page, { branchOnly: true, omitted: ['pos:wallet:read', 'pos:member:update'] });
  await page.goto('/inventory'); await expect(page.getByText('ZZ TEST Grip socks', { exact: true })).toBeVisible();
  await expect(selectPark(page).getByRole('option')).toHaveCount(1); await expect(selectPark(page)).toHaveValue(PARK);
  await page.goto('/wallets'); await expect(page.getByText('pos:wallet:read', { exact: true })).toBeVisible();
  await page.goto('/members'); await expect(page.getByText('pos:member:update', { exact: true })).toBeVisible();
  expect(state.calls.some(call => call.path.startsWith('/wallets') || call.path === '/members')).toBe(false); expect(writes(state)).toEqual([]);
});
