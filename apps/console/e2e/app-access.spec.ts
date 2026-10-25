import { expect, test, type Page } from '@playwright/test';

const SOM = '01900000-0000-7000-8000-000000000010';
const MAI = '01900000-0000-7000-8000-000000000011';
const BRANCH = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000003';
const OPERATOR = '01900000-0000-7000-8000-000000000002';
const APP_USER = '01900000-0000-7000-8000-000000000030';
const MAI_USER = '01900000-0000-7000-8000-000000000031';
const identity = (externalUserId = APP_USER, accountId = SOM, branchIds: string[] | null = null) => ({
  id: `identity-${accountId}`, app: 'oto_app', externalUserId, createdBy: OPERATOR,
  createdAt: '2026-10-22T01:00:00.000Z', hasAccess: true,
  branches: { accessBranches: branchIds, appBranches: { allBranches: branchIds === null,
    branches: [{ id: 'app-park', name: 'ZZ TEST Park', platformBranchId: BRANCH }] } },
});
const account = (id = SOM) => ({ id, phone: id === SOM ? '+66800000001' : '+66800000002', status: 'active', mustChangePassword: false,
  employee: { id: `employee-${id}`, name: id === SOM ? 'ZZ TEST Som' : 'ZZ TEST Mai' } });
const unlinked = { id: APP_USER, fullName: 'ZZ TEST OTO Person', email: 'zz-test-person@example.invalid', phoneE164: '+66800000001',
  role: 'advisor', isActive: true, createdAt: '2026-10-22T01:00:00.000Z', allBranches: false,
  branches: [{ id: 'app-park', name: 'ZZ TEST Park', platformBranchId: BRANCH }] };

async function fixture(page: Page, options: { linked?: boolean; read?: boolean; assign?: boolean; retainedAccess?: boolean } = {}) {
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

  const writes: Array<{ method: string; path: string; body: unknown; key: string | undefined }> = [];
  const identities = new Map([[SOM, options.linked ? [identity()] : []], [MAI, [identity(MAI_USER, MAI)]]]);
  let claimed = false;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext(OPERATOR, OPERATOR, null),
      account: { id: OPERATOR, phone: '', status: 'active', mustChangePassword: false, operatorId: OPERATOR },
      employee: { id: OPERATOR, name: 'ZZ TEST Admin', nickname: null }, branch: null,
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', 'app:oto_app:access', 'admin:account:read',
      ...(options.read === false ? [] : ['admin:role:read']), ...(options.assign === false ? [] : ['admin:role:assign']),
    ].map(permission => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: [
      { id: BRANCH, name: 'ZZ TEST Park', code: 'ZZ', timezone: 'Asia/Bangkok', archived: false },
      { id: OTHER, name: 'ZZ TEST Other Park', code: 'ZZ2', timezone: 'Asia/Bangkok', archived: false },
    ] } });
    if (path === '/accounts') {
      const query = url.searchParams.get('q')?.toLowerCase() ?? '';
      return route.fulfill({ json: { accounts: [account(), account(MAI)].filter(row => `${row.employee.name} ${row.phone}`.toLowerCase().includes(query)) } });
    }
    if (path === '/admin/apps/oto_app/unlinked-users') return route.fulfill({ json: { installed: true, anchored: true, users: claimed ? [] : [unlinked] } });
    if (path.startsWith('/admin/apps/users/')) return route.fulfill({ json: { identities: identities.get(path.split('/').at(-1)!) ?? [] } });
    if (path.endsWith('/permissions')) {
      const accountId = path.split('/')[2]!;
      return route.fulfill({ json: { assignments: [], effective: [
        { permission: 'app:pos:access', roleName: 'reception', scopeType: 'branch', scopeId: BRANCH },
        ...((options.retainedAccess || identities.get(accountId)?.length) ? [
          { permission: 'app:oto_app:access', roleName: options.retainedAccess ? 'operator_admin' : 'app_access_oto_app', scopeType: 'operator', scopeId: OPERATOR },
        ] : []),
      ] } });
    }
    if (path.startsWith('/admin/apps/oto_app/users') && ['POST', 'PUT', 'DELETE'].includes(request.method())) {
      const body = request.postDataJSON() as { accountId?: string; externalUserId?: string; branchIds?: string[] | null } | null;
      writes.push({ method: request.method(), path, body, key: request.headers()['idempotency-key'] });
      if (request.method() === 'POST') {
        const accountId = body!.accountId!;
        identities.set(accountId, [identity(body?.externalUserId ?? APP_USER, accountId, body?.branchIds ?? null)]);
        claimed = body?.externalUserId === APP_USER;
        return route.fulfill({ json: { id: `identity-${accountId}`, app: 'oto_app', accountId, externalUserId: body?.externalUserId ?? APP_USER,
          accountCreated: false, appUserCreated: !body?.externalUserId, appBranch: null } });
      }
      const accountId = path.split('/')[5]!;
      if (request.method() === 'PUT') {
        identities.set(accountId, [identity(APP_USER, accountId, body?.branchIds ?? null)]);
        return route.fulfill({ json: { ok: true } });
      }
      identities.set(accountId, []);
      return route.fulfill({ json: { ok: true, accessRevoked: true } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'Not on this fixture’s access.' } } });
  });
  return { writes };
}

