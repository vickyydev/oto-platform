// SCRUM-811 staging proof: Onboard Again's started toast says that the roles
// the platform took back stay taken back. One ZZ TEST employee with a login
// (and one without, the control), made here and removed here. The receipt
// holds ids and statuses only: no phone number, no name.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(root, 'scripts/agent/env.mjs')));
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const expectedSha = '98e269843f8887303839366bc8c07f58745d21db';
const out = resolve(import.meta.dirname, process.argv[2] ?? '.'); mkdirSync(out, { recursive: true });
const origins = { console: 'https://oto-console-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com', app: 'https://oto-app-staging.onrender.com' };
const ROLES = 'Their till and Console roles were taken back when they left; a Console administrator gives them back on Login users.';
const STARTED = 'The new employment has started.';
const receipt = { ticket: 'SCRUM-811', expectedSha, startedAt: new Date().toISOString(), phase: 'preflight', requests: [], created: {}, steps: {}, cleanup: [], passed: false };
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
  const events = (await r.json()).events.map(e => ({ id: e.id, kind: e.kind, state: e.state, attemptCount: e.attemptCount, lastErrorCode: e.lastErrorCode, createdAt: e.createdAt, settledAt: e.settledAt }));
  return { status: 200, events };
};
const profile = async id => {
  const r = await call(origins.app, `/api/employees/${id}`);
  if (r.status() !== 200) return { status: r.status() };
  const e = await r.json();
  return { status: 200, employeeStatus: e.status, employmentState: e.employmentState, hasLogin: !!e.userId, userId: e.userId ?? null };
};
/** Offboard as the Offboard dialog does: the same route, a resignation whose last working day was yesterday. */
const offboard = async id => {
  const r = await call(origins.app, `/api/employees/${id}/offboarding`, 'POST', { offboardingType: 'resignation', reasonCode: 'personal_reasons', lastWorkingDay: bangkokDay(-1) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status(), offboardingId: body.id };
};
/** The profile page's own Onboard Again button and dialog; answers the route's answer and the toast as shown. */
async function onboardAgain(id, templateName, names) {
  await app.goto(origins.app + `/employees/${id}`);
  await app.getByTestId('button-onboard-again').click();
  const dialog = app.getByRole('dialog'); await dialog.waitFor();
  const startShown = (await app.getByTestId('input-onboard-again-start-date').innerText()).trim();
  const departmentShown = (await app.getByTestId('select-onboard-again-department').innerText()).trim();
  if (!departmentShown || /Choose a department/.test(departmentShown)) {
    await app.getByTestId('select-onboard-again-department').click();
    await app.getByRole('option').first().click();
  }
  await app.getByTestId('select-onboard-again-template').click();
  await app.getByRole('option', { name: templateName, exact: true }).click();
  await expect(app.getByTestId('button-confirm-onboard-again')).toBeEnabled();
  await dialog.screenshot({ path: resolve(out, names.dialog), animations: 'disabled' });
  const answered = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/employees/${id}/onboard-again`);
  await app.getByTestId('button-confirm-onboard-again').click();
  const response = await answered, sent = response.request().postDataJSON(), answer = await response.json().catch(() => ({}));
  const toast = app.locator('li[data-state="open"]').filter({ hasText: /Onboard/ }).first();
  await toast.waitFor({ timeout: 15000 });
  await toast.hover().catch(() => {});
  await toast.screenshot({ path: resolve(out, names.toast) });
  const parts = await toast.locator('.grid > div').allInnerTexts();
  await app.screenshot({ path: resolve(out, names.page), mask: masks() });
  return {
    status: response.status(), startDateShown: startShown, startDateSent: sent.startDate, today: bangkokDay(0),
    started: answer.started, login: answer.login, platformRestrictionDelivered: answer.platformRestrictionDelivered,
    platformDeactivationDelivered: answer.platformDeactivationDelivered, rematch: answer.rematch,
    engagementId: answer.engagementId, contractId: answer.contract?.id, message: response.ok() ? undefined : answer.message,
    toastTitle: (parts[0] ?? '').replace(/\s+/g, ' ').trim(), toastText: (parts[1] ?? '').replace(/\s+/g, ' ').trim(),
  };
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

  phase('choose a branch with a contract template, and a department');
  const branches = (await (await call(origins.app, '/api/branches')).json()).filter(b => b.isActive !== false);
  const templates = (await (await call(origins.app, '/api/templates/with-assignments')).json()).filter(t => t.status === 'active');
  const template = templates.find(t => t.assignments.some(a => branches.some(b => b.id === a.branchId)));
  assert.ok(template, 'an active template assigned to an active branch');
  const branch = branches.find(b => template.assignments.some(a => a.branchId === b.id));
  const departments = (await (await call(origins.app, '/api/departments')).json()).filter(d => d.isActive !== false);
  const department = departments[0]; assert.ok(department, 'an active department');
  receipt.chosen = { branchId: branch.id, templateId: template.id, departmentId: department.id }; save();

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

  phase('step 1: create the ZZ TEST employee and its login through the employee editor');
  const suffix = Date.now().toString(36), email = `zz-test-811-${suffix}@example.com`;
  const made = await call(origins.app, '/api/employees', 'POST', { fullName: `ZZ TEST SCRUM-811 ${suffix}`, nickname: 'ZZ TEST', email, branchId: branch.id, primaryDepartmentId: department.id });
  assert.equal(made.status(), 201);
  const employeeId = (await made.json()).id; receipt.created.employeeId = employeeId; assert.ok(employeeId); save();
  await app.goto(origins.app + `/employees/${employeeId}`);
  await app.getByTestId('tab-access').click();
  const section = app.getByTestId('collapsible-access-login'); await section.waitFor();
  if (!(await app.getByTestId('button-enable-login').isVisible())) await section.getByText('Access & Login', { exact: true }).click();
  await app.getByTestId('button-enable-login').click();
  await app.getByTestId('input-login-email').fill(email);
  await app.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click();
  await app.getByTestId('input-employee-suite-phone').fill(phone);
  const created = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/employees/${employeeId}/enable-login`);
  await app.getByTestId('button-create-login').click();
  const loginResponse = await created, loginAnswer = await loginResponse.json().catch(() => ({}));
  for (const k of ['userId', 'personId', 'accessPolicyId', 'accountId']) if (loginAnswer[k]) receipt.created[k] = loginAnswer[k];
  receipt.steps.step1 = { employee: made.status(), enableLogin: loginResponse.status(), success: loginAnswer.success, replayed: loginAnswer.replayed,
    platformManaged: loginAnswer.platformManaged, platformAccount: !!loginAnswer.accountId, message: loginResponse.ok() ? undefined : loginAnswer.message }; save();
  assert.equal(loginResponse.status(), 200); assert.ok(loginAnswer.userId); assert.ok(loginAnswer.accountId);
  await app.getByTestId('text-enable-login-done-launcher').waitFor();
  receipt.steps.step1.profile = await profile(employeeId);
  receipt.steps.step1.lifecycleBefore = await lifecycle(loginAnswer.userId); save();

  phase('step 2: offboard with a last working day of yesterday');
  receipt.steps.step2 = { ...(await offboard(employeeId)), lastWorkingDay: 'yesterday (Bangkok)' };
  receipt.steps.step2.profile = await profile(employeeId); save();
  assert.equal(receipt.steps.step2.status, 201);

  phase('step 3: wait for the platform to have the restriction');
  const began = Date.now(); let newest = null, read = null;
  while (Date.now() - began < 240_000) {
    read = await lifecycle(loginAnswer.userId);
    newest = read.events.find(e => e.kind === 'restrict') ?? null;
    if (newest?.state === 'delivered') break;
    await sleep(10_000);
  }
  receipt.steps.step3 = { readStatus: read?.status, waitedSeconds: Math.round((Date.now() - began) / 1000), newestRestrict: newest, events: read?.events ?? [] }; save();
  const delivered = newest?.state === 'delivered';

  phase('step 4: Onboard Again on the ZZ TEST profile, and the toast');
  const step4 = await onboardAgain(employeeId, template.name, { dialog: '811-01-onboard-again-dialog.png', toast: '811-02-toast.png', page: '811-03-toast-on-profile.png' });
  if (step4.contractId) receipt.created.contractId = step4.contractId;
  receipt.steps.step4 = { ...step4, restrictionWasDelivered: delivered, sentenceShown: step4.toastText.includes(ROLES) };
  receipt.steps.step4.profile = await profile(employeeId);
  receipt.steps.step4.lifecycleAfter = await lifecycle(loginAnswer.userId); save();
  assert.equal(step4.status, 201); assert.equal(step4.started, true); assert.equal(step4.toastTitle, 'Onboarded again');
  assert.ok(step4.toastText.startsWith(STARTED));
  assert.equal(step4.platformRestrictionDelivered === true, delivered);
  assert.equal(receipt.steps.step4.sentenceShown, delivered);

  phase('step 5: the control, a ZZ TEST employee with no login');
  const suffix2 = Date.now().toString(36);
  const made2 = await call(origins.app, '/api/employees', 'POST', { fullName: `ZZ TEST SCRUM-811 control ${suffix2}`, nickname: 'ZZ TEST', email: `zz-test-811-control-${suffix2}@example.com`, branchId: branch.id, primaryDepartmentId: department.id });
  assert.equal(made2.status(), 201);
  const controlId = (await made2.json()).id; receipt.created.controlEmployeeId = controlId; save();
  const off2 = await offboard(controlId);
  receipt.steps.step5 = { employee: made2.status(), offboard: off2.status, profileLeft: await profile(controlId) }; save();
  assert.equal(off2.status, 201);
  const step5 = await onboardAgain(controlId, template.name, { dialog: '811-04-control-dialog.png', toast: '811-05-control-toast.png', page: '811-06-control-toast-on-profile.png' });
  if (step5.contractId) receipt.created.controlContractId = step5.contractId;
  receipt.steps.step5 = { ...receipt.steps.step5, ...step5, sentenceShown: step5.toastText.includes(ROLES), profile: await profile(controlId) }; save();
  assert.equal(step5.status, 201); assert.equal(step5.started, true);
  assert.equal(step5.toastText, STARTED); assert.notEqual(step5.platformRestrictionDelivered, true);
  receipt.behaviorRecorded = true; receipt.sentenceProved = delivered && receipt.steps.step4.sentenceShown;
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
  if (c.accountId) {
    await cleanup('platform account: switch off on the Console', async () => {
      assert.equal((await call(origins.console, `/api/accounts/${c.accountId}`, 'PATCH', { status: 'inactive' })).status(), 200);
    });
    await cleanup('platform account: withdraw the OTO App link', async () => {
      const r = await call(origins.console, `/api/admin/apps/oto_app/users/${c.accountId}`, 'DELETE'); assert.equal(r.status(), 200);
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
  for (const [contractKey, employeeKey, label] of [['contractId', 'employeeId', 'ZZ TEST employee'], ['controlContractId', 'controlEmployeeId', 'control employee']]) {
    if (c[contractKey]) await cleanup(`${label}: delete the draft contract Onboard Again made`, async () => {
      assert.ok([200, 204].includes((await call(origins.app, `/api/contracts/${c[contractKey]}`, 'DELETE')).status()));
      return { readBack: (await call(origins.app, `/api/contracts/${c[contractKey]}`)).status() };
    });
    if (c[employeeKey]) await cleanup(`${label}: delete through the app's own delete`, async () => {
      const r = await call(origins.app, `/api/employees/${c[employeeKey]}`, 'DELETE');
      if (![200, 204].includes(r.status())) { const b = await r.json().catch(() => ({})); throw new Error(`delete answered ${r.status()} ${b.reason ?? ''} ${JSON.stringify(b.blocking ?? '')}`); }
      const back = (await call(origins.app, `/api/employees/${c[employeeKey]}`)).status(); assert.equal(back, 404);
      return { readBack: back };
    });
  }
  if (c.userId) await cleanup('what stays: the lifecycle events of the deleted login', async () => ({ lifecycle: await lifecycle(c.userId) }));
  for (const [origin, logout, read, label] of [[origins.app, '/api/logout', '/api/user', 'app'], [origins.launcher, '/api/auth/sign-out', '/api/me', 'launcher'], [origins.console, '/api/auth/sign-out', '/api/me', 'console']]) {
    await cleanup(`sign out ${label}`, async () => { assert.ok([200, 204].includes((await call(origin, logout, 'POST')).status())); assert.equal((await call(origin, read)).status(), 401); });
  }
  await browser.close(); receipt.passed = !failed && receipt.behaviorRecorded === true; receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, sentenceProved: receipt.sentenceProved, failure: receipt.failure, steps: receipt.steps, cleanup: receipt.cleanup }, null, 1));
  if (!receipt.passed) process.exitCode = 1;
}
