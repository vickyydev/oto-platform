// Staging proof for the second counter round, as landed: SCRUM-1048 (extra
// food credit on any child ticket), SCRUM-1019 R1 (a number with no name),
// SCRUM-1054 (the parent's included-credit tick) and SCRUM-1041 (several
// customer displays on one till). Adapted from the SCRUM-1052 harness beside
// this folder. Own ZZ TEST till on the simulated box, paired customer
// displays, the seeded reception account at the till (the seeded manager only
// to remove a display, which is a manager's), cash only, ZZ TEST families and
// children made through the till, invented numbers. No credential, pairing
// code, band code, phone or raw response body enters the receipt or the
// console. Receipt pictures from the simulated printer are written outside
// the repository (RAW_DIR) and only masked copies come back in.
//
//   node proof.mjs <full-sha> <run-tag> <passes>
//   passes: x  SCRUM-1048: an adult and a child on Eat & Play; staff add ฿300
//              extra food credit for the child as its own line; cash; the
//              band; food from the band; a second sale whose credit line is
//              refunded from History before any is spent
//           n  SCRUM-1019 + SCRUM-1054: a new number with no name; two
//              children dropped off on Eat & Play; the parent ticks the
//              included-credit box for one; cash; check-in; food from the
//              ticked child's band with no manager; the other is asked for a
//              manager; the next visit's welcome; a name given in the Console
//              and shown instead
//           m  SCRUM-1041: a second and a third display; the same sale and one
//              form on each; the language followed; a fourth refused in the
//              Console; the manager removes one at the till, the others go on
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
const tag = process.argv[3] ?? 'run';
const dirOf = (ticket) => { const dir = resolve(import.meta.dirname, '..', ticket, tag); mkdirSync(dir, { recursive: true }); return dir; };
const out = dirOf('SCRUM-1048');
const RAW = process.env.RAW_DIR;
assert.ok(RAW, 'RAW_DIR: a folder outside the repository for unmasked receipt pictures');
mkdirSync(RAW, { recursive: true });
const wanted = (process.argv[4] ?? 'x,n,m').split(',');
const base = String(Number(process.env.ZZ_BASE ?? 21)).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const CONSOLE = 'https://oto-console-staging.onrender.com';
const FAM = {
  x: { number: '08981048' + base, name: `ZZ TEST SCRUM-1048 family ${base}` },
  n: { number: '08981019' + base, name: null, later: `ZZ TEST SCRUM-1019 family ${base}`, guardian: `ZZ TEST SCRUM-1019 guardian ${base}`,
    kidA: `ZZ TEST Nok ${base}`, kidB: `ZZ TEST Pim ${base}` },
  m: { number: '08981041' + base, name: `ZZ TEST SCRUM-1041 family ${base}`, guardian: `ZZ TEST SCRUM-1041 guardian ${base}`, kid: `ZZ TEST Fah ${base}` },
};
const receipt = { tickets: ['SCRUM-1048', 'SCRUM-1019', 'SCRUM-1054', 'SCRUM-1041'], sha, startedAt: new Date().toISOString(), phase: 'preflight', passes: wanted,
  points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], cleanup: [], raw: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = (value) => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const firstLine = (error) => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
const point = (key, pass, pictures, shows, seen = {}) => { receipt.points[key] = { pass, pictures, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); };
const odd = (what) => { receipt.odd.push({ at: receipt.phase, what }); save(); console.log('ODD', what); };
const digits = (text) => String(text ?? '').replace(/\D/g, '');
/** The member's name is the family's own number (R1): never recorded, only whether it is. */
const isOwnNumber = (name, number) => digits(name).endsWith(number.slice(1)) && !/[A-Za-z]/.test(String(name));

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

let browser = null, till = null, station = null, branchId = null, failed = false, receiptDevice = null;
const displays = [];
const knownSales = new Set();
const registrations = [];
const members = {};

