// SCRUM-954 / 956 / 953 small-points lane staging proof, 13 November 2026 (Bangkok); pos and pos-web at e4989a0d6
// (deploys.json; no platform change in the lane). An interactive driver, as the SCRUM-893, SCRUM-934 and SCRUM-884
// runs were driven, started from those drivers (docs/qa/proof-2026-11-12/SCRUM-893|934|884/driver.mjs): the counter
// display as it stands (600 x 1024, touch, `?keyboard=screen`, paired to an own till through the admin API), the phone
// till (390 x 844 and 360 x 740), the desk till (1680 x 1050), the OTO App party recipe, and SCRUM-884's masks (which
// also hide every image inside a masked card).
//
//   node driver.mjs [port]      then  POST http://127.0.0.1:<port>/run  with the step's body (curl --data-binary @file);
//                               POST /quit  ends it (closes the one browser).
//
// One headless Edge with a file-fed fake camera (a generated plain grey frame, no person), contexts opened and closed as
// the steps need them. Own ZZ TEST tills on the shared virtual box (virtual-1), ZZ TEST families with invented numbers
// (08989540xx, checked unused first), one ZZ TEST promo code (10 %), one ZZ TEST party made in the OTO App and deleted
// after. Cash only; every own cash sale refunded by the staging manager. Credentials are read by NAME through
// scripts/agent/env.mjs need() and never printed; staff names never enter the receipt or the log (scrubbed), and on the
// pictures the account corner, the password field, the pairing code, staff names, other families, other parties and
// other sales are masked with solid boxes.
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
const port = Number(process.argv[2] ?? 47954);
const out = resolve(import.meta.dirname);
mkdirSync(out, { recursive: true });
const scratch = process.env.ZZ_SCRATCH ?? resolve(out, '.scratch');
mkdirSync(scratch, { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, need };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.LAUNCHER = 'https://oto-launcher-staging.onrender.com';
S.APP = 'https://oto-app-staging.onrender.com';
S.APP_FLORESTA = '6427e84d-723f-4dbd-be58-8ef89cf7dc99';
S.FLORESTA_PACKAGE = '391b269d-159a-4039-89a2-51ac132da747';
S.sha = 'e4989a0d612fba311a301eb30f31acb64284021c';
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989540' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(out, 'deploys.json');
S.receipt = { tickets: ['SCRUM-954', 'SCRUM-956', 'SCRUM-953'], sha: S.sha,
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  numbers: {}, created: [], points: {}, reads: {}, odd: [], defects: [], hunt: [], pageErrors: [], requests: [], registrationsPosted: [], cleanup: {} };
if (process.env.ZZ_RESUME === '1' && existsSync(resolve(out, 'receipt.json'))) {
  const before = JSON.parse(readFileSync(resolve(out, 'receipt.json'), 'utf8'));
  S.receipt = { ...S.receipt, ...before, resumedAt: [...(before.resumedAt ?? []), new Date().toISOString()] };
}
// A promise a step left behind must never take the driver down.
process.on('unhandledRejection', e => { try { S.receipt.odd.push({ what: 'unhandled rejection in a step (logged, driver kept)', text: String(e?.message ?? e).split('\n')[0].slice(0, 200) }); } catch {} });

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
const NOT_NAMES = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Central|Floresta|Branch|Admin|Staff|Party|Oto|Park|Play|Staging)$/i;
S.scrub = text => {
  let t = String(text);
  for (const n of [...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s)).sort((a, b) => b.length - a.length)) t = t.split(n).join('[staff]');
  return t;
};
S.save = () => writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
S.point = (key, pass, pictures, seen) => { S.receipt.points[key] = { pass, pictures, seen }; S.save(); return { key, pass }; };
S.odd = (what, extra = {}) => { S.receipt.odd.push({ what, ...extra }); S.save(); };

