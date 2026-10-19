// Ported from the payroll prototype's employee-incentives.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import assert from "node:assert/strict";
import { describeSuite, test } from "../harness";
import { calculateEmployeeRevenueIncentives, calculateVoucherCommissions } from "../../../server/payroll/engine/employee-incentives";
import type {
  AttendanceDay,
  BranchId,
  BoothVoucher,
  EmployeeIncentivePlan,
  PayrollWorld,
} from "../../../server/payroll/engine/model";
import { branchBusinessPeriodAt, eligibleBoothStaffAtIssue, isStrictIsoInstant } from "../../../server/payroll/engine/voucher-eligibility";
describeSuite("employee-incentives.test.ts");

const currentMonth = "2026-10";
const branchId: BranchId = "hkt-central";
const staffIds = ["sales-a", "sales-b"];

function freshData(): PayrollWorld {
  return {
    branches: {
      [branchId]: {
        detailsHistory: [{ effectiveFrom: "2020-01", details: { country: "TH", currency: "THB" } }],
        staff: staffIds.map((id) => ({
          id, name: id === staffIds[0] ? "Alex" : "Sam", joinedOn: "2020-01-01", leftOn: null,
        })),
        employeeIncentivePlans: [],
        voucherSettings: { method: "percent", value: 0.05 },
      },
      "fictional-my-branch": {
        detailsHistory: [{ effectiveFrom: "2020-01", details: { country: "MY", currency: "MYR" } }],
        staff: [{ id: "malaysia-sales", name: "Mina", joinedOn: "2020-01-01", leftOn: null }],
        employeeIncentivePlans: [],
        voucherSettings: { method: "percent", value: 0.05 },
      },
    },
    revenue: [{
      branchId,
      month: currentMonth,
      streams: { tickets: 0, eventsParties: 0, cafeFnb: 0, retail: 0, memberships: 0 },
      costOfSales: { tickets: 0, eventsParties: 0, cafeFnb: 0, retail: 0, memberships: 0 },
    }],
    attendance: [],
    boothRoster: [],
    boothVouchers: [],
  } as unknown as PayrollWorld;
}

function makePlan(
  overrides: Partial<EmployeeIncentivePlan> & Pick<EmployeeIncentivePlan, "id" | "staffId">,
): EmployeeIncentivePlan {
  return {
    // @ts-expect-error -- prototype verbatim: `...overrides` below sets these again (TS2783 only).
    id: overrides.id,
    // @ts-expect-error -- as above.
    staffId: overrides.staffId,
    name: "Revenue share",
    streams: ["eventsParties"],
    rate: 0.01,
    basis: "branch",
    scope: "stream",
    targetGate: null,
    monthlyCap: null,
    effectiveFrom: `${currentMonth}-01`,
    effectiveTo: null,
    proratePartMonth: false,
    taxable: true,
    socialSecurity: true,
    ...overrides,
  };
}

function voucherFixture(
  data: PayrollWorld,
  overrides: Partial<BoothVoucher> = {},
): BoothVoucher {
  const staffIds = overrides.staffIds ?? [data.branches[branchId].staff[0].id];
  return {
    code: "TEST-VOUCHER",
    branchId,
    issuedAt: `${currentMonth}-05T09:00:00+07:00`,
    prizeType: "Test prize",
    staffIds,
    expiresAt: `${currentMonth}-28T23:59:59+07:00`,
    redeemedAt: `${currentMonth}-05T11:00:00+07:00`,
    redeemedSpend: 100,
    splitPercentByStaffId: null,
    ...overrides,
  };
}

function setDutyAndAttendance(
  data: PayrollWorld,
  branch: BranchId,
  date: string,
  staffIds: string[],
  clockIn: string | null,
  clockOut: string | null,
): void {
  data.boothRoster = data.boothRoster.filter((duty) =>
    duty.branchId !== branch || duty.date !== date);
  data.boothRoster.push({ branchId: branch, date, staffIds: [...staffIds] });
  data.attendance = data.attendance.filter((day) =>
    day.branchId !== branch || day.date !== date || !staffIds.includes(day.staffId));
  for (const staffId of staffIds) {
    data.attendance.push({
      id: `test:${branch}:${date}:${staffId}`,
      branchId: branch,
      staffId,
      date,
      scheduled: true,
      dayOff: false,
      holiday: false,
      plannedClockIn: "09:00",
      plannedClockOut: "17:00",
      actualClockIn: clockIn,
      actualClockOut: clockOut,
      effectiveClockIn: clockIn,
      effectiveClockOut: clockOut,
      overtimeHours: 0,
      exceptions: [],
    } as AttendanceDay);
  }
}

