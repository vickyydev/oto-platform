import { isCasualStaff } from "./model";
import type {
  AttendanceDay,
  BranchId,
  DeductionRule,
  IncentiveRule,
  ManualRunAdjustment,
  PayrollWorld,
  RunDraft as StoreRunDraft,
  RunLineOverride as StoreRunLineOverride,
  StreamKey,
} from "./model";
import {
  calculatePayrollPreview,
  calculateStaffWithExtras,
  effectiveBranchDetailsForMonth,
  effectiveRulesForMonth,
  type EffectiveStaffPayrollCalculation,
  type PayrollPreviewOptions,
  type StaffCalculationExtras,
} from "./calculations";
import { calculateIncentiveMonth } from "./incentives";
import {
  calculateDeductionForStaff,
  isDeductionAssigned,
  type DeductionOccurrenceBreakdown,
} from "./deductions";
import { effectiveLeavePolicy, leavePayrollInputs } from "./leave-engine";
import { computeEwf, type EwfComponent, type EwfResult } from "./ewf-engine";
export { calculateCompanyEngine as calculateCompanyMonthEnd } from "./company-calculations";
import { overtimePayoutsForMonth, overtimePolicyForRole, roundedOvertimeHours } from "./ot-bank";

export interface ThailandWeeklyOvertimeWarning {
  staffId: string;
  weekStart: string;
  weekEnd: string;
  combinedHours: number;
  coveredDays: number;
  requiredDays: number;
}

function mondayOfWeek(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function clockSpanHours(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  let minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  if (minutes < 0) minutes += 24 * 60;
  return minutes / 60;
}

export function thailandWeeklyOvertimeWarnings(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  attendance: AttendanceDay[] = data.attendance,
): ThailandWeeklyOvertimeWarning[] {
  const branch = data.branches[branchId];
  if (!branch || effectiveBranchDetailsForMonth(branch, month).country !== "TH") return [];
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  const staffById = new Map(branch.staff.map((staff) => [staff.id, staff]));
  const grouped = new Map<string, AttendanceDay[]>();
  for (const day of attendance) {
    if (day.branchId !== branchId || !staffById.has(day.staffId)) continue;
    const weekStart = mondayOfWeek(day.date);
    const weekEnd = addDays(weekStart, 6);
    if (weekEnd < monthStart || weekStart > monthEnd) continue;
    const key = `${day.staffId}:${weekStart}`;
    const items = grouped.get(key) ?? [];
    items.push(day);
    grouped.set(key, items);
  }
  const warnings: ThailandWeeklyOvertimeWarning[] = [];
  for (const [key, days] of Array.from(grouped.entries())) {
    const [staffId, weekStart] = key.split(":");
    const weekEnd = addDays(weekStart, 6);
    const staff = staffById.get(staffId)!;
    if (staff.joinedOn > weekEnd || (staff.leftOn && staff.leftOn < weekStart)) continue;
    const employmentStart = staff.joinedOn > weekStart ? staff.joinedOn : weekStart;
    const employmentEnd = staff.leftOn && staff.leftOn < weekEnd ? staff.leftOn : weekEnd;
    if (employmentStart > employmentEnd) continue;
    const requiredDates: string[] = [];
    for (let date = employmentStart; date <= employmentEnd; date = addDays(date, 1)) requiredDates.push(date);
    const coveredDates = new Set(days.map((day) => day.date));
    const coveredDays = requiredDates.filter((date) => coveredDates.has(date)).length;
    const overtimeHours = days.reduce((sum: number, day: AttendanceDay) => sum + Math.max(0, day.overtimeHours), 0);
    const holidayHours = days.reduce((sum: number, day: AttendanceDay) => {
      if (!day.holiday && !day.dayOff) return sum;
      const worked = clockSpanHours(day.effectiveClockIn ?? day.actualClockIn, day.effectiveClockOut ?? day.actualClockOut);
      return sum + Math.max(0, worked - Math.max(0, day.overtimeHours));
    }, 0);
    const combinedHours = Math.round((overtimeHours + holidayHours + Number.EPSILON) * 100) / 100;
    if (combinedHours > 36) {
      warnings.push({
        staffId, weekStart, weekEnd, combinedHours, coveredDays, requiredDays: requiredDates.length,
      });
    }
  }
  return warnings.sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.staffId.localeCompare(b.staffId));
}

export type RunLineKind =
  | "basic" | "day-rate" | "overtime" | "lunch" | "allowance"
  | "incentive" | "service-charge" | "deduction" | "manual-earning" | "manual-deduction"
  | "leave-payout" | "unpaid-leave" | "ot-bank-payout" | "ewf-employee" | "ewf-employer";

export interface LeavePayrollPayout {
  entryId: string;
  typeId: string;
  typeName: string;
  date: string;
  days: number;
  rate: number;
  amount: number;
  taxable: boolean;
  socialSecurity: boolean;
  decidedBy: string;
}

export interface LeavePayrollUnpaid {
  entryId: string;
  dates: string[];
  days: number;
  rate: number;
  amount: number;
}

export interface LeavePayrollInputs {
  payouts: LeavePayrollPayout[];
  unpaid: LeavePayrollUnpaid[];
}

export interface RunLineEdit {
  lineId: string;
  action: "replace" | "reject" | "reinstate";
  amount?: number;
  reason: string;
}

export interface RunRevenueOverlay {
  month: string;
  streams: Partial<Record<StreamKey, number>>;
  reason?: string;
}

export interface RunManualLine {
  id: string;
  staffId: string;
  kind: "earning" | "deduction";
  name: string;
  amount: number;
  source: "salary" | "service-charge";
  reason: string;
  /** Manual earnings default to non-taxable/non-contributory unless explicitly selected. */
  taxable?: boolean;
  socialSecurity?: boolean;
}

/** Draft adapter accepts the shared browser-store shape plus calculation-only input extensions. */
export type PayrollRunDraft = Partial<Pick<StoreRunDraft,
  "revenueOverrides" | "costOfSalesOverrides" | "manualAdjustments" | "overtimeDecisions"
>> & {
  revenueOverlay?: RunRevenueOverlay | null;
  manualFigures?: Array<{ ruleId: string; staffId: string | null; value: number; reason?: string }>;
  lineOverrides?: Record<string, StoreRunLineOverride> | RunLineEdit[];
  manualLines?: RunManualLine[];
  priorYearToDate?: PayrollPreviewOptions["priorYearToDate"];
};

export interface RunLedgerLine {
  id: string;
  staffId: string;
  staffName: string;
  kind: RunLineKind;
  name: string;
  source: "payroll" | "incentive" | "service-charge" | "deduction" | "manual";
  budgetSource?: "salary" | "service-charge";
  sourceRuleId?: string;
  sourceMonth?: string;
  amount: number;
  calculatedAmount: number;
  currency: "THB" | "MYR";
  eligible: boolean;
  rejected: boolean;
  formula: string;
  workings: string[];
  occurrenceDetails?: DeductionOccurrenceBreakdown[];
  override?: { action: RunLineEdit["action"]; reason: string };
  taxable?: boolean;
  socialSecurity?: boolean;
}

export interface RunStaffOverview {
  staffId: string;
  name: string;
  role: string;
  currency: "THB" | "MYR";
  grossPay: number;
  employeeStatutory: number;
  incomeTaxWithholding: number;
  deductions: number;
  netPay: number;
  employerStatutory: number;
  employerCost: number;
  socialSecurityWages: number;
  taxableWages: number;
  statutoryBreakdown: EffectiveStaffPayrollCalculation["statutoryBreakdown"];
  ewf: EwfResult | null;
  annualProjectedTax: number;
  lines: RunLedgerLine[];
  steps: string[];
}

export interface MonthEndCalculation {
  branchId: BranchId;
  branchName: string;
  month: string;
  currency: "THB" | "MYR";
  serviceEarningMonth: string;
  servicePool: number;
  serviceRevenueAvailable: boolean;
  rows: RunStaffOverview[];
  ledger: RunLedgerLine[];
  /** Exact leave input records captured by this calculation; locked snapshots freeze this object. */
  leavePayrollInputs: Record<string, LeavePayrollInputs>;
  /** Stable leave source IDs and captured calculation period for audit/reopen provenance. */
  sourceManifest: {
    leavePolicyVersion: string;
    leave: Array<{ staffId: string; payoutEntryIds: string[]; unpaidEntryIds: string[] }>;
  };
  /** Per-employee EWF rules, wage classification and amounts frozen with this calculation. */
  ewf: { entityId: string; headcount: number; staff: Array<{ staffId: string; result: EwfResult }> } | null;
  warnings: string[];
  totals: {
    grossPay: number;
    employeeStatutory: number;
    incomeTaxWithholding: number;
    deductions: number;
    netPay: number;
    employerStatutory: number;
    employerCost: number;
  };
  companyTotals?: Partial<Record<"THB" | "MYR", MonthEndCalculation["totals"]>>;
  steps: string[];
}

const STREAMS: StreamKey[] = ["tickets", "eventsParties", "cafeFnb", "retail", "memberships"];
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const leaveMoney = (value: number, currency: "THB" | "MYR") =>
  `${currency === "THB" ? "฿" : "RM"}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function assertMonth(month: string) {
  if (!MONTH.test(month)) throw new Error(`Invalid payroll month: ${month}. Expected YYYY-MM.`);
}

function nonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative amount.`);
  return roundMoney(value);
}