const PHONE_TEXT = /(\+66|\b0)\s?\d{1,2}\s?\d{3}\s?\d{4}\b/;
// A band code has a letter after its prefix; a receipt number (Z04808-000001) is all digits and stays.
const BAND_TEXT = /#?Z\d{5,6}-(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,8}\b/;
const shot = async (page, name, ticket = 'SCRUM-1048', target = page, masks = null) => {
  await target.screenshot({ path: resolve(dirOf(ticket), name), animations: 'disabled',
    mask: masks ?? [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
      page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/), page.locator('div.grid.gap-px'),
      page.getByTestId('band-codes').locator('span.font-mono'), page.getByText(/^Z\d{5,6}-[A-Z0-9]{4,8}$/), page.getByText(BAND_TEXT),
      page.locator('[data-testid="consent-kept-phone"] .tabular-nums'), page.locator('input[type="tel"]'),
      page.getByText(PHONE_TEXT)] });
  console.log('picture', ticket, name);
  return `${ticket}/${tag}/${name}`;
};
function watch(page, label) {
  page.on('pageerror', (e) => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` });
  });
}
const fixtureName = `ZZ TEST SCRUM-1048 proof till ${Date.now()}`;
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
  phase(`pair customer display ${letter}`);
  const context = await browser.newContext({ baseURL: pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  watch(page, `display ${letter}`);
  await page.goto(`${pos}/display`);
  await page.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
  const name = `ZZ TEST SCRUM-1041 display ${letter}`;
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name });
  assert.equal(paired.status, 200);
  const d = { letter, name, context, page, id: paired.body.device.id, revoked: false };
  displays.push(d);
  // What each display asks of the station: the intent's type and action and the answer, nothing typed.
  page.on('requestfinished', async (r) => {
    if (r.method() !== 'POST' || !/\/intents$/.test(new URL(r.url()).pathname)) return;
    const body = (() => { try { return r.postDataJSON(); } catch { return null; } })();
    const status = (await r.response().catch(() => null))?.status() ?? null;
    (receipt.checks.intents ??= []).push({ display: letter, at: receipt.phase, ms: Date.now(), type: body?.type ?? null, action: body?.payload?.action ?? null, status });
  });
  page.on('requestfailed', (r) => {
    if (!/\/intents$/.test(new URL(r.url()).pathname)) return;
    (receipt.checks.intents ??= []).push({ display: letter, at: receipt.phase, ms: Date.now(), failed: r.failure()?.errorText ?? 'failed' });
  });
  receipt.created.push({ kind: 'display', id: d.id, name }); save();
  await landing(page).waitFor();
  return d;
}
async function dropDisplay(d, reason = 'ZZ TEST SCRUM-1048 proof complete') {
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
async function staffPhotos(scopeOpener = 'Private child details', look = null) {
  await till.getByRole('button', { name: scopeOpener, exact: true }).click();
  const details = till.getByRole('dialog', { name: scopeOpener, exact: true });
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
    const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-1054 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const released = await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    assert.equal(released.status, 200);
  }
  const after = await registrationOf(regId);
  receipt.cleanup.push({ kind: 'released', id: regId, children: after.children.map((c) => c.status) }); save();
}
/** The newest receipt the simulated printer drew after `since`, kept OUTSIDE the repository. */
async function rawReceipt(name, since) {
  let printed = null;
  await expect.poll(async () => {
    const list = (await call('GET', `/devices/${receiptDevice}/printouts?limit=5`)).body?.printouts ?? [];
    printed = list.filter((p) => new Date(p.at) >= since).at(-1) ?? null;
    return Boolean(printed);
  }, { timeout: 60000 }).toBe(true).catch(() => odd(`no fresh printout for ${name}`));
  if (!printed) return null;
  const png = await call('GET', printed.previewUrl);
  if (png.status !== 200) { odd(`printout ${name}: ${png.status}`); return null; }
  writeFileSync(resolve(RAW, name), png.body);
  receipt.raw.push({ name, seq: printed.seq, at: printed.at }); save();
  console.log('raw receipt (outside the repo)', name);
  return name;
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
async function chargeFromBand(pictureName, ticket) {
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
  const pay = await shot(till, pictureName, ticket);
  const since = new Date(Date.now() - 2000);
  await till.getByRole('button', { name: 'Complete Order', exact: true }).click();
  await till.getByRole('heading', { name: 'Order Confirmed', exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(2000);
  const sale = (await stationSales()).find((s) => !knownSales.has(s.id) && s.status === 'finalised');
  if (sale) { knownSales.add(sale.id); receipt.created.push({ kind: 'sale', id: sale.id, note: 'F&B paid from the band' }); }
  return { pay, since, saleId: sale?.id ?? null };
}
/** Lock, "Sign out and hand over the till", and the next person signs in at the own till. */
async function handOver(who) {
  await home();
  await till.getByLabel('Lock screen').first().click();
  await till.getByRole('button', { name: 'Sign out and hand over the till' }).click();
  await till.locator('input[type="password"]').first().waitFor({ timeout: 30000 });
  await signInAtTill(till, who);
  await home();
  receipt.checks.handOvers = [...(receipt.checks.handOvers ?? []), { to: who.toLowerCase(), at: receipt.phase }]; save();
}
async function switchLanguage(page, nativeLabel) {
  await page.getByRole('button', { name: /Change language|เปลี่ยนภาษา|Сменить язык|更改语言|Changer de langue/ }).first().click();
  await page.getByRole('button', { name: nativeLabel, exact: true }).last().click();
  await page.waitForTimeout(1500);
}
async function consoleSignedIn(who = 'ADMIN') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  watch(page, 'console');
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  if (await page.locator('input[type="password"]').count()) {
    const field = page.locator('input[type="tel"], input[inputmode="tel"]').last();
    const prefix = await field.evaluate((el) => /\+(\d{1,4})/.exec(el.parentElement?.textContent ?? '')?.[1] ?? null).catch(() => null);
    const phone = need(`STAGING_${who}_PHONE`);
    await field.fill(prefix === '66' || !prefix ? phone.replace(/^\+66/, '0') : phone.slice(prefix.length + 1));
    await page.locator('input[type="password"]').last().fill(need(`STAGING_${who}_PASSWORD`));
    // A sign-in staging answers with a passing 502 is pressed once more.
    for (let tries = 0; tries < 2; tries++) {
      await page.getByRole('button', { name: /sign in/i }).first().click();
      if (await expect.poll(async () => page.locator('input[type="password"]').count(), { timeout: 20000 }).toBe(0).then(() => true).catch(() => false)) break;
      odd('the Console sign-in did not answer; pressed again');
    }
  }
  assert.equal(await page.locator('input[type="password"]').count(), 0, 'Console signed in');
  return { context, page };
}

// ---- x: SCRUM-1048, extra food credit on a plain child ticket ----
async function plainTicketWithCredit(fam, letter) {
  const d = displays[0];
  await home();
  phase(`x${letter}: the family types the number and a name on the display`);
  await identifyOnDisplay(d.page, fam.number, letter === 1 ? fam.name : null);
  await continueOnDisplay(d.page);
  const member = await memberMade(fam.number);
  members.x = member.id;
  await skipVisiting();
  phase(`x${letter}: Eat & Play, one child and one adult; Add food credit ฿300`);
  await chooseTicket('Eat & Play Kids Pass', 1, 1);
  const open = till.getByTestId('extra-credit-open').first();
  await open.waitFor({ timeout: 20000 });
  await open.click();
  for (let i = 0; i < 6; i++) { await till.getByTestId('extra-credit-more').click(); await till.waitForTimeout(150); }
  const amount = flat(await till.getByTestId('extra-credit-amount').innerText());
  if (letter === 1) await shot(till, 'x1-till-add-food-credit-300.png');
  await till.getByTestId('extra-credit-add').click();
  const line = till.getByTestId('order-extra-credit');
  await line.waitFor({ timeout: 20000 });
  await till.waitForTimeout(2500);
  const tillLine = flat(await line.innerText());
  // The separate display draws the line as a card of its own: read its words.
  const onDisplay = d.page.getByText('Extra food credit', { exact: true }).first();
  const displayLine = await onDisplay.waitFor({ timeout: 20000 })
    .then(async () => flat(await onDisplay.locator('xpath=ancestor::div[contains(@class,"rounded")][1]').innerText())).catch(() => null);
  if (letter === 1) {
    await shot(till, 'x2-till-order-extra-credit-line.png');
    await shot(d.page, 'x3-display-extra-credit-line.png');
  }
  phase(`x${letter}: Pay, cash`);
  await till.getByRole('button', { name: /^Pay ฿/ }).click();
  const sale = await newSale();
  const since = new Date(Date.now() - 2000);
  await payCash();
  if (letter === 1) await shot(till, 'x4-paid-cash.png');
  const read = await saleRead(sale.id);
  const lines = (read?.lines ?? read?.sale?.lines ?? []).map((l) => ({ label: l.label ?? l.name ?? null, amountSatang: l.amountSatang ?? l.totalSatang ?? l.lineTotalSatang ?? null }));
  const kid = bandsIn(read).find((b) => b.kind === 'kid') ?? null;
  const wallet = kid?.shortCode ? await walletOf(kid.shortCode) : null;
  const raw = await rawReceipt(`x${letter}-sale-receipt.png`, since);
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  return { saleId: sale.id, receiptNumber: read?.sale?.receiptNumber ?? read?.receiptNumber ?? null, amount, tillLine, displayLine, lines,
    kidCode: kid?.shortCode ?? null, bands: bandsIn(read).map((b) => b.kind), balanceSatang: satang(wallet), raw };
}
async function passX() {
  const fam = FAM.x;
  if (!displays.length) await pairDisplay('A');
  const first = await plainTicketWithCredit(fam, 1);
  const { kidCode, ...seen1 } = first;
  receipt.checks.x1 = seen1; save();
  point('1048-line', /300/.test(first.amount) && /Extra food credit/.test(first.tillLine) && /300/.test(first.tillLine) && Boolean(first.displayLine) && /300/.test(first.displayLine ?? ''),
    ['SCRUM-1048/x1-till-add-food-credit-300.png', 'SCRUM-1048/x2-till-order-extra-credit-line.png', 'SCRUM-1048/x3-display-extra-credit-line.png'],
    'On an Eat & Play ticket for an adult and a child (no drop-off) staff add ฿300 extra food credit for the child: its own line on the order and on the display', seen1);
  point('1048-band', first.balanceSatang === 160000, ['SCRUM-1048/x4-paid-cash.png'],
    'Paid in cash: the child\'s band holds the ticket\'s ฿1,300 and the ฿300 extra, ฿1,600', { balanceSatang: first.balanceSatang, bands: first.bands });

  phase('x: food from the band at F&B');
  assert.ok(kidCode, 'the child band of the first sale');
  await scanBand(kidCode);
  const asked = await addDish();
  assert.equal(asked, false, 'a plain ticket child is not asked for a manager');
  const fnb = await chargeFromBand('x5-fnb-paid-from-band.png', 'SCRUM-1048');
  await shot(till, 'x6-fnb-order-confirmed.png');
  const rawFood = await rawReceipt('x6-food-receipt.png', fnb.since);
  const afterFood = satang(await walletOf(kidCode));
  receipt.checks.xFood = { saleId: fnb.saleId, balanceAfterSatang: afterFood, raw: rawFood }; save();
  point('1048-spend', afterFood !== null && afterFood < 160000, ['SCRUM-1048/x5-fnb-paid-from-band.png', 'SCRUM-1048/x6-fnb-order-confirmed.png'],
    'A dish at F&B is paid from the child\'s band; the receipt prints the credit left (read the masked receipt picture)', receipt.checks.xFood);

  phase('x: a second sale; the credit line refunded from History before any is spent');
  const second = await plainTicketWithCredit(fam, 2);
  const code2 = second.kidCode;
  receipt.checks.x2 = { ...second, kidCode: undefined }; save();
  // A refund is a manager's at the counter ("A refund needs a manager's approval").
  await handOver('MANAGER');
  await till.locator('a[href="/history"]').first().click();
  const search = till.getByPlaceholder('Search by name, receipt, bracelet…');
  await search.waitFor({ timeout: 30000 });
  await search.fill(String(second.receiptNumber ?? ''));
  await till.waitForTimeout(3000);
  await till.getByText(String(second.receiptNumber), { exact: false }).first().click();
  const refund = till.getByTestId('refund-sale');
  await expect(refund).toBeEnabled({ timeout: 30000 });
  await refund.click();
  const modal = till.getByRole('dialog').last();
  await modal.getByRole('button', { name: 'By item', exact: true }).click();
  await modal.getByRole('button', { name: /food credit|Prepaid food/i }).first().click();
  await modal.locator('xpath=.//p[contains(., "Reason")]/following-sibling::div[1]//button').first().click();
  await till.waitForTimeout(800);
  await shot(till, 'x7-history-refund-credit-line.png');
  const go = modal.getByRole('button', { name: /^Refund ฿/ });
  const goLabel = flat(await go.innerText());
  await go.click();
  await till.waitForTimeout(4000);
  await shot(till, 'x8-history-credit-refunded.png');
  const afterRefund = code2 ? satang(await walletOf(code2)) : null;
  receipt.checks.xRefund = { by: 'the seeded manager at the till', refundButton: goLabel, balanceBeforeSatang: second.balanceSatang, balanceAfterSatang: afterRefund }; save();
  await handOver('RECEPTION');
  point('1048-refund', second.balanceSatang === 160000 && afterRefund === 130000 && /300/.test(goLabel),
    ['SCRUM-1048/x7-history-refund-credit-line.png', 'SCRUM-1048/x8-history-credit-refunded.png'],
    'A second sale\'s extra credit line refunded from History before any is spent: the band goes back from ฿1,600 to the ticket\'s ฿1,300', receipt.checks.xRefund);
}

// ---- n: SCRUM-1019 (a number with no name) and SCRUM-1054 (the tick) ----
async function passN() {
  const fam = FAM.n;
  if (!displays.length) await pairDisplay('A');
  const d = displays[0];
  await home();
  phase('n: a new number with no name on the display');
  await identifyOnDisplay(d.page, fam.number, null);
  await shot(d.page, 'n1-display-number-no-name.png', 'SCRUM-1019');
  await continueOnDisplay(d.page);
  await till.waitForTimeout(4000);
  const offer = await till.getByRole('dialog', { name: 'New member?', exact: true }).count();
  const member = await memberMade(fam.number);
  members.n = member.id;
  fam.heldAs = member.nickname;
  const byNumber = isOwnNumber(member.nickname, fam.number);
  await skipVisiting();
  phase('n: Eat & Play, two children, no adult');
  await chooseTicket('Eat & Play Kids Pass', 2, 0);
  await shot(till, 'n2-till-order-number-as-name.png', 'SCRUM-1019');
  // The display redraws the order a moment after the till's quantities change.
  await d.page.getByText('฿2600', { exact: true }).first().waitFor({ timeout: 15000 }).catch(() => odd('the display did not show the two-child total'));
  const header = flat(await d.page.locator('body').innerText()).slice(0, 4000);
  await shot(d.page, 'n3-display-no-number-in-header.png', 'SCRUM-1019');
  point('1019-r1-made', offer === 0 && byNumber && !PHONE_TEXT.test(header), ['SCRUM-1019/n1-display-number-no-name.png', 'SCRUM-1019/n2-till-order-number-as-name.png', 'SCRUM-1019/n3-display-no-number-in-header.png'],
    'A new number typed with no name: no "New member?" box; the member is made with the number as the name; the order shows it where the name goes (masked); the display shows no number', { newMemberBox: offer, nameIsTheNumber: byNumber, displayShowsANumber: PHONE_TEXT.test(header) });

  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const consent = d.page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  const cards = consent.getByTestId('consent-child');
  await expect(cards).toHaveCount(2, { timeout: 20000 });
  for (const [index, [name, age]] of [[fam.kidA, 6], [fam.kidB, 7]].entries()) {
    const card = cards.nth(index);
    await card.getByPlaceholder('Full name', { exact: true }).fill(name);
    await setAge(d.page, card, age);
  }
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByTestId('consent-care').first().waitFor();
  phase('n: the included-credit tick: ticked for the first child only');
  const ticks = consent.getByTestId('public-consent-order-with-included');
  await expect(ticks).toHaveCount(2, { timeout: 20000 });
  await ticks.nth(0).check();
  await d.page.waitForTimeout(2000);
  const tickWords = flat(await ticks.nth(0).locator('xpath=ancestor::label[1]').innerText().catch(() => ''));
  await ticks.nth(0).scrollIntoViewIfNeeded();
  await shot(d.page, 'n4-display-included-credit-tick.png', 'SCRUM-1054');
  // Staff's copy of the form is in the till's "Private child details": read it there.
  let mirrorWords = null;
  const lookAtStaffCopy = async (details) => {
    const mirror = details.getByTestId('consent-order-with-included');
    if (!(await mirror.first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false))) { odd('staff\'s copy shows no included-credit tick'); return; }
    await mirror.first().scrollIntoViewIfNeeded().catch(() => {});
    await till.waitForTimeout(800);
    mirrorWords = (await Promise.all((await mirror.all()).map(async (m) => flat(await m.locator('xpath=ancestor::label[1]').innerText().catch(() => ''))))).join(' | ');
    await shot(till, 'n5-till-staff-copy-ticked-by-the-family.png', 'SCRUM-1054', details,
      [details.locator('input[type="tel"]'), details.getByText(PHONE_TEXT), details.getByText(BAND_TEXT)]);
  };
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  const nameBox = consent.getByPlaceholder('Your full name', { exact: true });
  const asksName = await nameBox.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  phase('n: the parent\'s name (asked: the member has none yet), agreements, staff photos, Done');
  if (asksName) await nameBox.fill(fam.guardian);
  await tickAgreements(consent);
  await staffPhotos('Private child details', lookAtStaffCopy);
  const written = await familyDone(d.page);
  assert.equal(written.status, 200);
  const sent = (written.sent?.children ?? []).map((c) => ({ name: c.name, orderWithIncludedCredit: c.orderWithIncludedCredit ?? null }));
  const sale = await newSale();
  const since = new Date(Date.now() - 2000);
  await payCash();
  await checkInNow(written.reg.id);
  await shot(till, 'n6-paid-cash-checked-in.png', 'SCRUM-1054');
  const rawSale = await rawReceipt('n6-sale-receipt.png', since);
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  const reg = await registrationOf(written.reg.id);
  const stays = reg.children.map((c) => ({ name: c.childName, ...Object.fromEntries(Object.entries(c).filter(([k]) => /food/i.test(k))) }));
  const read = await saleRead(sale.id);
  const bands = bandsIn(read);
  const codeOf = (name) => bands.find((b) => b.childName === name)?.shortCode ?? null;
  const codes = { a: codeOf(fam.kidA), b: codeOf(fam.kidB) };
  const kidBands = bands.filter((b) => b.kind === 'kid');
  if (!codes.a && kidBands.length === 2) { codes.a = kidBands[0].shortCode; codes.b = kidBands[1].shortCode; odd('bands carry no child names; taken in order'); }
  const balances = { a: codes.a ? satang(await walletOf(codes.a)) : null, b: codes.b ? satang(await walletOf(codes.b)) : null };
  receipt.checks.n = { registrationId: written.reg.id, saleId: sale.id, asksName, tickWords, mirrorWords, sent, stays, balances, rawSale }; save();
  point('1054-tick', /may order food with the included credit/i.test(tickWords) && sent.find((c) => c.name === fam.kidA)?.orderWithIncludedCredit === true
    && sent.find((c) => c.name === fam.kidB)?.orderWithIncludedCredit !== true && /ticked by the family/.test(mirrorWords ?? ''),
  ['SCRUM-1054/n4-display-included-credit-tick.png', 'SCRUM-1054/n5-till-staff-copy-ticked-by-the-family.png', 'SCRUM-1054/n6-paid-cash-checked-in.png'],
  'Two children dropped off on Eat & Play with no extra food: the parent ticks "may order food with the included credit" for one; staff\'s copy says "ticked by the family"; the registration carries the tick for that child only',
  { tickWords, mirrorWords, sent, asksName });

  phase('n: the check-in board');
  await home();
  await till.getByRole('button', { name: 'Check-in', exact: true }).click();
  const searchBox = till.getByPlaceholder('Search child, parent or phone…');
  await searchBox.waitFor({ timeout: 20000 });
  await searchBox.fill(fam.guardian);
  await till.getByRole('tab', { name: /^In Park/ }).or(till.getByRole('button', { name: /^In Park/ })).first().click();
  await till.waitForTimeout(2500);
  const boardWords = flat(await till.locator('main, body').first().innerText()).slice(0, 3000);
  receipt.checks.nBoard = { showsKidA: boardWords.includes(fam.kidA), showsKidB: boardWords.includes(fam.kidB), showsNumberAsText: PHONE_TEXT.test(boardWords) }; save();
  await shot(till, 'n7-board-in-park.png', 'SCRUM-1019');
  // The board's own edit form says whether each child may order food (not saved: Escape).
  const mayOrder = {};
  for (const [key, name] of [['a', fam.kidA], ['b', fam.kidB]]) {
    try {
      await till.getByText(name, { exact: true }).first().locator('xpath=ancestor::div[.//button][1]').getByRole('button').last().click();
      const edit = till.getByRole('dialog').last();
      const toggle = edit.getByText('May order food', { exact: true }).locator('xpath=ancestor::div[1]').getByRole('switch');
      await toggle.waitFor({ timeout: 15000 });
      await toggle.scrollIntoViewIfNeeded();
      mayOrder[key] = await toggle.getAttribute('aria-checked');
      await shot(till, `n7${key === 'a' ? 'b' : 'c'}-board-edit-may-order-food-${key === 'a' ? 'ticked-child' : 'unticked-child'}.png`, 'SCRUM-1054', edit,
        [edit.locator('input[type="tel"]'), edit.getByText(PHONE_TEXT), edit.getByText(BAND_TEXT)]);
      await till.keyboard.press('Escape');
      await till.waitForTimeout(800);
    } catch (error) { odd(`board edit form for ${key}: ${firstLine(error)}`); await till.keyboard.press('Escape').catch(() => {}); }
  }
  receipt.checks.nBoard = { ...receipt.checks.nBoard, mayOrder }; save();

  phase('n: food from the ticked child\'s band, no manager');
  assert.ok(codes.a && codes.b, 'both children\'s bands');
  await scanBand(codes.a);
  const askedA = await addDish();
  let fnbA = null;
  if (!askedA) fnbA = await chargeFromBand('n8-fnb-ticked-child-paid-from-band.png', 'SCRUM-1054');
  else await shot(till, 'n8-fnb-ticked-child-asked.png', 'SCRUM-1054');
  const rawFoodA = fnbA ? await rawReceipt('n8-food-receipt.png', fnbA.since) : null;
  const afterA = satang(await walletOf(codes.a));
  phase('n: the unticked child\'s band: the counter asks a manager, as before');
  await scanBand(codes.b);
  const askedB = await addDish();
  await till.waitForTimeout(800);
  await shot(till, 'n9-fnb-unticked-child-asks-manager.png', 'SCRUM-1054');
  if (askedB) await till.getByRole('button', { name: 'Cancel', exact: true }).last().click().catch(() => {});
  const afterB = satang(await walletOf(codes.b));
  receipt.checks.nFood = { askedA, askedB, saleA: fnbA?.saleId ?? null, balanceAfterA: afterA, balanceAfterB: afterB, rawFoodA }; save();
  point('1054-counter', askedA === false && Boolean(fnbA?.saleId) && afterA < 130000 && askedB === true && afterB === 130000,
    ['SCRUM-1054/n8-fnb-ticked-child-paid-from-band.png', 'SCRUM-1054/n9-fnb-unticked-child-asks-manager.png'],
    'At F&B the ticked child\'s dish is paid from the included credit with no manager asked; the unticked child gets "Food not authorized" and the manager override, as before', receipt.checks.nFood);
  await release(written.reg.id);

  phase('n: the next visit, still no name: "Welcome to Oto"');
  await home();
  await identifyOnDisplay(d.page, fam.number, null);
  await continueOnDisplay(d.page);
  const welcome = await d.page.getByRole('heading', { name: 'Welcome to Oto', exact: true }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  await shot(d.page, 'n10-display-welcome-no-name.png', 'SCRUM-1019');
  await skipVisiting();

  phase('n: a name given in the Console');
  const { context, page } = await consoleSignedIn('ADMIN');
  let renamed = false;
  try {
    await page.goto(CONSOLE + '/catalogue/members', { waitUntil: 'domcontentloaded' });
    const edit = page.locator(`button[aria-label="Edit ${fam.heldAs}"]:visible`).first();
    await edit.waitFor({ timeout: 45000 });
    await edit.scrollIntoViewIfNeeded();
    await edit.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Edit member').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);
    await dialog.locator('#member-nickname').fill(fam.later);
    await shot(page, 'n11-console-name-given.png', 'SCRUM-1019', dialog, [dialog.locator('input[type="tel"]'), dialog.getByText(PHONE_TEXT)]);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 30000 });
    renamed = (await lookup(fam.number))?.nickname === fam.later;
  } catch (error) { odd(`Console rename: ${firstLine(error)}`); }
  finally { await context.close().catch(() => {}); }

  phase('n: the number again, now with the name');
  await home();
  await identifyOnDisplay(d.page, fam.number, null);
  await continueOnDisplay(d.page);
  const back = await d.page.getByRole('heading', { name: `Welcome back, ${fam.later}!`, exact: true }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  await shot(d.page, 'n12-display-welcome-back-by-name.png', 'SCRUM-1019');
  await skipVisiting();
  await chooseTicket('Eat & Play Kids Pass', 1, 1);
  const named = await till.getByText(fam.later, { exact: true }).count();
  await shot(till, 'n13-till-order-by-name.png', 'SCRUM-1019');
  await till.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  receipt.checks.nName = { welcomeToOto: welcome, renamed, welcomeBackByName: back, tillShowsName: named }; save();
  point('1019-r1-named', welcome && renamed && back && named > 0,
    ['SCRUM-1019/n10-display-welcome-no-name.png', 'SCRUM-1019/n11-console-name-given.png', 'SCRUM-1019/n12-display-welcome-back-by-name.png', 'SCRUM-1019/n13-till-order-by-name.png'],
    'Before a name: the next visit is greeted "Welcome to Oto"; a name given in the Console then shows instead of the number on the display and the order', receipt.checks.nName);
}

// ---- m: SCRUM-1041, three displays on one till ----
async function openDisplaysList(picture) {
  await till.getByTestId('paired-displays-open').click();
  const list = till.getByTestId('paired-displays');
  await list.waitFor({ timeout: 20000 });
  await till.waitForTimeout(1200);
  const rows = await list.getByTestId('paired-display').count();
  const removes = await list.getByTestId('paired-display-remove').count();
  const words = flat(await list.innerText());
  if (picture) await shot(till, picture, 'SCRUM-1041', list, [till.getByText(PHONE_TEXT)]);
  return { list, rows, removes, words };
}
async function closeDisplaysList() { await till.keyboard.press('Escape'); await till.waitForTimeout(600); }
async function passM() {
  const fam = FAM.m;
  if (!displays.length) await pairDisplay('A');
  await home();
  const a = displays[0];
  const b = await pairDisplay('B', { width: 768, height: 1024 });
  await till.waitForTimeout(5000);
  const two = await openDisplaysList('m1-till-two-displays.png');
  await closeDisplaysList();
  const c = await pairDisplay('C', { width: 1024, height: 768 });
  await till.waitForTimeout(5000);
  const three = await openDisplaysList('m2-till-three-displays.png');
  await closeDisplaysList();

  phase('m: the family types the number and a name on display A');
  await identifyOnDisplay(a.page, fam.number, fam.name);
  await continueOnDisplay(a.page);
  const member = await memberMade(fam.number);
  members.m = member.id;
  await skipVisiting();
  await chooseTicket('1 Hour Play', 1, 0);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const forms = [a, b, c].map((d) => d.page.getByTestId('display-consent'));
  for (const f of forms) await f.waitFor({ timeout: 30000 });
  phase('m: the child\'s name typed on A shows on B and C');
  await forms[0].getByPlaceholder('Full name', { exact: true }).fill(fam.kid);
  await a.page.waitForTimeout(4000);
  const namesSeen = [];
  for (const f of forms) namesSeen.push(await f.getByPlaceholder('Full name', { exact: true }).inputValue().catch(() => null));
  await setAge(a.page, forms[0], 6);
  await expect(forms[0].getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await forms[0].getByRole('button', { name: 'Continue', exact: true }).click();
  await a.page.waitForTimeout(3000);
  const careOn = [];
  for (const f of forms) careOn.push(await f.getByTestId('consent-care').first().isVisible().catch(() => false));
  await forms[1].getByRole('button', { name: 'Continue', exact: true }).click();
  const nameBoxes = forms.map((f) => f.getByPlaceholder('Your full name', { exact: true }));
  await nameBoxes[1].waitFor({ timeout: 20000 });
  phase('m: the parent\'s name typed and the consent ticked on B show on A, C and the till');
  const firstBox = (f) => f.getByRole('checkbox').first();
  // The consent tick is taken with the parent's name only (consentActionAllowed): the name first, as a family does.
  await nameBoxes[1].fill(fam.guardian);
  await b.page.waitForTimeout(1500);
  const tickedAt = Date.now();
  await firstBox(forms[1]).check();
  // Staff's list on the till: "Supervision and photo consent · ticked".
  const tillSays = till.getByText(/Supervision and photo consent/).first();
  const seenAfter = { A: null, C: null, till: null };
  for (let waited = 0; waited < 30000 && Object.values(seenAfter).some((v) => v === null); waited += 1000) {
    if (seenAfter.A === null && await firstBox(forms[0]).isChecked().catch(() => false)) seenAfter.A = Date.now() - tickedAt;
    if (seenAfter.C === null && await firstBox(forms[2]).isChecked().catch(() => false)) seenAfter.C = Date.now() - tickedAt;
    if (seenAfter.till === null && /· ticked/.test(flat(await tillSays.locator('xpath=..').innerText().catch(() => '')))) seenAfter.till = Date.now() - tickedAt;
    await b.page.waitForTimeout(1000);
  }
  const tickedOn = [];
  for (const f of forms) tickedOn.push(await firstBox(f).isChecked().catch(() => null));
  const tillTicked = seenAfter.till !== null;
  receipt.checks.mTickSeenAfterMs = seenAfter; save();
  await shot(b.page, 'm3-display-B-ticks-an-agreement.png', 'SCRUM-1041');
  await shot(a.page, 'm4-display-A-shows-the-tick.png', 'SCRUM-1041');
  await shot(c.page, 'm5-display-C-shows-the-tick.png', 'SCRUM-1041');
  await shot(till, 'm6-till-shows-the-tick.png', 'SCRUM-1041');
  phase('m: the language chosen on C is followed on A and B');
  const languages = {};
  await switchLanguage(c.page, 'ไทย').catch((e) => odd(`language th: ${firstLine(e)}`));
  await a.page.waitForTimeout(4000);
  for (const d of [a, b, c]) languages[d.letter] = await d.page.evaluate(() => document.documentElement.lang || null).catch(() => null);
  const thaiOnA = /[\u0E00-\u0E7F]/.test(await a.page.locator('body').innerText());
  await shot(a.page, 'm7-display-A-follows-thai.png', 'SCRUM-1041');
  await switchLanguage(c.page, 'English').catch((e) => odd(`language en: ${firstLine(e)}`));
  await a.page.waitForTimeout(4000);
  const backToEnglishOnA = await nameBoxes[0].isVisible().catch(() => false);
  receipt.checks.mForm = { listWithTwo: { rows: two.rows, removes: two.removes }, listWithThree: { rows: three.rows, removes: three.removes, words: three.words },
    namesSeen: namesSeen.map((n) => n === fam.kid), careOn, tickedOn, tillTicked, languages, thaiOnA, backToEnglishOnA }; save();
  point('1041-one-form', namesSeen.every((n) => n === fam.kid) && careOn.every(Boolean) && tickedOn.every((t) => t === true) && tillTicked && two.rows === 2 && three.rows === 3,
    ['SCRUM-1041/m1-till-two-displays.png', 'SCRUM-1041/m2-till-three-displays.png', 'SCRUM-1041/m3-display-B-ticks-an-agreement.png',
      'SCRUM-1041/m4-display-A-shows-the-tick.png', 'SCRUM-1041/m5-display-C-shows-the-tick.png', 'SCRUM-1041/m6-till-shows-the-tick.png'],
    'Two, then three displays on one till; the same sale on each; the child\'s name typed on A and an agreement ticked on B show on every display and on the till', receipt.checks.mForm);
  point('1041-language', thaiOnA, ['SCRUM-1041/m7-display-A-follows-thai.png'], 'Thai chosen on display C is followed on display A', { languages, thaiOnA });

  phase('m: the family finishes on A; staff photo; Done; cash; check-in; release');
  await nameBoxes[0].fill(fam.guardian);
  await tickAgreements(forms[0]);
  await staffPhotos();
  const written = await familyDone(a.page);
  assert.equal(written.status, 200);
  const sale = await newSale();
  await payCash();
  await checkInNow(written.reg.id);
  await shot(till, 'm8-paid-cash-checked-in.png', 'SCRUM-1041');
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  await release(written.reg.id);
  receipt.checks.mSale = { registrationId: written.reg.id, saleId: sale.id }; save();

  phase('m: a fourth display is refused in the Console');
  const fourth = await browser.newContext({ baseURL: pos, viewport: { width: 600, height: 1024 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  let refusal = null;
  try {
    const page4 = await fourth.newPage();
    await page4.goto(`${pos}/display`);
    await page4.getByTestId('display-pairing-code').waitFor();
    const code4 = (await page4.getByTestId('display-pairing-code').textContent()).trim();
    const { context, page } = await consoleSignedIn('ADMIN');
    try {
      await page.goto(CONSOLE + '/devices', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      const branchSelect = page.locator('select').filter({ has: page.locator('option', { hasText: /Central Floresta/ }) }).first();
      if (await branchSelect.count()) {
        const value = await branchSelect.locator('option', { hasText: /Central Floresta/ }).first().getAttribute('value');
        await branchSelect.selectOption(value);
        await page.waitForTimeout(3000);
      }
      await page.getByRole('button', { name: 'Pair a display', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Pair a display' }).last();
      await dialog.waitFor({ timeout: 20000 });
      const stationSelect = dialog.locator('select').first();
      const value = await stationSelect.locator('option', { hasText: fixtureName }).first().getAttribute('value');
      await stationSelect.selectOption(value);
      await dialog.getByPlaceholder('Counter 1 display').fill('ZZ TEST SCRUM-1041 display D');
      await dialog.locator('input[type="password"]').fill(code4);
      await dialog.getByRole('button', { name: /^Pair/ }).last().click();
      const alert = dialog.getByRole('alert');
      await alert.waitFor({ timeout: 20000 });
      refusal = flat(await alert.innerText());
      await shot(page, 'm9-console-fourth-display-refused.png', 'SCRUM-1041', dialog, [dialog.locator('input[type="password"]')]);
    } finally { await context.close().catch(() => {}); }
  } catch (error) { odd(`fourth display in the Console: ${firstLine(error)}`); }
  finally { await fourth.close().catch(() => {}); }
  const activeAfter = (await call('GET', `/stations/${station.id}/displays`)).body;
  receipt.checks.mFourth = { refusal }; save();
  point('1041-fourth', /already has three displays/.test(refusal ?? ''), ['SCRUM-1041/m9-console-fourth-display-refused.png'],
    'A fourth display is refused in the Console with its message', { refusal, displaysRead: Array.isArray(activeAfter?.displays) ? activeAfter.displays.length : null });

  phase('m: the manager removes display B at the till; A and C go on');
  await handOver('MANAGER');
  const asManager = await openDisplaysList('m10-till-three-displays-manager-remove.png');
  const row = asManager.list.getByTestId('paired-display').filter({ hasText: b.name });
  await row.getByTestId('paired-display-remove').click();
  await till.waitForTimeout(600);
  await shot(till, 'm11-till-remove-confirm.png', 'SCRUM-1041', asManager.list, [till.getByText(PHONE_TEXT)]);
  await row.getByTestId('paired-display-remove-confirm').click();
  await till.waitForTimeout(3000);
  const rowsAfter = await asManager.list.getByTestId('paired-display').count();
  await shot(till, 'm12-till-two-left.png', 'SCRUM-1041', asManager.list, [till.getByText(PHONE_TEXT)]);
  await closeDisplaysList();
  b.revoked = true;
  receipt.cleanup.push({ kind: 'display', id: b.id, revoked: true, by: 'the manager at the till' }); save();
  const stopped = await b.page.getByTestId('display-pairing-code').waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
  await shot(b.page, 'm13-display-B-stopped.png', 'SCRUM-1041');
  phase('m: A goes on: the family types the number on A');
  await home();
  await identifyOnDisplay(a.page, fam.number, null);
  await continueOnDisplay(a.page);
  const goesOn = await till.getByText(fam.name, { exact: true }).first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  await a.page.waitForTimeout(1500);
  await shot(a.page, 'm14-display-A-goes-on.png', 'SCRUM-1041');
  await shot(c.page, 'm15-display-C-goes-on.png', 'SCRUM-1041');
  await skipVisiting();
  await shot(till, 'm16-till-with-A-after-removal.png', 'SCRUM-1041');
  receipt.checks.mRemove = { managerRows: asManager.rows, managerRemoves: asManager.removes, rowsAfter, displayBStopped: stopped, aGoesOn: goesOn }; save();
  point('1041-remove', asManager.removes === 3 && rowsAfter === 2 && stopped && goesOn,
    ['SCRUM-1041/m10-till-three-displays-manager-remove.png', 'SCRUM-1041/m11-till-remove-confirm.png', 'SCRUM-1041/m12-till-two-left.png',
      'SCRUM-1041/m13-display-B-stopped.png', 'SCRUM-1041/m14-display-A-goes-on.png', 'SCRUM-1041/m15-display-C-goes-on.png', 'SCRUM-1041/m16-till-with-A-after-removal.png'],
    'The manager\'s list at the till has a Remove on each display; display B is removed and returns to its pairing screen; A and C stay paired and A carries the next family to the till', receipt.checks.mRemove);
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
  for (const name of ['oto-api-staging', 'oto-pos-staging', 'oto-pos-web-staging', 'oto-console-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=10`)).map((x) => x.deploy).find((x) => x.status === 'live');
    receipt.deployments[name] = { id: d?.id, status: d?.status, sha: d?.commit?.id };
  }
  save();
  const { execSync } = await import('node:child_process');
  for (const name of ['oto-api-staging', 'oto-pos-web-staging', 'oto-console-staging']) {
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
  receiptDevice = devices.find((d) => d.role === 'receipt').deviceId;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z048${String(i + 1).padStart(2, '0')}`).find((p) => !stations.some((s) => s.codePrefix === p));
  assert.ok(prefix);
  for (const key of ['x', 'n', 'm']) if (wanted.includes(key)) assert.equal(await lookup(FAM[key].number), null, `ZZ TEST number for ${key} must be unused`);
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

  const video = resolve(RAW, 'camera.y4m');
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

  for (const key of ['x', 'n', 'm']) if (wanted.includes(key)) await attempt(key, { x: passX, n: passN, m: passM }[key]);
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
      assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: 'ZZ TEST SCRUM-1048 proof cleanup' })).status, 200);
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
  if (process.env.KEEP_FAMILY !== '1') for (const key of ['x', 'n', 'm']) if (wanted.includes(key)) await clean(`archive the ZZ TEST family ${key}`, async () => {
    const member = await lookup(FAM[key].number);
    if (!member) { receipt.cleanup.push({ kind: 'member', key, none: true }); return; }
    assert.ok(String(member.nickname).startsWith('ZZ TEST SCRUM-') || isOwnNumber(member.nickname, FAM[key].number), 'only own test member');
    assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
    assert.equal(await lookup(FAM[key].number), null);
    receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true });
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
