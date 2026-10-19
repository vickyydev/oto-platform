/**
 * Rewards setup (SCRUM-568, the company payroll's R3; plan §2 "Adapt" and §8):
 * service-charge policies per branch, incentive rules, their dated versions
 * and their dated assignments — the prototype's `saveServiceChange` and
 * `saveIncentiveChange` (engine/company-rewards.ts) run as written on the park
 * group's stored rows, and what they change is written back in one
 * transaction.
 *
 * Stored as configured, nothing invented: a policy keeps `groups` and
 * `exceptions` only when an administrator set them (the prototype's
 * "Everyone" group and job-title exclusions migration is not run); an
 * incentive's `partMonth` is stored exactly as entered and never defaulted to
 * "prorate" (plan, "What reading the code changed"). Recipients are dated
 * assignments to a person or to a job title (optionally limited to branches),
 * never staff ids inside the rule or an array index.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  branches,
  employees,
  payrollIncentiveAssignments,
  payrollIncentiveRuleVersions,
  payrollIncentiveRules,
  payrollMonthRuns,
  payrollProfileAdvances,
  payrollProfileAllocations,
  payrollProfileSeparatePayments,
  payrollProfiles,
  payrollRevenueStreams,
  payrollRunVersions,
  payrollServicePolicies,
} from "@shared/schema";
import { PAYROLL_DISCOUNTS, type RewardsView } from "@shared/payroll-month";
import { db } from "../db";
import { PayrollRefusal, recordChange, requireReason, type PayrollActor } from "./setup";
import { engineRefusal, payrollBranches, payrollPeople, requireMonth } from "./inputs";
import { parkToday } from "./world";
import { profileOut } from "./profiles";
import { allocationAt } from "./engine/payroll-profile";
import type { PayrollWorld, StaffMember } from "./engine/model";
import { saveIncentiveChange, saveServiceChange, type AssignmentSelection, type JobTitleSelection } from "./engine/company-rewards";
import { validateCompanyDocument } from "./engine/company-validation";
import { systemClock } from "./engine/clock";
import type { CompanyIncentive, CompanyIncentiveKind, CompanyPayrollDocument, IncentiveAssignment, IncentiveRuleVersion, ServicePolicy } from "./engine/company-model";

type Tx = Parameters<Parameters<typeof db["transaction"]>[0]>[0];
const iso = (v: Date | string | null | undefined) => v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const KINDS: CompanyIncentiveKind[] = ["revenue", "team-days", "unit-pool", "unit", "kpi", "guarantee", "manual"];
const BASES: ServicePolicy["basis"][] = ["calendar", "worked", "equal", "role-weight"];
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The reward rows as the engine's document: policies, rules, versions, assignments, and each month's run status. */
async function rewardDocument(tx: Tx | typeof db, tenantId: string): Promise<CompanyPayrollDocument> {
  const [policies, rules, versions, assignments, runs] = await Promise.all([
    tx.select().from(payrollServicePolicies).where(eq(payrollServicePolicies.tenantId, tenantId)).orderBy(asc(payrollServicePolicies.version)),
    tx.select().from(payrollIncentiveRules).where(eq(payrollIncentiveRules.tenantId, tenantId)),
    tx.select().from(payrollIncentiveRuleVersions).where(eq(payrollIncentiveRuleVersions.tenantId, tenantId)).orderBy(asc(payrollIncentiveRuleVersions.version)),
    tx.select().from(payrollIncentiveAssignments).where(eq(payrollIncentiveAssignments.tenantId, tenantId)).orderBy(asc(payrollIncentiveAssignments.at)),
    tx.select({ entityId: payrollMonthRuns.entityId, month: payrollMonthRuns.month, version: payrollRunVersions.version, status: payrollRunVersions.status }).from(payrollMonthRuns)
      .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.runId, payrollMonthRuns.id), eq(payrollRunVersions.version, payrollMonthRuns.currentVersion)))
      .where(eq(payrollMonthRuns.tenantId, tenantId)),
  ]);
  const servicePolicies: CompanyPayrollDocument["servicePolicies"] = {};
  for (const p of policies) (servicePolicies[p.branchId] ??= []).push({ ...(p.policy as ServicePolicy), effectiveFrom: iso(p.effectiveFrom), version: p.version,
    reason: p.reason, who: p.actorName, at: p.createdAt.toISOString(), ...(p.superseded ? { superseded: true } : {}) });
  return {
    version: 1, rewardsVersion: 1, servicePolicies,
    incentives: rules.map((r) => ({ ...(r.terms as CompanyIncentive), staffIds: (r.terms as Partial<CompanyIncentive>).staffIds ?? [], id: r.id, enabled: r.enabled })),
    incentiveVersions: versions.map((v): IncentiveRuleVersion => ({ ruleId: v.ruleId, version: v.version, terms: v.terms as CompanyIncentive, effectiveFrom: iso(v.effectiveFrom),
      effectiveTo: v.effectiveTo ? iso(v.effectiveTo) : null, who: v.actorName, reason: v.reason, at: v.at.toISOString(), ...(v.superseded ? { superseded: true } : {}) })),
    incentiveAssignments: assignments.map((a): IncentiveAssignment => ({ id: a.assignmentKey, ruleId: a.ruleId, staffId: a.employeeId ?? null,
      ...(a.jobTitle ? { jobTitle: a.jobTitle } : {}), ...(a.branches ? { branches: a.branches } : {}),
      effectiveFrom: iso(a.effectiveFrom), effectiveTo: a.effectiveTo ? iso(a.effectiveTo) : null,
      ...(a.personalRate != null ? { personalRate: Number(a.personalRate) } : {}), ...(a.excluded ? { excluded: true } : {}),
      who: a.actorName, reason: a.reason, at: a.at.toISOString(), ...(a.superseded ? { superseded: true } : {}) })),
    months: {}, snapshots: [], audit: [],
    runs: Object.fromEntries(runs.map((r) => [`${r.entityId}:${r.month}`, { entityId: r.entityId, month: r.month, version: r.version, stage: "attendance" as const,
      status: (r.status === "superseded" ? "draft" : r.status) as "draft", attendance: {}, overrides: [], manual: [], audit: [] }])),
  };
}

