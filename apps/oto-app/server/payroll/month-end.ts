/**
 * The month-end draft and its read-only preview (SCRUM-568, the company
 * payroll's R3; plan §2 "Adapt", §3, §9 R3). R3 holds a run's DRAFT version
 * and the inputs it takes; R4 (SCRUM-569, ./lifecycle.ts) adds GM confirm,
 * Owner lock, paid and reopen, overtime decisions and third-party approvals.
 *
 *   - A run is one per park group, paying entity and month, created as
 *     version 1 in draft with the entity's default pay day (the prototype's
 *     28th, now configuration; clamped to the month's last day).
 *   - Attendance reviews (confirm / override / excuse) go through the
 *     prototype's `recordAttendanceReview` on the fed day and are stored
 *     against the run version, never in time_entries: the source attendance
 *     never changes (model.ts:693).
 *   - Manual bonuses/deductions and component overrides are the prototype's
 *     CompanyManual / CompanyOverride, each with a reason.
 *   - The preview computes the whole month through the engine
 *     (`calculateCompanyEngine`) on the loaded world and returns the
 *     calculation with the server's sha256 source signature.
 *
 * Every run-input change is written to the run audit (./run-audit.ts,
 * append-only). R3 wrote them to the setup audit; those rows stay there.
 *
 * A run's inputs can change while its current version is a draft or GM
 * confirmed (the confirmation then goes stale and the Owner lock refuses
 * until the GM confirms again, as in the prototype); a locked or paid
 * version refuses with the prototype's words until the Owner reopens it.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  employees,
  payrollMonthRuns,
  payrollPayingEntities,
  payrollProfiles,
  payrollRunAttendanceReviews,
  payrollRunManualLines,
  payrollRunOverrides,
  payrollRunVersions,
} from "@shared/schema";
import type { MonthEndView, PreviewView, RunView } from "@shared/payroll-month";
import { db } from "../db";
import { PayrollRefusal, requireReason, type PayrollActor } from "./setup";
import { recordRunAudit } from "./run-audit";
import { frozenSnapshot, lifecycleView } from "./run-view";
import { engineRefusal, payrollPeople, requireMonth } from "./inputs";
import { loadPayrollWorld, sourceSignature, type RunRef } from "./world";
import { calculateCompanyEngine } from "./engine/company-calculations";
import { openCheckFixProblems, recordAttendanceReview } from "./engine/company-issue-review";
import { newCompanyDraft } from "./engine/company-workflow";
import { validateCompanyDocument } from "./engine/company-validation";
import { monthDays } from "./engine/company-math";
import { systemClock } from "./engine/clock";
import type { AttendanceReview, CompanyCalculation, CompanyResult } from "./engine/company-model";

export type Tx = Parameters<Parameters<typeof db["transaction"]>[0]>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const iso = (v: Date | string | null | undefined) => v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const runView = (r: RunRef | undefined | null): RunView | null => r ? { runId: r.runId, versionId: r.versionId, version: r.version, status: r.status, payDate: r.payDate,
  stage: r.stage, approvedSignature: r.approvedSignature ?? null, reopenReason: r.reopenReason ?? null } : null;

export async function entityOf(tx: Tx | typeof db, tenantId: string, entityId: string) {
  if (!UUID.test(entityId)) throw new PayrollRefusal(404, "Paying entity not found");
  const [entity] = await tx.select().from(payrollPayingEntities).where(and(eq(payrollPayingEntities.tenantId, tenantId), eq(payrollPayingEntities.id, entityId))).limit(1);
  if (!entity) throw new PayrollRefusal(404, "Paying entity not found");
  return entity;
}

/** The current version of this entity's run for the month, row-locked for the transaction. */
export async function currentVersion(tx: Tx, tenantId: string, entityId: string, month: string) {
  const [row] = await tx.select({ run: payrollMonthRuns, version: payrollRunVersions }).from(payrollMonthRuns)
    .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.runId, payrollMonthRuns.id), eq(payrollRunVersions.version, payrollMonthRuns.currentVersion)))
    .where(and(eq(payrollMonthRuns.tenantId, tenantId), eq(payrollMonthRuns.entityId, entityId), eq(payrollMonthRuns.month, month))).limit(1)
    .for("update", { of: [payrollMonthRuns, payrollRunVersions] });
  if (!row) throw new PayrollRefusal(409, "Start this month's run first.");
  return row;
}