function revenueRow(data: PayrollWorld, month = currentMonth) {
  let row = data.revenue.find((item) => item.branchId === branchId && item.month === month);
  if (!row) {
    row = {
      branchId,
      month,
      streams: { tickets: 0, eventsParties: 0, cafeFnb: 0, retail: 0, memberships: 0 },
      costOfSales: { tickets: 0, eventsParties: 0, cafeFnb: 0, retail: 0, memberships: 0 },
    };
    data.revenue.push(row);
  }
  return row;
}

test("gross-profit revenue shares show an auditable stream formula and floor losses at zero", () => {
  const data = freshData();
  const revenue = revenueRow(data);
  revenue.streams.eventsParties = 100_000;
  revenue.costOfSales = { eventsParties: 3_700, tickets: 0, cafeFnb: 0, retail: 0, memberships: 0 };
  const staffId = data.branches[branchId].staff[0].id;
  data.branches[branchId].employeeIncentivePlans = [makePlan({
    id: "gp-events", staffId, basis: "gross-profit", streams: ["eventsParties"], rate: 0.01,
  })];

  const row = calculateEmployeeRevenueIncentives(data, branchId, currentMonth)[0];
  assert.equal(row.result.kind, "employee-plan");
  assert.equal(row.amount, 963);
  assert.ok(row.result.steps.some((step) =>
    step.includes("1% × Events & Parties gross profit ฿96,300 = ฿963")));

  revenue.costOfSales.eventsParties = 110_000;
  const loss = calculateEmployeeRevenueIncentives(data, branchId, currentMonth)[0];
  assert.equal(loss.amount, 0);
  assert.equal(loss.result.kind, "employee-plan");
  if (loss.result.kind === "employee-plan") {
    assert.equal(loss.result.sourceFigure, -10_000);
    assert.ok(loss.result.steps.some((step) => step.includes("payout floor is zero")));
  }
});

test("overall gross profit sums branch streams and unavailable costs do not invent a base", () => {
  const data = freshData();
  const revenue = revenueRow(data);
  revenue.streams = { tickets: 10_000, eventsParties: 20_000, cafeFnb: 30_000, retail: 40_000, memberships: 50_000 };
  revenue.costOfSales = { tickets: 1_000, eventsParties: 2_000, cafeFnb: 3_000, retail: 4_000, memberships: 5_000 };
  const staffId = data.branches[branchId].staff[0].id;
  data.branches[branchId].employeeIncentivePlans = [makePlan({
    id: "gp-overall", staffId, basis: "gross-profit", scope: "overall", streams: [], rate: 0.01,
  })];
  const row = calculateEmployeeRevenueIncentives(data, branchId, currentMonth)[0];
  assert.equal(row.amount, 1_350);
  assert.equal(row.result.kind, "employee-plan");
  if (row.result.kind === "employee-plan") {
    assert.equal(row.result.scope, "overall");
    assert.equal(row.result.sourceFigure, 135_000);
  }

  delete (revenue.costOfSales as Partial<typeof revenue.costOfSales>).memberships; // cast only: the prototype test deletes a required key
  const unavailable = calculateEmployeeRevenueIncentives(data, branchId, currentMonth)[0];
  assert.equal(unavailable.amount, 0);
  assert.equal(unavailable.result.kind, "employee-plan");
  if (unavailable.result.kind === "employee-plan") assert.equal(unavailable.result.sourceFigure, null);
});

test("overall revenue uses all branch streams without a staff-sales source", () => {
  const data = freshData();
  const revenue = revenueRow(data);
  revenue.streams = { tickets: 10_000, eventsParties: 20_000, cafeFnb: 30_000, retail: 40_000, memberships: 50_000 };
  const staffId = data.branches[branchId].staff[0].id;
  data.branches[branchId].employeeIncentivePlans = [makePlan({
    id: "overall-revenue", staffId, basis: "branch", scope: "overall", streams: [], rate: 0.01,
  })];

  const row = calculateEmployeeRevenueIncentives(data, branchId, currentMonth)[0];
  assert.equal(row.amount, 1_500);
  assert.equal(row.result.kind, "employee-plan");
  if (row.result.kind === "employee-plan") {
    assert.equal(row.result.sourceFigure, 150_000);
    assert.equal(row.result.scope, "overall");
  }
});

