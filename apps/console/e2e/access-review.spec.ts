import { expect, test, type Page } from '@playwright/test';

const PARK = '01900000-0000-7000-8000-000000000001';
const ACCOUNT = '01900000-0000-7000-8000-000000000081';
const signedInAt = '2026-10-22T03:04:05.000Z';
const titles = ['Operator-wide holders', 'Platform-wide holders', 'Accounts without an employee',
  'Employees without an account', 'Accounts with no recorded sign-in', 'Temporary passwords outstanding'];
const account = (overrides = {}) => ({
  id: ACCOUNT, phone: '+66800000001', status: 'active', employee: { id: 'employee-one', name: 'ZZ TEST Rowan' },
  lastSignInAt: signedInAt, mustChangePassword: false, ...overrides,
});
const snapshot = () => ({
  operatorWideHolders: [{ ...account(), assignments: [{ id: 'operator-assignment', roleName: 'operator_admin', scopeId: '01964000-0000-7000-8000-00000000f012' }] }],
  platformWideHolders: [{ ...account({ id: 'platform-account', employee: { id: 'employee-platform', name: 'ZZ TEST Platform' } }),
    assignments: [{ id: 'platform-assignment', roleName: 'platform_admin', scopeId: null }] }],
  accountsWithoutEmployee: [account({ id: 'unlinked-account', phone: '+66800000002', employee: null, status: 'inactive' })],
  employeesWithoutAccount: [{ id: 'unlinked-employee', name: 'ZZ TEST Mirror', nickname: 'Mirror', source: 'otoapp',
    archivedAt: '2026-10-21T08:00:00.000Z', branch: { id: PARK, name: 'ZZ TEST Central' } }],
  accountsNeverSignedIn: [account({ id: 'never-account', status: 'invited', lastSignInAt: null })],
  temporaryPasswordsOutstanding: [account({ id: 'temp-account', mustChangePassword: true })],
});

async function fixture(page: Page, options: { roleRead?: boolean; accountRead?: boolean } = {}) {
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

  let reads = 0;
  const writes: string[] = [];
  await page.route('**/api/**', (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/api/, '');
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext('01964000-0000-7000-8000-00000000f011', '01964000-0000-7000-8000-00000000f012', null),
      account: { id: '01964000-0000-7000-8000-00000000f011', phone: '', status: 'active', mustChangePassword: false, operatorId: '01964000-0000-7000-8000-00000000f012' },
      employee: { id: '01964000-0000-7000-8000-00000000f011', name: 'ZZ TEST Admin', nickname: null }, branch: null,
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', ...(options.roleRead === false ? [] : ['admin:role:read']),
      ...(options.accountRead === false ? [] : ['admin:account:read']),
    ].map((permission) => ({ permission, scopeType: 'branch', scopeId: PARK })) } });
    if (path === '/access-review' || path === '/access-review/') {
      reads++;
      return route.fulfill({ json: snapshot() });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'Not on fixture access.' } } });
  });
  return { reads: () => reads, writes };
}

function card(page: Page, title: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

test('Access review shows all six returned lists, wide roles, real sign-in state and flags without write controls or record IDs', async ({ page }, testInfo) => {
  const seen = await fixture(page);
  await page.goto('/people/access-review');
  await expect(page.getByRole('heading', { name: 'Access review', exact: true })).toBeVisible();
  for (const title of titles) {
    await expect(card(page, title)).toBeVisible();
    await expect(card(page, title).getByText(title === 'Employees without an account' ? '1 employee' : '1 account', { exact: true })).toBeVisible();
  }
  await expect(card(page, titles[0]!).getByText('operator_admin', { exact: true })).toBeVisible();
  await expect(card(page, titles[1]!).getByText('platform_admin', { exact: true })).toBeVisible();
  await expect(card(page, titles[0]!).locator('time')).toHaveAttribute('datetime', signedInAt);
  await expect(card(page, titles[2]!)).toContainText('+66800000002');
  await expect(card(page, titles[2]!)).toContainText('Inactive');
  await expect(card(page, titles[3]!)).toContainText('ZZ TEST Mirror');
  await expect(card(page, titles[3]!)).toContainText('ZZ TEST Central');
  await expect(card(page, titles[3]!)).toContainText('OTO App');
  await expect(card(page, titles[3]!)).toContainText('Archived');
  await expect(card(page, titles[4]!)).toContainText('Invited');
  await expect(card(page, titles[4]!)).toContainText('No recorded sign-in');
  await expect(card(page, titles[5]!)).toContainText('Password change required');
  await expect(page.getByRole('link', { name: 'Access review', exact: true })).toHaveAttribute('href', '/people/access-review');
  await expect(page.getByRole('button', { name: /create|invite|edit|save|delete|reset|reveal|grant|remove|sign out everywhere/i })).toHaveCount(0);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  for (const id of [ACCOUNT, 'operator-assignment', 'platform-assignment', 'employee-platform']) expect(await page.locator('main').innerText()).not.toContain(id);
  expect(seen.reads()).toBe(1);
  expect(seen.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('access-review-desktop.png'), fullPage: true });
  await page.goto('/access-review');
  await expect(page.getByRole('heading', { name: 'Access review', exact: true })).toBeVisible();
});

