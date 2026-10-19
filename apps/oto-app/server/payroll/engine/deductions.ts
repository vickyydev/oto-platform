import type {
  AttendanceDay,
  AttendanceException,
  BranchId,
  DeductionRule,
  ExceptionResolution,
  PayrollWorld,
  StaffMember,
} from "./model";
import { calculatePayrollPreview, type PayrollCalculationPreview } from "./calculations";

export interface DeductionOccurrenceBreakdown {
  date: string;
  plannedClockIn: string | null;
  actualClockIn: string | null;
  plannedClockOut: string | null;
  actualClockOut: string | null;
  minutes: number;
  reason: string;
  resolution: ExceptionResolution;
  runningCount: number;
  runningMinutes: number;
  withinAllowance: boolean;
  uncappedAmount: number;
  capApplied: number;
  sourceApplied: number;
  finalAmount: number;
  durationMissing: boolean;
}

export interface StaffDeductionCalculation {
  branchId: BranchId;
  month: string;
  staffId: string;
  ruleId: string;
  source: "service-charge" | "salary";
  total: number;
  amount: number;
  occurrences: DeductionOccurrenceBreakdown[];
  steps: string[];
}

export interface DeductionSourceBudget {
  serviceCharge: number;
  salary: number;
}

export interface MonthlyStaffDeductionCalculation {
  staffId: string;
  staffName: string;
  serviceChargeAvailable: number;
  salaryAvailable: number;
  serviceChargeDeducted: number;
  salaryDeducted: number;
  total: number;
  rules: StaffDeductionCalculation[];
}

export interface DeductionMonthCalculation {
  branchId: BranchId;
  month: string;
  currency: "THB" | "MYR";
  rows: MonthlyStaffDeductionCalculation[];
  ruleTotals: Record<string, number>;
  total: number;
}

const roundMoney = (value: number) => Number.isFinite(value)
  ? Math.round((value + Number.EPSILON) * 100) / 100
  : 0;
const finiteNonNegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

