// SCRUM-869 and SCRUM-870 staging proof (12 November 2026; the till page reloaded after 11:14 Bangkok was served
// 63f51a2d, which carries dc5f5513 unchanged plus drop-off fixes; the api at dc5f5513). As run, these steps were sent one
// at a time to an interactive driver on an own ZZ TEST till (cash routing, no QR); this file is the same steps in order.
// Credentials are read by NAME from the repo-root .env and never printed; the pairing code is never pictured.
//
//   node proof.mjs [out-dir]
//
// C  SCRUM-869  a separate display page at 1920 x 1080 paired to the own till; a walk-in (0898760040) identified on it;
//               1 Hour Play; three quick edits in the Current Order (+Kids, +Adults, +Kids, ~350 ms apart). The display's
//               text is read every 100 ms and pictured back to back; a MutationObserver counts every return of the
//               welcome line; another counts the staff column leaving full width.
// D  SCRUM-870  with the order on the display, the till taps Today: the station is released (lease/release 200) and the
//               display shows "Welcome to OTO Park"; Tickets again: the till's first screen (language, then the phone
//               prompt) is on the display. Again from a half-typed phone prompt.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const out = resolve(process.argv[2] ?? import.meta.dirname); mkdirSync(out, { recursive: true });
const tmp = resolve(out, '.seq'); mkdirSync(tmp, { recursive: true });
const pos = 'https://oto-pos-web-staging.onrender.com';
const NUMBER = '0898760040';
const IDLE = 'Please follow the staff screen.';
const receipt = { tickets: ['SCRUM-869', 'SCRUM-870'], startedAt: new Date().toISOString(), created: [], reads: {}, cleanup: {} };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

