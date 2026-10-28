import { expect, test, type Download, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { signInAndWait } from './console';

const PARK = '01920000-0000-7000-8000-000000000001', OTHER = '01920000-0000-7000-8000-000000000002';
const OPERATOR = '01920000-0000-7000-8000-000000000003', ACTOR = '01920000-0000-7000-8000-000000000004';
const DISCOUNT = '01920000-0000-7000-8000-000000000005', TYPE = '01920000-0000-7000-8000-000000000006';
const OTHER_TYPE = '01920000-0000-7000-8000-000000000007', CAMPAIGN = '01920000-0000-7000-8000-000000000008', OTHER_CAMPAIGN = '01920000-0000-7000-8000-000000000009';
const permissions = ['app:console:access', 'admin:branch:read', 'catalog:menu:read', 'catalog:menu:manage', 'catalog:tax:read', 'catalog:tax:manage', 'pos:event:read', 'admin:event_pricing:manage', 'admin:booth:read', 'admin:booth:manage'];
type Row = Record<string, unknown> & { id: string };
const gate = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
const tax = (percent = 7.25) => ({ rates: [{ id: 'zz-tax', name: 'ZZ TEST Primary tax', percent, defaultMode: 'exclusive' }, { id: 'zz-secondary', name: 'ZZ TEST Secondary tax', percent: 0.5 }], categoryRules: [{ category: 'fnb', taxMode: 'exclusive', taxRateId: 'zz-tax', serviceChargePercent: 2.5, taxOnServiceCharge: true, secondaryTaxRateId: 'zz-secondary', secondaryTaxMode: 'inclusive' }, { category: 'stored_value', taxMode: 'none' }], discountPlacement: 'after_tax' });
const pricing = (first = 12345) => ({ campDay: { weekday: first, weekend: 16789 }, eventDay: { weekday: 23456, weekend: 27890 }, partyGuest: { weekday: 34567, weekend: 38901 } });

async function fixture(page: Page, branchOnly = false) {
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
  const control = { refused: new Set<string>(), pending: new Map<string, Promise<void>>(), failedReads: new Map<string, number>(), uncertainMintOnce: false };
  const parks = [PARK, OTHER].map((id, index) => ({ id, name: index ? 'ZZ TEST Other money park' : 'ZZ TEST Money park', code: 'zz-money-' + index, timezone: 'Asia/Bangkok', country: 'TH', archived: false, openingHours: null, businessDayStart: '05:00:00', address: null }));
  const discounts: Row[] = [{ id: DISCOUNT, branchId: null, code: 'ZZ-623', label: 'ZZ TEST Money discount', kind: 'fixed', valueBp: null, valueSatang: 12345, freeProductId: null, target: { kind: 'everything' }, validFrom: '2027-01-01', validUntil: '2027-12-31', usageLimit: 100, perCustomerLimit: 2, stackable: true, active: true, archivedAt: null, usedCount: 0 }];
  const methods: Row[] = [{ id: 'zz_money', label: 'ZZ TEST Tender', kind: 'other', enabled: true, sortOrder: 0, attempts: 0 }];
  const definition = { code: 'zz-test-623-type', nameEn: 'ZZ TEST Money type', nameTh: 'ZZ TEST Thai display', kind: 'discount', valueType: 'amount', valueSatang: 12345, valueBp: null, productId: null, ticketPackageId: null, expiryDays: null, offlinePolicy: 'refuse', singleUse: true, costSatang: 0, titleEn: 'ZZ TEST Slip title', titleTh: null, instructionEn: 'ZZ TEST Slip instruction', instructionTh: null, termsEn: 'ZZ TEST Slip terms', termsTh: null, active: true, codeMode: 'generated', fixedCode: null, legacyQrPayload: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', archivedAt: null, product: null, ticketPackage: null, usedBy: [], parkProducts: [], unredeemedVouchers: 0, target: null, usageLimit: 100, perCustomerLimit: 2, validFrom: '2027-01-01', validUntil: '2027-12-31', redeemedVouchers: 0 };
  const definitions: Row[] = [{ ...definition, id: TYPE }, { ...definition, id: OTHER_TYPE, code: 'zz-test-623-second', nameEn: 'ZZ TEST Other type' }];
  const campaigns: Row[] = [{ id: CAMPAIGN, name: 'ZZ TEST Own campaign', branchId: PARK, definitionId: TYPE, definitionCode: definition.code, quantity: 2, redeemed: 0, createdAt: '2026-10-22T00:00:00.000Z', createdByAccountId: ACTOR }, { id: OTHER_CAMPAIGN, name: 'ZZ TEST Sibling campaign', branchId: OTHER, definitionId: TYPE, definitionCode: definition.code, quantity: 2, redeemed: 0, createdAt: '2026-10-22T00:00:00.000Z', createdByAccountId: ACTOR }];
  const taxes: Record<string, ReturnType<typeof tax>> = { [PARK]: tax(), [OTHER]: tax(9.75) };
  const prices: Record<string, ReturnType<typeof pricing>> = { [PARK]: pricing(), [OTHER]: pricing(99999) };
  const mintKeys = new Map<string, Row>();
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, ''), method = request.method(), key = request.headers()['idempotency-key'];
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    calls.push({ method, path, body, key });
    if (method === 'GET' && (control.failedReads.get(path) ?? 0) > 0) { control.failedReads.set(path, control.failedReads.get(path)! - 1); return route.fulfill({ status: 500, json: { error: { code: 'ZZ_TEST_READ', message: 'ZZ TEST Readback refused.' } } }); }
    if (method !== 'GET') {
      await control.pending.get(path);
      if (control.refused.has(path)) return route.fulfill({ status: 409, json: { error: { code: 'ZZ_TEST_REFUSED', message: 'ZZ TEST Keep this money draft.' } } });
    }
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext(ACTOR, OPERATOR, (parks[0])?.id ?? null), account: { id: ACTOR, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false }, employee: { id: ACTOR, name: 'ZZ TEST Money administrator', nickname: null }, branch: parks[0], isPlatformAdmin: false, photoFileId: null, sessionLocked: false, preferences: { theme: 'light', language: 'en' } } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: permissions.map(permission => ({ permission, scopeType: branchOnly ? 'branch' : 'operator', scopeId: branchOnly ? PARK : OPERATOR })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: parks } });
    if (path === '/menu/discounts') {
      if (method === 'GET') return route.fulfill({ json: { discounts } });
      if (method === 'POST') { const id = '01920000-0000-7000-8000-00000000000a'; discounts.push({ ...body, id }); return route.fulfill({ json: { id } }); }
    }
    const discount = /^\/menu\/discounts\/([^/]+)$/.exec(path);
    if (discount) { const row = discounts.find(item => item.id === discount[1]); if (method === 'PATCH' && row) { Object.assign(row, body); return route.fulfill({ json: { ok: true } }); } if (method === 'DELETE' && row) { discounts.splice(discounts.indexOf(row), 1); return route.fulfill({ json: { ok: true } }); } }
    if (path === '/payment-methods') {
      if (method === 'GET') return route.fulfill({ json: { methods } });
      if (method === 'POST') { methods.push({ ...body, id: String(body!.code), attempts: 0, enabled: true }); return route.fulfill({ json: { id: body!.code } }); }
    }
    const methodRow = /^\/payment-methods\/([^/]+)(?:\/move)?$/.exec(path);
    if (methodRow) { const row = methods.find(item => item.id === methodRow[1]); if (method === 'PATCH' && row) { Object.assign(row, body); return route.fulfill({ json: { ok: true } }); } if (method === 'DELETE' && row) { methods.splice(methods.indexOf(row), 1); return route.fulfill({ json: { ok: true } }); } if (method === 'POST') return route.fulfill({ json: { ok: true, moved: true } }); }
    const config = /^\/branches\/([^/]+)\/(tax-config|event-drop-in-pricing)$/.exec(path);
    if (config) { const id = config[1]!, isTax = config[2] === 'tax-config'; if (method === 'PUT') { if (isTax) taxes[id] = body as ReturnType<typeof tax>; else prices[id] = body as ReturnType<typeof pricing>; } return route.fulfill({ json: isTax ? method === 'PUT' ? { ok: true } : { config: taxes[id] } : { branchId: id, pricing: prices[id], configured: true, updatedAt: '2026-10-22T01:00:00.000Z' } }); }
    if (/^\/branches\/[^/]+\/menu$/.test(path)) return route.fulfill({ json: { branchId: PARK, categories: [], products: [], modifierGroups: [] } });
    if (path === '/voucher-definitions/link-options') return route.fulfill({ json: { products: [], packages: [] } });
    if (path === '/voucher-definitions') return route.fulfill({ json: { definitions } });
    const type = /^\/voucher-definitions\/([^/]+)$/.exec(path);
    if (type && method === 'PATCH') { const row = definitions.find(item => item.id === type[1])!; Object.assign(row, body); return route.fulfill({ json: { definition: row } }); }
    if (path === '/voucher-campaigns') {
      if (method === 'GET') return route.fulfill({ json: { campaigns } });
      if (method === 'POST') {
        let row = mintKeys.get(key ?? '');
        if (!row) { row = { id: '01920000-0000-7000-8000-' + String(campaigns.length + 1).padStart(12, '0'), name: String(body!.name), branchId: body!.branchId, definitionId: body!.definitionId, definitionCode: definition.code, quantity: body!.quantity, redeemed: 0, createdAt: '2026-10-22T01:00:00.000Z' }; mintKeys.set(key ?? '', row); campaigns.push(row); }
        if (control.uncertainMintOnce) { control.uncertainMintOnce = false; return route.abort('failed'); }
        return route.fulfill({ json: { campaign: row } });
      }
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST Outside this money fixture.' } } });
  });
  return { calls, control, discounts, methods, taxes, prices, definitions, campaigns };
}

