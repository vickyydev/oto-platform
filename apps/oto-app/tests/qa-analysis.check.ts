import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ANALYSIS_LIMITS, boundedConversation, extractEvidenceFrames, fallbackAnalysis, validateAnalysis } from "../server/qa/analysis";
import { approvedSourcePath, validateSourceIndex, type SourceChunk } from "../server/qa/source-index";
import { jiraDocument, QaJiraClient, QaJiraError } from "../server/qa/jira";
import { processQaClaim, type WorkerServices } from "../server/qa/worker";
import type { WorkerDetail } from "../server/qa/store";

const results: Record<string, boolean> = {}, failures: Record<string, string> = {};
async function check(name: string, work: () => unknown | Promise<unknown>): Promise<void> {
  try { await work(); results[name] = true; } catch { results[name] = false; failures[name] = "The named QA boundary control did not pass"; }
}
const sha = "a".repeat(40), otherSha = "b".repeat(40);
const chunk: SourceChunk = { file: "apps/oto-app/server/example.ts", startLine: 10, endLine: 12, content: "export const first = true;\nexport const next = true;\nexport const last = true;" };
const detail = (): WorkerDetail => {
  const id = randomUUID();
  return { report: { id, title: "ZZ TEST QA report", context: { path: "/zz-test", appVersion: sha }, status: "processing", assessment: "reported", jiraKey: null, jiraUrl: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null }, messages: [{ id: randomUUID(), role: "user", content: "ZZ TEST initial report", createdAt: new Date().toISOString() }], attachments: [], tenantId: randomUUID(), userId: randomUUID(), revision: 1, attempts: 1, jiraCreationPending: false };
};

function fakeWorker(value: WorkerDetail): { services: WorkerServices; state: { created: number; linked: boolean; analyzed: number; finished: boolean; failed: boolean; queued: boolean; attached: number; issue: boolean; ambiguous: boolean } } {
  const state = { created: 0, linked: false, analyzed: 0, finished: false, failed: false, queued: false, attached: 0, issue: false, ambiguous: false };
  const services: WorkerServices = {
    store: {
      getReportDetailForWorker: async () => value, renewReportLease: async () => true,
      reserveJiraIssueCreation: async () => { if (value.jiraCreationPending) return false; value.jiraCreationPending = true; return true; },
      releaseJiraIssueCreation: async () => { value.jiraCreationPending = false; return true; },
      setJiraLink: async (_id, _lease, link) => { state.linked = true; value.report.jiraKey = link.key; value.jiraCreationPending = false; return true; },
      getCachedAnalysis: async () => null, reserveAnalysisAttempt: async () => true, saveAnalysisResult: async () => true,
      finishReport: async () => { state.finished = true; return true; },
      failReport: async (_id, _lease, input) => { state.failed = true; if (input.expectedRevision !== value.revision) state.queued = true; return !state.queued; },
    },
    jira: {
      verifyParent: async () => undefined,
      verifyIssue: async (key) => ({ key, fields: {} }), findReportIssue: async () => state.issue ? "SCRUM-999" : null,
      createReportIssue: async () => { state.created++; if (state.ambiguous) throw new QaJiraError(true); state.issue = true; return { key: "SCRUM-999", url: "https://zz-test.atlassian.net/browse/SCRUM-999" }; },
      issueUrl: () => "https://zz-test.atlassian.net/browse/SCRUM-999", commentOnce: async () => undefined,
      attachOnce: async () => { state.attached++; },
    },
    configured: () => false,
    analyze: async () => { state.analyzed++; return fallbackAnalysis("ZZ TEST provider unavailable"); },
  };
  return { services, state };
}

