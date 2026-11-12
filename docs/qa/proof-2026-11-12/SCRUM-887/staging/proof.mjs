// SCRUM-887 staging proof: a connection drop during a drop-off registration does not leave the family stuck on the box.
// Adapted from the SCRUM-871 harness (docs/qa/proof-2026-11-12/SCRUM-871/staging/proof.mjs).
// Own ZZ TEST till on the shared virtual box (virtual-1), ZZ TEST guardians and children, invented numbers (08988700xx), cash only.
// The drops are made in the browser (Playwright route.abort('failed')), as the lane's e2e does: nothing on staging is switched off.
// Only what this run made is checked in, released, voided or archived. No credential or raw response body enters the receipt.
//
//   node proof.mjs <sha> <out-dir>        ONLY=1,2,3,5,4b,4a (default all)   ZZ_BASE=10 (numbers base+0 .. base+5)
//
// Run history (each run its own ZZ_BASE, so no invented number is used twice; each archives what it made):
//   01  63f51a2d  all        ZZ_BASE=10  4a PASS; 1, 3, 4b read the online receipt mark (receipt.observed) as a box intent,
//                                        the filter was narrowed after it; 2 refused at the second Continue (receipt-run-01-first-pass.json)
//   02  63f51a2d  all        ZZ_BASE=20  1, 3, 4a, 4b PASS; 2 refused again (receipt-run-02-points-1-3-4.json)
//   03  63f51a2d  ONLY=2     ZZ_BASE=30  2 FAIL: after Continue again the sale went to the box, "box has not received" (receipt-run-03-point-2.json)
//   04  9df18d68  ONLY=2     ZZ_BASE=40  2 PASS on the follow-up fix, the box status read kept unreachable: sale, cash, check-in online (out-run-04/)
//   05  9df18d68  ONLY=5     ZZ_BASE=50  5 PASS, picture 05 redone: refused before payment, Try again, paid once (out-run-05/;
//                                        the composite was moved up to 05-sale-refused-before-payment-then-try-again-paid-once.png)
//   06  9df18d68  ONLY=4b    ZZ_BASE=60  4b PASS, the ordinary online sale again (out-run-06/)
//
// Changed for runs 04-06 (follow-up fix 62ce4943, cc15e99f, 1267c59e, 9df18d68), and why:
//   - point 2 keeps aborting GET /api/box/v1/station/*/status from the restore until after "Check in now" (as the fix's
//     e2e does), so the till cannot hear from its box that the link is back and stays on the box lane through the sale,
//     the cash press and the door choice: the condition run 03 failed in. It waits for the till's first box status read
//     after the restore (the till reads it every 15 s only while it works through its box) before Continue again.
//   - point 2's PASS is the re-proof's list: the give-up says press Continue again; after the second Continue no "This
//     sale has not been saved." and no "rung up on the counter box"; one registration; one sale POST, 200; one cash
//     press, 200; Check in now puts both children in the park, its press answered 200 online; no box intent for the family.
//   - point 5 is new (picture 05 redone): only POST /api/sales aborted for 10 s, so the held retries run out and the sale
//     falls to the box before payment and is refused there; the panel must not carry the "Nothing answered" paragraph;
//     Try again, pressed once the till's lane probe has heard the box say the link is up, writes the same sale online and
//     it is paid once. Its numbers add base+5 (numbers.refused).
//   - the wire also records the door choice (POST /api/checkin/check-in-now, leave-as-booked) and every box status read
//     (its outcome and link.lane only), so the facts can say where the check-in went and how the lane moved.
//   - point 4b needs exactly one sale POST and one cash press, both 200, and one cash payment, besides no box intent.
//   - the bundle check also needs the fix's new strings ("finishing their check-in online", "box-not-synced").
//   - checkInNow(regId, { soft: true }) reports a door press that did not check the children in instead of throwing
//     (points 2 and 5), so the facts are still drawn; `shot` takes a clip, for the cropped panels picture 05 is made of.
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
const T = '887';
const base = Number(process.env.ZZ_BASE ?? 10);
const zz = i => '08988700' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const only = (process.env.ONLY ?? '1,2,3,5,4b,4a').split(',');
const receipt = { ticket: 'SCRUM-887', sha, startedAt: new Date().toISOString(), phase: 'preflight', only,
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], wire: [], probes: [], cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let response = await once();
  if (response.status() === 401) { receipt.checks.adminSignedInAgain = (receipt.checks.adminSignedInAgain ?? 0) + 1; await adminSignIn(); response = await once(); }
  const body = await response.json().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0].replace(ID, ':id'), status: response.status(), ...(response.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: response.status(), body };
};

const numbers = { g1: zz(0), g2: zz(1), g3: zz(2), ordinary: zz(3), offline: zz(4), refused: zz(5) };
receipt.numbers = numbers;
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const RUN = String(process.argv[3] ?? 'out').replace(/\D/g, '') || '00';
const guardianName = tag => `ZZ TEST SCRUM-${T} guardian ${tag}-${RUN}`;
const knownSales = new Set();
let browser = null, till = null, station = null, branchId = null, failed = false;
const regs = []; // { tag, id }
const PHRASES = ['Connection dropped — retrying', 'Member not found', 'rung up on the counter box', "Couldn't register these children", "Couldn't save these children",
  'The connection dropped and has not come back yet', 'This family is already saved online', 'These children are already saved online',
  'box has not received', 'Payment Successful',
  // Run 04: the refusal panel, its no-answer paragraph, the door's refusal, and the fix's retry words.
  'This sale has not been saved.', 'Nothing answered', 'no copy of that child', 'finishing their check-in online', 'finishing this sale online under the same sale number'];

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
const strangers = async page => {
  const onBoard = await page.getByPlaceholder('Search child, parent or phone…').isVisible().catch(() => false);
  return [page.getByRole('dialog').locator('[class*="bg-card"]').filter({ hasNotText: 'ZZ TEST' }),
    ...(onBoard ? [page.locator('[class*="bg-card"]').filter({ hasNotText: 'ZZ TEST' })] : [])];
};
const shot = async (page, name, extra = [], clip = null) => {
  const others = await strangers(page);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', ...(clip ? { clip } : {}),
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
      page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
      page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/),
      ...others, ...extra] });
  console.log('picture', name);
};
/** A masked picture of one element of the till, with a margin. */
const clipShot = async (page, name, locator, pad = 12) => {
  const bb = await locator.boundingBox();
  if (!bb) { console.log('no box for', name); return false; }
  const vp = page.viewportSize();
  const x = Math.max(0, bb.x - pad), y = Math.max(0, bb.y - pad);
  await shot(page, name, [], { x, y, width: Math.min(vp.width - x, bb.width + 2 * pad), height: Math.min(vp.height - y, bb.height + 2 * pad) });
  return true;
};
const point = (key, pass, picture, shows, seen = {}) => { receipt.points[key] = { pass, picture, shows, seen }; save(); console.log('POINT', key, pass === true ? 'PASS' : pass === null ? 'NOT PROVABLE' : 'FAIL', '|', shows); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what); };

