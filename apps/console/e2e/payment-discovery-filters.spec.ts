import { expect, test, type Page } from '@playwright/test';
import type { ConfigurationEntry } from '../src/api/consoleConfiguration';

const OPERATOR = '01968300-0000-7000-8000-000000000001';
const ACTOR = '01968300-0000-7000-8000-000000000002';
const SESSION = '01968300-0000-7000-8000-000000000003';
const PARK = '01968300-0000-7000-8000-000000000004';
const OTHER = '01968300-0000-7000-8000-000000000005';
const SALE = '01968300-0000-7000-8000-000000000006';
const permissions = ['app:console:access', 'admin:branch:read', 'catalog:menu:read', 'catalog:menu:manage',
  'catalog:tax:manage', 'console:config:read', 'console:money:read', 'console:money:investigate',
  'admin:station:read', 'admin:health:read', 'console:support:lookup'];
const entry = (key: string, label: string, over: Partial<ConfigurationEntry> = {}): ConfigurationEntry => ({
  id: key, key, label, appOwner: 'platform', editableHere: true, requiredPermission: 'catalog:menu:manage',
  scope: 'operator', branchIds: [], supported: true, url: '/catalogue/tenders', openInApp: null,
  lastChangedAt: null, lastChangedAvailability: 'unsupported', ...over,
});
const entries = [entry('tenders', 'Accepted tenders'), entry('tax', 'Park tax', { scope: 'branch', branchIds: [PARK, OTHER], url: '/catalogue/tax' }),
  entry('templates', 'Message templates', { appOwner: 'inbox', editableHere: false, url: null, openInApp: { app: 'inbox', path: '/?settings=templates' } }),
  entry('unknown', 'ZZ TEST Unknown setting', { supported: false, url: null }),
  entry('unsafe', 'ZZ TEST Unsupported address', { url: '//invalid.example/settings' })];

const scope = { from: '2026-10-01', to: '2026-10-04', branches: [{ branchId: PARK, name: 'ZZ TEST Money park' }], omitted: [] };
const day = {
  businessDate: '2026-10-01', provisional: false, rolledDays: 1, computedAt: null, revenueSatang: 123_400, ticketsSatang: 100_000,
  fnbSatang: 23_400, merchSatang: 0, partiesSatang: 0, dropoffSatang: 0, refundsSatang: 0, discountsSatang: 0, compsSatang: 0, txnCount: 3,
};
const MONEY: Record<string, unknown> = {
  sales: { scope, basis: 'stored-daily-summary', total: { ...day, businessDate: null },
    branches: [{ branchId: PARK, name: 'ZZ TEST Money park', source: 'oto_pos', today: '2026-10-28', lastRolledUpAt: null, total: { ...day, businessDate: null }, days: [day] }] },
  refunds: { scope, basis: 'original-sale-business-date', refunds: { count: 0, totalSatang: 0, truncated: false, rows: [] }, voids: { count: 0, totalSatang: 0, truncated: false, rows: [] } },
  discounts: { scope, basis: 'stored-report-facts', compSatang: 0, manualDiscountSatang: 0, promoSatang: 0, freeItemBenefitSatang: 0, foregoneSatang: 0, promoByType: [], byOperator: [] },
  cash: { scope, basis: 'pos-end-of-day', toleranceSatang: 100, branches: [{ branchId: PARK, name: 'ZZ TEST Money park', days: [
    { businessDate: '2026-10-01', available: false, code: 'EVENTS_SEAM_MISSING', reason: 'ZZ TEST the events seam is not on this database' },
  ] }] },
  settlement: { scope, basis: 'pos-settlement', gatewayFileFormat: 'fixture_only', branches: [{ branchId: PARK, name: 'ZZ TEST Money park', days: [
    { businessDate: '2026-10-01', terminals: [], gateway: { state: 'no_file', files: 0 }, matched: 0, unmatchedLines: [], unmatchedAttempts: [] },
  ] }] },
  wallets: { scope, basis: 'fact-wallet-liability-daily', outstanding: { projectionSatang: 0, ledgerSatang: 0 },
    branches: [{ branchId: PARK, name: 'ZZ TEST Money park', outstanding: { projectionSatang: 0, ledgerSatang: 0 }, days: [] }] },
  costs: { scope,
    booths: { prizeCostSatang: 0, prizeCostIncomplete: false, vouchersIssued: 0, vouchersRedeemed: 0, lastRolledUpAt: null, rows: [] },
    benefits: { totalReliefSatang: 0, appliedSatang: 0, compedSatang: 0, freeItemsSatang: 0, creditSatang: 0, discountSatang: 0, applications: 0, lastRolledUpAt: null, byRole: [] } },
  integrity: { scope, pendingMinutes: 10, generatedAt: '2026-10-28T00:00:00.000Z', checks: [
    { key: 'sales_without_payment', label: 'Sales with no settled payment', window: 'business_dates', truncated: false, rows: [{
      branchId: PARK, stationId: null, stationName: null, title: 'Sale ZZG-000001: ฿500.00 not settled', detail: 'ZZ TEST unpaid sale.',
      businessDate: '2026-10-01', amountSatang: 50_000, saleId: SALE, attemptId: null, actionId: null, receiptNumber: 'ZZG-000001', walletId: null,
      trace: { kind: 'sale', id: SALE, href: `/support?trace=${SALE}&kind=sale` },
    }] },
  ] },
};

