// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) twice, and
// needs a database whose otoapp schema the app's migrator has built.
//
// SCRUM-543 over HTTP, on the routes as registered:
//   - with this app's own sign-in closed, every password door — forgot
//     password (staff and advisor), change password, the admin resets and the
//     generated login — refuses with the one launcher message and writes
//     nothing;
//   - with it open, the same doors behave as before (they get past the guard
//     to their own checks, and an employee reset still issues a password);
//   - Create Login links what it makes: the employee and the access policy
//     carry the new login, so Disable Login works straight after, and the
//     employee read says whether the login is on; a global_admin may grant
//     the ADMIN level and all branches.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/legacy-password-doors.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("legacy-password-doors.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const SESSION_SECRET = randomBytes(24).toString("hex");
// The words, pinned: server/middleware/platformSignOn.ts LAUNCHER_PASSWORDS_REFUSAL.
const LAUNCHER_PASSWORDS_REFUSAL = "Passwords are managed on the OTO launcher. Change or recover a password there.";

// ─── Rows ─────────────────────────────────────────────────────────────────────

const tenant = randomUUID();
const branch = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 543 ${run}`, `zz-543-${run}`]);
await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [branch, tenant, `ZZ TEST 543 park ${run}`]);
async function user(role: string) {
  const id = randomUUID();
  const email = `zz-543-${role}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  return { id, email };
}
async function employee(label: string, fields: Record<string, unknown> = {}) {
  const id = randomUUID();
  const cols = ["id", "tenant_id", "branch_id", "full_name", "nickname", "email", "status", ...Object.keys(fields)];
  const vals = [id, tenant, branch, `ZZ TEST 543 ${label}`, "ZZ", `zz-543-${label}-${id.slice(0, 6)}-${run}@example.com`, "active", ...Object.values(fields)];
  await q(`insert into employees (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  return id;
}

const admin = await user("global_admin");
const staff = await user("staff");
const withLogin = await employee("with-login", { user_id: staff.id });
const noLogin = await employee("no-login");
const fresh = await employee("fresh");

// ─── The app, twice: its own form on, and closed ─────────────────────────────

const children: ChildProcess[] = [];
async function serve(env: Record<string, string>): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "dev",
      DEPLOY_ENV: "local",
      OTOAPP_JOBS: "inprocess",
      STORAGE_ENV_PREFIX: "zz-test",
      OBJECT_STORAGE: "local",
      LOG_LEVEL: "warn",
      SESSION_SECRET,
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

const call = async (origin: string, method: string, path: string, cookie: string, payload?: unknown) => {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body };
};

try {
  const legacy = await serve({ OTOAPP_LEGACY_LOGIN: "true" });
  const closed = await serve({ OTOAPP_LEGACY_LOGIN: "false" });

  const login = await fetch(`${legacy}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: admin.email, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `sign-in: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const doors: Array<[string, string, unknown]> = [
    ["/api/auth/forgot-password/request-otp", "", { phone: "0815430001" }],
    ["/api/auth/forgot-password/verify-otp", "", { phone: "0815430001", code: "123456" }],
    ["/api/auth/forgot-password/reset", "", { resetToken: "zz", newPassword: "zz-new-password" }],
    ["/api/auth/advisor/forgot-password/request-otp", "", { phone: "0815430001" }],
    ["/api/auth/advisor/forgot-password/verify-otp", "", { phone: "0815430001", code: "123456" }],
    ["/api/auth/advisor/forgot-password/reset", "", { resetToken: "zz", newPassword: "zz-new-password" }],
    ["/api/change-password", cookie, { currentPassword: PASSWORD, newPassword: "zz-new-password" }],
    [`/api/users/${staff.id}/reset-password`, cookie, { password: "zz-new-password" }],
    [`/api/employees/${withLogin}/reset-password`, cookie, {}],
    [`/api/employees/${noLogin}/generate-login`, cookie, { role: "staff" }],
  ];

  // Closed: one refusal, naming the launcher, and nothing written.
  const before = await q<{ id: string; password: string }>("select id, password from users where id = any($1)", [[admin.id, staff.id]]);
  for (const [path, who, payload] of doors) {
    const res = await call(closed, "POST", path, who, payload);
    assert.equal(res.status, 403, `${path}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { reason: "passwords_on_launcher", message: LAUNCHER_PASSWORDS_REFUSAL }, path);
  }
  assert.deepEqual(await q("select id, password from users where id = any($1)", [[admin.id, staff.id]]), before, "no password changed");
  assert.equal((await q("select user_id from employees where id = $1", [noLogin]))[0]!.user_id, null, "no login generated");

  // Open: the same doors reach their own checks, as before.
  const otp = await call(legacy, "POST", "/api/auth/forgot-password/request-otp", "", { phone: "1" });
  assert.deepEqual([otp.status, otp.body.message], [400, "Invalid phone number format"]);
  const change = await call(legacy, "POST", "/api/change-password", cookie, { currentPassword: "zz-wrong", newPassword: "zz-new-password" });
  assert.deepEqual([change.status, change.body.message], [401, "Current password is incorrect"]);
  const reset = await call(legacy, "POST", `/api/employees/${withLogin}/reset-password`, cookie, {});
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(typeof reset.body.tempPassword, "string");

  // Create Login, by a global_admin, at the ADMIN level across all branches.
  const created = await call(closed, "POST", `/api/employees/${fresh}/enable-login`, cookie, {
    email: `zz-543-made-${run}@example.com`,
    accessLevel: "ADMIN",
    branchScope: "ALL",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const [linked] = await q<{ user_id: string | null; core_user_id: string | null }>(
    "select e.user_id, p.core_user_id from employees e join access_policies p on p.person_id = e.person_id where e.id = $1",
    [fresh],
  );
  assert.deepEqual(linked, { user_id: created.body.userId, core_user_id: created.body.userId }, "the login is linked both ways");
  const again = await call(closed, "POST", `/api/employees/${fresh}/enable-login`, cookie, { email: `zz-543-again-${run}@example.com` });
  assert.equal(again.status, 409, "never a second login over the first");

  // Disable Login straight after, and the read names the state.
  const off = await call(closed, "POST", `/api/employees/${fresh}/toggle-login`, cookie);
  assert.deepEqual([off.status, off.body.isActive], [200, false], JSON.stringify(off.body));
  const read = await call(closed, "GET", `/api/employees/${fresh}`, cookie);
  assert.equal(read.body.loginActive, false);
  const on = await call(closed, "POST", `/api/employees/${fresh}/toggle-login`, cookie);
  assert.equal(on.body.isActive, true);
  assert.equal((await call(closed, "GET", `/api/employees/${noLogin}`, cookie)).body.loginActive, null);

  console.log("legacy-password-doors.check: all checks passed");
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
