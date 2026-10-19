/**
 * Month inputs (SCRUM-568, the company payroll's R3; plan §9 R3): revenue,
 * VAT, service charge and discount entry per branch and stream with its named
 * source, per-person inputs (days worked, units, KPIs, one-off rule amounts,
 * the contractor PND.3 basis), counts, and the prototype's
 * `overrideCompanyInput` with its audit — all against the park group's one
 * CompanyMonthInputs document for the month, kept whole.
 *
 * Every write takes a reason, runs in one transaction with the month row
 * locked, is checked by the engine's own `validateCompanyDocument`, and adds a
 * row to the append-only payroll_month_input_changes. Inputs of month M feed
 * month M's run and month M+1's service charge, so a locked or paid run of
 * either refuses the change.
 *
 * Revenue typed in (or read from a till report) is source "Manual", with the
 * reason naming where it came from: there is no live POS reader (that is the
 * follow-up "revenue reader" subtask), and nothing is labelled as synced from
 * a system it did not come from.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  branches,
  employees,
  payrollBranchDetailsVersions,
  payrollIncentiveRules,
  payrollMonthInputChanges,
  payrollMonthInputs,
  payrollMonthRuns,
  payrollProfileAllocations,
  payrollProfiles,
  payrollRevenueStreams,
  payrollRunVersions,
} from "@shared/schema";
import { PAYROLL_DISCOUNTS, type MonthInputChange, type MonthInputsView, type PayrollPersonRef } from "@shared/payroll-month";
import { db } from "../db";
import { getEmployeeDisplayName } from "../lib/employeeDisplayName";
import { PayrollRefusal, requireReason, type PayrollActor } from "./setup";
import { emptyMonthInputs, loadPayrollWorld, WorldRefusal } from "./world";
import { overrideCompanyInput, salesValue, sourceKey } from "./engine/company-sources";
import { validateCompanyDocument } from "./engine/company-validation";
import { money, previousMonth } from "./engine/company-math";
import { nextMonth } from "./engine/company-rewards";
import { systemClock } from "./engine/clock";
import type { CompanyMonthInputs, CompanyPayrollDocument, CompanyRevenue, RevenueCell } from "./engine/company-model";

type Tx = Parameters<Parameters<typeof db["transaction"]>[0]>[0];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function requireMonth(month: unknown): string {
  if (typeof month !== "string" || !MONTH.test(month)) throw new PayrollRefusal(400, "Choose a payroll month (YYYY-MM).");
  return month;
}

/** The engine's refusals are the prototype's words: a 400 the screen shows as is. */
export function engineRefusal(error: unknown): never {
  if (error instanceof PayrollRefusal) throw error;
  if (error instanceof WorldRefusal) throw new PayrollRefusal(error.status, error.message);
  throw new PayrollRefusal(400, error instanceof Error ? error.message : String(error));
}

/** Refuses when a run these inputs feed is locked or paid (R4 lands the lock; the guard is in place now). */
export async function assertMonthsOpen(tx: Tx | typeof db, tenantId: string, months: string[]) {
  const rows = await tx.select({ month: payrollMonthRuns.month, status: payrollRunVersions.status }).from(payrollMonthRuns)
    .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.runId, payrollMonthRuns.id), eq(payrollRunVersions.version, payrollMonthRuns.currentVersion)))
    .where(and(eq(payrollMonthRuns.tenantId, tenantId), inArray(payrollMonthRuns.month, months)));
  const locked = rows.find((r) => r.status === "locked" || r.status === "paid");
  if (locked) throw new PayrollRefusal(409, `The ${locked.month} payroll is locked. Reopen it first.`);
  return rows;
}

async function lockedMonths(tenantId: string, months: string[]): Promise<string[]> {
  const rows = await db.select({ month: payrollMonthRuns.month, status: payrollRunVersions.status }).from(payrollMonthRuns)
    .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.runId, payrollMonthRuns.id), eq(payrollRunVersions.version, payrollMonthRuns.currentVersion)))
    .where(and(eq(payrollMonthRuns.tenantId, tenantId), inArray(payrollMonthRuns.month, months)));
  return Array.from(new Set(rows.filter((r) => r.status === "locked" || r.status === "paid").map((r) => r.month))).sort();
}

