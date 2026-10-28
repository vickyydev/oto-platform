import { expect, test, type Page } from '@playwright/test';

const PARK = '01968200-0000-7000-8000-000000000001';
const OPERATOR = '01968200-0000-7000-8000-000000000002';
const ACTOR = '01968200-0000-7000-8000-000000000003';
const reference = 'zz-test-native-request-682';
const privateCanary = 'private-canary-682';
const tax = () => ({ rates: [{ id: 'zz-test-vat', name: 'ZZ TEST VAT', percent: 7 }], categoryRules: [
  { category: 'fnb', taxMode: 'exclusive', taxRateId: 'zz-test-vat', serviceChargePercent: 5 },
  { category: 'stored_value', taxMode: 'none' }], discountPlacement: 'before_tax' });

async function fixture(page: Page, platform = false) {
  let config = tax();
  const committed = new Set<string>();
  const state = { puts: 0, commits: 0, gets: 0, environmentReads: 0, failure: null as null | 'validation' | 'conflict' | 'rate' | 'server' | 'network',
    commitThenFailRead: false, failedReads: 0, sameRetryKey: true, firstKey: undefined as string | undefined,
    setSaved: (value: ReturnType<typeof tax>) => { config = value; } };
  const branch = { id: PARK, name: 'ZZ TEST Error review park', code: 'zz-682', timezone: 'Asia/Bangkok', country: 'TH', archived: false,
    openingHours: null, businessDayStart: '05:00:00', address: null };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      Object.assign(window, { __s682CopiedReference: text });
    } } });
  });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.slice(4).replace(/\/$/, '');
    if (path === '/me') return route.fulfill({ json: { operatorContext: {
      sessionId: '01968200-0000-7000-8000-000000000004', homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
      operatorOverride: null, branchId: PARK, stationId: null, revision: 0 }, account: { id: ACTOR, operatorId: OPERATOR,
      phone: '', status: 'active', mustChangePassword: false }, employee: { id: ACTOR, name: 'ZZ TEST Error reviewer', nickname: null },
      branch, isPlatformAdmin: platform, photoFileId: null, sessionLocked: false, preferences: { theme: 'light', language: 'en' } } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', 'admin:branch:read', 'catalog:tax:read', 'catalog:tax:manage', 'admin:health:read',
    ].map(permission => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: [branch] } });
    if (path === `/branches/${PARK}/tax-config`) {
      if (request.method() === 'GET') {
        state.gets++;
        if (state.failedReads > 0) { state.failedReads--; return route.fulfill({ status: 500,
          json: { error: { code: 'INTERNAL', message: 'ZZ TEST Readback refused.' } }, headers: { 'x-request-id': reference } }); }
        return route.fulfill({ json: { config } });
      }
      state.puts++;
      const key = request.headers()['idempotency-key'];
      if (state.firstKey === undefined) state.firstKey = key;
      else state.sameRetryKey &&= Boolean(key && key === state.firstKey);
      if (state.failure === 'network') {
        config = request.postDataJSON() as ReturnType<typeof tax>;
        if (key && !committed.has(key)) { committed.add(key); state.commits++; }
        return route.abort('failed');
      }
      const status = state.failure === 'validation' ? 400 : state.failure === 'conflict' ? 409 : state.failure === 'rate' ? 429 : state.failure === 'server' ? 500 : 200;
      if (status !== 200) return route.fulfill({ status, headers: { 'x-request-id': reference, ...(status === 429 ? { 'retry-after': '2' } : {}) }, json: { error: {
        code: status === 400 ? 'VALIDATION' : status === 409 ? 'CONFLICT' : status === 429 ? 'RATE_LIMITED' : 'INTERNAL',
        message: status === 400 ? 'Request does not match the schema' : status === 409 ? 'Another change was recorded.'
          : status === 429 ? 'Too many requests' : `SQL SELECT ${privateCanary} FROM provider_secret`,
        details: status === 400 ? [
          { instancePath: '/categoryRules/0/serviceChargePercent', params: { issue: { code: 'too_small', origin: 'number', minimum: 0, inclusive: true, message: privateCanary, received: privateCanary } } },
          { instancePath: '/password', params: { issue: { code: 'invalid_type', expected: privateCanary } }, message: privateCanary },
        ] : { password: privateCanary, stack: privateCanary },
      } } });
      config = request.postDataJSON() as ReturnType<typeof tax>;
      if (key && !committed.has(key)) { committed.add(key); state.commits++; }
      if (state.commitThenFailRead) { state.failedReads++; state.commitThenFailRead = false; }
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/platform/environment') {
      state.environmentReads++;
      return route.fulfill({ status: 500, headers: { 'x-request-id': reference },
        json: { error: { code: 'INTERNAL', message: `SQL SELECT ${privateCanary} FROM provider_secret`, details: { secret: privateCanary } } } });
    }
    if (path === '/ops/health') return route.fulfill({ json: { generatedAt: '2026-10-29T00:00:00.000Z', overallStatus: 'ok', alerts: [], boxes: [], checks: [] } });
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST Outside the error review fixture.' } } });
  });
  return state;
}

async function openTax(page: Page) {
  await page.goto('/catalogue/tax');
  await expect(page.getByRole('heading', { name: 'Global tax rates', exact: true })).toBeVisible();
  const field = page.locator('#tax-svc-fnb');
  await field.fill('15');
  return field;
}
const save = (page: Page) => page.getByRole('button', { name: 'Save changes', exact: true });

