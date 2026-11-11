// Native Create Login and knowledge PDF -> SOP, with exact fixture cleanup.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const mode = process.argv[2] ?? 'before';
const out = resolve(import.meta.dirname, mode); mkdirSync(out, { recursive: true });
const origins = { console: 'https://oto-console-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com', app: 'https://oto-app-staging.onrender.com' };
const receipt = { mode, startedAt: new Date().toISOString(), phase: 'preflight', requests: [], created: {}, cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = s => { receipt.phase = s; save(); console.log(s); };
for (const name of ['oto-api-staging', 'oto-app-staging']) {
  const svc = await service(name), list = await render('GET', `/services/${svc.id}/deploys?limit=5`);
  const live = list.map(x => x.deploy).find(x => x.status === 'live'); assert.ok(live);
  (receipt.deployments ??= {})[name] = { id: live.id, sha: live.commit.id }; save();
}
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const consoleContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30000); consoleContext.setDefaultTimeout(30000);
const app = await context.newPage(), consolePage = await consoleContext.newPage();
let failed = false;
async function login(page, origin) {
  await page.goto(origin);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('input[type="password"]').waitFor({ state: 'hidden' });
}
async function call(origin, path, method = 'GET', data) {
  const ctx = origin === origins.console ? consoleContext : context;
  const r = await ctx.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }), headers: { origin } });
  receipt.requests.push({ method, path, status: r.status() }); save(); return r;
}
async function picture(name, dialog = false) {
  const target = dialog ? app.getByRole('dialog') : app;
  await target.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [
    app.getByTestId('text-employee-suite-password'), app.getByTestId('text-employee-suite-phone'),
    app.locator('input[type="password"], input[type="tel"]'), app.locator('[data-testid^="button-user-menu"], [data-testid="avatar-user"]'),
  ] });
}
try {
  phase('native sign-in');
  await login(consolePage, origins.console); await consolePage.waitForURL(/\/overview$/);
  await login(app, origins.launcher);
  const handoff = app.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await app.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await app.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  const exchanged = await handoff; await exchanged.finished(); assert.equal(exchanged.status(), 200);
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  phase('create own ZZ TEST employee');
  const branches = await (await call(origins.app, '/api/branches')).json();
  const branch = branches.find(b => b.isActive !== false); assert.ok(branch);
  const suffix = Date.now().toString(36), email = `zz-test-784-${suffix}@example.com`;
  const employee = await call(origins.app, '/api/employees', 'POST', {
    fullName: `ZZ TEST SCRUM-784 ${suffix}`, nickname: 'ZZ TEST', email, branchId: branch.id,
  });
  assert.equal(employee.status(), 201);
  const employeeBody = await employee.json(); receipt.created.employeeId = employeeBody.id; assert.ok(employeeBody.id); save();
  phase('press Create Login through employee screen');
  await app.goto(origins.app + `/employees/${employeeBody.id}`);
  await app.getByTestId('tab-access').click();
  const section = app.getByTestId('collapsible-access-login'); await section.waitFor();
  if (!(await app.getByTestId('button-enable-login').isVisible())) await section.getByText('Access & Login', { exact: true }).click();
  await app.getByTestId('button-enable-login').click();
  await app.getByTestId('input-login-email').fill(email);
  await app.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click();
  const phone = '090' + String(Date.now()).slice(-7);
  await app.getByTestId('input-employee-suite-phone').fill(phone);
  const created = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/employees/${employeeBody.id}/enable-login`);
  await app.getByTestId('button-create-login').click();
  const response = await created, answer = await response.json();
  receipt.login = { status: response.status(), requestKeys: Object.keys(response.request().postDataJSON()).sort(),
    success: answer.success, userId: answer.userId, personId: answer.personId, accessPolicyId: answer.accessPolicyId,
    accountId: answer.accountId, replayed: answer.replayed, platformManaged: answer.platformManaged,
    temporaryPasswordShown: typeof answer.temporaryPassword === 'string' && answer.temporaryPassword.length > 0 };
  for (const k of ['userId', 'personId', 'accessPolicyId', 'accountId']) if (answer[k]) receipt.created[k] = answer[k]; save();
  assert.equal(response.status(), 200);
  await app.getByTestId('text-enable-login-done-launcher').waitFor();
  await picture('s784-login-created.png', true);
  phase('upload own ZZ TEST PDF through knowledge screen');
  await app.goto(origins.app + '/studio/kb/files');
  if (await app.getByTestId('tab-files').isVisible()) await app.getByTestId('tab-files').click();
  await app.getByTestId('button-upload-file').click();
  await app.getByTestId('input-file-upload').setInputFiles(resolve(root, 'docs/qa/proof-2026-11-11/SCRUM-785/staging/ZZ TEST SOP document.pdf'));
  const title = `ZZ TEST SCRUM-785 ${suffix}`;
  await app.getByTestId('input-file-title').fill(title);
  const upload = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/knowledge-files/upload');
  await app.getByTestId('button-submit-upload').click();
  const uploaded = await upload, file = await uploaded.json();
  receipt.upload = { status: uploaded.status(), responseKeys: Object.keys(file).sort() };
  receipt.created.fileId = file.id ?? file.file?.id; save();
  assert.ok(uploaded.ok()); assert.ok(receipt.created.fileId);
  await app.getByTestId('input-search-files').fill(title);
  const generate = app.getByTestId(`button-generate-sop-${receipt.created.fileId}`);
  await expect(generate).toBeVisible({ timeout: 90000 }); await expect(generate).toBeEnabled({ timeout: 90000 });
  phase('press Generate SOP through knowledge screen');
  const generated = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/knowledge-files/${receipt.created.fileId}/generate-sop`, { timeout: 180000 });
  await generate.click();
  const genResponse = await generated, genBody = await genResponse.json();
  receipt.sop = { status: genResponse.status(), sopId: genBody.sop?.id, stepsCount: genBody.stepsCount,
    message: typeof genBody.message === 'string' ? genBody.message.replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 220) : undefined };
  if (genBody.sop?.id) receipt.created.sopId = genBody.sop.id; save();
  await picture('s785-sop-result.png');
  if (!mode.startsWith('before')) {
    assert.equal(genResponse.status(), 201); assert.ok(genBody.stepsCount > 0);
    assert.equal(genBody.sop.status, 'draft');
    await app.goto(origins.app + '/studio/sops');
    await app.getByTestId('input-search-sops').fill(genBody.sop.title);
    await app.getByTestId(`card-sop-${genBody.sop.id}`).click();
    await app.getByTestId('input-step-0-title').waitFor();
    receipt.sop.visibleSteps = await app.locator('[data-testid^="step-card-"]').count(); save();
    assert.equal(receipt.sop.visibleSteps, genBody.stepsCount);
    await picture('s785-sop-steps.png', true);
  }
  receipt.behaviorRecorded = true;
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, name: error.name, message: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 180), path: new URL(app.url()).pathname,
    visibleTestIds: await app.locator('[data-testid]:visible').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-testid'))) }; save();
  await picture('harness-failure.png').catch(() => {});
} finally {
  phase('clean own fixture graph and sign out');
  const cleanup = async (label, work) => { try { await work(); receipt.cleanup.push({ label, passed: true }); } catch (e) { failed = true; receipt.cleanup.push({ label, passed: false, message: String(e.message).split('\n')[0].slice(0, 140) }); } save(); };
  if (receipt.created.accountId) {
    await cleanup('deactivate own core account', async () => assert.equal((await call(origins.console, `/api/accounts/${receipt.created.accountId}`, 'PATCH', { status: 'inactive' })).status(), 200));
    await cleanup('unlink own app grant', async () => assert.equal((await call(origins.console, `/api/admin/apps/oto_app/users/${receipt.created.accountId}`, 'DELETE')).status(), 200));
  }
  if (receipt.created.employeeId) await cleanup('delete own employee graph', async () => {
    assert.ok([200, 204].includes((await call(origins.app, `/api/employees/${receipt.created.employeeId}`, 'DELETE')).status()));
    assert.equal((await call(origins.app, `/api/employees/${receipt.created.employeeId}`)).status(), 404);
  });
  // SOP cleanup uses the discovered route; never enumerate or delete other files.
  if (receipt.created.sopId) await cleanup('delete own generated SOP', async () => {
    const r = await call(origins.app, `/api/sops/${receipt.created.sopId}`, 'DELETE'); assert.ok([200, 204].includes(r.status()));
    assert.equal((await call(origins.app, `/api/sops/${receipt.created.sopId}`)).status(), 404);
  });
  if (receipt.created.fileId) await cleanup('delete own uploaded PDF', async () => {
    assert.ok([200, 204].includes((await call(origins.app, `/api/knowledge-files/${receipt.created.fileId}`, 'DELETE')).status()));
    assert.equal((await call(origins.app, `/api/knowledge-files/${receipt.created.fileId}`)).status(), 404);
  });
  for (const [origin, logout, read, label] of [[origins.app, '/api/logout', '/api/user', 'app'], [origins.launcher, '/api/auth/sign-out', '/api/me', 'launcher'], [origins.console, '/api/auth/sign-out', '/api/me', 'console']]) {
    await cleanup(`sign out ${label}`, async () => { assert.ok([200, 204].includes((await call(origin, logout, 'POST')).status())); assert.equal((await call(origin, read)).status(), 401); });
  }
  await browser.close(); receipt.passed = !failed && receipt.behaviorRecorded === true; receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, failure: receipt.failure, login: receipt.login, sop: receipt.sop, cleanup: receipt.cleanup }));
  if (!receipt.passed) process.exitCode = 1;
}
