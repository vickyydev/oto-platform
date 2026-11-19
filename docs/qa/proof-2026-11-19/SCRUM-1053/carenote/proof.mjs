// SCRUM-1053 staging proof: a care note the family changes on the customer
// display, whose first save reply is lost, is written once. Adapted from the
// SCRUM-1017 proof. Own ZZ TEST till on the simulated box, own paired display,
// a returning ZZ TEST family made through the api, cash only. No credential,
// pairing code, band code, phone or raw response body enters the receipt or
// the console.
//
//   node proof.mjs <full-sha> <out-dir>
// ZZ_BASE moves the invented number; the run asserts it is unused first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '../../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const T = '1053';
const base = Number(process.env.ZZ_BASE ?? 21);
const number = '08981053' + String(base).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const family = `ZZ TEST SCRUM-${T} family ${base}`;
const kid = `ZZ TEST SCRUM-${T} child ${base}`;
const NOTE = 'ZZ TEST peanuts';
const EDITED = 'ZZ TEST peanuts and sesame';
const receipt = { ticket: `SCRUM-${T}`, sha, startedAt: new Date().toISOString(), phase: 'preflight', checks: {}, created: [], cleanup: [], pageErrors: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = (value) => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };
const firstLine = (error) => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let response = await once();
  if (response.status() === 401) { await adminSignIn(); response = await once(); }
  const isJson = /json/.test(response.headers()['content-type'] ?? '');
  const body = isJson ? await response.json().catch(() => null) : await response.body().catch(() => null);
  return { status: response.status(), body };
};

let browser = null, till = null, display = null, station = null, branchId = null, failed = false, memberId = null, childId = null;
const registrations = [];
const knownSales = new Set();

