// SCRUM-1055 — a former employee's single shift in company payroll, on the
// prototype's fictional seed world (no database): paid in the run of the
// month it is worked, on the old contract (the owner's answers R8 to R11 of
// 19 November 2026), and nothing else in the run moves.
import assert from "node:assert/strict";
import { describeSuite, test } from "../harness";
import { createSeedData } from "../seed-world";
import { calculateCompanyEngine } from "../../../server/payroll/engine/company-calculations";
import { money, SINGLE_SHIFT_COMPONENT } from "../../../server/payroll/engine/company-math";
import type { AttendanceDay, PayrollWorld, StaffMember } from "../../../server/payroll/engine/model";
import type { CompanyCalculation, CompanyPerson } from "../../../server/payroll/engine/company-model";
import type { EmployeePayrollProfile } from "../../../server/payroll/engine/payroll-profile";
describeSuite("single-shift (SCRUM-1055)");

const MONTH = "2026-10"; // 31 days: a day of a monthly salary is the salary ÷ 31 (R11), not ÷ 30
const SHIFT = "2026-10-14";
const FORMER = "zz-former";

/** The seed world with one former employee (left in June) cloned from a Central monthly profile, on a single shift. */
function world(edit: (p: EmployeePayrollProfile) => void = () => undefined, opts: { clocked?: boolean; overtime?: number; shift?: string } = {}): PayrollWorld {
  const data = createSeedData();
  const central = data.branches["hkt-central"];
  const model = central.staff.find((s) => s.id === "hkc-001")!;
  const p: EmployeePayrollProfile = {
    ...structuredClone(model.payrollProfile!), workerType: "monthly", monthlySalary: 15500, dayRate: 0, fixedFee: 0,
    joinedOn: "2025-01-01", lastWorkingDay: "2026-06-30", ssoEligible: true, pnd1Eligible: true, foodAllowanceEligible: true, foodAllowancePerDay: 60,
    otEligible: true, serviceChargeEligible: true, advances: [], separatePayments: [], studentLoanMonthly: 0, pnd3WithholdingPercent: 0,
    bankDetails: { ...model.payrollProfile!.bankDetails, accountNumber: "ZZ-TEST-FORMER-1", accountName: "ZZ TEST Former" },
  };
  edit(p);
  const former: StaffMember = { ...structuredClone(model), id: FORMER, employeeNumber: FORMER, name: "ZZ TEST Former",
    monthlySalary: p.workerType === "day-rate" ? null : p.workerType === "contractor" ? p.fixedFee : p.monthlySalary,
    dayRate: p.workerType === "day-rate" ? p.dayRate : null, joinedOn: p.joinedOn, leftOn: p.lastWorkingDay, payrollProfile: p,
    singleShifts: [{ invitationId: "zz-invitation-1", date: opts.shift ?? SHIFT }] };
  central.staff.push(former);
  if (opts.clocked !== false) {
    const day: AttendanceDay = { id: `hkt-central-${FORMER}-${opts.shift ?? SHIFT}`, branchId: "hkt-central", staffId: FORMER, date: opts.shift ?? SHIFT,
      scheduled: true, dayOff: false, holiday: false, plannedClockIn: "10:00", plannedClockOut: "19:00",
      actualClockIn: "10:00", actualClockOut: opts.overtime ? `${19 + opts.overtime}:00` : "19:00", effectiveClockIn: "10:00",
      effectiveClockOut: opts.overtime ? `${19 + opts.overtime}:00` : "19:00", overtimeHours: opts.overtime ?? 0,
      exceptions: opts.overtime ? [{ kind: "overtime", resolution: "Approved", reason: "ZZ TEST overtime", rawClockIn: "10:00", rawClockOut: `${19 + opts.overtime}:00`,
        effectiveClockIn: "10:00", effectiveClockOut: `${19 + opts.overtime}:00`, approvedBy: "ZZ TEST" }] : [] } as AttendanceDay;
    data.attendance.push(day);
  }
  return data;
}
const run = (data: PayrollWorld) => calculateCompanyEngine(data, data.companyPayroll!, MONTH);
const personIn = (calc: CompanyCalculation, id = FORMER): CompanyPerson | undefined => calc.entities.flatMap((e) => e.people).find((p) => p.id === id);
const line = (p: CompanyPerson | undefined, id: string) => p?.lines.find((l) => l.id === id);
const rules = () => createSeedData().branches["hkt-central"].rulesHistory.at(-1)!;