const counted = (businessDate: string, verdict: string) => ({ businessDate, available: true, status: 'open', verdict,
  floatSatang: 50000, countedSatang: null, floatLeftSatang: null, paidOutSatang: 0, safeDropSatang: 0,
  totalExpectedSatang: 10000, totalActualSatang: verdict === 'ok' ? 10000 : 0, totalDifferenceSatang: verdict === 'ok' ? 0 : -10000,
  linesOff: verdict === 'off' ? 1 : 0, lines: [], closedBy: null, closedAt: null, provisionalBoxes: 0 });
(MONEY.cash as { branches: Array<{ days: unknown[] }> }).branches[0]!.days = [counted('2026-10-01', 'ok'), counted('2026-10-02', 'off'), counted('2026-10-03', 'pending'),
  { businessDate: '2026-10-04', available: false, code: 'UNREAD', reason: 'ZZ TEST unavailable native source' }];
(MONEY.settlement as { branches: Array<{ days: unknown[] }> }).branches[0]!.days = [
  { businessDate: '2026-10-01', terminals: [], gateway: { state: 'matched', files: 1 }, matched: 1, unmatchedLines: [], unmatchedAttempts: [] },
  { businessDate: '2026-10-02', terminals: [], gateway: { state: 'no_file', files: 0 }, matched: 0, unmatchedLines: [], unmatchedAttempts: [] },
  { businessDate: '2026-10-03', terminals: [], gateway: { state: 'matched', files: 1 }, matched: 0, unmatchedLines: [],
    unmatchedAttempts: [{ method: 'qr', amountSatang: 7000, tid: null, status: 'approved', attemptId: null, trace: null }] }];

