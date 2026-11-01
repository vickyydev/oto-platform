// seed: its own — ZZ TEST rows in the slug-`default` park group (made only
// when the database has none) and in one other park group, made here. Not a
// Playwright file (the suite collects *.spec.ts and *.test.ts; this is
// neither): it boots the app's real routes and needs a database with the
// otoapp schema migrated.
//
// SCRUM-546 — two of the three follow-ups found while fixing the behaviour
// batch, over HTTP against the routes as registered (the third, the payroll
// page, is check 6 of tests/payroll-cutover.check.ts):
//
//   1. Event statuses. The list and create act on one park group's statuses
//      (the app's rule, getDefaultTenantId). Edit, reorder and delete now act
//      on that park group's statuses and on no other: another park group's
//      status answers "Status not found" (404) and is left exactly as it was,
//      whoever asks; a reorder naming one changes nothing, not even the
//      statuses it named first; and create, as before, writes into that park
//      group whatever park group a request names. The statuses of that park
//      group still edit, reorder and delete as they did.
//   2. The shift-row merge is one transaction. A database failure part-way —
//      the second source row refusing its delete, after the first source row
//      has been merged — leaves the rota exactly as it was: every assignment,
//      role, break and source row. The same merge with nothing in the way
//      still moves, skips and deletes what it did, and a role two source rows
//      share reaches the target row once.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/s546-follow-ups.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("s546-follow-ups.check: DATABASE_URL is not set");
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
const day = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);

// ─── Two park groups: the default one, whose statuses the screen shows, and another ──

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const DEFAULT = (await q<{ id: string }>("select id from tenants where slug = 'default'"))[0]!.id;
const OTHER = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [OTHER, `ZZ TEST s546 other ${run}`, `zz-s546-${run}`]);

async function admin(tenant: string, label: string): Promise<string> {
  const id = randomUUID();
  const email = `zz-s546-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, 'admin', true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST s546 ${label} ${run}`],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  return email;
}

async function branch(tenant: string, label: string): Promise<string> {
  const id = randomUUID();
  await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [id, tenant, `ZZ TEST s546 ${label} ${run}`]);
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

/** One status row as stored, everything a write could change. */
const statusRow = async (id: string) =>
  (await q("select id, tenant_id, name, value, color, sort_order, is_default from event_statuses where id = $1", [id]))[0];

async function foreignStatus(label: string, sortOrder: number): Promise<string> {
  const id = randomUUID();
  await q(
    "insert into event_statuses (id, tenant_id, name, value, color, sort_order, is_default) values ($1, $2, $3, $4, 'blue', $5, false)",
    [id, OTHER, `ZZ TEST s546 ${label} ${run}`, `zz_s546_${label}_${run}`, sortOrder],
  );
  return id;
}

/** Everything a merge of these rows could touch, read whole. */
async function rotaState(rowIds: string[]) {
  return JSON.stringify({
    rows: await q("select * from schedule_shift_rows where id = any($1) order by id", [rowIds]),
    assignments: await q("select * from schedule_assignments where shift_row_id = any($1) order by id", [rowIds]),
    roles: await q("select * from schedule_shift_row_roles where shift_row_id = any($1) order by id", [rowIds]),
    breaks: await q("select * from schedule_shift_breaks where shift_row_id = any($1) order by id", [rowIds]),
  });
}

