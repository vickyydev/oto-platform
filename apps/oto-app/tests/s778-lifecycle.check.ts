// SCRUM-778/781/810: real PostgreSQL, owned fixtures, injected HTTP only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { drainPlatformLifecycleEvents, readPlatformLifecycleEvents } from '../server/lib/platformLifecycle';

let target: URL;
try { target = new URL(process.env.DATABASE_URL ?? ''); } catch { throw new Error('Isolated lifecycle database required'); }
if (process.env.SCRUM_633_LIFECYCLE_TESTS !== '1' || target.hostname !== process.env.SCRUM_633_EXPECT_DB_HOST
  || target.pathname.slice(1) !== process.env.SCRUM_633_EXPECT_DB_NAME || !/^zz_test_633_[a-z0-9_]+$/.test(target.pathname.slice(1))) {
  throw new Error('Isolated lifecycle database guard refused');
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=otoapp', max: 2 });
const results: boolean[] = [];
async function check(name: string, action: () => Promise<void> | void) {
  try { await action(); results.push(true); } catch { results.push(false); }
  console.log(`${results.at(-1) ? 'ok' : 'not ok'} lifecycle retry: ${name}`);
}
async function fixture(action: (client: pg.PoolClient, user: string, tenant: string, event: string) => Promise<void>) {
  const client = await pool.connect(), user = randomUUID(), tenant = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO tenants(id,name,slug) VALUES ($1,'ZZ TEST retry tenant',$2)", [tenant, `zz-test-${tenant}`]);
    await client.query(`INSERT INTO users(id,email,password,full_name,role,is_active,platform_user_id)
      VALUES ($1,$2,'!','ZZ TEST retry login','staff',true,$3)`, [user, `${user}@example.invalid`, randomUUID()]);
    await client.query("INSERT INTO user_branch_access(id,tenant_id,user_id,access_scope) VALUES ($1,$2,$3,'all_branches')", [randomUUID(), tenant, user]);
    await client.query('UPDATE users SET is_active=false WHERE id=$1', [user]);
    const event = (await client.query('SELECT id FROM login_lifecycle_events WHERE user_id=$1', [user])).rows[0].id;
    await action(client, user, tenant, event);
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
}
const read = async (client: pg.PoolClient, event: string) => (await client.query(`SELECT *,
  extract(epoch FROM next_attempt_at-now())::int AS delay FROM login_lifecycle_events WHERE id=$1`, [event])).rows[0];
const config = { apiUrl: 'https://platform.invalid', key: 'ZZ TEST unused injected key' };
const refused = async () => new Response('PRIVATE_BODY', { status: 404 });

await check('HIGH: due time survives another drain and backs off through six attempts, then parks with a safe reason', () => fixture(async (client, _user, _tenant, event) => {
  let calls = 0;
  const dependencies = { database: client, config, fetch: async () => { calls++; return refused(); } };
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (attempt > 1) await client.query('UPDATE login_lifecycle_events SET next_attempt_at=now() WHERE id=$1', [event]);
    assert.equal((await drainPlatformLifecycleEvents(dependencies)).failed, 1);
    const row = await read(client, event);
    assert.equal(row.attempt_count, attempt);
    assert.equal(row.state, 'pending');
    assert.equal(row.delay, attempt === 6 ? null : 30 * 2 ** (attempt - 1));
    assert.equal((await drainPlatformLifecycleEvents({ ...dependencies })).selected, 0);
  }
  assert.equal(calls, 6);
  assert.equal((await read(client, event)).last_error_code, 'RETRY_LIMIT:PLATFORM_HTTP_REFUSED');
}));
await check('HIGH: two drains that read the same due row claim only one HTTP attempt', () => fixture(async (client, _user, _tenant, event) => {
  let calls = 0;
  const dependencies = { database: client, config, fetch: async () => { calls++; return refused(); } };
  await Promise.all([drainPlatformLifecycleEvents(dependencies), drainPlatformLifecycleEvents(dependencies)]);
  assert.equal(calls, 1); assert.equal((await read(client, event)).attempt_count, 1);
}));
await check('HIGH: a lost reply after platform settlement never reopens or annotates the terminal event', () => fixture(async (client, _user, _tenant, event) => {
  await drainPlatformLifecycleEvents({ database: client, config, fetch: async () => {
    await client.query("UPDATE login_lifecycle_events SET state='superseded',settled_at=now(),last_error_code=NULL WHERE id=$1", [event]);
    throw new Error('PRIVATE_NETWORK_DETAIL');
  } });
  const row = await read(client, event);
  assert.equal(row.state, 'superseded'); assert.equal(row.last_error_code, null);
  assert.equal((await drainPlatformLifecycleEvents({ database: client, config, fetch: refused })).selected, 0);
}));
await check('HIGH: deletion settles both event kinds and retains scoped readback after the login is gone', () => fixture(async (client, user, tenant, event) => {
  await client.query("UPDATE users SET access_mode='pay_only' WHERE id=$1", [user]);
  await client.query('DELETE FROM user_branch_access WHERE user_id=$1', [user]);
  await client.query('DELETE FROM users WHERE id=$1', [user]);
  const rows = await readPlatformLifecycleEvents(client, tenant, user);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.kind).sort(), ['deactivate', 'restrict']);
  for (const row of rows) { assert.equal(row.state, 'superseded'); assert.ok(row.settledAt); assert.equal(row.nextAttemptAt, null); assert.equal(row.lastErrorCode, 'LOGIN_DELETED'); }
  assert.ok(rows.some(row => row.id === event));
  assert.deepEqual(await readPlatformLifecycleEvents(client, randomUUID(), user), []);
  assert.equal(JSON.stringify(rows).includes('platform_account_id'), false);
}));
await check('HIGH: a rolled-back deletion restores both the user and its pending receipt', () => fixture(async (client, user, _tenant, event) => {
  await client.query('SAVEPOINT before_delete');
  await client.query('DELETE FROM user_branch_access WHERE user_id=$1', [user]);
  await client.query('DELETE FROM users WHERE id=$1', [user]);
  assert.equal((await read(client, event)).state, 'superseded');
  await client.query('ROLLBACK TO SAVEPOINT before_delete');
  assert.equal((await read(client, event)).state, 'pending');
  assert.equal((await client.query('SELECT id FROM users WHERE id=$1', [user])).rowCount, 1);
}));
await check('HIGH: a supplied foreign tenant cannot overwrite the insert-time ownership snapshot', () => fixture(async (client, user, tenant) => {
  const id = randomUUID();
  await client.query(`INSERT INTO login_lifecycle_events(id,user_id,platform_account_id,tenant_id)
    SELECT $1,id,platform_user_id,$3 FROM users WHERE id=$2`, [id, user, randomUUID()]);
  assert.equal((await read(client, id)).tenant_id, tenant);
}));
await check('MEDIUM: absent transport configuration has the same bounded schedule and stores no secret detail', () => fixture(async (client, _user, _tenant, event) => {
  await drainPlatformLifecycleEvents({ database: client, config: null, fetch: async () => { throw new Error('HTTP must not run'); } });
  const row = await read(client, event);
  assert.equal(row.attempt_count, 1); assert.equal(row.delay, 30); assert.equal(row.last_error_code, 'PLATFORM_UNCONFIGURED');
}));
await check('HIGH: the forward migration repairs old orphans and parks exhausted live events without resetting history', () => fixture(async (client, user, _tenant, event) => {
  await client.query(`DROP TRIGGER users_settle_deleted_login_lifecycle ON users;
    DROP TRIGGER login_lifecycle_tenant_stamp ON login_lifecycle_events;
    DROP FUNCTION settle_deleted_login_lifecycle(); DROP FUNCTION stamp_login_lifecycle_tenant();
    DROP FUNCTION login_lifecycle_tenant(varchar);
    ALTER TABLE login_lifecycle_events DROP COLUMN tenant_id, DROP COLUMN next_attempt_at;`);
  const orphan = randomUUID();
  await client.query(`INSERT INTO login_lifecycle_events(id,user_id,platform_account_id,attempt_count,last_error_code)
    VALUES ($1,$2,$3,200,'PLATFORM_HTTP_REFUSED')`, [orphan, randomUUID(), randomUUID()]);
  await client.query("UPDATE login_lifecycle_events SET attempt_count=9,last_error_code='PLATFORM_UNREACHABLE' WHERE id=$1", [event]);
  const migration = readFileSync(new URL('../migrations/0049_login_lifecycle_retries.sql', import.meta.url), 'utf8');
  await client.query(migration);
  const old = await read(client, orphan), live = await read(client, event);
  assert.equal(old.state, 'superseded'); assert.equal(old.last_error_code, 'LOGIN_DELETED'); assert.equal(old.attempt_count, 200);
  assert.equal(live.state, 'pending'); assert.equal(live.next_attempt_at, null); assert.equal(live.attempt_count, 9);
  assert.equal(live.last_error_code, 'RETRY_LIMIT:PLATFORM_UNREACHABLE');
  assert.equal((await client.query('SELECT id FROM users WHERE id=$1', [user])).rowCount, 1);
}));
await check('HIGH: support readback validates identity and route enforces admin plus park-group middleware', async () => {
  await assert.rejects(readPlatformLifecycleEvents(pool, 'invalid', randomUUID()));
  await assert.rejects(readPlatformLifecycleEvents(pool, randomUUID(), 'invalid'));
  const routes = readFileSync(new URL('../server/routes.ts', import.meta.url), 'utf8');
  const route = routes.slice(routes.indexOf('app.get("/api/admin/login-lifecycle"'), routes.indexOf('app.get("/api/admin/login-lifecycle"') + 800);
  assert.match(route, /requireAuth, requireAdmin, parkGroupOnly\(userManagementTenant\)/);
  assert.match(route, /readPlatformLifecycleEvents\(pool, parkGroupOf\(res\), parsed.data.userId\)/);
});
await pool.end();
const passed = results.filter(Boolean).length;
console.log(`s778-lifecycle.check: ${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
