import { expect, test, type Page } from '@playwright/test';

const HOME = '01964000-0000-7000-8000-000000000001';
const OTHER = '01964000-0000-7000-8000-000000000002';
const ACTOR = '01964000-0000-7000-8000-000000000003';
const NEXT_ACTOR = '01964000-0000-7000-8000-000000000004';
const HOME_PARK = '01964000-0000-7000-8000-000000000005';
const OTHER_PARK = '01964000-0000-7000-8000-000000000006';
const SESSION = '01964000-0000-7000-8000-000000000009';
const NEXT_SESSION = '01964000-0000-7000-8000-00000000000a';
const HOME_NAME = 'ZZ TEST Home operator';
const OTHER_NAME = 'ZZ TEST Working operator';
const basicPermissions = ['app:console:access', 'admin:branch:read', 'admin:account:read', 'analytics:read', 'app:oto_app:access'];

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
type Gate = ReturnType<typeof deferred>;
type Call = { method: string; path: string; body: unknown; key?: string; actor: string; operator: string; revision: number; sessionId: string };

/** Native App and SessionProvider; every business/auth response is synthetic and local. */
async function fixture(page: Page) {
  const calls: Call[] = [];
  const state = { actor: ACTOR, sessionId: SESSION, signedIn: true, override: null as string | null, revision: 0, branchId: HOME_PARK as string | null,
    locked: false, temporary: false, platform: true, switchScope: 'global' as 'global' | 'own' | 'branch' | null,
    meStatus: 200, operatorsStatus: 200, putStatus: 200, abortPut: false,
    choices: [{ id: OTHER, name: OTHER_NAME }, { id: HOME, name: HOME_NAME }] };
  const gates: { put?: Gate; me?: Gate; permissions?: Gate; operators?: Gate } = {};
  const effective = () => state.override ?? HOME;
  const context = () => ({ homeOperatorId: HOME, effectiveOperatorId: effective(), operatorOverride: state.override,
    branchId: state.branchId, stationId: null, revision: state.revision, sessionId: state.sessionId });
  const parks = () => [{ id: effective() === HOME ? HOME_PARK : OTHER_PARK,
    name: `ZZ TEST ${effective() === HOME ? 'Home' : 'Working'} park r${state.revision}`,
    code: 'zz-test', timezone: 'Asia/Bangkok', country: 'TH', address: null, openingHours: null,
    businessDayStart: '05:00:00', archived: false }];
  const permissions = () => [...basicPermissions.map(permission => ({ permission, scopeType: 'operator', scopeId: null as string | null })),
    ...(state.switchScope ? [{ permission: 'platform:operator:switch', scopeType: state.switchScope === 'branch' ? 'branch' : 'operator',
      scopeId: state.switchScope === 'global' ? null : state.switchScope === 'own' ? HOME : HOME_PARK }] : [])];

  // Observe dispatch itself, including the deliberately held per-test routes.
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
    calls.push({ method: request.method(), path, body: request.postData() ? request.postDataJSON() : undefined,
      key: request.headers()['idempotency-key'], actor: state.actor, operator: effective(),
      revision: state.revision, sessionId: state.sessionId });
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
    const method = request.method(), body: unknown = request.postData() ? request.postDataJSON() : undefined;
    if (path === '/me' && method === 'GET') {
      const reply = { account: { id: state.actor, phone: '', status: 'active', mustChangePassword: state.temporary, operatorId: HOME },
        employee: { id: state.actor, name: state.actor === ACTOR ? 'ZZ TEST Original actor' : 'ZZ TEST Next actor', nickname: null },
        branch: state.branchId ? parks().find(park => park.id === state.branchId) ?? null : null,
        isPlatformAdmin: state.platform, photoFileId: null, sessionLocked: state.locked,
        preferences: { theme: 'system', language: 'en' }, operatorContext: context() };
      const status = !state.signedIn ? 401 : state.meStatus;
      await gates.me?.promise;
      return status === 200 ? route.fulfill({ json: reply })
        : route.fulfill({ status, json: { error: { code: 'ZZ_TEST_SESSION_READ', message: 'ZZ TEST session context unavailable' } } });
    }
    if (path === '/me/permissions' && method === 'GET') {
      const reply = { permissions: permissions() }; await gates.permissions?.promise;
      return route.fulfill({ json: reply });
    }
    if (path === '/operators' && method === 'GET') {
      const reply = { operators: structuredClone(state.choices) }, status = state.operatorsStatus;
      await gates.operators?.promise;
      return status === 200 ? route.fulfill({ json: reply })
        : route.fulfill({ status, json: { error: { code: 'ZZ_TEST_OPERATORS', message: 'ZZ TEST operators unavailable' } } });
    }
    if (path === '/me/session/operator' && method === 'PUT') {
      const selection = body as { operatorId: string | null; expectedRevision: number };
      if (state.putStatus !== 200) return route.fulfill({ status: state.putStatus,
        json: { error: { code: 'ZZ_TEST_SELECTION_REFUSED', message: 'ZZ TEST operator selection refused' } } });
      if (selection.expectedRevision !== state.revision) return route.fulfill({ status: 409,
        json: { error: { code: 'OPERATOR_SWITCH_STALE', message: 'Read the current operator again.' } } });
      const previous = effective();
      state.override = selection.operatorId === HOME ? null : selection.operatorId;
      if (previous !== effective()) state.branchId = null;
      state.revision++;
      const reply = { homeOperatorId: HOME, effectiveOperatorId: effective(), operatorOverride: state.override,
        branchId: state.branchId, stationId: null, revision: state.revision, changed: previous !== effective() };
      await gates.put?.promise;
      if (state.abortPut) return route.abort('failed');
      return route.fulfill({ json: reply });
    }
    if (path === '/me/session/branch' && method === 'PUT') {
      state.branchId = (body as { branchId: string }).branchId;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/auth/sign-in' && method === 'POST') { state.signedIn = true; return route.fulfill({ json: { ok: true } }); }
    if (path === '/auth/sign-out' && method === 'POST') { state.signedIn = false; return route.fulfill({ json: { ok: true } }); }
    if (path === '/branches' && method === 'GET') return route.fulfill({ json: { branches: parks() } });
    if (path === '/branches/oto-app') return route.fulfill({ json: { installed: false, branches: [], appOnly: [] } });
    if (path === '/analytics/booths') return route.fulfill({ json: { booths: [], prizes: [], staff: [], lastRolledUpAt: null } });
    if (path === '/employees') return route.fulfill({ json: { employees: [] } });
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Not on this fixture access.' } } });
  });
  return { state, gates, calls, context, parks };
}

