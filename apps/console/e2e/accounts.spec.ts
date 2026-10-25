import { expect, test, type Page } from '@playwright/test';

const SOM = '01900000-0000-7000-8000-000000000010';
const MAI = '01900000-0000-7000-8000-000000000011';
const BRANCH = '01900000-0000-7000-8000-000000000001';
const OPERATOR = '01900000-0000-7000-8000-000000000002';
const ACCOUNT_LIST = /\/api\/accounts(?:\?.*)?$/;
const row = (id = SOM, name = 'ZZ TEST Som') => ({
  id, phone: '+66800000001', status: 'active', mustChangePassword: false,
  employee: { id: `employee-${id}`, name },
});
const fixturePassword = 'fixture-not-a-real-credential';

async function accountsFixture(page: Page, options: { read?: boolean; audit?: boolean } = {}) {
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

  const calls: Array<{ method: string; path: string; body: unknown; key: string | undefined }> = [];
  let accounts = [row(), row(MAI, 'ZZ TEST Mai')];
  let sessions = [{ id: 'session-one', branchId: BRANCH, stationId: null, lockedAt: '2026-10-22T06:00:00Z',
    lastSeenAt: '2026-10-22T06:00:00Z', expiresAt: '2099-10-22T06:00:00Z', createdAt: '2026-10-22T05:00:00Z' }];
  let tokens = [{ jti: 'fixture-token-id', accountId: SOM, stationId: 'fixture-station', boxId: 'fixture-box',
    issuedAt: '2026-10-22T05:00:00Z', expiresAt: '2099-10-22T06:00:00Z', revokedAt: null as string | null, revokedReason: null as string | null }];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    if (method !== 'GET') calls.push({ method, path, body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext('01964000-0000-7000-8000-00000000f031', OPERATOR, null),
      account: { id: '01964000-0000-7000-8000-00000000f031', phone: '', status: 'active', mustChangePassword: false, operatorId: OPERATOR },
      employee: { id: '01964000-0000-7000-8000-00000000f031', name: 'ZZ TEST Admin', nickname: null }, branch: null,
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', ...(options.read === false ? [] : ['admin:account:read']),
      'admin:account:create', 'admin:account:update', ...(options.audit === false ? [] : ['admin:audit:read']),
    ].map((permission) => ({ permission, scopeType: 'branch', scopeId: BRANCH })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: [
      { id: BRANCH, name: 'ZZ TEST Park', code: 'ZZ', timezone: 'Asia/Bangkok', archived: false },
    ] } });
    if (path === '/audit') return route.fulfill({ json: { entries: [] } });
    if (path === '/accounts' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return route.fulfill({ json: { accounts: accounts.filter((account) => `${account.employee.name} ${account.phone}`.toLowerCase().includes(q)) } });
    }
    if (path === '/accounts' && method === 'POST') {
      const body = request.postDataJSON() as { employeeName: string; phone: string };
      accounts = [...accounts, { ...row('01900000-0000-7000-8000-000000000012', body.employeeName), phone: body.phone, status: 'invited' }];
      return route.fulfill({ json: { id: accounts.at(-1)!.id, status: 'invited', codeSent: true } });
    }
    if (/^\/accounts\/[^/]+$/.test(path) && method === 'PATCH') {
      const patch = request.postDataJSON() as { status?: string; phone?: string };
      accounts = accounts.map((account) => account.id === path.split('/')[2] ? { ...account, ...patch } : account);
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/temp-password')) return route.fulfill({ json: { temporaryPassword: fixturePassword } });
    if (path.endsWith('/sessions/revoke')) {
      const sessionsEnded = sessions.length;
      sessions = [];
      return route.fulfill({ json: { sessionsEnded } });
    }
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions } });
    if (path.endsWith('/staff-tokens')) return route.fulfill({ json: { tokens } });
    if (path === '/staff-tokens/settings') return route.fulfill({ json: { available: true, kid: 'fixture-key-id', ttlSeconds: 57_600, offlineSignIn: false } });
    if (path.startsWith('/staff-tokens/') && method === 'DELETE') {
      tokens = tokens.map((token) => ({ ...token, revokedAt: '2026-10-22T06:00:00Z', revokedReason: 'admin' }));
      return route.fulfill({ json: { revoked: 1 } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'Not permitted in this fixture.' } } });
  });
  return calls;
}

