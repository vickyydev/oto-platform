// Staging proof for five tickets landed together at 3224debf0 (main), plus the api half of SCRUM-859:
//   SCRUM-883 the customer side shows only the credit the platform granted            (points 1-2)
//   SCRUM-865 a corrected order after Pay replaces the first one; also F&B after Charge (points 3-4)
//   SCRUM-866 the shop lets go of a sale it rang up when the order is cleared           (point 5)
//   SCRUM-867 the payment screen keeps the chosen method while a walk-in is saved       (point 6)
//   SCRUM-859 History -> Add time: the tender screen names the line beside the amount   (point 7)
//   SCRUM-868 a rate confirmation older than 30 minutes says so                         (point 8)
// Adapted from the committed SCRUM-858 / SCRUM-859 harnesses beside this folder. Own ZZ TEST till on the
// simulated box, ZZ TEST members, invented numbers (08988300xx), cash only. No credential, pairing code or
// raw response body enters the receipt or the console; credentials are read by name from scripts/agent/env.mjs.
//
//   node proof.mjs <out-dir> [passes]
//   passes: c  a walk-in's Thai rate confirmed by hand; the till's quote naming that claim kept (for point 8)
//           1  new member, Thai by hand, 1 Hour Play 1 kid + 1 adult (free), cash: no credit on either half
//           2  walk-in Tourist, 1 kid + 1 adult, cash: the ฿350 credit on both halves
//           3  member, Thai by hand, 1 kid, Pay, Back, Kids 2, Pay, cash: the first sale voided
//           4  F&B guest: Charge, Back, one more dish, Charge, cash: the first sale voided
//           5  Shop guest: Charge, Back, Clear: the sale voided; no left-behind notice on Tickets
//           6  new walk-in, Expat on a passport, Pay, Cash + a typed figure, 3 s: both still there
//           7  paired display; History -> point 2's sale -> Add time +1 hour -> Card: the display's lines; cash
//           8  the quote of pass c replayed once the claim is over 30 minutes old (waits up to WAIT_868_MIN)
// ZZ_BASE moves the invented numbers (08988300<base>..); each run asserts they are unused first.
//
// As run on 12 November 2026 (api dep-dbqiorgae00c738h8rl0 at 3224debf0, live 03:08 UTC):
//   run-01 (scratch only) `ZZ_BASE=10 node proof.mjs run-01 1,2,3,4,5,6,7`: points 3 and 6 asked for no adult, which
//     opens "Children playing alone"; point 7 waited for the till's own landing although a paired display takes it.
//   run-02 `ZZ_BASE=20 WAIT_868_MIN=30 node proof.mjs .` (receipt-run-02.json): the pictures 01, 02, 04*, 05*, 06* beside
//     this file. The till served 3224debf0 (pos-web 6660dd4d went live 03:17, a minute after this run signed in).
//     Point 3 found the payment step beside the order panel and never pressed Back; point 7's check expected "1 x ฿";
//     point 8 met the till's inactivity lock (423) at 30 minutes.
//   run-03 `ZZ_BASE=30 WAIT_868_MIN=33 node proof.mjs . c,3,7,8` (receipt-run-03.json): the pictures 00, 03*, 07*, 08.
//     The till served 6660dd4d (3224debf0 + visual fixes); the api moved to dc5f5513 at 04:05 UTC, during the wait of
//     point 8 (no change to the tier-claim code between the two).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const out = resolve(process.cwd(), process.argv[2] ?? 'out');
mkdirSync(out, { recursive: true });
const wanted = (process.argv[3] ?? 'c,1,2,3,4,5,6,7,8').split(',');
const T = '865';
const base = Number(process.env.ZZ_BASE ?? 10);
const zz = i => '08988300' + String(base + i).padStart(2, '0');
const numbers = { claim: zz(0), thai: zz(1), tourist: zz(2), corrected: zz(3), expat: zz(4) };
const names = { thai: `ZZ TEST ${T} Thai credit`, corrected: `ZZ TEST ${T} Corrected`, expat: `ZZ TEST ${T} Expat` };
const pos = 'https://oto-pos-web-staging.onrender.com';
const receipt = { tickets: ['SCRUM-883', 'SCRUM-865', 'SCRUM-866', 'SCRUM-867', 'SCRUM-868', 'SCRUM-859'], startedAt: new Date().toISOString(),
  phase: 'preflight', passes: wanted, numbers, points: {}, checks: {}, created: [], odd: [], pageErrors: [], cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = v => { receipt.phase = v; save(); console.log(new Date().toISOString(), v); };
const firstLine = e => `${e?.name ?? 'Error'}: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`;
const flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const baht = t => Number(String(t ?? '').replace(/[^\d.]/g, ''));

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let r = await once(); if (r.status() === 401) { await adminSignIn(); r = await once(); }
  return { status: r.status(), body: await r.json().catch(() => null) };
};
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
let browser = null, till = null, display = null, station = null, branchId = null, failed = false, staffNames = [];
const shared = {};

/** Never in a picture: the signed-in account's corner and name, passwords, the pairing code, QR grids (credit QR
 *  included), band codes. */
const masks = (page, { paid = true } = {}) => [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
  page.getByTestId('display-pairing-code'), ...(paid ? [page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
    page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/),
    page.locator('label:has(input[type="checkbox"])')] : []),
  ...staffNames.map(n => page.getByText(n, { exact: false }))];
