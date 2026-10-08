// seed: its own — the default park group (made when the database has none) and
// a second park group, of ZZ TEST rows, made here. Not a Playwright file (the
// suite collects *.spec.ts and *.test.ts; this is neither): it boots the app's
// real routes twice and needs a database with the otoapp schema migrated.
//
// S2-17b round 4 — tenant ownership over HTTP against the routes as registered
// (plan section 7, section 8 round 4; hazards H11, H12). Written for round 4a
// (the expand half) and brought to round 4b (the contract half, migration
// 0007), which this database carries:
//
//   - SETTINGS (H11): each park group reads its own value for a key and the
//     default park group's where it has none (Q28); each park group saves its
//     OWN row — beside the default park group's for the same key, which stays
//     as it was — the Fix department included; a caller the app cannot place
//     is refused (403); a save of several keys is one transaction, so a key
//     that fails saves none of the others (the round 4a review's note); a row
//     with no park group can no longer be written (NOT NULL); and on a
//     database 0007 has not reached (the old one-row-per-key unique put back
//     for the length of the check) another park group's save of a key the
//     default holds is refused in words, never a 500, and saves nothing else;
//   - THE ACTIVITY LOGBOOK: rows about no branch show in their own park
//     group's logbook and nobody else's; a reader with every branch sees them,
//     a reader limited to a branch does not (the app's own rule); a row
//     written now through a route carries the caller's park group; the
//     summary counts one park group's rows;
//   - THE DIRECTORY'S HR READS (H12): a tenant-bound key with hr:read answers
//     for its park group only — another park group's employee or branch 404,
//     the lists its own; a key without hr:read 403; no key 401; the shared
//     key refused 403 where HR_DIRECTORY_API_KEY is unset, and where it is set,
//     answering for the default park group only (Q13).
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/tenant-ownership.check.ts
// The platform's suite runs it the same way against a fresh test database
// when the app's node_modules are present (apps/api/test/s217b-r4a.test.ts and
// s217b-r4b.test.ts).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SETTINGS_KEY_HELD_REFUSAL, SETTINGS_NO_PARK_GROUP_REFUSAL } from "../server/lib/parkGroupSettings";
import {
  HR_DIRECTORY_NO_KEY,
  HR_DIRECTORY_SHARED_KEY_INVALID,
  HR_DIRECTORY_SHARED_KEY_OFF,
} from "../server/directory/hrReadAuth";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("tenant-ownership.check: DATABASE_URL is not set");
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
const SHARED_KEY = `zz-shared-${randomBytes(16).toString("hex")}`;

// ─── The default park group and a second one ────────────────────────────────

/** The default park group (slug `default`): this database's, or made here when it has none. */
await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const DEFAULT = (await q<{ id: string }>("select id from tenants where slug = 'default'"))[0]!.id;

interface ParkGroup {
  tenant: string;
  branch: string;
  /** A second branch, for the reader limited to the first. */
  otherBranch: string;
  department: string;
  role: string;
  employee: string;
  admin: { id: string; email: string };
}

async function user(tenant: string, role: string, email: string, branch: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q(
    "insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)",
    [tenant, id, branch, branch ? "selected_branches" : "all_branches"],
  );
  return id;
}

