// SCRUM-1024 — staging proof of family profiles, steps F1 and F2 (tables,
// writers, switch off; nothing reads a family yet). What it shows: the api is
// live and healthy after migration 0136, and the till's membership check, a
// saved child added to a NEW ZZ TEST family and a second lookup of that family
// behave as before. The new rows themselves are not read here: that needs the
// database, which this proof never touches.
// Run from the lane worktree: node docs/qa/proof-2026-11-19/SCRUM-1024/proof.mjs <full-sha> <run>
// No credentials, phone numbers or raw response bodies enter the receipt.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const { chromium, request, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
const run = Number(process.argv[3] ?? '1');
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
assert.ok(run >= 1 && run <= 9);
const out = import.meta.dirname;
const pos = 'https://oto-pos-web-staging.onrender.com';
const STATION_NAME = 'ZZ TEST setup traps 20261102';
const phone = `089102400${run}`; // ZZ TEST only; one per run.
const family = `ZZ TEST SCRUM-1024 family ${run}`;
const childName = `ZZ TEST Mali ${run}`;
const receipt = { ticket: 'SCRUM-1024', sha, run, startedAt: new Date().toISOString(), phase: 'preflight', requests: [], created: [], checks: {}, cleanup: [], pictures: [], pageErrors: [] };
mkdirSync(out, { recursive: true });
const save = () => writeFileSync(resolve(out, `receipt-${run}.json`), JSON.stringify(receipt, null, 2) + '\n');
const phase = (value) => { receipt.phase = value; save(); console.log('phase:', value); };

