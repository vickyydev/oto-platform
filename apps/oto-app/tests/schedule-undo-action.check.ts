// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-777 — undo one Schedule History action without touching later
// changes. Over HTTP against the routes as registered:
//
//   1. Applying a template records its change set: the shift rows, the row
//      role, the shifts and the day off it created, nothing deleted; the
//      history list says the entry can be undone.
//   2. Afterwards somebody else adds shifts by hand (a Housekeeping shift on
//      its own row, a Childcare shift on a row the template made), the week's
//      breaks are worked out, and one of the template's shifts is given to
//      another person.
//   3. Undoing the template entry removes only what the template did: its
//      shifts, its day off, the row nobody uses now and that row's role. The
//      hand-added shifts stay, the reassigned shift is left and reported
//      ("changed since"), and the two rows that have shifts on them now stay
//      and are reported ("still has shifts on it"). Breaks follow the shifts.
//   4. The undo logs its own entry, with its own change set.
//   5. A second undo of the same entry undoes nothing and says so, and logs
//      nothing.
//   6. An entry written before change sets existed answers 409: only Restore
//      is available; a restore entry cannot be undone on its own either.
//   7. Undoing a cleared week puts back the shifts it removed whose slot is
//      still free and reports the one whose slot is taken now; a week
//      deleted whole comes back with its shift.
//   8. An undo can itself be undone: what it removed comes back.
//   9. Another park group's manager cannot undo the entry (404), as with
//      Restore.
//  10. A shift another manager adds by hand while a template is being applied
//      (the apply held part-way, after it has written its shifts) is not
//      recorded as the template's, and undoing the template leaves it.
//  11. Undoing a clear puts back nothing the app's own rules refuse now: not
//      a shift on a day the person is on leave now (a new shift there is
//      refused too, ON_LEAVE), not a day off on a day they work now, not a
//      day off inside a leave that starts on an earlier day.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/schedule-undo-action.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("schedule-undo-action.check: DATABASE_URL is not set");
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
const monday = (offsetWeeks: number) => {
  const t = Date.now() + offsetWeeks * 7 * DAY_MS;
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// ─── One park group: a branch, Childcare and Housekeeping, a manager ─────────

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST s777 ${run}`, `zz-s777-${run}`]);
const BRANCH = randomUUID();
await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [BRANCH, TENANT, `ZZ TEST s777 park ${run}`]);
async function department(label: string): Promise<string> {
  const id = randomUUID();
  await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [id, TENANT, `ZZ TEST s777 ${label} ${run}`]);
  return id;
}
const CHILDCARE = await department("Childcare");
const HOUSEKEEPING = await department("Housekeeping");
const GROUP = randomUUID();
await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [GROUP, TENANT, BRANCH, `ZZ TEST s777 ${run}`]);
const ROLE = randomUUID();
await q("insert into roles (id, tenant_id, name) values ($1, $2, $3)", [ROLE, TENANT, `ZZ TEST s777 carer ${run}`]);

async function user(tenant: string, label: string) {
  const id = randomUUID();
  const email = `zz-s777-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, 'admin', true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST s777 ${label} ${run}`],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  return { id, email };
}
const manager = await user(TENANT, "manager");

async function employee(label: string, departmentId: string, carer: boolean): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, primary_department_id, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'active')`,
    [id, TENANT, BRANCH, `ZZ TEST s777 ${label} ${run}`, label, `zz-s777-${label.toLowerCase()}-${run}@example.com`, departmentId],
  );
  if (carer) await q("insert into employee_roles (employee_id, role_id) values ($1, $2)", [id, ROLE]);
  return id;
}
const ANNA = await employee("Anna", CHILDCARE, true);
const BEN = await employee("Ben", CHILDCARE, true);
const DAO = await employee("Dao", CHILDCARE, false);
const ELLA = await employee("Ella", CHILDCARE, true);
const CHAI = await employee("Chai", HOUSEKEEPING, false);

