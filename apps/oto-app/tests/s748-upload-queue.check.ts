// SCRUM-748 adversarial review: capture the real queue's browser boundaries.
// HIGH FINDING: a refused bucket PUT loses the upload. Prescribed fix: use the
// authenticated multipart route, including pending targets, without confirming twice.
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { uploadQueue } from "../client/src/lib/uploadQueue";

const originals = { fetch, XMLHttpRequest: globalThis.XMLHttpRequest, Image: globalThis.Image,
  document: globalThis.document, setTimeout, error: console.error, warn: console.warn };
let direct: "ok" | "network" | "refused" = "ok";
let refuse = "";
const calls: { path: string; init: RequestInit }[] = [];
const completed: any[] = [];
const attachment = { id: "zz-attachment", s3Key: "zz-server-key" };
let checks = 0, failed = 0;
globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) => {
  const timer = originals.setTimeout(fn, ms, ...args); timer.unref(); return timer;
}) as typeof setTimeout;
globalThis.Image = class {
  naturalWidth = 4; naturalHeight = 3; onload = () => {}; onerror = () => {};
  set src(_value: string) { queueMicrotask(() => this.onload()); }
} as any;
globalThis.document = { createElement: () => ({ set src(_value: string) { queueMicrotask(() => this.onerror()); }, onerror: () => {} }) } as any;
globalThis.XMLHttpRequest = class {
  status = 200; upload = { addEventListener() {} }; listeners = new Map<string, () => void>();
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn); }
  open(method: string) { assert.equal(method, "PUT"); }
  setRequestHeader() {}
  send() { this.status = direct === "refused" ? 403 : 200; queueMicrotask(() => this.listeners.get(direct === "network" ? "error" : "load")!()); }
} as any;
globalThis.fetch = (async (path: string, init: RequestInit) => {
  calls.push({ path, init });
  assert.equal(init.credentials, "include");
  const body = path.endsWith("presign") ? { uploadUrl: "https://bucket.invalid/zz", s3Key: "zz-direct-key" }
    : path.endsWith("confirm") ? { attachment } : attachment;
  return new Response(JSON.stringify(path.endsWith(refuse) && refuse ? { error: "ZZ TEST refused" } : body),
    { status: path.endsWith(refuse) && refuse ? 403 : 200 });
}) as typeof fetch;
console.error = () => {}; console.warn = () => {};
async function run(options: Parameters<typeof uploadQueue.addUpload>[2] = {}, target: "item" | "checklist" = "item", mime = "image/jpeg") {
  calls.length = 0; completed.length = 0;
  for (const item of uploadQueue.getItems()) uploadQueue.removeItem(item.id);
  const id = await uploadQueue.addUpload(new File(["ZZ TEST"], "ZZ TEST photo.jpg", { type: mime }), target,
    { checklistTemplateItemId: "zz-item", ...options, onComplete: value => completed.push(value) });
  for (let i = 0; i < 100; i++) {
    await tick();
    const item = uploadQueue.getItems().find(item => item.id === id)!;
    if (["completed", "failed"].includes(item.status)) return item;
  }
  throw Error("queue did not settle");
}
async function check(title: string, action: () => Promise<void>) {
  checks++;
  try { await action(); console.log(`PASS ${title}`); }
  catch { failed++; originals.error(`FAIL ${title}`); }
}
try {
  await check("PIN: successful direct PUT confirms once without fallback", async () => {
    assert.equal((await run()).status, "completed");
    assert.deepEqual(calls.map(c => c.path.split("/").pop()), ["presign", "confirm"]);
    assert.equal(completed.length, 1);
  });
  for (const mode of ["network", "refused"] as const) await check(`HIGH: ${mode} PUT uses multipart once and never confirms again`, async () => {
    direct = mode;
    assert.equal((await run()).status, "completed");
    assert.deepEqual(calls.map(c => c.path.split("/").pop()), ["presign", "upload"]);
    const init = calls[1].init, body = init.body as FormData;
    assert.equal(init.headers, undefined); assert.equal(body.get("target"), "item");
    assert.equal(body.get("checklistTemplateItemId"), "zz-item");
    assert.ok(body.get("file") instanceof File); assert.equal(completed.length, 1);
    assert.equal(completed[0].id, attachment.id); assert.ok(completed[0].localPreviewUrl);
  });
  await check("HIGH: unsaved first item retains index zero and no saved target", async () => {
    assert.equal((await run({ isPending: true, pendingChecklistId: "zz-pending", pendingItemIndex: 0 })).status, "completed");
    const body = calls[1].init.body as FormData;
    assert.equal(body.get("pendingItemIndex"), "0"); assert.equal(body.get("pendingChecklistId"), "zz-pending");
    assert.equal(body.has("checklistTemplateItemId"), false);
  });
  await check("PIN: saved header and video retain their multipart target and file", async () => {
    assert.equal((await run({ checklistTemplateId: "zz-template", checklistTemplateItemId: undefined }, "checklist", "video/mp4")).status, "completed");
    const body = calls[1].init.body as FormData;
    assert.equal(body.get("target"), "checklist"); assert.equal(body.get("checklistTemplateId"), "zz-template");
    assert.equal((body.get("file") as File).type, "video/mp4");
  });
  await check("PIN: fallback refusal stays failed and a retry can complete", async () => {
    refuse = "upload"; const item = await run(); assert.equal(item.status, "failed"); assert.equal(completed.length, 0);
    refuse = ""; uploadQueue.retryItem(item.id);
    for (let i = 0; i < 100 && item.status !== "completed"; i++) await tick();
    assert.equal(item.status, "completed"); assert.equal(completed.length, 1);
  });
  for (const boundary of ["presign", "confirm"]) await check(`PIN: ${boundary} refusal cannot bypass its guard via fallback`, async () => {
    direct = "ok"; refuse = boundary;
    assert.equal((await run()).status, "failed"); assert.equal(completed.length, 0);
    assert.equal(calls.some(c => c.path.endsWith("upload")), false);
  });
} finally {
  Object.assign(globalThis, { fetch: originals.fetch, XMLHttpRequest: originals.XMLHttpRequest, Image: originals.Image, document: originals.document, setTimeout: originals.setTimeout });
  console.error = originals.error; console.warn = originals.warn;
}
console.log(`s748-upload-queue.check: ${checks - failed}/${checks} checks passed`);
if (failed) process.exitCode = 1;
