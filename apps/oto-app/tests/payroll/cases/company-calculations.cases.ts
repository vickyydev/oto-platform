// Ported from the payroll prototype's company-calculations.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import { createSeedData } from "../seed-world";
import { calculateCompanyMonthEnd } from "../../../server/payroll/engine/run-calculations";
import { apportion, money } from "../../../server/payroll/engine/company-math";
import { calculateCompanyService } from "../../../server/payroll/engine/company-awards";
describeSuite("company-calculations.test.ts");
const data = createSeedData(), doc = data.companyPayroll!;
const result = calculateCompanyMonthEnd(data, doc, "2026-09");
const tt = result.entities.find(e => e.entityId === "tt-concept")!;
test("profile source: GM is one result, 70/30 earnings, no food, once-only registered SSO", () => {
  const gm = tt.people.find(p => p.id === "hkc-001")!;
  assert.equal(gm.components.salary, 49000); assert.equal(gm.components.food ?? 0, 0);
  assert.equal(gm.components.sso, 875);
  const salary = gm.lines.find(l => l.component === "salary")!;
  assert.deepEqual(salary.allocations.map(a => a.amount), [34300, 14700]);
  assert.equal(gm.payments.length, 2); assert.equal(gm.lines.find(l => l.component === "sso")!.registeredBranchId, "hkt-central");
  assert.equal(money(gm.payments.reduce((s, p) => s + p.amount, 0)), gm.net);
});
test("the profile OT flag is authoritative even when the old role default excludes OT", () => {
  const seed = structuredClone(data);
  const member = seed.branches["hkt-central"].staff.find(s => s.id === "hkc-009")!;
  assert.equal(member.payrollProfile!.otEligible, true);
  assert.equal(seed.branches["hkt-central"].rulesHistory.at(-1)!.overtimeEligibilityByRole[member.role], false);
  assert.ok(calculateCompanyMonthEnd(seed, seed.companyPayroll!, "2026-09").entities.find(e => e.entityId === "tt-concept")!
    .people.find(p => p.id === member.id)!.components.overtime > 0);
  member.payrollProfile!.otEligible = false;
  assert.equal(calculateCompanyMonthEnd(seed, seed.companyPayroll!, "2026-09").entities.find(e => e.entityId === "tt-concept")!
    .people.find(p => p.id === member.id)!.components.overtime ?? 0, 0);
});
test("pools conserve cents and use earning-month calendar allocation", () => {
  result.service.forEach(b => assert.equal(money(b.paid + b.retained), b.pool));
  const ch = result.service.find(b => b.branchId === "hkt-chalong")!;
  assert.equal(ch.percent, 6); assert.equal(ch.earningMonth, "2026-08");
  assert.equal(ch.people.find(p => p.staffId === "hkc-001")!.units, 9.3);
});
test("incentive gates, team days, unit pool, individual, KPI and guarantee", () => {
  assert.equal(result.incentives.find(a => a.ruleId === "ops-chalong")!.amount, 0);
  assert.match(result.incentives.find(a => a.ruleId === "ops-chalong")!.formula, /Target not met/);
  assert.equal(result.incentives.find(a => a.ruleId === "gm")!.amount, 18780);
  assert.equal(money(result.incentives.filter(a => a.ruleId === "nanny").reduce((s, a) => s + a.amount, 0)), 56000);
  assert.equal(money(result.incentives.filter(a => a.ruleId === "flyers").reduce((s, a) => s + a.amount, 0)), 9000);
  assert.equal(result.incentives.find(a => a.ruleId === "reply")!.amount, 2000);
});
test("contractor, separate rent, student loan, advances and cash fee use profile", () => {
  const chef = tt.people.find(p => p.id === "hch-010")!;
  assert.equal(chef.components.salary, 100000); assert.equal(chef.components.sso, 0);
  assert.equal(chef.components.pnd1, 0); assert.equal(chef.components.pnd3, 3000);
  assert.equal(tt.people.find(p => p.id === "hkc-001")!.components.pnd3, 250);
  assert.equal(tt.people.find(p => p.id === "hkc-010")!.components["student-loan"], 180);
  assert.equal(tt.people.find(p => p.id === "hkc-011")!.components.advance, 5000);
  assert.equal(tt.people.find(p => p.id === "hkc-026")!.components.advance, 1000);
  assert.equal(tt.people.find(p => p.id === "hkc-042")!.components["cash-fee"], 1960);
  assert.equal(tt.people.find(p => p.id === "hkc-042")!.payments[0].method, "cash");
});
test("joiner/leaver calendar proration, BMG and household isolation", () => {
  const leaver = tt.people.find(p => p.id === "hkc-022")!;
  assert.equal(leaver.employedDays, 15);
  assert.equal(tt.people.find(p => p.id === "hkc-023")!.employedDays, 9);
  const bmg = result.entities.find(e => e.entityId === "bmg")!;
  assert.equal(bmg.people.length, 1); assert.equal(bmg.people[0].components.salary, 35000);
  assert.ok(tt.people.filter(p => p.workerType === "owner-household").every(p => p.costs.every(c => c.costCentre === "owner-non-operational")));
});
test("retained shares and revenue VAT/SC exclusion", () => {
  const copy = structuredClone(doc);
  copy.servicePolicies["hkt-chalong"]![0].excluded = "retain";
  copy.months["2026-08"].revenue["hkt-chalong"]!.streams.tickets.vat = 100;
  const b = calculateCompanyService(data, copy, "2026-09", Object.values(data.branches).flatMap(b => b.staff), []).find(b => b.branchId === "hkt-chalong")!;
  assert.ok(b.retained > 0); assert.equal(money(b.paid + b.retained), b.pool);
  assert.equal(b.revenueBase, 689900); // Selected August POS streams, excluding VAT.
});
test("largest remainder including tiny shares has no rounding drift", () => {
  assert.deepEqual(apportion(0.01, [1, 1, 1]), [0.01, 0, 0]);
  assert.equal(money(apportion(12345.67, [70, 30]).reduce((s, n) => s + n, 0)), 12345.67);
});
test("guarantee tops up and historical SC allocations survive a current-month branch move", () => {
  const copy = structuredClone(data), config = copy.companyPayroll!;
  copy.branches["hkt-central"].staff.find(s => s.id === "hkc-041")!.payrollProfile!.fixedFee = 19000;
  const gm = copy.branches["hkt-central"].staff.find(s => s.id === "hkc-001")!.payrollProfile!;
  gm.allocations.push({ effectiveFrom: "2026-09-01", homeBranchId: "hkt-chalong", lines: [{ costCentre: "hkt-chalong", entityId: "tt-concept", percent: 100, payingAccountId: null }] });
  const calculated = calculateCompanyMonthEnd(copy, config, "2026-09");
  assert.equal(calculated.incentives.find(a => a.ruleId === "guarantee")!.amount, 2000);
  const moved = calculated.entities.find(e => e.entityId === "tt-concept")!.people.find(p => p.id === "hkc-001")!;
  assert.ok(moved.lines.find(l => l.component === "salary")!.allocations.every(a => a.costCentre === "hkt-chalong"));
  assert.ok(moved.lines.find(l => l.id === "sc:hkt-central")!.amount > 0);
  assert.equal(moved.lines.find(l => l.component === "sso")!.registeredBranchId, "hkt-chalong");
});