/** The prototype's words when a frozen run is changed (payroll-company-month-end-demo-page mutateRun). */
export const LOCKED_RUN_REFUSAL = "This run is locked. The Owner must reopen it before changes.";

/** The current version, row-locked; refused when it is locked or paid (a draft or a GM-confirmed version takes changes). */
export async function editableVersion(tx: Tx, tenantId: string, entityId: string, month: string) {
  const row = await currentVersion(tx, tenantId, entityId, month);
  if (row.version.status !== "draft" && row.version.status !== "gm-confirmed") throw new PayrollRefusal(409, LOCKED_RUN_REFUSAL);
  return row;
}

export async function loadMonthEnd(tenantId: string, entityId: string, monthValue: string): Promise<Omit<MonthEndView, "canManage" | "canConfirm" | "canLock">> {
  const month = requireMonth(monthValue);
  const entity = await entityOf(db, tenantId, entityId);
  const [loaded, people] = await Promise.all([
    loadPayrollWorld(tenantId, month).catch(engineRefusal),
    payrollPeople(tenantId, `${month}-${String(monthDays(month)).padStart(2, "0")}`),
  ]);
  const run = loaded.runs.get(entity.id) ?? null;
  const draft = loaded.doc.runs[`${entity.id}:${month}`];
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const [manual, overrides, life] = run ? await Promise.all([
    db.select().from(payrollRunManualLines).where(and(eq(payrollRunManualLines.tenantId, tenantId), eq(payrollRunManualLines.runVersionId, run.versionId))).orderBy(asc(payrollRunManualLines.createdAt)),
    db.select().from(payrollRunOverrides).where(and(eq(payrollRunOverrides.tenantId, tenantId), eq(payrollRunOverrides.runVersionId, run.versionId))).orderBy(asc(payrollRunOverrides.createdAt)),
    lifecycleView(tenantId, run.runId, run.versionId),
  ]) : [[], [], null];
  const current = life?.versions.find((v) => v.versionId === run?.versionId);
  const view = runView(run);
  if (view && current) Object.assign(view, { gm: current.gm, owner: current.owner, paid: current.paid, snapshotId: current.snapshotId });
  return {
    entity: { id: entity.id, name: entity.name, defaultPayDay: entity.defaultPayDay }, month, run: view,
    overtime: (life?.overtime ?? []).map((o) => ({ dayKey: o.attendanceDayKey, employeeId: o.employeeId, name: nameOf.get(o.employeeId) ?? o.employeeId, exceptionIndex: o.exceptionIndex,
      outcome: o.outcome, employeeChoiceConfirmed: o.employeeChoiceConfirmed, reason: o.reason, who: o.actorName, at: o.createdAt.toISOString() })),
    thirdParty: (life?.approvals ?? []).map((a) => ({ employeeId: a.employeeId, name: nameOf.get(a.employeeId) ?? a.employeeId, reason: a.reason, who: a.actorName, at: a.updatedAt.toISOString(),
      current: draft?.thirdPartyApprovals?.[a.employeeId]?.signature === a.signature })),
    versions: life?.versions ?? [], audit: life?.audit ?? [],
    attendance: loaded.attendance.filter((d) => d.date.startsWith(month)).map((d) => ({
      ...d, name: nameOf.get(d.staffId) ?? d.staffId, review: draft?.attendance[d.id] ?? null,
    })),
    manual: manual.map((m) => ({ id: m.id, employeeId: m.employeeId, name: nameOf.get(m.employeeId) ?? m.employeeId, kind: m.kind, amount: Number(m.amount), reason: m.reason, who: m.actorName, at: m.createdAt.toISOString() })),
    overrides: overrides.map((o) => ({ id: o.id, employeeId: o.employeeId, name: nameOf.get(o.employeeId) ?? o.employeeId, component: o.component, amount: Number(o.amount), reason: o.reason, who: o.actorName, at: o.createdAt.toISOString() })),
    people, excluded: loaded.excluded, notes: loaded.notes,
  };
}

