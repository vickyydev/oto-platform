// SCRUM-778/781/810: real PostgreSQL, owned fixtures, injected HTTP only.
//
// SCRUM-852 (the second half of this file): an outage never parks a switch-off
// — only the platform's own refusal does, after its six tries — and a parked
// event is said on the employee's Access & Login panel with "Send again". The
// queue's rules run in rolled-back transactions; the route is driven over HTTP
// on the app's real routes (tests/harness/serve-routes.ts) with rows committed
// to this file's own database, which the suite drops.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import pg from 'pg';
import {
  classifyLifecycleRefusal, drainPlatformLifecycleEvents, lifecycleWarnGate, readPlatformLifecycleEvents,
  requeueParkedLifecycleEvent, startPlatformLifecycleTransport,
} from '../server/lib/platformLifecycle';
import { lifecycleRefusalWords, parkedLifecycleNotices } from '../shared/loginLifecycle';

let target: URL;
try { target = new URL(process.env.DATABASE_URL ?? ''); } catch { throw new Error('Isolated lifecycle database required'); }
if (process.env.SCRUM_633_LIFECYCLE_TESTS !== '1' || target.hostname !== process.env.SCRUM_633_EXPECT_DB_HOST
  || target.pathname.slice(1) !== process.env.SCRUM_633_EXPECT_DB_NAME || !/^zz_test_633_[a-z0-9_]+$/.test(target.pathname.slice(1))) {
  throw new Error('Isolated lifecycle database guard refused');
}
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=otoapp', max: 4 });
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
type Queryable = Pick<pg.Pool, 'query'>;
const read = async (client: Queryable, event: string) => (await client.query(`SELECT *,
  extract(epoch FROM next_attempt_at-now())::int AS delay FROM login_lifecycle_events WHERE id=$1`, [event])).rows[0];
const due = (client: Queryable, event: string) => client.query('UPDATE login_lifecycle_events SET next_attempt_at=now() WHERE id=$1', [event]);
const park = (client: Queryable, event: string, code = 'RETRY_LIMIT:LAST_OPERATOR_ADMIN') => client.query(
  'UPDATE login_lifecycle_events SET next_attempt_at=NULL,attempt_count=6,last_error_code=$2 WHERE id=$1', [event, code]);
const config = { apiUrl: 'https://platform.invalid', key: 'ZZ TEST unused injected key' };
// The platform's refusal as its error handler sends it: an envelope with its code.
const refusal = (code: string, status = 409) => async () => new Response(
  JSON.stringify({ error: { code, message: 'PRIVATE_MESSAGE' } }), { status, headers: { 'content-type': 'application/json' } });
const refused = refusal('LAST_OPERATOR_ADMIN');
/** The platform's half of a delivery: it settles the event in the shared queue, then acknowledges. */
const delivering = (client: Queryable) => async (_url: string, init: RequestInit) => {
  const { eventId } = JSON.parse(String(init.body)) as { eventId: string };
  await client.query("UPDATE login_lifecycle_events SET state='delivered',settled_at=now(),last_error_code=NULL WHERE id=$1 AND state='pending'", [eventId]);
  return new Response(JSON.stringify({ ok: true, eventId, state: 'delivered', replayed: false }), { status: 200 });
};
const BACKOFF = [30, 60, 120, 240, 480, 900];
const delayAfter = (attempt: number) => BACKOFF[Math.min(attempt, BACKOFF.length) - 1];

