import { expect, test, type Download, type Page } from '@playwright/test';
import type { ApiResponse } from '@oto/api-types';

const PARK = '01950000-0000-7000-8000-000000000001', OTHER = '01950000-0000-7000-8000-000000000002';
const OPERATOR = '01950000-0000-7000-8000-000000000003', ACTOR = '01950000-0000-7000-8000-000000000004';
const SECOND_ACTOR = '01950000-0000-7000-8000-000000000005', RECORD = '01950000-0000-7000-8000-000000000006';
const access = ['app:console:access', 'analytics:read', 'admin:branch:read', 'catalog:menu:read'];
const hold = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
const itemName = (branch: string, actor: string) => `ZZ TEST ${actor === ACTOR ? 'original' : 'current'} ${branch === OTHER ? 'other' : 'own'} item`;

async function fixture(page: Page, options: {
  branchOnly?: boolean; analytics?: boolean; metadata?: boolean;
  directory?: 'sibling-only' | 'absent';
  clock?: { today: string; businessDayStart: string };
} = {}) {
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

  const calls: Array<{ method: string; path: string; query: string; actor: string; app?: string }> = [];
  const runtimeErrors: string[] = [];
  const control = {
    actorId: ACTOR, radar: false, empty: false, longNames: false,
    refused: new Set<string>(),
    holds: [] as Array<{ path: string; branch?: string; actor?: string; limit?: string; promise: Promise<void> }>,
  };
  const parks = [PARK, OTHER].map((id, index) => ({ id, name: index ? 'ZZ TEST Other report park' : 'ZZ TEST Report park', code: 'zz-report-' + index, timezone: 'Asia/Bangkok', businessDayStart: options.clock?.businessDayStart ?? '05:00:00', country: 'TH', archived: false, address: null, openingHours: null }));
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.slice(4).replace(/\/$/, ''), method = request.method(), actor = control.actorId;
    calls.push({ method, path, query: url.search, actor, ...(path === '/auth/handoff' ? { app: request.postDataJSON()?.app as string } : {}) });
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext(actor, OPERATOR, (options.directory ? { id: PARK, name: parks[0]!.name, code: parks[0]!.code, timezone: parks[0]!.timezone } : parks[0])?.id ?? null), account: { id: actor, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false }, employee: { id: actor, name: 'ZZ TEST Report reader', nickname: null }, branch: options.directory ? { id: PARK, name: parks[0]!.name, code: parks[0]!.code, timezone: parks[0]!.timezone } : parks[0], isPlatformAdmin: false, photoFileId: null, sessionLocked: false, preferences: { theme: 'light', language: 'en' } } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [...access.filter(permission => (options.analytics !== false || permission !== 'analytics:read') && (options.metadata !== false || permission !== 'catalog:menu:read') && !(options.directory === 'absent' && permission === 'admin:branch:read')), ...(control.radar ? ['app:radar:access'] : [])].map(permission => ({ permission, scopeType: options.branchOnly || options.directory && ['analytics:read', 'admin:branch:read'].includes(permission) ? 'branch' : 'operator', scopeId: options.directory === 'sibling-only' && permission === 'admin:branch:read' ? OTHER : options.branchOnly || options.directory && permission === 'analytics:read' ? PARK : OPERATOR })) } });
    if (path === '/auth/sign-in' && method === 'POST') { fixtureSessionActor = null; return route.fulfill({ json: { accountId: actor, mustChangePassword: false } }); }
    if (path === '/auth/handoff' && method === 'POST') return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_REFUSED', message: 'ZZ TEST Radar refused.' } } });
    if (path === '/branches') return options.directory
      ? route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST Branch directory is not readable at this seat.' } } })
      : route.fulfill({ json: { branches: parks } });
    if (path === '/menu/discounts') return route.fulfill({ json: { discounts: [{ id: RECORD, operatorId: OPERATOR, branchId: null, code: 'ZZTESTREPORT', label: 'ZZ TEST lifetime promo', kind: 'percent', valueBp: 1000, valueSatang: null, freeProductId: null, target: null, validFrom: null, validUntil: null, usageLimit: 20, perCustomerLimit: null, usedCount: 7, stackable: false, active: true, archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }] } });
    const branch = url.searchParams.get('branches')?.split(',')[0] ?? url.searchParams.get('branchId') ?? PARK;
    const from = url.searchParams.get('from') ?? '2026-10-01', to = url.searchParams.get('to') ?? '2026-10-23';
    const scope = { from, to, branches: [{ branchId: branch, name: parks.find(park => park.id === branch)?.name ?? parks[0]!.name }], omitted: [] };
    if (path === '/analytics/summary') {
      const visible = options.branchOnly || options.directory ? parks.slice(0, 1) : parks;
      const summary = {
        from, to, group: 'total', source: 'oto_pos', omitted: [], merged: [], hours: null, lastRolledUpAt: null,
        branches: visible.map(park => ({ branchId: park.id, name: park.name, source: 'oto_pos', timezone: park.timezone, businessDayStart: park.businessDayStart, today: options.clock?.today ?? '2026-10-23', lastRolledUpAt: null, rows: [] })),
        readable: visible.map(park => ({ branchId: park.id, name: park.name })),
        mergeable: visible.map(park => ({ branchId: park.id, name: park.name })),
      } satisfies ApiResponse<'/analytics/summary', 'get'>;
      return route.fulfill({ json: summary });
    }
    const name = itemName(branch, actor) + (control.longNames ? ' very long approved catalogue name'.repeat(8) : '');
    const rows = <T,>(values: T[]) => control.empty ? [] : values;
    let answer: unknown;
    if (path === '/analytics/reports/sales') answer = { ...scope,
      categories: rows([{ category: 'fnb', grossRevenueSatang: 12345, taxCollectedSatang: 789, serviceChargeSatang: 100, count: 2, pctShare: 100 }]), payments: [], tiers: [], ticketTypes: [], weekdayWeekend: [], dropOffNanny: [],
      fnbItems: rows([{ itemId: RECORD, name, qty: 2, revenueSatang: 12345 }]), merchItems: [] };
    if (path === '/analytics/reports/profitability') answer = { ...scope, fnb: rows([{ itemId: RECORD, name, qty: 2, revenueSatang: 12345, cogsSatang: 4567, marginSatang: 7778, marginPercent: 63.005, costTracked: true }]), merch: [] };
    if (path === '/analytics/reports/discounts') answer = { ...scope, compSatang: 120, manualDiscountSatang: 234, promoSatang: 345, freeItemBenefitSatang: 0,
      promoByType: rows([{ type: 'percent', count: 1, amountSatang: 345 }]), byOperator: rows([{ appliedBy: 'ZZ TEST Report manager', compCount: 1, compTotalSatang: 120, discountCount: 1, discountTotalSatang: 234 }]) };
    if (path === '/analytics/reports/discounts/transactions') answer = { ...scope,
      rows: rows([{ source: 'fnb', transactionId: branch === OTHER ? 'zz-other-transaction' : 'zz-own-transaction', createdAt: '2026-10-23T08:00:00.000Z', operatorName: 'ZZ TEST Report manager', type: 'amount', reason: branch === OTHER ? 'ZZ TEST Other reason' : 'ZZ TEST Original reason', note: null, amountSatang: 234, appliedBy: 'ZZ TEST Report manager' }]),
      promoRows: rows([{ transactionId: 'zz-promo-transaction', createdAt: '2026-10-23T08:00:00.000Z', operatorName: 'ZZ TEST Report manager', code: 'ZZTESTREPORT', label: 'ZZ TEST lifetime promo', type: 'percent', amountSatang: 345 }]) };
    if (path === '/analytics/reports/tax/vat') answer = { ...scope, period: url.searchParams.get('period') ?? 'range', rows: rows([{ category: 'fnb', period: url.searchParams.get('period') === 'day' ? '2026-10-23' : null, netBaseSatang: 11000, serviceChargeSatang: 100, exclusiveTaxSatang: 789, inclusiveTaxSatang: 0, grossSatang: 11889 }]) };
    if (path === '/analytics/reports/tax/receipts') answer = { ...scope, rows: rows([
      { kind: 'fnb', transactionId: 'zz-receipt-fnb', createdAt: '2026-10-23T08:00:00.000Z', branchId: branch, branchName: scope.branches[0]!.name, operatorName: '=ZZ TEST formula-like name', netSubtotalSatang: 11000, serviceChargeSatang: 100, taxTotalSatang: 789, grandTotalSatang: 11889, taxSummaryLabel: 'ZZ TEST VAT', categories: ['fnb'], paymentMethod: 'cash' },
      { kind: 'merch', transactionId: 'zz-receipt-merch', createdAt: '2026-10-23T09:00:00.000Z', branchId: branch, branchName: scope.branches[0]!.name, operatorName: 'ZZ TEST Other cashier', netSubtotalSatang: 20000, serviceChargeSatang: 0, taxTotalSatang: 1400, grandTotalSatang: 21400, taxSummaryLabel: 'ZZ TEST VAT', categories: ['merch'], paymentMethod: 'card' },
    ]) };
    if (path === '/wallets/report') answer = { summary: { grantedSatang: 12345, spentSatang: 2345, refundedSatang: 0, expiredSatang: 0, reactivatedSatang: 0, outstandingSatang: 10000, ledgerOutstandingSatang: 10000, entryCount: control.empty ? 0 : 1 }, rows: rows([{ entryId: RECORD, walletId: RECORD, keyDisplay: 'ZZ TEST BAND', holderName: 'ZZ TEST Wallet holder', kind: 'grant', source: 'ticket_sale', amountSatang: 12345, businessDate: '2026-10-23', at: '2026-10-23T08:00:00.000Z', by: 'ZZ TEST Report manager' }]) };
    if (path === '/vouchers/promotions/report') answer = { range: { from, to }, summary: { redemptions: 1, foregoneSatang: 456, creditLoadedSatang: 0 }, rows: rows([{ definitionId: RECORD, definitionCode: 'ZZTESTVOUCHER', nameEn: 'ZZ TEST report voucher', kind: 'amount_off', redemptions: 1, foregoneSatang: 456, creditLoadedSatang: 0 }]) };
    if (path === '/analytics/booths') answer = { ...scope, booths: [], prizes: [], staff: [], days: [], lastRolledUpAt: null };
    if (answer !== undefined) {
      // Freeze data at dispatch so a late actor/park reply really is the obsolete answer.
      const frozen = JSON.parse(JSON.stringify(answer));
      for (const held of control.holds) if (held.path === path && (!held.branch || held.branch === branch) && (!held.actor || held.actor === actor) && (!held.limit || held.limit === url.searchParams.get('limit'))) await held.promise;
      if (control.refused.has(path)) return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_REFUSED', message: 'ZZ TEST report refused.' } } });
      return route.fulfill({ json: frozen });
    }
    if (['/ready', '/ops/health'].includes(path)) return route.fulfill({ json: { ok: true } });
    if (path === '/ops/failures') return route.fulfill({ json: { failures: [], total: 0 } });
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_OUTSIDE', message: 'ZZ TEST Outside this reports fixture.' } } });
  });
  page.on('pageerror', error => runtimeErrors.push(error.name));
  return { calls, control, parks, runtimeErrors };
}

