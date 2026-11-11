// SCRUM-863 staging proof: the drop-off and nanny forms ask for and confirm the
// WhatsApp / Telegram / LINE number again. Adapted from the committed
// SCRUM-847 and SCRUM-853 harnesses (docs/qa/proof-2026-11-11/SCRUM-8{47,53}/staging).
// Own ZZ TEST till, ZZ TEST guardians and children, invented numbers, cash only.
// No credential, pairing code or raw response body enters the receipt or the console.
//
//   node proof.mjs <sha> <out-dir> <passes>
//   passes: s  split view, drop-off age   (points 1-4)
//           n  split view, nanny age      (point 5)
//           d  paired customer display    (points 6-7)
//           e  ordinary adult+child sale  (point 8)
//           o  paired display, a child of 10 with no adult (extra: registered for drop-off at no fee, the same form)
//
// As run on 12 November 2026 against the till at 0a7a9c7c: `ZZ_BASE=41 node proof.mjs <sha> out-04 s,n,d,e,o`
// (receipt.json), then `ZZ_BASE=51 node proof.mjs <sha> out-05 e` for pictures 08 and 08b once the band codes
// and credit QR grids were added to the picture masks (receipt-08-retake.json).
// LEFTOVER_REGISTRATIONS=<id,...> checks in and releases a registration an earlier run of this proof left waiting.
// ZZ_BASE moves the invented numbers (08986300<base>..); each run asserts they are unused first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The repository root: five folders up from docs/qa/proof-<date>/SCRUM-863/staging, or OTO_REPO when run from elsewhere.
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const wanted = (process.argv[4] ?? 's,n,d,e,o').split(',');
const T = '863';
const base = Number(process.env.ZZ_BASE ?? 11);
const zz = i => '08986300' + String(base + i).padStart(2, '0');
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

// ZZ TEST only; confirmed unused before use. A = typed on the first screen, B = what the family changes it to on the form.
const numbers = { sA: zz(0), sB: zz(1), nA: zz(2), dA: zz(3), dB: zz(4), eA: zz(5), oA: zz(6) };
receipt.numbers = numbers;
const e164 = n => '+66' + n.slice(1);
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
// Unique to the run, so the check-in board's search finds this run's card only.
const RUN = String(process.argv[3] ?? 'out').replace(/\D/g, '') || '00';
const childName = tag => `ZZ TEST SCRUM-${T} child ${tag}${RUN}`;
const guardianName = tag => `ZZ TEST SCRUM-${T} guardian ${tag}${RUN}`;
const CHANNELS = ['WhatsApp', 'Telegram', 'LINE'];
const CHANNEL_KEY = { WhatsApp: 'whatsapp', Telegram: 'telegram', LINE: 'line' };
const knownSales = new Set();
const leftovers = [];
let browser = null, till = null, display = null, station = null, branchId = null, failed = false;

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    // The signed-in account's corner of the header, any password field, the display's pairing code, QR grids.
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
      page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
      // Band codes and credit QR grids on the payment-success screen: whoever holds one can spend it.
      page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/)] });
  console.log('picture', name);
};
const point = (key, pass, picture, shows, seen = {}) => { receipt.points[key] = { pass, picture, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what); };

/** The contact fields of what the till itself wrote (ZZ TEST numbers only), newest last. */
const tillWrites = [];
const plain = v => typeof v === 'string' ? v.replace(/\s/g, '').replace(/^\+660/, '+66') : v ?? null;
function watchWrites(page) {
  page.on('request', r => {
    if (r.method() === 'GET') return;
    const path = new URL(r.url()).pathname;
    if (!['/api/sales', '/api/members', '/api/checkin/registrations'].includes(path)) return;
    let body = null; try { body = r.postDataJSON(); } catch { /* not json */ }
    const cart = body?.cart ?? body; // the commit body names who the sale is for inside its cart
    tillWrites.push({ at: receipt.phase, method: r.method(), path,
      ...(path === '/api/sales' ? { customerPhone: cart?.customerPhone ?? null, memberIdSent: Boolean(cart?.memberId) } : {}),
      ...(path === '/api/members' ? { phone: body?.phone ?? null, preferredChannel: body?.preferredChannel ?? null } : {}),
      ...(path === '/api/checkin/registrations' ? { guardianPhone: body?.guardianPhone ?? null, contactChannel: body?.contactChannel ?? null, memberIdSent: Boolean(body?.memberId) } : {}) });
  });
}
const writesSince = mark => tillWrites.slice(mark);

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
/** The till's own customer half: the second half of the split view. */
const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const paymentStep = () => till.getByTestId('payment-step');
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };

