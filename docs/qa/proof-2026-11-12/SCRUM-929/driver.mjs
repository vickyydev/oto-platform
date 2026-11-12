// SCRUM-929 staging proof (12 November 2026; api, pos and pos-web at 8e7f7d315, deploys.json).
// The till's Theme > Display switch changes a separate paired customer display.
// An interactive driver, as the SCRUM-909 run was driven: ONE headless browser kept open, one step at a time. Steps are
// sent to a local port (127.0.0.1 only) as small async bodies that get the state object S; every step and its answer are
// appended to steps.log beside the receipt, so the run can be read back in the order it was driven.
//
//   node driver.mjs [port]      then  POST http://127.0.0.1:<port>/run  with the step's body;  POST /quit  ends it.
//
// Own ZZ TEST tills on the shared virtual box (virtual-1), displays paired to them through the admin API and revoked at
// the end, a ZZ TEST walk-in number checked unused first, cash only. Credentials are read by NAME through
// scripts/agent/env.mjs need() and never printed; the display's bearer is read inside its page and never leaves it;
// staff names never enter the receipt or the log (scrubbed) and are masked on the pictures, as are the account corner,
// the password field and the pairing code. Every picture is the till and the display captured at the same moment, side
// by side.
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
const port = Number(process.argv[2] ?? 47929);
const out = resolve(import.meta.dirname);
mkdirSync(out, { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, need: undefined };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989290' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(out, 'deploys.json');
S.receipt = { tickets: ['SCRUM-929'], sha: '8e7f7d315c271ab00c1ddf4c164bb33dda46ca64',
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  numbers: {}, created: [], points: {}, reads: {}, odd: [], pageErrors: [], requests: [], publishes: [], cleanup: {} };

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
const NOT_NAMES = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Display|Staff|Theme)$/i;
S.scrub = text => {
  let t = String(text);
  for (const n of [...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s)).sort((a, b) => b.length - a.length)) t = t.split(n).join('[staff]');
  return t;
};
S.save = () => writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
S.point = (key, pass, pictures, seen) => { S.receipt.points[key] = { pass, pictures, seen }; S.save(); return { key, pass }; };
S.odd = (what, extra = {}) => { S.receipt.odd.push({ what, ...extra }); S.save(); };

// ---- the admin api (stations, pairing claims, reads, clean-up) ----
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
S.adminSignOut = async () => (await S.admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status();
await adminSignIn();
S.branchId = (await S.call('GET', '/branches')).body.branches.find(b => /Central Floresta/.test(b.name)).id;

// ---- the browser: one, headless ----
S.browser = await chromium.launch({ channel: 'msedge' });
S.watch = (page, label) => {
  page.on('pageerror', e => S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); });
};
/** Every display publication the till sends: when, and whether it carried a theme (and which). */
S.watchPublishes = (page, label) => page.on('request', req => {
  const u = new URL(req.url());
  if (req.method() !== 'POST' || !/\/intents$/.test(u.pathname)) return;
  let b = null; try { b = req.postDataJSON(); } catch { return; }
  if (b?.type !== 'session.publish_display') return;
  S.receipt.publishes.push({ page: label, at: S.phase ?? null, t: Date.now(), stage: b.payload?.stage ?? null, theme: b.payload?.theme ?? null });
});
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2) { S.names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.length >= 3) S.names.add(p); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
S.tills = {};
S.tillContext = async (label, viewport = { width: 1440, height: 900 }) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); S.watchPublishes(page, label);
  S.tills[label] = { ctx, page };
  return page;
};
/** Sign in on the till page at the named own ZZ TEST station. */
S.signIn = async (page, stationName, stationId) => {
  await page.goto(S.pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: stationName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } } else if (await page.locator('a[href="/history"]').first().isVisible()) break; await page.waitForTimeout(500); }
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 });
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  walkNames(me);
  assert.ok(JSON.stringify(me).includes(stationId), 'signed in at the own ZZ TEST till');
  return true;
};
S.signOutPage = async page => {
  const r = await page.evaluate(async (key) => (await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'idempotency-key': key } })).status, randomUUID());
  const me = await page.evaluate(async () => (await fetch('/api/me', { credentials: 'include' })).status);
  return { signOut: r, meAfter: me };
};
S.unlock = async page => {
  if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible().catch(() => false)) {
    await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
    await page.getByRole('button', { name: /Unlock/ }).click(); await page.waitForTimeout(3000);
    return true;
  }
  return false;
};

