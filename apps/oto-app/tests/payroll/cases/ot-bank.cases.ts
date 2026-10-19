// Ported from the payroll prototype's ot-bank.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import assert from "node:assert/strict";
import { describeSuite, test } from "../harness";
import type { AttendanceDay, PayrollWorld, RunSnapshot, StaffMember } from "../../../server/payroll/engine/model";
import { calculateMonthEnd, thailandWeeklyOvertimeWarnings } from "../../../server/payroll/engine/run-calculations";
import {
  createDefaultOvertimePolicy,
  assertOtBankAwardsWithinMaximum,
  calculateOtBankBalance,
  assertOtBankDecisionChangeAllowed,
  overtimeBankLotId,
  otBankContributionsEqual,
  snapshotOtBankContribution,
  roundedOvertimeHours,
  validateOvertimePolicy,
} from "../../../server/payroll/engine/ot-bank";
import { createSeedData } from "../seed-world";
describeSuite("ot-bank.test.ts");

const staff: StaffMember = {
  id: "ot-staff", employeeNumber: "OT-1", taxId: "DEMO-OT-1", name: "OT Test",
  role: "Floor Attendant", employmentType: "local", nationality: "Thai",
  monthlySalary: 24000, dayRate: null, joinedOn: "2024-01-01", leftOn: null,
  probationEndsOn: "2024-04-01", scheduledDaysPerWeek: 5, otEligible: true,
  serviceChargeEligible: true, serviceRoleWeight: 1,
};

function overtimeDay(date: string, hours: number, id = `test-${date}`): AttendanceDay {
  return {
    id, branchId: "hkt-central", staffId: staff.id, date, scheduled: true, dayOff: false, holiday: false,
    plannedClockIn: "10:00", plannedClockOut: "19:00", actualClockIn: "10:00", actualClockOut: "21:00",
    effectiveClockIn: "10:00", effectiveClockOut: "21:00", overtimeHours: hours,
    exceptions: [{
      kind: "overtime", resolution: "Approved", reason: "Approved OT",
      rawClockIn: "10:00", rawClockOut: "21:00", effectiveClockIn: "10:00", effectiveClockOut: "21:00",
      approvedBy: "Manager",
    }],
  };
}

function bankSnapshot(
  month: string,
  version: number,
  days: AttendanceDay[],
  outcomes: Array<"Bank" | "Pay" | "Reject">,
  overrides: Partial<ReturnType<typeof createDefaultOvertimePolicy>> = {},
): RunSnapshot {
  const policy = { ...createDefaultOvertimePolicy(), ...overrides };
  return {
    branchId: "hkt-central", month, version, lockedAt: `${month}-28T23:00:00.000Z`,
    lockedBy: "Owner", approval: "locked", calculations: {},
    details: {} as RunSnapshot["details"], staff: [staff],
    rules: {
      overtimePolicy: policy,
      overtimeEligibilityByRole: { "Floor Attendant": true },
      overtimeMultipliers: { regular: 1.5, restDay: 2, publicHoliday: 3 },
      hourlyBase: { monthlySalaryDays: 30, monthlyHoursPerDay: 8, casualDayHours: 8 },
    } as unknown as RunSnapshot["rules"], // cast only: a partial rules stub, as in the prototype test
    incentiveRules: [], deductionRules: [],
    inputs: {
      revenue: null, attendance: days, manualFigures: [],
      draft: {
        branchId: "hkt-central", month, version, stage: "approvals", approval: "gm-approved",
        revenueOverrides: {}, costOfSalesOverrides: {}, manualAdjustments: [], lineOverrides: [] as unknown as Record<string, never>, exceptionResolutions: [],
        overtimeDecisions: days.map((day, index) => ({
          attendanceId: day.id, exceptionIndex: 0, outcome: outcomes[index], reason: "Audited decision",
          resolvedBy: "Manager", resolvedAt: `${month}-28T12:00:00.000Z`,
        })),
      },
    },
    audit: [],
  };
}

function bankData(snapshots: RunSnapshot[]): PayrollWorld {
  return {
    runSnapshots: snapshots,
    otBankBookings: [],
    leaveOffboarding: [],
  } as unknown as PayrollWorld;
}