async function fixture(page: Page, grants = permissions) {
  const calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
  const methods = [
    { id: 'zz_cash', label: 'ZZ TEST Cash', kind: 'cash', enabled: true, sortOrder: 0, attempts: 0 },
    { id: 'zz_card', label: 'ZZ TEST Card', kind: 'card', enabled: true, sortOrder: 1, attempts: 4 },
    { id: 'zz_qr', label: 'ZZ TEST QR', kind: 'qr', enabled: false, sortOrder: 2, attempts: 0 },
  ];
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, ''), method = request.method();
    const body: unknown = request.postData() ? request.postDataJSON() : null;
    calls.push({ method, path, query: url.search, body });
    if (path === '/me') return route.fulfill({ json: {
      account: { id: ACTOR, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false },
      employee: { id: ACTOR, name: 'ZZ TEST Payments reader', nickname: null },
      branch: { id: PARK, name: 'ZZ TEST Payments park', code: 'zz-test', timezone: 'Asia/Bangkok' },
      isPlatformAdmin: false, sessionLocked: false, photoFileId: null, preferences: { theme: 'light', language: 'en' },
      operatorContext: { sessionId: SESSION, homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
        operatorOverride: null, branchId: PARK, stationId: null, revision: 0 },
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: grants.map(permission => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/payment-methods' && method === 'GET') return route.fulfill({ json: { methods } });
    if (/^\/payment-methods\/zz_card\/move$/.test(path) && method === 'POST') return route.fulfill({ json: { ok: true, moved: true } });
    if (method !== 'GET') return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_WRITE_BLOCKED', message: 'No other fixture writes.' } } });
    if (path === '/branches') return route.fulfill({ json: { branches: [PARK, OTHER].map((id, i) => ({ id, name: `ZZ TEST Payments park ${i + 1}`, code: `zz-test-${i}`, timezone: 'Asia/Bangkok', country: 'TH', archived: false, openingHours: null, businessDayStart: '05:00:00', address: null })) } });
    if (path === '/console/configuration') return route.fulfill({ json: {
      generatedAt: '2026-10-29T00:00:00.000Z', operatorId: OPERATOR,
      branches: [{ id: PARK, name: 'ZZ TEST Payments park' }, { id: OTHER, name: 'ZZ TEST Other park' }],
      selectedBranchId: url.searchParams.get('branchId'), entries: url.searchParams.get('branchId') === OTHER ? [entries[2]] : entries,
    } });
    const section = path.match(/^\/console\/money\/([a-z]+)$/)?.[1];
    if (section && MONEY[section]) return route.fulfill({ json: MONEY[section] });
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Not offered by this fixture.' } } });
  });
  return calls;
}

test('Payments discovery uses permitted native doors and accurate unavailable capabilities', async ({ page }) => {
  const calls = await fixture(page);
  await page.goto('/catalogue');
  const payments = page.getByRole('region', { name: 'Payments', exact: true });
  await expect(payments.getByRole('heading', { name: 'Set up', exact: true })).toBeVisible();
  for (const [name, href] of [['Tenders', '/catalogue/tenders'], ['Tax', '/catalogue/tax'], ['Station routing', '/devices'],
    ['Settlement import', '/watch/integrations'], ['Money oversight', '/reports/money'], ['Support', '/watch/support']]) {
    await expect(payments.getByRole('link', { name, exact: true })).toHaveAttribute('href', href!);
  }
  await expect(payments.getByText('Deployment-only', { exact: true })).toBeVisible();
  await expect(payments.getByText('Not integrated', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('Payments discovery cannot add a tax, station, reconciliation or investigation door to restricted navigation', async ({ page }) => {
  const calls = await fixture(page, ['app:console:access', 'catalog:menu:read', 'catalog:menu:manage']);
  await page.goto('/catalogue'); const payments = page.getByRole('region', { name: 'Payments', exact: true });
  await expect(payments.getByRole('link', { name: 'Tenders', exact: true })).toBeVisible();
  for (const name of ['Tax', 'Station routing', 'Settlement import', 'Money oversight', 'Support']) {
    await expect(payments.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('Tender filters stay local and retain full-list movement rather than a filtered index', async ({ page }) => {
  const calls = await fixture(page); await page.goto('/catalogue/tenders');
  await expect(page.getByText('3 of 3 payment methods match the loaded-list filters.', { exact: false })).toBeVisible();
  const readCount = calls.length;
  await page.getByRole('textbox', { name: 'Search payment methods', exact: true }).fill('  card  ');
  await page.getByRole('combobox', { name: 'Payment method availability', exact: true }).selectOption('enabled');
  await page.getByRole('combobox', { name: 'Filter payment method kind', exact: true }).selectOption('card');
  await expect(page.getByText('1 of 3 payment methods match the loaded-list filters.', { exact: false })).toBeVisible();
  await expect(page.locator('input[value="ZZ TEST Card"]')).toBeVisible();
  await expect(page.locator('input[value="ZZ TEST Cash"]')).toHaveCount(0);
  const up = page.getByRole('button', { name: 'Move up', exact: true });
  await expect(up).toBeEnabled(); expect(calls.length).toBe(readCount);
  await up.click();
  await expect.poll(() => calls.filter(call => call.method === 'POST').length).toBe(1);
  expect(calls.find(call => call.method === 'POST')).toMatchObject({ path: '/payment-methods/zz_card/move', body: { direction: 'up' } });
  await page.getByRole('combobox', { name: 'Payment method availability', exact: true }).selectOption('disabled');
  await expect(page.getByText('No payment methods match these filters.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search payment methods', exact: true }).fill('');
  await page.getByRole('combobox', { name: 'Filter payment method kind', exact: true }).selectOption('qr');
  await expect(page.locator('input[value="ZZ TEST QR"]')).toBeVisible();
  expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
});

test('Configuration search and owner grouping preserve park responses and unsupported/app destination gates', async ({ page }) => {
  const calls = await fixture(page); await page.goto('/config');
  await expect(page.getByText('5 of 5 settings in this loaded park selection.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-setting-owner-group="platform"]')).toBeVisible();
  await expect(page.locator('[data-setting-owner-group="inbox"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in Inbox', exact: true })).toHaveCount(0);
  await expect(page.locator('a[href="//invalid.example/settings"]')).toHaveCount(0);
  const reads = calls.filter(call => call.path === '/console/configuration').length;
  await page.getByRole('searchbox', { name: 'Search settings', exact: true }).fill('inbox');
  await expect(page.getByText('1 of 5 settings in this loaded park selection.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-setting-key="templates"]')).toBeVisible();
  await expect(page.locator('[data-setting-key="tenders"]')).toHaveCount(0);
  expect(calls.filter(call => call.path === '/console/configuration')).toHaveLength(reads);
  await page.getByRole('searchbox', { name: 'Search settings', exact: true }).fill('not present');
  await expect(page.getByText('No settings match this search', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search settings', exact: true }).fill('');
  await page.getByRole('combobox', { name: 'Park', exact: true }).selectOption(OTHER);
  await expect(page.getByText('1 of 1 settings in this loaded park selection.', { exact: true })).toBeVisible();
  const payments = page.getByRole('region', { name: 'Payments', exact: true });
  await expect(payments.getByRole('link', { name: 'Tenders', exact: true })).toHaveCount(0);
  await expect(payments.getByRole('link', { name: 'Tax', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('Money attention filters retain unavailable evidence and leave source totals, bases and requests unchanged', async ({ page }) => {
  const calls = await fixture(page); await page.goto('/reports/money');
  await expect(page.locator('[data-cash-day]')).toHaveCount(4);
  await expect(page.locator('[data-settlement-day]')).toHaveCount(3);
  await expect(page.locator('[aria-label="Money at a glance"]')).not.toContainText('Loading');
  const totals = await page.locator('[aria-label="Money at a glance"]').textContent();
  const reads = calls.filter(call => call.path.startsWith('/console/money/')).length;
  await page.getByRole('checkbox', { name: 'Only cash days needing attention', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Only settlement days needing attention', exact: true }).check();
  await expect(page.locator('[data-cash-day]')).toHaveCount(3);
  await expect(page.locator('[data-cash-day="2026-10-01"]')).toHaveCount(0);
  await expect(page.locator('[data-cash-day="2026-10-04"][data-available="false"]')).toBeVisible();
  await expect(page.locator('[data-settlement-day]')).toHaveCount(2);
  await expect(page.locator('[data-settlement-day="2026-10-01"]')).toHaveCount(0);
  await expect(page.locator('[data-settlement-day="2026-10-02"] .not-available')).toContainText('No 2C2P file imported');
  await expect(page.getByText('3 of 4 loaded cash days', { exact: true })).toBeVisible();
  await expect(page.getByText('2 of 3 loaded settlement days', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.path.startsWith('/console/money/'))).toHaveLength(reads);
  expect(totals).toContain('Sales');
  expect(await page.locator('[aria-label="Money at a glance"]').textContent()).toBe(totals);
  await expect(page.locator('#money-sales')).toContainText('stored daily summary');
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('payment discovery and loaded filters fit a native 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page);
  for (const path of ['/catalogue', '/config', '/reports/money']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (path === '/config') await expect(page.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
    if (path === '/reports/money') await expect(page.getByRole('checkbox', { name: 'Only cash days needing attention' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
});
