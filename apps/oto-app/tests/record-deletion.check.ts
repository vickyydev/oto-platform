// seed: its own — two park groups' worth of ZZ TEST rows, made here (the
// slug-`default` park group only when the database has none). Not a
// Playwright file (the suite collects *.spec.ts and *.test.ts; this is
// neither): it boots the app's real routes and needs a database with the
// otoapp schema migrated.
//
// SCRUM-542 — the deletes and resets whose confirmation or answer did not
// match what the server did, over HTTP against the routes as registered:
//
//   1. Employee delete: an employee with contracts, time or payroll records
//      is refused in words naming them, and nothing changes; one with none
//      goes whole with their person and login; one still linked to something
//      the delete does not handle is refused and NOTHING was written — the
//      login deleted first is back (one transaction). The bulk door carries
//      each refusal's words. SCRUM-547: a login linked the way enable-login
//      links it goes with the employee; what the employee keeps is named
//      before the login gate, whose platform-linked refusal comes last.
//   2. Branch delete: a branch with employees is refused naming them; one
//      still used by something else is refused and its rota is still there
//      (one transaction); one with only a rota goes, rota and all.
//   3. Advisor (person) delete: an advisor with clock-ins is refused and the
//      login deleted first is back with its branch access (one transaction);
//      one with none goes with their login.
//   4. Event delete: an event with tasks is refused naming them, not a 500.
//   5. Schedule restore: a week's snapshot puts that week back and leaves the
//      other weeks' assignments on the same shift rows alone.
//   6. Duplicate-shift removal stays in the requested branch.
//   7. Locations: another park group's location is not listed, nor found by
//      PATCH or DELETE; a location used by a fix report is refused naming it.
//   8. A scheduled task's questions survive another park group's delete.
//   9. A manager cannot reset an administrator's password from the employee
//      door; a global administrator's account is refused as at the users door.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/record-deletion.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("record-deletion.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 6 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);
const exists = async (table: string, id: string) => (await count(`select count(*) as n from ${table} where id = $1`, [id])) === 1;

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const DAY_MS = 86_400_000;
/** A Bangkok calendar date `n` days from today. */
const day = (n: number) => new Date(Date.now() + 7 * 3_600_000 + n * DAY_MS).toISOString().slice(0, 10);
/** The Monday on or before a date, and the date `n` days after it. */
const monday = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// ─── Two park groups ─────────────────────────────────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");

interface ParkGroup {
  tenant: string;
  x: string;
  y: string;
  admin: { id: string; email: string };
  manager: { id: string; email: string };
}

async function user(tenant: string, role: string, email: string, branch: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    tenant,
    id,
    branch,
    branch ? "selected_branches" : "all_branches",
  ]);
  return id;
}

async function branch(tenant: string, label: string): Promise<string> {
  const id = randomUUID();
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    id,
    tenant,
    `ZZ TEST m1 ${label} ${run}`,
  ]);
  return id;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST m1 ${label} ${run}`, `zz-m1-${label}-${run}`]);
  const x = await branch(tenant, `${label} x`);
  const y = await branch(tenant, `${label} y`);
  const adminEmail = `zz-m1-${label}-admin-${run}@example.com`;
  const managerEmail = `zz-m1-${label}-manager-${run}@example.com`;
  return {
    tenant,
    x,
    y,
    admin: { id: await user(tenant, "admin", adminEmail, null), email: adminEmail },
    manager: { id: await user(tenant, "manager", managerEmail, x), email: managerEmail },
  };
}

const A = await parkGroup("a");
const B = await parkGroup("b");

async function employee(g: ParkGroup, branchId: string, label: string, fields: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const row: Record<string, unknown> = {
    id,
    tenant_id: g.tenant,
    branch_id: branchId,
    full_name: `ZZ TEST ${run} ${label}`,
    nickname: "ZZ",
    email: `zz-m1-${label}-${id.slice(0, 8)}@example.com`,
    status: "active",
    ...fields,
  };
  const cols = Object.keys(row);
  const vals = Object.values(row);
  await q(`insert into employees (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  return id;
}

