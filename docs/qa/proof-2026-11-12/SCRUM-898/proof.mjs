// SCRUM-898 / SCRUM-899 / SCRUM-900 staging proof: the Console's station form after a save, a save from an older
// version refused, a printer's address required, a refund's VOID-slip note on the till.
// Adapted from the SCRUM-861 harness beside this folder (proof-2026-11-12/SCRUM-861/staging/proof.mjs).
//
// Own ZZ TEST till and ZZ TEST simulated printers on Virtual box 1 (Central Floresta), invented numbers
// (08989800xx), cash only. Credentials are read by NAME from scripts/agent/env.mjs and never printed.
//
//   node proof.mjs <phase>      phases, in order:
//     setup     ZZ TEST printers (kids band, adult band, drop-off band, receipt, kitchen, bar), each with its own
//               simulator address, and a ZZ TEST till without a drop-off band printer
//     p1        898 race: choose the drop-off band printer, save, reopen at once (five rounds, two with the list
//               read held back), the form sampled every frame after it opens
//     p2        898 refusal: the same form open in two Consoles, A saves, B's older form is refused; then the
//               till's own Station setup save keeps the drop-off band printer
//     p3        899: Add a device without / with a bad / with a good address, Edit clears it; the api's refusals
//     p4        900: two F&B sales (fries + Coke), a refund with the bar printer (no notice), the bar printer
//               removed in the Console, a refund without it (the notice), replays
//     p5        nothing else moved: an ordinary ticket sale in cash; the printer light
//     cleanup   everything this run made, read back; sessions signed out
//   env: OTO_SCRATCH (raw previews and state; default the session scratch folder), ATTEMPT (keeps a retried
//   phase's receipt apart)
//   Other phases, as run: p1b (two more race rounds, the picture taken the moment the form opens), p2till / p2look
//   (point 2's till half on its own; a look at the till's printer cards), p3recheck / p3look / p3seen (point 3
//   re-judged; the 401s explained; the one seeded printer with no address, view only), readback (read only),
//   p4retake (point 4's notice picture again), p5receipt (read only).
//
// As run on 12 November 2026 (times UTC; Bangkok is +7):
//   08:47 setup, 08:48 p1, 08:49-08:51 p1b (attempt 1's pictures before scrolling kept as *-top.png), 08:52 p2: the
//   Console half passed; the till half stopped on this harness reading /me's station from the wrong field (the
//   manager was at the ZZ TEST till; that sign-in was not signed out, see the report). 08:53-08:55 p2till (third
//   try passed), 08:56 p2look, 08:56 p3 attempt 1 (its wait for the new row ran out; receipt-p3-attempt-1.json),
//   08:57 p3, 08:58 p3recheck and p3look, 09:01 p3seen attempt 1 (the browser ran out of memory before sign-in).
//   Interrupted at about 09:02. Resumed 10:05: readback found the till (config v11) and nine ZZ TEST printers, no
//   sale; p4 10:10, p4retake 10:13, p5 10:14, p5receipt, p3seen 10:15, cleanup and readback 10:16.
//   Services: points 1-3 on api and Console 7cb06ac6c (pos-web was 7cb06ac6c until 08:52:10, then 079b9431, which
//   contains it: point 2's till half and p2look ran on 079b9431); points 4-5 on api, pos and pos-web 348caa58d and
//   Console 7cb06ac6c (deploys-resume.json).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const PHASE = process.argv[2];
const out = import.meta.dirname;
const scratch = process.env.OTO_SCRATCH ?? 'C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/s898p';
const raw = resolve(scratch, 'raw');
mkdirSync(raw, { recursive: true });
const T = '898';
const POS = 'https://oto-pos-web-staging.onrender.com';
const CONSOLE = 'https://oto-console-staging.onrender.com';
const zz = i => '08989800' + String(10 + i);
const NUMBERS = { ordinary: zz(0) };
/** Each ZZ TEST printer its own simulator address in TEST-NET-1 (192.0.2.0/24, never routed). */
const ADDRESS = { kids_band: '192.0.2.98:9101', adult_band: '192.0.2.98:9102', dropoff_band: '192.0.2.98:9103', receipt: '192.0.2.98:9104', kitchen: '192.0.2.98:9105', bar: '192.0.2.98:9106' };
const ADDED_ADDRESS = '192.0.2.98:9120';
const CHANGED_WORDS = 'This till was changed since you opened it. Close it and open it again.';

// ---- state (ids only) and receipts ----
const stateFile = resolve(scratch, 'state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { created: [] };
const saveState = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
const receipt = { ticket: 'SCRUM-898/899/900', phase: PHASE, startedAt: new Date().toISOString(), step: null, points: {}, requests: [], odd: [], pageErrors: [], notes: [] };
const receiptFile = resolve(out, `receipt-${PHASE}${process.env.ATTEMPT ? '-attempt-' + process.env.ATTEMPT : ''}.json`);
const staffNames = new Set();
const save = () => writeFileSync(receiptFile, [...staffNames].sort((x, y) => y.length - x.length)
  .reduce((text, n) => text.replace(new RegExp(`(?<![A-Za-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'g'), '[staff]'), JSON.stringify(receipt, null, 2)) + '\n');
const step = v => { receipt.step = v; save(); console.log(new Date().toISOString(), v); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.step, what, ...extra }); save(); console.log('ODD', what); };
const point = (key, verdict, pictures, shows, seen = {}) => { receipt.points[key] = { verdict, pictures, shows, seen }; save(); console.log('POINT', key, verdict, '|', shows); };
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
const stationRow = async () => (await call('GET', `/branches/${state.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === state.station.id);
const devicesOnBox = async () => (await call('GET', `/boxes/${state.boxId}/devices?includeArchived=true`)).body.devices;
const rolesOf = row => Object.fromEntries((row?.devices ?? []).map(d => [d.role, d.label]));
const jobFacts = j => ({ id: j.id, kind: j.kind, role: j.role, device: j.deviceLabel ?? deviceName(j.deviceId), status: j.status, error: j.errorCode ?? null, subjectType: j.subjectType ?? null });
const deviceName = id => Object.entries(state.devices ?? {}).find(([, d]) => d.id === id)?.[1]?.label ?? (id ? 'not a ZZ TEST printer' : null);

// ---- the simulated printers: what each drew ----
async function printouts(role) {
  const dev = state.devices[role];
  const r = await call('GET', `/devices/${dev.id}/printouts?limit=20`);
  if (r.status !== 200) return { status: r.status, code: r.body?.error?.code ?? null, printouts: [] };
  return { status: 200, printouts: r.body.printouts };
}
const keyOf = p => `${p.seq}@${p.at}`;
const seqsOf = async role => (await printouts(role)).printouts.map(keyOf);
const freshOf = async (role, seen) => (await printouts(role)).printouts.filter(p => !seen.includes(keyOf(p)));
async function newPrintouts(role, seen, { want = 1, timeout = 90000 } = {}) {
  const deadline = Date.now() + timeout;
  let fresh = [];
  while (Date.now() < deadline) {
    fresh = await freshOf(role, seen);
    if (fresh.length >= want) return fresh;
    await sleep(3000);
  }
  return fresh;
}
async function keepPreview(role, p, name) {
  const dev = state.devices[role];
  const r = await admin.get(`/api/devices/${dev.id}/printouts/${p.seq}/preview.png`);
  assert.equal(r.status(), 200, 'preview read');
  writeFileSync(resolve(raw, name), await r.body());
  receipt.notes.push({ preview: name, role, seq: p.seq, at: p.at });
  save();
}
async function jobsPrinted(saleId, filter = () => true, timeout = 90000) {
  let jobs = [];
  await expect.poll(async () => { jobs = ((await readSale(saleId)).printJobs ?? []).filter(filter); return jobs.length > 0 && jobs.every(j => j.status === 'printed'); }, { timeout, intervals: [2000] }).toBe(true);
  return jobs;
}

// ---- browsers ----
let browser = null;
async function launch() {
  browser ??= await chromium.launch({ channel: 'msedge' });
  return browser;
}
function watch(page, label) {
  page.on('pageerror', e => { receipt.pageErrors.push({ page: label, at: receipt.step, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); save(); });
  page.on('console', m => { if (m.type() === 'error') { receipt.pageErrors.push({ page: label, at: receipt.step, time: new Date().toISOString(), kind: 'console.error', text: m.text().split('\n')[0].slice(0, 240) }); save(); } });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) { receipt.pageErrors.push({ page: label, at: receipt.step, time: new Date().toISOString(), kind: 'http', text: `${r.request().method()} ${idPath(u.pathname)} ${r.status()}` }); save(); } });
}
async function learnNames(page, base) {
  const me = await page.evaluate(async (u) => (await (await fetch(u, { credentials: 'include' })).json()), base + '/api/me').catch(() => null);
  for (const o of [me?.employee, me?.account]) for (const k of ['name', 'nickname']) {
    const v = o?.[k]; if (typeof v === 'string' && v.trim().length >= 2) { staffNames.add(v.trim()); for (const part of v.trim().split(/\s+/)) { const w = part.replace(/[()]/g, ''); if (w.length >= 3 && !/^(Manager|Reception|Owner|Khun|Admin)$/i.test(w)) staffNames.add(w); } }
  }
}
async function redactNames(page) {
  await page.evaluate((needles) => {
    const list = needles.filter(Boolean).sort((a, b) => b.length - a.length);
    const code = () => /Z\d{5}-(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,8}/g;
    // Whole words only: the first point-4 notice picture lost the "Som" of "Some" to a name part.
    const word = s => new RegExp('(?<![A-Za-z])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'gi');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const hits = [];
    while (w.nextNode()) {
      const v = w.currentNode.nodeValue || '';
      if (list.some(s => word(s).test(v)) || code().test(v)) hits.push(w.currentNode);
    }
    const bar = m => `<span style="background:#3f3f46;color:#3f3f46">${'█'.repeat(m.length)}</span>`;
    for (const t of hits) {
      let h = (t.nodeValue || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      for (const s of list) h = h.replace(word(s), bar);
      h = h.replace(code(), bar);
      const sp = document.createElement('span'); sp.innerHTML = h; t.parentNode.replaceChild(sp, t);
    }
  }, [...staffNames]).catch(() => {});
}
/** A Console picture: staff names blacked out, the signed-in corner and passwords masked. */
async function consoleShot(page, name, extra = []) {
  await redactNames(page);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByRole('button', { name: 'Sign out', exact: true }).locator('..'), page.locator('input[type="password"]'), ...extra] });
  console.log('picture', name);
  return name;
}
/** A till picture: staff names blacked out, account corner, passwords, codes and QR masked. */
async function shot(page, name, extra = []) {
  await redactNames(page);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
      page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/), page.locator('div.grid.gap-px'),
      page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/),
      page.getByRole('button', { name: 'Sign out', exact: true }).locator('..'), ...extra] });
  console.log('picture', name);
  return name;
}