/** Every request of interest the till sends, what happened to it, and what came back. */
function watch(page, label) {
  page.on('pageerror', e => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('console', m => { if (m.type() === 'error') receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'console.error', text: m.text().split('\n')[0].slice(0, 240) }); });
  page.on('response', r => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http',
      text: `${r.request().method()} ${u.pathname.replace(ID, ':id')} ${r.status()}` });
  });
  const interesting = (method, path) => method !== 'GET' && (/^\/api\/(members|checkin\/registrations|checkin\/check-in-now|checkin\/leave-as-booked|sales)(\/|$)/.test(path) || /^\/api\/box\/v1\/station\/[^/]+\/intents$/.test(path));
  // Run 04: every box status read (the lane probe): its outcome and link.lane only.
  const isStatus = (method, path) => method === 'GET' && /^\/api\/box\/v1\/station\/[^/]+\/status$/.test(path);
  const describe = r => {
    const u = new URL(r.url());
    let body = null; try { body = r.postDataJSON(); } catch { /* not json */ }
    return { at: receipt.phase, t: Date.now(), method: r.method(), path: u.pathname.replace(ID, ':id'), bodyId: typeof body?.id === 'string' ? body.id : null,
      intent: /intents$/.test(u.pathname) ? (body?.type ?? null) : undefined };
  };
  page.on('requestfinished', async r => {
    const u = new URL(r.url());
    if (isStatus(r.method(), u.pathname)) {
      const res = await r.response().catch(() => null);
      let lane = null; try { lane = (await res?.json())?.link?.lane ?? null; } catch { /* no body */ }
      receipt.probes.push({ at: receipt.phase, t: Date.now(), status: res?.status() ?? null, lane }); save(); return;
    }
    if (!interesting(r.method(), u.pathname)) return;
    const res = await r.response().catch(() => null);
    receipt.wire.push({ ...describe(r), status: res?.status() ?? null }); save();
  });
  page.on('requestfailed', r => {
    const u = new URL(r.url());
    if (isStatus(r.method(), u.pathname)) { receipt.probes.push({ at: receipt.phase, t: Date.now(), failed: r.failure()?.errorText ?? 'failed' }); save(); return; }
    if (!interesting(r.method(), u.pathname)) return;
    receipt.wire.push({ ...describe(r), failed: r.failure()?.errorText ?? 'failed' }); save();
  });
}
const wireFrom = i => receipt.wire.slice(i);
const allBoxIntents = rows => rows.filter(w => /\/api\/box\/v1\/station\/:id\/intents$/.test(w.path));
// The box asked to write or price this family (not the display mirror or the online receipt mark every sale sends).
const boxIntents = rows => allBoxIntents(rows).filter(w => /^(member|child|visit|checkin|waiver|sale|cart)\./.test(w.intent ?? ''));
const regPosts = rows => rows.filter(w => w.method === 'POST' && w.path === '/api/checkin/registrations');
const salePosts = rows => rows.filter(w => w.method === 'POST' && w.path === '/api/sales');
const finalisePosts = rows => rows.filter(w => w.method === 'POST' && /^\/api\/sales\/:id\/finalise$/.test(w.path));
const childPosts = rows => rows.filter(w => w.method === 'POST' && /^\/api\/members\/:id\/children$/.test(w.path));
const memberPosts = rows => rows.filter(w => w.method === 'POST' && w.path === '/api/members');
const doorPosts = rows => rows.filter(w => w.method === 'POST' && /^\/api\/checkin\/(check-in-now|leave-as-booked)$/.test(w.path));
/** What the page has shown since the last reset: the first time each phrase was on screen. */
const seenPhrases = async () => till.evaluate(() => ({ ...(window.__zzPhrases ?? {}) }));
const resetPhrases = async () => till.evaluate(() => { window.__zzPhrases = {}; });

const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const newSales = async () => (await stationSales()).filter(s => !knownSales.has(s.id));
const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const paymentStep = () => till.getByTestId('payment-step');
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const registrationOf = async id => (await call('GET', '/checkin/registrations/' + id)).body;
const memberOf = async phone => (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body?.member ?? null;
const childrenOf = m => (m?.children ?? []).map(c => ({ id: c.id, name: c.name, ageYears: c.ageYears, allergies: c.allergies }));
const countBy = (rows, name) => rows.filter(c => c.name.trim().toLowerCase() === name.toLowerCase()).length;
/** A sale read back from the platform, as the staging admin: status, total, and its payments. */
async function saleOf(id) {
  const r = await call('GET', `/sales/${id}`);
  const sale = r.body?.sale ?? null;
  if (!sale) return { status: r.status };
  const lists = Object.fromEntries(Object.entries({ ...r.body, ...sale }).filter(([k, v]) => Array.isArray(v) && /pay|tender/i.test(k)).map(([k, v]) => [k, v.map(p => ({ method: p.method ?? p.kind ?? p.type ?? null, amountSatang: p.amountSatang ?? p.amount ?? null, status: p.status ?? null }))]));
  const provenance = Object.fromEntries(Object.entries(sale).filter(([k, v]) => /lane|origin|source|box|journal|channel/i.test(k) && (v === null || typeof v !== 'object')));
  return { bodyKeys: Object.keys(r.body), arrays: Object.fromEntries(Object.entries(r.body).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])), totals: sale.totals ?? null, id: sale.id, status: sale.status, grossSatang: sale.totals?.grossSatang ?? null, receiptNumber: sale.receiptNumber ? 'present' : null, stationIsOwn: sale.stationId === station.id, payments: lists, paymentAttempts: (r.body.attempts ?? []).map(a => ({ method: a.method ?? a.kind ?? null, status: a.status ?? null, amountSatang: a.amountSatang ?? null })), provenance, printJobs: (r.body.printJobs ?? []).map(j => j.status) };
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