const shot = async (page, name) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
      page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/), page.getByTestId('band-codes').locator('span.font-mono'),
      page.getByText(/^Z\d{5,6}-[A-Z0-9]{4,8}$/), page.getByText(/\+66[\d ]{6,}/), page.getByText(/\b0\d{2} ?\d{3} ?\d{4}\b/),
      page.getByTestId('consent-kept-phone')] });
  console.log('picture', name);
};
function watch(page, label) {
  page.on('pageerror', (e) => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` });
  });
}
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const landing = (page) => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const registrationOf = async (id) => (await call('GET', '/checkin/registrations/' + id)).body;

async function signInAtTill(page) {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect.poll(async () => (await picker.isVisible()) && (await pick.isVisible()) || (await landing(page).isVisible()), { timeout: 60000 }).toBe(true);
  if (await picker.isVisible()) await pick.click();
  await page.locator('a[href="/history"]').first().waitFor();
}
async function pairDisplay() {
  phase('pair own customer display');
  const context = await browser.newContext({ baseURL: pos, viewport: { width: 1024, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  watch(page, 'display');
  await page.goto(`${pos}/display`);
  await page.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: fixtureName });
  assert.equal(paired.status, 200);
  display = { context, page, id: paired.body.device.id, revoked: false };
  receipt.created.push({ kind: 'display', id: display.id }); save();
  await landing(page).waitFor();
}
async function dropDisplay(reason = `ZZ TEST SCRUM-${T} proof complete`) {
  if (!display) return;
  const d = display; display = null;
  if (!d.revoked) {
    assert.equal((await call('POST', `/credentials/${d.id}/revoke`, { reason })).status, 200);
    receipt.cleanup.push({ kind: 'display', id: d.id, revoked: true }); save();
  }
  await d.context.close().catch(() => {});
}
async function staffPhotos() {
  await till.getByRole('button', { name: 'Private child details', exact: true }).click();
  const details = till.getByRole('dialog', { name: 'Private child details', exact: true });
  await details.waitFor();
  await details.getByRole('button', { name: 'Start camera', exact: true }).first().click();
  await details.getByRole('button', { name: 'Take photo', exact: true }).first().click();
  await expect(details.getByAltText('Captured', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Close', exact: true }).click();
}
async function release(regId) {
  const reg = await registrationOf(regId);
  for (const child of reg.children) {
    assert.ok(String(child.childName).startsWith('ZZ TEST'), 'only own test child');
    if (child.status !== 'in_park') continue;
    const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: `ZZ TEST SCRUM-${T} synthetic pickup.png` });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const released = await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    assert.equal(released.status, 200);
  }
  const after = await registrationOf(regId);
  receipt.cleanup.push({ kind: 'released', id: regId, children: after.children.map((c) => c.status) }); save();
}

async function proof() {
  phase('the returning ZZ TEST family, made through the api');
  const made = await call('POST', '/members', { phone: number, nickname: family });
  assert.equal(made.status, 200);
  memberId = made.body.member.id;
  receipt.created.push({ kind: 'member', id: memberId }); save();
  const child = await call('POST', `/members/${memberId}/children`, { name: kid, ageYears: 6, allergies: NOTE });
  assert.equal(child.status, 200);
  childId = child.body.child.id;
  receipt.created.push({ kind: 'child', id: childId }); save();

  await till.goto('/');
  await landing(till).or(till.getByRole('heading', { name: 'Membership Check', exact: true })).first().waitFor();
  await pairDisplay();
  phase('the family types their number on the display');
  for (let i = 0; i < 20 && !(await display.page.getByTestId('identify-safety').isVisible().catch(() => false)); i++) {
    if (await display.page.getByTestId('language-choice').isVisible().catch(() => false)) await display.page.getByTestId('language-choice-en').click().catch(() => {});
    await display.page.waitForTimeout(750);
  }
  await display.page.getByTestId('identify-safety').waitFor();
  await keypad(display.page.locator('body'), number);
  await display.page.getByRole('button', { name: 'Continue', exact: true }).click();
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  await visiting.waitFor({ timeout: 30000 });
  await visiting.getByRole('button', { name: /^Confirm 1 child/ }).click();
  await visiting.waitFor({ state: 'hidden', timeout: 30000 });
  phase('1 Hour Play, one child, no adult; the gate');
  const rateStep = till.getByRole('heading', { name: 'Select Customer Type', exact: true });
  const ticket = till.getByRole('heading', { name: '1 Hour Play', exact: true }).first();
  await expect.poll(async () => (await rateStep.isVisible()) || (await ticket.isVisible()), { timeout: 30000 }).toBe(true);
  if (await rateStep.isVisible()) await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await ticket.click();
  await till.getByRole('button', { name: 'Remove one Adults', exact: true }).first().click();
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const consent = display.page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  const allergies = consent.getByTestId('consent-saved-allergies');
  await expect(allergies).toHaveValue(NOTE, { timeout: 20000 });

  phase('the family updates the allergy note on the display');
  await allergies.fill(EDITED);
  await expect(till.getByTestId('consent-display-care')).toContainText('sesame', { timeout: 20000 });
  for (const checkbox of await consent.getByRole('checkbox').all()) { if (!(await checkbox.isChecked())) await checkbox.check(); }
  await staffPhotos();
  const done = consent.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeEnabled({ timeout: 30000 });

  phase('the first save reply is lost on the way back to the till');
  const sent = [];
  let lost = false;
  await till.route(`**/api/members/children/${childId}`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    sent.push({ key: route.request().headers()['idempotency-key'] ?? null, body: route.request().postData() });
    if (!lost) {
      lost = true;
      const actual = await route.fetch();
      receipt.checks.firstWriteStatus = actual.status(); save();
      await route.fulfill({ status: 504, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UPSTREAM_TIMEOUT', message: 'The upstream save reply was lost' } }) });
      return;
    }
    await route.continue();
  });
  const startedAt = new Date(Date.now() - 5000).toISOString();
  await done.click();
  await consent.getByTestId('consent-not-saved').waitFor({ timeout: 30000 });
  await expect(till.getByTestId('consent-staff-status')).toContainText('could not be saved', { timeout: 20000 });
  await shot(till, 'c1-till-not-saved.png');
  await shot(display.page, 'c2-display-not-saved.png');

  phase('the family presses Done again');
  const registered = till.waitForResponse((r) => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST', { timeout: 60000 });
  await expect(done).toBeEnabled({ timeout: 30000 });
  await done.click();
  const reg = await (await registered).json();
  registrations.push(reg.id);
  receipt.created.push({ kind: 'registration', id: reg.id }); save();
  await till.getByTestId('payment-step').waitFor({ timeout: 45000 });
  await till.unroute(`**/api/members/children/${childId}`);
  await till.waitForTimeout(1500);
  await shot(till, 'c3-till-after-retry.png');

  phase('the audit for that child, read through the api');
  const trail = await call('GET', `/audit?entityType=child&entityId=${childId}&action=child.update&from=${encodeURIComponent(startedAt)}`);
  assert.equal(trail.status, 200);
  const fromDisplay = trail.body.entries.filter((e) => e.after?.source === 'customer_display');
  const record = (await call('GET', `/members/${memberId}`)).body.member.children.find((c) => c.id === childId);
  receipt.checks.carenote = {
    patchesSent: sent.length,
    everyPatchKeyed: sent.every((s) => typeof s.key === 'string' && s.key.length > 0),
    sameKey: sent.length === 2 && sent[0].key === sent[1].key,
    sameBody: sent.length === 2 && sent[0].body === sent[1].body,
    auditRows: trail.body.entries.length,
    auditRowsFromDisplay: fromDisplay.length,
    recordHoldsEdit: record?.allergies === EDITED,
    registrationStatus: 'written',
  };
  save();
  console.log('CHECK', JSON.stringify(receipt.checks.carenote));

  // The card: what the platform kept, in a page of its own (no numbers on it).
  const card = await browser.newPage({ viewport: { width: 760, height: 430 } });
  const c = receipt.checks.carenote;
  const row = (label, value, ok) => `<tr><td>${label}</td><td style="font-weight:700;color:${ok ? '#0a7a3d' : '#b42318'}">${value}</td></tr>`;
  await card.setContent(`<!doctype html><html><body style="font:16px system-ui;margin:24px;background:#fff;color:#111">
    <h2 style="margin:0 0 4px">SCRUM-1053 · staging test-run card</h2>
    <p style="margin:0 0 16px;color:#555">A care note changed on the customer display; the first save reply lost; Done pressed again. Commit ${sha.slice(0, 9)}.</p>
    <table cellpadding="8" style="border-collapse:collapse">
      ${row('Care-note writes sent by the till', c.patchesSent, c.patchesSent === 2)}
      ${row('Both sent under one idempotency key', c.sameKey ? 'yes' : 'no', c.sameKey)}
      ${row('Same change both times', c.sameBody ? 'yes' : 'no', c.sameBody)}
      ${row('child.update audit rows for this child since the first Done', c.auditRows, c.auditRows === 1)}
      ${row('of them from the customer display', c.auditRowsFromDisplay, c.auditRowsFromDisplay === 1)}
      ${row("The child's record holds the family's note", c.recordHoldsEdit ? 'yes' : 'no', c.recordHoldsEdit)}
    </table></body></html>`);
  await card.screenshot({ path: resolve(out, 'c4-audit-card.png') });
  await card.close();
  console.log('picture', 'c4-audit-card.png');

  phase('pay cash, check in, then release');
  await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click();
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 60000 });
  const now = till.getByRole('button', { name: 'Check in now', exact: true });
  await now.waitFor({ timeout: 20000 });
  await now.click();
  await expect.poll(async () => (await registrationOf(reg.id)).children.every((ch) => ch.status === 'in_park'), { timeout: 30000 }).toBe(true);
  for (const s of await stationSales()) knownSales.add(s.id);
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  assert.ok(c.patchesSent === 2 && c.sameKey && c.sameBody && c.auditRows === 1 && c.auditRowsFromDisplay === 1 && c.recordHoldsEdit, 'the care note was written once');
}

try {
  phase('deployments');
  receipt.deployments = {};
  for (const name of ['oto-pos-staging', 'oto-pos-web-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=10`)).map((x) => x.deploy).find((x) => x.status === 'live');
    receipt.deployments[name] = { id: d?.id, status: d?.status, sha: d?.commit?.id };
  }
  save();
  const { execSync } = await import('node:child_process');
  for (const name of ['oto-pos-staging', 'oto-pos-web-staging']) {
    execSync(`git merge-base --is-ancestor ${sha} ${receipt.deployments[name].sha}`, { cwd: repo });
    receipt.deployments[name].containsProvedSha = true;
  }
  phase('sign in and create own till');
  await adminSignIn();
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find((b) => /Central Floresta/.test(b.name));
  assert.ok(branch); branchId = branch.id;
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find((b) => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online');
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const printerSource = stations.find((s) => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every((role) => s.devices.some((d) => d.role === role)));
  assert.ok(printerSource, 'simulated printers already configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map((role) => ({ role, deviceId: printerSource.devices.find((d) => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T.slice(1)}${String(i + 1).padStart(2, '0')}`).find((p) => !stations.some((s) => s.codePrefix === p));
  assert.ok(prefix);
  assert.equal((await call('GET', `/members/lookup?phone=${number}`)).body.member, null, 'ZZ TEST number must be unused');
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

  const video = resolve(out, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  watch(till, 'till');
  await till.goto(pos);
  phase('reception signs in at the own till');
  await signInAtTill(till);
  await proof();
  receipt.passed = true;
} catch (error) {
  failed = true; receipt.passed = false; receipt.failure = { phase: receipt.phase, failure: firstLine(error) };
  console.log('RUN FAILED', '|', receipt.phase, '|', firstLine(error));
  if (till) await shot(till, 'failed-till.png').catch(() => {});
  if (display) await shot(display.page, 'failed-display.png').catch(() => {});
} finally {
  phase('clean up');
  const clean = async (step, action) => {
    try { await action(); }
    catch (error) { failed = true; (receipt.cleanupFailures ??= []).push({ step, failure: firstLine(error) }); console.log('CLEANUP FAILED', step, '|', firstLine(error)); }
    save();
  };
  await clean('unpair customer display', () => dropDisplay());
  for (const id of registrations) await clean(`release ${id}`, () => release(id));
  if (station) {
    let sales = [];
    await clean('read own sales', async () => { sales = await stationSales(); for (const s of sales) assert.equal(s.stationId, station.id); });
    for (const sale of sales.filter((s) => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
      assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
      receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided' });
    });
    await clean('final sales read-back', async () => {
      const final = await stationSales();
      receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map((s) => ({ id: s.id, status: s.status })) });
    });
    await clean('retire own till', async () => {
      assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
      assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
      receipt.cleanup.push({ kind: 'station', id: station.id, archived: true });
    });
  }
  if (memberId) await clean('archive the ZZ TEST family', async () => {
    const member = (await call('GET', `/members/${memberId}`)).body.member;
    assert.ok(String(member.nickname).startsWith(`ZZ TEST SCRUM-${T}`), 'only own test member');
    assert.equal((await call('DELETE', `/members/${memberId}`)).status, 200);
    assert.equal((await call('GET', `/members/lookup?phone=${number}`)).body.member, null);
    receipt.cleanup.push({ kind: 'member', id: memberId, archived: true });
  });
  if (till) await clean('sign out till', async () => {
    if ((await till.request.get('/api/me')).status() === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.cleanup.push({ kind: 'till-session', signedOut: true });
  });
  await clean('sign out admin', async () => {
    if ((await admin.get('/api/me')).status() === 200) assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.carenote ?? null, pageErrors: receipt.pageErrors.length, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
