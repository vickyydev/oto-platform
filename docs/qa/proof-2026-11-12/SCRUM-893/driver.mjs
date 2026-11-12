// SCRUM-893 family form lane (SCRUM-893, 894, 914, 915, 942 lock-screen part, 943) staging proof, 12 November 2026;
// api, pos and pos-web at 03fc3f75f (deploys.json). An interactive driver, as the SCRUM-857 parts 2-4 run was driven
// (docs/qa/proof-2026-11-12/SCRUM-857/parts2-4/driver.mjs, which this starts from): one headless browser (Edge, with a
// file-fed fake camera of generated colour bars, no person's picture), several contexts in it (the desk till, the
// paired display as the counter display is — 600 x 1024, touch, `?keyboard=screen` — a display with no camera, a
// display whose camera is refused, the phone till at 390 x 844), one step at a time. Steps are sent to a local port
// (127.0.0.1 only) as small async bodies that get the state object S; every step and its answer are appended to
// steps.log beside the receipt, so the run reads back in the order it was driven.
//
//   CAMERA_Y4M=<generated bars.y4m> node driver.mjs [port]   then  POST http://127.0.0.1:<port>/run  with the step's
//   body;  POST /quit  ends it.
//
// Own ZZ TEST tills on the shared virtual box (virtual-1), ZZ TEST families with invented numbers (08989302xx, checked
// unused first). Cash only; every cash sale refunded whole by the staging manager signed in at the own till. Names typed
// with the on-screen keys come out as "Zz Test …" (the keys capitalise each word's first letter and have no digits);
// the ZZ TEST check is case-blind. Credentials are read by NAME through scripts/agent/env.mjs need() and never printed;
// staff names never enter the receipt or the log (scrubbed), and on the pictures the account corner, the password
// field, the pairing code, staff names and other families are masked.
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
const port = Number(process.argv[2] ?? 47893);
const out = resolve(process.env.OUT_DIR ?? import.meta.dirname);
mkdirSync(out, { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, need: undefined };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.sha = '03fc3f75f56d6500197ac61f498122c9dfa43eda';
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989302' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
S.receipt = { tickets: ['SCRUM-893', 'SCRUM-894', 'SCRUM-914', 'SCRUM-915', 'SCRUM-942 (lock-screen part)', 'SCRUM-943'], sha: S.sha,
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  numbers: {}, created: [], points: {}, reads: {}, odd: [], defects: [], hunt: [], pageErrors: [], requests: [], registrationsPosted: [], photoFiles: [], displayPhotoUploads: [], cleanup: {} };

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
const NOT_NAMES = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Staging|Admin|Park)$/i;
S.scrub = text => {
  let t = String(text);
  for (const n of [...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s)).sort((a, b) => b.length - a.length)) t = t.split(n).join('[staff]');
  return t;
};
S.save = () => writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
S.point = (key, pass, pictures, seen) => { S.receipt.points[key] = { pass, pictures, seen }; S.save(); return { key, pass }; };
S.odd = (what, extra = {}) => { S.receipt.odd.push({ what, ...extra }); S.save(); };

// ---- the admin api (stations, displays, reads, clean-up) ----
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

