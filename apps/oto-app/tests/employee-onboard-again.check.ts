// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-794 — one person, one profile, across two contracts. Over HTTP against
// the routes as registered:
//
//   1. Fold: a duplicate profile made to put the person on the rota in a new
//      department folds into the original, the one that holds the login and
//      the face: 3 shifts with the duty and the break planned on one, the
//      weekly template shift, the role (a row needing it refuses the original
//      before and takes it after), 1 checklist assignment and 1 task
//      assignment moved, the duplicate deleted, the original's history kept;
//      the other way round
//      is refused; a duplicate with a payroll record is refused (its contract
//      no longer is: contracts move, tests/employee-fold.check.ts); a fold
//      across branches, a move the original already has and a duplicate made
//      with the original's email are handled as before; the stray
//      "Unscheduled work" approval on a day that now has a shift is matched,
//      the other stays pending.
//   2. Offboard: a last working day still to come keeps the login on and the
//      status active (the profile works until then); a last day of today
//      still sets the status at once, as the app always did.
//   3. Onboard Again: refused to staff, to a manager without
//      hr.terminate_employee and to another park group's admin, and for a
//      profile with no offboarding; a start date on or before the last day
//      refused; a later one makes the planned employment and a draft contract
//      in the new department, prefilled from the profile, with the movement
//      logged; a second one is refused; the onboarding steps show basic info,
//      login and face already set up. Create Contract on the profile makes
//      the new employment's contract with no plan named; a contract made
//      before the plan and signed in the notice leaves the profile Leaving;
//      one made in the notice and left unlinked is the plan's when signed,
//      the current contract running to the last day (signing renders a PDF,
//      so Chromium is needed, as for tests/documents.check.ts).
//   4. Shifts in advance: before the switch the new department takes the
//      profile from its start date (and not a day before), the current one up
//      to the last day (and not after); both show in the person's own rota.
//      A plan cancelled before its start date deletes its unsent draft and
//      does nothing else.
//   5. The 03:00 batch on a clock past the last day but before the start date:
//      a leaver with nothing planned is ended (resigned, Left, login off, the
//      platform told); the profile with Onboard Again planned keeps its login,
//      status and shifts. A Left profile onboarded again whose switch-off the
//      platform has had: the plan says a platform administrator reactivates
//      the sign-in, and stops saying so once the login is back on.
//   6. The batch on a clock at the start date starts the employment: the
//      department switched, the status active, the offboarding re-onboarded,
//      the login kept on — or switched back on for a Left profile, the
//      platform's pending switch-off withdrawn; the cancelled plan's profile
//      ends. A start date already past starts at once.
//   7. Rematch: staff are refused; a manager's rematch resolves exactly the
//      pending item whose day now has a shift.
//   8. The new contract ends too: the earlier offboarding is kept as the
//      record and is no longer the profile's; migration 0039 has retired
//      0008's one-offboarding-per-profile index, so the second offboarding is
//      made, 0038 holds one open offboarding per profile, Onboard Again plans
//      the next contract and the batch starts it, ending the employment
//      before; both offboardings stay as records.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/employee-onboard-again.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { REMATCH_NOTE } from "../server/lib/reviewRematch";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("employee-onboard-again.check: DATABASE_URL is not set");
  process.exit(2);
}

// Signing a contract renders its PDF with Chromium, as in the app's image:
// PUPPETEER_EXECUTABLE_PATH names it, or a usual install path is found (as
// tests/documents.check.ts finds it).
const CHROMIUM = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p): p is string => !!p && existsSync(p));
if (!CHROMIUM) {
  console.error("employee-onboard-again.check: no Chromium to render signed contracts with — set PUPPETEER_EXECUTABLE_PATH");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const DAY_MS = 86_400_000;
/** Bangkok's calendar day, as the offboarding route and the night batch compare days. */
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** 03:00 in Bangkok on a day, the 03:00 batch's hour, as an instant. */
const threeAmBangkok = (day: string) => new Date(Date.parse(`${day}T03:00:00+07:00`)).toISOString();
const ddmmyyyy = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;

// ─── One park group, two branches, two departments, and the people ──────────

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST s794 ${run}`, `zz-s794-${run}`]);
const BRANCH_A = randomUUID();
const BRANCH_B = randomUUID();
for (const [id, label] of [[BRANCH_A, "a"], [BRANCH_B, "b"]]) {
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    id, TENANT, `ZZ TEST s794 ${label} ${run}`,
  ]);
}
const RECEPTION = randomUUID();
const PROMOTION = randomUUID();
const RECEPTION_NAME = `ZZ TEST s794 reception ${run}`;
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [RECEPTION, TENANT, RECEPTION_NAME]);
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [PROMOTION, TENANT, `ZZ TEST s794 promotion ${run}`]);
const TEMPLATE = randomUUID();
await q("insert into templates (id, tenant_id, name, html_body) values ($1, $2, $3, $4)", [
  TEMPLATE, TENANT, `ZZ TEST s794 ${run}`,
  "<p>{{contract.position_title}} from {{contract.start_date}} in {{employee.department}}</p>",
]);

async function user(role: string, label: string, access: { scope: "all_branches" | "selected_branches"; branchId: string | null }, platformUserId: string | null = null) {
  const id = randomUUID();
  const email = `zz-s794-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [id, email, hash(PASSWORD), `ZZ TEST s794 ${label} ${run}`, role, platformUserId],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    TENANT, id, access.branchId, access.scope,
  ]);
  return { id, email };
}
const ALL = { scope: "all_branches" as const, branchId: null };
const ONLY_A = { scope: "selected_branches" as const, branchId: BRANCH_A };
const admin = await user("admin", "admin", ALL);
/** Another park group's admin, for the park-group fence. */
const OTHER_TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [OTHER_TENANT, `ZZ TEST s794 other ${run}`, `zz-s794-other-${run}`]);
const otherAdmin = { id: randomUUID(), email: `zz-s794-other-admin-${run}@example.com` };
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password)
   values ($1, $2, $3, 'ZZ TEST s794 other admin', 'admin', true, false)`,
  [otherAdmin.id, otherAdmin.email, hash(PASSWORD)],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [OTHER_TENANT, otherAdmin.id]);
const manager = await user("manager", "manager", ALL);
const staffer = await user("staff", "staff", ONLY_A);
const branchAdmin = await user("operator_admin", "branch-admin", ONLY_A);
/** The logins the profiles sign in with; platform-linked, so a switch-off is queued for the platform. */
const subject = await user("staff", "subject", ONLY_A, randomUUID());
const leaverLogin = await user("staff", "leaver", ONLY_A, randomUUID());
const pastLogin = await user("staff", "past", ONLY_A, randomUUID());
const cancelLogin = await user("staff", "cancel", ONLY_A, randomUUID());
const deliveredLogin = await user("staff", "delivered", ONLY_A, randomUUID());

async function employee(label: string, branchId: string, opts: { userId?: string | null; department?: string } = {}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, employment_state, default_merge_data, primary_department_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'active', 'ACTIVE', $8, $9)`,
    [id, TENANT, branchId, opts.userId ?? null, `ZZ TEST s794 ${label} ${run}`, label, `zz-s794-emp-${label}-${run}@example.com`,
      JSON.stringify({ positionTitle: "ZZ Promoter", salaryThb: 15000 }), opts.department ?? PROMOTION],
  );
  return id;
}
const original = await employee("original", BRANCH_A, { userId: subject.id });
await q("update employees set face_enrollment_status = 'ENROLLED', face_enrolled_at = now() where id = $1", [original]);
const duplicate = await employee("duplicate", BRANCH_A, { department: RECEPTION });
const contracted = await employee("contracted", BRANCH_A);
const elsewhere = await employee("elsewhere", BRANCH_B);
const overlapping = await employee("overlapping", BRANCH_A);
const leaver = await employee("leaver", BRANCH_A, { userId: leaverLogin.id });
const sameDay = await employee("same-day", BRANCH_A);
const pastCase = await employee("past", BRANCH_A, { userId: pastLogin.id });
const cancelled = await employee("cancelled", BRANCH_A, { userId: cancelLogin.id });
const delivered = await employee("delivered", BRANCH_A, { userId: deliveredLogin.id });

