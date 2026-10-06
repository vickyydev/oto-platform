import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-495 — the two paid extra-time tables, asserted against a live
 * database built from the committed migrations: every foreign key is indexed
 * and both tables carry created_at / updated_at (CLAUDE.md §8), because both
 * are written to after their insert.
 */

const TABLES = ['pos.sale_extension', 'pos.sale_extension_band'];

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

describe('migration 0062', () => {
  it('indexes every foreign key of the two tables', async () => {
    const { rows } = await client.query<{ table: string; column: string }>(
      `select n.nspname || '.' || t.relname as table, a.attname as column
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join unnest(c.conkey) as k(attnum) on true
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f'
          and n.nspname || '.' || t.relname = any($1)
          and not exists (
            select 1 from pg_index i
             where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
      [TABLES],
    );
    expect(rows).toEqual([]);
  });

  it('gives both tables created_at and updated_at', async () => {
    const { rows } = await client.query<{ table: string; column: string }>(
      `select table_schema || '.' || table_name as table, column_name as column
         from information_schema.columns
        where table_schema || '.' || table_name = any($1)
          and column_name in ('created_at', 'updated_at')
          and is_nullable = 'NO'
        order by 1, 2`,
      [TABLES],
    );
    expect(rows).toEqual([
      { table: 'pos.sale_extension', column: 'created_at' },
      { table: 'pos.sale_extension', column: 'updated_at' },
      { table: 'pos.sale_extension_band', column: 'created_at' },
      { table: 'pos.sale_extension_band', column: 'updated_at' },
    ]);
  });
});