// ---- the browser: one, with a file-fed fake camera (generated colour bars) ----
S.cameraFile = process.env.CAMERA_Y4M ?? null;
S.browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(S.cameraFile ? [`--use-file-for-fake-video-capture=${S.cameraFile}`] : [])] });
S.pages = {};
S.watch = (page, label) => {
  page.on('pageerror', e => S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); });
};
/** What a till writes: every registration POST (status, replay, id) and every registration photo file. */
S.watchTill = (page, label) => {
  page.on('response', async r => {
    const u = new URL(r.url());
    if (r.request().method() !== 'POST') return;
    if (u.pathname === '/api/checkin/registrations') {
      const entry = { till: label, at: S.phase ?? null, status: r.status(), replay: r.headers()['x-oto-replay'] === 'true', id: null, finishedAt: new Date().toISOString() };
      S.receipt.registrationsPosted.push(entry);
      entry.id = (await r.json().catch(() => null))?.id ?? null;
      S.save();
    }
  });
  page.on('request', q => {
    const u = new URL(q.url());
    if (q.method() !== 'POST' || u.pathname !== '/api/files') return;
    let body = null; try { body = q.postDataJSON(); } catch { /* not json */ }
    if (body?.ownerEntityType === 'registration') { S.receipt.photoFiles.push({ till: label, at: S.phase ?? null, ownerEntityId: body.ownerEntityId, contentType: body.contentType }); S.save(); }
  });
};
S.watchDisplay = (page, label) => {
  page.on('response', r => {
    const u = new URL(r.url());
    if (u.pathname === '/api/display/consent-photos' && r.request().method() === 'POST') { S.receipt.displayPhotoUploads.push({ display: label, at: S.phase ?? null, status: r.status() }); S.save(); }
  });
};
S.landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2) { S.names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.length >= 3) S.names.add(p); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
/** Sign a till in at one of this run's own stations (`station`: { id, name }). */
S.signIn = async (label, phoneKey, passwordKey, viewport, { station = S.station, query = '', ...extra } = {}) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'],
    ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), ...extra });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); S.watchTill(page, label); await page.goto(S.pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: station.name, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } } else if (await page.locator('a[href="/history"]').first().isVisible()) break; await page.waitForTimeout(500); }
  await page.waitForTimeout(2000);
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  walkNames(me);
  assert.ok(JSON.stringify(me).includes(station.id), 'signed in at the own ZZ TEST till');
  if (query) { await page.goto('/' + query); await page.waitForTimeout(2000); }
  S.pages[label] = { ctx, page, passwordKey, phoneKey };
  return page;
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
S.signOutPage = async label => {
  const t = S.pages[label];
  if (!t) return null;
  const before = (await t.page.request.get('/api/me')).status();
  if (before === 200) await t.page.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  const after = (await t.page.request.get('/api/me')).status();
  await t.ctx.close().catch(() => {});
  delete S.pages[label];
  (S.receipt.cleanup.sessions ??= []).push({ label, before, after }); S.save();
  return { label, before, after };
};

// ---- displays: each in its own context, paired to the own till through the admin api ----
S.displays = {};
const NO_CAMERA = () => {
  const md = navigator.mediaDevices;
  if (!md) return;
  Object.defineProperty(md, 'enumerateDevices', { configurable: true, value: async () => [] });
  Object.defineProperty(md, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Requested device not found', 'NotFoundError'); } });
};
const REFUSED = () => {
  const md = navigator.mediaDevices;
  if (!md) return;
  Object.defineProperty(md, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } });
};
/**
 * The counter display as it stands: 600 x 1024, a touch screen with no keyboard, `?keyboard=screen`.
 * camera: 'fake' (permission granted), 'refused' (getUserMedia answers NotAllowedError), 'none' (no video device).
 */
S.pairDisplay = async (label, { camera = 'fake', viewport = { width: 600, height: 1024 }, query = '?keyboard=screen', station = S.station } = {}) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, hasTouch: true, timezoneId: 'Asia/Bangkok', locale: 'en-GB', ...(camera === 'fake' ? { permissions: ['camera'] } : {}) });
  ctx.setDefaultTimeout(30000);
  if (camera === 'none') await ctx.addInitScript(NO_CAMERA);
  if (camera === 'refused') await ctx.addInitScript(REFUSED);
  const page = await ctx.newPage(); S.watch(page, `display-${label}`); S.watchDisplay(page, label);
  await page.goto(`${S.pos}/display${query}`);
  await page.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
  assert.match(pairingCode, /^\d{6}$/);
  const paired = await S.call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: `${station.name} display ${label}` });
  assert.equal(paired.status, 200);
  S.displays[label] = { ctx, page, id: paired.body.device.id, revoked: false, camera };
  S.receipt.created.push({ kind: 'display', label, id: paired.body.device.id, camera, station: station.id }); S.save();
  await S.landing(page).waitFor({ timeout: 60000 });
  return page;
};
S.dropDisplay = async (label, reason = 'ZZ TEST SCRUM-893 proof step complete') => {
  const d = S.displays[label];
  if (!d) return null;
  if (!d.revoked) {
    const r = await S.call('POST', `/credentials/${d.id}/revoke`, { reason });
    assert.equal(r.status, 200);
    d.revoked = true;
    (S.receipt.cleanup.displays ??= []).push({ label, id: d.id, revoked: true }); S.save();
  }
  await d.ctx.close().catch(() => {});
  delete S.displays[label];
  return { label, revoked: true };
};

