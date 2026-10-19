/**
 * What the month-end view shows of a run's lifecycle (SCRUM-569, R4): its
 * versions with who confirmed, locked and paid each, the current version's
 * overtime decisions and third-party approvals, the run audit, and the frozen
 * snapshot a locked or paid version is shown from.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { payrollRunOvertimeDecisions, payrollRunSnapshots, payrollRunThirdPartyApprovals, payrollRunVersions, users } from "@shared/schema";
import { db } from "../db";
import { listRunAudit, runAuditOut } from "./run-audit";

/** Versions, the current version's overtime decisions and third-party approvals, and the run audit, for the month-end view. */
export async function lifecycleView(tenantId: string, runId: string, versionId: string) {
  const [versions, snapshots, overtime, approvals, audit] = await Promise.all([
    db.select().from(payrollRunVersions).where(and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.runId, runId))).orderBy(desc(payrollRunVersions.version)),
    db.select({ id: payrollRunSnapshots.id, versionId: payrollRunSnapshots.runVersionId }).from(payrollRunSnapshots).where(and(eq(payrollRunSnapshots.tenantId, tenantId), eq(payrollRunSnapshots.runId, runId))),
    db.select().from(payrollRunOvertimeDecisions).where(and(eq(payrollRunOvertimeDecisions.tenantId, tenantId), eq(payrollRunOvertimeDecisions.runVersionId, versionId)))
      .orderBy(asc(payrollRunOvertimeDecisions.attendanceDayKey)),
    db.select().from(payrollRunThirdPartyApprovals).where(and(eq(payrollRunThirdPartyApprovals.tenantId, tenantId), eq(payrollRunThirdPartyApprovals.runVersionId, versionId))),
    listRunAudit(db, tenantId, runId),
  ]);
  const ids = Array.from(new Set(versions.flatMap((v) => [v.gmUserId, v.ownerUserId, v.paidBy]).filter((x): x is string => !!x)));
  const names = new Map((ids.length ? await db.select({ id: users.id, fullName: users.fullName, email: users.email }).from(users).where(inArray(users.id, ids)) : [])
    .map((u) => [u.id, u.fullName?.trim() || u.email || u.id]));
  const step = (userId: string | null, at: Date | null) => userId && at ? { name: names.get(userId) ?? userId, at: at.toISOString() } : null;
  return {
    versions: versions.map((v) => ({
      versionId: v.id, version: v.version, status: v.status, reopenReason: v.reopenReason, createdAt: v.createdAt.toISOString(),
      gm: step(v.gmUserId, v.gmAt), owner: step(v.ownerUserId, v.ownerAt), paid: step(v.paidBy, v.paidAt),
      snapshotId: snapshots.find((s) => s.versionId === v.id)?.id ?? null,
    })),
    overtime, approvals, audit: audit.map(runAuditOut),
  };
}

/** The frozen snapshot of a locked or paid version, as the preview shows it (the source engine is skipped entirely, as in the prototype). */
export async function frozenSnapshot(tenantId: string, versionId: string) {
  const [row] = await db.select({ id: payrollRunSnapshots.id, result: payrollRunSnapshots.result, calculation: payrollRunSnapshots.calculation,
    signature: payrollRunSnapshots.sourceSignature, names: sql<Record<string, string> | null>`${payrollRunSnapshots.world}->'world'->'costCentreNames'` })
    .from(payrollRunSnapshots).where(and(eq(payrollRunSnapshots.tenantId, tenantId), eq(payrollRunSnapshots.runVersionId, versionId))).limit(1);
  return row ?? null;
}
