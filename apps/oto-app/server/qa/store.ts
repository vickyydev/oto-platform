import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import type { QaAssessment, QaAttachment, QaContext, QaMessage, QaReport, QaReportDetail } from "../../shared/qa-reports";

export interface QaOwner { tenantId: string; userId: string }
export interface WorkerAttachment extends QaAttachment { objectKey: string; sha256: string }
export interface WorkerDetail {
  report: QaReport;
  messages: QaMessage[];
  attachments: WorkerAttachment[];
  tenantId: string;
  userId: string;
  revision: number;
  attempts: number;
  jiraCreationPending: boolean;
}
export interface QaClaim { id: string; leaseToken: string; revision: number }
export interface FinishReportInput {
  content: string;
  assessment: QaAssessment;
  jiraKey?: string;
  jiraUrl?: string;
  sourceEvidence?: unknown;
}
export interface FailReportInput { safeMessage: string; retryable: boolean; nextAttemptSeconds?: number; expectedRevision?: number }

if (process.env.DB_SCHEMA && process.env.DB_SCHEMA !== "otoapp") throw new Error("QA storage requires the app schema");
export const qaPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: "-c search_path=otoapp", application_name: "oto-app-qa" });

interface ReportRow extends pg.QueryResultRow {
  id: string; tenant_id: string; user_id: string; title: string; status: QaReport["status"];
  assessment: QaAssessment; jira_key: string | null; jira_url: string | null;
  context: QaContext; created_at: Date; updated_at: Date; last_error: string | null;
  revision: number; attempts: number; request_hash: string; jira_creation_pending: boolean;
}
interface AttachmentRow extends pg.QueryResultRow {
  id: string; report_id: string; name: string; content_type: string; size: number;
  created_at: Date; object_key: string; sha256: string;
}
type Query = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;
const iso = (value: Date) => new Date(value).toISOString();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reportApi = (row: ReportRow): QaReport => ({
  id: row.id, title: row.title, status: row.status, assessment: row.assessment,
  jiraKey: row.jira_key, jiraUrl: row.jira_url, context: row.context,
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), lastError: row.last_error,
});
const attachmentApi = (row: AttachmentRow): QaAttachment => ({
  id: row.id, name: row.name, contentType: row.content_type, size: row.size, createdAt: iso(row.created_at),
});

export class QaStoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await qaPool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function ownedRow(query: Query, owner: QaOwner, id: string, lock = false): Promise<ReportRow> {
  const { rows } = await query.query<ReportRow>(
    `SELECT * FROM qa_reports WHERE id=$1 AND tenant_id=$2 AND user_id=$3${lock ? " FOR UPDATE" : ""}`,
    [id, owner.tenantId, owner.userId],
  );
  if (!rows[0]) throw new QaStoreError(404, "Report not found");
  return rows[0];
}

async function detail(query: Query, row: ReportRow): Promise<QaReportDetail> {
  const messages = await query.query<{ id: string; role: QaMessage["role"]; content: string; created_at: Date }>(
    "SELECT id,role,content,created_at FROM qa_report_messages WHERE report_id=$1 ORDER BY sequence", [row.id],
  );
  const attachments = await query.query<AttachmentRow>(
    "SELECT * FROM qa_report_attachments WHERE report_id=$1 ORDER BY created_at,id", [row.id],
  );
  return {
    report: reportApi(row), messages: messages.rows.map(m => ({ id: m.id, role: m.role, content: m.content, createdAt: iso(m.created_at) })),
    attachments: attachments.rows.map(attachmentApi),
  };
}

export async function listReports(owner: QaOwner): Promise<QaReport[]> {
  const { rows } = await qaPool.query<ReportRow>(
    "SELECT * FROM qa_reports WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC,id LIMIT 50", [owner.tenantId, owner.userId],
  );
  return rows.map(reportApi);
}

export async function getReportDetail(owner: QaOwner, id: string): Promise<QaReportDetail> {
  // One snapshot keeps message content and the report's revision/status together.
  return transaction(async client => detail(client, await ownedRow(client, owner, id, true)));
}

