// SCRUM-971 staging proof (13 November 2026; the printers leftovers lane, main 1b9885a32, and point 5 of SCRUM-969).
// Copied from the SCRUM-952 driver (docs/qa/proof-2026-11-13/SCRUM-952/driver.mjs: admin api, Console box drawer,
// Controls, Printing panel, the browser-side request capture) with the drop-off pieces of the SCRUM-959 driver
// (docs/qa/proof-2026-11-13/SCRUM-959/driver.mjs: the fake camera, the drop-off form, the release, the masks of other
// families). ONE browser (Edge, headless), contexts opened and closed per step; the steps are sent to a local port
// (127.0.0.1 only) as small async bodies that get the state object S; every step and its answer are appended to
// steps.log beside the receipt.
//
//   NODE_OPTIONS=--max-old-space-size=2048 node driver.mjs [port]
//   then  POST http://127.0.0.1:<port>/run  with the step's body;  POST /quit  ends it (browser closed, admin signed out).
//
// Own ZZ TEST till, display station and ZZ TEST simulated printers on Virtual box 1 (Central Floresta), made through the
// API so their settings stay null; invented numbers (08989710xx, checked unused first); cash only. Robinson Chalong's
// Virtual box 3 is only READ. Credentials are read by NAME through scripts/agent/env.mjs need() and never printed; staff
// names never enter the receipt or the log (scrubbed), and on the pictures the account corner, the password field,
// staff names and other families are masked with solid boxes. Text answers are drawn as pictures in the same browser
// (S.txtShot, the look of scratchpad/txt2png.mjs) so only one browser ever runs.
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
const port = Number(process.argv[2] ?? 47971);
const out = resolve(import.meta.dirname);
const scratch = process.env.ZZ_SCRATCH ?? 'C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/p971';
mkdirSync(resolve(scratch, 'raw'), { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, scratch, need, writeFileSync, readFileSync, existsSync };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.CONSOLE = 'https://oto-console-staging.onrender.com';
for (const u of [S.pos, S.CONSOLE]) assert.ok(/-staging\.onrender\.com$/.test(new URL(u).host), 'staging only');
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989710' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(out, 'deploys-start.json');
S.receipt = { tickets: ['SCRUM-971', 'SCRUM-969 (point 5)'], sha: '1b9885a321ff7799ba122caa2a0adff30aa99807',
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  numbers: {}, created: [], points: {}, reads: {}, readings: [], odd: [], pageErrors: [], requests: [], cleanup: {} };
process.on('unhandledRejection', e => { try { S.receipt.odd.push({ what: 'unhandled rejection in a step (logged, driver kept)', text: String(e?.message ?? e).split('\n')[0].slice(0, 200) }); } catch {} });

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
const SKIP = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Admin|Owner|Khun|Staff|Central|Floresta|Branch|Oto|Party|Virtual|box|Receipt|Printer|Band)$/i;
S.scrub = text => {
  let t = String(text);
  for (const n of [...S.names].filter(s => s.length >= 3 && !SKIP.test(s)).sort((a, b) => b.length - a.length)) t = t.split(n).join('[staff]');
  return t;
};
S.save = () => writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
S.point = (key, pass, pictures, seen) => { S.receipt.points[key] = { verdict: pass ? 'PASSED' : 'FAILED', pictures, seen }; S.save(); return { key, pass }; };
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
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2) { S.names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.replace(/[()]/g, '').length >= 3) S.names.add(p.replace(/[()]/g, '')); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
S.walkNames = walkNames;
walkNames((await S.call('GET', '/me')).body);
S.branchId = (await S.call('GET', '/branches')).body.branches.find(b => /Central Floresta/.test(b.name)).id;
S.stationRow = async id => (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === (id ?? S.station.id));
S.rolesOf = row => Object.fromEntries((row?.devices ?? []).map(d => [d.role, d.label]));
S.devicesOnBox = async boxId => (await S.call('GET', `/boxes/${boxId ?? S.box.id}/devices?includeArchived=true`)).body.devices;
S.printoutsFull = async deviceId => { const r = await S.call('GET', `/devices/${deviceId}/printouts?limit=20`); return { status: r.status, printouts: r.body?.printouts ?? [], events: r.body?.events ?? [], code: r.body?.error?.code ?? null }; };
S.preview = async (deviceId, seq, file) => { const p = await S.admin.get(`/api/devices/${deviceId}/printouts/${seq}/preview.png`); if (p.status() === 200) writeFileSync(file, await p.body()); return p.status(); };
S.commands = async (boxId, limit = 30) => (await S.call('GET', `/boxes/${boxId ?? S.box.id}/commands?limit=${limit}`)).body?.commands ?? [];
S.jobs = async (boxId, limit = 30) => (await S.call('GET', `/boxes/${boxId ?? S.box.id}/print-jobs?limit=${limit}`)).body?.jobs ?? [];
S.keyOf = p => `${p.seq}@${p.at}`;
S.sale = async id => (await S.call('GET', `/sales/${id}`)).body;
S.registration = async id => (await S.call('GET', '/checkin/registrations/' + id)).body;
S.devName = id => Object.values(S.dev ?? {}).find(d => d.id === id)?.label ?? (id ? 'not a ZZ TEST printer' : null);
S.jobFacts = j => ({ kind: j.kind, role: j.role, device: S.devName(j.deviceId) ?? j.deviceLabel ?? null, status: j.status, error: j.errorCode ?? null });
S.boxNow = async () => (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(x => x.id === S.box.id);
/** Waits for `n` new reports (heartbeats) of Virtual box 1 after now. */
S.waitReports = async (n = 2, timeout = 300000) => {
  const t = Date.now(); let beats = 0, last = null; const seen = [];
  await expect.poll(async () => { const b = await S.boxNow(); const at = Date.parse(b.lastHeartbeatAt ?? 0); if (at > t + 500 && at !== last) { beats += 1; last = at; seen.push(b.lastHeartbeatAt); } return beats; }, { timeout, intervals: [4000] }).toBeGreaterThanOrEqual(n);
  return seen;
};
/** One device's reading as the platform gives it: reachability / paper / last error. */
S.readingOf = d => d ? { reachability: d.reachability, paperStatus: d.paperStatus, lastError: d.lastError ?? null, address: d.address ?? null, notSetUp: d.lastError === 'DEVICE_NO_ADDRESS' } : null;
/** The platform's reading of the ZZ printers now, from the box's device list and from /ops/health; kept in the receipt. */
S.apiReadings = async moment => {
  const devs = await S.devicesOnBox();
  const h = (await S.call('GET', '/ops/health')).body;
  const hb = (h?.boxes ?? []).find(b => b.id === S.box.id);
  const rec = { moment, at: new Date().toISOString(), deviceList: {}, opsHealth: {} };
  for (const [key, d] of Object.entries(S.dev)) {
    rec.deviceList[key] = S.readingOf(devs.find(x => x.id === d.id));
    const hd = (hb?.devices ?? []).find(x => x.id === d.id || x.label === d.label);
    rec.opsHealth[key] = hd ? { reachability: hd.reachability, paperStatus: hd.paperStatus, lastError: hd.lastError ?? null } : 'not listed';
  }
  S.receipt.readings.push(rec); S.save();
  return rec;
};

// ---- the browser: one, headless, with a fake camera for the drop-off form's photos ----
const video = resolve(scratch, 'camera.y4m');
const W = 320, H = 240;
writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(W * H, 150), Buffer.alloc(W * H / 2, 128)]));
S.browser = await chromium.launch({ channel: 'msedge', args: ['--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
S.pages = {};
const kindOf = new WeakMap();
/** A platform answer drawn as a picture, in a context of the same browser (scratchpad/txt2png.mjs's look). */
S.txtShot = async (text, name, title = '') => {
  const body = S.scrub(String(text)).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  writeFileSync(resolve(out, name.replace(/\.png$/, '.txt')), S.scrub(String(text)) + '\n');
  const ctx = await S.browser.newContext({ viewport: { width: 1180, height: 400 } });
  try {
    const p = await ctx.newPage();
    await p.setContent(`<body style="margin:0;background:#0f1320;color:#dfe6f3;font:13px/1.45 Consolas,monospace"><div style="padding:14px 18px;background:#1a2033;color:#9fb0d0;font:600 13px system-ui">${S.scrub(title).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div><pre style="margin:0;padding:16px 18px;white-space:pre-wrap">${body}</pre></body>`);
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
S.landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
S.signIn = async (label, phoneKey, passwordKey, viewport = { width: 1680, height: 1100 }, stationName = S.station.name, stationId = S.station.id) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); kindOf.set(page, 'till'); await page.goto(S.pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  S.pages[label] = { ctx, page, passwordKey, base: S.pos };
  const pick = page.getByRole('button', { name: stationName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } } else if (await page.locator('a[href="/history"]').first().isVisible()) break; await page.waitForTimeout(500); }
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
  const meOf = async () => (await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json())));
  let me = await meOf();
  walkNames(me);
  if (me?.operatorContext?.stationId !== stationId) {
    await page.goto('/station-setup');
    await page.getByRole('heading', { name: 'Which station are you on?' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: stationName, exact: false }).first().click();
    await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
    await expect.poll(async () => (await meOf())?.operatorContext?.stationId, { timeout: 20000 }).toBe(stationId);
    me = await meOf();
  }
  assert.equal(me?.operatorContext?.stationId, stationId, 'signed in at the own ZZ TEST till');
  return page;
};
S.consoleIn = async (label) => {
  const ctx = await S.browser.newContext({ baseURL: S.CONSOLE, viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); kindOf.set(page, 'console');
  await page.goto(S.CONSOLE);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  S.pages[label] = { ctx, page, base: S.CONSOLE };
  await page.waitForURL(/\/overview$/);
  walkNames(await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json())).catch(() => null));
  return page;
};
/** Signs a page's session out (only that session), reads /api/me back, closes its context. */
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
  const btn = t.page.getByRole('button', { name: 'Unlock', exact: true });
  if ((await t.page.getByRole('heading', { name: 'Locked', exact: true }).isVisible().catch(() => false)) || (await btn.isVisible().catch(() => false))) {
    await t.page.locator('input[type="password"]').first().fill(need(t.passwordKey));
    await t.page.getByRole('button', { name: /Unlock/ }).first().click(); await t.page.waitForTimeout(3000);
    return true;
  }
  return false;
};

