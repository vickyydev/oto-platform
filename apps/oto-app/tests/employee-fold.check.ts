// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-794 — the fold of a duplicate profile that is the one working, in the
// shape of the case found on staging (ids only, ZZ TEST rows here): the
// original has left (resigned, Left, its last working day past), holds the
// login and an enrolled face, an old active contract in Promotion and pending
// "Unscheduled work" items; the duplicate is active in Reception with a signed
// active contract, a finalized unsent copy, 7 time records, a face enrolment
// of its own, shifts, a checklist and a task. Over HTTP against the routes as
// registered:
//
//   1. The preview counts the contracts, time records, face, shifts,
//      checklist and task, says the original is onboarded again, and writes
//      nothing.
//   2. The fold moves all of it; the original reads active in Reception with
//      the duplicate's contract active and its own superseded, its offboarding
//      re-onboarded, its login on again (the same login), its own face kept
//      and the duplicate's removed from the face collection; the pending items
//      on the duplicate's shift days matched; the duplicate gone (404).
//   3. Refused: a duplicate with a payroll record; two active contracts while
//      the original's has no last working day.
//   4. A face moves to an original with none; a start date still to come is
//      planned for the batch, the moved contract waiting signed.
//   5. Onboard Again's draft: deleted by the contracts route (its links
//      cleared, one transaction); deleted by Cancel plan; a cancelled plan's
//      draft and an archived unsent draft do not keep a profile from being
//      deleted.
//   6. A profile onboarded again is offboarded again (migration 0039), one
//      open offboarding at a time.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/employee-fold.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { REMATCH_NOTE } from "../server/lib/reviewRematch";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("employee-fold.check: DATABASE_URL is not set");
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
/** Bangkok's calendar day, as the offboarding route and the fold compare days. */
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// ─── One park group, one branch, two departments ───────────────────────────

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST fold ${run}`, `zz-fold-${run}`]);
const BRANCH = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
  BRANCH, TENANT, `ZZ TEST fold ${run}`,
]);
const RECEPTION = randomUUID();
const PROMOTION = randomUUID();
const RECEPTION_NAME = `ZZ TEST fold reception ${run}`;
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [RECEPTION, TENANT, RECEPTION_NAME]);
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [PROMOTION, TENANT, `ZZ TEST fold promotion ${run}`]);
const TEMPLATE = randomUUID();
await q("insert into templates (id, tenant_id, name, html_body) values ($1, $2, $3, $4)", [
  TEMPLATE, TENANT, `ZZ TEST fold ${run}`, "<p>{{contract.position_title}} from {{contract.start_date}}</p>",
]);

async function user(role: string, label: string, platformUserId: string | null = null) {
  const id = randomUUID();
  const email = `zz-fold-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [id, email, hash(PASSWORD), `ZZ TEST fold ${label} ${run}`, role, platformUserId],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    TENANT, id, role === "staff" ? BRANCH : null, role === "staff" ? "selected_branches" : "all_branches",
  ]);
  return { id, email };
}
const admin = await user("admin", "admin");
/** The login the original signs in with; platform-linked, so its switch-off is queued for the platform. */
const login = await user("staff", "login", randomUUID());

interface ProfileOpts {
  userId?: string | null;
  department: string;
  position: string;
  status?: string;
  state?: string;
  faceId?: string | null;
  startDate?: string | null;
}
async function profile(label: string, opts: ProfileOpts): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, employment_state, default_merge_data,
                            primary_department_id, face_enrollment_status, face_id, face_enrolled_at, start_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id, TENANT, BRANCH, opts.userId ?? null, `ZZ TEST fold ${label} ${run}`, label, `zz-fold-emp-${label}-${run}@example.com`,
      opts.status ?? "active", opts.state ?? "ACTIVE", JSON.stringify({ positionTitle: opts.position, salaryThb: 15000 }), opts.department,
      opts.faceId ? "ENROLLED" : "NOT_ENROLLED", opts.faceId ?? null, opts.faceId ? new Date() : null, opts.startDate ?? null,
    ],
  );
  return id;
}