await check('HIGH: a refusal from the platform backs off through six attempts, then parks under the platform\'s own code', () => fixture(async (client, _user, _tenant, event) => {
  let calls = 0;
  const dependencies = { database: client, config, fetch: async () => { calls++; return refused(); } };
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (attempt > 1) await due(client, event);
    const summary = await drainPlatformLifecycleEvents(dependencies);
    assert.equal(summary.failed, 1); assert.deepEqual(summary.causes, ['LAST_OPERATOR_ADMIN']);
    assert.equal(summary.parked, attempt === 6 ? 1 : 0);
    const row = await read(client, event);
    assert.equal(row.attempt_count, attempt);
    assert.equal(row.state, 'pending');
    assert.equal(row.delay, attempt === 6 ? null : 30 * 2 ** (attempt - 1));
    assert.equal(row.last_error_code, attempt === 6 ? 'RETRY_LIMIT:LAST_OPERATOR_ADMIN' : 'LAST_OPERATOR_ADMIN');
    assert.equal((await drainPlatformLifecycleEvents({ ...dependencies })).selected, 0);
  }
  assert.equal(calls, 6);
  assert.equal(JSON.stringify(await read(client, event)).includes('PRIVATE_'), false);
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
  for (const row of rows) { assert.equal(row.state, 'superseded'); assert.ok(row.settledAt); assert.equal(row.nextAttemptAt, null); assert.equal(row.lastErrorCode, 'LOGIN_DELETED'); assert.equal(row.parked, false); }
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
await check('HIGH: absent transport configuration backs off the same, stores no secret detail and never parks (SCRUM-852)', () => fixture(async (client, _user, _tenant, event) => {
  const dependencies = { database: client, config: null, fetch: async () => { throw new Error('HTTP must not run'); } };
  for (let attempt = 1; attempt <= 8; attempt++) {
    if (attempt > 1) await due(client, event);
    const summary = await drainPlatformLifecycleEvents(dependencies);
    assert.equal(summary.parked, 0); assert.deepEqual(summary.causes, ['PLATFORM_UNCONFIGURED']);
    const row = await read(client, event);
    assert.equal(row.attempt_count, attempt); assert.equal(row.delay, delayAfter(attempt)); assert.equal(row.last_error_code, 'PLATFORM_UNCONFIGURED');
  }
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
await check('HIGH: support readback validates identity; the read and Send again both sit behind sign-in, admin and the park group', async () => {
  await assert.rejects(readPlatformLifecycleEvents(pool, 'invalid', randomUUID()));
  await assert.rejects(readPlatformLifecycleEvents(pool, randomUUID(), 'invalid'));
  await assert.rejects(requeueParkedLifecycleEvent(pool, 'invalid', randomUUID(), randomUUID()));
  await assert.rejects(requeueParkedLifecycleEvent(pool, randomUUID(), 'invalid', randomUUID()));
  const routes = readFileSync(new URL('../server/routes.ts', import.meta.url), 'utf8');
  const route = routes.slice(routes.indexOf('app.get("/api/admin/login-lifecycle"'), routes.indexOf('app.get("/api/admin/login-lifecycle"') + 800);
  assert.match(route, /requireAuth, requireAdmin, parkGroupOnly\(userManagementTenant\)/);
  assert.match(route, /readPlatformLifecycleEvents\(pool, parkGroupOf\(res\), parsed.data.userId\)/);
  const at = routes.indexOf('app.post("/api/admin/login-lifecycle/send-again"');
  assert.ok(at > 0); const post = routes.slice(at, at + 900);
  assert.match(post, /^app\.post\("\/api\/admin\/login-lifecycle\/send-again", requireAuth, requireAdmin, parkGroupOnly\(userManagementTenant\)/);
  assert.match(post, /requeueParkedLifecycleEvent\(pool, parkGroupOf\(res\), parsed.data.eventId, req.user.id\)/);
});

// ─── SCRUM-852: an outage never parks ────────────────────────────────────────

await check('HIGH (852): an unreachable platform for 20 attempts never parks and the delay holds at the 15 minute cap', () => fixture(async (client, _user, tenant, event) => {
  let calls = 0;
  const dependencies = { database: client, config, fetch: async () => { calls++; throw new Error('PRIVATE_NETWORK_DETAIL'); } };
  for (let attempt = 1; attempt <= 20; attempt++) {
    if (attempt > 1) await due(client, event);
    const summary = await drainPlatformLifecycleEvents(dependencies);
    assert.equal(summary.failed, 1); assert.equal(summary.parked, 0); assert.deepEqual(summary.causes, ['PLATFORM_UNREACHABLE']);
    const row = await read(client, event);
    assert.equal(row.state, 'pending'); assert.equal(row.attempt_count, attempt);
    assert.equal(row.delay, delayAfter(attempt)); assert.equal(row.last_error_code, 'PLATFORM_UNREACHABLE');
    // Not due again before its time: the outage is not hammered.
    assert.equal((await drainPlatformLifecycleEvents(dependencies)).selected, 0);
  }
  assert.equal(calls, 20);
  // Weeks into an outage the delay is still the cap, never an overflow and never a park.
  await client.query('UPDATE login_lifecycle_events SET attempt_count=50000,next_attempt_at=now() WHERE id=$1', [event]);
  assert.equal((await drainPlatformLifecycleEvents(dependencies)).parked, 0);
  const late = await read(client, event);
  assert.equal(late.attempt_count, 50001); assert.equal(late.delay, 900); assert.equal(late.state, 'pending');
  // The outage wrote nothing to the app's activity log, and the platform is back: it is delivered.
  assert.equal((await client.query('SELECT count(*)::int AS n FROM activity_log WHERE tenant_id=$1', [tenant])).rows[0].n, 0);
  await due(client, event);
  assert.equal((await drainPlatformLifecycleEvents({ database: client, config, fetch: delivering(client) })).delivered, 1);
  assert.equal((await read(client, event)).state, 'delivered');
}));
await check('HIGH (852): a 5xx for 20 attempts never parks; a busy platform, a refused key and an unreadable answer never park either', async () => {
  const cases: Array<[string, number, () => Promise<Response>]> = [
    ['PLATFORM_UNAVAILABLE', 20, async () => new Response('PRIVATE_BODY', { status: 503 })],
    ['PLATFORM_UNAVAILABLE', 8, async () => new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'PRIVATE_MESSAGE' } }), { status: 500 })],
    ['PLATFORM_UNAVAILABLE', 8, async () => new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status: 429 })],
    ['PLATFORM_KEY_REFUSED', 8, refusal('OTOAPP_PROVISION_UNAUTHORIZED', 401)],
    ['PLATFORM_KEY_REFUSED', 8, async () => new Response('PRIVATE_BODY', { status: 403 })],
    // A platform without the door yet (mid-rollout), then a proxy's 404 page: neither is an answer about the event.
    ['PLATFORM_DOOR_MISSING', 8, refusal('ROUTE_NOT_FOUND', 404)],
    ['PLATFORM_RESPONSE_INVALID', 8, async () => new Response('<html>PRIVATE_BODY</html>', { status: 404 })],
    ['PLATFORM_RESPONSE_INVALID', 8, async () => new Response('PRIVATE_BODY', { status: 200 })],
    ['PLATFORM_RESPONSE_INVALID', 8, async () => new Response(JSON.stringify({ ok: true, eventId: randomUUID(), state: 'delivered', replayed: false }), { status: 200 })],
  ];
  for (const [code, attempts, respond] of cases) await fixture(async (client, _user, _tenant, event) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await due(client, event);
      const summary = await drainPlatformLifecycleEvents({ database: client, config, fetch: respond });
      assert.equal(summary.parked, 0); assert.deepEqual(summary.causes, [code]);
      const row = await read(client, event);
      assert.equal(row.state, 'pending'); assert.equal(row.attempt_count, attempt);
      assert.equal(row.delay, delayAfter(attempt)); assert.equal(row.last_error_code, code);
      assert.equal(JSON.stringify(row).includes('PRIVATE_'), false);
    }
  });
});
await check('HIGH (852): the classification — only a 4xx carrying the platform\'s own code is a refusal', () => {
  const envelope = (code: unknown) => ({ error: { code, message: 'x' } });
  for (const status of [500, 502, 503, 504, 408, 425, 429]) assert.deepEqual(classifyLifecycleRefusal(status, envelope('ANY_CODE')), { code: 'PLATFORM_UNAVAILABLE', definite: false });
  for (const status of [401, 403, 407]) assert.deepEqual(classifyLifecycleRefusal(status, envelope('OTOAPP_PROVISION_UNAUTHORIZED')), { code: 'PLATFORM_KEY_REFUSED', definite: false });
  assert.deepEqual(classifyLifecycleRefusal(409, envelope('LAST_OPERATOR_ADMIN')), { code: 'LAST_OPERATOR_ADMIN', definite: true });
  assert.deepEqual(classifyLifecycleRefusal(404, envelope('NOT_FOUND')), { code: 'NOT_FOUND', definite: true });
  assert.deepEqual(classifyLifecycleRefusal(404, envelope('ROUTE_NOT_FOUND')), { code: 'PLATFORM_DOOR_MISSING', definite: false });
  assert.deepEqual(classifyLifecycleRefusal(400, envelope('VALIDATION_ERROR')), { code: 'VALIDATION_ERROR', definite: true });
  assert.deepEqual(classifyLifecycleRefusal(409, envelope('OTOAPP_LIFECYCLE_CHANGED')), { code: 'OTOAPP_LIFECYCLE_CHANGED', definite: true });
  // No envelope, an unsafe code, or one of this transport's own words: never a refusal, never stored.
  for (const body of [null, 'text', {}, { error: null }, envelope(null), envelope(7), envelope('lower_case'), envelope('HAS SPACE'),
    envelope('X'), envelope('A'.repeat(65)), envelope("X'; DROP TABLE users;--"), envelope('PLATFORM_UNREACHABLE'), envelope('PLATFORM_HTTP_REFUSED'),
    envelope('LOCAL_QUEUE_ERROR'), envelope('RETRY_LIMIT_REACHED'), envelope('RETRY_LIMIT:NOT_FOUND'), envelope('LOGIN_DELETED')]) {
    assert.deepEqual(classifyLifecycleRefusal(409, body), { code: 'PLATFORM_RESPONSE_INVALID', definite: false });
  }
  for (const status of [204, 301, 302, 304]) assert.equal(classifyLifecycleRefusal(status, envelope('NOT_FOUND')).definite, false);
});
await check('HIGH (852): a forged or unsafe platform code is never stored and never parks', async () => {
  for (const code of ['PRIVATE_lower case', 'PLATFORM_UNREACHABLE', 'RETRY_LIMIT_REACHED']) await fixture(async (client, _user, _tenant, event) => {
    for (let attempt = 1; attempt <= 7; attempt++) {
      if (attempt > 1) await due(client, event);
      assert.equal((await drainPlatformLifecycleEvents({ database: client, config, fetch: refusal(code) })).parked, 0);
    }
    const row = await read(client, event);
    assert.equal(row.last_error_code, 'PLATFORM_RESPONSE_INVALID'); assert.equal(row.delay, 900); assert.equal(row.state, 'pending');
  });
});
await check('HIGH (852): refusals below the ceiling followed by an outage never park; a refusal after a long outage parks at once', async () => {
  await fixture(async (client, _user, _tenant, event) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await due(client, event);
      await drainPlatformLifecycleEvents({ database: client, config, fetch: refused });
    }
    for (let attempt = 4; attempt <= 12; attempt++) {
      await due(client, event);
      const summary = await drainPlatformLifecycleEvents({ database: client, config, fetch: async () => { throw new Error('down'); } });
      assert.equal(summary.parked, 0);
      const row = await read(client, event);
      assert.equal(row.delay, delayAfter(attempt)); assert.equal(row.last_error_code, 'PLATFORM_UNREACHABLE');
    }
    // The platform is back and still refuses: the event has had its six tries, so it is shown now.
    await due(client, event);
    assert.equal((await drainPlatformLifecycleEvents({ database: client, config, fetch: refused })).parked, 1);
    const row = await read(client, event);
    assert.equal(row.next_attempt_at, null); assert.equal(row.last_error_code, 'RETRY_LIMIT:LAST_OPERATOR_ADMIN'); assert.equal(row.state, 'pending');
  });
});
await check('HIGH (852): a row the older rule parked without a refusal goes back in the queue; a refused one stays parked', async () => {
  for (const legacy of ['RETRY_LIMIT:PLATFORM_UNREACHABLE', 'RETRY_LIMIT:PLATFORM_HTTP_REFUSED', 'RETRY_LIMIT:PLATFORM_UNCONFIGURED',
    'RETRY_LIMIT:PLATFORM_RESPONSE_INVALID', 'RETRY_LIMIT_REACHED', 'RETRY_LIMIT:UNKNOWN']) await fixture(async (client, _user, _tenant, event) => {
    await park(client, event, legacy);
    const summary = await drainPlatformLifecycleEvents({ database: client, config, fetch: delivering(client) });
    assert.equal(summary.selected, 1); assert.equal(summary.delivered, 1);
    assert.equal((await read(client, event)).state, 'delivered');
  });
  // Put back, and the platform really does refuse: parked again at once, under the platform's code, and not put back twice.
  await fixture(async (client, _user, _tenant, event) => {
    await park(client, event, 'RETRY_LIMIT:PLATFORM_HTTP_REFUSED');
    assert.equal((await drainPlatformLifecycleEvents({ database: client, config, fetch: refused })).parked, 1);
    assert.equal((await read(client, event)).last_error_code, 'RETRY_LIMIT:LAST_OPERATOR_ADMIN');
    let calls = 0;
    assert.equal((await drainPlatformLifecycleEvents({ database: client, config, fetch: async () => { calls++; return refused(); } })).selected, 0);
    assert.equal(calls, 0); assert.equal((await read(client, event)).next_attempt_at, null);
  });
});

