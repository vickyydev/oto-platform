// Staging proof for SCRUM-1060, a save retried after a lost connection is
// written once, as landed. Adapted from the SCRUM-1059 harness of 20
// November. Own ZZ TEST till on the simulated box, one paired customer
// display (600x1024), the seeded reception account at the till, a returning
// ZZ TEST family (one saved child) made through the api with an invented
// number. No sale is paid. No credential, pairing code, phone, key or raw
// response body enters the receipt or the console.
//
//   node proof.mjs <full-sha> <run-tag>
//
//   1  "Who's visiting today?": the reply to the visit's own create is lost
//      at the edge after the platform wrote it (a 504); Confirm again: the
//      same id and key, the platform answers from the first write, one visit
//   3  the desk gate ("Children playing alone") at 1024 wide: a name typed in
//      "Child's name" draws at the box's own 18px
//   2  "Who's visiting today?" again: an allergy changed, and the reply to
//      the child's change dropped as no answer at all (the request aborted
//      after the platform wrote it), so the till moves the change to the
//      counter box; after the box's sync, one child.update row for it
// ZZ_BASE moves the invented number; each run asserts it is unused first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const tag = process.argv[3] ?? 'run';
const out = resolve(import.meta.dirname, tag);
mkdirSync(out, { recursive: true });
const base = String(Number(process.env.ZZ_BASE ?? 31)).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const FAM = { number: '08981060' + base, name: `ZZ TEST SCRUM-1060 family ${base}`, kid: `ZZ TEST Ploy ${base}`, typed: 'ZZ TEST Mai',
  allergy: `ZZ TEST sesame ${base}` };
const receipt = { ticket: 'SCRUM-1060', sha, startedAt: new Date().toISOString(), phase: 'preflight',
  points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = (value) => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const firstLine = (error) => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
const point = (key, pass, pictures, shows, seen = {}) => { receipt.points[key] = { pass, pictures, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); };
const odd = (what) => { receipt.odd.push({ at: receipt.phase, what }); save(); console.log('ODD', what); };
const ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let response = await once();
  if (response.status() === 401) { await adminSignIn(); response = await once(); }
  const isJson = /json/.test(response.headers()['content-type'] ?? '');
  const body = isJson ? await response.json().catch(() => null) : await response.body().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0].replace(ID, ':id'), status: response.status(), ...(response.status() >= 400 && isJson ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: response.status(), body };
};

let browser = null, till = null, station = null, branchId = null, boxId = null, failed = false;
let family = null, childId = null;
const displays = [];

const PHONE_TEXT = /(\+66|\b0)\s?\d{1,2}\s?\d{3}\s?\d{4}\b/;
const masksOf = (page) => [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
  page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/), page.locator('div.grid.gap-px'),
  page.locator('[data-testid="consent-kept-phone"] .tabular-nums'), page.locator('input[type="tel"]'), page.getByText(PHONE_TEXT)];
