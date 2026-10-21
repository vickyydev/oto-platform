import { expect, test, type Page } from '@playwright/test';
import { PERMISSION_WORDS } from '@oto/shared/permissions';
import { pressLandsOn } from './console';

const SOM = '01900000-0000-7000-8000-000000000010';
const MAI = '01900000-0000-7000-8000-000000000011';
const BRANCH = '01900000-0000-7000-8000-000000000001';
const OPERATOR = '01900000-0000-7000-8000-000000000002';
const ASSIGNMENT = '01900000-0000-7000-8000-000000000020';
const ADDED = '01900000-0000-7000-8000-000000000021';
const sales = { permission: 'pos:sale:read', words: 'Read the park’s sales.' };
const refunds = { permission: 'pos:refund:approve', words: 'Approve a refund at the park.' };
const account = (id = SOM) => ({ id, phone: '+66800000001', status: 'active', mustChangePassword: false,
  employee: { id: `employee-${id}`, name: id === SOM ? 'ZZ TEST Som' : 'ZZ TEST Mai' } });
const catalogue = { permissions: [sales, refunds], roles: [
  { id: 'reception', name: 'reception', description: 'The reception role.', system: true, permissions: [sales] },
  { id: 'staff', name: 'staff', description: null, system: true, permissions: [sales, refunds] },
  { id: 'app', name: 'app_access_oto_app', description: null, system: false, permissions: [sales] },
] };
const point = (entry = refunds, scopeType = 'branch', scopeId: string | null = BRANCH) => ({ ...entry, scopeType, scopeId });
const preview = (query: URLSearchParams) => ({
  accountId: query.get('accountId'), operation: query.get('operation'), before: [point(sales)],
  after: [point(sales), point()], added: query.get('operation') === 'grant' ? [point()] : [],
  removed: query.get('operation') === 'remove' ? [point()] : [], unchanged: [point(sales)],
});

async function fixture(page: Page, options: { read?: boolean; assign?: boolean; platform?: boolean } = {}) {
  const writes: Array<{ method: string; path: string; body: unknown; key: string | undefined }> = [];
  const previews: URLSearchParams[] = [];
  let granted = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/me') return route.fulfill({ json: {
      account: { id: 'caller', phone: '', status: 'active', mustChangePassword: false, operatorId: OPERATOR },
      employee: { id: 'caller', name: 'ZZ TEST Admin', nickname: null }, branch: null,
      isPlatformAdmin: options.platform ?? false, photoFileId: null, sessionLocked: false,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', 'admin:account:read', ...(options.read === false ? [] : ['admin:role:read']),
      ...(options.assign === false ? [] : ['admin:role:assign']),
    ].map((permission) => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: [
      { id: BRANCH, name: 'ZZ TEST Park', code: 'ZZ', timezone: 'Asia/Bangkok', archived: false },
    ] } });
    if (path === '/accounts') return route.fulfill({ json: { accounts: [account(), account(MAI)] } });
    if (path === '/roles' || path === '/roles/') return route.fulfill({ json: catalogue });
    if (path === '/roles/holders') return route.fulfill({ json: {
      permission: url.searchParams.get('permission'), words: sales.words,
      holders: url.searchParams.get('permission') === refunds.permission ? [] : [{
        accountId: SOM, phone: account().phone, status: 'active', employee: account().employee,
        assignments: [{ id: ASSIGNMENT, roleName: 'reception', scopeType: 'branch', scopeId: BRANCH, scopeName: 'ZZ TEST Park' }],
      }],
    } });
    if (path === '/roles/preview') {
      previews.push(url.searchParams);
      return route.fulfill({ json: preview(url.searchParams) });
    }
    if (path.endsWith('/permissions')) return route.fulfill({ json: {
      assignments: [{ id: ASSIGNMENT, roleName: 'reception', scopeType: 'branch', scopeId: BRANCH },
        ...(granted ? [{ id: ADDED, roleName: 'staff', scopeType: 'branch', scopeId: BRANCH }] : [])],
      effective: [{ permission: path.includes(MAI) ? refunds.permission : sales.permission, scopeType: 'branch', scopeId: BRANCH, roleName: 'reception' }],
    } });
    if (path.includes('/role-assignments')) {
      writes.push({ method: request.method(), path, body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
      granted = request.method() === 'POST';
      return route.fulfill({ json: granted ? { id: ADDED } : { ok: true } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'Not on this fixture’s access.' } } });
  });
  return { writes, previews };
}

async function permissionsForSom(page: Page) {
  await page.goto('/people/accounts');
  await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Effective permissions', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Permissions — ZZ TEST Som', exact: true });
  await expect(dialog.getByText('pos:sale:read', { exact: true })).toBeVisible();
  return dialog;
}

