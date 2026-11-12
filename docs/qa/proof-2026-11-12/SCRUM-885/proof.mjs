// SCRUM-885 + SCRUM-888 staging proof.
//   885: a member created on this sale (the till's New member box) is welcomed on the customer side as a first
//        visit ("Welcome to Oto" + the park's first-visit line), never "Welcome back" / "Great to see you again";
//        found again on a later sale, they are welcomed back by name.
//   888: in the Add drop-off child window the family card's Cancel booking fits inside the card (1680, 1440, phone).
// Adapted from the committed SCRUM-858 (split view, New member box, paired display) and SCRUM-862 (Add drop-off
// child window, Cancel booking) harnesses in docs/qa/proof-2026-11-12/.
// Own ZZ TEST till on the shared virtual box, ZZ TEST members and families, invented numbers (08988500xx), no payment.
// No credential, pairing code or raw response body enters the receipt or the console.
//
//   node proof.mjs <sha> <out-dir> [passes]
//   passes: a  split view 1440 x 900: new member, one step on, then the same number again   (points 1, 3)
//           b  split view 1680 x 1050: the same                                              (points 1, 3)
//           t  Thai on the customer half: first visit, then welcome back                     (point 4)
//           p  Add drop-off child: long, short and extra-long family; 1680, 1440, phone; cancel (points 5, 6)
//           d  a separate paired display: new member, one step on, then welcome back        (point 2)
// ZZ_BASE moves the invented numbers (08988500<base>..); the run asserts they are unused first.
//
// As run on 12 November 2026, 14:12-14:16 Bangkok, against the till at 3f0c082b (both till deploys live since 14:02):
// `node proof.mjs 3f0c082b1630d029f642b1cac0da0c9e644d7001 out-01` (one run, every point passed, cleanup read back).
// The pictures and receipt.json were then moved from out-01/ to sit beside this file. Known misread of this harness:
// `staffOrderNamesMember` reads the half under the "Add to Sale" heading, which the Configure step no longer shows,
// so it waits 30 s and records false; the order panel names the member in 01c and 03c. It is not part of any verdict.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The repository root: four folders up from docs/qa/proof-<date>/SCRUM-885, or OTO_REPO when run from elsewhere.
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const wanted = (process.argv[4] ?? 'a,b,t,p,d').split(',');
const T = '885';
const base = Number(process.env.ZZ_BASE ?? 10);
const zz = i => '08988500' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const receipt = { tickets: ['SCRUM-885', 'SCRUM-888'], sha, startedAt: new Date().toISOString(), phase: 'preflight',
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  passes: wanted, points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], displayIntents: [], cleanup: [] };
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

// ZZ TEST only; confirmed unused before use.
const numbers = { split1440: zz(0), split1680: zz(1), display: zz(2), thai: zz(3), pick1680: zz(4), pick1440: zz(5), famLong: zz(6), famShort: zz(7), famXLong: zz(8) };
receipt.numbers = numbers;
const RUN = (String(process.argv[3] ?? 'out').replace(/\D/g, '') || '0').padStart(2, '0').slice(-2);
const names = { split1440: `ZZ TEST ${T} split 1440 r${RUN}`, split1680: `ZZ TEST ${T} split 1680 r${RUN}`, display: `ZZ TEST ${T} display r${RUN}`, thai: `ZZ TEST ${T} Thai r${RUN}` };
// As long as the SCRUM-871 proof's "ZZ TEST SCRUM-871 guardian nanny05" (34 characters), a short one, and a much longer one.
const families = {
  long: { guardian: `ZZ TEST SCRUM-888 guardian nanny${RUN}`, child: `ZZ TEST Kai 888-${RUN}`, phone: numbers.famLong },
  short: { guardian: `ZZ TEST Ploy 888 ${RUN}`, child: `ZZ TEST Mint 888-${RUN}`, phone: numbers.famShort },
  xlong: { guardian: `ZZ TEST SCRUM-888 guardian with a much longer family name ${RUN}`, child: `ZZ TEST Nok 888-${RUN}`, phone: numbers.famXLong },
};
receipt.families = Object.fromEntries(Object.entries(families).map(([k, f]) => [k, { guardian: f.guardian, characters: f.guardian.length }]));
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const EN = { title: 'Welcome to Oto', line: "Thailand's happiest indoor play park. Let's get you ready to play!", back: 'Welcome back', again: 'Great to see you again' };
const TH = { title: 'ยินดีต้อนรับสู่ Oto', line: 'สนามเล่นในร่มที่มีความสุขที่สุดของไทย มาเตรียมตัวเล่นกันเลย!', back: 'ยินดีต้อนรับกลับมา', again: 'ยินดีที่ได้พบคุณอีกครั้ง' };
let browser = null, till = null, display = null, station = null, branchId = null, branchCode = null, failed = false, staffNames = [];
const regs = {}; // family key -> registration id

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
/** Never in a picture: the signed-in account's corner and name, passwords, the pairing code, QR grids, band codes, any family that is not ZZ TEST. */
const masks = async page => {
  const picker = page.getByRole('dialog').locator('[class*="bg-card"]').filter({ hasNotText: 'ZZ TEST' });
  return [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
    page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
    page.locator('div.grid.gap-px'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/), picker,
    ...staffNames.map(name => page.getByText(name, { exact: false }))];
};
const shot = async (page, name, extra = []) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [...(await masks(page)), ...extra] });
  console.log('picture', name);
};
async function closeUp(page, locator, name, pad = 20) {
  try {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    const view = page.viewportSize();
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: await masks(page),
      clip: { x, y, width: Math.min(view.width - x, box.width + 2 * pad), height: Math.min(view.height - y, box.height + 2 * pad) } });
    console.log('picture', name);
    return name;
  } catch (error) { return { failure: firstLine(error) }; }
}
const point = (key, pass, pictures, shows, seen = {}) => { receipt.points[key] = { pass, pictures, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); if (!pass) console.log('  seen', JSON.stringify(seen).slice(0, 2500)); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what, JSON.stringify(extra).slice(0, 600)); };

