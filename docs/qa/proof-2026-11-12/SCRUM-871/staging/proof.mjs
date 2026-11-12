// SCRUM-871 / SCRUM-872 / SCRUM-873 staging proof (one run, three tickets).
//   871: a second Continue after a failed registration writes each child once.
//   872: a guardian's saved children are matched when the number is first given on the form.
//   873: a nanny assigned on the board shows by name on the order.
// Adapted from the committed SCRUM-862 / SCRUM-863 harnesses (docs/qa/proof-2026-11-12/SCRUM-86{2,3}/staging).
// Own ZZ TEST till, ZZ TEST guardians, children and nanny, invented numbers (08987100xx), cash only.
// Only what this run made is checked in, released, voided or archived; every other card is covered in pictures.
// No credential, pairing code or raw response body enters the receipt or the console.
//
//   node proof.mjs <sha> <out-dir>        ONLY=1,1b,2,3,4 (default all)   ZZ_BASE=10
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
const T = '871';
const base = Number(process.env.ZZ_BASE ?? 10);
const zz = i => '08987100' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const only = (process.env.ONLY ?? '1,1b,2,3,4').split(',');
const receipt = { tickets: ['SCRUM-871', 'SCRUM-872', 'SCRUM-873'], sha, startedAt: new Date().toISOString(), phase: 'preflight', only,
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], childWrites: [], cleanup: [] };
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
const numbers = { g1: zz(0), dad: zz(1), g1b: zz(2), nanny: zz(3), nannyPicker: zz(4), ordinary: zz(5), drop: zz(6) };
receipt.numbers = numbers;
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const RUN = String(process.argv[3] ?? 'out').replace(/\D/g, '') || '00';
const guardianName = tag => `ZZ TEST SCRUM-${T} guardian ${tag}${RUN}`;
const NANNY = 'ZZ TEST Nanny 871';
const KAI = `ZZ TEST Kai ${T}-${RUN}`;
const PIM = `ZZ TEST Pim ${T}-${RUN}`;
const knownSales = new Set();
let browser = null, till = null, station = null, branchId = null, failed = false, nannyShiftId = null;
const regs = []; // { tag, id }

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
/** Any card on the board or in the picker that is not a ZZ TEST one is covered, so no real family appears. */
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
  // Every write the till makes to a member's children: the child id it sends and what came back.
  page.on('requestfinished', async r => {
    const u = new URL(r.url());
    if (r.method() === 'GET' || !/^\/api\/members\/(?:[^/]+\/children|children\/[^/]+)$/.test(u.pathname)) return;
    let body = null; try { body = r.postDataJSON(); } catch { /* not json */ }
    const res = await r.response().catch(() => null);
    receipt.childWrites.push({ at: receipt.phase, method: r.method(), path: u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'),
      childIdSent: body?.id ?? (u.pathname.match(/children\/([0-9a-f-]{36})$/)?.[1] ?? null), name: body?.name ?? null, allergies: body?.allergies, status: res?.status() ?? null });
    save();
  });
  page.on('requestfailed', r => {
    const u = new URL(r.url());
    if (!/^\/api\/(members|checkin)\//.test(u.pathname)) return;
    let body = null; try { body = r.postDataJSON(); } catch { /* not json */ }
    receipt.childWrites.push({ at: receipt.phase, method: r.method(), path: u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), childIdSent: body?.id ?? null, name: body?.name ?? null, failed: r.failure()?.errorText ?? 'failed' });
    save();
  });
}

