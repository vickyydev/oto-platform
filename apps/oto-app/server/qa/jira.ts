import { createHash } from "node:crypto";
import { readQaObject, qaAttachmentKey, validateQaAttachment } from "./media";
import type { WorkerAttachment, WorkerDetail } from "./store";
import { safeReportText } from "./analysis";

export class QaJiraError extends Error {
  constructor(public retryable: boolean, public definiteRejection = false) { super("The report is saved; its QA board connection needs another attempt."); }
}
interface JiraIssue { key: string; fields: { parent?: { key?: string }; labels?: string[]; project?: { key?: string }; attachment?: { filename?: string }[]; security?: { id?: string }; [field: string]: unknown } }
const project = "SCRUM", parent = "SCRUM-553", sprint = 36;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const marker = (id: string) => { if (!uuid.test(id)) throw new QaJiraError(false); return `qa-report-${id}`; };
export function jiraDocument(text: string): { type: string; version: number; content: unknown[] } {
  if (text.length > 30_000) throw new QaJiraError(false);
  const content: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.length) content.push({ type: "paragraph", content: [] });
    for (let offset = 0; offset < line.length; offset += 1000) content.push({ type: "paragraph", content: [{ type: "text", text: line.slice(offset, offset + 1000) }] });
  }
  return { type: "doc", version: 1, content };
}

function configuration(): { base: string; authorization: string; sprintField: string } {
  const raw = process.env.QA_JIRA_BASE_URL, email = process.env.QA_JIRA_EMAIL, token = process.env.QA_JIRA_API_TOKEN;
  if (!raw || !email || !token || (process.env.QA_JIRA_PARENT_KEY || parent) !== parent || Number(process.env.QA_JIRA_SPRINT_ID || sprint) !== sprint || (process.env.QA_JIRA_ISSUE_TYPE_ID || "10002") !== "10002") throw new QaJiraError(false);
  const base = new URL(raw);
  if (base.protocol !== "https:" || !/^[a-z0-9-]+\.atlassian\.net$/i.test(base.hostname) || base.username || base.password || base.search || base.hash || !["", "/"].includes(base.pathname)) throw new QaJiraError(false);
  const sprintField = process.env.QA_JIRA_SPRINT_FIELD || "customfield_10020";
  if (!/^customfield_\d+$/.test(sprintField)) throw new QaJiraError(false);
  return { base: base.origin, authorization: "Basic " + Buffer.from(email + ":" + token).toString("base64"), sprintField };
}

export class QaJiraClient {
  private commentCache = new Map<string, string>();
  constructor(private fetcher: typeof fetch = fetch) {}

  private async request(path: string, method = "GET", body?: unknown, form?: FormData): Promise<unknown> {
    const config = configuration();
    if (!/^\/rest\/api\/3\/(?:issue(?:\/|$)|search\/jql(?:\?|$))/.test(path)) throw new QaJiraError(false);
    let response: Response;
    try {
      response = await this.fetcher(config.base + path, { method, redirect: "error", headers: { authorization: config.authorization, accept: "application/json", ...(form ? { "X-Atlassian-Token": "no-check" } : body !== undefined ? { "content-type": "application/json" } : {}) }, body: form ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(12_000) });
    } catch { throw new QaJiraError(true); }
    if (!response.ok) throw new QaJiraError(response.status >= 500 || response.status === 429, [400, 401, 403, 404, 413, 422].includes(response.status));
    if (response.status === 204) return null;
    const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new QaJiraError(true);
    try { return text ? JSON.parse(text) : null; } catch { throw new QaJiraError(true); }
  }

  async verifyParent(): Promise<void> {
    const { sprintField } = configuration();
    const issue = await this.request(`/rest/api/3/issue/${parent}?fields=project,${sprintField}`) as JiraIssue;
    const values = issue?.fields?.[sprintField];
    if (issue.key !== parent || issue.fields.project?.key !== project || !Array.isArray(values) || !values.some((value: unknown) => typeof value === "object" && value !== null && Number((value as { id?: unknown }).id) === sprint)) throw new QaJiraError(false);
  }

  async verifyIssue(key: string, id: string): Promise<JiraIssue> {
    if (!/^SCRUM-\d+$/.test(key)) throw new QaJiraError(false);
    const issue = await this.request(`/rest/api/3/issue/${key}?fields=project,parent,labels,attachment`) as JiraIssue;
    if (issue?.key !== key || issue.fields.parent?.key !== parent || issue.fields.project?.key !== project || !issue.fields.labels?.includes(marker(id))) throw new QaJiraError(false);
    return issue;
  }