const picker = (page: Page) => page.getByRole('combobox', { name: 'Operator', exact: true });
const selections = (calls: Call[]) => calls.filter(call => call.method === 'PUT' && call.path === '/me/session/operator');
const parkText = (page: Page, owner: 'Home' | 'Working', revision: number) => page.getByRole('main').getByText(`ZZ TEST ${owner} park r${revision}`, { exact: true });
async function start(page: Page) {
  await page.goto('/organisation/branches');
  await expect(picker(page)).toHaveValue(HOME);
  await expect(parkText(page, 'Home', 0).first()).toBeVisible();
}
async function select(page: Page, operatorId: string) {
  await picker(page).selectOption(operatorId);
  await expect(picker(page)).toHaveValue(operatorId);
  await expect(picker(page)).toBeEnabled();
}
async function blockedPicker(page: Page) {
  await expect.poll(async () => await picker(page).count() === 0 || await picker(page).isDisabled()).toBe(true);
}
async function refreshSession(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('oto:session-locked')));
}
async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('operator choices use canonical current rather than the first row and keep home identity visible after switching', async ({ page }) => {
  const f = await fixture(page); await start(page);
  await expect(page.getByText(`Home operator: ${HOME_NAME}`, { exact: true })).toBeVisible();
  await select(page, OTHER);
  await expect(parkText(page, 'Working', 1).first()).toBeVisible();
  await expect(page.getByText(`Home operator: ${HOME_NAME}`, { exact: true })).toBeVisible();
  await select(page, HOME);
  expect(selections(f.calls)).toEqual([
    expect.objectContaining({ body: { operatorId: OTHER, expectedRevision: 0 }, key: expect.any(String), operator: HOME }),
    expect.objectContaining({ body: { operatorId: HOME, expectedRevision: 1 }, key: expect.any(String), operator: OTHER }),
  ]);
  expect(new Set(selections(f.calls).map(call => call.key)).size).toBe(2);
  expect(f.context()).toMatchObject({ homeOperatorId: HOME, effectiveOperatorId: HOME, operatorOverride: null, branchId: null, revision: 2 });
});

for (const scope of [null, 'own', 'branch'] as const) test(`a ${scope ?? 'missing'} switch grant offers no operator switch`, async ({ page }) => {
  const f = await fixture(page); f.state.switchScope = scope;
  await page.goto('/organisation/branches'); await expect(parkText(page, 'Home', 0).first()).toBeVisible();
  await expect(picker(page)).toHaveCount(0); expect(selections(f.calls)).toEqual([]);
});

