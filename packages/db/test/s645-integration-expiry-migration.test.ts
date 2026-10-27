import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-645 / planner ruling Q26 — the owner-supplied credential expiry
 * metadata. Expand-only: one new table, nothing existing altered. It holds a
 * DATE and who set it, never a credential or any part of one.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const entry = journal.entries.find((e) => /_integration_expiry$/.test(e.tag));

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-645-expiry-migration' });
  await client.connect();
}, 300_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

describe('SCRUM-645 integration credential expiry migration', () => {
  it('is journalled, and is expand-only: it creates and constrains, and alters or drops nothing existing', () => {
    expect(entry, 'a journalled *_integration_expiry migration').toBeDefined();
    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8');
    expect(sqlText).toMatch(/CREATE TABLE "core"\."integration_credential_expiry"/);
    expect(sqlText).not.toMatch(/\bDROP\b/i);
    expect(sqlText).not.toMatch(/ALTER TABLE "core"\."(?!integration_credential_expiry")/);
    expect(sqlText).not.toMatch(/ALTER COLUMN/i);
  });

  it('carries exactly the metadata columns — a date and who set it, no credential value', async () => {
    const { rows } = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'core' and table_name = 'integration_credential_expiry' order by column_name`,
    );
    expect(rows.map((r) => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ['created_at', 'timestamp with time zone', 'NO'],
      ['expires_on', 'date', 'YES'],
      ['id', 'uuid', 'NO'],
      ['integration_key', 'text', 'NO'],
      ['operator_id', 'uuid', 'NO'],
      ['set_at', 'timestamp with time zone', 'YES'],
      ['set_by_account_id', 'uuid', 'YES'],
      ['updated_at', 'timestamp with time zone', 'NO'],
    ]);
  });

  it('keeps one row per operator and integration, refuses an unknown integration, and needs a real operator', async () => {
    const operatorId = newId();
    await client.query(`insert into core.operator (id, name) values ($1, 'ZZ TEST 645 expiry migration')`, [operatorId]);
    await client.query(
      `insert into core.integration_credential_expiry (id, operator_id, integration_key, expires_on) values ($1, $2, 'meta_channel_token', '2026-12-01')`,
      [newId(), operatorId],
    );
    await expect(client.query(
      `insert into core.integration_credential_expiry (id, operator_id, integration_key) values ($1, $2, 'meta_channel_token')`,
      [newId(), operatorId],
    )).rejects.toMatchObject({ code: '23505', constraint: 'integration_credential_expiry_operator_key_unique' });
    await expect(client.query(
      `insert into core.integration_credential_expiry (id, operator_id, integration_key) values ($1, $2, 'ZZ TEST unknown')`,
      [newId(), operatorId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'integration_credential_expiry_key_check' });
    await expect(client.query(
      `insert into core.integration_credential_expiry (id, operator_id, integration_key) values ($1, $2, 'pgw_maintenance_key')`,
      [newId(), newId()],
    )).rejects.toMatchObject({ code: '23503' });
    for (const key of ['pgw_maintenance_key', 'otoapp_directory_key']) {
      await client.query(
        `insert into core.integration_credential_expiry (id, operator_id, integration_key) values ($1, $2, $3)`,
        [newId(), operatorId, key],
      );
    }
  });

  it('indexes the account foreign key', async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'core' and tablename = 'integration_credential_expiry' order by indexname`,
    );
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/\(operator_id, integration_key\)/);
    expect(defs).toMatch(/\(set_by_account_id\)/);
  });
});