// ─── The rota: a Reception and a Promotion row in branch A, one past week ────

const WEEK = "2026-10-05"; // a Monday
const day = (n: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const GROUP = randomUUID();
await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, 'ZZ TEST')", [GROUP, TENANT, BRANCH_A]);
const PLAN = randomUUID();
await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [PLAN, TENANT, BRANCH_A, WEEK]);
async function shiftRow(department: string, start: string, end: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into schedule_shift_rows (id, tenant_id, branch_id, department_id, shift_group_id, week_plan_id, start_time, end_time)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, TENANT, BRANCH_A, department, GROUP, PLAN, start, end],
  );
  return id;
}
const ROW = await shiftRow(RECEPTION, "09:00", "17:00");
const PROMO_ROW = await shiftRow(PROMOTION, "10:00", "18:00");
async function shift(employeeId: string, date: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, employee_id)
     values ($1, $2, $3, $4, $5, 'employee', $6)`,
    [id, TENANT, PLAN, ROW, date, employeeId],
  );
  return id;
}
async function checklist(employeeId: string): Promise<string> {
  const id = randomUUID();
  await q("insert into checklist_templates (id, tenant_id, branch_id, name, assigned_employee_id) values ($1, $2, $3, $4, $5)", [
    id, TENANT, BRANCH_A, `ZZ TEST s794 checklist ${run}`, employeeId,
  ]);
  await q("insert into checklist_template_assignees (tenant_id, template_id, employee_id) values ($1, $2, $3)", [TENANT, id, employeeId]);
  return id;
}
async function task(employeeId: string): Promise<string> {
  const id = randomUUID();
  await q("insert into tasks (id, tenant_id, branch_id, title) values ($1, $2, $3, $4)", [id, TENANT, BRANCH_A, `ZZ TEST s794 task ${run}`]);
  await q("insert into task_assignments (tenant_id, task_id, assignment_type, assignment_id) values ($1, $2, 'employee', $3)", [
    TENANT, id, employeeId,
  ]);
  return id;
}
async function duty(employeeId: string, assignmentId: string, date: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into duty_blocks (id, tenant_id, branch_id, date, employee_id, assignment_id, duty_name, start_time, end_time)
     values ($1, $2, $3, $4, $5, $6, 'ZZ TEST duty', '10:00', '11:00')`,
    [id, TENANT, BRANCH_A, date, employeeId, assignmentId],
  );
  return id;
}
async function shiftBreak(employeeId: string, assignmentId: string, date: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into schedule_shift_breaks (id, tenant_id, branch_id, shift_row_id, shift_date, employee_id, assignment_id, break_start_time, break_end_time)
     values ($1, $2, $3, $4, $5, $6, $7, '12:00', '13:00')`,
    [id, TENANT, BRANCH_A, ROW, date, employeeId, assignmentId],
  );
  return id;
}
/** A row of a weekly schedule template in branch A. */
async function templateRow(department: string): Promise<string> {
  const template = randomUUID();
  await q("insert into schedule_templates (id, tenant_id, branch_id, department_id, name) values ($1, $2, $3, $4, $5)", [
    template, TENANT, BRANCH_A, department, `ZZ TEST s794 template ${run}`,
  ]);
  const id = randomUUID();
  await q(
    "insert into schedule_template_rows (id, tenant_id, template_id, department_id, start_time, end_time) values ($1, $2, $3, $4, '09:00', '17:00')",
    [id, TENANT, template, department],
  );
  return id;
}
/** A face clock-in with no shift that day: what the kiosk's unscheduled route writes. */
async function unscheduled(employeeId: string, date: string) {
  const entry = randomUUID();
  const issue = randomUUID();
  await q(
    `insert into time_entries (id, tenant_id, employee_id, branch_id, shift_date, clock_in_at, status, source_in)
     values ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', 'FACE_KIOSK')`,
    [entry, TENANT, employeeId, BRANCH_A, date, `${date} 02:00`],
  );
  await q(
    `insert into timekeeping_issues (id, tenant_id, employee_id, branch_id, issue_date, issue_type, status, linked_time_entry_id, reason_code, created_by)
     values ($1, $2, $3, $4, $5, 'UNSCHEDULED_WORK', 'OPEN', $6, 'OTHER', 'KIOSK_SYSTEM')`,
    [issue, TENANT, employeeId, BRANCH_A, date, entry],
  );
  return { entry, issue };
}
const review = async (issue: string) =>
  (await q(`select i.status as issue_status, i.resolved_by, i.resolution_note, e.status as entry_status, e.approved_by
              from timekeeping_issues i join time_entries e on e.id = i.linked_time_entry_id where i.id = $1`, [issue]))[0];
/** A payroll line on a profile (a payroll run of its own): kept on the profile it was paid to, so a fold refuses it. */
async function payrollLine(employeeId: string) {
  const operator = randomUUID();
  await q("insert into operators (id, tenant_id, name) values ($1, $2, $3)", [operator, TENANT, `ZZ TEST s794 ${run}`]);
  const [{ id: period }] = await q<{ id: string }>(
    "insert into payroll_periods (tenant_id, operator_id, start_date, end_date) values ($1, $2, '2099-01-01', '2099-01-31') returning id",
    [TENANT, operator],
  );
  const [{ id: payrollRun }] = await q<{ id: string }>(
    "insert into payroll_runs (payroll_period_id, run_number, status, created_by) values ($1, 1, 'DRAFT', $2) returning id",
    [period, admin.id],
  );
  await q(
    "insert into payroll_line_items (payroll_run_id, employee_id, line_type, code, description, amount) values ($1, $2, 'EARNING', 'ZZ TEST', 'ZZ TEST line', 0)",
    [payrollRun, employeeId],
  );
}

// ─── A directory key for the night batch, as script/directory-client.mjs issues them ─

const JOBS_KEY = "odk_" + randomBytes(32).toString("base64url");
await q("insert into directory_clients (tenant_id, name, key_hash, scopes) values ($1, $2, $3, $4)", [
  TENANT, `ZZ TEST s794 ${run}`, createHash("sha256").update(JOBS_KEY).digest("hex"), ["jobs:run"],
]);

