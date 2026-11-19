// SCRUM-1052 / SCRUM-1053 / SCRUM-1018 staging proof: the counter's waiver
// repair and the consistency points, as landed. Adapted from the SCRUM-1017
// harness beside this folder. Own ZZ TEST till on the simulated box with a
// paired customer display, the seeded reception account at the till, a ZZ
// TEST family and children made through the till, invented numbers, cash
// only. No credential, pairing code, band code, phone or raw response body
// enters the receipt or the console.
//
//   node proof.mjs <full-sha> <run-tag> <passes>
//   passes: s  first visit: a new number and name on the display; two children
//              (6 and 10) registered and photographed; cash; checked in; released
//           w  the waiver: the same family returns with both; staff waive the
//              younger; the older sibling's short no-fee form on the display
//              (pictures at the counter display's size and on a tablet both
//              ways, and in Thai and Russian); Still matches; Done; cash; the
//              sale saved; checked in; released
//           c  the till's own customer half (display unpaired): the "no
//              allergies or medical needs" tick under an emptied saved note
//           d  the Console's member form refuses a rate document with no
//              expiry date (nothing saved)
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
const out = dirOf('SCRUM-1052');
const wanted = (process.argv[4] ?? 's,w,c,d').split(',');
const T = '1052';
const base = Number(process.env.ZZ_BASE ?? 11);
const number = '08981052' + String(base).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const CONSOLE = 'https://oto-console-staging.onrender.com';
const RUN = String(base);
const family = `ZZ TEST SCRUM-${T} family ${RUN}`;
const kidA = `ZZ TEST Mai ${RUN}`; // 6: needs drop-off; waived on the second visit
const kidB = `ZZ TEST Tom ${RUN}`; // 10: the covering sibling
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

