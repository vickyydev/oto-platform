// SCRUM-857 part 1 staging proof: on the drop-off and nanny form the family explicitly confirms the messaging number.
// Adapted from the SCRUM-863 harness (docs/qa/proof-2026-11-12/SCRUM-863/staging/proof.mjs: split view, paired display,
// first screen, ticket, age, cash, board) and the SCRUM-887 one (own till on the shared virtual box, cleanup, read-backs).
// Own ZZ TEST till on virtual-1, ZZ TEST guardians and children, invented Thai mobiles 08985701xx, cash only.
// No credential, pairing code or raw response body enters the receipt or the console.
//
//   node proof.mjs <sha> <out-dir> [passes]        ZZ_BASE=10 (numbers 08985701<base+0..base+8>)
//   passes (default s,a,n,d,c,e):
//     s  split view, drop-off age 6, WhatsApp: the confirm line, the gate, the status list, channel/number/landline/empty;
//        cash; read-back + audit; board: edit the number -> confirmation withdrawn   (points 1, 2, 5a)
//     a  the api refuses a landline, an invalid number, a confirmation with no number (own ZZ TEST body)   (point 7)
//     n  split view, nanny age 3: the same line is asked; nothing written                                (point 4)
//     d  paired display: the line on the agreements step, Done held, edit clears, staff copy read-only,
//        Thai / Russian; cash; read-back + audit; board: edit the channel -> withdrawn                    (points 3, 6b, 5b)
//     c  split view, a third family: cash; board: a name-only edit keeps it, clearing the number saves   (point 5c)
//     e  ordinary sale, one child with an adult: no confirm line anywhere, no registration, cash         (point 6a)
//
// Run history, 12 November 2026, all against the deploys of 13:18 Bangkok at 9383df00b (deploys.json; each run its own
// ZZ_BASE so no invented number is used twice; each run archives what it made). CAMERA_DIR pointed at the scratchpad.
//   01  all (s,a,n,d,c,e)  ZZ_BASE=10  out-run-01/  5c PASS, 6a PASS. s, n, d stopped at the first read of the confirm line
//                                      (a `has:` filter built from a scoped locator never matched; nothing was written), a had
//                                      no body shape without s.
//   02  s,a,n,d            ZZ_BASE=20  out-run-02/  1, 2, 5a, 5b, 6b PASS; two ODD (the split view's tick comes back when the
//                                      channel or the number is put back). 3 FAIL on one harness read only (Continue to payment
//                                      read while the Private child details dialog was still closing, so the page was hidden
//                                      from roles); 4 FAIL on the badge regex (the child's line says "needs a nanny"); a refused
//                                      its own template (the till had tied the body to the member it made).
//   03  n,d,a              ZZ_BASE=30  out-run-03/  3, 4, 5b, 6b, 7 PASS.
// Changed between runs, and why:
//   - after 01: the confirm line is read from the box's own <label> ancestor; the gate's standing note "<child> needs
//     drop-off/nanny supervision" is left out of "the only reason"; board "-saved" pictures wait 3 s for the board to
//     read itself again (run 01's 05d-...-saved and run 02's 05a-...-saved were taken before it did: the read-backs, not
//     those pictures, show the saved values).
//   - after 02: wait for the Private child details dialog to close before reading the till; the nanny check reads "nanny"
//     anywhere on the half; pass a drops memberId/visitId from the till's body and runs after d when s is not run.
// phone-till.mjs (out-phone-01/, out-phone-02/) is a read-only look at the same form on the phone till; leftovers.mjs
// (leftovers-check.json) reads back that nothing of these runs is left open.
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
const wanted = (process.argv[4] ?? 's,a,n,d,c,e').split(',');
const T = '857';
const base = Number(process.env.ZZ_BASE ?? 10);
const zz = i => '08985701' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const receipt = { ticket: `SCRUM-${T} part 1`, sha, startedAt: new Date().toISOString(), phase: 'preflight',
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
  receipt.requests.push({ method, path: path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), status: response.status(), ...(response.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: response.status(), body };
};

// ZZ TEST only; each confirmed unused before use.
const numbers = { sA: zz(0), sB: zz(1), sX: zz(2), nA: zz(3), dA: zz(4), dB: zz(5), cA: zz(6), eA: zz(7) };
receipt.numbers = numbers;
const LANDLINE = '021234567';
const e164 = n => '+66' + n.replace(/^0/, '');
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const RUN = String(process.argv[3] ?? 'out').replace(/\D/g, '') || '00';
const childName = tag => `ZZ TEST SCRUM-${T} child ${tag}${RUN}`;
const guardianName = tag => `ZZ TEST SCRUM-${T} guardian ${tag}${RUN}`;
const CHANNELS = ['WhatsApp', 'Telegram', 'LINE'];
const CHANNEL_KEY = { WhatsApp: 'whatsapp', Telegram: 'telegram', LINE: 'line' };
const LINE_EN = ch => `This is my ${ch} number — send messages about my child here.`;
const LINE_TH = ch => `นี่คือหมายเลข ${ch} ของฉัน — ส่งข้อความเกี่ยวกับลูกของฉันมาที่หมายเลขนี้`;
const LINE_RU = ch => `Это мой номер ${ch} — присылайте сообщения о моём ребёнке сюда.`;
const NEEDED_EN = 'Add the number we can message you on about your child.';
const INVALID_EN = "This doesn't look like a mobile number that can receive messages — please check it.";
const INVALID_TH = 'หมายเลขนี้ดูไม่เหมือนหมายเลขมือถือที่รับข้อความได้ — กรุณาตรวจสอบ';
const GATE_CONFIRM = 'Parent must confirm that the number is the one for their messaging channel on the customer screen.';
const GATE_EMPTY = 'Parent must give the number for messages about their child on the customer screen.';
const GATE_INVALID = "The parent's number doesn't look like a mobile that can receive messages — check it with them.";
const knownSales = new Set();
let browser = null, till = null, display = null, station = null, branchId = null, failed = false;
/** The registration body the till sent in pass s, kept in memory only (ZZ TEST values), for the api refusals of pass a. */
let templateBody = null;

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
const baseMasks = page => [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
  page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
  page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/)];
const shot = async (page, name, extraMasks = []) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [...baseMasks(page), ...extraMasks] });
  console.log('picture', name);
  return name;
};
const point = (key, pass, pictures, shows, seen = {}) => { receipt.points[key] = { pass, pictures, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what); };

