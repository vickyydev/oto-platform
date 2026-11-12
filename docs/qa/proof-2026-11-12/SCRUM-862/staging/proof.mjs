// SCRUM-862 staging proof: a waiting drop-off booking can be cancelled from the till's
// "Add drop-off child" window, and yesterday's waiting bookings leave the list.
// Adapted from the committed SCRUM-863 harness (docs/qa/proof-2026-11-12/SCRUM-863/staging/proof.mjs).
// Own ZZ TEST till, ZZ TEST guardians and children, invented numbers (08986200xx), cash only.
// Only bookings this run made are cancelled, checked in or released; every other card is covered in pictures.
// No credential, pairing code or raw response body enters the receipt or the console.
//
//   node proof.mjs <sha> <out-dir>
// ZZ_BASE moves the invented numbers (08986200<base>..); the run asserts they are unused first.
// ONLY=<points> runs a subset (e.g. ONLY=4,6). NAME_SUFFIX is added to the ZZ TEST child and guardian names on a rerun.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const T = '862';
const base = Number(process.env.ZZ_BASE ?? 10);
const zz = i => '08986200' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const receipt = { ticket: `SCRUM-${T}`, sha, startedAt: new Date().toISOString(), phase: 'preflight',
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], cleanup: [] };
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
const numbers = { picker0: zz(0), bookA: zz(1), pickerA: zz(2), bookB: zz(3), pickerB: zz(4), ordinary: zz(5) };
receipt.numbers = numbers;
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const SUFFIX = process.env.NAME_SUFFIX ?? '';
const childName = tag => `ZZ TEST ${T} child ${tag}${SUFFIX}`;
const guardianName = tag => tag === 'a' ? `ZZ TEST ${T} guardian${SUFFIX}` : `ZZ TEST ${T} guardian ${tag}${SUFFIX}`;
const knownSales = new Set();
let browser = null, till = null, station = null, branchId = null, failed = false, meId = null;
const regs = {}; // tag -> { id, stayIds }

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
/**
 * Families can only show in the picker's cards and on the Check-in board: there, any card that is not a
 * ZZ TEST one is covered, so a real family never appears in a picture. Ticket, payment and order panels are left as they are.
 */
const strangers = async page => {
  const onBoard = await page.getByPlaceholder('Search child, parent or phone…').isVisible().catch(() => false);
  return [page.getByRole('dialog').locator('[class*="bg-card"]').filter({ hasNotText: 'ZZ TEST' }),
    ...(onBoard ? [page.locator('[class*="bg-card"]').filter({ hasNotText: 'ZZ TEST' })] : [])];
};
const shot = async (page, name, extra = []) => {
  const others = await strangers(page);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
      page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
      page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/),
      ...others, ...extra] });
  console.log('picture', name);
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
  await half.getByText('Phone number', { exact: true }).scrollIntoViewIfNeeded();
  const form = { phoneNumberLabel: await half.getByText('Phone number', { exact: true }).count(), numberFields: await half.locator('input[type="tel"]').count(),
    channels: (await Promise.all(['WhatsApp', 'Telegram', 'LINE'].map(async l => (await half.getByTitle(l, { exact: true }).count()) ? l : null))).filter(Boolean) };
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
  return { form, reg, sale };
}

