// SCRUM-1014 — staging proof: the family adds and removes saved children on
// the customer display of the ZZ TEST station, and the till shows each change.
// Run from the lane worktree: node docs/qa/proof-2026-11-19/SCRUM-1014/proof.mjs <full-sha> <run>
// No credentials, pairing code, phone or raw response bodies enter the receipt.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const phone = `089101400${run}`; // ZZ TEST only; one per run.
const family = `ZZ TEST SCRUM-1014 family ${run}`;
const receipt = { ticket: 'SCRUM-1014', sha, run, startedAt: new Date().toISOString(), phase: 'preflight', requests: [], created: [], checks: {}, cleanup: [], pictures: [] };
mkdirSync(out, { recursive: true });
const save = () => writeFileSync(resolve(out, `receipt-${run}.json`), JSON.stringify(receipt, null, 2) + '\n');
const phase = (value) => { receipt.phase = value; save(); console.log('phase:', value); };

async function deployments() {
  const result = {};
  for (const name of ['oto-api-staging', 'oto-pos-staging', 'oto-pos-web-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
    assert.equal(d?.status, 'live', `${name} is live`);
    assert.equal(d.commit.id, sha, `${name} runs the proved source`);
    result[name] = { id: d.id, status: d.status, sha: d.commit.id };
  }
  return result;
}

const admin = await request.newContext({ baseURL: pos });
const call = async (method, path, data) => {
  const response = await admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }),
    headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  receipt.requests.push({ method, path: path.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id'), status: response.status() }); save();
  return { status: response.status(), body: await response.json().catch(() => null) };
};
let browser, tillContext, displayContext, till, display, station, displayId, memberId;
let failed = false;
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.locator('input[type="password"]'), page.getByTestId('display-pairing-code'),
      page.locator('input[type="tel"], input[inputmode="tel"]'), page.getByText(/^\+66[\d ]+$/)] });
  receipt.pictures.push(name); save();
};
const keypad = async (page, digits) => { for (const digit of digits) await page.getByRole('button', { name: digit, exact: true }).last().click(); };

