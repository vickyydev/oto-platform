import type { AttendanceDay, PayrollWorld } from "./model";
import type { AttendanceReview, CompanyDraft, CompanyPerson, CompanyPayrollDocument, PayrollException } from "./company-model";
import { newCompanyDraft } from "./company-workflow";
import { calculateCompanyEngine } from "./company-calculations";
import { systemClock, type PayrollClock } from "./clock";

export function issueGroup(e: PayrollException): string {
  const text = `${e.kind} ${e.message}`.toLowerCase();
  if (/third|someone else/.test(text)) return "Payments to someone else";
  if (/target|did not exceed|gate/.test(text)) return "Targets missed";
  if (/prorat|join|leav|post-employment|last working/.test(text)) return "Joiners & leavers";
  if (/attendance|clock/.test(text)) return "Attendance";
  if (/missing|no bank|tax id|sso number|account/.test(text)) return "Missing details";
  return "Other checks";
}
export function thirdPartyApprovalSignature(person: CompanyPerson): string {
  return JSON.stringify(person.payments.filter(p => p.method === "third-party").map(p => ({ bank: p.bank, reason: p.reason, amount: p.amount, account: p.payingAccountId, entity: p.entityId })));
}
export function issueNeedsReview(issue: PayrollException, person: CompanyPerson | undefined, run?: CompanyDraft): boolean {
  const approval = issue.staffId ? run?.thirdPartyApprovals?.[issue.staffId] : undefined;
  return !(issueGroup(issue) === "Payments to someone else" && person && approval && approval.signature === thirdPartyApprovalSignature(person));
}
/** Step 2 excludes attendance; joiner/leaver information is not an unresolved problem. */
export function checkFixIssues(result?: import("./company-model").CompanyResult, run?: CompanyDraft): PayrollException[] {
  return (result?.exceptions ?? []).filter(e => issueGroup(e) !== "Attendance" && issueNeedsReview(e, result?.people.find(p => p.id === e.staffId), run));
}
export function openCheckFixProblems(result?: import("./company-model").CompanyResult, run?: CompanyDraft): number {
  return checkFixIssues(result, run).filter(e => e.severity !== "info" && !/prorat/i.test(`${e.kind} ${e.message}`)).length;
}
export function attendanceIssueDay(data: PayrollWorld, issue: PayrollException): AttendanceDay | undefined {
  return data.attendance.find(d => issue.id === `attendance-${d.id}`) ??
    data.attendance.find(d => d.staffId === issue.staffId && issue.message.includes(d.date));
}
export function recordAttendanceReview(run: CompanyDraft, day: AttendanceDay, action: AttendanceReview["action"], reason: string, who: string, clockIn?: string, clockOut?: string, clock: PayrollClock = systemClock): void {
  if (!reason.trim() || !who.trim()) throw new Error("Enter a short reason.");
  if (!day.date.startsWith(`${run.month}-`)) throw new Error("This attendance day belongs to another month.");
  if (action === "override" && (!clockIn || !clockOut || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clockIn) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clockOut)))
    throw new Error("Enter both corrected times.");
  run.attendance[day.id] = { action, reason: reason.trim(), who, at: clock.now().toISOString(), ...(action === "override" ? { clockIn, clockOut } : {}) };
}
export function attendancePayEffect(data: PayrollWorld, doc: CompanyPayrollDocument, entityId: string, month: string, day: AttendanceDay): { amount: number; sources: string[] } {
  const simulate = (action: AttendanceReview["action"]) => {
    const copy = structuredClone(doc);
    const [key, previous] = Object.entries(copy.runs).filter(([, r]) => r.entityId === entityId && r.month === month).sort((a, b) => b[1].version - a[1].version)[0] ?? [`${entityId}:${month}`, undefined];
    const run = previous ?? newCompanyDraft(entityId, month);
    recordAttendanceReview(run, day, action, "Preview this day only", "Payroll preview");
    copy.runs[key] = run;
    return calculateCompanyEngine(data, copy, month).entities.find(e => e.entityId === entityId)?.people.find(p => p.id === day.staffId);
  };
  const excused = simulate("excuse"), confirmed = simulate("confirm");
  const deduction = (p?: CompanyPerson) => (p?.lines ?? []).filter(l => l.component.startsWith("attendance-rule:")).reduce((s, l) => s + l.amount, 0);
  return { amount: Math.round((deduction(confirmed) - deduction(excused)) * 100) / 100,
    sources: Array.from(new Set((confirmed?.lines ?? []).filter(l => l.component.startsWith("attendance-rule:") && l.amount > 0).map(l => /service charge/i.test(l.formula) ? "service charge" : "pay"))) };
}
export function targetIssueDetail(issue: PayrollException, doc: CompanyPayrollDocument, calculation?: import("./company-model").CompanyCalculation) {
  const award = calculation?.incentives.find(a => issue.id === `target-${a.ruleId}-${a.staffId}`);
  const rule = doc.incentives.find(r => r.id === award?.ruleId);
  const numbers = issue.message.match(/([\d.]+) did not exceed ([\d.]+)/);
  const actual = award?.base ?? Number(numbers?.[1] ?? 0), target = Number(numbers?.[2] ?? rule?.target ?? 0);
  const formula = award?.formula.match(/([\d.]+) (?:sales|base) × ([\d.]+)% × ([\d.]+)(?:\/([\d.]+))?/);
  const cap = award?.formula.match(/; cap ([\d.]+)/);
  const fraction = formula ? +formula[3] / +(formula[4] ?? 1) : 1;
  const potential = formula ? +formula[1] * +formula[2] / 100 * fraction : 0;
  return { name: award?.name ?? rule?.name ?? "Incentive", actual, target, shortfall: Math.max(0, target - actual), unpaid: Math.round(Math.min(potential, cap ? +cap[1] * fraction : Infinity) * 100) / 100 };
}
