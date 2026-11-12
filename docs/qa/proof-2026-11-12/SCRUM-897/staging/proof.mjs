// SCRUM-897 staging proof: after an online drop-off sale the till stops following the box lane where it should not.
// Adapted from the SCRUM-887 harness (docs/qa/proof-2026-11-12/SCRUM-887/staging/proof.mjs), its point 2 (run 04): every /api
// request aborted in the browser from the registration on, the till gives up, the link is restored while the box status read
// is still aborted (the lane stays "box"), Continue again, the family's sale is written online.
// Own ZZ TEST till on the shared virtual box (virtual-1), ZZ TEST guardians and children, invented numbers (08988970xx), cash
// only, two ZZ TEST promo codes made for this run and archived after. Nothing on staging is switched off: the drops are
// Playwright route aborts in the till's browser. No credential or raw response body enters the receipt.
//
//   node proof.mjs <sha> <out-dir>        ONLY=1,5,2,4a (default all, in that order)   ZZ_BASE=10 (numbers base+0 .. base+4)
//
// The points (the brief's numbering):
//   1  PROMO: ZZTEST897A (10 %, use limit 2, once per customer) on a drop-off family's order (g1), the long-outage window,
//      cash online. The platform counts one use. Then, on the same till with no reload, the same number and the same code:
//      the till's own copy must not believe the code was used (its own words "This code can only be used once per customer."
//      would say it counted the use locally); the platform's refusal, in its words, is what may come back.
//   3  HELD SALES: in the same window the Held sales list's next timed read is made to fail (as the lane's e2e does), so it
//      says "could not be read"; once Continue again is answered by the platform the list is read again at once (well
//      inside its 20 s timer) and the line is gone. Checked in both windows (g1 and g2).
//   5  ORDINARY: a walk-in (ordinary) with ZZTEST897A, 1 kid + 1 adult, cash online, on the same till: accepted (2nd use of 2),
//      the platform's count rises by exactly one.
//   2  HOLD SALE: a second window (g2): at the payment step no "working through its counter box" line, Hold sale open;
//      hold it, see it in Held sales, resume it (once the box status read is let through and the lane is back) and pay cash
//      once.
//   4a THE BOX LANE: a till offline from the start (every non-box /api request aborted) sells 1 kid + 1 adult with
//      ZZTEST897B (use limit 1) through its box: Hold sale shut with the counter-box line, cash on the box. The next
//      customer at the same till, still offline, is refused ZZTEST897B by the till's own copy (the use the box closed is
//      counted locally, as before). After the restore the box hands the sale to the platform, which counts one use of B.
//
// Run history:
//   01  079b9431  all        ZZ_BASE=10  stopped at 16:22 (laptop memory), no clean-up ran: 1 FAIL at the start (the harness looked for the promo box on the
//                                        drop-off form, which has none), 5 PASS (count 0 → 1, the code's first use); its leftovers were cleaned by
//                                        cleanup-run-01.mjs (out-run-01/cleanup.json)
//   02  348caa58  all        ZZ_BASE=20  the code applied at the ticket step; codes named per run: 1, 2, 4a, 5 PASS; 3 FAIL on its own rule
//                                        (it wanted "could not be read" on screen before Continue again, but the drop-off form has no Held
//                                        sales panel); the wire shows the re-read 1.5 s / 1.8 s after the failed read, off the 20 s timer
//   03  348caa58  ONLY=3b    ZZ_BASE=30  point 3 on screen: the held sale's first screen, reads aborted until the box says "platform"
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
const T = '897';
const base = Number(process.env.ZZ_BASE ?? 10);
const zz = i => '08988970' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const only = (process.env.ONLY ?? '1,5,2,4a').split(',');
const receipt = { ticket: 'SCRUM-897', sha, startedAt: new Date().toISOString(), phase: 'preflight', only,
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], wire: [], probes: [], held: [], cleanup: [] };
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
  receipt.requests.push({ method, path: path.split('?')[0].replace(ID, ':id'), status: response.status(), ...(response.status() >= 400 ? { errorCode: body?.error?.code ?? null, message: String(body?.error?.message ?? '').slice(0, 200) } : {}) });
  return { status: response.status(), body };
};

const numbers = { g1: zz(0), g2: zz(1), ordinary: zz(2), offline: zz(3), probe: zz(4) };
receipt.numbers = numbers;
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const RUN = String(process.argv[3] ?? 'out').replace(/\D/g, '') || '00';
const guardianName = tag => `ZZ TEST SCRUM-${T} guardian ${tag}-${RUN}`;
// Each run makes its own codes (run 01's were archived by cleanup-run-01.mjs), so no count carries over.
const CODE_A = `ZZTEST897A${RUN}`, CODE_B = `ZZTEST897B${RUN}`;
const codes = {}; // code -> { id }
const knownSales = new Set();
let browser = null, till = null, station = null, branchId = null, failed = false;
const regs = []; // { tag, id }
const PHRASES = ['Connection dropped — retrying', "Couldn't register these children", 'Member not found', 'rung up on the counter box', 'box has not received',
  'This sale has not been saved.', 'Payment Successful', 'Held sales could not be read', 'working through its counter box', 'Sale held',
  'This code can only be used', 'can only be used once per customer', 'has reached its total usage limit', 'is used up', 'was not found'];

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
      // Held sales: whoever held a sale is a staff name; a sale another till held is not this run's.
      page.getByTestId('held-sale').locator('div.text-xs').filter({ hasText: /^Held by/ }),
      page.getByTestId('held-sale').filter({ hasNotText: 'ZZ TEST' }),
      ...others, ...extra] });
  console.log('picture', name);
};
/** A masked picture of one element of the till, with a margin. */
const clipShot = async (page, name, locator, pad = 12) => {
  const bb = await locator.boundingBox().catch(() => null);
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
  const isStatus = (method, path) => method === 'GET' && /^\/api\/box\/v1\/station\/[^/]+\/status$/.test(path);
  const isHeld = (method, path) => method === 'GET' && path === '/api/sales/held';
  const describe = r => {
    const u = new URL(r.url());
    let body = null; try { body = r.postDataJSON(); } catch { /* not json */ }
    return { at: receipt.phase, t: Date.now(), method: r.method(), path: u.pathname.replace(ID, ':id'), bodyId: typeof body?.id === 'string' ? body.id : null,
      intent: /intents$/.test(u.pathname) ? (body?.type ?? null) : undefined,
      promoCodes: Array.isArray(body?.promoCodes) ? body.promoCodes : Array.isArray(body?.cart?.promoCodes) ? body.cart.promoCodes : undefined };
  };
  page.on('requestfinished', async r => {
    const u = new URL(r.url());
    if (isStatus(r.method(), u.pathname)) {
      const res = await r.response().catch(() => null);
      let lane = null; try { lane = (await res?.json())?.link?.lane ?? null; } catch { /* no body */ }
      receipt.probes.push({ at: receipt.phase, t: Date.now(), status: res?.status() ?? null, lane }); save(); return;
    }
    if (isHeld(r.method(), u.pathname)) {
      const res = await r.response().catch(() => null);
      receipt.held.push({ at: receipt.phase, t: Date.now(), status: res?.status() ?? null }); save(); return;
    }
    if (!interesting(r.method(), u.pathname)) return;
    const res = await r.response().catch(() => null);
    receipt.wire.push({ ...describe(r), status: res?.status() ?? null }); save();
  });
  page.on('requestfailed', r => {
    const u = new URL(r.url());
    if (isStatus(r.method(), u.pathname)) { receipt.probes.push({ at: receipt.phase, t: Date.now(), failed: r.failure()?.errorText ?? 'failed' }); save(); return; }
    if (isHeld(r.method(), u.pathname)) { receipt.held.push({ at: receipt.phase, t: Date.now(), failed: r.failure()?.errorText ?? 'failed' }); save(); return; }
    if (!interesting(r.method(), u.pathname)) return;
    receipt.wire.push({ ...describe(r), failed: r.failure()?.errorText ?? 'failed' }); save();
  });
}
const wireFrom = i => receipt.wire.slice(i);
const allBoxIntents = rows => rows.filter(w => /\/api\/box\/v1\/station\/:id\/intents$/.test(w.path));
const boxIntents = rows => allBoxIntents(rows).filter(w => /^(member|child|visit|checkin|waiver|sale|cart)\./.test(w.intent ?? ''));
const regPosts = rows => rows.filter(w => w.method === 'POST' && w.path === '/api/checkin/registrations');
const salePosts = rows => rows.filter(w => w.method === 'POST' && w.path === '/api/sales');
const finalisePosts = rows => rows.filter(w => w.method === 'POST' && /^\/api\/sales\/:id\/finalise$/.test(w.path));
const holdPosts = rows => rows.filter(w => w.method === 'POST' && /^\/api\/sales\/:id\/hold$/.test(w.path));
const resumePosts = rows => rows.filter(w => w.method === 'POST' && /^\/api\/sales\/:id\/resume$/.test(w.path));
const doorPosts = rows => rows.filter(w => w.method === 'POST' && /^\/api\/checkin\/(check-in-now|leave-as-booked)$/.test(w.path));
const outcome = w => w.failed ? 'aborted' : w.status;
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
const baht = satang => satang === null || satang === undefined ? '-' : `${(satang / 100).toFixed(2)} THB`;
/** The two ZZ TEST codes as the platform counts them (`usedCount`: the finalised sales that carried the code). */
async function codeCounts() {
  const rows = (await call('GET', '/menu/discounts?includeArchived=true')).body.discounts;
  return Object.fromEntries(Object.keys(codes).map(code => { const d = rows.find(x => x.id === codes[code].id); return [code, d ? { usedCount: d.usedCount, active: d.active, archived: Boolean(d.archivedAt) } : null]; }));
}
/** A sale read back from the platform, as the staging admin: status, total, its discounts and its payments. */
async function saleOf(id) {
  const r = await call('GET', `/sales/${id}`);
  const sale = r.body?.sale ?? null;
  if (!sale) return { status: r.status };
  return { id: sale.id, status: sale.status, grossSatang: sale.totals?.grossSatang ?? sale.grossSatang ?? null, totals: sale.totals ?? null,
    receiptNumber: sale.receiptNumber ? 'present' : null, stationIsOwn: sale.stationId === station.id, memberIsSet: Boolean(sale.memberId),
    discounts: (r.body.discounts ?? []).map(d => ({ kind: d.kind ?? null, code: d.code ?? null, discountType: d.discountType ?? null, percentBp: d.percentBp ?? null, amountSatang: d.amountSatang ?? null })),
    paymentAttempts: (r.body.attempts ?? []).map(a => ({ method: a.method ?? a.kind ?? null, status: a.status ?? null, amountSatang: a.amountSatang ?? null })),
    printJobs: (r.body.printJobs ?? []).map(j => j.status) };
}
const heldOnBranch = async () => (await call('GET', `/sales/held?branchId=${branchId}`)).body?.sales ?? [];

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

