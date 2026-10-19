// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes once; needs a database whose otoapp schema
// the app's migrator has built (0025 included).
//
// SCRUM-569, the company payroll's R4 (plan §1 "Frozen snapshots" and "The
// source signature on the server", §7 permissions, §9 R4), over HTTP on the
// routes as registered, plus the engine's OT-bank rule on its own:
//   1. the transitions in order — draft, GM confirm, Owner lock, paid, reopen —
//      and every refusal in the prototype's plain words: wrong role (staff,
//      manager, an admin locking), wrong state (lock before confirm, paid
//      before lock, reopen of a draft or without a reason), blocking items
//      (attendance never passes "confirm anyway"; other problems do, and the
//      lock still refuses them), a locked run refusing changes;
//   2. the source signature: a run input changed after GM confirmation, or a
//      different ENGINE_REVISION (an engine deploy between confirm and lock),
//      makes the lock refuse until the GM confirms again;
//   3. the freeze: a locked snapshot, its lines, its files and the run audit
//      refuse UPDATE and DELETE at the database (the trigger), and a reopen
//      leaves version 1 byte for byte as it was, superseded only when
//      version 2 locks; inputs are copied into version 2;
//   4. overtime decisions: stored against the version, Pay or Bank change pay,
//      decided once, refused for a day without overtime; the OT bank credits
//      from LOCKED versions only and from the latest one (engine rule), and a
//      company lock credits nothing (owner ruling, plan open decision 3);
//      a salary advance's later instalments count only what LOCKED months
//      repaid, from the latest locked version (never a draft, never twice);
//   5. payslips: staff see their OWN payslips from LOCKED versions only;
//      another person's or another park group's payslip is a 404; a person
//      not linked to an employee sees none; payroll roles open any payslip
//      and the opening is audited; the same person confirming and locking is
//      recorded as a non-independent review.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/payroll-lifecycle.check.ts
import assert from "node:assert/strict";
import { caller, database, makeEmployee, makeGroup, serve, signIn, stopServers, APP_ENV, type Group, type Role } from "./payroll-harness";
import { fictionalThaiId } from "../server/payroll/engine/upload-common";
import { calculateOtBankBalance, createDefaultOvertimePolicy } from "../server/payroll/engine/ot-bank";
import type { PayrollWorld, RunSnapshot } from "../server/payroll/engine/model";

