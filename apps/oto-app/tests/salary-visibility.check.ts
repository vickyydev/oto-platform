// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) once, and
// needs a database whose otoapp schema the app's migrator has built.
//
// SCRUM-559 over HTTP, on the routes as registered: an employee's pay is a
// payroll role's.
//   - admin, global_admin and operator_admin read it on the employee list
//     (both shapes), the employee, the change history and the probation
//     review; manager and staff read the same records with every pay key
//     gone and the note of a pay change dropped;
//   - below a payroll role an edit or a new employee carrying a pay field is
//     refused (403) and writes nothing, while an edit without one saves and
//     leaves the stored pay as it was;
//   - salary and incentive changes are refused below a payroll role, on
//     record and on contract-status update, and a pay value riding on another
//     kind of change is not recorded.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/salary-visibility.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("salary-visibility.check: DATABASE_URL is not set");
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
const SALARY = 31_559;
const INCENTIVE = `ZZ TEST incentive ${run}: 2% of sales`;

// ─── Rows ─────────────────────────────────────────────────────────────────────

const tenant = randomUUID();
const branch = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 559 ${run}`, `zz-559-${run}`]);
await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [branch, tenant, `ZZ TEST 559 park ${run}`]);

async function user(role: string) {
  const id = randomUUID();
  const email = `zz-559-${role}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  return { id, email };
}

