// SCRUM-884 / 918 / 901 / 948 / 917 / 938 staging proof (12 November 2026; pos and pos-web at 013e97348, deploys.json).
// The split-view lane: staff screens fit the split view at 1440 and 1680, add-on names whole, a long check-in label
// inside its button, money written one way, no refusal toast on Tickets for a part-paid food order, a waiting
// sibling's family under Upcoming too. An interactive driver started from the SCRUM-934 driver (same masks, same
// own-till set-up, the OTO App party recipe of SCRUM-889/934), with a fit audit added (S.fit) that reads every visible
// button and text box of a scope: clipped text, text spilling out of its button, a button outside the window, any
// sideways scroll, any text ending in "..".
//
//   node driver.mjs [port]      then  POST http://127.0.0.1:<port>/run  with the step's body (curl --data-binary @file);
//                               POST /quit  ends it (closes the one browser).
//
// One headless Edge (a fake camera for the drop-off form's photos), contexts opened and closed as the steps need them.
// Own ZZ TEST till on the shared virtual box (virtual-1), ZZ TEST members and families with invented numbers
// (08988840xx, checked unused first), one ZZ TEST promo code (10 %), one ZZ TEST party made in the OTO App and deleted
// after. Cash only. Credentials are read by NAME through scripts/agent/env.mjs need() and never printed; staff names
// never enter the receipt or the log (scrubbed), and on the pictures the account corner, the password field, staff
// names, other families, other parties and other sales are masked with solid boxes.
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
const port = Number(process.argv[2] ?? 47884);
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
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08988840' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(out, 'deploys.json');
S.receipt = { tickets: ['SCRUM-884', 'SCRUM-918', 'SCRUM-901', 'SCRUM-948', 'SCRUM-917', 'SCRUM-938'], sha: '013e973488d8578ddbc1c3ff2330055b13fcb49a',
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  numbers: {}, created: [], cancelled: [], points: {}, reads: {}, odd: [], pageErrors: [], requests: [], cleanup: {} };
// ZZ_RESUME=1: a restarted driver carries on the receipt of the run before it (what was made, read and seen).
if (process.env.ZZ_RESUME === '1' && existsSync(resolve(out, 'receipt.json'))) {
  const before = JSON.parse(readFileSync(resolve(out, 'receipt.json'), 'utf8'));
  S.receipt = { ...S.receipt, ...before, resumedAt: [...(before.resumedAt ?? []), new Date().toISOString()] };
}
// A promise a step left behind must never take the driver down (12 Nov: a dangling waitForResponse did).
process.on('unhandledRejection', e => { try { S.receipt.odd.push({ what: 'unhandled rejection in a step (logged, driver kept)', text: String(e?.message ?? e).split('\n')[0].slice(0, 200) }); } catch {} });

// ---- staff names: memory only, scrubbed from everything written ----
S.names = new Set();
const NOT_NAMES = /^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception|Central|Floresta|Branch|Admin|Staff|Party|Oto)$/i;
S.scrub = text => {
  let t = String(text);
  for (const n of [...S.names].filter(s => s.length >= 3 && !NOT_NAMES.test(s)).sort((a, b) => b.length - a.length)) t = t.split(n).join('[staff]');
  return t;
};
S.save = () => writeFileSync(resolve(out, 'receipt.json'), S.scrub(JSON.stringify(S.receipt, null, 2)) + '\n');
S.point = (key, pass, pictures, seen) => { S.receipt.points[key] = { pass, pictures, seen }; S.save(); return { key, pass }; };
S.odd = (what, extra = {}) => { S.receipt.odd.push({ what, ...extra }); S.save(); };

// ---- the admin api (stations, codes, reads, clean-up) ----
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