function watch(page, label) {
  page.on('pageerror', e => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('console', m => { if (m.type() === 'error') receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'console.error', text: m.text().split('\n')[0].slice(0, 240) }); });
  page.on('response', r => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http',
      text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` });
  });
}
/** What the till hands a paired display: the stage and whether a member rides along (no body kept). */
function watchIntents(page) {
  page.on('request', r => {
    const path = new URL(r.url()).pathname;
    if (r.method() !== 'POST' || !/^\/api\/box\/v1\/station\/[^/]+\/intents$/.test(path)) return;
    let body = null; try { body = r.postDataJSON(); } catch { return; }
    if (body?.type !== 'session.publish_display') return;
    const p = body.payload ?? {};
    receipt.displayIntents.push({ at: receipt.phase, stage: p.stage ?? null, member: p.member ? (/^ZZ TEST/.test(p.member.nickname ?? p.member.name ?? '') ? 'ZZ TEST member' : 'a member') : null, lines: Array.isArray(p.sale?.lines) ? p.sale.lines.length : null });
  });
}

const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
/** The till's own customer half (the split view's right side). */
const customerHalf = () => till.locator('div[class^="w-1/2 h-full"]').last();
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const typeStep = () => till.getByRole('heading', { name: 'Select Customer Type', exact: true });
const ticketStep = () => till.getByRole('heading', { name: 'Add to Sale', exact: true });
const offerBox = () => till.getByRole('dialog', { name: 'New member?', exact: true });
const CONTINUE = { en: 'Continue', th: 'ดำเนินการต่อ' };

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
  const context = await browser.newContext({ baseURL: pos, viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
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

/** The first screen on a customer surface: the language, then the number on its keypad. */
async function firstScreen(surface, number, lang = 'en') {
  await landing(surface).waitFor();
  if (await surface.getByTestId('language-choice').isVisible()) await surface.getByTestId(`language-choice-${lang}`).click();
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await keypad(scope, number);
  return scope;
}
/** Number -> Continue on the given surface. 'offer' when the till's "New member?" box opened, 'found' when the customer type step did. */
async function identify(surface, number, lang = 'en') {
  const scope = await firstScreen(surface, number, lang);
  await scope.getByRole('button', { name: CONTINUE[lang], exact: true }).last().click();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (await offerBox().isVisible().catch(() => false)) { await expect(offerBox()).toContainText(spaced(number)); return 'offer'; }
    if (await typeStep().isVisible().catch(() => false)) return 'found';
    await till.waitForTimeout(300);
  }
  throw new Error('neither the "New member?" box nor the customer type step opened');
}
async function createInBox(number, name) {
  const box = offerBox();
  await box.getByPlaceholder('e.g. Mali').fill(name);
  const [created] = await Promise.all([
    till.waitForResponse(r => new URL(r.url()).pathname === '/api/members' && r.request().method() === 'POST'),
    box.getByRole('button', { name: 'Create member', exact: true }).click(),
  ]);
  assert.equal(created.status(), 200, 'the member is created');
  await box.waitFor({ state: 'hidden' });
  await typeStep().waitFor();
  receipt.created.push({ kind: 'member', name, number }); save();
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** What a customer screen says: the greetings, the Customer bar, "Member rate applied", any raw key. */
async function greeting(scope, words = EN, name = null) {
  const text = flat(await scope.innerText().catch(() => ''));
  const bar = scope.locator('div.shrink-0.px-8.py-3');
  return {
    firstVisitTitle: text.includes(words.title), firstVisitLine: text.includes(words.line),
    welcomeBack: text.includes(words.back) || text.includes(EN.back), greatToSeeYou: text.includes(words.again) || text.includes(EN.again),
    welcomeBackLine: text.match(new RegExp(`(?:${escapeRe(words.back)}|${EN.back}), [^!]+!`))?.[0] ?? null,
    customerBar: (await bar.count()) ? flat(await bar.first().innerText()) : null,
    namesMember: name ? text.includes(name) : null,
    memberRateApplied: (text.match(/Member rate applied/g) ?? []).length,
    rawKeys: [...new Set(text.match(/\b(?:till|common|display|order|welcome)\.[A-Za-z]+(?:\.[A-Za-z]+)*\b|\{\{\w+\}\}/g) ?? [])],
    english: /Welcome|Great to see|happiest/.test(text),
  };
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
  await till.waitForTimeout(1000);
}
/** Leave the sale from the till (nothing is written before payment): the order panel's Cancel, else a reload. */
async function cancelSale(back = () => landing(till)) {
  let how = 'reload';
  const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
  if (await cancel.isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    how = 'Cancel button';
    const ok = await back().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    if (!ok) { how = 'Cancel button, then reload'; await till.goto('/'); }
  } else await till.goto('/');
  await back().waitFor({ timeout: 30000 });
  return how;
}

// ---- points 1 and 3: the split view at one size ----
async function passSplit(key, width, height, prefix) {
  const n = numbers[key], name = names[key];
  phase(`${key}: split view ${width} x ${height} — a fresh number, the New member box`);
  await till.setViewportSize({ width, height });
  await till.goto('/'); await landing(till).waitFor();
  assert.equal(await identify(till, n), 'offer', 'a fresh number offers "New member?"');
  await createInBox(n, name);
  const half = customerHalf();
  await expect.poll(async () => { const g = await greeting(half); return g.firstVisitTitle || g.welcomeBack; }, { timeout: 15000 }).toBe(true);
  await till.waitForTimeout(1500);
  const toast = await till.getByText('Member created', { exact: true }).count();
  const welcome = await greeting(half, EN, name);
  const staffBadge = flat(await till.locator('body').innerText()).match(/(Tourist|Expat|Thai) · verified|No verified rate/)?.[0] ?? null;
  const pics = [`${prefix}a-${width}x${height}-new-member-customer-half-welcome-to-oto.png`, `${prefix}b-${width}x${height}-tourist-ticket-step-still-first-visit.png`, `${prefix}c-${width}x${height}-one-ticket-order-names-the-member.png`];
  await shot(till, pics[0]);
  phase(`${key}: one step on — Tourist, then one child and one adult`);
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await ticketStep().waitFor({ timeout: 20000 });
  await till.waitForTimeout(1000);
  const atTickets = await greeting(half, EN, name);
  await shot(till, pics[1]);
  await addTickets(1, 1);
  await till.waitForTimeout(1200);
  const atOrder = await greeting(half, EN, name);
  const staffOrderNames = flat(await halfOf(ticketStep()).innerText().catch(() => '')).includes(name);
  await shot(till, pics[2]);
  const left = await cancelSale();
  const ok1 = welcome.firstVisitTitle && welcome.firstVisitLine && !welcome.welcomeBack && !welcome.greatToSeeYou
    && !atTickets.welcomeBack && !atTickets.greatToSeeYou && atOrder.namesMember === true;
  point(`1-${width}`, ok1, pics, `Split view ${width} x ${height}: ${n} typed on the customer half, "${name}" created in the New member box; the customer half says "${EN.title}" and the first-visit line, no "Welcome back" / "Great to see you again"; Tourist keeps that greeting; with one child and one adult the order names the member`,
    { toastMemberCreated: toast, staffBadge, welcome, atTickets, atOrder, staffOrderNamesMember: staffOrderNames, saleLeftBy: left });

  phase(`${key}: the same number on a new sale — welcomed back`);
  assert.equal(await identify(till, n), 'found', 'the member is found');
  await expect.poll(async () => (await greeting(half)).welcomeBack, { timeout: 15000 }).toBe(true);
  await till.waitForTimeout(1200);
  const again = await greeting(half, EN, name);
  const pic3 = `${prefix}d-${width}x${height}-same-number-new-sale-welcome-back.png`;
  await shot(till, pic3);
  const left2 = await cancelSale();
  const ok3 = again.welcomeBackLine === `Welcome back, ${name}!` && again.greatToSeeYou && !again.firstVisitTitle;
  point(`3-${width}`, ok3, [pic3], `Split view ${width} x ${height}: the sale abandoned, a new sale with ${n}: the member is found and the customer half says "Welcome back, ${name}!" and "Great to see you again"`, { again, saleLeftBy: left2 });
}

// ---- point 4: Thai on the customer half ----
async function passThai() {
  const n = numbers.thai, name = names.thai;
  phase('t: Thai on the customer half — a fresh number, the New member box');
  await till.setViewportSize({ width: 1440, height: 900 });
  await till.goto('/'); await landing(till).waitFor();
  assert.equal(await identify(till, n, 'th'), 'offer');
  await createInBox(n, name);
  const half = customerHalf();
  await expect.poll(async () => { const g = await greeting(half, TH); return g.firstVisitTitle || g.welcomeBack; }, { timeout: 15000 }).toBe(true);
  await till.waitForTimeout(1500);
  const welcome = await greeting(half, TH, name);
  const pics = ['04a-thai-new-member-first-visit-greeting.png', '04b-thai-customer-half-close.png', '04c-thai-same-number-welcome-back.png'];
  await shot(till, pics[0]);
  await closeUp(till, half, pics[1], 0);
  const left = await cancelSale();
  phase('t: the same number again in Thai — welcomed back');
  assert.equal(await identify(till, n, 'th'), 'found');
  await expect.poll(async () => (await greeting(half, TH)).welcomeBack, { timeout: 15000 }).toBe(true);
  await till.waitForTimeout(1200);
  const again = await greeting(half, TH, name);
  await shot(till, pics[2]);
  const left2 = await cancelSale();
  const ok = welcome.firstVisitTitle && welcome.firstVisitLine && !welcome.welcomeBack && !welcome.greatToSeeYou && welcome.rawKeys.length === 0 && !welcome.english
    && again.welcomeBackLine === `${TH.back}, ${name}!` && again.rawKeys.length === 0;
  point('4', ok, pics, `Thai chosen on the customer half, ${n}, "${name}" created: the customer half says "${TH.title}" and "${TH.line}", no raw key, no English, no "${TH.back}"; the next sale says "${TH.back}, ${name}!"`, { welcome, again, saleLeftBy: [left, left2] });
}

// ---- point 2: a separate paired display ----
async function passDisplay() {
  const n = numbers.display, name = names.display;
  phase('d: pair own customer display; the till at 1440 x 900');
  await till.setViewportSize({ width: 1440, height: 900 });
  await till.goto('/');
  await pairDisplay();
  await expect.poll(async () => customerHalf().count(), { timeout: 30000 }).toBe(0); // the till's own customer half gives way to the display
  const intentsFrom = receipt.displayIntents.length;
  phase('d: the number on the display, the New member box on the till');
  assert.equal(await identify(display.page, n), 'offer');
  await createInBox(n, name);
  const dp = display.page;
  const body = dp.locator('body');
  await expect.poll(async () => { const g = await greeting(body); return g.firstVisitTitle || g.welcomeBack; }, { timeout: 30000 }).toBe(true);
  // Two of the display's own reads after the create, so a late "Welcome back" would have arrived.
  for (let read = 0; read < 2; read += 1) await dp.waitForResponse(r => /\/display\/session$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET', { timeout: 20000 }).catch(() => {});
  await dp.waitForTimeout(800);
  const welcome = await greeting(body, EN, name);
  const welcomeIntents = receipt.displayIntents.slice(intentsFrom).filter(i => i.stage === 'welcome');
  const pics = ['02a-paired-display-new-member-welcome-to-oto.png', '02b-till-staff-side-member-created-display-paired.png', '02c-paired-display-one-ticket-order-names-the-member.png', '02d-paired-display-same-number-welcome-back.png'];
  await shot(dp, pics[0]);
  await shot(till, pics[1]);
  phase('d: one step on — Tourist, one child and one adult');
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await ticketStep().waitFor({ timeout: 20000 });
  await dp.waitForTimeout(2500);
  const atTickets = await greeting(body, EN, name);
  await addTickets(1, 1);
  await expect.poll(async () => (await greeting(body, EN, name)).namesMember, { timeout: 20000 }).toBe(true).catch(() => {});
  await dp.waitForTimeout(1500);
  const atOrder = await greeting(body, EN, name);
  await shot(dp, pics[2]);
  const left = await cancelSale(() => landing(dp));
  phase('d: the same number on the display, a new sale — welcomed back');
  assert.equal(await identify(dp, n), 'found');
  await expect.poll(async () => (await greeting(body)).welcomeBack, { timeout: 30000 }).toBe(true);
  await dp.waitForTimeout(1200);
  const again = await greeting(body, EN, name);
  await shot(dp, pics[3]);
  const left2 = await cancelSale(() => landing(dp));
  const ok = welcome.firstVisitTitle && welcome.firstVisitLine && !welcome.welcomeBack && !welcome.greatToSeeYou
    && welcomeIntents.every(i => i.member === null)
    && !atTickets.welcomeBack && atOrder.namesMember === true && again.welcomeBackLine === `Welcome back, ${name}!`;
  point('2', ok, pics, `A separate display paired to the own till (1280 x 800): ${n} typed on the display's keypad, "${name}" created in the till's New member box; the display says "${EN.title}" and the first-visit line, never "Welcome back"; every welcome the till published after the create carried no member; one ticket on, the display's order names the member; the next sale with the same number is welcomed back by name`,
    { welcome, welcomeIntentsAfterCreate: welcomeIntents, atTickets, atOrder, again, saleLeftBy: [left, left2] });
  await dropDisplay();
  await till.goto('/');
}