export async function createReport(owner: QaOwner, message: string, clientRequestId: string, context: QaContext): Promise<QaReportDetail> {
  return transaction(async client => {
    const id = randomUUID();
    // A deploy or role refresh cannot invalidate a replay of the same browser request.
    const { appVersion: _appVersion, role: _role, ...requestContext } = context;
    const requestHash = hash({ message, context: requestContext });
    const { rows } = await client.query<ReportRow>(
      `INSERT INTO qa_reports(id,tenant_id,user_id,client_request_id,request_hash,title,context)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,user_id,client_request_id) DO NOTHING RETURNING *`,
      [id, owner.tenantId, owner.userId, clientRequestId, requestHash, message.split(/\r?\n/)[0].slice(0, 120), context],
    );
    if (rows[0]) {
      await client.query("INSERT INTO qa_report_messages(id,report_id,role,content,client_request_id) VALUES($1,$2,'user',$3,$4)", [randomUUID(), id, message, clientRequestId]);
      return detail(client, rows[0]);
    }
    const existing = await client.query<ReportRow>(
      "SELECT * FROM qa_reports WHERE tenant_id=$1 AND user_id=$2 AND client_request_id=$3 FOR UPDATE", [owner.tenantId, owner.userId, clientRequestId],
    );
    if (!existing.rows[0] || existing.rows[0].request_hash !== requestHash) throw new QaStoreError(409, "This request was already saved with different details");
    return detail(client, existing.rows[0]);
  });
}

export async function appendMessage(owner: QaOwner, id: string, content: string, clientRequestId: string): Promise<QaReportDetail> {
  return transaction(async client => {
    const row = await ownedRow(client, owner, id, true);
    const existing = await client.query<{ content: string }>("SELECT content FROM qa_report_messages WHERE report_id=$1 AND client_request_id=$2", [id, clientRequestId]);
    if (existing.rows[0]) {
      if (existing.rows[0].content !== content) throw new QaStoreError(409, "This message was already saved with different text");
      return detail(client, row);
    }
    const count = await client.query<{ count: string }>("SELECT count(*) FROM qa_report_messages WHERE report_id=$1 AND role='user'", [id]);
    if (Number(count.rows[0].count) >= 100) throw new QaStoreError(409, "This conversation has reached its message limit");
    await client.query("INSERT INTO qa_report_messages(id,report_id,role,content,client_request_id) VALUES($1,$2,'user',$3,$4)", [randomUUID(), id, content, clientRequestId]);
    const updated = await client.query<ReportRow>(
      `UPDATE qa_reports SET revision=revision+1, attempts=0, last_error=NULL, updated_at=now(),
       status=CASE WHEN status='processing' THEN status ELSE 'draft' END WHERE id=$1 RETURNING *`, [id],
    );
    return detail(client, updated.rows[0]);
  });
}

