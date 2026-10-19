import type { BranchId, PayrollWorld, StaffMember } from "./model";
import { allocationAt, resolvePayingAccount, type EmployeePayrollProfile } from "./payroll-profile";
import type { CompanyPayrollDocument, MoneyAllocation, PayrollException, RevenueBase } from "./company-model";

export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const monthDays = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
export const previousMonth = (month: string) => {
  const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7);
};
export const datesIn = (month: string) => Array.from({ length: monthDays(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
export const employed = (p: EmployeePayrollProfile, date: string) => date >= p.joinedOn && (!p.lastWorkingDay || date <= p.lastWorkingDay);
/** Largest-remainder cents: split totals are exactly the rounded source amount. */
export function apportion(total: number, weights: number[]): number[] {
  if (!Number.isFinite(total) || weights.some(w => !Number.isFinite(w) || w < 0)) throw new Error("Invalid money or allocation weight.");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const cents = Math.round(Math.abs(total) * 100), sign = total < 0 ? -1 : 1;
  const exact = weights.map(w => cents * w / sum), parts = exact.map(Math.floor);
  const order = exact.map((v, i) => ({ i, fraction: v - parts[i] })).sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let left = cents - parts.reduce((a, b) => a + b, 0), i = 0; left > 0; left--, i++) parts[order[i % order.length].i]++;
  return parts.map(n => sign * n / 100);
}
export function workedDates(data: PayrollWorld, doc: CompanyPayrollDocument, staff: StaffMember, month: string): string[] {
  const p = staff.payrollProfile!;
  const decisions = Object.values(doc.runs).filter(r => r.month === month).flatMap(r => Object.entries(r.attendance));
  const reviews = new Map(decisions);
  return Array.from(new Set(data.attendance.filter(day => {
    const review = reviews.get(day.id);
    const clock = review?.action === "override" ? review.clockIn ?? day.effectiveClockIn ?? day.actualClockIn : day.effectiveClockIn ?? day.actualClockIn;
    return day.staffId === staff.id && day.date.startsWith(month) && employed(p, day.date) && !!clock;
  }).map(d => d.date))).sort();
}
export function workedUnits(data: PayrollWorld, doc: CompanyPayrollDocument, staff: StaffMember, month: string) {
  const dates = workedDates(data, doc, staff, month);
  const manual = doc.months[month]?.staff[staff.id]?.daysWorked;
  const employedDates = datesIn(month).filter(d => employed(staff.payrollProfile!, d));
  if (manual !== undefined && (!Number.isFinite(manual) || manual < 0 || manual > employedDates.length)) throw new Error(`${staff.name}: days worked must be between 0 and employed calendar days.`);
  const basisDates = dates.length ? dates : employedDates;
  const total = manual ?? dates.length;
  return { total, dates: basisDates, perDate: basisDates.length ? total / basisDates.length : 0 };
}
export function splitEarning(data: PayrollWorld, p: EmployeePayrollProfile, total: number,
  dateWeights: Array<{ date: string; weight: number }>): MoneyAllocation[] {
  const buckets = new Map<string, MoneyAllocation & { weight: number }>();
  for (const { date, weight } of dateWeights) {
    const allocation = allocationAt(p, date);
    if (!allocation || Math.abs(allocation.lines.reduce((s, l) => s + l.percent, 0) - 100) > 0.000001) throw new Error("Missing or invalid effective allocation.");
    for (const line of allocation.lines) {
      const account = resolvePayingAccount(data, line, date);
      const key = `${line.costCentre}|${line.entityId}|${account?.id ?? ""}`;
      const old = buckets.get(key) ?? { costCentre: line.costCentre, entityId: line.entityId, payingAccountId: account?.id ?? null, amount: 0, weight: 0 };
      old.weight += weight * line.percent / 100; buckets.set(key, old);
    }
  }
  const values = Array.from(buckets.values());
  return values.map((v, i) => ({ costCentre: v.costCentre, entityId: v.entityId, payingAccountId: v.payingAccountId, amount: apportion(total, values.map(v => v.weight))[i] }));
}
export function revenueBase(doc: CompanyPayrollDocument, month: string, base: RevenueBase, exceptions: PayrollException[], dependency: string): number {
  let sum = 0;
  for (const branch of base.branches) {
    const input = doc.months[month]?.revenue[branch];
    if (!input) { exceptions.push({ id: `${dependency}-${branch}-${month}`, branchId: branch, kind: "missing-input", severity: "blocking", message: `${dependency} depends on ${branch} revenue for ${month}.` }); continue; }
    for (const key of base.streams) {
      const cell = input.streams[key];
      if (!cell) { exceptions.push({ id: `${dependency}-${branch}-${key}-${month}`, branchId: branch, kind: "missing-input", severity: "blocking", message: `${dependency} depends on ${month} ${branch} / ${key}.` }); continue; }
      if (![cell.amount, cell.vat, cell.serviceCharge].every(n => Number.isFinite(n) && n >= 0) || cell.vat + cell.serviceCharge > cell.amount) throw new Error(`Invalid gross/VAT/service-charge input for ${branch}/${key}.`);
      sum += cell.amount - cell.vat - cell.serviceCharge;
    }
    for (const discount of base.addBack) {
      const amount = input.discounts[discount];
      if (amount === undefined) exceptions.push({ id: `${dependency}-${branch}-${discount}`, branchId: branch, kind: "missing-input", severity: "blocking", message: `${dependency} needs discount add-back ${discount} for ${month}.` });
      else sum += amount;
    }
  }
  return money(sum);
}
export function homeBranch(p: EmployeePayrollProfile, month: string): BranchId {
  const date = p.lastWorkingDay && p.lastWorkingDay.startsWith(month) ? p.lastWorkingDay : `${month}-${monthDays(month)}`;
  const version = allocationAt(p, date);
  if (!version) throw new Error("No registered branch for this period.");
  return version.homeBranchId;
}
