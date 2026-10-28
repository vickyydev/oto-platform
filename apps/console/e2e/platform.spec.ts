import { expect, test, type Page, type Route } from '@playwright/test';

const OPERATOR = '01963900-0000-7000-8000-000000000001';
const OTHER_OPERATOR = '01963900-0000-7000-8000-000000000002';
const ACTOR = '01963900-0000-7000-8000-000000000003';
const OTHER_ACTOR = '01963900-0000-7000-8000-000000000004';
const BRANCH = '01963900-0000-7000-8000-000000000005';
const OTHER_BRANCH = '01963900-0000-7000-8000-000000000006';
const GENERATED = '2026-10-25T10:00:00.000Z';
const permission = (name: string, scopeId: string | null = null, scopeType = 'operator') => ({ permission: name, scopeType, scopeId });
const allPermissions = () => [
  'app:console:access', 'admin:operator:read', 'admin:role:read', 'admin:health:read', 'admin:ops:manage',
].map((name) => permission(name));

type Authority = {
  actor: string; operator: string; branch: string | null; platform: boolean;
  active: boolean; locked: boolean; mustChangePassword: boolean;
  permissions: ReturnType<typeof permission>[];
};
type Call = { method: string; path: string; query: string; body: string | null };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const defaultJob = (name = 'job:ZZ_TEST_persisted') => ({
  name, status: 'unknown', lastRunAt: null, lastOutcome: null,
  expectedEverySeconds: 60, ageSeconds: null, lastError: null, waitingOn: ['database'],
});
const alert = (id: string, title: string, resolved = false) => ({
  id, key: `ZZ_TEST_${id}`, severity: resolved ? 'info' : 'critical', title,
  detail: 'ZZ TEST persisted alert detail', openedAt: GENERATED, acknowledgedAt: GENERATED,
  resolvedAt: resolved ? GENERATED : null, count: 3,
});

