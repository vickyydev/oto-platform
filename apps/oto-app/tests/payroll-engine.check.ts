// SCRUM-566 (Payroll R1: the engine port) — the ported engine, pure and fast:
// no database, no routes, no network.
//
//   1. The payroll prototype's own unit tests for the files that were ported
//      (tests/payroll/cases/*.cases.ts, bodies unchanged unless a comment says
//      otherwise), run against the prototype's fictional seed world as
//      committed in tests/fixtures/payroll/parity/.
//   2. One case per concern marker (`rg PAYROLL-CONCERN`): concern 1 charges
//      each attendance rule once, concern 2 estimates prior PIT, concern 3
//      repays advances with no floor, concern 4 pays each pair's built answer.
//   3. A dormant Malaysian world, so the MY code paths compile and run (no MY
//      row exists in any database, and no KL branch anywhere — plan §4).
//   4. The parity fixture: the ported engine on the seed world for 2026-09 and
//      2026-10 matches the prototype engine's own result line for line, except
//      the declared concern-1 difference (no `other:deduction:*` line, and each
//      person's deductions and net moved by exactly those lines).
//
// Usage, from apps/oto-app (CI's OTO App job runs exactly this):
//   npx tsx tests/payroll-engine.check.ts
import assert from "node:assert/strict";
import { registered } from "./payroll/harness";
import { createSeedData, parityExpected } from "./payroll/seed-world";
import "./payroll/cases/company-calculations.cases";
import "./payroll/cases/company-rewards.cases";
import "./payroll/cases/company-workflow.cases";
import "./payroll/cases/company-sources.cases";
import "./payroll/cases/company-issue-review.cases";
import "./payroll/cases/check-fix-step.cases";
import "./payroll/cases/deduction-job-titles.cases";
import "./payroll/cases/ot-bank.cases";
import "./payroll/cases/employee-incentives.cases";
import "./payroll/cases/upload-formats.cases";
import "./payroll/cases/ewf-upload-file.cases";
import "./payroll/cases/payroll-profile.cases";
import { calculateCompanyEngine } from "../server/payroll/engine/company-calculations";
import { calculateMonthEnd } from "../server/payroll/engine/run-calculations";
import { approveCompanyRun, lockCompanyRun, newCompanyDraft } from "../server/payroll/engine/company-workflow";
import { money } from "../server/payroll/engine/company-math";
import { fictionalThaiId } from "../server/payroll/engine/upload-common";
import { countryRulesTemplate } from "../server/payroll/engine/defaults";
import { listStatutoryOffers } from "../server/payroll/engine/statutory-engine";
import { fixedClock } from "../server/payroll/engine/clock";
import type { AttendanceDay, DeductionRule, PayrollWorld } from "../server/payroll/engine/model";
import type { CompanyCalculation, CompanyPerson } from "../server/payroll/engine/company-model";
import { buildSeptemberGoldenFixture, GOLDEN_ENTITY, GOLDEN_MONTH } from "../server/payroll/diagnostics/september-golden-fixture";
import { evaluateSeptemberGoldenFixture } from "../server/payroll/diagnostics/september-golden";