async function english() {
  await landing(till).waitFor({ timeout: 30000 });
  if (await till.getByTestId('language-choice').isVisible()) await till.getByTestId('language-choice-en').click();
  await till.getByTestId('identify-safety').waitFor();
}
/** A fresh page load of the till (resets the till's in-memory copy of the catalog). */
async function home() { await till.goto('/'); await english(); }
/** The next customer WITHOUT a reload: the till's own button after a sale, or the screen it is already on. */
async function nextCustomer() {
  const again = till.getByRole('button', { name: 'Start New Sale', exact: true });
  if (await again.isVisible().catch(() => false)) await again.click();
  await english();
}
/** The number on the customer half: a new number is a walk-in; a member found with saved children skips the visit question. */
async function typeNumber(number) {
  const scope = halfOf(till.getByTestId('identify-safety'));
  await keypad(scope, number);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  const skip = till.getByRole('button', { name: 'Skip for now', exact: true });
  const tiers = till.getByRole('heading', { name: 'Tourist', exact: true }).first();
  let seen = null;
  await expect.poll(async () => {
    if (await offer.isVisible().catch(() => false)) seen = 'new-member-offer';
    else if (await skip.isVisible().catch(() => false)) seen = 'member-found-visit-children';
    else if (await tiers.isVisible().catch(() => false)) seen = 'tiers';
    else seen = null;
    return seen;
  }, { timeout: 30000 }).not.toBeNull();
  if (seen === 'new-member-offer') {
    await expect(offer).toContainText(spaced(number));
    await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  } else if (seen === 'member-found-visit-children') {
    await skip.click();
  }
  return seen;
}
async function walkIn(number) { await home(); return typeNumber(number); }
/** Tourist, 1 Hour Play, the counts; Continue only when asked. */
async function ticket(kids, adults, { go = true } = {}) {
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
  if (go) await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
}
const promoInput = () => till.getByPlaceholder('Promo code…', { exact: true });
const promoBox = () => promoInput().locator('xpath=ancestor::div[contains(@class,"space-y-1.5")][1]');
const orderColumn = () => promoInput().locator('xpath=ancestor::div[contains(@class,"w-[360px]")][1]');
/** Type a code in the order panel's promo box and Apply: what the till shows once the answer has settled. */
async function applyPromo(code) {
  await resetPhrases();
  await expect(promoInput()).toBeEnabled({ timeout: 15000 });
  await promoInput().fill(code);
  await promoBox().getByRole('button', { name: 'Apply', exact: true }).click();
  const refusal = promoBox().locator('p');
  const badge = orderColumn().locator('div.font-mono').filter({ hasText: new RegExp(`^${code}$`) });
  const read = async () => ({ refusal: (await refusal.isVisible().catch(() => false)) ? flat(await refusal.innerText()) : null, badge: await badge.count() > 0 });
  await expect.poll(async () => { const s = await read(); return Boolean(s.refusal) || s.badge; }, { timeout: 30000 }).toBe(true).catch(() => {});
  await till.waitForTimeout(3500); // a platform refusal arrives on the quote after the till's own check
  const settled = await read();
  const note = orderColumn().getByText(/Priced on this till\.|The platform priced this differently/).first();
  settled.priceNote = (await note.isVisible().catch(() => false)) ? flat(await note.locator('xpath=..').innerText()).slice(0, 200) : null;
  if (settled.badge) settled.badgeRow = flat(await badge.first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]').innerText().catch(() => '')).slice(0, 120);
  settled.phrases = Object.keys(await seenPhrases());
  return settled;
}
async function cancelOrder() {
  await orderColumn().getByRole('button', { name: 'Cancel', exact: true }).click();
  await english();
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
  await expect.poll(async () => { sale = (await newSales()).find(x => ['tendering', 'paid', 'finalised'].includes(x.status)); return Boolean(sale); }, { timeout }).toBe(true);
  receipt.created.push({ kind, id: sale.id }); save();
  return sale;
}
async function checkInNow(regId) {
  const now = till.getByRole('button', { name: 'Check in now', exact: true });
  await now.waitFor({ timeout: 15000 }).catch(() => {});
  if (!(await now.isVisible().catch(() => false))) return { shown: false, inPark: false };
  await now.click();
  const inPark = await expect.poll(async () => (await registrationOf(regId)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true).then(() => true, () => false);
  if (!inPark) odd('"Check in now" did not put the children in the park within 30 s');
  await till.waitForTimeout(1200);
  return { shown: true, inPark };
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
const heldError = async () => {
  const line = till.getByTestId('held-sales').getByText(/Held sales could not be read/).first();
  return (await line.isVisible().catch(() => false)) ? flat(await line.innerText()).slice(0, 200) : null;
};
/** The payment step's Hold sale: open or shut, and any line under it. */
async function holdState() {
  const buttons = till.getByTestId('hold-sale-buttons');
  const hold = buttons.getByRole('button', { name: 'Hold sale', exact: true });
  const reason = till.getByTestId('hold-sale-reason');
  return { holdVisible: await hold.isVisible().catch(() => false), holdEnabled: await hold.isEnabled().catch(() => false),
    reason: (await reason.isVisible().catch(() => false)) ? flat(await reason.innerText()) : null,
    counterBoxLines: await till.getByText(/working through its counter box/).count() };
}
/** A picture of what the platform holds after a point, drawn from the admin reads. */
async function factsPicture(name, title, facts) {
  const page = await browser.newPage({ viewport: { width: 1250, height: 500 } });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:24px;background:#fff;color:#111"><h2>${esc(title)}</h2>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${facts.map(([k, v]) => `<tr><th style="text-align:left;vertical-align:top;white-space:nowrap">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <p style="color:#555">Read on the platform as the staging admin (GET /api/menu/discounts, /api/sales/:id, /api/sales/held, /api/checkin/registrations/:id), ${esc(new Date().toISOString())}. Request counts are the till browser's own requests.</p></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  console.log('picture', name);
}
/** One picture of a point: masked crops of the till side by side, and the platform's facts under them. */
async function storyPicture(name, title, images, facts) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 600 } });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const figures = images.filter(i => existsSync(resolve(out, i.file))).map(i => `<figure style="margin:0 20px 12px 0;display:inline-block;vertical-align:top;max-width:${i.width ?? 600}px">
    <img src="data:image/png;base64,${readFileSync(resolve(out, i.file)).toString('base64')}" style="max-width:100%;border:1px solid #bbb">
    <figcaption style="font-size:14px;color:#222;margin-top:6px;max-width:${i.width ?? 600}px">${esc(i.caption)}</figcaption></figure>`).join('');
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:24px;background:#fff;color:#111"><h2 style="margin-top:0">${esc(title)}</h2><div>${figures}</div>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px;margin-top:8px">${facts.map(([k, v]) => `<tr><th style="text-align:left;vertical-align:top;white-space:nowrap">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <p style="color:#555">The crops are the till's own screen (1680 x 1100), staff names masked. Facts read on the platform as the staging admin, ${esc(new Date().toISOString())}; request counts are the till browser's own requests.</p></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  console.log('picture', name);
}

