// SCRUM-909 / 911 / 912 / 913 / 916 staging proof (12 November 2026; api, pos and pos-web at 348caa58d, deploys.json).
// An interactive driver, as the SCRUM-889 run was driven: one browser (Edge, a fake camera for the drop-off form's
// photos) kept open, one step at a time. The steps are sent to a local port (127.0.0.1 only) as small async bodies that
// get the state object S; every step and its answer are appended to steps.log beside the receipt, so the run can be read
// back in the order it was driven. Started from the SCRUM-886 harness (drop-off bookings, the board, cancel, paid at the
// till) and the SCRUM-889 harness (a ZZ TEST party with a deposit, Settle party, History refund by a manager, clean-up).
//
//   node driver.mjs [port]      then  POST http://127.0.0.1:<port>/run  with the step's body;  POST /quit  ends it.
//
// Own ZZ TEST till on the shared virtual box (virtual-1), ZZ TEST families with invented numbers (08989090xx, checked
// unused first), a ZZ TEST party made in the OTO App and deleted after. Cash only. Credentials are read by NAME through
// scripts/agent/env.mjs need() and never printed; staff names never enter the receipt or the log (scrubbed), and on the
// pictures the account corner, the password field, staff names, other families, other parties and other sales are masked.
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
const port = Number(process.argv[2] ?? 47909);
const out = resolve(import.meta.dirname);
mkdirSync(out, { recursive: true });
const scratch = process.env.ZZ_SCRATCH ?? resolve(out, '.scratch');
mkdirSync(scratch, { recursive: true });

const S = { pw, expect, assert, randomUUID, resolve, out, need: undefined };
S.pos = 'https://oto-pos-web-staging.onrender.com';
S.LAUNCHER = 'https://oto-launcher-staging.onrender.com';
S.APP = 'https://oto-app-staging.onrender.com';
S.APP_FLORESTA = '6427e84d-723f-4dbd-be58-8ef89cf7dc99';
S.FLORESTA_PACKAGE = '391b269d-159a-4039-89a2-51ac132da747';
S.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
S.flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
S.ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
S.zz = i => '08989090' + String(i).padStart(2, '0');
S.isZz = s => /^ZZ TEST/i.test(String(s ?? '').trim());
S.sleep = ms => new Promise(r => setTimeout(r, ms));
const deploysFile = resolve(out, 'deploys.json');
S.receipt = { tickets: ['SCRUM-909', 'SCRUM-911', 'SCRUM-912', 'SCRUM-913', 'SCRUM-916'], sha: '348caa58d0a568d76a5f8cae815dcb745b0d73b7',
  startedAt: new Date().toISOString(), deploys: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  numbers: {}, created: [], cancelled: [], points: {}, reads: {}, odd: [], pageErrors: [], requests: [], cleanup: {} };

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

// ---- the admin api (stations, reads, clean-up) ----
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

// ---- the browser ----
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

// ---- masks ----
S.hidden = []; // names and numbers of families that are not ZZ TEST, nannies: memory only
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
S.phoneCards = page => page.locator('div.space-y-2 > button[class*="rounded-2xl"]');
S.pickerCards = page => page.getByRole('dialog').locator('div.space-y-3 > div');
S.otherParties = page => page.locator('div.space-y-2 > button.w-full').filter({ hasNotText: 'ZZ TEST' });
S.otherSales = page => page.locator('div.space-y-2 > button.w-full.text-left:not([data-zz])');
S.markMine = (page, res) => page.evaluate((list) => {
  for (const b of document.querySelectorAll('div.space-y-2 > button.w-full.text-left')) { if (list.some(r => new RegExp(r).test(b.innerText))) b.setAttribute('data-zz', 'mine'); else b.removeAttribute('data-zz'); }
}, res);
S.masks = page => {
  const staff = [...S.names].filter(s => s.length >= 3 && !/^(ZZ|TEST|SCRUM|proof|till|OTO|Till|Manager|Reception)$/i.test(s));
  const all = [...S.hidden, ...staff].filter(Boolean);
  const re = all.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${all.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  return [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
    page.getByTestId('display-pairing-code'), page.locator('canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
    S.deskCards(page).filter({ hasNotText: 'ZZ TEST' }), S.phoneCards(page).filter({ hasNotText: 'ZZ TEST' }),
    page.getByText(/^(Nannies free now|Free nannies):/),
    ...(re ? [S.deskCards(page).filter({ hasText: re }), S.phoneCards(page).filter({ hasText: re }), page.getByText(re)] : [])];
};
S.shots = [];
S.shot = async (page, name, extra = [], opts = {}) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', ...opts, mask: [...S.masks(page), ...extra], maskColor: '#18181b' });
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
  if (lang !== 'en') return scope;
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = page.getByRole('dialog', { name: 'New member?', exact: true });
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
/** The drop-off form on the customer half: every child named and aged 6, a photo each, the guardian, every tick. */
S.fillDropOff = async (page, children, guardian, picture) => {
  await page.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const first = page.getByPlaceholder('Full name', { exact: true }).first();
  await first.waitFor();
  const half = S.halfOf(first);
  const fields = half.getByPlaceholder('Full name', { exact: true });
  assert.equal(await fields.count(), children.length, 'one name field per child');
  for (let i = 0; i < children.length; i++) await fields.nth(i).fill(children[i]);
  for (let i = 0; i < children.length; i++) await S.setAge(page, half, 6);
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
S.releaseOwn = async (regId, guardian) => {
  const reg = await S.registration(regId);
  assert.equal(reg.guardianName, guardian, 'only this run\'s own booking');
  const done = [];
  for (const child of reg.children.filter(c => c.status === 'in_park')) {
    assert.ok(S.isZz(child.childName));
    const file = await S.call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-909 synthetic pickup.png' });
    assert.equal(file.status, 200);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await S.call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const r = await S.call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
    done.push({ child: child.childName, status: r.status });
  }
  return done;
};

// ---- setup: the numbers, the own till ----
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
  S.devices = devices;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z909${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  S.fixtureName = `ZZ TEST SCRUM-909 proof till ${Date.now()}`;
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