test('Accounts retains search and the scoped invitation form through the injected host transport', async ({ page }, testInfo) => {
  const calls = await accountsFixture(page);
  await page.goto('/people/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /ZZ TEST Som/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search name or phone', exact: true }).fill('Mai');
  await expect(page.getByRole('row', { name: /ZZ TEST Mai/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /ZZ TEST Som/ })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search name or phone', exact: true }).fill('');
  await expect(page.getByRole('row', { name: /ZZ TEST Som/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('accounts-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Invite staff account', exact: true }).click();
  const invite = page.getByRole('dialog', { name: 'Invite a staff account', exact: true });
  await invite.getByRole('textbox', { name: 'Full name', exact: true }).fill('ZZ TEST Reception');
  await invite.getByRole('textbox', { name: 'Phone Number', exact: true }).fill('800000002');
  await expect(invite.getByRole('combobox', { name: 'Role', exact: true }).getByRole('option')).toHaveText(['reception', 'staff', 'branch_manager', 'operator_admin']);
  await invite.getByRole('combobox', { name: 'Branch scope', exact: true }).selectOption(BRANCH);
  await invite.getByRole('button', { name: 'Create & send invite', exact: true }).click();
  await expect(page.getByRole('row', { name: /ZZ TEST Reception/ })).toBeVisible();
  const created = calls.find((call) => call.method === 'POST' && call.path === '/accounts')!;
  expect(created.body).toEqual({ phone: '+66800000002', employeeName: 'ZZ TEST Reception',
    roles: [{ roleName: 'reception', scopeType: 'branch', scopeId: BRANCH }] });
  expect(created.key).toBeTruthy();
  await expect(page.getByText('Account invited', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('accounts-phone.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('a temporary password requires confirmation, stays masked until asked for and is cleared on close', async ({ page }) => {
  const calls = await accountsFixture(page);
  const logs: string[] = [];
  page.on('console', (message) => logs.push(message.text()));
  await page.goto('/people/accounts');
  const som = page.getByRole('row', { name: /ZZ TEST Som/ });
  await som.getByTitle('Temporary password', { exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(calls.some((call) => call.path.endsWith('/temp-password'))).toBe(false);
  await som.getByTitle('Temporary password', { exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Issue temporary password', exact: true }).click();
  const issued = page.getByRole('dialog', { name: 'Temporary password for ZZ TEST Som', exact: true });
  await expect(issued).toBeVisible();
  expect(await page.content()).not.toContain(fixturePassword);
  await issued.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(issued.locator('code')).toHaveText(fixturePassword);
  await issued.getByRole('button', { name: 'Hide', exact: true }).click();
  expect(await page.content()).not.toContain(fixturePassword);
  await issued.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await page.content()).not.toContain(fixturePassword);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(fixturePassword);
  expect(logs.join('\n')).not.toContain(fixturePassword);
  await som.getByTitle('Temporary password', { exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Issue temporary password', exact: true }).click();
  await expect(issued.getByRole('button', { name: 'Show', exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(fixturePassword);
});

test('phone changes and deactivate/reactivate keep their original confirmations and server targets', async ({ page }) => {
  const calls = await accountsFixture(page);
  await page.goto('/people/accounts');
  const som = page.getByRole('row', { name: /ZZ TEST Som/ });
  await som.getByTitle('Change phone', { exact: true }).click();
  const phone = page.getByRole('dialog', { name: 'Change phone — ZZ TEST Som', exact: true });
  await phone.getByRole('textbox', { name: 'Phone Number', exact: true }).fill('800000003');
  await phone.getByRole('button', { name: 'Save phone', exact: true }).click();
  await expect(som).toContainText('+66800000003');
  expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ phone: '+66800000003' });
  await som.getByTitle('Deactivate', { exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  await som.getByTitle('Deactivate', { exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(som.getByTitle('Activate', { exact: true })).toBeVisible();
  await som.getByTitle('Activate', { exact: true }).click();
  await expect(som.getByTitle('Deactivate', { exact: true })).toBeVisible();
  expect(calls.filter((call) => call.method === 'PATCH').map((call) => ({ path: call.path, body: call.body }))).toEqual([
    { path: `/accounts/${SOM}`, body: { phone: '+66800000003' } },
    { path: `/accounts/${SOM}`, body: { status: 'inactive' } },
    { path: `/accounts/${SOM}`, body: { status: 'active' } },
  ]);
  expect(calls.every((call) => Boolean(call.key))).toBe(true);
});

test('sessions, shift-token ending and sign-out-everywhere retain the approved device controls', async ({ page }) => {
  const calls = await accountsFixture(page);
  await page.goto('/people/accounts');
  await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Sessions', { exact: true }).click();
  const sessions = page.getByRole('dialog', { name: 'Sessions — ZZ TEST Som', exact: true });
  await expect(sessions.getByText('locked', { exact: true })).toBeVisible();
  await expect(sessions.getByText('live', { exact: true })).toBeVisible();
  await expect(sessions).toContainText('Each lasts 16 hours');
  await sessions.getByRole('button', { name: 'End', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  await sessions.getByRole('button', { name: 'End', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End shift token', exact: true }).click();
  await expect(sessions.getByText('ended by a manager', { exact: true })).toBeVisible();
  await sessions.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  await expect(sessions.getByText('No sessions on record.', { exact: true })).toBeVisible();
  expect(calls.some((call) => call.path === `/accounts/${SOM}/sessions/revoke`)).toBe(true);
});

test('loading, failed reads and genuine empty searches never conceal a data-source failure', async ({ page }) => {
  await accountsFixture(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(ACCOUNT_LIST, async (route) => {
    await pending;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Account source did not answer.' } } });
  });
  await page.route('**/api/audit*', (route) => route.fulfill({ status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'Audit source did not answer.' } } }));
  await page.goto('/people/accounts');
  await expect(page.getByText('Loading accounts…', { exact: true })).toBeVisible();
  release!();
  await expect(page.getByRole('alert').filter({ hasText: 'Accounts could not be read.' })).toBeVisible();
  await expect(page.getByText('No accounts match this search.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'Recent denials could not be read.' })).toBeVisible();
  await expect(page.getByText(/Nothing refused recently/)).toHaveCount(0);
  await page.route(ACCOUNT_LIST, (route) => route.fulfill({ json: { accounts: [] } }));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No accounts match this search.', { exact: true })).toBeVisible();
});

test('a late earlier search cannot replace current results and the Accounts route retains its read guard', async ({ page }) => {
  await accountsFixture(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(ACCOUNT_LIST, async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'Som') return route.fallback();
    await pending;
    return route.fulfill({ json: { accounts: [row()] } });
  });
  await page.goto('/people/accounts');
  const search = page.getByRole('textbox', { name: 'Search name or phone', exact: true });
  await search.fill('Som');
  await search.fill('Mai');
  await expect(page.getByRole('row', { name: /ZZ TEST Mai/ })).toBeVisible();
  const earlier = page.waitForResponse((response) => new URL(response.url()).searchParams.get('q') === 'Som');
  release!();
  await earlier;
  await expect(page.getByRole('row', { name: /ZZ TEST Som/ })).toHaveCount(0);
  await accountsFixture(page, { read: false });
  await page.goto('/people/accounts');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
});

test('a delayed account action cannot replace another account’s open session or token details', async ({ page }) => {
  await accountsFixture(page);
  let somTokenReads = 0;
  await page.route('**/api/accounts/*/staff-tokens', (route) => {
    const isSom = route.request().url().includes(SOM);
    if (isSom) somTokenReads++;
    return route.fulfill({ json: { tokens: isSom ? [{
      jti: 'fixture-token-id', accountId: SOM, stationId: 'som-station', boxId: 'som-box',
      issuedAt: '2026-10-22T05:00:00Z', expiresAt: '2099-10-22T06:00:00Z', revokedAt: null, revokedReason: null,
    }] : [] } });
  });
  let releaseToken: (() => void) | undefined;
  const tokenPending = new Promise<void>((resolve) => { releaseToken = resolve; });
  await page.route('**/api/staff-tokens/fixture-token-id', async (route) => {
    await tokenPending;
    return route.fulfill({ json: { revoked: 1 } });
  });
  await page.goto('/people/accounts');
  const som = page.getByRole('row', { name: /ZZ TEST Som/ });
  const mai = page.getByRole('row', { name: /ZZ TEST Mai/ });
  await som.getByTitle('Sessions', { exact: true }).click();
  const somDialog = page.getByRole('dialog', { name: 'Sessions — ZZ TEST Som', exact: true });
  await somDialog.getByRole('button', { name: 'End', exact: true }).click();
  const tokenRequest = page.waitForRequest('**/api/staff-tokens/fixture-token-id');
  await page.getByRole('alertdialog').getByRole('button', { name: 'End shift token', exact: true }).click();
  await tokenRequest;
  await somDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await mai.getByTitle('Sessions', { exact: true }).click();
  const maiDialog = page.getByRole('dialog', { name: 'Sessions — ZZ TEST Mai', exact: true });
  await expect(maiDialog.getByText('No shift tokens on record.', { exact: true })).toBeVisible();
  const tokenResponse = page.waitForResponse('**/api/staff-tokens/fixture-token-id');
  releaseToken!();
  await tokenResponse;
  await page.waitForLoadState('networkidle');
  await expect(maiDialog.getByText('No shift tokens on record.', { exact: true })).toBeVisible();
  expect(somTokenReads).toBe(1);

  await maiDialog.getByRole('button', { name: 'Close', exact: true }).click();
  let releaseSessions: (() => void) | undefined;
  const sessionsPending = new Promise<void>((resolve) => { releaseSessions = resolve; });
  await page.route(`**/api/accounts/${SOM}/sessions/revoke`, async (route) => {
    await sessionsPending;
    return route.fulfill({ json: { sessionsEnded: 1 } });
  });
  await som.getByTitle('Sessions', { exact: true }).click();
  await somDialog.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  const sessionsRequest = page.waitForRequest(`**/api/accounts/${SOM}/sessions/revoke`);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  await sessionsRequest;
  await somDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await mai.getByTitle('Sessions', { exact: true }).click();
  await expect(maiDialog).toBeVisible();
  const sessionsResponse = page.waitForResponse(`**/api/accounts/${SOM}/sessions/revoke`);
  releaseSessions!();
  await sessionsResponse;
  await page.waitForLoadState('networkidle');
  await expect(maiDialog).toBeVisible();
  await expect(somDialog).toHaveCount(0);
});

test('only one temporary password can be issued while a previous rotation is pending', async ({ page }) => {
  await accountsFixture(page);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let rotations = 0;
  await page.route(`**/api/accounts/${SOM}/temp-password`, async (route) => {
    rotations++;
    if (rotations === 1) await pending;
    return route.fulfill({ json: { temporaryPassword: fixturePassword } });
  });
  await page.goto('/people/accounts');
  const action = page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Temporary password', { exact: true });
  await action.click();
  const request = page.waitForRequest(`**/api/accounts/${SOM}/temp-password`);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Issue temporary password', exact: true }).click();
  await request;
  await expect(action).toBeDisabled();
  expect(rotations).toBe(1);
  release!();
  const issued = page.getByRole('dialog', { name: 'Temporary password for ZZ TEST Som', exact: true });
  await expect(issued.getByRole('button', { name: 'Show', exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(fixturePassword);
  await issued.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(action).toBeEnabled();
  await action.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Issue temporary password', exact: true }).click();
  await expect(issued).toBeVisible();
  expect(rotations).toBe(2);
});
