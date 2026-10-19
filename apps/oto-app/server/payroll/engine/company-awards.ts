import type { BranchId, PayrollWorld, StaffMember } from "./model";
import { allocationAt } from "./payroll-profile";
import { apportion, datesIn, employed, money, previousMonth, revenueBase, workedUnits } from "./company-math";
import type { CompanyIncentive, CompanyPayrollDocument, IncentiveAward, PayrollException, ServiceDistribution, RewardTrace } from "./company-model";
import { assignmentFor, versionsForMonth } from "./company-rewards";
import { calculateGroupedService } from "./company-service-groups";

export function calculateCompanyService(data: PayrollWorld, doc: CompanyPayrollDocument, month: string,
  people: StaffMember[], errors: PayrollException[]): ServiceDistribution[] {
  const earningMonth = previousMonth(month);
  return (Object.keys(data.branches) as BranchId[]).map(branchId => {
    const policy = [...(doc.servicePolicies[branchId] ?? [])].filter(p => !p.superseded && p.effectiveFrom <= `${earningMonth}-01`).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || (b.version ?? 1) - (a.version ?? 1))[0];
    if (!policy) { errors.push({ id: `sc-policy-${branchId}`, branchId, kind: "missing-input", severity: "blocking", message: `No service-charge policy for ${branchId}/${earningMonth}.` }); return { branchId, earningMonth, revenueBase: 0, percent: 0, pool: 0, basis: "calendar" as const, denominator: 0, dayRate: 0, paid: 0, retained: 0, people: [] }; }
    if (policy.groups?.length) return calculateGroupedService(data, doc, month, branchId, policy, people, errors);
    const base = revenueBase(doc, earningMonth, { branches: [branchId], streams: policy.streams, addBack: policy.addBack }, errors, `Service charge ${branchId}`);
    const pool = money(base * policy.percent / 100);
    const entries = people.map(staff => {
      const p = staff.payrollProfile!;
      const dates = datesIn(earningMonth).filter(d => employed(p, d));
      const work = workedUnits(data, doc, staff, earningMonth);
      const effectiveDays = policy.basis === "worked" ? work.dates : dates;
      let units = 0;
      for (const date of effectiveDays) {
        const allocation = allocationAt(p, date);
        const percent = allocation?.lines.filter(l => l.costCentre === branchId).reduce((s, l) => s + l.percent, 0) ?? 0;
        const weight = policy.basis === "worked" ? work.perDate
          : policy.basis === "equal" ? 1 / (dates.length || 1)
          : policy.basis === "role-weight" ? (policy.roleWeights[p.jobTitle] ?? staff.serviceRoleWeight ?? 1) / (dates.length || 1) : 1;
        units += percent / 100 * weight;
      }
      return { staffId: staff.id, name: staff.name, units, eligible: p.serviceChargeEligible && dates.length > 0, amount: 0 };
    }).filter(p => p.units > 0);
    const weighted = entries.map(p => p.eligible || policy.excluded === "retain" ? p.units : 0);
    const denominator = weighted.reduce((s, w) => s + w, 0);
    const amounts = apportion(pool, weighted);
    let retained = denominator ? 0 : pool;
    const distribution = entries.map((p, i) => {
      if (!p.eligible) retained += amounts[i];
      return { ...p, amount: p.eligible ? amounts[i] : 0 };
    });
    return { branchId, earningMonth, revenueBase: base, percent: policy.percent, pool, basis: policy.basis,
      denominator, dayRate: denominator ? pool / denominator : 0,
      paid: money(distribution.reduce((s, p) => s + p.amount, 0)), retained: money(retained), people: distribution };
  });
}