/** What the till itself wrote (ZZ TEST values only), newest last. */
const tillWrites = [];
function watchWrites(page) {
  page.on('request', r => {
    if (r.method() === 'GET') return;
    const path = new URL(r.url()).pathname;
    const reg = path === '/api/checkin/registrations';
    const edit = /^\/api\/checkin\/checkins\/[0-9a-f-]{36}$/.test(path);
    if (!['/api/sales'].includes(path) && !reg && !edit) return;
    let body = null; try { body = r.postDataJSON(); } catch { /* not json */ }
    if (reg && body) templateBody ??= body;
    tillWrites.push({ at: receipt.phase, method: r.method(), path: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'),
      ...(reg ? { guardianPhone: body?.guardianPhone ?? null, contactChannel: body?.contactChannel ?? null, contactConfirmation: body?.contactConfirmation ?? null } : {}),
      ...(edit ? { fields: Object.keys(body ?? {}), guardianPhone: body?.guardianPhone, contactChannel: body?.contactChannel, guardianName: body?.guardianName } : {}) });
  });
}
const writesSince = mark => tillWrites.slice(mark);

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
async function setFieldNumber(scope, number) {
  const tel = scope.locator('input[type="tel"]');
  if (await tel.count()) { await tel.first().fill(number.replace(/^0/, '')); return 'typed'; }
  await scope.getByRole('button', { name: 'Clear', exact: true }).last().click();
  await keypad(scope, number.replace(/^0/, ''));
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

async function firstScreen(surface, number, channel) {
  await landing(surface).waitFor();
  if (await surface.getByTestId('language-choice').isVisible()) await surface.getByTestId('language-choice-en').click();
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await keypad(scope, number);
  if (channel) await scope.getByTitle(channel, { exact: true }).click();
  return { scope, channels: await channelState(scope) };
}
async function walkIn(scope) {
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  await offer.waitFor();
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

// ---- What the form, the status list and the gate say about the number ----
/** The confirm line of a form (the till's customer half, the staff copy, or the display). */
async function confirmLine(scope, testId) {
  const box = scope.getByTestId(testId);
  const count = await box.count();
  if (!count) return { shown: false };
  const label = box.first().locator('xpath=ancestor::label[1]');
  return { shown: true, text: flat(await label.innerText()), state: await box.first().getAttribute('data-state'),
    disabled: await box.first().isDisabled(),
    needed: (await scope.getByTestId('consent-contact-needed').count()) ? flat(await scope.getByTestId('consent-contact-needed').first().innerText()) : null,
    invalid: (await scope.getByTestId('consent-contact-invalid').count()) ? flat(await scope.getByTestId('consent-contact-invalid').first().innerText()) : null };
}
/** The staff side: the status list's number row, the gate's blockers and Continue to payment. */
async function staffSide() {
  const status = till.getByTestId('consent-contact-status');
  const before = till.locator('div.rounded-2xl').filter({ has: till.getByText('Before payment', { exact: true }) }).last();
  const blockers = (await before.count()) ? (await before.locator('li').allInnerTexts()).map(t => flat(t).replace(/^•\s*/, '')) : [];
  const cont = till.getByRole('button', { name: 'Continue to payment', exact: true });
  return { status: (await status.count()) ? flat(await status.first().innerText()) : null, blockers,
    continueEnabled: (await cont.count()) ? await cont.first().isEnabled() : null };
}
const settle = () => till.waitForTimeout(500);
/** The gate's blocking reasons, without its standing note that a child needs drop-off or nanny supervision. */
const reasons = s => s.staff.blockers.filter(b => !/needs (drop-off|nanny) supervision\.?$/.test(b));

async function continueToPayment(tag) {
  const [registered] = await Promise.all([
    till.waitForResponse(r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST', { timeout: 60000 }),
    till.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  const sent = registered.request().postDataJSON();
  const reg = await registered.json().catch(() => null);
  receipt.created.push({ kind: 'registration', id: reg?.id ?? null, pass: tag }); save();
  return { status: registered.status(), sent: { guardianPhone: sent?.guardianPhone ?? null, contactChannel: sent?.contactChannel ?? null, contactConfirmation: sent?.contactConfirmation ?? null }, reg };
}
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
const registrationOf = async id => (await call('GET', '/checkin/registrations/' + id)).body;
const contactOf = reg => ({ id: reg?.id, guardianName: reg?.guardianName, guardianPhone: reg?.guardianPhone, contactChannel: reg?.contactChannel,
  contactConfirmedAt: reg?.contactConfirmedAt, contactConfirmedBy: reg?.contactConfirmedBy });
async function auditOf(regId) {
  const r = await call('GET', `/audit?entityType=registration&entityId=${regId}&limit=50`);
  const rows = r.body?.entries ?? r.body?.rows ?? [];
  const pick = keys => obj => obj ? Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k))) : null;
  const keep = pick(['guardianName', 'guardianPhone', 'contactChannel', 'contactConfirmedAt', 'contactConfirmedBy', 'event']);
  return { status: r.status, rows: rows.map(e => ({ action: e.action, createdAt: e.createdAt, before: keep(e.before), after: keep(e.after) })) };
}
/** A picture of read-back facts: a plain table, rendered in its own page. */
async function factsPicture(name, title, rows) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 300 } });
  const esc = s => String(s ?? 'null').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:16px;background:#fff;color:#111"><h3 style="margin:0 0 8px">${esc(title)}</h3>
    <p style="margin:0 0 10px;color:#555;font-size:13px">Read ${esc(new Date().toISOString())} from ${esc(pos)} (staging, at ${esc(sha.slice(0, 9))}), the staging admin's own session. ZZ TEST values only.</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td style="font-family:Consolas,monospace">${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('')}</table></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  console.log('picture', name);
  return name;
}