/**
 * The people the reward rules can name, for the engine's reward functions
 * (which read only branches' staff, profiles and job titles): every payroll
 * profile, placed in the home branch of its allocation at the date (else its
 * latest allocation). A profile with no allocation cannot be paid and is not
 * offered. Independent of any month's pay rules, so a rule can be dated
 * before or after the months a branch has payroll details for.
 */
async function rewardWorld(tenantId: string, date: string): Promise<PayrollWorld> {
  const rows = await db.select({ profile: payrollProfiles, employee: employees }).from(payrollProfiles)
    .innerJoin(employees, and(eq(employees.id, payrollProfiles.employeeId), eq(employees.tenantId, tenantId)))
    .where(eq(payrollProfiles.tenantId, tenantId)).orderBy(asc(payrollProfiles.employeeId));
  const ids = rows.map((r) => r.profile.id);
  const [allocs, advances, payments] = ids.length ? await Promise.all([
    db.select().from(payrollProfileAllocations).where(and(eq(payrollProfileAllocations.tenantId, tenantId), inArray(payrollProfileAllocations.profileId, ids))),
    db.select().from(payrollProfileAdvances).where(and(eq(payrollProfileAdvances.tenantId, tenantId), inArray(payrollProfileAdvances.profileId, ids))),
    db.select().from(payrollProfileSeparatePayments).where(and(eq(payrollProfileSeparatePayments.tenantId, tenantId), inArray(payrollProfileSeparatePayments.profileId, ids))),
  ]) : [[], [], []];
  const world = { schemaVersion: 14, branches: {} } as unknown as PayrollWorld;
  for (const { profile, employee } of rows) {
    const p = profileOut(profile, allocs, advances, payments);
    const home = (allocationAt(p, date) ?? p.allocations.at(-1))?.homeBranchId;
    if (!home || !p.joinedOn) continue;
    const branch = world.branches[home] ??= { id: home, staff: [] } as unknown as PayrollWorld["branches"][string];
    branch.staff.push({ id: employee.id, name: employee.fullName ?? employee.id, role: p.jobTitle, payrollProfile: p } as StaffMember);
  }
  return world;
}

