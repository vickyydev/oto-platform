// Own ZZ TEST fixtures; DATABASE_URL must name a migrated disposable database.
// Real registered routes and legacy sessions; provisioning reaches only the local refusal server.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID, scryptSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('admin-managed-alternate requires a disposable database');
const appDir = fileURLToPath(new URL('../', import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=otoapp', max: 2 });
const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
const run = randomBytes(5).toString('hex'), password = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('hex');
const passwordHash = `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
const prefix = `ZZ TEST 632 alternate ${run}`;
const tenant = randomUUID(), foreignTenant = randomUUID(), offOperator = randomUUID(), onOperator = randomUUID(), foreignOperator = randomUUID();
const offBranch = randomUUID(), onBranch = randomUUID(), foreignBranch = randomUUID();
const phone = '080' + String(randomInt(10_000_000)).padStart(7, '0');
const provisionKey = randomBytes(32).toString('hex');
let child: ChildProcess | undefined, origin = '', activeCase = '', upstreamCalls = 0;
const cookies: string[] = [];
const results: Record<string, { passed: boolean; statuses: number[]; unchanged?: boolean; upstreamUnchanged?: boolean }> = {};
const upstream = createServer((request, response) => {
  upstreamCalls++;
  request.resume();
  response.writeHead(503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code: 'ZZ_TEST_LOCAL_REFUSAL', message: 'ZZ TEST local provisioning refused' } }));
});

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const response = await fetch(origin + path, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (activeCase) results[activeCase].statuses.push(response.status);
  let data: any = null;
  try { data = await response.json(); } catch { /* A 204 is empty. */ }
  return { status: response.status, data };
}
async function check(name: string, action: () => Promise<void>) {
  activeCase = name; results[name] = { passed: false, statuses: [] };
  try { await action(); results[name].passed = true; } catch { /* No private SQL/HTTP body or error is printed. */ }
  finally { activeCase = ''; }
}
async function snapshot() {
  const rows = await q(`select jsonb_build_object(
    'users',(select coalesce(jsonb_agg(to_jsonb(t)-'password' order by t.id),'[]') from users t where t.email like $1),
    'operators',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from operators t where t.tenant_id=any($2::uuid[])),
    'branches',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from branches t where t.tenant_id=any($2::uuid[])),
    'access',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from user_branch_access t where t.tenant_id=any($2::uuid[])),
    'policies',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from access_policies t where t.tenant_id=any($2::uuid[])),
    'overrides',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from user_module_overrides t where t.tenant_id=any($2::uuid[])),
    'people',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from people t where t.tenant_id=any($2::uuid[])),
    'employees',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from employees t where t.tenant_id=any($2::uuid[])),
    'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from activity_log t where t.tenant_id=any($2::uuid[]))) as snapshot`,
  [`zz-alt-%-${run}@example.invalid`, [tenant, foreignTenant]]);
  return createHash('sha256').update(JSON.stringify(rows[0].snapshot)).digest('hex');
}
async function refused(method: string, path: string, cookie: string, body?: unknown, status = 409, managed = true) {
  const before = await snapshot(), callsBefore = upstreamCalls;
  const response = await call(method, path, cookie, body);
  results[activeCase].unchanged = before === await snapshot();
  results[activeCase].upstreamUnchanged = callsBefore === upstreamCalls;
  assert.equal(response.status, status);
  if (managed) {
    assert.equal(response.data?.code, 'managed_in_admin');
    assert.equal(response.data?.message, 'Managed in Admin. Open Admin to make changes.');
    assert.equal(Object.keys(response.data).sort().join(','), 'code,message');
  }
  assert.equal(results[activeCase].unchanged, true);
  assert.equal(results[activeCase].upstreamUnchanged, true);
}
async function user(label: string, operatorId: string | null, role = 'staff', owner = tenant, branch = offBranch) {
  const id = randomUUID(), email = `zz-alt-${label}-${run}@example.invalid`;
  await q(`insert into users(id,email,password,full_name,role,is_active,must_change_password,operator_id)
    values($1,$2,$3,$4,$5,true,false,$6)`, [id, email, passwordHash, `${prefix} ${label}`, role, operatorId]);
  const access = (await q(`insert into user_branch_access(tenant_id,user_id,branch_id,access_scope)
    values($1,$2,$3,$4) returning id`, [owner, id, role === 'admin' ? null : branch, role === 'admin' ? 'all_branches' : 'selected_branches']))[0].id;
  return { id, email, access };
}
async function person(label: string, login?: { id: string; email: string }, advisor = false) {
  const id = randomUUID(), employeeId = advisor ? null : randomUUID(), policyId = randomUUID();
  const email = login?.email ?? `zz-alt-${label}-${run}@example.invalid`;
  await q('insert into people(id,tenant_id,full_name,email,person_type) values($1,$2,$3,$4,$5)',
    [id, tenant, `${prefix} ${label}`, email, advisor ? 'ADVISOR' : 'EMPLOYEE']);
  if (employeeId) await q(`insert into employees(id,tenant_id,branch_id,user_id,person_id,full_name,nickname,email,status)
    values($1,$2,$3,$4,$5,$6,'ZZ TEST',$7,'active')`, [employeeId, tenant, offBranch, login?.id ?? null, id, `${prefix} ${label}`, email]);
  await q(`insert into access_policies(id,tenant_id,person_id,access_level,modules,branch_scope,branch_ids,core_user_id)
    values($1,$2,$3,'STAFF','{}','SELECTED',$4,$5)`, [policyId, tenant, id, JSON.stringify([offBranch]), login?.id ?? null]);
  return { id, employeeId, policyId, email };
}
async function serve(upstreamOrigin: string) {
  child = spawn(process.execPath, [join(appDir, 'node_modules/tsx/dist/cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: appDir, env: { ...process.env, NODE_ENV: 'test', APP_ENV: 'dev', STORAGE_ENV_PREFIX: 'zz-admin-alternate',
      OBJECT_STORAGE: 'local', DEPLOY_ENV: 'local', OTOAPP_LEGACY_LOGIN: 'true', OTOAPP_JOBS: 'platform', USE_AWS_REKOGNITION: 'false',
      LOG_LEVEL: 'warn', SESSION_SECRET: randomBytes(32).toString('hex'), SESSION_PEPPER: randomBytes(32).toString('hex'),
      PLATFORM_API_URL: upstreamOrigin, OTOAPP_PROVISION_KEY: provisionKey }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = child;
  return new Promise<string>((resolve, reject) => {
    let tail = ''; const timer = setTimeout(() => reject(new Error('alternate harness start timed out')), 180_000);
    const read = (part: Buffer) => { tail = (tail + part.toString()).slice(-256); const match = /HARNESS_PORT=(\d+)/.exec(tail);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } };
    server.stdout!.on('data', read); server.stderr!.on('data', read);
    server.on('error', () => { clearTimeout(timer); reject(new Error('alternate harness start failed')); });
    server.on('exit', () => { clearTimeout(timer); reject(new Error('alternate harness stopped')); });
  });
}
async function signIn(email: string) {
  const response = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, password }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal(cookie.length > 0, true); cookies.push(cookie); return cookie;
}

