// SCRUM-963 display-fix lane staging proof, 13 November 2026 (Bangkok); pos and pos-web live at 92d8e3977, the
// platform unchanged at 8c3a6efd (deploys-start.json, deploys-end.json, read by deploys.mjs).
// Started from the SCRUM-954 driver (docs/qa/proof-2026-11-12/SCRUM-954/driver.mjs: the paired counter display at
// 600 x 1024 with `?keyboard=screen`, the on-screen keys, the masks, the own-till set-up) and the SCRUM-959 driver
// (docs/qa/proof-2026-11-13/SCRUM-959/driver.mjs: the split view at 1440 x 900, the category row read, Save as partly
// paid, the manager's refunds from History). Added: a contrast reader (S.ink), the category row's arrows and wheel
// read (S.rowRead), the number box against the language button (S.firstGeo).
//
//   node driver.mjs [port]      then  POST http://127.0.0.1:<port>/run  with the step's body (curl --data-binary @file);
//                               POST /quit  ends it (closes the one browser).
//
// One headless Edge with a file-fed fake camera (a generated plain grey frame, no person), contexts opened and closed as
// the steps need them. Own ZZ TEST tills on the shared virtual box (virtual-1), an own ZZ TEST display paired to the
// desk till, ZZ TEST families with invented numbers (08989630xx, checked unused first). Cash only; every own cash
// payment refunded by the staging manager. Credentials are read by NAME through scripts/agent/env.mjs need() and never
// printed; staff names never enter the receipt or the log (scrubbed), and on the pictures the account corner, the
// password field, the pairing code, staff names, other families and other sales are masked with solid boxes.
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
const port = Number(process.argv[2] ?? 47963);
const out = resolve(import.meta.dirname);
mkdirSync(out, { recursive: true });
const scratch = process.env.ZZ_SCRATCH ?? resolve(out, '.scratch');
mkdirSync(scratch, { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, need };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.sha = '92d8e3977b0c8f9b8761558190f8a2ce8724ab85';
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989630' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const read = f => existsSync(resolve(out, f)) ? JSON.parse(readFileSync(resolve(out, f), 'utf8')) : null;
S.receipt = { tickets: ['SCRUM-963', 'SCRUM-962 (points 2 to 4)', 'SCRUM-969 (points 7 and 8)'], sha: S.sha,
  startedAt: new Date().toISOString(), deploysAtStart: read('deploys-start.json'),
  numbers: {}, created: [], points: {}, reads: {}, odd: [], hunt: [], pageErrors: [], requests: [], registrationsPosted: [], cleanup: {} };
if (process.env.ZZ_RESUME === '1' && existsSync(resolve(out, 'receipt.json'))) {
  const before = JSON.parse(readFileSync(resolve(out, 'receipt.json'), 'utf8'));
  S.receipt = { ...S.receipt, ...before, resumedAt: [...(before.resumedAt ?? []), new Date().toISOString()] };
}
// A promise a step left behind must never take the driver down.
process.on('unhandledRejection', e => { try { S.receipt.odd.push({ what: 'unhandled rejection in a step (logged, driver kept)', text: String(e?.message ?? e).split('\n')[0].slice(0, 200) }); } catch {} });

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
const NOT_NAMES = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Central|Floresta|Branch|Admin|Staff|Party|Oto|Park|Play|Staging|display|main|phone)$/i;
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