const PHONE_TEXT = /(\+66|\b0)\s?\d{1,2}\s?\d{3}\s?\d{4}\b/;
const shot = async (page, name, ticket = 'SCRUM-1052', target = page, masks = null) => {
  await target.screenshot({ path: resolve(dirOf(ticket), name), animations: 'disabled',
    mask: masks ?? [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
      page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/), page.locator('div.grid.gap-px'),
      page.getByTestId('band-codes').locator('span.font-mono'), page.getByText(/^Z\d{5,6}-[A-Z0-9]{4,8}$/),
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
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const landing = (page) => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const paymentStep = () => till.getByTestId('payment-step');
const home = async () => { await till.goto('/'); await landing(till).or(till.getByRole('heading', { name: 'Membership Check', exact: true })).first().waitFor(); };
const registrationOf = async (id) => (await call('GET', '/checkin/registrations/' + id)).body;
/** The till's own customer half: the second half of the split view. */
const halfOf = (locator) => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');

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
  const context = await browser.newContext({ baseURL: pos, viewport: { width: 600, height: 1024 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
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
async function familyDone() {
  const consent = display.page.getByTestId('display-consent');
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
async function bandsOf(saleId) {
  const read = (await call('GET', `/sales/${saleId}`)).body;
  return { status: read?.sale?.status ?? read?.status ?? null, bands: (read?.bands ?? read?.sale?.bands ?? []).map((b) => ({ childName: b.childName ?? null, kind: b.kind ?? b.role ?? null })) };
}
async function switchLanguage(page, nativeLabel) {
  await page.getByRole('button', { name: /Change language|เปลี่ยนภาษา|Сменить язык|更改语言|Changer de langue/ }).first().click();
  await page.getByRole('button', { name: nativeLabel, exact: true }).last().click();
  await page.waitForTimeout(1200);
}

// ---- s: the first visit: a new number and a name; both children registered ----
async function passS() {
  await home();
  if (!display) await pairDisplay();
  phase('s: the family types a new number and a name on the display');
  await identifyOnDisplay(family);
  await display.page.getByRole('button', { name: 'Continue', exact: true }).click();
  await till.waitForTimeout(4000);
  let found = null;
  await expect.poll(async () => { found = (await call('GET', `/members/lookup?phone=${number}`)).body.member; return Boolean(found); }, { timeout: 30000 }).toBe(true);
  memberId = found.id;
  receipt.created.push({ kind: 'member', id: memberId }); save();
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  if (await visiting.isVisible().catch(() => false)) await visiting.getByRole('button', { name: 'Skip for now', exact: true }).click();

  phase('s: 1 Hour Play, two children, no adult');
  await chooseTicket('1 Hour Play', 2, 0);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const consent = display.page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  const cards = consent.getByTestId('consent-child');
  await expect(cards).toHaveCount(2, { timeout: 20000 });
  for (const [index, [name, age]] of [[kidA, 6], [kidB, 10]].entries()) {
    const card = cards.nth(index);
    await card.getByPlaceholder('Full name', { exact: true }).fill(name);
    await setAge(display.page, card, age);
  }
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByTestId('consent-care').first().waitFor();
  // Tom's note, for the till's own half to show and empty in pass c.
  const allergyBoxes = consent.getByTestId('consent-allergies');
  const tomBox = allergyBoxes.nth(1).locator('textarea, input').first().or(allergyBoxes.nth(1)).first();
  await tomBox.click().catch(() => {});
  await tomBox.fill('ZZ TEST peanuts').catch(() => odd('the allergy box did not take typing'));
  await display.page.waitForTimeout(1500);
  await expect(consent.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({ timeout: 20000 });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByPlaceholder('Your full name', { exact: true }).waitFor({ timeout: 20000 });
  phase('s: guardian name, agreements, staff photos, Done');
  await consent.getByPlaceholder('Your full name', { exact: true }).fill(guardian);
  for (const checkbox of await consent.getByRole('checkbox').all()) { if (!(await checkbox.isChecked())) await checkbox.check(); }
  await staffPhotos();
  const written = await familyDone();
  assert.equal(written.status, 200);
  const reg = written.reg;
  receipt.checks.firstVisit = { registrationId: reg.id, sentChildren: written.sent.children.map((c) => ({ name: c.name, ageYears: c.ageYears, service: c.service })) }; save();
  const sale = await newSale();
  await payCash();
  await checkInNow(reg.id);
  await shot(till, 's1-first-visit-paid-checked-in.png');
  receipt.checks.firstVisit.saleId = sale.id; save();
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  await release(reg.id);
  const kids = (await call('GET', `/members/${memberId}`)).body?.member?.children ?? [];
  receipt.checks.firstVisit.saved = kids.map((c) => ({ name: c.name ?? c.childName, hasAllergyNote: Boolean(c.allergies ?? c.allergiesMedical) })); save();
}

// ---- w: the waiver ----
async function passW() {
  assert.ok(memberId, 'the family from pass s');
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
  await till.waitForTimeout(2000);
  const gateText = flat(await till.locator('body').innerText());
  await shot(till, 'w2-gate-waived-sibling-registered-no-fee.png');

  phase('w: the older sibling\'s short no-fee form on the display');
  const consent = display.page.getByTestId('display-consent');
  await consent.waitFor({ timeout: 30000 });
  await consent.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor({ timeout: 30000 });
  await display.page.waitForTimeout(1500);
  const choice = till.getByTestId('last-photo-choice');
  const read = async () => ({
    heading: flat(await consent.getByRole('heading', { level: 2 }).first().innerText().catch(() => '')),
    subtitle: flat(await consent.locator('h2 + p').first().innerText().catch(() => '')),
    missing: flat(await consent.getByTestId('consent-missing').innerText().catch(() => '')),
    stepPills: await consent.getByTestId('consent-steps').count(),
    nameBoxes: await consent.getByPlaceholder('Full name', { exact: true }).count(),
    checkboxes: await consent.getByRole('checkbox').count(),
    done: await consent.getByRole('button', { name: 'Done', exact: true }).isEnabled().catch(() => null),
  });
  const before = await read();
  const staffChoice = { shown: await choice.count(), stillMatches: await choice.getByRole('button', { name: 'Still matches' }).count() };
  // The bar with the still-needed line and Done stays at the screen's foot: one picture per size holds both.
  await shot(display.page, 'b1-display-short-form-600x1024.png', 'SCRUM-1053');
  const sizes = {};
  for (const [w, h] of [[768, 1024], [1024, 768]]) {
    await display.page.setViewportSize({ width: w, height: h });
    await display.page.waitForTimeout(1200);
    await display.page.evaluate(() => window.scrollTo(0, 0));
    await consent.getByRole('heading', { name: 'Welcome back', exact: true }).scrollIntoViewIfNeeded().catch(() => {});
    await display.page.waitForTimeout(500);
    sizes[`${w}x${h}`] = await display.page.evaluate(() => ({ sideways: document.documentElement.scrollWidth > window.innerWidth }));
    await shot(display.page, `b3-display-short-form-${w}x${h}.png`, 'SCRUM-1053');
  }
  await display.page.setViewportSize({ width: 600, height: 1024 });
  await display.page.waitForTimeout(1200);
  sizes['600x1024'] = await display.page.evaluate(() => ({ sideways: document.documentElement.scrollWidth > window.innerWidth }));
  const languages = {};
  for (const [label, code] of [['ไทย', 'th'], ['Русский', 'ru']]) {
    await switchLanguage(display.page, label).catch((e) => odd(`language ${code}: ${firstLine(e)}`));
    await display.page.evaluate(() => window.scrollTo(0, 0));
    await display.page.waitForTimeout(600);
    languages[code] = { heading: flat(await consent.getByRole('heading', { level: 2 }).first().innerText().catch(() => '')),
      subtitle: flat(await consent.locator('h2 + p').first().innerText().catch(() => '')) };
    await shot(display.page, `b5-display-short-form-600x1024-${code}.png`, 'SCRUM-1053');
  }
  await switchLanguage(display.page, 'English').catch((e) => odd(`language en: ${firstLine(e)}`));
  await display.page.evaluate(() => window.scrollTo(0, 0));
  point('1053-short-form', before.heading === 'Welcome back' && /details are saved/.test(before.subtitle) && !/photo/i.test(before.missing) && before.stepPills === 0 && before.nameBoxes === 0
    && staffChoice.stillMatches === 1 && Object.values(sizes).every((s) => s.sideways === false),
  ['SCRUM-1053/b1-display-short-form-600x1024.png', 'SCRUM-1053/b3-display-short-form-768x1024.png',
    'SCRUM-1053/b3-display-short-form-1024x768.png', 'SCRUM-1053/b5-display-short-form-600x1024-th.png', 'SCRUM-1053/b5-display-short-form-600x1024-ru.png'],
  'A returning family\'s short form: "Welcome back", the details-saved line, no names asked; the still-needed line names no photo while staff decide the last one', { before, staffChoice, sizes, languages });

  phase('w: the family ticks the agreements; staff press "Still matches"; Done');
  for (const checkbox of await consent.getByRole('checkbox').all()) { if (!(await checkbox.isChecked())) await checkbox.check(); }
  await display.page.waitForTimeout(1500);
  const afterTicks = await read();
  await choice.getByRole('button', { name: 'Still matches' }).first().click();
  await till.waitForTimeout(1500);
  await shot(display.page, 'w3-display-sibling-agreements-ticked.png');
  const waiversPosted = [];
  const onRequest = (r) => { if (new URL(r.url()).pathname === '/api/checkin/waivers' && r.method() === 'POST') waiversPosted.push(r.postDataJSON()); };
  till.on('request', onRequest);
  const written = await familyDone();
  receipt.checks.waiver = { registrationStatus: written.status, registrationId: written.reg?.id ?? null,
    sentChildren: (written.sent?.children ?? []).map((c) => ({ name: c.name, ageYears: c.ageYears, service: c.service })),
    photoReuseSent: Array.isArray(written.sent?.photoReuse) ? written.sent.photoReuse.length : 0, afterTicks }; save();
  const sale = await newSale();
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  await till.waitForTimeout(1500);
  await shot(till, 'w4-payment-step-after-waiver.png');
  await payCash();
  await shot(till, 'w5-paid-cash-sale-saved.png');
  await checkInNow(written.reg.id);
  await shot(till, 'w6-checked-in.png');
  till.off('request', onRequest);
  const reg = await registrationOf(written.reg.id);
  const saleRead = await bandsOf(sale.id);
  const finalised = (await stationSales()).find((s) => s.id === sale.id);
  receipt.checks.waiver = { ...receipt.checks.waiver, saleId: sale.id, saleStatus: finalised?.status ?? saleRead.status, bands: saleRead.bands,
    stays: reg.children.map((c) => ({ name: c.childName, service: c.serviceType ?? c.service ?? null, status: c.status })),
    waivers: waiversPosted.map((w) => ({ namesRegistration: w?.registrationId === written.reg.id, child: w?.child?.name ?? null, sibling: w?.sibling?.name ?? null, waivedRequirement: w?.waivedRequirement ?? null })),
    gateSaysNoFee: /no fee/i.test(gateText) }; save();
  const w = receipt.checks.waiver;
  point('1052-waiver', w.registrationStatus === 200 && w.sentChildren.length === 1 && w.sentChildren[0].name === kidB && w.sentChildren[0].service === 'none'
    && w.waivers.length === 1 && w.waivers[0].namesRegistration && w.saleStatus === 'finalised' && w.stays.every((s) => s.status === 'in_park'),
  ['SCRUM-1052/w1-gate-waiver-offered.png', 'SCRUM-1052/w2-gate-waived-sibling-registered-no-fee.png', 'SCRUM-1053/b1-display-short-form-600x1024.png',
    'SCRUM-1052/w3-display-sibling-agreements-ticked.png', 'SCRUM-1052/w4-payment-step-after-waiver.png', 'SCRUM-1052/w5-paid-cash-sale-saved.png', 'SCRUM-1052/w6-checked-in.png'],
  'After the waiver the older sibling has the short no-fee form; the waiver names that registration; the cash sale is saved; the sibling is checked in and the younger child has her band', w);
  await till.getByRole('button', { name: 'Start New Sale' }).click().catch(() => {});
  await release(written.reg.id);
}

// ---- c: the till's own customer half, no display paired ----
async function passC() {
  assert.ok(memberId, 'the family from pass s');
  phase('c: unpair the display; the till shows its own customer half');
  await dropDisplay(`ZZ TEST SCRUM-${T} proof: own customer half next`);
  await home();
  const showButton = till.getByRole('button', { name: 'Show customer display', exact: true });
  let half = null;
  for (let i = 0; i < 40 && !half; i++) {
    if (await showButton.isVisible().catch(() => false)) await showButton.click();
    const safety = till.getByTestId('identify-safety');
    const lang = till.getByTestId('language-choice');
    if (await lang.isVisible().catch(() => false)) await till.getByTestId('language-choice-en').click().catch(() => {});
    if (await safety.isVisible().catch(() => false) && await halfOf(safety).count()) half = halfOf(safety);
    else await till.waitForTimeout(1500);
  }
  assert.ok(half, 'the till shows its own customer half');
  await keypad(half, number);
  await half.getByRole('button', { name: 'Continue', exact: true }).click();
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  await visiting.waitFor({ timeout: 30000 });
  for (const name of [kidA, kidB]) {
    const box = visiting.locator('label').filter({ hasText: name }).getByRole('checkbox');
    if (!(await box.count())) continue;
    const want = name === kidB;
    if ((await box.isChecked()) !== want) await box.click();
  }
  await visiting.getByRole('button', { name: /^Confirm 1 child/ }).click();
  await visiting.waitFor({ state: 'hidden', timeout: 30000 });
  await chooseTicket('1 Hour Play', 1, 0);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const heading = till.getByRole('heading', { name: 'Welcome back', exact: true });
  await heading.waitFor({ timeout: 30000 });
  const form = halfOf(heading);
  await till.waitForTimeout(1500);
  const box = form.getByTestId('consent-allergies').locator('textarea, input').first().or(form.getByTestId('consent-allergies')).first();
  const tick = form.getByTestId('consent-allergies-none');
  const done = form.getByRole('button', { name: 'Done', exact: true });
  const look = async () => ({ box: await box.inputValue().catch(() => null), tick: await tick.count(), ticked: (await tick.count()) ? await tick.getAttribute('data-state') : null,
    done: await done.isEnabled().catch(() => null), missing: flat(await form.getByTestId('consent-missing').innerText().catch(() => '')) });
  await box.scrollIntoViewIfNeeded();
  // The "Visit confirmed" notice passes over the half's last line: let it go first.
  const noticeGone = () => till.getByText('Visit confirmed', { exact: true }).waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await noticeGone();
  const seen = { held: await look() };
  await shot(till, 'c1-till-half-short-form-note-held.png', 'SCRUM-1053');
  phase('c: the family empties the saved note on the till\'s own half');
  await box.fill('');
  await till.waitForTimeout(1200);
  seen.emptied = await look();
  await tick.scrollIntoViewIfNeeded().catch(() => {});
  await shot(till, 'c2-till-half-no-allergies-tick-asked.png', 'SCRUM-1053');
  await tick.click();
  await till.waitForTimeout(1200);
  seen.ticked = await look();
  await shot(till, 'c3-till-half-no-allergies-ticked.png', 'SCRUM-1053');
  receipt.checks.ownHalf = seen; save();
  point('1053-own-half', seen.held.box === 'ZZ TEST peanuts' && seen.held.tick === 0 && seen.emptied.tick === 1 && seen.emptied.ticked === 'unchecked'
    && seen.emptied.done === false && /no allergies|medical/i.test(seen.emptied.missing) && seen.ticked.ticked === 'checked',
  ['SCRUM-1053/c1-till-half-short-form-note-held.png', 'SCRUM-1053/c2-till-half-no-allergies-tick-asked.png', 'SCRUM-1053/c3-till-half-no-allergies-ticked.png'],
  'The till\'s own customer half: emptying a saved child\'s note asks the "no allergies or medical needs" tick, and Done waits for it', seen);
  phase('c: back out; nothing is written');
  await till.getByRole('button', { name: /^Back/ }).first().click().catch(() => odd('no Back on the gate'));
  await till.waitForTimeout(2000);
  const kids = (await call('GET', `/members/${memberId}`)).body?.member?.children ?? [];
  receipt.checks.ownHalf.savedAfter = kids.map((c) => ({ name: c.name ?? c.childName, hasAllergyNote: Boolean(c.allergies ?? c.allergiesMedical) })); save();
}

// ---- d: the Console's member form ----
async function passD() {
  assert.ok(memberId, 'the family from pass s');
  phase('d: the Console, the member form, Expat with no expiry date');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  watch(page, 'console');
  try {
    await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (await page.locator('input[type="password"]').count()) {
      const field = page.locator('input[type="tel"], input[inputmode="tel"]').last();
      const prefix = await field.evaluate((el) => /\+(\d{1,4})/.exec(el.parentElement?.textContent ?? '')?.[1] ?? null).catch(() => null);
      const phone = need('STAGING_ADMIN_PHONE');
      await field.fill(prefix === '66' || !prefix ? phone.replace(/^\+66/, '0') : phone.slice(prefix.length + 1));
      await page.locator('input[type="password"]').last().fill(need('STAGING_ADMIN_PASSWORD'));
      await page.getByRole('button', { name: /sign in/i }).first().click();
      await page.waitForTimeout(6000);
    }
    assert.equal(await page.locator('input[type="password"]').count(), 0, 'Console signed in');
    await page.goto(CONSOLE + '/catalogue/members', { waitUntil: 'domcontentloaded' });
    const edit = page.locator(`button[aria-label="Edit ${family}"]:visible`).first();
    await edit.waitFor({ timeout: 45000 });
    await edit.scrollIntoViewIfNeeded();
    await edit.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Edit member').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);
    await dialog.getByRole('combobox', { name: 'Tier' }).click();
    await page.getByRole('option', { name: 'Expat', exact: true }).click();
    await page.waitForTimeout(800);
    const proof = flat(await dialog.getByRole('combobox', { name: 'Proof type' }).innerText().catch(() => ''));
    const expiry = await dialog.locator('#member-tier-expiry').inputValue().catch(() => null);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.waitForTimeout(1500);
    const error = dialog.getByText("Enter the document's expiry date.", { exact: true });
    const shown = await error.count();
    await error.scrollIntoViewIfNeeded().catch(() => {});
    // Only the dialog's own number boxes: the list behind it is not in the picture.
    await shot(page, 'd1-console-expat-no-expiry-refused.png', 'SCRUM-1053', dialog,
      [dialog.locator('input[type="tel"]'), dialog.getByText(PHONE_TEXT)]);
    const stillOpen = await dialog.isVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    const member = (await call('GET', `/members/${memberId}`)).body?.member ?? {};
    const seen = { proof, expiry, errorShown: shown, dialogStillOpen: stillOpen, tierAfter: member.tier ?? member.tierCode ?? null };
    receipt.checks.console = seen; save();
    point('1053-console', shown === 1 && expiry === '' && stillOpen && seen.tierAfter !== 'expat',
      ['SCRUM-1053/d1-console-expat-no-expiry-refused.png'],
      'The Console\'s member form refuses an Expat rate document with no expiry date before saving; the member keeps the Tourist rate', seen);
  } finally {
    await context.close().catch(() => {});
  }
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
  for (const name of ['oto-api-staging', 'oto-pos-staging', 'oto-pos-web-staging', 'oto-console-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=10`)).map((x) => x.deploy).find((x) => x.status === 'live');
    receipt.deployments[name] = { id: d?.id, status: d?.status, sha: d?.commit?.id };
  }
  save();
  const { execSync } = await import('node:child_process');
  for (const name of ['oto-api-staging', 'oto-pos-web-staging', ...(wanted.includes('d') ? ['oto-console-staging'] : [])]) {
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
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T.slice(1)}${String(i + 1).padStart(2, '0')}`).find((p) => !stations.some((s) => s.codePrefix === p));
  assert.ok(prefix);
  if (wanted.includes('s')) assert.equal((await call('GET', `/members/lookup?phone=${number}`)).body.member, null, 'ZZ TEST number must be unused');
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

  for (const key of ['s', 'w', 'c', 'd']) if (wanted.includes(key)) await attempt(key, { s: passS, w: passW, c: passC, d: passD }[key]);
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
  if (process.env.KEEP_FAMILY !== '1') await clean('archive the ZZ TEST family', async () => {
    const member = (await call('GET', `/members/lookup?phone=${number}`)).body.member;
    if (!member) { receipt.cleanup.push({ kind: 'member', none: true }); return; }
    assert.ok(String(member.nickname).startsWith(`ZZ TEST SCRUM-${T}`), 'only own test member');
    assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
    assert.equal((await call('GET', `/members/lookup?phone=${number}`)).body.member, null);
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
