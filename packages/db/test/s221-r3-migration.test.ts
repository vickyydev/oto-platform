import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-21 (SCRUM-218) round 3 — the checkout migration, found by its tag
 * (`*_benefit_checkout`) rather than its number, which is provisional.
 *
 *   - forward-only and additive: the previous snapshot survives intact apart
 *     from one new nullable column on `pos.sale_discount` (with its index and
 *     key), and the only new tables are `promo.benefit_usage` and
 *     `promo.benefit_application`; the SQL drops, renames and retypes nothing;
 *   - every foreign key on the new tables, and the new one on
 *     `pos.sale_discount`, leads an index;
 *   - the CHECKs and the unique indexes hold what the service relies on — and
 *     the claim the service makes, one conditional upsert, gives the last unit
 *     to one claimer and nothing to the next.
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

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
) as Journal;
const entry = journal.entries.find((e) => e.tag.endsWith('_benefit_checkout'))!;
const previous = journal.entries[journal.entries.indexOf(entry) - 1]!;
const snapshotOf = (tag: string) =>
  JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8'),
  ) as Snapshot;
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

describe('the benefit checkout migration (SCRUM-218 round 3)', () => {
  it('is in the journal once, directly after the previous entry, later than it, on its snapshot', () => {
    expect(journal.entries.filter((e) => e.tag.endsWith('_benefit_checkout'))).toHaveLength(1);
    expect(entry.idx).toBe(previous.idx + 1);
    expect(entry.when).toBeGreaterThan(previous.when);
    expect(snapshotOf(entry.tag).prevId).toBe(snapshotOf(previous.tag).id);
  });

  it('is additive: one nullable column on sale_discount, two new tables, nothing dropped or retyped', () => {
    const before = snapshotOf(previous.tag).tables;
    const after = snapshotOf(entry.tag).tables;
    const changed: string[] = [];
    for (const [name, table] of Object.entries(before)) {
      const now = after[name];
      if (!now) {
        changed.push(`table ${name} removed`);
        continue;
      }
      for (const part of [
        'columns',
        'indexes',
        'foreignKeys',
        'uniqueConstraints',
        'checkConstraints',
      ] as const) {
        for (const [k, v] of Object.entries(table[part] ?? {})) {
          if (JSON.stringify(now[part]?.[k]) !== JSON.stringify(v)) changed.push(`${name} ${part} ${k}`);
        }
        for (const k of Object.keys(now[part] ?? {})) {
          if (!(k in (table[part] ?? {}))) changed.push(`${name} ${part} ${k} added`);
        }
      }
    }
    expect(changed.sort()).toEqual([
      'pos.sale_discount columns benefit_application_id added',
      'pos.sale_discount foreignKeys sale_discount_benefit_application_id_benefit_application_id_fk added',
      'pos.sale_discount indexes sale_discount_benefit_application_idx added',
    ]);
    const column = after['pos.sale_discount']!.columns!['benefit_application_id'] as { notNull: boolean };
    expect(column.notNull).toBe(false);
    expect(Object.keys(after).filter((t) => !before[t]).sort()).toEqual([
      'promo.benefit_application',
      'promo.benefit_usage',
    ]);
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
        /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE "(promo"\."benefit_(application|usage)|pos"\."sale_discount)" ADD (CONSTRAINT|COLUMN))/,
      );
      expect(s, s).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT)\b|ALTER COLUMN/i);
    }
  });

  it('every foreign key on the new tables, and the new one on sale_discount, leads an index', async () => {
    const { rows } = await client.query(`
      select c.conrelid::regclass::text as tbl, c.conname,
             exists (
               select 1 from pg_index i
                where i.indrelid = c.conrelid
                  and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
             ) as indexed
        from pg_constraint c
       where c.contype = 'f'
         and (c.conrelid in ('promo.benefit_usage'::regclass, 'promo.benefit_application'::regclass)
              or c.conname = 'sale_discount_benefit_application_id_benefit_application_id_fk')`);
    expect(rows.length).toBe(2 + 9 + 1);
    expect(rows.filter((r: { indexed: boolean }) => !r.indexed)).toEqual([]);
  });

  it('holds its CHECKs and its unique indexes, and the conditional claim gives the last unit once', async () => {
    await client.query('begin');
    try {
      // The keys this test does not exercise are switched off for it: the CHECKs
      // and the unique indexes are what is under test, and they stay on.
      await client.query(`set local session_replication_role = replica`);
      const ids = (n: number) => `00000000-0000-7000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
      const usage = (id: string, qty: number, credit: number, item = 'free:coffee', period = '2026-10-07') =>
        sqlState(
          `insert into promo.benefit_usage (id, operator_id, employee_id, item_key, period_kind, period_key, qty_used, credit_used_satang)
           values ($1, $2, $3, $4, 'daily', $5, $6, $7)`,
          [id, ids(1), ids(2), item, period, qty, credit],
        );
      expect(await usage(ids(10), -1, 0)).toBe('23514');
      expect(await usage(ids(11), 0, -1)).toBe('23514');
      expect(
        await sqlState(
          `insert into promo.benefit_usage (id, operator_id, employee_id, item_key, period_kind, period_key)
           values ($1, $2, $3, 'credit', 'weekly', '2026-10')`,
          [ids(12), ids(1), ids(2)],
        ),
      ).toBe('23514');
      // The service's claim: insert, or add only while the total stays within the quota.
      const claim = async (qty: number, quota: number) =>
        (
          await client.query(
            `insert into promo.benefit_usage as u (id, operator_id, employee_id, item_key, period_kind, period_key, qty_used)
             values (gen_random_uuid(), $1, $2, 'free:coffee', 'daily', '2026-10-08', $3)
             on conflict (employee_id, item_key, period_key) do update
                set qty_used = u.qty_used + excluded.qty_used, version = u.version + 1
              where u.qty_used + excluded.qty_used <= $4
             returning u.qty_used`,
            [ids(1), ids(2), qty, quota],
          )
        ).rows;
      expect(await claim(1, 2)).toEqual([{ qty_used: 1 }]);
      expect(await claim(1, 2)).toEqual([{ qty_used: 2 }]);
      expect(await claim(1, 2)).toEqual([]);
      const { rows } = await client.query(
        `select count(*)::int as n, max(qty_used) as q, max(version) as v from promo.benefit_usage where period_key = '2026-10-08'`,
      );
      expect(rows[0]).toEqual({ n: 1, q: 2, v: 2 });

      const application = (
        id: string,
        client_: string,
        over: Partial<{
          comped: number;
          free: number;
          credit: number;
          discount: number;
          total: number;
          applied: number;
          removedAt: string | null;
          reason: string | null;
          origin: string;
          role: string;
        }> = {},
      ) =>
        sqlState(
          `insert into promo.benefit_application
             (id, client_id, operator_id, branch_id, sale_id, business_date, employee_id, credential_id, benefit_role,
              profile_snapshot, engine_version, processed_by_account_id, station_id, origin, comped_satang, free_items_satang,
              credit_satang, discount_satang, total_relief_satang, applied_satang, occurred_at, removed_at, removed_reason)
           values ($1, $2, $3, $3, $3, '2026-10-07', $3, $3, $4, '{}'::jsonb, 'v', $3, $3, $5, $6, $7, $8, $9, $10, $11, now(), $12, $13)`,
          [
            id,
            client_,
            ids(1),
            over.role ?? 'staff',
            over.origin ?? 'cloud',
            over.comped ?? 0,
            over.free ?? 6_000,
            over.credit ?? 0,
            over.discount ?? 0,
            over.total ?? 6_000,
            over.applied ?? 6_000,
            over.removedAt ?? null,
            over.reason ?? null,
          ],
        );
      // The four amounts add up to the total, and no more comes off the bill than the total.
      expect(await application(ids(20), ids(50), { total: 5_000 })).toBe('23514');
      expect(await application(ids(21), ids(51), { applied: 7_000 })).toBe('23514');
      expect(await application(ids(22), ids(52), { free: -1, total: -1, applied: 0 })).toBe('23514');
      // Removed means a time and a reason, from the three there are.
      expect(await application(ids(23), ids(53), { removedAt: '2026-10-07T00:00:00Z' })).toBe('23514');
      expect(await application(ids(24), ids(54), { reason: 'moved' })).toBe('23514');
      expect(
        await application(ids(25), ids(55), { removedAt: '2026-10-07T00:00:00Z', reason: 'lost' }),
      ).toBe('23514');
      expect(await application(ids(26), ids(56), { origin: 'kiosk' })).toBe('23514');
      expect(await application(ids(27), ids(57), { role: 'guest' })).toBe('23514');
      // One live application per scan; a closed one does not stand in the way.
      await client.query(
        `insert into promo.benefit_application
           (id, client_id, operator_id, branch_id, sale_id, business_date, employee_id, credential_id, benefit_role,
            profile_snapshot, engine_version, processed_by_account_id, station_id, free_items_satang, total_relief_satang,
            applied_satang, occurred_at, removed_at, removed_reason)
         values ($1, $2, $3, $3, $3, '2026-10-07', $3, $3, 'staff', '{}'::jsonb, 'v', $3, $3, 6000, 6000, 6000, now(),
                 now(), 'moved')`,
        [ids(30), ids(60), ids(1)],
      );
      expect(await application(ids(31), ids(60))).toBeNull();
      await client.query(
        `insert into promo.benefit_application
           (id, client_id, operator_id, branch_id, sale_id, business_date, employee_id, credential_id, benefit_role,
            profile_snapshot, engine_version, processed_by_account_id, station_id, free_items_satang, total_relief_satang,
            applied_satang, occurred_at)
         values ($1, $2, $3, $3, $3, '2026-10-07', $3, $3, 'staff', '{}'::jsonb, 'v', $3, $3, 6000, 6000, 6000, now())`,
        [ids(32), ids(61), ids(1)],
      );
      expect(await application(ids(33), ids(61))).toBe('23505');
    } finally {
      await client.query('rollback');
    }
  });
});
