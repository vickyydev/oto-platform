// SCRUM-886 staging proof: a waiting, unpaid drop-off booking from an earlier day (or today) can be
// cancelled from the Check-in board's Drop-off -> Upcoming list (desk till and phone till).
// Adapted from the committed SCRUM-862 harness (docs/qa/proof-2026-11-12/SCRUM-862/staging/proof.mjs).
// Own ZZ TEST till, ZZ TEST guardians and children, invented numbers (08988600xx), cash only.
// Cancels ONLY families whose guardian and every child name start with "ZZ TEST": this run's own bookings,
// and earlier-day ZZ TEST leftovers (reason "ZZ TEST leftover"). Every other family is never touched and is
// covered in every picture; its names and numbers are held in memory for masking only, never written or printed.
// No credential, pairing code or raw response body enters the receipt or the console.
//
//   node proof.mjs <sha> <out-dir>
// ZZ_BASE moves the invented numbers (08988600<base>..); the run asserts they are unused first.
// ONLY=<points> runs a subset (e.g. ONLY=1). KEEP_FOR_PHONE=<guardian name> keeps one earlier-day leftover for point 5.
// ONLY=r is the picture retake (whole cards of two refused families, the phone flow on today's own booking d);
// RETAKE_PHONE=0 leaves the phone part out.
//
// Runs on 12 November 2026, sha b627077e86c5085af7ba7ca52dd3277e452aae03 (receipts beside this file):
//   01, 02  ONLY=1                      read-only dry runs of point 1. Run 01's masks covered every card (a family that is
//                                       not ZZ TEST is named just "Test", which matched every "ZZ TEST" card); a string
//                                       that also stands inside a ZZ TEST text is now left to the whole-card mask. Tills
//                                       Z88601, Z88602 retired, nothing else made.
//   03      ONLY=1,2,3,4,5              the proof, points 1-5 PASS (receipt-run-03.json): 8 cancels — 7 earlier-day ZZ TEST
//                                       leftovers ("ZZ TEST leftover") and this run's own booking c. Till Z88603 retired.
//   04      ONLY=r ZZ_BASE=13           retake with the board-only card masks below (receipt-run-04-retake.json). Till Z88604.
//   05      ONLY=r RETAKE_PHONE=0 ZZ_BASE=16  the four-child card on a taller board (receipt-run-05-retake.json). Till Z88605.
// Run 03 used the first card masks (any rounded, card-coloured element): besides the cards they also covered the till
// form's Back / Continue to payment buttons (03a) and the phone family screen's big buttons (05b). Runs 04-05 use the
// board-only masks (deskCards / phoneCards below).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const T = '886';
const base = Number(process.env.ZZ_BASE ?? 10);
const zz = i => '08988600' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const LEFTOVER_REASON = 'ZZ TEST leftover';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const receipt = { ticket: `SCRUM-${T}`, sha, startedAt: new Date().toISOString(), phase: 'preflight',
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  points: {}, requests: [], created: [], cancelled: [], checks: {}, odd: [], pageErrors: [], cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let response = await once();
  if (response.status() === 401) { receipt.checks.adminSignedInAgain = (receipt.checks.adminSignedInAgain ?? 0) + 1; await adminSignIn(); response = await once(); }
  const body = await response.json().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), status: response.status(), ...(response.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: response.status(), body };
};

// ZZ TEST only; confirmed unused before use. One number per walk-in.
const numbers = { bookC: zz(0), bookB: zz(1), spare: zz(2) };
receipt.numbers = numbers;
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const childName = tag => `ZZ TEST ${T} child ${tag}`;
const guardianName = tag => `ZZ TEST ${T} guardian ${tag}`;
const isZz = s => /^ZZ TEST/.test(String(s ?? '').trim());
const knownSales = new Set();
let browser = null, till = null, station = null, branchId = null, failed = false, meId = null;
const regs = {}; // tag -> { id, stayIds }

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
const dayOf = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(iso));

