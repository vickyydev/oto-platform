// Retakes 1038-2-schedule-single-shift.png on a desk-wide screen (1920) with a
// short ZZ TEST nickname, so the "· single shift" mark is readable in the
// cell (proof.mjs took it at 1440 with the long ZZ TEST name, which the cell
// cuts short, as it cuts any long name). It also switches off the ZZ TEST
// kiosk device proof.mjs could not delete (its time records refer to it).
// Usage: REUSE_EMPLOYEE_ID=<id> KIOSK_DEVICE_ID=<id> node picture-2.mjs <full-sha>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const lane = 'C:/oto-lanes/codex-app-reliability-983-20261114';
const { chromium, expect } = createRequire(resolve(lane, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2]; assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const employeeId = process.env.REUSE_EMPLOYEE_ID; const deviceId = process.env.KIOSK_DEVICE_ID;
assert.ok(employeeId && deviceId, 'REUSE_EMPLOYEE_ID and KIOSK_DEVICE_ID');
const out = import.meta.dirname;
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const receipt = { picture: '1038-2-schedule-single-shift.png', sha, startedAt: new Date().toISOString(), requests: [], made: [], steps: {}, cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'picture-2-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 }, timezoneId: 'Asia/Bangkok' });
ctx.setDefaultTimeout(30000);
const app = await ctx.newPage();
async function call(path, method = 'GET', data) {
  const r = await ctx.request.fetch(origins.app + path, { method, ...(data === undefined ? {} : { data }), headers: { origin: origins.app } });
  receipt.requests.push({ method, path: path.split('?')[0].replace(ID, ':id'), status: r.status() }); save();
  return r;
}
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
const zz = {};
let failed = false, original = null;
try {
  await app.goto(origins.launcher);
  await app.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await app.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await app.getByRole('button', { name: 'Sign in', exact: true }).click();
  await app.locator('input[type="password"]').waitFor({ state: 'hidden' });
  await app.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await app.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  assert.equal((await (await call('/api/qa-reports/config')).json()).version, sha);

  const person = await (await call(`/api/employees/${employeeId}`)).json();
  assert.ok(/^ZZ TEST 1038 /.test(person.fullName ?? ''), 'a ZZ TEST 1038 profile');
  assert.equal(person.employmentState, 'LEFT');
  original = person.nickname;
  const WORDS = person.fullName.replace(/ Former$/, '');
  const short = `ZZ TEST ${WORDS.split(' ').pop()}`;
  const renamed = await call(`/api/employees/${employeeId}`, 'PATCH', { nickname: short });
  receipt.steps.nickname = { status: renamed.status(), from: original, to: short }; save();
  assert.equal(renamed.status(), 200);
  const branch = await (await call(`/api/branches/${person.branchId}`)).json();
  receipt.branch = branch.name; save();

  const group = await (await call('/api/schedule/shift-groups', 'POST', { branchId: person.branchId, name: `${WORDS} group` })).json();
  assert.ok(group.id); zz.group = group.id; receipt.made.push({ kind: 'shift group', id: group.id }); save();
  const row = await (await call('/api/schedule/shift-rows', 'POST', { branchId: person.branchId, shiftGroupId: group.id, startTime: '09:00', endTime: '15:00', label: `${WORDS} Morning`, staffRequired: 1 })).json();
  assert.ok(row.id); zz.row = row.id; receipt.made.push({ kind: 'shift row', id: row.id }); save();
  const inv = await call('/api/schedule/single-shift/invitations', 'POST', { employeeId, shiftRowId: row.id, shiftDate: today, payWay: 'old_contract' });
  const invitation = await inv.json();
  receipt.steps.invite = { status: inv.status(), payLabel: invitation.payLabel }; save();
  assert.equal(inv.status(), 201, JSON.stringify(invitation).slice(0, 200));
  zz.assignment = invitation.assignmentId; receipt.made.push({ kind: 'single shift invitation', id: invitation.id, assignmentId: invitation.assignmentId }); save();

  await app.evaluate(id => localStorage.setItem('oto_active_branch_id', id), person.branchId);
  await app.goto(origins.app + '/scheduling');
  await app.getByTestId('button-view-shifts').click();
  const chip = app.getByText(`${short} · single shift`).first();
  await expect(chip).toBeVisible();
  const label = app.getByText(`${WORDS} Morning`).first();
  await label.scrollIntoViewIfNeeded();
  const boxes = [await label.boundingBox(), await chip.boundingBox()];
  assert.ok(boxes.every(Boolean));
  const x = Math.max(0, Math.min(...boxes.map(b => b.x)) - 12), y = Math.max(0, Math.min(...boxes.map(b => b.y)) - 12);
  const clip = { x, y, width: Math.min(1920 - x, Math.max(...boxes.map(b => b.x + b.width)) - x + 12), height: Math.max(...boxes.map(b => b.y + b.height)) - y + 12 };
  await app.screenshot({ path: resolve(out, '1038-2-schedule-single-shift.png'), clip, animations: 'disabled' });
  receipt.steps.chip = await chip.innerText(); save();

  const off = await call(`/api/kiosk-devices/${deviceId}`, 'PATCH', { isActive: false });
  const device = await (await call(`/api/kiosk-devices/${deviceId}`)).json();
  receipt.steps.kioskDevice = { patch: off.status(), name: device.name, isActive: device.isActive }; save();
  assert.equal(device.isActive, false);
  assert.match(device.name ?? '', /^ZZ TEST/);
  receipt.behaviorPassed = true; save();
} catch (error) {
  failed = true; receipt.failure = String(error?.message ?? error).slice(0, 600); save();
  console.error(error);
} finally {
  const tidy = async (label, fn) => { try { receipt.cleanup.push({ label, ...(await fn()) }); } catch (e) { failed = true; receipt.cleanup.push({ label, failed: String(e?.message ?? e).slice(0, 200) }); } save(); };
  if (zz.assignment) await tidy('the single shift taken off the schedule', async () => ({ del: (await call(`/api/schedule/assignments/${zz.assignment}`, 'DELETE')).status() }));
  if (zz.row) await tidy('ZZ TEST shift row removed', async () => ({ del: (await call(`/api/schedule/shift-rows/${zz.row}`, 'DELETE')).status() }));
  if (zz.group) await tidy('ZZ TEST shift group removed', async () => ({ del: (await call(`/api/schedule/shift-groups/${zz.group}`, 'DELETE')).status() }));
  if (original !== null) await tidy('nickname restored', async () => ({ patch: (await call(`/api/employees/${employeeId}`, 'PATCH', { nickname: original })).status() }));
  await tidy('admin sign-out', async () => ({ app: (await call('/api/logout', 'POST', {})).status(), launcher: (await ctx.request.fetch(origins.launcher + '/api/auth/sign-out', { method: 'POST', data: {}, headers: { origin: origins.launcher } })).status() }));
  await browser.close();
  receipt.passed = !failed && receipt.behaviorPassed === true; receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, failure: receipt.failure, steps: receipt.steps, cleanup: receipt.cleanup }, null, 2));
}
