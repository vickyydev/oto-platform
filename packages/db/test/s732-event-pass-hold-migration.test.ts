import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-732, a camp or event pass waiting for its money — one migration,
 * expand-only: `pos.event_pass_hold` is a new table and nothing else moves. A
 * pass paid by QR or card waits beside its sale in this row, and `finaliseSale`
 * turns it into the roster entry, so one sale holds at most one pass.
 *
 * The entry is found by its tag suffix, never by number, so a lane that lands
 * another migration first and renumbers this one does not break the test. The
 * writes are exercised in `apps/api/test/scrum-732-routed-tenders.test.ts`.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_event_pass_hold$/.test(e.tag));
const entry = journal.entries[at];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({
    connectionString: database.url,
    application_name: 'oto-test-732-event-pass-hold-migration',
  });
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

describe('SCRUM-732 event pass hold migration', () => {
  it('is journalled after its predecessor, on its snapshot, and only adds', () => {
    expect(entry, 'a journalled *_event_pass_hold migration').toBeDefined();
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
    // Every ALTER adds a foreign key to the new table; no other table is touched.
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(new Set(['pos.event_pass_hold']));
  });

  it('indexes every foreign key, and none of them cascades', async () => {
    const { rows: unindexed } = await client.query(
      `select a.attname as fk
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join unnest(c.conkey) as k(attnum) on true
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f' and n.nspname = 'pos' and t.relname = 'event_pass_hold'
          and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
    );
    expect(unindexed).toEqual([]);
    const { rows: actions } = await client.query<{ confdeltype: string; count: number }>(
      `select c.confdeltype, count(*)::int as count
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where c.contype = 'f' and n.nspname = 'pos' and t.relname = 'event_pass_hold'
        group by c.confdeltype`,
    );
    expect(actions).toEqual([{ confdeltype: 'r', count: 8 }]);
  });

  it('keeps one pass to one sale, and its status and price to what the write promises', async () => {
    const { rows: unique } = await client.query(
      `select indexdef from pg_indexes
        where schemaname = 'pos' and tablename = 'event_pass_hold' and indexname = 'event_pass_hold_sale_unique'`,
    );
    expect(unique).toHaveLength(1);
    expect((unique[0] as { indexdef: string }).indexdef).toMatch(/UNIQUE INDEX .*\(sale_id\)/);

    const { rows: checks } = await client.query<{ conname: string; def: string }>(
      `select c.conname, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where c.contype = 'c' and n.nspname = 'pos' and t.relname = 'event_pass_hold'
        order by c.conname`,
    );
    const def = (name: string) => checks.find((c) => c.conname === name)?.def ?? '';
    expect(def('event_pass_hold_status_check')).toMatch(/pending.*applied.*released/);
    expect(def('event_pass_hold_type_check')).toMatch(/camp.*event/);
    expect(def('event_pass_hold_price_check')).toMatch(/price_snapshot_satang > 0/);
  });

  it('starts a hold as pending, with nothing applied or released yet', async () => {
    const { rows } = await client.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
      `select column_name, column_default, is_nullable
         from information_schema.columns
        where table_schema = 'pos' and table_name = 'event_pass_hold'
          and column_name in ('status', 'applied_at', 'released_at')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'applied_at', column_default: null, is_nullable: 'YES' },
      { column_name: 'released_at', column_default: null, is_nullable: 'YES' },
      { column_name: 'status', column_default: "'pending'::text", is_nullable: 'NO' },
    ]);
  });
});