/** Version 1 in draft, with the entity's default pay day (or the date given). Idempotent: an existing run is returned. */
export async function startRun(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  return db.transaction(async (tx) => {
    const entity = await entityOf(tx, tenantId, entityId);
    if (entity.archivedAt) throw new PayrollRefusal(409, "This entity is archived.");
    const [existing] = await tx.select().from(payrollMonthRuns)
      .where(and(eq(payrollMonthRuns.tenantId, tenantId), eq(payrollMonthRuns.entityId, entity.id), eq(payrollMonthRuns.month, month))).limit(1);
    if (existing) return { runId: existing.id, month, payDate: iso(existing.payDate), version: existing.currentVersion, created: false };
    const fallback = `${month}-${String(Math.min(entity.defaultPayDay, monthDays(month))).padStart(2, "0")}`;
    const payDate = typeof body.payDate === "string" && body.payDate ? body.payDate : fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate) || Number.isNaN(Date.parse(payDate))) throw new PayrollRefusal(400, "Choose a valid pay date.");
    const draft = newCompanyDraft(entity.id, month);
    const [run] = await tx.insert(payrollMonthRuns).values({ tenantId, entityId: entity.id, month, currentVersion: 1, payDate, createdBy: actor.userId }).returning();
    const [version] = await tx.insert(payrollRunVersions).values({ tenantId, runId: run.id, version: 1, status: draft.status, stage: draft.stage, createdBy: actor.userId }).returning();
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: 1, action: "Started the run", subject: "run", subjectId: run.id,
      reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "Started the month's run",
      oldValue: null, newValue: { entityId: entity.id, month, version: 1, payDate } });
    return { runId: run.id, month, payDate, version: 1, created: true };
  });
}

/**
 * A run decision on one fed attendance day: confirm, override (both corrected
 * times) or excuse. The prototype's own check refuses a day of another month
 * or an override without both times; the day must be one the feed produced.
 */
export async function recordReview(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, dayKey: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  const action = body.action as AttendanceReview["action"];
  if (!["confirm", "override", "excuse"].includes(action)) throw new PayrollRefusal(400, "Choose confirm, override or excuse.");
  await entityOf(db, tenantId, entityId);
  const loaded = await loadPayrollWorld(tenantId, month).catch(engineRefusal);
  const day = loaded.world.attendance.find((d) => d.id === dayKey);
  if (!day) throw new PayrollRefusal(404, "Attendance day not found");
  const run = newCompanyDraft(entityId, month);
  try {
    recordAttendanceReview(run, day, action, reason, actor.name, typeof body.clockIn === "string" ? body.clockIn : undefined,
      typeof body.clockOut === "string" ? body.clockOut : undefined, systemClock);
  } catch (e) { engineRefusal(e); }
  const review = run.attendance[day.id];
  return db.transaction(async (tx) => {
    const { run, version } = await editableVersion(tx, tenantId, entityId, month);
    const [before] = await tx.select().from(payrollRunAttendanceReviews).where(and(eq(payrollRunAttendanceReviews.tenantId, tenantId),
      eq(payrollRunAttendanceReviews.runVersionId, version.id), eq(payrollRunAttendanceReviews.attendanceDayKey, day.id))).limit(1);
    const values = { action: review.action, clockIn: review.clockIn ?? null, clockOut: review.clockOut ?? null, reason: review.reason, actorUserId: actor.userId, actorName: actor.name };
    if (before) {
      await tx.update(payrollRunAttendanceReviews).set({ ...values, updatedAt: new Date() }).where(and(eq(payrollRunAttendanceReviews.tenantId, tenantId), eq(payrollRunAttendanceReviews.id, before.id)));
    } else {
      await tx.insert(payrollRunAttendanceReviews).values({ tenantId, runVersionId: version.id, attendanceDayKey: day.id, employeeId: day.staffId, ...values });
    }
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: "Attendance decision", subject: "attendance", subjectId: day.id, reason,
      oldValue: before ? { action: before.action, clockIn: before.clockIn, clockOut: before.clockOut } : null, newValue: { action: review.action, clockIn: review.clockIn ?? null, clockOut: review.clockOut ?? null, version: version.version } });
    return { dayKey: day.id, ...values, version: version.version };
  });
}

