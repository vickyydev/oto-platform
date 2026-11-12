// SCRUM-857 parts 2-4 (with SCRUM-874 and SCRUM-875) staging proof, 12 November 2026; api, pos and pos-web at
// 6080dc815 (deploys.json). An interactive driver, as the SCRUM-909 run was driven: one browser (Edge, with Chromium's
// own generated fake camera, no person's picture) kept open, several contexts in it (the desk till, the paired
// display, a display with no camera, a display whose camera is refused), one step at a time. Steps are sent to a local
// port (127.0.0.1 only) as small async bodies that get the state object S; every step and its answer are appended to
// steps.log beside the receipt, so the run reads back in the order it was driven.
// Started from docs/qa/proof-2026-11-12/SCRUM-909/driver.mjs (masks, sign-in, clean-up) and the SCRUM-857 part 1
// harness (a display paired to the own till in a second context, the drop-off form reached from the display).
//
//   node driver.mjs [port]      then  POST http://127.0.0.1:<port>/run  with the step's body;  POST /quit  ends it.
//
// Own ZZ TEST till on the shared virtual box (virtual-1), ZZ TEST families with invented numbers (08985702xx, checked
// unused first). Cash only. Credentials are read by NAME through scripts/agent/env.mjs need() and never printed; staff
// names never enter the receipt or the log (scrubbed), and on the pictures the account corner, the password field,
// the pairing code, staff names and other families are masked.
//
// Run of 12 November 2026, 18:21-18:48 Bangkok (steps.log). Redefined from steps while it ran, so read steps.log for
// the exact code: S.pair with larger caption fonts (step "1: the family types"), S.keepAlive (a synthetic keydown on
// the till every 40 s, staff present at the counter, because the till locks itself after 2 minutes without a staff
// touch; paused on purpose for the lock hunt), S.masks also masking QR svgs (from point 10; the 10b picture's two
// credit QR codes were blacked out afterwards). After the first display context closed, the browser's generated fake
// camera answered NotReadableError in every context, so the browser was relaunched with a file-fed fake camera
// (generated colour bars, scratchpad camera-bars.y4m) and the till's storage state; family N's first sale was
// cancelled before anything was written. "Camera refused" is getUserMedia answering NotAllowedError through an init
// script: with --use-fake-ui-for-media-stream every context is granted the camera, a context without the grant too.
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
const port = Number(process.argv[2] ?? 47857);
const out = resolve(process.env.OUT_DIR ?? import.meta.dirname); // OUT_DIR: a second run writes its receipt and log in a folder of its own
mkdirSync(out, { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08985702' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
S.receipt = { tickets: ['SCRUM-857 parts 2-4', 'SCRUM-874', 'SCRUM-875'], sha: '6080dc81585e0ee8191fb98ca5848a97c4c1d2c1',
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  numbers: {}, created: [], points: {}, reads: {}, odd: [], pageErrors: [], requests: [], registrationsPosted: [], photoFiles: [], displayPhotoUploads: [], cleanup: {} };

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
S.scrub = text => {
  let t = String(text);
  for (const n of [...S.names].filter(s => s.length >= 3 && !/^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception)$/i.test(s)).sort((a, b) => b.length - a.length)) t = t.split(n).join('[staff]');
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

// ---- the browser: one, with Chromium's generated fake camera ----
S.browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(process.env.CAMERA_Y4M ? [`--use-file-for-fake-video-capture=${process.env.CAMERA_Y4M}`] : [])] });
S.pages = {};
S.watch = (page, label) => {
  page.on('pageerror', e => S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); });
};
/** What the till writes: every registration POST (status, replay, id) and every registration photo file. */
S.watchTill = page => {
  page.on('response', async r => {
    const u = new URL(r.url());
    if (r.request().method() !== 'POST') return;
    if (u.pathname === '/api/checkin/registrations') {
      const entry = { at: S.phase ?? null, status: r.status(), replay: r.headers()['x-oto-replay'] === 'true', id: null, finishedAt: new Date().toISOString() };
      S.receipt.registrationsPosted.push(entry);
      entry.id = (await r.json().catch(() => null))?.id ?? null;
      S.save();
    }
  });
  page.on('request', q => {
    const u = new URL(q.url());
    if (q.method() !== 'POST' || u.pathname !== '/api/files') return;
    let body = null; try { body = q.postDataJSON(); } catch { /* not json */ }
    if (body?.ownerEntityType === 'registration') { S.receipt.photoFiles.push({ at: S.phase ?? null, ownerEntityId: body.ownerEntityId, contentType: body.contentType }); S.save(); }
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
S.signIn = async (label, phoneKey, passwordKey, viewport, extra = {}) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'],
    ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), ...extra });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); S.watchTill(page); await page.goto(S.pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: S.fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } } else if (await page.locator('a[href="/history"]').first().isVisible()) break; await page.waitForTimeout(500); }
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  walkNames(me);
  assert.ok(JSON.stringify(me).includes(S.station.id), 'signed in at the own ZZ TEST till');
  S.pages[label] = { ctx, page, passwordKey };
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
/** camera: 'fake' (permission granted), 'nopermission' (no grant, nothing faked), 'refused' (getUserMedia answers NotAllowedError), 'none' (no video device). */
S.pairDisplay = async (label, { camera = 'fake', viewport = { width: 1024, height: 900 } } = {}) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', ...(camera === 'fake' ? { permissions: ['camera'] } : {}) });
  ctx.setDefaultTimeout(30000);
  if (camera === 'none') await ctx.addInitScript(NO_CAMERA);
  if (camera === 'refused') await ctx.addInitScript(REFUSED);
  const page = await ctx.newPage(); S.watch(page, `display-${label}`); S.watchDisplay(page, label);
  await page.goto(`${S.pos}/display`);
  await page.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
  assert.match(pairingCode, /^\d{6}$/);
  const paired = await S.call('POST', `/stations/${S.station.id}/displays/claim`, { pairingCode, name: `${S.fixtureName} display ${label}` });
  assert.equal(paired.status, 200);
  S.displays[label] = { ctx, page, id: paired.body.device.id, revoked: false, camera };
  S.receipt.created.push({ kind: 'display', label, id: paired.body.device.id, camera }); S.save();
  await S.landing(page).waitFor({ timeout: 60000 });
  return page;
};
S.dropDisplay = async (label, reason = 'ZZ TEST SCRUM-857 parts 2-4 proof step complete') => {
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
  const zzText = ['zz test', S.fixtureName ?? '', ...board.families.filter(S.familyAllZz).flatMap(f => [f.guardianName, ...f.children.map(c => c.childName)])].join(' | ').toLowerCase();
  const inZz = s => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u').test(zzText);
  S.hidden = [...keep].filter(s => s.length >= 2 && !inZz(s)).sort((a, b) => b.length - a.length);
  return board;
};
S.deskCards = page => page.locator('div.grid.gap-3 > div[class*="bg-card/50"]');
S.masks = page => {
  const staff = [...S.names].filter(s => s.length >= 3 && !/^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception)$/i.test(s));
  const all = [...S.hidden, ...staff].filter(Boolean);
  const re = all.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${all.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  return [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
    page.getByTestId('display-pairing-code'), page.getByText(/^QR-[A-Z0-9]+$/),
    S.deskCards(page).filter({ hasNotText: 'ZZ TEST' }),
    page.getByText(/^(Nannies free now|Free nannies):/),
    ...(re ? [S.deskCards(page).filter({ hasText: re }), page.getByText(re)] : [])];
};
S.shots = [];
S.shot = async (page, name, extra = [], opts = {}) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', ...opts, mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
  S.shots.push(name);
  return name;
};
/** Two pages side by side in one picture, taken at the same moment: the till on the left, the display on the right. */
S.pair = async (name, left, right, extra = {}) => {
  const [a, b] = await Promise.all([
    left.screenshot({ animations: 'disabled', mask: [...S.masks(left), ...(extra.left ?? [])], maskColor: '#18181b' }),
    right.screenshot({ animations: 'disabled', mask: [...S.masks(right), ...(extra.right ?? [])], maskColor: '#18181b' }),
  ]);
  const page = await S.browser.newPage({ viewport: { width: 2400, height: 1100 } });
  const img = buf => `data:image/png;base64,${buf.toString('base64')}`;
  await page.setContent(`<html><body style="margin:0;background:#111;color:#eee;font-family:Segoe UI,Arial">
    <div style="padding:6px 10px;font-size:14px">${(extra.caption ?? '').replace(/[<>&]/g, '')} — taken ${new Date().toISOString()}</div>
    <div style="display:flex;gap:8px;align-items:flex-start;padding:0 8px 8px">
      <figure style="margin:0;flex:1.62"><figcaption style="font-size:13px;padding:2px 0">Till (desk, 1680×1050)</figcaption><img style="width:100%;border:1px solid #444" src="${img(a)}"></figure>
      <figure style="margin:0;flex:1"><figcaption style="font-size:13px;padding:2px 0">Customer display (own context)</figcaption><img style="width:100%;border:1px solid #444" src="${img(b)}"></figure>
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
    <p style="margin:0 0 10px;color:#555;font-size:13px">Read ${e(new Date().toISOString())} from ${e(S.pos)} (staging, at 6080dc815), the staging admin's own session. ZZ TEST values only.</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td><b>${e(k)}</b></td><td style="font-family:Consolas,monospace">${e(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('')}</table></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  S.shots.push(name);
  return name;
};

// ---- till steps ----
S.halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
S.keypad = async (scope, digits) => { for (const d of digits) await scope.getByRole('button', { name: d, exact: true }).last().click(); };
S.spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
/** The first screen on a surface (the paired display, or the till's own customer half), then walk-in on the till. */
S.firstScreen = async (surface, till, number, { channel = null, lang = 'en' } = {}) => {
  await S.landing(surface).waitFor({ timeout: 30000 });
  if (await surface.getByTestId('language-choice').isVisible()) await surface.getByTestId(`language-choice-${lang}`).click();
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? S.halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await S.keypad(scope, number);
  if (channel) await scope.getByTitle(channel, { exact: true }).click();
  await scope.getByRole('button', { name: /^(Continue|ดำเนินการต่อ)$/ }).click();
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
S.setAge = async (page, scope, age) => {
  await scope.getByRole('button', { name: /Tap to set age|แตะเพื่อระบุอายุ/ }).last().click();
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: String(age), exact: true }).click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /^(Jan|ม\.ค\.)/ }).first().click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: '1', exact: true }).first().click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /Confirm|ยืนยัน/ }).click();
  await dialog.waitFor({ state: 'hidden' });
};
S.setNumber = async (scope, number) => {
  const tel = scope.locator('input[type="tel"]');
  if (await tel.count()) { await tel.first().fill(number.replace(/^0/, '')); return 'typed'; }
  await scope.getByRole('button', { name: 'Clear', exact: true }).last().click();
  await S.keypad(scope, number.replace(/^0/, ''));
  return 'keypad';
};
/** What the till's copy of the family's form shows right now. */
S.mirrorState = async till => {
  const m = till.getByTestId('consent-mirror');
  if (!(await m.count())) return { shown: false };
  const val = async l => (await l.count()) ? await l.first().inputValue().catch(() => null) : null;
  const steps = await m.getByTestId('consent-steps').locator('button').evaluateAll(bs => bs.map(b => ({ text: b.textContent.trim(), current: b.className.includes('bg-primary') })));
  return { shown: true, status: S.flat(await m.getByTestId('consent-mirror-status').innerText().catch(() => '')),
    step: steps.find(s => s.current)?.text ?? null,
    childName: await val(m.getByPlaceholder('Full name', { exact: true })),
    childAge: S.flat(await m.getByRole('button', { name: /Tap to set age|years|yrs|\d/ }).first().innerText().catch(() => '')).slice(0, 60),
    guardian: await val(m.locator('#public-consent-guardian')),
    phone: await val(m.locator('input[type="tel"]')),
    photoImg: await m.getByTestId('consent-mirror-photo').locator('img').count() ? (await m.getByTestId('consent-mirror-photo').locator('img').getAttribute('src'))?.slice(0, 30) : null,
    photoReceived: await m.getByTestId('consent-photo-received').count(),
    inert: await m.evaluate(e => e.hasAttribute('inert')) };
};
S.displayState = async page => {
  const c = page.getByTestId('display-consent');
  if (!(await c.count())) return { shown: false };
  const val = async l => (await l.count()) ? await l.first().inputValue().catch(() => null) : null;
  const steps = await c.getByTestId('consent-steps').locator('button').evaluateAll(bs => bs.map(b => ({ text: b.textContent.trim(), current: b.className.includes('bg-primary') })));
  const done = c.getByRole('button', { name: /^(Done|เสร็จสิ้น)$/ });
  return { shown: true, step: steps.find(s => s.current)?.text ?? null,
    childName: await val(c.getByPlaceholder(/Full name|ชื่อ-นามสกุล/)),
    guardian: await val(c.locator('#public-consent-guardian')),
    phone: await val(c.locator('input[type="tel"]')),
    missing: (await c.getByTestId('consent-missing').count()) ? S.flat(await c.getByTestId('consent-missing').innerText()) : null,
    finished: (await c.getByTestId('consent-finished').count()) ? S.flat(await c.getByTestId('consent-finished').innerText()) : null,
    notSaved: (await c.getByTestId('consent-not-saved').count()) ? S.flat(await c.getByTestId('consent-not-saved').innerText()) : null,
    photoFallback: (await c.getByTestId('consent-photo-fallback').count()) ? S.flat(await c.getByTestId('consent-photo-fallback').innerText()) : null,
    photoReceived: (await c.getByTestId('consent-photo-received').count()) ? S.flat(await c.getByTestId('consent-photo-received').innerText()) : null,
    doneShown: await done.count(), doneEnabled: (await done.count()) ? await done.first().isEnabled() : null };
};
S.staffLine = async till => (await till.getByTestId('consent-staff-status').count()) ? S.flat(await till.getByTestId('consent-staff-status').innerText()) : null;
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
S.regsByGuardian = async guardian => ((await S.call('GET', `/checkin/registrations?branchId=${S.branchId}`)).body?.registrations ?? []).filter(r => r.guardianName === guardian);

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
    const file = await S.call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-857 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await S.call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await S.call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push({ child: child.childName, status: r.status });
  }
  for (const child of reg.children.filter(c => c.status === 'registered')) {
    const r = await S.call('POST', `/checkin/registrations/${regId}/cancel`, { reason: 'ZZ TEST SCRUM-857 parts 2-4 proof cleanup' });
    done.push({ cancelWaiting: true, status: r.status, code: r.body?.error?.code ?? null });
    break;
  }
  return done;
};

// ---- setup: the numbers, the own till ----
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
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
  S.devices = devices;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z857${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  S.fixtureName = `ZZ TEST SCRUM-857 p2-4 proof till ${Date.now()}`;
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name: S.fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200);
  S.station = made.body.station;
  S.receipt.created.push({ kind: 'station', id: S.station.id, name: S.fixtureName, prefix }); S.save();
  return { free: unused.length, first: unused[0], last: unused.at(-1), station: S.station.id, prefix };
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
    appendFileSync(log, `\n=== ${at} ${S.phase ?? ''}\n${body.trim()}\n--> ${text.slice(0, 4000)}\n`);
    S.save();
    res.setHeader('content-type', 'application/json');
    res.end(text);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`driver ready on 127.0.0.1:${port}`));