try {
  receipt.deployments = await deployments(); save();
  phase('sign in (admin api) and find the ZZ TEST station');
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await call('GET', '/branches')).body;
  for (const branch of branches.branches ?? branches) {
    const stations = (await call('GET', `/branches/${branch.id}/stations`)).body?.stations ?? [];
    const found = stations.find((s) => s.name === STATION_NAME && !s.archived);
    if (found) { station = { ...found, branchId: branch.id }; break; }
  }
  assert.ok(station, 'the ZZ TEST station exists');
  assert.ok(station.boxId, 'the ZZ TEST station is on a box');
  receipt.station = { id: station.id, name: station.name }; save();

  phase('make the ZZ TEST family through the app routes');
  assert.equal((await call('GET', `/members/lookup?phone=${phone}`)).body.member, null, 'the ZZ TEST number is unused');
  const made = await call('POST', '/members', { phone, nickname: family });
  assert.equal(made.status, 200); memberId = made.body.member.id;
  receipt.created.push({ kind: 'member', id: memberId }); save();
  const kids = [];
  for (const kid of [{ name: 'ZZ TEST Aya', dateOfBirth: '2020-03-01', ageYears: 6 }, { name: 'ZZ TEST Ben', dateOfBirth: '2018-06-01', ageYears: 8 }]) {
    const c = await call('POST', `/members/${memberId}/children`, kid);
    assert.equal(c.status, 200); kids.push(c.body.child);
    receipt.created.push({ kind: 'child', id: c.body.child.id, name: kid.name }); save();
  }

  phase('till signs in at the ZZ TEST station; a display is paired to it');
  browser = await chromium.launch({ channel: 'msedge' });
  tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  displayContext = await browser.newContext({ baseURL: pos, viewport: { width: 1024, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  tillContext.setDefaultTimeout(30000); displayContext.setDefaultTimeout(30000);
  till = await tillContext.newPage(); display = await displayContext.newPage();
  await till.goto(pos);
  await till.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await till.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await till.getByRole('button', { name: 'Sign in', exact: true }).click();
  await till.getByRole('button', { name: STATION_NAME, exact: false }).first().click();
  // A till that just left the station holds its lease for a minute (STATION_LEASE_TTL_S).
  await till.waitForTimeout(6000);
  for (let i = 0; i < 12 && await till.getByText('Another till is using this station').first().isVisible().catch(() => false); i += 1) {
    await till.waitForTimeout(10000);
  }
  receipt.checks.leaseFree = !(await till.getByText('Another till is using this station').first().isVisible().catch(() => false)); save();
  await display.goto(`${pos}/display`);
  await display.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await display.getByTestId('display-pairing-code').textContent()).trim();
  assert.match(pairingCode, /^\d{6}$/);
  const paired = await call('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: `ZZ TEST SCRUM-1014 display ${run}` });
  assert.equal(paired.status, 200); displayId = paired.body.device.id;
  receipt.created.push({ kind: 'display', id: displayId }); save();

  phase('the family gives their number on the display');
  await display.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first().waitFor();
  if (await display.getByTestId('language-choice').isVisible()) await display.getByTestId('language-choice-en').click();
  await display.getByTestId('identify-safety').waitFor();
  await keypad(display, phone);
  await display.getByRole('button', { name: 'Continue', exact: true }).click();
  const visiting = till.getByRole('dialog').filter({ hasText: "Who's visiting today?" });
  await visiting.waitFor();
  await visiting.getByRole('button', { name: 'Skip for now', exact: true }).click();
  await till.waitForTimeout(1500);
  await shot(till, `explore-${run}-till-after-identify.png`);

  phase('two children playing alone: the review opens');
  const { ringUp } = await import(pathToFileURL(resolve(out, 'flow.mjs')));
  await ringUp({ till, display, expect, phase, shot, run });

  phase('the review on the display');
  const review = display.getByTestId('display-child-review');
  await review.waitFor();
  await expect(review.getByText('We saved their details from last time — check each one and confirm.')).toBeVisible();
  await shot(display, `01-display-review-saved-children-run${run}.png`);
  await shot(till, `02-till-review-before-run${run}.png`);

  phase('the family removes Ben from their saved children');
  const cards = review.getByTestId('saved-child-review-card');
  const benIndex = (await cards.evaluateAll((els) => els.map((el) => el.querySelector('input')?.value))).indexOf('ZZ TEST Ben');
  assert.ok(benIndex >= 0, 'Ben is in a place');
  receipt.checks.benPlace = benIndex + 1; save();
  await cards.nth(benIndex).getByRole('button', { name: 'Remove from saved', exact: true }).click();
  await expect(till.getByTestId('review-display-change')).toHaveText('The family removed ZZ TEST Ben from their saved children on the customer display.');
  await expect(cards.nth(benIndex)).toContainText("New — we'll save this");
  await expect.poll(async () => (await call('GET', `/members/${memberId}`)).body.member.children.map((c) => c.name).sort().join(',')).toBe('ZZ TEST Aya');
  receipt.checks.removed = { onTill: true, onRecord: 'ZZ TEST Ben off the saved list' }; save();
  await shot(display, `03-display-after-remove-place-empty-run${run}.png`);
  await shot(till, `04-till-shows-removal-run${run}.png`);

  phase('the family names a new child in the emptied place, age from the picker (up to 12)');
  const newName = cards.nth(benIndex).getByLabel(`Child ${benIndex + 1} name`, { exact: true });
  await newName.fill('ZZ TEST Cara');
  await cards.nth(benIndex).getByRole('button', { name: /Tap to set|yrs/ }).click();
  const picker = display.getByRole('dialog');
  const ages = await picker.getByRole('button').evaluateAll((els) => els.map((el) => el.textContent?.trim()).filter((t) => /^\d+$/.test(t ?? '')).map(Number));
  receipt.checks.displayAges = { max: Math.max(...ages), offered: ages.length }; save();
  assert.equal(Math.max(...ages), 12, 'the display offers ages up to 12');
  await shot(display, `05-display-age-picker-stops-at-12-run${run}.png`);
  await picker.getByRole('button', { name: '5', exact: true }).click();
  await picker.getByRole('button', { name: 'Jan', exact: true }).click();
  await picker.getByRole('button', { name: '15', exact: true }).click();
  await picker.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(till.getByTestId('review-display-change')).toHaveText(/The family added a new child on the customer display: ZZ TEST Cara, 5\./);
  receipt.checks.added = { onTill: true }; save();
  await shot(display, `06-display-new-child-named-run${run}.png`);
  await shot(till, `07-till-shows-new-child-run${run}.png`);

  phase('audit rows');
  const benId = kids.find((k) => k.name === 'ZZ TEST Ben').id;
  const entries = (await call('GET', `/audit?entityId=${benId}&limit=20`)).body?.entries ?? [];
  const archived = entries.find((r) => r.action === 'child.archive');
  assert.ok(archived, 'the archive is audited');
  receipt.checks.auditArchive = { action: archived.action, actorName: archived.actorName, source: archived.after?.source ?? null,
    stationMatches: archived.after?.stationId === station.id, archivedAt: Boolean(archived.after?.archivedAt), createdAt: archived.createdAt };
  receipt.checks.auditForBen = entries.map((r) => ({ action: r.action, actorName: r.actorName, createdAt: r.createdAt }));
  save();

  receipt.passed = true;
} catch (error) {
  failed = true; receipt.passed = false;
  receipt.failure = { phase: receipt.phase, kind: error.name, message: String(error.message ?? '').split('\n')[0].slice(0, 300) };
  if (till) await shot(till, `failed-till-run${run}.png`).catch(() => {});
  if (display) await shot(display, `failed-display-run${run}.png`).catch(() => {});
} finally {
  const clean = async (step, action) => {
    try { await action(); } catch (error) { failed = true; (receipt.cleanupFailures ??= []).push({ step, kind: error.name, message: String(error.message ?? '').slice(0, 200) }); }
    save();
  };
  if (till) await clean('go back from the review (no sale)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const back = till.getByRole('button', { name: 'Back', exact: true }).first();
      if (await back.isVisible().catch(() => false)) { await back.click(); await till.waitForTimeout(800); }
    }
  });
  await clean('close customer display', async () => { if (displayContext) { await displayContext.close(); displayContext = null; } });
  if (displayId) await clean('revoke own display', async () => {
    assert.equal((await call('POST', `/credentials/${displayId}/revoke`, { reason: 'ZZ TEST SCRUM-1014 proof complete' })).status, 200);
    receipt.cleanup.push({ kind: 'display', id: displayId, revoked: true });
  });
  if (station) await clean('no sale left on the station', async () => {
    const sales = (await call('GET', `/sales?branchId=${station.branchId}&stationId=${station.id}&limit=20`)).body?.sales ?? [];
    const mine = sales.filter((s) => (s.status === 'tendering' || s.status === 'open') && new Date(s.createdAt) >= new Date(receipt.startedAt));
    for (const sale of mine) {
      assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: 'ZZ TEST SCRUM-1014 proof cleanup' })).status, 200);
      receipt.cleanup.push({ kind: 'sale', id: sale.id, voided: true });
    }
    receipt.cleanup.push({ kind: 'sales-checked', open: mine.length });
  });
  if (memberId) await clean('archive the ZZ TEST family', async () => {
    const member = (await call('GET', `/members/${memberId}`)).body.member;
    assert.ok(member.nickname.startsWith('ZZ TEST SCRUM-1014'), 'only the own test member');
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