const shot = async (page, name, opts = {}) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: masks(page, opts) });
  console.log('picture', name);
  return name;
};
const point = (key, verdict, picture, shows, seen = {}) => { receipt.points[key] = { verdict, picture, shows, seen }; save(); console.log('POINT', key, verdict, '|', shows); if (verdict !== 'PASS') console.log('  seen', JSON.stringify(seen).slice(0, 1800)); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what); };
function watch(page, label) {
  page.on('pageerror', e => receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('console', m => { if (m.type() === 'error') receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'console.error', text: m.text().split('\n')[0].slice(0, 240) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` }); });
}
/** The till's own quote requests that name a tier claim: kept for point 8 (never printed). */
let lastClaimQuote = null;
/** Every sale the till rang up (POST /api/sales) and every void it asked for, in order: ids and statuses only. */
const saleWrites = [];
function watchSaleWrites(page) {
  page.on('response', async r => {
    const path = new URL(r.url()).pathname;
    if (r.request().method() !== 'POST') return;
    if (path === '/api/sales') { const sale = (await r.json().catch(() => null))?.sale ?? null; saleWrites.push({ at: Date.now(), kind: 'commit', status: r.status(), id: sale?.id ?? null, saleStatus: sale?.status ?? null, customerTier: sale?.customerTier ?? null, grossSatang: sale?.totals?.grossSatang ?? null }); }
    else if (/^\/api\/sales\/[^/]+\/void$/.test(path)) saleWrites.push({ at: Date.now(), kind: 'void', status: r.status(), id: path.split('/')[3] });
  });
}
function watchQuotes(page) {
  page.on('request', r => {
    if (r.method() !== 'POST' || new URL(r.url()).pathname !== '/api/sales/quote') return;
    const text = r.postData() ?? '';
    if (/tierClaimActionId"\s*:\s*"/.test(text)) lastClaimQuote = { at: Date.now(), body: text };
  });
}
const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const readSale = async id => (await call('GET', `/sales/${id}`)).body;
const halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digits) => { for (const d of digits) await scope.getByRole('button', { name: d, exact: true }).last().click(); };
const typeStep = () => till.getByRole('heading', { name: 'Select Customer Type', exact: true });
const ticketStep = () => till.getByRole('heading', { name: 'Add to Sale', exact: true });
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
/** Every string field whose key speaks of a reason, two levels down. */
const reasons = v => { const o = {}; const walk = (x, p, d) => { if (!x || typeof x !== 'object' || d > 2) return; for (const [k, y] of Object.entries(x)) { if (/reason/i.test(k) && (typeof y === 'string' || y === null)) o[p + k] = y; else if (y && typeof y === 'object' && !Array.isArray(y)) walk(y, `${p}${k}.`, d + 1); } }; walk(v, '', 0); return o; };

async function signInAtTill(page) {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000; let steady = 0;
  while (Date.now() < deadline) {
    if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } steady = 0; }
    else if (await landing(page).isVisible()) { steady += 1; if (steady >= 6) break; } else steady = 0;
    await page.waitForTimeout(500);
  }
  await page.locator('a[href="/history"]').first().waitFor();
  await landing(page).waitFor({ timeout: 15000 }).catch(async () => { await page.goto('/'); await landing(page).waitFor(); });
}
async function firstScreen(number) {
  await landing(till).waitFor();
  if (await till.getByTestId('language-choice').isVisible()) await till.getByTestId('language-choice-en').click();
  await till.getByTestId('identify-safety').waitFor();
  const scope = halfOf(till.getByTestId('identify-safety'));
  await keypad(scope, number);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  await offer.waitFor();
  await expect(offer).toContainText(spaced(number));
  return offer;
}
async function createMember(number, name) {
  const offer = await firstScreen(number);
  await offer.getByPlaceholder('e.g. Mali').fill(name);
  await offer.getByRole('button', { name: 'Create member', exact: true }).click();
  await offer.waitFor({ state: 'hidden' });
  await typeStep().waitFor();
  receipt.created.push({ kind: 'member', name, number }); save();
}
async function walkIn(number) {
  const offer = await firstScreen(number);
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  await typeStep().waitFor();
}
/** Thai by hand: the two-button box. Returns the buttons it offered. */
async function confirmThai() {
  await till.getByRole('heading', { name: 'Thai', exact: true }).first().click();
  const dialog = till.getByRole('dialog', { name: 'Verify Thai rate' });
  await dialog.getByTestId('tier-confirm-step').waitFor();
  const buttons = (await dialog.getByTestId('tier-confirm-step').getByRole('button').allInnerTexts()).map(flat).filter(Boolean);
  await dialog.getByRole('button', { name: 'Confirm Thai rate', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  await ticketStep().waitFor({ timeout: 20000 });
  return buttons;
}
async function quantity(label, target) {
  const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
  const remove = till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 8; i++) {
    const now = Number(await value.textContent()); if (now === target) return now;
    const button = now < target ? add : remove;
    if (!(await button.isEnabled().catch(() => false))) return now;
    await button.click(); await till.waitForTimeout(250);
  }
  return Number(await value.textContent());
}
async function configure(name, kids, adults) {
  await till.getByRole('heading', { name, exact: true }).first().click();
  await till.getByRole('heading', { name: /^Configure:/ }).waitFor();
  return { kids: await quantity('Kids', kids), adults: await quantity('Adults', adults) };
}
const payButton = () => till.getByRole('button', { name: /^Pay ฿/ });
async function payAmount() { await expect(payButton()).toBeEnabled({ timeout: 20000 }); return flat(await payButton().textContent()); }
/** Pay ฿X, waiting for the sale the press rang up. Customer Details answered when it opens. */
async function pressPay({ nickname = null } = {}) {
  const written = till.waitForResponse(r => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST', { timeout: 45000 }).catch(() => null);
  const shown = await payAmount();
  await payButton().click();
  const details = till.getByRole('heading', { name: 'Customer Details', exact: true });
  const due = till.getByRole('heading', { name: 'Amount Due' });
  await expect.poll(async () => (await details.isVisible()) || (await due.isVisible()), { timeout: 30000 }).toBe(true);
  let detailsStep = false;
  if (await details.isVisible()) {
    detailsStep = true;
    if (nickname) await till.getByPlaceholder('e.g. Mama, John').last().fill(nickname);
    await till.getByTestId('input-done').click();
  }
  await due.waitFor({ timeout: 30000 });
  const response = await written;
  const sale = response ? (await response.json().catch(() => null))?.sale ?? null : null;
  return { shown, detailsStep, status: response?.status() ?? null, sale: sale ? { id: sale.id, status: sale.status, customerTier: sale.customerTier ?? null, grossSatang: sale.totals?.grossSatang ?? null } : null };
}
async function chooseCash() { await till.getByRole('heading', { name: 'Cash', exact: true }).first().click(); await till.waitForTimeout(600); }
async function confirmCash() {
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  for (let i = 0; i < 3 && !(await confirm.isEnabled().catch(() => false)); i++) await chooseCash();
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded(); await confirm.click();
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
}
/** The thank-you: what each half says about credit, once the platform's read has landed. */
async function thankYou({ expectCredit }) {
  await till.getByText(/Receipt Z\d{5}-\d+/).first().waitFor({ timeout: 30000 }).catch(() => {});
  if (expectCredit) await till.getByText('Credit Grants', { exact: true }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await till.waitForTimeout(3000);
  const halves = await till.evaluate(() => [...document.querySelectorAll('div')].filter(d => d.classList.contains('w-1/2')).map(d => d.innerText.replace(/\s+/g, ' ').trim()));
  const staff = halves.find(t => /Payment Successful/.test(t)) ?? '';
  const customer = halves.find(t => t !== staff) ?? '';
  return { halves: halves.length, staffCreditBlock: /Credit Grants to Print/.test(staff), customerCreditBlock: /Credit Grants/.test(customer),
    staff350: /฿350/.test(staff), customer350: /฿350/.test(customer), receiptLine: staff.match(/Receipt Z\d{5}-\d+[^•]*• ฿[\d,.]+ • Cash/)?.[0] ?? null,
    customerSays: customer.slice(0, 400) };
}
async function startNewSale() {
  const next = till.getByRole('button', { name: 'Start New Sale' });
  if (await next.isVisible().catch(() => false)) await next.click(); else await till.goto('/');
  await landing(till).waitFor();
}
const facts = read => ({ id: read.sale?.id, status: read.sale?.status, receipt: read.sale?.receiptNumber ?? null, customerTier: read.sale?.customerTier ?? null,
  grossSatang: read.sale?.totals?.grossSatang ?? null, reasons: reasons(read.sale ?? {}),
  lines: (read.lines ?? read.sale?.lines ?? []).map(l => ({ kind: l.kind ?? null, label: l.label ?? l.name ?? null, quantity: l.quantity ?? null, unitSatang: l.unitSatang ?? l.unitPriceSatang ?? null })),
  grants: (read.grants ?? []).map(g => ({ creditSatang: g.creditSatang ?? g.amountSatang ?? null })) });

// ---- c: a claim for point 8. ----
async function passClaim() {
  phase('c: walk-in, Thai by hand, 1 Hour Play 1 kid + 1 adult; the quote naming the claim kept; the sale left before Pay');
  await till.goto('/'); await landing(till).waitFor();
  await walkIn(numbers.claim);
  const approval = till.waitForResponse(r => new URL(r.url()).pathname === '/api/sales/tier-approvals' && r.request().method() === 'POST', { timeout: 30000 });
  await confirmThai();
  const a = await approval;
  shared.claimAt = Date.now(); shared.claimStatus = a.status();
  await configure('1 Hour Play', 1, 1);
  await expect.poll(() => Boolean(lastClaimQuote && lastClaimQuote.at >= shared.claimAt), { timeout: 20000 }).toBe(true);
  await till.waitForTimeout(1500);
  shared.claimQuote = lastClaimQuote.body;
  shared.claimPay = await payAmount();
  receipt.checks.claim = { approvalStatus: a.status(), confirmedAt: new Date(shared.claimAt).toISOString(), payShownFresh: shared.claimPay }; save();
  await shot(till, '00-claim-thai-confirmed-by-hand.png');
  await till.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  await till.waitForTimeout(1500);
  await till.goto('/'); await landing(till).waitFor();
}

// ---- 1: SCRUM-883, the free Thai adult. ----
async function passThaiCredit() {
  phase('1: new member, Thai by hand, 1 Hour Play 1 + 1, cash');
  await till.goto('/'); await landing(till).waitFor();
  await createMember(numbers.thai, names.thai);
  const buttons = await confirmThai();
  const q = await configure('1 Hour Play', 1, 1);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click().catch(() => {});
  const paid = await pressPay();
  await chooseCash();
  await confirmCash();
  const seen = await thankYou({ expectCredit: false });
  await shot(till, '01-scrum883-thai-free-adult-thank-you-both-halves.png');
  const read = facts(await readSale(paid.sale.id));
  shared.thaiSale = read;
  const ok = buttons.join('|') === 'Cancel|Confirm Thai rate' && q.kids === 1 && q.adults === 1 && read.status === 'finalised' && read.customerTier === 'thai'
    && read.grants.length === 0 && !seen.staffCreditBlock && !seen.customerCreditBlock && !seen.customer350 && seen.halves === 2;
  point('1', ok ? 'PASS' : 'FAIL', '01-scrum883-thai-free-adult-thank-you-both-halves.png',
    'Thai member (two-button box), 1 kid + 1 adult paid in cash: neither half shows a Credit Grants block or ฿350; the sale reads back grants []',
    { buttons, quantities: q, pay: paid.shown, thankYou: seen, sale: read });
  await startNewSale();
}

// ---- 2: SCRUM-883, the paying Tourist adult. ----
async function passTouristCredit() {
  phase('2: walk-in Tourist, 1 Hour Play 1 + 1, cash');
  await till.goto('/'); await landing(till).waitFor();
  await walkIn(numbers.tourist);
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  const q = await configure('1 Hour Play', 1, 1);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click().catch(() => {});
  const paid = await pressPay();
  await chooseCash();
  await confirmCash();
  const seen = await thankYou({ expectCredit: true });
  await shot(till, '02-scrum883-tourist-paying-adult-credit-both-halves.png');
  const read = facts(await readSale(paid.sale.id));
  shared.touristSale = read;
  const ok = q.kids === 1 && q.adults === 1 && read.status === 'finalised' && read.grants.length === 1 && read.grants[0].creditSatang === 35000
    && seen.staffCreditBlock && seen.customerCreditBlock && seen.staff350 && seen.customer350;
  point('2', ok ? 'PASS' : 'FAIL', '02-scrum883-tourist-paying-adult-credit-both-halves.png',
    'Walk-in Tourist, 1 kid + 1 adult paid in cash: "Credit Grants to Print" on the staff half and "Credit Grants" on the customer half, both ฿350 (credit QR masked); the sale reads back one grant of ฿350',
    { quantities: q, pay: paid.shown, thankYou: seen, sale: read });
  await startNewSale();
}

// ---- 3: SCRUM-865, the corrected ticket order. ----
async function passCorrected() {
  phase('3: member, Thai by hand, 1 Hour Play 1 kid + 1 adult (free), Pay');
  await till.goto('/'); await landing(till).waitFor();
  await createMember(numbers.corrected, names.corrected);
  await confirmThai();
  const q1 = await configure('1 Hour Play', 1, 1);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click().catch(() => {});
  const first = await pressPay();
  receipt.created.push({ kind: 'sale', id: first.sale?.id, note: 'first sale of point 3' }); save();
  await till.waitForTimeout(1200);
  await shot(till, '03a-scrum865-first-pay-one-kid.png');
  phase('3: Back from the payment screen (and from Customer Details if it opens), Kids 1 -> 2');
  const backs = [];
  const mark = saleWrites.length;
  await till.getByTestId('payment-step').getByRole('button', { name: 'Back', exact: true }).click();
  await till.waitForTimeout(1500);
  backs.push({ after: 'payment Back', paymentStep: await till.getByTestId('payment-step').isVisible().catch(() => false), headings: flat((await till.locator('h1,h2').allInnerTexts()).join(' | ')).slice(0, 200) });
  if (await till.getByRole('heading', { name: 'Customer Details', exact: true }).isVisible().catch(() => false)) {
    await till.getByRole('button', { name: 'Back', exact: true }).first().click(); await till.waitForTimeout(1200);
    backs.push({ after: 'Customer Details Back', headings: flat((await till.locator('h1,h2').allInnerTexts()).join(' | ')).slice(0, 200) });
  }
  await shot(till, '03b0-scrum865-after-back.png');
  if (!(await till.getByRole('button', { name: 'Add one Kids', exact: true }).first().isVisible().catch(() => false))) {
    const cfg = till.getByRole('heading', { name: '1 Hour Play', exact: true }).first();
    if (await cfg.isVisible().catch(() => false)) { await cfg.click(); await till.getByRole('heading', { name: /^Configure:/ }).waitFor(); }
  }
  const kids = await quantity('Kids', 2);
  await expect.poll(() => payAmount(), { timeout: 20000 }).not.toBe(first.shown);
  const correctedShown = await payAmount();
  await till.waitForTimeout(800);
  await shot(till, '03b-scrum865-order-changed-to-two-kids.png');
  phase('3: Pay again');
  const writesBeforePay = saleWrites.slice(mark).map(w => ({ ...w, at: undefined }));
  const second = await pressPay();
  await expect.poll(() => saleWrites.slice(mark).some(w => w.kind === 'commit' && w.id && w.id !== first.sale?.id), { timeout: 30000 }).toBe(true).catch(() => {});
  await till.waitForTimeout(1500);
  const writes = saleWrites.slice(mark).map(w => ({ kind: w.kind, status: w.status, id: w.id, saleStatus: w.saleStatus, customerTier: w.customerTier, grossSatang: w.grossSatang }));
  const v = writes.find(w => w.kind === 'void' && w.id === first.sale?.id) ?? null;
  const secondCommit = writes.filter(w => w.kind === 'commit' && w.id && w.id !== first.sale?.id).at(-1) ?? null;
  second.sale ??= secondCommit ? { id: secondCommit.id, status: secondCommit.saleStatus, customerTier: secondCommit.customerTier, grossSatang: secondCommit.grossSatang } : null;
  second.status ??= secondCommit?.status ?? null;
  receipt.created.push({ kind: 'sale', id: second.sale?.id, note: 'corrected sale of point 3' }); save();
  const text = flat(await till.locator('body').innerText());
  const refusal = /already been used|discounted rate has gone|confirm it again|could not be saved/i.test(text);
  await shot(till, '03c-scrum865-corrected-pay-two-kids-thai.png');
  await chooseCash();
  await confirmCash();
  await thankYou({ expectCredit: false });
  await shot(till, '03d-scrum865-corrected-sale-paid-cash.png');
  const firstRead = facts(await readSale(first.sale.id));
  const secondRead = facts(await readSale(second.sale.id));
  shared.corrected = { firstRead, secondRead };
  await startNewSale();
  phase('3: History, this member');
  await till.locator('a[href="/history"]').first().click();
  const search = till.getByPlaceholder(/^Search by name, receipt number/);
  await search.waitFor({ timeout: 20000 });
  await search.fill(names.corrected);
  await till.waitForTimeout(3500);
  const listText = flat(await till.locator('main').first().innerText().catch(async () => till.locator('body').innerText()));
  const unpaidInList = (listText.match(/\bUnpaid\b/g) ?? []).length;
  const receiptShown = secondRead.receipt ? listText.includes(secondRead.receipt) : false;
  await shot(till, '03e-scrum865-history-no-unpaid-row.png', { paid: false });
  const ok = first.sale?.customerTier === 'thai' && q1.kids === 1 && kids === 2 && v?.status === 200 && second.status === 200 && !refusal
    && secondRead.customerTier === 'thai' && secondRead.grossSatang === 2 * (first.sale?.grossSatang ?? -1) && baht(correctedShown) * 100 === secondRead.grossSatang
    && firstRead.status === 'voided' && Object.values(firstRead.reasons).includes('Order changed at the till after Pay')
    && secondRead.status === 'finalised' && unpaidInList === 0 && receiptShown;
  point('3', ok ? 'PASS' : 'FAIL', '03c-scrum865-corrected-pay-two-kids-thai.png',
    'Thai member: Pay with one kid + the free adult (03a), Back (03b0), Kids 2 (03b), Pay again: no refusal, the Thai price for two (03c), paid cash (03d); the first sale reads back voided "Order changed at the till after Pay"; History lists the receipt and no Unpaid row (03e)',
    { quantities: { first: q1, kids }, backs, writesBeforePay, writes, firstPay: first, voidStatus: v?.status ?? null, secondPay: second, correctedShown, refusalOnScreen: refusal, firstRead, secondRead, history: { unpaidInList, receiptShown } });
  await till.goto('/'); await landing(till).waitFor();
}

// ---- 4: SCRUM-865 on F&B. ----
async function addDish() {
  const search = till.getByPlaceholder('Search dish…'); await search.scrollIntoViewIfNeeded(); await search.fill('Smashed avocado');
  const item = till.getByText('Smashed avocado + bruschetta', { exact: true }).first(); await item.scrollIntoViewIfNeeded(); await item.click();
  const d = till.getByRole('dialog');
  const egg = d.getByRole('button', { name: /Egg your way/ });
  if (await egg.isVisible().catch(() => false)) await egg.click();
  await d.getByRole('button', { name: /^Add to order/ }).click();
  await d.waitFor({ state: 'hidden' }).catch(() => {});
  await till.waitForTimeout(600);
}
async function fnbCharge() {
  const charge = till.getByRole('button', { name: /^Charge ฿/ });
  await expect(charge).toBeEnabled({ timeout: 20000 });
  const total = baht(await charge.textContent());
  await charge.click();
  const pickup = till.getByRole('dialog', { name: 'Pick-up Code', exact: true });
  if (await pickup.waitFor({ timeout: 6000 }).then(() => true).catch(() => false)) {
    const go = pickup.getByRole('button', { name: /^Continue to Payment/ });
    if (!(await go.isEnabled().catch(() => false))) { await pickup.getByRole('button', { name: '8', exact: true }).click(); await pickup.getByRole('button', { name: '6', exact: true }).click(); }
    await go.click();
  }
  await till.getByRole('button', { name: /^Cash / }).waitFor({ timeout: 30000 });
  return total;
}
async function waitTendering(not = new Set()) {
  let sale = null;
  await expect.poll(async () => { sale = (await stationSales()).find(s => ['tendering', 'open'].includes(s.status) && !not.has(s.id)) ?? null; return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  return sale;
}
async function passFnb() {
  phase('4: F&B guest, one dish, Charge');
  await till.goto('/'); await landing(till).waitFor();
  await till.getByRole('button', { name: 'F&B', exact: true }).click();
  await till.getByRole('heading', { name: 'Scan Wristband', exact: true }).waitFor();
  await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  await addDish();
  const total1 = await fnbCharge();
  const first = await waitTendering();
  receipt.created.push({ kind: 'sale', id: first.id, note: 'first F&B sale of point 4' }); save();
  await shot(till, '04a-scrum865-fnb-first-charge.png');
  phase('4: Back, one more dish, Charge, cash');
  await till.getByRole('button', { name: 'Back', exact: true }).first().click();
  await till.waitForTimeout(1200);
  await addDish();
  const total2 = await fnbCharge();
  await till.waitForTimeout(1500);
  const text = flat(await till.locator('body').innerText());
  const refusal = /already been used|could not be saved|refused/i.test(text);
  await shot(till, '04b-scrum865-fnb-second-charge.png');
  await till.getByRole('button', { name: /^Cash / }).click();
  await till.getByLabel('Cash received', { exact: true }).fill(total2.toFixed(2));
  await till.getByRole('button', { name: 'Record cash', exact: true }).click();
  await till.getByRole('heading', { name: 'Order Confirmed', exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(1500);
  await shot(till, '04c-scrum865-fnb-paid-cash.png');
  const sales = await stationSales();
  const firstRead = facts(await readSale(first.id));
  const second = sales.find(s => s.id !== first.id && s.status === 'finalised' && s.totals?.grossSatang === total2 * 100 && !receipt.created.some(c => c.id === s.id));
  const secondRead = second ? facts(await readSale(second.id)) : null;
  if (second) receipt.created.push({ kind: 'sale', id: second.id, note: 'second F&B sale of point 4' });
  const ok = firstRead.status === 'voided' && Object.values(firstRead.reasons).includes('Order changed at the till after Pay') && secondRead?.status === 'finalised' && !refusal && total2 > total1;
  point('4', ok ? 'PASS' : 'FAIL', '04c-scrum865-fnb-paid-cash.png',
    'F&B guest: Charge (04a), Back, one more dish, Charge (04b), cash: the first sale reads back voided, the second finalised',
    { total1, total2, refusalOnScreen: refusal, firstRead, secondRead });
  await till.getByRole('button', { name: 'New Order', exact: true }).click().catch(() => {});
}

// ---- 5: SCRUM-866, the shop. ----
async function passShop() {
  phase('5: Shop guest, one item, Charge');
  await till.goto('/'); await landing(till).waitFor();
  await till.getByRole('button', { name: 'Shop', exact: true }).click();
  await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  const e = till.getByText('Helium Balloon (65)', { exact: true }).first(); await e.scrollIntoViewIfNeeded(); await e.click(); await till.waitForTimeout(800);
  const known = new Set((await stationSales()).map(s => s.id));
  const charge = till.getByRole('button', { name: /^Charge ฿/ });
  await charge.scrollIntoViewIfNeeded(); await charge.click();
  await till.getByRole('button', { name: /^Cash / }).waitFor({ timeout: 30000 });
  let sale = await waitTendering(known).catch(() => null);
  let chargeWrote = Boolean(sale);
  if (!sale) { await till.getByRole('button', { name: /^Cash / }).click(); sale = await waitTendering(known); }
  receipt.created.push({ kind: 'sale', id: sale.id, note: 'shop sale of point 5' }); save();
  await shot(till, '05a-scrum866-shop-charge-rang-up.png');
  phase('5: Back, Clear');
  await till.getByRole('button', { name: 'Back', exact: true }).first().click();
  await till.waitForTimeout(1200);
  const voided = till.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${sale.id}/void` && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
  await till.getByRole('button', { name: 'Clear', exact: true }).first().click();
  const v = await voided;
  await till.waitForTimeout(1500);
  await shot(till, '05b-scrum866-shop-after-clear.png');
  const read = facts(await readSale(sale.id));
  phase('5: Tickets tab, no left-behind notice');
  await till.goto('/'); await landing(till).waitFor();
  await till.waitForTimeout(6000);
  const notices = await till.getByTestId('left-behind-sale').count();
  const refusals = await till.getByTestId('left-behind-refusal').count();
  await shot(till, '05c-scrum866-tickets-tab-no-left-behind-notice.png');
  const ok = v?.status() === 200 && read.status === 'voided' && Object.values(read.reasons).includes('Cancelled at the till') && notices === 0 && refusals === 0;
  point('5', ok ? 'PASS' : 'FAIL', '05b-scrum866-shop-after-clear.png',
    'Shop guest: Charge rang the sale up (05a), Back, Clear: the sale reads back voided "Cancelled at the till"; the Tickets tab shows no left-behind notice (05c)',
    { chargeWrote, voidStatus: v?.status() ?? null, sale: read, leftBehindNotices: notices, leftBehindRefusals: refusals });
}

// ---- 6: SCRUM-867, the payment screen keeps the method. ----
async function passExpatKeep() {
  phase('6: new walk-in, Expat on a passport, 1 Hour Play 1 kid + 1 adult (free), Pay');
  await till.goto('/'); await landing(till).waitFor();
  await walkIn(numbers.expat);
  await till.getByRole('heading', { name: 'Expat', exact: true }).first().click();
  const dialog = till.getByRole('dialog', { name: 'Verify Expat rate' });
  await dialog.getByText('Proof checked').waitFor();
  await dialog.getByRole('button', { name: 'Passport', exact: true }).click();
  await dialog.locator('#tier-evidence-expiry').fill('2030-01-01');
  await dialog.getByRole('button', { name: /^Verify Expat — Passport$/ }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  await ticketStep().waitFor({ timeout: 20000 });
  await configure('1 Hour Play', 1, 1);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click().catch(() => {});
  const memberBefore = Boolean((await call('GET', `/members/lookup?phone=${numbers.expat}`)).body.member);
  const paid = await pressPay({ nickname: names.expat });
  receipt.created.push({ kind: 'member', name: names.expat, number: numbers.expat, note: 'walk-in saved to a profile by the till' }); save();
  phase('6: Cash, type a figure, wait');
  await chooseCash();
  const amountDue = baht(flat(await till.locator('body').innerText()).match(/Amount Due\s*฿([\d,]+(?:\.\d\d)?)/)?.[1]);
  const typed = String(amountDue + 100);
  const field = till.locator('#payment-cash-received');
  await field.click();
  await field.fill(typed);
  const at0 = { value: await field.inputValue(), confirmEnabled: await till.getByRole('button', { name: 'Confirm Payment Received', exact: true }).isEnabled() };
  await till.waitForTimeout(3500);
  let memberAfter = false;
  await expect.poll(async () => (memberAfter = Boolean((await call('GET', `/members/lookup?phone=${numbers.expat}`)).body.member)), { timeout: 15000 }).toBe(true).catch(() => {});
  await till.waitForTimeout(1500);
  const after = { fieldThere: await field.count(), value: (await field.count()) ? await field.inputValue() : null,
    confirmEnabled: await till.getByRole('button', { name: 'Confirm Payment Received', exact: true }).isEnabled().catch(() => false),
    change: flat(await till.locator('body').innerText()).match(/Change\s*฿[\d,.]+/)?.[0] ?? null };
  await shot(till, '06-scrum867-cash-and-typed-figure-kept-after-5s.png');
  await confirmCash();
  await thankYou({ expectCredit: false });
  await shot(till, '06b-scrum867-paid-cash.png');
  const read = facts(await readSale(paid.sale.id));
  const ok = paid.detailsStep && !memberBefore && memberAfter && after.fieldThere === 1 && after.value === at0.value && at0.value.replace(/[^\d]/g, '').startsWith(typed)
    && after.confirmEnabled && read.status === 'finalised' && read.customerTier === 'expat';
  point('6', ok ? 'PASS' : 'FAIL', '06-scrum867-cash-and-typed-figure-kept-after-5s.png',
    `New walk-in verified Expat on a passport (2030-01-01) in this sale, Customer Details, Pay; Cash chosen and ฿${typed} typed; 5 s later (the walk-in now a member) Cash and the typed figure are still there; paid (06b)`,
    { pay: paid, amountDue, typed, at0, after, memberBefore, memberAfter, sale: read });
  await startNewSale();
}

// ---- 7: SCRUM-859, History -> Add time on a paired display. ----
async function pairDisplay() {
  const context = await browser.newContext({ baseURL: pos, viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  context.setDefaultTimeout(30000);
  const page = await context.newPage(); watch(page, 'display');
  await page.goto(`${pos}/display`);
  await page.getByTestId('display-pairing-code').waitFor();
  const code = (await page.getByTestId('display-pairing-code').textContent()).trim();
  assert.match(code, /^\d{6}$/);
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode: code, name: `ZZ TEST SCRUM-${T} display` });
  assert.equal(paired.status, 200);
  display = { context, page, id: paired.body.device.id, revoked: false };
  receipt.created.push({ kind: 'display', id: display.id }); save();
  await landing(page).waitFor({ timeout: 60000 });
}
async function dropDisplay() {
  if (!display) return;
  if (!display.revoked) { assert.equal((await call('POST', `/credentials/${display.id}/revoke`, { reason: `ZZ TEST SCRUM-${T} proof step complete` })).status, 200); display.revoked = true; receipt.cleanup.push({ kind: 'display', id: display.id, revoked: true }); save(); }
  await display.context.close().catch(() => {}); display = null;
}
async function passAddTime() {
  // Two children make the count on the display unmistakable: point 3's corrected sale when this run has it.
  const target = (shared.corrected?.secondRead?.status === 'finalised' ? shared.corrected.secondRead : null) ?? shared.touristSale ?? shared.thaiSale;
  assert.ok(target?.receipt, 'a paid ZZ TEST ticket sale of this run');
  phase('7: pair a display, History, Add time +1 hour');
  await pairDisplay();
  // With a display paired the till waits for the customer there: no landing on the till itself.
  await till.goto('/'); await till.locator('a[href="/history"]').first().waitFor();
  await till.locator('a[href="/history"]').first().click();
  const search = till.getByPlaceholder(/^Search by name, receipt number/);
  await search.waitFor({ timeout: 20000 });
  await search.fill(target.receipt);
  await till.getByText(target.receipt, { exact: true }).first().click();
  await till.getByRole('button', { name: 'Add time', exact: true }).click();
  const ext = till.getByRole('dialog', { name: 'Add time', exact: true });
  await ext.getByRole('button', { name: /^\+1 hour/ }).click();
  const optionText = flat(await ext.getByRole('button', { name: /^\+1 hour/ }).innerText());
  const [made] = await Promise.all([
    till.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${target.id}/extensions` && r.request().method() === 'POST'),
    ext.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  assert.equal(made.status(), 200);
  const chargeId = (await made.json()).sale.id;
  receipt.created.push({ kind: 'time-charge', id: chargeId }); save();
  const amount = flat(await ext.innerText()).match(/Amount to charge\s*฿([\d,.]+)/)?.[1] ?? null;
  phase('7: Card chosen: the display draws the line');
  await ext.getByRole('button', { name: 'Card', exact: true }).click();
  const tender = display.page.getByTestId('display-tender');
  const drawn = await tender.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  await display.page.waitForTimeout(1500);
  const shown = drawn ? flat(await tender.innerText()) : flat(await display.page.locator('body').innerText()).slice(0, 400);
  await shot(display.page, '07-scrum859-display-add-time-line-beside-amount-1920x1080.png');
  await shot(till, '07a-scrum859-till-add-time-card-chosen.png');
  phase('7: Cash instead, Record cash');
  await ext.getByRole('button', { name: 'Cash', exact: true }).click();
  await till.waitForTimeout(800);
  const cashDisplay = flat(await display.page.locator('body').innerText()).slice(0, 200);
  await ext.getByRole('button', { name: 'Record cash', exact: true }).click();
  await expect(ext).toHaveCount(0, { timeout: 45000 });
  await till.getByText(/Added \+1 hour to/).waitFor({ timeout: 20000 }).catch(() => {});
  await shot(till, '07b-scrum859-add-time-paid-cash.png');
  const charge = facts(await readSale(chargeId));
  const kids = (target.lines.find(l => l.kind === 'kids')?.quantity) ?? 1;
  // The display draws the count as a badge before the option: "<children> +1 hour ฿<per child> each ฿<line> ... Total ฿<amount>".
  const perChild = Math.round(baht(amount) / kids);
  const lineRead = new RegExp(`(^|\\s)${kids} \\+1 hour ฿${perChild} each ฿${baht(amount)}( |$)`).test(shown) && shown.includes(`Total ฿${baht(amount)}`);
  point('7', drawn && lineRead && charge.status === 'finalised' ? 'PASS' : 'FAIL', '07-scrum859-display-add-time-line-beside-amount-1920x1080.png',
    `History -> ${target.receipt} (${kids} child${kids > 1 ? 'ren' : ''}) -> Add time "+1 hour" -> Card: the paired display draws the line (option, children, price per child) beside the amount; the card was not taken: Cash chosen instead and the charge recorded in cash (07b)`,
    { receipt: target.receipt, kids, perChild, option: optionText, amount, displayDrewTender: drawn, displaySays: shown.slice(0, 400), afterCashChosen: cashDisplay, charge });
  await dropDisplay();
  await till.goto('/').catch(() => {});
}

// ---- 8: SCRUM-868, the aged claim. ----
async function passAged() {
  assert.ok(shared.claimQuote, 'pass c kept a quote naming a claim');
  const replay = async () => {
    const r = await till.request.post('/api/sales/quote', { data: JSON.parse(shared.claimQuote), headers: { 'idempotency-key': randomUUID(), origin: pos } });
    const body = await r.json().catch(() => null);
    const text = JSON.stringify(body ?? {});
    const find = (x, d = 0) => { if (!x || typeof x !== 'object' || d > 5) return null; if (typeof x.code === 'string' && /^TIER_CLAIM_/.test(x.code)) return x; for (const v of Object.values(x)) { const f = find(v, d + 1); if (f) return f; } return null; };
    const refusal = find(body);
    const tier = text.match(/"(?:customerTier|tier)"\s*:\s*"(\w+)"/)?.[1] ?? null;
    return { status: r.status(), refusal: refusal ? { code: refusal.code, message: refusal.message ?? null } : null, tier, ageMinutes: Math.round((Date.now() - shared.claimAt) / 6000) / 10 };
  };
  phase('8: the quote replayed now, before the window closes');
  const fresh = (Date.now() - shared.claimAt) < 29 * 60000 ? await replay() : null;
  const due = shared.claimAt + 30.5 * 60000;
  const maxWait = Number(process.env.WAIT_868_MIN ?? 25) * 60000;
  if (due - Date.now() > maxWait) { point('8', 'NOT PROVABLE', null, `the claim would be ${Math.round((due - Date.now()) / 60000)} more minutes from its window; not waited`, { fresh }); return; }
  phase(`8: waiting ${Math.max(0, Math.round((due - Date.now()) / 1000))} s for the claim to pass 30 minutes`);
  while (Date.now() < due) {
    await till.waitForTimeout(Math.min(60000, due - Date.now()));
    if ((await till.request.get('/api/me')).status() !== 200) { odd('the till session ended while waiting for the claim window'); break; }
  }
  let aged = await replay();
  let unlocked = null;
  // The till locks itself after inactivity (423 on business calls): staff unlock it with the password, as at the
  // counter (POST /api/auth/unlock on the same session), and the same quote is asked again.
  if (aged.status === 423) {
    const lockedAnswer = aged;
    const u = await till.request.post('/api/auth/unlock', { data: { password: need('STAGING_RECEPTION_PASSWORD') }, headers: { 'idempotency-key': randomUUID(), origin: pos } });
    unlocked = { lockedAnswer, unlockStatus: u.status() };
    aged = await replay();
  }
  receipt.checks.aged = { fresh, unlocked, aged }; save();
  const page = await till.context().newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font:18px system-ui;padding:32px;background:#fff;color:#111">
    <h1>SCRUM-868 on staging (api ${esc(receipt.deploys ?? '3224debf0')})</h1>
    <p>A walk-in's Thai rate was confirmed by hand at the own ZZ TEST till at <b>${esc(new Date(shared.claimAt).toISOString())}</b>
    (POST /api/sales/tier-approvals ${esc(shared.claimStatus)}). The till's own quote naming that claim was kept and replayed
    with the same till session (POST /api/sales/quote, a read).</p>
    <h2>Replayed at ${esc(fresh?.ageMinutes)} min</h2><pre>${esc(JSON.stringify(fresh, null, 2))}</pre>
    ${unlocked ? `<h2>At ${esc(unlocked.lockedAnswer.ageMinutes)} min the till had locked itself (423); unlocked with the password: ${esc(unlocked.unlockStatus)}</h2>` : ""}<h2>Replayed at ${esc(aged.ageMinutes)} min</h2><pre>${esc(JSON.stringify(aged, null, 2))}</pre>
    </body></html>`);
  await page.screenshot({ path: resolve(out, '08-scrum868-aged-claim-answer.png') });
  await page.close();
  const ok = aged.ageMinutes >= 30 && aged.refusal?.code === 'TIER_CLAIM_EXPIRED' && /more than 30 minutes ago/.test(aged.refusal?.message ?? '') && (!fresh || fresh.refusal === null);
  point('8', ok ? 'PASS' : 'FAIL', '08-scrum868-aged-claim-answer.png',
    'The till session\'s quote naming a hand-confirmed Thai claim: priced with no refusal while fresh, answered TIER_CLAIM_EXPIRED "confirmed more than 30 minutes ago" once older than the window', { fresh, unlocked, aged });
}

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true; (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) }); save();
    console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    if (display) await shot(display.page, `failed-${key}-display.png`).catch(() => {});
    if (!receipt.points[key]) point(key, 'FAIL', `failed-${key}-till.png`, `the pass stopped: ${firstLine(error)}`);
    await dropDisplay().catch(() => {});
    await till.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await till.goto('/').catch(() => {});
  }
};

try {
  phase('sign in and create own till');
  await adminSignIn();
  const branches = (await call('GET', '/branches')).body;
  branchId = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name)).id;
  const box = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online');
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(role => s.devices.some(d => d.role === role)));
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  for (const phone of Object.values(numbers)) assert.equal((await call('GET', `/members/lookup?phone=${phone}`)).body.member, null, 'ZZ TEST number must be unused');
  receipt.checks.numbersUnusedBefore = true;
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();
  browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  till = await ctx.newPage(); watch(till, 'till'); watchQuotes(till); watchSaleWrites(till);
  await till.goto(pos);
  phase('reception signs in at the own till (new browser profile)');
  await signInAtTill(till);
  const me = await (await till.request.get('/api/me')).json().catch(() => null);
  staffNames = [...new Set([me?.employee?.name, me?.employee?.nickname, me?.account?.name, me?.account?.nickname, me?.name, me?.nickname, me?.displayName, me?.account?.displayName]
    .filter(v => typeof v === 'string' && v.trim().length >= 2).map(v => v.trim()))];
  receipt.checks.staffNameMasks = staffNames.length;
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    let orderChanged = 0; for (const u of urls) orderChanged += (await (await fetch(u, { cache: 'no-store' })).text()).split('Order changed at the till after Pay').length - 1;
    return { files: urls.length, orderChangedMarkers: orderChanged };
  }); save();
  assert.ok(receipt.checks.bundle.orderChangedMarkers > 0, 'the till serves the SCRUM-865 bundle');
  for (const [key, fn] of [['c', passClaim], ['1', passThaiCredit], ['2', passTouristCredit], ['3', passCorrected], ['4', passFnb], ['5', passShop], ['6', passExpatKeep], ['7', passAddTime], ['8', passAged]])
    if (wanted.includes(key)) await attempt(key, fn);
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, failure: firstLine(error) };
  console.log('RUN FAILED |', receipt.phase, '|', firstLine(error));
  if (till) await shot(till, 'failed-run-till.png').catch(() => {});
} finally {
  phase('clean up');
  const clean = async (step, action) => { try { await action(); } catch (e) { failed = true; (receipt.cleanupFailures ??= []).push({ step, failure: firstLine(e) }); console.log('CLEANUP FAILED', step, '|', firstLine(e)); } save(); };
  await clean('unpair display', () => dropDisplay());
  if (station) {
    let own = false;
    await clean('verify own till', async () => { assert.equal((await call('GET', `/stations/${station.id}`)).body.station.name, fixtureName); own = true; });
    if (own) {
      let sales = [];
      await clean('read own sales', async () => { sales = await stationSales(); for (const s of sales) assert.equal(s.stationId, station.id); });
      // Only this run's own till, created minutes ago: nothing older than today can be here.
      for (const s of sales.filter(s => ['open', 'tendering'].includes(s.status))) await clean(`void ${s.id}`, async () => {
        assert.equal((await call('POST', `/sales/${s.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        receipt.cleanup.push({ kind: 'sale', id: s.id, voided: true, by: 'cleanup' });
      });
      for (const { id } of sales.filter(s => s.status === 'finalised')) await clean(`print ${id}`, async () => {
        let jobs; await expect.poll(async () => { jobs = (await call('GET', `/sales/${id}`)).body.printJobs; return jobs.every(j => ['printed', 'skipped'].includes(j.status)); }, { timeout: 60000 }).toBe(true);
        receipt.cleanup.push({ kind: 'finalised-test-sale', id, retained: true, printJobs: jobs.map(j => j.status) });
      });
      await clean('final sales read-back', async () => {
        const final = await stationSales();
        receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map(s => ({ receipt: s.receiptNumber ?? null, status: s.status, baht: s.totals?.grossSatang / 100 })) });
        assert.ok(final.every(s => ['finalised', 'voided'].includes(s.status)));
      });
      await clean('retire own till', async () => {
        assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
        assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
        const r = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === station.id);
        assert.ok(r.archived); receipt.cleanup.push({ kind: 'station', id: station.id, archived: true, devices: r.devices.length });
      });
    }
  }
  for (const [key, phone] of Object.entries(numbers)) await clean(`test number ${key}`, async () => {
    const member = (await call('GET', `/members/lookup?phone=${phone}`)).body.member;
    if (member) {
      assert.ok(`${member.nickname ?? ''} ${member.name ?? ''}`.includes(`ZZ TEST ${T}`), 'only own named test members');
      assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
      assert.equal((await call('GET', `/members/lookup?phone=${phone}`)).body.member, null);
      receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true });
    } else receipt.cleanup.push({ kind: 'test-number', key, member: null });
  });
  if (till) await clean('sign out till', async () => {
    if ((await till.request.get('/api/me')).status() === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await till.request.get('/api/me')).status(), 401); receipt.cleanup.push({ kind: 'till-session', signedOut: true });
  });
  await clean('sign out admin', async () => {
    if ((await admin.get('/api/me')).status() === 200) assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await admin.get('/api/me')).status(), 401); receipt.cleanup.push({ kind: 'admin-session', signedOut: true });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.verdict])), odd: receipt.odd.length, pageErrors: receipt.pageErrors.length, failures: receipt.failures?.length ?? 0, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
