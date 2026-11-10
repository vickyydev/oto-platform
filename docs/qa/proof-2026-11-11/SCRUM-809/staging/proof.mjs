// Run only while SCRUM-809 owns the source/API/proof slot.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../../..');
const helpers = process.env.OTO_HELPER_ROOT ?? 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helpers, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helpers, 'scripts/agent/render.mjs')));
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const runs = fullSha => JSON.parse(execFileSync('gh', ['run', 'list', '--commit', fullSha, '--workflow', 'CI', '--json', 'databaseId,headSha,status,conclusion'], { cwd: root, encoding: 'utf8' }));
const ci = runs(sha).find(r => r.headSha === sha);
assert.ok(ci, 'exact source CI exists');
let candidateGate = null;
if (ci.conclusion !== 'success') {
  assert.ok(['queued', 'in_progress'].includes(ci.status), 'failed source CI stops proof');
  const candidate = process.argv[3];
  assert.match(candidate ?? '', /^[a-f0-9]{40}$/);
  const diff = execFileSync('git', ['diff', '--name-only', candidate, sha], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(diff.every(p => p.startsWith('docs/')), 'candidate runtime/tests/workflow identical');
  const green = runs(candidate).find(r => r.headSha === candidate && r.status === 'completed' && r.conclusion === 'success');
  assert.ok(green, 'exact candidate fully green');
  candidateGate = { sha: candidate, ci: green.databaseId, runtimeIdentical: true };
}
const out = import.meta.dirname;
mkdirSync(out, { recursive: true });
const receipt = { ticket: 'SCRUM-809', sha, ci: ci.databaseId, ciAtStart: ci.status, candidateGate,
  startedAt: new Date().toISOString(), deployments: {}, requests: [], created: [], checks: {}, cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); };
