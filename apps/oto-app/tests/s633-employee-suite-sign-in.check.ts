// Native HTTP/DB employee provisioning checks. The only upstream is this
// process's captured loopback platform; no SMS adapter or real account is used.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=otoapp", max: 6 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await pool.query<T>(sql, values)).rows;
const run = randomBytes(5).toString("hex"), sessionSecret = randomBytes(24).toString("hex"), password = "zz-test-local-login";
const hash = () => { const salt = randomBytes(16).toString("hex"); return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`; };
const children: ChildProcess[] = [];
let failures = 0, checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  checks++;
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "check failed"}`); }
}
async function group(label: string) {
  const tenant = randomUUID(), branch = randomUUID(), operator = randomUUID();
  await q("insert into tenants (id,name,slug) values ($1,$2,$3)", [tenant, `ZZ TEST 633 ${label}`, `zz-633-${label}-${run}`]);
  await q("insert into operators (id,tenant_id,name,status,platform_roles_enabled) values ($1,$2,$3,'active',false)", [operator, tenant, `ZZ TEST 633 ${label}`]);
  await q("insert into branches (id,tenant_id,operator_id,name,address) values ($1,$2,$3,$4,'ZZ TEST')", [branch, tenant, operator, `ZZ TEST 633 ${label}`]);
  return { tenant, branch, operator };
}
type Group = Awaited<ReturnType<typeof group>>;
async function actor(g: Group, role: string, all = true) {
  const id = randomUUID(), email = `zz-633-${id}-${run}@example.com`;
  await q("insert into users (id,email,password,full_name,role,is_active,must_change_password,operator_id) values ($1,$2,$3,'ZZ TEST 633 actor',$4,true,false,$5)", [id, email, hash(), role, role === "operator_admin" ? g.operator : null]);
  await q("insert into user_branch_access (tenant_id,user_id,branch_id,access_scope) values ($1,$2,$3,$4)", [g.tenant, id, all ? null : g.branch, all ? "all_branches" : "selected_branches"]);
  return { id, email };
}
async function employee(g: Group, label: string, branch = g.branch, personId: string | null = null) {
  const id = randomUUID(), email = `zz-633-${id}-${run}@example.com`;
  await q("insert into employees (id,tenant_id,branch_id,full_name,nickname,email,phone,status,person_id) values ($1,$2,$3,$4,'ZZ',$5,'0816330001','active',$6)", [id, g.tenant, branch, `ZZ TEST 633 ${label}`, email, personId]);
  return { id, email };
}
async function footprint(id: string) {
  return q(`select e.user_id,e.person_id,
    (select count(*)::int from users u where u.email=e.email) as users,
    (select count(*)::int from people p where p.email=e.email) as people,
    (select count(*)::int from employee_action_receipts r where r.employee_id=e.id) as receipts
    from employees e where e.id=$1`, [id]);
}
async function graph(id: string) {
  const [row] = await q<{ user_id: string; person_id: string; role: string; operator_id: string | null; platform_user_id: string | null; policy_user: string; policies: number; seats: number; receipts: number; receipt_secret: boolean }>(`select e.user_id,e.person_id,u.role,u.operator_id,u.platform_user_id,a.core_user_id as policy_user,
    (select count(*)::int from access_policies where person_id=e.person_id) as policies,
    (select count(*)::int from user_branch_access where user_id=e.user_id) as seats,
    (select count(*)::int from employee_action_receipts where employee_id=e.id) as receipts,
    exists(select 1 from employee_action_receipts where employee_id=e.id and response_body::text like '%ZZ633-ONCE-ONLY%') as receipt_secret
    from employees e left join users u on u.id=e.user_id left join access_policies a on a.person_id=e.person_id where e.id=$1`, [id]);
  return row!;
}
type LoginAudit = { tenant_id: string; employee_id: string; created_by: string; activity_type: string; summary_text: string; metadata_json: string | null };
const loginAudits = (id: string) => q<LoginAudit>(`select tenant_id,employee_id,created_by,activity_type,summary_text,metadata_json
  from activity_log where employee_id=$1 and activity_type='user_permissions_updated' order by created_at,id`, [id]);
