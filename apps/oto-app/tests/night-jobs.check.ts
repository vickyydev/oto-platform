// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes twice and needs a database with the otoapp schema
// migrated.
//
// S2-17b round 3 — the app's night work on the platform's runner, over HTTP
// against the routes as registered (plan section 5 "The app's jobs on the
// platform runner"; hazards H8 and H9):
//
//   - POST /api/directory/jobs/:name/run takes a tenant-bound directory key
//     with `jobs:run`: no key 401, a key it did not issue or one without the
//     scope 403, a body naming another park group 404 (as another tenant's
//     event is), an unknown job 404, a body it does not take 400;
//   - under OTOAPP_JOBS=inprocess it refuses in words and runs nothing;
//   - under OTOAPP_JOBS=platform each batch runs for the key's park group and
//     nobody else's, synchronously, answering each step: the 00:01 batch
//     checks out the forgotten guest, closes each stale clock-in with exactly
//     ONE out at midnight (and none more on a second run), and makes the day's
//     recurring task once; the 03:00 batch repairs presence, moves the leaver
//     to Left, switches off the leaver's login and clears old availability;
//     the presence check repairs presence;
//   - the same park group's batch already running answers 409 and runs nothing;
//   - an error a step swallows is a failed step, named in words, and the
//     steps after it still run (the app's own "continue"); the one error the
//     app lets escape (the availability clean-up, the batch's last step) is a
//     failed step too;
//   - under `platform` the scheduler registers no timer; under `inprocess`
//     the app's own: the three night timers and, from round 4b, the
//     Attention engine's start-up run and six-hourly timer and the no-show
//     check's first run and ten-minute timer (seven);
//   - the two manual job triggers point at the Console under `platform`, and
//     under `inprocess` act on the caller's park group only.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/night-jobs.check.ts
// The platform's suite runs it the same way against a fresh test database
// when the app's node_modules are present (apps/api/test/s217b-r3.test.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { JOBS_ON_PLATFORM_REFUSAL } from "../server/lib/routeFences";
import {
  JOBS_INPROCESS_REFUSAL,
  JOB_NOT_FOUND_REFUSAL,
  JOB_RUNNING_REFUSAL,
  PARK_GROUP_NOT_FOUND_REFUSAL,
  type NightJobAnswer,
} from "../server/lib/nightJobs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("night-jobs.check: DATABASE_URL is not set");
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
/** The app keeps naive UTC timestamps: "30 hours ago" is always before today's Bangkok midnight. */
const LONG_AGO = "(now() at time zone 'utc') - interval '30 hours'";

// ─── Two park groups ─────────────────────────────────────────────────────────

interface ParkGroup {
  tenant: string;
  branch: string;
  admin: { id: string; email: string };
  /** An employee clocked in 30 hours ago and never out. */
  stale: { employee: string; event: string };
  /** A guest still `in_park` from yesterday. */
  checkin: string;
  /** A daily recurring task definition. */
  taskDefinition: string;
  /** Presence that says "not clocked in" yet names a branch. */
  mismatch: string;
  /** LEAVING, last working day long past. */
  leaving: string;
  /** Last working day long past, login still on. */
  departedUser: string;
  /** An availability record from 2020. */
  availability: string;
}