// ─── The servers ─────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
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
  PUPPETEER_EXECUTABLE_PATH: CHROMIUM,
};

/** The app's routes on the harness; with `fakeNow`, on a clock that starts at that instant. */
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

let ORIGIN = "";
async function call(method: string, path: string, cookie: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
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

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

interface NightStep { step: string; ok: boolean; counts: Record<string, number>; error?: string }

/** The 03:00 batch for this park group, as the platform's runner asks for it, on the server named. */
async function reconcileAt(origin: string): Promise<NightStep[]> {
  const res = await fetch(`${origin}/api/directory/jobs/reconcile/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${JOBS_KEY}` },
    body: JSON.stringify({ tenantId: TENANT }),
  });
  const body = await res.json() as { ok: boolean; steps: NightStep[] };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.steps;
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const countOf = async (sql: string, params: unknown[]) => Number((await q<{ n: string }>(sql, params))[0]!.n);
const shiftsOf = (employeeId: string) => countOf("select count(*) as n from schedule_assignments where employee_id = $1", [employeeId]);
const profile = async (id: string) => (await q(
  `select status, employment_state, primary_department_id, branch_id, last_working_day::date::text as last_working_day,
          default_merge_data->>'positionTitle' as position, face_enrollment_status
     from employees where id = $1`, [id]))[0]!;
const loginOn = async (userId: string) => (await q<{ is_active: boolean }>("select is_active from users where id = $1", [userId]))[0]!.is_active;
const lifecycle = async (userId: string) => (await q<{ state: string }>(
  "select state from login_lifecycle_events where user_id = $1 order by created_at", [userId])).map((r) => r.state);
const engagementOf = async (employeeId: string) => q(
  `select id, status, start_date::text as start_date, department_id, branch_id, contract_instance_id
     from employee_engagements where employee_id = $1 order by created_at`,
  [employeeId]);
const historyOf = async (employeeId: string) =>
  (await q<{ id: string }>("select id from employee_changes where employee_id = $1", [employeeId])).map((r) => r.id).sort();