/** Which of the three channel pills is the chosen one, read from the pill's own colours. */
async function channelState(scope) {
  const state = { shown: [], chosen: [] };
  for (const label of CHANNELS) {
    const pill = scope.getByTitle(label, { exact: true });
    if (!(await pill.count()) || !(await pill.first().isVisible())) continue;
    state.shown.push(label);
    if (!/border-transparent/.test(await pill.first().getAttribute('class') ?? '')) state.chosen.push(label);
  }
  return state;
}
/** The national digits the number field holds: a typed field, or the keypad's read-out. */
async function fieldNumber(scope) {
  const tel = scope.locator('input[type="tel"]');
  if (await tel.count()) return { kind: 'typed field', national: await tel.first().inputValue() };
  const readout = scope.locator('div.tracking-wider').first();
  return { kind: 'keypad read-out', national: flat(await readout.innerText()).replace(/^\+66\s*/, '').replace(/\s+/g, '') };
}
async function setFieldNumber(scope, number) {
  const tel = scope.locator('input[type="tel"]');
  if (await tel.count()) { await tel.first().fill(number.slice(1)); return 'typed'; }
  await scope.getByRole('button', { name: 'Clear', exact: true }).last().click();
  await keypad(scope, number.slice(1));
  return 'keypad';
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
    await page.screenshot({ path: resolve(out, name), animations: 'disabled',
      clip: { x, y, width: Math.min(view.width - x, box.width + 2 * pad), height: Math.min(view.height - y, box.height + 2 * pad) } });
    console.log('picture', name);
    return { width: Math.round(box.width), height: Math.round(box.height) };
  } catch (error) { return { failure: firstLine(error) }; }
}

