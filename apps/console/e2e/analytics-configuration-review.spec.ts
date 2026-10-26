import { expect, test, type Page } from '@playwright/test';

const OPERATOR = '01966000-0000-7000-8000-000000000001';
const ACTOR = '01966000-0000-7000-8000-000000000002';
const SESSION = '01966000-0000-7000-8000-000000000003';
const PARK = '01966000-0000-7000-8000-000000000004';

async function fixture(page: Page) {
  const calls: Array<{ method: string; path: string }> = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '').replace(/\/$/, '');
    calls.push({ method: request.method(), path });
    if (request.method() !== 'GET') return route.fulfill({ status: 403,
      json: { error: { code: 'ZZ_TEST_WRITE_BLOCKED', message: 'No fixture writes.' } } });
    if (path === '/me') return route.fulfill({ json: {
      account: { id: ACTOR, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false },
      employee: { id: ACTOR, name: 'ZZ TEST Analytics reader', nickname: null },
      branch: { id: PARK, name: 'ZZ TEST Analytics park', code: 'zz-test', timezone: 'Asia/Bangkok' },
      isPlatformAdmin: false, sessionLocked: false, photoFileId: null,
      preferences: { theme: 'light', language: 'en' },
      operatorContext: { sessionId: SESSION, homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
        operatorOverride: null, branchId: PARK, stationId: null, revision: 0 },
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', 'console:analytics:read', 'console:config:read', 'analytics:read',
    ].map(permission => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    return route.fulfill({ status: 403,
      json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Not offered by this fixture.' } } });
  });
  return calls;
}

test('an operator read holder can open Analytics and sources at the native report address', async ({ page }) => {
  const calls = await fixture(page);
  await page.goto('/reports/analytics');
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics & sources', exact: true })).toBeVisible();
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('an operator Configuration reader can open the native ownership index without a platform-admin role', async ({ page }) => {
  const calls = await fixture(page);
  await page.goto('/config');
  await expect(page.getByRole('heading', { level: 1, name: 'Configuration', exact: true })).toBeVisible();
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
});