export async function queueReport(owner: QaOwner, id: string): Promise<QaReportDetail> {
  return transaction(async client => {
    const row = await ownedRow(client, owner, id, true);
    if (row.status === "processing" || row.status === "queued" || row.status === "retrying") return detail(client, row);
    const updated = await client.query<ReportRow>(
      `UPDATE qa_reports SET status=CASE WHEN revision=analyzed_revision THEN 'complete' ELSE 'queued' END,
       attempts=0,last_error=NULL,next_attempt_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [id],
    );
    return detail(client, updated.rows[0]);
  });
}

export async function addAttachment(owner: QaOwner, id: string, attachment: {
  id: string; name: string; contentType: string; size: number; objectKey: string; sha256: string;
}, persist?: () => Promise<void>): Promise<QaAttachment> {
  return transaction(async client => {
    await ownedRow(client, owner, id, true);
    const existing = await client.query<AttachmentRow>("SELECT * FROM qa_report_attachments WHERE id=$1", [attachment.id]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.report_id !== id || row.name !== attachment.name || row.content_type !== attachment.contentType ||
          row.size !== attachment.size || row.sha256 !== attachment.sha256 || row.object_key !== attachment.objectKey) {
        throw new QaStoreError(409, "This evidence request was already saved with different details");
      }
      return attachmentApi(row);
    }
    const count = await client.query<{ count: string }>("SELECT count(*) FROM qa_report_attachments WHERE report_id=$1", [id]);
    if (Number(count.rows[0].count) >= 10) throw new QaStoreError(409, "A report can contain up to ten attachments");
    // Hold the report lock through the bounded object write: replays cannot replace its bytes.
    await persist?.();
    const { rows } = await client.query<AttachmentRow>(
      `INSERT INTO qa_report_attachments(id,report_id,name,content_type,size,object_key,sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [attachment.id, id, attachment.name, attachment.contentType, attachment.size, attachment.objectKey, attachment.sha256],
    );
    await client.query(
      `UPDATE qa_reports SET revision=revision+1,attempts=0,last_error=NULL,updated_at=now(),
       status=CASE WHEN status='processing' THEN status ELSE 'draft' END WHERE id=$1`, [id],
    );
    return attachmentApi(rows[0]);
  });
}

export async function getAttachment(owner: QaOwner, id: string, attachmentId: string): Promise<WorkerAttachment> {
  await ownedRow(qaPool, owner, id);
  const { rows } = await qaPool.query<AttachmentRow>("SELECT * FROM qa_report_attachments WHERE id=$1 AND report_id=$2", [attachmentId, id]);
  if (!rows[0]) throw new QaStoreError(404, "Attachment not found");
  return { ...attachmentApi(rows[0]), objectKey: rows[0].object_key, sha256: rows[0].sha256 };
}

export async function getReportDetailForWorker(id: string): Promise<WorkerDetail | null> {
  return transaction(async client => {
    const { rows } = await client.query<ReportRow>("SELECT * FROM qa_reports WHERE id=$1 FOR UPDATE", [id]);
    const row = rows[0];
    if (!row) return null;
    const attachments = await client.query<AttachmentRow>("SELECT * FROM qa_report_attachments WHERE report_id=$1 ORDER BY created_at,id", [id]);
    return { ...await detail(client, row), tenantId: row.tenant_id, userId: row.user_id,
      revision: row.revision, attempts: row.attempts, jiraCreationPending: row.jira_creation_pending,
      attachments: attachments.rows.map(a => ({ ...attachmentApi(a), objectKey: a.object_key, sha256: a.sha256 })),
    };
  });
}

export async function claimNextReport(workerId: string): Promise<QaClaim | null> {
  const leaseToken = randomUUID();
  return transaction(async client => {
    await client.query(
      `UPDATE qa_reports SET status='needs_configuration',lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,
       last_error='Processing paused after repeated interruptions. Retry this report.',updated_at=now()
       WHERE status='processing' AND lease_expires_at<now() AND attempts>=3`,
    );
    const { rows } = await client.query<{ id: string; revision: number }>(
    `WITH candidate AS (SELECT id FROM qa_reports WHERE
      (status IN ('queued','retrying') AND next_attempt_at<=now()) OR
      (status='draft' AND updated_at<now()-interval '5 minutes') OR
      (status='processing' AND lease_expires_at<now())
      ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
     UPDATE qa_reports r SET status='processing',lease_token=$1,worker_id=$2,
      lease_expires_at=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
     FROM candidate WHERE r.id=candidate.id RETURNING r.id,r.revision`, [leaseToken, workerId.slice(0, 120)],
  );
    return rows[0] ? { ...rows[0], leaseToken } : null;
  });
}

export async function renewReportLease(id: string, leaseToken: string): Promise<boolean> {
  const result = await qaPool.query(
    `UPDATE qa_reports SET lease_expires_at=now()+interval '5 minutes'
     WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_expires_at>now()`, [id, leaseToken],
  );
  return result.rowCount === 1;
}

export async function reserveJiraIssueCreation(id: string, leaseToken: string): Promise<boolean> {
  const result = await qaPool.query(
    `UPDATE qa_reports SET jira_creation_pending=true WHERE id=$1 AND lease_token=$2
     AND status='processing' AND lease_expires_at>now() AND jira_key IS NULL AND jira_creation_pending=false`, [id, leaseToken],
  );
  return result.rowCount === 1;
}

/** Only a definite provider rejection may release the one-time create reservation. */
export async function releaseJiraIssueCreation(id: string, leaseToken: string): Promise<boolean> {
  const result = await qaPool.query(
    `UPDATE qa_reports SET jira_creation_pending=false WHERE id=$1 AND lease_token=$2
     AND status='processing' AND lease_expires_at>now() AND jira_key IS NULL`, [id, leaseToken],
  );
  return result.rowCount === 1;
}

export async function reserveAnalysisAttempt(id: string, leaseToken: string, revision: number, limits: { dailyLimit: number; reportLimit: number }): Promise<boolean> {
  const dailyLimit = Math.max(1, Math.min(1000, Math.trunc(limits.dailyLimit)));
  const reportLimit = Math.max(1, Math.min(20, Math.trunc(limits.reportLimit)));
  if (!Number.isFinite(dailyLimit) || !Number.isFinite(reportLimit)) return false;
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('qa-analysis-budget',0))");
    const report = await client.query(
      "SELECT id FROM qa_reports WHERE id=$1 AND lease_token=$2 AND revision=$3 AND status='processing' AND lease_expires_at>now() FOR UPDATE", [id, leaseToken, revision],
    );
    if (!report.rows[0]) return false;
    const counts = await client.query<{ daily: string; report: string }>(
      `SELECT count(*) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily,
       count(*) FILTER(WHERE report_id=$1) AS report FROM qa_analysis_attempts`, [id],
    );
    if (Number(counts.rows[0].daily) >= dailyLimit || Number(counts.rows[0].report) >= reportLimit) return false;
    const result = await client.query(
      "INSERT INTO qa_analysis_attempts(id,report_id,revision,lease_token) SELECT $4,$1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM qa_analysis_attempts WHERE report_id=$1 AND revision=$2 AND result IS NOT NULL)", [id, revision, leaseToken, randomUUID()],
    );
    return result.rowCount === 1;
  });
}