// ---- the browser: one, headless ----
const video = resolve(scratch, 'camera.y4m');
const W = 320, H = 240;
writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(W * H, 150), Buffer.alloc(W * H / 2, 128)]));
S.browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
S.pages = {};
S.watch = (page, label) => {
  page.on('pageerror', e => S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }));
  page.on('console', m => { if (m.type() === 'error') S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'console.error', text: S.scrub(m.text().split('\n')[0].slice(0, 240)) }); });
  page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) S.receipt.pageErrors.push({ page: label, at: S.phase ?? null, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(S.ID, ':id')} ${r.status()}` }); });
};
S.landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const walkNames = (o, d = 0) => { if (!o || d > 3) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(name|nickname|fullName|displayName|firstName|lastName)$/i.test(k) && v.trim().length >= 2) { S.names.add(v.trim()); for (const p of v.trim().split(/\s+/)) if (p.length >= 3) S.names.add(p); } else if (v && typeof v === 'object' && !/branch|operator|station|role/i.test(k)) walkNames(v, d + 1); } };
S.walkNames = walkNames;
S.signIn = async (label, phoneKey, passwordKey, viewport, extra = {}) => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'],
    ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), ...extra });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label); await page.goto(S.pos);
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(phoneKey).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(passwordKey));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: S.fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } } else if (await page.locator('a[href="/history"]').first().isVisible()) break; await page.waitForTimeout(500); }
  await page.locator('a[href="/history"]').first().waitFor({ timeout: 60000 }).catch(() => {});
  const me = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'include' })).json()));
  walkNames(me);
  assert.ok(JSON.stringify(me).includes(S.station.id), 'signed in at the own ZZ TEST till');
  S.pages[label] = { ctx, page, passwordKey };
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
  // the phone's lock screen has no "Locked" heading role: its Unlock button is the sign
  const btn = t.page.getByRole('button', { name: 'Unlock', exact: true });
  if ((await t.page.getByRole('heading', { name: 'Locked', exact: true }).isVisible().catch(() => false)) || (await btn.isVisible().catch(() => false))) {
    await t.page.locator('input[type="password"]').first().fill(need(t.passwordKey));
    await t.page.getByRole('button', { name: /Unlock/ }).first().click(); await t.page.waitForTimeout(3000);
    return true;
  }
  return false;
};

// ---- displays (SCRUM-929's pairing through the admin API) ----
S.displays = {};
S.pair = async label => {
  const ctx = await S.browser.newContext({ baseURL: S.pos, viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage(); S.watch(page, label);
  await page.goto(`${S.pos}/display`);
  const code = (await page.getByTestId('display-pairing-code').textContent()).trim();
  const claimed = await S.call('POST', `/stations/${S.station.id}/displays/claim`, { pairingCode: code, name: `ZZ TEST SCRUM-884 display ${label}` });
  assert.equal(claimed.status, 200);
  S.displays[label] = { ctx, page, deviceId: claimed.body.device.id };
  S.receipt.created.push({ kind: 'display', label, id: claimed.body.device.id, station: S.station.id }); S.save();
  await page.getByTestId('display-pairing-code').waitFor({ state: 'detached', timeout: 30000 });
  return page;
};

// ---- masks ----
S.hidden = []; // names and numbers of families that are not ZZ TEST, nannies: memory only
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
// structural masks drawn in place (a dialog over them stays readable)
S.inPlace = page => [page.getByLabel('Lock screen').locator('..'), S.deskCards(page).filter({ hasNotText: 'ZZ TEST' }), S.phoneCards(page).filter({ hasNotText: 'ZZ TEST' }), page.getByText(/^(Nannies free now|Free nannies):/), S.otherSales(page), S.pickerCards(page).filter({ hasNotText: 'ZZ TEST' })];
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
/** Two pages captured at the same moment, side by side in one labelled picture. */
S.both = async (name, caption, left, right, opts = {}) => {
  const cap = async page => {
    for (const loc of S.inPlace(page)) await loc.evaluateAll(els => { for (const e of els) e.setAttribute('data-zz-mask', '1'); }).catch(() => {});
    const sources = S.needles().map(s => '(?<![\\p{L}\\p{N}])' + esc(s) + '(?![\\p{L}\\p{N}])');
    await page.evaluate((list) => {
      if (!document.getElementById('zz-mask-style')) { const st = document.createElement('style'); st.id = 'zz-mask-style'; st.textContent = '[data-zz-mask]{background:#18181b!important;color:#18181b!important;border-color:#18181b!important;border-radius:2px} [data-zz-mask] *{color:#18181b!important;background:#18181b!important;border-color:#18181b!important} [data-zz-mask] img,[data-zz-mask] video,[data-zz-mask] picture,[data-zz-mask] canvas{opacity:0!important}'; document.head.appendChild(st); }
      const res = list.map(s => new RegExp(s, 'iu'));
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const v = w.currentNode.nodeValue || ''; if (v.trim() && res.some(r => r.test(v))) w.currentNode.parentElement?.setAttribute('data-zz-mask', '1'); }
    }, sources).catch(() => {});
    try { return await page.screenshot({ animations: 'disabled', mask: S.masks(page), maskColor: '#18181b' }); }
    finally { await page.evaluate(() => { for (const el of document.querySelectorAll('[data-zz-mask]')) el.removeAttribute('data-zz-mask'); }).catch(() => {}); }
  };
  const at = new Date();
  const [a, b] = await Promise.all([cap(left), cap(right)]);
  const sheet = await left.context().newPage();
  await sheet.setViewportSize({ width: 2200, height: 800 });
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(at);
  await sheet.setContent(`<html><body style="margin:0;background:#fff;font:15px system-ui;color:#111"><div style="padding:8px 12px"><b>SCRUM-884</b> · ${caption} · captured together at ${when} Bangkok</div><div style="display:flex;gap:10px;padding:0 10px 10px;align-items:flex-start"><figure style="margin:0;flex:${opts.leftFlex ?? 1680}"><figcaption style="font-size:13px;margin-bottom:3px">${opts.leftLabel ?? 'Till (staff screen)'}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${a.toString('base64')}"></figure><figure style="margin:0;flex:${opts.rightFlex ?? 1280}"><figcaption style="font-size:13px;margin-bottom:3px">${opts.rightLabel ?? 'Paired customer display (/display)'}</figcaption><img style="width:100%;border:1px solid #888" src="data:image/png;base64,${b.toString('base64')}"></figure></div></body></html>`);
  await sheet.screenshot({ path: resolve(out, name), fullPage: true });
  await sheet.close();
  S.shots.push(name);
  return name;
};

