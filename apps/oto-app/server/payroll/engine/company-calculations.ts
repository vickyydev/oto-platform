import type { BranchId, PayrollWorld, StaffMember } from "./model";
import { allocationAt, profileReviewWarnings, validatePayrollProfile } from "./payroll-profile";
import { calculateMonthEnd as legacyCalculation } from "./run-calculations";
import { calculatePayrollPreview, calculateStaffWithExtras, cumulativeTax, effectiveRulesForMonth } from "./calculations";
import { computeEwf } from "./ewf-engine";
import { calculateDeductionForStaff } from "./deductions";
import { companyLineSources } from "./company-sources";
import { calculateCompanyIncentives, calculateCompanyService } from "./company-awards";
import { thaiIdValid } from "./upload-common";
import { bankCode } from "./scb-upload-files";
import { sanitizeFormula } from "./company-pay-explanation";
import { ewfFilingIssues } from "./ewf-upload-file";
import { SSO_TITLES } from "./statutory-upload-files";
import { apportion, datesIn, employed, homeBranch, money, monthDays, previousMonth, splitEarning, workedUnits } from "./company-math";
import type { CompanyCalculation, CompanyPayLine, CompanyPayrollDocument, CompanyPerson, CompanyResult, CompanySummary, MoneyAllocation, PayrollException } from "./company-model";