async function home() {
  await till.goto('/');
  await landing(till).waitFor();
  if (await till.getByTestId('language-choice').isVisible()) await till.getByTestId('language-choice-en').click();
  await till.getByTestId('identify-safety').waitFor();
}
async function typeNumberWalkIn(number) {
  const scope = halfOf(till.getByTestId('identify-safety'));
  await keypad(scope, number);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  await expect(offer).toContainText(spaced(number), { timeout: 30000 });
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
}
async function walkIn(number) { await home(); await typeNumberWalkIn(number); }
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
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 30000 });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click();
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 60000 });
}
async function saleWritten(kind, timeout = 45000) {
  let sale;
  await expect.poll(async () => { sale = (await newSales()).find(x => ['tendering', 'open', 'finalised'].includes(x.status)); return Boolean(sale); }, { timeout }).toBe(true);
  receipt.created.push({ kind, id: sale.id }); save();
  return sale;
}
async function checkInNow(regId, { soft = false } = {}) {
  const now = till.getByRole('button', { name: 'Check in now', exact: true });
  await now.waitFor({ timeout: 15000 }).catch(() => {});
  if (!(await now.isVisible().catch(() => false))) { odd('no "Check in now" after payment'); return false; }
  await now.click();
  const inPark = expect.poll(async () => (await registrationOf(regId)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
  if (!soft) await inPark;
  else if (!(await inPark.then(() => true, () => false))) { odd('"Check in now" did not put the children in the park within 30 s', { phrases: Object.keys(await seenPhrases()) }); return false; }
  await till.waitForTimeout(1200);
  return true;
}
async function fillGate(children, parent) {
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
  for (const checkbox of await half.getByRole('checkbox').all()) await checkbox.check();
  return half;
}
const continueButton = () => till.getByRole('button', { name: 'Continue to payment', exact: true });
const isRegistrationPost = r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST';
async function toastText(pattern, timeout = 30000) {
  const title = till.getByText(pattern).first();
  await title.waitFor({ timeout });
  const li = title.locator('xpath=ancestor::li[1]');
  return flat(await ((await li.count()) ? li : title.locator('xpath=..')).innerText()).slice(0, 500);
}
/** A picture of what the platform holds after a point, drawn from the admin reads. */
async function factsPicture(name, title, facts, rows = []) {
  const page = await browser.newPage({ viewport: { width: 1250, height: 500 } });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:24px;background:#fff;color:#111"><h2>${esc(title)}</h2>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${facts.map(([k, v]) => `<tr><th style="text-align:left;vertical-align:top;white-space:nowrap">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    ${rows.length ? `<h3>Children on the guardian (platform)</h3><table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px"><tr><th>#</th><th>Child id</th><th>Name</th><th>Age</th><th>Allergies</th></tr>
    ${rows.map((c, i) => `<tr><td>${i + 1}</td><td style="font-family:monospace">${esc(c.id)}</td><td>${esc(c.name)}</td><td>${esc(c.ageYears)}</td><td>${esc(c.allergies)}</td></tr>`).join('')}</table>` : ''}
    <p style="color:#555">Read on the platform as the staging admin (GET /api/members/lookup, /api/checkin/registrations/:id, /api/sales/:id), ${esc(new Date().toISOString())}. Wire counts are the till browser's own requests.</p></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  console.log('picture', name);
}
const wireLine = rows => rows.map(w => `${w.method} ${w.path}${w.intent ? ' [' + w.intent + ']' : ''} ${w.failed ? 'ABORTED' : w.status}`).join('; ');

/** One drop-off family: walk-in, children only, form filled. */
async function familyAtForm(phone, tag, kids) {
  await walkIn(phone);
  await ticket(kids.length, 0);
  await fillGate(kids, guardianName(tag));
}
/** After the press reached payment: pay cash, check the children in, read everything back. */
async function payAndRead({ tag, phone, wire0, regId, kids, shotPaid, onBox = false, shotCheckedIn = null, clipPaid = null, soft = false }) {
  let sale;
  if (onBox) {
    // Rung up on the box: the platform sees the sale once the box hands it over after the cash press.
    await payCash();
    await till.waitForTimeout(1500);
    await shot(till, shotPaid);
    sale = await saleWritten(`dropoff-sale-${tag}`, 180000);
  } else {
    sale = await saleWritten(`dropoff-sale-${tag}`);
    await payCash();
    await till.waitForTimeout(1500);
    await shot(till, shotPaid);
  }
  if (clipPaid) {
    const bb = await till.getByText('Payment Successful', { exact: true }).boundingBox().catch(() => null);
    if (bb) await shot(till, clipPaid, [], { x: 0, y: Math.max(0, bb.y - 140), width: 610, height: 260 });
  }
  knownSales.add(sale.id);
  const checkedIn = await checkInNow(regId, { soft });
  if (shotCheckedIn) { await till.waitForTimeout(800); await shot(till, shotCheckedIn); }
  const rows = childrenOf(await memberOf(phone));
  const reg = await registrationOf(regId);
  const sold = await saleOf(sale.id);
  const wire = wireFrom(wire0);
  const seen = {
    sale: sold,
    registration: { id: regId, children: reg.children.map(c => ({ name: c.childName, linked: rows.some(r => r.id === c.childId), status: c.status })) },
    memberChildren: rows, checkedIn,
    wire: { memberPosts: memberPosts(wire).length, childPosts: childPosts(wire).map(w => ({ id: w.bodyId, status: w.status ?? w.failed })), regPosts: regPosts(wire).map(w => ({ id: w.bodyId, outcome: w.failed ? 'aborted' : w.status })),
      salePosts: salePosts(wire).map(w => ({ id: w.bodyId, outcome: w.failed ? 'aborted' : w.status })), finalisePosts: finalisePosts(wire).map(w => ({ outcome: w.failed ? 'aborted' : w.status })), doorPosts: doorPosts(wire).map(w => ({ path: w.path, outcome: w.failed ? 'aborted' : w.status })), boxIntents: boxIntents(wire).map(w => `${w.intent} ${w.failed ? 'aborted' : w.status}`), otherBoxIntents: allBoxIntents(wire).filter(w => !boxIntents([w]).length).map(w => w.intent) },
    phrases: await seenPhrases(),
  };
  const kidsOnce = kids.every(k => countBy(rows, k.name) === 1) && rows.length === kids.length;
  return { sale, sold, rows, reg, seen, kidsOnce };
}
/** The sales on the own till that belong to this point (not made by an earlier point). */
const salesOfPoint = async tag => (await stationSales()).filter(s => !receipt.created.some(c => c.id === s.id && c.kind !== `dropoff-sale-${tag}`));

// ---- 1: the original case — the registration request is aborted for a few seconds, then let through ----
async function point1() {
  const tag = 'g1', phone = numbers.g1;
  const kids = [{ name: 'ZZ TEST Bua 887', age: 6, allergies: 'ZZ TEST peanuts' }, { name: 'ZZ TEST Nok 887', age: 9 }];
  phase('1: walk-in, two children no adult, drop-off form filled');
  await familyAtForm(phone, tag, kids);
  await shot(till, '01a-dropoff-form-filled.png');
  phase('1: Continue — the registration request reaches nothing (network abort) for 2.5 s, then goes through');
  let windowStart = null, aborted = 0;
  const matcher = url => new URL(url).pathname === '/api/checkin/registrations';
  const handler = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    windowStart ??= Date.now();
    if (Date.now() - windowStart < 2500) { aborted += 1; return route.abort('failed'); }
    return route.continue();
  };
  await till.route(matcher, handler);
  await resetPhrases();
  const wire0 = receipt.wire.length;
  const registered = till.waitForResponse(r => isRegistrationPost(r) && r.status() === 200, { timeout: 90000 });
  await continueButton().click();
  const retrying = await toastText(/Connection dropped — retrying/, 20000);
  await shot(till, '01b-connection-dropped-retrying.png');
  const reg = await (await registered).json();
  regs.push({ tag, id: reg.id }); receipt.created.push({ kind: 'registration', tag, id: reg.id }); save();
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  await till.waitForTimeout(1200);
  await shot(till, '01c-payment-reached-online.png');
  await till.unroute(matcher, handler);
  const r = await payAndRead({ tag, phone, wire0, regId: reg.id, kids, shotPaid: '01d-paid-cash.png' });
  const ids = new Set(r.seen.wire.regPosts.map(p => p.id));
  const ownSales = await salesOfPoint(tag);
  const ok = aborted >= 2 && Boolean(r.seen.phrases['Connection dropped — retrying']) && !r.seen.phrases['Member not found'] && !r.seen.phrases['rung up on the counter box']
    && ids.size === 1 && ids.has(reg.id) && r.seen.wire.boxIntents.length === 0 && r.sold.status === 'finalised' && r.sold.stationIsOwn && r.kidsOnce
    && r.seen.registration.children.length === 2 && r.seen.registration.children.every(c => c.linked) && ownSales.length === 1;
  await factsPicture('01-platform-readback-one-registration-sale-on-platform.png', 'SCRUM-887 point 1 — registration request aborted for 2.5 s, then let through', [
    ['Family', `${guardianName(tag)} (${phone}), walk-in, two children no adult`],
    ['Registration POSTs', `${r.seen.wire.regPosts.length} sent (${r.seen.wire.regPosts.map(p => p.outcome).join(', ')}), all with the same id: ${ids.size === 1 ? 'yes' : 'NO'} (${[...ids].join(', ')})`],
    ['Till said', retrying],
    ['"Member not found" on screen', r.seen.phrases['Member not found'] ? 'YES' : 'never'],
    ['Box intents sent by the till', r.seen.wire.boxIntents.length ? r.seen.wire.boxIntents.join(', ') : 'none (the box was never asked)'],
    ['Registration on the platform', `${reg.id}: ${r.seen.registration.children.map(c => `${c.name} ${c.status}${c.linked ? ' (linked to the guardian\'s child)' : ' (NOT linked)'}`).join('; ')}`],
    ['Sales on the own till for this family', ownSales.map(s => `${s.id} ${s.status}`).join('; ')],
    ['Sale on the platform', `${r.sold.id}: ${r.sold.status}, ${(r.sold.grossSatang ?? 0) / 100} THB, payments ${JSON.stringify(r.sold.payments)}, own till ${r.sold.stationIsOwn}`],
    ['Sale writes', `commit ${r.seen.wire.salePosts.map(p => p.outcome).join(', ')}; finalise ${r.seen.wire.finalisePosts.map(p => p.outcome).join(', ')}`],
  ], r.rows);
  point('1', ok, '01-platform-readback-one-registration-sale-on-platform.png', `Registration aborted ${aborted}x over 2.5 s: the till said "Connection dropped — retrying" (no "Member not found"), the same registration id went through on the platform, no box intent, sale finalised in cash on the platform, the guardian holds one Bua and one Nok`, { aborted, retrying, ...r.seen, ownSales: ownSales.map(s => ({ id: s.id, status: s.status })) });
}

// ---- 2: the link stays down longer than the retries ----
// Run 04: from the restore until after "Check in now" the till's box status read is aborted too (the fix's e2e does the
// same): the till cannot hear from its box that the link is back, so it stays on the box lane through the sale, the cash
// press and the door choice, the condition run 03 failed in. The till reads that status every 15 s only while it works
// through its box, so one read after the restore is waited for before Continue is pressed again.
async function point2() {
  const tag = 'g2', phone = numbers.g2;
  const kids = [{ name: 'ZZ TEST Mali 887', age: 7 }, { name: 'ZZ TEST Ton 887', age: 8 }];
  phase('2: walk-in, two children no adult, drop-off form filled');
  await familyAtForm(phone, tag, kids);
  phase('2: Continue — from the registration request on, every /api request reaches nothing until the till gives up');
  let down = false, downAt = null, tripped = false, abortedRegs = 0, abortedOther = 0;
  const handler = async route => {
    const req = route.request();
    const isReg = new URL(req.url()).pathname === '/api/checkin/registrations' && req.method() === 'POST';
    if (!tripped && isReg) { tripped = true; down = true; downAt = Date.now(); }
    if (down) { if (isReg) abortedRegs += 1; else abortedOther += 1; return route.abort('failed'); }
    return route.continue();
  };
  await till.route('**/api/**', handler);
  await resetPhrases();
  const wire0 = receipt.wire.length;
  await continueButton().click();
  const retrying = await toastText(/Connection dropped — retrying/, 20000).catch(() => null);
  if (retrying) await shot(till, '02a-connection-dropped-retrying.png');
  const gaveUp = await toastText(/Couldn't register these children/, 40000);
  const gaveUpAfterMs = Date.now() - downAt;
  await till.waitForTimeout(800);
  await shot(till, '02b-gave-up-press-continue-again.png');
  const atGiveUp = { member: childrenOf(await memberOf(phone)), onPayment: await paymentStep().isVisible().catch(() => false), sales: (await newSales()).map(s => s.status), phrases: Object.keys(await seenPhrases()) };
  phase('2: link restored for the till; its box status read still reaches nothing, so the lane stays on the box');
  const statusTimes = [];
  const statusMatcher = url => /^\/api\/box\/v1\/station\/[^/]+\/status$/.test(new URL(url).pathname);
  const statusHandler = route => { statusTimes.push(Date.now()); return route.abort('failed'); };
  await till.route(statusMatcher, statusHandler);
  down = false;
  await till.unroute('**/api/**', handler);
  const restoredAt = Date.now();
  const laneProbed = await expect.poll(() => statusTimes.length, { timeout: 40000 }).toBeGreaterThan(0).then(() => true, () => false);
  if (!laneProbed) odd('point 2: the till read no box status within 40 s of the restore, so it may not be on the box lane');
  await till.waitForTimeout(1000);
  phase('2: Continue pressed again, the lane still the box\'s');
  await resetPhrases();
  const regsBefore = regPosts(wireFrom(wire0)).length;
  const againAt = Date.now();
  const [registered] = await Promise.all([till.waitForResponse(r => isRegistrationPost(r) && r.status() === 200, { timeout: 60000 }), continueButton().click()]);
  const reg = await registered.json();
  regs.push({ tag, id: reg.id }); receipt.created.push({ kind: 'registration', tag, id: reg.id }); save();
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  // Either the sale is written online, or the payment step shows a refusal: wait for one of them.
  const notice = till.getByText('This sale has not been saved.', { exact: false });
  const rungUp = till.getByText('This sale was rung up on the counter box', { exact: false });
  let refused = null, onBox = false, recovery = { tryAgainPresses: 0, recoveredAfterMs: null };
  await expect.poll(async () => (await notice.isVisible().catch(() => false)) || (await rungUp.isVisible().catch(() => false)) || (await newSales()).length > 0, { timeout: 60000 }).toBe(true);
  if (await rungUp.isVisible().catch(() => false)) {
    onBox = true;
    refused = 'rung up on the counter box: ' + flat(await rungUp.innerText().catch(() => '')).slice(0, 300);
    odd('point 2: after the restore and the second Continue, the drop-off sale was rung up on the box, not online', { boxIntentsSoFar: allBoxIntents(wireFrom(wire0)).map(w => `${w.intent} ${w.failed ?? w.status}`) });
    await shot(till, '02c-sale-rung-up-on-box.png');
  } else if (await notice.isVisible().catch(() => false)) {
    const box = notice.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
    refused = flat(await box.innerText().catch(() => '')).slice(0, 700);
    odd('point 2: after the restore and the second Continue, the sale went to the box and was refused', { refused, boxIntentsSoFar: allBoxIntents(wireFrom(wire0)).map(w => `${w.intent} ${w.failed ?? w.status}`) });
    await shot(till, '02c-sale-refused-box-not-synced.png');
    // Recovery as staff would: press the notice's own Try again every 15 s, up to 3 minutes.
    const startedAt = Date.now();
    while (Date.now() - startedAt < 180000 && (await newSales()).length === 0) {
      await till.waitForTimeout(15000);
      const again = till.getByRole('button', { name: 'Try again', exact: true }).first();
      if (await again.isVisible().catch(() => false)) { await again.click(); recovery.tryAgainPresses += 1; await till.waitForTimeout(4000); }
    }
    if ((await newSales()).length > 0) recovery.recoveredAfterMs = Date.now() - startedAt;
    recovery.screen = flat(await notice.isVisible().catch(() => false) ? await notice.locator('xpath=ancestor::div[contains(@class, "rounded")][1]').innerText().catch(() => '') : 'notice gone').slice(0, 400);
    await shot(till, '02d-after-try-again.png');
    receipt.checks.point2Recovery = recovery; save();
  } else {
    await till.waitForTimeout(1200);
    await shot(till, '02c-second-continue-payment-online.png');
  }
  const r = await payAndRead({ tag, phone, wire0, regId: reg.id, kids, shotPaid: '02d-paid-cash-online.png', shotCheckedIn: '02e-checked-in-online.png', onBox, soft: true });
  const statusAfterRestore = statusTimes.map(t => ((t - restoredAt) / 1000).toFixed(1));
  await till.unroute(statusMatcher, statusHandler);
  phase('2: the box status read let through again');
  const ids = new Set(r.seen.wire.regPosts.map(p => p.id));
  const ownSales = await salesOfPoint(tag);
  const sales = r.seen.wire.salePosts, cash = r.seen.wire.finalisePosts, door = r.seen.wire.doorPosts;
  const attempts = r.sold.paymentAttempts ?? [];
  const checks = {
    gaveUpSaysPressContinueAgain: /The connection dropped and has not come back yet/.test(gaveUp) && /press Continue again/.test(gaveUp),
    tillOnBoxLaneAtSecondContinue: laneProbed,
    noRefusalAfterSecondContinue: !refused && !onBox && !r.seen.phrases['This sale has not been saved.'] && !r.seen.phrases['rung up on the counter box'],
    oneRegistration: ids.size === 1 && ids.has(reg.id) && r.seen.wire.regPosts.filter(p => p.outcome === 200).length === 1,
    oneSalePost200Online: sales.length === 1 && sales[0].outcome === 200 && ownSales.length === 1 && r.sold.status === 'finalised' && r.sold.stationIsOwn,
    oneCashPress200: cash.length === 1 && cash[0].outcome === 200 && attempts.length === 1 && attempts[0].method === 'cash' && attempts[0].status === 'approved',
    checkInNowBothInPark: r.seen.checkedIn && r.seen.registration.children.length === 2 && r.seen.registration.children.every(c => c.status === 'in_park' && c.linked),
    checkInNowPressOnline200: door.length === 1 && door[0].outcome === 200,
    noBoxIntentForThisFamily: r.seen.wire.boxIntents.length === 0,
    familyHeldOnce: r.kidsOnce && atGiveUp.member.length === 2,
    noMemberNotFoundNoCopy: !atGiveUp.phrases.includes('Member not found') && !r.seen.phrases['Member not found'] && !r.seen.phrases['no copy of that child'],
  };
  const ok = Object.values(checks).every(Boolean);
  await factsPicture('02-platform-readback-sale-cash-checkin-online.png', 'SCRUM-887 point 2 (run 04, 9df18d68) — link down past the retries; restored with the box status still unreachable; Continue again', [
    ['Family', `${guardianName(tag)} (${phone}), walk-in, two children no adult`],
    ['While down', `every /api request aborted from the registration request on: ${abortedRegs} registration tries, ${abortedOther} other requests; the till gave up after ${(gaveUpAfterMs / 1000).toFixed(1)} s`],
    ['First toast', retrying ?? '(not caught)'],
    ['Gave-up toast', gaveUp],
    ['At the give-up', `children on the guardian ${atGiveUp.member.length}; payment step ${atGiveUp.onPayment ? 'SHOWN' : 'not shown'}; sales ${atGiveUp.sales.length}`],
    ['After the restore', `the till's box status read aborted ${statusTimes.length}x, at +${statusAfterRestore.join(' s, +') || '-'} s (the till reads it every 15 s only while it works through its box); Continue pressed again at +${((againAt - restoredAt) / 1000).toFixed(1)} s`],
    ['Registration POSTs', `${r.seen.wire.regPosts.length} (${r.seen.wire.regPosts.map(p => p.outcome).join(', ')}), ${regsBefore} before the restore; one id: ${ids.size === 1 ? 'yes' : 'NO'} (${[...ids].join(', ')})`],
    ['Member / child creates', `${r.seen.wire.memberPosts} member, ${r.seen.wire.childPosts.length} child (${r.seen.wire.childPosts.map(p => p.status).join(', ')})`],
    ['Sale POSTs', `${sales.length}: ${sales.map(p => `${p.id} ${p.outcome}`).join(', ') || 'none'}`],
    ['Cash presses', `${cash.length}: ${cash.map(p => p.outcome).join(', ') || 'none'}; payments on the sale: ${attempts.map(a => `${a.method} ${a.status} ${(a.amountSatang ?? 0) / 100} THB`).join(', ') || 'none'}`],
    ['Check in now', `${door.length} press (${door.map(p => `${p.path} ${p.outcome}`).join(', ') || 'none'}); registration ${reg.id}: ${r.seen.registration.children.map(c => `${c.name} ${c.status}${c.linked ? ' (linked)' : ' (NOT linked)'}`).join('; ')}`],
    ['Box intents for this family', r.seen.wire.boxIntents.length ? r.seen.wire.boxIntents.join(', ') : `none (other box calls: ${r.seen.wire.otherBoxIntents.join(', ') || 'none'})`],
    ['On screen after the second Continue', Object.keys(r.seen.phrases).join(', ') || 'none of the watched phrases'],
    ['Sales on the own till for this family', `${ownSales.map(s => `${s.id} ${s.status}`).join('; ')}; ${r.sold.status}, ${(r.sold.grossSatang ?? 0) / 100} THB`],
    ['Sale refused at payment', refused ? `YES — ${refused}` : 'no'],
    ['Checks', Object.entries(checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; ')],
  ], r.rows);
  point('2', ok, '02-platform-readback-sale-cash-checkin-online.png', 'Link down past the retries: the till said press Continue again; restored with the box status still unreachable (box lane): the registration, the sale, the cash press and Check in now all went online, once each; no box intent; both children in the park', { checks, abortedRegs, abortedOther, gaveUpAfterMs, retrying, gaveUp, atGiveUp, statusAfterRestore, laneProbed, secondContinueAfterRestoreMs: againAt - restoredAt, refused, onBox, recovery, ...r.seen, ownSales: ownSales.map(s => ({ id: s.id, status: s.status })) });
}

// ---- 3: a drop at the payment step right after the form: the sale commit and the cash press are each aborted once ----
async function point3() {
  const tag = 'g3', phone = numbers.g3;
  const kids = [{ name: 'ZZ TEST Pim 887', age: 6 }, { name: 'ZZ TEST Fah 887', age: 9 }];
  phase('3: walk-in, two children no adult, drop-off form filled');
  await familyAtForm(phone, tag, kids);
  phase('3: Continue — the sale commit (POST /api/sales) is aborted once');
  let commitAborted = 0, finaliseAborted = 0, abortFinalise = false;
  const handler = async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && path === '/api/sales' && commitAborted === 0) { commitAborted += 1; return route.abort('failed'); }
    if (req.method() === 'POST' && /^\/api\/sales\/[^/]+\/finalise$/.test(path) && abortFinalise && finaliseAborted === 0) { finaliseAborted += 1; return route.abort('failed'); }
    return route.continue();
  };
  await till.route('**/api/sales**', handler);
  await resetPhrases();
  const wire0 = receipt.wire.length;
  const [registered] = await Promise.all([till.waitForResponse(r => isRegistrationPost(r) && r.status() === 200, { timeout: 60000 }), continueButton().click()]);
  const reg = await registered.json();
  regs.push({ tag, id: reg.id }); receipt.created.push({ kind: 'registration', tag, id: reg.id }); save();
  const retrying = await toastText(/Connection dropped — retrying/, 20000).catch(() => null);
  if (retrying) await shot(till, '03a-sale-connection-dropped-retrying.png');
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  await till.waitForTimeout(1500);
  await shot(till, '03b-payment-step-online.png');
  phase('3: the cash press (POST /api/sales/:id/finalise) is aborted once too');
  abortFinalise = true;
  const r = await payAndRead({ tag, phone, wire0, regId: reg.id, kids, shotPaid: '03c-paid-cash-once.png' });
  await till.unroute('**/api/sales**', handler);
  const saleIds = new Set(r.seen.wire.salePosts.map(p => p.id));
  const ownSales = await salesOfPoint(tag);
  const okFinalise = r.seen.wire.finalisePosts.filter(p => p.outcome === 200).length;
  const paymentsCount = r.sold.paymentAttempts.length;
  const ok = commitAborted === 1 && Boolean(retrying) && saleIds.size === 1 && saleIds.has(r.sale.id) && r.seen.wire.salePosts.length === 2
    && r.sold.status === 'finalised' && ownSales.length === 1 && r.seen.wire.boxIntents.length === 0 && !r.seen.phrases['Member not found'] && r.kidsOnce
    && finaliseAborted === 1 && okFinalise === 1 && paymentsCount === 1;
  await factsPicture('03-platform-readback-same-sale-paid-once.png', 'SCRUM-887 point 3 — the sale commit aborted once right after the form, the cash press aborted once', [
    ['Family', `${guardianName(tag)} (${phone}), walk-in, two children no adult`],
    ['Till said', retrying ?? '(no retry toast caught)'],
    ['Sale commit POSTs', `${r.seen.wire.salePosts.length} (${r.seen.wire.salePosts.map(p => p.outcome).join(', ')}), sale ids sent: ${[...saleIds].join(', ')}`],
    ['Cash press POSTs', `${r.seen.wire.finalisePosts.length} (${r.seen.wire.finalisePosts.map(p => p.outcome).join(', ')})`],
    ['Box intents', r.seen.wire.boxIntents.length ? r.seen.wire.boxIntents.join(', ') : 'none'],
    ['Sales on the own till for this family', ownSales.map(s => `${s.id} ${s.status}`).join('; ')],
    ['Sale on the platform', `${r.sold.id}: ${r.sold.status}, ${(r.sold.grossSatang ?? 0) / 100} THB, receipt number ${r.sold.receiptNumber}, payments ${JSON.stringify(r.sold.payments)}`],
    ['Registration', `${reg.id}: ${r.seen.registration.children.map(c => `${c.name} ${c.status}`).join('; ')}`],
  ], r.rows);
  point('3', ok, '03-platform-readback-same-sale-paid-once.png', 'The sale commit right after the form was aborted once: the till said "Connection dropped — retrying" and wrote the same sale id online; the cash press, aborted once, was retried online; one sale, finalised, paid once, no box intent', { commitAborted, finaliseAborted, retrying, ...r.seen, ownSales: ownSales.map(s => ({ id: s.id, status: s.status })), paymentsCount });
}

