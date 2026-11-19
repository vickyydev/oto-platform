// seed: its own — the September golden's ZZ TEST park group, entered through
// the real routes (tests/payroll-golden-http.ts), then ZZ TEST former
// employees and their single shifts made here. Not a Playwright file.
//
// SCRUM-1055 — a former employee's single shift reaches company payroll.
//
//   1. Nothing changes for a month without a single shift: the September
//      golden month, computed from the database by the preview route, is
//      identical figure for figure and line for line to the run recorded
//      before this change (tests/fixtures/payroll/single-shift/, recorded on
//      the lane's commit before the payroll change; ids named stably).
//   2. The same month with single shifts: a former employee who left in
//      March is paid one "Single shift" line (the monthly salary ÷ 30 days
//      of September), the worked day's food allowance and SSO through the
//      ordinary path, in the run view's people; a day-rate shift with no
//      clock-in is not paid and its day asks for review; a casual day rate is
//      listed as not paid, with why; the paid shift is not listed; every
//      other person of the golden month is unchanged line for line; the run
//      calculated twice is the same run; the readers that do not pay (the
//      feeds' OT bank, the month inputs, the statutory documents) do not take
//      the former employee. A second invitation on the same day (the same
//      shift made twice) adds no pay: the day is paid once, and the run says
//      so. A contractor's fee is not paid for one shift, and the run's
//      not-paid list says why.
//   3. Changed after the run: a pay way switched after the GM's confirmation
//      makes the run stale and the Owner lock refuses until it is confirmed
//      again; the lock freezes the shift's line, payslip, bank transfer and
//      report row; a change after the lock leaves the locked run as it was,
//      and the invitation refuses an old-contract shift, or a change of pay,
//      in the locked month; the reopened version pays it once, or not at all
//      once it is casual; a shift removed from the schedule is no longer
//      paid, and one the person had clocked for is named in the not-paid list.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/payroll-single-shift.check.ts
//   npx tsx tests/payroll-single-shift.check.ts --record   (writes the baseline; only on the commit before a change)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { projectRun, stableNames } from "./payroll/run-projection";
import { SINGLE_SHIFT_REFUSALS } from "../shared/singleShift";

