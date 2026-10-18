// Run only against a migrated disposable database; --media-only needs no database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { qaStorage, QA_MAX_ATTACHMENT_BYTES, readBoundedQaBody, validateQaAttachment } from "../server/qa/media";

const results: Record<string, boolean> = {};
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); results[name] = true; } catch { results[name] = false; }
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
await check("mediaTypes", () => {
  for (const [type, bytes] of [
    ["image/png", png], ["image/jpeg", Buffer.from([255, 216, 255])],
    ["image/webp", Buffer.from("RIFF1234WEBP")], ["video/mp4", Buffer.from("1234ftyp1234")],
    ["video/webm", Buffer.from([26, 69, 223, 163])],
  ] as const) validateQaAttachment(bytes, type);
});
await check("mediaMismatchAndLimit", async () => {
  assert.throws(() => validateQaAttachment(png, "image/jpeg"));
  assert.throws(() => validateQaAttachment(Buffer.from("<html>"), "image/png"));
  assert.throws(() => validateQaAttachment(Buffer.alloc(QA_MAX_ATTACHMENT_BYTES + 1), "image/png"));
  assert.throws(() => validateQaAttachment(Buffer.alloc(0), "image/png"));
  assert.throws(() => validateQaAttachment(png, "image/svg+xml"));
  const stalled = new Readable({ read() {} });
  await assert.rejects(readBoundedQaBody(stalled, undefined, 10));
  assert.equal(stalled.destroyed, true);
  await assert.rejects(readBoundedQaBody(Readable.from([Buffer.alloc(QA_MAX_ATTACHMENT_BYTES + 1)]), 1));
});
await check("multipartSingleFile", async () => {
  const { qaEvidenceUpload } = await import("../server/qa/routes");
  const app = express();
  app.post("/evidence", (req, res) => qaEvidenceUpload(req, res, error => {
    res.json({ accepted: !error && !!req.file, refused: !!error });
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  try {
    for (const variant of ["single", "second-file", "text-field"]) {
      const body = new FormData();
      body.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "ZZ TEST screenshot.png");
      if (variant === "second-file") body.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "ZZ TEST second.png");
      if (variant === "text-field") body.append("description", "ZZ TEST excluded form field");
      const response = await fetch(`http://127.0.0.1:${address.port}/evidence`, { method: "POST", body, signal: AbortSignal.timeout(15000) });
      const proof = await response.json();
      assert.equal(proof.accepted, variant === "single"); assert.equal(proof.refused, variant !== "single");
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

if (!process.argv.includes("--media-only")) {
  if (!process.env.DATABASE_URL) throw new Error("A migrated scratch database is required");
  process.env.QA_REPORTS_ENABLED = "false";
  process.env.STORAGE_ENV_PREFIX = "zz-qa-check";
  process.env.S3_ENDPOINT ||= "localhost";
  process.env.S3_BUCKET ||= "zz-qa-check";
  process.env.AWS_ACCESS_KEY_ID ||= randomUUID();
  process.env.AWS_SECRET_ACCESS_KEY ||= randomUUID();
  const store = await import("../server/qa/store");
  const { registerQaRoutes } = await import("../server/qa/routes");
  const { qaPool } = store;
  const tenantA = randomUUID(); const tenantB = randomUUID();
  const userA = randomUUID(); const userB = randomUUID(); const userC = randomUUID();
  const owners = { a: { tenantId: tenantA, userId: userA }, b: { tenantId: tenantB, userId: userB }, c: { tenantId: tenantA, userId: userC } };
  const objects = new Map<string, Buffer>();
  let writes = 0; let reads = 0;
  const storage = qaStorage();
  const originalSend = storage.client.send;
  storage.client.send = (async (command: { input: { Key?: string; Body?: unknown } }) => {
    const key = command.input.Key!;
    if (command instanceof PutObjectCommand) { writes++; objects.set(key, Buffer.from(command.input.Body as Uint8Array)); return {}; }
    if (command instanceof GetObjectCommand) { reads++; const bytes = objects.get(key); if (!bytes) throw new Error("Missing test evidence"); return { Body: Readable.from([bytes]), ContentLength: bytes.length }; }
    throw new Error("Unexpected object operation");
  }) as typeof storage.client.send;
  const app = express();
  app.use(express.json());
  // A small authenticated fixture boundary exercises the actual route handlers.
  // Full Passport sign-in remains a separate release/staging check.
  app.use((req, _res, next) => {
    const key = req.get("x-qa-test-user") as keyof typeof owners | undefined;
    const fixture = key ? owners[key] : undefined;
    if (fixture) Object.assign(req, {
      user: { id: fixture.userId, tenantId: tenantB, role: "admin" },
      userWithAccess: req.get("x-qa-test-missing-access") ? undefined : { id: fixture.userId, tenantId: fixture.tenantId, isActive: !req.get("x-qa-test-inactive"), role: "staff" },
      isAuthenticated: () => true,
    });
    else Object.assign(req, { isAuthenticated: () => false });
    next();
  });
  registerQaRoutes(app, (req, res, next) => { if (!req.isAuthenticated()) res.status(401).json({ message: "Authentication required" }); else next(); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  async function call(method: string, path: string, who = "a", body?: unknown, extra?: Record<string, string>) {
    return fetch(origin + path, { method, headers: { "x-qa-test-user": who, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  }
  async function upload(id: string, attachmentId: string, who = "a", bytes = png) {
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "ZZ TEST screenshot.png");
    return fetch(`${origin}/api/qa-reports/${id}/attachments`, { method: "POST", headers: { "x-qa-test-user": who, "X-QA-Attachment-Id": attachmentId }, body: form, signal: AbortSignal.timeout(15000) });
  }
  let id = ""; let attachmentId = "";
  const nonce = randomUUID();
  const context = { path: "/core/tasks?private=omitted#fragment", browser: "ZZ TEST browser", appVersion: "untrusted", role: "admin" };
  let setupStage = "fixtures";
  try {
    await qaPool.query("INSERT INTO tenants(id,name,slug) VALUES($1,'ZZ TEST QA A',$3),($2,'ZZ TEST QA B',$4)", [tenantA, tenantB, `zz-qa-${tenantA}`, `zz-qa-${tenantB}`]);
    for (const [key, fixture] of Object.entries(owners)) await qaPool.query(
      "INSERT INTO users(id,email,password,full_name,role) VALUES($1,$2,$3,$4,'staff')",
      [fixture.userId, `zz-qa-${key}-${fixture.userId}@example.invalid`, randomUUID(), `ZZ TEST QA ${key}`],
    );
    setupStage = "requests";
    await check("ownedDraftAndContext", async () => {
      const config = await (await call("GET", "/api/qa-reports/config")).json();
      assert.equal(config.enabled, false); assert.equal(config.acceptsVideo, true); assert.equal(config.audioTranscription, false);
      const response = await call("POST", "/api/qa-reports", "a", { message: "ZZ TEST task report", clientRequestId: nonce, context });
      assert.equal(response.status, 201);
      const data = await response.json(); id = data.report.id;
      assert.equal(data.report.status, "draft"); assert.equal(data.messages.length, 1);
      assert.equal(data.report.context.path, "/core/tasks"); assert.equal(data.report.context.role, "staff");
      assert.notEqual(data.report.context.appVersion, "untrusted");
      const raw = await store.getReportDetailForWorker(id);
      assert.equal(raw?.tenantId, tenantA); assert.equal(raw?.userId, userA);
      assert.equal(JSON.stringify(data).includes("objectKey"), false);
    });
    assert(id, "Owned draft is available");
    await check("foreignReporterAndPark", async () => {
      for (const who of ["b", "c"]) {
        assert.equal((await call("GET", `/api/qa-reports/${id}`, who)).status, 404);
        assert.equal((await call("POST", `/api/qa-reports/${id}/messages`, who, { message: "ZZ TEST foreign", clientRequestId: randomUUID() })).status, 404);
        assert.equal((await call("POST", `/api/qa-reports/${id}/analyze`, who, {})).status, 404);
        assert.equal((await upload(id, randomUUID(), who)).status, 404);
        const list = await (await call("GET", "/api/qa-reports", who)).json(); assert.equal(list.reports.length, 0);
      }
    });
    await check("createReplayAndConflict", async () => {
      const firstSha = process.env.RENDER_GIT_COMMIT;
      const savedVersion = (await store.getReportDetail(owners.a, id)).report.context.appVersion;
      process.env.RENDER_GIT_COMMIT = "a".repeat(40);
      const replay = await call("POST", "/api/qa-reports", "a", { message: "ZZ TEST task report", clientRequestId: nonce, context });
      if (firstSha === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = firstSha;
      const replayed = await replay.json();
      assert.equal(replay.status, 201); assert.equal(replayed.report.id, id); assert.equal(replayed.report.context.appVersion, savedVersion);
      assert.equal((await call("POST", "/api/qa-reports", "a", { message: "ZZ TEST changed", clientRequestId: nonce, context })).status, 409);
      assert.equal((await store.getReportDetail(owners.a, id)).messages.length, 1);
    });
    await check("messageReplayAndConflict", async () => {
      const clientRequestId = randomUUID();
      const body = { message: "ZZ TEST follow-up", clientRequestId };
      const replies = await Promise.all([call("POST", `/api/qa-reports/${id}/messages`, "a", body), call("POST", `/api/qa-reports/${id}/messages`, "a", body)]);
      assert(replies.every(reply => reply.status === 200));
      assert.equal((await store.getReportDetail(owners.a, id)).messages.length, 2);
      assert.equal((await call("POST", `/api/qa-reports/${id}/messages`, "a", { message: "ZZ TEST changed", clientRequestId })).status, 409);
    });
    await check("privateAttachmentReplay", async () => {
      attachmentId = randomUUID(); const before = writes;
      const replies = await Promise.all([upload(id, attachmentId), upload(id, attachmentId)]);
      assert(replies.every(reply => reply.status === 201));
      assert.equal(writes - before, 1);
      const data = await store.getReportDetail(owners.a, id); assert.equal(data.attachments.length, 1);
      assert.equal(data.attachments[0].id, attachmentId); assert.equal(JSON.stringify(data).includes("objectKey"), false);
      const own = await call("GET", `/api/qa-reports/${id}/attachments/${attachmentId}`);
      assert.equal(own.status, 200); assert(Buffer.from(await own.arrayBuffer()).equals(png));
      assert.equal(own.headers.get("cache-control"), "private, no-store");
    });
    await check("privateAttachmentConflictAndForeign", async () => {
      const beforeWrites = writes; const beforeReads = reads;
      assert.equal((await upload(id, attachmentId, "a", Buffer.concat([png, Buffer.from([2])]))).status, 409);
      const second = await store.createReport(owners.a, "ZZ TEST separate evidence report", randomUUID(), { path: "/" });
      assert.equal((await upload(second.report.id, attachmentId)).status, 409);
      for (const who of ["b", "c"]) assert.equal((await call("GET", `/api/qa-reports/${id}/attachments/${attachmentId}`, who)).status, 404);
      assert.equal(writes, beforeWrites); assert.equal(reads, beforeReads);
      assert.equal((await store.getReportDetail(owners.a, id)).attachments.length, 1);
    });
    await check("sameOriginAndCurrentAccess", async () => {
      assert.equal((await call("GET", "/api/qa-reports", "missing")).status, 401);
      assert.equal((await call("GET", "/api/qa-reports", "a", undefined, { "x-qa-test-missing-access": "true" })).status, 403);
      assert.equal((await call("GET", "/api/qa-reports", "a", undefined, { "x-qa-test-inactive": "true" })).status, 403);
      assert.equal((await call("POST", `/api/qa-reports/${id}/analyze`, "a", {}, { origin: "https://foreign.invalid" })).status, 403);
      assert.equal((await call("POST", `/api/qa-reports/${id}/analyze`, "a", {}, { "sec-fetch-site": "cross-site" })).status, 403);
    });
    let claim: Awaited<ReturnType<typeof store.claimNextReport>>;
    await check("queueAndSingleClaim", async () => {
      await Promise.all([store.queueReport(owners.a, id), store.queueReport(owners.a, id)]);
      const claims = await Promise.all([store.claimNextReport("ZZ TEST worker A"), store.claimNextReport("ZZ TEST worker B")]);
      assert.equal(claims.filter(Boolean).length, 1); claim = claims.find(Boolean)!; assert.equal(claim.id, id);
      assert.equal((await store.getReportDetail(owners.a, id)).report.status, "processing");
    });
    await check("durableJiraReservation", async () => {
      assert(claim); assert.equal(await store.reserveJiraIssueCreation(id, claim.leaseToken), true);
      assert.equal(await store.reserveJiraIssueCreation(id, claim.leaseToken), false);
      assert.equal((await store.getReportDetailForWorker(id))?.jiraCreationPending, true);
      assert.equal(await store.setJiraLink(id, randomUUID(), { key: "SCRUM-999999", url: "https://example.invalid/browse/SCRUM-999999" }), false);
      assert.equal(await store.setJiraLink(id, claim.leaseToken, { key: "SCRUM-999999", url: "https://example.invalid/browse/SCRUM-999999" }), true);
      assert.equal((await store.getReportDetailForWorker(id))?.jiraCreationPending, false);
    });
    await check("staleRevisionRequeues", async () => {
      assert(claim); await store.appendMessage(owners.a, id, "ZZ TEST arrived during analysis", randomUUID());
      assert.equal(await store.finishReport(id, claim.leaseToken, claim.revision, { content: "ZZ TEST older answer", assessment: "guidance" }), false);
      const data = await store.getReportDetail(owners.a, id);
      assert.equal(data.report.status, "queued"); assert.equal(data.report.jiraKey, "SCRUM-999999");
      assert.equal(data.messages.some(message => message.role === "assistant"), false);
      const oldFailure = await store.claimNextReport("ZZ TEST older failing analysis"); assert(oldFailure);
      await store.appendMessage(owners.a, id, "ZZ TEST newer follow-up after old failure", randomUUID());
      assert.equal(await store.failReport(id, oldFailure.leaseToken, { expectedRevision: oldFailure.revision, safeMessage: "ZZ TEST older failure", retryable: false }), false);
      const preserved = await store.getReportDetail(owners.a, id);
      assert.equal(preserved.report.status, "queued"); assert.equal(preserved.report.lastError, null);
    });
    await check("expiredLeaseCannotWrite", async () => {
      const old = await store.claimNextReport("ZZ TEST old lease"); assert(old);
      await qaPool.query("UPDATE qa_reports SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
      assert.equal(await store.renewReportLease(id, old.leaseToken), false);
      assert.equal(await store.finishReport(id, old.leaseToken, old.revision, { content: "ZZ TEST expired", assessment: "reported" }), false);
      claim = await store.claimNextReport("ZZ TEST replacement lease"); assert(claim);
      assert.notEqual(claim.leaseToken, old.leaseToken);
      assert.equal(await store.failReport(id, old.leaseToken, { safeMessage: "ZZ TEST old failure", retryable: false }), false);
      assert.equal(await store.setJiraLink(id, old.leaseToken, { key: "SCRUM-888888", url: "https://example.invalid" }), false);
      assert.equal(await store.renewReportLease(id, claim.leaseToken), true);
    });
    await check("analysisBudgetAndCache", async () => {
      assert(claim);
      assert.equal(await store.reserveAnalysisAttempt(id, claim.leaseToken, claim.revision, { dailyLimit: 100, reportLimit: 2 }), true);
      assert.equal(await store.getCachedAnalysis(id, claim.revision), null);
      assert.equal(await store.reserveAnalysisAttempt(id, claim.leaseToken, claim.revision, { dailyLimit: 100, reportLimit: 2 }), true);
      assert.equal(await store.reserveAnalysisAttempt(id, claim.leaseToken, claim.revision, { dailyLimit: 100, reportLimit: 2 }), false);
      const answer = { content: "ZZ TEST retained structured result", assessment: "needs_investigation" as const };
      assert.equal(await store.saveAnalysisResult(id, randomUUID(), claim.revision, answer), false);
      assert.equal(await store.saveAnalysisResult(id, claim.leaseToken, claim.revision, answer), true);
      assert.deepEqual(await store.getCachedAnalysis(id, claim.revision), answer);
      assert.equal(await store.finishReport(id, claim.leaseToken, claim.revision, answer), true);
      assert.equal((await store.queueReport(owners.a, id)).report.status, "complete");
      assert.equal((await store.getReportDetail(owners.a, id)).messages.filter(message => message.role === "assistant").length, 1);
    });
    await check("boundedRetries", async () => {
      await store.appendMessage(owners.a, id, "ZZ TEST retry sequence", randomUUID());
      await store.queueReport(owners.a, id);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const next = await store.claimNextReport("ZZ TEST retry"); assert(next);
        assert.equal(await store.failReport(id, next.leaseToken, { safeMessage: "Analysis is temporarily unavailable", retryable: true, nextAttemptSeconds: 5 }), true);
        const data = await store.getReportDetail(owners.a, id);
        assert.equal(data.report.status, attempt < 3 ? "retrying" : "needs_configuration");
        assert.equal(data.report.jiraKey, "SCRUM-999999");
        await qaPool.query("UPDATE qa_reports SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [id]);
      }
      assert.equal(await store.claimNextReport("ZZ TEST after limit"), null);
    });
    await check("interruptedDraftPickup", async () => {
      const draft = await store.createReport(owners.a, "ZZ TEST interrupted draft", randomUUID(), { path: "/" });
      assert.equal(await store.claimNextReport("ZZ TEST recent draft"), null);
      await qaPool.query("UPDATE qa_reports SET updated_at=now()-interval '6 minutes' WHERE id=$1", [draft.report.id]);
      const next = await store.claimNextReport("ZZ TEST recovered draft"); assert.equal(next?.id, draft.report.id);
    });
  } catch {
    console.log(`QA_REPORT_SETUP_ERROR=${setupStage}`);
    process.exitCode = 1;
  } finally {
    storage.client.send = originalSend;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await qaPool.query("DELETE FROM qa_reports WHERE tenant_id IN($1,$2)", [tenantA, tenantB]);
    await qaPool.query("DELETE FROM users WHERE id IN($1,$2,$3)", [userA, userB, userC]);
    await qaPool.query("DELETE FROM tenants WHERE id IN($1,$2)", [tenantA, tenantB]);
    await qaPool.end();
  }
}
console.log("QA_REPORT_RESULTS=" + JSON.stringify(results));
if (Object.values(results).some(result => !result)) process.exitCode = 1;