/** The "Add drop-off child" window, opened from the Add to Sale step of a fresh walk-in. */
async function openPicker(number) {
  await walkIn(number);
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await till.getByRole('button', { name: 'Add drop-off child', exact: true }).click();
  const picker = till.getByRole('dialog').filter({ hasText: 'Bookings with a signed form' });
  await picker.waitFor();
  await till.waitForTimeout(2500); // the list is read from the platform when the window opens
  return picker;
}
const familyCard = (picker, tag) => picker.locator('div').filter({ hasText: `${guardianName(tag)}'s booking` }).filter({ has: till.getByRole('button', { name: 'Add sibling' }) }).last();
async function pickerFamilies(picker) {
  const text = flat(await picker.innerText());
  const names = [...text.matchAll(/([^.·]*?)'s booking/g)].map(m => m[1].trim());
  return { empty: /No bookings are waiting to be checked in\./.test(text), families: names.length, zzFamilies: names.filter(n => /ZZ TEST/.test(n)).length,
    ownFamilies: names.filter(n => n.includes(`ZZ TEST ${T} guardian`)) };
}
/** What the platform lists for today, with each child's day, read as the admin. */
async function waitingList() {
  const list = (await call('GET', `/checkin/registrations?branchId=${branchId}`)).body.registrations ?? [];
  const dayOf = iso => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(iso)) : null;
  const today = dayOf(new Date().toISOString());
  return { today, count: list.length, families: list.map(r => ({ zz: /^ZZ TEST/.test(r.guardianName ?? ''), own: (r.guardianName ?? '').startsWith(`ZZ TEST ${T}`), source: r.source,
    createdDay: dayOf(r.createdAt), childDays: r.children.filter(c => c.status === 'registered').map(c => dayOf(c.scheduledFor ?? r.createdAt)) })),
    earlierDay: list.filter(r => r.children.filter(c => c.status === 'registered').every(c => dayOf(c.scheduledFor ?? r.createdAt) < today)).length };
}

// ---- 1: the window as it opens now ----
async function point1() {
  phase('1: open the Add drop-off child window before this run creates anything');
  const listed = await waitingList();
  const picker = await openPicker(numbers.picker0);
  const seen = { platform: listed, window: await pickerFamilies(picker) };
  await shot(till, '01-picker-as-it-opens-today-only.png');
  const ok = seen.window.ownFamilies.length === 0 && listed.earlierDay === 0 && seen.window.families === listed.count;
  point('1', ok, '01-picker-as-it-opens-today-only.png', `The window lists ${seen.window.families} family(ies)${seen.window.empty ? ' ("No bookings are waiting to be checked in.")' : ''}; the platform lists ${listed.count} for ${listed.today}, ${listed.earlierDay} from an earlier day`, seen);
  await till.keyboard.press('Escape');
}

// ---- 2 and 3: a waiting booking, then Cancel booking ----
async function points2and3() {
  phase('2: drop-off booking a — form filled, Continue to payment, then the sale is cancelled unpaid');
  const { form, reg, sale } = await dropOffBooking('a', numbers.bookA, '02a-dropoff-form-booking-a-phone-field.png');
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  await shot(till, '02b-booking-a-at-payment-not-paid.png');
  // The family leaves before paying: staff cancel the sale at the till; the signed form stays.
  let leftHow = 'till Cancel';
  const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
  if (await cancel.isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    await till.waitForTimeout(1500);
    const confirmVoid = till.getByRole('alertdialog').or(till.getByRole('dialog')).last();
    if (await confirmVoid.isVisible().catch(() => false)) {
      receipt.checks.saleCancelDialog = flat(await confirmVoid.innerText()).slice(0, 300);
      await shot(till, '02b2-sale-cancel-confirm.png');
      const reason = confirmVoid.locator('input, textarea').first();
      if (await reason.count()) await reason.fill(`ZZ TEST SCRUM-${T} family left before paying`);
      const go = confirmVoid.getByRole('button', { name: /void|cancel sale|confirm|yes/i }).last();
      if (await go.isEnabled().catch(() => false)) await go.click();
    }
    await till.waitForTimeout(3000);
  } else leftHow = 'no Cancel on the payment step';
  let saleNow = (await call('GET', `/sales/${sale.id}`)).body.sale;
  if (saleNow.status !== 'voided') {
    leftHow += ` (sale still ${saleNow.status}; voided through the api as the harness cleanup does)`;
    assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} family left before paying` })).status, 200);
    saleNow = (await call('GET', `/sales/${sale.id}`)).body.sale;
  }
  knownSales.add(sale.id);
  const after = await registrationOf(reg.id);
  const stillWaiting = after.children.every(c => c.status === 'registered');
  receipt.checks.bookingA = { leftHow, saleStatus: saleNow.status, children: after.children.map(c => ({ name: c.childName, status: c.status })) }; save();
  const picker = await openPicker(numbers.pickerA);
  const card = familyCard(picker, 'a');
  await expect(card.getByText(childName('a'))).toBeVisible({ timeout: 20000 });
  const seen2 = { form, ...receipt.checks.bookingA, window: await pickerFamilies(picker),
    addToSale: await card.getByRole('button', { name: 'Add to sale' }).isEnabled(), cancelBooking: await card.getByRole('button', { name: 'Cancel booking' }).isEnabled() };
  await card.scrollIntoViewIfNeeded();
  await shot(till, '02c-picker-lists-waiting-booking-a.png');
  point('2', stillWaiting && saleNow.status === 'voided' && seen2.cancelBooking && form.phoneNumberLabel > 0, '02c-picker-lists-waiting-booking-a.png', 'A signed drop-off booking left unpaid (its sale cancelled) is listed with "Add to sale" and "Cancel booking"', seen2);

  phase('3: Cancel booking — the confirm asks for a reason');
  await card.getByRole('button', { name: 'Cancel booking' }).click();
  const confirm = till.getByRole('dialog').filter({ hasText: 'Cancel this waiting booking' });
  await confirm.waitFor();
  const press = confirm.getByRole('button', { name: /reason to cancel|Cancel the booking/ });
  const seen3 = { description: flat(await confirm.innerText()).slice(0, 400),
    pressBeforeReason: { label: flat(await press.innerText()), enabled: await press.isEnabled() } };
  await shot(till, '03a-confirm-asks-for-a-reason.png');
  await confirm.getByLabel('Reason').fill('ZZ TEST cancel');
  seen3.pressAfterReason = { label: flat(await press.innerText()), enabled: await press.isEnabled() };
  await shot(till, '03b-confirm-reason-typed.png');
  const [answer] = await Promise.all([
    till.waitForResponse(r => /\/api\/checkin\/registrations\/[^/]+\/cancel$/.test(new URL(r.url()).pathname)),
    confirm.getByRole('button', { name: 'Cancel the booking' }).click(),
  ]);
  seen3.cancelAnswer = answer.status();
  await expect(confirm).toBeHidden({ timeout: 20000 });
  await expect(picker.getByText(`${guardianName('a')}'s booking`)).toHaveCount(0, { timeout: 20000 });
  seen3.windowAfter = await pickerFamilies(picker);
  await shot(till, '03c-picker-after-cancel-booking-gone.png');
  const cancelled = await registrationOf(reg.id);
  seen3.registration = { consentRecordedAt: Boolean(cancelled.consentRecordedAt), children: cancelled.children.map(c => ({ name: c.childName, status: c.status })) };
  seen3.platformListAfter = await waitingList();
  await till.keyboard.press('Escape');

  phase('3: the Check-in board\'s Upcoming list');
  await till.goto('/');
  await till.getByRole('button', { name: 'Check-in', exact: true }).click();
  const search = till.getByPlaceholder('Search child, parent or phone…');
  await search.waitFor({ timeout: 20000 });
  const upcoming = till.getByRole('tab', { name: /Upcoming/ }).or(till.getByRole('button', { name: /^Upcoming/ })).first();
  if (await upcoming.isVisible().catch(() => false)) await upcoming.click();
  await search.fill(childName('a'));
  await till.waitForTimeout(3000);
  seen3.boardCards = await till.locator('[class*="bg-card"]').filter({ hasText: childName('a') }).count();
  await shot(till, '03d-checkin-board-upcoming-no-card.png');
  const ok = seen3.cancelAnswer === 200 && !seen3.pressBeforeReason.enabled && seen3.pressAfterReason.enabled && seen3.windowAfter.ownFamilies.length === 0
    && seen3.registration.children.every(c => c.status === 'cancelled') && seen3.registration.consentRecordedAt && seen3.boardCards === 0;
  point('3', ok, '03a-confirm-asks-for-a-reason.png', 'The confirm needs a reason; with "ZZ TEST cancel" the booking is cancelled (200), leaves the window (03c) and is not on the board\'s Upcoming list (03d); the signed form stays on record', seen3);
  return reg.id;
}

// ---- 4: a paid booking cannot be cancelled ----
async function point4() {
  phase('4: drop-off booking b — paid in cash, Leave as booked');
  const { reg, sale } = await dropOffBooking('b', numbers.bookB);
  await payCash();
  const leave = till.getByRole('button', { name: 'Leave as booked', exact: true });
  await leave.waitFor({ timeout: 20000 });
  await shot(till, '04a-paid-cash-check-in-or-leave-as-booked.png');
  await leave.click();
  await till.waitForTimeout(2000);
  knownSales.add(sale.id);
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  const picker = await openPicker(numbers.pickerB);
  const card = familyCard(picker, 'b');
  await expect(card.getByText(childName('b'))).toBeVisible({ timeout: 20000 });
  const cancelButton = card.getByRole('button', { name: 'Cancel booking' });
  const text = flat(await card.innerText());
  const seen = { saleStatus: paid.status, grossSatang: paid.totals?.grossSatang ?? null, cardText: text.slice(0, 300),
    cancelBookingButtons: await cancelButton.count(),
    cancelBookingEnabled: (await cancelButton.count()) ? await cancelButton.isEnabled() : null,
    paidLine: (text.match(/[^.]*handled through its sale\./i) ?? [null])[0],
    firstButton: flat(await card.getByRole('button').first().innerText()) };
  await card.scrollIntoViewIfNeeded();
  await shot(till, '04b-picker-paid-booking-no-cancel.png');
  // The platform's own answer for the paid booking: refused, nothing changed.
  const refused = await till.request.post(`/api/checkin/registrations/${reg.id}/cancel`, { data: { reason: 'ZZ TEST cancel (must be refused)' }, headers: { 'idempotency-key': randomUUID() } });
  seen.platformRefusal = { status: refused.status(), code: (await refused.json().catch(() => null))?.error?.code ?? null };
  seen.afterRefusal = (await registrationOf(reg.id)).children.map(c => c.status);
  await till.keyboard.press('Escape');
  const ok = paid.status === 'finalised' && (seen.cancelBookingButtons === 0 || seen.cancelBookingEnabled === false) && seen.platformRefusal.status === 409 && seen.afterRefusal.every(s => s === 'registered');
  point('4', ok, '04b-picker-paid-booking-no-cancel.png', `Paid in cash and left as booked: no usable Cancel booking (${seen.cancelBookingButtons === 0 ? 'the control is not shown; the card\'s button reads "' + seen.firstButton + '"' : 'disabled: ' + seen.paidLine}); the platform refuses a cancel press (${seen.platformRefusal.status} ${seen.platformRefusal.code})`, seen);

  phase('4: check booking b in from the board');
  await till.goto('/');
  await till.getByRole('button', { name: 'Check-in', exact: true }).click();
  const search = till.getByPlaceholder('Search child, parent or phone…');
  await search.waitFor({ timeout: 20000 });
  await search.fill(childName('b'));
  const boardCard = till.locator('[class*="bg-card"]').filter({ hasText: childName('b') }).filter({ has: till.getByRole('button', { name: /^Check in/ }) }).last();
  const checkin = { via: 'board' };
  try {
    await boardCard.waitFor({ timeout: 15000 });
    await shot(till, '04c-board-upcoming-paid-booking-b.png');
    await boardCard.getByRole('button', { name: /^Check in/ }).first().click();
    const dialog = till.getByRole('dialog').filter({ hasText: /Check in (child|children)/ });
    await dialog.waitFor({ timeout: 15000 });
    for (const box of await dialog.getByRole('checkbox').all()) await box.check().catch(() => {});
    await shot(till, '04d-board-check-in-dialog.png');
    await dialog.getByRole('button', { name: /Check in & issue band/ }).click();
    await expect.poll(async () => (await registrationOf(reg.id)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
    await till.waitForTimeout(1500);
    await shot(till, '04e-board-booking-b-checked-in.png');
  } catch (error) {
    checkin.boardFailure = firstLine(error);
    odd('the board\'s Check in of the paid booking did not complete; checked in through the api as the board does', { failure: checkin.boardFailure });
    await shot(till, '04e-board-check-in-not-completed.png').catch(() => {});
    await till.keyboard.press('Escape').catch(() => {});
    for (const child of (await registrationOf(reg.id)).children.filter(c => c.status === 'registered')) {
      const r = await till.request.post('/api/checkin/check-in-booked', { data: { entries: [{ checkinId: child.id }] }, headers: { 'idempotency-key': randomUUID() } });
      checkin.api = { status: r.status(), code: r.status() >= 400 ? (await r.json().catch(() => null))?.error?.code ?? null : null };
    }
  }
  checkin.children = (await registrationOf(reg.id)).children.map(c => c.status);
  receipt.checks.bookingBCheckIn = checkin; save();
}

// ---- 5: the cancelled stay's change history ----
async function point5(registrationId) {
  phase('5: the change history of the cancelled stay');
  const stays = regs.a.stayIds;
  const rows = [];
  const shapes = [];
  for (const id of stays) {
    const r = await call('GET', `/audit?entityType=checkin&entityId=${id}&limit=20`);
    shapes.push({ status: r.status, keys: Object.keys(r.body ?? {}) });
    const list = r.body?.rows ?? r.body?.entries ?? r.body?.items ?? r.body?.events ?? r.body?.audit ?? [];
    for (const row of list) rows.push({ at: row.createdAt, action: row.action, entityType: row.entityType,
      byTheTillAccount: row.actorAccountId === meId,
      by: row.actorAccountId === meId ? 'the reception test account at the ZZ TEST till' : (row.actorAccountId ? 'another account' : 'none'),
      before: row.before ? { status: row.before.status ?? null, cancelReason: row.before.cancelReason ?? null } : null,
      after: row.after ? { status: row.after.status ?? null, cancelReason: row.after.cancelReason ?? null, cancelledAt: row.after.cancelledAt ?? null, event: row.after.event ?? null } : null });
  }
  rows.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  // The till's own read of the stay's change history (what the board's edit window lists), as the signed-in reception account.
  const history = [];
  for (const id of stays) {
    const r = await till.request.get(`/api/checkin/checkins/${id}/history`);
    const body = await r.json().catch(() => null);
    for (const e of body?.entries ?? []) history.push({ status: r.status(), field: e.field, from: e.oldValue, to: e.newValue, at: e.changedAt,
      by: e.changedById === meId ? 'the reception test account at the ZZ TEST till' : 'another account' });
  }
  const cancelRow = rows.find(r => r.after?.event === 'cancel');
  const seen = { registrationId, stays, tillChangeHistory: history, auditRows: rows, responseShapes: shapes };
  writeFileSync(resolve(out, '05-stay-change-history.json'), JSON.stringify(seen, null, 2) + '\n');
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 } });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:24px;background:#fff;color:#111"><h2>SCRUM-862 — change history of the cancelled stay</h2>
    <p>Booking: ${esc(guardianName('a'))} / ${esc(childName('a'))}. Times are UTC (Bangkok is +7).</p>
    <h3>The till's change history of the stay (GET /api/checkin/checkins/:id/history)</h3><table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">
    <tr><th>When (UTC)</th><th>Field</th><th>From</th><th>To</th><th>By</th></tr>
    ${history.map(h => `<tr><td>${esc(h.at)}</td><td>${esc(h.field)}</td><td>${esc(h.from)}</td><td>${esc(h.to)}</td><td>${esc(h.by)}</td></tr>`).join('')}
    </table><h3>The audit rows behind it (GET /api/audit, entityType=checkin)</h3><table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">
    <tr><th>When (UTC)</th><th>Action</th><th>By</th><th>Status before</th><th>Status after</th><th>Reason</th><th>Event</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.at)}</td><td>${esc(r.action)}</td><td>${esc(r.by)}</td><td>${esc(r.before?.status)}</td><td>${esc(r.after?.status)}</td><td>${esc(r.after?.cancelReason)}</td><td>${esc(r.after?.event)}</td></tr>`).join('')}
    </table><p>"registered" is what the board calls Upcoming.</p></body></html>`);
  await page.screenshot({ path: resolve(out, '05-stay-change-history.png'), fullPage: true });
  await page.close();
  console.log('picture', '05-stay-change-history.png');
  const statusLine = history.find(h => h.field === 'Status'), reasonLine = history.find(h => h.field === 'Cancel reason');
  const ok = statusLine?.from === 'Upcoming' && statusLine?.to === 'Cancelled' && reasonLine?.to === 'ZZ TEST cancel' && Boolean(cancelRow) && cancelRow.before?.status === 'registered' && cancelRow.after?.status === 'cancelled' && cancelRow.after?.cancelReason === 'ZZ TEST cancel' && cancelRow.byTheTillAccount;
  point('5', ok, '05-stay-change-history.png', 'The stay\'s change history on the till: Status Upcoming -> Cancelled and Cancel reason "ZZ TEST cancel", by the reception account, with the time; the audit row behind it agrees', { tillChangeHistory: history, cancelRow, rowCount: rows.length, responseShapes: shapes });
}