export function calculateCompanyIncentives(data: PayrollWorld, doc: CompanyPayrollDocument, month: string,
  people: StaffMember[], salaries: Map<string, number>, errors: PayrollException[]): IncentiveAward[] {
  const result: IncentiveAward[] = [];
  const active = versionsForMonth(doc, month).filter(v => v.terms.enabled !== false);
  // Guarantees run last and include all preceding incentive awards.
  for (const version of [...active.filter(v => v.terms.kind !== "guarantee"), ...active.filter(v => v.terms.kind === "guarantee")]) {
    const rule = { ...version.terms, effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo };
    const segments = people.flatMap(staff => {
      const groups = new Map<string, { staff: StaffMember; dates: string[]; assignment: NonNullable<ReturnType<typeof assignmentFor>> }>();
      for (const date of datesIn(month).filter(d => employed(staff.payrollProfile!, d) && d >= rule.effectiveFrom && (!rule.effectiveTo || d <= rule.effectiveTo))) {
        const assignment = assignmentFor(data, doc, rule.id, staff, date);
        if (!assignment) continue;
        const entry = groups.get(assignment.id) ?? { staff, dates: [], assignment };
        entry.dates.push(date); groups.set(assignment.id, entry);
      }
      return Array.from(groups.values());
    });
    const participants = segments.map(s => s.staff);
    if (!participants.length) continue;
    const needsRevenue = rule.kind === "revenue" || rule.kind === "team-days" || rule.target !== null;
    const base = needsRevenue ? revenueBase(doc, month, rule.base, errors, rule.name) : 0;
    // PAYROLL-CONCERN-4 (SCRUM-564): the target gate is strict `>`; the older engine's `targetGate` uses `≥` (unpaid). This answer pays.
    const targetMet = rule.target === null || base > rule.target;
    const days = segments.map(segment => {
      const s = segment.staff;
      const w = workedUnits(data, doc, s, month);
      return w.dates.reduce((total, date) => segment.dates.includes(date) ? total + w.perDate : total, 0) * (segment.assignment.personalRate ?? 1);
    });
    const poolCount = doc.months[month]?.counts[rule.inputKey];
    if (rule.kind === "unit-pool" && poolCount === undefined) errors.push({ id: `${rule.id}-count`, kind: "missing-input", severity: "blocking", message: `${rule.name} depends on count "${rule.inputKey}" for ${month}.` });
    const span = datesIn(month).filter(d => d >= rule.effectiveFrom && (!rule.effectiveTo || d <= rule.effectiveTo)).length / datesIn(month).length;
    const rawPool = (rule.kind === "team-days" ? base * rule.rate / 100 : (poolCount ?? 0) * rule.rate) * span;
    const pooled = apportion(rule.cap === null ? rawPool : Math.min(rawPool, rule.cap * span), rule.kind === "team-days" ? days : segments.map(s =>
      s.dates.length / (datesIn(month).filter(d => employed(s.staff.payrollProfile!, d)).length || 1) * (s.assignment.personalRate ?? 1)));
    participants.forEach((staff, index) => {
      const segment = segments[index], rate = segment.assignment.personalRate ?? rule.rate;
      const employedDays = datesIn(month).filter(d => employed(staff.payrollProfile!, d)).length || 1;
      const fraction = segment.dates.length / (rule.partMonth === "prorate" ? datesIn(month).length : employedDays);
      const unitFraction = segment.dates.length / employedDays;
      const input = doc.months[month]?.staff[staff.id];
      let amount = 0, units = 0, detail = "", valid = targetMet;
      let trace: RewardTrace = { version: version.version, rule: structuredClone(rule), assignment: structuredClone(segment.assignment), from: segment.dates[0], to: segment.dates.at(-1)!, dates: segment.dates };
      switch (rule.kind) {
        case "revenue": {
          const activeDays = datesIn(month).filter(d => employed(staff.payrollProfile!, d));
          const qualifying = segment.dates;
          // PAYROLL-CONCERN-4 (SCRUM-564): rates are PERCENT (base × rate / 100); legacy plans and vouchers use decimals (incentives.ts, employee-incentives.ts), and their lines are never paid.
          amount = base * rate / 100 * fraction;
          detail = `${base.toFixed(2)} sales × ${rate}% × ${qualifying.length}/${activeDays.length} eligible days`; break;
        }
        case "team-days": units = days[index]; amount = pooled[index]; detail = `${base.toFixed(2)} × ${rule.rate}% pool; ${units} worked days / ${days.reduce((s, d) => s + d, 0)} team days`; break;
        case "unit-pool": units = poolCount ?? 0; amount = pooled[index]; detail = `${units} units × ${rule.rate} / ${participants.length} people`; break;
        case "unit": units = input?.units[rule.inputKey] ?? 0; amount = units * rate * unitFraction; detail = `${units} items × ${rate} × ${segment.dates.length} eligible days / employed days`;
          if (input?.units[rule.inputKey] === undefined) errors.push({ id: `${rule.id}-${staff.id}-units`, staffId: staff.id, kind: "missing-input", severity: "blocking", message: `${staff.name}: ${rule.name} needs ${rule.inputKey}.` }); break;
        case "kpi": {
          const value = input?.kpis[rule.inputKey];
          valid = targetMet && value !== undefined && ({ lt: value < rule.kpiTarget, lte: value <= rule.kpiTarget, gte: value >= rule.kpiTarget, gt: value > rule.kpiTarget })[rule.kpiOperator];
          amount = valid ? rate * fraction : 0; detail = `${rule.inputKey} ${value ?? "missing"} ${rule.kpiOperator} ${rule.kpiTarget}; bonus ${rate} × ${fraction}`;
          if (value === undefined) errors.push({ id: `${rule.id}-${staff.id}-kpi`, staffId: staff.id, kind: "missing-input", severity: "blocking", message: `${staff.name}: ${rule.name} needs KPI ${rule.inputKey}.` }); break;
        }
        case "guarantee": {
          if (result.some(r => r.ruleId === rule.id && r.staffId === staff.id)) return;
          const earned = (salaries.get(staff.id) ?? 0) + result.filter(r => r.staffId === staff.id).reduce((s, r) => s + r.amount, 0);
          const monthDates = datesIn(month).filter(d => employed(staff.payrollProfile!, d));
          let floor = 0, coverage = 0, cap = 0;
          const qualifyingDates: string[] = [];
          const pieces: string[] = [];
          for (const v of active.filter(v => v.ruleId === rule.id && v.terms.kind === "guarantee")) {
            const eligible = monthDates.filter(d => d >= v.effectiveFrom && (!v.effectiveTo || d <= v.effectiveTo));
            for (const d of eligible) {
              const a = assignmentFor(data, doc, rule.id, staff, d);
              if (!a) continue;
              qualifyingDates.push(d);
              const share = 1 / (v.terms.partMonth === "prorate" ? datesIn(month).length : monthDates.length || 1);
              floor += (a.personalRate ?? v.terms.rate) * share; coverage += 1 / (monthDates.length || 1);
              cap += v.terms.cap === null ? Infinity : v.terms.cap * share;
              trace = { version: v.version, rule: structuredClone(v.terms), assignment: structuredClone(a), from: eligible[0], to: eligible.at(-1)! };
            }
            pieces.push(`version ${v.version}: minimum ${v.terms.rate} for ${eligible.length} days`);
          }
          amount = Math.min(cap, Math.max(0, floor - earned * coverage));
          qualifyingDates.sort();
          trace = { ...trace, from: qualifyingDates[0] ?? trace.from, to: qualifyingDates.at(-1) ?? trace.to, dates: qualifyingDates };
          detail = `${pieces.join("; ")}; max(0, weighted minimum ${floor.toFixed(2)} − salary and incentives ${earned.toFixed(2)} × ${coverage.toFixed(4)})`; break;
        }
        case "manual": {
          const last = datesIn(month).filter(d => employed(staff.payrollProfile!, d) && assignmentFor(data, doc, rule.id, staff, d) &&
            active.some(v => v.ruleId === rule.id && v.terms.kind === "manual" && d >= v.effectiveFrom && (!v.effectiveTo || d <= v.effectiveTo))).at(-1);
          if (!last || !segment.dates.includes(last)) return;
          const bonus = input?.bonuses?.[rule.id]; amount = bonus?.amount ?? 0; detail = bonus?.reason ?? "No one-off bonus entered";
          if (amount && !bonus?.reason.trim()) errors.push({ id: `${rule.id}-${staff.id}-reason`, staffId: staff.id, kind: "missing-reason", severity: "blocking", message: `${staff.name}: manual bonus needs a reason.` }); break;
        }
      }
      if (!targetMet) detail = `Target not met: ${base.toFixed(2)} must exceed ${rule.target}. ${detail}`;
      const cap = rule.kind === "team-days" || rule.kind === "unit-pool" || rule.kind === "guarantee" ? null : rule.cap === null ? null : rule.cap * (rule.kind === "manual" ? 1 : fraction);
      amount = money(valid ? (cap === null ? amount : Math.min(amount, cap)) : 0);
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid incentive ${rule.name}.`);
      result.push({ ruleId: rule.id, name: rule.name, staffId: staff.id, amount, formula: `Version ${version.version} (${segment.dates[0]} to ${segment.dates.at(-1)}): ${detail} = ${amount.toFixed(2)}${rule.cap !== null ? `; cap ${rule.cap}` : ""}`, targetMet: valid, base, units,
        rewardTrace: trace });
      if (!targetMet) errors.push({ id: `target-${rule.id}-${staff.id}`, staffId: staff.id, kind: "target-missed", severity: "warning", message: `${rule.name}: ${base.toFixed(2)} did not exceed ${rule.target}${rule.target && base >= rule.target * 0.95 ? " (just missed)" : ""}.` });
    });
  }
  return result;
}