test('a canonical current operator absent from live choices stays unselected and disabled, without a home fallback', async ({ page }) => {
  const f = await fixture(page); f.state.override = OTHER; f.state.branchId = null; f.state.revision = 1;
  f.state.choices = [{ id: HOME, name: HOME_NAME }];
  await page.goto('/organisation/branches'); await expect(picker(page)).toHaveValue(''); await expect(picker(page)).toBeDisabled();
  expect(selections(f.calls)).toEqual([]);
});

test('an operator switch masks old controls at PUT dispatch, before the held acknowledgement', async ({ page }) => {
  const f = await fixture(page); await start(page); const gate = deferred(); f.gates.put = gate;
  const dispatched = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/me/session/operator');
  await picker(page).selectOption(OTHER); await dispatched;
  try {
    await expect(parkText(page, 'Home', 0)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Switch here', exact: true })).toHaveCount(0);
    await blockedPicker(page); expect(selections(f.calls)).toHaveLength(1);
  } finally { gate.release(); }
  await expect(picker(page)).toHaveValue(OTHER); await expect(parkText(page, 'Working', 1).first()).toBeVisible();
});

for (const read of ['me', 'permissions'] as const) test(`a held canonical ${read} response cannot leave home data or an optimistic target active`, async ({ page }) => {
  const f = await fixture(page); await start(page); const gate = deferred(); f.gates[read] = gate;
  await picker(page).selectOption(OTHER);
  await expect.poll(() => selections(f.calls).length).toBe(1);
  await expect.poll(() => f.calls.some(call => call.method === 'GET'
    && call.path === (read === 'me' ? '/me' : '/me/permissions') && call.revision === 1)).toBe(true);
  try {
    await expect(parkText(page, 'Home', 0)).toHaveCount(0); await blockedPicker(page);
  } finally { gate.release(); }
  await expect(picker(page)).toHaveValue(OTHER); await expect(parkText(page, 'Working', 1).first()).toBeVisible();
});

test('an uncertain committed switch with failed canonical reads stays unavailable until Retry confirms B', async ({ page }) => {
  const f = await fixture(page); await start(page); f.state.abortPut = true; f.state.meStatus = 503;
  await picker(page).selectOption(OTHER); await expect.poll(() => f.state.revision).toBe(1);
  await expect(parkText(page, 'Home', 0)).toHaveCount(0); await blockedPicker(page);
  const retry = page.getByRole('button', { name: /retry/i }).first(); await expect(retry).toBeVisible();
  f.state.abortPut = false; f.state.meStatus = 200; await retry.click();
  await expect(picker(page)).toHaveValue(OTHER); await expect(parkText(page, 'Working', 1).first()).toBeVisible();
  const attempts = selections(f.calls); expect(attempts.length).toBeGreaterThanOrEqual(1);
  expect(new Set(attempts.map(call => call.key)).size).toBe(1);
  for (const attempt of attempts) expect(attempt.body).toEqual({ operatorId: OTHER, expectedRevision: 0 });
});

test('an operator-list error has Retry and never selects the first option or dispatches a write', async ({ page }) => {
  const f = await fixture(page); f.state.operatorsStatus = 503;
  await page.goto('/organisation/branches'); await blockedPicker(page);
  const retry = page.getByRole('button', { name: /retry/i }).first(); await expect(retry).toBeVisible();
  f.state.operatorsStatus = 200; await retry.click(); await expect(picker(page)).toHaveValue(HOME); await expect(picker(page)).toBeEnabled();
  expect(selections(f.calls)).toEqual([]);
});

test('an explicit selection refusal preserves its error and cannot claim a confirmed new operator', async ({ page }) => {
  const f = await fixture(page); await start(page); f.state.putStatus = 403;
  await picker(page).selectOption(OTHER);
  await expect(page.getByText('ZZ TEST operator selection refused', { exact: false })).toBeVisible();
  expect(f.context()).toMatchObject({ effectiveOperatorId: HOME, revision: 0 });
  await expect(picker(page)).not.toHaveValue(OTHER); expect(selections(f.calls)).toHaveLength(1);
});

test('a late B acknowledgement cannot replace a newer canonical home context after A-B-A', async ({ page }) => {
  const f = await fixture(page); await start(page); const gate = deferred(); f.gates.put = gate;
  await picker(page).selectOption(OTHER); await expect.poll(() => f.state.revision).toBe(1);
  f.state.override = null; f.state.revision = 2; await refreshSession(page);
  gate.release(); await expect(picker(page)).toHaveValue(HOME); await expect(parkText(page, 'Home', 2).first()).toBeVisible();
  await settleFrames(page); await expect(parkText(page, 'Working', 1)).toHaveCount(0); expect(selections(f.calls)).toHaveLength(1);
});

for (const replacement of ['signed out', 'new actor'] as const) test(`a held old switch cannot revive authority after ${replacement}`, async ({ page }) => {
  const f = await fixture(page); await start(page); const gate = deferred(); f.gates.put = gate;
  await picker(page).selectOption(OTHER); await expect.poll(() => f.state.revision).toBe(1);
  if (replacement === 'signed out') {
    f.state.signedIn = false;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('oto:unauthorized')));
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  } else {
    f.state.actor = NEXT_ACTOR; f.state.override = null; f.state.revision = 0; f.state.branchId = HOME_PARK;
    await refreshSession(page); await expect(page.getByText('ZZ TEST Next actor', { exact: true }).first()).toBeVisible();
  }
  gate.release(); await settleFrames(page);
  if (replacement === 'signed out') await expect(picker(page)).toHaveCount(0);
  else { await expect(picker(page)).toHaveValue(HOME); await expect(parkText(page, 'Working', 1)).toHaveCount(0); }
  expect(selections(f.calls)).toHaveLength(1);
});