async function parkGroup(label: string, tenant: string): Promise<ParkGroup> {
  const branch = randomUUID();
  const otherBranch = randomUUID();
  for (const [id, suffix] of [[branch, "one"], [otherBranch, "two"]] as const) {
    await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [
      id,
      tenant,
      `ZZ TEST ${label} ${suffix} ${run}`,
    ]);
  }
  const department = randomUUID();
  await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [department, tenant, `ZZ TEST ${label} dept ${run}`]);
  const role = randomUUID();
  await q("insert into roles (id, tenant_id, name) values ($1, $2, $3)", [role, tenant, `ZZ TEST ${label} role ${run}`]);
  const employee = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, primary_department_id, full_name, nickname, email)
     values ($1, $2, $3, $4, $5, 'ZZ', $6)`,
    [employee, tenant, branch, department, `ZZ TEST ${run} ${label} staff`, `zz-to-${label}-${run}@example.com`],
  );
  await q("insert into employee_roles (employee_id, role_id) values ($1, $2)", [employee, role]);
  await q(
    "insert into employee_presence (employee_id, tenant_id, is_clocked_in, current_work_branch_id) values ($1, $2, true, $3)",
    [employee, tenant, branch],
  );
  const adminEmail = `zz-to-${label}-admin-${run}@example.com`;
  const admin = { id: await user(tenant, "admin", adminEmail, null), email: adminEmail };
  return { tenant, branch, otherBranch, department, role, employee, admin };
}

const A = await parkGroup("a", DEFAULT);
const bTenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [bTenant, `ZZ TEST b ${run}`, `zz-to-b-${run}`]);
const B = await parkGroup("b", bTenant);

/** A manager of the default park group limited to its first branch. */
const limitedEmail = `zz-to-a-limited-${run}@example.com`;
await user(DEFAULT, "manager", limitedEmail, A.branch);

/** An admin the app cannot place: branch access in two park groups. */
const unplacedEmail = `zz-to-unplaced-${run}@example.com`;
const unplaced = await user(DEFAULT, "admin", unplacedEmail, null);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [
  B.tenant,
  unplaced,
]);

// ─── Directory keys, as script/directory-client.mjs issues them ─────────────

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

const hrA = await directoryKey(A.tenant, ["hr:read"]);
const hrB = await directoryKey(B.tenant, ["hr:read"]);
const eventsOnlyA = await directoryKey(A.tenant, ["events:write"]);

// ─── The two servers ─────────────────────────────────────────────────────────

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
};

async function serve(env: Record<string, string>): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const childEnv: Record<string, string | undefined> = { ...process.env, ...HARNESS_ENV, ...env };
  if (!env.HR_DIRECTORY_API_KEY) delete childEnv.HR_DIRECTORY_API_KEY;
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: childEnv as NodeJS.ProcessEnv,
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

async function signIn(origin: string, email: string): Promise<string> {
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field below
}

async function call(origin: string, method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
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

const settingsOf = async (origin: string, cookie: string): Promise<Map<string, { value: string; tenantId: string | null }>> => {
  const res = await call(origin, "GET", "/api/settings", { cookie });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return new Map((res.body as { key: string; value: string; tenantId: string | null }[]).map((s) => [s.key, { value: s.value, tenantId: s.tenantId }]));
};

const rowsFor = (key: string) =>
  q<{ tenant_id: string | null; value: string }>("select tenant_id, value from settings where key = $1 order by tenant_id", [key]);

let checks = 0;
const check = (name: string, fn: () => void | Promise<void>) => async () => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const K = (name: string) => `zz_test_${run}_${name}`;
let oldUniqueRestored = false;

try {
  const [plain, shared] = await Promise.all([serve({}), serve({ HR_DIRECTORY_API_KEY: SHARED_KEY })]);
  const cookieA = await signIn(plain, A.admin.email);
  const cookieB = await signIn(plain, B.admin.email);
  const cookieLimited = await signIn(plain, limitedEmail);
  const cookieUnplaced = await signIn(plain, unplacedEmail);

  // ── Settings, each park group its own (round 4b) ───────────────────────────
  console.log("settings, per park group, after 0007 — each park group saves its own (H11):");
  await check("0007's shape: tenant_id NOT NULL, and the (tenant_id, key) unique alone", async () => {
    const uniques = await q<{ conname: string }>(
      "select conname from pg_constraint where conrelid = 'otoapp.settings'::regclass and contype = 'u'",
    );
    assert.deepEqual(uniques, []);
    const indexes = await q<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'otoapp' and tablename = 'settings' and indexdef like 'CREATE UNIQUE%' order by 1",
    );
    assert.deepEqual(indexes.map((i) => i.indexname), ["settings_pkey", "settings_tenant_id_key_unique"]);
  })();
  await check("the default park group saves a key: one row, the default park group's", async () => {
    const res = await call(plain, "POST", "/api/settings", { cookie: cookieA, body: [{ key: K("held"), value: "A's value" }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await rowsFor(K("held")), [{ tenant_id: DEFAULT, value: "A's value" }]);
  })();
  await check("a second save of the same key updates that row, never a second", async () => {
    const res = await call(plain, "POST", "/api/settings", { cookie: cookieA, body: [{ key: K("held"), value: "A's newer value" }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await rowsFor(K("held")), [{ tenant_id: DEFAULT, value: "A's newer value" }]);
  })();
  await check("another park group with no row of its own reads the default park group's value (Q28)", async () => {
    const b = await settingsOf(plain, cookieB);
    assert.equal(b.get(K("held"))?.value, "A's newer value");
  })();
  await check("another park group saves the same key: its OWN row beside the default's, which is untouched", async () => {
    const res = await call(plain, "POST", "/api/settings", { cookie: cookieB, body: [{ key: K("held"), value: "B's value" }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body[0].tenantId, B.tenant);
    assert.deepEqual(
      (await rowsFor(K("held"))).sort((x, y) => String(x.tenant_id).localeCompare(String(y.tenant_id))),
      [
        { tenant_id: DEFAULT, value: "A's newer value" },
        { tenant_id: B.tenant, value: "B's value" },
      ].sort((x, y) => x.tenant_id.localeCompare(y.tenant_id)),
    );
  })();
  await check("each park group reads its own row for the key; neither reads the other's", async () => {
    assert.equal((await settingsOf(plain, cookieB)).get(K("held"))?.value, "B's value");
    assert.equal((await settingsOf(plain, cookieA)).get(K("held"))?.value, "A's newer value");
  })();
  await check("another park group saves a key nobody holds: its own row; the default park group does not read it", async () => {
    const res = await call(plain, "POST", "/api/settings", { cookie: cookieB, body: [{ key: K("b-only"), value: "B only" }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await rowsFor(K("b-only")), [{ tenant_id: B.tenant, value: "B only" }]);
    assert.equal((await settingsOf(plain, cookieA)).has(K("b-only")), false);
    // ...and the default park group can still save the same key for itself.
    const a = await call(plain, "POST", "/api/settings", { cookie: cookieA, body: [{ key: K("b-only"), value: "A too" }] });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal((await settingsOf(plain, cookieB)).get(K("b-only"))?.value, "B only");
    assert.equal((await settingsOf(plain, cookieA)).get(K("b-only"))?.value, "A too");
  })();
  await check("five saves of one new key at once by one park group: one row, every answer 200", async () => {
    const race = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call(plain, "POST", "/api/settings", { cookie: cookieB, body: [{ key: K("race"), value: `racer ${i}` }] })),
    );
    assert.deepEqual(race.map((r) => r.status), [200, 200, 200, 200, 200]);
    const rows = await rowsFor(K("race"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenant_id, B.tenant);
  })();
  await check("a save of several keys is one transaction: a later key that fails saves none of the earlier ones", async () => {
    const res = await call(plain, "POST", "/api/settings", {
      cookie: cookieB,
      body: [{ key: K("atomic-first"), value: "first" }, { key: null, value: "a key that cannot be" }],
    });
    assert.ok(res.status >= 400, `refused: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(await rowsFor(K("atomic-first")), []);
    // The same pair, whole, saves both — the transaction, not the first key, was the problem.
    const ok = await call(plain, "POST", "/api/settings", {
      cookie: cookieB,
      body: [{ key: K("atomic-first"), value: "first" }, { key: K("atomic-second"), value: "second" }],
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.map((s: { key: string }) => s.key), [K("atomic-first"), K("atomic-second")]);
    assert.deepEqual(await rowsFor(K("atomic-second")), [{ tenant_id: B.tenant, value: "second" }]);
  })();
  await check("another park group sets its own Fix department: its own row; the default park group's is untouched", async () => {
    const before = await q("select id, tenant_id, value from settings where key = 'fix_department_id' and tenant_id = $1", [DEFAULT]);
    const res = await call(plain, "POST", "/api/settings/fix-department", { cookie: cookieB, body: { departmentId: B.department } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await q("select id, tenant_id, value from settings where key = 'fix_department_id' and tenant_id = $1", [DEFAULT]), before);
    const b = await call(plain, "GET", "/api/settings/fix-department", { cookie: cookieB });
    assert.equal(b.body.departmentId, B.department);
  })();
  await check("no park group can set another park group's department as its Fix department: 404", async () => {
    const a = await call(plain, "POST", "/api/settings/fix-department", { cookie: cookieA, body: { departmentId: B.department } });
    assert.equal(a.status, 404, JSON.stringify(a.body));
    const b = await call(plain, "POST", "/api/settings/fix-department", { cookie: cookieB, body: { departmentId: A.department } });
    assert.equal(b.status, 404, JSON.stringify(b.body));
  })();
  await check("the default park group's Fix department is its own, and never another park group's", async () => {
    const set = await call(plain, "POST", "/api/settings/fix-department", { cookie: cookieA, body: { departmentId: A.department } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const a = await call(plain, "GET", "/api/settings/fix-department", { cookie: cookieA });
    assert.equal(a.body.departmentId, A.department);
    const b = await call(plain, "GET", "/api/settings/fix-department", { cookie: cookieB });
    assert.equal(b.body.departmentId, B.department);
  })();
  await check("an admin the app cannot place in one park group: 403 in words, nothing written", async () => {
    const res = await call(plain, "POST", "/api/settings", { cookie: cookieUnplaced, body: [{ key: K("unplaced"), value: "x" }] });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, SETTINGS_NO_PARK_GROUP_REFUSAL);
    assert.deepEqual(await rowsFor(K("unplaced")), []);
  })();
  await check("a row with no park group can no longer be written (NOT NULL, 0007)", async () => {
    await assert.rejects(q("insert into settings (key, value) values ($1, 'hand-over')", [K("handover")]), /null value in column "tenant_id"/);
    await assert.rejects(
      q("insert into activity_log (activity_type, summary_text) values ('employee_updated', $1)", [`ZZ TEST ${run} no park group`]),
      /null value in column "tenant_id"/,
    );
  })();

  // ── A database 0007 has not reached: the old one-row-per-key unique back ──
  console.log("settings, on a database 0007 has not reached (settings_key_unique put back for the length of these checks):");
  // The old unique cannot stand while a key is held twice: the second park
  // group's rows (all of them this check's own) go first.
  await q("delete from settings where tenant_id = $1", [B.tenant]);
  await q("alter table settings add constraint settings_key_unique unique (key)");
  oldUniqueRestored = true;
  await check("another park group saving a key the default holds: 409 in words (settings_key_held), never a 500, nothing written", async () => {
    const res = await call(plain, "POST", "/api/settings", { cookie: cookieB, body: [{ key: K("held"), value: "B on the old shape" }] });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body, SETTINGS_KEY_HELD_REFUSAL);
    assert.deepEqual(await rowsFor(K("held")), [{ tenant_id: DEFAULT, value: "A's newer value" }]);
  })();
  await check("the round 4a review's note: a new key before a refused one is not saved either", async () => {
    const res = await call(plain, "POST", "/api/settings", {
      cookie: cookieB,
      body: [{ key: K("before-the-refusal"), value: "would be orphaned" }, { key: K("held"), value: "refused" }],
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body, SETTINGS_KEY_HELD_REFUSAL);
    assert.deepEqual(await rowsFor(K("before-the-refusal")), []);
  })();
  await check("the default park group's own saves still work on that shape", async () => {
    const res = await call(plain, "POST", "/api/settings", {
      cookie: cookieA,
      body: [{ key: K("held"), value: "A on the old shape" }, { key: K("fresh"), value: "fresh" }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await rowsFor(K("held")), [{ tenant_id: DEFAULT, value: "A on the old shape" }]);
    assert.deepEqual(await rowsFor(K("fresh")), [{ tenant_id: DEFAULT, value: "fresh" }]);
  })();
  // Back to 0007's shape, for whatever runs after this check.
  await q("alter table settings drop constraint settings_key_unique");
  oldUniqueRestored = false;

  // ── The Activity Logbook ───────────────────────────────────────────────────
  console.log("the Activity Logbook, per park group:");
  const activity = async (fields: { tenant: string; branch: string | null; label: string; type?: string }) => {
    const id = randomUUID();
    await q(
      `insert into activity_log (id, tenant_id, branch_id, activity_type, summary_text)
       values ($1, $2, $3, $4, $5)`,
      [id, fields.tenant, fields.branch, fields.type ?? "employee_updated", `ZZ TEST ${run} ${fields.label}`],
    );
    return id;
  };
  const rows = {
    aBranch: await activity({ tenant: A.tenant, branch: A.branch, label: "a-branch" }),
    aOther: await activity({ tenant: A.tenant, branch: A.otherBranch, label: "a-other" }),
    aNone: await activity({ tenant: A.tenant, branch: null, label: "a-none" }),
    bBranch: await activity({ tenant: B.tenant, branch: B.branch, label: "b-branch" }),
    bNone: await activity({ tenant: B.tenant, branch: null, label: "b-none" }),
    aPromotion: await activity({ tenant: A.tenant, branch: null, label: "a-promotion", type: "promotion" }),
    bPromotion: await activity({ tenant: B.tenant, branch: B.branch, label: "b-promotion", type: "promotion" }),
  };
  const seen = async (cookie: string) => {
    const res = await call(plain, "GET", `/api/activity-logs?search=${encodeURIComponent(`ZZ TEST ${run}`)}&limit=100`, { cookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = new Set((res.body.logs as { id: string }[]).map((l) => l.id));
    return new Set(Object.entries(rows).filter(([, id]) => ids.has(id)).map(([k]) => k));
  };
  await check("the default park group's admin: its own rows, the branchless ones included, none of B's", async () => {
    assert.deepEqual(await seen(cookieA), new Set(["aBranch", "aOther", "aNone", "aPromotion"]));
  })();
  await check("B's admin: B's rows, its branchless one included, none of the default park group's", async () => {
    assert.deepEqual(await seen(cookieB), new Set(["bBranch", "bNone", "bPromotion"]));
  })();
  await check("a reader limited to one branch: that branch's rows only, no branchless row (the app's own rule)", async () => {
    assert.deepEqual(await seen(cookieLimited), new Set(["aBranch"]));
  })();
  await check("another park group's branch named in the filter: 404", async () => {
    const res = await call(plain, "GET", `/api/activity-logs?branchId=${B.branch}`, { cookie: cookieA });
    assert.equal(res.status, 404, JSON.stringify(res.body));
  })();
  await check("the summary counts the caller's park group's rows only", async () => {
    const before = await call(plain, "GET", "/api/activity-logs/summary", { cookie: cookieB });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    await activity({ tenant: B.tenant, branch: null, label: "b-promotion-2", type: "promotion" });
    const afterB = await call(plain, "GET", "/api/activity-logs/summary", { cookie: cookieB });
    assert.equal(afterB.body.promotion, before.body.promotion + 1);
    const a = await call(plain, "GET", "/api/activity-logs/summary", { cookie: cookieA });
    await activity({ tenant: B.tenant, branch: B.branch, label: "b-promotion-3", type: "promotion" });
    const a2 = await call(plain, "GET", "/api/activity-logs/summary", { cookie: cookieA });
    assert.equal(a2.body.promotion, a.body.promotion);
  })();
  await check("a row written now about no branch carries the caller's park group, and shows only there", async () => {
    const res = await call(plain, "POST", "/api/change-password", {
      cookie: cookieB,
      body: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [row] = await q<{ id: string; tenant_id: string; branch_id: string | null }>(
      `select id, tenant_id, branch_id from activity_log
        where created_by = $1 and activity_type = 'USER_PASSWORD_CHANGED' order by created_at desc limit 1`,
      [B.admin.id],
    );
    assert.equal(row?.branch_id, null);
    assert.equal(row?.tenant_id, B.tenant);
    const typed = async (cookie: string) =>
      ((await call(plain, "GET", "/api/activity-logs?types=USER_PASSWORD_CHANGED&limit=1000", { cookie })).body.logs as { id: string }[]).map((l) => l.id);
    assert.ok((await typed(cookieB)).includes(row!.id));
    assert.ok(!(await typed(cookieA)).includes(row!.id));
  })();

  // ── The directory's HR reads ───────────────────────────────────────────────
  console.log("the directory's HR reads (H12):");
  const dir = (origin: string, path: string, headers: Record<string, string> = {}) => call(origin, "GET", path, { headers });
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  await check("no key: 401, naming the key to send", async () => {
    const res = await dir(plain, `/api/directory/employee/${A.employee}`);
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.deepEqual(res.body, HR_DIRECTORY_NO_KEY);
  })();
  await check("A's hr:read key reads A's employee, with A's branch, department, role and presence", async () => {
    const res = await dir(plain, `/api/directory/employee/${A.employee}`, bearer(hrA));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.employee_id, A.employee);
    assert.equal(res.body.home_branch?.id, A.branch);
    assert.equal(res.body.department?.id, A.department);
    assert.deepEqual(res.body.roles.map((r: { id: string }) => r.id), [A.role]);
    assert.equal(res.body.presence.current_work_branch?.id, A.branch);
  })();
  await check("A's key reading B's employee: 404, as one that does not exist", async () => {
    const res = await dir(plain, `/api/directory/employee/${B.employee}`, bearer(hrA));
    assert.equal(res.status, 404, JSON.stringify(res.body));
    const none = await dir(plain, `/api/directory/employee/${randomUUID()}`, bearer(hrA));
    assert.deepEqual(res.body, none.body);
  })();
  await check("a key without hr:read: 403, naming the scope", async () => {
    const res = await dir(plain, `/api/directory/employee/${A.employee}`, bearer(eventsOnlyA));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(String(res.body.message), /hr:read/);
  })();
  await check("a key this app never issued: 403", async () => {
    const res = await dir(plain, `/api/directory/employee/${A.employee}`, bearer("odk_" + randomBytes(32).toString("base64url")));
    assert.equal(res.status, 403, JSON.stringify(res.body));
  })();
  await check("search: each key finds its own park group's staff only", async () => {
    const term = encodeURIComponent(`ZZ TEST ${run}`);
    const a = await dir(plain, `/api/directory/employees/search?q=${term}`, bearer(hrA));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.employees.map((e: { employee_id: string }) => e.employee_id), [A.employee]);
    const b = await dir(plain, `/api/directory/employees/search?q=${term}`, bearer(hrB));
    assert.deepEqual(b.body.employees.map((e: { employee_id: string }) => e.employee_id), [B.employee]);
  })();
  await check("a branch roster: another park group's branch 404, its own lists its own staff", async () => {
    const other = await dir(plain, `/api/directory/branches/${B.branch}/employees`, bearer(hrA));
    assert.equal(other.status, 404, JSON.stringify(other.body));
    const own = await dir(plain, `/api/directory/branches/${A.branch}/employees`, bearer(hrA));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual(own.body.employees.map((e: { employee_id: string }) => e.employee_id), [A.employee]);
  })();
  await check("roles, departments and branches: the key's park group's only", async () => {
    const roles = (await dir(plain, "/api/directory/roles", bearer(hrB))).body.roles.map((r: { id: string }) => r.id);
    assert.ok(roles.includes(B.role) && !roles.includes(A.role), JSON.stringify(roles));
    const depts = (await dir(plain, "/api/directory/departments", bearer(hrB))).body.departments.map((d: { id: string }) => d.id);
    assert.ok(depts.includes(B.department) && !depts.includes(A.department), JSON.stringify(depts));
    const branches = (await dir(plain, "/api/directory/branches", bearer(hrB))).body.branches.map((b: { id: string }) => b.id);
    assert.ok(branches.includes(B.branch) && !branches.includes(A.branch), JSON.stringify(branches));
  })();
  await check("HR_DIRECTORY_API_KEY unset: the shared-key path answers 403 in words", async () => {
    const res = await dir(plain, `/api/directory/employee/${A.employee}`, { "x-hr-api-key": SHARED_KEY });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, HR_DIRECTORY_SHARED_KEY_OFF);
  })();
  await check("HR_DIRECTORY_API_KEY set: the shared key reads the default park group only (Q13)", async () => {
    const own = await dir(shared, `/api/directory/employee/${A.employee}`, { "x-hr-api-key": SHARED_KEY });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.employee_id, A.employee);
    const other = await dir(shared, `/api/directory/employee/${B.employee}`, { "x-hr-api-key": SHARED_KEY });
    assert.equal(other.status, 404, JSON.stringify(other.body));
    const branches = (await dir(shared, "/api/directory/branches", { "x-hr-api-key": SHARED_KEY })).body.branches.map((b: { id: string }) => b.id);
    assert.ok(branches.includes(A.branch) && !branches.includes(B.branch), JSON.stringify(branches));
  })();
  await check("HR_DIRECTORY_API_KEY set: a wrong shared key 403, and a tenant-bound key still answers for its own", async () => {
    const wrong = await dir(shared, `/api/directory/employee/${A.employee}`, { "x-hr-api-key": "not-the-key" });
    assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
    assert.deepEqual(wrong.body, HR_DIRECTORY_SHARED_KEY_INVALID);
    const b = await dir(shared, `/api/directory/employee/${B.employee}`, bearer(hrB));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const a = await dir(shared, `/api/directory/employee/${A.employee}`, bearer(hrB));
    assert.equal(a.status, 404, JSON.stringify(a.body));
  })();

  console.log(`tenant-ownership.check: ${checks} checks passed`);
} finally {
  // The old one-row-per-key unique, put back for the checks of a database 0007
  // has not reached, goes again whatever happened: this database is 0007's.
  if (oldUniqueRestored) {
    await q("alter table settings drop constraint settings_key_unique").catch((e: unknown) =>
      console.error("could not drop settings_key_unique again:", e),
    );
  }
  for (const child of children) child.kill();
  await pool.end();
}