export async function getCachedAnalysis(id: string, revision: number): Promise<FinishReportInput | null> {
  const { rows } = await qaPool.query<{ result: FinishReportInput | null }>("SELECT result FROM qa_analysis_attempts WHERE report_id=$1 AND revision=$2 AND result IS NOT NULL LIMIT 1", [id, revision]);
  return rows[0]?.result ?? null;
}

export async function saveAnalysisResult(id: string, leaseToken: string, revision: number, input: FinishReportInput): Promise<boolean> {
  const result = await qaPool.query(
    `UPDATE qa_analysis_attempts a SET result=$4 FROM qa_reports r
     WHERE a.id=(SELECT id FROM qa_analysis_attempts WHERE report_id=$1 AND revision=$3 AND lease_token=$2 AND result IS NULL ORDER BY created_at DESC,id LIMIT 1)
     AND r.id=a.report_id AND r.revision=$3 AND r.lease_token=$2 AND r.status='processing' AND r.lease_expires_at>now()
     AND NOT EXISTS(SELECT 1 FROM qa_analysis_attempts WHERE report_id=$1 AND revision=$3 AND result IS NOT NULL)`,
    [id, leaseToken, revision, JSON.stringify(input)],
  );
  return result.rowCount === 1;
}

export async function setJiraLink(id: string, leaseToken: string, link: { key: string; url: string }): Promise<boolean> {
  const result = await qaPool.query(
    `UPDATE qa_reports SET jira_key=$3,jira_url=$4,jira_creation_pending=false,updated_at=now()
     WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_expires_at>now()
     AND (jira_key IS NULL OR jira_key=$3)`, [id, leaseToken, link.key, link.url],
  );
  return result.rowCount === 1;
}

export async function finishReport(id: string, leaseToken: string, revision: number, input: FinishReportInput): Promise<boolean> {
  return transaction(async client => {
    const { rows } = await client.query<ReportRow>(
      "SELECT * FROM qa_reports WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_expires_at>now() FOR UPDATE", [id, leaseToken],
    );
    const row = rows[0];
    if (!row) return false;
    if (row.revision !== revision) {
      await client.query("UPDATE qa_reports SET status='queued',next_attempt_at=now(),lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=now() WHERE id=$1", [id]);
      return false;
    }
    await client.query(
      `INSERT INTO qa_report_messages(id,report_id,role,content,analyzed_revision)
       VALUES($1,$2,'assistant',$3,$4) ON CONFLICT(report_id,analyzed_revision) DO NOTHING`, [randomUUID(), id, input.content.slice(0, 24000), revision],
    );
    await client.query(
      `UPDATE qa_reports SET status='complete',assessment=$2,analyzed_revision=$3,source_evidence=$4,
       last_error=NULL,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=now() WHERE id=$1`,
      [id, input.assessment, revision, JSON.stringify(input.sourceEvidence ?? null)],
    );
    return true;
  });
}

export async function failReport(id: string, leaseToken: string, input: FailReportInput): Promise<boolean> {
  const delay = Math.max(5, Math.min(3600, Math.trunc(input.nextAttemptSeconds ?? 30)));
  return transaction(async client => {
    const { rows } = await client.query<ReportRow>(
      "SELECT * FROM qa_reports WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_expires_at>now() FOR UPDATE", [id, leaseToken],
    );
    if (!rows[0]) return false;
    if (input.expectedRevision !== undefined && rows[0].revision !== input.expectedRevision) {
      await client.query(
        "UPDATE qa_reports SET status='queued',next_attempt_at=now(),last_error=NULL,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=now() WHERE id=$1", [id],
      );
      return false;
    }
    await client.query(
      `UPDATE qa_reports SET status=CASE WHEN $2 AND attempts<3 THEN 'retrying' ELSE 'needs_configuration' END,
       last_error=$3,next_attempt_at=now()+make_interval(secs=>$4),lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=now() WHERE id=$1`,
      [id, input.retryable, input.safeMessage.slice(0, 500), delay],
    );
    return true;
  });
}