// ---- the admin api (stations, displays, codes, reads, clean-up) ----
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
  const paired = await S.call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: `ZZ TEST SCRUM-954 display ${label}` });
  assert.equal(paired.status, 200);
  S.displays[label] = { ctx, page, id: paired.body.device.id, revoked: false };
  S.receipt.created.push({ kind: 'display', label, id: paired.body.device.id, station: station.id }); S.save();
  await S.landing(page).waitFor({ timeout: 60000 });
  return page;
};
S.dropDisplay = async (label, reason = 'ZZ TEST SCRUM-954 proof step complete') => {
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
S.otherParties = page => page.locator('div.space-y-2 > button.w-full').filter({ hasNotText: 'ZZ TEST' });
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
  await sheet.setContent(`<html><body style="margin:0;background:#fff;font:15px system-ui;color:#111"><div style="padding:8px 12px"><b>SCRUM-954</b> · ${e(caption)} · captured together at ${when} Bangkok</div><div style="display:flex;gap:10px;padding:0 10px 10px;align-items:flex-start"><figure style="margin:0;flex:${opts.leftFlex ?? lv.width}"><figcaption style="font-size:13px;margin-bottom:3px">${e(opts.leftLabel ?? `Till (${lv.width}×${lv.height})`)}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${a.toString('base64')}"></figure><figure style="margin:0;flex:${opts.rightFlex ?? rv.width}"><figcaption style="font-size:13px;margin-bottom:3px">${e(opts.rightLabel ?? `Counter display (${rv.width}×${rv.height}, touch, ?keyboard=screen)`)}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${b.toString('base64')}"></figure></div></body></html>`);
  await sheet.screenshot({ path: resolve(out, name), fullPage: true });
  await sheet.close();
  S.shots.push(name);
  return name;
};
/** A picture of read-back facts: a plain table, rendered in its own page. */
S.facts = async (name, title, rows) => {
  const page = await S.browser.newPage({ viewport: { width: 1300, height: 300 } });
  const e = s => String(s ?? 'null').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:16px;background:#fff;color:#111"><h3 style="margin:0 0 8px">${e(title)}</h3>
    <p style="margin:0 0 10px;color:#555;font-size:13px">Read ${e(new Date().toISOString())} from ${e(S.pos)} (staging, pos and pos-web at e4989a0d6). ZZ TEST values only.</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td><b>${e(k)}</b></td><td style="font-family:Consolas,monospace">${e(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('')}</table></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  S.shots.push(name);
  return name;
};

// ---- the on-screen keys ----
S.keys = page => page.getByTestId('screen-keyboard');
S.typeKeys = async (page, text, { space = /^(Space|เว้นวรรค)$/, scope = null } = {}) => {
  const k = scope ? scope.getByTestId('screen-keyboard') : S.keys(page);
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  for (const ch of text) {
    const b = ch === ' ' ? k.getByRole('button', { name: space }) : k.getByRole('button', { name: ch.toUpperCase(), exact: true });
    if (touch) await b.tap(); else await b.click();
  }
};
S.hideKeys = async (page, scope = null) => { const k = scope ? scope.getByTestId('screen-keyboard') : S.keys(page); const b = k.getByTestId('screen-keyboard-hide'); if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await b.tap(); else await b.click(); };
/** The keys' own button beside Space: its words, colours, place and size. */
S.keyLook = (page, scopeSel = null) => page.evaluate((scopeSel) => {
  const root = scopeSel ? document.querySelector(scopeSel) : document;
  const kb = root?.querySelector('[data-testid="screen-keyboard"]');
  if (!kb) return { keys: false };
  const buttons = [...kb.querySelectorAll('button')];
  const hide = kb.querySelector('[data-testid="screen-keyboard-hide"]');
  const space = buttons.find(b => /^(Space|เว้นวรรค)$/.test((b.getAttribute('aria-label') || b.textContent).trim()));
  const back = buttons.find(b => /^(Backspace|ลบตัวอักษร)$/.test((b.getAttribute('aria-label') || b.textContent).trim()));
  const look = b => { if (!b) return null; const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), aria: b.getAttribute('aria-label'), bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor, h: Math.round(r.height * 10) / 10, w: Math.round(r.width * 10) / 10, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), primaryClass: /(^| )bg-primary( |$)/.test(b.className), icon: !!b.querySelector('svg') }; };
  const kr = kb.getBoundingClientRect();
  const h = hide ? hide.getBoundingClientRect() : null;
  return { keys: true, hide: look(hide), space: look(space), backspace: look(back), sameBgAsSpace: !!(hide && space) && getComputedStyle(hide).backgroundColor === getComputedStyle(space).backgroundColor,
    bottomRight: h ? (Math.abs(h.right - kr.right) <= 16 && Math.abs(h.bottom - kr.bottom) <= 16) : null, lastButton: buttons.at(-1) === hide, keyboardBox: [Math.round(kr.left), Math.round(kr.top), Math.round(kr.right), Math.round(kr.bottom)] };
}, scopeSel);
/** Every visible button whose fill is the primary (blue) colour of the form's Continue/Done. */
S.blueButtons = (page, refText = /^(Done|Continue|เสร็จสิ้น|ดำเนินการต่อ)$/) => page.evaluate((src) => {
  const re = new RegExp(src);
  const vis = b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden'; };
  const all = [...document.querySelectorAll('button')].filter(vis);
  const ref = all.find(b => re.test(b.textContent.trim()) && /(^| )bg-primary( |$)/.test(b.className));
  const blue = ref ? getComputedStyle(ref).backgroundColor : null;
  return { primary: blue, blue: all.filter(b => blue && getComputedStyle(b).backgroundColor === blue).map(b => ({ text: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 40), h: Math.round(b.getBoundingClientRect().height) })),
    doneLike: all.filter(b => /^(Done|เสร็จสิ้น|Hide|ซ่อน)$/.test((b.textContent || '').trim()) || /^(Done|เสร็จสิ้น|Hide|ซ่อน)$/.test(b.getAttribute('aria-label') || '')).map(b => ({ text: b.textContent.trim(), aria: b.getAttribute('aria-label'), bg: getComputedStyle(b).backgroundColor })) };
}, refText.source);
/** Where the box and its keys are, against the scrolling part and the bar under it (SCRUM-894's measure). */
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
    field: [Math.round(f.top), Math.round(f.bottom)], keys: [Math.round(k.top), Math.round(k.bottom)], bar: b ? [Math.round(b.top), Math.round(b.bottom)] : null };
}, testId);
/** SCRUM-954 (4): the heights of the language button, the step pills and the bar's buttons on the display's form. */
S.touchSizes = page => page.evaluate(() => {
  const c = document.querySelector('[data-testid="display-consent"]') ?? document;
  const r1 = v => Math.round(v * 10) / 10;
  const sz = b => { const r = b.getBoundingClientRect(); return { text: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), h: r1(r.height), w: r1(r.width) }; };
  const lang = [...document.querySelectorAll('button')].find(b => /^(Change language|เปลี่ยนภาษา)$/.test(b.getAttribute('aria-label') || ''));
  const pills = [...(c.querySelector('[data-testid="consent-steps"]')?.querySelectorAll('button') ?? [])];
  const ask = [...c.querySelectorAll('button')].find(b => /^(Ask the team|ขอความช่วยเหลือจากทีมงาน)$/.test(b.textContent.trim()));
  const bar = ask ? [...ask.parentElement.querySelectorAll(':scope > button')] : [];
  const all = [lang && sz(lang), ...pills.map(sz), ...bar.map(sz)].filter(Boolean);
  return { viewport: `${innerWidth}x${innerHeight}`, language: lang ? sz(lang) : null, pills: pills.map(sz), bar: bar.map(sz), under44: all.filter(x => x.h < 44) };
});
/** Every visible touch target on a page smaller than `min` px in height or width. */
S.smallTargets = (page, min = 44, rootSel = null) => page.evaluate(({ min, rootSel }) => {
  const outs = [];
  const root = rootSel ? document.querySelector(rootSel) : document;
  if (!root) return outs;
  for (const el of root.querySelectorAll('button, [role="checkbox"], input, textarea, a, [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    const label = el.closest('label');
    const lr = label ? label.getBoundingClientRect() : null;
    const w = Math.max(r.width, lr?.width ?? 0), h = Math.max(r.height, lr?.height ?? 0);
    if (w < min || h < min) outs.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), text: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 50), w: Math.round(r.width), h: Math.round(r.height), withLabel: lr ? `${Math.round(lr.width)}x${Math.round(lr.height)}` : null });
  }
  return outs;
}, { min, rootSel });

