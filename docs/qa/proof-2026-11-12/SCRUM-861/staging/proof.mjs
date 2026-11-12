// SCRUM-861 staging proof: drop-off band printer, Add time reprints, VOID/UPDATED kitchen and bar slips.
// Adapted from the committed harnesses beside this folder (SCRUM-871 drop-off, SCRUM-865 F&B and History,
// SCRUM-876 party in the OTO App) and SCRUM-846's Console station form harness (proof-2026-11-11).
//
// Own ZZ TEST till and ZZ TEST simulated printers on Virtual box 1, invented numbers (08986100xx), cash only.
// Credentials are read by NAME from scripts/agent/env.mjs and never printed. Raw printer previews (they carry band
// codes) stay in the scratch folder; only masked composites are written beside this file.
//
//   node proof.mjs <phase>      phases, in order:
//     setup     ZZ TEST printers (kids band, adult band, drop-off band, receipt, kitchen, bar) and a ZZ TEST till
//     addresses each ZZ TEST printer its own simulator address (see ADDRESS; setup now gives them at creation)
//     p1        Console: the till's station form offers "Drop-off band printer"; assign the ZZ TEST one, save, reopen
//     p2a       drop-off sale (child 6, no adult, the form, cash), Check in now: the band on dropoff_band
//     p2b       ordinary sale (1 child + 1 adult, cash): kids_band and adult_band
//     p3        History -> Add time +1 hour on p2b's sale, cash: each band printed again on its own role, new time
//     p2c       Console: drop-off printer removed; History reprint of p2a's band and a new drop-off -> kids_band
//     retake    History's reprint record of p2a's band again, its band code blacked out (picture 02d)
//     p4        F&B dish + drink, cash; manager refunds the drink by item, then the rest whole; replays
//     p5        party: the till named for party slips, a ZZ TEST party (Floresta package) printed by the job,
//               its kitchen plan changed, then deleted; the branch's party slips station set back to none
//     p5record  point 5 read back from the print record and the audit trail (read-only; the verdict of point 5)
//     odd       point 2a's first attempt read back (picture 06b)
//     compose   the masked pictures of the printouts (offline; ONLY=2,2b,3,2c,4,5)
//     cleanup   everything this run made, read back; sessions signed out
//   env: OTO_SCRATCH (raw previews and state; default the session scratch folder), P2A_KEY (default drop1b)
//
// As run on 12 November 2026, main 26bf5a64 (api dep-dbqk5ojrjlhs738i12f0 live 04:43:09 UTC; pos-web
// dep-dbqk5r5g1s2s73ej5e5g 04:42:25; console dep-dbqk5sgae00c738l7njg 04:40:17; pos dep-dbqk5pdg1s2s73ej596g 04:39:58):
//   setup 05:04 UTC. p1 attempt 1 (receipt-p1-attempt-1.json) saved the assignment but reopened the form before the
//   list re-read the till: it showed config v1 and "Not set" (picture 06a). Attempt 2 read the select before the box's
//   devices loaded after a reload. p1 as kept: 05:07.
//   p2a: a try at 05:10 stopped on a click timeout before any record was made; the try at 05:13
//   (receipt-p2a-attempt-1.json, ZZ TEST Mint) routed the band to dropoff_band but the box skipped every job,
//   DEVICE_NO_ADDRESS: the printers had no address (picture 06b). After `addresses` (05:18), p2a passed at 05:21.
//   p2b 05:24, p3 05:26, p2c 05:28, retake 05:37, p4 05:39 (all on 26bf5a64).
//   p5 05:43-05:53: another lane's deploy b627077e (check-in board cancel; no change to the SCRUM-861 files) went
//   live on the api at 05:46:21, after the change slips (05:46:01) and before the delete (05:48:22). The api's
//   restart also restarted the in-process virtual box, whose simulators number printouts from 1 again, so p5's own
//   count saw no new printout for the delete and wrote FAIL in receipt-p5.json; the VOID slips had printed (05:49:15).
//   p5record reads the print record and the audit trail instead: PASS. Printouts are now keyed by number and time.
//   cleanup 05:54.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const PHASE = process.argv[2];
const out = import.meta.dirname;
const scratch = process.env.OTO_SCRATCH ?? 'C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/s861p';
const raw = resolve(scratch, 'raw');
mkdirSync(raw, { recursive: true });
const T = '861';
const POS = 'https://oto-pos-web-staging.onrender.com';
const CONSOLE = 'https://oto-console-staging.onrender.com';
const LAUNCHER = 'https://oto-launcher-staging.onrender.com';
const APP = 'https://oto-app-staging.onrender.com';
const APP_FLORESTA = '6427e84d-723f-4dbd-be58-8ef89cf7dc99';
const FLORESTA_PACKAGE = '391b269d-159a-4039-89a2-51ac132da747';
const zz = i => '08986100' + String(10 + i);
const NUMBERS = { drop1: zz(0), ordinary: zz(1), drop2: zz(2), drop1b: zz(3) };
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());