// ─── SCRUM-852: a parked event is sent again ─────────────────────────────────

await check('HIGH (852): Send again re-queues the parked event once, with its activity row; it is tried again and delivers', () => fixture(async (client, user, tenant, event) => {
  await park(client, event);
  const [shown] = await readPlatformLifecycleEvents(client, tenant, user);
  assert.equal(shown.id, event); assert.equal(shown.parked, true);
  // Another park group's administrator: not found, nothing written.
  const other = randomUUID();
  await client.query("INSERT INTO tenants(id,name,slug) VALUES ($1,'ZZ TEST other tenant',$2)", [other, `zz-test-${other}`]);
  assert.deepEqual(await requeueParkedLifecycleEvent(client, other, event, user), { outcome: 'not_found' });
  assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, randomUUID(), user), { outcome: 'not_found' });
  assert.equal((await read(client, event)).next_attempt_at, null);
  assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, event, user), { outcome: 'requeued', eventId: event, kind: 'deactivate' });
  const row = await read(client, event);
  assert.equal(row.state, 'pending'); assert.equal(row.attempt_count, 0); assert.equal(row.last_error_code, null); assert.ok(row.delay <= 0);
  assert.equal((await readPlatformLifecycleEvents(client, tenant, user))[0].parked, false);
  // The second press (another administrator, a double click): refused, and still one activity row.
  assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, event, user), { outcome: 'not_parked' });
  const logged = (await client.query('SELECT * FROM activity_log WHERE tenant_id=$1', [tenant])).rows;
  assert.equal(logged.length, 1);
  assert.equal(logged[0].activity_type, 'USER_PLATFORM_LIFECYCLE_RESENT'); assert.equal(logged[0].created_by, user);
  assert.equal(logged[0].summary_text, 'Sent the login switch-off for ZZ TEST retry login to the platform again');
  assert.deepEqual(JSON.parse(logged[0].metadata_json), { eventId: event, kind: 'deactivate', userId: user,
    previousReason: 'RETRY_LIMIT:LAST_OPERATOR_ADMIN', previousAttempts: 6 });
  // Tried again: still refused, it has six tries afresh; then the platform takes it.
  assert.equal((await drainPlatformLifecycleEvents({ database: client, config, fetch: refused })).parked, 0);
  assert.equal((await read(client, event)).attempt_count, 1);
  await due(client, event);
  assert.equal((await drainPlatformLifecycleEvents({ database: client, config, fetch: delivering(client) })).delivered, 1);
  assert.equal((await read(client, event)).state, 'delivered');
  assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, event, user), { outcome: 'not_parked' });
}));
await check('HIGH (852): Send again never sends a stale event — a login switched back on, re-stamped, replaced by a newer event, or out of pay only', async () => {
  // Switched back on: the app's own trigger settles the parked event, so there is nothing to send.
  await fixture(async (client, user, tenant, event) => {
    await park(client, event);
    await client.query('UPDATE users SET is_active=true WHERE id=$1', [user]);
    assert.equal((await read(client, event)).state, 'superseded');
    assert.equal((await readPlatformLifecycleEvents(client, tenant, user))[0].parked, false);
    assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, event, user), { outcome: 'not_parked' });
    // Switched off again: a new event; the old one stays settled and is never the one sent.
    await client.query('UPDATE users SET is_active=false WHERE id=$1', [user]);
    assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, event, user), { outcome: 'not_parked' });
  });
  // The trigger's rule held again at the button, should a row ever be parked and stale.
  await fixture(async (client, user, tenant, event) => {
    await client.query('ALTER TABLE users DISABLE TRIGGER users_login_lifecycle_event');
    await park(client, event);
    await client.query('UPDATE users SET is_active=true WHERE id=$1', [user]);
    assert.equal((await read(client, event)).state, 'pending');
    assert.equal((await readPlatformLifecycleEvents(client, tenant, user))[0].parked, false);
    assert.deepEqual(parkedLifecycleNotices(await readPlatformLifecycleEvents(client, tenant, user)), []);
    assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, event, user), { outcome: 'moved_on' });
    assert.equal((await read(client, event)).next_attempt_at, null);
    await client.query('UPDATE users SET is_active=false WHERE id=$1', [user]);
    assert.equal((await readPlatformLifecycleEvents(client, tenant, user))[0].parked, true);
    // Stamped with another platform account since: the event names an account this login no longer is.
    await client.query('UPDATE users SET platform_user_id=$2 WHERE id=$1', [user, randomUUID()]);
    assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, event, user), { outcome: 'moved_on' });
    assert.equal((await client.query('SELECT count(*)::int AS n FROM activity_log WHERE tenant_id=$1', [tenant])).rows[0].n, 0);
  });
  // A newer event of the same kind replaced it: only the newest is ever sent.
  await fixture(async (client, user, tenant, event) => {
    await park(client, event);
    const newer = randomUUID();
    await client.query(`INSERT INTO login_lifecycle_events(id,user_id,platform_account_id,created_at)
      SELECT $1,id,platform_user_id,now()+interval '1 second' FROM users WHERE id=$2`, [newer, user]);
    await park(client, newer);
    const rows = await readPlatformLifecycleEvents(client, tenant, user);
    assert.deepEqual(rows.map(row => [row.id, row.parked]), [[newer, true], [event, false]]);
    assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, event, user), { outcome: 'moved_on' });
    assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, newer, user), { outcome: 'requeued', eventId: newer, kind: 'deactivate' });
  });
  // A restriction: sent again while the login is in pay only, never after it is lifted.
  await fixture(async (client, user, tenant) => {
    await client.query('UPDATE users SET is_active=true WHERE id=$1', [user]);
    await client.query("UPDATE users SET access_mode='pay_only' WHERE id=$1", [user]);
    const restrict = (await client.query("SELECT id FROM login_lifecycle_events WHERE user_id=$1 AND kind='restrict'", [user])).rows[0].id;
    await park(client, restrict);
    const notices = parkedLifecycleNotices(await readPlatformLifecycleEvents(client, tenant, user));
    assert.deepEqual(notices.map(n => [n.eventId, n.kind]), [[restrict, 'restrict']]);
    assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, restrict, user), { outcome: 'requeued', eventId: restrict, kind: 'restrict' });
    assert.equal((await client.query('SELECT summary_text FROM activity_log WHERE tenant_id=$1', [tenant])).rows[0].summary_text,
      'Sent the pay-only restriction for ZZ TEST retry login to the platform again');
    await park(client, restrict);
    await client.query("UPDATE users SET access_mode='full' WHERE id=$1", [user]);
    assert.equal((await read(client, restrict)).state, 'superseded');
    assert.deepEqual(await requeueParkedLifecycleEvent(client, tenant, restrict, user), { outcome: 'not_parked' });
  });
});

