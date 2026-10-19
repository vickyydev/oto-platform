import { isCasualStaff } from "./model";
import type {
  AttendanceDay,
  BranchId,
  BranchRecord,
  CountryCode,
  PayrollWorld,
  RevenueMonth,
  StaffMember,
  StatutoryRules,
  TaxBracket,
} from "./model";
import {
  MALAYSIA_DEFAULT_RESIDENT_PCB_BRACKETS,
  THAI_DEFAULT_PIT_BRACKETS,
} from "./defaults";
import { overtimePolicyForRole, roundedOvertimeHours } from "./ot-bank";

export const PAYROLL_FORMULA_DESCRIPTIONS = {
  periodSelection: "All dated branch details and statutory/pay rules are selected as the latest effective-from month on or before the payroll month. Later-dated changes never alter an earlier preview.",
  calendarProration: "Monthly salary and fixed monthly allowances use employed calendar days (inclusive) divided by the configured actual-month or fixed divisor, capped at one full monthly amount.",
  casualPay: "Casual base pay is day rate multiplied by scheduled attendance days in the payroll month.",
  lunch: "Role lunch amount is multiplied by scheduled working days in the payroll month; off days do not receive lunch.",
  overtime: "Monthly-staff hourly rate is monthly base salary / configured monthly salary days / configured hours per day; casual hourly rate is day rate / configured casual hours per day. Staff must be individually eligible and their role enabled. Regular OT uses its configured multiplier (default 1.5×); public-holiday OT uses its separate configured multiplier (default 3×). Scheduled public-holiday base hours receive an incremental max(0, rest-day multiplier − 1)× premium, so default 2× rest-day settings produce 2× total pay including the already-counted base.",
  serviceCharge: "The selected revenue streams from the service earning month are summed and multiplied by the service rate. It is paid after the configured whole-month lag and distributed only among eligible staff using the selected allocation weights.",
  thaiSso: "Thai employee SSO uses the effective-dated employee rate on eligible social-security wages capped at the configured wage cap, rounded to a whole baht half-up. Employer SSO is always exactly the same rounded amount as employee SSO.",
  thaiEwf: "Thai Employee Welfare Fund contributions apply only from October 2026 when the legal entity meets its effective headcount/voluntary rule and the individual is not exempt through provident-fund membership. The employee and employer rates apply to uncapped, per-person eligible wages after unpaid salary reduction and are each rounded to cents. The employee contribution is not an additional PIT deduction.",
  thaiPit: "Thai annual progressive PIT uses the effective-dated editable brackets, employment-expense rate and cap, personal allowance, and annual employee SSO. Monthly withholding is cumulative against projected annual tax.",
  malaysiaEpf: "Malaysian EPF employee/employer rates are applied to eligible wages: local 11% employee; employer rate at/below the configured wage threshold (default MYR 5,000) or above it; foreign worker 2% each.",
  malaysiaSocsoEis: "SOCSO wages and EIS wages are capped at MYR 6,000. Locals below age 60 use SOCSO 0.5%/1.75% and EIS 0.2%/0.2%; the configured foreign-worker SOCSO rate is employer-only 1.25%.",
  malaysiaPcb: "Resident PCB is cumulative progressive annual tax using the effective-dated editable brackets and configured self relief (default MYR 9,000). Non-resident PCB is the effective-dated configured rate (default 30%) of current taxable monthly pay. This prototype is an estimate, not a filing calculation.",
  cumulativeWithholding: "Annual projected taxable income includes supplied actual YTD taxable pay when present, this month's taxable pay, and projected remaining regular monthly pay. Without actual YTD inputs, prior income and prior withholding are estimated from the regular-pay baseline—not the current recalculated tax—so variable pay changes the cumulative result. Incentive/service/OT amounts from this month are not repeated in future months.",
  publicHolidayPay: "The monthly/day-rate base already pays scheduled public-holiday hours once. Add max(0, configured rest-day multiplier − 1) × hourly rate × scheduled holiday base hours; the default rest-day multiplier of 2× makes total scheduled holiday pay 2× including base. Approved public-holiday overtime uses its separate configured multiplier (default 3×); regular overtime remains at its configured multiplier (default 1.5×).",
} as const;

export const THAI_PIT_BRACKETS = structuredClone(THAI_DEFAULT_PIT_BRACKETS);
export const MALAYSIA_RESIDENT_TAX_BRACKETS = structuredClone(MALAYSIA_DEFAULT_RESIDENT_PCB_BRACKETS);

