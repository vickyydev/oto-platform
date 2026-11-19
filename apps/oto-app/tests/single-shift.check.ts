// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-1038 — a former employee invited to one shift, on the same profile and
// without rehiring, paid on the old contract or switched to a casual day rate
// (the owner's answer of 19 November 2026), over HTTP against the routes as
// registered:
//
//   0. What one single shift is worth, both ways, with exact figures on fixture
//      contracts (ZZ TEST amounts): a casual day rate is the rate; the old
//      contract is one day of it as payroll values a day (a day rate as it is,
//      a monthly salary or fee ÷ 30); no payroll profile, no figure.
//   1. Who may invite: staff are refused; a manager outside the shift's branch
//      is refused; a current employee, a profile with Onboard Again planned and
//      a former employee of another branch are refused in words, with nothing
//      written; a past day and a casual rate missing or not whole are refused.
//   2. A former employee is accepted by a manager: one assignment on that shift
//      and day, its invitation, "On the old contract" by default, the activity
//      log naming who and which way; the week shows the shift; a second single
//      shift the same day is refused (one shift only), and the ordinary
//      assignment route still refuses a former employee.
//   3. The pay: the manager sees the way and no salary; a payroll role sees the
//      figure. Switched to a casual day rate of 1,200 and back, each switch in
//      the activity log with who, when and from/to; a day-rate contract's and
//      a profile-less person's figures.
//   4. The kiosk: on the shift's day at its branch the former employee clocks
//      in and out; at another branch that day, and on any other day, refused
//      as before with nothing written; the next day it is closed again by
//      itself. A shift removed closes it too.
//   5. Access outside it unchanged: the profile stays Left and the login in pay
//      only, refused everywhere but My pay, before and after.
//   6. The 03:00 batch ending an employment keeps a single shift already made
//      for that person (it deletes the ending employment's own later shifts).
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/single-shift.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { EMPLOYMENT_ENDED, KIOSK_EMPLOYMENT_ENDED_MESSAGE, PAY_ONLY_MESSAGE } from "../shared/payOnly";
import { SINGLE_SHIFT_REFUSALS } from "../shared/singleShift";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("single-shift.check: DATABASE_URL is not set");
  process.exit(2);
}

const HARNESS_ENV = {
  NODE_ENV: "test",
  APP_ENV: "dev",
  STORAGE_ENV_PREFIX: "zz-test",
  OBJECT_STORAGE: "local",
  OTOAPP_LEGACY_LOGIN: "true",
  LOG_LEVEL: "warn",
  TZ: "UTC",
  DEPLOY_ENV: "local",
  OTOAPP_JOBS: "platform",
  USE_AWS_REKOGNITION: "false",
};

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const DAY_MS = 86_400_000;
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** 10:00 in Bangkok on a day, as an instant. */
const tenAmBangkok = (day: string) => new Date(Date.parse(`${day}T10:00:00+07:00`)).toISOString();
/** 03:00 in Bangkok on a day, the 03:00 batch's hour, as an instant. */
const threeAmBangkok = (day: string) => new Date(Date.parse(`${day}T03:00:00+07:00`)).toISOString();

const SHIFT_DAY = plus(2);
const OTHER_DAY = plus(3);