// ---- points 5 and 6: Add drop-off child, the card's Cancel booking ----
/** A family registered for drop-off through the route the till's form calls, as the till's own session; nobody pays. */
async function registerWaiting(key) {
  const f = families[key];
  const answer = await till.evaluate(async ({ guardian, child, phone, branchCode }) => {
    const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
    const catalog = await (await fetch(`/api/public/branches/${branchCode}/catalog`)).json();
    const confirmations = catalog.supervision.policy.confirmations.filter(c => c.required).map(c => c.id);
    const id = crypto.randomUUID();
    const res = await fetch('/api/checkin/registrations', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ id, branchId: me.branch.id, stationId: me.operatorContext.stationId, guardianName: guardian, guardianPhone: phone,
        contactChannel: 'whatsapp', consentAcknowledged: true, acknowledgedConfirmationIds: confirmations,
        children: [{ checkinId: crypto.randomUUID(), name: child, ageYears: 5, service: 'drop_off', allergies: null, foodRestrictions: null, foodProvision: { mode: 'none', paidSatang: 0 } }] }) });
    return { status: res.status, id, code: res.status >= 400 ? ((await res.json().catch(() => null))?.error?.code ?? null) : null };
  }, { guardian: f.guardian, child: f.child, phone: f.phone, branchCode });
  assert.equal(answer.status, 200, `registration ${key}: ${answer.status} ${answer.code}`);
  regs[key] = answer.id;
  receipt.created.push({ kind: 'registration', key, id: answer.id, guardian: f.guardian }); save();
}
const pickerOf = () => till.getByRole('dialog').filter({ hasText: 'Add drop-off child' });
const cardOf = (picker, key) => picker.locator('div').filter({ hasText: `${families[key].guardian}'s booking` }).filter({ has: till.getByRole('button', { name: 'Add sibling' }) }).last();
async function openPicker(walkInNumber) {
  if (walkInNumber) {
    await till.goto('/'); await landing(till).waitFor();
    assert.equal(await identify(till, walkInNumber), 'offer');
    await offerBox().getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
    await typeStep().waitFor();
  } else {
    await till.goto('/');
    await typeStep().waitFor({ timeout: 30000 });
  }
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await till.getByRole('button', { name: 'Add drop-off child', exact: true }).click();
  const picker = pickerOf();
  await picker.waitFor();
  for (const key of Object.keys(families)) await expect(cardOf(picker, key).getByRole('button', { name: 'Cancel booking' })).toBeVisible({ timeout: 20000 });
  await expect.poll(() => picker.evaluate(el => getComputedStyle(el).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, [^)]*\))$/);
  await expect(till.getByText(/ is yours$/)).toHaveCount(0, { timeout: 15000 });
  await till.waitForTimeout(600);
  return picker;
}
/** Where the window, the list, the card, the name and both buttons are drawn (getBoundingClientRect), rounded to 0.1 px. */
async function measure(card) {
  return card.evaluate(element => {
    const r1 = v => Math.round(v * 10) / 10;
    const box = node => { const r = node.getBoundingClientRect(); return { left: r1(r.left), right: r1(r.right), top: r1(r.top), bottom: r1(r.bottom), width: r1(r.width) }; };
    const button = words => { const b = [...element.querySelectorAll('button')].find(x => x.textContent?.trim() === words); return b ? { ...box(b), whole: b.scrollWidth <= b.clientWidth + 1, text: b.textContent.trim() } : null; };
    const name = element.querySelector('.font-bold.truncate');
    const list = element.closest('[data-radix-scroll-area-viewport]');
    return { window: box(element.closest('[role="dialog"]')), list: { ...box(list), scrollsSideways: list.scrollWidth > list.clientWidth + 1 }, card: box(element),
      name: name ? { ...box(name), whole: name.scrollWidth <= name.clientWidth + 1, text: name.textContent.trim() } : null,
      add: button('Add to sale'), cancel: button('Cancel booking'), viewportWidth: window.innerWidth,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
}
function judge(c, size) {
  const inside = {
    cardInsideList: c.card.right <= c.list.right + 0.5 && c.card.left >= c.list.left - 0.5,
    listInsideWindow: c.list.right <= c.window.right + 0.5,
    windowInsideViewport: c.window.right <= c.viewportWidth + 0.5 && c.window.left >= -0.5,
    addThere: Boolean(c.add) && c.add.whole,
    cancelWhole: Boolean(c.cancel) && c.cancel.whole,
    cancelInsideCard: Boolean(c.cancel) && c.cancel.right <= c.card.right - 16 + 1 && c.cancel.left >= c.card.left + 16 - 1,
    addInsideCard: Boolean(c.add) && c.add.right <= c.card.right - 16 + 1,
    noSidewaysScroll: !c.list.scrollsSideways && !c.pageScrollsSideways,
  };
  const layout = size === 'phone'
    ? { buttonsUnderName: c.add.top >= c.name.bottom - 0.5, buttonsOneRow: Math.abs(c.cancel.top - c.add.top) <= 1, cancelAtRight: c.cancel.right >= c.card.right - 16 - 1 }
    : { oneRow: Math.abs(c.cancel.top - c.add.top) <= 1 && Math.abs(c.add.top - c.name.top) <= 8 && c.add.left > c.name.right,
        cancelUnderAdd: c.cancel.top >= c.add.bottom - 1 && Math.abs(c.cancel.right - c.add.right) <= 1, addBesideName: c.add.left > c.name.right && Math.abs(c.add.top - c.name.top) <= 8 };
  return { inside, layout, fits: Object.values(inside).every(Boolean),
    margins: { cardRightToListRight: Math.round((c.list.right - c.card.right) * 10) / 10, cancelRightToCardRight: Math.round((c.card.right - c.cancel.right) * 10) / 10, listRightToWindowRight: Math.round((c.window.right - c.list.right) * 10) / 10 } };
}
async function pickerAt(label, width, height, walkInNumber, prefix) {
  phase(`p: Add drop-off child at ${label} ${width} x ${height}`);
  await till.setViewportSize({ width, height });
  const picker = await openPicker(walkInNumber);
  const seen = { cardsInWindow: await picker.locator('[class*="bg-card"]').filter({ has: till.getByRole('button', { name: 'Add sibling' }) }).count() };
  for (const key of Object.keys(families)) { const fit = await measure(cardOf(picker, key)); seen[key] = { ...judge(fit, label), fit }; }
  const pics = [];
  await cardOf(picker, 'long').scrollIntoViewIfNeeded();
  await till.waitForTimeout(400);
  pics.push(`${prefix}a-${label}-${width}x${height}-add-dropoff-child-window.png`); await shot(till, pics.at(-1));
  for (const key of Object.keys(families)) { const name = `${prefix}${({ long: 'b', short: 'c', xlong: 'd' })[key]}-${label}-${width}x${height}-${key}-name-card.png`; const r = await closeUp(till, cardOf(picker, key), name, 12); if (typeof r === 'string') pics.push(r); }
  return { seen, pics };
}
async function passPicker() {
  phase('p: three waiting ZZ TEST families, registered through the till\'s route');
  for (const key of Object.keys(families)) await registerWaiting(key);
  const all = {};
  for (const [label, width, height, number, prefix] of [['counter', 1680, 1050, numbers.pick1680, '05a'], ['counter', 1440, 900, numbers.pick1440, '05b'], ['phone', 390, 844, null, '05c']]) {
    const { seen, pics } = await pickerAt(label, width, height, number, prefix);
    all[`${label}-${width}`] = { seen, pics };
    if (label !== 'phone') { await till.keyboard.press('Escape'); await till.waitForTimeout(400); }
  }
  const sizes = Object.values(all);
  const ok5 = sizes.every(s => ['long', 'short'].every(k => s.seen[k].fits))
    && all['counter-1680'].seen.short.layout.oneRow && all['counter-1440'].seen.short.layout.oneRow
    && all['phone-390'].seen.long.layout.buttonsUnderName && all['phone-390'].seen.short.layout.buttonsUnderName;
  point('5', ok5, sizes.flatMap(s => s.pics), 'Add drop-off child at 1680 x 1050, 1440 x 900 (counter till) and 390 x 844 (phone till): each own card inside the list and the window, Add to sale and Cancel booking whole inside the card; the short-name card keeps its one row on the counter; on the phone the buttons sit under the name',
    Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.seen])));
  for (const [k, v] of Object.entries(all)) if (!v.seen.xlong.fits) odd(`extra-long family name at ${k}: the card does not fit`, { margins: v.seen.xlong.margins, inside: v.seen.xlong.inside });

  // ---- point 6: cancel the three bookings from the phone till's window, with a ZZ TEST reason ----
  phase('6: Cancel booking on the phone till — the confirm asks for a reason');
  const picker = pickerOf();
  const seen6 = {};
  const pics6 = [];
  for (const key of ['long', 'short', 'xlong']) {
    const card = cardOf(picker, key);
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: 'Cancel booking' }).click();
    const confirm = till.getByRole('dialog').filter({ hasText: 'Cancel this waiting booking' });
    await confirm.waitFor();
    const press = confirm.getByRole('button', { name: /reason to cancel|Cancel the booking/ });
    const s = { pressBeforeReason: { label: flat(await press.innerText()), enabled: await press.isEnabled() } };
    if (key === 'long') { pics6.push('06a-phone-cancel-confirm-reason-empty.png'); await shot(till, pics6.at(-1)); }
    await confirm.getByLabel('Reason').fill('ZZ TEST SCRUM-888 proof cleanup');
    s.pressAfterReason = { label: flat(await press.innerText()), enabled: await press.isEnabled() };
    if (key === 'long') { pics6.push('06b-phone-cancel-confirm-reason-typed.png'); await shot(till, pics6.at(-1)); }
    const [answer] = await Promise.all([
      till.waitForResponse(r => /\/api\/checkin\/registrations\/[^/]+\/cancel$/.test(new URL(r.url()).pathname)),
      confirm.getByRole('button', { name: 'Cancel the booking' }).click(),
    ]);
    s.cancelAnswer = answer.status();
    await expect(confirm).toBeHidden({ timeout: 20000 });
    await expect(picker.getByText(`${families[key].guardian}'s booking`)).toHaveCount(0, { timeout: 20000 });
    const reg = (await call('GET', `/checkin/registrations/${regs[key]}`)).body;
    s.readBack = { children: reg.children.map(c => c.status), cancelReason: reg.children.map(c => c.cancelReason ?? null)[0] ?? null };
    seen6[key] = s;
  }
  await till.waitForTimeout(800);
  pics6.push('06c-phone-window-after-cancel-own-families-gone.png'); await shot(till, pics6.at(-1));
  await till.keyboard.press('Escape');
  const listed = (await call('GET', `/checkin/registrations?branchId=${branchId}`)).body.registrations ?? [];
  seen6.ownStillWaiting = listed.filter(r => Object.values(regs).includes(r.id)).length;
  const ok6 = ['long', 'short', 'xlong'].every(k => seen6[k].cancelAnswer === 200 && !seen6[k].pressBeforeReason.enabled && seen6[k].pressAfterReason.enabled && seen6[k].readBack.children.every(c => c === 'cancelled')) && seen6.ownStillWaiting === 0;
  point('6', ok6, pics6, 'On the phone till each own booking\'s Cancel booking opens the confirm; the press stays disabled until a reason is typed; with "ZZ TEST SCRUM-888 proof cleanup" each is cancelled (200), leaves the window, and reads back cancelled; none of the run\'s families is still waiting', seen6);
  await till.setViewportSize({ width: 1440, height: 900 });
}

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) {
      await shot(till, `failed-${key}-till.png`).catch(() => {});
      console.log('  till text:', flat(await till.locator('body').innerText().catch(() => '')).replace(new RegExp(staffNames.map(escapeRe).join('|') || '\\b\\B', 'g'), '[staff]').slice(0, 1500));
    }
    if (display) await shot(display.page, `failed-${key}-display.png`).catch(() => {});
    await till.keyboard.press('Escape').catch(() => {});
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
  assert.ok(branch); branchId = branch.id; branchCode = branch.code;
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
  const waitingBefore = (await call('GET', `/checkin/registrations?branchId=${branchId}`)).body.registrations ?? [];
  receipt.checks.waitingBefore = { families: waitingBefore.length, zz: waitingBefore.filter(r => /^ZZ TEST/.test(r.guardianName ?? '')).length };
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  assert.equal(station.name, fixtureName);
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

  browser = await chromium.launch({ channel: 'msedge' });
  // A new browser profile: nothing cached, the bundle is fetched fresh.
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  watch(till, 'till');
  watchIntents(till);
  await till.goto(pos);
  phase('reception account signs in at the own till (new browser profile)');
  await signInAtTill(till, need('STAGING_RECEPTION_PHONE'), need('STAGING_RECEPTION_PASSWORD'));
  const me = await (await till.request.get('/api/me')).json().catch(() => null);
  staffNames = [...new Set([me?.employee?.name, me?.employee?.nickname, me?.account?.name, me?.account?.nickname, me?.name, me?.nickname, me?.displayName, me?.account?.displayName]
    .filter(v => typeof v === 'string' && v.trim().length >= 2).map(v => v.trim()))];
  receipt.checks.staffNameMasks = staffNames.length;
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    const found = { files: urls.length, names: urls.map(u => u.split('/').pop().split('?')[0]), s888CardGrid: 0, firstVisitLine: 0 };
    for (const url of urls) {
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      found.s888CardGrid += text.split('minmax(min-content,1fr)').length - 1;
      found.firstVisitLine += text.split("Thailand's happiest indoor play park").length - 1;
    }
    return found;
  });
  save();
  console.log('bundle', JSON.stringify(receipt.checks.bundle), 'staff name masks', staffNames.length);
  assert.ok(receipt.checks.bundle.s888CardGrid >= 1, 'the till serves the 3f0c082b bundle (SCRUM-888 card grid)');

  if (wanted.includes('a')) await attempt('a', () => passSplit('split1440', 1440, 900, '01'));
  if (wanted.includes('b')) await attempt('b', () => passSplit('split1680', 1680, 1050, '03'));
  if (wanted.includes('t')) await attempt('t', passThai);
  if (wanted.includes('p')) await attempt('p', passPicker);
  if (wanted.includes('d')) await attempt('d', passDisplay);
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
  for (const [key, id] of Object.entries(regs)) await clean(`registration ${key}`, async () => {
    const reg = (await call('GET', `/checkin/registrations/${id}`)).body;
    assert.equal(reg.guardianName, families[key].guardian, 'only this run\'s own booking');
    if (reg.children.some(c => c.status === 'registered')) {
      assert.equal((await call('POST', `/checkin/registrations/${id}/cancel`, { reason: 'ZZ TEST SCRUM-888 proof cleanup' })).status, 200);
    }
    const after = (await call('GET', `/checkin/registrations/${id}`)).body;
    assert.ok(after.children.every(c => c.status === 'cancelled'));
    receipt.cleanup.push({ kind: 'registration', key, id, children: after.children.map(c => c.status) });
  });
  if (station) {
    let ownsStation = false;
    await clean('verify own till', async () => { assert.equal((await call('GET', `/stations/${station.id}`)).body.station.name, fixtureName); ownsStation = true; });
    if (ownsStation) {
      let sales = [];
      await clean('read own sales', async () => { sales = await stationSales(); for (const sale of sales) assert.equal(sale.stationId, station.id); });
      // Only this run's own till, created minutes ago: nothing older than today can be here.
      for (const sale of sales.filter(s => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
        assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        assert.equal((await call('GET', `/sales/${sale.id}`)).body.sale.status, 'voided');
        receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided' });
      });
      await clean('final sales read-back', async () => {
        const final = await stationSales();
        receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map(s => ({ id: s.id, status: s.status })) });
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
      assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null);
      receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true });
    } else receipt.cleanup.push({ kind: 'test-number', key, member: null });
  });
  if (till) await clean('sign out till', async () => {
    const before = (await till.request.get('/api/me')).status();
    if (before === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await till.request.get('/api/me')).status(), 401);
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