/** Explicit prototype assumptions: estimates are illustrative, not statutory advice. */
export const PAYROLL_ASSUMPTIONS = [
  "Thai personal tax brackets use the standard progressive bands published for individual income tax; no spouse, child, insurance, charity, or other personal deductions are modeled.",
  "Malaysia resident tax bands use the supplied progressive planning schedule and MYR 9,000 self relief only; additional reliefs, rebates, zakat and rounding tables are not modeled.",
  "The seeded Malaysian foreign-worker profile is explicitly marked non-resident for the 30% PCB illustration; actual tax residency depends on the person's facts.",
  "The employer HRD levy is modeled at the configured rate only when enabled and the Malaysian employee headcount is at least 10; this seeded 8-person branch has 7 Malaysian employees.",
  "All seeded Malaysian local staff are assumed to be below age 60 for SOCSO/EIS contribution examples.",
  "Rates and contribution bases are configured demo assumptions. MY contributions are rounded to cents; TH employee and employer SSO are identical whole-baht half-up amounts.",
  "Thai EWF is an illustrative effective-dated estimate: employee and employer shares use each frozen component manifest, entity headcount, and recorded individual provident-fund membership. Do not use it as a legal or filing determination.",
  "A fixed salary and fixed allowances are projected forward for annual withholding; variable service charge, overtime and other current-period spikes are not repeated in future months.",
  "Revenue values and attendance records are fictional; seed periods are the latest completed months at creation and then remain stable in saved browser data. Daily schedules use a five-day pattern for regular staff and a three-day pattern for casuals; two illustrative public-holiday shifts are represented.",
  "Payroll has no live data integration, bank export, tax filing, legal determination, or payment authority.",
] as const;

const LEGACY_THAI_PIT_BRACKETS = [
  { from: 0, to: 150000, rate: 0 },
  { from: 150000, to: 300000, rate: 0.05 },
  { from: 300000, to: 500000, rate: 0.1 },
  { from: 500000, to: 750000, rate: 0.15 },
  { from: 750000, to: 1000000, rate: 0.2 },
  { from: 1000000, to: 2000000, rate: 0.25 },
  { from: 2000000, to: 5000000, rate: 0.3 },
  { from: 5000000, to: Number.POSITIVE_INFINITY, rate: 0.35 },
] as const;

const LEGACY_MALAYSIA_RESIDENT_TAX_BRACKETS = [
  { from: 0, to: 5000, rate: 0 },
  { from: 5000, to: 20000, rate: 0.01 },
  { from: 20000, to: 35000, rate: 0.03 },
  { from: 35000, to: 50000, rate: 0.06 },
  { from: 50000, to: 70000, rate: 0.11 },
  { from: 70000, to: 100000, rate: 0.19 },
  { from: 100000, to: 400000, rate: 0.25 },
  { from: 400000, to: 600000, rate: 0.26 },
  { from: 600000, to: 2000000, rate: 0.28 },
  { from: 2000000, to: Number.POSITIVE_INFINITY, rate: 0.3 },
] as const;

export interface PriorYearToDate {
  taxableIncome: number;
  withheld: number;
  employeeSocialSecurity: number;
}

export interface PayrollPreviewOptions {
  /** Optional actual YTD figures for a more precise cumulative withholding preview. */
  priorYearToDate?: Record<string, PriorYearToDate>;
}

export interface StaffPayrollPreview {
  staffId: string;
  name: string;
  role: string;
  currency: "THB" | "MYR";
  regularPay: number;
  casualDayPay: number;
  allowances: number;
  lunch: number;
  overtime: number;
  serviceCharge: number;
  grossPay: number;
  employeeStatutory: number;
  statutoryBreakdown: {
    employee: { sso: number; epf: number; socso: number; eis: number; ewf: number };
    employer: { sso: number; epf: number; socso: number; eis: number; hrd: number; ewf: number };
  };
  incomeTaxWithholding: number;
  netPay: number;
  employerStatutory: number;
  steps: string[];
}

export interface StaffCalculationExtras {
  /** Per-component replacements are applied before statutory bases are built. */
  componentAmounts?: {
    regularPay?: number;
    casualDayPay?: number;
    lunch?: number;
    overtime?: number;
    serviceCharge?: number;
    allowances?: Record<string, number>;
  };
  incentives?: Array<{ amount: number; taxable: boolean; socialSecurity: boolean; label?: string }>;
  manualEarnings?: Array<{ amount: number; taxable: boolean; socialSecurity: boolean; label?: string }>;
  serviceChargeDeduction?: number;
  salaryDeduction?: number;
  /** Captured unpaid leave reduces this month's wage base before tax and contributions. */
  salaryReduction?: number;
  manualDeductions?: number;
}

export interface EffectiveStaffPayrollCalculation extends StaffPayrollPreview {
  taxableWages: number;
  socialSecurityWages: number;
  annualProjectedTax: number;
  calculationSteps: string[];
}

