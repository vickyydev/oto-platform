// SCRUM-877 and SCRUM-876 staging proof (12 November 2026, api at dc5f5513, till at dc5f5513 then 63f51a2d).
// As run, these steps were sent one at a time to an interactive driver (one browser, one own ZZ TEST till); this file is
// the same steps in order, runnable end to end. Credentials are read by NAME from the repo-root .env and never printed.
// Cash only; nothing is paid by QR; Close Day is never pressed (End of Day is only read). Staff names are covered on the
// pictures by a text redaction, the account corner by a mask.
//
//   node proof.mjs [out-dir]          (pictures 01-15 as listed in the report; the out-dir defaults to this folder)
//
// A  SCRUM-877  F&B guest order (French fries ฿175), Charge, Cash → Partial payment ฿50, left open → End of Day lists it
//               part-paid → History offers Refund (฿50 left), no Void → reception is told a manager makes it → a manager
//               at the same till refunds the whole sale (฿50 cash) → the sale is voided → End of Day lists nothing.
// B  SCRUM-876  a ZZ TEST party made in the OTO App (launcher hand-off) with its deposit recorded as paid (฿1,000 typed in
//               the BEO billing, no money moved) and the Floresta birthday package → Settle party → Confirm, nothing taken
//               → End of Day does not list it → History offers Void unpaid sale → the party page's Cancel settlement with
//               a reason → Settle party again, the deposit still ฿1,000 → the party deleted in the OTO App.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const out = resolve(process.argv[2] ?? import.meta.dirname); mkdirSync(out, { recursive: true });
const pos = 'https://oto-pos-web-staging.onrender.com';
const LAUNCHER = 'https://oto-launcher-staging.onrender.com';
const APP = 'https://oto-app-staging.onrender.com';
const APP_FLORESTA = '6427e84d-723f-4dbd-be58-8ef89cf7dc99';
const FLORESTA_PACKAGE = '391b269d-159a-4039-89a2-51ac132da747';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
const flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const receipt = { tickets: ['SCRUM-877', 'SCRUM-876'], startedAt: new Date().toISOString(), created: [], reads: {}, cleanup: {} };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

// ---- the admin api (stations, reads, clean-up) ----
const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  let r = await once(); if (r.status() === 401) { await adminSignIn(); r = await once(); }
  return { status: r.status(), body: await r.json().catch(() => null) };
};
await adminSignIn();
const branchId = ((await call('GET', '/branches')).body.branches).find(b => /Central Floresta/.test(b.name)).id;
const box = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
assert.ok(box, 'simulated box online');
const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(r => s.devices.some(d => d.role === r)));
const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
const prefix = Array.from({ length: 99 }, (_, i) => `Z876${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
const fixtureName = `ZZ TEST SCRUM-876 proof till ${Date.now()}`;
const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
assert.equal(made.status, 200); const station = made.body.station;
receipt.created.push({ kind: 'station', id: station.id, prefix }); save();

// ---- browsers ----
const browser = await chromium.launch({ channel: 'msedge' });
const names = new Set();
async function signInAt(phoneKey, passwordKey) {
  const ctx = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); await page.goto(pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await picker.waitFor({ timeout: 60000 }).catch(() => {});
  if (await picker.isVisible()) await page.getByRole('button', { name: fixtureName }).first().click();
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  const walk = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2) { names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.length >= 3) names.add(p); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walk(v, d + 1); } };
  walk(me);
  return { ctx, page };
}
/** Staff names on the page are blacked out (text runs), then the picture; the account corner is masked as well. */
async function shot(page, name) {
  await page.evaluate((needles) => {
    const list = needles.sort((a, b) => b.length - a.length);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const hits = [];
    while (w.nextNode()) if (list.some(s => (w.currentNode.nodeValue || '').toLowerCase().includes(s.toLowerCase()))) hits.push(w.currentNode);
    for (const t of hits) { let h = (t.nodeValue || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); for (const s of list) h = h.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<span style="background:#3f3f46;color:#3f3f46">${'█'.repeat(m.length)}</span>`); const sp = document.createElement('span'); sp.innerHTML = h; t.parentNode.replaceChild(sp, t); }
  }, [...names]);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]')] });
}
const eodRows = async () => (await call('GET', `/branches/${branchId}/end-of-day?date=${today}`)).body.openSales;
const { ctx: tillCtx, page: till } = await signInAt('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD');