/** Housekeeping's own row, there before anything below. */
const HK_ROW = randomUUID();
await q(
  `insert into schedule_shift_rows (id, tenant_id, branch_id, department_id, shift_group_id, label, start_time, end_time)
   values ($1, $2, $3, $4, $5, 'ZZ Housekeeping', '08:00', '16:00')`,
  [HK_ROW, TENANT, BRANCH, HOUSEKEEPING, GROUP],
);

// The Childcare template: Morning, Evening (a carer row) and Late (a carer
// row); five shifts and a day off.
const TEMPLATE = randomUUID();
await q("insert into schedule_templates (id, tenant_id, branch_id, department_id, shift_group_id, name) values ($1, $2, $3, $4, $5, $6)", [
  TEMPLATE, TENANT, BRANCH, CHILDCARE, GROUP, `ZZ TEST s777 Childcare week ${run}`,
]);
async function templateRow(label: string, start: string, end: string, order: number, carer: boolean): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into schedule_template_rows (id, tenant_id, template_id, department_id, shift_group_id, row_order, label, start_time, end_time)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, TENANT, TEMPLATE, CHILDCARE, GROUP, order, label, start, end],
  );
  if (carer) await q("insert into schedule_template_row_roles (tenant_id, template_row_id, role_id) values ($1, $2, $3)", [TENANT, id, ROLE]);
  return id;
}
const T_MORNING = await templateRow(`ZZ Morning ${run}`, "07:00", "12:00", 0, false);
const T_EVENING = await templateRow(`ZZ Evening ${run}`, "13:00", "18:00", 1, true);
const T_LATE = await templateRow(`ZZ Late ${run}`, "18:30", "22:30", 2, true);
for (const [row, day, person] of [
  [T_MORNING, 0, ANNA], [T_MORNING, 1, ANNA], [T_EVENING, 0, BEN], [T_EVENING, 1, BEN], [T_LATE, 3, ANNA],
] as const) {
  await q("insert into schedule_template_assignments (template_row_id, day_of_week, employee_id) values ($1, $2, $3)", [row, day, person]);
}
await q("insert into schedule_template_time_off (tenant_id, template_id, day_of_week, employee_id, type) values ($1, $2, 4, $3, 'CHANGE_DAY_OFF')", [
  TENANT, TEMPLATE, ANNA,
]);

const WEEK = monday(10);
const CLEAR_WEEK = monday(11);
const DELETED_WEEK = monday(12);
const RACE_WEEK = monday(13);
const LEAVE_WEEK = monday(14);

// ─── Another park group's manager ────────────────────────────────────────────