const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const newSales = async () => (await stationSales()).filter(s => !knownSales.has(s.id));
const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const paymentStep = () => till.getByTestId('payment-step');
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const registrationOf = async id => (await call('GET', '/checkin/registrations/' + id)).body;
const memberOf = async phone => (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body?.member ?? null;
const childrenOf = m => (m?.children ?? []).map(c => ({ id: c.id, name: c.name, dateOfBirth: c.dateOfBirth, ageYears: c.ageYears, allergies: c.allergies, medicalAlert: c.medicalAlert, lastConfirmedAt: c.lastConfirmedAt }));

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
/** After payment of a drop-off: "Check in now" when the till offers it, so nothing is left waiting. */
async function checkInNow(regId) {
  const now = till.getByRole('button', { name: 'Check in now', exact: true });
  await now.waitFor({ timeout: 15000 }).catch(() => {});
  if (!(await now.isVisible().catch(() => false))) { odd('no "Check in now" after payment'); return false; }
  await now.click();
  await expect.poll(async () => (await registrationOf(regId)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
  await till.waitForTimeout(1200);
  return true;
}

/**
 * The "Children playing alone" form on the till's customer half: each child's name, age, photo
 * and allergy; the parent's name; the number field set to `formNumber` when given; every tick.
 */
async function fillGate(children, parent, formNumber) {
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const first = till.getByPlaceholder('Full name', { exact: true }).first();
  await first.waitFor();
  const half = halfOf(first);
  const cards = () => half.locator('div.rounded-3xl').filter({ has: till.getByPlaceholder('Full name', { exact: true }) });
  await expect(cards()).toHaveCount(children.length);
  for (let i = 0; i < children.length; i++) {
    const card = cards().nth(i);
    await card.getByPlaceholder('Full name', { exact: true }).fill(children[i].name);
    await setAge(till, card, children[i].age);
  }
  // The rows may re-order once ages are set: each child's card is found again by the name it holds.
  const cardOf = async name => { for (let i = 0; i < await cards().count(); i++) if (await cards().nth(i).getByPlaceholder('Full name', { exact: true }).inputValue() === name) return cards().nth(i); throw new Error('no card for ' + name); };
  await half.getByPlaceholder('Your full name', { exact: true }).waitFor();
  await half.getByPlaceholder('Your full name', { exact: true }).fill(parent);
  for (const child of children) {
    const card = await cardOf(child.name);
    const start = card.getByRole('button', { name: 'Start camera', exact: true });
    if (await start.count()) {
      await start.click();
      await card.getByRole('button', { name: 'Take photo', exact: true }).click();
      await card.getByAltText('Captured', { exact: true }).waitFor();
    }
    if (child.allergies) await card.locator('textarea').first().fill(child.allergies);
  }
  if (formNumber) {
    const tel = half.locator('input[type="tel"]').first();
    await tel.fill(formNumber.slice(1));
  }
  for (const checkbox of await half.getByRole('checkbox').all()) await checkbox.check();
  return half;
}
const continueButton = () => till.getByRole('button', { name: 'Continue to payment', exact: true });
const isRegistrationPost = r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST';
async function pressContinue() {
  const [registered] = await Promise.all([till.waitForResponse(isRegistrationPost, { timeout: 60000 }), continueButton().click()]);
  const reg = await registered.json().catch(() => null);
  return { status: registered.status(), reg };
}
async function toastText(pattern) {
  const title = till.getByText(pattern).first();
  await title.waitFor({ timeout: 30000 });
  const li = title.locator('xpath=ancestor::li[1]');
  return flat(await ((await li.count()) ? li : title.locator('xpath=..')).innerText()).slice(0, 400);
}

/** A picture of what the platform holds on a guardian, drawn from the admin read. */
async function memberPicture(name, title, rows, notes) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 500 } });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:24px;background:#fff;color:#111"><h2>${esc(title)}</h2>
    ${notes.map(n => `<p>${esc(n)}</p>`).join('')}
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px"><tr><th>#</th><th>Child id</th><th>Name</th><th>Date of birth</th><th>Age</th><th>Allergies</th><th>Medical alert</th><th>Last confirmed (UTC)</th></tr>
    ${rows.map((c, i) => `<tr><td>${i + 1}</td><td style="font-family:monospace">${esc(c.id)}</td><td>${esc(c.name)}</td><td>${esc(c.dateOfBirth)}</td><td>${esc(c.ageYears)}</td><td>${esc(c.allergies)}</td><td>${esc(c.medicalAlert)}</td><td>${esc(c.lastConfirmedAt)}</td></tr>`).join('')}
    </table><p style="color:#555">Read with GET /api/members/lookup?phone=… as the staging admin, ${esc(new Date().toISOString())}.</p></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  console.log('picture', name);
}
const countBy = (rows, name) => rows.filter(c => c.name.trim().toLowerCase() === name.toLowerCase()).length;

