import type { PayrollWorld, StaffMember, BranchId } from "./model";
import type { CompanyPayrollDocument, CompanyIncentive, IncentiveAssignment, IncentiveRuleVersion, ServicePolicy } from "./company-model";
import { datesIn, employed } from "./company-math";
import { systemClock, type PayrollClock } from "./clock";

export const allRewardStaff = (data: PayrollWorld) => Object.values(data.branches).flatMap(b => b.staff);
export const rewardBranchOf = (data: PayrollWorld, staffId: string) => Object.values(data.branches).find(b => b.staff.some(s => s.id === staffId))?.id;
export const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
export const nextMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);
export function nextOpenRewardMonth(doc: CompanyPayrollDocument, month: string) {
  let candidate = month;
  for (let i = 0; i < 120; i++, candidate = nextMonth(candidate)) if (!rewardMonthLocked(doc, candidate)) return candidate;
  throw new Error("No open month found in the next ten years.");
}
export function rewardMonthLocked(doc: CompanyPayrollDocument, month: string) {
  return Object.values(doc.runs).some(r => r.month === month && (r.status === "locked" || r.status === "paid"));
}
export function rewardStart(doc: CompanyPayrollDocument, date: string, splitDays: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Choose a valid start date.");
  const month = date.slice(0, 7);
  if (rewardMonthLocked(doc, month)) throw new Error(`This month is locked. Choose ${nextOpenRewardMonth(doc, nextMonth(month))} or reopen the run first.`);
  return date.endsWith("-01") || splitDays ? date : `${nextOpenRewardMonth(doc, nextMonth(month))}-01`;
}
const inRange = (date: string, from: string, to: string | null) => date >= from && (!to || date <= to);
export function assignmentFor(data: PayrollWorld, doc: CompanyPayrollDocument, ruleId: string, staff: StaffMember, date: string): IncentiveAssignment | undefined {
  if (!doc.incentiveAssignments) {
    const rule = doc.incentives.find(r => r.id === ruleId);
    return rule?.staffIds.includes(staff.id) ? { id: `old-${ruleId}-${staff.id}`, ruleId, staffId: staff.id,
      effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo, who: "Sample setup", at: "", reason: "Existing assignment" } : undefined;
  }
  const eligible = doc.incentiveAssignments.filter(a => !a.superseded && a.ruleId === ruleId && inRange(date, a.effectiveFrom, a.effectiveTo));
  const direct = eligible.filter(a => a.staffId === staff.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.at.localeCompare(a.at))[0];
  if (direct) return direct.excluded ? undefined : direct;
  const template = eligible.find(a => a.staffId === null && a.jobTitle?.toLowerCase() === staff.payrollProfile?.jobTitle.toLowerCase() &&
    (!a.branches?.length || a.branches.includes(rewardBranchOf(data, staff.id)!)));
  return template && !template.excluded ? { ...template, id: `${template.id}:${staff.id}`, staffId: staff.id } : undefined;
}
export function recipientsForMonth(data: PayrollWorld, doc: CompanyPayrollDocument, ruleId: string, month: string) {
  return allRewardStaff(data).filter(s => datesIn(month).some(d => employed(s.payrollProfile!, d) && assignmentFor(data, doc, ruleId, s, d)));
}
export function versionsForMonth(doc: CompanyPayrollDocument, month: string): IncentiveRuleVersion[] {
  return doc.incentiveVersions?.filter(v => !v.superseded && v.effectiveFrom <= `${month}-31` && (!v.effectiveTo || v.effectiveTo >= `${month}-01`)) ??
    doc.incentives.map(r => ({ ruleId: r.id, version: 1, terms: r, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, who: "Sample setup", at: "", reason: "Existing rule" }))
      .filter(v => v.effectiveFrom <= `${month}-31` && (!v.effectiveTo || v.effectiveTo >= `${month}-01`));
}
/**
 * The dated form a save works on. The prototype ran `migrateCompanyRewards`
 * here (prototype company-rewards.ts:45-72), which also defaulted every
 * rule's `partMonth` to "prorate", added job-title templates keyed to the
 * fictional branch ids, an "Everyone" service group and nanny/sales-booth
 * exclusions. Per the plan (§2, §8, "What reading the code changed") that
 * migration is not run: this only turns the undated fallback (rule
 * `staffIds`, current terms) into the dated versions and assignments it
 * implies, and invents nothing. A document already in the dated form
 * (`rewardsVersion === 1`) is returned unchanged, as the prototype did.
 */
