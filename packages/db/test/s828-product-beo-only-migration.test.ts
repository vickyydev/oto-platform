import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-828 — a product the BEO created, sold only inside a party. Migration
 * 0113 adds `pos.product.beo_only`. Expand only: one column with a constant
 * default, so every product already on a till reads false and sells exactly
 * as before, and a release that does not know the column never reads it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

describe('migration 0113', () => {
  it('adds beo_only, boolean, not null, false by default', async () => {
    const { rows } = await client.query<{ type: string; nullable: string; def: string | null }>(
      `select data_type as type, is_nullable as nullable, column_default as def
         from information_schema.columns
        where table_schema = 'pos' and table_name = 'product' and column_name = 'beo_only'`,
    );
    expect(rows).toEqual([{ type: 'boolean', nullable: 'NO', def: 'false' }]);
  });

  it('is expand only: one ADD COLUMN with a constant default, nothing dropped, renamed or rewritten', () => {
    const statements = readFileSync(join(MIGRATIONS, '0113_product_beo_only.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    expect(statements).toEqual(['ALTER TABLE "pos"."product" ADD COLUMN "beo_only" boolean DEFAULT false NOT NULL;']);
  });

  it('comes after 0109 in the journal, later than it', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const at = journal.entries.findIndex((e) => e.tag === '0113_product_beo_only');
    const before = journal.entries.find((e) => e.tag === '0109_party_slips')!;
    expect(at).toBeGreaterThan(journal.entries.indexOf(before));
    expect(journal.entries[at]!.when).toBeGreaterThan(before.when);
  });
});