async function payrollEmployee(tx: Tx, tenantId: string, employeeId: string) {
  const [row] = await tx.select({ id: employees.id }).from(payrollProfiles)
    .innerJoin(employees, and(eq(employees.id, payrollProfiles.employeeId), eq(employees.tenantId, tenantId)))
    .where(and(eq(payrollProfiles.tenantId, tenantId), eq(payrollProfiles.employeeId, employeeId))).limit(1);
  if (!row) throw new PayrollRefusal(404, "Payroll profile not found");
  return row.id;
}

/** A one-off bonus or deduction (CompanyManual): a positive amount and a reason. */
export async function addManualLine(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  if (body.kind !== "bonus" && body.kind !== "deduction") throw new PayrollRefusal(400, "Choose a bonus or a deduction.");
  if (!finite(body.amount) || body.amount <= 0) throw new PayrollRefusal(400, "Choose a person and an amount above zero.");
  const kind = body.kind, amount = Math.round(body.amount * 100) / 100;
  await entityOf(db, tenantId, entityId);
  return db.transaction(async (tx) => {
    const employeeId = await payrollEmployee(tx, tenantId, String(body.employeeId ?? ""));
    const { run, version } = await editableVersion(tx, tenantId, entityId, month);
    const [row] = await tx.insert(payrollRunManualLines).values({ tenantId, runVersionId: version.id, employeeId, kind, amount: String(amount), reason, actorUserId: actor.userId, actorName: actor.name }).returning();
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: `Added a one-off ${kind}`, subject: "manual", subjectId: row.id, reason, oldValue: null, newValue: { employeeId, kind, amount } });
    return { id: row.id, employeeId, kind, amount, reason };
  });
}

export async function removeManualLine(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, id: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  await entityOf(db, tenantId, entityId);
  return db.transaction(async (tx) => {
    const { run, version } = await editableVersion(tx, tenantId, entityId, month);
    const [row] = await tx.select().from(payrollRunManualLines).where(and(eq(payrollRunManualLines.tenantId, tenantId),
      eq(payrollRunManualLines.runVersionId, version.id), sql`${payrollRunManualLines.id}::text = ${id}`)).limit(1);
    if (!row) throw new PayrollRefusal(404, "Manual line not found");
    await tx.delete(payrollRunManualLines).where(and(eq(payrollRunManualLines.tenantId, tenantId), eq(payrollRunManualLines.id, row.id)));
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: `Removed a one-off ${row.kind}`, subject: "manual", subjectId: row.id, reason,
      oldValue: { employeeId: row.employeeId, kind: row.kind, amount: Number(row.amount), reason: row.reason }, newValue: null });
    return { id: row.id, removed: true };
  });
}