// ---- state (ids only) and receipts ----
const stateFile = resolve(scratch, 'state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { created: [] };
const saveState = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
const receipt = { ticket: 'SCRUM-861', phase: PHASE, startedAt: new Date().toISOString(), step: null, points: {}, requests: [], odd: [], pageErrors: [], notes: [] };
const OFFLINE = ['compose'].includes(PHASE);
const receiptFile = resolve(OFFLINE ? scratch : out, `receipt-${PHASE}.json`);
/** The receipt, with any staff name the run met written as [staff] (names show on reprint and refund records). */
const staffNames = new Set();
const save = () => writeFileSync(receiptFile, [...staffNames].sort((x, y) => y.length - x.length)
  .reduce((text, n) => text.replace(new RegExp(`(?<![A-Za-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'g'), '[staff]'), JSON.stringify(receipt, null, 2)) + '\n');
const step = v => { receipt.step = v; save(); console.log(new Date().toISOString(), v); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.step, what, ...extra }); save(); console.log('ODD', what); };
const point = (key, verdict, picture, shows, seen = {}) => { receipt.points[key] = { verdict, picture, shows, seen }; save(); console.log('POINT', key, verdict, '|', shows); };
const firstLine = e => `${e?.name ?? 'Error'}: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`;
const flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const baht = t => Number(String(t ?? '').replace(/[^\d.]/g, ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const idPath = p => p.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id');

// ---- the admin api through the till's origin ----
const admin = await request.newContext({ baseURL: POS });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let r = await once();
  if (r.status() === 401) { await adminSignIn(); r = await once(); }
  const body = await r.json().catch(() => null);
  receipt.requests.push({ via: 'admin api', method, path: idPath(path), status: r.status(), ...(r.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: r.status(), body, headers: r.headers() };
};
const readSale = async id => (await call('GET', `/sales/${id}`)).body;
const stationSales = async () => (await call('GET', `/sales?branchId=${state.branchId}&stationId=${state.station.id}&limit=50`)).body.sales;
const memberOf = async phone => (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body?.member ?? null;
const registrationOf = async id => (await call('GET', '/checkin/registrations/' + id)).body;
const jobFacts = j => ({ id: j.id, kind: j.kind, role: j.role, device: j.deviceLabel ?? deviceName(j.deviceId), status: j.status, subjectType: j.subjectType ?? null,
  reprint: j.reprintOf ? 'copy' : null, reprintReason: j.reprintReason ?? null, queuedAt: j.queuedAt ?? null });
const deviceName = id => Object.entries(state.devices ?? {}).find(([, d]) => d.id === id)?.[1]?.label ?? (id ? 'not a ZZ TEST printer' : null);

// ---- the simulated printers: what each drew ----
async function printouts(role) {
  const dev = state.devices[role];
  const r = await call('GET', `/devices/${dev.id}/printouts?limit=20`);
  if (r.status !== 200) return { status: r.status, code: r.body?.error?.code ?? null, printouts: [] };
  return { status: 200, printouts: r.body.printouts };
}
/**
 * A printout's key: its number and when it was drawn. The simulator lives in the api process and numbers from 1
 * again when the api restarts (a deploy mid-run did, at 05:46 UTC), so the number alone would hide a new printout.
 */
const keyOf = p => `${p.seq}@${p.at}`;
const seqsOf = async role => (await printouts(role)).printouts.map(keyOf);
/** Wait for printouts on a printer past the ones already seen; answers the new ones (newest last). */
async function newPrintouts(role, seen, { want = 1, timeout = 90000 } = {}) {
  const deadline = Date.now() + timeout;
  let fresh = [];
  while (Date.now() < deadline) {
    const now = (await printouts(role)).printouts;
    fresh = now.filter(p => !seen.includes(keyOf(p)));
    if (fresh.length >= want) return fresh;
    await sleep(3000);
  }
  return fresh;
}
/** Save a printout's PNG (raw: it may carry a band code) under the scratch folder. */
async function keepPreview(role, p, name) {
  const dev = state.devices[role];
  const r = await admin.get(`/api/devices/${dev.id}/printouts/${p.seq}/preview.png`);
  assert.equal(r.status(), 200, 'preview read');
  const file = resolve(raw, name);
  writeFileSync(file, await r.body());
  receipt.notes.push({ preview: name, role, seq: p.seq, at: p.at, widthDots: p.widthDots, heightDots: p.heightDots });
  save();
  return file;
}
/** The print jobs of a sale (GET /sales/:id) until each named one has printed. */
async function jobsPrinted(saleId, filter = () => true, timeout = 90000) {
  let jobs = [];
  await expect.poll(async () => { jobs = ((await readSale(saleId)).printJobs ?? []).filter(filter); return jobs.length > 0 && jobs.every(j => j.status === 'printed'); }, { timeout, intervals: [2000] }).toBe(true);
  return jobs;
}

// ---- browsers ----
let browser = null;
async function launch() {
  const video = resolve(scratch, 'camera.y4m');
  const width = 320, height = 240;
  if (!existsSync(video)) writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser ??= await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  return browser;
}
const openPages = [];
function watch(page, label) {
  openPages.push({ page, label });
  page.on('pageerror', e => { receipt.pageErrors.push({ page: label, at: receipt.step, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); save(); });
  page.on('console', m => { if (m.type() === 'error') { receipt.pageErrors.push({ page: label, at: receipt.step, kind: 'console.error', text: m.text().split('\n')[0].slice(0, 240) }); save(); } });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) { receipt.pageErrors.push({ page: label, at: receipt.step, kind: 'http', text: `${r.request().method()} ${idPath(u.pathname)} ${r.status()}` }); save(); } });
}
async function learnNames(page, base) {
  const me = await page.evaluate(async (u) => (await (await fetch(u, { credentials: 'include' })).json()), base + '/api/me').catch(() => null);
  for (const o of [me?.employee, me?.account]) for (const k of ['name', 'nickname']) {
    const v = o?.[k]; if (typeof v === 'string' && v.trim().length >= 2) { staffNames.add(v.trim()); for (const part of v.trim().split(/\s+/)) { const w = part.replace(/[()]/g, ''); if (w.length >= 3 && !/^(Manager|Reception|Owner|Khun)$/i.test(w)) staffNames.add(w); } }
  }
}
/** A Console picture: staff names blacked out, the signed-in corner and passwords masked (no codes on these screens). */
async function consoleShot(page, name) {
  await redactNames(page);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByRole('button', { name: 'Sign out', exact: true }).locator('..'), page.locator('input[type="password"]')] });
  console.log('picture', name);
  return name;
}
/** Staff names and band codes (a till prefix, a dash, a code with a letter in it) blacked out in the page's text. */
async function redactNames(page) {
  await page.evaluate((needles) => {
    const list = needles.filter(Boolean).sort((a, b) => b.length - a.length);
    const code = () => /Z\d{5}-(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,8}/g;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const hits = [];
    while (w.nextNode()) {
      const v = w.currentNode.nodeValue || '';
      if (list.some(s => v.toLowerCase().includes(s.toLowerCase())) || code().test(v)) hits.push(w.currentNode);
    }
    const bar = m => `<span style="background:#3f3f46;color:#3f3f46">${'█'.repeat(m.length)}</span>`;
    for (const t of hits) {
      let h = (t.nodeValue || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      for (const s of list) h = h.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), bar);
      h = h.replace(code(), bar);
      const sp = document.createElement('span'); sp.innerHTML = h; t.parentNode.replaceChild(sp, t);
    }
  }, [...staffNames]).catch(() => {});
}
/** Staff names on the page are blacked out (text runs), then the picture; account corner, passwords, codes and QR masked. */
async function shot(page, name, extra = []) {
  await redactNames(page);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
      page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/), page.locator('div.grid.gap-px'),
      page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/), page.locator('label:has(input[type="checkbox"])'),
      page.getByRole('button', { name: 'Sign out', exact: true }).locator('..'), ...extra] });
  console.log('picture', name);
  return name;
}

// ---- the till (adapted from SCRUM-871 / SCRUM-865) ----
const halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digits) => { for (const d of digits) await scope.getByRole('button', { name: d, exact: true }).last().click(); };
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
async function openTill(phoneKey, passwordKey, label) {
  const b = await launch();
  const ctx = await b.newContext({ baseURL: POS, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(POS);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: state.station.name, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000; let steady = 0;
  while (Date.now() < deadline) {
    if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } steady = 0; }
    else if (await landing(page).isVisible()) { steady += 1; if (steady >= 6) break; } else steady = 0;
    await page.waitForTimeout(500);
  }
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
  await learnNames(page, POS);
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  receipt.notes.push({ signedIn: label, stationIsOwn: me?.station?.id ? me.station.id === state.station.id : null }); save();
  return { ctx, page };
}
const lastScreens = [];
/** Before a page is closed: its last picture (scratch only) and text, for a failure record. */
async function lastLook(page, label) {
  if (!page || page.isClosed()) return;
  await page.screenshot({ path: resolve(scratch, `last-${PHASE}-${label}.png`), animations: 'disabled', mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]')] }).catch(() => {});
  lastScreens.push(`[${label}] ` + flat(await page.locator('body').innerText().catch(() => '')).slice(0, 900));
}
async function closeTill(t) {
  if (!t) return;
  await lastLook(t.page, 'till');
  try {
    const before = (await t.page.request.get('/api/me')).status();
    if (before === 200) assert.equal((await t.page.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.notes.push({ signedOut: true, me: (await t.page.request.get('/api/me')).status() }); save();
  } catch (e) { odd('sign-out failed', { error: firstLine(e) }); }
  await t.ctx.close().catch(() => {});
}
async function walkIn(till, number) {
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
async function ticket(till, kids, adults) {
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
/** The "Children playing alone" form: each child's name, age, photo, allergy; the parent's name; every tick. */
async function fillGate(till, children, parent) {
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
  await half.getByPlaceholder('Your full name', { exact: true }).fill(parent);
  for (let i = 0; i < children.length; i++) {
    const card = cards().nth(i);
    const start = card.getByRole('button', { name: 'Start camera', exact: true });
    if (await start.count()) {
      await start.click();
      await card.getByRole('button', { name: 'Take photo', exact: true }).click();
      await card.getByAltText('Captured', { exact: true }).waitFor();
    }
    if (children[i].allergies) await card.locator('textarea').first().fill(children[i].allergies);
  }
  for (const checkbox of await half.getByRole('checkbox').all()) await checkbox.check();
  return half;
}
const isPath = (r, method, re) => r.request().method() === method && re.test(new URL(r.url()).pathname);
async function pressContinueToPayment(till) {
  const [registered] = await Promise.all([
    till.waitForResponse(r => isPath(r, 'POST', /^\/api\/checkin\/registrations$/), { timeout: 60000 }),
    till.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  return { status: registered.status(), reg: await registered.json().catch(() => null) };
}
async function saleWritten(known) {
  let sale;
  await expect.poll(async () => { sale = (await stationSales()).find(x => ['tendering', 'open'].includes(x.status) && !known.has(x.id)); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  return sale;
}
/** Cash on the ticket payment step; answers the finalise response's printing. */
async function payCash(till) {
  await expect(till.getByTestId('payment-step')).toBeVisible({ timeout: 30000 });
  await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded();
  const fin = till.waitForResponse(r => isPath(r, 'POST', /^\/api\/sales\/[^/]+\/finalise$/), { timeout: 60000 });
  await confirm.click();
  const answer = await (await fin).json().catch(() => null);
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
  return answer;
}
async function checkInNow(till, regId) {
  const now = till.getByRole('button', { name: 'Check in now', exact: true });
  await now.waitFor({ timeout: 20000 });
  const [res] = await Promise.all([
    till.waitForResponse(r => isPath(r, 'POST', /^\/api\/checkin\/check-in-now$/), { timeout: 60000 }),
    now.click(),
  ]);
  const body = await res.json().catch(() => null);
  await expect.poll(async () => (await registrationOf(regId)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
  await till.waitForTimeout(1500);
  return { status: res.status(), body };
}
async function openHistorySale(till, receiptNumber) {
  await till.goto('/'); await till.locator('a[href="/history"]').first().waitFor();
  await till.locator('a[href="/history"]').first().click();
  const search = till.getByPlaceholder(/^Search by name, receipt number/);
  await search.waitFor({ timeout: 20000 });
  await search.fill(receiptNumber);
  await till.getByText(receiptNumber, { exact: true }).first().click();
  await till.waitForTimeout(1500);
}

// ---- a drop-off sale, start to check-in ----
async function dropOffSale(till, key, childName, guardian, known) {
  await walkIn(till, NUMBERS[key]);
  await ticket(till, 1, 0);
  await fillGate(till, [{ name: childName, age: 6 }], guardian);
  const written = await pressContinueToPayment(till);
  assert.equal(written.status, 200, 'registration');
  state.created.push({ kind: 'registration', key, id: written.reg.id, guardian }); saveState();
  const sale = await saleWritten(known);
  state.created.push({ kind: 'sale', key, id: sale.id }); saveState();
  const fin = await payCash(till);
  known.add(sale.id);
  const checkin = await checkInNow(till, written.reg.id);
  return { regId: written.reg.id, saleId: sale.id, fin, checkin };
}

// =====================================================================================
const phases = {};

/**
 * The box finds a simulated printer by its address (packages/box-agent/src/printing/index.ts `open`), and a
 * device with none is refused DEVICE_NO_ADDRESS before the simulator is asked (printing/queue.ts `adapterFor`).
 * Each ZZ TEST printer gets its own address in TEST-NET-1 (192.0.2.0/24, never routed).
 */
const ADDRESS = { kids_band: '192.0.2.86:9101', adult_band: '192.0.2.86:9102', dropoff_band: '192.0.2.86:9103', receipt: '192.0.2.86:9104', kitchen: '192.0.2.86:9105', bar: '192.0.2.86:9106' };
phases.addresses = async () => {
  step('the ZZ TEST printers get their simulator addresses');
  for (const [role, d] of Object.entries(state.devices)) {
    const r = await call('PATCH', `/devices/${d.id}`, { address: ADDRESS[role] });
    assert.equal(r.status, 200, `address ${role}`);
    receipt.notes.push({ role, address: r.body.device.address });
  }
  save();
};

phases.setup = async () => {
  step('setup: branch, simulated box, unused numbers and prefix');
  const branch = (await call('GET', '/branches')).body.branches.find(b => /Central Floresta/.test(b.name));
  assert.ok(branch); state.branchId = branch.id;
  const box = (await call('GET', `/branches/${branch.id}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'Virtual box 1 online'); state.boxId = box.id;
  state.partySlipsStationIdAtStart = branch.partySlipsStationId;
  for (const [k, n] of Object.entries(NUMBERS)) assert.equal(await memberOf(n), null, `ZZ number ${k} unused`);
  const stations = (await call('GET', `/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  step('setup: ZZ TEST simulated printers on Virtual box 1');
  const defs = {
    kids_band: { kind: 'band_printer', label: 'ZZ TEST SCRUM-861 kids band printer', model: '4B-2082A', protocol: 'tspl2' },
    adult_band: { kind: 'band_printer', label: 'ZZ TEST SCRUM-861 adult band printer', model: '4B-2082A', protocol: 'tspl2' },
    dropoff_band: { kind: 'band_printer', label: 'ZZ TEST SCRUM-861 drop-off band printer', model: '4B-2082A', protocol: 'tspl2' },
    receipt: { kind: 'receipt_printer', label: 'ZZ TEST SCRUM-861 receipt printer', model: 'Xprinter XP-80', protocol: 'escpos' },
    kitchen: { kind: 'kitchen_printer', label: 'ZZ TEST SCRUM-861 kitchen printer', model: 'Xprinter XP-80', protocol: 'escpos' },
    bar: { kind: 'bar_printer', label: 'ZZ TEST SCRUM-861 bar printer', model: 'Xprinter XP-80', protocol: 'escpos' },
  };
  state.devices = state.devices ?? {};
  for (const [role, d] of Object.entries(defs)) {
    if (state.devices[role]) continue;
    const id = randomUUID();
    const r = await call('POST', `/boxes/${box.id}/devices`, { id, kind: d.kind, label: d.label, transport: 'simulated', model: d.model, protocol: d.protocol, address: ADDRESS[role] });
    assert.equal(r.status, 200, `device ${role}`);
    state.devices[role] = { id: r.body.device.id, label: d.label, kind: d.kind };
    state.created.push({ kind: 'device', role, id: r.body.device.id, label: d.label }); saveState();
  }
  step('setup: the ZZ TEST till, without a drop-off band printer (point 1 assigns it in the Console)');
  const name = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
  const devices = ['kids_band', 'adult_band', 'receipt', 'kitchen', 'bar'].map(role => ({ role, deviceId: state.devices[role].id }));
  const made = await call('POST', `/branches/${branch.id}/stations`, { name, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200, 'station');
  state.station = { id: made.body.station.id, name, prefix };
  state.created.push({ kind: 'station', id: made.body.station.id, name, prefix }); saveState();
  receipt.points.setup = { station: { name, prefix, devices: made.body.station.devices.map(d => ({ role: d.role, label: d.label })) }, partySlipsStationIdAtStart: branch.partySlipsStationId };
  save();
  console.log(JSON.stringify(receipt.points.setup, null, 1));
};

// ---- 1: the Console station form ----
async function openConsole() {
  const b = await launch();
  const ctx = await b.newContext({ baseURL: CONSOLE, viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  watch(page, 'console');
  await page.goto(CONSOLE);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/overview$/);
  await learnNames(page, CONSOLE);
  return { ctx, page };
}
/** The station's card on the list, once the list has read the config version the api now holds. */
async function cardReadsCurrent(page) {
  const row = (await call('GET', `/branches/${state.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === state.station.id);
  const card = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: state.station.name, exact: true }) });
  await expect(card).toContainText(`config v${row.configVersion}`, { timeout: 20000 });
  return row;
}
async function consoleStationDrawer(page) {
  if (!(await page.getByRole('button', { name: 'New station', exact: true }).isVisible().catch(() => false))) {
    await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
    await page.getByLabel('Branch').selectOption(state.branchId);
    await page.getByRole('button', { name: 'Stations', exact: true }).click();
  }
  const filter = page.getByPlaceholder('Name, identifier or type');
  if ((await filter.inputValue()) !== `ZZ TEST SCRUM-${T}`) await filter.fill(`ZZ TEST SCRUM-${T}`);
  await page.getByRole('button', { name: state.station.name, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: state.station.name, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}
const dropoffField = drawer => drawer.getByLabel(/^Drop-off band printer/);
async function closeConsole(c) {
  if (!c) return;
  await lastLook(c.page, 'console');
  try {
    const r = await c.ctx.request.post(CONSOLE + '/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
    receipt.notes.push({ consoleSignOut: r.status(), me: (await c.ctx.request.get(CONSOLE + '/api/me')).status() }); save();
  } catch (e) { odd('console sign-out failed', { error: firstLine(e) }); }
  await c.ctx.close().catch(() => {});
}
async function saveDrawer(page, drawer) {
  const waiting = page.waitForResponse(r => isPath(r, 'PATCH', new RegExp(`^/api/stations/${state.station.id}$`)));
  await drawer.getByRole('button', { name: 'Save the station', exact: true }).click();
  const res = await waiting;
  const body = await res.json().catch(() => null);
  receipt.requests.push({ via: 'console form', method: 'PATCH', path: '/stations/:id', status: res.status(), devicesSent: JSON.parse(res.request().postData() ?? '{}').devices?.map(d => d.role) ?? null });
  save();
  return { status: res.status(), body };
}

phases.p1 = async () => {
  // Attempt 1 saved the assignment and then reopened the form before the list had re-read the till (see the
  // receipt of attempt 1 and picture 06a); the till goes back to its five devices so the form starts "Not set".
  const now = (await call('GET', `/branches/${state.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === state.station.id);
  if (now.devices.some(d => d.role === 'dropoff_band')) {
    const devices = ['kids_band', 'adult_band', 'receipt', 'kitchen', 'bar'].map(role => ({ role, deviceId: state.devices[role].id }));
    assert.equal((await call('PATCH', `/stations/${state.station.id}`, { devices })).status, 200);
    receipt.notes.push({ resetBeforeRerun: 'drop-off band printer unassigned through the api, the other five kept' }); save();
  }
  const c = await openConsole();
  try {
    step('1: Console, Devices > Stations, the ZZ TEST till');
    let drawer = await consoleStationDrawer(c.page);
    await cardReadsCurrent(c.page);
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    drawer = await consoleStationDrawer(c.page);
    const field = dropoffField(drawer);
    await expect(field).toBeVisible();
    const labels = await drawer.locator('label').allInnerTexts();
    const roleOrder = labels.map(l => flat(l).split(' ').slice(0, 4).join(' ')).filter(l => /PRINTER|SCANNER|TERMINAL|DRAWER/.test(l)).slice(0, 12);
    const options = await field.locator('option').evaluateAll(os => os.map(o => ({ value: o.value, label: o.textContent.trim() })));
    const before = await field.inputValue();
    await field.selectOption(state.devices.dropoff_band.id);
    await field.scrollIntoViewIfNeeded();
    await c.page.waitForTimeout(400);
    await consoleShot(c.page, '01a-console-station-form-dropoff-band-printer-chosen.png');
    const saved = await saveDrawer(c.page, drawer);
    assert.equal(saved.status, 200, 'station saved');
    await expect(drawer).toHaveCount(0);
    step('1: the list re-reads the till; reopen the form');
    const row = await cardReadsCurrent(c.page);
    drawer = await consoleStationDrawer(c.page);
    const kept = await dropoffField(drawer).inputValue();
    await dropoffField(drawer).scrollIntoViewIfNeeded();
    await c.page.waitForTimeout(400);
    await consoleShot(c.page, '01-console-station-form-dropoff-band-printer-kept.png');
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    step('1: a fresh page, the form again');
    await c.page.reload();
    await c.page.getByRole('navigation', { name: 'Admin', exact: true }).waitFor();
    drawer = await consoleStationDrawer(c.page);
    // The select shows its value once the box's devices are read: wait for them before reading it.
    await expect.poll(async () => dropoffField(drawer).inputValue(), { timeout: 20000 }).toBe(state.devices.dropoff_band.id).catch(() => {});
    const keptAfterReload = await dropoffField(drawer).inputValue();
    await dropoffField(drawer).scrollIntoViewIfNeeded();
    await c.page.waitForTimeout(400);
    await consoleShot(c.page, '01b-console-station-form-kept-after-reload.png');
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => {});
    const roles = row.devices.map(d => ({ role: d.role, label: d.label }));
    const ok = before === '' && kept === state.devices.dropoff_band.id && keptAfterReload === state.devices.dropoff_band.id
      && roles.some(d => d.role === 'dropoff_band' && d.label === state.devices.dropoff_band.label)
      && options.every(o => o.value === '' || /— Band printer$/.test(o.label));
    point('1', ok ? 'PASS' : 'FAIL', '01-console-station-form-dropoff-band-printer-kept.png',
      'The till\'s station form asks for a "Drop-off band printer" right after the adult band printer, offering band printers only; the ZZ TEST drop-off band printer chosen and saved (PATCH 200); reopened (and again after a reload) it is kept; the api reads the role back',
      { fieldBefore: before === '' ? 'Not set' : before, optionsOffered: options.map(o => o.label), deviceFieldsInOrder: roleOrder, configVersionAfterSave: row.configVersion,
        keptIsTheZzPrinter: kept === state.devices.dropoff_band.id, keptAfterReload: keptAfterReload === state.devices.dropoff_band.id, readBack: roles });
  } finally { await closeConsole(c); }
};

// ---- 2a: a drop-off with the drop-off printer assigned ----
phases.p2a = async () => {
  const known = new Set((await stationSales()).map(s => s.id));
  const seen = { dropoff_band: await seqsOf('dropoff_band'), kids_band: await seqsOf('kids_band') };
  const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
  try {
    step('2a: drop-off sale, a child aged 6, no adult, the form, cash, Check in now');
    // Attempt 1 (key drop1, ZZ TEST Mint) routed the band to dropoff_band but the box skipped it: the ZZ TEST
    // printers had no address yet (receipt-p2a-attempt-1.json). This run uses a new family once they have one.
    const key = process.env.P2A_KEY ?? 'drop1b';
    const r = await dropOffSale(t.page, key, key === 'drop1' ? `ZZ TEST Mint ${T}` : `ZZ TEST Mali ${T}`, `ZZ TEST SCRUM-${T} guardian ${key === 'drop1' ? 'A' : 'A2'}`, known);
    await shot(t.page, '02a-till-dropoff-paid-and-checked-in.png');
    const bandJobs = (r.checkin.body?.printJobs ?? []).map(jobFacts);
    const atSale = (r.fin?.printing?.jobs ?? []).map(jobFacts);
    const printed = await jobsPrinted(r.saleId, j => j.kind === 'kids_wristband');
    const fresh = await newPrintouts('dropoff_band', seen.dropoff_band);
    const kidsFresh = (await printouts('kids_band')).printouts.filter(p => !seen.kids_band.includes(keyOf(p)));
    if (fresh[0]) await keepPreview('dropoff_band', fresh.at(-1), 'p2a-dropoff-band.png');
    state.p2a = { saleId: r.saleId, regId: r.regId, receipt: (await readSale(r.saleId)).sale.receiptNumber, bandJobId: printed[0]?.id ?? null }; saveState();
    const ok = bandJobs.length === 1 && bandJobs[0].role === 'dropoff_band' && bandJobs[0].device === state.devices.dropoff_band.label
      && printed.length === 1 && printed[0].role === 'dropoff_band' && fresh.length === 1 && kidsFresh.length === 0;
    point('2a', ok ? 'PASS' : 'FAIL', '02-dropoff-band-on-dropoff-printer.png',
      'Drop-off sale (child 6, no adult, the form, cash): Check in now printed the child\'s band as a kids_wristband job with role dropoff_band on the ZZ TEST drop-off band printer; nothing on the kids band printer',
      { finaliseJobs: atSale, checkInJobs: bandJobs, saleJobsPrinted: printed.map(jobFacts), dropoffPrinterNew: fresh.length, kidsPrinterNew: kidsFresh.length });
  } finally { await closeTill(t); }
};

// ---- 2b: an ordinary sale ----
phases.p2b = async () => {
  const known = new Set((await stationSales()).map(s => s.id));
  const seen = { kids_band: await seqsOf('kids_band'), adult_band: await seqsOf('adult_band'), dropoff_band: await seqsOf('dropoff_band') };
  const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
  try {
    step('2b: ordinary sale, one child and one adult, cash');
    await walkIn(t.page, NUMBERS.ordinary);
    await ticket(t.page, 1, 1);
    const sale = await saleWritten(known);
    state.created.push({ kind: 'sale', key: 'ordinary', id: sale.id }); saveState();
    const fin = await payCash(t.page);
    await t.page.waitForTimeout(2000);
    await shot(t.page, '02b-till-ordinary-sale-paid-cash.png');
    const printed = await jobsPrinted(sale.id, j => /wristband/.test(j.kind));
    const kidsNew = await newPrintouts('kids_band', seen.kids_band);
    const adultNew = await newPrintouts('adult_band', seen.adult_band);
    if (kidsNew[0]) await keepPreview('kids_band', kidsNew.at(-1), 'p2b-kids-band.png');
    if (adultNew[0]) await keepPreview('adult_band', adultNew.at(-1), 'p2b-adult-band.png');
    const dropNew = (await printouts('dropoff_band')).printouts.filter(p => !seen.dropoff_band.includes(keyOf(p)));
    state.p2b = { saleId: sale.id, receipt: (await readSale(sale.id)).sale.receiptNumber }; saveState();
    const roles = printed.map(j => [j.kind, j.role, j.deviceLabel]).sort();
    const ok = roles.length === 2 && roles[0][1] === 'adult_band' && roles[0][2] === state.devices.adult_band.label && roles[1][1] === 'kids_band' && roles[1][2] === state.devices.kids_band.label
      && kidsNew.length === 1 && adultNew.length === 1 && dropNew.length === 0;
    point('2b', ok ? 'PASS' : 'FAIL', '02b-ordinary-bands-kids-and-adult.png',
      'Ordinary sale (1 child + 1 adult, cash): the child\'s band on kids_band (ZZ TEST kids band printer), the adult\'s on adult_band; nothing on the drop-off printer',
      { finaliseJobs: (fin?.printing?.jobs ?? []).map(jobFacts), printed: printed.map(jobFacts), kidsNew: kidsNew.length, adultNew: adultNew.length, dropoffNew: dropNew.length });
  } finally { await closeTill(t); }
};

// ---- 3: Add time on the ordinary sale ----
phases.p3 = async () => {
  const seen = { kids_band: await seqsOf('kids_band'), adult_band: await seqsOf('adult_band'), dropoff_band: await seqsOf('dropoff_band') };
  const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
  try {
    step('3: History -> the ordinary sale -> Add time +1 hour -> Cash');
    await openHistorySale(t.page, state.p2b.receipt);
    await t.page.getByRole('button', { name: 'Add time', exact: true }).click();
    const ext = t.page.getByRole('dialog', { name: 'Add time', exact: true });
    await ext.getByRole('button', { name: /^\+1 hour/ }).click();
    const [made] = await Promise.all([
      t.page.waitForResponse(r => isPath(r, 'POST', new RegExp(`^/api/sales/${state.p2b.saleId}/extensions$`))),
      ext.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
    ]);
    assert.equal(made.status(), 200, 'extension');
    const madeBody = await made.json();
    const chargeId = madeBody.sale.id;
    state.created.push({ kind: 'sale', key: 'add-time-charge', id: chargeId }); state.p3 = { chargeId, selection: madeBody.extension?.selection?.mode ?? null }; saveState();
    await ext.getByRole('button', { name: 'Cash', exact: true }).click();
    await t.page.waitForTimeout(800);
    await shot(t.page, '03a-till-add-time-cash-chosen.png');
    const fin = t.page.waitForResponse(r => isPath(r, 'POST', new RegExp(`^/api/sales/${chargeId}/finalise$`)), { timeout: 60000 });
    await ext.getByRole('button', { name: 'Record cash', exact: true }).click();
    const answer = await (await fin).json().catch(() => null);
    await expect(ext).toHaveCount(0, { timeout: 45000 });
    await t.page.waitForTimeout(1500);
    await shot(t.page, '03b-till-add-time-paid-cash.png');
    const copies = (answer?.printing?.jobs ?? []).filter(j => j.subjectType === 'band').map(jobFacts);
    const kidsNew = await newPrintouts('kids_band', seen.kids_band);
    const adultNew = await newPrintouts('adult_band', seen.adult_band);
    if (kidsNew[0]) await keepPreview('kids_band', kidsNew.at(-1), 'p3-kids-band-after-add-time.png');
    if (adultNew[0]) await keepPreview('adult_band', adultNew.at(-1), 'p3-adult-band-after-add-time.png');
    const dropNew = (await printouts('dropoff_band')).printouts.filter(p => !seen.dropoff_band.includes(keyOf(p)));
    const sourceJobs = ((await readSale(state.p2b.saleId)).printJobs ?? []).filter(j => /wristband/.test(j.kind)).map(jobFacts);
    const roles = copies.map(c => [c.kind, c.role, c.device, c.reprintReason]).sort();
    const ok = copies.length === 2 && roles[0][1] === 'adult_band' && roles[1][1] === 'kids_band' && roles.every(r => r[3] === 'Extra time added (+60 min)')
      && kidsNew.length === 1 && adultNew.length === 1 && dropNew.length === 0;
    point('3', ok ? 'PASS' : 'FAIL', '03-add-time-bands-reprinted-new-leave-time.png',
      'History -> Add time "+1 hour" on the ordinary sale, cash: the finalise answer carries a copy of each band on its own role (kids_band, adult_band) with "Extra time added (+60 min)"; both printers printed one band each',
      { extensionSelection: state.p3.selection, finaliseNotes: answer?.printing?.notes ?? null, copies, sourceSaleBandJobs: sourceJobs, kidsNew: kidsNew.length, adultNew: adultNew.length, dropoffNew: dropNew.length });
  } finally { await closeTill(t); }
};

// ---- 2c: the drop-off printer removed: the fallback ----
phases.p2c = async () => {
  const c = await openConsole();
  try {
    step('2c: Console, the drop-off band printer set back to "Not set"');
    let drawer = await consoleStationDrawer(c.page);
    await cardReadsCurrent(c.page);
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    drawer = await consoleStationDrawer(c.page);
    assert.equal(await dropoffField(drawer).inputValue(), state.devices.dropoff_band.id, 'assigned before the removal');
    await dropoffField(drawer).selectOption('');
    const saved = await saveDrawer(c.page, drawer);
    assert.equal(saved.status, 200);
    await expect(drawer).toHaveCount(0);
    await cardReadsCurrent(c.page);
    drawer = await consoleStationDrawer(c.page);
    const after = await dropoffField(drawer).inputValue();
    await dropoffField(drawer).scrollIntoViewIfNeeded();
    await c.page.waitForTimeout(400);
    await consoleShot(c.page, '02c-console-dropoff-band-printer-removed.png');
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => {});
    state.p2c = { consoleAfter: after === '' ? 'Not set' : after }; saveState();
    const roles = (await call('GET', `/branches/${state.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === state.station.id).devices.map(d => d.role);
    receipt.notes.push({ afterRemoval: { consoleField: state.p2c.consoleAfter, rolesReadBack: roles } }); save();
    assert.ok(!roles.includes('dropoff_band'));
  } finally { await closeConsole(c); }
  const known = new Set((await stationSales()).map(s => s.id));
  const seen = { kids_band: await seqsOf('kids_band') };
  const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
  try {
    step('2c: History -> the first drop-off sale -> Reprint "Child bracelet"');
    await openHistorySale(t.page, state.p2a.receipt);
    await t.page.getByTestId('reprint-sale').click();
    const dialog = t.page.getByRole('dialog').filter({ hasText: 'Items to reprint' });
    await dialog.getByRole('button', { name: /Child bracelet/ }).click();
    const [rep] = await Promise.all([
      t.page.waitForResponse(r => isPath(r, 'POST', new RegExp(`^/api/sales/${state.p2a.saleId}/reprints$`))),
      dialog.getByRole('button', { name: /^Reprint 1 item/ }).click(),
    ]);
    const repBody = await rep.json().catch(() => null);
    await t.page.waitForTimeout(1500);
    await shot(t.page, '02d-till-history-reprint-child-bracelet.png');
    const reprintJobs = (repBody?.jobs ?? []).map(jobFacts);
    const kidsReprint = await newPrintouts('kids_band', seen.kids_band);
    if (kidsReprint[0]) await keepPreview('kids_band', kidsReprint.at(-1), 'p2c-reprint-of-dropoff-band-on-kids.png');
    seen.kids_band.push(...kidsReprint.map(keyOf));
    step('2c: a new drop-off sale with no drop-off printer');
    const r = await dropOffSale(t.page, 'drop2', `ZZ TEST Nim ${T}`, `ZZ TEST SCRUM-${T} guardian B`, known);
    await shot(t.page, '02e-till-second-dropoff-paid-and-checked-in.png');
    const bandJobs = (r.checkin.body?.printJobs ?? []).map(jobFacts);
    const kidsNew = await newPrintouts('kids_band', seen.kids_band);
    if (kidsNew[0]) await keepPreview('kids_band', kidsNew.at(-1), 'p2c-new-dropoff-band-on-kids.png');
    state.p2c.saleId = r.saleId; state.p2c.regId = r.regId; state.p2c.receipt = (await readSale(r.saleId)).sale.receiptNumber; saveState();
    // The same document: the reprint of the first drop-off band, now on the kids printer, against its first print.
    const first = resolve(raw, 'p2a-dropoff-band.png'), again = resolve(raw, 'p2c-reprint-of-dropoff-band-on-kids.png');
    const identical = existsSync(first) && existsSync(again) && Buffer.compare(readFileSync(first), readFileSync(again)) === 0;
    const ok = reprintJobs.length === 1 && reprintJobs[0].role === 'kids_band' && reprintJobs[0].device === state.devices.kids_band.label
      && bandJobs.length === 1 && bandJobs[0].role === 'kids_band' && bandJobs[0].device === state.devices.kids_band.label && kidsNew.length === 1;
    point('2c', ok ? 'PASS' : 'FAIL', '02c-dropoff-fallback-to-kids-printer.png',
      'Drop-off printer removed in the Console: History\'s "Child bracelet" reprint of the first drop-off band and a new drop-off child\'s band both print on kids_band (the ZZ TEST kids band printer), the drop-off badge on the paper',
      { consoleField: state.p2c.consoleAfter, reprintJobs, newDropoffJobs: bandJobs, reprintPreviewIdenticalToFirstPrint: identical });
  } finally { await closeTill(t); }
};

// ---- 2c picture again: History's reprint record with the band code blacked out ----
phases.retake = async () => {
  const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
  try {
    step('History -> the first drop-off sale: the reprint record');
    await openHistorySale(t.page, state.p2a.receipt);
    await t.page.getByTestId('reprint-history').waitFor({ timeout: 20000 });
    await t.page.waitForTimeout(1500);
    receipt.notes.push({ reprintHistory: flat(await t.page.getByTestId('reprint-history').innerText()).replace(/Z\d{5}-(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,8}/g, '[band code]').slice(0, 400) }); save();
    await shot(t.page, '02d-till-history-reprint-record-kids-band-printer.png');
  } finally { await closeTill(t); }
};

// ---- 4: an F&B sale's tickets, then refunds ----
async function addItem(till, name) {
  const search = till.getByPlaceholder('Search dish…');
  await search.scrollIntoViewIfNeeded();
  await search.fill(name);
  const item = till.getByText(name, { exact: true }).first();
  await item.scrollIntoViewIfNeeded();
  await item.click();
  const d = till.getByRole('dialog');
  if (await d.getByRole('button', { name: /^Add to order/ }).isVisible().catch(() => false)) {
    await d.getByRole('button', { name: /^Add to order/ }).click();
    await d.waitFor({ state: 'hidden' }).catch(() => {});
  }
  await till.waitForTimeout(600);
}
async function refundInHistory(page, saleId, receiptNumber, { mode, item, note, picture }) {
  await openHistorySale(page, receiptNumber);
  await page.getByTestId('refund-sale').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Refund amount' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: mode, exact: true }).click();
  if (item) await dialog.getByRole('button').filter({ hasText: item }).filter({ hasText: '฿' }).first().click();
  const reasons = dialog.getByRole('button', { name: 'Service recovery', exact: true });
  await reasons.click();
  await dialog.locator('textarea').first().fill(note);
  const go = dialog.getByRole('button', { name: /^Refund ฿/ });
  await expect(go).toBeEnabled();
  const label = flat(await go.innerText());
  await shot(page, picture);
  const sent = page.waitForRequest(r => isPath({ request: () => r, url: () => r.url() }, 'POST', new RegExp(`^/api/sales/${saleId}/refunds$`)));
  const answered = page.waitForResponse(r => isPath(r, 'POST', new RegExp(`^/api/sales/${saleId}/refunds$`)));
  await go.click();
  const request = await sent;
  const response = await answered;
  const body = await response.json().catch(() => null);
  await dialog.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return { label, status: response.status(), body, sent: { headers: request.headers(), body: request.postData() } };
}
const auditOf = async (action, entityId) => ((await call('GET', `/audit?action=${encodeURIComponent(action)}&entityId=${entityId}&limit=50`)).body?.entries ?? []);

phases.p4 = async () => {
  const known = new Set((await stationSales()).map(s => s.id));
  const seen = { kitchen: await seqsOf('kitchen'), bar: await seqsOf('bar') };
  const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
  let mgr = null;
  try {
    step('4: F&B guest: French fries (kitchen) and Coke (bar), Charge, cash');
    await t.page.goto('/'); await landing(t.page).waitFor();
    await t.page.getByRole('button', { name: 'F&B', exact: true }).click();
    await t.page.getByRole('heading', { name: 'Scan Wristband', exact: true }).waitFor();
    await t.page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
    await addItem(t.page, 'French fries');
    await addItem(t.page, 'Coke');
    const charge = t.page.getByRole('button', { name: /^Charge ฿/ });
    await expect(charge).toBeEnabled({ timeout: 20000 });
    const total = baht(await charge.textContent());
    await charge.click();
    const pickup = t.page.getByRole('dialog', { name: 'Pick-up Code', exact: true });
    if (await pickup.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
      const go = pickup.getByRole('button', { name: /^Continue to Payment/ });
      if (!(await go.isEnabled().catch(() => false))) { await pickup.getByRole('button', { name: '6', exact: true }).click(); await pickup.getByRole('button', { name: '1', exact: true }).click(); }
      await go.click();
    }
    await t.page.getByRole('button', { name: /^Cash / }).click();
    await t.page.getByLabel('Cash received', { exact: true }).fill(total.toFixed(2));
    const fin = t.page.waitForResponse(r => isPath(r, 'POST', /^\/api\/sales\/[^/]+\/finalise$/), { timeout: 60000 });
    await t.page.getByRole('button', { name: 'Record cash', exact: true }).click();
    const finBody = await (await fin).json().catch(() => null);
    await t.page.getByRole('heading', { name: 'Order Confirmed', exact: true }).waitFor({ timeout: 45000 });
    await t.page.waitForTimeout(1500);
    await shot(t.page, '04a-till-fnb-paid-cash.png');
    const sale = (await stationSales()).find(s => !known.has(s.id) && s.status === 'finalised');
    assert.ok(sale, 'the F&B sale');
    state.created.push({ kind: 'sale', key: 'fnb', id: sale.id });
    const read = await readSale(sale.id);
    state.p4 = { saleId: sale.id, receipt: read.sale.receiptNumber, pickupCode: read.sale.pickupCode ?? read.pickupCode ?? null, total }; saveState();
    const tickets = await jobsPrinted(sale.id, j => /_ticket$/.test(j.kind));
    const kitchenTicket = await newPrintouts('kitchen', seen.kitchen);
    const barTicket = await newPrintouts('bar', seen.bar);
    if (kitchenTicket[0]) await keepPreview('kitchen', kitchenTicket.at(-1), 'p4-kitchen-ticket.png');
    if (barTicket[0]) await keepPreview('bar', barTicket.at(-1), 'p4-bar-ticket.png');
    seen.kitchen.push(...kitchenTicket.map(keyOf)); seen.bar.push(...barTicket.map(keyOf));
    receipt.points['4-tickets'] = { finaliseJobs: (finBody?.printing?.jobs ?? []).map(jobFacts), printed: tickets.map(jobFacts), lines: (read.lines ?? read.sale.lines ?? []).map(l => ({ id: l.id, label: l.label ?? l.name, kind: l.kind })) };
    save();

    step('4: a manager at the same till: History, Refund by item, the Coke');
    mgr = await openTill('STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD', 'manager');
    const first = await refundInHistory(mgr.page, sale.id, state.p4.receipt, { mode: 'By item', item: 'Coke', note: `ZZ TEST SCRUM-${T} proof: the drink refunded`, picture: '04b-refund-dialog-by-item-coke.png' });
    assert.equal(first.status, 200, 'refund of the drink');
    state.p4.firstRefund = { id: first.body.refund.id, number: first.body.refund.number }; saveState();
    const barVoid = await newPrintouts('bar', seen.bar);
    await sleep(20000);
    const kitchenAfterFirst = (await printouts('kitchen')).printouts.filter(p => !seen.kitchen.includes(keyOf(p)));
    const barAfterFirst = (await printouts('bar')).printouts.filter(p => !seen.bar.includes(keyOf(p)));
    if (barVoid[0]) await keepPreview('bar', barVoid[0], 'p4-bar-void-after-drink-refund.png');
    seen.bar.push(...barAfterFirst.map(keyOf));
    await shot(mgr.page, '04c-history-after-drink-refund.png');
    const audit1 = (await auditOf('sale.void_slips', sale.id)).map(e => e.after);

    step('4: the rest refunded whole');
    const second = await refundInHistory(mgr.page, sale.id, state.p4.receipt, { mode: 'Whole sale', note: `ZZ TEST SCRUM-${T} proof: the rest refunded`, picture: '04d-refund-dialog-whole-sale.png' });
    assert.equal(second.status, 200, 'refund of the rest');
    state.p4.secondRefund = { id: second.body.refund.id, number: second.body.refund.number }; saveState();
    const kitchenVoid = await newPrintouts('kitchen', seen.kitchen);
    await sleep(20000);
    const kitchenAfterSecond = (await printouts('kitchen')).printouts.filter(p => !seen.kitchen.includes(keyOf(p)));
    const barAfterSecond = (await printouts('bar')).printouts.filter(p => !seen.bar.includes(keyOf(p)));
    if (kitchenVoid[0]) await keepPreview('kitchen', kitchenVoid[0], 'p4-kitchen-void-after-whole-refund.png');
    seen.kitchen.push(...kitchenAfterSecond.map(keyOf));
    await shot(mgr.page, '04e-history-after-whole-refund.png');
    const audit2 = (await auditOf('sale.void_slips', sale.id)).map(e => e.after);

    step('4: replays: the first refund again with its own key, and with its action id under a new key');
    const replayOf = async (sent, newKey) => {
      const body = JSON.parse(sent.body);
      const headers = { 'content-type': 'application/json', 'idempotency-key': newKey ? randomUUID() : sent.headers['idempotency-key'], 'x-oto-action-id': sent.headers['x-oto-action-id'] };
      const r = await mgr.page.request.fetch(`/api/sales/${sale.id}/refunds`, { method: 'POST', headers, data: body });
      const b = await r.json().catch(() => null);
      return { status: r.status(), replayHeader: r.headers()['x-oto-replay'] ?? null, refundId: b?.refund?.id ?? null, sameRefund: b?.refund?.id === state.p4.firstRefund.id, saleStatus: b?.sale?.status ?? null, errorCode: b?.error?.code ?? null };
    };
    const replaySameKey = await replayOf(first.sent, false);
    const replaySameAction = await replayOf(first.sent, true);
    await sleep(25000);
    const kitchenAfterReplay = (await printouts('kitchen')).printouts.filter(p => !seen.kitchen.includes(keyOf(p)));
    const barAfterReplay = (await printouts('bar')).printouts.filter(p => !seen.bar.includes(keyOf(p)));
    const audit3 = (await auditOf('sale.void_slips', sale.id)).map(e => e.after);
    const refunds = ((await readSale(sale.id)).refunds ?? []).map(r => ({ number: r.number, amountSatang: r.amountSatang, status: r.status ?? null }));
    const slipsOf = a => (a ?? []).flatMap(x => (x?.slips ?? []).map(sl => `${x.refundId === state.p4.firstRefund.id ? 'refund 1' : x.refundId === state.p4.secondRefund.id ? 'refund 2' : 'other'}: ${sl.station} ${sl.variant} ${sl.status}`));
    receipt.points['4-detail'] = {
      firstRefund: { button: first.label, status: first.status, number: first.body.refund.number, amountSatang: first.body.refund.amountSatang, saleStatusAfter: first.body.sale?.status ?? null,
        sentBodyKeys: Object.keys(JSON.parse(first.sent.body)), sentMode: JSON.parse(first.sent.body).mode, sentLineCount: (JSON.parse(first.sent.body).lineIds ?? []).length },
      afterFirst: { barNew: barAfterFirst.length, kitchenNew: kitchenAfterFirst.length, auditSlips: slipsOf(audit1) },
      secondRefund: { button: second.label, status: second.status, number: second.body.refund.number, amountSatang: second.body.refund.amountSatang, saleStatusAfter: second.body.sale?.status ?? null, sentMode: JSON.parse(second.sent.body).mode },
      afterSecond: { kitchenNew: kitchenAfterSecond.length, barNew: barAfterSecond.length, auditSlips: slipsOf(audit2) },
      replaySameKey, replaySameAction,
      afterReplays: { kitchenNew: kitchenAfterReplay.length, barNew: barAfterReplay.length, auditRows: audit3.length, auditSlips: slipsOf(audit3) },
      refunds,
    };
    save();
    const d = receipt.points['4-detail'];
    const ok = d.afterFirst.barNew === 1 && d.afterFirst.kitchenNew === 0 && slipsOf(audit1).join('|') === 'refund 1: bar void printed'
      && d.afterSecond.kitchenNew === 1 && d.afterSecond.barNew === 0 && slipsOf(audit2).sort().join('|') === ['refund 1: bar void printed', 'refund 2: kitchen void printed'].sort().join('|')
      && replaySameKey.status === 200 && replaySameKey.sameRefund && replaySameAction.status === 200 && replaySameAction.sameRefund
      && d.afterReplays.kitchenNew === 0 && d.afterReplays.barNew === 0 && audit3.length === 2;
    point('4', ok ? 'PASS' : 'FAIL', '04-void-slips-bar-then-kitchen.png',
      'F&B sale (French fries to the kitchen, Coke to the bar, cash): the manager refunds the Coke by item -> one bar VOID slip of the Coke, no UPDATED slip (nothing else at the bar), nothing in the kitchen; the rest refunded whole -> one kitchen VOID slip of the fries, nothing at the bar; the first refund replayed with its own key and with its action id under a new key -> the same refund back, no slip printed again',
      d);
  } finally { await closeTill(mgr); await closeTill(t); }
};

// ---- 5: a party's slips, its plan changed, the party deleted ----
let app = null;
async function openApp() {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  const appCall = async (method, path, body) => {
    const r = await ctx.request.fetch(APP + '/api' + path, { method, data: body, headers: method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() } });
    const json = await r.json().catch(() => null);
    receipt.requests.push({ via: 'oto app', method, path: idPath(path), status: r.status() }); save();
    return { status: r.status(), body: json };
  };
  assert.equal((await ctx.request.post(LAUNCHER + '/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const hand = await (await ctx.request.post(LAUNCHER + '/api/auth/handoff', { data: { app: 'oto_app' }, headers: { 'Idempotency-Key': randomUUID() } })).json();
  const page = await ctx.newPage();
  const exchanged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await page.goto(hand.launchUrl); await exchanged;
  await page.waitForURL(u => !u.hash.includes('handoff'), { timeout: 60000 });
  return { ctx, page, appCall };
}
async function closeApp(a) {
  if (!a) return;
  try {
    await a.ctx.request.post(APP + '/api/auth/logout', { headers: { 'Idempotency-Key': randomUUID() } }).catch(() => null);
    const r = await a.ctx.request.post(LAUNCHER + '/api/auth/sign-out', { data: {}, headers: { 'Idempotency-Key': randomUUID() } });
    receipt.notes.push({ launcherSignOut: r.status(), launcherMe: (await a.ctx.request.get(LAUNCHER + '/api/me')).status() }); save();
  } catch (e) { odd('oto app sign-out failed', { error: firstLine(e) }); }
  await a.ctx.close().catch(() => {});
}
const partyRead = async id => (await call('GET', `/parties/${id}?branchId=${state.branchId}`));
const kidsLine = (name, qty, code) => ({ id: `zz861_${name.replace(/\W/g, '').toLowerCase()}`, itemName: name, quantity: qty, notes: '', included: true, price: 0, productCode: code });
const bkk = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
/** Wait for the slips job to print on the kitchen and bar printers; answers the new printouts by role. */
async function slipsPrinted(seen, { want, timeout = 180000 }) {
  const deadline = Date.now() + timeout;
  let got = { kitchen: [], bar: [] };
  while (Date.now() < deadline) {
    for (const role of ['kitchen', 'bar']) got[role] = (await printouts(role)).printouts.filter(p => !seen[role].includes(keyOf(p)));
    if (got.kitchen.length >= want.kitchen && got.bar.length >= want.bar) break;
    await sleep(5000);
  }
  // A look a little longer: what else the same tick sent.
  await sleep(8000);
  for (const role of ['kitchen', 'bar']) got[role] = (await printouts(role)).printouts.filter(p => !seen[role].includes(keyOf(p)));
  return got;
}
const changeAudit = async eventId => (await auditOf('party.slips_change', eventId.toLowerCase())).map(e => ({ at: e.createdAt ?? e.at ?? null, run: e.after?.run, cancelled: e.after?.cancelled, slips: (e.after?.slips ?? []).map(s => `${s.station} ${s.variant} ${s.status}`) }));
const printAudit = async eventId => (await auditOf('party.slips_print', eventId.toLowerCase())).map(e => ({ run: e.after?.run, trigger: e.after?.trigger, stationIsOurTill: e.after?.stationId === state.station.id, slips: (e.after?.slips ?? []).map(s => `${s.station} ${s.status}`) }));

phases.p5 = async () => {
  const branch = (await call('GET', '/branches')).body.branches.find(b => b.id === state.branchId);
  assert.equal(branch.partySlipsStationId, null, 'the park names no party slips station (no other proof is using it)');
  const menu = (await call('GET', `/branches/${state.branchId}/menu`)).body;
  const product = name => menu.products.find(p => p.name === name && p.active && !p.archivedAt && p.code);
  const calamari = product('Calamari'), hummus = product('Hummus');
  assert.ok(calamari && hummus, 'till codes for the kitchen plan lines');
  assert.equal(calamari.effectivePrepStation, 'kitchen'); assert.equal(hummus.effectivePrepStation, 'kitchen');
  const seen = { kitchen: await seqsOf('kitchen'), bar: await seqsOf('bar') };
  const title = `ZZ TEST SCRUM-${T} party ${bkk(new Date()).replace(':', '')}`;
  let t = null;
  app = await openApp();
  try {
    step('5: the OTO App: a ZZ TEST party today, its kitchen plan (Calamari x2) and bar plan (Coke x4)');
    const ev = await app.appCall('POST', '/admin/events', { eventType: 'birthday', title, branchId: APP_FLORESTA, eventDate: today, startTime: '15:00', endTime: '18:00', durationMinutes: 180, numChildren: 6, numAdults: 2, status: 'upcoming' });
    assert.equal(ev.status, 201, 'party created');
    const partyId = ev.body.id;
    state.party = { id: partyId, title }; state.created.push({ kind: 'oto-app party', id: partyId, title }); saveState();
    const plan = await app.appCall('PUT', `/events/${partyId}/beo`, {
      kitchenPlan: { foodRequired: true, setMenuEnabled: false, menus: { kids: [kidsLine('Calamari', 2, calamari.code)], adults: [], adultsDiffer: false, kidsFoodTime: '15:30', adultsFoodTime: '' } },
      barPlan: { serviceTime: '15:00', items: [{ id: 'zz861_coke', itemName: 'Coke', quantity: 4, notes: '', included: true, price: 0 }] },
    });
    assert.ok([200, 201].includes(plan.status), 'BEO saved');
    step('5: the ZZ TEST till named for the park\'s party slips (set back to none at the end)');
    const named = await call('PATCH', `/branches/${state.branchId}`, { partySlipsStationId: state.station.id });
    assert.equal(named.status, 200);
    state.partySlipsStationNamed = true; saveState();
    step('5: the Floresta package applied: the plan is published, the slips job prints at its next look');
    const pkg = await app.appCall('POST', `/beo/events/${partyId}/package-snapshot`, { templateId: FLORESTA_PACKAGE });
    assert.equal(pkg.status, 201, 'package applied');
    const slipsTime = String(pkg.body?.slipsTime ?? '11:00').slice(0, 5);
    if (slipsTime > bkk(new Date())) {
      const moved = await app.appCall('PATCH', `/beo/events/${partyId}/package-snapshot`, { slipsTime: '11:00' });
      receipt.notes.push({ slipsTimeMovedFrom: slipsTime, status: moved.status }); save();
    }
    const firstRun = await slipsPrinted(seen, { want: { kitchen: 1, bar: 1 } });
    if (firstRun.kitchen[0]) await keepPreview('kitchen', firstRun.kitchen[0], 'p5-party-kitchen-slip.png');
    if (firstRun.bar[0]) await keepPreview('bar', firstRun.bar[0], 'p5-party-bar-slip.png');
    for (const role of ['kitchen', 'bar']) seen[role].push(...firstRun[role].map(keyOf));
    const view1 = (await partyRead(partyId)).body;
    t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
    await t.page.goto('/parties'); await t.page.getByText(title).first().click(); await t.page.waitForTimeout(3000);
    const block = t.page.getByText('Kitchen & bar slips').first();
    if (await block.isVisible().catch(() => false)) await block.scrollIntoViewIfNeeded();
    await shot(t.page, '05a-pos-party-page-slips-printed.png');
    step('5: one more look of the job: an unchanged plan prints nothing');
    await sleep(70000);
    const quiet1 = { kitchen: (await printouts('kitchen')).printouts.filter(p => !seen.kitchen.includes(keyOf(p))).length, bar: (await printouts('bar')).printouts.filter(p => !seen.bar.includes(keyOf(p))).length };

    step('5: the kitchen plan changed in the OTO App: Calamari x2 taken off, Hummus x1 added');
    const changed = await app.appCall('PUT', `/events/${partyId}/beo/kitchen-plan`, { menus: { kids: [kidsLine('Hummus', 1, hummus.code)], adults: [], adultsDiffer: false, kidsFoodTime: '15:30', adultsFoodTime: '' } });
    assert.ok([200, 201].includes(changed.status), 'kitchen plan saved');
    const changeRun = await slipsPrinted(seen, { want: { kitchen: 2, bar: 0 } });
    for (const [i, p] of changeRun.kitchen.entries()) await keepPreview('kitchen', p, `p5-change-kitchen-${i + 1}.png`);
    for (const role of ['kitchen', 'bar']) seen[role].push(...changeRun[role].map(keyOf));
    step('5: two more looks of the job: nothing printed twice');
    await sleep(130000);
    const quiet2 = { kitchen: (await printouts('kitchen')).printouts.filter(p => !seen.kitchen.includes(keyOf(p))).length, bar: (await printouts('bar')).printouts.filter(p => !seen.bar.includes(keyOf(p))).length };
    const auditAfterChange = await changeAudit(partyId);

    step('5: the party deleted in the OTO App');
    const del = await app.appCall('DELETE', `/admin/events/${partyId}`);
    receipt.notes.push({ partyDelete: del.status }); save();
    const cancelRun = await slipsPrinted(seen, { want: { kitchen: 1, bar: 1 } });
    if (cancelRun.kitchen[0]) await keepPreview('kitchen', cancelRun.kitchen[0], 'p5-cancel-kitchen-void.png');
    if (cancelRun.bar[0]) await keepPreview('bar', cancelRun.bar[0], 'p5-cancel-bar-void.png');
    for (const role of ['kitchen', 'bar']) seen[role].push(...cancelRun[role].map(keyOf));
    await sleep(70000);
    const quiet3 = { kitchen: (await printouts('kitchen')).printouts.filter(p => !seen.kitchen.includes(keyOf(p))).length, bar: (await printouts('bar')).printouts.filter(p => !seen.bar.includes(keyOf(p))).length };
    const auditFinal = await changeAudit(partyId);
    const prints = await printAudit(partyId);
    const appRead = (await app.appCall('GET', `/admin/events/${partyId}`)).status;
    const tillRead = (await partyRead(partyId)).status;
    receipt.points['5-detail'] = {
      partyTitle: title, slipsTime: view1?.slips?.slipsTime ?? null, namedStationIsOurTill: view1?.slips?.station?.id === state.station.id,
      firstRun: { kitchen: firstRun.kitchen.length, bar: firstRun.bar.length, partySlipRecords: (view1?.slips?.records ?? []).map(r => `${r.station} run ${r.run} ${r.trigger} ${r.status}`), printAudit: prints },
      unchangedLook: quiet1,
      change: { kitchen: changeRun.kitchen.length, bar: changeRun.bar.length, laterLooks: quiet2, audit: auditAfterChange },
      deleted: { appDelete: del.status, kitchen: cancelRun.kitchen.length, bar: cancelRun.bar.length, laterLook: quiet3, audit: auditFinal, readBack: { otoApp: appRead, till: tillRead } },
    };
    save();
    const d = receipt.points['5-detail'];
    const changeRows = auditAfterChange.filter(a => !a.cancelled);
    const cancelRows = auditFinal.filter(a => a.cancelled);
    const ok = d.firstRun.kitchen === 1 && d.firstRun.bar === 1 && quiet1.kitchen === 0 && quiet1.bar === 0
      && d.change.kitchen === 2 && d.change.bar === 0 && quiet2.kitchen === 0 && quiet2.bar === 0
      && changeRows.length === 1 && changeRows[0].slips.join('|') === 'kitchen void printed|kitchen updated printed'
      && d.deleted.kitchen === 1 && d.deleted.bar === 1 && quiet3.kitchen === 0 && quiet3.bar === 0
      && cancelRows.length === 1 && cancelRows[0].slips.join('|') === 'kitchen void printed|bar void printed';
    point('5', ok ? 'PASS' : 'FAIL', '05-party-slips-change-and-cancel.png',
      'A ZZ TEST party for today with the Floresta package: the slips job printed its kitchen and bar slips on the ZZ TEST till; the kitchen plan changed in the OTO App (Calamari x2 off, Hummus x1 on) -> one kitchen VOID slip and one kitchen UPDATED slip, nothing at the bar, nothing again on later looks; the party deleted -> a VOID slip each for the kitchen and the bar, once',
      d);
  } finally {
    if (state.partySlipsStationNamed) {
      const back = await call('PATCH', `/branches/${state.branchId}`, { partySlipsStationId: null });
      const now = (await call('GET', '/branches')).body.branches.find(b => b.id === state.branchId).partySlipsStationId;
      receipt.notes.push({ partySlipsStationSetBack: back.status, readBack: now }); save();
      if (back.status === 200 && now === null) { state.partySlipsStationNamed = false; saveState(); }
    }
    await closeTill(t);
    await closeApp(app);
  }
};

// ---- 5, read back from the record: the till's kitchen and bar jobs and the party's audit rows ----
/**
 * Read-only. The print jobs and the audit trail are in the database, so they hold across an api restart, which
 * the simulator's own list of printouts does not (it is in the api process). Run after p5.
 */
phases.p5record = async () => {
  assert.ok(state.party, 'run p5 first');
  const p5 = readReceipt('p5');
  const from = Date.parse(p5.startedAt);
  const jobs = (await call('GET', `/branches/${state.branchId}/print-jobs?stationId=${state.station.id}&limit=200`)).body.jobs
    .filter(j => ['kitchen_ticket', 'bar_ticket'].includes(j.kind) && Date.parse(j.queuedAt) >= from)
    .sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt))
    .map(j => ({ queuedAt: j.queuedAt, bangkok: bkk(new Date(j.queuedAt)), kind: j.kind, role: j.role, printer: j.deviceLabel, status: j.status, reprintOf: j.reprintOf ? 'copy' : null }));
  const prints = await printAudit(state.party.id);
  const changes = (await auditOf('party.slips_change', state.party.id.toLowerCase())).map(e => ({ at: e.createdAt, bangkok: bkk(new Date(e.createdAt)), run: e.after?.run, cancelled: e.after?.cancelled, stationIsOurTill: e.after?.stationId === state.station.id, slips: (e.after?.slips ?? []).map(s => `${s.station} ${s.variant} ${s.status}`) }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const branch = (await call('GET', '/branches')).body.branches.find(b => b.id === state.branchId);
  receipt.points['5-record'] = { party: state.party.title, jobsAtTheTillSinceP5: jobs, partySlipsPrintAudit: prints, partySlipsChangeAudit: changes, partySlipsStationIdNow: branch.partySlipsStationId,
    partyReadNow: { till: (await partyRead(state.party.id)).status } };
  // The verdict from the record: one slip-time run (kitchen and bar), one change (the kitchen's VOID and UPDATED,
  // nothing at the bar), one cancellation (a VOID each), and no other kitchen or bar job at the till since.
  const at = a => Date.parse(a.at ?? 0);
  const plan = changes.filter(c => !c.cancelled), cancel = changes.filter(c => c.cancelled);
  const jobsBetween = (t0, t1) => jobs.filter(j => Date.parse(j.queuedAt) >= t0 - 2000 && Date.parse(j.queuedAt) <= t1 + 2000).map(j => j.role).sort().join(',');
  const ok = prints.length === 1 && prints[0].trigger === 'schedule' && prints[0].stationIsOurTill && prints[0].slips.join('|') === 'kitchen printed|bar printed'
    && plan.length === 1 && plan[0].slips.join('|') === 'kitchen void printed|kitchen updated printed' && plan[0].stationIsOurTill
    && cancel.length === 1 && cancel[0].slips.join('|') === 'kitchen void printed|bar void printed' && cancel[0].stationIsOurTill
    && jobs.length === 6 && jobs.every(j => j.status === 'printed')
    && jobsBetween(at(plan[0]), at(plan[0])) === 'kitchen,kitchen' && jobsBetween(at(cancel[0]), at(cancel[0])) === 'bar,kitchen'
    && branch.partySlipsStationId === null;
  point('5', ok ? 'PASS' : 'FAIL', '05-party-slips-change-and-cancel.png',
    'Read back from the print record and the audit trail: the party\'s slip-time run printed a kitchen and a bar slip at the ZZ TEST till; the plan change sent the kitchen one VOID and one UPDATED slip and the bar nothing; the deletion sent a VOID slip each to the kitchen and the bar; no other kitchen or bar job at the till since; the park\'s party slips station is none again',
    { jobs: jobs.map(j => `${j.bangkok} ${j.role} ${j.status}`), printRuns: prints.length, planChanges: plan.length, cancellations: cancel.length });
  save();
  console.log(JSON.stringify(receipt.points['5-record'], null, 1));
};

// ---- 6: an odd thing, read back: point 2a's first attempt, before the ZZ TEST printers had addresses ----
phases.odd = async () => {
  const first = state.created.find(c => c.kind === 'sale' && c.key === 'drop1');
  assert.ok(first, 'the first drop-off sale');
  const read = await readSale(first.id);
  const jobs = (read.printJobs ?? []).map(j => ({ kind: j.kind, role: j.role, printer: j.deviceLabel, status: j.status, error: j.errorCode ?? '' }));
  receipt.points['6-no-address'] = { sale: read.sale.receiptNumber, jobs }; save();
  const b = await launch();
  const page = await (await b.newContext()).newPage();
  await page.setViewportSize({ width: 1200, height: 400 });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;margin:0;padding:22px 26px;background:#fff;color:#111">
    <h2 style="margin:0 0 8px">SCRUM-861, odd thing: a simulated printer with no address never prints</h2>
    <p style="margin:4px 0">Point 2a, first attempt (receipt ${esc(read.sale.receiptNumber)}): the ZZ TEST printers were declared "simulated" without an address, which the api and the Console's Add a device form allow. The band was routed right (role dropoff_band, the ZZ TEST drop-off band printer), but the box skipped every job: DEVICE_NO_ADDRESS. The box finds a simulator by its address (packages/box-agent/src/printing/index.ts:141) and refuses a device with none before asking (packages/box-agent/src/printing/queue.ts:840-846).</p>
    <p style="margin:4px 0">Read back now with GET /api/sales/:id. After each ZZ TEST printer was given its own TEST-NET-1 address the same flow printed (point 2a, second attempt).</p>
    <table style="border-collapse:collapse;font-size:14px;margin-top:10px"><tr>${Object.keys(jobs[0] ?? { kind: '' }).map(k => `<th style="border:1px solid #bbb;padding:5px 9px;background:#f2f2f2;text-align:left">${esc(k)}</th>`).join('')}</tr>
    ${jobs.map(j => `<tr>${Object.values(j).map(v => `<td style="border:1px solid #bbb;padding:5px 9px">${esc(v)}</td>`).join('')}</tr>`).join('')}</table></body></html>`);
  await page.screenshot({ path: resolve(out, '06b-simulated-printer-without-address-skipped.png'), fullPage: true });
  console.log(JSON.stringify(receipt.points['6-no-address'], null, 1));
};

// ---- the pictures of what the simulated printers drew (masked) ----
/**
 * One page per point: the job facts from the receipts and each printout as the simulator drew it. A band's QR
 * code, barcode and code are covered (everything from the QR down); on a refund's VOID slip the name after
 * "Voided by" is covered. The masks are found from the picture itself: rows of ink make lines, columns make words.
 */
async function composite(page, file, title, intro, rows, panels, outro = []) {
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const img = name => 'data:image/png;base64,' + readFileSync(resolve(raw, name)).toString('base64');
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;margin:0;padding:22px 26px;background:#fff;color:#111;width:1440px">
    <h2 style="margin:0 0 6px">${esc(title)}</h2>${intro.map(p => `<p style="margin:4px 0;font-size:15px">${esc(p)}</p>`).join('')}
    ${rows.length ? `<table style="border-collapse:collapse;font-size:13px;margin:10px 0"><tr>${Object.keys(rows[0]).map(k => `<th style="border:1px solid #bbb;padding:4px 8px;background:#f2f2f2;text-align:left">${esc(k)}</th>`).join('')}</tr>
      ${rows.map(r => `<tr>${Object.values(r).map(v => `<td style="border:1px solid #bbb;padding:4px 8px">${esc(v)}</td>`).join('')}</tr>`).join('')}</table>` : ''}
    <div style="display:flex;flex-wrap:wrap;gap:22px;align-items:flex-start;margin-top:8px">
    ${panels.map(p => `<figure style="margin:0;border:1px solid #ccc;padding:8px;background:#fafafa"><figcaption style="font-size:13px;font-weight:600;margin-bottom:6px;max-width:${p.width ?? 600}px">${esc(p.caption)}</figcaption>
      <div style="position:relative;display:inline-block;background:#fff;border:1px dashed #999"><img data-mask="${p.mask ?? ''}" src="${img(p.name)}" style="display:block;width:${p.width ?? 600}px;image-rendering:pixelated"></div></figure>`).join('')}
    </div>${outro.map(p => `<p style="margin:8px 0 0;font-size:14px">${esc(p)}</p>`).join('')}</body></html>`);
  await page.evaluate(async () => {
    for (const el of document.querySelectorAll('img[data-mask]')) {
      await el.decode();
      const mode = el.dataset.mask;
      if (!mode) continue;
      const c = document.createElement('canvas'); c.width = el.naturalWidth; c.height = el.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(el, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const ink = (px, py) => d[(py * c.width + px) * 4] < 128;
      const rowInk = Array.from({ length: c.height }, (_, y) => { let n = 0; for (let i = 0; i < c.width; i++) if (ink(i, y)) n++; return n; });
      const lines = []; let start = null;
      rowInk.forEach((n, y) => { if (n > 0 && start === null) start = y; if ((n === 0 || y === c.height - 1) && start !== null) { lines.push([start, n === 0 ? y - 1 : y]); start = null; } });
      const scale = el.getBoundingClientRect().width / c.width;
      const box = (x0, y0, x1, y1, label) => {
        const m = document.createElement('div');
        Object.assign(m.style, { position: 'absolute', left: `${x0 * scale}px`, top: `${y0 * scale}px`, width: `${(x1 - x0) * scale}px`, height: `${(y1 - y0) * scale}px`, background: '#2f2f35', color: '#ddd', font: '600 13px Segoe UI', display: 'flex', alignItems: 'center', justifyContent: 'center' });
        m.textContent = label; el.parentElement.appendChild(m);
      };
      if (mode === 'band') {
        // The QR is the first block of ink taller than a line of text: from there down is the code.
        const qr = lines.find(([a, b]) => b - a > 40);
        if (qr) box(0, Math.max(0, qr[0] - 2), c.width, c.height, 'QR code, barcode and band code masked');
      } else if (mode === 'voided-by') {
        // The VOID band is the tallest block; two lines below it is "Voided by <name>": cover the words after "by".
        const tall = lines.filter(([a, b]) => b - a >= 8);
        const band = tall.reduce((m, l) => (l[1] - l[0] > m[1] - m[0] ? l : m), tall[0]);
        const line = tall[tall.indexOf(band) + 2];
        if (line) {
          const colInk = Array.from({ length: c.width }, (_, i) => { for (let y = line[0]; y <= line[1]; y++) if (ink(i, y)) return true; return false; });
          const words = []; let w0 = null, gap = 0;
          colInk.forEach((on, i) => { if (on) { if (w0 === null) w0 = i; gap = 0; } else if (w0 !== null && ++gap > 7) { words.push([w0, i - gap]); w0 = null; gap = 0; } });
          if (w0 !== null) words.push([w0, c.width - 1]);
          if (words[2]) box(words[2][0] - 2, line[0] - 2, Math.max(words.at(-1)[1] + 3, words[2][0] + 60), line[1] + 3, 'staff');
        }
      }
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, file), fullPage: true });
  console.log('picture', file);
}
const readReceipt = name => JSON.parse(readFileSync(resolve(out, `receipt-${name}.json`), 'utf8'));
const factRow = j => ({ kind: j.kind, role: j.role, printer: j.device, status: j.status, reprint: j.reprint ? `copy: ${j.reprintReason}` : '' });

phases.compose = async () => {
  const b = await launch();
  const page = await (await b.newContext({ deviceScaleFactor: 1 })).newPage();
  const has = n => existsSync(resolve(raw, n));
  const only = (process.env.ONLY ?? '2,2b,2c,3,4,5').split(',');
  if (only.includes('2') && has('p2a-dropoff-band.png')) {
    const r = readReceipt('p2a').points['2a'].seen;
    await composite(page, '02-dropoff-band-on-dropoff-printer.png', 'SCRUM-861 point 2a: a drop-off child\'s band goes to the drop-off band printer',
      ['A drop-off sale on the ZZ TEST till (one child aged 6, no adult, the "Children playing alone" form, cash), then Check in now. The till has a drop-off band printer assigned (point 1).',
        `Print jobs of the sale, read back with GET /api/sales/:id. New printouts since the sale: drop-off band printer ${r.dropoffPrinterNew}, kids band printer ${r.kidsPrinterNew}.`],
      r.saleJobsPrinted.map(factRow),
      [{ name: 'p2a-dropoff-band.png', mask: 'band', width: 600, caption: 'What the ZZ TEST drop-off band printer drew (the simulator\'s own picture): name, DROP-OFF badge, leave time' }]);
  }
  if (only.includes('2b') && has('p2b-kids-band.png')) {
    const r = readReceipt('p2b').points['2b'].seen;
    await composite(page, '02b-ordinary-bands-kids-and-adult.png', 'SCRUM-861 point 2b: an ordinary sale prints on the kids and adult band printers as before',
      ['An ordinary sale on the same till (one child, one adult, cash) while the drop-off band printer is assigned.',
        `New printouts: kids band printer ${r.kidsNew}, adult band printer ${r.adultNew}, drop-off band printer ${r.dropoffNew}.`],
      r.printed.map(factRow),
      [{ name: 'p2b-kids-band.png', mask: 'band', width: 520, caption: 'ZZ TEST kids band printer: the child\'s band (no badge; the family\'s invented ZZ number)' },
        { name: 'p2b-adult-band.png', mask: 'band', width: 520, caption: 'ZZ TEST adult band printer: the adult\'s band' }]);
  }
  if (only.includes('3') && has('p3-kids-band-after-add-time.png')) {
    const r = readReceipt('p3').points['3'].seen;
    await composite(page, '03-add-time-bands-reprinted-new-leave-time.png', 'SCRUM-861 point 3: Add time (+1 hour) prints each band again on its own printer with the new leave time',
      ['History, the ordinary sale of point 2b, Add time, "+1 hour" (both bracelets selected, the default), paid in cash. The finalise answer carried these copies, each "Extra time added (+60 min)":'],
      r.copies.map(factRow),
      [{ name: 'p2b-kids-band.png', mask: 'band', width: 420, caption: 'Kids band printer, first print: 1 Hour, valid until 13:24' },
        { name: 'p3-kids-band-after-add-time.png', mask: 'band', width: 420, caption: 'Kids band printer, after Add time: 1 Hour + 1 hour, valid until 14:24' },
        { name: 'p2b-adult-band.png', mask: 'band', width: 420, caption: 'Adult band printer, first print' },
        { name: 'p3-adult-band-after-add-time.png', mask: 'band', width: 420, caption: 'Adult band printer, after Add time: 1 Hour + 1 hour, valid until 14:24' }],
      [`The same band each time (the code under the mask is unchanged). New printouts: kids ${r.kidsNew}, adult ${r.adultNew}, drop-off ${r.dropoffNew}.`]);
  }
  if (only.includes('2c') && has('p2c-new-dropoff-band-on-kids.png')) {
    const r = readReceipt('p2c').points['2c'].seen;
    await composite(page, '02c-dropoff-fallback-to-kids-printer.png', 'SCRUM-861 point 2c: with no drop-off band printer, drop-off bands print on the kids band printer, same paper',
      [`The drop-off band printer was set back to "Not set" in the Console (picture 02c-console…). Then History's "Child bracelet" reprint of point 2a's band, and a new drop-off sale (a child aged 6, no adult, cash, Check in now).`,
        `The reprint's picture is byte-for-byte the same as point 2a's first print on the drop-off band printer: ${r.reprintPreviewIdenticalToFirstPrint ? 'yes' : 'NO'}.`],
      [...r.reprintJobs, ...r.newDropoffJobs].map(factRow),
      [{ name: 'p2a-dropoff-band.png', mask: 'band', width: 420, caption: 'Point 2a, first print, on the DROP-OFF band printer' },
        { name: 'p2c-reprint-of-dropoff-band-on-kids.png', mask: 'band', width: 420, caption: 'The same band reprinted from History, now on the KIDS band printer' },
        { name: 'p2c-new-dropoff-band-on-kids.png', mask: 'band', width: 420, caption: 'A new drop-off child\'s band, on the KIDS band printer, DROP-OFF badge kept' }]);
  }
  if (only.includes('4') && has('p4-bar-void-after-drink-refund.png')) {
    const r = readReceipt('p4');
    const d = r.points['4-detail'];
    await composite(page, '04-void-slips-bar-then-kitchen.png', 'SCRUM-861 point 4: VOID slips to the kitchen and the bar after refunds',
      ['F&B guest order on the ZZ TEST till: French fries (kitchen) and Coke (bar), cash, pick-up #61. A manager at the same till refunded the Coke by item, then the rest as the whole sale.',
        `Refund 1 (${d.firstRefund.button}, by item): new printouts bar ${d.afterFirst.barNew}, kitchen ${d.afterFirst.kitchenNew}. Refund 2 (${d.secondRefund.button}, whole sale): kitchen ${d.afterSecond.kitchenNew}, bar ${d.afterSecond.barNew}.`,
        `Replays of refund 1: its own idempotency key -> HTTP ${d.replaySameKey.status}, the same refund, x-oto-replay ${d.replaySameKey.replayHeader}; its action id under a new key -> HTTP ${d.replaySameAction.status}, the same refund, x-oto-replay ${d.replaySameAction.replayHeader}. After both: kitchen ${d.afterReplays.kitchenNew}, bar ${d.afterReplays.barNew} new printouts; ${d.afterReplays.auditRows} sale.void_slips audit rows.`],
      d.afterReplays.auditSlips.map(s => ({ 'audit sale.void_slips (slip: station, variant, status)': s })),
      [{ name: 'p4-kitchen-ticket.png', width: 576, caption: 'Kitchen printer: the order\'s ticket' },
        { name: 'p4-bar-ticket.png', width: 576, caption: 'Bar printer: the order\'s ticket' },
        { name: 'p4-bar-void-after-drink-refund.png', mask: 'voided-by', width: 576, caption: 'Bar printer after refund 1: VOID slip of the Coke (no UPDATED slip: nothing else at the bar); the kitchen printed nothing' },
        { name: 'p4-kitchen-void-after-whole-refund.png', mask: 'voided-by', width: 576, caption: 'Kitchen printer after refund 2: VOID slip of the fries; the bar printed nothing' }]);
  }
  if (only.includes('5') && has('p5-party-kitchen-slip.png')) {
    const d = readReceipt('p5').points['5-detail'] ?? {};
    const rec = readReceipt('p5record').points['5-record'];
    // Which look of the job each kitchen or bar job belongs to, by the audit rows' times (the record, not the simulator).
    const runs = [...rec.partySlipsPrintAudit.map(a => ({ label: `slip time run ${a.run} (${a.trigger})`, slips: a.slips })), ...rec.partySlipsChangeAudit.map(a => ({ label: a.cancelled ? `change run ${a.run}: party cancelled` : `change run ${a.run}: plan changed`, at: a.bangkok, slips: a.slips }))];
    const panels = [{ name: 'p5-party-kitchen-slip.png', width: 576, caption: 'Kitchen printer, the slips job at the slip time: the party’s kitchen slip' },
      { name: 'p5-party-bar-slip.png', width: 576, caption: 'Bar printer, the same run: the party’s bar slip' }];
    for (const [i, n] of ['p5-change-kitchen-1.png', 'p5-change-kitchen-2.png'].entries()) if (has(n)) panels.push({ name: n, width: 576, caption: `Kitchen printer after the kitchen plan changed (Calamari x2 off, Hummus x1 on): ${i === 0 ? 'the VOID slip' : 'the UPDATED slip'}; the bar printed nothing` });
    if (has('p5-cancel-kitchen-void.png')) panels.push({ name: 'p5-cancel-kitchen-void.png', width: 576, caption: 'Kitchen printer after the party was deleted in the OTO App: VOID, party cancelled' });
    if (has('p5-cancel-bar-void.png')) panels.push({ name: 'p5-cancel-bar-void.png', width: 576, caption: 'Bar printer after the party was deleted: VOID, party cancelled' });
    await composite(page, '05-party-slips-change-and-cancel.png', 'SCRUM-861 point 5: a party’s VOID and UPDATED slips',
      [`"${rec.party}", made in the OTO App for today with the Floresta package (slip time ${d.slipsTime ?? '11:00'}), its kitchen plan one coded line Calamari x2, its bar plan Coke x4. The ZZ TEST till was named the park's party slips station for this point and set back to none after (now: ${rec.partySlipsStationIdNow ?? 'none'}).`,
        'The table is every kitchen and bar job at the ZZ TEST till from the start of this point, read back from the print record (GET /api/branches/:id/print-jobs), with the audit rows of the party (party.slips_print, party.slips_change). The api was redeployed (b627077e, no change to these files) at 12:46:21 Bangkok, between the change and the delete.'],
      rec.jobsAtTheTillSinceP5.map(j => ({ 'queued (Bangkok)': j.bangkok, kind: j.kind, role: j.role, printer: j.printer, status: j.status })),
      panels,
      runs.map(r => `Audit: ${r.label}${r.at ? ' at ' + r.at : ''} - ${r.slips.join(', ')}`));
  }
};

// ---- clean-up: only what this run made, each read back ----
phases.cleanup = async () => {
  const done = [];
  const clean = async (what, fn) => {
    try { const r = await fn(); done.push({ what, ...(r ?? {}) }); }
    catch (e) { done.push({ what, failed: firstLine(e) }); receipt.cleanupFailed = true; }
    receipt.points.cleanup = done; save();
  };
  const own = (await call('GET', `/branches/${state.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === state.station.id);
  assert.equal(own?.name, state.station.name, 'the ZZ TEST till of this run');
  await clean('the till\'s sales', async () => {
    const sales = await stationSales();
    for (const s of sales) assert.equal(s.stationId, state.station.id);
    for (const s of sales.filter(x => ['open', 'tendering'].includes(x.status))) {
      assert.equal((await call('POST', `/sales/${s.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
    }
    const after = await stationSales();
    assert.ok(after.every(s => ['finalised', 'voided', 'refunded'].includes(s.status)));
    return { sales: after.map(s => `${s.status} ${(s.totals?.grossSatang ?? 0) / 100}`) };
  });
  for (const item of state.created.filter(c => c.kind === 'registration')) await clean(`stay of ${item.key}`, async () => {
    let reg = await registrationOf(item.id);
    assert.equal(reg.guardianName, item.guardian, 'this run\'s own booking');
    for (const child of reg.children) assert.match(child.childName, /^ZZ TEST /);
    for (const child of reg.children.filter(c => c.status === 'in_park')) {
      const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: item.id, filename: `ZZ TEST SCRUM-${T} synthetic pickup.png` });
      assert.equal(file.status, 200);
      const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
      assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
      assert.equal((await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id })).status, 200);
    }
    for (const child of reg.children.filter(c => c.status === 'registered')) {
      assert.equal((await call('POST', `/checkin/registrations/${item.id}/cancel`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
      break;
    }
    reg = await registrationOf(item.id);
    const states = reg.children.map(c => c.status);
    assert.ok(states.every(s => s === 'out' || s === 'cancelled'), 'nothing of this run left in the park');
    return { children: states };
  });
  for (const [key, phone] of Object.entries(NUMBERS)) await clean(`number ${key}`, async () => {
    const m = await memberOf(phone);
    if (!m) return { member: 'none' };
    assert.ok(`${m.nickname ?? ''} ${m.name ?? ''}`.includes(`ZZ TEST SCRUM-${T}`), 'only this run\'s own named test members');
    assert.equal((await call('DELETE', `/members/${m.id}`)).status, 200);
    return { member: 'archived', stillFound: Boolean(await memberOf(phone)) };
  });
  await clean('the branch\'s party slips station', async () => {
    let now = (await call('GET', '/branches')).body.branches.find(b => b.id === state.branchId).partySlipsStationId;
    if (now === state.station.id) { assert.equal((await call('PATCH', `/branches/${state.branchId}`, { partySlipsStationId: null })).status, 200); now = (await call('GET', '/branches')).body.branches.find(b => b.id === state.branchId).partySlipsStationId; }
    assert.equal(now, null);
    return { partySlipsStationId: now };
  });
  if (state.party) await clean('the ZZ TEST party', async () => ({ tillRead: (await partyRead(state.party.id)).status }));
  await clean('the ZZ TEST till', async () => {
    assert.equal((await call('PATCH', `/stations/${state.station.id}`, { devices: [] })).status, 200);
    if (!own.archived) assert.equal((await call('DELETE', `/stations/${state.station.id}`)).status, 200);
    const row = (await call('GET', `/branches/${state.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === state.station.id);
    assert.ok(row.archived); assert.equal(row.devices.length, 0);
    return { archived: true, devices: 0 };
  });
  await clean('the ZZ TEST printers', async () => {
    const devices = (await call('GET', `/boxes/${state.boxId}/devices?includeArchived=true`)).body.devices;
    const out = [];
    for (const [role, d] of Object.entries(state.devices)) {
      const row = devices.find(x => x.id === d.id);
      assert.ok(row && row.label.startsWith('ZZ TEST SCRUM-861 '), 'only this run\'s printers');
      if (!row.archived) {
        const r = await call('DELETE', `/devices/${d.id}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.stillAssignedTo.length, 0);
      }
      out.push(role);
    }
    const after = (await call('GET', `/boxes/${state.boxId}/devices?includeArchived=true`)).body.devices.filter(x => Object.values(state.devices).some(d => d.id === x.id));
    assert.ok(after.every(x => x.archived));
    return { archived: out };
  });
};

// ---- dispatch ----
try {
  assert.ok(phases[PHASE], `unknown phase ${PHASE}`);
  if (PHASE !== 'setup') assert.ok(state.station, 'run setup first');
  if (!OFFLINE) await adminSignIn();
  await phases[PHASE]();
  receipt.passed = Object.values(receipt.points).every(p => !p.verdict || p.verdict === 'PASS');
} catch (error) {
  receipt.passed = false;
  receipt.failure = { step: receipt.step, error: firstLine(error), at: String(error?.stack ?? '').split(/\r?\n/).filter(l => /proof\.mjs:\d+/.test(l)).map(l => l.trim().replace(/^at /, '').replace(/\(?file:.*proof\.mjs:/, 'proof.mjs:').replace(/\)$/, '')) };
  console.log('FAILED', receipt.step, '|', firstLine(error), '|', receipt.failure.at.join(' < '));
  receipt.failure.lastScreens = lastScreens;
  process.exitCode = 1;
} finally {
  if (!OFFLINE) try { if ((await admin.get('/api/me')).status() === 200) await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } }); receipt.notes.push({ adminSignedOut: (await admin.get('/api/me')).status() }); } catch { /* read back in cleanup */ }
  await browser?.close().catch(() => {});
  await admin.dispose();
  receipt.finishedAt = new Date().toISOString(); save();
}