/** After payment: "Check in now", so the child is in the park (released at cleanup). */
async function checkInNow(regId) {
  const now = till.getByRole('button', { name: 'Check in now', exact: true });
  await now.waitFor({ timeout: 20000 });
  await now.click();
  await expect.poll(async () => (await registrationOf(regId)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
  await till.waitForTimeout(1000);
  const next = till.getByRole('button', { name: 'Start New Sale' });
  if (await next.isVisible().catch(() => false)) await next.click();
}
/** The board's card of this run's child. */
async function boardCard(tag) {
  await till.goto('/');
  await landing(till).waitFor();
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
  assert.ok(found, 'the board shows this run\'s card');
  return card;
}
/** Board masks: every card that is not this proof's, the edit dialog's nanny chooser and change-log authors. */
const boardMasks = dialog => [till.locator('[class*="bg-card"]').filter({ hasNotText: `ZZ TEST SCRUM-${T}` }),
  ...(dialog ? [dialog.locator('div.space-y-1\\.5').filter({ has: till.getByText('Assigned nanny', { exact: true }) }), dialog.locator('li > div:last-child')] : [])];
/** One edit through the board's Edit registration dialog; returns the PATCH's status and the toast. */
async function boardEdit(tag, mutate, picture) {
  const card = await boardCard(tag);
  await card.scrollIntoViewIfNeeded();
  await till.getByRole('button', { name: `Edit ${childName(tag)}`, exact: true }).first().click();
  const dialog = till.getByRole('dialog', { name: 'Edit registration', exact: true });
  await dialog.waitFor();
  const shown = { phone: await dialog.locator('input[type="tel"]').first().inputValue(), channels: await channelState(dialog) };
  await mutate(dialog);
  const edited = { phone: await dialog.locator('input[type="tel"]').first().inputValue(), channels: await channelState(dialog) };
  await shot(till, picture, boardMasks(dialog));
  const [patched] = await Promise.all([
    till.waitForResponse(r => /^\/api\/checkin\/checkins\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname) && r.request().method() === 'PATCH', { timeout: 30000 }),
    dialog.getByRole('button', { name: 'Save changes', exact: true }).click(),
  ]);
  const sent = patched.request().postDataJSON();
  const body = await patched.json().catch(() => null);
  const toast = till.locator('[role="status"], li[data-sonner-toast], ol li').filter({ hasText: /Changes saved|Could not save|No changes/ }).first();
  const toastText = await toast.waitFor({ timeout: 10000 }).then(async () => flat(await toast.innerText())).catch(() => null);
  // The board reads itself again after the toast: give the card time to show the saved values (run 01's picture was early).
  await till.waitForTimeout(3000);
  const cardAfter = await till.locator('[class*="bg-card"]').filter({ hasText: childName(tag) }).last().innerText().then(flat).catch(() => null);
  await shot(till, picture.replace('.png', '-saved.png'), boardMasks(null));
  return { shown, edited, sent: Object.fromEntries(Object.entries(sent ?? {}).filter(([k]) => ['guardianPhone', 'contactChannel', 'guardianName'].includes(k))),
    status: patched.status(), changed: body?.changed ?? null, errorCode: body?.error?.code ?? null, errorMessage: body?.error?.message ?? null, toast: toastText,
    cardAfter: cardAfter?.slice(0, 400) ?? null };
}

// ---- pass s: split view, drop-off age, WhatsApp. Points 1, 2, 5a. ----
async function passSplit() {
  const tag = 's', A = numbers.sA, mark = tillWrites.length;
  const pics = [];
  phase('s: first screen on the till\'s customer half — number A, WhatsApp; walk-in; one child, no adult');
  await till.goto('/');
  const { scope } = await firstScreen(till, A, 'WhatsApp');
  await walkIn(scope);
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const nameField = till.getByPlaceholder('Full name', { exact: true }).first();
  await nameField.waitFor();
  const half = halfOf(nameField);
  await nameField.fill(childName(tag));
  await setAge(till, half, 6);
  await half.getByPlaceholder('Your full name', { exact: true }).waitFor();
  const requirement = flat(await half.innerText()).match(/Drop-off required|Nanny required|Registered for drop-off — no fee/)?.[0] ?? null;

  phase('s: guardian name, photo and the agreement ticks first, so only the number confirmation is left');
  await half.getByPlaceholder('Your full name', { exact: true }).fill(guardianName(tag));
  await half.getByRole('button', { name: 'Start camera', exact: true }).click();
  await half.getByRole('button', { name: 'Take photo', exact: true }).click();
  await half.getByAltText('Captured', { exact: true }).waitFor();
  for (const checkbox of await half.getByRole('checkbox').all()) {
    if (await checkbox.getAttribute('data-testid') === 'consent-contact-confirm') continue;
    await checkbox.check();
  }
  await settle();
  const seen = { requirement, steps: {} };
  const step = async (key, picture) => {
    await settle();
    const s = { form: await confirmLine(half, 'consent-contact-confirm'), staff: await staffSide(), channels: await channelState(half) };
    seen.steps[key] = s;
    if (picture) {
      await half.getByTestId('consent-contact-confirm').scrollIntoViewIfNeeded().catch(() => {});
      pics.push(await shot(till, picture));
    }
    return s;
  };
  const tick = async () => { await half.getByTestId('consent-contact-confirm').click(); };
  const s1 = await step('1-unticked', '01a-split-confirm-line-unticked-continue-blocked.png');
  const checks = [];
  const check = (what, ok) => { checks.push({ what, ok }); if (!ok) console.log('CHECK FAILED', what); };
  check('line shown under the number, WhatsApp, unticked', s1.form.shown && s1.form.text === LINE_EN('WhatsApp') && s1.form.state === 'unchecked' && !s1.form.disabled);
  check('Continue to payment blocked, and the only reason is the confirmation', s1.staff.continueEnabled === false && reasons(s1).join('|') === GATE_CONFIRM);
  check('status list: WhatsApp number, not confirmed yet', /^WhatsApp number \+?[\d ]+ · not confirmed yet$/.test(s1.staff.status ?? ''));

  phase('s: the family ticks it');
  await tick();
  const s2 = await step('2-ticked', '01b-split-ticked-status-confirmed-by-family.png');
  check('ticked; status reads confirmed by the family; Continue open', s2.form.state === 'checked' && /· confirmed by the family$/.test(s2.staff.status ?? '') && s2.staff.continueEnabled === true && reasons(s2).length === 0);

  phase('s: switch the channel to Telegram');
  await half.getByTitle('Telegram', { exact: true }).click();
  const s3 = await step('3-telegram', '01c-split-telegram-clears-tick.png');
  check('Telegram clears the tick and the line names Telegram; gate blocked again', s3.form.state === 'unchecked' && s3.form.text === LINE_EN('Telegram') && /^Telegram number .* · not confirmed yet$/.test(s3.staff.status ?? '') && s3.staff.continueEnabled === false && s3.staff.blockers.includes(GATE_CONFIRM));

  phase('s: (defect hunt) back to WhatsApp without ticking — does the earlier tick come back?');
  await half.getByTitle('WhatsApp', { exact: true }).click();
  const s3b = await step('3b-back-to-whatsapp', '01c2-split-back-to-whatsapp.png');
  if (s3b.form.state === 'checked') odd('Split view: switching the channel back to the one the family ticked for brings the tick back without a new tick (Telegram, then WhatsApp again), and the gate opens', { status: s3b.staff.status, continueEnabled: s3b.staff.continueEnabled });
  await half.getByTitle('Telegram', { exact: true }).click();
  await settle();

  phase('s: tick on Telegram, then edit the number');
  await tick();
  const s4a = await step('4a-ticked-telegram');
  check('ticked again on Telegram', s4a.form.state === 'checked' && /^Telegram number .* · confirmed by the family$/.test(s4a.staff.status ?? ''));
  await setFieldNumber(half, numbers.sX);
  const s4 = await step('4-number-edited', '01d-split-number-edited-clears-tick.png');
  check('editing the number clears the tick; gate blocked', s4.form.state === 'unchecked' && /not confirmed yet$/.test(s4.staff.status ?? '') && s4.staff.continueEnabled === false && s4.staff.blockers.includes(GATE_CONFIRM));

  phase('s: (defect hunt) put the confirmed number back — does the tick come back?');
  await setFieldNumber(half, A);
  const s4b = await step('4b-number-back', '01d2-split-number-put-back.png');
  if (s4b.form.state === 'checked') odd('Split view: typing the confirmed number back brings the tick back without a new tick, and the gate opens', { status: s4b.staff.status, continueEnabled: s4b.staff.continueEnabled });

  phase('s: a landline');
  await setFieldNumber(half, LANDLINE);
  const s5 = await step('5-landline', '01e-split-landline-cannot-tick.png');
  await half.getByTestId('consent-contact-confirm').click({ force: true, timeout: 3000 }).catch(() => {});
  const s5b = await step('5b-landline-after-press');
  check('landline: the box is greyed out, cannot be ticked, the form says why, the gate says why', s5.form.disabled === true && s5.form.state === 'unchecked' && s5b.form.state === 'unchecked' && s5.form.invalid === INVALID_EN && s5.staff.blockers.includes(GATE_INVALID) && s5.staff.continueEnabled === false && /doesn't look like a mobile that can receive messages$/.test(s5.staff.status ?? ''));

  phase('s: an empty number');
  await setFieldNumber(half, '');
  const s6 = await step('6-empty', '01f-split-empty-cannot-tick.png');
  await half.getByTestId('consent-contact-confirm').click({ force: true, timeout: 3000 }).catch(() => {});
  const s6b = await step('6b-empty-after-press');
  check('empty: cannot be ticked, the form asks for the number, the gate says why', s6.form.disabled === true && s6b.form.state === 'unchecked' && s6.form.needed === NEEDED_EN && s6.staff.blockers.includes(GATE_EMPTY) && s6.staff.continueEnabled === false && /no number yet$/.test(s6.staff.status ?? ''));

  phase('s: number A and WhatsApp again, the family ticks, Continue to payment');
  await setFieldNumber(half, A);
  await half.getByTitle('WhatsApp', { exact: true }).click();
  const s7a = await step('7a-restored');
  if (s7a.form.state === 'checked') odd('Split view: number A on WhatsApp came back ticked without a new tick', { status: s7a.staff.status });
  else await tick();
  const s7 = await step('7-final', '01g-split-final-ticked-whatsapp.png');
  check('final: WhatsApp line ticked, confirmed by the family, Continue open', s7.form.state === 'checked' && s7.form.text === LINE_EN('WhatsApp') && /^WhatsApp number .* · confirmed by the family$/.test(s7.staff.status ?? '') && s7.staff.continueEnabled === true);
  seen.checks = checks;
  point('1', checks.every(c => c.ok), pics, 'Till split view, customer half (drop-off age 6): the confirm line under the number, unticked; Continue blocked with only the number reason; tick -> confirmed by the family; Telegram clears it and the line names Telegram; an edited number clears it; a landline and an empty number cannot be ticked and the form and the gate say why', seen);

  const written = await continueToPayment(tag);
  assert.equal(written.status, 200);
  const sale = await saleWritten('dropoff-ticket-sale');
  phase('s: pay cash');
  await payCash();
  await till.waitForTimeout(1200);
  const paidPic = await shot(till, '02a-split-paid-cash.png');
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  knownSales.add(sale.id);
  const reg = await registrationOf(written.reg.id);
  const audit = await auditOf(written.reg.id);
  const create = audit.rows.find(r => r.action === 'registration.create');
  const p2 = { sentByTheTill: written.sent, registration: contactOf(reg), sale: { id: paid.id, status: paid.status, receipt: paid.receiptNumber ?? null, grossSatang: paid.totals?.grossSatang ?? null }, auditCreate: create ?? null, auditStatus: audit.status };
  const ok2 = written.sent.contactConfirmation?.by === 'family' && reg.guardianPhone === e164(A) && reg.contactChannel === 'whatsapp'
    && typeof reg.contactConfirmedAt === 'string' && reg.contactConfirmedBy === 'family' && paid.status === 'finalised'
    && create?.after?.contactConfirmedAt === reg.contactConfirmedAt && create?.after?.contactConfirmedBy === 'family' && create?.after?.guardianPhone === e164(A);
  const factsPic = await factsPicture('02b-split-registration-and-audit-readback.png', 'SCRUM-857 point 2 — the split-view registration read back (GET /api/checkin/registrations/:id) and its registration.create audit row (GET /api/audit)', [
    ['registration id', reg.id], ['guardianName', reg.guardianName], ['guardianPhone', reg.guardianPhone], ['contactChannel', reg.contactChannel],
    ['contactConfirmedAt', reg.contactConfirmedAt], ['contactConfirmedBy', reg.contactConfirmedBy],
    ['till sent contactConfirmation', written.sent.contactConfirmation], ['sale', `${paid.id} ${paid.status} ${paid.receiptNumber ?? ''} ${paid.totals?.grossSatang ?? ''} satang`],
    ['audit registration.create after', create?.after ?? 'not found']]);
  point('2', ok2, [paidPic, factsPic], 'Cash sale done; the registration reads back the number (+66), WhatsApp, contactConfirmedAt set and contactConfirmedBy family; the registration.create audit row carries the same', p2);

  phase('s: check in');
  await checkInNow(written.reg.id);
  phase('s: board — edit the guardian number (point 5a)');
  let edit = null, ok5 = false;
  try {
    edit = await boardEdit(tag, async dialog => { await setFieldNumber(dialog, numbers.sB); }, '05a-board-edit-number.png');
    const after = await registrationOf(written.reg.id);
    const audit2 = await auditOf(written.reg.id);
    const update = audit2.rows.filter(r => r.action === 'registration.update').at(0) ?? null;
    edit.registrationAfter = contactOf(after); edit.auditUpdate = update;
    ok5 = edit.status === 200 && after.guardianPhone === e164(numbers.sB) && after.contactConfirmedAt === null && after.contactConfirmedBy === null
      && update?.before?.contactConfirmedAt === reg.contactConfirmedAt && update?.before?.contactConfirmedBy === 'family' && update?.after?.contactConfirmedAt === null && update?.after?.contactConfirmedBy === null;
    edit.facts = await factsPicture('05a-board-edit-number-readback.png', 'SCRUM-857 point 5a — after the board edit of the number: the registration and its registration.update audit row', [
      ['registration id', after.id], ['guardianPhone before', reg.guardianPhone], ['guardianPhone after', after.guardianPhone], ['contactChannel', after.contactChannel],
      ['contactConfirmedAt after', after.contactConfirmedAt], ['contactConfirmedBy after', after.contactConfirmedBy], ['PATCH status / toast', `${edit.status} / ${edit.toast}`],
      ['audit registration.update before', update?.before ?? 'not found'], ['audit registration.update after', update?.after ?? 'not found']]);
  } catch (error) { edit = { ...(edit ?? {}), failure: firstLine(error) }; }
  receipt.checks.edit5a = edit; save();
  return { regId: written.reg.id, ok5, edit };
}

// ---- pass a: the api refuses bad numbers (own ZZ TEST body, never a real family). Point 7. ----
async function passApi() {
  assert.ok(templateBody, 'pass s gave the till\'s own registration body shape');
  const cases = [
    { key: 'landline', guardianPhone: LANDLINE, contactConfirmation: null, expect: /landline or a service line/ },
    { key: 'invalid', guardianPhone: '0112345678', contactConfirmation: null, expect: /not a valid number for its country/ },
    { key: 'not-a-number', guardianPhone: 'abc', contactConfirmation: null, expect: /doesn't look right/ },
    { key: 'confirmation-without-number', guardianPhone: null, contactConfirmation: { confirmedAt: new Date().toISOString(), by: 'family' }, expect: /confirmed but none was given/ },
  ];
  const results = [];
  for (const c of cases) {
    phase(`a: POST /checkin/registrations — ${c.key}`);
    const id = randomUUID();
    const body = { ...templateBody, id, stationId: station.id, branchId,
      guardianName: `ZZ TEST SCRUM-${T} api guardian ${c.key}${RUN}`, guardianPhone: c.guardianPhone, contactChannel: 'whatsapp',
      contactConfirmation: c.contactConfirmation,
      children: templateBody.children.map(ch => ({ ...ch, checkinId: randomUUID(), ...('childId' in ch ? { childId: null } : {}), name: `ZZ TEST SCRUM-${T} api child ${c.key}${RUN}` })) };
    // Not tied to the member the till made for this run's family in pass s: a body of its own.
    delete body.memberId; delete body.visitId;
    const r = await call('POST', '/checkin/registrations', body);
    const read = await call('GET', '/checkin/registrations/' + id);
    if (read.status === 200) receipt.created.push({ kind: 'registration', id, pass: 'a', unexpected: true });
    results.push({ case: c.key, sentPhone: c.guardianPhone, sentConfirmation: Boolean(c.contactConfirmation), status: r.status, code: r.body?.error?.code ?? null, message: r.body?.error?.message ?? null,
      readBackStatus: read.status, ok: r.status === 400 && c.expect.test(r.body?.error?.message ?? '') && read.status === 404 });
  }
  const pic = await factsPicture('07-api-refusals.png', 'SCRUM-857 point 7 — POST /api/checkin/registrations refusals (own ZZ TEST body; nothing written: each id reads back 404)',
    results.map(r => [r.case, `${r.status} ${r.code ?? ''} — ${r.message ?? ''} · read-back ${r.readBackStatus}`]));
  point('7', results.every(r => r.ok), [pic], 'The api refuses a landline, an invalid number (and text that is not a number) and a confirmation with no number, each 400 with a plain line; nothing is written', { results });
}

// ---- pass n: split view, nanny age. Point 4. ----
async function passNanny() {
  const tag = 'n', A = numbers.nA;
  phase('n: first screen — number A, WhatsApp; one child aged 3, no adult');
  await till.goto('/');
  const { scope } = await firstScreen(till, A, 'WhatsApp');
  await walkIn(scope);
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const nameField = till.getByPlaceholder('Full name', { exact: true }).first();
  await nameField.waitFor();
  const half = halfOf(nameField);
  await nameField.fill(childName(tag));
  await setAge(till, half, 3);
  await half.getByPlaceholder('Your full name', { exact: true }).waitFor();
  const text = flat(await half.innerText());
  const seen = { nannyRequirementShown: /nanny/i.test(text), requirement: text.match(/Nanny required|Nanny|Drop-off required/)?.[0] ?? null };
  await half.getByPlaceholder('Your full name', { exact: true }).fill(guardianName(tag));
  await half.getByRole('button', { name: 'Start camera', exact: true }).click();
  await half.getByRole('button', { name: 'Take photo', exact: true }).click();
  await half.getByAltText('Captured', { exact: true }).waitFor();
  for (const checkbox of await half.getByRole('checkbox').all()) if (await checkbox.getAttribute('data-testid') !== 'consent-contact-confirm') await checkbox.check();
  await settle();
  seen.before = { form: await confirmLine(half, 'consent-contact-confirm'), staff: await staffSide() };
  await half.getByTestId('consent-contact-confirm').scrollIntoViewIfNeeded();
  const p1 = await shot(till, '04a-nanny-confirm-line-asked.png');
  await half.getByTestId('consent-contact-confirm').click();
  await settle();
  seen.after = { form: await confirmLine(half, 'consent-contact-confirm'), staff: await staffSide() };
  const p2 = await shot(till, '04b-nanny-ticked.png');
  const ok = seen.nannyRequirementShown && seen.before.form.shown && seen.before.form.text === LINE_EN('WhatsApp') && seen.before.form.state === 'unchecked'
    && seen.before.staff.continueEnabled === false && seen.before.staff.blockers.includes(GATE_CONFIRM)
    && seen.after.form.state === 'checked' && /confirmed by the family$/.test(seen.after.staff.status ?? '') && seen.after.staff.continueEnabled === true;
  point('4', ok, [p1, p2], 'Nanny age (3): the same confirm line is asked, Continue is blocked until the family ticks it; nothing written (backed out before Continue to payment)', seen);
  await till.getByRole('button', { name: 'Back', exact: true }).first().click().catch(() => {});
  await till.goto('/'); await landing(till).waitFor();
}

// ---- pass d: a separate paired display. Points 3, 6b, 5b. ----
async function passDisplay() {
  const tag = 'd', A = numbers.dA, B = numbers.dB;
  const pics = [], lang = { pics: [] };
  await till.goto('/');
  await pairDisplay();
  const page = display.page;
  phase('d: first screen on the display — number A, WhatsApp');
  const { scope } = await firstScreen(page, A, 'WhatsApp');
  await walkIn(scope);
  phase('d: one child, no adult; the form opens on the display');
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const consent = page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  await consent.getByPlaceholder('Full name', { exact: true }).fill(childName(tag));
  await setAge(page, consent, 6);
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByTestId('consent-care').waitFor();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByPlaceholder('Your full name', { exact: true }).waitFor();
  const seen = { steps: {} };
  const checks = [];
  const check = (what, ok) => { checks.push({ what, ok }); if (!ok) console.log('CHECK FAILED', what); };
  const dstep = async (key, picture) => {
    await page.waitForTimeout(600);
    const s = { form: await confirmLine(consent, 'public-consent-contact-confirm'),
      done: await consent.getByRole('button', { name: 'Done', exact: true }).count() ? await consent.getByRole('button', { name: 'Done', exact: true }).isEnabled() : 'not shown',
      continueShown: await consent.getByRole('button', { name: 'Continue', exact: true }).count() > 0 };
    seen.steps[key] = s;
    if (picture) { await consent.getByTestId('public-consent-contact-confirm').scrollIntoViewIfNeeded().catch(() => {}); pics.push(await shot(page, picture)); }
    return s;
  };
  const d1 = await dstep('1-agreements', '03a-display-agreements-confirm-line-unticked.png');
  check('display agreements step: the confirm line, WhatsApp, unticked', d1.form.shown && d1.form.text === LINE_EN('WhatsApp') && d1.form.state === 'unchecked' && !d1.form.disabled);

  phase('d: language switch — Thai, then Russian, then English (point 6b)');
  const switchTo = async label => {
    await page.getByRole('button', { name: /Change language|เปลี่ยนภาษา|更改语言|Сменить язык|Changer de langue/ }).first().click();
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(600);
  };
  await switchTo('ไทย');
  const th = await confirmLine(consent, 'public-consent-contact-confirm');
  const thRaw = /superviseConsent\.|\{\{channel\}\}/.test(await consent.innerText());
  await consent.getByTestId('public-consent-contact-confirm').scrollIntoViewIfNeeded();
  lang.pics.push(await shot(page, '06b-display-thai-confirm-line.png'));
  await setFieldNumber(consent, LANDLINE);
  const thInvalid = await confirmLine(consent, 'public-consent-contact-confirm');
  lang.pics.push(await shot(page, '06c-display-thai-landline-line.png'));
  await setFieldNumber(consent, A);
  await switchTo('Русский');
  const ru = await confirmLine(consent, 'public-consent-contact-confirm');
  const ruRaw = /superviseConsent\.|\{\{channel\}\}/.test(await consent.innerText());
  lang.pics.push(await shot(page, '06d-display-russian-confirm-line.png'));
  await switchTo('English');
  lang.seen = { thai: th, thaiRawKey: thRaw, thaiLandline: thInvalid, russian: ru, russianRawKey: ruRaw };
  lang.ok = th.text === LINE_TH('WhatsApp') && !thRaw && thInvalid.invalid === INVALID_TH && thInvalid.disabled === true && ru.text === LINE_RU('WhatsApp') && !ruRaw;

  phase('d: on the display, a landline and an empty number cannot be ticked');
  await setFieldNumber(consent, LANDLINE);
  const d2 = await dstep('2-landline', '03b-display-landline-cannot-tick.png');
  await setFieldNumber(consent, '');
  const d3 = await dstep('3-empty');
  check('display: a landline greys the box out with the invalid line; an empty number with the needed line', d2.form.disabled === true && d2.form.invalid === INVALID_EN && d3.form.disabled === true && d3.form.needed === NEEDED_EN);
  await setFieldNumber(consent, A);

  phase('d: the family names the guardian and gives the agreement ticks, but not the number tick; Continue');
  await consent.getByPlaceholder('Your full name', { exact: true }).fill(guardianName(tag));
  for (const checkbox of await consent.getByRole('checkbox').all()) if (await checkbox.getAttribute('data-testid') !== 'public-consent-contact-confirm') await checkbox.check();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  phase('d: staff take the photo in Private child details; the staff copy shows the tick read-only');
  await till.getByRole('button', { name: 'Private child details', exact: true }).click();
  const details = till.getByRole('dialog', { name: 'Private child details', exact: true });
  await expect(details.getByPlaceholder('Your full name', { exact: true })).toHaveValue(guardianName(tag), { timeout: 20000 });
  await details.getByRole('button', { name: 'Start camera', exact: true }).click();
  await details.getByRole('button', { name: 'Take photo', exact: true }).click();
  await details.getByAltText('Captured', { exact: true }).waitFor();
  await till.waitForTimeout(800);
  const staff1 = await confirmLine(details, 'consent-contact-confirm');
  await details.getByTestId('consent-contact-confirm').click({ force: true, timeout: 3000 }).catch(() => {});
  await till.waitForTimeout(500);
  const staff1b = await confirmLine(details, 'consent-contact-confirm');
  await details.getByTestId('consent-contact-confirm').scrollIntoViewIfNeeded();
  pics.push(await shot(till, '03c-staff-private-copy-read-only-unticked.png'));
  await details.getByRole('button', { name: 'Close', exact: true }).click();
  // The till's page is hidden from roles while the dialog closes (run 02 read Continue to payment as absent): wait.
  await details.waitFor({ state: 'hidden' }); await till.waitForTimeout(600);
  const gate1 = await staffSide();
  const d4 = await dstep('4-saved-unconfirmed', '03d-display-done-disabled-until-tick.png');
  seen.staffCopyBefore = staff1; seen.staffCopyAfterStaffPress = staff1b; seen.gateBefore = gate1;
  check('staff copy: the tick is read-only, "(the family confirms this on their screen)", and a staff press does nothing', staff1.shown && staff1.disabled === true && staff1.state === 'unchecked' && /\(the family confirms this on their screen\)$/.test(staff1.text) && staff1b.state === 'unchecked');
  check('display: Done shown but disabled while the number is not ticked; till gate says why', d4.done === false && gate1.continueEnabled === false && gate1.blockers.includes(GATE_CONFIRM));

  phase('d: the family ticks the number on the display and presses Continue');
  await consent.getByTestId('public-consent-contact-confirm').click();
  const d5a = await dstep('5a-ticked-not-sent');
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  const d5 = await dstep('5-ticked-sent', '03e-display-ticked-done-enabled.png');
  const gate2 = await staffSide();
  check('display: ticking needs Continue, then Done is enabled; the till status reads confirmed by the family', d5a.form.state === 'checked' && d5.done === true && /^WhatsApp number .* · confirmed by the family$/.test(gate2.status ?? ''));

  phase('d: the family edits the number on the display to B — the tick clears');
  await setFieldNumber(consent, B);
  const d6 = await dstep('6-number-edited', '03f-display-number-edited-clears-tick.png');
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  const d6b = await dstep('6b-edited-sent');
  const gate3 = await staffSide();
  check('display: editing the number clears the tick, Done is not offered, the till reads not confirmed', d6.form.state === 'unchecked' && d6.done !== true && d6b.done === false && /not confirmed yet$/.test(gate3.status ?? '') && gate3.blockers.includes(GATE_CONFIRM));

  phase('d: the family ticks number B, Continue; staff copy shows it ticked, read-only');
  await consent.getByTestId('public-consent-contact-confirm').click();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  const d7 = await dstep('7-final');
  await till.getByRole('button', { name: 'Private child details', exact: true }).click();
  await details.waitFor();
  await till.waitForTimeout(800);
  const staff2 = await confirmLine(details, 'consent-contact-confirm');
  await details.getByTestId('consent-contact-confirm').scrollIntoViewIfNeeded();
  pics.push(await shot(till, '03g-staff-private-copy-ticked-read-only.png'));
  await details.getByRole('button', { name: 'Close', exact: true }).click();
  await details.waitFor({ state: 'hidden' }); await till.waitForTimeout(600);
  const gate4 = await staffSide();
  seen.staffCopyAfter = staff2; seen.gateAfter = gate4;
  check('final: Done enabled; staff copy ticked and read-only "(confirmed by the family)"; till status confirmed by the family', d7.done === true && staff2.state === 'checked' && staff2.disabled === true && /\(confirmed by the family\)$/.test(staff2.text) && /· confirmed by the family$/.test(gate4.status ?? ''));
  await consent.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(consent.getByText('Thank you. The team will complete the staff checks.', { exact: true })).toBeVisible({ timeout: 20000 }).catch(() => odd('the display did not show its thank-you line after Done'));
  phase('d: Continue to payment; cash');
  const written = await continueToPayment(tag);
  assert.equal(written.status, 200);
  const sale = await saleWritten('dropoff-ticket-sale');
  await payCash();
  await till.waitForTimeout(1200);
  pics.push(await shot(till, '03h-display-pass-paid-cash.png'));
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  knownSales.add(sale.id);
  const reg = await registrationOf(written.reg.id);
  const audit = await auditOf(written.reg.id);
  const create = audit.rows.find(r => r.action === 'registration.create');
  seen.sentByTheTill = written.sent; seen.registration = contactOf(reg); seen.auditCreate = create ?? null;
  seen.sale = { id: paid.id, status: paid.status, receipt: paid.receiptNumber ?? null, grossSatang: paid.totals?.grossSatang ?? null };
  check('read-back: number B (+66), WhatsApp, confirmed by the family; audit create carries it; sale finalised', reg.guardianPhone === e164(B) && reg.contactChannel === 'whatsapp' && typeof reg.contactConfirmedAt === 'string' && reg.contactConfirmedBy === 'family'
    && written.sent.contactConfirmation?.by === 'family' && create?.after?.contactConfirmedBy === 'family' && create?.after?.contactConfirmedAt === reg.contactConfirmedAt && paid.status === 'finalised');
  pics.push(await factsPicture('03i-display-registration-and-audit-readback.png', 'SCRUM-857 point 3 — the paired-display registration read back and its registration.create audit row', [
    ['registration id', reg.id], ['guardianPhone', reg.guardianPhone], ['contactChannel', reg.contactChannel], ['contactConfirmedAt', reg.contactConfirmedAt], ['contactConfirmedBy', reg.contactConfirmedBy],
    ['till sent contactConfirmation', written.sent.contactConfirmation], ['sale', `${paid.id} ${paid.status} ${paid.receiptNumber ?? ''} ${paid.totals?.grossSatang ?? ''} satang`], ['audit registration.create after', create?.after ?? 'not found']]));
  seen.checks = checks;
  point('3', checks.every(c => c.ok), pics, 'Paired display: the confirm line on the agreements step; Done disabled until the family ticks it (and presses Continue); editing the number clears it; the staff copy shows it read-only; cash; read-back and audit as in point 2', seen);
  point('6b', lang.ok, lang.pics, 'Display language switch: the confirm line in Thai and in Russian with the channel filled in, the Thai landline line, no raw key', lang.seen);
  await dropDisplay();
  phase('d: check in; board — edit the channel only (point 5b)');
  await checkInNow(written.reg.id);
  let edit = null, ok5 = false;
  try {
    edit = await boardEdit(tag, async dialog => { await dialog.getByTitle('Telegram', { exact: true }).click(); }, '05b-board-edit-channel.png');
    const after = await registrationOf(written.reg.id);
    const update = (await auditOf(written.reg.id)).rows.filter(r => r.action === 'registration.update').at(0) ?? null;
    edit.registrationAfter = contactOf(after); edit.auditUpdate = update;
    ok5 = edit.status === 200 && after.contactChannel === 'telegram' && after.guardianPhone === e164(B) && after.contactConfirmedAt === null && after.contactConfirmedBy === null
      && update?.before?.contactConfirmedBy === 'family' && update?.after?.contactConfirmedAt === null && !('guardianPhone' in (edit.sent ?? {}));
    edit.facts = await factsPicture('05b-board-edit-channel-readback.png', 'SCRUM-857 point 5b — after the board edit of the channel only', [
      ['registration id', after.id], ['the PATCH carried', edit.sent], ['guardianPhone', after.guardianPhone], ['contactChannel before / after', `${reg.contactChannel} / ${after.contactChannel}`],
      ['contactConfirmedAt after', after.contactConfirmedAt], ['contactConfirmedBy after', after.contactConfirmedBy], ['PATCH status / toast', `${edit.status} / ${edit.toast}`],
      ['audit registration.update before', update?.before ?? 'not found'], ['audit registration.update after', update?.after ?? 'not found']]);
  } catch (error) { edit = { ...(edit ?? {}), failure: firstLine(error) }; }
  receipt.checks.edit5b = edit; save();
  return { ok5, edit };
}

// ---- pass c: a third family, for a name-only edit and clearing the number. Point 5c. ----
async function passClear() {
  const tag = 'c', A = numbers.cA;
  phase('c: split view, number A, WhatsApp, age 6; the family ticks; cash');
  await till.goto('/');
  const { scope } = await firstScreen(till, A, 'WhatsApp');
  await walkIn(scope);
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const nameField = till.getByPlaceholder('Full name', { exact: true }).first();
  await nameField.waitFor();
  const half = halfOf(nameField);
  await nameField.fill(childName(tag));
  await setAge(till, half, 6);
  await half.getByPlaceholder('Your full name', { exact: true }).fill(guardianName(tag));
  await half.getByRole('button', { name: 'Start camera', exact: true }).click();
  await half.getByRole('button', { name: 'Take photo', exact: true }).click();
  await half.getByAltText('Captured', { exact: true }).waitFor();
  for (const checkbox of await half.getByRole('checkbox').all()) await checkbox.check();
  await settle();
  const written = await continueToPayment(tag);
  assert.equal(written.status, 200);
  const sale = await saleWritten('dropoff-ticket-sale');
  await payCash();
  knownSales.add(sale.id);
  const reg = await registrationOf(written.reg.id);
  assert.equal(reg.contactConfirmedBy, 'family');
  await checkInNow(written.reg.id);
  const seen = { registrationBefore: contactOf(reg) };
  phase('c: board — a name-only edit keeps the confirmation');
  seen.nameEdit = await boardEdit(tag, async dialog => {
    await dialog.locator('div.space-y-1\\.5').filter({ has: till.getByText('Parent name', { exact: true }) }).locator('input').first().fill(guardianName(tag) + ' renamed');
  }, '05c-board-edit-name-only.png');
  const afterName = await registrationOf(written.reg.id);
  seen.afterName = contactOf(afterName);
  phase('c: board — clear the number');
  seen.clearEdit = await boardEdit(tag, async dialog => { await setFieldNumber(dialog, ''); }, '05d-board-clear-number.png');
  const afterClear = await registrationOf(written.reg.id);
  const update = (await auditOf(written.reg.id)).rows.filter(r => r.action === 'registration.update');
  seen.afterClear = contactOf(afterClear); seen.auditUpdates = update;
  const pic = await factsPicture('05e-board-name-edit-and-clear-readback.png', 'SCRUM-857 point 5c — a name-only board edit keeps the confirmation; clearing the number saves and withdraws it', [
    ['registration id', reg.id], ['before: phone / confirmed', `${reg.guardianPhone} / ${reg.contactConfirmedBy} ${reg.contactConfirmedAt}`],
    ['name edit: PATCH status / toast', `${seen.nameEdit.status} / ${seen.nameEdit.toast}`], ['after name edit: name / confirmed', `${afterName.guardianName} / ${afterName.contactConfirmedBy} ${afterName.contactConfirmedAt}`],
    ['clear: the PATCH carried', seen.clearEdit.sent], ['clear: PATCH status / toast', `${seen.clearEdit.status} / ${seen.clearEdit.toast}`],
    ['after clear: phone / confirmedAt / confirmedBy', `${afterClear.guardianPhone} / ${afterClear.contactConfirmedAt} / ${afterClear.contactConfirmedBy}`],
    ['audit registration.update rows (newest first)', update.map(u => ({ before: u.before, after: u.after }))]]);
  const ok = seen.nameEdit.status === 200 && afterName.contactConfirmedBy === 'family' && afterName.contactConfirmedAt === reg.contactConfirmedAt
    && seen.clearEdit.status === 200 && afterClear.guardianPhone === null && afterClear.contactConfirmedAt === null && afterClear.contactConfirmedBy === null && /Changes saved/.test(seen.clearEdit.toast ?? '');
  return { ok, seen, pics: ['05c-board-edit-name-only.png', '05d-board-clear-number.png', '05d-board-clear-number-saved.png', pic] };
}

// ---- pass e: an ordinary sale, one child with an adult. Point 6a. ----
async function passOrdinary() {
  const A = numbers.eA, mark = tillWrites.length;
  phase('e: ordinary sale — number on the first screen, one adult and one child');
  await dropDisplay().catch(() => {});
  await till.goto('/');
  const { scope } = await firstScreen(till, A, null);
  await walkIn(scope);
  await ticket(1, 1);
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  const sale = await saleWritten('ordinary-ticket-sale');
  await till.waitForTimeout(1500);
  const bodyText = flat(await till.locator('body').innerText());
  const seen = { childrenPlayingAloneShown: await till.getByRole('heading', { name: 'Children playing alone', exact: true }).count(),
    confirmLineTill: await till.getByTestId('consent-contact-confirm').count(), statusRow: await till.getByTestId('consent-contact-status').count(),
    confirmWordsAnywhere: /send messages about my child/.test(bodyText) };
  const p1 = await shot(till, '06a-ordinary-sale-payment-no-confirm-line.png');
  await payCash();
  await till.waitForTimeout(1200);
  const p2 = await shot(till, '06a2-ordinary-sale-paid-cash.png');
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  knownSales.add(sale.id);
  seen.sale = { id: paid.id, status: paid.status, receipt: paid.receiptNumber ?? null, grossSatang: paid.totals?.grossSatang ?? null };
  seen.tillWrites = writesSince(mark);
  seen.registrationsWritten = seen.tillWrites.filter(w => w.path === '/api/checkin/registrations').length;
  const ok = seen.childrenPlayingAloneShown === 0 && seen.confirmLineTill === 0 && seen.statusRow === 0 && !seen.confirmWordsAnywhere && paid.status === 'finalised' && seen.registrationsWritten === 0;
  await till.goto('/'); await landing(till).waitFor();
  return { ok, seen, pics: [p1, p2] };
}

const attempt = async (key, fn) => {
  try { return await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    if (display) await shot(display.page, `failed-${key}-display.png`).catch(() => {});
    try {
      const dialogClose = till.getByRole('dialog').getByRole('button', { name: 'Close', exact: true });
      if (await dialogClose.count()) await dialogClose.first().click().catch(() => {});
      const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
      if (await paymentStep().isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) { await cancel.click(); await till.waitForTimeout(3000); }
    } catch { /* cleanup below reads the sales back */ }
    await dropDisplay().catch(() => {});
    await till.goto('/').catch(() => {});
    return null;
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

  // The synthetic reception camera: one flat grey frame, nobody's picture (kept outside the proof folder).
  const video = resolve(process.env.CAMERA_DIR ?? out, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
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
    const found = { files: urls.length, confirmTestIds: 0, publicConfirmTestIds: 0, confirmLineEn: 0 };
    for (const url of urls) {
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      found.confirmTestIds += text.split('consent-contact-status').length - 1;
      found.publicConfirmTestIds += text.split('public-consent-contact-confirm').length - 1;
      found.confirmLineEn += text.split('send messages about my child here').length - 1;
    }
    return found;
  });
  save();
  console.log('bundle', JSON.stringify(receipt.checks.bundle));
  assert.ok(receipt.checks.bundle.confirmTestIds > 0 && receipt.checks.bundle.publicConfirmTestIds > 0, 'the till serves the SCRUM-857 bundle');

  if (wanted.includes('s')) {
    const s = await attempt('s', passSplit);
    if (s) point('5a', s.ok5, [s.edit?.facts, '05a-board-edit-number.png', '05a-board-edit-number-saved.png'].filter(Boolean), 'Check-in board: editing the confirmed registration\'s guardian number saves and withdraws the confirmation (both fields null on read-back; the update audit row has the old values in before, nulls in after)', s.edit);
  }
  // Pass a takes its body shape from the till's own first registration: after s, or after d when s is not run.
  if (wanted.includes('a') && wanted.includes('s')) await attempt('a', passApi);
  if (wanted.includes('n')) await attempt('n', passNanny);
  if (wanted.includes('d')) {
    const d = await attempt('d', passDisplay);
    if (d) point('5b', d.ok5, [d.edit?.facts, '05b-board-edit-channel.png', '05b-board-edit-channel-saved.png'].filter(Boolean), 'Check-in board: editing only the channel withdraws the confirmation (both fields null), the number is untouched', d.edit);
  }
  if (wanted.includes('a') && !wanted.includes('s')) await attempt('a', passApi);
  if (wanted.includes('c')) {
    const c = await attempt('c', passClear);
    if (c) point('5c', c.ok, c.pics, 'Check-in board: a name-only edit keeps the confirmation; clearing the number saves ("Changes saved") and leaves phone and confirmation null', c.seen);
  }
  if (wanted.includes('e')) {
    const e = await attempt('e', passOrdinary);
    if (e) point('6a', e.ok, e.pics, 'Ordinary sale, one child with an adult: no confirm line or status row anywhere on the till, no registration written, paid in cash', e.seen);
  }
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
      for (const item of receipt.created.filter(i => i.kind === 'registration' && i.id)) await clean(`release / cancel own test child (${item.pass})`, async () => {
        const reg = await registrationOf(item.id);
        assert.ok(String(reg.guardianName).startsWith(`ZZ TEST SCRUM-${T}`), 'only this proof\'s own registration');
        // A child still waiting (registered, unpaid): the board's cancel, for this run's own registration only.
        if (reg.children.some(c => c.status === 'registered')) {
          const cancelled = await call('POST', `/checkin/registrations/${item.id}/cancel`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` });
          receipt.cleanup.push({ kind: 'cancel-waiting', registration: item.id, status: cancelled.status, code: cancelled.body?.error?.code ?? null });
        }
        for (const child of reg.children) {
          assert.ok(String(child.childName).startsWith(`ZZ TEST SCRUM-${T}`));
          if (child.status === 'in_park') {
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
        assert.ok(states.every(c => c.status !== 'in_park' && c.status !== 'registered'));
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
