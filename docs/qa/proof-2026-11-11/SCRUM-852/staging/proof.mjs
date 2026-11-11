// SCRUM-852 staging proof: after the retry change, a login's switch-off (and a
// leaver's move to pay only) still reaches the platform; the Access & Login
// panel in its normal state says nothing; Send again refuses when nothing is
// parked. One ZZ TEST employee with a login, made here and removed here. The
// receipt holds ids and statuses only: no phone number, no name.
//
// The parked line and its Send again button are NOT produced here: the platform
// cannot be made to refuse a ZZ TEST switch-off without touching a real
// administrator or writing to the database. The checks prove them.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = process.env.OTO_ROOT ? resolve(process.env.OTO_ROOT) : resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(root, 'scripts/agent/env.mjs')));
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const expectedSha = '70d45d0d18d95d061e4a7abe079d90dbc1932a18';
const out = resolve(import.meta.dirname, process.argv[2] ?? '.'); mkdirSync(out, { recursive: true });
const origins = { console: 'https://oto-console-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com', app: 'https://oto-app-staging.onrender.com' };
const NOT_TOLD = 'The platform was not told';
const receipt = { ticket: 'SCRUM-852', expectedSha, startedAt: new Date().toISOString(), phase: 'preflight', requests: [], created: {}, steps: {}, cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = s => { receipt.phase = s; save(); console.log(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bangkokDay = (offsetDays = 0) => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);
};
const browser = await chromium.launch({ channel: 'msedge' });
const options = { viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' };
const context = await browser.newContext(options), consoleContext = await browser.newContext(options);
context.setDefaultTimeout(30000); consoleContext.setDefaultTimeout(30000);
const app = await context.newPage(), consolePage = await consoleContext.newPage();
let failed = false;
async function login(page, origin) {
  await page.goto(origin);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('input[type="password"]').waitFor({ state: 'hidden' });
}
/** Requests as the signed-in administrator. A query that carries a phone number is never written down. */
async function call(origin, path, method = 'GET', data, logged = path) {
  const ctx = origin === origins.console ? consoleContext : context;
  const r = await ctx.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }), headers: { origin } });
  receipt.requests.push({ at: origin === origins.console ? 'console' : 'app', method, path: logged, status: r.status() }); save(); return r;
}
const masks = () => [
  app.getByTestId('text-employee-suite-password'), app.getByTestId('text-employee-suite-phone'),
  app.locator('input[type="password"], input[type="tel"]'), app.locator('[data-testid^="button-user-menu"], [data-testid="avatar-user"]'),
];
const lifecycle = async userId => {
  const r = await call(origins.app, `/api/admin/login-lifecycle?userId=${userId}`);
  if (r.status() !== 200) return { status: r.status(), events: [] };
  const events = (await r.json()).events.map(e => ({ id: e.id, kind: e.kind, state: e.state, attemptCount: e.attemptCount, lastErrorCode: e.lastErrorCode,
    parked: e.parked, nextAttemptAt: e.nextAttemptAt, createdAt: e.createdAt, settledAt: e.settledAt }));
  return { status: 200, events };
};
const profile = async id => {
  const r = await call(origins.app, `/api/employees/${id}`);
  if (r.status() !== 200) return { status: r.status() };
  const e = await r.json();
  return { status: 200, employeeStatus: e.status, employmentState: e.employmentState, hasLogin: !!e.userId, loginActive: e.loginActive ?? null, userId: e.userId ?? null };
};
/** The platform account as the Console's Login users list reads it: this proof's own row only. */
const platformAccount = async accountId => {
  const r = await call(origins.console, '/api/accounts');
  if (r.status() !== 200) return { status: r.status() };
  const row = (await r.json()).accounts.find(a => a.id === accountId);
  return { status: 200, listed: !!row, accountStatus: row?.status ?? null };
};
/** Wait for the newest event of a kind to settle: every 15 s, up to four minutes. Every read is kept. */
async function awaitEvent(userId, kind) {
  const began = Date.now(), reads = []; let newest = null;
  for (;;) {
    const read = await lifecycle(userId);
    newest = read.events.find(e => e.kind === kind) ?? null;
    reads.push({ afterSeconds: Math.round((Date.now() - began) / 1000), status: read.status, state: newest?.state ?? null, attemptCount: newest?.attemptCount ?? null,
      lastErrorCode: newest?.lastErrorCode ?? null, parked: newest?.parked ?? null });
    if (newest && newest.state !== 'pending') break;
    if (Date.now() - began >= 240_000) break;
    await sleep(15_000);
  }
  return { waitedSeconds: Math.round((Date.now() - began) / 1000), reads, event: newest };
}
/** Open the ZZ TEST profile's Access & Login panel afresh; answers the toggle button and what the panel's own lifecycle read answered. */
async function openPanel(employeeId) {
  const panelReads = [];
  const seen = r => { const u = new URL(r.url()); if (u.pathname === '/api/admin/login-lifecycle') panelReads.push(r.status()); };
  app.on('response', seen);
  await app.goto(origins.app + `/employees/${employeeId}`);
  await app.getByTestId('tab-access').click();
  const section = app.getByTestId('collapsible-access-login'); await section.waitFor();
  const toggle = app.locator('[data-testid="button-toggle-login"], [data-testid="button-toggle-login-policy"]').first();
  if (!(await toggle.isVisible())) await section.getByText('Access & Login', { exact: true }).click();
  await toggle.waitFor();
  await expect.poll(() => panelReads.length, { timeout: 20000 }).toBeGreaterThan(0);
  await app.waitForLoadState('networkidle').catch(() => {});
  app.off('response', seen);
  return { section, toggle, panelReads };
}
const panelState = async (section, toggle, panelReads) => ({
  panelLifecycleReads: panelReads, toggleReads: (await toggle.innerText()).trim(),
  parkedLines: await app.locator('[data-testid^="login-lifecycle-parked-"]').count(),
  sendAgainButtons: await app.locator('[data-testid^="button-login-lifecycle-send-again-"]').count(),
  notToldTextOnPage: (await app.locator('body').innerText()).includes(NOT_TOLD),
  sendAgainTextInPanel: (await section.innerText()).includes('Send again'),
});
async function pressToggle(employeeId, toggle) {
  const answered = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/employees/${employeeId}/toggle-login`);
  await toggle.click();
  const response = await answered, body = await response.json().catch(() => ({}));
  return { status: response.status(), isActive: body.isActive, message: body.message };
}
try {
  phase('sign in: Console, launcher, OTO App');
  await login(consolePage, origins.console); await consolePage.waitForURL(/\/overview$/);
  await login(app, origins.launcher);
  const handoff = app.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await app.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await app.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  const exchanged = await handoff; await exchanged.finished(); assert.equal(exchanged.status(), 200);
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);

  phase('the app reports the landed source');
  {
    const r = await call(origins.app, '/api/qa-reports/config'), body = await r.json();
    receipt.appVersion = { status: r.status(), sha: body.version }; save();
    if (body.version !== expectedSha) execFileSync('git', ['merge-base', '--is-ancestor', expectedSha, body.version], { cwd: root });
  }

  phase('choose a branch and a department');
  const branches = (await (await call(origins.app, '/api/branches')).json()).filter(b => b.isActive !== false);
  const branch = branches[0]; assert.ok(branch, 'an active branch');
  const departments = (await (await call(origins.app, '/api/departments')).json()).filter(d => d.isActive !== false);
  const department = departments[0]; assert.ok(department, 'an active department');
  receipt.chosen = { branchId: branch.id, departmentId: department.id }; save();

  phase('a phone number nobody can hold, checked for a clash in the app and on the platform');
  let phone = null; receipt.phoneChecks = [];
  for (let attempt = 0; attempt < 5 && !phone; attempt += 1) {
    const candidate = '010' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
    const inApp = await call(origins.app, `/api/support/by-phone?phone=${candidate}`, 'GET', undefined, '/api/support/by-phone?phone=[not recorded]');
    const appBody = inApp.status() === 200 ? await inApp.json() : null;
    const onPlatform = await call(origins.console, `/api/accounts?q=${candidate.slice(1)}`, 'GET', undefined, '/api/accounts?q=[not recorded]');
    const platformBody = onPlatform.status() === 200 ? await onPlatform.json() : null;
    const check = { app: inApp.status(), appRecords: appBody?.records?.length ?? null, platform: onPlatform.status(), platformAccounts: platformBody?.accounts?.length ?? null };
    receipt.phoneChecks.push(check); save();
    if (check.appRecords === 0 && check.platformAccounts === 0) phone = candidate;
  }
  assert.ok(phone, 'a free phone number');

  phase('step 2: create the ZZ TEST employee and its login through the employee editor');
  const suffix = Date.now().toString(36), email = `zz-test-852-${suffix}@example.com`;
  const made = await call(origins.app, '/api/employees', 'POST', { fullName: `ZZ TEST SCRUM-852 ${suffix}`, nickname: 'ZZ TEST', email, branchId: branch.id, primaryDepartmentId: department.id });
  assert.equal(made.status(), 201);
  const employeeId = (await made.json()).id; receipt.created.employeeId = employeeId; assert.ok(employeeId); save();
  await app.goto(origins.app + `/employees/${employeeId}`);
  await app.getByTestId('tab-access').click();
  const firstSection = app.getByTestId('collapsible-access-login'); await firstSection.waitFor();
  if (!(await app.getByTestId('button-enable-login').isVisible())) await firstSection.getByText('Access & Login', { exact: true }).click();
  await app.getByTestId('button-enable-login').click();
  await app.getByTestId('input-login-email').fill(email);
  await app.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click();
  await app.getByTestId('input-employee-suite-phone').fill(phone);
  const created = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/employees/${employeeId}/enable-login`);
  await app.getByTestId('button-create-login').click();
  const loginResponse = await created, loginAnswer = await loginResponse.json().catch(() => ({}));
  for (const k of ['userId', 'personId', 'accessPolicyId', 'accountId']) if (loginAnswer[k]) receipt.created[k] = loginAnswer[k];
  receipt.steps.step2 = { employee: made.status(), enableLogin: loginResponse.status(), success: loginAnswer.success, replayed: loginAnswer.replayed,
    platformManaged: loginAnswer.platformManaged, platformAccount: !!loginAnswer.accountId, message: loginResponse.ok() ? undefined : loginAnswer.message }; save();
  assert.equal(loginResponse.status(), 200); assert.ok(loginAnswer.userId); assert.ok(loginAnswer.accountId);
  await app.getByTestId('text-enable-login-done-launcher').waitFor();
  const userId = loginAnswer.userId, accountId = loginAnswer.accountId;
  receipt.steps.step2.profile = await profile(employeeId);
  receipt.steps.step2.lifecycleBefore = await lifecycle(userId);
  receipt.steps.step2.platformAccount = await platformAccount(accountId); save();
  assert.equal(receipt.steps.step2.platformAccount.accountStatus, 'active');

  phase('step 3: Disable Login on the Access & Login panel; the switch-off reaches the platform');
  {
    const { section, toggle, panelReads } = await openPanel(employeeId);
    const before = await panelState(section, toggle, panelReads);
    assert.equal(before.toggleReads, 'Disable Login');
    await section.screenshot({ path: resolve(out, '852-01-panel-login-on.png'), animations: 'disabled' });
    const pressed = await pressToggle(employeeId, toggle);
    receipt.steps.step3 = { panelBefore: before, disableLogin: pressed }; save();
    assert.equal(pressed.status, 200); assert.equal(pressed.isActive, false);
    const waited = await awaitEvent(userId, 'deactivate');
    receipt.steps.step3.delivery = waited;
    receipt.steps.step3.profile = await profile(employeeId);
    receipt.steps.step3.platformAccount = await platformAccount(accountId); save();
    const again = await openPanel(employeeId);
    const after = await panelState(again.section, again.toggle, again.panelReads);
    receipt.steps.step3.panelAfter = after; save();
    await again.section.scrollIntoViewIfNeeded();
    await again.section.screenshot({ path: resolve(out, '852-02-panel-after-switch-off.png'), animations: 'disabled' });
    await app.screenshot({ path: resolve(out, '852-03-profile-after-switch-off.png'), mask: masks() });
    receipt.steps.step3.passed = waited.event?.state === 'delivered' && waited.event.parked === false && waited.event.lastErrorCode === null
      && receipt.steps.step3.platformAccount.accountStatus === 'inactive'
      && after.panelLifecycleReads.every(s => s === 200) && after.toggleReads === 'Enable Login'
      && after.parkedLines === 0 && after.sendAgainButtons === 0 && !after.notToldTextOnPage && !after.sendAgainTextInPanel;
    save();
    // A switch-off that did not arrive is the finding: record it and go straight to the clean-up.
    if (waited.event?.state !== 'delivered') throw new Error(`the switch-off was not delivered: ${waited.event?.state ?? 'no event'} after ${waited.event?.attemptCount ?? 0} attempt(s), code ${waited.event?.lastErrorCode ?? 'none'}`);
  }

  phase('step 5: Send again for the delivered event is refused and changes nothing');
  {
    const before = await lifecycle(userId);
    const event = before.events.find(e => e.kind === 'deactivate');
    if (event) {
      const r = await call(origins.app, '/api/admin/login-lifecycle/send-again', 'POST', { eventId: event.id });
      const body = await r.json().catch(() => ({}));
      const after = await lifecycle(userId);
      let identical = true; try { assert.deepEqual(after, before); } catch { identical = false; }
      receipt.steps.step5 = { eventId: event.id, eventStateBefore: event.state, status: r.status(), message: body.message ?? null, ok: body.ok ?? null,
        lifecycleBefore: before, lifecycleAfter: after, lifecycleIdentical: identical,
        platformAccountAfter: await platformAccount(accountId) };
      receipt.steps.step5.passed = r.status() === 409 && identical && event.state === 'delivered';
    } else receipt.steps.step5 = { passed: false, note: 'no deactivate event to send again' };
    save();
  }

  phase('step 4: Enable Login again, then Offboard with a last working day of yesterday; the pay-only restriction reaches the platform');
  {
    const { toggle } = await openPanel(employeeId);
    assert.equal((await toggle.innerText()).trim(), 'Enable Login');
    const pressed = await pressToggle(employeeId, toggle);
    receipt.steps.step4 = { enableLogin: pressed, lifecycleAfterEnable: await lifecycle(userId), platformAccountAfterEnable: await platformAccount(accountId) }; save();
    assert.equal(pressed.status, 200); assert.equal(pressed.isActive, true);
    const r = await call(origins.app, `/api/employees/${employeeId}/offboarding`, 'POST', { offboardingType: 'resignation', reasonCode: 'personal_reasons', lastWorkingDay: bangkokDay(-1) });
    const body = await r.json().catch(() => ({}));
    receipt.steps.step4.offboard = { status: r.status(), offboardingId: body.id, lastWorkingDay: 'yesterday (Bangkok)' }; save();
    assert.equal(r.status(), 201);
    const waited = await awaitEvent(userId, 'restrict');
    receipt.steps.step4.delivery = waited;
    receipt.steps.step4.profile = await profile(employeeId);
    receipt.steps.step4.lifecycle = await lifecycle(userId);
    receipt.steps.step4.platformAccount = await platformAccount(accountId); save();
    const again = await openPanel(employeeId).catch(() => null);
    if (again) {
      receipt.steps.step4.panelAfter = await panelState(again.section, again.toggle, again.panelReads);
      await again.section.scrollIntoViewIfNeeded();
      await again.section.screenshot({ path: resolve(out, '852-04-panel-after-offboard.png'), animations: 'disabled' });
    }
    receipt.steps.step4.passed = waited.event?.state === 'delivered' && waited.event.parked === false && waited.event.lastErrorCode === null;
    save();
  }
  receipt.behaviorRecorded = true;
} catch (error) {
  failed = true;
  receipt.failure = { phase: receipt.phase, name: error.name, message: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 220), path: new URL(app.url()).pathname,
    visibleTestIds: await app.locator('[data-testid]:visible').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-testid')).slice(0, 80)).catch(() => []) };
  save();
  await app.screenshot({ path: resolve(out, 'harness-failure.png'), mask: masks() }).catch(() => {});
} finally {
  phase('clean up the ZZ TEST rows and sign out');
  const cleanup = async (label, work) => {
    try { const note = await work(); receipt.cleanup.push({ label, passed: true, ...(note ?? {}) }); }
    catch (e) { failed = true; receipt.cleanup.push({ label, passed: false, message: String(e.message).split('\n')[0].slice(0, 200) }); }
    save();
  };
  const c = receipt.created;
  if (c.userId) await cleanup('before clean-up: the lifecycle events as they stand', async () => ({ lifecycle: await lifecycle(c.userId) }));
  if (c.accountId) {
    await cleanup('platform account: switch off on the Console (only if it is not off already)', async () => {
      const now = await platformAccount(c.accountId);
      if (now.accountStatus === 'inactive') return { alreadyInactive: true };
      assert.equal((await call(origins.console, `/api/accounts/${c.accountId}`, 'PATCH', { status: 'inactive' })).status(), 200);
      return { alreadyInactive: false };
    });
    await cleanup('platform account: withdraw the OTO App link', async () => {
      const r = await call(origins.console, `/api/admin/apps/oto_app/users/${c.accountId}`, 'DELETE');
      assert.ok([200, 404].includes(r.status()), `unlink answered ${r.status()}`);
      return { unlink: r.status() };
    });
    await cleanup('platform account: read back', async () => {
      const r = await call(origins.console, '/api/accounts'); assert.equal(r.status(), 200);
      const row = (await r.json()).accounts.find(a => a.id === c.accountId);
      assert.ok(row, 'the account is still listed (accounts are never hard-deleted)'); assert.equal(row.status, 'inactive');
      const perms = await call(origins.console, `/api/accounts/${c.accountId}/permissions`);
      const body = perms.status() === 200 ? await perms.json() : null;
      return { accountStatus: row.status, permissionsRead: perms.status(), permissionKeys: body ? Object.keys(body).sort() : null,
        counts: body ? Object.fromEntries(Object.entries(body).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])) : null };
    });
  }
  if (c.employeeId) await cleanup(`ZZ TEST employee: delete through the app's own delete`, async () => {
    const r = await call(origins.app, `/api/employees/${c.employeeId}`, 'DELETE');
    if (![200, 204].includes(r.status())) { const b = await r.json().catch(() => ({})); throw new Error(`delete answered ${r.status()} ${b.reason ?? ''} ${JSON.stringify(b.blocking ?? '')}`); }
    const back = (await call(origins.app, `/api/employees/${c.employeeId}`)).status(); assert.equal(back, 404);
    return { readBack: back };
  });
  if (c.userId) await cleanup('what stays: the lifecycle events of the deleted login', async () => ({ lifecycle: await lifecycle(c.userId) }));
  for (const [origin, logout, read, label] of [[origins.app, '/api/logout', '/api/user', 'app'], [origins.launcher, '/api/auth/sign-out', '/api/me', 'launcher'], [origins.console, '/api/auth/sign-out', '/api/me', 'console']]) {
    await cleanup(`sign out ${label}`, async () => { assert.ok([200, 204].includes((await call(origin, logout, 'POST')).status())); assert.equal((await call(origin, read)).status(), 401); });
  }
  await browser.close();
  receipt.passed = !failed && receipt.behaviorRecorded === true && receipt.steps.step3?.passed === true && receipt.steps.step5?.passed === true;
  receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, failure: receipt.failure, steps: receipt.steps, cleanup: receipt.cleanup }, null, 1));
  if (!receipt.passed) process.exitCode = 1;
}