async function employee(tenant: string, branch: string, label: string, fields: Record<string, unknown> = {}) {
  const id = randomUUID();
  const cols = ["id", "tenant_id", "branch_id", "full_name", "nickname", "email", ...Object.keys(fields)];
  const vals = [id, tenant, branch, `ZZ TEST ${label} ${id.slice(0, 4)}`, "ZZ", `zz-${id}@example.com`, ...Object.values(fields)];
  await q(`insert into employees (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  return id;
}

async function user(tenant: string, role: string, email: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q(
    "insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')",
    [tenant, id],
  );
  return id;
}

async function staleClockIn(tenant: string, branch: string, employeeId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into time_events (id, tenant_id, employee_id, branch_id, event_type, event_time, auth_method)
     values ($1, $2, $3, $4, 'IN', ${LONG_AGO}, 'PIN')`,
    [id, tenant, employeeId, branch],
  );
  return id;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  const branch = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ${label} ${run}`, `zz-nj-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [branch, tenant, `ZZ TEST ${label} park ${run}`]);
  const adminEmail = `zz-nj-${label}-admin-${run}@example.com`;
  const admin = { id: await user(tenant, "admin", adminEmail), email: adminEmail };

  const clocked = await employee(tenant, branch, label);
  const stale = { employee: clocked, event: await staleClockIn(tenant, branch, clocked) };

  const checkin = randomUUID();
  await q(
    `insert into service_checkins (id, tenant_id, branch_id, status, parent_full_name, whatsapp_phone_raw, child_full_name, checked_in_at)
     values ($1, $2, $3, 'in_park', 'ZZ TEST parent', '+66000000000', 'ZZ TEST child', ${LONG_AGO})`,
    [checkin, tenant, branch],
  );

  const taskDefinition = randomUUID();
  await q(
    `insert into tasks (id, tenant_id, branch_id, title, recurrence, is_recurring_definition)
     values ($1, $2, $3, $4, 'daily', true)`,
    [taskDefinition, tenant, branch, `ZZ TEST ${label} daily ${run}`],
  );

  const mismatch = await employee(tenant, branch, label);
  await q(
    `insert into employee_presence (employee_id, tenant_id, is_clocked_in, current_work_branch_id)
     values ($1, $2, false, $3)`,
    [mismatch, tenant, branch],
  );

  const leaving = await employee(tenant, branch, label, { employment_state: "LEAVING", last_working_day: "2020-01-01" });

  const departedUser = await user(tenant, "staff", `zz-nj-${label}-departed-${run}@example.com`);
  await employee(tenant, branch, label, { last_working_day: "2020-01-01", user_id: departedUser });

  const availability = randomUUID();
  await q(
    `insert into employee_role_availability (id, tenant_id, employee_id, role_id, role_name, unavailable_date)
     values ($1, $2, $3, 'zz', 'ZZ TEST', '2020-01-01')`,
    [availability, tenant, leaving],
  );

  return { tenant, branch, admin, stale, checkin, taskDefinition, mismatch, leaving, departedUser, availability };
}

const A = await parkGroup("a");
const B = await parkGroup("b");

/** Everything a batch may touch for one park group, in one comparable value. */
async function stateOf(g: ParkGroup) {
  const one = async <T>(sql: string, params: unknown[]) => ((await q(sql, params))[0] ?? null) as T;
  return {
    outs: Number(
      (await one<{ n: string }>("select count(*) as n from time_events where employee_id = $1 and event_type = 'OUT'", [g.stale.employee])).n,
    ),
    checkin: (await one<{ status: string }>("select status from service_checkins where id = $1", [g.checkin])).status,
    generated: Number(
      (await one<{ n: string }>("select count(*) as n from tasks where parent_task_id = $1", [g.taskDefinition])).n,
    ),
    mismatchBranch: (
      await one<{ b: string | null }>("select current_work_branch_id as b from employee_presence where employee_id = $1", [g.mismatch])
    ).b,
    leaving: (await one<{ s: string }>("select employment_state as s from employees where id = $1", [g.leaving])).s,
    departedActive: (await one<{ a: boolean }>("select is_active as a from users where id = $1", [g.departedUser])).a,
    availability: Number(
      (await one<{ n: string }>("select count(*) as n from employee_role_availability where id = $1", [g.availability])).n,
    ),
  };
}

const untouched = {
  outs: 0,
  checkin: "in_park",
  generated: 0,
  mismatchBranch: B.branch,
  leaving: "LEAVING",
  departedActive: true,
  availability: 1,
};

// ─── Directory keys, as script/directory-client.mjs issues them ─────────────

async function directoryKey(tenant: string, scopes: string[]): Promise<string> {
  const key = "odk_" + randomBytes(32).toString("base64url");
  await q(
    "insert into directory_clients (tenant_id, name, key_hash, scopes) values ($1, $2, $3, $4)",
    [tenant, `ZZ TEST ${run}`, createHash("sha256").update(key).digest("hex"), scopes],
  );
  return key;
}

const keyA = await directoryKey(A.tenant, ["jobs:run"]);
const eventsOnlyA = await directoryKey(A.tenant, ["events:write"]);
const keyB = await directoryKey(B.tenant, ["jobs:run"]);

// ─── The two servers ─────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
const HARNESS_ENV = {
  NODE_ENV: "test",
  APP_ENV: "dev",
  STORAGE_ENV_PREFIX: "zz-test",
  OBJECT_STORAGE: "local",
  OTOAPP_LEGACY_LOGIN: "true",
  LOG_LEVEL: "warn",
  // The app runs with TZ=UTC: its timestamps are naive UTC and its Bangkok
  // midnight is computed by hand. A developer's machine in Bangkok must not
  // move either.
  TZ: "UTC",
  DEPLOY_ENV: "local",
};