// ---- displays ----
S.displays = {};
S.displayContext = async (label, storageState) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', ...(storageState ? { storageState } : {}) });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label);
  S.displays[label] = { ...(S.displays[label] ?? {}), ctx, page };
  return page;
};
/** Open /display, read the pairing code inside this process only, claim it for the station through the admin API. */
S.pair = async (label, stationId) => {
  const page = S.displays[label].page;
  await page.goto(`${S.pos}/display`);
  const code = (await page.getByTestId('display-pairing-code').textContent()).trim();
  const claimed = await S.call('POST', `/stations/${stationId}/displays/claim`, { pairingCode: code, name: `ZZ TEST SCRUM-929 display ${label}` });
  assert.equal(claimed.status, 200);
  S.displays[label].deviceId = claimed.body.device.id;
  S.receipt.created.push({ kind: 'display', label, id: claimed.body.device.id, station: stationId }); S.save();
  await page.getByTestId('display-pairing-code').waitFor({ state: 'detached', timeout: 30000 });
  return { paired: true };
};
S.screen = page => page.getByTestId('separate-display');
S.look = async page => { const c = await S.screen(page).getAttribute('class'); return /(^|\s)light(\s|$)/.test(c) ? 'light' : /(^|\s)dark(\s|$)/.test(c) ? 'dark' : `other: ${c?.split(' ')[0]}`; };
S.stored = page => page.evaluate(() => { try { return localStorage.getItem('oto.display.theme'); } catch { return 'unreadable'; } });
/** The display's own session read with its own bearer, inside its page; only the look and the document's theme leave. */
S.sessionTheme = page => page.evaluate(async () => {
  const bearer = localStorage.getItem('oto.display.credential');
  const r = await fetch('/api/display/session', { credentials: 'omit', cache: 'no-store', headers: { authorization: `Bearer ${bearer}` } });
  const body = await r.json().catch(() => null);
  const doc = body?.document ?? null;
  return { status: r.status, hasThemeField: doc ? 'theme' in doc : null, theme: doc?.theme ?? null, sequence: doc?.sequence ?? null, stage: doc?.display?.stage ?? doc?.payload?.stage ?? null };
});
/** Time-stamp every class change of the display's root, so a flip can be measured against the till's press. */
S.watchFlips = page => page.evaluate(() => {
  const w = window; w.__flips = [];
  const el = document.querySelector('[data-testid="separate-display"]');
  const read = () => { const c = el.className; return /(^|\s)light(\s|$)/.test(c) ? 'light' : 'dark'; };
  w.__last = read();
  new MutationObserver(() => { const now = read(); if (now !== w.__last) { w.__flips.push({ t: Date.now(), to: now }); w.__last = now; } }).observe(el, { attributes: true, attributeFilter: ['class'] });
  return w.__last;
});
S.flips = page => page.evaluate(() => window.__flips ?? []);

// ---- the theme menu on the till ----
S.openTheme = async page => { if (!(await page.getByRole('button', { name: /^Switch display theme to / }).isVisible().catch(() => false))) await page.getByRole('button', { name: 'Theme settings', exact: true }).click(); await page.getByRole('button', { name: /^Switch display theme to / }).waitFor(); };
S.closeTheme = async page => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); };
S.displayRow = async page => { await S.openTheme(page); return page.getByRole('button', { name: /^Switch display theme to / }).getAttribute('data-theme-preference'); };
/** Press Display on the till and measure how long the paired display takes to take the new look. */
S.press = async (tillPage, displayPage, expectTo) => {
  await S.openTheme(tillPage);
  const before = (await S.flips(displayPage)).length;
  const t0 = Date.now();
  await tillPage.getByRole('button', { name: `Switch display theme to ${expectTo}`, exact: true }).click();
  await expect.poll(async () => (await S.flips(displayPage)).length > before && (await S.flips(displayPage)).at(-1).to === expectTo, { timeout: 15000, intervals: [50] }).toBe(true);
  const f = (await S.flips(displayPage)).at(-1);
  return { to: f.to, ms: f.t - t0 };
};

// ---- masks and pictures ----
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
S.masks = page => {
  const staff = [...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s));
  const re = staff.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${staff.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  return [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
    page.getByText(/^QR-[A-Z0-9]+$/), ...(re ? [page.getByText(re)] : [])];
};
S.cap = (page, extra = []) => page.screenshot({ animations: 'disabled', mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
/** The till and the display at the same moment, side by side in one labelled picture. */
S.both = async (name, caption, tillPage, displayPage, opts = {}) => {
  const at = new Date();
  const [a, b] = await Promise.all([S.cap(tillPage, opts.tillMask ?? []), S.cap(displayPage, opts.displayMask ?? [])]);
  const sheet = await S.tills[opts.sheetFrom ?? 'A'].ctx.newPage();
  await sheet.setViewportSize({ width: 2000, height: 760 });
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(at);
  await sheet.setContent(`<html><body style="margin:0;background:#fff;font:15px system-ui;color:#111"><div style="padding:8px 12px"><b>SCRUM-929</b> · ${caption} · captured together at ${when} Bangkok</div><div style="display:flex;gap:10px;padding:0 10px 10px;align-items:flex-start"><figure style="margin:0;flex:1440"><figcaption style="font-size:13px;margin-bottom:3px">${opts.tillLabel ?? 'Till (staff screen)'}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${a.toString('base64')}"></figure><figure style="margin:0;flex:1280"><figcaption style="font-size:13px;margin-bottom:3px">${opts.displayLabel ?? 'Paired customer display (/display)'}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${b.toString('base64')}"></figure></div></body></html>`);
  await sheet.screenshot({ path: resolve(out, name), fullPage: true });
  await sheet.close();
  return name;
};
S.one = async (name, page, extra = []) => { await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [...S.masks(page), ...extra], maskColor: '#18181b' }); return name; };

// ---- setup: two own ZZ TEST tills on the virtual box ----
S.makeTill = async label => {
  const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box online');
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(r => s.devices.some(d => d.role === r)));
  assert.ok(source, 'simulated printers configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z929${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  const name = `ZZ TEST SCRUM-929 proof till ${label} ${Date.now()}`;
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200);
  S.stations = { ...(S.stations ?? {}), [label]: { id: made.body.station.id, name, prefix } };
  S.receipt.created.push({ kind: 'station', label, id: made.body.station.id, name, prefix }); S.save();
  return S.stations[label];
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