// ─── One park group, two branches, the people ────────────────────────────────

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST s1038 ${run}`, `zz-s1038-${run}`]);
const BRANCH = randomUUID();
const BRANCH_2 = randomUUID();
for (const [id, label] of [[BRANCH, "one"], [BRANCH_2, "two"]] as const) {
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    id, TENANT, `ZZ TEST s1038 ${label} ${run}`,
  ]);
}
const DEPARTMENT = randomUUID();
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [DEPARTMENT, TENANT, `ZZ TEST s1038 floor ${run}`]);
const GROUP = randomUUID();
await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [GROUP, TENANT, BRANCH, `ZZ TEST s1038 group ${run}`]);
async function shiftRow(label: string, start: string, end: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into schedule_shift_rows (id, tenant_id, branch_id, department_id, shift_group_id, label, start_time, end_time)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, TENANT, BRANCH, DEPARTMENT, GROUP, `ZZ TEST ${label}`, start, end],
  );
  return id;
}
const MORNING = await shiftRow("morning", "09:00", "15:00");
const EVENING = await shiftRow("evening", "15:00", "21:00");

async function user(role: string, label: string, branchId: string | null) {
  const id = randomUUID();
  const email = `zz-s1038-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST s1038 ${label} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    TENANT, id, branchId, branchId === null ? "all_branches" : "selected_branches",
  ]);
  return { id, email };
}
const admin = await user("admin", "admin", null);
const manager = await user("manager", "manager", BRANCH);
const otherManager = await user("manager", "othermanager", BRANCH_2);
const staff = await user("staff", "staff", BRANCH);
const formerLogin = await user("staff", "former", BRANCH);
await q("update users set access_mode = 'pay_only' where id = $1", [formerLogin.id]);

