// SCRUM-748 adversarial review: capture the real queue's browser boundaries.
// HIGH FINDING: a refused bucket PUT loses the upload. Prescribed fix: use the
// authenticated multipart route, including pending targets, without confirming twice.
//
// SCRUM-850: the multipart route is an XMLHttpRequest too, so the bar moves on
// it as it does on the direct upload, and a refusal with no sentence of the
// app's own (a proxy's page, a server fault, a dropped connection) reads as one
// plain line, never a parse error. And the server's half, on the real storage
// module with a captured bucket client: a file is received to a temporary
// file and handed to the bucket as a stream, never as one buffer; each type
// stores no more than its limit; nothing is left behind.
//
// SCRUM-855: a width, height or length goes to the server only when the
// browser could measure it, as a whole number. A recording made in the page
// has no length and the browser says Infinity: nothing is sent for it.
//
// SCRUM-856: nothing of an upload is sent until the browser has measured its
// file, or a short limit has passed. Measuring used to race the upload, and
// where the bucket refuses the browser the form left first, without them.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setImmediate as tick, setTimeout as wait } from "node:timers/promises";
import { crc32 } from "node:zlib";
import express from "express";
import multer from "multer";
import {
  putTempUpload, removeStaleUploads, removeTempUpload, tempFileStorage, type TempUploadFile,
} from "../server/core/checklistMediaUpload";
import { UPLOAD_NOT_THROUGH, uploadQueue } from "../client/src/lib/uploadQueue";
import { wholeMeasure } from "../shared/mediaMeasure";

const originals = { fetch, XMLHttpRequest: globalThis.XMLHttpRequest, Image: globalThis.Image,
  document: globalThis.document, setTimeout, error: console.error, warn: console.warn };