export function datedRewards(document: CompanyPayrollDocument): CompanyPayrollDocument {
  if (document.rewardsVersion === 1) return document;
  const doc = structuredClone(document);
  doc.incentiveAssignments ??= doc.incentives.flatMap(r => r.staffIds.map(id => ({ id: `${r.id}:${id}:initial`, ruleId: r.id, staffId: id,
    effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, who: "Sample setup", at: "", reason: "Existing recipient" })));
  doc.incentiveVersions ??= doc.incentives.map(r => ({ ruleId: r.id, version: 1, terms: structuredClone(r), effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo, who: "Sample setup", at: "", reason: "Original saved terms" }));
  for (const policies of Object.values(doc.servicePolicies)) for (const [i, policy] of Array.from((policies ?? []).entries())) policy.version ??= i + 1;
  doc.rewardsVersion = 1;
  return doc;
}
export interface AssignmentSelection { staffId: string; startDate: string; endDate?: string | null; personalRate?: number; excluded?: boolean }
export interface JobTitleSelection { jobTitle: string; branches: BranchId[] }
/** Terms never overwrite an older version. Assignment removal is a dated exclusion, including title defaults. */
export function saveIncentiveChange(data: PayrollWorld, document: CompanyPayrollDocument, terms: CompanyIncentive,
  selected: AssignmentSelection[], titles: JobTitleSelection[], from: string, splitDays: boolean, reason: string, who: string,
  clock: PayrollClock = systemClock): CompanyPayrollDocument {
  if (!reason.trim() || !who.trim()) throw new Error("A reason and editor are required.");
  const date = rewardStart(document, from, splitDays), doc = structuredClone(datedRewards(document)), at = clock.now().toISOString();
  const versions = doc.incentiveVersions!;
  const same = versions.filter(v => v.ruleId === terms.id && !v.superseded);
  for (const old of same) if (old.effectiveFrom === date) old.superseded = true;
  else if (old.effectiveFrom < date && (!old.effectiveTo || old.effectiveTo >= date)) old.effectiveTo = dayBefore(date);
  const next = same.filter(v => v.effectiveFrom > date).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  const saved = { ...structuredClone(terms), staffIds: selected.filter(s => !s.excluded).map(s => s.staffId), effectiveFrom: date, effectiveTo: next ? dayBefore(next.effectiveFrom) : terms.effectiveTo };
  versions.push({ ruleId: terms.id, version: Math.max(0, ...versions.filter(v => v.ruleId === terms.id).map(v => v.version)) + 1,
    terms: saved, effectiveFrom: date, effectiveTo: saved.effectiveTo, reason, who, at });
  doc.incentives = [...doc.incentives.filter(r => r.id !== terms.id), saved];
  const assignments = doc.incentiveAssignments!;
  const current = recipientsForMonth(data, doc, terms.id, date.slice(0, 7));
  for (const s of current) if (!selected.some(p => p.staffId === s.id)) {
    const templateIncluded = titles.some(t => t.jobTitle.toLowerCase() === s.payrollProfile?.jobTitle.toLowerCase() && (!t.branches.length || t.branches.includes(rewardBranchOf(data, s.id)!)));
    if (!templateIncluded) selected = [...selected, { staffId: s.id, startDate: date, endDate: null, personalRate: undefined }];
  }
  const selectedIds = new Set(saved.staffIds);
  const currentIds = new Set(current.map(s => s.id));
  for (const s of allRewardStaff(data)) {
    const choice = selected.find(p => p.staffId === s.id);
    const auto = titles.some(t => t.jobTitle.toLowerCase() === s.payrollProfile?.jobTitle.toLowerCase() && (!t.branches.length || t.branches.includes(rewardBranchOf(data, s.id)!)));
    if (!choice && !currentIds.has(s.id)) continue;
    const requested = rewardStart(doc, choice?.startDate || date, splitDays);
    const starts = requested < date ? date : requested;
    if (choice?.endDate && choice.endDate < starts) throw new Error("An end date must be after the start date.");
    if (choice?.personalRate !== undefined && (!Number.isFinite(choice.personalRate) || choice.personalRate < 0)) throw new Error("Personal rates cannot be negative.");
    for (const old of assignments.filter(a => a.ruleId === terms.id && a.staffId === s.id && (!a.effectiveTo || a.effectiveTo >= starts))) {
      if (old.effectiveFrom >= starts) old.superseded = true;
      else old.effectiveTo = dayBefore(starts);
    }
    assignments.push({ id: `${terms.id}:${s.id}:${at}`, ruleId: terms.id, staffId: s.id, effectiveFrom: starts,
      effectiveTo: choice?.endDate || null, personalRate: selectedIds.has(s.id) ? choice?.personalRate : undefined,
      excluded: choice?.excluded || (!selectedIds.has(s.id) && !auto), who, reason, at });
  }
  for (const old of assignments.filter(a => a.ruleId === terms.id && a.staffId === null && (!a.effectiveTo || a.effectiveTo >= date))) {
    if (old.effectiveFrom >= date) old.superseded = true;
    else old.effectiveTo = dayBefore(date);
  }
  for (const title of titles) assignments.push({ id: `${terms.id}:title:${title.jobTitle}:${at}`, ruleId: terms.id, staffId: null,
    jobTitle: title.jobTitle, branches: title.branches, effectiveFrom: date, effectiveTo: null, who, reason, at });
  doc.audit.push({ at, who, reason, action: `Incentive changed: ${terms.name}, from ${date}${splitDays ? " (split by days)" : ""}` });
  return doc;
}
export function saveServiceChange(data: PayrollWorld, document: CompanyPayrollDocument, branch: BranchId, policy: ServicePolicy,
  month: string, reason: string, who: string, clock: PayrollClock = systemClock) {
  if (!reason.trim()) throw new Error("A reason is required.");
  const doc = structuredClone(datedRewards(document));
  if (rewardMonthLocked(doc, nextMonth(month))) throw new Error(`The ${nextMonth(month)} payroll is locked. Choose a sales month paid in an open run.`);
  const from = `${month}-01`;
  const list = doc.servicePolicies[branch] ?? [];
  const version = Math.max(0, ...list.map(p => p.version ?? 1)) + 1;
  list.filter(p => p.effectiveFrom === from).forEach(p => { p.superseded = true; });
  doc.servicePolicies[branch] = [...list, { ...structuredClone(policy), effectiveFrom: from, version, who, reason, at: clock.now().toISOString() }];
  doc.audit.push({ at: clock.now().toISOString(), who, reason, action: `Service charge changed: ${branch}, sales month ${month}` });
  return doc;
}
