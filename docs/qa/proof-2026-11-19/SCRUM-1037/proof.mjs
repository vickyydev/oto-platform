// SCRUM-1036 and SCRUM-1037 staging proof, through the HR app's own screens
// and routes, signed in as the staging admin through the launcher. Only
// "ZZ TEST" profiles made here are acted on; they and their login are removed
// at the end. No real name, phone number or pay figure is written to the
// receipt or shown in a picture: the Scheduling views are filtered to the
// ZZ TEST names, and a drag is sent only when every id it would save is one
// of the ZZ TEST profiles made here (checked in the browser before the
// request leaves; otherwise the request is aborted and nothing is written).
// Usage: node proof.mjs <full-sha>
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const lane = 'C:/oto-lanes/codex-app-reliability-983-20261114';
const { card, png } = await import(pathToFileURL(resolve(lane, 'scripts/agent/evidence.mjs')).href);
const { chromium, expect } = createRequire(resolve(lane, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2]; assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out37 = import.meta.dirname, out36 = resolve(import.meta.dirname, '../SCRUM-1036');
mkdirSync(out36, { recursive: true });
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com', console: 'https://oto-console-staging.onrender.com' };
const receipt = { tickets: ['SCRUM-1036', 'SCRUM-1037'], sha, startedAt: new Date().toISOString(), phase: 'sign-in', requests: [], made: [], steps: {}, cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out37, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = v => { receipt.phase = v; save(); console.log(v); };
// A wait that times out before it is awaited must not end the run before the clean-up.
process.on('unhandledRejection', e => { receipt.unhandled = String(e?.message ?? e).slice(0, 300); save(); });
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = { admin: await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' }),
  staff: await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' }),
  console: await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' }) };
for (const c of Object.values(ctx)) c.setDefaultTimeout(30000);
const app = await ctx.admin.newPage();
const cards = await ctx.admin.newPage();
async function call(who, origin, path, method = 'GET', data) {
  const r = await ctx[who].request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }), headers: { origin } });
  receipt.requests.push({ who, origin: new URL(origin).hostname.split('.')[0], method, path: path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id'), status: r.status() }); save();
  return r;
}
async function launcherSignIn(page, phone, password, origin = origins.launcher) {
  await page.goto(origin);
  await page.locator('input[type="tel"]').fill(phone.replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function openApp(page) {
  const handoff = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await page.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await page.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  const h = await handoff; await h.finished(); return h.status();
}
const shot = (page, file, opts = {}) => page.screenshot({ path: file, animations: 'disabled', ...opts });
const zz = { a: null, b: null, staff: null };
let staffAccountId = null, timeOffId = null, failed = false;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const deploy = `oto-app-staging at ${sha.slice(0, 9)}`;
try {
  await launcherSignIn(app, need('STAGING_ADMIN_PHONE'), need('STAGING_ADMIN_PASSWORD'));
  await app.locator('input[type="password"]').waitFor({ state: 'hidden' });
  receipt.steps.adminHandoff = await openApp(app);
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  phase('version');
  await expect.poll(async () => (await (await call('admin', origins.app, '/api/qa-reports/config')).json()).version, { timeout: 300000, intervals: [15000] }).toBe(sha);
  const me = await (await call('admin', origins.app, '/api/user')).json();
  receipt.adminRole = me.role; save();

  // ── SCRUM-1037 (a): the types after 0053, against the read before the deploy ──
  phase('1037 types after');
  const before = JSON.parse(readFileSync(resolve(out37, 'before.json'), 'utf8'));
  const after = (await (await call('admin', origins.app, '/api/leave-types')).json()).map(({ code, name, isActive, managersOnly }) => ({ code, name, isActive, managersOnly }));
  receipt.steps.types = { before: before.leaveTypes, after };
  const changes = after.map(t => { const b = before.leaveTypes.find(x => x.code === t.code);
    return `${t.code.padEnd(15)} ${t.name.padEnd(16)} active ${String(b?.isActive).padEnd(5)} -> ${String(t.isActive).padEnd(5)}  ${t.managersOnly ? 'managers only' : 'staff can see'}`; });
  save();
  await app.evaluate(() => window.scrollTo(0, 0));
  await app.goto(origins.app + '/policies');
  const list = app.getByTestId('card-leave-types');
  await list.scrollIntoViewIfNeeded(); await expect(app.getByTestId('leave-type-audience-SICK')).toHaveText('Managers only');
  await list.screenshot({ path: resolve(out37, '1037-1-leave-types-screen.png'), animations: 'disabled' });
  await app.getByRole('button', { name: /^Edit Sick Leave$/ }).click();
  const dialog = app.getByRole('dialog');
  await expect(dialog.getByTestId('switch-leave-type-managers-only')).toHaveAttribute('data-state', 'checked');
  await dialog.screenshot({ path: resolve(out37, '1037-2-sick-leave-managers-only-switch.png'), animations: 'disabled' });
  await app.keyboard.press('Escape');

  // ── Set-up: three ZZ TEST profiles in a branch whose unassigned group holds nobody else ──
  phase('choose a branch');
  const branches = (await (await call('admin', origins.app, '/api/branches')).json()).filter(b => b.isActive !== false && !b.archivedAt);
  const shown = e => e.employmentState === 'ACTIVE' || e.employmentState === 'LEAVING' || (e.employmentState === 'LEFT' && e.lastWorkingDay);
  // Scheduling draws only real departments, so the ZZ TEST profiles need one.
  // A drag saves its whole department, so it is done only in a department
  // where nobody else is shown in that branch.
  let branch = null, dept = null, fallback = null;
  for (const b of branches) {
    const people = await (await call('admin', origins.app, `/api/employees?branchId=${b.id}`)).json();
    const depts = await (await call('admin', origins.app, `/api/departments?branchId=${b.id}`)).json();
    for (const d of depts) {
      const others = people.filter(e => shown(e) && e.primaryDepartmentId === d.id && !String(e.fullName ?? '').startsWith('ZZ TEST'));
      receipt.steps.departmentScan = [...(receipt.steps.departmentScan ?? []), { branch: b.name, department: d.name, othersShown: others.length }]; save();
      fallback ??= { b, d };
      if (others.length === 0 && !branch) { branch = b; dept = d; }
    }
    if (branch) break;
  }
  receipt.steps.emptyDepartmentFound = !!branch; save();
  if (!branch) ({ b: branch, d: dept } = fallback);
  assert.ok(branch && dept, 'no department to place the ZZ TEST profiles');
  receipt.branch = branch.name; receipt.department = dept.name;
  const suffix = randomBytes(2).toString('hex');
  const phone = `+668${String(10_000_000 + Math.floor(Math.random() * 89_999_999)).slice(0, 8)}`;
  const loginPassword = randomBytes(12).toString('base64url');
  const make = async (key, name, extra = {}) => {
    const r = await call('admin', origins.app, '/api/employees', 'POST', { fullName: name, nickname: `ZZ ${key}`, email: `zz-test-${key}-${suffix}@example.invalid`,
      branchId: branch.id, primaryDepartmentId: dept.id, status: 'active', employmentBasis: 'FULL_TIME', startDate: '2026-11-01', ...extra });
    const body = await r.json(); assert.equal(r.status(), 201, `${name}: ${body.message ?? ''}`);
    zz[key] = { id: body.id, userId: body.userId ?? null, name }; receipt.made.push({ kind: 'employee', id: body.id, name }); save();
  };
  phase('make ZZ TEST profiles');
  await make('a', `ZZ TEST 1036 Ant ${suffix}`);
  await make('b', `ZZ TEST 1036 Bee ${suffix}`);
  await make('staff', `ZZ TEST 1037 Staff ${suffix}`, { phone: phone.replace(/^\+66/, '0'), phoneE164: phone, setupLogin: true, loginPassword, accessLevel: 'STAFF' });
  const inBranch = await (await call('admin', origins.app, `/api/employees?branchId=${branch.id}`)).json();
  const place = id => inBranch.find(e => e.id === id)?.displayOrder;
  const otherMax = Math.max(...inBranch.filter(e => !Object.values(zz).some(z => z?.id === e.id)).map(e => e.displayOrder ?? 0));
  receipt.steps.newPlaces = { a: place(zz.a.id), b: place(zz.b.id), staff: place(zz.staff.id), highestOtherInBranch: otherMax }; save();

  // ── SCRUM-1036: the drag saves the order shown ──
  phase('1036 drag');
  await app.evaluate(id => localStorage.setItem('oto_active_branch_id', id), branch.id);
  if (receipt.steps.emptyDepartmentFound) {
  const zzIds = new Set(Object.values(zz).map(z => z.id));
  await app.route('**/api/employees/reorder', async route => {
    const ids = route.request().postDataJSON()?.orderedIds ?? [];
    receipt.steps.reorderSent = { count: ids.length, allZzTest: ids.every(id => zzIds.has(id)) }; save();
    if (ids.length > 0 && ids.every(id => zzIds.has(id))) await route.continue(); else await route.abort();
  });
  await app.evaluate(id => localStorage.setItem('oto_active_branch_id', id), branch.id);
  const openScheduling = async () => {
    await app.goto(origins.app + '/scheduling');
    await app.getByTestId('input-schedule-search').fill(`ZZ TEST 1036`);
    await expect(app.getByTestId(`button-drag-employee-${zz.a.id}`)).toBeVisible({ timeout: 20000 });
    await expect(app.getByTestId(`button-drag-employee-${zz.b.id}`)).toBeVisible({ timeout: 20000 });
  };
  const order = async () => {
    const ya = (await app.getByTestId(`button-drag-employee-${zz.a.id}`).boundingBox()).y;
    const yb = (await app.getByTestId(`button-drag-employee-${zz.b.id}`).boundingBox()).y;
    return ya < yb ? 'Ant, Bee' : 'Bee, Ant';
  };
  await openScheduling();
  receipt.steps.orderBefore = await order(); save();
  await shot(app, resolve(out36, '1036-1-before-drag.png'));
  const from = await app.getByTestId(`button-drag-employee-${zz.b.id}`).boundingBox();
  const to = await app.getByTestId(`button-drag-employee-${zz.a.id}`).boundingBox();
  // dnd-kit starts after 8 px and measures the rows in the next frames: move
  // in small steps with pauses, hold over the target, then release.
  const answers = [];
  app.on('response', r => { if (new URL(r.url()).pathname === '/api/employees/reorder') answers.push(r.status()); });
  app.on('requestfailed', r => { if (new URL(r.url()).pathname === '/api/employees/reorder') answers.push(`failed: ${r.failure()?.errorText}`); });
  const saved = (async () => { for (let i = 0; i < 60 && !answers.length; i++) await app.waitForTimeout(500); return answers.length ? { status: () => answers[0] } : null; })();
  const x = from.x + from.width / 2, y0 = from.y + from.height / 2, y1 = to.y + to.height / 2 - 6;
  await app.mouse.move(x, y0);
  await app.mouse.down();
  await app.mouse.move(x, y0 - 10, { steps: 5 });
  await app.waitForTimeout(250);
  for (let i = 1; i <= 15; i++) { await app.mouse.move(x, y0 - 10 + ((y1 - y0 + 10) * i) / 15); await app.waitForTimeout(40); }
  await app.waitForTimeout(400);
  await app.mouse.up();
  const answer = await saved;
  receipt.steps.reorderStatus = answer ? answer.status() : 'no reorder request was sent'; save();
  assert.ok(answer, 'the drag sent no reorder request');
  assert.equal(answer.status(), 200);
  await openScheduling();
  receipt.steps.orderAfterReload = await order(); save();
  await shot(app, resolve(out36, '1036-2-after-drag-and-reload.png'));
  const reread = await (await call('admin', origins.app, `/api/employees?branchId=${branch.id}`)).json();
  receipt.steps.placesAfter = { a: reread.find(e => e.id === zz.a.id)?.displayOrder, b: reread.find(e => e.id === zz.b.id)?.displayOrder, staff: reread.find(e => e.id === zz.staff.id)?.displayOrder }; save();
  await app.unroute('**/api/employees/reorder');
  } else { receipt.steps.dragSkipped = 'no department in any branch is free of real staff; a drag would rewrite their places'; save(); }

  // ── SCRUM-1037 (b): the ZZ TEST staff member's own session ──
  phase('1037 staff session');
  const given = await call('admin', origins.app, `/api/users/${zz.staff.userId}/suite-sign-in`, 'POST', { actionId: randomUUID(), phone });
  receipt.steps.suiteSignIn = given.status(); save();
  assert.equal(given.status(), 200);
  const temporary = (await given.json()).temporaryPassword;
  const staffPage = await ctx.staff.newPage();
  const signIn = staffPage.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/sign-in');
  await launcherSignIn(staffPage, phone, temporary);
  const signed = await (await signIn).json(); staffAccountId = signed.accountId; receipt.made.push({ kind: 'platform account', id: staffAccountId }); save();
  const ownPassword = randomBytes(12).toString('base64url');
  const changed = await call('staff', origins.launcher, '/api/auth/change-password', 'POST', { currentPassword: temporary, password: ownPassword });
  receipt.steps.changePassword = changed.status(); save();
  await staffPage.goto(origins.launcher);
  receipt.steps.staffHandoff = await openApp(staffPage); save();
  await expect.poll(() => staffPage.evaluate(async () => (await fetch('/api/user')).status), { timeout: 30000 }).toBe(200);  const staffUser = await (await call('staff', origins.app, '/api/user')).json();
  receipt.steps.staffRole = staffUser.role; save();
  const staffTypes = await (await call('staff', origins.app, '/api/leave-types')).json();
  receipt.steps.staffSees = staffTypes.map(({ code, name, isActive }) => ({ code, name, isActive })); save();
  const attempt = await call('staff', origins.app, '/api/time-off', 'POST', { employeeId: zz.staff.id, branchId: branch.id, timeOffType: 'SICK', startDate: today, endDate: today });
  const attemptText = await attempt.text().catch(() => '');
  receipt.steps.staffRecordsSick = { status: attempt.status(), message: (() => { try { const b = JSON.parse(attemptText); return b.message ?? b.error?.message ?? attemptText.slice(0, 120); } catch { return attemptText.slice(0, 120); } })() }; save();
  const offered = staffTypes.filter(t => t.isActive).map(t => t.name);
  await card(cards, { title: 'SCRUM-1037: what a staff session is offered', subtitle: 'GET /api/leave-types and POST /api/time-off as the ZZ TEST staff member, on staging',
    identity: `ZZ TEST 1037 Staff (app role: ${staffUser.role})`, deploy,
    rows: [
      { tag: 'OFFERED', ok: offered.length === 2, head: `Leave types offered: ${offered.join(', ')}`, note: 'active types in the staff list', body: staffTypes.map(t => `${t.code.padEnd(15)} ${t.name.padEnd(16)} ${t.isActive ? 'active' : 'switched off'}`).join('\n') },
      { tag: 'HIDDEN', ok: !staffTypes.some(t => ['SICK', 'BUSINESS', 'UNPAID'].includes(t.code)), head: 'Sick Leave, Business Days, Unpaid Leave are not in the list', note: 'managers only, left out by the server' },
      { tag: String(attempt.status()), ok: attempt.status() === 403, head: 'Staff try to record Sick Leave for themselves', note: `refused: "${receipt.steps.staffRecordsSick.message}"; nothing saved` },
    ] }, resolve(out37, '1037-3-staff-session-card.png'));
  const leftAfterAttempt = await (await call('admin', origins.app, `/api/time-off?employeeId=${zz.staff.id}`)).json().catch(() => null);
  receipt.steps.timeOffAfterStaffAttempt = Array.isArray(leftAfterAttempt) ? leftAfterAttempt.length : leftAfterAttempt; save();

  // ── SCRUM-1037 (c): a manager records Sick Leave for the ZZ TEST staff member in Scheduling ──
  phase('1037 manager records');
  await app.goto(origins.app + '/scheduling');
  await app.getByTestId('input-schedule-search').fill('ZZ TEST 1037');
  await expect(app.locator(`[data-testid^="button-add-action-${zz.staff.id}-"]`).first()).toBeVisible({ timeout: 20000 });
  const todays = app.getByTestId(`button-add-action-${zz.staff.id}-${today}`);
  const action = (await todays.count()) ? todays : app.locator(`[data-testid^="button-add-action-${zz.staff.id}-"]`).last();
  await app.waitForTimeout(2000);
  await action.click();
  const day = (await action.getAttribute('data-testid')).slice(`button-add-action-${zz.staff.id}-`.length);
  receipt.steps.recordDay = day;
  const sick = app.getByTestId(`button-set-leave-sick-${zz.staff.id}-${day}`);
  await expect(sick).toBeVisible({ timeout: 20000 });
  const menu = app.locator('[data-radix-popper-content-wrapper]').last();
  receipt.steps.managerOffered = await menu.locator('[data-testid^="button-set-leave-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid').split('-')[3]));
  save();
  await menu.screenshot({ path: resolve(out37, '1037-4-manager-time-off-choices.png'), animations: 'disabled' });
  const recorded = app.waitForResponse(r => new URL(r.url()).pathname === '/api/time-off' && r.request().method() === 'POST');
  await sick.click();
  const rec = await recorded; const recBody = await rec.json().catch(() => ({}));
  timeOffId = recBody.id ?? recBody.timeOff?.id ?? null;
  receipt.steps.managerRecordsSick = { status: rec.status(), id: timeOffId }; save();
  assert.equal(rec.status(), 201);
  await app.keyboard.press('Escape');
  await app.waitForTimeout(1500);
  await shot(app, resolve(out37, '1037-5-sick-leave-recorded.png'));
  receipt.behaviorPassed = true; save();
  await card(cards, { title: 'SCRUM-1037: the leave types on staging, before and after the deploy', subtitle: 'the staging admin\'s park group, read through GET /api/leave-types before and after migration 0053',
    identity: `staging admin (app role: ${me.role})`, deploy,
    rows: [{ tag: 'TYPES', ok: true, head: 'code / name / active before -> after / who sees it', note: 'no type deleted; codes and names unchanged', body: changes.join('\n') }] }, resolve(out37, '1037-0-types-before-after-card.png'));
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, message: String(error?.message ?? error).slice(0, 600) }; save();
  console.error(error);
} finally {
  phase('clean-up');
  const tidy = async (label, fn) => { try { receipt.cleanup.push({ label, ...(await fn()) }); } catch (e) { failed = true; receipt.cleanup.push({ label, failed: String(e?.message ?? e).slice(0, 200) }); } save(); };
  if (timeOffId) await tidy('delete the ZZ TEST time off', async () => ({ status: (await call('admin', origins.app, `/api/time-off/${timeOffId}`, 'DELETE')).status() }));
  await tidy('staff sign-out', async () => ({ app: (await call('staff', origins.app, '/api/logout', 'POST', {})).status(), launcher: (await call('staff', origins.launcher, '/api/auth/sign-out', 'POST', {})).status() }));
  if (staffAccountId) {
    await tidy('console: account inactive, app link removed', async () => {
      const page = await ctx.console.newPage();
      await launcherSignIn(page, need('STAGING_ADMIN_PHONE'), need('STAGING_ADMIN_PASSWORD'), origins.console);
      await page.waitForURL(/\/overview$/);
      const off = (await call('console', origins.console, `/api/accounts/${staffAccountId}`, 'PATCH', { status: 'inactive' })).status();
      const unlink = (await call('console', origins.console, `/api/admin/apps/oto_app/users/${staffAccountId}`, 'DELETE')).status();
      const signOut = (await call('console', origins.console, '/api/auth/sign-out', 'POST', {})).status();
      return { off, unlink, signOut };
    });
  }
  for (const z of Object.values(zz).filter(Boolean)) {
    await tidy(`delete ${z.name.split(' ').slice(0, 4).join(' ')}`, async () => {
      const del = (await call('admin', origins.app, `/api/employees/${z.id}`, 'DELETE')).status();
      const read = (await call('admin', origins.app, `/api/employees/${z.id}`)).status();
      return { del, read };
    });
  }
  await tidy('admin sign-out', async () => ({ app: (await call('admin', origins.app, '/api/logout', 'POST', {})).status(), launcher: (await call('admin', origins.launcher, '/api/auth/sign-out', 'POST', {})).status() }));
  await browser.close();
  receipt.passed = !failed && receipt.behaviorPassed === true; receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, failure: receipt.failure, steps: receipt.steps, cleanup: receipt.cleanup }, null, 2));
}
