/**
 * The company payroll's month-end lifecycle (SCRUM-569, R4; plan §1 "Frozen
 * snapshots" and "The source signature on the server", §2 "Adapt", §7, §9 R4).
 *
 * The prototype's company-workflow (approveCompanyRun, lockCompanyRun,
 * markCompanyPaid, reopenCompanyRun) runs here unchanged in its guards, their
 * order and their words, one database transaction per transition with the run
 * and its current version row-locked:
 *
 *   draft → (attendance, inputs, check & fix) → GM CONFIRM → OWNER LOCK → PAID
 *                                                     ↑                     │
 *                                                     └── REOPEN as N+1 ────┘
 *
 *   - GM confirm (payroll.confirm: admin, operator_admin, global_admin)
 *     records the server's source signature: sha256 over canonical JSON of
 *     every input the engine reads, plus ENGINE_REVISION. "Confirm anyway"
 *     lets open non-attendance problems through, as the prototype's screen
 *     does (company-approvals.tsx:41); attendance blockers never pass.
 *   - Owner lock (payroll.lock: operator_admin, global_admin) recomputes the
 *     signature inside the transaction — any input change or an engine deploy
 *     since the confirmation refuses with the prototype's words — then no
 *     blocking item, clean upload details and bank files plus cash equal to
 *     net. It writes the frozen snapshot (everything the engine read and its
 *     result), the pay lines and the output files (payslips, bank files, the
 *     cash list, reports), all unchangeable by trigger. Earlier locked
 *     versions of the month become `superseded` only now.
 *   - Mark paid (payroll.lock) checks the frozen files reconcile to net.
 *   - Reopen (payroll.lock) needs a reason and makes version N+1 a draft with
 *     the run's inputs copied ({...prior}, company-workflow.ts:64); version N
 *     and its snapshot stay exactly as they were.
 *
 * Every step is audited into the run audit and is safe to repeat: confirming
 * an unchanged confirmed run, locking a locked one, paying a paid one and
 * reopening the version already reopened answer with the state as it is.
 *
 * Owner ruling 2026-10-20 (plan, open decision 3): company runs do not credit
 * the OT bank. A Bank decision is stored and takes the hours out of pay, as
 * the prototype does; the bank itself reads only the older per-branch
 * snapshots, which company runs never write, so it earns nothing from them.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  payrollMonthRuns,
  payrollOutputFiles,
  payrollRunAttendanceReviews,
  payrollRunLines,
  payrollRunManualLines,
  payrollRunOverrides,
  payrollRunOvertimeDecisions,
  payrollRunSnapshots,
  payrollRunThirdPartyApprovals,
  payrollRunVersions,
  users,
} from "@shared/schema";
import type { OutputsManifest } from "@shared/payroll-month";
import { db } from "../db";
import { PayrollRefusal, requireReason, type PayrollActor } from "./setup";
import { requireMonth } from "./inputs";
import { currentVersion, editableVersion, entityOf, type Tx } from "./month-end";
import { listRunAudit, recordRunAudit, runAuditOut } from "./run-audit";
import { loadPayrollWorld, sourceSignature, WorldRefusal, type LoadedWorld } from "./world";
import { approveCompanyRun, lockCompanyRun, markCompanyPaid, reopenCompanyRun } from "./engine/company-workflow";
import { calculateCompanyEngine } from "./engine/company-calculations";
import { thirdPartyApprovalSignature } from "./engine/company-issue-review";
import { effectiveRulesForMonth } from "./engine/calculations";
import { assertOtBankAwardsWithinMaximum, overtimeBankLotId, overtimePolicyForRole, roundedOvertimeHours } from "./engine/ot-bank";
import { previousMonth } from "./engine/company-math";
import { uploadFileBytes } from "./engine/company-upload-files";
import { validateCompanyDocument } from "./engine/company-validation";
import { ENGINE_REVISION } from "./engine/revision";
import { systemClock, type PayrollClock } from "./engine/clock";
import type { CompanyOutputs, CompanyPayrollDocument, CompanyResult, CompanySnapshot } from "./engine/company-model";
import type { OvertimeDecision, PayrollWorld } from "./engine/model";

/** Options the checks use: a fixed clock, and an engine revision other than the deployed one (an engine deploy between confirm and lock). */
export interface LifecycleOptions { clock?: PayrollClock; engineRevision?: string }