/** These fixtures intercept the built Console; no control reaches a real API. */
async function fixture(page: Page, initial: Partial<Authority> = {}) {
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

  const authority: Authority = {
    actor: ACTOR, operator: OPERATOR, branch: null, platform: true, active: true,
    locked: false, mustChangePassword: false, permissions: allPermissions(), ...initial,
  };
  const calls: Call[] = [];
  const jobs = { rows: [defaultJob()], fail: false };
  const controls = { available: true, gate: null as ReturnType<typeof deferred> | null };
  const reads = new Map<string, (route: Route) => Promise<void>>();
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
    calls.push({ method: request.method(), path, query: url.search, body: request.postData() });
    if (path === '/me' && !authority.active) return route.fulfill({ status: 401,
      json: { error: { code: 'UNAUTHORIZED', message: 'Not signed in' } } });
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext(authority.actor, authority.operator, (authority.branch ? { id: authority.branch, name: 'ZZ TEST Park', code: 'ZZ', timezone: 'Asia/Bangkok' } : null)?.id ?? null),
      account: { id: authority.actor, operatorId: authority.operator, phone: '',
        status: authority.active ? 'active' : 'inactive', mustChangePassword: authority.mustChangePassword },
      employee: { id: authority.actor, name: authority.actor === ACTOR ? 'ZZ TEST Platform Admin' : 'ZZ TEST Next Admin', nickname: null },
      branch: authority.branch ? { id: authority.branch, name: 'ZZ TEST Park', code: 'ZZ', timezone: 'Asia/Bangkok' } : null,
      isPlatformAdmin: authority.platform, photoFileId: null, sessionLocked: authority.locked,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: authority.permissions } });
    if (path === '/ready') return route.fulfill({ json: { status: 'ready' } });
    if (path === '/ops/health') return route.fulfill({ json: {
      status: 'ok', checks: [], jobs: [], boxes: [], alerts: [], generatedAt: GENERATED,
    } });
    if (path === '/ops/failures') return route.fulfill({ json: { groups: [], ungrouped: 0, nextCursor: null } });
    if (path === '/branches') return route.fulfill({ json: { branches: [
      { id: BRANCH, name: 'ZZ TEST Park', code: 'ZZ', timezone: 'Asia/Bangkok', archived: false },
    ] } });
    const held = reads.get(path);
    if (held) return held(route);
    if (path === '/operators') return route.fulfill({ json: { operators: [{ id: OPERATOR, name: 'ZZ TEST Existing Operator' }] } });
    if (path === '/roles') return route.fulfill({ json: {
      permissions: [{ permission: 'admin:health:read', words: 'Read the platform health.' }],
      roles: [
        { id: '01963900-0000-7000-8000-000000000010', name: 'operator_admin', system: true,
          description: 'ZZ TEST immutable system role.', permissions: [{ permission: 'admin:health:read', words: 'Read the platform health.' }] },
        { id: '01963900-0000-7000-8000-000000000011', name: 'platform_admin', system: false,
          description: 'ZZ TEST custom lookalike must stay outside the system catalogue.', permissions: [] },
      ],
    } });
    if (path === '/platform/alerts') {
      const state = url.searchParams.get('state') ?? 'open';
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const rows = state === 'resolved' ? [alert('resolved', 'ZZ TEST Resolved alert', true)]
        : [alert('open', offset ? 'ZZ TEST Next alert page' : 'ZZ TEST Open acknowledged alert')];
      return route.fulfill({ json: { generatedAt: GENERATED, alerts: rows, total: 51, limit, offset } });
    }
    if (path === '/platform/jobs') return jobs.fail
      ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'ZZ TEST job register unavailable.' } } })
      : route.fulfill({ json: { generatedAt: GENERATED, jobs: jobs.rows } });
    if (path === '/platform/environment') return route.fulfill({ json: {
      generatedAt: GENERATED, variables: [
        { name: 'ZZ_TEST_REQUIRED_NAME', present: false, required: true, purpose: 'ZZ TEST required provider setting', provider: 'ZZ TEST provider' },
        { name: 'ZZ_TEST_OPTIONAL_NAME', present: true, required: false, purpose: 'ZZ TEST optional setting', provider: null },
      ],
      value: 'ZZ TEST PRIVATE CONFIGURATION VALUE MUST NOT RENDER',
      providers: [{ endpoint: 'https://private.invalid/DO_NOT_RENDER' }],
    } });
    if (path === '/ops/test-controls' && request.method() === 'GET') return route.fulfill({ json: {
      available: controls.available,
      controls: controls.available ? [{ key: 'zz-test-only', label: 'ZZ TEST Simulate failure', description: 'Intercepted local control only.', sticky: true }] : [],
    } });
    if (path === '/ops/test-controls/zz-test-only' && request.method() === 'POST') {
      if (controls.gate) await controls.gate.promise;
      return route.fulfill({ json: { ok: true, message: 'ZZ TEST Local control completed.' } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'Not on this fixture’s access.' } } });
  });
  const featureCalls = () => calls.filter((call) => call.path.startsWith('/platform/') || call.path === '/roles' || call.path === '/operators' || call.path.startsWith('/ops/test-controls'));
  return { authority, calls, featureCalls, reads, jobs, controls };
}

async function freshAuthority(page: Page, expectedStatus = 200) {
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/me'
    && response.status() === expectedStatus);
  await page.evaluate(() => window.dispatchEvent(new Event('oto:session-locked')));
  await loaded;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const pages = [
  ['/platform/operators', 'Operators', '/operators'],
  ['/platform/system-roles', 'System roles', '/roles'],
  ['/platform/alerts', 'Platform alerts', '/platform/alerts'],
  ['/platform/jobs', 'Platform jobs', '/platform/jobs'],
  ['/platform/environment', 'Environment', '/platform/environment'],
  ['/platform/test-controls', 'Test controls', '/ops/test-controls'],
] as const;