// ---- masks: drawn in place and removed after the picture (SCRUM-959's way) ----
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
S.esc = esc;
S.hidden = []; // names and numbers of families that are not ZZ TEST: memory only
S.familyAllZz = f => S.isZz(f.guardianName) && f.children.every(c => S.isZz(c.childName)) && (f.checkedInChildNames ?? []).every(S.isZz);
S.boardApi = async () => {
  const board = (await S.call('GET', `/checkin/board?branchId=${S.branchId}`)).body;
  const keep = new Set();
  for (const f of board?.families ?? []) {
    for (const n of [f.guardianName, ...f.children.map(c => c.childName), ...(f.checkedInChildNames ?? [])]) if (n && !S.isZz(n) && n.trim().length >= 2) keep.add(n.trim());
    if (!S.familyAllZz(f) && f.guardianPhone) { const p = f.guardianPhone; keep.add(p); keep.add(p.replace(/^\+66/, '0')); }
  }
  for (const n of board?.nannies ?? []) if (n.name && !S.isZz(n.name)) keep.add(n.name.trim());
  // a word that is part of our own ZZ TEST text (a family on staging is named "test") is not masked (SCRUM-959's rule)
  const zzText = ['zz test', 'ZZ TEST 971 receipt printer', 'ZZ TEST 971 band printer', 'ZZ TEST 971 till', 'ZZ TEST SCRUM', ...(board?.families ?? []).filter(S.familyAllZz).flatMap(f => [f.guardianName, ...f.children.map(c => c.childName)])].join(' | ').toLowerCase();
  const inZz = s => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u').test(zzText);
  S.hidden = [...new Set([...S.hidden, ...keep])].filter(s => s.length >= 2 && !inZz(s)).sort((a, b) => b.length - a.length);
  return board;
};
S.markMine = (page, list) => page.evaluate((list) => {
  for (const b of document.querySelectorAll('div.space-y-2 > button.w-full.text-left')) { const t = b.innerText.replace(/\s+/g, ' '); if (list.some(r => t.includes(r))) b.setAttribute('data-zz', 'mine'); else b.removeAttribute('data-zz'); }
}, list);
S.needles = () => [...S.hidden, ...[...S.names].filter(s => s.length >= 3 && !SKIP.test(s))].filter(Boolean);
S.inPlace = page => kindOf.get(page) === 'till'
  ? [page.getByLabel('Lock screen').locator('..'), page.locator('div.space-y-2 > div.rounded-xl.p-3').filter({ hasNotText: 'ZZ TEST' }),
    page.locator('div.space-y-2 > button.w-full.text-left:not([data-zz]):not([role="dialog"] *)')]
  : [page.getByRole('button', { name: 'Sign out', exact: true }).locator('..')];
