// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-1036 — the employee order's server half, over HTTP against the routes
// as registered (the owner's answer of 19 November 2026: "the drag saves the
// order shown; a new employee takes a place at the end"):
//
//   1. A new employee made through POST /api/employees takes the place after
//      the last of the park group, so it shows at the end of its department.
//   2. POST /api/employees/reorder saves the places it is sent, in order; a
//      repeated, empty or non-string id is refused with 400 and nothing moves;
//      a long list is not refused for its length.
//   3. Another park group's employee named in a reorder keeps its place.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/employee-order-http.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("employee-order-http.check: DATABASE_URL is not set");
  process.exit(2);
}

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

// ─── Two park groups, one department each, a manager ──────────────────────────

async function parkGroup(label: string) {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST s1036 ${label} ${run}`, `zz-s1036-${label}-${run}`]);
  const branch = randomUUID();
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    branch, tenant, `ZZ TEST s1036 ${label} ${run}`,
  ]);
  const department = randomUUID();
  await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [department, tenant, `ZZ TEST s1036 floor ${label} ${run}`]);
  return { tenant, branch, department };
}
const PARK = await parkGroup("one");
const OTHER = await parkGroup("two");

const managerEmail = `zz-s1036-manager-${run}@example.com`;
const MANAGER = randomUUID();
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password)
   values ($1, $2, $3, $4, 'manager', true, false)`,
  [MANAGER, managerEmail, hash(PASSWORD), `ZZ TEST s1036 manager ${run}`],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
  PARK.tenant, MANAGER, PARK.branch,
]);

async function employee(at: { tenant: string; branch: string; department: string }, label: string, place: number): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, employment_state,
                            primary_department_id, display_order)
     values ($1, $2, $3, $4, $5, $6, 'active', 'ACTIVE', $7, $8)`,
    [id, at.tenant, at.branch, `ZZ TEST s1036 ${label} ${run}`, `zz${label}`, `zz-s1036-${label}-${run}@example.com`, at.department, place],
  );
  return id;
}
// Places as a park group has them after some drags: 0, 1 and a high one left by
// an earlier department's drag.
const first = await employee(PARK, "first", 0);
const second = await employee(PARK, "second", 1);
const third = await employee(PARK, "third", 7);
const outsider = await employee(OTHER, "outsider", 42);

const placeOf = async (id: string) => Number((await q<{ display_order: number }>("select display_order from employees where id = $1", [id]))[0]!.display_order);

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
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
async function call(origin: string, method: string, path: string, cookie: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, {
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
async function signIn(origin: string, email: string): Promise<string> {
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in ${email}: ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

try {
  const origin = await serve();
  const asManager = await signIn(origin, managerEmail);

  console.log("1. a new employee takes a place at the end:");
  let made = "";
  await check("made through POST /api/employees, the new employee's place is after the last of the park group", async () => {
    const res = await call(origin, "POST", "/api/employees", asManager, {
      fullName: `ZZ TEST s1036 new ${run}`,
      nickname: "zznew",
      email: `zz-s1036-new-${run}@example.com`,
      branchId: PARK.branch,
      primaryDepartmentId: PARK.department,
    });
    assert.equal(res.status, 201, show(res));
    made = res.body.id;
    assert.equal(await placeOf(made), 8, "one after the park group's last place (7), not 0");
    assert.equal(await placeOf(outsider), 42, "another park group's places are not read or moved");
  });

  console.log("2. the reorder endpoint:");
  await check("a repeated, an empty or a non-string id is refused with 400, and nothing moves", async () => {
    for (const orderedIds of [[second, first, second], [first, ""], [first, 7], "not-a-list"]) {
      const res = await call(origin, "POST", "/api/employees/reorder", asManager, { orderedIds });
      assert.equal(res.status, 400, `${JSON.stringify(orderedIds)}: ${show(res)}`);
      assert.equal(res.body.message, "orderedIds must be an array of distinct employee ids");
    }
    assert.deepEqual([await placeOf(first), await placeOf(second), await placeOf(third), await placeOf(made)], [0, 1, 7, 8]);
  });
  await check("the order sent is saved, place by place; another park group's employee keeps its place", async () => {
    const res = await call(origin, "POST", "/api/employees/reorder", asManager, { orderedIds: [made, third, first, outsider, second] });
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([await placeOf(made), await placeOf(third), await placeOf(first), await placeOf(second)], [0, 1, 2, 4]);
    assert.equal(await placeOf(outsider), 42);
  });
  await check("a long list is not refused for its length (no cap of its own); ids that name nobody move nothing", async () => {
    // 2,001 ids: one more than the cap a first draft of this repair had.
    const orderedIds = [first, ...Array.from({ length: 2000 }, () => randomUUID())];
    const res = await call(origin, "POST", "/api/employees/reorder", asManager, { orderedIds });
    assert.equal(res.status, 200, show(res));
    assert.equal(await placeOf(first), 0);
    assert.equal(await placeOf(made), 0, "the others keep the places the last reorder gave them");
  });

  console.log(`employee-order-http.check: ${checks} checks passed`);
} catch (err) {
  console.error("employee-order-http.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
