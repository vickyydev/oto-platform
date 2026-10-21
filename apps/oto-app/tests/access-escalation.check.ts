// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-604 — no escalation through the access page or the login dialog, and
// an override never opens an admin-only module, over HTTP against the routes
// as registered:
//
//   1. A manager cannot grant ADMIN on the access page (PUT /api/people/:id/access)
//      nor in the login dialog (POST /api/employees/:id/enable-login); a level
//      the dialog does not offer (GLOBAL_ADMIN) is refused, not lower-cased
//      into a role.
//   2. An operator admin granting ADMIN writes `admin`, never `global_admin`,
//      on both doors; a login above them (global_admin) is not theirs to
//      change, and an operator admin saved as ADMIN keeps their role.
//   3. The honest paths are unchanged: a manager still makes a MANAGER login.
//   4. An override that enables an admin-only module (settings, hr_admin) for
//      staff or a manager opens nothing: POST /api/settings (requireModule)
//      refuses, and /api/permissions/me shows the module closed; an operator
//      admin still passes the module gate.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/access-escalation.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("access-escalation.check: DATABASE_URL is not set");
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

// ─── One park group, one operator, one branch ───────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST esc ${run}`, `zz-esc-${run}`]);
const operator = randomUUID();
await q("insert into operators (id, tenant_id, name) values ($1, $2, $3)", [operator, tenant, `ZZ TEST esc ${run}`]);
const branch = randomUUID();
await q(
  "insert into branches (id, tenant_id, operator_id, name, address, timezone) values ($1, $2, $3, $4, 'ZZ TEST', 'Asia/Bangkok')",
  [branch, tenant, operator, `ZZ TEST esc ${run}`],
);

async function user(role: string, label: string, opts: { operatorId?: string } = {}): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `zz-esc-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, operator_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role, opts.operatorId ?? null],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
    tenant,
    id,
    branch,
  ]);
  return { id, email };
}

/** A person with an employee record, optionally with a login of `role` linked to both. */
async function person(label: string, role: string | null, opts: { operatorId?: string } = {}) {
  const email = `zz-esc-p-${label.toLowerCase()}-${run}@example.com`;
  const personId = randomUUID();
  await q("insert into people (id, tenant_id, full_name, email, person_type) values ($1, $2, $3, $4, 'EMPLOYEE')", [
    personId,
    tenant,
    `ZZ TEST ${label} ${run}`,
    email,
  ]);
  let userId: string | null = null;
  if (role) {
    userId = randomUUID();
    await q(
      `insert into users (id, email, password, full_name, role, is_active, must_change_password, operator_id)
       values ($1, $2, $3, $4, $5, true, false, $6)`,
      [userId, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role, opts.operatorId ?? null],
    );
    await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
      tenant,
      userId,
      branch,
    ]);
  }
  const employeeId = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, person_id, full_name, nickname, email, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'active')`,
    [employeeId, tenant, branch, userId, personId, `ZZ TEST ${label} ${run}`, label, email],
  );
  return { personId, userId, employeeId, email };
}

/** An employee with no person and no login, for the login dialog. */
async function bareEmployee(label: string) {
  const employeeId = randomUUID();
  const email = `zz-esc-e-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status)
     values ($1, $2, $3, $4, $5, $6, 'active')`,
    [employeeId, tenant, branch, `ZZ TEST ${label} ${run}`, label, email],
  );
  return { employeeId, email };
}

const manager = await user("manager", "Manager");
const opAdmin = await user("operator_admin", "OpAdmin", { operatorId: operator });
const staffOverride = await user("staff", "StaffOverride");
const managerOverride = await user("manager", "ManagerOverride");
for (const u of [staffOverride, managerOverride]) {
  for (const moduleKey of ["settings", "hr_admin"]) {
    await q(
      `insert into user_module_overrides (tenant_id, user_id, module_key, enabled, branch_scope_type)
       values ($1, $2, $3, true, 'ALL')`,
      [tenant, u.id, moduleKey],
    );
  }
}

const target = await person("Target", "staff");
const theGm = await person("Gm", "global_admin");
const peerOpAdmin = await person("PeerOp", "operator_admin", { operatorId: operator });
const loginByManagerAdmin = await bareEmployee("MgrAdmin");
const loginByManagerGlobal = await bareEmployee("MgrGlobal");
const loginByManagerManager = await bareEmployee("MgrManager");
const loginByOpAdmin = await bareEmployee("OpAdminLogin");

const roleOf = async (id: string) => (await q<{ role: string }>("select role from users where id = $1", [id]))[0]?.role;
const loginFor = async (email: string) => (await q<{ role: string }>("select role from users where lower(email) = lower($1)", [email]))[0];

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

/** What the Permissions page sends (client/src/pages/permissions-page.tsx). */
const accessBody = (accessLevel: string) => ({
  accessLevel,
  modules: { core: true, hr: true, studio: false, events: false, ops: false, setup: false },
  branchScope: "SELECTED",
  branchIds: [branch],
});
/** What the employee editor's login dialog sends (client/src/pages/employee-editor-page.tsx). */
const loginBody = (email: string, accessLevel: string) => ({
  email,
  password: "zz-temp-pass",
  accessLevel,
  enableCoreModule: true,
  enableHrModule: false,
  enableStudioModule: false,
  enableEventsModule: false,
  enableOpsModule: false,
  enableSetupModule: false,
  branchScope: "SELECTED",
  branchIds: [branch],
});

