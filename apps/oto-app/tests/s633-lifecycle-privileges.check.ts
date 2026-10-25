// Actual migration SQL and restricted roles in root's disposable SCRUM-633 database.
// Every role, owner change, source fixture and grant is rolled back; no network is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

let target: URL;
try { target = new URL(process.env.DATABASE_URL ?? ''); } catch { throw new Error('Isolated lifecycle database required'); }
if (process.env.SCRUM_633_LIFECYCLE_TESTS !== '1' || target.hostname !== process.env.SCRUM_633_EXPECT_DB_HOST
  || target.pathname.slice(1) !== process.env.SCRUM_633_EXPECT_DB_NAME || !/^zz_test_633_[a-z0-9_]+$/.test(target.pathname.slice(1))) {
  throw new Error('Isolated lifecycle database guard refused');
}
const migration = readFileSync(new URL('../migrations/0031_login_lifecycle.sql', import.meta.url), 'utf8');
// On the pre-fix source this intentionally does nothing: the RED is an actual
// denied queue privilege / trigger write, rather than a missing-file assertion.
const grant = migration.match(/DO\s+\$login_lifecycle_access\$[\s\S]*?\$login_lifecycle_access\$\s*;/i)?.[0] ?? '';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=otoapp', max: 1 });
const results: Record<string, boolean> = {};
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const capabilities = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