const shot = async (page, name, target = page, masks = null) => {
  await target.screenshot({ path: resolve(out, name), animations: 'disabled', mask: masks ?? masksOf(page) });
  console.log('picture', name);
  return `SCRUM-1060/${tag}/${name}`;
};
function watch(page, label) {
  page.on('pageerror', (e) => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(ID, ':id')} ${r.status()}` });
  });
}
const fixtureName = `ZZ TEST SCRUM-1060 proof till ${Date.now()}`;
const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const landing = (page) => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const keypad = async (scope, digitsToType) => { for (const digit of digitsToType) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const home = async () => { await till.goto('/'); await landing(till).or(till.getByRole('heading', { name: 'Membership Check', exact: true })).first().waitFor(); };
const lookup = async (number) => (await call('GET', `/members/lookup?phone=${number}`)).body.member;
const entriesOf = (body) => body?.entries ?? body?.items ?? body?.rows ?? body?.audit ?? (Array.isArray(body) ? body : []);
const auditRows = async (query) => entriesOf((await call('GET', `/audit?${query}&limit=200`)).body);
const visitRowsFor = async (memberId, from) => (await auditRows(`entityType=visit&from=${encodeURIComponent(from)}`))
  .filter((row) => row.after?.memberId === memberId && /^visit\./.test(row.action));
const childUpdateRows = async (from) => (await auditRows(`entityId=${childId}&from=${encodeURIComponent(from)}`)).filter((row) => row.action === 'child.update');
const boxStatus = async () => {
  const r = await call('GET', `/box/v1/station/${station.id}/status`);
  return r.status === 200 ? { lane: r.body.link?.lane ?? null, up: r.body.link?.up ?? null, outboxDepth: r.body.outboxDepth, membersAppliedAt: r.body.members?.appliedAt ?? null } : { status: r.status };
};

async function signInAtTill(page, who = 'RECEPTION') {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need(`STAGING_${who}_PHONE`).replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need(`STAGING_${who}_PASSWORD`));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000; let steady = 0;
  while (Date.now() < deadline) {
    if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } steady = 0; }
    else if (await landing(page).isVisible()) { steady += 1; if (steady >= 6) break; } else steady = 0;
    await page.waitForTimeout(500);
  }
  await page.locator('a[href="/history"]').first().waitFor();
}
async function pairDisplay(letter, viewport = { width: 600, height: 1024 }) {
  phase(`pair customer display ${letter} (${viewport.width}x${viewport.height})`);
  const context = await browser.newContext({ baseURL: pos, viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  watch(page, `display ${letter}`);
  await page.goto(`${pos}/display`);
  await page.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
  const name = `ZZ TEST SCRUM-1060 display ${letter}`;
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name });
  assert.equal(paired.status, 200);
  const d = { letter, name, context, page, id: paired.body.device.id, revoked: false };
  displays.push(d);
  receipt.created.push({ kind: 'display', id: d.id, name }); save();
  await landing(page).waitFor();
  return d;
}
async function dropDisplay(d, reason = 'ZZ TEST SCRUM-1060 proof complete') {
  const at = displays.indexOf(d);
  if (at >= 0) displays.splice(at, 1);
  if (!d.revoked) {
    const r = await call('POST', `/credentials/${d.id}/revoke`, { reason });
    assert.ok([200, 409].includes(r.status));
    receipt.cleanup.push({ kind: 'display', id: d.id, revoked: true }); save();
  }
  await d.context.close().catch(() => {});
}
async function identifyOnDisplay(page, number) {
  await page.waitForTimeout(2500);
  for (let i = 0; i < 20; i++) {
    if (await page.getByTestId('language-choice').isVisible().catch(() => false)) await page.getByTestId('language-choice-en').click().catch(() => {});
    else if (await page.getByTestId('identify-safety').isVisible().catch(() => false)) break;
    await page.waitForTimeout(750);
  }
  await page.getByTestId('identify-safety').waitFor();
  await keypad(page.locator('body'), number);
}
/** Continue on the display; a request the display gave up on (its 8 s limit) offers Retry, pressed and recorded. */
async function continueOnDisplay(page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  for (let i = 0; i < 3; i++) {
    if (!(await retry.waitFor({ timeout: 6000 }).then(() => true).catch(() => false))) return;
    odd('the display said "Connection interrupted" and offered Retry; Retry pressed');
    await retry.click();
    await page.waitForTimeout(2500);
    const again = page.getByRole('button', { name: 'Continue', exact: true });
    if (await again.isVisible().catch(() => false)) await again.click();
  }
}
async function setQuantity(label, target) {
  const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
  const remove = till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let count = 0; count < 8; count++) {
    const current = Number(await value.textContent());
    if (current === target) return;
    await (current < target ? add : remove).click();
    await till.waitForTimeout(250);
  }
  assert.equal(Number(await value.textContent()), target);
}
async function chooseTicket(pkg, kids, adults, rate = 'Tourist') {
  const tiers = till.getByRole('heading', { name: 'Select Customer Type', exact: true });
  await tiers.or(till.getByRole('heading', { name: pkg, exact: true }).first()).first().waitFor({ timeout: 30000 });
  if (rate && await tiers.isVisible().catch(() => false)) await till.getByRole('heading', { name: rate, exact: true }).first().click();
  await till.getByRole('heading', { name: pkg, exact: true }).first().click();
  await till.waitForTimeout(600);
  await setQuantity('Kids', kids); await setQuantity('Adults', adults);
}
const visitingWindow = () => till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
const cardOf = (visiting, name) => visiting.locator('div.rounded-xl.p-3').filter({ has: till.getByText(name, { exact: true }) }).first();

async function openVisitingWindow() {
  const a = displays[0];
  await home();
  await identifyOnDisplay(a.page, FAM.number);
  await continueOnDisplay(a.page);
  const visiting = visitingWindow();
  await visiting.waitFor({ timeout: 30000 });
  const box = cardOf(visiting, FAM.kid).getByRole('checkbox');
  await box.waitFor({ timeout: 20000 });
  if (!(await box.isChecked().catch(() => false))) await box.click();
  return visiting;
}

// ---- 1: the visit's own create, its reply lost ----
async function pointOne() {
  phase('1: the family types the number on display A; "Who\'s visiting today?"');
  const visiting = await openVisitingWindow();
  const from = new Date(Date.now() - 5000).toISOString();
  const sends = [];
  const onVisit = async (route) => {
    const r = route.request();
    if (r.method() !== 'POST') return route.continue();
    const body = r.postDataJSON() ?? {};
    const response = await route.fetch();
    const answered = await response.json().catch(() => null);
    sends.push({ key: r.headers()['idempotency-key'] ?? null, bodyId: body.id ?? null, platformStatus: response.status(),
      replayed: response.headers()['x-oto-replay'] === 'true' || response.headers()['idempotent-replayed'] === 'true', answeredId: answered?.id ?? null });
    if (sends.length === 1) {
      // What the till sees when the edge gives up on a reply the platform already wrote.
      await route.fulfill({ status: 504, contentType: 'text/plain', body: 'Gateway Timeout' });
      return;
    }
    await route.fulfill({ response });
  };
  await till.route('**/api/visits', onVisit);
  const confirm = visiting.getByRole('button', { name: /^Confirm 1 child/ });
  phase('1: Confirm; the platform opens the visit, its reply is lost at the edge');
  await confirm.click();
  const lost = till.getByText("Couldn't confirm the visit", { exact: true }).first();
  await lost.waitFor({ timeout: 30000 });
  await till.waitForTimeout(800);
  const p1a = await shot(till, 'p1a-visiting-window-visit-reply-lost.png');
  phase('1: Confirm again');
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await confirm.click();
  await visiting.waitFor({ state: 'hidden', timeout: 30000 });
  await till.unroute('**/api/visits', onVisit);
  await till.waitForTimeout(1200);
  const p1b = await shot(till, 'p1b-visit-confirmed-after-retry.png');
  let rows = [];
  await expect.poll(async () => { rows = await visitRowsFor(family.id, from); return rows.length; }, { timeout: 20000 }).toBeGreaterThan(0).catch(() => odd('no visit row read'));
  await till.waitForTimeout(3000);
  rows = await visitRowsFor(family.id, from);
  const same = sends.length === 2 && sends[0].key === sends[1].key && sends[0].bodyId === sends[1].bodyId;
  receipt.checks.visit = {
    sends: sends.map((s, i) => ({ attempt: i + 1, sameKeyAsFirst: s.key === sends[0].key, sameIdAsFirst: s.bodyId === sends[0].bodyId, platformStatus: s.platformStatus,
      replayed: s.replayed, answeredWithFirstId: s.answeredId === sends[0].bodyId })),
    visitRows: rows.map((row) => ({ action: row.action, fromThisTillOnline: row.requestId !== null })),
    distinctVisits: new Set(rows.filter((row) => row.action === 'visit.create').map((row) => row.entityId)).size,
  };
  save();
  point('1-visit-create-once', same && sends.every((s) => s.platformStatus === 200) && sends[1].answeredId === sends[0].bodyId
    && receipt.checks.visit.distinctVisits === 1 && rows.filter((row) => row.action === 'visit.create').length === 1, [p1a, p1b],
  '"Who\'s visiting today?": the platform opened the visit and the reply was lost; Confirm again sent the same visit id under the same key, the platform answered with that visit, and the family has one visit and one visit.create row',
  receipt.checks.visit);
  return rows.find((row) => row.action === 'visit.create')?.entityId ?? null;
}

// ---- 3: the desk gate at 1024 wide ----
async function pointThree() {
  phase('3: Eat & Play for two children, no adult; the desk gate at 1024 wide');
  // On its own (ONLY=3) the family is identified on the display first and its saved child confirmed.
  if (!(await till.getByRole('heading', { name: 'Select Customer Type', exact: true }).isVisible().catch(() => false))) {
    if (childId) {
      const visiting = await openVisitingWindow();
      await visiting.getByRole('button', { name: /^Confirm 1 child/ }).click();
      await visiting.waitFor({ state: 'hidden', timeout: 30000 });
    } else {
      // No display paired: the family's half is on the till's own screen, and the desk gate's
      // own "Child's name" boxes follow (with a display paired the form is the display's).
      await home();
      const choice = till.getByTestId('language-choice').last();
      if (await choice.waitFor({ timeout: 20000 }).then(() => true).catch(() => false)) await choice.getByTestId('language-choice-en').click();
      await till.getByTestId('identify-safety').waitFor({ timeout: 20000 });
      await keypad(till.locator('body'), FAM.number);
      await till.getByRole('button', { name: 'Continue', exact: true }).last().click();
      const offer = till.getByRole('button', { name: 'Continue as walk-in', exact: true });
      const tiers = till.getByRole('heading', { name: 'Tourist', exact: true });
      await expect.poll(async () => (await offer.isVisible()) || (await tiers.isVisible()), { timeout: 20000 }).toBe(true);
      if (await offer.isVisible()) await offer.click();
    }
    await till.waitForTimeout(1000);
  }
  await chooseTicket('Eat & Play Kids Pass', 2, 0);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
  const gate = till.getByRole('heading', { name: 'Children playing alone', exact: true });
  // A returning family confirms its saved children first; the second child is named there.
  const stillYours = till.getByRole('heading', { name: 'Are these still your children?', exact: true });
  await gate.or(stillYours).first().waitFor({ timeout: 30000 });
  if (await stillYours.isVisible().catch(() => false)) {
    // The saved child is confirmed as still correct; the new child is named in the empty box.
    const confirmSaved = till.getByRole('button', { name: 'Confirm', exact: true }).first();
    if (await confirmSaved.isVisible().catch(() => false)) await confirmSaved.click();
    let empty = null;
    for (const box of await till.getByPlaceholder('Full name', { exact: true }).all()) if ((await box.inputValue()) === '') { empty = box; break; }
    assert.ok(empty, 'an empty "Full name" box for the second child');
    await empty.fill(`${FAM.typed} 2`);
    const next = till.getByRole('button', { name: 'Continue', exact: true }).last();
    await expect(next).toBeEnabled({ timeout: 20000 });
    await next.click();
  }
  await gate.waitFor({ timeout: 30000 });
  const height = Number(process.env.GATE_HEIGHT ?? 768);
  await till.setViewportSize({ width: 1024, height });
  await till.waitForTimeout(1500);
  const boxes = till.getByPlaceholder("Child's name", { exact: true });
  const seen = await boxes.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top), visible: r.height > 0 && r.width > 0 }; }));
  receipt.checks.gateBoxes = { viewport: { width: 1024, height }, boxes: seen }; save();
  if (!seen.some((b) => b.visible)) odd(`the desk gate's name boxes are not visible at 1024x${height}: ${JSON.stringify(seen)}`);
  await expect(boxes.first()).toBeVisible({ timeout: 20000 });
  // An empty "Child's name" box when the gate offers one; else the last one, cleared and typed into.
  let target = null;
  for (const box of await boxes.all()) if ((await box.inputValue()) === '') { target = box; break; }
  target ??= boxes.last();
  await target.click();
  await target.fill('');
  await target.pressSequentially(FAM.typed, { delay: 40 });
  await till.waitForTimeout(800);
  const measured = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    return { typed: el.value.length > 0, fontSize: s.fontSize, boxHeight: Math.round(el.getBoundingClientRect().height), windowWidth: window.innerWidth,
      sideways: document.documentElement.scrollWidth > window.innerWidth };
  });
  const p3 = await shot(till, 'p3-desk-gate-1024-wide-name-typed.png');
  receipt.checks.gate = measured; save();
  point('3-gate-typed-size', measured.typed && measured.fontSize === '18px' && measured.windowWidth === 1024 && measured.boxHeight === 48 && !measured.sideways, [p3],
    'The desk gate at 1024 wide: a name typed in "Child\'s name" draws at the box\'s own 18 px inside the 48 px box', measured);
  await target.fill('');
  await till.getByRole('button', { name: 'Back', exact: true }).first().click().catch(() => odd('no Back on the gate'));
  await till.setViewportSize({ width: 1680, height: 1100 });
  await till.waitForTimeout(1500);
}

