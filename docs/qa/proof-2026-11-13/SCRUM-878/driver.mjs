// SCRUM-878 staging proof, 13 November 2026 (Bangkok): a staff session that ends during a long shift keeps the sale and
// says what happened. api, pos-web and pos at f0a47eb79 (deploys.json). An interactive driver started from the SCRUM-954
// and SCRUM-884 drivers (docs/qa/proof-2026-11-12/SCRUM-954|884/driver.mjs): an own ZZ TEST till on the shared virtual
// box (virtual-1), a ZZ TEST counter display paired to it through the admin API, the desk till (1680 x 1050) and the
// phone till (390 x 844).
//
//   node driver.mjs [port]      then  POST http://127.0.0.1:<port>/run  with the step's body (curl --data-binary @file);
//                               POST /quit  ends it (closes the one browser).
//
// TWO LOGIN USERS USED ONLY FOR THIS PROOF ("ZZ TEST Session A" and "ZZ TEST Session B", reception at the park), made
// through the platform's own admin routes with the staging admin's session: POST /accounts (the Console's Login Users
// "Add login user": phone, employee name, the reception role scoped to the branch), POST /accounts/:id/temp-password
// (the Login Users "Temporary password", no SMS), then each signs in once with it and sets its own password through
// POST /auth/change-password. Their numbers are POSSIBLE but NOT VALID Thai numbers (+66 2 9887 89xx: a nine-digit
// national number starting with 2 is no Bangkok line), checked unused first, so the setup code POST /accounts sends can
// reach nobody. The temporary and the final passwords are generated here and live only in this process's memory (a
// closure the steps cannot return); they are never printed, logged, saved or drawn (password boxes are masked and
// every written text is scrubbed of them). A session is ended ONLY with POST /accounts/<A or B>/sessions/revoke ("Sign
// out everywhere") from the admin session; S.revoke refuses any other account.
//
// One headless Edge with a generated grey camera frame; contexts opened and closed as the steps need them. Cash, the
// gateway simulator (only when staging runs it) or 0 only. Credentials of the shared admin and manager are read by NAME
// through scripts/agent/env.mjs need() and never printed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const pw = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const { chromium, request, expect } = pw;
const port = Number(process.argv[2] ?? 47878);
const out = resolve(import.meta.dirname);
mkdirSync(out, { recursive: true });
const scratch = process.env.ZZ_SCRATCH ?? resolve(out, '.scratch');
mkdirSync(scratch, { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, need };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.sha = 'f0a47eb792c4f78248bc8a5924286215687f9529';
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08988780' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(out, 'deploys.json');
S.receipt = { ticket: 'SCRUM-878', sha: S.sha,
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  accounts: {}, numbers: {}, created: [], points: {}, reads: {}, odd: [], defects: [], hunt: [], pageErrors: [], requests: [], revokes: [], cleanup: {} };
if (process.env.ZZ_RESUME === '1' && existsSync(resolve(out, 'receipt.json'))) {
  const before = JSON.parse(readFileSync(resolve(out, 'receipt.json'), 'utf8'));
  S.receipt = { ...S.receipt, ...before, resumedAt: [...(before.resumedAt ?? []), new Date().toISOString()] };
}
process.on('unhandledRejection', e => { try { S.receipt.odd.push({ what: 'unhandled rejection in a step (logged, driver kept)', text: S.scrub(String(e?.message ?? e).split('\n')[0].slice(0, 200)) }); } catch {} });

// ---- secrets: memory only, in this closure; every written text is scrubbed of them ----
const secrets = new Map(); // who -> { password }
const secretValues = () => [...secrets.values()].flatMap(v => [v.password, v.temp]).filter(Boolean);
// ---- staff names that are not ZZ TEST: memory only, scrubbed from everything written ----
S.names = new Set();
const NOT_NAMES = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Central|Floresta|Branch|Admin|Staff|Party|Oto|Park|Play|Staging|Session)$/i;
S.scrub = text => {
  let t = String(text);
  for (const v of secretValues()) t = t.split(v).join('[secret]');
  for (const n of [...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s)).sort((a, b) => b.length - a.length)) t = t.split(n).join('[staff]');
  return t;
};
S.save = () => writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
S.point = (key, pass, pictures, seen) => { S.receipt.points[key] = { pass, pictures, seen }; S.save(); return { key, pass }; };
S.odd = (what, extra = {}) => { S.receipt.odd.push({ what, ...extra }); S.save(); };

