// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-794 — one person on two profiles: the original offboarded (Left, its
// login switched off) yet still the one she signs in and clocks in with, and
// a duplicate made only to put her on the rota in a new position. Over HTTP
// against the routes as registered:
//
//   1. Offboarding (the app's own route) leaves the original Left with its
//      login off and a deactivation queued for the platform.
//   2. Another park group's admin finds the employee at none of the doors.
//      Rehire: staff and a manager without hr.terminate_employee are refused,
//      an active profile is refused; an admin's rehire makes the original
//      Active in the new position, department and branch, switches its login
//      back on, supersedes the queued deactivation, writes the "rehired"
//      movement, keeps the offboarding row as the record, and leaves face
//      enrolment alone.
//   3. Fold: the preview counts without writing; a duplicate with 3 shifts, 1
//      checklist assignment and 1 task assignment folds into the original
//      (3/1/1 moved, the duplicate gone, the original's history intact), and
//      the stray "Unscheduled work" approval on a day that now has a shift is
//      matched, the other left pending; a duplicate with a contract is
//      refused and keeps its shift; a manager, and an admin reaching only one
//      branch, are refused a fold across branches; a move the original
//      already has is skipped and counted; a duplicate made with the
//      original's email takes neither the original's person nor its login.
//   4. Rematch: staff are refused; a manager's rematch resolves exactly the
//      pending item whose day now has a shift.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/employee-rehire.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("employee-rehire.check: DATABASE_URL is not set");
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
/** Bangkok's today and yesterday, as the offboarding route compares them. */
const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

// ─── One park group, two branches, a department, and the people ──────────────

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
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [RECEPTION, TENANT, `ZZ TEST s794 reception ${run}`]);

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
const staffer = await user("staff", "staff", { scope: "selected_branches", branchId: BRANCH_A });
const branchAdmin = await user("operator_admin", "branch-admin", { scope: "selected_branches", branchId: BRANCH_A });
/** The login the original profile signs in with; platform-linked, so its switch-off is queued for the platform. */
const SUBJECT_ACCOUNT = randomUUID();
const subject = await user("staff", "subject", { scope: "selected_branches", branchId: BRANCH_A }, SUBJECT_ACCOUNT);

