import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-798, the Golden Ticket — one migration, expand-only: a new table
 * (`promo.voucher_sale_item`, the item whose sale issues a voucher), a new
 * nullable column on `promo.voucher` (`issued_sale_id`, the sale that sold
 * it) and a new column with a constant default on `promo.voucher_definition`
 * (`ticket_offer`, what a free ticket admits — the booth's 1+1 unless said
 * otherwise). Nothing is dropped, renamed or tightened.
 *
 * The entry is found by its tag suffix, never by number, so a lane that lands
 * another migration first and renumbers this one does not break the test. The
 * writes are exercised in `apps/api/test/golden-ticket.test.ts`.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_golden_ticket$/.test(e.tag));
const entry = journal.entries[at];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-798-golden-ticket-migration' });
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

describe('SCRUM-798 Golden Ticket migration', () => {
  it('is journalled after its predecessor, on its snapshot, and only adds', () => {
    expect(entry, 'a journalled *_golden_ticket migration').toBeDefined();
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

    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');
    expect(sqlText).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/);
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(
      new Set(['promo.voucher', 'promo.voucher_definition', 'promo.voucher_sale_item']),
    );
  });

  it('adds the two columns: the selling sale nullable, the offer defaulting to the 1+1', async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      `select table_name, column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'promo'
          and ((table_name = 'voucher' and column_name = 'issued_sale_id')
            or (table_name = 'voucher_definition' and column_name = 'ticket_offer'))
        order by table_name`,
    );
    expect(rows).toEqual([
      { table_name: 'voucher', column_name: 'issued_sale_id', is_nullable: 'YES', column_default: null },
      { table_name: 'voucher_definition', column_name: 'ticket_offer', is_nullable: 'NO', column_default: "'one_plus_one'::text" },
    ]);
  });

  it('holds the offer to the two it knows, and one item to one voucher type', async () => {
    const { rows } = await client.query<{ name: string; def: string }>(
      `select c.conname as name, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'promo' and c.conname in ('voucher_definition_ticket_offer_check', 'voucher_sale_item_definition_fk')
        order by c.conname`,
    );
    expect(rows.map((r) => r.name)).toEqual(['voucher_definition_ticket_offer_check', 'voucher_sale_item_definition_fk']);
    expect(rows[0]!.def).toContain('one_plus_one');
    expect(rows[0]!.def).toContain('gift_day');
    const unique = await client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'promo' and indexname = 'voucher_sale_item_product_unique'`,
    );
    expect(unique.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(product_id\)/);
  });
});
