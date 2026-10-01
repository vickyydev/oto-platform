import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-14b round 1 — RE-CHECK gate (invariant 5): 0048 reshapes the placeholder
 * tables only while they are EMPTY. Its opening guard (the first statement of
 * the migration) is run, as written in the file, against a built database
 * holding one placeholder row: it must stop with its sentence.
 */
const SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0048_stock_ledger.sql'),
  'utf8',
);
const GUARD = SQL.split('--> statement-breakpoint')[0]!.replace(/^--.*$/gm, '').trim();

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

describe('re-check — 0048 refuses to reshape tables that hold rows', () => {
  it('passes on empty placeholders and stops, in words, on a stock_item or stock_level row', async () => {
    expect(GUARD.startsWith('DO $$')).toBe(true);
    await client.query('begin');
    try {
      // Empty (a database built from the migrations, unseeded): the guard is silent.
      const { rows } = await client.query(
        `select (select count(*) from pos.stock_item)::int + (select count(*) from pos.stock_level)::int as n`,
      );
      expect((rows[0] as { n: number }).n).toBe(0);
      await expect(client.query(GUARD)).resolves.toBeTruthy();
      const op = await client.query(`insert into core.operator (id, name) values (gen_random_uuid(), 'Guard Op') returning id`);
      const br = await client.query(
        `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'Guard Park', 'gp-' || substr(md5(random()::text), 1, 8)) returning id`,
        [op.rows[0].id],
      );
      await client.query(`insert into pos.stock_item (id, operator_id, branch_id, name) values (gen_random_uuid(), $1, $2, 'Placeholder')`, [
        op.rows[0].id,
        br.rows[0].id,
      ]);
      await expect(client.query(GUARD)).rejects.toThrow(/0048: pos.stock_item or pos.stock_level holds rows/);
    } finally {
      await client.query('rollback');
    }
  });
});
