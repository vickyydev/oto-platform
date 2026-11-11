// SCRUM-856 staging proof: the upload waits for its file to be measured, so the measures are saved.
// Only ZZ TEST fixtures; synthetic media; signed URLs and keys never saved. A new browser profile per launch.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const root = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { chromium, expect } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const expectedSha = process.argv[2]; assert.match(expectedSha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out856'); mkdirSync(out, { recursive: true });
const RUNS = Number(process.argv[4] ?? 5), videoBitrate = 8_000_000, videoSeconds = 6;
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const receipt = { ticket: 'SCRUM-856', expectedSha, startedAt: new Date().toISOString(), phase: 'sign-in', requests: [], templates: [], runs: [], attachments: [], withLengthRuns: [], bucketPuts: [], cleanup: [], passed: false };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(value); };
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const app = await context.newPage(); app.setDefaultTimeout(30000);
const keys = new Map(); let failed = false;
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
let branch, suffix, counter = 0;
// A fresh ZZ TEST checklist with one item, opened in the editor with the item expanded.
async function freshItem(label) {
  counter += 1;
  const made = await call('/api/checklists/templates', 'POST', { name: `ZZ TEST SCRUM-856 ${suffix} ${counter} ${label}`, branchIds: [branch.id], recurrence: 'weekly', weeklyDays: ['sun'], items: [{ title: 'ZZ TEST media reference' }] });
  assert.equal(made.status(), 201); const saved = await made.json(); receipt.templates.push(saved.id); save();
  const details = await (await call(`/api/checklists/templates/${saved.id}`)).json();
  const itemId = details.items[0].id; assert.ok(itemId);
  await app.goto(origins.app + '/studio/checklists');
  await app.getByTestId(`button-edit-checklist-${saved.id}`).click();
  await app.getByTestId('button-expand-edit-item-0').click();
  return { templateId: saved.id, itemId, fileInput: dialog().locator('input[type="file"]').last() };
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
  const lengthOf = blob => new Promise(res => {
    const v = document.createElement('video'), url = URL.createObjectURL(blob); v.preload = 'metadata';
    v.onloadedmetadata = () => { res(Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration)); URL.revokeObjectURL(url); };
    v.onerror = () => { res('error'); URL.revokeObjectURL(url); }; v.src = url;
  });
  const raw = new Blob(chunks, { type: 'video/webm' });
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
  window.__zzFile = new File([body], name, { type: 'video/webm' });
  return { fileName: name, fileType: 'video/webm', size: window.__zzFile.size, sizeMB: +(window.__zzFile.size / 1048576).toFixed(2), lengthWrittenIntoHeader: lengthWritten, browserLengthOfFileSent: lengthSent };
};
// Chooses window.__zzFile on the item's own file input, reads (never changes) the form the browser sends and when.
async function sendFile(kind, fileInput) {
  await app.evaluate(() => {
    window.__zzSent = null; window.__zzSeries = []; window.__zzT0 = performance.now();
    if (!window.__zzXhrRead) {
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (body) {
        try { if (body instanceof FormData) window.__zzSent = { msAfterTheFileWasChosen: Math.round(performance.now() - window.__zzT0), fields: [...body.keys()], width: body.get('width'), height: body.get('height'), durationSeconds: body.get('durationSeconds') }; } catch { /* reading only */ }
        return send.apply(this, arguments);
      };
      window.__zzXhrRead = true;
    }
    window.__zzTimer = setInterval(() => {
      const el = document.querySelector('[data-testid^="text-upload-item-progress-"]'), err = document.querySelector('[data-testid^="text-upload-error-"]');
      window.__zzSeries.push({ item: el ? el.textContent.trim() : null, error: err ? err.textContent.trim() : null });
    }, 200);
  });
  const answer = uploadAnswer(); const start = Date.now();
  // The clock starts in the same step that chooses the file.
  await fileInput.evaluate(el => { const dt = new DataTransfer(); dt.items.add(window.__zzFile); el.files = dt.files; window.__zzT0 = performance.now(); el.dispatchEvent(new Event('change', { bubbles: true })); });
  const response = await answer, wallMs = Date.now() - start;
  await new Promise(r => setTimeout(r, 400));
  const page = await app.evaluate(() => { clearInterval(window.__zzTimer); return { series: window.__zzSeries, sent: window.__zzSent }; });
  const numbers = page.series.map(s => s.item).filter(Boolean).map(s => Number(s.replace('%', '')));
  const text = await response.text().catch(() => '');
  let raw = {}; try { raw = JSON.parse(text); } catch { /* not JSON */ }
  const attachment = raw.attachment ?? raw;
  const row = { kind, route: new URL(response.url()).pathname, status: response.status(), wallMs, formTheBrowserSent: page.sent, attachmentId: attachment.id, type: attachment.type, storedFileSize: attachment.fileSize,
    answered: { width: attachment.width, height: attachment.height, durationSeconds: attachment.durationSeconds }, bar: [...new Set(numbers)], errorLine: page.series.map(s => s.error).find(Boolean) ?? null };
  if (response.status() !== 200) row.serverWords = text.replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 400);
  if (attachment.id) { receipt.attachments.push(attachment.id); keys.set(attachment.id, attachment.s3Key); } save();
  return { row, attachment };
}
async function readBack(itemId, attachmentId) {
  const r = await call(`/api/checklist-media/by-item/${itemId}`); const body = await r.json().catch(() => ({}));
  const list = Array.isArray(body) ? body : (body.attachments ?? []);
  const found = list.find(a => a.id === attachmentId);
  return { status: r.status(), found: !!found, type: found?.type, fileSize: found?.fileSize, width: found?.width, height: found?.height, durationSeconds: found?.durationSeconds };
}
async function thumbnailLabel(attachmentId) {
  const thumb = app.getByTestId(`media-thumbnail-${attachmentId}`); await expect(thumb).toBeVisible();
  await thumb.scrollIntoViewIfNeeded();
  return (await thumb.textContent())?.trim() ?? '';
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
  branch = branches.find(b => b.isActive !== false && !b.archivedAt); assert.ok(branch);
  suffix = Date.now().toString(36);

  for (let i = 1; i <= RUNS; i += 1) {
    phase(`video with its length, run ${i} of ${RUNS}`);
    const item = await freshItem(`video ${i}`);
    const file = await app.evaluate(makeVideo, { bitrate: videoBitrate, seconds: videoSeconds, withLength: true, name: `ZZ TEST SCRUM-856 video ${i}.webm`, caption: `ZZ TEST SCRUM-856 video ${i}` });
    const { row, attachment } = await sendFile('video with its length', item.fileInput);
    row.run = i; row.file = file;
    row.readBack = attachment.id ? await readBack(item.itemId, attachment.id) : null;
    row.thumbnailLabel = attachment.id ? await thumbnailLabel(attachment.id) : null;
    const sent = row.formTheBrowserSent ?? {};
    row.pass = row.status === 200 && row.route === '/api/checklist-media/upload'
      && ['file', 'target', 'checklistTemplateItemId', 'width', 'height', 'durationSeconds'].every(f => (sent.fields ?? []).includes(f))
      && sent.width === '1280' && sent.height === '720' && sent.durationSeconds === '6'
      && row.readBack?.width === 1280 && row.readBack?.height === 720 && row.readBack?.durationSeconds === 6
      && row.thumbnailLabel === '0:06';
    receipt.withLengthRuns.push(row); save();
    console.log(JSON.stringify({ run: i, pass: row.pass, status: row.status, ms: sent.msAfterTheFileWasChosen, fields: sent.fields, sent: [sent.width, sent.height, sent.durationSeconds], readBack: row.readBack, label: row.thumbnailLabel, wallMs: row.wallMs }));
    if (i === 1 && row.thumbnailLabel === '0:06') await dialogPhoto('856-1-video-length-label.png');
    await app.getByTestId('button-cancel-edit').click();
  }
  receipt.withLengthPassed = receipt.withLengthRuns.filter(r => r.pass).length; receipt.withLengthOf = RUNS; save();

  phase('the synthetic photo, once');
  {
    const item = await freshItem('photo');
    const bytes = readFileSync(resolve(root, 'apps/oto-app/tests/fixtures/media/checklist-evidence.jpg')).toString('base64');
    await app.evaluate(b64 => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) u[i] = bin.charCodeAt(i); window.__zzFile = new File([u], 'ZZ TEST SCRUM-856 photo.jpg', { type: 'image/jpeg' }); }, bytes);
    const { row, attachment } = await sendFile('photo', item.fileInput);
    row.fixture = { bytes: 583, pixels: '320 x 180' };
    row.readBack = attachment.id ? await readBack(item.itemId, attachment.id) : null;
    row.pass = row.status === 200 && Number.isInteger(row.readBack?.width) && row.readBack.width > 0 && Number.isInteger(row.readBack?.height) && row.readBack.height > 0;
    receipt.photo = row; save(); console.log(JSON.stringify({ photo: row }));
    await app.getByTestId('button-cancel-edit').click();
  }

  phase('the raw no-length recording, once');
  {
    const item = await freshItem('no-length');
    const file = await app.evaluate(makeVideo, { bitrate: videoBitrate, seconds: videoSeconds, withLength: false, name: 'ZZ TEST SCRUM-856 no-length video.webm', caption: 'ZZ TEST SCRUM-856 no-length video' });
    const { row, attachment } = await sendFile('no-length video', item.fileInput);
    row.file = file;
    row.readBack = attachment.id ? await readBack(item.itemId, attachment.id) : null;
    row.thumbnailLabel = attachment.id ? await thumbnailLabel(attachment.id) : null;
    receipt.noLength = row; save(); console.log(JSON.stringify({ noLength: row }));
    await app.getByTestId('button-cancel-edit').click();
    if (attachment.id) {
      const started = await call('/api/checklist-runs/start', 'POST', { templateId: item.templateId, branchId: branch.id });
      assert.equal(started.status(), 200); const run = await started.json(); receipt.runs.push(run.id); save();
      await app.goto(origins.app + `/core/checklist/${run.id}`);
      await app.getByTestId('button-view-media').first().click();
      const viewer = app.getByTestId('media-viewer-modal'); await expect(viewer).toBeVisible();
      const player = viewer.locator('video'); await expect(player).toHaveCount(1, { timeout: 30000 });
      await player.evaluate(async v => { v.muted = true; await v.play(); });
      await expect.poll(() => player.evaluate(v => v.readyState >= 2 && v.currentTime > 1), { timeout: 60000 }).toBe(true);
      row.playback = await player.evaluate(v => ({ readyState: v.readyState, currentTime: +v.currentTime.toFixed(2), paused: v.paused, videoWidth: v.videoWidth, videoHeight: v.videoHeight, error: v.error ? v.error.code : null }));
      await app.getByTestId('button-close-media-viewer').click();
    }
    row.pass = row.status === 200 && row.readBack?.durationSeconds === null && row.readBack?.width === 1280 && row.readBack?.height === 720 && row.playback?.readyState >= 2 && row.playback?.currentTime > 0;
    save();
  }
  receipt.appVersionAfter = await version(); assert.equal(receipt.appVersionAfter, expectedSha);
  receipt.behaviorPassed = receipt.withLengthPassed === RUNS;
} catch (error) {
  failed = true; receipt.failure = { phase: receipt.phase, name: error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 500) }; save();
  if (await dialog().first().isVisible().catch(() => false)) await dialog().first().screenshot({ path: resolve(out, 'failure-dialog.png'), mask: personMask() }).catch(() => {});
} finally {
  phase('remove exact owned attachments, checklists and run, then sign out');
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
console.log(JSON.stringify({ passed: receipt.passed, withLength: `${receipt.withLengthPassed} of ${receipt.withLengthOf}`, photoPass: receipt.photo?.pass, noLengthPass: receipt.noLength?.pass, failure: receipt.failure, cleanupFailures: receipt.cleanup.filter(c => c.failed).length, cleanupCount: receipt.cleanup.length }));
process.exitCode = receipt.passed ? 0 : 1;