/** The park group's payroll people (profiles) with their home branch at a date. */
export async function payrollPeople(tenantId: string, asOf: string): Promise<PayrollPersonRef[]> {
  const [rows, allocations] = await Promise.all([
    db.select({ profile: payrollProfiles, employee: employees }).from(payrollProfiles)
      .innerJoin(employees, and(eq(employees.id, payrollProfiles.employeeId), eq(employees.tenantId, tenantId)))
      .where(eq(payrollProfiles.tenantId, tenantId)),
    db.select({ profileId: payrollProfileAllocations.profileId, effectiveFrom: payrollProfileAllocations.effectiveFrom, homeBranchId: payrollProfileAllocations.homeBranchId })
      .from(payrollProfileAllocations).where(eq(payrollProfileAllocations.tenantId, tenantId)),
  ]);
  return rows.map(({ profile, employee }) => {
    const home = allocations.filter((x) => x.profileId === profile.id && String(x.effectiveFrom).slice(0, 10) <= asOf)
      .sort((x, y) => String(y.effectiveFrom).localeCompare(String(x.effectiveFrom)))[0]?.homeBranchId ?? null;
    return { id: employee.id, name: getEmployeeDisplayName(employee), jobTitle: profile.jobTitle, homeBranchId: home, workerType: profile.workerType };
  }).sort((x, y) => x.name.localeCompare(y.name));
}

export async function payrollBranches(tenantId: string) {
  const rows = await db.selectDistinct({ id: branches.id, name: branches.name }).from(branches)
    .innerJoin(payrollBranchDetailsVersions, and(eq(payrollBranchDetailsVersions.tenantId, tenantId), eq(payrollBranchDetailsVersions.branchId, branches.id)))
    .where(eq(branches.tenantId, tenantId)).orderBy(asc(branches.name));
  return rows;
}

export async function loadMonthInputsView(tenantId: string, monthValue: string): Promise<Omit<MonthInputsView, "canManage">> {
  const month = requireMonth(monthValue), prev = previousMonth(month);
  const [rows, streams, branchList, people, rules, changes, locked] = await Promise.all([
    db.select().from(payrollMonthInputs).where(and(eq(payrollMonthInputs.tenantId, tenantId), inArray(payrollMonthInputs.month, [month, prev]))),
    db.select().from(payrollRevenueStreams).where(eq(payrollRevenueStreams.tenantId, tenantId)).orderBy(asc(payrollRevenueStreams.label)),
    payrollBranches(tenantId),
    payrollPeople(tenantId, `${month}-28`),
    db.select({ id: payrollIncentiveRules.id, name: payrollIncentiveRules.name, kind: payrollIncentiveRules.kind }).from(payrollIncentiveRules)
      .where(eq(payrollIncentiveRules.tenantId, tenantId)).orderBy(asc(payrollIncentiveRules.name)),
    db.select().from(payrollMonthInputChanges).where(and(eq(payrollMonthInputChanges.tenantId, tenantId), inArray(payrollMonthInputChanges.month, [month, prev])))
      .orderBy(desc(payrollMonthInputChanges.createdAt)).limit(200),
    lockedMonths(tenantId, [prev, month, nextMonth(month)]),
  ]);
  const current = rows.find((r) => r.month === month), previous = rows.find((r) => r.month === prev);
  return {
    month, previousMonth: prev,
    inputs: (current?.inputs as CompanyMonthInputs | undefined) ?? null, previous: (previous?.inputs as CompanyMonthInputs | undefined) ?? null,
    revision: current?.revision ?? 0,
    streams: streams.map((s) => ({ id: s.id, key: s.key, label: s.label, archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null })),
    branches: branchList, people,
    manualRules: rules.filter((r) => r.kind === "manual").map((r) => ({ id: r.id, name: r.name })),
    locked,
    changes: changes.map((c): MonthInputChange => ({ id: c.id, key: c.key, priorValue: c.priorValue, newValue: c.newValue, sourceKind: c.sourceKind, reason: c.reason, who: c.actorName, at: c.createdAt.toISOString() })),
  };
}

