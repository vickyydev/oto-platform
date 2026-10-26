import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { createTestDatabase, stopTestServer } from '../src/testing';

const keys = ['pos', 'console', 'oto_app', 'radar', 'booth', 'inbox'] as const;
const own = newId(), other = newId(), actor = newId();
const secondAdmin = newId();
let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-643-suite-controls' });
  await client.connect();
  await client.query(`insert into core.operator (id, name) values
    ($1, 'ZZ TEST 643 own operator'), ($2, 'ZZ TEST 643 other operator')`, [own, other]);
  await client.query(`insert into core.account (id, operator_id, phone)
    values ($1, $2, 'ZZ TEST 643 actor')`, [actor, other]);
}, 300_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

async function table(name: string) {
  expect((await client.query('select to_regclass($1)::text as name', [`core.${name}`])).rows)
    .toEqual([{ name: `core.${name}` }]);
}

async function refused(run: () => Promise<unknown>, code: string) {
  let actual: string | undefined;
  try { await run(); } catch (error) { actual = (error as { code?: string }).code; }
  expect(actual, 'the database refuses the invalid record without exposing its payload').toBe(code);
}

async function app(key = 'pos') {
  await table('app_registry');
  const existing = await client.query('select id from core.app_registry where key = $1', [key]);
  if (existing.rows.length) return existing.rows[0]!.id as string;
  const id = newId();
  await client.query(`insert into core.app_registry
    (id, key, name, purpose, origin_urls, schema_name, owning_service, version_source, required_permission, sort_order, tile_state)
    values ($1, $2, 'ZZ TEST 643 app', 'ZZ TEST 643 purpose', $3::jsonb, 'core', 'ZZ TEST 643 service',
      'APP_VERSION', $4, 0, 'open')`, [id, key, JSON.stringify({ staging: 'https://example.test' }), `app:${key}:access`]);
  return id;
}

async function flag(options: {
  key?: string; kind?: string; targetApp?: string; scopeType?: string; scopeId?: string | null;
  operatorId?: string | null; value?: unknown; defaultValue?: unknown; expiresAt?: Date | null;
  reason?: string | null; updatedBy?: string | null; revision?: number;
} = {}) {
  await table('feature_flag'); await app();
  return client.query(`insert into core.feature_flag
    (id, key, kind, target_app, scope_type, scope_id, operator_id, value, default_value, expires_at, reason, updated_by${options.revision === undefined ? '' : ', revision'})
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12${options.revision === undefined ? '' : ', $13'}) returning *`,
  [newId(), options.key ?? `ZZ TEST 643 ${newId()}`, options.kind ?? 'feature', options.targetApp ?? 'pos', options.scopeType ?? 'platform',
    options.scopeId ?? null, options.operatorId ?? null, JSON.stringify(options.value === undefined ? false : options.value), JSON.stringify(options.defaultValue === undefined ? true : options.defaultValue),
    options.expiresAt ?? null, options.reason ?? null, options.updatedBy ?? null, ...(options.revision === undefined ? [] : [options.revision])]);
}