test("future employee override masks its role default only in months it is effective", () => {
  const data = freshData();
  const staffId = data.branches[branchId].staff[0].id;
  revenueRow(data).streams.eventsParties = 100_000;
  const nextMonth = "2026-11";
  revenueRow(data, nextMonth).streams.eventsParties = 100_000;
  const defaultPlan = makePlan({
    id: "dated-role-default",
    staffId,
    sourceRoleDefaultId: "events-role-default",
    isOverride: false,
    rate: 0.01,
  });
  const futureOverride = makePlan({
    id: "dated-future-override",
    staffId,
    sourceRoleDefaultId: "events-role-default",
    isOverride: true,
    rate: 0.02,
    effectiveFrom: `${nextMonth}-01`,
  });
  data.branches[branchId].employeeIncentivePlans = [defaultPlan, futureOverride];

  const current = calculateEmployeeRevenueIncentives(data, branchId, currentMonth);
  assert.equal(current.find((row) => row.ruleId === `employee-plan:${defaultPlan.id}`)?.amount, 1_000,
    "a future override must not suppress the currently effective default");
  assert.equal(current.find((row) => row.ruleId === `employee-plan:${futureOverride.id}`)?.amount, 0);

  const future = calculateEmployeeRevenueIncentives(data, branchId, nextMonth);
  assert.equal(future.some((row) => row.ruleId === `employee-plan:${defaultPlan.id}`), false,
    "the active override replaces its role default from its effective month onward");
  assert.equal(future.find((row) => row.ruleId === `employee-plan:${futureOverride.id}`)?.amount, 2_000);
});

test("midmonth role-default and override allocate basis by effective days without stream duplication", () => {
  const data = freshData();
  const staffId = data.branches[branchId].staff[0].id;
  const revenue = revenueRow(data);
  revenue.streams.eventsParties = 100_000;
  revenue.streams.retail = 62_000;
  const defaultPlan = makePlan({
    id: "midmonth-role-default",
    staffId,
    streams: ["eventsParties", "retail"],
    sourceRoleDefaultId: "events-role-default",
    isOverride: false,
    rate: 0.01,
    proratePartMonth: false,
  });
  const override = makePlan({
    id: "midmonth-events-override",
    staffId,
    streams: ["eventsParties"],
    sourceRoleDefaultId: "events-role-default",
    isOverride: true,
    rate: 0.02,
    effectiveFrom: `${currentMonth}-16`,
    proratePartMonth: false,
  });
  data.branches[branchId].employeeIncentivePlans = [defaultPlan, override];

  const rows = calculateEmployeeRevenueIncentives(data, branchId, currentMonth);
  const defaultRow = rows.find((row) => row.ruleId === `employee-plan:${defaultPlan.id}`);
  const overrideRow = rows.find((row) => row.ruleId === `employee-plan:${override.id}`);
  assert.ok(defaultRow && overrideRow);
  const daysInMonth = new Date(Date.UTC(2026, 9 + 1, 0)).getUTCDate();
  const expectedDefault = 100_000 * 0.01 * 15 / daysInMonth + 62_000 * 0.01;
  const expectedOverride = 100_000 * 0.02 * (daysInMonth - 15) / daysInMonth;
  assert.equal(defaultRow.amount, Math.round(expectedDefault * 100) / 100,
    "the default retains only pre-override Events days while its unmatched retail stream remains whole-month");
  assert.equal(overrideRow.amount, Math.round(expectedOverride * 100) / 100,
    "the override earns only from its effective date, even when part-month proration is disabled");
  assert.equal(defaultRow.amount + overrideRow.amount,
    Math.round((expectedDefault + expectedOverride) * 100) / 100);
  assert.ok(defaultRow.result.steps.some((step) => step.includes(`Events & Parties 15/${daysInMonth} days`)));
  assert.ok(defaultRow.result.steps.some((step) => step.includes("Retail full month")));
  assert.ok(overrideRow.result.steps.some((step) =>
    step.includes(`Events & Parties ${daysInMonth - 15}/${daysInMonth} days`)));

  const sameDayBoundary = freshData();
  revenueRow(sameDayBoundary).streams.eventsParties = 100_000;
  const endedDefault = makePlan({
    id: "ended-role-default",
    staffId,
    sourceRoleDefaultId: "events-role-default",
    isOverride: false,
    effectiveTo: `${currentMonth}-15`,
    proratePartMonth: false,
  });
  const nextDayOverride = makePlan({
    id: "next-day-override",
    staffId,
    sourceRoleDefaultId: "events-role-default",
    isOverride: true,
    rate: 0.02,
    effectiveFrom: `${currentMonth}-16`,
    proratePartMonth: false,
  });
  sameDayBoundary.branches[branchId].employeeIncentivePlans = [endedDefault, nextDayOverride];
  const adjacentRows = calculateEmployeeRevenueIncentives(sameDayBoundary, branchId, currentMonth);
  assert.equal(adjacentRows.find((row) => row.ruleId === `employee-plan:${endedDefault.id}`)?.amount,
    Math.round(100_000 * 0.01 * 15 / daysInMonth * 100) / 100);
  assert.equal(adjacentRows.find((row) => row.ruleId === `employee-plan:${nextDayOverride.id}`)?.amount,
    Math.round(100_000 * 0.02 * (daysInMonth - 15) / daysInMonth * 100) / 100);
});

