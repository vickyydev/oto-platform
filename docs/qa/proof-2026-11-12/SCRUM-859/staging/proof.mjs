// SCRUM-859 staging proof: the customer's payment screen shows the full order, not only the amount.
// Adapted from the committed SCRUM-863 and SCRUM-858 harnesses (docs/qa/proof-2026-11-12/SCRUM-86{3,8}/staging).
// Own ZZ TEST till (QR routed to the simulated gateway), invented numbers (08985900xx), cash only:
// every QR is shown, pictured and cancelled; nothing is paid by QR. No credential, pairing code or raw
// response body enters the receipt or the console.
//
//   node proof.mjs <out-dir> [passes]
//   passes: t  ticket sale on the split view: cash, then the QR, cancelled, paid cash   (points 1-2)
//           f  F&B guest order, one dish with an option and a note: cash, QR, cash      (point 3)
//           s  shop guest sale, two items                                               (point 4)
//           l  long ticket order: five tickets, ten rows, cancelled (voided)            (point 5)
//           d  a separate display paired at 1920 x 1080: the ticket sale of point 1    (point 6)
//           p  the phone-width till (390 x 844): the QR handed to the customer          (point 7)
// ZZ_BASE moves the invented numbers (08985900<base>..); each run asserts they are unused first.
//
// As run on 12 November 2026 against the till at d72fa7b6 (it carries SCRUM-859's d3b3f556 unchanged; the api at
// 7f653066): `node proof.mjs out-01` (receipt-run-01.json; its two-column overlap and shop-card measures were wrong),
// then, with those two measures corrected, `ZZ_BASE=30 node proof.mjs out-02`: the pictures and receipt.json beside
// this file are that second run's. The tender screens (History → Add time, an event pass) need the api deployed at
// d3b3f556 or later and are not driven here.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The repository root: five folders up from docs/qa/proof-<date>/SCRUM-859/staging, or OTO_REPO when run from elsewhere.
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const out = resolve(process.cwd(), process.argv[2] ?? 'out');
mkdirSync(out, { recursive: true });
const wanted = (process.argv[3] ?? 't,f,s,l,d,p').split(',');
const T = '859';
const base = Number(process.env.ZZ_BASE ?? 20);
const zz = i => '08985900' + String(base + i).padStart(2, '0');
const numbers = { ticket: zz(0), long: zz(1), display: zz(2), phone: zz(3) };
const pos = 'https://oto-pos-web-staging.onrender.com';
const receipt = { ticket: `SCRUM-${T}`, startedAt: new Date().toISOString(), phase: 'preflight', passes: wanted, numbers,
  points: {}, measures: {}, created: [], odd: [], pageErrors: [], cleanup: [] };
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
let browser = null, till = null, display = null, station = null, branchId = null, failed = false;

/** Pictures: the signed-in account's corner and any password field are covered; on a paid screen the band codes
 *  and credit QR grids are too. The payment QR is NOT covered: it is the simulated gateway's code, the thing proved. */