/** The month row, made empty where missing, locked for this transaction. */
async function lockMonth(tx: Tx, tenantId: string, month: string, actor: PayrollActor) {
  await tx.insert(payrollMonthInputs).values({ tenantId, month, inputs: emptyMonthInputs(), revision: 0, updatedBy: actor.userId })
    .onConflictDoNothing();
  const [row] = await tx.select().from(payrollMonthInputs)
    .where(and(eq(payrollMonthInputs.tenantId, tenantId), eq(payrollMonthInputs.month, month))).limit(1).for("update");
  return row;
}

async function writeMonth(tx: Tx, tenantId: string, month: string, inputs: CompanyMonthInputs, revision: number, actor: PayrollActor,
  changes: { key: string; prior: unknown; next: unknown; source: string }[], reason: string) {
  const doc: CompanyPayrollDocument = { version: 1, servicePolicies: {}, incentives: [], months: { [month]: inputs }, runs: {}, snapshots: [], audit: [] };
  try { validateCompanyDocument(doc); } catch (e) { engineRefusal(e); }
  const [row] = await tx.update(payrollMonthInputs).set({ inputs, revision: revision + 1, updatedBy: actor.userId, updatedAt: new Date() })
    .where(and(eq(payrollMonthInputs.tenantId, tenantId), eq(payrollMonthInputs.month, month))).returning();
  if (changes.length) {
    await tx.insert(payrollMonthInputChanges).values(changes.map((c) => ({
      tenantId, month, key: c.key, priorValue: c.prior ?? null, newValue: c.next ?? null, sourceKind: c.source, reason, actorUserId: actor.userId, actorName: actor.name,
    })));
  }
  return { month, revision: row.revision, inputs: row.inputs as CompanyMonthInputs };
}

function readCell(raw: unknown, label: string): RevenueCell {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cell = { amount: c.amount, vat: c.vat ?? 0, serviceCharge: c.serviceCharge ?? 0 };
  if (![cell.amount, cell.vat, cell.serviceCharge].every((n) => finite(n) && n >= 0)) throw new PayrollRefusal(400, `${label}: gross, VAT and service charge must be amounts of zero or more.`);
  const out = { amount: money(cell.amount as number), vat: money(cell.vat as number), serviceCharge: money(cell.serviceCharge as number) };
  if (out.vat + out.serviceCharge > out.amount) throw new PayrollRefusal(400, `${label}: VAT and service charge cannot be more than the gross amount.`);
  return out;
}

/**
 * One branch's month of sales, whole: every stream's gross, VAT and service
 * charge, and the discount add-backs. Streams must be in the park group's
 * catalogue. Each stream is recorded with source "Manual" and the reason.
 */