// ---- 2: the child's change with no answer at all, so the box lane takes it ----
async function pointTwo() {
  phase('2: wait until the box\'s copy of the members holds the family');
  const madeAt = Date.parse(family.createdAt ?? receipt.startedAt);
  let status = null;
  await expect.poll(async () => { status = await boxStatus(); return status.membersAppliedAt ? Date.parse(status.membersAppliedAt) > madeAt + 2000 : false; },
    { timeout: 240000, intervals: [10000] }).toBe(true);
  receipt.checks.boxBefore = status; save();

  phase('2: the family types the number again; "Who\'s visiting today?"; an allergy changed');
  const visiting = await openVisitingWindow();
  const card = cardOf(visiting, FAM.kid);
  const details = card.getByRole('button', { name: /Details/ });
  await details.waitFor({ timeout: 20000 });
  if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
  await card.getByLabel('Allergies / medical', { exact: true }).fill(FAM.allergy);
  const from = new Date(Date.now() - 5000).toISOString();

  const patches = [];
  const intents = [];
  const onPatch = async (route) => {
    const r = route.request();
    if (r.method() !== 'PATCH') return route.continue();
    const body = r.postDataJSON() ?? {};
    const key = r.headers()['idempotency-key'] ?? null;
    const response = await route.fetch();
    patches.push({ keyNamed: /^visit-child:[0-9a-f-]{36}$/.test(key ?? ''), actionIdIsKeyTail: Boolean(key) && body.actionId === key.slice(key.indexOf(':') + 1).slice(0, 64),
      actionId: body.actionId ?? null, platformStatus: response.status() });
    // No answer at all: the platform wrote it, the till hears nothing.
    await route.abort('connectionreset');
  };
  const onIntent = async (route) => {
    const r = route.request();
    const body = r.postDataJSON() ?? {};
    intents.push({ type: body.type ?? null, actionId: body.actionId ?? null });
    await route.continue();
  };
  const childPath = '**/api/members/children/' + childId;
  const intentPath = `**/api/box/v1/station/${station.id}/intents`;
  await till.route(childPath, onPatch);
  await till.route(intentPath, onIntent);
  phase('2: Confirm; the platform writes the change, the till hears nothing and moves it to the box');
  await visiting.getByRole('button', { name: /^Confirm 1 child/ }).click();
  const closed = await visiting.waitFor({ state: 'hidden', timeout: 45000 }).then(() => true).catch(() => false);
  if (!closed) odd('the visiting window stayed open after Confirm on the box lane');
  await till.waitForTimeout(1500);
  const p2a = await shot(till, 'p2a-visit-confirmed-on-the-box-lane.png');
  await till.unroute(childPath, onPatch);
  await till.unroute(intentPath, onIntent);

  phase('2: the box\'s sync: wait for its facts to reach the platform');
  const depths = [];
  let boxVisitRows = [];
  await expect.poll(async () => {
    const s = await boxStatus();
    depths.push(s.outboxDepth ?? null);
    boxVisitRows = (await visitRowsFor(family.id, from)).filter((row) => row.requestId === null);
    return boxVisitRows.length > 0 && s.outboxDepth === 0;
  }, { timeout: 180000, intervals: [5000] }).toBe(true).catch(() => odd('the box\'s visit fact was not read on the platform, or its outbox did not empty'));
  await till.waitForTimeout(8000);
  const rows = await childUpdateRows(from);
  const quarantine = await call('GET', `/ops/quarantine?boxId=${boxId}&limit=100`);
  const actionId = patches[0]?.actionId ?? null;
  const held = quarantine.status === 200 ? (quarantine.body.events ?? []).filter((e) => e.actionId === actionId || (e.type === 'child.update' && Date.parse(e.receivedAt) > Date.parse(from))) : null;
  const saved = (await call('GET', `/members/${family.id}`)).body?.member?.children?.find((ch) => ch.id === childId) ?? null;
  const childIntent = intents.find((i) => i.type === 'child.update') ?? null;
  receipt.checks.boxLane = {
    patches: patches.map(({ actionId: _a, ...rest }) => rest),
    intents: intents.map((i) => ({ type: i.type, actionIdIsTheOnlineOnes: i.type === 'child.update' ? i.actionId === actionId : null })),
    outboxDepthsSeen: depths,
    visitRowsFromTheBox: boxVisitRows.map((row) => row.action),
    childUpdateRows: rows.map((row) => ({ fromThisTillOnline: row.requestId !== null, allergiesIsTheChange: row.after?.allergies === FAM.allergy })),
    quarantineReadStatus: quarantine.status,
    quarantinedForThisChange: held?.length ?? null,
    allergyNowIsTheChange: saved?.allergies === FAM.allergy,
  };
  save();
  point('2-box-lane-once', patches.length === 1 && patches[0].platformStatus === 200 && patches[0].keyNamed && patches[0].actionIdIsKeyTail
    && Boolean(childIntent) && childIntent.actionId === actionId && boxVisitRows.length > 0 && depths.at(-1) === 0
    && rows.length === 1 && rows[0].requestId !== null && rows[0].after?.allergies === FAM.allergy && held?.length === 0 && saved?.allergies === FAM.allergy, [p2a],
  'The allergy change reached the platform but its reply never came; the till moved the change to the counter box under the same action id; once the box\'s facts were on the platform (its visit, outbox empty), the child has one child.update row, the online one, nothing in quarantine',
  receipt.checks.boxLane);
}