test('Money opens six approved native surfaces and keeps the old voucher type address', async ({ page }) => {
  const state = await fixture(page);
  for (const [path, heading] of [['/catalogue/discounts', 'Discount codes'], ['/catalogue/tenders', 'Payment methods'], ['/catalogue/tax', 'Tax'], ['/catalogue/voucher-campaigns', 'Campaigns'], ['/catalogue/event-pricing', 'Walk-up prices'], ['/voucher-types', 'Voucher types']]) {
    await page.goto(path!); await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('branch grants withhold operator edits but retain own-park campaign and settings authority', async ({ page }) => {
  const state = await fixture(page, true);
  await page.goto('/catalogue/discounts'); await expect(page.getByRole('heading', { name: 'Discount codes', exact: true })).toBeVisible();
  for (const button of await page.getByRole('button', { name: 'Add code', exact: true }).all()) await expect(button).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  await page.goto('/catalogue/tenders'); await expect(page.getByRole('heading', { name: 'Payment methods', exact: true })).toBeVisible();
  for (const input of await page.getByPlaceholder('New method (e.g. Bank transfer)').all()) expect(await input.isDisabled() || await input.getAttribute('readonly') !== null).toBe(true);
  await page.goto('/voucher-types'); await expect(page.getByRole('heading', { name: 'Voucher types', exact: true })).toBeVisible();
  for (const button of await page.getByRole('button', { name: 'New voucher type', exact: true }).all()) await expect(button).toBeDisabled();
  await page.goto('/catalogue/voucher-campaigns'); await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rules', exact: true })).toHaveCount(0);
  const own = page.getByRole('row').filter({ has: page.getByText('ZZ TEST Own campaign', { exact: true }) }), sibling = page.getByRole('row').filter({ has: page.getByText('ZZ TEST Sibling campaign', { exact: true }) });
  await expect(own.getByRole('link', { name: 'Codes (CSV)', exact: true })).toBeVisible(); await expect(sibling.getByRole('link', { name: 'Codes (CSV)', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('voucher-campaign-form').getByRole('button', { name: 'Mint codes', exact: true })).toBeVisible();
  await page.goto('/catalogue/tax'); await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await page.goto('/catalogue/event-pricing'); await expect(page.getByRole('heading', { name: 'Walk-up prices', exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('an unresolved free item in another park leaves unrelated discount controls usable', async ({ page }) => {
  const state = await fixture(page);
  state.discounts.push({ ...state.discounts[0], id: '01920000-0000-7000-8000-00000000000b',
    code: 'ZZ-FREE-OTHER', label: 'ZZ TEST Other park free item', kind: 'free_item',
    valueSatang: null, freeProductId: '01920000-0000-7000-8000-00000000000c' });
  await page.goto('/catalogue/discounts');
  await expect(page.getByText('ZZ TEST Other park free item', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add code', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit ZZ-623', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Edit ZZ-FREE-OTHER', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete ZZ-FREE-OTHER', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Edit ZZ-623', exact: true }).click();
  await expect(page.getByLabel('Code', { exact: true })).toHaveValue('ZZ-623');
  expect(state.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

test('a refused discount rename keeps the draft and never creates its replacement before the old-code step succeeds', async ({ page }) => {
  const state = await fixture(page), target = '/menu/discounts/' + DISCOUNT;
  state.control.refused.add(target); await page.goto('/catalogue/discounts');
  const row = page.getByText('ZZ TEST Money discount', { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  await row.getByRole('button', { name: /Edit/ }).click();
  await page.getByLabel('Code', { exact: true }).fill('ZZ-623-RENAMED'); await page.getByLabel('Label', { exact: true }).fill('ZZ TEST Renamed discount');
  await expect(page.getByLabel('Value (฿)', { exact: true })).toHaveValue('123.45');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.getByText('ZZ TEST Keep this money draft.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Code', { exact: true })).toHaveValue('ZZ-623-RENAMED');
  expect(state.calls.filter(call => call.method === 'POST' && call.path === '/menu/discounts')).toHaveLength(0);
  expect(state.discounts.some(discount => discount.id === DISCOUNT)).toBe(true);
});

test('tender add and blur-rename refusals retain native fields until a confirmed retry', async ({ page }) => {
  const state = await fixture(page); state.control.refused.add('/payment-methods'); await page.goto('/catalogue/tenders');
  const newLabel = page.getByPlaceholder('New method (e.g. Bank transfer)'); await newLabel.fill('ZZ TEST Transfer'); await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('ZZ TEST Keep this money draft.', { exact: true })).toBeVisible(); await expect(newLabel).toHaveValue('ZZ TEST Transfer');
  state.control.refused.delete('/payment-methods'); await page.getByRole('button', { name: 'Add', exact: true }).click(); await expect(newLabel).toHaveValue('');
  const target = '/payment-methods/zz_money'; state.control.refused.add(target);
  const label = page.locator('input[value="ZZ TEST Tender"]'); await label.fill('ZZ TEST Refused tender rename'); await page.keyboard.press('Tab');
  await expect(page.getByText('ZZ TEST Keep this money draft.', { exact: true })).toBeVisible(); await expect(page.locator('input[value="ZZ TEST Refused tender rename"]')).toBeVisible();
  expect(state.methods.find(method => method.id === 'zz_money')?.label).toBe('ZZ TEST Tender');
});

test('tax save refusal cannot report Saved and retry preserves fractions plus the hidden stored-value rule', async ({ page }) => {
  const state = await fixture(page), path = '/branches/' + PARK + '/tax-config'; state.control.refused.add(path);
  await page.goto('/catalogue/tax'); await page.locator('#tax-svc-fnb').fill('3.75');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.getByText('ZZ TEST Keep this money draft. Read the current settings before trying again.', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved — live in the till.', { exact: true })).toHaveCount(0); await expect(page.locator('#tax-svc-fnb')).toHaveValue('3.75');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  const beforeRead = state.calls.length;
  await page.getByRole('button', { name: 'Read current settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved tax settings', exact: true })).toBeVisible();
  expect(state.calls.slice(beforeRead).filter(call => call.path === path).map(call => call.method)).toEqual(['GET']);
  await expect(page.locator('#tax-svc-fnb')).toHaveValue('3.75');
  state.control.refused.delete(path); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Saved — live in the till.', { exact: true })).toBeVisible();
  const write = state.calls.filter(call => call.method === 'PUT' && call.path === path).at(-1);
  expect(write?.body).toMatchObject({ rates: tax().rates, categoryRules: [{ ...tax().categoryRules[0], serviceChargePercent: 3.75 }, tax().categoryRules[1]], discountPlacement: 'after_tax' });
});

test('late event save preserves a newer native draft and another park retains its own exact satang', async ({ page }) => {
  const state = await fixture(page), held = gate(), path = '/branches/' + PARK + '/event-drop-in-pricing'; state.control.pending.set(path, held.promise);
  await page.goto('/catalogue/event-pricing'); await expect(page.getByRole('spinbutton').nth(0)).toHaveValue('123.45');
  await page.getByRole('spinbutton').nth(0).fill('234.56'); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.method === 'PUT' && call.path === path).length).toBe(1);
  await page.getByRole('spinbutton').nth(0).fill('456.78');
  const response = page.waitForResponse(answer => answer.request().method() === 'PUT' && answer.url().endsWith(path)); held.release(); await (await response).finished();
  await expect(page.getByRole('spinbutton').nth(0)).toHaveValue('456.78');
  await page.getByRole('combobox', { name: 'Park', exact: true }).selectOption(OTHER); await expect(page.getByRole('spinbutton').nth(0)).toHaveValue('999.99');
  expect(state.calls.filter(call => call.method === 'PUT').map(call => call.path)).toEqual([path]);
});

test('old promotional-rule completion cannot close a different native voucher editor', async ({ page }) => {
  const state = await fixture(page), held = gate(), path = '/voucher-definitions/' + TYPE; state.control.pending.set(path, held.promise);
  await page.goto('/catalogue/voucher-campaigns'); const ownRow = page.getByRole('row').filter({ has: page.getByText('ZZ TEST Money type', { exact: true }) });
  await ownRow.getByRole('button', { name: 'Rules', exact: true }).click(); await page.getByLabel('Usage limit', { exact: true }).fill('123'); await page.getByRole('button', { name: 'Save rules', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.method === 'PATCH' && call.path === path).length).toBe(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('row').filter({ has: page.getByText('ZZ TEST Other type', { exact: true }) }).getByRole('button', { name: 'Rules', exact: true }).click(); await page.getByLabel('Usage limit', { exact: true }).fill('456');
  const response = page.waitForResponse(answer => answer.request().method() === 'PATCH' && answer.url().endsWith(path)); held.release(); await (await response).finished();
  await expect(page.getByTestId('voucher-rules-editor')).toContainText('ZZ TEST Other type'); await expect(page.getByLabel('Usage limit', { exact: true })).toHaveValue('456');
});

test('uncertain campaign retry reuses its key and a late successful mint preserves a newer draft', async ({ page }) => {
  const state = await fixture(page); state.control.uncertainMintOnce = true; await page.goto('/catalogue/voucher-campaigns');
  const form = page.getByTestId('voucher-campaign-form'); await form.getByLabel('Voucher type', { exact: true }).selectOption(TYPE); await form.getByLabel('Park', { exact: true }).selectOption(PARK); await form.getByLabel('Campaign name', { exact: true }).fill('ZZ TEST Retry campaign'); await form.getByLabel('How many codes', { exact: true }).fill('2');
  await form.getByRole('button', { name: 'Mint codes', exact: true }).click(); await expect.poll(() => state.calls.filter(call => call.method === 'POST' && call.path === '/voucher-campaigns').length).toBe(1); await expect(form.getByRole('button', { name: 'Mint codes', exact: true })).toBeEnabled();
  const held = gate(); state.control.pending.set('/voucher-campaigns', held.promise); await form.getByRole('button', { name: 'Mint codes', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.method === 'POST' && call.path === '/voucher-campaigns').length).toBe(2); await form.getByLabel('Campaign name', { exact: true }).fill('ZZ TEST Newer campaign draft');
  const writes = state.calls.filter(call => call.method === 'POST' && call.path === '/voucher-campaigns'); expect(writes[0]?.key).toMatch(/^[a-f0-9-]{36}$/i); expect.soft(writes[1]?.key).toBe(writes[0]?.key); expect.soft(writes[1]?.body).toEqual(writes[0]?.body);
  const response = page.waitForResponse(answer => answer.request().method() === 'POST' && answer.url().endsWith('/voucher-campaigns')); held.release(); await (await response).finished();
  await expect(form.getByLabel('Campaign name', { exact: true })).toHaveValue('ZZ TEST Newer campaign draft');
  expect(state.campaigns.filter(campaign => campaign.name === 'ZZ TEST Retry campaign')).toHaveLength(1);
  await form.getByRole('button', { name: 'Mint codes', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.method === 'POST' && call.path === '/voucher-campaigns').length).toBe(3);
  const changed = state.calls.filter(call => call.method === 'POST' && call.path === '/voucher-campaigns')[2]!;
  expect(changed.key).toMatch(/^[a-f0-9-]{36}$/i); expect(changed.key).not.toBe(writes[0]?.key); expect(changed.body?.name).toBe('ZZ TEST Newer campaign draft');
});

test('the isolated server campaign downloads its real CSV through the native browser link', async ({ page, baseURL }) => {
  // A browser-owned download bypasses both page and context request mocks.
  // This case uses the harness database, which run.mjs creates and drops.
  const origin = new URL(baseURL!);
  expect(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password).toBe(true);
  await signInAndWait(page);
  let file: Download | undefined;
  try {
    const meResponse = await page.request.get('/api/me'), branchesResponse = await page.request.get('/api/branches');
    expect(meResponse.status()).toBe(200); expect(branchesResponse.status()).toBe(200);
    const me = await meResponse.json() as { branch: { id: string } | null };
    const branches = (await branchesResponse.json() as { branches: Array<{ id: string; archived: boolean }> }).branches.filter(branch => !branch.archived);
    const branchId = me.branch?.id ?? branches[0]?.id;
    expect(typeof branchId === 'string' && branches.some(branch => branch.id === branchId)).toBe(true);
    const stamp = randomUUID().slice(0, 8), campaignName = 'ZZ TEST 623 download ' + stamp;
    const definitionResponse = await page.request.post('/api/voucher-definitions', {
      headers: { 'idempotency-key': randomUUID() },
      data: { code: 'zz-test-623-download-' + stamp, nameEn: 'ZZ TEST 623 CSV type ' + stamp, kind: 'discount', valueType: 'amount', valueSatang: 12345, expiryDays: 14, offlinePolicy: 'refuse', active: true, codeMode: 'generated' },
    });
    expect(definitionResponse.status()).toBe(201);
    const definitionId = (await definitionResponse.json() as { definition: { id: string } }).definition.id;
    const campaignResponse = await page.request.post('/api/voucher-campaigns', {
      headers: { 'idempotency-key': randomUUID() }, data: { definitionId, branchId, name: campaignName, quantity: 1 },
    });
    expect(campaignResponse.status()).toBe(200);
    const campaignId = (await campaignResponse.json() as { campaign: { id: string } }).campaign.id;
    const csvPath = '/api/voucher-campaigns/' + campaignId + '/codes';
    const filename = 'voucher-campaign-zz-test-623-download-' + stamp + '.csv';
    await page.goto('/catalogue/voucher-campaigns');
    const link = page.getByRole('row').filter({ has: page.getByText(campaignName, { exact: true }) }).getByRole('link', { name: 'Codes (CSV)', exact: true });
    await expect(link).toHaveAttribute('href', csvPath);
    const download = page.waitForEvent('download'); await link.click(); file = await download;
    expect(new URL(file.url()).pathname).toBe(csvPath); expect(file.suggestedFilename()).toBe(filename);
    expect(await file.failure() === null).toBe(true);
    const response = await page.request.get(csvPath);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');
    expect(response.headers()['content-disposition']).toBe('attachment; filename="' + filename + '"');
    expect(response.headers()['cache-control']).toBe('no-store');
    const path = await file.path(); expect(path !== null).toBe(true);
    const bytes = await readFile(path!), rows = bytes.toString('utf8').trimEnd().split(/\r?\n/);
    // Only public headers, counts, booleans and hashes enter failure output.
    // Issued bearer values remain in memory and the private temporary download.
    expect(rows.length).toBe(2); expect(rows[0] === 'code,status,expires_at').toBe(true);
    const issued = rows[1]!.split(',');
    expect(issued.length).toBe(3); expect(issued[0]!.length > 0 && issued[1] === 'issued' && Number.isFinite(Date.parse(issued[2]!))).toBe(true);
    const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
    expect(digest(bytes)).toBe(digest(await response.body()));
  } finally {
    await file?.delete();
    const signedOut = await page.request.post('/api/auth/sign-out'); expect(signedOut.status()).toBe(200);
  }
});