async function employee(label: string, branchId: string, userId: string | null = null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, employment_state, default_merge_data)
     values ($1, $2, $3, $4, $5, $6, $7, 'active', 'ACTIVE', $8)`,
    [id, TENANT, branchId, userId, `ZZ TEST s794 ${label} ${run}`, label, `zz-s794-emp-${label}-${run}@example.com`,
      JSON.stringify({ positionTitle: "ZZ Floor" })],
  );
  return id;
}
const original = await employee("original", BRANCH_A, subject.id);
await q("update employees set face_enrollment_status = 'ENROLLED', face_enrolled_at = now() where id = $1", [original]);
const duplicate = await employee("duplicate", BRANCH_A);
const contracted = await employee("contracted", BRANCH_A);
const elsewhere = await employee("elsewhere", BRANCH_B);
const overlapping = await employee("overlapping", BRANCH_A);

// ─── The rota: one week in branch A, one Reception shift row ─────────────────

const WEEK = "2026-10-05"; // a Monday
const day = (n: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const GROUP = randomUUID();
await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, 'ZZ TEST')", [GROUP, TENANT, BRANCH_A]);
const PLAN = randomUUID();
await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [PLAN, TENANT, BRANCH_A, WEEK]);
const ROW = randomUUID();
await q(
  `insert into schedule_shift_rows (id, tenant_id, branch_id, department_id, shift_group_id, week_plan_id, start_time, end_time)
   values ($1, $2, $3, $4, $5, $6, '09:00', '17:00')`,
  [ROW, TENANT, BRANCH_A, RECEPTION, GROUP, PLAN],
);
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

// ─── The server ──────────────────────────────────────────────────────────────

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
};

async function serve(): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV },
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

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const countOf = async (sql: string, params: unknown[]) => Number((await q<{ n: string }>(sql, params))[0]!.n);
const shiftsOf = (employeeId: string) => countOf("select count(*) as n from schedule_assignments where employee_id = $1", [employeeId]);

try {
  ORIGIN = await serve();
  const as = {
    admin: await signIn(admin.email),
    manager: await signIn(manager.email),
    staff: await signIn(staffer.email),
    branchAdmin: await signIn(branchAdmin.email),
    otherAdmin: await signIn(otherAdmin.email),
  };
  const rehireBody = { startDate: today, positionTitle: "ZZ Reception", departmentId: RECEPTION, branchId: BRANCH_A };

  console.log("1. offboarding:");
  await check("the app's offboarding leaves the original Left, its login off and a deactivation queued", async () => {
    const res = await call("POST", `/api/employees/${original}/offboarding`, as.admin, {
      offboardingType: "resignation", reasonCode: "personal_reasons", lastWorkingDay: yesterday,
    });
    assert.equal(res.status, 201, show(res));
    const [row] = await q("select status, employment_state, last_working_day is not null as has_last_day from employees where id = $1", [original]);
    assert.deepEqual(row, { status: "resigned", employment_state: "LEFT", has_last_day: true });
    assert.deepEqual(await q("select is_active from users where id = $1", [subject.id]), [{ is_active: false }]);
    assert.deepEqual(await q("select state from login_lifecycle_events where user_id = $1", [subject.id]), [{ state: "pending" }]);
  });

  console.log("2. rehire:");
  await check("another park group's admin finds the employee at none of the three doors, and nothing changes", async () => {
    for (const [method, path, body] of [
      ["POST", `/api/employees/${original}/rehire`, rehireBody],
      ["GET", `/api/employees/${duplicate}/fold-into/${original}/preview`, undefined],
      ["POST", `/api/employees/${duplicate}/fold-into/${original}`, undefined],
      ["POST", `/api/employees/${original}/review/rematch`, undefined],
    ] as const) {
      const res = await call(method, path, as.otherAdmin, body);
      assert.deepEqual([res.status, res.body], [404, { message: "Employee not found" }], `${method} ${path}: ${show(res)}`);
    }
    assert.deepEqual(await q("select status from employees where id = $1", [original]), [{ status: "resigned" }]);
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [duplicate]), 1);
  });
  await check("staff, and a manager without hr.terminate_employee, are refused and nothing changes", async () => {
    const staff = await call("POST", `/api/employees/${original}/rehire`, as.staff, rehireBody);
    assert.equal(staff.status, 403, show(staff));
    const mgr = await call("POST", `/api/employees/${original}/rehire`, as.manager, rehireBody);
    assert.equal(mgr.status, 403, show(mgr));
    assert.match(mgr.body.message, /hr\.terminate_employee/);
    assert.deepEqual(await q("select status from employees where id = $1", [original]), [{ status: "resigned" }]);
  });
  await check("a profile that has not left is refused", async () => {
    const res = await call("POST", `/api/employees/${duplicate}/rehire`, as.admin, rehireBody);
    assert.equal(res.status, 409, show(res));
  });
  await check("an admin's rehire: Active in the new position, login on, movement logged, offboarding kept as the record", async () => {
    const res = await call("POST", `/api/employees/${original}/rehire`, as.admin, rehireBody);
    assert.equal(res.status, 200, show(res));
    assert.equal(res.body.login, "reactivated");
    assert.equal(res.body.offboarding?.reversal, "movement_log");
    assert.deepEqual(res.body.rematch, { matched: 0, stillPending: 0 });
    const [row] = await q(
      `select status, employment_state, end_reason, last_working_day, notice_date, primary_department_id, branch_id,
              default_merge_data->>'positionTitle' as position, start_date::date::text as start_date, face_enrollment_status
         from employees where id = $1`,
      [original],
    );
    assert.deepEqual(row, {
      status: "active", employment_state: "ACTIVE", end_reason: null, last_working_day: null, notice_date: null,
      primary_department_id: RECEPTION, branch_id: BRANCH_A, position: "ZZ Reception", start_date: today,
      face_enrollment_status: "ENROLLED",
    });
    assert.deepEqual(await q("select is_active from users where id = $1", [subject.id]), [{ is_active: true }]);
    assert.deepEqual(await q("select state from login_lifecycle_events where user_id = $1", [subject.id]), [{ state: "superseded" }],
      "the switch-off still waiting for the platform is withdrawn through the same channel");
    const movements = await q("select change_type, old_title, new_title, new_department_id, created_by from employee_changes where employee_id = $1 order by created_at", [original]);
    assert.deepEqual(movements.map((m) => m.change_type), ["resigned", "rehired"]);
    assert.deepEqual(movements[1], { change_type: "rehired", old_title: "ZZ Floor", new_title: "ZZ Reception", new_department_id: RECEPTION, created_by: admin.id });
    assert.equal(await countOf("select count(*) as n from employee_offboarding where employee_id = $1", [original]), 1);
    const again = await call("POST", `/api/employees/${original}/rehire`, as.admin, rehireBody);
    assert.equal(again.status, 409, "a second rehire finds the profile active");
  });

  console.log("3. fold:");
  const originalShift = await shift(original, day(3));
  const dupShifts = [await shift(duplicate, day(0)), await shift(duplicate, day(1)), await shift(duplicate, day(2))];
  const dupChecklist = await checklist(duplicate);
  const dupTask = await task(duplicate);
  const onShiftDay = await unscheduled(original, day(0));
  const offShiftDay = await unscheduled(original, day(5));
  const historyOf = async (employeeId: string) =>
    (await q<{ id: string }>("select id from employee_changes where employee_id = $1", [employeeId])).map((r) => r.id).sort();
  const historyBefore = await historyOf(original);

  await check("the preview counts 3/1/1 and writes nothing", async () => {
    const res = await call("GET", `/api/employees/${duplicate}/fold-into/${original}/preview`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body, {
      moved: { shifts: 3, checklists: 1, tasks: 1 }, skipped: { shifts: 0, checklists: 0, tasks: 0 }, deleted: { profile: 1, login: 0 },
    });
    assert.equal(await shiftsOf(duplicate), 3);
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [duplicate]), 1);
    assert.equal((await review(onShiftDay.issue)).issue_status, "OPEN");
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
  await check("a duplicate with a contract is refused and keeps its shift", async () => {
    const template = randomUUID();
    await q("insert into templates (id, tenant_id, name, html_body) values ($1, $2, $3, '<p>ZZ</p>')", [template, TENANT, `ZZ TEST s794 ${run}`]);
    await q(
      `insert into contract_instances (employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json, created_by, status)
       values ($1, $2, '<p>ZZ</p>', 1, '{}'::jsonb, $3, 'active')`,
      [contracted, template, admin.id],
    );
    await shift(contracted, day(4));
    const res = await call("POST", `/api/employees/${contracted}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.reason, "has_records");
    assert.deepEqual(res.body.blocking, [{ label: "contracts", count: 1 }]);
    assert.equal(await shiftsOf(contracted), 1);
    assert.equal(await countOf("select count(*) as n from employees where id = $1", [contracted]), 1);
  });
  await check("the fold moves 3/1/1 onto the original, deletes the duplicate and keeps the original's history", async () => {
    const res = await call("POST", `/api/employees/${duplicate}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.moved, { shifts: 3, checklists: 1, tasks: 1 });
    assert.deepEqual(res.body.skipped, { shifts: 0, checklists: 0, tasks: 0 });
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
    assert.deepEqual(await historyOf(original), historyBefore);
    assert.equal(await countOf("select count(*) as n from employee_offboarding where employee_id = $1", [original]), 1);
    assert.deepEqual(await q("select status, face_enrollment_status from employees where id = $1", [original]), [{ status: "active", face_enrollment_status: "ENROLLED" }]);
  });
  await check("the fold matched the approval on a day that now has a shift, and left the other pending", async () => {
    // The fold's answer from the check above is read back through the rows it settled.
    assert.deepEqual(await review(onShiftDay.issue), {
      issue_status: "RESOLVED", resolved_by: admin.id, resolution_note: "matched to a shift after rehire/fold",
      entry_status: "APPROVED", approved_by: admin.id,
    });
    assert.deepEqual(await review(offShiftDay.issue), {
      issue_status: "OPEN", resolved_by: null, resolution_note: null, entry_status: "PENDING_APPROVAL", approved_by: null,
    });
  });
  await check("a move the original already has is skipped and counted", async () => {
    await shift(overlapping, day(3)); // the original already works this shift
    const sharedChecklist = await checklist(overlapping);
    await q("insert into checklist_template_assignees (tenant_id, template_id, employee_id) values ($1, $2, $3)", [TENANT, sharedChecklist, original]);
    const res = await call("POST", `/api/employees/${overlapping}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.moved, res.body.skipped], [
      { shifts: 0, checklists: 0, tasks: 0 }, { shifts: 1, checklists: 1, tasks: 0 },
    ]);
    assert.equal(await countOf("select count(*) as n from schedule_assignments where employee_id = $1 and shift_date = $2", [original, day(3)]), 1);
    assert.deepEqual(await q("select employee_id from checklist_template_assignees where template_id = $1", [sharedChecklist]), [{ employee_id: original }]);
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
    assert.deepEqual(await q("select is_active from users where id = $1", [subject.id]), [{ is_active: true }]);
    assert.deepEqual(await q("select id from people where id = $1", [person]), [{ id: person }]);
    assert.deepEqual(await q("select core_user_id from access_policies where person_id = $1", [person]), [{ core_user_id: subject.id }]);
    assert.deepEqual(await q("select user_id, person_id from employees where id = $1", [original]), [{ user_id: subject.id, person_id: person }]);
  });

  console.log("4. rematch:");
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
      issue_status: "RESOLVED", resolved_by: manager.id, resolution_note: "matched to a shift after rehire/fold",
      entry_status: "APPROVED", approved_by: manager.id,
    });
    assert.equal((await review(second.issue)).issue_status, "OPEN");
  });

  console.log(`employee-rehire.check: ${checks} checks passed`);
} catch (err) {
  console.error("employee-rehire.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
