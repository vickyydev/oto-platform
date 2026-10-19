// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes once; needs a database whose otoapp schema
// the app's migrator has built.
//
// SCRUM-568, the company payroll's R3 (plan §3, §9 R3), over HTTP on the
// routes as registered and on the feed's pure builder:
//   1. every new route is fenced: manager and staff refused (403), anonymous
//      401, another park group's ids answer 404 and write nothing, and a
//      park group's lists never show another's rows;
//   2. the attendance adapter: a punch is a worked day, a rejected claim is
//      not, an approved correction's clocks win, a pending one is an open
//      exception, overnight sessions stay one day, holidays, days off, the
//      roster branch, lateness, no-shows and overtime;
//   3. run corrections and excuses are stored against the run version and
//      NEVER touch time_events, time_entries or timekeeping_issues;
//   4. the loader's seams: company rules and branch exceptions flattened into
//      rulesHistory, deduction lists picked by date, the leave policy built
//      from the live SCRUM-560 catalogue (unpaid leave valued and paid as a
//      negative line), people who cannot be placed listed, a fixed number of
//      queries whatever the head count;
//   5. month inputs, rewards and feeds keep the prototype's words: unknown
//      streams, days above employment, an OT booking against an empty bank
//      (owner ruling: runs do not credit it) are refused;
//   6. the preview of a realistic park (60 people, two months of punches)
//      is timed server-side against the plan's ~2 s budget.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/payroll-feeds.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { caller, database, makeEmployee, makeGroup, serve, signIn, stopServers, APP_ENV, type Group } from "./payroll-harness";
import { buildAttendanceDays, type AttendanceSources } from "../server/payroll/attendance";
import { deductionRulesFor, flattenRulesHistory, leavePolicyFromCatalogue, engineFrom } from "../server/payroll/world";
import { countryRulesTemplate } from "../server/payroll/engine/defaults";
import { rulebookThaiDeductionRules } from "../shared/payroll-config";
import type { DeductionRule, StatutoryRules } from "../server/payroll/engine/model";

