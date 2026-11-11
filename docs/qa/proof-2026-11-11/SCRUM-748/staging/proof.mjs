// Native checklist editor proof; only ZZ TEST fixtures, signed URLs never saved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const root = resolve(import.meta.dirname, '../../../../..');
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const expectedSha = process.argv[2]; assert.match(expectedSha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'attempt-01'); mkdirSync(out, { recursive: true });
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const receipt = { expectedSha, startedAt: new Date().toISOString(), phase: 'sign-in', requests: [], templates: [], attachments: [], uploads: [], cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(value); };
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const app = await context.newPage(); app.setDefaultTimeout(30000);
const keys = new Map(); let failed = false, forceFallback = false;
await context.route(url => url.origin !== origins.app && url.origin !== origins.launcher, async route => {
  if (forceFallback && route.request().method() === 'PUT') { receipt.injectedPutRefusals = (receipt.injectedPutRefusals ?? 0) + 1; save(); await route.abort('failed'); }
  else await route.continue();
});
async function call(path, method = 'GET', data, origin = origins.app) {
  const r = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }), headers: { origin } });
  receipt.requests.push({ method, path: path.split('?')[0], status: r.status() }); save(); return r;
}
async function photo(name) {
  await expect.poll(async () => (await app.getByRole('dialog').boundingBox())?.width ?? 0).toBeGreaterThan(400);
  await app.getByRole('dialog').screenshot({ path: resolve(out, name), animations: 'disabled', mask: [app.locator('input[type="tel"], input[type="password"]')] });
}
async function version() {
  const r = await call('/api/qa-reports/config'); assert.equal(r.status(), 200);
  return (await r.json()).version;
}
async function upload(input, pending) {
  const result = app.waitForResponse(r => r.request().method() === 'POST' && ['/api/checklist-media/upload', '/api/checklist-media/confirm'].includes(new URL(r.url()).pathname), { timeout: 90000 });
  await input.setInputFiles({ name: 'ZZ TEST SCRUM-748 photo.jpg', mimeType: 'image/jpeg', buffer: (await import('node:fs')).readFileSync(resolve(root, 'apps/oto-app/tests/fixtures/media/checklist-evidence.jpg')) });
  const response = await result, raw = await response.json(), attachment = raw.attachment ?? raw;
  receipt.uploads.push({ pending, forcedPutRefusal: forceFallback, route: new URL(response.url()).pathname, status: response.status(), attachmentId: attachment.id, checklistTemplateId: attachment.checklistTemplateId, checklistTemplateItemId: attachment.checklistTemplateItemId, pendingChecklistId: attachment.pendingChecklistId, pendingItemIndex: attachment.pendingItemIndex });
  if (attachment.id) { receipt.attachments.push(attachment.id); keys.set(attachment.id, attachment.s3Key); } save();
  assert.equal(response.status(), 200); assert.ok(attachment.id);
  if (forceFallback) assert.equal(new URL(response.url()).pathname, '/api/checklist-media/upload');
  const thumbnail = app.getByTestId(`media-thumbnail-${attachment.id}`); await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.locator('img').evaluateAll(images => images.some(img => img.complete && img.naturalWidth > 0))).toBe(true);
  await thumbnail.scrollIntoViewIfNeeded();
  return attachment;
}
async function edit(id) {
  await app.goto(origins.app + '/studio/checklists');
  await app.getByTestId(`button-edit-checklist-${id}`).click();
  await app.getByTestId('button-expand-edit-item-0').click();
}
try {
  await app.goto(origins.launcher);
  await app.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await app.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await app.getByRole('button', { name: 'Sign in', exact: true }).click();
  const handoff = app.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await app.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await app.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  await (await handoff).finished();
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  phase('verify exact deployed source before any fixture');
  await expect.poll(version, { timeout: 300000, intervals: [15000] }).toBe(expectedSha);
  receipt.appVersionBefore = expectedSha; save();
  const branches = await (await call('/api/branches')).json();
  const branch = branches.find(b => b.isActive !== false && !b.archivedAt); assert.ok(branch);
  const suffix = Date.now().toString(36);
  phase('saved checklist item: native photo upload');
  const made = await call('/api/checklists/templates', 'POST', { name: `ZZ TEST SCRUM-748 saved ${suffix}`, branchIds: [branch.id], recurrence: 'weekly', weeklyDays: ['sun'], items: [{ title: 'ZZ TEST photo reference' }] });
  assert.equal(made.status(), 201); const saved = await made.json(); receipt.templates.push(saved.id); save();
  const savedDetails = await (await call(`/api/checklists/templates/${saved.id}`)).json();
  await edit(saved.id);
  const savedPhoto = await upload(app.getByRole('dialog').locator('input[type="file"]').last(), false);
  assert.equal(savedPhoto.checklistTemplateItemId, savedDetails.items[0].id);
  await photo('s748-saved-upload.png');
  await app.getByTestId('button-cancel-edit').click();
  await edit(saved.id);
  const savedImage = app.getByTestId(`media-thumbnail-${savedPhoto.id}`).locator('img');
  await expect(savedImage).toBeVisible(); await expect.poll(() => savedImage.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await savedImage.scrollIntoViewIfNeeded();
  receipt.savedPhotoSurvivesReload = true; save(); await photo('s748-saved-reloaded.png');
  await app.getByTestId('button-cancel-edit').click();
  phase('unsaved first item: deliberate bucket refusal and native create');
  forceFallback = true;
  await app.getByTestId('button-create-checklist').click();
  await app.getByTestId('input-checklist-name').fill(`ZZ TEST SCRUM-748 pending ${suffix}`);
  const selected = app.locator('[data-testid^="checkbox-branch-"][data-state="checked"]');
  for (const box of await selected.all()) await box.click();
  await app.getByTestId(`checkbox-branch-${branch.id}`).click();
  await app.getByTestId('input-item-0').fill('ZZ TEST first pending photo');
  // Cancelling edit can leave its expanded item state in the create form.
  if (!await app.getByTestId('textarea-create-item-description-0').isVisible()) await app.getByTestId('button-expand-item-0').click();
  const firstItemUpload = app.getByTestId('input-item-0').locator('..').locator('..').getByTestId('input-media-upload');
  await expect(firstItemUpload).toHaveCount(1);
  const pendingPhoto = await upload(firstItemUpload, true);
  assert.equal(pendingPhoto.pendingItemIndex, 0); await photo('s748-pending-upload.png');
  const created = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/checklists/templates');
  const associated = app.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/checklist-media/associate-pending');
  await app.getByTestId('button-submit-checklist').click();
  const cr = await created, body = await cr.json(); assert.equal(cr.status(), 201); receipt.templates.push(body.id); save();
  const ar = await associated; receipt.association = { status: ar.status(), updated: (await ar.json()).updated }; save();
  assert.equal(ar.status(), 200); assert.equal(receipt.association.updated, 1);
  await app.getByRole('dialog').waitFor({ state: 'hidden' });
  await edit(body.id);
  const pendingImage = app.getByTestId(`media-thumbnail-${pendingPhoto.id}`).locator('img');
  await expect(pendingImage).toBeVisible(); await expect.poll(() => pendingImage.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await pendingImage.scrollIntoViewIfNeeded();
  receipt.pendingPhotoSurvivesSaveAndReload = true; save(); await photo('s748-pending-reloaded.png');
  receipt.appVersionAfter = await version(); assert.equal(receipt.appVersionAfter, expectedSha);
  receipt.behaviorPassed = true;
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, name: error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 500) }; save();
  if (await app.getByRole('dialog').isVisible().catch(() => false)) await photo('failure.png').catch(() => {});
} finally {
  phase('remove exact owned attachments and templates, then revoke sessions'); forceFallback = false;
  for (const id of receipt.attachments) {
    try {
      const r = await call(`/api/checklist-media/${id}`, 'DELETE'); assert.ok([200,404].includes(r.status()));
      const read = await call('/api/checklist-media/url?s3Key=' + encodeURIComponent(keys.get(id))); assert.equal(read.status(), 404);
      receipt.cleanup.push({ attachmentId: id, deleteStatus: r.status(), readStatus: read.status() });
    } catch (error) { failed = true; receipt.cleanup.push({ attachmentId: id, failed: error.name }); }
    save();
  }
  for (const id of receipt.templates) {
    try {
      const r = await call(`/api/checklists/templates/${id}`, 'DELETE'); assert.equal(r.status(), 200);
      const read = await call(`/api/checklists/templates/${id}`); assert.equal(read.status(), 404);
      receipt.cleanup.push({ templateId: id, deleteStatus: r.status(), readStatus: read.status() });
    } catch (error) { failed = true; receipt.cleanup.push({ templateId: id, failed: error.name }); }
    save();
  }
  for (const [origin, path, readPath] of [[origins.app, '/api/logout', '/api/user'], [origins.launcher, '/api/auth/sign-out', '/api/me']]) {
    try { const r = await call(path, 'POST', {}, origin); const read = await call(readPath, 'GET', undefined, origin); assert.equal(read.status(), 401); receipt.cleanup.push({ origin, signOutStatus: r.status(), readStatus: read.status() }); }
    catch (error) { failed = true; receipt.cleanup.push({ origin, failed: error.name }); }
    save();
  }
  await context.close(); await browser.close();
  receipt.passed = !failed && receipt.behaviorPassed === true; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, failure: receipt.failure }));
process.exitCode = receipt.passed ? 0 : 1;