async function employee(label: string) {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status,
       default_merge_data, incentive_clause_text, food_allowance_per_day, daily_rate)
     values ($1, $2, $3, $4, 'ZZ', $5, 'active', $6, $7, 60, 900)`,
    [
      id, tenant, branch, `ZZ TEST 559 ${label}`, `zz-559-${label}-${id.slice(0, 6)}-${run}@example.com`,
      JSON.stringify({ positionTitle: "ZZ TEST Receptionist", salaryThb: SALARY, startDate: "2026-01-05", incentiveClause: INCENTIVE }),
      INCENTIVE,
    ],
  );
  return id;
}

const roles = ["global_admin", "admin", "operator_admin", "manager", "staff"] as const;
type Role = typeof roles[number];
const accounts = {} as Record<Role, { id: string; email: string }>;
for (const role of roles) accounts[role] = await user(role);
const PAYROLL: Role[] = ["global_admin", "admin", "operator_admin"];

const worker = await employee("worker");
const salaryChange = randomUUID();
const titleChange = randomUUID();
await q(
  `insert into employee_changes (id, employee_id, change_type, effective_date, old_salary, new_salary, note, created_by)
   values ($1, $2, 'salary_adjustment', now(), 28000, $3, 'ZZ TEST raised to 31559', $4)`,
  [salaryChange, worker, SALARY, accounts.admin.id],
);
await q(
  `insert into employee_changes (id, employee_id, change_type, effective_date, old_title, new_title, old_salary, new_salary, note, created_by)
   values ($1, $2, 'title_change', now(), 'ZZ TEST Trainee', 'ZZ TEST Receptionist', $3, $3, 'ZZ TEST promoted', $4)`,
  [titleChange, worker, SALARY, accounts.admin.id],
);

// ─── The app ─────────────────────────────────────────────────────────────────

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

/** Every key the redaction withholds that these rows carry, wherever it sits. */
const PAY_KEYS = ["salaryThb", "incentiveClause", "incentiveClauseText", "foodAllowancePerDay", "dailyRate", "oldSalary", "newSalary", "oldIncentiveClause", "newIncentiveClause"];
function payKeysIn(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => payKeysIn(item, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    [...(PAY_KEYS.includes(key) ? [`${path}.${key}`] : []), ...payKeysIn(item, `${path}.${key}`)]);
}
/** The amount as a JSON number, or inside a string, anywhere in the answer. */
const mentionsSalary = (value: unknown) => new RegExp(`(^|[^0-9a-f-])${SALARY}([^0-9a-f-]|$)`).test(JSON.stringify(value));

try {
  const origin = await serve({ OTOAPP_LEGACY_LOGIN: "true" });
  const cookies = {} as Record<Role, string>;
  for (const role of roles) {
    const login = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: accounts[role].email, password: PASSWORD }),
    });
    assert.equal(login.status, 200, `${role} sign-in: ${login.status}`);
    cookies[role] = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  const call = async (role: Role, method: string, path: string, payload?: unknown) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json", cookie: cookies[role] },
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
  const stored = async () => (await q<{ default_merge_data: Record<string, unknown>; incentive_clause_text: string | null; food_allowance_per_day: number | null; daily_rate: number | null }>(
    "select default_merge_data, incentive_clause_text, food_allowance_per_day, daily_rate from employees where id = $1", [worker]))[0]!;
  let passed = 0;

  // ── Reads: list (plain and with a branch), the employee, change history ──
  const reads = [
    "/api/employees",
    `/api/employees?branchId=${branch}`,
    `/api/employees?branchId=${branch}&schedulingWeekStart=2026-10-19`,
    `/api/employees/${worker}`,
  ];
  for (const role of roles) {
    for (const path of reads) {
      const res = await call(role, "GET", path);
      assert.equal(res.status, 200, `${role} GET ${path}: ${res.status} ${JSON.stringify(res.body)}`);
      const row = Array.isArray(res.body) ? res.body.find((e: { id: string }) => e.id === worker) : res.body;
      assert.ok(row, `${role} GET ${path}: the employee is listed`);
      assert.equal(row.defaultMergeData?.positionTitle, "ZZ TEST Receptionist", `${role} ${path}: ordinary HR fields stay`);
      if (PAYROLL.includes(role)) {
        assert.equal(row.defaultMergeData.salaryThb, SALARY, `${role} ${path}: sees salary`);
        assert.deepEqual([row.incentiveClauseText, row.foodAllowancePerDay, row.dailyRate], [INCENTIVE, 60, 900], `${role} ${path}: sees pay`);
      } else {
        assert.deepEqual(payKeysIn(res.body), [], `${role} ${path}: no pay key anywhere`);
        assert.ok(!mentionsSalary(res.body), `${role} ${path}: the amount appears nowhere`);
      }
      passed++;
    }
    const history = await call(role, "GET", `/api/employees/${worker}/changes`);
    assert.equal(history.status, 200);
    const salaryRow = history.body.find((c: { id: string }) => c.id === salaryChange);
    const titleRow = history.body.find((c: { id: string }) => c.id === titleChange);
    if (PAYROLL.includes(role)) {
      assert.deepEqual([salaryRow.newSalary, salaryRow.note], [SALARY, "ZZ TEST raised to 31559"], `${role}: full history`);
    } else {
      assert.deepEqual(payKeysIn(history.body), [], `${role}: no pay key in history`);
      assert.equal(salaryRow.note, undefined, `${role}: a pay change's note is dropped`);
      assert.equal(titleRow.note, "ZZ TEST promoted", `${role}: other notes stay`);
      assert.equal(titleRow.newTitle, "ZZ TEST Receptionist");
    }
    passed++;
  }

  // ── Edits below a payroll role ──
  const before = await stored();
  for (const role of ["manager"] as const) {
    for (const body of [
      { defaultMergeData: { positionTitle: "ZZ TEST Receptionist", salaryThb: 99_999, startDate: "2026-01-05" } },
      { dailyRate: 1 },
      { incentiveClauseText: null },
      { foodAllowancePerDay: null },
    ]) {
      const res = await call(role, "PATCH", `/api/employees/${worker}`, body);
      assert.equal(res.status, 403, `${role} PATCH ${JSON.stringify(body)}: ${res.status}`);
      assert.match(res.body.message, /hr\.view_salary/);
      passed++;
    }
  }
  assert.deepEqual(await stored(), before, "a refused edit writes nothing");

  // The form a manager is shown has no pay: it saves, and the pay stays.
  const ordinary = await call("manager", "PATCH", `/api/employees/${worker}`, {
    nickname: "ZZ-559",
    defaultMergeData: { positionTitle: "ZZ TEST Senior Receptionist", startDate: "2026-01-05" },
  });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  assert.deepEqual(payKeysIn(ordinary.body), [], "the saved answer is withheld too");
  const afterOrdinary = await stored();
  assert.equal(afterOrdinary.default_merge_data.positionTitle, "ZZ TEST Senior Receptionist");
  assert.equal(afterOrdinary.default_merge_data.salaryThb, SALARY, "a redacted save never wipes stored salary");
  assert.equal(afterOrdinary.default_merge_data.incentiveClause, INCENTIVE, "nor the merge-data incentive");
  assert.deepEqual([afterOrdinary.incentive_clause_text, afterOrdinary.food_allowance_per_day, afterOrdinary.daily_rate], [INCENTIVE, 60, 900]);
  passed++;

  // An admin's save without the pay keys keeps them too; with one, it changes.
  const adminTitle = await call("admin", "PATCH", `/api/employees/${worker}`, {
    defaultMergeData: { positionTitle: "ZZ TEST Supervisor", startDate: "2026-01-05" },
  });
  assert.equal(adminTitle.status, 200);
  assert.equal(adminTitle.body.defaultMergeData.salaryThb, SALARY);
  const adminPay = await call("operator_admin", "PATCH", `/api/employees/${worker}`, {
    defaultMergeData: { positionTitle: "ZZ TEST Supervisor", startDate: "2026-01-05", salaryThb: SALARY + 1 },
  });
  assert.equal(adminPay.status, 200, JSON.stringify(adminPay.body));
  assert.equal((await stored()).default_merge_data.salaryThb, SALARY + 1, "a payroll role changes pay");
  await q("update employees set default_merge_data = jsonb_set(default_merge_data, '{salaryThb}', $2::jsonb) where id = $1", [worker, String(SALARY)]);
  passed += 2;

  // A new employee: pay refused from a manager, accepted from an admin.
  const newEmployee = (label: string, pay: boolean) => ({
    fullName: `ZZ TEST 559 new ${label}`,
    nickname: "ZZ",
    email: `zz-559-new-${label}-${run}@example.com`,
    branchId: branch,
    defaultMergeData: { positionTitle: "ZZ TEST Runner", startDate: "2026-02-01", ...(pay ? { salaryThb: 20_000 } : {}) },
  });
  const refusedNew = await call("manager", "POST", "/api/employees", newEmployee("refused", true));
  assert.equal(refusedNew.status, 403, JSON.stringify(refusedNew.body));
  assert.equal((await q("select 1 from employees where email = $1", [`zz-559-new-refused-${run}@example.com`])).length, 0);
  const managerNew = await call("manager", "POST", "/api/employees", newEmployee("manager", false));
  assert.equal(managerNew.status, 201, JSON.stringify(managerNew.body));
  const adminNew = await call("admin", "POST", "/api/employees", newEmployee("admin", true));
  assert.equal(adminNew.status, 201, JSON.stringify(adminNew.body));
  assert.equal(adminNew.body.defaultMergeData.salaryThb, 20_000);
  passed += 3;

  // ── Employment-term changes (server/employee-action-routes.ts) ──
  const countChanges = async () => Number((await q<{ n: string }>("select count(*) n from employee_changes where employee_id = $1", [worker]))[0]!.n);
  const changesBefore = await countChanges();
  for (const body of [
    { changeType: "salary_adjustment", effectiveDate: "2026-11-01", newSalary: 99_999 },
    { changeType: "incentive_change", effectiveDate: "2026-11-01", newIncentiveClause: "ZZ TEST everything" },
  ]) {
    const res = await call("manager", "POST", `/api/employees/${worker}/changes`, body);
    assert.equal(res.status, 403, `manager ${body.changeType}: ${res.status} ${JSON.stringify(res.body)}`);
    passed++;
  }
  assert.equal(await countChanges(), changesBefore, "a refused pay change records nothing");
  assert.equal((await stored()).default_merge_data.salaryThb, SALARY);

  // A title change from a manager carrying a pay value: recorded without it.
  const title = await call("manager", "POST", `/api/employees/${worker}/changes`, {
    changeType: "title_change", effectiveDate: "2026-11-01", newTitle: "ZZ TEST Lead", newSalary: 77_777,
  });
  assert.equal(title.status, 201, JSON.stringify(title.body));
  assert.deepEqual(payKeysIn(title.body), [], "the recorded change comes back withheld");
  const [recorded] = await q<{ new_salary: number | null }>("select new_salary from employee_changes where id = $1", [title.body.id]);
  assert.equal(recorded!.new_salary, SALARY, "the manager's pay value was not recorded");
  passed++;

  // The admin's salary change works and comes back whole.
  const raise = await call("admin", "POST", `/api/employees/${worker}/changes`, {
    changeType: "salary_adjustment", effectiveDate: "2026-11-01", newSalary: SALARY + 2, note: "ZZ TEST raise",
  });
  assert.equal(raise.status, 201, JSON.stringify(raise.body));
  assert.deepEqual([raise.body.newSalary, raise.body.note], [SALARY + 2, "ZZ TEST raise"]);
  passed++;

  // Contract status on a pay change: refused below; a title change answers withheld.
  const statusOnPay = await call("manager", "PATCH", `/api/employees/${worker}/changes/${salaryChange}`, { contractGenerated: true });
  assert.equal(statusOnPay.status, 403, JSON.stringify(statusOnPay.body));
  assert.equal((await q<{ contract_generated: boolean }>("select contract_generated from employee_changes where id = $1", [salaryChange]))[0]!.contract_generated, false);
  const statusOnTitle = await call("manager", "PATCH", `/api/employees/${worker}/changes/${titleChange}`, { contractGenerated: true });
  assert.equal(statusOnTitle.status, 200, JSON.stringify(statusOnTitle.body));
  assert.deepEqual(payKeysIn(statusOnTitle.body), []);
  const statusByAdmin = await call("admin", "PATCH", `/api/employees/${worker}/changes/${salaryChange}`, { contractGenerated: true });
  assert.equal(statusByAdmin.status, 200);
  assert.equal(statusByAdmin.body.newSalary, SALARY);
  passed += 3;

  // The probation review answers with the employee: withheld below, whole above.
  const review = await call("manager", "POST", `/api/employees/${worker}/complete-probation-review`, {});
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.deepEqual(payKeysIn(review.body), [], "the review's employee is withheld");
  assert.ok(!mentionsSalary(review.body));
  const adminReview = await call("admin", "POST", `/api/employees/${worker}/complete-probation-review`, {});
  assert.equal(adminReview.status, 200);
  assert.equal(adminReview.body.defaultMergeData.salaryThb, SALARY + 2);
  passed += 2;

  console.log(`salary-visibility.check: ${passed} checks passed`);
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
