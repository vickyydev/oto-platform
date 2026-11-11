// SCRUM-807. Run on the named live source; proof does not hold the landing slot.
// No credentials, pairing code, phone or raw response bodies enter the receipt.
import assert from 'node:assert/strict';
import { prove } from './flow.mjs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const { chromium, request, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 10_000_000 });
const ciFor = source => JSON.parse(execFileSync('gh', ['run', 'list', '--commit', source, '--workflow', 'CI', '--json', 'databaseId,headSha,status,conclusion'], { cwd: root, encoding: 'utf8' })).find(r => r.headSha === source);
const ci = ciFor(sha);
assert.ok(ci);
assert.ok(!['failure', 'timed_out'].includes(ci.conclusion), 'failed source gate stops proof');
const out = import.meta.dirname;
const pos = 'https://oto-pos-web-staging.onrender.com';
const receipt = { tickets: ['SCRUM-807'], sha, ci, localGates: '../local-gates.json', startedAt: new Date().toISOString(), phase: 'preflight', requests: [], created: [], checks: {}, cleanup: [] };
mkdirSync(out, { recursive: true });
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); };
async function deployments() {
  const result = {};
  for (const name of ['oto-pos-staging', 'oto-pos-web-staging', 'oto-api-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
    assert.equal(d?.status, 'live', `${name} is live`);
    if (name !== 'oto-api-staging') assert.equal(d.commit.id, sha, 'changed service at proved source');
    else receipt.apiRuntimeDifferences = git(['diff', '--name-only', sha, d.commit.id, '--', 'apps/api/src', 'packages']).trim().split('\n').filter(Boolean);
    result[name] = { id: d.id, status: d.status, sha: d.commit.id };
  }
  return result;
}
receipt.deployments = await deployments(); save();
const admin = await request.newContext({ baseURL: pos });
const call = async (method, path, data) => {
  const response = await admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  receipt.requests.push({ method, path: path.split('?')[0], status: response.status() }); save();
  return { status: response.status(), body: await response.json().catch(() => null) };
};
let browser, tillContext, displayContext, till, display, station, displayId, branchId;
const testNumbers = ['0898070011']; // ZZ TEST only.
const formatted = index => `+66 89 807 001${index + 1}`;
const fixtureName = `ZZ TEST SCRUM-807 Golden Ticket ${Date.now()}`;
let failed = false;
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
      page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByTestId('voucher-card'), page.getByTestId('voucher-used'), page.getByText(/^QR-[A-Z0-9]+$/)] });
};
const keypad = async (page, digits) => { for (const digit of digits) await page.getByRole('button', { name: digit, exact: true }).last().click(); };
const identify = async index => {
  phase(`guest ${index + 1}: language choice`);
  await display.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first().waitFor();
  if (await display.getByTestId('language-choice').isVisible()) await display.getByTestId('language-choice-en').click();
  phase(`guest ${index + 1}: type test number`);
  await display.getByTestId('identify-safety').waitFor();
  await keypad(display, testNumbers[index]);
  await display.getByRole('button', { name: 'Continue', exact: true }).click();
  phase(`guest ${index + 1}: member offer`);
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  await expect(offer).toContainText(formatted(index));
  
  phase(`guest ${index + 1}: continue as walk-in`);
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
};
try {
  phase('sign in and create own till');
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  assert.ok(branch); branchId = branch.id;
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online');
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const printerSource = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(role => s.devices.some(d => d.role === role)));
  assert.ok(printerSource, 'simulated printers already configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: printerSource.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z807${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  for (const phone of testNumbers) assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null, 'ZZ TEST number must be unused');
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  assert.equal(station.name, fixtureName);
  receipt.created.push({ kind: 'station', id: station.id }); save();
  const video = resolve(out, '../local/camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  displayContext = await browser.newContext({ baseURL: pos, viewport: { width: 1024, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  tillContext.setDefaultTimeout(30000); displayContext.setDefaultTimeout(30000);
  till = await tillContext.newPage(); display = await displayContext.newPage();
  await till.goto(pos);
  await till.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await till.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await till.getByRole('button', { name: 'Sign in', exact: true }).click();
  await till.getByRole('button', { name: fixtureName, exact: false }).first().click();
  phase('pair own customer display');
  await display.goto(`${pos}/display`);
  await display.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await display.getByTestId('display-pairing-code').textContent()).trim();
  assert.match(pairingCode, /^\d{6}$/);
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: fixtureName });
  assert.equal(paired.status, 200); displayId = paired.body.device.id;
  receipt.created.push({ kind: 'display', id: displayId }); save();

  await prove({ till, display, call, expect, phase, shot, identify, receipt, save, branchId, station, prefix });
  receipt.deploymentsAfter = await deployments();
  receipt.passed = true;
} catch (error) {
  failed = true; receipt.passed = false; receipt.failure = { phase: receipt.phase, kind: error.name, frames: (error.stack ?? '').split('\n').filter(l => l.includes('proof.mjs:')).map(l => l.match(/proof.mjs:\d+:\d+/)?.[0]) };
  // No exception text: a browser call log can include the value being typed.
  if (till) await shot(till, 'failed-attempt.png').catch(() => {});
  if (display) await shot(display, 'failed-display.png').catch(() => {});
} finally {
  const clean = async (step, action) => {
    try { await action(); }
    catch (error) {
      failed = true; receipt.passed = false;
      (receipt.cleanupFailures ??= []).push({ step, kind: error.name });
    }
    save();
  };
  await clean('close customer display', async () => {
    if (displayContext) { await displayContext.close(); displayContext = null; }
  });
  let ownsStation = false;
  if (station) {
    await clean('verify own till', async () => {
      const own = (await call('GET', `/stations/${station.id}`)).body.station;
      assert.equal(own.name, fixtureName);
      ownsStation = true;
    });
    if (ownsStation) {
      for (const item of receipt.created.filter(item => item.kind === 'registration')) await clean('release own test child', async () => {
        const reg = (await call('GET', '/checkin/registrations/' + item.id)).body;
        assert.equal(reg.guardianName, 'ZZ TEST SCRUM-807 guardian');
        for (const child of reg.children) {
          assert.equal(child.childName, 'ZZ TEST SCRUM-807 child');
          if (child.status === 'in_park') {
            assert.ok(reg.photoFileId || child.photoFileId);
            assert.equal((await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: reg.photoFileId || child.photoFileId, stationId: station.id })).status, 200);
          }
        }
        const after = (await call('GET', '/checkin/registrations/' + item.id)).body;
        assert.ok(after.children.every(child => child.status === 'out'));
        receipt.cleanup.push({ kind: 'registration', id: item.id, children: after.children.map(child => ({ id: child.id, status: child.status })), syntheticPhotoReusedForCleanup: true });
      });
      let sales = [];
      await clean('read own sales', async () => {
        sales = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
        assert.ok(Array.isArray(sales));
        for (const sale of sales) assert.equal(sale.stationId, station.id);
      });
      for (const sale of sales.filter(s => s.status === 'tendering' || s.status === 'open')) {
        await clean(`void ${sale.id}`, async () => {
          assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: 'ZZ TEST SCRUM-807 proof cleanup' })).status, 200);
          assert.equal((await call('GET', `/sales/${sale.id}`)).body.sale.status, 'voided');
          receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided' });
        });
      }
      for (const { id } of sales.filter(s => s.status === 'finalised')) await clean(`print ${id}`, async () => {
        let jobs;
        await expect.poll(async () => {
          jobs = (await call('GET', `/sales/${id}`)).body.printJobs;
          return jobs.every(j => j.status === 'printed');
        }, { timeout: 60000 }).toBe(true);
        receipt.cleanup.push({ kind: 'paid-test-sale', id, retained: true, printJobs: jobs.map(j => ({ id: j.id, status: j.status })) });
      });
      if (displayId) await clean('revoke own display', async () => {
        assert.equal((await call('POST', `/credentials/${displayId}/revoke`, { reason: 'ZZ TEST SCRUM-807 proof complete' })).status, 200);
        assert.ok(!(await call('GET', `/stations/${station.id}/displays`)).body.displays.some(d => d.id === displayId));
        receipt.cleanup.push({ kind: 'display', id: displayId, revoked: true });
      });
      await clean('retire own till', async () => {
        assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
        assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
        const retired = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === station.id);
        assert.ok(retired.archived); assert.equal(retired.devices.length, 0);
        receipt.cleanup.push({ kind: 'station', id: station.id, archived: true, devices: 0 });
      });
      for (const [index, phone] of testNumbers.entries()) await clean(`check test member ${index}`, async () => {
        const member = (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member;
        if (member) {
          assert.ok(member.nickname.startsWith('ZZ TEST SCRUM-807'), 'only own named test members');
          assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
          assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null);
          receipt.cleanup.push({ kind: 'member', id: member.id, archived: true });
        }
      });
    }
  }
  if (till) await clean('sign out till', async () => {
    const signedOut = await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
    assert.equal(signedOut.status(), 200);
    const me = await till.request.get('/api/me'); assert.equal(me.status(), 401);
    receipt.cleanup.push({ kind: 'till-session', signedOut: true, me: 401 });
  });
  await clean('sign out admin', async () => {
    const signedOut = await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
    assert.equal(signedOut.status(), 200); assert.equal((await admin.get('/api/me')).status(), 401);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true, me: 401 });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