const phoneOf = () => `08${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const PHONE = { former: phoneOf(), dayRate: phoneOf(), stranger: phoneOf(), current: phoneOf() };
async function employee(label: string, opts: {
  status: string; state: string; lastDay?: string | null; branchId?: string; userId?: string | null; phone?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, employment_state,
                            primary_department_id, phone_e164, last_working_day)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, TENANT, opts.branchId ?? BRANCH, opts.userId ?? null, `ZZ TEST s1038 ${label} ${run}`, `zz${label}`,
      `zz-s1038-emp-${label}-${run}@example.com`, opts.status, opts.state, DEPARTMENT,
      opts.phone ? `+66${opts.phone.slice(1)}` : null, opts.lastDay ? `${opts.lastDay}T00:00:00Z` : null],
  );
  return id;
}
const LEFT = { status: "resigned", state: "LEFT", lastDay: plus(-10) };
const former = await employee("former", { ...LEFT, userId: formerLogin.id, phone: PHONE.former });
const dayRater = await employee("dayrater", { ...LEFT, phone: PHONE.dayRate });
const noProfile = await employee("noprofile", LEFT);
const stranger = await employee("stranger", { ...LEFT, phone: PHONE.stranger });
const current = await employee("current", { status: "active", state: "ACTIVE", lastDay: null, phone: PHONE.current });
const comingBack = await employee("comingback", LEFT);
await q(
  `insert into employee_engagements (tenant_id, employee_id, start_date, department_id, branch_id, status)
   values ($1, $2, $3, $4, $5, 'planned')`,
  [TENANT, comingBack, plus(20), DEPARTMENT, BRANCH],
);
const elsewhere = await employee("elsewhere", { ...LEFT, branchId: BRANCH_2 });
// Resigned with a last day already past, the batch not yet run on it: still Leaving.
const leaving = await employee("leaving", { status: "resigned", state: "LEAVING", lastDay: plus(-1) });

/** ZZ TEST pay terms on the payroll profile, the old contract's source. */
async function payrollProfile(employeeId: string, workerType: string, amounts: { monthly?: number; day?: number; fee?: number }) {
  await q(
    `insert into payroll_profiles (tenant_id, employee_id, worker_type, monthly_salary, day_rate, fixed_fee,
                                   food_allowance_eligible, sso_eligible, pnd1_eligible, service_charge_eligible, ot_eligible,
                                   joined_on, last_working_day)
     values ($1, $2, $3, $4, $5, $6, false, false, false, false, false, $7, $8)`,
    [TENANT, employeeId, workerType, amounts.monthly ?? 0, amounts.day ?? 0, amounts.fee ?? 0, plus(-400), plus(-10)],
  );
}
await payrollProfile(former, "monthly", { monthly: 15000 });
await payrollProfile(dayRater, "day-rate", { day: 450 });

// The kiosk tablets: one at each branch.
const DEVICE_SECRET = randomBytes(32).toString("hex");
const DEVICE_2_SECRET = randomBytes(32).toString("hex");
for (const [branchId, secret, label] of [[BRANCH, DEVICE_SECRET, "one"], [BRANCH_2, DEVICE_2_SECRET, "two"]] as const) {
  await q(
    `insert into kiosk_devices (id, tenant_id, branch_id, name, device_secret_hash, kiosk_type, is_active)
     values ($1, $2, $3, $4, $5, 'face_recognition', true)`,
    [randomUUID(), TENANT, branchId, `ZZ TEST s1038 tablet ${label}`, sha256(secret)],
  );
}
// A directory key for the night batch, as script/directory-client.mjs issues them.
const JOBS_KEY = "odk_" + randomBytes(32).toString("base64url");
await q("insert into directory_clients (tenant_id, name, key_hash, scopes) values ($1, $2, $3, $4)", [
  TENANT, `ZZ TEST s1038 ${run}`, sha256(JOBS_KEY), ["jobs:run"],
]);

// ─── The servers ─────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
async function serve(fakeNow?: string): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV, ...(fakeNow ? { HARNESS_FAKE_NOW: fakeNow } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 90_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}:\n${output}`));
    });
  });
}

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field below
}
async function call(origin: string, method: string, path: string, cookie: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body: parsed };
}
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body)}`;
async function signIn(origin: string, email: string): Promise<string> {
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in ${email}: ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const invitationsOf = async (employeeId: string) =>
  q<{ id: string; pay_basis: string; casual_day_rate: number | null; assignment_id: string | null; shift_date: string; created_by: string; updated_by: string }>(
    "select id, pay_basis, casual_day_rate, assignment_id, shift_date::text as shift_date, created_by, updated_by from single_shift_invitations where employee_id = $1 order by created_at",
    [employeeId],
  );
const assignmentsOf = async (employeeId: string) =>
  q<{ id: string; shift_row_id: string; shift_date: string }>(
    "select id, shift_row_id, shift_date::text as shift_date from schedule_assignments where employee_id = $1 order by shift_date",
    [employeeId],
  );
const activityOf = async (employeeId: string) =>
  (await q<{ activity_type: string; created_by: string; metadata_json: string; summary_text: string }>(
    "select activity_type, created_by, metadata_json, summary_text from activity_log where employee_id = $1 and activity_type like 'single_shift_%' order by created_at",
    [employeeId],
  )).map((r) => ({ ...r, metadata: JSON.parse(r.metadata_json) }));
const timeEventsOf = async (employeeId: string) =>
  q<{ event_type: string; branch_id: string }>("select event_type, branch_id from time_events where employee_id = $1 order by event_time", [employeeId]);
const profileOf = async (id: string) =>
  (await q<{ status: string; employment_state: string; last_working_day: string }>(
    "select status, employment_state, last_working_day::date::text as last_working_day from employees where id = $1", [id]))[0]!;
const loginOf = async (id: string) =>
  (await q<{ is_active: boolean; access_mode: string }>("select is_active, access_mode from users where id = $1", [id]))[0]!;

const invite = (origin: string, cookie: string, body: Record<string, unknown>) =>
  call(origin, "POST", "/api/schedule/single-shift/invitations", cookie, body);
const shiftsOn = (origin: string, cookie: string, branchId: string, from: string, to: string) =>
  call(origin, "GET", `/api/schedule/single-shift/invitations?branchId=${branchId}&startDate=${from}&endDate=${to}`, cookie);

try {
  // ── 0. The pay, both ways, on its own ──────────────────────────────────────
  console.log("0. what one single shift is worth, both ways:");
  Object.assign(process.env, HARNESS_ENV);
  const { singleShiftPay } = await import("../server/lib/singleShift");
  await check("a casual day rate is the rate for the shift; the old contract is one day of it as payroll values a day", () => {
    assert.deepEqual(singleShiftPay("casual_day_rate", 1200, null), { way: "casual_day_rate", amount: 1200, formula: "Casual day rate ฿1,200 × 1 shift" });
    assert.deepEqual(singleShiftPay("old_contract", null, { workerType: "monthly", monthlySalary: 15000, dayRate: 0, fixedFee: 0 }),
      { way: "old_contract", amount: 500, formula: "Monthly salary ฿15,000 ÷ 30 × 1 shift" });
    assert.equal(singleShiftPay("old_contract", null, { workerType: "monthly", monthlySalary: 16000, dayRate: 0, fixedFee: 0 }).amount, 533.33);
    assert.deepEqual(singleShiftPay("old_contract", null, { workerType: "day-rate", monthlySalary: 0, dayRate: 450, fixedFee: 0 }),
      { way: "old_contract", amount: 450, formula: "Day rate ฿450 × 1 shift" });
    assert.deepEqual(singleShiftPay("old_contract", null, { workerType: "contractor", monthlySalary: 0, dayRate: 0, fixedFee: 9000 }),
      { way: "old_contract", amount: 300, formula: "Fixed fee ฿9,000 ÷ 30 × 1 shift" });
    assert.deepEqual(singleShiftPay("old_contract", null, null),
      { way: "old_contract", amount: null, formula: "No payroll profile: the old contract's pay terms are not on file" });
    assert.throws(() => singleShiftPay("casual_day_rate", null, null));
    assert.throws(() => singleShiftPay("casual_day_rate", 99.5, null));
  });

  const origin = await serve();
  const asAdmin = await signIn(origin, admin.email);
  const asManager = await signIn(origin, manager.email);
  const asOtherManager = await signIn(origin, otherManager.email);
  const asStaff = await signIn(origin, staff.email);

  // ── 1. Who may invite ──────────────────────────────────────────────────────
  console.log("1. who may invite, and whom:");
  const base = { employeeId: former, shiftRowId: MORNING, shiftDate: SHIFT_DAY };
  await check("staff are refused by the scheduling rule; a manager outside the shift's branch is refused; nothing is written", async () => {
    const asStaffRes = await invite(origin, asStaff, base);
    assert.equal(asStaffRes.status, 403, show(asStaffRes));
    const outside = await invite(origin, asOtherManager, base);
    assert.deepEqual([outside.status, outside.body.message], [403, "Access denied to this branch"], show(outside));
    const list = await call(origin, "GET", `/api/schedule/single-shift/former-employees?branchId=${BRANCH}`, asOtherManager);
    assert.equal(list.status, 403, show(list));
    assert.deepEqual(await invitationsOf(former), []);
    assert.deepEqual(await assignmentsOf(former), []);
  });
  await check("a current employee is refused in words: they are scheduled as usual", async () => {
    const res = await invite(origin, asManager, { ...base, employeeId: current });
    assert.deepEqual([res.status, res.body.message, res.body.reasonCode], [400, SINGLE_SHIFT_REFUSALS.notFormer, "NOT_FORMER_EMPLOYEE"], show(res));
    assert.deepEqual(await invitationsOf(current), []);
    assert.deepEqual(await assignmentsOf(current), []);
  });
  await check("a profile with Onboard Again planned, and a former employee of another branch, are refused", async () => {
    const back = await invite(origin, asManager, { ...base, employeeId: comingBack });
    assert.deepEqual([back.status, back.body.reasonCode], [400, "ONBOARD_AGAIN_PLANNED"], show(back));
    const away = await invite(origin, asAdmin, { ...base, employeeId: elsewhere });
    assert.deepEqual([away.status, away.body.reasonCode], [400, "BRANCH_MISMATCH"], show(away));
    assert.deepEqual([...(await invitationsOf(comingBack)), ...(await invitationsOf(elsewhere))], []);
  });
  await check("a past day, a casual rate missing or not whole baht, and a rate on the old contract are refused", async () => {
    const past = await invite(origin, asManager, { ...base, shiftDate: plus(-1) });
    assert.deepEqual([past.status, past.body.message], [400, SINGLE_SHIFT_REFUSALS.pastDate], show(past));
    for (const body of [
      { ...base, payWay: "casual_day_rate" },
      { ...base, payWay: "casual_day_rate", casualDayRate: 0 },
      { ...base, payWay: "casual_day_rate", casualDayRate: 950.5 },
      { ...base, payWay: "old_contract", casualDayRate: 900 },
    ]) {
      const res = await invite(origin, asManager, body);
      assert.deepEqual([res.status, res.body.message], [400, SINGLE_SHIFT_REFUSALS.rate], `${JSON.stringify(body)}: ${show(res)}`);
    }
    assert.deepEqual(await invitationsOf(former), []);
  });
  await check("the branch's former employees are listed for the manager: not the current one, not the one coming back, not another branch's", async () => {
    const res = await call(origin, "GET", `/api/schedule/single-shift/former-employees?branchId=${BRANCH}`, asManager);
    assert.equal(res.status, 200, show(res));
    const ids = (res.body as { id: string }[]).map((p) => p.id);
    for (const id of [former, dayRater, noProfile, stranger, leaving]) assert.ok(ids.includes(id), `${id} listed`);
    for (const id of [current, comingBack, elsewhere]) assert.ok(!ids.includes(id), `${id} not listed`);
  });

  // ── 2. A former employee accepted ──────────────────────────────────────────
  console.log("2. a former employee put on one shift:");
  let invitationId = "";
  await check("the manager invites the former employee: one assignment on that shift and day, on the old contract by default", async () => {
    const res = await invite(origin, asManager, base);
    assert.equal(res.status, 201, show(res));
    assert.deepEqual([res.body.employeeId, res.body.shiftRowId, res.body.shiftDate, res.body.payWay, res.body.casualDayRate, res.body.payLabel],
      [former, MORNING, SHIFT_DAY, "old_contract", null, "On the old contract"]);
    assert.equal("pay" in res.body, false, "a manager is not shown the salary");
    invitationId = res.body.id;
    const assignments = await assignmentsOf(former);
    assert.deepEqual(assignments.map((a) => [a.shift_row_id, a.shift_date]), [[MORNING, SHIFT_DAY]]);
    const [row] = await invitationsOf(former);
    assert.deepEqual([row!.pay_basis, row!.casual_day_rate, row!.assignment_id, row!.shift_date, row!.created_by], ["old_contract", null, assignments[0]!.id, SHIFT_DAY, manager.id]);
  });
  await check("the activity log names who and which way", async () => {
    const [entry, ...rest] = await activityOf(former);
    assert.equal(rest.length, 0);
    assert.equal(entry!.activity_type, "single_shift_invited");
    assert.equal(entry!.created_by, manager.id);
    assert.deepEqual([entry!.metadata.invitationId, entry!.metadata.shiftDate, entry!.metadata.payWay, entry!.metadata.casualDayRate],
      [invitationId, SHIFT_DAY, "old_contract", null]);
    assert.match(entry!.summary_text, /single shift on .*, on the old contract$/);
  });
  await check("the week shows the shift, with the person, like any shift", async () => {
    const monday = (() => { const at = Date.parse(`${SHIFT_DAY}T00:00:00Z`); const d = new Date(at).getUTCDay(); return new Date(at + (d === 0 ? -6 : 1 - d) * DAY_MS).toISOString().slice(0, 10); })();
    const week = await call(origin, "GET", `/api/schedule/week?branchId=${BRANCH}&weekStartDate=${monday}`, asManager);
    assert.equal(week.status, 200, show(week));
    const all = (week.body.shiftRows as { assignments?: { employeeId: string; shiftDate: string }[] }[]).flatMap((r) => r.assignments ?? []);
    assert.ok(all.some((a) => a.employeeId === former && String(a.shiftDate).startsWith(SHIFT_DAY)), JSON.stringify(all));
  });
  await check("one shift only: a second single shift the same day is refused, and nothing more is written", async () => {
    const res = await invite(origin, asManager, { ...base, shiftRowId: EVENING });
    assert.deepEqual([res.status, res.body.message, res.body.reasonCode], [409, SINGLE_SHIFT_REFUSALS.sameDay, "ALREADY_INVITED"], show(res));
    assert.equal((await assignmentsOf(former)).length, 1);
    assert.equal((await invitationsOf(former)).length, 1);
  });
  await check("the ordinary assignment route still refuses a former employee", async () => {
    const res = await call(origin, "POST", "/api/schedule/assignments", asManager, { shiftRowId: EVENING, shiftDate: OTHER_DAY, employeeId: former });
    assert.deepEqual([res.status, res.body.reasonCode], [400, "EMPLOYMENT_ENDED"], show(res));
    assert.equal((await assignmentsOf(former)).length, 1);
  });

  // ── 3. The pay ─────────────────────────────────────────────────────────────
  console.log("3. how the shift is paid:");
  await check("a payroll role sees the old contract's figure: ฿15,000 a month ÷ 30 = ฿500 for the shift", async () => {
    const res = await shiftsOn(origin, asAdmin, BRANCH, SHIFT_DAY, SHIFT_DAY);
    assert.equal(res.status, 200, show(res));
    const mine = (res.body as { id: string; pay: unknown }[]).find((s) => s.id === invitationId)!;
    assert.deepEqual(mine.pay, { way: "old_contract", amount: 500, formula: "Monthly salary ฿15,000 ÷ 30 × 1 shift" });
    const asMgr = await shiftsOn(origin, asManager, BRANCH, SHIFT_DAY, SHIFT_DAY);
    assert.equal(Object.hasOwn((asMgr.body as { id: string }[]).find((s) => s.id === invitationId)!, "pay"), false);
  });
  await check("switched to a casual day rate of ฿1,200: stored on the invitation, shown, and in the activity log from/to", async () => {
    const res = await call(origin, "PATCH", `/api/schedule/single-shift/invitations/${invitationId}`, asManager, { payWay: "casual_day_rate", casualDayRate: 1200 });
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.payWay, res.body.casualDayRate, res.body.payLabel], ["casual_day_rate", 1200, "Casual day rate ฿1,200 a day"]);
    const [row] = await invitationsOf(former);
    assert.deepEqual([row!.pay_basis, row!.casual_day_rate, row!.updated_by], ["casual_day_rate", 1200, manager.id]);
    const entries = await activityOf(former);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]!.activity_type, "single_shift_pay_changed");
    assert.equal(entries[1]!.created_by, manager.id);
    assert.deepEqual([entries[1]!.metadata.from, entries[1]!.metadata.to],
      [{ payWay: "old_contract", casualDayRate: null }, { payWay: "casual_day_rate", casualDayRate: 1200 }]);
    const admin1 = await shiftsOn(origin, asAdmin, BRANCH, SHIFT_DAY, SHIFT_DAY);
    assert.deepEqual((admin1.body as { id: string; pay: unknown }[]).find((s) => s.id === invitationId)!.pay,
      { way: "casual_day_rate", amount: 1200, formula: "Casual day rate ฿1,200 × 1 shift" });
  });
  await check("the same way again writes nothing; a bad rate is refused; switched back to the old contract by the administrator", async () => {
    const same = await call(origin, "PATCH", `/api/schedule/single-shift/invitations/${invitationId}`, asManager, { payWay: "casual_day_rate", casualDayRate: 1200 });
    assert.equal(same.status, 200, show(same));
    assert.equal((await activityOf(former)).length, 2);
    const bad = await call(origin, "PATCH", `/api/schedule/single-shift/invitations/${invitationId}`, asManager, { payWay: "casual_day_rate", casualDayRate: -5 });
    assert.deepEqual([bad.status, bad.body.message], [400, SINGLE_SHIFT_REFUSALS.rate], show(bad));
    const outside = await call(origin, "PATCH", `/api/schedule/single-shift/invitations/${invitationId}`, asOtherManager, { payWay: "old_contract" });
    assert.equal(outside.status, 404, show(outside));
    const back = await call(origin, "PATCH", `/api/schedule/single-shift/invitations/${invitationId}`, asAdmin, { payWay: "old_contract" });
    assert.deepEqual([back.status, back.body.payLabel, back.body.pay?.amount], [200, "On the old contract", 500], show(back));
    const entries = await activityOf(former);
    assert.deepEqual(entries.map((e) => e.activity_type), ["single_shift_invited", "single_shift_pay_changed", "single_shift_pay_changed"]);
    assert.equal(entries[2]!.created_by, admin.id);
    assert.deepEqual(entries[2]!.metadata.to, { payWay: "old_contract", casualDayRate: null });
  });
  await check("a day-rate contract's shift is its day rate; a person with no payroll profile shows no figure", async () => {
    const dr = await invite(origin, asManager, { employeeId: dayRater, shiftRowId: EVENING, shiftDate: SHIFT_DAY });
    assert.equal(dr.status, 201, show(dr));
    const np = await invite(origin, asManager, { employeeId: noProfile, shiftRowId: EVENING, shiftDate: SHIFT_DAY, payWay: "casual_day_rate", casualDayRate: 800 });
    assert.deepEqual([np.status, np.body.payLabel], [201, "Casual day rate ฿800 a day"], show(np));
    const res = await shiftsOn(origin, asAdmin, BRANCH, SHIFT_DAY, SHIFT_DAY);
    const byPerson = new Map((res.body as { employeeId: string; pay: { amount: number | null } }[]).map((s) => [s.employeeId, s.pay.amount]));
    assert.deepEqual([byPerson.get(dayRater), byPerson.get(noProfile)], [450, 800]);
    const switched = await call(origin, "PATCH", `/api/schedule/single-shift/invitations/${np.body.id}`, asManager, { payWay: "old_contract" });
    assert.deepEqual([switched.status, switched.body.payLabel], [200, "On the old contract"], show(switched));
    const after = await shiftsOn(origin, asAdmin, BRANCH, SHIFT_DAY, SHIFT_DAY);
    const np2 = (after.body as { employeeId: string; pay: { amount: number | null; formula: string } }[]).find((s) => s.employeeId === noProfile)!;
    assert.deepEqual([np2.pay.amount, np2.pay.formula], [null, "No payroll profile: the old contract's pay terms are not on file"]);
  });

  // ── 4. The kiosk ───────────────────────────────────────────────────────────
  console.log("4. the kiosk:");
  const onTheDay = await serve(tenAmBangkok(SHIFT_DAY));
  const theDayAfter = await serve(tenAmBangkok(plus(3)));
  const phoneClock = (origin: string, phone: string, secret = DEVICE_SECRET) =>
    call(origin, "POST", "/api/kiosk/clock-phone", "", { phone, photoEvidenceUrl: "", deviceSecret: secret });
  const REFUSED = { success: false, reason: EMPLOYMENT_ENDED, reasonCode: EMPLOYMENT_ENDED, message: KIOSK_EMPLOYMENT_ENDED_MESSAGE };
  await check("before the shift's day the former employee is refused as before, with nothing written", async () => {
    const res = await phoneClock(origin, PHONE.former);
    assert.deepEqual([res.status, res.body], [403, REFUSED], show(res));
    assert.deepEqual(await timeEventsOf(former), []);
  });
  await check("on the shift's day at another branch the kiosk refuses them, with nothing written", async () => {
    const res = await phoneClock(onTheDay, PHONE.former, DEVICE_2_SECRET);
    assert.deepEqual([res.status, res.body], [403, REFUSED], show(res));
    assert.deepEqual(await timeEventsOf(former), []);
  });
  await check("on the shift's day at its branch they clock in, then out", async () => {
    const inRes = await phoneClock(onTheDay, PHONE.former);
    assert.deepEqual([inRes.status, inRes.body.success, inRes.body.eventType], [200, true, "IN"], show(inRes));
    const outRes = await phoneClock(onTheDay, PHONE.former);
    assert.deepEqual([outRes.status, outRes.body.eventType], [200, "OUT"], show(outRes));
    assert.deepEqual((await timeEventsOf(former)).map((e) => [e.event_type, e.branch_id]), [["IN", BRANCH], ["OUT", BRANCH]]);
  });
  await check("a former employee with no single shift that day is still refused there", async () => {
    const res = await phoneClock(onTheDay, PHONE.stranger);
    assert.deepEqual([res.status, res.body], [403, REFUSED], show(res));
    assert.deepEqual(await timeEventsOf(stranger), []);
  });
  await check("the next day the kiosk is closed again by itself", async () => {
    const res = await phoneClock(theDayAfter, PHONE.former);
    assert.deepEqual([res.status, res.body], [403, REFUSED], show(res));
    assert.equal((await timeEventsOf(former)).length, 2);
  });
  await check("a single shift removed from the schedule opens nothing on its day", async () => {
    const [assignment] = await assignmentsOf(dayRater);
    const removed = await call(origin, "DELETE", `/api/schedule/assignments/${assignment!.id}`, asManager);
    assert.equal(removed.status, 204, show(removed));
    const [row] = await invitationsOf(dayRater);
    assert.equal(row!.assignment_id, null, "the invitation keeps its record; its shift is gone");
    const res = await phoneClock(onTheDay, PHONE.dayRate);
    assert.deepEqual([res.status, res.body], [403, REFUSED], show(res));
    assert.deepEqual(await timeEventsOf(dayRater), []);
    const listed = await shiftsOn(origin, asManager, BRANCH, SHIFT_DAY, SHIFT_DAY);
    assert.ok(!(listed.body as { employeeId: string }[]).some((s) => s.employeeId === dayRater), "a removed shift is not listed");
  });

  // ── 5. Access outside the shift ────────────────────────────────────────────
  console.log("5. access outside the shift:");
  await check("the profile stays Left with its last day, and the login stays in pay only", async () => {
    assert.deepEqual(await profileOf(former), { status: "resigned", employment_state: "LEFT", last_working_day: plus(-10) });
    assert.deepEqual(await loginOf(formerLogin.id), { is_active: true, access_mode: "pay_only" });
  });
  await check("the former employee's login is refused the schedule and the single-shift routes, on the shift's day too", async () => {
    for (const at of [origin, onTheDay]) {
      const cookie = await signIn(at, formerLogin.email);
      for (const path of [`/api/rota?scope=me&branchId=${BRANCH}&from=${SHIFT_DAY}&to=${SHIFT_DAY}`, `/api/schedule/single-shift/invitations?branchId=${BRANCH}&startDate=${SHIFT_DAY}&endDate=${SHIFT_DAY}`]) {
        const res = await call(at, "GET", path, cookie);
        assert.deepEqual([res.status, res.body], [403, { reason: EMPLOYMENT_ENDED, reasonCode: EMPLOYMENT_ENDED, message: PAY_ONLY_MESSAGE }], `${path}: ${show(res)}`);
      }
    }
  });

  // ── 6. The night batch ─────────────────────────────────────────────────────
  console.log("6. the 03:00 batch:");
  await check("a person resigned and still Leaving is invited; the batch ends the employment and keeps that single shift", async () => {
    const res = await invite(origin, asManager, { employeeId: leaving, shiftRowId: MORNING, shiftDate: OTHER_DAY });
    assert.equal(res.status, 201, show(res));
    const night = await serve(threeAmBangkok(plus(1)));
    const batch = await fetch(`${night}/api/directory/jobs/reconcile/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${JOBS_KEY}` },
      body: JSON.stringify({ tenantId: TENANT }),
    });
    const body = await batch.json() as { ok: boolean };
    assert.deepEqual([batch.status, body.ok], [200, true], JSON.stringify(body));
    assert.equal((await profileOf(leaving)).employment_state, "LEFT");
    assert.deepEqual((await assignmentsOf(leaving)).map((a) => a.shift_date), [OTHER_DAY]);
    assert.notEqual((await invitationsOf(leaving))[0]!.assignment_id, null);
  });

  console.log(`single-shift.check: ${checks} checks passed`);
} catch (err) {
  console.error("single-shift.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
  // The pure leg's import opened the app's own pool; it holds no connection the check needs.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
