import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-762, the phone number asked once at the start — one migration,
 * expand-only: `pos.sale.customer_phone` is a new nullable column with the
 * E.164 check every phone column carries (SCRUM-292), and nothing else moves.
 * It holds the number the family gave at the counter, printed on the child's
 * band when an adult stays.
 *
 * The entry is found by its tag suffix, never by number, so a lane that lands
 * another migration first and renumbers this one does not break the test. The
 * writes are exercised in `apps/api/test/sales-printing.test.ts` and
 * `apps/api/test/offline-selling.test.ts`.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_sale_customer_phone$/.test(e.tag));
const entry = journal.entries[at];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-762-sale-phone-migration' });
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

describe('SCRUM-762 sale customer phone migration', () => {
  it('is journalled after its predecessor, on its snapshot, and only adds to pos.sale', () => {
    expect(entry, 'a journalled *_sale_customer_phone migration').toBeDefined();
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
    expect(sqlText).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN|NOT NULL/);
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(new Set(['pos.sale']));
  });

  it('adds a nullable text column', async () => {
    const { rows } = await client.query<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns
        where table_schema = 'pos' and table_name = 'sale' and column_name = 'customer_phone'`,
    );
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
  });

  it('holds the number to E.164, or nothing', async () => {
    const { rows } = await client.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where c.contype = 'c' and n.nspname = 'pos' and t.relname = 'sale' and c.conname = 'sale_customer_phone_check'`,
    );
    expect(rows).toHaveLength(1);
    // The constraint itself, as the database states it, on a probe column of the same name.
    await client.query('create temp table phone_probe (customer_phone text)');
    await client.query(`alter table phone_probe add constraint probe_check ${rows[0]!.def}`);
    const accepts = async (value: string | null) => {
      try {
        await client.query('insert into phone_probe (customer_phone) values ($1)', [value]);
        return true;
      } catch {
        return false;
      }
    };
    expect(await accepts('+66812345678')).toBe(true);
    expect(await accepts('+447700900123')).toBe(true);
    expect(await accepts(null)).toBe(true);
    expect(await accepts('0812345678')).toBe(false);
    expect(await accepts('081 234 5678')).toBe(false);
    expect(await accepts('+0812345678')).toBe(false);
  });
});
