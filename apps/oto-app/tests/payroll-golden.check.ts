// SCRUM-566 (Payroll R1) — the September golden example, the payroll build's
// acceptance test (plan §6). The ported engine must reproduce the prototype's
// numbers exactly: its eleven checks, with its tolerance (integer cents ±1 for
// THB, 1e-7 for days and rates, exact text) and exact reconciliation.
//
// Three legs are planned. R1 landed the ENGINE leg: in-memory inputs through
// the ported engine, no database. R3 (SCRUM-568) switches on the SERVICE AND
// HTTP leg for checks 1-9: the fixture entered through the real routes into a
// migrated database, the month computed by the preview route, the same checks
// on its answer (tests/payroll-golden-http.ts). Checks 10-11 over HTTP (R5) and
// the lifecycle leg (R4/R5) join in the rounds named below.
//
// Usage, from apps/oto-app:
//   npx tsx tests/payroll-golden.check.ts          the engine leg (no database)
//   npx tsx tests/payroll-golden.check.ts --http   both legs (DATABASE_URL set, migrated)
// CI runs the first before its database exists and the second after the
// migrations; a switched-on leg must pass wherever it runs.
import assert from "node:assert/strict";
import { calculateCompanyEngine } from "../server/payroll/engine/company-calculations";
import { buildSeptemberGoldenFixture, GOLDEN_ENTITY, GOLDEN_MONTH } from "../server/payroll/diagnostics/september-golden-fixture";
import { evaluateSeptemberGoldenFixture, goldenChecks } from "../server/payroll/diagnostics/september-golden";

/** The golden ratchet: each leg and the round that switches it on. A switched-on leg must pass. */
const LEGS = [
  { leg: "engine (pure, in memory)", round: "R1", on: true },
  { leg: "service and HTTP, checks 1-9", round: "R3", on: true },
  { leg: "service and HTTP, checks 10-11", round: "R5", on: false },
  { leg: "lifecycle (confirm, lock, paid, reopen)", round: "R4/R5", on: false },
] as const;

const started = performance.now();
let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

try {
  const fixture = buildSeptemberGoldenFixture();
  const report = evaluateSeptemberGoldenFixture(fixture);
  assert.equal(report.checks.length, 11, "the golden has eleven checks");
  let assertions = 0;
  for (const c of report.checks) {
    assertions += c.assertions.length;
    check(`golden ${c.id}: ${c.title} (${c.assertions.length} assertions)`, () =>
      assert.equal(c.pass, true, JSON.stringify(c.assertions.filter(a => !a.pass), null, 2)));
  }
  check("the GM's take-home is ฿82,387.91", () =>
    assert.equal(report.checks[0].assertions.find(a => a.label === "GM net")!.actual, 82387.91));
  check("the evaluation is deterministic and leaves the fixture's profiles, inputs and snapshots unchanged", () => {
    const before = JSON.stringify(fixture);
    assert.deepEqual(evaluateSeptemberGoldenFixture(fixture), report);
    assert.equal(JSON.stringify(fixture), before);
  });
  check("a wrong company-engine salary fails the original expected checks (GM salary +1 fails check 1)", () => {
    const changed = structuredClone(fixture);
    changed.data.branches["hkt-central"].staff.find(s => s.id === "gold-gm")!.payrollProfile!.monthlySalary += 1;
    const bad = evaluateSeptemberGoldenFixture(changed);
    assert.equal(bad.pass, false); assert.equal(bad.checks[0].pass, false);
  });
  check("the contractor PND.3 basis is configurable; the default still withholds on service charge too (฿3,077.78)", () => {
    const changed = structuredClone(fixture);
    delete changed.doc.months[GOLDEN_MONTH].staff["gold-chef"].pnd3Basis;
    const chef = calculateCompanyEngine(changed.data, changed.doc, GOLDEN_MONTH).entities.find(e => e.entityId === GOLDEN_ENTITY)!
      .people.find(p => p.id === "gold-chef")!;
    assert.equal(chef.components.pnd3, 3077.78);
    assert.equal(report.checks[7].pass, true);
  });
  const http = process.argv.includes("--http");
  if (http) {
    const { runGoldenHttpLeg } = await import("./payroll-golden-http");
    const leg = await runGoldenHttpLeg();
    const { checks: httpChecks } = goldenChecks(leg.calc, leg.outputs, leg.ids);
    let httpAssertions = 0;
    for (const c of httpChecks.filter((x) => x.id <= 9)) {
      httpAssertions += c.assertions.length;
      check(`HTTP golden ${c.id}: ${c.title} (${c.assertions.length} assertions)`, () =>
        assert.equal(c.pass, true, JSON.stringify(c.assertions.filter(a => !a.pass), null, 2)));
    }
    check("HTTP: the GM's take-home is ฿82,387.91 from the stored rows", () =>
      assert.equal(httpChecks[0].assertions.find(a => a.label === "GM net")!.actual, 82387.91));
    check("HTTP: the stored form is versions + assignments, policies without groups, partMonth never defaulted", () => {
      assert.equal(leg.stored.profiles, 55, "17 people and 38 prior-month leavers (the plan said 15 + 38; the fixture has 17)");
      assert.equal(leg.stored.versions, 5);
      assert.equal(leg.stored.assignments, 11);
      assert.equal(leg.stored.policiesWithGroups, 0);
      assert.equal(leg.stored.partMonthDefaulted, 0);
    });
    for (const c of httpChecks.filter((x) => x.id > 9)) console.log(`  info HTTP golden ${c.id} (switched on in R5): ${c.pass ? "passes" : "not yet"}`);
    console.log(`  HTTP leg: ${httpAssertions} assertions; preview ${leg.previewMs} ms round trip (load ${leg.timing.loadMs} ms in ${leg.timing.queries} queries, calculate ${leg.timing.calculateMs} ms)`);
  }
  for (const leg of LEGS) console.log(`  leg ${leg.leg}: ${leg.on ? leg.round === "R3" && !http ? "on — runs with --http against the migrated database" : "on" : `off — lands in ${leg.round}`}`);
  console.log(`payroll-golden.check: ${checks} checks passed (11 golden checks, ${assertions} assertions) in ${Math.round(performance.now() - started)} ms`);
} catch (err) {
  console.error("payroll-golden.check FAILED:", err);
  process.exitCode = 1;
}
