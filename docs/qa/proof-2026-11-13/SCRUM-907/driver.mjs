// SCRUM-907 / SCRUM-950 / SCRUM-951 staging proof driver (the party edit lane, main b229f96e2), 13 November 2026.
// An interactive driver as the SCRUM-906 and SCRUM-954 runs were driven (docs/qa/proof-2026-11-12/SCRUM-906/proof.mjs,
// .../SCRUM-954/driver.mjs): ONE headless Chromium, started only when a step asks for it (after a free-memory check),
// several contexts in it; one step at a time, each sent to 127.0.0.1:<port> as a small async body that gets the state
// object S; every step and its scrubbed answer appended to steps.log beside the receipt.
//
//   node driver.mjs [port]      then  node go.mjs steps/<file> [port];   POST /quit  ends it (closes the one browser).
//
// ZZ TEST records only: own ZZ TEST till and ZZ TEST simulated printers on the platform's virtual box (virtual-1),
// ZZ TEST parties made in the OTO App and deleted after, cash only. Credentials are read by NAME through
// scripts/agent/env.mjs need() and never printed; staff names are held in memory only, scrubbed from everything
// written, and blacked out on the pictures (with the account corner, password fields and other parties' cards).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const pw = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const { chromium, request, expect } = pw;
const port = Number(process.argv[2] ?? 47907);
const out = resolve(repo, 'docs/qa/proof-2026-11-13/SCRUM-907');
mkdirSync(out, { recursive: true });
const scratch = 'C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/p907';
mkdirSync(resolve(scratch, 'raw'), { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, scratch, writeFileSync, readFileSync, existsSync, copyFileSync, need };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.LAUNCHER = 'https://oto-launcher-staging.onrender.com';
S.APP = 'https://oto-app-staging.onrender.com';
S.APP_FLORESTA = '6427e84d-723f-4dbd-be58-8ef89cf7dc99';
S.FLORESTA_PACKAGE = '391b269d-159a-4039-89a2-51ac132da747';
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.bkk = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(d));
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
S.freeGb = () => { try { return Number(execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB"', { encoding: 'utf8' }).trim()); } catch { return null; } };
S.receipt = { tickets: ['SCRUM-907', 'SCRUM-950', 'SCRUM-951'], sha: 'b229f96e2771e2100a1075766d479edaa9f48bd2',
  startedAt: new Date().toISOString(), deploys: existsSync(resolve(out, 'deploys.json')) ? JSON.parse(readFileSync(resolve(out, 'deploys.json'), 'utf8')) : null,
  foundAtStart: {}, created: [], points: {}, reads: {}, odd: [], hunt: [], pageErrors: [], requests: [], cleanup: {} };
if (process.env.ZZ_RESUME === '1' && existsSync(resolve(out, 'receipt.json'))) {
  const before = JSON.parse(readFileSync(resolve(out, 'receipt.json'), 'utf8'));
  S.receipt = { ...S.receipt, ...before, resumedAt: [...(before.resumedAt ?? []), new Date().toISOString()] };
}
process.on('unhandledRejection', e => { try { S.receipt.odd.push({ what: 'unhandled rejection in a step (logged, driver kept)', text: String(e?.message ?? e).split('\n')[0].slice(0, 200) }); } catch { /* ignore */ } });

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
S.hidden = []; // other parties' titles: memory only
S.addName = v => { if (typeof v !== 'string') return; const t = v.trim(); if (t.length < 2 || S.isZz(t)) return; S.names.add(t); for (const p of t.split(/\s+/)) { const w = p.replace(/[()]/g, ''); if (w.length >= 3) S.names.add(w); } };
const STOP = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Admin|Staff|Owner|Khun|Central|Floresta|Party|Kitchen|Bar|Cake|Birthday|package|Branch|Platform|System|Super|User|Admins?)$/i;
S.needles = () => [...S.hidden, ...[...S.names].filter(s => s.length >= 3 && !STOP.test(s))].filter(Boolean).sort((a, b) => b.length - a.length);
S.scrub = text => {
  let t = String(text);
  for (const n of S.needles()) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, n.length <= 4 ? 'gu' : 'giu'), '[name]');
  return t.replace(/[0-9a-f]{48}/g, '<token>');
};
S.save = () => writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
S.point = (key, pass, pictures, seen) => { S.receipt.points[key] = { verdict: pass ? 'PASS' : 'FAIL', pictures, seen }; S.save(); return { key, verdict: pass ? 'PASS' : 'FAIL' }; };
S.odd = (what, extra = {}) => { S.receipt.odd.push({ what, ...extra }); S.save(); };

