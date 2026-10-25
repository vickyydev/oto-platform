import { expect, test, type Page } from '@playwright/test';

const PARK = '01900000-0000-7000-8000-000000000001';
const OTHER_PARK = '01900000-0000-7000-8000-000000000002';
const OPERATOR = '01900000-0000-7000-8000-000000000003';
const ACTOR = '01900000-0000-7000-8000-000000000004';
const permissions = ['app:console:access', 'admin:branch:read', 'admin:branch:create', 'admin:branch:update', 'admin:operator:read', 'admin:operator:create', 'admin:operator:update', 'catalog:holiday:read', 'catalog:holiday:manage', 'catalog:package:read', 'catalog:package:create'];
interface Park { id: string; name: string; code: string; timezone: string; country: string; address: string | null; openingHours: unknown; businessDayStart?: string; archived: boolean }
interface Holiday { id: string; name: string; startsOn: string; endsOn: string; pricedSales: number }

async function fixture(page: Page, options: { platform?: boolean; permissions?: string[] } = {}) {
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
  const runtimeErrors: Array<{ name: string; missingExport: string | null }> = [];
  page.on('pageerror', error => runtimeErrors.push({ name: error.name, missingExport: /does not provide an export named ['"]([A-Za-z_$][\w$]*)['"]/.exec(error.message)?.[1] ?? null }));
  const parks: Park[] = [
    { id: PARK, name: 'ZZ TEST Central', code: 'zz-central', timezone: 'Asia/Bangkok', country: 'TH', address: null, openingHours: null, businessDayStart: '05:00:00', archived: false },
    { id: OTHER_PARK, name: 'ZZ TEST Other park', code: 'zz-other', timezone: 'Asia/Bangkok', country: 'TH', address: null, openingHours: null, businessDayStart: '05:00:00', archived: false },
  ];
  const state = { actorId: ACTOR, branchId: PARK, operatorName: 'ZZ TEST Fixture operator', operatorArchived: false };
  const holidays: Record<string, Holiday[]> = {
    [PARK]: [{ id: 'zz-traded', name: 'ZZ TEST Traded holiday', startsOn: '2099-04-13', endsOn: '2099-04-15', pricedSales: 3 }],
    [OTHER_PARK]: [{ id: 'zz-other-range', name: 'ZZ TEST Other park holiday', startsOn: '2099-05-01', endsOn: '2099-05-02', pricedSales: 0 }],
  };
  await page.route('**/api/**', route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    // Development module paths also contain /api/; they are source, not API requests.
    if (!pathname.startsWith('/api/')) return route.fallback();
    const path = pathname.replace(/^\/api/, '');
    const method = request.method();
    let body: unknown;
    if (request.postData()) body = request.postDataJSON();
    calls.push({ method, path, body, key: request.headers()['idempotency-key'] });
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext(state.actorId, OPERATOR, (parks.find(park => park.id === state.branchId) ?? null)?.id ?? null),
      account: { id: state.actorId, phone: '', operatorId: OPERATOR, status: 'active', mustChangePassword: false },
      employee: { id: state.actorId, name: state.actorId === ACTOR ? 'ZZ TEST Administrator' : 'ZZ TEST Next administrator', nickname: null }, branch: parks.find(park => park.id === state.branchId) ?? null,
      isPlatformAdmin: options.platform ?? true, photoFileId: null, sessionLocked: false,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: (options.permissions ?? permissions).map(permission => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/operators' && method === 'GET') return route.fulfill({ json: { operators: state.operatorArchived ? [] : [{ id: OPERATOR, name: state.operatorName }] } });
    if (path === `/operators/${OPERATOR}` && method === 'PATCH') { const change = body as { name?: string; archived?: boolean }; if (change.name) state.operatorName = change.name; if (change.archived !== undefined) state.operatorArchived = change.archived; return route.fulfill({ json: { ok: true } }); }
    if (path === '/ops/demo-reset' && method === 'GET') return route.fulfill({ json: { available: false, confirmationPhrase: '' } });
    if (path === '/branches' && method === 'GET') return route.fulfill({ json: { branches: parks.filter(park => !park.archived) } });
    if (path === '/branches/oto-app' && method === 'GET') return route.fulfill({ json: { installed: true, branches: parks.map((park, index) => ({ branchId: park.id, branchName: park.name, status: 'SUCCESS', appBranchId: `zz-app-${index}`, appBranchName: park.name, error: null })), appOnly: [] } });
    if (path === '/me/session/branch' && method === 'PUT') { state.branchId = (body as { branchId: string }).branchId; return route.fulfill({ json: { ok: true } }); }
    if (path === '/auth/sign-in' && method === 'POST') { fixtureSessionActor = null; return route.fulfill({ json: { ok: true } }); }
    if (path.startsWith('/branches/') && method === 'PATCH' && !path.includes('/holidays/')) {
      const park = parks.find(row => path === `/branches/${row.id}`);
      if (park) { Object.assign(park, body); return route.fulfill({ json: { ok: true, otoApp: null } }); }
    }
    const holidayPath = /^\/branches\/([^/]+)\/holidays(?:\/([^/]+))?$/.exec(path);
    if (holidayPath) {
      const owner = holidayPath[1]!, id = holidayPath[2];
      if (method === 'GET') return route.fulfill({ json: { holidays: holidays[owner] ?? [] } });
      if (method === 'POST') { holidays[owner]!.push({ id: 'zz-created', ...(body as Omit<Holiday, 'id' | 'pricedSales'>), pricedSales: 0 }); return route.fulfill({ json: { id: 'zz-created' } }); }
      if (method === 'PATCH') { Object.assign(holidays[owner]!.find(range => range.id === id)!, body); return route.fulfill({ json: { ok: true } }); }
      if (method === 'DELETE') { holidays[owner] = holidays[owner]!.filter(range => range.id !== id); return route.fulfill({ json: { ok: true } }); }
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST action is not on fixture access.' } } });
  });
  return { calls, parks, runtimeErrors, state, holidays };
}

test('the platform Organisation page offers the approved operator name edit on the existing native row', async ({ page }) => {
  const { calls, runtimeErrors } = await fixture(page);
  await page.goto('/organisation/operators');
  await expect(page.getByRole('heading', { name: 'Operators', exact: true })).toBeVisible().catch(failure => { expect(runtimeErrors).toEqual([]); throw failure; });
  await expect(page.getByText('ZZ TEST Fixture operator', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Operator name', { exact: true }).fill('ZZ TEST Renamed operator');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByText('ZZ TEST Renamed operator', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.method !== 'GET')).toEqual([{ method: 'PATCH', path: `/operators/${OPERATOR}`, body: { name: 'ZZ TEST Renamed operator' }, key: expect.any(String) }]);
});

test('returning to Stored hours keeps an opaque legacy value unchanged when a branch name is saved', async ({ page }) => {
  const { calls, parks } = await fixture(page);
  parks[0]!.openingHours = { legacy: 'ZZ TEST opaque stored hours' };
  await page.goto('/organisation/branches');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const hours = page.getByRole('combobox', { name: 'Opening hours', exact: true });
  await expect(hours).toHaveValue('legacy');
  await hours.selectOption('weekly'); await hours.selectOption('legacy');
  await page.getByLabel('Branch name', { exact: true }).fill('ZZ TEST Renamed legacy park');
  await page.getByRole('button', { name: 'Save branch', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit branch', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: `/branches/${PARK}`, body: { name: 'ZZ TEST Renamed legacy park' }, key: expect.any(String) }]);
  expect(parks[0]!.openingHours).toEqual({ legacy: 'ZZ TEST opaque stored hours' });
});

test('an absent older business-day field is left absent during an unrelated name edit', async ({ page }) => {
  const { calls, parks } = await fixture(page);
  delete parks[0]!.businessDayStart;
  await page.goto('/organisation/branches');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.getByLabel('Branch name', { exact: true }).fill('ZZ TEST Renamed older park');
  await page.getByRole('button', { name: 'Save branch', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit branch', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: `/branches/${PARK}`, body: { name: 'ZZ TEST Renamed older park' }, key: expect.any(String) }]);
});

test('a delayed save from the first branch cannot close a newly opened second-branch draft', async ({ page }) => {
  const { calls } = await fixture(page);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/branches/${PARK}`, async route => { if (route.request().method() !== 'PATCH') return route.fallback(); await pending; return route.fallback(); });
  await page.goto('/organisation/branches');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.getByLabel('Branch name', { exact: true }).fill('ZZ TEST Delayed first park');
  const dispatched = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/branches/${PARK}`);
  await page.getByRole('button', { name: 'Save branch', exact: true }).click(); await dispatched;
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
  await page.getByLabel('Branch name', { exact: true }).fill('ZZ TEST Unsaved second park');
  const returned = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/branches/${PARK}`);
  release(); await (await returned).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('heading', { name: 'Edit branch', exact: true })).toBeVisible();
  await expect(page.getByLabel('Branch name', { exact: true })).toHaveValue('ZZ TEST Unsaved second park');
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
});

test('an invitation replay without a delivery field does not claim an SMS succeeded or failed', async ({ page }) => {
  await fixture(page);
  await page.route(`**/api/operators/${OPERATOR}/administrators`, route => route.fulfill({ json: { accountId: '01900000-0000-7000-8000-000000000005' } }));
  await page.goto('/organisation/operators');
  await page.getByRole('button', { name: 'Assign admin', exact: true }).click();
  await page.getByPlaceholder('e.g. Khun Anan', { exact: true }).fill('ZZ TEST Local invitation');
  await page.locator('input[type="tel"]').fill('999620000');
  await page.getByRole('button', { name: 'Invite administrator', exact: true }).click();
  await expect(page.getByText('Administrator invited', { exact: true })).toBeVisible();
  await expect(page.getByText(/setup code could not be texted|setup code has been texted/i)).toHaveCount(0);
});

test('operator archive requires its exact typed name before dispatch and reads back the hidden row', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.goto('/organisation/operators');
  await page.getByTitle('Archive (hidden from pickers)', { exact: true }).click();
  const confirmation = page.getByRole('textbox', { name: 'Confirm operator name', exact: true });
  await expect(confirmation).toBeVisible();
  const save = page.getByRole('button', { name: 'Archive operator', exact: true });
  await expect(save).toBeDisabled(); await confirmation.fill('zz test fixture operator'); await expect(save).toBeDisabled();
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  await confirmation.fill('ZZ TEST Fixture operator'); await save.click();
  await expect(page.getByText('ZZ TEST Fixture operator', { exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method !== 'GET')).toEqual([{ method: 'PATCH', path: `/operators/${OPERATOR}`, body: { archived: true, confirmName: 'ZZ TEST Fixture operator' }, key: expect.any(String) }]);
});

test('branch archive requires the current branch name before dispatch and reloads the branch directory', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.goto('/organisation/branches');
  await page.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
  await page.getByRole('button', { name: 'Archive branch', exact: true }).click();
  const confirmation = page.getByRole('textbox', { name: 'Confirm branch name', exact: true });
  await expect(confirmation).toBeVisible();
  const save = page.getByRole('alertdialog').getByRole('button', { name: 'Archive branch', exact: true });
  await expect(save).toBeDisabled(); await confirmation.fill('zz test other park'); await expect(save).toBeDisabled();
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  await confirmation.fill('ZZ TEST Other park'); await save.click();
  await expect(page.getByRole('heading', { name: 'Edit branch', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method !== 'GET')).toEqual([{ method: 'PATCH', path: `/branches/${OTHER_PARK}`, body: { archived: true, confirmName: 'ZZ TEST Other park' }, key: expect.any(String) }]);
});

test('direct Organisation addresses keep platform-only Operators and the Holidays permission without reading refused data', async ({ page }) => {
  const grants = permissions.filter(permission => permission !== 'catalog:holiday:manage');
  const { calls } = await fixture(page, { platform: false, permissions: grants });
  await page.goto('/organisation/operators');
  await expect(page.getByText('admin:operator:read', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create operator', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Operators', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.path === '/operators')).toEqual([]);
  await page.goto('/organisation/holidays');
  await expect(page.getByText('catalog:holiday:manage', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add range', exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.path === '/branches' || call.path.includes('/holidays'))).toEqual([]);
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
});

test('Switch here sends one keyed platform UUID and waits for the canonical session before marking the new park active', async ({ page }) => {
  const { calls, runtimeErrors } = await fixture(page);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const puts: Array<{ body: unknown; key: string | undefined }> = [];
  await page.route('**/api/me/session/branch', async route => {
    puts.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    await pending; return route.fallback();
  });
  await page.goto('/organisation/branches');
  await expect(page.getByRole('heading', { name: 'Registered branches', exact: true })).toBeVisible();
  await expect(page.getByText('Mapped', { exact: true })).toHaveCount(2);
  const button = page.getByRole('button', { name: 'Switch here', exact: true });
  await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ body: { branchId: OTHER_PARK }, key: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
  try {
    await expect(page.getByText('Active', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Switch here', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Registered branches', exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByText('Active', { exact: true }).locator('..')).toContainText('ZZ TEST Other park');
  expect(calls.filter(call => call.path === '/me')).toHaveLength(4);
  expect(puts).toHaveLength(1); expect(runtimeErrors).toEqual([]);
});

test('a branch-switch response from the old account cannot re-read or reseat a newly signed-in account', async ({ page }) => {
  const { calls, state, runtimeErrors } = await fixture(page);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let dispatched = 0;
  await page.route('**/api/me/session/branch', async route => { dispatched++; await pending; return route.fulfill({ json: { ok: true } }); });
  await page.goto('/organisation/branches');
  await page.getByRole('button', { name: 'Switch here', exact: true }).click();
  await expect.poll(() => dispatched).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('oto:unauthorized')));
  await expect(page.locator('input[type="password"]')).toBeVisible();
  state.actorId = '01900000-0000-7000-8000-000000000006'; state.branchId = PARK;
  await page.locator('input[type="tel"]').fill('+66999620001');
  await page.locator('input[type="password"]').fill('ZZ TEST synthetic sign-in');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Registered branches', exact: true })).toBeVisible();
  const readsBefore = calls.filter(call => call.path === '/me').length;
  const response = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/me/session/branch');
  release(); await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('Active', { exact: true }).locator('..')).toContainText('ZZ TEST Central');
  expect(calls.filter(call => call.path === '/me')).toHaveLength(readsBefore);
  expect(dispatched).toBe(1); expect(runtimeErrors).toEqual([]);
});

test('Holidays keeps sold dates fixed and reads back the canonical renamed range at its selected park', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.goto('/organisation/holidays');
  await page.getByRole('button', { name: 'Edit ZZ TEST Traded holiday', exact: true }).click();
  await expect(page.getByLabel('Start date', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('End date', { exact: true })).toBeDisabled();
  await expect(page.getByText(/3 sales were priced by this range/)).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('ZZ TEST Corrected holiday');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Corrected holiday', exact: true })).toBeVisible();
  expect(calls.filter(call => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: `/branches/${PARK}/holidays/zz-traded`, body: { name: 'ZZ TEST Corrected holiday', startsOn: '2099-04-13', endsOn: '2099-04-15' }, key: expect.any(String) }]);
});

test('a late holiday save cannot replace the newly selected park with the previous park calendar', async ({ page }) => {
  const { calls } = await fixture(page);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/branches/${PARK}/holidays/zz-traded`, async route => { if (route.request().method() !== 'PATCH') return route.fallback(); await pending; return route.fallback(); });
  await page.goto('/organisation/holidays');
  await page.getByRole('button', { name: 'Edit ZZ TEST Traded holiday', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('ZZ TEST Late first-park holiday');
  const dispatched = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith('/holidays/zz-traded'));
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await dispatched;
  await page.getByRole('combobox', { name: 'Park', exact: true }).selectOption(OTHER_PARK);
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Other park holiday', exact: true })).toBeVisible();
  const oldReads = calls.filter(call => call.method === 'GET' && call.path === `/branches/${PARK}/holidays`).length;
  const returned = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname.endsWith('/holidays/zz-traded'));
  release(); await (await returned).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Edit ZZ TEST Other park holiday', exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Late first-park holiday', { exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method === 'GET' && call.path === `/branches/${PARK}/holidays`)).toHaveLength(oldReads);
});

test('the native branch editor and Holidays controls fit a 390px phone', async ({ page }) => {
  const { parks } = await fixture(page); await page.setViewportSize({ width: 390, height: 844 });
  parks[0]!.code = 'z'.repeat(40); parks[0]!.name = 'ZZ TEST Central park with a long existing branch name';
  await page.goto('/organisation/branches');
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText('Active', { exact: true }).locator('..')).toContainText(parks[0]!.name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByLabel('Business day start', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto('/organisation/holidays');
  await expect(page.getByRole('heading', { name: 'Holidays / weekend overrides', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add range', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

for (const failingRead of ['me', 'permissions'] as const) test(`an accepted branch switch removes stale authority while its canonical ${failingRead} read is pending or fails`, async ({ page }) => {
  const { calls, state } = await fixture(page);
  let accepted = false, waiting = false, unavailable = true, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/me/session/branch', route => { accepted = true; return route.fallback(); });
  const path = failingRead === 'me' ? '/api/me' : '/api/me/permissions';
  await page.route('**' + path, async route => {
    if (!accepted || !unavailable) return route.fallback(); waiting = true; await held;
    return route.fulfill({ status: 500, json: { error: { code: 'UNAVAILABLE', message: 'ZZ TEST canonical session read failed.' } } });
  });
  await page.goto('/organisation/branches');
  await page.getByRole('button', { name: 'Switch here', exact: true }).click();
  await expect.poll(() => waiting).toBe(true);
  try {
    await expect(page.getByText('Active', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Registered branches', exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'Confirm the current operator', exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST canonical session read failed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(page.getByText('Active', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch here', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Registered branches', exact: true })).toHaveCount(0);
  expect(state.branchId).toBe(OTHER_PARK);
  expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/clone'))).toEqual([]);
  const writesBeforeRetry = calls.filter(call => call.method === 'PUT' && call.path === '/me/session/branch');
  expect(writesBeforeRetry).toHaveLength(1);
  expect(writesBeforeRetry[0]).toMatchObject({ body: { branchId: OTHER_PARK }, key: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
  unavailable = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Active', { exact: true }).locator('..')).toContainText('ZZ TEST Other park');
  expect(calls.filter(call => call.method === 'PUT' && call.path === '/me/session/branch')).toEqual(writesBeforeRetry);
  expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/clone'))).toEqual([]);
});

test('a completed holiday save cannot erase a different range draft opened while it was pending', async ({ page }) => {
  const { holidays } = await fixture(page);
  holidays[PARK]!.push({ id: 'zz-second-range', name: 'ZZ TEST Second range', startsOn: '2099-06-01', endsOn: '2099-06-02', pricedSales: 0 });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/branches/${PARK}/holidays/zz-traded`, async route => { if (route.request().method() !== 'PATCH') return route.fallback(); await held; return route.fallback(); });
  await page.goto('/organisation/holidays');
  await page.getByRole('button', { name: 'Edit ZZ TEST Traded holiday', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('ZZ TEST First completed save');
  const sent = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith('/holidays/zz-traded'));
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await sent;
  await page.getByRole('button', { name: 'Edit ZZ TEST Second range', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('ZZ TEST Unsaved second range');
  const readback = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/branches/${PARK}/holidays`);
  release(); await (await readback).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('ZZ TEST Unsaved second range');
});

test('a completed branch creation cannot discard a new form opened after the first form was cancelled', async ({ page }) => {
  const { parks } = await fixture(page);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/branches', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as { name: string; code: string };
    await held; const id = '01900000-0000-7000-8000-000000000007';
    parks.push({ ...parks[0]!, id, name: body.name, code: body.code });
    return route.fulfill({ json: { id, otoApp: null } });
  });
  await page.goto('/organisation/branches');
  await page.getByRole('button', { name: 'Add a branch', exact: true }).click();
  await page.getByPlaceholder('e.g. HKT Chalong', { exact: true }).fill('ZZ TEST First queued park');
  const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/branches');
  await page.getByRole('button', { name: 'Create branch', exact: true }).click(); await sent;
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add a branch', exact: true }).click();
  await page.getByPlaceholder('e.g. HKT Chalong', { exact: true }).fill('ZZ TEST Unsaved new park');
  const readback = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/branches');
  release(); await (await readback).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByPlaceholder('e.g. HKT Chalong', { exact: true })).toHaveValue('ZZ TEST Unsaved new park');
});

test('an explicit switch refusal keeps its native error, while an uncertain accepted write removes the old branch authority', async ({ page }) => {
  const { state } = await fixture(page); const keys: Array<string | undefined> = [];
  const bodies: unknown[] = [];
  let uncertain = false, canonicalUnavailable = true, canonicalFailures = 0;
  await page.route('**/api/me', route => {
    if (!uncertain || !canonicalUnavailable) return route.fallback();
    canonicalFailures++;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'ZZ TEST uncertain branch read unavailable.' } } });
  });
  await page.route('**/api/me/session/branch', route => {
    keys.push(route.request().headers()['idempotency-key']);
    bodies.push(route.request().postDataJSON());
    if (keys.length === 1) return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST no access at selected park' } } });
    // The server moved the original session before its connection failed.
    uncertain = true; state.branchId = OTHER_PARK; return route.abort('failed');
  });
  await page.goto('/organisation/branches');
  await page.getByRole('button', { name: 'Switch here', exact: true }).click();
  await expect(page.getByText('ZZ TEST no access at selected park', { exact: true })).toBeVisible();
  await expect(page.getByText('Active', { exact: true }).locator('..')).toContainText('ZZ TEST Central');
  await page.getByRole('button', { name: 'Switch here', exact: true }).click();
  await expect.poll(() => state.branchId).toBe(OTHER_PARK);
  await expect(page.getByText('Active', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Registered branches', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch here', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Confirm the current operator', exact: true })).toBeVisible();
  expect(canonicalFailures).toBe(1);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(keys).toHaveLength(3); expect(new Set(keys).size).toBe(2);
  expect(keys[0]).not.toBe(keys[1]); expect(keys[1]).toBe(keys[2]);
  expect(bodies).toEqual([{ branchId: OTHER_PARK }, { branchId: OTHER_PARK }, { branchId: OTHER_PARK }]);
  canonicalUnavailable = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Active', { exact: true }).locator('..')).toContainText('ZZ TEST Other park');
  await expect(page.getByText('ZZ TEST no access at selected park', { exact: true })).toHaveCount(0);
  expect(keys).toHaveLength(3);
});