function clockMinutes(clock: string | null): number | null {
  if (!clock || !/^\d{2}:\d{2}$/.test(clock)) return null;
  const [hours, minutes] = clock.split(":").map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesBetween(start: string | null, end: string | null): number | null {
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  if (from === null || to === null) return null;
  const delta = to - from;
  return Math.max(0, delta < 0 ? delta + 24 * 60 : delta);
}

function shiftDuration(day: AttendanceDay): number {
  return minutesBetween(day.plannedClockIn, day.plannedClockOut) ?? 0;
}

function issueMinutes(
  rule: DeductionRule,
  day: AttendanceDay,
  exception: AttendanceException,
): { minutes: number; durationMissing: boolean } {
  const chargeClockIn = exception.resolution === "Corrected" && exception.effectiveClockIn !== null
    ? exception.effectiveClockIn
    : exception.rawClockIn ?? day.actualClockIn;
  const chargeClockOut = exception.resolution === "Corrected" && exception.effectiveClockOut !== null
    ? exception.effectiveClockOut
    : exception.rawClockOut ?? day.actualClockOut;
  if (rule.issue === "late") {
    const plannedMinutes = clockMinutes(day.plannedClockIn);
    const actualMinutes = clockMinutes(chargeClockIn);
    if (plannedMinutes === null || actualMinutes === null) return { minutes: 0, durationMissing: true };
    return { minutes: Math.max(0, actualMinutes - plannedMinutes), durationMissing: false };
  }
  if (rule.issue === "early-departure") {
    const planned = clockMinutes(day.plannedClockOut);
    const actual = clockMinutes(chargeClockOut);
    if (planned === null || actual === null) return { minutes: 0, durationMissing: true };
    const difference = planned - actual;
    return { minutes: Math.max(0, difference), durationMissing: false };
  }
  if (rule.issue === "no-show") {
    const duration = shiftDuration(day);
    return { minutes: duration, durationMissing: duration <= 0 };
  }
  if (rule.issue === "break-overrun") {
    const supplied = exception.minutes;
    return {
      minutes: supplied === undefined ? 0 : finiteNonNegative(supplied),
      durationMissing: supplied === undefined || !Number.isFinite(supplied),
    };
  }
  return { minutes: 0, durationMissing: false };
}

function isChargeable(resolution: ExceptionResolution): boolean {
  return resolution === "Approved" || resolution === "Corrected";
}

/** Job-title match when the rule lists job titles; otherwise falls back to the original role list. */
export function isDeductionAssigned(rule: DeductionRule, staff: StaffMember): boolean {
  if (rule.excludeStaffIds.includes(staff.id)) return false;
  if (rule.includeStaffIds.includes(staff.id)) return true;
  if (rule.jobTitles && rule.jobTitles.length > 0) {
    const title = (staff.payrollProfile?.jobTitle || staff.role).trim().toLowerCase();
    return rule.jobTitles.some((item) => item.trim().toLowerCase() === title);
  }
  return rule.roles.includes(staff.role);
}
const isAssigned = isDeductionAssigned;

function matchingOccurrences(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  staffId: string,
  rule: DeductionRule,
) {
  const rows: Array<{
    day: AttendanceDay;
    exception: AttendanceException & { resolution: Exclude<ExceptionResolution, null> };
  }> = [];
  let unresolvedCount = 0;
  for (const day of data.attendance) {
    if (day.branchId !== branchId || day.staffId !== staffId || day.date.slice(0, 7) !== month) continue;
    for (const exception of day.exceptions) {
      if (exception.kind !== rule.issue) continue;
      if (exception.resolution === null) {
        unresolvedCount += 1;
        continue;
      }
      if (exception.resolution === "Corrected" && (exception.kind === "late" || exception.kind === "early-departure")) {
        const corrected = issueMinutes(rule, day, exception);
        if (!corrected.durationMissing && corrected.minutes === 0) continue;
      }
      rows.push({
        day,
        exception: exception as AttendanceException & { resolution: Exclude<ExceptionResolution, null> },
      });
    }
  }
  return {
    rows: rows.sort((a, b) => a.day.date.localeCompare(b.day.date) || a.day.id.localeCompare(b.day.id)),
    unresolvedCount,
  };
}

/**
 * Calculates a single assigned rule for a staff member. `remainingSource` can
 * be a remaining source amount or explicit remaining source budgets, as used by
 * the month calculation to prevent overlapping deductions.
 */
export function calculateDeductionForStaff(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  staffId: string,
  rule: DeductionRule,
  remainingSource?: number | Partial<DeductionSourceBudget>,
  suppliedPreview?: PayrollCalculationPreview,
): StaffDeductionCalculation {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid payroll month: ${month}. Expected YYYY-MM.`);
  const branch = data.branches[branchId];
  if (!branch) throw new Error(`Unknown payroll branch: ${branchId}.`);
  const staff = branch.staff.find((member) => member.id === staffId);
  if (!staff) throw new Error(`Unknown staff member ${staffId} in ${branchId}.`);
  const preview = suppliedPreview ?? calculatePayrollPreview(data, branchId, month);
  const previewRow = preview.rows.find((row) => row.staffId === staffId);
  if (!previewRow) throw new Error(`Payroll preview has no row for staff member ${staffId}.`);
  const source = rule.source === "service-charge" ? "serviceCharge" : "salary";
  const sourceBase = finiteNonNegative(source === "serviceCharge" ? previewRow.serviceCharge : previewRow.regularPay);
  const sourceBudget = typeof remainingSource === "number"
    ? finiteNonNegative(remainingSource)
    : remainingSource
      ? finiteNonNegative(remainingSource[source] ?? sourceBase)
      : sourceBase;
  const matching = matchingOccurrences(data, branchId, month, staffId, rule);
  const occurrences = matching.rows;
  let runningCount = 0;
  let runningMinutes = 0;
  let ruleCharged = 0;
  let sourceCharged = 0;
  const detail: DeductionOccurrenceBreakdown[] = [];

  if (rule.enabled && isAssigned(rule, staff)) {
    for (const { day, exception } of occurrences) {
      const measured = issueMinutes(rule, day, exception);
      const chargeable = isChargeable(exception.resolution);
      const count = chargeable ? runningCount + 1 : runningCount;
      const minutes = chargeable
        ? runningMinutes + measured.minutes
        : runningMinutes;
      const occurrenceLimitReached = rule.freeOccurrences !== null && count > rule.freeOccurrences;
      const minuteLimitReached = rule.freeMinutes !== null && minutes > rule.freeMinutes;
      const hasAllowance = rule.freeOccurrences !== null || rule.freeMinutes !== null;
      const withinAllowance = !chargeable ||
        (hasAllowance && !occurrenceLimitReached && !minuteLimitReached);
      let uncappedAmount = 0;
      if (chargeable && !withinAllowance) {
        if (rule.method === "fixed") uncappedAmount = finiteNonNegative(rule.amount);
        else if (rule.method === "percent") uncappedAmount = sourceBase * finiteNonNegative(rule.amount);
        else {
          const priorMinutes = runningMinutes;
          const chargeableMinutes = occurrenceLimitReached
            ? measured.minutes
            : minuteLimitReached && rule.freeMinutes !== null
              ? Math.max(0, minutes - Math.max(priorMinutes, rule.freeMinutes))
              : measured.minutes;
          uncappedAmount = finiteNonNegative(rule.amount) * chargeableMinutes;
        }
      }
      uncappedAmount = roundMoney(uncappedAmount);
      const remainingCap = rule.cap === null ? Number.POSITIVE_INFINITY : Math.max(0, finiteNonNegative(rule.cap) - ruleCharged);
      const afterCap = roundMoney(Math.min(uncappedAmount, remainingCap));
      const remainingBudget = Math.max(0, sourceBudget - sourceCharged);
      const finalAmount = roundMoney(Math.min(afterCap, remainingBudget));
      const capApplied = roundMoney(uncappedAmount - afterCap);
      const sourceApplied = roundMoney(afterCap - finalAmount);
      if (chargeable) {
        runningCount = count;
        runningMinutes = minutes;
        ruleCharged = roundMoney(ruleCharged + afterCap);
        sourceCharged = roundMoney(sourceCharged + finalAmount);
      }
      detail.push({
        date: day.date,
        plannedClockIn: day.plannedClockIn,
        actualClockIn: chargeable && exception.resolution === "Corrected"
          ? exception.effectiveClockIn ?? exception.rawClockIn ?? day.actualClockIn
          : exception.rawClockIn ?? day.actualClockIn,
        plannedClockOut: day.plannedClockOut,
        actualClockOut: chargeable && exception.resolution === "Corrected"
          ? exception.effectiveClockOut ?? exception.rawClockOut ?? day.actualClockOut
          : exception.rawClockOut ?? day.actualClockOut,
        minutes: measured.minutes,
        reason: exception.reason || (measured.durationMissing ? "Duration not supplied" : ""),
        resolution: exception.resolution,
        runningCount,
        runningMinutes,
        withinAllowance,
        uncappedAmount,
        capApplied,
        sourceApplied,
        finalAmount,
        durationMissing: measured.durationMissing,
      });
    }
  }

  const total = roundMoney(detail.reduce((sum, item) => sum + item.finalAmount, 0));
  const steps = [
    `${staff.name}: ${rule.name}; ${rule.enabled ? "enabled" : "disabled"}; source ${rule.source} (${sourceBase.toFixed(2)} available basis); ${rule.method} consequence ${rule.amount}.`,
    `Allowance: ${rule.freeOccurrences === null ? "no occurrence allowance" : `${rule.freeOccurrences} free occurrence(s)`}; ${rule.freeMinutes === null ? "no minute allowance" : `${rule.freeMinutes} free cumulative minutes`}. Approved and Corrected exceptions count; Corrected uses the effective clock time when supplied. Excused exceptions remain visible and never advance counters.`,
    matching.unresolvedCount
      ? `${matching.unresolvedCount} unresolved matching exception(s) explicitly excluded; resolve them before finalizing the cutoff.`
      : "No unresolved matching exceptions were excluded.",
    `Monthly cap ${rule.cap === null ? "none" : rule.cap.toFixed(2)}; calculated deduction ${total.toFixed(2)} from ${detail.length} matching occurrence(s).`,
  ];
  return { branchId, month, staffId, ruleId: rule.id, source: rule.source, total, amount: total, occurrences: detail, steps };
}

/** Calculates enabled deduction rules in stable configured order, with one shared budget per source/staff. */
export function calculateDeductionMonth(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
): DeductionMonthCalculation {
  const branch = data.branches[branchId];
  if (!branch) throw new Error(`Unknown payroll branch: ${branchId}.`);
  const preview = calculatePayrollPreview(data, branchId, month);
  const ruleTotals: Record<string, number> = {};
  const rows = branch.staff.map((staff) => {
    const previewRow = preview.rows.find((row) => row.staffId === staff.id);
    if (!previewRow) throw new Error(`Payroll preview has no row for staff member ${staff.id}.`);
    let serviceRemaining = finiteNonNegative(previewRow.serviceCharge);
    let salaryRemaining = finiteNonNegative(previewRow.regularPay);
    const rules: StaffDeductionCalculation[] = [];
    for (const rule of branch.deductionRules) {
      const available = rule.source === "service-charge" ? serviceRemaining : salaryRemaining;
      const result = calculateDeductionForStaff(data, branchId, month, staff.id, rule, available, preview);
      if (rule.source === "service-charge") serviceRemaining = roundMoney(Math.max(0, serviceRemaining - result.total));
      else salaryRemaining = roundMoney(Math.max(0, salaryRemaining - result.total));
      rules.push(result);
      ruleTotals[rule.id] = roundMoney((ruleTotals[rule.id] ?? 0) + result.total);
    }
    const serviceChargeAvailable = finiteNonNegative(previewRow.serviceCharge);
    const salaryAvailable = finiteNonNegative(previewRow.regularPay);
    const serviceChargeDeducted = roundMoney(serviceChargeAvailable - serviceRemaining);
    const salaryDeducted = roundMoney(salaryAvailable - salaryRemaining);
    return {
      staffId: staff.id,
      staffName: staff.name,
      serviceChargeAvailable,
      salaryAvailable,
      serviceChargeDeducted,
      salaryDeducted,
      total: roundMoney(serviceChargeDeducted + salaryDeducted),
      rules,
    };
  });
  return {
    branchId,
    month,
    currency: preview.currency,
    rows,
    ruleTotals,
    total: roundMoney(rows.reduce((sum, row) => sum + row.total, 0)),
  };
}