// ---- the platform admin api on the till's origin (stations, printers, reads, clean-up) ----
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

// ---- the browser: one, headless, started on demand ----
S.browser = null;
S.launch = async () => {
  if (S.browser) return 'already';
  const free = S.freeGb();
  if (free !== null && free < 3) throw new Error(`only ${free.toFixed(2)} GB free: wait`);
  S.browser = await chromium.launch({ headless: true });
  return `launched with ${free?.toFixed(2)} GB free`;
};
S.pages = {};
S.watch = (page, label) => {
  page.on('pageerror', e => { S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: S.scrub(String(e.message).split('\n')[0].slice(0, 240)) }); });
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { try { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); } catch { /* ignore */ } });
};
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k)) S.addName(v); else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
S.walkNames = walkNames;
/** A till signed in at this run's own ZZ TEST station. */
S.signIn = async (label, phoneKey, passwordKey, viewport = { width: 1440, height: 900 }) => {
  await S.launch();
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); await page.goto(S.pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: S.fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } } else if (await page.locator('a[href="/history"]').first().isVisible()) break; await page.waitForTimeout(500); }
  await page.locator('a[href="/history"], a[href="/parties"]').first().waitFor({ timeout: 60000 });
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
    await t.page.getByRole('button', { name: /Unlock/ }).first().click(); await t.page.waitForTimeout(3000);
    return true;
  }
  return false;
};
S.signOutTill = async label => {
  const t = S.pages[label];
  if (!t) return null;
  const so = await t.page.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } }).catch(() => null);
  const me = await t.page.request.get('/api/me').catch(() => null);
  await t.ctx.close().catch(() => {});
  delete S.pages[label];
  (S.receipt.cleanup.signOuts ??= {})[label] = { signOut: so?.status() ?? null, meAfter: me?.status() ?? null }; S.save();
  return { signOut: so?.status() ?? null, meAfter: me?.status() ?? null };
};

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
  return S.app;
};
S.appCall = async (method, path, body) => {
  const r = await S.app.ctx.request.fetch(S.APP + '/api' + path, { method, data: body, headers: method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() }, timeout: 120000 });
  const text = await r.text();
  let b = null; try { b = JSON.parse(text); } catch { b = text.slice(0, 300); }
  S.receipt.requests.push({ via: 'oto app', method, path: path.split('?')[0].replace(S.ID, ':id').replace(/[0-9a-f]{48}/g, '<token>'), status: r.status() });
  return { status: r.status(), body: b };
};
S.hideBoard = page => page.evaluate(() => { const root = document.getElementById('root'); if (!root) return false; root.setAttribute('data-board-hidden', '1'); root.style.visibility = 'hidden'; root.style.opacity = '0'; return true; });
S.showBoard = page => page.evaluate(() => { const root = document.querySelector('[data-board-hidden]'); if (root) { root.style.visibility = ''; root.style.opacity = ''; root.removeAttribute('data-board-hidden'); } });