/** A target row and two source rows in one week, as the merge dialog offers them. */
async function mergeRota() {
  const branchId = await branch(DEFAULT, "rota");
  const plan = randomUUID();
  await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [plan, DEFAULT, branchId, day]);
  const group = randomUUID();
  await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [group, DEFAULT, branchId, `ZZ TEST s546 ${run}`]);
  const row = async (label: string) => {
    const id = randomUUID();
    await q(
      `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label)
       values ($1, $2, $3, $4, $5, '09:00', '17:00', $6)`,
      [id, DEFAULT, branchId, group, plan, `ZZ TEST s546 ${label}`],
    );
    return id;
  };
  const target = await row("target"), first = await row("first source"), second = await row("second source");
  const person = async (label: string) => {
    const id = randomUUID();
    await q(
      "insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status) values ($1, $2, $3, $4, 'ZZ', $5, 'active')",
      [id, DEFAULT, branchId, `ZZ TEST s546 ${label} ${run}`, `zz-s546-${id.slice(0, 8)}@example.com`],
    );
    return id;
  };
  const kept = await person("kept"), mover = await person("mover"), secondMover = await person("second mover");
  const assign = async (shiftRow: string, employee: string) => {
    const id = randomUUID();
    await q(
      "insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id) values ($1, $2, $3, $4, $5, $6)",
      [id, DEFAULT, plan, shiftRow, day, employee],
    );
    return id;
  };
  await assign(target, kept);
  const clash = await assign(first, kept); // the same person and day as the target's own: keep_target drops it
  await assign(first, mover);
  const moving = await assign(second, secondMover);
  const role = randomUUID();
  await q("insert into roles (id, tenant_id, name) values ($1, $2, $3)", [role, DEFAULT, `ZZ TEST s546 role ${run}`]);
  for (const shiftRow of [first, second]) {
    await q("insert into schedule_shift_row_roles (tenant_id, shift_row_id, role_id) values ($1, $2, $3)", [DEFAULT, shiftRow, role]);
  }
  await q(
    `insert into schedule_shift_breaks (tenant_id, branch_id, shift_row_id, shift_date, employee_id, assignment_id, break_start_time, break_end_time)
     values ($1, $2, $3, $4, $5, $6, '12:00', '13:00')`,
    [DEFAULT, branchId, second, day, secondMover, moving],
  );
  return { target, first, second, kept, mover, secondMover, clash, role, rows: [target, first, second] };
}

const INJECT = `zz_s546_merge_failure_${run}`;