S.masks = page => [page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'), page.locator('canvas'), page.getByText(/^QR-[A-Z0-9]+$/)];
S.shots = [];
S.shot = async (page, name, extra = [], opts = {}) => {
  for (const loc of S.inPlace(page)) await loc.evaluateAll(els => { for (const e of els) e.setAttribute('data-zz-mask', '1'); }).catch(() => {});
  const sources = S.needles().map(s => '(?<![\\p{L}\\p{N}])' + esc(s) + '(?![\\p{L}\\p{N}])');
  await page.evaluate((list) => {
    if (!document.getElementById('zz-mask-style')) { const st = document.createElement('style'); st.id = 'zz-mask-style'; st.textContent = '[data-zz-mask]{background:#18181b!important;color:#18181b!important;border-color:#18181b!important;border-radius:2px} [data-zz-mask] *{color:#18181b!important;background:#18181b!important;border-color:#18181b!important} [data-zz-mask] img,[data-zz-mask] video,[data-zz-mask] picture,[data-zz-mask] canvas{opacity:0!important}'; document.head.appendChild(st); }
    const res = list.map(s => new RegExp(s, 'iu'));
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const v = w.currentNode.nodeValue || ''; if (v.trim() && res.some(r => r.test(v))) w.currentNode.parentElement?.setAttribute('data-zz-mask', '1'); }
    for (const el of document.querySelectorAll('input,textarea')) { if (res.some(r => r.test(el.value || ''))) el.setAttribute('data-zz-mask', '1'); }
  }, sources).catch(() => {});
  try {
    await page.screenshot({ path: resolve(out, name), animations: 'disabled', ...opts, mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
  } finally {
    await page.evaluate(() => { for (const el of document.querySelectorAll('[data-zz-mask]')) el.removeAttribute('data-zz-mask'); }).catch(() => {});
  }
  S.shots.push(name);
  return name;
};
/** A local PNG shown in a context of the same browser with boxes drawn over it ([x,y,w,h] in image pixels). */
S.boxed = async (src, dst, boxes = []) => {
  const ctx = await S.browser.newContext({ viewport: { width: 700, height: 1200 } });
  try {
    const page = await ctx.newPage();
    const b64 = readFileSync(src).toString('base64');
    const o = await page.evaluate(async ({ src, boxes }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0); g.fillStyle = '#18181b';
      for (const [x, y, w, h] of boxes) g.fillRect(x, y, w, h);
      return { w: c.width, h: c.height, data: c.toDataURL('image/png').split(',')[1] };
    }, { src: b64, boxes });
    writeFileSync(dst, Buffer.from(o.data, 'base64'));
    return { w: o.w, h: o.h };
  } finally { await ctx.close(); }
};
/** The ink rows of a printout preview: dark-pixel runs per pixel row, inside an x range. */
S.inkBands = async (src, x0, x1, minGap = 1) => {
  const ctx = await S.browser.newContext({ viewport: { width: 700, height: 700 } });
  try {
    const page = await ctx.newPage();
    const b64 = readFileSync(src).toString('base64');
    return await page.evaluate(async ({ src, x0, x1, minGap }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const ink = [];
      for (let y = 0; y < c.height; y++) { let n = 0; for (let x = Math.max(0, x0); x < Math.min(c.width, x1); x++) { const i = (y * c.width + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 384 && d[i + 3] > 0) n++; } ink.push(n); }
      const bands = []; let start = -1, gap = 0;
      for (let y = 0; y < ink.length; y++) {
        if (ink[y] > 0) { if (start < 0) start = y; gap = 0; }
        else if (start >= 0) { gap++; if (gap >= minGap) { bands.push([start, y - gap]); start = -1; gap = 0; } }
      }
      if (start >= 0) bands.push([start, ink.length - 1]);
      return { w: c.width, h: c.height, bands };
    }, { src: b64, x0, x1, minGap });
  } finally { await ctx.close(); }
};

// ---- till steps (from SCRUM-959) ----
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
S.quantity = async (page, label, target) => {
  const add = page.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
  const remove = page.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 10; i++) { const c = Number(await value.textContent()); if (c === target) return; await (c < target ? add : remove).click(); await page.waitForTimeout(250); }
  assert.equal(Number(await value.textContent()), target);
};
S.ticket = async (page, kids, adults, pkg = '1 Hour Play') => {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByRole('heading', { name: pkg, exact: true }).first().click();
  await S.quantity(page, 'Kids', kids); await S.quantity(page, 'Adults', adults);
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
S.fillDropOff = async (page, children, guardian, ages = []) => {
  await page.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const first = page.getByPlaceholder('Full name', { exact: true }).first();
  await first.waitFor();
  const half = S.halfOf(first);
  const fields = half.getByPlaceholder('Full name', { exact: true });
  assert.equal(await fields.count(), children.length, 'one name field per child');
  for (let i = 0; i < children.length; i++) await fields.nth(i).fill(children[i]);
  for (let i = children.length - 1; i >= 0; i--) await S.setAge(page, half, ages[i] ?? 6);
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
S.stationSales = async (stationId = S.station.id) => (await S.call('GET', `/sales?branchId=${S.branchId}&stationId=${stationId}&limit=50`)).body.sales;
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
    const file = await S.call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-971 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await S.call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await S.call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push({ child: child.childName, status: r.status, code: r.body?.error?.code ?? null });
  }
  return done;
};