test('the role catalogue speaks in sentences and reverse lookup shows the server’s visible people and scopes', async ({ page }, testInfo) => {
  await fixture(page);
  await page.goto('/people/roles');
  await expect(page.getByRole('heading', { name: 'Roles & scopes', exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'reception' }).click();
  await expect(page.getByText(sales.words, { exact: true }).first()).toBeVisible();
  const holders = page.getByRole('list', { name: 'Permission holders', exact: true });
  await expect(holders).toContainText('ZZ TEST Som');
  await expect(holders).toContainText('ZZ TEST Park');
  await page.screenshot({ path: testInfo.outputPath('roles-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('combobox', { name: 'Permission', exact: true }).selectOption(refunds.permission);
  await expect(page.getByText('No holders in your reach', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox', { name: 'Permission', exact: true }).selectOption(sales.permission);
  await expect(holders).toContainText('ZZ TEST Som');
  await page.screenshot({ path: testInfo.outputPath('roles-phone.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('the full permission catalogue and long park scopes remain usable on a phone', async ({ page }, testInfo) => {
  await fixture(page);
  const permissions = Object.entries(PERMISSION_WORDS).map(([permission, words]) => ({ permission, words }));
  const longest = permissions.reduce((held, entry) => entry.words.length > held.words.length ? entry : held);
  const scopeName = 'ZZ TEST Chalong Family Adventure and Evening Operations Park — Reception and guest services team';
  await page.route('**/api/roles', (route) => route.fulfill({ json: {
    permissions,
    roles: [{ id: 'operator_admin', name: 'operator_admin', description: 'The existing operator administrator role.', system: true, permissions }],
  } }));
  await page.route('**/api/roles/holders*', (route) => route.fulfill({ json: {
    permission: new URL(route.request().url()).searchParams.get('permission'), words: longest.words,
    holders: [{ accountId: SOM, phone: account().phone, status: 'active', employee: account().employee,
      assignments: [{ id: ASSIGNMENT, roleName: 'branch_manager', scopeType: 'branch', scopeId: BRANCH, scopeName }] }],
  } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/people/roles');
  const picker = page.getByRole('combobox', { name: 'Permission', exact: true });
  await expect(picker.getByRole('option')).toHaveCount(137);
  await picker.selectOption(longest.permission);
  await expect(picker).toHaveValue(longest.permission);
  await expect(page.getByRole('list', { name: 'Permission holders', exact: true })).toContainText(scopeName);
  await page.locator('summary').filter({ hasText: 'operator_admin' }).click();
  await expect(page.getByText(longest.words, { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => ({ width: innerWidth, contentWidth: document.documentElement.scrollWidth })))
    .toEqual({ width: 390, contentWidth: 390 });
  const box = await picker.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await picker.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('roles-full-catalogue-phone.png'), animations: 'disabled' });
});

test('the lifted branch grant and removal both require canonical previews before writing', async ({ page }, testInfo) => {
  const { writes, previews } = await fixture(page);
  const dialog = await permissionsForSom(page);
  await expect(dialog.getByRole('combobox', { name: 'Role', exact: true }).getByRole('option')).toHaveText(['reception', 'staff', 'branch_manager', 'operator_admin']);
  await expect(dialog.getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue('operator');
  await expect(dialog.getByRole('option', { name: 'Platform-wide (every operator)', exact: true })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: 'Role', exact: true }).selectOption('staff');
  await dialog.getByRole('combobox', { name: 'Scope', exact: true }).selectOption(`branch:${BRANCH}`);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  const review = page.getByRole('alertdialog', { name: 'Review permission change', exact: true });
  await expect(review.getByText(refunds.words, { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(review.getByText(refunds.words, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('role-preview.png'), animations: 'disabled' });
  expect(await pressLandsOn(review.getByRole('button', { name: 'Save role change', exact: true }))).toContain('button “Save role change”');
  await review.getByRole('button', { name: 'Save role change', exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(writes[0]).toMatchObject({ method: 'POST', path: `/accounts/${SOM}/role-assignments`,
    body: { roleName: 'staff', scopeType: 'branch', scopeId: BRANCH } });
  expect(writes[0]?.key).toBeTruthy();
  expect(previews[0]?.get('scopeId')).toBe(BRANCH);
  await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await expect(review.getByRole('heading', { name: 'Removed access (1)', exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Save role change', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(1);
  expect(writes[1]).toMatchObject({ method: 'DELETE', path: `/accounts/${SOM}/role-assignments/${ADDED}` });
  expect(previews.at(-1)?.get('assignmentId')).toBe(ADDED);
});

test('a refused or pending preview cannot save a role change', async ({ page }) => {
  const { writes } = await fixture(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/roles/preview*', async (route) => {
    await pending;
    return route.fulfill({ status: 403, json: { error: { code: 'LAST_ADMIN', message: 'The last administrator must keep this role.' } } });
  });
  const dialog = await permissionsForSom(page);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  const review = page.getByRole('alertdialog');
  await expect(review.getByRole('button', { name: 'Save role change', exact: true })).toBeDisabled();
  release!();
  await expect(review.getByRole('alert')).toContainText('The last administrator must keep this role.');
  await expect(review.getByRole('button', { name: 'Save role change', exact: true })).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test('an earlier account permission read cannot replace a different account’s drawer', async ({ page }) => {
  await fixture(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/accounts/${SOM}/permissions`, async (route) => { await pending; return route.fulfill({ json: {
    assignments: [], effective: [{ permission: sales.permission, scopeType: 'branch', scopeId: BRANCH, roleName: 'reception' }],
  } }); });
  await page.goto('/people/accounts');
  await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Effective permissions', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('row', { name: /ZZ TEST Mai/ }).getByTitle('Effective permissions', { exact: true }).click();
  const mai = page.getByRole('dialog', { name: 'Permissions — ZZ TEST Mai', exact: true });
  await expect(mai.getByText(refunds.permission, { exact: true })).toBeVisible();
  const response = page.waitForResponse(`**/api/accounts/${SOM}/permissions`);
  release!(); await response; await page.waitForLoadState('networkidle');
  await expect(mai.getByText(refunds.permission, { exact: true })).toBeVisible();
  await expect(mai.getByText(sales.permission, { exact: true })).toHaveCount(0);
});

test('a canceled earlier preview cannot authorize a new scope choice', async ({ page }) => {
  const { writes } = await fixture(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/roles/preview*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('scopeType') !== 'operator') return route.fallback();
    await pending;
    return route.fulfill({ json: { ...preview(query), added: [point(sales, 'operator', OPERATOR)] } });
  });
  const dialog = await permissionsForSom(page);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  const review = page.getByRole('alertdialog');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Scope', exact: true }).selectOption(`branch:${BRANCH}`);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(review.getByText(refunds.words, { exact: true })).toBeVisible();
  const response = page.waitForResponse((answer) => new URL(answer.url()).searchParams.get('scopeType') === 'operator');
  release!(); await response; await page.waitForLoadState('networkidle');
  await expect(review.getByText(sales.words, { exact: true })).toHaveCount(0);
  await review.getByRole('button', { name: 'Save role change', exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(writes[0]?.body).toMatchObject({ scopeType: 'branch', scopeId: BRANCH });
});

test('role-read and assignment permissions retain their separate guards and platform scope is explicit', async ({ page }) => {
  await fixture(page, { read: false });
  await page.goto('/people/roles');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  await page.goto('/people/accounts');
  await expect(page.getByTitle('Effective permissions', { exact: true })).toHaveCount(0);
  await fixture(page, { assign: false });
  const readOnly = await permissionsForSom(page);
  await expect(readOnly.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await expect(readOnly.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
  await fixture(page, { platform: true });
  const platform = await permissionsForSom(page);
  await expect(platform.getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue('operator');
  await expect(platform.getByRole('option', { name: 'Platform-wide (every operator)', exact: true })).toHaveCount(1);
});

test('failed catalogue, reverse lookup and account reads stay visibly failed instead of empty', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/roles', (route) => route.fulfill({ status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'Role catalogue unavailable.' } } }));
  await page.goto('/people/roles');
  await expect(page.getByText('Role catalogue unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText('No matching roles', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/roles');
  await page.route('**/api/roles/holders*', (route) => route.fulfill({ status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'Permission holders unavailable.' } } }));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Permission holders unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText('No holders in your reach', { exact: true })).toHaveCount(0);
  await page.route(`**/api/accounts/${SOM}/permissions`, (route) => route.fulfill({ status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'Account permissions unavailable.' } } }));
  await page.goto('/people/accounts');
  await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Effective permissions', { exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Permissions could not be read.');
  await expect(page.getByText(/No roles assigned/)).toHaveCount(0);
});

test('the server may report no effective change and a pending save cannot be submitted twice', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/roles/preview*', (route) => route.fulfill({ json: {
    ...preview(new URL(route.request().url()).searchParams), added: [], removed: [],
  } }));
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  await page.route(`**/api/accounts/${SOM}/role-assignments`, async (route) => {
    writes++; await pending; return route.fulfill({ json: { id: ADDED } });
  });
  const dialog = await permissionsForSom(page);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  const review = page.getByRole('alertdialog');
  await expect(review.getByRole('heading', { name: 'Added access (0)', exact: true })).toBeVisible();
  await expect(review.getByRole('heading', { name: 'Removed access (0)', exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Save role change', exact: true }).click();
  await expect(review.getByRole('button', { name: 'Save role change', exact: true })).toBeDisabled();
  await expect(review.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  release!(); await expect(review).toHaveCount(0);
  expect(writes).toBe(1);
});
