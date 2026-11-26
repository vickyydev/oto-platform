import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-1077, the gate's messages in the language the guest chose at the
 * till — one migration, expand-only: `pos.sale.guest_language` is a new
 * nullable column held to the customer display's five languages, and nothing
 * else moves.
 *
 * The entry is found by its tag suffix, never by number, so a lane that lands
 * another migration first and renumbers this one does not break the test. The
 * writes are exercised in `apps/api/test/s1077-guest-language.test.ts`.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_sale_guest_language$/.test(e.tag));
const entry = journal.entries[at];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-1077-guest-language-migration' });
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

describe('SCRUM-1077 sale guest language migration', () => {
  it('is journalled after its predecessor, on its snapshot, and only adds to pos.sale', () => {
    expect(entry, 'a journalled *_sale_guest_language migration').toBeDefined();
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
    expect(sqlText).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN|NOT NULL|\bDEFAULT\b/);
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(new Set(['pos.sale']));
  });

  it('adds a nullable text column with no default', async () => {
    const { rows } = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'pos' and table_name = 'sale' and column_name = 'guest_language'`,
    );
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  it('holds the language to the customer display’s five, or nothing', async () => {
    const { rows } = await client.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where c.contype = 'c' and n.nspname = 'pos' and t.relname = 'sale' and c.conname = 'sale_guest_language_check'`,
    );
    expect(rows).toHaveLength(1);
    // The constraint itself, as the database states it, on a probe column of the same name.
    await client.query('create temp table language_probe (guest_language text)');
    await client.query(`alter table language_probe add constraint probe_check ${rows[0]!.def}`);
    const accepts = async (value: string | null) => {
      try {
        await client.query('insert into language_probe (guest_language) values ($1)', [value]);
        return true;
      } catch {
        return false;
      }
    };
    for (const lang of ['en', 'zh', 'th', 'ru', 'fr']) expect(await accepts(lang), lang).toBe(true);
    expect(await accepts(null)).toBe(true);
    for (const other of ['de', 'EN', '', 'en ', 'english']) expect(await accepts(other), other).toBe(false);
  });
});