function frozenLeaveRate(
  data: PayrollWorld,
  branchId: BranchId,
  staffId: string,
  entryId: string,
  inputRate: number,
): number {
  const source = data.leaveLedger.find((entry) =>
    entry.entryId === entryId && entry.branchId === branchId && entry.staffId === staffId);
  if (!source || !Number.isFinite(source.rate) || source.rate! < 0 || source.rate !== inputRate) {
    throw new Error(`Leave payroll source ${entryId} for ${staffId} is missing its captured daily rate.`);
  }
  return source.rate!;
}

function normalizeDraft(draft: PayrollRunDraft, month: string): PayrollRunDraft {
  const manualLines: RunManualLine[] = [
    ...(draft.manualLines ?? []),
    ...((draft.manualAdjustments ?? []) as ManualRunAdjustment[]).map((item) => ({
      id: item.id,
      staffId: item.staffId,
      kind: item.kind,
      name: item.kind === "earning" ? "Manual earning" : "Manual deduction",
      amount: item.amount,
      source: item.source,
      reason: item.reason,
    })),
  ];
  const lineOverrides: RunLineEdit[] = Array.isArray(draft.lineOverrides)
    ? draft.lineOverrides
    : Object.entries(draft.lineOverrides ?? {}).map(([lineId, override]) => ({
      lineId,
      action: override.status === "changed" ? "replace" : override.status === "rejected" ? "reject" : "reinstate",
      amount: override.amount,
      reason: override.reason,
    }));
  return {
    ...draft,
    revenueOverlay: draft.revenueOverlay ?? (draft.revenueOverrides || draft.costOfSalesOverrides
      ? { month, streams: draft.revenueOverrides ?? {} }
      : undefined),
    manualLines,
    lineOverrides,
  };
}

function applyDraftInputs(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  draft: PayrollRunDraft,
): PayrollWorld {
  for (const [stream, value] of Object.entries(draft.costOfSalesOverrides ?? {})) {
    if (!STREAMS.includes(stream as StreamKey)) throw new Error(`Unsupported cost-of-sales stream ${stream}.`);
    nonNegative(value as number, `Cost of sales ${stream}`);
  }
  const copy: PayrollWorld = {
    ...data,
    revenue: data.revenue.map((row) => row.branchId === branchId && draft.revenueOverlay?.month === row.month
      ? {
        ...row, streams: { ...row.streams, ...draft.revenueOverlay.streams },
        costOfSales: { ...row.costOfSales, ...(draft.costOfSalesOverrides ?? {}) },
      }
      : row),
    manualFigures: [...data.manualFigures],
  };
  if (draft.revenueOverlay) {
    assertMonth(draft.revenueOverlay.month);
    for (const [stream, value] of Object.entries(draft.revenueOverlay.streams)) {
      if (!STREAMS.includes(stream as StreamKey)) throw new Error(`Unsupported revenue stream ${stream}.`);
      nonNegative(value as number, `Revenue overlay ${stream}`);
    }
    const exists = copy.revenue.some((row) => row.branchId === branchId && row.month === draft.revenueOverlay!.month);
    if (!exists) {
      if (STREAMS.some((key) => draft.revenueOverlay!.streams[key] === undefined)) {
        throw new Error(`Revenue for ${branchId} ${draft.revenueOverlay.month} is unavailable; the overlay must supply all revenue streams.`);
      }
      const streams = Object.fromEntries(STREAMS.map((key) => [key, 0])) as Record<StreamKey, number>;
      Object.assign(streams, draft.revenueOverlay.streams);
       copy.revenue.push({
         branchId, month: draft.revenueOverlay.month, streams,
         costOfSales: Object.fromEntries(STREAMS.map((key) => [key, draft.costOfSalesOverrides?.[key] ?? 0])) as Record<StreamKey, number>,
       });
    }
  }
  for (const input of draft.manualFigures ?? []) {
    if (!Number.isFinite(input.value)) throw new Error(`Manual incentive figure ${input.ruleId} must be finite.`);
    if (!data.branches[branchId]?.incentiveRules.some((rule) => rule.id === input.ruleId)) {
      throw new Error(`Unknown incentive rule for manual figure: ${input.ruleId}.`);
    }
    if (input.staffId !== null && !data.branches[branchId]?.staff.some((staff) => staff.id === input.staffId)) {
      throw new Error(`Unknown staff member for manual figure: ${input.staffId}.`);
    }
    const existingIndex = copy.manualFigures.findIndex((item) =>
      item.branchId === branchId && item.month === month &&
      item.ruleId === input.ruleId && item.staffId === input.staffId);
    const record = { branchId, month, ruleId: input.ruleId, staffId: input.staffId, value: input.value };
    if (existingIndex >= 0) copy.manualFigures[existingIndex] = record;
    else copy.manualFigures.push(record);
  }
  return copy;
}

function overridesByLine(draft: PayrollRunDraft) {
  const map = new Map<string, RunLineEdit>();
  const values: RunLineEdit[] = Array.isArray(draft.lineOverrides)
    ? draft.lineOverrides
    : Object.entries(draft.lineOverrides ?? {}).map(([lineId, override]) => ({
      lineId,
      action: override.status === "changed" ? "replace" : override.status === "rejected" ? "reject" : "reinstate",
      amount: override.amount,
      reason: override.reason,
    }));
  for (const override of values) {
    if (!override.lineId || !override.reason.trim()) throw new Error("Every line override requires a line id and reason.");
    if (map.has(override.lineId)) throw new Error(`Duplicate line override for ${override.lineId}.`);
    if (!["replace", "reject", "reinstate"].includes(override.action)) throw new Error(`Invalid override action for ${override.lineId}.`);
    if (override.action === "replace") nonNegative(override.amount ?? Number.NaN, `Override ${override.lineId}`);
    map.set(override.lineId, override);
  }
  return map;
}

function finalizeLine(line: RunLedgerLine, override: RunLineEdit | undefined): RunLedgerLine {
  if (!override) return line;
  if (!line.eligible && override.action !== "reinstate") throw new Error(`Line ${line.id} is not eligible for override.`);
  if (override.action === "reject") return { ...line, amount: 0, rejected: true, override: { action: override.action, reason: override.reason } };
  if (override.action === "replace") return {
    ...line,
    amount: nonNegative(override.amount ?? Number.NaN, `Override ${line.id}`),
    rejected: false,
    override: { action: override.action, reason: override.reason },
  };
  return { ...line, amount: line.calculatedAmount, rejected: false, override: { action: override.action, reason: override.reason } };
}

function assertLineOverridePresence(lines: RunLedgerLine[], overrides: Map<string, RunLineEdit>) {
  const ids = new Set(lines.map((line) => line.id));
  for (const id of Array.from(overrides.keys())) if (!ids.has(id)) throw new Error(`Line override references unknown line ${id}.`);
}

function sums(data: PayrollWorld, branchId: BranchId, month: string, streams: StreamKey[]) {
  const revenue = data.revenue.find((item) => item.branchId === branchId && item.month === month);
  if (!revenue) return null;
  return streams.reduce((sum, key) => sum + revenue.streams[key], 0);
}

function daysInMonth(month: string) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

function serviceChargeEligibility(
  data: PayrollWorld,
  branchId: BranchId,
  earningMonth: string,
  staff: PayrollWorld["branches"][BranchId]["staff"][number],
  rules: ReturnType<typeof effectiveRulesForMonth>,
) {
  const first = `${earningMonth}-01`;
  const last = `${earningMonth}-${String(daysInMonth(earningMonth)).padStart(2, "0")}`;
  const workDays = data.attendance.filter((day) =>
    day.branchId === branchId && day.staffId === staff.id &&
    day.date.slice(0, 7) === earningMonth && day.scheduled && !day.dayOff).length;
  const activeDuringMonth = staff.joinedOn <= last && (!staff.leftOn || staff.leftOn >= first);
  const probationComplete = staff.probationEndsOn <= last;
  const reasons: string[] = [];
  if (!staff.serviceChargeEligible) reasons.push("staff profile is not service-charge eligible");
  if (!activeDuringMonth) reasons.push(`not employed during ${earningMonth} (joined ${staff.joinedOn}${staff.leftOn ? `, left ${staff.leftOn}` : ""})`);
  if (workDays < rules.serviceCharge.minimumDays) {
    reasons.push(`${workDays} eligible scheduled day(s), below ${rules.serviceCharge.minimumDays} required`);
  }
  if (rules.serviceCharge.probationRequired && !probationComplete) {
    reasons.push(`probation ends ${staff.probationEndsOn}, after earning-month end ${last}`);
  }
  if (!rules.serviceCharge.includeCasuals && isCasualStaff(staff)) reasons.push("casual staff are excluded by the service-charge rule");
  return {
    workDays,
    activeDuringMonth,
    probationComplete,
    eligible: staff.serviceChargeEligible && activeDuringMonth &&
      workDays >= rules.serviceCharge.minimumDays &&
      (!rules.serviceCharge.probationRequired || probationComplete) &&
      (rules.serviceCharge.includeCasuals || !isCasualStaff(staff)),
    reasons,
  };
}

function serviceChargeWeight(
  staff: PayrollWorld["branches"][BranchId]["staff"][number],
  workDays: number,
  rules: ReturnType<typeof effectiveRulesForMonth>,
) {
  const serviceRule = rules.serviceCharge;
  if (serviceRule.allocation === "equal") return 1;
  if (serviceRule.allocation === "days") return workDays;
  if (serviceRule.allocation === "role-weight") return serviceRule.roleWeights[staff.role] ?? staff.serviceRoleWeight;
  return serviceRule.customPercentByStaffId[staff.id] ?? 0;
}

