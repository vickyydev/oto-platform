import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-860, a contact made by staff and a contact's name set by staff — one
 * migration, expand-only: three nullable columns on `inbox.contact`
 * (`profile_name`, `name_set_by_account_id` with its foreign key and index,
 * `name_set_at`), one new check tying the two name-set columns together, the
 * erased check swapped for one that only WIDENS what an erased row must not
 * carry, and one backfill of `profile_name` from `display_name` on the live
 * rows. Nothing is dropped for good, renamed or tightened: the one DROP is
 * the check that is re-added wider in the same file.
 *
 * The entry is found by its tag suffix, never by number, so a lane that lands
 * another migration first and renumbers this one does not break the test
 * (built as 0116). The writes are exercised in
 * `apps/api/test/inbox-contacts.test.ts`.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_inbox_contact_name$/.test(e.tag));
const entry = journal.entries[at];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-860-contact-name-migration' });
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

describe('SCRUM-860 contact name migration', () => {
  it('is journalled after its predecessor, on its snapshot, and only adds (one check swapped wider)', () => {
    expect(entry, 'a journalled *_inbox_contact_name migration').toBeDefined();
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
    expect(sqlText).not.toMatch(/\bRENAME\b|ALTER COLUMN|DROP COLUMN|DROP TABLE/);
    // The one DROP is the erased check, re-added wider below it.
    const drops = [...sqlText.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(drops).toEqual(['contact_erased_check']);
    expect(sqlText).toMatch(/ADD CONSTRAINT "contact_erased_check"/);
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(new Set(['inbox.contact']));
    // The backfill: the live rows' shown name becomes their channel name, once, and only where empty.
    expect(sqlText).toMatch(
      /UPDATE "inbox"\."contact" SET "profile_name" = "display_name" WHERE "profile_name" IS NULL AND "display_name" IS NOT NULL AND "erased_at" IS NULL;/,
    );
  });

  it('adds the three columns, all nullable, with the account foreign key and its index', async () => {
    const { rows } = await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'inbox' and table_name = 'contact'
          and column_name in ('profile_name', 'name_set_by_account_id', 'name_set_at')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'name_set_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'name_set_by_account_id', data_type: 'uuid', is_nullable: 'YES', column_default: null },
      { column_name: 'profile_name', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
    const fk = await client.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'inbox' and t.relname = 'contact' and c.conname = 'contact_name_set_by_account_id_account_id_fk'`,
    );
    expect(fk.rows[0]?.def).toMatch(/FOREIGN KEY \(name_set_by_account_id\) REFERENCES core\.account\(id\) ON DELETE RESTRICT/);
    const index = await client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'inbox' and indexname = 'contact_name_set_by_idx'`,
    );
    expect(index.rows[0]?.indexdef).toMatch(/\(name_set_by_account_id\)/);
  });

  it('ties the two name-set columns together and keeps every name off an erased row', async () => {
    const { rows } = await client.query<{ name: string; def: string }>(
      `select c.conname as name, pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'inbox' and t.relname = 'contact' and c.conname in ('contact_name_set_check', 'contact_erased_check')
        order by c.conname`,
    );
    expect(rows.map((r) => r.name)).toEqual(['contact_erased_check', 'contact_name_set_check']);
    expect(rows[1]!.def).toMatch(/\(name_set_at IS NULL\) = \(name_set_by_account_id IS NULL\)/);
    for (const column of ['phone IS NULL', 'member_id IS NULL', 'profile_name IS NULL', 'name_set_by_account_id IS NULL']) {
      expect(rows[0]!.def).toContain(column);
    }
  });
});
