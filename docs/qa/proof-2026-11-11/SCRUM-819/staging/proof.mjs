// SCRUM-819: native Console pairing, ten real minutes online, then real silence.
// Credentials stay in memory. Only own fixture IDs and bounded readings are saved.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const { card } = await import(pathToFileURL(resolve(helper, 'scripts/agent/evidence.mjs')));
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const ci = JSON.parse(execFileSync('gh', ['run', 'list', '--commit', sha, '--workflow', 'CI', '--json', 'databaseId,headSha,status,conclusion'], { cwd: root, encoding: 'utf8' })).find(run => run.headSha === sha);
assert.ok(ci);
assert.ok(!['failure', 'timed_out'].includes(ci.conclusion));
const out = import.meta.dirname;
const receipt = { ticket: 'SCRUM-819', sha, ci, startedAt: new Date().toISOString(), phase: 'preflight', requests: [], created: [], samples: [], checks: {}, cleanup: [] };
mkdirSync(out, { recursive: true });
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(value); };
async function deployments() {
  const result = {};
  for (const name of ['oto-api-staging', 'oto-console-staging', 'oto-pos-web-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
    assert.equal(d?.status, 'live', `${name} must be live`);
    if (name === 'oto-api-staging') assert.equal(d.commit.id, sha);
    result[name] = { id: d.id, status: d.status, sha: d.commit.id };
  }
  return result;
}
receipt.deployments = await deployments(); save();
const origin = 'https://oto-console-staging.onrender.com';
const pos = 'https://oto-pos-web-staging.onrender.com';
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' });
ctx.setDefaultTimeout(30000);
const page = await ctx.newPage();
let displayContext, display, station, displayId, branchId, releaseSession;
let failed = false;
const fixtureName = `ZZ TEST SCRUM-819 ${Date.now()}`;
const call = async (method, path, data) => {
  const response = await ctx.request.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  receipt.requests.push({ method, path: path.split('?')[0], status: response.status() }); save();
  return { status: response.status(), body: await response.json().catch(() => null) };
};
const ownCredential = async () => {
  const response = await call('GET', `/branches/${branchId}/credentials?includeRevoked=true`);
  assert.equal(response.status, 200);
  const own = response.body.credentials.find(row => row.id === displayId);
  assert.ok(own); assert.equal(own.label, fixtureName); assert.equal(own.stationId, station.id);
  return own;
};
const shot = async (filename, target = page) => {
  const otherRows = target.locator('section li').filter({ hasNotText: fixtureName });
  await target.screenshot({ path: resolve(out, filename), animations: 'disabled', mask: [
    target.getByRole('button', { name: 'Sign out', exact: true }).locator('..'),
    target.locator('input[type="password"],input[type="tel"]'),
    target.getByTestId('display-pairing-code'), otherRows,
  ] });
};
const readHealthFromScreen = async () => {
  const next = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ops/health' && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const response = await next;
  assert.equal(response.status(), 200);
  const health = await response.json();
  assert.ok((health.evidence ?? []).every(item => item.source !== 'alerts' || item.availability === 'ok'));
  assert.ok(health.alerts.length < 50, 'bounded alert list must be complete');
  const own = health.alerts.filter(item => item.key === `display.offline:${displayId}`);
  const credential = await ownCredential();
  const sample = { at: new Date().toISOString(), generatedAt: health.generatedAt, watchdogAgeSeconds: health.watchdogAgeSeconds,
    presence: credential.presence, alerts: own.map(({ id, key, openedAt, count, resolvedAt }) => ({ id, key, openedAt, count, resolvedAt })) };
  receipt.samples.push(sample); save();
  return sample;
};
try {
  phase('Console sign-in and own test station');
  await page.goto(origin);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/overview$/);
  const branches = (await call('GET', '/branches')).body;
  const park = (branches.branches ?? branches).find(item => /Central Floresta/.test(item.name));
  assert.ok(park); branchId = park.id;
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find(item => item.role === 'virtual' && item.slot === 'virtual-1' && !item.archived && item.status === 'online');
  assert.ok(box);
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const prefix = Array.from({ length: 99 }, (_, i) => `Z819${String(i + 1).padStart(2, '0')}`).find(value => !stations.some(item => item.codePrefix === value));
  assert.ok(prefix);
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', devices: [], paymentRouting: { card: 'manual', qr: 'none' } });
  assert.equal(made.status, 200); station = made.body.station;
  receipt.created.push({ kind: 'station', id: station.id }); save();
  displayContext = await browser.newContext({ baseURL: pos, viewport: { width: 1024, height: 900 }, timezoneId: 'Asia/Bangkok' });
  displayContext.setDefaultTimeout(30000);
  // Hold only this browser's first protected read, to inspect pairing before a poll.
  const firstRead = new Promise(resolveRead => { releaseSession = resolveRead; });
  await displayContext.route('**/api/display/session', async route => { await firstRead; await route.continue().catch(() => {}); });
  display = await displayContext.newPage();
  await display.goto(`${pos}/display`);
  await display.getByTestId('display-pairing-code').waitFor();
  const pairingCode = (await display.getByTestId('display-pairing-code').textContent()).trim();
  assert.match(pairingCode, /^\d{6}$/);
  phase('pair display through Console');
  await page.goto(`${origin}/devices`);
  await page.getByLabel('Branch').selectOption(branchId);
  await page.getByRole('button', { name: 'Paired screens', exact: true }).click();
  await page.getByRole('button', { name: 'Pair a display', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair a display', exact: true });
  await dialog.getByLabel(/^Station/).selectOption(station.id);
  await dialog.getByLabel(/^Display name/).fill(fixtureName);
  await dialog.getByLabel(/^Pairing code/).fill(pairingCode);
  const claimed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/stations/${station.id}/displays/claim` && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Pair the display', exact: true }).click();
  const claim = await claimed; assert.equal(claim.status(), 200);
  displayId = (await claim.json()).device.id;
  receipt.created.push({ kind: 'display', id: displayId }); save();
  const first = await ownCredential();
  assert.equal(first.lastSeenAt, first.pairedAt); assert.equal(first.presence.state, 'online');
  receipt.checks.firstSighting = { pairedAt: first.pairedAt, lastSeenAt: first.lastSeenAt, state: first.presence.state, beforeFirstProtectedRead: true }; save();
  releaseSession();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const ownRow = page.locator('li').filter({ hasText: fixtureName }).first();
  await expect(ownRow).toContainText('Online');
  await ownRow.scrollIntoViewIfNeeded();
  await shot('s819-paired-online.png');
  phase('ten minutes connected: Console alerts refreshed every 30 seconds');
  await page.goto(`${origin}/health`);
  const onlineStart = Date.now();
  do {
    const sample = await readHealthFromScreen();
    assert.equal(sample.alerts.length, 0); assert.equal(sample.presence.state, 'online');
    assert.ok(sample.watchdogAgeSeconds !== null && sample.watchdogAgeSeconds < 120, 'watchdog is running');
    if (Date.now() - onlineStart >= 600000) break;
    await page.waitForTimeout(Math.min(30000, 600000 - (Date.now() - onlineStart)));
  } while (true);
  receipt.checks.onlineWindow = { elapsedMs: Date.now() - onlineStart, sampleCount: receipt.samples.length, alerts: 0 }; save();
  await shot('s819-ten-minutes-no-alert.png');
  phase('cut only the test display and wait for real silence');
  receipt.cutAt = new Date().toISOString(); save();
  await displayContext.close(); displayContext = null;
  const deadline = Date.now() + (receipt.samples.at(-1).presence.offlineAfterSeconds + 150) * 1000;
  let offline;
  do {
    await page.waitForTimeout(15000);
    offline = await readHealthFromScreen();
    if (offline.alerts.length) break;
  } while (Date.now() < deadline);
  assert.equal(offline.presence.state, 'offline'); assert.equal(offline.alerts.length, 1);
  const alertId = offline.alerts[0].id;
  receipt.checks.realSilence = { alertId, openedAt: offline.alerts[0].openedAt, offlineAfterSeconds: offline.presence.offlineAfterSeconds };
  await page.getByRole('list', { name: 'Open alerts', exact: true }).getByText(new RegExp(fixtureName)).first().scrollIntoViewIfNeeded();
  await shot('s819-real-silence-one-alert.png');
  await page.waitForTimeout(35000);
  const repeated = await readHealthFromScreen();
  assert.equal(repeated.alerts.length, 1); assert.equal(repeated.alerts[0].id, alertId);
  receipt.checks.repeatedSweepSameAlert = true;
  await card(page, { title: 'SCRUM-819 - display pairing and real silence', subtitle: 'Labelled test-run card; live Console reads, real elapsed time', identity: 'Seeded staging administrator; isolated ZZ TEST display', deploy: `oto-api-staging ${sha}`, rows: [
    { ok: true, tag: 'PASS', head: 'Pairing is the first sighting', note: 'Before the first protected display request', body: JSON.stringify(receipt.checks.firstSighting, null, 2) },
    { ok: true, tag: 'PASS', head: 'Ten minutes connected without an Offline alert', note: `${receipt.checks.onlineWindow.sampleCount} Console samples over ${Math.floor(receipt.checks.onlineWindow.elapsedMs / 1000)} seconds` },
    { ok: true, tag: 'PASS', head: 'Real silence opens one alert', note: `Same alert on the next watchdog read: ${alertId}` },
    { ok: true, tag: 'SCOPE', head: 'Only the test browser was disconnected', note: 'No park screen, service setting or opening hours changed. Notification delivery is covered by the integration review, not this screen proof.' },
  ] }, resolve(out, 's819-observation-card.png'));
  receipt.deploymentsAfter = await deployments();
  receipt.passed = true;
} catch (error) {
  failed = true; receipt.passed = false;
  receipt.failure = { phase: receipt.phase, kind: error.name, frames: (error.stack ?? '').split('\n').filter(line => /proof\.mjs:/.test(line)).map(line => line.match(/proof\.mjs:\d+:\d+/)?.[0]) };
  await shot('failed-attempt.png').catch(() => {});
} finally {
  releaseSession?.();
  const clean = async (step, action) => { try { await action(); } catch (error) { failed = true; receipt.passed = false; (receipt.cleanupFailures ??= []).push({ step, kind: error.name }); } save(); };
  await clean('close own display', async () => { await displayContext?.close(); });
  if (station) await clean('retire own display and till', async () => {
    const own = (await call('GET', `/stations/${station.id}`)).body.station;
    assert.equal(own.name, fixtureName);
    // A lost claim response can still have paired the browser. Recover its ID
    // only from this exact new station and label before retiring the fixture.
    if (!displayId) {
      const active = (await call('GET', `/stations/${station.id}/displays`)).body.displays;
      assert.ok(active.length <= 1);
      if (active.length) { assert.equal(active[0].name, fixtureName); displayId = active[0].id; }
    }
    if (displayId) {
      assert.equal((await call('POST', `/credentials/${displayId}/revoke`, { reason: 'ZZ TEST SCRUM-819 proof complete' })).status, 200);
      assert.ok((await ownCredential()).revokedAt);
      receipt.cleanup.push({ kind: 'display', id: displayId, revoked: true });
    }
    assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
    const retired = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(item => item.id === station.id);
    assert.equal(retired.archived, true); assert.equal(retired.devices.length, 0);
    receipt.cleanup.push({ kind: 'station', id: station.id, archived: true, devices: 0 });
    if (displayId) await expect.poll(async () => {
      const health = await call('GET', '/ops/health'); assert.equal(health.status, 200);
      return health.body.alerts.some(item => item.key === `display.offline:${displayId}`);
    }, { timeout: 90000, intervals: [10000] }).toBe(false);
    receipt.cleanup.push({ kind: 'alert', closed: true });
  });
  await clean('sign out Console', async () => {
    assert.equal((await call('POST', '/auth/sign-out')).status, 200);
    assert.equal((await call('GET', '/me')).status, 401);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true, me: 401 });
  });
  await browser.close(); receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
