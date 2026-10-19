/**
 * Payroll history and payslips (SCRUM-569, the company payroll's R4; plan §7,
 * §9 R4, §10 "The salary boundary" and "PDPA").
 *
 * Everything here reads LOCKED versions only: a snapshot exists only for a
 * version the Owner locked, and its payslips and files are rows written at
 * that lock and never changed (migration 0025's trigger). A payslip is the
 * prototype's companyPayslipHtml, rendered at lock from the frozen result and
 * served as those exact bytes, checked against the sha256 recorded with them.
 *
 *   - Payroll roles (hr.view_salary) see every locked version, its frozen
 *     result, its audit and its files; each file they open — another
 *     person's payslip included — is written to the run audit.
 *   - Everyone signed in sees THEIR OWN payslips only (the employee linked to
 *     their account, in their park group), only from a locked or paid
 *     version still in force. Anyone else's payslip, or one of another park
 *     group, is a 404: its existence is not confirmed.
 *
 * Payslips are served as private HTML (sandboxed, never cached) and print to
 * PDF from the browser; the server's Puppeteer PDF and the object-storage move
 * are R5's (outputs and downloads), so no lock waits on a browser render.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { employees, payrollMonthRuns, payrollOutputFiles, payrollPayingEntities, payrollRunSnapshots, payrollRunVersions, type PayrollOutputFileRow } from "@shared/schema";
import type { MyPayslipsView, OutputFileView, OutputsManifest, PayrollHistoryRow, PayrollHistoryVersionView, RunAuditEntryView } from "@shared/payroll-month";
import type { CompanyResult } from "./engine/company-model";
import { db } from "../db";
import { getEmployeeDisplayName } from "../lib/employeeDisplayName";
import { PayrollRefusal, type PayrollActor } from "./setup";
import { requireMonth } from "./inputs";
import { recordRunAudit } from "./run-audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => Number(v ?? 0);

const historyColumns = {
  snapshotId: payrollRunSnapshots.id, entityId: payrollRunSnapshots.entityId, entityName: payrollPayingEntities.name, month: payrollRunSnapshots.month,
  version: payrollRunSnapshots.version, status: payrollRunVersions.status, lockedAt: payrollRunSnapshots.lockedAt, lockedBy: payrollRunSnapshots.lockedByName,
  gmActor: payrollRunSnapshots.gmActor, runId: payrollRunSnapshots.runId, versionId: payrollRunSnapshots.runVersionId,
  people: sql<number>`jsonb_array_length(${payrollRunSnapshots.result}->'people')`,
  totals: sql<PayrollHistoryRow["totals"]>`${payrollRunSnapshots.result}->'totals'`,
};
type HistoryRowRaw = { snapshotId: string; entityId: string; entityName: string; month: string; version: number; status: string; lockedAt: Date; lockedBy: string; gmActor: string; people: number; totals: PayrollHistoryRow["totals"] };
const historyOut = (r: HistoryRowRaw): PayrollHistoryRow => ({
  snapshotId: r.snapshotId, entityId: r.entityId, entityName: r.entityName, month: r.month, version: r.version, status: r.status,
  lockedAt: r.lockedAt.toISOString(), lockedBy: r.lockedBy, gmActor: r.gmActor, people: num(r.people),
  totals: { gross: num(r.totals?.gross), deductions: num(r.totals?.deductions), net: num(r.totals?.net), employer: num(r.totals?.employer), totalCost: num(r.totals?.totalCost) },
});

/** Every locked version of the park group, newest month first. */
export async function listHistory(tenantId: string): Promise<PayrollHistoryRow[]> {
  const rows = await db.select(historyColumns).from(payrollRunSnapshots)
    .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.id, payrollRunSnapshots.runVersionId)))
    .innerJoin(payrollPayingEntities, and(eq(payrollPayingEntities.tenantId, tenantId), eq(payrollPayingEntities.id, payrollRunSnapshots.entityId)))
    .where(eq(payrollRunSnapshots.tenantId, tenantId))
    .orderBy(desc(payrollRunSnapshots.month), asc(payrollPayingEntities.name), desc(payrollRunSnapshots.version));
  return rows.map(historyOut);
}