try {
  ORIGIN = await serve();
  const cookie = { own: await signIn(await admin(DEFAULT, "own")), other: await signIn(await admin(OTHER, "other")) };

  // ── 1. Event statuses ───────────────────────────────────────────────────────
  console.log("1. event statuses:");
  const list = await call("GET", "/api/admin/event-statuses", cookie.own);
  assert.equal(list.status, 200, show(list));
  const created = await call("POST", "/api/admin/event-statuses", cookie.own, { name: `ZZ TEST s546 own ${run}`, color: "green" });
  assert.equal(created.status, 201, show(created));
  const own = created.body.id as string;
  const foreign = await foreignStatus("foreign", 0);
  const foreignSecond = await foreignStatus("foreign second", 1);

  await check("an edit of another park group's status is not found, from either park group, and changes nothing", async () => {
    const before = await statusRow(foreign);
    for (const who of [cookie.own, cookie.other]) {
      const res = await call("PATCH", `/api/admin/event-statuses/${foreign}`, who, { name: "ZZ TEST renamed", color: "red", sortOrder: 9 });
      assert.deepEqual([res.status, res.body], [404, { message: "Status not found" }], show(res));
    }
    assert.deepEqual(await statusRow(foreign), before);
  });

  await check("a reorder naming another park group's status changes nothing, not even the statuses it named first", async () => {
    const before = { own: await statusRow(own), foreign: await statusRow(foreign), second: await statusRow(foreignSecond) };
    for (const orderedIds of [[own, foreign], [foreignSecond, foreign]]) {
      for (const who of [cookie.own, cookie.other]) {
        const res = await call("POST", "/api/admin/event-statuses/reorder", who, { orderedIds });
        assert.deepEqual([res.status, res.body], [404, { message: "Status not found" }], show(res));
      }
    }
    assert.deepEqual({ own: await statusRow(own), foreign: await statusRow(foreign), second: await statusRow(foreignSecond) }, before);
  });

  await check("a delete of another park group's status is not found and the status stays", async () => {
    const before = await statusRow(foreign);
    for (const who of [cookie.own, cookie.other]) {
      const res = await call("DELETE", `/api/admin/event-statuses/${foreign}`, who);
      assert.deepEqual([res.status, res.body], [404, { message: "Status not found" }], show(res));
    }
    assert.deepEqual(await statusRow(foreign), before);
  });

  await check("create still writes into the screen's park group whatever park group a request names", async () => {
    const res = await call("POST", "/api/admin/event-statuses", cookie.other, { name: `ZZ TEST s546 named ${run}`, tenantId: OTHER });
    assert.equal(res.status, 201, show(res));
    assert.equal((await statusRow(res.body.id))?.tenant_id, DEFAULT);
    assert.equal((await call("DELETE", `/api/admin/event-statuses/${res.body.id}`, cookie.own)).status, 204);
  });

  await check("the screen's own statuses still edit, reorder and delete", async () => {
    const edited = await call("PATCH", `/api/admin/event-statuses/${own}`, cookie.own, { name: `ZZ TEST s546 edited ${run}`, color: "purple" });
    assert.equal(edited.status, 200, show(edited));
    assert.deepEqual([edited.body.name, edited.body.color], [`ZZ TEST s546 edited ${run}`, "purple"]);
    const ids = (await q<{ id: string }>("select id from event_statuses where tenant_id = $1 order by sort_order, id", [DEFAULT])).map((r) => r.id);
    const reversed = [...ids].reverse();
    const reordered = await call("POST", "/api/admin/event-statuses/reorder", cookie.own, { orderedIds: reversed });
    assert.deepEqual([reordered.status, reordered.body], [200, { success: true }], show(reordered));
    for (const [i, id] of reversed.entries()) assert.equal((await statusRow(id))?.sort_order, i, id);
    assert.equal((await call("DELETE", `/api/admin/event-statuses/${own}`, cookie.own)).status, 204);
    assert.equal(await statusRow(own), undefined);
    assert.ok(await statusRow(foreign), "another park group's statuses are still there");
  });

  // ── 2. The shift-row merge ──────────────────────────────────────────────────
  console.log("2. the shift-row merge:");
  await check("a failure part-way through a merge leaves the rota exactly as it was", async () => {
    const r = await mergeRota();
    await q(`create function ${INJECT}() returns trigger language plpgsql as $$
             begin raise exception 'ZZ TEST merge interrupted'; end $$`);
    await q(`create trigger ${INJECT} before delete on schedule_shift_rows for each row when (old.id = '${r.second}') execute function ${INJECT}()`);
    try {
      const before = await rotaState(r.rows);
      const res = await call("POST", "/api/schedule/shift-rows/merge/execute", cookie.own, { targetRowId: r.target, sourceRowIds: [r.first, r.second] });
      assert.equal(res.status, 500, show(res));
      assert.equal(await rotaState(r.rows), before, "nothing of the first source row's merge is left behind");
    } finally {
      await q(`drop trigger if exists ${INJECT} on schedule_shift_rows`);
      await q(`drop function if exists ${INJECT}()`);
    }

    // Nothing in the way: the same merge does what it always did.
    const res = await call("POST", "/api/schedule/shift-rows/merge/execute", cookie.own, { targetRowId: r.target, sourceRowIds: [r.first, r.second] });
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body, { success: true, moved: 2, skipped: 1, replaced: 0, sourceRowsDeleted: 2 });
    assert.deepEqual((await q("select id from schedule_shift_rows where id = any($1)", [[r.first, r.second]])), [], "both source rows are gone");
    const onTarget = (await q<{ employee_id: string }>("select employee_id from schedule_assignments where shift_row_id = $1", [r.target]))
      .map((a) => a.employee_id).sort();
    assert.deepEqual(onTarget, [r.kept, r.mover, r.secondMover].sort());
    assert.deepEqual(await q("select id from schedule_assignments where id = $1", [r.clash]), [], "the clashing source assignment was dropped");
    assert.deepEqual((await q("select role_id from schedule_shift_row_roles where shift_row_id = $1", [r.target])).map((x) => x.role_id), [r.role],
      "a role both source rows carry reaches the target once");
    assert.equal((await q("select count(*)::int as n from schedule_shift_breaks where shift_row_id = $1", [r.target]))[0]!.n, 1, "the break moved");
  });

  console.log(`s546-follow-ups.check: ${checks} checks passed`);
} catch (err) {
  console.error("s546-follow-ups.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