test("overtime policies validate limits and apply minimum-block rounding", () => {
  const policy = createDefaultOvertimePolicy();
  assert.equal(roundedOvertimeHours(0.49, policy), 0);
  assert.equal(roundedOvertimeHours(0.5, policy), 0.5);
  assert.equal(roundedOvertimeHours(0.62, policy), 0.5);
  assert.equal(roundedOvertimeHours(0.63, policy), 0.75);
  assert.throws(() => validateOvertimePolicy({ ...policy, bankExpiryMonths: 0 }), /expiry/);
  assert.throws(() => validateOvertimePolicy({ ...policy, roundingMinutes: 0 }), /rounding/);
});

test("OT bank consumes bookings FIFO and pays only the unexpired remainder at expiry", () => {
  const days = [overtimeDay("2025-01-10", 2), overtimeDay("2025-01-20", 3)];
  const snapshot = bankSnapshot("2025-01", 1, days, ["Bank", "Bank"], {
    bankExpiryMonths: 1, bankExpiryAction: "payout",
  });
  const data = bankData([snapshot]);
  data.otBankBookings!.push({
    id: "booking-1", branchId: "hkt-central", staffId: staff.id, date: "2025-02-05",
    hours: 3, reason: "Booked time off", createdBy: "Manager", createdAt: "2025-01-25T12:00:00.000Z",
  });

  const balance = calculateOtBankBalance(data, "hkt-central", staff.id, "2025-02-21");
  assert.equal(balance.earnedHours, 5);
  assert.equal(balance.usedHours, 3);
  assert.equal(balance.payoutHours, 2);
  assert.equal(balance.availableHours, 0);
  const bookingEntries = balance.entries.filter((entry) => entry.kind === "Used");
  assert.deepEqual(bookingEntries.map((entry) => entry.hours), [2, 1]);
});

test("OT bank expiry can forfeit and resignation pays remaining hours", () => {
  const day = overtimeDay("2025-01-10", 2);
  const forfeited = bankData([bankSnapshot("2025-01", 1, [day], ["Bank"], {
    bankExpiryMonths: 1, bankExpiryAction: "forfeit",
  })]);
  const expired = calculateOtBankBalance(forfeited, "hkt-central", staff.id, "2025-02-11");
  assert.equal(expired.expiredHours, 2);
  assert.equal(expired.availableHours, 0);

  const resignation = bankData([bankSnapshot("2025-01", 1, [day], ["Bank"], { bankExpiryMonths: 6 })]);
  resignation.leaveOffboarding!.push({
    branchId: "hkt-central", staffId: staff.id, resignationDate: "2025-02-01",
    lastWorkingDate: "2025-02-01", reason: "Resigned", recordedBy: "Manager", recordedAt: "2025-01-25T12:00:00.000Z",
  });
  const paid = calculateOtBankBalance(resignation, "hkt-central", staff.id, "2025-02-01");
  assert.equal(paid.payoutHours, 2);
  assert.equal(paid.availableHours, 0);
  assert.ok(paid.entries.some((entry) => entry.kind === "Paid out" && entry.reason.includes("offboarding")));
});

