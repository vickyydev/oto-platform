import type {
  AttendanceDay,
  BranchId,
  IncentiveRule,
  PayrollWorld,
  RevenueMonth,
  StaffMember,
  StreamKey,
} from "./model";
import {
  calculateEmployeeRevenueIncentives,
  calculateVoucherCommissions,
  type Phase3bIncentiveResult,
} from "./employee-incentives";

export type IncentiveGateStatus = "not-configured" | "unlocked" | "locked" | "unavailable";
export type IncentiveSourceAvailability = "available" | "unavailable";

export interface IncentiveShare {
  staffId: string;
  staffName: string;
  amount: number;
  weight: number;
  prorationFactor: number;
}

export interface IncentiveStaffResult {
  branchId: BranchId;
  month: string;
  staffId: string;
  ruleId: string;
  amount: number;
  eligible: boolean;
  ineligibleReason: string | null;
  gate: {
    status: IncentiveGateStatus;
    value: number | null;
    threshold: number | null;
    streams: StreamKey[];
  };
  metric: IncentiveRule["metric"];
  metricValue: number | null;
  source: IncentiveRule["source"];
  sourceAvailability: IncentiveSourceAvailability;
  sourceFigure: number | null;
  sourceDescription: string;
  calculationAmount: number | null;
  poolAmount: number | null;
  proration: {
    applied: boolean;
    activeDays: number;
    monthDays: number;
    factor: number;
    amountBefore: number;
    amountAfter: number;
  };
  shares: IncentiveShare[];
  steps: string[];
}

export interface IncentiveMonthEntry {
  staffId: string;
  staffName: string;
  ruleId: string;
  ruleName: string;
  amount: number;
  eligible: boolean;
  result: IncentiveStaffResult | Phase3bIncentiveResult;
}

