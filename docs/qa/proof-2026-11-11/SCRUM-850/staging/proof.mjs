// SCRUM-850 staging proof: photo and synthetic video through the app server.
// Only ZZ TEST fixtures; synthetic media; signed URLs and keys never saved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const root = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const expectedSha = process.argv[2]; assert.match(expectedSha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out850'); mkdirSync(out, { recursive: true });
const videoBitrate = Number(process.argv[4] ?? 8_000_000), videoSeconds = Number(process.argv[5] ?? 6);
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const receipt = { ticket: 'SCRUM-850', expectedSha, startedAt: new Date().toISOString(), phase: 'sign-in', requests: [], templates: [], runs: [], attachments: [], uploads: [], bucketPuts: [], cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(value); };
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const app = await context.newPage(); app.setDefaultTimeout(30000);
const keys = new Map(); let failed = false;
// What the browser's own attempt at the bucket met; the address is never kept.
const isBucket = url => { const o = new URL(url).origin; return o !== origins.app && o !== origins.launcher; };
app.on('requestfailed', r => { if (['PUT', 'OPTIONS'].includes(r.method()) && isBucket(r.url())) { receipt.bucketPuts.push({ method: r.method(), outcome: 'failed', reason: r.failure()?.errorText }); save(); } });
app.on('response', r => { const q = r.request(); if (['PUT', 'OPTIONS'].includes(q.method()) && isBucket(r.url())) { receipt.bucketPuts.push({ method: q.method(), outcome: 'answered', status: r.status() }); save(); } });
async function call(path, method = 'GET', data, origin = origins.app) {
  const r = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }), headers: { origin } });
  receipt.requests.push({ method, path: path.split('?')[0], status: r.status() }); save(); return r;
}
const dialog = () => app.getByRole('dialog');
async function dialogPhoto(name) {
  await expect.poll(async () => (await dialog().boundingBox())?.width ?? 0).toBeGreaterThan(400);
  await dialog().screenshot({ path: resolve(out, name), animations: 'disabled', mask: [app.locator('input[type="tel"], input[type="password"]')] });
}
async function version() {
  const r = await call('/api/qa-reports/config'); assert.equal(r.status(), 200);
  return (await r.json()).version;
}
const uploadAnswer = () => app.waitForResponse(r => r.request().method() === 'POST' && ['/api/checklist-media/upload', '/api/checklist-media/confirm'].includes(new URL(r.url()).pathname), { timeout: 600000 });
async function recordUpload(kind, response, extra = {}) {
  const raw = await response.json().catch(() => ({})), attachment = raw.attachment ?? raw;
  const row = { kind, route: new URL(response.url()).pathname, status: response.status(), attachmentId: attachment.id, type: attachment.type, mimeType: attachment.mimeType, storedFileSize: attachment.fileSize, checklistTemplateItemId: attachment.checklistTemplateItemId, ...extra };
  receipt.uploads.push(row);
  if (attachment.id) { receipt.attachments.push(attachment.id); keys.set(attachment.id, attachment.s3Key); } save();
  assert.equal(response.status(), 200); assert.ok(attachment.id);
  assert.equal(row.route, '/api/checklist-media/upload');
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

  phase('step 1: ZZ TEST checklist with one item');
  const made = await call('/api/checklists/templates', 'POST', { name: `ZZ TEST SCRUM-850 ${suffix}`, branchIds: [branch.id], recurrence: 'weekly', weeklyDays: ['sun'], items: [{ title: 'ZZ TEST media reference' }] });
  assert.equal(made.status(), 201); const saved = await made.json(); receipt.templates.push(saved.id); save();
  const details = await (await call(`/api/checklists/templates/${saved.id}`)).json();
  const itemId = details.items[0].id; assert.ok(itemId); assert.equal(details.items.length, 1);
  receipt.checklist = { status: made.status(), templateId: saved.id, items: details.items.length };

  phase('step 2: photo from the browser');
  await edit(saved.id);
  const fileInput = dialog().locator('input[type="file"]').last();
  const photoBytes = readFileSync(resolve(root, 'apps/oto-app/tests/fixtures/media/checklist-evidence.jpg'));
  let answer = uploadAnswer(); const photoStart = Date.now();
  await fileInput.setInputFiles({ name: 'ZZ TEST SCRUM-850 photo.jpg', mimeType: 'image/jpeg', buffer: photoBytes });
  let response = await answer;
  const photo = await recordUpload('photo', response, { sentBytes: photoBytes.length, wallMs: Date.now() - photoStart });
  assert.equal(photo.checklistTemplateItemId, itemId);
  const photoThumb = app.getByTestId(`media-thumbnail-${photo.id}`); await expect(photoThumb).toBeVisible();
  await expect.poll(() => photoThumb.locator('img').evaluateAll(images => images.some(img => img.complete && img.naturalWidth > 0))).toBe(true);
  await photoThumb.scrollIntoViewIfNeeded();
  receipt.photoShowsOnItem = true; save();
  await dialogPhoto('850-1-photo-on-item.png');
  // The finished row leaves the progress panel three seconds after it completes.
  await expect(app.getByTestId('container-global-upload-progress')).toBeHidden({ timeout: 15000 });

  phase('step 3: synthetic video made in the page');
  const made2 = await app.evaluate(async ({ bitrate, seconds, withLength }) => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    const tile = document.createElement('canvas'); tile.width = 320; tile.height = 180;
    const tctx = tile.getContext('2d'); const img = tctx.createImageData(320, 180);
    let frame = 0, stop = false;
    const draw = () => {
      if (stop) return;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = Math.random() * 255; d[i + 1] = Math.random() * 255; d[i + 2] = Math.random() * 255; d[i + 3] = 255; }
      tctx.putImageData(img, 0, 0); ctx.drawImage(tile, 0, 0, 1280, 720);
      const hue = (frame * 6) % 360; ctx.fillStyle = `hsl(${hue} 90% 50%)`; ctx.fillRect((frame * 14) % 1280 - 200, 240, 400, 240);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1280, 90); ctx.fillStyle = '#fff'; ctx.font = 'bold 44px sans-serif';
      ctx.fillText(`ZZ TEST SCRUM-850 synthetic video  frame ${frame}`, 24, 60);
      frame += 1; requestAnimationFrame(draw);
    };
    draw();
    const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType, videoBitsPerSecond: bitrate });
    const chunks = []; recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise(r => { recorder.onstop = r; });
    recorder.start(500); await new Promise(r => setTimeout(r, seconds * 1000)); recorder.stop(); await done; stop = true;
    // What the browser says a file's length is: the app reads the same property.
    const lengthOf = blob => new Promise(done => {
      const v = document.createElement('video'), url = URL.createObjectURL(blob); v.preload = 'metadata';
      v.onloadedmetadata = () => { done(Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration)); URL.revokeObjectURL(url); };
      v.onerror = () => { done('error'); URL.revokeObjectURL(url); }; v.src = url;
    });
    const raw = new Blob(chunks, { type: 'video/webm' });
    const rawLength = await lengthOf(raw);
    let body = raw, lengthWritten = false;
    if (withLength) {
      // A recording made in the browser carries no length. Write one into its
      // header (the Info element's Duration), as a file from a phone has.
      const buf = new Uint8Array(await raw.arrayBuffer()); let p = -1;
      for (let i = 0; i < Math.min(buf.length, 65536) - 4; i += 1) if (buf[i] === 0x15 && buf[i + 1] === 0x49 && buf[i + 2] === 0xA9 && buf[i + 3] === 0x66) { p = i; break; }
      if (p < 0) throw new Error('no Info element in the recording');
      const first = buf[p + 4]; let len = 1; while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1;
      let size = first & (0xFF >> len); for (let k = 1; k < len; k += 1) size = size * 256 + buf[p + 4 + k];
      const bodyStart = p + 4 + len, bodyEnd = bodyStart + size;
      const dur = new Uint8Array(11); dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88; new DataView(dur.buffer).setFloat64(3, seconds * 1000);
      const sizeBytes = new Uint8Array(8); sizeBytes[0] = 0x01; let n = size + 11; for (let k = 7; k >= 1; k -= 1) { sizeBytes[k] = n & 0xFF; n = Math.floor(n / 256); }
      body = new Blob([buf.subarray(0, p + 4), sizeBytes, buf.subarray(bodyStart, bodyEnd), dur, buf.subarray(bodyEnd)], { type: 'video/webm' });
      lengthWritten = true;
    }
    const lengthSent = await lengthOf(body);
    const file = new File([body], 'ZZ TEST SCRUM-850 video.webm', { type: 'video/webm' });
    window.__zzVideo = file;
    return { recorderMimeType: mimeType, fileType: file.type, size: file.size, frames: frame, seconds, bitrate, browserLengthOfRawRecording: rawLength, lengthWrittenIntoHeader: lengthWritten, browserLengthOfFileSent: lengthSent };
  }, { bitrate: videoBitrate, seconds: videoSeconds, withLength: process.argv[6] !== 'raw' });
  if (process.argv[6] !== 'raw') assert.equal(typeof made2.browserLengthOfFileSent, 'number', 'the file sent has no finite length');
  receipt.video = { ...made2, sizeMB: +(made2.size / 1048576).toFixed(2), content: 'canvas noise and a moving colour block with a ZZ TEST caption; no person, no sound' }; save();
  console.log(JSON.stringify(receipt.video));
  assert.ok(made2.size >= 2 * 1048576, 'video under 2 MB');

  phase('step 3: video upload with the progress sampled');
  await app.evaluate(() => {
    const read = () => {
      const el = document.querySelector('[data-testid^="text-upload-item-progress-"]');
      const bar = document.querySelector('[data-testid^="container-upload-item-"] [role="progressbar"]');
      const err = document.querySelector('[data-testid^="text-upload-error-"]');
      return { item: el ? el.textContent.trim() : null, bar: bar ? (bar.getAttribute('aria-valuenow') ?? bar.getAttribute('data-value')) : null, header: document.querySelector('[data-testid="text-upload-progress"]')?.textContent.trim() ?? null, error: err ? err.textContent.trim() : null };
    };
    window.__zzT0 = performance.now(); window.__zzSeries = []; window.__zzChanges = [];
    window.__zzTimer = setInterval(() => window.__zzSeries.push({ t: Math.round(performance.now() - window.__zzT0), ...read() }), 200);
    let last;
    window.__zzObserver = new MutationObserver(() => { const v = read().item; if (v !== last) { last = v; window.__zzChanges.push({ t: Math.round(performance.now() - window.__zzT0), item: v }); } });
    window.__zzObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  answer = uploadAnswer(); const videoStart = Date.now();
  await fileInput.evaluate(el => { const dt = new DataTransfer(); dt.items.add(window.__zzVideo); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); });
  let midShot = null, settled = false; answer.then(() => { settled = true; }, () => { settled = true; });
  const panel = app.getByTestId('container-global-upload-progress');
  while (!settled) {
    const text = await app.locator('[data-testid^="text-upload-item-progress-"]').first().textContent({ timeout: 500 }).catch(() => null);
    const value = text ? Number(text.replace('%', '')) : NaN;
    if (!midShot && value >= 20 && value <= 88) {
      try { await panel.screenshot({ path: resolve(out, '850-2-video-progress-mid-bar.png'), timeout: 5000 }); midShot = { valueWhenTaken: value, atMs: Date.now() - videoStart }; } catch { /* the bar finished first */ }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  response = await answer; const wallMs = Date.now() - videoStart;
  const timing = response.request().timing();
  await new Promise(r => setTimeout(r, 600));
  const sampled = await app.evaluate(() => { clearInterval(window.__zzTimer); window.__zzObserver.disconnect(); return { series: window.__zzSeries, changes: window.__zzChanges }; });
  const numbers = sampled.series.map(s => s.item).filter(Boolean).map(s => Number(s.replace('%', '')));
  const distinct = [...new Set(numbers)];
  const strictlyBetween = distinct.filter(v => v > numbers[0] && v < numbers[numbers.length - 1]);
  receipt.progress = { sampledEveryMs: 200, series: sampled.series.map(s => ({ t: s.t, item: s.item, bar: s.bar, error: s.error })).filter(s => s.item !== null || s.error !== null), numbers, distinct, start: numbers[0], end: numbers[numbers.length - 1], strictlyBetween, everyChangeSeen: sampled.changes, midBarPicture: midShot };
  save();
  const video = await recordUpload('video', response, { sentBytes: made2.size, wallMs, requestToResponseMs: Math.round(timing.responseEnd > 0 ? timing.responseEnd : timing.responseStart) });
  assert.equal(video.checklistTemplateItemId, itemId); assert.equal(video.type, 'video');
  assert.ok(distinct.length > 1, 'progress never changed'); assert.ok(strictlyBetween.length > 0, 'no value between start and end');
  receipt.progress.moved = true; save();
  const videoThumb = app.getByTestId(`media-thumbnail-${video.id}`); await expect(videoThumb).toBeVisible();
  await videoThumb.scrollIntoViewIfNeeded();
  await expect.poll(() => videoThumb.locator('video').evaluateAll(v => v.some(x => x.readyState >= 1)), { timeout: 30000 }).toBe(true).catch(() => {});
  await dialogPhoto('850-3-video-on-item.png');
  await app.getByTestId('button-cancel-edit').click();

  phase('step 4: playback in the app viewer');
  const started = await call('/api/checklist-runs/start', 'POST', { templateId: saved.id, branchId: branch.id });
  assert.equal(started.status(), 200); const run = await started.json(); receipt.runs.push(run.id); save();
  await app.goto(origins.app + `/core/checklist/${run.id}`);
  await app.getByTestId('button-view-media').first().click();
  const viewer = app.getByTestId('media-viewer-modal'); await expect(viewer).toBeVisible();
  for (let i = 0; i < 3; i += 1) {
    await expect(viewer.locator('img, video')).toHaveCount(1, { timeout: 30000 });
    if (await viewer.locator('video').count() > 0) break;
    await app.getByTestId('button-media-next').click();
    await app.waitForTimeout(400);
  }
  const player = viewer.locator('video'); await expect(player).toHaveCount(1, { timeout: 30000 });
  await player.evaluate(async v => { v.muted = true; await v.play(); });
  await expect.poll(() => player.evaluate(v => v.readyState >= 2 && v.currentTime > 1), { timeout: 60000 }).toBe(true);
  receipt.playback = await player.evaluate(v => ({ readyState: v.readyState, currentTime: +v.currentTime.toFixed(2), paused: v.paused, ended: v.ended, videoWidth: v.videoWidth, videoHeight: v.videoHeight, error: v.error ? v.error.code : null, fromAppOrigin: new URL(v.currentSrc).origin === location.origin }));
  save();
  // The dark viewer is not fully opaque and its frame reaches the page's top right corner: cover the signed-in person's menu.
  await viewer.screenshot({ path: resolve(out, '850-4-video-playing.png'), mask: [app.locator('[data-testid^="button-user-menu"], [data-testid="avatar-user"], span[class*="rounded-full"][class*="overflow-hidden"]')] });
  receipt.playback.userMenuMasked = await app.locator('[data-testid^="button-user-menu"]').count();
  const later = await player.evaluate(async v => { const a = v.currentTime; await new Promise(r => setTimeout(r, 700)); return { before: +a.toFixed(2), after: +v.currentTime.toFixed(2), ended: v.ended }; });
  receipt.playback.advance = later; save();
  assert.ok(receipt.playback.readyState >= 2 && receipt.playback.currentTime > 0);
  await app.getByTestId('button-close-media-viewer').click();
  receipt.appVersionAfter = await version(); assert.equal(receipt.appVersionAfter, expectedSha);
  receipt.behaviorPassed = true;
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, name: error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 500) }; save();
  try {
    const sampled = await app.evaluate(() => ({ series: window.__zzSeries, changes: window.__zzChanges }));
    if (sampled.series && !receipt.progress) { receipt.progressAtFailure = { series: sampled.series.filter(s => s.item !== null || s.error !== null), changes: sampled.changes }; save(); }
  } catch { /* page gone */ }
  if (await dialog().first().isVisible().catch(() => false)) await dialog().first().screenshot({ path: resolve(out, 'failure-dialog.png') }).catch(() => {});
  await app.getByTestId('container-global-upload-progress').screenshot({ path: resolve(out, 'failure-progress-panel.png'), timeout: 3000 }).catch(() => {});
} finally {
  phase('remove exact owned attachments, checklist and run, then sign out');
  for (const id of receipt.attachments) {
    try {
      const r = await call(`/api/checklist-media/${id}`, 'DELETE'); assert.ok([200, 404].includes(r.status()));
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
  for (const id of receipt.runs) {
    try { const read = await call(`/api/checklist-runs/${id}`); assert.equal(read.status(), 404); receipt.cleanup.push({ runId: id, removedWithChecklist: true, readStatus: read.status() }); }
    catch (error) { failed = true; receipt.cleanup.push({ runId: id, failed: error.name }); }
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
console.log(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, failure: receipt.failure, uploads: receipt.uploads, progress: receipt.progress && { distinct: receipt.progress.distinct, mid: receipt.progress.midBarPicture }, playback: receipt.playback, cleanup: receipt.cleanup }));
process.exitCode = receipt.passed ? 0 : 1;