export interface PayrollCalculationPreview {
  branchId: BranchId;
  branchName: string;
  month: string;
  currency: "THB" | "MYR";
  serviceEarningMonth: string;
  serviceRevenueAvailable: boolean;
  servicePool: number;
  rows: StaffPayrollPreview[];
  totals: {
    grossPay: number;
    employeeStatutory: number;
    incomeTaxWithholding: number;
    netPay: number;
    employerStatutory: number;
  };
  steps: string[];
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const halfUpBaht = (value: number) => Math.floor(value + 0.5);
const monthStart = (month: string) => `${month}-01`;

function monthIndex(month: string) {
  const [year, number] = month.split("-").map(Number);
  return year * 12 + number - 1;
}

function monthFromIndex(index: number) {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function daysInMonth(month: string) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

function employedCalendarDays(staff: StaffMember, month: string) {
  const first = monthStart(month);
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const start = staff.joinedOn > first ? staff.joinedOn : first;
  const end = staff.leftOn && staff.leftOn < last ? staff.leftOn : last;
  if (end < start) return 0;
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

export function effectiveRulesForMonth(branch: BranchRecord, month: string): StatutoryRules {
  const rules = branch.rulesHistory
    .filter((rule) => rule.effectiveFrom <= month)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (!rules.length) throw new Error(`No statutory/pay rules are effective for ${branch.id} in ${month}.`);
  return rules[rules.length - 1];
}

export function effectiveBranchDetailsForMonth(branch: BranchRecord, month: string) {
  const versions = branch.detailsHistory
    .filter((version) => version.effectiveFrom <= month)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (!versions.length) throw new Error(`No branch details are effective for ${branch.id} in ${month}.`);
  return versions[versions.length - 1].details;
}

function findRevenue(data: PayrollWorld, branchId: BranchId, month: string): RevenueMonth | undefined {
  return data.revenue.find((item) => item.branchId === branchId && item.month === month);
}

function shiftMonth(month: string, delta: number) {
  return monthFromIndex(monthIndex(month) + delta);
}

function clockHoursBetween(start: string | null, end: string | null) {
  if (!start || !end) return 0;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  return (minutes < 0 ? minutes + 24 * 60 : minutes) / 60;
}

function progressiveTax(taxableIncome: number, brackets: ReadonlyArray<TaxBracket>) {
  const taxable = Math.max(0, taxableIncome);
  return roundMoney(brackets.reduce((total, bracket) => {
    const upper = bracket.to ?? Number.POSITIVE_INFINITY;
    const band = Math.max(0, Math.min(taxable, upper) - bracket.from);
    return total + band * bracket.rate;
  }, 0));
}

function prorationFactor(staff: StaffMember, month: string, rules: StatutoryRules) {
  const activeDays = employedCalendarDays(staff, month);
  const divisor = rules.calendarProration.method === "actual-calendar-days"
    ? daysInMonth(month)
    : rules.calendarProration.divisor;
  return Math.min(1, activeDays / divisor);
}

function eligibleAttendance(
  attendance: AttendanceDay[],
  branchId: BranchId,
  staffId: string,
  month: string,
) {
  return attendance.filter((day) => day.branchId === branchId && day.staffId === staffId &&
    day.date.slice(0, 7) === month && day.scheduled && !day.dayOff);
}

function attendedDaysInMonth(data: PayrollWorld, branchId: BranchId, staffId: string, month: string) {
  return eligibleAttendance(data.attendance, branchId, staffId, month).length;
}

function serviceChargeShares(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  rules: StatutoryRules,
) {
  const serviceRule = rules.serviceCharge;
  const earningMonth = shiftMonth(month, -serviceRule.payoutLagMonths);
  const revenue = findRevenue(data, branchId, earningMonth);
  const pool = revenue
    ? roundMoney(serviceRule.revenueStreams.reduce((sum, stream) => sum + revenue.streams[stream], 0) * serviceRule.rate)
    : 0;
  if (!pool) return { pool: 0, earningMonth, revenueAvailable: revenue !== undefined, shares: new Map<string, number>() };

  const branch = data.branches[branchId];
  const monthEnd = `${earningMonth}-${String(daysInMonth(earningMonth)).padStart(2, "0")}`;
  const eligible = branch.staff.map((staff) => {
    const workDays = attendedDaysInMonth(data, branchId, staff.id, earningMonth);
    const activeDuringMonth = staff.joinedOn <= monthEnd && (!staff.leftOn || staff.leftOn >= monthStart(earningMonth));
    const probationComplete = staff.probationEndsOn <= monthEnd;
    const isEligible = staff.serviceChargeEligible && activeDuringMonth && workDays >= serviceRule.minimumDays &&
      (!serviceRule.probationRequired || probationComplete) &&
      (serviceRule.includeCasuals || !isCasualStaff(staff));
    return { staff, workDays, isEligible };
  }).filter((item) => item.isEligible);

  const weights = eligible.map(({ staff, workDays }) => {
    if (serviceRule.allocation === "equal") return 1;
    if (serviceRule.allocation === "days") return workDays;
    if (serviceRule.allocation === "role-weight") return serviceRule.roleWeights[staff.role] ?? staff.serviceRoleWeight;
    return serviceRule.customPercentByStaffId[staff.id] ?? 0;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = new Map<string, number>();
  if (totalWeight > 0) eligible.forEach(({ staff }, index) => {
    shares.set(staff.id, roundMoney(pool * weights[index] / totalWeight));
  });
  return { pool, earningMonth, revenueAvailable: revenue !== undefined, shares };
}

function monthElapsedCount(month: string) {
  return Number(month.slice(5, 7));
}

function regularBaselineAnnualTax(
  country: CountryCode,
  rules: StatutoryRules,
  annualRegularGross: number,
  annualRegularSso: number,
) {
  if (country === "TH") {
    const employmentExpense = Math.min(
      annualRegularGross * rules.thPit.employmentExpenseRate,
      rules.thPit.employmentExpenseCap,
    );
    const taxable = Math.max(
      0,
      annualRegularGross - employmentExpense - rules.thPit.personalAllowance - annualRegularSso,
    );
    return progressiveTax(taxable, rules.thPit.brackets);
  }
  return progressiveTax(
    Math.max(0, annualRegularGross - rules.my.residentSelfRelief),
    rules.my.residentPcbBrackets,
  );
}

export function cumulativeTax(
  country: CountryCode,
  staff: StaffMember,
  rules: StatutoryRules,
  month: string,
  currentTaxable: number,
  regularTaxable: number,
  employeeSso: number,
  regularEmployeeSso: number,
  ytd: PriorYearToDate | undefined,
): { withholding: number; annualProjectedTax: number; annualTaxable: number; steps: string[] } {
  const elapsed = monthElapsedCount(month);
  const year = Number(month.slice(0, 4));
  let priorDefaultTaxable = 0;
  let futureRegular = 0;
  let baselineAnnualGross = 0;
  let priorDefaultSso = 0;
  let futureRegularSso = 0;
  let baselineAnnualSso = 0;
  let totalPayrollPeriods = 0;
  let elapsedPayrollPeriods = 0;
  for (let calendarMonth = 1; calendarMonth <= 12; calendarMonth += 1) {
    const projectedMonth = `${year}-${String(calendarMonth).padStart(2, "0")}`;
    const employmentFraction = prorationFactor(staff, projectedMonth, rules);
    if (employmentFraction > 0) {
      totalPayrollPeriods += 1;
      if (calendarMonth <= elapsed) elapsedPayrollPeriods += 1;
    }
    const regularGross = regularTaxable * employmentFraction;
    const regularSso = regularEmployeeSso * employmentFraction;
    baselineAnnualGross += regularGross;
    baselineAnnualSso += regularSso;
    if (calendarMonth < elapsed) {
      priorDefaultTaxable += regularGross;
      priorDefaultSso += regularSso;
    } else if (calendarMonth > elapsed) {
      futureRegular += regularGross;
      futureRegularSso += regularSso;
    }
  }
  const priorIncome = ytd?.taxableIncome ?? priorDefaultTaxable;
  const annualGross = priorIncome + currentTaxable + futureRegular;
  const priorSso = ytd?.employeeSocialSecurity ?? priorDefaultSso;
  const annualSso = priorSso + employeeSso + futureRegularSso;
  let annualTaxable: number;
  let annualTax: number;
  const steps: string[] = [];
  if (country === "TH") {
    const employmentExpense = Math.min(annualGross * rules.thPit.employmentExpenseRate, rules.thPit.employmentExpenseCap);
    annualTaxable = Math.max(0, annualGross - employmentExpense - rules.thPit.personalAllowance - annualSso);
    annualTax = progressiveTax(annualTaxable, rules.thPit.brackets);
    steps.push(`Annual projected taxable income: ${annualGross.toFixed(2)} − ${(rules.thPit.employmentExpenseRate * 100).toFixed(2)}% employment expense (cap ${rules.thPit.employmentExpenseCap.toFixed(2)}) − personal allowance ${rules.thPit.personalAllowance.toFixed(2)} − ${annualSso.toFixed(2)} projected employee SSO = ${annualTaxable.toFixed(2)}.`);
  } else if (staff.taxResidency === "nonresident") {
    annualTaxable = annualGross;
    annualTax = annualGross * rules.my.nonResidentPcbRate;
    const monthlyTarget = currentTaxable * rules.my.nonResidentPcbRate;
    return {
      withholding: roundMoney(monthlyTarget),
      annualProjectedTax: roundMoney(annualTax),
      annualTaxable,
      steps: [`Foreign-worker non-resident PCB assumption: current taxable pay MYR ${currentTaxable.toFixed(2)} × ${(rules.my.nonResidentPcbRate * 100).toFixed(2)}% configured rate = MYR ${monthlyTarget.toFixed(2)}.`],
    };
  } else {
    annualTaxable = Math.max(0, annualGross - rules.my.residentSelfRelief);
    annualTax = progressiveTax(annualTaxable, rules.my.residentPcbBrackets);
    steps.push(`Annual projected taxable income: MYR ${annualGross.toFixed(2)} − MYR ${rules.my.residentSelfRelief.toFixed(2)} self relief = MYR ${annualTaxable.toFixed(2)}; configured resident PCB brackets applied.`);
  }
  const cumulativeTarget = annualTax * elapsedPayrollPeriods / Math.max(1, totalPayrollPeriods);
  const baselineAnnualTax = regularBaselineAnnualTax(country, rules, baselineAnnualGross, baselineAnnualSso);
  const activePeriodsBeforeCurrent = Math.max(0, elapsedPayrollPeriods - (prorationFactor(staff, month, rules) > 0 ? 1 : 0));
  const previousWithheld = ytd?.withheld ?? baselineAnnualTax * activePeriodsBeforeCurrent / Math.max(1, totalPayrollPeriods);
  const dueNow = currentTaxable > 0 ? Math.max(0, cumulativeTarget - previousWithheld) : 0;
  const currency = country === "TH" ? "THB" : "MYR";
  const priorBasis = ytd
    ? `actual supplied YTD withholding ${currency} ${ytd.withheld.toFixed(2)} (taxable income ${currency} ${ytd.taxableIncome.toFixed(2)})`
    : `regular-pay baseline prior taxable income ${currency} ${priorDefaultTaxable.toFixed(2)}; estimated prior withholding from baseline annual tax ${currency} ${baselineAnnualTax.toFixed(2)} × ${activePeriodsBeforeCurrent}/${Math.max(1, totalPayrollPeriods)}`;
  steps.push(`Cumulative withholding: annual projected tax ${currency} ${annualTax.toFixed(2)} × ${elapsedPayrollPeriods}/${Math.max(1, totalPayrollPeriods)} employed payroll periods − ${priorBasis} = ${dueNow.toFixed(2)}. Prior and future regular pay are prorated by employment dates; current variable pay is included once and is not repeated in future projections.`);
  return { withholding: roundMoney(dueNow), annualProjectedTax: roundMoney(annualTax), annualTaxable, steps };
}

function calculateStaff(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  rules: StatutoryRules,
  currency: "THB" | "MYR",
  staff: StaffMember,
  serviceCharge: number,
  options: PayrollPreviewOptions,
  extras: StaffCalculationExtras = {},
): EffectiveStaffPayrollCalculation {
  const steps: string[] = [];
  const dayRows = eligibleAttendance(data.attendance, branchId, staff.id, month);
  const workingDays = dayRows.length;
  const employedDays = employedCalendarDays(staff, month);
  const salaryProration = prorationFactor(staff, month, rules);
  const monthDays = daysInMonth(month);
  const calculatedRegularPay = staff.monthlySalary === null
    ? 0
    : roundMoney(staff.monthlySalary * salaryProration);
  const calculatedCasualDayPay = staff.dayRate === null ? 0 : roundMoney(staff.dayRate * workingDays);
  const regularPay = roundMoney(extras.componentAmounts?.regularPay ?? calculatedRegularPay);
  const casualDayPay = roundMoney(extras.componentAmounts?.casualDayPay ?? calculatedCasualDayPay);
  const allowanceAmounts = Object.fromEntries(rules.allowances.map((allowance) => [
    allowance.id,
    extras.componentAmounts?.allowances?.[allowance.id] !== undefined
      ? roundMoney(extras.componentAmounts.allowances[allowance.id])
      : roundMoney(isCasualStaff(staff) ? 0 : allowance.amount * salaryProration),
  ]));
  const allowances = roundMoney(Object.values(allowanceAmounts).reduce((sum, amount) => sum + amount, 0));
  const calculatedLunch = roundMoney((rules.lunchByRole[staff.role] ?? 0) * workingDays);
  const lunch = roundMoney(extras.componentAmounts?.lunch ?? calculatedLunch);
  const otPolicy = overtimePolicyForRole(rules.overtimePolicy, staff.role);
  const overtimeRows = data.attendance
    .filter((day) => day.branchId === branchId && day.staffId === staff.id &&
      day.date.slice(0, 7) === month && day.overtimeHours > 0)
    .map((day) => ({ ...day, overtimeHours: roundedOvertimeHours(day.overtimeHours, otPolicy) }))
    .filter((day) => day.overtimeHours > 0);
  const roleOtEligible = staff.otEligible && rules.overtimeEligibilityByRole[staff.role];
  const overtimeHours = overtimeRows.reduce((sum, day) => sum + (roleOtEligible ? day.overtimeHours : 0), 0);
  const weightedOtHours = overtimeRows.reduce((sum, day) => {
    if (!roleOtEligible || day.overtimeHours <= 0) return sum;
    const multiplier = day.holiday ? rules.overtimeMultipliers.publicHoliday : day.dayOff ? rules.overtimeMultipliers.restDay : rules.overtimeMultipliers.regular;
    return sum + day.overtimeHours * multiplier;
  }, 0);
  const hourlyRate = staff.monthlySalary !== null
    ? staff.monthlySalary / rules.hourlyBase.monthlySalaryDays / rules.hourlyBase.monthlyHoursPerDay
    : (staff.dayRate ?? 0) / rules.hourlyBase.casualDayHours;
  const overtimeHoursAmount = roundMoney(hourlyRate * weightedOtHours);
  const holidayBaseHours = dayRows.filter((day) => day.holiday).reduce(
    (sum, day) => sum + clockHoursBetween(day.plannedClockIn, day.plannedClockOut),
    0,
  );
  const holidayBasePremiumMultiplier = Math.max(0, rules.overtimeMultipliers.restDay - 1);
  const holidayPremium = roundMoney(hourlyRate * holidayBaseHours * holidayBasePremiumMultiplier);
  const calculatedOvertime = roundMoney(overtimeHoursAmount + holidayPremium);
  const overtime = roundMoney(extras.componentAmounts?.overtime ?? calculatedOvertime);
  serviceCharge = roundMoney(extras.componentAmounts?.serviceCharge ?? serviceCharge);
  const incentiveEarnings = (extras.incentives ?? []).map((line) => ({ ...line, amount: roundMoney(line.amount) }));
  const manualEarnings = (extras.manualEarnings ?? []).map((line) => ({ ...line, amount: roundMoney(line.amount) }));
  const salaryReduction = roundMoney(extras.salaryReduction ?? 0);
  const reducedBaseSalary = roundMoney(Math.max(0, regularPay + casualDayPay - salaryReduction));
  const grossPay = roundMoney(regularPay + casualDayPay + allowances + lunch + overtime + serviceCharge +
    incentiveEarnings.reduce((sum, line) => sum + line.amount, 0) +
    manualEarnings.reduce((sum, line) => sum + line.amount, 0) - salaryReduction);
  const flags = rules.componentFlags;
  const sociallyIncluded = (componentId: string, amount: number) => flags[componentId]?.socialSecurity ? amount : 0;
  const taxableIncluded = (componentId: string, amount: number) => flags[componentId]?.taxable ? amount : 0;
  const socialWages = roundMoney(
    sociallyIncluded("baseSalary", reducedBaseSalary) +
    rules.allowances.reduce((sum, allowance) => sum + (allowance.socialSecurity ? allowanceAmounts[allowance.id] : 0), 0) +
    sociallyIncluded("serviceCharge", serviceCharge) +
    sociallyIncluded("overtime", overtime) +
    sociallyIncluded("lunch", lunch) +
    incentiveEarnings.reduce((sum, line) => sum + (line.socialSecurity ? line.amount : 0), 0) +
    manualEarnings.reduce((sum, line) => sum + (line.socialSecurity ? line.amount : 0), 0),
  );
  const taxableThisMonth = roundMoney(
    taxableIncluded("baseSalary", reducedBaseSalary) +
    rules.allowances.reduce((sum, allowance) => sum + (allowance.taxable ? allowanceAmounts[allowance.id] : 0), 0) +
    taxableIncluded("serviceCharge", serviceCharge) +
    taxableIncluded("overtime", overtime) +
    taxableIncluded("lunch", lunch) +
    incentiveEarnings.reduce((sum, line) => sum + (line.taxable ? line.amount : 0), 0) +
    manualEarnings.reduce((sum, line) => sum + (line.taxable ? line.amount : 0), 0),
  );
  const baseTaxable = flags.baseSalary?.taxable ?? false;
  const regularTaxable = staff.monthlySalary !== null
    ? roundMoney((baseTaxable ? staff.monthlySalary : 0) + rules.allowances.reduce((sum, allowance) => sum + (allowance.taxable ? allowance.amount : 0), 0))
    : roundMoney((baseTaxable ? (staff.dayRate ?? 0) * Math.max(1, staff.scheduledDaysPerWeek * 52 / 12) : 0));
  const regularBaseWages = staff.monthlySalary ??
    (staff.dayRate ?? 0) * Math.max(1, staff.scheduledDaysPerWeek * 52 / 12);
  const regularSocialWages = roundMoney(
    sociallyIncluded("baseSalary", regularBaseWages) +
    (isCasualStaff(staff) ? 0 : rules.allowances.reduce((sum, allowance) => sum + (allowance.socialSecurity ? allowance.amount : 0), 0)),
  );
  const regularEmployeeSso = rules.country === "TH"
    ? halfUpBaht(Math.min(regularSocialWages, rules.thSso.wageCap) * rules.thSso.employeeRate)
    : 0;
  const ytd = options.priorYearToDate?.[staff.id];
  let employeeStatutory = 0;
  let employerStatutory = 0;
  let employeeSso = 0;
  const statutoryBreakdown = {
    employee: { sso: 0, epf: 0, socso: 0, eis: 0, ewf: 0 },
    employer: { sso: 0, epf: 0, socso: 0, eis: 0, hrd: 0, ewf: 0 },
  };
  if (rules.country === "TH") {
    const ssoBase = Math.min(socialWages, rules.thSso.wageCap);
    employeeSso = halfUpBaht(ssoBase * rules.thSso.employeeRate);
    const employerSso = employeeSso;
    statutoryBreakdown.employee.sso = employeeSso;
    statutoryBreakdown.employer.sso = employerSso;
    employeeStatutory += employeeSso;
    employerStatutory += employerSso;
    steps.push(`SSO base min(THB ${socialWages.toFixed(2)}, THB ${rules.thSso.wageCap.toFixed(2)}) = THB ${ssoBase.toFixed(2)}; employee ${(rules.thSso.employeeRate * 100).toFixed(2)}% = THB ${employeeSso}; employer contribution is always equal to the same rounded employee amount, THB ${employerSso}.`);
  } else {
    const epfBase = socialWages;
    const local = staff.employmentType === "local";
    const epfEmployeeRate = local ? rules.my.epfLocalEmployeeRate : rules.my.epfForeignEmployeeRate;
    const epfEmployerRate = local
      ? (epfBase <= rules.my.epfEmployerThreshold ? rules.my.epfLocalEmployerRateAtOrBelow5000 : rules.my.epfLocalEmployerRateAbove5000)
      : rules.my.epfForeignEmployerRate;
    const employeeEpf = roundMoney(epfBase * epfEmployeeRate);
    const employerEpf = roundMoney(epfBase * epfEmployerRate);
    const cappedSocsoBase = Math.min(socialWages, rules.my.socsoWageCap);
    const employeeSocso = roundMoney(cappedSocsoBase * (local ? rules.my.socsoLocalEmployeeRate : rules.my.socsoForeignEmployeeRate));
    const employerSocso = roundMoney(cappedSocsoBase * (local ? rules.my.socsoLocalEmployerRate : rules.my.socsoForeignEmployerRate));
    const cappedEisBase = Math.min(socialWages, rules.my.eisWageCap);
    const employeeEis = local ? roundMoney(cappedEisBase * rules.my.eisLocalEmployeeRate) : 0;
    const employerEis = local ? roundMoney(cappedEisBase * rules.my.eisLocalEmployerRate) : 0;
    const hrdEligible = rules.my.hrdEnabled && rules.my.malaysianEmployeeHeadcount >= 10;
    const hrd = hrdEligible ? roundMoney(socialWages * rules.my.hrdEmployerRate) : 0;
    statutoryBreakdown.employee.epf = employeeEpf;
    statutoryBreakdown.employee.socso = employeeSocso;
    statutoryBreakdown.employee.eis = employeeEis;
    statutoryBreakdown.employer.epf = employerEpf;
    statutoryBreakdown.employer.socso = employerSocso;
    statutoryBreakdown.employer.eis = employerEis;
    statutoryBreakdown.employer.hrd = hrd;
    employeeStatutory = employeeEpf + employeeSocso + employeeEis;
    employerStatutory = employerEpf + employerSocso + employerEis + hrd;
    const employerRateBasis = local
      ? `configured local employer threshold MYR ${rules.my.epfEmployerThreshold.toFixed(2)} (${epfBase.toFixed(2)} ${epfBase <= rules.my.epfEmployerThreshold ? "≤" : ">"} threshold)`
      : "configured foreign-worker employer rate (local threshold not applied)";
    steps.push(`EPF: eligible wages MYR ${epfBase.toFixed(2)}; ${employerRateBasis}. Employee rate ${(epfEmployeeRate * 100).toFixed(2)}% = MYR ${employeeEpf.toFixed(2)}; employer rate ${(epfEmployerRate * 100).toFixed(2)}% = MYR ${employerEpf.toFixed(2)}.`);
    steps.push(`SOCSO: min(MYR ${socialWages.toFixed(2)}, MYR ${rules.my.socsoWageCap}) × employee ${(local ? rules.my.socsoLocalEmployeeRate : rules.my.socsoForeignEmployeeRate) * 100}% / employer ${(local ? rules.my.socsoLocalEmployerRate : rules.my.socsoForeignEmployerRate) * 100}% = MYR ${employeeSocso.toFixed(2)} / ${employerSocso.toFixed(2)}.`);
    const hrdExplanation = !rules.my.hrdEnabled
      ? `disabled; no levy (headcount ${rules.my.malaysianEmployeeHeadcount})`
      : rules.my.malaysianEmployeeHeadcount < 10
        ? `enabled but noneligible: Malaysian employee headcount ${rules.my.malaysianEmployeeHeadcount} is below 10; no levy`
        : `eligible: Malaysian employee headcount ${rules.my.malaysianEmployeeHeadcount} meets the 10-employee threshold; MYR ${socialWages.toFixed(2)} × ${(rules.my.hrdEmployerRate * 100).toFixed(2)}% = MYR ${hrd.toFixed(2)}`;
    steps.push(`EIS: ${local ? `min(MYR ${socialWages.toFixed(2)}, MYR ${rules.my.eisWageCap}) × 0.2% = MYR ${employeeEis.toFixed(2)} employee / ${employerEis.toFixed(2)} employer` : "foreign workers are excluded by this prototype rule"}; HRD levy ${hrdExplanation}.`);
  }
  const tax = cumulativeTax(rules.country, staff, rules, month, taxableThisMonth, regularTaxable, employeeSso, regularEmployeeSso, ytd);
  steps.push(...tax.steps);
  const prorationDivisor = rules.calendarProration.method === "actual-calendar-days" ? monthDays : rules.calendarProration.divisor;
  const employmentEvents = [
    staff.joinedOn.slice(0, 7) === month ? `JOINER: joined ${staff.joinedOn}.` : "",
    staff.leftOn?.slice(0, 7) === month ? `LEAVER: final employed day ${staff.leftOn}.` : "",
  ].filter(Boolean).join(" ");
  steps.unshift(`${staff.name}: ${staff.role}; ${employedDays}/${monthDays} employed calendar days; configured proration ${employedDays}/${prorationDivisor}, capped at 1.00 (${rules.calendarProration.method}); ${workingDays} scheduled work days; gross ${currency} ${grossPay.toFixed(2)}.${employmentEvents ? ` Employment event: ${employmentEvents}` : ""}`);
  steps.splice(1, 0, `Pay: monthly base ${currency} ${regularPay.toFixed(2)}; day-rate pay ${currency} ${casualDayPay.toFixed(2)}; fixed allowances ${currency} ${allowances.toFixed(2)}; lunch ${workingDays} × ${currency} ${(rules.lunchByRole[staff.role] ?? 0).toFixed(2)} = ${currency} ${lunch.toFixed(2)}; approved OT ${overtimeHours}h weighted to ${weightedOtHours.toFixed(2)}h at regular ×${rules.overtimeMultipliers.regular}/rest-day ×${rules.overtimeMultipliers.restDay}/public-holiday ×${rules.overtimeMultipliers.publicHoliday}, hourly ${currency} ${hourlyRate.toFixed(2)} = ${currency} ${overtimeHoursAmount.toFixed(2)}; ${holidayBaseHours.toFixed(2)} scheduled holiday base hours add max(0, rest-day ×${rules.overtimeMultipliers.restDay} − 1) = ${holidayBasePremiumMultiplier.toFixed(2)}× incremental premium, ${currency} ${hourlyRate.toFixed(2)} × ${holidayBaseHours.toFixed(2)}h = ${currency} ${holidayPremium.toFixed(2)} (base shift already included once in regular/day-rate pay); combined overtime/holiday premium ${currency} ${overtime.toFixed(2)}; lagged service charge ${currency} ${serviceCharge.toFixed(2)}.`);
  return {
    staffId: staff.id,
    name: staff.name,
    role: staff.role,
    currency,
    regularPay,
    casualDayPay,
    allowances,
    lunch,
    overtime,
    serviceCharge,
    grossPay,
    employeeStatutory: roundMoney(employeeStatutory),
    statutoryBreakdown,
    incomeTaxWithholding: tax.withholding,
    netPay: roundMoney(grossPay - employeeStatutory - tax.withholding -
      (extras.serviceChargeDeduction ?? 0) - (extras.salaryDeduction ?? 0) - (extras.manualDeductions ?? 0)),
    employerStatutory: roundMoney(employerStatutory),
    steps,
    taxableWages: taxableThisMonth,
    socialSecurityWages: socialWages,
    annualProjectedTax: tax.annualProjectedTax,
    calculationSteps: [...steps],
  };
}

/** Recalculates a staff member using effective month-end line amounts. */
export function calculateStaffWithExtras(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  staffId: string,
  serviceCharge: number,
  extras: StaffCalculationExtras = {},
  options: PayrollPreviewOptions = {},
): EffectiveStaffPayrollCalculation {
  const amounts = [
    serviceCharge,
    ...(Object.values(extras.componentAmounts ?? {}).flatMap((value) =>
      typeof value === "number" ? [value] : Object.values(value ?? {}))),
    ...(extras.incentives ?? []).map((line) => line.amount),
    ...(extras.manualEarnings ?? []).map((line) => line.amount),
    extras.serviceChargeDeduction ?? 0,
    extras.salaryDeduction ?? 0,
    extras.salaryReduction ?? 0,
    extras.manualDeductions ?? 0,
  ];
  if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0)) {
    throw new Error(`Effective payroll extras for ${staffId} must contain only finite, non-negative amounts.`);
  }
  const branch = data.branches[branchId];
  if (!branch) throw new Error(`Unknown payroll branch: ${branchId}.`);
  const staff = branch.staff.find((item) => item.id === staffId);
  if (!staff) throw new Error(`Unknown staff member ${staffId} in ${branchId}.`);
  const rules = effectiveRulesForMonth(branch, month);
  const details = effectiveBranchDetailsForMonth(branch, month);
  if (rules.country !== details.country) {
    throw new Error(`Branch details country ${details.country} and statutory rules country ${rules.country} do not match for ${month}.`);
  }
  return calculateStaff(data, branchId, month, rules, details.currency, staff, serviceCharge, options, extras);
}

export function calculatePayrollPreview(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  options: PayrollPreviewOptions = {},
): PayrollCalculationPreview {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid payroll month: ${month}. Expected YYYY-MM.`);
  const branch = data.branches[branchId];
  if (!branch) throw new Error(`Unknown payroll branch: ${branchId}.`);
  const rules = effectiveRulesForMonth(branch, month);
  const details = effectiveBranchDetailsForMonth(branch, month);
  if (rules.country !== details.country) {
    throw new Error(`Branch details country ${details.country} and statutory rules country ${rules.country} do not match for ${month}.`);
  }
  const { pool, earningMonth, revenueAvailable, shares } = serviceChargeShares(data, branchId, month, rules);
  const calculatedRows = branch.staff.map((staff) =>
    calculateStaff(data, branchId, month, rules, details.currency, staff, shares.get(staff.id) ?? 0, options),
  );
  const rows: StaffPayrollPreview[] = calculatedRows.map(({
    taxableWages: _taxableWages,
    socialSecurityWages: _socialSecurityWages,
    annualProjectedTax: _annualProjectedTax,
    calculationSteps: _calculationSteps,
    ...row
  }) => row);
  const total = (key: "grossPay" | "employeeStatutory" | "incomeTaxWithholding" | "netPay" | "employerStatutory") =>
    roundMoney(rows.reduce((sum, row) => sum + row[key], 0));
  const steps = [
    `Payroll preview for ${details.name}, ${month}; dated rules effective ${rules.effectiveFrom}.`,
    revenueAvailable
      ? `Service pool: ${earningMonth} selected revenue streams × ${(rules.serviceCharge.rate * 100).toFixed(2)}% = ${details.currency} ${pool.toFixed(2)}; paid after ${rules.serviceCharge.payoutLagMonths} month(s).`
      : `No revenue source data is seeded for ${earningMonth}; service-charge pool is explicitly shown as ${details.currency} 0.00. Add the earning-month revenue input before relying on service-charge preview.`,
    `Allocation: ${rules.serviceCharge.allocation}; minimum ${rules.serviceCharge.minimumDays} eligible day(s); ${rules.serviceCharge.probationRequired ? "probation completion required" : "probation not required"}; casual eligibility ${rules.serviceCharge.includeCasuals ? "included" : "excluded"}.`,
    ...rows.flatMap((row) => row.steps),
  ];
  return {
    branchId,
    branchName: details.name,
    month,
    currency: details.currency,
    serviceEarningMonth: earningMonth,
    serviceRevenueAvailable: revenueAvailable,
    servicePool: pool,
    rows,
    totals: {
      grossPay: total("grossPay"),
      employeeStatutory: total("employeeStatutory"),
      incomeTaxWithholding: total("incomeTaxWithholding"),
      netPay: total("netPay"),
      employerStatutory: total("employerStatutory"),
    },
    steps,
  };
}