test('role-read gates the page while the existing account-read People navigation gate remains unchanged', async ({ page }) => {
  const denied = await fixture(page, { roleRead: false });
  await page.goto('/people/access-review');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Access review', exact: true })).toHaveCount(0);
  expect(denied.reads()).toBe(0);
  const direct = await fixture(page, { accountRead: false });
  await page.goto('/people/access-review');
  await expect(page.getByRole('heading', { name: 'Access review', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Access review', exact: true })).toHaveCount(0);
  expect(direct.reads()).toBe(1);
});

test('pending or failed review does not invent six empty lists and retry can show genuine empty results', async ({ page }) => {
  await fixture(page);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/access-review*', async (route) => {
    if (++attempts === 1) {
      await delayed;
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'The access review did not answer.' } } });
    }
    return route.fulfill({ json: Object.fromEntries(Object.keys(snapshot()).map((key) => [key, []])) });
  });
  await page.goto('/people/access-review');
  await expect(page.getByRole('status')).toContainText('Loading access review');
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toHaveCount(0);
  release!();
  await expect(page.getByRole('alert')).toContainText('The access review did not answer.');
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  for (const title of titles) {
    await expect(card(page, title).getByText(title === 'Employees without an account' ? '0 employees' : '0 accounts', { exact: true })).toBeVisible();
    await expect(card(page, title).getByText('No matching records in your reach.', { exact: true })).toBeVisible();
  }
});

test('a late earlier refresh cannot replace the currently completed review', async ({ page }) => {
  await fixture(page);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/access-review*', async (route) => {
    const attempt = ++attempts;
    if (attempt === 2) await delayed;
    const answer = snapshot();
    answer.operatorWideHolders[0]!.employee!.name = attempt === 2 ? 'ZZ TEST Old review' : attempt === 3 ? 'ZZ TEST New review' : 'ZZ TEST Rowan';
    return route.fulfill({ json: answer });
  });
  await page.goto('/people/access-review');
  await expect(card(page, titles[0]!).getByRole('heading', { name: 'ZZ TEST Rowan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Loading access review');
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(card(page, titles[0]!).getByRole('heading', { name: 'ZZ TEST New review', exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse((response) => response.url().includes('/api/access-review'));
  release!(); await (await oldResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(card(page, titles[0]!).getByRole('heading', { name: 'ZZ TEST New review', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ZZ TEST Old review', exact: true })).toHaveCount(0);
});

test('a server refusal is shown as an error without presenting a clean access review', async ({ page }) => {
  const seen = await fixture(page);
  await page.route('**/api/access-review*', (route) => route.fulfill({ status: 403,
    json: { error: { code: 'PERMISSION_DENIED', message: 'This review is outside your readable role scope.' } } }));
  await page.goto('/people/access-review');
  await expect(page.getByRole('alert')).toContainText('This review is outside your readable role scope.');
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toHaveCount(0);
  await expect(page.getByText('No matching records in your reach.', { exact: true })).toHaveCount(0);
  expect(seen.writes).toEqual([]);
});

test('six review cards and long account, role, employee and park names fit a390px phone', async ({ page }, testInfo) => {
  const seen = await fixture(page);
  const long = 'ZZ TEST ' + 'LongAccountRoleEmployeePark'.repeat(5);
  const answer = snapshot();
  answer.operatorWideHolders[0]!.employee!.name = long;
  answer.operatorWideHolders[0]!.assignments[0]!.roleName = long;
  answer.employeesWithoutAccount[0]!.name = long;
  answer.employeesWithoutAccount[0]!.nickname = long;
  answer.employeesWithoutAccount[0]!.branch!.name = long;
  await page.route('**/api/access-review*', (route) => route.fulfill({ json: answer }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/people/access-review');
  await expect(card(page, titles[0]!).getByRole('heading', { name: long, exact: true })).toBeVisible();
  await expect(card(page, titles[3]!).getByRole('heading', { name: long, exact: true })).toBeVisible();
  await expect(card(page, titles[5]!)).toContainText('Password change required');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const bounds = await card(page, titles[0]!).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(seen.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('access-review-phone.png'), fullPage: true });
});