// ─── SCRUM-852: a long outage does not refill the log ────────────────────────

await check('HIGH (852): a day-long outage writes one log line an hour for its cause, a new cause is named at once, and nothing else', async () => {
  // The gate alone, over 24 hours of 30 second ticks with an attempt every 15 minutes.
  const gate = lifecycleWarnGate();
  let lines = 0;
  for (let t = 0; t <= 24 * 3600_000; t += 30_000) lines += gate(t % 900_000 === 0 ? ['PLATFORM_UNREACHABLE'] : [], t).length ? 1 : 0;
  assert.ok(lines >= 24 && lines <= 25, `lines ${lines}`);
  assert.deepEqual(gate(['PLATFORM_UNREACHABLE', 'PLATFORM_UNAVAILABLE'], 24 * 3600_000 + 30_000), ['PLATFORM_UNAVAILABLE']);
  assert.deepEqual(gate(['PLATFORM_UNAVAILABLE'], 24 * 3600_000 + 60_000), []);
  // The transport itself, with an event failing on EVERY tick (worse than any backoff allows).
  const event = { id: randomUUID(), user_id: randomUUID(), platform_account_id: randomUUID(), state: 'pending', kind: 'deactivate' };
  const database = { async query(sql: string) { return { rows: /^\s*SELECT/i.test(sql) ? [event] : [], rowCount: 1 }; } };
  let respond: () => Promise<Response> = async () => { throw new Error('PRIVATE_NETWORK_DETAIL'); };
  const warned: string[] = [], original = console.warn;
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-11-11T00:00:00Z') });
  console.warn = (...args: unknown[]) => { warned.push(args.join(' ')); };
  let stop = () => {};
  try {
    stop = startPlatformLifecycleTransport({ database: database as never, config, fetch: () => respond() });
    await flush();
    for (let tick = 1; tick < 200; tick++) { mock.timers.tick(30_000); await flush(); }
    // 200 failed attempts over 100 minutes: the first, and one an hour later.
    assert.equal(warned.length, 2, warned.join(' | '));
    assert.ok(warned.every(line => /^\[PLATFORM_LIFECYCLE\] 1 delivery attempt\(s\) did not settle \(PLATFORM_UNREACHABLE\)$/.test(line)));
    respond = async () => new Response('PRIVATE_BODY', { status: 503 });
    for (let tick = 0; tick < 20; tick++) { mock.timers.tick(30_000); await flush(); }
    assert.equal(warned.length, 3);
    assert.match(warned[2], /\(PLATFORM_UNAVAILABLE\)/);
    assert.equal(warned.join(' ').includes('PRIVATE_'), false);
  } finally { stop(); console.warn = original; mock.timers.reset(); }
});

