import { expect, test, type Page } from '@playwright/test';

const EMPLOYEE = '01900000-0000-7000-8000-000000000061';
const SOURCE_EMPLOYEE = 'e2b48b20-ded7-41ab-b3db-867bd4eb4215';
const PARK = '01900000-0000-7000-8000-000000000001';
const signedInAt = '2026-10-22T03:04:05.000Z';
const employee = (overrides = {}) => ({
  id: EMPLOYEE, name: 'ZZ TEST Mira', nickname: 'Mira', source: 'otoapp',
  externalId: SOURCE_EMPLOYEE, archivedAt: null,
  branch: { id: PARK, name: 'ZZ TEST Central' }, department: { id: 'department', name: 'Reception' },
  accounts: [
    { id: 'login-one', phone: '+66800000001', status: 'active', lastSignInAt: signedInAt },
    { id: 'login-two', phone: '+66800000002', status: 'inactive', lastSignInAt: null },
  ],
  lastSignInAt: signedInAt, ...overrides,
});
const rows = () => [employee(), employee({
  id: 'platform-person', name: 'ZZ TEST Platform person', nickname: null, source: 'platform', externalId: null,
  archivedAt: '2026-10-21T08:00:00.000Z', branch: null, department: null, accounts: [], lastSignInAt: null,
})];

async function fixture(page: Page, options: { read?: boolean; sourceAccess?: boolean } = {}) {
  const reads: string[] = [];
  const writes: Array<{ method: string; path: string; body: unknown; key: string | undefined }> = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    if (request.method() !== 'GET') writes.push({
      method: request.method(), path, body: request.postDataJSON(), key: request.headers()['idempotency-key'],
    });
    if (path === '/me') return route.fulfill({ json: {
      account: { id: 'caller', phone: '', status: 'active', mustChangePassword: false, operatorId: 'operator' },
      employee: { id: 'caller', name: 'ZZ TEST Admin', nickname: null }, branch: null,
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', ...(options.read === false ? [] : ['admin:account:read']),
      ...(options.sourceAccess === false ? [] : ['app:oto_app:access']),
    ].map((permission) => ({ permission, scopeType: 'branch', scopeId: PARK })) } });
    if (path === '/employees' || path === '/employees/') {
      reads.push(url.searchParams.get('q') ?? '');
      return route.fulfill({ json: { employees: rows() } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'Not on fixture access.' } } });
  });
  return { reads, writes };
}

test('Employees shows source, park, department, all linked logins and real sign-in timestamps without edit controls', async ({ page }, testInfo) => {
  const seen = await fixture(page);
  await page.goto('/people/employees');
  await expect(page.getByRole('heading', { name: 'Employees', exact: true })).toBeVisible();
  const list = page.getByRole('list', { name: 'Employees', exact: true });
  const mirror = list.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'ZZ TEST Mira', exact: true }) });
  await expect(mirror).toContainText('OTO App');
  await expect(mirror).toContainText('ZZ TEST Central');
  await expect(mirror).toContainText('Reception');
  await expect(mirror).toContainText('+66800000001');
  await expect(mirror).toContainText('+66800000002');
  await expect(mirror).toContainText('Inactive');
  await expect(mirror.locator('time')).toHaveCount(2);
  expect(await mirror.locator('time').first().getAttribute('datetime')).toBe(signedInAt);
  await expect(mirror).toContainText('No recorded sign-in');
  const platform = list.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'ZZ TEST Platform person', exact: true }) });
  await expect(platform).toContainText('Platform');
  await expect(platform).toContainText('Archived');
  await expect(platform).toContainText('No park recorded');
  await expect(platform).toContainText('No department recorded');
  await expect(platform).toContainText('No visible linked sign-in');
  await expect(platform.getByRole('button', { name: 'Open in OTO App', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /invite|create|edit|save|delete|deactivate/i })).toHaveCount(0);
  expect(seen.reads).toEqual(['']);
  expect(seen.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('employees-desktop.png'), fullPage: true });
  await page.goto('/employees');
  await expect(page.getByRole('heading', { name: 'Employees', exact: true })).toBeVisible();
});

test('Employees navigation and direct route retain account-read permission and do not read without it', async ({ page }) => {
  const seen = await fixture(page, { read: false });
  await page.goto('/people/employees');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Employees', exact: true })).toHaveCount(0);
  expect(seen.reads).toEqual([]);
});

test('a pending or failed directory stays distinct from empty and retry refreshes the real source', async ({ page }) => {
  await fixture(page);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/employees*', async (route) => {
    if (++attempts === 1) {
      await delayed;
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'The employee source did not answer.' } } });
    }
    return route.fulfill({ json: { employees: attempts === 2 ? rows() : [] } });
  });
  await page.goto('/people/employees');
  await expect(page.getByRole('status')).toContainText('Loading employees');
  await expect(page.getByText('No employees in your reach', { exact: true })).toHaveCount(0);
  release!();
  await expect(page.getByRole('alert')).toContainText('The employee source did not answer.');
  await expect(page.getByRole('list', { name: 'Employees', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ZZ TEST Mira', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('No employees in your reach', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search employees', exact: true }).fill('Nobody');
  await expect(page.getByText('No matching employees', { exact: true })).toBeVisible();
});

