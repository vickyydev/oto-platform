// SCRUM-982 and scoped SCRUM-981 native staging proof. Adapted from the
// committed SCRUM-964 driver; new stations, sales, display and family numbers.
// Exactly two retired ZZ TEST964 staff accounts may be reused after verifying
// their committed IDs, names, phones, inactivity and absence of live sessions.
// Staging SMS_ADAPTER is Twilio: this driver never invokes POST /accounts.
// Temporary passwords and final passwords stay only in this process's closure.
// Run with exact S982_SHA; POST step source to localhost:47982/run, /quit closes.
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
const port = Number(process.argv[2] ?? 47982);
const out = resolve(import.meta.dirname);
mkdirSync(out, { recursive: true });
const scratch = 'C:/oto-lanes/audit-takeover-20261113/982-runtime';
mkdirSync(scratch, { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, scratch, need, readFileSync, writeFileSync, existsSync };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.LAUNCHER = 'https://oto-launcher-staging.onrender.com';
S.APP = 'https://oto-app-staging.onrender.com';
S.APP_FLORESTA = '6427e84d-723f-4dbd-be58-8ef89cf7dc99';
S.FLORESTA_PACKAGE = '391b269d-159a-4039-89a2-51ac132da747';
S.sha = process.env.S982_SHA; assert.match(S.sha ?? '', /^[a-f0-9]{40}$/, 'exact S982_SHA required');
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.bkk = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(d));
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989882' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
S.receipt = { tickets: ['SCRUM-982', 'SCRUM-981 scoped reliability'], sha: S.sha,
  startedAt: new Date().toISOString(), deploysAtStart: existsSync(resolve(out, 'deploys-start.txt')) ? readFileSync(resolve(out, 'deploys-start.txt'), 'utf8').trim().split('\n') : null,
  accounts: {}, numbers: {}, created: [], points: {}, reads: {}, odd: [], hunt: [], pageErrors: [], requests: [], revokes: [], restarts: [], cleanup: {} };
if (process.env.ZZ_RESUME === '1' && existsSync(resolve(out, 'receipt.json'))) {
  const before = JSON.parse(readFileSync(resolve(out, 'receipt.json'), 'utf8'));
  S.receipt = { ...S.receipt, ...before, resumedAt: [...(before.resumedAt ?? []), new Date().toISOString()] };
}
process.on('unhandledRejection', e => { try { S.receipt.odd.push({ what: 'unhandled rejection in a step (logged, driver kept)', text: S.scrub(String(e?.message ?? e).split('\n')[0].slice(0, 200)) }); } catch {} });

// ---- secrets: memory only, in this closure; every written text is scrubbed of them ----
const secrets = new Map(); // who -> { password, temp }
const secretValues = () => [...secrets.values()].flatMap(v => [v.password, v.temp]).filter(Boolean);
// ---- staff names that are not ZZ TEST, and other families' names: memory only, scrubbed from everything written ----
S.names = new Set();
S.hidden = [];
const NOT_NAMES = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Central|Floresta|Branch|Admin|Staff|Party|Oto|Park|Play|Staging|Session|Kitchen|Bar|Cake|Birthday|package|Platform|System|Super|User|Admins?|Owner|Khun)$/i;
S.addName = v => { if (typeof v !== 'string') return; const t = v.trim(); if (t.length < 2 || S.isZz(t)) return; S.names.add(t); for (const p of t.split(/\s+/)) { const w = p.replace(/[()]/g, ''); if (w.length >= 3) S.names.add(w); } };
S.needles = () => [...S.hidden, ...[...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s))].filter(Boolean).sort((a, b) => b.length - a.length);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
S.esc = esc;
S.scrub = text => {
  let t = String(text);
  for (const v of secretValues()) t = t.split(v).join('[withheld]');
  for (const n of S.needles()) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, n.length <= 4 ? 'gu' : 'giu'), '[name]');
  return t.replace(/[0-9a-f]{48}/g, '<token>');
};
S.save = () => {
  writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
  // This ledger contains only explicitly synthetic names, ids and phone numbers.
  // Keep exact IDs independently of the name-redacted narrative for safe cleanup.
  writeFileSync(resolve(out, 'exact-ledger.json'), JSON.stringify({ sha: S.sha, created: S.receipt.created, reusedStaff: S.receipt.reusedStaff ?? [], knownSales: [...(S.knownSales ?? [])] }, null, 2) + '\n');
};
S.point = (key, verdict, pictures, seen) => { S.receipt.points[key] = { verdict, pictures, seen }; S.save(); return { key, verdict }; };
S.odd = (what, extra = {}) => { S.receipt.odd.push({ what, ...extra }); S.save(); };

