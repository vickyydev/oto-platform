import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { createTestDatabase, stopTestServer } from '../src/testing';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
const own = newId(), foreign = newId(), updater = newId(), platformUpdater = newId();
let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };
let originalPeople: unknown[];
let originalOperators: unknown[];

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-638-setting-migration' });
  await client.connect();
  await client.query(`insert into core.operator (id, name) values
    ($1, 'ZZ TEST 638 own operator'), ($2, 'ZZ TEST 638 other operator')`, [own, foreign]);
  await client.query(`insert into core.account (id, operator_id, phone) values
    ($1, $2, 'ZZ TEST 638 own updater'), ($3, $4, 'ZZ TEST 638 platform updater')`,
  [updater, own, platformUpdater, foreign]);
  originalPeople = (await client.query(`select id, operator_id, phone, status from core.account
    where id in ($1, $2) order by id`, [updater, platformUpdater])).rows;
  originalOperators = (await client.query(`select * from core.operator where id in ($1, $2) order by id`, [own, foreign])).rows;
}, 300_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

async function requireSetting() {
  const result = await client.query<{ name: string | null }>(`select to_regclass('core.setting')::text as name`);
  expect(result.rows[0]?.name, 'the migrated generic operator setting table exists').toBe('core.setting');
}

async function insert(owner = own, key = `ZZ TEST ${newId()}`, updatedBy: string | null = null, revision?: number) {
  return client.query(`insert into core.setting (operator_id, key, value, updated_by${revision === undefined ? '' : ', revision'})
    values ($1, $2, $3::jsonb, $4${revision === undefined ? '' : ', $5'}) returning *`,
  [owner, key, JSON.stringify({ schemaVersion: 1, overrides: { internal: {}, inbox: {} }, rates: [] }), updatedBy,
    ...(revision === undefined ? [] : [revision])]);
}

async function refused(run: () => Promise<unknown>, code: string) {
  let actual: string | undefined;
  try { await run(); } catch (error) { actual = (error as { code?: string }).code; }
  expect(actual, 'the database refuses the invalid setting without exposing its payload').toBe(code);
}

