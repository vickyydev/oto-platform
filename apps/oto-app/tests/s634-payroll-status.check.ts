// Real app HTTP/DB checks. All rows are ZZ TEST fixtures in the caller's
// migrated disposable database. No platform, SMS, payment or payroll action
// is called. Mapped-session fixtures start with a real local sign-in; the
// existing handoff suite owns issuance, while these requests exercise the
// registered salary, current-identity, raw-advisor and park-group guards.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("s634-payroll-status requires a migrated disposable database");
const appDir = fileURLToPath(new URL("../", import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=otoapp", max: 3 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => (await pool.query<T>(text, values)).rows;
const run = randomBytes(5).toString("hex"), password = randomBytes(24).toString("base64url"), salt = randomBytes(16).toString("hex");
const passwordHash = `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
const MONTH = "2026-11", PREVIOUS_MONTH = "2026-10";
const groups: Array<{ tenant: string; branch: string; operator: string }> = [];
const cookies: string[] = [];
const cases: Record<string, { passed: boolean; statuses: number[] }> = {};
let child: ChildProcess | undefined, origin = "", active = "";

async function group(label: string) {
  const value = { tenant: randomUUID(), branch: randomUUID(), operator: randomUUID() };
  await q("insert into tenants(id,name,slug) values($1,$2,$3)", [value.tenant, `ZZ TEST 634 ${label}`, `zz-634-${label}-${run}`]);
  await q("insert into operators(id,tenant_id,name,status,platform_roles_enabled) values($1,$2,$3,'active',true)", [value.operator, value.tenant, `ZZ TEST 634 ${label}`]);
  await q("insert into branches(id,tenant_id,operator_id,name,address) values($1,$2,$3,$4,'ZZ TEST')", [value.branch, value.tenant, value.operator, `ZZ TEST 634 ${label}`]);
  groups.push(value); return value;
}
type Group = Awaited<ReturnType<typeof group>>;
async function user(g: Group, label: string, role: string, mapped = false, access = true) {
  const id = randomUUID(), account = randomUUID(), email = `zz-634-${label}-${id}-${run}@example.invalid`;
  await q(`insert into users(id,email,password,full_name,role,is_active,must_change_password,operator_id,platform_user_id)
    values($1,$2,$3,$4,$5,true,false,$6,$7)`, [id, email, passwordHash, `ZZ TEST 634 ${label}`, role, mapped ? g.operator : null, mapped ? account : null]);
  if (access) await q("insert into user_branch_access(tenant_id,user_id,branch_id,access_scope) values($1,$2,$3,'selected_branches')", [g.tenant, id, g.branch]);
  if (role === "advisor") {
    const person = randomUUID();
    await q("insert into people(id,tenant_id,full_name,email,person_type) values($1,$2,'ZZ TEST 634 advisor',$3,'ADVISOR')", [person, g.tenant, email]);
    await q(`insert into access_policies(tenant_id,person_id,access_level,modules,branch_scope,branch_ids,core_user_id)
      values($1,$2,'ADMIN','{"core":true,"hr":true,"setup":true}'::jsonb,'SELECTED',$3::jsonb,$4)`, [g.tenant, person, JSON.stringify([g.branch]), id]);
  }
  return { ...g, id, account, email };
}
type Actor = Awaited<ReturnType<typeof user>>;
async function entity(g: Group, label: string, archived = false) {
  const id = randomUUID(), name = `ZZ TEST 634 ${label}`;
  await q(`insert into payroll_paying_entities(id,tenant_id,name,country,archived_at)
    values($1,$2,$3,'TH',case when $4::boolean then now() else null end)`, [id, g.tenant, name, archived]);
  return { id, name };
}
async function payrollRun(g: Group, entityId: string, status: string, month = MONTH) {
  const id = randomUUID();
  await q("insert into payroll_month_runs(id,tenant_id,entity_id,month,current_version,pay_date) values($1,$2,$3,$4,2,$5)", [id, g.tenant, entityId, month, `${month}-28`]);
  await q(`insert into payroll_run_versions(tenant_id,run_id,version,status,stage)
    values($1,$2,1,'superseded','outputs'),($1,$2,2,$3,'attendance')`, [g.tenant, id, status]);
  return id;
}
async function serve() {
  child = spawn(process.execPath, [join(appDir, "node_modules/tsx/dist/cli.mjs"), "tests/harness/serve-routes.ts"], {
    cwd: appDir, env: { ...process.env, NODE_ENV: "test", APP_ENV: "dev", DEPLOY_ENV: "local", OBJECT_STORAGE: "local", STORAGE_ENV_PREFIX: "zz-634",
      OTOAPP_JOBS: "platform", OTOAPP_LEGACY_LOGIN: "true", PLATFORM_API_URL: "", OTOAPP_PUBLIC_ORIGIN: "", OTOAPP_PROVISION_KEY: "",
      SESSION_SECRET: randomBytes(32).toString("hex"), SESSION_PEPPER: randomBytes(32).toString("hex"), LOG_LEVEL: "warn", HARNESS_FAKE_NOW: "2026-10-31T18:30:00.000Z" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = child;
  return new Promise<string>((resolve, reject) => {
    let tail = "";
    const timer = setTimeout(() => reject(new Error("Native app harness start timed out")), 90_000);
    const read = (part: Buffer) => { tail = (tail + part.toString()).slice(-1024); const match = /HARNESS_PORT=(\d+)/.exec(tail);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } };
    server.stdout!.on("data", read); server.stderr!.on("data", read);
    server.on("error", () => { clearTimeout(timer); reject(new Error("Native app harness failed")); });
    server.on("exit", () => { clearTimeout(timer); reject(new Error("Native app harness stopped")); });
  });
}
async function signIn(who: Actor, mapping?: { role: "admin" | "manager" | "staff"; salary: boolean }) {
  const response = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: who.email, password }), redirect: "error" });
  assert.equal(response.status, 200, "Synthetic local sign-in succeeds");
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); assert.equal(cookie.length > 0, true); cookies.push(cookie);
  if (mapping) {
    const context = { accountId: who.account, otoApp: { platformRolesEnabled: true, userId: who.id, operatorId: who.operator, tenantId: who.tenant,
      role: mapping.role, permissions: { "hr:salary:view": mapping.salary } } };
    const rows = await q(`update session set sess=(sess::jsonb || jsonb_build_object('platform',$2::jsonb))::json
      where sess::jsonb #>> '{passport,user}'=$1 returning sid`, [who.id, JSON.stringify(context)]);
    assert.equal(rows.length, 1, "Exactly the proof-owned signed-in session receives its mapped context");
  }
  return cookie;
}
async function get(cookie = "") {
  const response = await fetch(origin + "/api/payroll/month-status", { headers: cookie ? { cookie } : {}, redirect: "error" });
  if (active) cases[active].statuses.push(response.status);
  const text = await response.text(); let body: unknown = null; try { body = JSON.parse(text); } catch { /* Missing route remains a meaningful HTTP404. */ }
  return { status: response.status, body, headers: response.headers };
}
type StatusBody = { month: string; entities: Array<{ id: string; name: string; version: number | null; status: string }> };
function statusBody(value: unknown): StatusBody {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true);
  const result = value as StatusBody;
  assert.deepEqual(Object.keys(result).sort(), ["entities", "month"]);
  assert.equal(result.month, MONTH, "Month comes from the server's Bangkok payroll calendar, not its UTC month");
  assert.equal(Array.isArray(result.entities), true);
  for (const row of result.entities) assert.deepEqual(Object.keys(row).sort(), ["id", "name", "status", "version"]);
  return result;
}
async function check(name: string, action: () => Promise<void>) {
  active = name; cases[name] = { passed: false, statuses: [] };
  try { await action(); cases[name].passed = true; } catch { /* Persist safe outcomes only; never an auth/body assertion diff. */ }
  finally { active = ""; }
}
async function payrollSnapshot() {
  const tables = await q<{ table_name: string }>(`select table_name from information_schema.tables where table_schema='otoapp' and table_type='BASE TABLE'
    and (table_name like 'payroll_%' or table_name='statutory_rule_sets') order by table_name`);
  const rows: unknown[] = [];
  for (const { table_name: table } of tables) {
    assert.equal(/^[a-z_]+$/.test(table), true);
    rows.push({ table, rows: await q(`select to_jsonb(t) as row from otoapp."${table}" t order by to_jsonb(t)::text`) });
  }
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

try {
  const A = await group("own"), B = await group("foreign"), empty = await group("empty");
  const admin = await user(A, "legacy-admin", "admin"), foreign = await user(B, "foreign-admin", "admin"), emptyAdmin = await user(empty, "empty-admin", "admin");
  const manager = await user(A, "legacy-manager", "manager"), staff = await user(A, "legacy-staff", "staff"), unplaced = await user(A, "unplaced-admin", "admin", false, false);
  const mappedAdmin = await user(A, "mapped-admin-denied", "admin", true), mappedManager = await user(A, "mapped-manager-allowed", "manager", true);
  const advisor = await user(A, "mapped-advisor", "advisor", true);
  const expected = new Map<string, { id: string; name: string; version: number | null; status: string }>();
  for (const status of ["draft", "gm-confirmed", "locked", "paid", "superseded"]) {
    const value = await entity(A, status); await payrollRun(A, value.id, status); expected.set(value.id, { ...value, version: 2, status });
  }
  const noRun = await entity(A, "not-started"), previous = await entity(A, "previous-month-only"), archived = await entity(A, "archived", true), foreignEntity = await entity(B, "foreign");
  expected.set(noRun.id, { ...noRun, version: null, status: "not-started" }); expected.set(previous.id, { ...previous, version: null, status: "not-started" });
  await payrollRun(A, previous.id, "paid", PREVIOUS_MONTH); await payrollRun(A, archived.id, "paid"); await payrollRun(B, foreignEntity.id, "paid");
  const crossRunEntity = await entity(A, "foreign-run-reference"), crossVersionEntity = await entity(A, "foreign-version-reference");
  expected.set(crossRunEntity.id, { ...crossRunEntity, version: null, status: "not-started" });
  expected.set(crossVersionEntity.id, { ...crossVersionEntity, version: 2, status: "draft" });
  const ownRun = await payrollRun(A, crossVersionEntity.id, "draft");
  // Simulate historical corrupt soft references in this disposable database.
  // The replication setting is LOCAL to this one fixture transaction; no
  // constraint or trigger definition is removed or changed.
  const fixture = await pool.connect();
  try {
    await fixture.query("begin"); await fixture.query("set local session_replication_role='replica'");
    const badRun = randomUUID();
    await fixture.query("insert into payroll_month_runs(id,tenant_id,entity_id,month,current_version,pay_date) values($1,$2,$3,$4,1,$5)", [badRun, B.tenant, crossRunEntity.id, MONTH, `${MONTH}-28`]);
    await fixture.query("insert into payroll_run_versions(tenant_id,run_id,version,status) values($1,$2,1,'paid'),($1,$3,2,'paid')", [B.tenant, badRun, ownRun]);
    await fixture.query("commit");
  } catch (error) { await fixture.query("rollback"); throw error; } finally { fixture.release(); }
  origin = await serve();
  const adminCookie = await signIn(admin), foreignCookie = await signIn(foreign), emptyCookie = await signIn(emptyAdmin);
  const managerCookie = await signIn(manager), staffCookie = await signIn(staff), unplacedCookie = await signIn(unplaced);
  const deniedCookie = await signIn(mappedAdmin, { role: "admin", salary: false }), allowedCookie = await signIn(mappedManager, { role: "manager", salary: true });
  const advisorCookie = await signIn(advisor, { role: "admin", salary: true });

  await check("current Bangkok month preserves all five current statuses and exposes only four safe entity fields", async () => {
    const response = await get(adminCookie); assert.equal(response.status, 200); const body = statusBody(response.body);
    assert.deepEqual(body.entities.map(row => row.id).sort(), [...expected.keys()].sort());
    for (const row of body.entities) assert.deepEqual(row, expected.get(row.id));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  });
  await check("no run or previous-month-only run remains not-started; archived and foreign entities are absent", async () => {
    const response = await get(adminCookie); assert.equal(response.status, 200); const body = statusBody(response.body);
    for (const id of [noRun.id, previous.id]) assert.deepEqual(body.entities.find(row => row.id === id), expected.get(id));
    assert.equal(body.entities.some(row => row.id === archived.id || row.id === foreignEntity.id), false);
  });
  await check("tenant equality fences both entity-to-run and run-to-current-version soft references", async () => {
    const response = await get(adminCookie); assert.equal(response.status, 200); const body = statusBody(response.body);
    for (const id of [crossRunEntity.id, crossVersionEntity.id]) assert.deepEqual(body.entities.filter(row => row.id === id), [expected.get(id)]);
    const other = await get(foreignCookie); assert.equal(other.status, 200); assert.deepEqual(statusBody(other.body).entities, [{ ...foreignEntity, version: 2, status: "paid" }]);
  });
  await check("empty own company list is ready and empty without creating a payroll run or default rules", async () => {
    const before = await payrollSnapshot(), response = await get(emptyCookie); assert.equal(response.status, 200);
    assert.deepEqual(statusBody(response.body).entities, []); assert.equal(await payrollSnapshot(), before);
  });
  await check("repeated status reads never seed, calculate, audit, modify or disclose payroll financial data", async () => {
    const before = await payrollSnapshot();
    for (let repeat = 0; repeat < 2; repeat++) { const response = await get(adminCookie); assert.equal(response.status, 200); statusBody(response.body); }
    assert.equal(await payrollSnapshot(), before);
  });
  await check("anonymous and legacy manager/staff callers retain existing payroll refusals", async () => {
    assert.equal((await get()).status, 401); assert.equal((await get(managerCookie)).status, 403); assert.equal((await get(staffCookie)).status, 403);
  });
  await check("mapped salary visibility allows manager claim but denies admin claim without falling back to role", async () => {
    assert.equal((await get(deniedCookie)).status, 403); const allowed = await get(allowedCookie); assert.equal(allowed.status, 200); statusBody(allowed.body);
  });
  await check("raw advisor identity remains excluded even with mapped admin and salary visibility", async () => {
    assert.equal((await get(advisorCookie)).status, 403);
    const [raw] = await q<{ role: string }>("select role from users where id=$1", [advisor.id]); assert.equal(raw.role, "advisor");
  });
  await check("an unplaced admin cannot use the session's first-branch tenant fallback for payroll", async () => {
    assert.equal((await get(unplacedCookie)).status, 403);
  });
  const passed = Object.values(cases).filter(row => row.passed).length;
  console.log(JSON.stringify({ suite: "s634-payroll-status", passed, total: Object.keys(cases).length, cases }));
  if (passed !== Object.keys(cases).length) process.exitCode = 1;
} catch {
  console.error("s634-payroll-status: setup_failed"); process.exitCode = 1;
} finally {
  for (const cookie of cookies) if (origin) try { await fetch(origin + "/api/logout", { method: "POST", headers: { cookie }, redirect: "error" }); } catch { /* Own harness is stopped next. */ }
  if (child && child.exitCode === null) {
    const server = child; await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); server.kill(); });
  }
  await pool.end();
}
