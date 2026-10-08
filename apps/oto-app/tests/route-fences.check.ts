// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes twice and needs a database with the otoapp schema
// migrated.
//
// S2-17b round 1 — the route fences and the user-delete refusals, over HTTP
// against the routes as registered (plan section 4; H26 and H28):
//
//   - shaped like staging (DEPLOY_ENV=staging, OTOAPP_JOBS=platform): the
//     seed, the production copy and its status, the dev import, the Sentry
//     test and the storage test are refused before they do anything, and the
//     two manual job triggers point at the Console instead of running — and
//     not one row changes;
//   - on a developer's machine (DEPLOY_ENV=local, OTOAPP_JOBS=inprocess): the
//     four maintenance routes refuse an admin the app cannot place in a park
//     group (no branch access, two park groups), and run by one park group's
//     admin they change that park group's rows and none of the other's;
//   - the app's own branch edit cannot write the platform's join column
//     (core_branch_id) or its core_sync_* record;
//   - DELETE /api/users/:id answers the app's own 409 words for a user the
//     platform has linked and for a user the app still references, changing
//     nothing, and still deletes a user nothing points at — and so do the
//     other doors that delete a user: DELETE /api/people/:id, DELETE
//     /api/employees/:id and POST /api/employees/bulk-delete.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/route-fences.check.ts
// The platform's suite runs it the same way against a fresh test database
// when the app's node_modules are present (apps/api/test/s217b-r1.test.ts).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DEACTIVATE_INSTEAD } from "../server/lib/userDeletion";
import { DEV_ROUTE_REFUSAL, JOBS_ON_PLATFORM_REFUSAL, NO_PARK_GROUP_REFUSAL } from "../server/lib/routeFences";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("route-fences.check: DATABASE_URL is not set");
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

// ─── Two park groups ─────────────────────────────────────────────────────────