let direct: "ok" | "network" | "refused" = "ok";
let refuse = "";
// What the app's multipart route answers when a check says so; null is the stored attachment.
let viaServer: { status: number; body: string } | "network" | null = null;
// What presign or confirm answers when a check says so.
let small: { boundary: string; status: number; body: string } | null = null;
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
// What the page's video element reports for the file; null is a file it cannot read.
let page: { duration: number; videoWidth: number; videoHeight: number } | null = null;
globalThis.document = { createElement: (tag: string) => tag === "canvas" ? { getContext: () => null } : ({
  ...(page ?? {}), onerror: () => {}, onloadeddata: () => {}, onseeked: () => {},
  set src(_value: string) { queueMicrotask(() => (page ? this.onloadeddata() : this.onerror())); },
  set currentTime(_value: number) { queueMicrotask(() => this.onseeked()); },
}) } as any;
// One XMLHttpRequest stands for both uploads: the PUT to the bucket and, since
// SCRUM-850, the POST to the app's own route. Each reports bytes as it sends.
globalThis.XMLHttpRequest = class {
  status = 200; responseText = ""; withCredentials = false; method = ""; url = "";
  headers: Record<string, string> | undefined;
  sent = new Map<string, (event: any) => void>(); listeners = new Map<string, () => void>();
  upload = { addEventListener: (name: string, fn: (event: any) => void) => { this.sent.set(name, fn); } };
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { (this.headers ??= {})[name] = value; }
  send(body: unknown) {
    const progress = () => { for (const loaded of [25, 50, 100]) this.sent.get("progress")?.({ lengthComputable: true, loaded, total: 100 }); };
    if (this.method === "PUT") {
      this.status = direct === "refused" ? 403 : 200;
      queueMicrotask(() => { if (direct === "ok") progress(); this.listeners.get(direct === "network" ? "error" : "load")!(); });
      return;
    }
    assert.equal(this.method, "POST"); assert.equal(this.withCredentials, true);
    calls.push({ path: this.url, init: { body: body as FormData, headers: this.headers } });
    queueMicrotask(() => {
      if (viaServer === "network") return this.listeners.get("error")!();
      progress(); this.sent.get("load")?.({});
      const refused = refuse === "upload";
      this.status = viaServer?.status ?? (refused ? 403 : 200);
      this.responseText = viaServer?.body ?? JSON.stringify(refused ? { error: "ZZ TEST refused" } : attachment);
      this.listeners.get("load")!();
    });
  }
} as any;
globalThis.fetch = (async (path: string, init: RequestInit) => {
  calls.push({ path, init });
  assert.equal(init.credentials, "include");
  assert.equal(path.endsWith("upload"), false, "the multipart route is sent with progress, not by fetch");
  if (small && path.endsWith(small.boundary)) return new Response(small.body, { status: small.status });
  const body = path.endsWith("presign") ? { uploadUrl: "https://bucket.invalid/zz", s3Key: "zz-direct-key" } : { attachment };
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
  catch (error) { failed++; originals.error(`FAIL ${title}`, error instanceof Error ? error.message : error); }
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
    const item = await run();
    assert.equal(item.status, "failed"); assert.equal(completed.length, 0);
    assert.equal(item.error, "ZZ TEST refused", "the app's own sentence is what the person reads");
    assert.equal(calls.some(c => c.path.endsWith("upload")), false);
  });
  refuse = "";

  // SCRUM-850. The bar: 10 at the start of an upload, 10 to 90 while bytes
  // leave, 95 while the server finishes, 100 when the attachment is back.
  const watch = async (action: () => Promise<{ status: string }>) => {
    const seen: { status: string; progress: number }[] = [];
    for (const item of uploadQueue.getItems()) uploadQueue.removeItem(item.id);
    const stop = uploadQueue.subscribe(items => { for (const item of items) seen.push({ status: item.status, progress: item.progress }); });
    try { return { item: await action(), seen }; } finally { stop(); }
  };
  await check("SCRUM-850: the bar moves while a file goes through the app's own route", async () => {
    for (const mode of ["network", "refused"] as const) {
      direct = mode;
      const { item, seen } = await watch(() => run());
      assert.equal(item.status, "completed");
      const bar = seen.map(step => step.progress);
      for (const step of [30, 50, 90, 95, 100]) assert.ok(bar.includes(step), `${mode}: the bar never showed ${step}: ${bar.join(",")}`);
      assert.ok(bar.indexOf(30) < bar.indexOf(50) && bar.indexOf(50) < bar.indexOf(90) && bar.indexOf(90) < bar.indexOf(95));
      // The screens draw a bar for "uploading" alone, and the server can be a while storing a video.
      assert.ok(seen.some(step => step.status === "uploading" && step.progress === 95), "bytes sent, the server still storing");
      assert.equal(seen.some(step => step.status === "confirming"), false, "the bar would vanish while the server stores the file");
    }
  });
  await check("SCRUM-850 PIN: the direct upload reports its bytes as before", async () => {
    direct = "ok";
    const { item, seen } = await watch(() => run());
    assert.equal(item.status, "completed");
    const bar = seen.map(step => step.progress);
    for (const step of [5, 10, 30, 50, 90, 95, 100]) assert.ok(bar.includes(step), `the bar never showed ${step}: ${bar.join(",")}`);
    assert.equal(calls.some(c => c.path.endsWith("upload")), false);
  });
  await check("SCRUM-850: a refusal that is not the app's own reads as one plain line", async () => {
    direct = "network";
    assert.equal(UPLOAD_NOT_THROUGH, "The upload did not go through. Try again, or use a smaller file.");
    const page = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>";
    const cases: (typeof viaServer)[] = [
      { status: 502, body: page }, { status: 413, body: "<html>Request Entity Too Large</html>" },
      { status: 504, body: "" }, { status: 200, body: page }, { status: 200, body: "null" }, { status: 200, body: "{}" },
      { status: 500, body: JSON.stringify({ error: "ZZ TEST AccessDenied: bucket zz-bucket, request 0123ABCD" }) },
      { status: 500, body: JSON.stringify({ message: "ZZ TEST ENOSPC: no space left on device, open '/tmp/zz'" }) },
      "network",
    ];
    for (const answer of cases) {
      viaServer = answer;
      const item = await run();
      assert.equal(item.status, "failed", JSON.stringify(answer)); assert.equal(completed.length, 0);
      assert.equal(item.error, UPLOAD_NOT_THROUGH, JSON.stringify(answer));
    }
    viaServer = null;
  });
  await check("SCRUM-850 PIN: the route's own refusals keep their sentences", async () => {
    direct = "refused";
    for (const [status, body, line] of [
      [400, { error: "Image too large. Maximum size is 10MB" }, "Image too large. Maximum size is 10MB"],
      [400, { error: "Video too large. Maximum size is 200MB" }, "Video too large. Maximum size is 200MB"],
      [404, { error: "Checklist item not found or access denied" }, "Checklist item not found or access denied"],
      [403, { message: "ZZ TEST manager access required" }, "ZZ TEST manager access required"],
      [401, { message: "ZZ TEST not signed in" }, "ZZ TEST not signed in"],
    ] as const) {
      viaServer = { status, body: JSON.stringify(body) };
      const item = await run();
      assert.equal(item.status, "failed"); assert.equal(item.error, line);
    }
    viaServer = null;
  });
  for (const boundary of ["presign", "confirm"]) await check(`SCRUM-850: a ${boundary} answer that is not JSON is the plain line, never a parse error`, async () => {
    direct = "ok";
    for (const answer of [{ status: 502, body: "<html>Bad Gateway</html>" }, { status: 200, body: "<html>Sign in</html>" },
      { status: 500, body: JSON.stringify({ error: "ZZ TEST AWS credentials not configured" }) }]) {
      small = { boundary, ...answer };
      const item = await run();
      assert.equal(item.status, "failed"); assert.equal(item.error, UPLOAD_NOT_THROUGH, JSON.stringify(answer));
      assert.equal(calls.some(c => c.path.endsWith("upload")), false, "a refused small request never reaches the multipart route");
    }
    small = null;
  });

  // SCRUM-855. Both ways a file is saved: the confirmation after a direct
  // upload (JSON) and the app's own multipart route (form fields).
  const measuresSent = async (measured: typeof page, mode: "ok" | "refused") => {
    page = measured; direct = mode;
    const item = await run({}, "item", "video/webm");
    page = null;
    assert.equal(item.status, "completed"); assert.equal(completed.length, 1);
    const keys = ["width", "height", "durationSeconds"] as const;
    if (mode === "ok") {
      const raw = calls.find(c => c.path.endsWith("confirm"))!.init.body as string;
      assert.equal(/null|Infinity|NaN/.test(raw), false, `the confirmation carries a measure that is not one: ${raw}`);
      const body = JSON.parse(raw);
      return keys.map(key => (key in body ? body[key] : undefined));
    }
    const form = calls.find(c => c.path.endsWith("upload"))!.init.body as FormData;
    return keys.map(key => (form.has(key) ? Number(form.get(key)) : undefined));
  };
  for (const mode of ["ok", "refused"] as const) {
    const way = mode === "ok" ? "the confirmation" : "the multipart route";
    await check(`SCRUM-855: a length the page cannot read is not sent on ${way}`, async () => {
      for (const duration of [Infinity, -Infinity, NaN, 0, 0.4, -3]) {
        assert.deepEqual(await measuresSent({ duration, videoWidth: 1280, videoHeight: 720 }, mode), [1280, 720, undefined], `a length of ${duration}`);
      }
    });
    await check(`SCRUM-855: a length the page can read is sent whole on ${way}`, async () => {
      for (const [duration, sent] of [[6.4, 6], [6.5, 7], [12, 12], [0.5, 1]]) {
        assert.deepEqual(await measuresSent({ duration, videoWidth: 1280, videoHeight: 720 }, mode), [1280, 720, sent], `a length of ${duration}`);
      }
      assert.deepEqual(await measuresSent({ duration: 6, videoWidth: 0, videoHeight: NaN }, mode), [undefined, undefined, 6], "no picture size, a length");
      assert.deepEqual(await measuresSent(null, mode), [undefined, undefined, undefined], "a file the page cannot read at all");
    });
  }
  await check("SCRUM-855: a measure is a whole number above nothing, or not known", () => {
    for (const [value, measure] of [
      [6, 6], [6.4, 6], [6.5, 7], ["6", 6], [" 12 ", 12], ["6.4", 6], ["1280", 1280], [2147483647, 2147483647], ["2147483647", 2147483647],
      [Infinity, null], [-Infinity, null], [NaN, null], [0, null], [0.4, null], [-3, null], [2147483648, null], [1e12, null],
      ["Infinity", null], ["NaN", null], ["abc", null], ["", null], ["  ", null], ["-5", null], ["1e3", null], ["0x10", null], ["6px", null],
      ["99999999999", null], ["0", null], ["0.2", null], [null, null], [undefined, null], [true, null], [[6], null], [{}, null],
    ] as const) assert.equal(wholeMeasure(value), measure, `wholeMeasure(${JSON.stringify(value) ?? String(value)})`);
  });

  // SCRUM-856. The measuring itself is held here: each file's is a promise
  // the check settles when it chooses, in the place the queue's own is made.
  type Measure = { width: number; height: number; duration?: number };
  const queue = uploadQueue as any;
  const real = { video: queue.getVideoMetadataWithTimeout, image: queue.getImageDimensionsWithTimeout, limits: uploadQueue.measureLimitMs };
  const held = new Map<string, { resolve: (measure: Measure) => void; reject: (error: Error) => void }>();
  const hold = (file: File) => new Promise<Measure>((resolve, reject) => { held.set(file.name, { resolve, reject }); });
  const NEVER = 3_600_000;
  const add = (name: string, mime = "video/mp4") => uploadQueue.addUpload(new File(["ZZ TEST"], name, { type: mime }), "item",
    { checklistTemplateItemId: "zz-item", onComplete: value => completed.push(value) });
  const fresh = (mode: typeof direct, limits = { image: NEVER, video: NEVER }) => {
    for (const item of uploadQueue.getItems()) uploadQueue.removeItem(item.id);
    calls.length = 0; completed.length = 0; held.clear(); direct = mode; uploadQueue.measureLimitMs = limits;
  };
  const settled = async (ids: string[], withinMs = 2000) => {
    for (const until = Date.now() + withinMs; Date.now() < until;) {
      const items = ids.map(id => uploadQueue.getItems().find(item => item.id === id)!);
      if (items.every(item => ["completed", "failed"].includes(item.status))) return items;
      await wait(2);
    }
    throw Error("queue did not settle");
  };
  const quiet = async (what: string) => {
    for (let i = 0; i < 25; i++) await tick();
    await wait(15);
    assert.deepEqual(calls.map(c => c.path.split("/").pop()), [], `${what}: something was sent before the file was measured`);
  };
  /** The measures each save carried, in the order sent: [file name, width, height, length]. */
  const sent = (mode: typeof direct) => calls.filter(c => c.path.endsWith(mode === "ok" ? "confirm" : "upload")).map(c => {
    const keys = ["width", "height", "durationSeconds"] as const;
    if (mode === "ok") { const body = JSON.parse(c.init.body as string); return [body.originalFilename, ...keys.map(key => body[key])]; }
    const form = c.init.body as FormData;
    return [(form.get("file") as File).name, ...keys.map(key => (form.has(key) ? Number(form.get(key)) : undefined))];
  });
  queue.getVideoMetadataWithTimeout = hold; queue.getImageDimensionsWithTimeout = hold;
  try {
    await check("SCRUM-856 PIN: a photo waits up to a second and a half, a video up to three", () => {
      assert.deepEqual(real.limits, { image: 1500, video: 3000 });
    });
    for (const mode of ["ok", "refused"] as const) {
      const way = mode === "ok" ? "the confirmation" : "the multipart route";
      await check(`SCRUM-856: nothing is sent until the video is measured, then its measures go on ${way}`, async () => {
        fresh(mode);
        const id = await add("ZZ TEST clip.mp4");
        await quiet("an unmeasured video");
        const waiting = uploadQueue.getItems().find(item => item.id === id)!;
        assert.deepEqual([waiting.status, waiting.progress], ["uploading", 5], "the bar is where an upload starts");
        held.get("ZZ TEST clip.mp4")!.resolve({ width: 1280, height: 720, duration: 6 });
        const [item] = await settled([id]);
        assert.equal(item.status, "completed"); assert.equal(completed.length, 1);
        assert.deepEqual(sent(mode), [["ZZ TEST clip.mp4", 1280, 720, 6]]);
        assert.deepEqual(calls.map(c => c.path.split("/").pop()), mode === "ok" ? ["presign", "confirm"] : ["presign", "upload"]);
      });
      await check(`SCRUM-856: a photo waits for its size the same way on ${way}`, async () => {
        fresh(mode);
        const id = await add("ZZ TEST photo.jpg", "image/jpeg");
        await quiet("an unmeasured photo");
        held.get("ZZ TEST photo.jpg")!.resolve({ width: 4032, height: 3024 });
        assert.equal((await settled([id]))[0].status, "completed");
        assert.deepEqual(sent(mode), [["ZZ TEST photo.jpg", 4032, 3024, undefined]]);
      });
    }
    await check("SCRUM-856: a file the browser never measures goes at the limit, without measures", async () => {
      // A photo's limit and a video's are their own: each goes at its own, never at the other's.
      for (const [name, mime, limits] of [
        ["ZZ TEST clip.mp4", "video/mp4", { image: NEVER, video: 250 }], ["ZZ TEST photo.jpg", "image/jpeg", { image: 250, video: NEVER }],
      ] as const) {
        fresh("refused", { ...limits });
        const started = Date.now();
        const id = await add(name, mime);
        await quiet(`${name} inside its limit`);
        const [item] = await settled([id]);
        assert.equal(item.status, "completed", "a file that cannot be measured must still go");
        assert.ok(Date.now() - started >= 240, `${name} went before its limit`);
        assert.deepEqual(sent("refused"), [[name, undefined, undefined, undefined]]);
      }
    });
    await check("SCRUM-856: a measuring that fails lets the upload go at once", async () => {
      for (const mode of ["ok", "refused"] as const) {
        fresh(mode);
        const id = await add("ZZ TEST clip.mp4");
        await quiet("an unmeasured video");
        held.get("ZZ TEST clip.mp4")!.reject(new Error("ZZ TEST the browser cannot read this file"));
        const [item] = await settled([id], 500);
        assert.equal(item.status, "completed");
        assert.deepEqual(sent(mode), [["ZZ TEST clip.mp4", undefined, undefined, undefined]]);
      }
    });
    await check("SCRUM-856: two files added together each wait for their own measuring, in the order added", async () => {
      for (const mode of ["ok", "refused"] as const) {
        fresh(mode);
        const first = await add("ZZ TEST first.mp4"), second = await add("ZZ TEST second.mp4");
        // The second is measured first: it still waits its turn, and the first still waits for its own.
        held.get("ZZ TEST second.mp4")!.resolve({ width: 640, height: 360, duration: 12 });
        await quiet("the first of two, unmeasured");
        assert.equal(uploadQueue.getItems().find(item => item.id === second)!.status, "pending");
        held.get("ZZ TEST first.mp4")!.resolve({ width: 1280, height: 720, duration: 6 });
        const items = await settled([first, second]);
        assert.deepEqual(items.map(item => item.status), ["completed", "completed"]);
        assert.deepEqual(sent(mode), [["ZZ TEST first.mp4", 1280, 720, 6], ["ZZ TEST second.mp4", 640, 360, 12]]);
      }
    });
    await check("SCRUM-856 PIN: a retry does not wait again, and sends what was measured", async () => {
      fresh("refused"); refuse = "upload";
      const id = await add("ZZ TEST clip.mp4");
      held.get("ZZ TEST clip.mp4")!.resolve({ width: 1280, height: 720, duration: 6 });
      assert.equal((await settled([id]))[0].status, "failed");
      refuse = ""; calls.length = 0;
      uploadQueue.retryItem(id);
      assert.equal((await settled([id], 500))[0].status, "completed");
      assert.deepEqual(sent("refused"), [["ZZ TEST clip.mp4", 1280, 720, 6]]);
    });
  } finally {
    queue.getVideoMetadataWithTimeout = real.video; queue.getImageDimensionsWithTimeout = real.image;
    uploadQueue.measureLimitMs = real.limits; refuse = "";
    for (const item of uploadQueue.getItems()) uploadQueue.removeItem(item.id);
  }
} finally {
  Object.assign(globalThis, { fetch: originals.fetch, XMLHttpRequest: originals.XMLHttpRequest, Image: originals.Image, document: originals.document, setTimeout: originals.setTimeout });
  console.error = originals.error; console.warn = originals.warn;
}