async function appsFor(page: Page, person = 'Som', path = '/people/app-access') {
  await page.goto(path);
  await page.getByRole('row', { name: new RegExp(`ZZ TEST ${person}`) }).getByTitle('Apps', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Apps — ZZ TEST ${person}`, exact: true });
  await expect(dialog.getByRole('group', { name: 'POS access', exact: true })).toBeVisible();
  return dialog;
}
const otoRow = (page: Page) => page.getByRole('dialog').getByRole('group', { name: 'OTO App access', exact: true });

test('Accounts and App access share the approved Apps dialog and one-action OTO App provisioning', async ({ page }, testInfo) => {
  const { writes } = await fixture(page);
  const dialog = await appsFor(page, 'Som', '/people/accounts');
  for (const name of ['POS', 'Console', 'OTO App', 'Radar', 'Lucky Wheel', 'Inbox']) await expect(dialog.getByRole('group', { name: `${name} access`, exact: true })).toBeVisible();
  const oto = otoRow(page);
  await oto.getByRole('button', { name: 'Give them access', exact: true }).click();
  await expect(oto.getByRole('combobox').getByRole('option')).toHaveText(['Global admin', 'Operator admin', 'Admin', 'Manager', 'Staff']);
  await expect(oto.getByRole('combobox')).toHaveValue('staff');
  await expect(oto.getByRole('button', { name: 'Only some', exact: true })).toBeEnabled();
  await oto.getByPlaceholder('name@otopark.co.th').fill('zz-test-person@example.invalid');
  await oto.getByRole('button', { name: 'Create in OTO App', exact: true }).click();
  await expect(oto.getByText(APP_USER, { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ method: 'POST', path: '/admin/apps/oto_app/users', body: {
    accountId: SOM, otoApp: { email: 'zz-test-person@example.invalid', role: 'staff' },
  } });
  expect(writes[0]?.body).not.toHaveProperty('phone');
  expect(writes[0]?.body).not.toHaveProperty('branchIds');
  expect(writes[0]?.key).toBeTruthy();
  await page.locator('[toast-close]').click();
  await expect(page.getByText('OTO App linked', { exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('apps-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('apps-phone.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('existing-user linking and branch changes retain the approved choices and exact seam payloads', async ({ page }) => {
  const { writes } = await fixture(page);
  await appsFor(page);
  const oto = otoRow(page);
  await oto.getByRole('button', { name: 'Give them access', exact: true }).click();
  await oto.getByRole('button', { name: 'Already has a user', exact: true }).click();
  await oto.getByPlaceholder('The id that app already knows them by').fill(APP_USER);
  await oto.getByRole('button', { name: 'Only some', exact: true }).click();
  await expect(oto.getByRole('button', { name: 'Link OTO App', exact: true })).toBeDisabled();
  await oto.getByRole('checkbox', { name: 'ZZ TEST Park', exact: true }).check();
  await oto.getByRole('button', { name: 'Link OTO App', exact: true }).click();
  await expect(oto.getByRole('button', { name: 'Change', exact: true })).toBeVisible();
  expect(writes[0]?.body).toEqual({ accountId: SOM, externalUserId: APP_USER, branchIds: [BRANCH] });
  await oto.getByRole('button', { name: 'Change', exact: true }).click();
  await oto.getByRole('button', { name: 'All branches', exact: true }).click();
  await oto.getByRole('button', { name: 'Save branches', exact: true }).click();
  await expect(oto.locator('dl')).toContainText('all branches');
  expect(writes[1]).toMatchObject({ method: 'PUT', path: `/admin/apps/oto_app/users/${SOM}/branches`, body: { branchIds: null } });
  expect(writes[1]?.key).toBeTruthy();
});

test('unlinked OTO App users claim an existing staff sign-in without inviting or changing their app role', async ({ page }, testInfo) => {
  const { writes } = await fixture(page);
  await page.goto('/people/app-access');
  await expect(page.getByText('Advisor', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('app-access-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('app-access-phone.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Link ZZ TEST OTO Person to a sign-in', exact: true });
  await dialog.getByRole('radio').check();
  await dialog.getByRole('button', { name: 'Link OTO App', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Everyone in the OTO App has a suite sign-in.', { exact: false })).toBeVisible();
  expect(writes[0]?.body).toEqual({ accountId: SOM, externalUserId: APP_USER });
  expect(writes[0]?.key).toBeTruthy();
  for (const action of ['Change phone', 'Sessions', 'Sign out everywhere', 'Temporary password', 'Deactivate']) await expect(page.getByTitle(action, { exact: true })).toHaveCount(0);
});

test('reading apps and changing app access retain separate permission offers', async ({ page }) => {
  await fixture(page, { read: false, assign: false });
  await page.goto('/people/app-access');
  await expect(page.getByRole('heading', { name: 'App access', exact: true })).toBeVisible();
  await expect(page.getByTitle('Apps', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Link', exact: true })).toHaveCount(0);
  await fixture(page, { assign: false });
  await appsFor(page);
  await expect(otoRow(page).getByRole('button', { name: 'Give them access', exact: true })).toBeDisabled();
});

test('late account app and permission reads cannot replace another account’s dialog', async ({ page }) => {
  await fixture(page, { linked: true });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/admin/apps/users/${SOM}`, async route => { await pending; return route.fulfill({ json: { identities: [identity()] } }); });
  await page.route(`**/api/accounts/${SOM}/permissions`, async route => { await pending; return route.fulfill({ json: { assignments: [], effective: [] } }); });
  await page.goto('/people/app-access');
  await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Apps', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('row', { name: /ZZ TEST Mai/ }).getByTitle('Apps', { exact: true }).click();
  const mai = page.getByRole('dialog', { name: 'Apps — ZZ TEST Mai', exact: true });
  await expect(mai.getByText(MAI_USER, { exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse(`**/api/admin/apps/users/${SOM}`);
  release(); await oldResponse; await page.waitForLoadState('networkidle');
  await expect(mai.getByText(MAI_USER, { exact: true })).toBeVisible();
  await expect(mai.getByText(APP_USER, { exact: true })).toHaveCount(0);
});

test('a delayed mutation refresh cannot replace the next account’s app identity', async ({ page }) => {
  await fixture(page);
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/admin/apps/users/${SOM}`, async route => {
    if (++reads === 1) return route.fallback();
    await pending; return route.fulfill({ json: { identities: [identity()] } });
  });
  const som = await appsFor(page);
  const oto = otoRow(page);
  await oto.getByRole('button', { name: 'Give them access', exact: true }).click();
  await oto.getByPlaceholder('name@otopark.co.th').fill('zz-test-person@example.invalid');
  await oto.getByRole('button', { name: 'Create in OTO App', exact: true }).click();
  await expect(oto.getByPlaceholder('name@otopark.co.th')).toHaveCount(0);
  await som.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('row', { name: /ZZ TEST Mai/ }).getByTitle('Apps', { exact: true }).click();
  const mai = page.getByRole('dialog', { name: 'Apps — ZZ TEST Mai', exact: true });
  await expect(mai.getByText(MAI_USER, { exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse(`**/api/admin/apps/users/${SOM}`);
  release(); await oldResponse; await page.waitForLoadState('networkidle');
  await expect(mai.getByText(MAI_USER, { exact: true })).toBeVisible();
});

test('changing an unlinked-user search clears an invisible previous account choice', async ({ page }) => {
  const { writes } = await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/accounts?q=Mai', async route => { await pending; return route.fulfill({ json: { accounts: [account(MAI)] } }); });
  await page.goto('/people/app-access');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio').check();
  await dialog.getByPlaceholder('Search name or phone…').fill('Mai');
  await expect(dialog.getByRole('button', { name: 'Link OTO App', exact: true })).toBeDisabled();
  release();
  await expect(dialog.getByText('ZZ TEST Mai', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('radio')).not.toBeChecked();
  expect(writes).toHaveLength(0);
});

test('late unlinked-user search results cannot replace the current query', async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/accounts?q=Som', async route => { await pending; return route.fulfill({ json: { accounts: [account()] } }); });
  await page.goto('/people/app-access');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Search name or phone…').fill('Som');
  await dialog.getByPlaceholder('Search name or phone…').fill('Mai');
  await expect(dialog.getByText('ZZ TEST Mai', { exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse('**/api/accounts?q=Som');
  release(); await oldResponse; await page.waitForLoadState('networkidle');
  await expect(dialog.getByText('ZZ TEST Mai', { exact: true })).toBeVisible();
  await expect(dialog.getByText('ZZ TEST Som', { exact: true })).toHaveCount(0);
});

test('a failed unlinked-user search never becomes an empty account match', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/accounts?q=unavailable', route => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Staff search unavailable.' } } }));
  await page.goto('/people/app-access');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const link = page.getByRole('dialog');
  await link.getByPlaceholder('Search name or phone…').fill('unavailable');
  await expect(link.getByRole('alert')).toContainText('Staff search unavailable.');
  await expect(link.getByText('No staff account matches.', { exact: true })).toHaveCount(0);
});

test('a failed permission read never becomes a fictional app access state', async ({ page }) => {
  await fixture(page);
  await page.route(`**/api/accounts/${SOM}/permissions`, route => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Permissions unavailable.' } } }));
  await page.goto('/people/app-access');
  await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Apps', { exact: true }).click();
  const apps = page.getByRole('dialog');
  await expect(apps.getByRole('alert')).toContainText('Permissions unavailable.');
  await expect(apps.getByText('not granted', { exact: true })).toHaveCount(0);
});

test('unlink confirmation and refreshed role grants explain access that survives the link', async ({ page }) => {
  const { writes } = await fixture(page, { linked: true, retainedAccess: true });
  await appsFor(page);
  const oto = otoRow(page);
  await oto.getByRole('button', { name: 'Unlink', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Unlink OTO App from ZZ TEST Som?', exact: true });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toHaveLength(0);
  await oto.getByRole('button', { name: 'Unlink', exact: true }).click();
  await confirm.getByRole('button', { name: 'Unlink', exact: true }).click();
  await expect(oto.getByText('refused at the door', { exact: true })).toBeVisible();
  await expect(page.getByText(/its tile is off their launcher/)).toHaveCount(0);
  expect(writes[0]).toMatchObject({ method: 'DELETE', path: `/admin/apps/oto_app/users/${SOM}` });
  expect(writes[0]?.key).toBeTruthy();
});

test('an account resource 404 keeps its actual reason instead of claiming app linking is undeployed', async ({ page }) => {
  await fixture(page);
  await page.route(`**/api/admin/apps/users/${SOM}`, route => route.fulfill({ status: 404,
    json: { error: { code: 'ACCOUNT_NOT_FOUND', message: 'This staff account no longer exists.' } } }));
  await page.goto('/people/app-access');
  await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Apps', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Apps — ZZ TEST Som', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('This staff account no longer exists.');
  await expect(dialog.getByText('App linking is not on this deployment yet', { exact: true })).toHaveCount(0);
});

test('a missing app user keeps the real claim error without marking provisioning unavailable', async ({ page }) => {
  await fixture(page);
  let attempts = 0;
  await page.route('**/api/admin/apps/oto_app/users', route => {
    attempts++;
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'That OTO App user no longer exists.' } } });
  });
  await appsFor(page);
  const oto = otoRow(page);
  await oto.getByRole('button', { name: 'Give them access', exact: true }).click();
  await oto.getByRole('button', { name: 'Already has a user', exact: true }).click();
  await oto.getByPlaceholder('The id that app already knows them by').fill(APP_USER);
  await oto.getByRole('button', { name: 'Link OTO App', exact: true }).click();
  await expect(page.getByText("Couldn't link OTO App", { exact: true })).toBeVisible();
  await expect(page.getByText('That OTO App user no longer exists.', { exact: true })).toBeVisible();
  await expect(oto.getByText('Linking OTO App users is not on this deployment yet.', { exact: true })).toHaveCount(0);
  expect(attempts).toBe(1);
});

test('an UNKNOWN 404 still shows the original missing-route fallback', async ({ page }) => {
  await fixture(page);
  await page.route(`**/api/admin/apps/users/${SOM}`, route => route.fulfill({ status: 404,
    json: { message: 'Route GET:/admin/apps/users/demo not found', error: 'Not Found', statusCode: 404 } }));
  await page.goto('/people/app-access');
  await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Apps', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Apps — ZZ TEST Som', exact: true });
  await expect(dialog.getByText('App linking is not on this deployment yet', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});
