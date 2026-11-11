// SCRUM-858 staging proof: a registered member with a verified rate sees only their own
// ticket type at the till. Adapted from the committed SCRUM-863 harness
// (docs/qa/proof-2026-11-12/SCRUM-863/staging/proof.mjs).
// Own ZZ TEST till, ZZ TEST members, invented numbers (08985800xx), cash only.
// No credential, pairing code or raw response body enters the receipt or the console.
//
//   node proof.mjs <sha> <out-dir> <passes>
//   passes: t  Thai: create, confirm at the till, return, one card, sale paid in cash   (points 1-3, 10)
//           x  Expat: create, passport to 2030, return, one card, Show all rates, Tourist (points 4-5)
//           w  walk-in with a fresh number                                                (point 6)
//           u  member created, nothing verified                                           (point 7)
//           r  regression: walk-in Tourist sale in cash; the drop-off form's number field (point 8)
//           m  phone-width till with a paired display: the Thai member's one card         (point 9)
//
// ZZ_BASE moves the invented numbers (08985800<base>..); each run asserts they are unused first.
//
// As run on 12 November 2026 against the till at d255250b: `ZZ_BASE=11 node proof.mjs <sha> out-01` (every point
// passed; receipt-run-01.json), then `ZZ_BASE=21 node proof.mjs <sha> out-02` with the taller pictures, the
// "customer display hidden" pictures and the paid screen's credit read added: the pictures and receipt.json
// beside this file are that second run's. The expired-document case needs a row changed in the database and is
// not produced here: apps/pos/e2e/member-tier.spec.ts and apps/pos/test/s858-member-tier-only.test.ts cover it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The repository root: five folders up from docs/qa/proof-<date>/SCRUM-858/staging, or OTO_REPO when run from elsewhere.
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const wanted = (process.argv[4] ?? 't,x,w,u,r,m').split(',');
const T = '858';
const base = Number(process.env.ZZ_BASE ?? 11);
const zz = i => '08985800' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const receipt = { ticket: `SCRUM-${T}`, sha, startedAt: new Date().toISOString(), phase: 'preflight',
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  passes: wanted, points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let response = await once();
  if (response.status() === 401) { receipt.checks.adminSignedInAgain = (receipt.checks.adminSignedInAgain ?? 0) + 1; await adminSignIn(); response = await once(); }
  const body = await response.json().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0], status: response.status(), ...(response.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: response.status(), body };
};

// ZZ TEST only; confirmed unused before use.
const numbers = { thai: zz(0), expat: zz(1), walkin: zz(2), plain: zz(3), sale: zz(4), dropoff: zz(5) };
receipt.numbers = numbers;
const RUN = String(process.argv[3] ?? 'out').replace(/\D/g, '') || '00';
const names = { thai: `ZZ TEST ${T} Thai`, expat: `ZZ TEST ${T} Expat`, plain: `ZZ TEST ${T} Plain` };
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const TIERS = ['Tourist', 'Expat', 'Thai'];
const knownSales = new Set();
let browser = null, till = null, display = null, station = null, branchId = null, failed = false, staffNames = [];

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
/** What is never to stand in a picture: the signed-in account's corner and name, passwords, pairing code, QR grids, band codes. */
const masks = page => [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
  page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
  page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/),
  ...staffNames.map(name => page.getByText(name, { exact: false }))];
const shot = async (page, name, extraMasks = []) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [...masks(page), ...extraMasks] });
  console.log('picture', name);
};
/** The same screen in a taller window, so a list the 900-high window scrolls is seen whole. Back to 1440 x 900 after. */
async function tallShot(name, height = 1500) {
  await till.setViewportSize({ width: 1440, height });
  await till.waitForTimeout(600);
  await shot(till, name);
  await till.setViewportSize({ width: 1440, height: 900 });
  await till.waitForTimeout(400);
}
/** The staff side alone ("Hide customer display"), pictured, then the split view again. */
async function staffOnlyShot(name) {
  const hide = till.getByText('Hide customer display', { exact: true });
  if (!(await hide.count())) return { taken: false };
  await hide.click();
  await till.getByText('Show customer display', { exact: true }).waitFor();
  await till.waitForTimeout(600);
  await shot(till, name);
  await till.getByText('Show customer display', { exact: true }).click();
  await till.getByText('Hide customer display', { exact: true }).waitFor();
  await till.waitForTimeout(400);
  return { taken: true };
}
const point = (key, pass, picture, shows, seen = {}) => { receipt.points[key] = { pass, picture, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); if (!pass) console.log('  seen', JSON.stringify(seen).slice(0, 1500)); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what, JSON.stringify(extra).slice(0, 600)); };

