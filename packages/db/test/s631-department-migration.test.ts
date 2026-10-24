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
const operator = newId(), foreignOperator = newId(), first = newId(), second = newId(), foreignBranch = newId();
const legacy = newId();
let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-631-core-migration' });
  await client.connect();
  await client.query(`insert into core.operator (id, name) values
    ($1, 'ZZ TEST 631 migration own'), ($2, 'ZZ TEST 631 migration foreign')`, [operator, foreignOperator]);
  for (const [id, owner] of [[first, operator], [second, operator], [foreignBranch, foreignOperator]]) {
    await client.query(`insert into core.branch (id, operator_id, name, code)
      values ($1, $2, 'ZZ TEST 631 migration branch', $3)`, [id, owner, id]);
  }
  await client.query(`insert into core.department (id, operator_id, branch_id, name)
    values ($1, $2, $3, 'ZZ TEST 631 retained seed')`, [legacy, operator, first]);
}, 300_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

async function insert(owner: string, branch: string | null, external: string | null, archived: boolean = false) {
  const id = newId();
  await client.query(`insert into core.department (id, operator_id, branch_id, name, external_id, archived_at)
    values ($1, $2, $3, 'ZZ TEST 631 projection', $4, $5)`, [id, owner, branch, external, archived ? new Date('2026-01-02T00:00:00Z') : null]);
  return id;
}

describe('SCRUM-631 expand-only department projection migration', () => {
  it('adds only nullable external identity and archive time to existing department rows', async () => {
    const columns = (await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'core' and table_name = 'department' and column_name in ('external_id', 'archived_at')
      order by column_name`)).rows;
    expect(columns).toEqual([
      { column_name: 'archived_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'external_id', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
    expect((await client.query('select id, branch_id, name, external_id, archived_at from core.department where id = $1', [legacy])).rows)
      .toEqual([{ id: legacy, branch_id: first, name: 'ZZ TEST 631 retained seed', external_id: null, archived_at: null }]);
  });

  it('follows its predecessor without changing any prior snapshot column or index', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const mine = journal.entries.find(entry => entry.tag.endsWith('_department_mirror'));
    expect(mine).toBeDefined();
    const previous = journal.entries[journal.entries.indexOf(mine!) - 1]!;
    expect(mine!.idx).toBe(previous.idx + 1); expect(mine!.when).toBeGreaterThan(previous.when);
    const load = (tag: string) => JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as {
      id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
    };
    const before = load(previous.tag), after = load(mine!.tag);
    expect(after.prevId).toBe(before.id); expect(after.id).not.toBe(before.id);
    const expected = structuredClone(before);
    expected.id = after.id; expected.prevId = after.prevId;
    expected.tables['core.department']!.columns = after.tables['core.department']!.columns;
    expected.tables['core.department']!.indexes = after.tables['core.department']!.indexes;
    expect(after).toEqual(expected);
    expect(Object.keys(after.tables['core.department']!.columns).filter(key => !(key in before.tables['core.department']!.columns)).sort())
      .toEqual(['archived_at', 'external_id']);
    for (const [key, value] of Object.entries(before.tables['core.department']!.columns)) expect(after.tables['core.department']!.columns[key]).toEqual(value);
    for (const [key, value] of Object.entries(before.tables['core.department']!.indexes)) expect(after.tables['core.department']!.indexes[key]).toEqual(value);
    expect(Object.keys(after.tables['core.department']!.indexes).filter(key => !(key in before.tables['core.department']!.indexes))).toHaveLength(2);
    const sql = readFileSync(join(MIGRATIONS, `${mine!.tag}.sql`), 'utf8');
    expect(sql).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT)\b|ALTER COLUMN/i);
  });

  it('allows the same source department at several branches and operators but refuses a duplicate branch projection', async () => {
    const external = `zz-test-631-branches/${newId()}`;
    await insert(operator, first, external); await insert(operator, second, external);
    await insert(foreignOperator, foreignBranch, external);
    await expect(insert(operator, first, external)).rejects.toMatchObject({ code: '23505' });
    expect((await client.query('select count(*)::int as n from core.department where external_id = $1', [external])).rows[0]?.n).toBe(3);
  });

  it('makes branchless identity unique while allowing concrete and branchless projections side by side', async () => {
    const external = `zz-test-631-branchless/${newId()}`;
    await insert(operator, null, external); await insert(operator, first, external);
    await insert(foreignOperator, null, external);
    await expect(insert(operator, null, external)).rejects.toMatchObject({ code: '23505' });
  });

  it('reserves the same identity across archive and restoration instead of creating replacement rows', async () => {
    for (const branch of [first, null]) {
      const external = `zz-test-631-archive/${newId()}`, id = await insert(operator, branch, external, true);
      await expect(insert(operator, branch, external)).rejects.toMatchObject({ code: '23505' });
      await client.query('update core.department set archived_at = null where id = $1', [id]);
      expect((await client.query('select id, branch_id, external_id, archived_at from core.department where id = $1', [id])).rows)
        .toEqual([{ id, branch_id: branch, external_id: external, archived_at: null }]);
    }
  });

  it('leaves unlinked same-name seeded departments unconstrained', async () => {
    for (const branch of [first, null]) {
      const a = await insert(operator, branch, null), b = await insert(operator, branch, null);
      expect(a).not.toBe(b);
    }
  });

  it('can link a legacy ID without moving or renaming it', async () => {
    const before = (await client.query('select * from core.department where id = $1', [legacy])).rows[0];
    const external = `zz-test-631-adopt/${newId()}`;
    await client.query('update core.department set external_id = $2 where id = $1', [legacy, external]);
    const after = (await client.query('select * from core.department where id = $1', [legacy])).rows[0];
    expect(after).toEqual({ ...before, external_id: external });
  });

  it('replays the committed platform chain without another migration record or changing department data', async () => {
      const before = (await client.query('select hash, created_at::text from drizzle.__drizzle_migrations order by created_at')).rows;
      const rows = (await client.query('select * from core.department where operator_id in ($1, $2) order by id', [operator, foreignOperator])).rows;
      execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
        cwd: PKG, env: { ...process.env, DATABASE_URL: database.url }, stdio: 'pipe',
      });
      expect((await client.query('select hash, created_at::text from drizzle.__drizzle_migrations order by created_at')).rows).toEqual(before);
      expect((await client.query('select * from core.department where operator_id in ($1, $2) order by id', [operator, foreignOperator])).rows).toEqual(rows);
  }, 300_000);
});
