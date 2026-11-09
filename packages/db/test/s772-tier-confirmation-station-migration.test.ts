import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-772 — the Thai rate confirmed at the till, with no document: who,
 * where and when is the record. Migration 0107 adds the station beside the
 * account and the branch on the member's verification and on the sale's tier
 * claim. Expand only: two nullable columns, each with its foreign key and an
 * index (every foreign key carries one).
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

const TABLES = [
  { schema: 'crm', table: 'member_tier_verification', index: 'mtv_station_idx' },
  { schema: 'pos', table: 'sale_tier_claim', index: 'sale_tier_claim_station_idx' },
] as const;

describe('migration 0107', () => {
  it('adds station_id, a nullable uuid, to both records', async () => {
    for (const { schema, table } of TABLES) {
      const { rows } = await client.query<{ type: string; nullable: string }>(
        `select data_type as type, is_nullable as nullable
           from information_schema.columns
          where table_schema = $1 and table_name = $2 and column_name = 'station_id'`,
        [schema, table],
      );
      expect(rows, `${schema}.${table}`).toEqual([{ type: 'uuid', nullable: 'YES' }]);
    }
  });

  it('points each at core.station and indexes it', async () => {
    for (const { schema, table, index } of TABLES) {
      const fks = await client.query<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           join pg_namespace n on n.oid = t.relnamespace
          where n.nspname = $1 and t.relname = $2 and c.contype = 'f'
            and pg_get_constraintdef(c.oid) like 'FOREIGN KEY (station_id)%'`,
        [schema, table],
      );
      expect(fks.rows, `${schema}.${table}`).toHaveLength(1);
      expect(fks.rows[0]!.def).toContain('REFERENCES core.station(id)');
      const indexes = await client.query<{ def: string }>(
        `select indexdef as def from pg_indexes where schemaname = $1 and indexname = $2`,
        [schema, index],
      );
      expect(indexes.rows, index).toHaveLength(1);
      expect(indexes.rows[0]!.def).toContain('(station_id)');
    }
  });
});
