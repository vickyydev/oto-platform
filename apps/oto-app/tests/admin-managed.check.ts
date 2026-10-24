// seed: its own ZZ TEST rows in the caller's migrated disposable database.
// Exercise the real registered routes, legacy sign-in and PostgreSQL state.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("admin-managed.check requires a disposable database");
const appDir = fileURLToPath(new URL("../", import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=otoapp", max: 2 });
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const run = randomBytes(5).toString("hex");
const password = randomBytes(24).toString("base64url");
const salt = randomBytes(16).toString("hex");
const passwordHash = `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
const prefix = `ZZ TEST managed ${run}`;
const tenant = randomUUID();
const foreignTenant = randomUUID();
const offOperator = randomUUID();
const onOperator = randomUUID();
const foreignOperator = randomUUID();
const branch = randomUUID();
const onBranch = randomUUID();
const foreignBranch = randomUUID();
let child: ChildProcess | undefined;
let origin = "";
let activeCase = "";
const cookies: string[] = [];
const cases: Record<string, { passed: boolean; statuses: number[]; stateUnchanged?: boolean; failure?: string }> = {};

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (activeCase) cases[activeCase].statuses.push(response.status);
  const text = await response.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* Empty success responses are valid. */ }
  return { status: response.status, data };
}

async function check(name: string, action: () => Promise<void>) {
  activeCase = name;
  cases[name] = { passed: false, statuses: [] };
  try { await action(); cases[name].passed = true; }
  catch { cases[name].failure = "assertion_or_request_failed"; }
  finally { activeCase = ""; }
}

/** Hash state in RAM: neither private values nor assertion diffs reach the log. */
async function businessSnapshot(): Promise<string> {
  const rows = await q(`select jsonb_build_object(
    'users', (select coalesce(jsonb_agg(to_jsonb(t) - 'password' order by t.id), '[]') from users t where lower(t.email) like $1),
    'operators', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from operators t where t.tenant_id = any($2::uuid[])),
    'branches', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from branches t where t.tenant_id = any($2::uuid[])),
    'access', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from user_branch_access t where t.tenant_id = any($2::uuid[])),
    'policies', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from access_policies t where t.tenant_id = any($2::uuid[])),
    'overrides', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from user_module_overrides t where t.tenant_id = any($2::uuid[])),
    'employees', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from employees t where t.tenant_id = any($2::uuid[])),
    'people', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from people t where t.tenant_id = any($2::uuid[])),
    'audit', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from activity_log t where t.tenant_id = any($2::uuid[]))
  ) as snapshot`, [`zz-managed-%-${run}@example.invalid`, [tenant, foreignTenant]]);
  return createHash("sha256").update(JSON.stringify(rows[0].snapshot)).digest("hex");
}

async function refused(method: string, path: string, cookie: string, body?: unknown, status = 409) {
  const before = await businessSnapshot();
  const response = await call(method, path, cookie, body);
  const unchanged = before === await businessSnapshot();
  cases[activeCase].stateUnchanged = unchanged;
  assert.equal(response.status, status);
  if (status === 409) {
    assert.equal(response.data?.code, "managed_in_admin");
    assert.equal(response.data?.message, "Managed in Admin. Open Admin to make changes.");
    assert.equal(Object.keys(response.data).sort().join(","), "code,message");
  }
  assert.equal(unchanged, true);
}

async function seedUser(label: string, operatorId: string | null, role = "staff", targetTenant = tenant, targetBranch = branch) {
  const id = randomUUID();
  const email = `zz-managed-${label}-${run}@example.invalid`;
  await q(`insert into users(id,email,password,full_name,role,is_active,must_change_password,operator_id)
    values($1,$2,$3,$4,$5,true,false,$6)`, [id, email, passwordHash, `${prefix} ${label}`, role, operatorId]);
  await q("insert into user_branch_access(tenant_id,user_id,branch_id,access_scope) values($1,$2,$3,$4)",
    [targetTenant, id, role === "admin" ? null : targetBranch, role === "admin" ? "all_branches" : "selected_branches"]);
  return { id, email };
}

async function seedPerson(user: { id: string; email: string }, label: string, targetBranch: string) {
  const personId = randomUUID();
  const employeeId = randomUUID();
  const policyId = randomUUID();
  await q("insert into people(id,tenant_id,full_name,email,person_type) values($1,$2,$3,$4,'EMPLOYEE')",
    [personId, tenant, `${prefix} ${label}`, user.email]);
  await q(`insert into employees(id,tenant_id,branch_id,user_id,person_id,full_name,nickname,email,status)
    values($1,$2,$3,$4,$5,$6,'ZZ TEST',$7,'active')`,
  [employeeId, tenant, targetBranch, user.id, personId, `${prefix} ${label}`, user.email]);
  await q(`insert into access_policies(id,tenant_id,person_id,access_level,modules,branch_scope,branch_ids,core_user_id)
    values($1,$2,$3,'STAFF',$4,'SELECTED',$5,$6)`,
  [policyId, tenant, personId, JSON.stringify({ core: true, hr: false }), JSON.stringify([targetBranch]), user.id]);
  return { personId, employeeId, policyId };
}

async function serve() {
  child = spawn(process.execPath, [join(appDir, "node_modules/tsx/dist/cli.mjs"), "tests/harness/serve-routes.ts"], {
    cwd: appDir,
    env: { ...process.env, NODE_ENV: "test", APP_ENV: "dev", STORAGE_ENV_PREFIX: "zz-admin-managed",
      OBJECT_STORAGE: "local", DEPLOY_ENV: "local", OTOAPP_LEGACY_LOGIN: "true", OTOAPP_JOBS: "platform",
      USE_AWS_REKOGNITION: "false", LOG_LEVEL: "warn", SESSION_SECRET: randomBytes(32).toString("hex"),
      SESSION_PEPPER: randomBytes(32).toString("hex"), PLATFORM_API_URL: "", OTOAPP_PROVISION_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = child;
  return new Promise<string>((resolve, reject) => {
    let tail = "";
    const timer = setTimeout(() => reject(new Error("admin-managed harness start timed out")), 180_000);
    const read = (part: Buffer) => {
      tail = (tail + part.toString()).slice(-256);
      const match = /HARNESS_PORT=(\d+)/.exec(tail);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    server.stdout!.on("data", read);
    server.stderr!.on("data", read);
    server.on("error", () => { clearTimeout(timer); reject(new Error("admin-managed harness start failed")); });
    server.on("exit", () => { clearTimeout(timer); reject(new Error("admin-managed harness stopped")); });
  });
}

async function signIn(email: string) {
  const response = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.equal(cookie.length > 0, true);
  cookies.push(cookie);
  return cookie;
}

const userBody = (label: string) => ({ email: `zz-managed-${label}-${run}@example.invalid`, password,
  fullName: `${prefix} ${label}`, role: "staff", accessScope: "selected_branches", branchIds: [branch], mustChangePassword: false });

try {
  await q("insert into tenants(name,slug) values('ZZ TEST managed dictionary','default') on conflict(slug) do nothing");
  for (const [id, label] of [[tenant, "own"], [foreignTenant, "foreign"]]) {
    await q("insert into tenants(id,name,slug) values($1,$2,$3)", [id, `${prefix} ${label}`, `zz-managed-${label}-${run}`]);
  }
  for (const [id, owner, label, enabled] of [[offOperator, tenant, "off", false], [onOperator, tenant, "on", true], [foreignOperator, foreignTenant, "foreign", true]]) {
    await q("insert into operators(id,tenant_id,name,platform_roles_enabled) values($1,$2,$3,$4)", [id, owner, `${prefix} ${label}`, enabled]);
  }
  for (const [id, owner, operator, label] of [[branch, tenant, offOperator, "off"], [onBranch, tenant, onOperator, "on"], [foreignBranch, foreignTenant, foreignOperator, "foreign"]]) {
    await q("insert into branches(id,tenant_id,operator_id,name,address) values($1,$2,$3,$4,'ZZ TEST')", [id, owner, operator, `${prefix} ${label}`]);
  }
  const offActor = await seedUser("off-actor", offOperator, "admin");
  const onActor = await seedUser("on-actor", onOperator, "admin");
  const offTarget = await seedUser("off-target", offOperator);
  const nullTarget = await seedUser("null-target", null);
  const onTarget = await seedUser("on-target", onOperator);
  const foreignTarget = await seedUser("foreign-target", foreignOperator, "staff", foreignTenant, foreignBranch);
  const onDeleteUser = await seedUser("on-delete", onOperator);
  const onReferenceUser = await seedUser("on-reference", onOperator);
  const offReferenceUser = await seedUser("off-reference", offOperator);
  const onAssignmentUser = await seedUser("on-assignment", onOperator);
  const offPerson = await seedPerson(offTarget, "off-person", branch);
  const onPerson = await seedPerson(onTarget, "on-person", onBranch);
  const foreignPerson = randomUUID();
  await q("insert into people(id,tenant_id,full_name,email,person_type) values($1,$2,$3,$4,'EMPLOYEE')",
    [foreignPerson, foreignTenant, `${prefix} foreign person`, foreignTarget.email]);
  const caseOffUser = await seedUser("case-sensitive", offOperator);
  const caseOnUser = await seedUser("case-on", onOperator);
  const advisorTarget = await seedUser("case-advisor", onOperator, "advisor");
  const caseOnEmail = caseOffUser.email.toUpperCase();
  await q("update users set email=$1 where id=$2", [caseOnEmail, caseOnUser.id]);
  const caseOffPerson = randomUUID(), caseOnPerson = randomUUID(), unmatchedPerson = randomUUID(), advisorPerson = randomUUID();
  for (const [id, email, label, kind] of [
    [caseOffPerson, caseOffUser.email, "exact off", "EMPLOYEE"],
    [caseOnPerson, caseOnEmail, "exact on", "EMPLOYEE"],
    [unmatchedPerson, onTarget.email.toUpperCase(), "no exact login", "EMPLOYEE"],
    [advisorPerson, advisorTarget.email.toUpperCase(), "advisor login", "ADVISOR"],
  ]) {
    await q("insert into people(id,tenant_id,full_name,email,person_type) values($1,$2,$3,$4,$5)",
      [id, tenant, `${prefix} ${label}`, email, kind]);
  }
  const emptyOnOperator = randomUUID();
  await q("insert into operators(id,tenant_id,name,platform_roles_enabled) values($1,$2,$3,true)",
    [emptyOnOperator, tenant, `${prefix} empty on`]);
  await q(`insert into user_module_overrides(tenant_id,user_id,module_key,enabled,branch_scope_type)
    values($1,$2,'hr',false,'ALL')`, [tenant, onTarget.id]);
  origin = await serve();
  const offCookie = await signIn(offActor.email);
  const onCookie = await signIn(onActor.email);

  await check("off_actor_on_user_patch", () => refused("PATCH", `/api/users/${onTarget.id}`, offCookie, { fullName: `${prefix} forbidden rename` }));
  await check("on_actor_off_user_patch", () => refused("PATCH", `/api/users/${offTarget.id}`, onCookie, { fullName: `${prefix} forbidden rename` }));
  await check("off_actor_on_operator_patch", () => refused("PATCH", `/api/admin/operators/${onOperator}`, offCookie, { name: `${prefix} forbidden entity` }));
  await check("on_actor_operator_create", () => refused("POST", "/api/admin/operators", onCookie, { name: `${prefix} forbidden create`, status: "active" }));
  await check("on_actor_user_create", () => refused("POST", "/api/users", onCookie, userBody("forbidden-create")));
  await check("off_actor_user_create_preserves_null_placement", async () => {
    const response = await call("POST", "/api/users", offCookie, userBody("permitted-create"));
    assert.equal(response.status, 201);
    const rows = await q("select operator_id from users where id=$1", [response.data?.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operator_id, null);
  });
  await check("off_actor_off_user_patch_unchanged", async () => {
    const fullName = `${prefix} permitted rename`;
    assert.equal((await call("PATCH", `/api/users/${offTarget.id}`, offCookie, { fullName })).status, 200);
    assert.equal((await q("select full_name from users where id=$1", [offTarget.id]))[0].full_name === fullName, true);
  });
  await check("off_actor_off_operator_patch_unchanged", async () => {
    const name = `${prefix} permitted entity`;
    assert.equal((await call("PATCH", `/api/admin/operators/${offOperator}`, offCookie, { name })).status, 200);
    assert.equal((await q("select name from operators where id=$1", [offOperator]))[0].name === name, true);
  });

  await check("own_metadata_is_actor_scoped", async () => {
    const off = await call("GET", "/api/permissions/me", offCookie);
    const on = await call("GET", "/api/permissions/me", onCookie);
    assert.equal(off.status, 200);
    assert.equal(on.status, 200);
    assert.equal(off.data?.managedInAdmin, false);
    assert.equal(on.data?.managedInAdmin, true);
  });
  await check("user_list_metadata_is_target_scoped", async () => {
    for (const cookie of [offCookie, onCookie]) {
      const list = await call("GET", "/api/users", cookie);
      assert.equal(list.status, 200);
      assert.equal(Array.isArray(list.data), true);
      assert.equal(list.data.find((row: any) => row.id === offTarget.id)?.managedInAdmin, false);
      assert.equal(list.data.find((row: any) => row.id === onTarget.id)?.managedInAdmin, true);
      assert.equal(list.data.some((row: any) => row.id === foreignTarget.id), false);
    }
  });
  await check("permissions_list_metadata_is_target_scoped", async () => {
    const list = await call("GET", "/api/permissions/bulk", offCookie);
    assert.equal(list.status, 200);
    assert.equal(list.data.find((row: any) => row.personId === offPerson.personId)?.managedInAdmin, false);
    assert.equal(list.data.find((row: any) => row.personId === onPerson.personId)?.managedInAdmin, true);
  });
  await check("permissions_metadata_follows_actual_case_sensitive_login", async () => {
    const list = await call("GET", "/api/permissions/bulk", offCookie);
    assert.equal(list.status, 200);
    const off = list.data.find((row: any) => row.personId === caseOffPerson);
    const on = list.data.find((row: any) => row.personId === caseOnPerson);
    assert.equal(off?.userId, caseOffUser.id);
    assert.equal(on?.userId, caseOnUser.id);
    assert.equal(off?.managedInAdmin, false);
    assert.equal(on?.managedInAdmin, true);
  });
  await check("mixed_bulk_case_variant_login_refused_before_any_policy_write", () => refused("PUT", "/api/permissions/bulk-update", offCookie,
    { personIds: [offPerson.personId, caseOnPerson], moduleKey: "hr", enabled: true }));
  await check("non_advisor_missing_exact_login_keeps_original_skipped_bulk", async () => {
    const list = await call("GET", "/api/permissions/bulk", offCookie);
    assert.equal(list.status, 200);
    const row = list.data.find((item: any) => item.personId === unmatchedPerson);
    assert.equal(row?.userId, null);
    assert.equal(row?.managedInAdmin, false);
    const before = await businessSnapshot();
    const response = await call("PUT", "/api/permissions/bulk-update", offCookie,
      { personIds: [unmatchedPerson], moduleKey: "hr", enabled: true });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { updated: 0, skipped: 1 });
    assert.equal(before, await businessSnapshot());
  });
  await check("advisor_single_access_preserves_case_insensitive_target_refusal", () => refused("PUT", `/api/people/${advisorPerson}/access`, offCookie,
    { accessLevel: "STAFF", modules: { core: true, hr: false }, branchScope: "SELECTED", branchIds: [branch] }));
  await check("operator_list_and_members_keep_own_flags", async () => {
    const list = await call("GET", "/api/admin/operators", offCookie);
    assert.equal(list.status, 200);
    assert.equal(list.data.find((row: any) => row.id === offOperator)?.platformRolesEnabled, false);
    assert.equal(list.data.find((row: any) => row.id === onOperator)?.platformRolesEnabled, true);
    assert.equal(list.data.some((row: any) => row.id === foreignOperator), false);
    const members = await call("GET", `/api/admin/operators/${onOperator}/users`, offCookie);
    assert.equal(members.status, 200);
    assert.equal(members.data.find((row: any) => row.id === onTarget.id)?.managedInAdmin, true);
  });
  const accessBody = { accessLevel: "MANAGER", modules: { core: true, hr: true }, branchScope: "SELECTED", branchIds: [onBranch] };
  await check("on_person_access_policy_refused_before_role_and_employee_changes", () => refused("PUT", `/api/people/${onPerson.personId}/access`, offCookie, accessBody));
  await check("on_actor_off_person_access_policy_refused", () => refused("PUT", `/api/people/${offPerson.personId}/access`, onCookie,
    { ...accessBody, branchIds: [branch] }));
  await check("mixed_bulk_preflight_prevents_partial_off_first_write", () => refused("PUT", "/api/permissions/bulk-update", offCookie,
    { personIds: [offPerson.personId, onPerson.personId], moduleKey: "hr", enabled: true }));
  await check("on_user_override_put_refused", () => refused("PUT", `/api/module-overrides/${onTarget.id}`, offCookie,
    { overrides: [{ moduleKey: "hr", enabled: true, branchScopeType: "ALL", branchIds: [] }] }));
  await check("on_user_override_delete_refused", () => refused("DELETE", `/api/module-overrides/${onTarget.id}`, offCookie));
  await check("off_actor_off_person_access_unchanged", async () => {
    const response = await call("PUT", `/api/people/${offPerson.personId}/access`, offCookie, { ...accessBody, branchIds: [branch] });
    assert.equal(response.status, 200);
    assert.equal((await q("select role from users where id=$1", [offTarget.id]))[0].role, "manager");
  });
  await check("foreign_targets_keep_not_found_before_management_refusal", async () => {
    await refused("PATCH", `/api/users/${foreignTarget.id}`, offCookie, { fullName: `${prefix} foreign attempt` }, 404);
    await refused("PATCH", `/api/admin/operators/${foreignOperator}`, onCookie, { name: `${prefix} foreign attempt` }, 404);
  });
  await check("suite_signin_on_target_refused_without_upstream_configuration", () => refused("POST", `/api/users/${onTarget.id}/suite-sign-in`, offCookie,
    { actionId: randomUUID() }));
  await check("suite_signin_on_actor_refused_without_upstream_configuration", () => refused("POST", `/api/users/${offTarget.id}/suite-sign-in`, onCookie,
    { actionId: randomUUID() }));
  await check("data_admin_on_user_update_refused", () => refused("PUT", `/api/data-admin/users/${onTarget.id}`, offCookie,
    { fullName: `${prefix} raw forbidden` }));
  await check("data_admin_on_operator_update_refused", () => refused("PUT", `/api/data-admin/operators/${onOperator}`, offCookie,
    { name: `${prefix} raw entity forbidden` }));
  await check("data_admin_on_policy_update_refused", () => refused("PUT", `/api/data-admin/access-policies/${onPerson.policyId}`, offCookie,
    { accessLevel: "MANAGER" }));
  await check("data_admin_policy_new_on_user_reference_refused", () => refused("PUT", `/api/data-admin/access-policies/${offPerson.policyId}`, offCookie,
    { coreUserId: onTarget.id }));
  await check("data_admin_cannot_clear_old_on_user_entity", () => refused("PUT", `/api/data-admin/users/${onReferenceUser.id}`, offCookie,
    { operatorId: null }));
  await check("data_admin_cannot_assign_off_user_to_on_entity", () => refused("PUT", `/api/data-admin/users/${offReferenceUser.id}`, offCookie,
    { operatorId: onOperator }));
  await check("data_admin_on_detached_user_delete_refused", () => refused("DELETE", `/api/data-admin/users/${onDeleteUser.id}`, offCookie));
  await check("data_admin_empty_on_operator_delete_refused", () => refused("DELETE", `/api/data-admin/operators/${emptyOnOperator}`, offCookie));
  await check("native_password_reset_refuses_without_changing_hash", async () => {
    const before = (await q("select password from users where id=$1", [onTarget.id]))[0].password;
    await refused("POST", `/api/users/${onTarget.id}/reset-password`, offCookie, { password });
    assert.equal(before === (await q("select password from users where id=$1", [onTarget.id]))[0].password, true);
  });
  await check("native_permission_review_clear_refused", () => refused("POST", `/api/users/${onTarget.id}/clear-permission-review`, offCookie));
  await check("native_detached_user_delete_refused", () => refused("DELETE", `/api/users/${onDeleteUser.id}`, offCookie));
  await check("native_empty_on_operator_delete_refused", () => refused("DELETE", `/api/admin/operators/${emptyOnOperator}`, offCookie));
  await check("native_on_operator_branch_replacement_refused_before_clear", () => refused("PUT", `/api/admin/operators/${onOperator}/branches`, offCookie,
    { branchIds: [onBranch] }));
  await check("foreign_branch_refusal_stays_before_managed_refusal", () => refused("PUT", `/api/admin/operators/${onOperator}/branches`, onCookie,
    { branchIds: [foreignBranch] }, 403));
  await check("null_operator_target_keeps_native_edit", async () => {
    const name = `${prefix} null placement edit`;
    assert.equal((await call("PATCH", `/api/users/${nullTarget.id}`, offCookie, { fullName: name })).status, 200);
    const row = (await q("select full_name,operator_id from users where id=$1", [nullTarget.id]))[0];
    assert.equal(row.full_name === name && row.operator_id === null, true);
  });
  await check("same_cookie_next_write_reads_current_entity_flag", async () => {
    await q("update operators set platform_roles_enabled=true where id=$1", [offOperator]);
    try {
      const current = await call("GET", "/api/permissions/me", offCookie);
      assert.equal(current.status, 200);
      assert.equal(current.data?.managedInAdmin, true);
      await refused("PATCH", `/api/users/${nullTarget.id}`, offCookie, { fullName: `${prefix} live flag forbidden` });
    } finally {
      await q("update operators set platform_roles_enabled=false where id=$1", [offOperator]);
    }
  });
  await check("same_cookie_flag_off_recovers_native_write", async () => {
    const current = await call("GET", "/api/permissions/me", offCookie);
    assert.equal(current.status, 200);
    assert.equal(current.data?.managedInAdmin, false);
    assert.equal((await call("PATCH", `/api/users/${nullTarget.id}`, offCookie, { fullName: `${prefix} live flag recovered` })).status, 200);
  });
  await check("off_bulk_retains_foreign_and_missing_skip_counts", async () => {
    const response = await call("PUT", "/api/permissions/bulk-update", offCookie,
      { personIds: [offPerson.personId, foreignPerson, randomUUID()], moduleKey: "hr", enabled: false });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { updated: 1, skipped: 2 });
  });
  await check("off_operator_create_keeps_flag_false", async () => {
    const response = await call("POST", "/api/admin/operators", offCookie, { name: `${prefix} native off create`, status: "active" });
    assert.equal(response.status, 201);
    assert.equal(response.data?.platformRolesEnabled, false);
  });
  // Assignment checks run last: an unfenced baseline can clear existing placement.
  await check("operator_user_assignment_old_on_entity_refused_before_unassign", () => refused("PUT", `/api/admin/operators/${offOperator}/users`, offCookie,
    { userIds: [onAssignmentUser.id] }));
  await check("operator_user_assignment_new_on_entity_refused_before_unassign", () => refused("PUT", `/api/admin/operators/${onOperator}/users`, offCookie,
    { userIds: [offTarget.id] }));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
    ? error.code : "setup_or_runtime_failed";
  cases.setup_or_runtime = { passed: false, statuses: [], failure: code };
} finally {
  activeCase = "";
  for (const cookie of cookies) {
    try { await call("POST", "/api/logout", cookie); } catch { /* The disposable harness is stopped below. */ }
  }
  child?.kill();
  await pool.end();
}
const passed = Object.values(cases).every(result => result.passed) && Object.keys(cases).length === 46;
console.log("ADMIN_MANAGED_RESULTS=" + JSON.stringify({ passed, checks: Object.keys(cases).length, cases }));
if (!passed) process.exitCode = 1;