// ---- A: SCRUM-877 ----
await till.goto('/'); await till.getByRole('button', { name: 'F&B', exact: true }).click();
await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
await till.getByPlaceholder('Search dish…').fill('French Fries');
await till.getByText(/^French Fries$/i).first().click();
const charge = till.getByRole('button', { name: /^Charge ฿/ }); await expect(charge).toBeEnabled({ timeout: 20000 }); await charge.click();
const pickup = till.getByRole('dialog', { name: 'Pick-up Code', exact: true });
await pickup.getByRole('button', { name: '7', exact: true }).click(); await pickup.getByRole('button', { name: '6', exact: true }).click();
await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();
await till.getByRole('button', { name: /^Cash / }).click();
await till.getByRole('button', { name: 'Partial payment', exact: true }).click();
await till.locator('#payment-part-amount').fill('50.00'); await till.locator('#payment-cash-received').fill('50.00');
await shot(till, '01-877-fnb-partial-payment-50-of-175.png');
const finalised = till.waitForResponse(r => /\/api\/sales\/[^/]+\/finalise$/.test(new URL(r.url()).pathname));
await till.getByRole('button', { name: /^Record/ }).first().click();
const fin = await finalised; const saleA = new URL(fin.url()).pathname.split('/')[3];
assert.equal((await fin.json()).finalised, false); receipt.created.push({ kind: 'sale-877', id: saleA }); save();
assert.ok((await eodRows()).rows.some(r => r.saleId === saleA && r.kind === 'part_paid'));
await till.goto('/end-of-day'); await till.waitForTimeout(4000); await shot(till, '02-877-end-of-day-lists-it-part-paid.png');
await till.goto('/history'); await till.getByRole('button').filter({ hasText: 'No receipt number' }).filter({ hasText: 'Unpaid' }).first().click();
await expect(till.getByTestId('refund-sale')).toHaveText(/Refund \(฿50 left\)/); await expect(till.getByTestId('void-sale')).toHaveCount(0);
await shot(till, '03-877-history-part-paid-sale-offers-refund-not-void.png');
await till.getByTestId('refund-sale').click();
let dialog = till.getByRole('dialog'); await dialog.getByRole('button', { name: 'Service recovery', exact: true }).click();
await dialog.locator('textarea').first().fill('ZZ TEST SCRUM-877 proof: part-paid order refunded whole');
await shot(till, '04-877-refund-dialog-whole-sale-only-50.png');
const refused = till.waitForResponse(r => r.url().includes(`/api/sales/${saleA}/refunds`));
await dialog.getByRole('button', { name: 'Refund ฿50', exact: true }).click();
assert.equal((await refused).status(), 403); // REFUND_APPROVAL_REQUIRED for reception
await shot(till, '05-877-reception-is-told-a-manager-makes-the-refund.png');
const { ctx: mgrCtx, page: mgr } = await signInAt('STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD');
await mgr.goto('/history'); await mgr.getByRole('button').filter({ hasText: 'No receipt number' }).filter({ hasText: '฿175' }).filter({ hasText: 'Unpaid' }).first().click();
assert.ok(flat(await mgr.locator('body').innerText()).includes(fixtureName), 'my sale');
await mgr.getByTestId('refund-sale').click(); dialog = mgr.getByRole('dialog');
await dialog.getByRole('button', { name: 'Service recovery', exact: true }).click();
await dialog.locator('textarea').first().fill('ZZ TEST SCRUM-877 proof: part-paid order refunded whole');
const refunded = mgr.waitForResponse(r => r.url().includes(`/api/sales/${saleA}/refunds`));
await dialog.getByRole('button', { name: 'Refund ฿50', exact: true }).click();
const rb = await (await refunded).json(); receipt.reads.refund = { amount: rb.refund?.amountSatang, sale: rb.sale?.status, routes: rb.refund?.tenderAllocation?.map(a => a.route) }; save();
assert.equal(rb.sale.status, 'voided'); await mgr.waitForTimeout(3000);
await shot(mgr, '06-877-after-refund-history-shows-it-refunded.png');
assert.ok(!(await eodRows()).rows.some(r => r.saleId === saleA));
await till.goto('/end-of-day'); await till.waitForTimeout(4000); await shot(till, '07-877-end-of-day-after-refund-no-part-paid.png');