function assertNoInvalidRules(branchRules: (DeductionRule | IncentiveRule)[]) {
  if (branchRules.some((rule) => !rule.id)) throw new Error("A payroll rule is missing its identifier.");
}

function ewfFlag(
  rules: ReturnType<typeof effectiveRulesForMonth>,
  id: string,
  defaultWage: boolean,
  defaultReason: string,
): { countsAsWage: boolean; reason: string } {
  const flag = rules.componentFlags[id];
  return {
    countsAsWage: typeof flag?.ewfWage === "boolean" ? flag.ewfWage : defaultWage,
    reason: flag?.ewfReason?.trim() || defaultReason,
  };
}

function planIsUngatedCommission(branch: PayrollWorld["branches"][BranchId], planId: string, staffId: string) {
  const plan = [
    ...branch.employeeIncentivePlans.filter((item) => item.staffId === staffId),
    ...branch.roleIncentiveDefaults,
  ].find((item) => item.id === planId);
  return !!plan && plan.targetGate === null;
}

function calendarDates(from: string, through: string) {
  const dates: string[] = [];
  for (let date = Date.parse(`${from}T00:00:00.000Z`); date <= Date.parse(`${through}T00:00:00.000Z`); date += 86400000) {
    dates.push(new Date(date).toISOString().slice(0, 10));
  }
  return dates;
}

function allocateCentsAcrossDates(amount: number, dates: string[]) {
  if (!dates.length) return [];
  const totalCents = Math.max(0, Math.round((amount + Number.EPSILON) * 100));
  const baseCents = Math.floor(totalCents / dates.length);
  const remainder = totalCents - baseCents * dates.length;
  return dates.map((date, index) => ({
    date, cents: baseCents + (index < remainder ? 1 : 0),
  }));
}

function allocateMonthlyCentsAcrossDates(
  amount: number,
  dates: string[],
  membershipDate: string | null | undefined,
) {
  if (!dates.length) return [];
  const groups = new Map<"pre-membership" | "member-period", string[]>([
    ["pre-membership", []], ["member-period", []],
  ]);
  for (const date of dates) {
    const group = membershipDate && date >= membershipDate ? "member-period" : "pre-membership";
    groups.get(group)!.push(date);
  }
  const populatedGroups = Array.from(groups.values()).filter((group) => group.length);
  if (populatedGroups.length <= 1) return allocateCentsAcrossDates(amount, dates);
  const totalCents = Math.max(0, Math.round((amount + Number.EPSILON) * 100));
  let allocatedCents = 0;
  return populatedGroups.flatMap((group, index) => {
    const groupCents = index === populatedGroups.length - 1
      ? totalCents - allocatedCents
      : Math.round(totalCents * group.length / dates.length);
    allocatedCents += groupCents;
    return allocateCentsAcrossDates(groupCents / 100, group);
  });
}

function applyUnpaidLeaveByDate(
  wages: Array<{ date: string; cents: number }>,
  unpaid: LeavePayrollInputs["unpaid"],
  membershipDate: string | null | undefined,
) {
  const amountByDate = new Map(wages.map((item) => [item.date, item.cents]));
  const reductionsByDate = new Map<string, number>();
  for (const entry of unpaid) {
    for (const item of allocateCentsAcrossDates(entry.amount, entry.dates)) {
      reductionsByDate.set(item.date, (reductionsByDate.get(item.date) ?? 0) + item.cents);
    }
  }
  const remainingByGroup = new Map<"pre-membership" | "member-period", number>();
  for (const [date, reduction] of Array.from(reductionsByDate)) {
    const group = membershipDate && date >= membershipDate ? "member-period" : "pre-membership";
    const current = amountByDate.get(date) ?? 0;
    const applied = Math.min(current, reduction);
    amountByDate.set(date, current - applied);
    remainingByGroup.set(group, (remainingByGroup.get(group) ?? 0) + reduction - applied);
  }
  for (const [group, remaining] of Array.from(remainingByGroup)) {
    let amountToAllocate = remaining;
    const eligibleDates = wages.filter((item) =>
      (membershipDate && item.date >= membershipDate ? "member-period" : "pre-membership") === group &&
      (amountByDate.get(item.date) ?? 0) > 0).map((item) => item.date).sort().reverse();
    for (const date of eligibleDates) {
      if (amountToAllocate <= 0) break;
      const current = amountByDate.get(date) ?? 0;
      const applied = Math.min(current, amountToAllocate);
      amountByDate.set(date, current - applied);
      amountToAllocate -= applied;
    }
    if (amountToAllocate > 0) {
      throw new Error(`Unpaid leave salary reduction cannot be allocated without negative EWF wages in the ${group} wage window.`);
    }
  }
  return wages.map(({ date }) => ({ date, cents: amountByDate.get(date) ?? 0 }));
}

