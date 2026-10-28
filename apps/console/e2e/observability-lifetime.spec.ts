import { expect, test, type Page, type Route } from '@playwright/test';

const OPERATOR = '01964000-0000-7000-8000-000000000001';
const ACTOR = '01964000-0000-7000-8000-000000000002';
const NEXT_ACTOR = '01964000-0000-7000-8000-000000000003';
const SESSION = '01964000-0000-7000-8000-000000000004';
const NOW = '2026-10-27T04:00:00.000Z';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const audit = (action: string, id = action) => ({ id, action, entityType: 'ZZ TEST record',
  entityId: 'ZZ TEST record', actorAccountId: null, actorName: null, branchId: null, requestId: 'zz-test-request',
  before: null, after: null, createdAt: NOW });
const group = (name: string, retryable = false) => ({ fingerprint: name, name, kind: 'job', count: 1,
  firstSeenAt: NOW, lastSeenAt: NOW, lastError: null, lastRunId: retryable ? 'zz-test-run' : null, retryable });

type Read = (route: Route, query: URLSearchParams) => Promise<unknown>;
async function fixture(page: Page) {
  const state = { actor: ACTOR, revision: 0 };
  const writes: string[] = [];
  const reads = { audit: (async route => route.fulfill({ json: { entries: [], nextCursor: null, masked: true } })) as Read,
    groups: (async route => route.fulfill({ json: { groups: [], nextCursor: null } })) as Read,
    runs: (async route => route.fulfill({ json: { runs: [] } })) as Read,
    retry: (async route => route.fulfill({ json: { ok: true } })) as Read };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      if (request.method() === 'POST' && path === '/ops/runs/zz-test-run/retry') return reads.retry(route, url.searchParams);
      return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_WRITE_BLOCKED', message: 'Not on fixture access.' } } });
    }
    if (path === '/me') return route.fulfill({ json: {
      account: { id: state.actor, phone: '', status: 'active', mustChangePassword: false, operatorId: OPERATOR },
      employee: { id: state.actor, name: 'ZZ TEST Observability reader', nickname: null }, branch: null,
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
      operatorContext: { sessionId: SESSION, homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
        operatorOverride: null, branchId: null, stationId: null, revision: state.revision },
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', 'admin:audit:read', 'admin:health:read', 'admin:ops:manage',
    ].map(permission => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/audit') return reads.audit(route, url.searchParams);
    if (path === '/ops/failures') return reads.groups(route, url.searchParams);
    if (path === '/ops/runs') return reads.runs(route, url.searchParams);
    if (path === '/ops/quarantine') return route.fulfill({ json: { events: [], nextCursor: null, openCount: 0 } });
    if (path === '/accounts') return route.fulfill({ json: { accounts: [] } });
    if (path === '/branches') return route.fulfill({ json: { branches: [] } });
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Not on fixture access.' } } });
  });
  return { state, reads, writes };
}

async function releaseAndSettle(page: Page, held: ReturnType<typeof deferred>, path: string) {
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === `/api${path}`);
  held.release();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const row = (page: Page, action: string) => page.getByRole('main').getByText(action, { exact: true });
const kinds = (page: Page) => page.getByRole('combobox', { name: 'Kind', exact: true });
const failureGroups = (page: Page) => page.getByRole('list', { name: 'Failure groups', exact: true });

test('Activity keeps the latest same-session action query after an older answer arrives', async ({ page }) => {
  const f = await fixture(page), held = deferred();
  let oldStarted = false;
  f.reads.audit = async (route, query) => {
    const action = query.get('action');
    if (action === 'zz.test.old') { oldStarted = true; await held.promise; }
    return route.fulfill({ json: { entries: action ? [audit(action)] : [], nextCursor: null, masked: true } });
  };
  await page.goto('/watch/activity');
  const action = page.getByRole('textbox', { name: 'Action', exact: true });
  await action.fill('zz.test.old'); await expect.poll(() => oldStarted).toBe(true);
  await action.fill('zz.test.current'); await expect(row(page, 'zz.test.current')).toBeVisible();
  await releaseAndSettle(page, held, '/audit');
  await expect(action).toHaveValue('zz.test.current');
  await expect(row(page, 'zz.test.current')).toBeVisible();
  await expect(row(page, 'zz.test.old')).toHaveCount(0);
  expect(f.writes).toEqual([]);
});

