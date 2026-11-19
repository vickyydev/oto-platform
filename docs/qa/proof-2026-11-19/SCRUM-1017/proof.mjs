// SCRUM-1017 (sub-tasks 1018 to 1021) staging proof: the counter's drop-off flow
// as the owner answered it on 19 November. Adapted from the committed SCRUM-863
// and SCRUM-1014 harnesses. Own ZZ TEST till on the simulated box, ZZ TEST
// family and children made through the till, invented numbers, cash only.
// No credential, pairing code, band code, phone or raw response body enters the
// receipt or the console.
//
//   node proof.mjs <full-sha> <out-dir> <passes>
//   passes: a  a new number with a name on the display; Eat & Play; food credit on the form; cash; band credit
//           f  a food order paid from the band; the receipt's "Credit left"
//           p  pickup: "You still have X baht remaining"; released
//           r  the returning family: ticks, agreements only, number shown, last photo, care notes, Edit details
//           w  the waiver: straight to payment
//           x  the Expat rate: expiry required; skips the rate step with "change"; the Thai rate asks no date
// ZZ_BASE moves the invented numbers; each run asserts they are unused first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const wanted = (process.argv[4] ?? 'a,f,p,r,w,x').split(',');
const T = '1017';
const base = Number(process.env.ZZ_BASE ?? 11);
const zz = (i) => '08981017' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const number = zz(0);
const RUN = String(base);
const family = `ZZ TEST SCRUM-${T} family ${RUN}`;
const kidA = `ZZ TEST Mai ${RUN}`;
const kidB = `ZZ TEST Noah ${RUN}`;
const guardian = `ZZ TEST SCRUM-${T} guardian ${RUN}`;
const receipt = { ticket: `SCRUM-${T}`, sha, startedAt: new Date().toISOString(), phase: 'preflight', passes: wanted,
  points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = (value) => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const firstLine = (error) => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
const point = (key, pass, pictures, shows, seen = {}) => { receipt.points[key] = { pass, pictures, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); };
const odd = (what) => { receipt.odd.push({ at: receipt.phase, what }); save(); console.log('ODD', what); };

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let response = await once();
  if (response.status() === 401) { await adminSignIn(); response = await once(); }
  const isJson = /json/.test(response.headers()['content-type'] ?? '');
  const body = isJson ? await response.json().catch(() => null) : await response.body().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), status: response.status(), ...(response.status() >= 400 && isJson ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: response.status(), body };
};

let browser = null, till = null, display = null, station = null, branchId = null, failed = false, memberId = null;
const knownSales = new Set();
const registrations = [];
let bandCode = null; // in memory only: whoever holds a band code can spend it
let receiptDevice = null;