/** A transition the prototype refuses: its words, as a conflict with the run's state. */
function transitionRefusal(error: unknown): never {
  if (error instanceof PayrollRefusal) throw error;
  if (error instanceof WorldRefusal) throw new PayrollRefusal(error.status, error.message);
  throw new PayrollRefusal(409, error instanceof Error ? error.message : String(error));
}

const signer = (revision: string) => (data: PayrollWorld, doc: CompanyPayrollDocument, month: string) => sourceSignature({ world: data, doc, month }, revision);
const key = (entityId: string, month: string) => `${entityId}:${month}`;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function userName(tx: Tx, userId: string | null): Promise<string> {
  if (!userId) return "";
  const [u] = await tx.select({ fullName: users.fullName, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.fullName?.trim() || u?.email || userId;
}

async function loadWorld(tenantId: string, month: string): Promise<LoadedWorld> {
  return loadPayrollWorld(tenantId, month).catch(transitionRefusal);
}

// ─── GM confirm ──────────────────────────────────────────────────────────────

export async function confirmRun(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, body: Record<string, unknown>, options: LifecycleOptions = {}) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  const entity = await entityOf(db, tenantId, entityId);
  const revision = options.engineRevision ?? ENGINE_REVISION;
  return db.transaction(async (tx) => {
    const { run, version } = await currentVersion(tx, tenantId, entity.id, month);
    const loaded = await loadWorld(tenantId, month);
    const signature = sourceSignature(loaded, revision);
    if (version.status === "gm-confirmed" && version.approvedSignature === signature) {
      return { status: version.status, version: version.version, signature, unchanged: true };
    }
    let doc: CompanyPayrollDocument;
    try {
      doc = approveCompanyRun(loaded.world, loaded.doc, entity.id, month, actor.name, { reason, allowOpenProblems: body.confirmAnyway === true },
        options.clock ?? systemClock, { signature: signer(revision) });
    } catch (e) { transitionRefusal(e); }
    const draft = doc.runs[key(entity.id, month)];
    const entry = draft.audit.at(-1)!;
    const at = new Date(entry.at);
    await tx.update(payrollRunVersions).set({ status: "gm-confirmed", stage: "approvals", approvedSignature: draft.approvedSignature!, gmUserId: actor.userId, gmAt: at })
      .where(and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.id, version.id)));
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: entry.action, reason: entry.reason,
      subject: "lifecycle", oldValue: { status: version.status, approvedSignature: version.approvedSignature }, newValue: { status: "gm-confirmed", approvedSignature: draft.approvedSignature } });
    return { status: "gm-confirmed", version: version.version, signature: draft.approvedSignature!, unchanged: false };
  });
}

// ─── Owner lock ──────────────────────────────────────────────────────────────

/** The prototype's CompanyOutputs without the file bodies: what the snapshot row keeps. */
export function outputsManifest(outputs: CompanyOutputs): OutputsManifest {
  return {
    banks: outputs.banks.map((b) => ({ account: { id: b.account.id, label: b.account.label, bank: b.account.bank, fileFormat: b.account.fileFormat }, filename: b.filename, amount: b.amount, transfers: b.transfers })),
    cashAmount: outputs.cashAmount, net: outputs.net, bankAmount: outputs.bankAmount, difference: outputs.difference, note: outputs.note,
    uploadIssues: outputs.uploadIssues ?? [], uploadBankAmount: outputs.uploadBankAmount ?? 0, uploadDifference: outputs.uploadDifference ?? 0,
    reports: Object.keys(outputs.reports), payslips: Object.keys(outputs.payslips),
  };
}

interface FileToWrite { employeeId: string | null; group: string; filename: string; mime: string; encoding: "utf8" | "base64"; content: string; rows: number; total: number }