// ---- the admin api (stations, accounts, displays, reads, clean-up) ----
S.admin = await request.newContext({ baseURL: S.pos });
const adminSignIn = async () => assert.equal((await S.admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
S.call = async (method, path, data, headers = {}) => {
  const once = () => S.admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers }, timeout: 120000 });
  let r = await once();
  if (r.status() === 401) { await adminSignIn(); r = await once(); }
  const body = await r.json().catch(() => null);
  S.receipt.requests.push({ via: 'platform admin', method, path: path.split('?')[0].replace(S.ID, ':id'), status: r.status(), ...(r.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: r.status(), body };
};
await adminSignIn();
{
  const me = (await S.call('GET', '/me')).body;
  for (const o of [me?.employee, me?.account]) for (const k of ['name', 'nickname']) S.addName(o?.[k]);
}
S.branch = (await S.call('GET', '/branches')).body.branches.find(b => /Central Floresta/.test(b.name));
S.branchId = S.branch.id;

// ---- the two proof accounts ----
S.acct = {}; // who -> { id, phone, local, name }
S.makeAccounts = async () => {
  const outA = {};
  const prior = JSON.parse(readFileSync(resolve(out, '../SCRUM-964/receipt.json'), 'utf8'));
  const fixtures = prior.created.filter(r => r.kind === 'login user');
  assert.equal(fixtures.length, 2, 'two committed proof staff identities');
  const all = (await S.call('GET', '/accounts')).body.accounts;
  const census = [];
  for (const who of ['A', 'B']) {
    const f = fixtures.find(r => r.who === who);
    assert.equal(f?.name, `ZZ TEST 964 ${who}`, 'exact prior synthetic staff name');
    const row = all.find(a => a.id === f.id);
    assert.ok(row && row.phone === f.phone && row.employee?.name === f.name && row.status === 'inactive', 'exact inactive QA staff identity');
    const sessions = (await S.call('GET', `/accounts/${f.id}/sessions?limit=50`)).body;
    assert.ok(sessions.total <= 50 && sessions.sessions.every(x => x.status === 'ended'), 'no live or hidden staff session');
    census.push({ who, id: f.id, name: f.name, phone: f.phone, status: row.status, liveSessions: 0, priorSessions: sessions.total });
  }
  S.receipt.accounts.reusePreflight = census; S.save();
  for (const f of census) {
    const { who, id, name, phone } = f;
    const n = '0' + phone.slice(3);
    S.acct[who] = { id, local: n, phone, name };
    // Record exact identity before changing lifecycle, so cleanup can resume.
    (S.receipt.reusedStaff ??= []).push({ who, id, name, phone }); S.save();
    assert.equal((await S.call('PATCH', `/accounts/${id}`, { status: 'active' })).status, 200, 'reactivated own inactive QA staff');
    const temp = await S.admin.fetch(`/api/accounts/${id}/temp-password`, { method: 'POST', headers: { 'idempotency-key': randomUUID() } });
    assert.equal(temp.status(), 200, `temporary password for ${who}`);
    const tempPassword = (await temp.json()).temporaryPassword;
    const finalPassword = randomBytes(15).toString('base64url') + 'Zz9';
    secrets.set(who, { temp: tempPassword, password: finalPassword });
    S.receipt.requests.push({ via: 'platform admin', method: 'POST', path: '/accounts/:id/temp-password', status: temp.status() });
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
/** End the session of A or B ONLY (the two own ZZ TEST accounts), from the admin session, with an Idempotency-Key. */
S.revoke = async who => {
  assert.ok(who === 'A' || who === 'B', 'only the two proof accounts');
  const a = S.acct[who];
  assert.ok(a && S.isZz(a.name), 'a ZZ TEST proof account');
  const r = await S.call('POST', `/accounts/${a.id}/sessions/revoke`);
  assert.equal(r.status, 200, 'revoked');
  const at = new Date();
  S.receipt.revokes.push({ who, at: at.toISOString(), bangkok: S.bkk(at), sessionsEnded: r.body.sessionsEnded, phase: S.phase ?? null }); S.save();
  return { who, sessionsEnded: r.body.sessionsEnded, at: at.toISOString(), atMs: at.getTime() };
};
/** Type the person's password into a password box (never read back, never returned). */
S.typePassword = async (locator, who) => { await locator.fill(secrets.get(who).password); };
S.trySignIn = async who => {
  const ctx = await request.newContext({ baseURL: S.pos });
  const r = await ctx.post('/api/auth/sign-in', { data: { phone: S.acct[who].local, password: secrets.get(who).password } });
  const b = await r.json().catch(() => null);
  if (r.status() === 200) await ctx.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } }).catch(() => {});
  await ctx.dispose();
  return { status: r.status(), code: b?.error?.code ?? null, message: b?.error?.message ?? null };
};

