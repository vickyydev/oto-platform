import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-772 — a tier claim can record the Thai rate approved by hand: the
 * reason, what staff typed for Other, and a note. Expand only: three nullable
 * columns, an index for the Console's count, and a check that a typed reason
 * or a note never sits on a document check.
 */

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

describe('migration 0102', () => {
  it('adds the three approval columns, all nullable text', async () => {
    const { rows } = await client.query<{ column: string; type: string; nullable: string }>(
      `select column_name as column, data_type as type, is_nullable as nullable
         from information_schema.columns
        where table_schema = 'pos' and table_name = 'sale_tier_claim'
          and column_name like 'approval_%'
        order by column_name`,
    );
    expect(rows).toEqual([
      { column: 'approval_note', type: 'text', nullable: 'YES' },
      { column: 'approval_reason', type: 'text', nullable: 'YES' },
      { column: 'approval_reason_text', type: 'text', nullable: 'YES' },
    ]);
  });

  it('indexes the hand approvals for the per-staff count', async () => {
    const { rows } = await client.query<{ def: string }>(
      `select indexdef as def from pg_indexes
        where schemaname = 'pos' and indexname = 'sale_tier_claim_approval_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.def).toContain('(operator_id, account_id, created_at)');
    expect(rows[0]!.def).toContain('approval_reason IS NOT NULL');
  });

  it('keeps a typed reason and a note off a document check', async () => {
    const { rows } = await client.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'pos' and t.relname = 'sale_tier_claim'
          and c.conname = 'sale_tier_claim_approval_check'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.def).toMatch(/approval_reason IS NOT NULL/);
    expect(rows[0]!.def).toMatch(/approval_reason_text IS NULL/);
    expect(rows[0]!.def).toMatch(/approval_note IS NULL/);
  });
});