/** Every file of the lock: one payslip per person, each bank file, the cash list, reports and the upload files (not the payslips zip: the payslips are each stored). */
export function outputFiles(outputs: CompanyOutputs, result: CompanyResult, entityId: string, month: string): FileToWrite[] {
  const base = `${entityId}-${month}`;
  const files: FileToWrite[] = [];
  const seen = new Set<string>();
  const add = (f: FileToWrite) => { if (seen.has(f.filename)) return; seen.add(f.filename); files.push(f); };
  for (const [employeeId, html] of Object.entries(outputs.payslips)) {
    add({ employeeId, group: "Payslips", filename: `${base}-${employeeId}-payslip.html`, mime: "text/html", encoding: "utf8", content: html, rows: 1,
      total: result.people.find((p) => p.id === employeeId)?.net ?? 0 });
  }
  for (const b of outputs.banks) add({ employeeId: null, group: "Bank files", filename: b.filename, mime: "text/csv", encoding: "utf8", content: b.csv, rows: b.transfers.length, total: b.amount });
  add({ employeeId: null, group: "Reports", filename: `${base}-cash-signature-list.html`, mime: "text/html", encoding: "utf8", content: outputs.cashHtml, rows: 0, total: outputs.cashAmount });
  for (const [name, content] of Object.entries(outputs.reports)) add({ employeeId: null, group: "Reports", filename: `${base}-${name}`, mime: "text/csv", encoding: "utf8", content, rows: 0, total: 0 });
  for (const f of outputs.downloadFiles ?? []) {
    if (f.group === "Payslips") continue;
    add({ employeeId: null, group: f.group, filename: f.filename, mime: f.mime, encoding: f.encoding, content: f.content, rows: f.rows, total: f.total });
  }
  return files;
}

export async function lockRun(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, body: Record<string, unknown>, options: LifecycleOptions = {}) {
  const month = requireMonth(monthValue);
  const note = requireReason(body.reason);
  const entity = await entityOf(db, tenantId, entityId);
  const revision = options.engineRevision ?? ENGINE_REVISION;
  return db.transaction(async (tx) => {
    const { run, version } = await currentVersion(tx, tenantId, entity.id, month);
    if (version.status === "locked" || version.status === "paid") {
      const [frozen] = await tx.select({ id: payrollRunSnapshots.id }).from(payrollRunSnapshots)
        .where(and(eq(payrollRunSnapshots.tenantId, tenantId), eq(payrollRunSnapshots.runVersionId, version.id))).limit(1);
      return { status: version.status, version: version.version, snapshotId: frozen?.id ?? null, unchanged: true };
    }
    const loaded = await loadWorld(tenantId, month);
    const gmName = await userName(tx, version.gmUserId);
    const k = key(entity.id, month);
    if (loaded.doc.runs[k] && gmName) loaded.doc.runs[k].gmActor = gmName;
    const before = structuredClone(loaded.doc);
    let doc: CompanyPayrollDocument;
    try {
      doc = lockCompanyRun(loaded.world, loaded.doc, entity.id, month, actor.name, options.clock ?? systemClock,
        { signature: signer(revision), sameReviewer: !!version.gmUserId && version.gmUserId === actor.userId });
    } catch (e) { transitionRefusal(e); }
    const snapshot = doc.snapshots.at(-1) as CompanySnapshot;
    const entry = doc.runs[k].audit.at(-1)!;
    const lockedAt = new Date(snapshot.lockedAt);
    const signature = sourceSignature(loaded, revision);
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: entry.action,
      reason: `${entry.reason} Note: ${note}`, subject: "lifecycle", oldValue: { status: version.status }, newValue: { status: "locked", sourceSignature: signature } });
    const audit = (await listRunAudit(tx, tenantId, run.id)).filter((a) => a.runVersionId === version.id).map(runAuditOut);
    const { companyPayroll: _doc, ...worldOnly } = loaded.world;
    const prev = previousMonth(month);
    const [row] = await tx.insert(payrollRunSnapshots).values({
      tenantId, runId: run.id, runVersionId: version.id, entityId: entity.id, month, version: version.version,
      result: snapshot.result, calculation: snapshot.calculation, outputsManifest: outputsManifest(snapshot.outputs), audit,
      rewardConfig: snapshot.rewardConfig ?? {}, inputSnapshot: { [prev]: before.months[prev] ?? null, [month]: before.months[month] ?? null },
      world: { world: worldOnly, doc: before, excluded: loaded.excluded, notes: loaded.notes },
      engineRevision: revision, sourceSignature: signature, lockedAt, lockedBy: actor.userId, lockedByName: actor.name,
      gmUserId: version.gmUserId, gmActor: snapshot.gmActor || gmName,
    }).returning({ id: payrollRunSnapshots.id });
    const lines = snapshot.result.people.flatMap((p) => p.lines.map((l) => ({
      tenantId, snapshotId: row.id, runVersionId: version.id, entityId: entity.id, month, employeeId: p.id, lineKey: l.id, component: l.component,
      label: l.label, category: l.category, amount: String(l.amount), allocations: l.allocations, taxable: l.taxable, ssoWage: l.ssoWage,
    })));
    for (let i = 0; i < lines.length; i += 1000) await tx.insert(payrollRunLines).values(lines.slice(i, i + 1000));
    const files = outputFiles(snapshot.outputs, snapshot.result, entity.id, month).map((f) => {
      const bytes = uploadFileBytes({ ...f, group: "Reports", preview: { headers: [], rows: [] } });
      return { tenantId, snapshotId: row.id, runVersionId: version.id, employeeId: f.employeeId, fileGroup: f.group, filename: f.filename, mime: f.mime,
        encoding: f.encoding, content: f.content, objectKey: null, sha256: sha256(bytes), bytes: bytes.length, rows: f.rows, total: String(Math.round(f.total * 100) / 100) };
    });
    for (let i = 0; i < files.length; i += 200) await tx.insert(payrollOutputFiles).values(files.slice(i, i + 200));
    // Only now does an earlier locked version of the month stop being the one in force.
    await tx.update(payrollRunVersions).set({ status: "superseded" }).where(and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.runId, run.id),
      lt(payrollRunVersions.version, version.version), inArray(payrollRunVersions.status, ["locked", "paid"])));
    await tx.update(payrollRunVersions).set({ status: "locked", stage: "outputs", ownerUserId: actor.userId, ownerAt: lockedAt })
      .where(and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.id, version.id)));
    return { status: "locked", version: version.version, snapshotId: row.id, lines: lines.length, files: files.length, unchanged: false };
  });
}