for (const loss of ['locked', 'temporary password', 'grant withdrawn'] as const) test(`fresh ${loss} state cannot retain active operator controls`, async ({ page }) => {
  const f = await fixture(page); await start(page);
  if (loss === 'locked') f.state.locked = true;
  if (loss === 'temporary password') f.state.temporary = true;
  if (loss === 'grant withdrawn') f.state.switchScope = null;
  await refreshSession(page);
  if (loss === 'temporary password') await expect(page.getByRole('heading', { name: 'Choose a password first', exact: true })).toBeVisible();
  else if (loss === 'grant withdrawn') await expect(picker(page)).toHaveCount(0);
  else await blockedPicker(page);
  expect(selections(f.calls)).toEqual([]);
});

test('an old readonly response released after switching cannot replace the new operator directory', async ({ page }) => {
  const f = await fixture(page); await start(page); const gate = deferred(); let waiting = false;
  await page.route('**/api/branches', async route => {
    if (f.state.override !== null) return route.fallback();
    waiting = true; const old = f.parks(); await gate.promise;
    return route.fulfill({ json: { branches: old.map(row => ({ ...row, name: 'ZZ TEST stale A directory' })) } });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect.poll(() => waiting).toBe(true);
  await select(page, OTHER);
  const returned = page.waitForResponse(response => new URL(response.url()).pathname === '/api/branches');
  gate.release(); await (await returned).finished(); await settleFrames(page);
  await expect(parkText(page, 'Working', 1).first()).toBeVisible(); await expect(page.getByText('ZZ TEST stale A directory', { exact: true })).toHaveCount(0);
});

test('a held old export cannot download after the operator context changes', async ({ page }) => {
  await fixture(page); await page.goto('/reports/booths'); await expect(picker(page)).toHaveValue(HOME);
  const gate = deferred(); let waiting = false; const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.route('**/api/analytics/booths/export?*', async route => {
    waiting = true; await gate.promise;
    return route.fulfill({ contentType: 'text/csv', headers: { 'content-disposition': 'attachment; filename="zz-test-old.csv"' }, body: 'synthetic,count\nold,1\n' });
  });
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click(); await expect.poll(() => waiting).toBe(true);
  await select(page, OTHER);
  const returned = page.waitForResponse(response => new URL(response.url()).pathname === '/api/analytics/booths/export');
  gate.release(); await (await returned).finished(); await settleFrames(page); expect(downloads).toEqual([]);
});

test('an old acting-user handoff response cannot navigate after the operator context changes', async ({ page }) => {
  const f = await fixture(page); const gate = deferred(); let waiting = false;
  await page.route('**/api/employees*', route => route.fulfill({ json: { employees: f.state.override === null ? [{
    id: '01964000-0000-7000-8000-000000000007', name: 'ZZ TEST Source employee', nickname: null,
    source: 'otoapp', externalId: '01964000-0000-7000-8000-000000000008', archivedAt: null,
    branch: { id: HOME_PARK, name: 'ZZ TEST Home park' }, department: null, accounts: [], lastSignInAt: null,
  }] : [] } }));
  await page.route('**/api/auth/handoff', async route => {
    waiting = true; await gate.promise;
    return route.fulfill({ json: { launchUrl: new URL('/zz-test-local-source#handoff=synthetic-only', page.url()).href } });
  });
  await page.goto('/people/employees'); await expect(picker(page)).toHaveValue(HOME);
  await page.getByRole('button', { name: 'Open in OTO App', exact: true }).click(); await expect.poll(() => waiting).toBe(true);
  await select(page, OTHER);
  const returned = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/handoff');
  gate.release(); await (await returned).finished(); await settleFrames(page);
  expect(new URL(page.url()).pathname).toBe('/people/employees');
  expect(f.calls.filter(call => call.path === '/auth/handoff')).toHaveLength(1);
});

test('home and canonical operator controls fit a 390px phone without horizontal overflow', async ({ page }) => {
  const f = await fixture(page); f.state.choices[1]!.name = `${HOME_NAME} with a deliberately long existing name`;
  await page.setViewportSize({ width: 390, height: 844 }); await start(page);
  await expect(page.getByText(`Home operator: ${f.state.choices[1]!.name}`, { exact: true })).toBeVisible();
  const bounds = await picker(page).boundingBox(); expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await select(page, OTHER); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

for (const replacement of ['same actor, new session', 'new actor, new session'] as const) {
  test(`a mutation canonical read replaced by ${replacement} cannot publish its old refusal into the replacement`, async ({ page }) => {
    const f = await fixture(page);
    await start(page);
    const firstRead = deferred(), freshRead = deferred();
    const beforeMeReads = f.calls.filter(call => call.path === '/me' && call.method === 'GET').length;
    let mutationMeReads = 0;
    await page.route('**/api/me', async route => {
      mutationMeReads++;
      // The third read must still be unconfirmed: either a fresh epoch's
      // first read, or the old implementation's incorrectly reused retry.
      if (mutationMeReads === 3) await freshRead.promise;
      return route.fallback();
    });
    await page.evaluate(() => {
      const state = window as unknown as { zzOldMutationError?: boolean; zzMutationObserver?: MutationObserver };
      state.zzOldMutationError = false;
      const observe = () => {
        if (document.body.textContent?.includes('ZZ TEST operator selection refused')) state.zzOldMutationError = true;
      };
      state.zzMutationObserver = new MutationObserver(observe);
      state.zzMutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    f.gates.me = firstRead;
    f.state.putStatus = 403;
    try {
      await picker(page).selectOption(OTHER);
      await expect.poll(() => f.calls.filter(call => call.path === '/me' && call.method === 'GET').length)
        .toBe(beforeMeReads + 1);
      // The first mutation read has captured the old identity. Replace the
      // cookie's session before the second canonical read, without an event.
      f.state.sessionId = NEXT_SESSION;
      if (replacement === 'new actor, new session') f.state.actor = NEXT_ACTOR;
      f.state.revision = 7;
      firstRead.release();
      await expect.poll(() => mutationMeReads).toBe(3);
      await blockedPicker(page);
      await expect(parkText(page, 'Home', 7)).toHaveCount(0);
      await expect(page.getByText('ZZ TEST operator selection refused', { exact: false })).toHaveCount(0);
      expect(f.calls.filter(call => call.path === '/operators' && call.sessionId === NEXT_SESSION)).toEqual([]);
      freshRead.release();
      await expect(picker(page)).toHaveValue(HOME);
      await expect(picker(page)).toBeEnabled();
      await expect(parkText(page, 'Home', 7).first()).toBeVisible();
      await expect(page.getByText(replacement === 'same actor, new session'
        ? 'ZZ TEST Original actor' : 'ZZ TEST Next actor', { exact: true }).first()).toBeVisible();
      await settleFrames(page);
      expect(await page.evaluate(() => (window as unknown as { zzOldMutationError?: boolean }).zzOldMutationError)).toBe(false);
      await expect(page.getByText('ZZ TEST operator selection refused', { exact: false })).toHaveCount(0);
      // A replacement gets one metadata read after its own fresh handshake;
      // the old mutation must not first publish it and fetch its choices.
      expect(f.calls.filter(call => call.path === '/operators' && call.sessionId === NEXT_SESSION)).toHaveLength(1);
      expect(selections(f.calls)).toHaveLength(1);
    } finally {
      firstRead.release();
      freshRead.release();
      await page.evaluate(() => {
        (window as unknown as { zzMutationObserver?: MutationObserver }).zzMutationObserver?.disconnect();
      });
    }
  });
}