// ---- the Console (from SCRUM-952) ----
S.goStations = async (page, filter = 'ZZ TEST 971') => {
  await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Branch').selectOption(S.branchId);
  await page.getByRole('button', { name: 'Stations', exact: true }).click();
  await page.getByPlaceholder('Name, identifier or type').fill(filter);
  await page.waitForTimeout(800);
};
S.drawerOf = page => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^(Save the station|Create the station)$/ }) });
S.goBox = async (page, branchId, boxName) => {
  await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Branch').selectOption(branchId);
  await page.getByRole('button', { name: 'Boxes', exact: true }).click();
  await page.getByRole('button', { name: boxName, exact: true }).click();
  const d = page.getByRole('dialog', { name: boxName, exact: true });
  await expect(d).toBeVisible();
  return d;
};
S.deviceRow = (page, box, label) => box.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) }).first();
S.editing = (page, box) => box.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Archive it', exact: true }) });
/** Records every request the page sends whose method and path match, while `fn` runs and `settle` ms after. */
S.capture = async (page, method, pathRe, fn, settle = 2500) => {
  const seen = [];
  const on = req => { const u = new URL(req.url()); if (req.method() === method && pathRe.test(u.pathname)) seen.push({ method: req.method(), path: u.pathname.replace(S.ID, ':id'), body: req.postData() ?? null }); };
  page.on('request', on);
  try { await fn(); await page.waitForTimeout(settle); } finally { page.off('request', on); }
  return seen;
};