const shot = async (page, name) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
      page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/), page.locator('div.grid.gap-px'),
      page.getByTestId('band-codes').locator('span.font-mono'), page.getByText(/^Z\d{5,6}-[A-Z0-9]{4,8}$/),
      page.getByText(/^\+66[\d ]+$/), page.getByText(/^0\d{2} ?\d{3} ?\d{4}$/)] });
  console.log('picture', name);
};
function watch(page, label) {
  page.on('pageerror', (e) => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` });
  });
}
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const landing = (page) => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const paymentStep = () => till.getByTestId('payment-step');
const home = async () => { await till.goto('/'); await landing(till).or(till.getByRole('heading', { name: 'Membership Check', exact: true })).first().waitFor(); };
const registrationOf = async (id) => (await call('GET', '/checkin/registrations/' + id)).body;

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
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: fixtureName });
  assert.equal(paired.status, 200);
  display = { context, page, id: paired.body.device.id, revoked: false };
  receipt.created.push({ kind: 'display', id: display.id }); save();
  await landing(page).waitFor();
}
async function dropDisplay(reason = `ZZ TEST SCRUM-${T} proof complete`) {
  if (!display) return;
  const d = display; display = null;
  if (!d.revoked) {
    assert.equal((await call('POST', `/credentials/${d.id}/revoke`, { reason })).status, 200);
    receipt.cleanup.push({ kind: 'display', id: d.id, revoked: true }); save();
  }
  await d.context.close().catch(() => {});
}
/** The display's first screen: the number, and a nickname when given. */
async function identifyOnDisplay(nickname) {
  const page = display.page;
  await page.waitForTimeout(2500);
  for (let i = 0; i < 20; i++) {
    if (await page.getByTestId('language-choice').isVisible().catch(() => false)) await page.getByTestId('language-choice-en').click().catch(() => {});
    else if (await page.getByTestId('identify-safety').isVisible().catch(() => false)) break;
    await page.waitForTimeout(750);
  }
  await page.getByTestId('identify-safety').waitFor();
  await keypad(page.locator('body'), number);
  if (nickname) await page.getByPlaceholder('e.g. Mama, John').fill(nickname);
}
async function setQuantity(label, target) {
  const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
  const remove = till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let count = 0; count < 8; count++) {
    const current = Number(await value.textContent());
    if (current === target) return;
    await (current < target ? add : remove).click();
    await till.waitForTimeout(250);
  }
  assert.equal(Number(await value.textContent()), target);
}
async function chooseTicket(pkg, kids, adults, rate = 'Tourist') {
  if (rate && await till.getByRole('heading', { name: 'Select Customer Type', exact: true }).isVisible().catch(() => false)) await till.getByRole('heading', { name: rate, exact: true }).first().click();
  await till.getByRole('heading', { name: pkg, exact: true }).first().click();
  await till.waitForTimeout(600);
  await setQuantity('Kids', kids); await setQuantity('Adults', adults);
}
async function setAge(page, scope, age) {
  await scope.getByRole('button', { name: /Tap to set age/ }).last().click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^(Jan.*|12)$/ }) }).last();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: String(age), exact: true }).click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /^Jan/ }).first().click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: '1', exact: true }).first().click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /Confirm/ }).click();
  await expect(page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^(Jan.*|12)$/ }) })).toHaveCount(0);
}
async function staffPhotos(scopeOpener = 'Private child details') {
  await till.getByRole('button', { name: scopeOpener, exact: true }).click();
  const details = till.getByRole('dialog', { name: scopeOpener, exact: true });
  await details.waitFor();
  const starts = details.getByRole('button', { name: 'Start camera', exact: true });
  for (let i = 0; i < 4 && await starts.count(); i++) {
    await starts.first().click();
    await details.getByRole('button', { name: 'Take photo', exact: true }).first().click();
    await till.waitForTimeout(800);
  }
  await details.getByRole('button', { name: 'Close', exact: true }).click();
}
async function continueToPayment(tag) {
  const [registered] = await Promise.all([
    till.waitForResponse((r) => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST', { timeout: 60000 }),
    till.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  const sent = registered.request().postDataJSON();
  const reg = await registered.json().catch(() => null);
  registrations.push({ id: reg?.id ?? null, pass: tag });
  receipt.created.push({ kind: 'registration', id: reg?.id ?? null, pass: tag }); save();
  return { status: registered.status(), sent, reg };
}
async function familyDone() {
  // The display's Done, or the sale moves on by itself after it.
  const consent = display.page.getByTestId('display-consent');
  const done = consent.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeEnabled({ timeout: 30000 });
  const [registered] = await Promise.all([
    till.waitForResponse((r) => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST', { timeout: 60000 }).catch(() => null),
    done.click(),
  ]);
  if (registered) {
    const reg = await registered.json().catch(() => null);
    registrations.push({ id: reg?.id ?? null });
    receipt.created.push({ kind: 'registration', id: reg?.id ?? null }); save();
    return { status: registered.status(), sent: registered.request().postDataJSON(), reg };
  }
  return null;
}
async function newSale() {
  let sale;
  await expect.poll(async () => { sale = (await stationSales()).find((x) => ['tendering', 'open'].includes(x.status) && !knownSales.has(x.id)); return Boolean(sale); }, { timeout: 45000 }).toBe(true);
  knownSales.add(sale.id);
  receipt.created.push({ kind: 'sale', id: sale.id }); save();
  return sale;
}
async function payCash() {
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click();
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 60000 });
}
async function checkInNow(regId) {
  const now = till.getByRole('button', { name: 'Check in now', exact: true });
  await now.waitFor({ timeout: 20000 });
  await now.click();
  await expect.poll(async () => (await registrationOf(regId)).children.every((c) => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
  await till.waitForTimeout(1500);
}
async function release(regId) {
  const reg = await registrationOf(regId);
  for (const child of reg.children) {
    assert.ok(String(child.childName).startsWith('ZZ TEST'), 'only own test child');
    if (child.status !== 'in_park') continue;
    const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: `ZZ TEST SCRUM-${T} synthetic pickup.png` });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const released = await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    assert.equal(released.status, 200);
  }
  const after = await registrationOf(regId);
  receipt.cleanup.push({ kind: 'released', id: regId, children: after.children.map((c) => c.status) }); save();
}
const walletOf = async (key) => (await call('GET', `/wallets/lookup?key=${encodeURIComponent(key)}`)).body;
const satang = (w) => w?.wallet?.balanceSatang ?? w?.wallet?.balance ?? null;
async function bandsOf(saleId) {
  const read = (await call('GET', `/sales/${saleId}`)).body;
  return read?.bands ?? read?.sale?.bands ?? [];
}

// ---- a: a new number with a name; the first drop-off; Eat & Play; credit on the form and the band ----
async function passA() {
  await home();
  await pairDisplay();
  phase('a: the family types a new number and a name on the display');
  await identifyOnDisplay(family);
  await shot(display.page, 'a1-display-new-number-and-name.png');
  await display.page.getByRole('button', { name: 'Continue', exact: true }).click();
  await till.waitForTimeout(4000);
  const offer = await till.getByRole('dialog', { name: 'New member?', exact: true }).count();
  let found = null;
  await expect.poll(async () => { found = (await call('GET', `/members/lookup?phone=${number}`)).body.member; return Boolean(found); }, { timeout: 30000 }).toBe(true);
  memberId = found.id;
  receipt.created.push({ kind: 'member', id: memberId }); save();
  await shot(till, 'a2-till-member-made-no-new-member-box.png');
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  const visitingShown = await visiting.isVisible().catch(() => false);
  point('1019-auto', offer === 0 && found.nickname === family, ['a1-display-new-number-and-name.png', 'a2-till-member-made-no-new-member-box.png'],
    'An unknown number typed with a name on the display made the member by itself; no "New member?" box on the till', { newMemberBox: offer, memberNickname: found.nickname, visitingDialog: visitingShown });
  if (visitingShown) await visiting.getByRole('button', { name: 'Skip for now', exact: true }).click();

  phase('a: Eat & Play, one child, no adult');
  await chooseTicket('Eat & Play Kids Pass', 1, 0);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const consent = display.page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  await consent.getByPlaceholder('Full name', { exact: true }).fill(kidA);
  await setAge(display.page, consent, 6);
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByTestId('consent-care').waitFor();
  const allergyBox = consent.getByTestId('consent-allergies').locator('textarea, input').first().or(consent.getByTestId('consent-allergies')).first();
  await allergyBox.click().catch(() => {});
  await allergyBox.fill('ZZ TEST peanuts').catch(() => odd('the allergy box did not take typing'));
  const keysDone = display.page.getByRole('button', { name: 'Done', exact: true });
  await consent.getByTestId('consent-food-credit').waitFor({ timeout: 20000 });
  const included = flat(await consent.getByTestId('consent-food-included').innerText().catch(() => ''));
  await consent.getByTestId('consent-food-credit').scrollIntoViewIfNeeded();
  await shot(display.page, 'a3-display-food-included-no-extra-charge.png');
  phase('a: the parent chooses extra food credit on the display');
  await consent.getByTestId('consent-extra-credit-more').click();
  await display.page.waitForTimeout(400);
  await consent.getByTestId('consent-extra-credit-more').click();
  await display.page.waitForTimeout(1500);
  const extraShown = flat(await consent.getByTestId('consent-extra-credit').innerText());
  const extraTHB = Number(extraShown.replace(/[^\d]/g, ''));
  await shot(display.page, 'a4-display-extra-credit-chosen.png');
  const mirrorFood = till.getByTestId('consent-extra-credit').first();
  if (await mirrorFood.count()) await mirrorFood.scrollIntoViewIfNeeded();
  await till.waitForTimeout(800);
  const mirrorSays = (await mirrorFood.count()) ? flat(await mirrorFood.innerText()) : null;
  const tillFood = till.getByTestId('order-food-credit');
  const tillSees = await tillFood.first().waitFor({ timeout: 3000 }).then(async () => flat(await tillFood.first().innerText())).catch(() => null);
  await shot(till, 'a5-till-sees-extra-credit.png');
  point('1021-form', /included, no extra charge/.test(included) && /1,?300/.test(included), ['a3-display-food-included-no-extra-charge.png'],
    'Eat & Play child on the drop-off form: "Food credit ฿1300 — included, no extra charge"', { included });
  point('1021-extra-display', extraTHB > 0 && (Boolean(tillSees) || mirrorSays === extraShown), ['a4-display-extra-credit-chosen.png', 'a5-till-sees-extra-credit.png'],
    'The parent chose extra food credit on the display; the till shows it as its own row on the order', { extraShown, tillSees, mirrorSays });
  void keysDone;
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByPlaceholder('Your full name', { exact: true }).waitFor({ timeout: 20000 });

  phase('a: guardian name, agreements, staff photo, Done');
  await consent.getByPlaceholder('Your full name', { exact: true }).fill(guardian);
  for (const checkbox of await consent.getByRole('checkbox').all()) { if (!(await checkbox.isChecked())) await checkbox.check(); }
  await staffPhotos();
  const done = await familyDone();
  let reg = done?.reg ?? null;
  if (!reg) {
    const written = await continueToPayment('a');
    reg = written.reg;
  }
  receipt.checks.firstRegistration = { id: reg?.id ?? null }; save();
  const sale = await newSale();
  await payCash();
  await checkInNow(reg.id);
  await shot(till, 'a6-paid-cash-checked-in.png');
  const bands = await bandsOf(sale.id);
  const kidBand = bands.find((b) => b.childName === kidA) ?? bands[0];
  bandCode = kidBand?.shortCode ?? null;
  const wallet = bandCode ? await walletOf(bandCode) : null;
  const balance = satang(wallet);
  receipt.checks.bandAfterSale = { bands: bands.length, hasCode: Boolean(bandCode), balanceSatang: balance, ledger: (wallet?.ledger ?? []).map((e) => ({ kind: e.kind ?? e.type ?? null, amountSatang: e.amountSatang ?? null, source: e.source ?? null })) }; save();
  point('1021-band', balance === (1300 + extraTHB) * 100, ['a6-paid-cash-checked-in.png'],
    `After the cash sale and check-in, the child's band holds the ticket's ฿1300 and the ฿${extraTHB} extra`, receipt.checks.bandAfterSale);
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  receipt.checks.passA = { registrationId: reg.id, saleId: sale.id, extraTHB }; save();
}

// ---- f: a food order paid from the band; the receipt says the credit left ----
async function passF() {
  assert.ok(bandCode, 'the band from pass a');
  phase('f: F&B, scan the band, one dish, paid from the band');
  await home();
  await till.getByRole('button', { name: 'F&B', exact: true }).click();
  await till.getByRole('heading', { name: 'Scan Wristband', exact: true }).waitFor();
  await till.getByPlaceholder('Wristband code e.g. 1001').fill(bandCode);
  await till.getByPlaceholder('Wristband code e.g. 1001').press('Enter');
  await till.waitForTimeout(3000);
  await shot(till, 'f1-fnb-band-scanned.png');
  const search = till.getByPlaceholder('Search dish…');
  await search.waitFor({ timeout: 20000 });
  await search.fill('Smashed avocado');
  const item = till.getByText('Smashed avocado + bruschetta', { exact: true }).first();
  await item.click();
  const d = till.getByRole('dialog');
  const egg = d.getByRole('button', { name: /Egg your way/ });
  if (await egg.isVisible().catch(() => false)) await egg.click();
  const add = d.getByRole('button', { name: /^Add to order/ });
  if (await add.isVisible().catch(() => false)) { await add.click(); await d.waitFor({ state: 'hidden' }).catch(() => {}); }
  await till.waitForTimeout(800);
  const charge = till.getByRole('button', { name: /^Charge ฿/ });
  await expect(charge).toBeEnabled({ timeout: 20000 });
  await charge.click();
  const pickup = till.getByRole('dialog', { name: 'Pick-up Code', exact: true });
  if (await pickup.waitFor({ timeout: 6000 }).then(() => true).catch(() => false)) {
    const go = pickup.getByRole('button', { name: /^Continue to Payment/ });
    if (!(await go.isEnabled().catch(() => false))) { await pickup.getByRole('button', { name: '8', exact: true }).click(); await pickup.getByRole('button', { name: '6', exact: true }).click(); }
    await go.click();
  }
  await till.waitForTimeout(2500);
  await shot(till, 'f2-fnb-payment-band-credit.png');
  const complete = till.getByRole('button', { name: 'Complete Order', exact: true });
  await complete.click();
  await till.getByRole('heading', { name: 'Order Confirmed', exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(2000);
  await shot(till, 'f3-fnb-order-confirmed.png');
  const sale = (await stationSales()).find((s) => !knownSales.has(s.id) && s.status === 'finalised');
  if (sale) { knownSales.add(sale.id); receipt.created.push({ kind: 'sale', id: sale.id, note: 'F&B paid from the band' }); }
  const wallet = await walletOf(bandCode);
  phase('f: the receipt the simulated receipt printer drew');
  let printed = null;
  await expect.poll(async () => {
    const list = (await call('GET', `/devices/${receiptDevice}/printouts?limit=5`)).body?.printouts ?? [];
    printed = list.at(-1) ?? null;
    return Boolean(printed && new Date(printed.at) > new Date(Date.now() - 5 * 60000));
  }, { timeout: 60000 }).toBe(true).catch(() => odd('no fresh printout on the receipt device'));
  let picture = null;
  if (printed) {
    const png = await call('GET', printed.previewUrl);
    if (png.status === 200) { picture = 'f4-food-receipt-credit-left.png'; writeFileSync(resolve(out, picture), png.body); console.log('picture', picture); }
  }
  receipt.checks.passF = { saleId: sale?.id ?? null, balanceAfterSatang: satang(wallet), printout: printed ? { seq: printed.seq, at: printed.at } : null }; save();
  point('1021-receipt', Boolean(picture), [picture, 'f2-fnb-payment-band-credit.png', 'f3-fnb-order-confirmed.png'].filter(Boolean),
    'A food order paid from the band: the receipt prints the credit left (read the picture)', receipt.checks.passF);
}

// ---- p: pickup: "You still have X baht remaining"; then released ----
async function passP() {
  const regId = receipt.checks.returning?.registrationId ?? receipt.checks.passA?.registrationId;
  assert.ok(regId, 'a registration of this run with the child in the park');
  phase('p: the check-in board, Check Out on the child');
  await home();
  await till.getByRole('button', { name: 'Check-in', exact: true }).click();
  const searchBox = till.getByPlaceholder('Search child, parent or phone…');
  await searchBox.waitFor({ timeout: 20000 });
  await searchBox.fill(kidA);
  await till.waitForTimeout(1000);
  await till.getByRole('tab', { name: /^In Park/ }).or(till.getByRole('button', { name: /^In Park/ })).first().click();
  await till.waitForTimeout(2000);
  const out1 = till.getByRole('button', { name: 'Check Out', exact: true }).first();
  await out1.waitFor({ timeout: 20000 });
  await out1.click();
  const modal = till.getByRole('dialog').last();
  await modal.waitFor();
  await modal.getByText(guardian, { exact: true }).first().click();
  const confirmId = modal.getByRole('button', { name: /Identity confirmed/ });
  if (await confirmId.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) await confirmId.click();
  await till.waitForTimeout(2500);
  const still = modal.getByText(/You still have ฿[\d,]+ remaining/).first();
  if (await still.count()) await still.scrollIntoViewIfNeeded();
  await till.waitForTimeout(800);
  const text = flat(await modal.innerText());
  const remaining = text.match(/You still have ฿[\d,]+ remaining/)?.[0] ?? null;
  await shot(till, 'p1-pickup-you-still-have-remaining.png');
  point('1021-pickup', Boolean(remaining), ['p1-pickup-you-still-have-remaining.png'], 'The pickup screen says "You still have ฿X remaining" for staff to tell the parent', { remaining });
  await till.keyboard.press('Escape');
  await till.waitForTimeout(800);
  await release(regId);
}

// ---- r: the returning family ----
async function passR() {
  assert.ok(memberId, 'the family from pass a');
  await home();
  if (!display) await pairDisplay();
  phase('r: the family types their number on the display');
  await identifyOnDisplay(null);
  await display.page.getByRole('button', { name: 'Continue', exact: true }).click();
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  await visiting.waitFor({ timeout: 30000 });
  const row = visiting.locator('label').filter({ hasText: kidA });
  const box = row.getByRole('checkbox');
  if (!(await box.isChecked())) await box.click();
  await shot(till, 'r1-till-who-is-visiting-ticked.png');
  await visiting.getByRole('button', { name: /^Confirm 1 child/ }).click();
  await visiting.waitFor({ state: 'hidden', timeout: 30000 });
  phase('r: Eat & Play, one child; the gate');
  await chooseTicket('Eat & Play Kids Pass', 1, 0);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const choice = till.getByTestId('last-photo-choice');
  await choice.waitFor({ timeout: 30000 });
  const gateText = flat(await till.locator('main, body').first().innerText());
  const consent = display.page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  await display.page.waitForTimeout(2000);
  const formSeen = {
    childOnGate: gateText.includes(kidA),
    stillMatches: await choice.getByRole('button', { name: 'Still matches' }).count(),
    takeNew: await choice.getByRole('button', { name: 'Take a new one' }).count(),
    stepPills: await consent.getByTestId('consent-steps').count(),
    keptGuardian: await consent.getByTestId('consent-kept-guardian').count(),
    keptPhone: await consent.getByTestId('consent-kept-phone').count(),
    numberBoxes: await consent.locator('input[type="tel"]').count(),
    childShown: flat(await consent.getByTestId('consent-child-shown').first().innerText().catch(() => '')),
    checkboxes: await consent.getByRole('checkbox').count(),
    savedCare: await consent.getByTestId('consent-saved-care').count(),
    included: flat(await consent.getByTestId('consent-food-included').innerText().catch(() => '')),
  };
  await shot(till, 'r2-till-gate-ticked-child-last-photo-two-choices.png');
  await shot(display.page, 'r3-display-agreements-only-number-shown.png');
  await consent.getByTestId('consent-kept-phone').scrollIntoViewIfNeeded().catch(() => {});
  await shot(display.page, 'r3b-display-number-shown-no-tick.png');
  point('1018-returning', formSeen.childOnGate && formSeen.stillMatches === 1 && formSeen.takeNew === 1 && formSeen.stepPills === 0 && formSeen.keptGuardian === 1 && formSeen.keptPhone === 1 && formSeen.numberBoxes === 0,
    ['r1-till-who-is-visiting-ticked.png', 'r2-till-gate-ticked-child-last-photo-two-choices.png', 'r3-display-agreements-only-number-shown.png', 'r3b-display-number-shown-no-tick.png'],
    'Returning family: the ticked child is on the form; the display asks only the agreements, shows the name and the number with no tick; staff see the last photo with "Still matches" and "Take a new one"', formSeen);

  phase('r: the parent updates the care notes on the display');
  const care = consent.getByTestId('consent-saved-care').first();
  let careSeen = { shown: await care.count() };
  if (careSeen.shown) {
    await care.scrollIntoViewIfNeeded();
    careSeen.before = flat(await care.innerText()).slice(0, 300);
    await shot(display.page, 'r4-display-care-notes-from-profile.png');
    const allergyField = care.locator('textarea, input:not([type="checkbox"])').first();
    careSeen.allergyBefore = await allergyField.inputValue().catch(() => null);
    await allergyField.fill('ZZ TEST peanuts and sesame');
    await display.page.waitForTimeout(3000);
    const medical = care.getByPlaceholder('Conditions, medicines, anything the team should know');
    if (await medical.count()) { await medical.fill('ZZ TEST inhaler in the bag'); await display.page.waitForTimeout(3000); }
    const line = till.getByTestId('consent-display-care');
    careSeen.tillLines = await line.first().waitFor({ timeout: 20000 }).then(async () => (await line.allInnerTexts()).map(flat)).catch(() => []);
    await shot(display.page, 'r5-display-care-notes-edited.png');
    await shot(till, 'r6-till-shows-care-change.png');
  }
  point('1020-care', careSeen.shown > 0 && careSeen.tillLines?.length > 0, ['r4-display-care-notes-from-profile.png', 'r5-display-care-notes-edited.png', 'r6-till-shows-care-change.png'],
    'The saved child\'s allergy and medical notes are shown on the display; the parent edits them there and the till shows the change', careSeen);

  phase('r: the parent chooses extra food credit; staff see it on the till');
  const more = consent.getByTestId('consent-extra-credit-more').first();
  if (await more.count()) {
    await more.click(); await display.page.waitForTimeout(1500);
    receipt.checks.returningExtra = flat(await consent.getByTestId('consent-extra-credit').first().innerText()); save();
    const mirror = till.getByTestId('consent-food-credit').first();
    if (await mirror.count()) { await mirror.scrollIntoViewIfNeeded(); await till.waitForTimeout(800); }
    await shot(till, 'r6b-till-sees-family-extra-credit.png');
  } else odd('no extra credit control on the returning form');

  phase('r: the family ticks the agreements; staff press "Still matches"');
  for (const checkbox of await consent.getByRole('checkbox').all()) { if (!(await checkbox.isChecked())) await checkbox.check(); }
  await choice.getByRole('button', { name: 'Still matches' }).click();
  await till.waitForTimeout(1000);
  const tillTickedBefore = (flat(await till.locator('body').innerText()).match(/· ticked/g) ?? []).length;
  const ticksBefore = await consent.getByRole('checkbox').evaluateAll((els) => els.map((el) => el.getAttribute('data-state') ?? String(el.checked)));
  await shot(till, 'r7-till-photo-still-matches.png');

  phase('r: Edit details: add a new child; the ticks stay');
  await till.getByTestId('edit-details-open').first().click();
  const edit = till.getByTestId('edit-details');
  await edit.waitFor();
  await edit.getByTestId('edit-details-add-new').click();
  await till.waitForTimeout(1500);
  const names = edit.getByPlaceholder('Full name', { exact: true });
  const count = await names.count();
  await names.nth(count - 1).fill(kidB);
  await setAge(till, edit, 10);
  await till.waitForTimeout(1500);
  await shot(till, 'r8-edit-details-new-child-added.png');
  const editTicks = await edit.getByRole('checkbox').evaluateAll((els) => els.map((el) => el.getAttribute('data-state') ?? String(el.checked)));
  await till.keyboard.press('Escape');
  await till.waitForTimeout(2500);
  const ticksAfter = await consent.getByRole('checkbox').evaluateAll((els) => els.map((el) => el.getAttribute('data-state') ?? String(el.checked)));
  await shot(display.page, 'r9-display-after-edit-ticks-kept.png');
  await shot(till, 'r10-till-after-edit-two-children.png');
  const tillTickedAfter = (flat(await till.locator('body').innerText()).match(/· ticked/g) ?? []).length;
  const kept = { tillTickedBefore, tillTickedAfter, ticksBefore, editTicks, ticksAfter, gateHasNewChild: flat(await till.locator('body').innerText()).includes(kidB) };
  point('1020-edit', kept.gateHasNewChild && tillTickedBefore > 0 && tillTickedAfter === tillTickedBefore,
    ['r8-edit-details-new-child-added.png', 'r9-display-after-edit-ticks-kept.png', 'r10-till-after-edit-two-children.png'],
    'Edit details mid check-in added a child; the agreement ticks already made stay ticked', kept);

  phase('r: finish: the new child\'s photo, Done, pay cash, check in');
  for (const checkbox of await consent.getByRole('checkbox').all()) { if (!(await checkbox.isChecked())) await checkbox.check().catch(() => {}); }
  await staffPhotos().catch((e) => odd('staff photos: ' + firstLine(e)));
  let written = await familyDone().catch(() => null);
  if (!written) written = await continueToPayment('r');
  receipt.checks.returning = { registrationId: written.reg?.id ?? null, status: written.status, photoReuseSent: Array.isArray(written.sent?.photoReuse) ? written.sent.photoReuse.length : 0 }; save();
  const sale = await newSale();
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  await till.waitForTimeout(1500);
  const orderFood = till.getByTestId('order-food-credit');
  receipt.checks.returningOrderFoodRow = (await orderFood.count()) ? flat(await orderFood.first().innerText()) : null; save();
  if (await orderFood.count()) await orderFood.first().scrollIntoViewIfNeeded();
  await shot(till, 'r10b-payment-step-extra-credit-row.png');
  await payCash();
  await checkInNow(written.reg.id);
  await shot(till, 'r11-returning-paid-checked-in.png');
  const reg = await registrationOf(written.reg.id);
  receipt.checks.returning.children = reg.children.map((c) => ({ name: c.childName, status: c.status, hasPhoto: Boolean(c.childPhotoFileId ?? c.photoFileId ?? c.childPhotoUrl) }));
  receipt.checks.returning.saleId = sale.id;
  const kids = (await call('GET', `/members/${memberId}`)).body?.member?.children ?? [];
  receipt.checks.returning.savedAfter = kids.map((c) => ({ name: c.name ?? c.childName, allergies: c.allergies ?? c.allergiesMedical ?? null, medicalNotes: c.medicalNotes ?? null })); save();
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  await release(written.reg.id);
}

// ---- w: the waiver: straight to payment ----
async function passW() {
  await home();
  if (!display) await pairDisplay();
  phase('w: the returning family with both children ticked');
  await identifyOnDisplay(null);
  await display.page.getByRole('button', { name: 'Continue', exact: true }).click();
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  await visiting.waitFor({ timeout: 30000 });
  for (const name of [kidA, kidB]) {
    const box = visiting.locator('label').filter({ hasText: name }).getByRole('checkbox');
    if (await box.count() && !(await box.isChecked())) await box.click();
  }
  await visiting.getByRole('button', { name: /^Confirm 2 children/ }).click();
  await visiting.waitFor({ state: 'hidden', timeout: 30000 });
  await chooseTicket('1 Hour Play', 2, 0);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  await till.waitForTimeout(2000);
  const waive = till.getByRole('button', { name: /^Waive — older sibling/ });
  await waive.waitFor({ timeout: 20000 });
  await shot(till, 'w1-gate-waiver-offered.png');
  await waive.click();
  await till.waitForTimeout(1500);
  await shot(till, 'w2-gate-waived-continue.png');
  const registrationsPosted = [];
  till.on('request', (r) => { if (new URL(r.url()).pathname === '/api/checkin/registrations' && r.method() === 'POST') registrationsPosted.push(1); });
  await till.getByRole('button', { name: /^Continue/ }).last().click();
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  await till.waitForTimeout(2000);
  await shot(till, 'w3-straight-to-payment.png');
  await shot(display.page, 'w4-display-at-payment.png');
  const sale = await newSale().catch(() => null);
  point('1018-waiver', registrationsPosted.length === 0, ['w1-gate-waiver-offered.png', 'w2-gate-waived-continue.png', 'w3-straight-to-payment.png', 'w4-display-at-payment.png'],
    'After the waiver, Continue goes straight to payment: no drop-off form, no registration written', { registrationsPosted: registrationsPosted.length, saleId: sale?.id ?? null });
  const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
  if (await cancel.isEnabled().catch(() => false)) { await cancel.click(); await till.waitForTimeout(3000); }
  const confirmCancel = till.getByRole('button', { name: /Cancel sale|Yes, cancel/ });
  if (await confirmCancel.isVisible().catch(() => false)) { await confirmCancel.click(); await till.waitForTimeout(2000); }
}

// ---- x: the Expat rate ----
async function passX() {
  await home();
  if (!display) await pairDisplay();
  phase('x: the family, Expat chosen: the document step');
  await identifyOnDisplay(null);
  await display.page.getByRole('button', { name: 'Continue', exact: true }).click();
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  if (await visiting.waitFor({ timeout: 20000 }).then(() => true).catch(() => false)) await visiting.getByRole('button', { name: 'Skip for now', exact: true }).click();
  await till.getByRole('heading', { name: 'Expat', exact: true }).first().click();
  const modal = till.getByRole('dialog').last();
  await modal.waitFor();
  await modal.getByRole('button', { name: 'Passport', exact: true }).click();
  await till.waitForTimeout(600);
  const verify = modal.getByRole('button', { name: /^Verify Expat|^Choose proof/ });
  const empty = { needed: flat(await modal.getByTestId('tier-evidence-expiry-needed').innerText().catch(() => '')), verifyEnabled: await verify.isEnabled() };
  await shot(till, 'x1-expat-expiry-required-when-empty.png');
  const nextYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  await modal.locator('#tier-evidence-expiry').fill(nextYear);
  await till.waitForTimeout(600);
  const filled = { needed: await modal.getByTestId('tier-evidence-expiry-needed').count(), verifyEnabled: await verify.isEnabled() };
  await shot(till, 'x2-expat-expiry-given-verify-enabled.png');
  point('1019-expiry', /expiry date/.test(empty.needed) && empty.verifyEnabled === false && filled.verifyEnabled === true,
    ['x1-expat-expiry-required-when-empty.png', 'x2-expat-expiry-given-verify-enabled.png'],
    'The Expat document step refuses an empty expiry date ("Enter the document\'s expiry date.", Verify disabled) and accepts a date', { empty, filled });
  await verify.click();
  await modal.waitFor({ state: 'hidden', timeout: 30000 });
  await till.waitForTimeout(1500);
  receipt.checks.expatVerified = true; save();

  phase('x: the same family again: straight to tickets with "change"');
  await home();
  await identifyOnDisplay(null);
  await display.page.getByRole('button', { name: 'Continue', exact: true }).click();
  if (await visiting.waitFor({ timeout: 20000 }).then(() => true).catch(() => false)) await visiting.getByRole('button', { name: 'Skip for now', exact: true }).click();
  await till.waitForTimeout(3000);
  const skip = { rateStep: await till.getByRole('heading', { name: 'Select Customer Type', exact: true }).count() };
  await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click().catch(() => {});
  await till.waitForTimeout(1500);
  skip.changeLink = await till.getByTestId('order-change-tier').count();
  skip.pill = flat(await till.getByTestId('order-change-tier').locator('..').innerText().catch(() => ''));
  await shot(till, 'x3-expat-straight-to-tickets-change-link.png');
  point('1019-expat', skip.rateStep === 0 && skip.changeLink === 1, ['x3-expat-straight-to-tickets-change-link.png'],
    'A member with a valid Expat rate goes straight to tickets; the rate shows on the order with a "change" link', skip);

  phase('x: "change" back to the rate step; the Thai rate asks no document and no date');
  await till.getByTestId('order-change-tier').click();
  const all = till.getByText('Show all rates', { exact: true });
  if (await all.isVisible().catch(() => false)) await all.click();
  await till.getByRole('heading', { name: 'Thai', exact: true }).first().click();
  const thai = till.getByRole('dialog').last();
  await thai.waitFor();
  const thaiSeen = { dateFields: await thai.locator('input[type="date"]').count(), confirm: await thai.getByRole('button', { name: /Confirm Thai rate/ }).count() };
  await shot(till, 'x4-thai-rate-no-expiry-asked.png');
  point('1019-thai', thaiSeen.dateFields === 0 && thaiSeen.confirm === 1, ['x4-thai-rate-no-expiry-asked.png'],
    'The Thai rate (the ID-card case) is confirmed with no document and no expiry date', thaiSeen);
  await thai.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => till.keyboard.press('Escape'));
}

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    if (display) await shot(display.page, `failed-${key}-display.png`).catch(() => {});
  }
};

try {
  phase('deployments');
  receipt.deployments = {};
  for (const name of ['oto-api-staging', 'oto-pos-staging', 'oto-pos-web-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=10`)).map((x) => x.deploy).find((x) => x.status === 'live');
    receipt.deployments[name] = { id: d?.id, status: d?.status, sha: d?.commit?.id };
  }
  save();
  const { execSync } = await import('node:child_process');
  for (const name of ['oto-api-staging', 'oto-pos-web-staging']) {
    const live = receipt.deployments[name].sha;
    execSync(`git merge-base --is-ancestor ${sha} ${live}`, { cwd: repo });
    receipt.deployments[name].containsProvedSha = true;
  }
  phase('sign in and create own till');
  await adminSignIn();
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find((b) => /Central Floresta/.test(b.name));
  assert.ok(branch); branchId = branch.id;
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find((b) => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online');
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const printerSource = stations.find((s) => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every((role) => s.devices.some((d) => d.role === role)));
  assert.ok(printerSource, 'simulated printers already configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map((role) => ({ role, deviceId: printerSource.devices.find((d) => d.role === role).deviceId }));
  receiptDevice = devices.find((d) => d.role === 'receipt').deviceId;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T.slice(1)}${String(i + 1).padStart(2, "0")}`).find((p) => !stations.some((s) => s.codePrefix === p));
  assert.ok(prefix);
  if (wanted.includes('a')) assert.equal((await call('GET', `/members/lookup?phone=${number}`)).body.member, null, 'ZZ TEST number must be unused');
  else memberId = (await call('GET', `/members/lookup?phone=${number}`)).body.member?.id ?? null;
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

  const video = resolve(out, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  watch(till, 'till');
  await till.goto(pos);
  phase('reception signs in at the own till');
  await signInAtTill(till);

  for (const key of ['a', 'f', 'p', 'r', 'w', 'x']) if (wanted.includes(key)) await attempt(key, { a: passA, f: passF, p: passP, r: passR, w: passW, x: passX }[key]);
  receipt.passed = !failed && Object.values(receipt.points).every((v) => v.pass === true);
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
  await clean('unpair customer display', () => dropDisplay());
  for (const item of registrations.filter((r) => r.id)) await clean(`release ${item.id}`, () => release(item.id));
  if (station) {
    let sales = [];
    await clean('read own sales', async () => { sales = await stationSales(); for (const s of sales) assert.equal(s.stationId, station.id); });
    for (const sale of sales.filter((s) => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
      assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
      receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided' });
    });
    await clean('final sales read-back', async () => {
      const final = await stationSales();
      receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map((s) => ({ id: s.id, status: s.status, grossSatang: s.totals?.grossSatang ?? null })) });
    });
    await clean('retire own till', async () => {
      assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
      assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
      receipt.cleanup.push({ kind: 'station', id: station.id, archived: true });
    });
  }
  const toArchive = process.env.KEEP_FAMILY === '1' ? [] : [number, ...(process.env.ARCHIVE_ALSO ?? '').split(',').filter(Boolean).map((b) => '08981017' + b.padStart(2, '0'))];
  for (const phone of toArchive) await clean('archive the ZZ TEST family', async () => {
    const member = (await call('GET', `/members/lookup?phone=${phone}`)).body.member;
    if (!member) { receipt.cleanup.push({ kind: 'member', none: true }); return; }
    assert.ok(String(member.nickname).startsWith(`ZZ TEST SCRUM-${T}`), 'only own test member');
    assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
    assert.equal((await call("GET", `/members/lookup?phone=${phone}`)).body.member, null);
    receipt.cleanup.push({ kind: 'member', id: member.id, archived: true });
  });
  if (till) await clean('sign out till', async () => {
    if ((await till.request.get('/api/me')).status() === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.cleanup.push({ kind: 'till-session', signedOut: true });
  });
  await clean('sign out admin', async () => {
    if ((await admin.get('/api/me')).status() === 200) assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.pass])), failures: receipt.failures ?? [], odd: receipt.odd.length, pageErrors: receipt.pageErrors.length, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