// ---- the browser: one, headless Edge, started on demand; a generated grey camera frame ----
const video = resolve(scratch, 'camera.y4m');
const W = 320, H = 240;
writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(W * H, 150), Buffer.alloc(W * H / 2, 128)]));
S.browser = null;
S.launch = async () => {
  if (S.browser) return 'already';
  S.browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  S.browser.on('disconnected', () => { S.browser = null; S.odd('the browser disconnected'); });
  return 'launched';
};
S.pages = {};
S.watch = (page, label) => {
  page.on('response', async r => {
    try {
      if (new URL(r.url()).pathname !== '/api/sales' || r.request().method() !== 'POST' || r.status() !== 200) return;
      const sale = (await r.json()).sale;
      assert.ok((S.stations ?? []).some(s => s.id === sale?.stationId), 'only own station sale');
      S.knownSales.add(sale.id);
      if (!S.receipt.created.some(x => x.kind === 'sale' && x.id === sale.id)) {
        S.receipt.created.push({ kind: 'sale', id: sale.id, stationId: sale.stationId, label, phase: S.phase }); S.save();
      }
    } catch (e) { S.odd('sale ledger response handler', { text: String(e.message).slice(0, 150) }); }
  });
  page.on('pageerror', e => S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: S.scrub(String(e.message).split('\n')[0].slice(0, 240)) }));
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { try { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); } catch {} });
};
S.landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k)) S.addName(v); else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
S.walkNames = walkNames;
S.picker = page => page.getByRole('heading', { name: 'Which station are you on?' });
/** A new till context at the sign-in form (no one signed in yet). */
S.openTill = async (label, viewport) => {
  await S.launch();
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'],
    ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label);
  page.on('request', q => { try { if (q.method() === 'PUT' && new URL(q.url()).pathname === '/api/me/session/station') (S.picks ??= []).push({ label, at: new Date().toISOString() }); } catch {} });
  page.on('response', r => { try { if (r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/me/session/station') (S.pickAnswers ??= []).push({ label, at: new Date().toISOString(), status: r.status() }); } catch {} });
  await page.goto(S.pos);
  await page.getByRole('heading', { name: 'Oto POS is locked' }).waitFor({ timeout: 60000 });
  S.pages[label] = { ctx, page, viewport };
  return page;
};
/** The sign-in form: phone, password, Sign in; the status of /auth/sign-in. */
S.formSignIn = async (page, who) => {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(S.acct[who].local);
  await S.typePassword(page.locator('input[type="password"]').first(), who);
  const [resp] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/sign-in' && r.request().method() === 'POST', { timeout: 45000 }),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  return resp.status();
};
/** After a sign-in: pick the given station if the picker asks; report whether it asked. */
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
/** A till signed in with a SHARED staging account (manager), by key name, at the given own station. */
S.signInShared = async (label, phoneKey, passwordKey, station, viewport = { width: 1440, height: 900 }) => {
  await S.launch();
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); await page.goto(S.pos);
  await page.getByRole('heading', { name: 'Oto POS is locked' }).waitFor({ timeout: 60000 });
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await S.afterSignIn(page, station);
  await page.locator('a[href="/history"], a[href="/parties"]').first().waitFor({ timeout: 60000 });
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  walkNames(me);
  assert.ok(JSON.stringify(me).includes(station.id), 'signed in at the own ZZ TEST till');
  S.pages[label] = { ctx, page, viewport, passwordKey };
  return page;
};
S.unlockShared = async label => {
  const t = S.pages[label];
  if (await t.page.getByRole('heading', { name: 'Locked', exact: true }).isVisible().catch(() => false)) {
    await t.page.locator('input[type="password"]').first().fill(need(t.passwordKey));
    await t.page.getByRole('button', { name: /Unlock/ }).first().click(); await t.page.waitForTimeout(3000);
    return true;
  }
  return false;
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
S.notice = async page => (await page.getByText(/^Display (connection|connected)/).allInnerTexts().catch(() => [])).map(S.flat);
S.signOutLabel = async label => {
  const t = S.pages[label];
  if (!t) return null;
  const r = await t.page.evaluate(async key => (await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'idempotency-key': key } })).status, randomUUID()).catch(() => null);
  const me = await t.page.evaluate(async () => (await fetch('/api/me', { credentials: 'include' })).status).catch(() => null);
  await t.ctx.close().catch(() => {});
  delete S.pages[label];
  S.receipt.cleanup.signOuts = { ...(S.receipt.cleanup.signOuts ?? {}), [label + '@' + new Date().toISOString()]: { signOut: r, meAfter: me } }; S.save();
  return { signOut: r, meAfter: me };
};
/** The ordinary hand-over: Lock screen, then "Sign out and hand over the till". */
S.handOver = async page => {
  await page.getByRole('button', { name: 'Lock screen' }).click();
  await page.getByRole('heading', { name: 'Locked', exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Sign out and hand over the till' }).click();
  await page.getByRole('heading', { name: 'Oto POS is locked' }).waitFor({ timeout: 30000 });
};
S.alive = label => S.pages[label]?.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))).catch(() => null);
S.keepAlive = on => { clearInterval(S.aliveTimer); S.aliveTimer = null; if (on) S.aliveTimer = setInterval(() => { for (const l of Object.keys(S.pages)) S.alive(l); }, 40000); return on; };