export async function loadRewardsView(tenantId: string): Promise<Omit<RewardsView, "canManage">> {
  const [doc, branchList, streams, people] = await Promise.all([
    rewardDocument(db, tenantId), payrollBranches(tenantId),
    db.select().from(payrollRevenueStreams).where(eq(payrollRevenueStreams.tenantId, tenantId)).orderBy(asc(payrollRevenueStreams.label)),
    payrollPeople(tenantId, parkToday()),
  ]);
  return {
    branches: branchList, people,
    streams: streams.map((s) => ({ id: s.id, key: s.key, label: s.label, archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null })),
    policies: doc.servicePolicies as Record<string, ServicePolicy[]>, rules: doc.incentives,
    versions: doc.incentiveVersions ?? [], assignments: doc.incentiveAssignments ?? [],
  };
}

async function liveStreams(tx: Tx, tenantId: string) {
  const rows = await tx.select({ key: payrollRevenueStreams.key }).from(payrollRevenueStreams)
    .where(and(eq(payrollRevenueStreams.tenantId, tenantId), isNull(payrollRevenueStreams.archivedAt)));
  return new Set(rows.map((r) => r.key));
}
async function tenantBranchIds(tx: Tx, tenantId: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), inArray(branches.id, ids)));
  return new Set(rows.map((r) => r.id));
}
async function tenantEmployeeIds(tx: Tx, tenantId: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await tx.select({ id: employees.id }).from(employees).where(and(eq(employees.tenantId, tenantId), inArray(employees.id, ids)));
  return new Set(rows.map((r) => r.id));
}
const serialize = (tx: Tx, tenantId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:payroll-rewards`}))`);

/** A policy as configured: groups and exceptions only when set. */
function readPolicy(raw: unknown, streams: Set<string>): ServicePolicy {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!finite(p.percent) || p.percent < 0 || p.percent > 100) throw new PayrollRefusal(400, "The service-charge rate is a percent from 0 to 100.");
  if (!BASES.includes(p.basis as ServicePolicy["basis"])) throw new PayrollRefusal(400, "Choose how the pool is shared.");
  if (p.excluded !== "remove" && p.excluded !== "retain") throw new PayrollRefusal(400, "Choose what happens to the share of people who are not eligible.");
  if (!strings(p.streams) || !(p.streams as string[]).length) throw new PayrollRefusal(400, "Choose the sales streams the pool comes from.");
  for (const s of p.streams as string[]) if (!streams.has(s)) throw new PayrollRefusal(400, `"${s}" is not one of this park group's revenue streams.`);
  const addBack = p.addBack === undefined ? [] : p.addBack;
  if (!strings(addBack) || (addBack as string[]).some((d) => !(PAYROLL_DISCOUNTS as readonly string[]).includes(d))) throw new PayrollRefusal(400, "Unknown discount add-back.");
  const weights = (p.roleWeights && typeof p.roleWeights === "object" ? p.roleWeights : {}) as Record<string, unknown>;
  if (Object.values(weights).some((w) => !finite(w) || w < 0)) throw new PayrollRefusal(400, "Role weights must be numbers of zero or more.");
  const policy: ServicePolicy = { effectiveFrom: "", percent: p.percent, basis: p.basis as ServicePolicy["basis"], excluded: p.excluded,
    streams: [...(p.streams as string[])], addBack: [...(addBack as ServicePolicy["addBack"])], roleWeights: weights as Record<string, number> };
  if (Array.isArray(p.groups) && p.groups.length) policy.groups = structuredClone(p.groups) as ServicePolicy["groups"];
  if (Array.isArray(p.exceptions) && p.exceptions.length) policy.exceptions = structuredClone(p.exceptions) as ServicePolicy["exceptions"];
  return policy;
}

/**
 * A new service-charge policy version for a branch from a sales month
 * (the prototype's `saveServiceChange`): a same-month version is superseded,
 * never overwritten, and a month whose payout run is locked is refused.
 */