test("bank maximum projection applies same-month expiry and booking events before each award", () => {
  const fullDay = overtimeDay("2025-01-10", 40);
  const base = bankData([bankSnapshot("2025-01", 1, [fullDay], ["Bank"], {
    bankExpiryMonths: 1, bankExpiryAction: "forfeit",
  })]);
  const projected = (date: string, hours: number, id: string) => [{
    id, date, hours, expiryMonths: 3, expiryAction: "forfeit" as const,
  }];

  assert.throws(() => assertOtBankAwardsWithinMaximum(
    base, "hkt-central", staff.id, 40, projected("2025-02-01", 1, "pre-expiry-award"),
  ), /maximum/);
  assert.doesNotThrow(() => assertOtBankAwardsWithinMaximum(
    base, "hkt-central", staff.id, 40, projected("2025-02-11", 5, "post-expiry-award"),
  ), "an award after the existing lot expires should fit the released capacity");

  const booked = bankData([bankSnapshot("2025-01", 1, [fullDay], ["Bank"])]);
  booked.otBankBookings!.push({
    id: "mid-month-booking", branchId: "hkt-central", staffId: staff.id, date: "2025-02-05",
    hours: 10, reason: "Booked time off", createdBy: "Manager", createdAt: "2025-02-01T12:00:00.000Z",
  });
  assert.doesNotThrow(() => assertOtBankAwardsWithinMaximum(
    booked, "hkt-central", staff.id, 40, projected("2025-02-06", 10, "after-booking-award"),
  ), "an award after a same-month booking should use the released bank capacity");
  assert.throws(() => assertOtBankAwardsWithinMaximum(
    booked, "hkt-central", staff.id, 40, projected("2025-02-04", 1, "before-booking-award"),
  ), /maximum/);
  assert.throws(() => assertOtBankAwardsWithinMaximum(
    booked, "hkt-central", staff.id, 40,
    [...projected("2025-02-06", 6, "bulk-award-a"), ...projected("2025-02-06", 5, "bulk-award-b")],
  ), /maximum/, "all proposed bulk awards on the date count toward the cap");
});

test("latest locked run version replaces prior OT bank decisions", () => {
  const day = overtimeDay("2025-01-10", 2);
  const v1 = bankSnapshot("2025-01", 1, [day], ["Bank"]);
  const v2 = bankSnapshot("2025-01", 2, [day], ["Pay"]);
  const balance = calculateOtBankBalance(bankData([v1, v2]), "hkt-central", staff.id, "2025-01-31");
  assert.equal(balance.earnedHours, 0);
  assert.equal(balance.availableHours, 0);
});

test("non-OT re-lock revisions preserve stable source attribution for settled bank lots", () => {
  const day = overtimeDay("2025-01-10", 2);
  const v1 = bankSnapshot("2025-01", 1, [day], ["Bank"]);
  const v1Data = bankData([v1]);
  v1Data.otBankBookings!.push({
    id: "settled-v1-booking", branchId: "hkt-central", staffId: staff.id, date: "2025-01-11",
    hours: 1, reason: "Booked from v1 bank balance", createdBy: "Manager", createdAt: "2025-01-10T12:00:00.000Z",
  });
  const lotId = overtimeBankLotId("hkt-central", "2025-01", day.id, 0);
  const v1Used = calculateOtBankBalance(v1Data, "hkt-central", staff.id, "2025-01-31")
    .entries.find((entry) => entry.kind === "Used")!;
  assert.equal(v1Used.id, `booking:settled-v1-booking:${lotId}`);

  const v2 = bankSnapshot("2025-01", 2, [day], ["Bank"]);
  v2.inputs.draft.revenueOverrides.eventsParties = 25000;
  const v2Data = bankData([v1, v2]);
  v2Data.otBankBookings = structuredClone(v1Data.otBankBookings);
  const v2Used = calculateOtBankBalance(v2Data, "hkt-central", staff.id, "2025-01-31")
    .entries.find((entry) => entry.kind === "Used")!;
  assert.equal(v2Used.id, v1Used.id,
    "a non-OT revision keeps the original booking's source-lot attribution");
  assert.equal(v2Used.sourceKey, v1Used.sourceKey);
});

test("changed award hours or rate retain stable identity but are not treated as equivalent contributions", () => {
  const dayV1 = overtimeDay("2025-01-10", 2);
  const v1 = bankSnapshot("2025-01", 1, [dayV1], ["Bank"]);
  const dayV2 = { ...dayV1, overtimeHours: 3 };
  const v2 = bankSnapshot("2025-01", 2, [dayV2], ["Bank"]);
  v2.staff[0].monthlySalary = 36000;
  const before = snapshotOtBankContribution(v1, dayV1.id, 0);
  const after = snapshotOtBankContribution(v2, dayV2.id, 0);
  assert.ok(before && after);
  assert.equal(before.id, after.id, "revisions retain one stable source-lot identity");
  assert.equal(otBankContributionsEqual(before, after), false,
    "changed hours/rate are a material award change");

  const data = bankData([v1]);
  data.otBankBookings!.push({
    id: "settled-contribution", branchId: "hkt-central", staffId: staff.id, date: "2025-01-11",
    hours: 1, reason: "Booked from earned hours", createdBy: "Manager", createdAt: "2025-01-10T12:00:00.000Z",
  });
  assert.throws(() => assertOtBankDecisionChangeAllowed(
    data, "hkt-central", "2025-01", staff.id, dayV1.date, before.id, "2025-01-31",
  ), /booking.*depends/,
  "the lock guard blocks a changed contribution when its stable lot has settled usage");
});

