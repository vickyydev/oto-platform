import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runFlow } from './s747-native-flow.mjs';

const [root, sha] = process.argv.slice(2);
assert.match(root ?? '', /^C:\/oto-lanes\//); assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const local = process.env.S747_LOCAL_ORIGIN;
if (local) assert.equal(new URL(local).hostname, '127.0.0.1');
const apiRequire = createRequire(root + '/apps/api/package.json'); apiRequire('tsx/esm/api').register();
const shared = await import(pathToFileURL(root + '/packages/shared/src/index.ts').href);
const { chromium, expect } = createRequire(root + '/apps/pos/package.json')('@playwright/test');
const { need } = await import('file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs');
const POS = local ?? 'https://oto-pos-web-staging.onrender.com';
const CONSOLE = local ?? 'https://oto-console-staging.onrender.com';
const LAUNCHER = local ?? 'https://oto-launcher-staging.onrender.com';
const stamp = Date.now().toString(36), out = root + '/docs/qa/proof-2026-11-04/s747-746/' + (local ? 'local/' : 'staging/') + stamp;
mkdirSync(out, { recursive: true });
const r = { mode: local ? 'local' : 'staging', source: sha, startedAt: new Date().toISOString(), fixture: { stamp, name: 'ZZ TEST SCRUM-747 ' + stamp, stations: [] }, requests: [], cases: [], attempts: [], screens: [], outcome: 'incomplete' };
const save = () => writeFileSync(out + '/receipt.json', JSON.stringify(r, null, 2) + '\n'); save();
let stable = async () => {}, finishServices = async () => {};
if (!local) {
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root, stdio: 'ignore' });
  const { render, stagingServices, envValue } = await import(pathToFileURL(root + '/scripts/agent/render.mjs').href);
  const services = (await stagingServices()).filter(s => ['oto-api-staging', 'oto-pos-web-staging', 'oto-pos-staging', 'oto-console-staging', 'oto-launcher-staging', 'oto-booth-staging', 'oto-inbox-staging', 'oto-app-staging'].includes(s.name));
  assert.equal(services.length, 8); const api = services.find(s => s.name === 'oto-api-staging'); assert.ok(api.ownerId);
  assert.ok(services.every(s => s.ownerId === api.ownerId));
  const live = async () => Promise.all(services.map(async service => {
    const deploy = (await render('GET', '/services/' + service.id + '/deploys?limit=1'))[0]?.deploy;
    assert.equal(deploy?.status, 'live', service.name + ' is not live');
    if (['oto-api-staging', 'oto-pos-web-staging', 'oto-pos-staging', 'oto-console-staging'].includes(service.name)) assert.equal(deploy.commit.id, sha, 'Live source mismatch: ' + service.name);
    return { service: service.name, commit: deploy.commit.id, deployId: deploy.id, liveAt: deploy.finishedAt };
  }));
  const names = async () => {
    const rows = await render('GET', '/services/' + api.id + '/env-vars?limit=100');
    const list = rows.map(row => (row.envVar ?? row).key).sort(); assert.equal(list.length, 57); assert.equal(new Set(list).size, 57); return list;
  };
  const baseline = await names(); r.apiSettingNameCount = baseline.length;
  assert.equal(await envValue(api.id, 'PGW_PROVIDER'), 'simulator', 'Gateway must be simulated'); r.gatewaySimulatorVerified = true;
  r.deployments = await live(); stable = async () => assert.deepEqual(await live(), r.deployments);
  r.ci = JSON.parse(execFileSync('gh', ['run', 'list', '--branch', 'main', '--commit', sha, '--limit', '1', '--json', 'databaseId,headSha,status,conclusion'], { cwd: root, encoding: 'utf8' }))[0];
  assert.equal(r.ci?.headSha, sha); assert.equal(r.ci.conclusion, 'success');
  finishServices = async () => { assert.deepEqual(await names(), baseline); r.apiSettingNameCountAfter = 57; await stable(); r.deploymentsAfter = await live(); };
  save();
}
const browser = await chromium.launch(), admin = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
admin.setDefaultTimeout(25_000); r.browser = { version: browser.version() }; save();
const phone = local ? process.env.S747_LOCAL_PHONE : need('STAGING_ADMIN_PHONE');
const password = local ? process.env.S747_LOCAL_PASSWORD : need('STAGING_ADMIN_PASSWORD');
assert.ok(phone && password);
const enter = async (context, app, page) => {
  const response = await context.request.post(LAUNCHER + '/api/auth/sign-in', { data: { phone, password } });
  assert.equal(response.status(), 200, 'Sign-in failed');
  if (local) { if (app === 'pos') await page.goto(POS); return; }
  const handoff = await context.request.post(LAUNCHER + '/api/auth/handoff', { data: { app } }); assert.equal(handoff.status(), 200);
  const exchanged = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/auth/handoff/exchange');
  await page.goto((await handoff.json()).launchUrl, { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('Handoff navigation failed'); });
  assert.equal((await exchanged).status(), 200);
};
const adminApi = async (method, path, data) => {
  const response = await admin.request.fetch(CONSOLE + '/api' + path, { method, data, headers: method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() } });
  const body = await response.json().catch(() => null);
  r.requests.push({ method, path: path.split('?')[0], status: response.status(), errorCode: body?.error?.code ?? null }); save();
  assert.ok([200, 201].includes(response.status()), method + ' ' + path.split('?')[0] + ': ' + response.status() + ' ' + (body?.error?.code ?? ''));
  return body;
};
const shot = async (label, page) => {
  await stable(); await page.bringToFront();
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  await page.screenshot({ path: out + '/' + label + '.png', fullPage: true, mask: [page.locator('input[type=password], input[type=tel], input[inputmode=tel]')] });
  r.screens.push({ file: label + '.png', at: new Date().toISOString() }); save();
};
try {
  await enter(admin, 'console', await admin.newPage());
  await runFlow({ browser, expect, origin: POS, adminApi, enterPos: (context, page) => enter(context, 'pos', page), record: r, save, shot, stable, shared });
} catch (error) {
  r.failure ??= { name: error.name, message: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[address omitted]').slice(0, 250) };
} finally {
  r.adminSessions = [];
  for (const origin of [...new Set([CONSOLE, LAUNCHER])]) {
    try { assert.equal((await admin.request.post(origin + '/api/auth/sign-out', { data: {} })).status(), 200); assert.equal((await admin.request.get(origin + '/api/me')).status(), 401); r.adminSessions.push({ origin, signedOut: true }); }
    catch { r.adminSessions.push({ origin, signedOut: false }); }
  }
  try { await finishServices(); } catch (error) { r.serviceReadbackFailure = { name: error.name, message: String(error.message).split('\n')[0].slice(0, 180) }; }
  r.finishedAt = new Date().toISOString(); save(); await browser.close();
}
if (r.failure || !r.cleanup?.passed || r.serviceReadbackFailure || r.adminSessions.some(session => !session.signedOut)) process.exitCode = 1;
console.log(JSON.stringify({ out, source: sha, mode: r.mode, outcome: r.outcome, phase: r.phase, failure: r.failure, cleanup: r.cleanup, cases: r.cases.length, images: r.screens.map(screen => screen.file) }));
