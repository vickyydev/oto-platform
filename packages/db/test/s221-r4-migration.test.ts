import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-21 (SCRUM-218) round 4 — the benefits' day migration, found by its tag
 * (`*_benefit_daily`) rather than its number, which is provisional.
 *
 *   - forward-only and additive: the previous snapshot survives intact, the
 *     only new table is `analytics.fact_benefit_daily`, and the SQL drops,
 *     renames, retypes and writes nothing;
 *   - every foreign key on the new table leads an index;
 *   - the CHECKs and the unique index hold what the rollup relies on: one row
 *     per branch, day, beneficiary and role; the four amounts add up to the
 *     total and what came off the bill is no more than it; no count is
 *     negative or above the applications, and no row has no application.
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
const entry = journal.entries.find((e) => e.tag.endsWith('_benefit_daily'))!;
const previous = journal.entries[journal.entries.indexOf(entry) - 1]!;
const snapshotOf = (tag: string) =>
  JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as Snapshot;
const SQL = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8');

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
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

describe('the benefits’ day migration (SCRUM-218 round 4)', () => {
  it('is in the journal once, directly after the previous entry, later than it, on its snapshot', () => {
    expect(journal.entries.filter((e) => e.tag.endsWith('_benefit_daily'))).toHaveLength(1);
    expect(entry.idx).toBe(previous.idx + 1);
    expect(entry.when).toBeGreaterThan(previous.when);
    expect(snapshotOf(entry.tag).prevId).toBe(snapshotOf(previous.tag).id);
  });

  it('is additive: one new table, nothing before it changed, dropped or retyped', () => {
    const before = snapshotOf(previous.tag).tables;
    const after = snapshotOf(entry.tag).tables;
    const changed: string[] = [];
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
        for (const k of Object.keys(now[part] ?? {})) {
          if (!(k in (table[part] ?? {}))) changed.push(`${name} ${part} ${k} added`);
        }
      }
    }
    expect(changed).toEqual([]);
    expect(Object.keys(after).filter((t) => !before[t])).toEqual(['analytics.fact_benefit_daily']);
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
      expect(s, s).toMatch(
        /^(CREATE TABLE "analytics"\."fact_benefit_daily"|CREATE (UNIQUE )?INDEX "fact_benefit_daily_|ALTER TABLE "analytics"\."fact_benefit_daily" ADD CONSTRAINT)/,
      );
      expect(s, s).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT)\b|ALTER COLUMN/i);
    }
  });

  it('every foreign key on the new table leads an index', async () => {
    const { rows } = await client.query(`
      select c.conname,
             exists (
               select 1 from pg_index i
                where i.indrelid = c.conrelid
                  and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
             ) as indexed
        from pg_constraint c
       where c.contype = 'f' and c.conrelid = 'analytics.fact_benefit_daily'::regclass`);
    expect(rows.map((r: { conname: string }) => r.conname).sort()).toEqual([
      'fact_benefit_daily_branch_id_branch_id_fk',
      'fact_benefit_daily_employee_id_employee_id_fk',
      'fact_benefit_daily_operator_id_operator_id_fk',
    ]);
    expect(rows.filter((r: { indexed: boolean }) => !r.indexed)).toEqual([]);
  });

  it('holds its CHECKs and its unique index', async () => {
    await client.query('begin');
    try {
      // The keys are switched off for this block: the CHECKs and the unique
      // index are what is under test, and they stay on.
      await client.query(`set local session_replication_role = replica`);
      const ids = (n: number) => `00000000-0000-7000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
      let next = 20;
      const row = (
        over: Partial<{
          role: string;
          employee: string;
          applications: number;
          compCount: number;
          comped: number;
          freeCount: number;
          units: number;
          free: number;
          creditCount: number;
          credit: number;
          discountCount: number;
          discount: number;
          total: number;
          applied: number;
        }> = {},
      ) => {
        const r = {
          role: 'manager',
          employee: ids(3),
          applications: 2,
          compCount: 0,
          comped: 0,
          freeCount: 1,
          units: 2,
          free: 12_000,
          creditCount: 1,
          credit: 50_000,
          discountCount: 2,
          discount: 9_000,
          total: 71_000,
          applied: 71_000,
          ...over,
        };
        return sqlState(
          `insert into analytics.fact_benefit_daily
             (id, operator_id, branch_id, business_date, employee_id, benefit_role, applications,
              comp_count, comped_satang, free_items_count, free_item_units, free_items_satang,
              credit_count, credit_satang, discount_count, discount_satang, total_relief_satang,
              applied_satang, provisional, computed_at)
           values ($1, $2, $3, '2026-10-07', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, true, now())`,
          [
            ids(next++),
            ids(1),
            ids(2),
            r.employee,
            r.role,
            r.applications,
            r.compCount,
            r.comped,
            r.freeCount,
            r.units,
            r.free,
            r.creditCount,
            r.credit,
            r.discountCount,
            r.discount,
            r.total,
            r.applied,
          ],
        );
      };
      expect(await row()).toBeNull();
      // One row per branch, day, beneficiary and role.
      await client.query(
        `insert into analytics.fact_benefit_daily (id, operator_id, branch_id, business_date, employee_id, benefit_role, applications, computed_at)
         values ($1, $2, $3, '2026-10-07', $4, 'manager', 1, now())`,
        [ids(90), ids(1), ids(2), ids(4)],
      );
      expect(
        await sqlState(
          `insert into analytics.fact_benefit_daily (id, operator_id, branch_id, business_date, employee_id, benefit_role, applications, computed_at)
           values ($1, $2, $3, '2026-10-07', $4, 'manager', 1, now())`,
          [ids(91), ids(1), ids(2), ids(4)],
        ),
      ).toBe('23505');
      // The same person under another role that day is another row.
      expect(
        await sqlState(
          `insert into analytics.fact_benefit_daily (id, operator_id, branch_id, business_date, employee_id, benefit_role, applications, computed_at)
           values ($1, $2, $3, '2026-10-07', $4, 'staff', 1, now())`,
          [ids(92), ids(1), ids(2), ids(4)],
        ),
      ).toBeNull();
      expect(await row({ role: 'cashier', employee: ids(5) })).toBe('23514');
      expect(await row({ employee: ids(6), applications: 0 })).toBe('23514');
      expect(await row({ employee: ids(7), discountCount: 3 })).toBe('23514');
      expect(await row({ employee: ids(8), units: -1 })).toBe('23514');
      expect(await row({ employee: ids(9), total: 70_999 })).toBe('23514');
      expect(await row({ employee: ids(10), applied: 71_001 })).toBe('23514');
      expect(await row({ employee: ids(11), free: -1, total: 58_999, applied: 0 })).toBe('23514');
      // What the cascade capped is less than the relief, and that is allowed.
      expect(await row({ employee: ids(12), applied: 60_000 })).toBeNull();
    } finally {
      await client.query('rollback');
    }
  });
});