// ---- setup: the numbers, the ZZ TEST 971 printers, the own till ----
S.defs = {
  receipt: { kind: 'receipt_printer', label: 'ZZ TEST 971 receipt printer', address: '192.0.2.71:9100', protocol: 'escpos' },
  band: { kind: 'band_printer', label: 'ZZ TEST 971 band printer', address: '192.0.2.72:9100', protocol: 'tspl2' },
};
S.setup = async () => {
  const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && !b.archived);
  assert.ok(box, 'Virtual box 1');
  S.box = { id: box.id, name: box.name, status: box.status };
  const board = await S.boardApi();
  const boardPhones = new Set((board?.families ?? []).map(f => (f.guardianPhone ?? '').replace(/^\+66/, '0')));
  const unused = [];
  for (let i = 10; i < 25; i++) {
    const n = S.zz(i);
    const m = (await S.call('GET', `/members/lookup?phone=${n}`)).body?.member ?? null;
    if (!m && !boardPhones.has(n)) unused.push(n);
  }
  S.free = unused;
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  S.prefixFree = Array.from({ length: 99 }, (_, i) => `Z971${String(i + 1).padStart(2, '0')}`).filter(p => !stations.some(s => s.codePrefix === p));
  const prefix = S.prefixFree.shift();
  const onBox = await S.devicesOnBox(box.id);
  S.dev = {};
  for (const [key, d] of Object.entries(S.defs)) {
    assert.ok(!onBox.some(x => !x.archived && (x.label === d.label || x.address === d.address)), `no live device named ${d.label} or at ${d.address}`);
    const id = randomUUID();
    const r = await S.call('POST', `/boxes/${box.id}/devices`, { id, kind: d.kind, label: d.label, transport: 'simulated', protocol: d.protocol, address: d.address });
    assert.equal(r.status, 200, `device ${key}`);
    S.dev[key] = { id: r.body.device.id, label: d.label, kind: d.kind, address: d.address };
    S.receipt.created.push({ kind: 'device', key, id: r.body.device.id, label: d.label }); S.save();
  }
  const name = 'ZZ TEST 971 till';
  assert.ok(!stations.some(s => s.name === name && !s.archived), 'no live station of that name');
  const devices = [['receipt', 'receipt'], ['kids_band', 'band'], ['adult_band', 'band'], ['dropoff_band', 'band']].map(([role, key]) => ({ role, deviceId: S.dev[key].id }));
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200, 'station');
  S.station = { id: made.body.station.id, name, prefix };
  S.receipt.created.push({ kind: 'station', id: S.station.id, name, prefix }); S.save();
  const rows = (await S.devicesOnBox(box.id)).filter(x => Object.values(S.dev).some(d => d.id === x.id));
  S.receipt.reads.setup = { box: box.name, boxStatus: box.status, prefix, numbersFree: unused.length, configVersion: made.body.station.configVersion, roles: S.rolesOf(made.body.station),
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
    appendFileSync(log, `\n=== ${at} ${S.phase ?? ''}\n${S.scrub(body.trim())}\n--> ${text.slice(0, 5000)}\n`);
    S.save();
    res.setHeader('content-type', 'application/json');
    res.end(text);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`driver ready on 127.0.0.1:${port}`));