interface ParkGroup {
  tenant: string;
  branch: string;
  admin: { id: string; email: string };
  pending: string;
  departedUser: string;
  leaving: string;
  photo: string;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  const branch = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ${label} ${run}`, `zz-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [branch, tenant, `ZZ TEST ${label} park ${run}`]);

  const user = async (role: string, email: string) => {
    const id = randomUUID();
    await q(
      `insert into users (id, email, password, full_name, role, is_active, must_change_password)
       values ($1, $2, $3, $4, $5, true, false)`,
      [id, email, hash(PASSWORD), `ZZ TEST ${label} ${role}`, role],
    );
    await q(
      "insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')",
      [tenant, id],
    );
    return id;
  };
  const adminEmail = `zz-${label}-admin-${run}@example.com`;
  const admin = { id: await user("admin", adminEmail), email: adminEmail };

  const employee = async (fields: Record<string, unknown>) => {
    const id = randomUUID();
    const cols = ["id", "tenant_id", "branch_id", "full_name", "nickname", "email", ...Object.keys(fields)];
    const vals = [id, tenant, branch, `ZZ TEST ${label} ${id.slice(0, 4)}`, "ZZ", `zz-${id}@example.com`, ...Object.values(fields)];
    await q(`insert into employees (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
    return id;
  };

  // Pending, with a signed contract: what fix-pending promotes.
  const pending = await employee({ status: "pending" });
  const template = randomUUID();
  await q("insert into templates (id, name, html_body) values ($1, $2, '<p>ZZ</p>')", [template, `ZZ TEST ${label} ${run}`]);
  await q(
    `insert into contract_instances (employee_id, template_id, template_snapshot_html, template_snapshot_version,
       merge_data_json, created_by, signing_status)
     values ($1, $2, '<p>ZZ</p>', 1, '{}'::jsonb, $3, 'signed')`,
    [pending, template, admin.id],
  );
  // Gone since 2020 with a login still on: what the departed deactivation switches off.
  const departedUser = await user("staff", `zz-${label}-departed-${run}@example.com`);
  await employee({ last_working_day: "2020-01-01", user_id: departedUser });
  // LEAVING with the last day long past: what transition-left moves to LEFT.
  const leaving = await employee({ employment_state: "LEAVING", last_working_day: "2020-01-01" });
  // An old-format photo path and no user to take one from: what the backfill clears.
  const photo = await employee({ profile_photo_path: "/profile-photos/zz.jpg" });

  return { tenant, branch, admin, pending, departedUser, leaving, photo };
}

const A = await parkGroup("a");
const B = await parkGroup("b");

/** Every row a fence must leave alone, in one comparable value. */
async function stateOf(g: ParkGroup) {
  const [emp] = await q<{ status: string }>("select status from employees where id = $1", [g.pending]);
  const [dep] = await q<{ is_active: boolean }>("select is_active from users where id = $1", [g.departedUser]);
  const [lea] = await q<{ employment_state: string }>("select employment_state from employees where id = $1", [g.leaving]);
  const [pho] = await q<{ profile_photo_path: string | null }>("select profile_photo_path from employees where id = $1", [g.photo]);
  return {
    pending: emp!.status,
    departedActive: dep!.is_active,
    leaving: lea!.employment_state,
    photo: pho!.profile_photo_path,
  };
}
const untouched = { pending: "pending", departedActive: true, leaving: "LEAVING", photo: "/profile-photos/zz.jpg" };
const userCount = async () => Number((await q<{ n: string }>("select count(*) as n from users"))[0]!.n);

// ─── Users to delete, in park group A ────────────────────────────────────────

async function staffUser(label: string, platformUserId: string | null = null) {
  const id = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, 'staff', true, false, $5)`,
    [id, `zz-del-${label}-${run}@example.com`, hash(PASSWORD), `ZZ TEST delete ${label}`, platformUserId],
  );
  await q(
    "insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')",
    [A.tenant, id, A.branch],
  );
  return id;
}
// An admin the app cannot place: no branch-access row, in a database of two
// park groups. The session still names a park group (the first branch's, by
// `getUserWithBranchAccess`'s fallback); the maintenance routes must not.
const unplaced = { id: randomUUID(), email: `zz-unplaced-admin-${run}@example.com` };
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password)
   values ($1, $2, $3, 'ZZ TEST unplaced admin', 'admin', true, false)`,
  [unplaced.id, unplaced.email, hash(PASSWORD)],
);

const linked = await staffUser("linked", randomUUID());
const referenced = await staffUser("referenced");
await q("insert into user_module_overrides (tenant_id, user_id, module_key) values ($1, $2, 'ops')", [A.tenant, referenced]);
const plain = await staffUser("plain");

// The other doors that delete a user: the people delete and the employee
// deletes take the user matched by email with them.
async function personFor(userId: string) {
  const [{ email }] = await q<{ email: string }>("select email from users where id = $1", [userId]);
  const person = randomUUID();
  await q("insert into people (id, full_name, email, person_type) values ($1, 'ZZ TEST person', $2, 'EMPLOYEE')", [person, email]);
  return { person, email };
}
const linkedByPerson = await staffUser("linked-person", randomUUID());
const linkedPerson = await personFor(linkedByPerson);
const linkedByEmployee = await staffUser("linked-employee", randomUUID());
const linkedEmployeePerson = await personFor(linkedByEmployee);
const linkedEmployee = randomUUID();
await q(
  `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, person_id)
   values ($1, $2, $3, 'ZZ TEST linked employee', 'ZZ', $4, $5)`,
  [linkedEmployee, A.tenant, A.branch, linkedEmployeePerson.email, linkedEmployeePerson.person],
);
const referencedByPerson = await staffUser("referenced-person");
await q("insert into user_module_overrides (tenant_id, user_id, module_key) values ($1, $2, 'ops')", [A.tenant, referencedByPerson]);
const referencedPerson = await personFor(referencedByPerson);
const plainByPerson = await staffUser("plain-person");
const plainPerson = await personFor(plainByPerson);

// ─── The two servers ─────────────────────────────────────────────────────────

const children: ChildProcess[] = [];

async function serve(env: Record<string, string>): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "dev",
      STORAGE_ENV_PREFIX: "zz-test",
      OBJECT_STORAGE: "local",
      OTOAPP_LEGACY_LOGIN: "true",
      LOG_LEVEL: "warn",
      ...env,
    },
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

/** The boot guard refuses a deployment whose DATABASE_URL names localhost; the host is the same database, spelled as a parameter. */
function hostAsParameter(url: string): string {
  const u = new URL(url);
  const host = u.hostname;
  const port = u.port || "5432";
  u.hostname = "";
  u.port = "";
  const params = new URLSearchParams(u.search);
  params.set("host", host);
  params.set("port", port);
  return `${u.protocol}//${u.username}:${u.password}@${u.pathname}?${params}`;
}

