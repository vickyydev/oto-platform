import type {
  BoothVoucher,
  BranchId,
  EmployeeIncentivePlan,
  PayrollWorld,
  StreamKey,
} from "./model";
import { branchBusinessPeriodAt, eligibleBoothStaffAtIssue, isStrictIsoInstant } from "./voucher-eligibility";

export interface EmployeeRevenueResult {
  kind: "employee-plan";
  branchId: BranchId;
  month: string;
  staffId: string;
  planId: string;
  planName: string;
  amount: number;
  eligible: boolean;
  basis: "branch" | "gross-profit";
  scope: "stream" | "overall";
  streams: StreamKey[];
  rate: number;
  sourceFigure: number | null;
  gate: { status: "not-configured" | "unlocked" | "locked" | "unavailable"; streams: StreamKey[]; value: number | null; threshold: number | null };
  cap: number | null;
  prorationFactor: number;
  taxable: boolean;
  socialSecurity: boolean;
  steps: string[];
}

export interface VoucherCommissionResult {
  kind: "voucher";
  branchId: BranchId;
  month: string;
  staffId: string;
  voucherCode: string;
  amount: number;
  eligible: boolean;
  issuedAt: string;
  redeemedAt: string | null;
  expiresAt: string;
  redeemedSpend: number | null;
  totalCommission: number;
  splitPercent: number;
  prizeType: string;
  taxable: boolean;
  socialSecurity: boolean;
  steps: string[];
}

export type Phase3bIncentiveResult = EmployeeRevenueResult | VoucherCommissionResult;
export type Phase3bIncentiveRow = {
  staffId: string;
  staffName: string;
  ruleId: string;
  ruleName: string;
  amount: number;
  eligible: boolean;
  result: Phase3bIncentiveResult;
};

const STREAMS: StreamKey[] = ["tickets", "eventsParties", "cafeFnb", "retail", "memberships"];
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const dayCount = (start: string, end: string) =>
  Math.max(0, Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1);
const daysInMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const monthStart = (month: string) => `${month}-01`;
const monthEnd = (month: string) => `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
const sum = (values: Record<StreamKey, number>, streams: StreamKey[]) =>
  streams.reduce((total, stream) => total + values[stream], 0);
const STREAM_LABELS: Record<StreamKey, string> = {
  tickets: "Tickets",
  eventsParties: "Events & Parties",
  cafeFnb: "Cafe & F&B",
  retail: "Retail",
  memberships: "Memberships",
};

function branchCurrency(data: PayrollWorld, branchId: BranchId, month: string) {
  const versions = data.branches[branchId].detailsHistory
    .filter((item) => item.effectiveFrom <= month)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (!versions.length) throw new Error(`No branch currency is effective for ${branchId} in ${month}.`);
  return versions[versions.length - 1].details.currency;
}

function formatMoney(value: number, currency: "THB" | "MYR") {
  const formatted = new Intl.NumberFormat("en", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${currency === "THB" ? "฿" : "RM"}${formatted}`;
}

function formatRate(rate: number) {
  return `${(rate * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

function ensureMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid incentive month: ${month}. Expected YYYY-MM.`);
}