const OTHER_TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [OTHER_TENANT, `ZZ TEST s777b ${run}`, `zz-s777b-${run}`]);
await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [randomUUID(), OTHER_TENANT, `ZZ TEST s777b park ${run}`]);
const stranger = await user(OTHER_TENANT, "stranger");

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
    const timer = setTimeout(() => reject(new Error("harness did not start")), 90_000);
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
      reject(new Error(`harness exited ${code}`));
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
    // Not JSON (a 204 has no body) — kept as text.
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
  assert.equal(res.status, 200, `sign-in: ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

type Shift = { id: string; shift_row_id: string; shift_date: string; employee_id: string };
/** The park's shifts in a week, as rows. */
const shiftsIn = (from: string) =>
  q<Shift>(
    `select a.id, a.shift_row_id, to_char(a.shift_date, 'YYYY-MM-DD') as shift_date, a.employee_id
       from schedule_assignments a join schedule_shift_rows r on r.id = a.shift_row_id
      where r.branch_id = $1 and a.shift_date between $2::date and $3::date order by a.shift_date, a.employee_id`,
    [BRANCH, from, plus(from, 6)],
  );
const rowNamed = async (label: string) =>
  (await q<{ id: string }>("select id from schedule_shift_rows where branch_id = $1 and label = $2", [BRANCH, label]))[0]?.id;
const historyOf = (action: string) =>
  q<{ id: string; change_set: any; description: string }>( // eslint-disable-line @typescript-eslint/no-explicit-any -- jsonb read field by field
    "select id, change_set, description from schedule_audit_log where tenant_id = $1 and action = $2 order by created_at",
    [TENANT, action],
  );
const breaksOn = async (assignmentId: string) =>
  Number((await q<{ n: string }>("select count(*) as n from schedule_shift_breaks where assignment_id = $1", [assignmentId]))[0]!.n);
/** A row of time off written straight into the table, as a template or the leave screens leave it. */
const timeOffRow = (employeeId: string, type: string, from: string, until: string) =>
  q(
    `insert into employee_time_off (tenant_id, employee_id, branch_id, type, start_date, end_date, created_by)
     values ($1, $2, $3, $4, $5::timestamp, $6::timestamp, $7)`,
    [TENANT, employeeId, BRANCH, type, from, until, manager.id],
  );
async function waitFor(test: () => Promise<boolean>, what: string): Promise<void> {
  const until = Date.now() + 30_000;
  while (!(await test())) {
    if (Date.now() > until) throw new Error(what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

try {
  ORIGIN = await serve();
  const cookie = await signIn(manager.email);
  const strangerCookie = await signIn(stranger.email);

  console.log("1. applying a template records what it did:");
  let applyEntry = "";
  let morning = "";
  let evening = "";
  let late = "";
  await check("the change set holds the rows, the role, the shifts and the day off it created, and nothing deleted", async () => {
    const res = await call("POST", `/api/schedule/templates/${TEMPLATE}/apply-safe`, cookie, { branchId: BRANCH, weekStartDate: WEEK });
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.rowsAdded, res.body.assignmentsApplied, res.body.timeOffApplied], [3, 5, 1], show(res));
    const [entry] = await historyOf("apply_template_additive");
    assert.ok(entry?.change_set, "the history entry has no change set");
    applyEntry = entry.id;
    morning = (await rowNamed(`ZZ Morning ${run}`))!;
    evening = (await rowNamed(`ZZ Evening ${run}`))!;
    late = (await rowNamed(`ZZ Late ${run}`))!;
    const created = entry.change_set.created;
    assert.deepEqual(created.shiftRows.map((r: { id: string }) => r.id).sort(), [morning, evening, late].sort());
    assert.equal(created.rowRoles.length, 2, "the two carer rows' roles");
    assert.equal(created.assignments.length, 5);
    assert.equal(created.timeOff.length, 1);
    assert.deepEqual(entry.change_set.deleted, {}, "a template applied this way deletes nothing");
    const list = await call("GET", `/api/schedule/audit-log?branchId=${BRANCH}`, cookie);
    assert.equal(list.status, 200, show(list));
    assert.equal(list.body.find((e: { id: string }) => e.id === applyEntry)?.hasChangeSet, true);
  });

  console.log("2. other people's work afterwards:");
  let chaiShift = "";
  let daoShift = "";
  let reassigned = "";
  await check("a Housekeeping shift on its own row, a Childcare shift on the template's row, the breaks, one template shift reassigned", async () => {
    const hk = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: WEEK, employeeId: CHAI });
    assert.equal(hk.status, 201, show(hk));
    chaiShift = hk.body.id;
    const cc = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: morning, shiftDate: plus(WEEK, 2), employeeId: DAO });
    assert.equal(cc.status, 201, show(cc));
    daoShift = cc.body.id;
    const [plan] = await q<{ id: string }>("select id from schedule_week_plans where branch_id = $1 and week_start_date = $2::date", [BRANCH, WEEK]);
    const breaks = await call("POST", `/api/schedule/week/${plan!.id}/regenerate-breaks`, cookie);
    assert.equal(breaks.status, 200, show(breaks));
    const [benTuesday] = (await shiftsIn(WEEK)).filter((s) => s.shift_row_id === evening && s.shift_date === plus(WEEK, 1));
    const moved = await call("PATCH", `/api/schedule/assignments/${benTuesday!.id}/reassign`, cookie, { employeeId: ELLA });
    assert.equal(moved.status, 200, show(moved));
    reassigned = benTuesday!.id;
    assert.equal((await shiftsIn(WEEK)).length, 7, "five template shifts and two by hand");
  });

  console.log("3. undoing the template entry:");
  let undoAnswer: Answer = { status: 0, body: null };
  await check("removes only what the template did and reports what it left", async () => {
    undoAnswer = await call("POST", `/api/schedule/audit-log/${applyEntry}/undo`, cookie);
    assert.equal(undoAnswer.status, 200, show(undoAnswer));
    const body = undoAnswer.body;
    // Four shifts, the day off, the Late row and its role.
    assert.deepEqual([body.undoneCreated, body.restoredDeleted, body.changedBack, body.nothingUndone], [7, 0, 0, false], show(undoAnswer));
    const reasons = (body.skipped as { kind: string; id: string; reason: string }[]).map((s) => `${s.kind}:${s.id}:${s.reason}`).sort();
    assert.deepEqual(reasons, [
      `assignments:${reassigned}:changed since`,
      `shiftRows:${evening}:still has shifts on it`,
      `shiftRows:${morning}:still has shifts on it`,
    ].sort());
    assert.equal(body.skippedCount, 3);
  });
  await check("the hand-added shifts and the reassigned shift stay; the template's other shifts and its day off are gone", async () => {
    assert.deepEqual((await shiftsIn(WEEK)).map((s) => s.id).sort(), [chaiShift, daoShift, reassigned].sort());
    const dayOff = await q("select id from employee_time_off where employee_id = $1 and branch_id = $2", [ANNA, BRANCH]);
    assert.equal(dayOff.length, 0, "the template's day off is still there");
  });
  await check("the row nobody uses goes with its role; the rows with shifts on them now stay", async () => {
    assert.equal(await rowNamed(`ZZ Late ${run}`), undefined, "the Late row is still there");
    assert.equal((await q("select id from schedule_shift_row_roles where shift_row_id = $1", [late])).length, 0);
    assert.equal(await rowNamed(`ZZ Morning ${run}`), morning);
    assert.equal(await rowNamed(`ZZ Evening ${run}`), evening);
    assert.equal((await q("select id from schedule_shift_row_roles where shift_row_id = $1", [evening])).length, 1, "the Evening row lost its role");
  });
  await check("breaks follow the shifts: every shift left has its break, none is left on a removed shift", async () => {
    for (const id of [chaiShift, daoShift, reassigned]) assert.equal(await breaksOn(id), 1, `shift ${id} has no break`);
    const orphans = await q("select b.id from schedule_shift_breaks b where b.branch_id = $1 and not exists (select 1 from schedule_assignments a where a.id = b.assignment_id)", [BRANCH]);
    assert.equal(orphans.length, 0);
  });

  console.log("4. the undo's own entry:");
  await check("the undo logs an entry naming the undone one, with its own change set", async () => {
    const entries = await historyOf("undo_action");
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.match(entry!.description, /^Undid the action of .* \(Applied template \(additive\) to week /);
    assert.equal(entry!.change_set.deleted.assignments.length, 4);
    assert.equal(entry!.change_set.deleted.timeOff.length, 1);
    assert.deepEqual(entry!.change_set.deleted.shiftRows.map((r: { id: string }) => r.id), [late]);
    const list = await call("GET", `/api/schedule/audit-log?branchId=${BRANCH}`, cookie);
    const listed = list.body.find((e: { id: string }) => e.id === entry!.id);
    assert.deepEqual([listed?.action, listed?.hasChangeSet, listed?.hasSnapshot], ["undo_action", true, false]);
  });

  console.log("5. a second undo of the same entry:");
  await check("undoes nothing, says so, and logs nothing", async () => {
    const before = (await historyOf("undo_action")).length;
    const shifts = (await shiftsIn(WEEK)).map((s) => s.id).sort();
    const again = await call("POST", `/api/schedule/audit-log/${applyEntry}/undo`, cookie);
    assert.equal(again.status, 200, show(again));
    assert.deepEqual([again.body.undoneCreated, again.body.restoredDeleted, again.body.changedBack, again.body.nothingUndone], [0, 0, 0, true]);
    assert.match(again.body.message, /^Nothing was undone/);
    assert.equal((await historyOf("undo_action")).length, before);
    assert.deepEqual((await shiftsIn(WEEK)).map((s) => s.id).sort(), shifts);
  });

  console.log("6. entries without a change set:");
  await check("an entry from before change sets answers 409: only Restore is available; a restore entry cannot be undone either", async () => {
    const [old] = await q<{ id: string }>(
      `insert into schedule_audit_log (tenant_id, branch_id, action, description, snapshot_data)
       values ($1, $2, 'apply_template_additive', 'ZZ TEST older entry', '{"shiftRows": []}'::jsonb) returning id`,
      [TENANT, BRANCH],
    );
    const res = await call("POST", `/api/schedule/audit-log/${old!.id}/undo`, cookie);
    assert.equal(res.status, 409, show(res));
    assert.match(res.body.message, /Only Restore is available/);
    const [restore] = await q<{ id: string }>(
      "insert into schedule_audit_log (tenant_id, branch_id, action, description) values ($1, $2, 'restore_from_snapshot', 'ZZ TEST restore') returning id",
      [TENANT, BRANCH],
    );
    const refused = await call("POST", `/api/schedule/audit-log/${restore!.id}/undo`, cookie);
    assert.equal(refused.status, 409, show(refused));
    assert.match(refused.body.message, /cannot be undone on its own/);
  });

  console.log("7. undoing a cleared week:");
  await check("puts back the shifts it removed whose slot is free, and reports the one whose slot is taken now", async () => {
    const mon = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: CLEAR_WEEK, employeeId: CHAI });
    const tuesday = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: plus(CLEAR_WEEK, 1), employeeId: CHAI });
    assert.deepEqual([mon.status, tuesday.status], [201, 201], `${show(mon)} ${show(tuesday)}`);
    const clear = await call("POST", "/api/schedule/clear", cookie, {
      branchId: BRANCH, departmentId: HOUSEKEEPING, startDate: CLEAR_WEEK, endDate: plus(CLEAR_WEEK, 6),
    });
    assert.equal(clear.status, 200, show(clear));
    assert.equal((await shiftsIn(CLEAR_WEEK)).length, 0);
    const [entry] = await historyOf("clear_week");
    assert.equal(entry!.change_set.deleted.assignments.length, 2);
    const again = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: plus(CLEAR_WEEK, 1), employeeId: CHAI });
    assert.equal(again.status, 201, show(again));
    const undo = await call("POST", `/api/schedule/audit-log/${entry!.id}/undo`, cookie);
    assert.equal(undo.status, 200, show(undo));
    assert.deepEqual([undo.body.undoneCreated, undo.body.restoredDeleted], [0, 1], show(undo));
    assert.deepEqual(undo.body.skipped, [{ kind: "assignments", id: tuesday.body.id, reason: "that slot is taken now" }]);
    assert.deepEqual((await shiftsIn(CLEAR_WEEK)).map((s) => s.id).sort(), [mon.body.id, again.body.id].sort());
    assert.equal(await breaksOn(mon.body.id), 1, "the shift put back has no break");
  });
  await check("a week deleted whole comes back with its shift", async () => {
    const shift = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: DELETED_WEEK, employeeId: CHAI });
    assert.equal(shift.status, 201, show(shift));
    const plan = shift.body.weekPlanId as string;
    const removed = await call("DELETE", `/api/schedule/week/${plan}`, cookie);
    assert.equal(removed.status, 204, show(removed));
    assert.equal((await shiftsIn(DELETED_WEEK)).length, 0);
    const [entry] = await q<{ id: string; change_set: any }>( // eslint-disable-line @typescript-eslint/no-explicit-any -- jsonb read field by field
      "select id, change_set from schedule_audit_log where week_plan_id = $1 and action = 'clear_week'", [plan]);
    assert.deepEqual([entry!.change_set.deleted.weekPlans.length, entry!.change_set.deleted.assignments.length], [1, 1]);
    const undo = await call("POST", `/api/schedule/audit-log/${entry!.id}/undo`, cookie);
    assert.equal(undo.status, 200, show(undo));
    assert.deepEqual([undo.body.restoredDeleted, undo.body.skippedCount], [2, 0], show(undo));
    assert.equal((await q("select id from schedule_week_plans where id = $1", [plan])).length, 1, "the week is not back");
    assert.deepEqual((await shiftsIn(DELETED_WEEK)).map((s) => s.id), [shift.body.id]);
    assert.equal(await breaksOn(shift.body.id), 1, "the shift put back has no break");
  });

  console.log("8. undoing an undo:");
  await check("what the undo removed comes back", async () => {
    const [entry] = await historyOf("undo_action");
    const redo = await call("POST", `/api/schedule/audit-log/${entry!.id}/undo`, cookie);
    assert.equal(redo.status, 200, show(redo));
    assert.deepEqual([redo.body.undoneCreated, redo.body.restoredDeleted, redo.body.skippedCount], [0, 7, 0], show(redo));
    assert.equal(await rowNamed(`ZZ Late ${run}`), late);
    assert.equal((await shiftsIn(WEEK)).length, 7);
    assert.equal((await q("select id from employee_time_off where employee_id = $1 and branch_id = $2", [ANNA, BRANCH])).length, 1);
  });

  console.log("9. another park group:");
  await check("another park group's manager cannot undo the entry", async () => {
    const res = await call("POST", `/api/schedule/audit-log/${applyEntry}/undo`, strangerCookie);
    assert.equal(res.status, 404, show(res));
    assert.equal((await shiftsIn(WEEK)).length, 7, "the stranger's undo changed the schedule");
  });

  console.log("10. a shift added by hand while a template is being applied:");
  await check("is not recorded as the template's, and undoing the template leaves it", async () => {
    // Hold the apply part-way: once it has written its rows and shifts it
    // reads the template's days off, and that table stays locked until the
    // hand-added shift is in.
    const lock = await pool.connect();
    let hand: Answer = { status: 0, body: null };
    let applied: Answer = { status: 0, body: null };
    try {
      await lock.query("begin");
      await lock.query("lock table schedule_template_time_off in access exclusive mode");
      const applying = call("POST", `/api/schedule/templates/${TEMPLATE}/apply-safe`, cookie, { branchId: BRANCH, weekStartDate: RACE_WEEK });
      await waitFor(
        async () => Number((await q<{ n: string }>(
          `select count(*) as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query ilike '%schedule_template_time_off%'`,
        ))[0]!.n) > 0,
        "the apply never reached the template's days off",
      );
      assert.equal((await shiftsIn(RACE_WEEK)).length, 5, "the apply is held before it wrote its shifts");
      hand = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: RACE_WEEK, employeeId: CHAI });
      await lock.query("commit");
      applied = await applying;
    } finally {
      await lock.query("rollback").catch(() => undefined);
      lock.release();
    }
    assert.equal(hand.status, 201, show(hand));
    assert.equal(applied.status, 200, show(applied));
    assert.deepEqual([applied.body.rowsAdded, applied.body.assignmentsApplied, applied.body.timeOffApplied], [0, 5, 1], show(applied));
    const entry = (await historyOf("apply_template_additive")).at(-1)!;
    const recorded = (entry.change_set.created.assignments as { id: string }[]).map((r) => r.id);
    assert.equal(recorded.length, 5, `the template's change set holds ${recorded.length} shifts`);
    assert.ok(!recorded.includes(hand.body.id), "the hand-added shift was recorded as the template's");
    const undo = await call("POST", `/api/schedule/audit-log/${entry.id}/undo`, cookie);
    assert.equal(undo.status, 200, show(undo));
    assert.deepEqual([undo.body.undoneCreated, undo.body.restoredDeleted, undo.body.skippedCount], [6, 0, 0], show(undo));
    assert.deepEqual((await shiftsIn(RACE_WEEK)).map((s) => s.id), [hand.body.id], "the hand-added shift did not survive the undo");
  });

  console.log("11. undoing a clear puts back nothing the app's rules refuse now:");
  await check("a shift on a leave day now, a day off on a working day now, a day off inside a leave that starts earlier: all left out", async () => {
    const mon = LEAVE_WEEK;
    const tue = plus(LEAVE_WEEK, 1);
    const thu = plus(LEAVE_WEEK, 3);
    const shift = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: mon, employeeId: CHAI });
    assert.equal(shift.status, 201, show(shift));
    await timeOffRow(CHAI, "CHANGE_DAY_OFF", tue, tue);
    await timeOffRow(CHAI, "CHANGE_DAY_OFF", thu, thu);
    const clear = await call("POST", "/api/schedule/clear", cookie, {
      branchId: BRANCH, departmentId: HOUSEKEEPING, startDate: mon, endDate: plus(mon, 6),
    });
    assert.equal(clear.status, 200, show(clear));
    const entry = (await historyOf("clear_week")).at(-1)!;
    assert.deepEqual((entry.change_set.deleted.assignments as { id: string }[]).map((r) => r.id), [shift.body.id]);
    const daysOff = entry.change_set.deleted.timeOff as { id: string; startDate: string }[];
    assert.equal(daysOff.length, 2, "the clear removes the person's two days off that week");
    const tuesdayOff = daysOff.find((r) => r.startDate.startsWith(tue))!.id;
    const thursdayOff = daysOff.find((r) => r.startDate.startsWith(thu))!.id;

    // Since then: leave from the Sunday before to Monday, leave from
    // Wednesday to Friday, and a shift on Tuesday.
    await timeOffRow(CHAI, "ANNUAL_LEAVE", plus(mon, -1), mon);
    await timeOffRow(CHAI, "ANNUAL_LEAVE", plus(mon, 2), plus(mon, 4));
    const refused = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: mon, employeeId: CHAI });
    assert.equal(refused.status, 400, show(refused));
    assert.equal(refused.body.reasonCode, "ON_LEAVE", show(refused));
    const tuesday = await call("POST", "/api/schedule/assignments", cookie, { shiftRowId: HK_ROW, shiftDate: tue, employeeId: CHAI });
    assert.equal(tuesday.status, 201, show(tuesday));

    const undos = (await historyOf("undo_action")).length;
    const undo = await call("POST", `/api/schedule/audit-log/${entry.id}/undo`, cookie);
    assert.equal(undo.status, 200, show(undo));
    assert.deepEqual([undo.body.undoneCreated, undo.body.restoredDeleted, undo.body.nothingUndone], [0, 0, true], show(undo));
    const reasons = (undo.body.skipped as { kind: string; id: string; reason: string }[]).map((s) => `${s.kind}:${s.id}:${s.reason}`).sort();
    assert.deepEqual(reasons, [
      `assignments:${shift.body.id}:that person cannot take that shift now`,
      `timeOff:${thursdayOff}:that day already has time off`,
      `timeOff:${tuesdayOff}:that person has a shift that day now`,
    ].sort());
    assert.equal((await historyOf("undo_action")).length, undos, "an undo that put nothing back was logged");
    assert.deepEqual((await shiftsIn(LEAVE_WEEK)).map((s) => s.id), [tuesday.body.id]);
    const changeDaysOff = await q(
      "select id from employee_time_off where employee_id = $1 and type = 'CHANGE_DAY_OFF' and start_date::date between $2::date and $3::date",
      [CHAI, mon, plus(mon, 6)],
    );
    assert.equal(changeDaysOff.length, 0, "a day off was put back");
  });

  console.log(`schedule-undo-action.check: ${checks} checks passed`);
} catch (err) {
  console.error("schedule-undo-action.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