/** What the till itself wrote for a sale or a member (ZZ TEST numbers only), newest last. */
const tillWrites = [];
function watchWrites(page) {
  page.on('request', r => {
    if (r.method() === 'GET') return;
    const path = new URL(r.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id');
    if (!/^\/api\/(sales|members|checkin\/registrations)(\/|$)/.test(path)) return;
    let body = null; try { body = r.postDataJSON(); } catch { /* not json */ }
    const cart = body?.cart ?? body;
    tillWrites.push({ at: receipt.phase, method: r.method(), path,
      ...(path === '/api/sales' ? { tier: cart?.tier ?? cart?.customerTier ?? null, memberIdSent: Boolean(cart?.memberId), tierKeys: Object.keys(cart ?? {}).filter(k => /tier/i.test(k)) } : {}),
      ...(path === '/api/members' ? { phone: body?.phone ?? null } : {}),
      ...(/tier-verification$/.test(path) ? { toTier: body?.toTier ?? null, evidenceType: body?.evidenceType ?? null, evidenceExpiresAt: body?.evidenceExpiresAt ?? null } : {}),
      ...(/tier-approvals$/.test(path) ? { tier: body?.tier ?? body?.toTier ?? null, reason: body?.reason ?? null } : {}) });
  });
}

/** Console errors, page errors and refused api answers of a page, without bodies. */
function watch(page, label) {
  page.on('pageerror', e => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('console', m => { if (m.type() === 'error') receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'console.error', text: m.text().split('\n')[0].slice(0, 240) }); });
  page.on('response', r => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http',
      text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` });
  });
}

const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const newSales = async () => (await stationSales()).filter(s => !knownSales.has(s.id));
/** The half of the split view an element stands in. */
const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const paymentStep = () => till.getByTestId('payment-step');
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const typeStep = () => till.getByRole('heading', { name: 'Select Customer Type', exact: true });
const ticketStep = () => till.getByRole('heading', { name: 'Add to Sale', exact: true });
const showAll = () => till.getByRole('button', { name: 'Show all rates', exact: true });
const memberRate = () => till.getByText('Member rate applied', { exact: true });

/** The member's stored rate, as the till's own lookup reads it back. */
async function stored(number) {
  const member = (await call('GET', `/members/lookup?phone=${encodeURIComponent(number)}`)).body?.member ?? null;
  const v = member?.tierVerification ?? null;
  return member ? { found: true, nickname: member.nickname, tier: v?.tier ?? null, evidence: v?.evidenceType ?? v?.proofType ?? null, expires: v?.evidenceExpiresAt ?? v?.expiresAt ?? null, reverifyDue: v?.reverifyDue ?? null } : { found: false };
}

async function signInAtTill(page, phone, password) {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(phone.replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000; let steady = 0;
  while (Date.now() < deadline) {
    // Only on the picker: the till's own header carries a button with the station's name, which opens the picker.
    if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } steady = 0; }
    else if (await landing(page).isVisible()) { steady += 1; if (steady >= 6) break; } else steady = 0;
    await page.waitForTimeout(500);
  }
  await page.locator('a[href="/history"]').first().waitFor();
  await landing(page).waitFor({ timeout: 15000 }).catch(async () => { await page.goto('/'); await landing(page).waitFor(); });
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
  assert.match(pairingCode, /^\d{6}$/);
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: fixtureName });
  assert.equal(paired.status, 200);
  display = { context, page, id: paired.body.device.id, revoked: false };
  receipt.created.push({ kind: 'display', id: display.id }); save();
  await landing(page).waitFor();
}
async function dropDisplay(reason = `ZZ TEST SCRUM-${T} proof step complete`) {
  if (!display) return;
  const d = display;
  if (!d.revoked) {
    assert.equal((await call('POST', `/credentials/${d.id}/revoke`, { reason })).status, 200);
    d.revoked = true;
    receipt.cleanup.push({ kind: 'display', id: d.id, revoked: true }); save();
  }
  await d.context.close().catch(() => {});
  display = null;
}

/** A close picture of one element, with a little room around it. */
async function closeUp(page, locator, name, pad = 24) {
  try {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    const view = page.viewportSize();
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: masks(page),
      clip: { x, y, width: Math.min(view.width - x, box.width + 2 * pad), height: Math.min(view.height - y, box.height + 2 * pad) } });
    console.log('picture', name);
    return { width: Math.round(box.width), height: Math.round(box.height) };
  } catch (error) { return { failure: firstLine(error) }; }
}

/** The first screen on the customer half (or a paired display): language, the number on the keypad. */
async function firstScreen(surface, number) {
  await landing(surface).waitFor();
  if (await surface.getByTestId('language-choice').isVisible()) await surface.getByTestId('language-choice-en').click();
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await keypad(scope, number);
  return scope;
}
/** Number → Continue. Returns 'offer' when the "New member?" box opened, 'found' when the customer type step did. */
async function identify(number) {
  const scope = await firstScreen(till, number);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await offer.isVisible().catch(() => false)) { await expect(offer).toContainText(spaced(number)); return 'offer'; }
    if (await typeStep().isVisible().catch(() => false)) {
      // A returning member with saved children gets the visit dialog first; ours have none.
      return 'found';
    }
    await till.waitForTimeout(300);
  }
  throw new Error('neither the "New member?" box nor the customer type step opened');
}
async function createMember(number, name) {
  assert.equal(await identify(number), 'offer', 'a fresh number offers "New member?"');
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  await offer.getByPlaceholder('e.g. Mali').fill(name);
  await offer.getByRole('button', { name: 'Create member', exact: true }).click();
  await offer.waitFor({ state: 'hidden' });
  await typeStep().waitFor();
  receipt.created.push({ kind: 'member', name, number }); save();
}
async function walkIn(number) {
  assert.equal(await identify(number), 'offer', 'a fresh number offers "New member?"');
  await till.getByRole('dialog', { name: 'New member?', exact: true }).getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  await typeStep().waitFor();
}
/** What the customer type step shows, read from the page. */
async function typeStepState(page = till) {
  const cards = [];
  for (const name of TIERS) if (await page.getByRole('heading', { name, exact: true }).count() > 0 && await page.getByRole('heading', { name, exact: true }).first().isVisible()) cards.push(name);
  const text = flat(await page.locator('body').innerText());
  const selected = [];
  for (const name of cards) {
    const card = page.getByRole('heading', { name, exact: true }).first().locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
    if (/ring-2/.test(await card.getAttribute('class').catch(() => '') ?? '')) selected.push(name);
  }
  return { cards, selected, showAllRates: await page.getByRole('button', { name: 'Show all rates', exact: true }).count(),
    badge: text.match(/(Tourist|Expat|Thai) · verified/)?.[0] ?? (/No verified rate/.test(text) ? 'No verified rate' : /Walk-in \(no member\)/.test(text) ? 'Walk-in (no member)' : null),
    cardLines: [...text.matchAll(/([A-Z][A-Za-z ()]+ — no proof needed|Proof required — verify now)/g)].map(m => m[1]),
    reverify: /re-verify/.test(text),
    welcome: text.match(/Welcome back, [^!]+!|Welcome to Oto/)?.[0] ?? null,
    memberRateApplied: await page.getByText('Member rate applied', { exact: true }).count() };
}
/** Leave the sale from the till: the order panel's Cancel if it is there, else a reload (nothing is written before payment). */
async function cancelSale() {
  let how = 'reload';
  const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
  if (await cancel.isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    how = 'Cancel button';
    const back = await landing(till).waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!back) { how = 'Cancel button, then reload'; await till.goto('/'); }
  } else await till.goto('/');
  await landing(till).waitFor();
  return how;
}
/** The ticket step for the tier in force: the 1 Hour Play card as it reads, quantities, the order panel's total. */
async function ticketStepState() {
  await ticketStep().waitFor({ timeout: 20000 });
  const card = till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
  const half = halfOf(ticketStep());
  return { oneHourPlayCard: flat(await card.innerText().catch(() => '')).slice(0, 300), staffHalf: flat(await half.innerText().catch(() => '')).slice(0, 900) };
}
async function addTickets(kids, adults) {
  await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
  const quantity = async (label, target) => {
    const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
    const remove = till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
    const value = add.locator('xpath=preceding-sibling::span[1]');
    for (let count = 0; count < 8; count++) {
      const current = Number(await value.textContent());
      if (current === target) return;
      await (current < target ? add : remove).click();
      await till.waitForTimeout(200);
    }
    assert.equal(Number(await value.textContent()), target);
  };
  await quantity('Kids', kids); await quantity('Adults', adults);
  await till.waitForTimeout(800);
  const total = flat(await till.locator('div.font-bold.text-2xl').filter({ hasText: 'Total' }).first().innerText().catch(() => ''));
  return { orderPanelTotal: total };
}
const toPayment = async () => { await till.getByRole('button', { name: 'Continue', exact: true }).first().click(); };
async function saleWritten(kind) {
  let sale;
  await expect.poll(async () => { sale = (await newSales()).find(x => ['tendering', 'open'].includes(x.status)); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  receipt.created.push({ kind, id: sale.id }); save();
  return sale;
}
async function payCash() {
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click();
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
}
/** After "Payment Successful": give the print read time to land, then say what each half shows about credit. */
async function settlePaidScreen() {
  const staffCredit = till.getByRole('heading', { name: 'Credit Grants to Print', exact: true });
  await staffCredit.waitFor({ timeout: 12000 }).catch(() => {});
  await till.waitForTimeout(1500);
  const text = flat(await till.locator('body').innerText());
  return { staffSideCreditGrantsBlock: await staffCredit.count(), customerSideCreditGrants: (text.match(/Credit Grants(?! to Print)/g) ?? []).length,
    receiptLine: text.match(/Receipt Z\d{5}-\d+ • ฿[\d,.]+ • Cash/)?.[0] ?? null, bracelets: text.match(/\d× (Child|Adult) bracelets?/g) ?? [] };
}
/** The grants and print jobs a sale read names: kinds and amounts only. */
function grantFacts(read) {
  const list = v => Array.isArray(v) ? v : [];
  return { grants: list(read.grants ?? read.sale?.grants).map(g => ({ type: g.type ?? g.kind ?? null, amountSatang: g.amountSatang ?? g.valueSatang ?? null })),
    printJobs: list(read.printJobs).map(j => ({ kind: j.kind ?? j.type ?? j.role ?? null, status: j.status })) };
}
/** Every key of a sale read that speaks of the tier, with its value; and each line's label and price. */
function saleFacts(sale) {
  const tiers = {};
  const walk = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(value)) {
      if (/tier/i.test(k) && (typeof v === 'string' || v === null)) tiers[`${path}${k}`] = v;
      else if (typeof v === 'object') walk(v, `${path}${Array.isArray(value) ? '' : k + '.'}`, depth + 1);
    }
  };
  walk(sale, '', 0);
  return { id: sale.id, status: sale.status, receipt: sale.receiptNumber ?? null, grossSatang: sale.totals?.grossSatang ?? null, tierFields: tiers,
    lines: (sale.lines ?? []).map(l => ({ label: l.label ?? l.name ?? l.description ?? null, quantity: l.quantity ?? null, unit: l.unitPriceSatang ?? l.unitSatang ?? null, gross: l.grossSatang ?? l.totalSatang ?? null })) };
}
async function startNewSale() {
  const next = till.getByRole('button', { name: 'Start New Sale' });
  if (await next.isVisible().catch(() => false)) await next.click(); else await till.goto('/');
  await landing(till).waitFor();
}
/** Is the element's own text cut by its box? And where it stands. */
const fit = locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), textCut: el.scrollWidth > el.clientWidth + 1, text: (el.textContent ?? '').trim().slice(0, 60) }; });

// ---- pass t: the Thai member. Points 1, 2, 3 and the wording capture of point 10. ----
async function passThai() {
  const n = numbers.thai;
  phase('t: fresh number, create the member; every rate is offered');
  await till.goto('/');
  await createMember(n, names.thai);
  const first = await typeStepState();
  await shot(till, '01a-new-member-as-the-900-high-window-shows-it.png');
  await tallShot('01-new-member-all-three-cards.png');
  phase('t: tap Thai, the two-button confirmation');
  await till.getByRole('heading', { name: 'Thai', exact: true }).first().click();
  const dialog = till.getByRole('dialog', { name: 'Verify Thai rate' });
  await dialog.getByTestId('tier-confirm-step').waitFor();
  const buttons = (await dialog.getByTestId('tier-confirm-step').getByRole('button').allInnerTexts()).map(flat).filter(Boolean);
  const dialogSeen = { buttons, documentList: await dialog.getByText('Proof checked').count(), expiryField: await dialog.locator('#tier-evidence-expiry').count() };
  await shot(till, '01b-thai-two-button-confirmation.png');
  await dialog.getByRole('button', { name: 'Confirm Thai rate', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  await ticketStep().waitFor({ timeout: 20000 }).catch(() => {});
  await till.waitForTimeout(800);
  const afterConfirm = { onTicketStep: await ticketStep().isVisible().catch(() => false), stored: await stored(n) };
  await shot(till, '01c-thai-confirmed-ticket-step.png');
  const cancelled = await cancelSale();
  const ok1 = first.cards.join() === TIERS.join() && first.showAllRates === 0 && first.badge === 'No verified rate'
    && buttons.join('|') === 'Cancel|Confirm Thai rate' && dialogSeen.documentList === 0 && dialogSeen.expiryField === 0 && afterConfirm.stored.tier === 'thai';
  point('1', ok1, '01-new-member-all-three-cards.png', 'A new member (no verified rate) is offered Tourist, Expat and Thai; Thai is confirmed with the two-button dialog (01b) and the sale cancelled', { first, dialog: dialogSeen, afterConfirm, saleLeftBy: cancelled });

  phase('t: the same number again — one card');
  assert.equal(await identify(n), 'found');
  await expect(till.getByText('Thai · verified')).toBeVisible();
  await till.waitForTimeout(1200);
  const second = await typeStepState();
  // Layout at this width: the control, the card, the banner, the member's name, the staff panel.
  const thaiCard = till.getByRole('heading', { name: 'Thai', exact: true }).first().locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
  const banner = till.getByText('Thai · verified').locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]');
  const panel = halfOf(typeStep());
  const layout = { viewport: till.viewportSize(), control: await fit(showAll()), card: await fit(thaiCard), banner: await fit(banner), badge: await fit(till.getByText('Thai · verified')),
    name: await fit(banner.locator('div.font-bold.text-lg.truncate').first()), phone: await fit(banner.locator('div.text-sm.text-muted-foreground').first()), staffPanel: await fit(panel),
    cardLine: await fit(thaiCard.locator('p.text-emerald-600, p[class*="text-emerald"]').last()) };
  layout.controlInsidePanel = layout.control.right <= layout.staffPanel.right && layout.control.x >= layout.staffPanel.x;
  layout.controlBelowCard = layout.control.y >= layout.card.bottom;
  layout.controlOnScreen = layout.control.bottom <= layout.viewport.height;
  layout.badgeInsideBanner = layout.badge.right <= layout.banner.right;
  await shot(till, '02-returning-thai-member-one-card.png');
  receipt.checks.thaiCardWording = { line: second.cardLines, picture: '10a-thai-card-line-approved-by-hand.png', size: await closeUp(till, thaiCard, '10a-thai-card-line-approved-by-hand.png', 16) };
  receipt.checks.bannerAt1440 = { picture: '02b-banner-and-control-close.png', size: await closeUp(till, panel, '02b-banner-and-control-close.png', 0),
    staffSideAlone: { picture: '02c-same-screen-customer-display-hidden.png', ...(await staffOnlyShot('02c-same-screen-customer-display-hidden.png')) } };
  await expect(till.getByText('Thai · verified')).toBeVisible();
  const ok2 = second.cards.join() === 'Thai' && second.selected.join() === 'Thai' && second.badge === 'Thai · verified' && second.showAllRates === 1
    && second.welcome === `Welcome back, ${names.thai}!` && second.memberRateApplied >= 1
    && layout.controlInsidePanel && layout.controlBelowCard && layout.controlOnScreen && !layout.control.textCut && layout.badgeInsideBanner && layout.name.width > 30;
  if (layout.name.textCut) odd(`at ${layout.viewport.width} wide in the split view the member's name in the staff banner is cut with an ellipsis: ${layout.name.width}px of room for "${names.thai}" (the order panel and the customer half show it whole)`, { name: layout.name, phone: layout.phone, picture: '02b-banner-and-control-close.png' });
  if (layout.phone.textCut) odd(`at ${layout.viewport.width} wide the member's number in the staff banner is cut with an ellipsis`, { phone: layout.phone });
  point('2', ok2, '02-returning-thai-member-one-card.png', 'The same number again: only the Thai card, pre-selected, "Thai · verified", "Show all rates" under the card; the customer half greets the member and says "Member rate applied"', { second, layout });

  phase('t: tap the Thai card — the ticket step at Thai prices');
  await till.getByRole('heading', { name: 'Thai', exact: true }).first().click();
  const tickets = await ticketStepState();
  await till.waitForTimeout(600);
  await shot(till, '03a-thai-ticket-step-thai-prices.png');
  const mark = tillWrites.length;
  const built = await addTickets(1, 1);
  const rateSaid = await memberRate().count();
  await shot(till, '03b-thai-one-child-one-adult.png');
  await toPayment();
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  const sale = await saleWritten('thai-ticket-sale');
  await till.waitForTimeout(1200);
  await shot(till, '03c-thai-sale-payment-step.png');
  phase('t: pay cash');
  await payCash();
  const paidScreen = await settlePaidScreen();
  await shot(till, '03-thai-sale-paid-cash-receipt.png');
  const read = (await call('GET', `/sales/${sale.id}`)).body;
  const paid = read.sale;
  paidScreen.readKeys = Object.keys(read); paidScreen.grants = grantFacts(read);
  knownSales.add(sale.id);
  const facts = saleFacts(paid);
  const sent = tillWrites.slice(mark).filter(w => w.path === '/api/sales' && w.method === 'POST').at(-1) ?? null;
  receipt.checks.thaiSale = { ...facts, ticketCard: tickets.oneHourPlayCard, orderPanelTotal: built.orderPanelTotal, sentByTheTill: sent, paidScreen };
  const ok3 = paid.status === 'finalised' && rateSaid >= 1 && (Object.values(facts.tierFields).includes('thai') || sent?.tier === 'thai');
  point('3', ok3, '03-thai-sale-paid-cash-receipt.png', 'Tapping the one card opens the ticket step at the Thai prices (03a); one child and one adult paid in cash, the sale closes at the Thai rate', { tickets, built, memberRateSaidOnCustomerHalf: rateSaid, sale: facts, sentByTheTill: sent, storedAfter: await stored(n) });
  await startNewSale();
}

// ---- pass x: the Expat member. Points 4 and 5. ----
async function passExpat() {
  const n = numbers.expat;
  phase('x: fresh number, create the member, tap Expat, record a passport to 2030-01-01');
  await till.goto('/');
  await createMember(n, names.expat);
  const first = await typeStepState();
  await till.getByRole('heading', { name: 'Expat', exact: true }).first().click();
  const dialog = till.getByRole('dialog', { name: 'Verify Expat rate' });
  await dialog.getByText('Proof checked').waitFor();
  const choices = (await dialog.getByRole('button').allInnerTexts()).map(flat).filter(Boolean);
  await dialog.getByRole('button', { name: 'Passport', exact: true }).click();
  await dialog.locator('#tier-evidence-expiry').fill('2030-01-01');
  await till.waitForTimeout(300);
  await shot(till, '04a-expat-passport-expiry-2030.png');
  await dialog.getByRole('button', { name: /^Verify Expat — Passport$/ }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  await ticketStep().waitFor({ timeout: 20000 }).catch(() => {});
  await till.waitForTimeout(800);
  const afterVerify = { onTicketStep: await ticketStep().isVisible().catch(() => false), stored: await stored(n) };
  await shot(till, '04b-expat-verified-ticket-step.png');
  const cancelled = await cancelSale();
  phase('x: the same number again — one card');
  assert.equal(await identify(n), 'found');
  await expect(till.getByText('Expat · verified')).toBeVisible();
  await till.waitForTimeout(1200);
  const second = await typeStepState();
  await shot(till, '04-returning-expat-member-one-card.png');
  const ok4 = first.cards.join() === TIERS.join() && afterVerify.stored.tier === 'expat' && String(afterVerify.stored.expires ?? '').startsWith('2030-01-01')
    && second.cards.join() === 'Expat' && second.badge === 'Expat · verified' && second.showAllRates === 1;
  point('4', ok4, '04-returning-expat-member-one-card.png', 'Expat recorded on a passport valid to 2030-01-01 (04a); on the next lookup only the Expat card is offered', { first, choices, afterVerify, saleLeftBy: cancelled, second });

  phase('x: Show all rates — every card, the control gone');
  await showAll().click();
  await expect.poll(async () => (await typeStepState()).cards.join()).toBe(TIERS.join());
  await till.waitForTimeout(600);
  const all = await typeStepState();
  await shot(till, '05a2-show-all-rates-as-the-900-high-window-shows-it.png');
  await tallShot('05a-show-all-rates-three-cards.png');
  phase('x: tap Tourist — the ticket step at Tourist prices, no "Member rate applied"');
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  const tickets = await ticketStepState();
  await till.waitForTimeout(800);
  const rateAtGrid = await memberRate().count();
  await shot(till, '05b-tourist-prices-no-member-rate.png');
  await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
  await till.waitForTimeout(1200);
  const rateSaid = rateAtGrid + await memberRate().count();
  const customerHalf = flat(await till.locator('body').innerText()).match(/Welcome back, [^!]+!|Your Order|Building your order…/g) ?? [];
  await shot(till, '05c-tourist-one-child-one-adult-no-member-rate.png');
  const storedDuring = await stored(n);
  const cancelled2 = await cancelSale();
  phase('x: the same number once more — only Expat again');
  assert.equal(await identify(n), 'found');
  await expect(till.getByText('Expat · verified')).toBeVisible();
  await till.waitForTimeout(1200);
  const third = await typeStepState();
  await shot(till, '05-expat-member-again-one-card.png');
  const storedAfter = await stored(n);
  const ok5 = all.cards.join() === TIERS.join() && all.showAllRates === 0 && all.badge === 'Expat · verified' && rateSaid === 0
    && third.cards.join() === 'Expat' && third.showAllRates === 1 && storedDuring.tier === 'expat' && storedAfter.tier === 'expat';
  receipt.checks.touristTicketCard = tickets.oneHourPlayCard;
  point('5', ok5, '05-expat-member-again-one-card.png', '"Show all rates" brings the three cards back and the control goes (05a); Tourist opens the ticket step at Tourist prices and the customer half no longer says "Member rate applied" (05b); the next lookup shows only Expat again and the stored rate is still expat', { all, tickets, memberRateSaidAtTourist: rateSaid, customerHalf, storedDuring, saleLeftBy: cancelled2, third, storedAfter });
  await cancelSale();
}

// ---- pass w: a walk-in. Point 6. ----
async function passWalkIn() {
  phase('w: fresh number continued as a walk-in');
  await till.goto('/');
  await walkIn(numbers.walkin);
  await till.waitForTimeout(800);
  const seen = await typeStepState();
  await shot(till, '06a-walk-in-as-the-900-high-window-shows-it.png');
  await tallShot('06-walk-in-all-three-cards-no-control.png');
  point('6', seen.cards.join() === TIERS.join() && seen.showAllRates === 0 && seen.memberRateApplied === 0, '06-walk-in-all-three-cards-no-control.png', 'A fresh number continued as a walk-in: Tourist, Expat and Thai, no "Show all rates" control', seen);
  await cancelSale();
}

// ---- pass u: a member with nothing verified. Point 7. ----
async function passPlain() {
  const n = numbers.plain;
  phase('u: fresh number, create the member, verify nothing');
  await till.goto('/');
  await createMember(n, names.plain);
  const first = await typeStepState();
  await tallShot('07a-member-just-created-all-three-cards.png');
  await cancelSale();
  phase('u: the same number again — still every card');
  assert.equal(await identify(n), 'found');
  await expect(till.getByText('No verified rate')).toBeVisible();
  await till.waitForTimeout(800);
  const second = await typeStepState();
  await tallShot('07-unverified-member-all-three-cards.png');
  const ok = [first, second].every(s => s.cards.join() === TIERS.join() && s.showAllRates === 0 && s.badge === 'No verified rate' && s.memberRateApplied === 0) && (await stored(n)).tier === null;
  point('7', ok, '07-unverified-member-all-three-cards.png', 'A member with no verified rate, just created (07a) and found again: every card, "No verified rate", no control', { first, second });
  await cancelSale();
}

/** Age, then 1 January: the date-of-birth picker. */
async function setAge(page, scope, age) {
  await scope.getByRole('button', { name: /Tap to set age/ }).last().click();
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: String(age), exact: true }).click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /^Jan/ }).first().click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: '1', exact: true }).first().click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /Confirm/ }).click();
  await dialog.waitFor({ state: 'hidden' });
}