/** POINT 1 / 6a: the first screen. The number on the keypad, a channel, no Skip; then walk-in. */
async function firstScreen(surface, number, channel, typed = number) {
  await landing(surface).waitFor();
  if (await surface.getByTestId('language-choice').isVisible()) await surface.getByTestId('language-choice-en').click();
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await keypad(scope, typed);
  if (channel) await scope.getByTitle(channel, { exact: true }).click();
  const seen = { typed: flat(await scope.locator('div.tracking-wider').first().innerText().catch(() => '')), channels: await channelState(scope),
    skipButtons: await scope.getByRole('button', { name: /skip/i }).count(), skipWordAnywhere: /\bskip\b/i.test(await scope.innerText()),
    buttons: (await scope.getByRole('button').allInnerTexts()).map(flat).filter(b => b && !/^[0-9]$/.test(b)) };
  return { scope, seen };
}
async function walkIn(scope, number) {
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
/** Age, then 1 January: the date-of-birth picker, on whichever page shows it. */
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
/** What the parent's block shows about the number. */
async function parentBlock(scope) {
  const text = flat(await scope.innerText());
  return { phoneNumberLabel: /Phone number/.test(text), field: await fieldNumber(scope), channels: await channelState(scope),
    storedAs: text.match(/Stored as:\s*(\+\d+)/)?.[1] ?? null,
    keptLineTestId: await scope.getByTestId('consent-kept-phone').count(),
    keptSentence: /We will use the number you gave at the start/.test(text) };
}
function assertBlock(seen, number, channel) {
  assert.equal(seen.phoneNumberLabel, true, '"Phone number" stands in the parent\'s block');
  // A number typed on the first screen with its leading 0 keeps it in the field until it is stored (the "Stored as" line shows the stored form).
  assert.match(seen.field.national, new RegExp(`^0?${number.slice(1)}$`), 'the field holds the number');
  seen.field.leadingZeroShown = seen.field.national.startsWith('0');
  assert.deepEqual(seen.channels.shown, CHANNELS, 'the three channels are offered');
  assert.deepEqual(seen.channels.chosen, [channel], `${channel} is the chosen one`);
  assert.equal(seen.keptLineTestId, 0, 'no fixed line');
  assert.equal(seen.keptSentence, false, 'no "number you gave at the start" sentence');
}
async function continueToPayment(tag) {
  const [registered] = await Promise.all([
    till.waitForResponse(r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST'),
    till.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  const sent = registered.request().postDataJSON();
  const reg = await registered.json().catch(() => null);
  receipt.created.push({ kind: 'registration', id: reg?.id ?? null, pass: tag }); save();
  return { status: registered.status(), sent: { guardianPhone: sent?.guardianPhone ?? null, contactChannel: sent?.contactChannel ?? null }, reg };
}
async function saleWritten(kind) {
  let sale;
  await expect.poll(async () => { sale = (await newSales()).find(x => ['tendering', 'open'].includes(x.status)); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  receipt.created.push({ kind, id: sale.id }); save();
  return sale;
}
const saleContact = sale => Object.fromEntries(Object.entries(sale).filter(([k]) => /phone|channel|contact/i.test(k)));
async function payCash() {
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click();
  // By text: the "Check in the drop-off child?" dialog opens over the page and hides its headings from roles.
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
}
const registrationOf = async id => (await call('GET', '/checkin/registrations/' + id)).body;
async function readBack(reg, sale, tag, number, channel, startNumber, writes) {
  const sales = writes.filter(w => w.path === '/api/sales' && w.method === 'POST');
  const sent = sales.at(-1) ?? null;
  // The list read names the member a sale is filed under; the sale's own number is not in any read.
  const listed = (await stationSales()).find(x => x.id === sale.id);
  const seen = { registration: { id: reg.id, guardianName: reg.guardianName, guardianPhone: reg.guardianPhone, contactChannel: reg.contactChannel,
    children: reg.children.map(c => ({ name: c.childName, service: c.service, status: c.status })) },
  sale: { id: sale.id, status: sale.status, receipt: sale.receiptNumber ?? null, grossSatang: sale.totals?.grossSatang ?? null,
    numberTheTillSentWithTheSale: sent?.customerPhone ?? null, numberTheTillSentWithTheSaleStoredForm: plain(sent?.customerPhone),
    saleReadReturnsItsOwnNumber: 'customerPhone' in sale, filedUnderMember: listed?.member ? { nickname: listed.member.nickname, phone: listed.member.phone } : null },
  tillWrites: writes };
  assert.equal(reg.guardianName, guardianName(tag));
  assert.equal(reg.guardianPhone, e164(number), 'the registration keeps the form\'s number in +66 form');
  assert.equal(reg.contactChannel, CHANNEL_KEY[channel], 'the registration keeps the form\'s channel');
  assert.ok(sales.length > 0, 'the till wrote the sale');
  for (const write of sales) assert.equal(plain(write.customerPhone), e164(startNumber), 'the till sent the sale with the first screen\'s number');
  return seen;
}
/** After payment: check the child in (so no waiting registration is left), then the board's card. */
async function checkInAndBoard(tag, regId, picture) {
  const result = { checkedIn: false, board: null };
  const now = till.getByRole('button', { name: 'Check in now', exact: true });
  if (await now.isVisible().catch(() => false)) {
    await now.click();
    await expect.poll(async () => (await registrationOf(regId)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
    result.checkedIn = true;
    await till.waitForTimeout(1500);
    await shot(till, picture.replace('checkin-board-card-number-b', 'checked-in-payment-successful'));
  }
  try {
    const next = till.getByRole('button', { name: 'Start New Sale' });
    if (await next.isVisible().catch(() => false)) await next.click();
    await till.getByRole('button', { name: 'Check-in', exact: true }).click();
    const search = till.getByPlaceholder('Search child, parent or phone…');
    await search.waitFor({ timeout: 20000 });
    await search.fill(childName(tag));
    const card = till.locator('[class*="bg-card"]').filter({ hasText: childName(tag) }).last();
    let found = await card.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
    for (const tab of ['In park', 'In Park', 'Checked in']) {
      if (found) break;
      const t = till.getByRole('tab', { name: new RegExp(tab) }).or(till.getByRole('button', { name: new RegExp('^' + tab) })).first();
      if (await t.isVisible().catch(() => false)) { await t.click(); found = await card.waitFor({ timeout: 6000 }).then(() => true).catch(() => false); }
    }
    if (found) {
      await card.scrollIntoViewIfNeeded();
      result.board = flat(await card.innerText()).slice(0, 500);
      // Only this proof's own ZZ TEST card is searched for; any other card left on the board is covered.
      const others = till.locator('[class*="bg-card"]').filter({ hasNotText: `ZZ TEST SCRUM-${T}` });
      await till.screenshot({ path: resolve(out, picture), animations: 'disabled',
        mask: [till.getByLabel('Lock screen').locator('..'), till.locator('svg:not(.lucide), canvas'), others] });
      console.log('picture', picture);
    } else result.board = 'card not found on the board';
  } catch (error) { result.board = 'board not read: ' + firstLine(error); }
  await till.goto('/'); await landing(till).waitFor();
  return result;
}

// ---- pass s: split view, drop-off age. Points 1-4. ----
async function passSplitDropOff() {
  const tag = 's', A = numbers.sA, B = numbers.sB, mark = tillWrites.length;
  phase('s: first screen on the till\'s customer half — number A, Telegram');
  await till.goto('/');
  const { scope, seen: first } = await firstScreen(till, A, 'Telegram');
  await shot(till, '01-first-screen-number-a-telegram-no-skip.png');
  // Point 9: the read-out of a number typed with its leading 0 — does it stay on one line inside its box?
  const readout = scope.locator('div.tracking-wider').first();
  const fit = await readout.evaluate(el => ({ boxHeight: el.clientHeight, contentHeight: el.scrollHeight, lines: Math.round(el.firstElementChild.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '36')) }));
  receipt.checks.firstScreenReadout = { typed: first.typed, ...fit, overflowsItsBox: fit.contentHeight > fit.boxHeight, picture: '09a-first-screen-readout-ten-digits.png', size: await closeUp(till, readout, '09a-first-screen-readout-ten-digits.png') };
  const p1 = first.typed.replace(/\s+/g, '').endsWith(A.slice(1)) && first.channels.chosen.join() === 'Telegram' && first.skipButtons === 0 && !first.skipWordAnywhere;
  point('1', p1, '01-first-screen-number-a-telegram-no-skip.png', 'Customer half of the till: number A typed, Telegram chosen, no Skip button', first);
  await walkIn(scope, A);

  phase('s: ticket with one child and no adult, to "Children playing alone"');
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const nameField = till.getByPlaceholder('Full name', { exact: true }).first();
  await nameField.waitFor();
  const half = halfOf(nameField);
  await nameField.fill(childName(tag));
  await setAge(till, half, 6);
  await half.getByPlaceholder('Your full name', { exact: true }).waitFor();
  const badge = flat(await half.innerText()).match(/Drop-off[^.]*?(?=Photo|$)/)?.[0]?.slice(0, 120) ?? null;
  const block = await parentBlock(half);
  await half.getByText('Phone number', { exact: true }).scrollIntoViewIfNeeded();
  await shot(till, '02-dropoff-form-number-a-telegram.png');
  // Point 9: staff's "Before payment" list as it reads on this till's theme.
  const before = till.getByText('Before payment', { exact: true }).locator('xpath=ancestor::div[contains(@class, "rounded-2xl")][1]');
  const tone = await before.evaluate(el => { const li = el.querySelector('li'); return { text: getComputedStyle(li).color, box: getComputedStyle(el).backgroundColor, page: getComputedStyle(document.body).backgroundColor, htmlClass: document.documentElement.className }; }).catch(() => null);
  receipt.checks.beforePaymentList = { colours: tone, picture: '09b-before-payment-list-staff-side.png', size: await closeUp(till, before, '09b-before-payment-list-staff-side.png', 12) };
  let ok = true; try { assertBlock(block, A, 'Telegram'); } catch (error) { ok = false; block.failure = firstLine(error); }
  point('2', ok, '02-dropoff-form-number-a-telegram.png', 'Drop-off age (6): the parent\'s block on the customer half holds number A with WhatsApp / Telegram / LINE, Telegram chosen, and no "number you gave at the start" line', { requirement: badge, ...block });

  phase('s: the family changes the number to B and the channel to LINE');
  await setFieldNumber(half, B);
  await half.getByTitle('LINE', { exact: true }).click();
  const changed = await parentBlock(half);
  const privateButton = await till.getByRole('button', { name: 'Private child details', exact: true }).count();
  changed.privateChildDetailsButtonOnStaffSide = privateButton;
  await half.getByText('Phone number', { exact: true }).scrollIntoViewIfNeeded();
  await shot(till, '03-dropoff-form-changed-to-b-line.png');
  ok = true; try { assertBlock(changed, B, 'LINE'); } catch (error) { ok = false; changed.failure = firstLine(error); }
  if (privateButton) {
    await till.getByRole('button', { name: 'Private child details', exact: true }).click();
    const details = till.getByRole('dialog', { name: 'Private child details', exact: true });
    changed.staffCopy = await parentBlock(details);
    await shot(till, '03b-private-child-details-b-line.png');
    await details.getByRole('button', { name: 'Close', exact: true }).click();
  }
  point('3', ok, '03-dropoff-form-changed-to-b-line.png', 'The form now holds number B and LINE' + (privateButton ? '; staff\'s Private child details shows the same' : '; the split view has no "Private child details" button (it is offered only while a separate display is paired), so staff\'s copy is proved at point 7 and what the till kept at point 4'), changed);

  phase('s: finish the form — guardian name, synthetic photo, ticks');
  await half.getByPlaceholder('Your full name', { exact: true }).fill(guardianName(tag));
  await half.getByRole('button', { name: 'Start camera', exact: true }).click();
  await half.getByRole('button', { name: 'Take photo', exact: true }).click();
  await half.getByAltText('Captured', { exact: true }).waitFor();
  for (const checkbox of await half.getByRole('checkbox').all()) await checkbox.check();
  phase('s: Continue to payment (the registration is written)');
  const written = await continueToPayment(tag);
  assert.equal(written.status, 200);
  const sale = await saleWritten('dropoff-ticket-sale');
  phase('s: pay cash');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '04-dropoff-paid-cash.png');
  const reg = await registrationOf(written.reg.id);
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  knownSales.add(sale.id);
  let seen = { sentByTheTill: written.sent, sentIsB: written.sent.guardianPhone === e164(B) }; ok = true;
  try { seen = { ...seen, ...(await readBack(reg, paid, tag, B, 'LINE', A, writesSince(mark))) }; assert.equal(paid.status, 'finalised'); } catch (error) { ok = false; seen.failure = firstLine(error); seen.registrationRead = { guardianPhone: reg?.guardianPhone, contactChannel: reg?.contactChannel }; seen.saleRead = paid ? saleContact(paid) : null; }
  phase('s: check in, read the board\'s card');
  seen.after = await checkInAndBoard(tag, written.reg.id, '04b-checkin-board-card-number-b.png');
  point('4', ok, '04-dropoff-paid-cash.png', 'Cash sale completed; read back: the registration\'s guardian number is B in +66 form with channel LINE; the till wrote the sale itself with number A', seen);
}

// ---- pass n: split view, nanny age. Point 5. ----
async function passSplitNanny() {
  const tag = 'n', A = numbers.nA;
  phase('n: first screen — number A, Telegram; ticket with one child and no adult');
  await till.goto('/');
  // Typed here without the leading 0, to show the field as it reads then.
  const { scope } = await firstScreen(till, A, 'Telegram', A.slice(1));
  await walkIn(scope, A);
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const nameField = till.getByPlaceholder('Full name', { exact: true }).first();
  await nameField.waitFor();
  const half = halfOf(nameField);
  await nameField.fill(childName(tag));
  await setAge(till, half, 3);
  await half.getByPlaceholder('Your full name', { exact: true }).waitFor();
  const text = flat(await half.innerText());
  const block = await parentBlock(half);
  block.nannyRequirementShown = /nanny/i.test(text);
  await half.getByText('Phone number', { exact: true }).scrollIntoViewIfNeeded();
  await shot(till, '05-nanny-form-number-a-telegram.png');
  let ok = true; try { assertBlock(block, A, 'Telegram'); assert.equal(block.nannyRequirementShown, true); } catch (error) { ok = false; block.failure = firstLine(error); }
  point('5', ok, '05-nanny-form-number-a-telegram.png', 'Nanny age (3): the same block — number A, the three channels, Telegram chosen, no fixed line', block);
  // Nothing was written: the registration and the sale are only written at "Continue to payment".
  await till.getByRole('button', { name: 'Back', exact: true }).first().click().catch(() => {});
  await till.goto('/'); await landing(till).waitFor();
}

// ---- pass d: a separate customer display paired to the till. Points 6-7. ----
async function passPairedDisplay() {
  const tag = 'd', A = numbers.dA, B = numbers.dB, mark = tillWrites.length;
  await till.goto('/');
  await pairDisplay();
  const page = display.page;
  phase('d: first screen on the paired display — number A, Telegram');
  const { scope, seen: first } = await firstScreen(page, A, 'Telegram');
  await shot(page, '06a-display-first-screen-number-a-telegram.png');
  await walkIn(scope, A);
  phase('d: ticket with one child and no adult; the form opens on the display');
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const consent = page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  const keyboardDone = page.getByRole('button', { name: 'Done', exact: true });
  await consent.getByPlaceholder('Full name', { exact: true }).fill(childName(tag));
  await setAge(page, consent, 6);
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByTestId('consent-care').waitFor();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByPlaceholder('Your full name', { exact: true }).waitFor();
  const block = await parentBlock(consent);
  block.firstScreen = first;
  await shot(page, '06-display-agreements-number-a-three-channels.png');
  let ok = true; try { assertBlock(block, A, 'Telegram'); } catch (error) { ok = false; block.failure = firstLine(error); }
  point('6', ok, '06-display-agreements-number-a-three-channels.png', 'Paired display, agreements step: the number field holds A with WhatsApp / Telegram / LINE, Telegram chosen', block);

  phase('d: the family changes the number to B and the channel to LINE, names the guardian, ticks, Continue');
  const how = await setFieldNumber(consent, B);
  await consent.getByTitle('LINE', { exact: true }).click();
  await consent.getByPlaceholder('Your full name', { exact: true }).fill(guardianName(tag));
  if (await consent.getByPlaceholder('Your full name', { exact: true }).inputValue() !== guardianName(tag)) odd('the display\'s guardian name field did not take a typed name');
  for (const checkbox of await consent.getByRole('checkbox').all()) await checkbox.check();
  const changed = await parentBlock(consent);
  changed.numberEnteredBy = how;
  await shot(page, '07a-display-changed-to-b-line.png');
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  phase('d: staff open Private child details');
  await till.getByRole('button', { name: 'Private child details', exact: true }).click();
  const details = till.getByRole('dialog', { name: 'Private child details', exact: true });
  await expect(details.getByPlaceholder('Your full name', { exact: true })).toHaveValue(guardianName(tag), { timeout: 20000 });
  await expect(details.locator('input[type="tel"]')).toHaveValue(B.slice(1), { timeout: 20000 }).catch(() => {});
  const staff = await parentBlock(details);
  await details.getByText('Phone number', { exact: true }).scrollIntoViewIfNeeded();
  await shot(till, '07-staff-private-child-details-b-line.png');
  ok = true; try { assertBlock(changed, B, 'LINE'); assertBlock(staff, B, 'LINE'); } catch (error) { ok = false; staff.failure = firstLine(error); }
  phase('d: staff take the synthetic photo; the display offers Done');
  await details.getByRole('button', { name: 'Start camera', exact: true }).click();
  await details.getByRole('button', { name: 'Take photo', exact: true }).click();
  await details.getByAltText('Captured', { exact: true }).waitFor();
  await details.getByRole('button', { name: 'Close', exact: true }).click();
  const done = consent.getByRole('button', { name: 'Done', exact: true });
  let doneOffered = true;
  try { await expect(done).toBeEnabled({ timeout: 30000 }); } catch { doneOffered = false; }
  const atDone = await parentBlock(consent).catch(() => null);
  await shot(page, '07b-display-offers-done.png');
  if (!doneOffered) { ok = false; staff.failure = (staff.failure ? staff.failure + '; ' : '') + 'the display did not offer Done'; }
  if (doneOffered) await done.click();
  await expect(consent.getByText('Thank you. The team will complete the staff checks.', { exact: true })).toBeVisible({ timeout: 20000 }).catch(() => odd('the display did not show its thank-you line after Done'));
  phase('d: Continue to payment (the registration is written)');
  const written = await continueToPayment(tag);
  assert.equal(written.status, 200);
  const sale = await saleWritten('dropoff-ticket-sale');
  phase('d: pay cash');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '07c-display-pass-paid-cash.png');
  const reg = await registrationOf(written.reg.id);
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  knownSales.add(sale.id);
  let seen = { displayAfterChange: changed, staffDialog: staff, displayOffersDone: doneOffered, displayAtDone: atDone, sentByTheTill: written.sent, sentIsB: written.sent.guardianPhone === e164(B) };
  try { seen = { ...seen, ...(await readBack(reg, paid, tag, B, 'LINE', A, writesSince(mark))) }; assert.equal(paid.status, 'finalised'); } catch (error) { ok = false; seen.failure = firstLine(error); seen.registrationRead = { guardianPhone: reg?.guardianPhone, contactChannel: reg?.contactChannel }; seen.saleRead = paid ? saleContact(paid) : null; }
  await dropDisplay();
  phase('d: check in, read the board\'s card');
  seen.after = await checkInAndBoard(tag, written.reg.id, '07d-checkin-board-card-number-b.png');
  point('7', ok, '07-staff-private-child-details-b-line.png', 'After Continue on the display, staff\'s Private child details shows number B and LINE; the display then offers Done; cash sale completed and the registration reads back B / LINE while the till wrote the sale with A', seen);
}

// ---- pass o: paired display, a child old enough to play alone and with no adult. Extra, beside the follow-up commit 0a7a9c7c. ----
async function passDisplayNoCare() {
  const tag = 'o', A = numbers.oA;
  await till.goto('/');
  await pairDisplay();
  const page = display.page;
  phase('o: paired display — number A; one child aged 10 and no adult');
  const { scope } = await firstScreen(page, A, null);
  await walkIn(scope, A);
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const consent = page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  await consent.getByPlaceholder('Full name', { exact: true }).fill(childName(tag));
  await setAge(page, consent, 10);
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByTestId('consent-care').waitFor();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByText('Phone number', { exact: true }).waitFor();
  const kept = consent.getByTestId('consent-kept-phone');
  const seen = { keptLine: await kept.count(), keptText: (await kept.count()) ? flat(await kept.innerText()) : null,
    numberFields: await consent.locator('input[type="tel"]').count(), channels: await channelState(consent),
    consentTickAsked: await consent.getByTestId('public-consent-ack').count(),
    requirementOnTheTill: flat(await till.locator('body').innerText()).match(/Registered for drop-off — no fee|No supervision required|Drop-off required|Nanny required/)?.[0] ?? null };
  await shot(page, 'x1-display-child-of-10-alone-same-form.png');
  await shot(till, 'x1b-till-child-of-10-alone.png');
  // An extra, not one of the nine points: a child old enough to play alone and with no adult is still
  // registered for drop-off at no fee (Till.tsx openSupervisionGate, optIn: true), so consent is asked
  // and the form is the same one — with the number field and the channels.
  const ok = seen.consentTickAsked === 1 && seen.numberFields === 1 && seen.channels.shown.length === 3 && seen.keptLine === 0;
  point('x1', ok, 'x1-display-child-of-10-alone-same-form.png', 'Extra: a child of 10 with no adult is registered for drop-off at no fee, so the display shows the same form with the number field and the three channels', seen);
  // Nothing was written: the registration and the sale are only written at "Continue to payment".
  await dropDisplay();
  await till.goto('/'); await landing(till).waitFor();
}

// ---- pass e: an ordinary sale, one adult and one child. Point 8. ----
async function passOrdinary() {
  const A = numbers.eA, mark = tillWrites.length;
  phase('e: ordinary sale — number on the first screen, one adult and one child');
  await dropDisplay().catch(() => {});
  await till.goto('/');
  const { scope } = await firstScreen(till, A, null);
  await walkIn(scope, A);
  await ticket(1, 1);
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  const sale = await saleWritten('ordinary-ticket-sale');
  await till.waitForTimeout(1500);
  const pay = till.getByText('Please pay', { exact: true });
  const half = (await pay.count()) ? halfOf(pay.first()) : null;
  const seen = { childrenPlayingAloneShown: await till.getByRole('heading', { name: 'Children playing alone', exact: true }).count(),
    customerHalf: half ? flat(await half.innerText()).slice(0, 400) : null,
    numberFieldsOnCustomerHalf: half ? await half.locator('input[type="tel"]').count() : null,
    keypadOnCustomerHalf: half ? await half.getByRole('button', { name: '7', exact: true }).count() : null,
    channelPillsOnCustomerHalf: half ? (await channelState(half)).shown.length : null,
    staffDialogs: await till.getByRole('dialog').count() };
  await shot(till, '08-ordinary-sale-payment-number-not-asked-again.png');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '08b-ordinary-sale-paid-cash.png');
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  knownSales.add(sale.id);
  const sent = writesSince(mark).filter(w => w.path === '/api/sales' && w.method === 'POST').at(-1) ?? null;
  seen.sale = { id: paid.id, status: paid.status, receipt: paid.receiptNumber ?? null, grossSatang: paid.totals?.grossSatang ?? null,
    numberTheTillSentWithTheSale: sent?.customerPhone ?? null, numberTheTillSentWithTheSaleStoredForm: plain(sent?.customerPhone) };
  seen.tillWrites = writesSince(mark);
  seen.registrationsWritten = seen.tillWrites.filter(w => w.path === '/api/checkin/registrations').length;
  const ok = seen.childrenPlayingAloneShown === 0 && seen.numberFieldsOnCustomerHalf === 0 && seen.keypadOnCustomerHalf === 0 && seen.channelPillsOnCustomerHalf === 0
    && paid.status === 'finalised' && plain(sent?.customerPhone) === e164(A) && seen.registrationsWritten === 0;
  point('8', ok, '08-ordinary-sale-payment-number-not-asked-again.png', 'One adult and one child: straight from the ticket to payment, the number is not asked again; paid in cash (08b)', seen);
  await till.goto('/'); await landing(till).waitFor();
}

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    if (display) await shot(display.page, `failed-${key}-display.png`).catch(() => {});
    // Leave the pass: cancel what the payment step still holds, unpair, start clean.
    try {
      const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
      if (await paymentStep().isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) { await cancel.click(); await till.waitForTimeout(3000); }
    } catch { /* cleanup below reads the sales back */ }
    await dropDisplay().catch(() => {});
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
  for (const phone of Object.values(numbers)) assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null, 'ZZ TEST number must be unused');
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
  // A new browser profile: nothing cached, the bundle is fetched fresh.
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  watch(till, 'till');
  watchWrites(till);
  await till.goto(pos);
  phase('reception account signs in at the own till (new browser profile)');
  await signInAtTill(till, need('STAGING_RECEPTION_PHONE'), need('STAGING_RECEPTION_PASSWORD'));
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    const found = { files: urls.length, names: urls.map(u => u.split('/').pop().split('?')[0]), keptPhoneMarkers: 0, keptSentence: false };
    for (const url of urls) {
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      // Before SCRUM-863 the marker stood twice (the till's own form and the display's); now only the display keeps it, for a till that does not send the channel.
      found.keptPhoneMarkers += text.split('consent-kept-phone').length - 1;
      if (text.includes('We will use the number you gave at the start')) found.keptSentence = true;
    }
    return found;
  });
  save();
  console.log('bundle', JSON.stringify(receipt.checks.bundle));
  assert.equal(receipt.checks.bundle.keptPhoneMarkers, 1, 'the till serves the SCRUM-863 bundle');

  if (wanted.includes('s')) await attempt('s', passSplitDropOff);
  if (wanted.includes('n')) await attempt('n', passSplitNanny);
  if (wanted.includes('d')) await attempt('d', passPairedDisplay);
  if (wanted.includes('e')) await attempt('e', passOrdinary);
  if (wanted.includes('o')) await attempt('o', passDisplayNoCare);
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
  // A registration an earlier run of THIS proof left waiting (its payment-success wait missed the check-in dialog):
  // checked in from this run's own till, as the board's "Check in" does, then released below like the others.
  for (const id of (process.env.LEFTOVER_REGISTRATIONS ?? '').split(',').filter(Boolean)) await clean(`leftover registration ${id}`, async () => {
    const reg = await registrationOf(id);
    assert.ok(String(reg.guardianName).startsWith(`ZZ TEST SCRUM-${T} guardian`), 'only this proof\'s own registration');
    for (const child of reg.children) {
      assert.ok(String(child.childName).startsWith(`ZZ TEST SCRUM-${T} child`));
      if (child.status === 'registered') {
        const response = await till.request.post('/api/checkin/check-in-booked', { data: { entries: [{ checkinId: child.id }] }, headers: { 'idempotency-key': randomUUID() } });
        receipt.cleanup.push({ kind: 'leftover-check-in', registration: id, child: child.id, status: response.status(), ...(response.status() >= 400 ? { errorCode: (await response.json().catch(() => null))?.error?.code ?? null } : {}) });
        assert.equal(response.status(), 200);
      }
    }
    leftovers.push(id);
  });
  let ownsStation = false;
  if (station) {
    await clean('verify own till', async () => {
      const own = (await call('GET', `/stations/${station.id}`)).body.station;
      assert.equal(own.name, fixtureName); ownsStation = true;
    });
    if (ownsStation) {
      for (const item of [...receipt.created.filter(i => i.kind === 'registration' && i.id), ...leftovers.map(id => ({ id, pass: 'earlier run', leftover: true }))]) await clean(`pick up own test child (${item.pass})`, async () => {
        const reg = await registrationOf(item.id);
        if (item.leftover) assert.ok(String(reg.guardianName).startsWith(`ZZ TEST SCRUM-${T} guardian`)); else assert.equal(reg.guardianName, guardianName(item.pass));
        for (const child of reg.children) {
          if (item.leftover) assert.ok(String(child.childName).startsWith(`ZZ TEST SCRUM-${T} child`)); else assert.equal(child.childName, childName(item.pass));
          if (child.status === 'in_park') {
            // As cleanup-pickup.mjs of SCRUM-807: a separate synthetic pickup photo, then the release.
            const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: item.id, filename: `ZZ TEST SCRUM-${T} synthetic pickup.png` });
            assert.equal(file.status, 200);
            const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
            assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
            const released = await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
            assert.equal(released.status, 200);
          }
        }
        const after = await registrationOf(item.id);
        const states = after.children.map(c => ({ id: c.id, name: c.childName, status: c.status }));
        receipt.cleanup.push({ kind: 'registration', pass: item.pass, id: item.id, children: states, stillWaiting: states.filter(c => c.status === 'registered').length, inPark: states.filter(c => c.status === 'in_park').length });
        assert.ok(states.every(c => c.status !== 'in_park'));
      });
      let sales = [];
      await clean('read own sales', async () => {
        sales = await stationSales();
        assert.ok(Array.isArray(sales));
        for (const sale of sales) assert.equal(sale.stationId, station.id);
      });
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
    const member = (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member;
    if (member) {
      assert.ok(`${member.nickname ?? ''} ${member.name ?? ''}`.includes(`ZZ TEST SCRUM-${T}`), 'only own named test members');
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