// ---- 1: SCRUM-871, the registration fails once after the children are written ----
async function point1() {
  const tag = 'g1', phone = numbers.g1;
  phase('1: walk-in, two children no adult, drop-off form with Bua allergy');
  await walkIn(phone);
  await ticket(2, 0);
  await fillGate([{ name: 'ZZ TEST Bua', age: 6, allergies: 'ZZ TEST peanuts' }, { name: 'ZZ TEST Nok', age: 9 }], guardianName(tag));
  await shot(till, '01a-dropoff-form-bua-nok.png');
  phase('1: first Continue — the registration request is refused once (HTTP 500 injected in the browser), after the children are written');
  // Not a network abort: a call that reaches nothing moves the till to its box (lib/lane.ts isBoxLaneTrigger),
  // which is a different path. A 500 is the platform's own refusal, so the till stays on the platform lane.
  let aborted = 0;
  const handler = async route => {
    if (route.request().method() === 'POST' && aborted === 0) {
      aborted += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ZZ_TEST_INJECTED', message: 'ZZ TEST injected failure.' } }) });
    } else await route.continue();
  };
  const matcher = url => new URL(url).pathname === '/api/checkin/registrations';
  await till.route(matcher, handler);
  const writesBefore = receipt.childWrites.length;
  await continueButton().click();
  const toast = await toastText(/Couldn't register these children/);
  await till.waitForTimeout(1500);
  await shot(till, '01b-first-continue-failed-toast.png');
  const afterFirst = childrenOf(await memberOf(phone));
  const firstPressWrites = receipt.childWrites.slice(writesBefore);
  await till.unroute(matcher, handler);
  phase('1: second Continue');
  const writesMid = receipt.childWrites.length;
  const second = await pressContinue();
  assert.equal(second.status, 200, 'the second Continue registers');
  regs.push({ tag, id: second.reg.id });
  receipt.created.push({ kind: 'registration', tag, id: second.reg.id }); save();
  const secondPressWrites = receipt.childWrites.slice(writesMid);
  const sale = await saleWritten('dropoff-sale-1');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '01c-paid-cash.png');
  knownSales.add(sale.id);
  await checkInNow(second.reg.id);
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  const member = await memberOf(phone);
  const rows = childrenOf(member);
  const reg = await registrationOf(second.reg.id);
  const seen = { abortedRegistrationPosts: aborted, toast, childrenAfterFirstPress: afterFirst.map(c => c.name), firstPressWrites, secondPressWrites,
    sale: { status: paid.status, grossSatang: paid.totals?.grossSatang ?? null }, memberChildren: rows,
    registration: reg.children.map(c => ({ name: c.childName, childIdIsTheMembersChild: rows.some(r => r.id === c.childId), service: c.service, status: c.status })) };
  receipt.checks.guardian1 = { memberId: member?.id ?? null, bua: rows.find(r => r.name === 'ZZ TEST Bua') ?? null }; save();
  await memberPicture('01-guardian-children-once-after-retry.png', 'SCRUM-871 — guardian 1 after a failed first Continue and a second Continue',
    rows, [`Guardian ${guardianName(tag)} (${phone}), member ${member?.id ?? '-'}.`,
      `First Continue: the registration request was refused once (HTTP 500 injected in the browser) after the children were written; the till said "${toast.slice(0, 160)}".`,
      `Children after the first press: ${afterFirst.length} (${afterFirst.map(c => c.name).join(', ')}). Child writes on the first press: ${firstPressWrites.length}; on the second press: ${secondPressWrites.length}.`,
      `Second Continue: registration ${second.status}; sale ${paid.status}, ${(paid.totals?.grossSatang ?? 0) / 100} THB cash. Registration children linked to these records: ${seen.registration.filter(r => r.childIdIsTheMembersChild).length}/${seen.registration.length}.`]);
  const ok = aborted === 1 && /Couldn't register these children/.test(toast) && afterFirst.length === 2 && rows.length === 2
    && countBy(rows, 'ZZ TEST Bua') === 1 && countBy(rows, 'ZZ TEST Nok') === 1 && paid.status === 'finalised'
    && secondPressWrites.filter(w => w.method === 'POST').length === 0 && seen.registration.every(r => r.childIdIsTheMembersChild);
  point('1', ok, '01-guardian-children-once-after-retry.png', 'Registration refused once (injected 500) after the children were written; the second Continue wrote no child; the guardian holds exactly one ZZ TEST Bua and one ZZ TEST Nok; paid cash', seen);
}