// ---- till steps ----
S.halfOf = l => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
S.keypad = async (scope, digits) => { for (const d of digits) await scope.getByRole('button', { name: d, exact: true }).last().click(); };
S.spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
S.walkIn = async (page, number, lang = 'en') => {
  await page.goto('/');
  await S.landing(page).waitFor();
  if (await page.getByTestId('language-choice').isVisible()) await page.getByTestId(`language-choice-${lang}`).click();
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
S.ticket = async (page, kids, adults, pkg = '1 Hour Play', go = true) => {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByRole('heading', { name: pkg, exact: true }).first().click();
  await S.quantity(page, 'Kids', kids); await S.quantity(page, 'Adults', adults);
  if (go) await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
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
/** The drop-off form on the customer half: every child named and aged 6, a photo each, the guardian, every tick. */
S.fillDropOff = async (page, children, guardian, picture, ages = []) => {
  await page.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const first = page.getByPlaceholder('Full name', { exact: true }).first();
  await first.waitFor();
  const half = S.halfOf(first);
  const fields = half.getByPlaceholder('Full name', { exact: true });
  assert.equal(await fields.count(), children.length, 'one name field per child');
  for (let i = 0; i < children.length; i++) await fields.nth(i).fill(children[i]);
  // setAge presses the LAST "Tap to set age" left, so the ages go in from the last child up
  for (let i = children.length - 1; i >= 0; i--) await S.setAge(page, half, ages[i] ?? 6);
  await half.getByPlaceholder('Your full name', { exact: true }).fill(guardian);
  for (let i = 0; i < children.length; i++) {
    await half.getByRole('button', { name: 'Start camera', exact: true }).first().click();
    await half.getByRole('button', { name: 'Take photo', exact: true }).first().click();
    await expect(half.getByAltText('Captured', { exact: true })).toHaveCount(i + 1);
  }
  for (const box of await half.getByRole('checkbox').all()) if (await box.isEnabled()) await box.check();
  if (picture) await S.shot(page, picture);
  const [registered] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
  ]);
  const reg = await registered.json().catch(() => null);
  assert.equal(registered.status(), 200, 'the registration is written');
  S.receipt.created.push({ kind: 'registration', guardian, id: reg.id, stays: reg.children.map(c => ({ id: c.id, name: c.childName })) }); S.save();
  return reg;
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
S.stayFacts = f => f ? f.children.map(c => ({ child: c.childName, status: c.status, paidAtTill: c.paidAtTill ? { receipt: c.paidAtTill.receiptNumber ?? null } : null, paidOnline: Boolean(c.paidOnline) })) : null;
S.money = t => (S.flat(t).match(/[−-]?฿[0-9][0-9,]*(?:\.[0-9]+)?/g) ?? []);
S.oneDecimal = t => (S.flat(t).match(/฿[0-9][0-9,]*\.[0-9](?![0-9])/g) ?? []);

// ---- the desk board ----
S.search = page => page.getByPlaceholder('Search child, parent or phone…');
S.tab = (page, tab) => page.getByRole('button', { name: new RegExp(`^${tab}\\s*\\d+$`) }).first();
S.openBoard = async (page, tab = 'Upcoming') => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check-in', exact: true }).click();
  await S.search(page).waitFor({ timeout: 20000 });
  const dropOff = page.getByRole('button', { name: 'Drop-off', exact: true }).first();
  if (await dropOff.isVisible().catch(() => false)) await dropOff.click();
  await S.tab(page, tab).click();
  await page.waitForTimeout(2500);
};
S.searchBoard = async (page, q) => { await S.search(page).fill(q); await page.waitForTimeout(1200); };
S.releaseOwn = async (regId, guardian) => {
  const reg = await S.registration(regId);
  assert.equal(reg.guardianName, guardian, 'only this run\'s own booking');
  const done = [];
  for (const child of reg.children.filter(c => c.status === 'in_park')) {
    assert.ok(S.isZz(child.childName));
    const file = await S.call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-884 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await S.call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await S.call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push({ child: child.childName, status: r.status });
  }
  return done;
};