// ---- the fit audit (SCRUM-884): what a person would see cut, spilling or scrolling sideways ----
S.fit = (page, rootSel = null) => page.evaluate((rootSel) => {
  const root = rootSel ? document.querySelector(rootSel) : document.body;
  if (!root) return { error: 'no root ' + rootSel };
  const vw = window.innerWidth, vh = window.innerHeight;
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
  const txt = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const r1 = v => Math.round(v * 10) / 10;
  const out = { viewport: [vw, vh], docScrollWidth: document.documentElement.scrollWidth, pageSideways: document.documentElement.scrollWidth > vw + 1, truncated: [], spill: [], outsideViewport: [], sidewaysScrollers: [], pastRightEdge: [] };
  for (const el of root.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const t = txt(el);
    if (t && cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.truncated.push({ tag: el.tagName, text: t.slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth });
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) out.sidewaysScrollers.push({ tag: el.tagName, cls: String(el.className).slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth, text: t.slice(0, 60) });
    if (el.children.length === 0 && t) { const r = el.getBoundingClientRect(); if (r.right > vw + 1) out.pastRightEdge.push({ text: t.slice(0, 70), right: r1(r.right) }); }
  }
  for (const b of root.querySelectorAll('button, [role="button"], a')) {
    if (!vis(b)) continue;
    const r = b.getBoundingClientRect();
    let worst = 0;
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { if (!w.currentNode.nodeValue.trim() || !vis(w.currentNode.parentElement)) continue; const rg = document.createRange(); rg.selectNodeContents(w.currentNode); for (const rr of rg.getClientRects()) worst = Math.max(worst, r.left - rr.left, rr.right - r.right, r.top - rr.top, rr.bottom - r.bottom); }
    if (worst > 1) out.spill.push({ text: txt(b).slice(0, 90), by: r1(worst), box: [r1(r.left), r1(r.top), r1(r.width), r1(r.height)] });
    if (r.right > vw + 1 || r.left < -1) out.outsideViewport.push({ text: txt(b).slice(0, 90), left: r1(r.left), right: r1(r.right) });
  }
  out.problems = out.pageSideways || out.truncated.length + out.spill.length + out.outsideViewport.length + out.sidewaysScrollers.length + out.pastRightEdge.length > 0;
  return out;
}, rootSel);
/** The innermost visible element whose text is `text`: its box, whether it is inside the window and whole. */
S.boxOf = (page, text, { exact = true } = {}) => page.evaluate(({ text, exact }) => {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const hit = e => exact ? norm(e.innerText) === text : norm(e.innerText).includes(text);
  const all = [...document.body.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && hit(e); });
  const el = all.find(e => ![...e.children].some(hit));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const r1 = v => Math.round(v * 10) / 10;
  const rg = document.createRange(); rg.selectNodeContents(el); const tr = rg.getBoundingClientRect();
  return { text: norm(el.innerText), box: [r1(r.left), r1(r.top), r1(r.width), r1(r.height)], textRight: r1(tr.right), insideWindowX: r.left >= -1 && r.right <= window.innerWidth + 1 && tr.right <= window.innerWidth + 1,
    whole: el.scrollWidth <= el.clientWidth + 1, ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 };
}, { text, exact });

