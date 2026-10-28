import { expect, test, type Page, type Route } from '@playwright/test';
import type { ApiResponse } from '@oto/api-types';

const OPERATOR = '01964300-0000-7000-8000-000000000001';
const OTHER_OPERATOR = '01964300-0000-7000-8000-000000000002';
const ACTOR = '01964300-0000-7000-8000-000000000003';
const OTHER_ACTOR = '01964300-0000-7000-8000-000000000004';
const BRANCH = '01964300-0000-7000-8000-000000000005';
const APP = '01964300-0000-7000-8000-000000000006';
const EVENT = '01964300-0000-7000-8000-000000000007';
const BOX = '01964300-0000-7000-8000-000000000008';
const GENERATED = '2026-10-27T03:00:00.000Z';
const grant = (permission: string, scopeId: string | null = OPERATOR, scopeType = 'operator') => ({ permission, scopeType, scopeId });
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const registry = (name = 'ZZ TEST Admin') => ({ generatedAt: GENERATED, apps: [{
  id: APP, key: 'console', name, purpose: 'ZZ TEST suite control surface',
  origins: { staging: 'https://zz-test.invalid/admin' }, schemaName: 'core', owningService: 'ZZ TEST Console service',
  healthUrl: null, versionSource: 'build_id', requiredPermission: 'app:console:access', sortOrder: 5,
  storedState: 'open', effectiveState: 'maintenance', revision: 2,
  maintenance: { message: 'ZZ TEST scheduled maintenance', expiresAt: '2026-10-27T04:00:00.000Z' },
}] });
const history = (name = 'ZZ TEST Admin', offset = 0) => ({ generatedAt: GENERATED, total: 51, limit: 50, offset,
  deployments: [{ id: EVENT, app: 'console', appName: name, version: null, commit: null,
    actorAccountId: null, status: 'recorded', ciGreen: null, deployedAt: null, recordedAt: GENERATED }],
});
type Agents = ApiResponse<'/console/releases/agents', 'get'>;
const agent = (name = 'ZZ TEST Box', agentVersion: string | null = '2.1.0', belowMinimum: boolean | null = false): Agents['agents'][number] => ({
  id: BOX, name, slot: 'ZZ_TEST_BOX', branchId: BRANCH, branchName: 'ZZ TEST Park',
  agentVersion, lastHeartbeatAt: agentVersion === null ? null : GENERATED, belowMinimum,
});
const fleet = (name = 'ZZ TEST Box', operatorId = OPERATOR): Agents => ({
  generatedAt: GENERATED, operatorId, minimumSupportedVersion: '2.0.0', total: 1, limit: 50, offset: 0, agents: [agent(name)],
});

async function fixture(page: Page, permissions = [grant('console:app_registry:read'), grant('console:release:read')]) {
  const authority = { actor: ACTOR, operator: OPERATOR, revision: 0, permissions };
  const sessionId = crypto.randomUUID();
  const calls: Array<{ method: string; path: string; query: string }> = [];
  const reads = new Map<string, (route: Route) => Promise<void>>();
  const errors: string[] = [];
  let apps = registry(), releases = history(), agents = fleet();
  page.on('pageerror', error => errors.push(error.name));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
    calls.push({ method: request.method(), path, query: url.search });
    if (path === '/me') return route.fulfill({ json: {
      account: { id: authority.actor, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false },
      operatorContext: { sessionId, homeOperatorId: OPERATOR, effectiveOperatorId: authority.operator,
        operatorOverride: authority.operator === OPERATOR ? null : authority.operator, branchId: BRANCH, stationId: null, revision: authority.revision },
      employee: { id: authority.actor, name: 'ZZ TEST Suite reader', nickname: null },
      branch: { id: BRANCH, name: 'ZZ TEST Park', code: 'ZZ', timezone: 'Asia/Bangkok' },
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false, preferences: { theme: 'light', language: 'en' },
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [grant('app:console:access'), ...authority.permissions] } });
    if (path === '/ready') return route.fulfill({ json: { status: 'ready' } });
    if (path === '/ops/health') return route.fulfill({ json: { status: 'ok', checks: [], jobs: [], boxes: [], alerts: [], generatedAt: GENERATED } });
    if (path === '/ops/failures') return route.fulfill({ json: { groups: [], ungrouped: 0, nextCursor: null } });
    const held = reads.get(path);
    if (held) return held(route);
    if (path === '/console/apps') return route.fulfill({ json: apps });
    if (path === '/console/releases') return route.fulfill({ json: { ...releases, offset: Number(url.searchParams.get('offset') ?? 0) } });
    if (path === '/console/releases/agents') return route.fulfill({ json: { ...agents, offset: Number(url.searchParams.get('offset') ?? 0) } });
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST Read not allowed.' } } });
  });
  return { authority, calls, reads, errors, setApps: (next: typeof apps) => { apps = next; },
    setReleases: (next: typeof releases) => { releases = next; },
    setAgents: (next: Agents) => { agents = next; },
    features: () => calls.filter(call => call.path.startsWith('/console/')) };
}