// ---- the browser: one, headless, a generated grey camera frame ----
const video = resolve(scratch, 'camera.y4m');
const W = 320, H = 240;
writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(W * H, 150), Buffer.alloc(W * H / 2, 128)]));
S.browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
S.pages = {};
S.watch = (page, label) => {
  page.on('pageerror', e => S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); });
};
S.watchTill = (page, label) => {
  page.on('response', async r => {
    const u = new URL(r.url());
    if (r.request().method() !== 'POST' || u.pathname !== '/api/checkin/registrations') return;
    const entry = { till: label, at: S.phase ?? null, status: r.status(), id: null, finishedAt: new Date().toISOString() };
    S.receipt.registrationsPosted.push(entry);
    entry.id = (await r.json().catch(() => null))?.id ?? null;
    S.save();
  });
};
S.landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2) { S.names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.length >= 3) S.names.add(p); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
S.walkNames = walkNames;
/** Sign a till in at one of this run's own stations. */
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
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  walkNames(me);
  assert.ok(JSON.stringify(me).includes(station.id), 'signed in at the own ZZ TEST till');
  if (query) { await page.goto('/' + query); await page.waitForTimeout(2000); }
  S.pages[label] = { ctx, page, passwordKey, phoneKey };
  return page;
};
S.signOut = async label => {
  const t = S.pages[label];
  if (!t) return null;
  const r = await t.page.evaluate(async key => (await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'idempotency-key': key } })).status, randomUUID()).catch(() => null);
  const me = await t.page.evaluate(async () => (await fetch('/api/me', { credentials: 'include' })).status).catch(() => null);
  await t.ctx.close().catch(() => {});
  delete S.pages[label];
  S.receipt.cleanup.signOuts = { ...(S.receipt.cleanup.signOuts ?? {}), [label]: { signOut: r, meAfter: me } }; S.save();
  return { signOut: r, meAfter: me };
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
S.alive = label => S.pages[label]?.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))).catch(() => null);