// ---- pass r: regression. Point 8. ----
async function passRegression() {
  phase('r: walk-in Tourist sale, one adult and one child, cash');
  await till.goto('/');
  await walkIn(numbers.sale);
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  const tickets = await ticketStepState();
  const mark = tillWrites.length;
  const built = await addTickets(1, 1);
  await toPayment();
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  const sale = await saleWritten('tourist-ticket-sale');
  await till.waitForTimeout(1000);
  // Point 10: the payment methods as the split view draws them at this width, and with the customer display hidden.
  const methodLabels = {};
  for (const m of ['Cash', 'Card', 'PromptPay']) { const h = till.getByRole('heading', { name: m, exact: true }).first(); if (await h.count()) methodLabels[m] = await h.evaluate(el => ({ width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height), lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) })); }
  const confirmBox = await fit(till.getByRole('button', { name: 'Confirm Payment Received', exact: true }));
  await shot(till, '10b-payment-step-split-view-1440.png');
  receipt.checks.paymentStepSplitView = { picture: '10b-payment-step-split-view-1440.png', methodLabels, confirmButton: confirmBox, confirmButtonBelowTheWindow: confirmBox.bottom > 900,
    staffSideAlone: { picture: '10c-payment-step-customer-display-hidden.png', ...(await staffOnlyShot('10c-payment-step-customer-display-hidden.png').catch(e => ({ failure: firstLine(e) }))) } };
  if (Object.values(methodLabels).some(l => l.lines > 1)) odd('payment step in the split view at 1440 wide: the method names break across lines (Ca/sh, Car/d, Pro/mp/tPa/y)', { methodLabels, picture: '10b-payment-step-split-view-1440.png' });
  await payCash();
  const paidScreen = await settlePaidScreen();
  await shot(till, '08-walk-in-tourist-sale-paid-cash.png');
  const read = (await call('GET', `/sales/${sale.id}`)).body;
  const paid = read.sale;
  paidScreen.readKeys = Object.keys(read); paidScreen.grants = grantFacts(read);
  knownSales.add(sale.id);
  const facts = saleFacts(paid);
  const sent = tillWrites.slice(mark).filter(w => w.path === '/api/sales' && w.method === 'POST').at(-1) ?? null;
  receipt.checks.touristSale = { ...facts, ticketCard: tickets.oneHourPlayCard, orderPanelTotal: built.orderPanelTotal, sentByTheTill: sent, paidScreen };
  await startNewSale();

  phase('r: a child with no adult — the drop-off form still asks the phone number (SCRUM-863)');
  await walkIn(numbers.dropoff);
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await ticketStep().waitFor();
  await addTickets(1, 0);
  const before = (await call('GET', `/checkin/registrations?branchId=${branchId}`)).body.registrations?.length ?? null;
  await toPayment();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const nameField = till.getByPlaceholder('Full name', { exact: true }).first();
  await nameField.waitFor();
  const half = halfOf(nameField);
  await nameField.fill(`ZZ TEST SCRUM-${T} child r${RUN}`);
  await setAge(till, half, 6);
  await half.getByPlaceholder('Your full name', { exact: true }).waitFor();
  const text = flat(await half.innerText());
  const tel = half.locator('input[type="tel"]');
  const form = { phoneNumberLabel: /Phone number/.test(text), numberFields: await tel.count(), fieldHolds: (await tel.count()) ? (await tel.first().inputValue()).replace(/^0/, '') === numbers.dropoff.slice(1) : null,
    channels: (await Promise.all(['WhatsApp', 'Telegram', 'LINE'].map(async c => (await half.getByTitle(c, { exact: true }).count()) ? c : null))).filter(Boolean) };
  await half.getByText('Phone number', { exact: true }).scrollIntoViewIfNeeded();
  await shot(till, '08b-dropoff-form-phone-number-field.png');
  // Nothing is written before "Continue to payment": Back, then leave the sale.
  await till.getByRole('button', { name: 'Back', exact: true }).first().click().catch(() => {});
  await till.waitForTimeout(500);
  const left = await cancelSale();
  const after = (await call('GET', `/checkin/registrations?branchId=${branchId}`)).body.registrations?.length ?? null;
  form.waitingRegistrationsBefore = before; form.waitingRegistrationsAfter = after; form.saleLeftBy = left;
  form.registrationsWrittenByTheTill = tillWrites.filter(w => /checkin\/registrations/.test(w.path)).length;
  const ok = paid.status === 'finalised' && form.phoneNumberLabel && form.numberFields === 1 && form.fieldHolds === true && form.channels.length === 3 && before === after && form.registrationsWrittenByTheTill === 0;
  point('8', ok, '08-walk-in-tourist-sale-paid-cash.png', 'A walk-in Tourist sale with one adult and one child is paid in cash; for a child with no adult the drop-off form still shows its phone number field with the three channels (08b), left without a registration', { sale: facts, sentByTheTill: sent, tickets, built, dropOffForm: form });
}