  async findReportIssue(id: string): Promise<string | null> {
    const label = marker(id);
    const jql = `project = SCRUM AND parent = SCRUM-553 AND labels = "${label}"`;
    const result = await this.request(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=2`) as { issues?: { key: string }[] };
    if (!Array.isArray(result.issues) || result.issues.length > 1) throw new QaJiraError(false);
    const key = result.issues[0]?.key; if (key) await this.verifyIssue(key, id);
    return key ?? null;
  }

  async createReportIssue(detail: WorkerDetail): Promise<{ key: string; url: string }> {
    await this.verifyParent();
    const label = marker(detail.report.id);
    const context = detail.report.context;
    const metadata = `App path: ${context.path}\nApp version: ${context.appVersion || "not available"}\nBranch: ${context.branchId || "not supplied"}\nRole: ${context.role || "not supplied"}\nBrowser: ${context.browser || "not supplied"}\nViewport: ${context.viewport ? context.viewport.width + "x" + context.viewport.height : "not supplied"}\nLocale: ${context.locale || "not supplied"}\nTimezone: ${context.timezone || "not supplied"}`;
    const text = `QA report ${detail.report.id}\n${safeReportText(metadata, 3000)}\n\n${safeReportText(detail.messages.find((message) => message.role === "user")?.content || detail.report.title, 12_000)}\n\nAssessment: reported. Automated analysis and runtime reproduction are not yet established.\nVideo audio is not transcribed or analyzed.`;
    const issue = await this.request("/rest/api/3/issue", "POST", { fields: { project: { key: project }, parent: { key: parent }, issuetype: { id: "10002" }, summary: safeReportText(detail.report.title, 180) || "App QA report", description: jiraDocument(text), labels: ["oto-app-qa", label] } }) as { key?: string };
    if (!issue?.key || !/^SCRUM-\d+$/.test(issue.key)) throw new QaJiraError(true);
    return { key: issue.key, url: `${configuration().base}/browse/${issue.key}` };
  }

  issueUrl(key: string): string { if (!/^SCRUM-\d+$/.test(key)) throw new QaJiraError(false); return `${configuration().base}/browse/${key}`; }

  async commentOnce(key: string, id: string, revision: number, kind: "user" | "analysis" | "analysis-unavailable" | `message-${string}`, text: string): Promise<void> {
    await this.verifyParent();
    await this.verifyIssue(key, id);
    if (!Number.isInteger(revision) || revision < 0 || (kind.startsWith("message-") && !uuid.test(kind.slice(8)))) throw new QaJiraError(false);
    const tag = kind.startsWith("message-") ? `[${marker(id)}:${kind}]` : `[${marker(id)}:revision-${revision}:${kind}]`;
    // The service only appends these bounded report comments. Read all report
    // pages within a fixed ceiling; refuse instead of silently losing dedupe.
    let comments = this.commentCache.get(key);
    if (comments === undefined) { comments = ""; for (let page = 0; page < 5; page++) {
      const result = await this.request(`/rest/api/3/issue/${key}/comment?startAt=${page * 100}&maxResults=100`) as { comments?: unknown[]; total?: number };
      if (!Array.isArray(result.comments)) throw new QaJiraError(true);
      comments += JSON.stringify(result.comments);
      if ((page + 1) * 100 >= Number(result.total ?? 0)) break;
      if (page === 4) throw new QaJiraError(false);
    } this.commentCache.set(key, comments); }
    if (!comments.includes(tag)) {
      try { await this.request(`/rest/api/3/issue/${key}/comment`, "POST", { body: jiraDocument(`${tag}\n${safeReportText(text, 24_000)}`) }); }
      catch (error) { this.commentCache.delete(key); throw error; }
      this.commentCache.set(key, comments + tag);
    }
  }

  async attachOnce(key: string, detail: WorkerDetail, attachment: WorkerAttachment): Promise<void> {
    await this.verifyParent();
    const issue = await this.verifyIssue(key, detail.report.id);
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" } as Record<string, string>)[attachment.contentType];
    if (!extension || !uuid.test(attachment.id)) throw new QaJiraError(false);
    const name = `qa-${detail.report.id}-${attachment.id}.${extension}`;
    if (issue.fields.attachment?.some((existing) => existing.filename === name)) return;
    const bytes = await readPrivateEvidence(detail, attachment);
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: attachment.contentType }), name);
    await this.request(`/rest/api/3/issue/${key}/attachments`, "POST", undefined, form);
  }
}

export async function readPrivateEvidence(detail: WorkerDetail, attachment: WorkerAttachment): Promise<Buffer> {
  if (attachment.objectKey !== qaAttachmentKey(detail.tenantId, detail.report.id, attachment.id) || attachment.size > 25 * 1024 * 1024) throw new QaJiraError(false);
  const bytes = await readQaObject(attachment.objectKey);
  validateQaAttachment(bytes, attachment.contentType);
  if (bytes.length !== attachment.size || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new QaJiraError(false);
  return bytes;
}
