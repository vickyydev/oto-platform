// seed: its own — two park groups of ZZ TEST rows, made here, and the default
// park group's Attention rules (the slug-`default` park group, made when the
// database has none). Not a Playwright file (the suite collects *.spec.ts and
// *.test.ts; this is neither): it boots the app's real routes and needs a
// database with the otoapp schema migrated.
//
// S2-17b round 4b — Attention resumed, per park group, over HTTP against the
// routes as registered (plan section 7 round 4, section 8 round 4's 4b half;
// hazard H20):
//
//   - the engine (the platform's `attention` batch, POST
//     /api/directory/jobs/attention/run under a park group's jobs:run key)
//     raises that park group's items and nobody else's, each carrying its park
//     group; its answer counts the new items rule by rule; a second run raises
//     nothing new (H20); two runs at once never both run;
//   - each park group's managers read their own items only: a reader with
//     every branch sees the branchless ones, a branch-limited reader does not;
//   - Refresh runs the caller's park group's engine only, and is refused in
//     words while that park group's engine is already running;
//   - Snooze (24 hours) and Resolve (for good) work on one's own items, and
//     another park group's item is a 404 that changes nothing; a snoozed item
//     is not re-opened by the next run;
//   - the rules (`attention_rules_config`): a park group reads the default
//     park group's until it saves its own, and saves its own row;
//   - the no-show check per park group (07:00-22:00 Bangkok, the app's hours),
//     and the app's own six-hourly run resolving a no-show alert it did not
//     raise (the app's rule, kept);
//   - the night batches' Attention writes (a stuck clock-in) carry the park
//     group of the person they are about.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/attention.check.ts
// The platform's suite runs it the same way against a fresh test database
// when the app's node_modules are present (apps/api/test/s217b-r4b.test.ts).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ATTENTION_REFRESH_RUNNING, JOB_RUNNING_REFUSAL, type NightJobAnswer } from "../server/lib/nightJobs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("attention.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 6 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const LOCK_NAMESPACE = 0x0712;

// ─── The default park group and two of our own ───────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const DEFAULT = (await q<{ id: string }>("select id from tenants where slug = 'default'"))[0]!.id;

interface ParkGroup {
  label: string;
  tenant: string;
  branch: string;
  otherBranch: string;
  /** Active, ten days on the books, no contract, department, role or login: several rules fire. */
  employee: string;
  /** The same, seated on no branch: its items are about no branch. */
  branchless: string;
  admin: { id: string; email: string };
  /** A manager limited to `branch`. */
  limited: { id: string; email: string };
}

async function user(tenant: string, role: string, email: string, branch: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    tenant,
    id,
    branch,
    branch ? "selected_branches" : "all_branches",
  ]);
  return id;
}

async function employee(tenant: string, branch: string | null, label: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, created_at)
     values ($1, $2, $3, $4, 'ZZ', $5, 'active', now() - interval '10 days')`,
    [id, tenant, branch, `ZZ TEST ${run} ${label}`, `zz-at-${label}-${id.slice(0, 8)}@example.com`],
  );
  return id;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST at ${label} ${run}`, `zz-at-${label}-${run}`]);
  const branch = randomUUID();
  const otherBranch = randomUUID();
  for (const [id, suffix] of [[branch, "one"], [otherBranch, "two"]] as const) {
    await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [
      id,
      tenant,
      `ZZ TEST at ${label} ${suffix} ${run}`,
    ]);
  }
  const adminEmail = `zz-at-${label}-admin-${run}@example.com`;
  const limitedEmail = `zz-at-${label}-limited-${run}@example.com`;
  return {
    label,
    tenant,
    branch,
    otherBranch,
    employee: await employee(tenant, branch, `${label}-staff`),
    branchless: await employee(tenant, null, `${label}-unseated`),
    admin: { id: await user(tenant, "admin", adminEmail, null), email: adminEmail },
    limited: { id: await user(tenant, "manager", limitedEmail, branch), email: limitedEmail },
  };
}