async function contract(employeeId: string, opts: { status: string; signing: string; start: string; position: string; createdAt?: string }) {
  const id = randomUUID();
  await q(
    `insert into contract_instances (id, employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json,
                                     created_by, status, signing_status, signed_at, created_at)
     values ($1, $2, $3, '<p>ZZ TEST</p>', 1, $4, $5, $6, $7, $8, coalesce($9::timestamp, now()))`,
    [
      id, employeeId, TEMPLATE, JSON.stringify({ positionTitle: opts.position, salaryThb: 15000, startDate: opts.start }), admin.id,
      opts.status, opts.signing, opts.signing === "signed" ? new Date() : null, opts.createdAt ?? null,
    ],
  );
  return id;
}

// ─── The rota: a Reception row in the branch ────────────────────────────────

const GROUP = randomUUID();
await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, 'ZZ TEST')", [GROUP, TENANT, BRANCH]);
const PLAN = randomUUID();
await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [PLAN, TENANT, BRANCH, plus(-7)]);
const ROW = randomUUID();
await q(
  `insert into schedule_shift_rows (id, tenant_id, branch_id, department_id, shift_group_id, week_plan_id, start_time, end_time)
   values ($1, $2, $3, $4, $5, $6, '09:00', '17:00')`,
  [ROW, TENANT, BRANCH, RECEPTION, GROUP, PLAN],
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
    id, TENANT, BRANCH, `ZZ TEST fold checklist ${run}`, employeeId,
  ]);
  await q("insert into checklist_template_assignees (tenant_id, template_id, employee_id) values ($1, $2, $3)", [TENANT, id, employeeId]);
  return id;
}
async function task(employeeId: string): Promise<string> {
  const id = randomUUID();
  await q("insert into tasks (id, tenant_id, branch_id, title) values ($1, $2, $3, $4)", [id, TENANT, BRANCH, `ZZ TEST fold task ${run}`]);
  await q("insert into task_assignments (tenant_id, task_id, assignment_type, assignment_id) values ($1, $2, 'employee', $3)", [TENANT, id, employeeId]);
  return id;
}
/** A face clock-in with no shift that day: what the kiosk's unscheduled route writes. */
async function unscheduled(employeeId: string, date: string) {
  const entry = randomUUID();
  const issue = randomUUID();
  await q(
    `insert into time_entries (id, tenant_id, employee_id, branch_id, shift_date, clock_in_at, status, source_in)
     values ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', 'FACE_KIOSK')`,
    [entry, TENANT, employeeId, BRANCH, date, `${date} 02:00`],
  );
  await q(
    `insert into timekeeping_issues (id, tenant_id, employee_id, branch_id, issue_date, issue_type, status, linked_time_entry_id, reason_code, created_by)
     values ($1, $2, $3, $4, $5, 'UNSCHEDULED_WORK', 'OPEN', $6, 'OTHER', 'KIOSK_SYSTEM')`,
    [issue, TENANT, employeeId, BRANCH, date, entry],
  );
  return { entry, issue };
}
/** A payroll line on a profile (a payroll run of its own): kept on the profile it was paid to. */
async function payrollLine(employeeId: string) {
  const operator = randomUUID();
  await q("insert into operators (id, tenant_id, name) values ($1, $2, $3)", [operator, TENANT, `ZZ TEST fold ${run}`]);
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
  // Face clock-in off, as production runs: the face service is the stand-in, whose removal answers true.
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
const exists = (id: string) => countOf("select count(*) as n from employees where id = $1", [id]);
const row = async (id: string) => (await q(
  `select status, employment_state, primary_department_id, branch_id, user_id, last_working_day::date::text as last_working_day,
          default_merge_data->>'positionTitle' as position, face_enrollment_status, face_id
     from employees where id = $1`, [id]))[0]!;
const loginOn = async (userId: string) => (await q<{ is_active: boolean }>("select is_active from users where id = $1", [userId]))[0]!.is_active;
const contractOf = async (id: string) => (await q("select employee_id, status, signing_status from contract_instances where id = $1", [id]))[0];
const review = async (issue: string) =>
  (await q(`select i.status as issue_status, i.resolution_note, e.status as entry_status
              from timekeeping_issues i join time_entries e on e.id = i.linked_time_entry_id where i.id = $1`, [issue]))[0];
const TIME_TABLES = ["time_events", "time_entries", "time_adjustments", "timekeeping_issues"];
const timeRecordsOf = async (employeeId: string) => {
  let n = 0;
  for (const t of TIME_TABLES) n += await countOf(`select count(*) as n from ${t} where employee_id = $1`, [employeeId]);
  return n;
};
const NONE = { shifts: 0, duties: 0, breaks: 0, templateShifts: 0, roles: 0, checklists: 0, tasks: 0, contracts: 0, timeRecords: 0 };

try {
  ORIGIN = await serve();
  const as = { admin: await signIn(admin.email) };
  const offboard = (id: string, lastWorkingDay: string) => call("POST", `/api/employees/${id}/offboarding`, as.admin, {
    offboardingType: "resignation", reasonCode: "personal_reasons", lastWorkingDay,
  });

  // ── The case ───────────────────────────────────────────────────────────────
  const LAST_DAY = plus(-9);
  const START = plus(-6);
  const original = await profile("original", { userId: login.id, department: PROMOTION, position: "ZZ Promoter", faceId: `zz-face-original-${run}` });
  const oldContract = await contract(original, { status: "active", signing: "signed", start: plus(-200), position: "ZZ Promoter", createdAt: "2026-01-01" });
  const off = await offboard(original, LAST_DAY);
  assert.equal(off.status, 201, `the original's offboarding: ${show(off)}`);
  const [{ id: originalOffboarding }] = await q<{ id: string }>("select id from employee_offboarding where employee_id = $1", [original]);

  const duplicate = await profile("duplicate", {
    department: RECEPTION, position: "ZZ Receptionist", faceId: `zz-face-duplicate-${run}`, startDate: START,
  });
  const signed = await contract(duplicate, { status: "active", signing: "signed", start: START, position: "ZZ Receptionist", createdAt: `${plus(-9)} 08:00` });
  const copy = await contract(duplicate, { status: "finalized", signing: "not_sent", start: START, position: "ZZ Receptionist" });
  // The duplicate's 11 shifts: 4 days, a gap, then 7.
  const shiftDays = [-5, -4, -3, -2, 0, 1, 2, 3, 4, 5, 6].map(plus);
  for (const date of shiftDays) await shift(duplicate, date);
  const dupChecklist = await checklist(duplicate);
  const dupTask = await task(duplicate);
  // Its 7 time records: 3 clock-ins, 3 time entries, 1 attendance review item.
  for (const date of shiftDays.slice(4, 7)) {
    await q(
      "insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time) values ($1, $2, $3, 'CLOCK_IN', $4)",
      [TENANT, duplicate, BRANCH, `${date} 02:00`],
    );
  }
  const dupEntries: string[] = [];
  for (const date of shiftDays.slice(4, 7)) {
    const [{ id }] = await q<{ id: string }>(
      `insert into time_entries (tenant_id, employee_id, branch_id, shift_date, clock_in_at, status, source_in)
       values ($1, $2, $3, $4, $5, 'APPROVED', 'FACE_KIOSK') returning id`,
      [TENANT, duplicate, BRANCH, date, `${date} 02:00`],
    );
    dupEntries.push(id);
  }
  const [{ id: dupIssue }] = await q<{ id: string }>(
    `insert into timekeeping_issues (tenant_id, employee_id, branch_id, issue_date, issue_type, status, linked_time_entry_id, reason_code, created_by)
     values ($1, $2, $3, $4, 'MISSING_CLOCK_OUT', 'OPEN', $5, 'OTHER', 'KIOSK_SYSTEM') returning id`,
    [TENANT, duplicate, BRANCH, shiftDays[6], dupEntries[2]],
  );
  // The original's pending "Unscheduled work": two on the duplicate's shift days, one on a day nobody worked.
  const onShiftDays = [await unscheduled(original, shiftDays[0]!), await unscheduled(original, shiftDays[1]!)];
  const offShiftDay = await unscheduled(original, plus(-1));

  console.log("1. the preview:");
  const CASE_MOVES = { ...NONE, contracts: 2, timeRecords: 7, shifts: 11, checklists: 1, tasks: 1 };
  await check("the preview counts 2 contracts, 7 time records, 11 shifts, 1 checklist and 1 task, the face, and the re-onboarding, and writes nothing", async () => {
    assert.deepEqual([(await row(original)).status, (await row(original)).employment_state, await loginOn(login.id)], ["resigned", "LEFT", false]);
    const res = await call("GET", `/api/employees/${duplicate}/fold-into/${original}/preview`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.moved, CASE_MOVES);
    assert.deepEqual(res.body.skipped, NONE);
    assert.equal(res.body.face, "original_kept");
    assert.equal(res.body.supersededContracts, 1);
    assert.deepEqual(res.body.deleted, { profile: 1, login: 0 });
    const { engagementId, ...plan } = res.body.reonboard;
    assert.ok(engagementId);
    assert.deepEqual(plan, {
      startDate: START,
      started: true,
      department: { id: RECEPTION, name: RECEPTION_NAME },
      branch: { id: BRANCH, name: `ZZ TEST fold ${run}` },
      positionTitle: "ZZ Receptionist",
      contractId: signed,
      login: "reactivated",
      platformDeactivationDelivered: false,
    });
    assert.equal("faceToRemove" in res.body, false, "the face id stays on the server");
    // Nothing written.
    assert.equal(await exists(duplicate), 1);
    const kept = await row(original);
    assert.deepEqual([kept.status, kept.employment_state, kept.primary_department_id], ["resigned", "LEFT", PROMOTION]);
    assert.equal(await loginOn(login.id), false);
    assert.deepEqual(await contractOf(oldContract), { employee_id: original, status: "active", signing_status: "signed" });
    assert.equal(await countOf("select count(*) as n from employee_engagements where employee_id = $1", [original]), 0);
    assert.equal((await review(onShiftDays[0]!.issue))!.issue_status, "OPEN");
  });

  console.log("2. the fold:");
  await check("the fold moves everything, onboards the original again into the duplicate's employment and deletes the duplicate", async () => {
    const res = await call("POST", `/api/employees/${duplicate}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.moved, CASE_MOVES);
    assert.equal(res.body.face, "original_kept");
    assert.equal(res.body.faceRemovedFromCollection, true);
    assert.equal(res.body.reonboard.started, true);
    assert.deepEqual(res.body.rematch, { matched: 2, stillPending: 1 });
    assert.equal(await exists(duplicate), 0);
  });
  await check("the original reads active in Reception, its last working day cleared, the same login switched on, its own face kept", async () => {
    const kept = await row(original);
    assert.deepEqual(
      [kept.status, kept.employment_state, kept.primary_department_id, kept.branch_id, kept.last_working_day, kept.position, kept.user_id],
      ["active", "ACTIVE", RECEPTION, BRANCH, null, "ZZ Receptionist", login.id],
    );
    assert.deepEqual([kept.face_enrollment_status, kept.face_id], ["ENROLLED", `zz-face-original-${run}`]);
    assert.equal(await loginOn(login.id), true);
    assert.equal(await countOf("select count(*) as n from employees where face_id = $1", [`zz-face-duplicate-${run}`]), 0);
  });
  await check("the duplicate's signed contract is the original's active contract, its copy moved as it was, the old one superseded", async () => {
    assert.deepEqual(await contractOf(signed), { employee_id: original, status: "active", signing_status: "signed" });
    assert.deepEqual(await contractOf(copy), { employee_id: original, status: "finalized", signing_status: "not_sent" });
    assert.deepEqual(await contractOf(oldContract), { employee_id: original, status: "superseded", signing_status: "signed" });
    assert.equal(await countOf("select count(*) as n from contract_instances where employee_id = $1 and status = 'active'", [original]), 1);
  });
  await check("the employment is recorded as Onboard Again's: engagement active from the contract's start, the offboarding re-onboarded, the movement logged", async () => {
    assert.deepEqual(
      await q(`select status, start_date::text as start_date, department_id, branch_id, position_title, contract_instance_id, offboarding_id
                 from employee_engagements where employee_id = $1`, [original]),
      [{ status: "active", start_date: START, department_id: RECEPTION, branch_id: BRANCH, position_title: "ZZ Receptionist", contract_instance_id: signed, offboarding_id: originalOffboarding }],
    );
    assert.equal(await countOf("select count(*) as n from employee_offboarding where id = $1 and reonboarded_at is not null", [originalOffboarding]), 1);
    const [movement] = await q<{ note: string; new_department_id: string; old_department_id: string; contract_instance_id: string; effective: string }>(
      `select note, new_department_id, old_department_id, contract_instance_id, effective_date::date::text as effective
         from employee_changes where employee_id = $1 and change_type = 'onboard_again'`, [original]);
    assert.match(movement!.note, /^Onboard again \(from a folded profile\)/);
    assert.deepEqual([movement!.old_department_id, movement!.new_department_id, movement!.contract_instance_id, movement!.effective], [PROMOTION, RECEPTION, signed, START]);
  });
  await check("the time records, shifts, checklist and task are the original's; the pending items on the duplicate's shift days matched, the other pending", async () => {
    assert.equal(await timeRecordsOf(original), 7 + 2 * 3);
    assert.deepEqual(await q("select employee_id, status from timekeeping_issues where id = $1", [dupIssue]), [{ employee_id: original, status: "OPEN" }]);
    assert.equal(await countOf("select count(*) as n from schedule_assignments where employee_id = $1", [original]), 11);
    assert.deepEqual(await q("select employee_id from checklist_template_assignees where template_id = $1", [dupChecklist]), [{ employee_id: original }]);
    assert.deepEqual(await q("select assignment_id from task_assignments where task_id = $1", [dupTask]), [{ assignment_id: original }]);
    for (const item of onShiftDays) {
      assert.deepEqual(await review(item.issue), { issue_status: "RESOLVED", resolution_note: REMATCH_NOTE, entry_status: "APPROVED" });
    }
    assert.deepEqual(await review(offShiftDay.issue), { issue_status: "OPEN", resolution_note: null, entry_status: "PENDING_APPROVAL" });
  });
  await check("the duplicate is gone (404), and the original's record says what came onto it", async () => {
    const gone = await call("GET", `/api/employees/${duplicate}`, as.admin);
    assert.equal(gone.status, 404, show(gone));
    const [log] = await q<{ summary_text: string; metadata_json: string }>(
      "select summary_text, metadata_json from activity_log where employee_id = $1 and summary_text like 'A duplicate profile was folded%'", [original]);
    assert.match(log!.summary_text, /2 contract\(s\), 7 time record\(s\), 11 shift\(s\)/);
    assert.match(log!.summary_text, /onboarded again \(from a folded profile\)/);
    const meta = JSON.parse(log!.metadata_json) as { foldedProfileId: string; foldedFaceId: string; supersededContracts: number };
    assert.deepEqual([meta.foldedProfileId, meta.foldedFaceId, meta.supersededContracts], [duplicate, `zz-face-duplicate-${run}`, 1]);
  });

  console.log("3. refused:");
  await check("a duplicate with a payroll record is refused, in the preview and the fold, naming it, and nothing moves", async () => {
    const kept = await profile("paid-original", { department: PROMOTION, position: "ZZ Promoter" });
    const paid = await profile("paid", { department: RECEPTION, position: "ZZ Receptionist" });
    await contract(paid, { status: "active", signing: "signed", start: plus(-3), position: "ZZ Receptionist" });
    await shift(paid, plus(10));
    await payrollLine(paid);
    for (const [method, path] of [["GET", `/api/employees/${paid}/fold-into/${kept}/preview`], ["POST", `/api/employees/${paid}/fold-into/${kept}`]] as const) {
      const res = await call(method, path, as.admin);
      assert.equal(res.status, 409, `${method}: ${show(res)}`);
      assert.deepEqual([res.body.reason, res.body.blocking], ["has_records", [{ label: "payroll records", count: 1 }]]);
      assert.match(res.body.message, /^This profile has 1 payroll record\. Payroll records stay on the profile they were paid to/);
    }
    assert.equal(await exists(paid), 1);
    assert.equal(await countOf("select count(*) as n from schedule_assignments where employee_id = $1", [paid]), 1);
    assert.equal(await countOf("select count(*) as n from contract_instances where employee_id = $1", [paid]), 1);
  });
  await check("two active contracts while the kept profile's has no last working day are refused, and nothing moves", async () => {
    const kept = await profile("both-original", { department: PROMOTION, position: "ZZ Promoter" });
    const keptContract = await contract(kept, { status: "active", signing: "signed", start: plus(-100), position: "ZZ Promoter" });
    const other = await profile("both", { department: RECEPTION, position: "ZZ Receptionist" });
    await contract(other, { status: "active", signing: "signed", start: plus(-3), position: "ZZ Receptionist" });
    const res = await call("POST", `/api/employees/${other}/fold-into/${kept}`, as.admin);
    assert.deepEqual([res.status, res.body.reason], [409, "both_active"], show(res));
    assert.equal(await exists(other), 1);
    assert.deepEqual(await contractOf(keptContract), { employee_id: kept, status: "active", signing_status: "signed" });
  });

  console.log("4. the face, and a start still to come:");
  await check("a face enrolment moves to a kept profile with none", async () => {
    const kept = await profile("faceless", { department: PROMOTION, position: "ZZ Promoter" });
    const other = await profile("faced", { department: PROMOTION, position: "ZZ Promoter", faceId: `zz-face-faced-${run}` });
    const res = await call("POST", `/api/employees/${other}/fold-into/${kept}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.face, res.body.reonboard, "faceRemovedFromCollection" in res.body], ["taken", null, false]);
    const after = await row(kept);
    assert.deepEqual([after.face_enrollment_status, after.face_id], ["ENROLLED", `zz-face-faced-${run}`]);
  });
  await check("a duplicate whose contract starts later: the employment is planned for its start date, the moved contract waits signed, the current one runs on", async () => {
    const later = plus(8);
    const kept = await profile("leaving", { department: PROMOTION, position: "ZZ Promoter" });
    const keptContract = await contract(kept, { status: "active", signing: "signed", start: plus(-100), position: "ZZ Promoter" });
    assert.equal((await offboard(kept, plus(5))).status, 201);
    const other = await profile("starting", { department: RECEPTION, position: "ZZ Receptionist", startDate: later });
    const next = await contract(other, { status: "active", signing: "signed", start: later, position: "ZZ Receptionist" });
    const res = await call("POST", `/api/employees/${other}/fold-into/${kept}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.reonboard.started, res.body.reonboard.startDate, res.body.supersededContracts, res.body.reonboard.login], [false, later, 0, null]);
    assert.deepEqual(await contractOf(next), { employee_id: kept, status: "finalized", signing_status: "signed" });
    assert.deepEqual(await contractOf(keptContract), { employee_id: kept, status: "active", signing_status: "signed" });
    assert.deepEqual(
      await q("select status, start_date::text as start_date, department_id, contract_instance_id from employee_engagements where employee_id = $1", [kept]),
      [{ status: "planned", start_date: later, department_id: RECEPTION, contract_instance_id: next }],
    );
    const after = await row(kept);
    assert.deepEqual([after.status, after.employment_state, after.primary_department_id], ["active", "LEAVING", PROMOTION]);
  });

  console.log("5. Onboard Again's draft contract:");
  const planOn = async (label: string) => {
    const id = await profile(label, { department: PROMOTION, position: "ZZ Promoter" });
    assert.equal((await offboard(id, plus(3))).status, 201);
    const plan = await call("POST", `/api/employees/${id}/onboard-again`, as.admin, {
      startDate: plus(6), departmentId: RECEPTION, positionTitle: "ZZ Receptionist", templateId: TEMPLATE,
    });
    assert.equal(plan.status, 201, show(plan));
    return { id, engagementId: plan.body.engagementId as string, draft: plan.body.contract.id as string };
  };
  await check("the draft is deleted by the contracts route, in one transaction: the movement, activity and plan keep their rows without the link", async () => {
    const p = await planOn("draft-delete");
    const res = await call("DELETE", `/api/contracts/${p.draft}`, as.admin);
    assert.equal(res.status, 204, show(res));
    assert.equal(await countOf("select count(*) as n from contract_instances where id = $1", [p.draft]), 0);
    assert.deepEqual(await q("select contract_instance_id from employee_changes where employee_id = $1 and change_type = 'onboard_again'", [p.id]), [{ contract_instance_id: null }]);
    assert.equal(await countOf("select count(*) as n from activity_log where contract_instance_id = $1", [p.draft]), 0);
    assert.ok(await countOf("select count(*) as n from activity_log where employee_id = $1 and summary_text like 'Onboard again planned%'", [p.id]) === 1);
    assert.deepEqual(await q("select status, contract_instance_id from employee_engagements where id = $1", [p.engagementId]), [{ status: "planned", contract_instance_id: null }]);
  });
  await check("Cancel plan deletes the plan's unsent draft, and the profile can then be deleted", async () => {
    const p = await planOn("cancel");
    const res = await call("DELETE", `/api/employees/${p.id}/onboard-again/${p.engagementId}`, as.admin);
    assert.deepEqual([res.status, res.body], [200, { cancelled: true, contractId: p.draft, contractDeleted: true }], show(res));
    assert.equal(await countOf("select count(*) as n from contract_instances where employee_id = $1", [p.id]), 0);
    const gone = await call("DELETE", `/api/employees/${p.id}`, as.admin);
    assert.equal(gone.status, 204, show(gone));
    assert.equal(await exists(p.id), 0);
  });
  await check("a plan cancelled before this release (its draft kept) and an archived unsent draft keep nobody from being deleted", async () => {
    const p = await planOn("cancelled-before");
    // As Cancel plan left it before: the plan cancelled, its draft standing.
    await q("update employee_engagements set status = 'cancelled', cancelled_at = now() where id = $1", [p.engagementId]);
    const archived = await contract(p.id, { status: "draft", signing: "not_sent", start: plus(6), position: "ZZ Receptionist" });
    await q("update contract_instances set archived_at = now() where id = $1", [archived]);
    const gone = await call("DELETE", `/api/employees/${p.id}`, as.admin);
    assert.equal(gone.status, 204, show(gone));
    assert.equal(await countOf("select count(*) as n from contract_instances where id = any($1::varchar[])", [[p.draft, archived]]), 0);
  });
  await check("a sent or signed contract still keeps a profile from being deleted", async () => {
    const p = await planOn("sent");
    await q("update contract_instances set status = 'finalized', signing_status = 'awaiting_signature', signing_token = $2 where id = $1", [p.draft, randomBytes(16).toString("hex")]);
    await q("update employee_engagements set status = 'cancelled', cancelled_at = now() where id = $1", [p.engagementId]);
    const res = await call("DELETE", `/api/employees/${p.id}`, as.admin);
    assert.deepEqual([res.status, res.body.reason, res.body.blocking], [409, "has_records", [{ label: "contracts", count: 1 }]], show(res));
  });

  console.log("6. offboarded again:");
  await check("the profile onboarded again by the fold is offboarded again (201); a second open offboarding is refused", async () => {
    const res = await offboard(original, plus(20));
    assert.equal(res.status, 201, show(res));
    assert.equal(await countOf("select count(*) as n from employee_offboarding where employee_id = $1", [original]), 2);
    assert.equal(await countOf("select count(*) as n from employee_offboarding where employee_id = $1 and reonboarded_at is null", [original]), 1);
    const kept = await row(original);
    assert.deepEqual([kept.status, kept.employment_state, kept.last_working_day], ["active", "LEAVING", plus(20)]);
    const twice = await offboard(original, plus(21));
    assert.deepEqual([twice.status, twice.body.message], [409, "Offboarding already exists for this employee"], show(twice));
  });

  console.log(`employee-fold.check: ${checks} checks passed`);
} catch (err) {
  console.error("employee-fold.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