// ─── Mark paid ───────────────────────────────────────────────────────────────

export async function markPaid(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, body: Record<string, unknown>, options: LifecycleOptions = {}) {
  const month = requireMonth(monthValue);
  const note = requireReason(body.reason);
  const entity = await entityOf(db, tenantId, entityId);
  return db.transaction(async (tx) => {
    const { run, version } = await currentVersion(tx, tenantId, entity.id, month);
    if (version.status === "paid") return { status: "paid", version: version.version, unchanged: true };
    const [frozen] = await tx.select({ result: payrollRunSnapshots.result, manifest: payrollRunSnapshots.outputsManifest }).from(payrollRunSnapshots)
      .where(and(eq(payrollRunSnapshots.tenantId, tenantId), eq(payrollRunSnapshots.runVersionId, version.id))).limit(1);
    const doc = {
      version: 1, servicePolicies: {}, incentives: [], months: {}, audit: [],
      runs: { [key(entity.id, month)]: { entityId: entity.id, month, version: version.version, status: version.status, stage: version.stage, attendance: {}, overrides: [], manual: [], audit: [] } },
      snapshots: frozen ? [{ entityId: entity.id, month, version: version.version, result: frozen.result, outputs: frozen.manifest }] : [],
    } as unknown as CompanyPayrollDocument;
    let next: CompanyPayrollDocument;
    try { next = markCompanyPaid(doc, entity.id, month, actor.name, options.clock ?? systemClock); } catch (e) { transitionRefusal(e); }
    const entry = next.runs[key(entity.id, month)].audit.at(-1)!;
    await tx.update(payrollRunVersions).set({ status: "paid", paidBy: actor.userId, paidAt: new Date(entry.at) })
      .where(and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.id, version.id)));
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: entry.action,
      reason: `${entry.reason} Note: ${note}`, subject: "lifecycle", oldValue: { status: version.status }, newValue: { status: "paid" } });
    return { status: "paid", version: version.version, unchanged: false };
  });
}

// ─── Reopen ──────────────────────────────────────────────────────────────────