// ---- B: SCRUM-876 ----
const appCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
const appCall = async (method, path, body) => { const r = await appCtx.request.fetch(APP + '/api' + path, { method, data: body, headers: method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() } }); return { status: r.status(), body: await r.json().catch(() => null) }; };
assert.equal((await appCtx.request.post(LAUNCHER + '/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const hand = await (await appCtx.request.post(LAUNCHER + '/api/auth/handoff', { data: { app: 'oto_app' }, headers: { 'Idempotency-Key': randomUUID() } })).json();
const appPage = await appCtx.newPage(); const exchanged = appPage.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
await appPage.goto(hand.launchUrl); await exchanged; await appPage.waitForURL(u => !u.hash.includes('handoff'), { timeout: 60000 });
const ev = await appCall('POST', '/admin/events', { eventType: 'birthday', title: 'ZZ TEST SCRUM-876 party', branchId: APP_FLORESTA, eventDate: today, startTime: '14:00', endTime: '17:00', durationMinutes: 180, numChildren: 2, numAdults: 2, status: 'upcoming' });
assert.equal(ev.status, 201); const partyId = ev.body.id; receipt.created.push({ kind: 'oto-app event', id: partyId }); save();
assert.equal((await appCall('PUT', `/events/${partyId}/beo/billing`, { depositRequired: true, depositAmount: 1000, depositPaid: true, depositPaidAmount: 1000 })).status, 201);
assert.equal((await appCall('POST', `/beo/events/${partyId}/package-snapshot`, { templateId: FLORESTA_PACKAGE })).status, 201);
const openParty = async () => { await till.goto('/parties'); await till.getByText('ZZ TEST SCRUM-876 party').first().click(); await till.waitForTimeout(2500); };
await openParty();
await till.getByRole('button', { name: 'Settle party', exact: true }).click();
const socks = till.getByText('Socks given', { exact: true }).locator('xpath=ancestor::div[.//button][1]');
for (let i = 0; i < 2; i++) await socks.getByRole('button').first().click();
const settled = till.waitForResponse(r => /\/api\/parties\/[^/]+\/settle$/.test(new URL(r.url()).pathname));
await till.getByRole('button', { name: /^Confirm/ }).click();
const sb = await (await settled).json(); const saleB = sb.sale.id; receipt.created.push({ kind: 'party-settlement-sale', id: saleB }); save();
assert.deepEqual([sb.sale.status, sb.settlement.state, sb.settlement.depositSatang], ['tendering', 'open', 100000]);
await till.waitForTimeout(2500); await shot(till, '08-876-settlement-opened-only-the-deposit-on-it.png');
assert.ok(!(await eodRows()).rows.some(r => r.saleId === saleB));
await till.goto('/end-of-day'); await till.waitForTimeout(4000); await shot(till, '09-876-end-of-day-does-not-list-the-party-settlement.png');
await till.goto('/history'); await till.getByRole('button').filter({ hasText: 'No receipt number' }).filter({ hasText: /16,?900/ }).first().click();
await expect(till.getByTestId('void-sale')).toBeVisible(); await shot(till, '10-876-history-offers-void-unpaid-sale-deposit-is-the-partys.png');
await till.goto('/'); await till.waitForTimeout(2500); await shot(till, '15-876-note-open-settlement-resumed-on-the-tickets-tab.png');
await openParty(); await shot(till, '11-876-party-page-shows-cancel-settlement.png');
await till.getByRole('button', { name: 'Cancel settlement', exact: true }).click();
await till.locator('#cancel-settlement-reason').fill('ZZ TEST SCRUM-876 proof: parent pays the balance later');
await shot(till, '12-876-cancel-settlement-with-a-reason.png');
const voided = till.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${saleB}/void`);
await till.getByRole('dialog').getByRole('button', { name: 'Cancel settlement', exact: true }).click();
assert.equal((await voided).status(), 200); await till.waitForTimeout(3500);
await shot(till, '13-876-party-after-cancel-settle-party-again-deposit-kept.png');
const p = (await call('GET', `/parties/${partyId}?branchId=${branchId}`)).body;
receipt.reads.partyAfterCancel = { deposit: p.event.party.depositSatang, settlement: p.event.party.settlement?.state, sale: (await call('GET', `/sales/${saleB}`)).body.sale.status }; save();
await till.getByRole('button', { name: 'Settle party', exact: true }).click(); await till.waitForTimeout(3000);
await shot(till, '14-876-settle-again-form-uses-the-same-1000-deposit.png');
await till.getByRole('button', { name: 'Cancel', exact: true }).last().click();

// ---- clean-up: own records only, each read back ----
receipt.cleanup.partyDelete = (await appCall('DELETE', `/admin/events/${partyId}`)).status;
receipt.cleanup.partyRead = { app: (await appCall('GET', `/admin/events/${partyId}`)).status, till: (await call('GET', `/parties/${partyId}?branchId=${branchId}`)).status };
const sales = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
receipt.cleanup.sales = sales.map(s => ({ id: s.id, status: s.status })); assert.ok(sales.every(s => s.status === 'voided'));
for (const page of [mgr, till]) await page.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
await appCtx.request.post(LAUNCHER + '/api/auth/sign-out', { data: {}, headers: { 'Idempotency-Key': randomUUID() } });
await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
await Promise.all([mgrCtx.close(), tillCtx.close(), appCtx.close()]); await browser.close();
receipt.finishedAt = new Date().toISOString(); save();
console.log('done', JSON.stringify(receipt.reads));