// ---- till steps ----
S.halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
S.keypad = async (scope, digits, { tap = false } = {}) => { for (const d of digits) { const b = scope.getByRole('button', { name: d, exact: true }).last(); if (tap) await b.tap(); else await b.click(); } };
S.spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
/** The first screen on a surface (the paired display, or the till's own customer half), then walk-in on the till. */
S.firstScreen = async (surface, till, number, { lang = 'en', tap = false, walkIn = true } = {}) => {
  await S.landing(surface).waitFor({ timeout: 30000 });
  if (await surface.getByTestId('language-choice').isVisible()) { const b = surface.getByTestId(`language-choice-${lang}`); if (tap) await b.tap(); else await b.click(); }
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? S.halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await S.keypad(scope, number, { tap });
  const cont = scope.getByRole('button', { name: /^(Continue|ดำเนินการต่อ)$/ });
  if (tap) await cont.tap(); else await cont.click();
  if (!walkIn) return scope;
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
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
S.ticket = async (page, kids, adults, pkg = '1 Hour Play', go = true) => {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByRole('heading', { name: pkg, exact: true }).first().click();
  await S.quantity(page, 'Kids', kids); await S.quantity(page, 'Adults', adults);
  if (go) await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
};
/** The age picker: open it, read its look, optionally pick an age. */
S.pickerLook = page => page.evaluate(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  if (!d) return null;
  const cs = getComputedStyle(d);
  const btn = [...d.querySelectorAll('button')].find(b => /^\d+$/.test(b.textContent.trim()));
  const head = d.querySelector('h2, [id*="title"]') ?? d;
  return { dataSurface: d.getAttribute('data-surface'), darkClass: d.classList.contains('dark'), lightClass: d.classList.contains('light'), bg: cs.backgroundColor, color: getComputedStyle(head).color,
    ageButtonBg: btn ? getComputedStyle(btn).backgroundColor : null, ageButtonColor: btn ? getComputedStyle(btn).color : null, title: (d.querySelector('h2')?.textContent ?? '').trim().slice(0, 60) };
});
S.setAge = async (page, scope, age, { tap = false, read = false } = {}) => {
  const press = async l => { if (tap) await l.tap(); else await l.click(); };
  await press(scope.getByRole('button', { name: /Tap to set age|แตะเพื่อระบุอายุ/ }).last());
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor();
  await page.waitForTimeout(500);
  const look = read ? await S.pickerLook(page) : null;
  if (age == null) return look;
  await press(dialog.getByRole('button', { name: String(age), exact: true }));
  await page.waitForTimeout(400);
  await press(dialog.getByRole('button', { name: /^(Jan|ม\.ค\.)/ }).first());
  await page.waitForTimeout(400);
  await press(dialog.getByRole('button', { name: '1', exact: true }).first());
  await page.waitForTimeout(400);
  await press(dialog.getByRole('button', { name: /Confirm|ยืนยัน/ }));
  await dialog.waitFor({ state: 'hidden' });
  return look;
};
S.mirrorState = async till => {
  const m = till.getByTestId('consent-mirror');
  if (!(await m.count())) return { shown: false };
  const val = async l => (await l.count()) ? await l.first().inputValue().catch(() => null) : null;
  return { shown: true, childName: await val(m.getByTestId('consent-child-name')), allergies: await val(m.getByTestId('consent-allergies')),
    dietary: await val(m.getByTestId('consent-dietary')), guardian: await val(m.getByTestId('consent-guardian')) };
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
S.money = t => (S.flat(t).match(/[−-]?฿[0-9][0-9,]*(?:\.[0-9]+)?/g) ?? []);
/** The drop-off form on the till's customer half (no keyboard flag): names, ages, guardian, a photo each, every tick. */
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
  for (const box of await half.getByRole('checkbox').all()) if (await box.isEnabled() && (await box.getAttribute('data-state')) !== 'checked') await box.check();
  return half;
};
S.continueToPayment = async page => {
  const [registered] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST', { timeout: 60000 }),
    page.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  const reg = await registered.json().catch(() => null);
  assert.equal(registered.status(), 200, 'the registration is written');
  return reg;
};