function ewfComponentsForStaff(
  branch: PayrollWorld["branches"][BranchId],
  staff: PayrollWorld["branches"][BranchId]["staff"][number],
  rules: ReturnType<typeof effectiveRulesForMonth>,
  ledgerLines: RunLedgerLine[],
  unpaidSalaryReduction: number,
  unpaidEntries: LeavePayrollInputs["unpaid"],
  holidayPremiumByDate: Array<{ date: string; amount: number }>,
  leavePayoutDates: LeavePayrollInputs["payouts"],
  attendance: PayrollWorld["attendance"],
  month: string,
  currency: "THB" | "MYR",
  branchId: BranchId,
): EwfComponent[] {
  const components: EwfComponent[] = [];
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  const coversFrom = staff.joinedOn > monthStart ? staff.joinedOn : monthStart;
  const coversThrough = staff.leftOn && staff.leftOn < monthEnd ? staff.leftOn : monthEnd;
  const hasEmploymentSpan = coversFrom <= coversThrough;
  const membershipDate = staff.ewfMembership?.membershipJoinDate ?? null;
  const add = (
    id: string, name: string, amount: number, defaultWage: boolean, defaultReason: string,
    timing: Pick<EwfComponent, "earnedOn" | "coversFrom" | "coversThrough"> = {},
  ) => {
    const policy = ewfFlag(rules, id, defaultWage, defaultReason);
    const hasReliableEarningDate = timing.earnedOn !== undefined ||
      (timing.coversFrom !== undefined && timing.coversThrough !== undefined);
    const reason = policy.countsAsWage && amount > 0 && !hasReliableEarningDate
      ? `${policy.reason} No reliable earning date/span is available; the amount is conservatively treated as pre-membership.`
      : policy.reason;
    components.push({
      id, name, amount: roundMoney(Math.max(0, amount)), countsAsWage: policy.countsAsWage,
      reason, branchId, staffId: staff.id, currency, ...timing,
    });
  };
  const salaryLine = ledgerLines.find((line) => line.kind === "basic");
  const dayRateLine = ledgerLines.find((line) => line.kind === "day-rate");
  const addMonthlySegments = (
    id: string,
    name: string,
    lineAmount: number,
    applyUnpaid: boolean,
    defaultWage: boolean,
    defaultReason: string,
  ) => {
    if (!hasEmploymentSpan) {
      add(id, name, Math.max(0, lineAmount - (applyUnpaid ? unpaidSalaryReduction : 0)), defaultWage,
        `${defaultReason} Unpaid salary reduction ${applyUnpaid ? unpaidSalaryReduction.toFixed(2) : "0.00"} deducted from the monthly amount; no employed calendar span is available.`,
      );
      return;
    }
    const earnedDates = calendarDates(coversFrom, coversThrough);
    const grossByDate = allocateMonthlyCentsAcrossDates(lineAmount, earnedDates, membershipDate);
    const paidByDate = applyUnpaid
      ? applyUnpaidLeaveByDate(grossByDate, unpaidEntries, membershipDate)
      : grossByDate;
    const groups = new Map<"pre-membership" | "member-period", Array<{ date: string; cents: number }>>([
      ["pre-membership", []], ["member-period", []],
    ]);
    for (const item of paidByDate) {
      const group = membershipDate && item.date >= membershipDate ? "member-period" : "pre-membership";
      groups.get(group)!.push(item);
    }
    for (const [group, items] of Array.from(groups)) {
      if (!items.length) continue;
      const amount = items.reduce<number>((sum, item) => sum + item.cents, 0) / 100;
      const from = items[0].date;
      const through = items[items.length - 1].date;
      const segmentName = membershipDate && group === "pre-membership"
        ? `${name} · before membership`
        : membershipDate && group === "member-period"
          ? `${name} · from membership`
          : name;
      add(id, segmentName, amount, defaultWage,
        `${defaultReason} Covers ${from} through ${through}; ${applyUnpaid
          ? `unpaid leave reductions are applied on their actual dates within this membership window (period reduction ${unpaidSalaryReduction.toFixed(2)}).`
          : "no unpaid salary reduction is applied to this allowance."}`,
        { coversFrom: from, coversThrough: through });
    }
    const expected = Math.max(0, Math.round((lineAmount - (applyUnpaid ? unpaidSalaryReduction : 0) + Number.EPSILON) * 100));
    const actual = paidByDate.reduce((sum, item) => sum + item.cents, 0);
    if (actual !== expected) {
      throw new Error(`EWF dated monthly component ${id} does not reconcile to gross wages after unpaid leave (${(actual / 100).toFixed(2)} vs ${(expected / 100).toFixed(2)}).`);
    }
  };
  if (staff.monthlySalary !== null) {
    addMonthlySegments("baseSalary", "Salary", Math.max(0, salaryLine?.amount ?? 0), true, true,
      "Normal monthly salary is included as wages.");
  } else {
    const earnedDays = attendance.filter((day) => day.branchId === branchId && day.staffId === staff.id &&
      day.date.slice(0, 7) === month && day.scheduled && !day.dayOff).map((day) => day.date);
    if (earnedDays.length) {
      const grossByDate = allocateCentsAcrossDates(Math.max(0, dayRateLine?.amount ?? 0), earnedDays);
      const paidByDate = applyUnpaidLeaveByDate(grossByDate, unpaidEntries, membershipDate);
      paidByDate.forEach(({ date: earnedOn, cents }) => add(
        "baseSalary", "Day-rate pay", cents / 100, true,
        `Day-rate pay is attributed to scheduled work date ${earnedOn}; unpaid salary reductions are applied on their actual dates.`,
        { earnedOn },
      ));
      const expected = Math.max(0, Math.round(((dayRateLine?.amount ?? 0) - unpaidSalaryReduction + Number.EPSILON) * 100));
      const actual = paidByDate.reduce((sum, item) => sum + item.cents, 0);
      if (actual !== expected) {
        throw new Error(`EWF dated day-rate wages do not reconcile after unpaid leave (${(actual / 100).toFixed(2)} vs ${(expected / 100).toFixed(2)}).`);
      }
    } else {
      add("baseSalary", "Day-rate pay", Math.max(0, (dayRateLine?.amount ?? 0) - unpaidSalaryReduction), true,
        `Day-rate period amount has no reliable attendance earning dates; unpaid salary reduction ${unpaidSalaryReduction.toFixed(2)} is deducted and any PF exemption is conservatively limited.`);
    }
  }

  for (const line of ledgerLines.filter((item) => item.kind === "allowance")) {
    const allowanceId = line.sourceRuleId ?? line.id.split(":").at(-1) ?? "";
    const id = `allowance:${allowanceId}`;
    const name = line.name.toLowerCase();
    const includedByDefault = /position|professional|fuel/.test(name) || /position|professional|fuel/.test(allowanceId.toLowerCase());
    const defaultReason = includedByDefault
      ? "Position/professional/fixed fuel allowance is included by the prototype default."
      : "Welfare, meal, transport-expense, or unclassified allowance is excluded by the prototype default; accountant confirmation is recommended.";
    addMonthlySegments(id, line.name, line.amount, false, includedByDefault, defaultReason);
  }
  const lunch = ledgerLines.filter((line) => line.kind === "lunch").reduce((sum, line) => sum + line.amount, 0);
  add("lunch", "Lunch", lunch, false, "Meal/lunch welfare is excluded from EWF wages by the prototype default.");
  const overtime = ledgerLines.filter((line) => line.kind === "overtime").reduce((sum, line) => sum + line.amount, 0);
  const holidayPremium = holidayPremiumByDate.reduce((sum, item) => sum + item.amount, 0);
  add("overtime", "Overtime", Math.max(0, overtime - holidayPremium), false,
    "Overtime outside normal hours is excluded; any scheduled holiday-pay premium is classified separately.");
  holidayPremiumByDate.forEach(({ date, amount }) => add("holidayPay", `Paid holiday premium · ${date}`, amount, true,
    `Paid public-holiday premium was earned on ${date}; it is separately identified from overtime.`, { earnedOn: date }));
  const serviceCharge = ledgerLines.filter((line) => line.kind === "service-charge").reduce((sum, line) => sum + line.amount, 0);
  add("serviceCharge", "Service charge", serviceCharge, false,
    "Service charge is excluded from EWF wages by the prototype default.");

  for (const line of ledgerLines.filter((item) => item.kind === "incentive")) {
    const commissionId = line.id.startsWith("employee-incentive:")
      ? `employeeCommission:${line.sourceRuleId ?? ""}`
      : line.id.startsWith("voucher:")
        ? "boothVoucher"
        : `incentive:${line.sourceRuleId ?? ""}`;
    const isBoothVoucher = commissionId === "boothVoucher";
    const isEmployeePlan = commissionId.startsWith("employeeCommission:");
    const planId = line.sourceRuleId ?? "";
    const planCommission = isEmployeePlan && planIsUngatedCommission(branch, planId, staff.id);
    const rule = !isEmployeePlan && !isBoothVoucher
      ? branch.incentiveRules.find((item) => item.id === line.sourceRuleId)
      : undefined;
    const genericCommission = !!rule && rule.metric === "revenue" &&
      rule.reward.type === "percent" && rule.targetGate === null;
    const defaultWage = !isBoothVoucher && (planCommission || genericCommission);
    const defaultReason = isBoothVoucher
      ? "Booth voucher payouts are excluded; accountant confirmation is recommended."
      : defaultWage
        ? "Undated ungated percentage-of-revenue commission is conservatively treated as earned before PF membership and included from the first baht; accountant confirmation is recommended."
        : "Target-gated, fixed, tiered, or otherwise unverified incentive is excluded by the prototype default.";
    add(commissionId, line.name, line.amount, defaultWage, defaultReason);
  }

  for (const line of ledgerLines.filter((item) => item.kind === "leave-payout")) {
    const payout = leavePayoutDates.find((item) => line.id.endsWith(`:${item.entryId}`));
    add("exitLeavePayout", line.name, line.amount, false,
      "Unused-leave payout on exit is excluded from normal wage base as a termination settlement; accountant review is recommended.",
      payout?.date ? { earnedOn: payout.date } : {});
  }
  for (const line of ledgerLines.filter((item) => item.kind === "manual-earning")) {
    const id = `manual:${line.id.slice("manual:".length)}`;
    add(id, line.name, line.amount, false,
      "Undated manual earning is conservatively treated as earned before PF membership unless a component flag excludes it; an effective dated component flag can change its wage classification.");
  }
  return components;
}

/**
 * Calculates the complete current-month run. The input data and draft are never mutated.
 * Revenue and cost-of-sales overlays feed branch incentives and lagged service pools.
 */