// ---- displays: each in its own context, paired to the own till through the admin api ----
S.displays = {};
/** The counter display as it stands: 600 x 1024, a touch screen with no keyboard, `?keyboard=screen`, a fake camera. */
S.pairDisplay = async (label, { viewport = { width: 600, height: 1024 }, query = '?keyboard=screen', station = S.station } = {}) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, hasTouch: true, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, `display-${label}`);
  await page.goto(`${S.pos}/display${query}`);
  await page.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
  assert.match(pairingCode, /^\d{6}$/);
  const paired = await S.call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: `ZZ TEST SCRUM-963 display ${label}` });
  assert.equal(paired.status, 200);
  S.displays[label] = { ctx, page, id: paired.body.device.id, revoked: false };
  S.receipt.created.push({ kind: 'display', label, id: paired.body.device.id, station: station.id }); S.save();
  await S.landing(page).waitFor({ timeout: 60000 });
  return page;
};
S.dropDisplay = async (label, reason = 'ZZ TEST SCRUM-963 proof step complete') => {
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

// ---- masks (SCRUM-884's: in place, images inside a masked card hidden too) ----
S.hidden = [];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
S.esc = esc;
S.familyAllZz = f => S.isZz(f.guardianName) && f.children.every(c => S.isZz(c.childName)) && (f.checkedInChildNames ?? []).every(S.isZz);
S.boardApi = async () => {
  const board = (await S.call('GET', `/checkin/board?branchId=${S.branchId}`)).body;
  const keep = new Set();
  for (const f of board.families) {
    for (const n of [f.guardianName, ...f.children.map(c => c.childName), ...(f.checkedInChildNames ?? [])]) if (n && !S.isZz(n) && n.trim().length >= 2) keep.add(n.trim());
    if (!S.familyAllZz(f) && f.guardianPhone) { const p = f.guardianPhone; keep.add(p); keep.add(p.replace(/^\+66/, '0')); }
  }
  for (const n of board.nannies ?? []) if (n.name && !S.isZz(n.name)) keep.add(n.name.trim());
  const zzText = ['zz test', S.fixtureName ?? '', ...board.families.filter(S.familyAllZz).flatMap(f => [f.guardianName, ...f.children.map(c => c.childName)])].join(' | ').toLowerCase();
  const inZz = s => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u').test(zzText);
  S.hidden = [...new Set([...S.hidden, ...keep])].filter(s => s.length >= 2 && !inZz(s)).sort((a, b) => b.length - a.length);
  return board;
};
S.deskCards = page => page.locator('div.grid.gap-3 > div[class*="bg-card/50"]');
S.phoneCards = page => page.locator('div.space-y-2 > button[class*="rounded-2xl"]');
S.pickerCards = page => page.getByRole('dialog').locator('div.space-y-3 > div');
S.otherSales = page => page.locator('div.space-y-2 > button.w-full.text-left:not([data-zz]):not([role="dialog"] *)');
S.markMine = (page, list) => page.evaluate((list) => {
  for (const b of document.querySelectorAll('div.space-y-2 > button.w-full.text-left')) { const t = b.innerText.replace(/\s+/g, ' '); if (list.some(r => t.includes(r))) b.setAttribute('data-zz', 'mine'); else b.removeAttribute('data-zz'); }
}, list);
S.needles = () => [...S.hidden, ...[...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s))].filter(Boolean);
S.inPlace = page => [page.getByLabel('Lock screen').locator('..'), S.deskCards(page).filter({ hasNotText: 'ZZ TEST' }), S.phoneCards(page).filter({ hasNotText: 'ZZ TEST' }), page.getByText(/^(Nannies free now|Free nannies):/), S.otherSales(page), S.pickerCards(page).filter({ hasNotText: 'ZZ TEST' })];
S.masks = page => [page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'), page.locator('canvas'), page.getByText(/^QR-[A-Z0-9]+$/)];
const MASK_CSS = '[data-zz-mask]{background:#18181b!important;color:#18181b!important;border-color:#18181b!important;border-radius:2px} [data-zz-mask] *{color:#18181b!important;background:#18181b!important;border-color:#18181b!important} [data-zz-mask] img,[data-zz-mask] video,[data-zz-mask] picture,[data-zz-mask] canvas{opacity:0!important}';
S.capture = async (page, opts = {}, extra = []) => {
  for (const loc of S.inPlace(page)) await loc.evaluateAll(els => { for (const e of els) e.setAttribute('data-zz-mask', '1'); }).catch(() => {});
  const sources = S.needles().map(s => '(?<![\\p{L}\\p{N}])' + esc(s) + '(?![\\p{L}\\p{N}])');
  await page.evaluate(({ list, css }) => {
    if (!document.getElementById('zz-mask-style')) { const st = document.createElement('style'); st.id = 'zz-mask-style'; st.textContent = css; document.head.appendChild(st); }
    const res = list.map(s => new RegExp(s, 'iu'));
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const v = w.currentNode.nodeValue || ''; if (v.trim() && res.some(r => r.test(v))) w.currentNode.parentElement?.setAttribute('data-zz-mask', '1'); }
    for (const el of document.querySelectorAll('input,textarea')) { if (res.some(r => r.test(el.value || ''))) el.setAttribute('data-zz-mask', '1'); }
  }, { list: sources, css: MASK_CSS }).catch(() => {});
  try {
    return await page.screenshot({ animations: 'disabled', ...opts, mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
  } finally {
    await page.evaluate(() => { for (const el of document.querySelectorAll('[data-zz-mask]')) el.removeAttribute('data-zz-mask'); }).catch(() => {});
  }
};
S.shots = [];
S.shot = async (page, name, extra = [], opts = {}) => {
  const buf = await S.capture(page, opts, extra);
  writeFileSync(resolve(out, name), buf);
  S.shots.push(name);
  return name;
};
/** Two pages captured at the same moment, side by side in one labelled picture. */
S.both = async (name, caption, left, right, opts = {}) => {
  const at = new Date();
  const [a, b] = await Promise.all([S.capture(left), S.capture(right)]);
  const lv = left.viewportSize(), rv = right.viewportSize();
  const sheet = await S.browser.newPage({ viewport: { width: 2000, height: 800 } });
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(at);
  const e = s => String(s ?? '').replace(/[<>&]/g, '');
  await sheet.setContent(`<html><body style="margin:0;background:#fff;font:15px system-ui;color:#111"><div style="padding:8px 12px"><b>SCRUM-963</b> · ${e(caption)} · captured together at ${when} Bangkok</div><div style="display:flex;gap:10px;padding:0 10px 10px;align-items:flex-start"><figure style="margin:0;flex:${opts.leftFlex ?? lv.width}"><figcaption style="font-size:13px;margin-bottom:3px">${e(opts.leftLabel ?? `Till (${lv.width}×${lv.height})`)}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${a.toString('base64')}"></figure><figure style="margin:0;flex:${opts.rightFlex ?? rv.width}"><figcaption style="font-size:13px;margin-bottom:3px">${e(opts.rightLabel ?? `Counter display (${rv.width}×${rv.height}, touch, ?keyboard=screen)`)}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${b.toString('base64')}"></figure></div></body></html>`);
  await sheet.screenshot({ path: resolve(out, name), fullPage: true });
  await sheet.close();
  S.shots.push(name);
  return name;
};

// ---- the on-screen keys ----
S.keys = page => page.getByTestId('screen-keyboard');
S.typeKeys = async (page, text, { space = /^(Space|เว้นวรรค|空格|Пробел|Espace)$/, scope = null } = {}) => {
  const k = scope ? scope.getByTestId('screen-keyboard') : S.keys(page);
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  for (const ch of text) {
    const b = ch === ' ' ? k.getByRole('button', { name: space }) : k.getByRole('button', { name: ch.toUpperCase(), exact: true });
    if (touch) await b.tap(); else await b.click();
  }
};
S.hideKeys = async (page, scope = null) => { const k = scope ? scope.getByTestId('screen-keyboard') : S.keys(page); const b = k.getByTestId('screen-keyboard-hide'); if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await b.tap(); else await b.click(); };
/** Where the box and its keys are, against the scrolling part and the bar under it (SCRUM-894's measure). */
S.placing = (page, testId) => page.evaluate((id) => {
  const field = document.querySelector(`[data-testid="display-consent"] [data-testid="${id}"]`) ?? document.querySelector(`[data-testid="${id}"]`);
  const keyboard = document.querySelector('[data-testid="screen-keyboard"]');
  if (!field || !keyboard) return { field: !!field, keyboard: !!keyboard };
  let scroller = field.parentElement;
  while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
  const bar = document.querySelector('[data-testid="consent-done-bar"]')
    ?? [...document.querySelectorAll('button')].find((button) => /^(Ask the team|ขอความช่วยเหลือจากทีมงาน)$/.test(button.textContent.trim()))?.parentElement ?? null;
  const box = (el) => el.getBoundingClientRect();
  const s = scroller ? box(scroller) : { top: 0, bottom: innerHeight }; const f = box(field); const k = box(keyboard); const b = bar ? box(bar) : null;
  const inside = (r) => r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
  return { fieldInView: inside(f), keysInView: inside(k), keysBelowField: k.top >= f.bottom - 1, keysOverField: k.top < f.bottom - 1 && k.bottom > f.top + 1,
    clearOfBar: !b || (k.bottom <= b.top + 1 && f.bottom <= b.top + 1),
    viewport: `${innerWidth}x${innerHeight}`, scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
    field: [Math.round(f.top), Math.round(f.bottom)], keys: [Math.round(k.top), Math.round(k.bottom)], bar: b ? [Math.round(b.top), Math.round(b.bottom)] : null };
}, testId);
/** Every visible touch target in a scope with its size; the ones under `min` listed apart. */
S.sizesIn = (page, rootSel, min = 44) => page.evaluate(({ rootSel, min }) => {
  const root = rootSel ? document.querySelector(rootSel) : document;
  if (!root) return { error: 'no root ' + rootSel };
  const r1 = v => Math.round(v * 10) / 10;
  const all = [];
  for (const el of root.querySelectorAll('button, [role="checkbox"], [role="button"], a')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    all.push({ text: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), w: r1(r.width), h: r1(r.height), disabled: !!el.disabled });
  }
  return { all, under: all.filter(x => x.h < min || x.w < min) };
}, { rootSel, min });
S.fit = (page, rootSel = null) => page.evaluate((rootSel) => {
  const root = rootSel ? document.querySelector(rootSel) : document.body;
  if (!root) return { error: 'no root ' + rootSel };
  const vw = window.innerWidth;
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
  const txt = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const r1 = v => Math.round(v * 10) / 10;
  const out = { viewport: [vw, window.innerHeight], pageSideways: document.documentElement.scrollWidth > vw + 1, truncated: [], spill: [], outsideViewport: [], sidewaysScrollers: [], pastRightEdge: [], overlaps: [] };
  for (const el of root.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const t = txt(el);
    if (t && cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.truncated.push({ tag: el.tagName, text: t.slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth });
    else if (t && cs.overflowX === 'hidden' && el.children.length === 0 && el.scrollWidth > el.clientWidth + 1) out.truncated.push({ tag: el.tagName, text: t.slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth, how: 'overflow hidden' });
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) out.sidewaysScrollers.push({ tag: el.tagName, cls: String(el.className).slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth, text: t.slice(0, 60) });
    if (el.children.length === 0 && t) { const r = el.getBoundingClientRect(); if (r.right > vw + 1) out.pastRightEdge.push({ text: t.slice(0, 70), right: r1(r.right) }); }
  }
  const btns = [...root.querySelectorAll('button, [role="button"], a')].filter(vis);
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    let worst = 0;
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { if (!w.currentNode.nodeValue.trim() || !vis(w.currentNode.parentElement)) continue; const rg = document.createRange(); rg.selectNodeContents(w.currentNode); for (const rr of rg.getClientRects()) worst = Math.max(worst, r.left - rr.left, rr.right - r.right, r.top - rr.top, rr.bottom - r.bottom); }
    if (worst > 1) out.spill.push({ text: txt(b).slice(0, 90), by: r1(worst), box: [r1(r.left), r1(r.top), r1(r.width), r1(r.height)] });
    if (r.right > vw + 1 || r.left < -1) out.outsideViewport.push({ text: txt(b).slice(0, 90), left: r1(r.left), right: r1(r.right) });
  }
  // text runs that sit on top of each other (two leaf texts whose boxes cross), within the root
  const leaves = [];
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) { const v = tw.currentNode.nodeValue.trim(); if (!v || !vis(tw.currentNode.parentElement)) continue; const rg = document.createRange(); rg.selectNodeContents(tw.currentNode); for (const rr of rg.getClientRects()) if (rr.width > 2 && rr.height > 2) leaves.push({ v: v.slice(0, 40), r: rr, el: tw.currentNode.parentElement }); }
  for (let i = 0; i < leaves.length && out.overlaps.length < 12; i++) for (let j = i + 1; j < leaves.length; j++) {
    const a = leaves[i].r, b = leaves[j].r;
    const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ix > 3 && iy > 3 && leaves[i].el !== leaves[j].el && !leaves[i].el.contains(leaves[j].el) && !leaves[j].el.contains(leaves[i].el)) { out.overlaps.push({ a: leaves[i].v, b: leaves[j].v, by: [r1(ix), r1(iy)] }); break; }
  }
  out.problems = out.pageSideways || out.truncated.length + out.spill.length + out.outsideViewport.length + out.pastRightEdge.length + out.overlaps.length > 0;
  return out;
}, rootSel);