test("synthetic -1 overtime decisions affect paid calculations and OT-bank earnings without source exceptions", () => {
  const day = overtimeDay("2025-01-10", 2);
  day.exceptions = [];
  const snapshot = bankSnapshot("2025-01", 1, [day], ["Bank"]);
  snapshot.inputs.draft.overtimeDecisions![0].exceptionIndex = -1;
  const balance = calculateOtBankBalance(bankData([snapshot]), "hkt-central", staff.id, "2025-01-31");
  assert.equal(balance.earnedHours, 2);
  assert.ok(balance.entries.some((entry) => entry.id.endsWith(`${day.id}:-1`)));

  const data = createSeedData();
  const branchId = "hkt-central";
  const eligibleStaff = data.branches[branchId].staff.find((person) =>
    person.otEligible && data.branches[branchId].rulesHistory[0].overtimeEligibilityByRole[person.role]);
  assert.ok(eligibleStaff);
  const noExceptionDay = data.attendance.find((entry) =>
    entry.branchId === branchId && entry.staffId === eligibleStaff.id &&
    entry.date.startsWith("2026-10-") && entry.exceptions.length === 0);
  assert.ok(noExceptionDay);
  noExceptionDay.overtimeHours = 2;
  const before = calculateMonthEnd(data, branchId, "2026-10");
  const banked = calculateMonthEnd(data, branchId, "2026-10", {
    overtimeDecisions: [{
      attendanceId: noExceptionDay.id, exceptionIndex: -1, outcome: "Bank", reason: "Banked synthetic occurrence",
      resolvedBy: "Manager", resolvedAt: "2026-10-31T12:00:00.000Z",
    }],
  });
  const beforeAmount = before.ledger.find((line) => line.id === `overtime:${eligibleStaff.id}`)!.amount;
  const bankedAmount = banked.ledger.find((line) => line.id === `overtime:${eligibleStaff.id}`)!.amount;
  assert.ok(bankedAmount < beforeAmount);
});

test("historical Bank edits are blocked after downstream bookings, payouts, or locked payroll", () => {
  const day = overtimeDay("2025-01-10", 2);
  const snapshot = bankSnapshot("2025-01", 1, [day], ["Bank"], {
    bankExpiryMonths: 1, bankExpiryAction: "payout",
  });
  const noDependencies = bankData([snapshot]);
  assert.doesNotThrow(() => assertOtBankDecisionChangeAllowed(
    noDependencies, "hkt-central", "2025-01", staff.id, "2025-01-10", undefined, "2025-01-31",
  ));

  const booked = bankData([snapshot]);
  booked.otBankBookings!.push({
    id: "later-booking", branchId: "hkt-central", staffId: staff.id, date: "2025-01-11",
    hours: 1, reason: "Booked", createdBy: "Manager", createdAt: "2025-01-10T12:00:00.000Z",
  });
  assert.throws(() => assertOtBankDecisionChangeAllowed(
    booked, "hkt-central", "2025-01", staff.id, "2025-01-10", undefined, "2025-01-31",
  ), /booking.*depends/);

  const downstream = bankData([snapshot, bankSnapshot("2025-02", 1, [], [], {})]);
  assert.throws(() => assertOtBankDecisionChangeAllowed(
    downstream, "hkt-central", "2025-01", staff.id, "2025-01-10", undefined, "2025-01-31",
  ), /Locked payroll/);

  const lotId = overtimeBankLotId("hkt-central", "2025-01", day.id, 0);
  assert.throws(() => assertOtBankDecisionChangeAllowed(
    noDependencies, "hkt-central", "2025-01", staff.id, "2025-01-10", lotId, "2025-02-11",
  ), /payout was already generated/);
});