try {
  ORIGIN = await serve();
  const as = {
    admin: await signIn(admin.email),
    manager: await signIn(manager.email),
    staff: await signIn(staffer.email),
    branchAdmin: await signIn(branchAdmin.email),
    otherAdmin: await signIn(otherAdmin.email),
    subject: await signIn(subject.email),
  };

  // ── 1. Fold ────────────────────────────────────────────────────────────────
  console.log("1. fold a duplicate into the original:");
  const originalShift = await shift(original, day(3));
  const dupShifts = [await shift(duplicate, day(0)), await shift(duplicate, day(1)), await shift(duplicate, day(2))];
  const dupChecklist = await checklist(duplicate);
  const dupTask = await task(duplicate);
  // The duty and the break planned on one of the duplicate's shifts, its
  // weekly template shift and the role a row of the original's department needs.
  const dupDuty = await duty(duplicate, dupShifts[0]!, day(0));
  const dupBreak = await shiftBreak(duplicate, dupShifts[0]!, day(0));
  const TEMPLATE_ROW = await templateRow(RECEPTION);
  const dupTemplateShift = randomUUID();
  await q("insert into schedule_template_assignments (id, template_row_id, day_of_week, employee_id) values ($1, $2, 0, $3)", [
    dupTemplateShift, TEMPLATE_ROW, duplicate,
  ]);
  const ROLE = randomUUID();
  await q("insert into roles (id, tenant_id, name) values ($1, $2, $3)", [ROLE, TENANT, `ZZ TEST s794 role ${run}`]);
  const dupRole = randomUUID();
  await q("insert into employee_roles (id, employee_id, role_id, is_primary) values ($1, $2, $3, true)", [dupRole, duplicate, ROLE]);
  const ROLE_ROW = await shiftRow(PROMOTION, "11:00", "19:00");
  await q("insert into schedule_shift_row_roles (tenant_id, shift_row_id, role_id) values ($1, $2, $3)", [TENANT, ROLE_ROW, ROLE]);
  const onShiftDay = await unscheduled(original, day(0));
  const offShiftDay = await unscheduled(original, day(5));
  const historyBefore = await historyOf(original);

  await check("another park group's admin finds the profile at none of the doors, and nothing changes", async () => {
    for (const [method, path, body] of [
      ["GET", `/api/employees/${original}/onboard-again`, undefined],
      ["POST", `/api/employees/${original}/onboard-again`, { startDate: plus(30), departmentId: RECEPTION, templateId: TEMPLATE }],
      ["DELETE", `/api/employees/${original}/onboard-again/${randomUUID()}`, undefined],
      ["GET", `/api/employees/${duplicate}/fold-into/${original}/preview`, undefined],
      ["POST", `/api/employees/${duplicate}/fold-into/${original}`, undefined],
      ["POST", `/api/employees/${original}/review/rematch`, undefined],
    ] as const) {
      const res = await call(method, path, as.otherAdmin, body);
      assert.deepEqual([res.status, res.body], [404, { message: "Employee not found" }], `${method} ${path}: ${show(res)}`);
    }
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [duplicate]), 1);
    assert.equal((await engagementOf(original)).length, 0);
  });
  const NONE = { shifts: 0, duties: 0, breaks: 0, templateShifts: 0, roles: 0, checklists: 0, tasks: 0, contracts: 0, timeRecords: 0 };
  const DUPLICATE_HOLDS = { ...NONE, shifts: 3, duties: 1, breaks: 1, templateShifts: 1, roles: 1, checklists: 1, tasks: 1 };
  await check("the preview counts 3 shifts (1 duty, 1 break), 1 template shift, 1 role, 1 checklist, 1 task and writes nothing", async () => {
    const res = await call("GET", `/api/employees/${duplicate}/fold-into/${original}/preview`, as.admin);
    assert.equal(res.status, 200, show(res));
    // The original works on (active, no last working day): nobody is onboarded again, and no face moves.
    assert.deepEqual(res.body, {
      moved: DUPLICATE_HOLDS, skipped: NONE, face: "none", supersededContracts: 0, reonboard: null, deleted: { profile: 1, login: 0 },
    });
    assert.equal(await shiftsOf(duplicate), 3);
    assert.deepEqual(await q("select employee_id from duty_blocks where id = $1", [dupDuty]), [{ employee_id: duplicate }]);
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [duplicate]), 1);
    assert.equal((await review(onShiftDay.issue)).issue_status, "OPEN");
  });
  await check("folding the profile that holds the login and the face into the duplicate is refused", async () => {
    const res = await call("POST", `/api/employees/${original}/fold-into/${duplicate}`, as.admin);
    assert.equal(res.status, 409, show(res));
    assert.match(res.body.message, /Fold the other way round/);
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [original]), 1);
    assert.equal(await shiftsOf(duplicate), 3);
  });
  await check("a manager, and an admin reaching one branch, are refused a fold across branches", async () => {
    const mgr = await call("POST", `/api/employees/${elsewhere}/fold-into/${original}`, as.manager);
    assert.equal(mgr.status, 403, show(mgr));
    const limited = await call("POST", `/api/employees/${elsewhere}/fold-into/${original}`, as.branchAdmin);
    assert.deepEqual([limited.status, limited.body.message], [403, "Both profiles must be in a branch you manage"], show(limited));
    const within = await call("GET", `/api/employees/${duplicate}/fold-into/${original}/preview`, as.branchAdmin);
    assert.equal(within.status, 200, `the same admin previews a fold inside their branch: ${show(within)}`);
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [elsewhere]), 1);
  });
  await check("a duplicate with a payroll record is refused naming it alone (its contract moves now), and keeps its contract and shift", async () => {
    const [{ id: contract }] = await q<{ id: string }>(
      `insert into contract_instances (employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json, created_by, status)
       values ($1, $2, '<p>ZZ</p>', 1, '{}'::jsonb, $3, 'active') returning id`,
      [contracted, TEMPLATE, admin.id],
    );
    await payrollLine(contracted);
    await shift(contracted, day(4));
    const res = await call("POST", `/api/employees/${contracted}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.reason, "has_records");
    assert.deepEqual(res.body.blocking, [{ label: "payroll records", count: 1 }]);
    assert.match(res.body.message, /Payroll records stay on the profile they were paid to/);
    assert.equal(await shiftsOf(contracted), 1);
    assert.deepEqual(await q("select employee_id, status from contract_instances where id = $1", [contract]), [{ employee_id: contracted, status: "active" }]);
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [contracted]), 1);
  });
  await check("before the fold, the row needing the duplicate's role refuses the original", async () => {
    const res = await call("POST", "/api/schedule/assignments", as.manager, { shiftRowId: ROLE_ROW, shiftDate: plus(1), employeeId: original, assigneeType: "employee" });
    assert.deepEqual([res.status, res.body.reasonCode], [400, "ROLE_MISMATCH"], show(res));
  });
  await check("the fold moves all of it onto the original, deletes the duplicate and keeps the original's history", async () => {
    const res = await call("POST", `/api/employees/${duplicate}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.moved, DUPLICATE_HOLDS);
    assert.deepEqual(res.body.skipped, NONE);
    assert.deepEqual(res.body.deleted, { profile: 1, login: 0 });
    assert.deepEqual(res.body.rematch, { matched: 1, stillPending: 1 });
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [duplicate]), 0);
    assert.deepEqual(
      (await q<{ id: string }>("select id from schedule_assignments where employee_id = $1", [original])).map((r) => r.id).sort(),
      [originalShift, ...dupShifts].sort(),
    );
    assert.deepEqual(await q("select employee_id from checklist_template_assignees where template_id = $1", [dupChecklist]), [{ employee_id: original }]);
    assert.deepEqual(await q("select assigned_employee_id from checklist_templates where id = $1", [dupChecklist]), [{ assigned_employee_id: original }]);
    assert.deepEqual(await q("select assignment_id from task_assignments where task_id = $1", [dupTask]), [{ assignment_id: original }]);
    // The duty and the break stay on the shift they were planned on, now the original's.
    assert.deepEqual(await q("select employee_id, assignment_id from duty_blocks where id = $1", [dupDuty]), [{ employee_id: original, assignment_id: dupShifts[0] }]);
    assert.deepEqual(await q("select employee_id, assignment_id from schedule_shift_breaks where id = $1", [dupBreak]), [{ employee_id: original, assignment_id: dupShifts[0] }]);
    assert.deepEqual(await q("select employee_id from schedule_template_assignments where id = $1", [dupTemplateShift]), [{ employee_id: original }]);
    assert.deepEqual(await q("select employee_id, is_primary from employee_roles where id = $1", [dupRole]), [{ employee_id: original, is_primary: true }]);
    assert.deepEqual(await historyOf(original), historyBefore);
    assert.equal(await loginOn(subject.id), true);
    assert.deepEqual([(await profile(original)).status, (await profile(original)).face_enrollment_status], ["active", "ENROLLED"]);
  });
  await check("after the fold the row needing that role takes the original", async () => {
    const res = await call("POST", "/api/schedule/assignments", as.manager, { shiftRowId: ROLE_ROW, shiftDate: plus(1), employeeId: original, assigneeType: "employee" });
    assert.equal(res.status, 201, show(res));
    // Only to prove the role came across: the shift is not one the later checks count.
    await q("delete from schedule_assignments where id = $1", [res.body.id]);
  });
  await check("the fold matched the approval on a day that now has a shift, and left the other pending", async () => {
    assert.deepEqual(await review(onShiftDay.issue), {
      issue_status: "RESOLVED", resolved_by: admin.id, resolution_note: REMATCH_NOTE, entry_status: "APPROVED", approved_by: admin.id,
    });
    assert.deepEqual(await review(offShiftDay.issue), {
      issue_status: "OPEN", resolved_by: null, resolution_note: null, entry_status: "PENDING_APPROVAL", approved_by: null,
    });
  });
  await check("a move the original already has is skipped and counted", async () => {
    const overlapShift = await shift(overlapping, day(3)); // the original already works this shift
    await duty(overlapping, overlapShift, day(3)); // planned on the skipped shift: it goes with it
    const sharedChecklist = await checklist(overlapping);
    await q("insert into checklist_template_assignees (tenant_id, template_id, employee_id) values ($1, $2, $3)", [TENANT, sharedChecklist, original]);
    await q("insert into schedule_template_assignments (template_row_id, day_of_week, employee_id) values ($1, 0, $2)", [TEMPLATE_ROW, overlapping]);
    await q("insert into employee_roles (employee_id, role_id) values ($1, $2)", [overlapping, ROLE]); // the original holds it now
    const res = await call("POST", `/api/employees/${overlapping}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.moved, res.body.skipped], [
      NONE, { ...NONE, shifts: 1, duties: 1, templateShifts: 1, roles: 1, checklists: 1 },
    ]);
    assert.equal(await countOf("select count(*) as n from schedule_assignments where employee_id = $1 and shift_date = $2", [original, day(3)]), 1);
    assert.deepEqual(await q("select employee_id from checklist_template_assignees where template_id = $1", [sharedChecklist]), [{ employee_id: original }]);
    assert.equal(await countOf("select count(*) as n from schedule_template_assignments where template_row_id = $1 and employee_id = $2", [TEMPLATE_ROW, original]), 1);
    assert.equal(await countOf("select count(*) as n from employee_roles where role_id = $1 and employee_id = $2", [ROLE, original]), 1);
  });
  await check("a duplicate made with the original's email takes neither the original's person record nor its login", async () => {
    // The employee delete finds a profile's person and login by email when it
    // links none; for a twin that is the original's own.
    const [{ email }] = await q<{ email: string }>("select email from employees where id = $1", [original]);
    const person = randomUUID();
    await q("insert into people (id, tenant_id, full_name, email, person_type) values ($1, $2, 'ZZ TEST s794 person', $3, 'EMPLOYEE')", [person, TENANT, email]);
    await q("update employees set person_id = $2 where id = $1", [original, person]);
    await q(
      `insert into access_policies (tenant_id, person_id, access_level, modules, branch_scope, core_account_enabled, core_user_id)
       values ($1, $2, 'STAFF', '{}'::jsonb, 'SELECTED', true, $3)`,
      [TENANT, person, subject.id],
    );
    const twin = randomUUID();
    await q(
      `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status)
       values ($1, $2, $3, 'ZZ TEST s794 twin', 'twin', $4, 'active')`,
      [twin, TENANT, BRANCH_A, email],
    );
    const twinTask = await task(twin);
    const res = await call("POST", `/api/employees/${twin}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.moved.tasks, res.body.deleted], [1, { profile: 1, login: 0 }]);
    assert.deepEqual(await q("select assignment_id from task_assignments where task_id = $1", [twinTask]), [{ assignment_id: original }]);
    assert.equal(await loginOn(subject.id), true);
    assert.deepEqual(await q("select id from people where id = $1", [person]), [{ id: person }]);
    assert.deepEqual(await q("select core_user_id from access_policies where person_id = $1", [person]), [{ core_user_id: subject.id }]);
    assert.deepEqual(await q("select user_id, person_id from employees where id = $1", [original]), [{ user_id: subject.id, person_id: person }]);
  });

  // ── 2. Offboard ───────────────────────────────────────────────────────────
  console.log("2. offboard:");
  const LAST_DAY = plus(3);
  const START = plus(5);
  const offboard = (id: string, lastWorkingDay: string) => call("POST", `/api/employees/${id}/offboarding`, as.admin, {
    offboardingType: "resignation", reasonCode: "personal_reasons", lastWorkingDay,
  });
  await check("a last working day still to come keeps the profile working: status active, Leaving, login on, nothing told to the platform", async () => {
    const res = await offboard(original, LAST_DAY);
    assert.equal(res.status, 201, show(res));
    const row = await profile(original);
    assert.deepEqual([row.status, row.employment_state, row.last_working_day, row.face_enrollment_status], ["active", "LEAVING", LAST_DAY, "ENROLLED"]);
    assert.deepEqual(await q("select offboarding_type from employees where id = $1", [original]), [{ offboarding_type: "RESIGNATION" }]);
    assert.equal(await loginOn(subject.id), true);
    assert.deepEqual(await lifecycle(subject.id), []);
    for (const [id, last] of [[leaver, plus(2)], [cancelled, plus(4)]] as const) {
      const other = await offboard(id, last);
      assert.equal(other.status, 201, show(other));
      assert.equal((await profile(id)).status, "active");
    }
  });
  await check("a last working day of today still sets the status at once, as the app always did", async () => {
    const res = await offboard(sameDay, today);
    assert.equal(res.status, 201, show(res));
    const row = await profile(sameDay);
    assert.deepEqual([row.status, row.employment_state], ["resigned", "LEAVING"]);
  });

  // ── 3. Onboard Again ──────────────────────────────────────────────────────
  console.log("3. Onboard Again:");
  const onboardBody = { startDate: START, departmentId: RECEPTION, positionTitle: "ZZ Receptionist", templateId: TEMPLATE };
  await check("staff, and a manager without hr.terminate_employee, are refused and nothing is written", async () => {
    const staff = await call("POST", `/api/employees/${original}/onboard-again`, as.staff, onboardBody);
    assert.equal(staff.status, 403, show(staff));
    const mgr = await call("POST", `/api/employees/${original}/onboard-again`, as.manager, onboardBody);
    assert.equal(mgr.status, 403, show(mgr));
    assert.match(mgr.body.message, /hr\.terminate_employee/);
    assert.equal((await engagementOf(original)).length, 0);
  });
  await check("a profile with no offboarding is refused", async () => {
    const res = await call("POST", `/api/employees/${elsewhere}/onboard-again`, as.admin, { ...onboardBody, branchId: BRANCH_B });
    assert.equal(res.status, 409, show(res));
    assert.match(res.body.message, /set the last working day/);
    assert.equal((await engagementOf(elsewhere)).length, 0);
  });
  await check("a start date on or before the last working day is refused", async () => {
    for (const startDate of [LAST_DAY, plus(1)]) {
      const res = await call("POST", `/api/employees/${original}/onboard-again`, as.admin, { ...onboardBody, startDate });
      assert.equal(res.status, 409, show(res));
      assert.match(res.body.message, /after the last working day/);
    }
    assert.equal((await engagementOf(original)).length, 0);
  });
  let draftContract = "";
  await check("Onboard Again with a later start date plans the employment and starts a draft contract in the new department", async () => {
    const res = await call("POST", `/api/employees/${original}/onboard-again`, as.admin, onboardBody);
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.started, false);
    const [engagement] = await engagementOf(original);
    assert.deepEqual(
      [engagement!.status, engagement!.start_date, engagement!.department_id, engagement!.branch_id],
      ["planned", START, RECEPTION, BRANCH_A],
    );
    draftContract = engagement!.contract_instance_id as string;
    assert.equal(res.body.contract.id, draftContract);
    const [contract] = await q<{ status: string; signing_status: string; template_id: string; html: string; start: string; position: string; salary: number }>(
      `select status, signing_status, template_id, template_snapshot_html as html, merge_data_json->>'startDate' as start,
              merge_data_json->>'positionTitle' as position, (merge_data_json->>'salaryThb')::int as salary
         from contract_instances where id = $1 and employee_id = $2`, [draftContract, original]);
    assert.deepEqual([contract!.status, contract!.signing_status, contract!.template_id, contract!.start, contract!.position, contract!.salary],
      ["draft", "not_sent", TEMPLATE, START, "ZZ Receptionist", 15000]);
    assert.ok(contract!.html.includes(RECEPTION_NAME), "the draft names the new department");
    assert.ok(contract!.html.includes(ddmmyyyy(START)), "the draft carries the new start date");
    // The current employment is untouched until its last day.
    const row = await profile(original);
    assert.deepEqual([row.status, row.employment_state, row.primary_department_id, row.position], ["active", "LEAVING", PROMOTION, "ZZ Promoter"]);
    assert.equal(await loginOn(subject.id), true);
    assert.deepEqual(
      await q(`select change_type, new_department_id, contract_instance_id, effective_date::date::text as effective
                 from employee_changes where employee_id = $1 and change_type = 'onboard_again'`, [original]),
      [{ change_type: "onboard_again", new_department_id: RECEPTION, contract_instance_id: draftContract, effective: START }],
    );
  });
  await check("a second planned employment is refused", async () => {
    const res = await call("POST", `/api/employees/${original}/onboard-again`, as.admin, { ...onboardBody, startDate: plus(9) });
    assert.equal(res.status, 409, show(res));
    assert.match(res.body.message, /already planned/);
    assert.equal((await engagementOf(original)).length, 1);
  });
  await check("the profile page reads the plan, and the onboarding steps show basic info, login and face already set up", async () => {
    const read = await call("GET", `/api/employees/${original}/onboard-again`, as.manager);
    assert.equal(read.status, 200, show(read));
    assert.deepEqual(
      [read.body.engagement.startDate, read.body.engagement.department.id, read.body.engagement.contract.id, read.body.engagement.contract.status],
      [START, RECEPTION, draftContract, "draft"],
    );
    const steps = await call("GET", `/api/employees/${original}/onboarding-status`, as.admin);
    assert.equal(steps.status, 200, show(steps));
    assert.deepEqual(steps.body.onboardAgain.alreadySetUp, { essentialInfo: true, login: true, face: true });
    assert.equal(steps.body.steps.step2_contractGenerated.contractId, draftContract);
    assert.deepEqual(
      [steps.body.steps.step2_contractGenerated.complete, steps.body.steps.step3_contractSent.complete, steps.body.steps.step4_contractSigned.complete],
      [true, false, false],
    );
  });

  // The contract steps while the current contract still runs: Create Contract
  // on the profile, then signing. The current (Promotion) contract is active.
  const contractsOf = async (employeeId: string) => q<{ id: string; status: string; signing_status: string; archived: boolean }>(
    `select id, status, signing_status, archived_at is not null as archived from contract_instances where employee_id = $1`, [employeeId]);
  const statusOf = async (contractId: string) => (await contractsOf(original)).find((c) => c.id === contractId);
  const signable = async (createdAt: string) => {
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    await q(
      `insert into contract_instances (id, employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json,
                                       created_by, status, signing_status, signing_token, signing_token_expires_at, created_at)
       values ($1, $2, $3, '<p>ZZ TEST</p>', 1, '{}'::jsonb, $4, 'finalized', 'awaiting_signature', $5, now() + interval '7 days', ${createdAt})`,
      [id, original, TEMPLATE, admin.id, token],
    );
    return { id, token };
  };
  const SIGNATURE = `data:image/png;base64,${randomBytes(120).toString("base64")}`;
  const sign = (token: string) => call("POST", `/api/signing/${token}/sign`, "", { signatureImage: SIGNATURE, agreedToTerms: true });
  const promotionContract = randomUUID();
  await q(
    `insert into contract_instances (id, employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json,
                                     created_by, status, signing_status, created_at)
     values ($1, $2, $3, '<p>ZZ TEST</p>', 1, '{}'::jsonb, $4, 'active', 'signed', now() - interval '90 days')`,
    [promotionContract, original, TEMPLATE, admin.id],
  );
  let plannedContract = draftContract;
  await check("Create Contract on the profile while Onboard Again is planned makes the new employment's contract, even with no plan named", async () => {
    const res = await call("POST", "/api/contracts", as.admin, {
      employeeId: original, templateId: TEMPLATE, status: "draft",
      mergeDataJson: { positionTitle: "ZZ Receptionist", salaryThb: 15000, startDate: START },
    });
    assert.equal(res.status, 201, show(res));
    plannedContract = res.body.id;
    const [engagement] = await engagementOf(original);
    assert.equal(engagement!.contract_instance_id, plannedContract, "the plan's contract is the new one");
    assert.equal((await statusOf(draftContract))!.archived, true, "the unsent draft it replaces is archived");
    const [{ html }] = await q<{ html: string }>("select template_snapshot_html as html from contract_instances where id = $1", [plannedContract]);
    assert.ok(html.includes(RECEPTION_NAME), "compiled with the new department");
  });
  await check("a contract made before the plan, signed during the notice, is signed as before but leaves the profile Leaving", async () => {
    const earlier = await signable("now() - interval '30 days'");
    const res = await sign(earlier.token);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(await statusOf(earlier.id), { id: earlier.id, status: "active", signing_status: "signed", archived: false });
    assert.equal((await statusOf(promotionContract))!.status, "superseded");
    const row = await profile(original);
    assert.deepEqual([row.status, row.employment_state, row.primary_department_id], ["active", "LEAVING", PROMOTION]);
    assert.equal((await engagementOf(original))[0]!.contract_instance_id, plannedContract, "the plan keeps its own contract");
  });
  await check("a contract made during the notice and left unlinked is the plan's when signed: the current contract stays active, the profile Leaving", async () => {
    const [{ id: currentContract }] = await q<{ id: string }>(
      "select id from contract_instances where employee_id = $1 and status = 'active'", [original]);
    const unlinked = await signable("now()");
    const res = await sign(unlinked.token);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(await statusOf(unlinked.id), { id: unlinked.id, status: "finalized", signing_status: "signed", archived: false });
    assert.equal((await statusOf(currentContract!))!.status, "active", "the current contract runs to the last working day");
    const row = await profile(original);
    assert.deepEqual([row.status, row.employment_state, row.primary_department_id], ["active", "LEAVING", PROMOTION]);
    assert.equal((await engagementOf(original))[0]!.contract_instance_id, unlinked.id);
    assert.equal((await statusOf(plannedContract))!.archived, true, "the unsent draft it replaces is archived");
    plannedContract = unlinked.id;
  });

  // ── 4. Shifts in advance ──────────────────────────────────────────────────
  console.log("4. shifts in the new department before the start date:");
  const assign = (shiftRowId: string, shiftDate: string) =>
    call("POST", "/api/schedule/assignments", as.manager, { shiftRowId, shiftDate, employeeId: original, assigneeType: "employee" });
  const eligibleFor = async (shiftRowId: string, date: string) => {
    const res = await call("GET", `/api/schedule/shift-rows/${shiftRowId}/eligible-employees?date=${date}`, as.manager);
    assert.equal(res.status, 200, show(res));
    return (res.body as { id: string }[]).some((e) => e.id === original);
  };
  let receptionShift = "";
  await check("before the switch the new department takes the profile from the start date, and not a day before", async () => {
    assert.equal(await eligibleFor(ROW, START), true, "listed for the new department on its start date");
    assert.equal(await eligibleFor(ROW, plus(2)), false, "not listed for the new department before it");
    const onStart = await assign(ROW, START);
    assert.equal(onStart.status, 201, show(onStart));
    receptionShift = onStart.body.id;
    const gap = await assign(ROW, plus(4));
    assert.deepEqual([gap.status, gap.body.reasonCode], [400, "EMPLOYMENT_ENDED"], show(gap));
    const early = await assign(ROW, plus(2));
    assert.deepEqual([early.status, early.body.reasonCode], [400, "DEPT_MISMATCH"], show(early));
  });
  let promotionShift = "";
  await check("the current department still takes the profile up to the last working day, and not after", async () => {
    assert.equal(await eligibleFor(PROMO_ROW, LAST_DAY), true, "listed for the current department on the last day");
    assert.equal(await eligibleFor(PROMO_ROW, plus(6)), false, "not listed for the current department once the new employment starts");
    const lastDay = await assign(PROMO_ROW, LAST_DAY);
    assert.equal(lastDay.status, 201, show(lastDay));
    promotionShift = lastDay.body.id;
    const after = await assign(PROMO_ROW, plus(6));
    assert.deepEqual([after.status, after.body.reasonCode], [400, "DEPT_MISMATCH"], show(after));
  });
  await check("the person sees both departments' shifts in their own rota as soon as they are added", async () => {
    const rota = await call("GET", `/api/rota?scope=me&branchId=${BRANCH_A}&from=${today}&to=${plus(7)}`, as.subject);
    assert.equal(rota.status, 200, show(rota));
    const mine = (rota.body as { assignmentId: string; date: string; departmentId: string }[])
      .map((s) => [s.assignmentId, s.date, s.departmentId].join(" ")).sort();
    assert.deepEqual(mine, [[promotionShift, LAST_DAY, PROMOTION].join(" "), [receptionShift, START, RECEPTION].join(" ")].sort());
  });
  await check("the schedule's employee list carries the planned employment", async () => {
    const list = await call("GET", `/api/employees?branchId=${BRANCH_A}&schedulingWeekStart=${today}`, as.manager);
    assert.equal(list.status, 200, show(list));
    const row = (list.body as { id: string; schedulingEngagement?: unknown }[]).find((e) => e.id === original);
    assert.deepEqual(row?.schedulingEngagement, { startDate: START, departmentId: RECEPTION, branchId: BRANCH_A });
  });
  await check("a planned employment can be cancelled before its start date: its unsent draft is deleted, and nothing else changes", async () => {
    const plan = await call("POST", `/api/employees/${cancelled}/onboard-again`, as.admin, { ...onboardBody, startDate: plus(6) });
    assert.equal(plan.status, 201, show(plan));
    const before = await profile(cancelled);
    const res = await call("DELETE", `/api/employees/${cancelled}/onboard-again/${plan.body.engagementId}`, as.admin);
    assert.deepEqual([res.status, res.body], [200, { cancelled: true, contractId: plan.body.contract.id, contractDeleted: true }], show(res));
    assert.deepEqual((await engagementOf(cancelled)).map((g) => g.status), ["cancelled"]);
    assert.deepEqual(await profile(cancelled), before);
    assert.equal(await loginOn(cancelLogin.id), true);
    // The profile reads as before the plan: the draft made for it is gone (the app deletes drafts, SCRUM-794).
    assert.equal(await countOf("select count(*) as n from contract_instances where id = $1", [plan.body.contract.id]), 0);
    const again = await call("DELETE", `/api/employees/${cancelled}/onboard-again/${plan.body.engagementId}`, as.admin);
    assert.equal(again.status, 404, show(again));
  });

  // ── 5. The night after the last day, before the start date ───────────────
  console.log("5. the 03:00 batch past the last day, before the start date:");
  const nightBetween = await serve(threeAmBangkok(plus(4)));
  await check("a leaver with nothing planned is ended: resigned, Left, login off, the platform told; the planned profile keeps everything", async () => {
    const steps = await reconcileAt(nightBetween);
    assert.equal(steps.find((s) => s.step === "statusTransitions")!.counts.onboarded, 0);
    const ended = await profile(leaver);
    assert.deepEqual([ended.status, ended.employment_state], ["resigned", "LEFT"]);
    assert.equal(await loginOn(leaverLogin.id), false);
    assert.deepEqual(await lifecycle(leaverLogin.id), ["pending"]);
    const kept = await profile(original);
    assert.deepEqual([kept.status, kept.employment_state, kept.primary_department_id], ["active", "LEAVING", PROMOTION]);
    assert.equal(await loginOn(subject.id), true);
    assert.deepEqual(await lifecycle(subject.id), []);
    assert.deepEqual((await engagementOf(original)).map((g) => g.status), ["planned"]);
    assert.equal(await countOf("select count(*) as n from schedule_assignments where id = $1", [receptionShift]), 1, "the new department's shift stays");
    // The cancelled plan's profile has not reached its last day yet.
    assert.deepEqual([(await profile(cancelled)).status, await loginOn(cancelLogin.id)], ["active", true]);
  });
  await check("a Left profile is onboarded again, its login staying off until the start date", async () => {
    const res = await call("POST", `/api/employees/${leaver}/onboard-again`, as.admin, { ...onboardBody, startDate: plus(3) });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.started, false);
    assert.equal(await loginOn(leaverLogin.id), false);
    // Its switch-off still waits for the platform: the start withdraws it, nobody needs to act.
    assert.equal(res.body.platformSignInOff, false);
  });
  await check("a Left profile whose switch-off the platform has had: the plan says a platform administrator reactivates the sign-in", async () => {
    const off = await offboard(delivered, plus(-2));
    assert.equal(off.status, 201, show(off));
    assert.equal(await loginOn(deliveredLogin.id), false);
    // What the platform's consumer marks once it has switched the account off (the harness runs no transport).
    await q("update login_lifecycle_events set state = 'delivered', settled_at = now() where user_id = $1 and state = 'pending'", [deliveredLogin.id]);
    const res = await call("POST", `/api/employees/${delivered}/onboard-again`, as.admin, { ...onboardBody, startDate: plus(30) });
    assert.deepEqual([res.status, res.body.started, res.body.platformSignInOff], [201, false, true], show(res));
    const read = await call("GET", `/api/employees/${delivered}/onboard-again`, as.manager);
    assert.equal(read.body.engagement.platformSignInOff, true, show(read));
    // A platform administrator's reactivation switches the app login back on (activateOtoAppUser): then nothing is asked.
    await q("update users set is_active = true where id = $1", [deliveredLogin.id]);
    const after = await call("GET", `/api/employees/${delivered}/onboard-again`, as.manager);
    assert.equal(after.body.engagement.platformSignInOff, false, show(after));
  });

  // ── 6. The night of the start date ────────────────────────────────────────
  console.log("6. the 03:00 batch on the start date:");
  const nightOfStart = await serve(threeAmBangkok(START));
  await check("the employment starts: the new department, active, the offboarding re-onboarded, the login kept on", async () => {
    const steps = await reconcileAt(nightOfStart);
    assert.equal(steps.find((s) => s.step === "statusTransitions")!.counts.onboarded, 2);
    const row = await profile(original);
    assert.deepEqual(
      [row.status, row.employment_state, row.primary_department_id, row.branch_id, row.last_working_day, row.position, row.face_enrollment_status],
      ["active", "ACTIVE", RECEPTION, BRANCH_A, null, "ZZ Receptionist", "ENROLLED"],
    );
    assert.deepEqual((await engagementOf(original)).map((g) => g.status), ["active"]);
    assert.equal(await countOf("select count(*) as n from employee_offboarding where employee_id = $1 and reonboarded_at is not null", [original]), 1);
    assert.equal(await loginOn(subject.id), true);
    assert.deepEqual(await lifecycle(subject.id), []);
    assert.equal(await countOf("select count(*) as n from schedule_assignments where id = any($1::varchar[])", [[receptionShift, promotionShift]]), 2);
  });
  await check("the new contract signed during the notice is the active contract from the start date; the one before it is superseded", async () => {
    assert.deepEqual(
      (await contractsOf(original)).filter((c) => c.status === "active").map((c) => [c.id, c.signing_status]),
      [[plannedContract, "signed"]],
    );
    assert.equal((await statusOf(promotionContract))!.status, "superseded");
  });
  await check("the Left profile's login is switched back on, and the platform's pending switch-off withdrawn", async () => {
    const row = await profile(leaver);
    assert.deepEqual([row.status, row.employment_state, row.primary_department_id], ["active", "ACTIVE", RECEPTION]);
    assert.equal(await loginOn(leaverLogin.id), true);
    assert.deepEqual(await lifecycle(leaverLogin.id), ["superseded"]);
  });
  await check("the cancelled plan's profile is ended once its last day has passed", async () => {
    assert.deepEqual([(await profile(cancelled)).status, await loginOn(cancelLogin.id)], ["resigned", false]);
  });
  await check("a start date already past starts the employment at once", async () => {
    const off = await offboard(pastCase, plus(-3));
    assert.equal(off.status, 201, show(off));
    assert.deepEqual([(await profile(pastCase)).status, await loginOn(pastLogin.id)], ["resigned", false]);
    const res = await call("POST", `/api/employees/${pastCase}/onboard-again`, as.admin, { ...onboardBody, startDate: plus(-1) });
    assert.equal(res.status, 201, show(res));
    assert.deepEqual([res.body.started, res.body.login], [true, "reactivated"]);
    const row = await profile(pastCase);
    assert.deepEqual([row.status, row.employment_state, row.primary_department_id], ["active", "ACTIVE", RECEPTION]);
    assert.equal(await loginOn(pastLogin.id), true);
    assert.deepEqual(await lifecycle(pastLogin.id), ["superseded"]);
  });

  // ── 7. Rematch ────────────────────────────────────────────────────────────
  console.log("7. rematch:");
  await check("staff are refused", async () => {
    const res = await call("POST", `/api/employees/${original}/review/rematch`, as.staff);
    assert.equal(res.status, 403, show(res));
    assert.equal((await review(offShiftDay.issue)).issue_status, "OPEN");
  });
  await check("a manager's rematch resolves exactly the pending item whose day now has a shift", async () => {
    const before = await call("POST", `/api/employees/${original}/review/rematch`, as.manager);
    assert.deepEqual([before.status, before.body], [200, { matched: 0, stillPending: 1 }], show(before));
    const second = await unscheduled(original, day(6));
    await shift(original, day(5));
    const res = await call("POST", `/api/employees/${original}/review/rematch`, as.manager);
    assert.deepEqual([res.status, res.body], [200, { matched: 1, stillPending: 1 }], show(res));
    assert.deepEqual(await review(offShiftDay.issue), {
      issue_status: "RESOLVED", resolved_by: manager.id, resolution_note: REMATCH_NOTE, entry_status: "APPROVED", approved_by: manager.id,
    });
    assert.equal((await review(second.issue)).issue_status, "OPEN");
  });

  // ── 8. The new contract ends too, on the same profile ─────────────────────
  console.log("8. the new contract ends, and the next one is planned, on the same profile:");
  const [{ id: firstOffboarding }] = await q<{ id: string }>("select id from employee_offboarding where employee_id = $1", [original]);
  await check("the offboarding of the contract that ended is kept as its record, and is no longer the profile's offboarding", async () => {
    const read = await call("GET", `/api/employees/${original}/offboarding`, as.admin);
    assert.deepEqual([read.status, read.body], [200, null], show(read));
    const edit = await call("PATCH", `/api/employees/${original}/offboarding`, as.admin, { notes: "ZZ TEST" });
    assert.equal(edit.status, 404, show(edit));
    assert.equal(await countOf("select count(*) as n from employee_offboarding where id = $1 and reonboarded_at is not null", [firstOffboarding]), 1);
  });
  const NEXT_LAST_DAY = plus(20);
  const NEXT_START = plus(22);
  const indexStands = async (name: string) => (await countOf(
    "select count(*) as n from pg_indexes where schemaname = 'otoapp' and indexname = $1", [name])) === 1;
  // The rule since migration 0039: 0008's one offboarding per profile, ever,
  // is retired; 0038's one OPEN offboarding per profile is the backstop.
  await check("on a database migrated from empty, 0008's one-offboarding-per-profile index is retired (0039) and 0038's one-open index stands", async () => {
    assert.equal(await indexStands("employee_offboarding_employee_unique"), false);
    assert.equal(await indexStands("employee_offboarding_one_open"), true);
  });
  let secondOffboarding = "";
  await check("the new contract is offboarded (201), and the earlier offboarding keeps its re-onboarded mark", async () => {
    const res = await offboard(original, NEXT_LAST_DAY);
    assert.equal(res.status, 201, show(res));
    secondOffboarding = res.body.id;
    const read = await call("GET", `/api/employees/${original}/offboarding`, as.admin);
    assert.equal(read.body?.id, secondOffboarding, show(read));
    const row = await profile(original);
    assert.deepEqual([row.status, row.employment_state, row.last_working_day], ["active", "LEAVING", NEXT_LAST_DAY]);
    assert.equal(await loginOn(subject.id), true);
    assert.equal(await countOf("select count(*) as n from employee_offboarding where id = $1 and reonboarded_at is not null", [firstOffboarding]), 1);
    const twice = await offboard(original, plus(21));
    assert.deepEqual([twice.status, twice.body.message], [409, "Offboarding already exists for this employee"], show(twice));
  });
  await check("the database itself holds one open offboarding per profile (0038)", async () => {
    await assert.rejects(
      q(`insert into employee_offboarding (employee_id, offboarding_type, reason_code, last_working_day, created_by)
         values ($1, 'resignation', 'personal_reasons', now(), $2)`, [original, admin.id]),
      (err: { code?: string; constraint?: string }) => err.code === "23505" && err.constraint === "employee_offboarding_one_open",
    );
  });
  await check("and Onboard Again plans the next contract on the same profile (201), following the new offboarding", async () => {
    const res = await call("POST", `/api/employees/${original}/onboard-again`, as.admin, {
      ...onboardBody, startDate: NEXT_START, departmentId: PROMOTION, positionTitle: "ZZ Promoter",
    });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.started, false);
    const plans = await q<{ status: string; offboarding_id: string | null }>(
      "select status, offboarding_id from employee_engagements where employee_id = $1 order by created_at", [original]);
    assert.deepEqual(plans.map((g) => g.status), ["active", "planned"]);
    assert.equal(plans[1]!.offboarding_id, secondOffboarding);
  });
  await check("the batch on its start date starts it: the earlier employment ended, the new offboarding re-onboarded, the login kept on", async () => {
    const steps = await reconcileAt(await serve(threeAmBangkok(NEXT_START)));
    assert.equal(steps.find((s) => s.step === "statusTransitions")!.counts.onboarded, 1);
    assert.deepEqual((await engagementOf(original)).map((g) => g.status), ["ended", "active"]);
    const row = await profile(original);
    assert.deepEqual([row.status, row.employment_state, row.primary_department_id, row.last_working_day], ["active", "ACTIVE", PROMOTION, null]);
    assert.equal(await countOf("select count(*) as n from employee_offboarding where employee_id = $1 and reonboarded_at is not null", [original]), 2);
    assert.equal(await loginOn(subject.id), true);
  });
  await check("the profile keeps both offboardings as the records of the contracts they ended, none open, and is nobody's duplicate", async () => {
    assert.deepEqual(
      (await q<{ id: string; open: boolean }>(
        "select id, reonboarded_at is null as open from employee_offboarding where employee_id = $1 order by created_at", [original])),
      [{ id: firstOffboarding, open: false }, { id: secondOffboarding, open: false }],
    );
    const read = await call("GET", `/api/employees/${original}/offboarding`, as.admin);
    assert.deepEqual([read.status, read.body], [200, null], show(read));
  });

  console.log(`employee-onboard-again.check: ${checks} checks passed`);
} catch (err) {
  console.error("employee-onboard-again.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
