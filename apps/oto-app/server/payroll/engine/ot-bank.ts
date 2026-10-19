import type {
  BranchId,
  OtBankBalance,
  OtBankBooking,
  OtBankLedgerEntry,
  OvertimePolicy,
  PayrollWorld,
  RunSnapshot,
  StaffRole,
} from "./model";
import { clockDate, systemClock, type PayrollClock } from "./clock";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const roundHours = (value: number) => Math.round((value + Number.EPSILON) * 10000) / 10000;
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function createDefaultOvertimePolicy(): OvertimePolicy {
  return {
    handlingMode: "pay-only",
    requirePreapprovalOrSchedule: true,
    minimumBlockMinutes: 30,
    roundingMinutes: 15,
    bankConversionRate: 1,
    bankMaximumHours: 40,
    bankExpiryMonths: 3,
    bankExpiryAction: "payout",
    bankUseUnit: "hours",
    monthlyCapHours: 36,
    positionOverrides: {},
  };
}

export function validateOvertimePolicy(policy: OvertimePolicy): void {
  if (!policy || !["pay-only", "time-off-only", "employee-chooses", "manager-decides"].includes(policy.handlingMode)) {
    throw new Error("Overtime handling mode is invalid.");
  }
  if (typeof policy.requirePreapprovalOrSchedule !== "boolean") throw new Error("Overtime preapproval requirement must be a boolean.");
  const positiveOrZero: Array<[number, string]> = [
    [policy.minimumBlockMinutes, "Minimum overtime block"],
    [policy.bankMaximumHours, "OT bank maximum"],
    [policy.monthlyCapHours, "Monthly overtime cap"],
  ];
  for (const [value, label] of positiveOrZero) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative.`);
  }
  if (!Number.isInteger(policy.minimumBlockMinutes) || policy.minimumBlockMinutes > 1440) {
    throw new Error("Minimum overtime block must be a whole number of minutes no greater than 1440.");
  }
  if (!Number.isInteger(policy.roundingMinutes) || policy.roundingMinutes < 1 || policy.roundingMinutes > 240) {
    throw new Error("Overtime rounding must be a whole number of minutes between 1 and 240.");
  }
  if (!Number.isFinite(policy.bankConversionRate) || policy.bankConversionRate <= 0 || policy.bankConversionRate > 10) {
    throw new Error("OT bank conversion rate must be greater than zero and no greater than 10.");
  }
  if (!Number.isInteger(policy.bankExpiryMonths) || policy.bankExpiryMonths < 1 || policy.bankExpiryMonths > 60) {
    throw new Error("OT bank expiry must be a whole number of months between 1 and 60.");
  }
  if (!["payout", "forfeit"].includes(policy.bankExpiryAction)) throw new Error("OT bank expiry action is invalid.");
  if (!["hours", "half-days"].includes(policy.bankUseUnit)) throw new Error("OT bank time-off unit is invalid.");
  for (const [role, override] of Object.entries(policy.positionOverrides ?? {})) {
    if (!override || typeof override !== "object") throw new Error(`Overtime policy override for ${role} is invalid.`);
    validateOvertimePolicy({ ...policy, ...override, positionOverrides: {} } as OvertimePolicy);
  }
}

export function overtimePolicyForRole(policy: OvertimePolicy | undefined, role: StaffRole): OvertimePolicy {
  const base = policy ?? createDefaultOvertimePolicy();
  return { ...base, ...(base.positionOverrides?.[role] ?? {}), positionOverrides: {} };
}

export function roundedOvertimeHours(rawHours: number, policy: OvertimePolicy): number {
  if (!Number.isFinite(rawHours) || rawHours <= 0) return 0;
  const minutes = rawHours * 60;
  if (minutes + 1e-8 < policy.minimumBlockMinutes) return 0;
  return roundHours(Math.round(minutes / policy.roundingMinutes) * policy.roundingMinutes / 60);
}

function shiftMonth(month: string, amount: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + amount;
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
}

function expiryDate(date: string, months: number): string {
  const month = shiftMonth(date.slice(0, 7), months);
  const day = Math.min(Number(date.slice(8, 10)),
    new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate());
  return `${month}-${String(day).padStart(2, "0")}`;
}

function latestSnapshots(data: PayrollWorld, branchId: BranchId): RunSnapshot[] {
  const latest = new Map<string, RunSnapshot>();
  for (const snapshot of data.runSnapshots ?? []) {
    if (snapshot.branchId !== branchId || snapshot.approval !== "locked") continue;
    const current = latest.get(snapshot.month);
    if (!current || snapshot.version > current.version) latest.set(snapshot.month, snapshot);
  }
  return Array.from(latest.values()).sort((a, b) => a.month.localeCompare(b.month));
}

export interface OtBankContribution {
  id: string;
  branchId: BranchId;
  staffId: string;
  date: string;
  hours: number;
  expiresOn: string;
  expiryAction: "payout" | "forfeit";
  rate: number;
}

type OtLot = OtBankContribution;

export function otBankContributionsEqual(
  before: OtBankContribution | undefined,
  after: OtBankContribution | undefined,
): boolean {
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
}

export interface OtBankProjectedAward {
  id: string;
  date: string;
  hours: number;
  expiryMonths: number;
  expiryAction: "payout" | "forfeit";
  rate?: number;
}

export function overtimeBankLotId(
  branchId: BranchId,
  month: string,
  attendanceId: string,
  exceptionIndex: number,
): string {
  return `earned:${branchId}:${month}:${attendanceId}:${exceptionIndex}`;
}

function lotFromProjectedAward(
  award: OtBankProjectedAward,
  branchId: BranchId,
  staffId: string,
): OtLot {
  if (!award.id || !DATE.test(award.date) || !Number.isFinite(award.hours) || award.hours <= 0 ||
    !Number.isInteger(award.expiryMonths) || award.expiryMonths < 1 || award.expiryMonths > 60 ||
    !["payout", "forfeit"].includes(award.expiryAction) ||
    (award.rate !== undefined && (!Number.isFinite(award.rate) || award.rate < 0))) {
    throw new Error(`Invalid projected OT bank award ${award.id || "(missing id)"}.`);
  }
  return {
    id: award.id, branchId, staffId, date: award.date, hours: award.hours,
    expiresOn: expiryDate(award.date, award.expiryMonths),
    expiryAction: award.expiryAction, rate: award.rate ?? 0,
  };
}

function getEarnedLots(data: PayrollWorld, branchId: BranchId, staffId: string): OtLot[] {
  const lots: OtLot[] = [];
  for (const snapshot of latestSnapshots(data, branchId)) {
    const draft = snapshot.inputs.draft;
    const decisions = draft.overtimeDecisions ?? [];
    const byOccurrence = new Map(decisions.map((decision) => [
      `${decision.attendanceId}:${decision.exceptionIndex}`, decision,
    ]));
    const staff = snapshot.staff.find((person) => person.id === staffId);
    if (!staff || !staff.otEligible || !snapshot.rules.overtimeEligibilityByRole[staff.role]) continue;
    const policy = overtimePolicyForRole(snapshot.rules.overtimePolicy, staff.role);
    const baseRate = staff.monthlySalary !== null
      ? staff.monthlySalary / snapshot.rules.hourlyBase.monthlySalaryDays / snapshot.rules.hourlyBase.monthlyHoursPerDay
      : (staff.dayRate ?? 0) / snapshot.rules.hourlyBase.casualDayHours;
    for (const day of snapshot.inputs.attendance) {
      if (day.staffId !== staffId || day.date.slice(0, 7) !== snapshot.month || day.overtimeHours <= 0) continue;
      const actualExceptionIndex = day.exceptions.findIndex((exception) => exception.kind === "overtime");
      const occurrenceIndex = actualExceptionIndex >= 0 ? actualExceptionIndex : -1;
      const decision = byOccurrence.get(`${day.id}:${occurrenceIndex}`);
      if (decision?.outcome !== "Bank") continue;
      const hours = roundedOvertimeHours(day.overtimeHours, policy) * policy.bankConversionRate;
      if (hours <= 0) continue;
      const multiplier = day.holiday ? snapshot.rules.overtimeMultipliers.publicHoliday
        : day.dayOff ? snapshot.rules.overtimeMultipliers.restDay : snapshot.rules.overtimeMultipliers.regular;
      lots.push({
        id: overtimeBankLotId(snapshot.branchId, snapshot.month, day.id, occurrenceIndex),
        branchId, staffId, date: day.date, hours, expiresOn: expiryDate(day.date, policy.bankExpiryMonths),
        expiryAction: policy.bankExpiryAction,
        rate: roundMoney(baseRate * multiplier / policy.bankConversionRate),
      });
    }
  }
  return lots.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function snapshotOtBankContribution(
  snapshot: RunSnapshot,
  attendanceId: string,
  exceptionIndex: number,
): OtBankContribution | undefined {
  const day = snapshot.inputs.attendance.find((entry) => entry.id === attendanceId);
  if (!day) return undefined;
  const data = { runSnapshots: [snapshot] } as unknown as PayrollWorld;
  return getEarnedLots(data, snapshot.branchId, day.staffId).find((lot) =>
    lot.id === overtimeBankLotId(snapshot.branchId, snapshot.month, attendanceId, exceptionIndex));
}

function calculateLedger(
  data: PayrollWorld,
  branchId: BranchId,
  staffId: string,
  asOf: string,
  projectedAwards: OtBankProjectedAward[] = [],
): OtBankLedgerEntry[] {
  if (!DATE.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) throw new Error("OT bank as-of date must use YYYY-MM-DD format.");
  const lotById = new Map(getEarnedLots(data, branchId, staffId).map((lot) => [lot.id, lot]));
  for (const award of projectedAwards) {
    const projected = lotFromProjectedAward(award, branchId, staffId);
    lotById.set(projected.id, projected);
  }
  const lots = Array.from(lotById.values()).filter((lot) => lot.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const balance = new Map(lots.map((lot) => [lot.id, lot.hours]));
  const entries: OtBankLedgerEntry[] = lots.map((lot) => ({
    id: lot.id, branchId, staffId, date: lot.date, hours: lot.hours, kind: "Earned",
    reason: "Locked payroll snapshot · banked overtime", sourceKey: lot.id, expiresOn: lot.expiresOn, rate: lot.rate,
  }));

  const bookings: OtBankBooking[] = (data.otBankBookings ?? [])
    .filter((booking) => booking.branchId === branchId && booking.staffId === staffId && booking.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const expiries = lots.filter((lot) => lot.expiresOn <= asOf).map((lot) => ({
    date: lot.expiresOn, type: "expiry" as const, id: `expiry:${lot.id}`, lotId: lot.id,
  }));
  const events = [
    ...bookings.map((booking) => ({ date: booking.date, type: "booking" as const, booking })),
    ...expiries,
    ...(data.leaveOffboarding ?? [])
      .filter((record) => record.branchId === branchId && record.staffId === staffId && record.lastWorkingDate <= asOf)
      .map((record) => ({ date: record.lastWorkingDate, type: "resignation" as const, id: `resignation:${branchId}:${staffId}:${record.lastWorkingDate}` })),
  ].sort((a, b) => a.date.localeCompare(b.date) ||
    (a.type === "booking" ? -1 : b.type === "booking" ? 1 : a.type.localeCompare(b.type)));

  const consume = (
    hours: number, date: string, kind: "Used" | "Expired" | "Paid out", reason: string,
    sourceKey: string, payout = false, onlyLotId?: string,
  ) => {
    let remaining = hours;
    for (const lot of lots) {
      if (remaining <= 1e-8) break;
      if (onlyLotId && lot.id !== onlyLotId) continue;
      const available = balance.get(lot.id) ?? 0;
      if (available <= 1e-8 || lot.date > date) continue;
      const consumed = Math.min(available, remaining);
      balance.set(lot.id, roundHours(available - consumed));
      remaining = roundHours(remaining - consumed);
      entries.push({
        id: `${sourceKey}:${lot.id}`, branchId, staffId, date, hours: consumed, kind, reason,
        sourceKey, rate: lot.rate, ...(payout ? { amount: roundMoney(consumed * lot.rate) } : {}),
      });
    }
    if (remaining > 0.0001) throw new Error(`OT bank event ${sourceKey} exceeds available hours by ${remaining.toFixed(4)}h.`);
  };
  const appliedResignation = new Set<string>();
  for (const event of events) {
    if (event.type === "booking") {
      if (!Number.isFinite(event.booking.hours) || event.booking.hours <= 0) throw new Error(`Invalid OT bank booking ${event.booking.id}.`);
      consume(event.booking.hours, event.date, "Used", event.booking.reason, `booking:${event.booking.id}`);
    } else if (event.type === "expiry") {
      const lot = lots.find((item) => item.id === event.lotId)!;
      const amount = balance.get(lot.id) ?? 0;
      if (amount <= 0) continue;
      if (lot.expiryAction === "payout") {
        consume(amount, event.date, "Paid out", "Expired OT bank hours · paid out", event.id, true, lot.id);
      } else {
        consume(amount, event.date, "Expired", "Expired OT bank hours · forfeited per captured policy", event.id, false, lot.id);
      }
    } else {
      if (appliedResignation.has(event.id)) continue;
      appliedResignation.add(event.id);
      const outstanding = roundHours(Array.from(balance.values()).reduce((sum, hours) => sum + hours, 0));
      if (outstanding > 0) consume(outstanding, event.date, "Paid out", "OT bank balance paid out on recorded offboarding", event.id, true);
    }
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function calculateOtBankBalance(
  data: PayrollWorld,
  branchId: BranchId,
  staffId: string,
  asOf: string,
): OtBankBalance {
  return summarizeOtBankEntries(calculateLedger(data, branchId, staffId, asOf));
}

export function calculateOtBankBalanceWithProposedAwards(
  data: PayrollWorld,
  branchId: BranchId,
  staffId: string,
  asOf: string,
  proposedAwards: OtBankProjectedAward[],
): OtBankBalance {
  return summarizeOtBankEntries(calculateLedger(data, branchId, staffId, asOf, proposedAwards));
}

function summarizeOtBankEntries(entries: OtBankLedgerEntry[]): OtBankBalance {
  const sum = (kind: OtBankLedgerEntry["kind"]) => roundHours(entries
    .filter((entry) => entry.kind === kind)
    .reduce((total, entry) => total + entry.hours, 0));
  const earnedHours = sum("Earned");
  const usedHours = sum("Used");
  const expiredHours = sum("Expired");
  const payoutHours = sum("Paid out");
  return {
    availableHours: roundHours(Math.max(0, earnedHours - usedHours - expiredHours - payoutHours)),
    earnedHours, usedHours, expiredHours, payoutHours, entries,
  };
}

export function assertOtBankAwardsWithinMaximum(
  data: PayrollWorld,
  branchId: BranchId,
  staffId: string,
  maximumHours: number,
  proposedAwards: OtBankProjectedAward[],
): void {
  if (!Number.isFinite(maximumHours) || maximumHours < 0) throw new Error("OT bank maximum must be finite and non-negative.");
  const sorted = [...proposedAwards].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const dates = Array.from(new Set(sorted.map((award) => award.date)));
  for (const date of dates) {
    const throughDateAwards = sorted.filter((award) => award.date <= date);
    const balance = calculateOtBankBalanceWithProposedAwards(data, branchId, staffId, date, throughDateAwards);
    if (balance.availableHours > maximumHours + 0.0001) {
      throw new Error(`Banking overtime on ${date} would exceed the ${maximumHours}h OT bank maximum.`);
    }
  }
}

export function assertOtBankDecisionChangeAllowed(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  staffId: string,
  occurredOn: string,
  sourceLotId?: string,
  asOfDate?: string,
  clock: PayrollClock = systemClock,
): void {
  // Injected clock: the prototype defaulted to the wall clock here (:342).
  asOfDate ??= clockDate(clock);
  const laterBooking = (data.otBankBookings ?? []).find((booking) =>
    booking.branchId === branchId && booking.staffId === staffId && booking.date >= occurredOn);
  if (laterBooking) {
    throw new Error(`OT bank booking ${laterBooking.id} on ${laterBooking.date} depends on this historical contribution.`);
  }
  const downstreamSnapshot = (data.runSnapshots ?? []).find((snapshot) =>
    snapshot.branchId === branchId && snapshot.month > month && snapshot.approval === "locked" &&
    snapshot.staff.some((staff) => staff.id === staffId));
  if (downstreamSnapshot) {
    throw new Error(`Locked payroll ${downstreamSnapshot.month} v${downstreamSnapshot.version} depends on this employee's historical bank balance.`);
  }
  if (sourceLotId) {
    const balance = calculateOtBankBalance(data, branchId, staffId, asOfDate);
    const settledPayout = balance.entries.find((entry) =>
      entry.kind === "Paid out" && entry.id.endsWith(`:${sourceLotId}`));
    if (settledPayout) {
      throw new Error("Expiry or offboarding payout was already generated from this contribution.");
    }
  }
}

export function overtimePayoutsForMonth(
  data: PayrollWorld,
  branchId: BranchId,
  staffId: string,
  month: string,
): OtBankLedgerEntry[] {
  if (!MONTH.test(month)) throw new Error("OT bank payout month must use YYYY-MM format.");
  const through = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  return calculateLedger(data, branchId, staffId, through).filter((entry) =>
    entry.kind === "Paid out" && entry.date.slice(0, 7) === month);
}