// ---- 5: the sale refused before payment, then Try again (run 05: picture 05 redone on the follow-up fix) ----
// Only POST /api/sales is aborted, for 10 s from its first try: the held retries (1 s, 2 s, 4 s) run out, the sale falls
// to the counter's box, which has not pulled the family the gate wrote seconds before, and is refused before payment.
// The box answered, so the panel must not carry the "Nothing answered" paragraph. Try again is pressed once the till's
// lane probe has heard the box say the link is up, so the same sale is written online; it is then paid once in cash.
/** One picture of a point: masked crops of the till side by side, and the platform's facts under them. */
async function storyPicture(name, title, images, facts) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 600 } });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const figures = images.filter(i => existsSync(resolve(out, i.file))).map(i => `<figure style="margin:0 20px 12px 0;display:inline-block;vertical-align:top;max-width:${i.width ?? 600}px">
    <img src="data:image/png;base64,${readFileSync(resolve(out, i.file)).toString('base64')}" style="max-width:100%;border:1px solid #bbb">
    <figcaption style="font-size:14px;color:#222;margin-top:6px;max-width:${i.width ?? 600}px">${esc(i.caption)}</figcaption></figure>`).join('');
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:24px;background:#fff;color:#111"><h2 style="margin-top:0">${esc(title)}</h2><div>${figures}</div>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px;margin-top:8px">${facts.map(([k, v]) => `<tr><th style="text-align:left;vertical-align:top;white-space:nowrap">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <p style="color:#555">The crops are the till's own screen (1680 x 1100), staff name masked. Facts read on the platform as the staging admin (GET /api/sales/:id, /api/checkin/registrations/:id), ${esc(new Date().toISOString())}; request counts are the till browser's own requests.</p></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  console.log('picture', name);
}
async function point5() {
  const tag = 'g5', phone = numbers.refused;
  const kids = [{ name: 'ZZ TEST Dao 887', age: 6 }, { name: 'ZZ TEST Kai 887', age: 8 }];
  phase('5: walk-in, two children no adult, drop-off form filled');
  await familyAtForm(phone, tag, kids);
  phase('5: Continue — only POST /api/sales reaches nothing, for 10 s from its first try');
  const WINDOW_MS = 10000;
  let windowStart = null, aborted = 0, letThrough = 0;
  const salesMatcher = url => new URL(url).pathname === '/api/sales';
  const handler = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    windowStart ??= Date.now();
    if (Date.now() - windowStart < WINDOW_MS) { aborted += 1; return route.abort('failed'); }
    letThrough += 1; return route.continue();
  };
  await till.route(salesMatcher, handler);
  await resetPhrases();
  const wire0 = receipt.wire.length, probes0 = receipt.probes.length;
  const [registered] = await Promise.all([till.waitForResponse(r => isRegistrationPost(r) && r.status() === 200, { timeout: 60000 }), continueButton().click()]);
  const reg = await registered.json();
  regs.push({ tag, id: reg.id }); receipt.created.push({ kind: 'registration', tag, id: reg.id }); save();
  const retrying = await toastText(/Connection dropped — retrying/, 20000).catch(() => null);
  if (retrying) await shot(till, '05a-sale-connection-dropped-retrying.png');
  const notice = till.getByText('This sale has not been saved.', { exact: false });
  const rungUp = till.getByText('This sale was rung up on the counter box', { exact: false });
  const shown = async () => (await notice.isVisible().catch(() => false)) ? 'refused' : (await rungUp.isVisible().catch(() => false)) ? 'rung-up-on-box' : (await newSales()).length > 0 ? 'written-online' : null;
  await expect.poll(shown, { timeout: 60000 }).not.toBeNull();
  const refusedAt = Date.now();
  const outcome = await shown();
  const salesAtRefusal = (await newSales()).length;
  await till.waitForTimeout(800); // the box's answer is on the wire record
  const boxAtRefusal = boxIntents(wireFrom(wire0)).map(w => `${w.intent} ${w.failed ? 'aborted' : w.status}`);
  let panelText = null, onBox = outcome === 'rung-up-on-box';
  const tryAgain = { laneBackAfterMs: null, pressedAfterMs: null, outcome: null };
  if (outcome === 'refused') {
    const panel = notice.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
    panelText = flat(await panel.innerText().catch(() => '')).slice(0, 900);
    await shot(till, '05b-refused-before-payment.png');
    await clipShot(till, '05b-refused-before-payment-panel.png', panel);
    phase('5: refused before payment; waiting for the till to hear from its box that the link is up');
    const back = () => receipt.probes.slice(probes0).find(p => p.t > refusedAt && p.lane === 'platform');
    const laneBack = await expect.poll(() => Boolean(back()), { timeout: 60000, intervals: [1000] }).toBe(true).then(() => true, () => false);
    if (!laneBack) odd('point 5: no box status read answered "platform" within 60 s of the refusal');
    else tryAgain.laneBackAfterMs = back().t - refusedAt;
    await till.waitForTimeout(2500); // after the box's answer the till reads /me before it moves back
    phase('5: Try again');
    tryAgain.pressedAfterMs = Date.now() - refusedAt;
    await till.getByRole('button', { name: 'Try again', exact: true }).first().click();
    const afterAgain = async () => (await newSales()).length > 0 ? 'written-online' : (await rungUp.isVisible().catch(() => false)) ? 'rung-up-on-box' : null;
    await expect.poll(afterAgain, { timeout: 45000 }).not.toBeNull().catch(() => {});
    tryAgain.outcome = (await afterAgain()) ?? `nothing within 45 s; panel: ${flat(await notice.isVisible().catch(() => false) ? await panel.innerText().catch(() => '') : 'gone').slice(0, 300)}`;
    if (tryAgain.outcome === 'rung-up-on-box') { onBox = true; odd('point 5: Try again rang the sale up on the box, not online'); }
    await till.waitForTimeout(1500);
    await shot(till, '05c-after-try-again-sale-online.png');
  } else {
    odd(`point 5: the sale was not refused before payment (${outcome})`, { boxAtRefusal });
    await shot(till, `05x-${outcome}.png`);
  }
  await till.unroute(salesMatcher, handler);
  const r = await payAndRead({ tag, phone, wire0, regId: reg.id, kids, shotPaid: '05d-paid-cash-once.png', clipPaid: '05d-paid-cash-once-clip.png', shotCheckedIn: '05e-checked-in.png', onBox, soft: true });
  const ids = new Set(r.seen.wire.regPosts.map(p => p.id));
  const ownSales = await salesOfPoint(tag);
  const sales = r.seen.wire.salePosts, cash = r.seen.wire.finalisePosts, door = r.seen.wire.doorPosts;
  const saleIds = new Set(sales.map(p => p.id));
  const attempts = r.sold.paymentAttempts ?? [];
  const checks = {
    refusedBeforePayment: outcome === 'refused' && salesAtRefusal === 0 && aborted >= 4,
    boxAnsweredNotReceived: /has not received their record yet/.test(panelText ?? '') && boxAtRefusal.some(i => / 4\d\d$/.test(i)),
    noNothingAnsweredParagraph: outcome === 'refused' && !/Nothing answered/.test(panelText ?? '') && !r.seen.phrases['Nothing answered'],
    tryAgainWroteSameSaleOnline: tryAgain.outcome === 'written-online' && saleIds.size === 1 && saleIds.has(r.sale.id) && sales.filter(p => p.outcome === 200).length === 1 && ownSales.length === 1 && r.sold.stationIsOwn,
    paidOnceInCash: r.sold.status === 'finalised' && cash.length === 1 && cash[0].outcome === 200 && attempts.length === 1 && attempts[0].method === 'cash' && attempts[0].status === 'approved',
    checkInNowBothInPark: r.seen.checkedIn && r.seen.registration.children.length === 2 && r.seen.registration.children.every(c => c.status === 'in_park' && c.linked),
    oneRegistration: ids.size === 1 && ids.has(reg.id),
    neverRungUpOnBox: !onBox && !r.seen.phrases['rung up on the counter box'],
    familyHeldOnce: r.kidsOnce,
  };
  const ok = Object.values(checks).every(Boolean);
  const facts = [
    ['Family', `${guardianName(tag)} (${phone}), walk-in, two children no adult`],
    ['How', `only POST /api/sales aborted, for ${WINDOW_MS / 1000} s from its first try: ${aborted} aborted (Pay and its held retries), ${letThrough} let through after`],
    ['Retry toast', retrying ?? '(not caught)'],
    ['Before payment', outcome === 'refused' ? `refused; sales on the platform at that moment: ${salesAtRefusal}; the box was asked: ${boxAtRefusal.join(', ') || 'nothing'}` : `NOT refused: ${outcome}`],
    ['Refusal panel', panelText ?? '(none)'],
    ['"Nothing answered" paragraph', panelText === null ? '-' : /Nothing answered/.test(panelText) ? 'PRESENT' : 'absent'],
    ['Try again', outcome === 'refused' ? `the till's box status read answered "platform" at +${tryAgain.laneBackAfterMs === null ? '?' : (tryAgain.laneBackAfterMs / 1000).toFixed(1)} s; pressed at +${(tryAgain.pressedAfterMs / 1000).toFixed(1)} s; ${tryAgain.outcome}` : '-'],
    ['Sale POSTs', `${sales.length}: ${sales.map(p => p.outcome).join(', ')}; one sale id: ${saleIds.size === 1 ? 'yes' : 'NO'} (${[...saleIds].join(', ')})`],
    ['Cash presses', `${cash.length}: ${cash.map(p => p.outcome).join(', ') || 'none'}; payments on the sale: ${attempts.map(a => `${a.method} ${a.status} ${(a.amountSatang ?? 0) / 100} THB`).join(', ') || 'none'}`],
    ['Sale on the platform', `${r.sold.id}: ${r.sold.status}, ${(r.sold.grossSatang ?? 0) / 100} THB, own till ${r.sold.stationIsOwn}; sales on the own till for this family: ${ownSales.length}`],
    ['Check in now', `${door.map(p => `${p.path} ${p.outcome}`).join(', ') || 'none'}; ${r.seen.registration.children.map(c => `${c.name} ${c.status}`).join('; ')}`],
    ['Box intents for this family', r.seen.wire.boxIntents.join(', ') || 'none'],
    ['Checks', Object.entries(checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; ')],
  ];
  await storyPicture('05-sale-refused-before-payment-then-try-again-paid-once.png', 'SCRUM-887 picture 05 (run 05, 9df18d68) — the sale refused before payment, then Try again: the same sale written online and paid once', [
    { file: '05b-refused-before-payment-panel.png', caption: 'Before payment: the counter box answered that it has not received this family; no "Nothing answered" paragraph', width: 470 },
    { file: '05d-paid-cash-once-clip.png', caption: 'After Try again: the same sale, written online, paid once in cash', width: 610 },
  ], facts);
  point('5', ok, '05-sale-refused-before-payment-then-try-again-paid-once.png', 'The sale commit aborted for 10 s: the held retries ran out, the box refused the sale before payment without "Nothing answered"; Try again wrote the same sale online; one cash payment; both children checked in', { checks, aborted, letThrough, retrying, outcome, salesAtRefusal, boxAtRefusal, panelText, tryAgain, ...r.seen, ownSales: ownSales.map(s => ({ id: s.id, status: s.status })) });
}

// ---- 4b: regression — an ordinary online ticket sale in cash ----
async function point4b() {
  phase('4b: ordinary online sale — one adult and one child, cash');
  await walkIn(numbers.ordinary);
  await resetPhrases();
  const wire0 = receipt.wire.length;
  await ticket(1, 1);
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  const sale = await saleWritten('ordinary-ticket-sale');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '04b-ordinary-online-sale-paid-cash.png');
  knownSales.add(sale.id);
  const sold = await saleOf(sale.id);
  const wire = wireFrom(wire0);
  const sales = salePosts(wire).map(w => ({ id: w.bodyId, outcome: w.failed ? 'aborted' : w.status }));
  const cash = finalisePosts(wire).map(w => ({ outcome: w.failed ? 'aborted' : w.status }));
  const attempts = sold.paymentAttempts ?? [];
  const ok = sold.status === 'finalised' && boxIntents(wire).length === 0 && sales.length === 1 && sales[0].outcome === 200 && sales[0].id === sale.id
    && cash.length === 1 && cash[0].outcome === 200 && attempts.length === 1 && attempts[0].method === 'cash' && attempts[0].status === 'approved';
  point('4b', ok, '04b-ordinary-online-sale-paid-cash.png', 'One adult and one child paid in cash completes online: one sale POST 200, one cash press 200, one cash payment, no box intent', { sale: sold, salePosts: sales, cashPresses: cash, regPosts: regPosts(wire).length, boxIntents: boxIntents(wire).map(w => w.intent), otherBoxIntents: allBoxIntents(wire).filter(w => !boxIntents([w]).length).map(w => w.intent), phrases: await seenPhrases() });
}