/** A login, a person carrying its email (with an access policy in the park group), and nothing else. */
async function loginAndPerson(g: ParkGroup, label: string, personType = "employee") {
  const email = `zz-m1-${label}-${randomUUID().slice(0, 8)}@example.com`;
  const userId = await user(g.tenant, "staff", email, null);
  const person = randomUUID();
  await q("insert into people (id, full_name, email, person_type, tenant_id) values ($1, $2, $3, $4, $5)", [
    person,
    `ZZ TEST ${run} ${label}`,
    email,
    personType,
    g.tenant,
  ]);
  await q(
    "insert into access_policies (tenant_id, person_id, access_level, modules, branch_scope) values ($1, $2, 'staff', '[]'::jsonb, 'ALL')",
    [g.tenant, person],
  );
  return { email, userId, person };
}

async function document(employeeId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employee_documents (id, employee_id, document_type, file_name, file_path, mime_type)
     values ($1, $2, 'other', 'zz.pdf', 'zz/zz.pdf', 'application/pdf')`,
    [id, employeeId],
  );
  return id;
}

async function contract(g: ParkGroup, employeeId: string): Promise<string> {
  const template = randomUUID();
  await q("insert into templates (id, tenant_id, name, html_body) values ($1, $2, $3, '<p>ZZ</p>')", [template, g.tenant, `ZZ TEST m1 ${run} ${template.slice(0, 6)}`]);
  const id = randomUUID();
  await q(
    `insert into contract_instances (id, employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json, created_by, status)
     values ($1, $2, $3, '<p>ZZ</p>', 1, '{}'::jsonb, $4, 'active')`,
    [id, employeeId, template, g.admin.id],
  );
  return id;
}

async function task(g: ParkGroup, fields: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const cols = ["id", "tenant_id", "title", ...Object.keys(fields)];
  const vals = [id, g.tenant, `ZZ TEST m1 task ${run}`, ...Object.values(fields)];
  await q(`insert into tasks (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  return id;
}

/** A week plan, a shift group and a shift row (no active-date limits, so it spans every week). */
async function rota(g: ParkGroup, branchId: string, weekStart: string, start = "09:00", end = "17:00") {
  const plan = randomUUID();
  await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [plan, g.tenant, branchId, weekStart]);
  const group = randomUUID();
  await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [group, g.tenant, branchId, `ZZ TEST m1 ${run}`]);
  const row = randomUUID();
  await q(
    `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label)
     values ($1, $2, $3, $4, $5, $6, $7, 'ZZ TEST')`,
    [row, g.tenant, branchId, group, plan, start, end],
  );
  return { plan, group, row };
}

async function assignment(g: ParkGroup, plan: string, row: string, date: string, employeeId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, g.tenant, plan, row, date, employeeId],
  );
  return id;
}

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
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

