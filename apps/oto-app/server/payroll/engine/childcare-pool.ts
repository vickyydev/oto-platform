import type { PayrollWorld, StaffMember } from "./model";
import type { CompanyPayrollDocument, IncentiveAward, IncentiveRuleVersion, PayrollException } from "./company-model";
import { apportion, revenueBase, workedDates } from "./company-math";
import { assignmentFor } from "./company-rewards";

const childcareDepartment = /\b(?:child\s*care|nanny|nannies|drop[ -]?off)\b/i;

/** Each park pays one monthly pool. A membership change changes eligible dates, never the number of pools. */
export function childcareAwards(world: PayrollWorld, doc: CompanyPayrollDocument, month: string, staff: StaffMember[],
  versions: IncentiveRuleVersion[], errors: PayrollException[]): IncentiveAward[] {
  if (!versions.length) return [];
  const result: IncentiveAward[] = [];
  const worked = new Map(staff.map(s => [s.id, new Set(workedDates(world, doc, s, month))]));
  const people = new Map(staff.map(s => [s.id, s]));
  for (const park of Object.keys(world.branches).sort()) {
    const rules = versions.filter(v => v.terms.base.branches.includes(park)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    if (!rules.length) continue;
    const weights = new Map<string, { shifts: Set<string>; clocks: Set<string>; version: IncentiveRuleVersion; assignment: NonNullable<ReturnType<typeof assignmentFor>> }>();
    for (const day of world.attendance) {
      const person = people.get(day.staffId);
      if (!person || !worked.get(person.id)?.has(day.date) || !(day.clockBranches ?? [day.branchId]).includes(park)) continue;
      const shifts = day.shiftDepartments?.filter(s => s.branchId === park) ?? [];
      if (shifts.length && !shifts.some(s => childcareDepartment.test(s.name))) continue;
      for (const v of rules) {
        if (day.date < v.effectiveFrom || (v.effectiveTo && day.date > v.effectiveTo)) continue;
        const assignment = assignmentFor(world, doc, v.ruleId, person, day.date);
        if (!assignment) continue;
        const entry = weights.get(person.id) ?? { shifts: new Set<string>(), clocks: new Set<string>(), version: v, assignment };
        if (shifts.length) { entry.shifts.add(day.date); entry.clocks.delete(day.date); }
        else if (!entry.shifts.has(day.date)) entry.clocks.add(day.date);
        weights.set(person.id, entry);
        break;
      }
    }
    if (!weights.size) continue;
    const base = revenueBase(doc, month, { branches: [park], streams: rules[0].terms.base.streams, addBack: [] }, errors, "Childcare Team");
    // Pay whole satang and never exceed one fifth of the net sales.
    const pool = Math.floor(Math.round(Math.max(0, base) * 100) / 5) / 100;
    const members = [...weights].sort(([a], [b]) => a.localeCompare(b));
    const days = members.map(([, w]) => w.shifts.size + w.clocks.size);
    const teamDays = days.reduce((a, b) => a + b, 0);
    const shares = apportion(pool, days);
    members.forEach(([staffId, w], i) => {
      const dates = [...w.shifts, ...w.clocks].sort();
      const label = world.costCentreNames?.[park] ?? park;
      result.push({ ruleId: w.version.ruleId, name: w.version.terms.name, staffId, amount: shares[i], targetMet: true, base, units: days[i],
        childcare: { branchId: park, shiftDays: w.shifts.size, clockDays: w.clocks.size, teamDays, pool },
        formula: `${label}: 20% of net nanny and drop-off sales × ${days[i]}/${teamDays} days (${w.shifts.size} childcare shift days, ${w.clocks.size} clock-in days without department records).`,
        rewardTrace: { rule: w.version.terms, version: w.version.version, assignment: w.assignment, from: dates[0], to: dates[dates.length - 1], dates } });
    });
  }
  return result;
}