// ---- 4a: regression — a till offline from the start sells through its box ----
async function point4a() {
  phase('4a: offline from the start — every platform request aborted, the virtual box path left open');
  await home();
  let abortedPlatform = 0;
  const offline = async route => {
    const path = new URL(route.request().url()).pathname;
    if (/^\/api\/box\//.test(path)) return route.continue();
    abortedPlatform += 1; return route.abort('failed');
  };
  await till.route('**/api/**', offline);
  await resetPhrases();
  const wire0 = receipt.wire.length;
  const trace = [];
  try {
    await typeNumberWalkIn(numbers.offline);
    await ticket(1, 1);
    await expect(paymentStep()).toBeVisible({ timeout: 45000 });
    await till.waitForTimeout(1200);
    await shot(till, '04a-1-offline-payment-step-on-box.png');
    await payCash();
    await till.waitForTimeout(1500);
    await shot(till, '04a-2-offline-paid-cash-on-box.png');
  } catch (error) {
    trace.push(firstLine(error));
    trace.push('screen: ' + flat(await till.locator('main, [role="dialog"]').first().innerText().catch(() => '')).slice(0, 300));
    await shot(till, '04a-x-offline-not-completed.png').catch(() => {});
  }
  const wire = wireFrom(wire0);
  const intents = allBoxIntents(wire).map(w => ({ intent: w.intent, outcome: w.failed ? 'aborted' : w.status }));
  const phrases = await seenPhrases();
  phase('4a: network restored; the box hands the sale to the platform');
  await till.unroute('**/api/**', offline);
  let synced = null;
  await expect.poll(async () => { synced = (await newSales()).find(s => s.status === 'finalised') ?? null; return Boolean(synced); }, { timeout: 180000, intervals: [5000] }).toBe(true).catch(() => {});
  if (synced) { knownSales.add(synced.id); receipt.created.push({ kind: 'offline-box-sale', id: synced.id }); save(); }
  const sold = synced ? await saleOf(synced.id) : null;
  const ok = trace.length === 0 && intents.some(i => /sale/.test(i.intent ?? '')) && Boolean(sold && sold.status === 'finalised');
  await factsPicture('04a-platform-readback-offline-sale-via-box.png', 'SCRUM-887 point 4a — a till offline from the start sells through its box', [
    ['How', `every /api request except /api/box/* aborted in the browser before the walk-in (${abortedPlatform} aborted); the virtual box answered on /api/box/v1/station/:id/*`],
    ['Box intents sent', intents.map(i => `${i.intent} ${i.outcome}`).join('; ') || 'none'],
    ['Platform writes tried while offline', wireLine(wire.filter(w => !/\/box\//.test(w.path))) || 'none'],
    ['Screen phrases', JSON.stringify(Object.keys(phrases))],
    ['Sale on the platform after the restore', sold ? `${sold.id}: ${sold.status}, ${(sold.grossSatang ?? 0) / 100} THB, payments ${JSON.stringify(sold.payments)}, provenance ${JSON.stringify(sold.provenance)}` : 'not seen within 3 min'],
    ['Problems', trace.join(' | ') || 'none'],
  ]);
  point('4a', ok, '04a-platform-readback-offline-sale-via-box.png', 'A till offline from the start sold one adult + one child for cash through its (virtual) box; once restored the box handed the finalised sale to the platform', { abortedPlatform, intents, phrases, sale: sold, trace });
  await home();
}

const attempt = async (key, fn) => {
  try { return await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    await till.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
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
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online');
  receipt.checks.box = { slot: box.slot, role: box.role, status: box.status };
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const printerSource = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(role => s.devices.some(d => d.role === role)));
  assert.ok(printerSource, 'simulated printers already configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: printerSource.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  for (const phone of Object.values(numbers)) assert.equal(await memberOf(phone), null, 'ZZ TEST number must be unused');
  receipt.checks.testNumbersUnusedBefore = true;
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix, box: box.slot }); save();

  const video = resolve(import.meta.dirname, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  // Every phrase of interest, the first time it is on screen (toasts come and go).
  await tillContext.addInitScript(phrases => {
    window.__zzPhrases = {};
    setInterval(() => { const text = document.body?.innerText ?? ''; for (const p of phrases) if (!window.__zzPhrases[p] && text.includes(p)) window.__zzPhrases[p] = Date.now(); }, 200);
  }, PHRASES);
  till = await tillContext.newPage();
  watch(till, 'till');
  await till.goto(pos);
  phase('reception account signs in at the own till (new browser profile)');
  await signInAtTill(till, need('STAGING_RECEPTION_PHONE'), need('STAGING_RECEPTION_PASSWORD'));
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    const found = { files: urls.map(u => u.split('/').pop().split('?')[0]), connectionDropped: 0, saleHold: 0, doorHold: 0, boxNotSynced: 0 };
    for (const url of urls) { const text = await (await fetch(url, { cache: 'no-store' })).text(); found.connectionDropped += text.split('Connection dropped').length - 1; found.saleHold += text.split('finishing this sale online under the same sale number').length - 1; found.doorHold += text.split('finishing their check-in online').length - 1; found.boxNotSynced += text.split('box-not-synced').length - 1; }
    return found;
  });
  save();
  assert.ok(receipt.checks.bundle.connectionDropped >= 2 && receipt.checks.bundle.saleHold >= 1, 'the till serves the SCRUM-887 bundle');
  assert.ok(receipt.checks.bundle.doorHold >= 1 && receipt.checks.bundle.boxNotSynced >= 1, 'the till serves the follow-up fix (9df18d68)');

  if (only.includes('1')) await attempt('1', point1);
  if (only.includes('2')) await attempt('2', point2);
  if (only.includes('3')) await attempt('3', point3);
  if (only.includes('5')) await attempt('5', point5);
  if (only.includes('4b')) await attempt('4b', point4b);
  if (only.includes('4a')) await attempt('4a', point4a);
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
  await till?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  let ownsStation = false;
  if (station) {
    await clean('verify own till', async () => { assert.equal((await call('GET', `/stations/${station.id}`)).body.station.name, fixtureName); ownsStation = true; });
    if (ownsStation) {
      if (till) await clean('read the own till\'s box status', async () => {
        const r = await till.request.get(`/api/box/v1/station/${station.id}/status`);
        const body = await r.json().catch(() => null);
        const shape = v => Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'object' && x !== null ? shape(x) : (typeof x === 'number' || typeof x === 'boolean' || /lane|state|status|mode/i.test(k) ? x : typeof x)])) : typeof v;
        receipt.cleanup.push({ kind: 'box-status', status: r.status(), shape: shape(body) });
      });
      for (const sale of (await stationSales().catch(() => [])).filter(s => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
        assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided', by: 'cleanup' });
      });
      for (const item of regs) await clean(`own registration ${item.tag}`, async () => {
        let reg = await registrationOf(item.id);
        assert.equal(reg.guardianName, guardianName(item.tag), 'only this run\'s own booking');
        for (const child of reg.children) assert.match(child.childName, /^ZZ TEST /);
        if (reg.children.some(c => c.status === 'registered')) {
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