// ---- 1b: SCRUM-871, the answer to the second child's create is lost (the server wrote it) ----
async function point1b() {
  const tag = 'g1b', phone = numbers.g1b;
  phase('1b: walk-in, two children no adult; the answer to the second child\'s create is lost once');
  await walkIn(phone);
  await ticket(2, 0);
  await fillGate([{ name: 'ZZ TEST Mali', age: 5 }, { name: 'ZZ TEST Ton', age: 7 }], guardianName(tag));
  let creates = 0; const lost = {};
  const matcher = url => /^\/api\/members\/[^/]+\/children$/.test(new URL(url).pathname);
  const handler = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    creates += 1;
    if (creates === 2) {
      // The request reaches the platform and is written; the browser never sees the answer.
      const answer = await route.fetch();
      lost.status = answer.status(); lost.childIdSent = route.request().postDataJSON()?.id ?? null; lost.name = route.request().postDataJSON()?.name ?? null;
      // A gateway error in its place (not a network abort, which would move the till to its box).
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ZZ_TEST_ANSWER_LOST', message: 'ZZ TEST: the answer was lost on the way.' } }) });
    } else await route.continue();
  };
  await till.route(matcher, handler);
  const writesBefore = receipt.childWrites.length;
  await continueButton().click();
  const toast = await toastText(/Couldn't save these children/);
  await till.waitForTimeout(1500);
  await shot(till, '01e-answer-lost-toast.png');
  const afterFirst = childrenOf(await memberOf(phone));
  await till.unroute(matcher, handler);
  phase('1b: second Continue');
  const writesMid = receipt.childWrites.length;
  const second = await pressContinue();
  assert.equal(second.status, 200);
  regs.push({ tag, id: second.reg.id });
  receipt.created.push({ kind: 'registration', tag, id: second.reg.id }); save();
  const firstPressWrites = receipt.childWrites.slice(writesBefore, writesMid);
  const secondPressWrites = receipt.childWrites.slice(writesMid);
  const sale = await saleWritten('dropoff-sale-1b');
  await payCash();
  knownSales.add(sale.id);
  await checkInNow(second.reg.id);
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  const member = await memberOf(phone);
  const rows = childrenOf(member);
  const tonResent = secondPressWrites.filter(w => w.method === 'POST' && w.name === 'ZZ TEST Ton');
  const seen = { lostAnswer: lost, toast, childrenAfterFirstPress: afterFirst.map(c => ({ id: c.id, name: c.name })), firstPressWrites, secondPressWrites,
    tonResentWithTheSameId: tonResent.length > 0 && tonResent.every(w => w.childIdSent === lost.childIdSent), sale: { status: paid.status, grossSatang: paid.totals?.grossSatang ?? null }, memberChildren: rows };
  await memberPicture('01d-answer-lost-children-once.png', 'SCRUM-871 (extra) — the answer to the second child\'s create was lost; a second Continue',
    rows, [`Guardian ${guardianName(tag)} (${phone}), member ${member?.id ?? '-'}.`,
      `First Continue: POST …/children for ZZ TEST Ton reached the platform (answer ${lost.status}, child id ${lost.childIdSent}) and the browser was handed a 502 in place of its answer; the till said "${toast.slice(0, 140)}".`,
      `Children on the platform after the first press: ${afterFirst.length}. Second press re-sent ZZ TEST Ton with child id ${tonResent.map(w => w.childIdSent).join(', ') || '(not re-sent)'} → ${tonResent.map(w => w.status).join(', ')}.`,
      `Sale ${paid.status}, ${(paid.totals?.grossSatang ?? 0) / 100} THB cash.`]);
  const ok = lost.status >= 200 && lost.status < 300 && afterFirst.length === 2 && rows.length === 2 && countBy(rows, 'ZZ TEST Mali') === 1 && countBy(rows, 'ZZ TEST Ton') === 1
    && rows.find(r => r.name === 'ZZ TEST Ton')?.id === lost.childIdSent && paid.status === 'finalised';
  point('1b', ok, '01d-answer-lost-children-once.png', 'Extra: the platform wrote ZZ TEST Ton but the till never saw the answer; the second Continue re-sent the same child id and the guardian holds one Mali and one Ton', seen);
}

// ---- 2: SCRUM-872, the known guardian's number first given on the form ----
async function point2() {
  const tag = 'dad', phone = numbers.dad;
  const before = childrenOf(await memberOf(numbers.g1));
  assert.equal(before.length, 2, 'point 1 left guardian 1 with two children');
  phase('2: a different unknown number (dad), walk-in, two children; the form carries guardian 1\'s number');
  await walkIn(phone);
  await ticket(2, 0);
  const half = await fillGate([{ name: 'zz test bua', age: 6 }, { name: 'ZZ TEST Nok', age: 9 }], guardianName(tag), numbers.g1);
  const formNumber = await half.locator('input[type="tel"]').first().inputValue();
  await half.locator('input[type="tel"]').first().scrollIntoViewIfNeeded();
  await shot(till, '02a-form-typed-children-guardian1-number.png');
  const writesBefore = receipt.childWrites.length;
  const written = await pressContinue();
  assert.equal(written.status, 200);
  regs.push({ tag, id: written.reg.id });
  receipt.created.push({ kind: 'registration', tag, id: written.reg.id }); save();
  const writes = receipt.childWrites.slice(writesBefore);
  const sale = await saleWritten('dropoff-sale-2');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '02b-paid-cash.png');
  knownSales.add(sale.id);
  await checkInNow(written.reg.id);
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  const member = await memberOf(numbers.g1);
  const rows = childrenOf(member);
  const reg = await registrationOf(written.reg.id);
  const dadMember = await memberOf(phone);
  const bua = rows.find(r => r.name === 'ZZ TEST Bua');
  const seen = { formNumber, childrenBefore: before, writes, memberChildren: rows, dadHasAMember: Boolean(dadMember),
    registration: { guardianPhone: reg.guardianPhone, memberIsGuardian1: reg.memberId ? reg.memberId === member?.id : null,
      children: reg.children.map(c => ({ name: c.childName, childId: c.childId, linkedToSaved: before.some(b => b.id === c.childId), allergies: c.allergies, status: c.status })) },
    sale: { status: paid.status, grossSatang: paid.totals?.grossSatang ?? null } };
  await memberPicture('02-guardian1-children-matched-allergy-kept.png', 'SCRUM-872 — guardian 1 after a second family visit typed on the form',
    rows, [`Typed on the form: "zz test bua" (6) and "ZZ TEST Nok" (9), Bua's allergy box left blank; the parent's number field carried guardian 1's number ${numbers.g1}; the first screen had the unknown number ${phone} (walk-in).`,
      `Child writes on Continue: ${writes.length ? writes.map(w => `${w.method} ${w.path} ${w.status}`).join('; ') : 'none'}. Registration children linked to the saved records: ${seen.registration.children.filter(c => c.linkedToSaved).length}/${seen.registration.children.length}.`,
      `Before this visit: ${before.map(c => `${c.name} (${c.id.slice(0, 8)}…, allergies ${c.allergies ?? '-'})`).join(', ')}. Sale ${paid.status}, ${(paid.totals?.grossSatang ?? 0) / 100} THB cash.`]);
  const ok = rows.length === 2 && countBy(rows, 'ZZ TEST Bua') === 1 && countBy(rows, 'ZZ TEST Nok') === 1 && bua?.allergies === 'ZZ TEST peanuts'
    && rows.every(r => before.some(b => b.id === r.id)) && writes.filter(w => w.method === 'POST').length === 0
    && seen.registration.children.every(c => c.linkedToSaved) && paid.status === 'finalised';
  point('2', ok, '02-guardian1-children-matched-allergy-kept.png', 'The typed children were matched to guardian 1\'s saved Bua and Nok (no new child, the registration names the saved records); Bua\'s allergy is still "ZZ TEST peanuts"; paid cash', seen);
}