const STAGING = {
  DEPLOY_ENV: "staging",
  OTOAPP_JOBS: "platform",
  DATABASE_URL: hostAsParameter(DATABASE_URL),
  SESSION_SECRET: randomBytes(24).toString("hex"),
  SESSION_PEPPER: randomBytes(24).toString("hex"),
  KIOSK_CODE_PEPPER: randomBytes(24).toString("hex"),
  PIN_FINGERPRINT_SECRET: randomBytes(24).toString("hex"),
  OBJECT_STORAGE: "s3",
  S3_BUCKET: "zz-test-bucket",
  S3_ENDPOINT: "zz-test.invalid",
  AWS_ACCESS_KEY_ID: "zz-test",
  AWS_SECRET_ACCESS_KEY: "zz-test",
};
const LOCAL = { DEPLOY_ENV: "local", OTOAPP_JOBS: "inprocess" };

async function signIn(origin: string, email: string): Promise<string> {
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.ok(cookie, "the sign-in set a session cookie");
  return cookie;
}

const call = async (origin: string, method: string, path: string, cookie?: string, payload: unknown = {}) => {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body: body as Record<string, unknown> };
};

let checks = 0;
const check = (name: string, fn: () => void | Promise<void>) => async () => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

try {
  const [staging, local] = await Promise.all([serve(STAGING), serve(LOCAL)]);

  // ── Shaped like staging ────────────────────────────────────────────────────
  console.log("staging-shaped (DEPLOY_ENV=staging, OTOAPP_JOBS=platform):");
  const usersBefore = await userCount();
  for (const [method, path] of [
    ["POST", "/api/seed"],
    ["GET", "/api/test-sentry"],
    ["POST", "/api/dev/import-core-legacy-uploads"],
    ["GET", "/api/test-object-storage"],
    ["POST", "/api/admin/prod-sync"],
    ["GET", "/api/admin/prod-sync/status"],
  ] as const) {
    await check(`${method} ${path} is refused before anything runs`, async () => {
      const res = await call(staging, method, path);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.reason, DEV_ROUTE_REFUSAL.reason);
      assert.equal(res.body.message, DEV_ROUTE_REFUSAL.message);
    })();
  }
  // Signed in too: the fence stands in front of the route's own checks.
  const stagingAdmin = await signIn(staging, A.admin.email);
  await check("the storage test is refused to a signed-in admin as well", async () => {
    const res = await call(staging, "GET", "/api/test-object-storage", stagingAdmin);
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, DEV_ROUTE_REFUSAL.reason);
    assert.ok(!JSON.stringify(res.body).includes("zz-test-bucket"), "the bucket's name is not handed out");
  })();
  for (const path of ["/api/admin/run-departed-deactivation", "/api/scheduler/transition-left"]) {
    await check(`POST ${path} points at the Console under OTOAPP_JOBS=platform`, async () => {
      const res = await call(staging, "POST", path, stagingAdmin);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.reason, JOBS_ON_PLATFORM_REFUSAL.reason);
      assert.match(String(res.body.message), /Run now on the Console's Health page/);
    })();
  }
  await check("not one row changed: users counted, both park groups as they were", async () => {
    assert.equal(await userCount(), usersBefore);
    assert.deepEqual(await stateOf(A), untouched);
    assert.deepEqual(await stateOf(B), untouched);
  })();

  // ── A developer's machine ──────────────────────────────────────────────────
  console.log("local (DEPLOY_ENV=local, OTOAPP_JOBS=inprocess):");
  await check("the Sentry test still throws on a developer's machine (the fence is DEPLOY_ENV's)", async () => {
    const res = await call(local, "GET", "/api/test-sentry");
    assert.equal(res.status, 500);
  })();
  const unplacedAdmin = await signIn(local, unplaced.email);
  for (const path of [
    "/api/admin/fix-pending-with-signed-contracts",
    "/api/admin/backfill-employee-photos",
    "/api/scheduler/transition-left",
    "/api/admin/run-departed-deactivation",
  ]) {
    await check(`POST ${path} refuses an admin the app cannot place in a park group, and changes nobody's rows`, async () => {
      const res = await call(local, "POST", path, unplacedAdmin);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.reason, NO_PARK_GROUP_REFUSAL.reason);
      assert.deepEqual(await stateOf(A), untouched);
      assert.deepEqual(await stateOf(B), untouched);
    })();
  }
  const adminA = await signIn(local, A.admin.email);
  await check("fix-pending promotes park group A's employee and not B's", async () => {
    const res = await call(local, "POST", "/api/admin/fix-pending-with-signed-contracts", adminA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await stateOf(A)).pending, "active");
    assert.equal((await stateOf(B)).pending, "pending");
  })();
  await check("the photo backfill clears park group A's old path and not B's", async () => {
    const res = await call(local, "POST", "/api/admin/backfill-employee-photos", adminA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await stateOf(A)).photo, null);
    assert.equal((await stateOf(B)).photo, "/profile-photos/zz.jpg");
  })();
  await check("transition-left moves park group A's leaver and not B's", async () => {
    const res = await call(local, "POST", "/api/scheduler/transition-left", adminA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await stateOf(A)).leaving, "LEFT");
    assert.equal((await stateOf(B)).leaving, "LEAVING");
  })();
  await check("the departed deactivation switches off park group A's login and not B's", async () => {
    const res = await call(local, "POST", "/api/admin/run-departed-deactivation", adminA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await stateOf(A)).departedActive, false);
    assert.equal((await stateOf(B)).departedActive, true);
  })();

  // ── The app's own branch edit ──────────────────────────────────────────────
  console.log("PATCH /api/branches/:id:");
  const coreColumns = async (id: string) =>
    (
      await q(
        "select core_branch_id, core_sync_status, core_synced_at, core_sync_error, address from branches where id = $1",
        [id],
      )
    )[0];
  await check("a branch edit cannot write the platform's join column or its sync record, and the rest still saves", async () => {
    const res = await call(local, "PATCH", `/api/branches/${A.branch}`, adminA, {
      coreBranchId: randomUUID().toUpperCase(),
      coreSyncStatus: "SUCCESS",
      coreSyncedAt: new Date().toISOString(),
      coreSyncError: "zz",
      address: "ZZ TEST edited",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await coreColumns(A.branch), {
      core_branch_id: null,
      core_sync_status: null,
      core_synced_at: null,
      core_sync_error: null,
      address: "ZZ TEST edited",
    });
  })();
  await check("an edit carrying only the platform's columns changes nothing and answers the branch", async () => {
    const res = await call(local, "PATCH", `/api/branches/${A.branch}`, adminA, { coreBranchId: randomUUID() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.id, A.branch);
    assert.equal((await coreColumns(A.branch))!.core_branch_id, null);
  })();

  // ── Deleting users ─────────────────────────────────────────────────────────
  console.log("DELETE /api/users/:id:");
  const accessRows = async (id: string) =>
    Number((await q<{ n: string }>("select count(*) as n from user_branch_access where user_id = $1", [id]))[0]!.n);
  const exists = async (id: string) => (await q("select 1 from users where id = $1", [id])).length === 1;
  await check("a user the platform has linked is refused in the app's words, and kept", async () => {
    const res = await call(local, "DELETE", `/api/users/${linked}`, adminA);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.message, DEACTIVATE_INSTEAD);
    assert.equal(res.body.reason, "linked_to_platform");
    assert.ok(await exists(linked));
    assert.equal(await accessRows(linked), 1);
  })();
  await check("a user the app still references is refused in the same words, not a bare 500, and kept whole", async () => {
    const res = await call(local, "DELETE", `/api/users/${referenced}`, adminA);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.message, DEACTIVATE_INSTEAD);
    assert.equal(res.body.reason, "still_referenced");
    assert.ok(await exists(referenced));
    assert.equal(await accessRows(referenced), 1, "the branch access was not deleted ahead of the refusal");
  })();
  await check("a user nothing points at is still deleted, with its branch access", async () => {
    const res = await call(local, "DELETE", `/api/users/${plain}`, adminA);
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.ok(!(await exists(plain)));
    assert.equal(await accessRows(plain), 0);
  })();

  // ── The other doors that delete a user ─────────────────────────────────────
  console.log("DELETE /api/people/:id and the employee deletes:");
  const personExists = async (id: string) => (await q("select 1 from people where id = $1", [id])).length === 1;
  const employeeExists = async (id: string) => (await q("select 1 from employees where id = $1", [id])).length === 1;
  await check("the people delete refuses a platform-linked user in the app's words, and keeps the user and the person", async () => {
    const res = await call(local, "DELETE", `/api/people/${linkedPerson.person}`, adminA);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body, { message: DEACTIVATE_INSTEAD, reason: "linked_to_platform" });
    assert.ok(await exists(linkedByPerson));
    assert.equal(await accessRows(linkedByPerson), 1);
    assert.ok(await personExists(linkedPerson.person));
  })();
  await check("the people delete refuses a user the app still references, not a bare 500, and keeps both", async () => {
    const res = await call(local, "DELETE", `/api/people/${referencedPerson.person}`, adminA);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body, { message: DEACTIVATE_INSTEAD, reason: "still_referenced" });
    assert.ok(await exists(referencedByPerson));
    assert.equal(await accessRows(referencedByPerson), 1);
    assert.ok(await personExists(referencedPerson.person));
  })();
  await check("the employee delete refuses an employee whose user the platform has linked, writing nothing", async () => {
    const res = await call(local, "DELETE", `/api/employees/${linkedEmployee}`, adminA);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body, { message: DEACTIVATE_INSTEAD, reason: "linked_to_platform" });
    assert.ok(await exists(linkedByEmployee));
    assert.ok(await personExists(linkedEmployeePerson.person));
    assert.ok(await employeeExists(linkedEmployee));
  })();
  await check("the bulk employee delete reports the same refusal for that employee, writing nothing", async () => {
    const res = await call(local, "POST", "/api/employees/bulk-delete", adminA, { employeeIds: [linkedEmployee] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deletedCount, 0);
    assert.deepEqual(res.body.results, [
      { id: linkedEmployee, status: "error", message: DEACTIVATE_INSTEAD, reason: "linked_to_platform" },
    ]);
    assert.ok(await exists(linkedByEmployee));
    assert.ok(await personExists(linkedEmployeePerson.person));
    assert.ok(await employeeExists(linkedEmployee));
  })();
  await check("the people delete still removes a person and a user nothing points at", async () => {
    const res = await call(local, "DELETE", `/api/people/${plainPerson.person}`, adminA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!(await exists(plainByPerson)));
    assert.equal(await accessRows(plainByPerson), 0);
    assert.ok(!(await personExists(plainPerson.person)));
  })();

  console.log(`route-fences.check: ${checks} checks passed`);
} catch (err) {
  console.error("route-fences.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
