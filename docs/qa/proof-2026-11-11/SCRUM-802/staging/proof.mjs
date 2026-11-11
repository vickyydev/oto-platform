// SCRUM-802/783. Run only after this unit owns the source/proof slot.
// No credentials, pairing code, phone or raw response bodies enter the receipt.
import assert from 'node:assert/strict';
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
let candidate = null;
if (ci.conclusion !== 'success') {
  assert.ok(['in_progress', 'queued', 'pending'].includes(ci.status), 'failed source gate stops proof');
  const source = process.argv[3];
  assert.match(source ?? '', /^[a-f0-9]{40}$/);
  assert.equal(ciFor(source)?.conclusion, 'success', 'candidate must be green');
  // The parallel app-only lane may have landed between the full candidate
  // gate and this till landing. Require byte-identical till/API runtime and
  // build inputs; the landed-SHA gate is still required before Deployed.
  const changed = git(['diff', '--name-only', source, sha]).trim().split('\n').filter(Boolean);
  assert.ok(changed.every(p => p.startsWith('docs/') || p.startsWith('apps/oto-app/')), 'candidate till/API runtime and build inputs must be identical');
  candidate = { sha: source, run: ciFor(source).databaseId, unrelatedAppChanges: changed.filter(p => p.startsWith('apps/oto-app/')) };
}
const out = import.meta.dirname;
const pos = 'https://oto-pos-web-staging.onrender.com';
const receipt = { tickets: ['SCRUM-802', 'SCRUM-783'], sha, ci, candidate, startedAt: new Date().toISOString(), phase: 'preflight', requests: [], created: [], checks: {}, cleanup: [] };
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
    else assert.equal(git(['diff', '--name-only', sha, d.commit.id, '--', 'apps/api/src', 'packages']).trim(), '', 'the live API runtime matches the checked source');
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
const testNumbers = ['0898020011', '0898020012', '0898020013']; // ZZ TEST only.
const formatted = index => `+66 89 802 001${index + 1}`;
const fixtureName = `ZZ TEST SCRUM-802 phone ${Date.now()}`;
let failed = false;
const shot = async (page, name) => {
  for (const close of await page.locator('[toast-close]').all()) await close.click();
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
      page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/)] });
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
  if (index === 0) await shot(till, 's783-new-member-offer.png');
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
};
const quantity = async (label, target) => {
  const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
  const remove = till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let count = 0; count < 8; count++) {
    const current = Number(await value.textContent());
    if (current === target) return;
    await (current < target ? add : remove).click();
  }
  assert.equal(Number(await value.textContent()), target);
};
const order = async (adults = 1) => {
  await till.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
  await quantity('Kids', 1); await quantity('Adults', adults);
  await till.getByRole('button', { name: 'Continue', exact: true }).click();
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
  const prefix = Array.from({ length: 99 }, (_, i) => `Z802${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  for (const phone of testNumbers) assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null, 'ZZ TEST number must be unused');
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  assert.equal(station.name, fixtureName);
  receipt.created.push({ kind: 'station', id: station.id }); save();
  browser = await chromium.launch({ channel: 'msedge' });
  tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['clipboard-read', 'clipboard-write'] });
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

  phase('leading zero in member offer and paid admission');
  await identify(0);
  receipt.checks.memberOffer = { formatted: true };
  phase('paid admission');
  await till.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await order();
  await till.getByRole('heading', { name: 'Cash', exact: true }).click();
  await till.getByRole('button', { name: 'Confirm Payment Received', exact: true }).click();
  let admission;
  await expect.poll(async () => {
    admission = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales.find(s => s.status === 'finalised');
    return Boolean(admission);
  }, { timeout: 30000 }).toBe(true);
  receipt.created.push({ kind: 'paid-sale', id: admission.id }); save();
  const original = (await call('GET', `/sales/${admission.id}`)).body;
  const band = original.bands.find(b => b.kind === 'kid') ?? original.bands[0];
  assert.ok(band?.shortCode);

  phase('paste in History');
  await till.locator('a[href="/history"]').click();
  await till.getByRole('button', { name: 'Scan bracelet', exact: true }).click();
  await till.getByLabel('Bracelet code', { exact: true }).click();
  await till.evaluate(code => navigator.clipboard.writeText(code), band.shortCode);
  await till.keyboard.press('ControlOrMeta+V');
  await expect(till.getByLabel('Bracelet code', { exact: true })).toHaveCount(0);
  await expect(till.getByText(admission.receiptNumber, { exact: true })).toBeVisible();
  receipt.checks.paste = { saleId: admission.id, bandId: band.id, findNotPressed: true }; save();
  await shot(till, 's802-paste-opens-history.png');
  await till.getByText(admission.receiptNumber, { exact: true }).click();
  await till.getByRole('button', { name: 'Add time', exact: true }).click();
  const extension = till.getByRole('dialog', { name: 'Add time', exact: true });
  await extension.getByRole('button', { name: /^\+1 hour/ }).click();
  const [chargeResponse] = await Promise.all([
    till.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${admission.id}/extensions` && r.request().method() === 'POST'),
    extension.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  assert.equal(chargeResponse.status(), 200);
  const chargeId = (await chargeResponse.json()).sale.id;
  receipt.created.push({ kind: 'time-charge', id: chargeId }); save();
  await extension.getByRole('button', { name: 'Cash', exact: true }).click();
  phase('pay Add time and see the new receipt without leaving History');
  let navigations = 0;
  const navigated = frame => { if (frame === till.mainFrame()) navigations++; };
  till.on('framenavigated', navigated);
  const [refreshedResponse] = await Promise.all([
    till.waitForResponse(r => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'GET'),
    extension.getByRole('button', { name: 'Record cash', exact: true }).click(),
  ]);
  await expect(extension).toHaveCount(0);
  await expect(till.getByText(/Added \+1 hour to/)).toBeVisible();
  assert.equal(refreshedResponse.status(), 200);
  assert.ok((await refreshedResponse.json()).sales.some(s => s.id === chargeId && s.status === 'finalised'), 'the paid charge is in the automatic list reread');
  const charge = (await call('GET', `/sales/${chargeId}`)).body.sale;
  assert.equal(charge.status, 'finalised');
  await shot(till, 's802-time-paid.png');
  await till.getByRole('button', { name: 'Back to history', exact: true }).click();
  await till.getByRole('button', { name: 'Back to all transactions', exact: true }).click();
  await till.getByPlaceholder(/^Search by name, receipt number/).fill(prefix);
  await expect(till.getByText(charge.receiptNumber, { exact: true })).toBeVisible();
  assert.equal(navigations, 0); till.off('framenavigated', navigated);
  receipt.checks.refresh = { chargeSaleId: chargeId, status: charge.status, automaticListRead: 200, receiptVisibleWithoutNavigation: true }; save();
  await shot(till, 's802-new-receipt-in-history.png');

  phase('leading zero on customer details');
  await till.locator('a[href="/"]').first().click();
  const newSale = till.getByRole('button', { name: 'New sale', exact: true });
  if (await newSale.isVisible()) await newSale.click();
  await identify(1);
  phase('confirm Thai rate for customer details');
  await till.getByRole('heading', { name: 'Thai', exact: true }).click();
  const verification = till.getByRole('dialog');
  await verification.getByRole('button', { name: 'Confirm Thai rate', exact: true }).click();
  phase('show customer details');
  await order();
  await expect(display.getByTestId('input-kept-phone')).toContainText(formatted(1));
  await display.getByTestId('input-kept-phone').scrollIntoViewIfNeeded();
  await shot(display, 's783-customer-details.png');
  const staffDetails = till.getByRole('heading', { name: 'Customer Details', exact: true }).locator('..').locator('..');
  await expect(staffDetails.getByText(formatted(1), { exact: true })).toBeVisible();
  await shot(till, 's783-staff-customer-details.png');
  receipt.checks.customerDetails = { formatted: true, paymentNotTaken: true }; save();
  receipt.checks.staffCustomerDetails = { formatted: true }; save();
  await till.getByRole('button', { name: 'Cancel', exact: true }).click();

  phase('leading zero on agreements');
  await identify(2);
  await till.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await order(0);
  const consent = display.getByTestId('display-consent');
  await consent.getByPlaceholder('Full name', { exact: true }).fill('ZZ TEST SCRUM-783 child');
  const keyboardDone = display.getByRole('button', { name: 'Done', exact: true });
  if (await keyboardDone.isVisible()) await keyboardDone.click();
  await consent.getByRole('button', { name: /Tap to set age/ }).click();
  const age = display.getByRole('dialog');
  await age.getByRole('button', { name: '6', exact: true }).click();
  await age.getByRole('button', { name: 'Jan', exact: true }).click();
  await age.getByRole('button', { name: '5', exact: true }).click();
  await age.getByRole('button', { name: /Confirm/ }).click();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByTestId('consent-care').waitFor();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(consent.getByTestId('consent-kept-phone')).toContainText(formatted(2));
  await shot(display, 's783-agreements.png');
  receipt.checks.agreements = { formatted: true, noConsentSubmitted: true }; save();
  await till.getByRole('button', { name: 'Back', exact: true }).first().click();
  await till.getByRole('button', { name: 'Cancel', exact: true }).click();
  receipt.deploymentsAfter = await deployments();
  receipt.passed = true;
} catch (error) {
  failed = true; receipt.passed = false; receipt.failure = { phase: receipt.phase, kind: error.name };
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
      let sales = [];
      await clean('read own sales', async () => {
        sales = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
        assert.ok(Array.isArray(sales));
        for (const sale of sales) assert.equal(sale.stationId, station.id);
      });
      for (const sale of sales.filter(s => s.status === 'tendering' || s.status === 'open')) {
        await clean(`void ${sale.id}`, async () => {
          assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: 'ZZ TEST SCRUM-802/783 proof cleanup' })).status, 200);
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
        assert.equal((await call('POST', `/credentials/${displayId}/revoke`, { reason: 'ZZ TEST SCRUM-802/783 proof complete' })).status, 200);
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
          assert.ok(member.nickname.startsWith('ZZ TEST SCRUM-783'), 'only own named test members');
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