// ---- 3: SCRUM-873, a nanny assigned on the board ----
async function boardCard(childName) {
  await till.goto('/');
  await till.getByRole('button', { name: 'Check-in', exact: true }).click();
  const search = till.getByPlaceholder('Search child, parent or phone…');
  await search.waitFor({ timeout: 20000 });
  await search.fill(childName);
  const card = till.locator('[class*="bg-card"]').filter({ hasText: childName }).last();
  let found = await card.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  for (const tab of ['Upcoming', 'Registered', 'Waiting']) {
    if (found) break;
    const t = till.getByRole('tab', { name: new RegExp(tab) }).or(till.getByRole('button', { name: new RegExp('^' + tab) })).first();
    if (await t.isVisible().catch(() => false)) { await t.click(); found = await card.waitFor({ timeout: 6000 }).then(() => true).catch(() => false); }
  }
  assert.ok(found, 'the board shows the card of ' + childName);
  await card.scrollIntoViewIfNeeded();
  return card;
}
async function cancelAtPayment(sale) {
  let how = 'till Cancel';
  const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
  if (await cancel.isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    await till.waitForTimeout(1500);
    const confirmVoid = till.getByRole('alertdialog').or(till.getByRole('dialog')).last();
    if (await confirmVoid.isVisible().catch(() => false)) {
      receipt.checks.saleCancelDialog = flat(await confirmVoid.innerText()).slice(0, 300);
      const reason = confirmVoid.locator('input, textarea').first();
      if (await reason.count()) await reason.fill(`ZZ TEST SCRUM-${T} family left before paying`);
      const go = confirmVoid.getByRole('button', { name: /void|cancel sale|confirm|yes/i }).last();
      if (await go.isEnabled().catch(() => false)) await go.click();
    }
    await till.waitForTimeout(3000);
  } else how = 'no Cancel on the payment step';
  let now = (await call('GET', `/sales/${sale.id}`)).body.sale;
  if (now.status !== 'voided') {
    how += ` (sale still ${now.status}; voided through the api as the harness cleanup does)`;
    assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} family left before paying` })).status, 200);
    now = (await call('GET', `/sales/${sale.id}`)).body.sale;
  }
  knownSales.add(sale.id);
  return { how, status: now.status };
}
/** What the order panel says about the nanny: the line's own "Nanny · <name>" and the "Nanny supervision" rows. */
async function nannyRows() {
  const head = till.getByText('Nanny supervision', { exact: true });
  const section = (await head.count()) > 0;
  return { section, sectionText: section ? flat(await head.first().locator('xpath=../..').innerText()).slice(0, 300) : null,
    named: await till.getByText(new RegExp('^Nanny ·\\s*' + NANNY + '$')).count(),
    blank: await till.getByText(/^Nanny ·\s*$/).count(), assignFor: await till.getByText(/^Nanny — assign for/).count(),
    lineAssignANanny: await till.getByText('Assign a nanny', { exact: true }).count() };
}
/** Length for the drop-off line (its configure panel), then on to the payment step. */
async function finishDropOffSetup(trace) {
  for (let i = 0; i < 10; i++) {
    if (await paymentStep().isVisible().catch(() => false)) return;
    const lengthPanel = till.getByRole('heading', { name: 'Play ticket length', exact: true });
    if (await lengthPanel.isVisible().catch(() => false)) {
      const panel = lengthPanel.locator('xpath=ancestor::div[contains(@class, "flex-col")][2]');
      trace.push('config panel: ' + flat(await panel.innerText().catch(() => '')).slice(0, 300));
      await panel.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
      await till.waitForTimeout(800);
      const done = till.getByRole('button', { name: /^(Continue|Choose length|Assign a nanny)$/ }).last();
      trace.push('config button: ' + flat(await done.innerText()) + (await done.isEnabled() ? '' : ' (disabled)'));
      if (await done.isEnabled()) { await done.click(); await till.waitForTimeout(1500); continue; }
      break;
    }
    if (await till.getByRole('heading', { name: 'Tourist', exact: true }).first().isVisible().catch(() => false) && !(await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().isVisible().catch(() => false))) {
      trace.push('tier step: Tourist'); await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click(); await till.waitForTimeout(1500); continue;
    }
    let pressed = false;
    for (const label of [/^Pay ฿/, /^Done adding/, /^Continue$/, /^Configure$/]) {
      const b = till.getByRole('button', { name: label }).first();
      if (await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) { trace.push('pressed ' + label); await b.click(); await till.waitForTimeout(1500); pressed = true; break; }
    }
    if (!pressed) { trace.push('buttons: ' + (await till.getByRole('button').allInnerTexts()).map(flat).filter(Boolean).join(' | ').slice(0, 600)); break; }
  }
  await expect(paymentStep()).toBeVisible({ timeout: 20000 });
}
async function point3() {
  const tag = 'nanny';
  phase('3: a waiting, unpaid nanny-age booking (Kai, 3)');
  await walkIn(numbers.nanny);
  await ticket(1, 0);
  await fillGate([{ name: KAI, age: 3 }], guardianName(tag));
  const written = await pressContinue();
  assert.equal(written.status, 200);
  regs.push({ tag, id: written.reg.id });
  receipt.created.push({ kind: 'registration', tag, id: written.reg.id }); save();
  await till.waitForTimeout(2500);
  await shot(till, '03a-after-gate-nanny-not-yet-assigned.png');
  const afterGate = { nannyRows: await nannyRows(), sales: (await newSales()).map(s => s.status), dialog: await till.getByRole('dialog').last().innerText().then(flat).catch(() => null) };
  receipt.checks.afterGate = afterGate; save();
  if (await till.getByRole('dialog').last().isVisible().catch(() => false)) await till.keyboard.press('Escape');
  for (const s of await newSales()) { if (['tendering', 'open'].includes(s.status)) await call('POST', `/sales/${s.id}/void`, { reason: `ZZ TEST SCRUM-${T} family left before paying` }); knownSales.add(s.id); }
  const stays = (await registrationOf(written.reg.id)).children;
  assert.ok(stays.every(c => c.status === 'registered' && c.service === 'nanny' && !c.nannyId), 'waiting, nanny service, no nanny yet');

  phase('3: the board — assign the ZZ TEST nanny to Kai');
  let card = await boardCard(KAI);
  await card.getByRole('button', { name: `Assign nanny to ${KAI}` }).click();
  const modal = till.getByRole('dialog').filter({ hasText: 'Assign a nanny' });
  await modal.waitFor();
  await modal.getByRole('button', { name: new RegExp(NANNY) }).first().click();
  // Every nanny on the roster but the ZZ TEST one is covered: the others are the park's staff.
  await shot(till, '03b-board-assign-nanny-dialog.png', [modal.getByRole('button').filter({ hasNotText: 'ZZ TEST' })]);
  await modal.getByRole('button', { name: `Assign ${NANNY}` }).click();
  await expect.poll(async () => (await registrationOf(written.reg.id)).children[0].nannyId ?? null, { timeout: 20000 }).not.toBeNull();
  await till.waitForTimeout(1500);
  card = await boardCard(KAI);
  const cardText = flat(await card.innerText()).slice(0, 400);
  await shot(till, '03c-board-card-nanny-assigned.png');

  phase('3a: the board\'s Check in hands the family to the till');
  await card.getByRole('button', { name: /^Check in/ }).first().click();
  await till.getByText(KAI).first().waitFor({ timeout: 30000 });
  await till.waitForTimeout(3000);
  const handover = await nannyRows();
  await shot(till, '03-board-check-in-order-summary-nanny-named.png');
  const trace = [];
  phase('3a: on to payment, then the sale is cancelled (the booking waits again)');
  let reached = true, atPayment = null;
  try { await finishDropOffSetup(trace); } catch (error) { reached = false; trace.push('not reached: ' + firstLine(error)); await shot(till, '03d-x-not-at-payment.png'); }
  let cancelled = null;
  if (reached) {
    atPayment = await nannyRows();
    await shot(till, '03d-handover-at-payment-nanny-supervision-named.png');
    const sale = await saleWritten('nanny-handover-sale');
    cancelled = await cancelAtPayment(sale);
  }
  const waitingAgain = (await registrationOf(written.reg.id)).children.map(c => ({ status: c.status, nannyKept: Boolean(c.nannyId), saleId: c.saleId ?? null }));
  const okA = handover.named >= 1 && handover.blank === 0 && handover.assignFor === 0 && handover.lineAssignANanny === 0 && (!atPayment || (atPayment.named >= 1 && atPayment.blank === 0 && atPayment.assignFor === 0));
  point('3a', okA, '03-board-check-in-order-summary-nanny-named.png', `Board → Check in: the order panel reads "Nanny · ${NANNY}" (named, not blank), and again in the Nanny supervision rows at payment (03c)`, { cardText, handover, atPayment, trace, cancelled, waitingAgain });

  phase('3b: Add drop-off child → Add to sale');
  await walkIn(numbers.nannyPicker);
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await till.getByRole('button', { name: 'Add drop-off child', exact: true }).click();
  const picker = till.getByRole('dialog').filter({ hasText: 'Bookings with a signed form' });
  await picker.waitFor();
  await till.waitForTimeout(2500);
  const family = picker.locator('div').filter({ hasText: `${guardianName(tag)}'s booking` }).filter({ hasText: KAI }).filter({ has: till.getByRole('button', { name: 'Add to sale' }) }).last();
  await expect(family).toBeVisible({ timeout: 20000 });
  await family.scrollIntoViewIfNeeded();
  await shot(till, '03e-picker-lists-kai.png');
  await family.getByRole('button', { name: 'Add to sale' }).click();
  await till.waitForTimeout(2000);
  if (await picker.isVisible().catch(() => false)) await till.keyboard.press('Escape');
  await till.waitForTimeout(1000);
  const added = await nannyRows();
  await shot(till, '03f-add-to-sale-order-summary-nanny-named.png');
  const okB = () => added.named >= 1 && added.assignFor === 0 && added.blank === 0 && added.lineAssignANanny === 0 && added.atPayment?.named >= 1 && added.atPayment?.assignFor === 0;
  phase('3b: pay cash and check Kai in');
  const trace2 = [];
  let paidStatus = null;
  try {
    await finishDropOffSetup(trace2);
    added.atPayment = await nannyRows();
    await shot(till, '03g-picker-sale-at-payment-nanny-named.png');
    const sale = await saleWritten('nanny-picker-sale');
    await payCash();
    await till.waitForTimeout(1500);
    await shot(till, '03h-picker-sale-paid-cash.png');
    knownSales.add(sale.id);
    await checkInNow(written.reg.id);
    paidStatus = (await call('GET', `/sales/${sale.id}`)).body.sale.status;
  } catch (error) { trace2.push('payment: ' + firstLine(error)); await shot(till, '03g-x-payment-not-completed.png'); }
  const finalStay = (await registrationOf(written.reg.id)).children.map(c => ({ status: c.status, nannyKept: Boolean(c.nannyId) }));
  point('3b', okB() && paidStatus === 'finalised', '03f-add-to-sale-order-summary-nanny-named.png', `Add drop-off child → Add to sale: the line keeps the nanny with her name ("Nanny · ${NANNY}"), not "assign for…"; paid cash and checked in`, { added, trace: trace2, paidStatus, finalStay });
}