export async function reopenRun(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, body: Record<string, unknown>, options: LifecycleOptions = {}) {
  const month = requireMonth(monthValue);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const entity = await entityOf(db, tenantId, entityId);
  return db.transaction(async (tx) => {
    const { run, version } = await currentVersion(tx, tenantId, entity.id, month);
    // Repeating the reopen of version N (it already made N+1) answers with N+1 as it is.
    if (typeof body.fromVersion === "number" && version.version === body.fromVersion + 1 && version.status === "draft" && version.reopenReason) {
      return { status: version.status, version: version.version, unchanged: true };
    }
    const doc = {
      version: 1, servicePolicies: {}, incentives: [], months: {}, audit: [], snapshots: [],
      runs: { [key(entity.id, month)]: { entityId: entity.id, month, version: version.version, status: version.status, stage: version.stage, attendance: {}, overrides: [], manual: [], audit: [] } },
    } as unknown as CompanyPayrollDocument;
    let next: CompanyPayrollDocument;
    try { next = reopenCompanyRun(doc, entity.id, month, actor.name, reason, options.clock ?? systemClock); } catch (e) { transitionRefusal(e); }
    const entry = next.runs[key(entity.id, month)].audit.at(-1)!;
    const number = version.version + 1;
    const [created] = await tx.insert(payrollRunVersions).values({ tenantId, runId: run.id, version: number, status: "draft", stage: "attendance", reopenReason: reason, createdBy: actor.userId }).returning();
    await tx.update(payrollMonthRuns).set({ currentVersion: number, updatedAt: new Date() }).where(and(eq(payrollMonthRuns.tenantId, tenantId), eq(payrollMonthRuns.id, run.id)));
    await copyRunInputs(tx, tenantId, version.id, created.id);
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: created.id, version: number, action: entry.action, reason: entry.reason,
      subject: "lifecycle", oldValue: { version: version.version, status: version.status }, newValue: { version: number, status: "draft" } });
    return { status: "draft", version: number, unchanged: false };
  });
}

/** The prototype's `{...prior}`: the new version starts with every decision and adjustment of the one it reopens. */
async function copyRunInputs(tx: Tx, tenantId: string, from: string, to: string) {
  const moved = <T extends { id: string; runVersionId: string }>(rows: T[]) => rows.map(({ id: _id, ...rest }) => ({ ...rest, runVersionId: to }));
  const reviews = await tx.select().from(payrollRunAttendanceReviews).where(and(eq(payrollRunAttendanceReviews.tenantId, tenantId), eq(payrollRunAttendanceReviews.runVersionId, from)));
  if (reviews.length) await tx.insert(payrollRunAttendanceReviews).values(moved(reviews));
  const overrides = await tx.select().from(payrollRunOverrides).where(and(eq(payrollRunOverrides.tenantId, tenantId), eq(payrollRunOverrides.runVersionId, from)));
  if (overrides.length) await tx.insert(payrollRunOverrides).values(moved(overrides));
  const manual = await tx.select().from(payrollRunManualLines).where(and(eq(payrollRunManualLines.tenantId, tenantId), eq(payrollRunManualLines.runVersionId, from)));
  if (manual.length) await tx.insert(payrollRunManualLines).values(moved(manual));
  const overtime = await tx.select().from(payrollRunOvertimeDecisions).where(and(eq(payrollRunOvertimeDecisions.tenantId, tenantId), eq(payrollRunOvertimeDecisions.runVersionId, from)));
  if (overtime.length) await tx.insert(payrollRunOvertimeDecisions).values(moved(overtime));
  const approvals = await tx.select().from(payrollRunThirdPartyApprovals).where(and(eq(payrollRunThirdPartyApprovals.tenantId, tenantId), eq(payrollRunThirdPartyApprovals.runVersionId, from)));
  if (approvals.length) await tx.insert(payrollRunThirdPartyApprovals).values(moved(approvals));
}

// ─── Overtime decisions ──────────────────────────────────────────────────────

/**
 * Pay, Bank or Reject one overtime occurrence (the prototype's
 * "resolve-overtime", context.tsx): the occurrence must be the day's own
 * overtime exception (or -1 for a positive-hours day without one), it may
 * be decided once, an ineligible person's overtime can only be rejected, the
 * policy's handling mode decides what is allowed, an employee's own choice
 * must be recorded first under "employee chooses", and banking may not take
 * the bank past its maximum.
 */