// ---- pictures: names blacked out in place; structural masks; nothing else touched ----
S.otherParties = page => page.locator('div.space-y-2 > button.w-full').filter({ hasNotText: 'ZZ TEST' });
S.otherSales = page => page.locator('div.space-y-2 > button.w-full.text-left:not([data-zz]):not([role="dialog"] *)');
S.inPlace = page => [page.getByLabel('Lock screen').locator('..'), S.otherParties(page)];
S.masks = page => [page.locator('input[type="password"]'), page.locator('canvas'), page.getByText(/^QR-[A-Z0-9]+$/)];
const MASK_CSS = '[data-zz-mask]{background:#18181b!important;color:#18181b!important;border-color:#18181b!important;border-radius:2px} [data-zz-mask] *{color:#18181b!important;background:#18181b!important;border-color:#18181b!important} [data-zz-mask] img,[data-zz-mask] video,[data-zz-mask] picture,[data-zz-mask] canvas,[data-zz-mask] svg{opacity:0!important}';
S.shots = [];
S.shot = async (page, name, extra = [], opts = {}) => {
  for (const loc of S.inPlace(page)) await loc.evaluateAll(els => { for (const e of els) e.setAttribute('data-zz-mask', '1'); }).catch(() => {});
  await page.evaluate(({ list, css }) => {
    if (!document.getElementById('zz-mask-style')) { const st = document.createElement('style'); st.id = 'zz-mask-style'; st.textContent = css; document.head.appendChild(st); }
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const res = list.map(s => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s)}(?![\\p{L}\\p{N}])`, s.length <= 4 ? 'u' : 'iu'));
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const v = w.currentNode.nodeValue || ''; if (v.trim() && res.some(r => r.test(v))) w.currentNode.parentElement?.setAttribute('data-zz-mask', '1'); }
    for (const el of document.querySelectorAll('input,textarea')) { if (res.some(r => r.test(el.value || ''))) el.setAttribute('data-zz-mask', '1'); }
  }, { list: S.needles(), css: MASK_CSS }).catch(() => {});
  try {
    if (opts.element) await opts.element.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
    else await page.screenshot({ path: resolve(out, name), animations: 'disabled', ...opts, mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
  } finally {
    await page.evaluate(() => { for (const el of document.querySelectorAll('[data-zz-mask]')) el.removeAttribute('data-zz-mask'); }).catch(() => {});
  }
  S.shots.push(name);
  return name;
};
/** A picture of read-back facts: a plain table, rendered in its own page. */
S.facts = async (name, title, rows, note = '') => {
  await S.launch();
  const ctx = await S.browser.newContext({ viewport: { width: 1300, height: 300 } });
  const page = await ctx.newPage();
  const e = s => String(s ?? 'null').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await page.setContent(`<html><body style="font-family:Segoe UI,Arial;padding:16px;background:#fff;color:#111"><h3 style="margin:0 0 8px">${e(title)}</h3>
    <p style="margin:0 0 10px;color:#555;font-size:13px">Read ${e(S.bkk(new Date()))} Bangkok, 13 November 2026, from the staging api (oto-api-staging at b229f96e). ${e(note)}</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="vertical-align:top"><b>${e(k)}</b></td><td style="font-family:Consolas,monospace;white-space:pre-wrap">${e(typeof v === 'string' ? v : JSON.stringify(v, null, 1))}</td></tr>`).join('')}</table></body></html>`);
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await ctx.close();
  S.shots.push(name);
  return name;
};

// ---- the simulated printers: what each drew ----
S.printouts = async role => {
  const dev = S.devices[role];
  const r = await S.call('GET', `/devices/${dev.id}/printouts?limit=20`);
  return r.status === 200 ? r.body.printouts : [];
};
S.keyOf = p => `${p.seq}@${p.at}`;
S.keepPreview = async (role, p, name, dir = out) => {
  const r = await S.admin.get(`/api/devices/${S.devices[role].id}/printouts/${p.seq}/preview.png`);
  assert.equal(r.status(), 200, 'preview read');
  writeFileSync(resolve(dir, name), await r.body());
  return name;
};
S.newPrintouts = async () => ({
  kitchen: (await S.printouts('kitchen')).filter(p => !S.seen.kitchen.includes(S.keyOf(p))),
  bar: (await S.printouts('bar')).filter(p => !S.seen.bar.includes(S.keyOf(p))),
});
S.markSeen = (k, b) => { for (const p of k) S.seen.kitchen.push(S.keyOf(p)); for (const p of b) S.seen.bar.push(S.keyOf(p)); };
S.jobsAtTill = async (sinceIso) => (await S.call('GET', `/branches/${S.branchId}/print-jobs?stationId=${S.station.id}&limit=200`)).body.jobs
  .filter(j => !sinceIso || Date.parse(j.queuedAt) >= Date.parse(sinceIso))
  .sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt))
  .map(j => ({ queuedAt: j.queuedAt, bangkok: S.bkk(j.queuedAt), kind: j.kind, role: j.role, printer: j.deviceLabel, status: j.status, errorCode: j.errorCode }));
S.auditOf = async (action, entityId) => ((await S.call('GET', `/audit?action=${encodeURIComponent(action)}&entityId=${entityId}&limit=50`)).body?.entries ?? []);
S.party = async id => (await S.call('GET', `/parties/${id}?branchId=${S.branchId}`));
S.sale = async id => (await S.call('GET', `/sales/${id}`)).body;
S.stationSales = async () => (await S.call('GET', `/sales?branchId=${S.branchId}&stationId=${S.station.id}&limit=50`)).body.sales;

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
      answer = { ok: false, error: `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n').slice(0, 8).join(' | ').slice(0, 1500)}` };
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