try {
  await q("insert into tenants(name,slug) values('ZZ TEST alternate dictionary','default') on conflict(slug) do nothing");
  for (const [id, label] of [[tenant, 'own'], [foreignTenant, 'foreign']]) await q('insert into tenants(id,name,slug) values($1,$2,$3)',
    [id, `${prefix} ${label}`, `zz-alt-${label}-${run}`]);
  for (const [id, owner, enabled] of [[offOperator, tenant, false], [onOperator, tenant, true], [foreignOperator, foreignTenant, true]]) {
    await q('insert into operators(id,tenant_id,name,platform_roles_enabled) values($1,$2,$3,$4)', [id, owner, prefix, enabled]);
  }
  for (const [id, owner, operatorId] of [[offBranch, tenant, offOperator], [onBranch, tenant, onOperator], [foreignBranch, foreignTenant, foreignOperator]]) {
    await q("insert into branches(id,tenant_id,operator_id,name,address) values($1,$2,$3,$4,'ZZ TEST')", [id, owner, operatorId, prefix]);
  }
  const offActor = await user('off-actor', offOperator, 'admin'), onActor = await user('on-actor', onOperator, 'admin');
  const offUser = await user('off-user', offOperator), onUser = await user('on-user', onOperator), onClear = await user('on-clear', onOperator);
  const scopeUser = await user('off-scope', offOperator), deleteAccess = await user('on-access-delete', onOperator);
  const foreignUser = await user('foreign-user', foreignOperator, 'staff', foreignTenant, foreignBranch);
  const offPerson = await person('off-person', offUser), onPerson = await person('on-person', onUser);
  const historical = await person('historical-soft-link', undefined, true);
  await q('update access_policies set core_user_id=$1 where id=$2', [foreignUser.id, historical.policyId]);
  const advisorUser = await user('on-advisor', onOperator, 'advisor');
  const advisor = await person('on-advisor', advisorUser, true), missingAdvisor = await person('missing-advisor', undefined, true);
  const caseOnUser = await user('case-on-advisor', onOperator, 'advisor');
  const caseOffUser = await user('case-off-advisor', offOperator, 'advisor');
  const caseNonAdvisorUser = await user('case-non-advisor', onOperator);
  const caseOn = await person('case-on-advisor', caseOnUser, true);
  const caseOff = await person('case-off-advisor', caseOffUser, true);
  const caseNonAdvisor = await person('case-non-advisor', caseNonAdvisorUser, true);
  for (const fixture of [caseOn, caseOff, caseNonAdvisor]) {
    await q('update people set email=upper(email) where id=$1', [fixture.id]);
    await q('update access_policies set core_user_id=null where id=$1', [fixture.policyId]);
  }
  await q("update people set person_type='EMPLOYEE' where id=$1", [caseNonAdvisor.id]);
  const override = (await q(`insert into user_module_overrides(tenant_id,user_id,module_key,enabled,branch_scope_type)
    values($1,$2,'hr',false,'ALL') returning id`, [tenant, offUser.id]))[0].id;
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = await serve(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  const off = await signIn(offActor.email), on = await signIn(onActor.email);

  // Run the original path before counterfactual writes can unassign its actor.
  // A separate local fixture phone cannot become another case's conflict.
  await check('off_suite_user_retains_local_provisioning_path', async () => {
    const before = upstreamCalls, controlPhone = '081' + phone.slice(3);
    const response = await call('POST', `/api/users/${offUser.id}/suite-sign-in`, off, { actionId: randomUUID(), phone: controlPhone });
    assert.equal(response.status, 502); assert.equal(upstreamCalls, before + 1);
    assert.equal((await q('select phone_e164 is not null as saved from users where id=$1', [offUser.id]))[0].saved, true);
  });
  await check('historical_foreign_reference_clear_preserves_existing_ownership_and_managed_refusals', async () => {
    await refused('PUT', `/api/data-admin/access-policies/${historical.policyId}`, off, { accessLevel: 'MANAGER' }, 404, false);
    await refused('PUT', `/api/data-admin/access-policies/${historical.policyId}`, off, { coreUserId: foreignUser.id }, 404, false);
    assert.equal((await call('PUT', `/api/data-admin/access-policies/${historical.policyId}`, off, { coreUserId: null, branchIds: null })).status, 200);
    const repaired = (await q('select core_user_id,branch_ids from access_policies where id=$1', [historical.policyId]))[0];
    assert.equal(repaired.core_user_id, null); assert.equal(repaired.branch_ids, null);
    assert.equal((await call('GET', `/api/people/${historical.id}`, off)).status, 200);
    await refused('PUT', `/api/data-admin/access-policies/${onPerson.policyId}`, off, { coreUserId: null });
  });
  const caseAccess = { accessLevel: 'MANAGER', modules: { core: true, hr: false }, branchScope: 'SELECTED', branchIds: [offBranch] };
  await check('native_advisor_case_variant_managed_login_refused', async () => {
    assert.equal((await q('select count(*)::int n from employees where person_id=$1', [caseOn.id]))[0].n, 0);
    assert.equal((await q('select core_user_id from access_policies where id=$1', [caseOn.policyId]))[0].core_user_id, null);
    await refused('PUT', `/api/people/${caseOn.id}/access`, off, caseAccess);
  });
  await check('raw_policy_advisor_case_variant_managed_login_refused', () => refused('PUT', `/api/data-admin/access-policies/${caseOn.policyId}`, off,
    { accessLevel: 'MANAGER' }));
  await check('off_advisor_case_variant_preserves_existing_policy_writes', async () => {
    assert.equal((await call('PUT', `/api/people/${caseOff.id}/access`, off, caseAccess)).status, 200);
    assert.equal((await call('PUT', `/api/data-admin/access-policies/${caseOff.policyId}`, off, { accessLevel: 'STAFF' })).status, 200);
    assert.equal((await q('select role from users where id=$1', [caseOffUser.id]))[0].role, 'advisor');
  });
  await check('nonadvisor_case_variant_keeps_exact_only_identity_matching', async () => {
    assert.equal((await call('PUT', `/api/people/${caseNonAdvisor.id}/access`, off, caseAccess)).status, 200);
    assert.equal((await call('PUT', `/api/data-admin/access-policies/${caseNonAdvisor.policyId}`, off, { accessLevel: 'STAFF' })).status, 200);
    assert.equal((await q('select role from users where id=$1', [caseNonAdvisorUser.id]))[0].role, 'staff');
  });
  await check('raw_user_create_flagged_actor_null_target', () => refused('POST', '/api/data-admin/users', on,
    { email: `zz-alt-new-actor-${run}@example.invalid`, fullName: prefix, password: passwordHash, role: 'staff' }));
  await check('raw_user_create_flagged_entity', () => refused('POST', '/api/data-admin/users', off,
    { email: `zz-alt-new-entity-${run}@example.invalid`, fullName: prefix, password: passwordHash, role: 'staff', operatorId: onOperator }));
  await check('raw_operator_create_flagged_actor', () => refused('POST', '/api/data-admin/operators', on, { name: prefix }));
  await check('raw_branch_access_create_affected_user', () => refused('POST', '/api/data-admin/user-branch-accesses', off,
    { userId: onUser.id, branchId: onBranch, accessScope: 'selected_branches' }));
  await check('raw_branch_access_move_new_user', () => refused('PUT', `/api/data-admin/user-branch-accesses/${offUser.access}`, off, { userId: onUser.id }));
  await check('raw_override_move_new_user', () => refused('PUT', `/api/data-admin/user-module-overrides/${override}`, off, { userId: onUser.id }));
  await check('raw_policy_clear_old_core_user', () => refused('PUT', `/api/data-admin/access-policies/${onPerson.policyId}`, off, { coreUserId: null }));
  await check('raw_policy_move_new_person', () => refused('PUT', `/api/data-admin/access-policies/${offPerson.policyId}`, off, { personId: onPerson.id }));
  await check('raw_branch_clear_old_entity', () => refused('PUT', `/api/data-admin/branches/${onBranch}`, off, { operatorId: null }));
  await check('raw_branch_assign_new_entity', () => refused('PUT', `/api/data-admin/branches/${offBranch}`, off, { operatorId: onOperator }));
  await check('raw_user_clear_old_entity', () => refused('PUT', `/api/data-admin/users/${onClear.id}`, off, { operatorId: null }));
  await check('foreign_user_retains_404', () => refused('PUT', `/api/data-admin/users/${foreignUser.id}`, on, { fullName: prefix }, 404, false));
  await check('internal_flag_refusal_retained', () => refused('PUT', `/api/data-admin/operators/${offOperator}`, off, { platformRolesEnabled: true }, 409, false));
  await check('ordinary_hr_employee_name_remains_writable', async () => {
    const name = `${prefix} HR name`;
    assert.equal((await call('PUT', `/api/data-admin/employees/${onPerson.employeeId}`, on, { fullName: name })).status, 200);
    assert.equal((await q('select full_name from employees where id=$1', [onPerson.employeeId]))[0].full_name === name, true);
  });
  await check('ordinary_hr_person_name_remains_writable', async () => {
    assert.equal((await call('PUT', `/api/data-admin/persons/${onPerson.id}`, on, { fullName: `${prefix} person name` })).status, 200);
  });
  await check('ordinary_branch_name_remains_writable', async () => {
    assert.equal((await call('PUT', `/api/data-admin/branches/${offBranch}`, on, { name: `${prefix} branch name` })).status, 200);
  });
  await check('off_user_grant_branch_does_not_infer_managed_entity', async () => {
    assert.equal((await call('PUT', `/api/data-admin/user-branch-accesses/${scopeUser.access}`, off, { branchId: onBranch })).status, 200);
  });
  await check('employee_unlink_old_managed_user', () => refused('PUT', `/api/data-admin/employees/${onPerson.employeeId}`, off, { userId: null }));
  await check('employee_link_new_managed_user', () => refused('PUT', `/api/data-admin/employees/${offPerson.employeeId}`, off, { userId: onUser.id }));
  await check('person_email_identity_change_managed_user', () => refused('PUT', `/api/data-admin/persons/${onPerson.id}`, off,
    { email: `zz-alt-changed-${run}@example.invalid` }));
  await check('suite_user_refuses_before_phone_and_upstream', () => refused('POST', `/api/users/${onUser.id}/suite-sign-in`, off, { actionId: randomUUID(), phone }));
  await check('suite_advisor_refuses_before_phone_and_upstream', () => refused('POST', `/api/people/${advisor.id}/suite-sign-in`, off, { actionId: randomUUID(), phone }));
  await check('suite_flagged_actor_refuses_before_advisor_login_creation', () => refused('POST', `/api/people/${missingAdvisor.id}/suite-sign-in`, on, { actionId: randomUUID(), phone }));
  await check('raw_branch_access_delete_affected_user', () => refused('DELETE', `/api/data-admin/user-branch-accesses/${deleteAccess.access}`, off));
} catch {
  results.setup_or_runtime = { passed: false, statuses: [] };
} finally {
  activeCase = '';
  for (const cookie of cookies) { try { await call('POST', '/api/logout', cookie); } catch { /* Stop the owned local child below. */ } }
  child?.kill(); upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  await pool.end();
}
const passed = Object.values(results).every(row => row.passed) && Object.keys(results).length === 30;
console.log('ADMIN_MANAGED_ALTERNATE_RESULTS=' + JSON.stringify({ passed, checks: Object.keys(results).length, results, localUpstreamCalls: upstreamCalls, externalNetwork: false }));
if (!passed) process.exitCode = 1;
