import { allocationAt } from "./payroll-profile";
import { datesIn } from "./company-math";
import type { StaffMember } from "./model";
import type { IncentiveRuleVersion } from "./company-model";

export function assignedParks(staff: StaffMember | undefined, date: string, parks: string[]): string[] {
  const profile = staff?.payrollProfile;
  const allocation = profile && allocationAt(profile, date);
  if (!allocation) return [];
  const centres = [...new Set(allocation.lines.filter(line => line.percent > 0).map(line => line.costCentre))];
  if (!centres.length) return [];
  return centres.length === 1 && parks.includes(centres[0]) ? centres : parks;
}

/** Keep normal dated-rule proration when a person changes park during a month. */
export function revenuePeriods(version: IncentiveRuleVersion, month: string, people: StaffMember[]): IncentiveRuleVersion[] {
  const policy = version.terms.assignedRevenue;
  if (!policy) return [version];
  const person = people.find(p => p.id === policy.employeeId);
  const periods: IncentiveRuleVersion[] = [];
  let previousKey: string | undefined;
  for (const date of datesIn(month)) {
    if (date < version.effectiveFrom || (version.effectiveTo && date > version.effectiveTo)) continue;
    const branches = assignedParks(person, date, policy.parks);
    const key = JSON.stringify(branches);
    if (previousKey === key) periods[periods.length - 1].effectiveTo = date;
    else {
      periods.push({ ...version, effectiveFrom: date, effectiveTo: date,
        terms: { ...version.terms, base: { ...version.terms.base, branches } } });
      previousKey = key;
    }
  }
  return periods;
}