const { pool, q, count } = database();
const reason = "ZZ TEST SCRUM-569";
const MONTH = "2026-08";
let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };
const okAsync = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ok  ${name}`); };

// ── 4b. The OT bank credits from LOCKED versions only, the latest one (pure engine rule) ──
{
  const day = { id: "p1:2026-08-05", staffId: "p1", branchId: "b1", date: "2026-08-05", overtimeHours: 2, holiday: false, dayOff: false,
    exceptions: [{ kind: "overtime", resolution: null }] };
  const snapshot = (version: number, outcome: "Bank" | "Reject", approval: "locked" | "draft" = "locked") => ({
    branchId: "b1", month: "2026-08", version, approval, lockedAt: "", lockedBy: "", calculations: null, details: {}, incentiveRules: [], deductionRules: [],
    staff: [{ id: "p1", role: "Floor", otEligible: true, monthlySalary: 24000, dayRate: null }],
    rules: { overtimeEligibilityByRole: { Floor: true }, overtimePolicy: { ...createDefaultOvertimePolicy(), handlingMode: "manager-decides" },
      hourlyBase: { monthlySalaryDays: 30, monthlyHoursPerDay: 8, casualDayHours: 8 }, overtimeMultipliers: { regular: 1.5, restDay: 2, publicHoliday: 3 } },
    inputs: { revenue: null, attendance: [day], manualFigures: [], draft: { overtimeDecisions: [{ attendanceId: day.id, exceptionIndex: 0, outcome, reason: "ZZ", resolvedBy: "ZZ", resolvedAt: "" }] } },
  }) as unknown as RunSnapshot;
  const earned = (...snapshots: RunSnapshot[]) => calculateOtBankBalance({ runSnapshots: snapshots, otBankBookings: [], leaveOffboarding: [] } as unknown as PayrollWorld, "b1", "p1", "2026-08-31").earnedHours;
  ok("OT bank: a locked version's Bank decision earns its hours", () => assert.equal(earned(snapshot(1, "Bank")), 2));
  ok("OT bank: an unlocked version earns nothing", () => assert.equal(earned(snapshot(1, "Bank", "draft")), 0));
  ok("OT bank: a reopened and relocked month credits once, from the latest locked version only", () => {
    assert.equal(earned(snapshot(1, "Bank"), snapshot(2, "Bank")), 2, "not 4");
    assert.equal(earned(snapshot(1, "Bank"), snapshot(2, "Reject")), 0, "v2 rejected it: v1's credit is gone");
    assert.equal(earned(snapshot(1, "Bank"), snapshot(2, "Reject", "draft")), 2, "v2 not locked yet: v1 still credits");
  });
}

const groups: Group[] = [];
try {
  const A = await makeGroup(q, "life-a", ["ZZ TEST A Central"]);
  const B = await makeGroup(q, "life-b", ["ZZ TEST B Park"]);
  groups.push(A, B);
  const origin = await serve();
  await signIn(origin, A); await signIn(origin, B);
  const call = caller(origin);
  const as = (g: Group, role: Role) => (method: string, path: string, payload?: unknown) => call(g, role, method, path, payload ?? { reason });
  const must = async (g: Group, role: Role, method: string, path: string, payload?: unknown, status = [200, 201]) => {
    const res = await call(g, role, method, path, payload ?? { reason });
    assert.ok(status.includes(res.status), `${role} ${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  let thaiId = 500;

  // ── Each group: entity, account, branch details, a stream; people linked to accounts ──
  const setupFor = async (g: Group) => {
    const entity = await must(g, "admin", "POST", "/api/payroll/setup/entities", { name: `ZZ ${g.label} Co.`, country: "TH", taxId: "0105500000001", ssoEmployerNumber: "1000000001", defaultPayDay: 28, reason });
    const account = await must(g, "admin", "POST", "/api/payroll/setup/accounts", { entityId: entity.id, label: "ZZ SCB", bank: "SCB", bankCode: "014", accountNumber: "9901000001",
      accountName: "ZZ", fileFormat: "SCB", scbProduct: "PAY", debitAccount: "9901000001", feeAccount: "9901000001", reason });
    await must(g, "admin", "POST", `/api/payroll/setup/branches/${g.branches[0]}/details`, { effectiveFrom: "2025-01-01", foodAllowanceDefault: 60, reason,
      details: { country: "TH", payingEntityId: entity.id, ssoBranchNumber: "830001", payDate: 28, legalEntity: "ZZ", employerNumber: "1000000001", taxId: "0105500000001", address: "ZZ", payrollBank: "SCB" } });
    await must(g, "admin", "POST", "/api/payroll/setup/revenue-streams", { key: "tickets", label: "Tickets", reason });
    await must(g, "admin", "POST", `/api/payroll/setup/rewards/service-policies/${g.branches[0]}`, { month: "2026-07",
      policy: { percent: 3, basis: "worked", excluded: "retain", streams: ["tickets"], addBack: [], roleWeights: {} }, reason });
    // July's sales are entered (none were made): August's service charge has its source and pays nothing.
    await must(g, "admin", "PUT", `/api/payroll/inputs/2026-07/revenue/${g.branches[0]}`, { streams: { tickets: { amount: 0, vat: 0, serviceCharge: 0 } }, discounts: {}, reason });
    return { entity: entity.id as string, account: account.id as string };
  };
  const a = await setupFor(A), b = await setupFor(B);
  const profile = (home: string, entity: string, payingAccountId: string | null, name: string) => ({
    workerType: "monthly", jobTitle: "ZZ TEST Floor", monthlySalary: 24000, dayRate: 0, fixedFee: 0, joinedOn: "2025-01-01", lastWorkingDay: null,
    taxId: fictionalThaiId(++thaiId), ssoNumber: "", ssoTitle: "Mr.", givenName: name, surname: "Test",
    foodAllowanceEligible: false, foodAllowancePerDay: 0, ssoEligible: true, pnd1Eligible: false, serviceChargeEligible: false, otEligible: true,
    pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0, paymentMethod: "bank-transfer", bankDetails: { bank: "SCB", bankCode: "014", accountNumber: `99${String(thaiId).padStart(8, "0")}`, accountName: `ZZ ${name}` },
    thirdPartyReason: "", allocations: [{ effectiveFrom: "2025-01-01", homeBranchId: home, lines: [{ costCentre: home, percent: 100, entityId: entity, payingAccountId }] }],
    studentLoanMonthly: 0, advances: [], separatePayments: [], notes: "",
  });
  // A: X is the staff account's own employee, Y is someone else. Y's stored profile then loses its job
  // title (as a draft or an import could leave it): a blocking profile problem, not an attendance one.
  const X = await makeEmployee(q, A, A.branches[0], "ZZ TEST Xavier", "2025-01-01", [0]);
  const Y = await makeEmployee(q, A, A.branches[0], "ZZ TEST Yara", "2025-01-01", [0]);
  const Z = await makeEmployee(q, B, B.branches[0], "ZZ TEST Zane", "2025-01-01", [0]);
  await q("update employees set user_id = $1 where id = $2", [A.accounts.staff.id, X]);
  await q("update employees set user_id = $1 where id = $2", [B.accounts.staff.id, Z]);
  await must(A, "admin", "PUT", `/api/payroll/profiles/${X}`, { profile: { ...profile(A.branches[0], a.entity, a.account, "Xavier"),
    // A salary advance repaid in instalments: what is still owed is read from LOCKED months only.
    advances: [{ id: "zz-advance", principal: 3000, outstandingBalance: 3000, repaymentMode: "instalments", instalments: 2, monthlyRepayment: 2000, startsOn: "2026-08-01" }] }, revision: 0, reason });
  await must(A, "admin", "PUT", `/api/payroll/profiles/${Y}`, { profile: profile(A.branches[0], a.entity, a.account, "Yara"), revision: 0, reason });
  await q("update payroll_profiles set job_title = '' where tenant_id = $1 and employee_id = $2", [A.tenant, Y]);
  await must(B, "admin", "PUT", `/api/payroll/profiles/${Z}`, { profile: profile(B.branches[0], b.entity, b.account, "Zane"), revision: 0, reason });

  // ── X's August: one rota day with 1.5 h overtime (out 19:30 against 18:00), one unpaired punch ──
  const [group] = await q<{ id: string }>("insert into shift_groups (tenant_id, branch_id, name) values ($1, $2, 'ZZ TEST') returning id", [A.tenant, A.branches[0]]);
  const [week] = await q<{ id: string }>("insert into schedule_week_plans (tenant_id, branch_id, week_start_date) values ($1, $2, '2026-08-03') returning id", [A.tenant, A.branches[0]]);
  const [row] = await q<{ id: string }>(`insert into schedule_shift_rows (tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time)
    values ($1, $2, $3, $4, '09:00', '18:00') returning id`, [A.tenant, A.branches[0], group.id, week.id]);
  await q("insert into schedule_assignments (tenant_id, week_plan_id, shift_row_id, shift_date, employee_id) values ($1, $2, $3, '2026-08-05', $4)", [A.tenant, week.id, row.id, X]);
  const ev = (emp: string, type: string, iso: string) => q("insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time) values ($1, $2, $3, $4, $5)", [A.tenant, emp, A.branches[0], type, iso]);
  await ev(X, "IN", "2026-08-05T02:00:00Z"); await ev(X, "OUT", "2026-08-05T12:30:00Z");
  await ev(X, "IN", "2026-08-06T02:00:00Z");
  const base = `/api/payroll/month-end/${a.entity}/${MONTH}`;
  const bBase = `/api/payroll/month-end/${b.entity}/${MONTH}`;
  const otDay = `${X}:2026-08-05`, missedDay = `${X}:2026-08-06`;

  await okAsync("before a run: confirm, lock, paid and reopen each say the run must start first", async () => {
    for (const [role, path] of [["admin", "confirm"], ["operator_admin", "lock"], ["operator_admin", "paid"], ["operator_admin", "reopen"]] as const) {
      const r = await as(A, role)("POST", `${base}/${path}`);
      assert.deepEqual([r.status, r.body.message], [409, "Start this month's run first."], path);
    }
  });
  await must(A, "admin", "POST", `${base}/run`, { reason });
  await must(B, "admin", "POST", `${bBase}/run`, { reason });

  // ── 1. Role fences in plain words ──
  await okAsync("roles: staff and managers cannot confirm, an admin cannot lock, reopen or mark paid; the words name the key", async () => {
    for (const role of ["staff", "manager"] as const) {
      const r = await as(A, role)("POST", `${base}/confirm`);
      assert.deepEqual([r.status, r.body.message], [403, "GM confirmation is for payroll managers only (payroll.confirm required)."], role);
    }
    for (const path of ["lock", "paid", "reopen"]) {
      const r = await as(A, "admin")("POST", `${base}/${path}`);
      assert.deepEqual([r.status, r.body.message], [403, "Only the Owner can lock, reopen or mark a payroll month paid (payroll.lock required)."], path);
    }
    for (const role of ["staff", "manager"] as const) assert.equal((await as(A, role)("GET", "/api/payroll/history")).status, 403, `${role} history`);
    const anon = await fetch(`${origin}${base}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(anon.status, 401);
  });
  await okAsync("state: lock before confirm, paid before lock and reopen of a draft are refused in the prototype's words", async () => {
    assert.deepEqual(Object.values(await as(A, "operator_admin")("POST", `${base}/lock`)), [409, { message: "GM confirmation is required before Owner lock." }]);
    assert.deepEqual(Object.values(await as(A, "operator_admin")("POST", `${base}/paid`)), [409, { message: "A locked, reconciled company run is required." }]);
    assert.deepEqual(Object.values(await as(A, "operator_admin")("POST", `${base}/reopen`)), [409, { message: "Only locked or paid runs may be reopened." }]);
  });

  // ── 4. Overtime decisions ──
  const preview = async () => (await must(A, "admin", "GET", `${base}/preview`)) as { result: { people: { id: string; gross: number; net: number; lines: { component: string }[] }[]; exceptions: { severity: string; kind: string; message: string }[] }; stale: boolean; signature: string; frozen: boolean; openProblems: number };
  const grossOf = async (id: string) => (await preview()).result.people.find((p) => p.id === id)!.gross;
  await okAsync("overtime: a day without overtime is refused; Bank is refused under a pay-only policy; Pay or Reject, decided once", async () => {
    const none = await as(A, "admin")("PUT", `${base}/overtime/${encodeURIComponent(missedDay)}`, { outcome: "Pay", reason });
    assert.deepEqual([none.status, none.body.message], [404, `Overtime occurrence ${missedDay}:-1 was not found in the selected run. Use -1 only when a positive-hours day has no overtime exception.`]);
    const bad = await as(A, "admin")("PUT", `${base}/overtime/${encodeURIComponent(otDay)}`, { outcome: "Maybe", reason });
    assert.deepEqual([bad.status, bad.body.message], [400, "Choose Pay, Bank or Reject."]);
    const undecided = await grossOf(X);
    const bank = await as(A, "admin")("PUT", `${base}/overtime/${encodeURIComponent(otDay)}`, { outcome: "Bank", reason });
    assert.deepEqual([bank.status, bank.body.message], [409, "Bank is not allowed by the pay-only overtime policy."], "the Thai rule set pays overtime only");
    await must(A, "admin", "PUT", `${base}/overtime/${encodeURIComponent(otDay)}`, { outcome: "Reject", reason });
    const banked = await grossOf(X);
    const twice = await as(A, "admin")("PUT", `${base}/overtime/${encodeURIComponent(otDay)}`, { outcome: "Pay", reason });
    assert.equal(twice.status, 409); assert.match(twice.body.message, /already has an outcome\.$/);
    await must(A, "admin", "POST", `${base}/overtime/${encodeURIComponent(otDay)}/remove`, { reason });
    await must(A, "admin", "PUT", `${base}/overtime/${encodeURIComponent(otDay)}`, { outcome: "Pay", reason });
    const paidOt = await grossOf(X);
    assert.ok(paidOt > banked, `Pay (${paidOt}) adds the overtime that Reject (${banked}) leaves unpaid`);
    assert.equal(paidOt, undecided, "an undecided occurrence is paid, as the prototype computes it");
    const stored = await q("select outcome from payroll_run_overtime_decisions where tenant_id = $1", [A.tenant]);
    assert.deepEqual(stored.map((r) => r.outcome), ["Pay"]);
  });

  // ── 1. Blocking items: attendance never passes; other problems pass "confirm anyway" and still stop the lock ──
  await okAsync("blocking: unconfirmed attendance refuses GM confirm, even 'confirm anyway'", async () => {
    for (const confirmAnyway of [false, true]) {
      const r = await as(A, "admin")("POST", `${base}/confirm`, { reason, confirmAnyway });
      assert.equal(r.status, 409); assert.match(r.body.message, /^Resolve \d+ blocking items first: /);
      assert.match(r.body.message, /unconfirmed attendance 2026-08-0[56]/);
    }
  });
  for (const day of [otDay, missedDay]) await must(A, "admin", "PUT", `${base}/attendance/${encodeURIComponent(day)}`, { action: "confirm", reason });
  await okAsync("blocking: a profile problem refuses a plain confirm; 'confirm anyway' records the GM review; the lock still refuses", async () => {
    const plain = await as(A, "admin")("POST", `${base}/confirm`, { reason });
    assert.deepEqual([plain.status, plain.body.message], [409, "Resolve 1 blocking items first: ZZ TEST Yara: Job title is required."]);
    const anyway = await must(A, "admin", "POST", `${base}/confirm`, { reason: "ZZ GM review", confirmAnyway: true });
    assert.equal(anyway.status, "gm-confirmed");
    const again = await must(A, "admin", "POST", `${base}/confirm`, { reason: "ZZ GM review", confirmAnyway: true });
    assert.equal(again.unchanged, true, "confirming an unchanged confirmed run changes nothing");
    const lock = await as(A, "operator_admin")("POST", `${base}/lock`);
    assert.deepEqual([lock.status, lock.body.message], [409, "Resolve blocking exceptions before locking."]);
    const audit = await q<{ action: string; reason: string }>("select action, reason from payroll_run_audit where tenant_id = $1 and action = 'GM confirm'", [A.tenant]);
    assert.equal(audit.length, 1); assert.match(audit[0].reason, /^\d+ problems still open; confirmed anyway\. ZZ GM review$/);
    assert.ok(!audit.some((r) => /simulation|demo/i.test(r.action)), "real words, not the prototype's demo wording");
  });

  // ── 2. The signature: an input change, then an engine revision change ──
  const STALE = "Financial sources changed after GM confirmation. Reconfirm before locking.";
  await okAsync("signature: fixing the input after GM confirmation makes it stale; the lock refuses until the GM confirms again", async () => {
    const view = await must(A, "admin", "GET", `/api/payroll/profiles/${Y}`);
    await must(A, "admin", "PUT", `/api/payroll/profiles/${Y}`, { profile: { ...view.profile, jobTitle: "ZZ TEST Floor" }, revision: view.revision, reason });
    assert.equal((await preview()).stale, true);
    const lock = await as(A, "operator_admin")("POST", `${base}/lock`);
    assert.deepEqual([lock.status, lock.body.message], [409, STALE]);
    await must(A, "admin", "POST", `${base}/confirm`, { reason: "ZZ reconfirm" });
    assert.equal((await preview()).stale, false);
  });
  await okAsync("signature: a run input (a one-off bonus) added while GM confirmed is allowed and makes the confirmation stale", async () => {
    const before = (await preview()).signature;
    await must(A, "admin", "POST", `${base}/manual`, { employeeId: X, kind: "bonus", amount: 500, reason });
    const after = await preview();
    assert.notEqual(after.signature, before); assert.equal(after.stale, true);
    assert.deepEqual(Object.values(await as(A, "operator_admin")("POST", `${base}/lock`)), [409, { message: STALE }]);
    await must(A, "admin", "POST", `${base}/confirm`, { reason: "ZZ reconfirm after the bonus" });
  });
  Object.assign(process.env, APP_ENV);
  const { lockRun, confirmRun } = await import("../server/payroll/lifecycle");
  const appPool = (await import("../server/db")).pool;
  const owner = { userId: A.accounts.operator_admin.id, name: "ZZ TEST owner" };
  await okAsync("signature: a different ENGINE_REVISION between confirm and lock (an engine deploy) refuses the lock; so does a confirmation made under another revision", async () => {
    await assert.rejects(lockRun(A.tenant, owner, a.entity, MONTH, { reason }, { engineRevision: "payroll-engine-next" }), (e: Error & { status?: number }) => e.message === STALE && e.status === 409);
    await confirmRun(A.tenant, { userId: A.accounts.admin.id, name: "ZZ TEST GM" }, a.entity, MONTH, { reason }, { engineRevision: "payroll-engine-next" });
    assert.deepEqual(Object.values(await as(A, "operator_admin")("POST", `${base}/lock`)), [409, { message: STALE }]);
    await must(A, "admin", "POST", `${base}/confirm`, { reason: "ZZ reconfirm on the deployed engine" });
  });

  const advanceIn = async (month: string) => ((await must(A, "admin", "GET", `/api/payroll/month-end/${a.entity}/${month}/preview`)).result.people
    .find((p: { id: string }) => p.id === X).components.advance ?? 0) as number;
  await okAsync("advances: with nothing locked, September deducts the full instalment again (no repayment is counted from a draft)", async () => {
    assert.equal(await advanceIn(MONTH), 2000);
    assert.equal(await advanceIn("2026-09"), 2000);
  });

  // ── 5. Payslips before the lock: none ──
  await okAsync("payslips: nothing is visible before the lock", async () => {
    const mine = await must(A, "staff", "GET", "/api/payroll/me/payslips");
    assert.equal(mine.employee.id, X); assert.deepEqual(mine.payslips, []);
  });

  // ── The lock ──
  const locked = await must(A, "operator_admin", "POST", `${base}/lock`, { reason: "ZZ Owner review" });
  await okAsync("lock: the Owner locks; the snapshot, its lines and one payslip per person are written; locking again changes nothing", async () => {
    assert.equal(locked.status, "locked"); assert.equal(locked.version, 1);
    assert.equal(await count("select count(*) n from payroll_run_snapshots where tenant_id = $1", [A.tenant]), 1);
    assert.ok(await count("select count(*) n from payroll_run_lines where tenant_id = $1", [A.tenant]) > 4);
    assert.equal(await count("select count(*) n from payroll_output_files where tenant_id = $1 and file_group = 'Payslips'", [A.tenant]), 2);
    const again = await must(A, "operator_admin", "POST", `${base}/lock`, { reason });
    assert.equal(again.unchanged, true);
    const [audit] = await q<{ reason: string }>("select reason from payroll_run_audit where tenant_id = $1 and action = 'Owner lock'", [A.tenant]);
    assert.equal(audit.reason, "Independent Owner review and bank/cash reconciliation. Note: ZZ Owner review");
    const p = await preview();
    assert.equal(p.frozen, true, "a locked month shows its frozen snapshot");
  });
  await okAsync("locked: run inputs and the month's inputs refuse changes until the Owner reopens", async () => {
    const r = await as(A, "admin")("POST", `${base}/manual`, { employeeId: X, kind: "bonus", amount: 1, reason });
    assert.deepEqual([r.status, r.body.message], [409, "This run is locked. The Owner must reopen it before changes."]);
    const ot = await as(A, "admin")("POST", `${base}/overtime/${encodeURIComponent(otDay)}/remove`, { reason });
    assert.deepEqual([ot.status, ot.body.message], [409, "This run is locked. The Owner must reopen it before changes."]);
    const confirm = await as(A, "admin")("POST", `${base}/confirm`);
    assert.deepEqual([confirm.status, confirm.body.message], [409, "Reopen the locked run into a new version first."]);
    const sales = await as(A, "admin")("PUT", `/api/payroll/inputs/${MONTH}/revenue/${A.branches[0]}`, { streams: { tickets: { amount: 1, vat: 0, serviceCharge: 0 } }, discounts: {}, reason });
    assert.deepEqual([sales.status, sales.body.message], [409, `The ${MONTH} payroll is locked. Reopen it first.`]);
  });

  // ── 3. The freeze, at the database ──
  await okAsync("freeze: the snapshot, lines, files and run audit refuse UPDATE and DELETE (trigger)", async () => {
    for (const table of ["payroll_run_snapshots", "payroll_run_lines", "payroll_output_files", "payroll_run_audit"]) {
      await assert.rejects(q(`update ${table} set tenant_id = tenant_id where tenant_id = $1`, [A.tenant]), /frozen payroll/, `${table} update`);
      await assert.rejects(q(`delete from ${table} where tenant_id = $1`, [A.tenant]), /frozen payroll/, `${table} delete`);
    }
  });
  await okAsync("OT bank: the company lock with a Pay decision and the owner ruling credit nothing; the feeds say why", async () => {
    const feeds = await must(A, "admin", "GET", `/api/payroll/feeds/${MONTH}`);
    assert.equal(feeds.otBankCreditsFromRuns, false);
    assert.equal(feeds.otBank.find((r: { employeeId: string }) => r.employeeId === X)?.earnedHours ?? 0, 0);
  });

  // ── 5. Payslips: own, locked, private ──
  const files = await q<{ id: string; employee_id: string }>("select id, employee_id from payroll_output_files where tenant_id = $1 and file_group = 'Payslips'", [A.tenant]);
  const xFile = files.find((f) => f.employee_id === X)!.id, yFile = files.find((f) => f.employee_id === Y)!.id;
  const openAs = async (g: Group, role: Role, url: string) => { const r = await fetch(`${origin}${url}`, { headers: { cookie: g.cookies[role] } }); return { status: r.status, text: await r.text(), headers: r.headers }; };
  await okAsync("payslips: staff see their own locked payslip only, served private and sandboxed", async () => {
    const mine = await must(A, "staff", "GET", "/api/payroll/me/payslips");
    assert.deepEqual(mine.payslips.map((p: { fileId: string; version: number; month: string }) => [p.fileId, p.version, p.month]), [[xFile, 1, MONTH]]);
    const own = await openAs(A, "staff", `/api/payroll/me/payslips/${xFile}`);
    assert.equal(own.status, 200); assert.match(own.text, /ZZ TEST Xavier/); assert.ok(!own.text.includes("ZZ TEST Yara"));
    assert.match(own.headers.get("content-security-policy") ?? "", /sandbox/); assert.match(own.headers.get("cache-control") ?? "", /no-store/);
  });
  await okAsync("payslips: another person's payslip (same park group) and another park group's are 404; payroll-role file routes are 403 to staff", async () => {
    assert.equal((await openAs(A, "staff", `/api/payroll/me/payslips/${yFile}`)).status, 404, "cross-person");
    assert.equal((await openAs(B, "staff", `/api/payroll/me/payslips/${xFile}`)).status, 404, "cross-tenant");
    assert.deepEqual((await must(B, "staff", "GET", "/api/payroll/me/payslips")).payslips, []);
    assert.equal((await openAs(A, "staff", `/api/payroll/history/files/${yFile}`)).status, 403);
    assert.equal((await openAs(B, "operator_admin", `/api/payroll/history/files/${xFile}`)).status, 404, "another park group's payroll role");
    const unlinked = await must(A, "manager", "GET", "/api/payroll/me/payslips");
    assert.deepEqual([unlinked.employee, unlinked.payslips], [null, []]);
  });
  await okAsync("payslips: a payroll role opens anyone's payslip and the opening is written to the run audit", async () => {
    const before = await count("select count(*) n from payroll_run_audit where tenant_id = $1 and action = 'Opened a payslip'", [A.tenant]);
    const r = await openAs(A, "admin", `/api/payroll/history/files/${yFile}`);
    assert.equal(r.status, 200); assert.match(r.text, /ZZ TEST Yara/);
    assert.equal(await count("select count(*) n from payroll_run_audit where tenant_id = $1 and action = 'Opened a payslip'", [A.tenant]), before + 1);
  });

  // ── Paid, then reopen ──
  const fingerprint = async () => (await q<{ h: string }>(`select md5(string_agg(s.result::text || s.calculation::text || s.world::text || s.outputs_manifest::text, '' order by s.version)) h
    from payroll_run_snapshots s where s.tenant_id = $1 and s.version = 1`, [A.tenant]))[0].h;
  const v1 = await fingerprint();
  await okAsync("paid: the Owner marks it paid (the frozen files reconcile); again changes nothing", async () => {
    assert.equal((await must(A, "operator_admin", "POST", `${base}/paid`, { reason: "ZZ paid at the bank" })).status, "paid");
    assert.equal((await must(A, "operator_admin", "POST", `${base}/paid`, { reason })).unchanged, true);
    const [audit] = await q<{ reason: string }>("select reason from payroll_run_audit where tenant_id = $1 and action = 'Marked paid'", [A.tenant]);
    assert.match(audit.reason, /^Bank files plus cash reconcile exactly to net pay\./);
  });
  await okAsync("reopen: a reason is required, in the prototype's words", async () => {
    assert.deepEqual(Object.values(await as(A, "operator_admin")("POST", `${base}/reopen`, {})), [409, { message: "Owner actor and reopening reason required." }]);
  });
  await okAsync("reopen: version 2 is a draft with every input copied; version 1 stays paid and frozen; repeating changes nothing", async () => {
    const r = await must(A, "operator_admin", "POST", `${base}/reopen`, { reason: "ZZ correction", fromVersion: 1 });
    assert.deepEqual([r.status, r.version], ["draft", 2]);
    assert.equal((await must(A, "operator_admin", "POST", `${base}/reopen`, { reason: "ZZ correction", fromVersion: 1 })).unchanged, true);
    const versions = await q<{ version: number; status: string }>("select version, status from payroll_run_versions v join payroll_month_runs r on r.id = v.run_id where v.tenant_id = $1 and r.entity_id = $2 order by version", [A.tenant, a.entity]);
    assert.deepEqual(versions.map((v) => [v.version, v.status]), [[1, "paid"], [2, "draft"]]);
    for (const table of ["payroll_run_attendance_reviews", "payroll_run_overtime_decisions", "payroll_run_manual_lines"]) {
      const n = await q<{ version: number; n: string }>(`select v.version, count(*) n from ${table} t join payroll_run_versions v on v.id = t.run_version_id where t.tenant_id = $1 group by v.version order by v.version`, [A.tenant]);
      assert.deepEqual(n.map((x) => Number(x.n)), [Number(n[0].n), Number(n[0].n)], `${table} copied`);
    }
    assert.equal(await fingerprint(), v1, "version 1's snapshot is byte for byte unchanged");
    const mine = await must(A, "staff", "GET", "/api/payroll/me/payslips");
    assert.deepEqual(mine.payslips.map((p: { version: number }) => p.version), [1], "while version 2 is a draft, version 1 is the payslip in force");
  });
  await okAsync("version 2: the same person confirming and locking is recorded as a non-independent review; version 1 is superseded only now", async () => {
    await must(A, "admin", "POST", `${base}/manual`, { employeeId: X, kind: "bonus", amount: 250, reason });
    await must(A, "global_admin", "POST", `${base}/confirm`, { reason: "ZZ GM v2", confirmAnyway: true });
    await must(A, "global_admin", "POST", `${base}/lock`, { reason: "ZZ Owner v2" });
    const [audit] = await q<{ reason: string }>("select reason from payroll_run_audit where tenant_id = $1 and action = 'Owner lock' and version = 2", [A.tenant]);
    assert.equal(audit.reason, "Owner completed both reviews; this is explicitly a non-independent review. Note: ZZ Owner v2");
    const versions = await q<{ status: string }>("select status from payroll_run_versions where tenant_id = $1 order by version", [A.tenant]);
    assert.deepEqual(versions.map((v) => v.status), ["superseded", "locked"]);
    assert.equal(await fingerprint(), v1);
    const mine = await must(A, "staff", "GET", "/api/payroll/me/payslips");
    assert.deepEqual(mine.payslips.map((p: { version: number }) => p.version), [2], "the corrected version replaces version 1 for the employee");
    const history = await must(A, "admin", "GET", "/api/payroll/history");
    assert.deepEqual(history.map((h: { version: number; status: string }) => [h.version, h.status]), [[2, "locked"], [1, "superseded"]]);
  });
  await okAsync("advances: September reads the LOCKED August snapshot — 3,000 owed less 2,000 repaid — once, from the latest locked version", async () => {
    assert.equal(await advanceIn("2026-09"), 1000);
  });
  await okAsync("cross-tenant: park group B reaches none of A's run, history or files (404)", async () => {
    for (const [method, url] of [["GET", base], ["GET", `${base}/preview`], ["POST", `${base}/confirm`], ["POST", `${base}/lock`], ["POST", `${base}/paid`], ["POST", `${base}/reopen`],
      ["PUT", `${base}/overtime/${encodeURIComponent(otDay)}`], ["PUT", `${base}/third-party/${X}`], ["GET", `/api/payroll/history/${a.entity}/${MONTH}/1`]] as const) {
      const r = await call(B, "operator_admin", method, url, { reason, outcome: "Pay" });
      assert.equal(r.status, 404, `${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });
  await appPool.end().catch(() => undefined);
  console.log(`payroll-lifecycle.check: ${passed} checks passed`);
} catch (error) {
  console.error("payroll-lifecycle.check FAILED:", error);
  process.exitCode = 1;
} finally {
  stopServers();
  await pool.end();
}