// ---- 4: regression — an ordinary sale, and a one-child drop-off ----
async function point4() {
  phase('4a: ordinary sale — one adult and one child, cash');
  await walkIn(numbers.ordinary);
  await ticket(1, 1);
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  const sale = await saleWritten('ordinary-ticket-sale');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '04a-ordinary-sale-paid-cash.png');
  knownSales.add(sale.id);
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  point('4a', paid.status === 'finalised', '04a-ordinary-sale-paid-cash.png', 'One adult and one child paid in cash completes', { status: paid.status, grossSatang: paid.totals?.grossSatang ?? null });

  phase('4b: a drop-off for one new child (Pim, 6), cash');
  const tag = 'drop';
  await walkIn(numbers.drop);
  await ticket(1, 0);
  await fillGate([{ name: PIM, age: 6 }], guardianName(tag));
  const written = await pressContinue();
  assert.equal(written.status, 200);
  regs.push({ tag, id: written.reg.id });
  receipt.created.push({ kind: 'registration', tag, id: written.reg.id }); save();
  const sale2 = await saleWritten('dropoff-sale-4b');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '04b-dropoff-one-child-paid-cash.png');
  knownSales.add(sale2.id);
  const checkedIn = await checkInNow(written.reg.id);
  const paid2 = (await call('GET', `/sales/${sale2.id}`)).body.sale;
  const rows = childrenOf(await memberOf(numbers.drop));
  point('4b', paid2.status === 'finalised' && checkedIn && rows.length === 1, '04b-dropoff-one-child-paid-cash.png', 'A drop-off for one new child completes: paid cash, checked in, one child on the new guardian', { status: paid2.status, grossSatang: paid2.totals?.grossSatang ?? null, checkedIn, memberChildren: rows });
  await till.goto('/'); await landing(till).waitFor();
}

