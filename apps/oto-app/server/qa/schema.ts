import { sql } from "drizzle-orm";
import { bigserial, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, users } from "../../shared/schema";

export const qaReports = pgTable("qa_reports", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientRequestId: uuid("client_request_id").notNull(), requestHash: text("request_hash").notNull(),
  title: text("title").notNull(), context: jsonb("context").notNull(),
  status: text("status").notNull().default("draft"), assessment: text("assessment").notNull().default("reported"),
  revision: integer("revision").notNull().default(1), analyzedRevision: integer("analyzed_revision").notNull().default(0),
  attempts: integer("attempts").notNull().default(0), jiraKey: text("jira_key"), jiraUrl: text("jira_url"),
  jiraCreationPending: boolean("jira_creation_pending").notNull().default(false), sourceEvidence: jsonb("source_evidence"),
  lastError: text("last_error"), workerId: text("worker_id"), leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("qa_reports_request_unique").on(table.tenantId, table.userId, table.clientRequestId),
  index("qa_reports_owner_created_idx").on(table.tenantId, table.userId, table.createdAt),
  index("qa_reports_queue_idx").on(table.status, table.nextAttemptAt, table.updatedAt),
  check("qa_reports_status_check", sql`${table.status} IN ('draft','queued','processing','complete','retrying','needs_configuration')`),
  check("qa_reports_assessment_check", sql`${table.assessment} IN ('reported','code_supported','guidance','needs_investigation','related_report')`),
  check("qa_reports_revision_check", sql`${table.revision}>0 AND ${table.analyzedRevision}>=0 AND ${table.analyzedRevision}<=${table.revision} AND ${table.attempts}>=0`),
  check("qa_reports_lease_check", sql`((${table.status}='processing') AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.workerId} IS NOT NULL) OR ((${table.status}<>'processing') AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.workerId} IS NULL)`),
]);

export const qaReportMessages = pgTable("qa_report_messages", {
  id: uuid("id").primaryKey(), reportId: uuid("report_id").notNull().references(() => qaReports.id, { onDelete: "cascade" }),
  sequence: bigserial("sequence", { mode: "number" }).notNull(), role: text("role").notNull(), content: text("content").notNull(),
  clientRequestId: uuid("client_request_id"), analyzedRevision: integer("analyzed_revision"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("qa_report_messages_request_unique").on(table.reportId, table.clientRequestId),
  uniqueIndex("qa_report_messages_revision_unique").on(table.reportId, table.analyzedRevision),
  check("qa_report_messages_role_check", sql`${table.role} IN ('user','assistant')`),
  check("qa_report_messages_content_check", sql`length(${table.content}) BETWEEN 1 AND 24000`),
  check("qa_report_messages_kind_check", sql`(${table.role}='user' AND ${table.clientRequestId} IS NOT NULL AND ${table.analyzedRevision} IS NULL) OR (${table.role}='assistant' AND ${table.clientRequestId} IS NULL AND ${table.analyzedRevision}>0)`),
]);

export const qaReportAttachments = pgTable("qa_report_attachments", {
  id: uuid("id").primaryKey(), reportId: uuid("report_id").notNull().references(() => qaReports.id, { onDelete: "cascade" }),
  name: text("name").notNull(), contentType: text("content_type").notNull(), size: integer("size").notNull(),
  objectKey: text("object_key").notNull(), sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("qa_report_attachments_object_unique").on(table.objectKey),
  index("qa_report_attachments_report_idx").on(table.reportId),
  check("qa_report_attachments_size_check", sql`${table.size}>0 AND ${table.size}<=26214400`),
  check("qa_report_attachments_type_check", sql`${table.contentType} IN ('image/png','image/jpeg','image/webp','video/mp4','video/webm')`),
  check("qa_report_attachments_sha_check", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
]);

export const qaAnalysisAttempts = pgTable("qa_analysis_attempts", {
  id: uuid("id").primaryKey(),
  reportId: uuid("report_id").notNull().references(() => qaReports.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(), leaseToken: uuid("lease_token").notNull(), result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("qa_analysis_attempts_result_unique").on(table.reportId, table.revision).where(sql`${table.result} IS NOT NULL`),
  index("qa_analysis_attempts_created_idx").on(table.createdAt),
  check("qa_analysis_attempts_revision_check", sql`${table.revision}>0`),
]);