test("R11: a day of a monthly salary is the salary ÷ the days in the month, one Single shift line, taxed and an SSO wage", () => {
  const p = personIn(run(world()))!;
  const shift = line(p, `${SINGLE_SHIFT_COMPONENT}:zz-invitation-1`)!;
  assert.equal(shift.label, "Single shift");
  assert.equal(shift.component, SINGLE_SHIFT_COMPONENT);
  assert.equal(shift.amount, money(15500 / 31));
  assert.equal(shift.amount, 500);
  assert.deepEqual([shift.taxable, shift.ssoWage, shift.category], [true, true, "earning"]);
  assert.equal(money(shift.allocations.reduce((n, a) => n + a.amount, 0)), shift.amount);
  assert.match(shift.formula, /15500 monthly salary ÷ 31 days in 2026-10; single shift on 2026-10-14/);
  assert.equal(p.lines.filter((l) => l.component === SINGLE_SHIFT_COMPONENT).length, 1, "one line per invitation");
});

test("R9: tax and social security through the old contract's own path, on this run's earnings", () => {
  const p = personIn(run(world()))!;
  const r = rules();
  const wage = p.lines.filter((l) => l.category === "earning" && l.ssoWage).reduce((n, l) => n + l.amount, 0);
  assert.equal(wage, 500, "the shift is the month's whole SSO wage");
  assert.equal(line(p, "sso")!.amount, Math.round(Math.min(wage, r.thSso.wageCap) * r.thSso.employeeRate));
  assert.equal(line(p, "employer-sso")!.amount, Math.round(Math.min(wage, r.thSso.wageCap) * r.thSso.employerRate));
  assert.ok(line(p, "pnd1"), "PND.1 is worked out by the cumulative path, as for the old contract");
  assert.match(line(p, "pnd1")!.formula, /Cumulative withholding/);
  const off = personIn(run(world((x) => { x.ssoEligible = false; x.pnd1Eligible = false; })))!;
  assert.equal(line(off, "sso")!.amount, 0, "a contract without SSO carries none, as before");
  assert.match(line(off, "pnd1")!.formula, /PND\.1 disabled on profile/);
});

test("R10: the food allowance of the worked day on the food line's own flags; none without a clock-in", () => {
  const p = personIn(run(world()))!;
  const food = line(p, `${SINGLE_SHIFT_COMPONENT}-food:zz-invitation-1`)!;
  assert.deepEqual([food.component, food.amount, food.taxable, food.ssoWage], ["food", 60, false, false]);
  const unclocked = personIn(run(world(undefined, { clocked: false })))!;
  assert.equal(line(unclocked, `${SINGLE_SHIFT_COMPONENT}-food:zz-invitation-1`), undefined);
  const notEligible = personIn(run(world((x) => { x.foodAllowanceEligible = false; })))!;
  assert.equal(line(notEligible, `${SINGLE_SHIFT_COMPONENT}-food:zz-invitation-1`), undefined);
});

test("no clock-in: a monthly contract is paid by the calendar, a day-rate contract only for a worked day", () => {
  const monthly = line(personIn(run(world(undefined, { clocked: false }))), `${SINGLE_SHIFT_COMPONENT}:zz-invitation-1`)!;
  assert.equal(monthly.amount, 500);
  assert.match(monthly.formula, /no clock-in recorded, a monthly contract is paid by the calendar/);
  const dayRate = (x: EmployeePayrollProfile) => { x.workerType = "day-rate"; x.dayRate = 700; x.monthlySalary = 0; };
  assert.equal(line(personIn(run(world(dayRate))), `${SINGLE_SHIFT_COMPONENT}:zz-invitation-1`)!.amount, 700, "the old day rate, as it was");
  assert.equal(personIn(run(world(dayRate, { clocked: false }))), undefined, "an unworked day-rate shift is not paid");
});