test("retired attributed bases fail closed rather than reading staff-sales data", () => {
  const data = freshData();
  const staffId = data.branches[branchId].staff[0].id;
  data.branches[branchId].employeeIncentivePlans = [makePlan({
    id: "legacy-attributed", staffId, basis: "attributed" as EmployeeIncentivePlan["basis"],
  })];
  assert.throws(() => calculateEmployeeRevenueIncentives(data, branchId, currentMonth), /retired incentive basis/);
});

test("issue eligibility requires an explicit instant, matching roster, and prior clock-in", () => {
  const data = freshData();
  const staffId = data.branches[branchId].staff[0].id;
  const issueDate = `${currentMonth}-05`;
  setDutyAndAttendance(data, branchId, issueDate, [staffId], "09:00", null);
  const issuedAt = `${issueDate}T09:00:00+07:00`;
  assert.deepEqual(eligibleBoothStaffAtIssue(data, branchId, issuedAt), [staffId]);
  assert.deepEqual(eligibleBoothStaffAtIssue(data, branchId, `${issueDate}T08:59:00+07:00`), []);
  setDutyAndAttendance(data, branchId, issueDate, [staffId], "09:00", "17:00");
  assert.deepEqual(eligibleBoothStaffAtIssue(data, branchId, `${issueDate}T18:00:00+07:00`), []);
  assert.equal(isStrictIsoInstant(`${issueDate}T09:00`), false);
  assert.equal(isStrictIsoInstant(`${issueDate}T09:00:00+07:00`), true);
});

test("booth commissions pay once in branch-local redemption month and split the rounded voucher total", () => {
  const data = freshData();
  const staffIds = data.branches[branchId].staff.slice(0, 2).map((staff) => staff.id);
  const issueDate = `${currentMonth}-05`;
  setDutyAndAttendance(data, branchId, issueDate, staffIds, "09:00", "17:00");
  data.branches[branchId].voucherSettings = { method: "percent", value: 0.05 };
  const voucher = voucherFixture(data, {
    code: "SPLIT-100",
    staffIds,
    splitPercentByStaffId: { [staffIds[0]]: 50, [staffIds[1]]: 50 },
    redeemedSpend: 101,
  });
  data.boothVouchers = [voucher];

  const currentRows = calculateVoucherCommissions(data, branchId, currentMonth);
  assert.equal(currentRows.length, 2);
  assert.deepEqual(currentRows.map((row) => row.amount), [2.53, 2.52]);
  assert.equal(currentRows.reduce((total, row) => total + row.amount, 0), 5.05);
  assert.ok(currentRows.some((row) =>
    row.result.steps.some((step) => step.includes("balanced rounding adjustment"))));
  const [year, monthNumber] = currentMonth.split("-").map(Number);
  const otherMonth = `${monthNumber === 12 ? year + 1 : year}-${String(monthNumber === 12 ? 1 : monthNumber + 1).padStart(2, "0")}`;
  assert.deepEqual(calculateVoucherCommissions(data, branchId, otherMonth), []);
});