test("Bank and Reject outcomes are excluded from paid overtime calculations", () => {
  const data = createSeedData();
  const occurrence = data.attendance.find((day) => {
    const branch = data.branches[day.branchId];
    const person = branch.staff.find((staff) => staff.id === day.staffId);
    return day.overtimeHours > 0 && person?.otEligible &&
      branch.rulesHistory[0].overtimeEligibilityByRole[person.role];
  });
  assert.ok(occurrence);
  const exceptionIndex = occurrence.exceptions.findIndex((exception) => exception.kind === "overtime");
  assert.ok(exceptionIndex >= 0);
  const before = calculateMonthEnd(data, occurrence.branchId, occurrence.date.slice(0, 7));
  const banked = calculateMonthEnd(data, occurrence.branchId, occurrence.date.slice(0, 7), {
    overtimeDecisions: [{
      attendanceId: occurrence.id, exceptionIndex, outcome: "Bank", reason: "Employee chose time off",
      resolvedBy: "Manager", resolvedAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  const rejected = calculateMonthEnd(data, occurrence.branchId, occurrence.date.slice(0, 7), {
    overtimeDecisions: [{
      attendanceId: occurrence.id, exceptionIndex, outcome: "Reject", reason: "Duplicate entry",
      resolvedBy: "Manager", resolvedAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  const staffId = occurrence.staffId;
  const paidBefore = before.ledger.find((line) => line.id === `overtime:${staffId}`)!.amount;
  const paidBanked = banked.ledger.find((line) => line.id === `overtime:${staffId}`)!.amount;
  const paidRejected = rejected.ledger.find((line) => line.id === `overtime:${staffId}`)!.amount;
  assert.ok(paidBanked < paidBefore);
  assert.equal(paidBanked, paidRejected);
});

test("Thailand weekly OT plus holiday-work warnings use week boundaries and disclose partial coverage", () => {
  const data = createSeedData();
  const branchId = "hkt-central";
  const targetStaff = data.branches[branchId].staff[0];
  const weekDays = data.attendance.filter((day) => day.branchId === branchId &&
    day.staffId === targetStaff.id && day.date >= "2026-10-05" && day.date <= "2026-10-11");
  assert.equal(weekDays.length, 7);
  weekDays.forEach((day, index) => {
    day.overtimeHours = index === 6 ? 0 : 6;
    day.actualClockIn = index === 6 ? "09:00" : "09:00";
    day.actualClockOut = index === 6 ? "17:00" : "15:00";
    day.effectiveClockIn = day.actualClockIn;
    day.effectiveClockOut = day.actualClockOut;
    day.holiday = index === 6;
  });

  const complete = thailandWeeklyOvertimeWarnings(data, branchId, "2026-10");
  const completeWarning = complete.find((warning) =>
    warning.staffId === targetStaff.id && warning.weekStart === "2026-10-05");
  assert.equal(completeWarning?.combinedHours, 44);
  assert.equal(completeWarning?.coveredDays, 7);
  assert.equal(completeWarning?.requiredDays, 7);

  const partial = thailandWeeklyOvertimeWarnings(data, branchId, "2026-10",
    data.attendance.filter((day) => day.id !== weekDays[0].id));
  const partialWarning = partial.find((warning) =>
    warning.staffId === targetStaff.id && warning.weekStart === "2026-10-05");
  assert.equal(partialWarning?.coveredDays, 6);
  assert.equal(partialWarning?.requiredDays, 7);

  const calculation = calculateMonthEnd(data, branchId, "2026-10");
  assert.ok(calculation.warnings.some((warning) =>
    warning.includes("Thailand weekly OT + holiday work") && warning.includes("44.00h")));
  const ledgerLine = calculation.ledger.find((line) => line.id === `overtime:${targetStaff.id}`);
  assert.ok(ledgerLine?.workings.some((working) => working.includes("Thailand weekly OT + holiday work")));
});