function validatePlan(plan: EmployeeIncentivePlan) {
  if (!plan.id || !plan.staffId || !plan.name) throw new Error("Employee incentive plan requires an id, staff member, and name.");
  const scope = (plan as EmployeeIncentivePlan & { scope?: "stream" | "overall" }).scope ?? "stream";
  if (!["stream", "overall"].includes(scope)) throw new Error(`Plan ${plan.id} has an invalid revenue scope.`);
  if ((scope === "stream" && !plan.streams.length) || plan.streams.some((stream) => !STREAMS.includes(stream))) {
    throw new Error(`Plan ${plan.id} requires supported revenue streams.`);
  }
  const basis = String(plan.basis);
  if (basis !== "branch" && basis !== "gross-profit") {
    throw new Error(`Plan ${plan.id} uses a retired incentive basis; migrate it to a branch revenue basis before calculation.`);
  }
  if (!Number.isFinite(plan.rate) || plan.rate < 0 || plan.rate > 1) throw new Error(`Plan ${plan.id} rate must be a decimal between 0 and 1.`);
  if (plan.monthlyCap !== null && (!Number.isFinite(plan.monthlyCap) || plan.monthlyCap < 0)) throw new Error(`Plan ${plan.id} monthly cap must be non-negative.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.effectiveFrom) || (plan.effectiveTo !== null && !/^\d{4}-\d{2}-\d{2}$/.test(plan.effectiveTo))) {
    throw new Error(`Plan ${plan.id} must use YYYY-MM-DD effective dates.`);
  }
  if (plan.effectiveTo && plan.effectiveTo < plan.effectiveFrom) throw new Error(`Plan ${plan.id} ends before it becomes effective.`);
  if (plan.targetGate && (!plan.targetGate.streams.length || plan.targetGate.streams.some((stream) => !STREAMS.includes(stream)) ||
      !Number.isFinite(plan.targetGate.threshold) || plan.targetGate.threshold < 0)) {
    throw new Error(`Plan ${plan.id} has an invalid target gate.`);
  }
}

function planActiveForMonth(
  plan: EmployeeIncentivePlan,
  branch: PayrollWorld["branches"][BranchId],
  month: string,
): boolean {
  return planWindowForMonth(plan, branch, month) !== null;
}

function planDateWindowForMonth(
  plan: EmployeeIncentivePlan,
  month: string,
): { start: string; end: string } | null {
  const start = plan.effectiveFrom > monthStart(month) ? plan.effectiveFrom : monthStart(month);
  const effectiveEnd = plan.effectiveTo ?? monthEnd(month);
  const end = effectiveEnd < monthEnd(month) ? effectiveEnd : monthEnd(month);
  return start <= end ? { start, end } : null;
}

function planWindowForMonth(
  plan: EmployeeIncentivePlan,
  branch: PayrollWorld["branches"][BranchId],
  month: string,
): { start: string; end: string } | null {
  const staff = branch.staff.find((person) => person.id === plan.staffId);
  if (!staff) return null;
  const planWindow = planDateWindowForMonth(plan, month);
  if (!planWindow) return null;
  const startDates = [planWindow.start, staff.joinedOn, monthStart(month)];
  const endDates = [planWindow.end, staff.leftOn ?? monthEnd(month), monthEnd(month)];
  if (startDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date)) ||
      endDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) return null;
  const start = startDates.sort().at(-1)!;
  const end = endDates.sort()[0];
  return start <= end ? { start, end } : null;
}

function nextDate(date: string, offsetDays: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + offsetDays * 86400000).toISOString().slice(0, 10);
}

function overlappingDays(
  window: { start: string; end: string } | null,
  other: { start: string; end: string } | null,
): number {
  if (!window || !other) return 0;
  const start = window.start > other.start ? window.start : other.start;
  const end = window.end < other.end ? window.end : other.end;
  return end < start ? 0 : dayCount(start, end);
}

function uncoveredDays(
  window: { start: string; end: string },
  masks: { start: string; end: string }[],
): number {
  const ordered = masks
    .map((mask) => ({
      start: mask.start > window.start ? mask.start : window.start,
      end: mask.end < window.end ? mask.end : window.end,
    }))
    .filter((mask) => mask.end >= mask.start)
    .sort((a, b) => a.start.localeCompare(b.start));
  let cursor = window.start;
  let days = 0;
  for (const mask of ordered) {
    if (mask.end < cursor) continue;
    if (mask.start > cursor) days += dayCount(cursor, nextDate(mask.start, -1));
    if (mask.end >= cursor) cursor = nextDate(mask.end, 1);
    if (cursor > window.end) return days;
  }
  if (cursor <= window.end) days += dayCount(cursor, window.end);
  return days;
}

function planScope(plan: EmployeeIncentivePlan): "stream" | "overall" {
  return (plan as EmployeeIncentivePlan & { scope?: "stream" | "overall" }).scope ?? "stream";
}

function overrideMatchesDefault(
  override: EmployeeIncentivePlan,
  roleDefault: EmployeeIncentivePlan,
): boolean {
  if (override.isOverride !== true ||
      override.staffId !== roleDefault.staffId ||
      override.basis !== roleDefault.basis ||
      planScope(override) !== planScope(roleDefault)) return false;
  if (override.sourceRoleDefaultId) {
    return override.sourceRoleDefaultId === roleDefault.sourceRoleDefaultId;
  }
  return planScope(roleDefault) === "overall" ||
    override.streams.some((stream) => roleDefault.streams.includes(stream));
}

function assertNonOverlappingRoleOverrides(
  plans: EmployeeIncentivePlan[],
  overrides: EmployeeIncentivePlan[],
  month: string,
): void {
  for (const roleDefault of plans.filter((plan) => plan.isOverride !== true && plan.sourceRoleDefaultId)) {
    const defaultStreams = planScope(roleDefault) === "overall" ? STREAMS : roleDefault.streams;
    for (const stream of defaultStreams) {
      const streamOverrides = overrides.filter((override) =>
        overrideMatchesDefault(override, roleDefault) &&
        (planScope(override) === "overall" || override.streams.includes(stream)));
      const windows = streamOverrides.map((override) => ({
        plan: override,
        window: planDateWindowForMonth(override, month),
      })).filter((item): item is { plan: EmployeeIncentivePlan; window: { start: string; end: string } } =>
        item.window !== null);
      for (let first = 0; first < windows.length; first += 1) {
        for (let second = first + 1; second < windows.length; second += 1) {
          if (overlappingDays(windows[first].window, windows[second].window) > 0) {
            throw new Error(
              `Employee incentive overrides ${windows[first].plan.id} and ${windows[second].plan.id} overlap for ${stream} in ${month}.`,
            );
          }
        }
      }
    }
  }
}

export function calculateEmployeeRevenueIncentives(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
): Phase3bIncentiveRow[] {
  ensureMonth(month);
  const branch = data.branches[branchId];
  if (!branch) throw new Error(`Unknown incentive branch: ${branchId}.`);
  const plans = branch.employeeIncentivePlans;
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length) {
    throw new Error(`Employee incentive plan IDs must be unique in ${branchId}.`);
  }
  const overrides = plans.filter((plan) =>
    plan.isOverride === true && planActiveForMonth(plan, branch, month));
  assertNonOverlappingRoleOverrides(plans, overrides, month);
  const selectedPlans = plans.map((plan) => {
    const scope = planScope(plan);
    const planWindow = planWindowForMonth(plan, branch, month);
    const effectiveWindow = planDateWindowForMonth(plan, month);
    const planDays = effectiveWindow ? dayCount(effectiveWindow.start, effectiveWindow.end) : 0;
    const activeDays = planWindow ? dayCount(planWindow.start, planWindow.end) : 0;
    const baseFactor = plan.proratePartMonth && planWindow
      ? Math.min(1, activeDays / daysInMonth(month))
      : 1;
    if (plan.isOverride === true || !plan.sourceRoleDefaultId) {
      const replacesRoleDefault = plan.isOverride === true && plans.some((candidate) =>
        candidate.isOverride !== true &&
        Boolean(candidate.sourceRoleDefaultId) &&
        planDateWindowForMonth(candidate, month) !== null &&
        overrideMatchesDefault(plan, candidate));
      const allocationDays = replacesRoleDefault && effectiveWindow
        ? plan.proratePartMonth && planWindow
          ? overlappingDays(planWindow, effectiveWindow)
          : planDays
        : plan.proratePartMonth && planWindow ? activeDays : daysInMonth(month);
      const factor = replacesRoleDefault && effectiveWindow
        ? Math.min(1, allocationDays / daysInMonth(month))
        : baseFactor;
      const streams = scope === "overall" ? STREAMS : plan.streams;
      return {
        plan,
        streams,
        factors: Object.fromEntries(streams.map((stream) => [stream, factor])) as Record<StreamKey, number>,
        periodPartitioned: replacesRoleDefault && planWindow !== null,
        allocationDays: Object.fromEntries(streams.map((stream) => [
          stream,
          replacesRoleDefault && effectiveWindow || plan.proratePartMonth && planWindow
            ? `${allocationDays}/${daysInMonth(month)} days`
            : "full month",
        ])) as Record<StreamKey, string>,
      };
    }
    const relevantOverrides = overrides.filter((override) => overrideMatchesDefault(override, plan));
    const defaultStreams = scope === "overall" ? STREAMS : plan.streams;
    const factors: Partial<Record<StreamKey, number>> = {};
    const allocationDays: Partial<Record<StreamKey, string>> = {};
    const streams = defaultStreams.filter((stream) => {
      const masks = relevantOverrides
        .filter((override) => planScope(override) === "overall" || override.streams.includes(stream))
        .map((override) => planDateWindowForMonth(override, month))
        .filter((window): window is { start: string; end: string } => window !== null);
      const uncoveredPlanDays = effectiveWindow ? uncoveredDays(effectiveWindow, masks) : 0;
      const uncoveredActiveDays = planWindow ? uncoveredDays(planWindow, masks) : 0;
      const partitioned = masks.length > 0 && effectiveWindow !== null;
      const remainingDays = plan.proratePartMonth ? uncoveredActiveDays : uncoveredPlanDays;
      const factor = partitioned && effectiveWindow
        ? remainingDays / daysInMonth(month)
        : baseFactor;
      factors[stream] = factor;
      allocationDays[stream] = partitioned
        ? `${remainingDays}/${daysInMonth(month)} days`
        : plan.proratePartMonth && planWindow
          ? `${activeDays}/${daysInMonth(month)} days`
          : "full month";
      return !partitioned || remainingDays > 0;
    });
    return {
      plan,
      streams,
      factors,
      allocationDays,
      periodPartitioned: defaultStreams.some((stream) =>
        relevantOverrides.some((override) =>
          (planScope(override) === "overall" || override.streams.includes(stream)) &&
          planDateWindowForMonth(override, month) !== null)),
    };
  }).filter((selection) => selection.streams.length > 0);
  const revenue = data.revenue.find((row) => row.branchId === branchId && row.month === month);
  const costOfSales = revenue && (revenue as typeof revenue & {
    costOfSales?: Partial<Record<StreamKey, number>>;
  }).costOfSales;
  const currency = branchCurrency(data, branchId, month);
  return selectedPlans.flatMap(({ plan, streams, factors, allocationDays, periodPartitioned }) => {
    validatePlan(plan);
    const staff = branch.staff.find((person) => person.id === plan.staffId);
    if (!staff) throw new Error(`Plan ${plan.id} references unknown staff ${plan.staffId}.`);
    const start = [plan.effectiveFrom, monthStart(month), staff.joinedOn].sort().at(-1)!;
    const end = [plan.effectiveTo ?? monthEnd(month), monthEnd(month), staff.leftOn ?? monthEnd(month)].sort()[0];
    const effectiveDays = end < start ? 0 : dayCount(start, end);
    const isEffective = effectiveDays > 0;
    const selectedScope = planScope(plan);
    const basis = String(plan.basis) as "branch" | "gross-profit";
    const effectiveStreams = selectedScope === "overall" ? STREAMS : streams;
    const rawProrate = plan.proratePartMonth && isEffective
      ? Math.min(1, effectiveDays / daysInMonth(month))
      : 1;
    const factorsForStreams = effectiveStreams.map((stream) => factors[stream] ?? rawProrate);
    const uniformFactors = factorsForStreams.every((factor) => Math.abs(factor - factorsForStreams[0]) < 1e-10);
    const prorate = uniformFactors
      ? factorsForStreams[0] ?? rawProrate
      : factorsForStreams.reduce((total, factor) => total + factor, 0) / factorsForStreams.length;
    const revenueAmounts = revenue?.streams;
    const grossProfitAmounts = costOfSales && revenueAmounts
      ? Object.fromEntries(STREAMS.flatMap((stream) => {
        const cost = costOfSales[stream];
        const amount = revenueAmounts[stream];
        return typeof cost === "number" && Number.isFinite(cost) &&
          typeof amount === "number" && Number.isFinite(amount)
          ? [[stream, amount - cost]]
          : [];
      })) as Partial<Record<StreamKey, number>>
      : undefined;
    const selectedAmounts = basis === "gross-profit" ? grossProfitAmounts : revenueAmounts;
    const selectedValues = selectedAmounts
      ? effectiveStreams.map((stream) => selectedAmounts[stream])
      : [];
    const weightedSourceFigure = selectedAmounts && selectedValues.every((value) => typeof value === "number" && Number.isFinite(value))
      ? effectiveStreams.reduce<number>((total, stream, index) =>
        total + (typeof selectedValues[index] === "number" ? selectedValues[index] * (factors[stream] ?? rawProrate) : 0), 0)
      : null;
    const sourceFigure = selectedAmounts && selectedValues.every((value) => typeof value === "number" && Number.isFinite(value))
      ? selectedValues.reduce<number>((total, value) => total + (typeof value === "number" ? value : 0), 0)
      : null;
    const basisLabel = basis === "gross-profit" ? "gross profit" : "revenue";
    const selectedRevenue = revenueAmounts
      ? effectiveStreams.map((stream) => revenueAmounts[stream] ?? 0).reduce((total, value) => total + value, 0)
      : null;
    const selectedCost = costOfSales && effectiveStreams.every((stream) =>
      typeof costOfSales[stream] === "number" && Number.isFinite(costOfSales[stream]))
      ? effectiveStreams.reduce<number>((total, stream) => total + (costOfSales[stream] as number), 0)
      : null;
    const grossProfitExplanation = basis === "gross-profit" && selectedRevenue !== null && selectedCost !== null
      ? `Gross profit = revenue ${formatMoney(selectedRevenue, currency)} − cost of sales ${formatMoney(selectedCost, currency)}`
      : null;
    const basisSubject = selectedScope === "overall"
      ? `overall branch ${basisLabel}`
      : `${effectiveStreams.map((stream) => STREAM_LABELS[stream]).join(" + ")} ${basisLabel}`;
    const sourceAmountDescription = sourceFigure === null
      ? `${basisSubject} unavailable`
      : `${basisSubject} = ${formatMoney(sourceFigure, currency)}`;
    const gateValue = plan.targetGate && revenue ? sum(revenue.streams, plan.targetGate.streams) : null;
    const gateStatus = !plan.targetGate ? "not-configured"
      : gateValue === null ? "unavailable"
        : gateValue >= plan.targetGate.threshold ? "unlocked" : "locked";
    const eligible = isEffective && sourceFigure !== null && gateStatus !== "locked" && gateStatus !== "unavailable";
    const calculationBase = uniformFactors ? sourceFigure : weightedSourceFigure;
    const payableBase = basis === "gross-profit" ? Math.max(0, calculationBase ?? 0) : calculationBase ?? 0;
    const commissionBeforeProration = eligible ? payableBase * plan.rate : 0;
    const proratedCommission = money(commissionBeforeProration * (uniformFactors ? prorate : 1));
    const amount = money(plan.monthlyCap === null ? proratedCommission : Math.min(proratedCommission, plan.monthlyCap));
    const steps = [
      `${staff.name} — ${plan.name}: ${eligible ? "eligible" : "not eligible"}.`,
      `Basis ${basisSubject}; ${sourceAmountDescription}${grossProfitExplanation ? ` (${grossProfitExplanation})` : ""}.`,
      plan.targetGate
        ? gateValue === null
          ? `Gate unavailable: ${plan.targetGate.streams.map((stream) => STREAM_LABELS[stream]).join(", ")} revenue input is missing.`
          : `Gate ${gateStatus}: ${plan.targetGate.streams.map((stream) => STREAM_LABELS[stream]).join(", ")} revenue ${formatMoney(gateValue, currency)} ${gateStatus === "unlocked" ? "≥" : "<"} threshold ${formatMoney(plan.targetGate.threshold, currency)}.`
        : "No target gate configured.",
      sourceFigure === null
        ? `${formatRate(plan.rate)} × ${sourceAmountDescription}; payout ${formatMoney(0, currency)}.`
        : `${formatRate(plan.rate)} × ${uniformFactors ? basisSubject : `period-weighted ${basisSubject}`} ${formatMoney(payableBase, currency)} = ${formatMoney(commissionBeforeProration, currency)}${basis === "gross-profit" && (calculationBase ?? 0) < 0 ? " (gross profit below zero; payout floor is zero)" : eligible ? "" : " (payout blocked by eligibility/gate)"}.`,
      !uniformFactors || periodPartitioned
        ? `Subperiod allocation: ${effectiveStreams.map((stream) =>
          `${STREAM_LABELS[stream]} ${allocationDays[stream] ?? "full month"} (factor ${(factors[stream] ?? rawProrate).toFixed(4)})`).join("; ")}; resulting payout ${formatMoney(proratedCommission, currency)} before cap.`
        : plan.proratePartMonth
        ? `Part-month proration: ${effectiveDays}/${daysInMonth(month)} qualifying active/effective days = ${prorate.toFixed(4)}; ${formatMoney(commissionBeforeProration, currency)} × ${prorate.toFixed(4)} = ${formatMoney(proratedCommission, currency)}.`
        : `Part-month proration disabled; amount ${formatMoney(proratedCommission, currency)}.`,
      plan.monthlyCap === null
        ? `No monthly cap; payout ${formatMoney(amount, currency)}.`
        : `Monthly cap ${formatMoney(plan.monthlyCap, currency)}; payout ${formatMoney(amount, currency)}.`,
    ];
    if (!isEffective) steps.push(`Plan not active for the employee during ${month}.`);
    return [{
      staffId: staff.id,
      staffName: staff.name,
      ruleId: `employee-plan:${plan.id}`,
      ruleName: plan.name,
      amount,
      eligible,
      result: {
        kind: "employee-plan" as const,
        branchId, month, staffId: staff.id, planId: plan.id, planName: plan.name, amount, eligible,
         basis, scope: selectedScope, streams: [...effectiveStreams], rate: plan.rate, sourceFigure,
        gate: { status: gateStatus, streams: plan.targetGate?.streams ?? [], value: gateValue, threshold: plan.targetGate?.threshold ?? null },
        cap: plan.monthlyCap, prorationFactor: prorate, taxable: plan.taxable, socialSecurity: plan.socialSecurity, steps,
      },
    }];
  });
}

export function calculateVoucherCommissions(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
): Phase3bIncentiveRow[] {
  ensureMonth(month);
  const branch = data.branches[branchId];
  if (!branch) throw new Error(`Unknown incentive branch: ${branchId}.`);
  const settings = branch.voucherSettings;
  const currency = branchCurrency(data, branchId, month);
  if (!Number.isFinite(settings.value) || settings.value < 0 || (settings.method === "percent" && settings.value > 1)) {
    throw new Error(`Invalid booth voucher setting for ${branchId}.`);
  }
  return data.boothVouchers.filter((voucher) => voucher.branchId === branchId).flatMap((voucher) => {
    if (!voucher.redeemedAt) return [];
    const redemptionPeriod = branchBusinessPeriodAt(data, branchId, voucher.redeemedAt);
    const malformedCurrentRedemption = !redemptionPeriod && voucher.redeemedAt.slice(0, 7) === month;
    if (!malformedCurrentRedemption && redemptionPeriod?.month !== month) return [];

    const issuePeriod = branchBusinessPeriodAt(data, branchId, voucher.issuedAt);
    const issuedAtMillis = isStrictIsoInstant(voucher.issuedAt) ? Date.parse(voucher.issuedAt) : Number.NaN;
    const expiresAtMillis = isStrictIsoInstant(voucher.expiresAt) ? Date.parse(voucher.expiresAt) : Number.NaN;
    const redeemedAtMillis = isStrictIsoInstant(voucher.redeemedAt) ? Date.parse(voucher.redeemedAt) : Number.NaN;
    const staffById = new Map(branch.staff.map((person) => [person.id, person]));
    const verifiedIssueStaff = (voucher as BoothVoucher & { verifiedStaffIdsAtIssue?: unknown }).verifiedStaffIdsAtIssue;
    const hasVerifiedIssueEvidence = verifiedIssueStaff !== undefined;
    const verifiedIssueEvidenceValid = !hasVerifiedIssueEvidence ||
      (Array.isArray(verifiedIssueStaff) &&
        verifiedIssueStaff.every((staffId) => typeof staffId === "string" && staffById.has(staffId)) &&
        new Set(verifiedIssueStaff).size === verifiedIssueStaff.length);
    const issueEligibleStaff = new Set<string>(hasVerifiedIssueEvidence
      ? verifiedIssueEvidenceValid ? verifiedIssueStaff as string[] : []
      : eligibleBoothStaffAtIssue(data, branchId, voucher.issuedAt));
    const staffIdsValid = voucher.staffIds.length >= 1 && voucher.staffIds.length <= 2 &&
      new Set(voucher.staffIds).size === voucher.staffIds.length &&
      voucher.staffIds.every((staffId) => staffById.has(staffId));
    const allAssignedStaffEligible = staffIdsValid && voucher.staffIds.every((staffId) => issueEligibleStaff.has(staffId));
    const issueEligibleNames = Array.from(issueEligibleStaff)
      .map((id) => staffById.get(id)?.name ?? id);
    const splitValues = voucher.staffIds.map((staffId) => voucher.splitPercentByStaffId?.[staffId] ??
      (voucher.staffIds.length > 0 ? 100 / voucher.staffIds.length : 0));
    const splitValid = !voucher.splitPercentByStaffId
      ? staffIdsValid
      : staffIdsValid &&
        Object.keys(voucher.splitPercentByStaffId).every((staffId) => voucher.staffIds.includes(staffId)) &&
        splitValues.every((value) => Number.isFinite(value) && value >= 0 && value <= 100) &&
        Math.abs(splitValues.reduce((total, value) => total + value, 0) - 100) <= 0.0001;
    const issueAndExpiryValid = Number.isFinite(issuedAtMillis) && Number.isFinite(expiresAtMillis) &&
      expiresAtMillis > issuedAtMillis;
    const redemptionTimeValid = Number.isFinite(redeemedAtMillis) &&
      redemptionPeriod !== null &&
      issuedAtMillis <= redeemedAtMillis &&
      redeemedAtMillis <= expiresAtMillis;
    const spendValid = Number.isFinite(voucher.redeemedSpend) && (voucher.redeemedSpend ?? -1) >= 0;
    const invalidReasons = [
      !issueAndExpiryValid ? "Voucher issue or expiry timestamp is invalid." : "",
      !issuePeriod ? "Branch-local voucher issue date cannot be verified." : "",
      !verifiedIssueEvidenceValid ? "Verified voucher issue-eligibility evidence is invalid." : "",
      malformedCurrentRedemption || !redemptionTimeValid ? "Redemption must be after issue and on or before expiry." : "",
      !staffIdsValid ? "Voucher must be assigned to one or two distinct employees in this branch." : "",
      !allAssignedStaffEligible ? "Every assigned employee must have been rostered and clocked in when the voucher was issued." : "",
      !splitValid ? "Staff splits must be non-negative percentages totaling 100%." : "",
      !spendValid ? "Redeemed voucher has no valid non-negative spend amount." : "",
    ].filter(Boolean);
    const validRedemption = invalidReasons.length === 0;
    const totalCommission = validRedemption
      ? money(settings.method === "fixed" ? settings.value : (voucher.redeemedSpend ?? 0) * settings.value)
      : 0;
    let distributedCents = 0;
    return voucher.staffIds.flatMap((staffId, index) => {
      const staff = staffById.get(staffId);
      if (!staff) return [];
      const splitPercent = splitValues[index] ?? 0;
      const totalCents = Math.round(totalCommission * 100);
      const calculatedShareCents = Math.round(totalCents * splitPercent / 100);
      const shareCents = index === voucher.staffIds.length - 1
        ? totalCents - distributedCents
        : calculatedShareCents;
      const amount = money(shareCents / 100);
      distributedCents += shareCents;
      const rawShare = money(totalCommission * splitPercent / 100);
      const roundingDelta = money(amount - rawShare);
      const methodText = settings.method === "fixed"
        ? `fixed ${formatMoney(settings.value, currency)} per redeemed voucher`
        : `${formatRate(settings.value)} × redeemed spend ${formatMoney(voucher.redeemedSpend ?? 0, currency)}`;
      const steps = [
        `Voucher ${voucher.code}; issued ${voucher.issuedAt}; expires ${voucher.expiresAt}; redeemed ${voucher.redeemedAt}.`,
        `Commission ${methodText} = ${formatMoney(totalCommission, currency)} for this voucher, earned in redemption month ${redemptionPeriod?.month ?? month}.`,
        `Issue eligibility: ${issueEligibleNames.length ? issueEligibleNames.join(", ") : "no rostered and clocked-in employee verified"} were rostered and clocked in at issue.`,
        `${staff.name} receives ${splitPercent.toFixed(2)}% × ${formatMoney(totalCommission, currency)} = ${formatMoney(rawShare, currency)}${roundingDelta ? `; balanced rounding adjustment ${roundingDelta > 0 ? "+" : ""}${formatMoney(roundingDelta, currency)}` : ""}; paid share ${formatMoney(amount, currency)}.`,
        ...invalidReasons.map((reason) => `Not payable: ${reason}`),
      ];
      return [{
        staffId,
        staffName: staff.name,
        ruleId: `voucher:${voucher.code}:${staffId}`,
        ruleName: `Voucher ${voucher.code}`,
        amount,
        eligible: validRedemption,
        result: {
          kind: "voucher" as const,
          branchId,
          month,
          staffId,
          voucherCode: voucher.code,
          amount,
          eligible: validRedemption,
          issuedAt: voucher.issuedAt,
          redeemedAt: voucher.redeemedAt,
          expiresAt: voucher.expiresAt,
          redeemedSpend: voucher.redeemedSpend,
          totalCommission,
          splitPercent,
          prizeType: voucher.prizeType,
          taxable: true,
          socialSecurity: true,
          steps,
        },
      }];
    });
  });
}