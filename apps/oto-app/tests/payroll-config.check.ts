// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) once, and
// needs a database whose otoapp schema the app's migrator has built.
//
// SCRUM-567, the company payroll's R2 (plan §9 R2), over HTTP on the routes as
// registered:
//   - two park groups keep separate configuration: entities, accounts, branch
//     details, rule sets, deduction lists, welfare fund settings, streams and
//     profiles of one are never listed for the other;
//   - no route reaches across: every id of the other park group answers 404
//     (or a refusal naming the field), and writes nothing;
//   - every route refuses manager and staff (403), writes refuse anyone below
//     admin, and the HR-data draft action is global_admin's alone;
//   - the Thai company-v1 rule set is seeded once per park group, idempotently,
//     and the old engine's doors never see it; no welfare fund setting is
//     seeded and its start date is required configuration; Malaysia refused;
//   - a draft profile from HR data carries no pay: salary, day rate, food,
//     bank and advances stay empty until a payroll role saves the profile,
//     which marks it reviewed; a stale revision is refused; the prototype's
//     checks refuse an invalid profile; the setup audit is append-only;
//   - an employee with a payroll profile is not deleted (a payroll record).
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/payroll-config.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("payroll-config.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const SESSION_SECRET = randomBytes(24).toString("hex");
const SALARY = 31_567;

const roles = ["global_admin", "admin", "operator_admin", "manager", "staff"] as const;
type Role = typeof roles[number];
interface Group { label: string; tenant: string; branch: string; accounts: Record<Role, { id: string; email: string }>; worker: string; partTimer: string; cookies: Record<Role, string> }

async function group(label: string): Promise<Group> {
  const tenant = randomUUID();
  const branch = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 567 ${label} ${run}`, `zz-567-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [branch, tenant, `ZZ TEST 567 ${label} park ${run}`]);
  const accounts = {} as Group["accounts"];
  for (const role of roles) {
    const id = randomUUID();
    const email = `zz-567-${label}-${role}-${id.slice(0, 6)}-${run}@example.com`;
    await q(`insert into users (id, email, password, full_name, role, is_active, must_change_password)
             values ($1, $2, $3, $4, $5, true, false)`, [id, email, hash(PASSWORD), `ZZ TEST ${label} ${role}`, role]);
    await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
    accounts[role] = { id, email };
  }
  const employee = async (name: string, basis: "FULL_TIME" | "PART_TIME") => {
    const id = randomUUID();
    await q(`insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, employment_basis,
               default_merge_data, food_allowance_per_day, daily_rate, tax_id_number, sso_number, start_date)
             values ($1, $2, $3, $4, 'ZZ', $5, 'active', $6, $7, 60, 900, '1234567890123', '1234567890', '2026-01-05')`,
    [id, tenant, branch, `ZZ TEST 567 ${label} ${name}`, `zz-567-${label}-${name}-${id.slice(0, 6)}-${run}@example.com`, basis,
      JSON.stringify({ positionTitle: "ZZ TEST Receptionist", salaryThb: SALARY, startDate: "2026-01-05" })]);
    return id;
  };
  const worker = await employee("worker", "FULL_TIME");
  const partTimer = await employee("parttimer", "PART_TIME");
  return { label, tenant, branch, accounts, worker, partTimer, cookies: {} as Group["cookies"] };
}

const A = await group("a");
const B = await group("b");
// An old advance and an old payroll profile for A's worker: proposals only, never copied.
const operatorA = (await q<{ id: string }>("insert into operators (tenant_id, name) values ($1, 'ZZ TEST 567 operator') returning id", [A.tenant]))[0]!.id;
await q(`insert into employee_payroll_profiles (tenant_id, operator_id, employee_id, base_salary_monthly, bank_name, bank_account_number, bank_account_name)
         values ($1, $2, $3, 30000, 'ZZ Bank', '111-2-33333-4', 'ZZ TEST worker')`, [A.tenant, operatorA, A.worker]);
await q(`insert into salary_advances (tenant_id, operator_id, employee_id, principal_amount, issued_date, repayment_type, remaining_balance)
         values ($1, $2, $3, 5000, '2026-09-01', 'FIXED_AMOUNT', 4000)`, [A.tenant, operatorA, A.worker]);

