// SCRUM-889 / SCRUM-890 / SCRUM-891 staging proof (12 November 2026; api, pos and pos-web all at 6944d5381, deploys.json).
// Started from the SCRUM-876 harness (docs/qa/proof-2026-11-12/SCRUM-876/proof.mjs), which made the same situation.
// Own ZZ TEST till on the shared virtual box (virtual-1), a ZZ TEST party made in the OTO App, an invented walk-in number
// (0898890010; 08988900xx is this proof's range), cash only. Only what this run makes is voided, refunded, cancelled or
// deleted. Credentials are read by NAME through scripts/agent/env.mjs need() and never printed; staff names are blacked out
// on the pictures (text runs) and the account corner, password field and every other party / sale card are masked.
//
//   node proof.mjs [out-dir]          (the out-dir defaults to ./out-run-NN; run 01's receipt.json and pictures sit in this folder)
//
// Run history:
//   01  6944d538  all points  13:34-13:52 Bangkok. Driven step by step through an interactive driver (one browser kept
//                             open, one step at a time, these steps in this order); all six points PASS. Differences from
//                             the brief, kept here: the settle payment screen's Back is disabled (the deposit is a recorded
//                             tender, usePaymentStage canBack), so the modal is left by its X (Close); the reception till
//                             locked on inactivity while the phone and manager steps ran, so it is unlocked before point 5.
//
// 1  SCRUM-889  ZZ TEST party for today (Floresta package, 1,000 deposit marked paid) → Settle party → Confirm, nothing
//               taken → X → Tickets → reload: first screen, no ticket order, the "Party settlement open" card with one
//               "Open the party page" → the party page on the party → Resume settlement → Amount Due is the balance.
// 2  SCRUM-889  contrast: a 1 child + 1 adult walk-in order left at payment → History → Tickets: back on its payment
//               screen, Pay = Amount Due → Cancel voids it.
// 3  SCRUM-890  F&B French fries 175, 50 cash partial → History card and detail "Partly paid", "Balance due" 125, Cash 50,
//               Refund (50 left); the deposit-only settlement still Unpaid with Void unpaid sale offered (not pressed).
// 6  SCRUM-890  the phone till (390 x 844) reads the same part-paid sale the same way (before the refund).
// 4  SCRUM-891  a manager refunds the part-paid order whole: the refund answer and a fresh GET /api/sales/:id both say
//               refunded; End of Day lists nothing part-paid for it.
// 5  clean-up   Cancel settlement on the party page with a ZZ TEST reason (deposit stays the party's) → the party deleted
//               in the OTO App → read back; till retired, every session signed out.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const out = resolve(process.argv[2] ?? resolve(import.meta.dirname, 'out-run-02')); mkdirSync(out, { recursive: true });
const pos = 'https://oto-pos-web-staging.onrender.com';
const LAUNCHER = 'https://oto-launcher-staging.onrender.com';
const APP = 'https://oto-app-staging.onrender.com';
const APP_FLORESTA = '6427e84d-723f-4dbd-be58-8ef89cf7dc99';
const FLORESTA_PACKAGE = '391b269d-159a-4039-89a2-51ac132da747';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
const flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
const zz = i => '08988900' + String(10 + i).padStart(2, '0');
const PARTY = 'ZZ TEST SCRUM-889 party';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const receipt = { tickets: ['SCRUM-889', 'SCRUM-890', 'SCRUM-891'], startedAt: new Date().toISOString(),
  deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  created: [], points: {}, reads: {}, pageErrors: [], requests: [], cleanup: {} };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const point = (key, pass, pictures, seen) => { receipt.points[key] = { pass, pictures, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL'); };
let phase = 'setup';

// ---- the admin api (stations, reads, clean-up) ----
const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  let r = await once(); if (r.status() === 401) { await adminSignIn(); r = await once(); }
  const body = await r.json().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0].replace(ID, ':id'), status: r.status(), ...(r.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: r.status(), body };
};
await adminSignIn();
const branchId = (await call('GET', '/branches')).body.branches.find(b => /Central Floresta/.test(b.name)).id;
const box = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
assert.ok(box, 'simulated box online');
for (let i = 0; i < 6; i++) assert.equal((await call('GET', `/members/lookup?phone=${zz(i)}`)).body?.member ?? null, null, 'ZZ TEST number unused');
const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(r => s.devices.some(d => d.role === r)));
const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
const prefix = Array.from({ length: 99 }, (_, i) => `Z889${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
const fixtureName = `ZZ TEST SCRUM-889 proof till ${Date.now()}`;
const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
assert.equal(made.status, 200); const station = made.body.station;
receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

// ---- browsers ----
const browser = await chromium.launch({ channel: 'msedge' });
const names = new Set();
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const watch = (page, label) => {
  page.on('pageerror', e => receipt.pageErrors.push({ page: label, at: phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(ID, ':id')} ${r.status()}` }); });
};
async function signInAt(phoneKey, passwordKey, viewport, label) {
  const ctx = await browser.newContext({ baseURL: pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); watch(page, label); await page.goto(pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } } else if (await page.locator('a[href="/history"]').first().isVisible()) break; await page.waitForTimeout(500); }
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  const walk = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2) { names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.length >= 3) names.add(p); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walk(v, d + 1); } };
  walk(me);
  assert.ok(JSON.stringify(me).includes(station.id), 'signed in at the own ZZ TEST till');
  return { ctx, page, passwordKey };
}
/** The till locks on inactivity: unlock with the same account's password. */
async function unlock(t) {
  if (await t.page.getByRole('heading', { name: 'Locked', exact: true }).isVisible().catch(() => false)) {
    await t.page.locator('input[type="password"]').first().fill(need(t.passwordKey));
    await t.page.getByRole('button', { name: /Unlock/ }).click(); await t.page.waitForTimeout(3000);
  }
}
/** Staff names blacked out as text runs, then the picture; account corner, password field and `mask` covered. */
async function shot(page, name, mask = [], opts = {}) {
  await page.evaluate((needles) => {
    const list = needles.filter(s => !/^(ZZ|TEST|SCRUM|proof|till|OTO)$/i.test(s)).sort((a, b) => b.length - a.length);
    if (!list.length) return;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const hits = [];
    while (w.nextNode()) if (list.some(s => (w.currentNode.nodeValue || '').toLowerCase().includes(s.toLowerCase()))) hits.push(w.currentNode);
    for (const t of hits) { let h = (t.nodeValue || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); for (const s of list) h = h.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<span style="background:#3f3f46;color:#3f3f46">${'█'.repeat(m.length)}</span>`); const sp = document.createElement('span'); sp.innerHTML = h; t.parentNode.replaceChild(sp, t); }
  }, [...names]);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', ...opts, mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), ...mask], maskColor: '#18181b' });
}
// Other parties on the party page, and every History card that is not this run's, are masked.
const otherParties = page => [page.locator('div.space-y-2 > button.w-full').filter({ hasNotText: 'ZZ TEST' })];
const mine = [];
const markMine = page => page.evaluate((res) => {
  for (const b of document.querySelectorAll('div.space-y-2 > button.w-full.text-left')) { if (res.some(r => new RegExp(r).test(b.innerText))) b.setAttribute('data-zz', 'mine'); else b.removeAttribute('data-zz'); }
}, mine);
const otherSales = page => [page.locator('div.space-y-2 > button.w-full.text-left:not([data-zz])')];
const hhmm = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const amountDue = page => page.evaluate(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.trim() === 'Amount Due'); return h ? (h.nextElementSibling?.textContent ?? '').trim() : null; });
const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const eod = async () => (await call('GET', `/branches/${branchId}/end-of-day?date=${today}`)).body?.openSales ?? {};

const T = await signInAt('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', { width: 1440, height: 900 }, 'till');
const till = T.page;

// ---- the ZZ TEST party, in the OTO App (launcher hand-off) ----
const appCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
const appCall = async (method, path, body) => { const r = await appCtx.request.fetch(APP + '/api' + path, { method, data: body, headers: method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() } }); return { status: r.status(), body: await r.json().catch(() => null) }; };
assert.equal((await appCtx.request.post(LAUNCHER + '/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const hand = await (await appCtx.request.post(LAUNCHER + '/api/auth/handoff', { data: { app: 'oto_app' }, headers: { 'Idempotency-Key': randomUUID() } })).json();
const appPage = await appCtx.newPage(); const exchanged = appPage.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
await appPage.goto(hand.launchUrl); await exchanged; await appPage.waitForURL(u => !u.hash.includes('handoff'), { timeout: 60000 });
const ev = await appCall('POST', '/admin/events', { eventType: 'birthday', title: PARTY, branchId: APP_FLORESTA, eventDate: today, startTime: '15:00', endTime: '18:00', durationMinutes: 180, numChildren: 2, numAdults: 2, status: 'upcoming' });
assert.equal(ev.status, 201); const partyId = ev.body.id; receipt.created.push({ kind: 'oto-app event', id: partyId, title: PARTY }); save();
assert.equal((await appCall('PUT', `/events/${partyId}/beo/billing`, { depositRequired: true, depositAmount: 1000, depositPaid: true, depositPaidAmount: 1000 })).status, 201);
assert.equal((await appCall('POST', `/beo/events/${partyId}/package-snapshot`, { templateId: FLORESTA_PACKAGE })).status, 201);
assert.equal((await call('GET', `/parties/${partyId}?branchId=${branchId}`)).body.event.party.depositSatang, 100000);

// ---- 1: SCRUM-889 ----
phase = '1';
await till.goto('/parties'); await till.getByText(PARTY).first().click(); await till.waitForTimeout(2500);
await shot(till, '01a-889-party-page-before-settle.png', otherParties(till));
await till.getByRole('button', { name: 'Settle party', exact: true }).click(); await till.waitForTimeout(1500);
const socks = till.getByText('Socks given', { exact: true }).locator('xpath=ancestor::div[.//button][1]');
for (let i = 0; i < 2; i++) await socks.getByRole('button').first().click();
const settled = till.waitForResponse(r => /\/api\/parties\/[^/]+\/settle$/.test(new URL(r.url()).pathname));
await till.getByRole('button', { name: /^Confirm/ }).click();
const sb = await (await settled).json(); const saleB = sb.sale.id;
receipt.created.push({ kind: 'party-settlement-sale', id: saleB, settlement: sb.settlement?.id }); save();
await till.getByTestId('payment-step').waitFor(); await till.waitForTimeout(3000);
const settleDue = await amountDue(till);
await shot(till, '01b-889-settle-confirmed-amount-due-is-the-balance.png', otherParties(till));
const backDisabled = await till.getByTestId('payment-step').getByRole('button', { name: 'Back', exact: true }).isDisabled();
await shot(till, '01b2-889-settle-payment-back-is-disabled.png', otherParties(till), { clip: { x: 100, y: 780, width: 520, height: 120 } });
await till.getByRole('button', { name: 'Close', exact: true }).click(); await till.waitForTimeout(2500);
const resumeLabel = flat(await till.getByRole('button', { name: /^Resume settlement/ }).first().innerText());
await shot(till, '01c-889-after-back-party-page-resume-settlement.png', otherParties(till));
await till.getByRole('link', { name: /Tickets/ }).first().click(); await till.waitForTimeout(3000);
await shot(till, '01d-889-tickets-tab-before-reload.png');
await till.reload(); await till.waitForTimeout(6000);
const body1 = flat(await till.locator('body').innerText());
const card = till.getByTestId('left-behind-party-settlement');
const r1 = {
  settle: { saleStatus: sb.sale.status, settlement: sb.settlement?.state, depositSatang: sb.settlement?.depositSatang, outstandingSatang: sb.settlement?.outstandingSatang, amountDue: settleDue, backDisabled, resumeLabel },
  afterReload: { firstScreen: await landing(till).isVisible(), card: await card.isVisible(), cardText: flat(await card.innerText()), openPartyButtons: await till.getByTestId('open-party-page').count(),
    resume: await till.getByRole('button', { name: /Resume this sale/i }).count(), void: await till.getByRole('button', { name: /Void that unpaid sale/i }).count(),
    resumedNotice: /Resumed after a reload/i.test(body1), steppers: await till.getByRole('button', { name: /Add one Kids/ }).count(), paymentStep: await till.getByTestId('payment-step').isVisible(),
    pay: flat(await till.getByRole('button', { name: /^Pay ฿/ }).first().innerText()) },
};
await shot(till, '01e-889-tickets-tab-after-reload-party-settlement-card.png');
await till.getByTestId('open-party-page').click(); await till.waitForTimeout(3500);
r1.openParty = { url: new URL(till.url()).pathname + new URL(till.url()).search, onParty: await till.getByRole('heading', { name: PARTY }).first().isVisible(), button: flat(await till.getByRole('button', { name: /^Resume settlement/ }).first().innerText()) };
await shot(till, '01f-889-open-the-party-page-lands-on-the-party.png', otherParties(till));
await till.getByRole('button', { name: /^Resume settlement/ }).first().click(); await till.waitForTimeout(3500);
r1.resumed = { amountDue: await amountDue(till), display: flat(await till.locator('body').innerText()).match(/Amount due ฿[\d,]+/g) };
await shot(till, '01g-889-resume-settlement-amount-due-is-the-balance.png', otherParties(till));
receipt.reads.point1 = r1;
point('1', r1.settle.amountDue === '฿15900' && r1.afterReload.firstScreen && r1.afterReload.card && r1.afterReload.openPartyButtons === 1 && !r1.afterReload.resume && !r1.afterReload.void
  && !r1.afterReload.resumedNotice && !r1.afterReload.steppers && !r1.afterReload.paymentStep && r1.afterReload.pay === 'Pay ฿0' && r1.openParty.url === `/parties?party=${partyId}`
  && r1.openParty.button === 'Resume settlement ฿15900' && r1.resumed.amountDue === '฿15900', ['01a', '01b', '01b2', '01c', '01d', '01e', '01f', '01g'], r1);
await till.getByRole('button', { name: 'Close', exact: true }).click(); await till.waitForTimeout(1500);

// ---- 3 (first half): the deposit-only settlement in History ----
phase = '3';
mine.push(`${hhmm(sb.sale.occurredAt ?? new Date().toISOString())}[^]*16,?900`);
await till.goto('/history'); await till.waitForTimeout(5000); await markMine(till);
await shot(till, '03b-876-history-list-settlement-card-unpaid.png', otherSales(till));
await till.locator('button[data-zz]').filter({ hasText: /16,?900/ }).first().click(); await till.waitForTimeout(3500);
const r3s = { label: flat(await till.getByTestId('sale-amount-shown').locator('xpath=preceding-sibling::span[1]').innerText()), amount: flat(await till.getByTestId('sale-amount-shown').innerText()),
  void: flat(await till.getByTestId('void-sale').innerText().catch(() => '')), refund: await till.getByTestId('refund-sale').isVisible().catch(() => false) };
await shot(till, '03c-876-deposit-only-settlement-still-unpaid-void-offered.png', otherSales(till));

// ---- 2: SCRUM-889 contrast — an ordinary ticket order ----
phase = '2';
const halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
await till.goto('/'); await landing(till).waitFor();
if (await till.getByTestId('language-choice').isVisible()) await till.getByTestId('language-choice-en').click();
const scope = halfOf(till.getByTestId('identify-safety'));
for (const d of zz(0)) await scope.getByRole('button', { name: d, exact: true }).last().click();
await scope.getByRole('button', { name: 'Continue', exact: true }).click();
await till.getByRole('dialog', { name: 'New member?', exact: true }).getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
for (const [label, target] of [['Kids', 1], ['Adults', 1]]) {
  const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 8 && Number(await value.textContent()) !== target; i++) { await (Number(await value.textContent()) < target ? add : till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first()).click(); await till.waitForTimeout(200); }
}
const posted = till.waitForResponse(r => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST');
await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
const saleT = (await (await posted).json()).sale.id; receipt.created.push({ kind: 'ticket-sale', id: saleT, number: zz(0) }); save();
await expect(till.getByTestId('payment-step')).toBeVisible({ timeout: 45000 }); await till.waitForTimeout(2000);
await shot(till, '02a-889-ticket-order-at-payment.png');
await till.locator('a[href="/history"]').first().click(); await till.waitForTimeout(3000);
await till.locator('a[href="/"]').first().click(); await till.waitForTimeout(6000);
const r2 = { paymentStep: await till.getByTestId('payment-step').isVisible(), amountDue: await amountDue(till), pay: flat(await till.getByRole('button', { name: /^Pay ฿/ }).first().innerText()),
  resumedNotice: (flat(await till.locator('body').innerText()).match(/Resumed after a reload[^.]*/) ?? [null])[0] };
await shot(till, '02b-889-ticket-order-back-on-its-payment-screen.png');
await till.getByRole('button', { name: /^Pay ฿/ }).first().scrollIntoViewIfNeeded(); await till.waitForTimeout(600);
await shot(till, '02c-889-ticket-order-pay-button-equals-amount-due.png');
const voidedT = till.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${saleT}/void`);
await till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
r2.voidStatus = (await voidedT).status(); await till.waitForTimeout(3000);
r2.sale = (await call('GET', `/sales/${saleT}`)).body.sale.status;
await shot(till, '02e-889-ticket-order-voided-till-back-to-start.png');
receipt.reads.point2 = r2;
point('2', r2.paymentStep && r2.amountDue === '฿1040' && r2.pay === 'Pay ฿1040' && r2.voidStatus === 200 && r2.sale === 'voided', ['02a', '02b', '02c', '02e'], r2);

// ---- 3 (second half): SCRUM-890 — F&B French fries, 50 cash partial ----
phase = '3';
await till.goto('/'); await till.waitForTimeout(2000);
await till.getByRole('button', { name: 'F&B', exact: true }).click();
await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
await till.getByPlaceholder('Search dish…').fill('French Fries');
await till.getByText(/^French Fries$/i).first().click();
const charge = till.getByRole('button', { name: /^Charge ฿/ }); await expect(charge).toBeEnabled({ timeout: 20000 }); await charge.click();
const pickup = till.getByRole('dialog', { name: 'Pick-up Code', exact: true });
await pickup.getByRole('button', { name: '8', exact: true }).click(); await pickup.getByRole('button', { name: '9', exact: true }).click();
await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();
await till.getByRole('button', { name: /^Cash / }).click();
await till.getByRole('button', { name: 'Partial payment', exact: true }).click();
await till.locator('#payment-part-amount').fill('50.00'); await till.locator('#payment-cash-received').fill('50.00'); await till.waitForTimeout(800);
await shot(till, '03a-890-fnb-partial-payment-50-of-175.png');
const finalised = till.waitForResponse(r => /\/api\/sales\/[^/]+\/finalise$/.test(new URL(r.url()).pathname));
await till.getByRole('button', { name: /^Record/ }).first().click();
const fin = await finalised; const saleF = new URL(fin.url()).pathname.split('/')[3];
assert.equal((await fin.json()).outstandingSatang, 12500); receipt.created.push({ kind: 'fnb-part-paid-sale', id: saleF }); save();
await till.waitForTimeout(3000); await shot(till, '03a2-890-fnb-after-partial-recorded.png');
const rowF = (await stationSales()).find(s => s.id === saleF);
const friesTime = hhmm(rowF.occurredAt); mine.push(`${friesTime}[^]*175`);
await till.goto('/history'); await till.waitForTimeout(5000); await markMine(till);
const cardF = till.locator('button[data-zz]').filter({ hasText: new RegExp(friesTime) }).filter({ hasText: /175/ }).first();
const r3 = { settlement: r3s, apiRow: { partPaid: rowF.partPaid ?? null }, cardBadge: flat(await cardF.getByText(/^(Partly paid|Unpaid)$/).first().innerText()) };
await cardF.scrollIntoViewIfNeeded(); await shot(till, '03d-890-history-list-card-partly-paid.png', otherSales(till));
await cardF.click(); await till.waitForTimeout(3500);
Object.assign(r3, { label: flat(await till.getByTestId('sale-amount-shown').locator('xpath=preceding-sibling::span[1]').innerText()), amount: flat(await till.getByTestId('sale-amount-shown').innerText()),
  refund: flat(await till.getByTestId('refund-sale').innerText()), void: await till.getByTestId('void-sale').isVisible().catch(() => false), cash: (flat(await till.locator('body').innerText()).match(/Cash · Approved[^฿]*฿50/) ?? [null])[0] });
await shot(till, '03e-890-history-detail-partly-paid-balance-due-125.png', otherSales(till));
receipt.reads.point3 = r3;
point('3', r3.cardBadge === 'Partly paid' && r3.label === 'Balance due' && r3.amount === '฿125' && r3.refund === 'Refund (฿50 left)' && !r3.void && Boolean(r3.cash)
  && r3s.label === 'Amount due' && r3s.amount === '฿16900' && r3s.void === 'Void unpaid sale' && !r3s.refund, ['03a', '03a2', '03b', '03c', '03d', '03e'], r3);

// ---- look: the Tickets tab while the part-paid F&B order is open at this till ----
await till.goto('/'); await till.waitForTimeout(7000);
receipt.reads.ticketsTabWithFnbOpen = { toast: (flat(await till.locator('body').innerText()).match(/That sale is not a ticket sale[^.]*/) ?? [null])[0] };
await shot(till, '07a-look-tickets-tab-with-part-paid-fnb-order-open.png');

// ---- 6: SCRUM-890 on the phone till (before the refund) ----
phase = '6';
const P = await signInAt('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', { width: 390, height: 844 }, 'phone');
const phone = P.page;
await phone.goto('/history'); await phone.waitForTimeout(6000); await markMine(phone);
const pCard = phone.locator('button[data-zz]').filter({ hasText: new RegExp(friesTime) }).filter({ hasText: /175/ }).first();
await pCard.scrollIntoViewIfNeeded();
const r6 = { cardBadge: flat(await pCard.getByText(/^(Partly paid|Unpaid)$/).first().innerText()) };
await shot(phone, '06a-890-phone-history-list-partly-paid.png', otherSales(phone));
for (const [c, name] of [[phone.locator('button[data-zz]').filter({ hasText: /16,?900/ }).first(), '06e-890-phone-history-list-settlement-card-unpaid.png'], [pCard, '06f-890-phone-history-list-part-paid-card.png']]) {
  await c.evaluate(e => e.scrollIntoView({ block: 'center' })); await phone.waitForTimeout(500);
  const b = await c.boundingBox(); await shot(phone, name, [], { clip: { x: 0, y: Math.max(0, b.y - 8), width: 390, height: b.height + 16 } });
}
await pCard.click(); await phone.waitForTimeout(3500);
const pb = flat(await phone.locator('body').innerText());
Object.assign(r6, { badge: (pb.match(/Partly paid|Unpaid/) ?? [null])[0], balance: (pb.match(/Balance due ฿[\d,]+/) ?? [null])[0], refund: (pb.match(/Refund \(฿[\d,]+ left\)/) ?? [null])[0], cash: (pb.match(/Cash · Approved[^฿]*฿50/) ?? [null])[0] });
await shot(phone, '06b-890-phone-history-detail-partly-paid-balance-due.png', otherSales(phone));
await phone.getByRole('button', { name: /Refund \(฿/ }).first().scrollIntoViewIfNeeded(); await phone.waitForTimeout(600);
await shot(phone, '06d-890-phone-history-detail-refund-50-left.png', otherSales(phone));
receipt.reads.point6 = r6;
point('6', r6.cardBadge === 'Partly paid' && r6.badge === 'Partly paid' && r6.balance === 'Balance due ฿125' && r6.refund === 'Refund (฿50 left)' && Boolean(r6.cash), ['06a', '06b', '06d', '06e', '06f'], r6);

// ---- 4: SCRUM-891 — a manager refunds the part-paid order whole ----
phase = '4';
const eodBefore = (await eod()).rows?.filter(r => r.saleId === saleF).map(r => ({ kind: r.kind, gross: r.grossSatang, paid: r.paidSatang, balance: r.balanceSatang }));
const M = await signInAt('STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD', { width: 1440, height: 900 }, 'manager');
const mgr = M.page;
await mgr.goto('/history'); await mgr.waitForTimeout(5000); await markMine(mgr);
await mgr.locator('button[data-zz]').filter({ hasText: new RegExp(friesTime) }).filter({ hasText: /175/ }).first().click(); await mgr.waitForTimeout(3500);
assert.ok(flat(await mgr.locator('body').innerText()).includes(fixtureName), 'my sale');
await mgr.getByTestId('refund-sale').click();
const dialog = mgr.getByRole('dialog');
await dialog.getByRole('button', { name: 'Service recovery', exact: true }).click();
await dialog.locator('textarea').first().fill('ZZ TEST SCRUM-891 proof: part-paid order refunded whole');
await shot(mgr, '04a-891-manager-refund-dialog-whole-50.png', otherSales(mgr));
const refunded = mgr.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${saleF}/refunds` && r.request().method() === 'POST');
await dialog.getByRole('button', { name: 'Refund ฿50', exact: true }).click();
const rb = await (await refunded).json(); await mgr.waitForTimeout(3500);
await shot(mgr, '04b-891-after-refund-history-detail.png', otherSales(mgr));
const fresh = await mgr.evaluate(async id => { const b = await (await fetch(`/api/sales/${id}`, { credentials: 'include', cache: 'no-store' })).json(); return { status: b.sale?.status, refundStatus: b.refundStatus ?? null, refundableSatang: b.refundableSatang ?? null }; }, saleF);
const r4 = { answer: { refundStatus: rb.refundStatus, sale: rb.sale?.status, amountSatang: rb.refund?.amountSatang, mode: rb.refund?.mode }, freshRead: fresh, eodBefore, eodAfter: (await eod()).rows?.filter(r => r.saleId === saleF).length };
await mgr.goto('/end-of-day'); await mgr.waitForTimeout(6000);
await shot(mgr, '04c-891-end-of-day-after-refund-nothing-part-paid.png');
receipt.reads.point4 = r4;
point('4', r4.answer.refundStatus === 'refunded' && r4.freshRead.refundStatus === 'refunded' && r4.freshRead.status === 'voided' && r4.freshRead.refundableSatang === 0
  && eodBefore?.[0]?.kind === 'part_paid' && r4.eodAfter === 0, ['04a', '04b', '04c'], r4);

// ---- 5: clean-up through the party page, then the OTO App ----
phase = '5';
await unlock(T);
await till.goto(`/parties?party=${partyId}`); await till.waitForTimeout(4000);
await till.getByRole('button', { name: 'Cancel settlement', exact: true }).click();
await till.locator('#cancel-settlement-reason').fill('ZZ TEST SCRUM-889 proof: clean-up, the parent pays later');
await shot(till, '05a-889-cancel-settlement-with-a-reason.png', otherParties(till));
const voidedB = till.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${saleB}/void`);
await till.getByRole('dialog').getByRole('button', { name: 'Cancel settlement', exact: true }).click();
const r5 = { voidStatus: (await voidedB).status() }; await till.waitForTimeout(3500);
r5.button = flat(await till.getByRole('button', { name: /^(Settle party|Resume settlement)/ }).first().innerText());
await shot(till, '05b-889-party-after-cancel-settle-party-again.png', otherParties(till));
const pAfter = (await call('GET', `/parties/${partyId}?branchId=${branchId}`)).body;
Object.assign(r5, { deposit: pAfter.event.party.depositSatang, settlement: pAfter.event.party.settlement?.state, sale: (await call('GET', `/sales/${saleB}`)).body.sale.status });
await till.goto('/'); await till.waitForTimeout(6000);
r5.cardGone = !(await till.getByTestId('left-behind-party-settlement').isVisible().catch(() => false));
await shot(till, '05c-889-tickets-tab-card-gone-after-cancel.png');
r5.partyDelete = (await appCall('DELETE', `/admin/events/${partyId}`)).status;
r5.partyReadBack = { app: (await appCall('GET', `/admin/events/${partyId}`)).status, till: (await call('GET', `/parties/${partyId}?branchId=${branchId}`)).status };
receipt.reads.point5 = r5;
point('5', r5.voidStatus === 200 && r5.deposit === 100000 && r5.settlement === 'voided' && r5.sale === 'voided' && r5.cardGone && r5.partyDelete === 204 && r5.partyReadBack.app === 404 && r5.partyReadBack.till === 404, ['05a', '05b', '05c'], r5);

// ---- clean-up: own records only, each read back ----
const sales = await stationSales();
receipt.cleanup.sales = sales.map(s => ({ id: s.id, status: s.status, gross: s.totals.grossSatang })); assert.ok(sales.every(s => s.status === 'voided'));
receipt.cleanup.members = {}; for (let i = 0; i < 6; i++) receipt.cleanup.members[zz(i)] = (await call('GET', `/members/lookup?phone=${zz(i)}`)).body?.member?.id ?? null;
for (const [k, page] of [['phone', phone], ['mgr', mgr], ['till', till]]) {
  if ((await page.request.get('/api/me')).status() === 200) await page.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  receipt.cleanup[`${k}Me`] = (await page.request.get('/api/me')).status();
}
assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
const retired = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === station.id);
receipt.cleanup.station = { archived: Boolean(retired.archived), devices: retired.devices.length };
await appCtx.request.post(LAUNCHER + '/api/auth/sign-out', { data: {}, headers: { 'Idempotency-Key': randomUUID() } });
await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } }); receipt.cleanup.adminMe = (await admin.get('/api/me')).status();
await Promise.all([M.ctx.close(), P.ctx.close(), T.ctx.close(), appCtx.close()]); await browser.close(); await admin.dispose();
// Staff names never stay in the receipt.
let text = JSON.stringify(receipt);
for (const n of [...names].filter(s => s.length >= 3 && !/^(ZZ|TEST|SCRUM|proof|till|OTO)$/i.test(s)).sort((a, b) => b.length - a.length)) text = text.split(n).join('[staff]');
const clean = JSON.parse(text); clean.finishedAt = new Date().toISOString(); clean.passed = Object.values(clean.points).every(p => p.pass);
writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(clean, null, 2) + '\n');
console.log('done', JSON.stringify(Object.fromEntries(Object.entries(clean.points).map(([k, v]) => [k, v.pass]))));