async function serve(env: Record<string, string>): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise((resolve, reject) => {
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

/** How many timers the scheduler registers under one switch (tests/harness/start-scheduler.ts). */
function timersUnder(mode: "platform" | "inprocess"): { timers: number; started: boolean } {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(process.execPath, [tsx, "tests/harness/start-scheduler.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV, OTOAPP_JOBS: mode },
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const m = /TIMERS=(\d+) STARTED=(true|false)/.exec(output);
  assert.ok(m, `start-scheduler printed no count:\n${output}`);
  return { timers: Number(m[1]), started: m[2] === "true" };
}

const job = async (origin: string, name: string, key: string | null, body: unknown = {}) => {
  const res = await fetch(`${origin}/api/directory/jobs/${name}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body: parsed as Record<string, unknown> & Partial<NightJobAnswer> };
};

async function signIn(origin: string, email: string): Promise<string> {
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const post = async (origin: string, path: string, cookie: string) => {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{}",
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON.
  }
  return { status: res.status, body, text };
};

const stepOf = (answer: Partial<NightJobAnswer>, step: string) => {
  const found = answer.steps?.find((s) => s.step === step);
  assert.ok(found, `the answer names the step ${step}: ${JSON.stringify(answer)}`);
  return found;
};

let checks = 0;
const check = (name: string, fn: () => void | Promise<void>) => async () => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

try {
  const [platform, inprocess] = await Promise.all([
    serve({ OTOAPP_JOBS: "platform" }),
    serve({ OTOAPP_JOBS: "inprocess" }),
  ]);

  // ── The key, the switch, the body ──────────────────────────────────────────
  console.log("POST /api/directory/jobs/:name/run — who may ask:");
  await check("no key: 401, and nothing runs", async () => {
    const res = await job(platform, "midnight", null);
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.deepEqual(await stateOf(A), { ...untouched, mismatchBranch: A.branch });
  })();
  await check("a key this app never issued: 403", async () => {
    const res = await job(platform, "midnight", "odk_" + randomBytes(32).toString("base64url"));
    assert.equal(res.status, 403, JSON.stringify(res.body));
  })();
  await check("a key without jobs:run (events:write only): 403, naming the scope", async () => {
    const res = await job(platform, "midnight", eventsOnlyA);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(String(res.body.message), /jobs:run/);
  })();
  await check("under OTOAPP_JOBS=inprocess the endpoint refuses in words, and nothing runs", async () => {
    const res = await job(inprocess, "midnight", keyA, { tenantId: A.tenant });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body, JOBS_INPROCESS_REFUSAL);
    assert.deepEqual(await stateOf(A), { ...untouched, mismatchBranch: A.branch });
  })();
  await check("round 4b's two Attention batches follow the same switch: refused in words under inprocess", async () => {
    for (const name of ["attention", "no_show"]) {
      const res = await job(inprocess, name, keyA, { tenantId: A.tenant });
      assert.equal(res.status, 409, `${name}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, JOBS_INPROCESS_REFUSAL);
    }
  })();
  await check("a job that is not one of the five: 404", async () => {
    const res = await job(platform, "payroll", keyA);
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual(res.body, JOB_NOT_FOUND_REFUSAL);
  })();
  await check("park group A's key naming park group B: 404, and neither park group is touched", async () => {
    const res = await job(platform, "midnight", keyA, { tenantId: B.tenant });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual(res.body, PARK_GROUP_NOT_FOUND_REFUSAL);
    assert.deepEqual(await stateOf(A), { ...untouched, mismatchBranch: A.branch });
    assert.deepEqual(await stateOf(B), untouched);
  })();
  await check("a body it does not take: 400", async () => {
    const res = await job(platform, "midnight", keyA, { tenantId: A.tenant, everyone: true });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  })();

  // ── The 00:01 batch ────────────────────────────────────────────────────────
  console.log("the 00:01 batch, for park group A only:");
  await check("the same park group's batch already running: 409, and it is not run a second time", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("select pg_advisory_lock($1::int4, hashtext($2))", [0x0712, `otoapp_night:midnight:${A.tenant}`]);
      const res = await job(platform, "midnight", keyA, { tenantId: A.tenant });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.deepEqual(res.body, JOB_RUNNING_REFUSAL);
      assert.deepEqual(await stateOf(A), { ...untouched, mismatchBranch: A.branch });
    } finally {
      await holder.query("select pg_advisory_unlock($1::int4, hashtext($2))", [0x0712, `otoapp_night:midnight:${A.tenant}`]);
      holder.release();
    }
  })();
  await check("it runs: the guest checked out, ONE out at midnight per stale clock-in, the day's task made — A's only", async () => {
    const res = await job(platform, "midnight", keyA, { tenantId: A.tenant });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.job, "midnight");
    assert.equal(res.body.tenantId, A.tenant);
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.deepEqual(res.body.steps!.map((s) => [s.step, s.ok, s.onFailure]), [
      ["autoCheckout", true, "continue"],
      ["autoClockOut", true, "continue"],
      ["taskGeneration", true, "continue"],
    ]);
    assert.equal(stepOf(res.body, "autoCheckout").counts.checkedOut, 1);
    assert.equal(stepOf(res.body, "autoClockOut").counts.autoClockedOut, 1);
    assert.equal(stepOf(res.body, "taskGeneration").counts.generated, 1);
    const a = await stateOf(A);
    assert.equal(a.outs, 1);
    assert.equal(a.checkin, "checked_out");
    assert.equal(a.generated, 1);
    const [out] = await q<{ notes: string; auth_method: string }>(
      "select notes, auth_method from time_events where employee_id = $1 and event_type = 'OUT'",
      [A.stale.employee],
    );
    // The app's own words and method (plan Q10: the auto clock-out is labelled FACE).
    assert.equal(out!.notes, "[Auto-clocked out at midnight — missing clock-out]");
    assert.equal(out!.auth_method, "FACE");
    assert.deepEqual(await stateOf(B), untouched);
  })();
  await check("a second run: nothing new — still one out per stale clock-in, still one task", async () => {
    const res = await job(platform, "midnight", keyA, { tenantId: A.tenant });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(stepOf(res.body, "autoClockOut").counts.autoClockedOut, 0);
    assert.equal(stepOf(res.body, "taskGeneration").counts.generated, 0);
    const a = await stateOf(A);
    assert.equal(a.outs, 1);
    assert.equal(a.generated, 1);
    assert.deepEqual(await stateOf(B), untouched);
  })();
  await check("an error a step swallows is a failed step, in words — and the steps after it still run", async () => {
    // A guard made for this check: the next clock-out written for this one
    // employee fails, as a database fault would.
    const broken = await employee(A.tenant, A.branch, "a-broken");
    await staleClockIn(A.tenant, A.branch, broken);
    await q(`create or replace function zz_nj_refuse_out() returns trigger language plpgsql as $$
             begin raise exception 'zz night-jobs forced failure'; end $$`);
    await q(`create trigger zz_nj_refuse_out before insert on time_events
             for each row when (new.employee_id = '${broken}' and new.event_type = 'OUT')
             execute function zz_nj_refuse_out()`);
    try {
      const res = await job(platform, "midnight", keyA, { tenantId: A.tenant });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, false);
      const failed = stepOf(res.body, "autoClockOut");
      assert.equal(failed.ok, false);
      assert.equal(failed.onFailure, "continue");
      assert.match(String(failed.error), /zz night-jobs forced failure/);
      // The batch went on, as the app's own does.
      assert.equal(stepOf(res.body, "taskGeneration").ok, true);
      assert.equal(stepOf(res.body, "autoCheckout").ok, true);
    } finally {
      await q("drop trigger zz_nj_refuse_out on time_events");
      await q("drop function zz_nj_refuse_out()");
    }
    // The next run closes it: still one out each.
    const again = await job(platform, "midnight", keyA, { tenantId: A.tenant });
    assert.equal(again.body.ok, true, JSON.stringify(again.body));
    const [{ n }] = await q<{ n: string }>(
      "select count(*) as n from time_events where employee_id = $1 and event_type = 'OUT'",
      [broken],
    );
    assert.equal(Number(n), 1);
  })();

  // ── The 03:00 batch and the presence check ─────────────────────────────────
  console.log("the 03:00 batch and the six-hourly presence check:");
  await check("the escaped error — the availability clean-up, the batch's last step — is a failed step too", async () => {
    await q(`create or replace function zz_nj_refuse_cleanup() returns trigger language plpgsql as $$
             begin raise exception 'zz night-jobs cleanup refused'; end $$`);
    await q(`create trigger zz_nj_refuse_cleanup before delete on employee_role_availability
             for each row execute function zz_nj_refuse_cleanup()`);
    try {
      const res = await job(platform, "reconcile", keyA, { tenantId: A.tenant });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, false);
      const failed = stepOf(res.body, "availabilityCleanup");
      assert.equal(failed.ok, false);
      assert.equal(failed.onFailure, "stop");
      assert.match(String(failed.error), /zz night-jobs cleanup refused/);
      for (const step of ["presenceReconciliation", "statusTransitions", "departedLogins"]) {
        assert.equal(stepOf(res.body, step).ok, true, step);
      }
    } finally {
      await q("drop trigger zz_nj_refuse_cleanup on employee_role_availability");
      await q("drop function zz_nj_refuse_cleanup()");
    }
  })();
  await check("it runs for A: presence repaired, the leaver Left, their login off, old availability gone — B untouched", async () => {
    const res = await job(platform, "reconcile", keyA, { tenantId: A.tenant });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.deepEqual(res.body.steps!.map((s) => s.step), [
      "presenceReconciliation",
      "statusTransitions",
      "departedLogins",
      "availabilityCleanup",
    ]);
    const a = await stateOf(A);
    assert.equal(a.mismatchBranch, null);
    assert.equal(a.leaving, "LEFT");
    assert.equal(a.departedActive, false);
    assert.equal(a.availability, 0);
    assert.deepEqual(await stateOf(B), untouched);
  })();
  await check("the presence check runs for B's key, for B only", async () => {
    const res = await job(platform, "presence", keyB, { tenantId: B.tenant });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(res.body.tenantId, B.tenant);
    assert.equal(stepOf(res.body, "presenceReconciliation").counts.repairs, 1);
    assert.equal((await stateOf(B)).mismatchBranch, null);
    assert.equal((await stateOf(B)).leaving, "LEAVING");
  })();
  await check("a body with no park group runs the key's own", async () => {
    const res = await job(platform, "presence", keyA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.tenantId, A.tenant);
  })();

  // ── The scheduler ──────────────────────────────────────────────────────────
  console.log("the scheduler:");
  await check("under OTOAPP_JOBS=platform it registers no timer at all", () => {
    assert.deepEqual(timersUnder("platform"), { timers: 0, started: false });
  })();
  await check("under OTOAPP_JOBS=inprocess it registers the app's own: 00:01, 03:00, six-hourly presence, and Attention's four (round 4b)", () => {
    assert.deepEqual(timersUnder("inprocess"), { timers: 7, started: true });
  })();

  // ── The two manual triggers ────────────────────────────────────────────────
  console.log("the two manual job triggers:");
  const departedA = await user(A.tenant, "staff", `zz-nj-a-departed2-${run}@example.com`);
  await employee(A.tenant, A.branch, "a", { last_working_day: "2020-01-01", user_id: departedA });
  const departedB = await user(B.tenant, "staff", `zz-nj-b-departed2-${run}@example.com`);
  await employee(B.tenant, B.branch, "b", { last_working_day: "2020-01-01", user_id: departedB });
  const leavingA = await employee(A.tenant, A.branch, "a", { employment_state: "LEAVING", last_working_day: "2020-01-01" });
  const active = async (id: string) => (await q<{ a: boolean }>("select is_active as a from users where id = $1", [id]))[0]!.a;
  const stateOfEmployee = async (id: string) =>
    (await q<{ s: string }>("select employment_state as s from employees where id = $1", [id]))[0]!.s;

  const adminOnPlatform = await signIn(platform, A.admin.email);
  for (const path of ["/api/admin/run-departed-deactivation", "/api/scheduler/transition-left"]) {
    await check(`POST ${path} under platform: the platform's 03:00 run and Retry, in words, and nothing runs`, async () => {
      const res = await post(platform, path, adminOnPlatform);
      assert.equal(res.status, 409, res.text);
      assert.deepEqual(res.body, JOBS_ON_PLATFORM_REFUSAL);
      assert.equal(await active(departedA), true);
      assert.equal(await stateOfEmployee(leavingA), "LEAVING");
    })();
  }
  const adminInProcess = await signIn(inprocess, A.admin.email);
  await check("under inprocess the departed deactivation runs as today, for the caller's park group only", async () => {
    const res = await post(inprocess, "/api/admin/run-departed-deactivation", adminInProcess);
    assert.equal(res.status, 200, res.text);
    assert.equal(await active(departedA), false);
    assert.equal(await active(departedB), true);
  })();
  await check("under inprocess transition-left runs as today, for the caller's park group only", async () => {
    const res = await post(inprocess, "/api/scheduler/transition-left", adminInProcess);
    assert.equal(res.status, 200, res.text);
    assert.equal(await stateOfEmployee(leavingA), "LEFT");
    assert.equal(await stateOfEmployee(B.leaving), "LEAVING");
  })();

  console.log(`night-jobs.check: ${checks} checks passed`);
} catch (err) {
  console.error("night-jobs.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