const children: ChildProcess[] = [];
async function serve(env: Record<string, string>): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env, NODE_ENV: "test", APP_ENV: "dev", DEPLOY_ENV: "local", OTOAPP_JOBS: "inprocess",
      STORAGE_ENV_PREFIX: "zz-test", OBJECT_STORAGE: "local", LOG_LEVEL: "warn", SESSION_SECRET, ...env,
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
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`harness exited ${code}:\n${output}`)); });
  });
}

try {
  const origin = await serve({ OTOAPP_LEGACY_LOGIN: "true" });
  for (const g of [A, B]) {
    for (const role of roles) {
      const login = await fetch(`${origin}/api/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: g.accounts[role].email, password: PASSWORD }),
      });
      assert.equal(login.status, 200, `${g.label} ${role} sign-in: ${login.status}`);
      g.cookies[role] = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    }
  }
  const call = async (g: Group, role: Role, method: string, path: string, payload?: unknown) => {
    const res = await fetch(`${origin}${path}`, {
      method, headers: { "content-type": "application/json", cookie: g.cookies[role] },
      body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
    });
    const text = await res.text();
    let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
    try { body = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body };
  };
  let passed = 0;
  const reason = "ZZ TEST SCRUM-567";

  // ── The Thai rule set: seeded once per park group, never seen by the old doors ──
  assert.equal(await count("select count(*) n from statutory_rule_sets where tenant_id = $1", [A.tenant]), 0, "a park group made after 0021 has none yet");
  const setupA = await call(A, "admin", "GET", "/api/payroll/setup");
  assert.equal(setupA.status, 200, JSON.stringify(setupA.body));
  assert.equal(setupA.body.ruleSets.length, 1, "the first read seeds the Thai rule set");
  const thai = setupA.body.ruleSets[0];
  assert.deepEqual([thai.country, thai.branchId, thai.effectiveFrom, thai.rules.thSso.wageCap, thai.rules.thSso.employeeRate], ["TH", null, "2025-01", 17500, 0.05]);
  assert.deepEqual(thai.rules.overtimeMultipliers, { regular: 1.5, restDay: 2, publicHoliday: 3 });
  assert.equal(thai.rules.thPit.brackets.length, 8);
  assert.deepEqual(thai.rules.allowances, [], "no demonstration allowance is seeded");
  assert.ok(!("Casual" in thai.rules.lunchByRole) && !("Casual" in thai.rules.overtimeEligibilityByRole) && thai.rules.serviceCharge.includeCasuals === false, "no casual path in the seeded rules");
  assert.equal(setupA.body.canManage, true);
  passed += 3;
  for (let i = 0; i < 2; i++) await call(A, "admin", "GET", "/api/payroll/setup");
  assert.equal((await q<{ made: number }>("select seed_tenant_payroll_rule_sets($1) as made", [A.tenant]))[0]!.made, 0, "seeding again makes nothing");
  assert.equal(await count("select count(*) n from statutory_rule_sets where tenant_id = $1 and rule_format = 'company-v1'", [A.tenant]), 1, "one row however often it runs");
  assert.equal(await count("select count(*) n from statutory_rule_sets where tenant_id = $1", [B.tenant]), 0, "B is not seeded by A's read");
  passed += 3;
  const oldList = await call(A, "admin", "GET", "/api/payroll/statutory-rule-sets");
  assert.equal(oldList.status, 200);
  assert.ok(oldList.body.every((r: { ruleFormat?: string; id: string }) => r.id !== thai.id), "the old door does not list the company-v1 row");
  const oldOne = await call(A, "admin", "GET", `/api/payroll/statutory-rule-sets/${thai.id}`);
  assert.equal(oldOne.status, 404, "nor find it");
  const oldDelete = await call(A, "global_admin", "DELETE", `/api/payroll/statutory-rule-sets/${thai.id}`);
  assert.equal(oldDelete.status, 404, "nor delete it");
  const oldCreate = await call(A, "admin", "POST", "/api/payroll/statutory-rule-sets", {
    countryCode: "TH", name: "ZZ TEST legacy", effectiveFrom: "2099-01-01", rules: {}, ruleFormat: "company-v1",
  });
  if (oldCreate.status === 201) {
    assert.equal((await q<{ rule_format: string }>("select rule_format from statutory_rule_sets where id = $1", [oldCreate.body.id]))[0]!.rule_format, "legacy-v1", "the old door writes legacy-v1 whatever it is sent");
    await q("delete from statutory_rule_sets where id = $1", [oldCreate.body.id]);
  }
  assert.equal(await count("select count(*) n from payroll_ewf_settings_versions where tenant_id in ($1, $2)", [A.tenant, B.tenant]), 0, "no welfare fund setting is seeded");
  passed += 5;

  // ── Every route: manager and staff refused; writes refused below admin ──
  const fake = randomUUID();
  const routes: [string, string, "read" | "write" | "draft"][] = [
    ["GET", "/api/payroll/setup", "read"], ["GET", "/api/payroll/setup/changes", "read"],
    ["POST", "/api/payroll/setup/entities", "write"], ["PATCH", `/api/payroll/setup/entities/${fake}`, "write"],
    ["POST", `/api/payroll/setup/entities/${fake}/archive`, "write"], ["POST", "/api/payroll/setup/accounts", "write"],
    ["PATCH", `/api/payroll/setup/accounts/${fake}`, "write"], ["POST", `/api/payroll/setup/accounts/${fake}/archive`, "write"],
    ["POST", `/api/payroll/setup/branches/${A.branch}/details`, "write"], ["POST", "/api/payroll/setup/rule-sets", "write"],
    ["POST", "/api/payroll/setup/deduction-lists", "write"], ["POST", "/api/payroll/setup/ewf-settings", "write"],
    ["PUT", "/api/payroll/setup/ewf-remittances", "write"], ["POST", "/api/payroll/setup/revenue-streams", "write"],
    ["PATCH", `/api/payroll/setup/revenue-streams/${fake}`, "write"], ["GET", "/api/payroll/profiles", "read"],
    ["POST", "/api/payroll/profiles/drafts", "draft"], ["GET", `/api/payroll/profiles/${A.worker}`, "read"],
    ["PUT", `/api/payroll/profiles/${A.worker}`, "write"],
  ];
  const before = await count("select count(*) n from payroll_profile_changes where tenant_id = $1", [A.tenant]);
  for (const [method, path, kind] of routes) {
    for (const role of ["manager", "staff"] as const) {
      const res = await call(A, role, method, path, { reason });
      assert.equal(res.status, 403, `${role} ${method} ${path}: ${res.status}`);
      assert.ok(!JSON.stringify(res.body).includes(String(SALARY)), `${role} ${method} ${path}: no pay in the refusal`);
      passed++;
    }
    if (kind === "draft") {
      for (const role of ["admin", "operator_admin"] as const) {
        assert.equal((await call(A, role, method, path, { reason })).status, 403, `${role} drafts: refused (global_admin's)`);
        passed++;
      }
    }
    const anon = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    assert.equal(anon.status, 401, `anonymous ${method} ${path}`);
    passed++;
  }
  assert.equal(await count("select count(*) n from payroll_profile_changes where tenant_id = $1", [A.tenant]), before, "no refused call wrote anything");
  for (const role of ["global_admin", "admin", "operator_admin"] as const) {
    assert.equal((await call(A, role, "GET", "/api/payroll/profiles")).status, 200, `${role} reads the roster`);
    passed++;
  }

  // ── Separate configuration per park group ──
  const entityFor = async (g: Group, role: Role, name: string) => {
    const res = await call(g, role, "POST", "/api/payroll/setup/entities", { name, country: "TH", taxId: "0105555555555", reason });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as { id: string };
  };
  const entityA = await entityFor(A, "admin", "ZZ TEST A Co., Ltd.");
  const entityB = await entityFor(B, "operator_admin", "ZZ TEST B Co., Ltd.");
  const accountA = await call(A, "admin", "POST", "/api/payroll/setup/accounts", {
    entityId: entityA.id, label: "ZZ TEST SCB", bank: "SCB", bankCode: "014", accountNumber: "123-4-56789-0", accountName: "ZZ TEST A", fileFormat: "SCB", scbProduct: "PAY", reason,
  });
  assert.equal(accountA.status, 201, JSON.stringify(accountA.body));
  const details = (entity: string, account?: string) => ({
    effectiveFrom: "2025-01-01", foodAllowanceDefault: 60, reason,
    details: { country: "TH", payingEntityId: entity, defaultPayingAccountId: account, ssoBranchNumber: "000001", payDate: 28, legalEntity: "ZZ TEST", employerNumber: "", taxId: "", address: "", payrollBank: "SCB" },
  });
  const detailsA = await call(A, "admin", "POST", `/api/payroll/setup/branches/${A.branch}/details`, details(entityA.id, accountA.body.id));
  assert.equal(detailsA.status, 200, JSON.stringify(detailsA.body));
  assert.equal((await call(B, "admin", "POST", `/api/payroll/setup/branches/${B.branch}/details`, details(entityB.id))).status, 200);
  const viewA = (await call(A, "admin", "GET", "/api/payroll/setup")).body;
  const viewB = (await call(B, "admin", "GET", "/api/payroll/setup")).body;
  assert.deepEqual(viewA.entities.map((e: { id: string }) => e.id), [entityA.id]);
  assert.deepEqual(viewB.entities.map((e: { id: string }) => e.id), [entityB.id]);
  assert.deepEqual(viewB.accounts, [], "B lists none of A's accounts");
  assert.deepEqual(viewA.branches.map((b: { id: string }) => b.id), [A.branch]);
  assert.equal(viewB.ruleSets.length, 1, "B's own rule set");
  assert.notEqual(viewB.ruleSets[0].id, viewA.ruleSets[0].id);
  passed += 6;

  // ── No cross-park-group reach ──
  const across: [string, string, unknown][] = [
    ["PATCH", `/api/payroll/setup/entities/${entityA.id}`, { name: "ZZ hijack", reason }],
    ["POST", `/api/payroll/setup/entities/${entityA.id}/archive`, { reason }],
    ["PATCH", `/api/payroll/setup/accounts/${accountA.body.id}`, { label: "ZZ hijack", reason }],
    ["POST", `/api/payroll/setup/accounts/${accountA.body.id}/archive`, { reason }],
    ["POST", "/api/payroll/setup/accounts", { entityId: entityA.id, label: "x", bank: "x", accountNumber: "1", accountName: "x", fileFormat: "GENERIC", reason }],
    ["POST", `/api/payroll/setup/branches/${A.branch}/details`, details(entityB.id)],
    ["POST", `/api/payroll/setup/branches/${B.branch}/details`, details(entityA.id)],
    ["POST", "/api/payroll/setup/rule-sets", { country: "TH", branchId: A.branch, effectiveFrom: "2026-11", rules: thai.rules, reason }],
    ["POST", "/api/payroll/setup/deduction-lists", { scope: "branch", branchId: A.branch, effectiveFrom: "2026-11-01", rules: [], reason }],
    ["POST", "/api/payroll/setup/ewf-settings", { entityId: entityA.id, effectiveFrom: "2026-11-01", settings: { employeeRate: 0.0025, employerRate: 0.0025, headcountThreshold: 10, providentFundAvailable: false, voluntaryBelowThreshold: false }, reason }],
    ["PUT", "/api/payroll/setup/ewf-remittances", { entityId: entityA.id, month: "2026-10", amountPaid: 1, reason }],
    ["GET", `/api/payroll/profiles/${A.worker}`, undefined],
    ["PUT", `/api/payroll/profiles/${A.worker}`, { profile: {}, revision: 0, reason }],
  ];
  const aWrites = await count("select count(*) n from payroll_profile_changes where tenant_id = $1", [A.tenant]);
  for (const [method, path, payload] of across) {
    const res = await call(B, "global_admin", method, path, payload);
    assert.equal(res.status, 404, `B ${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    passed++;
  }
  const streamA = await call(A, "admin", "POST", "/api/payroll/setup/revenue-streams", { key: "tickets", label: "Tickets", reason });
  assert.equal(streamA.status, 201);
  assert.equal((await call(B, "admin", "PATCH", `/api/payroll/setup/revenue-streams/${streamA.body.id}`, { label: "x", reason })).status, 404);
  assert.equal((await call(B, "admin", "POST", "/api/payroll/setup/revenue-streams", { key: "tickets", label: "B tickets", reason })).status, 201, "B keeps its own catalogue");
  assert.equal(await count("select count(*) n from payroll_profile_changes where tenant_id = $1", [A.tenant]), aWrites + 1, "B wrote nothing of A's");
  assert.deepEqual((await q<{ name: string }>("select name from payroll_paying_entities where id = $1", [entityA.id]))[0], { name: "ZZ TEST A Co., Ltd." });
  passed += 4;

  // ── Malaysia dormant; the welfare fund date is configuration ──
  assert.equal((await call(A, "admin", "POST", "/api/payroll/setup/entities", { name: "ZZ MY", country: "MY", reason })).status, 400, "Malaysia refused");
  const noDate = await call(A, "admin", "POST", "/api/payroll/setup/ewf-settings", { entityId: entityA.id, settings: { employeeRate: 0.0025, employerRate: 0.0025, headcountThreshold: 10, providentFundAvailable: false, voluntaryBelowThreshold: false }, reason });
  assert.equal(noDate.status, 400, "no start date, no settings");
  const ewf = await call(A, "admin", "POST", "/api/payroll/setup/ewf-settings", { entityId: entityA.id, effectiveFrom: "2026-11-01", settings: { employeeRate: 0.0025, employerRate: 0.0025, headcountThreshold: 10, providentFundAvailable: false, voluntaryBelowThreshold: false }, reason });
  assert.equal(ewf.status, 200, JSON.stringify(ewf.body));
  const noReason = await call(A, "admin", "POST", "/api/payroll/setup/rule-sets", { country: "TH", effectiveFrom: "2026-11", rules: thai.rules });
  assert.equal(noReason.status, 400, "a reason is required");
  const ruleSet = await call(A, "admin", "POST", "/api/payroll/setup/rule-sets", { country: "TH", effectiveFrom: "2026-11", rules: { ...thai.rules, thSso: { ...thai.rules.thSso, wageCap: 17500 } }, reason });
  assert.equal(ruleSet.status, 200, JSON.stringify(ruleSet.body));
  const deductions = await call(A, "operator_admin", "POST", "/api/payroll/setup/deduction-lists", { scope: "company", effectiveFrom: "2026-11-01", rules: [{ id: "late", name: "Late arrival", enabled: true, issue: "late", freeOccurrences: 3, freeMinutes: 30, method: "fixed", amount: 100, source: "service-charge", cap: 1000, roles: [], jobTitles: ["ZZ TEST Receptionist"], includeStaffIds: [], excludeStaffIds: [] }], reason });
  assert.equal(deductions.status, 200, JSON.stringify(deductions.body));
  passed += 6;

  // ── Drafts carry no pay; a payroll role's save does ──
  const drafted = await call(A, "global_admin", "POST", "/api/payroll/profiles/drafts", { reason });
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  assert.equal(drafted.body.created, 2);
  const draftRow = (await q<Record<string, string | boolean | number>>("select * from payroll_profiles where tenant_id = $1 and employee_id = $2", [A.tenant, A.worker]))[0]!;
  assert.deepEqual([draftRow.monthly_salary, draftRow.day_rate, draftRow.fixed_fee, draftRow.food_allowance_per_day, draftRow.bank_account_number, draftRow.review_state, draftRow.revision],
    ["0.00", "0.00", "0.00", "0.00", "", "needs-review", 0], "the draft copied no pay");
  assert.equal(draftRow.job_title, "ZZ TEST Receptionist", "identity is proposed");
  assert.equal(await count("select count(*) n from payroll_profile_advances where tenant_id = $1", [A.tenant]), 0, "no advance copied");
  const partRow = (await q<{ worker_type: string; sso_eligible: boolean }>("select worker_type, sso_eligible from payroll_profiles where tenant_id = $1 and employee_id = $2", [A.tenant, A.partTimer]))[0]!;
  assert.deepEqual(partRow, { worker_type: "day-rate", sso_eligible: false }, "part-time proposes a day-rate profile with its flags");
  assert.equal((await call(A, "global_admin", "POST", "/api/payroll/profiles/drafts", { reason })).body.created, 0, "drafting again makes nothing");
  assert.equal(await count("select count(*) n from payroll_profiles where tenant_id = $1", [B.tenant]), 0, "A's drafts are A's");
  passed += 6;

  const opened = await call(A, "admin", "GET", `/api/payroll/profiles/${A.worker}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.reviewState, "needs-review");
  assert.equal(opened.body.profile.monthlySalary, 0);
  const salarySuggestion = opened.body.suggestions.find((s: { field: string; source: string }) => s.field === "monthlySalary" && s.source === "HR contract salary");
  assert.equal(salarySuggestion?.value, SALARY, "the salary is offered as a suggestion");
  assert.ok(opened.body.suggestions.some((s: { field: string; value: number }) => s.field === "advance" && s.value === 4000), "the old advance is offered");
  assert.ok(opened.body.validationErrors.includes("Transfer bank, account number and account name are required."), "the prototype's checks show what is missing");
  passed += 4;

  const profile = {
    ...opened.body.profile, monthlySalary: SALARY,
    bankDetails: { bank: "ZZ Bank", accountNumber: "111-2-33333-4", accountName: "ZZ TEST worker" },
    advances: [{ id: "adv-new", principal: 5000, outstandingBalance: 4000, repaymentMode: "instalments", instalments: 4, monthlyRepayment: 1000, startsOn: "2026-11-01" }],
  };
  const invalid = await call(A, "admin", "PUT", `/api/payroll/profiles/${A.worker}`, {
    profile: { ...profile, allocations: [{ ...profile.allocations[0], lines: [{ ...profile.allocations[0].lines[0], percent: 90 }] }] }, revision: 0, reason,
  });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.body.errors.some((e: string) => e.includes("must total 100%")), JSON.stringify(invalid.body));
  const crossBranch = await call(A, "admin", "PUT", `/api/payroll/profiles/${A.worker}`, {
    profile: { ...profile, allocations: [{ ...profile.allocations[0], homeBranchId: B.branch }] }, revision: 0, reason,
  });
  assert.equal(crossBranch.status, 400, "another park group's branch is not a cost centre here");
  const managerSave = await call(A, "manager", "PUT", `/api/payroll/profiles/${A.worker}`, { profile, revision: 0, reason });
  assert.equal(managerSave.status, 403);
  assert.equal((await q<{ monthly_salary: string }>("select monthly_salary from payroll_profiles where tenant_id = $1 and employee_id = $2", [A.tenant, A.worker]))[0]!.monthly_salary, "0.00", "still no pay after refusals");
  const saved = await call(A, "admin", "PUT", `/api/payroll/profiles/${A.worker}`, { profile, revision: 0, reason });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.revision, saved.body.reviewState, saved.body.profile.monthlySalary], [1, "reviewed", SALARY]);
  const advanceId = saved.body.profile.advances[0].id as string;
  assert.match(advanceId, /^[0-9a-f-]{36}$/);
  const stale = await call(A, "operator_admin", "PUT", `/api/payroll/profiles/${A.worker}`, { profile, revision: 0, reason });
  assert.equal(stale.status, 409, "a stale revision is refused");
  const again = await call(A, "operator_admin", "PUT", `/api/payroll/profiles/${A.worker}`, { profile: { ...saved.body.profile, notes: "ZZ" }, revision: 1, reason });
  assert.equal(again.status, 200);
  assert.equal(again.body.profile.advances[0].id, advanceId, "an advance keeps its id across saves");
  const reopened = (await call(A, "admin", "GET", `/api/payroll/profiles/${A.worker}`)).body;
  assert.deepEqual(reopened.suggestions, [], "a reviewed profile shows no proposals");
  assert.deepEqual(reopened.changes.map((c: { kind: string }) => c.kind), ["profile", "profile", "profile-draft"]);
  passed += 10;

  const roster = (await call(A, "admin", "GET", "/api/payroll/profiles?asOf=2026-11-15")).body;
  const workerRow = roster.rows.find((r: { employeeId: string }) => r.employeeId === A.worker);
  assert.equal(workerRow.reviewState, "reviewed");
  assert.equal(workerRow.allocationBadge, `ZZ TEST 567 a park ${run} 100%`);
  assert.equal(roster.canDraft, false, "admin sees no draft action");
  assert.equal((await call(A, "global_admin", "GET", "/api/payroll/profiles")).body.canDraft, true);
  passed += 4;

  // ── Append-only audit; payroll kept on employee delete ──
  await assert.rejects(q("update payroll_profile_changes set reason = 'x' where tenant_id = $1", [A.tenant]), /append-only/);
  await assert.rejects(q("delete from payroll_profile_changes where tenant_id = $1", [A.tenant]), /append-only/);
  const del = await call(A, "admin", "DELETE", `/api/employees/${A.worker}`);
  assert.equal(del.status, 409, JSON.stringify(del.body));
  assert.match(del.body.message, /payroll record/);
  assert.equal(await count("select count(*) n from employees where id = $1", [A.worker]), 1);
  passed += 4;

  console.log(`payroll-config.check: ${passed} checks passed`);
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
