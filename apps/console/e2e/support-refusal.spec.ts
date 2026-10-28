import { expect, test, type Page } from '@playwright/test';

const OPERATOR = '01964800-0000-7000-8000-000000000001';
const ACTOR = '01964800-0000-7000-8000-000000000002';
const NEXT_ACTOR = '01964800-0000-7000-8000-000000000003';
const SUBJECT = '01964800-0000-7000-8000-000000000004';
const SESSION = '01964800-0000-7000-8000-000000000005';
const NEXT_SESSION = '01964800-0000-7000-8000-000000000006';
const WINDOW = '01964800-0000-7000-8000-000000000007';
const WINDOWS = '/console/support/impersonations';
const REFUSAL = 'IMPERSONATION_SUBJECT_PRIVILEGED';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Real App/session lifecycle; all API responses and writes are synthetic and local. */
async function fixture(page: Page) {
  const state = { actor: ACTOR, sessionId: SESSION, active: false, startStatus: 403,
    startGate: null as ReturnType<typeof deferred> | null, meReads: 0, cardReads: 0 };
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const now = new Date().toISOString();
  const viewWindow = () => ({ id: WINDOW, actor: { accountId: ACTOR, name: 'ZZ TEST Support actor' },
    subject: { accountId: SUBJECT, name: 'ZZ TEST Reception' }, targetApp: 'pos', mode: 'read_only',
    reason: null, reference: null, approvalId: null, startedAt: now,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), endedAt: null, endReason: null,
    state: state.active ? 'active' : 'ended' });
  // The local success fixture never follows a real handoff or opens another app.
  await page.addInitScript(() => { window.open = () => null; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '').replace(/\/$/, '');
    const method = request.method();
    if (method === 'GET' && path === '/me') {
      state.meReads++;
      return route.fulfill({ json: {
        account: { id: state.actor, phone: '', status: 'active', operatorId: OPERATOR, mustChangePassword: false },
        employee: { id: state.actor, name: state.actor === ACTOR ? 'ZZ TEST Support actor' : 'ZZ TEST Next actor', nickname: null },
        branch: null, isPlatformAdmin: true, photoFileId: null, sessionLocked: false,
        operatorContext: { sessionId: state.sessionId, homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
          operatorOverride: null, revision: 0, branchId: null, stationId: null },
        impersonation: null, impersonating: state.active ? [viewWindow()] : [],
      } });
    }
    if (method === 'GET' && path === '/me/permissions') return route.fulfill({ json: { permissions:
      ['app:console:access', 'console:support:lookup', 'console:support:impersonate']
        .map(permission => ({ permission, scopeType: 'operator', scopeId: null })) } });
    if (method === 'GET' && path === WINDOWS) {
      state.cardReads++;
      return route.fulfill({ json: { maxMinutes: 15, dualControl: true,
        targetApps: ['pos', 'oto_app', 'radar', 'inbox'], windows: state.active ? [viewWindow()] : [], approvals: [] } });
    }
    if (method !== 'GET') writes.push({ method, path, body: request.postData() ? request.postDataJSON() as unknown : undefined });
    if (method === 'POST' && path === WINDOWS) {
      const status = state.startStatus;
      await state.startGate?.promise;
      if (status !== 200) return route.fulfill({ status, json: { error: { code: REFUSAL,
        message: 'ZZ TEST privileged subject refused.' } } });
      state.active = true;
      return route.fulfill({ json: { impersonation: viewWindow(), launchUrl: '/zz-test-no-handoff',
        handoffExpiresAt: new Date(Date.now() + 30_000).toISOString() } });
    }
    if (method === 'POST' && path === `${WINDOWS}/${WINDOW}/end`) {
      state.active = false;
      return route.fulfill({ json: { impersonation: viewWindow() } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Not on fixture access.' } } });
  });
  return { state, writes };
}

const start = (page: Page) => page.getByRole('button', { name: 'Open a read-only window', exact: true });
async function open(page: Page) {
  await page.goto('/watch/support');
  await expect(start(page)).toBeVisible();
  await page.getByRole('textbox', { name: 'Account id', exact: true }).fill(SUBJECT);
  await expect(start(page)).toBeEnabled();
}
async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('a privileged-subject refusal remains visible with its draft after the real action and card reload', async ({ page }) => {
  const f = await fixture(page);
  await open(page);
  const meReads = f.state.meReads, cardReads = f.state.cardReads;
  await start(page).click();
  await expect.poll(() => f.state.cardReads).toBeGreaterThan(cardReads);
  await expect(page.locator(`[data-refusal="${REFUSAL}"]`)).toContainText(
    'This account holds platform or Console authority, so it can never be viewed as.');
  await expect(start(page)).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Account id', exact: true })).toHaveValue(SUBJECT);
  await settleFrames(page);
  expect(f.state.meReads).toBe(meReads);
  expect(f.writes).toEqual([{ method: 'POST', path: WINDOWS,
    body: { subjectAccountId: SUBJECT, targetApp: 'pos', mode: 'read_only' } }]);
});

test('successful opening and ending still refresh the session banner', async ({ page }) => {
  const f = await fixture(page);
  f.state.startStatus = 200;
  await open(page);
  const beforeStart = f.state.meReads;
  await start(page).click();
  await expect(page.getByTestId('impersonation-banner')).toContainText('ZZ TEST Reception');
  expect(f.state.meReads).toBeGreaterThan(beforeStart);
  await expect(page.locator(`[data-window="${WINDOW}"]`)).toBeVisible();
  const beforeEnd = f.state.meReads;
  await page.getByRole('button', { name: 'End now', exact: true }).click();
  await expect(page.getByTestId('impersonation-banner')).toHaveCount(0);
  await expect(start(page)).toBeVisible();
  expect(f.state.meReads).toBeGreaterThan(beforeEnd);
  expect(f.writes.map(write => ({ method: write.method, path: write.path }))).toEqual([
    { method: 'POST', path: WINDOWS }, { method: 'POST', path: `${WINDOWS}/${WINDOW}/end` },
  ]);
});

test('a held old refusal cannot refresh or publish into the replacement actor session', async ({ page }) => {
  const f = await fixture(page);
  const gate = deferred();
  f.state.startGate = gate;
  await open(page);
  try {
    const request = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === `/api${WINDOWS}`);
    await start(page).click();
    await request;
    f.state.actor = NEXT_ACTOR;
    f.state.sessionId = NEXT_SESSION;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('oto:session-locked')));
    await expect(page.getByText('ZZ TEST Next actor', { exact: true }).first()).toBeVisible();
    await expect(start(page)).toBeVisible();
    const meReads = f.state.meReads;
    const reply = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api${WINDOWS}`);
    gate.release();
    await reply;
    await settleFrames(page);
    expect(f.state.meReads).toBe(meReads);
    await expect(page.locator('[data-refusal]')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Account id', exact: true })).toHaveValue('');
    expect(f.writes).toHaveLength(1);
  } finally { gate.release(); }
});
