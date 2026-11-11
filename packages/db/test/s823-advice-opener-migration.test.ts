import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INBOX_TEMPLATE_KEYS } from '../src/schema/inbox';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-823, the opener beside a birthday advice hand-over — one migration,
 * expand-only: the template key CHECK and the out-of-hours key CHECK are
 * swapped for lists that only WIDEN, by `opener_birthday_advice` and
 * `opener_birthday_advice_park_known`. No row is written here; platform-sync
 * lays the lines (`inbox-i1.test.ts`).
 *
 * The entry is found by its tag suffix, never by number: built as 0113, it
 * became 0114 when SCRUM-828's `0113_product_beo_only` landed first. Drizzle's
 * migrator applies a migration only when its journal time is later than the
 * last one applied, so its time must be later than the entry just before it,
 * whichever that is, and its snapshot must chain onto that entry's.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_inbox_advice_opener$/.test(e.tag));
const entry = journal.entries[at];
const NEW_KEYS = ['opener_birthday_advice', 'opener_birthday_advice_park_known'];

type Snapshot = { id: string; prevId: string; tables: Record<string, { checkConstraints?: Record<string, { value: string }> }> };
const snapshotOf = (tag: string) =>
  JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as Snapshot;
const keysIn = (check: string) => [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-823-advice-opener-migration' });
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

describe('SCRUM-823 advice opener migration', () => {
  it('is journalled after its predecessor (0113_product_beo_only), later than it, on its snapshot', () => {
    expect(entry, 'a journalled *_inbox_advice_opener migration').toBeDefined();
    const before = journal.entries[at - 1]!;
    expect(entry!.idx).toBe(before.idx + 1);
    expect(entry!.when, `after ${before.tag}`).toBeGreaterThan(before.when);
    expect(journal.entries.findIndex((e) => e.tag === '0113_product_beo_only')).toBeLessThan(at);
    expect(snapshotOf(entry!.tag).prevId).toBe(snapshotOf(before.tag).id);
  });

  it('only widens the two key CHECKs, by the two opener keys', () => {
    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');
    const statements = sqlText.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    const dropped = statements.flatMap((s) => [...s.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]));
    const added = statements.flatMap((s) => [...s.matchAll(/ADD CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]));
    expect(statements).toHaveLength(4);
    expect(new Set(dropped)).toEqual(new Set(['template_key_check', 'channel_account_out_of_hours_key_check']));
    expect(new Set(added)).toEqual(new Set(dropped));
    expect(sqlText).not.toMatch(/\bRENAME\b|ALTER COLUMN|DROP COLUMN|DROP TABLE|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);

    // Against the snapshot before it: the old list, and exactly the two opener keys more.
    const before = snapshotOf(journal.entries[at - 1]!.tag).tables;
    const after = snapshotOf(entry!.tag).tables;
    for (const [table, check] of [
      ['inbox.template', 'template_key_check'],
      ['inbox.channel_account', 'channel_account_out_of_hours_key_check'],
    ] as const) {
      const was = keysIn(before[table]!.checkConstraints![check]!.value);
      const now = keysIn(after[table]!.checkConstraints![check]!.value);
      expect(now, check).toEqual([...was, ...NEW_KEYS]);
      // The live list begins with this migration's: a later one (SCRUM-825's party lines) only appends.
      expect(INBOX_TEMPLATE_KEYS.slice(0, now.length), check).toEqual(now);
    }
  });

  it('the database takes both opener keys on a template and as an out-of-hours key', async () => {
    const { rows } = await client.query<{ name: string; def: string }>(
      `select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('template_key_check', 'channel_account_out_of_hours_key_check') order by conname`,
    );
    expect(rows.map((r) => r.name)).toEqual(['channel_account_out_of_hours_key_check', 'template_key_check']);
    for (const r of rows) for (const key of NEW_KEYS) expect(r.def, r.name).toContain(`'${key}'`);
  });
});
