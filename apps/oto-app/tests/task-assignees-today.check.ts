// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-597 — a task the Ops board assigns to several employees shows in the
// Today page of every one of them, over HTTP against the routes as registered:
//
//   1. A manager creates a task on the Ops board's route (POST /api/core/tasks)
//      for three employees; each of the three reads it in Today
//      (GET /api/tasks/today), a fourth in the same branch does not.
//   2. A task for one employee is unchanged: that employee reads it, the
//      others do not.
//   3. The board's read (GET /api/core/tasks) still names all three assignees.
//   4. An assignee added or removed on the board's task sheet (PATCH with
//      `assignments`) gains or loses the task in Today.
//   5. The date rule the report's screenshots show, pinned as the prototype
//      has it: moving a non-scheduled task's due date to a later day moves its
//      start too, and Today lists only started tasks, so the task leaves every
//      assignee's Today until that day and returns when it is due today.
//
// SCRUM-598 — Today resolves the signed-in person the way My Account does
// (by login, then email, then phone), within their own park group:
//
//   6. An employee record with no login attached but the login's email reads
//      the task assigned to it in Today; a record matched by phone alone
//      likewise.
//   7. A record of another park group with the login's email is not taken for
//      that login, nor is a same-group record that belongs to another login.
//   8. A login with no employee record still reads its user-assigned task.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/task-assignees-today.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("task-assignees-today.check: DATABASE_URL is not set");
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
/** Today's Bangkok calendar date. */
const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

// ─── One park group, one branch, a manager and four staff ────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ta ${run}`, `zz-ta-${run}`]);
const branch = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
  branch,
  tenant,
  `ZZ TEST ta ${run}`,
]);

async function user(role: string, label: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `zz-ta-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
    tenant,
    id,
    branch,
  ]);
  return { id, email };
}

interface Staff {
  label: string;
  userId: string;
  email: string;
  employeeId: string;
}
async function staff(label: string): Promise<Staff> {
  const u = await user("staff", label);
  const employeeId = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'active')`,
    [employeeId, tenant, branch, u.id, `ZZ TEST ${label} ${run}`, label, u.email],
  );
  return { label, userId: u.id, email: u.email, employeeId };
}