// ---- the admin api ----
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

// ---- the two proof accounts ----
S.acct = {}; // who -> { id, phone, local, name }
const ACCOUNT_NUMBERS = ['0298878901', '0298878902', '0298878903', '0298878904', '0298878905', '0298878906'];
S.makeAccounts = async () => {
  const outA = {};
  const all = (await S.call('GET', '/accounts')).body.accounts;
  const free = [];
  for (const n of ACCOUNT_NUMBERS) {
    const e164 = '+66' + n.slice(1);
    const usedByAccount = all.some(a => a.phone === e164);
    const member = (await S.call('GET', `/members/lookup?phone=${n}`)).body?.member ?? null;
    if (!usedByAccount && !member) free.push(n);
  }
  S.receipt.accounts.numbersChecked = { candidates: ACCOUNT_NUMBERS.length, unused: free.length, accountsListed: all.length };
  assert.ok(free.length >= 2, 'two unused numbers');
  for (const [who, name, n] of [['A', 'ZZ TEST Session A', free[0]], ['B', 'ZZ TEST Session B', free[1]]]) {
    const made = await S.call('POST', '/accounts', { phone: n, employeeName: name, roles: [{ roleName: 'reception', scopeType: 'branch', scopeId: S.branchId }] });
    assert.equal(made.status, 200, `account ${who} made`);
    const id = made.body.id;
    S.acct[who] = { id, local: n, phone: '+66' + n.slice(1), name };
    S.receipt.created.push({ kind: 'login user', who, id, name, phone: S.acct[who].phone, statusAtCreate: made.body.status, codeSent: made.body.codeSent ?? null, warning: made.body.warning?.code ?? null }); S.save();
    // The Login Users panel's "Temporary password": no SMS; forces a change at the first sign-in.
    const temp = await S.admin.fetch(`/api/accounts/${id}/temp-password`, { method: 'POST', headers: { 'idempotency-key': randomUUID() } });
    assert.equal(temp.status(), 200, `temporary password for ${who}`);
    const tempPassword = (await temp.json()).temporaryPassword;
    const finalPassword = randomBytes(15).toString('base64url') + 'Zz9';
    secrets.set(who, { temp: tempPassword, password: finalPassword });
    S.receipt.requests.push({ method: 'POST', path: '/accounts/:id/temp-password', status: temp.status() });
    // The person's own first sign-in and password change, through the platform's own routes.
    const ctx = await request.newContext({ baseURL: S.pos });
    const si = await ctx.post('/api/auth/sign-in', { data: { phone: n, password: tempPassword } });
    const siBody = await si.json().catch(() => null);
    const ch = await ctx.post('/api/auth/change-password', { data: { currentPassword: tempPassword, password: finalPassword }, headers: { 'idempotency-key': randomUUID() } });
    const so = await ctx.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
    await ctx.dispose();
    secrets.get(who).temp = null;
    const perms = await S.call('GET', `/accounts/${id}/permissions`);
    const row = (await S.call('GET', `/accounts?q=${n.slice(1)}`)).body.accounts.find(a => a.id === id);
    outA[who] = { id, signInWithTemporary: si.status(), mustChangeAtFirst: siBody?.account?.mustChangePassword ?? siBody?.mustChangePassword ?? null, changePassword: ch.status(), signOut: so.status(),
      status: row?.status, mustChangePassword: row?.mustChangePassword, assignments: perms.body.assignments.map(a => `${a.roleName} ${a.scopeType} ${a.scopeId === S.branchId ? 'park' : a.scopeId}`),
      holdsSaleCreate: perms.body.effective.some(e => e.permission === 'pos:sale:create' && e.scopeId === S.branchId) };
  }
  S.receipt.accounts.made = outA; S.save();
  return outA;
};
/** "Sign out everywhere" for A or B only, from the admin session, with an Idempotency-Key. */
S.revoke = async who => {
  assert.ok(who === 'A' || who === 'B', 'only the two proof accounts');
  const a = S.acct[who];
  assert.ok(a && S.isZz(a.name), 'a ZZ TEST proof account');
  const r = await S.call('POST', `/accounts/${a.id}/sessions/revoke`);
  assert.equal(r.status, 200, 'revoked');
  const at = new Date();
  S.receipt.revokes.push({ who, at: at.toISOString(), sessionsEnded: r.body.sessionsEnded, phase: S.phase ?? null }); S.save();
  return { who, sessionsEnded: r.body.sessionsEnded, at: at.toISOString() };
};
/** Type the person's password into a password box (never read back, never returned). */
S.typePassword = async (locator, who) => { await locator.fill(secrets.get(who).password); };
/** A request context signed in as A or B, for reads at their own session (sales list, /me). */
S.apiAs = async who => {
  const ctx = await request.newContext({ baseURL: S.pos });
  const r = await ctx.post('/api/auth/sign-in', { data: { phone: S.acct[who].local, password: secrets.get(who).password } });
  return { ctx, status: r.status() };
};
/** The cleanup's read back: a sign-in attempt with the person's own password, status and error code only. */
S.trySignIn = async who => {
  const ctx = await request.newContext({ baseURL: S.pos });
  const r = await ctx.post('/api/auth/sign-in', { data: { phone: S.acct[who].local, password: secrets.get(who).password } });
  const b = await r.json().catch(() => null);
  if (r.status() === 200) await ctx.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } }).catch(() => {});
  await ctx.dispose();
  return { status: r.status(), code: b?.error?.code ?? null, message: b?.error?.message ?? null };
};

