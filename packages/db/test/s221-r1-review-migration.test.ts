import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-218 review of lane I round 1 — the staff-benefits migration, found by
 * its tag (`*_staff_benefits`) rather than its number, because the number is
 * provisional and the lander renumbers it.
 *
 *   - forward-only and additive: nothing in the previous snapshot is removed
 *     or changed, the SQL drops, renames and retypes nothing, and the only
 *     existing table it touches is `core.employee`, by adding to it;
 *   - it applies twice clean: two databases built from empty, and the
 *     migrator run again over a built one changes nothing;
 *   - every foreign key on its tables leads an index;
 *   - the CHECKs and partial unique indexes hold what the service relies on.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');

interface Journal {
  entries: Array<{ idx: number; when: number; tag: string }>;
}
interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, Record<string, Record<string, unknown> | undefined>>;
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
const entry = journal.entries.find((e) => e.tag.endsWith('_staff_benefits'))!;
const previous = journal.entries[journal.entries.indexOf(entry) - 1]!;
const snapshotOf = (tag: string) =>
  JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as Snapshot;
const SQL = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8');

let first: { url: string; drop: () => Promise<void> };
let second: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  first = await createTestDatabase();
  second = await createTestDatabase();
  client = new pg.Client({ connectionString: second.url });
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.end();
  await first?.drop();
  await second?.drop();
  await stopTestServer();
});

