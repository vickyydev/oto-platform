import type { PayrollWorld, StaffMember, BranchId } from "./model";
import type { CompanyPayrollDocument, PayrollException, ServiceDistribution, ServicePolicy, ServiceShareGroup } from "./company-model";
import { allocationAt } from "./payroll-profile";
import { apportion, datesIn, employed, money, previousMonth, revenueBase, workedUnits } from "./company-math";

export function calculateGroupedService(data: PayrollWorld, doc: CompanyPayrollDocument, month: string,
  branchId: BranchId, policy: ServicePolicy, staff: StaffMember[], errors: PayrollException[]): ServiceDistribution {
  const earningMonth = previousMonth(month), groups = policy.groups!;
  const base = revenueBase(doc, earningMonth, { branches: [branchId], streams: policy.streams, addBack: policy.addBack }, errors, `Service charge ${branchId}`);
  const pool = money(base * policy.percent / 100);
  const explicit = groups.filter(g => g.selection !== "everyone");
  const selected = (g: ServiceShareGroup, s: StaffMember): boolean => g.selection === "everyone" ? !explicit.some(other => selected(other, s))
    : g.selection === "people" ? g.values.includes(s.id)
    : g.selection === "department" ? g.values.includes(s.payrollProfile!.department ?? "")
    : g.values.includes(s.payrollProfile!.jobTitle);
  const rawUnits = (s: StaffMember, basis: ServicePolicy["basis"]) => {
    const p = s.payrollProfile!, dates = datesIn(earningMonth).filter(d => employed(p, d)), worked = workedUnits(data, doc, s, earningMonth);
    return (basis === "worked" ? worked.dates : dates).reduce((n, d) => n +
      (allocationAt(p, d)?.lines.filter(l => l.costCentre === branchId).reduce((a, l) => a + l.percent, 0) ?? 0) / 100 *
      (basis === "worked" ? worked.perDate : basis === "equal" ? 1 / (dates.length || 1) :
        basis === "role-weight" ? (policy.roleWeights[p.jobTitle] ?? s.serviceRoleWeight ?? 1) / (dates.length || 1) : 1), 0);
  };
  const exception = (id: string) => policy.exceptions?.find(e => e.staffId === id);
  const fixed = staff.filter(s => exception(s.id)?.kind === "fixed" && rawUnits(s, "calendar") > 0);
  const fixedTotal = money(fixed.reduce((n, s) => n + exception(s.id)!.value, 0));
  if (fixedTotal > pool) throw new Error("Fixed service-charge amounts exceed the branch pool.");
  const reserved = groups.map(g => g.streams?.length ? money(revenueBase(doc, earningMonth,
    { branches: [branchId], streams: g.streams, addBack: [] }, errors, `${g.name} service charge`) * policy.percent / 100 * g.percent / 100) : 0);
  const reservedTotal = money(reserved.reduce((n, v) => n + v, 0));
  if (reservedTotal > pool + 0.01) throw new Error("Group sales pools exceed the branch service-charge pool.");
  const ordinary = groups.filter(g => !g.streams?.length);
  const remainder = money(pool - reservedTotal);
  const shared = apportion(remainder, ordinary.map(g => g.percent));
  const grossBudgets = groups.map((g, i) => g.streams?.length ? reserved[i] : shared[ordinary.indexOf(g)] ?? 0);
  const budgets = fixedTotal ? apportion(pool - fixedTotal,
    [...grossBudgets, money(pool - grossBudgets.reduce((n, x) => n + x, 0))]).slice(0, groups.length) : grossBudgets;
  const people = new Map<string, ServiceDistribution["people"][number]>();
  const details: Record<string, string> = {};
  for (const s of fixed) {
    const amount = money(exception(s.id)!.value);
    people.set(s.id, { staffId: s.id, name: s.name, units: 0, eligible: true, amount });
    details[s.id] = `Fixed service charge ${amount.toFixed(2)} from the ${earningMonth} branch pool`;
  }
  const results = groups.map((group, gi) => {
    const entries = staff.filter(s => selected(group, s) && exception(s.id)?.kind !== "fixed").map(s => {
      const ex = exception(s.id);
      const eligible = ex?.kind !== "exclude" && s.payrollProfile!.serviceChargeEligible;
      const units = rawUnits(s, group.basis) * (ex?.kind === "weight" ? ex.value : 1);
      return { s, eligible, units };
    }).filter(e => e.units > 0);
    const weights = entries.map(e => e.eligible || policy.excluded === "retain" ? e.units : 0);
    const denominator = weights.reduce((n, x) => n + x, 0), amounts = apportion(budgets[gi], weights);
    const dayRate = denominator ? budgets[gi] / denominator : 0;
    let paid = 0;
    entries.forEach((e, i) => {
      const amount = e.eligible ? amounts[i] : 0;
      paid += amount;
      const old = people.get(e.s.id) ?? { staffId: e.s.id, name: e.s.name, eligible: false, units: 0, amount: 0 };
      people.set(e.s.id, { ...old, eligible: old.eligible || e.eligible, units: old.units + e.units, amount: money(old.amount + amount) });
      const text = `${group.name}: ${e.units.toFixed(4)} ${group.basis === "calendar" ? "calendar days" : group.basis === "worked" ? "worked days" : "share units"} × ${dayRate.toFixed(6)} = ${amount.toFixed(2)}; pool ${budgets[gi].toFixed(2)}, total units ${denominator.toFixed(4)}`;
      details[e.s.id] = [details[e.s.id], text].filter(Boolean).join("; ");
    });
    return { id: group.id, name: group.name, pool: budgets[gi], denominator, dayRate, paid: money(paid),
      retained: money(budgets[gi] - paid), basis: group.basis };
  });
  const distribution = Array.from(people.values()), paid = money(distribution.reduce((n, e) => n + e.amount, 0));
  const denominator = results.reduce((n, g) => n + g.denominator, 0);
  return { branchId, earningMonth, revenueBase: base, percent: policy.percent, pool, basis: policy.basis,
    denominator, dayRate: denominator ? (pool - fixedTotal) / denominator : 0, paid, retained: money(pool - paid),
    people: distribution, groups: results, details };
}