const card = (page: Page, name: string | RegExp) => page.getByRole('heading', { name, level: 3 }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
async function select(page: Page, label: string, option: string) {
  const exactLabel = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
  await page.locator('label').filter({ hasText: exactLabel }).locator('..').getByRole('combobox').click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function csv(download: Download) {
  const stream = await download.createReadStream(); expect(stream).not.toBeNull();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('the five native reports and old Booth report address render canonical read-only answers', async ({ page }) => {
  const state = await fixture(page);
  for (const [path, marker] of [['sales', 'Top F&B items'], ['profitability', /Revenue .*COGS/], ['discounts', 'Promo impact by type'], ['tax-vat', /VAT summary/], ['wallet-promo', /Wallet ledger/]] as const) {
    await page.goto('/reports/' + path); await expect(page.getByRole('heading', { name: marker, level: 3 }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export CSV', exact: true }).first()).toBeEnabled();
  }
  await page.goto('/booth-report'); await expect(page.getByRole('heading', { name: 'Booth report', level: 1, exact: true })).toBeVisible();
  await expect.poll(() => state.calls.filter(call => call.path === '/analytics/booths').length).toBeGreaterThan(0);
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]); expect(state.runtimeErrors).toEqual([]);
});

test('native Sales CSV keeps integer-satang figures and its current business-date filename', async ({ page }) => {
  await fixture(page); await page.goto('/reports/sales');
  await page.locator('input[type=date]').nth(0).fill('2026-10-01'); await page.locator('input[type=date]').nth(1).fill('2026-10-23');
  const category = card(page, /^Revenue by category/); await expect(category.getByRole('cell', { name: '฿123.45', exact: true })).toBeVisible();
  const pending = page.waitForEvent('download'); await category.getByRole('button', { name: 'Export CSV', exact: true }).click(); const file = await pending;
  expect(file.suggestedFilename()).toBe('sales-by-category_2026-10-01_2026-10-23.csv');
  expect(await csv(file)).toContain('F&B,123.45,100.0,7.89,1.00,2');
});

test('pending new-park Sales hides old rows and disables the relabelled export until its own answer arrives', async ({ page }) => {
  const state = await fixture(page); await page.goto('/reports/sales'); await expect(page.getByText(itemName(PARK, ACTOR), { exact: true })).toBeVisible();
  const held = hold(); state.control.holds.push({ path: '/analytics/reports/sales', branch: OTHER, promise: held.promise });
  await select(page, 'Branch', 'ZZ TEST Other report park');
  await expect.poll(() => state.calls.filter(call => call.path === '/analytics/reports/sales' && new URLSearchParams(call.query).get('branches') === OTHER).length).toBe(1);
  await expect(page.getByText(itemName(PARK, ACTOR), { exact: true })).toHaveCount(0);
  await expect(card(page, /^Revenue by category/).getByRole('button', { name: 'Export CSV', exact: true })).toBeDisabled();
  const response = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/analytics/reports/sales'); held.release(); await (await response).finished();
  await expect(page.getByText(itemName(OTHER, ACTOR), { exact: true })).toBeVisible();
  await expect(card(page, /^Revenue by category/).getByRole('button', { name: 'Export CSV', exact: true })).toBeEnabled();
});

test('late Sales data from a previous signed-in actor cannot reappear under the next actor', async ({ page }) => {
  const state = await fixture(page), held = hold(); state.control.holds.push({ path: '/analytics/reports/sales', actor: ACTOR, promise: held.promise });
  await page.goto('/reports/sales'); await expect.poll(() => state.calls.filter(call => call.path === '/analytics/reports/sales').length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('oto:unauthorized'))); await expect(page.locator('input[type=password]')).toBeVisible();
  state.control.actorId = SECOND_ACTOR;
  await page.locator('input[type=tel]').fill('+66999625001'); await page.locator('input[type=password]').fill('ZZ TEST synthetic password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(itemName(PARK, SECOND_ACTOR), { exact: true })).toBeVisible();
  const response = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/analytics/reports/sales'); held.release(); await (await response).finished();
  await expect(page.getByText(itemName(PARK, ACTOR), { exact: true })).toHaveCount(0); await expect(page.getByText(itemName(PARK, SECOND_ACTOR), { exact: true })).toBeVisible();
});

test('Tax grouping and native category/payment narrowing export only matching receipts with formula-safe names', async ({ page }) => {
  const state = await fixture(page); await page.goto('/reports/tax-vat');
  await expect(page.getByRole('cell', { name: 'fnb/zz-receipt-fnb', exact: true })).toBeVisible();
  await select(page, 'Group by', 'Day'); await expect.poll(() => state.calls.some(call => call.path === '/analytics/reports/tax/vat' && new URLSearchParams(call.query).get('period') === 'day')).toBe(true);
  await select(page, 'Category', 'F&B'); await select(page, 'Payment', 'cash');
  await expect(page.getByRole('cell', { name: 'merch/zz-receipt-merch', exact: true })).toHaveCount(0);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export all receipts', exact: true }).click(); const text = await csv(await pending);
  expect(text).toContain('zz-receipt-fnb'); expect(text).not.toContain('zz-receipt-merch'); expect(text).toContain("'=ZZ TEST formula-like name"); expect(text).toContain('110.00,1.00,7.89,118.89');
});

test('Discounts does not mix old transaction rows with a new summary and shows the real refused-read error', async ({ page }) => {
  const state = await fixture(page); await page.goto('/reports/discounts'); await expect(page.getByText('ZZ TEST Original reason', { exact: true })).toBeVisible();
  const held = hold(); state.control.holds.push({ path: '/analytics/reports/discounts/transactions', branch: OTHER, promise: held.promise });
  state.control.refused.add('/analytics/reports/discounts/transactions'); await select(page, 'Branch', 'ZZ TEST Other report park');
  await expect(page.getByText('ZZ TEST Original reason', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Export CSV', exact: true }).first()).toBeDisabled();
  const response = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/analytics/reports/discounts/transactions'); held.release(); await (await response).finished();
  await expect(page.getByText(/The figures could not be loaded from the platform/)).toContainText('ZZ TEST report refused.');
  await expect(page.getByText('ZZ TEST Original reason', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Export CSV', exact: true }).first()).toBeDisabled();
});

test('Wallet preserves lifetime promo counters, ranged value and separate foregone revenue and exports its full ledger read', async ({ page }) => {
  const state = await fixture(page); await page.goto('/reports/wallet-promo');
  await expect(page.getByRole('cell', { name: 'ZZ TEST BAND', exact: true })).toBeVisible();
  const promo = card(page, 'Promo code usage'); await expect(promo.getByRole('row').filter({ hasText: 'ZZTESTREPORT' })).toContainText('฿3.45');
  await expect(promo.getByRole('row').filter({ hasText: 'ZZTESTREPORT' })).toContainText('7');
  await expect(page.getByText('ZZ TEST report voucher', { exact: true })).toBeVisible();
  const pending = page.waitForEvent('download'); await card(page, /^Wallet ledger/).getByRole('button', { name: 'Export CSV', exact: true }).click(); const text = await csv(await pending);
  expect(text).toContain('ZZ TEST BAND,ZZ TEST Wallet holder,grant,123.45');
  expect(state.calls.some(call => call.path === '/wallets/report' && new URLSearchParams(call.query).get('limit') === '1000')).toBe(true);
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('report permissions refuse direct addresses without data reads and branch readers never gain a sibling option', async ({ page }) => {
  const denied = await fixture(page, { analytics: false }); await page.goto('/reports/sales');
  await expect(page.getByText('analytics:read', { exact: true })).toBeVisible();
  expect(denied.calls.some(call => call.path.startsWith('/analytics/reports/'))).toBe(false);
  const scoped = await page.context().newPage(); const state = await fixture(scoped, { branchOnly: true });
  await scoped.goto('/reports/sales'); await expect(scoped.getByText(itemName(PARK, ACTOR), { exact: true })).toBeVisible();
  await scoped.locator('label').filter({ hasText: /^Branch$/ }).locator('..').getByRole('combobox').click();
  await expect(scoped.getByRole('option', { name: 'ZZ TEST Other report park', exact: true })).toHaveCount(0);
  await expect(scoped.getByRole('option', { name: 'ZZ TEST Report park', exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]); await scoped.close();
});

test('Radar stays gated on the Reports landing and issues its handoff only after an explicit click', async ({ page }) => {
  const state = await fixture(page); await page.goto('/reports'); await expect(page.getByRole('button', { name: 'Open Radar', exact: true })).toHaveCount(0);
  state.control.radar = true; await page.reload(); await expect(page.getByRole('button', { name: 'Open Radar', exact: true })).toBeVisible();
  expect(state.calls.some(call => call.path === '/auth/handoff')).toBe(false);
  await page.getByRole('button', { name: 'Open Radar', exact: true }).click(); await expect(page.getByText('ZZ TEST Radar refused.', { exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.path === '/auth/handoff').map(call => call.app)).toEqual(['radar']);
});

test('native report filters and long-name tables remain bounded on a 390px phone', async ({ page }) => {
  const state = await fixture(page); state.control.longNames = true; await page.setViewportSize({ width: 390, height: 1000 });
  for (const path of ['sales', 'profitability', 'discounts', 'tax-vat', 'wallet-promo']) {
    await page.goto('/reports/' + path); await expect(page.getByRole('button', { name: 'Export CSV', exact: true }).first()).toBeEnabled();
    expect(await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ viewport: 390, document: 390 });
    for (const control of await page.locator('input[type=date]').all()) {
      const bounds = await control.boundingBox(); expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    }
  }
  expect(state.runtimeErrors).toEqual([]);
});

test('analytics at the current park does not inherit a branch-directory requirement held only at another park', async ({ page }) => {
  const state = await fixture(page, { directory: 'sibling-only' });
  await page.goto('/reports/sales');
  await expect(page.getByText(itemName(PARK, ACTOR), { exact: true })).toBeVisible();
  await expect(card(page, /^Revenue by category/).getByRole('button', { name: 'Export CSV', exact: true })).toBeEnabled();
  await select(page, 'Branch', 'All branches');
  await page.locator('label').filter({ hasText: /^Branch$/ }).locator('..').getByRole('combobox').click();
  await expect(page.getByRole('option', { name: 'ZZ TEST Other report park', exact: true })).toHaveCount(0);
  expect(state.calls.some(call => call.path === '/analytics/reports/sales')).toBe(true);
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('an analytics-only reader starts the month on the canonical trading day before a nondefault day start', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-01T00:30:00.000Z'));
  const state = await fixture(page, { directory: 'absent', clock: { today: '2026-10-31', businessDayStart: '08:00:00' } });
  await page.goto('/reports/sales');
  await expect(page.getByText(itemName(PARK, ACTOR), { exact: true })).toBeVisible();
  await expect(page.locator('input[type=date]').nth(0)).toHaveValue('2026-10-01');
  await expect(page.locator('input[type=date]').nth(1)).toHaveValue('2026-10-31');
  const requests = state.calls.filter(call => call.path === '/analytics/reports/sales');
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(call => new URLSearchParams(call.query).get('from') === '2026-10-01' && new URLSearchParams(call.query).get('to') === '2026-10-31')).toBe(true);
  expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
});
