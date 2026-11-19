// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-1058 — pay in the activity log. Pay figures are shown only to the
// roles that may see salaries (canViewHrSalary, SCRUM-559); the activity log
// follows the same rule (server/lib/activityPay.ts). Over HTTP against the
// routes as registered, on ZZ TEST rows made here:
//
//   1. Staff and a manager get the log without its salary-change entries, by
//      list and count; an administrator gets them.
//   2. Not by type filter, employee, search or the dashboard summary either.
//   3. Another entry whose metadata carries pay (a contract generated with a
//      salary change) keeps its words and other fields for them, the pay
//      fields taken out; an administrator reads it whole.
//   4. No other door reads the log (no entry by id, no export), and nothing
//      stored is deleted or changed.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/activity-log-pay.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("activity-log-pay.check: DATABASE_URL is not set");
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

// ─── One park group, one branch, the people ──────────────────────────────────

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST s1058 ${run}`, `zz-s1058-${run}`]);
const BRANCH = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
  BRANCH, TENANT, `ZZ TEST s1058 ${run}`,
]);
const DEPARTMENT = randomUUID();
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [DEPARTMENT, TENANT, `ZZ TEST s1058 floor ${run}`]);

async function user(role: string, label: string, branchId: string | null) {
  const id = randomUUID();
  const email = `zz-s1058-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST s1058 ${label} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    TENANT, id, branchId, branchId === null ? "all_branches" : "selected_branches",
  ]);
  return { id, email };
}
const admin = await user("admin", "admin", null);
const manager = await user("manager", "manager", BRANCH);
const staff = await user("staff", "staff", BRANCH);

const EMPLOYEE = randomUUID();
await q(
  `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, employment_state, primary_department_id)
   values ($1, $2, $3, $4, 'zzcurrent', $5, 'active', 'ACTIVE', $6)`,
  [EMPLOYEE, TENANT, BRANCH, `ZZ TEST s1058 current ${run}`, `zz-s1058-emp-${run}@example.com`, DEPARTMENT],
);