test.describe('native Platform pages', () => {
  test.setTimeout(25_000);

  test('Platform navigation offers all six native sections and keeps the old Operators address', async ({ page }) => {
    await fixture(page);
    await page.goto('/platform');
    const main = page.getByRole('main');
    for (const [path, label] of pages) await expect(main.getByRole('link', { name: new RegExp(`^${label}`) })).toHaveAttribute('href', path);
    await main.getByRole('link', { name: /^Operators/ }).click();
    await expect(page.getByRole('heading', { name: 'Operators', exact: true })).toBeVisible();
    await expect(page.getByText('ZZ TEST Existing Operator', { exact: true })).toBeVisible();
    await page.goto('/organisation/operators');
    await expect(page.getByText('ZZ TEST Existing Operator', { exact: true })).toBeVisible();
  });

  for (const [path, title, readPath] of pages) {
    test(`${title} refuses an ordinary operator administrator before its page request`, async ({ page }) => {
      const f = await fixture(page, { platform: false });
      await page.goto(path);
      await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
      expect(f.featureCalls().filter((call) => call.path === readPath)).toEqual([]);
      expect(f.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });
  }

  test('a system role is selected by provenance and its catalogue never opens a role editor or holder lookup', async ({ page }) => {
    const f = await fixture(page);
    await page.goto('/platform/system-roles');
    await expect(page.getByRole('heading', { name: 'System roles', exact: true })).toBeVisible();
    await expect(page.getByText('operator_admin', { exact: true })).toBeVisible();
    await expect(page.getByText('platform_admin', { exact: true })).toHaveCount(0);
    const summary = page.locator('summary').filter({ hasText: 'operator_admin' });
    if (await summary.count()) await summary.click();
    await expect(page.getByText('Read the platform health.', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /edit|grant|add|remove/i })).toHaveCount(0);
    expect(f.calls.filter((call) => call.path.startsWith('/roles/') || call.path.startsWith('/accounts'))).toEqual([]);
    expect(f.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a platform caller still needs each page’s own permission', async ({ page }) => {
    const f = await fixture(page, { permissions: [permission('app:console:access')] });
    for (const [path] of pages) {
      await page.goto(path);
      await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
    }
    expect(f.featureCalls()).toEqual([]);
  });

  for (const [path, title] of pages.slice(2, 5)) {
    test(`${title} does not offer a global read on only a branch health grant`, async ({ page }) => {
      const f = await fixture(page, { permissions: [permission('app:console:access'), permission('admin:health:read', BRANCH, 'branch')] });
      await page.goto('/platform');
      await expect(page.getByRole('heading', { name: 'Platform', exact: true })).toBeVisible();
      for (const [globalPath] of pages.slice(2, 5)) {
        await expect(page.getByRole('main').locator(`a[href="${globalPath}"]`)).toHaveCount(0);
        await expect(page.getByRole('navigation', { name: 'Admin', exact: true }).locator(`a[href="${globalPath}"]`)).toHaveCount(0);
      }
      await page.goto(path);
      await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
      expect(f.featureCalls()).toEqual([]);
    });
  }

  test('alerts preserve acknowledged open rows and use server pagination without an action write', async ({ page }) => {
    const f = await fixture(page);
    await page.goto('/platform/alerts');
    await expect(page.getByText('ZZ TEST Open acknowledged alert', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('ZZ TEST Next alert page', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('resolved');
    await expect(page.getByText('ZZ TEST Resolved alert', { exact: true })).toBeVisible();
    const reads = f.calls.filter((call) => call.path === '/platform/alerts');
    expect(reads.some((call) => new URLSearchParams(call.query).get('offset') === '50')).toBe(true);
    expect(reads.at(-1) && new URLSearchParams(reads.at(-1)!.query).get('state')).toBe('resolved');
    expect(reads.at(-1) && Number(new URLSearchParams(reads.at(-1)!.query).get('offset') ?? 0)).toBe(0);
    expect(reads.every((call) => [...new URLSearchParams(call.query).keys()].every((key) => ['state', 'limit', 'offset'].includes(key)))).toBe(true);
    expect(f.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('jobs show the persisted unknown and waiting state without starting or repairing a job', async ({ page }) => {
    const f = await fixture(page);
    await page.goto('/platform/jobs');
    await expect(page.getByText('job:ZZ_TEST_persisted', { exact: true })).toBeVisible();
    await expect(page.getByText(/unknown/i).first()).toBeVisible();
    await expect(page.getByText(/database/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /run|start|retry job|repair/i })).toHaveCount(0);
    expect(f.featureCalls().every((call) => call.query === '' && call.method === 'GET')).toBe(true);
  });

  test('environment renders only the names and presence metadata, including on a phone', async ({ page }, testInfo) => {
    const f = await fixture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/platform/environment');
    await expect(page.getByRole('heading', { name: 'Environment', exact: true })).toBeVisible();
    await expect(page.getByText('ZZ_TEST_REQUIRED_NAME', { exact: true })).toBeVisible();
    await expect(page.getByText('ZZ_TEST_OPTIONAL_NAME', { exact: true })).toBeVisible();
    await expect(page.getByText('ZZ TEST required provider setting', { exact: true })).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('PRIVATE CONFIGURATION VALUE');
    await expect(page.getByRole('main')).not.toContainText('DO_NOT_RENDER');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    expect(f.featureCalls().every((call) => call.query === '' && call.method === 'GET')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('platform-environment-phone.png'), fullPage: true, animations: 'disabled' });
  });

  test('a failed register read stays a failure until a deliberate successful retry', async ({ page }) => {
    const f = await fixture(page);
    f.jobs.fail = true;
    await page.goto('/platform/jobs');
    await expect(page.getByText('This could not be loaded because the service had a problem. Try reading it again; share the reference if it keeps failing.', { exact: true })).toBeVisible();
    await expect(page.getByText('job:ZZ_TEST_persisted', { exact: true })).toHaveCount(0);
    f.jobs.fail = false;
    await page.getByRole('button', { name: /try again|retry/i }).click();
    await expect(page.getByText('job:ZZ_TEST_persisted', { exact: true })).toBeVisible();
    expect(f.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('test controls require both the server availability offer and the native manage permission', async ({ page }) => {
    const f = await fixture(page);
    f.controls.available = false;
    await page.goto('/platform/test-controls');
    await expect(page.getByRole('heading', { name: 'Test controls', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ZZ TEST Simulate failure', exact: true })).toHaveCount(0);
    expect(f.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('the declared local test-control key is sent once and a late result is discarded after authority loss', async ({ page }) => {
    const f = await fixture(page);
    f.controls.gate = deferred();
    await page.goto('/platform/test-controls');
    const control = page.getByRole('button', { name: 'ZZ TEST Simulate failure', exact: true });
    await control.click();
    await expect(control).toBeDisabled();
    await expect.poll(() => f.calls.filter((call) => call.method === 'POST').length).toBe(1);
    f.authority.platform = false;
    await freshAuthority(page);
    await expect(control).toHaveCount(0);
    const completed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/ops/test-controls/zz-test-only');
    f.controls.gate.release();
    await completed;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('ZZ TEST Local control completed.', { exact: true })).toHaveCount(0);
    expect(f.calls.filter((call) => call.method !== 'GET').map(({ method, path, body }) => ({ method, path, body })))
      .toEqual([{ method: 'POST', path: '/ops/test-controls/zz-test-only', body: null }]);
  });

  for (const change of ['actor', 'operator', 'branch', 'grant', 'platform', 'inactive', 'locked', 'password'] as const) {
    test(`a late read cannot repopulate the page after ${change} authority changes`, async ({ page }) => {
      const f = await fixture(page);
      const held = deferred();
      let started = false;
      f.reads.set('/platform/jobs', async (route) => {
        if (!started) {
          started = true;
          await held.promise;
          return route.fulfill({ json: { generatedAt: GENERATED, jobs: [defaultJob('job:ZZ_TEST_STALE_PREVIOUS_AUTHORITY')] } });
        }
        return route.fulfill({ json: { generatedAt: GENERATED, jobs: [defaultJob('job:ZZ_TEST_CURRENT_AUTHORITY')] } });
      });
      await page.goto('/platform/jobs');
      await expect.poll(() => started).toBe(true);
      if (change === 'actor') f.authority.actor = OTHER_ACTOR;
      if (change === 'operator') f.authority.operator = OTHER_OPERATOR;
      if (change === 'branch') f.authority.branch = OTHER_BRANCH;
      if (change === 'grant') f.authority.permissions = [permission('app:console:access')];
      if (change === 'platform') f.authority.platform = false;
      if (change === 'inactive') f.authority.active = false;
      if (change === 'locked') f.authority.locked = true;
      if (change === 'password') f.authority.mustChangePassword = true;
      await freshAuthority(page, change === 'inactive' ? 401 : 200);
      if (['actor', 'operator', 'branch'].includes(change)) {
        await expect(page.getByText('job:ZZ_TEST_CURRENT_AUTHORITY', { exact: true })).toBeVisible();
      } else if (change === 'locked') {
        await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
      } else if (change === 'password') {
        await expect(page.getByRole('heading', { name: 'Choose a password first', exact: true })).toBeVisible();
      } else {
        if (change === 'inactive') await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
        await expect(page.getByText('job:ZZ_TEST_CURRENT_AUTHORITY', { exact: true })).toHaveCount(0);
      }
      const completed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/platform/jobs'
        && response.request().method() === 'GET');
      held.release();
      await completed;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByText('job:ZZ_TEST_STALE_PREVIOUS_AUTHORITY', { exact: true })).toHaveCount(0);
      expect(f.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });
  }

  test('an A-to-B-to-A authority round trip still rejects the first A response', async ({ page }) => {
    const f = await fixture(page);
    const held = deferred();
    let started = false;
    f.reads.set('/platform/jobs', async (route) => {
      if (!started) {
        started = true;
        await held.promise;
        return route.fulfill({ json: { generatedAt: GENERATED, jobs: [defaultJob('job:ZZ_TEST_STALE_FIRST_A')] } });
      }
      return route.fulfill({ json: { generatedAt: GENERATED, jobs: [defaultJob('job:ZZ_TEST_FRESH_AUTHORITY')] } });
    });
    await page.goto('/platform/jobs');
    await expect.poll(() => started).toBe(true);
    f.authority.actor = OTHER_ACTOR;
    await freshAuthority(page);
    await expect(page.getByText('job:ZZ_TEST_FRESH_AUTHORITY', { exact: true })).toBeVisible();
    f.authority.actor = ACTOR;
    await freshAuthority(page);
    await expect.poll(() => f.calls.filter((call) => call.path === '/platform/jobs').length).toBeGreaterThanOrEqual(3);
    const completed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/platform/jobs');
    held.release();
    await completed;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('job:ZZ_TEST_STALE_FIRST_A', { exact: true })).toHaveCount(0);
    await expect(page.getByText('job:ZZ_TEST_FRESH_AUTHORITY', { exact: true })).toBeVisible();
  });

  for (const selection of ['filter', 'page'] as const) {
    test(`alerts mask the previous answer before dispatching a new ${selection} query`, async ({ page }) => {
      // Observe the native DOM at the actual new fetch boundary. This neither
      // changes React scheduling nor supplies a response to the application.
      await page.addInitScript(() => {
        const nativeFetch = window.fetch;
        const probes: Array<{ state: string; offset: number; oldRows: boolean; oldPagination: boolean }> = [];
        Object.assign(window, { platformAlertQueryProbes: probes });
        window.fetch = (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
          if (url.pathname === '/api/platform/alerts') {
            const main = document.querySelector('main');
            probes.push({ state: url.searchParams.get('state') ?? 'open', offset: Number(url.searchParams.get('offset') ?? 0),
              oldRows: main?.textContent?.includes('ZZ TEST Open acknowledged alert') ?? false,
              oldPagination: [...(main?.querySelectorAll('button') ?? [])].some((button) => button.textContent === 'Next') });
          }
          return nativeFetch(input, init);
        };
      });
      const f = await fixture(page);
      const held = deferred();
      await page.goto('/platform/alerts');
      await expect(page.getByText('ZZ TEST Open acknowledged alert', { exact: true })).toBeVisible();
      f.reads.set('/platform/alerts', async (route) => {
        const query = new URL(route.request().url()).searchParams;
        await held.promise;
        return route.fulfill({ json: { generatedAt: GENERATED,
          alerts: [alert('new-query', 'ZZ TEST Exact new query answer', selection === 'filter')],
          total: 51, limit: 50, offset: Number(query.get('offset') ?? 0) } });
      });
      if (selection === 'filter') await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('resolved');
      else await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect.poll(() => f.calls.filter((call) => call.path === '/platform/alerts').length).toBe(2);
      const probe = await page.evaluate(() => (window as unknown as {
        platformAlertQueryProbes: Array<{ state: string; offset: number; oldRows: boolean; oldPagination: boolean }>;
      }).platformAlertQueryProbes.at(-1));
      expect(probe).toMatchObject({ state: selection === 'filter' ? 'resolved' : 'open', offset: selection === 'page' ? 50 : 0,
        oldRows: false, oldPagination: false });
      await expect(page.getByText('ZZ TEST Open acknowledged alert', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
      const completed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/platform/alerts');
      held.release();
      await completed;
      await expect(page.getByText('ZZ TEST Exact new query answer', { exact: true })).toBeVisible();
    });
  }
});