/** CompanyOverride: one component of one person's pay at this entity set to an amount, with a reason. */
export async function addOverride(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  const component = typeof body.component === "string" ? body.component.trim() : "";
  if (!/^[a-z][a-z0-9:-]{0,80}$/i.test(component)) throw new PayrollRefusal(400, "Choose the pay component to override.");
  if (!finite(body.amount) || body.amount < 0) throw new PayrollRefusal(400, "Overrides and manual adjustments require a non-negative amount and a reason.");
  const amount = Math.round(body.amount * 100) / 100;
  const entity = await entityOf(db, tenantId, entityId);
  return db.transaction(async (tx) => {
    const employeeId = await payrollEmployee(tx, tenantId, String(body.employeeId ?? ""));
    const { run, version } = await editableVersion(tx, tenantId, entityId, month);
    const [row] = await tx.insert(payrollRunOverrides).values({ tenantId, runVersionId: version.id, employeeId, entityId: entity.id, component, amount: String(amount), reason, actorUserId: actor.userId, actorName: actor.name }).returning();
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: "Added an override", subject: "override", subjectId: row.id, reason, oldValue: null, newValue: { employeeId, component, amount } });
    return { id: row.id, employeeId, component, amount, reason };
  });
}

export async function removeOverride(tenantId: string, actor: PayrollActor, entityId: string, monthValue: string, id: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  await entityOf(db, tenantId, entityId);
  return db.transaction(async (tx) => {
    const { run, version } = await editableVersion(tx, tenantId, entityId, month);
    const [row] = await tx.select().from(payrollRunOverrides).where(and(eq(payrollRunOverrides.tenantId, tenantId),
      eq(payrollRunOverrides.runVersionId, version.id), sql`${payrollRunOverrides.id}::text = ${id}`)).limit(1);
    if (!row) throw new PayrollRefusal(404, "Override not found");
    await tx.delete(payrollRunOverrides).where(and(eq(payrollRunOverrides.tenantId, tenantId), eq(payrollRunOverrides.id, row.id)));
    await recordRunAudit(tx, tenantId, actor, { runId: run.id, versionId: version.id, version: version.version, action: "Removed an override", subject: "override", subjectId: row.id, reason,
      oldValue: { employeeId: row.employeeId, component: row.component, amount: Number(row.amount), reason: row.reason }, newValue: null });
    return { id: row.id, removed: true };
  });
}

/**
 * The full month through the engine, read-only: `CompanyCalculation` for
 * every entity, this entity's result, the server signature, and how long the
 * load and the calculation took (plan §10's size rule is measured here).
 */
export async function previewMonth(tenantId: string, entityId: string, monthValue: string): Promise<PreviewView> {
  const month = requireMonth(monthValue);
  const entity = await entityOf(db, tenantId, entityId);
  const started = performance.now();
  const loaded = await loadPayrollWorld(tenantId, month).catch(engineRefusal);
  const loadedAt = performance.now();
  const ref = loaded.runs.get(entity.id);
  const signature = sourceSignature(loaded);
  // A locked or paid version shows its frozen snapshot: the source engine is skipped entirely, as in the prototype.
  const frozen = ref && (ref.status === "locked" || ref.status === "paid") ? await frozenSnapshot(tenantId, ref.versionId) : null;
  let calculation: CompanyCalculation;
  let result: CompanyResult | null;
  if (frozen) {
    calculation = frozen.calculation as CompanyCalculation;
    result = frozen.result as CompanyResult;
  } else {
    try {
      validateCompanyDocument(loaded.doc);
      calculation = calculateCompanyEngine(loaded.world, loaded.doc, month);
    } catch (e) { engineRefusal(e); }
    result = calculation.entities.find((e) => e.entityId === entity.id) ?? null;
  }
  const calculatedAt = performance.now();
  return {
    month, entityId: entity.id, calculation, result,
    signature: frozen ? frozen.signature : signature, excluded: loaded.excluded, notes: loaded.notes, run: runView(ref),
    timing: { loadMs: Math.round(loadedAt - started), calculateMs: Math.round(calculatedAt - loadedAt), queries: loaded.queries },
    branchNames: frozen?.names ?? loaded.world.costCentreNames ?? {},
    frozen: !!frozen,
    stale: ref?.status === "gm-confirmed" && ref.approvedSignature !== signature,
    openProblems: result ? openCheckFixProblems(result, loaded.doc.runs[`${entity.id}:${month}`]) : 0,
  };
}