const admin = await request.newContext({ baseURL: pos });
assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data) => { const r = await admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } }); return { status: r.status(), body: await r.json().catch(() => null) }; };
assert.equal((await call('GET', `/members/lookup?phone=${NUMBER}`)).body.member, null, 'the ZZ TEST number is unused');
const branchId = (await call('GET', '/branches')).body.branches.find(b => /Central Floresta/.test(b.name)).id;
const box = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(r => s.devices.some(d => d.role === r)));
const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
const prefix = Array.from({ length: 99 }, (_, i) => `Z869${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
const fixtureName = `ZZ TEST SCRUM-869 proof till ${Date.now()}`;
const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
assert.equal(made.status, 200); const station = made.body.station; receipt.created.push({ kind: 'station', id: station.id }); save();

const browser = await chromium.launch({ channel: 'msedge' });
const tillCtx = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
tillCtx.setDefaultTimeout(30000);
const till = await tillCtx.newPage(); await till.goto(pos);
await till.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
await till.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
await till.getByRole('button', { name: 'Sign in', exact: true }).click();
const picker = till.getByRole('heading', { name: 'Which station are you on?' });
await picker.waitFor({ timeout: 60000 }).catch(() => {}); if (await picker.isVisible()) await till.getByRole('button', { name: fixtureName }).first().click();
await till.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
const shot = (page, name) => page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [page.getByLabel('Lock screen').locator('..'), page.getByTestId('display-pairing-code')] });

// pair the display
const dispCtx = await browser.newContext({ baseURL: pos, viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
dispCtx.setDefaultTimeout(30000);
const display = await dispCtx.newPage(); await display.goto(`${pos}/display`);
const code = (await display.getByTestId('display-pairing-code').textContent()).trim();
const claimed = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode: code, name: 'ZZ TEST SCRUM-869 display' });
assert.equal(claimed.status, 200); const displayId = claimed.body.device.id; receipt.created.push({ kind: 'display', id: displayId }); save();
await display.getByTestId('language-choice-en').click();
for (const d of NUMBER) await display.getByRole('button', { name: d, exact: true }).last().click();
await display.getByRole('button', { name: 'Continue', exact: true }).click();
const offer = till.getByRole('button', { name: 'Continue as walk-in', exact: true }); const tiers = till.getByRole('heading', { name: 'Tourist', exact: true });
await expect.poll(async () => (await offer.isVisible()) || (await tiers.isVisible()), { timeout: 30000 }).toBe(true);
if (await offer.isVisible()) await offer.click();
await tiers.first().click();
await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().dispatchEvent('click');
await display.getByText('Your Order', { exact: true }).waitFor({ timeout: 20000 });
await shot(display, '01-869-display-shows-the-order-1920x1080.png'); await shot(till, '02-869-staff-till-full-width-with-display.png');

// C: three quick edits, the display read every 100 ms
const frames = [];
till.on('request', req => { if (/\/intents$/.test(new URL(req.url()).pathname) && req.method() === 'POST') { const b = req.postDataJSON(); if (b?.type === 'session.publish_display') frames.push({ t: Date.now(), stage: b.payload?.stage, supported: b.payload?.cart?.supported ?? null }); } });
await display.evaluate((idle) => {
  const w = window; w.__samples = []; w.__idle = 0;
  const read = () => { const t = document.body.innerText; return { idle: t.includes(idle) || /Welcome to OTO Park/.test(t), order: t.includes('Your Order'), total: (t.match(/Total\s*\n?\s*(฿[\d,]+)/) || [])[1] || null }; };
  w.__shown = read().idle; w.__timer = setInterval(() => w.__samples.push({ t: Date.now(), ...read() }), 100);
  new MutationObserver(() => { const now = read().idle; if (now && !w.__shown) w.__idle += 1; w.__shown = now; }).observe(document.body, { subtree: true, childList: true, characterData: true });
}, IDLE);
await till.evaluate(() => { const w = window; w.__split = 0; const col = [...document.querySelectorAll('div')].find(d => d.className === 'w-full h-full min-w-0'); new MutationObserver(() => { if (col.className.includes('w-1/2')) w.__split += 1; }).observe(col, { attributes: true, attributeFilter: ['class'] }); });
let shooting = true; const pics = []; const t0 = Date.now();
const loop = (async () => { let i = 0; while (shooting) { const name = `seq-${String(i++).padStart(2, '0')}.png`; await display.screenshot({ path: resolve(tmp, name) }); pics.push({ name, ms: Date.now() - t0 }); } })();
const order = till.getByRole('heading', { name: 'Current Order' }).locator('../..');
const clicks = [];
for (const label of ['Kids', 'Adults', 'Kids']) { await order.getByRole('button', { name: `Add one ${label}` }).first().click(); clicks.push({ label, ms: Date.now() - t0 }); await till.waitForTimeout(350); }
await till.waitForTimeout(5000); shooting = false; await loop;
const res = await display.evaluate(() => { clearInterval(window.__timer); return { idleFlashes: window.__idle, samples: window.__samples }; });
const split = await till.evaluate(() => window.__split);
const samples = res.samples.map(x => ({ ms: x.t - t0, idle: x.idle, order: x.order, total: x.total }));
receipt.reads.c869 = { clicks, frames: frames.map(f => ({ ms: f.t - t0, stage: f.stage, supported: f.supported })), reads: samples.length, welcomeReads: samples.filter(s => s.idle).length, noOrderReads: samples.filter(s => !s.order).length, idleFlashes: res.idleFlashes, splitFlips: split, totals: [...new Set(samples.map(s => s.total))] }; save();
assert.equal(res.idleFlashes, 0); assert.equal(split, 0); assert.equal(receipt.reads.c869.welcomeReads, 0);
const near = ms => samples.reduce((a, b) => Math.abs(b.ms - ms) < Math.abs(a.ms - ms) ? b : a);
const cells = pics.slice(0, 12).map(p => { const s = near(p.ms); return `<figure><img src="data:image/png;base64,${readFileSync(resolve(tmp, p.name)).toString('base64')}"><figcaption>${p.ms} ms · display total ${s.total} · welcome shown: ${s.idle ? 'YES' : 'no'}</figcaption></figure>`; }).join('');
const sheet = await tillCtx.newPage(); await sheet.setViewportSize({ width: 1600, height: 900 });
await sheet.setContent(`<html><body style="margin:0;font:14px system-ui"><h3 style="margin:8px 12px">SCRUM-869 · paired display (1920×1080) captured back to back during three quick edits on the till: ${clicks.map(c => `+1 ${c.label} at ${c.ms} ms`).join(' · ')}</h3><p style="margin:0 12px 6px">Display read every 100 ms: ${samples.length} reads, ${receipt.reads.c869.welcomeReads} showed the welcome screen, ${receipt.reads.c869.noOrderReads} without "Your Order". Frames published by the till: ${receipt.reads.c869.frames.map(f => f.ms + ' ms ' + f.stage).join(', ')}.</p><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px">${cells}</div><style>figure{margin:0}img{width:100%;border:1px solid #999}figcaption{font-size:12px}</style></body></html>`);
await sheet.screenshot({ path: resolve(out, '03-869-display-sequence-three-quick-edits-never-welcome.png'), fullPage: true }); await sheet.close();
await shot(till, '04-869-staff-till-still-full-width-after-edits.png');

// D: Today gives the station up; Tickets takes it again
const release = () => till.waitForResponse(r => /\/lease\/release$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
let rel = release(); await till.getByRole('button', { name: 'Today', exact: true }).click(); assert.equal((await rel).status(), 200);
await display.getByRole('heading', { name: 'Welcome to OTO Park', exact: true }).waitFor({ timeout: 20000 });
await shot(display, '05-870-display-back-to-welcome-when-till-is-on-today.png'); await shot(till, '06-870-till-on-today-tab.png');
await till.getByRole('button', { name: 'Tickets', exact: true }).click();
await display.getByTestId('language-choice').waitFor({ timeout: 20000 });
await shot(display, '07-870-back-on-tickets-display-shows-the-sale-again.png'); await shot(till, '08-870-till-back-on-tickets.png');
await display.getByTestId('language-choice-en').click();
for (const d of '08987') await display.getByRole('button', { name: d, exact: true }).last().click();
await shot(display, '09-870-display-phone-prompt-half-typed.png');
rel = release(); await till.getByRole('button', { name: 'Today', exact: true }).click(); assert.equal((await rel).status(), 200);
await display.getByRole('heading', { name: 'Welcome to OTO Park', exact: true }).waitFor({ timeout: 20000 });
await shot(display, '10-870-display-welcome-after-today-from-phone-prompt.png');
await till.getByRole('button', { name: 'Tickets', exact: true }).click();
await display.getByTestId('language-choice').waitFor({ timeout: 20000 });
await shot(display, '11-870-back-on-tickets-phone-prompt-starts-fresh.png');

// clean-up
receipt.cleanup.displayRevoke = (await call('POST', `/credentials/${displayId}/revoke`, { reason: 'ZZ TEST SCRUM-869 proof complete' })).status;
await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
receipt.cleanup.unassign = (await call('PATCH', `/stations/${station.id}`, { devices: [] })).status;
receipt.cleanup.archive = (await call('DELETE', `/stations/${station.id}`)).status;
receipt.cleanup.member = (await call('GET', `/members/lookup?phone=${NUMBER}`)).body.member ? 'EXISTS' : null;
await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
await browser.close(); receipt.finishedAt = new Date().toISOString(); save();
console.log('done', JSON.stringify(receipt.reads.c869));