// ---- setup: the numbers, the own till, the code ----
S.setup = async () => {
  const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box online');
  S.box = box;
  const board = await S.boardApi();
  const boardPhones = new Set(board.families.map(f => (f.guardianPhone ?? '').replace(/^\+66/, '0')));
  const unused = [];
  for (let i = 10; i < 40; i++) {
    const n = S.zz(i);
    const m = (await S.call('GET', `/members/lookup?phone=${n}`)).body?.member ?? null;
    if (!m && !boardPhones.has(n)) unused.push(n);
  }
  S.receipt.checks = { numbersCheckedUnused: unused.length };
  S.free = unused;
  const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
  const source = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(r => s.devices.some(d => d.role === r)));
  assert.ok(source, 'simulated printers configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: source.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z884${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  S.fixtureName = `ZZ TEST SCRUM-884 proof till ${Date.now()}`;
  const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name: S.fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200);
  S.station = made.body.station;
  S.receipt.created.push({ kind: 'station', id: S.station.id, name: S.fixtureName, prefix }); S.save();
  // the 10 percent code
  const existing = (await S.call('GET', '/menu/discounts?includeArchived=true')).body.discounts;
  S.CODE = Array.from({ length: 50 }, (_, i) => `ZZTEST884${String.fromCharCode(65 + (i % 26))}${i >= 26 ? 'X' : ''}`).find(c => !existing.some(d => d.code === c));
  const code = await S.call('POST', '/menu/discounts', { branchId: S.branchId, code: S.CODE, label: `ZZ TEST SCRUM-884 proof ${S.CODE}`, kind: 'percent', valueBp: 1000,
    validFrom: S.today, validUntil: S.today, usageLimit: 10, perCustomerLimit: null, stackable: false, active: true });
  assert.equal(code.status, 200, 'code made');
  S.codeId = code.body.id;
  S.receipt.created.push({ kind: 'promo-code', code: S.CODE, id: S.codeId, valueBp: 1000, usageLimit: 10, validOn: S.today }); S.save();
  return { free: unused.length, first: unused[0], last: unused.at(-1), station: S.station.id, prefix, code: S.CODE };
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

