// SCRUM-1038 and SCRUM-1055 staging proof: a former employee invited to a
// single shift, on the old contract, through the HR app's own screens and
// routes, signed in as the staging admin through the launcher. Only ZZ TEST
// records made here are acted on: one profile (ended in the past through the
// offboarding route), one shift group with one shift row, one kiosk device;
// they are removed at the end, and what the app keeps for the record is said.
// No payroll is calculated, confirmed or paid. No real name is in a picture:
// the invite dialog's list of the branch's former employees is masked in the
// page before the picture, and the schedule picture is the ZZ TEST row alone.
// Usage: node proof.mjs <full-sha>
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const receipt = { tickets: ['SCRUM-1038', 'SCRUM-1055'], sha, startedAt: new Date().toISOString(), phase: 'sign-in', requests: [], made: [], steps: {}, cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = v => { receipt.phase = v; save(); console.log(v); };
process.on('unhandledRejection', e => { receipt.unhandled = String(e?.message ?? e).slice(0, 300); save(); });
const browser = await chromium.launch({ channel: 'msedge' });
const view = { viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' };
const ctx = await browser.newContext(view);
ctx.setDefaultTimeout(30000);
const app = await ctx.newPage();
const cards = await ctx.newPage();
const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
async function call(path, method = 'GET', data) {
  const r = await ctx.request.fetch(origins.app + path, { method, ...(data === undefined ? {} : { data }), headers: { origin: origins.app } });
  receipt.requests.push({ method, path: path.split('?')[0].replace(ID, ':id'), status: r.status() }); save();
  return r;
}
async function launcherSignIn(page, phone, password) {
  await page.goto(origins.launcher);
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
const bangkok = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(d);
const today = bangkok();
const yesterday = bangkok(new Date(Date.now() - 86_400_000));
const suffix = randomBytes(2).toString('hex');
// REUSE_EMPLOYEE_ID names the ZZ TEST profile an earlier run left (the app keeps a profile with a single shift for the record).
const reuse = process.env.REUSE_EMPLOYEE_ID ?? null;
let WORDS = `ZZ TEST 1038 ${suffix}`;
const deploy = `oto-app-staging at ${sha.slice(0, 9)}`;
const HELD = 'The pay rule for a casual day rate is being confirmed; use the old contract for now.';
const zz = {};
let failed = false;
try {
  await launcherSignIn(app, need('STAGING_ADMIN_PHONE'), need('STAGING_ADMIN_PASSWORD'));
  await app.locator('input[type="password"]').waitFor({ state: 'hidden' });
  receipt.steps.adminHandoff = await openApp(app);
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  phase('version');
  await expect.poll(async () => (await (await call('/api/qa-reports/config')).json()).version, { timeout: 600000, intervals: [15000] }).toBe(sha);
  const me = await (await call('/api/user')).json();
  receipt.adminRole = me.role; save();

  // ── Set-up: one ZZ TEST profile, ended in the past; one ZZ TEST shift row ──
  phase('make the ZZ TEST profile');
  const branches = (await (await call('/api/branches')).json()).filter(b => b.isActive !== false && !b.archivedAt);
  let branch = null, dept = null;
  for (const b of branches) {
    const depts = await (await call(`/api/departments?branchId=${b.id}`)).json();
    if (depts.length) { branch = b; dept = depts[0]; break; }
  }
  assert.ok(branch && dept, 'no branch with a department');
  receipt.branch = branch.name; save();
  let phone = `+668${String(10_000_000 + Math.floor(Math.random() * 89_999_999)).slice(0, 8)}`;
  let person;
  if (reuse) {
    person = await (await call(`/api/employees/${reuse}`)).json();
    assert.ok(person?.id && /^ZZ TEST 1038 /.test(person.fullName ?? ''), `reuse: not a ZZ TEST 1038 profile: ${JSON.stringify(person).slice(0, 120)}`);
    assert.equal(person.branchId, branch.id, 'the reused profile is at the chosen branch');
    WORDS = person.fullName.replace(/ Former$/, '');
    phone = person.phoneE164 ?? null; assert.ok(phone, 'the reused profile has a phone');
    zz.person = { id: person.id, name: person.fullName, reused: true }; receipt.reused = { kind: 'employee', id: person.id, name: person.fullName }; save();
  } else {
    const made = await call('/api/employees', 'POST', { fullName: `${WORDS} Former`, nickname: `${WORDS} Former`, email: `zz-test-1038-${suffix}@example.invalid`,
      branchId: branch.id, primaryDepartmentId: dept.id, status: 'active', employmentBasis: 'FULL_TIME', startDate: '2026-10-01',
      phone: phone.replace(/^\+66/, '0'), phoneE164: phone });
    person = await made.json(); assert.equal(made.status(), 201, person.message ?? '');
    zz.person = { id: person.id, name: `${WORDS} Former` }; receipt.made.push({ kind: 'employee', id: person.id, name: zz.person.name }); save();
    phase('end the employment in the past');
    const ended = await call(`/api/employees/${person.id}/offboarding`, 'POST', { offboardingType: 'resignation', reasonCode: 'other', reasonText: 'ZZ TEST proof', lastWorkingDay: yesterday, notes: 'ZZ TEST proof' });
    receipt.steps.offboarding = ended.status(); save();
    assert.ok([200, 201].includes(ended.status()), `offboarding: ${ended.status()} ${(await ended.text()).slice(0, 200)}`);
  }
  const profile = await (await call(`/api/employees/${person.id}`)).json();
  receipt.steps.profile = { status: profile.status, employmentState: profile.employmentState, lastWorkingDay: String(profile.lastWorkingDay ?? '').slice(0, 10) }; save();
  assert.equal(profile.employmentState, 'LEFT');

  phase('make the ZZ TEST shift row');
  const group = await (await call('/api/schedule/shift-groups', 'POST', { branchId: branch.id, name: `${WORDS} group` })).json();
  assert.ok(group.id, `shift group: ${JSON.stringify(group).slice(0, 200)}`);
  zz.group = { id: group.id }; receipt.made.push({ kind: 'shift group', id: group.id }); save();
  const row = await (await call('/api/schedule/shift-rows', 'POST', { branchId: branch.id, shiftGroupId: group.id, startTime: '09:00', endTime: '15:00', label: `${WORDS} Morning`, staffRequired: 1 })).json();
  assert.ok(row.id, `shift row: ${JSON.stringify(row).slice(0, 200)}`);
  zz.row = { id: row.id }; receipt.made.push({ kind: 'shift row', id: row.id }); save();

  // ── The invite dialog, on the Scheduling screen ──
  phase('the invite dialog');
  await app.evaluate(id => localStorage.setItem('oto_active_branch_id', id), branch.id);
  await app.goto(origins.app + '/scheduling');
  // The page opens on the employees view; the shift grid with its cells is the shifts view.
  await app.getByTestId('button-view-shifts').click();
  const addButton = app.getByTestId(`button-add-assignment-${row.id}-${today}`);
  await addButton.scrollIntoViewIfNeeded();
  await addButton.click();
  await app.getByTestId(`button-single-shift-${row.id}-${today}`).click();
  await expect(app.getByText('Invite a Former Employee')).toBeVisible();
  await expect(app.getByTestId(`button-single-shift-${person.id}`)).toBeVisible();
  // The dialog lists the branch's former employees: every other name is masked in the page before the picture.
  receipt.steps.dialogListMasked = await app.evaluate(ours => {
    let masked = 0;
    for (const b of document.querySelectorAll('[data-testid^="button-single-shift-"]')) {
      if (b.getAttribute('data-testid') === `button-single-shift-${ours}`) continue;
      const span = b.querySelector('span'); if (span) { span.textContent = 'Former employee (name masked)'; masked += 1; }
    }
    return masked;
  }, person.id); save();
  await app.getByTestId(`button-single-shift-${person.id}`).click();
  const casual = app.getByTestId('single-shift-invite-casual');
  await expect(casual).toBeDisabled();
  await expect(app.getByTestId('single-shift-invite-casual-held')).toHaveText(HELD);
  await expect(app.getByTestId('single-shift-invite-old-contract')).toHaveAttribute('aria-checked', 'true');
  receipt.steps.dialog = { oldContractChecked: true, casualDisabled: true, heldLine: HELD, noPayrollProfileHint: await app.getByTestId('single-shift-no-payroll-profile').count() }; save();
  await app.locator('[role="dialog"]').screenshot({ path: resolve(out, '1038-1-invite-dialog.png'), animations: 'disabled' });

  // ── Invite: the schedule entry carries the mark ──
  phase('invite');
  const invited = app.waitForResponse(r => new URL(r.url()).pathname === '/api/schedule/single-shift/invitations' && r.request().method() === 'POST');
  await app.getByTestId('button-single-shift-invite').click();
  const inv = await invited; const invitation = await inv.json();
  receipt.steps.invite = { status: inv.status(), payWay: invitation.payWay, payLabel: invitation.payLabel, shiftDate: invitation.shiftDate }; save();
  assert.equal(inv.status(), 201, JSON.stringify(invitation).slice(0, 200));
  zz.invitation = { id: invitation.id, assignmentId: invitation.assignmentId }; receipt.made.push({ kind: 'single shift invitation', id: invitation.id, assignmentId: invitation.assignmentId }); save();
  await expect(app.getByTestId(`single-shift-pay-${person.id}`)).toHaveText('On the old contract');
  await app.locator('[role="dialog"]').getByRole('button', { name: 'Close' }).click();
  await expect(app.getByText('Invite a Former Employee')).toBeHidden();
  const chip = app.getByText(`${WORDS} Former · single shift`).first();
  await expect(chip).toBeVisible();
  const label = app.getByText(`${WORDS} Morning`).first();
  const boxes = [await label.boundingBox(), await chip.boundingBox()];
  assert.ok(boxes.every(Boolean), 'the row label and the chip are on screen');
  const x = Math.min(...boxes.map(b => b.x)) - 12, y = Math.min(...boxes.map(b => b.y)) - 12;
  const clip = { x: Math.max(0, x), y: Math.max(0, y), width: Math.min(1440 - Math.max(0, x), Math.max(...boxes.map(b => b.x + b.width)) - Math.max(0, x) + 12), height: Math.max(...boxes.map(b => b.y + b.height)) - Math.max(0, y) + 12 };
  await app.screenshot({ path: resolve(out, '1038-2-schedule-single-shift.png'), clip, animations: 'disabled' });
  receipt.steps.scheduleChip = await chip.innerText(); save();

  // ── A change of pay to the casual day rate is refused by the route ──
  phase('route refuses the casual day rate');
  const refused = await call(`/api/schedule/single-shift/invitations/${invitation.id}`, 'PATCH', { payWay: 'casual_day_rate', casualDayRate: 500 });
  const refusal = await refused.json();
  receipt.steps.casualRefused = { status: refused.status(), message: refusal.message, reasonCode: refusal.reasonCode }; save();
  assert.deepEqual([refused.status(), refusal.message], [400, HELD]);
  const refusedNew = await call('/api/schedule/single-shift/invitations', 'POST', { employeeId: person.id, shiftRowId: row.id, shiftDate: today, payWay: 'casual_day_rate', casualDayRate: 500 });
  receipt.steps.casualNewRefused = { status: refusedNew.status(), message: (await refusedNew.json()).message }; save();
  assert.equal(refusedNew.status(), 400);

  // ── The kiosk: the route the tablet calls, with a ZZ TEST device at the branch ──
  phase('kiosk');
  const dev = await (await call('/api/kiosk-devices', 'POST', { branchId: branch.id, name: `${WORDS} tablet` })).json();
  assert.ok(dev.id && dev.deviceSecret, `kiosk device: ${JSON.stringify({ ...dev, deviceSecret: undefined }).slice(0, 200)}`);
  zz.device = { id: dev.id }; receipt.made.push({ kind: 'kiosk device', id: dev.id }); save();
  const clock = async () => {
    const r = await call('/api/kiosk/clock-phone', 'POST', { phone: phone.replace(/^\+66/, '0'), photoEvidenceUrl: '', deviceSecret: dev.deviceSecret });
    const body = await r.json();
    return { status: r.status(), success: body.success, eventType: body.eventType, keys: Object.keys(body).sort(), singleShifts: body.singleShifts, message: body.message };
  };
  const clockIn = await clock();
  const clockOut = await clock();
  receipt.steps.kiosk = { route: 'POST /api/kiosk/clock-phone', clockIn, clockOut }; save();
  assert.deepEqual([clockIn.status, clockIn.eventType], [200, 'IN'], JSON.stringify(clockIn));
  assert.deepEqual([clockOut.status, clockOut.eventType], [200, 'OUT'], JSON.stringify(clockOut));
  assert.equal(clockIn.singleShifts?.length, 1);
  assert.deepEqual([clockIn.singleShifts[0].shiftDate, clockIn.singleShifts[0].startTime, clockIn.singleShifts[0].endTime, clockIn.singleShifts[0].label], [today, '09:00', '15:00', `${WORDS} Morning`]);
  const s = clockIn.singleShifts[0];
  await card(cards, { title: 'SCRUM-1055: the kiosk tells the former employee their shift', subtitle: `POST /api/kiosk/clock-phone, the route the tablet calls, branch "${branch.name}", on staging`,
    identity: `${WORDS} Former (profile ended ${yesterday}, no login), a ZZ TEST kiosk device at the branch`, deploy,
    rows: [
      { tag: 'IN', ok: true, head: `clock-in answered 200, eventType IN, with the single shift`, note: 'on its day, at its branch',
        body: `singleShifts[0]: ${s.shiftDate} ${s.startTime} – ${s.endTime}, "${s.label}", department ${s.department ?? '—'}, role ${s.role ?? '—'}, branch ${s.branchName}, breaks ${JSON.stringify(s.breaks)}\nkeys of the answer: ${clockIn.keys.join(', ')} (no pay way, no pay)` },
      { tag: 'OUT', ok: true, head: `clock-out answered 200, eventType OUT, the same shift`, note: 'the day closes by itself tomorrow',
        body: `singleShifts: ${clockOut.singleShifts?.length ?? 0}` },
      { tag: 'PAY', ok: true, head: 'the casual day rate is held: the route answers 400', note: 'the owner\'s N1 is open',
        body: `PATCH pay way casual_day_rate → ${receipt.steps.casualRefused.status} "${receipt.steps.casualRefused.message}"\nPOST a new one on casual_day_rate → ${receipt.steps.casualNewRefused.status}` },
    ] }, resolve(out, '1038-3-kiosk-and-route-card.png'));
  receipt.behaviorPassed = true; save();
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, message: String(error?.message ?? error).slice(0, 600) }; save();
  console.error(error);
} finally {
  phase('clean-up');
  const tidy = async (label, fn) => { try { receipt.cleanup.push({ label, ...(await fn()) }); } catch (e) { failed = true; receipt.cleanup.push({ label, failed: String(e?.message ?? e).slice(0, 200) }); } save(); };
  if (zz.invitation?.assignmentId) await tidy('the single shift taken off the schedule', async () => ({ del: (await call(`/api/schedule/assignments/${zz.invitation.assignmentId}`, 'DELETE')).status() }));
  if (zz.row) await tidy('ZZ TEST shift row removed', async () => ({ del: (await call(`/api/schedule/shift-rows/${zz.row.id}`, 'DELETE')).status() }));
  if (zz.group) await tidy('ZZ TEST shift group removed', async () => ({ del: (await call(`/api/schedule/shift-groups/${zz.group.id}`, 'DELETE')).status() }));
  if (zz.device) await tidy('ZZ TEST kiosk device removed', async () => ({ del: (await call(`/api/kiosk-devices/${zz.device.id}`, 'DELETE')).status() }));
  if (zz.person) await tidy('ZZ TEST profile delete attempted', async () => {
    const r = await call(`/api/employees/${zz.person.id}`, 'DELETE');
    const body = await r.text();
    return { del: r.status(), says: body.replace(ID, ':id').slice(0, 240), read: (await call(`/api/employees/${zz.person.id}`)).status() };
  });
  await tidy('admin sign-out', async () => ({ app: (await call('/api/logout', 'POST', {})).status(), launcher: (await ctx.request.fetch(origins.launcher + '/api/auth/sign-out', { method: 'POST', data: {}, headers: { origin: origins.launcher } })).status() }));
  await browser.close();
  receipt.passed = !failed && receipt.behaviorPassed === true; receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, failure: receipt.failure, steps: receipt.steps, cleanup: receipt.cleanup }, null, 2));
}