test('validation names a known field and constraint, retains its draft, focuses it and copies only a valid reference', async ({ page }) => {
  const state = await fixture(page); state.failure = 'validation';
  const field = await openTax(page);
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText('F&B service charge');
  await expect(page.getByRole('alert')).toContainText('0 or more');
  await expect(field).toHaveValue('15');
  await expect(field).toBeFocused();
  await expect(page.getByText(privateCanary, { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy reference', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __s682CopiedReference?: string }).__s682CopiedReference === 'zz-test-native-request-682')).toBe(true);
  expect(state.puts).toBe(1);
});

test('a409 retains the draft and requires an explicit fresh GET before resubmitting', async ({ page }) => {
  const state = await fixture(page); state.failure = 'conflict';
  const field = await openTax(page);
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText('Another change was recorded.');
  await expect(field).toHaveValue('15');
  await expect(save(page)).toBeDisabled();
  state.failure = null;
  await page.getByRole('button', { name: 'Read current settings', exact: true }).click();
  await expect(save(page)).toBeEnabled();
  expect(state.gets).toBe(2);
  expect(state.puts).toBe(1);
  await expect(field).toHaveValue('15');
  await save(page).click();
  await expect(page.getByText('Saved — live in the till.', { exact: true })).toBeVisible();
  expect(state.puts).toBe(2);
  expect(state.sameRetryKey).toBe(true);
  expect(state.commits).toBe(1);
});

test('a429 uses the native wait without automatically repeating the write', async ({ page }) => {
  const state = await fixture(page); state.failure = 'rate';
  await openTax(page);
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText('Wait');
  await expect(save(page)).toBeDisabled();
  state.failure = null;
  await expect(save(page)).toBeEnabled({ timeout: 6000 });
  expect(state.puts).toBe(1);
  await save(page).click();
  await expect(page.getByText('Saved — live in the till.', { exact: true })).toBeVisible();
  expect(state.puts).toBe(2);
});

for (const failure of ['server', 'network'] as const) test(`an uncertain ${failure} outcome does not claim not-saved or repeat the write before a read`, async ({ page }) => {
  const state = await fixture(page); state.failure = failure;
  const field = await openTax(page);
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText('may have been saved');
  await expect(page.getByText(privateCanary, { exact: false })).toHaveCount(0);
  await expect(page.getByText('The tax settings were not saved.', { exact: false })).toHaveCount(0);
  await expect(field).toHaveValue('15');
  await expect(save(page)).toBeDisabled();
  state.failure = null;
  await page.getByRole('button', { name: 'Read current settings', exact: true }).click();
  await expect(save(page)).toBeEnabled();
  expect(state.puts).toBe(1);
  await save(page).click();
  await expect(page.getByText('Saved — live in the till.', { exact: true })).toBeVisible();
  expect(state.puts).toBe(2);
  expect(state.sameRetryKey).toBe(true);
  expect(state.commits).toBe(1);
});

test('a confirmed save followed by failed refresh retries only the read', async ({ page }) => {
  const state = await fixture(page); state.commitThenFailRead = true;
  await openTax(page);
  await save(page).click();
  await expect(page.getByText(/Saved, but the money settings could not be refreshed/)).toBeVisible();
  expect(state.puts).toBe(1);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('#tax-svc-fnb')).toHaveValue('15');
  expect(state.puts).toBe(1);
  expect(state.gets).toBe(3);
});

test('a platform read failure keeps diagnostics private and the safe reference copyable', async ({ page }) => {
  const state = await fixture(page, true);
  await page.goto('/platform/environment');
  await expect(page.getByText(reference, { exact: true })).toBeVisible();
  await expect(page.getByText(privateCanary, { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy reference', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __s682CopiedReference?: string }).__s682CopiedReference === 'zz-test-native-request-682')).toBe(true);
  expect(state.environmentReads).toBe(1);
});

test('an operator grant does not imply platform-wide authority or read the refused page', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/platform/environment');
  await expect(page.getByText(/requires a platform-wide account/)).toBeVisible();
  await expect(page.getByText(/park or operator access alone/)).toBeVisible();
  expect(state.environmentReads).toBe(0);
});

test('a recovery read distinguishes changed saved values from the retained draft before an explicit Save', async ({ page }) => {
  const state = await fixture(page); state.failure = 'conflict';
  const field = await openTax(page);
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  const changed = tax();
  changed.rates[0]!.percent = 9.5;
  changed.categoryRules[0]!.serviceChargePercent = 35;
  state.setSaved(changed); state.failure = null;
  await page.getByRole('button', { name: 'Read current settings', exact: true }).click();
  await expect(save(page)).toBeEnabled();
  expect(state.gets).toBe(2);
  expect(state.puts).toBe(1);
  await expect(field).toHaveValue('15');
  await expect(page.getByRole('spinbutton', { name: 'Rate percent', exact: true })).toHaveValue('7');
  const saved = page.getByRole('region', { name: 'Saved tax settings', exact: true });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText('differs from the saved settings');
  await expect(saved.getByText('35%', { exact: true })).toBeVisible();
  await expect(saved.getByText('9.5%', { exact: true })).toBeVisible();
  await save(page).click();
  await expect(page.getByText('Saved — live in the till.', { exact: true })).toBeVisible();
  expect(state.puts).toBe(2);
  await expect(saved).toHaveCount(0);
});