// ---- masks ----
S.hidden = [];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
S.familyAllZz = f => S.isZz(f.guardianName) && f.children.every(c => S.isZz(c.childName)) && (f.checkedInChildNames ?? []).every(S.isZz);
S.boardApi = async () => {
  const board = (await S.call('GET', `/checkin/board?branchId=${S.branchId}`)).body;
  const keep = new Set();
  for (const f of board.families) {
    for (const n of [f.guardianName, ...f.children.map(c => c.childName), ...(f.checkedInChildNames ?? [])]) if (n && !S.isZz(n) && n.trim().length >= 2) keep.add(n.trim());
    if (!S.familyAllZz(f) && f.guardianPhone) { const p = f.guardianPhone; keep.add(p); keep.add(p.replace(/^\+66/, '0')); }
  }
  for (const n of board.nannies ?? []) if (n.name && !S.isZz(n.name)) keep.add(n.name.trim());
  const zzText = ['zz test', S.station?.name ?? '', ...board.families.filter(S.familyAllZz).flatMap(f => [f.guardianName, ...f.children.map(c => c.childName)])].join(' | ').toLowerCase();
  const inZz = s => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u').test(zzText);
  S.hidden = [...keep].filter(s => s.length >= 2 && !inZz(s)).sort((a, b) => b.length - a.length);
  return board;
};
S.deskCards = page => page.locator('div.grid.gap-3 > div[class*="bg-card/50"]');
S.masks = page => {
  const staff = [...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s));
  const all = [...S.hidden, ...staff].filter(Boolean);
  const re = all.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${all.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  return [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
    page.getByTestId('display-pairing-code'), page.getByText(/^QR-[A-Z0-9]+$/), page.locator('svg:not(.lucide)'),
    S.deskCards(page).filter({ hasNotText: /ZZ TEST/i }),
    page.getByText(/^(Nannies free now|Free nannies):/),
    ...(re ? [S.deskCards(page).filter({ hasText: re }), page.getByText(re)] : [])];
};
S.shots = [];
S.shot = async (page, name, extra = [], opts = {}) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', ...opts, mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
  S.shots.push(name);
  return name;
};
/** Two pages side by side in one picture, taken at the same moment, each at the same scale: the till left, the display right. */
S.pair = async (name, left, right, extra = {}) => {
  const [a, b] = await Promise.all([
    left.screenshot({ animations: 'disabled', mask: [...S.masks(left), ...(extra.left ?? [])], maskColor: '#18181b' }),
    right.screenshot({ animations: 'disabled', mask: [...S.masks(right), ...(extra.right ?? [])], maskColor: '#18181b' }),
  ]);
  const lv = left.viewportSize(), rv = right.viewportSize();
  const page = await S.browser.newPage({ viewport: { width: 2200, height: 1000 } });
  const img = buf => `data:image/png;base64,${buf.toString('base64')}`;
  await page.setContent(`<html><body style="margin:0;background:#111;color:#eee;font-family:Segoe UI,Arial">
    <div style="padding:6px 10px;font-size:18px">${(extra.caption ?? '').replace(/[<>&]/g, '')} — taken ${new Date().toISOString()}</div>
    <div style="display:flex;gap:8px;align-items:flex-start;padding:0 8px 8px">
      <figure style="margin:0;flex:${lv.width}"><figcaption style="font-size:15px;padding:2px 0">${(extra.leftLabel ?? `Till (${lv.width}×${lv.height})`).replace(/[<>&]/g, '')}</figcaption><img style="width:100%;border:1px solid #444" src="${img(a)}"></figure>
      <figure style="margin:0;flex:${rv.width}"><figcaption style="font-size:15px;padding:2px 0">${(extra.rightLabel ?? `Customer display (${rv.width}×${rv.height}, touch, ?keyboard=screen)`).replace(/[<>&]/g, '')}</figcaption><img style="width:100%;border:1px solid #444" src="${img(b)}"></figure>
    </div></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  S.shots.push(name);
  return name;
};
/** A picture of read-back facts: a plain table, rendered in its own page. */
S.facts = async (name, title, rows) => {
  const page = await S.browser.newPage({ viewport: { width: 1200, height: 300 } });
  const e = s => String(s ?? 'null').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:16px;background:#fff;color:#111"><h3 style="margin:0 0 8px">${e(title)}</h3>
    <p style="margin:0 0 10px;color:#555;font-size:13px">Read ${e(new Date().toISOString())} from ${e(S.pos)} (staging, at 03fc3f75f), the staging admin's own session. ZZ TEST values only.</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td><b>${e(k)}</b></td><td style="font-family:Consolas,monospace">${e(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('')}</table></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  S.shots.push(name);
  return name;
};

// ---- the on-screen keys ----
S.keys = page => page.getByTestId('screen-keyboard');
/** Type with the on-screen keys, by touch; a space is the Space key (its Thai label on a Thai screen). Answers ms taken. */
S.typeKeys = async (page, text, { space = /^(Space|เว้นวรรค)$/ } = {}) => {
  const k = S.keys(page);
  const t0 = Date.now();
  for (const ch of text) {
    if (ch === ' ') await k.getByRole('button', { name: space }).tap();
    else await k.getByRole('button', { name: ch.toUpperCase(), exact: true }).tap();
  }
  return Date.now() - t0;
};
S.backspace = async (page, n = 1) => { for (let i = 0; i < n; i++) await S.keys(page).getByRole('button', { name: /^(Backspace|ลบตัวอักษร)$/ }).tap(); };
S.keyNames = async page => S.keys(page).locator('button').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label') || b.textContent.trim()));
/** Where the box and its keys are, against the part of the form that scrolls and the bar under it (the lane's own browser test's measure). */
S.placing = (page, testId) => page.evaluate((id) => {
  const field = document.querySelector(`[data-testid="${id}"]`);
  const keyboard = document.querySelector('[data-testid="screen-keyboard"]');
  if (!field || !keyboard) return { field: !!field, keyboard: !!keyboard };
  let scroller = field.parentElement;
  while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
  const bar = document.querySelector('[data-testid="consent-done-bar"]')
    ?? [...document.querySelectorAll('button')].find((button) => /^(Ask the team|ขอความช่วยเหลือจากทีมงาน)$/.test(button.textContent.trim()))?.parentElement ?? null;
  const box = (el) => el.getBoundingClientRect();
  const s = box(scroller); const f = box(field); const k = box(keyboard); const b = bar ? box(bar) : null;
  const inside = (r) => r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
  return { fieldInView: inside(f), keysInView: inside(k), keysBelowField: k.top >= f.bottom - 1,
    clearOfBar: !b || (k.bottom <= b.top + 1 && f.bottom <= b.top + 1),
    viewport: `${innerWidth}x${innerHeight}`, scrollTop: Math.round(scroller.scrollTop),
    scroller: [Math.round(s.top), Math.round(s.bottom)], field: [Math.round(f.top), Math.round(f.bottom)], keys: [Math.round(k.top), Math.round(k.bottom)], bar: b ? [Math.round(b.top), Math.round(b.bottom)] : null,
    barButtons: bar ? [...bar.querySelectorAll('button')].map(x => x.textContent.trim()) : [] };
}, testId);
/** Every visible touch target on a page smaller than `min` px in either direction (label text included for a checkbox). */
S.smallTargets = (page, min = 40) => page.evaluate((min) => {
  const outs = [];
  for (const el of document.querySelectorAll('button, [role="checkbox"], input, textarea, a, [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    const label = el.closest('label');
    const lr = label ? label.getBoundingClientRect() : null;
    const w = Math.max(r.width, lr?.width ?? 0), h = Math.max(r.height, lr?.height ?? 0);
    if (w < min || h < min) outs.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), text: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 50), w: Math.round(r.width), h: Math.round(r.height), withLabel: lr ? `${Math.round(lr.width)}x${Math.round(lr.height)}` : null });
  }
  return outs;
}, min);

// ---- till steps ----
S.halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
S.keypad = async (scope, digits, { tap = false } = {}) => { for (const d of digits) { const b = scope.getByRole('button', { name: d, exact: true }).last(); if (tap) await b.tap(); else await b.click(); } };
S.spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
/** The first screen on a surface (the paired display, or the till's own customer half), then walk-in on the till. */
S.firstScreen = async (surface, till, number, { channel = null, lang = 'en', tap = false } = {}) => {
  await S.landing(surface).waitFor({ timeout: 30000 });
  if (await surface.getByTestId('language-choice').isVisible()) { const b = surface.getByTestId(`language-choice-${lang}`); if (tap) await b.tap(); else await b.click(); }
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? S.halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await S.keypad(scope, number, { tap });
  if (channel) await scope.getByTitle(channel, { exact: true }).click();
  const cont = scope.getByRole('button', { name: /^(Continue|ดำเนินการต่อ)$/ });
  if (tap) await cont.tap(); else await cont.click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
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
S.setAge = async (page, scope, age, { tap = false } = {}) => {
  const press = async l => { if (tap) await l.tap(); else await l.click(); };
  await press(scope.getByRole('button', { name: /Tap to set age|แตะเพื่อระบุอายุ/ }).last());
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor();
  await press(dialog.getByRole('button', { name: String(age), exact: true }));
  await page.waitForTimeout(400);
  await press(dialog.getByRole('button', { name: /^(Jan|ม\.ค\.)/ }).first());
  await page.waitForTimeout(400);
  await press(dialog.getByRole('button', { name: '1', exact: true }).first());
  await page.waitForTimeout(400);
  await press(dialog.getByRole('button', { name: /Confirm|ยืนยัน/ }));
  await dialog.waitFor({ state: 'hidden' });
};
/** What the till's copy of the family's form shows right now. */
S.mirrorState = async till => {
  const m = till.getByTestId('consent-mirror');
  if (!(await m.count())) return { shown: false };
  const val = async l => (await l.count()) ? await l.first().inputValue().catch(() => null) : null;
  const steps = await m.getByTestId('consent-steps').locator('button').evaluateAll(bs => bs.map(b => ({ text: b.textContent.trim(), current: b.className.includes('bg-primary') })));
  return { shown: true, status: S.flat(await m.getByTestId('consent-mirror-status').innerText().catch(() => '')),
    step: steps.find(s => s.current)?.text ?? null,
    childName: await val(m.getByTestId('consent-child-name')),
    allergies: await val(m.getByTestId('consent-allergies')),
    dietary: await val(m.getByTestId('consent-dietary')),
    guardian: await val(m.getByTestId('consent-guardian')),
    phone: await val(m.locator('input[type="tel"]')),
    photoImg: await m.getByTestId('consent-mirror-photo').locator('img').count() ? (await m.getByTestId('consent-mirror-photo').locator('img').getAttribute('src'))?.slice(0, 30) : null,
    photoReceived: await m.getByTestId('consent-photo-received').count(),
    inert: await m.evaluate(e => e.hasAttribute('inert')),
    buttons: await m.locator('button').evaluateAll(bs => bs.filter(b => b.offsetParent).map(b => ({ text: b.textContent.trim().slice(0, 30), disabled: b.disabled, opacity: getComputedStyle(b).opacity }))) };
};
S.displayState = async page => {
  const c = page.getByTestId('display-consent');
  if (!(await c.count())) return { shown: false };
  const val = async l => (await l.count()) ? await l.first().inputValue().catch(() => null) : null;
  const steps = await c.getByTestId('consent-steps').locator('button').evaluateAll(bs => bs.map(b => ({ text: b.textContent.trim(), current: b.className.includes('bg-primary') })));
  const done = c.getByRole('button', { name: /^(Done|เสร็จสิ้น)$/ });
  const txt = async id => (await c.getByTestId(id).count()) ? S.flat(await c.getByTestId(id).first().innerText()) : null;
  return { shown: true, step: steps.find(s => s.current)?.text ?? null,
    childName: await val(c.getByTestId('consent-child-name')),
    allergies: await val(c.getByTestId('consent-allergies')),
    dietary: await val(c.getByTestId('consent-dietary')),
    guardian: await val(c.getByTestId('consent-guardian')),
    phone: await val(c.locator('input[type="tel"]')),
    missing: await txt('consent-missing'), finished: await txt('consent-finished'), notSaved: await txt('consent-not-saved'),
    photoFallback: await txt('consent-photo-fallback'), photoReceived: await txt('consent-photo-received'),
    wait: (await page.getByTestId('display-consent-wait').count()) ? S.flat(await page.getByTestId('display-consent-wait').innerText()) : null,
    reconnecting: (await page.getByTestId('display-form-reconnecting').count()) ? S.flat(await page.getByTestId('display-form-reconnecting').innerText()) : null,
    alert: (await page.getByRole('alert').count()) ? S.flat(await page.getByRole('alert').first().innerText()) : null,
    keysOpen: await S.keys(page).count(),
    doneShown: await done.count(), doneEnabled: (await done.count()) ? await done.first().isEnabled() : null };
};
S.staffLine = async till => (await till.getByTestId('consent-staff-status').count()) ? S.flat(await till.getByTestId('consent-staff-status').innerText()) : null;
S.stationSales = async (station = S.station) => (await S.call('GET', `/sales?branchId=${S.branchId}&stationId=${station.id}&limit=50`)).body.sales;
S.knownSales = new Set();
S.saleWritten = async (kind, station = S.station) => {
  let sale;
  await expect.poll(async () => { sale = (await S.stationSales(station)).find(x => !S.knownSales.has(x.id) && ['tendering', 'open'].includes(x.status)); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  S.knownSales.add(sale.id);
  S.receipt.created.push({ kind, id: sale.id, station: station.id }); S.save();
  return sale;
};
S.paymentStep = page => page.getByTestId('payment-step');
S.amountDue = page => page.evaluate(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.trim() === 'Amount Due'); return h ? (h.nextElementSibling?.textContent ?? '').trim() : null; });
S.payCash = async page => {
  await expect(S.paymentStep(page)).toBeVisible({ timeout: 30000 });
  await page.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = page.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.scrollIntoViewIfNeeded();
  await confirm.click();
  await page.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
};
S.registration = async id => (await S.call('GET', '/checkin/registrations/' + id)).body;
S.sale = async id => (await S.call('GET', `/sales/${id}`)).body;
S.familyOnBoard = async id => (await S.boardApi()).families.find(f => f.registrationId === id) ?? null;
S.regsByPhone = async phone => ((await S.call('GET', `/checkin/registrations?branchId=${S.branchId}`)).body?.registrations ?? []).filter(r => (r.guardianPhone ?? '').replace(/^\+66/, '0') === phone);

// ---- the desk board ----
S.search = page => page.getByPlaceholder('Search child, parent or phone…');
S.openBoard = async (page, tab = 'Upcoming') => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check-in', exact: true }).click();
  await S.search(page).waitFor({ timeout: 20000 });
  const dropOff = page.getByRole('button', { name: 'Drop-off', exact: true }).first();
  if (await dropOff.isVisible().catch(() => false)) await dropOff.click();
  await page.getByRole('button', { name: new RegExp(`^${tab}\\s*\\d+$`) }).first().click();
  await page.waitForTimeout(2500);
};
S.searchBoard = async (page, q) => { await S.search(page).fill(q); await page.waitForTimeout(1200); };
S.releaseOwn = async (regId) => {
  const reg = await S.registration(regId);
  assert.ok(S.isZz(reg.guardianName), 'only this run\'s own booking');
  const done = [];
  for (const child of reg.children.filter(c => c.status === 'in_park')) {
    assert.ok(S.isZz(child.childName));
    const file = await S.call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-893 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await S.call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await S.call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push({ child: child.childName, status: r.status });
  }
  for (const child of reg.children.filter(c => c.status === 'registered')) {
    const r = await S.call('POST', `/checkin/registrations/${regId}/cancel`, { reason: 'ZZ TEST SCRUM-893 proof cleanup' });
    done.push({ cancelWaiting: true, status: r.status, code: r.body?.error?.code ?? null });
    break;
  }
  return done;
};

// ---- setup: the numbers, the own tills ----
S.makeStation = async (label) => {
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z893${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const name = `ZZ TEST SCRUM-893 ${label} ${Date.now()}`;
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name, kind: 'till', boxId: S.box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices: S.devices });
  assert.equal(made.status, 200);
  const station = { ...made.body.station, name };
  S.receipt.created.push({ kind: 'station', id: station.id, name, prefix }); S.save();
  (S.stations ??= []).push(station);
  return station;
};
S.setup = async () => {
  const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box online');
  S.box = { id: box.id, slot: box.slot, role: box.role };
  const board = await S.boardApi();
  const boardPhones = new Set(board.families.map(f => (f.guardianPhone ?? '').replace(/^\+66/, '0')));
  const unused = [];
  for (let i = 10; i < 40; i++) {
    const n = S.zz(i);
    const m = (await S.call('GET', `/members/lookup?phone=${n}`)).body?.member ?? null;
    if (!m && !boardPhones.has(n)) unused.push(n);
  }
  S.receipt.checks = { numbersCheckedUnused: unused.length, first: unused[0], last: unused.at(-1) };
  S.free = unused;
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(r => s.devices.some(d => d.role === r)));
  assert.ok(source, 'simulated printers configured');
  S.devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
  S.station = await S.makeStation('proof till');
  return { free: unused.length, first: unused[0], last: unused.at(-1), station: S.station.id };
};

// ---- the step server ----
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const log = resolve(out, 'steps.log');
let busy = false;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    if (req.url === '/quit') { res.end('bye'); await S.browser?.close().catch(() => {}); await S.admin.dispose().catch(() => {}); server.close(); process.exit(0); }
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
    appendFileSync(log, `\n=== ${at} ${S.phase ?? ''}\n${body.trim()}\n--> ${text.slice(0, 5000)}\n`);
    S.save();
    res.setHeader('content-type', 'application/json');
    res.end(text);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`driver ready on 127.0.0.1:${port}`));