// ---- displays: each in its own context, paired to an own till through the admin api ----
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
  const paired = await S.call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: `ZZ TEST SCRUM-982 display ${label}` });
  assert.equal(paired.status, 200);
  S.displays[label] = { ctx, page, id: paired.body.device.id, revoked: false };
  S.receipt.created.push({ kind: 'display', label, id: paired.body.device.id, station: station.id }); S.save();
  await page.getByTestId('display-pairing-code').waitFor({ state: 'detached', timeout: 60000 });
  return page;
};
S.dropDisplay = async (label, reason = 'ZZ TEST SCRUM-982 proof step complete') => {
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

// ---- masks: the account corner, password boxes, the pairing code, every QR or credit code, other sales and
// families, other parties; staff names that are not ZZ TEST and other families' names wherever they show ----
S.otherSales = page => page.locator('div.space-y-2 > button.w-full.text-left:not([data-zz]):not([role="dialog"] *)');
S.otherParties = page => page.locator('div.space-y-2 > button.w-full').filter({ hasNotText: 'ZZ TEST' });
S.markMine = (page, list) => page.evaluate((list) => {
  for (const b of document.querySelectorAll('div.space-y-2 > button.w-full.text-left')) { const t = b.innerText.replace(/\s+/g, ' '); if (list.some(r => t.includes(r))) b.setAttribute('data-zz', 'mine'); else b.removeAttribute('data-zz'); }
}, list);
S.extraInPlace = []; // functions page => locator, added by steps (e.g. other rows on End of Day)
S.inPlace = page => [page.getByLabel('Lock screen').locator('..'), S.otherSales(page), ...S.extraInPlace.map(f => f(page))];
S.masks = page => [page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'), page.locator('canvas'), page.getByText(/^QR-[A-Z0-9]+$/)];
const MASK_CSS = '[data-zz-mask]{background:#18181b!important;color:#18181b!important;border-color:#18181b!important;border-radius:2px} [data-zz-mask] *{color:#18181b!important;background:#18181b!important;border-color:#18181b!important} [data-zz-mask] img,[data-zz-mask] video,[data-zz-mask] picture,[data-zz-mask] canvas,[data-zz-mask] svg{opacity:0!important}';
S.capture = async (page, opts = {}, extra = []) => {
  for (const loc of S.inPlace(page)) await loc.evaluateAll(els => { for (const e of els) e.setAttribute('data-zz-mask', '1'); }).catch(() => {});
  await page.evaluate(({ list, css }) => {
    if (!document.getElementById('zz-mask-style')) { const st = document.createElement('style'); st.id = 'zz-mask-style'; st.textContent = css; document.head.appendChild(st); }
    const e = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const res = list.map(s => new RegExp(`(?<![\\p{L}\\p{N}])${e(s)}(?![\\p{L}\\p{N}])`, s.length <= 4 ? 'u' : 'iu'));
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const v = w.currentNode.nodeValue || ''; if (v.trim() && res.some(r => r.test(v))) w.currentNode.parentElement?.setAttribute('data-zz-mask', '1'); }
    for (const el of document.querySelectorAll('input,textarea')) { if (res.some(r => r.test(el.value || ''))) el.setAttribute('data-zz-mask', '1'); }
    // every square code-like element: an svg, img or canvas 90 px or more, a square box of 20+ cells, an svg of cells
    for (const s of document.querySelectorAll('svg, img, canvas, div')) {
      const r = s.getBoundingClientRect(); if (r.width < 40 || r.width > 340 || Math.abs(r.width - r.height) > 8) continue;
      const media = s.tagName !== 'DIV' && r.width >= 90;
      // a box of cells with no words in it (a cart panel is square too, but has words)
      const grid = s.tagName === 'DIV' && s.querySelectorAll('*').length >= 20 && !(s.innerText || '').trim();
      const svgCells = s.tagName.toLowerCase() === 'svg' && s.querySelectorAll('rect, path').length >= 3 && r.width >= 60;
      if (media || grid || svgCells) s.setAttribute('data-zz-qr', '1');
    }
  }, { list: S.needles(), css: MASK_CSS }).catch(() => {});
  try {
    const mask = [...S.masks(page), page.locator('[data-zz-qr]'), ...extra];
    if (opts.element) return await opts.element.screenshot({ animations: 'disabled', mask, maskColor: '#18181b' });
    return await page.screenshot({ animations: 'disabled', ...opts, mask, maskColor: '#18181b' });
  } finally {
    await page.evaluate(() => { for (const el of document.querySelectorAll('[data-zz-mask]')) el.removeAttribute('data-zz-mask'); for (const el of document.querySelectorAll('[data-zz-qr]')) el.removeAttribute('data-zz-qr'); }).catch(() => {});
  }
};
S.shots = [];
S.shot = async (page, name, extra = [], opts = {}) => {
  const buf = await S.capture(page, opts, extra);
  writeFileSync(resolve(out, name), buf);
  S.shots.push(name);
  return name;
};
S.tallShot = async (page, name, element) => {
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width, height: 2400 });
  await page.waitForTimeout(800);
  try { await element.scrollIntoViewIfNeeded().catch(() => {}); return await S.shot(page, name, [], { element }); }
  finally { await page.setViewportSize(vp); await page.waitForTimeout(400); }
};
/** Two pages captured at the same moment, side by side in one labelled picture. */
S.both = async (name, caption, left, right, opts = {}) => {
  const at = new Date();
  const [a, b] = await Promise.all([S.capture(left), S.capture(right)]);
  const lv = left.viewportSize(), rv = right.viewportSize();
  const ctx = await S.browser.newContext({ viewport: { width: 2000, height: 800 } });
  const sheet = await ctx.newPage();
  const e = s => String(s ?? '').replace(/[<>&]/g, '');
  await sheet.setContent(`<html><body style="margin:0;background:#fff;font:15px system-ui;color:#111"><div style="padding:8px 12px"><b>SCRUM-982</b> Â· ${e(caption)} Â· captured together at ${S.bkk(at)} Bangkok</div><div style="display:flex;gap:10px;padding:0 10px 10px;align-items:flex-start"><figure style="margin:0;flex:${opts.leftFlex ?? lv.width}"><figcaption style="font-size:13px;margin-bottom:3px">${e(opts.leftLabel ?? `Till (${lv.width}Ã—${lv.height})`)}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${a.toString('base64')}"></figure><figure style="margin:0;flex:${opts.rightFlex ?? rv.width}"><figcaption style="font-size:13px;margin-bottom:3px">${e(opts.rightLabel ?? `Paired ZZ TEST counter display (${rv.width}Ã—${rv.height})`)}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${b.toString('base64')}"></figure></div></body></html>`);
  await sheet.screenshot({ path: resolve(out, name), fullPage: true });
  await ctx.close();
  S.shots.push(name);
  return name;
};
/** A picture of read-back facts: a plain table, rendered in its own page. */
S.facts = async (name, title, rows, note = '') => {
  await S.launch();
  const ctx = await S.browser.newContext({ viewport: { width: 1300, height: 300 } });
  const page = await ctx.newPage();
  const e = s => S.scrub(String(s ?? 'null')).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:16px;background:#fff;color:#111"><h3 style="margin:0 0 8px">${e(title)}</h3>
    <p style="margin:0 0 10px;color:#555;font-size:13px">Read ${e(S.bkk(new Date()))} Bangkok, 13 November 2026, from ${e(S.pos)} (staging; till source ${e(S.sha)}). ZZ TEST values only. ${e(note)}</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="vertical-align:top"><b>${e(k)}</b></td><td style="font-family:Consolas,monospace;white-space:pre-wrap">${e(typeof v === 'string' ? v : JSON.stringify(v, null, 1))}</td></tr>`).join('')}</table></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await ctx.close();
  S.shots.push(name);
  return name;
};

// ---- till steps (ticket counter) ----
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
  const cont = scope.getByRole('button', { name: /^(Continue|à¸”à¸³à¹€à¸™à¸´à¸™à¸à¸²à¸£à¸•à¹ˆà¸­)$/ });
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
S.ticket = async (page, kids, adults, pkg = '1 Hour Play', go = false) => {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByRole('heading', { name: pkg, exact: true }).first().click();
  await page.getByRole('heading', { name: /^Configure:/ }).first().waitFor({ timeout: 20000 });
  await S.quantity(page, 'Kids', kids); await S.quantity(page, 'Adults', adults);
  if (go) await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
};
S.cartState = async page => {
  const configure = await page.getByRole('heading', { name: /^Configure:/ }).first().innerText().catch(() => null);
  const pay = await page.getByRole('button', { name: /^Pay à¸¿/ }).first().innerText().catch(() => null);
  const panel = await page.evaluate(() => { const h = [...document.querySelectorAll('h2,h3')].find(x => /Current Order/.test(x.textContent)); let el = h; for (let i = 0; i < 4 && el && el.innerText.length < 60; i++) el = el.parentElement; return el ? el.innerText.replace(/\s+/g, ' ').trim().slice(0, 500) : null; });
  const payment = await page.getByTestId('payment-step').count();
  return { configure: configure && S.flat(configure), pay: pay && S.flat(pay), panel: panel && S.scrub(panel), membershipCheck: (await page.getByText('Membership Check', { exact: true }).count()) > 0, paymentStep: payment > 0, url: new URL(page.url()).pathname };
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
  await page.getByRole('button', { name: /^Pay à¸¿/ }).first().click();
  const done = page.getByRole('button', { name: 'Done', exact: true });
  const due = page.getByRole('heading', { name: 'Amount Due' });
  await expect.poll(async () => (await done.isVisible()) || (await due.isVisible()), { timeout: 30000 }).toBe(true);
  if (await done.isVisible()) await done.click();
  await due.waitFor({ timeout: 30000 });
};
S.amountDue = page => page.evaluate(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.trim() === 'Amount Due'); return h ? (h.nextElementSibling?.textContent ?? '').trim() : null; });

// ---- setup: numbers, the own tills ----
S.boardApi = async () => {
  const board = (await S.call('GET', `/checkin/board?branchId=${S.branchId}`)).body;
  const keep = new Set();
  for (const f of board?.families ?? []) {
    for (const n of [f.guardianName, ...(f.children ?? []).map(c => c.childName), ...(f.checkedInChildNames ?? [])]) if (n && !S.isZz(n) && n.trim().length >= 2) keep.add(n.trim());
  }
  for (const n of board?.nannies ?? []) if (n.name && !S.isZz(n.name)) keep.add(n.name.trim());
  S.hidden = [...new Set([...S.hidden, ...keep])].filter(s => s.length >= 3 && !NOT_NAMES.test(s)).sort((a, b) => b.length - a.length);
  return board;
};
S.makeStation = async (label, paymentRouting = { card: 'manual', qr: 'none' }) => {
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z982${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const name = `ZZ TEST SCRUM-982 ${label} ${Date.now()}`;
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name, kind: 'till', boxId: S.box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting, capabilities: [], devices: S.devices });
  assert.equal(made.status, 200, 'station ' + JSON.stringify(made.body).slice(0, 200));
  const station = { ...made.body.station, name };
  S.receipt.created.push({ kind: 'station', id: station.id, name, prefix, paymentRouting }); S.save();
  (S.stations ??= []).push(station);
  return station;
};
S.setup = async () => {
  const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box online');
  S.box = { id: box.id, slot: box.slot, role: box.role };
  const board = await S.boardApi();
  const boardPhones = new Set((board?.families ?? []).map(f => (f.guardianPhone ?? '').replace(/^\+66/, '0')));
  const unused = [];
  for (let i = 10; i < 18; i++) {
    const n = S.zz(i);
    const m = (await S.call('GET', `/members/lookup?phone=${n}`)).body?.member ?? null;
    if (!m && !boardPhones.has(n)) unused.push(n);
  }
  S.receipt.checks = { walkInNumbersCheckedUnused: unused.length, first: unused[0], last: unused.at(-1) };
  S.free = unused;
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(r => s.devices.some(d => d.role === r)));
  assert.ok(source, 'simulated printers configured');
  S.devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
  const gw = await S.call('GET', '/webhooks/2c2p/simulator');
  S.gateway = { status: gw.status, provider: gw.body?.provider ?? null, simulatorAvailable: gw.body?.simulatorAvailable ?? null, fellBack: gw.body?.fellBack ?? null };
  S.receipt.reads.gateway = S.gateway; S.save();
  const qr = S.gateway.provider === 'simulator' && S.gateway.simulatorAvailable ? 'gateway' : 'none';
  S.station = await S.makeStation('desk till', { card: 'manual', qr });
  return { free: unused.length, first: unused[0], station: S.station.id, prefix: S.station.codePrefix, gateway: S.gateway, qr };
};
S.nextNumber = () => { const n = S.free.shift(); (S.receipt.numbers.used ??= []).push(n); S.save(); return n; };

// ---- the OTO App, through the launcher (the staging administrator) ----
S.openApp = async () => {
  if (S.app) return S.app;
  await S.launch();
  const ctx = await S.browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', colorScheme: 'light' });
  ctx.setDefaultTimeout(30000);
  assert.equal((await ctx.request.post(S.LAUNCHER + '/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const hand = await (await ctx.request.post(S.LAUNCHER + '/api/auth/handoff', { data: { app: 'oto_app' }, headers: { 'Idempotency-Key': randomUUID() } })).json();
  const page = await ctx.newPage();
  S.watch(page, 'oto-app');
  const exchanged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff', { timeout: 90000 });
  await page.goto(hand.launchUrl); await exchanged;
  await page.waitForURL(u => !u.hash.includes('handoff'), { timeout: 60000 }).catch(() => {});
  S.app = { ctx, page };
  const u = (await S.appCall('GET', '/user')).body;
  for (const v of [u?.fullName, u?.firstName, u?.lastName, u?.nickname, u?.displayName, u?.username, u?.name]) S.addName(v);
  const em = (await S.appCall('GET', `/employees?branchId=${S.APP_FLORESTA}`)).body;
  for (const e of (Array.isArray(em) ? em : em?.employees ?? [])) { S.addName(e.nickname); S.addName(e.fullName); S.addName(e.thaiName); S.addName(e.firstName); S.addName(e.lastName); }
  await page.close().catch(() => {});
  return S.app;
};
S.appCall = async (method, path, body) => {
  const r = await S.app.ctx.request.fetch(S.APP + '/api' + path, { method, data: body, headers: method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() }, timeout: 120000 });
  const text = await r.text();
  let b = null; try { b = JSON.parse(text); } catch { b = text.slice(0, 300); }
  S.receipt.requests.push({ via: 'oto app', method, path: path.split('?')[0].replace(S.ID, ':id').replace(/[0-9a-f]{48}/g, '<token>'), status: r.status() });
  return { status: r.status(), body: b };
};
S.party = async id => (await S.call('GET', `/parties/${id}?branchId=${S.branchId}`));

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
      answer = { ok: false, error: `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n').slice(0, 8).join(' | ').slice(0, 1500)}` };
    }
    busy = false;
    const text = S.scrub(JSON.stringify(answer, null, 1));
    appendFileSync(log, S.scrub(`\n=== ${at} ${S.phase ?? ''}\n${body.trim()}\n--> ${text.slice(0, 8000)}\n`));
    S.save();
    res.setHeader('content-type', 'application/json');
    res.end(text);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`driver ready on 127.0.0.1:${port}`));