// ---- the till (from SCRUM-861) ----
const halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digits) => { for (const d of digits) await scope.getByRole('button', { name: d, exact: true }).last().click(); };
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const isPath = (r, method, re) => r.request().method() === method && re.test(new URL(r.url()).pathname);
async function openTill(phoneKey, passwordKey, label) {
  const b = await launch();
  const ctx = await b.newContext({ baseURL: POS, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
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
  try {
    await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
    await learnNames(page, POS);
    const stationOf = async () => (await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json())))?.operatorContext?.stationId ?? null;
    let at = await stationOf();
    receipt.notes.push({ signedIn: label, stationIsOwn: at ? at === state.station.id : null }); save();
    if (at !== state.station.id) {
      // Not placed at the ZZ TEST till by the sign-in: pick it in the station picker.
      await page.goto('/station-setup');
      await page.getByRole('heading', { name: 'Which station are you on?' }).waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: state.station.name, exact: false }).first().click();
      await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
      await expect.poll(stationOf, { timeout: 20000 }).toBe(state.station.id);
      at = await stationOf();
      receipt.notes.push({ pickedInStationPicker: label, stationIsOwn: at === state.station.id }); save();
    }
    assert.equal(at, state.station.id, `${label} signed in at the ZZ TEST till`);
  } catch (e) {
    await closeTill({ ctx, page }, label);
    throw e;
  }
  return { ctx, page };
}
const lastScreens = [];
async function lastLook(page, label) {
  if (!page || page.isClosed()) return;
  await page.screenshot({ path: resolve(scratch, `last-${PHASE}-${label.replace(/\W+/g, '-')}.png`), animations: 'disabled', mask: [page.locator('input[type="password"]')] }).catch(() => {});
  lastScreens.push(`[${label}] ` + flat(await page.locator('body').innerText().catch(() => '')).slice(0, 900));
}
async function closeTill(t, label = 'till') {
  if (!t) return;
  await lastLook(t.page, label);
  try {
    const before = (await t.page.request.get('/api/me')).status();
    if (before === 200) assert.equal((await t.page.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.notes.push({ signedOut: label, me: (await t.page.request.get('/api/me')).status() }); save();
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
async function saleWritten(known) {
  let sale;
  await expect.poll(async () => { sale = (await stationSales()).find(x => ['tendering', 'open'].includes(x.status) && !known.has(x.id)); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  return sale;
}
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
async function openHistorySale(till, receiptNumber) {
  await till.goto('/'); await till.locator('a[href="/history"]').first().waitFor();
  await till.locator('a[href="/history"]').first().click();
  const search = till.getByPlaceholder(/^Search by name, receipt number/);
  await search.waitFor({ timeout: 20000 });
  await search.fill(receiptNumber);
  await till.getByText(receiptNumber, { exact: true }).first().click();
  await till.waitForTimeout(1500);
}
const auditOf = async (action, entityId) => ((await call('GET', `/audit?action=${encodeURIComponent(action)}&entityId=${entityId}&limit=50`)).body?.entries ?? []);

// ---- the Console ----
async function openConsole(label = 'console') {
  const b = await launch();
  const ctx = await b.newContext({ baseURL: CONSOLE, viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(CONSOLE);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/overview$/);
  await learnNames(page, CONSOLE);
  return { ctx, page, label };
}
async function closeConsole(c) {
  if (!c) return;
  await lastLook(c.page, c.label);
  try {
    const r = await c.ctx.request.post(CONSOLE + '/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
    receipt.notes.push({ consoleSignOut: c.label, time: new Date().toISOString(), status: r.status(), me: (await c.ctx.request.get(CONSOLE + '/api/me')).status() }); save();
  } catch (e) { odd('console sign-out failed', { error: firstLine(e) }); }
  await c.ctx.close().catch(() => {});
}
/** Devices > the branch > Stations, filtered to this run's till. */
async function goStations(page) {
  await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Branch').selectOption(state.branchId);
  await page.getByRole('button', { name: 'Stations', exact: true }).click();
  await page.getByPlaceholder('Name, identifier or type').fill(`ZZ TEST SCRUM-${T}`);
  await page.getByRole('button', { name: state.station.name, exact: true }).waitFor();
}
/** The station form, open on any name (its title follows the list's row). */
const stationDrawerOf = page => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save the station', exact: true }) });
async function openStationDrawer(page) {
  await page.getByRole('button', { name: state.station.name, exact: true }).click();
  const drawer = stationDrawerOf(page);
  await expect(drawer).toBeVisible();
  return drawer;
}
const dropoffField = drawer => drawer.getByLabel(/^Drop-off band printer/);
const barField = drawer => drawer.getByLabel(/^Bar printer/);
const nameField = drawer => drawer.getByLabel(/^Name/).first();
const versionShown = async drawer => Number((flat(await drawer.innerText()).match(/config v(\d+)/) ?? [])[1] ?? NaN);
/** Waits until the box's devices are in the select (the value shows once they are). */
async function devicesLoaded(drawer) {
  await expect.poll(async () => dropoffField(drawer).locator('option').count(), { timeout: 20000 }).toBeGreaterThan(1);
}
async function saveDrawer(page, drawer) {
  const waiting = page.waitForResponse(r => isPath(r, 'PATCH', new RegExp(`^/api/stations/${state.station.id}$`)));
  await drawer.getByRole('button', { name: 'Save the station', exact: true }).click();
  const res = await waiting;
  const body = await res.json().catch(() => null);
  const sent = JSON.parse(res.request().postData() ?? '{}');
  const facts = { via: 'console form', method: 'PATCH', path: '/stations/:id', status: res.status(), errorCode: body?.error?.code ?? null,
    expectedConfigVersionSent: sent.expectedConfigVersion ?? null, idempotencyKeySent: Boolean(res.request().headers()['idempotency-key']), devicesSent: sent.devices?.map(d => d.role) ?? null };
  receipt.requests.push(facts); save();
  return { status: res.status(), body, sent, facts };
}

// =====================================================================================
const phases = {};

phases.setup = async () => {
  step('setup: branch, Virtual box 1, unused numbers and prefix');
  const branch = (await call('GET', '/branches')).body.branches.find(b => /Central Floresta/.test(b.name));
  assert.ok(branch); state.branchId = branch.id; state.branchName = branch.name;
  const box = (await call('GET', `/branches/${branch.id}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'Virtual box 1 online'); state.boxId = box.id; state.boxName = box.name;
  for (const [k, n] of Object.entries(NUMBERS)) assert.equal(await memberOf(n), null, `ZZ number ${k} unused`);
  const stations = (await call('GET', `/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  step('setup: what printers on the box have no address (read only; for point 3\'s existing-printer case)');
  const onBox = (await call('GET', `/boxes/${box.id}/devices?includeArchived=true`)).body.devices;
  const printers = onBox.filter(d => d.kind.endsWith('printer'));
  receipt.points.beforeRun = {
    box: box.name,
    liveZzTestPrintersWithoutAddress: printers.filter(d => !d.archived && /^ZZ TEST/.test(d.label) && !d.address?.trim()).map(d => ({ id: d.id, label: d.label, createdAt: d.createdAt ?? null })),
    archivedZzTestPrintersWithoutAddress: printers.filter(d => d.archived && /^ZZ TEST/.test(d.label) && !d.address?.trim()).map(d => d.label),
    otherLivePrintersWithoutAddress: printers.filter(d => !d.archived && !/^ZZ TEST/.test(d.label) && !d.address?.trim()).length,
  };
  save();
  step('setup: ZZ TEST simulated printers on Virtual box 1, each with its own address');
  const defs = {
    kids_band: { kind: 'band_printer', label: `ZZ TEST SCRUM-${T} kids band printer`, model: '4B-2082A', protocol: 'tspl2' },
    adult_band: { kind: 'band_printer', label: `ZZ TEST SCRUM-${T} adult band printer`, model: '4B-2082A', protocol: 'tspl2' },
    dropoff_band: { kind: 'band_printer', label: `ZZ TEST SCRUM-${T} drop-off band printer`, model: '4B-2082A', protocol: 'tspl2' },
    receipt: { kind: 'receipt_printer', label: `ZZ TEST SCRUM-${T} receipt printer`, model: 'Xprinter XP-80', protocol: 'escpos' },
    kitchen: { kind: 'kitchen_printer', label: `ZZ TEST SCRUM-${T} kitchen printer`, model: 'Xprinter XP-80', protocol: 'escpos' },
    bar: { kind: 'bar_printer', label: `ZZ TEST SCRUM-${T} bar printer`, model: 'Xprinter XP-80', protocol: 'escpos' },
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
  const name = `ZZ TEST SCRUM-${T} proof till`;
  assert.ok(!stations.some(s => s.name === name && !s.archived), 'no live station of that name');
  const devices = ['kids_band', 'adult_band', 'receipt', 'kitchen', 'bar'].map(role => ({ role, deviceId: state.devices[role].id }));
  const made = await call('POST', `/branches/${branch.id}/stations`, { name, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200, 'station');
  state.station = { id: made.body.station.id, name, prefix };
  state.created.push({ kind: 'station', id: made.body.station.id, name, prefix }); saveState();
  receipt.points.setup = { station: { name, prefix, configVersion: made.body.station.configVersion, devices: made.body.station.devices.map(d => ({ role: d.role, label: d.label })) } };
  save();
  console.log(JSON.stringify(receipt.points, null, 1));
};

// ---- 1: SCRUM-898, the race ----
/** Every animation frame from the moment the station form appears: the version it says and the drop-off select. */
async function startSampler(page, ms) {
  await page.evaluate((ms) => {
    const s = { samples: [], first: null, done: false };
    window.__s898 = s;
    const t0 = performance.now();
    const tick = () => {
      const now = performance.now();
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find(d => (d.innerText || '').includes('Its devices'));
      if (dlg) {
        if (s.first === null) s.first = now;
        const m = (dlg.innerText || '').match(/config v(\d+)/);
        const label = [...dlg.querySelectorAll('label')].find(l => (l.querySelector('span')?.textContent || '').trim().startsWith('Drop-off band printer'));
        const sel = label?.querySelector('select');
        s.samples.push({ t: Math.round(now - t0), version: m ? Number(m[1]) : null, dropoff: sel ? sel.value : null, options: sel ? sel.options.length : 0 });
      }
      if ((s.first !== null && now - s.first > ms) || now - t0 > ms + 20000) { s.done = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}
async function raceRound(page, round, target, { holdList, picture, pictureAtOnce }) {
  const listPath = new RegExp(`^/api/branches/${state.branchId}/stations$`);
  const listReads = [];
  const onResp = r => { if (r.request().method() === 'GET' && listPath.test(new URL(r.url()).pathname)) listReads.push({ at: Date.now(), status: r.status() }); };
  page.on('response', onResp);
  const hold = async route => { await sleep(8000); await route.continue().catch(() => {}); };
  const matcher = u => listPath.test(new URL(u).pathname);
  if (holdList) await page.route(matcher, hold);
  try {
    const before = await stationRow();
    let drawer = await openStationDrawer(page);
    await devicesLoaded(drawer);
    const shownBefore = await versionShown(drawer);
    const fieldBefore = await dropoffField(drawer).inputValue();
    await dropoffField(drawer).selectOption(target);
    const saved = await saveDrawer(page, drawer);
    const savedAt = Date.now();
    assert.equal(saved.status, 200, `round ${round} saved`);
    const newVersion = saved.body.station.configVersion;
    await expect(drawer).toHaveCount(0, { timeout: 10000 });
    await startSampler(page, holdList ? 10000 : 3000);
    const clickAt = Date.now();
    await page.getByRole('button', { name: state.station.name, exact: true }).click();
    let atOnce = null;
    if (pictureAtOnce) {
      // The picture the moment the form is drawn, while the list's re-read is still held back.
      await expect(stationDrawerOf(page)).toBeVisible();
      await dropoffField(stationDrawerOf(page)).scrollIntoViewIfNeeded();
      await consoleShot(page, pictureAtOnce);
      atOnce = { picture: pictureAtOnce, msAfterSave: Date.now() - savedAt, listReadsLandedBeforePicture: listReads.filter(r => r.at > savedAt).length };
    }
    await page.waitForFunction(() => window.__s898?.done === true, null, { timeout: 60000 });
    const samples = await page.evaluate(() => window.__s898.samples);
    drawer = stationDrawerOf(page);
    let pic = null;
    if (picture) {
      await dropoffField(drawer).scrollIntoViewIfNeeded();
      pic = await consoleShot(page, picture);
    }
    const shownAfter = await versionShown(drawer);
    const fieldAfter = await dropoffField(drawer).inputValue();
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    const after = await stationRow();
    const versions = [...new Set(samples.map(s => s.version))];
    const values = [...new Set(samples.filter(s => s.options > 1).map(s => s.dropoff))];
    const result = {
      round, target: target ? 'ZZ TEST drop-off band printer' : 'Not set', listReadHeldBack: holdList,
      versionBefore: before.configVersion, formShowedBefore: shownBefore, fieldBefore: fieldBefore ? 'ZZ TEST drop-off band printer' : 'Not set',
      save: { status: saved.status, expectedConfigVersionSent: saved.facts.expectedConfigVersionSent, answeredVersion: newVersion },
      reopenedMsAfterSave: clickAt - savedAt,
      listReadsLandedBetweenSaveAndReopen: listReads.filter(r => r.at > savedAt && r.at <= clickAt).length,
      listReadsLandedWhileOpen: listReads.filter(r => r.at > clickAt).length,
      framesSampled: samples.length, firstFrameMs: samples[0]?.t ?? null, lastFrameMs: samples.at(-1)?.t ?? null,
      versionsSeen: versions, dropoffValuesSeen: values.map(v => v === state.devices.dropoff_band.id ? 'ZZ TEST drop-off band printer' : v === '' ? 'Not set' : v),
      framesBeforeDevicesLoaded: samples.filter(s => s.options <= 1).length,
      formShowedAfter: shownAfter, fieldAfter: fieldAfter ? 'ZZ TEST drop-off band printer' : 'Not set',
      apiAfter: { configVersion: after.configVersion, dropoff: rolesOf(after).dropoff_band ?? 'Not set' },
      picture: pic ?? atOnce?.picture ?? null, atOnce,
    };
    result.ok = saved.facts.expectedConfigVersionSent === shownBefore && shownBefore === before.configVersion && newVersion === before.configVersion + 1
      && versions.length === 1 && versions[0] === newVersion && values.length === 1 && values[0] === target
      && shownAfter === newVersion && fieldAfter === target && after.configVersion === newVersion
      && (target ? rolesOf(after).dropoff_band === state.devices.dropoff_band.label : !rolesOf(after).dropoff_band);
    return result;
  } finally {
    page.off('response', onResp);
    if (holdList) { await page.unroute(matcher, hold).catch(() => {}); await sleep(9000); }
  }
}
phases.p1 = async () => {
  const c = await openConsole('console');
  try {
    step('1: Console, Devices > Stations, the ZZ TEST till');
    await goStations(c.page);
    const rounds = [];
    const dev = state.devices.dropoff_band.id;
    step('1: round 1, drop-off band printer chosen, saved, reopened at once');
    rounds.push(await raceRound(c.page, 1, dev, { holdList: false, picture: '01-console-reopened-at-once-dropoff-printer-kept.png' }));
    step('1: round 2, set back to Not set, reopened at once');
    rounds.push(await raceRound(c.page, 2, '', { holdList: false }));
    step('1: round 3, chosen again, the list re-read held back 8 s');
    rounds.push(await raceRound(c.page, 3, dev, { holdList: true, picture: '01b-console-reopened-list-read-held-back.png' }));
    step('1: round 4, Not set, the list re-read held back 8 s');
    rounds.push(await raceRound(c.page, 4, '', { holdList: true }));
    step('1: round 5, chosen again, reopened at once (left assigned for point 2)');
    rounds.push(await raceRound(c.page, 5, dev, { holdList: false }));
    receipt.points['1-rounds'] = rounds; save();
    step('1: a fresh page: the form again');
    await c.page.reload();
    await goStations(c.page);
    const drawer = await openStationDrawer(c.page);
    await devicesLoaded(drawer);
    await expect(dropoffField(drawer)).toHaveValue(dev, { timeout: 20000 });
    const afterReload = { version: await versionShown(drawer), dropoff: (await dropoffField(drawer).inputValue()) === dev };
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    const row = await stationRow();
    const ok = rounds.every(r => r.ok) && afterReload.version === row.configVersion && afterReload.dropoff;
    point('1', ok ? 'PASS' : 'FAIL', rounds.map(r => r.picture).filter(Boolean),
      'Five rounds of choose, Save the station, reopen at once (two with the list re-read held back 8 s in the browser): every frame of the reopened form shows the saved printer choice and the new config version; the save sends expectedConfigVersion; the api reads the same back',
      { rounds, afterReload, apiNow: { configVersion: row.configVersion, devices: rolesOf(row) } });
  } finally { await closeConsole(c); }
};

/**
 * Two more rounds whose picture is taken the moment the reopened form is drawn, with the list's re-read held back,
 * so the picture itself is from before the list could have refreshed (rounds 1-5 took theirs after sampling).
 */
phases.p1b = async () => {
  const c = await openConsole('console');
  try {
    await goStations(c.page);
    const dev = state.devices.dropoff_band.id;
    const before = await stationRow();
    assert.equal(rolesOf(before).dropoff_band, state.devices.dropoff_band.label, 'starts assigned (round 5 or 7)');
    // As run: attempt 1 (rounds 6-7, v6->v8) drew its pictures before scrolling to the devices, so they show the
    // version but not the select (kept as *-top.png); attempt 2 (rounds 8-9) scrolls to the select first.
    const first = before.configVersion === 6 ? 6 : 8;
    const rounds = [];
    step(`1b: round ${first}, Not set, the list re-read held back, the picture at once`);
    rounds.push(await raceRound(c.page, first, '', { holdList: true, pictureAtOnce: '01c-console-reopened-at-once-not-set-list-held.png' }));
    step(`1b: round ${first + 1}, the drop-off band printer, the list re-read held back, the picture at once`);
    rounds.push(await raceRound(c.page, first + 1, dev, { holdList: true, pictureAtOnce: '01d-console-reopened-at-once-dropoff-printer-list-held.png' }));
    const ok = rounds.every(r => r.ok && r.atOnce.listReadsLandedBeforePicture === 0);
    point('1b', ok ? 'PASS' : 'FAIL', rounds.map(r => r.atOnce.picture),
      'Two rounds with the picture taken the moment the reopened form is drawn, the list re-read still held back (none landed before the picture): the form shows the saved choice and the new version',
      { rounds });
  } finally { await closeConsole(c); }
};

// ---- 2: SCRUM-898, the refusal; the till's own Station setup ----
phases.p2 = async () => {
  const A = await openConsole('console A');
  const B = await openConsole('console B');
  const facts = {};
  try {
    step('2: the till\'s form open in two Consoles, A and B');
    await goStations(A.page); await goStations(B.page);
    let dA = await openStationDrawer(A.page); await devicesLoaded(dA);
    let dB = await openStationDrawer(B.page); await devicesLoaded(dB);
    const before = await stationRow();
    facts.before = { configVersion: before.configVersion, name: before.name, devices: rolesOf(before) };
    facts.opened = { A: await versionShown(dA), B: await versionShown(dB) };
    const nameA = `ZZ TEST SCRUM-${T} proof till A`, nameB = `ZZ TEST SCRUM-${T} proof till B`;
    step('2: A renames the till and saves');
    await nameField(dA).fill(nameA);
    const savedA = await saveDrawer(A.page, dA);
    assert.equal(savedA.status, 200, 'A saved');
    await expect(dA).toHaveCount(0);
    state.station.name = nameA; saveState();
    facts.A = { status: savedA.status, expectedConfigVersionSent: savedA.facts.expectedConfigVersionSent, answeredVersion: savedA.body.station.configVersion, name: savedA.body.station.name };
    step('2: B, still on the version it opened, renames differently and saves');
    await nameField(dB).fill(nameB);
    const savedB = await saveDrawer(B.page, dB);
    facts.B = { status: savedB.status, errorCode: savedB.body?.error?.code ?? null, apiMessage: savedB.body?.error?.message ?? null, details: savedB.body?.error?.details ?? null, expectedConfigVersionSent: savedB.facts.expectedConfigVersionSent };
    const refusal = dB.getByText(CHANGED_WORDS, { exact: true });
    await expect(refusal).toBeVisible({ timeout: 10000 });
    await refusal.scrollIntoViewIfNeeded();
    await B.page.waitForTimeout(2500); // the list re-read the refusal asks for lands
    facts.B.drawerStillOpen = await dB.isVisible();
    facts.B.typedNameKept = (await nameField(dB).inputValue()) === nameB;
    facts.B.drawerTitleNow = await dB.getAttribute('aria-label');
    facts.B.versionShownNow = await versionShown(dB);
    await consoleShot(B.page, '02a-console-second-form-refused-changed-since-opened.png');
    const afterB = await stationRow();
    facts.readBackAfterB = { configVersion: afterB.configVersion, name: afterB.name, devices: rolesOf(afterB) };
    step('2: B presses Save again (still refused), then closes and reopens');
    const savedB2 = await saveDrawer(B.page, dB);
    facts.B.secondPress = { status: savedB2.status, errorCode: savedB2.body?.error?.code ?? null };
    await dB.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dB).toHaveCount(0);
    dB = await openStationDrawer(B.page); await devicesLoaded(dB);
    facts.B.reopened = { name: await nameField(dB).inputValue(), version: await versionShown(dB), dropoffKept: (await dropoffField(dB).inputValue()) === state.devices.dropoff_band.id };
    await consoleShot(B.page, '02b-console-reopened-shows-first-save.png');
    await dB.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally { await closeConsole(A); await closeConsole(B); }
  receipt.points['2-console'] = facts; save();
  await tillSetupPart(facts);
};

/**
 * Point 2's second half on its own: the till's Station setup save, then the Console's form. As run, the first p2
 * stopped here when the manager's sign-in did not land on the ZZ TEST till (receipt-p2.json keeps the Console half).
 */
phases.p2till = async () => {
  const first = JSON.parse(readFileSync(resolve(out, 'receipt-p2.json'), 'utf8')).points['2-console'];
  assert.ok(first?.B?.errorCode === 'STATION_CHANGED', 'the Console half of point 2 ran');
  receipt.points['2-console'] = first; save();
  await tillSetupPart({ ...first });
};

async function tillSetupPart(facts) {
  step('2: the till\'s own Station setup, saved without a change');
  const t = await openTill('STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD', 'manager till');
  try {
    await t.page.goto('/station-setup/settings');
    const saveBtn = t.page.getByRole('button', { name: 'Save changes', exact: true });
    await saveBtn.waitFor({ timeout: 30000 });
    await t.page.waitForTimeout(4000);
    const access = t.page.getByText('Who may use this station', { exact: true }).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " p-6 ")][1]');
    await shot(t.page, '02c-till-station-setup-before-save.png', [access]);
    const before = await stationRow();
    const [res] = await Promise.all([
      t.page.waitForResponse(r => isPath(r, 'PATCH', new RegExp(`^/api/stations/${state.station.id}$`)), { timeout: 30000 }),
      saveBtn.click(),
    ]);
    const sent = JSON.parse(res.request().postData() ?? '{}');
    await t.page.waitForTimeout(3000);
    const after = await stationRow();
    facts.tillSetup = { status: res.status(), expectedConfigVersionSent: sent.expectedConfigVersion ?? null, devicesSent: (sent.devices ?? []).map(d => d.role),
      versionBefore: before.configVersion, versionAfter: after.configVersion, dropoffBefore: rolesOf(before).dropoff_band ?? null, dropoffAfter: rolesOf(after).dropoff_band ?? null, devicesAfter: rolesOf(after) };
    await shot(t.page, '02d-till-station-setup-saved.png');
  } finally { await closeTill(t, 'manager till'); }
  const c = await openConsole('console');
  try {
    await goStations(c.page);
    const d = await openStationDrawer(c.page); await devicesLoaded(d);
    await dropoffField(d).scrollIntoViewIfNeeded();
    facts.consoleAfterTillSave = { version: await versionShown(d), dropoffKept: (await dropoffField(d).inputValue()) === state.devices.dropoff_band.id };
    await consoleShot(c.page, '02e-console-after-till-save-dropoff-printer-kept.png');
    await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally { await closeConsole(c); }
  const ok = facts.opened.A === facts.before.configVersion && facts.opened.B === facts.before.configVersion
    && facts.A.status === 200 && facts.A.answeredVersion === facts.before.configVersion + 1
    && facts.B.status === 409 && facts.B.errorCode === 'STATION_CHANGED' && facts.B.expectedConfigVersionSent === facts.before.configVersion && facts.B.drawerStillOpen && facts.B.typedNameKept
    && facts.readBackAfterB.name === `ZZ TEST SCRUM-${T} proof till A` && facts.readBackAfterB.configVersion === facts.A.answeredVersion
    && facts.B.secondPress.status === 409
    && facts.B.reopened.name === `ZZ TEST SCRUM-${T} proof till A` && facts.B.reopened.version === facts.A.answeredVersion
    && facts.tillSetup.status === 200 && facts.tillSetup.expectedConfigVersionSent === null && facts.tillSetup.dropoffAfter === state.devices.dropoff_band.label
    && facts.consoleAfterTillSave.dropoffKept;
  point('2', ok ? 'PASS' : 'FAIL', ['02a-console-second-form-refused-changed-since-opened.png', '02b-console-reopened-shows-first-save.png', '02c-till-station-setup-before-save.png', '02d-till-station-setup-saved.png', '02e-console-after-till-save-dropoff-printer-kept.png'],
    'Two Consoles open on the same version: A saves a rename; B\'s different rename from the older version is refused 409 STATION_CHANGED, the form stays open with what was typed and says "This till was changed since you opened it. Close it and open it again."; nothing written; reopened it shows A\'s save. The till\'s Station setup save (no version sent) still saves and keeps the drop-off band printer',
    facts);
}

/** A look only (no save): the till's Station settings, its printer cards, for the picture point 2's first one missed. */
phases.p2look = async () => {
  const t = await openTill('STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD', 'manager till');
  try {
    await t.page.goto('/station-setup/settings');
    await t.page.getByRole('button', { name: 'Save changes', exact: true }).waitFor({ timeout: 30000 });
    await t.page.waitForTimeout(4000);
    const kitchen = t.page.getByText('Kitchen printer', { exact: true }).first();
    await kitchen.scrollIntoViewIfNeeded();
    await t.page.mouse.wheel(0, 250);
    await t.page.waitForTimeout(800);
    const cards = flat(await t.page.locator('body').innerText()).match(/(Receipt printer|Kids bracelet printer|Adult bracelet printer|Kitchen printer|Bar printer|Drop-off[^.]*printer)/g);
    receipt.points['2-look'] = { printerCardsOnTheTillsSettings: [...new Set(cards ?? [])] }; save();
    const access = t.page.getByText('Who may use this station', { exact: true }).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " p-6 ")][1]');
    await shot(t.page, '02c2-till-station-setup-printer-cards.png', [access]);
  } finally { await closeTill(t, 'manager till'); }
};

// ---- 3: SCRUM-899, a printer's address ----
phases.p3 = async () => {
  const facts = { console: {}, api: {} };
  const c = await openConsole('console');
  // As run: attempt 1 added "ZZ TEST SCRUM-898 no address" through the form (POST 200, 192.0.2.98:9120), then its
  // wait for the new row ran out before the box's list re-read showed it (the row was there in its last picture).
  // That printer stays in state for the clean-up; attempt 2 adds its own under a new label and waits longer.
  const attempt = state.devices.added ? 2 : 1;
  if (state.devices.added) state.devices.addedAttempt1 = state.devices.added;
  const addedLabel = `ZZ TEST SCRUM-${T} no address${attempt === 2 ? ' 2' : ''}`;
  const addedAddress = attempt === 2 ? '192.0.2.98:9122' : ADDED_ADDRESS;
  try {
    step('3: Console, Devices > Boxes > Virtual box 1 > Add a device');
    await c.page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
    await c.page.getByLabel('Branch').selectOption(state.branchId);
    await c.page.getByRole('button', { name: 'Boxes', exact: true }).click();
    await c.page.getByRole('button', { name: state.boxName, exact: true }).click();
    const boxDrawer = c.page.getByRole('dialog', { name: state.boxName, exact: true });
    await expect(boxDrawer).toBeVisible();
    await boxDrawer.getByRole('button', { name: 'Add a device', exact: true }).click();
    const form = boxDrawer.locator('div.rounded-xl').filter({ has: c.page.getByRole('button', { name: 'Add it', exact: true }) }).last();
    await form.getByLabel(/^What it is/).selectOption('band_printer');
    await form.getByLabel(/^Label/).fill(addedLabel);
    await form.getByLabel(/^How the box reaches it/).selectOption('simulated');
    await form.getByLabel(/^Protocol/).fill('tspl2');
    const addIt = form.getByRole('button', { name: 'Add it', exact: true });
    const addressLabel = form.locator('label').filter({ hasText: /^Address/ });
    const address = form.getByLabel(/^Address/);
    const hintOf = async () => flat(await addressLabel.innerText()).replace(/^Address\s*/i, '');
    await address.scrollIntoViewIfNeeded();
    facts.console.empty = { addItEnabled: await addIt.isEnabled(), hint: await hintOf() };
    await consoleShot(c.page, '03a-console-add-printer-no-address-held-back.png');
    await address.fill('/dev/usb/lp0');
    facts.console.devPath = { addItEnabled: await addIt.isEnabled(), hint: await hintOf() };
    await consoleShot(c.page, '03b-console-add-printer-dev-path-refused.png');
    await address.fill('tcp://192.0.2.98:9100');
    facts.console.tcpUrl = { addItEnabled: await addIt.isEnabled(), hint: await hintOf() };
    await address.fill(addedAddress);
    facts.console.valid = { addItEnabled: await addIt.isEnabled(), hint: await hintOf() };
    await consoleShot(c.page, '03c-console-add-printer-valid-address.png');
    const [made] = await Promise.all([
      c.page.waitForResponse(r => isPath(r, 'POST', new RegExp(`^/api/boxes/${state.boxId}/devices$`))),
      addIt.click(),
    ]);
    const madeBody = await made.json().catch(() => null);
    facts.console.added = { status: made.status(), address: madeBody?.device?.address ?? null };
    assert.equal(made.status(), 200, 'printer added');
    state.devices.added = { id: madeBody.device.id, label: addedLabel, kind: 'band_printer' };
    state.created.push({ kind: 'device', role: 'added', id: madeBody.device.id, label: addedLabel }); saveState();
    receipt.points['3-console'] = facts.console; save();
    const row = boxDrawer.getByRole('listitem').filter({ hasText: addedLabel }).first();
    await expect(row).toBeVisible({ timeout: 60000 });
    await row.scrollIntoViewIfNeeded();
    facts.console.rowText = flat(await row.innerText()).slice(0, 200);
    step('3: Edit that printer: clear the address, then put it back');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    // The row turns into the edit form (inputs, no label text): found as the one row with "Archive it".
    const editing = boxDrawer.getByRole('listitem').filter({ has: c.page.getByRole('button', { name: 'Archive it', exact: true }) });
    await expect(editing).toHaveCount(1);
    await expect(editing.getByLabel(/^Label/)).toHaveValue(addedLabel);
    const editAddress = editing.getByLabel(/^Address/);
    const editSave = editing.getByRole('button', { name: 'Save', exact: true });
    await editAddress.fill('');
    facts.console.editCleared = { saveEnabled: await editSave.isEnabled(), hint: flat(await editing.locator('label').filter({ hasText: /^Address/ }).innerText()).replace(/^Address\s*/i, '') };
    receipt.points['3-console'] = facts.console; save();
    await editAddress.scrollIntoViewIfNeeded();
    await consoleShot(c.page, '03d-console-edit-printer-address-cleared-save-held-back.png');
    await editAddress.fill('/dev/ttyUSB0');
    facts.console.editDevPath = { saveEnabled: await editSave.isEnabled() };
    await editAddress.fill(addedAddress);
    facts.console.editRestored = { saveEnabled: await editSave.isEnabled() };
    await editing.getByLabel(/^Label/).fill(`${addedLabel} renamed`);
    const [patched] = await Promise.all([
      c.page.waitForResponse(r => isPath(r, 'PATCH', new RegExp(`^/api/devices/${state.devices.added.id}$`))),
      editSave.click(),
    ]);
    const patchedBody = await patched.json().catch(() => null);
    facts.console.editSaved = { status: patched.status(), label: patchedBody?.device?.label ?? null, address: patchedBody?.device?.address ?? null };
    state.devices.added.label = `${addedLabel} renamed`; saveState();
  } finally { await closeConsole(c); }
  receipt.points['3-console'] = facts.console; save();

  step('3: the api: the same refusals');
  const tryCreate = async (kind, address) => {
    const id = randomUUID();
    const r = await call('POST', `/boxes/${state.boxId}/devices`, { id, kind, label: `ZZ TEST SCRUM-${T} api refused`, transport: 'simulated', ...(address === undefined ? {} : { address }) });
    if (r.status === 200) { state.created.push({ kind: 'device', role: 'unexpected', id, label: `ZZ TEST SCRUM-${T} api refused` }); saveState(); }
    const written = (await devicesOnBox()).some(d => d.id === id);
    return { status: r.status, code: r.body?.error?.code ?? null, written };
  };
  facts.api.create = {
    bandNoAddress: await tryCreate('band_printer', undefined),
    receiptBlank: await tryCreate('receipt_printer', '   '),
    kitchenDevPath: await tryCreate('kitchen_printer', '/dev/usb/lp0'),
    barTcpUrl: await tryCreate('bar_printer', 'tcp://192.0.2.98:9100'),
    bandIpv6: await tryCreate('band_printer', '[::1]:9100'),
    bandBadPort: await tryCreate('band_printer', '192.0.2.98:70000'),
  };
  const trimId = randomUUID();
  const trimmed = await call('POST', `/boxes/${state.boxId}/devices`, { id: trimId, kind: 'receipt_printer', label: `ZZ TEST SCRUM-${T} trimmed address`, transport: 'simulated', address: '  192.0.2.98:9121  ' });
  if (trimmed.status === 200) { state.devices.trimmed = { id: trimId, label: `ZZ TEST SCRUM-${T} trimmed address`, kind: 'receipt_printer' }; state.created.push({ kind: 'device', role: 'trimmed', id: trimId, label: state.devices.trimmed.label }); saveState(); }
  facts.api.validWithSpaces = { status: trimmed.status, storedAddress: trimmed.body?.device?.address ?? null };
  const added = state.devices.added.id;
  const patch = async body => { const r = await call('PATCH', `/devices/${added}`, body); return { status: r.status, code: r.body?.error?.code ?? null }; };
  facts.api.edit = {
    clearEmpty: await patch({ address: '' }),
    clearNull: await patch({ address: null }),
    devPath: await patch({ address: '/dev/usb/lp0' }),
    renameOnly: await patch({ label: `${state.devices.added.label}` }),
  };
  const addedNow = (await devicesOnBox()).find(d => d.id === added);
  facts.api.addedReadBack = { label: addedNow.label, address: addedNow.address, archived: addedNow.archived };

  step('3: an existing ZZ TEST printer without an address, if this morning left one');
  const legacy = (await devicesOnBox()).filter(d => !d.archived && /^ZZ TEST/.test(d.label) && d.kind.endsWith('printer') && !d.address?.trim());
  facts.legacy = legacy.length === 0 ? 'none live on Virtual box 1 (every ZZ TEST printer there is archived or has an address), and the api no longer makes one'
    : legacy.map(d => ({ label: d.label, createdAt: d.createdAt ?? null }));
  const ok = !facts.console.empty.addItEnabled && /^Required for a printer\./.test(facts.console.empty.hint)
    && !facts.console.devPath.addItEnabled && /not an address the box can print to/.test(facts.console.devPath.hint)
    && !facts.console.tcpUrl.addItEnabled && facts.console.valid.addItEnabled && facts.console.added.status === 200 && facts.console.added.address === addedAddress
    && !facts.console.editCleared.saveEnabled && !facts.console.editDevPath.saveEnabled && facts.console.editRestored.saveEnabled && facts.console.editSaved.status === 200
    && facts.api.create.bandNoAddress.status === 400 && facts.api.create.bandNoAddress.code === 'PRINTER_ADDRESS_REQUIRED'
    && facts.api.create.receiptBlank.code === 'PRINTER_ADDRESS_REQUIRED'
    && ['kitchenDevPath', 'barTcpUrl', 'bandIpv6', 'bandBadPort'].every(k => facts.api.create[k].status === 400 && facts.api.create[k].code === 'PRINTER_ADDRESS_INVALID')
    && Object.values(facts.api.create).every(x => !x.written)
    && facts.api.validWithSpaces.status === 200 && facts.api.validWithSpaces.storedAddress === '192.0.2.98:9121'
    && facts.api.edit.clearEmpty.code === 'PRINTER_ADDRESS_REQUIRED' && facts.api.edit.clearNull.code === 'PRINTER_ADDRESS_REQUIRED' && facts.api.edit.devPath.code === 'PRINTER_ADDRESS_INVALID'
    && facts.api.edit.renameOnly.status === 200 && facts.api.addedReadBack.address === addedAddress;
  point('3', ok ? 'PASS' : 'FAIL', ['03a-console-add-printer-no-address-held-back.png', '03b-console-add-printer-dev-path-refused.png', '03c-console-add-printer-valid-address.png', '03d-console-edit-printer-address-cleared-save-held-back.png'],
    'Add a device: a band printer with no address cannot be added and the form says why; /dev/usb/lp0 and tcp:// are refused; 192.0.2.98:9120 adds. Edit: clearing or breaking the address holds Save back; restored, it saves. The api refuses the same (400 PRINTER_ADDRESS_REQUIRED / PRINTER_ADDRESS_INVALID), writes nothing, and stores an address trimmed',
    facts);
};

/**
 * Point 3's verdict again, from receipt-p3.json, with one check corrected. The harness wanted PATCH { address: '' }
 * refused PRINTER_ADDRESS_REQUIRED; the route's own schema (address: z.string().min(1).nullable()) refuses an empty
 * string first, 400 VALIDATION, and writes nothing. That is still a refusal; null and a blank are the printer rule's.
 */
phases.p3recheck = async () => {
  const facts = JSON.parse(readFileSync(resolve(out, 'receipt-p3.json'), 'utf8')).points['3'].seen;
  const addedAddress = facts.console.added.address;
  const ok = !facts.console.empty.addItEnabled && /^Required for a printer\./.test(facts.console.empty.hint)
    && !facts.console.devPath.addItEnabled && /not an address the box can print to/.test(facts.console.devPath.hint)
    && !facts.console.tcpUrl.addItEnabled && facts.console.valid.addItEnabled && facts.console.added.status === 200
    && !facts.console.editCleared.saveEnabled && !facts.console.editDevPath.saveEnabled && facts.console.editRestored.saveEnabled && facts.console.editSaved.status === 200
    && facts.api.create.bandNoAddress.status === 400 && facts.api.create.bandNoAddress.code === 'PRINTER_ADDRESS_REQUIRED'
    && facts.api.create.receiptBlank.code === 'PRINTER_ADDRESS_REQUIRED'
    && ['kitchenDevPath', 'barTcpUrl', 'bandIpv6', 'bandBadPort'].every(k => facts.api.create[k].status === 400 && facts.api.create[k].code === 'PRINTER_ADDRESS_INVALID')
    && Object.values(facts.api.create).every(x => !x.written)
    && facts.api.validWithSpaces.status === 200 && facts.api.validWithSpaces.storedAddress === '192.0.2.98:9121'
    && facts.api.edit.clearEmpty.status === 400 && facts.api.edit.clearNull.code === 'PRINTER_ADDRESS_REQUIRED' && facts.api.edit.devPath.code === 'PRINTER_ADDRESS_INVALID'
    && facts.api.edit.renameOnly.status === 200 && facts.api.addedReadBack.address === addedAddress;
  point('3', ok ? 'PASS' : 'FAIL', ['03a-console-add-printer-no-address-held-back.png', '03b-console-add-printer-dev-path-refused.png', '03c-console-add-printer-valid-address.png', '03d-console-edit-printer-address-cleared-save-held-back.png'],
    'Point 3 re-judged from receipt-p3.json: PATCH { address: "" } is refused 400 VALIDATION by the route schema (not PRINTER_ADDRESS_REQUIRED); everything else as receipt-p3.json shows',
    { correctedCheck: { clearEmpty: facts.api.edit.clearEmpty, clearNull: facts.api.edit.clearNull }, readFrom: 'receipt-p3.json' });
  // The address the printer holds now, read back after the refusals.
  const now = (await devicesOnBox()).find(d => d.id === state.devices.added.id);
  receipt.notes.push({ addedPrinterNow: { label: now.label, address: now.address, archived: now.archived } }); save();
};

/** The box drawer left open 30 s, then the session signed out: which reads fail, and when (the 401s in p3). */
phases.p3look = async () => {
  const c = await openConsole('console');
  try {
    step('3look: Virtual box 1 drawer open, idle 30 s');
    await c.page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
    await c.page.getByLabel('Branch').selectOption(state.branchId);
    await c.page.getByRole('button', { name: 'Boxes', exact: true }).click();
    await c.page.getByRole('button', { name: state.boxName, exact: true }).click();
    await expect(c.page.getByRole('dialog', { name: state.boxName, exact: true })).toBeVisible();
    const reads = [];
    c.page.on('response', r => { const u = new URL(r.url()); if (/\/api\/boxes\/[^/]+\/devices$/.test(u.pathname)) reads.push({ time: new Date().toISOString(), status: r.status() }); });
    await c.page.waitForTimeout(30000);
    receipt.points['3-look'] = { deviceReadsWhileOpen: reads.slice() }; save();
    step('3look: signed out with the drawer still open, 10 s more');
    const signedOutAt = new Date().toISOString();
    await c.ctx.request.post(CONSOLE + '/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
    await c.page.waitForTimeout(10000);
    receipt.points['3-look'] = { deviceReadsWhileOpen: reads.filter(r => r.time < signedOutAt), signedOutAt, deviceReadsAfterSignOut: reads.filter(r => r.time >= signedOutAt) };
    await c.page.screenshot({ path: resolve(scratch, 'p3look-after-sign-out.png') });
    save();
  } finally { await closeConsole(c); }
};

/**
 * Read only: the one printer on staging with no address (seeded: Robinson Chalong, Virtual box 3, "Receipt Printer 1")
 * as the box's device list in the Console now words it. Nothing is pressed but the box's card; no Edit, no save.
 */
phases.p3seen = async () => {
  const c = await openConsole('console');
  try {
    step('3seen: Robinson Chalong > Boxes > Virtual box 3 (view only)');
    await c.page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
    const branch = (await call('GET', '/branches')).body.branches.find(b => /Robinson Chalong/.test(b.name));
    await c.page.getByLabel('Branch').selectOption(branch.id);
    await c.page.getByRole('button', { name: 'Boxes', exact: true }).click();
    await c.page.getByRole('button', { name: 'Virtual box 3', exact: true }).click();
    const drawer = c.page.getByRole('dialog', { name: 'Virtual box 3', exact: true });
    await expect(drawer).toBeVisible();
    const row = drawer.getByRole('listitem').filter({ hasText: 'Receipt Printer 1' }).first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.scrollIntoViewIfNeeded();
    receipt.points['3-seen'] = { branch: branch.name, box: 'Virtual box 3', row: flat(await row.innerText()).slice(0, 300) }; save();
    await consoleShot(c.page, '03e-console-seeded-printer-without-address-view-only.png');
  } finally { await closeConsole(c); }
};

/** Read only, after the interruption at about 16:00 Bangkok: what this run holds on staging now. */
phases.readback = async () => {
  const row = await stationRow();
  const devices = await devicesOnBox();
  const mine = state.created.filter(c => c.kind === 'device').map(c => {
    const d = devices.find(x => x.id === c.id);
    return d ? { role: c.role, label: d.label, address: d.address, archived: d.archived } : { role: c.role, label: c.label, written: false };
  });
  const sales = await stationSales();
  receipt.points.readback = {
    station: { name: row.name, configVersion: row.configVersion, archived: row.archived, devices: rolesOf(row) },
    printers: mine,
    salesAtTheTill: sales.map(s => ({ status: s.status, receipt: s.receiptNumber ?? null, grossBaht: (s.totals?.grossSatang ?? 0) / 100 })),
    ordinaryNumberMember: Boolean(await memberOf(NUMBERS.ordinary)),
  };
  save();
  console.log(JSON.stringify(receipt.points.readback, null, 1));
};

// ---- 4: SCRUM-900, a refund's VOID-slip note ----
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
async function fnbSale(till, known, picture) {
  await till.goto('/'); await landing(till).waitFor();
  await till.getByRole('button', { name: 'F&B', exact: true }).click();
  await till.getByRole('heading', { name: 'Scan Wristband', exact: true }).waitFor();
  await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  await addItem(till, 'French fries');
  await addItem(till, 'Coke');
  const charge = till.getByRole('button', { name: /^Charge ฿/ });
  await expect(charge).toBeEnabled({ timeout: 20000 });
  const total = baht(await charge.textContent());
  await charge.click();
  const pickup = till.getByRole('dialog', { name: 'Pick-up Code', exact: true });
  if (await pickup.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
    const go = pickup.getByRole('button', { name: /^Continue to Payment/ });
    if (!(await go.isEnabled().catch(() => false))) { await pickup.getByRole('button', { name: '9', exact: true }).click(); await pickup.getByRole('button', { name: '8', exact: true }).click(); }
    await go.click();
  }
  await till.getByRole('button', { name: /^Cash / }).click();
  await till.getByLabel('Cash received', { exact: true }).fill(total.toFixed(2));
  const fin = till.waitForResponse(r => isPath(r, 'POST', /^\/api\/sales\/[^/]+\/finalise$/), { timeout: 60000 });
  await till.getByRole('button', { name: 'Record cash', exact: true }).click();
  const finBody = await (await fin).json().catch(() => null);
  await till.getByRole('heading', { name: 'Order Confirmed', exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(1500);
  if (picture) await shot(till, picture);
  let sale;
  await expect.poll(async () => { sale = (await stationSales()).find(s => !known.has(s.id) && s.status === 'finalised'); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  known.add(sale.id);
  state.created.push({ kind: 'sale', key: 'fnb', id: sale.id }); saveState();
  const read = await readSale(sale.id);
  return { saleId: sale.id, receipt: read.sale.receiptNumber, total, finaliseNotes: finBody?.printing?.notes ?? null };
}
/** History > the sale > Refund > By item > the Coke; the toast is read the moment the answer lands. */
async function refundCoke(page, saleId, receiptNumber, note, pictures) {
  await openHistorySale(page, receiptNumber);
  await page.getByTestId('refund-sale').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Refund amount' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'By item', exact: true }).click();
  await dialog.getByRole('button').filter({ hasText: 'Coke' }).filter({ hasText: '฿' }).first().click();
  await dialog.getByRole('button', { name: 'Service recovery', exact: true }).click();
  await dialog.locator('textarea').first().fill(note);
  const go = dialog.getByRole('button', { name: /^Refund ฿/ });
  await expect(go).toBeEnabled();
  const label = flat(await go.innerText());
  if (pictures.dialog) await shot(page, pictures.dialog);
  const sent = page.waitForRequest(r => r.method() === 'POST' && new RegExp(`^/api/sales/${saleId}/refunds$`).test(new URL(r.url()).pathname));
  const answered = page.waitForResponse(r => isPath(r, 'POST', new RegExp(`^/api/sales/${saleId}/refunds$`)));
  await go.click();
  const request = await sent;
  const response = await answered;
  const answeredAt = Date.now();
  const body = await response.json().catch(() => null);
  const toastTitle = page.getByText('Some items not printed', { exact: true });
  const toastSeen = await toastTitle.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  let toastText = null;
  let toastMs = null;
  if (toastSeen) {
    toastMs = Date.now() - answeredAt;
    toastText = flat(await toastTitle.locator('xpath=ancestor::li[1]').innerText({ timeout: 2000 }).catch(() => toastTitle.locator('xpath=../..').innerText()));
    await shot(page, pictures.after);
  } else {
    await page.getByText(/^Refund recorded/).first().waitFor({ timeout: 15000 }).catch(() => {});
    for (const wait of [800, 2000]) { await page.waitForTimeout(wait); if (await toastTitle.isVisible().catch(() => false)) { toastText = 'appeared late'; break; } }
    await shot(page, pictures.after);
  }
  const recorded = flat(await page.getByText(/^Refund recorded/).first().innerText({ timeout: 5000 }).catch(() => ''));
  return { label, status: response.status(), body, toastSeen, toastMsAfterAnswer: toastMs, toastText, recordedCard: recorded,
    sent: { headers: request.headers(), body: request.postData() } };
}
/**
 * Point 4, resumable (the session was interrupted once at about 16:00 Bangkok, before point 4 began): each stage
 * keeps what it learnt in state.p4 and is skipped when already done. One browser context at a time (the laptop is
 * short of memory): the reception till for the two sales, then the manager, then the Console, then the manager.
 */
phases.p4 = async () => {
  state.p4 ??= {}; state.p4.facts ??= {};
  const P = state.p4, facts = P.facts;
  const keep = () => { saveState(); receipt.points['4-so-far'] = facts; save(); };
  const row0 = await stationRow();
  assert.equal(rolesOf(row0).kitchen, state.devices.kitchen.label, 'the kitchen printer is on the till');
  P.seen ??= { kitchen: await seqsOf('kitchen'), bar: await seqsOf('bar') };
  const seen = P.seen;

  if (!P.A || !P.B) {
    assert.equal(rolesOf(row0).bar, state.devices.bar.label, 'the bar printer is on the till for the sales');
    const known = new Set((await stationSales()).map(s => s.id));
    const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
    try {
      step('4: two F&B guest orders, French fries (kitchen) and Coke (bar), cash');
      if (!P.A) { P.A = await fnbSale(t.page, known, '04a-till-fnb-order-paid-cash.png'); keep(); }
      if (!P.B) { P.B = await fnbSale(t.page, known, null); keep(); }
    } finally { await closeTill(t, 'till'); }
    const ticketsA = await jobsPrinted(P.A.saleId, j => /_ticket$/.test(j.kind));
    const ticketsB = await jobsPrinted(P.B.saleId, j => /_ticket$/.test(j.kind));
    const kitchenTickets = await newPrintouts('kitchen', seen.kitchen, { want: 2 });
    const barTickets = await newPrintouts('bar', seen.bar, { want: 2 });
    seen.kitchen.push(...kitchenTickets.map(keyOf)); seen.bar.push(...barTickets.map(keyOf));
    facts.sales = { A: { receipt: P.A.receipt, finaliseNotes: P.A.finaliseNotes, tickets: ticketsA.map(jobFacts) }, B: { receipt: P.B.receipt, finaliseNotes: P.B.finaliseNotes, tickets: ticketsB.map(jobFacts) },
      newPrintouts: { kitchen: kitchenTickets.length, bar: barTickets.length } };
    keep();
  }

  if (!P.ctlRefund) {
    assert.equal(rolesOf(await stationRow()).bar, state.devices.bar.label, 'the bar printer is on the till for the control');
    const mgr = await openTill('STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD', 'manager');
    try {
      step('4: control: a manager refunds sale A\'s Coke with the bar printer in place');
      const ctl = await refundCoke(mgr.page, P.A.saleId, P.A.receipt, `ZZ TEST SCRUM-${T} proof: control, bar printer in place`, { dialog: null, after: '04b-till-refund-with-bar-printer-no-notice.png' });
      assert.equal(ctl.status, 200, 'control refund');
      P.ctlRefund = ctl.body.refund.id;
      facts.control = { status: ctl.status, refund: ctl.body.refund.number, amountSatang: ctl.body.refund.amountSatang, notes: ctl.body.printing?.notes ?? 'field missing', toastSeen: ctl.toastSeen, toastText: ctl.toastText, recordedCard: ctl.recordedCard };
      keep();
    } finally { await closeTill(mgr, 'manager'); }
    const ctlBar = await newPrintouts('bar', seen.bar);
    await sleep(15000);
    const ctlBarAll = await freshOf('bar', seen.bar);
    const ctlKitchen = await freshOf('kitchen', seen.kitchen);
    if (ctlBar[0]) await keepPreview('bar', ctlBar[0], 'p4-bar-void-control.png');
    seen.bar.push(...ctlBarAll.map(keyOf)); seen.kitchen.push(...ctlKitchen.map(keyOf));
    Object.assign(facts.control, { barNew: ctlBarAll.length, kitchenNew: ctlKitchen.length,
      audit: (await auditOf('sale.void_slips', P.A.saleId)).map(e => ({ slips: (e.after?.slips ?? []).map(s => `${s.station} ${s.variant} ${s.status}`), notes: e.after?.notes ?? null })) });
    keep();
  }

  if (rolesOf(await stationRow()).bar) {
    step('4: Console: the till\'s Bar printer set to Not set');
    const c = await openConsole('console');
    try {
      await goStations(c.page);
      const d = await openStationDrawer(c.page); await devicesLoaded(d);
      await barField(d).selectOption('');
      const saved = await saveDrawer(c.page, d);
      assert.equal(saved.status, 200, 'bar printer removed');
      await expect(d).toHaveCount(0);
      const d2 = await openStationDrawer(c.page); await devicesLoaded(d2);
      await barField(d2).scrollIntoViewIfNeeded();
      facts.barRemoved = { status: saved.status, expectedConfigVersionSent: saved.facts.expectedConfigVersionSent, answeredVersion: saved.body.station.configVersion,
        consoleField: (await barField(d2).inputValue()) || 'Not set', readBack: rolesOf(await stationRow()) };
      await consoleShot(c.page, '04c-console-bar-printer-not-set.png');
      await d2.getByRole('button', { name: 'Cancel', exact: true }).click();
      keep();
    } finally { await closeConsole(c); }
  }
  assert.ok(!rolesOf(await stationRow()).bar, 'no bar printer on the till');

  if (!P.bRefund) {
    const mgr = await openTill('STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD', 'manager');
    try {
      step('4: the manager refunds sale B\'s Coke without a bar printer');
      const r = await refundCoke(mgr.page, P.B.saleId, P.B.receipt, `ZZ TEST SCRUM-${T} proof: no bar printer`, { dialog: '04d-till-refund-dialog-coke.png', after: '04e-till-refund-notice-bar-void-not-printed.png' });
      assert.equal(r.status, 200, 'refund without a bar printer');
      P.bRefund = r.body.refund.id;
      facts.withoutBar = { status: r.status, refund: r.body.refund.number, amountSatang: r.body.refund.amountSatang, notes: r.body.printing?.notes ?? 'field missing',
        toastSeen: r.toastSeen, toastMsAfterAnswer: r.toastMsAfterAnswer, toastText: r.toastText, recordedCard: r.recordedCard };
      keep();
      step('4: the refund replayed: its own key, then its action id under a new key');
      const replay = async newKey => {
        const body = JSON.parse(r.sent.body);
        const headers = { 'content-type': 'application/json', 'idempotency-key': newKey ? randomUUID() : r.sent.headers['idempotency-key'], 'x-oto-action-id': r.sent.headers['x-oto-action-id'] };
        const res = await mgr.page.request.fetch(`/api/sales/${P.B.saleId}/refunds`, { method: 'POST', headers, data: body });
        const b = await res.json().catch(() => null);
        return { status: res.status(), replayHeader: res.headers()['x-oto-replay'] ?? null, sameRefund: b?.refund?.id === P.bRefund, notes: b?.printing?.notes ?? 'field missing', errorCode: b?.error?.code ?? null };
      };
      facts.replaySameKey = await replay(false);
      facts.replaySameAction = await replay(true);
      keep();
    } finally { await closeTill(mgr, 'manager'); }
    await sleep(20000);
    const barNew = await freshOf('bar', seen.bar);
    const kitchenNew = await freshOf('kitchen', seen.kitchen);
    const saleRead = await readSale(P.B.saleId);
    Object.assign(facts.withoutBar, { barNew: barNew.length, kitchenNew: kitchenNew.length, saleStatus: saleRead.sale.status,
      refundsOnSale: (saleRead.refunds ?? []).map(x => ({ number: x.number, amountSatang: x.amountSatang })),
      audit: (await auditOf('sale.void_slips', P.B.saleId)).map(e => ({ slips: (e.after?.slips ?? []).map(s => `${s.station} ${s.variant} ${s.status}`), notes: e.after?.notes ?? null })) });
    facts.afterReplays = { barNew: barNew.length, kitchenNew: kitchenNew.length, auditRows: facts.withoutBar.audit.length, refundsOnSale: (saleRead.refunds ?? []).length };
    keep();
  }

  step('4: the bar printer given back to the till (api), for point 5');
  const row = await stationRow();
  if (!rolesOf(row).bar) {
    const devices = row.devices.map(d => ({ role: d.role, deviceId: d.deviceId }));
    const back = await call('PATCH', `/stations/${state.station.id}`, { devices: [...devices, { role: 'bar', deviceId: state.devices.bar.id }] });
    facts.barGivenBack = { status: back.status, roles: rolesOf(back.body?.station) };
    keep();
  }
  const want = `Void slip for the bar not printed — no bar printer at ${state.station.name}`;
  const w = facts.withoutBar;
  const ok = Array.isArray(facts.control.notes) && facts.control.notes.length === 0 && !facts.control.toastSeen && facts.control.barNew === 1 && facts.control.kitchenNew === 0
    && w.status === 200 && JSON.stringify(w.notes) === JSON.stringify([want]) && w.toastSeen && String(w.toastText ?? '').includes(want)
    && w.barNew === 0 && w.kitchenNew === 0 && w.refundsOnSale.length === 1
    && facts.replaySameKey.status === 200 && facts.replaySameKey.sameRefund && JSON.stringify(facts.replaySameKey.notes) === JSON.stringify([want])
    && facts.replaySameAction.status === 200 && facts.replaySameAction.sameRefund && JSON.stringify(facts.replaySameAction.notes) === JSON.stringify([want])
    && facts.afterReplays.refundsOnSale === 1;
  point('4', ok ? 'PASS' : 'FAIL', ['04a-till-fnb-order-paid-cash.png', '04b-till-refund-with-bar-printer-no-notice.png', '04c-console-bar-printer-not-set.png', '04d-till-refund-dialog-coke.png', '04e-till-refund-notice-bar-void-not-printed.png'],
    'Two F&B orders (fries to the kitchen, Coke to the bar, cash), tickets printed. With the bar printer: the Coke refunded, no notice, the bar VOID slip printed. Bar printer set to Not set in the Console: the other order\'s Coke refunded -> "Some items not printed" naming the bar\'s VOID slip; the refund stands; replays (own key; action id under a new key) return the same refund and the same note and print nothing',
    { ...facts, expectedNote: want });
};

/**
 * Point 4's notice picture once more. As run, the first one (kept as 04e-...-first-title-overmasked.png) blacked out
 * "Som" of "Some items not printed": the name masking matched part of a word. Masking is whole words now; this
 * makes a third F&B order (fries + Coke, cash) with the bar printer, takes the bar printer off in the Console, and
 * has the manager refund its Coke, for a clean picture of the same notice.
 */
phases.p4retake = async () => {
  state.p4r ??= {}; const R = state.p4r; R.facts ??= {}; const facts = R.facts;
  const keep = () => { saveState(); receipt.points['4-retake-so-far'] = facts; save(); };
  R.seen ??= { kitchen: await seqsOf('kitchen'), bar: await seqsOf('bar') };
  if (!R.C) {
    assert.equal(rolesOf(await stationRow()).bar, state.devices.bar.label, 'the bar printer is on the till for the sale');
    const known = new Set((await stationSales()).map(s => s.id));
    const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
    try {
      step('4 retake: a third F&B order, French fries and Coke, cash');
      R.C = await fnbSale(t.page, known, null); keep();
    } finally { await closeTill(t, 'till'); }
    facts.saleC = { receipt: R.C.receipt, tickets: (await jobsPrinted(R.C.saleId, j => /_ticket$/.test(j.kind))).map(jobFacts) };
    const k = await newPrintouts('kitchen', R.seen.kitchen); const b = await newPrintouts('bar', R.seen.bar);
    R.seen.kitchen.push(...k.map(keyOf)); R.seen.bar.push(...b.map(keyOf));
    keep();
  }
  if (rolesOf(await stationRow()).bar) {
    step('4 retake: Console, the Bar printer set to Not set');
    const c = await openConsole('console');
    try {
      await goStations(c.page);
      const d = await openStationDrawer(c.page); await devicesLoaded(d);
      await barField(d).selectOption('');
      const saved = await saveDrawer(c.page, d);
      assert.equal(saved.status, 200, 'bar printer removed');
      facts.barRemoved = { status: saved.status, answeredVersion: saved.body.station.configVersion };
      keep();
    } finally { await closeConsole(c); }
  }
  assert.ok(!rolesOf(await stationRow()).bar, 'no bar printer on the till');
  if (!R.refund) {
    const mgr = await openTill('STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD', 'manager');
    try {
      step('4 retake: the manager refunds the third order\'s Coke');
      const r = await refundCoke(mgr.page, R.C.saleId, R.C.receipt, `ZZ TEST SCRUM-${T} proof: notice picture again`, { dialog: null, after: '04e-till-refund-notice-bar-void-not-printed.png' });
      assert.equal(r.status, 200, 'refund');
      R.refund = r.body.refund.id;
      facts.refund = { status: r.status, refund: r.body.refund.number, notes: r.body.printing?.notes ?? 'field missing', toastSeen: r.toastSeen, toastMsAfterAnswer: r.toastMsAfterAnswer, toastText: r.toastText, recordedCard: r.recordedCard };
      keep();
    } finally { await closeTill(mgr, 'manager'); }
    await sleep(15000);
    facts.refund.barNew = (await freshOf('bar', R.seen.bar)).length;
    facts.refund.kitchenNew = (await freshOf('kitchen', R.seen.kitchen)).length;
    facts.refund.refundsOnSale = ((await readSale(R.C.saleId)).refunds ?? []).length;
    keep();
  }
  step('4 retake: the bar printer given back (api)');
  const row = await stationRow();
  if (!rolesOf(row).bar) {
    const back = await call('PATCH', `/stations/${state.station.id}`, { devices: [...row.devices.map(d => ({ role: d.role, deviceId: d.deviceId })), { role: 'bar', deviceId: state.devices.bar.id }] });
    facts.barGivenBack = { status: back.status, roles: Object.keys(rolesOf(back.body?.station)) };
    keep();
  }
  const want = `Void slip for the bar not printed — no bar printer at ${state.station.name}`;
  const ok = facts.refund.status === 200 && JSON.stringify(facts.refund.notes) === JSON.stringify([want]) && facts.refund.toastSeen && String(facts.refund.toastText).startsWith('Some items not printed')
    && String(facts.refund.toastText).includes(want) && facts.refund.barNew === 0 && facts.refund.kitchenNew === 0 && facts.refund.refundsOnSale === 1;
  point('4-retake', ok ? 'PASS' : 'FAIL', ['04e-till-refund-notice-bar-void-not-printed.png'],
    'The same notice again on a third order, for a picture whose title is not masked: "Some items not printed" with the bar\'s VOID-slip line; nothing printed',
    { ...facts, expectedNote: want });
};

// ---- 5: nothing else moved ----
phases.p5 = async () => {
  const facts = {};
  const known = new Set((await stationSales()).map(s => s.id));
  const seen = { kids_band: await seqsOf('kids_band'), adult_band: await seqsOf('adult_band'), receipt: await seqsOf('receipt'), dropoff_band: await seqsOf('dropoff_band') };
  const t = await openTill('STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', 'till');
  try {
    step('5: the till\'s header: the printer light');
    await t.page.goto('/'); await landing(t.page).waitFor(); await t.page.waitForTimeout(6000);
    const light = t.page.locator('[role="status"][aria-label^="Printers:"]');
    facts.lightBefore = { shown: await light.count() > 0, label: (await light.count()) ? await light.first().getAttribute('aria-label') : null };
    const printers = (await call('GET', `/stations/${state.station.id}/printers`)).body?.printers ?? [];
    facts.stationPrinters = printers.map(p => ({ label: p.label, reachability: p.reachability ?? null, paperStatus: p.paperStatus ?? null, lastError: p.lastError ?? null, queued: p.queued ?? null }));
    await shot(t.page, '05a-till-header-printer-light-clear.png');
    step('5: an ordinary ticket sale, one child and one adult, cash');
    await walkIn(t.page, NUMBERS.ordinary);
    await ticket(t.page, 1, 1);
    const sale = await saleWritten(known);
    state.created.push({ kind: 'sale', key: 'ordinary', id: sale.id }); saveState();
    const fin = await payCash(t.page);
    await t.page.waitForTimeout(2000);
    await shot(t.page, '05b-till-ordinary-sale-paid-cash.png');
    const printed = await jobsPrinted(sale.id, () => true);
    const kidsNew = await newPrintouts('kids_band', seen.kids_band);
    const adultNew = await newPrintouts('adult_band', seen.adult_band);
    const receiptJobs = printed.filter(j => j.kind === 'receipt');
    const receiptNew = receiptJobs.length ? await newPrintouts('receipt', seen.receipt) : await freshOf('receipt', seen.receipt);
    const dropNew = await freshOf('dropoff_band', seen.dropoff_band);
    facts.sale = { receipt: (await readSale(sale.id)).sale.receiptNumber, finaliseNotes: fin?.printing?.notes ?? null, jobs: printed.map(jobFacts), newPrintouts: { kids: kidsNew.length, adult: adultNew.length, receipt: receiptNew.length, dropoff: dropNew.length } };
    await t.page.goto('/'); await landing(t.page).waitFor(); await t.page.waitForTimeout(6000);
    facts.lightAfter = { shown: await light.count() > 0, label: (await light.count()) ? await light.first().getAttribute('aria-label') : null };
  } finally { await closeTill(t); }
  const roles = facts.sale.jobs.map(j => `${j.kind}:${j.role}:${j.device}`).sort();
  const ok = !facts.lightBefore.shown && !facts.lightAfter.shown && facts.stationPrinters.every(p => !p.lastError && p.reachability !== 'unreachable')
    && facts.sale.jobs.every(j => j.status === 'printed') && roles.includes(`kids_wristband:kids_band:${state.devices.kids_band.label}`) && roles.includes(`adult_wristband:adult_band:${state.devices.adult_band.label}`)
    && facts.sale.newPrintouts.kids === 1 && facts.sale.newPrintouts.adult === 1 && facts.sale.newPrintouts.dropoff === 0
    && facts.sale.jobs.filter(j => j.kind === 'receipt').every(j => j.role === 'receipt');
  point('5', ok ? 'PASS' : 'FAIL', ['05a-till-header-printer-light-clear.png', '05b-till-ordinary-sale-paid-cash.png'],
    'An ordinary ticket sale (1 child + 1 adult, cash) on the ZZ TEST till prints as before; the header shows no printer fault (the light is clear) with every printer addressed',
    facts);
};

/** Read only: point 5 counted two new printouts on the receipt printer for one receipt job; when was each drawn? */
phases.p5receipt = async () => {
  const list = (await printouts('receipt')).printouts.map(p => ({ seq: p.seq, at: p.at, widthDots: p.widthDots ?? null, heightDots: p.heightDots ?? null, jobId: p.jobId ?? p.printJobId ?? null }));
  const sales = await stationSales();
  const jobs = [];
  for (const s of sales) for (const j of ((await readSale(s.id)).printJobs ?? []).filter(j => j.role === 'receipt')) jobs.push({ receipt: s.receiptNumber ?? null, kind: j.kind, status: j.status, queuedAt: j.queuedAt ?? null, printedAt: j.printedAt ?? null, id: j.id });
  receipt.points['5-receipt'] = { printouts: list, receiptJobs: jobs };
  save();
  console.log(JSON.stringify(receipt.points['5-receipt'], null, 1));
};

// ---- clean-up: only what this run made, each read back ----
phases.cleanup = async () => {
  const done = [];
  const clean = async (what, fn) => {
    try { const r = await fn(); done.push({ what, ...(r ?? {}) }); }
    catch (e) { done.push({ what, failed: firstLine(e) }); receipt.cleanupFailed = true; }
    receipt.points.cleanup = done; save();
  };
  const own = await stationRow();
  assert.ok(own?.name?.startsWith(`ZZ TEST SCRUM-${T} `), 'the ZZ TEST till of this run');
  await clean('the till\'s sales', async () => {
    const sales = await stationSales();
    for (const s of sales) assert.equal(s.stationId, state.station.id);
    for (const s of sales.filter(x => ['open', 'tendering'].includes(x.status))) {
      assert.equal((await call('POST', `/sales/${s.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
    }
    const after = await stationSales();
    assert.ok(after.every(s => !['open', 'tendering'].includes(s.status)), 'nothing left open');
    return { sales: after.map(s => `${s.status} ${(s.totals?.grossSatang ?? 0) / 100}`) };
  });
  for (const [key, phone] of Object.entries(NUMBERS)) await clean(`number ${key}`, async () => {
    const m = await memberOf(phone);
    if (!m) return { member: 'none' };
    assert.ok(`${m.nickname ?? ''} ${m.name ?? ''}`.includes(`ZZ TEST SCRUM-${T}`), 'only this run\'s own named test members');
    assert.equal((await call('DELETE', `/members/${m.id}`)).status, 200);
    return { member: 'archived', stillFound: Boolean(await memberOf(phone)) };
  });
  await clean('the ZZ TEST till', async () => {
    if (!own.archived) {
      assert.equal((await call('PATCH', `/stations/${state.station.id}`, { devices: [] })).status, 200);
      assert.equal((await call('DELETE', `/stations/${state.station.id}`)).status, 200);
    }
    const row = await stationRow();
    assert.ok(row.archived); assert.equal(row.devices.length, 0);
    return { name: row.name, archived: true, devices: 0 };
  });
  await clean('the ZZ TEST printers', async () => {
    const devices = await devicesOnBox();
    const mine = state.created.filter(c => c.kind === 'device');
    const outList = [];
    for (const d of mine) {
      const row = devices.find(x => x.id === d.id);
      if (!row) { outList.push(`${d.role}: never written`); continue; }
      assert.ok(row.label.startsWith(`ZZ TEST SCRUM-${T} `), 'only this run\'s printers');
      if (!row.archived) {
        const r = await call('DELETE', `/devices/${d.id}`);
        assert.equal(r.status, 200);
        assert.equal((r.body.stillAssignedTo ?? []).length, 0);
      }
      outList.push(d.role);
    }
    const after = (await devicesOnBox()).filter(x => mine.some(d => d.id === x.id));
    assert.ok(after.every(x => x.archived));
    return { archived: outList, readBackArchived: after.length };
  });
};

// ---- dispatch ----
try {
  assert.ok(phases[PHASE], `unknown phase ${PHASE}`);
  if (PHASE !== 'setup') assert.ok(state.station, 'run setup first');
  await adminSignIn();
  await phases[PHASE]();
  receipt.passed = Object.values(receipt.points).every(p => !p.verdict || p.verdict === 'PASS');
} catch (error) {
  receipt.passed = false;
  receipt.failure = { step: receipt.step, error: firstLine(error), at: String(error?.stack ?? '').split(/\r?\n/).filter(l => /proof\.mjs:\d+/.test(l)).map(l => l.trim().replace(/^at /, '').replace(/\(?file:.*proof\.mjs:/, 'proof.mjs:').replace(/\)$/, '')) };
  console.log('FAILED', receipt.step, '|', firstLine(error), '|', receipt.failure.at.join(' < '));
  receipt.failure.lastScreens = lastScreens;
  process.exitCode = 1;
} finally {
  try { if ((await admin.get('/api/me')).status() === 200) await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } }); receipt.notes.push({ adminSignedOut: (await admin.get('/api/me')).status() }); } catch { /* read back in cleanup */ }
  await browser?.close().catch(() => {});
  await admin.dispose();
  receipt.finishedAt = new Date().toISOString(); save();
}