// ---- contrast: the ink of an element against what lies under it (composited, sRGB, WCAG 2) ----
S.inkJs = `(el) => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e);
  let bg = [255, 255, 255, 1]; const images = [];
  for (const e of chain.reverse()) { const cs = getComputedStyle(e); if (cs.backgroundImage && cs.backgroundImage !== 'none') images.push((e.getAttribute('data-testid') || e.tagName) + ': ' + cs.backgroundImage.slice(0, 80)); const c = rgba(cs.backgroundColor); if (c[3] > 0) bg = over(c, bg); }
  const ink = over(rgba(getComputedStyle(el).color), bg);
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const L1 = lum(ink), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  return { text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40), color: getComputedStyle(el).color, ownBg: getComputedStyle(el).backgroundColor, inkHex: hex(ink), bgHex: hex(bg), ratio: Math.round(ratio * 100) / 100, gradientsUnder: images };
}`;
S.ink = loc => loc.evaluate(new Function('return ' + S.inkJs)());

// ---- till steps ----
S.halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
S.keypad = async (scope, digits, { tap = false } = {}) => { for (const d of digits) { const b = scope.getByRole('button', { name: d, exact: true }).last(); if (tap) await b.tap(); else await b.click(); } };
S.spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
S.quantity = async (page, label, target) => {
  const add = page.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
  const remove = page.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 10; i++) { const c = Number(await value.textContent()); if (c === target) return; await (c < target ? add : remove).click(); await page.waitForTimeout(250); }
  assert.equal(Number(await value.textContent()), target);
};
S.ticket = async (page, kids, adults, pkg = '1 Hour Play', go = true) => {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByRole('heading', { name: pkg, exact: true }).first().click();
  await S.quantity(page, 'Kids', kids); await S.quantity(page, 'Adults', adults);
  if (go) await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
};
/** The age picker's look. */
S.pickerLook = page => page.evaluate(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  if (!d) return null;
  const cs = getComputedStyle(d);
  return { dataSurface: d.getAttribute('data-surface'), bg: cs.backgroundColor };
});
/** The age picker's presses: its close, back, crumbs (Age, Month, Day). */
S.pickerSizes = page => page.evaluate(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  if (!d) return null;
  const r1 = v => Math.round(v * 10) / 10;
  const sz = (b, label) => { if (!b) return null; const r = b.getBoundingClientRect(); return { label, text: (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20), w: r1(r.width), h: r1(r.height), box: [r1(r.left), r1(r.top), r1(r.right), r1(r.bottom)], disabled: !!b.disabled }; };
  const close = [...d.children].filter(c => c.tagName === 'BUTTON').at(-1);
  const head = d.querySelector('.border-b');
  const back = head ? [...head.querySelectorAll('button')].find(b => /^(Back|ย้อนกลับ|返回|Назад|Retour)$/.test(b.getAttribute('aria-label') || '')) : null;
  const crumbs = head ? [...head.querySelectorAll('button')].filter(b => b !== back) : [];
  const xIcon = close?.querySelector('svg')?.getBoundingClientRect();
  return { viewport: `${innerWidth}x${innerHeight}`, surface: d.getAttribute('data-surface'), close: sz(close, 'close'), closeIcon: xIcon ? [r1(xIcon.left), r1(xIcon.top), r1(xIcon.width), r1(xIcon.height)] : null, back: sz(back, 'back'), crumbs: crumbs.map(b => sz(b, 'crumb')),
    under44: [sz(close, 'close'), sz(back, 'back'), ...crumbs.map(b => sz(b, 'crumb'))].filter(x => x && (x.h < 44 || x.w < 44)) };
});
S.mirrorState = async till => {
  const m = till.getByTestId('consent-mirror');
  if (!(await m.count())) return { shown: false };
  const val = async l => (await l.count()) ? await l.first().inputValue().catch(() => null) : null;
  return { shown: true, childName: await val(m.getByTestId('consent-child-name')), allergies: await val(m.getByTestId('consent-allergies')),
    dietary: await val(m.getByTestId('consent-dietary')), guardian: await val(m.getByTestId('consent-guardian')), text: S.flat(await m.innerText()).slice(0, 400) };
};
S.displayState = async page => {
  const c = page.getByTestId('display-consent');
  if (!(await c.count())) return { shown: false };
  const val = async l => (await l.count()) ? await l.first().inputValue().catch(() => null) : null;
  const steps = await c.getByTestId('consent-steps').locator('button').evaluateAll(bs => bs.map(b => ({ text: b.textContent.trim(), current: b.className.includes('bg-primary') })));
  return { shown: true, step: steps.find(s => s.current)?.text ?? null, childName: await val(c.getByTestId('consent-child-name')), allergies: await val(c.getByTestId('consent-allergies')),
    guardian: await val(c.getByTestId('consent-guardian')), keysOpen: await S.keys(page).count(),
    reconnecting: (await page.getByTestId('display-form-reconnecting').count()) ? S.flat(await page.getByTestId('display-form-reconnecting').innerText()) : null };
};
/** The display's form: the heading, the reconnecting line, the Retry bar, the lock, the status lines, the language button. */
S.geo = page => page.evaluate(() => {
  const r1 = v => Math.round(v * 10) / 10;
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [r1(r.left), r1(r.top), r1(r.right), r1(r.bottom)]; };
  const lang = [...document.querySelectorAll('button')].find(b => /^(Change language|เปลี่ยนภาษา|更改语言|Сменить язык|Changer de langue)$/.test(b.getAttribute('aria-label') || '') || b.getAttribute('aria-haspopup') === 'listbox');
  const line = document.querySelector('[data-testid="display-form-reconnecting"]');
  const form = document.querySelector('[data-testid="display-consent"]');
  const heading = form?.querySelector('h2');
  const alert = document.querySelector('[role="alert"]');
  return { line: line ? { text: line.textContent.trim(), rect: rect(line) } : null, lang: rect(lang), langText: lang?.textContent.trim() ?? null, langAria: lang?.getAttribute('aria-label') ?? null,
    headingTop: heading ? r1(heading.getBoundingClientRect().top) : null, heading: heading?.textContent.trim() ?? null, formTop: form ? r1(form.getBoundingClientRect().top) : null,
    formInert: !!form?.closest('[inert]'), alert: alert ? { text: alert.innerText.replace(/\s+/g, ' ').trim(), rect: rect(alert) } : null,
    status: [...document.querySelectorAll('[role="status"]')].map(s => s.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
    paused: /Connection paused|การเชื่อมต่อหยุดชั่วคราว/.test(document.body.innerText),
    pills: form ? [...(form.querySelector('[data-testid="consent-steps"]')?.querySelectorAll('button') ?? [])].map(b => b.textContent.trim()) : [] };
});
/** The language button (the pill) and its open list: each choice's text, size, colour; the list's background. */
S.langList = page => page.evaluate(() => {
  const r1 = v => Math.round(v * 10) / 10;
  const b = [...document.querySelectorAll('button')].filter(x => /^(Change language|เปลี่ยนภาษา|更改语言|Сменить язык|Changer de langue)$/.test(x.getAttribute('aria-label') || '') && x.getBoundingClientRect().width > 0).at(-1);
  if (!b) return null;
  const m = b.parentElement?.querySelector(':scope > div');
  const pr = b.getBoundingClientRect();
  const res = { pill: { text: b.textContent.trim(), h: r1(pr.height), w: r1(pr.width), bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color } };
  if (!m) return { ...res, open: false };
  const mr = m.getBoundingClientRect();
  return { ...res, open: true, listBg: getComputedStyle(m).backgroundColor, listBox: [r1(mr.left), r1(mr.top), r1(mr.right), r1(mr.bottom)],
    choices: [...m.querySelectorAll('button')].map(x => { const r = x.getBoundingClientRect(); return { text: x.textContent.trim(), h: r1(r.height), w: r1(r.width), color: getComputedStyle(x).color, bg: getComputedStyle(x).backgroundColor, chosenClass: /bg-primary\/15/.test(x.className) }; }) };
});
S.openLang = async page => { const b = page.getByRole('button', { name: /^(Change language|เปลี่ยนภาษา|更改语言|Сменить язык|Changer de langue)$/ }).last(); if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await b.tap(); else await b.click(); await page.waitForTimeout(400); };
S.chooseLang = async (page, label) => { await S.openLang(page); const c = page.getByRole('button', { name: label, exact: true }).last(); if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await c.tap(); else await c.click(); await page.waitForTimeout(600); };
S.themeOf = page => page.evaluate(() => document.querySelector('[data-testid="separate-display"]')?.className.split(' ')[0] ?? null);
S.toggleDisplayTheme = async (till = S.till) => {
  await till.getByRole('button', { name: 'Theme settings' }).click();
  await till.waitForTimeout(500);
  const menu = S.flat(await till.getByRole('menu').innerText().catch(() => ''));
  await till.getByRole('menu').getByRole('button', { name: /Display/ }).first().click().catch(async () => { await till.getByRole('menu').getByText(/Display/).first().click(); });
  await till.keyboard.press('Escape');
  await till.waitForTimeout(2500);
  return menu.slice(0, 160);
};
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
S.registration = async id => (await S.call('GET', '/checkin/registrations/' + id)).body;
S.sale = async id => (await S.call('GET', `/sales/${id}`)).body;
S.cancelSale = async (till = S.till) => {
  await till.getByRole('button', { name: 'Cancel', exact: true }).last().click(); await till.waitForTimeout(1200);
  const dlg = till.getByRole('alertdialog').or(till.getByRole('dialog')).last();
  let text = null;
  if (await dlg.count()) { text = S.flat(await dlg.innerText()).slice(0, 200); const yes = dlg.getByRole('button', { name: /Cancel sale|Yes|Discard|Clear|Confirm|Cancel order/ }).first(); if (await yes.count()) await yes.click(); await till.waitForTimeout(1200); }
  return text;
};
S.releaseOwn = async (regId) => {
  const reg = await S.registration(regId);
  assert.ok(S.isZz(reg.guardianName) && reg.children.every(c => S.isZz(c.childName)), 'only this run\'s own booking');
  const done = [];
  for (const child of reg.children.filter(c => c.status === 'in_park')) {
    const file = await S.call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-963 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await S.call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await S.call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push({ child: child.childName, status: r.status });
  }
  return done;
};

