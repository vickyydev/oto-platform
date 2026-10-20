// seed: its own — one park group's worth of ZZ TEST rows, made here (the
// slug-`default` park group only when the database has none). Not a
// Playwright file (the suite collects *.spec.ts and *.test.ts; this is
// neither): it boots the app's real routes and needs a database with the
// otoapp schema migrated.
//
// SCRUM-595 — the leave balance reads keep the original app's branch rule,
// over HTTP against the routes as registered:
//
//   1. Sick-leave balances: a staff member at branch X reading a branch-Y
//      employee's balance is the 403 the other leave doors answer ("Access
//      denied to this employee's branch"); a branch-X employee's is the 200.
//      The branch list (/api/sick-leave-balances?branchId=) is the 403
//      "Access denied - branch not allowed" for Y and the 200 for X.
//   2. An employee with no branch: the balance read
//      (/api/leave-balances/employee/:id) is the 403 for anyone without
//      all-branch access, as is the sick-leave balance.
//   3. A manager with all-branch access reads all of the above (200).
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/leave-balance-reach.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("leave-balance-reach.check: DATABASE_URL is not set");
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

// ─── One park group of our own ───────────────────────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");

const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST lbr ${run}`, `zz-lbr-${run}`]);
const x = randomUUID();
const y = randomUUID();
for (const [id, suffix] of [[x, "x"], [y, "y"]] as const) {
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    id,
    tenant,
    `ZZ TEST lbr ${suffix} ${run}`,
  ]);
}

async function user(role: string, label: string, branch: string | null): Promise<string> {
  const email = `zz-lbr-${label}-${run}@example.com`;
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
  return email;
}

async function employee(branch: string | null, label: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, start_date)
     values ($1, $2, $3, $4, 'ZZ', $5, 'active', '2020-01-01')`,
    [id, tenant, branch, `ZZ TEST ${run} ${label}`, `zz-lbr-${label}-${id.slice(0, 8)}@example.com`],
  );
  return id;
}

const staffX = await user("staff", "staff-x", x);
const managerAll = await user("manager", "manager-all", null);
const empX = await employee(x, "at-x");
const empY = await employee(y, "at-y");
const empNone = await employee(null, "no-branch");

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
  body: unknown;
}

let ORIGIN = "";
async function get(path: string, cookie: string): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, { headers: { cookie } });
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

const EMPLOYEE_BRANCH_DENIED = { message: "Access denied to this employee's branch" };
const BRANCH_DENIED = { message: "Access denied - branch not allowed" };
const DENIED = { message: "Access denied" };

async function refused(path: string, cookie: string, body: unknown) {
  const res = await get(path, cookie);
  assert.equal(res.status, 403, `${path}: ${show(res)}`);
  assert.deepEqual(res.body, body, `${path}: ${show(res)}`);
}
async function allowed(path: string, cookie: string) {
  const res = await get(path, cookie);
  assert.equal(res.status, 200, `${path}: ${show(res)}`);
}

try {
  ORIGIN = await serve();
  const staff = await signIn(staffX);
  const manager = await signIn(managerAll);

  console.log("1. sick-leave balances keep the branch rule:");
  await check("staff at X reading a branch-Y employee's sick balance is the 403 the other leave doors answer", async () => {
    await refused(`/api/employees/${empY}/sick-leave-balance`, staff, EMPLOYEE_BRANCH_DENIED);
  });
  await check("staff at X reading a branch-X employee's sick balance is the 200", async () => {
    await allowed(`/api/employees/${empX}/sick-leave-balance`, staff);
  });
  await check("staff at X listing branch Y's sick balances is the 403; branch X's the 200", async () => {
    await refused(`/api/sick-leave-balances?branchId=${y}`, staff, BRANCH_DENIED);
    await allowed(`/api/sick-leave-balances?branchId=${x}`, staff);
  });

  console.log("2. an employee with no branch:");
  await check("staff reading a no-branch employee's balance is the 403", async () => {
    await refused(`/api/leave-balances/employee/${empNone}`, staff, DENIED);
    await refused(`/api/employees/${empNone}/sick-leave-balance`, staff, EMPLOYEE_BRANCH_DENIED);
  });
  await check("staff reading a branch-X employee's balance is still the 200", async () => {
    await allowed(`/api/leave-balances/employee/${empX}`, staff);
  });

  console.log("3. a manager with all-branch access:");
  await check("reads every one of the above (200)", async () => {
    for (const id of [empX, empY, empNone]) {
      await allowed(`/api/employees/${id}/sick-leave-balance`, manager);
      await allowed(`/api/leave-balances/employee/${id}`, manager);
    }
    await allowed(`/api/sick-leave-balances?branchId=${x}`, manager);
    await allowed(`/api/sick-leave-balances?branchId=${y}`, manager);
  });

  console.log(`leave-balance-reach.check: ${checks} checks passed`);
} catch (err) {
  console.error("leave-balance-reach.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