// ---- the browser: one, headless, a generated grey camera frame ----
const video = resolve(scratch, 'camera.y4m');
const W = 320, H = 240;
writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(W * H, 150), Buffer.alloc(W * H / 2, 128)]));
S.browser = null;
S.launch = async () => {
  if (S.browser) return 'already';
  S.browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  return 'launched';
};
S.pages = {};
S.watch = (page, label) => {
  page.on('pageerror', e => S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: S.scrub(String(e.message).split('\n')[0].slice(0, 240)) }));
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); });
};
S.landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2 && !S.isZz(v)) { S.names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.length >= 3) S.names.add(p); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
S.walkNames = walkNames;
S.picker = page => page.getByRole('heading', { name: 'Which station are you on?' });
/** A new till context at the sign-in form (no one signed in yet). */
S.openTill = async (label, viewport) => {
  await S.launch();
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'],
    ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label);
  page.on('request', q => { if (q.method() === 'PUT' && new URL(q.url()).pathname === '/api/me/session/station') (S.picks ??= []).push({ label, at: new Date().toISOString() }); });
  await page.goto(S.pos);
  await page.getByRole('heading', { name: 'Oto POS is locked' }).waitFor({ timeout: 60000 });
  S.pages[label] = { ctx, page, viewport };
  return page;
};
/** The sign-in form as the lock screen draws it: phone, password, Sign in; the status of /auth/sign-in. */
S.formSignIn = async (page, who) => {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(S.acct[who].local);
  await S.typePassword(page.locator('input[type="password"]').first(), who);
  const [resp] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/sign-in' && r.request().method() === 'POST', { timeout: 45000 }),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  return resp.status();
};
/** After a sign-in: pick the own station if the picker asks; report whether it asked. */
S.afterSignIn = async (page, station = S.station, { wait = 60000 } = {}) => {
  const deadline = Date.now() + wait;
  let asked = false;
  while (Date.now() < deadline) {
    if (await S.picker(page).isVisible().catch(() => false)) { asked = true; const pick = page.getByRole('button', { name: station.name, exact: false }).first(); if (await pick.isVisible().catch(() => false)) { await pick.click(); break; } }
    else if (await page.locator('a[href="/history"]').first().isVisible().catch(() => false)) break;
    else if (await page.getByRole('heading', { name: 'A sale is open on this till' }).isVisible().catch(() => false)) break;
    else if (await page.getByRole('button', { name: /^Open cart/ }).isVisible().catch(() => false)) break;
    await page.waitForTimeout(400);
  }
  return { pickerAsked: asked };
};
S.me = page => page.evaluate(async () => { const r = await fetch('/api/me', { credentials: 'include' }); return { status: r.status, body: r.status === 200 ? await r.json() : null }; });
/** The till's heartbeat, sent now: the context goes offline and online again (the heartbeat listens for 'online'). */
S.kick = async (label, { wait = 25000 } = {}) => {
  const t = S.pages[label];
  const refused = t.page.waitForResponse(r => new URL(r.url()).pathname === '/api/me/station/heartbeat', { timeout: wait }).then(r => r.status()).catch(() => null);
  await t.ctx.setOffline(true); await t.page.waitForTimeout(600); await t.ctx.setOffline(false);
  return { heartbeat: await refused };
};
S.endedLine = page => page.getByTestId('lock-session-ended');
S.familyLine = page => page.getByTestId('lock-family-form');
S.waitEnded = async (page, ms = 70000) => { await S.endedLine(page).waitFor({ timeout: ms }); await page.waitForTimeout(800); return S.flat(await S.endedLine(page).innerText()); };
S.bodyText = page => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
/** What a person can read on the page, and whether the cart's words or any amount are among it. */
S.readLock = async (page, words = ['2 Hours Play', '1 Hour Play']) => {
  const text = await S.bodyText(page);
  const html = await page.content();
  return { text: S.scrub(text).slice(0, 600), saleWordsInText: words.filter(w => text.includes(w)), saleWordsInHtml: words.filter(w => html.includes(w)), amountInText: /฿\s?\d/.test(text), payButton: await page.getByRole('button', { name: /^Pay ฿/ }).count(),
    stillSignedIn: text.includes('still signed in'), notSignedIn: /Not signed in/.test(text), heading: S.flat(await page.locator('h1').first().innerText().catch(() => '')) };
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
S.alive = label => S.pages[label]?.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))).catch(() => null);
S.keepAlive = on => { clearInterval(S.aliveTimer); S.aliveTimer = null; if (on) S.aliveTimer = setInterval(() => { for (const l of Object.keys(S.pages)) S.alive(l); }, 40000); return on; };