const { pool, q, count } = database();
const reason = "ZZ TEST SCRUM-568";
let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };
const okAsync = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ok  ${name}`); };

// ── 2. The attendance adapter, pure ─────────────────────────────────────────
{
  const at = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);
  const tz = new Map([["b1", "Asia/Bangkok"], ["b2", "Asia/Bangkok"]]);
  const window = { from: "2026-09-01", to: "2026-10-31", today: "2026-10-20", timezones: tz, defaultTimezone: "Asia/Bangkok" };
  const people = [{ id: "p1", rosterBranchId: "b1", weeklyOffDays: [0] }];
  const empty: AttendanceSources = { events: [], entries: [], issues: [], assignments: [], holidays: [], timeOff: [] };
  const ev = (date: string, inT: string, outT: string | null, branchId = "b1") => [
    { employeeId: "p1", branchId, eventType: "IN", eventTime: at(date, inT) },
    ...(outT ? [{ employeeId: "p1", branchId, eventType: "OUT", eventTime: at(outT < inT ? nextDay(date) : date, outT) }] : []),
  ];
  const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const build = (s: Partial<AttendanceSources>) => buildAttendanceDays(people, { ...empty, ...s }, window);

  ok("a punch pair is a worked day: actual = effective, branch-local HH:mm", () => {
    const [d] = build({ events: ev("2026-10-05", "09:02", "18:00") });
    assert.deepEqual([d.id, d.date, d.actualClockIn, d.actualClockOut, d.effectiveClockIn, d.effectiveClockOut, d.exceptions.length], ["p1:2026-10-05", "2026-10-05", "09:02", "18:00", "09:02", "18:00", 0]);
  });
  ok("the roster branch is stamped; where they clocked is kept beside it", () => {
    const [d] = build({ events: ev("2026-10-05", "09:00", "18:00", "b2") });
    assert.deepEqual([d.branchId, d.workedAtBranchId], ["b1", "b2"]);
  });
  ok("an overnight session stays on the date it started", () => {
    const days = build({ events: ev("2026-10-05", "20:00", "02:00") });
    assert.deepEqual(days.map((d) => [d.date, d.actualClockIn, d.actualClockOut]), [["2026-10-05", "20:00", "02:00"]]);
  });
  const entry = (status: string, inT: string | null, outT: string | null) => ({ id: randomUUID(), employeeId: "p1", branchId: "b1", shiftDate: "2026-10-06",
    clockInAt: inT ? at("2026-10-06", inT) : null, clockOutAt: outT ? at("2026-10-06", outT) : null, status, updatedAt: new Date("2026-10-07T00:00:00Z") });
  const issue = (type: string, status: string) => ({ id: randomUUID(), employeeId: "p1", branchId: "b1", issueDate: "2026-10-06", issueType: type, status, resolutionNote: null, createdAt: new Date("2026-10-06T12:00:00Z") });
  ok("an APPROVED correction's clocks are the effective clocks; the issue is resolved (Corrected)", () => {
    const [d] = build({ events: ev("2026-10-06", "10:30", "18:00"), entries: [entry("APPROVED", "09:00", "18:00")], issues: [issue("MISSING_CLOCK_IN", "RESOLVED")] });
    assert.deepEqual([d.actualClockIn, d.effectiveClockIn, d.exceptions[0].kind, d.exceptions[0].resolution], ["10:30", "09:00", "missed-punch", "Corrected"]);
  });
  ok("a PENDING claim has no effective clock and an open (unresolved) exception", () => {
    const [d] = build({ events: ev("2026-10-06", "09:00", "18:00"), entries: [entry("PENDING_APPROVAL", "09:00", "18:00")], issues: [issue("UNSCHEDULED_WORK", "OPEN")] });
    assert.deepEqual([d.effectiveClockIn, d.actualClockIn, d.exceptions.map((e) => e.resolution)], [null, "09:00", [null]]);
  });
  ok("a REJECTED claim leaves the day with no clock at all, so it is not worked", () => {
    const [d] = build({ events: ev("2026-10-06", "09:00", "18:00"), entries: [entry("REJECTED", "09:00", "18:00")], issues: [issue("UNSCHEDULED_WORK", "REJECTED")] });
    assert.deepEqual([d.actualClockIn, d.effectiveClockIn, d.exceptions[0].resolution], [null, null, "Corrected"]);
  });
  ok("holiday and weekly day off are flagged", () => {
    const [d] = build({ events: ev("2026-10-04", "09:00", "17:00"), holidays: ["2026-10-04"] });
    assert.deepEqual([d.holiday, d.dayOff], [true, true]); // 2026-10-04 is a Sunday
  });
  ok("rota: late with minutes, overtime hours after the rota end, an overtime exception", () => {
    const [d] = build({ events: ev("2026-10-07", "09:20", "19:30"), assignments: [{ employeeId: "p1", shiftDate: "2026-10-07", startTime: "09:00:00", endTime: "18:00:00" }] });
    assert.deepEqual([d.scheduled, d.plannedClockIn, d.plannedClockOut, d.overtimeHours], [true, "09:00", "18:00", 1.5]);
    assert.deepEqual(d.exceptions.map((e) => [e.kind, e.resolution, e.minutes ?? null]), [["late", null, 20], ["overtime", null, null]]);
  });
  ok("a rostered past day with no clock and no time off is a no-show; with time off it is not", () => {
    const shift = [{ employeeId: "p1", shiftDate: "2026-10-08", startTime: "09:00:00", endTime: "18:00:00" }];
    assert.deepEqual(build({ assignments: shift })[0].exceptions.map((e) => e.kind), ["no-show"]);
    assert.deepEqual(build({ assignments: shift, timeOff: [{ employeeId: "p1", startDate: new Date("2026-10-08T00:00:00Z"), endDate: new Date("2026-10-08T00:00:00Z") }] })[0].exceptions, []);
  });
  ok("an unpaired punch in the past is a missed punch", () => {
    assert.deepEqual(build({ events: ev("2026-10-09", "09:00", null) })[0].exceptions.map((e) => e.kind), ["missed-punch"]);
  });
}

// ── 4. The loader's seams, pure ─────────────────────────────────────────────
{
  const rule = (from: string, cap: number): StatutoryRules => ({ ...countryRulesTemplate("TH", from), thSso: { ...countryRulesTemplate("TH").thSso, wageCap: cap } });
  const rows = [
    { branchId: null, country: "TH", effectiveFrom: "2025-01-01", rules: rule("2025-01", 15000) },
    { branchId: null, country: "TH", effectiveFrom: "2026-01-01", rules: rule("2026-01", 17500) },
    { branchId: null, country: "TH", effectiveFrom: "2026-10-01", rules: rule("2026-10", 20000) },
    { branchId: "b2", country: "TH", effectiveFrom: "2026-06-01", rules: rule("2026-06", 16000) },
  ];
  ok("seam 1: a branch without exceptions follows every company version", () => {
    assert.deepEqual(flattenRulesHistory("TH", rows, "b1").map((r) => [r.effectiveFrom, r.thSso.wageCap]), [["2025-01", 15000], ["2026-01", 17500], ["2026-10", 20000]]);
  });
  ok("seam 1: a branch exception takes over from its first date; later company versions no longer reach it", () => {
    assert.deepEqual(flattenRulesHistory("TH", rows, "b2").map((r) => [r.effectiveFrom, r.thSso.wageCap]), [["2025-01", 15000], ["2026-01", 17500], ["2026-06", 16000]]);
  });
  const late: DeductionRule = { id: "late", name: "Late", enabled: true, issue: "late", freeOccurrences: 3, freeMinutes: 30, method: "fixed", amount: 100, source: "service-charge", cap: 1000, roles: [], includeStaffIds: [], excludeStaffIds: [] };
  ok("seam 1: deduction lists — the branch's list effective by the 1st, else the company's, else none", () => {
    const lists = [{ branchId: null, effectiveFrom: "2026-09-01", rules: [late] }, { branchId: "b2", effectiveFrom: "2026-10-15", rules: [] }];
    assert.equal(deductionRulesFor(lists, "b1", "2026-09").length, 1);
    assert.equal(deductionRulesFor(lists, "b2", "2026-10").length, 1, "a branch list starting mid-October applies from November");
    assert.equal(deductionRulesFor(lists, "b2", "2026-11").length, 0);
    assert.equal(deductionRulesFor(lists, "b1", "2026-08").length, 0);
  });
  ok("seam 2: the leave policy is SCRUM-560's catalogue — UNPAID is the one unpaid type", () => {
    const policy = leavePolicyFromCatalogue("TH", [
      { code: "ANNUAL", name: "Annual", isActive: true, accrualMethod: "YEARLY", annualDays: 6, waitingMonths: 4, daysWorkedRequired: 0, daysOffEarned: 0 },
      { code: "UNPAID", name: "Unpaid", isActive: true, accrualMethod: "NONE", annualDays: 0, waitingMonths: 0, daysWorkedRequired: 0, daysOffEarned: 0 },
    ], ["2026-10-13"], null);
    assert.deepEqual(policy.types.map((t) => [t.id, t.paid]), [["ANNUAL", true], ["UNPAID", false]]);
    assert.deepEqual(policy.publicHolidays, ["2026-10-13"]);
  });
  ok("dated versions starting on the 1st read as their month for the engine; any other date stays a date", () => {
    assert.deepEqual([engineFrom("2025-01-01"), engineFrom("2026-10-15")], ["2025-01", "2026-10-15"]);
  });
}

const children: Group[] = [];
try {
  const A = await makeGroup(q, "feeds-a", ["ZZ TEST A Central", "ZZ TEST A Chalong"]);
  const B = await makeGroup(q, "feeds-b", ["ZZ TEST B Park"]);
  children.push(A, B);
  const origin = await serve();
  await signIn(origin, A); await signIn(origin, B);
  const call = caller(origin);
  const must = async (g: Group, method: string, path: string, payload?: unknown, status = [200, 201]) => {
    const res = await call(g, "admin", method, path, payload);
    assert.ok(status.includes(res.status), `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };

  // ── A's setup: entity, account, both branches' details, streams, three people ──
  const setupFor = async (g: Group) => {
    const entity = await must(g, "POST", "/api/payroll/setup/entities", { name: `ZZ ${g.label} Co.`, country: "TH", defaultPayDay: 28, reason });
    const account = await must(g, "POST", "/api/payroll/setup/accounts", { entityId: entity.id, label: "ZZ SCB", bank: "SCB", bankCode: "014", accountNumber: "9901000001", accountName: "ZZ", fileFormat: "SCB", scbProduct: "PAY", reason });
    for (const b of g.branches) {
      await must(g, "POST", `/api/payroll/setup/branches/${b}/details`, { effectiveFrom: "2025-01-01", foodAllowanceDefault: 60, reason,
        details: { country: "TH", payingEntityId: entity.id, defaultPayingAccountId: account.id, ssoBranchNumber: "830001", payDate: 28, legalEntity: "ZZ", employerNumber: "", taxId: "", address: "", payrollBank: "SCB" } });
    }
    await must(g, "POST", "/api/payroll/setup/revenue-streams", { key: "tickets", label: "Tickets", reason });
    return { entity: entity.id as string, account: account.id as string };
  };
  const a = await setupFor(A), b = await setupFor(B);
  const profile = (home: string, entity: string, extra: Record<string, unknown> = {}) => ({
    workerType: "monthly", jobTitle: "ZZ TEST Floor", monthlySalary: 30000, dayRate: 0, fixedFee: 0, joinedOn: "2025-01-01", lastWorkingDay: null,
    taxId: "", ssoNumber: "", foodAllowanceEligible: false, foodAllowancePerDay: 0, ssoEligible: true, pnd1Eligible: false, serviceChargeEligible: true, otEligible: true,
    pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0, paymentMethod: "bank-transfer", bankDetails: { bank: "SCB", accountNumber: `ZZ-${randomUUID().slice(0, 8)}`, accountName: "ZZ" },
    thirdPartyReason: "", allocations: [{ effectiveFrom: "2025-01-01", homeBranchId: home, lines: [{ costCentre: home, percent: 100, entityId: entity, payingAccountId: null }] }],
    studentLoanMonthly: 0, advances: [], separatePayments: [], notes: "", ...extra,
  });
  const worker = await makeEmployee(q, A, A.branches[0], "ZZ TEST worker", "2025-01-01", [0]);
  const dayRate = await makeEmployee(q, A, A.branches[0], "ZZ TEST day-rate", "2025-01-01", [0]);
  const unplaced = await makeEmployee(q, A, A.branches[0], "ZZ TEST unplaced", "2025-01-01");
  const bPerson = await makeEmployee(q, B, B.branches[0], "ZZ TEST B person", "2025-01-01");
  await must(A, "PUT", `/api/payroll/profiles/${worker}`, { profile: profile(A.branches[0], a.entity), revision: 0, reason });
  await must(A, "PUT", `/api/payroll/profiles/${dayRate}`, { profile: profile(A.branches[0], a.entity, { workerType: "day-rate", monthlySalary: 0, dayRate: 1000, ssoEligible: false }), revision: 0, reason });
  await must(B, "PUT", `/api/payroll/profiles/${bPerson}`, { profile: profile(B.branches[0], b.entity), revision: 0, reason });
  // A draft-style profile with no allocation: it cannot be placed, so it must be LISTED, not silently dropped.
  await q(`insert into payroll_profiles (tenant_id, employee_id, worker_type, joined_on, food_allowance_eligible, sso_eligible, pnd1_eligible, service_charge_eligible, ot_eligible)
           values ($1, $2, 'monthly', '2025-01-01', false, true, true, true, true)`, [A.tenant, unplaced]);

  // ── Source attendance for the worker in October 2026 (punches, a pending claim, a holiday) ──
  const ev = (emp: string, branch: string, type: string, iso: string) => q("insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time) values ($1, $2, $3, $4, $5)", [A.tenant, emp, branch, type, iso]);
  for (const day of ["2026-10-05", "2026-10-06", "2026-10-07"]) { await ev(worker, A.branches[0], "IN", `${day}T02:00:00Z`); await ev(worker, A.branches[0], "OUT", `${day}T11:00:00Z`); }
  for (const day of ["2026-10-05", "2026-10-06"]) { await ev(dayRate, A.branches[0], "IN", `${day}T02:00:00Z`); await ev(dayRate, A.branches[0], "OUT", `${day}T11:00:00Z`); }
  await ev(dayRate, A.branches[1], "IN", "2026-10-08T02:00:00Z"); await ev(dayRate, A.branches[1], "OUT", "2026-10-08T11:00:00Z");
  const [pending] = await q<{ id: string }>(`insert into time_entries (tenant_id, employee_id, branch_id, shift_date, clock_in_at, clock_out_at, status)
    values ($1, $2, $3, '2026-10-07', '2026-10-07T01:30:00Z', '2026-10-07T11:00:00Z', 'PENDING_APPROVAL') returning id`, [A.tenant, worker, A.branches[0]]);
  await q(`insert into timekeeping_issues (tenant_id, employee_id, branch_id, issue_date, issue_type, status, linked_time_entry_id, created_by)
           values ($1, $2, $3, '2026-10-07', 'MISSING_CLOCK_IN', 'OPEN', $4, 'KIOSK_SYSTEM')`, [A.tenant, worker, A.branches[0], pending.id]);
  await q("insert into public_holidays (tenant_id, name, date, year) values ($1, 'ZZ TEST holiday', '2026-10-13', 2026)", [A.tenant]);
  const sourceFingerprint = async () => JSON.stringify(await q(`select 'e' k, id::text, event_time::text a, event_type b from time_events where tenant_id = $1
     union all select 't', id::text, coalesce(clock_in_at::text, '') || status, coalesce(clock_out_at::text, '') from time_entries where tenant_id = $1
     union all select 'i', id::text, status, coalesce(resolution_note, '') from timekeeping_issues where tenant_id = $1 order by 1, 2`, [A.tenant]));
  const before = await sourceFingerprint();

  // ── 1. Every new route fenced ──
  const fake = randomUUID();
  const routes: [string, string, "read" | "write"][] = [
    ["GET", "/api/payroll/inputs/2026-10", "read"], ["PUT", `/api/payroll/inputs/2026-10/revenue/${A.branches[0]}`, "write"],
    ["POST", "/api/payroll/inputs/2026-10/override", "write"], ["PUT", `/api/payroll/inputs/2026-10/people/${worker}`, "write"],
    ["GET", "/api/payroll/setup/rewards", "read"], ["POST", `/api/payroll/setup/rewards/service-policies/${A.branches[0]}`, "write"],
    ["POST", "/api/payroll/setup/rewards/incentives", "write"], ["GET", "/api/payroll/feeds/2026-10", "read"],
    ["POST", "/api/payroll/feeds/ot-bookings", "write"], ["POST", "/api/payroll/feeds/leave-valuations", "write"],
    ["POST", `/api/payroll/feeds/leave-valuations/${fake}/reverse`, "write"], ["PUT", `/api/payroll/feeds/offboarding/${worker}`, "write"],
    ["GET", `/api/payroll/month-end/${a.entity}/2026-10`, "read"], ["POST", `/api/payroll/month-end/${a.entity}/2026-10/run`, "write"],
    ["PUT", `/api/payroll/month-end/${a.entity}/2026-10/attendance/${encodeURIComponent(`${worker}:2026-10-05`)}`, "write"],
    ["POST", `/api/payroll/month-end/${a.entity}/2026-10/manual`, "write"], ["POST", `/api/payroll/month-end/${a.entity}/2026-10/manual/${fake}/remove`, "write"],
    ["POST", `/api/payroll/month-end/${a.entity}/2026-10/overrides`, "write"], ["POST", `/api/payroll/month-end/${a.entity}/2026-10/overrides/${fake}/remove`, "write"],
    ["GET", `/api/payroll/month-end/${a.entity}/2026-10/preview`, "read"],
  ];
  const writesBefore = await count("select count(*) n from payroll_profile_changes where tenant_id = $1", [A.tenant]);
  for (const [method, path] of routes) {
    for (const role of ["manager", "staff"] as const) {
      const res = await call(A, role, method, path, { reason });
      assert.equal(res.status, 403, `${role} ${method} ${path}: ${res.status}`);
      passed++;
    }
    const anon = await call(null, "admin", method, path, { reason });
    assert.equal(anon.status, 401, `anonymous ${method} ${path}: ${anon.status}`);
    passed++;
  }
  assert.equal(await count("select count(*) n from payroll_profile_changes where tenant_id = $1", [A.tenant]), writesBefore, "no refused call wrote");
  console.log(`  ok  ${routes.length} new routes: manager, staff and anonymous refused, nothing written`);

  // ── A's month: run, revenue, a review, a manual line, an override, an unpaid leave ──
  await must(A, "PUT", `/api/payroll/inputs/2026-10/revenue/${A.branches[0]}`, { streams: { tickets: { amount: 100000, vat: 6542.06, serviceCharge: 0 } }, reason });
  await must(A, "PUT", `/api/payroll/inputs/2026-09/revenue/${A.branches[0]}`, { streams: { tickets: { amount: 80000, vat: 0, serviceCharge: 0 } }, reason });
  await must(A, "POST", `/api/payroll/setup/rewards/service-policies/${A.branches[0]}`, { month: "2026-09", policy: { percent: 3, basis: "calendar", excluded: "retain", streams: ["tickets"], addBack: [], roleWeights: {} }, reason });
  await must(A, "POST", `/api/payroll/month-end/${a.entity}/2026-10/run`, { reason });
  const run = (await must(A, "GET", `/api/payroll/month-end/${a.entity}/2026-10`)).run;
  const manual = await must(A, "POST", `/api/payroll/month-end/${a.entity}/2026-10/manual`, { employeeId: worker, kind: "bonus", amount: 500, reason });
  const override = await must(A, "POST", `/api/payroll/month-end/${a.entity}/2026-10/overrides`, { employeeId: worker, entityId: a.entity, component: "pnd1", amount: 100, reason });
  const [unpaidType] = await q<{ code: string }>("select code from leave_types where tenant_id = $1 and upper(code) = 'UNPAID'", [A.tenant]);
  assert.ok(unpaidType, "SCRUM-560's catalogue was made for the park group by the loader's first read");
  const [timeOff] = await q<{ id: string }>(`insert into employee_time_off (tenant_id, employee_id, branch_id, type, start_date, end_date, created_by)
    values ($1, $2, $3, 'UNPAID', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', $4) returning id`, [A.tenant, worker, A.branches[0], A.accounts.admin.id]);
  const valuation = await must(A, "POST", "/api/payroll/feeds/leave-valuations", { kind: "unpaid", timeOffId: timeOff.id, reason });
  await must(A, "PUT", `/api/payroll/feeds/offboarding/${dayRate}`, { resignationDate: "2026-12-01", lastWorkingDate: "2026-12-31", reason });

  // ── 1 (cont.). Another park group's ids: 404 and nothing written; lists stay apart ──
  const bWritesBefore = await count("select count(*) n from payroll_profile_changes where tenant_id = $1", [A.tenant]);
  const across: [string, string, unknown][] = [
    ["PUT", `/api/payroll/inputs/2026-10/revenue/${A.branches[0]}`, { streams: { tickets: { amount: 1 } }, reason }],
    ["PUT", `/api/payroll/inputs/2026-10/people/${worker}`, { pnd3Basis: "fee-only", reason }],
    ["POST", `/api/payroll/setup/rewards/service-policies/${A.branches[0]}`, { month: "2026-10", policy: { percent: 1, basis: "calendar", excluded: "retain", streams: ["tickets"] }, reason }],
    ["POST", "/api/payroll/feeds/leave-valuations", { kind: "unpaid", timeOffId: timeOff.id, reason }],
    ["POST", `/api/payroll/feeds/leave-valuations/${valuation.id}/reverse`, { reason }],
    ["PUT", `/api/payroll/feeds/offboarding/${worker}`, { resignationDate: "2026-12-01", lastWorkingDate: "2026-12-31", reason }],
    ["GET", `/api/payroll/month-end/${a.entity}/2026-10`, undefined],
    ["POST", `/api/payroll/month-end/${a.entity}/2026-10/run`, { reason }],
    ["PUT", `/api/payroll/month-end/${a.entity}/2026-10/attendance/${encodeURIComponent(`${worker}:2026-10-05`)}`, { action: "confirm", reason }],
    ["POST", `/api/payroll/month-end/${a.entity}/2026-10/manual`, { employeeId: worker, kind: "bonus", amount: 1, reason }],
    ["POST", `/api/payroll/month-end/${a.entity}/2026-10/manual/${manual.id}/remove`, { reason }],
    ["POST", `/api/payroll/month-end/${a.entity}/2026-10/overrides`, { employeeId: worker, component: "pnd1", amount: 1, reason }],
    ["POST", `/api/payroll/month-end/${a.entity}/2026-10/overrides/${override.id}/remove`, { reason }],
    ["GET", `/api/payroll/month-end/${a.entity}/2026-10/preview`, undefined],
    // B's own entity, but A's people and rows:
    ["POST", `/api/payroll/month-end/${b.entity}/2026-10/manual`, { employeeId: worker, kind: "bonus", amount: 1, reason }],
  ];
  await must(B, "POST", `/api/payroll/month-end/${b.entity}/2026-10/run`, { reason });
  for (const [method, path, payload] of across) {
    const res = await call(B, "global_admin", method, path, payload);
    assert.equal(res.status, 404, `B ${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    passed++;
  }
  assert.equal(await count("select count(*) n from payroll_profile_changes where tenant_id = $1", [A.tenant]), bWritesBefore, "B wrote nothing of A's");
  assert.equal(await count("select count(*) n from payroll_run_manual_lines where tenant_id = $1", [A.tenant]), 1);
  const bInputs = (await must(B, "GET", "/api/payroll/inputs/2026-10"));
  assert.equal(bInputs.inputs, null, "B sees none of A's month inputs");
  assert.ok(!bInputs.people.some((p: { id: string }) => p.id === worker));
  const bFeeds = await must(B, "GET", "/api/payroll/feeds/2026-10");
  assert.equal(bFeeds.valuations.length, 0); assert.equal(bFeeds.offboarding.length, 0);
  const bRewards = await must(B, "GET", "/api/payroll/setup/rewards");
  assert.deepEqual(Object.keys(bRewards.policies), [], "B sees none of A's policies");
  passed += 6;
  console.log(`  ok  ${across.length} cross-park-group calls answered 404; lists stay apart`);

  // ── 3. A review is stored against the run version; source attendance unchanged ──
  await okAsync("an override review lands on the run version and the preview uses its clocks; sources untouched", async () => {
    const review = await must(A, "PUT", `/api/payroll/month-end/${a.entity}/2026-10/attendance/${encodeURIComponent(`${worker}:2026-10-07`)}`, { action: "override", clockIn: "08:30", clockOut: "18:00", reason });
    assert.equal(review.version, 1);
    const rows = await q<{ run_version_id: string; action: string; clock_in: string }>("select run_version_id, action, clock_in from payroll_run_attendance_reviews where tenant_id = $1", [A.tenant]);
    assert.deepEqual(rows, [{ run_version_id: run.versionId, action: "override", clock_in: "08:30" }]);
    assert.equal(await sourceFingerprint(), before, "time_events, time_entries and timekeeping_issues are byte-for-byte unchanged");
    const view = await must(A, "GET", `/api/payroll/month-end/${a.entity}/2026-10`);
    const day = view.attendance.find((d: { id: string }) => d.id === `${worker}:2026-10-07`);
    assert.deepEqual([day.effectiveClockIn, day.review.action, day.exceptions[0].resolution], [null, "override", null], "the fed day still shows the source; the review sits beside it");
  });
  await okAsync("excuse and confirm need a reason; an override needs both times (the prototype's words)", async () => {
    const day = encodeURIComponent(`${worker}:2026-10-06`);
    assert.equal((await call(A, "admin", "PUT", `/api/payroll/month-end/${a.entity}/2026-10/attendance/${day}`, { action: "excuse" })).status, 400);
    const res = await call(A, "admin", "PUT", `/api/payroll/month-end/${a.entity}/2026-10/attendance/${day}`, { action: "override", clockIn: "09:00", reason });
    assert.deepEqual([res.status, res.body.message], [400, "Enter both corrected times."]);
    assert.equal((await call(A, "admin", "PUT", `/api/payroll/month-end/${a.entity}/2026-10/attendance/${encodeURIComponent(`${worker}:2026-11-01`)}`, { action: "confirm", reason })).status, 404);
  });

  // ── The preview: seams in force on stored rows ──
  await okAsync("preview: worked days from the feed (day-rate pays punches + reviewed day), unpaid leave valued per workday, unplaced person listed", async () => {
    const preview = await must(A, "GET", `/api/payroll/month-end/${a.entity}/2026-10/preview`);
    const people = preview.result.people as { id: string; daysWorked: number; lines: { component: string; amount: number }[]; components: Record<string, number> }[];
    const w = people.find((p) => p.id === worker)!, d = people.find((p) => p.id === dayRate)!;
    assert.equal(w.daysWorked, 3, "three punched days, the reviewed one counted with its override clock");
    assert.equal(d.daysWorked, 3, "a day punched at the sister branch still counts (roster branch stamped)");
    assert.equal(d.components.salary, 3000, "day rate × worked days");
    // The feed is right: one dated line per valued workday at the frozen 30000/30 rate. The SIGN is the
    // prototype engine's (PAYROLL-FINDING-R3: it negates the older calculation's negative line, so the
    // day is paid, not deducted) — not pinned here either way; raised for the park.
    const unpaid = w.lines.filter((l) => l.component.startsWith("unpaid-leave:"));
    assert.deepEqual(unpaid.map((l) => Math.abs(l.amount)), [1000, 1000], JSON.stringify(unpaid));
    assert.ok(unpaid.every((l) => /−1 days × ฿1,000.00/.test((l as unknown as { formula: string }).formula)));
    console.log(`      NOTE PAYROLL-FINDING-R3: the engine books the valued unpaid days as ${unpaid.reduce((n, l) => n + l.amount, 0)} (prototype sign)`);
    assert.equal(w.components.manual, 500); assert.equal(w.components.pnd1, 100);
    assert.deepEqual(preview.excluded.map((x: { employeeId: string }) => x.employeeId), [unplaced]);
    assert.match(preview.signature, /^sha256:[0-9a-f]{64}$/);
    const again = await must(A, "GET", `/api/payroll/month-end/${a.entity}/2026-10/preview`);
    assert.equal(again.signature, preview.signature, "the signature is stable for unchanged inputs");
    assert.ok(preview.calculation.exceptions.some((e: { kind: string; message: string }) => e.kind === "attendance" && e.message.includes("2026-10-07")) === false,
      "the reviewed day's open exception no longer blocks");
  });
  await okAsync("the loader reads a fixed number of queries whatever the head count", async () => {
    const small = (await must(A, "GET", `/api/payroll/month-end/${a.entity}/2026-10/preview`)).timing.queries;
    for (let i = 0; i < 6; i++) {
      const id = await makeEmployee(q, A, A.branches[1], `ZZ TEST extra ${i}`, "2025-01-01");
      await must(A, "PUT", `/api/payroll/profiles/${id}`, { profile: profile(A.branches[1], a.entity), revision: 0, reason });
    }
    const large = (await must(A, "GET", `/api/payroll/month-end/${a.entity}/2026-10/preview`)).timing.queries;
    assert.equal(large, small, `${small} queries with 3 people, ${large} with 9`);
  });

  // ── 5. Inputs, rewards and feeds keep the prototype's words ──
  await okAsync("month inputs: unknown stream refused; days above employment refused; days overridden with source Attendance", async () => {
    const bad = await call(A, "admin", "PUT", `/api/payroll/inputs/2026-10/revenue/${A.branches[0]}`, { streams: { nope: { amount: 1 } }, reason });
    assert.equal(bad.status, 400);
    const over = await call(A, "admin", "POST", "/api/payroll/inputs/2026-10/override", { key: `days:${worker}`, value: 40, reason });
    assert.deepEqual([over.status, over.body.message], [400, "Days worked cannot exceed the 31 days this person was employed."]);
    const okDays = await must(A, "POST", "/api/payroll/inputs/2026-10/override", { key: `days:${worker}`, value: 20, reason });
    assert.equal(okDays.inputs.sources[`days:${worker}`].kind, "Attendance");
    const log = await count("select count(*) n from payroll_month_input_changes where tenant_id = $1", [A.tenant]);
    await assert.rejects(q("update payroll_month_input_changes set reason = 'x' where tenant_id = $1", [A.tenant]), /append-only/);
    assert.ok(log >= 3);
  });
  await okAsync("rewards: partMonth stored as entered (absent stays absent), policies without groups, versions dated", async () => {
    const saved = await must(A, "POST", "/api/payroll/setup/rewards/incentives", {
      terms: { name: "ZZ ticket share", kind: "revenue", base: { branches: [A.branches[0]], streams: ["tickets"], addBack: [] }, rate: 1, target: null, cap: null },
      from: "2026-10-01", selected: [{ staffId: worker, startDate: "2026-10-01" }], titles: [{ jobTitle: "ZZ TEST Floor", branches: [A.branches[1]] }], reason,
    });
    const [rule] = await q<{ terms: Record<string, unknown> }>("select terms from payroll_incentive_rules where id = $1", [saved.id]);
    assert.ok(!("partMonth" in rule.terms), "never defaulted to prorate");
    const rows = await q<{ employee_id: string | null; job_title: string | null }>("select employee_id, job_title from payroll_incentive_assignments where rule_id = $1 order by job_title nulls first", [saved.id]);
    assert.deepEqual(rows.map((r) => [r.employee_id, r.job_title]), [[worker, null], [null, "ZZ TEST Floor"]]);
    const policies = await q<{ policy: Record<string, unknown> }>("select policy from payroll_service_policies where tenant_id = $1", [A.tenant]);
    assert.ok(policies.every((p) => !("groups" in p.policy) && !("exceptions" in p.policy)));
  });
  await okAsync("OT bank: bookings refused against an empty bank — runs do not credit it (owner ruling); the feed says so", async () => {
    const res = await call(A, "admin", "POST", "/api/payroll/feeds/ot-bookings", { employeeId: worker, date: "2026-10-10", hours: 4, reason });
    assert.deepEqual([res.status, res.body.message], [409, "OT bank booking exceeds available time: 0.00h available, 4.00h requested."]);
    const feeds = await must(A, "GET", "/api/payroll/feeds/2026-10");
    assert.equal(feeds.otBankCreditsFromRuns, false);
    assert.ok(feeds.otBank.every((r: { availableHours: number }) => r.availableHours === 0));
    assert.equal(feeds.valuations[0].amount, 2000);
  });
  await okAsync("a valuation is reversed with a reason, never deleted; valuing the same time off twice is refused", async () => {
    assert.equal((await call(A, "admin", "POST", "/api/payroll/feeds/leave-valuations", { kind: "unpaid", timeOffId: timeOff.id, reason })).status, 409);
    await must(A, "POST", `/api/payroll/feeds/leave-valuations/${valuation.id}/reverse`, { reason });
    assert.equal(await count("select count(*) n from payroll_leave_valuations where id = $1 and reversed_at is not null", [valuation.id]), 1);
  });

  // ── 6. A realistic park: 60 people, two months of punches ──
  await okAsync("timing: a full-month preview of a realistic park stays within the plan's ~2 s server budget", async () => {
    const P = await makeGroup(q, "feeds-perf", ["ZZ TEST P Central", "ZZ TEST P Chalong"]);
    children.push(P);
    await signIn(origin, P);
    const p = await setupFor(P);
    await must(P, "PUT", `/api/payroll/inputs/2026-09/revenue/${P.branches[0]}`, { streams: { tickets: { amount: 900000, vat: 0, serviceCharge: 0 } }, reason });
    await must(P, "PUT", `/api/payroll/inputs/2026-09/revenue/${P.branches[1]}`, { streams: { tickets: { amount: 400000, vat: 0, serviceCharge: 0 } }, reason });
    await must(P, "PUT", `/api/payroll/inputs/2026-10/revenue/${P.branches[0]}`, { streams: { tickets: { amount: 950000, vat: 0, serviceCharge: 0 } }, reason });
    await must(P, "PUT", `/api/payroll/inputs/2026-10/revenue/${P.branches[1]}`, { streams: { tickets: { amount: 420000, vat: 0, serviceCharge: 0 } }, reason });
    for (const br of P.branches) await must(P, "POST", `/api/payroll/setup/rewards/service-policies/${br}`, { month: "2026-09", policy: { percent: 3, basis: "worked", excluded: "retain", streams: ["tickets"], addBack: [], roleWeights: {} }, reason });
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const home = P.branches[i % 2];
      const id = await makeEmployee(q, P, home, `ZZ TEST park ${i}`, "2025-01-01", [i % 7]);
      ids.push(id);
      await must(P, "PUT", `/api/payroll/profiles/${id}`, { profile: profile(home, p.entity, i % 5 === 0 ? { workerType: "day-rate", monthlySalary: 0, dayRate: 900, ssoEligible: false } : {}), revision: 0, reason });
    }
    // Two months of punches: in 09:00, out 18:00 or 19:30 (overtime on some days); a few late.
    await q(`insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time)
      select $1, e.id, e.branch_id, k.t, (d::date + case k.t when 'IN' then (interval '2 hours' + (case when extract(day from d)::int % 9 = 0 then interval '15 minutes' else interval '0' end))
                                                    else (interval '11 hours' + (case when extract(day from d)::int % 4 = 0 then interval '90 minutes' else interval '0' end)) end)
      from employees e cross join generate_series('2026-09-01'::date, '2026-10-31'::date, '1 day') d cross join (values ('IN'), ('OUT')) k(t)
      where e.tenant_id = $1 and extract(dow from d)::int <> all(e.weekly_off_days)`, [P.tenant]);
    const punches = await count("select count(*) n from time_events where tenant_id = $1", [P.tenant]);
    // The rulebook's attendance tariffs for everyone, and resolved late arrivals and missed punches on
    // some days, so the deduction path (the one R1 flagged as quadratic) does real work.
    const tariffs = rulebookThaiDeductionRules().map((r) => ({ ...r, jobTitles: ["ZZ TEST Floor"] }));
    await must(P, "POST", "/api/payroll/setup/deduction-lists", { scope: "company", effectiveFrom: "2026-09-01", rules: tariffs, reason });
    await q(`insert into timekeeping_issues (tenant_id, employee_id, branch_id, issue_date, issue_type, status, created_by, resolution_note)
      select $1, e.id, e.branch_id, to_char(d, 'YYYY-MM-DD'), case when extract(day from d)::int % 2 = 0 then 'LATE_ARRIVAL' else 'MISSING_CLOCK_OUT' end, 'RESOLVED', 'KIOSK_SYSTEM', 'ZZ TEST'
      from employees e cross join generate_series('2026-09-03'::date, '2026-10-30'::date, '3 days') d where e.tenant_id = $1`, [P.tenant]);
    const issues = await count("select count(*) n from timekeeping_issues where tenant_id = $1", [P.tenant]);
    await must(P, "POST", `/api/payroll/month-end/${p.entity}/2026-10/run`, { reason });
    const timings: number[] = [];
    let last: { timing: { loadMs: number; calculateMs: number; queries: number }; result: { people: unknown[] }; calculation: { exceptions: unknown[] } } | null = null;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      last = await must(P, "GET", `/api/payroll/month-end/${p.entity}/2026-10/preview`);
      timings.push(Math.round(performance.now() - started));
    }
    const server = last!.timing.loadMs + last!.timing.calculateMs;
    const charged = (last!.result as unknown as { people: { lines: { component: string }[] }[] }).people.filter((x) => x.lines.some((l) => l.component.startsWith("attendance-rule:"))).length;
    assert.ok(charged > 0, "the tariffs charged someone");
    console.log(`      realistic park: ${ids.length} people, ${punches} punches and ${issues} resolved issues over two months, ${tariffs.length} tariffs, ${last!.result.people.length} paid, ${last!.calculation.exceptions.length} exceptions, ${charged} charged a tariff`);
    console.log(`      preview round trips ${timings.join(" / ")} ms; server load ${last!.timing.loadMs} ms (${last!.timing.queries} queries) + calculate ${last!.timing.calculateMs} ms = ${server} ms`);
    assert.ok(server < 2000, `server-side preview ${server} ms is over the ~2 s budget`);
  });

  console.log(`payroll-feeds.check: ${passed} checks passed`);
} catch (error) {
  console.error("payroll-feeds.check FAILED:", error);
  process.exitCode = 1;
} finally {
  stopServers();
  await pool.end();
  void APP_ENV;
}