// ---- the board as the platform holds it, and what is never to stand in a picture ----
let hidden = []; // names and numbers of families that are not ZZ TEST, nannies, the till's account: memory only
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const familyAllZz = f => isZz(f.guardianName) && f.children.every(c => isZz(c.childName)) && (f.checkedInChildNames ?? []).every(isZz);
async function boardApi() {
  const board = (await call('GET', `/checkin/board?branchId=${branchId}`)).body;
  const keep = new Set();
  for (const f of board.families) {
    for (const n of [f.guardianName, ...f.children.map(c => c.childName), ...(f.checkedInChildNames ?? [])]) if (n && !isZz(n) && n.trim().length >= 2) keep.add(n.trim());
    if (!familyAllZz(f) && f.guardianPhone) { const p = f.guardianPhone; keep.add(p); keep.add(p.replace(/^\+66/, '0')); }
  }
  for (const n of board.nannies ?? []) if (n.name && !isZz(n.name)) keep.add(n.name.trim());
  for (const n of staffNames) keep.add(n);
  // A family that is not ZZ TEST yet carries a ZZ TEST name (mixed) keeps every string; otherwise a string that
  // also stands inside a ZZ TEST name (a nickname such as the test's own) is left to the whole-card masks.
  const mixed = board.families.filter(f => !familyAllZz(f) && [f.guardianName, ...f.children.map(c => c.childName)].some(isZz));
  receipt.checks.mixedFamilies = mixed.length;
  const zzText = ['zz test', fixtureName, ...board.families.filter(familyAllZz).flatMap(f => [f.guardianName, ...f.children.map(c => c.childName)]),
    ...(board.nannies ?? []).map(n => n.name).filter(isZz)].join(' | ').toLowerCase();
  const inZz = s => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u').test(zzText);
  // A string that also stands inside a ZZ TEST text (a family named just "Test") would cover every ZZ TEST card: it is
  // left to the whole-card mask (a card without "ZZ TEST"). Mixed families sit only on tabs this run never pictures unsearched.
  hidden = [...keep].filter(s => s.length >= 2 && !inZz(s)).sort((a, b) => b.length - a.length);
  receipt.checks.masking = { strings: hidden.length, leftToCardMasks: [...keep].filter(s => s.length >= 2 && inZz(s)).length, mixedFamilyTabs: mixed.map(f => f.tab) };
  return board;
}
let staffNames = [];
/** The board's families as the till's card logic sees them: waiting, paid, checked-in, the cancel offered or not. */
function classify(board) {
  const today = dayOf(new Date().toISOString());
  return board.families.filter(f => f.children.some(c => c.status === 'registered')).map(f => {
    const waiting = f.children.filter(c => c.status === 'registered');
    const paidWaiting = waiting.filter(c => c.paidOnline || c.paidAtTill).length;
    const inPark = f.children.some(c => c.status === 'in_park');
    const settled = [...new Set([...f.children.filter(c => c.status === 'out').map(c => c.childName), ...(f.checkedInChildNames ?? [])])];
    const offered = waiting.length > 0 && !inPark && paidWaiting < waiting.length; // the button is drawn
    const enabled = offered && settled.length === 0 && paidWaiting === 0;
    return { id: f.registrationId, zz: familyAllZz(f), guardian: f.guardianName, phone: f.guardianPhone ?? '', children: f.children.map(c => c.childName),
      waiting: waiting.length, paidWaiting, inPark, settled: settled.length, offered, enabled, tab: f.tab,
      bookedFor: [...new Set(waiting.map(c => c.bookedForDate ?? null))], earlier: waiting.every(c => c.bookedForDate && c.bookedForDate < today), today };
  });
}
const publicRow = r => r.zz ? { id: r.id, guardian: r.guardian, children: r.children, waiting: r.waiting, paidWaiting: r.paidWaiting, settled: r.settled, offered: r.offered, enabled: r.enabled, bookedFor: r.bookedFor, earlier: r.earlier }
  : { zz: false, waiting: r.waiting, paidWaiting: r.paidWaiting, settled: r.settled, offered: r.offered, enabled: r.enabled, bookedFor: r.bookedFor, earlier: r.earlier };

// The board's family cards only: the desk grid's cards (FamilyCheckInCard) and the phone list's cards (MobileChildCard).
// Run 03 matched any rounded card-coloured element, which also covered the till form's Back / Continue to payment
// buttons and the phone family screen's big buttons; run 04 (the retake) uses these.
const deskCards = page => page.locator('div.grid.gap-3 > div[class*="bg-card/50"]');
const phoneCards = page => page.locator('div.space-y-2 > button[class*="rounded-2xl"]');
const masks = page => {
  const re = hidden.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${hidden.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  return [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
    page.getByTestId('display-pairing-code'), page.locator('canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
    page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/),
    deskCards(page).filter({ hasNotText: 'ZZ TEST' }), phoneCards(page).filter({ hasNotText: 'ZZ TEST' }),
    page.getByText(/^(Nannies free now|Free nannies):/),
    ...(re ? [deskCards(page).filter({ hasText: re }), phoneCards(page).filter({ hasText: re }), page.getByText(re)] : [])];
};
const shot = async (page, name, extra = []) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [...masks(page), ...extra] });
  console.log('picture', name);
  return name;
};
const point = (key, pass, picture, shows, seen = {}) => { receipt.points[key] = { pass, picture, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what); };

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
const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const paymentStep = () => till.getByTestId('payment-step');
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };

