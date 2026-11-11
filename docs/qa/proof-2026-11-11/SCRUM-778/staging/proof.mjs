// Native staging sign-ins and Console observation; only the two known ZZ TEST receipts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const { card } = await import(pathToFileURL(resolve(root, 'scripts/agent/evidence.mjs')));
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2]; assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const origins = { console: 'https://oto-console-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com', app: 'https://oto-app-staging.onrender.com' };
const subjects = [
  { ticket: 'SCRUM-769', userId: '0fc76a98-325a-4745-98f9-f98065b2195a' },
  { ticket: 'SCRUM-795', userId: '57b8850c-9575-4d73-a41b-121e5ba91887' },
];
const out = import.meta.dirname;
mkdirSync(out, { recursive: true });
const receipt = { tickets: ['SCRUM-778', 'SCRUM-781', 'SCRUM-810'], sha, startedAt: new Date().toISOString(),
  phase: 'preflight', requests: [], subjects, before: [], after: [], samples: [], cleanup: [], createdRecords: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = text => { receipt.phase = text; save(); console.log(text); };
async function deployments(initial = false) {
  const result = {};
  for (const name of ['oto-api-staging', 'oto-app-staging', 'oto-console-staging', 'oto-launcher-staging']) {
    const svc = await service(name), entries = await render('GET', `/services/${svc.id}/deploys?limit=5`);
    const live = entries.map(item => item.deploy).find(item => item.status === 'live');
    assert.ok(live, `${name} live deployment missing`);
    if (initial && ['oto-api-staging', 'oto-app-staging'].includes(name)) assert.equal(live.commit.id, sha);
    result[name] = { id: live.id, status: live.status, sha: live.commit.id,
      latestStatus: entries[0].deploy.status, latestSha: entries[0].deploy.commit.id };
  }
  return result;
}
receipt.deploymentsBefore = await deployments(true); save();
const runs = JSON.parse(execFileSync('gh', ['run', 'list', '--commit', sha, '--workflow', 'CI', '--json', 'databaseId,headSha,status,conclusion'], { cwd: root, encoding: 'utf8' }));
receipt.ciAtStart = runs.filter(run => run.headSha === sha); save();
const browser = await chromium.launch({ channel: 'msedge' });
const consoleContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' });
const appContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' });
const page = await consoleContext.newPage(), app = await appContext.newPage();
for (const context of [consoleContext, appContext]) context.setDefaultTimeout(30000);
let failed = false;
async function login(target, origin) {
  await target.goto(origin);
  await target.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await target.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await target.getByRole('button', { name: 'Sign in', exact: true }).click();
  await target.locator('input[type="password"]').waitFor({ state: 'hidden' });
}
async function readReceipts(destination) {
  for (const subject of subjects) {
    const path = `/api/admin/login-lifecycle?userId=${subject.userId}`;
    const response = await appContext.request.get(origins.app + path);
    receipt.requests.push({ method: 'GET', path, status: response.status() }); save();
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.events) && body.events.length > 0 && body.events.length < 100);
    const events = body.events.map(({ id, kind, state, settledAt, attemptCount, lastErrorCode, nextAttemptAt }) =>
      ({ id, kind, state, settledAt, attemptCount, lastErrorCode, nextAttemptAt }));
    assert.ok(events.some(row => row.kind === 'deactivate'));
    for (const event of events) { assert.notEqual(event.state, 'pending'); assert.ok(event.settledAt); assert.equal(event.nextAttemptAt, null); }
    destination.push({ ...subject, events }); save();
  }
}
async function activity() {
  const answer = page.waitForResponse(response => new URL(response.url()).pathname === '/api/audit'
    && new URL(response.url()).searchParams.get('action') === 'app_identity.lifecycle_deactivation.failed');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const response = await answer; assert.equal(response.status(), 200);
  const body = await response.json();
  assert.equal(body.masked, true); assert.equal(body.nextCursor, null);
  assert.ok(Array.isArray(body.entries)); assert.equal(body.entries.length, 0);
  receipt.samples.push({ at: new Date().toISOString(), status: response.status(), count: body.entries.length,
    masked: body.masked, nextCursor: body.nextCursor }); save();
}
async function screenshot(filename) {
  await page.screenshot({ path: resolve(out, filename), animations: 'disabled', mask: [
    page.getByRole('button', { name: 'Sign out', exact: true }).locator('..'),
    page.locator('input[type="password"],input[type="tel"]'),
  ] });
}
try {
  const anonymous = await appContext.request.get(`${origins.app}/api/admin/login-lifecycle?userId=${subjects[0].userId}`);
  assert.equal(anonymous.status(), 401);
  receipt.requests.push({ method: 'GET', path: '/api/admin/login-lifecycle', actor: 'anonymous', status: anonymous.status() }); save();
  phase('native Console and launcher sign-in');
  await login(page, origins.console); await page.waitForURL(/\/overview$/);
  await login(app, origins.launcher);
  await app.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await app.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  const user = await appContext.request.get(origins.app + '/api/user'); assert.equal(user.status(), 200);
  phase('read both old ZZ TEST lifecycle receipts through the app route');
  await readReceipts(receipt.before);
  for (const subject of subjects) {
    await app.goto(`${origins.app}/api/admin/login-lifecycle?userId=${subject.userId}`);
    await app.screenshot({ path: resolve(out, `s810-${subject.ticket.toLowerCase()}-settled.png`), animations: 'disabled' });
  }
  phase('ten real minutes in Console Activity');
  await page.goto(origins.console + '/activity');
  await page.getByLabel('Action', { exact: true }).fill('app_identity.lifecycle_deactivation.failed');
  // Include seconds so earlier failures in the same minute are not the observation.
  const started = Date.now(); receipt.observationStartedAt = new Date(started).toISOString(); save();
  await page.getByLabel('From', { exact: true }).fill(new Date(started + 7 * 3600000).toISOString().slice(0, 19));
  await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await activity(); await screenshot('s778-activity-start.png');
  while (Date.now() - started < 600000) {
    await page.waitForTimeout(Math.min(30000, 600000 - (Date.now() - started)));
    await activity();
  }
  receipt.observationElapsedMs = Date.now() - started; save();
  await screenshot('s778-activity-ten-minutes.png');
  await readReceipts(receipt.after);
  assert.deepEqual(receipt.after, receipt.before, 'terminal receipt attempt counters must not keep increasing');
  receipt.deploymentsAfter = await deployments(); save();
  await card(app, { title: 'SCRUM-778 / 781 / 810 — lifecycle retry observation',
    subtitle: 'Labelled staging test-run card; native Activity and app-route pictures accompany it.',
    identity: 'Seeded staging administrator; personal details omitted.', deploy: sha,
    rows: [
      { ok: true, tag: 'PASS', head: 'Two old test logins settled', note: 'App-owned authenticated route read before and after; no pending event and unchanged attempt counters.' },
      { ok: true, tag: 'PASS', head: 'Ten minutes with no repeated failure rows', note: `${receipt.samples.length} native Console Refresh responses over ${receipt.observationElapsedMs} ms; action and From filters applied.` },
      { ok: true, tag: 'SCOPE', head: 'No new staging records', note: 'Only the two existing ZZ TEST receipt identities were inspected. Six-attempt backoff, deletion rollback and park isolation were exercised in the isolated local database.' },
    ] }, resolve(out, 's778-observation-card.png'));
  receipt.behaviorPassed = true;
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, name: error.name,
    message: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 200) }; save();
} finally {
  phase('sign out both native sessions');
  for (const [context, origin, logout, read, label] of [
    [appContext, origins.app, '/api/logout', '/api/user', 'app'],
    [appContext, origins.launcher, '/api/auth/logout', '/api/me', 'launcher'],
    [consoleContext, origins.console, '/api/auth/logout', '/api/me', 'console'],
  ]) {
    try {
      const response = await context.request.post(origin + logout, { headers: { origin } });
      const check = await context.request.get(origin + read);
      receipt.cleanup.push({ label, logout: response.status(), signedOut: check.status() });
      if (![200, 204].includes(response.status()) || check.status() !== 401) failed = true;
    } catch { failed = true; receipt.cleanup.push({ label, failed: true }); }
    save();
  }
  await browser.close();
  receipt.passed = !failed && receipt.behaviorPassed === true;
  receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, samples: receipt.samples.length, cleanup: receipt.cleanup }));
  if (!receipt.passed) process.exitCode = 1;
}
