// SCRUM-930 / SCRUM-931 / SCRUM-932 staging proof (12 November 2026; the printers lane, main d880f8f30).
// An interactive driver, as the SCRUM-909 run was driven (its driver.mjs beside this folder), with the Console helpers
// of the SCRUM-898 harness (its proof.mjs): ONE browser (Edge, headless, a fake camera for the drop-off form's photos),
// contexts opened and closed per step; the steps are sent to a local port (127.0.0.1 only) as small async bodies that get
// the state object S; every step and its answer are appended to steps.log beside the receipt.
//
//   NODE_OPTIONS=--max-old-space-size=2048 node driver.mjs [port]
//   then  POST http://127.0.0.1:<port>/run  with the step's body;  POST /quit  ends it (browser closed, admin signed out).
//
// Own ZZ TEST till and four ZZ TEST simulated printers on Virtual box 1 (Central Floresta), invented numbers (08989300xx,
// checked unused first), cash only. Robinson Chalong's Virtual box 3 is only READ (point 11). Credentials are read by NAME
// through scripts/agent/env.mjs need() and never printed; staff names never enter the receipt or the log (scrubbed), and on
// the pictures the account corner, the password field, staff names and other families are masked with solid boxes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const pw = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const { chromium, request, expect } = pw;
const port = Number(process.argv[2] ?? 47930);
const out = resolve(import.meta.dirname);
const scratch = process.env.ZZ_SCRATCH ?? 'C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/s930';
mkdirSync(resolve(scratch, 'raw'), { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, scratch, need: undefined, writeFileSync, readFileSync };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.CONSOLE = 'https://oto-console-staging.onrender.com';
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989300' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(out, 'deploys.json');
S.receipt = { tickets: ['SCRUM-930', 'SCRUM-931', 'SCRUM-932'], sha: 'd880f8f30ecc7999280d4f2f04bc94bf658a09c6',
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  numbers: {}, created: [], points: {}, reads: {}, odd: [], pageErrors: [], requests: [], cleanup: {} };

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
const SKIP = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Admin|Owner|Khun|Staff)$/i;
S.scrub = text => {
  let t = String(text);
  for (const n of [...S.names].filter(s => s.length >= 3 && !SKIP.test(s)).sort((a, b) => b.length - a.length)) t = t.split(n).join('[staff]');
  return t;
};
S.save = () => writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
S.point = (key, pass, pictures, seen) => { S.receipt.points[key] = { verdict: pass ? 'PASS' : 'FAIL', pictures, seen }; S.save(); return { key, pass }; };
S.odd = (what, extra = {}) => { S.receipt.odd.push({ what, ...extra }); S.save(); };