const A = await parkGroup("a");
const B = await parkGroup("b");

async function directoryKey(tenant: string, scopes: string[]): Promise<string> {
  const key = "odk_" + randomBytes(32).toString("base64url");
  await q("insert into directory_clients (tenant_id, name, key_hash, scopes) values ($1, $2, $3, $4)", [
    tenant,
    `ZZ TEST ${run}`,
    createHash("sha256").update(key).digest("hex"),
    scopes,
  ]);
  return key;
}

const keyA = await directoryKey(A.tenant, ["jobs:run"]);
const keyB = await directoryKey(B.tenant, ["jobs:run"]);

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
  // The platform runs the Attention batches through the job endpoint, which
  // answers only under `platform`; Refresh, snooze and resolve answer either way.
  OTOAPP_JOBS: "platform",
};

async function serve(env: Record<string, string> = {}): Promise<string> {
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

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field below
}

async function call(
  origin: string,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
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

async function signIn(origin: string, email: string): Promise<string> {
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const job = (origin: string, name: string, key: string, tenantId: string) =>
  call(origin, "POST", `/api/directory/jobs/${name}/run`, {
    body: { tenantId },
    headers: { authorization: `Bearer ${key}` },
  }) as Promise<{ status: number; body: NightJobAnswer & Record<string, unknown> }>;

/** Every item about one of a park group's two fixture employees, with its park group. */
const itemsAbout = (g: ParkGroup) =>
  q<{ id: string; tenant_id: string; branch_id: string | null; employee_id: string; rule_key: string; status: string; suppress_until: Date | null }>(
    `select id, tenant_id, branch_id, employee_id, rule_key, status, suppress_until from attention_items
      where employee_id = any($1) order by rule_key, employee_id`,
    [[g.employee, g.branchless]],
  );

let checks = 0;
const check = (name: string, fn: () => void | Promise<void>) => async () => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

try {
  const origin = await serve();
  const cookie = {
    a: await signIn(origin, A.admin.email),
    b: await signIn(origin, B.admin.email),
    aLimited: await signIn(origin, A.limited.email),
  };

  console.log("the engine, per park group (the platform's attention batch):");
  let firstCreatedA = 0;
  await check("A's run raises A's items only, each carrying A's park group; B has none", async () => {
    const res = await job(origin, "attention", keyA, A.tenant);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.deepEqual(res.body.steps.map((s) => [s.step, s.ok, s.onFailure]), [["attentionReconciliation", true, "continue"]]);
    const counts = res.body.steps[0]!.counts;
    firstCreatedA = counts.created!;
    assert.ok(firstCreatedA >= 6, `A's two employees raise at least three rules each: ${JSON.stringify(counts)}`);
    const items = await itemsAbout(A);
    assert.ok(items.length >= 6, JSON.stringify(items));
    for (const item of items) assert.equal(item.tenant_id, A.tenant, JSON.stringify(item));
    assert.deepEqual(await itemsAbout(B), []);
  })();
  await check("the run's answer counts the new items rule by rule, and the rules add up to the total", async () => {
    // A fresh park group's first run is the burst the plan names: every rule at once.
    const res = await job(origin, "attention", keyB, B.tenant);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const counts = res.body.steps[0]!.counts;
    const byRule = Object.entries(counts).filter(([k]) => k.startsWith("created."));
    assert.ok(byRule.length >= 3, JSON.stringify(counts));
    assert.equal(byRule.reduce((sum, [, n]) => sum + n, 0), counts.created);
    for (const rule of ["CHANGE_NO_CONTRACT", "EMPLOYEE_MISSING_ROLE", "MISSING_LOGIN_ACCESS"]) {
      assert.ok((counts[`created.${rule}`] ?? 0) >= 2, `${rule} for both of B's employees: ${JSON.stringify(counts)}`);
    }
    for (const item of await itemsAbout(B)) assert.equal(item.tenant_id, B.tenant);
  })();
  await check("H20: a second run raises nothing new — the same items, one per rule and person", async () => {
    const before = await itemsAbout(A);
    const res = await job(origin, "attention", keyA, A.tenant);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.steps[0]!.counts.created, 0, JSON.stringify(res.body.steps));
    const after = await itemsAbout(A);
    assert.deepEqual(after.map((i) => i.id), before.map((i) => i.id));
    const keys = after.map((i) => `${i.rule_key}:${i.employee_id}`);
    assert.equal(new Set(keys).size, keys.length, "one item per rule and person");
  })();
  await check("two runs at once for one park group: one runs, the other is refused, and nothing is raised twice", async () => {
    const before = (await itemsAbout(A)).length;
    const holder = await pool.connect();
    try {
      await holder.query("select pg_advisory_lock($1::int4, hashtext($2))", [LOCK_NAMESPACE, `otoapp_night:attention:${A.tenant}`]);
      const res = await job(origin, "attention", keyA, A.tenant);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.deepEqual(res.body, JOB_RUNNING_REFUSAL);
    } finally {
      await holder.query("select pg_advisory_unlock($1::int4, hashtext($2))", [LOCK_NAMESPACE, `otoapp_night:attention:${A.tenant}`]);
      holder.release();
    }
    const both = await Promise.all([job(origin, "attention", keyA, A.tenant), job(origin, "attention", keyA, A.tenant)]);
    assert.ok(both.some((r) => r.status === 200), JSON.stringify(both.map((r) => r.status)));
    for (const r of both.filter((x) => x.status !== 200)) assert.deepEqual(r.body, JOB_RUNNING_REFUSAL);
    assert.equal((await itemsAbout(A)).length, before);
  })();

  console.log("reading, per park group:");
  const listed = async (who: string, query = "") => {
    const res = await call(origin, "GET", `/api/attention-items?limit=1000${query}`, { cookie: who });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.paused, false);
    return new Set((res.body.items as { id: string }[]).map((i) => i.id));
  };
  await check("A's admin sees A's items, the branchless ones included, and none of B's", async () => {
    const seen = await listed(cookie.a);
    for (const item of await itemsAbout(A)) assert.ok(seen.has(item.id), `A sees ${item.rule_key}`);
    for (const item of await itemsAbout(B)) assert.ok(!seen.has(item.id), `A never sees B's ${item.rule_key}`);
  })();
  await check("B's admin sees B's items and none of A's", async () => {
    const seen = await listed(cookie.b);
    for (const item of await itemsAbout(B)) assert.ok(seen.has(item.id));
    for (const item of await itemsAbout(A)) assert.ok(!seen.has(item.id));
  })();
  await check("a manager limited to one of A's branches sees that branch's items, not the branchless ones", async () => {
    const seen = await listed(cookie.aLimited);
    const items = await itemsAbout(A);
    for (const item of items.filter((i) => i.branch_id === A.branch)) assert.ok(seen.has(item.id));
    for (const item of items.filter((i) => i.branch_id === null)) assert.ok(!seen.has(item.id), `not the branchless ${item.rule_key}`);
  })();
  await check("the counts are each park group's own; another park group's branch is a 404", async () => {
    const before = (await call(origin, "GET", "/api/attention-items/counts", { cookie: cookie.b })).body;
    await job(origin, "attention", keyA, A.tenant);
    const after = (await call(origin, "GET", "/api/attention-items/counts", { cookie: cookie.b })).body;
    assert.deepEqual(after, before);
    const other = await call(origin, "GET", `/api/attention-items?branchId=${B.branch}`, { cookie: cookie.a });
    assert.equal(other.status, 404, JSON.stringify(other.body));
  })();

  console.log("Refresh, Snooze and Resolve:");
  await check("Refresh as A runs A's engine only: B's open items are left as they are", async () => {
    const bBefore = await itemsAbout(B);
    const res = await call(origin, "POST", "/api/attention-items/refresh", { cookie: cookie.a });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(typeof res.body.created, "number");
    assert.match(String(res.body.message), /^Attention engine completed\./);
    assert.ok(res.body.lastCalculatedAt, "the park group's last run is answered");
    assert.deepEqual(await itemsAbout(B), bBefore);
    const last = await call(origin, "GET", "/api/attention-items/last-run", { cookie: cookie.a });
    assert.equal(last.status, 200);
    assert.equal(last.body.lastCalculatedAt, res.body.lastCalculatedAt);
  })();
  await check("Refresh while A's engine is running: 409 in words, and nothing runs", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("select pg_advisory_lock($1::int4, hashtext($2))", [LOCK_NAMESPACE, `otoapp_night:attention:${A.tenant}`]);
      const res = await call(origin, "POST", "/api/attention-items/refresh", { cookie: cookie.a });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.deepEqual(res.body, ATTENTION_REFRESH_RUNNING);
      // B's Refresh is B's own lock, and runs.
      const b = await call(origin, "POST", "/api/attention-items/refresh", { cookie: cookie.b });
      assert.equal(b.status, 200, JSON.stringify(b.body));
    } finally {
      await holder.query("select pg_advisory_unlock($1::int4, hashtext($2))", [LOCK_NAMESPACE, `otoapp_night:attention:${A.tenant}`]);
      holder.release();
    }
  })();
  await check("Snooze: one of A's items, for 24 hours — and the next run does not re-open it", async () => {
    const item = (await itemsAbout(A)).find((i) => i.status === "open" && i.rule_key === "EMPLOYEE_MISSING_ROLE")!;
    assert.ok(item, "an open item to snooze");
    const res = await call(origin, "POST", `/api/attention-items/${item.id}/resolve`, { cookie: cookie.a, body: { permanent: false } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "resolved");
    // The app keeps naive UTC timestamps (TZ=UTC): measured in the database, not read through this process's zone.
    const [row] = await q<{ status: string; hours: number; resolved_by: string }>(
      "select status, extract(epoch from (suppress_until - (now() at time zone 'utc'))) / 3600 as hours, resolved_by from attention_items where id = $1",
      [item.id],
    );
    assert.equal(row!.status, "resolved");
    assert.equal(row!.resolved_by, A.admin.id);
    const hours = Number(row!.hours);
    assert.ok(hours > 23 && hours <= 24.1, `snoozed for a day: ${hours}`);
    await job(origin, "attention", keyA, A.tenant);
    const [again] = await q<{ status: string }>("select status from attention_items where id = $1", [item.id]);
    assert.equal(again!.status, "resolved");
  })();
  await check("Resolve: one of A's items, for good", async () => {
    const item = (await itemsAbout(A)).find((i) => i.status === "open" && i.rule_key === "CHANGE_NO_CONTRACT")!;
    const res = await call(origin, "POST", `/api/attention-items/${item.id}/resolve`, { cookie: cookie.a, body: { permanent: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [row] = await q<{ until: string }>("select to_char(suppress_until, 'YYYY-MM-DD') as until from attention_items where id = $1", [item.id]);
    assert.equal(row!.until, "2050-01-01");
  })();
  await check("B snoozing or resolving A's item: 404, the same as one that does not exist, and the item is unchanged", async () => {
    const item = (await itemsAbout(A)).find((i) => i.status === "open")!;
    for (const permanent of [false, true]) {
      const res = await call(origin, "POST", `/api/attention-items/${item.id}/resolve`, { cookie: cookie.b, body: { permanent } });
      assert.equal(res.status, 404, JSON.stringify(res.body));
      const none = await call(origin, "POST", `/api/attention-items/${randomUUID()}/resolve`, { cookie: cookie.b, body: { permanent } });
      assert.deepEqual(res.body, none.body);
    }
    const condition = await call(origin, "GET", `/api/attention-items/${item.id}/check-condition`, { cookie: cookie.b });
    assert.equal(condition.status, 404);
    const [row] = await q<{ status: string }>("select status from attention_items where id = $1", [item.id]);
    assert.equal(row!.status, "open");
  })();

  console.log("the rules, per park group (attention_rules_config):");
  const [savedDefault] = await q<{ value: string }>("select value from settings where tenant_id = $1 and key = 'attention_rules_config'", [DEFAULT]);
  try {
    await q(
      `insert into settings (key, value, tenant_id) values ('attention_rules_config', $1, $2)
       on conflict (tenant_id, key) do update set value = excluded.value`,
      [JSON.stringify({ openShiftHoursThreshold: 48, zzDefault: run }), DEFAULT],
    );
    await check("a park group with no rules of its own reads the default park group's (Q28)", async () => {
      const res = await call(origin, "GET", "/api/attention-rules/config", { cookie: cookie.b });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.zzDefault, run);
      assert.equal(res.body.openShiftHoursThreshold, 48);
    })();
    await check("B saves its own rules: its own row; the default park group's and A's reading are as they were", async () => {
      const res = await call(origin, "PUT", "/api/attention-rules/config", { cookie: cookie.b, body: { openShiftHoursThreshold: 24, zzB: run } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.openShiftHoursThreshold, 24);
      const rows = await q<{ tenant_id: string; value: string }>(
        "select tenant_id, value from settings where key = 'attention_rules_config' and tenant_id = any($1)",
        [[DEFAULT, A.tenant, B.tenant]],
      );
      assert.deepEqual(rows.map((r) => r.tenant_id).sort(), [DEFAULT, B.tenant].sort());
      assert.equal(JSON.parse(rows.find((r) => r.tenant_id === DEFAULT)!.value).zzDefault, run);
      assert.equal((await call(origin, "GET", "/api/attention-rules/config", { cookie: cookie.b })).body.zzB, run);
      const a = (await call(origin, "GET", "/api/attention-rules/config", { cookie: cookie.a })).body;
      assert.equal(a.zzDefault, run);
      assert.equal(a.zzB, undefined);
    })();
  } finally {
    if (savedDefault) {
      await q("update settings set value = $1 where tenant_id = $2 and key = 'attention_rules_config'", [savedDefault.value, DEFAULT]);
    } else {
      await q("delete from settings where tenant_id = $1 and key = 'attention_rules_config'", [DEFAULT]);
    }
  }

  console.log("the no-show check, per park group (07:00-22:00 Bangkok), on servers whose clocks read noon and 23:00 today:");
  /** Today's date in Bangkok, the date the fixture's shifts and the two servers' clocks share. */
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const [noon, late] = await Promise.all([
    serve({ HARNESS_FAKE_NOW: `${today}T12:00:00+07:00` }),
    serve({ HARNESS_FAKE_NOW: `${today}T23:00:00+07:00` }),
  ]);
  /** A shift today from 00:00 Bangkok for one employee: past its grace at noon. */
  async function scheduledToday(g: ParkGroup): Promise<void> {
    const plan = randomUUID();
    await q(
      "insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)",
      [plan, g.tenant, g.branch, today],
    );
    const group = randomUUID();
    await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [group, g.tenant, g.branch, `ZZ TEST ${run}`]);
    const row = randomUUID();
    await q(
      `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time)
       values ($1, $2, $3, $4, $5, '00:00', '08:00')`,
      [row, g.tenant, g.branch, group, plan],
    );
    await q(
      `insert into schedule_assignments (tenant_id, week_plan_id, shift_row_id, shift_date, employee_id)
       values ($1, $2, $3, $4, $5)`,
      [g.tenant, plan, row, today, g.employee],
    );
  }
  await scheduledToday(A);
  await scheduledToday(B);
  const noShows = (g: ParkGroup) =>
    q<{ id: string; tenant_id: string; status: string }>(
      "select id, tenant_id, status from attention_items where rule_key = 'SCHEDULED_NO_SHOW_ALERT' and employee_id = $1",
      [g.employee],
    );
  await check("at 23:00 Bangkok the check runs nothing and says so (the app's own hours)", async () => {
    const res = await job(late, "no_show", keyB, B.tenant);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.steps[0]!.counts, { created: 0, resolved: 0, outsideHours: 1 });
    assert.deepEqual(await noShows(B), []);
  })();
  await check("at noon B's check raises B's no-show only, in B's park group; A's waits for A's own check", async () => {
    const res = await job(noon, "no_show", keyB, B.tenant);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.steps.map((s) => [s.step, s.ok]), [["noShowCheck", true]]);
    assert.deepEqual(res.body.steps[0]!.counts, { created: 1, resolved: 0, outsideHours: 0 });
    assert.deepEqual((await noShows(B)).map((i) => [i.tenant_id, i.status]), [[B.tenant, "open"]]);
    assert.deepEqual(await noShows(A), []);
    const a = await job(noon, "no_show", keyA, A.tenant);
    assert.equal(a.body.steps[0]!.counts.created, 1, JSON.stringify(a.body.steps));
    assert.deepEqual((await noShows(A)).map((i) => i.tenant_id), [A.tenant]);
  })();
  await check("a second check is the same alert, not a second one", async () => {
    const res = await job(noon, "no_show", keyB, B.tenant);
    assert.equal(res.body.steps[0]!.counts.created, 0, JSON.stringify(res.body.steps));
    assert.equal((await noShows(B)).length, 1);
  })();
  await check("once B's person clocks in, B's check resolves B's alert and leaves A's open", async () => {
    await q(
      `insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time, auth_method)
       values ($1, $2, $3, 'IN', $4::date - interval '6 hours', 'PIN')`,
      // 01:00 Bangkok today, kept as the app keeps time (naive UTC): inside the window the app's check reads.
      [B.tenant, B.employee, B.branch, today],
    );
    const res = await job(noon, "no_show", keyB, B.tenant);
    assert.equal(res.body.steps[0]!.counts.resolved, 1, JSON.stringify(res.body.steps));
    assert.deepEqual((await noShows(B)).map((i) => i.status), ["resolved"]);
    assert.deepEqual((await noShows(A)).map((i) => i.status), ["open"]);
  })();
  await check("the app's six-hourly run resolves a no-show alert it did not raise, and the next check re-opens it (the app's rule, kept)", async () => {
    await job(noon, "attention", keyA, A.tenant);
    assert.deepEqual((await noShows(A)).map((i) => i.status), ["resolved"]);
    await job(noon, "no_show", keyA, A.tenant);
    assert.deepEqual((await noShows(A)).map((i) => i.status), ["open"]);
    // B's alert was never touched by A's runs.
    assert.deepEqual((await noShows(B)).map((i) => i.status), ["resolved"]);
  })();

  console.log("the night batches' own Attention writes:");
  await check("a stuck clock-in found by the presence check is raised in the park group of the person it is about", async () => {
    await q(
      `insert into employee_presence (employee_id, tenant_id, is_clocked_in, current_work_branch_id, last_in_at)
       values ($1, $2, true, $3, (now() at time zone 'utc') - interval '20 hours')`,
      [B.employee, B.tenant, B.branch],
    );
    const res = await job(origin, "presence", keyB, B.tenant);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.steps[0]!.counts.stuckClockIns! >= 1, JSON.stringify(res.body.steps));
    const rows = await q<{ tenant_id: string }>(
      "select tenant_id from attention_items where type = 'TIMEKEEPING_STUCK_CLOCK_IN' and employee_id = $1",
      [B.employee],
    );
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.equal(r.tenant_id, B.tenant);
  })();

  console.log(`attention.check: ${checks} checks passed`);
} catch (err) {
  console.error("attention.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