export async function saveServicePolicy(tenantId: string, actor: PayrollActor, branchId: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  const month = requireMonth(body.month);
  const world = await rewardWorld(tenantId, `${month}-01`);
  return db.transaction(async (tx) => {
    await serialize(tx, tenantId);
    if (!(await tenantBranchIds(tx, tenantId, [branchId])).has(branchId)) throw new PayrollRefusal(404, "Branch not found");
    const policy = readPolicy(body.policy, await liveStreams(tx, tenantId));
    const exceptionIds = (policy.exceptions ?? []).map((e) => e.staffId);
    const known = await tenantEmployeeIds(tx, tenantId, exceptionIds);
    if (exceptionIds.some((id) => !known.has(id))) throw new PayrollRefusal(400, "Check service-charge exceptions; use one entry per person.");
    const before = await rewardDocument(tx, tenantId);
    let doc: CompanyPayrollDocument;
    try {
      doc = saveServiceChange(world, before, branchId, policy, month, reason, actor.name, systemClock);
      validateCompanyDocument(doc);
    } catch (e) { engineRefusal(e); }
    const added = (doc.servicePolicies[branchId] ?? []).at(-1)!;
    const from = `${month}-01`;
    await tx.update(payrollServicePolicies).set({ superseded: true })
      .where(and(eq(payrollServicePolicies.tenantId, tenantId), eq(payrollServicePolicies.branchId, branchId), eq(payrollServicePolicies.effectiveFrom, from), eq(payrollServicePolicies.superseded, false)));
    const { effectiveFrom: _f, version: _v, who: _w, reason: _r, at: _a, superseded: _s, ...stored } = added;
    const [row] = await tx.insert(payrollServicePolicies).values({
      tenantId, branchId, version: added.version!, effectiveFrom: from, policy: stored, reason, actorUserId: actor.userId, actorName: actor.name,
    }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "service-policy", subjectId: row.id, reason,
      oldValue: (before.servicePolicies[branchId] ?? []).filter((p) => !p.superseded).at(-1) ?? null, newValue: { ...stored, effectiveFrom: from, version: row.version } });
    return { id: row.id, branchId, version: row.version, effectiveFrom: from, policy: stored };
  });
}

function readTerms(raw: unknown, id: string, streams: Set<string>, branchIds: Set<string>): CompanyIncentive {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof t.name === "string" ? t.name.trim().slice(0, 200) : "";
  if (!name) throw new PayrollRefusal(400, "Give the rule a name.");
  if (!KINDS.includes(t.kind as CompanyIncentiveKind)) throw new PayrollRefusal(400, "Choose the kind of reward.");
  const base = (t.base && typeof t.base === "object" ? t.base : {}) as Record<string, unknown>;
  const ruleBranches = strings(base.branches) ? base.branches as string[] : [];
  const ruleStreams = strings(base.streams) ? base.streams as string[] : [];
  const addBack = strings(base.addBack) ? base.addBack as string[] : [];
  for (const b of ruleBranches) if (!branchIds.has(b)) throw new PayrollRefusal(400, "Choose branches of this park group.");
  for (const s of ruleStreams) if (!streams.has(s)) throw new PayrollRefusal(400, `"${s}" is not one of this park group's revenue streams.`);
  if (addBack.some((d) => !(PAYROLL_DISCOUNTS as readonly string[]).includes(d))) throw new PayrollRefusal(400, "Unknown discount add-back.");
  const nullable = (v: unknown, label: string) => {
    if (v === null || v === undefined || v === "") return null;
    if (!finite(v) || v < 0) throw new PayrollRefusal(400, `${label} must be empty or an amount of zero or more.`);
    return v;
  };
  if (!finite(t.rate) || t.rate < 0) throw new PayrollRefusal(400, "The rate must be a number of zero or more.");
  const op = t.kpiOperator ?? "lt";
  if (!["lt", "lte", "gte", "gt"].includes(op as string)) throw new PayrollRefusal(400, "Choose how the KPI is compared.");
  const terms: CompanyIncentive = {
    id, name, kind: t.kind as CompanyIncentiveKind, staffIds: [],
    base: { branches: ruleBranches, streams: ruleStreams, addBack: addBack as CompanyIncentive["base"]["addBack"] },
    rate: t.rate, inputKey: typeof t.inputKey === "string" ? t.inputKey.trim().slice(0, 80) : "",
    target: nullable(t.target, "The target"), cap: nullable(t.cap, "The cap"),
    effectiveFrom: "", effectiveTo: null, kpiOperator: op as CompanyIncentive["kpiOperator"], kpiTarget: finite(t.kpiTarget) ? t.kpiTarget : 0,
    enabled: t.enabled !== false,
  };
  // Stored exactly as entered: never defaulted to "prorate" (plan, "What reading the code changed").
  if (t.partMonth === "prorate" || t.partMonth === "full") terms.partMonth = t.partMonth;
  else if (t.partMonth !== undefined && t.partMonth !== null) throw new PayrollRefusal(400, "Part months are prorated or paid in full.");
  if ((terms.kind === "unit-pool" || terms.kind === "unit" || terms.kind === "kpi") && !terms.inputKey) throw new PayrollRefusal(400, "Name the input this rule counts.");
  if ((terms.kind === "revenue" || terms.kind === "team-days") && (!ruleBranches.length || !ruleStreams.length)) throw new PayrollRefusal(400, "Choose the branches and sales streams this rule is based on.");
  return terms;
}