// ---- the fit audit: what a person would see cut, spilling or scrolling sideways ----
S.fit = (page, rootSel = null) => page.evaluate((rootSel) => {
  const root = rootSel ? document.querySelector(rootSel) : document.body;
  if (!root) return { error: 'no root ' + rootSel };
  const vw = window.innerWidth, vh = window.innerHeight;
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
  const txt = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const r1 = v => Math.round(v * 10) / 10;
  const out = { viewport: [vw, vh], pageSideways: document.documentElement.scrollWidth > vw + 1, truncated: [], clamped: [], spill: [], outsideViewport: [], sidewaysScrollers: [], dotdot: [] };
  for (const el of root.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const t = txt(el);
    if (t && cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.truncated.push({ tag: el.tagName, text: t.slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth });
    else if (t && cs.overflowX === 'hidden' && el.children.length === 0 && el.scrollWidth > el.clientWidth + 1) out.truncated.push({ tag: el.tagName, text: t.slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth, how: 'overflow hidden' });
    if (t && cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 1) out.clamped.push({ tag: el.tagName, text: t.slice(0, 90) });
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) out.sidewaysScrollers.push({ tag: el.tagName, cls: String(el.className).slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth, text: t.slice(0, 60) });
  }
  for (const b of root.querySelectorAll('button, [role="button"], [role="tab"], a')) {
    if (!vis(b)) continue;
    const r = b.getBoundingClientRect();
    let worst = 0;
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { if (!w.currentNode.nodeValue.trim() || !vis(w.currentNode.parentElement)) continue; const rg = document.createRange(); rg.selectNodeContents(w.currentNode); for (const rr of rg.getClientRects()) worst = Math.max(worst, r.left - rr.left, rr.right - r.right, r.top - rr.top, rr.bottom - r.bottom); }
    if (worst > 1) out.spill.push({ text: txt(b).slice(0, 90), by: r1(worst), box: [r1(r.left), r1(r.top), r1(r.width), r1(r.height)] });
    if (r.right > vw + 1 || r.left < -1) out.outsideViewport.push({ text: txt(b).slice(0, 90), left: r1(r.left), right: r1(r.right) });
  }
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) { const v = tw.currentNode.nodeValue.trim(); if (/(\.\.|…)$/.test(v) && vis(tw.currentNode.parentElement)) out.dotdot.push(v.slice(-70)); }
  out.problems = out.pageSideways || out.truncated.length + out.clamped.length + out.spill.length + out.outsideViewport.length + out.sidewaysScrollers.length + out.dotdot.length > 0;
  return out;
}, rootSel);
/** The innermost element whose text is `text`, its box, its button's box, whether it sits inside both and the window. */
S.boxOf = (page, text, { exact = true, within = null } = {}) => page.evaluate(({ text, exact, within }) => {
  const scope = within ? document.querySelector(within) : document.body;
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const hit = e => exact ? norm(e.innerText) === text : norm(e.innerText).includes(text);
  const all = [...scope.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && hit(e); });
  const el = all.find(e => ![...e.children].some(hit));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const btn = el.closest('button');
  const b = btn ? btn.getBoundingClientRect() : null;
  const r1 = v => Math.round(v * 10) / 10;
  let textRect = null;
  const rg = document.createRange(); rg.selectNodeContents(el); const rr = rg.getBoundingClientRect(); textRect = rr;
  return { text: norm(el.innerText), box: [r1(r.left), r1(r.top), r1(r.width), r1(r.height)], button: b ? [r1(b.left), r1(b.top), r1(b.width), r1(b.height)] : null,
    textInsideButton: b ? (textRect.left >= b.left - 1 && textRect.right <= b.right + 1 && textRect.top >= b.top - 1 && textRect.bottom <= b.bottom + 1) : null,
    insideWindow: r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1,
    whole: el.scrollWidth <= el.clientWidth + 1 };
}, { text, exact, within });
S.toggleDisplay = async (page, want) => {
  const b = page.getByRole('button', { name: /^(Show|Hide) customer display$/ }).first();
  await b.waitFor({ timeout: 20000 });
  const showing = S.flat(await b.innerText()).startsWith('Hide');
  if (showing !== want) { await b.click(); await page.waitForTimeout(800); }
  return S.flat(await b.innerText());
};
S.customerHalf = page => page.locator('div[class^="w-1/2 h-full"]').last();

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