// ---- the admin api (setup, reads, clean-up) ----
S.admin = await request.newContext({ baseURL: S.pos });
const adminSignIn = async () => assert.equal((await S.admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
S.call = async (method, path, data, headers = {}) => {
  const once = () => S.admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let r = await once();
  if (r.status() === 401) { await adminSignIn(); r = await once(); }
  const body = await r.json().catch(() => null);
  S.receipt.requests.push({ method, path: path.split('?')[0].replace(S.ID, ':id'), status: r.status(), ...(r.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: r.status(), body };
};
await adminSignIn();
S.branchId = (await S.call('GET', '/branches')).body.branches.find(b => /Central Floresta/.test(b.name)).id;
S.stationRow = async () => (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === S.station.id);
S.rolesOf = row => Object.fromEntries((row?.devices ?? []).map(d => [d.role, d.label]));
S.devicesOnBox = async boxId => (await S.call('GET', `/boxes/${boxId ?? S.box.id}/devices?includeArchived=true`)).body.devices;
S.printouts = async role => { const r = await S.call('GET', `/devices/${S.dev[role].id}/printouts?limit=20`); return r.status === 200 ? r.body.printouts : []; };
S.keyOf = p => `${p.seq}@${p.at}`;
S.sale = async id => (await S.call('GET', `/sales/${id}`)).body;
S.registration = async id => (await S.call('GET', '/checkin/registrations/' + id)).body;
S.jobFacts = j => ({ kind: j.kind, role: j.role, device: S.devName(j.deviceId) ?? j.deviceLabel ?? null, status: j.status, error: j.errorCode ?? null });
S.devName = id => Object.values(S.dev ?? {}).find(d => d.id === id)?.label ?? (id ? 'not a ZZ TEST printer' : null);

// ---- the browser: one, headless, fake camera ----
const video = resolve(scratch, 'camera.y4m');
const W = 320, H = 240;
writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(W * H, 150), Buffer.alloc(W * H / 2, 128)]));
S.browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
S.pages = {};
S.watch = (page, label) => {
  page.on('pageerror', e => S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); });
};
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2) { S.names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.replace(/[()]/g, '').length >= 3) S.names.add(p.replace(/[()]/g, '')); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
S.landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
S.signIn = async (label, phoneKey, passwordKey, viewport = { width: 1680, height: 1100 }) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); await page.goto(S.pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: S.station.name, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } } else if (await page.locator('a[href="/history"]').first().isVisible()) break; await page.waitForTimeout(500); }
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
  const stationOf = async () => (await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json())));
  let me = await stationOf();
  walkNames(me);
  if (me?.operatorContext?.stationId !== S.station.id) {
    await page.goto('/station-setup');
    await page.getByRole('heading', { name: 'Which station are you on?' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: S.station.name, exact: false }).first().click();
    await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
    await expect.poll(async () => (await stationOf())?.operatorContext?.stationId, { timeout: 20000 }).toBe(S.station.id);
    me = await stationOf();
  }
  assert.equal(me?.operatorContext?.stationId, S.station.id, 'signed in at the own ZZ TEST till');
  S.pages[label] = { ctx, page, passwordKey, base: S.pos };
  return page;
};
S.consoleIn = async (label) => {
  const ctx = await S.browser.newContext({ baseURL: S.CONSOLE, viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label);
  await page.goto(S.CONSOLE);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/overview$/);
  walkNames(await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json())).catch(() => null));
  S.pages[label] = { ctx, page, base: S.CONSOLE };
  return page;
};
/** Signs a page's session out, reads /api/me back, closes its context. */
S.close = async label => {
  const t = S.pages[label]; if (!t) return null;
  let r = {};
  try {
    const before = (await t.ctx.request.get(t.base + '/api/me')).status();
    if (before === 200) r.signOut = (await t.ctx.request.post(t.base + '/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status();
    r.me = (await t.ctx.request.get(t.base + '/api/me')).status();
  } catch (e) { r.error = String(e.message).slice(0, 200); }
  await t.ctx.close().catch(() => {});
  delete S.pages[label];
  (S.receipt.sessions ??= []).push({ label, ...r, at: new Date().toISOString() }); S.save();
  return r;
};
S.unlock = async label => {
  const t = S.pages[label];
  if (await t.page.getByRole('heading', { name: 'Locked', exact: true }).isVisible().catch(() => false)) {
    await t.page.locator('input[type="password"]').first().fill(need(t.passwordKey));
    await t.page.getByRole('button', { name: /Unlock/ }).click(); await t.page.waitForTimeout(3000);
    return true;
  }
  return false;
};

// ---- masks: staff names and other families blacked out as solid boxes ----
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
S.hidden = [];
S.redact = async page => page.evaluate((needles) => {
  const list = needles.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!list.length) return;
  const word = s => new RegExp('(?<![\\p{L}\\p{N}])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu');
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const hits = [];
  while (w.nextNode()) { const v = w.currentNode.nodeValue || ''; if (list.some(s => word(s).test(v))) hits.push(w.currentNode); }
  const bar = m => `<span style="background:#18181b;color:#18181b">${'█'.repeat(m.length)}</span>`;
  for (const t of hits) {
    let h = (t.nodeValue || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    for (const s of list) h = h.replace(word(s), bar);
    const sp = document.createElement('span'); sp.innerHTML = h; t.parentNode.replaceChild(sp, t);
  }
}, [...S.names].filter(s => s.length >= 3 && !SKIP.test(s)).concat(S.hidden)).catch(() => {});
S.masks = page => [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
  page.getByTestId('display-pairing-code'), page.locator('canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
  page.getByRole('button', { name: 'Sign out', exact: true }).locator('..')];
S.shot = async (page, name, extra = [], opts = {}) => {
  await S.redact(page);
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', ...opts, mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
  return name;
};

// ---- till steps (from SCRUM-909) ----
S.halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
S.keypad = async (scope, digits) => { for (const d of digits) await scope.getByRole('button', { name: d, exact: true }).last().click(); };
S.spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
S.walkIn = async (page, number) => {
  await page.goto('/');
  await S.landing(page).waitFor();
  if (await page.getByTestId('language-choice').isVisible()) await page.getByTestId('language-choice-en').click();
  await page.getByTestId('identify-safety').waitFor();
  const scope = S.halfOf(page.getByTestId('identify-safety'));
  await S.keypad(scope, number);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = page.getByRole('dialog', { name: 'New member?', exact: true });
  await expect(offer).toContainText(S.spaced(number));
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  return scope;
};
S.ticket = async (page, kids, adults, pkg = '1 Hour Play') => {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByRole('heading', { name: pkg, exact: true }).first().click();
  const quantity = async (label, target) => {
    const add = page.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
    const remove = page.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
    const value = add.locator('xpath=preceding-sibling::span[1]');
    for (let i = 0; i < 8; i++) { const c = Number(await value.textContent()); if (c === target) return; await (c < target ? add : remove).click(); await page.waitForTimeout(200); }
    assert.equal(Number(await value.textContent()), target);
  };
  await quantity('Kids', kids); await quantity('Adults', adults);
  await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
};
S.setAge = async (page, scope, age) => {
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
};
S.fillDropOff = async (page, children, guardian) => {
  await page.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const first = page.getByPlaceholder('Full name', { exact: true }).first();
  await first.waitFor();
  const half = S.halfOf(first);
  const fields = half.getByPlaceholder('Full name', { exact: true });
  assert.equal(await fields.count(), children.length, 'one name field per child');
  for (let i = 0; i < children.length; i++) await fields.nth(i).fill(children[i]);
  for (let i = 0; i < children.length; i++) await S.setAge(page, half, 6);
  await half.getByPlaceholder('Your full name', { exact: true }).fill(guardian);
  for (let i = 0; i < children.length; i++) {
    await half.getByRole('button', { name: 'Start camera', exact: true }).first().click();
    await half.getByRole('button', { name: 'Take photo', exact: true }).first().click();
    await expect(half.getByAltText('Captured', { exact: true })).toHaveCount(i + 1);
  }
  for (const box of await half.getByRole('checkbox').all()) if (await box.isEnabled()) await box.check();
  const [registered] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  const reg = await registered.json().catch(() => null);
  assert.equal(registered.status(), 200, 'the registration is written');
  S.receipt.created.push({ kind: 'registration', guardian, id: reg.id, stays: reg.children.map(c => ({ id: c.id, name: c.childName })) }); S.save();
  return reg;
};
S.stationSales = async () => (await S.call('GET', `/sales?branchId=${S.branchId}&stationId=${S.station.id}&limit=50`)).body.sales;
S.knownSales = new Set();
S.saleWritten = async kind => {
  let sale;
  await expect.poll(async () => { sale = (await S.stationSales()).find(x => !S.knownSales.has(x.id) && ['tendering', 'open'].includes(x.status)); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  S.knownSales.add(sale.id);
  S.receipt.created.push({ kind, id: sale.id }); S.save();
  return sale;
};
S.paymentStep = page => page.getByTestId('payment-step');
S.payCash = async page => {
  await expect(S.paymentStep(page)).toBeVisible({ timeout: 30000 });
  await page.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = page.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click();
  await page.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
};
S.releaseOwn = async (regId, guardian) => {
  const reg = await S.registration(regId);
  assert.equal(reg.guardianName, guardian, 'only this run\'s own booking');
  const done = [];
  for (const child of reg.children.filter(c => c.status === 'in_park')) {
    assert.ok(S.isZz(child.childName));
    const file = await S.call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-930 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await S.call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await S.call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push({ child: child.childName, status: r.status });
  }
  return done;
};

// ---- the Console (from SCRUM-898) ----
S.goStations = async page => {
  await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Branch').selectOption(S.branchId);
  await page.getByRole('button', { name: 'Stations', exact: true }).click();
  await page.getByPlaceholder('Name, identifier or type').fill('ZZ TEST 930');
  await page.getByRole('button', { name: S.station.name, exact: true }).waitFor();
};
S.drawerOf = page => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save the station', exact: true }) });
S.openDrawer = async page => {
  await page.getByRole('button', { name: S.station.name, exact: true }).click();
  const d = S.drawerOf(page);
  await expect(d).toBeVisible();
  await expect.poll(async () => d.getByLabel(/^Drop-off band printer/).locator('option').count(), { timeout: 20000 }).toBeGreaterThan(1);
  return d;
};
S.field = (drawer, re) => drawer.getByLabel(re);
S.versionShown = async drawer => Number((S.flat(await drawer.innerText()).match(/config v(\d+)/) ?? [])[1] ?? NaN);
S.saveDrawer = async (page, drawer) => {
  const waiting = page.waitForResponse(r => r.request().method() === 'PATCH' && new RegExp(`^/api/stations/${S.station.id}$`).test(new URL(r.url()).pathname));
  await drawer.getByRole('button', { name: 'Save the station', exact: true }).click();
  const res = await waiting;
  const body = await res.json().catch(() => null);
  const sent = JSON.parse(res.request().postData() ?? '{}');
  return { status: res.status(), body, sent };
};
S.goBox = async (page, branchId, boxName) => {
  await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Branch').selectOption(branchId);
  await page.getByRole('button', { name: 'Boxes', exact: true }).click();
  await page.getByRole('button', { name: boxName, exact: true }).click();
  const d = page.getByRole('dialog', { name: boxName, exact: true });
  await expect(d).toBeVisible();
  return d;
};

// ---- setup: the numbers, the four printers, the own till ----
S.setup = async () => {
  const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'Virtual box 1 online');
  S.box = { id: box.id, name: box.name };
  const unused = [];
  for (let i = 10; i < 20; i++) {
    const n = S.zz(i);
    const m = (await S.call('GET', `/members/lookup?phone=${n}`)).body?.member ?? null;
    if (!m) unused.push(n);
  }
  S.free = unused;
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z930${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const defs = {
    receipt: { kind: 'receipt_printer', label: 'ZZ TEST 930 receipt printer', address: '192.0.2.50:9100', model: 'Xprinter XP-80', protocol: 'escpos' },
    kids_band: { kind: 'band_printer', label: 'ZZ TEST 930 kids band printer', address: '192.0.2.51:9100', model: '4B-2082A', protocol: 'tspl2' },
    adult_band: { kind: 'band_printer', label: 'ZZ TEST 930 adult band printer', address: '192.0.2.53:9100', model: '4B-2082A', protocol: 'tspl2' },
    dropoff_band: { kind: 'band_printer', label: 'ZZ TEST 930 drop-off band printer', address: '192.0.2.52:9100', model: '4B-2082A', protocol: 'tspl2' },
  };
  const onBox = await S.devicesOnBox(box.id);
  for (const d of Object.values(defs)) assert.ok(!onBox.some(x => !x.archived && x.label === d.label), `no live ${d.label} yet`);
  S.dev = {};
  for (const [role, d] of Object.entries(defs)) {
    const id = randomUUID();
    const r = await S.call('POST', `/boxes/${box.id}/devices`, { id, kind: d.kind, label: d.label, transport: 'simulated', model: d.model, protocol: d.protocol, address: d.address });
    assert.equal(r.status, 200, `device ${role}`);
    S.dev[role] = { id: r.body.device.id, label: d.label, kind: d.kind, address: d.address };
    S.receipt.created.push({ kind: 'device', role, id: r.body.device.id, label: d.label }); S.save();
  }
  const name = 'ZZ TEST 930 till';
  assert.ok(!stations.some(s => s.name === name && !s.archived), 'no live station of that name');
  const devices = ['receipt', 'kids_band', 'adult_band'].map(role => ({ role, deviceId: S.dev[role].id }));
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200, 'station');
  S.station = { id: made.body.station.id, name, prefix };
  S.receipt.created.push({ kind: 'station', id: S.station.id, name, prefix }); S.save();
  S.receipt.reads.setup = { box: box.name, prefix, numbersFree: unused.length, configVersion: made.body.station.configVersion, devices: S.rolesOf(made.body.station), capabilities: made.body.station.capabilities };
  return S.receipt.reads.setup;
};

// ---- the step server ----
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const log = resolve(out, 'steps.log');
let busy = false;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    if (req.url === '/quit') {
      for (const label of Object.keys(S.pages)) await S.close(label).catch(() => {});
      await S.browser?.close().catch(() => {});
      try { if ((await S.admin.get('/api/me')).status() === 200) await S.admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } }); S.receipt.cleanup.adminMe = (await S.admin.get('/api/me')).status(); } catch { /* read back below */ }
      S.receipt.finishedAt = new Date().toISOString(); S.save();
      await S.admin.dispose().catch(() => {});
      res.end('bye'); server.close(); process.exit(0);
    }
    if (busy) { res.statusCode = 409; res.end('busy'); return; }
    busy = true;
    const at = new Date().toISOString();
    let answer;
    try {
      const value = await new AsyncFunction('S', body)(S);
      answer = { ok: true, value };
    } catch (error) {
      answer = { ok: false, error: `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ').slice(0, 900)}` };
    }
    busy = false;
    const text = S.scrub(JSON.stringify(answer, null, 1));
    appendFileSync(log, `\n=== ${at} ${S.phase ?? ''}\n${S.scrub(body.trim())}\n--> ${text.slice(0, 4000)}\n`);
    S.save();
    res.setHeader('content-type', 'application/json');
    res.end(text);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`driver ready on 127.0.0.1:${port}`));