// ─── SCRUM-852: the line and the button ──────────────────────────────────────

await check('HIGH (852): the panel says one plain line per parked event with a Send again button, and nothing otherwise', () => {
  const at = (kind: 'deactivate' | 'restrict', lastErrorCode: string | null, parked = true) =>
    ({ id: randomUUID(), kind, state: 'pending' as const, lastErrorCode, parked });
  assert.equal(parkedLifecycleNotices([at('deactivate', 'RETRY_LIMIT:LAST_OPERATOR_ADMIN')])[0].line,
    'The platform was not told to switch this login off: this person is the only administrator who can hand out access there. Give somebody else an administrator role on the platform first.');
  assert.equal(parkedLifecycleNotices([at('restrict', 'RETRY_LIMIT:NOT_FOUND')])[0].line,
    'The platform was not told to limit this login to My pay: the platform could not match this login to an account of this park.');
  assert.equal(lifecycleRefusalWords('RETRY_LIMIT:SOME_NEW_CODE'), 'the platform refused it (SOME_NEW_CODE).');
  for (const unsafe of [null, '', 'RETRY_LIMIT_REACHED', '<b>x</b>', 'lower']) assert.equal(lifecycleRefusalWords(unsafe), 'the platform refused it.');
  // Not parked (retrying through an outage, delivered, superseded): no line.
  assert.deepEqual(parkedLifecycleNotices([at('deactivate', 'PLATFORM_UNREACHABLE', false), { ...at('restrict', null, false), state: 'delivered' as const }]), []);
  // One line per kind, the newest marked one.
  const both = [at('restrict', 'RETRY_LIMIT:NOT_FOUND'), at('deactivate', 'RETRY_LIMIT:NOT_FOUND'), at('deactivate', 'RETRY_LIMIT:NOT_FOUND')];
  assert.deepEqual(parkedLifecycleNotices(both).map(n => n.eventId), [both[1].id, both[0].id]);

  // The component as the bundler gives it, rendered to markup.
  const built = buildSync({
    absWorkingDir: APP_DIR, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    tsconfig: join(APP_DIR, 'tests', 'tsconfig.jsx.json'), logLevel: 'silent',
    define: { 'import.meta.env': '{}', 'import.meta.url': JSON.stringify('file:///s778-lifecycle-ui.native.cjs') },
    stdin: { resolveDir: APP_DIR, loader: 'tsx', contents: `
      export * as React from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
      export { LoginLifecycleNoticeLines } from './client/src/components/login-lifecycle-notice';` },
  });
  const nativeRequire = createRequire(join(APP_DIR, 'package.json'));
  const compiled = new Module(join(APP_DIR, 'tests', 's778-lifecycle-ui.native.cjs')) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
  compiled.filename = join(APP_DIR, 'tests', 's778-lifecycle-ui.native.cjs');
  compiled.paths = nativeRequire.resolve.paths('react');
  compiled._compile(built.outputFiles[0].text, compiled.filename);
  const { React, renderToStaticMarkup, LoginLifecycleNoticeLines } = compiled.exports;
  const notices = parkedLifecycleNotices([at('deactivate', 'RETRY_LIMIT:LAST_OPERATOR_ADMIN')]);
  const render = (props: Record<string, unknown>) => String(renderToStaticMarkup(React.createElement(LoginLifecycleNoticeLines, props)))
    .replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
  const html = render({ notices, sendingEventId: null, onSendAgain: () => {} });
  assert.ok(html.includes('data-testid="login-lifecycle-parked-deactivate"'));
  assert.ok(html.includes(`<p class="text-sm">${notices[0].line}</p>`));
  assert.match(html, /<button[^>]*data-testid="button-login-lifecycle-send-again-deactivate"[^>]*>Send again<\/button>/);
  assert.doesNotMatch(html, / disabled=""/);
  // The panel's own notice style (the reserved sign-in notice beside it).
  assert.ok(html.includes('class="space-y-2 rounded-lg border p-3"'));
  assert.match(render({ notices, sendingEventId: notices[0].eventId, onSendAgain: () => {} }), /<button[^>]* disabled=""/);
  assert.equal(render({ notices: [], sendingEventId: null, onSendAgain: () => {} }), '');
  // Mounted in the employee's Access & Login panel, read for administrators only.
  const page = readFileSync(join(APP_DIR, 'client/src/pages/employee-editor-page.tsx'), 'utf8');
  assert.ok(page.includes('const parkedLifecycle = useParkedLoginLifecycle(employee.userId, isAdmin);'));
  assert.ok(page.includes('{employee.userId && <LoginLifecycleNotice userId={employee.userId} notices={parkedLifecycle} />}'));
  const component = readFileSync(join(APP_DIR, 'client/src/components/login-lifecycle-notice.tsx'), 'utf8');
  assert.ok(component.includes('enabled: isAdmin && !!userId'));
  assert.ok(component.includes('apiRequest("POST", "/api/admin/login-lifecycle/send-again", { eventId })'));
});