// ---- 6: an ordinary sale, and the drop-off form's phone number field ----
async function point6() {
  phase('6: ordinary sale — one adult and one child, cash');
  await walkIn(numbers.ordinary);
  await ticket(1, 1);
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  const sale = await saleWritten('ordinary-ticket-sale');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '06-ordinary-sale-paid-cash.png');
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  knownSales.add(sale.id);
  const form = receipt.points['2']?.seen?.form ?? null;
  const ok = paid.status === 'finalised' && (form?.phoneNumberLabel ?? 0) > 0;
  point('6', ok, '06-ordinary-sale-paid-cash.png', 'One adult and one child paid in cash completes (finalised); the drop-off form still showed its "Phone number" field (02a)', { sale: { status: paid.status, receipt: paid.receiptNumber ?? null, grossSatang: paid.totals?.grossSatang ?? null }, dropOffForm: form });
  await till.goto('/'); await landing(till).waitFor();
}

const attempt = async (key, fn) => {
  try { return await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    await till.keyboard.press('Escape').catch(() => {});
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
  const probe = await call('POST', `/checkin/registrations/${randomUUID()}/cancel`, {});
  receipt.checks.cancelRouteProbe = { status: probe.status, code: probe.body?.error?.code ?? null, meaning: 'an empty body on the new route is refused by validation; the old api answered 404' };
  assert.equal(probe.status, 400, 'the api serves the cancel route');
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
  receipt.checks.meIdKnown = Boolean(meId);
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    const found = { files: urls.length, cancelDialogMarkers: 0 };
    for (const url of urls) found.cancelDialogMarkers += (await (await fetch(url, { cache: 'no-store' })).text()).split('Cancel this waiting booking').length - 1;
    return found;
  });
  save();
  assert.ok(receipt.checks.bundle.cancelDialogMarkers >= 1, 'the till serves the SCRUM-862 bundle');

  const only = (process.env.ONLY ?? '1,2,3,4,5,6').split(',');
  receipt.only = only;
  if (only.includes('1')) await attempt('1', point1);
  const cancelledId = only.includes('2') || only.includes('3') ? await attempt('2-3', points2and3) : null;
  if (only.includes('4')) await attempt('4', point4);
  if (cancelledId && only.includes('5')) await attempt('5', () => point5(cancelledId));
  if (only.includes('6')) await attempt('6', point6);
  receipt.passed = !failed && only.every(k => receipt.points[k]?.pass === true);
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
      for (const item of receipt.created.filter(i => i.kind === 'registration' && i.id)) await clean(`own registration ${item.tag}`, async () => {
        let reg = await registrationOf(item.id);
        assert.equal(reg.guardianName, guardianName(item.tag), 'only this run\'s own booking');
        for (const child of reg.children) {
          assert.equal(child.childName, childName(item.tag));
          if (child.status === 'registered' && item.tag !== 'a') {
            // Paid but never checked in (a run that stopped early): checked in from this run's own till, as the board does.
            const r = await till.request.post('/api/checkin/check-in-booked', { data: { entries: [{ checkinId: child.id }] }, headers: { 'idempotency-key': randomUUID() } });
            receipt.cleanup.push({ kind: 'check-in-booked', tag: item.tag, status: r.status() });
          }
        }
        reg = await registrationOf(item.id);
        for (const child of reg.children.filter(c => c.status === 'in_park')) {
          const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: item.id, filename: `ZZ TEST SCRUM-${T} synthetic pickup.png` });
          assert.equal(file.status, 200);
          const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
          assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
          assert.equal((await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id })).status, 200);
        }
        if (item.tag === 'a' && reg.children.some(c => c.status === 'registered')) {
          // Only if point 3 did not get to press it: this run's own booking a is cancelled through the same route.
          for (const s of (await stationSales()).filter(x => ['tendering', 'open'].includes(x.status))) await call('POST', `/sales/${s.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` });
          const r = await till.request.post(`/api/checkin/registrations/${item.id}/cancel`, { data: { reason: `ZZ TEST SCRUM-${T} proof cleanup` }, headers: { 'idempotency-key': randomUUID() } });
          receipt.cleanup.push({ kind: 'cancel-own-booking-a', status: r.status() });
        }
        const after = await registrationOf(item.id);
        const states = after.children.map(c => ({ id: c.id, status: c.status }));
        receipt.cleanup.push({ kind: 'registration', tag: item.tag, id: item.id, children: states });
        assert.ok(states.every(c => c.status === 'out' || c.status === 'cancelled'), 'nothing of this run is left waiting or in the park');
      });
      let sales = [];
      await clean('read own sales', async () => { sales = await stationSales(); for (const sale of sales) assert.equal(sale.stationId, station.id); });
      for (const sale of sales.filter(s => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
        assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided', by: 'cleanup' });
      });
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
  if (branchId) await clean('waiting list after', async () => { receipt.cleanup.push({ kind: 'waiting-list-after', ...(await waitingList()) }); });
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
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.pass])), odd: receipt.odd.length, pageErrors: receipt.pageErrors.length, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
