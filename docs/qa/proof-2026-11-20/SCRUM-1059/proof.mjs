// Staging proof for SCRUM-1059, the finish points seen in the staging checks
// of the counter flow, as landed. Adapted from the SCRUM-1048 harness of
// 19 November. Own ZZ TEST till on the simulated box, paired customer
// displays (600x1024, 768x1024, 1024x768), the seeded reception account at
// the till, cash only, a ZZ TEST family made through the till with an
// invented number. No credential, pairing code, band code, phone, key or raw
// response body enters the receipt or the console.
//
//   node proof.mjs <full-sha> <run-tag> [passes]
//   passes: f  the first visit: two children on Eat & Play with no adult;
//              staff add ฿300 food credit for the first (2: the order before
//              and after Continue, the form carrying it); names typed on the
//              768 and 1024 displays (6); the second child's included-credit
//              tick and staff's copy of the food line (9); cash; Check in
//              now and the bracelet cards (8); food paid from the first
//              child's band and the confirmed order's "F&B credit" (5)
//           r  the return visit: "Who's visiting today?" with an allergy
//              changed and the reply lost at the edge after the write, then
//              Confirm again (1: one key, one audit row); the short form's
//              line while staff decide the last photo (7); Still matches;
//              cash; the child's band at F&B, "Food not authorized" in the
//              light and the dark theme (4)
// ZZ_BASE moves the invented number; each run asserts it is unused first.
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
const tag = process.argv[3] ?? 'run';
const out = resolve(import.meta.dirname, tag);
mkdirSync(out, { recursive: true });
const wanted = (process.argv[4] ?? 'f,r').split(',');
const base = String(Number(process.env.ZZ_BASE ?? 21)).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const FAM = { number: '08981059' + base, name: `ZZ TEST SCRUM-1059 family ${base}`, guardian: `ZZ TEST SCRUM-1059 guardian ${base}`,
  kidA: `ZZ TEST Nok ${base}`, kidB: `ZZ TEST Pim ${base}` };
const receipt = { ticket: 'SCRUM-1059', sha, startedAt: new Date().toISOString(), phase: 'preflight', passes: wanted,
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

let browser = null, till = null, station = null, branchId = null, failed = false;
const displays = [];
const knownSales = new Set();
const registrations = [];

const PHONE_TEXT = /(\+66|\b0)\s?\d{1,2}\s?\d{3}\s?\d{4}\b/;
// A band code has a letter after its prefix; a receipt number (Z04808-000001) is all digits and stays.
const BAND_TEXT = /#?Z\d{5,6}-(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,8}\b/;
const masksOf = (page) => [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
  page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/), page.locator('div.grid.gap-px'),
  page.getByTestId('band-codes').locator('span.font-mono'), page.getByText(/^Z\d{5,6}-[A-Z0-9]{4,8}$/), page.getByText(BAND_TEXT),
  page.locator('[data-testid="consent-kept-phone"] .tabular-nums'), page.locator('input[type="tel"]'),
  page.getByText(PHONE_TEXT)];