async function deployments() {
  const answer = {};
  for (const name of ['oto-api-staging', 'oto-console-staging', 'oto-pos-staging', 'oto-pos-web-staging']) {
    const svc = await service(name);
    assert.ok(svc);
    const rows = await render('GET', `/services/${svc.id}/deploys?limit=1`);
    const d = rows[0]?.deploy;
    assert.equal(d?.status, 'live', name);
    assert.equal(d?.commit?.id, sha, name);
    answer[name] = { id: d.id, status: d.status, sha: d.commit.id };
  }
  return answer;
}
receipt.deployments = await deployments(); save();
const origin = 'https://oto-console-staging.onrender.com';
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Bangkok' });
ctx.setDefaultTimeout(30000);
const page = await ctx.newPage();
let branchId;
const owned = new Map();
let failed = false;
const call = async (method, path, data) => {
  const r = await ctx.request.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }),
    headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  receipt.requests.push({ method, path, status: r.status() }); save();
  return { status: r.status(), body: await r.json().catch(() => null) };
};
const list = async () => {
  const r = await call('GET', `/branches/${branchId}/stations?includeArchived=true`);
  assert.equal(r.status, 200);
  return r.body.stations;
};
const shot = async filename => {
  await page.screenshot({ path: resolve(out, filename), animations: 'disabled',
    mask: [page.getByRole('button', { name: 'Sign out', exact: true }).locator('..')] });
};
try {
  phase('Console sign-in');
  await page.goto(origin);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/overview$/);
  const branches = await call('GET', '/branches');
  assert.equal(branches.status, 200);
  const park = (branches.body.branches ?? branches.body).find(b => /Central Floresta/.test(b.name));
  assert.ok(park); branchId = park.id;
  const boxes = await call('GET', `/branches/${branchId}/boxes`);
  assert.equal(boxes.status, 200);
  const box = boxes.body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && !b.archived);
  assert.ok(box);
  const before = await list();
  const unused = Array.from({ length: 99 }, (_, i) => `Z809${String(i + 1).padStart(2, '0')}`).filter(p => !before.some(s => s.codePrefix === p));
  assert.ok(unused.length >= 2);
  const [oldPrefix, nextPrefix] = unused;
  const suffix = Date.now();
  const oldName = `ZZ TEST SCRUM-809 archived ${suffix}`;
  const nextName = `ZZ TEST SCRUM-809 replacement ${suffix}`;
  phase('isolated archived till');
  const old = await call('POST', `/branches/${branchId}/stations`, { name: oldName, kind: 'till', boxId: box.id,
    codePrefix: oldPrefix, accessScope: 'all_staff', devices: [], paymentRouting: { card: 'manual', qr: 'none' } });
  assert.equal(old.status, 200);
  const oldId = old.body.station.id;
  owned.set(oldId, oldName); receipt.created.push({ kind: 'station', id: oldId }); save();
  assert.equal((await call('DELETE', `/stations/${oldId}`)).status, 200);
  assert.equal((await list()).find(s => s.id === oldId)?.archived, true);
  phase('Console reused-prefix refusal');
  await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Branch', { exact: true }).selectOption(branchId);
  await page.getByRole('button', { name: 'Stations', exact: true }).click();
  await page.getByPlaceholder('Name, identifier or type').fill('ZZ TEST SCRUM-809');
  await page.getByRole('button', { name: 'New station', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'New station', exact: true });
  await drawer.getByLabel(/^Box/).selectOption(box.id);
  await drawer.getByLabel(/^Name/).fill(nextName);
  await drawer.getByLabel(/^Code prefix/).fill(oldPrefix);
  const creating = () => page.waitForResponse(r => new URL(r.url()).pathname === `/api/branches/${branchId}/stations` && r.request().method() === 'POST');
  const firstResponse = creating();
  await drawer.getByRole('button', { name: 'Create the station', exact: true }).click();
  const refusal = await firstResponse;
  assert.equal(refusal.status(), 409);
  const error = (await refusal.json()).error;
  assert.equal(error.code, 'STATION_CODE_PREFIX_TAKEN');
  assert.equal(error.details.stationId, oldId);
  await expect(drawer.getByRole('alert')).toContainText(oldName);
  await expect(drawer.getByRole('alert')).toContainText('archiving a till does not free');
  assert.equal((await list()).some(s => s.name === nextName), false);
  receipt.requests.push({ method: 'POST', path: `/branches/${branchId}/stations`, status: 409, code: error.code });
  receipt.checks.refusal = { earlierStationId: oldId, oldPrefix, earlierTillNamed: true, noReplacementSaved: true }; save();
  await shot('s809-archived-prefix-refused.png');
  phase('corrected prefix in the same form');
  await drawer.getByLabel(/^Code prefix/).fill(nextPrefix);
  const correctedResponse = creating();
  await drawer.getByRole('button', { name: 'Create the station', exact: true }).click();
  const corrected = await correctedResponse;
  assert.equal(corrected.status(), 200);
  const next = (await corrected.json()).station;
  assert.equal(next.name, nextName); assert.equal(next.codePrefix, nextPrefix);
  owned.set(next.id, nextName); receipt.created.push({ kind: 'station', id: next.id }); save();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('button', { name: nextName, exact: true })).toBeVisible();
  receipt.requests.push({ method: 'POST', path: `/branches/${branchId}/stations`, status: 200, id: next.id });
  receipt.checks.correction = { stationId: next.id, prefix: nextPrefix, savedFromSameForm: true }; save();
  await shot('s809-corrected-prefix-saved.png');
  assert.deepEqual(await deployments(), receipt.deployments, 'no rollout during proof');
} catch (error) {
  failed = true;
  // Browser errors may contain input values; retain only the kind and phase.
  receipt.failure = { kind: error.name }; save();
} finally {
  for (const [id, name] of owned) {
    try {
      const row = (await list()).find(s => s.id === id);
      assert.equal(row?.name, name); assert.ok(name.startsWith('ZZ TEST SCRUM-809 '));
      if (!row.archived) assert.equal((await call('DELETE', `/stations/${id}`)).status, 200);
      assert.equal((await list()).find(s => s.id === id)?.archived, true);
      receipt.cleanup.push({ kind: 'station', id, archived: true });
    } catch (error) { failed = true; receipt.cleanup.push({ kind: 'station', id, error: error.name }); }
    save();
  }
  try {
    const signedOut = await call('POST', '/auth/sign-out');
    assert.ok([200, 204].includes(signedOut.status));
    assert.equal((await call('GET', '/me')).status, 401);
    receipt.cleanup.push({ kind: 'session', signedOut: true, me: 401 });
  } catch (error) { failed = true; receipt.cleanup.push({ kind: 'session', error: error.name }); }
  await browser.close();
  receipt.passed = !failed; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, created: receipt.created, cleanup: receipt.cleanup }));
if (failed) process.exitCode = 1;