async function approval(options: Record<string, unknown> = {}) {
  await table('suite_control_approval');
  await client.query(`insert into core.account (id, operator_id, phone)
    values ($1, $2, 'ZZ TEST 643 second admin') on conflict (id) do nothing`, [secondAdmin, own]);
  const row = { id: newId(), action: 'kill_switch.set', operation: { value: false }, payload_sha256: 'a'.repeat(64),
    operator_id: own, requester_account_id: actor, approver_account_id: null, state: 'pending',
    created_at: new Date('2026-10-27T00:00:00.000Z'), request_expires_at: new Date('2026-10-27T00:10:00.000Z'),
    approved_at: null, consumed_at: null, expired_at: null, ...options };
  return client.query(`insert into core.suite_control_approval
    (id, action, operation, payload_sha256, operator_id, requester_account_id, approver_account_id, state,
      created_at, request_expires_at, approved_at, consumed_at, expired_at)
    values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
  [row.id, row.action, JSON.stringify(row.operation), row.payload_sha256, row.operator_id, row.requester_account_id,
    row.approver_account_id, row.state, row.created_at, row.request_expires_at, row.approved_at, row.consumed_at, row.expired_at]);
}

describe('SCRUM-643 native suite-control storage', () => {
  it('creates three actual core tables with no fabricated registry, flags or deployment history', async () => {
    for (const name of ['app_registry', 'feature_flag', 'deploy_event']) {
      await table(name);
      expect((await client.query(`select count(*)::int as count from core.${name}`)).rows).toEqual([{ count: 0 }]);
    }
  });

  it('declares nullable unknown deployment facts with no success/version/time defaults', async () => {
    await table('deploy_event');
    const columns = await client.query(`select column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'core' and table_name = 'deploy_event' order by column_name`);
    expect(columns.rows).toEqual([
      { column_name: 'actor_account_id', data_type: 'uuid', is_nullable: 'YES', column_default: null },
      { column_name: 'app', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'ci_green', data_type: 'boolean', is_nullable: 'YES', column_default: null },
      { column_name: 'commit', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'deployed_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
      { column_name: 'status', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'version', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('preserves all six suite keys as unique identities even when a registry row is archived', async () => {
    for (const key of keys) await app(key);
    expect((await client.query('select key from core.app_registry order by key')).rows.map(r => r.key)).toEqual([...keys].sort());
    const id = await app();
    await client.query('update core.app_registry set archived_at = now() where id = $1', [id]);
    await refused(() => client.query(`insert into core.app_registry
      select $1, key, name, purpose, origin_urls, schema_name, owning_service, health_url, version_source,
        required_permission, sort_order, tile_state, maintenance_message, maintenance_expires_at, maintenance_restore_state,
        revision, archived_at, created_at, updated_at from core.app_registry where id = $2`, [newId(), id]), '23505');
    await refused(() => client.query('update core.app_registry set key = $1 where id = $2', ['not-a-suite-app', id]), '23514');
    await client.query('update core.app_registry set archived_at = null where id = $1', [id]);
  });

  it('requires an object for environment origins and stores positive revision/timestamp defaults', async () => {
    const id = await app();
    const row = (await client.query('select * from core.app_registry where id = $1', [id])).rows[0]!;
    expect(row.origin_urls).toEqual({ staging: 'https://example.test' }); expect(row.revision).toBe(1);
    expect(row.created_at).toBeInstanceOf(Date); expect(row.updated_at).toBeInstanceOf(Date);
    for (const value of ['[]', 'null', 'false', '"https://example.test"'])
      await refused(() => client.query('update core.app_registry set origin_urls = $1::jsonb where id = $2', [value, id]), '23514');
    for (const revision of [0, -1]) await refused(() => client.query('update core.app_registry set revision = $1 where id = $2', [revision, id]), '23514');
  });

  it('stores maintenance only with a message, expiry and non-maintenance restoration state', async () => {
    const id = await app();
    for (const [message, expiry, restore] of [[null, new Date(), 'open'], [' ', new Date(), 'open'], ['ZZ TEST maintenance', null, 'open'],
      ['ZZ TEST maintenance', new Date(), null], ['ZZ TEST maintenance', new Date(), 'maintenance']])
      await refused(() => client.query(`update core.app_registry set tile_state = 'maintenance', maintenance_message = $1,
        maintenance_expires_at = $2, maintenance_restore_state = $3 where id = $4`, [message, expiry, restore, id]), '23514');
    const expired = new Date('2020-01-01T00:00:00.000Z');
    await client.query(`update core.app_registry set tile_state = 'maintenance', maintenance_message = 'ZZ TEST maintenance',
      maintenance_expires_at = $1, maintenance_restore_state = 'coming_soon' where id = $2`, [expired, id]);
    expect((await client.query('select tile_state, maintenance_expires_at, maintenance_restore_state from core.app_registry where id = $1', [id])).rows)
      .toEqual([{ tile_state: 'maintenance', maintenance_expires_at: expired, maintenance_restore_state: 'coming_soon' }]);
    // Expiry resolution is service-owned; storage retains the actual expired record.
    await refused(() => client.query('update core.app_registry set tile_state = $1 where id = $2', ['open', id]), '23514');
    await client.query(`update core.app_registry set tile_state = 'open', maintenance_message = null,
      maintenance_expires_at = null, maintenance_restore_state = null where id = $1`, [id]);
    await refused(() => client.query('update core.app_registry set maintenance_message = $1 where id = $2', ['ZZ TEST stale message', id]), '23514');
    await refused(() => client.query('update core.app_registry set tile_state = $1 where id = $2', ['unknown', id]), '23514');
  });

  it('uniquely identifies a platform key and each non-platform key/scope without treating SQL null as a second platform row', async () => {
    const key = `ZZ TEST 643 ${newId()}`, branch = newId();
    await flag({ key });
    await refused(() => flag({ key }), '23505');
    await app('console');
    await refused(() => flag({ key, targetApp: 'console' }), '23505');
    await flag({ key, scopeType: 'operator', scopeId: own, operatorId: own });
    await refused(() => flag({ key, scopeType: 'operator', scopeId: own, operatorId: own }), '23505');
    await flag({ key, scopeType: 'operator', scopeId: other, operatorId: other });
    await flag({ key, scopeType: 'branch', scopeId: branch, operatorId: own });
    await refused(() => flag({ key, scopeType: 'branch', scopeId: branch, operatorId: own }), '23505');
    expect((await client.query('select count(*)::int as count from core.feature_flag where key = $1', [key])).rows).toEqual([{ count: 4 }]);
  });

  it('requires exact platform/null versus scoped/non-null shape and operator-scope self identity', async () => {
    for (const options of [
      { operatorId: own }, { scopeId: own }, { scopeId: own, operatorId: own },
      { scopeType: 'operator' }, { scopeType: 'branch', operatorId: own }, { scopeType: 'station', scopeId: newId() },
      { scopeType: 'operator', scopeId: other, operatorId: own }, { scopeType: 'tenant', scopeId: own, operatorId: own },
      { kind: 'unknown' },
    ]) await refused(() => flag(options), '23514');
    await flag({ scopeType: 'station', scopeId: newId(), operatorId: own });
    // A UUID-shaped branch/station reference is not a claim of valid lineage; service checks the live ownership tuple.
  });

  it('requires kill-switch expiry and a trimmed nonempty reason but does not erase expired historical overrides', async () => {
    for (const options of [{}, { expiresAt: new Date() }, { reason: 'ZZ TEST reason' }, { expiresAt: new Date(), reason: '  ' }])
      await refused(() => flag({ ...options, kind: 'kill_switch' }), '23514');
    const past = new Date('2020-01-01T00:00:00.000Z');
    const row = (await flag({ kind: 'kill_switch', expiresAt: past, reason: 'ZZ TEST historical expiry' })).rows[0]!;
    expect(row.expires_at).toEqual(past); expect(row.kind).toBe('kill_switch');
    const ordinary = (await flag()).rows[0]!; expect(ordinary.expires_at).toBeNull(); expect(ordinary.reason).toBeNull();
  });

  it('preserves typed JSON values and enforces positive flag revisions and real updater/operator/app foreign keys', async () => {
    for (const value of [null, false, 0, [], { enabled: false }]) {
      const row = (await flag({ value, defaultValue: value, updatedBy: actor })).rows[0]!;
      expect(row.value).toEqual(value); expect(row.default_value).toEqual(value); expect(row.revision).toBe(1); expect(row.updated_by).toBe(actor);
    }
    for (const revision of [0, -1]) await refused(() => flag({ revision }), '23514');
    await refused(() => flag({ updatedBy: newId() }), '23503');
    await refused(() => flag({ scopeType: 'operator', scopeId: own, operatorId: newId() }), '23514');
    const absent = newId(); await refused(() => flag({ scopeType: 'operator', scopeId: absent, operatorId: absent }), '23503');
    await refused(() => flag({ targetApp: 'missing-app' }), '23503');
    await refused(() => client.query('delete from core.account where id = $1', [actor]), '23503');
  });

  it('stores only supplied deployment facts and preserves unknown/null CI separately from failed CI', async () => {
    await table('deploy_event'); await app();
    const id = newId();
    await client.query(`insert into core.deploy_event (id, app, status) values ($1, 'pos', 'unknown')`, [id]);
    expect((await client.query('select version, commit, actor_account_id, ci_green, deployed_at from core.deploy_event where id = $1', [id])).rows)
      .toEqual([{ version: null, commit: null, actor_account_id: null, ci_green: null, deployed_at: null }]);
    const deployedAt = new Date('2020-01-01T00:00:00.000Z');
    await client.query(`insert into core.deploy_event (id, app, version, commit, actor_account_id, status, ci_green, deployed_at)
      values ($1, 'pos', 'ZZ TEST native version', $2, $3, 'build_failed', false, $4)`, [newId(), 'a'.repeat(40), actor, deployedAt]);
    expect((await client.query('select count(*)::int as count from core.deploy_event where ci_green = false')).rows).toEqual([{ count: 1 }]);
    await refused(() => client.query(`insert into core.deploy_event (id, app, status) values ($1, 'pos', ' ')`, [newId()]), '23514');
    await refused(() => client.query(`insert into core.deploy_event (id, app, status) values ($1, 'missing', 'unknown')`, [newId()]), '23503');
    await refused(() => client.query(`insert into core.deploy_event (id, app, status, actor_account_id) values ($1, 'pos', 'unknown', $2)`, [newId(), newId()]), '23503');
    await refused(() => client.query(`insert into core.deploy_event (id, app, status) values ($1, 'pos', null)`, [newId()]), '23502');
  });

  it('stores an empty approval ledger with explicit actor, state and deadline facts rather than fabricated approval defaults', async () => {
    await table('suite_control_approval');
    expect((await client.query('select count(*)::int as count from core.suite_control_approval')).rows).toEqual([{ count: 0 }]);
    const rows = (await client.query(`select column_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'core' and table_name = 'suite_control_approval' and column_name in
      ('state', 'requester_account_id', 'approver_account_id', 'operator_id', 'request_expires_at', 'approved_at', 'consumed_at', 'expired_at') order by column_name`)).rows;
    expect(rows).toEqual([
      { column_name: 'approved_at', is_nullable: 'YES', column_default: null },
      { column_name: 'approver_account_id', is_nullable: 'YES', column_default: null },
      { column_name: 'consumed_at', is_nullable: 'YES', column_default: null },
      { column_name: 'expired_at', is_nullable: 'YES', column_default: null },
      { column_name: 'operator_id', is_nullable: 'YES', column_default: null },
      { column_name: 'request_expires_at', is_nullable: 'NO', column_default: null },
      { column_name: 'requester_account_id', is_nullable: 'NO', column_default: null },
      { column_name: 'state', is_nullable: 'NO', column_default: null },
    ]);
  });

  it('requires a bounded approval action, object payload, digest and exact ten-minute request window', async () => {
    for (const options of [{ action: 'other' }, { operation: [] }, { operation: null }, { payload_sha256: 'bad' },
      { request_expires_at: new Date('2026-10-27T00:09:59.999Z') }, { state: 'unknown' }])
      await refused(() => approval(options), '23514');
    const row = (await approval()).rows[0]!;
    expect(row.state).toBe('pending'); expect(row.approver_account_id).toBeNull(); expect(row.consumed_at).toBeNull();
    expect(row.request_expires_at.getTime() - row.created_at.getTime()).toBe(600_000);
  });

  it('requires two distinct real actors and retains the original event owner across approval and expiry', async () => {
    for (const options of [{ requester_account_id: newId() }, { operator_id: newId() },
      { state: 'approved', approver_account_id: newId(), approved_at: new Date('2026-10-27T00:01:00.000Z') }])
      await refused(() => approval(options), '23503');
    await refused(() => approval({ state: 'approved', approver_account_id: actor, approved_at: new Date('2026-10-27T00:01:00.000Z') }), '23514');
    const row = (await approval({ state: 'approved', approver_account_id: secondAdmin, approved_at: new Date('2026-10-27T00:01:00.000Z') })).rows[0]!;
    expect(row.operator_id).toBe(own); expect(row.requester_account_id).toBe(actor); expect(row.approver_account_id).toBe(secondAdmin);
    await client.query(`update core.suite_control_approval set state = 'expired', expired_at = request_expires_at where id = $1`, [row.id]);
    expect((await client.query('select operator_id, approver_account_id from core.suite_control_approval where id = $1', [row.id])).rows)
      .toEqual([{ operator_id: own, approver_account_id: secondAdmin }]);
  });

  it('refuses impossible approval/consumption/expiry tuples without deleting historical rows', async () => {
    for (const options of [{ approver_account_id: secondAdmin }, { state: 'approved' }, { state: 'consumed' },
      { state: 'expired' }, { state: 'expired', expired_at: new Date('2026-10-27T00:09:59.999Z') },
      { state: 'approved', approver_account_id: secondAdmin, approved_at: new Date('2026-10-27T00:10:00.000Z') },
      { state: 'consumed', approver_account_id: secondAdmin, approved_at: new Date('2026-10-27T00:01:00.000Z'), consumed_at: new Date('2026-10-27T00:10:00.000Z') }])
      await refused(() => approval(options), '23514');
    const row = (await approval({ state: 'consumed', approver_account_id: secondAdmin,
      approved_at: new Date('2026-10-27T00:01:00.000Z'), consumed_at: new Date('2026-10-27T00:02:00.000Z') })).rows[0]!;
    expect(row.state).toBe('consumed'); expect(row.expired_at).toBeNull();
    await refused(() => client.query(`update core.suite_control_approval set state = 'pending' where id = $1`, [row.id]), '23514');
    expect((await client.query('select state from core.suite_control_approval where id = $1', [row.id])).rows).toEqual([{ state: 'consumed' }]);
  });
});