function assertLoginAudit(row: LoginAudit, phase: "prepared" | "completed", expected: { tenant: string; employee: string; actor: string; action: string; user: string }) {
  assert.equal(row.tenant_id === expected.tenant && row.employee_id === expected.employee && row.created_by === expected.actor, true, "Login audit must retain its exact tenant, employee and actor");
  assert.equal(row.activity_type, "user_permissions_updated");
  const metadata = JSON.parse(row.metadata_json ?? "null") as Record<string, unknown> | null;
  assert.equal(metadata?.phase === phase && metadata.actionId === expected.action && metadata.userId === expected.user, true, "Audit must identify the reserved action, user and outcome");
  assert.equal(JSON.stringify(Object.keys(metadata ?? {}).sort()) === JSON.stringify(["actionId", "phase", "userId"].sort()), true, "Only safe audit identifiers and phase are stored");
  assert.equal(phase === "prepared" ? /pending/i.test(row.summary_text) : /confirm/i.test(row.summary_text), true, "Park-facing audit must distinguish pending preparation from confirmation");
}
const asked: Array<{ path: string; body: Record<string, unknown>; keyOkay: boolean; cookieAbsent: boolean }> = [];
const upstream = new Map<string, { userId: string; accountId: string; phone: string; platformManaged: boolean }>();
const lost = new Set<string>();
let dropAfterCommit: string | null = null;
const platform = createServer((request, response) => {
  let raw = "";
  request.on("data", chunk => { raw += chunk; });
  request.on("end", () => { void (async () => {
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    asked.push({ path: request.url ?? "", body, keyOkay: request.headers.authorization === "Bearer zz-633-captured-key", cookieAbsent: request.headers.cookie === undefined });
    if (request.url !== "/admin/apps/oto_app/suite-sign-ins") { response.writeHead(404); response.end(); return; }
    const action = String(body.actionId).toLowerCase(), existing = upstream.get(action);
    if (existing) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: action, externalUserId: existing.userId, ...existing, temporaryPassword: null, replayed: true })); return;
    }
    const [owner] = await q<{ platform_roles_enabled: boolean }>("select o.platform_roles_enabled from users u left join operators o on o.id=u.operator_id where u.id=$1", [body.appUserId]);
    const made = { userId: String(body.appUserId), accountId: randomUUID(), phone: String(body.phone), platformManaged: owner?.platform_roles_enabled === true };
    upstream.set(action, made);
    await q("update users set platform_user_id=$1,role=case when $3 then 'staff' else role end where id=$2", [made.accountId, made.userId, made.platformManaged]);
    if (dropAfterCommit?.toLowerCase() === action && !lost.has(action)) { lost.add(action); request.socket.destroy(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: action, externalUserId: made.userId, ...made, temporaryPassword: "ZZ633-ONCE-ONLY", replayed: false }));
  })().catch(() => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: "ZZ_UPSTREAM_FAILED", message: "Captured platform failed" } })); }); });
});
async function serve(legacy: boolean, apiUrl: string, keyed = true) {
  const child = spawn(process.execPath, [join(APP, "node_modules/tsx/dist/cli.mjs"), "tests/harness/serve-routes.ts"], {
    cwd: APP, env: { ...process.env, NODE_ENV: "test", APP_ENV: "dev", DEPLOY_ENV: "local", OBJECT_STORAGE: "local", STORAGE_ENV_PREFIX: "zz-test",
      OTOAPP_JOBS: "platform", OTOAPP_LEGACY_LOGIN: String(legacy), SESSION_SECRET: sessionSecret, LOG_LEVEL: "warn",
      PLATFORM_API_URL: apiUrl, OTOAPP_PROVISION_KEY: keyed ? "zz-633-captured-key" : "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let output = "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native app harness did not start")), 90_000);
    const receive = (chunk: Buffer) => { output += chunk.toString(); const match = /HARNESS_PORT=(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } };
    child.stdout!.on("data", receive); child.stderr!.on("data", receive);
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`Native app harness exited ${code}`)); });
  });
}
async function login(origin: string, who: { email: string }) {
  const response = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: who.email, password }) });
  assert.equal(response.status, 200, "local fixture login"); return response.headers.getSetCookie().map(x => x.split(";")[0]).join("; ");
}
async function call(origin: string, cookie: string, id: string, body: Record<string, unknown>) {
  const response = await fetch(origin + `/api/employees/${id}/enable-login`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body), redirect: "error" });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
}
function payload(g: Group, email: string, actionId = randomUUID(), extra: Record<string, unknown> = {}) {
  return { actionId, phone: "081633" + String(++phoneSequence).padStart(4, "0"), email, accessLevel: "STAFF", branchScope: "SELECTED", branchIds: [g.branch],
    enableCoreModule: true, enableHrModule: false, enableStudioModule: false, enableEventsModule: false, enableOpsModule: false, enableSetupModule: false, ...extra };
}
let phoneSequence = 10;
try {
  const A = await group("a"), B = await group("b");
  const admin = await actor(A, "admin"), manager = await actor(A, "manager", false);
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  const legacy = await serve(true, apiUrl), closed = await serve(false, apiUrl), unkeyed = await serve(false, apiUrl, false);
  const adminCookie = await login(legacy, admin), managerCookie = await login(legacy, manager);

  await check("nonlegacy Create Login provisions once through the platform and links one exact local graph", async () => {
    const e = await employee(A, "success"), body = payload(A, e.email), before = asked.length;
    const response = await call(closed, adminCookie, e.id, body);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.body.temporaryPassword === "ZZ633-ONCE-ONLY", true, "one-time captured secret returned only to first caller");
    assert.equal(response.body.replayed, false); assert.equal(response.body.platformManaged, false); assert.equal(asked.length, before + 1);
    const linked = await graph(e.id); assert.ok(linked.user_id); assert.equal(linked.policy_user, linked.user_id);
    assert.equal(linked.policies, 1); assert.equal(linked.seats, 1); assert.equal(linked.receipts, 1); assert.equal(linked.receipt_secret, false);
    assert.equal(linked.operator_id, A.operator); assert.equal(linked.platform_user_id, response.body.accountId);
    const captured = asked.at(-1)!; assert.equal(captured.keyOkay, true); assert.equal(captured.cookieAbsent, true);
    assert.deepEqual(captured.body, { actionId: body.actionId, appUserId: linked.user_id, phone: "+66" + String(body.phone).slice(1), actorAppUserId: admin.id });
    const replay = await call(closed, adminCookie, e.id, body);
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.temporaryPassword, null);
    assert.deepEqual(await graph(e.id), linked, "replay never recreates or changes the graph");
  });
  await check("lost platform acknowledgement retains one reservation and same action/user on retry", async () => {
    const e = await employee(A, "lost"), body = payload(A, e.email); dropAfterCommit = String(body.actionId);
    assert.equal((await loginAudits(e.id)).length, 0);
    const first = await call(closed, adminCookie, e.id, body); assert.equal(first.status, 502);
    const prepared = await graph(e.id); assert.ok(prepared.user_id); assert.equal(prepared.receipts, 1); assert.equal(prepared.receipt_secret, false);
    const expectedAudit = { tenant: A.tenant, employee: e.id, actor: admin.id, action: String(body.actionId), user: prepared.user_id };
    const pendingAudits = await loginAudits(e.id); assert.equal(pendingAudits.length, 1, "An uncertain platform answer still has one committed local preparation audit");
    assertLoginAudit(pendingAudits[0], "prepared", expectedAudit);
    const replay = await call(closed, adminCookie, e.id, body); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.temporaryPassword, null);
    assert.equal((await graph(e.id)).user_id, prepared.user_id); assert.equal(upstream.get(String(body.actionId))?.userId, prepared.user_id);
    const completedAudits = await loginAudits(e.id); assert.equal(completedAudits.length, 2);
    assertLoginAudit(completedAudits[0], "prepared", expectedAudit); assertLoginAudit(completedAudits[1], "completed", expectedAudit);
    assert.equal((await call(closed, adminCookie, e.id, body)).status, 200);
    assert.deepEqual(await loginAudits(e.id), completedAudits, "Further replay adds neither preparation nor completion audits");
  });
  await check("fresh authenticated reload resumes the prepared request without creating another graph or exposing a password", async () => {
    const e = await employee(A, "reload"), body = payload(A, e.email); dropAfterCommit = String(body.actionId);
    assert.equal((await call(closed, adminCookie, e.id, body)).status, 502);
    const before = await graph(e.id), count = asked.length, freshCookie = await login(legacy, admin);
    const response = await fetch(closed + `/api/employees/${e.id}/login-provisioning`, { headers: { cookie: freshCookie } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const pending = await response.json() as { phase: string; actionId: string; request: Record<string, unknown>; userId: string };
    assert.equal(pending.phase, "prepared"); assert.equal(pending.actionId, body.actionId); assert.equal(pending.userId, before.user_id);
    assert.deepEqual(pending.request, body); assert.equal(JSON.stringify(pending).includes("ZZ633-ONCE-ONLY"), false);
    assert.equal(asked.length, count, "reading pending work never calls platform");
    const denied = await fetch(closed + `/api/employees/${e.id}/login-provisioning`, { headers: { cookie: managerCookie } });
    assert.equal(denied.status, 403, "only original actor can recover this request");
    const resumed = await call(closed, freshCookie, e.id, pending.request);
    assert.equal(resumed.status, 200); assert.equal(resumed.body.temporaryPassword, null); assert.equal(resumed.body.replayed, true);
    assert.equal((await graph(e.id)).user_id, before.user_id);
    const finished = await fetch(closed + `/api/employees/${e.id}/login-provisioning`, { headers: { cookie: freshCookie } });
    assert.equal(finished.status, 200); assert.equal(await finished.json(), null);
  });
  await check("uppercase UUID action survives lost acknowledgement and fresh-session reload as the same reservation", async () => {
    const e = await employee(A, "uppercase"), action = randomUUID().toUpperCase(), body = payload(A, e.email, action);
    dropAfterCommit = action;
    assert.equal((await call(closed, adminCookie, e.id, body)).status, 502);
    const before = await graph(e.id), freshCookie = await login(legacy, admin);
    const pending = await fetch(closed + `/api/employees/${e.id}/login-provisioning`, { headers: { cookie: freshCookie } });
    assert.equal(pending.status, 200);
    const recovered = await pending.json() as { actionId: string; request: Record<string, unknown>; userId: string };
    assert.equal(recovered.actionId.toLowerCase(), action.toLowerCase()); assert.equal(recovered.userId, before.user_id);
    const resumed = await call(closed, freshCookie, e.id, recovered.request);
    assert.equal(resumed.status, 200); assert.equal(resumed.body.replayed, true); assert.equal(resumed.body.temporaryPassword, null);
    assert.equal((await graph(e.id)).user_id, before.user_id);
    assert.equal(asked.slice(-2).every(entry => String(entry.body.actionId).toLowerCase() === action.toLowerCase()), true);
  });
  await check("configuration and phone validation happen before any local write", async () => {
    for (const [origin, overrides, expected] of [[unkeyed, {}, 503], [closed, { phone: "bad" }, 400], [closed, { phone: "" }, 400]] as const) {
      const e = await employee(A, "invalid"), before = await footprint(e.id), askedBefore = asked.length;
      const response = await call(origin, adminCookie, e.id, payload(A, e.email, randomUUID(), overrides));
      assert.equal(response.status, expected); assert.deepEqual(await footprint(e.id), before); assert.equal(asked.length, askedBefore);
    }
  });
  await check("a UUID action ID is required before local or upstream effects", async () => {
    const e = await employee(A, "no-action"), before = await footprint(e.id), count = asked.length;
    assert.equal((await call(closed, adminCookie, e.id, payload(A, e.email, "not-a-uuid"))).status, 400);
    assert.deepEqual(await footprint(e.id), before); assert.equal(asked.length, count);
  });
  await check("foreign employee and foreign selected branch refuse before writes or upstream", async () => {
    for (const [g, branches, expected] of [[B, [B.branch], 404], [A, [B.branch], 403]] as const) {
      const e = await employee(g, "foreign"), before = await footprint(e.id), count = asked.length;
      assert.equal((await call(closed, adminCookie, e.id, payload(g, e.email, randomUUID(), { branchIds: branches }))).status, expected);
      assert.deepEqual(await footprint(e.id), before); assert.equal(asked.length, count);
    }
  });
  await check("manager keeps own-branch manager creation but cannot grant ADMIN or all branches", async () => {
    for (const overrides of [{ accessLevel: "ADMIN" }, { accessLevel: "MANAGER", branchScope: "ALL", branchIds: [] }]) {
      const e = await employee(A, "manager-refused"), before = await footprint(e.id), count = asked.length;
      assert.equal((await call(closed, managerCookie, e.id, payload(A, e.email, randomUUID(), overrides))).status, 403);
      assert.deepEqual(await footprint(e.id), before); assert.equal(asked.length, count);
    }
    const e = await employee(A, "manager-allowed");
    const response = await call(closed, managerCookie, e.id, payload(A, e.email, randomUUID(), { accessLevel: "MANAGER", enableHrModule: true }));
    assert.equal(response.status, 200); assert.equal(response.body.platformManaged, false); assert.equal((await graph(e.id)).role, "manager");
  });
  await check("same action cannot change payload, employee or caller on replay", async () => {
    const e = await employee(A, "binding"), other = await employee(A, "binding-other"), body = payload(A, e.email);
    assert.equal((await call(closed, adminCookie, e.id, body)).status, 200);
    const before = await graph(e.id), otherBefore = await footprint(other.id), count = asked.length;
    assert.equal((await call(closed, adminCookie, e.id, { ...body, enableOpsModule: true })).status, 409);
    assert.equal((await call(closed, adminCookie, other.id, { ...body, email: other.email })).status, 409);
    assert.equal((await call(closed, managerCookie, e.id, body)).status, 409);
    assert.deepEqual(await graph(e.id), before); assert.deepEqual(await footprint(other.id), otherBefore); assert.equal(asked.length, count);
  });
  await check("replay reauthorizes the manager's present employee branch access", async () => {
    const e = await employee(A, "reauthorize"), body = payload(A, e.email); dropAfterCommit = String(body.actionId);
    assert.equal((await call(closed, managerCookie, e.id, body)).status, 502); const count = asked.length;
    await q("delete from user_branch_access where user_id=$1", [manager.id]);
    try { assert.equal((await call(closed, managerCookie, e.id, body)).status, 403); assert.equal(asked.length, count); }
    finally { await q("insert into user_branch_access (tenant_id,user_id,branch_id,access_scope) values ($1,$2,$3,'selected_branches')", [A.tenant, manager.id, A.branch]); }
  });
  await check("mapped employee entity returns platform-managed staff without creating platform role grants", async () => {
    const op = randomUUID(), branch = randomUUID();
    await q("insert into operators (id,tenant_id,name,status,platform_roles_enabled) values ($1,$2,'ZZ TEST 633 mapped','active',true)", [op, A.tenant]);
    await q("insert into branches (id,tenant_id,operator_id,name,address) values ($1,$2,$3,'ZZ TEST 633 mapped','ZZ TEST')", [branch, A.tenant, op]);
    const g = { ...A, branch, operator: op }, e = await employee(g, "mapped");
    const response = await call(closed, adminCookie, e.id, payload(g, e.email, randomUUID(), { accessLevel: "MANAGER", enableHrModule: true }));
    assert.equal(response.status, 200); assert.equal(response.body.platformManaged, true); assert.equal((await graph(e.id)).role, "staff");
    assert.equal((await graph(e.id)).operator_id, op);
  });
  await check("unassigned employee branch never picks an arbitrary legal entity", async () => {
    const branch = randomUUID(); await q("insert into branches (id,tenant_id,name,address) values ($1,$2,'ZZ TEST 633 unassigned','ZZ TEST')", [branch, A.tenant]);
    const g = { ...A, branch }, e = await employee(g, "unassigned");
    assert.equal((await call(closed, adminCookie, e.id, payload(g, e.email))).status, 200); assert.equal((await graph(e.id)).operator_id, null);
  });
  await check("foreign-tenant person link is refused without attaching it or asking platform", async () => {
    const person = randomUUID(), e = await employee(A, "cross-person"), count = asked.length;
    await q("insert into people (id,tenant_id,full_name,email,person_type) values ($1,$2,'ZZ TEST 633 foreign person',$3,'EMPLOYEE')", [person, B.tenant, e.email]);
    const before = await footprint(e.id); assert.equal((await call(closed, adminCookie, e.id, payload(A, e.email))).status, 409);
    assert.deepEqual(await footprint(e.id), before); assert.equal(asked.length, count);
  });
  await check("failure during local policy insertion rolls back user, links and reservation", async () => {
    const person = randomUUID(); await q("insert into people (id,tenant_id,full_name,email,person_type) values ($1,$2,'ZZ TEST 633 rollback',$3,'EMPLOYEE')", [person, A.tenant, `zz-633-rollback-${run}@example.com`]);
    const e = await employee(A, "rollback", A.branch, person), before = await footprint(e.id), count = asked.length, auditBefore = await loginAudits(e.id);
    const fn = `zz633_fail_${run}`, trigger = `zz633_fail_${run}`;
    await q(`create function otoapp.${fn}() returns trigger language plpgsql as $$ begin raise exception 'ZZ TEST policy failure'; end $$`);
    await q(`create trigger ${trigger} before insert on otoapp.access_policies for each row when (new.person_id = '${person}') execute function otoapp.${fn}()`);
    try { assert.equal((await call(closed, adminCookie, e.id, payload(A, e.email))).status, 500); assert.deepEqual(await footprint(e.id), before); assert.equal(asked.length, count);
      assert.deepEqual(await loginAudits(e.id), auditBefore, "Failed local graph has no preparation or completion audit"); }
    finally { await q(`drop trigger ${trigger} on otoapp.access_policies`); await q(`drop function otoapp.${fn}()`); }
  });
  await check("legacy-enabled employee creation keeps its original local password flow and never asks platform", async () => {
    const e = await employee(A, "legacy"), count = asked.length;
    const response = await call(legacy, adminCookie, e.id, { email: e.email, password, accessLevel: "STAFF", branchScope: "SELECTED", branchIds: [A.branch] });
    assert.equal(response.status, 200); assert.equal(asked.length, count); assert.equal((await graph(e.id)).platform_user_id, null);
  });
  console.log(`s633-employee-suite-sign-in.check: ${checks - failures}/${checks} passed`);
  if (failures) process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await new Promise<void>(resolve => platform.close(() => resolve()));
  await pool.end();
}