export async function recordOvertimeDecision(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, dayKey: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  const outcome = body.outcome as OvertimeDecision["outcome"];
  if (!["Pay", "Bank", "Reject"].includes(outcome)) throw new PayrollRefusal(400, "Choose Pay, Bank or Reject.");
  const entity = await entityOf(db, tenantId, entityId);
  const loaded = await loadWorld(tenantId, month);
  const day = loaded.world.attendance.find((d) => d.id === dayKey && d.date.startsWith(`${month}-`));
  const actualExceptionIndex = day?.exceptions.findIndex((e) => e.kind === "overtime") ?? -1;
  const exceptionIndex = body.exceptionIndex === undefined ? actualExceptionIndex : body.exceptionIndex;
  if (typeof exceptionIndex !== "number" || !Number.isInteger(exceptionIndex) || exceptionIndex < -1) throw new PayrollRefusal(400, "Overtime exception index is invalid.");
  const identity = `${dayKey}:${exceptionIndex}`;
  const synthetic = exceptionIndex === -1 && !!day && day.overtimeHours > 0 && actualExceptionIndex < 0;
  const actual = exceptionIndex >= 0 && exceptionIndex === actualExceptionIndex;
  if (!day || day.overtimeHours <= 0 || (!synthetic && !actual)) {
    throw new PayrollRefusal(404, `Overtime occurrence ${identity} was not found in the selected run. Use -1 only when a positive-hours day has no overtime exception.`);
  }
  const branch = loaded.world.branches[day.branchId];
  const staff = branch?.staff.find((s) => s.id === day.staffId);
  if (!branch || !staff) throw new PayrollRefusal(404, `Overtime occurrence ${identity} has no employee in the selected run.`);
  const rules = effectiveRulesForMonth(branch, month);
  const eligible = staff.otEligible && !!rules.overtimeEligibilityByRole[staff.role];
  if (!eligible && outcome !== "Reject") throw new PayrollRefusal(409, `Ineligible overtime occurrence ${identity} can only be rejected.`);
  const policy = overtimePolicyForRole(rules.overtimePolicy, staff.role);
  const allowed = outcome === "Reject" || (eligible && (policy.handlingMode === "manager-decides" || policy.handlingMode === "employee-chooses" ||
    (policy.handlingMode === "pay-only" && outcome === "Pay") || (policy.handlingMode === "time-off-only" && outcome === "Bank")));
  if (!allowed) throw new PayrollRefusal(409, `${outcome} is not allowed by the ${policy.handlingMode} overtime policy.`);
  const choice = body.employeeChoiceConfirmed === true;
  if (eligible && policy.handlingMode === "employee-chooses" && outcome !== "Reject" && !choice) throw new PayrollRefusal(409, "Record the employee's choice before selecting Pay or Bank.");
  if (outcome === "Bank") {
    const decided = loaded.world.runDrafts[`${branch.id}:${month}`]?.overtimeDecisions ?? [];
    const awards = [...decided.filter((d) => d.outcome === "Bank"), { attendanceId: day.id, exceptionIndex }].flatMap((d) => {
      const banked = loaded.world.attendance.find((a) => a.id === d.attendanceId);
      if (!banked || banked.staffId !== staff.id) return [];
      const hours = roundedOvertimeHours(banked.overtimeHours, policy) * policy.bankConversionRate;
      return hours > 0 ? [{ id: overtimeBankLotId(branch.id, month, banked.id, d.exceptionIndex), date: banked.date, hours, expiryMonths: policy.bankExpiryMonths, expiryAction: policy.bankExpiryAction }] : [];
    });
    try { assertOtBankAwardsWithinMaximum(loaded.world, branch.id, staff.id, policy.bankMaximumHours, awards); } catch (e) { transitionRefusal(e); }
  }
  return db.transaction(async (tx) => {
    const { run, version } = await editableVersion(tx, tenantId, entity.id, month);
    const [existing] = await tx.select({ id: payrollRunOvertimeDecisions.id }).from(payrollRunOvertimeDecisions).where(and(eq(payrollRunOvertimeDecisions.tenantId, tenantId),
      eq(payrollRunOvertimeDecisions.runVersionId, version.id), eq(payrollRunOvertimeDecisions.attendanceDayKey, day.id), eq(payrollRunOvertimeDecisions.exceptionIndex, exceptionIndex))).limit(1);
    if (existing) throw new PayrollRefusal(409, `Overtime exception ${identity} already has an outcome.`);
    await tx.insert(payrollRunOvertimeDecisions).values({ tenantId, runVersionId: version.id, attendanceDayKey: day.id, employeeId: staff.id, exceptionIndex, outcome,
      employeeChoiceConfirmed: choice, reason, actorUserId: actor.userId, actorName: actor.name });
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: `Overtime: ${outcome}`, subject: "overtime", subjectId: identity, reason,
      oldValue: null, newValue: { outcome, hours: day.overtimeHours, employeeChoiceConfirmed: choice } });
    return { dayKey: day.id, exceptionIndex, outcome, version: version.version,
      ...(outcome === "Bank" ? { note: "Banked hours are taken out of this month's pay. Until the park rules how company runs credit the OT bank, they earn no bank balance either." } : {}) };
  });
}