const attempt = async (key, fn) => {
  try { return await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    if (till) { receipt.failures.at(-1).screenText = flat(await till.locator('body').innerText().catch(() => '')).slice(0, 1500); save(); }
    await till.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await till.keyboard.press('Escape').catch(() => {});
    try {
      const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
      if (await paymentStep().isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) { await cancel.click(); await till.waitForTimeout(3000); }
    } catch { /* cleanup below reads the sales back */ }
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
  for (const phone of Object.values(numbers)) assert.equal(await memberOf(phone), null, 'ZZ TEST number must be unused');
  receipt.checks.testNumbersUnusedBefore = true;
  if (only.includes('3')) {
    // A ZZ TEST nanny on shift now, added by hand as the till's "nobody rostered" path does (POST /branches/:id/nannies/manual).
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const h = Number(hm.slice(0, 2));
    const from = `${String(h).padStart(2, '0')}:00`, to = h + 3 > 23 ? '23:59' : `${String(h + 3).padStart(2, '0')}:00`;
    const added = await call('POST', `/branches/${branchId}/nannies/manual`, { name: NANNY, from, to });
    assert.equal(added.status, 200, 'the ZZ TEST nanny is on the roster');
    const row = added.body.nannies.find(n => n.name === NANNY);
    const live = (row?.shifts ?? []).filter(s => s.source === 'manual');
    nannyShiftId = (live.find(s => Date.parse(s.startsAt) <= Date.now() && Date.parse(s.endsAt) > Date.now()) ?? live.at(-1))?.id ?? null;
    receipt.created.push({ kind: 'nanny-shift', nanny: NANNY, nannyId: row?.id ?? null, shiftId: nannyShiftId, from, to, onShift: row?.onShift ?? null, shiftKeys: Object.keys(live[0] ?? {}) }); save();
    assert.ok(row?.onShift, 'the ZZ TEST nanny is on shift now');
  }
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
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    const found = { files: urls.map(u => u.split('/').pop().split('?')[0]), gateMatchMarkers: 0 };
    // 'several_saved' / 'several_slots' are lib/gateChildren's match reasons (SCRUM-872), new in this landing.
    for (const url of urls) { const text = await (await fetch(url, { cache: 'no-store' })).text(); found.gateMatchMarkers += text.split('several_saved').length - 1 + text.split('several_slots').length - 1; }
    return found;
  });
  save();
  assert.ok(receipt.checks.bundle.gateMatchMarkers >= 2, 'the till serves the SCRUM-871/872 bundle');

  if (only.includes('1')) await attempt('1', point1);
  if (only.includes('1b')) await attempt('1b', point1b);
  if (only.includes('2')) await attempt('2', point2);
  if (only.includes('3')) await attempt('3', point3);
  if (only.includes('4')) await attempt('4', point4);
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
  let ownsStation = false;
  if (station) {
    await clean('verify own till', async () => { assert.equal((await call('GET', `/stations/${station.id}`)).body.station.name, fixtureName); ownsStation = true; });
    if (ownsStation) {
      // Open sales first, so a booking left at payment is not paid by anyone.
      for (const sale of (await stationSales().catch(() => [])).filter(s => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
        assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided', by: 'cleanup' });
      });
      for (const item of regs) await clean(`own registration ${item.tag}`, async () => {
        let reg = await registrationOf(item.id);
        assert.equal(reg.guardianName, guardianName(item.tag), 'only this run\'s own booking');
        for (const child of reg.children) assert.match(child.childName, /^(ZZ TEST|zz test) /);
        if (reg.children.some(c => c.status === 'registered')) {
          // Never paid (a pass that stopped early): this run's own booking is cancelled through the till's route.
          const r = await till.request.post(`/api/checkin/registrations/${item.id}/cancel`, { data: { reason: `ZZ TEST SCRUM-${T} proof cleanup` }, headers: { 'idempotency-key': randomUUID() } });
          receipt.cleanup.push({ kind: 'cancel-own-booking', tag: item.tag, status: r.status() });
        }
        reg = await registrationOf(item.id);
        for (const child of reg.children.filter(c => c.status === 'in_park')) {
          const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: item.id, filename: `ZZ TEST SCRUM-${T} synthetic pickup.png` });
          assert.equal(file.status, 200);
          const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
          assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
          assert.equal((await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id })).status, 200);
        }
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
  if (nannyShiftId) await clean('take the ZZ TEST nanny off shift', async () => {
    const r = await call('DELETE', `/branches/${branchId}/nannies/shifts/${nannyShiftId}`);
    const row = r.body?.nannies?.find(n => n.name === NANNY);
    receipt.cleanup.push({ kind: 'nanny-shift', shiftId: nannyShiftId, status: r.status, onShiftAfter: row?.onShift ?? null, note: 'the nanny row itself has no archive route and stays on the roster, off shift' });
    assert.equal(r.status, 200);
  });
  if (process.env.KEEP_MEMBERS !== '1') for (const [key, phone] of Object.entries(numbers)) await clean(`check test number ${key}`, async () => {
    const member = await memberOf(phone);
    if (member) {
      assert.ok(`${member.nickname ?? ''} ${member.name ?? ''}`.includes(`ZZ TEST SCRUM-${T}`), 'only own named test members');
      assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
      receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true });
    } else receipt.cleanup.push({ kind: 'test-number', key, member: null });
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
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.pass])), odd: receipt.odd.length, pageErrors: receipt.pageErrors.length, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