const admin = await request.newContext({ baseURL: pos });
const call = async (method, path, data) => {
  const response = await admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }),
    headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  receipt.requests.push({ by: 'admin', method, path: path.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id'), status: response.status() }); save();
  return { status: response.status(), body: await response.json().catch(() => null) };
};
let browser, tillContext, till, station, memberId, childId;
let failed = false;
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
      page.locator('input[type="tel"], input[inputmode="tel"]'), page.getByText(/\+66[\d ]+/)] });
  receipt.pictures.push(name); save();
};
const halfOf = (l) => l.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = (page) => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
/** A UUIDv7, as the till mints a child id. */
const uuidv7 = () => {
  const b = randomBytes(16); const t = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const keypad = async (scope, digits) => { for (const d of digits) await scope.getByRole('button', { name: d, exact: true }).last().click(); };

/** The till's customer half: the number, then Continue. */
async function giveNumber() {
  await landing(till).waitFor();
  if (await till.getByTestId('language-choice').isVisible()) await till.getByTestId('language-choice-en').click();
  await till.getByTestId('identify-safety').waitFor();
  const scope = halfOf(till.getByTestId('identify-safety'));
  const own = (await scope.count()) > 0 ? scope : till;
  await keypad(own, phone);
  await own.getByRole('button', { name: 'Continue', exact: true }).click();
}

try {
  phase('the api runs the landed source, healthy and ready');
  const svc = await service('oto-api-staging');
  const d = (await render('GET', `/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
  assert.equal(d?.status, 'live', 'oto-api-staging is live');
  assert.equal(d.commit.id, sha, 'oto-api-staging runs the proved source');
  receipt.deployments = { 'oto-api-staging': { id: d.id, status: d.status, sha: d.commit.id, finishedAt: d.finishedAt } };
  for (const name of ['oto-pos-web-staging']) {
    const s = await service(name);
    const x = (await render('GET', `/services/${s.id}/deploys?limit=1`))[0]?.deploy;
    receipt.deployments[name] = { id: x?.id, status: x?.status, sha: x?.commit?.id, note: 'not redeployed: the lane changed no screen' };
  }
  const apiUrl = svc.serviceDetails?.url;
  assert.ok(apiUrl, 'the api has a public address');
  const probe = await request.newContext();
  const health = await probe.get(`${apiUrl}/health`);
  const ready = await probe.get(`${apiUrl}/ready`);
  const readyBody = await ready.json().catch(() => null);
  receipt.checks.health = { status: health.status(), body: await health.json().catch(() => null) };
  receipt.checks.ready = { status: ready.status(), state: readyBody?.status ?? null, database: readyBody?.checks?.database ?? null };
  await probe.dispose(); save();
  assert.equal(health.status(), 200, '/health answers 200');
  assert.equal(ready.status(), 200, '/ready answers 200');

  phase('sign in (admin api) and find the ZZ TEST station');
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await call('GET', '/branches')).body;
  for (const branch of branches.branches ?? branches) {
    const stations = (await call('GET', `/branches/${branch.id}/stations`)).body?.stations ?? [];
    const found = stations.find((s) => s.name === STATION_NAME && !s.archived);
    if (found) { station = { ...found, branchId: branch.id }; break; }
  }
  assert.ok(station, 'the ZZ TEST station exists');
  receipt.station = { id: station.id, name: station.name }; save();
  assert.equal((await call('GET', `/members/lookup?phone=${phone}`)).body.member, null, 'the ZZ TEST number is unused');

  phase('the till signs in at the ZZ TEST station');
  browser = await chromium.launch({ channel: 'msedge' });
  tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  till.on('pageerror', (e) => { receipt.pageErrors.push({ at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 200) }); });
  till.on('response', (r) => { const u = new URL(r.url()); if (r.status() >= 400 && /\/api\//.test(u.pathname)) receipt.pageErrors.push({ at: receipt.phase, kind: 'http', text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` }); });
  await till.goto(pos);
  await till.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await till.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await till.getByRole('button', { name: 'Sign in', exact: true }).click();
  await till.getByRole('button', { name: STATION_NAME, exact: false }).first().click();
  await till.waitForTimeout(6000);
  for (let i = 0; i < 12 && await till.getByText('Another till is using this station').first().isVisible().catch(() => false); i += 1) {
    await till.waitForTimeout(10000);
  }
  receipt.checks.leaseFree = !(await till.getByText('Another till is using this station').first().isVisible().catch(() => false)); save();
  await landing(till).waitFor({ timeout: 20000 }).catch(async () => { await till.goto('/'); await landing(till).waitFor(); });

  phase('membership check with a new ZZ TEST number: the till makes the member');
  await giveNumber();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  const typeStep = till.getByRole('heading', { name: 'Select Customer Type', exact: true });
  await expect.poll(async () => (await offer.isVisible()) || (await typeStep.isVisible()), { timeout: 30000 }).toBe(true);
  if (await offer.isVisible()) {
    await offer.getByPlaceholder('e.g. Mali').fill(family);
    await shot(till, `01-till-new-member-offer-run${run}.png`);
    await offer.getByRole('button', { name: 'Create member', exact: true }).click();
    await offer.waitFor({ state: 'hidden' });
  }
  await typeStep.waitFor();
  await expect(till.getByText(family, { exact: true }).first()).toBeVisible();
  await shot(till, `02-till-member-made-run${run}.png`);
  const made = (await call('GET', `/members/lookup?phone=${phone}`)).body.member;
  assert.ok(made, 'the member exists');
  memberId = made.id;
  receipt.created.push({ kind: 'member', id: memberId, via: 'till membership check' }); save();
  receipt.checks.memberMade = { nickname: made.nickname, children: (made.children ?? []).length };

  phase('a saved child added to the new family, on the till session');
  // The request the till's "children playing alone" step sends (POST
  // /members/:id/children with a child id the till mints), on the till's own
  // session at the ZZ TEST station. Sent twice with the same id and key: a
  // retried request must answer the same child.
  childId = uuidv7();
  const key = randomUUID();
  const body = { id: childId, name: childName, dateOfBirth: '2021-02-01', ageYears: 5, allergies: 'ZZ TEST peanuts' };
  const first = await till.request.post(`/api/members/${memberId}/children`, { data: body, headers: { 'idempotency-key': key } });
  const firstBody = await first.json().catch(() => null);
  const again = await till.request.post(`/api/members/${memberId}/children`, { data: body, headers: { 'idempotency-key': key } });
  const againBody = await again.json().catch(() => null);
  receipt.requests.push({ by: 'till', method: 'POST', path: '/members/:id/children', status: first.status() }, { by: 'till', method: 'POST', path: '/members/:id/children (same key)', status: again.status() });
  assert.equal(first.status(), 200, 'the child is saved');
  childId = firstBody.child.id;
  receipt.created.push({ kind: 'child', id: childId, name: childName }); save();
  receipt.checks.childAnswer = { keys: Object.keys(firstBody.child).sort(), hasFamilyField: 'familyId' in firstBody.child || 'mergedIntoChildId' in firstBody.child,
    replay: { status: again.status(), sameChild: againBody?.child?.id === childId } };
  save();
  assert.equal(receipt.checks.childAnswer.hasFamilyField, false, 'the child answer carries no family field');
  assert.equal(again.status(), 200); assert.equal(againBody.child.id, childId, 'a replay answers the same child');

  phase('the family looked up again on the till: the saved child is offered');
  await till.goto('/');
  await giveNumber();
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  await visiting.waitFor();
  await expect(visiting.getByText(childName, { exact: false }).first()).toBeVisible();
  await shot(till, `03-till-lookup-offers-saved-child-run${run}.png`);
  const lookedUp = (await call('GET', `/members/lookup?phone=${phone}`)).body.member;
  const asRead = (lookedUp.children ?? []).find((c) => c.id === childId);
  receipt.checks.lookup = { children: (lookedUp.children ?? []).map((c) => c.name), childKeys: Object.keys(asRead ?? {}).sort(),
    memberKeys: Object.keys(lookedUp).sort(), hasFamilyField: Boolean(asRead && ('familyId' in asRead || 'mergedIntoChildId' in asRead)) || 'families' in lookedUp || 'familyId' in lookedUp };
  save();
  assert.deepEqual(receipt.checks.lookup.children, [childName], 'the lookup holds exactly the one saved child');
  assert.equal(receipt.checks.lookup.hasFamilyField, false, 'the lookup answer carries no family field');
  await visiting.getByRole('button', { name: 'Skip for now', exact: true }).click();
  await visiting.waitFor({ state: 'hidden' });

  phase('audit rows: the child is audited as before, no family row in the trail');
  const childTrail = (await call('GET', `/audit?entityId=${childId}&limit=20`)).body?.entries ?? [];
  const memberTrail = (await call('GET', `/audit?entityId=${memberId}&limit=20`)).body?.entries ?? [];
  const created = childTrail.find((r) => r.action === 'child.create');
  receipt.checks.audit = { child: childTrail.map((r) => ({ action: r.action, entityType: r.entityType, afterHasFamily: Boolean(r.after && ('familyId' in r.after || 'mergedIntoChildId' in r.after)) })),
    member: memberTrail.map((r) => ({ action: r.action, entityType: r.entityType })) };
  save();
  assert.ok(created, 'child.create is audited');
  assert.equal(childTrail.filter((r) => r.action === 'child.create').length, 1, 'one child.create for a replayed request');
  assert.ok(![...childTrail, ...memberTrail].some((r) => String(r.action).startsWith('family') || r.entityType === 'family'), 'no family row in the trail');

  receipt.passed = true;
} catch (error) {
  failed = true; receipt.passed = false;
  receipt.failure = { phase: receipt.phase, kind: error.name, message: String(error.message ?? '').split('\n')[0].slice(0, 300) };
  if (till) await shot(till, `failed-till-run${run}.png`).catch(() => {});
} finally {
  const clean = async (step, action) => {
    try { await action(); } catch (error) { failed = true; (receipt.cleanupFailures ??= []).push({ step, kind: error.name, message: String(error.message ?? '').slice(0, 200) }); }
    save();
  };
  if (station) await clean('no sale left on the station', async () => {
    const sales = (await call('GET', `/sales?branchId=${station.branchId}&stationId=${station.id}&limit=20`)).body?.sales ?? [];
    const mine = sales.filter((s) => (s.status === 'tendering' || s.status === 'open') && new Date(s.createdAt) >= new Date(receipt.startedAt));
    for (const sale of mine) {
      assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: 'ZZ TEST SCRUM-1024 proof cleanup' })).status, 200);
      receipt.cleanup.push({ kind: 'sale', id: sale.id, voided: true });
    }
    receipt.cleanup.push({ kind: 'sales-checked', open: mine.length });
  });
  if (memberId) await clean('archive the ZZ TEST family', async () => {
    const member = (await call('GET', `/members/${memberId}`)).body.member;
    assert.ok(member.nickname.startsWith('ZZ TEST SCRUM-1024'), 'only the own test member');
    assert.equal((await call('DELETE', `/members/${memberId}`)).status, 200);
    assert.equal((await call('GET', `/members/lookup?phone=${phone}`)).body.member, null);
    receipt.cleanup.push({ kind: 'member', id: memberId, archived: true });
  });
  if (till) await clean('sign out till', async () => {
    const signedOut = await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
    assert.equal(signedOut.status(), 200);
    receipt.cleanup.push({ kind: 'till-session', signedOut: true });
  });
  await clean('sign out admin', async () => {
    assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, failure: receipt.failure ?? null, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
