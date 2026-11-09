// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-794 — the fold of a duplicate profile that is the one working, in the
// shape of the case found on staging (ids only, ZZ TEST rows here): the
// original has left (resigned, Left, its last working day past), holds the
// login and an enrolled face, an old active contract in Promotion and pending
// "Unscheduled work" items (one on a day the duplicate clocked as well); the
// duplicate is active and on probation in Reception with a signed active
// contract, a finalized unsent copy, 7 time records, a face enrolment of its
// own, its history, shifts, a checklist and a task; and org chart entries as
// the Org Chart page left them, on the live company chart (the duplicate's
// only) and on the branch chart (the original's and the duplicate's, a
// position reporting to the duplicate's). Over HTTP against the routes as
// registered:
//
//   1. The preview counts the contracts, time records, history, face, shifts,
//      checklist and task and the day clocked on both, says the original is
//      onboarded again on the duplicate's terms, counts the two org chart
//      entries taken and the original's own branch entry replaced, and writes
//      nothing.
//   2. The fold moves all of it; the original reads active and on probation in
//      Reception with the duplicate's contract active and its own superseded,
//      its offboarding re-onboarded, its login on again (the same login), its
//      own face kept and the duplicate's removed from the face collection; the
//      pending items on the duplicate's shift days matched, the one on the day
//      clocked on both left pending; the duplicate gone (404); both of the
//      duplicate's chart entries the original's in their place (onboarded
//      again into the duplicate's employment, the duplicate's branch entry is
//      the current one), the original's own branch entry deleted and the
//      position under the duplicate's still under it; the Org Chart page's
//      read shows the original once on each chart, as the receptionist, and
//      adds nothing.
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
//   7. A part-time duplicate on probation with a signed letter, a document,
//      company property, leave, leave settings, a payroll profile, a cost
//      allocation, availability, a live clock-in and history: the preview
//      counts them, the fold keeps every one on the original (a day off the
//      original already has skipped; the original's own payroll profile and
//      leave setting replaced), and the original reads as the duplicate's
//      employment.
//   8. Refused: a payroll profile and leave settings on both profiles when
//      nobody is onboarded again; a re-onboarding still to come on other
//      terms.
//   9. The org chart: an entry deleted from the chart and added back by the
//      next read (the live one taken, the marked one deleted); the kept
//      profile's entry below the duplicate's (no entry ends up below itself);
//      the kept profile's entry disabled and the duplicate's not, both
//      working (the duplicate's taken in its place, the disabled one deleted,
//      the entries under either under the one taken, none below itself; on a
//      chart where neither is disabled the kept profile's stays); and a
//      duplicate still pointed at by what a fold does not move (a nanny
//      reservation, a voucher) refused naming each, nothing moved.
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
  /** The employment's terms: basis, daily rate, probation, salary (15000 unless named). */
  basis?: "FULL_TIME" | "PART_TIME";
  dailyRate?: number | null;
  probationDays?: number | null;
  probationEnd?: string | null;
  salary?: number;
}
async function profile(label: string, opts: ProfileOpts): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, employment_state, default_merge_data,
                            primary_department_id, face_enrollment_status, face_id, face_enrolled_at, start_date,
                            employment_basis, daily_rate, probation_days, probation_end_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      id, TENANT, BRANCH, opts.userId ?? null, `ZZ TEST fold ${label} ${run}`, label, `zz-fold-emp-${label}-${run}@example.com`,
      opts.status ?? "active", opts.state ?? "ACTIVE", JSON.stringify({ positionTitle: opts.position, salaryThb: opts.salary ?? 15000 }), opts.department,
      opts.faceId ? "ENROLLED" : "NOT_ENROLLED", opts.faceId ?? null, opts.faceId ? new Date() : null, opts.startDate ?? null,
      opts.basis ?? "FULL_TIME", opts.dailyRate ?? null, opts.probationDays ?? null, opts.probationEnd ?? null,
    ],
  );
  return id;
}
/** An activity entry naming a profile, as the app's own writes record one. */
async function activity(employeeId: string, summary: string) {
  await q("insert into activity_log (tenant_id, branch_id, employee_id, activity_type, summary_text, created_by) values ($1, $2, $3, 'employee_updated', $4, $5)", [
    TENANT, BRANCH, employeeId, summary, admin.id,
  ]);
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
/** An org chart entry as the Org Chart page writes one: a person's, or a position's (nobody in it). */
async function orgEntry(opts: {
  scope: "company" | "branch";
  person?: string | null;
  parent?: string | null;
  position?: string | null;
  sort?: number;
  deleted?: boolean;
  /** "Disable position" on the Org Chart page: drawn greyed, left out of headcount and cost. */
  disabled?: boolean;
  mode?: "live" | "draft";
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into org_nodes (id, tenant_id, mode, scope_type, scope_branch_id, node_type, person_employee_id, title, position_title, branch_id,
                            reports_to_node_id, is_vacant, is_deleted, sort_order, is_disabled)
     values ($1, $2, $3, $4, $5, $6, $7, 'ZZ TEST', $8, $9, $10, $11, $12, $13, $14)`,
    [
      id, TENANT, opts.mode ?? "live", opts.scope, opts.scope === "branch" ? BRANCH : null, opts.person ? "person" : "vacant_role", opts.person ?? null,
      opts.position ?? null, BRANCH, opts.parent ?? null, !opts.person, opts.deleted ?? false, opts.sort ?? 0, opts.disabled ?? false,
    ],
  );
  return id;
}
/** An entry as it stands: whose, under which entry, in which place. */
const entryOf = async (id: string) =>
  (await q("select person_employee_id, reports_to_node_id, position_title, sort_order, is_deleted from org_nodes where id = $1", [id]))[0];

/** A face clock-in with no shift that day: what the kiosk's unscheduled route writes. */
async function unscheduled(employeeId: string, date: string, at = "02:00") {
  const entry = randomUUID();
  const issue = randomUUID();
  await q(
    `insert into time_entries (id, tenant_id, employee_id, branch_id, shift_date, clock_in_at, status, source_in)
     values ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', 'FACE_KIOSK')`,
    [entry, TENANT, employeeId, BRANCH, date, `${date} ${at}`],
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
/** The employment's terms on a profile. */
const termsOf = async (id: string) => (await q(
  `select employment_basis, daily_rate, probation_days, probation_end_date::date::text as probation_end, probation_review_completed_at,
          (default_merge_data->>'salaryThb')::int as salary
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
const NONE = {
  shifts: 0, duties: 0, breaks: 0, templateShifts: 0, roles: 0, checklists: 0, tasks: 0, contracts: 0, timeRecords: 0,
  documents: 0, letters: 0, assets: 0, timeOff: 0, availability: 0, leaveSettings: 0, payrollProfile: 0, costAllocations: 0, history: 0,
};
const NOTHING_REPLACED = { payrollProfile: 0, costAllocations: 0, leaveSettings: 0 };

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

  // On probation in Reception, as the staging duplicate reads ("Probation").
  const PROBATION_END = plus(84);
  const duplicate = await profile("duplicate", {
    department: RECEPTION, position: "ZZ Receptionist", faceId: `zz-face-duplicate-${run}`, startDate: START,
    probationDays: 90, probationEnd: PROBATION_END,
  });
  const signed = await contract(duplicate, { status: "active", signing: "signed", start: START, position: "ZZ Receptionist", createdAt: `${plus(-9)} 08:00` });
  const copy = await contract(duplicate, { status: "finalized", signing: "not_sent", start: START, position: "ZZ Receptionist" });
  // Its Reception history: the contract made and signed, the face enrolled.
  await activity(duplicate, "ZZ TEST fold contract made and signed");
  await activity(duplicate, "ZZ TEST fold face enrolled");
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
  // The original's 4 pending "Unscheduled work" items: two on the duplicate's
  // shift days, one on a day nobody worked, and one on a day the duplicate
  // clocked too (a scan that landed on the original a minute after the
  // duplicate's own clock-in for the shift).
  const onShiftDays = [await unscheduled(original, shiftDays[0]!), await unscheduled(original, shiftDays[1]!)];
  const offShiftDay = await unscheduled(original, plus(-1));
  const clockedTwice = await unscheduled(original, shiftDays[4]!, "02:01");
  // The org chart, as the Org Chart page left it: the live company chart, read
  // only since the original left, holds the duplicate (under a manager's
  // position, in its place); the branch chart, read while the original
  // worked, holds the original's entry (from the employment that ended, its
  // old position) and the duplicate's (the current one), with a trainee
  // position reporting to the duplicate's.
  const MANAGER = await orgEntry({ scope: "company", position: "ZZ Manager" });
  const dupCompany = await orgEntry({ scope: "company", person: duplicate, parent: MANAGER, position: "ZZ Receptionist", sort: 3 });
  const originalBranch = await orgEntry({ scope: "branch", person: original, position: "ZZ Promoter" });
  const dupBranch = await orgEntry({ scope: "branch", person: duplicate, position: "ZZ Receptionist", sort: 2 });
  const trainee = await orgEntry({ scope: "branch", parent: dupBranch, position: "ZZ Receptionist trainee" });
  const chartRows = () => countOf("select count(*) as n from org_nodes where tenant_id = $1", [TENANT]);

  console.log("1. the preview:");
  const CASE_MOVES = { ...NONE, contracts: 2, timeRecords: 7, shifts: 11, checklists: 1, tasks: 1, history: 2 };
  await check("the preview counts 2 contracts, 7 time records, 11 shifts, 1 checklist, 1 task and 2 history entries, the face, the day clocked on both, and the re-onboarding on the duplicate's terms, and writes nothing", async () => {
    assert.deepEqual([(await row(original)).status, (await row(original)).employment_state, await loginOn(login.id)], ["resigned", "LEFT", false]);
    const res = await call("GET", `/api/employees/${duplicate}/fold-into/${original}/preview`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.moved, CASE_MOVES);
    assert.deepEqual(res.body.skipped, NONE);
    assert.equal(res.body.face, "original_kept");
    assert.equal(res.body.supersededContracts, 1);
    assert.deepEqual(res.body.replaced, NOTHING_REPLACED);
    assert.equal(res.body.clockedOnBoth, 1);
    assert.deepEqual(res.body.deleted, { profile: 1, login: 0 });
    const { engagementId, ...plan } = res.body.reonboard;
    assert.ok(engagementId);
    assert.deepEqual(plan, {
      startDate: START,
      started: true,
      department: { id: RECEPTION, name: RECEPTION_NAME },
      branch: { id: BRANCH, name: `ZZ TEST fold ${run}` },
      positionTitle: "ZZ Receptionist",
      employmentBasis: "FULL_TIME",
      probationEndDate: PROBATION_END,
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
  await check("the preview counts the duplicate's org chart entries: both taken (the company chart's, and the branch chart's as the current one, the original onboarded again into its employment), the original's own branch entry replaced, none dropped, and writes nothing", async () => {
    const res = await call("GET", `/api/employees/${duplicate}/fold-into/${original}/preview`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.orgChartMoved, res.body.orgChartDropped, res.body.orgChartReplaced], [2, 0, 1]);
    assert.equal(await chartRows(), 5);
    assert.deepEqual(await entryOf(dupCompany), { person_employee_id: duplicate, reports_to_node_id: MANAGER, position_title: "ZZ Receptionist", sort_order: 3, is_deleted: false });
    assert.deepEqual(await entryOf(dupBranch), { person_employee_id: duplicate, reports_to_node_id: null, position_title: "ZZ Receptionist", sort_order: 2, is_deleted: false });
    assert.deepEqual(await entryOf(originalBranch), { person_employee_id: original, reports_to_node_id: null, position_title: "ZZ Promoter", sort_order: 0, is_deleted: false });
    assert.equal((await entryOf(trainee))?.reports_to_node_id, dupBranch);
  });

  console.log("2. the fold:");
  await check("the fold moves everything, onboards the original again into the duplicate's employment and deletes the duplicate", async () => {
    const res = await call("POST", `/api/employees/${duplicate}/fold-into/${original}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.moved, CASE_MOVES);
    assert.equal(res.body.face, "original_kept");
    assert.equal(res.body.faceRemovedFromCollection, true);
    assert.equal(res.body.reonboard.started, true);
    assert.equal(res.body.clockedOnBoth, 1);
    assert.deepEqual([res.body.orgChartMoved, res.body.orgChartDropped, res.body.orgChartReplaced], [2, 0, 1]);
    // The day clocked on both is left for a manager: 2 matched, 2 pending.
    assert.deepEqual(res.body.rematch, { matched: 2, stillPending: 2 });
    assert.equal(await exists(duplicate), 0);
  });
  await check("the original reads active in Reception, on probation as the duplicate was, its last working day cleared, the same login switched on, its own face kept", async () => {
    const kept = await row(original);
    assert.deepEqual(
      [kept.status, kept.employment_state, kept.primary_department_id, kept.branch_id, kept.last_working_day, kept.position, kept.user_id],
      ["active", "ACTIVE", RECEPTION, BRANCH, null, "ZZ Receptionist", login.id],
    );
    const terms = await termsOf(original);
    assert.deepEqual([terms.employment_basis, terms.probation_days, terms.probation_end, terms.probation_review_completed_at], ["FULL_TIME", 90, PROBATION_END, null]);
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
    assert.equal(await timeRecordsOf(original), 7 + 2 * 4);
    assert.deepEqual(await q("select employee_id, status from timekeeping_issues where id = $1", [dupIssue]), [{ employee_id: original, status: "OPEN" }]);
    assert.equal(await countOf("select count(*) as n from schedule_assignments where employee_id = $1", [original]), 11);
    assert.deepEqual(await q("select employee_id from checklist_template_assignees where template_id = $1", [dupChecklist]), [{ employee_id: original }]);
    assert.deepEqual(await q("select assignment_id from task_assignments where task_id = $1", [dupTask]), [{ assignment_id: original }]);
    for (const item of onShiftDays) {
      assert.deepEqual(await review(item.issue), { issue_status: "RESOLVED", resolution_note: REMATCH_NOTE, entry_status: "APPROVED" });
    }
    assert.deepEqual(await review(offShiftDay.issue), { issue_status: "OPEN", resolution_note: null, entry_status: "PENDING_APPROVAL" });
  });
  await check("the day clocked on both profiles: the stray entry is left pending beside the duplicate's approved one, so the hours are counted once", async () => {
    assert.deepEqual(await review(clockedTwice.issue), { issue_status: "OPEN", resolution_note: null, entry_status: "PENDING_APPROVAL" });
    assert.deepEqual(
      await q("select status from time_entries where employee_id = $1 and shift_date = $2 order by clock_in_at", [original, shiftDays[4]]),
      [{ status: "APPROVED" }, { status: "PENDING_APPROVAL" }],
    );
  });
  await check("the duplicate's Reception history is the original's", async () => {
    assert.equal(await countOf("select count(*) as n from activity_log where employee_id = $1 and summary_text like 'ZZ TEST fold %'", [original]), 2);
    assert.equal(await countOf("select count(*) as n from activity_log where tenant_id = $1 and employee_id is null and summary_text like 'ZZ TEST fold %'", [TENANT]), 0);
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
  await check("the original's chart entries: both of the duplicate's, in their place (the company chart's under the manager, the branch chart's with the trainee under it); the original's own branch entry from the employment that ended deleted outright", async () => {
    assert.deepEqual(await entryOf(dupCompany), { person_employee_id: original, reports_to_node_id: MANAGER, position_title: "ZZ Receptionist", sort_order: 3, is_deleted: false });
    assert.deepEqual(await entryOf(dupBranch), { person_employee_id: original, reports_to_node_id: null, position_title: "ZZ Receptionist", sort_order: 2, is_deleted: false });
    assert.equal(await entryOf(originalBranch), undefined, "deleted, not marked deleted");
    assert.equal((await entryOf(trainee))?.reports_to_node_id, dupBranch);
    assert.equal(await chartRows(), 4);
    const [log] = await q<{ summary_text: string; metadata_json: string }>(
      "select summary_text, metadata_json from activity_log where employee_id = $1 and summary_text like 'A duplicate profile was folded%'", [original]);
    assert.match(log!.summary_text, /2 org chart entr\(ies\) taken, 0 dropped where this profile kept its entry, 1 of its own replaced by the folded profile's current one/);
    const meta = JSON.parse(log!.metadata_json) as { orgChartMoved: number; orgChartDropped: number; orgChartReplaced: number };
    assert.deepEqual([meta.orgChartMoved, meta.orgChartDropped, meta.orgChartReplaced], [2, 0, 1]);
  });
  await check("the Org Chart page's read, company and branch: the original once on each, as the receptionist, the duplicate on neither, and nothing added", async () => {
    type Node = { id: string; personEmployeeId: string | null; reportsToNodeId: string | null; positionTitle: string | null; isDisabled: boolean };
    for (const [path, expected] of [
      ["/api/org-chart/nodes?mode=live&scopeType=company", dupCompany],
      [`/api/org-chart/nodes?mode=live&scopeType=branch&scopeBranchId=${BRANCH}`, dupBranch],
    ] as const) {
      const res = await call("GET", path, as.admin);
      assert.equal(res.status, 200, `${path}: ${show(res)}`);
      const nodes = res.body as Node[];
      assert.deepEqual(
        nodes.filter((n) => n.personEmployeeId === original).map((n) => [n.id, n.positionTitle, n.isDisabled]),
        [[expected, "ZZ Receptionist", false]],
        path,
      );
      assert.equal(nodes.filter((n) => n.personEmployeeId === duplicate).length, 0, path);
    }
    const branch = (await call("GET", `/api/org-chart/nodes?mode=live&scopeType=branch&scopeBranchId=${BRANCH}`, as.admin)).body as Node[];
    assert.equal(branch.find((n) => n.id === trainee)?.reportsToNodeId, dupBranch);
    assert.equal(await chartRows(), 4, "the read added no entry");
    assert.equal(await countOf("select count(*) as n from org_nodes where person_employee_id = $1", [original]), 2);
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

  // ── A working duplicate's own records ──────────────────────────────────────
  console.log("7. a working duplicate's own records, part-time on probation:");
  const LEAVE = randomUUID();
  await q("insert into leave_types (id, tenant_id, code, name) values ($1, $2, $3, $4)", [LEAVE, TENANT, `ZZF${run}`, `ZZ TEST fold leave ${run}`]);
  const [{ id: OPERATOR }] = await q<{ id: string }>("insert into operators (tenant_id, name) values ($1, $2) returning id", [TENANT, `ZZ TEST fold operator ${run}`]);
  const [{ id: SCHEDULE_TEMPLATE }] = await q<{ id: string }>(
    "insert into schedule_templates (tenant_id, branch_id, name) values ($1, $2, $3) returning id", [TENANT, BRANCH, `ZZ TEST fold ${run}`]);
  const payrollProfileOf = (employeeId: string, account: string) => q(
    `insert into employee_payroll_profiles (tenant_id, operator_id, employee_id, employment_type, base_salary_monthly, bank_account_number)
     values ($1, $2, $3, 'monthly', 15000, $4)`, [TENANT, OPERATOR, employeeId, account]);
  const timeOffOn = async (employeeId: string, date: string) => (await q<{ id: string }>(
    `insert into employee_time_off (tenant_id, employee_id, branch_id, type, start_date, end_date, created_by)
     values ($1, $2, $3, 'annual', $4, $4, $5) returning id`, [TENANT, employeeId, BRANCH, date, admin.id]))[0]!.id;
  const overrideOf = (employeeId: string, days: number) => q(
    "insert into employee_leave_overrides (tenant_id, employee_id, leave_type_id, annual_days) values ($1, $2, $3, $4)", [TENANT, employeeId, LEAVE, days]);

  // The original: left Promotion; its own payroll profile, opening leave balance and a day off.
  const left = await profile("records-original", { department: PROMOTION, position: "ZZ Promoter", probationDays: 119, probationEnd: "2025-06-01" });
  assert.equal((await offboard(left, plus(-3))).status, 201);
  await payrollProfileOf(left, "ZZ-KEPT");
  await q("insert into employee_leave_balance_openings (tenant_id, employee_id, leave_type_id, snapshot_at, opening_balance) values ($1, $2, $3, now(), 3)", [TENANT, left, LEAVE]);
  const leftDayOff = await timeOffOn(left, plus(2));

  // The duplicate: working part-time in Reception at 500 a day, on probation, 12000 salary default.
  const RECORDS_PROBATION_END = plus(110);
  const working = await profile("records-duplicate", {
    department: RECEPTION, position: "ZZ Receptionist", startDate: plus(-2),
    basis: "PART_TIME", dailyRate: 500, probationDays: 119, probationEnd: RECORDS_PROBATION_END, salary: 12000,
  });
  const workingContract = await contract(working, { status: "active", signing: "signed", start: plus(-2), position: "ZZ Receptionist" });
  const [{ id: letter }] = await q<{ id: string }>(
    `insert into employee_letters (employee_id, branch_id, letter_type, status, signed_at, employee_signed_name, created_by)
     values ($1, $2, 'warning', 'signed', now(), 'ZZ TEST', $3) returning id`, [working, BRANCH, admin.id]);
  const [{ id: document }] = await q<{ id: string }>(
    `insert into employee_documents (employee_id, branch_id, document_type, file_name, file_path, mime_type)
     values ($1, $2, 'id_card', 'zz-test.jpg', 'zz-test/zz-test.jpg', 'image/jpeg') returning id`, [working, BRANCH]);
  const [{ id: asset }] = await q<{ id: string }>(
    "insert into employee_assets (employee_id, branch_id, asset_name_snapshot, assigned_by) values ($1, $2, 'ZZ TEST locker key', $3) returning id",
    [working, BRANCH, admin.id]);
  const sameDayOff = await timeOffOn(working, plus(2)); // the original has that day off already: skipped
  const ownDayOff = await timeOffOn(working, plus(9));
  await q("insert into employee_leave_balance_openings (tenant_id, employee_id, leave_type_id, snapshot_at, opening_balance) values ($1, $2, $3, now(), 1.5)", [TENANT, working, LEAVE]);
  await overrideOf(working, 6);
  await payrollProfileOf(working, "ZZ-DUP");
  await q("insert into staff_cost_allocations (tenant_id, employee_id, branch_id, allocation_percent) values ($1, $2, $3, 100)", [TENANT, working, BRANCH]);
  await q("insert into employee_role_availability (tenant_id, employee_id, role_id, role_name, unavailable_date) values ($1, $2, $3, 'ZZ TEST', $4)", [
    TENANT, working, randomUUID(), plus(4),
  ]);
  await q("insert into schedule_template_time_off (tenant_id, template_id, day_of_week, employee_id, type) values ($1, $2, 2, $3, 'OFF')", [TENANT, SCHEDULE_TEMPLATE, working]);
  await q("insert into employee_presence (employee_id, tenant_id, is_clocked_in, last_event_at) values ($1, $2, true, now())", [working, TENANT]);
  // Its history: an activity entry, the attention engine's own item for it, a staff movement entry and a kiosk sign-in.
  await activity(working, "ZZ TEST fold records history");
  const [{ id: attention }] = await q<{ id: string }>(
    `insert into attention_items (tenant_id, branch_id, employee_id, type, title, status, rule_key, entity_key)
     values ($1, $2, $3, 'PROBATION_REVIEW_DUE_SOON', 'ZZ TEST', 'open', 'PROBATION_REVIEW_DUE_SOON', $4) returning id`,
    [TENANT, BRANCH, working, `employee:${working}:probation-soon`]);
  const [{ id: movement, created_at: movementAt }] = await q<{ id: string; created_at: string }>(
    `insert into employee_changes (employee_id, change_type, effective_date, note, created_by)
     values ($1, 'title_change', now(), 'ZZ TEST', $2) returning id, created_at::text as created_at`, [working, admin.id]);
  await q("insert into kiosk_auth_attempts (id, employee_id, branch_id, method, outcome) values ($1, $2, $3, 'FACE', 'SUCCESS')", [randomUUID(), working, BRANCH]);

  const RECORDS_MOVES = {
    ...NONE, contracts: 1, documents: 1, letters: 1, assets: 1, timeOff: 1, availability: 2, leaveSettings: 2, payrollProfile: 1, costAllocations: 1, history: 4,
  };
  await check("the preview counts the letter, document, property, leave, availability, leave settings, payroll profile, cost allocation and history, the day off skipped and the original's own replaced, and the part-time probation terms", async () => {
    const res = await call("GET", `/api/employees/${working}/fold-into/${left}/preview`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.moved, RECORDS_MOVES);
    assert.deepEqual(res.body.skipped, { ...NONE, timeOff: 1 });
    assert.deepEqual(res.body.replaced, { payrollProfile: 1, costAllocations: 0, leaveSettings: 1 });
    assert.deepEqual([res.body.reonboard.started, res.body.reonboard.employmentBasis, res.body.reonboard.probationEndDate], [true, "PART_TIME", RECORDS_PROBATION_END]);
    assert.equal(await countOf("select count(*) as n from employee_letters where employee_id = $1", [working]), 1);
    assert.deepEqual(await termsOf(left), {
      employment_basis: "FULL_TIME", daily_rate: null, probation_days: 119, probation_end: "2025-06-01", probation_review_completed_at: null, salary: 15000,
    });
  });
  await check("the fold keeps every one of them on the original, and the original reads as the duplicate's employment: part-time, 500 a day, on probation, its salary", async () => {
    const res = await call("POST", `/api/employees/${working}/fold-into/${left}`, as.admin);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.moved, RECORDS_MOVES);
    assert.equal(await exists(working), 0);
    assert.deepEqual(await termsOf(left), {
      employment_basis: "PART_TIME", daily_rate: 500, probation_days: 119, probation_end: RECORDS_PROBATION_END, probation_review_completed_at: null, salary: 12000,
    });
    const kept = await row(left);
    assert.deepEqual([kept.status, kept.employment_state, kept.primary_department_id, kept.position], ["active", "ACTIVE", RECEPTION, "ZZ Receptionist"]);
    assert.deepEqual(await q("select status, employment_basis, contract_instance_id from employee_engagements where employee_id = $1", [left]), [
      { status: "active", employment_basis: "PART_TIME", contract_instance_id: workingContract },
    ]);
    assert.deepEqual(await q("select employee_id, status from employee_letters where id = $1", [letter]), [{ employee_id: left, status: "signed" }]);
    assert.deepEqual(await q("select employee_id from employee_documents where id = $1", [document]), [{ employee_id: left }]);
    assert.deepEqual(await q("select employee_id from employee_assets where id = $1", [asset]), [{ employee_id: left }]);
    assert.deepEqual(
      (await q<{ id: string }>("select id from employee_time_off where employee_id = $1", [left])).map((r) => r.id).sort(),
      [leftDayOff, ownDayOff].sort(),
    );
    assert.equal(await countOf("select count(*) as n from employee_time_off where id = $1", [sameDayOff]), 0);
    assert.deepEqual(await q("select bank_account_number from employee_payroll_profiles where employee_id = $1", [left]), [{ bank_account_number: "ZZ-DUP" }]);
    assert.deepEqual(await q("select opening_balance from employee_leave_balance_openings where employee_id = $1", [left]), [{ opening_balance: 1.5 }]);
    assert.deepEqual(await q("select annual_days from employee_leave_overrides where employee_id = $1", [left]), [{ annual_days: 6 }]);
    assert.equal(await countOf("select count(*) as n from staff_cost_allocations where employee_id = $1", [left]), 1);
    assert.equal(await countOf("select count(*) as n from employee_role_availability where employee_id = $1", [left]), 1);
    assert.equal(await countOf("select count(*) as n from schedule_template_time_off where employee_id = $1", [left]), 1);
    assert.deepEqual(await q("select is_clocked_in from employee_presence where employee_id = $1", [left]), [{ is_clocked_in: true }]);
    assert.deepEqual(await q("select employee_id, status from attention_items where id = $1", [attention]), [{ employee_id: left, status: "resolved" }]);
    assert.equal(await countOf("select count(*) as n from activity_log where employee_id = $1 and summary_text = 'ZZ TEST fold records history'", [left]), 1);
    // The movement entry moved whole: its own id, words, author and time.
    assert.deepEqual(
      await q("select employee_id, change_type, note, created_by, created_at::text as created_at from employee_changes where id = $1", [movement]),
      [{ employee_id: left, change_type: "title_change", note: "ZZ TEST", created_by: admin.id, created_at: movementAt }],
    );
    assert.equal(await countOf("select count(*) as n from kiosk_auth_attempts where employee_id = $1", [left]), 1);
  });

  console.log("8. refused:");
  await check("a payroll profile and leave settings on both profiles, nobody onboarded again: refused naming them, and nothing moves", async () => {
    const kept = await profile("both-records-original", { department: PROMOTION, position: "ZZ Promoter" });
    const other = await profile("both-records", { department: PROMOTION, position: "ZZ Promoter" });
    await payrollProfileOf(kept, "ZZ-KEPT-2");
    await payrollProfileOf(other, "ZZ-OTHER-2");
    await overrideOf(kept, 6);
    await overrideOf(other, 8);
    const otherDayOff = await timeOffOn(other, plus(12));
    for (const [method, path] of [["GET", `/api/employees/${other}/fold-into/${kept}/preview`], ["POST", `/api/employees/${other}/fold-into/${kept}`]] as const) {
      const res = await call(method, path, as.admin);
      assert.equal(res.status, 409, `${method}: ${show(res)}`);
      assert.deepEqual([res.body.reason, res.body.blocking], ["has_records", [{ label: "payroll profiles", count: 1 }, { label: "leave settings", count: 1 }]]);
    }
    assert.equal(await exists(other), 1);
    assert.deepEqual(await q("select employee_id from employee_time_off where id = $1", [otherDayOff]), [{ employee_id: other }]);
    assert.deepEqual(await q("select bank_account_number from employee_payroll_profiles where employee_id = $1", [kept]), [{ bank_account_number: "ZZ-KEPT-2" }]);
  });
  await check("a re-onboarding still to come on other terms (part-time) is refused until its start date, and nothing moves", async () => {
    const later = plus(8);
    const kept = await profile("terms-leaving", { department: PROMOTION, position: "ZZ Promoter" });
    await contract(kept, { status: "active", signing: "signed", start: plus(-100), position: "ZZ Promoter" });
    assert.equal((await offboard(kept, plus(5))).status, 201);
    const other = await profile("terms-starting", { department: RECEPTION, position: "ZZ Receptionist", startDate: later, basis: "PART_TIME", dailyRate: 450 });
    const next = await contract(other, { status: "active", signing: "signed", start: later, position: "ZZ Receptionist" });
    const res = await call("POST", `/api/employees/${other}/fold-into/${kept}`, as.admin);
    assert.deepEqual([res.status, res.body.reason], [409, "terms_differ"], show(res));
    assert.match(res.body.message, new RegExp(`Fold on or after ${later}`));
    assert.equal(await exists(other), 1);
    assert.deepEqual(await contractOf(next), { employee_id: other, status: "active", signing_status: "signed" });
    assert.equal(await countOf("select count(*) as n from employee_engagements where employee_id = $1", [kept]), 0);
  });

  console.log("9. the org chart, and what a fold does not move:");
  await check("an entry deleted from the chart and added back by the next read: the live one is taken, the marked one deleted, the kept profile once on the chart", async () => {
    const kept = await profile("chart-kept", { department: PROMOTION, position: "ZZ Promoter" });
    const other = await profile("chart-dup", { department: PROMOTION, position: "ZZ Promoter" });
    // The app's delete of an entry marks it deleted; the next read adds the active employee again.
    const marked = await orgEntry({ scope: "company", person: other, deleted: true });
    const readBack = await orgEntry({ scope: "company", person: other, sort: 1 });
    const preview = await call("GET", `/api/employees/${other}/fold-into/${kept}/preview`, as.admin);
    assert.deepEqual([preview.status, preview.body.orgChartMoved, preview.body.orgChartDropped, preview.body.orgChartReplaced], [200, 1, 1, 0], show(preview));
    const res = await call("POST", `/api/employees/${other}/fold-into/${kept}`, as.admin);
    assert.deepEqual([res.status, res.body.orgChartMoved, res.body.orgChartDropped, res.body.orgChartReplaced], [200, 1, 1, 0], show(res));
    assert.equal(await entryOf(marked), undefined);
    assert.deepEqual(await entryOf(readBack), { person_employee_id: kept, reports_to_node_id: null, position_title: null, sort_order: 1, is_deleted: false });
    const read = await call("GET", "/api/org-chart/nodes?mode=live&scopeType=company", as.admin);
    assert.equal(read.status, 200, show(read));
    const nodes = read.body as { id: string; personEmployeeId: string | null }[];
    assert.deepEqual(nodes.filter((n) => n.personEmployeeId === kept).map((n) => n.id), [readBack]);
    assert.equal(nodes.filter((n) => n.personEmployeeId === other).length, 0);
  });
  await check("the kept profile's entry below the duplicate's (a draft branch chart): it takes the dropped entry's parent, the other entry under it reports to the kept one", async () => {
    const kept = await profile("below-kept", { department: PROMOTION, position: "ZZ Promoter" });
    const other = await profile("below-dup", { department: PROMOTION, position: "ZZ Promoter" });
    const top = await orgEntry({ scope: "branch", mode: "draft", position: "ZZ Manager" });
    const dropped = await orgEntry({ scope: "branch", mode: "draft", person: other, parent: top });
    const keptEntry = await orgEntry({ scope: "branch", mode: "draft", person: kept, parent: dropped });
    const beside = await orgEntry({ scope: "branch", mode: "draft", parent: dropped, position: "ZZ Assistant" });
    const res = await call("POST", `/api/employees/${other}/fold-into/${kept}`, as.admin);
    assert.deepEqual([res.status, res.body.orgChartMoved, res.body.orgChartDropped, res.body.orgChartReplaced], [200, 0, 1, 0], show(res));
    assert.equal(await entryOf(dropped), undefined);
    assert.equal((await entryOf(keptEntry))?.reports_to_node_id, top);
    assert.equal((await entryOf(beside))?.reports_to_node_id, keptEntry);
  });
  await check("the kept profile's entry disabled and the duplicate's not, both working: the duplicate's taken in its place, the disabled one deleted, the entries under either under the one taken, none below itself; where neither is disabled the kept profile's stays", async () => {
    const kept = await profile("disabled-kept", { department: PROMOTION, position: "ZZ Promoter" });
    const other = await profile("disabled-dup", { department: PROMOTION, position: "ZZ Promoter" });
    // The live company chart: the kept profile's old entry disabled, a position
    // under it; the duplicate's under a manager, a team member under it.
    const manager = await orgEntry({ scope: "company", position: "ZZ Manager" });
    const keptOld = await orgEntry({ scope: "company", person: kept, position: "ZZ old position", disabled: true });
    const underOld = await orgEntry({ scope: "company", parent: keptOld, position: "ZZ old assistant" });
    const current = await orgEntry({ scope: "company", person: other, parent: manager, position: "ZZ current position", sort: 4 });
    const team = await orgEntry({ scope: "company", parent: current, position: "ZZ team member" });
    // A draft branch chart: the duplicate's entry below the kept profile's disabled one.
    const head = await orgEntry({ scope: "branch", mode: "draft", position: "ZZ Head" });
    const draftOld = await orgEntry({ scope: "branch", mode: "draft", person: kept, parent: head, disabled: true });
    const draftCurrent = await orgEntry({ scope: "branch", mode: "draft", person: other, parent: draftOld, position: "ZZ current position" });
    const draftBeside = await orgEntry({ scope: "branch", mode: "draft", parent: draftOld, position: "ZZ Assistant" });
    // The live branch chart: neither disabled, nobody onboarded again.
    const keptBranch = await orgEntry({ scope: "branch", person: kept, position: "ZZ Promoter" });
    const otherBranch = await orgEntry({ scope: "branch", person: other, position: "ZZ current position", sort: 1 });
    const branchUnder = await orgEntry({ scope: "branch", parent: otherBranch, position: "ZZ Helper" });

    const preview = await call("GET", `/api/employees/${other}/fold-into/${kept}/preview`, as.admin);
    assert.deepEqual([preview.status, preview.body.orgChartMoved, preview.body.orgChartDropped, preview.body.orgChartReplaced], [200, 2, 1, 2], show(preview));
    assert.deepEqual(await entryOf(keptOld), { person_employee_id: kept, reports_to_node_id: null, position_title: "ZZ old position", sort_order: 0, is_deleted: false });
    assert.equal((await entryOf(current))?.person_employee_id, other);
    assert.equal((await entryOf(team))?.reports_to_node_id, current);
    assert.equal((await entryOf(draftCurrent))?.reports_to_node_id, draftOld);
    assert.equal((await entryOf(otherBranch))?.person_employee_id, other);

    const res = await call("POST", `/api/employees/${other}/fold-into/${kept}`, as.admin);
    assert.deepEqual([res.status, res.body.orgChartMoved, res.body.orgChartDropped, res.body.orgChartReplaced], [200, 2, 1, 2], show(res));
    // The live company chart: the working entry stays where it is, now the kept profile's.
    assert.deepEqual(await entryOf(current), { person_employee_id: kept, reports_to_node_id: manager, position_title: "ZZ current position", sort_order: 4, is_deleted: false });
    assert.equal(await entryOf(keptOld), undefined, "deleted, not marked deleted");
    assert.equal((await entryOf(team))?.reports_to_node_id, current);
    assert.equal((await entryOf(underOld))?.reports_to_node_id, current);
    // The draft branch chart: the one taken takes the disabled entry's parent.
    assert.equal(await entryOf(draftOld), undefined);
    assert.deepEqual(await entryOf(draftCurrent), { person_employee_id: kept, reports_to_node_id: head, position_title: "ZZ current position", sort_order: 0, is_deleted: false });
    assert.equal((await entryOf(draftBeside))?.reports_to_node_id, draftCurrent);
    // The live branch chart: the kept profile's entry stays, the duplicate's deleted.
    assert.equal(await entryOf(otherBranch), undefined);
    assert.deepEqual(await entryOf(keptBranch), { person_employee_id: kept, reports_to_node_id: null, position_title: "ZZ Promoter", sort_order: 0, is_deleted: false });
    assert.equal((await entryOf(branchUnder))?.reports_to_node_id, keptBranch);
    assert.deepEqual(
      (await q<{ id: string; is_disabled: boolean }>("select id, is_disabled from org_nodes where person_employee_id = $1", [kept]))
        .map((r) => [r.id, r.is_disabled]).sort(),
      [[current, false], [draftCurrent, false], [keptBranch, false]].sort(),
    );
    // The Org Chart page's read: the kept profile once, enabled, under the manager, in the working position.
    const read = await call("GET", "/api/org-chart/nodes?mode=live&scopeType=company", as.admin);
    assert.equal(read.status, 200, show(read));
    const nodes = read.body as { id: string; personEmployeeId: string | null; reportsToNodeId: string | null; positionTitle: string | null; isDisabled: boolean }[];
    assert.deepEqual(
      nodes.filter((n) => n.personEmployeeId === kept).map((n) => [n.id, n.reportsToNodeId, n.positionTitle, n.isDisabled]),
      [[current, manager, "ZZ current position", false]],
    );
    assert.equal(nodes.filter((n) => n.personEmployeeId === other).length, 0);
    assert.equal(nodes.find((n) => n.id === team)?.reportsToNodeId, current);
  });
  await check("anything else still pointing at the duplicate is named, every table, \"still linked by …\", in the preview and the fold, and nothing moves", async () => {
    const kept = await profile("linked-kept", { department: PROMOTION, position: "ZZ Promoter" });
    const other = await profile("linked-dup", { department: PROMOTION, position: "ZZ Promoter" });
    const entry = await orgEntry({ scope: "company", person: other, sort: 5 });
    await shift(other, plus(30));
    await q(
      `insert into nanny_reservations (tenant_id, branch_id, nanny_employee_id, nanny_full_name, reservation_date, start_time, end_time, duration_minutes)
       values ($1, $2, $3, 'ZZ TEST', $4, '10:00', '11:00', 60)`, [TENANT, BRANCH, other, plus(30)]);
    await q("insert into user_vouchers (tenant_id, token, remaining_uses, employee_id) values ($1, $2, 1, $3)", [TENANT, `zz-fold-${randomUUID()}`, other]);
    for (const [method, path] of [["GET", `/api/employees/${other}/fold-into/${kept}/preview`], ["POST", `/api/employees/${other}/fold-into/${kept}`]] as const) {
      const res = await call(method, path, as.admin);
      assert.equal(res.status, 409, `${method}: ${show(res)}`);
      assert.deepEqual([res.body.reason, res.body.blocking], [
        "still_referenced",
        [{ label: "still linked by nanny reservations", count: 1 }, { label: "still linked by vouchers", count: 1 }],
      ]);
      assert.match(res.body.message, /^This profile is still linked by nanny reservations and vouchers, which a fold does not move, so nothing was folded\./);
    }
    assert.equal(await exists(other), 1);
    assert.equal((await entryOf(entry))?.person_employee_id, other);
    assert.equal(await countOf("select count(*) as n from schedule_assignments where employee_id = $1", [other]), 1);
  });

  console.log(`employee-fold.check: ${checks} checks passed`);
} catch (err) {
  console.error("employee-fold.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
