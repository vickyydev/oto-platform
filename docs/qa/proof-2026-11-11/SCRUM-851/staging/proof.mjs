// SCRUM-851 staging proof: the normal path of SOP from a document, with exact fixture cleanup.
// Only ZZ TEST fixtures; the document is the synthetic one-page PDF of the SCRUM-785 proof.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const root = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const expectedSha = process.argv[2]; assert.match(expectedSha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out851'); mkdirSync(out, { recursive: true });
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const receipt = { ticket: 'SCRUM-851', expectedSha, startedAt: new Date().toISOString(), phase: 'sign-in', requests: [], created: {}, cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = s => { receipt.phase = s; save(); console.log(s); };
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30000);
const app = await context.newPage();
let failed = false;
async function call(origin, path, method = 'GET', data) {
  const r = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }), headers: { origin } });
  receipt.requests.push({ method, path, status: r.status() }); save(); return r;
}
// The signed-in person's menu is covered in every picture; nothing on the page is rewritten.
const personMask = () => [app.locator('input[type="password"], input[type="tel"]'), app.locator('[data-testid^="button-user-menu"], [data-testid="avatar-user"], span[class*="rounded-full"][class*="overflow-hidden"]')];
async function picture(name, dialog = false) {
  const target = dialog ? app.getByRole('dialog') : app;
  await target.screenshot({ path: resolve(out, name), animations: 'disabled', mask: personMask() });
}
try {
  await app.goto(origins.launcher);
  await app.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await app.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await app.getByRole('button', { name: 'Sign in', exact: true }).click();
  await app.locator('input[type="password"]').waitFor({ state: 'hidden' });
  const handoff = app.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await app.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await app.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  const exchanged = await handoff; await exchanged.finished(); assert.equal(exchanged.status(), 200);
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  phase('verify the authenticated app reports the exact landed source');
  await expect.poll(async () => {
    const response = await call(origins.app, '/api/qa-reports/config');
    const body = await response.json(); receipt.appVersionBefore = { status: response.status(), sha: body.version }; save();
    return body.version;
  }, { timeout: 300000, intervals: [15000] }).toBe(expectedSha);
  const suffix = Date.now().toString(36);
  phase('upload own ZZ TEST PDF through knowledge screen');
  await app.goto(origins.app + '/studio/kb/files');
  if (await app.getByTestId('tab-files').isVisible()) await app.getByTestId('tab-files').click();
  await app.getByTestId('button-upload-file').click();
  await app.getByTestId('input-file-upload').setInputFiles(resolve(root, 'docs/qa/proof-2026-11-11/SCRUM-785/staging/ZZ TEST SOP document.pdf'));
  const title = `ZZ TEST SCRUM-851 ${suffix}`;
  await app.getByTestId('input-file-title').fill(title);
  const upload = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/knowledge-files/upload');
  await app.getByTestId('button-submit-upload').click();
  const uploaded = await upload, file = await uploaded.json();
  receipt.upload = { status: uploaded.status(), title };
  receipt.created.fileId = file.id ?? file.file?.id; save();
  assert.ok(uploaded.ok()); assert.ok(receipt.created.fileId);
  await app.getByTestId('input-search-files').fill(title);
  const generate = app.getByTestId(`button-generate-sop-${receipt.created.fileId}`);
  await expect(generate).toBeVisible({ timeout: 90000 }); await expect(generate).toBeEnabled({ timeout: 90000 });
  phase('press Generate SOP through knowledge screen');
  const generated = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/knowledge-files/${receipt.created.fileId}/generate-sop`, { timeout: 180000 });
  const pressedAt = Date.now();
  await generate.click();
  const genResponse = await generated, genBody = await genResponse.json();
  receipt.sop = { status: genResponse.status(), wallMs: Date.now() - pressedAt, sopId: genBody.sop?.id, sopStatus: genBody.sop?.status, sopTitle: genBody.sop?.title, stepsCount: genBody.stepsCount,
    message: typeof genBody.message === 'string' ? genBody.message.replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 220) : undefined };
  if (genBody.sop?.id) receipt.created.sopId = genBody.sop.id; save();
  await app.waitForTimeout(700);
  await picture('851-1-sop-created.png');
  assert.equal(genResponse.status(), 201); assert.ok(genBody.stepsCount > 0);
  assert.equal(genBody.sop.status, 'draft');
  phase('open the draft in the SOP editor');
  await app.goto(origins.app + '/studio/sops');
  await app.getByTestId('input-search-sops').fill(genBody.sop.title);
  await app.getByTestId(`card-sop-${genBody.sop.id}`).click();
  await app.getByTestId('input-step-0-title').waitFor();
  receipt.sop.visibleSteps = await app.locator('[data-testid^="step-card-"]').count(); save();
  assert.equal(receipt.sop.visibleSteps, genBody.stepsCount);
  await picture('851-2-sop-draft-steps.png', true);
  const after = await call(origins.app, '/api/qa-reports/config'), afterBody = await after.json();
  receipt.appVersionAfter = { status: after.status(), sha: afterBody.version }; save();
  assert.equal(afterBody.version, expectedSha);
  receipt.behaviorPassed = true;
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, name: error.name, message: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 220), path: new URL(app.url()).pathname }; save();
  await picture('failure.png').catch(() => {});
} finally {
  phase('clean own fixtures and sign out');
  const cleanup = async (label, work) => { try { await work(); receipt.cleanup.push({ label, passed: true }); } catch (e) { failed = true; receipt.cleanup.push({ label, passed: false, message: String(e.message).split('\n')[0].slice(0, 140) }); } save(); };
  // The SOP and the document are removed by their own ids; nothing else is listed or touched.
  if (receipt.created.sopId) await cleanup('delete own generated SOP', async () => {
    const r = await call(origins.app, `/api/sops/${receipt.created.sopId}`, 'DELETE'); assert.ok([200, 204].includes(r.status()));
    assert.equal((await call(origins.app, `/api/sops/${receipt.created.sopId}`)).status(), 404);
  });
  if (receipt.created.fileId) await cleanup('delete own uploaded PDF', async () => {
    assert.ok([200, 204].includes((await call(origins.app, `/api/knowledge-files/${receipt.created.fileId}`, 'DELETE')).status()));
    assert.equal((await call(origins.app, `/api/knowledge-files/${receipt.created.fileId}`)).status(), 404);
  });
  for (const [origin, logout, read, label] of [[origins.app, '/api/logout', '/api/user', 'app'], [origins.launcher, '/api/auth/sign-out', '/api/me', 'launcher']]) {
    await cleanup(`sign out ${label}`, async () => { assert.ok([200, 204].includes((await call(origin, logout, 'POST')).status())); assert.equal((await call(origin, read)).status(), 401); });
  }
  await browser.close(); receipt.passed = !failed && receipt.behaviorPassed === true; receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, failure: receipt.failure, upload: receipt.upload, sop: receipt.sop, cleanup: receipt.cleanup }));
  if (!receipt.passed) process.exitCode = 1;
}