const started = performance.now();
let checks = 0;
const failures: string[] = [];
const check = async (name: string, fn: () => void | Promise<void>) => {
  const t = performance.now();
  try {
    await fn();
    checks += 1;
    console.log(`  ok  ${name} (${Math.round(performance.now() - t)} ms)`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL ${name}\n${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
};
const person = (calc: CompanyCalculation, id: string, entity = GOLDEN_ENTITY): CompanyPerson => {
  const found = calc.entities.find(e => e.entityId === entity)?.people.find(p => p.id === id);
  assert.ok(found, `${id} is in ${entity}`);
  return found;
};

// --- 1. The prototype's own unit tests -------------------------------------
console.log(`payroll-engine.check: ${registered.length} ported prototype tests`);
for (const t of registered) await check(`[${t.suite}] ${t.name}`, t.fn);

// --- 2. One case per concern ------------------------------------------------
/** The golden world plus one fictional late arrival for the Central regular, approved upstream. */
function lateArrivalWorld(rules: DeductionRule[]) {
  const { data, doc } = buildSeptemberGoldenFixture();
  data.branches["hkt-central"].deductionRules = rules;
  const day: AttendanceDay = {
    id: "gold-regular-c:2026-09-07", branchId: "hkt-central", staffId: "gold-regular-c", date: "2026-09-07",
    scheduled: true, dayOff: false, holiday: false, plannedClockIn: "10:00", plannedClockOut: "19:00",
    actualClockIn: "10:40", actualClockOut: "19:00", effectiveClockIn: "10:40", effectiveClockOut: "19:00", overtimeHours: 0,
    exceptions: [{ kind: "late", resolution: "Approved", reason: "Fictional late arrival", rawClockIn: "10:40", rawClockOut: "19:00",
      effectiveClockIn: "10:40", effectiveClockOut: "19:00", approvedBy: "Fictional manager", minutes: 40 }],
  };
  data.attendance = [day];
  return { data, doc };
}
/** Complete fictional filing details, so the upload files are clean and Owner lock can run (they move no number). */
function fileReady(data: PayrollWorld) {
  Object.values(data.branches).flatMap(b => b.staff).forEach((s, i) => Object.assign(s.payrollProfile!, {
    taxId: fictionalThaiId(7000 + i), ssoTitle: "นาย", givenName: "สมมติ",
    bankDetails: { bank: "SCB", bankCode: "014", accountNumber: String(1000000000 + i), accountName: s.name },
  }));
}
const lateRule = (id: string, method: DeductionRule["method"], amount: number): DeductionRule => ({
  id, name: `Fictional late rule ${id}`, enabled: true, issue: "late", freeOccurrences: 0, freeMinutes: 0, method, amount,
  source: "salary", cap: null, roles: [], jobTitles: [], includeStaffIds: ["gold-regular-c"], excludeStaffIds: [],
});

await check("concern 1: two attendance rules and one late arrival give exactly one line per rule — charged once, not twice", () => {
  const { data, doc } = lateArrivalWorld([lateRule("fixed", "fixed", 100), lateRule("minutes", "per-minute", 2)]);
  const regular = person(calculateCompanyEngine(data, doc, GOLDEN_MONTH), "gold-regular-c");
  const ruleLines = regular.lines.filter(l => l.component.startsWith("attendance-rule:"));
  assert.deepEqual(ruleLines.map(l => [l.id, l.amount]), [["attendance-rule:fixed", 100], ["attendance-rule:minutes", 80]]);
  assert.equal(regular.lines.filter(l => l.id.startsWith("other:")).length, 0, "no second, legacy-sourced copy of a rule");
  // The second source the prototype also charged still exists in the older calculation, with the same amounts —
  // which is exactly why the company engine no longer adds it (PAYROLL-CONCERN-1).
  const legacy = calculateMonthEnd(data, "hkt-central", GOLDEN_MONTH, {}).rows.find(r => r.staffId === "gold-regular-c")!;
  assert.deepEqual(legacy.lines.filter(l => l.kind === "deduction" && l.amount > 0).map(l => l.amount), [100, 80]);
  // Without the rules the person nets exactly 180 more: the rules cost once.
  const clean = lateArrivalWorld([]);
  assert.equal(money(person(calculateCompanyEngine(clean.data, clean.doc, GOLDEN_MONTH), "gold-regular-c").net - regular.net), 180);
});
await check("concern 1: the fix moves no golden number — 11 of 11 checks pass, GM net ฿82,387.91", () => {
  const report = evaluateSeptemberGoldenFixture(buildSeptemberGoldenFixture());
  assert.equal(report.checks.length, 11);
  assert.ok(report.pass, JSON.stringify(report.checks.flatMap(c => c.assertions.filter(a => !a.pass))));
  assert.equal(report.checks[0].assertions.find(a => a.label === "GM net")!.actual, 82387.91);
});
await check("concern 2: PND.1 has no year-to-date input — prior withholding is the baseline estimate, even with a locked month before", () => {
  const { data, doc } = buildSeptemberGoldenFixture();
  doc.runs = {};
  const gm = () => person(calculateCompanyEngine(data, doc, "2026-10"), "gold-gm");
  const before = gm().lines.find(l => l.component === "pnd1")!;
  assert.match(before.formula, /estimated prior withholding from baseline annual tax/);
  // Lock September (fictional IDs so the upload files are clean), then recalculate October.
  fileReady(data);
  const clock = fixedClock("2026-10-01T03:00:00.000Z");
  const confirmed = approveCompanyRun(data, doc, GOLDEN_ENTITY, GOLDEN_MONTH, "Fictional GM", { reason: "Concern 2 case", allowOpenProblems: true }, clock);
  const locked = lockCompanyRun(data, confirmed, GOLDEN_ENTITY, GOLDEN_MONTH, "Fictional Owner", clock);
  assert.equal(locked.snapshots.length, 1);
  Object.assign(doc, locked);
  const after = gm().lines.find(l => l.component === "pnd1")!;
  assert.equal(after.amount, before.amount, "a locked September does not change October's PIT: the estimate ignores it");
  assert.match(after.formula, /estimated prior withholding/);
});
await check("concern 3: advances — one-off and instalments against locked history, with no net-pay floor", () => {
  const { data, doc } = buildSeptemberGoldenFixture();
  doc.runs = {};
  fileReady(data);
  const loan = data.branches["hkt-central"].staff.find(s => s.id === "gold-loan")!.payrollProfile!;
  loan.advances = [{ id: "fictional-instalments", principal: 3000, outstandingBalance: 3000, repaymentMode: "instalments", instalments: 99, monthlyRepayment: 1000, startsOn: "2026-09-01" }];
  const low = data.branches["hkt-central"].staff.find(s => s.id === "gold-low")!.payrollProfile!;
  low.advances = [{ id: "fictional-large", principal: 50000, outstandingBalance: 50000, repaymentMode: "one-off", instalments: 1, monthlyRepayment: 50000, startsOn: "2026-09-01" }];
  const sept = calculateCompanyEngine(data, doc, GOLDEN_MONTH);
  assert.equal(person(sept, "gold-gm").components.advance, 5000);
  assert.equal(person(sept, "gold-loan").components.advance, 1000, "instalments repay the monthly amount; the instalment count is not used");
  assert.equal(person(sept, "gold-low").components.advance, 50000, "no floor and no percent-of-net rule");
  assert.ok(person(sept, "gold-low").net < 0);
  assert.ok(person(sept, "gold-low").warnings.includes("Zero or negative net pay"));
  // October before any lock: nothing is repaid yet, so the one-off is charged again.
  assert.equal(person(calculateCompanyEngine(data, doc, "2026-10"), "gold-gm").components.advance, 5000);
  low.advances = [];
  const clock = fixedClock("2026-10-01T03:00:00.000Z");
  const locked = lockCompanyRun(data, approveCompanyRun(data, doc, GOLDEN_ENTITY, GOLDEN_MONTH, "Fictional GM", { reason: "Concern 3 case", allowOpenProblems: true }, clock), GOLDEN_ENTITY, GOLDEN_MONTH, "Fictional Owner", clock);
  const oct = calculateCompanyEngine(data, locked, "2026-10");
  assert.equal(person(oct, "gold-gm").components.advance ?? 0, 0, "the locked one-off is settled");
  assert.equal(person(oct, "gold-loan").components.advance, 1000, "remaining 2000 after one locked instalment");
});
await check("concern 4: each pair's built answer — percent rates, strict > target, worked days for day rates, actual-day allowance proration", () => {
  // Percent rates: the golden GM share is 0.4 (%) of 4,717,595.50.
  const golden = buildSeptemberGoldenFixture();
  const calc = calculateCompanyEngine(golden.data, golden.doc, GOLDEN_MONTH);
  assert.equal(calc.incentives.find(a => a.ruleId === "gold-gm-share")!.amount, money(4717595.5 * 0.4 / 100));
  // Strict >: a target exactly equal to the base is not met.
  const equal = buildSeptemberGoldenFixture();
  equal.doc.incentives.find(r => r.id === "gold-ops-c-share")!.target = 3724034.38;
  const award = calculateCompanyEngine(equal.data, equal.doc, GOLDEN_MONTH).incentives.find(a => a.ruleId === "gold-ops-c-share")!;
  assert.equal(award.targetMet, false); assert.equal(award.amount, 0);
  // Worked days: a day-rate person is paid for the days worked input, not scheduled days.
  const dayRate = buildSeptemberGoldenFixture();
  Object.assign(dayRate.data.branches["hkt-central"].staff.find(s => s.id === "gold-low")!.payrollProfile!, { workerType: "day-rate", dayRate: 500, monthlySalary: 0 });
  dayRate.doc.months[GOLDEN_MONTH].staff["gold-low"] = { daysWorked: 12, units: {}, kpis: {}, bonuses: {} };
  assert.equal(person(calculateCompanyEngine(dayRate.data, dayRate.doc, GOLDEN_MONTH), "gold-low").components.salary, 6000);
  // Allowances: actual days in the month even when the configured divisor is a fixed 30 (salary uses the divisor).
  const divisor = buildSeptemberGoldenFixture();
  for (const b of Object.values(divisor.data.branches)) b.rulesHistory = b.rulesHistory.map(r => ({ ...r,
    calendarProration: { method: "fixed-divisor", divisor: 30 }, allowances: [{ id: "transport", name: "Transport allowance", amount: 1200, taxable: true, socialSecurity: true }] }));
  Object.assign(divisor.data.branches["hkt-central"].staff.find(s => s.id === "gold-low")!.payrollProfile!, { joinedOn: "2026-09-16" });
  const low = person(calculateCompanyEngine(divisor.data, divisor.doc, GOLDEN_MONTH), "gold-low");
  assert.equal(low.components["fixed:transport"], money(1200 * 15 / 30), "September has 30 days, so check the 31-day case too");
  const oct = buildSeptemberGoldenFixture();
  for (const b of Object.values(oct.data.branches)) b.rulesHistory = b.rulesHistory.map(r => ({ ...r,
    calendarProration: { method: "fixed-divisor", divisor: 30 }, allowances: [{ id: "transport", name: "Transport allowance", amount: 1200, taxable: true, socialSecurity: true }] }));
  oct.doc.runs = {};
  Object.assign(oct.data.branches["hkt-central"].staff.find(s => s.id === "gold-low")!.payrollProfile!, { joinedOn: "2026-10-17" });
  const joiner = person(calculateCompanyEngine(oct.data, oct.doc, "2026-10"), "gold-low");
  assert.equal(joiner.components["fixed:transport"], money(1200 * 15 / 31), "allowance: 15 of 31 actual days");
  assert.equal(joiner.components.salary, money(14000 * 15 / 30), "salary: 15 of the configured 30");
});

// --- 3. The dormant Malaysian world -----------------------------------------
await check("dormant MY: a Malaysian branch in memory runs the MY statutory path and offers MY forms (country from config, not a branch id)", () => {
  const { data, doc } = buildSeptemberGoldenFixture();
  const MY = "fictional-my-branch", ENTITY = "fictional-my-entity";
  const rules = countryRulesTemplate("MY", "2025-01");
  data.payingEntities!.push({ id: ENTITY, name: "Fictional MY Sdn. Bhd.", country: "MY" });
  data.payingAccounts!.push({ id: "fictional-my-account", entityId: ENTITY, label: "Fictional MY payroll", bank: "MAYBANK", accountNumber: "0000000001", accountName: "Fictional MY Sdn. Bhd.", fileFormat: "GENERIC" });
  const template = structuredClone(data.branches["hkt-central"]);
  data.branches[MY] = { ...template, id: MY, staff: [], rulesHistory: [rules],
    detailsHistory: [{ effectiveFrom: "2025-01", details: { ...template.detailsHistory[0].details, name: "Fictional MY branch", country: "MY", currency: "MYR",
      timezone: "Asia/Kuala_Lumpur", payingEntityId: ENTITY, defaultPayingAccountId: "fictional-my-account", legalEntity: "Fictional MY Sdn. Bhd." } }],
    leavePolicyHistory: template.leavePolicyHistory.map(v => ({ ...v, policy: { ...v.policy, country: "MY" as const } })) };
  const source = data.branches["hkt-central"].staff.find(s => s.id === "gold-low")!;
  const staff = structuredClone(source);
  Object.assign(staff, { id: "fictional-my-1", name: "Fictional MY worker", nationality: "Malaysian" });
  Object.assign(staff.payrollProfile!, { monthlySalary: 4000, ssoEligible: false, pnd1Eligible: true, bankDetails: { bank: "MAYBANK", accountNumber: "0000000002", accountName: "Fictional MY worker" },
    allocations: [{ effectiveFrom: "2025-01-01", homeBranchId: MY, lines: [{ costCentre: MY, percent: 100, entityId: ENTITY, payingAccountId: "fictional-my-account" }] }] });
  data.branches[MY].staff.push(staff);
  doc.servicePolicies[MY] = [];
  const my = person(calculateCompanyEngine(data, doc, GOLDEN_MONTH), "fictional-my-1", ENTITY);
  assert.equal(my.currency, "MYR");
  assert.equal(my.components.salary, 4000);
  for (const component of ["my-statutory", "my-employer"]) assert.ok(Number.isFinite(my.components[component]) && my.components[component] > 0, component);
  assert.equal(my.lines.filter(l => l.component === "sso").length, 0, "no Thai SSO on the MY path");
  const codes = listStatutoryOffers(data, MY, GOLDEN_MONTH).map(o => o.code);
  assert.ok(codes.includes("Borang8A"), `MY forms offered: ${codes.join(", ")}`);
  assert.ok(!codes.some(c => c.startsWith("PND")), "no Thai forms on a MY branch");
  assert.ok(listStatutoryOffers(data, "hkt-central", GOLDEN_MONTH).some(o => o.code.startsWith("PND")), "a TH branch still offers Thai forms");
});

// --- 4. Parity with the prototype engine -------------------------------------
type ExpectedLine = { id: string; component: string; label: string; category: string; amount: number; taxable: boolean; ssoWage: boolean; allocations: unknown[] };
type ExpectedPerson = { id: string; entityId: string; gross: number; deductions: number; net: number; employer: number; lines: ExpectedLine[];
  payments: { payingAccountId: string | null; method: string; batch: string; amount: number }[] };
type ExpectedMonth = { month: string; signature: string;
  entities: { entityId: string; totals: Record<string, number>; people: ExpectedPerson[]; exceptions: { id: string; severity: string; kind: string }[] }[];
  service: unknown[]; incentives: unknown[] };
const expected = parityExpected<{ generatedBy: string; months: ExpectedMonth[] }>();
const parityWorld: PayrollWorld = createSeedData();
const CONCERN_1 = (l: { id: string }) => l.id.startsWith("other:deduction:");
let removedLines = 0, comparedLines = 0, comparedPeople = 0;
for (const month of expected.months) await check(`parity ${month.month}: line for line with the prototype engine, except the declared concern-1 lines`, () => {
  const calc = calculateCompanyEngine(parityWorld, parityWorld.companyPayroll!, month.month);
  assert.equal(calc.signature, month.signature, "same world, same source signature");
  assert.deepEqual(JSON.parse(JSON.stringify(calc.service.map(s => ({ branchId: s.branchId, earningMonth: s.earningMonth, pool: s.pool, denominator: s.denominator, paid: s.paid, retained: s.retained,
    people: s.people.map(p => ({ staffId: p.staffId, units: p.units, amount: p.amount, eligible: p.eligible })) })))), month.service);
  assert.deepEqual(JSON.parse(JSON.stringify(calc.incentives.map(a => ({ ruleId: a.ruleId, staffId: a.staffId, amount: a.amount, base: a.base, units: a.units, targetMet: a.targetMet })))), month.incentives);
  assert.deepEqual(calc.entities.map(e => e.entityId), month.entities.map(e => e.entityId));
  for (const want of month.entities) {
    const got = calc.entities.find(e => e.entityId === want.entityId)!;
    assert.deepEqual(got.people.map(p => p.id), want.people.map(p => p.id));
    let entityRemoved = 0;
    for (const wp of want.people) {
      const gp = got.people.find(p => p.id === wp.id)!;
      const removed = wp.lines.filter(CONCERN_1);
      const removedTotal = money(removed.reduce((n, l) => n + l.amount, 0));
      removedLines += removed.length; entityRemoved = money(entityRemoved + removedTotal);
      const kept = wp.lines.filter(l => !CONCERN_1(l));
      assert.deepEqual(JSON.parse(JSON.stringify(gp.lines.map(l => ({ id: l.id, component: l.component, label: l.label, category: l.category, amount: l.amount, taxable: l.taxable, ssoWage: l.ssoWage, allocations: l.allocations })))), kept, `${wp.id} lines`);
      comparedLines += kept.length; comparedPeople += 1;
      assert.equal(gp.gross, wp.gross, `${wp.id} gross`);
      assert.equal(gp.employer, wp.employer, `${wp.id} employer`);
      assert.equal(gp.deductions, money(wp.deductions - removedTotal), `${wp.id} deductions less the concern-1 lines`);
      assert.equal(gp.net, money(wp.net + removedTotal), `${wp.id} net plus the concern-1 lines`);
      assert.equal(money(gp.payments.reduce((n, p) => n + p.amount, 0)), money(wp.payments.reduce((n, p) => n + p.amount, 0) + removedTotal), `${wp.id} payments`);
    }
    assert.equal(got.totals.net, money(want.totals.net + entityRemoved), `${want.entityId} net`);
    assert.equal(got.totals.gross, want.totals.gross, `${want.entityId} gross`);
    assert.deepEqual(got.exceptions.map(e => ({ id: e.id, severity: e.severity, kind: e.kind })), want.exceptions, `${want.entityId} exceptions`);
  }
});
await check("parity: the declared concern-1 difference is real and the only one (32 `other:deduction:*` lines over the two months)", () => {
  assert.equal(removedLines, 32);
  assert.ok(comparedPeople > 100 && comparedLines > 1000, `${comparedPeople} people, ${comparedLines} lines compared`);
});

const ms = Math.round(performance.now() - started);
if (failures.length) {
  console.error(`payroll-engine.check FAILED: ${failures.length} of ${checks + failures.length} checks (${ms} ms)`);
  process.exitCode = 1;
} else {
  console.log(`payroll-engine.check: ${checks} checks passed (${registered.length} ported prototype tests; ${comparedPeople} people and ${comparedLines} lines at parity) in ${ms} ms`);
}
