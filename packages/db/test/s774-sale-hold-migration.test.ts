import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-774, Held sales — one migration, expand-only: `pos.sale_hold` is a new
 * table and nothing else moves. A sale parked at the till's payment step
 * stays `tendering` on the ledger; this row is its parking ticket, and one
 * sale has at most one open at a time.
 *
 * The entry is found by its tag suffix, never by number, so a lane that lands
 * another migration first and renumbers this one does not break the test. The
 * writes are exercised in `apps/api/test/sale-holds.test.ts`.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_sale_hold$/.test(e.tag));
const entry = journal.entries[at];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-774-sale-hold-migration' });
  await client.connect();
}, 300_000);

afterAll(async () => {
  try {
    await client?.end();
  } finally {
    try {
      await database?.drop();
    } finally {
      await stopTestServer();
    }
  }
});

const checks = async (): Promise<Map<string, string>> => {
  const { rows } = await client.query<{ conname: string; def: string }>(
    `select c.conname, pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where c.contype = 'c' and n.nspname = 'pos' and t.relname = 'sale_hold'`,
  );
  return new Map(rows.map((r) => [r.conname, r.def]));
};

describe('SCRUM-774 sale hold migration', () => {
  it('is journalled after its predecessor, on its snapshot, and only adds', () => {
    expect(entry, 'a journalled *_sale_hold migration').toBeDefined();
    const before = journal.entries[at - 1]!;
    expect(entry!.idx).toBe(before.idx + 1);
    expect(entry!.when).toBeGreaterThan(before.when);
    const snapshot = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${entry!.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { prevId: string };
    const previous = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${before.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);

    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8');
    expect(sqlText).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/);
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(new Set(['pos.sale_hold']));
  });

  it('indexes every foreign key, and none of them cascades', async () => {
    const { rows: unindexed } = await client.query(
      `select a.attname as fk
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join unnest(c.conkey) as k(attnum) on true
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f' and n.nspname = 'pos' and t.relname = 'sale_hold'
          and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum and i.indpred is null)`,
    );
    expect(unindexed).toEqual([]);
    const { rows: actions } = await client.query<{ confdeltype: string; count: number }>(
      `select c.confdeltype, count(*)::int as count
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where c.contype = 'f' and n.nspname = 'pos' and t.relname = 'sale_hold'
        group by c.confdeltype`,
    );
    expect(actions).toEqual([{ confdeltype: 'r', count: 7 }]);
  });

  it('keeps one open hold per sale and one hold per press', async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'pos' and tablename = 'sale_hold' and indexname in ('sale_hold_open_unique', 'sale_hold_action_unique')
        order by indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(['sale_hold_action_unique', 'sale_hold_open_unique']);
    expect(rows[1]!.indexdef).toMatch(/UNIQUE INDEX .*\(sale_id\) WHERE \(released_at IS NULL\)/);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE INDEX .*\(operator_id, action_id\) WHERE \(action_id IS NOT NULL\)/);
  });

  it('holds the money and the ending to what the service promises', async () => {
    const def = await checks();
    expect(def.get('sale_hold_kind_check')).toMatch(/held.*part_paid/);
    // A held sale took no money; a part-paid one took some; both still owe.
    expect(def.get('sale_hold_money_check')).toMatch(/balance_satang > 0/);
    expect(def.get('sale_hold_money_check')).toMatch(/kind = 'held'::text\) AND \(paid_satang = 0\)/);
    expect(def.get('sale_hold_money_check')).toMatch(/kind = 'part_paid'::text\) AND \(paid_satang > 0\)/);
    // An ended hold says how it ended, and only in the five words the list knows.
    expect(def.get('sale_hold_released_check')).toMatch(/resumed.*paid.*voided.*not_collected.*refunded/);
    expect(def.get('sale_hold_label_check')).toMatch(/btrim\(label\)/);
  });
});
