// SCRUM-846 staging proof. Adapted from docs/qa/proof-2026-11-11/SCRUM-809/staging/proof.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

const root = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(root, 'scripts/agent/env.mjs')));
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(root, 'docs/qa/proof-2026-11-11/SCRUM-846/staging');
mkdirSync(out, { recursive: true });
const receipt = { ticket: 'SCRUM-846', sha, apiDeploy: JSON.parse(process.argv[3] ?? 'null'),
  startedAt: new Date().toISOString(), requests: [], created: [], steps: {}, cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); };
const origin = 'https://oto-console-staging.onrender.com';
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Bangkok' });
ctx.setDefaultTimeout(30000);
const page = await ctx.newPage();
let branchId;
const owned = new Map(); // id -> current name
let failed = false;
const call = async (method, path, data) => {
  const r = await ctx.request.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }),
    headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  receipt.requests.push({ via: 'api', method, path, status: r.status() }); save();
  return { status: r.status(), body: await r.json().catch(() => null) };
};
const list = async () => {
  const r = await call('GET', `/branches/${branchId}/stations?includeArchived=true`);
  assert.equal(r.status, 200);
  return r.body.stations;
};
const shot = async filename => {
  await page.screenshot({ path: resolve(out, filename), animations: 'disabled',
    mask: [page.getByRole('button', { name: 'Sign out', exact: true }).locator('..')] });
};
const formResponse = (method, path) => page.waitForResponse(r => new URL(r.url()).pathname === `/api${path}` && r.request().method() === method);
const logForm = (method, path, status, extra = {}) => { receipt.requests.push({ via: 'form', method, path, status, ...extra }); save(); };
const card = name => page.getByRole('listitem').filter({ has: page.getByRole('button', { name, exact: true }) });
const openCard = async name => {
  await page.getByRole('button', { name, exact: true }).click();
  const drawer = page.getByRole('dialog', { name, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
};
// 'QR' alone also begins the 'QR terminal' device label, so the field is found by its exact caption.
const routeSelect = (drawer, caption) => drawer.locator('label').filter({ has: page.locator('span', { hasText: new RegExp('^' + caption + '$') }) }).locator('select');
const pick = (row) => ({ name: row.name, codePrefix: row.codePrefix, paymentRouting: row.paymentRouting, configVersion: row.configVersion, archived: row.archived });
try {
  phase('Console sign-in');
  await page.goto(origin);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/overview$/);
  const branches = await call('GET', '/branches');
  assert.equal(branches.status, 200);
  const park = (branches.body.branches ?? branches.body).find(b => /Central Floresta/.test(b.name));
  assert.ok(park); branchId = park.id;
  const boxes = await call('GET', `/branches/${branchId}/boxes`);
  assert.equal(boxes.status, 200);
  const box = boxes.body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && !b.archived);
  assert.ok(box);
  const before = await list();
  const unused = Array.from({ length: 99 }, (_, i) => `Z846${String(i + 1).padStart(2, '0')}`).filter(p => !before.some(s => s.codePrefix === p));
  assert.ok(unused.length >= 3);
  const [P, Q, R] = unused;
  const suffix = Date.now();
  const nameA = `ZZ TEST SCRUM-846 till A ${suffix}`;
  const nameB = `ZZ TEST SCRUM-846 till B ${suffix}`;
  const nameB2 = `ZZ TEST SCRUM-846 till B renamed ${suffix}`;
  receipt.prefixes = { P, Q, R }; receipt.names = { nameA, nameB, nameB2 }; save();

  phase('open Console Devices > Stations');
  await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Branch').selectOption(branchId);
  await page.getByRole('button', { name: 'Stations', exact: true }).click();
  await page.getByPlaceholder('Name, identifier or type').fill('ZZ TEST SCRUM-846');

  const createInForm = async (name, prefix) => {
    await page.getByRole('button', { name: 'New station', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'New station', exact: true });
    await drawer.getByLabel(/^Box/).selectOption(box.id);
    await drawer.getByLabel(/^Name/).fill(name);
    await drawer.getByLabel(/^Code prefix/).fill(prefix);
    const waiting = formResponse('POST', `/branches/${branchId}/stations`);
    await drawer.getByRole('button', { name: 'Create the station', exact: true }).click();
    const res = await waiting;
    const body = await res.json().catch(() => null);
    logForm('POST', `/branches/${branchId}/stations`, res.status(), { id: body?.station?.id });
    assert.equal(res.status(), 200);
    const st = body.station;
    owned.set(st.id, name); receipt.created.push({ kind: 'station', id: st.id, name }); save();
    assert.equal(st.name, name); assert.equal(st.codePrefix, prefix); assert.equal(st.kind, 'till');
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    return st;
  };

  phase('step 1: create till A with prefix P, archive it');
  const a = await createInForm(nameA, P);
  {
    const drawer = await openCard(nameA);
    const waiting = formResponse('DELETE', `/stations/${a.id}`);
    await drawer.getByRole('button', { name: 'Archive this station', exact: true }).click();
    const res = await waiting;
    logForm('DELETE', `/stations/${a.id}`, res.status());
    assert.equal(res.status(), 200);
    await expect(drawer).toHaveCount(0);
  }
  const aBack = (await list()).find(s => s.id === a.id);
  assert.equal(aBack?.archived, true); assert.equal(aBack.codePrefix, P);
  receipt.steps.step1 = { pass: true, tillA: a.id, prefix: P, create: 200, archive: 200, readBackArchived: true }; save();

  phase('step 2: create till B with free prefix Q');
  const b = await createInForm(nameB, Q);
  await expect(card(nameB)).toContainText(Q);
  receipt.steps.step2 = { pass: true, tillB: b.id, prefix: Q, create: 200 }; save();

  const patchPath = `/stations/${b.id}`;
  const saveForm = async drawer => {
    const waiting = formResponse('PATCH', patchPath);
    await drawer.getByRole('button', { name: 'Save the station', exact: true }).click();
    const res = await waiting;
    const body = await res.json().catch(() => null);
    return { status: res.status(), body };
  };

  phase('step 3a: rename till B, prefix untouched');
  {
    const drawer = await openCard(nameB);
    await expect(drawer.getByLabel(/^Code prefix/)).toHaveValue(Q);
    await drawer.getByLabel(/^Name/).fill(nameB2);
    const res = await saveForm(drawer);
    logForm('PATCH', patchPath, res.status, { change: 'name', code: res.body?.error?.code });
    assert.equal(res.status, 200);
    owned.set(b.id, nameB2);
    await expect(drawer).toHaveCount(0);
    await expect(card(nameB2)).toContainText(Q);
    await card(nameB2).scrollIntoViewIfNeeded();
    const row = (await list()).find(s => s.id === b.id);
    assert.equal(row.name, nameB2); assert.equal(row.codePrefix, Q);
    receipt.steps.step3rename = { pass: true, status: 200, readBack: pick(row) }; save();
    await shot('846-1-renamed-prefix-kept.png');
  }

  phase('step 3b: change till B payment routing, prefix untouched');
  {
    const drawer = await openCard(nameB2);
    await expect(drawer.getByLabel(/^Code prefix/)).toHaveValue(Q);
    await routeSelect(drawer, 'Cards').selectOption('manual');
    await routeSelect(drawer, 'QR').selectOption('none');
    const res = await saveForm(drawer);
    logForm('PATCH', patchPath, res.status, { change: 'paymentRouting', code: res.body?.error?.code });
    assert.equal(res.status, 200);
    await expect(drawer).toHaveCount(0);
    await expect(card(nameB2)).toContainText(Q);
    await card(nameB2).scrollIntoViewIfNeeded();
    const row = (await list()).find(s => s.id === b.id);
    assert.equal(row.name, nameB2); assert.equal(row.codePrefix, Q);
    assert.equal(row.paymentRouting?.card, 'manual'); assert.equal(row.paymentRouting?.qr, 'none');
    receipt.steps.step3routing = { pass: true, status: 200, readBack: pick(row) }; save();
    await shot('846-2-routing-changed-prefix-kept.png');
  }

  phase('step 4: change till B prefix to archived till A prefix P');
  const beforeRefusal = pick((await list()).find(s => s.id === b.id));
  const drawer = await openCard(nameB2);
  await drawer.getByLabel(/^Code prefix/).fill(P);
  {
    const res = await saveForm(drawer);
    logForm('PATCH', patchPath, res.status, { change: 'codePrefix -> P', code: res.body?.error?.code });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STATION_CODE_PREFIX_TAKEN');
    assert.equal(res.body.error.details?.stationId, a.id);
    const alert = drawer.getByRole('alert');
    await expect(alert).toContainText(nameA);
    await expect(alert).toContainText('archiving a till does not free its receipt numbers');
    const words = (await alert.innerText()).trim();
    const afterRefusal = pick((await list()).find(s => s.id === b.id));
    assert.deepEqual(afterRefusal, beforeRefusal);
    receipt.steps.step4 = { pass: true, status: 409, code: res.body.error.code, namesTillA: true, words, tillBUnchanged: true, readBack: afterRefusal }; save();
    await shot('846-3-archived-prefix-refused.png');
  }

  phase('step 5: change till B prefix to free R in the same form');
  await drawer.getByLabel(/^Code prefix/).fill(R);
  {
    const res = await saveForm(drawer);
    logForm('PATCH', patchPath, res.status, { change: 'codePrefix -> R', code: res.body?.error?.code });
    assert.equal(res.status, 200);
    await expect(drawer).toHaveCount(0);
    await expect(card(nameB2)).toContainText(R);
    await card(nameB2).scrollIntoViewIfNeeded();
    const row = (await list()).find(s => s.id === b.id);
    assert.equal(row.codePrefix, R); assert.equal(row.name, nameB2);
    receipt.steps.step5 = { pass: true, status: 200, readBack: pick(row) }; save();
    await shot('846-4-free-prefix-saved.png');
  }
  phase('steps complete');
} catch (error) {
  failed = true;
  // Browser errors may contain input values; retain only the kind and phase.
  receipt.failure = { kind: error.name, callsite: error.stack?.split('\n').filter(line => /^\s+at .*proof\.mjs:\d+:\d+/.test(line)) };
  await shot('846-failed-attempt.png').catch(() => {}); save();
} finally {
  for (const [id, name] of owned) {
    try {
      const row = (await list()).find(s => s.id === id);
      assert.equal(row?.name, name); assert.ok(name.startsWith('ZZ TEST SCRUM-846 '));
      if (!row.archived) assert.equal((await call('DELETE', `/stations/${id}`)).status, 200);
      assert.equal((await list()).find(s => s.id === id)?.archived, true);
      receipt.cleanup.push({ kind: 'station', id, name, archived: true });
    } catch (error) { failed = true; receipt.cleanup.push({ kind: 'station', id, error: error.name }); }
    save();
  }
  try {
    const signedOut = await call('POST', '/auth/sign-out');
    assert.ok([200, 204].includes(signedOut.status));
    assert.equal((await call('GET', '/me')).status, 401);
    receipt.cleanup.push({ kind: 'session', signedOut: true, me: 401 });
  } catch (error) { failed = true; receipt.cleanup.push({ kind: 'session', error: error.name }); }
  await browser.close();
  receipt.passed = !failed; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, steps: receipt.steps, failure: receipt.failure, created: receipt.created, cleanup: receipt.cleanup }, null, 1));
if (failed) process.exitCode = 1;