const emptyTotals = (): CompanySummary => ({ gross: 0, deductions: 0, net: 0, employer: 0, totalCost: 0 });
const sum = (lines: CompanyPayLine[], category: CompanyPayLine["category"]) => money(lines.filter(l => l.category === category).reduce((s, l) => s + l.amount, 0));
export function companySourceSignature(data: PayrollWorld, doc: CompanyPayrollDocument, month: string): string {
  const source = JSON.stringify({
    engine: "company-payroll-source-evidence-v8",
    profiles: Object.values(data.branches).flatMap(b => b.staff),
    incentiveAssignments: doc.incentiveAssignments, incentiveVersions: doc.incentiveVersions,
    branches: Object.values(data.branches).map(b => ({ details: b.detailsHistory, rules: b.rulesHistory, deductions: b.deductionRules })),
    ewf: data.ewfSettings,
    leaveLedger: data.leaveLedger, otBankBookings: data.otBankBookings,
    leaveOffboarding: data.leaveOffboarding, leaveNegativeDecisions: data.leaveNegativeDecisions,
    accounts: data.payingAccounts, policies: doc.servicePolicies, incentives: doc.incentives,
    months: [doc.months[month], doc.months[previousMonth(month)]],
    attendance: data.attendance.filter(d => d.date.startsWith(month) || d.date.startsWith(previousMonth(month))),
    runs: Object.values(doc.runs).filter(r => r.month === month && (Object.keys(r.attendance).length || r.overrides.length || r.manual.length || r.payDate || Object.keys(r.thirdPartyApprovals ?? {}).length)).map(r => ({ entityId: r.entityId, payDate: r.payDate, attendance: r.attendance, overrides: r.overrides, manual: r.manual, thirdPartyApprovals: r.thirdPartyApprovals })),
    overtimeDecisions: Object.entries(data.runDrafts).filter(([key]) => key.endsWith(month)).map(([key, r]) => ({ key, overtimeDecisions: r.overtimeDecisions })),
    history: doc.snapshots.filter(s => s.month < month).map(s => ({ entity: s.entityId, month: s.month, version: s.version, people: s.result.people.map(p => ({ id: p.id, gross: p.gross, deductions: p.deductions, net: p.net })) })),
  });
  let h = 2166136261;
  for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 16777619);
  return `${(h >>> 0).toString(16)}:${source.length}`;
}
export function calculateCompanyEngine(data: PayrollWorld, doc: CompanyPayrollDocument, month: string): CompanyCalculation {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid payroll month.");
  const exceptions: PayrollException[] = [];
  const all = Object.values(data.branches).flatMap(b => b.staff);
  if (new Set(all.map(s => s.id)).size !== all.length) throw new Error("Duplicate employee identities across branches.");
  const staff = all.filter(s => !!s.payrollProfile);
  for (const s of all) {
    if (!s.payrollProfile) exceptions.push({ id: `${s.id}-profile`, staffId: s.id, severity: "blocking", kind: "profile", message: `${s.name}: missing payroll profile.` });
    else validatePayrollProfile(s.payrollProfile, data).forEach((message, i) => exceptions.push({ id: `${s.id}-profile-${i}`, staffId: s.id, severity: "blocking", kind: "profile", message: `${s.name}: ${message}` }));
  }
  if (exceptions.some(e => e.kind === "profile" && !all.find(s => s.id === e.staffId)?.payrollProfile)) throw new Error("All employees need payroll profiles before a company run.");
  const services = calculateCompanyService(data, doc, month, staff, exceptions);
  const reviews = new Map(Object.values(doc.runs).filter(r => r.month === month).flatMap(r => Object.entries(r.attendance)));
  const shadow: PayrollWorld = {
    ...data, runSnapshots: [], companyPayroll: undefined,
    branches: Object.fromEntries(Object.entries(data.branches).map(([id, b]) => [id, { ...b,
      // Profiles now hold the per-person decision; legacy role defaults must not veto it.
      rulesHistory: b.rulesHistory.map(r => ({ ...r, overtimeEligibilityByRole:
        Object.fromEntries(Object.keys(r.overtimeEligibilityByRole).map(role => [role, true])) as typeof r.overtimeEligibilityByRole })),
      staff: b.staff.map(s => {
      const p = s.payrollProfile; return p ? { ...s, monthlySalary: p.workerType === "day-rate" ? null : p.workerType === "contractor" ? p.fixedFee : p.monthlySalary,
        dayRate: p.workerType === "day-rate" ? p.dayRate : null, joinedOn: p.joinedOn, leftOn: p.lastWorkingDay,
        otEligible: p.otEligible, serviceChargeEligible: p.serviceChargeEligible } : s;
    }) }])) as PayrollWorld["branches"],
    attendance: data.attendance.map(d => {
      const review = reviews.get(d.id);
      return review ? { ...d, effectiveClockIn: review.clockIn ?? d.effectiveClockIn, effectiveClockOut: review.clockOut ?? d.effectiveClockOut,
        exceptions: d.exceptions.map(e => e.resolution === null ? { ...e,
          resolution: review.action === "override" ? "Corrected" as const : review.action === "excuse" ? "Excused" as const : "Approved" as const,
          ...(review.action === "override" ? { effectiveClockIn: review.clockIn ?? e.effectiveClockIn, effectiveClockOut: review.clockOut ?? e.effectiveClockOut } : {}),
          reason: review.reason, approvedBy: review.who } : e) } : d;
    }),
  };
  const legacy = new Map((Object.keys(data.branches) as BranchId[]).map(id => [id, legacyCalculation(shadow, id, month, data.runDrafts[`${id}:${month}`] ?? {})]));
  const salaries = new Map<string, number>(), linesByPerson = new Map<string, CompanyPayLine[]>();
  for (const s of staff) {
    const p = s.payrollProfile!, employedDates = datesIn(month).filter(d => employed(p, d));
    const work = workedUnits(shadow, doc, s, month);
    const lines: CompanyPayLine[] = [];
    linesByPerson.set(s.id, lines);
    if (!employedDates.length && !services.some(b => b.people.some(person => person.staffId === s.id && person.amount))) continue;
    const dayWeights = employedDates.map(date => ({ date, weight: 1 }));
    const homeBranchRecord = Object.values(data.branches).find(b => b.staff.some(member => member.id === s.id))!;
    const payRules = effectiveRulesForMonth(homeBranchRecord, month);
    const divisor = payRules.calendarProration.method === "fixed-divisor" ? payRules.calendarProration.divisor : monthDays(month);
    const monthlyFraction = employedDates.length === monthDays(month) ? 1 : Math.min(1, employedDates.length / divisor);
    // PAYROLL-CONCERN-4 (SCRUM-564): day-rate pay counts WORKED days here; the older engine counts scheduled days (run-calculations.ts:853, unpaid). This answer pays.
    const salary = money(p.workerType === "day-rate" ? p.dayRate * work.total
      : (p.workerType === "contractor" ? p.fixedFee : p.monthlySalary) * monthlyFraction);
    salaries.set(s.id, salary);
    const add = (component: string, label: string, amount: number, formula: string, weights = dayWeights, taxable = true, ssoWage = true) => {
      if (!weights.length && amount) throw new Error(`${s.name}: earning has no effective employment allocation.`);
      lines.push({ id: component, component, label, category: "earning", amount: money(amount), formula, inputs: [formula], sourceMonth: month,
        allocations: weights.length ? splitEarning(data, p, amount, weights) : [], taxable, ssoWage });
    };
    add("salary", p.workerType === "contractor" ? "Fixed fee" : p.workerType === "day-rate" ? "Day-rate pay" : "Salary", salary,
      p.workerType === "day-rate" ? `${p.dayRate} × ${work.total} worked days` : `${p.workerType === "contractor" ? p.fixedFee : p.monthlySalary} × ${monthlyFraction === 1 ? "1 full month" : `${employedDates.length}/${divisor} calendar days`}`,
      p.workerType === "day-rate" ? work.dates.map(date => ({ date, weight: work.perDate })) : dayWeights);
    if (p.foodAllowanceEligible) add("food", "Food allowance", p.foodAllowancePerDay * work.total, `${p.foodAllowancePerDay} × ${work.total} worked days`,
      work.dates.map(date => ({ date, weight: work.perDate })), false, false);
    const sourceBranch = Object.values(data.branches).find(b => b.staff.some(person => person.id === s.id))!;
    const rules = effectiveRulesForMonth(data.branches[homeBranch(p, month)], month);
    // PAYROLL-CONCERN-4 (SCRUM-564): fixed allowances prorate by actual days in the month, ignoring the configured divisor the older engine uses (run-calculations.ts:868, unpaid). This answer pays.
    if (p.workerType === "monthly" || p.workerType === "owner-household") for (const a of rules.allowances) add(`fixed:${a.id}`, a.name, a.amount * employedDates.length / monthDays(month), `${a.amount} × ${employedDates.length}/${monthDays(month)} calendar days`, dayWeights, a.taxable, a.socialSecurity);
    const old = legacy.get(sourceBranch.id)?.rows.find(r => r.staffId === s.id);
    const ot = old?.lines.filter(l => l.kind === "overtime").reduce((n, l) => n + l.amount, 0) ?? 0;
    if (ot && p.otEligible) add("overtime", "Approved overtime / holiday premium", ot, old?.lines.find(l => l.kind === "overtime")?.formula ?? "Dated approved OT policy");
    for (const item of old?.lines.filter(l => l.kind === "leave-payout" || l.kind === "ot-bank-payout" || l.kind === "unpaid-leave") ?? []) {
      if (!item.amount || !dayWeights.length) continue;
      add(`${item.kind}:${item.id}`, item.name, item.kind === "unpaid-leave" ? -item.amount : item.amount, item.formula, dayWeights, item.taxable, item.socialSecurity);
      if (item.kind === "unpaid-leave") salaries.set(s.id, Math.max(0, money((salaries.get(s.id) ?? 0) - item.amount)));
    }
    for (const b of services) {
      const award = b.people.find(person => person.staffId === s.id);
      if (!award?.eligible || !award.amount) continue;
      const weights = datesIn(b.earningMonth).filter(date => employed(p, date)).map(date => ({ date, weight: 1 }));
      // Preserve exact historical allocation/entity/account proportions without rounding a synthetic one-baht amount.
      const historical = new Map<string, MoneyAllocation & { weight: number }>();
      for (const { date } of weights) for (const a of allocationAt(p, date)?.lines.filter(l => l.costCentre === b.branchId) ?? []) {
        const part = splitEarning(data, p, 100, [{ date, weight: 1 }]).find(l => l.costCentre === a.costCentre && l.entityId === a.entityId);
        const key = `${a.costCentre}|${a.entityId}|${part?.payingAccountId ?? ""}`;
        const v = historical.get(key) ?? { costCentre: a.costCentre, entityId: a.entityId, payingAccountId: part?.payingAccountId ?? null, amount: 0, weight: 0 };
        v.weight += a.percent; historical.set(key, v);
      }
      const buckets = Array.from(historical.values());
      const amounts = apportion(award.amount, buckets.map(a => a.weight));
      lines.push({ id: `sc:${b.branchId}`, component: "sc", label: sanitizeFormula(`Service charge · ${b.branchId}`, data.costCentreNames), category: "earning", amount: award.amount,
        formula: b.details?.[s.id] ?? `${award.units.toFixed(4)} ${b.basis} units × ${b.dayRate.toFixed(6)} = ${award.amount.toFixed(2)}; ${b.earningMonth}`,
        inputs: [`Pool ${b.pool}; denominator ${b.denominator}; retained ${b.retained}`, `Revenue ex-VAT/ex-SC ${b.revenueBase} × ${b.percent}%`],
        sourceMonth: b.earningMonth, allocations: buckets.map((a, i) => ({ costCentre: a.costCentre, entityId: a.entityId, payingAccountId: a.payingAccountId, amount: amounts[i] })), taxable: true, ssoWage: rules.componentFlags.serviceCharge.socialSecurity });
    }
    for (const separate of p.separatePayments) add(`separate:${separate.id}`, separate.description, separate.amount * employedDates.length / monthDays(month),
      `${separate.amount} separate payment × ${employedDates.length}/${monthDays(month)}; withholding ${separate.withholdingPercent}%`, dayWeights, false, false);
  }
  const incentives = calculateCompanyIncentives(shadow, doc, month, staff, salaries, exceptions);
  for (const award of incentives) {
    const s = staff.find(s => s.id === award.staffId)!, p = s.payrollProfile!;
    const rule = doc.incentives.find(r => r.id === award.ruleId)!;
    const dates = award.rewardTrace?.dates ?? datesIn(month).filter(date => employed(p, date) && date >= (award.rewardTrace?.from ?? rule.effectiveFrom) && date <= (award.rewardTrace?.to ?? rule.effectiveTo ?? `${month}-31`));
    linesByPerson.get(s.id)!.push({ id: `incentive:${award.ruleId}:${award.rewardTrace?.version ?? 1}:${award.rewardTrace?.assignment.id ?? s.id}`, component: `incentive:${award.ruleId}`, label: award.name,
      category: "earning", amount: award.amount, formula: award.formula, inputs: [award.formula], sourceMonth: month,
      allocations: splitEarning(data, p, award.amount, dates.map(date => ({ date, weight: 1 }))), taxable: true, ssoWage: false, rewardTrace: award.rewardTrace });
  }
  for (const draft of Object.values(doc.runs).filter(r => r.month === month)) for (const manual of draft.manual) {
    if (!manual.reason.trim() || !Number.isFinite(manual.amount) || manual.amount < 0) throw new Error("Manual amounts require a positive amount and reason.");
    const s = staff.find(s => s.id === manual.staffId); if (!s) throw new Error("Unknown manual-adjustment employee.");
    const weights = datesIn(month).filter(d => employed(s.payrollProfile!, d)).map(date => ({ date, weight: 1 }));
    const allocations = splitEarning(data, s.payrollProfile!, manual.amount, weights).filter(l => l.entityId === draft.entityId);
    linesByPerson.get(s.id)!.push({ id: `manual:${manual.id}`, component: manual.kind === "bonus" ? "manual" : "other", label: `Manual ${manual.kind}`,
      category: manual.kind === "bonus" ? "earning" : "deduction", amount: money(allocations.reduce((n, l) => n + l.amount, 0)),
      formula: manual.reason, inputs: [manual.reason], sourceMonth: month, allocations, taxable: manual.kind === "bonus", ssoWage: false });
  }
  // Apply earning overrides BEFORE rebuilding all statutory bases.
  for (const draft of Object.values(doc.runs).filter(r => r.month === month)) for (const override of draft.overrides) {
    const lines = linesByPerson.get(override.staffId) ?? [];
    const staffMember = staff.find(s => s.id === override.staffId);
    if (!staffMember || !override.reason.trim()) throw new Error("Overrides require a valid employee and a reason.");
    const profile = staffMember.payrollProfile!;
    const weights = employedDatesFor(profile, month).map(date => ({ date, weight: 1 }));
    const fallback = weights.length ? weights : [{ date: profile.lastWorkingDay ?? `${month}-01`, weight: 1 }];
    const entityAmount = (l: CompanyPayLine) => l.allocations.filter(a => a.entityId === override.entityId).reduce((n, a) => n + a.amount, 0);
    if (override.component === "gross") {
      const current = lines.filter(l => l.category === "earning").reduce((n, l) => n + entityAmount(l), 0);
      const delta = money(override.amount - current);
      const buckets = splitEarning(data, profile, Math.abs(delta), fallback).filter(a => a.entityId === override.entityId);
      const values = apportion(delta, buckets.map(a => Math.abs(a.amount) || 1));
      lines.push({ id: "gross-override", component: "manual", label: "Gross balancing override", category: "earning", amount: delta,
        formula: `${override.amount} target gross − ${current} calculated gross; ${override.reason}`, inputs: [override.reason], sourceMonth: month,
        allocations: buckets.map((a, i) => ({ ...a, amount: values[i] })), taxable: true, ssoWage: false, overridden: true });
      continue;
    }
    const matches = lines.filter(l => l.category === "earning" && l.component === override.component);
    if (!matches.length) {
      if (["salary", "food", "overtime", "sc", "manual"].includes(override.component) || override.component.startsWith("incentive:")) {
        const buckets = splitEarning(data, profile, override.amount, fallback).filter(a => a.entityId === override.entityId);
        const parts = apportion(override.amount, buckets.map(a => a.amount || 1));
        lines.push({ id: `override:${override.component}`, component: override.component, label: `Manual ${override.component} override`,
          category: "earning", amount: override.amount, formula: `Explicit override of absent component: ${override.reason}`, inputs: [override.reason], sourceMonth: month,
          allocations: buckets.map((a, i) => ({ ...a, amount: parts[i] })), taxable: override.component !== "food", ssoWage: override.component === "salary", overridden: true });
      }
      continue;
    }
    const buckets = matches.flatMap(l => l.allocations.filter(a => a.entityId === override.entityId));
    const amounts = apportion(override.amount, buckets.map(a => a.amount || 1));
    let i = 0;
    for (const line of matches) {
      line.allocations = line.allocations.map(a => a.entityId === override.entityId ? { ...a, amount: amounts[i++] } : a);
      line.amount = money(line.allocations.reduce((n, a) => n + a.amount, 0)); line.overridden = true;
      line.inputs.push(`Override: ${override.reason}`); line.formula = `Overridden to ${override.amount}: ${override.reason}`;
    }
  }
  const combined: CompanyPerson[] = [];
  // Reuse within this calculation only; a later edit gets a fresh shadow and previews.
  const deductionPreviews = new Map<BranchId, ReturnType<typeof calculatePayrollPreview>>();
  for (const s of staff) {
    const p = s.payrollProfile!, lines = linesByPerson.get(s.id)!;
    if (!lines.length) continue;
    const home = homeBranch(p, month), rules = effectiveRulesForMonth(data.branches[home], month), work = workedUnits(shadow, doc, s, month);
    const earnings = lines.filter(l => l.category === "earning"), allBuckets = earnings.flatMap(l => l.allocations);
    const primary = allBuckets.find(a => a.costCentre === home && a.amount > 0) ?? allBuckets.find(a => a.costCentre === "owner-non-operational") ?? allBuckets.find(a => a.amount > 0) ?? allBuckets[0];
    if (!primary) continue;
    const registeredEntity = data.branches[home].detailsHistory.at(-1)?.details.payingEntityId;
    const deduct = (component: string, label: string, amount: number, formula: string, category: "deduction" | "employer" = "deduction", allocations?: MoneyAllocation[]) => {
      lines.push({ id: component, component, label, category, amount: money(amount), formula, inputs: [formula], sourceMonth: month,
        allocations: allocations ?? [{ ...primary, amount: money(amount) }], taxable: false, ssoWage: false,
        registeredBranchId: home, remittingEntityId: registeredEntity });
    };
    const budgets = {
      salary: Math.max(0, earnings.filter(l => l.component === "salary").reduce((n, l) => n + l.amount, 0)),
      "service-charge": Math.max(0, earnings.filter(l => l.component === "sc").reduce((n, l) => n + l.amount, 0)),
    };
    const attendanceBranch = Object.values(shadow.branches).find(branch => branch.staff.some(person => person.id === s.id))!;
    for (const rule of shadow.branches[home].deductionRules) {
      let preview = deductionPreviews.get(attendanceBranch.id);
      if (!preview) {
        preview = calculatePayrollPreview(shadow, attendanceBranch.id, month);
        deductionPreviews.set(attendanceBranch.id, preview);
      }
      const charge = calculateDeductionForStaff(shadow, attendanceBranch.id, month, s.id, rule, budgets[rule.source], preview);
      budgets[rule.source] = money(Math.max(0, budgets[rule.source] - charge.total));
      if (charge.total) deduct(`attendance-rule:${rule.id}`, rule.name, charge.total,
        `${rule.source === "salary" ? "Salary" : "Service charge"} deduction: ${charge.steps.join("; ")}`);
    }
    let employeeSso = 0;
    if (rules.country === "TH") {
      const wage = Math.max(0, earnings.filter(l => l.ssoWage).reduce((n, l) => n + l.amount, 0));
      employeeSso = p.ssoEligible ? Math.round(Math.min(wage, rules.thSso.wageCap) * rules.thSso.employeeRate) : 0;
      deduct("sso", "SSO employee", employeeSso, `min(${wage.toFixed(2)}, ${rules.thSso.wageCap}) × ${rules.thSso.employeeRate * 100}%; registered ${home}`);
      deduct("employer-sso", "SSO employer", p.ssoEligible ? Math.round(Math.min(wage, rules.thSso.wageCap) * rules.thSso.employerRate) : 0, `${rules.thSso.employerRate * 100}% capped wage; registered ${home}`, "employer");
      const taxable = earnings.filter(l => l.taxable).reduce((n, l) => n + l.amount, 0);
      const regular = p.monthlySalary + rules.allowances.filter(a => a.taxable).reduce((n, a) => n + a.amount, 0);
      const canonical = { ...s, joinedOn: p.joinedOn, leftOn: p.lastWorkingDay };
      // PAYROLL-CONCERN-2 (SCRUM-564): PIT has no year-to-date input, so prior withholding is always the estimate baselineAnnualTax × periods; built as the prototype, awaiting the accountant's worked example.
      const tax = p.pnd1Eligible ? cumulativeTax("TH", canonical, rules, month, taxable, regular, employeeSso,
        p.ssoEligible ? Math.min(p.monthlySalary, rules.thSso.wageCap) * rules.thSso.employeeRate : 0, undefined) : { withholding: 0, steps: ["PND.1 disabled on profile"] };
      deduct("pnd1", "PND.1 PIT", tax.withholding, tax.steps.join(" "));
    } else {
      const source = Object.values(shadow.branches).find(b => b.staff.some(person => person.id === s.id))!;
      const statutory = calculateStaffWithExtras(shadow, source.id, month, s.id, earnings.filter(l => l.component === "sc").reduce((n, l) => n + l.amount, 0), {
        componentAmounts: { regularPay: p.workerType === "day-rate" ? 0 : salaries.get(s.id) ?? 0, casualDayPay: p.workerType === "day-rate" ? salaries.get(s.id) ?? 0 : 0,
          lunch: earnings.find(l => l.component === "food")?.amount ?? 0, overtime: earnings.find(l => l.component === "overtime")?.amount ?? 0,
          allowances: Object.fromEntries(rules.allowances.map(a => [a.id, earnings.find(l => l.component === `fixed:${a.id}`)?.amount ?? 0])) },
        incentives: earnings.filter(l => l.component.startsWith("incentive:")).map(l => ({ amount: l.amount, taxable: l.taxable, socialSecurity: l.ssoWage })),
      });
      deduct("my-statutory", "EPF / SOCSO / EIS", statutory.employeeStatutory, "Existing Malaysia statutory rules on profile-driven current wages");
      deduct("pnd1", "PCB", statutory.incomeTaxWithholding, statutory.steps.join(" "));
      deduct("my-employer", "Employer EPF / SOCSO / EIS / HRD", statutory.employerStatutory, "Existing Malaysia statutory rates", "employer");
    }
    const feeOnly = doc.months[month]?.staff[s.id]?.pnd3Basis === "fee-only";
    const feeLines = earnings.filter(l => feeOnly ? l.component === "salary" : !l.component.startsWith("separate:"));
    if (p.workerType === "contractor" && p.pnd3WithholdingPercent) {
      const total = money(feeLines.reduce((n, l) => n + l.amount, 0) * p.pnd3WithholdingPercent / 100);
      const buckets = feeLines.flatMap(l => l.allocations), parts = apportion(total, buckets.map(a => a.amount));
      deduct("pnd3", "PND.3 contractor withholding", total, `${feeLines.reduce((n, l) => n + l.amount, 0).toFixed(2)} ${feeOnly ? "fixed-fee-only" : "all non-separate earnings"} × ${p.pnd3WithholdingPercent}%`, "deduction", buckets.map((a, i) => ({ ...a, amount: parts[i] })));
    }
    for (const separate of p.separatePayments) {
      const line = earnings.find(l => l.component === `separate:${separate.id}`); if (!line) continue;
      const amount = money(line.amount * separate.withholdingPercent / 100), parts = apportion(amount, line.allocations.map(a => a.amount));
      deduct("pnd3", `PND.3 ${separate.description}`, amount, `${line.amount} × ${separate.withholdingPercent}% separate-payment withholding`, "deduction", line.allocations.map((a, i) => ({ ...a, amount: parts[i] })));
      lines.at(-1)!.id = `pnd3:${separate.id}`;
    }
    if (p.studentLoanMonthly) deduct("student-loan", "Student Loan Fund / กยศ.", p.studentLoanMonthly, `${p.studentLoanMonthly} monthly profile deduction; remit separately`);
    // PAYROLL-CONCERN-3 (SCRUM-564): advances repay min(regular, remaining) with no net-pay floor, no percent-of-net rule and the instalment count unused; built as the prototype.
    for (const advance of p.advances) if (advance.startsOn <= `${month}-${monthDays(month)}`) {
      const history = Array.from(new Map(doc.snapshots.filter(snap => snap.month < month)
        .sort((a, b) => a.version - b.version).map(snap => [`${snap.entityId}:${snap.month}`, snap])).values());
      const repaid = history.flatMap(snap => snap.result.people.filter(person => person.id === s.id))
        .flatMap(person => person.lines).filter(line => line.id === `advance:${advance.id}`).reduce((n, line) => n + line.amount, 0);
      const regular = advance.repaymentMode === "one-off" ? advance.outstandingBalance : advance.monthlyRepayment;
      const remaining = Math.max(0, advance.outstandingBalance - repaid);
      const amount = Math.min(regular, remaining);
      if (amount) {
        deduct("advance", "Salary advance repayment", amount, `Advance ${advance.id}: min(${regular}, opening balance ${advance.outstandingBalance} − locked repayments ${repaid}); no balance mutation on preview`);
        lines.at(-1)!.id = `advance:${advance.id}`;
      }
    }
    if (p.workerType === "contractor" && p.paymentMethod === "cash" && p.cashHandlingFeePercent) {
      const amount = money(sum(earnings, "earning") * p.cashHandlingFeePercent / 100), buckets = earnings.flatMap(l => l.allocations), parts = apportion(amount, buckets.map(a => a.amount));
      deduct("cash-fee", "Cash handling fee", amount, `${sum(earnings, "earning")} gross × ${p.cashHandlingFeePercent}%`, "deduction", buckets.map((a, i) => ({ ...a, amount: parts[i] })));
    }
    const source = Object.values(data.branches).find(b => b.staff.some(person => person.id === s.id))!;
    // PAYROLL-CONCERN-1 (SCRUM-564): attendance deductions are charged once, by the attendance-rule loop above.
    // The prototype also added an `other:<id>` line here for every `kind: "deduction"` line of the older
    // calculation — the same rules through the same `calculateDeductionForStaff` on the same corrected
    // attendance (prototype company-calculations.ts:275-283, run-calculations.ts:1171-1193) — so each
    // rule was charged twice. Owner ruling 2026-10-20: charge once; the park confirms at the next meeting.
    // No golden number moves (the golden sets `deductionRules: []`); the parity fixture declares the
    // difference (one fewer `other:deduction:*` line per rule per person).
    if (rules.country === "TH" && p.workerType !== "contractor") {
      const dates = employedDatesFor(p, month);
      const ewf = computeEwf(shadow, source.id, month, s.id, earnings.filter(l => !l.component.startsWith("separate:")).map(l => {
        const flag = rules.componentFlags[l.component === "salary" ? "baseSalary" : l.component === "sc" ? "serviceCharge" : l.component === "food" ? "lunch" : l.component];
        return { id: l.id, name: l.label, amount: Math.max(0, l.amount),
          countsAsWage: flag?.ewfWage ?? (l.component === "salary" || l.component.startsWith("fixed:")),
          reason: flag?.ewfReason ?? "Variable component classification requires accountant confirmation; prototype excludes by default.",
          ...(dates.length && l.sourceMonth === month ? { coversFrom: dates[0], coversThrough: dates.at(-1)! } : {}) };
      }));
      deduct("ewf", "EWF employee", ewf.employeeAmount, `${ewf.wageBase} eligible wages × ${ewf.employeeRate * 100}%; ${ewf.membershipProrationMethod}`);
      deduct("employer-ewf", "EWF employer", ewf.employerAmount, `${ewf.wageBase} × ${ewf.employerRate * 100}%`, "employer");
    }
    for (const draft of Object.values(doc.runs).filter(r => r.month === month)) for (const o of draft.overrides.filter(o => o.staffId === s.id)) {
      const current = (category: CompanyPayLine["category"]) => money(lines.filter(l => l.category === category).flatMap(l => l.allocations).filter(a => a.entityId === o.entityId).reduce((n, a) => n + a.amount, 0));
      if (["net", "employer", "total-cost"].includes(o.component)) {
        const isNet = o.component === "net";
        const delta = isNet ? money(current("earning") - current("deduction") - o.amount)
          : money(o.amount - current("employer") - (o.component === "total-cost" ? current("earning") : 0));
        const buckets = lines.filter(l => l.category === "earning").flatMap(l => l.allocations).filter(a => a.entityId === o.entityId);
        const values = apportion(delta, buckets.map(a => Math.abs(a.amount) || 1));
        lines.push({ id: `${o.component}-override`, component: isNet ? "other" : "employer-adjustment", category: isNet ? "deduction" : "employer",
          label: `${o.component} balancing override`, amount: delta, formula: `Target ${o.amount}; explicit post-statutory balancing adjustment: ${o.reason}`,
          inputs: ["This is a separate balancing correction, not an automatic tax/SSO rate change.", o.reason], sourceMonth: month,
          allocations: buckets.map((a, i) => ({ ...a, amount: values[i] })), taxable: false, ssoWage: false, overridden: true });
        continue;
      }
      const matches = lines.filter(l => l.category !== "earning" && l.component === o.component);
      if (!matches.length && !lines.some(l => l.category === "earning" && l.component === o.component)) {
        const allocation = lines.flatMap(l => l.allocations).find(a => a.entityId === o.entityId);
        if (!allocation) throw new Error("No entity allocation for this override.");
        deduct(o.component, `Manual ${o.component} override`, o.amount, o.reason, o.component.startsWith("employer-") ? "employer" : "deduction", [{ ...allocation, amount: o.amount }]);
        lines.at(-1)!.overridden = true;
        continue;
      }
      const buckets = matches.flatMap(l => l.allocations.filter(a => a.entityId === o.entityId)), parts = apportion(o.amount, buckets.map(a => a.amount || 1));
      let i = 0; for (const l of matches) { l.allocations = l.allocations.map(a => a.entityId === o.entityId ? { ...a, amount: parts[i++] } : a);
        l.amount = money(l.allocations.reduce((n, a) => n + a.amount, 0)); l.overridden = true; l.inputs.push(`Override: ${o.reason}`);
        l.formula = `Component override ${o.component} to ${o.amount}; this line ${l.amount}; ${o.reason}`; }
    }
    for (const line of lines) line.sources = companyLineSources(doc, s, line);
    for (const entityId of Array.from(new Set(lines.flatMap(l => l.allocations.map(a => a.entityId))))) {
      const entityLines = lines.map(l => ({ ...l, allocations: l.allocations.filter(a => a.entityId === entityId) })).filter(l => l.allocations.length)
        .map(l => ({ ...l, amount: money(l.allocations.reduce((n, a) => n + a.amount, 0)), remittingEntityId: l.component === "pnd3" ? entityId : l.remittingEntityId }));
      const gross = sum(entityLines, "earning"), deductions = sum(entityLines, "deduction"), employer = sum(entityLines, "employer");
      const costs = Array.from(new Set(entityLines.flatMap(l => l.allocations.map(a => a.costCentre)))).map(costCentre => {
        const amount = (category: CompanyPayLine["category"]) => money(entityLines.filter(l => l.category === category).flatMap(l => l.allocations).filter(a => a.costCentre === costCentre).reduce((n, a) => n + a.amount, 0));
        const g = amount("earning"), d = amount("deduction"), e = amount("employer");
        return { costCentre, entityId, gross: g, deductions: d, net: money(g - d), employer: e, totalCost: money(g + e) };
      });
      const accountIds = Array.from(new Set(entityLines.filter(l => l.category !== "employer").flatMap(l => l.allocations.map(a => a.payingAccountId))));
      const payments = accountIds.map(payingAccountId => {
        const amount = money(entityLines.filter(l => l.category !== "employer").reduce((n, l) => n + (l.category === "earning" ? 1 : -1) * l.allocations.filter(a => a.payingAccountId === payingAccountId).reduce((n, a) => n + a.amount, 0), 0));
        const account = data.payingAccounts?.find(a => a.id === payingAccountId);
        return { staffId: s.id, person: s.name, entityId, payingAccountId, method: p.paymentMethod, bank: { ...p.bankDetails }, reason: p.thirdPartyReason, amount,
          batch: p.paymentMethod === "cash" ? "cash" as const : account && ((bankCode(account) && bankCode(account) === bankCode(p.bankDetails)) || (!bankCode(account) && account.bank.toUpperCase() === p.bankDetails.bank.toUpperCase())) ? "same-bank" as const : "other-bank" as const };
      });
      const prior = doc.snapshots.filter(snap => snap.entityId === entityId && snap.month < month && snap.month.slice(0, 4) === month.slice(0, 4));
      const latest = Array.from(new Map(prior.sort((a, b) => a.version - b.version).map(snap => [snap.month, snap])).values());
      const priorRows = latest.flatMap(snap => snap.result.people.filter(person => person.id === s.id));
      const components: Record<string, number> = {};
      entityLines.forEach(l => { components[l.component] = money((components[l.component] ?? 0) + l.amount); });
      const warnings = profileReviewWarnings(data, s);
      if (!employedDatesFor(p, month).length && earnings.some(l => l.component === "sc" && l.amount)) warnings.push("Post-employment service-charge payout");
      if (rules.country === "TH" && p.ssoEligible && (!thaiIdValid(p.taxId) || !SSO_TITLES.includes(p.ssoTitle ?? "") || !p.givenName?.trim()))
        warnings.push("SSO filing: valid 13-digit ID, title and given name required");
      const ewfFiling = { dateOfBirth: p.dateOfBirth, nationality: p.nationality, passportNumber: p.passportNumber, leavingReason: p.leavingReason, title: p.ssoTitle, givenName: p.givenName, surname: p.surname };
      if (entityLines.some(l => (l.component === "ewf" || l.component === "employer-ewf") && l.amount > 0)) {
        const filingProblems = ewfFilingIssues(ewfFiling, p.taxId, p.joinedOn, p.lastWorkingDay, month);
        if (filingProblems.length) warnings.push(`EWF filing: ${filingProblems.join("; ")} — excluded until fixed`);
      }
      const priorMonthRow = latest.find(snap => snap.month === previousMonth(month))?.result.people.find(person => person.id === s.id);
      if (priorMonthRow && Math.abs(money(gross - deductions) - priorMonthRow.net) / Math.max(1, Math.abs(priorMonthRow.net)) > 0.15) warnings.push("Net pay changed more than 15% versus last locked month");
      if (gross - deductions <= 0) warnings.push("Zero or negative net pay");
      const person: CompanyPerson = { id: s.id, name: s.name, jobTitle: p.jobTitle, entityId, homeBranchId: home,
        currency: rules.country === "TH" ? "THB" : "MYR", workerType: p.workerType, taxId: p.taxId, ssoNumber: p.ssoNumber, joinedOn: p.joinedOn, lastWorkingDay: p.lastWorkingDay,
        notes: p.notes, department: p.department, ewfFiling, allocationBadge: allocationAt(p, `${month}-${monthDays(month)}`)?.lines.map(l => `${l.percent}`).join("/") ?? "",
        daysWorked: work.total, employedDays: employedDatesFor(p, month).length, prorationDivisor: rules.calendarProration.method === "fixed-divisor" ? rules.calendarProration.divisor : monthDays(month), lines: entityLines, gross, deductions, net: money(gross - deductions), employer, totalCost: money(gross + employer),
        components, costs, payments, warnings, ytd: { gross: money(gross + priorRows.reduce((n, r) => n + r.gross, 0)), deductions: money(deductions + priorRows.reduce((n, r) => n + r.deductions, 0)),
          net: money(gross - deductions + priorRows.reduce((n, r) => n + r.net, 0)), months: [...latest.filter(snap => snap.result.people.some(r => r.id === s.id)).map(snap => snap.month), month] } };
      combined.push(person);
      warnings.forEach((message, i) => exceptions.push({ id: `${entityId}-${s.id}-warning-${i}`, staffId: s.id, entityId, branchId: home, severity: "warning", kind: /^(SSO|EWF) filing:/.test(message) ? "missing-details" : /third/i.test(message) ? "third-party" : "profile-review", message: `${s.name}: ${message}` }));
      if (p.joinedOn.startsWith(month) || p.lastWorkingDay?.startsWith(month)) exceptions.push({ id: `${entityId}-${s.id}-proration`, staffId: s.id, entityId, branchId: home, severity: "info", kind: "proration", message: `${s.name}: paid for ${person.employedDays} of ${person.prorationDivisor} days.` });
      payments.forEach((pay, i) => { if (pay.amount < 0 || !pay.payingAccountId) exceptions.push({ id: `${entityId}-${s.id}-payment-${i}`, staffId: s.id, entityId, severity: "blocking", kind: "payment", message: `${s.name}: negative transfer or missing paying account.` }); });
    }
  }
  for (const day of data.attendance.filter(d => d.date.startsWith(month) && d.exceptions.some(e => e.resolution === null) && !reviews.has(d.id))) {
    exceptions.push({ id: `attendance-${day.id}`, staffId: day.staffId, branchId: day.branchId, severity: "blocking", kind: "attendance", message: `${day.staffId}: unconfirmed attendance ${day.date}` });
  }
  for (const service of services) {
    for (const person of service.people) person.amount = money(combined.filter(p => p.id === person.staffId).flatMap(p => p.lines)
      .filter(l => l.id === `sc:${service.branchId}` || (l.component === "sc" && l.allocations.some(a => a.costCentre === service.branchId)))
      .flatMap(l => l.allocations).filter(a => a.costCentre === service.branchId).reduce((n, a) => n + a.amount, 0));
    service.paid = money(service.people.reduce((n, a) => n + a.amount, 0));
    if (money(service.pool - service.paid - service.retained) !== 0 || (service.pool > 0 && !service.denominator)) exceptions.push({
      id: `sc-reconciliation-${service.branchId}`, branchId: service.branchId, severity: !service.denominator ? "blocking" : "warning", kind: "sc-reconciliation",
      message: `${service.branchId}: pool ${service.pool}, paid ${service.paid}, retained ${service.retained}; review undistributed/overridden share.`,
    });
  }
  const entities: CompanyResult[] = (data.payingEntities ?? []).map(entity => {
    const people = combined.filter(p => p.entityId === entity.id);
    const totals = people.reduce((t, p) => ({ gross: money(t.gross + p.gross), deductions: money(t.deductions + p.deductions), net: money(t.net + p.net), employer: money(t.employer + p.employer), totalCost: money(t.totalCost + p.totalCost) }), emptyTotals());
    const branches = new Set(people.flatMap(p => p.costs.map(c => c.costCentre)));
    return { entityId: entity.id, name: entity.name, month, currency: entity.country === "TH" ? "THB" : "MYR", people, totals, payments: people.flatMap(p => p.payments),
      exceptions: exceptions.filter(e => e.entityId ? e.entityId === entity.id : e.staffId ? people.some(p => p.id === e.staffId) : !e.branchId || branches.has(e.branchId)) };
  });
  return { month, entities, service: services, incentives, exceptions, signature: companySourceSignature(data, doc, month) };
}
const employedDatesFor = (p: NonNullable<StaffMember["payrollProfile"]>, month: string) => datesIn(month).filter(d => employed(p, d));