test("a contractor's fixed monthly fee: the fee ÷ the days in the month, and its PND.3 withholding as before", () => {
  const p = personIn(run(world((x) => { x.workerType = "contractor"; x.fixedFee = 31000; x.monthlySalary = 0; x.pnd3WithholdingPercent = 3; x.ssoEligible = false; x.pnd1Eligible = false; x.foodAllowanceEligible = false; x.otEligible = false; })))!;
  assert.equal(line(p, `${SINGLE_SHIFT_COMPONENT}:zz-invitation-1`)!.amount, 1000);
  assert.equal(p.lines.filter((l) => l.component === "pnd3").reduce((n, l) => n + l.amount, 0), 30);
});

test("R10: overtime of the shift's day as on the old contract, allocated to that day", () => {
  const p = personIn(run(world(undefined, { overtime: 2 })))!;
  const ot = line(p, "overtime")!;
  assert.ok(ot.amount > 0, "the shift's approved overtime is paid");
  assert.equal(money(ot.allocations.reduce((n, a) => n + a.amount, 0)), ot.amount);
  assert.equal(line(personIn(run(world((x) => { x.otEligible = false; }, { overtime: 2 }))), "overtime"), undefined, "no overtime on a contract without it");
});

test("a day the payroll profile still counts as employed is not paid twice: no Single shift line, and the run says so", () => {
  const calc = run(world((x) => { x.lastWorkingDay = null; }));
  assert.equal(line(personIn(calc), `${SINGLE_SHIFT_COMPONENT}:zz-invitation-1`), undefined);
  assert.ok(calc.exceptions.some((e) => e.kind === "single-shift" && e.staffId === FORMER && /paid as an employed day and not again/.test(e.message)));
});

test("everyone else's pay is identical with and without the single shift; calculated twice it is the same run", () => {
  const without = run(createSeedData());
  const withShift = run(world(undefined, { overtime: 2 }));
  for (const entity of without.entities) {
    const other = withShift.entities.find((e) => e.entityId === entity.entityId)!;
    for (const person of entity.people) assert.deepEqual(other.people.find((p) => p.id === person.id), person, person.id);
    assert.equal(other.people.length, entity.people.length + (personIn(withShift)?.entityId === entity.entityId ? 1 : 0));
  }
  assert.deepEqual(withShift.service, without.service, "the service-charge pools and shares do not move");
  assert.deepEqual(withShift.incentives, without.incentives);
  assert.deepEqual(withShift.exceptions.filter((e) => e.staffId !== FORMER), without.exceptions);
  assert.deepEqual(run(world(undefined, { overtime: 2 })), withShift, "the same inputs calculate the same run");
});

test("a shift of another month is not paid by this one", () => {
  assert.equal(personIn(run(world(undefined, { shift: "2026-11-02", clocked: false }))), undefined);
});

test("a leaver of last month, already in the month for the service-charge payout: the payout stays as it was, the shift adds its own line", () => {
  const leaver = (x: EmployeePayrollProfile) => { x.lastWorkingDay = "2026-09-20"; };
  const withShift = world(leaver);
  const without = world(leaver);
  delete without.branches["hkt-central"].staff.find((s) => s.id === FORMER)!.singleShifts;
  without.attendance = without.attendance.filter((d) => d.staffId !== FORMER || d.date !== SHIFT);
  const a = personIn(run(withShift))!, b = personIn(run(without))!;
  const sc = (p: CompanyPerson) => p.lines.filter((l) => l.component === "sc");
  assert.ok(sc(b).length > 0, "the leaver has last month's service charge");
  assert.deepEqual(sc(a), sc(b));
  assert.equal(line(a, `${SINGLE_SHIFT_COMPONENT}:zz-invitation-1`)!.amount, 500);
  assert.equal(line(b, `${SINGLE_SHIFT_COMPONENT}:zz-invitation-1`), undefined);
});