export interface IncentiveMonthResult {
  branchId: BranchId;
  month: string;
  rows: IncentiveMonthEntry[];
  byStaff: Array<{
    staffId: string;
    staffName: string;
    ruleAmounts: Record<string, number>;
    total: number;
  }>;
  byRule: Array<{
    ruleId: string;
    ruleName: string;
    total: number;
  }>;
  total: number;
  warnings?: string[];
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const STREAM_KEYS: StreamKey[] = ["tickets", "eventsParties", "cafeFnb", "retail", "memberships"];

function assertMonth(month: string) {
  if (!MONTH_PATTERN.test(month)) throw new Error(`Invalid incentive month: ${month}. Expected YYYY-MM.`);
}

function assertInputs(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  rule: IncentiveRule,
) {
  assertMonth(month);
  const branch = data.branches[branchId];
  if (!branch) throw new Error(`Unknown incentive branch: ${branchId}.`);
  if (!rule || typeof rule !== "object" || !rule.id || !rule.name) {
    throw new Error("Invalid incentive rule: id and name are required.");
  }
  if (!["revenue", "attendance-percent", "days-worked", "manual"].includes(rule.metric)) {
    throw new Error(`Invalid incentive rule ${rule.id}: unsupported metric.`);
  }
  if (!["POS", "manual"].includes(rule.source) ||
      !["individual", "role", "branch"].includes(rule.scope)) {
    throw new Error(`Invalid incentive rule ${rule.id}: unsupported source or scope.`);
  }
  if (!["fixed", "percent", "tiered-percent", "per-unit"].includes(rule.reward.type) ||
      !["each", "equal", "days"].includes(rule.poolDistribution)) {
    throw new Error(`Invalid incentive rule ${rule.id}: unsupported reward or pool distribution.`);
  }
  if (!Array.isArray(rule.roles) || !Array.isArray(rule.revenueStreams) ||
      !Array.isArray(rule.includeStaffIds) || !Array.isArray(rule.excludeStaffIds)) {
    throw new Error(`Invalid incentive rule ${rule.id}: assignments and stream selections must be arrays.`);
  }
  if (!Number.isFinite(rule.reward.amount) || rule.reward.amount < 0) {
    throw new Error(`Invalid incentive rule ${rule.id}: reward amount must be a non-negative number.`);
  }
  if (rule.metric === "manual" && rule.source !== "manual") {
    throw new Error(`Invalid incentive rule ${rule.id}: manual metric requires manual source.`);
  }
  if (rule.reward.type === "per-unit" && (rule.metric !== "revenue" || rule.source !== "POS")) {
    throw new Error(`Invalid incentive rule ${rule.id}: per-unit rewards require POS revenue data.`);
  }
  if (rule.metric === "revenue" && rule.source === "POS" && rule.revenueStreams.length === 0) {
    throw new Error(`Invalid incentive rule ${rule.id}: POS revenue requires at least one selected stream.`);
  }
  if (rule.targetGate && (!Array.isArray(rule.targetGate.streams) || rule.targetGate.streams.length === 0)) {
    throw new Error(`Invalid incentive rule ${rule.id}: target gate requires at least one revenue stream.`);
  }
  if (rule.reward.type === "tiered-percent" &&
      (!rule.reward.tiers.length || rule.reward.tiers.some((tier) =>
        !Number.isFinite(tier.rate) || tier.rate < 0 ||
        (tier.upTo !== null && (!Number.isFinite(tier.upTo) || tier.upTo < 0))))) {
    throw new Error(`Invalid incentive rule ${rule.id}: tiered percentage requires valid tiers.`);
  }
  if (rule.reward.type === "tiered-percent" &&
      rule.reward.tiers.filter((tier) => tier.upTo === null).length !== 1) {
    throw new Error(`Invalid incentive rule ${rule.id}: tiered percentage must include exactly one unbounded final tier.`);
  }
  const streams = [...rule.revenueStreams, ...(rule.targetGate?.streams ?? [])];
  if (streams.some((stream) => !STREAM_KEYS.includes(stream))) {
    throw new Error(`Invalid incentive rule ${rule.id}: unsupported revenue stream.`);
  }
  if (rule.targetGate && (!Number.isFinite(rule.targetGate.threshold) || rule.targetGate.threshold < 0)) {
    throw new Error(`Invalid incentive rule ${rule.id}: target threshold must be non-negative.`);
  }
  return branch;
}

function daysInMonth(month: string) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

function activeDays(staff: StaffMember, month: string) {
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const start = staff.joinedOn > first ? staff.joinedOn : first;
  const end = staff.leftOn && staff.leftOn < last ? staff.leftOn : last;
  if (end < start) return 0;
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

function attended(day: PayrollWorld["attendance"][number]) {
  return Boolean(day.effectiveClockIn || day.actualClockIn) &&
    Boolean(day.effectiveClockOut || day.actualClockOut);
}

function attendanceMetrics(data: PayrollWorld, branchId: BranchId, month: string, staffId: string) {
  const rows = data.attendance.filter((day) =>
    day.branchId === branchId && day.staffId === staffId && day.date.slice(0, 7) === month,
  );
  const byDate = new Map<string, AttendanceDay[]>();
  rows.forEach((day) => byDate.set(day.date, [...(byDate.get(day.date) ?? []), day]));
  const scheduledDates = Array.from(byDate.entries()).filter(
    (entry: [string, AttendanceDay[]]) =>
      entry[1].some((day: AttendanceDay) => day.scheduled && !day.dayOff),
  );
  const disqualifyingException = (day: typeof rows[number]) =>
    day.exceptions.some((exception) =>
      exception.resolution === "Approved" &&
      (exception.kind === "late" || exception.kind === "early-departure" || exception.kind === "no-show"),
    );
  const attendedScheduled = scheduledDates.filter(
    (entry: [string, AttendanceDay[]]) =>
      entry[1].some(attended) && !entry[1].some(disqualifyingException),
  ).length;
  // Day-off rows with actual/effective clock times represent worked rest-day shifts.
  // Count unique dates so duplicate attendance rows never inflate the day total.
  const worked = Array.from(byDate.values()).filter(
    (days: AttendanceDay[]) => days.some(attended),
  ).length;
  const hasDisqualifyingException = scheduledDates.some(
    (entry: [string, AttendanceDay[]]) => entry[1].some(disqualifyingException),
  );
  const percent = scheduledDates.length ? attendedScheduled / scheduledDates.length * 100 : 0;
  return { scheduled: scheduledDates.length, attendedScheduled, worked, percent, hasDisqualifyingException };
}

function revenueMonth(data: PayrollWorld, branchId: BranchId, month: string): RevenueMonth | undefined {
  return data.revenue.find((item) => item.branchId === branchId && item.month === month);
}

function sumStreams(streams: Record<StreamKey, number>, selected: StreamKey[]) {
  return selected.reduce((sum, stream) => sum + streams[stream], 0);
}

function manualFigure(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  ruleId: string,
  staffId: string | null,
) {
  return data.manualFigures.find((item) =>
    item.branchId === branchId && item.month === month && item.ruleId === ruleId && item.staffId === staffId,
  );
}

function tieredReward(metricValue: number, rule: IncentiveRule) {
  const metric = Math.max(0, metricValue);
  const tiers = [...rule.reward.tiers].sort((a, b) =>
    (a.upTo ?? Number.POSITIVE_INFINITY) - (b.upTo ?? Number.POSITIVE_INFINITY),
  );
  if (rule.reward.tierMode === "whole") {
    const tier = tiers.find((item) => item.upTo === null || metric <= item.upTo) ?? tiers[tiers.length - 1];
    return metric * tier.rate;
  }
  let lower = 0;
  let total = 0;
  for (const tier of tiers) {
    const upper = tier.upTo ?? Number.POSITIVE_INFINITY;
    const band = Math.max(0, Math.min(metric, upper) - lower);
    total += band * tier.rate;
    lower = upper;
    if (metric <= upper) break;
  }
  return total;
}

function rewardFor(metricValue: number, rule: IncentiveRule, membershipUnits: number) {
  if (rule.reward.type === "fixed") return rule.reward.amount;
  if (rule.reward.type === "percent") return Math.max(0, metricValue) * rule.reward.amount;
  if (rule.reward.type === "tiered-percent") return tieredReward(metricValue, rule);
  return Math.max(0, membershipUnits) * rule.reward.amount;
}

function candidateStaff(branchStaff: StaffMember[], rule: IncentiveRule, month: string) {
  return branchStaff.filter((staff) => {
    const active = activeDays(staff, month) > 0;
    const assigned = rule.roles.includes(staff.role) || rule.includeStaffIds.includes(staff.id);
    return active && assigned && !rule.excludeStaffIds.includes(staff.id);
  });
}

interface MetricFigure {
  value: number | null;
  available: boolean;
  description: string;
  membershipUnits: number;
}

function metricFigure(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  staff: StaffMember,
  recipients: StaffMember[],
  rule: IncentiveRule,
): MetricFigure {
  const manualStaffId = rule.scope === "individual" ? staff.id : null;
  if (rule.metric === "manual" || (rule.source === "manual" && rule.metric === "revenue")) {
    const input = manualFigure(data, branchId, month, rule.id, manualStaffId);
    return {
      value: input?.value ?? null,
      available: input !== undefined,
      description: input
        ? `Manual figure ${input.value} for ${rule.scope === "individual" ? staff.name : "the shared pool"}.`
        : `Manual figure is unavailable for ${rule.scope === "individual" ? staff.name : "the shared pool"}; enter the month-end value.`,
      membershipUnits: 0,
    };
  }
  if (rule.metric === "attendance-percent") {
    if (rule.scope !== "individual" && rule.poolDistribution !== "each") {
      const attendance = recipients.map((person) =>
        attendanceMetrics(data, branchId, month, person.id),
      );
      const scheduled = attendance.reduce((sum, item) => sum + item.scheduled, 0);
      const attended = attendance.reduce((sum, item) => sum + item.attendedScheduled, 0);
      const percent = scheduled ? attended / scheduled * 100 : 0;
      return {
        value: percent,
        available: scheduled > 0,
        description: `Shared-pool attendance: ${attended}/${scheduled} eligible-recipient scheduled shifts attended without Approved late, early-departure, or no-show exceptions = ${percent.toFixed(2)}% (weighted by scheduled shifts).`,
        membershipUnits: 0,
      };
    }
    const attendance = attendanceMetrics(data, branchId, month, staff.id);
    return {
      value: attendance.percent,
      available: attendance.scheduled > 0,
      description: `${attendance.attendedScheduled}/${attendance.scheduled} scheduled shifts attended without Approved late, early-departure, or no-show exceptions (${attendance.percent.toFixed(2)}%).`,
      membershipUnits: 0,
    };
  }
  if (rule.metric === "days-worked") {
    if (rule.scope !== "individual" && rule.poolDistribution !== "each") {
      const attendance = recipients.map((person) =>
        attendanceMetrics(data, branchId, month, person.id),
      );
      const worked = attendance.reduce((sum, item) => sum + item.worked, 0);
      return {
        value: worked,
        available: true,
        description: `Shared-pool days worked: sum of distinct attended dates across ${recipients.length} eligible recipient(s) = ${worked}.`,
        membershipUnits: 0,
      };
    }
    const attendance = attendanceMetrics(data, branchId, month, staff.id);
    return {
      value: attendance.worked,
      available: true,
      description: `${attendance.worked} scheduled shift(s) attended.`,
      membershipUnits: 0,
    };
  }

  if (rule.scope === "branch") {
    const revenue = revenueMonth(data, branchId, month);
    if (!revenue) {
      return { value: null, available: false, description: `POS branch revenue for ${month} is unavailable.`, membershipUnits: 0 };
    }
    const value = sumStreams(revenue.streams, rule.revenueStreams);
    let membershipUnits = 0;
    return {
      value,
      available: true,
      description: `Branch POS revenue: ${rule.revenueStreams.join(", ") || "no streams selected"} = ${value.toFixed(2)}.`,
      membershipUnits,
    };
  }
  return {
    value: null,
    available: false,
    description: "Individual sales attribution has been retired. Use an employee branch revenue-share plan or a redeemed booth voucher.",
    membershipUnits: 0,
  };
}

function targetGate(data: PayrollWorld, branchId: BranchId, month: string, rule: IncentiveRule) {
  if (!rule.targetGate) {
    return { status: "not-configured" as const, value: null, threshold: null, streams: [] as StreamKey[] };
  }
  const revenue = revenueMonth(data, branchId, month);
  if (!revenue) {
    return {
      status: "unavailable" as const,
      value: null,
      threshold: rule.targetGate.threshold,
      streams: [...rule.targetGate.streams],
    };
  }
  const value = sumStreams(revenue.streams, rule.targetGate.streams);
  return {
    status: value >= rule.targetGate.threshold ? "unlocked" as const : "locked" as const,
    value,
    threshold: rule.targetGate.threshold,
    streams: [...rule.targetGate.streams],
  };
}

function resultFor(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  staff: StaffMember,
  rule: IncentiveRule,
  recipients: StaffMember[],
): IncentiveStaffResult {
  const monthDays = daysInMonth(month);
  const active = activeDays(staff, month);
  const prorationFactor = rule.proratePartMonth ? Math.min(1, active / monthDays) : 1;
  const gate = targetGate(data, branchId, month, rule);
  const steps: string[] = [];
  const eligibleAssignment = recipients.some((person) => person.id === staff.id);
  const figure = metricFigure(data, branchId, month, staff, recipients, rule);
  const metricValue = figure.value;
  let eligible = rule.enabled && eligibleAssignment && figure.available;
  let ineligibleReason: string | null = null;
  if (!rule.enabled) ineligibleReason = "Rule is disabled.";
  else if (!eligibleAssignment) ineligibleReason = "Staff member is inactive or not assigned to this rule (or is explicitly excluded).";
  else if (!figure.available) ineligibleReason = figure.description;
  if (eligible && gate.status === "locked") {
    eligible = false;
    ineligibleReason = `Branch target locked: ${gate.value?.toFixed(2)} is below ${gate.threshold?.toFixed(2)}.`;
  } else if (eligible && gate.status === "unavailable") {
    eligible = false;
    ineligibleReason = "Branch target status is unavailable because revenue input is missing.";
  }
  if (eligible && rule.metric === "attendance-percent" &&
      (rule.scope === "individual" || rule.poolDistribution === "each")) {
    const attendance = attendanceMetrics(data, branchId, month, staff.id);
    if (!attendance.scheduled || attendance.percent < 100 || attendance.hasDisqualifyingException) {
      eligible = false;
      ineligibleReason = !attendance.scheduled
        ? "No scheduled shifts are recorded."
        : attendance.hasDisqualifyingException
          ? "An Approved late, early-departure, or no-show exception prevents attendance eligibility."
          : `Attendance was ${attendance.percent.toFixed(2)}%, below the 100% requirement.`;
    }
  }

  const isSharedPool = rule.scope !== "individual" && rule.poolDistribution !== "each";
  let calculationAmount: number | null = null;
  let poolAmount: number | null = null;
  let beforeProration = 0;
  let shares: IncentiveShare[] = [];
  if (eligible && metricValue !== null) {
    calculationAmount = roundMoney(rewardFor(metricValue, rule, figure.membershipUnits));
    if (isSharedPool) {
      poolAmount = roundMoney(calculationAmount);
      const weighted = recipients.map((person) => ({
        person,
        weight: rule.poolDistribution === "equal" ? 1 : attendanceMetrics(data, branchId, month, person.id).worked,
      }));
      const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
      shares = weighted.map(({ person, weight }) => {
        const personFactor = rule.proratePartMonth
          ? Math.min(1, activeDays(person, month) / monthDays)
          : 1;
        const unproratedShare = totalWeight > 0 ? poolAmount! * weight / totalWeight : 0;
        return {
          staffId: person.id,
          staffName: person.name,
          weight,
          prorationFactor: personFactor,
          amount: roundMoney(unproratedShare * personFactor),
        };
      });
      beforeProration = shares.find((share) => share.staffId === staff.id)?.amount ?? 0;
      const rawShare = totalWeight > 0 ? poolAmount * (weighted.find((item) => item.person.id === staff.id)?.weight ?? 0) / totalWeight : 0;
      beforeProration = rawShare;
    } else {
      beforeProration = roundMoney(calculationAmount);
      shares = [{
        staffId: staff.id,
        staffName: staff.name,
        amount: roundMoney(beforeProration * prorationFactor),
        weight: 1,
        prorationFactor,
      }];
    }
  }
  const amountAfter = isSharedPool
    ? shares.find((share) => share.staffId === staff.id)?.amount ?? 0
    : roundMoney(beforeProration * prorationFactor);
  const amount = eligible ? amountAfter : 0;
  steps.push(`${staff.name} — ${rule.name}: ${eligible ? "eligible" : "not eligible"}.`);
  if (gate.status === "not-configured") steps.push("Branch target gate: not configured.");
  else if (gate.status === "unavailable") steps.push(`Branch target gate unavailable: ${gate.streams.join(", ")} revenue input is missing.`);
  else steps.push(`Branch target gate ${gate.status}: ${gate.streams.join(", ")} revenue ${gate.value!.toFixed(2)} ${gate.status === "unlocked" ? "≥" : "<"} threshold ${gate.threshold!.toFixed(2)}.`);
  steps.push(figure.description);
  if (metricValue !== null) steps.push(`Metric value: ${metricValue.toFixed(2)}${rule.metric === "attendance-percent" ? "%" : ""}.`);
  if (calculationAmount !== null) {
    if (rule.reward.type === "fixed") steps.push(`Fixed reward: ${rule.reward.amount.toFixed(2)}.`);
    else if (rule.reward.type === "percent") steps.push(`${metricValue!.toFixed(2)} × ${(rule.reward.amount * 100).toFixed(2)}% = ${calculationAmount.toFixed(2)}.`);
    else if (rule.reward.type === "tiered-percent") steps.push(`Tiered ${rule.reward.tierMode} percentage reward on ${metricValue!.toFixed(2)} = ${calculationAmount.toFixed(2)}.`);
    else steps.push(`${figure.membershipUnits} membership unit(s) × ${rule.reward.amount.toFixed(2)} = ${calculationAmount.toFixed(2)}.`);
  }
  if (isSharedPool && poolAmount !== null) {
    const share = shares.find((item) => item.staffId === staff.id);
    steps.push(`Shared ${rule.poolDistribution} pool ${poolAmount.toFixed(2)}; ${share?.weight ?? 0} weight / ${shares.reduce((sum, item) => sum + item.weight, 0)} total weight; share before proration ${beforeProration.toFixed(2)}.`);
  }
  if (rule.proratePartMonth) {
    steps.push(`Part-month proration: ${active}/${monthDays} active calendar days = ${prorationFactor.toFixed(4)}; ${beforeProration.toFixed(2)} × ${prorationFactor.toFixed(4)} = ${amountAfter.toFixed(2)}.`);
  } else {
    steps.push(`Part-month proration disabled; amount ${amountAfter.toFixed(2)}.`);
  }
  if (ineligibleReason) steps.push(ineligibleReason);
  return {
    branchId,
    month,
    staffId: staff.id,
    ruleId: rule.id,
    amount: roundMoney(amount),
    eligible,
    ineligibleReason,
    gate,
    metric: rule.metric,
    metricValue,
    source: rule.source,
    sourceAvailability: figure.available ? "available" : "unavailable",
    sourceFigure: figure.value,
    sourceDescription: figure.description,
    calculationAmount,
    poolAmount,
    proration: {
      applied: rule.proratePartMonth,
      activeDays: active,
      monthDays,
      factor: prorationFactor,
      amountBefore: roundMoney(beforeProration),
      amountAfter: roundMoney(amountAfter),
    },
    shares,
    steps,
  };
}

/**
 * Calculate one staff member's incentive from the same branch/month pool used by
 * monthly summaries. Shared role/branch pools are calculated once and exposed
 * with every result's complete, deterministic allocation.
 */
export function calculateIncentiveForStaff(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  staffId: string,
  rule: IncentiveRule,
): IncentiveStaffResult {
  const branch = assertInputs(data, branchId, month, rule);
  const staff = branch.staff.find((person) => person.id === staffId);
  if (!staff) throw new Error(`Unknown staff member for incentive calculation: ${staffId}.`);
  const recipients = candidateStaff(branch.staff, rule, month);
  return resultFor(data, branchId, month, staff, rule, recipients);
}

/** Monthly incentive rows and totals, using calculateIncentiveForStaff for each cell. */
export function calculateIncentiveMonth(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
): IncentiveMonthResult {
  assertMonth(month);
  const branch = data.branches[branchId];
  if (!branch) throw new Error(`Unknown incentive branch: ${branchId}.`);
  const rows: IncentiveMonthEntry[] = [
    ...calculateEmployeeRevenueIncentives(data, branchId, month),
    ...calculateVoucherCommissions(data, branchId, month),
  ];
  const byStaff = branch.staff.map((staff) => {
    const cells = rows.filter((row) => row.staffId === staff.id);
    const ruleAmounts = Object.fromEntries(cells.map((row) => [row.ruleId, row.amount]));
    return {
      staffId: staff.id,
      staffName: staff.name,
      ruleAmounts,
      total: roundMoney(cells.reduce((sum, row) => sum + row.amount, 0)),
    };
  });
  const byRule = Array.from(new Map(rows.map((row) => [row.ruleId, row.ruleName])).entries()).map(([ruleId, ruleName]) => ({
    ruleId,
    ruleName,
    total: roundMoney(rows.filter((row) => row.ruleId === ruleId).reduce((sum, row) => sum + row.amount, 0)),
  }));
  return {
    branchId,
    month,
    rows,
    byStaff,
    byRule,
    total: roundMoney(rows.reduce((sum, row) => sum + row.amount, 0)),
    warnings: [],
  };
}