// ZZ TEST entries of the kinds that carry pay: a salary change, as the
// employee editor writes it (words and metadata), and a contract generated
// with a salary change among its employee changes; and one plain entry.
const SALARY_ENTRY = randomUUID();
const CONTRACT_ENTRY = randomUUID();
const PLAIN_ENTRY = randomUUID();
await q(
  `insert into activity_log (id, tenant_id, branch_id, employee_id, activity_type, summary_text, metadata_json, created_by)
   values ($1, $2, $3, $4, 'salary_change', $5, $6, $7)`,
  [SALARY_ENTRY, TENANT, BRANCH, EMPLOYEE, "ZZ TEST salary changed from ฿10,000 to ฿11,000", JSON.stringify({ oldValue: 10000, newValue: 11000 }), admin.id],
);
await q(
  `insert into activity_log (id, tenant_id, branch_id, employee_id, activity_type, summary_text, metadata_json, created_by)
   values ($1, $2, $3, $4, 'employee_updated', 'Employee updated during contract generation', $5, $6)`,
  [CONTRACT_ENTRY, TENANT, BRANCH, EMPLOYEE, JSON.stringify({
    source: "contract_generation",
    changes: { defaultMergeData: { old: { salaryThb: 10000, positionTitle: "ZZ TEST A" }, new: { salaryThb: 11000, positionTitle: "ZZ TEST B" } } },
  }), admin.id],
);
await q(
  `insert into activity_log (id, tenant_id, branch_id, employee_id, activity_type, summary_text, metadata_json, created_by)
   values ($1, $2, $3, $4, 'employee_updated', 'ZZ TEST nickname changed', $5, $6)`,
  [PLAIN_ENTRY, TENANT, BRANCH, EMPLOYEE, JSON.stringify({ field: "nickname" }), admin.id],
);

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
async function call(origin: string, path: string, cookie: string): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, { headers: { cookie } });
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
  const stored = async () => q<{ id: string; activity_type: string; summary_text: string; metadata_json: string | null }>(
    "select id, activity_type, summary_text, metadata_json from activity_log where tenant_id = $1 order by id", [TENANT]);
  const asStaff = await signIn(origin, staff.email);
  const asManager = await signIn(origin, manager.email);
  const asAdmin = await signIn(origin, admin.email);
  const before = await stored();
  assert.equal(before.length, 3, "the three ZZ TEST entries");
  const PAY_TYPES = ["salary_change"];
  const logs = async (cookie: string, query: string) => {
    const res = await call(origin, `/api/activity-logs?limit=500${query}`, cookie);
    assert.equal(res.status, 200, show(res));
    return res.body as { logs: { id: string; activityType: string; summaryText: string; metadataJson: string | null }[]; totalCount: number };
  };
  const payFree = (text: string) => assert.doesNotMatch(text, /10,000|11,000|10000|11000|salaryThb/, text);
  const readers: [string, string][] = [["staff", asStaff], ["a manager", asManager]];

  console.log("activity log pay (SCRUM-1058):");
  await check("staff and a manager get the log without its salary changes, the count too; an administrator gets them", async () => {
    const all = await logs(asAdmin, `&branchId=${BRANCH}`);
    assert.deepEqual(all.logs.map((l) => l.id).sort(), [SALARY_ENTRY, CONTRACT_ENTRY, PLAIN_ENTRY].sort(), "the administrator reads all three");
    assert.equal(all.totalCount, 3);
    for (const [who, cookie] of readers) {
      const theirs = await logs(cookie, `&branchId=${BRANCH}`);
      assert.deepEqual(theirs.logs.filter((l) => PAY_TYPES.includes(l.activityType)), [], who);
      assert.deepEqual(theirs.logs.map((l) => l.id).sort(), [CONTRACT_ENTRY, PLAIN_ENTRY].sort(), `${who}: the rest unchanged`);
      assert.equal(theirs.totalCount, 2, who);
      payFree(JSON.stringify(theirs));
      const unscoped = await logs(cookie, "");
      assert.ok(!unscoped.logs.some((l) => l.id === SALARY_ENTRY), `${who}: no branch named`);
      payFree(JSON.stringify(unscoped));
    }
  });
  await check("not by type filter, employee, search or the dashboard summary either", async () => {
    for (const [who, cookie] of readers) {
      for (const query of [
        "&types=salary_change", `&types=salary_change&branchId=${BRANCH}`, "&types=salary_change,employee_updated",
        `&employeeId=${EMPLOYEE}&types=salary_change`, `&employeeId=${EMPLOYEE}`,
        "&search=salary", "&search=" + encodeURIComponent("฿"), "&search=11",
      ]) {
        const res = await logs(cookie, query);
        assert.deepEqual(res.logs.filter((l) => PAY_TYPES.includes(l.activityType)), [], `${who} ${query}`);
        if (query.endsWith("types=salary_change") || query.includes("types=salary_change&")) {
          assert.deepEqual([res.logs.length, res.totalCount], [0, 0], `${who} ${query}`);
        }
        payFree(JSON.stringify(res));
      }
      const summary = await call(origin, `/api/activity-logs/summary?branchId=${BRANCH}&sinceDays=30`, cookie);
      assert.equal(summary.status, 200, `${who}: ${show(summary)}`);
      assert.equal(summary.body.salary_change, 0, `${who}: ${show(summary)}`);
    }
    const adminSummary = await call(origin, `/api/activity-logs/summary?branchId=${BRANCH}&sinceDays=30`, asAdmin);
    assert.deepEqual([adminSummary.status, adminSummary.body.salary_change], [200, 1], show(adminSummary));
    const adminFiltered = await logs(asAdmin, `&types=salary_change&branchId=${BRANCH}`);
    assert.deepEqual(adminFiltered.logs.map((l) => [l.id, l.summaryText]), [[SALARY_ENTRY, "ZZ TEST salary changed from ฿10,000 to ฿11,000"]]);
  });
  await check("another entry's pay fields are taken out of its metadata for them; the entry and its other fields stay", async () => {
    for (const [who, cookie] of readers) {
      const entry = (await logs(cookie, `&employeeId=${EMPLOYEE}`)).logs.find((l) => l.id === CONTRACT_ENTRY);
      assert.ok(entry, who);
      assert.equal(entry!.summaryText, "Employee updated during contract generation");
      assert.deepEqual(JSON.parse(entry!.metadataJson!), {
        source: "contract_generation",
        changes: { defaultMergeData: { old: { positionTitle: "ZZ TEST A" }, new: { positionTitle: "ZZ TEST B" } } },
      }, who);
      const plain = (await logs(cookie, `&employeeId=${EMPLOYEE}`)).logs.find((l) => l.id === PLAIN_ENTRY);
      assert.deepEqual(JSON.parse(plain!.metadataJson!), { field: "nickname" }, `${who}: an entry with no pay is as stored`);
    }
    const whole = (await logs(asAdmin, `&employeeId=${EMPLOYEE}`)).logs.find((l) => l.id === CONTRACT_ENTRY);
    assert.equal(JSON.parse(whole!.metadataJson!).changes.defaultMergeData.new.salaryThb, 11000);
  });
  await check("no other door reads the log: no entry by id, no export; the stored entries are unchanged", async () => {
    const byId = await call(origin, `/api/activity-logs/${SALARY_ENTRY}`, asStaff);
    assert.notEqual(byId.status, 200, show(byId));
    payFree(JSON.stringify(byId.body));
    const routes = readFileSync(join(APP_DIR, "server", "routes.ts"), "utf8");
    const doors = Array.from(routes.matchAll(/app\.(get|post|put|patch|delete)\("(\/api\/activity-log[^"]*)"/g)).map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(doors, ["get /api/activity-logs", "get /api/activity-logs/summary", "post /api/activity-logs/backfill-departures"], "a new door on the log takes the same rule");
    assert.deepEqual(await stored(), before, "nothing stored is deleted or changed");
  });

  console.log(`activity-log-pay.check: ${checks} checks passed`);
} catch (err) {
  console.error("activity-log-pay.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