// The engine's answer depends on the ORDER of the people's ids (the world is
// read in id order and a pool's last cents go by that order), and the golden
// park group's ids are random. Ids made here are random per run but sort in
// the order they are made, so two runs read the same people in the same order
// and compare exactly. (Ids the routes make are not ordered; none of them
// orders the people.)
const runPrefix = crypto.randomBytes(4).toString("hex");
let made = 0;
crypto.randomUUID = (() => `${runPrefix}-0000-4000-8000-${(made++).toString(16).padStart(12, "0")}`) as typeof crypto.randomUUID;
syncBuiltinESMExports();
const { runGoldenHttpLeg } = await import("./payroll-golden-http");
const { caller, database, makeEmployee, serve, signIn, stopServers } = await import("./payroll-harness");
type Group = import("./payroll-harness").Group;
type Calc = import("../server/payroll/engine/company-model").CompanyCalculation;
type Person = import("../server/payroll/engine/company-model").CompanyPerson;

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "payroll", "single-shift", "september-golden-run.json.gz");
const RECORD = process.argv.includes("--record");

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const { pool, q } = database();
try {
  console.log("1. a month without a single shift:");
  const golden = await runGoldenHttpLeg();
  const [{ tenant_id: tenant }] = await q<{ tenant_id: string }>("select tenant_id from payroll_paying_entities where id = $1", [golden.ids.entity]);
  const names = await stableNames(q, tenant);
  const projection = projectRun(golden.calc, names);
  if (RECORD) {
    const recordedOn = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, gzipSync(strToU8(JSON.stringify({ recordedOn, month: golden.calc.month, projection }))));
    console.log(`payroll-single-shift.check: baseline recorded on ${recordedOn}`);
    process.exit(0);
  }
  const baseline = JSON.parse(strFromU8(gunzipSync(new Uint8Array(readFileSync(BASELINE))))) as { recordedOn: string; month: string; projection: unknown };
  // DUMP_PROJECTION=<file> writes both sides, to read a difference whole.
  if (process.env.DUMP_PROJECTION) writeFileSync(process.env.DUMP_PROJECTION, JSON.stringify({ now: projection, then: baseline.projection }, null, 1));
  await check(`the golden month is the run recorded before the change (${baseline.recordedOn.slice(0, 9)}), figure for figure and line for line`, () => {
    assert.equal(golden.calc.month, baseline.month);
    assert.deepEqual(projection, baseline.projection);
  });

  // ── The golden park group again, to put single shifts in its month ──
  const MONTH = golden.calc.month; // 2026-09: 30 days
  const users = await q<{ id: string; email: string; role: string }>(
    "select u.id, u.email, u.role from users u join user_branch_access a on a.user_id = u.id where a.tenant_id = $1", [tenant]);
  const branchRows = await q<{ id: string; name: string }>("select id, name from branches where tenant_id = $1 order by name", [tenant]);
  const central = branchRows.find((b) => b.name.startsWith("ZZ TEST Central"))!.id;
  const g: Group = { label: "golden", tenant, branches: branchRows.map((b) => b.id), cookies: {} as Group["cookies"],
    accounts: Object.fromEntries(users.map((u) => [u.role, { id: u.id, email: u.email }])) as Group["accounts"] };
  const origin = await serve();
  await signIn(origin, g);
  const call = caller(origin);
  const ok = async (role: "admin" | "operator_admin", method: string, path: string, payload?: unknown) => {
    const res = await call(g, role, method, path, payload);
    if (res.status !== 200 && res.status !== 201) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const reason = "ZZ TEST SCRUM-1055 single shift";
  const base = `/api/payroll/month-end/${golden.ids.entity}/${MONTH}`;

  // Two ZZ TEST former employees (left in March) with payroll profiles made through the route, on the golden's own terms.
  const template = (await ok("admin", "GET", `/api/payroll/profiles/${golden.ids.staff("gold-regular-c")}`)).profile;
  async function former(name: string, terms: Record<string, unknown>) {
    const id = await makeEmployee(q, g, central, name, "2025-01-01");
    await q("update employees set status = 'resigned', employment_state = 'LEFT', last_working_day = '2026-03-31T00:00:00Z' where id = $1", [id]);
    const profile = { ...template, joinedOn: "2025-01-01", lastWorkingDay: "2026-03-31", jobTitle: "ZZ TEST former", advances: [], separatePayments: [], studentLoanMonthly: 0,
      bankDetails: { ...template.bankDetails, accountNumber: `ZZ-1055-${name.slice(-1)}`, accountName: name }, ...terms };
    await ok("admin", "PUT", `/api/payroll/profiles/${id}`, { profile, revision: 0, reason });
    return id;
  }
  const monthly = await former("ZZ TEST Former A", { workerType: "monthly", monthlySalary: 15000, dayRate: 0, ssoEligible: true, pnd1Eligible: true, foodAllowanceEligible: true, foodAllowancePerDay: 60 });
  const dayRate = await former("ZZ TEST Former B", { workerType: "day-rate", monthlySalary: 0, dayRate: 700, ssoEligible: false, pnd1Eligible: true, foodAllowanceEligible: true, foodAllowancePerDay: 60 });
  const [group] = await q<{ id: string }>("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, 'ZZ TEST 1055') returning id", [crypto.randomUUID(), tenant, central]);
  const [row] = await q<{ id: string }>(`insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, label, start_time, end_time)
    values ($1, $2, $3, $4, 'ZZ TEST 1055 day', '10:00', '19:00') returning id`, [crypto.randomUUID(), tenant, central, group.id]);
  const monday = (day: string) => { const at = Date.parse(`${day}T00:00:00Z`), d = new Date(at).getUTCDay(); return new Date(at + (d === 0 ? -6 : 1 - d) * 86_400_000).toISOString().slice(0, 10); };
  /** A single shift as the invitation route makes it: the assignment and its invitation (the route refuses a past day). */
  async function singleShift(employeeId: string, day: string, way: "old_contract" | "casual_day_rate" = "old_contract", rate: number | null = null) {
    const [plan] = await q<{ id: string }>("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4) returning id", [crypto.randomUUID(), tenant, central, monday(day)]);
    const [assignment] = await q<{ id: string }>(`insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, employee_id)
      values ($1, $2, $3, $4, $5, 'employee', $6) returning id`, [crypto.randomUUID(), tenant, plan.id, row.id, day, employeeId]);
    const [invitation] = await q<{ id: string }>(`insert into single_shift_invitations (tenant_id, employee_id, branch_id, assignment_id, shift_row_id, shift_date, pay_basis, casual_day_rate)
      values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [tenant, employeeId, central, assignment.id, row.id, day, way, rate]);
    return { assignment: assignment.id, invitation: invitation.id };
  }
  const clock = async (employeeId: string, day: string) => {
    for (const [type, at] of [["IN", `${day}T10:00:00+07:00`], ["OUT", `${day}T19:00:00+07:00`]]) {
      await q("insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time) values ($1, $2, $3, $4, $5)", [tenant, employeeId, central, type, new Date(at)]);
    }
  };
  const shiftA = await singleShift(monthly, `${MONTH}-17`);
  await clock(monthly, `${MONTH}-17`);
  const casualA = await singleShift(monthly, `${MONTH}-24`, "casual_day_rate", 1200);
  const shiftB = await singleShift(dayRate, `${MONTH}-10`);
  void casualA;

  console.log("2. the same month with single shifts:");
  const preview = async () => (await ok("admin", "GET", `${base}/preview`)) as { calculation: Calc; result: { people: Person[] }; excluded: { employeeId: string; reason: string }[]; stale: boolean; frozen: boolean };
  const first = await preview();
  const personOf = (calc: Calc, id: string) => calc.entities.flatMap((e) => e.people).find((p) => p.id === id);
  await check("the former employee is paid one Single shift line: 15,000 ÷ 30 days of September, taxed and an SSO wage", () => {
    const a = personOf(first.calculation, monthly)!;
    const line = a.lines.find((l) => l.id === `single-shift:${shiftA.invitation}`)!;
    assert.deepEqual([line.label, line.component, line.amount, line.taxable, line.ssoWage], ["Single shift", "single-shift", 500, true, true]);
    assert.equal(a.lines.filter((l) => l.component === "single-shift").length, 1, "one line, for the old-contract invitation only");
    assert.ok(first.result.people.some((p) => p.id === monthly), "in the run view's people");
  });
  await check("the worked day's food allowance, and SSO and PND.1 through the ordinary path on the month's earnings", () => {
    const a = personOf(first.calculation, monthly)!;
    assert.equal(a.lines.find((l) => l.id === `single-shift-food:${shiftA.invitation}`)!.amount, 60);
    assert.equal(a.lines.find((l) => l.id === "sso")!.amount, 25, "5% of the 500 SSO wage");
    assert.match(a.lines.find((l) => l.id === "pnd1")!.formula, /Cumulative withholding/);
    assert.equal(a.gross, 560);
  });
  await check("a day-rate shift with no clock-in is not paid, and its day waits for review", () => {
    assert.equal(personOf(first.calculation, dayRate), undefined);
    assert.ok(first.calculation.exceptions.some((e) => e.kind === "attendance" && e.staffId === dayRate && e.severity === "blocking"), "the no-show day is a blocking review item");
  });
  await check("the casual day rate is listed as not paid, with why; the paid shift is not listed", () => {
    const listed = first.excluded.filter((x) => x.employeeId === monthly);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.reason, `Single shift on ${MONTH}-24 (casual day rate ฿1,200 a day) is not paid by this run: company payroll has no pay for casual workers, who are outside it.`);
    assert.ok(!listed[0]!.reason.includes(`${MONTH}-17`));
    assert.ok(!first.excluded.some((x) => x.employeeId === dayRate), "an old-contract shift is never listed as not taken");
  });
  await check("every person of the golden month is unchanged, line for line; the run calculated twice is the same run", async () => {
    const now = projectRun(first.calculation, await stableNames(q, tenant)) as { entities: { people: { id: string }[] }[] };
    const was = baseline.projection as { entities: { people: { id: string }[] }[] };
    const others = now.entities[0]!.people.filter((p) => !p.id.startsWith("person:ZZ TEST Former"));
    assert.deepEqual(others, was.entities[0]!.people);
    assert.deepEqual((now as unknown as { service: unknown }).service, (was as unknown as { service: unknown }).service);
    assert.deepEqual((await preview()).calculation, first.calculation);
  });
  await check("the readers that do not pay do not take the former employee: the feeds' OT bank, the month inputs, the statutory documents", async () => {
    const feeds = await ok("admin", "GET", `/api/payroll/feeds/${MONTH}`);
    assert.ok(!(feeds.otBank as { employeeId: string }[]).some((o) => o.employeeId === monthly), "not an employee of the month for the OT bank");
    const refused = await call(g, "admin", "POST", `/api/payroll/inputs/${MONTH}/override`, { key: `days:${monthly}`, value: 1, reason });
    assert.notEqual(refused.status, 200, "no days-worked figure for a former employee");
    // The statutory documents name nobody until a per-branch run exists, so their reader is held by its load:
    // only the pay readers ask for single shifts.
    const source = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "server", "payroll", file), "utf8");
    assert.ok(source("statutory.ts").includes("({ world } = await loadPayrollWorld(tenantId, month));"), "the statutory documents load the month without single shifts");
    for (const file of ["feeds.ts", "inputs.ts", "statutory.ts"]) assert.ok(!source(file).includes("PAY_READER"), file);
    for (const file of ["month-end.ts", "lifecycle.ts"]) assert.ok(source(file).includes("PAY_READER"), file);
  });

  await check("the same shift made twice: one Single shift line, one food allowance, the same gross; the run names the second as already paid", async () => {
    const twice = await singleShift(monthly, `${MONTH}-17`);
    const again = await preview();
    const a = personOf(again.calculation, monthly)!;
    assert.deepEqual(a.lines.filter((l) => l.component === "single-shift").map((l) => [l.id, l.amount]), [[`single-shift:${shiftA.invitation}`, 500]]);
    assert.equal(a.lines.filter((l) => l.component === "food").length, 1);
    assert.equal(a.gross, 560);
    assert.ok(again.calculation.exceptions.some((e) => e.kind === "single-shift" && e.staffId === monthly && e.message.includes(`a second single shift on ${MONTH}-17; the day is paid once`)));
    await q("delete from single_shift_invitations where id = $1", [twice.invitation]);
    await q("delete from schedule_assignments where id = $1", [twice.assignment]);
    assert.deepEqual((await preview()).calculation.entities, first.calculation.entities, "taken away again, the run is as it was");
  });
  await check("a contractor's fixed fee is not paid for one shift: listed as not paid, with why", async () => {
    const contractor = await former("ZZ TEST Former C", { workerType: "contractor", monthlySalary: 0, dayRate: 0, fixedFee: 30000, ssoEligible: false, pnd1Eligible: false, foodAllowanceEligible: false });
    const made = await singleShift(contractor, `${MONTH}-18`);
    await clock(contractor, `${MONTH}-18`);
    const withIt = await preview();
    assert.equal(personOf(withIt.calculation, contractor), undefined);
    assert.ok(withIt.excluded.some((x) => x.employeeId === contractor && x.reason === `Single shift on ${MONTH}-18 (on the old contract) is not paid by this run: the old contract is a contractor's fixed fee, and how one shift of a fee is paid is not decided.`), JSON.stringify(withIt.excluded));
    // Taken away again (its shift, clock and invitation), so the month goes on as the rest of this check expects.
    await q("delete from single_shift_invitations where id = $1", [made.invitation]);
    await q("delete from schedule_assignments where id = $1", [made.assignment]);
    await q("delete from time_events where employee_id = $1", [contractor]);
    const after = await preview();
    assert.ok(!after.excluded.some((x) => x.employeeId === contractor && x.reason.includes("Single shift")));
    assert.deepEqual(after.calculation.entities, first.calculation.entities, "nobody's pay moved");
  });

  console.log("3. changed after the run:");
  // Lock needs every person's upload details, as the golden's lifecycle leg gives them (no number moves).
  const { fictionalThaiId } = await import("../server/payroll/engine/upload-common");
  const everyone = await q<{ employee_id: string; full_name: string }>(
    "select p.employee_id, e.full_name from payroll_profiles p join employees e on e.id = p.employee_id where p.tenant_id = $1 order by p.employee_id", [tenant]);
  let n = 0;
  for (const person of everyone) {
    const view = await ok("admin", "GET", `/api/payroll/profiles/${person.employee_id}`);
    const profile = { ...view.profile, taxId: fictionalThaiId(++n), ssoTitle: "Mr.", givenName: person.full_name.split(" ")[0] || "ZZ", surname: "Test",
      bankDetails: { ...view.profile.bankDetails, accountNumber: `991${String(n).padStart(7, "0")}` } };
    await ok("admin", "PUT", `/api/payroll/profiles/${person.employee_id}`, { profile, revision: view.revision, reason });
  }
  const dayKey = (await preview()).calculation.exceptions.find((e) => e.kind === "attendance" && e.staffId === dayRate)!.id.replace(/^attendance-/, "");
  await ok("admin", "PUT", `${base}/attendance/${encodeURIComponent(dayKey)}`, { action: "excuse", reason: "ZZ TEST did not come" });
  await ok("admin", "POST", `${base}/confirm`, { reason: "ZZ TEST GM review", confirmAnyway: true });
  const setWay = (way: string, rate: number | null) => q("update single_shift_invitations set pay_basis = $2, casual_day_rate = $3 where id = $1", [shiftA.invitation, way, rate]);
  await check("the pay way switched after the GM's confirmation makes the run stale, and the Owner lock refuses", async () => {
    await setWay("casual_day_rate", 900);
    assert.equal((await preview()).stale, true);
    const lock = await call(g, "operator_admin", "POST", `${base}/lock`, { reason: "ZZ TEST Owner review" });
    assert.equal(lock.status, 409, JSON.stringify(lock.body));
    await setWay("old_contract", null);
    assert.equal((await preview()).stale, false, "switched back, the confirmed source is the same again");
  });
  let locked: { snapshotId: string };
  await check("the lock freezes the shift's line, its payslip, its bank transfer and its report row", async () => {
    locked = await ok("operator_admin", "POST", `${base}/lock`, { reason: "ZZ TEST Owner review" });
    const [line] = await q<{ label: string; amount: string }>("select label, amount from payroll_run_lines where snapshot_id = $1 and employee_id = $2 and component = 'single-shift'", [locked.snapshotId, monthly]);
    assert.deepEqual([line?.label, Number(line?.amount)], ["Single shift", 500]);
    const files = await q<{ file_group: string; employee_id: string | null; content: string; encoding: "utf8" | "base64"; filename: string }>(
      "select file_group, employee_id, content, encoding, filename from payroll_output_files where snapshot_id = $1", [locked.snapshotId]);
    const text = (f: (typeof files)[number]) => Buffer.from(f.content, f.encoding).toString("utf8");
    const slip = files.find((f) => f.file_group === "Payslips" && f.employee_id === monthly)!;
    assert.match(text(slip), /Single shift/);
    const frozen = await preview();
    const net = personOf(frozen.calculation, monthly)!.net;
    assert.ok(frozen.calculation.entities[0]!.payments.some((p) => p.staffId === monthly && p.amount === net && p.method === "bank-transfer"), "a bank transfer of the net");
    const summary = files.find((f) => f.filename.endsWith("branch-summary.csv"))!;
    assert.match(text(summary), /ZZ TEST Former A/);
  });
  await check("in the locked month the invitation routes refuse an old-contract shift and a change of pay, with nothing written", async () => {
    // The routes on a clock set to a day of the month before its shifts (the routes refuse a past day).
    const during = await serve({ HARNESS_FAKE_NOW: `${MONTH}-05T03:00:00.000Z` });
    const gDuring: Group = { ...g, cookies: {} as Group["cookies"] };
    await signIn(during, gDuring);
    const callDuring = caller(during);
    const before = await q("select id, pay_basis, casual_day_rate from single_shift_invitations where tenant_id = $1 order by id", [tenant]);
    const assignments = await q("select id from schedule_assignments where tenant_id = $1 order by id", [tenant]);
    const made = await callDuring(gDuring, "admin", "POST", "/api/schedule/single-shift/invitations", { employeeId: monthly, shiftRowId: row.id, shiftDate: `${MONTH}-20` });
    assert.deepEqual([made.status, made.body.reasonCode, made.body.message], [409, "PAYROLL_LOCKED", SINGLE_SHIFT_REFUSALS.payrollLocked], JSON.stringify(made.body));
    const changed = await callDuring(gDuring, "admin", "PATCH", `/api/schedule/single-shift/invitations/${shiftA.invitation}`, { payWay: "casual_day_rate", casualDayRate: 900 });
    assert.deepEqual([changed.status, changed.body.reasonCode], [409, "PAYROLL_LOCKED"], JSON.stringify(changed.body));
    assert.deepEqual(await q("select id, pay_basis, casual_day_rate from single_shift_invitations where tenant_id = $1 order by id", [tenant]), before);
    assert.deepEqual(await q("select id from schedule_assignments where tenant_id = $1 order by id", [tenant]), assignments);
  });
  await check("a change after the lock leaves the locked run as it was", async () => {
    await setWay("casual_day_rate", 900);
    const frozen = await preview();
    assert.equal(frozen.frozen, true);
    assert.equal(personOf(frozen.calculation, monthly)!.lines.find((l) => l.component === "single-shift")!.amount, 500);
  });
  await check("the reopened version pays the shift once, or not at all once it is casual; a removed shift is not paid, and one clocked for is named", async () => {
    await ok("operator_admin", "POST", `${base}/reopen`, { reason: "ZZ TEST correction", fromVersion: 1 });
    const casual = await preview();
    assert.equal(personOf(casual.calculation, monthly), undefined, "on a casual day rate it is not paid by this run");
    assert.ok(casual.excluded.some((x) => x.employeeId === monthly && x.reason.includes(`${MONTH}-17 (casual day rate ฿900 a day)`)));
    await setWay("old_contract", null);
    const again = await preview();
    assert.equal(personOf(again.calculation, monthly)!.lines.filter((l) => l.component === "single-shift").length, 1, "once, in this version");
    // SCRUM-1055: shiftA was clocked 10:00 to 19:00; shiftB never was.
    await q("delete from schedule_assignments where id = $1", [shiftA.assignment]);
    await q("delete from schedule_assignments where id = $1", [shiftB.assignment]);
    const removed = await preview();
    assert.equal(personOf(removed.calculation, monthly), undefined, "a shift taken off the schedule is not paid");
    const named = removed.excluded.filter((x) => x.employeeId === monthly);
    assert.equal(named.length, 1);
    assert.ok(named[0]!.reason.includes(`Single shift on ${MONTH}-17 (on the old contract) is not paid by this run: it was taken off the schedule, but the person has a clock record that day.`), named[0]!.reason);
    assert.ok(!removed.excluded.some((x) => x.employeeId === dayRate), "a removed shift never clocked for is not named");
  });

  console.log(`payroll-single-shift.check: ${checks} checks passed`);
} catch (err) {
  console.error("payroll-single-shift.check FAILED:", err);
  process.exitCode = 1;
} finally {
  stopServers();
  await pool.end();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