// ---- the board ----
S.search = page => page.getByPlaceholder('Search child, parent or phone…');
S.tab = (page, tab) => page.getByRole('button', { name: new RegExp(`^${tab}\\s*\\d+$`) }).first();
S.searchBoard = async (page, q) => { await S.search(page).fill(q); await page.waitForTimeout(1200); };
S.releaseOwn = async (regId) => {
  const reg = await S.registration(regId);
  assert.ok(S.isZz(reg.guardianName) && reg.children.every(c => S.isZz(c.childName)), 'only this run\'s own booking');
  const done = [];
  for (const child of reg.children.filter(c => c.status === 'in_park')) {
    const file = await S.call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-954 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await S.call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await S.call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push({ child: child.childName, status: r.status });
  }
  return done;
};

// ---- setup: the numbers, the own till, the code ----
S.makeStation = async (label) => {
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z954${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const name = `ZZ TEST SCRUM-954 ${label} ${Date.now()}`;
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
  S.fixtureName = S.station.name;
  const existing = (await S.call('GET', '/menu/discounts?includeArchived=true')).body.discounts;
  S.CODE = Array.from({ length: 50 }, (_, i) => `ZZTEST954${String.fromCharCode(65 + (i % 26))}${i >= 26 ? 'X' : ''}`).find(c => !existing.some(d => d.code === c));
  const code = await S.call('POST', '/menu/discounts', { branchId: S.branchId, code: S.CODE, label: `ZZ TEST SCRUM-954 proof ${S.CODE}`, kind: 'percent', valueBp: 1000,
    validFrom: S.today, validUntil: S.today, usageLimit: 10, perCustomerLimit: null, stackable: false, active: true });
  assert.equal(code.status, 200, 'code made');
  S.codeId = code.body.id;
  S.receipt.created.push({ kind: 'promo-code', code: S.CODE, id: S.codeId, valueBp: 1000, usageLimit: 10, validOn: S.today }); S.save();
  return { free: unused.length, first: unused[0], last: unused.at(-1), station: S.station.id, prefix: S.station.codePrefix, code: S.CODE };
};

// ---- the OTO App (parties) ----
S.appSignIn = async () => {
  const appCtx = await S.browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  S.appCtx = appCtx;
  S.appCall = async (method, path, body) => { const r = await appCtx.request.fetch(S.APP + '/api' + path, { method, data: body, headers: method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() } }); return { status: r.status(), body: await r.json().catch(() => null) }; };
  assert.equal((await appCtx.request.post(S.LAUNCHER + '/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const hand = await (await appCtx.request.post(S.LAUNCHER + '/api/auth/handoff', { data: { app: 'oto_app' }, headers: { 'Idempotency-Key': randomUUID() } })).json();
  const appPage = await appCtx.newPage();
  const exchanged = appPage.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await appPage.goto(hand.launchUrl); await exchanged; await appPage.waitForURL(u => !u.hash.includes('handoff'), { timeout: 60000 });
  await appPage.close();
  return true;
};
S.makeParty = async (title, { deposit = 1000, startTime = '15:00', endTime = '18:00' } = {}) => {
  if (!S.appCtx) await S.appSignIn();
  const ev = await S.appCall('POST', '/admin/events', { eventType: 'birthday', title, branchId: S.APP_FLORESTA, eventDate: S.today, startTime, endTime, durationMinutes: 180, numChildren: 2, numAdults: 2, status: 'upcoming' });
  assert.equal(ev.status, 201);
  const id = ev.body.id;
  S.receipt.created.push({ kind: 'oto-app event', id, title }); S.save();
  const bill = await S.appCall('PUT', `/events/${id}/beo/billing`, { depositRequired: true, depositAmount: deposit, depositPaid: true, depositPaidAmount: deposit });
  const snap = await S.appCall('POST', `/beo/events/${id}/package-snapshot`, { templateId: S.FLORESTA_PACKAGE });
  return { id, bill: bill.status, snap: snap.status };
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
    appendFileSync(log, `\n=== ${at} ${S.phase ?? ''}\n${body.trim()}\n--> ${text.slice(0, 6000)}\n`);
    S.save();
    res.setHeader('content-type', 'application/json');
    res.end(text);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`driver ready on 127.0.0.1:${port}`));
