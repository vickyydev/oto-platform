// SCRUM-855 staging proof: a recording with no length is accepted and plays.
// Only ZZ TEST fixtures; synthetic media; signed URLs and keys never saved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const root = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const expectedSha = process.argv[2]; assert.match(expectedSha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out855'); mkdirSync(out, { recursive: true });
const videoBitrate = Number(process.argv[4] ?? 8_000_000), videoSeconds = Number(process.argv[5] ?? 6);
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const receipt = { ticket: 'SCRUM-855', expectedSha, startedAt: new Date().toISOString(), phase: 'sign-in', requests: [], templates: [], runs: [], attachments: [], uploads: [], bucketPuts: [], cleanup: [], passed: false };
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
const personMask = () => [app.locator('input[type="tel"], input[type="password"]'), app.locator('[data-testid^="button-user-menu"], [data-testid="avatar-user"], span[class*="rounded-full"][class*="overflow-hidden"]')];
async function dialogPhoto(name) {
  await expect.poll(async () => (await dialog().boundingBox())?.width ?? 0).toBeGreaterThan(400);
  await dialog().screenshot({ path: resolve(out, name), animations: 'disabled', mask: personMask() });
}
async function version() {
  const r = await call('/api/qa-reports/config'); assert.equal(r.status(), 200);
  return (await r.json()).version;
}
const uploadAnswer = () => app.waitForResponse(r => r.request().method() === 'POST' && ['/api/checklist-media/upload', '/api/checklist-media/confirm'].includes(new URL(r.url()).pathname), { timeout: 600000 });
async function edit(id) {
  await app.goto(origins.app + '/studio/checklists');
  await app.getByTestId(`button-edit-checklist-${id}`).click();
  await app.getByTestId('button-expand-edit-item-0').click();
}
// Runs in the page: canvas noise through MediaRecorder; a length is written into the header only when asked.
const makeVideo = async ({ bitrate, seconds, withLength, name, caption }) => {
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
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1280, 90); ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif';
    ctx.fillText(`${caption}  frame ${frame}`, 24, 60);
    frame += 1; requestAnimationFrame(draw);
  };
  draw();
  const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType, videoBitsPerSecond: bitrate });
  const chunks = []; recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(r => { recorder.onstop = r; });
  recorder.start(500); await new Promise(r => setTimeout(r, seconds * 1000)); recorder.stop(); await done; stop = true;
  // What the browser says a file's length is: the app reads the same property.
  const lengthOf = blob => new Promise(res => {
    const v = document.createElement('video'), url = URL.createObjectURL(blob); v.preload = 'metadata';
    v.onloadedmetadata = () => { res(Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration)); URL.revokeObjectURL(url); };
    v.onerror = () => { res('error'); URL.revokeObjectURL(url); }; v.src = url;
  });
  const raw = new Blob(chunks, { type: 'video/webm' });
  const rawLength = await lengthOf(raw);
  let body = raw, lengthWritten = false;
  if (withLength) {
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
  const file = new File([body], name, { type: 'video/webm' });
  window.__zzVideo = file;
  return { recorderMimeType: mimeType, fileType: file.type, fileName: name, size: file.size, sizeMB: +(file.size / 1048576).toFixed(2), frames: frame, seconds, bitrate, browserLengthOfRawRecording: rawLength, lengthWrittenIntoHeader: lengthWritten, browserLengthOfFileSent: lengthSent };
};
// Sends window.__zzVideo through the item's own file input and samples the bar every 200 ms.
async function sendVideo(kind, fileInput, midPicture) {
  await app.evaluate(() => {
    const read = () => {
      const el = document.querySelector('[data-testid^="text-upload-item-progress-"]');
      const err = document.querySelector('[data-testid^="text-upload-error-"]');
      return { item: el ? el.textContent.trim() : null, error: err ? err.textContent.trim() : null };
    };
    window.__zzT0 = performance.now(); window.__zzSeries = [];
    window.__zzSent = null;
    if (!window.__zzXhrRead) {
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (body) {
        try { if (body instanceof FormData) window.__zzSent = { atMsAfterTheFileWasChosen: Math.round(performance.now() - window.__zzT0), fields: [...body.keys()], width: body.get('width'), height: body.get('height'), durationSeconds: body.get('durationSeconds') }; } catch { /* reading only */ }
        return send.apply(this, arguments);
      };
      window.__zzXhrRead = true;
    }
    window.__zzTimer = setInterval(() => window.__zzSeries.push({ t: Math.round(performance.now() - window.__zzT0), ...read() }), 200);
  });
  const answer = uploadAnswer(); const start = Date.now();
  await fileInput.evaluate(el => { const dt = new DataTransfer(); dt.items.add(window.__zzVideo); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); });
  let midShot = null, settled = false; answer.then(() => { settled = true; }, () => { settled = true; });
  const panel = app.getByTestId('container-global-upload-progress');
  while (!settled) {
    const text = await app.locator('[data-testid^="text-upload-item-progress-"]').first().textContent({ timeout: 500 }).catch(() => null);
    const value = text ? Number(text.replace('%', '')) : NaN;
    if (midPicture && !midShot && value >= 20 && value <= 88) {
      try { await panel.screenshot({ path: resolve(out, midPicture), timeout: 5000 }); midShot = { valueWhenTaken: value, atMs: Date.now() - start }; } catch { /* the bar finished first */ }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  const response = await answer, wallMs = Date.now() - start;
  await new Promise(r => setTimeout(r, 600));
  const series = await app.evaluate(() => { clearInterval(window.__zzTimer); return window.__zzSeries; });
  const sentByBrowser = await app.evaluate(() => window.__zzSent);
  const numbers = series.map(s => s.item).filter(Boolean).map(s => Number(s.replace('%', '')));
  const distinct = [...new Set(numbers)];
  const text = await response.text().catch(() => '');
  let raw = {}; try { raw = JSON.parse(text); } catch { /* not JSON */ }
  const attachment = raw.attachment ?? raw;
  const row = { kind, route: new URL(response.url()).pathname, status: response.status(), wallMs, sentByBrowser, attachmentId: attachment.id, type: attachment.type, mimeType: attachment.mimeType, storedFileSize: attachment.fileSize,
    answered: { width: attachment.width, height: attachment.height, durationSeconds: attachment.durationSeconds },
    progress: { sampledEveryMs: 200, numbers, distinct, start: numbers[0], end: numbers[numbers.length - 1], strictlyBetween: distinct.filter(v => v > numbers[0] && v < numbers[numbers.length - 1]).length, errorLine: series.map(s => s.error).find(Boolean) ?? null, midBarPicture: midShot } };
  if (response.status() !== 200) row.serverWords = text.replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 400);
  receipt.uploads.push(row);
  if (attachment.id) { receipt.attachments.push(attachment.id); keys.set(attachment.id, attachment.s3Key); } save();
  return { row, attachment };
}
async function readBack(itemId, attachmentId) {
  const r = await call(`/api/checklist-media/by-item/${itemId}`); const body = await r.json().catch(() => ({}));
  const list = Array.isArray(body) ? body : (body.attachments ?? []);
  const found = list.find(a => a.id === attachmentId);
  return { status: r.status(), found: !!found, type: found?.type, mimeType: found?.mimeType, fileSize: found?.fileSize, width: found?.width, height: found?.height, durationSeconds: found?.durationSeconds, durationIsNull: found ? found.durationSeconds === null : undefined };
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

  phase('ZZ TEST checklist with one item');
  const made = await call('/api/checklists/templates', 'POST', { name: `ZZ TEST SCRUM-855 ${suffix}`, branchIds: [branch.id], recurrence: 'weekly', weeklyDays: ['sun'], items: [{ title: 'ZZ TEST media reference' }] });
  assert.equal(made.status(), 201); const saved = await made.json(); receipt.templates.push(saved.id); save();
  const details = await (await call(`/api/checklists/templates/${saved.id}`)).json();
  const itemId = details.items[0].id; assert.ok(itemId); assert.equal(details.items.length, 1);
  receipt.checklist = { status: made.status(), templateId: saved.id, items: details.items.length };

  let fileInput;
  // 'length-only' repeats just the record-only video with its length.
  if (process.argv[6] !== 'length-only') {
  phase('raw recording, no length in its header');
  await edit(saved.id);
  fileInput = dialog().locator('input[type="file"]').last();
  const rawVideo = await app.evaluate(makeVideo, { bitrate: videoBitrate, seconds: videoSeconds, withLength: false, name: 'ZZ TEST SCRUM-855 no-length video.webm', caption: 'ZZ TEST SCRUM-855 no-length video' });
  receipt.noLengthVideo = { ...rawVideo, content: 'canvas noise and a moving colour block with a ZZ TEST caption; no person, no sound' }; save();
  console.log(JSON.stringify(rawVideo));
  assert.equal(rawVideo.browserLengthOfFileSent, 'Infinity', 'the raw recording was expected to have no length');
  assert.ok(rawVideo.size >= 2 * 1048576, 'video under 2 MB');
  const first = await sendVideo('no-length video', fileInput, '855-0-no-length-video-progress-mid-bar.png');
  console.log(JSON.stringify(first.row));
  assert.equal(first.row.status, 200, 'the no-length upload was not accepted');
  assert.equal(first.row.route, '/api/checklist-media/upload');
  assert.equal(first.attachment.checklistTemplateItemId, itemId); assert.equal(first.attachment.type, 'video');
  receipt.noLengthReadBack = await readBack(itemId, first.attachment.id); save();
  assert.equal(receipt.noLengthReadBack.found, true); assert.equal(receipt.noLengthReadBack.durationSeconds, null);
  const thumb = app.getByTestId(`media-thumbnail-${first.attachment.id}`); await expect(thumb).toBeVisible();
  await thumb.scrollIntoViewIfNeeded();
  await expect.poll(() => thumb.locator('video').evaluateAll(v => v.some(x => x.readyState >= 1)), { timeout: 30000 }).toBe(true).catch(() => {});
  await dialogPhoto('855-1-no-length-video-on-item.png');
  await app.getByTestId('button-cancel-edit').click();

  phase('the no-length video plays in the app viewer');
  const started = await call('/api/checklist-runs/start', 'POST', { templateId: saved.id, branchId: branch.id });
  assert.equal(started.status(), 200); const run = await started.json(); receipt.runs.push(run.id); save();
  await app.goto(origins.app + `/core/checklist/${run.id}`);
  await app.getByTestId('button-view-media').first().click();
  const viewer = app.getByTestId('media-viewer-modal'); await expect(viewer).toBeVisible();
  const player = viewer.locator('video'); await expect(player).toHaveCount(1, { timeout: 30000 });
  await player.evaluate(async v => { v.muted = true; await v.play(); });
  await expect.poll(() => player.evaluate(v => v.readyState >= 2 && v.currentTime > 1), { timeout: 60000 }).toBe(true);
  receipt.playback = await player.evaluate(v => ({ readyState: v.readyState, currentTime: +v.currentTime.toFixed(2), paused: v.paused, ended: v.ended, videoWidth: v.videoWidth, videoHeight: v.videoHeight, durationTheBrowserReports: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration), error: v.error ? v.error.code : null }));
  save();
  // The dark viewer is not fully opaque and its frame reaches the page's top right corner: cover the signed-in person's menu.
  await viewer.screenshot({ path: resolve(out, '855-2-no-length-video-playing.png'), mask: personMask() });
  receipt.playback.userMenuMasked = await app.locator('[data-testid^="button-user-menu"]').count();
  receipt.playback.advance = await player.evaluate(async v => { const a = v.currentTime; await new Promise(r => setTimeout(r, 700)); return { before: +a.toFixed(2), after: +v.currentTime.toFixed(2), ended: v.ended }; });
  save();
  assert.ok(receipt.playback.readyState >= 2 && receipt.playback.currentTime > 0);
  await app.getByTestId('button-close-media-viewer').click();
  receipt.noLengthPassed = true; save();
  }

  phase('the normal video with its length, record only');
  await edit(saved.id);
  fileInput = dialog().locator('input[type="file"]').last();
  const normalVideo = await app.evaluate(makeVideo, { bitrate: videoBitrate, seconds: videoSeconds, withLength: true, name: 'ZZ TEST SCRUM-855 video with length.webm', caption: 'ZZ TEST SCRUM-855 video with length' });
  receipt.videoWithLength = normalVideo; save();
  const second = await sendVideo('video with its length', fileInput, null);
  console.log(JSON.stringify(second.row));
  receipt.withLengthReadBack = second.attachment.id ? await readBack(itemId, second.attachment.id) : null; save();
  assert.equal(second.row.status, 200, 'the video with its length was not accepted');
  // Record only: the measures are stored when the browser finished measuring before the upload began.
  receipt.withLengthMeasuresStored = receipt.withLengthReadBack.durationSeconds === videoSeconds; save();
  await app.getByTestId('button-cancel-edit').click();
  receipt.appVersionAfter = await version(); assert.equal(receipt.appVersionAfter, expectedSha);
  receipt.behaviorPassed = true;
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, name: error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 500) }; save();
  if (await dialog().first().isVisible().catch(() => false)) await dialog().first().screenshot({ path: resolve(out, 'failure-dialog.png'), mask: personMask() }).catch(() => {});
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
console.log(JSON.stringify({ passed: receipt.passed, noLengthPassed: receipt.noLengthPassed === true, failure: receipt.failure, noLengthReadBack: receipt.noLengthReadBack, withLengthReadBack: receipt.withLengthReadBack, playback: receipt.playback, cleanup: receipt.cleanup }));
process.exitCode = receipt.passed ? 0 : 1;