const shot = async (page, name, { paid = false } = {}) => {
  const mask = [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code')];
  if (paid) mask.push(page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/), page.locator('svg:not(.lucide), canvas'));
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask });
  console.log('picture', name);
  return name;
};
const point = (key, verdict, picture, shows, seen = {}) => { receipt.points[key] = { verdict, picture, shows, seen }; save(); console.log('POINT', key, verdict, '|', shows); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what); };
function watch(page, label) {
  page.on('pageerror', e => receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('console', m => { if (m.type() === 'error') receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'console.error', text: m.text().split('\n')[0].slice(0, 240) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` }); });
}
const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digits) => { for (const d of digits) await scope.getByRole('button', { name: d, exact: true }).last().click(); };

/** Where each block of the customer's payment frame sits, read in one pass. */
async function measure(page) {
  return page.evaluate(() => {
    const f = document.querySelector('[data-testid="customer-payment"]');
    if (!f) return null;
    const box = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height) }; };
    const q = s => f.querySelector(`[data-testid="${s}"]`);
    const lines = q('payment-order-lines'), summary = q('payment-order-summary'), amount = q('payment-amount');
    const lb = lines.getBoundingClientRect(), ab = amount.getBoundingClientRect();
    // The line cards: the list's children, or the children of the one wrapper the F&B and shop lists put them in.
    let holder = lines; while (holder.children.length === 1 && holder.firstElementChild.children.length > 1 && !holder.firstElementChild.matches('[class*="rounded"]')) holder = holder.firstElementChild;
    const cards = [...holder.children].map(c => { const b = c.getBoundingClientRect(); const shown = Math.max(0, Math.min(b.bottom, lb.bottom) - Math.max(b.top, lb.top)); return { height: Math.round(b.height), shownPx: Math.round(shown), whole: b.top >= lb.top - 1 && b.bottom <= lb.bottom + 1 }; });
    const leaves = [...amount.querySelectorAll('*')].filter(e => e.childElementCount === 0 && /^฿[\d,]+(\.\d\d)?$/.test(e.textContent.trim()));
    const fig = leaves.sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize))[0] ?? null;
    const fb = fig?.getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    const qr = f.querySelector('img[data-testid="payment-qr"]');
    const qb = qr?.getBoundingClientRect();
    const inside = (b, c) => Boolean(b) && b.top >= c.top - 1 && b.bottom <= c.bottom + 1 && b.left >= c.left - 1 && b.right <= c.right + 1;
    return {
      viewport: { width: innerWidth, height: innerHeight }, frame: box(f), lines: box(lines), summary: box(summary), amount: box(amount), qr: box(qr),
      linesList: { visibleHeight: lines.clientHeight, contentHeight: lines.scrollHeight, scrollsInItself: lines.scrollHeight > lines.clientHeight + 1, paddingTop: parseFloat(getComputedStyle(lines).paddingTop) },
      cards, everyCardWhole: cards.every(c => c.whole),
      // Only when the two share columns: in the two-column layout the summary sits beside the amount, not above it.
      summaryOverlapsAmountPx: summary && summary.getBoundingClientRect().right > ab.left + 1 && summary.getBoundingClientRect().left < ab.right - 1 ? Math.max(0, Math.round(summary.getBoundingClientRect().bottom - ab.top)) : 0,
      figure: fig ? { text: fig.textContent.trim(), ...box(fig), visible: inside(fb, ab) && inside(fb, fr) && fb.bottom <= innerHeight } : null,
      qrWhole: qr ? inside(qb, ab) && inside(qb, fr) && qb.bottom <= innerHeight : null,
      amountScrollsInItself: amount.scrollHeight > amount.clientHeight + 1,
      pageScrolls: document.scrollingElement.scrollHeight > innerHeight + 1,
      text: { lines: lines.innerText.replace(/\s+/g, ' ').trim(), summary: summary?.innerText.replace(/\s+/g, ' ').trim() ?? '', amount: amount.innerText.replace(/\s+/g, ' ').trim() },
    };
  });
}
const nothingCut = m => Boolean(m && m.everyCardWhole && m.figure?.visible && m.summaryOverlapsAmountPx === 0);

async function signInAtTill(page) {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect.poll(async () => (await picker.isVisible()) || (await landing(page).isVisible()), { timeout: 60000 }).toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: fixtureName }).first().click();
  await page.locator('a[href="/history"]').first().waitFor();
  await landing(page).waitFor({ timeout: 20000 });
}
/** The number typed on the customer's screen (the split view's half or the paired display), then walk-in Tourist. */
async function walkIn(surface, number) {
  await landing(surface).waitFor();
  if (await surface.getByTestId('language-choice').isVisible()) await surface.getByTestId('language-choice-en').click();
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await keypad(scope, number);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  await offer.waitFor();
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
}
async function quantity(label, target) {
  const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
  const remove = till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 8; i++) { const now = Number(await value.textContent()); if (now === target) return; await (now < target ? add : remove).click(); await till.waitForTimeout(250); }
  assert.equal(Number(await value.textContent()), target);
}
async function configure(name, kids, adults) {
  await till.getByRole('heading', { name, exact: true }).first().click();
  await till.getByRole('heading', { name: /^Configure:/ }).waitFor();
  await quantity('Kids', kids); await quantity('Adults', adults);
}
/** Continue, Pay ฿X → the payment step; returns the Pay button and the staff half's Amount Due. */
async function toPayment() {
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  const pay = till.getByRole('button', { name: /^Pay ฿/ });
  await expect(pay).toBeEnabled({ timeout: 20000 });
  const payButton = flat(await pay.textContent());
  await pay.click();
  const done = till.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible().catch(() => false)) await done.click();
  const due = till.getByRole('heading', { name: 'Amount Due' });
  await due.waitFor({ timeout: 20000 });
  const amountDue = flat(await till.locator('body').innerText()).match(/Amount Due\s*(฿[\d,]+(?:\.\d\d)?)/)?.[1] ?? null;
  return { payButton, amountDue };
}
async function chooseTicketMethod(name) {
  await till.getByRole('heading', { name, exact: true }).first().click();
  await till.waitForTimeout(800);
}
/** The QR from the simulated gateway. Waits until the customer's frame draws it when a page is named. */
async function showQr(customerPage, method = async () => chooseTicketMethod('PromptPay')) {
  await method();
  const b = till.getByRole('button', { name: 'Show payment QR', exact: true }).first();
  await b.scrollIntoViewIfNeeded();
  const [resp] = await Promise.all([till.waitForResponse(r => r.url().endsWith('/api/payments/attempts') && r.request().method() === 'POST'), b.click()]);
  const body = await resp.json().catch(() => null);
  receipt.created.push({ kind: 'qr-attempt', id: body?.attempt?.id ?? null, route: body?.route ?? null, status: resp.status() }); save();
  assert.equal(resp.status(), 200); assert.equal(body?.route, 'gateway');
  if (customerPage) { await customerPage.getByTestId('customer-payment').locator('img[data-testid="payment-qr"]').waitFor({ timeout: 30000 }); await customerPage.waitForTimeout(1500); }
  return body?.attempt?.id ?? null;
}
async function cancelQr(attemptId) {
  const c = till.getByTestId('payment-cancel-qr');
  await c.scrollIntoViewIfNeeded(); await c.click();
  await expect(c).toBeHidden({ timeout: 30000 });
  await till.waitForTimeout(1500);
  const sale = (await stationSales()).find(s => ['tendering', 'open'].includes(s.status));
  const read = sale ? (await call('GET', `/sales/${sale.id}`)).body : null;
  const attempt = read?.attempts?.find(a => a.id === attemptId);
  receipt.created.push({ kind: 'qr-cancelled', id: attemptId, attemptStatus: attempt?.status ?? null }); save();
}
async function payTicketCash() {
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  for (let i = 0; i < 3 && !(await confirm.isEnabled().catch(() => false)); i++) await chooseTicketMethod('Cash');
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded(); await confirm.click();
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(1500);
}
async function payPanelCash(figure) {
  await till.getByRole('button', { name: /^Cash / }).click();
  await till.getByLabel('Cash received', { exact: true }).fill(figure);
  await till.getByRole('button', { name: 'Record cash', exact: true }).click();
}

// ---- t: ticket sale on the split view. Points 1-2. ----
async function passTicket() {
  phase('t: walk-in Tourist, 1 Hour Play with 2 kids and 1 adult');
  await till.goto('/'); await landing(till).waitFor();
  await walkIn(till, numbers.ticket);
  await configure('1 Hour Play', 2, 1);
  const staff = await toPayment();
  phase('t: Cash');
  await chooseTicketMethod('Cash');
  await till.getByTestId('customer-payment').waitFor();
  await till.waitForTimeout(1200);
  const m = await measure(till);
  receipt.measures.ticketCash = m; save();
  await shot(till, '01-ticket-cash-split-1440x900.png');
  const figureMatches = Boolean(m.figure) && baht(m.figure.text) === baht(staff.amountDue);
  const linesRead = /1 Hour Play/.test(m.text.lines) && /Kids\s*2 × ฿690/.test(m.text.lines) && /Adults\s*1 × ฿350/.test(m.text.lines);
  const words = /Please pay/.test(m.text.amount) && /Total/.test(m.text.summary);
  if (!nothingCut(m)) odd(`1440 x 900 split view, ticket cash: the order list shows ${m.linesList.visibleHeight}px (${m.linesList.visibleHeight - m.linesList.paddingTop}px under its padding) of ${m.linesList.contentHeight}px; the ticket card shows ${m.cards[0]?.shownPx}px of ${m.cards[0]?.height}px; the summary runs ${m.summaryOverlapsAmountPx}px under the amount block`, { picture: '01-ticket-cash-split-1440x900.png' });
  // The same screen in a 1920 x 1080 window, to tell a short window from a broken layout.
  await till.setViewportSize({ width: 1920, height: 1080 }); await till.waitForTimeout(800);
  receipt.measures.ticketCash1920 = await measure(till); save();
  await shot(till, '01b-ticket-cash-split-1920x1080.png');
  await till.setViewportSize({ width: 1440, height: 900 }); await till.waitForTimeout(800);
  point('1', linesRead && words && figureMatches && nothingCut(m) ? 'PASS' : 'FAIL', '01-ticket-cash-split-1440x900.png',
    'Ticket sale, Cash, split view 1440 x 900: the customer half carries the package line, Kids 2 x ฿690, Adults 1 x ฿350, the Total and "Please pay" with the staff half\'s Amount Due',
    { staff, figure: m.figure, linesInTheDom: linesRead, words, figureMatchesAmountDue: figureMatches, nothingCut: nothingCut(m), cards: m.cards, linesList: m.linesList, summaryOverlapsAmountPx: m.summaryOverlapsAmountPx,
      at1920: { nothingCut: nothingCut(receipt.measures.ticketCash1920), cards: receipt.measures.ticketCash1920?.cards, linesList: receipt.measures.ticketCash1920?.linesList } });

  phase('t: PromptPay → Show payment QR (simulated gateway), then cancel');
  const attempt = await showQr(till);
  const q = await measure(till);
  receipt.measures.ticketQr = q; save();
  await shot(till, '02-ticket-qr-split-1440x900.png');
  await cancelQr(attempt);
  phase('t: pay cash');
  await payTicketCash();
  await shot(till, '02b-ticket-paid-cash.png', { paid: true });
  const sale = (await stationSales()).find(s => s.status === 'finalised' && s.totals.grossSatang === baht(staff.amountDue) * 100);
  const qrOk = q.qrWhole && (q.qr.right - q.qr.left) >= 200 && q.figure?.visible && /Scan to Pay/.test(q.text.amount);
  point('2', qrOk && q.everyCardWhole && Boolean(sale) ? 'PASS' : 'FAIL', '02-ticket-qr-split-1440x900.png',
    'Same sale, PromptPay → Show payment QR: the QR and the amount are drawn whole beside the order\'s lines; the QR cancelled and the sale paid in cash (02b)',
    { qr: q.qr, qrWhole: q.qrWhole, figure: q.figure, cards: q.cards, linesList: q.linesList, summaryOverlapsAmountPx: q.summaryOverlapsAmountPx, sale: sale ? { receipt: sale.receiptNumber, status: sale.status, baht: sale.totals.grossSatang / 100 } : null });
  await till.getByRole('button', { name: 'Start New Sale' }).click();
}

// ---- f: F&B guest order. Point 3. ----
async function passFnb() {
  phase('f: F&B guest, Smashed avocado + bruschetta with Egg your way and the note "ZZ TEST no salt"');
  await till.goto('/'); await landing(till).waitFor();
  await till.getByRole('button', { name: 'F&B', exact: true }).click();
  await till.getByRole('heading', { name: 'Scan Wristband', exact: true }).waitFor();
  await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  const search = till.getByPlaceholder('Search dish…'); await search.scrollIntoViewIfNeeded(); await search.fill('Smashed avocado');
  const item = till.getByText('Smashed avocado + bruschetta', { exact: true }).first(); await item.scrollIntoViewIfNeeded(); await item.click();
  const d = till.getByRole('dialog');
  await d.getByRole('button', { name: /Egg your way/ }).click();
  await d.getByPlaceholder('e.g. no pickles, extra crispy').fill('ZZ TEST no salt');
  await d.getByRole('button', { name: /^Add to order/ }).click();
  const charge = till.getByRole('button', { name: /^Charge ฿/ });
  await expect(charge).toBeEnabled({ timeout: 20000 });
  const total = baht(await charge.textContent());
  await charge.click();
  const pickup = till.getByRole('dialog', { name: 'Pick-up Code', exact: true });
  await pickup.getByRole('button', { name: '8', exact: true }).click();
  await pickup.getByRole('button', { name: '5', exact: true }).click();
  await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();
  phase('f: Cash');
  await till.getByRole('button', { name: /^Cash / }).click();
  await till.waitForTimeout(1500);
  const m = await measure(till);
  receipt.measures.fnbCash = m; save();
  await shot(till, '03-fnb-cash-split-1440x900.png');
  phase('f: PromptPay → Show payment QR, then cancel');
  const attempt = await showQr(till, async () => { await till.getByRole('button', { name: /Customer scans to pay/ }).click(); await till.waitForTimeout(800); });
  const q = await measure(till);
  receipt.measures.fnbQr = q; save();
  await shot(till, '03b-fnb-qr-split-1440x900.png');
  await cancelQr(attempt);
  phase('f: pay cash');
  await payPanelCash(total.toFixed(2));
  await till.getByRole('heading', { name: 'Order Confirmed', exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(1200);
  await shot(till, '03c-fnb-paid-cash.png', { paid: true });
  const cashOk = /Smashed avocado \+ bruschetta/.test(m.text.lines) && /Egg your way/.test(m.text.lines) && /ZZ TEST no salt/.test(m.text.lines) && /Total/.test(m.text.summary) && /Amount to pay/.test(m.text.amount) && baht(m.figure?.text) === total;
  if (!q.everyCardWhole) odd(`F&B with the QR up at 1440 x 900: the dish's card shows ${q.cards[0]?.shownPx}px of ${q.cards[0]?.height}px, so its option and the note "ZZ TEST no salt" are below the fold of the list`, { picture: '03b-fnb-qr-split-1440x900.png' });
  const verdict = cashOk && nothingCut(m) && q.qrWhole && q.everyCardWhole ? 'PASS' : (cashOk && q.qrWhole ? 'PARTIAL' : 'FAIL');
  point('3', verdict, '03-fnb-cash-split-1440x900.png',
    'F&B guest, Cash: the customer half lists the dish with its option and note, the Total and the amount; then the QR beside the line (03b); the QR cancelled and paid in cash (03c)',
    { total, cash: { cards: m.cards, figure: m.figure, words: cashOk, nothingCut: nothingCut(m) }, qr: { qrWhole: q.qrWhole, figure: q.figure, cards: q.cards, linesList: q.linesList } });
  await till.getByRole('button', { name: 'New Order', exact: true }).click();
}

// ---- s: Shop guest sale. Point 4. ----
async function passShop() {
  phase('s: Shop guest, 2 x Helium Balloon (65) and 1 x Merch Blue Emoji Toy');
  await till.goto('/'); await landing(till).waitFor();
  await till.getByRole('button', { name: 'Shop', exact: true }).click();
  await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  const pick = async name => { const e = till.getByText(name, { exact: true }).first(); await e.scrollIntoViewIfNeeded(); await e.click(); await till.waitForTimeout(600); };
  await pick('Helium Balloon (65)'); await pick('Helium Balloon (65)'); await pick('Merch Blue Emoji Toy');
  const charge = till.getByRole('button', { name: /^Charge ฿/ });
  const total = baht(await charge.textContent());
  await charge.scrollIntoViewIfNeeded(); await charge.click();
  await till.getByRole('button', { name: /^Cash / }).click();
  await till.waitForTimeout(1500);
  const m = await measure(till);
  receipt.measures.shopCash = m; save();
  await shot(till, '04-shop-cash-split-1440x900.png');
  await till.getByTestId('payment-order-lines').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await till.waitForTimeout(500);
  await shot(till, '04b-shop-list-scrolled-to-the-end.png');
  await payPanelCash(total.toFixed(2));
  await till.getByRole('heading', { name: 'Sale Confirmed', exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(1200);
  await shot(till, '04c-shop-paid-cash.png', { paid: true });
  const words = /Helium Balloon \(65\)\s*฿65 each/.test(m.text.lines) && /Merch Blue Emoji Toy\s*฿100 each/.test(m.text.lines) && /Total/.test(m.text.summary) && baht(m.figure?.text) === total;
  if (!m.everyCardWhole) odd(`Shop, two lines at 1440 x 900: the second line's card shows ${m.cards[1]?.shownPx}px of ${m.cards[1]?.height}px until the list is scrolled (04b)`, { picture: '04-shop-cash-split-1440x900.png' });
  point('4', words && nothingCut(m) ? 'PASS' : (words && m.figure?.visible ? 'PARTIAL' : 'FAIL'), '04-shop-cash-split-1440x900.png',
    'Shop guest, two items: lines with "each" prices, the Total and the amount; paid in cash (04c)', { total, cards: m.cards, linesList: m.linesList, figure: m.figure, words });
  await till.getByRole('button', { name: 'New Sale' }).click();
}

// ---- l: a long ticket order. Point 5. ----
async function passLong() {
  phase('l: five tickets, each with kids and adults');
  await till.goto('/'); await landing(till).waitFor();
  await walkIn(till, numbers.long);
  const tickets = [['1 Hour Play', 2, 1], ['2 Hours Play', 1, 1], ['Full Day Pass', 1, 1], ['Eat & Play Kids Pass', 1, 1], ['1 Kid + 1 Adult (1 hour)', 1, 1]];
  for (const [i, [name, k, a]] of tickets.entries()) {
    if (i) { await till.getByRole('button', { name: 'Add Another Ticket', exact: true }).click(); await till.waitForTimeout(800); }
    await configure(name, k, a);
  }
  const staff = await toPayment();
  await chooseTicketMethod('Cash');
  await till.waitForTimeout(1200);
  const m = await measure(till);
  receipt.measures.longCash = m; save();
  await shot(till, '05-long-order-cash-split-1440x900.png');
  await till.getByTestId('payment-order-lines').evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await till.waitForTimeout(500);
  await shot(till, '05b-long-order-list-scrolled-half-way.png');
  await till.setViewportSize({ width: 1920, height: 1080 }); await till.waitForTimeout(800);
  receipt.measures.longCash1920 = await measure(till); save();
  await shot(till, '05c-long-order-split-1920x1080.png');
  await till.setViewportSize({ width: 1440, height: 900 }); await till.waitForTimeout(800);
  const rows = (m.text.lines.match(/×/g) ?? []).length;
  const ok = m.linesList.scrollsInItself && !m.pageScrolls && m.figure?.visible && /Total/.test(m.text.summary);
  const readable = m.linesList.visibleHeight - m.linesList.paddingTop >= 100;
  if (!readable) odd(`long order at 1440 x 900: the list scrolls in its own area, but that area is ${m.linesList.visibleHeight}px tall (${m.linesList.visibleHeight - m.linesList.paddingTop}px under its padding), less than one ticket card (${m.cards[0]?.height}px): no line is readable whole at any scroll position`, { picture: '05b-long-order-list-scrolled-half-way.png' });
  point('5', ok ? (readable ? 'PASS' : 'PARTIAL') : 'FAIL', '05-long-order-cash-split-1440x900.png',
    `Long order (${m.cards.length} tickets, ${rows} priced rows): the list scrolls inside its own area, the Total and the amount stay on the screen and the page itself does not scroll`,
    { staff, cards: m.cards.length, rows, linesList: m.linesList, figure: m.figure, pageScrolls: m.pageScrolls, at1920: receipt.measures.longCash1920?.linesList });
  phase('l: cancel the long order (no money taken)');
  await till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await till.waitForTimeout(2500);
}

// ---- d: a separate display paired at 1920 x 1080. Point 6. ----
async function dropDisplay() {
  if (!display) return;
  if (!display.revoked) { assert.equal((await call('POST', `/credentials/${display.id}/revoke`, { reason: `ZZ TEST SCRUM-${T} proof step complete` })).status, 200); display.revoked = true; receipt.cleanup.push({ kind: 'display', id: display.id, revoked: true }); save(); }
  await display.context.close().catch(() => {}); display = null;
}
async function passDisplay() {
  phase('d: pair own display at 1920 x 1080');
  await till.goto('/'); await landing(till).waitFor();
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
  phase('d: the number on the display, walk-in, 1 Hour Play 2 + 1, Cash');
  await walkIn(page, numbers.display);
  await configure('1 Hour Play', 2, 1);
  const staff = await toPayment();
  await chooseTicketMethod('Cash');
  await page.getByTestId('customer-payment').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const m = await measure(page);
  receipt.measures.displayCash = m; save();
  await shot(page, '06-display-cash-1920x1080.png');
  await shot(till, '06a-till-staff-side-with-display.png');
  const tillHalf = await till.getByTestId('customer-payment').count();
  phase('d: the QR on the display, then cancel');
  const attempt = await showQr(page);
  const q = await measure(page);
  receipt.measures.displayQr = q; save();
  await shot(page, '06b-display-qr-1920x1080.png');
  await cancelQr(attempt);
  await payTicketCash();
  await shot(till, '06c-display-sale-paid-cash.png', { paid: true });
  const twoColumns = m.amount.left >= m.lines.right - 1 && m.amount.top <= m.lines.top + 1;
  const ok = twoColumns && nothingCut(m) && /Kids\s*2 × ฿690/.test(m.text.lines) && /Please pay/.test(m.text.amount) && baht(m.figure?.text) === baht(staff.amountDue) && q.qrWhole && q.everyCardWhole;
  point('6', ok ? 'PASS' : 'FAIL', '06-display-cash-1920x1080.png',
    'Paired display, 1920 x 1080 landscape: the order on the left, the amount in its own column on the right; the QR the same way (06b); cancelled, paid cash (06c)',
    { staff, twoColumns, lines: m.lines, amount: m.amount, cards: m.cards, figure: m.figure, qr: { qrWhole: q.qrWhole, figure: q.figure, everyCardWhole: q.everyCardWhole }, tillDrawsItsOwnCustomerHalf: tillHalf });
  await till.getByRole('button', { name: 'Start New Sale' }).click();
  await dropDisplay();
}

// ---- p: the phone-width till. Point 7. ----
async function passPhone() {
  phase('p: the till at 390 x 844, no display');
  await till.setViewportSize({ width: 390, height: 844 });
  await till.goto('/');
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await till.getByText('1 Hour Play', { exact: true }).first().click();
  await till.getByRole('heading', { name: /^Configure:/ }).waitFor();
  await quantity('Kids', 2); await quantity('Adults', 1);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  phase('p: the phone handed over for the number');
  await till.getByRole('button', { name: 'Customer is ready', exact: true }).click();
  const lang = till.getByTestId('language-choice-en'); if (await lang.isVisible().catch(() => false)) await lang.click();
  await keypad(till, numbers.phone);
  await till.getByRole('button', { name: 'Done', exact: true }).first().click();
  const pay = till.getByRole('button', { name: /^Pay ฿/ }); await expect(pay).toBeEnabled({ timeout: 20000 });
  const payButton = flat(await pay.textContent()); await pay.click();
  await till.getByRole('heading', { name: 'Amount Due' }).waitFor({ timeout: 20000 });
  phase('p: PromptPay → Show payment QR, the phone handed to the customer');
  const attempt = await showQr(null);
  await shot(till, '07a-phone-staff-qr-requested.png');
  await till.getByRole('button', { name: 'Customer is ready', exact: true }).click();
  await till.getByTestId('customer-payment').locator('img[data-testid="payment-qr"]').waitFor({ timeout: 30000 });
  await till.waitForTimeout(1500);
  const m = await measure(till);
  receipt.measures.phoneQr = m; save();
  await shot(till, '07-phone-customer-payment-390x844.png');
  const handBack = await till.getByRole('button', { name: 'Done — return phone to staff', exact: true }).boundingBox();
  const figureUnderTheHandBackBar = Boolean(handBack && m.figure && m.figure.bottom > handBack.y);
  await till.getByTestId('payment-amount').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await till.waitForTimeout(500);
  await shot(till, '07b-phone-amount-block-scrolled.png');
  await till.getByRole('button', { name: 'Done — return phone to staff', exact: true }).click();
  await cancelQr(attempt);
  await payTicketCash();
  await shot(till, '07c-phone-paid-cash.png', { paid: true });
  if (!m.figure?.visible || figureUnderTheHandBackBar) odd(`phone till 390 x 844, the customer's QR screen: the amount ${m.figure?.text} sits at ${m.figure?.top}-${m.figure?.bottom}px, past the frame's ${m.frame.bottom}px bottom and under the hand-back bar; the order list shows ${m.linesList.visibleHeight}px of ${m.linesList.contentHeight}px`, { picture: '07-phone-customer-payment-390x844.png' });
  point('7', nothingCut(m) && m.qrWhole && !figureUnderTheHandBackBar ? 'PASS' : 'FAIL', '07-phone-customer-payment-390x844.png',
    'Phone-width till, the QR handed to the customer: the order\'s lines with the amount pinned beside the QR',
    { payButton, cards: m.cards, linesList: m.linesList, figure: m.figure, qrWhole: m.qrWhole, summaryOverlapsAmountPx: m.summaryOverlapsAmountPx, amountScrollsInItself: m.amountScrollsInItself, figureUnderTheHandBackBar });
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  await till.setViewportSize({ width: 1440, height: 900 });
}

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true; (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) }); save();
    console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    if (display) await shot(display.page, `failed-${key}-display.png`).catch(() => {});
    try { const c = till.getByTestId('payment-cancel-qr'); if (await c.isVisible().catch(() => false)) { await c.click(); await till.waitForTimeout(2000); } } catch { /* read back below */ }
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
  // QR routed to the gateway: on staging that is the simulated gateway, which settles nothing by itself.
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'gateway' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();
  browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  till = await ctx.newPage(); watch(till, 'till');
  await till.goto(pos);
  phase('reception signs in at the own till (new browser profile)');
  await signInAtTill(till);
  receipt.checks = { bundle: await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    let marker = 0; for (const u of urls) marker += (await (await fetch(u, { cache: 'no-store' })).text()).split('customer-payment').length - 1;
    return { files: urls.map(u => u.split('/').pop().split('?')[0]), customerPaymentMarkers: marker };
  }) }; save();
  assert.ok(receipt.checks.bundle.customerPaymentMarkers > 0, 'the till serves the SCRUM-859 bundle');
  if (wanted.includes('t')) await attempt('t', passTicket);
  if (wanted.includes('f')) await attempt('f', passFnb);
  if (wanted.includes('s')) await attempt('s', passShop);
  if (wanted.includes('l')) await attempt('l', passLong);
  if (wanted.includes('d')) await attempt('d', passDisplay);
  if (wanted.includes('p')) await attempt('p', passPhone);
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
      for (const s of sales.filter(s => ['open', 'tendering'].includes(s.status))) await clean(`void ${s.id}`, async () => {
        assert.equal((await call('POST', `/sales/${s.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        receipt.cleanup.push({ kind: 'sale', id: s.id, voided: true });
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
    receipt.cleanup.push({ kind: 'test-number', key, member: member ? 'EXISTS' : null });
    assert.equal(member, null, 'a walk-in leaves no member');
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