export async function removeOvertimeDecision(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, dayKey: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  const entity = await entityOf(db, tenantId, entityId);
  const exceptionIndex = typeof body.exceptionIndex === "number" ? body.exceptionIndex : null;
  return db.transaction(async (tx) => {
    const { run, version } = await editableVersion(tx, tenantId, entity.id, month);
    const rows = await tx.select().from(payrollRunOvertimeDecisions).where(and(eq(payrollRunOvertimeDecisions.tenantId, tenantId),
      eq(payrollRunOvertimeDecisions.runVersionId, version.id), eq(payrollRunOvertimeDecisions.attendanceDayKey, dayKey)));
    const row = rows.find((r) => exceptionIndex === null || r.exceptionIndex === exceptionIndex);
    if (!row) throw new PayrollRefusal(404, "Overtime decision not found");
    await tx.delete(payrollRunOvertimeDecisions).where(and(eq(payrollRunOvertimeDecisions.tenantId, tenantId), eq(payrollRunOvertimeDecisions.id, row.id)));
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: "Overtime decision removed", subject: "overtime",
      subjectId: `${dayKey}:${row.exceptionIndex}`, reason, oldValue: { outcome: row.outcome, reason: row.reason }, newValue: null });
    return { dayKey, exceptionIndex: row.exceptionIndex, removed: true };
  });
}

// ─── Payments to someone else ────────────────────────────────────────────────

/**
 * Approve a person's payment to someone else for exactly the payment details
 * it has now (thirdPartyApprovalSignature); a later change of bank, reason,
 * amount or account makes the item need review again, as in the prototype.
 */
export async function approveThirdParty(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, employeeId: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  const entity = await entityOf(db, tenantId, entityId);
  const loaded = await loadWorld(tenantId, month);
  let person;
  try {
    validateCompanyDocument(loaded.doc);
    person = calculateCompanyEngine(loaded.world, loaded.doc, month).entities.find((e) => e.entityId === entity.id)?.people.find((p) => p.id === employeeId);
  } catch (e) { transitionRefusal(e); }
  if (!person) throw new PayrollRefusal(404, "This person is not paid by this company this month.");
  if (!person.payments.some((p) => p.method === "third-party")) throw new PayrollRefusal(409, `${person.name} has no payment to someone else to approve.`);
  const signature = thirdPartyApprovalSignature(person);
  return db.transaction(async (tx) => {
    const { run, version } = await editableVersion(tx, tenantId, entity.id, month);
    const [before] = await tx.select().from(payrollRunThirdPartyApprovals).where(and(eq(payrollRunThirdPartyApprovals.tenantId, tenantId),
      eq(payrollRunThirdPartyApprovals.runVersionId, version.id), eq(payrollRunThirdPartyApprovals.employeeId, person.id))).limit(1);
    if (before && before.signature === signature) return { employeeId: person.id, approved: true, unchanged: true };
    if (before) {
      await tx.update(payrollRunThirdPartyApprovals).set({ signature, reason, actorUserId: actor.userId, actorName: actor.name, updatedAt: new Date() })
        .where(and(eq(payrollRunThirdPartyApprovals.tenantId, tenantId), eq(payrollRunThirdPartyApprovals.id, before.id)));
    } else {
      await tx.insert(payrollRunThirdPartyApprovals).values({ tenantId, runVersionId: version.id, employeeId: person.id, signature, reason, actorUserId: actor.userId, actorName: actor.name });
    }
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: "Approved a payment to someone else", subject: "third-party",
      subjectId: person.id, reason, oldValue: before ? { reason: before.reason } : null, newValue: { payments: person.payments.filter((p) => p.method === "third-party").map((p) => ({ amount: p.amount, payee: p.bank.accountName })) } });
    return { employeeId: person.id, approved: true, unchanged: false };
  });
}