async function card(points) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const v = receipt.checks.visit ?? {}, b = receipt.checks.boxLane ?? {}, g = receipt.checks.gate ?? {};
  const row = (k, n) => `<tr><td>${k}</td><td><b>${n}</b></td></tr>`;
  await page.setContent(`<!doctype html><html><body style="font:16px system-ui;margin:24px;background:#fff;color:#111">
    <h2 style="margin:0 0 4px">SCRUM-1060 staging test run: a save retried after a lost connection is written once</h2>
    <p style="margin:0 0 16px;color:#555">Own ZZ TEST till on the simulated box, Central Floresta, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, release ${sha.slice(0, 9)}. A ZZ TEST family; no sale paid.</p>
    <table cellpadding="6" style="border-collapse:collapse;min-width:900px" border="1">
    <tr style="background:#f2f2f2"><th align="left">What was counted</th><th align="left">Count</th></tr>
    ${row('1. Visit create sent (first reply lost at the edge, then Confirm again)', (v.sends ?? []).length)}
    ${row('1. ... both sends under the same visit id and key', (v.sends ?? []).every((s) => s.sameKeyAsFirst && s.sameIdAsFirst) ? 'yes' : 'no')}
    ${row('1. Visits the family has from this (visit.create rows)', v.distinctVisits ?? '?')}
    ${row('2. Allergy change sent online (written, no answer at all)', (b.patches ?? []).length)}
    ${row('2. Same change sent to the counter box under the same action id', (b.intents ?? []).filter((i) => i.actionIdIsTheOnlineOnes === true).length)}
    ${row('2. Box facts that reached the platform (its visit)', (b.visitRowsFromTheBox ?? []).length)}
    ${row('2. Box outbox after its sync', (b.outboxDepthsSeen ?? []).at(-1) ?? '?')}
    ${row('2. child.update rows in the activity log for that change', (b.childUpdateRows ?? []).length)}
    ${row('2. Box facts for it held in quarantine', b.quarantinedForThisChange ?? '?')}
    ${row('3. Desk gate at 1024 wide: typed name size / box height', `${g.fontSize ?? '?'} / ${g.boxHeight ?? '?'}px`)}
    </table></body></html>`);
  const name = await shot(page, 'p4-test-run-card-counts.png', page, []);
  await page.close();
  return name;
}

