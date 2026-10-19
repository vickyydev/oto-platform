/**
 * The run audit (SCRUM-569, the company payroll's R4; plan §1 `payroll_run_audit`):
 * every run-input change and every transition of a run version, append-only
 * (migration 0025's trigger refuses UPDATE and DELETE). It replaces R3's stopgap
 * of writing run-input changes into the setup audit; those R3-era rows stay
 * where they were written (payroll_profile_changes, subject "run…").
 */
import { and, asc, eq } from "drizzle-orm";
import { payrollRunAudit, type PayrollRunAuditRow } from "@shared/schema";
import type { RunAuditEntryView } from "@shared/payroll-month";
import { db } from "../db";
import type { PayrollActor } from "./setup";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface RunAuditEntry {
  runId: string; versionId: string; version: number;
  action: string; reason: string;
  subject?: string | null; subjectId?: string | null;
  oldValue?: unknown; newValue?: unknown;
}

/** One row of the run audit, in the caller's transaction. */
export async function recordRunAudit(tx: Tx | Db, tenantId: string, actor: PayrollActor, entry: RunAuditEntry): Promise<void> {
  await tx.insert(payrollRunAudit).values({
    tenantId, runId: entry.runId, runVersionId: entry.versionId, version: entry.version,
    action: entry.action, reason: entry.reason, subject: entry.subject ?? null, subjectId: entry.subjectId ?? null,
    oldValue: entry.oldValue ?? null, newValue: entry.newValue ?? null,
    actorUserId: actor.userId, actorName: actor.name,
  });
}

export const runAuditOut = (row: PayrollRunAuditRow): RunAuditEntryView => ({
  id: row.id, version: row.version, action: row.action, subject: row.subject, subjectId: row.subjectId, reason: row.reason,
  oldValue: row.oldValue ?? null, newValue: row.newValue ?? null, who: row.actorName, at: row.at.toISOString(),
});

/** The whole run's audit, every version, oldest first. */
export async function listRunAudit(tx: Tx | Db, tenantId: string, runId: string): Promise<PayrollRunAuditRow[]> {
  return tx.select().from(payrollRunAudit).where(and(eq(payrollRunAudit.tenantId, tenantId), eq(payrollRunAudit.runId, runId)))
    .orderBy(asc(payrollRunAudit.at), asc(payrollRunAudit.id));
}