const fileOut = (f: Pick<PayrollOutputFileRow, "id" | "fileGroup" | "filename" | "mime" | "employeeId" | "bytes" | "rows" | "total" | "sha256">, names: Map<string, string>): OutputFileView => ({
  id: f.id, group: f.fileGroup, filename: f.filename, mime: f.mime, employeeId: f.employeeId, name: f.employeeId ? names.get(f.employeeId) ?? null : null,
  bytes: f.bytes, rows: f.rows, total: num(f.total), sha256: f.sha256,
});

/** One locked version: its frozen result, what its outputs held, its audit at lock and its files (no file bodies). */
export async function loadHistoryVersion(tenantId: string, entityId: string, monthValue: string, versionValue: string): Promise<PayrollHistoryVersionView> {
  const month = requireMonth(monthValue);
  const version = Number(versionValue);
  if (!UUID.test(entityId) || !Number.isInteger(version) || version < 1) throw new PayrollRefusal(404, "Locked payroll not found");
  const [row] = await db.select({ ...historyColumns, result: payrollRunSnapshots.result, manifest: payrollRunSnapshots.outputsManifest, audit: payrollRunSnapshots.audit,
    sourceSignature: payrollRunSnapshots.sourceSignature, engineRevision: payrollRunSnapshots.engineRevision })
    .from(payrollRunSnapshots)
    .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.id, payrollRunSnapshots.runVersionId)))
    .innerJoin(payrollPayingEntities, and(eq(payrollPayingEntities.tenantId, tenantId), eq(payrollPayingEntities.id, payrollRunSnapshots.entityId)))
    .where(and(eq(payrollRunSnapshots.tenantId, tenantId), eq(payrollRunSnapshots.entityId, entityId), eq(payrollRunSnapshots.month, month), eq(payrollRunSnapshots.version, version))).limit(1);
  if (!row) throw new PayrollRefusal(404, "Locked payroll not found");
  const files = await db.select({ id: payrollOutputFiles.id, fileGroup: payrollOutputFiles.fileGroup, filename: payrollOutputFiles.filename, mime: payrollOutputFiles.mime,
    employeeId: payrollOutputFiles.employeeId, bytes: payrollOutputFiles.bytes, rows: payrollOutputFiles.rows, total: payrollOutputFiles.total, sha256: payrollOutputFiles.sha256 })
    .from(payrollOutputFiles).where(and(eq(payrollOutputFiles.tenantId, tenantId), eq(payrollOutputFiles.snapshotId, row.snapshotId)))
    .orderBy(asc(payrollOutputFiles.fileGroup), asc(payrollOutputFiles.filename));
  const result = row.result as CompanyResult;
  const names = new Map(result.people.map((p) => [p.id, p.name]));
  return {
    ...historyOut(row), result, manifest: row.manifest as OutputsManifest, audit: row.audit as RunAuditEntryView[],
    files: files.map((f) => fileOut(f, names)), sourceSignature: row.sourceSignature, engineRevision: row.engineRevision,
  };
}

export interface ServedFile { filename: string; mime: string; body: Buffer }

function bodyOf(file: Pick<PayrollOutputFileRow, "content" | "encoding" | "sha256" | "filename">): Buffer {
  if (file.content == null) throw new PayrollRefusal(409, "This file is kept in storage that is not connected yet.");
  const body = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
  // The bytes are the ones frozen at lock: anything else is refused, never served.
  if (createHash("sha256").update(body).digest("hex") !== file.sha256) throw new PayrollRefusal(409, `${file.filename} does not match the copy frozen at lock.`);
  return body;
}

