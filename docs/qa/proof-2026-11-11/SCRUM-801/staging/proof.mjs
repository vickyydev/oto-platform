/* global getComputedStyle */
// Run only while Unit 1 owns the landing/proof slot. Deployed always waits for
// green landed-SHA CI. While it runs, a green byte-identical candidate may
// authorize the screen proof, as the plan watches main CI in the background.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import process from 'node:process';

const root = resolve(import.meta.dirname, '../../../../..');
const helperRoot = process.env.OTO_HELPER_ROOT ?? 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helperRoot, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helperRoot, 'scripts/agent/render.mjs')));
const { chromium, request, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'a full source SHA is required');
const runs = JSON.parse(execFileSync('gh', ['run', 'list', '--commit', sha, '--workflow', 'CI', '--json', 'databaseId,headSha,status,conclusion'], { cwd: root, encoding: 'utf8' }));
const ci = runs.find(run => run.headSha === sha);
assert.ok(ci, 'the exact source CI must exist');
let candidateGate = null;
if (ci.status !== 'completed' || ci.conclusion !== 'success') {
  assert.ok(['queued', 'in_progress'].includes(ci.status), 'a failed source CI stops proof');
  const candidate = process.argv[3];
  assert.match(candidate ?? '', /^[a-f0-9]{40}$/, 'pending main CI needs a green identical candidate');
  const differences = execFileSync('git', ['diff', '--name-only', candidate, sha], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(differences.every(path => path.startsWith('docs/')), 'candidate runtime, tests and workflow must be identical');
  const candidateRuns = JSON.parse(execFileSync('gh', ['run', 'list', '--commit', candidate, '--workflow', 'CI', '--json', 'databaseId,headSha,status,conclusion'], { cwd: root, encoding: 'utf8' }));
  const green = candidateRuns.find(run => run.headSha === candidate && run.status === 'completed' && run.conclusion === 'success');
  assert.ok(green, 'the exact identical candidate CI must be green');
  candidateGate = { sha: candidate, ci: green.databaseId, runtimeIdentical: true };
}
const out = import.meta.dirname;
const pos = 'https://oto-pos-web-staging.onrender.com';
const receipt = { unit: ['SCRUM-801', 'SCRUM-800'], sha, ci: ci.databaseId, ciAtStart: { status: ci.status, conclusion: ci.conclusion }, candidateGate, startedAt: new Date().toISOString(), deployments: {}, requests: [], created: [], checks: {}, cleanup: [] };
mkdirSync(out, { recursive: true });
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = name => { receipt.phase = name; save(); };

async function deployments() {
  const answer = {};
  for (const name of ['oto-pos-staging', 'oto-pos-web-staging']) {
    const svc = await service(name);
    assert.ok(svc, 'changed POS service exists');
    const rows = await render('GET', `/services/${svc.id}/deploys?limit=1`);
    const d = rows[0]?.deploy;
    assert.equal(d?.status, 'live', `${name} is live`);
    assert.equal(d?.commit?.id, sha, `${name} source matches`);
    answer[name] = { id: d.id, status: d.status, sha: d.commit.id };
  }
  return answer;
}
receipt.deployments = await deployments(); save();
const admin = await request.newContext({ baseURL: pos });
let browser;
let page;
let station;
let saleId;
let failure = false;
const call = async (method, path, data) => {
  const res = await admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }),
    headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  receipt.requests.push({ method, path, status: res.status() }); save();
  return { status: res.status(), body: await res.json().catch(() => null) };
};
try {
  phase('admin sign-in');
  const auth = await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } });
  assert.equal(auth.status(), 200, 'admin sign-in');
  phase('fixture lookup');
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  assert.ok(branch, 'proof park found');
  const boxes = (await call('GET', `/branches/${branch.id}/boxes`)).body.boxes;
  const box = boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'Virtual box 1 is online');
  const stations = (await call('GET', `/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z801${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix, 'an unused prefix including archived tills');
  const name = `ZZ TEST SCRUM-801 phone ${Date.now()}`;
  phase('create own till');
  const made = await call('POST', `/branches/${branch.id}/stations`, { name, kind: 'till', boxId: box.id, codePrefix: prefix,
    accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices: [] });
  assert.ok([200, 201].includes(made.status), 'own test till created');
  station = made.body.station;
  assert.equal(station.name, name);
  receipt.created.push({ kind: 'station', id: station.id }); save();

  phase('phone sign-in');
  browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ baseURL: pos, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Bangkok' });
  ctx.setDefaultTimeout(30000);
  page = await ctx.newPage();
  await page.goto(pos);
  const phone = need('STAGING_RECEPTION_PHONE');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(phone.replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name, exact: false }).first().click();
  phase('phone order');
  await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await page.getByText('1 Hour Play', { exact: true }).click();
  await page.getByRole('button', { name: 'Add one Kids', exact: true }).click();
  await page.getByRole('button', { name: 'Add one Adults', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  phase('customer details');
  await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
  for (const digit of '898010001') await page.getByRole('button', { name: digit, exact: true }).last().click();
  await page.getByPlaceholder('e.g. Mama, John').fill('ZZ TEST SCRUM-801');
  await page.getByTestId('input-done').click();
  phase('prepare payment');
  const writing = page.waitForResponse(r => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^Pay ฿/ }).click();
  const written = await writing;
  assert.equal(written.status(), 200);
  const sale = (await written.json()).sale;
  saleId = sale.id;
  assert.equal(sale.stationId, station.id);
  assert.equal(sale.status, 'tendering');
  receipt.created.push({ kind: 'sale', id: saleId });
  receipt.requests.push({ method: 'POST', path: '/sales', status: written.status(), id: saleId }); save();
  await page.getByRole('heading', { name: 'Cash', exact: true }).click();
  phase('payment width');
  const panel = page.getByTestId('payment-step');
  await expect.poll(() => panel.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
  await expect(panel.getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeEnabled();
  await expect(panel.getByRole('heading', { name: 'PromptPay', exact: true })).toBeVisible();
  const sizes = await panel.evaluate(el => [el, ...el.querySelectorAll('button,input,h2,h3')].map(node => {
    const b = node.getBoundingClientRect();
    return { element: node.tagName, left: b.left, right: b.right, width: b.width, scroll: node.scrollWidth, client: node.clientWidth };
  }));
  for (const b of sizes) { assert.ok(b.left >= 0 && b.right <= 375); assert.ok(b.scroll <= b.client + 1); }
  receipt.checks.paymentWidth = { viewport: 375, sizes }; save();
  const shot = async filename => {
    for (const close of await page.locator('[toast-close]').all()) await close.click();
    await page.screenshot({ path: resolve(out, filename), animations: 'disabled',
      mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.locator('input[type="tel"]')] });
  };
  phase('payment screenshots');
  await panel.getByRole('heading', { name: 'Amount Due' }).scrollIntoViewIfNeeded();
  await shot('s800-payment-375.png');
  await panel.getByRole('button', { name: 'Confirm Payment Received', exact: true }).scrollIntoViewIfNeeded();
  await shot('s800-confirm-375.png');
  phase('native cancellation');
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  const cancelling = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${saleId}/void`);
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  const cancelled = await cancelling;
  assert.equal(cancelled.status(), 200);
  receipt.requests.push({ method: 'POST', path: `/sales/${saleId}/void`, status: cancelled.status() });
  const read = await call('GET', `/sales/${saleId}`);
  assert.equal(read.body.sale.status, 'voided');
  receipt.checks.cancel = { saleId, status: read.body.sale.status }; save();
  phase('phone reload');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tourist', exact: true })).toBeVisible();
  await expect(page.getByTestId('payment-step')).toHaveCount(0);
  await shot('s801-reloaded-phone.png');
  phase('counter reload');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
  await expect(page.getByTestId('payment-step')).toHaveCount(0);
  receipt.checks.reload = { phoneEmpty: true, counterNoResume: true }; save();
  await shot('s801-reloaded-counter.png');
  assert.deepEqual(await deployments(), receipt.deployments, 'no rollout during proof');
} catch (error) {
  failure = true;
  // A Playwright error can contain filled input values. Keep only its kind.
  receipt.failure = { kind: error.name }; save();
} finally {
  const cleanup = async (kind, action) => {
    try { await action(); } catch (error) {
      failure = true;
      receipt.cleanup.push({ kind, failed: true, errorKind: error.name });
    } finally { save(); }
  };
  if (page) await cleanup('staff-session', async () => {
    const signedOut = await page.request.post('/api/auth/sign-out');
    const after = await page.request.get('/api/me');
    receipt.cleanup.push({ kind: 'staff-session', signOut: signedOut.status(), readback: after.status() });
    if (after.status() !== 401) failure = true;
  });
  let saleCleared = !saleId;
  if (saleId) await cleanup('sale', async () => {
    const read = await call('GET', `/sales/${saleId}`);
    assert.equal(read.body.sale.stationId, station.id, 'cleanup only own sale');
    if (read.body.sale.status === 'tendering') await call('POST', `/sales/${saleId}/void`, { reason: 'ZZ TEST SCRUM-801 proof cleanup' });
    const final = await call('GET', `/sales/${saleId}`);
    receipt.cleanup.push({ kind: 'sale', id: saleId, status: final.body.sale.status });
    saleCleared = final.body.sale.status === 'voided';
    if (!saleCleared) failure = true;
  });
  if (station) await cleanup('station', async () => {
    assert.ok(saleCleared, 'keep the till available if its sale still needs resolution');
    assert.ok(station.name.startsWith('ZZ TEST SCRUM-801 '));
    const archived = await call('DELETE', `/stations/${station.id}`);
    const after = await call('GET', `/stations/${station.id}`);
    const archivedFlag = !!(after.body?.station?.archivedAt ?? after.body?.archivedAt ?? after.body?.station?.archived);
    receipt.cleanup.push({ kind: 'station', id: station.id, status: archived.status, archived: archivedFlag });
    if (!archivedFlag) failure = true;
  });
  await cleanup('admin-session', async () => {
    const signOut = await admin.post('/api/auth/sign-out');
    const after = await admin.get('/api/me');
    receipt.cleanup.push({ kind: 'admin-session', signOut: signOut.status(), readback: after.status() });
    if (after.status() !== 401) failure = true;
  });
  await browser?.close(); await admin.dispose();
  receipt.finishedAt = new Date().toISOString(); receipt.passed = !failure; save();
}
process.stdout.write(JSON.stringify({ passed: !failure, receipt: resolve(out, 'receipt.json') }) + '\n');
process.exitCode = failure ? 1 : 0;