test("fixed voucher commission is per redeemed voucher and invalid issue eligibility is explicitly nonpayable", () => {
  const data = freshData();
  const staffId = data.branches[branchId].staff[0].id;
  const issueDate = `${currentMonth}-05`;
  setDutyAndAttendance(data, branchId, issueDate, [staffId], "09:00", "17:00");
  data.branches[branchId].voucherSettings = { method: "fixed", value: 25 };
  data.boothVouchers = [voucherFixture(data, {
    code: "FIXED-ONE",
    redeemedSpend: 0,
  })];
  assert.equal(calculateVoucherCommissions(data, branchId, currentMonth)[0].amount, 25);

  data.boothVouchers = [voucherFixture(data, {
    code: "EXPIRED-REDEMPTION",
    expiresAt: `${issueDate}T10:00:00+07:00`,
    redeemedAt: `${issueDate}T10:00:01+07:00`,
  })];
  const late = calculateVoucherCommissions(data, branchId, currentMonth)[0];
  assert.equal(late.amount, 0);
  assert.ok(late.result.steps.some((step) => step.includes("Redemption must be after issue and on or before expiry.")));

  data.boothVouchers = [voucherFixture(data, { code: "FIXED-ONE", redeemedSpend: 0 })];
  data.boothRoster = [];
  const invalid = calculateVoucherCommissions(data, branchId, currentMonth)[0];
  assert.equal(invalid.amount, 0);
  assert.equal(invalid.eligible, false);
  assert.ok(invalid.result.steps.some((step) => step.includes("Not payable: Every assigned employee")));
});

test("verified voucher issue evidence is stable across later attendance and roster edits", () => {
  const data = freshData();
  const staffId = data.branches[branchId].staff[0].id;
  const issueDate = `${currentMonth}-05`;
  setDutyAndAttendance(data, branchId, issueDate, [staffId], "09:00", "17:00");
  data.branches[branchId].voucherSettings = { method: "percent", value: 0.05 };
  const voucher = {
    ...voucherFixture(data, { code: "CAPTURED-ISSUE", staffIds: [staffId] }),
    verifiedStaffIdsAtIssue: [staffId],
  };
  data.boothVouchers = [voucher];
  assert.equal(calculateVoucherCommissions(data, branchId, currentMonth)[0].amount, 5);

  data.boothRoster = [];
  const attendance = data.attendance.find((day) =>
    day.branchId === branchId && day.staffId === staffId && day.date === issueDate)!;
  attendance.actualClockIn = "13:00";
  attendance.effectiveClockIn = "13:00";
  const stillVerified = calculateVoucherCommissions(data, branchId, currentMonth)[0];
  assert.equal(stillVerified.amount, 5);
  assert.equal(stillVerified.eligible, true);

  const unverified: BoothVoucher & { verifiedStaffIdsAtIssue?: string[] } = { ...voucher };
  delete unverified.verifiedStaffIdsAtIssue;
  data.boothVouchers = [unverified];
  const currentInvalid = calculateVoucherCommissions(data, branchId, currentMonth)[0];
  assert.equal(currentInvalid.amount, 0);
  assert.equal(currentInvalid.eligible, false,
    "a current voucher without captured proof must still be checked against current issue-time records");
});

test("Malaysia voucher issue and redemption periods use local calendar dates across UTC month boundary", () => {
  const data = freshData();
  const malaysiaBranch: BranchId = "fictional-my-branch";
  const staffId = data.branches[malaysiaBranch].staff[0].id;
  const issueDate = "2026-10-31";
  setDutyAndAttendance(data, malaysiaBranch, issueDate, [staffId], "22:00", "02:00");
  const issue = "2026-10-31T23:00:00+08:00";
  const redemption = "2026-11-01T00:15:00+08:00";
  assert.equal(branchBusinessPeriodAt(data, malaysiaBranch, redemption)?.month, "2026-11");
  assert.deepEqual(eligibleBoothStaffAtIssue(data, malaysiaBranch, issue), [staffId]);
  data.branches[malaysiaBranch].voucherSettings = { method: "fixed", value: 30 };
  data.boothVouchers = [voucherFixture(data, {
    branchId: malaysiaBranch,
    code: "LOCAL-MONTH",
    issuedAt: issue,
    expiresAt: "2026-11-02T23:59:00+08:00",
    redeemedAt: redemption,
    staffIds: [staffId],
  })];
  assert.equal(calculateVoucherCommissions(data, malaysiaBranch, "2026-10").length, 0);
  assert.equal(calculateVoucherCommissions(data, malaysiaBranch, "2026-11")[0]?.amount, 30);
});