// ─── SCRUM-852: the route, over HTTP on the routes as registered ─────────────

let harness: ChildProcess | undefined;
function stopHarness() {
  if (!harness?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(harness.pid), '/T', '/F'], { stdio: 'ignore' });
  else harness.kill('SIGKILL');
  harness = undefined;
}
async function serve(): Promise<string> {
  const child = spawn(process.execPath, [join(APP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: APP_DIR, env: { ...process.env, OTOAPP_LEGACY_LOGIN: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness = child;
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('harness did not start')), 80_000);
    const seen = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const port = /HARNESS_PORT=(\d+)/.exec(output);
      if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port[1]}`); }
    };
    child.stdout!.on('data', seen); child.stderr!.on('data', seen);
    child.on('exit', () => { clearTimeout(timer); reject(new Error('harness exited')); });
  });
}
await check('HIGH (852): the Send again route — signed in, an administrator, their own park group, a parked event; two presses at once send one', async () => {
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
  const PASSWORD = 'zz-test-password', run = randomBytes(3).toString('hex');
  const hash = (password: string) => { const salt = randomBytes(16).toString('hex'); return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`; };
  const tenant = randomUUID(), otherTenant = randomUUID(), branch = randomUUID();
  await q("INSERT INTO tenants(id,name,slug) VALUES ($1,$2,$3),($4,$5,$6)", [tenant, `ZZ TEST 852 ${run}`, `zz-852-${run}`, otherTenant, `ZZ TEST 852 other ${run}`, `zz-852-other-${run}`]);
  await q("INSERT INTO branches(id,tenant_id,name,address) VALUES ($1,$2,$3,'ZZ TEST')", [branch, tenant, `ZZ TEST 852 park ${run}`]);
  const person = async (role: string, of: string, platform = false) => {
    const id = randomUUID(), email = `zz-852-${role}-${id.slice(0, 6)}-${run}@example.com`;
    await q(`INSERT INTO users(id,email,password,full_name,role,is_active,must_change_password,platform_user_id)
      VALUES ($1,$2,$3,$4,$5,true,false,$6)`, [id, email, hash(PASSWORD), `ZZ TEST 852 ${role}`, role, platform ? randomUUID() : null]);
    await q("INSERT INTO user_branch_access(tenant_id,user_id,branch_id,access_scope) VALUES ($1,$2,null,'all_branches')", [of, id]);
    return { id, email };
  };
  const admin = await person('global_admin', tenant), secondAdmin = await person('admin', tenant);
  const manager = await person('manager', tenant), staff = await person('staff', tenant);
  const outsider = await person('global_admin', otherTenant), leaver = await person('staff', tenant, true);
  const employee = randomUUID();
  await q(`INSERT INTO employees(id,tenant_id,branch_id,full_name,nickname,email,status,user_id)
    VALUES ($1,$2,$3,'ZZ TEST 852 leaver','ZZ',$4,'active',$5)`, [employee, tenant, branch, `zz-852-leaver-${run}@example.com`, leaver.id]);
  await q('UPDATE users SET is_active=false WHERE id=$1', [leaver.id]);
  const event = (await q('SELECT id FROM login_lifecycle_events WHERE user_id=$1', [leaver.id]))[0].id as string;
  await park(pool, event);
  try {
    const origin = await serve();
    const signIn = async (who: { email: string }) => {
      const res = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: who.email, password: PASSWORD }) });
      assert.equal(res.status, 200);
      return res.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    };
    const call = async (method: string, path: string, cookie: string, payload?: unknown) => {
      const res = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', cookie },
        body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}) });
      const text = await res.text();
      let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
      try { body = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, body };
    };
    const SEND = '/api/admin/login-lifecycle/send-again', READ = `/api/admin/login-lifecycle?userId=${leaver.id}`;
    const cookies = { admin: await signIn(admin), second: await signIn(secondAdmin), manager: await signIn(manager), staff: await signIn(staff), outsider: await signIn(outsider) };
    const untouched = async () => { const row = await read(pool, event); assert.equal(row.next_attempt_at, null); assert.equal(row.attempt_count, 6); };

    // The read marks it for the administrator; nobody else reads it.
    const shown = await call('GET', READ, cookies.admin);
    assert.equal(shown.status, 200); assert.equal(shown.body.events.length, 1);
    assert.equal(shown.body.events[0].id, event); assert.equal(shown.body.events[0].parked, true);
    assert.equal(parkedLifecycleNotices(shown.body.events).length, 1);
    assert.equal((await call('GET', READ, cookies.manager)).status, 403);
    assert.deepEqual((await call('GET', READ, cookies.outsider)).body, { events: [] });

    // Refused: not signed in, not an administrator, another park group, a bad body, an unknown event.
    assert.equal((await call('POST', SEND, '', { eventId: event })).status, 401);
    assert.equal((await call('POST', SEND, cookies.staff, { eventId: event })).status, 403);
    assert.equal((await call('POST', SEND, cookies.manager, { eventId: event })).status, 403);
    const foreign = await call('POST', SEND, cookies.outsider, { eventId: event });
    assert.deepEqual([foreign.status, foreign.body], [404, { message: 'That event was not found.' }]);
    assert.equal((await call('POST', SEND, cookies.admin, { eventId: 'not-an-id' })).status, 400);
    assert.equal((await call('POST', SEND, cookies.admin, { eventId: event, userId: leaver.id })).status, 400);
    assert.equal((await call('POST', SEND, cookies.admin, { eventId: randomUUID() })).status, 404);
    await untouched();
    assert.equal((await q('SELECT count(*)::int AS n FROM activity_log WHERE tenant_id = ANY($1)', [[tenant, otherTenant]]))[0].n, 0);

    // Two administrators press at once: one re-queue, one activity row.
    const presses = await Promise.all([call('POST', SEND, cookies.admin, { eventId: event }), call('POST', SEND, cookies.second, { eventId: event })]);
    assert.deepEqual(presses.map(press => press.status).sort(), [200, 409]);
    assert.deepEqual(presses.find(press => press.status === 200)!.body, { ok: true, eventId: event, kind: 'deactivate' });
    assert.deepEqual(presses.find(press => press.status === 409)!.body, { message: 'This is no longer waiting: it was already sent again, or the platform has it now.' });
    const logged = await q('SELECT * FROM activity_log WHERE tenant_id=$1', [tenant]);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].activity_type, 'USER_PLATFORM_LIFECYCLE_RESENT'); assert.equal(logged[0].employee_id, employee);
    assert.ok([admin.id, secondAdmin.id].includes(logged[0].created_by));
    const queued = await read(pool, event);
    assert.equal(queued.attempt_count, 0); assert.equal(queued.state, 'pending'); assert.ok(queued.delay <= 0);
    assert.equal((await call('GET', READ, cookies.admin)).body.events[0].parked, false);

    // The transport tries it again and the platform takes it.
    const summary = await drainPlatformLifecycleEvents({ database: pool, config, fetch: delivering(pool) });
    assert.equal(summary.delivered, 1);
    const after = await call('GET', READ, cookies.admin);
    assert.equal(after.body.events[0].state, 'delivered'); assert.deepEqual(parkedLifecycleNotices(after.body.events), []);
    const late = await call('POST', SEND, cookies.admin, { eventId: event });
    assert.equal(late.status, 409);
    // It never touched the login or made an event.
    assert.equal((await q('SELECT count(*)::int AS n FROM login_lifecycle_events WHERE user_id=$1', [leaver.id]))[0].n, 1);
    assert.equal((await q('SELECT is_active FROM users WHERE id=$1', [leaver.id]))[0].is_active, false);
    assert.equal((await q('SELECT count(*)::int AS n FROM activity_log WHERE tenant_id=$1', [tenant]))[0].n, 1);
  } finally {
    stopHarness();
    // No pending row of this check outlives it.
    await q("UPDATE login_lifecycle_events SET state='superseded',settled_at=now(),next_attempt_at=NULL WHERE user_id=$1 AND state='pending'", [leaver.id]).catch(() => {});
  }
});
stopHarness();
await pool.end();
const passed = results.filter(Boolean).length;
console.log(`s778-lifecycle.check: ${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