export async function saveBranchRevenue(tenantId: string, actor: PayrollActor, monthValue: string, branchId: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  const rawStreams = (body.streams && typeof body.streams === "object" ? body.streams : null) as Record<string, unknown> | null;
  if (!rawStreams || !Object.keys(rawStreams).length) throw new PayrollRefusal(400, "Enter at least one sales stream.");
  const rawDiscounts = (body.discounts && typeof body.discounts === "object" ? body.discounts : {}) as Record<string, unknown>;
  return db.transaction(async (tx) => {
    const [branch] = await tx.select({ id: branches.id, name: branches.name }).from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId))).limit(1);
    if (!branch) throw new PayrollRefusal(404, "Branch not found");
    const catalogue = await tx.select({ key: payrollRevenueStreams.key }).from(payrollRevenueStreams)
      .where(and(eq(payrollRevenueStreams.tenantId, tenantId), isNull(payrollRevenueStreams.archivedAt)));
    const known = new Set(catalogue.map((s) => s.key));
    const streams: Record<string, RevenueCell> = {};
    for (const [key, cell] of Object.entries(rawStreams)) {
      if (!known.has(key)) throw new PayrollRefusal(400, `"${key}" is not one of this park group's revenue streams. Add it in setup first.`);
      streams[key] = readCell(cell, key);
    }
    const discounts: CompanyRevenue["discounts"] = {};
    for (const [key, value] of Object.entries(rawDiscounts)) {
      if (!(PAYROLL_DISCOUNTS as readonly string[]).includes(key)) throw new PayrollRefusal(400, `Unknown discount add-back: ${key}.`);
      if (value === null || value === undefined || value === "") continue;
      if (!finite(value) || value < 0) throw new PayrollRefusal(400, "Discount add-backs must be amounts of zero or more.");
      discounts[key as keyof CompanyRevenue["discounts"]] = money(value);
    }
    await assertMonthsOpen(tx, tenantId, [month, nextMonth(month)]);
    const row = await lockMonth(tx, tenantId, month, actor);
    if (body.revision !== undefined && body.revision !== row.revision) {
      throw new PayrollRefusal(409, "These inputs were changed by someone else since you opened them. Reload and make your change again.");
    }
    const inputs = structuredClone(row.inputs as CompanyMonthInputs);
    const before = inputs.revenue[branchId] ?? null;
    inputs.revenue[branchId] = { streams, discounts };
    inputs.sources ??= {};
    const at = systemClock.now().toISOString(), today = at.slice(0, 10);
    for (const key of Object.keys(inputs.sources)) if (key.startsWith(`sales:${branchId}:`)) delete inputs.sources[key];
    for (const [stream, cell] of Object.entries(streams)) {
      const net = money(cell.amount - cell.vat - cell.serviceCharge);
      inputs.sources[sourceKey.sales(branchId, stream)] = { kind: "Manual", original: net, current: net, syncedAt: today, who: actor.name, reason, at, overridden: false };
    }
    return writeMonth(tx, tenantId, month, inputs, row.revision, actor, [{ key: `revenue:${branchId}`, prior: before, next: inputs.revenue[branchId], source: "Manual" }], reason);
  });
}

/**
 * The prototype's `overrideCompanyInput` (company-sources.ts), for one key:
 * `sales:<branch>:<stream|total>`, `days:<person>`, `count:<key>`,
 * `units:<person>:<key>`, `kpi:<person>:<key>`. The first original value stays
 * recorded; the reason and editor go on the source and the log. Days worked
 * is the manual worked-days figure of plan §3 (0 to employed days).
 */
export async function overrideMonthInput(tenantId: string, actor: PayrollActor, monthValue: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!/^(sales|days|count|units|kpi):/.test(key)) throw new PayrollRefusal(400, "Unknown input.");
  if (!finite(body.value)) throw new PayrollRefusal(400, "Use a number of zero or more.");
  const value = body.value;
  const loaded = await loadPayrollWorld(tenantId, month).catch(engineRefusal);
  return db.transaction(async (tx) => {
    await assertMonthsOpen(tx, tenantId, [month, nextMonth(month)]);
    const row = await lockMonth(tx, tenantId, month, actor);
    const doc: CompanyPayrollDocument = { ...loaded.doc, months: { ...loaded.doc.months, [month]: structuredClone(row.inputs as CompanyMonthInputs) }, audit: [] };
    let next: CompanyPayrollDocument;
    try { next = overrideCompanyInput(loaded.world, doc, month, key, value, reason, actor.name, systemClock); } catch (e) { engineRefusal(e); }
    const source = next.months[month].sources?.[key];
    return writeMonth(tx, tenantId, month, next.months[month], row.revision, actor,
      [{ key, prior: currentValue(doc, month, key), next: value, source: source?.kind ?? "Manual" }], reason);
  });
}