async function sqlState(text: string, values: unknown[] = []): Promise<string | null> {
  await client.query('savepoint review');
  try {
    await client.query(text, values);
    await client.query('rollback to savepoint review');
    return null;
  } catch (err) {
    await client.query('rollback to savepoint review');
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('the staff-benefits migration (SCRUM-218 review)', () => {
  it('is in the journal once, directly after the previous entry, later than it, on its snapshot', () => {
    expect(journal.entries.filter((e) => e.tag.endsWith('_staff_benefits'))).toHaveLength(1);
    expect(entry.idx).toBe(previous.idx + 1);
    expect(entry.when).toBeGreaterThan(previous.when);
    expect(snapshotOf(entry.tag).prevId).toBe(snapshotOf(previous.tag).id);
  });

  it('is additive: the previous snapshot survives intact, and only core.employee gains anything', () => {
    const before = snapshotOf(previous.tag).tables;
    const after = snapshotOf(entry.tag).tables;
    const changed: string[] = [];
    const grew: string[] = [];
    for (const [name, table] of Object.entries(before)) {
      const now = after[name];
      if (!now) {
        changed.push(`table ${name} removed`);
        continue;
      }
      for (const part of ['columns', 'indexes', 'foreignKeys', 'uniqueConstraints', 'checkConstraints'] as const) {
        for (const [k, v] of Object.entries(table[part] ?? {})) {
          if (JSON.stringify(now[part]?.[k]) !== JSON.stringify(v)) changed.push(`${name} ${part} ${k}`);
        }
        for (const k of Object.keys(now[part] ?? {})) if (!(k in (table[part] ?? {}))) grew.push(`${name} ${part} ${k}`);
      }
    }
    expect(changed).toEqual([]);
    expect([...new Set(grew.map((g) => g.split(' ')[0]))]).toEqual(['core.employee']);
    expect(Object.keys(after).filter((t) => !before[t]).sort()).toEqual([
      'promo.benefit_profile',
      'promo.benefit_role_template',
    ]);
    // Nothing destructive in the SQL itself: with the comments and the foreign
    // keys' ON DELETE / ON UPDATE actions set aside, every statement creates or adds.
    const statements = SQL.split('--> statement-breakpoint')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .replace(/ON (DELETE|UPDATE) (no action|restrict|cascade|set null)/gi, '')
          .trim(),
      )
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s, s).toMatch(/^(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE "[a-z_]+"\."[a-z_]+" ADD (COLUMN|CONSTRAINT))/);
      expect(s, s).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT)\b|ALTER COLUMN/i);
    }
  });

  it('applies twice clean: a second run of the migrator over a built database changes nothing', async () => {
    const shape = async (url: string) => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        const cols = await c.query(
          `select table_schema, table_name, column_name, data_type, is_nullable, column_default
             from information_schema.columns
            where table_schema in ('core','promo') order by 1,2,3`,
        );
        const idx = await c.query(
          `select schemaname, tablename, indexname, indexdef from pg_indexes
            where schemaname in ('core','promo') order by 1,2,3`,
        );
        const applied = await c.query('select count(*)::int as n from drizzle.__drizzle_migrations');
        return { cols: cols.rows, idx: idx.rows, applied: applied.rows[0].n as number };
      } finally {
        await c.end();
      }
    };
    const once = await shape(first.url);
    execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL: first.url },
      stdio: 'pipe',
    });
    const twice = await shape(first.url);
    expect(twice).toEqual(once);
    expect(once.applied).toBe(journal.entries.length);
    // And the second database, built from empty on its own, is the same shape.
    expect(await shape(second.url)).toEqual(once);
  }, 300_000);

  it('every foreign key on the new tables leads an index', async () => {
    const { rows } = await client.query(`
      select c.conrelid::regclass::text as tbl, c.conname,
             exists (
               select 1 from pg_index i
                where i.indrelid = c.conrelid
                  and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
             ) as indexed
        from pg_constraint c
       where c.contype = 'f'
         and c.conrelid in ('promo.benefit_role_template'::regclass, 'promo.benefit_profile'::regclass)`);
    expect(rows.length).toBe(5);
    expect(rows.filter((r: { indexed: boolean }) => !r.indexed)).toEqual([]);
  });

  it('holds its CHECKs and partial unique indexes', async () => {
    await client.query('begin');
    try {
      const operator = '00000000-0000-7000-8000-000000000001';
      const emp = '00000000-0000-7000-8000-000000000002';
      await client.query(`insert into core.operator (id, name) values ($1, 'Review')`, [operator]);
      await client.query(`insert into core.employee (id, operator_id, name) values ($1, $2, 'Review')`, [emp, operator]);
      // Every existing and new employee row is a platform row unless told otherwise.
      expect((await client.query('select source from core.employee where id = $1', [emp])).rows[0].source).toBe('platform');
      expect(await sqlState(`update core.employee set source = 'hr' where id = $1`, [emp])).toBe('23514');

      const tpl = (id: string, role: string, from: string, to: string | null) =>
        sqlState(
          `insert into promo.benefit_role_template (id, operator_id, role, name, profile, effective_from, effective_to)
           values ($1, $2, $3, 'X', '{}'::jsonb, $4, $5)`,
          [id, operator, role, from, to],
        );
      expect(await tpl('00000000-0000-7000-8000-000000000010', 'boss', '2026-01-01', null)).toBe('23514');
      expect(await tpl('00000000-0000-7000-8000-000000000011', 'owner', '2026-05-01', '2026-04-01')).toBe('23514');
      await client.query(
        `insert into promo.benefit_role_template (id, operator_id, role, name, profile, effective_from)
         values ('00000000-0000-7000-8000-000000000012', $1, 'owner', 'Owner', '{}'::jsonb, '2026-01-01')`,
        [operator],
      );
      expect(await tpl('00000000-0000-7000-8000-000000000013', 'owner', '2026-06-01', null)).toBe('23505');
      // An empty range (replaced before it started) is allowed, closed rows any number.
      expect(await tpl('00000000-0000-7000-8000-000000000014', 'owner', '2026-06-01', '2026-06-01')).toBeNull();

      const prof = (id: string, roleName: string | null, archived: boolean) =>
        sqlState(
          `insert into promo.benefit_profile (id, operator_id, employee_id, benefit_role, effective_from, archived_at)
           values ($1, $2, $3, $4, '2026-01-01', $5)`,
          [id, operator, emp, roleName, archived ? new Date() : null],
        );
      expect(await prof('00000000-0000-7000-8000-000000000020', 'boss', false)).toBe('23514');
      await client.query(
        `insert into promo.benefit_profile (id, operator_id, employee_id, benefit_role, effective_from)
         values ('00000000-0000-7000-8000-000000000021', $1, $2, null, '2026-01-01')`,
        [operator, emp],
      );
      expect(await prof('00000000-0000-7000-8000-000000000022', 'staff', false)).toBe('23505');
      expect(await prof('00000000-0000-7000-8000-000000000023', 'staff', true)).toBeNull();

      // An OTO App id is unique per operator among live rows; archiving frees it.
      await client.query(`update core.employee set external_id = 'E1' where id = $1`, [emp]);
      expect(
        await sqlState(`insert into core.employee (id, operator_id, name, external_id) values ($1, $2, 'Twin', 'E1')`, [
          '00000000-0000-7000-8000-000000000030',
          operator,
        ]),
      ).toBe('23505');
      // Deleting an employee with benefit history is refused (restrict).
      expect(await sqlState('delete from core.employee where id = $1', [emp])).toBe('23503');
    } finally {
      await client.query('rollback');
    }
  });
});