await check("sourceVersion", () => {
  const chunks = [chunk], index = { version: 1, sha, files: 1, chunks, digest: createHash("sha256").update(JSON.stringify(chunks)).digest("hex") };
  assert.ok(validateSourceIndex(index, sha)); assert.equal(validateSourceIndex(index, otherSha), null);
  for (const name of [".env", "imports/a.ts", "services/a.ts", "apps/oto-app/server/../../.env", "apps/oto-app/server/config/env.ts"]) assert.equal(approvedSourcePath(name), false);
});
await check("citationBounds", () => {
  const valid = { assessment: "code_supported", explanation: "The supplied handler checks the record owner.", citations: [{ file: chunk.file, startLine: 10, endLine: 12 }] };
  assert.equal(validateAnalysis(valid, [chunk], sha, []).assessment, "code_supported");
  assert.equal(validateAnalysis({ ...valid, citations: [{ ...valid.citations[0], endLine: 13 }] }, [chunk], sha, []).assessment, "needs_investigation");
  assert.equal(validateAnalysis(valid, [chunk], null, []).assessment, "needs_investigation");
  assert.throws(() => validateAnalysis({ ...valid, command: "ZZ TEST ignored command" }, [chunk], sha, []));
});
await check("citationVisibility", () => {
  const valid = { assessment: "code_supported", explanation: "The supplied handler checks the record owner.", citations: [{ file: chunk.file, startLine: 10, endLine: 12 }] };
  const answer = validateAnalysis(valid, [chunk], sha, []);
  assert.ok(answer.content.includes(`${chunk.file}:10-12`)); assert.ok(answer.content.includes(sha));
  assert.equal(answer.content.includes(chunk.content), false);
  const unsupported = validateAnalysis({ ...valid, citations: [{ ...valid.citations[0], endLine: 13 }] }, [chunk], sha, []);
  assert.equal(unsupported.content.includes(`${chunk.file}:10-13`), false);
  assert.equal(validateAnalysis(valid, [chunk], null, []).content.includes(`${chunk.file}:10-12`), false);
});
await check("latestTurn", () => {
  const value = detail(); value.messages[0]!.content = "ZZ TEST initial " + "x".repeat(11_950);
  value.messages.push({ id: randomUUID(), role: "user", content: "ZZ TEST latest followup remains visible", createdAt: new Date().toISOString() });
  const context = boundedConversation(value); assert.ok(context.text.includes("latest followup remains visible")); assert.ok(context.omitted); assert.ok(context.text.length <= ANALYSIS_LIMITS.textCharacters);
});
await check("runtimeClaims", () => {
  for (const explanation of ["I fixed the issue", "The issue has been fixed", "Tests passed on staging", "The request was reproduced"]) assert.equal(validateAnalysis({ assessment: "code_supported", explanation, citations: [{ file: chunk.file, startLine: 10, endLine: 11 }] }, [chunk], sha, []).assessment, "needs_investigation");
});
await check("jiraText", () => {
  const long = "ZZ TEST " + "x".repeat(11_950) + " TAIL PRESERVED";
  const document = jiraDocument(long) as { content: { content: { text: string }[] }[] };
  assert.equal(document.content.flatMap((p) => p.content).map((p) => p.text).join(""), long);
});
await check("jiraPlacement", async () => {
  Object.assign(process.env, { QA_JIRA_BASE_URL: "https://zz-test.atlassian.net", QA_JIRA_EMAIL: "zz-test@example.invalid", QA_JIRA_API_TOKEN: "ZZ TEST placeholder", QA_JIRA_PARENT_KEY: "SCRUM-553", QA_JIRA_SPRINT_ID: "3", QA_JIRA_ISSUE_TYPE_ID: "10002" });
  let requests = 0; const client = new QaJiraClient(async () => { requests++; return new Response("{}"); });
  await assert.rejects(client.verifyParent()); assert.equal(requests, 0); process.env.QA_JIRA_SPRINT_ID = "36";
});
await check("jiraAmbiguous", async () => {
  const value = detail(), { services, state } = fakeWorker(value); state.ambiguous = true;
  const claim = { id: value.report.id, leaseToken: randomUUID(), revision: 1 };
  await processQaClaim(claim, services); await processQaClaim(claim, services); assert.equal(state.created, 1); assert.ok(value.jiraCreationPending);
  state.issue = true; await processQaClaim(claim, services); assert.ok(state.linked); assert.equal(state.created, 1);
});
await check("workerFallback", async () => {
  const value = detail(), { services, state } = fakeWorker(value);
  await processQaClaim({ id: value.report.id, leaseToken: randomUUID(), revision: 1 }, services);
  assert.ok(state.linked); assert.ok(state.failed); assert.equal(state.finished, false); assert.equal(state.analyzed, 0);
});
await check("newerRevisionFailureRequeues", async () => {
  const value = detail(), { services, state } = fakeWorker(value); services.configured = () => true;
  services.analyze = async () => { value.revision = 2; return fallbackAnalysis("ZZ TEST temporary provider failure"); };
  await processQaClaim({ id: value.report.id, leaseToken: randomUUID(), revision: 1 }, services);
  assert.ok(state.queued); assert.equal(state.finished, false);
});
await check("allAcceptedEvidencePublishes", async () => {
  const value = detail(), { services, state } = fakeWorker(value);
  value.attachments = Array.from({ length: 10 }, () => ({ id: randomUUID(), name: "ZZ TEST evidence.png", contentType: "image/png", size: 10, createdAt: new Date().toISOString(), objectKey: "ZZ TEST private key placeholder", sha256: "c".repeat(64) }));
  await processQaClaim({ id: value.report.id, leaseToken: randomUUID(), revision: 1 }, services);
  assert.equal(state.attached, 10);
  await assert.rejects(extractEvidenceFrames(Buffer.alloc(1), true, 9, "video/mp4"));
});

console.log("QA_WORKER_RESULTS=" + JSON.stringify({ results, failures }));
if (Object.values(results).some((value) => !value)) process.exitCode = 1;