test('Activity does not append an old cursor page to a changed action query', async ({ page }) => {
  const f = await fixture(page), held = deferred();
  let paging = false;
  f.reads.audit = async (route, query) => {
    if (query.has('cursor')) { paging = true; await held.promise; return route.fulfill({ json: {
      entries: [audit('zz.test.old-page')], nextCursor: 'old-page-3', masked: true } }); }
    const action = query.get('action');
    return route.fulfill({ json: { entries: [audit(action || 'zz.test.first')], nextCursor: action ? null : 'old-page-2', masked: true } });
  };
  await page.goto('/watch/activity'); await expect(row(page, 'zz.test.first')).toBeVisible();
  await page.getByRole('button', { name: 'Load more', exact: true }).click(); await expect.poll(() => paging).toBe(true);
  await page.getByRole('textbox', { name: 'Action', exact: true }).fill('zz.test.current');
  await expect(row(page, 'zz.test.current')).toBeVisible();
  await releaseAndSettle(page, held, '/audit');
  await expect(row(page, 'zz.test.old-page')).toHaveCount(0);
  await expect(row(page, 'zz.test.current')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
});

test('Failures keeps the latest same-session kind query and count after an older answer arrives', async ({ page }) => {
  const f = await fixture(page), held = deferred();
  let oldStarted = false;
  f.reads.groups = async (route, query) => {
    const kind = query.get('kind');
    if (kind === 'job') { oldStarted = true; await held.promise; }
    return route.fulfill({ json: { groups: kind ? [group(`zz.test.${kind}`)] : [], nextCursor: null } });
  };
  await page.goto('/watch/failures'); await expect(kinds(page)).toBeVisible();
  await kinds(page).selectOption('job'); await expect.poll(() => oldStarted).toBe(true);
  await kinds(page).selectOption('http'); await expect(failureGroups(page)).toContainText('zz.test.http');
  await releaseAndSettle(page, held, '/ops/failures');
  await expect(kinds(page)).toHaveValue('http');
  await expect(failureGroups(page)).toContainText('zz.test.http');
  await expect(failureGroups(page)).not.toContainText('zz.test.job');
  await expect(page.getByText('1 group', { exact: true })).toBeVisible();
});

test('Failures does not append an old cursor page or count to a changed kind query', async ({ page }) => {
  const f = await fixture(page), held = deferred();
  let paging = false;
  f.reads.groups = async (route, query) => {
    if (query.has('cursor')) { paging = true; await held.promise; return route.fulfill({ json: {
      groups: [group('zz.test.old-page')], nextCursor: 'old-page-3' } }); }
    const kind = query.get('kind');
    return route.fulfill({ json: { groups: kind ? [group(`zz.test.${kind}`)] : [], nextCursor: kind === 'job' ? 'old-page-2' : null } });
  };
  await page.goto('/watch/failures'); await kinds(page).selectOption('job');
  await expect(failureGroups(page)).toContainText('zz.test.job');
  await page.getByRole('button', { name: 'Load more', exact: true }).click(); await expect.poll(() => paging).toBe(true);
  await kinds(page).selectOption('http'); await expect(failureGroups(page)).toContainText('zz.test.http');
  await releaseAndSettle(page, held, '/ops/failures');
  await expect(failureGroups(page)).not.toContainText('zz.test.old-page');
  await expect(page.getByText('1 group', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
});

test('a completed Retry cannot dispatch the old filter read after the user changes kind', async ({ page }) => {
  const f = await fixture(page), held = deferred();
  let jobReads = 0, retryStarted = false;
  f.reads.groups = async (route, query) => {
    const kind = query.get('kind'); if (kind === 'job') jobReads++;
    return route.fulfill({ json: { groups: kind ? [group(`zz.test.${kind}`, kind === 'job')] : [], nextCursor: null } });
  };
  f.reads.retry = async route => { retryStarted = true; await held.promise; return route.fulfill({ json: { ok: true } }); };
  await page.goto('/watch/failures'); await kinds(page).selectOption('job');
  await failureGroups(page).getByRole('button', { name: 'Retry', exact: true }).click(); await expect.poll(() => retryStarted).toBe(true);
  await kinds(page).selectOption('http'); await expect(failureGroups(page)).toContainText('zz.test.http');
  await releaseAndSettle(page, held, '/ops/runs/zz-test-run/retry');
  expect(jobReads).toBe(1);
  await expect(failureGroups(page)).toContainText('zz.test.http');
  expect(f.writes).toEqual(['POST /ops/runs/zz-test-run/retry']);
});

test('Activity related-read refusal is not an assertion that this was the only row', async ({ page }) => {
  const f = await fixture(page); let relatedReads = 0;
  f.reads.audit = async (route, query) => {
    if (query.has('requestId') && ++relatedReads === 1) return route.fulfill({ status: 503,
      json: { error: { code: 'ZZ_TEST_UNAVAILABLE', message: 'ZZ TEST related rows unavailable' } } });
    return route.fulfill({ json: { entries: query.has('requestId') ? [] : [audit('zz.test.open')], masked: true } });
  };
  await page.goto('/watch/activity'); await row(page, 'zz.test.open').click();
  const drawer = page.getByRole('dialog', { name: 'zz.test.open', exact: true });
  await drawer.getByRole('button', { name: 'Related', exact: true }).click();
  await expect(drawer.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true })).toBeVisible();
  await expect(drawer.getByText('This was the only row for that request', { exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(drawer.getByText('This was the only row for that request', { exact: true })).toBeVisible();
  expect(relatedReads).toBe(2);
});

test('Failures run-history refusal is not an assertion that no individual runs exist', async ({ page }) => {
  const f = await fixture(page); let historyReads = 0;
  f.reads.groups = async route => route.fulfill({ json: { groups: [group('zz.test.open')], nextCursor: null } });
  f.reads.runs = async route => ++historyReads === 1 ? route.fulfill({ status: 503,
    json: { error: { code: 'ZZ_TEST_UNAVAILABLE', message: 'ZZ TEST run history unavailable' } } }) : route.fulfill({ json: { runs: [] } });
  await page.goto('/watch/failures'); await failureGroups(page).getByRole('button', { name: 'Details', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'zz.test.open', exact: true });
  await expect(drawer.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true })).toBeVisible();
  await expect(drawer.getByText('No individual runs returned', { exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(drawer.getByText('No individual runs returned', { exact: true })).toBeVisible();
  expect(historyReads).toBe(2);
});

test('the existing canonical client fence rejects an old actor 401 without signing out the current actor', async ({ page }) => {
  const f = await fixture(page), held = deferred(); let originalStarted = false;
  f.reads.audit = async route => {
    if (f.state.actor === ACTOR) { originalStarted = true; await held.promise; return route.fulfill({ status: 401,
      json: { error: { code: 'ZZ_TEST_OLD_SESSION', message: 'ZZ TEST previous session ended' } } }); }
    return route.fulfill({ json: { entries: [audit('zz.test.current-actor')], nextCursor: null, masked: true } });
  };
  await page.goto('/watch/activity'); await expect.poll(() => originalStarted).toBe(true);
  f.state.actor = NEXT_ACTOR; f.state.revision++;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('oto:session-locked')));
  await expect(row(page, 'zz.test.current-actor')).toBeVisible();
  await releaseAndSettle(page, held, '/audit');
  await expect(row(page, 'zz.test.current-actor')).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByText('ZZ TEST previous session ended', { exact: true })).toHaveCount(0);
  expect(f.writes).toEqual([]);
});