async function refreshAuthority(page: Page) {
  const answer = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me' && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new Event('oto:session-locked')));
  await answer;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('operator-only registry readers reach Apps through its alias and see recorded metadata without mutation offers', async ({ page }) => {
  const state = await fixture(page, [grant('console:app_registry:read')]);
  await page.goto('/apps');
  await expect(page.getByRole('heading', { name: 'Apps', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('ZZ TEST Admin', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST scheduled maintenance', { exact: true })).toBeVisible();
  await expect(page.getByText('https://zz-test.invalid/admin', { exact: true })).toBeVisible();
  await expect(page.getByText('app:console:access', { exact: true })).toBeVisible();
  await expect(page.locator('a[href="/organisation/apps"]')).toBeVisible();
  await expect(page.locator('a[href="/platform"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /save|maintenance|deploy|kill switch/i })).toHaveCount(0);
  expect(state.features().every(call => call.method === 'GET')).toBe(true);
  expect(state.errors).toEqual([]);
});

test('Releases uses recorded history and reports null facts honestly, including its old address', async ({ page }) => {
  const state = await fixture(page, [grant('console:release:read')]);
  await page.goto('/releases');
  await expect(page.getByRole('heading', { name: 'Releases', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('ZZ TEST Admin', { exact: true })).toBeVisible();
  await expect(page.getByText('Not recorded', { exact: true })).toHaveCount(5);
  await expect(page.getByRole('heading', { name: 'Box agent versions', exact: true, level: 2 })).toBeVisible();
  await expect(page.getByText('2.0.0', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Box', { exact: true })).toBeVisible();
  await expect(page.getByText('Meets minimum', { exact: true })).toBeVisible();
  await expect(page.locator('a[href="/watch/releases"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /deploy|rollback|save|flip/i })).toHaveCount(0);
  expect(state.features().every(call => call.method === 'GET')).toBe(true);
});

test('ungranted and branch-only read grants refuse both direct pages without registry/history requests', async ({ page }) => {
  const state = await fixture(page, []);
  await page.goto('/apps');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  await page.goto('/releases');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  state.authority.permissions = [grant('console:app_registry:read', BRANCH, 'branch'), grant('console:release:read', BRANCH, 'branch')];
  await refreshAuthority(page);
  await page.goto('/apps');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  await page.goto('/releases');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  expect(state.features()).toEqual([]);
});

test('failed reads have a retry and do not claim an empty registry or release history', async ({ page }) => {
  const state = await fixture(page);
  state.reads.set('/console/apps', route => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'ZZ TEST Registry unavailable.' } } }));
  await page.goto('/apps');
  await expect(page.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true })).toBeVisible();
  await expect(page.getByText('No apps are recorded.', { exact: true })).toHaveCount(0);
  state.reads.delete('/console/apps');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('ZZ TEST Admin', { exact: true })).toBeVisible();
  state.setReleases({ ...history(), total: 0, deployments: [] });
  await page.goto('/releases');
  await expect(page.getByText('No releases are recorded.', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Admin', { exact: true })).toHaveCount(0);
});

test('late registry data cannot return after the actor changes away and back', async ({ page }) => {
  const state = await fixture(page), pending = deferred();
  let requests = 0;
  state.reads.set('/console/apps', async route => {
    const index = ++requests;
    if (index === 1) await pending.promise;
    await route.fulfill({ json: registry(index === 1 ? 'ZZ TEST Obsolete registry' : 'ZZ TEST Current registry') });
  });
  await page.goto('/apps');
  await expect(page.getByText('Loading app registry…', { exact: true })).toBeVisible();
  await expect.poll(() => requests).toBe(1);
  state.authority.actor = OTHER_ACTOR;
  await refreshAuthority(page);
  await expect(page.getByText('ZZ TEST Current registry', { exact: true })).toBeVisible();
  state.authority.actor = ACTOR;
  await refreshAuthority(page);
  await expect.poll(() => requests).toBe(3);
  pending.release();
  await expect(page.getByText('ZZ TEST Current registry', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Obsolete registry', { exact: true })).toHaveCount(0);
});

test('same-account effective-operator revisions fence delayed history, including a return to the original context', async ({ page }) => {
  const state = await fixture(page), pending = deferred();
  let requests = 0, agentRequests = 0;
  state.reads.set('/console/releases', async route => {
    const index = ++requests;
    if (index === 1) await pending.promise;
    await route.fulfill({ json: history(index === 1 ? 'ZZ TEST Old history' : 'ZZ TEST Current history') });
  });
  state.reads.set('/console/releases/agents', async route => {
    const index = ++agentRequests, operatorId = state.authority.operator;
    if (index === 1) await pending.promise;
    await route.fulfill({ json: fleet(index === 1 ? 'ZZ TEST Old fleet' : 'ZZ TEST Current fleet', operatorId) });
  });
  await page.goto('/releases');
  await expect.poll(() => requests).toBe(1);
  state.authority.operator = OTHER_OPERATOR; state.authority.revision++;
  state.authority.permissions = [grant('console:release:read', OTHER_OPERATOR)];
  await refreshAuthority(page);
  await expect(page.getByText('ZZ TEST Current history', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Current fleet', { exact: true })).toBeVisible();
  state.authority.operator = OPERATOR; state.authority.revision++;
  state.authority.permissions = [grant('console:release:read')];
  await refreshAuthority(page);
  await expect.poll(() => requests).toBe(3);
  await expect.poll(() => agentRequests).toBe(3);
  pending.release();
  await expect(page.getByText('ZZ TEST Current history', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Old history', { exact: true })).toHaveCount(0);
  await expect(page.getByText('ZZ TEST Current fleet', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Old fleet', { exact: true })).toHaveCount(0);
  state.reads.set('/console/releases/agents', route => route.fulfill({ json: fleet('ZZ TEST Foreign fleet', OTHER_OPERATOR) }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Agent version records belong to a different operator.', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Foreign fleet', { exact: true })).toHaveCount(0);
  await expect(page.getByText('ZZ TEST Current history', { exact: true })).toBeVisible();
});

test('history pagination replaces the visible page and cannot export or infer omitted facts', async ({ page }) => {
  const state = await fixture(page), pending = deferred();
  state.reads.set('/console/releases', async route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? 0);
    if (offset) await pending.promise;
    await route.fulfill({ json: history(offset ? 'ZZ TEST Older release' : 'ZZ TEST Latest release', offset) });
  });
  await page.goto('/releases');
  await expect(page.getByText('ZZ TEST Latest release', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Older releases', exact: true }).click();
  await expect(page.getByText('Loading release history…', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Latest release', { exact: true })).toHaveCount(0);
  pending.release();
  await expect(page.getByText('ZZ TEST Older release', { exact: true })).toBeVisible();
  expect(state.features().filter(call => call.path === '/console/releases').at(-1)?.query).toContain('offset=50');
  await expect(page.getByRole('button', { name: /export|deploy/i })).toHaveCount(0);
  state.reads.set('/console/releases', route => route.fulfill({ json: {
    ...history(), total: 1, offset: 50, deployments: [],
  } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('0 records on this page; 1 record total', { exact: true })).toBeVisible();
  await expect(page.getByText('No releases on this page.', { exact: true })).toBeVisible();
  await expect(page.getByText('No releases are recorded.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Newer releases', exact: true })).toBeEnabled();
});

test('read-only native cards and long metadata fit a 390px phone', async ({ page }) => {
  const state = await fixture(page);
  const long = registry('ZZ TEST ' + 'Long approved app name '.repeat(8));
  long.apps[0]!.origins.staging = 'https://zz-test.invalid/' + 'long-path/'.repeat(25);
  state.setApps(long);
  state.setAgents({ ...fleet(), agents: [{ ...agent('ZZ TEST ' + 'Long box name '.repeat(16)),
    slot: 'ZZ_TEST_LONG_SLOT_'.repeat(12), branchName: 'ZZ TEST ' + 'Long park name '.repeat(12) }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/apps');
  await expect(page.getByText(long.apps[0]!.name, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.goto('/releases');
  await expect(page.getByText('ZZ TEST Admin', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(state.errors).toEqual([]);
});

test('agent versions keep nullable facts, independent read errors and honest empty-page pagination', async ({ page }) => {
  const state = await fixture(page);
  const records = Array.from({ length: 50 }, (_, index) => ({
    ...agent(index === 0 ? 'ZZ TEST Below-minimum box' : index === 1 ? 'ZZ TEST Unknown box' : 'ZZ TEST Current box ' + index,
      index === 0 ? '1.0.0' : index === 1 ? null : '2.1.0', index === 0 ? true : index === 1 ? null : false),
    id: '01964300-0000-7000-8000-' + String(index + 100).padStart(12, '0'),
  }));
  state.reads.set('/console/releases/agents', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? 0);
    return route.fulfill({ json: { ...fleet(), total: 51, offset,
      agents: offset ? [agent('ZZ TEST Older box')] : records } });
  });
  await page.goto('/releases');
  const panel = page.getByRole('heading', { name: 'Box agent versions', exact: true, level: 2 }).locator('xpath=ancestor::section[1]');
  await expect(panel.getByText('Below minimum', { exact: true })).toHaveCount(1);
  const unknown = panel.locator('article').filter({ has: page.getByRole('heading', { name: 'ZZ TEST Unknown box', exact: true }) });
  await expect(unknown.getByText('Not recorded', { exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Older agent records', exact: true }).click();
  await expect(page.getByText('ZZ TEST Older box', { exact: true })).toBeVisible();
  expect(state.features().filter(call => call.path === '/console/releases/agents').at(-1)?.query).toContain('offset=50');
  state.reads.set('/console/releases/agents', route => route.fulfill({ json: { ...fleet(), total: 1, offset: 50, agents: [] } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel.getByText('0 boxes on this page; 1 box total', { exact: true })).toBeVisible();
  await expect(panel.getByText('No boxes on this page.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Newer agent records', exact: true })).toBeEnabled();
  state.reads.set('/console/releases/agents', route => route.fulfill({ status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'ZZ TEST Agent versions unavailable.' } } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true })).toBeVisible();
  await expect(page.getByText('ZZ TEST Admin', { exact: true })).toBeVisible();
  await expect(panel.getByText('No boxes are recorded.', { exact: true })).toHaveCount(0);
  state.reads.delete('/console/releases/agents'); state.setAgents({ ...fleet(), total: 0, agents: [] });
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(panel.getByText('No boxes are recorded.', { exact: true })).toBeVisible();
  state.setAgents(fleet());
  state.reads.set('/console/releases', route => route.fulfill({ status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'ZZ TEST History unavailable.' } } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true })).toBeVisible();
  await expect(panel.getByText('ZZ TEST Box', { exact: true })).toBeVisible();
});