// ---- pass m: the phone-width till. Point 9. ----
async function passPhone() {
  const n = numbers.thai;
  phase('m: the till at phone width (390 x 844), a customer display paired to it');
  assert.equal((await stored(n)).tier, 'thai', 'the Thai member of pass t is the one looked up here');
  await till.setViewportSize({ width: 390, height: 844 });
  await till.goto('/');
  await typeStep().waitFor({ timeout: 30000 });
  await till.waitForTimeout(800);
  const before = await typeStepState();
  await shot(till, '09a-phone-till-before-lookup.png');
  await pairDisplay();
  const scope = await firstScreen(display.page, n);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(till.getByText('Thai · verified')).toBeVisible({ timeout: 30000 });
  await till.waitForTimeout(1200);
  const seen = await typeStepState();
  const control = await fit(showAll());
  const card = await fit(till.getByRole('heading', { name: 'Thai', exact: true }).first().locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]'));
  const banner = till.getByText('Thai · verified').locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]');
  const layout = { viewport: till.viewportSize(), control, card, banner: await fit(banner), badge: await fit(till.getByText('Thai · verified')), name: await fit(banner.locator('div.font-bold.text-lg.truncate').first()),
    pageScrollsSideways: await till.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1) };
  layout.controlInsideScreen = control.x >= 0 && control.right <= layout.viewport.width;
  layout.controlBelowCard = control.y >= card.bottom;
  await showAll().scrollIntoViewIfNeeded();
  await shot(till, '09-phone-till-thai-member-one-card.png');
  await shot(display.page, '09c-paired-display-welcome-member-rate.png');
  const displaySays = { welcome: flat(await display.page.locator('body').innerText()).match(/Welcome back, [^!]+!/)?.[0] ?? null, memberRate: await display.page.getByText('Member rate applied', { exact: true }).count() };
  if (layout.name.textCut || layout.name.width < 30) odd(`on the phone till (${layout.viewport.width} wide) the member's name in the banner has ${layout.name.width}px of room`, { name: layout.name, picture: '09-phone-till-thai-member-one-card.png' });
  phase('m: Show all rates on the phone till');
  await showAll().click();
  await expect.poll(async () => (await typeStepState()).cards.join()).toBe(TIERS.join());
  const all = await typeStepState();
  await shot(till, '09b-phone-till-show-all-rates.png');
  await till.getByRole('heading', { name: 'Thai', exact: true }).first().scrollIntoViewIfNeeded();
  await till.waitForTimeout(400);
  await shot(till, '09d-phone-till-show-all-rates-scrolled-to-thai.png');
  const ok = seen.cards.join() === 'Thai' && seen.showAllRates === 1 && seen.badge === 'Thai · verified' && layout.controlInsideScreen && !control.textCut && layout.controlBelowCard
    && all.cards.join() === TIERS.join() && all.showAllRates === 0 && (await stored(n)).tier === 'thai';
  point('9', ok, '09-phone-till-thai-member-one-card.png', 'The phone-width till (390 wide), number given on its paired display: only the Thai card with a readable "Show all rates"; pressing it brings the three cards back (09b)', { before, seen, layout, displaySays, all });
  await dropDisplay();
  await till.setViewportSize({ width: 1440, height: 900 });
  await till.goto('/'); await landing(till).waitFor();
}

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) {
      await shot(till, `failed-${key}-till.png`).catch(() => {});
      console.log('  till text:', flat(await till.locator('body').innerText().catch(() => '')).replace(new RegExp(staffNames.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '\\b\\B', 'g'), '[staff]').slice(0, 1800));
    }
    if (display) await shot(display.page, `failed-${key}-display.png`).catch(() => {});
    // Leave the pass: cancel what the payment step still holds, unpair, start clean.
    try {
      const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
      if (await paymentStep().isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) { await cancel.click(); await till.waitForTimeout(3000); }
    } catch { /* cleanup below reads the sales back */ }
    await dropDisplay().catch(() => {});
    await till.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await till.goto('/').catch(() => {});
  }
};