/**
 * The long-outage window (SCRUM-887 point 2, run 04): from the registration request on every /api request is aborted until
 * the till gives up; the link comes back while the box status read is still aborted (the lane stays on the box); the Held
 * sales list's next timed read is made to fail too, then Continue again. Leaves the status and held routes in place.
 */
async function longOutageToPayment({ tag, phone, kids, promoCode = null }) {
  const st = { tag, phone };
  phase(`${tag}: walk-in, two children no adult, drop-off form filled`);
  st.identified = await walkIn(phone);
  // Run 02: the drop-off form (step 7) has no order column (Till.tsx draws it only while step < 6), so a code goes on in
  // the order panel at the ticket step, before Continue. Run 01 looked for the promo box on the form and failed there.
  await ticket(kids.length, 0, { go: !promoCode });
  if (promoCode) {
    phase(`${tag}: ${promoCode} applied on the order at the ticket step, before the drop-off form`);
    st.promo = await applyPromo(promoCode);
    await shot(till, `${tag}-a-promo-applied-on-order.png`);
    await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  }
  await fillGate(kids, guardianName(tag));
  phase(`${tag}: Continue — from the registration request on, every /api request reaches nothing until the till gives up`);
  let down = false, downAt = null, tripped = false;
  st.abortedRegs = 0; st.abortedOther = 0;
  const handler = async route => {
    const req = route.request();
    const isReg = new URL(req.url()).pathname === '/api/checkin/registrations' && req.method() === 'POST';
    if (!tripped && isReg) { tripped = true; down = true; downAt = Date.now(); }
    if (down) { if (isReg) st.abortedRegs += 1; else st.abortedOther += 1; return route.abort('failed'); }
    return route.continue();
  };
  await till.route('**/api/**', handler);
  await resetPhrases();
  st.wire0 = receipt.wire.length; st.held0 = receipt.held.length; st.probes0 = receipt.probes.length;
  await continueButton().click();
  st.retrying = await toastText(/Connection dropped — retrying/, 20000).catch(() => null);
  st.gaveUp = await toastText(/Couldn't register these children/, 45000);
  st.gaveUpAfterMs = Date.now() - downAt;
  await till.waitForTimeout(800);
  await shot(till, `${tag}-b-gave-up-press-continue-again.png`);
  phase(`${tag}: link restored for the till; its box status read still reaches nothing, so the lane stays on the box`);
  const statusTimes = [];
  const statusMatcher = url => /^\/api\/box\/v1\/station\/[^/]+\/status$/.test(new URL(url).pathname);
  const statusHandler = route => { statusTimes.push(Date.now()); return route.abort('failed'); };
  let heldDown = false, heldFailedAt = null;
  const heldMatcher = url => new URL(url).pathname === '/api/sales/held';
  const heldHandler = async route => { if (heldDown) { heldDown = false; heldFailedAt = Date.now(); return route.abort('failed'); } return route.fallback(); };
  await till.route(statusMatcher, statusHandler);
  await till.route(heldMatcher, heldHandler);
  down = false;
  await till.unroute('**/api/**', handler);
  st.restoredAt = Date.now();
  st.laneProbed = await expect.poll(() => statusTimes.length, { timeout: 40000 }).toBeGreaterThan(0).then(() => true, () => false);
  if (!st.laneProbed) odd(`${tag}: the till read no box status within 40 s of the restore, so it may not be on the box lane`);
  phase(`${tag}: the Held sales list's next timed read is made to fail while the lane is on the box`);
  heldDown = true;
  st.heldFailed = await expect.poll(() => heldFailedAt !== null, { timeout: 30000 }).toBe(true).then(() => true, () => false);
  await till.waitForTimeout(800);
  st.heldErrorBefore = await heldError();
  if (st.heldErrorBefore) await clipShot(till, `${tag}-c-held-sales-could-not-be-read.png`, till.getByTestId('held-sales'));
  st.heldFailedAt = heldFailedAt;
  phase(`${tag}: Continue pressed again, the lane still the box's`);
  await resetPhrases();
  st.againAt = Date.now();
  const [registered] = await Promise.all([till.waitForResponse(r => isRegistrationPost(r) && r.status() === 200, { timeout: 60000 }), continueButton().click()]);
  const reg = await registered.json();
  regs.push({ tag, id: reg.id }); receipt.created.push({ kind: 'registration', tag, id: reg.id }); save();
  st.regId = reg.id;
  await expect(paymentStep()).toBeVisible({ timeout: 45000 });
  const notice = till.getByText('This sale has not been saved.', { exact: false });
  const rungUp = till.getByText('This sale was rung up on the counter box', { exact: false });
  await expect.poll(async () => (await notice.isVisible().catch(() => false)) || (await rungUp.isVisible().catch(() => false)) || (await newSales()).length > 0, { timeout: 60000 }).toBe(true);
  st.refused = (await notice.isVisible().catch(() => false)) ? 'not saved' : (await rungUp.isVisible().catch(() => false)) ? 'rung up on the counter box' : null;
  if (st.refused) odd(`${tag}: after Continue again the sale was not written online: ${st.refused}`);
  // Point 3: the list is read again by itself, well inside its 20 s timer.
  const regRow = regPosts(wireFrom(st.wire0)).find(w => w.status === 200);
  st.regAnsweredT = regRow?.t ?? null;
  st.heldErrorGone = await expect.poll(async () => (await heldError()) === null, { timeout: 15000, intervals: [250] }).toBe(true).then(() => true, () => false);
  st.heldErrorGoneAfterAgainMs = Date.now() - st.againAt;
  const heldAfter = receipt.held.slice(st.held0).filter(h => heldFailedAt !== null && h.t > heldFailedAt);
  st.heldReadsAfterFailure = heldAfter.map(h => ({ secondsAfterFailedRead: +((h.t - heldFailedAt) / 1000).toFixed(1), secondsAfterRegistrationAnswered: st.regAnsweredT ? +((h.t - st.regAnsweredT) / 1000).toFixed(1) : null, outcome: h.failed ? 'aborted' : h.status }));
  // Point 2: the sale on screen is online, so Hold sale is open and nothing says the till works through its box.
  await expect(till.getByTestId('hold-sale-buttons').getByRole('button', { name: 'Hold sale', exact: true })).toBeEnabled({ timeout: 10000 }).catch(() => {});
  st.hold = await holdState();
  st.statusReadsAbortedSoFar = statusTimes.length;
  st.phrases = Object.keys(await seenPhrases());
  await till.waitForTimeout(400);
  await shot(till, `${tag}-d-payment-step-online-hold-sale-open.png`);
  const holdArea = till.getByTestId('hold-sale-buttons').locator('xpath=..');
  await clipShot(till, `${tag}-d-hold-sale-area.png`, holdArea, 16);
  const release = async () => { await till.unroute(statusMatcher, statusHandler).catch(() => {}); await till.unroute(heldMatcher, heldHandler).catch(() => {}); st.statusReadsAborted = statusTimes.length; };
  return { st, reg, release, statusTimes };
}
/** After the status read is let through: wait until the till's box answers "platform", so the lane can move back. */
async function laneBack(label, timeout = 60000) {
  const from = Date.now();
  const back = () => receipt.probes.find(p => p.t > from && p.lane === 'platform');
  const ok = await expect.poll(() => Boolean(back()), { timeout, intervals: [1000] }).toBe(true).then(() => true, () => false);
  if (!ok) odd(`${label}: no box status read answered "platform" within ${timeout / 1000} s`);
  await till.waitForTimeout(3000); // after the box's answer the till reads /me before it moves back
  return ok ? +((back().t - from) / 1000).toFixed(1) : null;
}

// ---- 1 (with 3): the promo code on a drop-off family's sale in the long-outage window, then the same customer again ----
async function point1() {
  const tag = 'g1', phone = numbers.g1;
  const kids = [{ name: 'ZZ TEST Bua 897', age: 6, allergies: 'ZZ TEST peanuts' }, { name: 'ZZ TEST Nok 897', age: 9 }];
  const before = await codeCounts();
  const { st, reg, release } = await longOutageToPayment({ tag, phone, kids, promoCode: CODE_A });
  const sale = await saleWritten(`dropoff-sale-${tag}`);
  phase(`${tag}: cash, then Check in now`);
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, `${tag}-e-paid-cash.png`);
  knownSales.add(sale.id);
  const door = await checkInNow(reg.id);
  await release();
  phase(`${tag}: the box status read let through again; waiting for the lane to come back`);
  const sold = await saleOf(sale.id);
  const afterSale = await codeCounts();
  const wire = wireFrom(st.wire0);
  st.window = { salePosts: salePosts(wire).map(w => ({ outcome: outcome(w), promoCodes: w.promoCodes })), finalisePosts: finalisePosts(wire).map(outcome), doorPosts: doorPosts(wire).map(w => `${w.path} ${outcome(w)}`), boxIntents: boxIntents(wire).map(w => `${w.intent} ${outcome(w)}`) };
  st.laneBackAfterS = await laneBack('point 1');
  receipt.checks.point3g1 = st; save();

  phase('1b: Start New Sale (no reload), the same number, the same code');
  await nextCustomer();
  await resetPhrases();
  const identified = await typeNumber(phone);
  await ticket(1, 1, { go: false });
  const again = await applyPromo(CODE_A);
  await shot(till, '1b-same-customer-same-code.png');
  await clipShot(till, '1b-same-customer-same-code-promo-box.png', promoBox().locator('xpath=..'), 16);
  const afterCheck = await codeCounts();
  phase('1b: the order cancelled (nothing was rung up)');
  await cancelOrder();
  const ownSales = (await stationSales()).filter(s => !knownSales.has(s.id));
  const promoOnSale = sold.discounts.filter(d => d.code === CODE_A);
  const checks = {
    codeTakenOnTheOrder: st.promo?.badge === true && !st.promo?.refusal,
    windowReproduced: /press Continue again/.test(st.gaveUp ?? '') && st.laneProbed && !st.refused,
    saleOnlineFinalisedCash: sold.status === 'finalised' && sold.stationIsOwn && sold.paymentAttempts.length === 1 && sold.paymentAttempts[0].method === 'cash' && st.window.salePosts.length === 1 && st.window.salePosts[0].outcome === 200 && st.window.boxIntents.length === 0,
    codeOnTheSaleOnce: promoOnSale.length === 1 && (promoOnSale[0].amountSatang ?? 0) > 0,
    platformCountRoseByOne: before[CODE_A]?.usedCount === 0 && afterSale[CODE_A]?.usedCount === 1,
    tillDidNotCountItLocally: !(again.refusal ?? '').startsWith('This code can only be used') && !again.phrases.includes('This code can only be used') && !again.phrases.includes('has reached its total usage limit'),
    nothingRungUpByTheCheck: ownSales.length === 0 && afterCheck[CODE_A]?.usedCount === 1,
  };
  const ok = Object.values(checks).every(Boolean);
  const facts = [
    ['Code', `${CODE_A}: 10 %, use limit 2, once per customer, this branch, today only (made by this run)`],
    ['Family', `${guardianName(tag)} (${phone}), walk-in, two children no adult, drop-off form; the code applied on the order before payment: ${st.promo?.badge ? 'taken' : 'NOT taken'}${st.promo?.badgeRow ? ' (' + st.promo.badgeRow + ')' : ''}`],
    ['Window', `every /api request aborted from the registration on (${st.abortedRegs} registration tries, ${st.abortedOther} others); gave up after ${(st.gaveUpAfterMs / 1000).toFixed(1)} s: "${st.gaveUp}"; restored with the box status read aborted (${st.statusReadsAborted ?? '?'} aborted reads)`],
    ['Sale', `${sold.id}: ${sold.status}, ${baht(sold.grossSatang)}, own till ${sold.stationIsOwn}, member on the sale ${sold.memberIsSet}; payments ${sold.paymentAttempts.map(a => `${a.method} ${a.status} ${baht(a.amountSatang)}`).join(', ')}`],
    ['Discount rows on the sale', sold.discounts.map(d => `${d.kind} ${d.code} ${d.discountType ?? ''} ${d.percentBp ?? ''}bp -${baht(d.amountSatang)}`).join('; ') || 'none'],
    ['Till requests', `sale POST ${st.window.salePosts.map(p => p.outcome).join(', ')} (codes sent ${JSON.stringify(st.window.salePosts.map(p => p.promoCodes ?? null))}); cash press ${st.window.finalisePosts.join(', ')}; door ${st.window.doorPosts.join(', ') || 'none'}; box intents ${st.window.boxIntents.join(', ') || 'none'}`],
    ['Use count on the platform', `before ${before[CODE_A]?.usedCount}; after this sale ${afterSale[CODE_A]?.usedCount}; after the same-customer check ${afterCheck[CODE_A]?.usedCount}`],
    ['Same number again, no reload', `${phone} (${identified}), 1 kid + 1 adult, ${CODE_A} applied: ${again.badge ? 'code TAKEN on the order' : 'refused'}; the line under the promo box: ${again.refusal ? '"' + again.refusal + '"' : 'none'}; price note: ${again.priceNote ?? 'none'}; order cancelled, nothing rung up`],
    ['Whose words', `the till's own copy would say: This code can only be used once per customer. — had it counted the first use; the platform says: Code "${CODE_A}" can only be used once per customer.`],
    ['Door', door.shown ? `Check in now: children in the park ${door.inPark}` : 'no Check in now offered'],
    ['Checks', Object.entries(checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; ')],
  ];
  await factsPicture('01-platform-readback-promo-counted-once.png', 'SCRUM-897 point 1 — a promo code on the drop-off family\'s sale in the long-outage window', facts);
  await storyPicture('01-promo-window-then-same-customer.png', 'SCRUM-897 point 1 — the code counted once, by the platform; the till did not count it again', [
    { file: `${tag}-a-promo-applied-on-order.png`, caption: `${CODE_A} on the drop-off family's order before the outage`, width: 600 },
    { file: '1b-same-customer-same-code-promo-box.png', caption: 'Same number, same till, no reload: the line under the promo box', width: 420 },
  ], facts);
  point('1', ok, '01-promo-window-then-same-customer.png', `The code on the drop-off family's sale written online in the long-outage window: one discount row, cash, the platform's use count 0 → 1; the same number again on the same till: ${again.refusal ? 'refused in the words "' + again.refusal + '"' : 'code taken'} — not the till's own once-per-customer words`, { checks, before, afterSale, afterCheck, sale: sold, again, identified, window: st.window, door });
  // Point 3 is first read in this window.
  receipt.checks.point3windows = [...(receipt.checks.point3windows ?? []), { tag, heldErrorBefore: st.heldErrorBefore, heldFailed: st.heldFailed, heldErrorGone: st.heldErrorGone, heldErrorGoneAfterAgainMs: st.heldErrorGoneAfterAgainMs, reads: st.heldReadsAfterFailure, hold: st.hold }];
  save();
}

// ---- 5: an ordinary online ticket sale with the same code on the same till (no reload): accepted, counted once ----
async function point5() {
  phase('5: Start New Sale (no reload): an ordinary walk-in, 1 kid + 1 adult, the same code, cash');
  const before = await codeCounts();
  await nextCustomer();
  await resetPhrases();
  const identified = await typeNumber(numbers.ordinary);
  await ticket(1, 1, { go: false });
  const applied = await applyPromo(CODE_A);
  await shot(till, '05a-ordinary-code-applied.png');
  const wire0 = receipt.wire.length;
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  const sale = await saleWritten('ordinary-ticket-sale');
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, '05b-ordinary-paid-cash.png');
  knownSales.add(sale.id);
  const sold = await saleOf(sale.id);
  const after = await codeCounts();
  const wire = wireFrom(wire0);
  const sales = salePosts(wire).map(w => ({ outcome: outcome(w), promoCodes: w.promoCodes }));
  const cash = finalisePosts(wire).map(outcome);
  const promoOnSale = sold.discounts.filter(d => d.code === CODE_A);
  const checks = {
    codeTaken: applied.badge && !applied.refusal,
    finalisedOnlineCash: sold.status === 'finalised' && boxIntents(wire).length === 0 && sales.length === 1 && sales[0].outcome === 200 && cash.length === 1 && cash[0] === 200 && sold.paymentAttempts.length === 1 && sold.paymentAttempts[0].method === 'cash',
    codeOnTheSaleOnce: promoOnSale.length === 1 && (promoOnSale[0].amountSatang ?? 0) > 0,
    countedOnce: after[CODE_A]?.usedCount === (before[CODE_A]?.usedCount ?? -9) + 1,
  };
  const ok = Object.values(checks).every(Boolean);
  const facts = [
    ['Customer', `${numbers.ordinary} (${identified}), Tourist, 1 Hour Play, 1 kid + 1 adult, on the same till as point 1, no reload`],
    ['Code on the order', `${CODE_A}: ${applied.badge ? 'taken' : 'NOT taken'}${applied.badgeRow ? ' (' + applied.badgeRow + ')' : ''}${applied.refusal ? '; refusal: ' + applied.refusal : ''}`],
    ['Sale', `${sold.id}: ${sold.status}, ${baht(sold.grossSatang)}; payments ${sold.paymentAttempts.map(a => `${a.method} ${a.status} ${baht(a.amountSatang)}`).join(', ')}`],
    ['Discount rows on the sale', sold.discounts.map(d => `${d.kind} ${d.code} -${baht(d.amountSatang)}`).join('; ') || 'none'],
    ['Till requests', `sale POST ${sales.map(s => s.outcome).join(', ')}; cash press ${cash.join(', ')}; box intents ${boxIntents(wire).map(w => w.intent).join(', ') || 'none'}`],
    ['Use count on the platform', `before ${before[CODE_A]?.usedCount}, after ${after[CODE_A]?.usedCount} (limit 2: this was use ${(before[CODE_A]?.usedCount ?? 0) + 1})`],
    ['Checks', Object.entries(checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; ')],
  ];
  await factsPicture('05-platform-readback-ordinary-sale-code-counted-once.png', 'SCRUM-897 point 5 — an ordinary online ticket sale with the code, cash, counted once', facts);
  point('5', ok, '05-platform-readback-ordinary-sale-code-counted-once.png', `An ordinary online sale with ${CODE_A} (use ${(before[CODE_A]?.usedCount ?? 0) + 1} of its limit of 2) was accepted on the same till, paid in cash online once, and the platform's count rose by exactly one (${before[CODE_A]?.usedCount} → ${after[CODE_A]?.usedCount})`, { checks, before, after, sale: sold, applied, salePosts: sales, cash });
}

// ---- 2 (with 3): Hold sale in the same window; held, listed, resumed, paid once ----
async function point2() {
  const tag = 'g2', phone = numbers.g2;
  const kids = [{ name: 'ZZ TEST Mali 897', age: 7 }, { name: 'ZZ TEST Ton 897', age: 8 }];
  const { st, reg, release } = await longOutageToPayment({ tag, phone, kids });
  const sale = await saleWritten(`dropoff-sale-${tag}`);
  const holdLabel = `ZZ TEST SCRUM-${T} held ${tag}-${RUN}`;
  phase(`${tag}: Hold sale pressed on the online sale while the lane still says box`);
  const holdArea = st.hold;
  let held = { pressed: false };
  if (holdArea.holdEnabled) {
    await till.getByTestId('hold-sale-buttons').getByRole('button', { name: 'Hold sale', exact: true }).click();
    const dialog = till.getByTestId('hold-sale-dialog');
    await dialog.waitFor();
    await dialog.locator('#hold-label').fill(holdLabel);
    await dialog.locator('#hold-note').fill('ZZ TEST proof hold');
    await shot(till, `${tag}-e-hold-dialog.png`);
    const answered = till.waitForResponse(r => /\/api\/sales\/[^/]+\/hold$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30000 });
    await dialog.getByRole('button', { name: 'Hold sale', exact: true }).click();
    const response = await answered;
    held = { pressed: true, status: response.status() };
    held.toast = await toastText(/^Sale held$/, 15000).catch(() => null);
    await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await english().catch(() => {});
    const mine = till.getByTestId('held-sale').filter({ hasText: holdLabel });
    held.listed = await mine.waitFor({ timeout: 30000 }).then(() => true, () => false);
    held.resumeWhileBox = { enabled: await mine.getByRole('button', { name: 'Resume', exact: true }).isEnabled().catch(() => null),
      lines: (await mine.locator('p.mt-1').allInnerTexts().catch(() => [])).map(flat) };
    held.platformList = (await heldOnBranch()).filter(h => h.saleId === sale.id).map(h => ({ kind: h.kind, label: h.label, balanceSatang: h.balanceSatang }));
    held.saleWhileHeld = (await saleOf(sale.id)).status;
    await till.waitForTimeout(500);
    await shot(till, `${tag}-f-held-in-held-sales.png`);
    await clipShot(till, `${tag}-f-held-sales-panel.png`, till.getByTestId('held-sales'));
    phase(`${tag}: the box status read let through; waiting for the lane to come back, then Resume`);
    await release();
    held.laneBackAfterS = await laneBack('point 2');
    const resume = mine.getByRole('button', { name: 'Resume', exact: true });
    held.resumeEnabledAfterLane = await expect(resume).toBeEnabled({ timeout: 30000 }).then(() => true, () => false);
    if (held.resumeEnabledAfterLane) {
      const resumed = till.waitForResponse(r => /\/api\/sales\/[^/]+\/resume$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30000 });
      await resume.click();
      held.resumeStatus = (await resumed).status();
      await expect(paymentStep()).toBeVisible({ timeout: 30000 });
      await till.waitForTimeout(1200);
      await shot(till, `${tag}-g-resumed-payment-step.png`);
      phase(`${tag}: the resumed sale paid in cash`);
      await payCash();
      await till.waitForTimeout(1500);
      await shot(till, `${tag}-h-resumed-paid-cash.png`);
      held.door = await checkInNow(reg.id);
    } else {
      held.resumeLinesAfterLane = (await mine.locator('p.mt-1').allInnerTexts().catch(() => [])).map(flat);
      odd(`${tag}: Resume stayed shut after the lane came back`, { lines: held.resumeLinesAfterLane });
    }
  } else {
    odd(`${tag}: Hold sale was shut at the payment step: ${holdArea.reason ?? '(no line)'}`);
    await release();
  }
  knownSales.add(sale.id);
  const sold = await saleOf(sale.id);
  const regNow = await registrationOf(reg.id);
  const wire = wireFrom(st.wire0);
  const w = { salePosts: salePosts(wire).map(outcome), holdPosts: holdPosts(wire).map(outcome), resumePosts: resumePosts(wire).map(outcome), finalisePosts: finalisePosts(wire).map(outcome), boxIntents: boxIntents(wire).map(x => `${x.intent} ${outcome(x)}`), doorPosts: doorPosts(wire).map(x => `${x.path} ${outcome(x)}`) };
  const stillHeld = (await heldOnBranch()).filter(h => h.saleId === sale.id).length;
  const checks = {
    windowReproduced: /press Continue again/.test(st.gaveUp ?? '') && st.laneProbed && !st.refused,
    noCounterBoxLineHoldOpen: st.hold.holdEnabled && st.hold.counterBoxLines === 0 && st.hold.reason === null,
    heldOnce: held.status === 200 && w.holdPosts.length === 1 && held.listed === true && held.platformList?.length === 1 && held.platformList[0].kind === 'held',
    resumedOnce: held.resumeStatus === 200 && w.resumePosts.length === 1,
    paidCashOnce: sold.status === 'finalised' && sold.paymentAttempts.length === 1 && sold.paymentAttempts[0].method === 'cash' && sold.paymentAttempts[0].status === 'approved' && w.finalisePosts.length === 1 && w.finalisePosts[0] === 200 && w.salePosts.length === 1,
    noBoxIntent: w.boxIntents.length === 0,
    offTheHeldList: stillHeld === 0,
  };
  const ok = Object.values(checks).every(Boolean);
  const facts = [
    ['Family', `${guardianName(tag)} (${phone}), walk-in, two children no adult, drop-off form, no code`],
    ['Window', `every /api request aborted from the registration on (${st.abortedRegs} registration tries, ${st.abortedOther} others); "${st.gaveUp}"; restored with the box status read aborted (${st.statusReadsAborted ?? '?'} aborted reads while the sale was on screen)`],
    ['Payment step', `Hold sale ${st.hold.holdEnabled ? 'OPEN' : 'SHUT'}; line under it: ${st.hold.reason ? '"' + st.hold.reason + '"' : 'none'}; "working through its counter box" on screen ${st.hold.counterBoxLines}x`],
    ['Hold', held.pressed ? `POST /sales/:id/hold ${held.status}; toast "${held.toast ?? '-'}"; in the till's Held sales: ${held.listed}; platform's held list: ${JSON.stringify(held.platformList)}; sale status while held: ${held.saleWhileHeld}` : 'not pressed'],
    ['Resume while the lane said box', held.resumeWhileBox ? `button ${held.resumeWhileBox.enabled ? 'open' : 'shut'}; ${held.resumeWhileBox.lines.join(' | ') || 'no line'}` : '-'],
    ['Resume', held.pressed ? `status read let through; the box answered "platform" after ${held.laneBackAfterS ?? '?'} s; Resume open ${held.resumeEnabledAfterLane}; POST /sales/:id/resume ${held.resumeStatus ?? '-'}` : '-'],
    ['Sale', `${sold.id}: ${sold.status}, ${baht(sold.grossSatang)}; payments ${sold.paymentAttempts.map(a => `${a.method} ${a.status} ${baht(a.amountSatang)}`).join(', ') || 'none'}; still on the held list: ${stillHeld}`],
    ['Till requests', `sale POST ${w.salePosts.join(', ')}; hold ${w.holdPosts.join(', ')}; resume ${w.resumePosts.join(', ')}; cash press ${w.finalisePosts.join(', ')}; door ${w.doorPosts.join(', ') || 'none'}; box intents ${w.boxIntents.join(', ') || 'none'}`],
    ['Children after the resumed payment', `${held.door?.shown ? 'Check in now offered' : 'no Check in now offered'}; registration: ${regNow.children.map(c => `${c.childName} ${c.status}`).join('; ')}`],
    ['Checks', Object.entries(checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; ')],
  ];
  await storyPicture('02-hold-sale-in-the-window-held-resumed-paid-once.png', 'SCRUM-897 point 2 — Hold sale on the online drop-off sale in the long-outage window', [
    { file: `${tag}-d-hold-sale-area.png`, caption: 'Payment step, lane still on the box: Hold sale open, no counter-box line', width: 300 },
    { file: `${tag}-f-held-sales-panel.png`, caption: 'Held: the sale in Held sales (who held it masked)', width: 380 },
    { file: `${tag}-h-resumed-paid-cash.png`, caption: 'Resumed and paid in cash once', width: 520 },
  ], facts);
  point('2', ok, '02-hold-sale-in-the-window-held-resumed-paid-once.png', `In the window the payment step showed Hold sale open with no counter-box line; the sale was held (in Held sales on the till and on the platform), resumed once the lane was back, and paid in cash once`, { checks, st: { hold: st.hold, gaveUp: st.gaveUp }, held, sale: sold, wire: w, registration: regNow.children.map(c => ({ name: c.childName, status: c.status })) });
  receipt.checks.point3windows = [...(receipt.checks.point3windows ?? []), { tag, heldErrorBefore: st.heldErrorBefore, heldFailed: st.heldFailed, heldErrorGone: st.heldErrorGone, heldErrorGoneAfterAgainMs: st.heldErrorGoneAfterAgainMs, reads: st.heldReadsAfterFailure, hold: st.hold }];
  save();
}

// ---- 3b (run 03): the same re-read, where the Held sales panel is on screen ----
// In the window the till is on the drop-off form (step 7), where the order column and its Held sales panel are not drawn
// (Till.tsx draws them only while step < 6), so run 02 could show "could not be read" only on the wire. Here the family's
// online sale is held, which takes the till back to its first screen, where the panel is drawn. From then on every read of
// the list is aborted until the till's box status read answers "platform" (the status read is still aborted, so the lane
// stays on the box): the panel says "could not be read". Then the status read is let through; the box answers "platform",
// the lane moves back, and the list must be read again at once, not at its next 20 s timer, and the line must go. The
// aborted timer reads give the timer's own rhythm, so a re-read off that rhythm is the till's own. Then Resume, cash.
async function point3b() {
  const tag = 'g3', phone = numbers.g1;
  const kids = [{ name: 'ZZ TEST Pim 897', age: 6 }, { name: 'ZZ TEST Fah 897', age: 7 }];
  const { st, release } = await longOutageToPayment({ tag, phone, kids });
  const sale = await saleWritten(`dropoff-sale-${tag}`);
  const holdLabel = `ZZ TEST SCRUM-${T} held ${tag}-${RUN}`;
  assert.ok(st.hold.holdEnabled, 'Hold sale open on the online sale');
  phase(`${tag}: the sale held, so the till is back at its first screen where Held sales is drawn; the lane still says box`);
  await till.getByTestId('hold-sale-buttons').getByRole('button', { name: 'Hold sale', exact: true }).click();
  const dialog = till.getByTestId('hold-sale-dialog');
  await dialog.waitFor();
  await dialog.locator('#hold-label').fill(holdLabel);
  const answered = till.waitForResponse(r => /\/api\/sales\/[^/]+\/hold$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30000 });
  await dialog.getByRole('button', { name: 'Hold sale', exact: true }).click();
  const holdStatus = (await answered).status();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await english().catch(() => {});
  const mine = till.getByTestId('held-sale').filter({ hasText: holdLabel });
  await mine.waitFor({ timeout: 30000 });
  await till.waitForTimeout(1000);
  phase(`${tag}: every read of the list now reaches nothing until the box answers "platform"`);
  let releasedAt = Infinity;
  const laneSeenBack = () => receipt.probes.some(p => p.t > releasedAt && p.lane === 'platform');
  const abortedReads = [];
  const heldMatcher = url => new URL(url).pathname === '/api/sales/held';
  const heldAbort = route => { if (!laneSeenBack()) { abortedReads.push(Date.now()); return route.abort('failed'); } return route.fallback(); };
  await till.route(heldMatcher, heldAbort);
  await expect.poll(() => abortedReads.length, { timeout: 30000 }).toBeGreaterThan(0);
  await expect.poll(async () => Boolean(await heldError()), { timeout: 5000 }).toBe(true).catch(() => {});
  const errorShown = await heldError();
  const firstFailedAt = abortedReads[0];
  await till.waitForTimeout(500);
  await clipShot(till, `${tag}-a-held-sales-could-not-be-read.png`, till.getByTestId('held-sales'));
  await shot(till, `${tag}-a-first-screen-held-sales-could-not-be-read.png`);
  phase(`${tag}: the box status read let through; waiting for the lane to move back`);
  await till.waitForTimeout(1500);
  releasedAt = Date.now();
  await release();
  const probeBack = await expect.poll(() => laneSeenBack(), { timeout: 40000, intervals: [250] }).toBe(true).then(() => receipt.probes.find(p => p.t > releasedAt && p.lane === 'platform').t, () => null);
  const gone = await expect.poll(async () => (await heldError()) === null, { timeout: 30000, intervals: [250] }).toBe(true).then(() => Date.now(), () => null);
  const reread = receipt.held.find(h => h.t > releasedAt && h.status === 200) ?? null;
  await till.waitForTimeout(500);
  await clipShot(till, `${tag}-b-held-sales-read-again.png`, till.getByTestId('held-sales'));
  await till.unroute(heldMatcher, heldAbort).catch(() => {});
  // The timer's rhythm, from its own aborted reads: the next read it would have made after the box answered.
  const cadence = abortedReads.length >= 2 ? (abortedReads[abortedReads.length - 1] - abortedReads[0]) / (abortedReads.length - 1) : 20000;
  const lastTimer = abortedReads[abortedReads.length - 1];
  const nextTimerAt = lastTimer + Math.max(1, Math.ceil(((probeBack ?? lastTimer) - lastTimer) / cadence)) * cadence;
  const facts3 = {
    holdStatus,
    abortedReadsSecondsAfterFirst: abortedReads.map(t => +((t - firstFailedAt) / 1000).toFixed(1)), cadenceS: +(cadence / 1000).toFixed(1),
    errorShown, releasedAfterFirstFailureS: +((releasedAt - firstFailedAt) / 1000).toFixed(1),
    boxSaidPlatformAfterReleaseS: probeBack ? +((probeBack - releasedAt) / 1000).toFixed(1) : null,
    rereadAfterBoxSaidPlatformS: reread && probeBack ? +((reread.t - probeBack) / 1000).toFixed(1) : null,
    rereadBeforeNextTimerS: reread ? +((nextTimerAt - reread.t) / 1000).toFixed(1) : null,
    lineGoneAfterBoxSaidPlatformS: gone && probeBack ? +((gone - probeBack) / 1000).toFixed(1) : null,
  };
  receipt.checks.point3b = facts3; save();
  phase(`${tag}: Resume, then cash`);
  const resume = mine.getByRole('button', { name: 'Resume', exact: true });
  await expect(resume).toBeEnabled({ timeout: 30000 });
  const resumed = till.waitForResponse(r => /\/api\/sales\/[^/]+\/resume$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30000 });
  await resume.click();
  const resumeStatus = (await resumed).status();
  await payCash();
  await till.waitForTimeout(1500);
  await shot(till, `${tag}-c-resumed-paid-cash.png`);
  knownSales.add(sale.id);
  const sold = await saleOf(sale.id);
  const checks = {
    windowReproduced: /press Continue again/.test(st.gaveUp ?? '') && st.laneProbed && !st.refused,
    couldNotBeReadOnScreen: /Held sales could not be read/.test(errorShown ?? ''),
    boxSaidPlatform: probeBack !== null,
    readAgainAtOnce: facts3.rereadAfterBoxSaidPlatformS !== null && facts3.rereadAfterBoxSaidPlatformS < 5 && facts3.rereadBeforeNextTimerS > 1.5,
    lineGone: facts3.lineGoneAfterBoxSaidPlatformS !== null && facts3.lineGoneAfterBoxSaidPlatformS < 6,
    resumedAndPaidCashOnce: resumeStatus === 200 && sold.status === 'finalised' && sold.paymentAttempts.length === 1 && sold.paymentAttempts[0].method === 'cash',
  };
  const ok = Object.values(checks).every(Boolean);
  const facts = [
    ['Family', `${guardianName(tag)} (${phone}), walk-in, two children no adult; the long-outage window as in points 1 and 2; the online sale held (POST /sales/:id/hold ${holdStatus}) so the till is back at its first screen`],
    ['While the lane said box', `every read of the list aborted until the box said "platform": ${abortedReads.length} timed read(s) at +${facts3.abortedReadsSecondsAfterFirst.join(' s, +')} s (the timer, every ${facts3.cadenceS} s); the panel said: ${errorShown ? '"' + errorShown + '"' : 'NOTHING'}`],
    ['Lane back', `status read let through ${facts3.releasedAfterFirstFailureS} s after the first failed read; the box answered "platform" ${facts3.boxSaidPlatformAfterReleaseS ?? '?'} s later`],
    ['Read again', reread ? `answered 200 ${facts3.rereadAfterBoxSaidPlatformS} s after the box said "platform", ${facts3.rereadBeforeNextTimerS} s before the timer's next read was due` : 'NOT read again'],
    ['Line gone', gone ? `${facts3.lineGoneAfterBoxSaidPlatformS} s after the box said "platform"` : 'NOT gone within 30 s'],
    ['Then', `Resume ${resumeStatus}; sale ${sold.id}: ${sold.status}, ${baht(sold.grossSatang)}; payments ${sold.paymentAttempts.map(a => `${a.method} ${a.status} ${baht(a.amountSatang)}`).join(', ')}`],
    ['Checks', Object.entries(checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; ')],
  ];
  await storyPicture('03b-held-sales-read-again-on-screen.png', 'SCRUM-897 point 3 — Held sales, which could not be read, is read again as soon as the platform answers', [
    { file: `${tag}-a-held-sales-could-not-be-read.png`, caption: 'Lane on the box, every read of the list failing: "could not be read" (who held it masked)', width: 420 },
    { file: `${tag}-b-held-sales-read-again.png`, caption: 'Seconds after the box says the link is up: read again, the line gone', width: 420 },
  ], facts);
  point('3b', ok, '03b-held-sales-read-again-on-screen.png', `On the till's first screen in the window, Held sales said it could not be read while the lane was on the box; ${facts3.rereadAfterBoxSaidPlatformS ?? '?'} s after the box said the link was up the list was read again (${facts3.rereadBeforeNextTimerS ?? '?'} s before its timer) and the line went; the held sale was then resumed and paid in cash once`, { checks, facts3, sale: sold });
}

// ---- 3: drawn from both windows ----
async function point3() {
  const windows = receipt.checks.point3windows ?? [];
  const judged = windows.map(w => {
    const firstOk = (w.reads ?? []).find(r => r.outcome === 200) ?? null;
    return { ...w, firstOk, pass: Boolean(w.heldFailed && w.heldErrorBefore && w.heldErrorGone && firstOk && firstOk.secondsAfterFailedRead < 15 && (firstOk.secondsAfterRegistrationAnswered ?? 99) < 5 && w.heldErrorGoneAfterAgainMs < 15000) };
  });
  const ok = judged.length > 0 && judged.every(j => j.pass);
  const tagOf = j => j.tag;
  const facts = judged.flatMap(j => [
    [`Window ${tagOf(j)}: before Continue again`, `the list's timed read aborted while the lane was on the box; the panel said: ${j.heldErrorBefore ? '"' + j.heldErrorBefore + '"' : 'NOTHING'}`],
    [`Window ${tagOf(j)}: after Continue again`, `the first read answered 200 came ${j.firstOk ? `${j.firstOk.secondsAfterFailedRead} s after the failed timed read (its timer is 20 s) and ${j.firstOk.secondsAfterRegistrationAnswered} s after the platform answered the registration` : 'NEVER'}; "could not be read" gone after ${(j.heldErrorGoneAfterAgainMs / 1000).toFixed(1)} s from the press: ${j.heldErrorGone}`],
    [`Window ${tagOf(j)}: list reads after the failure`, JSON.stringify(j.reads)],
  ]);
  await storyPicture('03-held-sales-read-again-when-the-platform-answers.png', 'SCRUM-897 point 3 — the Held sales list is read again as soon as the platform answers', [
    { file: 'g1-c-held-sales-could-not-be-read.png', caption: 'g1, before Continue again: the timed read failed while the lane was on the box', width: 420 },
    { file: 'g1-d-payment-step-online-hold-sale-open.png', caption: 'g1, a few seconds after Continue again: no "could not be read"', width: 640 },
  ], [...facts, ['Pass rule', 'a read answered 200 within 5 s of the platform answering the registration, before the 20 s timer (under 15 s after the failed read), and the line gone within 15 s of the press — in every window']]);
  point('3', ok, '03-held-sales-read-again-when-the-platform-answers.png', `In ${judged.length} window(s) the Held sales list, which could not be read, was read again ${judged.map(j => j.firstOk ? j.firstOk.secondsAfterRegistrationAnswered + ' s' : 'never').join(' and ')} after the platform answered the registration, and "could not be read" went away`, { windows: judged });
}

// ---- 4a: a till offline from the start sells through its box; the box-lane use is still counted on the till ----
async function point4a() {
  phase('4a: offline from the start — every platform request aborted, the virtual box path left open');
  const before = await codeCounts();
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
  let applied = null, hold = null, again = null;
  try {
    await typeNumber(numbers.offline);
    await ticket(1, 1, { go: false });
    applied = await applyPromo(CODE_B);
    await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
    await expect(paymentStep()).toBeVisible({ timeout: 45000 });
    await till.waitForTimeout(1500);
    hold = await holdState();
    await shot(till, '04a-1-offline-payment-step-on-box.png');
    await clipShot(till, '04a-1-hold-sale-area.png', till.getByTestId('hold-sale-buttons').locator('xpath=..'), 16);
    await payCash();
    await till.waitForTimeout(1500);
    await shot(till, '04a-2-offline-paid-cash-on-box.png');
    phase('4a: the next customer at the same till, still offline, the same code');
    await nextCustomer();
    await typeNumber(numbers.probe);
    await ticket(1, 1, { go: false });
    again = await applyPromo(CODE_B);
    await shot(till, '04a-3-next-customer-same-code-refused-by-the-till.png');
    await clipShot(till, '04a-3-promo-box.png', promoBox().locator('xpath=..'), 16);
    await cancelOrder();
  } catch (error) {
    trace.push(firstLine(error));
    trace.push('screen: ' + flat(await till.locator('main, [role="dialog"]').first().innerText().catch(() => '')).slice(0, 300));
    await shot(till, '04a-x-offline-not-completed.png').catch(() => {});
  }
  const wire = wireFrom(wire0);
  const intents = allBoxIntents(wire).map(w => ({ intent: w.intent, outcome: outcome(w) }));
  phase('4a: network restored; the box hands the sale to the platform');
  await till.unroute('**/api/**', offline);
  let synced = null;
  await expect.poll(async () => { synced = (await newSales()).find(s => s.status === 'finalised') ?? null; return Boolean(synced); }, { timeout: 180000, intervals: [5000] }).toBe(true).catch(() => {});
  if (synced) { knownSales.add(synced.id); receipt.created.push({ kind: 'offline-box-sale', id: synced.id }); save(); }
  const sold = synced ? await saleOf(synced.id) : null;
  const after = await codeCounts();
  const checks = {
    codeTakenOffline: Boolean(applied?.badge) && !applied?.refusal,
    holdShutWithBoxLine: Boolean(hold) && !hold.holdEnabled && /counter box/.test(hold.reason ?? ''),
    soldThroughTheBox: intents.some(i => /^sale\./.test(i.intent ?? '')) && trace.length === 0,
    tillCountedTheBoxUse: /has reached its total usage limit/.test(again?.refusal ?? ''),
    finalisedOnPlatformWithCode: Boolean(sold && sold.status === 'finalised' && sold.discounts.some(d => d.code === CODE_B)),
    platformCountsOne: after[CODE_B]?.usedCount === 1,
  };
  const ok = Object.values(checks).every(Boolean);
  const facts = [
    ['How', `every /api request except /api/box/* aborted in the browser before the walk-in (${abortedPlatform} aborted); the virtual box answered on /api/box/v1/station/:id/*`],
    ['Code on the order (offline)', `${CODE_B} (10 %, use limit 1): ${applied?.badge ? 'taken' : 'NOT taken'}${applied?.badgeRow ? ' (' + applied.badgeRow + ')' : ''}${applied?.refusal ? '; refusal: ' + applied.refusal : ''}; price note: ${applied?.priceNote ?? 'none'}`],
    ['Payment step', hold ? `Hold sale ${hold.holdEnabled ? 'OPEN' : 'SHUT'}; line under it: "${hold.reason ?? ''}"` : 'not reached'],
    ['Box intents sent', intents.map(i => `${i.intent} ${i.outcome}`).join('; ') || 'none'],
    ['Next customer, same till, still offline', again ? `${numbers.probe}, ${CODE_B}: ${again.badge ? 'TAKEN' : 'refused'}; the line under the promo box: ${again.refusal ? '"' + again.refusal + '"' : 'none'}; order cancelled` : 'not reached'],
    ['Sale on the platform after the restore', sold ? `${sold.id}: ${sold.status}, ${baht(sold.grossSatang)}, discounts ${sold.discounts.map(d => `${d.code} -${baht(d.amountSatang)}`).join(', ') || 'none'}, payments ${sold.paymentAttempts.map(a => `${a.method} ${a.status} ${baht(a.amountSatang)}`).join(', ')}` : 'not seen within 3 min'],
    ['Use count of B on the platform', `before ${before[CODE_B]?.usedCount}, after ${after[CODE_B]?.usedCount}`],
    ['Problems', trace.join(' | ') || 'none'],
    ['Checks', Object.entries(checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; ')],
  ];
  await storyPicture('04a-box-lane-unchanged.png', 'SCRUM-897 point 4 — the ordinary box lane is unchanged', [
    { file: '04a-1-hold-sale-area.png', caption: 'Offline sale on the box: Hold sale shut with the counter-box line', width: 300 },
    { file: '04a-3-promo-box.png', caption: 'Next customer, still offline: the till\'s own copy counted the box\'s use', width: 420 },
  ], facts);
  point('4a', ok, '04a-box-lane-unchanged.png', 'A till offline from the start sold 1 kid + 1 adult with a code through its box: Hold sale shut with the counter-box line, cash on the box; the till\'s own copy then refused the used-up code to the next customer; after the restore the box handed the finalised sale to the platform, which counted one use', { checks, abortedPlatform, applied, hold, again, intents, sale: sold, before, after, trace });
  await home().catch(() => {});
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
  phase('sign in, make the codes and the own till');
  await adminSignIn();
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  assert.ok(branch); branchId = branch.id;
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online');
  receipt.checks.box = { slot: box.slot, role: box.role, status: box.status };
  for (const phone of Object.values(numbers)) assert.equal(await memberOf(phone), null, 'ZZ TEST number must be unused');
  receipt.checks.testNumbersUnusedBefore = true;
  const existing = (await call('GET', '/menu/discounts?includeArchived=true')).body.discounts;
  assert.ok(!existing.some(d => [CODE_A, CODE_B].includes(d.code) && !d.archivedAt), 'no live ZZTEST897 code left from an earlier run');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: branch.timezone ?? 'Asia/Bangkok' }).format(new Date());
  // Run 03: codes only for the points that use them; the label names the code (run 02's read "proof 2" for both).
  for (const [code, usageLimit, perCustomerLimit] of only.some(p => ['1', '5', '4a'].includes(p)) ? [[CODE_A, 2, 1], [CODE_B, 1, null]] : []) {
    const made = await call('POST', '/menu/discounts', { branchId, code, label: `ZZ TEST SCRUM-${T} proof ${code}`, kind: 'percent', valueBp: 1000,
      validFrom: today, validUntil: today, usageLimit, perCustomerLimit, stackable: false, active: true });
    assert.equal(made.status, 200, `code ${code} made`);
    codes[code] = { id: made.body.id };
    receipt.created.push({ kind: 'promo-code', code, id: made.body.id, usageLimit, perCustomerLimit, valueBp: 1000, validOn: today }); save();
  }
  receipt.checks.codesAtStart = await codeCounts();
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const printerSource = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(role => s.devices.some(d => d.role === role)));
  assert.ok(printerSource, 'simulated printers already configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: printerSource.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix, box: box.slot }); save();

  const video = resolve(import.meta.dirname, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  await tillContext.addInitScript(phrases => {
    window.__zzPhrases = {};
    setInterval(() => { const text = document.body?.innerText ?? ''; for (const p of phrases) if (!window.__zzPhrases[p] && text.includes(p)) window.__zzPhrases[p] = Date.now(); }, 200);
  }, PHRASES);
  till = await tillContext.newPage();
  watch(till, 'till');
  await till.goto(pos);
  phase('reception account signs in at the own till (new browser profile; the codes exist before the catalog is read)');
  await signInAtTill(till, need('STAGING_RECEPTION_PHONE'), need('STAGING_RECEPTION_PASSWORD'));
  receipt.checks.bundle = await till.evaluate(() => [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\/assets\/index-[^/]+\.js/.test(n)).map(n => n.split('/').pop()))]);
  save();

  if (only.includes('1')) await attempt('1', point1);
  if (only.includes('5')) await attempt('5', point5);
  if (only.includes('2')) await attempt('2', point2);
  if (only.includes('1') || only.includes('2')) await attempt('3', point3);
  if (only.includes('3b')) await attempt('3b', point3b);
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
      for (const sale of (await stationSales().catch(() => [])).filter(s => s.status === 'tendering' || s.status === 'paid')) await clean(`void ${sale.id}`, async () => {
        assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        receipt.cleanup.push({ kind: 'sale', id: sale.id, was: sale.status, status: 'voided', by: 'cleanup' });
      });
      for (const item of regs) await clean(`own registration ${item.tag}`, async () => {
        let reg = await registrationOf(item.id);
        assert.equal(reg.guardianName, guardianName(item.tag), 'only this run\'s own booking');
        for (const child of reg.children) assert.match(child.childName, /^ZZ TEST /);
        const waiting = reg.children.filter(c => c.status === 'registered');
        if (waiting.length) {
          const r = await till.request.post(`/api/checkin/registrations/${item.id}/cancel`, { data: { reason: `ZZ TEST SCRUM-${T} proof cleanup` }, headers: { 'idempotency-key': randomUUID() } });
          receipt.cleanup.push({ kind: 'cancel-own-booking', tag: item.tag, status: r.status() });
          if (r.status() !== 200) {
            // Paid and waiting (a resumed sale): checked in as the board does, then released below.
            const b = await till.request.post('/api/checkin/check-in-booked', { data: { entries: waiting.map(c => ({ checkinId: c.id })) }, headers: { 'idempotency-key': randomUUID() } });
            receipt.cleanup.push({ kind: 'check-in-booked-own', tag: item.tag, status: b.status() });
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
        const after = await registrationOf(item.id);
        const states = after.children.map(c => ({ id: c.id, status: c.status }));
        receipt.cleanup.push({ kind: 'registration', tag: item.tag, id: item.id, children: states });
        assert.ok(states.every(c => c.status === 'out' || c.status === 'cancelled'), 'nothing of this run is left waiting or in the park');
      });
      await clean('held list read-back', async () => {
        const mine = (await heldOnBranch()).filter(h => /ZZ TEST SCRUM-897/.test(h.label ?? ''));
        receipt.cleanup.push({ kind: 'held-read-back', ownHeld: mine.length });
        assert.equal(mine.length, 0);
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
        receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map(s => ({ id: s.id, status: s.status, grossSatang: s.totals?.grossSatang ?? s.grossSatang ?? null })) });
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
  for (const [code, { id }] of Object.entries(codes)) await clean(`archive code ${code}`, async () => {
    const row = (await call('GET', '/menu/discounts?includeArchived=true')).body.discounts.find(d => d.id === id);
    assert.ok(row && row.code === code && /^ZZ TEST SCRUM-897/.test(row.label), 'only this run\'s own code');
    if (!row.archivedAt) assert.equal((await call('DELETE', `/menu/discounts/${id}`)).status, 200);
    const after = (await call('GET', '/menu/discounts?includeArchived=true')).body.discounts.find(d => d.id === id);
    assert.ok(after.archivedAt && after.active === false);
    const live = (await call('GET', '/menu/discounts')).body.discounts.some(d => d.id === id);
    assert.equal(live, false);
    receipt.cleanup.push({ kind: 'promo-code', code, id, archived: true, active: after.active, usedCount: after.usedCount, inLiveList: live });
  });
  if (process.env.KEEP_MEMBERS !== '1') for (const [key, phone] of Object.entries(numbers)) await clean(`check test number ${key}`, async () => {
    const member = await memberOf(phone);
    if (member) {
      assert.ok(`${member.nickname ?? ''} ${member.name ?? ''}`.includes(`ZZ TEST SCRUM-${T}`), 'only own named test members');
      assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
      receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true, readBack: (await memberOf(phone)) === null ? 'gone from lookup' : 'STILL FOUND' });
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