// ─── SCRUM-850, the server's half ─────────────────────────────────────────────
// The storage the route uses, behind a small app of its own: the route's
// guards and its bucket are proved on the real route in checklist-copies.check.
const MB = 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), "zz-s850-"));
const LIMITS: Record<string, number> = { "image/jpeg": 64 * 1024, "video/mp4": 64 * MB };
const receiver = multer({ storage: tempFileStorage(mime => LIMITS[mime] ?? 0, () => dir), limits: { fileSize: 64 * MB + 1 } });
let received: TempUploadFile | undefined;
const app = express();
app.post("/upload", (req, res) => receiver.single("file")(req, res, (error: any) => {
  received = req.file;
  if (error) return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 500).json({ code: error.code ?? String(error.message) });
  res.json({ size: req.file?.size ?? null, stored: Boolean(req.file?.path), buffered: req.file?.buffer !== undefined });
}));
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const port = (server.address() as AddressInfo).port;
const stored = () => readdirSync(dir);
const crcOf = (parts: Buffer[]) => { const b = Buffer.alloc(4); b.writeUInt32BE(parts.reduce((sum, part) => crc32(part, sum), 0)); return b.toString("base64"); };
/** One multipart upload, its file written piece by piece and never held whole. */
function send(mime: string, pieces: Buffer[], options: { stopAfter?: number; hold?: boolean } = {}) {
  return new Promise<{ status: number; body: any; peak: number }>((resolve, reject) => {
    const boundary = "zz-s850-boundary";
    let peak = 0;
    const req = request({ host: "127.0.0.1", port, path: "/upload", method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "transfer-encoding": "chunked" } }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => { req.destroy(); resolve({ status: res.statusCode!, body: JSON.parse(text), peak }); });
    });
    req.on("error", error => (options.stopAfter === undefined ? reject(error) : resolve({ status: 0, body: null, peak })));
    req.on("close", () => resolve({ status: 0, body: null, peak }));
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error("the upload was not answered")); });
    (async () => {
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ZZ TEST clip"\r\nContent-Type: ${mime}\r\n\r\n`);
      for (const [index, piece] of pieces.entries()) {
        if (index === options.stopAfter) return req.destroy();
        if (req.destroyed) return;
        if (!req.write(piece)) await new Promise(resolve => req.once("drain", resolve));
        for (const name of stored()) peak = Math.max(peak, statSync(join(dir, name), { throwIfNoEntry: false })?.size ?? 0);
      }
      if (!options.hold) req.end(`\r\n--${boundary}--\r\n`);
    })().catch(reject);
  });
}
const piece = (fill: number, size = MB) => Buffer.alloc(size, fill);
try {
  await check("SCRUM-850: a large video is received to a temporary file, never into a buffer", async () => {
    const pieces = Array.from({ length: 48 }, (_, index) => piece(index + 1));
    const result = await send("video/mp4", pieces);
    assert.deepEqual({ status: result.status, ...result.body }, { status: 200, size: 48 * MB, stored: true, buffered: false });
    assert.equal(received!.buffer, undefined); assert.equal(received!.size, 48 * MB);
    assert.equal(received!.checksumCrc32, crcOf(pieces), "the checksum is of the bytes that arrived");
    assert.deepEqual(stored(), [received!.filename]); assert.equal(statSync(received!.path).size, 48 * MB);
  });
  await check("SCRUM-850: the bucket client is handed a stream with its length and checksum, and the file goes after", async () => {
    const file = received!;
    const sent: any[] = []; const sizes: number[] = [];
    await putTempUpload({ send: async (command: any) => {
      sent.push(command.input);
      for await (const chunk of command.input.Body) sizes.push(chunk.length);
      return {};
    } } as any, { bucket: "zz-bucket", key: "checklists/zz/header/zz.mp4", contentType: "video/mp4" }, file);
    assert.equal(sent.length, 1);
    const input = sent[0];
    assert.ok(input.Body instanceof Readable, "the body is a stream");
    assert.equal(Buffer.isBuffer(input.Body) || ArrayBuffer.isView(input.Body) || typeof input.Body === "string", false);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), 48 * MB); assert.ok(Math.max(...sizes) <= MB, "read in pieces, never whole");
    assert.deepEqual({ ...input, Body: null }, { Bucket: "zz-bucket", Key: "checklists/zz/header/zz.mp4", ContentType: "video/mp4",
      Body: null, ContentLength: 48 * MB, ChecksumAlgorithm: "CRC32", ChecksumCRC32: file.checksumCrc32 });
    await removeTempUpload(file);
    assert.deepEqual(stored(), []);
    await removeTempUpload(file); await removeTempUpload(undefined);
  });
  await check("SCRUM-850: a refused bucket write is tried again from the first byte, and only when it may pass", async () => {
    const pieces = [piece(7), piece(8), piece(9)];
    assert.equal((await send("video/mp4", pieces)).status, 200);
    const file = received!;
    const reads: number[] = [];
    const failing = (failure: unknown, times: number) => ({ send: async (command: any) => {
      let bytes = 0; let sum = 0;
      for await (const chunk of command.input.Body) { bytes += chunk.length; sum = crc32(chunk, sum); if (reads.length < times && bytes >= MB) break; }
      reads.push(bytes);
      if (reads.length <= times) throw failure;
      assert.equal(crcOf(pieces), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(sum); return b.toString("base64"); })());
      return {};
    } }) as any;
    const target = { bucket: "zz-bucket", key: "zz-key", contentType: "video/mp4" };
    await putTempUpload(failing(Object.assign(new Error("ZZ TEST slow down"), { $metadata: { httpStatusCode: 503 } }), 2), target, file);
    assert.equal(reads.length, 3); assert.equal(reads[2], 3 * MB, "the last try read the whole file");
    reads.length = 0;
    const denied = Object.assign(new Error("ZZ TEST denied"), { $metadata: { httpStatusCode: 403 } });
    await assert.rejects(putTempUpload(failing(denied, 9), target, file), /ZZ TEST denied/);
    assert.equal(reads.length, 1, "a refusal that will not change is not asked twice");
    reads.length = 0;
    await assert.rejects(putTempUpload(failing(Object.assign(new Error("ZZ TEST reset"), { code: "ECONNRESET" }), 9), target, file), /ZZ TEST reset/);
    assert.equal(reads.length, 3, "three tries, then the failure is the route's to answer");
    await removeTempUpload(file);
    await assert.rejects(putTempUpload(failing(denied, 0), target, { ...file, path: undefined as any }), /not received/);
    assert.deepEqual(stored(), []);
  });
  await check("SCRUM-850: each type stores no more than its limit, and a refused type stores nothing", async () => {
    const photo = await send("image/jpeg", [piece(1, 64 * 1024)]);
    assert.deepEqual({ ...photo.body }, { size: 64 * 1024, stored: true, buffered: false }, "a photo at its limit is kept");
    await removeTempUpload(received);
    const bigPhoto = await send("image/jpeg", Array.from({ length: 8 }, () => piece(2)));
    assert.deepEqual({ status: bigPhoto.status, ...bigPhoto.body }, { status: 200, size: 8 * MB, stored: false, buffered: false });
    assert.ok(bigPhoto.peak <= 64 * 1024, `a photo past its limit wrote ${bigPhoto.peak} bytes`);
    assert.equal(received!.path, undefined); assert.equal(received!.size, 8 * MB, "still counted to the end, so the route can say why");
    const other = await send("text/plain", Array.from({ length: 4 }, () => piece(3)));
    assert.deepEqual({ status: other.status, ...other.body, peak: other.peak }, { status: 200, size: 4 * MB, stored: false, buffered: false, peak: 0 });
    assert.deepEqual(stored(), []);
  });
  await check("SCRUM-850: one byte past the largest allowance is refused while it arrives, with nothing left", async () => {
    const atLimit = await send("video/mp4", Array.from({ length: 64 }, () => piece(4)));
    assert.deepEqual({ status: atLimit.status, ...atLimit.body }, { status: 200, size: 64 * MB, stored: true, buffered: false }, "exactly the limit is taken");
    await removeTempUpload(received);
    // The file never ends: the refusal cannot be waiting for the end of it.
    const over = await send("video/mp4", [...Array.from({ length: 64 }, () => piece(5)), piece(6, 1), ...Array.from({ length: 4 }, () => piece(6))], { hold: true });
    assert.deepEqual({ status: over.status, ...over.body }, { status: 413, code: "LIMIT_FILE_SIZE" });
    assert.ok(over.peak <= 64 * MB, `wrote ${over.peak} bytes of a file past the limit`);
    for (let i = 0; i < 50 && stored().length; i++) await wait(20);
    assert.deepEqual(stored(), []);
  });
  await check("SCRUM-850: an upload that stops halfway leaves no temporary file", async () => {
    await send("video/mp4", Array.from({ length: 12 }, () => piece(7)), { stopAfter: 6 });
    for (let i = 0; i < 100 && stored().length; i++) await wait(20);
    assert.deepEqual(stored(), []);
  });
  await check("SCRUM-850: two uploads at once keep their own bytes", async () => {
    const one = Array.from({ length: 6 }, () => piece(11)), two = Array.from({ length: 9 }, () => piece(12));
    const both = await Promise.all([send("video/mp4", one), send("video/mp4", two)]);
    assert.deepEqual(both.map(r => r.body.size), [6 * MB, 9 * MB]);
    const names = stored(); assert.equal(names.length, 2);
    const sums = names.map(name => crcOf([readFileSync(join(dir, name))])).sort();
    assert.deepEqual(sums, [crcOf(one), crcOf(two)].sort());
    for (const name of names) rmSync(join(dir, name));
  });
  await check("SCRUM-850: what a stopped process left behind is removed, and nothing else", async () => {
    const old = join(dir, "zz-old.upload"), fresh = join(dir, "zz-fresh.upload"), other = join(dir, "zz-old.txt");
    for (const file of [old, fresh, other]) writeFileSync(file, "ZZ TEST");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, twoHoursAgo, twoHoursAgo); utimesSync(other, twoHoursAgo, twoHoursAgo);
    assert.equal(await removeStaleUploads(dir), 1);
    assert.deepEqual([old, fresh, other].map(file => existsSync(file)), [false, true, true]);
    assert.equal(await removeStaleUploads(join(dir, "zz-missing")), 0);
  });
  await check("SCRUM-850 PIN: the route keeps no file in memory and streams from the temporary file", () => {
    const route = readFileSync(new URL("../server/core/checklistMediaRoutes.ts", import.meta.url), "utf8");
    assert.equal(/memoryStorage|\.buffer\b/.test(route), false, "the route reaches for a buffer");
    assert.ok(route.includes("storage: tempFileStorage("));
    assert.ok(route.includes("limits: { fileSize: MAX_VIDEO_SIZE + 1 }"));
    assert.ok(route.includes('router.post("/upload", requireAuth, requireManager, receiveUpload, fixMulterFilenames,'));
    const handler = route.slice(route.indexOf('router.post("/upload"'));
    assert.ok(handler.includes("await putTempUpload(s3Client, { bucket, key: s3Key, contentType: mimeType }, file);"));
    assert.ok(/finally \{[^}]*await removeTempUpload\(req\.file\);/.test(handler), "the temporary file goes with every answer");
  });
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
console.log(`s748-upload-queue.check: ${checks - failed}/${checks} checks passed`);
if (failed) process.exitCode = 1;