try {
  phase('deployments');
  receipt.deployments = {};
  for (const name of ['oto-api-staging', 'oto-pos-staging', 'oto-pos-web-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=10`)).map((x) => x.deploy).find((x) => x.status === 'live');
    receipt.deployments[name] = { id: d?.id, status: d?.status, sha: d?.commit?.id };
  }
  save();
  const { execSync } = await import('node:child_process');
  for (const name of ['oto-api-staging', 'oto-pos-staging', 'oto-pos-web-staging']) {
    execSync(`git merge-base --is-ancestor ${sha} ${receipt.deployments[name].sha}`, { cwd: repo });
    receipt.deployments[name].containsProvedSha = true;
  }
  phase('sign in and create own till and a returning ZZ TEST family');
  await adminSignIn();
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find((b) => /Central Floresta/.test(b.name));
  assert.ok(branch); branchId = branch.id;
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find((b) => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online'); boxId = box.id;
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const printerSource = stations.find((s) => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every((role) => s.devices.some((d) => d.role === role)));
  assert.ok(printerSource, 'simulated printers already configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map((role) => ({ role, deviceId: printerSource.devices.find((d) => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z060${String(i + 1).padStart(2, '0')}`).find((p) => !stations.some((s) => s.codePrefix === p));
  assert.ok(prefix);
  assert.equal(await lookup(FAM.number), null, 'the ZZ TEST number must be unused');
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();
  const member = await call('POST', '/members', { phone: FAM.number, nickname: FAM.name, createdVia: 'pos' });
  assert.equal(member.status, 200);
  family = member.body.member ?? member.body;
  family.createdAt = new Date().toISOString();
  receipt.created.push({ kind: 'member', id: family.id }); save();
  // Point 3 on its own (ONLY=3) takes a family with no saved child, so the sale's two
  // children are anonymous and the desk gate opens straight after Continue, as a first visit's does.
  if (process.env.ONLY !== '3') {
    const kid = await call('POST', `/members/${family.id}/children`, { name: FAM.kid, dateOfBirth: '2019-05-01' });
    assert.equal(kid.status, 200);
    childId = (kid.body.child ?? kid.body).id;
    receipt.created.push({ kind: 'child', id: childId }); save();
  }

  browser = await chromium.launch({ channel: 'msedge' });
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  watch(till, 'till');
  await till.goto(pos);
  phase('reception signs in at the own till');
  await signInAtTill(till);
  // Point 3 on its own runs with no display paired, so the till draws the desk gate's own boxes.
  if (process.env.ONLY !== '3') await pairDisplay('A');
  await till.waitForTimeout(4000);

  // ONLY=3 runs one point again on a fresh family and till (a run that proved the others already).
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [key, fn] of [['1', pointOne], ['3', pointThree], ['2', pointTwo]].filter(([k]) => !only || only.includes(k))) {
    try { await fn(); }
    catch (error) {
      failed = true;
      (receipt.failures ??= []).push({ point: key, failedAt: receipt.phase, failure: firstLine(error) });
      save(); console.log('POINT FAILED', key, '|', receipt.phase, '|', firstLine(error));
      if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
      for (const d of displays) await shot(d.page, `failed-${key}-display-${d.letter}.png`).catch(() => {});
    }
  }
  if (!only) await card().catch((error) => odd(`card: ${firstLine(error)}`));
  const expected = ['1-visit-create-once', '2-box-lane-once', '3-gate-typed-size'].filter((k) => !only || only.includes(k[0]));
  receipt.passed = !failed && expected.every((k) => receipt.points[k]?.pass === true);
} catch (error) {
  failed = true; receipt.passed = false; receipt.failure = { phase: receipt.phase, failure: firstLine(error) };
  console.log('RUN FAILED', '|', receipt.phase, '|', firstLine(error));
  if (till) await shot(till, 'failed-run-till.png').catch(() => {});
} finally {
  phase('clean up');
  const clean = async (step, action) => {
    try { await action(); }
    catch (error) { failed = true; (receipt.cleanupFailures ??= []).push({ step, failure: firstLine(error) }); console.log('CLEANUP FAILED', step, '|', firstLine(error)); }
    save();
  };
  for (const d of [...displays]) await clean(`unpair display ${d.letter}`, () => dropDisplay(d));
  if (station) {
    let sales = [];
    await clean('read own sales', async () => { sales = await stationSales(); for (const s of sales) assert.equal(s.stationId, station.id); });
    for (const sale of sales.filter((s) => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
      assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: 'ZZ TEST SCRUM-1060 proof cleanup' })).status, 200);
      receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided' });
    });
    await clean('final sales read-back', async () => {
      const final = await stationSales();
      receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map((s) => ({ id: s.id, status: s.status, grossSatang: s.totals?.grossSatang ?? null })) });
    });
    await clean('retire own till', async () => {
      assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
      assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
      receipt.cleanup.push({ kind: 'station', id: station.id, archived: true });
    });
  }
  if (process.env.KEEP_FAMILY !== '1') await clean('archive the ZZ TEST family', async () => {
    const found = await lookup(FAM.number);
    if (!found) { receipt.cleanup.push({ kind: 'member', none: true }); return; }
    assert.ok(String(found.nickname).startsWith('ZZ TEST SCRUM-1060'), 'only own test member');
    assert.equal((await call('DELETE', `/members/${found.id}`)).status, 200);
    assert.equal(await lookup(FAM.number), null);
    receipt.cleanup.push({ kind: 'member', id: found.id, archived: true });
  });
  if (till) await clean('sign out till', async () => {
    if ((await till.request.get('/api/me')).status() === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.cleanup.push({ kind: 'till-session', signedOut: true });
  });
  await clean('sign out admin', async () => {
    if ((await admin.get('/api/me')).status() === 200) assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.pass])), failures: receipt.failures ?? [], odd: receipt.odd.length, pageErrors: receipt.pageErrors.length, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