// ---- displays: each in its own context, paired to the own till through the admin api ----
S.displays = {};
S.pairDisplay = async (label, { viewport = { width: 600, height: 1024 }, query = '?keyboard=screen', station = S.station } = {}) => {
  await S.launch();
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, hasTouch: true, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, `display-${label}`);
  await page.goto(`${S.pos}/display${query}`);
  await page.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
  assert.match(pairingCode, /^\d{6}$/);
  const paired = await S.call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: `ZZ TEST SCRUM-878 display ${label}` });
  assert.equal(paired.status, 200);
  S.displays[label] = { ctx, page, id: paired.body.device.id, revoked: false };
  S.receipt.created.push({ kind: 'display', label, id: paired.body.device.id, station: station.id }); S.save();
  await page.getByTestId('display-pairing-code').waitFor({ state: 'detached', timeout: 60000 });
  return page;
};
S.dropDisplay = async (label, reason = 'ZZ TEST SCRUM-878 proof step complete') => {
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

// ---- masks: password boxes, the pairing code, QR canvases, other people's sales; staff names that are not ZZ TEST ----
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
S.esc = esc;
S.otherSales = page => page.locator('div.space-y-2 > button.w-full.text-left:not([data-zz]):not([role="dialog"] *)');
S.markMine = (page, list) => page.evaluate((list) => {
  for (const b of document.querySelectorAll('div.space-y-2 > button.w-full.text-left')) { const t = b.innerText.replace(/\s+/g, ' '); if (list.some(r => t.includes(r))) b.setAttribute('data-zz', 'mine'); else b.removeAttribute('data-zz'); }
}, list);
S.needles = () => [...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s)).filter(Boolean);
S.inPlace = page => [S.otherSales(page)];
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
  await sheet.setContent(`<html><body style="margin:0;background:#fff;font:15px system-ui;color:#111"><div style="padding:8px 12px"><b>SCRUM-878</b> · ${e(caption)} · captured together at ${when} Bangkok</div><div style="display:flex;gap:10px;padding:0 10px 10px;align-items:flex-start"><figure style="margin:0;flex:${opts.leftFlex ?? lv.width}"><figcaption style="font-size:13px;margin-bottom:3px">${e(opts.leftLabel ?? `Till (${lv.width}×${lv.height})`)}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${a.toString('base64')}"></figure><figure style="margin:0;flex:${opts.rightFlex ?? rv.width}"><figcaption style="font-size:13px;margin-bottom:3px">${e(opts.rightLabel ?? `Paired ZZ TEST counter display (${rv.width}×${rv.height})`)}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${b.toString('base64')}"></figure></div></body></html>`);
  await sheet.screenshot({ path: resolve(out, name), fullPage: true });
  await sheet.close();
  S.shots.push(name);
  return name;
};
/** A picture of read-back facts: a plain table, rendered in its own page. */
S.facts = async (name, title, rows) => {
  const page = await S.browser.newPage({ viewport: { width: 1300, height: 300 } });
  const e = s => S.scrub(String(s ?? 'null')).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:16px;background:#fff;color:#111"><h3 style="margin:0 0 8px">${e(title)}</h3>
    <p style="margin:0 0 10px;color:#555;font-size:13px">Read ${e(new Date().toISOString())} from ${e(S.pos)} (staging, api, pos-web and pos at f0a47eb79). ZZ TEST values only.</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td><b>${e(k)}</b></td><td style="font-family:Consolas,monospace">${e(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('')}</table></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await page.close();
  S.shots.push(name);
  return name;
};

// ---- till steps ----
S.halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
S.keypad = async (scope, digits, { tap = false } = {}) => { for (const d of digits) { const b = scope.getByRole('button', { name: d, exact: true }).last(); if (tap) await b.tap(); else await b.click(); } };
S.spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
/** The first screen on a surface (the paired display, or the till's own customer half), then walk-in on the till. */
S.firstScreen = async (surface, till, number, { lang = 'en', tap = false, walkIn = true, press = true } = {}) => {
  await S.landing(surface).waitFor({ timeout: 30000 });
  if (await surface.getByTestId('language-choice').isVisible()) { const b = surface.getByTestId(`language-choice-${lang}`); if (tap) await b.tap(); else await b.click(); }
  await surface.getByTestId('identify-safety').waitFor();
  const scope = surface === till ? S.halfOf(surface.getByTestId('identify-safety')) : surface.locator('body');
  await S.keypad(scope, number, { tap });
  if (!press) return scope;
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
S.ticket = async (page, kids, adults, pkg = '2 Hours Play', go = false) => {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByRole('heading', { name: pkg, exact: true }).first().click();
  await page.getByRole('heading', { name: /^Configure:/ }).first().waitFor({ timeout: 20000 });
  await S.quantity(page, 'Kids', kids); await S.quantity(page, 'Adults', adults);
  if (go) await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
};
/** What the till shows of the sale: step heading, the order panel's words, the Pay button. */
S.cartState = async page => {
  const configure = await page.getByRole('heading', { name: /^Configure:/ }).first().innerText().catch(() => null);
  const pay = await page.getByRole('button', { name: /^Pay ฿/ }).first().innerText().catch(() => null);
  const kids = await page.getByRole('button', { name: 'Add one Kids', exact: true }).first().locator('xpath=preceding-sibling::span[1]').textContent({ timeout: 2000 }).catch(() => null);
  const adults = await page.getByRole('button', { name: 'Add one Adults', exact: true }).first().locator('xpath=preceding-sibling::span[1]').textContent({ timeout: 2000 }).catch(() => null);
  const panel = await page.evaluate(() => { const h = [...document.querySelectorAll('h2,h3')].find(x => /Current Order/.test(x.textContent)); let el = h; for (let i = 0; i < 4 && el && el.innerText.length < 60; i++) el = el.parentElement; return el ? el.innerText.replace(/\s+/g, ' ').trim().slice(0, 500) : null; });
  const membership = await page.getByText('Membership Check', { exact: true }).count();
  const payment = await page.getByTestId('payment-step').count();
  return { configure: configure && S.flat(configure), pay: pay && S.flat(pay), kids, adults, panel: panel && S.scrub(panel), membershipCheck: membership > 0, paymentStep: payment > 0, url: new URL(page.url()).pathname };
};
S.stationSales = async (station = S.station) => (await S.call('GET', `/sales?branchId=${S.branchId}&stationId=${station.id}&limit=50`)).body.sales;
S.knownSales = new Set();
S.sale = async id => (await S.call('GET', `/sales/${id}`)).body;
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
/** Pay pressed; a walk-in may hand the display over for a number first (Done hands it back). */
S.pressPay = async page => {
  await page.getByRole('button', { name: /^Pay ฿/ }).first().click();
  const done = page.getByRole('button', { name: 'Done', exact: true });
  const due = page.getByRole('heading', { name: 'Amount Due' });
  await expect.poll(async () => (await done.isVisible()) || (await due.isVisible()), { timeout: 30000 }).toBe(true);
  if (await done.isVisible()) await done.click();
  await due.waitFor({ timeout: 30000 });
};

// ---- setup: numbers, the own till(s) ----
S.makeStation = async (label, paymentRouting = { card: 'manual', qr: 'none' }) => {
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z878${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const name = `ZZ TEST SCRUM-878 ${label} ${Date.now()}`;
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name, kind: 'till', boxId: S.box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting, capabilities: [], devices: S.devices });
  assert.equal(made.status, 200);
  const station = { ...made.body.station, name };
  S.receipt.created.push({ kind: 'station', id: station.id, name, prefix, paymentRouting }); S.save();
  (S.stations ??= []).push(station);
  return station;
};
S.setup = async () => {
  const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box online');
  S.box = { id: box.id, slot: box.slot, role: box.role };
  const unused = [];
  for (let i = 10; i < 40; i++) {
    const n = S.zz(i);
    const m = (await S.call('GET', `/members/lookup?phone=${n}`)).body?.member ?? null;
    if (!m) unused.push(n);
  }
  S.receipt.checks = { walkInNumbersCheckedUnused: unused.length, first: unused[0], last: unused.at(-1) };
  S.free = unused;
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(r => s.devices.some(d => d.role === r)));
  assert.ok(source, 'simulated printers configured');
  S.devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
  // Which QR gateway this deployment runs: only the provider's name and whether the simulator can be driven are kept.
  const gw = await S.call('GET', '/webhooks/2c2p/simulator');
  S.gateway = { status: gw.status, provider: gw.body?.provider ?? null, simulatorAvailable: gw.body?.simulatorAvailable ?? null, fellBack: gw.body?.fellBack ?? null };
  S.receipt.reads.gateway = S.gateway; S.save();
  const qr = S.gateway.provider === 'simulator' && S.gateway.simulatorAvailable ? 'gateway' : 'none';
  S.station = await S.makeStation('desk till', { card: 'manual', qr });
  return { free: unused.length, first: unused[0], station: S.station.id, prefix: S.station.codePrefix, gateway: S.gateway, qr };
};
S.nextNumber = () => { const n = S.free.shift(); (S.receipt.numbers.used ??= []).push(n); S.save(); return n; };

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
    appendFileSync(log, S.scrub(`\n=== ${at} ${S.phase ?? ''}\n${body.trim()}\n--> ${text.slice(0, 6000)}\n`));
    S.save();
    res.setHeader('content-type', 'application/json');
    res.end(text);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`driver ready on 127.0.0.1:${port}`));