async function check(name: string, action: () => Promise<void>) {
  try { await action(); results[name] = true; } catch { results[name] = false; }
  console.log(`${results[name] ? 'ok' : 'not ok'} lifecycle privileges: ${name}`);
}
async function asRole<T>(client: pg.PoolClient, role: string, action: () => Promise<T>): Promise<T> {
  const savepoint = identifier('role_' + randomUUID().replaceAll('-', ''));
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(`SET LOCAL ROLE ${identifier(role)}`);
    const result = await action();
    await client.query('RESET ROLE');
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
async function tableCapabilities(client: pg.PoolClient, role: string, table: string): Promise<boolean[]> {
  return (await client.query<{ allowed: boolean }>(
    'SELECT has_table_privilege($1,$2,p) AS allowed FROM unnest($3::text[]) WITH ORDINALITY AS requested(p,n) ORDER BY n',
    [role, table, capabilities],
  )).rows.map(row => row.allowed);
}
type Fixture = { client: pg.PoolClient; apiRole: string; appRole: string; outsiderRole: string; userId: string; accountId: string };
async function fixture(action: (value: Fixture) => Promise<void>) {
  const client = await pool.connect(), suffix = randomUUID().replaceAll('-', '');
  const apiRole = 'zz_633_api_' + suffix, appRole = 'zz_633_app_' + suffix, outsiderRole = 'zz_633_other_' + suffix;
  const roleNames = [apiRole, appRole, outsiderRole], userId = randomUUID(), accountId = randomUUID();
  const original = (await client.query<{ relname: string; relowner: number }>(`SELECT c.relname,c.relowner FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname='core' AND c.relname='account') OR (n.nspname='otoapp' AND c.relname='login_lifecycle_events')
    ORDER BY n.nspname,c.relname`)).rows;
  try {
    await client.query('BEGIN');
    for (const role of roleNames) await client.query(`CREATE ROLE ${identifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA otoapp TO ${roleNames.map(identifier).join(',')}`);
    await client.query(`GRANT CREATE ON SCHEMA otoapp TO ${identifier(appRole)}`);
    await client.query(`GRANT SELECT,UPDATE ON otoapp.users TO ${identifier(apiRole)}`);
    await client.query(`ALTER TABLE core.account OWNER TO ${identifier(apiRole)}`);
    await client.query(`ALTER TABLE otoapp.login_lifecycle_events OWNER TO ${identifier(appRole)}`);
    await client.query(`REVOKE ALL ON otoapp.login_lifecycle_events FROM PUBLIC,${identifier(apiRole)},${identifier(outsiderRole)}`);
    await client.query(`INSERT INTO otoapp.users(id,email,password,full_name,role,is_active,platform_user_id)
      VALUES($1,$2,'!','ZZ TEST 633 lifecycle privilege','staff',true,$3)`,
    [userId, `zz-test-633-${userId}@example.invalid`, accountId]);
    await action({ client, apiRole, appRole, outsiderRole, userId, accountId });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    try {
      assert.equal((await client.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1::text[])', [roleNames])).rows[0].n, 0);
      const restored = (await client.query<{ relname: string; relowner: number }>(`SELECT c.relname,c.relowner FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE (n.nspname='core' AND c.relname='account') OR (n.nspname='otoapp' AND c.relname='login_lifecycle_events')
        ORDER BY n.nspname,c.relname`)).rows;
      assert.deepEqual(restored, original);
    } finally { client.release(); }
  }
}
async function applyGrant(client: pg.PoolClient, appRole: string) {
  if (grant) await asRole(client, appRole, () => client.query(grant));
}

await check('actual owner-derived SQL grants exactly queue SELECT INSERT UPDATE and replays without widening its ACL', () => fixture(async ({ client, apiRole, appRole }) => {
  assert.deepEqual(await tableCapabilities(client, apiRole, 'otoapp.login_lifecycle_events'), capabilities.map(() => false));
  await applyGrant(client, appRole);
  assert.deepEqual(await tableCapabilities(client, apiRole, 'otoapp.login_lifecycle_events'), [true,true,true,false,false,false,false]);
  const before = (await client.query("SELECT relacl::text AS acl FROM pg_class WHERE oid='otoapp.login_lifecycle_events'::regclass")).rows[0].acl;
  await applyGrant(client, appRole);
  assert.equal((await client.query("SELECT relacl::text AS acl FROM pg_class WHERE oid='otoapp.login_lifecycle_events'::regclass")).rows[0].acl, before);
}));

await check('the existing API users update fires the ordinary invoker trigger and its role can read and settle the exact event', () => fixture(async ({ client, apiRole, appRole, userId, accountId }) => {
  await applyGrant(client, appRole);
  assert.equal((await client.query(`SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='otoapp' AND p.proname='queue_login_lifecycle_event'`)).rows[0].prosecdef, false);
  await asRole(client, apiRole, () => client.query('UPDATE otoapp.users SET is_active=false WHERE id=$1', [userId]));
  const first = await asRole(client, apiRole, () => client.query('SELECT id,user_id,platform_account_id,state FROM otoapp.login_lifecycle_events WHERE user_id=$1', [userId]));
  assert.equal(first.rows.length, 1); assert.equal(first.rows[0].user_id, userId);
  assert.equal(first.rows[0].platform_account_id, accountId); assert.equal(first.rows[0].state, 'pending');
  await asRole(client, apiRole, () => client.query('UPDATE otoapp.users SET is_active=true WHERE id=$1', [userId]));
  assert.equal((await client.query('SELECT state FROM otoapp.login_lifecycle_events WHERE id=$1', [first.rows[0].id])).rows[0].state, 'superseded');
  await asRole(client, apiRole, () => client.query('UPDATE otoapp.users SET is_active=false WHERE id=$1', [userId]));
  const terminal = await asRole(client, apiRole, () => client.query(`UPDATE otoapp.login_lifecycle_events
    SET state='delivered',settled_at=now(),last_error_code=null WHERE user_id=$1 AND state='pending' RETURNING id`, [userId]));
  assert.equal(terminal.rows.length, 1); assert.notEqual(terminal.rows[0].id, first.rows[0].id);
}));

await check('the grant gives no PUBLIC or unrelated-role access and adds no app-to-core privilege', () => fixture(async ({ client, apiRole, appRole, outsiderRole }) => {
  const before = await tableCapabilities(client, appRole, 'core.account');
  assert.equal(before[1], false); assert.equal(before[2], false); assert.equal(before[3], false);
  await applyGrant(client, appRole);
  assert.deepEqual(await tableCapabilities(client, appRole, 'core.account'), before);
  assert.deepEqual(await tableCapabilities(client, outsiderRole, 'otoapp.login_lifecycle_events'), capabilities.map(() => false));
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_class c,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE c.oid='otoapp.login_lifecycle_events'::regclass AND acl.grantee=0`)).rows[0].n, 0);
  for (const statement of ['DELETE FROM otoapp.login_lifecycle_events', 'TRUNCATE otoapp.login_lifecycle_events']) {
    let code: string | undefined;
    try { await asRole(client, apiRole, () => client.query(statement)); } catch (error) { code = (error as { code?: string }).code; }
    assert.equal(code, '42501');
  }
}));

await check('the actual full migration installs without core and its access block can replay without inventing a recipient', async () => {
  const client = await pool.connect(), hiddenCore = identifier('zz_633_core_' + randomUUID().replaceAll('-', ''));
  try {
    await client.query('BEGIN');
    await client.query('DROP TRIGGER users_login_lifecycle_event ON otoapp.users');
    await client.query('DROP FUNCTION otoapp.queue_login_lifecycle_event()');
    await client.query('DROP TABLE otoapp.login_lifecycle_events');
    await client.query(`ALTER SCHEMA core RENAME TO ${hiddenCore}`);
    const before = (await client.query('SELECT count(*)::int AS n FROM otoapp.users')).rows[0].n;
    await client.query(migration);
    if (grant) { await client.query(grant); await client.query(grant); }
    assert.equal((await client.query('SELECT count(*)::int AS n FROM otoapp.users')).rows[0].n, before);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_class WHERE oid='otoapp.login_lifecycle_events'::regclass")).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM otoapp.login_lifecycle_events')).rows[0].n, 0);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_class c,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      WHERE c.oid='otoapp.login_lifecycle_events'::regclass AND acl.grantee<>c.relowner`)).rows[0].n, 0);
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
});

await pool.end();
const passed = Object.values(results).filter(Boolean).length;
console.log(`s633-lifecycle-privileges.check: ${passed}/${Object.keys(results).length} checks passed`);
if (passed !== Object.keys(results).length) process.exitCode = 1;
