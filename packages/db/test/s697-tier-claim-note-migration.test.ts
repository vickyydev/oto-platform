import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-697, Other on the verify-tier step — one migration. Expand-only: one
 * nullable column, `pos.sale_tier_claim.note`, with no default and no row
 * written.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const entry = journal.entries.find((e) => /_sale_tier_claim_note$/.test(e.tag));

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({
    connectionString: database.url,
    application_name: 'oto-test-697-tier-claim-note-migration',
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

describe('SCRUM-697 sale_tier_claim.note migration', () => {
  it('is journalled, and is expand-only: one nullable column added', () => {
    expect(entry, 'a journalled *_sale_tier_claim_note migration').toBeDefined();
    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
      .trim();
    expect(sqlText).toBe('ALTER TABLE "pos"."sale_tier_claim" ADD COLUMN "note" text;');
  });

  it('leaves the column nullable with no default', async () => {
    const { rows } = await client.query<{ is_nullable: string; column_default: string | null; data_type: string }>(
      `select is_nullable, column_default, data_type
         from information_schema.columns
        where table_schema = 'pos' and table_name = 'sale_tier_claim' and column_name = 'note'`,
    );
    expect(rows).toEqual([{ is_nullable: 'YES', column_default: null, data_type: 'text' }]);
  });
});
