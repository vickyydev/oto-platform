import { expect, test, type Page } from '@playwright/test';

/**
 * SCRUM-647 — Money oversight in the browser, against a fixture api: the
 * figures render, a source that is not there reads as not available, the
 * integrity panel is offered only to an investigator, and every trace link
 * carries its record's identifier. The fixture refuses every non-GET, so a
 * page that tried to write would fail here.
 */

const OPERATOR = '01964700-0000-7000-8000-000000000001';
const ACTOR = '01964700-0000-7000-8000-000000000002';
const SESSION = '01964700-0000-7000-8000-000000000003';
const PARK = '01964700-0000-7000-8000-000000000004';
const SALE = '01964700-0000-7000-8000-0000000000b1';

const scope = { from: '2026-10-01', to: '2026-10-02', branches: [{ branchId: PARK, name: 'ZZ TEST Money park' }], omitted: [] };
const day = {
  businessDate: '2026-10-01', provisional: false, rolledDays: 1, computedAt: null, revenueSatang: 123_400, ticketsSatang: 100_000,
  fnbSatang: 23_400, merchSatang: 0, partiesSatang: 0, dropoffSatang: 0, refundsSatang: 0, discountsSatang: 0, compsSatang: 0, txnCount: 3,
};
const SECTIONS: Record<string, unknown> = {
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

async function fixture(page: Page, permissions: string[]) {
  const calls: Array<{ method: string; path: string }> = [];
  // The api only: the dev server serves the app's own modules under /src/api/.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '').replace(/\/$/, '');
    calls.push({ method: request.method(), path });
    if (request.method() !== 'GET') {
      return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_WRITE_BLOCKED', message: 'No fixture writes.' } } });
    }
    if (path === '/me') return route.fulfill({ json: {
      account: { id: ACTOR, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false },
      employee: { id: ACTOR, name: 'ZZ TEST Money reader', nickname: null },
      branch: { id: PARK, name: 'ZZ TEST Money park', code: 'zz-test', timezone: 'Asia/Bangkok' },
      isPlatformAdmin: false, sessionLocked: false, photoFileId: null,
      preferences: { theme: 'light', language: 'en' },
      operatorContext: { sessionId: SESSION, homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
        operatorOverride: null, branchId: PARK, stationId: null, revision: 0 },
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: ['app:console:access', ...permissions]
      .map((permission) => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    const section = path.match(/^\/console\/money\/([a-z]+)$/)?.[1];
    if (section && SECTIONS[section]) {
      if (section === 'integrity' && !permissions.includes('console:money:investigate')) {
        return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Missing permission console:money:investigate' } } });
      }
      return route.fulfill({ json: SECTIONS[section] });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Not offered by this fixture.' } } });
  });
  return calls;
}

test('an investigator reads the money, sees not-available sources as such, and every trace link names its record', async ({ page }) => {
  const calls = await fixture(page, ['console:money:read', 'console:money:investigate']);
  await page.goto('/money');
  await expect(page.getByRole('heading', { level: 1, name: 'Money oversight', exact: true })).toBeVisible();
  await expect(page.getByText('฿1,234').first()).toBeVisible();
  // Not available is its own mark, never a zero.
  await expect(page.locator('.not-available', { hasText: 'End of Day could not read this day' })).toBeVisible();
  await expect(page.locator('.not-available', { hasText: 'No 2C2P file imported' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Money integrity' })).toBeVisible();
  const trace = page.getByRole('link', { name: 'Support trace' });
  await expect(trace).toHaveAttribute('href', `/support?trace=${SALE}&kind=sale`);
  expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  expect(calls.some((call) => call.path === '/console/money/integrity')).toBe(true);
});

test('a reader without investigate gets the figures and no integrity panel, and never asks for it', async ({ page }) => {
  const calls = await fixture(page, ['console:money:read']);
  await page.goto('/reports/money');
  await expect(page.getByRole('heading', { level: 1, name: 'Money oversight', exact: true })).toBeVisible();
  await expect(page.getByText('฿1,234').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Money integrity' })).toHaveCount(0);
  expect(calls.some((call) => call.path === '/console/money/integrity')).toBe(false);
  expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
});