const shot = async (page, name, target = page, masks = null) => {
  await target.screenshot({ path: resolve(out, name), animations: 'disabled', mask: masks ?? masksOf(page) });
  console.log('picture', name);
  return `SCRUM-1059/${tag}/${name}`;
};
function watch(page, label) {
  page.on('pageerror', (e) => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` });
  });
}
const fixtureName = `ZZ TEST SCRUM-1059 proof till ${Date.now()}`;
const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const landing = (page) => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digitsToType) => { for (const digit of digitsToType) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const paymentStep = () => till.getByTestId('payment-step');
const home = async () => { await till.goto('/'); await landing(till).or(till.getByRole('heading', { name: 'Membership Check', exact: true })).first().waitFor(); };
const registrationOf = async (id) => (await call('GET', '/checkin/registrations/' + id)).body;
const lookup = async (number) => (await call('GET', `/members/lookup?phone=${number}`)).body.member;
const walletOf = async (key) => (await call('GET', `/wallets/lookup?key=${encodeURIComponent(key)}`)).body;
const satang = (w) => w?.wallet?.balanceSatang ?? w?.wallet?.balance ?? null;
const saleRead = async (id) => (await call('GET', `/sales/${id}`)).body;
const bandsIn = (read) => read?.bands ?? read?.sale?.bands ?? [];
const textsOf = async (locator) => Promise.all((await locator.all()).map(async (l) => flat(await l.innerText().catch(() => ''))));
/** The order panel's "Total" row, as staff read it. */
const totalOnTill = async () => flat(await till.getByText('Total', { exact: true }).last().locator('xpath=..').innerText().catch(() => ''));

async function signInAtTill(page, who = 'RECEPTION') {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(`STAGING_${who}_PHONE`).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(`STAGING_${who}_PASSWORD`));
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
async function pairDisplay(letter, viewport = { width: 600, height: 1024 }) {
  phase(`pair customer display ${letter} (${viewport.width}x${viewport.height})`);
  const context = await browser.newContext({ baseURL: pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  watch(page, `display ${letter}`);
  await page.goto(`${pos}/display`);
  await page.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
  const name = `ZZ TEST SCRUM-1059 display ${letter}`;
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name });
  assert.equal(paired.status, 200);
  const d = { letter, name, context, page, id: paired.body.device.id, revoked: false };
  displays.push(d);
  receipt.created.push({ kind: 'display', id: d.id, name }); save();
  await landing(page).waitFor();
  return d;
}
async function dropDisplay(d, reason = 'ZZ TEST SCRUM-1059 proof complete') {
  const at = displays.indexOf(d);
  if (at >= 0) displays.splice(at, 1);
  if (!d.revoked) {
    const r = await call('POST', `/credentials/${d.id}/revoke`, { reason });
    assert.ok([200, 409].includes(r.status));
    receipt.cleanup.push({ kind: 'display', id: d.id, revoked: true }); save();
  }
  await d.context.close().catch(() => {});
}
async function identifyOnDisplay(page, number, nickname) {
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
/** Continue on the display; a request the display gave up on (its 8 s limit) offers Retry, pressed and recorded. */
async function continueOnDisplay(page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  for (let i = 0; i < 3; i++) {
    if (!(await retry.waitFor({ timeout: 6000 }).then(() => true).catch(() => false))) return;
    odd('the display said "Connection interrupted" and offered Retry; Retry pressed');
    await retry.click();
    await page.waitForTimeout(2500);
    const again = page.getByRole('button', { name: 'Continue', exact: true });
    if (await again.isVisible().catch(() => false)) await again.click();
  }
}
async function memberMade(number) {
  let found = null;
  await expect.poll(async () => { found = await lookup(number); return Boolean(found); }, { timeout: 30000 }).toBe(true);
  if (!receipt.created.some((c) => c.kind === 'member' && c.id === found.id)) { receipt.created.push({ kind: 'member', id: found.id }); save(); }
  return found;
}
async function skipVisiting() {
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  if (await visiting.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) await visiting.getByRole('button', { name: 'Skip for now', exact: true }).click();
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
  const tiers = till.getByRole('heading', { name: 'Select Customer Type', exact: true });
  await tiers.or(till.getByRole('heading', { name: pkg, exact: true }).first()).first().waitFor({ timeout: 30000 });
  if (rate && await tiers.isVisible().catch(() => false)) await till.getByRole('heading', { name: rate, exact: true }).first().click();
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
async function staffPhotos(look = null) {
  await till.getByRole('button', { name: 'Private child details', exact: true }).click();
  const details = till.getByRole('dialog', { name: 'Private child details', exact: true });
  await details.waitFor();
  if (look) await look(details);
  const starts = details.getByRole('button', { name: 'Start camera', exact: true });
  for (let i = 0; i < 4 && await starts.count(); i++) {
    await starts.first().click();
    await details.getByRole('button', { name: 'Take photo', exact: true }).first().click();
    await till.waitForTimeout(800);
  }
  await details.getByRole('button', { name: 'Close', exact: true }).click();
}
/** Ticks every box on the form's current step except the included-credit ticks, which a pass sets itself. */
async function tickAgreements(consent) {
  for (const checkbox of await consent.getByRole('checkbox').all()) {
    if ((await checkbox.getAttribute('data-testid'))?.endsWith('consent-order-with-included')) continue;
    if (!(await checkbox.isChecked())) await checkbox.check();
  }
}
async function familyDone(page) {
  const consent = page.getByTestId('display-consent');
  const done = consent.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeEnabled({ timeout: 30000 });
  const [registered] = await Promise.all([
    till.waitForResponse((r) => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST', { timeout: 60000 }),
    done.click(),
  ]);
  const reg = await registered.json().catch(() => null);
  registrations.push({ id: reg?.id ?? null });
  receipt.created.push({ kind: 'registration', id: reg?.id ?? null }); save();
  return { status: registered.status(), sent: registered.request().postDataJSON(), reg };
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
    const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-1059 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const released = await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    assert.equal(released.status, 200);
  }
  const after = await registrationOf(regId);
  receipt.cleanup.push({ kind: 'released', id: regId, children: after.children.map((c) => c.status) }); save();
}
async function scanBand(code) {
  await home();
  await till.getByRole('button', { name: 'F&B', exact: true }).click();
  await till.getByRole('heading', { name: 'Scan Wristband', exact: true }).waitFor();
  await till.getByPlaceholder('Wristband code e.g. 1001').fill(code);
  await till.getByPlaceholder('Wristband code e.g. 1001').press('Enter');
  await till.waitForTimeout(3000);
}
/** One dish on the scanned band; returns whether the "Food not authorized" box asked for a manager. */
async function addDish() {
  const search = till.getByPlaceholder('Search dish…');
  await search.waitFor({ timeout: 20000 });
  await search.fill('Smashed avocado');
  await till.getByText('Smashed avocado + bruschetta', { exact: true }).first().click();
  const refusal = till.getByRole('heading', { name: 'Food not authorized', exact: true });
  const d = till.getByRole('dialog');
  const egg = d.getByRole('button', { name: /Egg your way/ });
  for (let i = 0; i < 10; i++) {
    if (await refusal.isVisible().catch(() => false)) return true;
    if (await egg.isVisible().catch(() => false)) break;
    if (await till.getByRole('button', { name: /^Charge ฿/ }).isEnabled().catch(() => false)) break;
    await till.waitForTimeout(500);
  }
  if (await egg.isVisible().catch(() => false)) await egg.click();
  const add = d.getByRole('button', { name: /^Add to order/ });
  if (await add.isVisible().catch(() => false)) { await add.click(); await d.waitFor({ state: 'hidden' }).catch(() => {}); }
  await till.waitForTimeout(1200);
  return await refusal.isVisible().catch(() => false);
}
async function chargeFromBand(pictureName) {
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
  const pay = await shot(till, pictureName);
  await till.getByRole('button', { name: 'Complete Order', exact: true }).click();
  await till.getByRole('heading', { name: 'Order Confirmed', exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(2000);
  const sale = (await stationSales()).find((s) => !knownSales.has(s.id) && s.status === 'finalised');
  if (sale) { knownSales.add(sale.id); receipt.created.push({ kind: 'sale', id: sale.id, note: 'F&B paid from the band' }); }
  return { pay, saleId: sale?.id ?? null };
}
/** The page drawn in the staff dark or light theme by its own class, for a picture; nothing is saved to the account. */
async function drawTheme(page, theme) {
  return page.evaluate((want) => {
    const root = document.documentElement;
    const was = root.classList.contains('dark') ? 'dark' : 'light';
    // The till paints its staff theme as one class on the root, as `createThemeController` does.
    root.classList.toggle('dark', want === 'dark');
    root.classList.toggle('light', want === 'light');
    return was;
  }, theme);
}

let first = null;

// ---- f: the first visit ----
async function passF() {
  const a = displays[0];
  await home();
  const b = await pairDisplay('B', { width: 768, height: 1024 });
  const c = await pairDisplay('C', { width: 1024, height: 768 });
  await till.waitForTimeout(5000);
  phase('f: the family types a new number and a name on display A');
  await identifyOnDisplay(a.page, FAM.number, FAM.name);
  await continueOnDisplay(a.page);
  const member = await memberMade(FAM.number);
  await skipVisiting();

  phase('f: Eat & Play, two children, no adult; staff add ฿300 food credit for the first child');
  await chooseTicket('Eat & Play Kids Pass', 2, 0);
  await till.getByTestId('extra-credit-open').first().click();
  await till.getByTestId('extra-credit-kid-1').click().catch(() => odd('no child choice on the food credit adder'));
  for (let i = 0; i < 6; i++) { await till.getByTestId('extra-credit-more').click(); await till.waitForTimeout(150); }
  const amount = flat(await till.getByTestId('extra-credit-amount').innerText());
  await till.getByTestId('extra-credit-add').click();
  await till.getByTestId('order-extra-credit').first().waitFor({ timeout: 20000 });
  await till.waitForTimeout(2000);
  const before = { amount, staffLines: await textsOf(till.getByTestId('order-extra-credit')), formLines: await textsOf(till.getByTestId('order-food-credit')), total: await totalOnTill() };
  const p2a = await shot(till, 'p2a-till-order-before-continue.png');

  phase('f: Continue: the drop-off form on the three displays');
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const forms = [a, b, c].map((d) => d.page.getByTestId('display-consent'));
  for (const f of forms) await f.waitFor({ timeout: 30000 });
  const cardsOf = (f) => f.getByTestId('consent-child');
  const nameBox = (f, i) => cardsOf(f).nth(i).getByPlaceholder('Full name', { exact: true });
  for (const f of forms) await expect(cardsOf(f)).toHaveCount(2, { timeout: 20000 });

  phase('f: the first child\'s name typed on display B (768x1024), the second\'s on display C (1024x768)');
  await nameBox(forms[1], 0).fill(FAM.kidA);
  await b.page.waitForTimeout(4000);
  await nameBox(forms[2], 1).fill(FAM.kidB);
  await c.page.waitForTimeout(4000);
  const typed = {};
  for (const [d, f] of [[b, forms[1]], [c, forms[2]]]) {
    typed[d.letter] = await Promise.all([0, 1].map((i) => nameBox(f, i).evaluate((el) => {
      const s = getComputedStyle(el);
      return { filled: el.value.length > 0, fontSize: s.fontSize, boxHeight: Math.round(el.getBoundingClientRect().height) };
    })));
    typed[d.letter + 'Sideways'] = await d.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  }
  await nameBox(forms[1], 0).scrollIntoViewIfNeeded();
  const p6a = await shot(b.page, 'p6a-display-768x1024-name-typed.png');
  await nameBox(forms[2], 1).scrollIntoViewIfNeeded();
  const p6b = await shot(c.page, 'p6b-display-1024x768-name-typed.png');
  receipt.checks.typed = typed; save();
  const all24 = ['B', 'C'].every((k) => typed[k].every((box) => box.filled && box.fontSize === '24px'));
  point('6-typed-size', all24 && typed.BSideways === false && typed.CSideways === false, [p6a, p6b],
    'Names typed on the 768x1024 and the 1024x768 displays draw at the box\'s own 24 px, as on the 600 display', typed);

  phase('f: ages on display A; the care step carries staff\'s ฿300 for the first child');
  await expect(nameBox(forms[0], 0)).toHaveValue(FAM.kidA, { timeout: 15000 });
  await expect(nameBox(forms[0], 1)).toHaveValue(FAM.kidB, { timeout: 15000 });
  await setAge(a.page, cardsOf(forms[0]).nth(0), 6);
  await setAge(a.page, cardsOf(forms[0]).nth(1), 7);
  await expect(forms[0].getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await forms[0].getByRole('button', { name: 'Continue', exact: true }).click();
  await forms[0].getByTestId('consent-care').first().waitFor();
  const extras = forms[0].getByTestId('consent-extra-credit');
  await expect(extras.first()).toHaveText('฿300', { timeout: 20000 });
  const extraShown = await textsOf(extras);
  const ticks = forms[0].getByTestId('public-consent-order-with-included');
  const tickCount = await ticks.count();
  await extras.first().scrollIntoViewIfNeeded();
  await a.page.waitForTimeout(800);
  const p2b = await shot(a.page, 'p2b-display-form-carries-staff-credit.png');
  phase('f: the parent ticks "may order food with the included credit" for the second child');
  await ticks.first().check();
  await a.page.waitForTimeout(2000);
  await forms[0].getByRole('button', { name: 'Continue', exact: true }).click();
  const guardianBox = forms[0].getByPlaceholder('Your full name', { exact: true });
  if (await guardianBox.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) await guardianBox.fill(FAM.guardian);
  await tickAgreements(forms[0]);
  await a.page.waitForTimeout(1500);

  phase('f: staff\'s copy of the food line; staff photos');
  let staffCopy = null, p9 = null;
  await staffPhotos(async (details) => {
    const included = details.getByText('Included credit', { exact: true });
    if (!(await included.first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false))) odd('staff\'s copy shows no "Included credit"');
    await included.first().scrollIntoViewIfNeeded().catch(() => {});
    await till.waitForTimeout(800);
    staffCopy = {
      includedCredit: await details.getByText('Included credit', { exact: true }).count(),
      noFood: await details.getByText('No food', { exact: true }).count(),
      tickedByFamily: await details.getByText(/\(ticked by the family\)/).count(),
      familyTicksOnScreen: await details.getByText(/the family ticks this on their screen/).count(),
    };
    p9 = await shot(till, 'p9-till-staff-copy-included-credit.png', details, [details.locator('input[type="tel"]'), details.getByText(PHONE_TEXT), details.getByText(BAND_TEXT)]);
  });
  receipt.checks.staffCopy = staffCopy; save();
  point('9-staff-copy', staffCopy?.includedCredit === 1 && staffCopy?.noFood === 1 && staffCopy?.tickedByFamily >= 1, [p9],
    'Staff\'s copy: the child whose parent ticked "may order food with the included credit" reads "Included credit" on the food choice, not "No food"; the child with staff\'s ฿300 keeps "Prepaid credit"', staffCopy ?? {});

  phase('f: the family\'s Done; the order after the gate');
  const written = await familyDone(a.page);
  assert.equal(written.status, 200);
  const sale = await newSale();
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  await till.waitForTimeout(2500);
  const after = { staffLines: await textsOf(till.getByTestId('order-extra-credit')), formLines: await textsOf(till.getByTestId('order-food-credit')), total: await totalOnTill() };
  const p2c = await shot(till, 'p2c-till-order-after-continue.png');
  const sentFood = (written.sent?.children ?? []).map((ch) => ({ name: ch.name === FAM.kidA ? 'first' : ch.name === FAM.kidB ? 'second' : 'other',
    foodProvision: ch.foodProvision ?? null, mayOrderFood: ch.mayOrderFood ?? null, orderWithIncludedCredit: ch.orderWithIncludedCredit ?? null }));
  await payCash();
  await checkInNow(written.reg.id);
  const confirmation = flat(await till.locator('body').innerText());
  const bracelet = { printsAtCheckIn: await till.getByText('Prints at check-in', { exact: true }).count(), bandCodeRows: await till.getByTestId('band-codes').count(),
    namesShown: [FAM.kidA, FAM.kidB].map((n) => confirmation.includes(n)) };
  const p8 = await shot(till, 'p8-paid-checked-in-bracelet-cards.png');
  const read = await saleRead(sale.id);
  const bands = bandsIn(read);
  const codeOf = (name) => bands.find((band) => band.childName === name)?.shortCode ?? null;
  const codes = { a: codeOf(FAM.kidA), b: codeOf(FAM.kidB) };
  const balances = { a: codes.a ? satang(await walletOf(codes.a)) : null, b: codes.b ? satang(await walletOf(codes.b)) : null };
  const lines = (read?.lines ?? read?.sale?.lines ?? []).map((l) => ({ label: l.label ?? l.name ?? null, amountSatang: l.amountSatang ?? l.totalSatang ?? l.lineTotalSatang ?? null }));
  const gross = read?.sale?.totals?.grossSatang ?? read?.totals?.grossSatang ?? null;
  receipt.checks.f = { memberId: member.id, saleId: sale.id, registrationId: written.reg.id, before, after, extraShown, tickCount, sentFood, bracelet, balances, lines, grossSatang: gross }; save();
  point('2-credit-into-form', /300/.test(before.amount) && before.staffLines.length === 1 && extraShown[0] === '฿300' && extraShown[1] === '฿0'
    && after.staffLines.length === 0 && after.formLines.length === 1 && /300/.test(after.formLines[0] ?? '') && balances.a === 160000 && balances.b === 130000,
  [p2a, p2b, p2c],
  'Staff add ฿300 food credit for the first child on a ticket with no adult; Continue opens that child\'s form with ฿300 already chosen; after the gate the order has it once, on the child\'s drop-off line, and the band holds ฿1,300 + ฿300; the second child\'s band holds the ticket\'s ฿1,300 alone',
  receipt.checks.f);
  point('8-bracelet-after-check-in', bracelet.printsAtCheckIn === 0 && bracelet.bandCodeRows >= 2 && bracelet.namesShown.every(Boolean), [p8],
    'After "Check in now" the Payment Successful screen\'s bracelet cards show each child\'s band (code masked) and name, and no longer "Prints at check-in"', bracelet);

  phase('f: food paid from the first child\'s band; the confirmed order');
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  assert.ok(codes.a, 'the first child\'s band');
  await scanBand(codes.a);
  const asked = await addDish();
  assert.equal(asked, false, 'a child with food credit is not asked for a manager');
  const fnb = await chargeFromBand('p5a-fnb-pay-from-band.png');
  const confirmed = flat(await till.locator('body').innerText());
  const fbRow = { fAndBCredit: /F&B credit/.test(confirmed), strayBackslash: confirmed.includes('F\\&B') };
  const p5 = await shot(till, 'p5-fnb-order-confirmed-fb-credit.png');
  receipt.checks.fnb = { ...fbRow, saleId: fnb.saleId }; save();
  point('5-fb-credit', fbRow.fAndBCredit && !fbRow.strayBackslash, [fnb.pay, p5], 'The order paid from the band is confirmed with an "F&B credit" row, with no backslash', fbRow);
  await release(written.reg.id);
  await dropDisplay(b, 'ZZ TEST SCRUM-1059 proof: the 768 display is done');
  await dropDisplay(c, 'ZZ TEST SCRUM-1059 proof: the 1024 display is done');
  first = { memberId: member.id };
}

// ---- r: the return visit ----
async function passR() {
  const a = displays[0];
  await home();
  phase('r: the family types the number on display A');
  await identifyOnDisplay(a.page, FAM.number, null);
  await continueOnDisplay(a.page);
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  await visiting.waitFor({ timeout: 30000 });
  const member = await lookup(FAM.number);
  const kids = member?.children ?? member?.savedChildren ?? [];
  const childA = kids.find((ch) => (ch.name ?? ch.childName) === FAM.kidA);
  assert.ok(childA, 'the first child is saved on the family');
  const cardOf = (name) => visiting.locator('div.rounded-xl.p-3').filter({ has: till.getByText(name, { exact: true }) }).first();
  // Only the first child today.
  const boxB = cardOf(FAM.kidB).getByRole('checkbox');
  if (await boxB.isChecked().catch(() => false)) await boxB.click();
  const cardA = cardOf(FAM.kidA);
  const details = cardA.getByRole('button', { name: /Details/ });
  await details.waitFor({ timeout: 20000 });
  if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
  await cardA.getByLabel('Allergies / medical', { exact: true }).fill('ZZ TEST sesame');

  phase('r: Confirm; the reply to the child\'s change is lost at the edge after the platform wrote it');
  const writes = [];
  let firstKey = null;
  const onPatch = async (route) => {
    const r = route.request();
    if (r.method() !== 'PATCH') return route.continue();
    const key = r.headers()['idempotency-key'] ?? null;
    const response = await route.fetch();
    writes.push({ keyNamed: /^visit-child:[0-9a-f-]{36}$/.test(key ?? ''), sameKeyAsFirst: firstKey === null ? true : key === firstKey,
      platformStatus: response.status(), replayed: response.headers()['x-oto-replay'] === 'true' });
    if (firstKey === null) {
      firstKey = key;
      // What the till sees when the edge gives up on a reply the platform already wrote.
      await route.fulfill({ status: 504, contentType: 'text/plain', body: 'Gateway Timeout' });
      return;
    }
    await route.fulfill({ response });
  };
  const childPath = '**/api/members/children/' + childA.id;
  await till.route(childPath, onPatch);
  const from = new Date(Date.now() - 5000).toISOString();
  const confirm = visiting.getByRole('button', { name: /^Confirm 1 child/ });
  await confirm.click();
  const lost = till.getByText("Couldn't confirm the visit", { exact: true }).first();
  await lost.waitFor({ timeout: 30000 });
  await till.waitForTimeout(800);
  const p1a = await shot(till, 'p1a-visiting-window-reply-lost.png');
  phase('r: Confirm again');
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.click();
  await visiting.waitFor({ state: 'hidden', timeout: 30000 });
  await till.unroute(childPath, onPatch);
  const p1b = await shot(till, 'p1b-visit-confirmed-after-retry.png');
  let trail = [];
  await expect.poll(async () => {
    const body = (await call('GET', `/audit?entityId=${childA.id}&from=${encodeURIComponent(from)}&limit=50`)).body;
    trail = body?.entries ?? body?.items ?? body?.rows ?? body?.audit ?? (Array.isArray(body) ? body : []);
    return trail.length;
  }, { timeout: 20000 }).toBeGreaterThan(0).catch(() => odd('no audit row read for the child'));
  const updates = trail.filter((row) => row.action === 'child.update' || /child/.test(row.action ?? '') && /update/.test(row.action ?? ''));
  const saved = (await call('GET', `/members/${member.id}`)).body?.member?.children?.find((ch) => ch.id === childA.id) ?? null;
  receipt.checks.visitWindow = { writes, auditActions: trail.map((row) => row.action), childUpdateRows: updates.length, allergyNow: saved?.allergies ?? null }; save();
  point('1-visit-window-key', writes.length === 2 && writes.every((w) => w.keyNamed && w.sameKeyAsFirst) && writes[1].replayed === true && updates.length === 1
    && saved?.allergies === 'ZZ TEST sesame', [p1a, p1b],
  '"Who\'s visiting today?": the child\'s change was written, its reply lost; Confirm again sent it under the same key, the platform answered from the first write, and the child has one change row in the activity log',
  receipt.checks.visitWindow);

  phase('r: Eat & Play for the one child; the gate; the short form on display A');
  await chooseTicket('Eat & Play Kids Pass', 1, 0);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const consent = a.page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  await consent.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor({ timeout: 30000 });
  await a.page.waitForTimeout(1500);
  await tickAgreements(consent);
  await a.page.waitForTimeout(2500);
  const choice = till.getByTestId('last-photo-choice');
  const line = consent.getByTestId('consent-missing');
  const shortForm = { line: flat(await line.innerText().catch(() => '')), done: await consent.getByRole('button', { name: 'Done', exact: true }).isEnabled().catch(() => null),
    staffDeciding: await choice.getByRole('button', { name: 'Still matches' }).count() };
  const p7 = await shot(a.page, 'p7-display-600x1024-short-form-team-checking.png');
  const sizes = {};
  for (const [w, h] of [[768, 1024], [1024, 768]]) {
    await a.page.setViewportSize({ width: w, height: h });
    await a.page.waitForTimeout(1200);
    sizes[`${w}x${h}`] = { sideways: await a.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), line: flat(await line.innerText().catch(() => '')) };
  }
  const p7b = await shot(a.page, 'p7b-display-1024x768-short-form-team-checking.png');
  await a.page.setViewportSize({ width: 600, height: 1024 });
  await a.page.waitForTimeout(1200);
  receipt.checks.shortForm = { ...shortForm, sizes }; save();
  point('7-short-form-line', shortForm.line === 'The team is checking the photo — there is nothing more for you to do.' && shortForm.staffDeciding === 1
    && Object.values(sizes).every((s) => !s.sideways && s.line === shortForm.line), [p7, p7b],
  'A returning family\'s short form with the agreements ticked while staff decide the last photo: the line says the team is checking the photo and nothing more is theirs to do; Done waits for staff', receipt.checks.shortForm);

  phase('r: staff press "Still matches"; Done; cash; check-in');
  await choice.getByRole('button', { name: 'Still matches' }).first().click();
  await till.waitForTimeout(1500);
  const written = await familyDone(a.page);
  assert.equal(written.status, 200);
  const sale = await newSale();
  await payCash();
  await checkInNow(written.reg.id);
  const read = await saleRead(sale.id);
  const code = bandsIn(read).find((band) => band.childName === FAM.kidA)?.shortCode ?? bandsIn(read).find((band) => band.kind === 'kid')?.shortCode ?? null;
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});

  phase('r: the child\'s band at F&B: "Food not authorized", light and dark');
  assert.ok(code, 'the child\'s band');
  await scanBand(code);
  const asked = await addDish();
  assert.equal(asked, true, 'the child with no food chosen is asked for a manager');
  const box = till.getByRole('dialog').filter({ has: till.getByRole('heading', { name: 'Food not authorized', exact: true }) }).last();
  const inks = async () => box.evaluate((el) => {
    const pick = (node) => node ? getComputedStyle(node).color : null;
    const words = [...el.querySelectorAll('span')].find((s) => /^Only override after confirming/.test((s.textContent ?? '').trim()));
    return { title: pick(el.querySelector('h2')), warning: pick(words), backdrop: pick(words?.closest('.rounded-xl') ?? null) && getComputedStyle(el).backgroundColor };
  });
  const was = await drawTheme(till, 'light');
  await till.waitForTimeout(600);
  const light = await inks();
  const p4a = await shot(till, 'p4a-fnb-food-not-authorized-light.png');
  await drawTheme(till, 'dark');
  await till.waitForTimeout(600);
  const dark = await inks();
  const p4b = await shot(till, 'p4b-fnb-food-not-authorized-dark.png');
  await drawTheme(till, was);
  await till.getByRole('button', { name: 'Cancel', exact: true }).last().click().catch(() => {});
  receipt.checks.foodBox = { accountTheme: was, light, dark }; save();
  point('4-food-box-ink', Boolean(light.title && light.warning) && light.title !== dark.title && light.warning !== dark.warning, [p4a, p4b],
    'The "Food not authorized" box reads in the light theme (amber-800 title, amber-900 warning) and keeps its dark-theme inks', receipt.checks.foodBox);
  await release(written.reg.id);
}

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    for (const d of displays) await shot(d.page, `failed-${key}-display-${d.letter}.png`).catch(() => {});
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
  for (const name of ['oto-pos-staging', 'oto-pos-web-staging']) {
    execSync(`git merge-base --is-ancestor ${sha} ${receipt.deployments[name].sha}`, { cwd: repo });
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
  const prefix = Array.from({ length: 99 }, (_, i) => `Z059${String(i + 1).padStart(2, '0')}`).find((p) => !stations.some((s) => s.codePrefix === p));
  assert.ok(prefix);
  if (wanted.includes('f')) assert.equal(await lookup(FAM.number), null, 'the ZZ TEST number must be unused');
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

  const raw = process.env.RAW_DIR;
  assert.ok(raw, 'RAW_DIR: a folder outside the repository for the fake camera');
  mkdirSync(raw, { recursive: true });
  const video = resolve(raw, 'camera.y4m');
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
  await pairDisplay('A');

  for (const key of ['f', 'r']) if (wanted.includes(key)) await attempt(key, { f: passF, r: passR }[key]);
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
  for (const d of [...displays]) await clean(`unpair display ${d.letter}`, () => dropDisplay(d));
  for (const item of registrations.filter((r) => r.id)) await clean(`release ${item.id}`, () => release(item.id));
  if (station) {
    let sales = [];
    await clean('read own sales', async () => { sales = await stationSales(); for (const s of sales) assert.equal(s.stationId, station.id); });
    for (const sale of sales.filter((s) => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
      assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: 'ZZ TEST SCRUM-1059 proof cleanup' })).status, 200);
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
  if (process.env.KEEP_FAMILY !== '1') await clean('archive the ZZ TEST family', async () => {
    const member = await lookup(FAM.number);
    if (!member) { receipt.cleanup.push({ kind: 'member', none: true }); return; }
    assert.ok(String(member.nickname).startsWith('ZZ TEST SCRUM-1059'), 'only own test member');
    assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
    assert.equal(await lookup(FAM.number), null);
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