// SCRUM-598: logins whose employee record carries no login link.
async function unlinkedEmployee(tenantId: string, branchId: string, label: string, email: string, phone: string | null) {
  const employeeId = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, phone, status)
     values ($1, $2, $3, null, $4, $5, $6, $7, 'active')`,
    [employeeId, tenantId, branchId, `ZZ TEST ${label} ${run}`, label, email, phone],
  );
  return employeeId;
}
/** Email match only: the record's email differs from the login's only in case. */
const byEmail = await user("staff", "ByEmail");
const byEmailEmployee = await unlinkedEmployee(tenant, branch, "ByEmail", byEmail.email.toUpperCase(), null);
/** Phone match only: a different email, the login's E.164 phone written the local way. */
const byPhone = await user("staff", "ByPhone");
const phoneDigits = String(Date.now()).slice(-8);
await q("update users set phone_e164 = $2, phone_number = $3 where id = $1", [byPhone.id, `+669${phoneDigits}`, `09${phoneDigits}`]);
const byPhoneEmployee = await unlinkedEmployee(tenant, branch, "ByPhone", `zz-ta-byphone-other-${run}@example.com`, `09-${phoneDigits}`);
/** No employee record here; one in another park group, and one linked to another login, carry its email. */
const lone = await user("staff", "Lone");
const otherTenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [otherTenant, `ZZ TEST ta2 ${run}`, `zz-ta2-${run}`]);
const otherBranch = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
  otherBranch,
  otherTenant,
  `ZZ TEST ta2 ${run}`,
]);
const foreignEmployee = await unlinkedEmployee(otherTenant, otherBranch, "Foreign", lone.email, null);

const manager = await user("manager", "manager");
const anan = await staff("Anan");
const lek = await staff("Lek");
const som = await staff("Som");
const other = await staff("Other");

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
async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body };
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
  const cookie = {
    manager: await signIn(manager.email),
    Anan: await signIn(anan.email),
    Lek: await signIn(lek.email),
    Som: await signIn(som.email),
    Other: await signIn(other.email),
    ByEmail: await signIn(byEmail.email),
    ByPhone: await signIn(byPhone.email),
    Lone: await signIn(lone.email),
  };

  /** What the Ops board's create dialog sends (client/src/components/create-task-dialog.tsx). */
  const create = async (title: string, people: Staff[]) => {
    const res = await call("POST", "/api/core/tasks", {
      cookie: cookie.manager,
      body: {
        branchIds: [branch],
        title,
        description: null,
        priority: "medium",
        recurrence: "once",
        weeklyDays: [],
        monthlyDay: null,
        preferredDueTime: "18:00",
        scheduledMode: false,
        startAt: null,
        dueAt: `${today}T18:00:00+07:00`,
        assignments: people.map((p) => ({ assignmentType: "employee", assignmentId: p.employeeId })),
        requiresPhotoEvidence: false,
        requiresResponses: false,
      },
    });
    assert.equal(res.status, 201, show(res));
    return (res.body as { id: string }).id;
  };
  const todayFor = async (who: keyof typeof cookie) => {
    const res = await call("GET", `/api/tasks/today?branchId=${branch}`, { cookie: cookie[who] });
    assert.equal(res.status, 200, `${who}: ${show(res)}`);
    return (res.body as Array<{ id: string }>).map((t) => t.id);
  };

  const multi = await create(`ZZ TEST multi ${run}`, [anan, lek, som]);
  const single = await create(`ZZ TEST single ${run}`, [anan]);

  await check("a task for Anan, Lek and Som is in each one's Today", async () => {
    for (const who of ["Anan", "Lek", "Som"] as const) {
      assert.ok((await todayFor(who)).includes(multi), `${who}'s Today has no multi-assigned task`);
    }
  });

  await check("and not in the Today of a fourth employee of the same branch", async () => {
    assert.ok(!(await todayFor("Other")).includes(multi), "Other's Today shows a task not assigned to them");
  });

  await check("a task for Anan alone is in Anan's Today and nobody else's", async () => {
    assert.ok((await todayFor("Anan")).includes(single), "Anan's Today has no single-assigned task");
    for (const who of ["Lek", "Som", "Other"] as const) {
      assert.ok(!(await todayFor(who)).includes(single), `${who}'s Today shows Anan's task`);
    }
  });

  await check("the board still names all three assignees", async () => {
    const res = await call("GET", `/api/core/tasks?branchId=${branch}`, { cookie: cookie.manager });
    assert.equal(res.status, 200, show(res));
    const task = (res.body as Array<{ id: string; assignments: Array<{ label: string }> }>).find((t) => t.id === multi);
    assert.ok(task, "the board does not list the multi-assigned task");
    assert.deepEqual(task.assignments.map((a) => a.label).sort(), ["Anan", "Lek", "Som"]);
  });

  /** What the board's task sheet sends (client/src/components/ops/TaskDetailSheet.tsx). */
  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await call("PATCH", `/api/core/tasks/${id}`, { cookie: cookie.manager, body });
    assert.equal(res.status, 200, show(res));
  };

  await check("an assignee added on the board's task sheet reads the task in Today too", async () => {
    await patch(multi, {
      assignments: [anan, lek, som, other].map((p) => ({ assignmentType: "employee", assignmentId: p.employeeId })),
    });
    for (const who of ["Anan", "Lek", "Som", "Other"] as const) {
      assert.ok((await todayFor(who)).includes(multi), `${who}'s Today has no task after the sheet added them`);
    }
    await patch(multi, {
      assignments: [anan, lek, som].map((p) => ({ assignmentType: "employee", assignmentId: p.employeeId })),
    });
    assert.ok(!(await todayFor("Other")).includes(multi), "Other still reads the task after the sheet removed them");
  });

  // The rule the report's screenshots show (the prototype's own, unchanged):
  // moving a non-scheduled task's due date also moves its start, and Today
  // lists only tasks that have started — for one assignee or several alike.
  const later = new Date(Date.parse(`${today}T00:00:00Z`) + 11 * 86_400_000).toISOString().slice(0, 10);
  await check("a task whose due date moves to a later day leaves every assignee's Today until that day", async () => {
    await patch(multi, { dueAt: `${later}T18:00:00+07:00` });
    await patch(single, { dueAt: `${later}T18:00:00+07:00` });
    for (const who of ["Anan", "Lek", "Som"] as const) {
      assert.ok(!(await todayFor(who)).includes(multi), `${who}'s Today shows a task that starts on ${later}`);
    }
    assert.ok(!(await todayFor("Anan")).includes(single), `Anan's Today shows a single task that starts on ${later}`);
  });

  await check("and is back in each one's Today once it is due today again", async () => {
    await patch(multi, { dueAt: `${today}T18:00:00+07:00` });
    for (const who of ["Anan", "Lek", "Som"] as const) {
      assert.ok((await todayFor(who)).includes(multi), `${who}'s Today has no task due today`);
    }
    assert.ok(!(await todayFor("Other")).includes(multi), "Other's Today shows a task not assigned to them");
  });

  // ─── SCRUM-598: Today resolves the person the way My Account does ─────────

  /** A task for one employee id, made on the board for Anan and then re-pointed in the database. */
  const taskFor = async (title: string, employeeId: string) => {
    const id = await create(title, [anan]);
    await q("update task_assignments set assignment_id = $2 where task_id = $1 and assignment_type = 'employee'", [id, employeeId]);
    await q("update tasks set assigned_employee_id = $2 where id = $1 and assigned_employee_id is not null", [id, employeeId]);
    return id;
  };

  const emailTask = await taskFor(`ZZ TEST by email ${run}`, byEmailEmployee);
  const phoneTask = await taskFor(`ZZ TEST by phone ${run}`, byPhoneEmployee);
  const foreignTask = await taskFor(`ZZ TEST foreign ${run}`, foreignEmployee);

  await check("an employee record with no login but the login's email reads its task in Today", async () => {
    assert.ok((await todayFor("ByEmail")).includes(emailTask), "ByEmail's Today has no task assigned to their employee record");
    assert.ok(!(await todayFor("ByPhone")).includes(emailTask), "ByPhone's Today shows ByEmail's task");
  });

  await check("an employee record matched by phone alone reads its task in Today", async () => {
    assert.ok((await todayFor("ByPhone")).includes(phoneTask), "ByPhone's Today has no task assigned to their employee record");
    assert.ok(!(await todayFor("ByEmail")).includes(phoneTask), "ByEmail's Today shows ByPhone's task");
  });

  await check("a record of another park group with the login's email is not taken for that login", async () => {
    assert.ok(!(await todayFor("Lone")).includes(foreignTask), "Lone's Today shows a task for another park group's record");
  });

  await check("a same-group record linked to another login is not taken by email for this one", async () => {
    // A record with Lone's email whose login is the manager's: it is the
    // manager's record, and the email step considers records with no login only.
    const managerEmployee = randomUUID();
    await q(
      `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status)
       values ($1, $2, $3, $4, $5, 'ManagerRecord', $6, 'active')`,
      [managerEmployee, tenant, branch, manager.id, `ZZ TEST ManagerRecord ${run}`, lone.email],
    );
    const id = await taskFor(`ZZ TEST linked elsewhere ${run}`, managerEmployee);
    assert.ok(!(await todayFor("Lone")).includes(id), "Lone's Today shows a task for the manager's record");
  });

  await check("a login with no employee record still reads its user-assigned task", async () => {
    const id = await create(`ZZ TEST for a login ${run}`, [anan]);
    await q("delete from task_assignments where task_id = $1", [id]);
    await q("update tasks set assigned_employee_id = null, assigned_to = $2 where id = $1", [id, lone.id]);
    assert.ok((await todayFor("Lone")).includes(id), "Lone's Today has no task assigned to their login");
    assert.ok(!(await todayFor("Anan")).includes(id), "Anan's Today shows Lone's task");
  });

  console.log(`task-assignees-today.check: ${checks} checks passed`);
} catch (err) {
  console.error("task-assignees-today.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