/**
 * Creates or changes an incentive (the prototype's `saveIncentiveChange`):
 * the terms become a new dated version (older versions end the day before),
 * each chosen person gets a dated assignment (with an optional personal rate
 * or a dated exclusion), and job-title recipients are dated title
 * assignments. Starting mid-month needs `splitDays`; otherwise the change
 * starts on the next open month, as the prototype rules.
 */
export async function saveIncentive(tenantId: string, actor: PayrollActor, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  const from = typeof body.from === "string" ? body.from : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new PayrollRefusal(400, "Choose a valid start date.");
  const rawTerms = (body.terms && typeof body.terms === "object" ? body.terms : {}) as Record<string, unknown>;
  const existingId = typeof rawTerms.id === "string" && rawTerms.id ? rawTerms.id : null;
  const selected: AssignmentSelection[] = (Array.isArray(body.selected) ? body.selected : []).map((s: Record<string, unknown>) => ({
    staffId: String(s?.staffId ?? ""), startDate: typeof s?.startDate === "string" ? s.startDate : from,
    endDate: typeof s?.endDate === "string" && s.endDate ? s.endDate : null,
    ...(finite(s?.personalRate) ? { personalRate: s.personalRate as number } : {}), ...(s?.excluded === true ? { excluded: true } : {}),
  }));
  const titles: JobTitleSelection[] = (Array.isArray(body.titles) ? body.titles : []).map((t: Record<string, unknown>) => ({
    jobTitle: typeof t?.jobTitle === "string" ? t.jobTitle.trim() : "", branches: strings(t?.branches) ? t.branches as string[] : [],
  }));
  if (titles.some((t) => !t.jobTitle)) throw new PayrollRefusal(400, "Name each job title.");
  const world = await rewardWorld(tenantId, from);
  return db.transaction(async (tx) => {
    await serialize(tx, tenantId);
    if (existingId) {
      const [rule] = await tx.select({ id: payrollIncentiveRules.id }).from(payrollIncentiveRules)
        .where(and(eq(payrollIncentiveRules.tenantId, tenantId), sql`${payrollIncentiveRules.id}::text = ${existingId}`)).limit(1);
      if (!rule) throw new PayrollRefusal(404, "Incentive rule not found");
    }
    const ruleId = existingId ?? randomUUID();
    const branchIds = new Set([...(strings((rawTerms.base as Record<string, unknown> | undefined)?.branches) ? (rawTerms.base as { branches: string[] }).branches : []), ...titles.flatMap((t) => t.branches)]);
    const ownBranches = await tenantBranchIds(tx, tenantId, Array.from(branchIds));
    if (titles.some((t) => t.branches.some((b) => !ownBranches.has(b)))) throw new PayrollRefusal(400, "Choose branches of this park group.");
    const terms = readTerms(rawTerms, ruleId, await liveStreams(tx, tenantId), ownBranches);
    const people = await tenantEmployeeIds(tx, tenantId, selected.map((s) => s.staffId));
    if (selected.some((s) => !people.has(s.staffId))) throw new PayrollRefusal(400, "Choose people of this park group.");
    const before = await rewardDocument(tx, tenantId);
    let doc: CompanyPayrollDocument;
    try {
      doc = saveIncentiveChange(world, before, terms, selected, titles, from, body.splitDays === true, reason, actor.name, systemClock);
      validateCompanyDocument(doc);
    } catch (e) { engineRefusal(e); }
    const saved = doc.incentives.find((r) => r.id === ruleId)!;
    const { staffIds: _ids, ...storedTerms } = saved;
    await tx.insert(payrollIncentiveRules).values({ id: ruleId, tenantId, name: saved.name, kind: saved.kind, terms: storedTerms, enabled: saved.enabled !== false })
      .onConflictDoUpdate({ target: payrollIncentiveRules.id, set: { name: saved.name, kind: saved.kind, terms: storedTerms, enabled: saved.enabled !== false, updatedAt: new Date() },
        setWhere: eq(payrollIncentiveRules.tenantId, tenantId) });
    const oldVersions = new Map((before.incentiveVersions ?? []).filter((v) => v.ruleId === ruleId).map((v) => [v.version, v]));
    for (const v of (doc.incentiveVersions ?? []).filter((x) => x.ruleId === ruleId)) {
      const old = oldVersions.get(v.version);
      if (old) {
        if (old.effectiveTo !== v.effectiveTo || !!old.superseded !== !!v.superseded) {
          await tx.update(payrollIncentiveRuleVersions).set({ effectiveTo: v.effectiveTo, superseded: !!v.superseded })
            .where(and(eq(payrollIncentiveRuleVersions.tenantId, tenantId), eq(payrollIncentiveRuleVersions.ruleId, ruleId), eq(payrollIncentiveRuleVersions.version, v.version)));
        }
      } else {
        await tx.insert(payrollIncentiveRuleVersions).values({ tenantId, ruleId, version: v.version, terms: v.terms, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo,
          superseded: !!v.superseded, reason, actorUserId: actor.userId, actorName: actor.name });
      }
    }
    const oldAssignments = new Map((before.incentiveAssignments ?? []).filter((a) => a.ruleId === ruleId).map((a) => [a.id, a]));
    for (const a of (doc.incentiveAssignments ?? []).filter((x) => x.ruleId === ruleId)) {
      const old = oldAssignments.get(a.id);
      if (old) {
        if (old.effectiveTo !== a.effectiveTo || !!old.superseded !== !!a.superseded) {
          await tx.update(payrollIncentiveAssignments).set({ effectiveTo: a.effectiveTo, superseded: !!a.superseded })
            .where(and(eq(payrollIncentiveAssignments.tenantId, tenantId), eq(payrollIncentiveAssignments.ruleId, ruleId), eq(payrollIncentiveAssignments.assignmentKey, a.id)));
        }
      } else {
        await tx.insert(payrollIncentiveAssignments).values({ tenantId, ruleId, assignmentKey: a.id, employeeId: a.staffId, jobTitle: a.jobTitle ?? null,
          branches: a.branches ?? null, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo,
          personalRate: a.personalRate === undefined ? null : String(a.personalRate), excluded: !!a.excluded, superseded: !!a.superseded,
          reason, actorUserId: actor.userId, actorName: actor.name });
      }
    }
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "incentive", subjectId: ruleId, reason,
      oldValue: before.incentives.find((r) => r.id === ruleId) ?? null, newValue: { terms: storedTerms, from, selected, titles } });
    const version = (doc.incentiveVersions ?? []).filter((v) => v.ruleId === ruleId).at(-1)!;
    return { id: ruleId, version: version.version, effectiveFrom: version.effectiveFrom, terms: storedTerms };
  });
}