/** Legacy branch compatibility engine. Active company demos use calculateCompanyMonthEnd. */
export function calculateMonthEnd(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  draft: PayrollRunDraft = {},
): MonthEndCalculation {
  assertMonth(month);
  const sourceBranch = data.branches[branchId];
  if (!sourceBranch) throw new Error(`Unknown payroll branch: ${branchId}.`);
  assertNoInvalidRules([...sourceBranch.incentiveRules, ...sourceBranch.deductionRules]);
  const normalizedDraft = normalizeDraft(draft, month);
  const runData = applyDraftInputs(data, branchId, month, normalizedDraft);
  const branch = runData.branches[branchId];
  const policyRules = effectiveRulesForMonth(branch, month);
  const complianceAttendance = runData.attendance;
  const overtimeDecisionByOccurrence = new Map((normalizedDraft.overtimeDecisions ?? []).map((decision) => [
    `${decision.attendanceId}:${decision.exceptionIndex}`, decision,
  ]));
  runData.attendance = runData.attendance.map((day) => {
    if (day.branchId !== branchId || day.date.slice(0, 7) !== month || day.overtimeHours <= 0) return day;
    const staff = branch.staff.find((person) => person.id === day.staffId);
    if (!staff) return day;
    const actualExceptionIndex = day.exceptions.findIndex((exception) => exception.kind === "overtime");
    const occurrenceIndex = actualExceptionIndex >= 0 ? actualExceptionIndex : -1;
    const outcome = overtimeDecisionByOccurrence.get(`${day.id}:${occurrenceIndex}`)?.outcome;
    const policy = overtimePolicyForRole(policyRules.overtimePolicy, staff.role);
    const hours = outcome === "Bank" || outcome === "Reject"
      ? 0
      : roundedOvertimeHours(day.overtimeHours, policy);
    return hours === day.overtimeHours ? day : { ...day, overtimeHours: hours };
  });
  const preview = calculatePayrollPreview(runData, branchId, month, { priorYearToDate: normalizedDraft.priorYearToDate });
  let deductionPreview: ReturnType<typeof calculatePayrollPreview> | undefined;
  const rules = effectiveRulesForMonth(branch, month);
  const details = effectiveBranchDetailsForMonth(branch, month);
  const incentives = calculateIncentiveMonth(runData, branchId, month);
  const lineOverrides = overridesByLine(normalizedDraft);
  const warnings: string[] = [];
  warnings.push(...(incentives.warnings ?? []));
  const thailandWeeklyWarnings = thailandWeeklyOvertimeWarnings(
    runData, branchId, month, complianceAttendance,
  );
  const thailandWarningsByStaff = new Map<string, string[]>();
  for (const warning of thailandWeeklyWarnings) {
    const partial = warning.coveredDays < warning.requiredDays;
    const message = partial
      ? `Thailand weekly OT + holiday work: ${warning.combinedHours.toFixed(2)}h is above 36h for ${warning.weekStart}–${warning.weekEnd}; coverage is partial (${warning.coveredDays}/${warning.requiredDays} employment days), so the total may be higher.`
      : `Thailand weekly OT + holiday work: ${warning.combinedHours.toFixed(2)}h is above 36h for ${warning.weekStart}–${warning.weekEnd} (Monday–Sunday). Review the Thai labor-limit exposure.`;
    warnings.push(message);
    thailandWarningsByStaff.set(warning.staffId, [
      ...(thailandWarningsByStaff.get(warning.staffId) ?? []), message,
    ]);
  }
  const rows: RunStaffOverview[] = [];
  const ledger: RunLedgerLine[] = [];
  const ewfStaffResults: Array<{ staffId: string; result: EwfResult }> = [];
  const leaveInputsByStaff: Record<string, LeavePayrollInputs> = {};
  const leaveManifest: MonthEndCalculation["sourceManifest"]["leave"] = [];
  const leavePolicyVersion = effectiveLeavePolicy(
    data, branchId, `${month}-${String(daysInMonth(month)).padStart(2, "0")}`,
  ).effectiveFrom;

  for (const staff of branch.staff) {
    const leaveInputs = leavePayrollInputs(data, branchId, month, staff.id);
    if (!leaveInputs || !Array.isArray(leaveInputs.payouts) || !Array.isArray(leaveInputs.unpaid)) {
      throw new Error(`Leave payroll inputs are unavailable or incomplete for ${branchId}/${month}/${staff.id}.`);
    }
    leaveInputsByStaff[staff.id] = structuredClone(leaveInputs);
    leaveManifest.push({
      staffId: staff.id,
      payoutEntryIds: leaveInputs.payouts.map((item) => item.entryId),
      unpaidEntryIds: leaveInputs.unpaid.map((item) => item.entryId),
    });
    const previewRow = preview.rows.find((row) => row.staffId === staff.id);
    if (!previewRow) throw new Error(`Payroll preview has no row for staff member ${staff.id}.`);
    const scheduledWorkingDays = runData.attendance.filter((day) =>
      day.branchId === branchId && day.staffId === staff.id && day.date.slice(0, 7) === month &&
      day.scheduled && !day.dayOff).length;
    const staffIncentives = incentives.rows.filter((row) => row.staffId === staff.id);
    const staffLines: RunLedgerLine[] = [];
    const baseLines: RunLedgerLine[] = [];
    const add = (line: RunLedgerLine) => {
      const finalized = finalizeLine(line, lineOverrides.get(line.id));
      staffLines.push(finalized);
      return finalized;
    };
    const regularLine = add({
      id: `basic:${staff.id}`, staffId: staff.id, staffName: staff.name, kind: "basic", name: "Basic salary",
      source: "payroll", amount: previewRow.regularPay, calculatedAmount: previewRow.regularPay,
      currency: preview.currency, eligible: staff.monthlySalary !== null, rejected: false,
      formula: `${staff.monthlySalary ?? 0} monthly salary × employed calendar proration`,
      workings: [`Effective monthly base ${staff.monthlySalary?.toFixed(2) ?? "0.00"} × employed-day factor = ${previewRow.regularPay.toFixed(2)}.`, previewRow.steps[0]],
    });
    baseLines.push(regularLine);
    const casualLine = add({
      id: `day-rate:${staff.id}`, staffId: staff.id, staffName: staff.name, kind: "day-rate", name: "Day-rate pay",
      source: "payroll", amount: previewRow.casualDayPay, calculatedAmount: previewRow.casualDayPay,
      currency: preview.currency, eligible: staff.dayRate !== null, rejected: false,
      formula: `${staff.dayRate ?? 0} day rate × ${scheduledWorkingDays} scheduled work days`,
      workings: [`Day rate ${staff.dayRate?.toFixed(2) ?? "0.00"} × ${scheduledWorkingDays} scheduled work days = ${previewRow.casualDayPay.toFixed(2)}.`],
    });
    baseLines.push(casualLine);
    const allowanceAmount = previewRow.allowances;
    let allowanceRemaining = allowanceAmount;
    for (const allowance of rules.allowances) {
      const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
      const first = `${month}-01`;
      const last = `${month}-${String(days).padStart(2, "0")}`;
      const start = staff.joinedOn > first ? staff.joinedOn : first;
      const end = staff.leftOn && staff.leftOn < last ? staff.leftOn : last;
      const activeDays = end < start ? 0 : Math.floor(
        (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000,
      ) + 1;
      const divisor = rules.calendarProration.method === "actual-calendar-days" ? days : rules.calendarProration.divisor;
      const isLastAllowance = allowance.id === rules.allowances[rules.allowances.length - 1]?.id;
      const itemAmount = isCasualStaff(staff) ? 0 : isLastAllowance
        ? allowanceRemaining
        : roundMoney(allowance.amount * Math.min(1, activeDays / divisor));
      allowanceRemaining = roundMoney(allowanceRemaining - itemAmount);
      const line = add({
        id: `allowance:${staff.id}:${allowance.id}`, staffId: staff.id, staffName: staff.name,
        kind: "allowance", name: allowance.name, source: "payroll", sourceRuleId: allowance.id,
        amount: itemAmount, calculatedAmount: itemAmount, currency: preview.currency,
        eligible: !isCasualStaff(staff), rejected: false,
        formula: `${allowance.amount} fixed monthly allowance × employed calendar proration`,
        workings: [`Configured amount ${allowance.amount.toFixed(2)}; prorated line ${itemAmount.toFixed(2)}.`],
        taxable: allowance.taxable, socialSecurity: allowance.socialSecurity,
      });
      baseLines.push(line);
    }
    const lunchLine = add({
      id: `lunch:${staff.id}`, staffId: staff.id, staffName: staff.name, kind: "lunch", name: "Lunch",
      source: "payroll", amount: previewRow.lunch, calculatedAmount: previewRow.lunch,
      currency: preview.currency, eligible: true, rejected: false,
      formula: `${(rules.lunchByRole[staff.role] ?? 0).toFixed(2)} role rate × scheduled work days`,
      workings: [`${(rules.lunchByRole[staff.role] ?? 0).toFixed(2)} × ${scheduledWorkingDays} scheduled work days = ${previewRow.lunch.toFixed(2)}.`],
    });
    baseLines.push(lunchLine);
    const otRows = runData.attendance.filter((day) => day.branchId === branchId && day.staffId === staff.id &&
      day.date.slice(0, 7) === month && day.overtimeHours > 0);
    const otHours = otRows.reduce((sum, day) => sum + day.overtimeHours, 0);
    const policy = overtimePolicyForRole(rules.overtimePolicy, staff.role);
    const rawOtRows = data.attendance.filter((day) => day.branchId === branchId && day.staffId === staff.id &&
      day.date.slice(0, 7) === month && day.overtimeHours > 0);
    const recordedOtHours = rawOtRows.reduce((sum, day) =>
      sum + roundedOvertimeHours(day.overtimeHours, policy), 0);
    const bankedHours = rawOtRows.reduce((sum, day) => {
      const index = day.exceptions.findIndex((exception) => exception.kind === "overtime");
      return overtimeDecisionByOccurrence.get(`${day.id}:${index}`)?.outcome === "Bank"
        ? sum + roundedOvertimeHours(day.overtimeHours, policy) * policy.bankConversionRate
        : sum;
    }, 0);
    const rejectedHours = rawOtRows.reduce((sum, day) => {
      const index = day.exceptions.findIndex((exception) => exception.kind === "overtime");
      return overtimeDecisionByOccurrence.get(`${day.id}:${index}`)?.outcome === "Reject"
        ? sum + roundedOvertimeHours(day.overtimeHours, policy)
        : sum;
    }, 0);
    if (policy.requirePreapprovalOrSchedule) {
      rawOtRows.filter((day) => !day.overtimePreapproved && !day.overtimeScheduled).forEach((day) => {
        warnings.push(`${staff.name}: ${day.date} has ${day.overtimeHours}h overtime without recorded preapproval or schedule evidence; verify the legally payable amount.`);
      });
    }
    if (recordedOtHours > policy.monthlyCapHours) {
      warnings.push(`${staff.name}: ${recordedOtHours.toFixed(2)} recorded overtime hours exceed the ${policy.monthlyCapHours}h monthly policy threshold. The threshold is an alert only; it does not suppress wages.`);
    }
    const hourlyRate = staff.monthlySalary !== null
      ? staff.monthlySalary / rules.hourlyBase.monthlySalaryDays / rules.hourlyBase.monthlyHoursPerDay
      : (staff.dayRate ?? 0) / rules.hourlyBase.casualDayHours;
    const holidayPremiumRawByDate = runData.attendance
      .filter((day) => day.branchId === branchId && day.staffId === staff.id &&
        day.date.slice(0, 7) === month && day.scheduled && !day.dayOff && day.holiday)
      .flatMap((day) => {
        if (!day.plannedClockIn || !day.plannedClockOut) return [];
        const [startHour, startMinute] = day.plannedClockIn.split(":").map(Number);
        const [endHour, endMinute] = day.plannedClockOut.split(":").map(Number);
        const minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
        const hours = (minutes < 0 ? minutes + 1440 : minutes) / 60;
        return [{ date: day.date, amount: hourlyRate * hours * Math.max(0, rules.overtimeMultipliers.restDay - 1) }];
      });
    const holidayPremium = roundMoney(holidayPremiumRawByDate.reduce((sum, item) => sum + item.amount, 0));
    const holidayPremiumByDate = holidayPremiumRawByDate.map((item) => ({ ...item, amount: roundMoney(item.amount) }));
    const holidayRoundingDelta = roundMoney(holidayPremium - holidayPremiumByDate.reduce((sum, item) => sum + item.amount, 0));
    if (holidayPremiumByDate.length && holidayRoundingDelta) {
      holidayPremiumByDate[holidayPremiumByDate.length - 1].amount =
        roundMoney(holidayPremiumByDate[holidayPremiumByDate.length - 1].amount + holidayRoundingDelta);
    }
    const otLine = add({
      id: `overtime:${staff.id}`, staffId: staff.id, staffName: staff.name, kind: "overtime", name: "Overtime",
      source: "payroll", amount: previewRow.overtime, calculatedAmount: previewRow.overtime,
      currency: preview.currency, eligible: staff.otEligible && rules.overtimeEligibilityByRole[staff.role], rejected: false,
      formula: "hourly base × approved hours × dated OT multipliers + scheduled public-holiday premium",
      workings: [
        ...otRows.map((day) => `${day.date}: ${day.overtimeHours}h paid × ${day.holiday ? rules.overtimeMultipliers.publicHoliday : day.dayOff ? rules.overtimeMultipliers.restDay : rules.overtimeMultipliers.regular} multiplier${day.holiday ? " (public holiday)" : day.dayOff ? " (rest day)" : ""}.`),
        ...(bankedHours > 0 ? [`${bankedHours.toFixed(2)}h banked under the selected policy; excluded from paid OT wages.`] : []),
        ...(rejectedHours > 0 ? [`${rejectedHours.toFixed(2)}h rejected with an audited reason; excluded from OT wages.`] : []),
        ...(thailandWarningsByStaff.get(staff.id) ?? []),
        `Hourly rate ${staff.monthlySalary !== null
          ? `${staff.monthlySalary.toFixed(2)} ÷ ${rules.hourlyBase.monthlySalaryDays} salary days ÷ ${rules.hourlyBase.monthlyHoursPerDay} hours`
          : `${(staff.dayRate ?? 0).toFixed(2)} day rate ÷ ${rules.hourlyBase.casualDayHours} casual hours`} = ${hourlyRate.toFixed(2)}; total recorded OT ${otHours}h; Phase 1 OT and scheduled holiday premium = ${previewRow.overtime.toFixed(2)}.`,
      ],
    });
    baseLines.push(otLine);
    const serviceRevenue = runData.revenue.find((row) =>
      row.branchId === branchId && row.month === preview.serviceEarningMonth);
    const selectedServiceRevenue = serviceRevenue
      ? rules.serviceCharge.revenueStreams.reduce((sum, stream) => sum + serviceRevenue.streams[stream], 0)
      : null;
    const serviceEligibility = serviceChargeEligibility(
      runData, branchId, preview.serviceEarningMonth, staff, rules,
    );
    const eligibleServiceWeights = branch.staff.flatMap((person) => {
      const eligibility = serviceChargeEligibility(runData, branchId, preview.serviceEarningMonth, person, rules);
      return eligibility.eligible
        ? [{ staff: person, weight: serviceChargeWeight(person, eligibility.workDays, rules) }]
        : [];
    });
    const totalServiceWeight = eligibleServiceWeights.reduce((sum, item) => sum + item.weight, 0);
    const staffServiceWeight = serviceChargeWeight(staff, serviceEligibility.workDays, rules);
    const calculatedServiceAmount = previewRow.serviceCharge;
    const staffSharePercent = preview.servicePool > 0
      ? calculatedServiceAmount / preview.servicePool * 100
      : 0;
    const serviceZeroReason = !serviceRevenue
      ? `No revenue record exists for earning month ${preview.serviceEarningMonth}; no pool/share is available.`
      : preview.servicePool <= 0
        ? `The earning-month source exists, but selected stream revenue ${selectedServiceRevenue!.toFixed(2)} × ${(rules.serviceCharge.rate * 100).toFixed(2)}% produces a zero pool.`
        : !serviceEligibility.eligible
          ? `No share: ${serviceEligibility.reasons.join("; ")}.`
          : totalServiceWeight <= 0
            ? "No share: the eligible staff allocation weights total zero."
            : staffServiceWeight <= 0
              ? "No share: this eligible staff member has zero allocation weight."
              : `No positive share was allocated after currency rounding; calculated payout is ${calculatedServiceAmount.toFixed(2)}.`;
    const serviceShareFormula = calculatedServiceAmount > 0 && preview.servicePool > 0
      ? `${preview.servicePool.toFixed(2)} pool × ${staffSharePercent.toFixed(4)}% staff share = ${calculatedServiceAmount.toFixed(2)}`
      : `${preview.servicePool.toFixed(2)} pool × 0.0000% staff share = ${calculatedServiceAmount.toFixed(2)}; ${serviceZeroReason}`;
    const serviceLine = add({
      id: `service-charge:${staff.id}`, staffId: staff.id, staffName: staff.name, kind: "service-charge",
      name: `Service charge (${preview.serviceEarningMonth})`, source: "service-charge",
      amount: previewRow.serviceCharge, calculatedAmount: previewRow.serviceCharge,
      currency: preview.currency, eligible: serviceEligibility.eligible && serviceRevenue !== undefined, rejected: false,
      sourceMonth: preview.serviceEarningMonth,
      formula: serviceShareFormula,
      workings: [
        serviceRevenue
          ? `Earning month ${preview.serviceEarningMonth} source revenue available: ${rules.serviceCharge.revenueStreams.map((stream) => `${stream} ${serviceRevenue.streams[stream].toFixed(2)}`).join(", ")} = ${selectedServiceRevenue!.toFixed(2)}; × ${(rules.serviceCharge.rate * 100).toFixed(2)}% service rate = ${preview.servicePool.toFixed(2)} pool.`
          : `Earning month ${preview.serviceEarningMonth}: source revenue is missing for selected streams ${rules.serviceCharge.revenueStreams.join(", ")}; pool is unavailable and this line is zero.`,
        `${serviceEligibility.eligible ? "Eligible" : "Ineligible"} for earning-month ${preview.serviceEarningMonth} allocation; joined ${staff.joinedOn}; active during earning month ${serviceEligibility.activeDuringMonth ? "yes" : "no"}; probation ends ${staff.probationEndsOn} (${serviceEligibility.probationComplete ? "complete by month end" : "not complete by month end"}); probation required ${rules.serviceCharge.probationRequired ? "yes" : "no"}; eligible scheduled work days ${serviceEligibility.workDays}/${rules.serviceCharge.minimumDays} minimum; service-charge profile eligibility ${staff.serviceChargeEligible ? "yes" : "no"}; casual inclusion ${rules.serviceCharge.includeCasuals ? "enabled" : "excluded"}.${serviceEligibility.reasons.length ? ` Reasons: ${serviceEligibility.reasons.join("; ")}.` : ""}`,
        `Allocation ${rules.serviceCharge.allocation}; staff weight ${staffServiceWeight}; eligible total weight ${totalServiceWeight}. ${serviceShareFormula}.`,
      ],
    });
    baseLines.push(serviceLine);
    const incentiveLines: RunLedgerLine[] = staffIncentives.map((entry) => {
      const result = entry.result;
      const phase3b = "kind" in result ? result : null;
      const isEmployeePlan = phase3b?.kind === "employee-plan";
      const isVoucher = phase3b?.kind === "voucher";
      const rule = phase3b
        ? undefined
        : branch.incentiveRules.find((item) => item.id === entry.ruleId);
      const sourceRuleId = phase3b?.kind === "employee-plan" ? phase3b.planId
        : phase3b?.kind === "voucher" ? phase3b.voucherCode : entry.ruleId;
      const id = isEmployeePlan
        ? `employee-incentive:${staff.id}:${phase3b!.kind === "employee-plan" ? phase3b.planId : ""}`
        : isVoucher
          ? `voucher:${phase3b!.kind === "voucher" ? phase3b.voucherCode : ""}:${staff.id}`
          : `incentive:${staff.id}:${entry.ruleId}`;
      const steps = "steps" in result ? result.steps : [];
      const taxable = phase3b ? phase3b.taxable : rule?.taxable ?? false;
      const socialSecurity = phase3b ? phase3b.socialSecurity : rule?.socialSecurity ?? false;
      const line = add({
        id, staffId: staff.id, staffName: staff.name,
        kind: "incentive", name: entry.ruleName, source: "incentive", sourceRuleId,
        amount: entry.amount, calculatedAmount: entry.amount, currency: preview.currency,
        eligible: entry.eligible, rejected: false, formula: steps.join(" "),
        workings: [...steps], taxable, socialSecurity,
      });
      return line;
    });

    const leavePayoutLines = leaveInputs.payouts.map((payout) => {
      frozenLeaveRate(data, branchId, staff.id, payout.entryId, payout.rate);
      if (!payout.entryId || !payout.typeId || !payout.typeName || !payout.date || payout.date.slice(0, 7) !== month || !payout.decidedBy ||
        !Number.isFinite(payout.days) || payout.days <= 0 || !Number.isFinite(payout.rate) || payout.rate < 0 ||
        !Number.isFinite(payout.amount) || payout.amount < 0 ||
        Math.abs(roundMoney(payout.days * payout.rate) - roundMoney(payout.amount)) > 0.01 ||
        typeof payout.taxable !== "boolean" || typeof payout.socialSecurity !== "boolean") {
        throw new Error(`Invalid frozen leave payout input ${payout.entryId || "(missing id)"} for ${staff.name}.`);
      }
      return add({
        id: `leave-payout:${staff.id}:${payout.entryId}`,
        staffId: staff.id, staffName: staff.name, kind: "leave-payout",
        name: `Unused ${payout.typeName} leave payout`,
        source: "payroll", amount: roundMoney(payout.amount), calculatedAmount: roundMoney(payout.amount),
        currency: preview.currency, eligible: false, rejected: false,
        formula: `${payout.days} days × ${leaveMoney(payout.rate, preview.currency)} = ${leaveMoney(payout.amount, preview.currency)}`,
        workings: [
          `${payout.days} days × ${leaveMoney(payout.rate, preview.currency)} = ${leaveMoney(payout.amount, preview.currency)}.`,
          `Leave type ${payout.typeName}; payout date ${payout.date}; decision maker ${payout.decidedBy}.`,
          `Taxable: ${payout.taxable ? "yes" : "no"}; social-security inclusion: ${payout.socialSecurity ? "yes" : "no"}.`,
        ],
        taxable: payout.taxable, socialSecurity: payout.socialSecurity,
      });
    });
    const otBankPayoutLines = overtimePayoutsForMonth(data, branchId, staff.id, month).map((payout) => {
      const amount = roundMoney(payout.amount ?? 0);
      const flags = rules.componentFlags["ot-bank-payout"] ?? rules.componentFlags.overtime ??
        { taxable: true, socialSecurity: true };
      return add({
        id: `ot-bank-payout:${staff.id}:${payout.id}`,
        staffId: staff.id, staffName: staff.name, kind: "ot-bank-payout",
        name: payout.reason.includes("offboarding") ? "OT bank resignation payout" : "Expired OT bank payout",
        source: "payroll", sourceRuleId: payout.sourceKey,
        amount, calculatedAmount: amount, currency: preview.currency, eligible: false, rejected: false,
        formula: `${payout.hours.toFixed(4)} OT bank hours × ${preview.currency} ${(payout.rate ?? 0).toFixed(2)} captured hourly rate = ${preview.currency} ${amount.toFixed(2)}`,
        workings: [
          `${payout.hours.toFixed(4)} hours paid out on ${payout.date}; source ${payout.sourceKey}.`,
          payout.reason,
          `Taxable: ${flags.taxable ? "yes" : "no"}; social-security inclusion: ${flags.socialSecurity ? "yes" : "no"}.`,
        ],
        taxable: flags.taxable, socialSecurity: flags.socialSecurity,
      });
    });
    leaveInputs.unpaid.forEach((unpaid) => {
      frozenLeaveRate(data, branchId, staff.id, unpaid.entryId, unpaid.rate);
      if (!unpaid.entryId || !Array.isArray(unpaid.dates) || unpaid.dates.length === 0 ||
        unpaid.dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month) ||
        !Number.isFinite(unpaid.days) || unpaid.days <= 0 || !Number.isFinite(unpaid.rate) || unpaid.rate < 0 ||
        !Number.isFinite(unpaid.amount) || unpaid.amount < 0 ||
        Math.abs(roundMoney(unpaid.days * unpaid.rate) - roundMoney(unpaid.amount)) > 0.01) {
        throw new Error(`Invalid frozen unpaid leave input ${unpaid.entryId || "(missing id)"} for ${staff.name}.`);
      }
      add({
        id: `unpaid-leave:${staff.id}:${unpaid.entryId}`,
        staffId: staff.id, staffName: staff.name, kind: "unpaid-leave",
        name: "Unpaid leave salary reduction",
        source: "payroll", amount: -roundMoney(unpaid.amount), calculatedAmount: -roundMoney(unpaid.amount),
        currency: preview.currency, eligible: false, rejected: false,
        formula: `−${unpaid.days} days × ${leaveMoney(unpaid.rate, preview.currency)} = −${leaveMoney(unpaid.amount, preview.currency)}`,
        workings: [
          `Unpaid leave dates: ${unpaid.dates.join(", ")}.`,
          `${unpaid.days} days × captured daily rate ${leaveMoney(unpaid.rate, preview.currency)} = salary reduction ${leaveMoney(unpaid.amount, preview.currency)}.`,
        ],
      });
    });
    const leaveSalaryReduction = roundMoney(
      leaveInputs.unpaid.reduce((sum, item) => sum + roundMoney(item.amount), 0),
    );
    const sourceIds = [...leaveInputs.payouts.map((item) => item.entryId), ...leaveInputs.unpaid.map((item) => item.entryId)];
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new Error(`Duplicate leave payroll source entry for ${staff.name} in ${month}.`);
    }
    if (leaveSalaryReduction > roundMoney(regularLine.amount + casualLine.amount) + 0.01) {
      throw new Error(`Unpaid leave reduction exceeds base wages for ${staff.name} in ${month}.`);
    }

    const extras: StaffCalculationExtras = {
      componentAmounts: {
        regularPay: regularLine.amount,
        casualDayPay: casualLine.amount,
        lunch: lunchLine.amount,
        overtime: otLine.amount,
        serviceCharge: serviceLine.amount,
        allowances: Object.fromEntries(rules.allowances.map((allowance) => [allowance.id,
          staffLines.find((line) => line.id === `allowance:${staff.id}:${allowance.id}`)?.amount ?? 0])),
      },
      incentives: incentiveLines.map((line) => ({
        amount: line.amount, taxable: Boolean(line.taxable), socialSecurity: Boolean(line.socialSecurity), label: line.name,
      })),
      manualEarnings: [],
      salaryReduction: leaveSalaryReduction,
    };
    extras.manualEarnings!.push(...leavePayoutLines.map((line) => ({
      amount: line.amount, taxable: Boolean(line.taxable), socialSecurity: Boolean(line.socialSecurity), label: line.name,
    })));
    extras.manualEarnings!.push(...otBankPayoutLines.map((line) => ({
      amount: line.amount, taxable: Boolean(line.taxable), socialSecurity: Boolean(line.socialSecurity), label: line.name,
    })));

    const deductionLines: RunLedgerLine[] = [];
    const manualDeductionLines: Array<{ line: RunLedgerLine; source: RunManualLine["source"] }> = [];
    let salaryManualEarnings = 0;
    let serviceManualEarnings = 0;
    const staffManualIds = new Set<string>();
    for (const manual of (normalizedDraft.manualLines ?? []).filter((item) => item.staffId === staff.id)) {
      if (!manual.id || !manual.name || !manual.reason.trim()) throw new Error("Manual payroll lines require an id, name, and reason.");
      if (staffManualIds.has(manual.id)) throw new Error(`Duplicate manual payroll line id ${manual.id} for ${staff.name}.`);
      staffManualIds.add(manual.id);
      const amount = nonNegative(manual.amount, `Manual line ${manual.name}`);
      const manualLine = add({
        id: `manual:${manual.id}`, staffId: staff.id, staffName: staff.name,
        kind: manual.kind === "earning" ? "manual-earning" : "manual-deduction",
        name: manual.name, source: "manual", budgetSource: manual.source, amount, calculatedAmount: amount,
        currency: preview.currency, eligible: true, rejected: false,
        formula: `${manual.kind === "earning" ? "Manual earning" : "Manual deduction"} (${manual.source} source): ${manual.reason}`,
        workings: [`${manual.amount.toFixed(2)}; ${manual.reason}`],
        taxable: manual.kind === "earning" ? manual.taxable ?? false : undefined,
        socialSecurity: manual.kind === "earning" ? manual.socialSecurity ?? false : undefined,
      });
      if (manual.kind === "earning") {
        extras.manualEarnings!.push({
          amount: manualLine.amount,
          taxable: manual.taxable ?? false,
          socialSecurity: manual.socialSecurity ?? false,
          label: manual.name,
        });
        if (manual.source === "service-charge") serviceManualEarnings += manualLine.amount;
        else salaryManualEarnings += manualLine.amount;
      } else {
        manualDeductionLines.push({ line: manualLine, source: manual.source });
      }
    }

    let serviceRemaining = roundMoney(serviceLine.amount + serviceManualEarnings);
    let salaryRemaining = roundMoney(regularLine.amount + casualLine.amount + salaryManualEarnings - leaveSalaryReduction);
    for (const rule of branch.deductionRules) {
      const available = rule.source === "service-charge" ? serviceRemaining : salaryRemaining;
      // Pass the post-override source budget explicitly. The Phase 2 calculator
      // still uses its source basis for percentage formulas, while this budget
      // caps the result against the effective payout (including manual earnings).
      // The prototype let each call rebuild the whole branch preview (deductions.ts:201): the same pure
      // function of the same unchanged `runData`, once per person per rule. It is built once per
      // calculation and passed in — identical result, linear instead of quadratic (the parity check
      // holds every line to the prototype's).
      deductionPreview ??= calculatePayrollPreview(runData, branchId, month);
      const deduction = calculateDeductionForStaff(runData, branchId, month, staff.id, rule, available, deductionPreview);
      const line = add({
        id: `deduction:${staff.id}:${rule.id}`, staffId: staff.id, staffName: staff.name,
        kind: "deduction", name: rule.name, source: "deduction", sourceRuleId: rule.id,
        budgetSource: rule.source,
        amount: deduction.total, calculatedAmount: deduction.total, currency: preview.currency,
        eligible: rule.enabled && isDeductionAssigned(rule, staff),
        rejected: false, formula: deduction.steps.join(" "),
        workings: deduction.steps, occurrenceDetails: deduction.occurrences,
      });
      const remaining = rule.source === "service-charge" ? serviceRemaining : salaryRemaining;
      if (line.amount > remaining + 0.001) {
        throw new Error(`Deduction ${rule.name} for ${staff.name} exceeds the post-override ${rule.source} payout budget (${remaining.toFixed(2)} available, ${line.amount.toFixed(2)} requested).`);
      }
      if (rule.source === "service-charge") serviceRemaining = roundMoney(serviceRemaining - line.amount);
      else salaryRemaining = roundMoney(salaryRemaining - line.amount);
      deductionLines.push(line);
    }
    let manualDeductionTotal = 0;
    for (const { line, source } of manualDeductionLines) {
      manualDeductionTotal += line.amount;
      const budget = source === "service-charge" ? serviceRemaining : salaryRemaining;
      if (line.amount > budget + 0.001) {
        throw new Error(`Manual deduction ${line.name} for ${staff.name} exceeds the post-override ${source} payout budget (${budget.toFixed(2)} available, ${line.amount.toFixed(2)} requested).`);
      }
      if (source === "service-charge") serviceRemaining = roundMoney(serviceRemaining - line.amount);
      else salaryRemaining = roundMoney(salaryRemaining - line.amount);
    }
    for (const deduction of deductionLines) {
      const rule = branch.deductionRules.find((item) => item.id === deduction.sourceRuleId)!;
      if (rule.source === "service-charge") extras.serviceChargeDeduction = (extras.serviceChargeDeduction ?? 0) + deduction.amount;
      else extras.salaryDeduction = (extras.salaryDeduction ?? 0) + deduction.amount;
    }
    extras.manualDeductions = manualDeductionTotal;
    const effective = calculateStaffWithExtras(
      runData, branchId, month, staff.id, serviceLine.amount, extras,
      { priorYearToDate: normalizedDraft.priorYearToDate },
    );
    const holidayPayForEwf = Math.min(Math.max(0, otLine.amount),
      holidayPremiumByDate.reduce((sum, item) => sum + item.amount, 0));
    const holidayPayScale = holidayPremium > 0 ? holidayPayForEwf / holidayPremium : 0;
    const datedHolidayPay = holidayPremiumByDate.map((item) => ({
      date: item.date, amount: roundMoney(item.amount * holidayPayScale),
    }));
    const holidayPayDelta = roundMoney(holidayPayForEwf - datedHolidayPay.reduce((sum, item) => sum + item.amount, 0));
    if (datedHolidayPay.length && holidayPayDelta) {
      datedHolidayPay[datedHolidayPay.length - 1].amount =
        roundMoney(datedHolidayPay[datedHolidayPay.length - 1].amount + holidayPayDelta);
    }
    const ewfResult = details.country === "TH" && details.currency === "THB"
      ? computeEwf(runData, branchId, month, staff.id, ewfComponentsForStaff(
        branch, staff, rules, staffLines, leaveSalaryReduction, leaveInputs.unpaid, datedHolidayPay, leaveInputs.payouts,
        runData.attendance, month, preview.currency, branchId,
      ))
      : null;
    if (ewfResult) {
      ewfResult.componentManifest = ewfResult.componentManifest.map((component) => ({
        ...component,
        reason: component.countsAsWage && !component.included
          ? `${component.reason} Not contributed this month because EWF status is ${ewfResult.status}.`
          : component.reason,
      }));
      ewfStaffResults.push({ staffId: staff.id, result: ewfResult });
      effective.statutoryBreakdown.employee.ewf = ewfResult.employeeAmount;
      effective.statutoryBreakdown.employer.ewf = ewfResult.employerAmount;
      effective.employeeStatutory = roundMoney(effective.employeeStatutory + ewfResult.employeeAmount);
      effective.employerStatutory = roundMoney(effective.employerStatutory + ewfResult.employerAmount);
      effective.netPay = roundMoney(effective.netPay - ewfResult.employeeAmount);
      const formula = `THB ${ewfResult.wageBase.toFixed(2)} × ${(ewfResult.employeeRate * 100).toFixed(2)}% = THB ${ewfResult.employeeAmount.toFixed(2)}`;
      const componentNotes = ewfResult.componentManifest.map((component) =>
        `${component.included ? "Included" : "Excluded"} · ${component.name} · gross THB ${component.amount.toFixed(2)} · EWF-eligible THB ${component.eligibleAmount.toFixed(2)} · PF-member-exempt THB ${component.membershipExemptAmount.toFixed(2)}${component.prorationNote ? ` · ${component.prorationNote}` : ""} · ${component.reason}`);
      if (month >= "2026-10") {
        const statusNote = `EWF status ${ewfResult.status}; legal entity ${ewfResult.entityId}; headcount ${ewfResult.headcount}; wage base THB ${ewfResult.wageBase.toFixed(2)}; employee ${(ewfResult.employeeRate * 100).toFixed(2)}%; employer ${(ewfResult.employerRate * 100).toFixed(2)}%. ${ewfResult.membershipProrationMethod}`;
        staffLines.push(
          {
            id: `ewf-employee:${staff.id}`, staffId: staff.id, staffName: staff.name, kind: "ewf-employee",
            name: "กองทุนสงเคราะห์ลูกจ้าง / Employee Welfare Fund", source: "payroll",
            amount: ewfResult.employeeAmount, calculatedAmount: ewfResult.employeeAmount, currency: "THB",
            eligible: ewfResult.employeeAmount > 0, rejected: false, formula,
            workings: [statusNote, ...componentNotes],
          },
          {
            id: `ewf-employer:${staff.id}`, staffId: staff.id, staffName: staff.name, kind: "ewf-employer",
            name: "กองทุนสงเคราะห์ลูกจ้าง / Employee Welfare Fund (employer)", source: "payroll",
            amount: ewfResult.employerAmount, calculatedAmount: ewfResult.employerAmount, currency: "THB",
            eligible: ewfResult.employerAmount > 0, rejected: false,
            formula: `THB ${ewfResult.wageBase.toFixed(2)} × ${(ewfResult.employerRate * 100).toFixed(2)}% = THB ${ewfResult.employerAmount.toFixed(2)}`,
            workings: [statusNote, ...componentNotes],
          },
        );
      }
      effective.calculationSteps.push(
        `EWF: status ${ewfResult.status}; entity headcount ${ewfResult.headcount}; eligible wage base THB ${ewfResult.wageBase.toFixed(2)}; employee ${(ewfResult.employeeRate * 100).toFixed(2)}% = THB ${ewfResult.employeeAmount.toFixed(2)}; employer ${(ewfResult.employerRate * 100).toFixed(2)}% = THB ${ewfResult.employerAmount.toFixed(2)}. ${ewfResult.membershipProrationMethod}`,
        ...componentNotes,
      );
    }
    const totalDeductions = roundMoney(deductionLines.reduce((sum, line) => sum + line.amount, 0) + manualDeductionTotal);
    const totalGross = roundMoney(effective.grossPay);
    const totalNet = roundMoney(effective.netPay);
    const overview: RunStaffOverview = {
      staffId: staff.id,
      name: staff.name,
      role: staff.role,
      currency: preview.currency,
      grossPay: totalGross,
      employeeStatutory: effective.employeeStatutory,
      incomeTaxWithholding: effective.incomeTaxWithholding,
      deductions: totalDeductions,
      netPay: totalNet,
      employerStatutory: effective.employerStatutory,
      employerCost: roundMoney(totalGross + effective.employerStatutory),
      socialSecurityWages: effective.socialSecurityWages,
      taxableWages: effective.taxableWages,
      statutoryBreakdown: effective.statutoryBreakdown,
      ewf: ewfResult,
      annualProjectedTax: effective.annualProjectedTax,
      lines: staffLines,
      steps: effective.calculationSteps,
    };
    rows.push(overview);
    ledger.push(...staffLines);
  }
  assertLineOverridePresence(ledger, lineOverrides);
  const aggregate = (key: keyof MonthEndCalculation["totals"]) => roundMoney(rows.reduce((sum, row) => sum + row[key], 0));
  const totals = {
    grossPay: aggregate("grossPay"),
    employeeStatutory: aggregate("employeeStatutory"),
    incomeTaxWithholding: aggregate("incomeTaxWithholding"),
    deductions: aggregate("deductions"),
    netPay: aggregate("netPay"),
    employerStatutory: aggregate("employerStatutory"),
    employerCost: aggregate("employerCost"),
  };
  const streamTotal = sums(runData, branchId, month, rules.serviceCharge.revenueStreams);
  const steps = [
    `Month-end payroll for ${details.name}, ${month}; effective rules dated ${rules.effectiveFrom}.`,
    `Service charge earned in ${preview.serviceEarningMonth}; source ${preview.serviceRevenueAvailable ? "available" : "unavailable"}; pool ${preview.currency} ${preview.servicePool.toFixed(2)} after ${rules.serviceCharge.payoutLagMonths} month(s).`,
    streamTotal === null ? "Branch revenue is not available for the payroll month; incentive revenue conditions requiring POS data are unavailable." : `Current month configured service/revenue stream sum: ${streamTotal.toFixed(2)}.`,
    "Manual earnings default to non-taxable and non-social-security unless each policy flag is explicitly enabled.",
  ];
  return {
    branchId,
    branchName: preview.branchName,
    month,
    currency: preview.currency,
    serviceEarningMonth: preview.serviceEarningMonth,
    servicePool: preview.servicePool,
    serviceRevenueAvailable: preview.serviceRevenueAvailable,
    rows,
    ledger,
    leavePayrollInputs: leaveInputsByStaff,
    sourceManifest: { leavePolicyVersion, leave: leaveManifest },
    ewf: ewfStaffResults.length ? {
      entityId: ewfStaffResults[0].result.entityId,
      headcount: ewfStaffResults[0].result.headcount,
      staff: ewfStaffResults,
    } : null,
    warnings,
    totals,
    companyTotals: { [preview.currency]: totals },
    steps,
  };
}