/** A payroll role opens any locked file; the opening is written to the run audit (another person's payslip included). */
export async function openHistoryFile(tenantId: string, actor: PayrollActor, fileId: string): Promise<ServedFile> {
  if (!UUID.test(fileId)) throw new PayrollRefusal(404, "File not found");
  const [row] = await db.select({ file: payrollOutputFiles, runId: payrollRunSnapshots.runId, version: payrollRunSnapshots.version })
    .from(payrollOutputFiles)
    .innerJoin(payrollRunSnapshots, and(eq(payrollRunSnapshots.tenantId, tenantId), eq(payrollRunSnapshots.id, payrollOutputFiles.snapshotId)))
    .where(and(eq(payrollOutputFiles.tenantId, tenantId), eq(payrollOutputFiles.id, fileId))).limit(1);
  if (!row) throw new PayrollRefusal(404, "File not found");
  const body = bodyOf(row.file);
  await recordRunAudit(db, tenantId, actor, { runId: row.runId, versionId: row.file.runVersionId, version: row.version,
    action: row.file.fileGroup === "Payslips" ? "Opened a payslip" : "Downloaded a file", subject: "file", subjectId: row.file.id,
    reason: `${row.file.filename} (${row.file.fileGroup})`, newValue: { employeeId: row.file.employeeId, sha256: row.file.sha256 } });
  return { filename: row.file.filename, mime: row.file.mime, body };
}

/** The employee linked to this account in this park group, or none. */
async function ownEmployee(tenantId: string, userId: string) {
  const [employee] = await db.select().from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.userId, userId))).limit(1);
  return employee ?? null;
}

/** Payslips of versions still in force (locked or paid), the caller's own only. */
function ownPayslipsQuery(tenantId: string, employeeId: string, fileId?: string) {
  return db.select({ file: payrollOutputFiles, entityName: payrollPayingEntities.name, month: payrollRunSnapshots.month, version: payrollRunSnapshots.version,
    status: payrollRunVersions.status, lockedAt: payrollRunSnapshots.lockedAt })
    .from(payrollOutputFiles)
    .innerJoin(payrollRunSnapshots, and(eq(payrollRunSnapshots.tenantId, tenantId), eq(payrollRunSnapshots.id, payrollOutputFiles.snapshotId)))
    .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.id, payrollOutputFiles.runVersionId)))
    .innerJoin(payrollMonthRuns, and(eq(payrollMonthRuns.tenantId, tenantId), eq(payrollMonthRuns.id, payrollRunSnapshots.runId)))
    .innerJoin(payrollPayingEntities, and(eq(payrollPayingEntities.tenantId, tenantId), eq(payrollPayingEntities.id, payrollRunSnapshots.entityId)))
    .where(and(eq(payrollOutputFiles.tenantId, tenantId), eq(payrollOutputFiles.employeeId, employeeId), eq(payrollOutputFiles.fileGroup, "Payslips"),
      inArray(payrollRunVersions.status, ["locked", "paid"]), fileId ? eq(payrollOutputFiles.id, fileId) : undefined));
}

export async function myPayslips(tenantId: string, userId: string): Promise<MyPayslipsView> {
  const employee = await ownEmployee(tenantId, userId);
  if (!employee) return { employee: null, payslips: [] };
  const rows = await ownPayslipsQuery(tenantId, employee.id).orderBy(desc(payrollRunSnapshots.month), asc(payrollPayingEntities.name));
  return {
    employee: { id: employee.id, name: getEmployeeDisplayName(employee) },
    payslips: rows.map((r) => ({ fileId: r.file.id, entityName: r.entityName, month: r.month, version: r.version, status: r.status, net: num(r.file.total), lockedAt: r.lockedAt.toISOString() })),
  };
}

/** One of the caller's own payslips; anything else answers 404. */
export async function openMyPayslip(tenantId: string, userId: string, fileId: string): Promise<ServedFile> {
  if (!UUID.test(fileId)) throw new PayrollRefusal(404, "Payslip not found");
  const employee = await ownEmployee(tenantId, userId);
  if (!employee) throw new PayrollRefusal(404, "Payslip not found");
  const [row] = await ownPayslipsQuery(tenantId, employee.id, fileId).limit(1);
  if (!row) throw new PayrollRefusal(404, "Payslip not found");
  return { filename: row.file.filename, mime: row.file.mime, body: bodyOf(row.file) };
}
