// SCRUM-1058 staging proof (and the Leave Types badge, a SCRUM-1037 follow-up),
// through the HR app's own screens and routes, signed in as the staging admin
// through the launcher. Only "ZZ TEST" profiles made here are acted on; they
// and their logins are removed at the end. The salary change is made on a
// ZZ TEST profile with made-up figures (10,000 to 11,000). No real name,
// phone number or pay figure is written to the receipt or shown in a picture:
// the Activity Logbook is searched for this run's ZZ TEST words, every row in
// a picture is checked to carry them before the picture is taken, and a
// staff session's reads are recorded as counts of salary changes only.
// The nickname is the name the activity log writes (getEmployeeDisplayName),
// so each ZZ TEST profile carries the run's words in it too (attempt 1 lacked it).
// Usage: node proof.mjs <full-sha>
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const lane = 'C:/oto-lanes/codex-app-reliability-983-20261114';
const { card } = await import(pathToFileURL(resolve(lane, 'scripts/agent/evidence.mjs')).href);
const { chromium, expect } = createRequire(resolve(lane, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2]; assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = import.meta.dirname;
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com', console: 'https://oto-console-staging.onrender.com' };
const receipt = { tickets: ['SCRUM-1058', 'SCRUM-1037 follow-up'], sha, startedAt: new Date().toISOString(), phase: 'sign-in', requests: [], made: [], steps: {}, cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = v => { receipt.phase = v; save(); console.log(v); };
process.on('unhandledRejection', e => { receipt.unhandled = String(e?.message ?? e).slice(0, 300); save(); });
const browser = await chromium.launch({ channel: 'msedge' });
const view = { viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' };
const ctx = { admin: await browser.newContext(view), staff: await browser.newContext(view), manager: await browser.newContext(view), console: await browser.newContext(view) };
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
const zz = {};
const accounts = [];
let failed = false;
const suffix = randomBytes(2).toString('hex');
const WORDS = `ZZ TEST 1058 ${suffix}`;
const deploy = `oto-app-staging at ${sha.slice(0, 9)}`;
const salaryChanges = body => (body.logs ?? []).filter(l => l.activityType === 'salary_change');
const ours = body => (body.logs ?? []).filter(l => String(l.summaryText ?? '').includes(WORDS));
try {
  await launcherSignIn(app, need('STAGING_ADMIN_PHONE'), need('STAGING_ADMIN_PASSWORD'));
  await app.locator('input[type="password"]').waitFor({ state: 'hidden' });
  receipt.steps.adminHandoff = await openApp(app);
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  phase('version');
  await expect.poll(async () => (await (await call('admin', origins.app, '/api/qa-reports/config')).json()).version, { timeout: 300000, intervals: [15000] }).toBe(sha);
  const me = await (await call('admin', origins.app, '/api/user')).json();
  receipt.adminRole = me.role; save();

  // ── The Leave Types badge: a switched-off type names no audience ──
  phase('leave types badge');
  await app.goto(origins.app + '/policies');
  const list = app.getByTestId('card-leave-types');
  await list.scrollIntoViewIfNeeded();
  await expect(app.getByTestId('leave-type-audience-SICK')).toHaveText('Managers only');
  const types = (await (await call('admin', origins.app, '/api/leave-types')).json()).map(({ code, isActive, managersOnly }) => ({ code, isActive, managersOnly }));
  const badges = {};
  for (const t of types) badges[t.code] = (await app.getByTestId(`leave-type-audience-${t.code}`).count()) ? await app.getByTestId(`leave-type-audience-${t.code}`).innerText() : null;
  receipt.steps.badges = types.map(t => ({ ...t, badge: badges[t.code] })); save();
  for (const t of types) assert.equal(badges[t.code], t.isActive ? (t.managersOnly ? 'Managers only' : 'Staff can see') : null, t.code);
  assert.ok(types.some(t => !t.isActive), 'at least one switched-off type to show');
  await list.screenshot({ path: resolve(out, '1058-1-leave-types-badge.png'), animations: 'disabled' });

  // ── Set-up: ZZ TEST profiles in one branch ──
  phase('make ZZ TEST profiles');
  const branches = (await (await call('admin', origins.app, '/api/branches')).json()).filter(b => b.isActive !== false && !b.archivedAt);
  let branch = null, dept = null;
  for (const b of branches) {
    const depts = await (await call('admin', origins.app, `/api/departments?branchId=${b.id}`)).json();
    if (depts.length) { branch = b; dept = depts[0]; break; }
  }
  assert.ok(branch && dept, 'no branch with a department');
  receipt.branch = branch.name; save();
  const phoneOf = () => `+668${String(10_000_000 + Math.floor(Math.random() * 89_999_999)).slice(0, 8)}`;
  const make = async (key, name, extra = {}) => {
    const r = await call('admin', origins.app, '/api/employees', 'POST', { fullName: name, nickname: name, email: `zz-test-1058-${key}-${suffix}@example.invalid`,
      branchId: branch.id, primaryDepartmentId: dept.id, status: 'active', employmentBasis: 'FULL_TIME', startDate: '2026-11-01', ...extra });
    const body = await r.json(); assert.equal(r.status(), 201, `${name}: ${body.message ?? ''}`);
    zz[key] = { id: body.id, userId: body.userId ?? null, name }; receipt.made.push({ kind: 'employee', id: body.id, name }); save();
  };
  await make('pay', `${WORDS} Pay`, { defaultMergeData: { salaryThb: 10000 } });
  const staffPhone = phoneOf(), managerPhone = phoneOf();
  await make('staff', `${WORDS} Staff`, { phone: staffPhone.replace(/^\+66/, '0'), phoneE164: staffPhone, setupLogin: true, loginPassword: randomBytes(12).toString('base64url'), accessLevel: 'STAFF' });
  await make('manager', `${WORDS} Manager`, { phone: managerPhone.replace(/^\+66/, '0'), phoneE164: managerPhone, setupLogin: true, loginPassword: randomBytes(12).toString('base64url'), accessLevel: 'MANAGER' });

  // ── A salary change on the ZZ TEST profile, through the employee edit ──
  phase('salary change');
  const changed = await call('admin', origins.app, `/api/employees/${zz.pay.id}`, 'PATCH', { defaultMergeData: { salaryThb: 11000 } });
  receipt.steps.salaryChange = changed.status(); save();
  assert.equal(changed.status(), 200);
  const q = `/api/activity-logs?limit=100&branchId=${branch.id}&search=${encodeURIComponent(WORDS)}`;
  const adminRead = await (await call('admin', origins.app, q)).json();
  receipt.steps.adminReads = { entries: ours(adminRead).map(l => ({ type: l.activityType, summary: l.summaryText })), salaryChanges: salaryChanges(adminRead).length }; save();
  assert.equal(salaryChanges(adminRead).length, 1, 'the administrator reads the ZZ TEST salary change');

  // ── The ZZ TEST staff and manager sessions ──
  const session = async (who, key, phone) => {
    phase(`${who} session`);
    const given = await call('admin', origins.app, `/api/users/${zz[key].userId}/suite-sign-in`, 'POST', { actionId: randomUUID(), phone });
    receipt.steps[`${who}SuiteSignIn`] = given.status(); save();
    assert.equal(given.status(), 200);
    const temporary = (await given.json()).temporaryPassword;
    const page = await ctx[who].newPage();
    const signIn = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/sign-in');
    await launcherSignIn(page, phone, temporary);
    const signed = await (await signIn).json(); accounts.push({ who, id: signed.accountId }); receipt.made.push({ kind: 'platform account', who, id: signed.accountId }); save();
    const own = randomBytes(12).toString('base64url');
    receipt.steps[`${who}ChangePassword`] = (await call(who, origins.launcher, '/api/auth/change-password', 'POST', { currentPassword: temporary, password: own })).status(); save();
    await page.goto(origins.launcher);
    receipt.steps[`${who}Handoff`] = await openApp(page); save();
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/user')).status), { timeout: 30000 }).toBe(200);
    receipt.steps[`${who}Role`] = (await (await call(who, origins.app, '/api/user')).json()).role; save();
    return page;
  };
  const reads = async who => {
    const searched = await (await call(who, origins.app, q)).json();
    const byType = await (await call(who, origins.app, `/api/activity-logs?limit=100&branchId=${branch.id}&types=salary_change`)).json();
    const all = await (await call(who, origins.app, `/api/activity-logs?limit=100&branchId=${branch.id}`)).json();
    const summary = await (await call(who, origins.app, `/api/activity-logs/summary?branchId=${branch.id}&sinceDays=30`)).json();
    // Counts and ZZ TEST words only: nobody else's entry is written down.
    return { searchedZzEntries: ours(searched).map(l => l.activityType), searchedSalaryChanges: salaryChanges(searched).length,
      typeFilterRows: byType.logs?.length ?? null, typeFilterTotal: byType.totalCount ?? null,
      branchPageSalaryChanges: salaryChanges(all).length, summarySalaryChange: summary.salary_change ?? null };
  };
  const staffPage = await session('staff', 'staff', staffPhone);
  receipt.steps.staffReads = await reads('staff'); save();
  const managerPage = await session('manager', 'manager', managerPhone);
  receipt.steps.managerReads = await reads('manager'); save();
  receipt.steps.adminReadsAll = await reads('admin'); save();
  for (const who of ['staff', 'manager']) {
    const r = receipt.steps[`${who}Reads`];
    assert.equal(r.searchedSalaryChanges, 0, who); assert.equal(r.typeFilterTotal, 0, who);
    assert.equal(r.branchPageSalaryChanges, 0, who); assert.equal(r.summarySalaryChange, 0, who);
  }
  assert.ok(receipt.steps.adminReadsAll.typeFilterTotal >= 1 && receipt.steps.adminReadsAll.summarySalaryChange >= 1, 'the administrator counts it');
  await staffPage.close();

  // ── The Activity Logbook screen, searched for this run's ZZ TEST words ──
  const logbook = async (page, who, file) => {
    phase(`${who} logbook`);
    await page.evaluate(id => localStorage.setItem('oto_active_branch_id', id), branch.id);
    await page.goto(origins.app + '/activity-logbook');
    await page.getByTestId('input-search-activity').fill(WORDS);
    await expect.poll(async () => (await page.locator('[data-testid^="activity-log-"]').allInnerTexts()).every(t => t.includes(WORDS)), { timeout: 30000 }).toBe(true);
    await page.waitForTimeout(1500);
    const rows = await page.locator('[data-testid^="activity-log-"]').allInnerTexts();
    assert.ok(rows.every(t => t.includes(WORDS)), `${who}: every row shown is this run's ZZ TEST`);
    receipt.steps[`${who}Logbook`] = rows.map(t => t.replace(/\s+/g, ' ').slice(0, 160)); save();
    const region = page.locator('main').first();
    await (await region.count() ? region : page).screenshot({ path: resolve(out, file), animations: 'disabled' });
    return rows;
  };
  const managerRows = await logbook(managerPage, 'manager', '1058-2-manager-logbook-no-salary-change.png');
  assert.ok(!managerRows.some(t => /Salary Change|salary changed/i.test(t)), 'the manager sees no salary change');
  const adminRows = await logbook(app, 'admin', '1058-3-admin-logbook-salary-change.png');
  assert.ok(adminRows.some(t => /salary changed from ฿10,000 to ฿11,000/.test(t)), 'the administrator sees the salary change');
  const s = receipt.steps;
  await card(cards, { title: 'SCRUM-1058: the activity log as each role reads it', subtitle: `GET /api/activity-logs and its summary, branch "${branch.name}", on staging`,
    identity: `ZZ TEST staff (app role: ${s.staffRole}), ZZ TEST manager (app role: ${s.managerRole}), staging admin (app role: ${me.role})`, deploy,
    rows: [
      { tag: 'STAFF', ok: true, head: 'ZZ TEST staff session: no salary change anywhere', note: 'the server leaves them out',
        body: `search for this run's ZZ TEST words: ${s.staffReads.searchedZzEntries.length} entries, salary changes ${s.staffReads.searchedSalaryChanges}\nfilter "Salary Change": ${s.staffReads.typeFilterTotal} entries\nthe branch's latest 100 entries: salary changes ${s.staffReads.branchPageSalaryChanges}\ndashboard summary, salary changes in 30 days: ${s.staffReads.summarySalaryChange}` },
      { tag: 'MANAGER', ok: true, head: 'ZZ TEST manager session: no salary change anywhere', note: 'managers are below the salary roles',
        body: `search for this run's ZZ TEST words: ${s.managerReads.searchedZzEntries.length} entries, salary changes ${s.managerReads.searchedSalaryChanges}\nfilter "Salary Change": ${s.managerReads.typeFilterTotal} entries\nthe branch's latest 100 entries: salary changes ${s.managerReads.branchPageSalaryChanges}\ndashboard summary, salary changes in 30 days: ${s.managerReads.summarySalaryChange}` },
      { tag: 'ADMIN', ok: true, head: 'Staging admin: the salary changes are there', note: 'a salary role reads the log whole',
        body: `search for this run's ZZ TEST words: salary changes ${s.adminReads.salaryChanges} (the ZZ TEST one, 10,000 to 11,000)\nfilter "Salary Change": counted, not listed here\ndashboard summary: counted, not listed here` },
    ] }, resolve(out, '1058-4-reads-by-role-card.png'));
  receipt.behaviorPassed = true; save();
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, message: String(error?.message ?? error).slice(0, 600) }; save();
  console.error(error);
} finally {
  phase('clean-up');
  const tidy = async (label, fn) => { try { receipt.cleanup.push({ label, ...(await fn()) }); } catch (e) { failed = true; receipt.cleanup.push({ label, failed: String(e?.message ?? e).slice(0, 200) }); } save(); };
  for (const who of ['staff', 'manager']) {
    await tidy(`${who} sign-out`, async () => ({ app: (await call(who, origins.app, '/api/logout', 'POST', {})).status(), launcher: (await call(who, origins.launcher, '/api/auth/sign-out', 'POST', {})).status() }));
  }
  if (accounts.length) {
    await tidy('console: ZZ TEST accounts inactive, app links removed', async () => {
      const page = await ctx.console.newPage();
      await launcherSignIn(page, need('STAGING_ADMIN_PHONE'), need('STAGING_ADMIN_PASSWORD'), origins.console);
      await page.waitForURL(/\/overview$/);
      const done = [];
      for (const a of accounts) {
        const off = (await call('console', origins.console, `/api/accounts/${a.id}`, 'PATCH', { status: 'inactive' })).status();
        const unlink = (await call('console', origins.console, `/api/admin/apps/oto_app/users/${a.id}`, 'DELETE')).status();
        done.push({ who: a.who, off, unlink });
      }
      const signOut = (await call('console', origins.console, '/api/auth/sign-out', 'POST', {})).status();
      return { done, signOut };
    });
  }
  for (const z of Object.values(zz)) {
    await tidy(`delete ${z.name.split(' ').slice(0, 3).join(' ')} ${z.name.split(' ').pop()}`, async () => {
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
