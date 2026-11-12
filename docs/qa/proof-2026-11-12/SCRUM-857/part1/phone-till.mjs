// SCRUM-857 part 1 extra: the drop-off form on the PHONE till (MobileTill, < 768 px), which part 1 left without the
// number confirmation (the builder's owner decision 3). Read-only on purpose: an own ZZ TEST till on the shared virtual
// box, a walk-in, one child aged 6, as far as the family's form — then Back; nothing is registered or sold.
// Also tries a landline as the guardian number on that form, to see what the phone till says BEFORE anything is written.
//
//   node phone-till.mjs <sha> <out-dir>        ZZ_NUMBER=08985701xx (an invented, unused ZZ TEST mobile)
//
// Run history (12 November 2026, at 9383df00b): out-phone-01 (ZZ_NUMBER=0898570160) walked to the first Continue;
// out-phone-02 (0898570161) named the child, age 6, and stopped: "Continue to payment" stays greyed (consent and photo
// missing), and that Continue is the only way the phone till opens the family's form (MobileTill.tsx:1302-1323), so the
// form, its number and the confirmation were never reached (p04, p-failed). Nothing was written in either run (no sale, no
// registration, no member; own till archived; both sessions signed out).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out-phone');
mkdirSync(out, { recursive: true });
const T = '857';
const pos = 'https://oto-pos-web-staging.onrender.com';
const number = process.env.ZZ_NUMBER ?? '0898570160';
const fixtureName = `ZZ TEST SCRUM-${T} phone till ${Date.now()}`;
const receipt = { ticket: `SCRUM-${T} part 1 — phone till extra`, sha, startedAt: new Date().toISOString(), number, steps: [], pageErrors: [], requests: [], cleanup: [], writes: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const firstLine = e => `${e?.name ?? 'Error'}: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`;

const admin = await request.newContext({ baseURL: pos });
const call = async (method, path, data) => {
  const r = await admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  const body = await r.json().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), status: r.status() });
  return { status: r.status(), body };
};
let browser, page, station, branchId;
const shot = async name => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.locator('svg:not(.lucide), canvas')] });
  console.log('picture', name);
};
const step = async (what, picture) => {
  const buttons = (await page.getByRole('button').allInnerTexts()).map(flat).filter(Boolean).slice(0, 40);
  receipt.steps.push({ what, picture: picture ?? null, url: new URL(page.url()).pathname, buttons }); save();
  if (picture) await shot(picture);
  console.log('STEP', what, '|', buttons.join(' / ').slice(0, 300));
};
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await call('GET', '/branches')).body;
  branchId = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name)).id;
  assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(number)}`)).body.member, null, 'ZZ TEST number unused');
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const src = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(role => s.devices.some(d => d.role === role)));
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: src.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.station = { id: station.id, prefix }; save();

  browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ baseURL: pos, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(20000);
  page = await ctx.newPage();
  page.on('pageerror', e => receipt.pageErrors.push({ kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 200) }));
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && u.pathname.startsWith('/api/')) receipt.pageErrors.push({ kind: 'http', text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` }); });
  page.on('request', r => { if (r.method() !== 'GET' && /\/api\/(sales|checkin\/registrations)$/.test(new URL(r.url()).pathname)) receipt.writes.push({ method: r.method(), path: new URL(r.url()).pathname }); });
  await page.goto(pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await picker.waitFor({ timeout: 30000 }).catch(() => {});
  if (await picker.isVisible()) await page.getByRole('button', { name: fixtureName }).first().click();
  await page.waitForTimeout(3000);
  await step('signed in', 'p01-phone-till-start.png');
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
  await page.waitForTimeout(1000);
  await step('ticket picked');
  const kids = page.getByRole('button', { name: 'Add one Kids', exact: true }).first();
  const value = kids.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 4 && Number(await value.textContent()) < 1; i++) { await kids.click(); await page.waitForTimeout(200); }
  const adults = page.getByRole('button', { name: 'Remove one Adults', exact: true }).first();
  const aval = page.getByRole('button', { name: 'Add one Adults', exact: true }).first().locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 4 && Number(await aval.textContent()) > 0; i++) { await adults.click(); await page.waitForTimeout(200); }
  await step('one child, no adult', 'p02-phone-till-one-child.png');
  await page.getByRole('button', { name: 'Continue', exact: true }).last().click();
  await page.waitForTimeout(1500);
  await step('after Continue', 'p03-phone-till-after-continue.png');
  // The supervision step: the child's name and age 6, then Continue to payment opens the family's form (no write yet).
  await page.getByPlaceholder("Child's name").first().fill(`ZZ TEST SCRUM-${T} phone child`);
  await page.getByRole('button', { name: /Tap to set age/ }).first().click();
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '6', exact: true }).click(); await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /^Jan/ }).first().click(); await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: '1', exact: true }).first().click(); await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /Confirm/ }).click();
  await dialog.waitFor({ state: 'hidden' });
  await step('child named, age 6', 'p04-phone-till-gate-age-6.png');
  receipt.gate = { text: flat(await page.locator('main, body').first().innerText()).slice(0, 900), confirmLines: await page.getByTestId('consent-contact-confirm').count() };
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await page.getByPlaceholder('Your full name', { exact: true }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const formText = async () => flat(await page.locator('body').innerText());
  receipt.form = { confirmLines: await page.getByTestId('consent-contact-confirm').count(), telFields: await page.locator('input[type="tel"]').count(),
    confirmWords: /send messages about my child/.test(await formText()), numberShown: await page.locator('input[type="tel"]').first().inputValue().catch(() => null) };
  await page.getByText('Phone number', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
  await step('the family\'s form on the phone till', 'p05-phone-till-family-form-no-confirm-line.png');
  // A landline in the number field, to see what the phone till's form says before anything is written. Not continued.
  await page.locator('input[type="tel"]').first().fill('21234567');
  await page.waitForTimeout(600);
  const text = await formText();
  receipt.formLandline = { confirmLines: await page.getByTestId('consent-contact-confirm').count(), invalidLine: await page.getByTestId('consent-contact-invalid').count(),
    mobileWarning: /mobile number that can receive messages|landline/i.test(text), storedAs: text.match(/Stored as:\s*(\+\d+)/)?.[1] ?? null };
  await step('landline typed on the phone till\'s form (not continued)', 'p06-phone-till-landline-no-warning.png');
  receipt.done = 'stopped at the family form; nothing continued, so nothing was registered or sold';
} catch (error) {
  receipt.failure = firstLine(error);
  console.log('FAILED', receipt.failure);
  if (page) await shot('p-failed.png').catch(() => {});
} finally {
  save();
  if (process.env.KEEP !== '1') {
    try {
      if (page) {
        const me = (await page.request.get('/api/me')).status();
        if (me === 200) await page.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
        receipt.cleanup.push({ kind: 'phone-session', signedOutMe: (await page.request.get('/api/me')).status() });
      }
      if (station) {
        const sales = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales ?? [];
        receipt.cleanup.push({ kind: 'sales-on-phone-till', count: sales.length, statuses: sales.map(s => s.status) });
        for (const s of sales.filter(s => s.status === 'open' || s.status === 'tendering')) {
          const v = await call('POST', `/sales/${s.id}/void`, { reason: `ZZ TEST SCRUM-${T} phone till cleanup` });
          receipt.cleanup.push({ kind: 'void', id: s.id, status: v.status });
        }
        assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
        assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
        const retired = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === station.id);
        receipt.cleanup.push({ kind: 'station', id: station.id, archived: retired.archived, devices: retired.devices.length });
      }
      const m = (await call('GET', `/members/lookup?phone=${encodeURIComponent(number)}`)).body.member;
      receipt.cleanup.push({ kind: 'test-number', member: m ? m.id : null });
      await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
      receipt.cleanup.push({ kind: 'admin-session', me: (await admin.get('/api/me')).status() });
    } catch (error) { receipt.cleanupFailure = firstLine(error); console.log('CLEANUP FAILED', receipt.cleanupFailure); }
  }
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ failure: receipt.failure ?? null, writes: receipt.writes.length, cleanup: receipt.cleanup }));
}