test('search sends the exact query and an older response cannot replace the selected search', async ({ page }) => {
  await fixture(page);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const queries: string[] = [];
  await page.route('**/api/employees*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    queries.push(query);
    if (query === 'Old') {
      await delayed;
      return route.fulfill({ json: { employees: [employee({ name: 'ZZ TEST Old response' })] } });
    }
    return route.fulfill({ json: { employees: [employee({ name: query ? 'ZZ TEST New response' : 'ZZ TEST Mira' })] } });
  });
  await page.goto('/people/employees');
  await expect(page.getByRole('heading', { name: 'ZZ TEST Mira', exact: true })).toBeVisible();
  const search = page.getByRole('textbox', { name: 'Search employees', exact: true });
  await search.fill('Old');
  await expect(page.getByRole('status')).toContainText('Loading employees');
  await expect(page.getByRole('heading', { name: 'ZZ TEST Mira', exact: true })).toHaveCount(0);
  await search.fill('+6680 New');
  await expect(page.getByRole('heading', { name: 'ZZ TEST New response', exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse((answer) => new URL(answer.url()).searchParams.get('q') === 'Old');
  release!();
  await (await oldResponse).finished();
  // Let the released fetch continuation and React paint complete before checking
  // that an older query did not replace the currently selected result.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('heading', { name: 'ZZ TEST New response', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ZZ TEST Old response', exact: true })).toHaveCount(0);
  expect(queries).toEqual(['', 'Old', '+6680 New']);
});

test('the source button uses an explicitly requested configured handoff and the existing employee deep target', async ({ page }) => {
  const seen = await fixture(page);
  const handoffs: Array<{ body: unknown; key: string | undefined }> = [];
  await page.route('**/api/auth/handoff', (route) => {
    handoffs.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    return route.fulfill({ json: { launchUrl: 'https://source.example/#handoff=fixture' } });
  });
  await page.route('https://source.example/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>ZZ TEST source</p>' }));
  await page.goto('/people/employees');
  const button = page.getByRole('button', { name: 'Open in OTO App', exact: true });
  await expect(button).toHaveCount(1);
  expect(handoffs).toEqual([]);
  expect(seen.writes).toEqual([]);
  await button.click();
  await page.waitForURL(`https://source.example/#handoff=fixture&to=${encodeURIComponent(`/employees/${SOURCE_EMPLOYEE}`)}`);
  expect(handoffs).toHaveLength(1);
  expect(handoffs[0]!.body).toEqual({ app: 'oto_app' });
  expect(handoffs[0]!.key).toMatch(/^[0-9a-f-]{36}$/i);
  const opaqueId = 'legacy-employee_007';
  await page.route('**/api/employees*', (route) => route.fulfill({ json: { employees: [employee({ externalId: opaqueId })] } }));
  await page.goto('/people/employees');
  await page.getByRole('button', { name: 'Open in OTO App', exact: true }).click();
  await page.waitForURL(`https://source.example/#handoff=fixture&to=${encodeURIComponent(`/employees/${opaqueId}`)}`);
  expect(handoffs).toHaveLength(2);
});

test('source access and a valid mirrored identifier are required before offering an OTO App action', async ({ page }) => {
  const seen = await fixture(page, { sourceAccess: false });
  await page.goto('/people/employees');
  await expect(page.getByRole('heading', { name: 'ZZ TEST Mira', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in OTO App', exact: true })).toHaveCount(0);
  await expect(page.getByText('OTO App is not on your access.', { exact: true })).toBeVisible();
  expect(seen.writes).toEqual([]);
  await fixture(page);
  await page.route('**/api/employees*', (route) => route.fulfill({ json: { employees: [
    employee({ externalId: '../other-page' }), employee({ id: 'missing-id', name: 'ZZ TEST Missing source', externalId: null }),
  ] } }));
  await page.goto('/people/employees');
  await expect(page.getByText('The source employee link is unavailable.', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Open in OTO App', exact: true })).toHaveCount(0);
});

test('handoff failures keep the directory visible, suppress duplicate requests and allow a fresh retry', async ({ page }) => {
  await fixture(page);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const keys: string[] = [];
  await page.route('**/api/auth/handoff', async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (keys.length === 1) {
      await delayed;
      return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'The source app refused this handoff.' } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/people/employees');
  await page.getByRole('button', { name: 'Open in OTO App', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Opening OTO App…', exact: true })).toBeDisabled();
  expect(keys).toHaveLength(1);
  release!();
  await expect(page.getByRole('alert')).toContainText('The source app refused this handoff.');
  await expect(page.getByRole('heading', { name: 'ZZ TEST Mira', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open in OTO App', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('OTO App has no configured destination.');
  expect(new Set(keys).size).toBe(2);
});

test('long real-world employee details and multiple sign-ins fit a 390px phone without hiding source or account state', async ({ page }, testInfo) => {
  await fixture(page);
  const long = 'ZZ TEST ' + 'LongEmployeeParkDepartment'.repeat(5);
  await page.route('**/api/employees*', (route) => route.fulfill({ json: { employees: [employee({
    name: long, nickname: long, branch: { id: PARK, name: long }, department: { id: 'department', name: long },
  })] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/people/employees');
  await expect(page.getByRole('heading', { name: long, exact: true })).toBeVisible();
  await expect(page.getByText('+66800000001 Active', { exact: true })).toBeVisible();
  await expect(page.getByText('+66800000002 Inactive', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open in OTO App', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const bounds = await page.getByRole('textbox', { name: 'Search employees', exact: true }).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('employees-phone.png'), fullPage: true });
});