async function signInAtTill(page, phone, password) {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(phone.replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(password);
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

/** The first screen on the till's customer half: language, the number, Continue, walk-in. */
async function walkIn(number) {
  await till.goto('/');
  await landing(till).waitFor();
  if (await till.getByTestId('language-choice').isVisible()) await till.getByTestId('language-choice-en').click();
  await till.getByTestId('identify-safety').waitFor();
  const scope = halfOf(till.getByTestId('identify-safety'));
  await keypad(scope, number);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  await expect(offer).toContainText(spaced(number));
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
}
async function ticket(kids, adults) {
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
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
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
}
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
async function payCash() {
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click();
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
}
async function saleWritten(kind) {
  let sale;
  await expect.poll(async () => { sale = (await newSales()).find(x => ['tendering', 'open'].includes(x.status)); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  receipt.created.push({ kind, id: sale.id }); save();
  return sale;
}
const registrationOf = async id => (await call('GET', '/checkin/registrations/' + id)).body;

/** A walk-in, one child aged 6 and no adult, the drop-off form filled on the customer half, Continue to payment. */
async function dropOffBooking(tag, number, picture) {
  await walkIn(number);
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const nameField = till.getByPlaceholder('Full name', { exact: true }).first();
  await nameField.waitFor();
  const half = halfOf(nameField);
  await nameField.fill(childName(tag));
  await setAge(till, half, 6);
  await half.getByPlaceholder('Your full name', { exact: true }).waitFor();
  await half.getByPlaceholder('Your full name', { exact: true }).fill(guardianName(tag));
  await half.getByRole('button', { name: 'Start camera', exact: true }).click();
  await half.getByRole('button', { name: 'Take photo', exact: true }).click();
  await half.getByAltText('Captured', { exact: true }).waitFor();
  for (const checkbox of await half.getByRole('checkbox').all()) await checkbox.check();
  if (picture) await shot(till, picture);
  const [registered] = await Promise.all([
    till.waitForResponse(r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST'),
    till.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  const reg = await registered.json().catch(() => null);
  assert.equal(registered.status(), 200, 'the registration is written');
  regs[tag] = { id: reg.id, stayIds: reg.children.map(c => c.id) };
  receipt.created.push({ kind: 'registration', tag, id: reg.id, stays: regs[tag].stayIds }); save();
  const sale = await saleWritten(`dropoff-sale-${tag}`);
  return { reg, sale };
}
/** The family leaves before paying: the till's Cancel on the payment step voids the sale; the signed form stays waiting. */
async function leaveUnpaid(sale) {
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  let how = 'till Cancel';
  const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
  if (await cancel.isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) { await cancel.click(); await till.waitForTimeout(3000); }
  else how = 'no Cancel on the payment step';
  let now = (await call('GET', `/sales/${sale.id}`)).body.sale;
  if (now.status !== 'voided') {
    how += ` (sale still ${now.status}; voided through the api as the harness cleanup does)`;
    assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} family left before paying` })).status, 200);
    now = (await call('GET', `/sales/${sale.id}`)).body.sale;
  }
  knownSales.add(sale.id);
  return { how, saleStatus: now.status };
}

// ---- the desk board ----
const search = page => page.getByPlaceholder('Search child, parent or phone…');
const upcomingTab = page => page.getByRole('button', { name: /^Upcoming\s*\d+$/ }).first();
const upcomingCount = async page => Number(flat(await upcomingTab(page).innerText()).match(/(\d+)$/)[1]);
const tabCounts = async page => Object.fromEntries(await Promise.all(['Upcoming', 'In Park', 'Out'].map(async l => [l, Number(flat(await page.getByRole('button', { name: new RegExp(`^${l}\\s*\\d+$`) }).first().innerText()).match(/(\d+)$/)[1])])));
async function openDeskBoard() {
  await till.goto('/');
  await till.getByRole('button', { name: 'Check-in', exact: true }).click();
  await search(till).waitFor({ timeout: 20000 });
  const dropOff = till.getByRole('button', { name: 'Drop-off', exact: true }).first();
  if (await dropOff.isVisible().catch(() => false)) await dropOff.click();
  await upcomingTab(till).click();
  await till.waitForTimeout(2500); // the board is read from the platform when it opens
}
async function searchBoard(page, q) {
  await search(page).fill(q);
  await page.waitForTimeout(1200);
}
/** What a card in view says: its name line, booked-for line, the Cancel booking button, the refusal line. */
const BOOKED_FOR = /Booked for \d{1,2} [A-Z][a-z]{2}( \d{4})?(, \d{1,2} [A-Z][a-z]{2}( \d{4})?)*/;
async function cardFacts(card) {
  const text = flat(await card.innerText());
  const button = card.getByRole('button', { name: 'Cancel booking', exact: true });
  const line = card.locator('p').filter({ hasText: /handled through its sale|off this sale first/ });
  return { bookedFor: (text.match(BOOKED_FOR) ?? [null])[0], cancelButtons: await button.count(),
    cancelEnabled: (await button.count()) ? await button.first().isEnabled() : null,
    refusal: (await line.count()) ? flat(await line.first().innerText()) : null };
}
/**
 * Cancel one family from a board in view by its guardian name: only when every family the search shows with an
 * enabled Cancel booking is one of `allowed` (earlier-day ZZ TEST leftovers, or this run's own booking).
 */
async function cancelFromBoard(page, cards, guardian, allowed, reason, pictures = {}) {
  const board = await boardApi();
  const q = guardian.toLowerCase();
  // The board's own search (DropOff.tsx visibleFamilies): any child's "<child> <parent> <phone>" holds the text; Upcoming tab only.
  const shown = classify(board).filter(r => r.tab === 'registered' && r.children.some(cn => `${cn} ${r.guardian} ${r.phone}`.toLowerCase().includes(q)));
  const enabled = shown.filter(r => r.enabled);
  assert.ok(enabled.length >= 1, `a family named ${guardian} with Cancel booking enabled is on the board`);
  assert.ok(enabled.every(r => allowed.has(r.id) && r.zz), `every family the search for ${guardian} shows with Cancel booking enabled is allowed and ZZ TEST`);
  await searchBoard(page, guardian);
  const buttons = [];
  for (const b of await page.getByRole('button', { name: 'Cancel booking', exact: true }).all()) if (await b.isVisible() && await b.isEnabled()) buttons.push(b);
  assert.equal(buttons.length, enabled.length, 'the till shows Cancel booking enabled on exactly the families the platform says');
  const before = await upcomingCount(page).catch(() => null);
  if (pictures.card) await pictures.card();
  await buttons[0].click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Cancel this waiting booking' });
  await dialog.waitFor();
  const press = dialog.getByRole('button', { name: /reason to cancel|Cancel the booking/ });
  const seen = { description: flat(await dialog.locator('p').first().innerText()).slice(0, 300), beforeReason: { label: flat(await press.innerText()), enabled: await press.isEnabled() } };
  assert.ok(seen.description.startsWith(`${guardian}'s booking:`), 'the confirm names the family being cancelled');
  if (pictures.empty) await shot(page, pictures.empty);
  await dialog.getByLabel('Reason').fill(reason);
  seen.afterReason = { label: flat(await press.innerText()), enabled: await press.isEnabled() };
  if (pictures.typed) await shot(page, pictures.typed);
  const [answer] = await Promise.all([
    page.waitForResponse(r => /\/api\/checkin\/registrations\/[^/]+\/cancel$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Cancel the booking' }).click(),
  ]);
  const id = new URL(answer.url()).pathname.split('/').at(-2);
  seen.answer = answer.status(); seen.registrationId = id;
  assert.ok(allowed.has(id), 'the cancelled booking is one of the allowed');
  await expect(dialog).toBeHidden({ timeout: 20000 });
  await page.waitForTimeout(2500);
  const reg = await registrationOf(id);
  seen.after = { guardianZz: isZz(reg.guardianName), children: reg.children.map(c => ({ zz: isZz(c.childName), status: c.status })), consentKept: Boolean(reg.consentRecordedAt) };
  seen.upcomingBefore = before; seen.upcomingAfter = await upcomingCount(page).catch(() => null);
  receipt.cancelled.push({ id, guardian, reason, status: seen.answer, children: seen.after.children.map(c => c.status), from: pictures.from ?? 'desk board', at: new Date().toISOString() }); save();
  return seen;
}

// ---- 1: the board's Upcoming tab now ----
let eligible = []; // earlier-day ZZ TEST families with Cancel booking enabled, read at point 1
async function point1() {
  phase('1: the board\'s Upcoming tab before this run changes anything');
  const board = await boardApi();
  const rows = classify(board);
  receipt.checks.boardBefore = { counts: board.counts, families: rows.length, zz: rows.filter(r => r.zz).map(publicRow), notZz: rows.filter(r => !r.zz).map(publicRow) };
  eligible = rows.filter(r => r.zz && r.earlier && r.enabled);
  save();
  await openDeskBoard();
  await till.setViewportSize({ width: 1680, height: 4300 });
  await till.waitForTimeout(1500);
  const seen = { tabs: await tabCounts(till), platform: board.counts, families: rows.length, zzFamilies: rows.filter(r => r.zz).length, notZzFamilies: rows.filter(r => !r.zz).length,
    zzEarlierEnabled: eligible.length, zzEarlierNotEnabled: rows.filter(r => r.zz && r.earlier && !r.enabled).length };
  await shot(till, '01a-board-upcoming-now-other-families-masked.png');
  await searchBoard(till, 'ZZ TEST');
  const zzCards = deskCards(till).filter({ hasText: 'ZZ TEST' });
  seen.zzCardsShown = await zzCards.count();
  seen.cardsWithBookedFor = await deskCards(till).filter({ hasText: BOOKED_FOR }).count();
  seen.zzFamiliesForAnotherDay = rows.filter(r => r.zz && r.bookedFor.some(Boolean)).length;
  await shot(till, '01b-board-upcoming-zz-test-leftovers-booked-for.png');
  await till.setViewportSize({ width: 1680, height: 1100 });
  const pick = eligible.find(r => r.guardian === 'ZZ TEST Walkin Guardian 496') ?? eligible[0];
  assert.ok(pick, 'an earlier-day ZZ TEST family with Cancel booking enabled is on the board');
  await searchBoard(till, pick.guardian);
  const card = deskCards(till).filter({ hasText: pick.guardian }).filter({ has: till.getByRole('button', { name: 'Cancel booking' }) }).last();
  seen.picked = { guardian: pick.guardian, children: pick.children, bookedFor: pick.bookedFor, card: await cardFacts(card) };
  await card.screenshot({ path: resolve(out, '01c-earlier-day-leftover-card-booked-for-cancel-booking.png'), animations: 'disabled', mask: masks(till) });
  console.log('picture', '01c-earlier-day-leftover-card-booked-for-cancel-booking.png');
  receipt.checks.pick = pick.id;
  const ok = seen.tabs.Upcoming === board.counts.registered && seen.cardsWithBookedFor === seen.zzFamiliesForAnotherDay && seen.zzCardsShown === seen.zzFamilies && seen.picked.card.cancelEnabled === true && Boolean(seen.picked.card.bookedFor);
  point('1', ok, '01b-board-upcoming-zz-test-leftovers-booked-for.png', `Upcoming ${seen.tabs.Upcoming} children in ${rows.length} families (${seen.zzFamilies} ZZ TEST, ${seen.notZzFamilies} not, masked); every earlier-day card says "Booked for <day>"; ${eligible.length} ZZ TEST leftovers have Cancel booking enabled`, seen);
  return pick;
}

// ---- 2: cancel one earlier-day leftover, then clear the rest ----
async function point2(pick) {
  phase('2: Cancel booking on one earlier-day ZZ TEST leftover from the board');
  await openDeskBoard();
  const allowed = new Set([pick.id]);
  const before = await upcomingCount(till);
  const seen = await cancelFromBoard(till, deskCards, pick.guardian, allowed, LEFTOVER_REASON, {
    empty: '02a-board-cancel-dialog-reason-empty-disabled.png', typed: '02b-board-cancel-dialog-reason-typed.png' });
  await searchBoard(till, pick.guardian);
  seen.cardsLeftForName = await deskCards(till).filter({ hasText: pick.guardian }).count();
  await shot(till, '02c-board-after-cancel-card-gone-upcoming-count.png');
  await searchBoard(till, '');
  seen.upcomingBeforeNoSearch = before;
  await expect.poll(() => upcomingCount(till), { timeout: 15000 }).toBe(before - pick.waiting).catch(() => {});
  seen.upcomingAfterNoSearch = await upcomingCount(till);
  const ok = seen.answer === 200 && !seen.beforeReason.enabled && /reason/i.test(seen.beforeReason.label) && seen.afterReason.enabled && seen.afterReason.label === 'Cancel the booking'
    && seen.after.children.every(c => c.status === 'cancelled') && seen.cardsLeftForName === 0 && seen.upcomingAfterNoSearch === before - pick.waiting;
  point('2', ok, '02c-board-after-cancel-card-gone-upcoming-count.png', `"${pick.guardian}" (booked for ${pick.bookedFor.join(', ')}): reason empty -> "${seen.beforeReason.label}" disabled; "${LEFTOVER_REASON}" -> "Cancel the booking"; 200, the card left and Upcoming went ${before} -> ${seen.upcomingAfterNoSearch} (${pick.waiting} child)`, seen);
}
async function clearLeftovers(keepGuardian) {
  phase('2b: clear the remaining earlier-day ZZ TEST leftovers from the board');
  await openDeskBoard();
  const cleared = [], skipped = [];
  for (let round = 0; round < 20; round++) {
    const rows = classify(await boardApi());
    const left = rows.filter(r => r.zz && r.earlier && r.enabled && r.guardian !== keepGuardian && !skipped.some(s => s.id === r.id));
    if (!left.length) break;
    const next = left[0];
    // Only the families this search can show with an enabled button, and only when all of them are earlier-day ZZ TEST.
    const allowed = new Set(rows.filter(r => r.zz && r.earlier && r.enabled && r.guardian !== keepGuardian).map(r => r.id));
    try {
      const seen = await cancelFromBoard(till, deskCards, next.guardian, allowed, LEFTOVER_REASON);
      cleared.push({ id: seen.registrationId, guardian: next.guardian, bookedFor: next.bookedFor, waiting: next.waiting, answer: seen.answer, children: seen.after.children.map(c => c.status) });
    } catch (error) {
      skipped.push({ id: next.id, guardian: next.guardian, why: firstLine(error) });
      odd(`a leftover was not cleared from the board: ${next.guardian}`, { failure: firstLine(error) });
      await till.keyboard.press('Escape').catch(() => {});
    }
    save();
  }
  const rows = classify(await boardApi());
  receipt.checks.clearing = { cleared, skipped, after: { zz: rows.filter(r => r.zz).map(publicRow), notZz: rows.filter(r => !r.zz).map(publicRow) } };
  await till.setViewportSize({ width: 1680, height: 3400 });
  await searchBoard(till, 'ZZ TEST');
  await shot(till, '02d-board-zz-test-after-clearing-only-paid-or-checked-in-left.png');
  await searchBoard(till, '');
  await shot(till, '02e-board-upcoming-after-clearing-other-families-masked.png');
  await till.setViewportSize({ width: 1680, height: 1100 });
  save();
  return { cleared, skipped, rows };
}

// ---- 4b: earlier-day ZZ TEST families the board will not cancel ----
async function refusalsOnBoard() {
  phase('4b: earlier-day ZZ TEST families with a paid or checked-in child');
  await openDeskBoard();
  const rows = classify(await boardApi()).filter(r => r.zz && r.earlier && !r.enabled);
  const seen = [];
  let i = 0;
  for (const r of rows) {
    await searchBoard(till, r.guardian);
    const cards = deskCards(till).filter({ hasText: r.guardian });
    const n = await cards.count();
    const facts = [];
    for (let k = 0; k < n; k++) facts.push(await cardFacts(cards.nth(k)));
    const file = `04-earlier-day-${String.fromCharCode(97 + i++)}-${r.paidWaiting ? 'paid' : 'checked-in'}-${r.offered ? 'cancel-disabled' : 'no-cancel'}.png`;
    await shot(till, file);
    seen.push({ guardian: r.guardian, bookedFor: r.bookedFor, waiting: r.waiting, paidWaiting: r.paidWaiting, settled: r.settled, platformOffered: r.offered, cards: facts, picture: file });
  }
  receipt.checks.refusalsOnBoard = seen; save();
  return seen;
}

// ---- 3: today's waiting booking, no Booked for line, cancelled from the board ----
async function point3() {
  phase('3: a waiting booking today (unpaid), on the board with no Booked for line, cancelled from the board');
  const { reg, sale } = await dropOffBooking('c', numbers.bookC, '03a-dropoff-form-booking-c.png');
  const left = await leaveUnpaid(sale);
  await openDeskBoard();
  await searchBoard(till, guardianName('c'));
  const card = deskCards(till).filter({ hasText: guardianName('c') }).filter({ has: till.getByRole('button', { name: 'Cancel booking' }) }).last();
  await card.waitFor({ timeout: 20000 });
  const facts = await cardFacts(card);
  const platformChild = (await boardApi()).families.find(f => f.registrationId === reg.id)?.children.map(c => ({ status: c.status, bookedForDate: c.bookedForDate ?? null }));
  await shot(till, '03b-board-today-booking-no-booked-for-cancel-booking.png');
  const seen = await cancelFromBoard(till, deskCards, guardianName('c'), new Set([reg.id]), 'ZZ TEST cancel', { typed: '03c-board-today-booking-cancel-dialog.png', from: 'desk board (own booking c)' });
  await searchBoard(till, guardianName('c'));
  seen.cardsLeft = await deskCards(till).filter({ hasText: guardianName('c') }).count();
  await shot(till, '03d-board-after-today-cancel-card-gone.png');
  const ok = left.saleStatus === 'voided' && facts.bookedFor === null && facts.cancelEnabled === true && platformChild?.every(c => c.bookedForDate === null) && seen.answer === 200 && seen.after.children.every(c => c.status === 'cancelled') && seen.cardsLeft === 0;
  point('3', ok, '03b-board-today-booking-no-booked-for-cancel-booking.png', `Today's unpaid booking c (sale ${left.saleStatus} at the till): the card has no "Booked for" line and an enabled Cancel booking; cancelled from the board (200), the card left`, { left, card: facts, platformChild, cancel: seen });
}

// ---- 4: a paid booking left as booked ----
async function point4() {
  phase('4: drop-off booking b — paid in cash, Leave as booked');
  const { reg, sale } = await dropOffBooking('b', numbers.bookB);
  await payCash();
  const leave = till.getByRole('button', { name: 'Leave as booked', exact: true });
  await leave.waitFor({ timeout: 20000 });
  await leave.click();
  await till.waitForTimeout(2000);
  knownSales.add(sale.id);
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  await openDeskBoard();
  await searchBoard(till, guardianName('b'));
  const card = deskCards(till).filter({ hasText: guardianName('b') }).last();
  await card.waitFor({ timeout: 20000 });
  const facts = await cardFacts(card);
  facts.text = flat(await card.innerText()).replace(/\+?\d[\d\s-]{7,}\d/g, '<number>').slice(0, 300);
  await shot(till, '04-paid-booking-b-left-as-booked-no-cancel-booking.png');
  const refused = await till.request.post(`/api/checkin/registrations/${reg.id}/cancel`, { data: { reason: 'ZZ TEST cancel (must be refused)' }, headers: { 'idempotency-key': randomUUID() } });
  const platformRefusal = { status: refused.status(), code: (await refused.json().catch(() => null))?.error?.code ?? null };
  const refusals = await refusalsOnBoard();
  phase('4: check booking b in from the board, then release it');
  await openDeskBoard();
  await searchBoard(till, childName('b'));
  const boardCard = deskCards(till).filter({ hasText: childName('b') }).filter({ has: till.getByRole('button', { name: /^Check in/ }) }).last();
  const checkin = { via: 'board' };
  try {
    await boardCard.waitFor({ timeout: 15000 });
    await boardCard.getByRole('button', { name: /^Check in/ }).first().click();
    const dialog = till.getByRole('dialog').filter({ hasText: /Check in (child|children)/ });
    await dialog.waitFor({ timeout: 15000 });
    for (const box of await dialog.getByRole('checkbox').all()) await box.check().catch(() => {});
    await dialog.getByRole('button', { name: /Check in & issue band/ }).click();
    await expect.poll(async () => (await registrationOf(reg.id)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
    await till.waitForTimeout(1500);
    await till.getByRole('button', { name: /^In Park\s*\d+$/ }).first().click();
    await searchBoard(till, childName('b'));
    await shot(till, '04-paid-booking-b-checked-in-from-the-board.png');
  } catch (error) {
    checkin.boardFailure = firstLine(error);
    odd('the board\'s Check in of the paid booking did not complete; checked in through the api as the board does', { failure: checkin.boardFailure });
    await till.keyboard.press('Escape').catch(() => {});
    for (const child of (await registrationOf(reg.id)).children.filter(c => c.status === 'registered')) {
      const r = await till.request.post('/api/checkin/check-in-booked', { data: { entries: [{ checkinId: child.id }] }, headers: { 'idempotency-key': randomUUID() } });
      checkin.api = { status: r.status() };
    }
  }
  checkin.release = await releaseOwn(reg.id, 'b');
  checkin.children = (await registrationOf(reg.id)).children.map(c => c.status);
  const ok = paid.status === 'finalised' && facts.cancelButtons === 0 && platformRefusal.status === 409 && checkin.children.every(s => s === 'out')
    && refusals.every(r => r.cards.every(c => (r.platformOffered ? c.cancelEnabled === false && Boolean(c.refusal) : c.cancelButtons === 0)));
  point('4', ok, '04-paid-booking-b-left-as-booked-no-cancel-booking.png', `Paid in cash, left as booked: no Cancel booking on the card (platform refuses ${platformRefusal.status} ${platformRefusal.code}); checked in from the board and released. Earlier-day ZZ TEST: ${refusals.map(r => `${r.guardian} ${r.platformOffered ? 'disabled: ' + (r.cards[0]?.refusal ?? '?') : 'no button'}`).join('; ')}`,
    { sale: { status: paid.status, grossSatang: paid.totals?.grossSatang ?? null }, card: facts, platformRefusal, refusals, checkin });
}
/** This run's own paid booking released with a synthetic pickup picture, as the SCRUM-862 harness's cleanup does. */
async function releaseOwn(id, tag) {
  const reg = await registrationOf(id);
  assert.equal(reg.guardianName, guardianName(tag), 'only this run\'s own booking');
  const done = [];
  for (const child of reg.children.filter(c => c.status === 'in_park')) {
    assert.equal(child.childName, childName(tag));
    const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: id, filename: `ZZ TEST SCRUM-${T} synthetic pickup.png` });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push(r.status);
  }
  return done;
}

// ---- 5: the phone till's board ----
async function point5(keepGuardian, names = { a: '05a-phone-board-upcoming-leftover-booked-for.png', b: '05b-phone-family-detail-cancel-booking.png', c: '05c-phone-cancel-dialog-reason-typed.png', d: '05d-phone-board-after-cancel-card-gone.png' }, key = '5') {
  phase('5: the phone till\'s board (390 x 844)');
  let target = classify(await boardApi()).find(r => r.zz && r.earlier && r.enabled && r.guardian === keepGuardian);
  let made = null;
  if (!target) {
    // No earlier-day leftover kept: a fresh waiting booking today, made on the desk till first.
    await till.setViewportSize({ width: 1680, height: 1100 });
    const { reg, sale } = await dropOffBooking('d', numbers.spare);
    await leaveUnpaid(sale);
    made = reg.id;
    target = classify(await boardApi()).find(r => r.id === reg.id);
  }
  await till.setViewportSize({ width: 390, height: 844 });
  await till.goto('/drop-off');
  await search(till).waitFor({ timeout: 30000 });
  await upcomingTab(till).click();
  await till.waitForTimeout(2500);
  const before = await upcomingCount(till);
  await searchBoard(till, target.guardian);
  const card = phoneCards(till).filter({ hasText: target.guardian }).first();
  await card.waitFor({ timeout: 20000 });
  const cardText = flat(await card.innerText()).replace(/\+?\d[\d\s-]{7,}\d/g, '<number>');
  await shot(till, names.a);
  await card.click();
  const cancel = till.getByRole('button', { name: 'Cancel booking', exact: true });
  await cancel.waitFor({ timeout: 15000 });
  await cancel.scrollIntoViewIfNeeded();
  const detail = { cancelEnabled: await cancel.isEnabled(), bookedFor: (flat(await till.locator('body').innerText()).match(BOOKED_FOR) ?? [null])[0],
    refusal: (await till.locator('p').filter({ hasText: /handled through its sale|off this sale first/ }).count()) };
  await shot(till, names.b);
  const allowed = new Set([target.id]);
  await cancel.click();
  const dialog = till.getByRole('dialog').filter({ hasText: 'Cancel this waiting booking' });
  await dialog.waitFor();
  const press = dialog.getByRole('button', { name: /reason to cancel|Cancel the booking/ });
  const seen = { before, cardText: cardText.slice(0, 200), detail, description: flat(await dialog.locator('p').first().innerText()).slice(0, 300), beforeReason: { label: flat(await press.innerText()), enabled: await press.isEnabled() } };
  assert.ok(seen.description.startsWith(`${target.guardian}'s booking:`));
  await dialog.getByLabel('Reason').fill(made ? 'ZZ TEST cancel' : LEFTOVER_REASON);
  seen.afterReason = { label: flat(await press.innerText()), enabled: await press.isEnabled() };
  await shot(till, names.c);
  const [answer] = await Promise.all([
    till.waitForResponse(r => /\/api\/checkin\/registrations\/[^/]+\/cancel$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Cancel the booking' }).click(),
  ]);
  const id = new URL(answer.url()).pathname.split('/').at(-2);
  assert.ok(allowed.has(id));
  seen.answer = answer.status();
  await expect(dialog).toBeHidden({ timeout: 20000 });
  await till.waitForTimeout(2500);
  const reg = await registrationOf(id);
  receipt.cancelled.push({ id, guardian: target.guardian, reason: made ? 'ZZ TEST cancel' : LEFTOVER_REASON, status: seen.answer, children: reg.children.map(c => c.status), from: 'phone board', at: new Date().toISOString() }); save();
  await search(till).waitFor({ timeout: 15000 });
  await searchBoard(till, target.guardian);
  seen.cardsLeft = await phoneCards(till).filter({ hasText: target.guardian }).count();
  await shot(till, names.d);
  await searchBoard(till, '');
  seen.after = await upcomingCount(till);
  await till.setViewportSize({ width: 1680, height: 1100 });
  const ok = seen.answer === 200 && reg.children.every(c => c.status === 'cancelled') && seen.detail.cancelEnabled && !seen.beforeReason.enabled && seen.afterReason.enabled && seen.cardsLeft === 0 && (Boolean(made) || /Booked for/.test(cardText));
  point(key, ok, names.b, `Phone till (390 x 844): "${target.guardian}"${made ? ' (today\'s own booking)' : ` booked for ${target.bookedFor.join(', ')}`} shows ${made ? '' : '"Booked for" on its card and '}Cancel booking on its family screen; cancelled there (200), the card left, Upcoming ${seen.before} -> ${seen.after}`, seen);
}

// ---- r: retake — whole cards of two earlier-day ZZ TEST families the board will not cancel, and the phone flow on today's booking ----
async function retake() {
  phase('r: whole cards of earlier-day ZZ TEST families with a paid or checked-in child');
  await openDeskBoard();
  await till.setViewportSize({ width: 1680, height: 1800 }); // the four-child card is taller than the board's list at 1100
  const seen = { cards: [] };
  for (const [guardian, file] of [['ZZ TEST Family 496 waiting', '04-earlier-day-d-paid-cancel-disabled-whole-card.png'], ['ZZ TEST SCRUM-741 Ying', '04-earlier-day-b-checked-in-cancel-disabled-whole-card.png']]) {
    const row = classify(await boardApi()).find(r => r.zz && r.guardian === guardian);
    if (!row) { odd(`${guardian} is no longer on the board`); continue; }
    await searchBoard(till, guardian);
    const card = deskCards(till).filter({ hasText: guardian }).first();
    await card.waitFor({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();
    const facts = await cardFacts(card);
    await card.screenshot({ path: resolve(out, file), animations: 'disabled', mask: masks(till) });
    console.log('picture', file);
    seen.cards.push({ guardian, bookedFor: row.bookedFor, waiting: row.waiting, paidWaiting: row.paidWaiting, settled: row.settled, card: facts, picture: file });
  }
  receipt.checks.retakeCards = seen; save();
  if (process.env.RETAKE_PHONE === '0') { await till.setViewportSize({ width: 1680, height: 1100 }); return; }
  phase("r: the phone till with today's waiting booking d");
  await till.setViewportSize({ width: 1680, height: 1100 });
  await point5(null, { a: '05e-phone-board-today-booking-no-booked-for.png', b: '05f-phone-family-detail-cancel-booking.png', c: '05g-phone-cancel-dialog-reason-typed.png', d: '05h-phone-board-after-cancel-card-gone.png' }, '5r');
}

const attempt = async (key, fn) => {
  try { return await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    await till.keyboard.press('Escape').catch(() => {});
    await till.setViewportSize({ width: 1680, height: 1100 }).catch(() => {});
    await till.goto('/').catch(() => {});
    return null;
  }
};

const only = (process.env.ONLY ?? '1,2,3,4,5').split(',');
const keepForPhone = process.env.KEEP_FOR_PHONE ?? 'ZZ TEST Nanny Guardian 494';
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
  for (const phone of Object.values(numbers)) assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null, 'ZZ TEST number must be unused');
  receipt.checks.testNumbersUnusedBefore = true;
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

  const video = resolve(import.meta.dirname, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  watch(till, 'till');
  await till.goto(pos);
  phase('reception account signs in at the own till (new browser profile)');
  await signInAtTill(till, need('STAGING_RECEPTION_PHONE'), need('STAGING_RECEPTION_PASSWORD'));
  const me = await (await till.request.get('/api/me')).json().catch(() => null);
  meId = me?.account?.id ?? me?.id ?? null;
  staffNames = [me?.employee?.name, me?.employee?.nickname, me?.account?.name, me?.name].filter(n => typeof n === 'string' && n.trim().length >= 2 && !isZz(n)).map(n => n.trim());
  receipt.checks.meIdKnown = Boolean(meId);
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    const found = { files: urls.length, bookedForMarkers: 0, bookingCheckedInMarkers: 0, cancelDialogMarkers: 0 };
    for (const url of urls) {
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      found.bookedForMarkers += text.split('Booked for ').length - 1;
      found.bookingCheckedInMarkers += text.split('bookingCheckedIn').length - 1;
      found.cancelDialogMarkers += text.split('Cancel this waiting booking').length - 1;
    }
    return found;
  });
  save();
  assert.ok(receipt.checks.bundle.bookedForMarkers >= 1 && receipt.checks.bundle.bookingCheckedInMarkers >= 1, 'the till serves the SCRUM-886 bundle');
  receipt.only = only;
  let pick = null;
  if (only.includes('1')) pick = await attempt('1', point1);
  if (only.includes('2') && pick) {
    await attempt('2', () => point2(pick));
    await attempt('2b', () => clearLeftovers(only.includes('5') ? keepForPhone : null));
  }
  if (only.includes('3')) await attempt('3', point3);
  if (only.includes('4')) await attempt('4', point4);
  if (only.includes('5')) await attempt('5', () => point5(keepForPhone));
  if (only.includes('r')) await attempt('r', retake);
  receipt.passed = !failed && only.every(k => k === 'r' ? (process.env.RETAKE_PHONE === '0' || receipt.points['5r']?.pass === true) : receipt.points[k]?.pass === true);
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
  let ownsStation = false;
  if (station) {
    await clean('verify own till', async () => { assert.equal((await call('GET', `/stations/${station.id}`)).body.station.name, fixtureName); ownsStation = true; });
    if (ownsStation) {
      for (const s of (await stationSales().catch(() => [])).filter(x => ['tendering', 'open'].includes(x.status))) await clean(`void ${s.id}`, async () => {
        assert.equal((await call('POST', `/sales/${s.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        receipt.cleanup.push({ kind: 'sale', id: s.id, status: 'voided', by: 'cleanup' });
      });
      for (const item of receipt.created.filter(i => i.kind === 'registration' && i.id)) await clean(`own registration ${item.tag}`, async () => {
        let reg = await registrationOf(item.id);
        assert.equal(reg.guardianName, guardianName(item.tag), 'only this run\'s own booking');
        if (reg.children.some(c => c.status === 'registered')) {
          const paidAny = (await boardApi()).families.find(f => f.registrationId === item.id)?.children.some(c => c.status === 'registered' && (c.paidOnline || c.paidAtTill));
          if (paidAny) {
            for (const child of reg.children.filter(c => c.status === 'registered')) {
              const r = await till.request.post('/api/checkin/check-in-booked', { data: { entries: [{ checkinId: child.id }] }, headers: { 'idempotency-key': randomUUID() } });
              receipt.cleanup.push({ kind: 'check-in-booked', tag: item.tag, status: r.status() });
            }
          } else {
            const r = await till.request.post(`/api/checkin/registrations/${item.id}/cancel`, { data: { reason: `ZZ TEST SCRUM-${T} proof cleanup` }, headers: { 'idempotency-key': randomUUID() } });
            receipt.cleanup.push({ kind: 'cancel-own-booking', tag: item.tag, status: r.status() });
          }
        }
        reg = await registrationOf(item.id);
        if (reg.children.some(c => c.status === 'in_park')) receipt.cleanup.push({ kind: 'release-own', tag: item.tag, statuses: await releaseOwn(item.id, item.tag) });
        const after = await registrationOf(item.id);
        const states = after.children.map(c => ({ id: c.id, status: c.status }));
        receipt.cleanup.push({ kind: 'registration', tag: item.tag, id: item.id, children: states });
        assert.ok(states.every(c => c.status === 'out' || c.status === 'cancelled'), 'nothing of this run is left waiting or in the park');
      });
      let sales = [];
      await clean('read own sales', async () => { sales = await stationSales(); for (const sale of sales) assert.equal(sale.stationId, station.id); });
      for (const { id } of sales.filter(s => s.status === 'finalised')) await clean(`print ${id}`, async () => {
        let jobs;
        await expect.poll(async () => { jobs = (await call('GET', `/sales/${id}`)).body.printJobs; return jobs.every(j => j.status === 'printed'); }, { timeout: 60000 }).toBe(true);
        receipt.cleanup.push({ kind: 'finalised-test-sale', id, retained: true, printJobs: jobs.map(j => j.status) });
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
    const member = (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member;
    if (member) {
      assert.ok(`${member.nickname ?? ''} ${member.name ?? ''}`.includes('ZZ TEST'), 'only own named test members');
      assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
      receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true });
    } else receipt.cleanup.push({ kind: 'test-number', key, member: null });
  });
  if (branchId && only.includes('5')) await clean('kept leftover', async () => {
    const rows = classify(await boardApi());
    for (const r of rows.filter(x => x.zz && x.earlier && x.enabled && x.guardian === keepForPhone)) {
      const reg = await registrationOf(r.id);
      assert.ok(isZz(reg.guardianName) && reg.children.every(c => isZz(c.childName)), 'only a ZZ TEST leftover');
      const res = await call('POST', `/checkin/registrations/${r.id}/cancel`, { reason: LEFTOVER_REASON });
      receipt.cancelled.push({ id: r.id, guardian: r.guardian, reason: LEFTOVER_REASON, status: res.status, from: 'cleanup (api)', at: new Date().toISOString() });
      receipt.cleanup.push({ kind: 'kept-leftover-cancelled', guardian: r.guardian, status: res.status });
    }
  });
  if (branchId) await clean('board after', async () => {
    const board = await boardApi();
    const rows = classify(board);
    receipt.cleanup.push({ kind: 'board-after', counts: board.counts, zz: rows.filter(r => r.zz).map(publicRow), notZz: rows.filter(r => !r.zz).map(publicRow) });
  });
  if (till) await clean('sign out till', async () => {
    const before = (await till.request.get('/api/me')).status();
    if (before === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await till.request.get('/api/me')).status(), 401);
    receipt.cleanup.push({ kind: 'till-session', signedOut: true, me: 401 });
  });
  await clean('sign out admin', async () => {
    if ((await admin.get('/api/me')).status() === 200) assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await admin.get('/api/me')).status(), 401);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true, me: 401 });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  hidden = []; staffNames = [];
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.pass])), cancelled: receipt.cancelled.length, odd: receipt.odd.length, pageErrors: receipt.pageErrors.length, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