describe('SCRUM-638 expand-only operator settings storage', () => {
  it('creates a real core table without seeding settings or provider prices', async () => {
    const tables = await client.query(`select table_name from information_schema.tables
      where table_schema = 'core' and table_name = 'setting' and table_type = 'BASE TABLE'`);
    expect(tables.rows).toEqual([{ table_name: 'setting' }]);
    await requireSetting();
    expect((await client.query('select count(*)::int as n from core.setting')).rows).toEqual([{ n: 0 }]);
  });

  it('has exactly the typed operator/key/value, revision, updater and timestamp columns', async () => {
    const columns = await client.query(`select column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'core' and table_name = 'setting' order by column_name`);
    expect(columns.rows).toEqual([
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'key', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'operator_id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
      { column_name: 'revision', data_type: 'integer', is_nullable: 'NO', column_default: '1' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'updated_by', data_type: 'uuid', is_nullable: 'YES', column_default: null },
      { column_name: 'value', data_type: 'jsonb', is_nullable: 'NO', column_default: null },
    ]);
  });

  it('uses the operator/key pair as its only primary key and indexes the optional updater', async () => {
    await requireSetting();
    const keys = await client.query(`select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'core.setting'::regclass and contype = 'p'`);
    expect(keys.rows).toEqual([{ definition: 'PRIMARY KEY (operator_id, key)' }]);
    const indexes = await client.query<{ columns: string[]; is_unique: boolean }>(`select
      array_agg(a.attname::text order by k.ordinality) as columns, i.indisunique as is_unique
      from pg_index i cross join lateral unnest(i.indkey::smallint[]) with ordinality k(attnum, ordinality)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indrelid = 'core.setting'::regclass group by i.indexrelid, i.indisunique`);
    expect(indexes.rows).toContainEqual({ columns: ['updated_by'], is_unique: false });
  });

  it('allows separate operator documents and keys but refuses duplicate operator/key identity', async () => {
    await requireSetting();
    const key = `ZZ TEST ${newId()}`;
    await insert(own, key); await insert(foreign, key); await insert(own, `${key} alternate`);
    await refused(() => insert(own, key), '23505');
    expect((await client.query('select count(*)::int as n from core.setting where key = $1', [key])).rows)
      .toEqual([{ n: 2 }]);
  });

  it('stores JSON zero values without coercion and supplies positive revision and timestamp defaults', async () => {
    await requireSetting();
    const key = `ZZ TEST ${newId()}`;
    const value = { schemaVersion: 1, overrides: { internal: { dailyAskCap: 0 }, inbox: { bubbleGapMs: 0 } }, rates: [] };
    const started = Date.now();
    const result = await client.query(`insert into core.setting (operator_id, key, value)
      values ($1, $2, $3::jsonb) returning *`, [own, key, JSON.stringify(value)]);
    const row = result.rows[0]!;
    expect(row.value).toEqual(value); expect(row.revision).toBe(1); expect(row.updated_by).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date); expect(row.updated_at).toBeInstanceOf(Date);
    expect(row.created_at.getTime()).toBeGreaterThanOrEqual(started - 1_000);
    expect(row.updated_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(row.created_at).toEqual(row.updated_at);
  });

  it('enforces positive revisions independently of the HTTP lost-update guard', async () => {
    await requireSetting();
    for (const revision of [0, -1]) await refused(() => insert(own, `ZZ TEST ${newId()}`, null, revision), '23514');
    const row = (await insert(own, `ZZ TEST ${newId()}`, null, 2)).rows[0]!;
    expect(row.revision).toBe(2);
    await refused(() => client.query('update core.setting set revision = 0 where operator_id = $1 and key = $2', [own, row.key]), '23514');
    expect((await client.query('select revision from core.setting where operator_id = $1 and key = $2', [own, row.key])).rows)
      .toEqual([{ revision: 2 }]);
  });

  it('refuses SQL-null required fields while the generic table leaves document validation to its service', async () => {
    await requireSetting();
    for (const column of ['operator_id', 'key', 'value', 'revision', 'created_at', 'updated_at']) {
      const fields = { operator_id: own, key: `ZZ TEST ${newId()}`, value: '{}', revision: 1,
        created_at: new Date(), updated_at: new Date() };
      await refused(() => client.query(`insert into core.setting (operator_id, key, value, revision, created_at, updated_at)
        values ($1, $2, $3::jsonb, $4, $5, $6)`, Object.entries(fields).map(([name, value]) => name === column ? null : value)), '23502');
    }
    const key = `ZZ TEST ${newId()}`;
    await client.query(`insert into core.setting (operator_id, key, value) values ($1, $2, 'null'::jsonb)`, [own, key]);
    expect((await client.query('select value is null as sql_null, jsonb_typeof(value) as json_type from core.setting where operator_id = $1 and key = $2', [own, key])).rows)
      .toEqual([{ sql_null: false, json_type: 'null' }]);
  });

  it('fences both foreign keys without incorrectly requiring the updater to belong to the setting operator', async () => {
    await requireSetting();
    await refused(() => insert(newId()), '23503');
    await refused(() => insert(own, `ZZ TEST ${newId()}`, newId()), '23503');
    const key = `ZZ TEST ${newId()}`;
    await insert(own, key, platformUpdater);
    expect((await client.query('select operator_id, updated_by from core.setting where operator_id = $1 and key = $2', [own, key])).rows)
      .toEqual([{ operator_id: own, updated_by: platformUpdater }]);
    await refused(() => client.query('delete from core.account where id = $1', [platformUpdater]), '23503');
    await refused(() => client.query('delete from core.operator where id = $1', [own]), '23503');
  });

  it('leaves existing operator and account rows unchanged', async () => {
    await requireSetting();
    expect((await client.query('select id, operator_id, phone, status from core.account where id in ($1, $2) order by id', [updater, platformUpdater])).rows)
      .toEqual(originalPeople);
    expect((await client.query('select * from core.operator where id in ($1, $2) order by id', [own, foreign])).rows)
      .toEqual(originalOperators);
  });

  it('adds only the new table in a forward-only successor snapshot and contains no seed/backfill SQL', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const mine = journal.entries.find(entry => entry.tag.endsWith('_assistant_settings'));
    expect(mine, 'the assistant settings migration is present in the actual chain').toBeDefined();
    const previous = journal.entries[journal.entries.indexOf(mine!) - 1]!;
    expect(mine!.idx).toBe(previous.idx + 1); expect(mine!.when).toBeGreaterThan(previous.when);
    const load = (tag: string) => JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as {
      id: string; prevId: string; tables: Record<string, unknown>;
    };
    const before = load(previous.tag), after = load(mine!.tag);
    expect(after.prevId).toBe(before.id); expect(after.id).not.toBe(before.id);
    expect(before.tables).not.toHaveProperty('core.setting'); expect(after.tables).toHaveProperty('core.setting');
    const expected = structuredClone(before);
    expected.id = after.id; expected.prevId = after.prevId; expected.tables['core.setting'] = after.tables['core.setting'];
    expect(after).toEqual(expected);
    const sql = readFileSync(join(MIGRATIONS, `${mine!.tag}.sql`), 'utf8');
    expect(sql).toMatch(/CREATE TABLE "core"\."setting"/);
    expect(sql).not.toMatch(/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\S+\s+SET|DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX|SCHEMA)|TRUNCATE|RENAME|ALTER\s+COLUMN)\b/i);
    const targets = [...sql.matchAll(/(?:CREATE|ALTER) TABLE\s+"([^"]+)"\."([^"]+)"/gi)].map(match => `${match[1]}.${match[2]}`);
    expect([...new Set(targets)]).toEqual(['core.setting']);
  });

  it('reapplies the native migration chain without another entry or changing stored data', async () => {
    await requireSetting();
    const migrations = (await client.query('select hash, created_at::text from drizzle.__drizzle_migrations order by created_at')).rows;
    const rows = (await client.query('select * from core.setting order by operator_id, key')).rows;
    let completed = false;
    try {
      execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
        cwd: PKG, env: { ...process.env, DATABASE_URL: database.url }, stdio: 'pipe',
      });
      completed = true;
    } catch { /* Only the status is asserted; child output can contain connection details. */ }
    expect(completed, 'the native migration command exits successfully').toBe(true);
    expect((await client.query('select hash, created_at::text from drizzle.__drizzle_migrations order by created_at')).rows).toEqual(migrations);
    expect((await client.query('select * from core.setting order by operator_id, key')).rows).toEqual(rows);
  }, 300_000);
});
