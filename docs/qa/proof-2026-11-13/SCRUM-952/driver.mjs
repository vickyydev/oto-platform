// SCRUM-952 staging proof (13 November 2026; the printers follow-up, main 8c3a6efd7).
// Copied from the SCRUM-930 driver (docs/qa/proof-2026-11-12/SCRUM-930/driver.mjs) and adapted: ONE browser (Edge,
// headless), contexts opened and closed per step; the steps are sent to a local port (127.0.0.1 only) as small async
// bodies that get the state object S; every step and its answer are appended to steps.log beside the receipt.
//
//   NODE_OPTIONS=--max-old-space-size=2048 node driver.mjs [port]
//   then  POST http://127.0.0.1:<port>/run  with the step's body;  POST /quit  ends it (browser closed, admin signed out).
//
// Own ZZ TEST till and ZZ TEST simulated printers on Virtual box 1 (Central Floresta), invented numbers (08989520xx,
// checked unused first), cash or the staging payment simulator only. Robinson Chalong's Virtual box 3 is only READ.
// Credentials are read by NAME through scripts/agent/env.mjs need() and never printed; staff names never enter the
// receipt or the log (scrubbed), and on the pictures the account corner, the password field, staff names and other
// families are masked with solid boxes. Text answers are drawn as pictures in the same browser (S.txtShot).
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
const port = Number(process.argv[2] ?? 47952);
const out = resolve(import.meta.dirname);
const scratch = process.env.ZZ_SCRATCH ?? 'C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/p952';
mkdirSync(resolve(scratch, 'raw'), { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, scratch, need: undefined, writeFileSync, readFileSync };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.CONSOLE = 'https://oto-console-staging.onrender.com';
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989520' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(out, 'deploys-start.json');
S.receipt = { tickets: ['SCRUM-952'], sha: '8c3a6efd77c875a84066cd5c0a0b8554334878c1',
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
/** The whole answer of the printouts read: the printouts and the simulator's events, as the Console reads them. */
S.printoutsFull = async deviceId => { const r = await S.call('GET', `/devices/${deviceId}/printouts?limit=20`); return { status: r.status, printouts: r.body?.printouts ?? [], events: r.body?.events ?? [], code: r.body?.error?.code ?? null }; };
S.preview = async (deviceId, seq, file) => { const p = await S.admin.get(`/api/devices/${deviceId}/printouts/${seq}/preview.png`); if (p.status() === 200) writeFileSync(file, await p.body()); return p.status(); };
S.commands = async (boxId, limit = 30) => (await S.call('GET', `/boxes/${boxId ?? S.box.id}/commands?limit=${limit}`)).body?.commands ?? [];
S.jobs = async (boxId, limit = 30) => (await S.call('GET', `/boxes/${boxId ?? S.box.id}/print-jobs?limit=${limit}`)).body?.jobs ?? [];
S.keyOf = p => `${p.seq}@${p.at}`;
S.sale = async id => (await S.call('GET', `/sales/${id}`)).body;
S.registration = async id => (await S.call('GET', '/checkin/registrations/' + id)).body;
S.jobFacts = j => ({ kind: j.kind, role: j.role, device: S.devName(j.deviceId) ?? j.deviceLabel ?? null, status: j.status, error: j.errorCode ?? null });
S.devName = id => Object.values(S.dev ?? {}).find(d => d.id === id)?.label ?? (id ? 'not a ZZ TEST printer' : null);

// ---- the browser: one, headless ----
S.browser = await chromium.launch({ channel: 'msedge', args: ['--disable-gpu'] });
S.pages = {};
/** A platform answer drawn as a picture, in a context of the same browser (scratchpad/txt2png.mjs's look). */
S.txtShot = async (text, name, title = '') => {
  const body = S.scrub(String(text)).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  writeFileSync(resolve(out, name.replace(/\.png$/, '.txt')), S.scrub(String(text)) + '\n');
  const ctx = await S.browser.newContext({ viewport: { width: 1180, height: 400 } });
  try {
    const p = await ctx.newPage();
    await p.setContent(`<body style="margin:0;background:#0f1320;color:#dfe6f3;font:13px/1.45 Consolas,monospace"><div style="padding:14px 18px;background:#1a2033;color:#9fb0d0;font:600 13px system-ui">${title.replace(/</g, '&lt;')}</div><pre style="margin:0;padding:16px 18px;white-space:pre-wrap">${body}</pre></body>`);
    const h = await p.evaluate(() => document.documentElement.scrollHeight);
    await p.setViewportSize({ width: 1180, height: Math.min(h, 6000) });
    await p.screenshot({ path: resolve(out, name) });
  } finally { await ctx.close(); }
  return name;
};
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
// ---- the Console (from SCRUM-898 / SCRUM-930) ----
S.goStations = async (page, name = S.station.name) => {
  await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Branch').selectOption(S.branchId);
  await page.getByRole('button', { name: 'Stations', exact: true }).click();
  await page.getByPlaceholder('Name, identifier or type').fill('ZZ TEST 952');
  await page.getByRole('button', { name, exact: true }).waitFor();
};
S.drawerOf = page => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save the station', exact: true }) });
S.openDrawer = async (page, name = S.station.name, waitPrinters = true) => {
  await page.getByRole('button', { name, exact: true }).click();
  const d = S.drawerOf(page);
  await expect(d).toBeVisible();
  if (waitPrinters) await expect.poll(async () => d.getByLabel(/^Drop-off band printer/).locator('option').count(), { timeout: 20000 }).toBeGreaterThan(1);
  else await expect.poll(async () => S.versionShown(d), { timeout: 20000 }).toBeGreaterThan(0);
  return d;
};
S.field = (drawer, re) => drawer.getByLabel(re);
S.versionShown = async drawer => Number((S.flat(await drawer.innerText()).match(/config v(\d+)/) ?? [])[1] ?? NaN);
S.saveDrawer = async (page, drawer, stationId = S.station.id) => {
  const waiting = page.waitForResponse(r => r.request().method() === 'PATCH' && new RegExp(`^/api/stations/${stationId}$`).test(new URL(r.url()).pathname));
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

// ---- setup: the numbers, the ZZ TEST 952 printers (reused when still live), the own till ----
// The brief's two printers, plus a third receipt printer with NO model (point 1, the Model row reads the kind). The
// band printer also takes the kids and adult band roles so a ticket sale's bands print rather than being skipped.
S.defs = {
  receipt: { kind: 'receipt_printer', label: 'ZZ TEST 952 receipt printer', address: '192.0.2.52:9100', model: 'Xprinter XP-80', protocol: 'escpos' },
  band: { kind: 'band_printer', label: 'ZZ TEST 952 band printer', address: '192.0.2.53:9100', protocol: 'tspl2' },
  nomodel: { kind: 'receipt_printer', label: 'ZZ TEST 952 no-model receipt printer', address: '192.0.2.54:9100', protocol: 'escpos' },
};
S.setup = async () => {
  const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && !b.archived);
  assert.ok(box, 'Virtual box 1');
  S.box = { id: box.id, name: box.name, status: box.status };
  const unused = [];
  for (let i = 10; i < 20; i++) {
    const n = S.zz(i);
    const m = (await S.call('GET', `/members/lookup?phone=${n}`)).body?.member ?? null;
    if (!m) unused.push(n);
  }
  S.free = unused;
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z952${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const onBox = await S.devicesOnBox(box.id);
  S.dev = {};
  const reused = [];
  for (const [key, d] of Object.entries(S.defs)) {
    const live = onBox.find(x => !x.archived && x.label === d.label);
    if (live) { S.dev[key] = { id: live.id, label: d.label, kind: d.kind, address: live.address }; reused.push(d.label); continue; }
    assert.ok(!onBox.some(x => !x.archived && x.address === d.address), `no live device at ${d.address} on the box`);
    const id = randomUUID();
    const r = await S.call('POST', `/boxes/${box.id}/devices`, { id, kind: d.kind, label: d.label, transport: 'simulated', ...(d.model ? { model: d.model } : {}), protocol: d.protocol, address: d.address });
    assert.equal(r.status, 200, `device ${key}`);
    S.dev[key] = { id: r.body.device.id, label: d.label, kind: d.kind, address: d.address };
    S.receipt.created.push({ kind: 'device', key, id: r.body.device.id, label: d.label }); S.save();
  }
  const name = 'ZZ TEST 952 till';
  assert.ok(!stations.some(s => s.name === name && !s.archived), 'no live station of that name');
  const devices = [['receipt', 'receipt'], ['dropoff_band', 'band'], ['kids_band', 'band'], ['adult_band', 'band'], ['bar', 'nomodel']].map(([role, key]) => ({ role, deviceId: S.dev[key].id }));
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200, 'station');
  S.station = { id: made.body.station.id, name, prefix };
  S.receipt.created.push({ kind: 'station', id: S.station.id, name, prefix }); S.save();
  const rows = (await S.devicesOnBox(box.id)).filter(x => Object.values(S.dev).some(d => d.id === x.id));
  S.receipt.reads.setup = { box: box.name, boxStatus: box.status, prefix, numbersFree: unused.length, reused, configVersion: made.body.station.configVersion, roles: S.rolesOf(made.body.station), capabilities: made.body.station.capabilities,
    printers: rows.map(x => ({ label: x.label, kind: x.kind, transport: x.transport, address: x.address, model: x.model ?? null, protocol: x.protocol, settings: x.settings ?? null, reachability: x.reachability, paperStatus: x.paperStatus, lastError: x.lastError ?? null })) };
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