try {
  ORIGIN = await serve();
  const cookie = { a: await signIn(A.admin.email), aManager: await signIn(A.manager.email), b: await signIn(B.admin.email) };

  // ── 1. Employee delete ──────────────────────────────────────────────────────
  console.log("1. employee delete:");
  await check("an employee with a contract is refused naming it, and nothing is archived or deleted", async () => {
    const { email, userId, person } = await loginAndPerson(A, "kept");
    const id = await employee(A, A.x, "kept", { email, person_id: person });
    const doc = await document(id);
    const kept = await contract(A, id);
    const res = await call("DELETE", `/api/employees/${id}`, cookie.a);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.reason, "has_records");
    assert.match(res.body.message, /cannot be deleted: they have 1 contract\. .*offboard them instead/);
    assert.deepEqual(res.body.blocking, [{ label: "contracts", count: 1 }]);
    assert.ok(await exists("employees", id));
    assert.ok(await exists("employee_documents", doc));
    assert.ok(await exists("people", person));
    assert.ok(await exists("users", userId), "the login deleted first inside the transaction is back");
    assert.equal(await count("select count(*) as n from user_branch_access where user_id = $1", [userId]), 1);
    assert.deepEqual(await q("select status from contract_instances where id = $1", [kept]), [{ status: "active" }]);
  });

  await check("the bulk door carries the same words for that employee", async () => {
    const id = await employee(A, A.x, "bulk-kept");
    await contract(A, id);
    const res = await call("POST", "/api/employees/bulk-delete", cookie.a, { employeeIds: [id] });
    assert.equal(res.status, 200, show(res));
    assert.equal(res.body.deletedCount, 0);
    assert.equal(res.body.results[0].status, "error");
    assert.equal(res.body.results[0].reason, "has_records");
    assert.match(res.body.results[0].message, /cannot be deleted: they have 1 contract/);
    assert.ok(await exists("employees", id));
  });

  await check("one transaction: an employee still linked to a task is refused, and the login, person, policy and documents are all still there", async () => {
    const { email, userId, person } = await loginAndPerson(A, "linked");
    const id = await employee(A, A.x, "linked", { email, person_id: person });
    const doc = await document(id);
    await task(A, { assigned_employee_id: id });
    const res = await call("DELETE", `/api/employees/${id}`, cookie.a);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.reason, "still_referenced");
    assert.match(res.body.message, /still linked to tasks, so nothing was deleted/);
    assert.ok(await exists("employees", id));
    assert.ok(await exists("employee_documents", doc));
    assert.ok(await exists("people", person));
    assert.equal(await count("select count(*) as n from access_policies where person_id = $1", [person]), 1);
    assert.ok(await exists("users", userId));
    assert.equal(await count("select count(*) as n from user_branch_access where user_id = $1", [userId]), 1);
  });

  await check("an employee with no history goes whole: documents, person, policy and login", async () => {
    const { email, userId, person } = await loginAndPerson(A, "gone");
    const id = await employee(A, A.x, "gone", { email, person_id: person });
    const doc = await document(id);
    const res = await call("DELETE", `/api/employees/${id}`, cookie.a);
    assert.equal(res.status, 204, show(res));
    for (const [table, row] of [["employees", id], ["employee_documents", doc], ["people", person], ["users", userId]] as const) {
      assert.ok(!(await exists(table, row)), `${table} ${row} is gone`);
    }
  });

  /** As enable-login leaves it (SCRUM-543): the employee and the person's policy both point at the login. */
  const linkedLogin = async (label: string) => {
    const { email, userId, person } = await loginAndPerson(A, label);
    const id = await employee(A, A.x, label, { email, person_id: person, user_id: userId });
    await q("update access_policies set core_user_id = $2 where person_id = $1", [person, userId]);
    return { id, userId, person };
  };

  await check("SCRUM-547: an employee with a LINKED login and no history goes whole, login and all", async () => {
    const { id, userId, person } = await linkedLogin("linked-gone");
    const res = await call("DELETE", `/api/employees/${id}`, cookie.a);
    assert.equal(res.status, 204, show(res));
    for (const [table, row] of [["employees", id], ["people", person], ["users", userId]] as const) {
      assert.ok(!(await exists(table, row)), `${table} ${row} is gone`);
    }
    assert.equal(await count("select count(*) as n from access_policies where person_id = $1", [person]), 0);
    assert.equal(await count("select count(*) as n from user_branch_access where user_id = $1", [userId]), 0);
  });

  await check("SCRUM-547: an employee with a linked login AND a contract is refused naming the contract, and every link is back", async () => {
    const { id, userId, person } = await linkedLogin("linked-kept");
    await contract(A, id);
    const res = await call("DELETE", `/api/employees/${id}`, cookie.a);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.reason, "has_records");
    assert.match(res.body.message, /cannot be deleted: they have 1 contract\. .*offboard them instead/);
    assert.deepEqual(res.body.blocking, [{ label: "contracts", count: 1 }]);
    assert.ok(await exists("users", userId));
    assert.deepEqual(await q("select user_id from employees where id = $1", [id]), [{ user_id: userId }]);
    assert.deepEqual(await q("select core_user_id from access_policies where person_id = $1", [person]), [{ core_user_id: userId }]);
  });

  await check("SCRUM-547: a platform-linked login is refused with the deactivate words only when nothing else blocks", async () => {
    const withContract = await linkedLogin("platform-kept");
    await q("update users set platform_user_id = $2 where id = $1", [withContract.userId, randomUUID()]);
    await contract(A, withContract.id);
    const named = await call("DELETE", `/api/employees/${withContract.id}`, cookie.a);
    assert.equal(named.status, 409, show(named));
    assert.equal(named.body.reason, "has_records", "the contract is named before the login");

    const clear = await linkedLogin("platform-only");
    await q("update users set platform_user_id = $2 where id = $1", [clear.userId, randomUUID()]);
    const res = await call("DELETE", `/api/employees/${clear.id}`, cookie.a);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.reason, "linked_to_platform");
    assert.equal(res.body.message, "Deactivate this account to preserve its HR record");
    assert.ok(await exists("employees", clear.id));
    assert.ok(await exists("users", clear.userId));
    assert.deepEqual(await q("select user_id from employees where id = $1", [clear.id]), [{ user_id: clear.userId }]);
    assert.deepEqual(await q("select core_user_id from access_policies where person_id = $1", [clear.person]), [{ core_user_id: clear.userId }]);
  });

  // ── 2. Branch delete ────────────────────────────────────────────────────────
  console.log("2. branch delete:");
  await check("a branch with an employee is refused naming it, and its rota is still there", async () => {
    const b = await branch(A.tenant, "with-staff");
    await employee(A, b, "at-branch");
    const r = await rota(A, b, monday(day(0)));
    const res = await call("DELETE", `/api/branches/${b}`, cookie.a);
    assert.equal(res.status, 409, show(res));
    assert.match(res.body.message, /cannot be deleted: it still has 1 employee\. Move or remove those first\./);
    assert.ok(await exists("branches", b));
    assert.ok(await exists("schedule_week_plans", r.plan));
  });

  await check("one transaction: a branch still used by a task is refused, and the rota its cascade would take is still there", async () => {
    const b = await branch(A.tenant, "with-task");
    const r = await rota(A, b, monday(day(0)));
    await task(A, { branch_id: b });
    const res = await call("DELETE", `/api/branches/${b}`, cookie.a);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.reason, "still_referenced");
    assert.match(res.body.message, /still used by tasks, so nothing was deleted/);
    assert.ok(await exists("branches", b));
    assert.ok(await exists("schedule_week_plans", r.plan));
    assert.ok(await exists("schedule_shift_rows", r.row));
  });

  await check("a branch with only a rota is deleted with it", async () => {
    const b = await branch(A.tenant, "rota-only");
    const r = await rota(A, b, monday(day(0)));
    const res = await call("DELETE", `/api/branches/${b}`, cookie.a);
    assert.equal(res.status, 204, show(res));
    assert.ok(!(await exists("branches", b)));
    assert.ok(!(await exists("schedule_week_plans", r.plan)));
  });

  // ── 3. Advisor delete ───────────────────────────────────────────────────────
  console.log("3. advisor delete:");
  await check("one transaction: an advisor with a clock-in is refused, and the login deleted first is back with its branch access", async () => {
    const { userId, person } = await loginAndPerson(A, "advisor-kept", "advisor");
    await q("insert into kiosk_auth_attempts (person_id, branch_id, method, outcome) values ($1, $2, 'PIN', 'SUCCESS')", [person, A.x]);
    const res = await call("DELETE", `/api/people/${person}`, cookie.a);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.reason, "has_records");
    assert.match(res.body.message, /cannot be deleted: they have 1 clock-in record, which are kept for the record\. Deactivate their login on the Users page instead\./);
    assert.ok(await exists("people", person));
    assert.equal(await count("select count(*) as n from access_policies where person_id = $1", [person]), 1);
    assert.ok(await exists("users", userId));
    assert.equal(await count("select count(*) as n from user_branch_access where user_id = $1", [userId]), 1);
  });

  await check("an advisor with nothing recorded goes with their login", async () => {
    const { userId, person } = await loginAndPerson(A, "advisor-gone", "advisor");
    const res = await call("DELETE", `/api/people/${person}`, cookie.a);
    assert.equal(res.status, 200, show(res));
    assert.ok(!(await exists("people", person)));
    assert.ok(!(await exists("users", userId)));
  });

  // ── 4. Event delete ─────────────────────────────────────────────────────────
  console.log("4. event delete:");
  await check("an event with a task is refused naming it, not a 500; one without is deleted", async () => {
    const event = randomUUID();
    await q("insert into core_events (id, tenant_id, branch_id, title, event_date, start_time) values ($1, $2, $3, 'ZZ TEST m1 event', $4, '10:00')", [event, A.tenant, A.x, day(3)]);
    await q("update tasks set title = $2 where id = $1", [await task(A, { event_id: event }), `ZZ m1 setup ${run}`]);
    const refused = await call("DELETE", `/api/admin/events/${event}`, cookie.a);
    assert.equal(refused.status, 409, show(refused));
    assert.equal(refused.body.reason, "event_has_tasks");
    assert.ok(refused.body.message.includes(`1 task linked to it ("ZZ m1 setup ${run}")`), refused.body.message);
    assert.ok(await exists("core_events", event));
    await q("delete from tasks where event_id = $1", [event]);
    const deleted = await call("DELETE", `/api/admin/events/${event}`, cookie.a);
    assert.equal(deleted.status, 204, show(deleted));
    assert.ok(!(await exists("core_events", event)));
  });

  // ── 5. Schedule restore ─────────────────────────────────────────────────────
  console.log("5. schedule restore:");
  await check("a week's snapshot restores that week and leaves the next week's assignments on the same row alone", async () => {
    const week = monday(day(14));
    const person = await employee(A, A.y, "rota");
    const r = await rota(A, A.y, week);
    const snapshotAssignment = await assignment(A, r.plan, r.row, plus(week, 1), person);
    const nextWeekPlan = randomUUID();
    await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [nextWeekPlan, A.tenant, A.y, plus(week, 7)]);
    const nextWeek = await assignment(A, nextWeekPlan, r.row, plus(week, 8), person);
    const snapshot = {
      weekPlan: { id: r.plan, tenantId: A.tenant, branchId: A.y, weekStartDate: week },
      shiftRows: [{ id: r.row, tenantId: A.tenant, branchId: A.y, shiftGroupId: r.group, weekPlanId: r.plan, startTime: "09:00", endTime: "17:00", label: "ZZ TEST" }],
      assignments: [{ id: snapshotAssignment, tenantId: A.tenant, weekPlanId: r.plan, shiftRowId: r.row, shiftDate: plus(week, 1), employeeId: person }],
      rowRoles: [],
      breaks: [],
    };
    // What the template apply added after the snapshot was taken.
    const added = await assignment(A, r.plan, r.row, plus(week, 2), person);
    const entry = randomUUID();
    await q(
      "insert into schedule_audit_log (id, tenant_id, week_plan_id, branch_id, week_start_date, action, snapshot_data) values ($1, $2, $3, $4, $5, 'apply_template_additive', $6)",
      [entry, A.tenant, r.plan, A.y, week, JSON.stringify(snapshot)],
    );
    const res = await call("POST", `/api/schedule/audit-log/${entry}/restore`, cookie.a);
    assert.equal(res.status, 200, show(res));
    assert.ok(await exists("schedule_assignments", snapshotAssignment), "the snapshot's assignment is back");
    assert.ok(!(await exists("schedule_assignments", added)), "what came after the snapshot in that week is gone");
    assert.ok(await exists("schedule_assignments", nextWeek), "the next week's assignment on the same row survives");
    assert.ok(await exists("schedule_shift_rows", r.row));
  });

  await check("a department's week clear takes the duty blocks with its assignments, and restoring it from history puts them back (SCRUM-544)", async () => {
    const week = monday(day(35));
    const person = await employee(A, A.y, "duty");
    const r = await rota(A, A.y, week);
    const dept = randomUUID();
    await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [dept, A.tenant, `ZZ TEST m3 ${run}`]);
    await q("update schedule_shift_rows set department_id = $1 where id = $2", [dept, r.row]);
    const shift = await assignment(A, r.plan, r.row, plus(week, 2), person);
    const dutyType = randomUUID();
    await q("insert into duty_types (id, tenant_id, name) values ($1, $2, 'ZZ TEST m3 duty')", [dutyType, A.tenant]);
    await q(
      `insert into duty_blocks (tenant_id, branch_id, date, employee_id, assignment_id, duty_type_id, duty_name, start_time, end_time)
       values ($1, $2, $3, $4, $5, $6, 'ZZ TEST m3 duty', '10:00', '11:00')`,
      [A.tenant, A.y, plus(week, 2), person, shift, dutyType],
    );
    const cleared = await call("POST", "/api/schedule/clear", cookie.a, { branchId: A.y, departmentId: dept, startDate: week, endDate: plus(week, 6) });
    assert.equal(cleared.status, 200, show(cleared));
    assert.equal((await q("select id from duty_blocks where employee_id = $1", [person])).length, 0, "the clear takes the duty block");
    const [entry] = await q("select id from schedule_audit_log where action = 'clear_week' and department_id = $1", [dept]);
    const restored = await call("POST", `/api/schedule/audit-log/${entry!.id}/restore`, cookie.a);
    assert.equal(restored.status, 200, show(restored));
    assert.equal((restored.body as { shiftRows: number }).shiftRows, 0, "a department restore reports no shift rows, as it touches none");
    const back = await q(
      `select d.start_time, d.duty_type_id from duty_blocks d join schedule_assignments s on s.id = d.assignment_id
        where d.employee_id = $1 and s.shift_row_id = $2 and s.shift_date = $3`,
      [person, r.row, plus(week, 2)],
    );
    assert.deepEqual(back, [{ start_time: "10:00", duty_type_id: dutyType }], "the duty block is back on the restored assignment");
  });

  // ── 6. Duplicate-shift removal ──────────────────────────────────────────────
  console.log("6. duplicate-shift removal:");
  await check("removing duplicates in branch X keeps one there and never touches the same person's shift in branch Y", async () => {
    const date = day(21);
    const week = monday(date);
    const person = await employee(A, A.x, "dup");
    const x1 = await rota(A, A.x, week, "09:00", "12:00");
    const x2 = await rota(A, A.x, week, "13:00", "15:00");
    const yLong = await rota(A, A.y, week, "08:00", "20:00");
    const a1 = await assignment(A, x1.plan, x1.row, date, person);
    const a2 = await assignment(A, x2.plan, x2.row, date, person);
    const ay = await assignment(A, yLong.plan, yLong.row, date, person);
    const res = await call("POST", "/api/schedule/conflicts/auto-fix", cookie.a, { branchId: A.x });
    assert.equal(res.status, 200, show(res));
    assert.ok(await exists("schedule_assignments", ay), "branch Y's shift is untouched");
    assert.ok(await exists("schedule_assignments", a1), "the longest shift in branch X is kept");
    assert.ok(!(await exists("schedule_assignments", a2)), "the other is removed");
  });

  // ── 7. Locations ────────────────────────────────────────────────────────────
  console.log("7. locations:");
  await check("another park group's location is not listed, nor found by PATCH or DELETE, and is unchanged", async () => {
    const loc = randomUUID();
    await q("insert into locations (id, tenant_id, name) values ($1, $2, 'ZZ TEST m1 loc')", [loc, A.tenant]);
    const listed = async (c: string) => ((await call("GET", "/api/locations", c)).body as { id: string }[]).some((l) => l.id === loc);
    assert.equal(await listed(cookie.a), true);
    assert.equal(await listed(cookie.b), false);
    const patched = await call("PATCH", `/api/locations/${loc}`, cookie.b, { name: "ZZ changed" });
    assert.equal(patched.status, 404, show(patched));
    const deleted = await call("DELETE", `/api/locations/${loc}`, cookie.b);
    assert.equal(deleted.status, 404, show(deleted));
    assert.deepEqual(await q("select name from locations where id = $1", [loc]), [{ name: "ZZ TEST m1 loc" }]);
  });

  await check("a location used by a fix report is refused naming it", async () => {
    const loc = randomUUID();
    await q("insert into locations (id, tenant_id, name) values ($1, $2, 'ZZ TEST m1 used')", [loc, A.tenant]);
    await q("insert into fix_reports (tenant_id, branch_id, reported_by, title, location, location_id) values ($1, $2, $3, 'ZZ', 'ZZ', $4)", [A.tenant, A.x, A.admin.id, loc]);
    const res = await call("DELETE", `/api/locations/${loc}`, cookie.a);
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.message, "ZZ TEST m1 used cannot be deleted: it is still used by 1 fix report, which keep the location they were recorded with.");
    assert.ok(await exists("locations", loc));
  });

  // ── 8. Scheduled task questions ─────────────────────────────────────────────
  console.log("8. scheduled task questions:");
  await check("another park group's delete leaves the task and its questions", async () => {
    const id = await task(A, { is_recurring_definition: true });
    await q("insert into task_questions (tenant_id, task_id, prompt) values ($1, $2, 'ZZ?')", [A.tenant, id]);
    const res = await call("DELETE", `/api/studio/scheduled-tasks/${id}`, cookie.b);
    assert.equal(res.status, 404, show(res));
    assert.ok(await exists("tasks", id));
    assert.equal(await count("select count(*) as n from task_questions where task_id = $1", [id]), 1);
  });

  // ── 9. Employee password reset ──────────────────────────────────────────────
  console.log("9. employee password reset:");
  await check("a manager cannot reset an administrator's password, nor a global administrator's", async () => {
    for (const role of ["admin", "global_admin"]) {
      const email = `zz-m1-target-${role}-${run}@example.com`;
      const target = await user(A.tenant, role, email, null);
      const id = await employee(A, A.x, `target-${role}`, { user_id: target });
      const before = await q<{ password: string }>("select password from users where id = $1", [target]);
      const res = await call("POST", `/api/employees/${id}/reset-password`, cookie.aManager);
      assert.equal(res.status, 403, `${role}: ${show(res)}`);
      assert.equal(
        res.body.message,
        role === "admin" ? "Only an administrator can reset an administrator's password" : "This account is managed outside User Management",
      );
      assert.deepEqual(await q("select password from users where id = $1", [target]), before);
    }
  });

  console.log(`record-deletion.check: ${checks} checks passed`);
} catch (err) {
  console.error("record-deletion.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