/** The value a key holds before an override (for the log). */
function currentValue(doc: CompanyPayrollDocument, month: string, key: string): number | null {
  const [type, subject, inputKey] = key.split(":");
  const inputs = doc.months[month];
  if (type === "sales") return inputs?.revenue[subject] ? salesValue(doc, month, subject, inputKey === "total" ? undefined : inputKey) : null;
  if (type === "count") return inputs?.counts[subject] ?? null;
  if (type === "days") return inputs?.staff[subject]?.daysWorked ?? null;
  if (type === "units") return inputs?.staff[subject]?.units[inputKey] ?? null;
  return inputs?.staff[subject]?.kpis[inputKey] ?? null;
}

/**
 * One person's own month inputs that are not numbers from a system: the
 * contractor PND.3 basis, and the amount of a one-off ("manual") rule. A
 * one-off amount above zero needs a reason, as the prototype's check does.
 */
export async function saveStaffMonthInput(tenantId: string, actor: PayrollActor, monthValue: string, employeeId: string, body: Record<string, unknown>) {
  const month = requireMonth(monthValue);
  const reason = requireReason(body.reason);
  return db.transaction(async (tx) => {
    const [profile] = await tx.select({ id: payrollProfiles.id }).from(payrollProfiles)
      .innerJoin(employees, and(eq(employees.id, payrollProfiles.employeeId), eq(employees.tenantId, tenantId)))
      .where(and(eq(payrollProfiles.tenantId, tenantId), eq(payrollProfiles.employeeId, employeeId))).limit(1);
    if (!profile) throw new PayrollRefusal(404, "Payroll profile not found");
    await assertMonthsOpen(tx, tenantId, [month, nextMonth(month)]);
    const row = await lockMonth(tx, tenantId, month, actor);
    const inputs = structuredClone(row.inputs as CompanyMonthInputs);
    const person = inputs.staff[employeeId] ??= { units: {}, kpis: {}, bonuses: {} };
    const changes: { key: string; prior: unknown; next: unknown; source: string }[] = [];
    if ("pnd3Basis" in body) {
      const basis = body.pnd3Basis;
      if (basis !== null && basis !== "all-earnings" && basis !== "fee-only") throw new PayrollRefusal(400, "Invalid contractor PND.3 basis.");
      changes.push({ key: `pnd3Basis:${employeeId}`, prior: person.pnd3Basis ?? null, next: basis, source: "Manual" });
      if (basis === null) delete person.pnd3Basis; else person.pnd3Basis = basis;
    }
    if (body.bonus !== undefined) {
      const bonus = (body.bonus && typeof body.bonus === "object" ? body.bonus : {}) as Record<string, unknown>;
      const ruleId = typeof bonus.ruleId === "string" ? bonus.ruleId : "";
      const [rule] = await tx.select({ id: payrollIncentiveRules.id, kind: payrollIncentiveRules.kind }).from(payrollIncentiveRules)
        .where(and(eq(payrollIncentiveRules.tenantId, tenantId), sql`${payrollIncentiveRules.id}::text = ${ruleId}`)).limit(1);
      if (!rule || rule.kind !== "manual") throw new PayrollRefusal(400, "Choose a one-off rule.");
      if (bonus.amount === null) {
        changes.push({ key: `bonus:${employeeId}:${rule.id}`, prior: person.bonuses[rule.id] ?? null, next: null, source: "Manual" });
        delete person.bonuses[rule.id];
      } else {
        if (!finite(bonus.amount) || bonus.amount < 0) throw new PayrollRefusal(400, "Choose a rule, person and amount.");
        const entry = { amount: money(bonus.amount), reason };
        changes.push({ key: `bonus:${employeeId}:${rule.id}`, prior: person.bonuses[rule.id] ?? null, next: entry, source: "Manual" });
        person.bonuses[rule.id] = entry;
      }
    }
    if (!changes.length) throw new PayrollRefusal(400, "Nothing to change.");
    return writeMonth(tx, tenantId, month, inputs, row.revision, actor, changes, reason);
  });
}
