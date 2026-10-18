import { aiConfigured } from "../lib/anthropic";
import { analyzeReport, fallbackAnalysis, type AnalysisResult } from "./analysis";
import { QaJiraClient, QaJiraError } from "./jira";
import * as storage from "./store";
import type { QaClaim, FinishReportInput } from "./store";

type QaStore = Pick<typeof storage, "getReportDetailForWorker" | "renewReportLease" | "reserveJiraIssueCreation" | "releaseJiraIssueCreation" | "setJiraLink" | "getCachedAnalysis" | "reserveAnalysisAttempt" | "saveAnalysisResult" | "finishReport" | "failReport">;
export interface WorkerServices { store: QaStore; jira: Pick<QaJiraClient, "verifyParent" | "verifyIssue" | "findReportIssue" | "createReportIssue" | "issueUrl" | "commentOnce" | "attachOnce">; analyze: typeof analyzeReport; configured: () => boolean }
class LeaseLost extends Error {}
class WorkDeadline extends Error {}
export function boundedSetting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("QA worker limit configuration is unavailable");
  return value;
}

export async function processQaClaim(claim: QaClaim, overrides: Partial<WorkerServices> = {}): Promise<void> {
  const { store, jira, analyze, configured }: WorkerServices = { store: storage, jira: new QaJiraClient(), analyze: analyzeReport, configured: aiConfigured, ...overrides };
  const deadline = Date.now() + 240_000;
  const keepLease = async () => { if (Date.now() >= deadline) throw new WorkDeadline(); if (!await store.renewReportLease(claim.id, claim.leaseToken)) throw new LeaseLost(); };
  try {
    await keepLease();
    const detail = await store.getReportDetailForWorker(claim.id); if (!detail) return;
    if (detail.revision !== claim.revision) { await store.finishReport(claim.id, claim.leaseToken, claim.revision, { content: "A newer message is queued for review.", assessment: "reported" }); return; }
    await jira.verifyParent();
    let key = detail.report.jiraKey;
    if (key) await jira.verifyIssue(key, claim.id);
    else {
      key = await jira.findReportIssue(claim.id);
      if (!key) {
        await keepLease();
        if (detail.jiraCreationPending || !await store.reserveJiraIssueCreation(claim.id, claim.leaseToken)) throw new QaJiraError(true);
        try { const created = await jira.createReportIssue(detail); key = created.key; }
        catch (error) { if (error instanceof QaJiraError && error.definiteRejection) await store.releaseJiraIssueCreation(claim.id, claim.leaseToken); throw error; }
      }
      // Save the recovered/created link before media or AI can fail. It is
      // independent of message revision, and never creates a second issue.
      if (!await store.setJiraLink(claim.id, claim.leaseToken, { key, url: jira.issueUrl(key) })) throw new LeaseLost();
    }
    for (const message of detail.messages.filter((m) => m.role === "user").slice(1)) {
      await keepLease(); await jira.commentOnce(key, claim.id, 0, `message-${message.id}`, message.content);
    }
    if (detail.attachments.length > 10) throw new QaJiraError(false);
    for (const attachment of detail.attachments) { await keepLease(); await jira.attachOnce(key, detail, attachment); }
    await keepLease();
    const cached = await store.getCachedAnalysis(claim.id, claim.revision);
    let answer: AnalysisResult;
    if (cached) answer = { content: cached.content, assessment: cached.assessment === "related_report" ? "needs_investigation" : cached.assessment, availability: "complete", sourceEvidence: (cached.sourceEvidence || { sha: null, citations: [], notes: [] }) as AnalysisResult["sourceEvidence"] };
    else if (!configured()) answer = fallbackAnalysis("Automated analysis is awaiting its service configuration.", null, [], "needs_configuration");
    else if (!await store.reserveAnalysisAttempt(claim.id, claim.leaseToken, claim.revision, { dailyLimit: boundedSetting("QA_MAX_DAILY_ANALYSES", 100, 1, 1000), reportLimit: boundedSetting("QA_MAX_REPORT_ANALYSES", 3, 1, 20) })) answer = fallbackAnalysis("The configured analysis allowance has been reached. The report is saved on the QA board; another review can be requested after the allowance is available.", null, [], "needs_configuration");
    else {
      answer = await analyze(detail, keepLease);
      if (answer.availability === "complete") {
        const input: FinishReportInput = { content: answer.content, assessment: answer.assessment, sourceEvidence: { ...answer.sourceEvidence, usage: answer.modelUsage } };
        if (!await store.saveAnalysisResult(claim.id, claim.leaseToken, claim.revision, input)) { await store.finishReport(claim.id, claim.leaseToken, claim.revision, input); return; }
      }
    }
    await keepLease();
    await jira.commentOnce(key, claim.id, claim.revision, answer.availability === "complete" ? "analysis" : "analysis-unavailable", answer.content);
    if (answer.availability !== "complete") {
      await store.failReport(claim.id, claim.leaseToken, { safeMessage: answer.content, retryable: answer.availability === "retryable", nextAttemptSeconds: 60, expectedRevision: claim.revision }); return;
    }
    await store.finishReport(claim.id, claim.leaseToken, claim.revision, { content: answer.content, assessment: answer.assessment, sourceEvidence: { ...answer.sourceEvidence, usage: answer.modelUsage } });
  } catch (error) {
    if (error instanceof LeaseLost) return;
    await store.failReport(claim.id, claim.leaseToken, { safeMessage: error instanceof QaJiraError ? error.message : "The report and evidence are saved. Its background review will continue with another attempt.", retryable: error instanceof QaJiraError ? error.retryable : true, nextAttemptSeconds: 60, expectedRevision: claim.revision });
  }
}