try {
  phase('sign in and create own till');
  await adminSignIn();
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
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  const fresh = wanted.includes('t') ? Object.values(numbers) : Object.entries(numbers).filter(([k]) => k !== 'thai').map(([, v]) => v);
  for (const phone of fresh) assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null, 'ZZ TEST number must be unused');
  receipt.checks.testNumbersUnusedBefore = true;
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  assert.equal(station.name, fixtureName);
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

  // The synthetic reception camera: one flat grey frame, nobody's picture.
  const video = resolve(import.meta.dirname, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  // A new browser profile: nothing cached, the bundle is fetched fresh. The split view at 1440 x 900.
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  watch(till, 'till');
  watchWrites(till);
  await till.goto(pos);
  phase('reception account signs in at the own till (new browser profile)');
  await signInAtTill(till, need('STAGING_RECEPTION_PHONE'), need('STAGING_RECEPTION_PASSWORD'));
  // The signed-in account's own name: covered wherever a picture would show it (the verify dialogs name who confirmed).
  const me = await (await till.request.get('/api/me')).json().catch(() => null);
  staffNames = [...new Set([me?.employee?.name, me?.employee?.nickname, me?.account?.name, me?.account?.nickname, me?.name, me?.nickname, me?.displayName, me?.account?.displayName]
    .filter(v => typeof v === 'string' && v.trim().length >= 2).map(v => v.trim()))];
  receipt.checks.staffNameMasks = staffNames.length;
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    const found = { files: urls.length, names: urls.map(u => u.split('/').pop().split('?')[0]), showAllRates: 0 };
    for (const url of urls) {
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      found.showAllRates += text.split('Show all rates').length - 1;
    }
    return found;
  });
  receipt.checks.served = await till.evaluate(async () => { const r = await fetch('/version.json', { cache: 'no-store' }).catch(() => null); if (!r || !r.ok) return null; const t = await r.text(); try { const j = JSON.parse(t); return Object.fromEntries(Object.entries(j).filter(([k]) => /sha|commit|version|built/i.test(k))); } catch { return null; } });
  save();
  console.log('bundle', JSON.stringify(receipt.checks.bundle), 'served', JSON.stringify(receipt.checks.served), 'staff name masks', staffNames.length);
  assert.ok(receipt.checks.bundle.showAllRates >= 1, 'the till serves the SCRUM-858 bundle');

  if (wanted.includes('t')) await attempt('t', passThai);
  if (wanted.includes('x')) await attempt('x', passExpat);
  if (wanted.includes('w')) await attempt('w', passWalkIn);
  if (wanted.includes('u')) await attempt('u', passPlain);
  if (wanted.includes('r')) await attempt('r', passRegression);
  if (wanted.includes('m')) await attempt('m', passPhone);
  receipt.passed = !failed && Object.values(receipt.points).every(v => v.pass === true);
} catch (error) {
  failed = true; receipt.passed = false; receipt.failure = { phase: receipt.phase, failure: firstLine(error) };
  console.log('RUN FAILED', '|', receipt.phase, '|', firstLine(error));
  if (till) await shot(till, 'failed-run-till.png').catch(() => {});
} finally {
  phase('clean up');
  const clean = async (step, action) => {
    try { await action(); }
    catch (error) { failed = true; (receipt.cleanupFailures ??= []).push({ step, failure: firstLine(error) }); console.log('CLEANUP FAILED', step, '|', firstLine(error)); }
    save();
  };
  await clean('unpair customer display', () => dropDisplay(`ZZ TEST SCRUM-${T} proof complete`));
  let ownsStation = false;
  if (station) {
    await clean('verify own till', async () => {
      const own = (await call('GET', `/stations/${station.id}`)).body.station;
      assert.equal(own.name, fixtureName); ownsStation = true;
    });
    if (ownsStation) {
      await clean('no waiting registration of this proof', async () => {
        const waiting = (await call('GET', `/checkin/registrations?branchId=${branchId}`)).body.registrations ?? [];
        const own = waiting.filter(r => /^ZZ TEST SCRUM-858/.test(r.guardianName ?? '') || (r.children ?? []).some(c => /^ZZ TEST SCRUM-858/.test(c.childName ?? '')));
        receipt.cleanup.push({ kind: 'waiting-registrations', ofThisProof: own.length });
        assert.equal(own.length, 0);
      });
      let sales = [];
      await clean('read own sales', async () => {
        sales = await stationSales();
        assert.ok(Array.isArray(sales));
        for (const sale of sales) assert.equal(sale.stationId, station.id);
      });
      // Only this run's own till, created minutes ago: nothing older than today can be here.
      for (const sale of sales.filter(s => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
        assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        assert.equal((await call('GET', `/sales/${sale.id}`)).body.sale.status, 'voided');
        receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided', by: 'cleanup' });
      });
      for (const { id } of sales.filter(s => s.status === 'finalised')) await clean(`print ${id}`, async () => {
        let jobs;
        await expect.poll(async () => { jobs = (await call('GET', `/sales/${id}`)).body.printJobs; return jobs.every(j => j.status === 'printed'); }, { timeout: 60000 }).toBe(true);
        receipt.cleanup.push({ kind: 'finalised-test-sale', id, retained: true, printJobs: jobs.map(j => ({ id: j.id, status: j.status })) });
      });
      await clean('final sales read-back', async () => {
        const final = await stationSales();
        receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map(s => ({ id: s.id, status: s.status, grossSatang: s.totals?.grossSatang ?? null })) });
        assert.ok(final.every(s => ['finalised', 'voided'].includes(s.status)));
      });
      await clean('retire own till', async () => {
        assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
        assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
        const retired = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === station.id);
        assert.ok(retired.archived); assert.equal(retired.devices.length, 0);
        receipt.cleanup.push({ kind: 'station', id: station.id, archived: true, devices: 0 });
      });
    }
  }
  for (const [key, phone] of Object.entries(numbers)) await clean(`check test number ${key}`, async () => {
    if (key === 'thai' && process.env.KEEP_THAI === '1') { receipt.cleanup.push({ kind: 'member', key, keptForALaterPass: true }); return; }
    const member = (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member;
    if (member) {
      assert.ok(`${member.nickname ?? ''} ${member.name ?? ''}`.includes(`ZZ TEST ${T}`), 'only own named test members');
      assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
      assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null);
      receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true });
    } else receipt.cleanup.push({ kind: 'test-number', key, member: null });
  });
  if (till) await clean('sign out till', async () => {
    const before = (await till.request.get('/api/me')).status();
    if (before === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    const me = await till.request.get('/api/me'); assert.equal(me.status(), 401);
    receipt.cleanup.push({ kind: 'till-session', signedInBefore: before === 200, signedOut: true, me: 401 });
  });
  await clean('sign out admin', async () => {
    if ((await admin.get('/api/me')).status() === 200) assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await admin.get('/api/me')).status(), 401);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true, me: 401 });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.pass])), odd: receipt.odd.length, pageErrors: receipt.pageErrors.length, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
