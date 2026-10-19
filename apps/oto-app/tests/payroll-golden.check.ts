// SCRUM-566 (Payroll R1) — the September golden example, the payroll build's
// acceptance test (plan §6). The ported engine must reproduce the prototype's
// numbers exactly: its eleven checks, with its tolerance (integer cents ±1 for
// THB, 1e-7 for days and rates, exact text) and exact reconciliation.
//
// Three legs are planned. R1 landed the ENGINE leg: in-memory inputs through
// the ported engine, no database. R3 (SCRUM-568) switches on the SERVICE AND
// HTTP leg for checks 1-9: the fixture entered through the real routes into a
// migrated database, the month computed by the preview route, the same checks
// on its answer (tests/payroll-golden-http.ts). R4 (SCRUM-569) switches on
// checks 10-11 over HTTP and the LIFECYCLE leg: GM confirm, Owner lock, mark
// paid, reopen and a second park group's 404s, with all eleven checks run
// again on what the lock froze — the frozen calculation and the bank files,
// cash list and reports read back as stored bytes.
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
  { leg: "service and HTTP, checks 10-11", round: "R4", on: true },
  { leg: "lifecycle (confirm, lock, paid, reopen, cross-tenant 404)", round: "R4", on: true },
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
    const leg = await runGoldenHttpLeg({ lifecycle: true });
    const { checks: httpChecks } = goldenChecks(leg.calc, leg.outputs, leg.ids);
    let httpAssertions = 0;
    for (const c of httpChecks) {
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
    const life = leg.lifecycle!;
    check("lifecycle: refusals in plain words before and around the lock", () => {
      assert.deepEqual(life.refusals["lock before confirm"], { status: 409, message: "GM confirmation is required before Owner lock." });
      assert.deepEqual(life.refusals["admin locks"], { status: 403, message: "Only the Owner can lock, reopen or mark a payroll month paid (payroll.lock required)." });
      assert.deepEqual(life.refusals["staff confirms"], { status: 403, message: "GM confirmation is for payroll managers only (payroll.confirm required)." });
      assert.deepEqual(life.refusals["manager confirms"], { status: 403, message: "GM confirmation is for payroll managers only (payroll.confirm required)." });
    });
    check("lifecycle: upload details (Thai ID, SSO title, given name) move no number", () => assert.equal(life.previewUnchanged, true));
    check("lifecycle: the GM confirms (admin), the Owner locks (operator_admin); locking again changes nothing", () => {
      assert.equal(life.confirm.status, 200, JSON.stringify(life.confirm.body)); assert.equal(life.confirm.body.status, "gm-confirmed");
      assert.match(life.confirm.body.signature, /^sha256:[0-9a-f]{64}$/);
      assert.equal(life.lock.status, 200, JSON.stringify(life.lock.body)); assert.equal(life.lock.body.status, "locked");
      assert.ok(life.lock.body.lines > 0 && life.lock.body.files > 0);
      assert.equal(life.lockAgain.status, 200); assert.equal(life.lockAgain.body.unchanged, true);
    });
    check("lifecycle: the snapshot's result equals the preview it was confirmed from", () =>
      assert.deepEqual(JSON.parse(JSON.stringify(life.frozenResult)), JSON.parse(JSON.stringify(life.previewBefore))));
    const frozenChecks = goldenChecks(life.frozenCalc, life.frozenOutputs, leg.ids).checks;
    for (const c of frozenChecks) {
      check(`frozen golden ${c.id}: ${c.title} (${c.assertions.length} assertions, stored bytes)`, () =>
        assert.equal(c.pass, true, JSON.stringify(c.assertions.filter(a => !a.pass), null, 2)));
    }
    check("lifecycle: the frozen bank-file CSV bytes plus cash equal net to the satang; every reference SALARY SEP26", () => {
      const result = life.frozenCalc.entities.find((e) => e.entityId === leg.ids.entity)!;
      assert.equal(Math.round((life.bankCsvTotal + life.frozenOutputs.cashAmount) * 100), Math.round(result.totals.net * 100));
      assert.ok(life.bankReferences.length > 0 && life.bankReferences.every((r) => r === "SALARY SEP26"));
    });
    check("lifecycle: exactly one payslip for the GM, served as frozen; opening it is written to the run audit", () => {
      assert.equal(life.gmPayslips, 1);
      assert.equal(life.payslipOpens, 1);
      assert.ok(life.gmPayslipHtml.includes(life.gmName) && life.gmPayslipHtml.includes("82,387.91"), "the GM payslip shows the GM and the golden net");
    });
    check("lifecycle: mark paid passes the reconciliation", () => { assert.equal(life.paid.status, 200, JSON.stringify(life.paid.body)); assert.equal(life.paid.body.status, "paid"); });
    check("lifecycle: reopen makes version 2 a draft; v1 stays frozen and unchanged; repeating the reopen changes nothing", () => {
      assert.equal(life.reopen.status, 200, JSON.stringify(life.reopen.body)); assert.deepEqual([life.reopen.body.status, life.reopen.body.version], ["draft", 2]);
      assert.equal(life.reopenAgain.body.unchanged, true); assert.equal(life.reopenAgain.body.version, 2);
      assert.deepEqual([life.currentVersion, life.currentStatus], [2, "draft"]);
      assert.equal(life.v1Unchanged, true); assert.equal(life.v1Status, "paid", "v1 stays paid until version 2 locks");
    });
    check("lifecycle: another park group gets 404 on every URL of the fixture's run", () =>
      assert.deepEqual(life.crossTenant.filter((u) => u.status !== 404), []));
    console.log(`  HTTP leg: ${httpAssertions} assertions; preview ${leg.previewMs} ms round trip (load ${leg.timing.loadMs} ms in ${leg.timing.queries} queries, calculate ${leg.timing.calculateMs} ms)`);
  }
  for (const leg of LEGS) console.log(`  leg ${leg.leg}: ${leg.on ? leg.round !== "R1" && !http ? "on — runs with --http against the migrated database" : "on" : `off — lands in ${leg.round}`}`);
  console.log(`payroll-golden.check: ${checks} checks passed (11 golden checks, ${assertions} assertions) in ${Math.round(performance.now() - started)} ms`);
} catch (err) {
  console.error("payroll-golden.check FAILED:", err);
  process.exitCode = 1;
}