try {
  ORIGIN = await serve();
  const cookie = {
    manager: await signIn(manager.email),
    opAdmin: await signIn(opAdmin.email),
    staffOverride: await signIn(staffOverride.email),
    managerOverride: await signIn(managerOverride.email),
  };

  // ─── 1. A manager cannot grant ADMIN ──────────────────────────────────────

  await check("a manager cannot grant ADMIN on the access page; the login stays staff", async () => {
    const res = await call("PUT", `/api/people/${target.personId}/access`, { cookie: cookie.manager, body: accessBody("ADMIN") });
    assert.equal(res.status, 403, show(res));
    assert.equal(await roleOf(target.userId!), "staff");
  });

  await check("a manager cannot grant ADMIN in the login dialog; no login is made", async () => {
    const res = await call("POST", `/api/employees/${loginByManagerAdmin.employeeId}/enable-login`, {
      cookie: cookie.manager,
      body: loginBody(loginByManagerAdmin.email, "ADMIN"),
    });
    assert.equal(res.status, 403, show(res));
    assert.equal(await loginFor(loginByManagerAdmin.email), undefined);
  });

  await check("a level the dialog does not offer (GLOBAL_ADMIN) is refused, not written as global_admin", async () => {
    const res = await call("POST", `/api/employees/${loginByManagerGlobal.employeeId}/enable-login`, {
      cookie: cookie.manager,
      body: loginBody(loginByManagerGlobal.email, "GLOBAL_ADMIN"),
    });
    assert.equal(res.status, 400, show(res));
    assert.equal(await loginFor(loginByManagerGlobal.email), undefined);
  });

  // ─── 2. An operator admin's ADMIN is `admin` ──────────────────────────────

  await check("an operator admin granting ADMIN on the access page writes admin, never global_admin", async () => {
    const res = await call("PUT", `/api/people/${target.personId}/access`, { cookie: cookie.opAdmin, body: accessBody("ADMIN") });
    assert.equal(res.status, 200, show(res));
    assert.equal(await roleOf(target.userId!), "admin");
  });

  await check("an operator admin granting ADMIN in the login dialog makes an admin login", async () => {
    const res = await call("POST", `/api/employees/${loginByOpAdmin.employeeId}/enable-login`, {
      cookie: cookie.opAdmin,
      body: loginBody(loginByOpAdmin.email, "ADMIN"),
    });
    assert.equal(res.status, 200, show(res));
    assert.equal((await loginFor(loginByOpAdmin.email))?.role, "admin");
  });

  await check("a global admin's login is not an operator admin's to change", async () => {
    const res = await call("PUT", `/api/people/${theGm.personId}/access`, { cookie: cookie.opAdmin, body: accessBody("STAFF") });
    assert.equal(res.status, 403, show(res));
    assert.equal(await roleOf(theGm.userId!), "global_admin");
    const policy = await q("select 1 from access_policies where person_id = $1", [theGm.personId]);
    assert.equal(policy.length, 0, "the refused save wrote an access policy");
  });

  await check("an operator admin saved as ADMIN keeps operator_admin", async () => {
    const res = await call("PUT", `/api/people/${peerOpAdmin.personId}/access`, { cookie: cookie.opAdmin, body: accessBody("ADMIN") });
    assert.equal(res.status, 200, show(res));
    assert.equal(await roleOf(peerOpAdmin.userId!), "operator_admin");
  });

  await check("and no door wrote global_admin for anyone made here", async () => {
    const rows = await q<{ id: string }>(
      "select id from users where role = 'global_admin' and email like $1 and id <> $2",
      [`zz-esc-%-${run}@example.com`, theGm.userId],
    );
    assert.deepEqual(rows, []);
  });

  // ─── 3. The honest path is unchanged ──────────────────────────────────────

  await check("a manager still makes a MANAGER login in the dialog", async () => {
    const res = await call("POST", `/api/employees/${loginByManagerManager.employeeId}/enable-login`, {
      cookie: cookie.manager,
      body: loginBody(loginByManagerManager.email, "MANAGER"),
    });
    assert.equal(res.status, 200, show(res));
    assert.equal((await loginFor(loginByManagerManager.email))?.role, "manager");
  });

  // ─── 4. Overrides never open an admin-only module ─────────────────────────

  await check("staff with a settings override are refused by the settings module gate", async () => {
    const res = await call("POST", "/api/settings", { cookie: cookie.staffOverride, body: {} });
    assert.equal(res.status, 403, show(res));
    assert.equal(res.body.error, "Module access denied", show(res));
  });

  await check("a manager with a settings override is refused too", async () => {
    const res = await call("POST", "/api/settings", { cookie: cookie.managerOverride, body: {} });
    assert.equal(res.status, 403, show(res));
    assert.equal(res.body.error, "Module access denied", show(res));
  });

  await check("their effective permissions show settings and HR Admin closed", async () => {
    for (const who of ["staffOverride", "managerOverride"] as const) {
      const res = await call("GET", "/api/permissions/me", { cookie: cookie[who] });
      assert.equal(res.status, 200, show(res));
      const modules = res.body.modules as Array<{ moduleKey: string; allowed: boolean }>;
      for (const key of ["settings", "hr_admin"]) {
        assert.equal(modules.find((m) => m.moduleKey === key)?.allowed, false, `${who}: ${key} is open`);
      }
    }
  });

  await check("an operator admin still passes the settings module gate", async () => {
    const res = await call("POST", "/api/settings", { cookie: cookie.opAdmin, body: {} });
    assert.equal(res.status, 400, show(res));
  });

  console.log(`access-escalation.check: ${checks} checks passed`);
} catch (err) {
  console.error("access-escalation.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