// ---- the split view (SCRUM-959's) ----
S.toggleDisplay = async (page, want) => {
  const b = page.getByRole('button', { name: /^(Show|Hide) customer display$/ }).first();
  await b.waitFor({ timeout: 20000 });
  const showing = S.flat(await b.innerText()).startsWith('Hide');
  if (showing !== want) { await b.click(); await page.waitForTimeout(800); }
  return S.flat(await b.innerText());
};
S.customerHalf = page => page.locator('div[class^="w-1/2 h-full"]').last();
/** The category row (shared/CategoryRow): its box, scroll, wrap, the arrows, the chosen category and the last one. */
S.rowRead = page => page.evaluate(() => {
  const r1 = v => Math.round(v * 10) / 10;
  const row = [...document.querySelectorAll('[data-testid="category-row"]')].find(e => e.getBoundingClientRect().width > 0);
  if (!row) return { row: false };
  const b = row.getBoundingClientRect();
  const btns = [...row.querySelectorAll(':scope > button')];
  const box = x => { const r = x.getBoundingClientRect(); return [r1(r.left), r1(r.top), r1(r.right), r1(r.bottom)]; };
  const wrapper = row.parentElement;
  const arrow = name => { const a = [...wrapper.querySelectorAll(':scope > button')].find(x => x.getAttribute('aria-label') === name); return a ? { box: box(a), w: r1(a.getBoundingClientRect().width), h: r1(a.getBoundingClientRect().height) } : null; };
  const chosen = row.querySelector('[data-chosen="true"]');
  const whole = x => { const r = x.getBoundingClientRect(); return r.left >= b.left - 0.5 && r.right <= b.right + 0.5; };
  const last = btns.at(-1);
  let scroller = row.parentElement; while (scroller && !(['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
  return { row: true, box: box(row), clientWidth: row.clientWidth, scrollWidth: row.scrollWidth, scrollLeft: r1(row.scrollLeft), end: row.scrollWidth - row.clientWidth, wrap: getComputedStyle(row).flexWrap,
    lines: new Set(btns.map(x => Math.round(x.getBoundingClientRect().top))).size, count: btns.length,
    earlier: arrow('Earlier categories'), more: arrow('More categories'),
    chosen: chosen ? { text: chosen.innerText.trim(), box: box(chosen), whole: whole(chosen) } : null,
    last: last ? { text: last.innerText.trim(), whole: whole(last) } : null,
    seen: btns.filter(whole).map(x => x.innerText.trim()),
    pageScroller: scroller ? { tag: scroller.tagName, cls: String(scroller.className).slice(0, 60), scrollTop: r1(scroller.scrollTop) } : { tag: 'document', scrollTop: r1(document.scrollingElement.scrollTop) }, winScrollY: r1(scrollY) };
});
/** Roll a plain mouse wheel (deltaY only) over the category row; record whether the page saw it prevented. */
S.wheelRow = async (page, dy, times = 1) => {
  await page.evaluate(() => { if (!window.__zzWheel) { window.__zzWheel = []; document.addEventListener('wheel', e => { window.__zzWheel.push({ prevented: e.defaultPrevented, dx: e.deltaX, dy: e.deltaY }); }, { passive: true }); } window.__zzWheel.length = 0; });
  const row = page.locator('[data-testid="category-row"]').first();
  const bb = await row.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  for (let i = 0; i < times; i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(250); }
  await page.waitForTimeout(400);
  return page.evaluate(() => window.__zzWheel.slice());
};

// ---- setup: the numbers, the own tills ----
S.makeStation = async (label) => {
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z963${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const name = `ZZ TEST SCRUM-963 ${label} ${Date.now()}`;
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
  for (let i = 10; i < 30; i++) {
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
  S.station = await S.makeStation('desk till');
  S.fixtureName = S.station.name;
  return { free: unused.length, first: unused[0], last: unused.at(-1), station: S.station.id, prefix: S.station.codePrefix };
};

// ---- the step server ----
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const log = resolve(out, 'steps.log');
let busy = false;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    if (req.url === '/quit') { res.end('bye'); clearInterval(S.aliveTimer); await S.browser?.close().catch(() => {}); await S.admin.dispose().catch(() => {}); server.close(); process.exit(0); }
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
    appendFileSync(log, `\n=== ${at} ${S.phase ?? ''}\n${body.trim()}\n--> ${text.slice(0, 8000)}\n`);
    S.save();
    res.setHeader('content-type', 'application/json');
    res.end(text);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`driver ready on 127.0.0.1:${port}`));
