import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-696, the inbox assistant's behaviour rules — one migration.
 * Expand-only: one CREATE TABLE (`inbox.ai_rule`) with its foreign keys,
 * indexes and CHECKs; no row written.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const entry = journal.entries.find((e) => /_inbox_ai_rule$/.test(e.tag));

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-696-ai-rule-migration' });
  await client.connect();
}, 300_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

describe('SCRUM-696 inbox ai_rule migration', () => {
  it('is journalled, and is expand-only: one CREATE TABLE and its constraints and indexes', () => {
    expect(entry, 'a journalled *_inbox_ai_rule migration').toBeDefined();
    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');
    expect([...sqlText.matchAll(/CREATE TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual(['inbox.ai_rule']);
    expect(sqlText).not.toMatch(/DROP (TABLE|COLUMN|INDEX|CONSTRAINT)/i);
    expect(sqlText).not.toMatch(/ALTER COLUMN/i);
    expect(sqlText).not.toMatch(/\b(INSERT INTO|UPDATE "|DELETE FROM)\b/i);
    expect(sqlText).not.toMatch(/ALTER TABLE "(?!inbox"\."ai_rule")/);
  });

  it('takes a valid draft and refuses an approved row without its approver, a bad status and a bad ask_first shape', async () => {
    const operatorId = newId();
    await client.query(`insert into core.operator (id, name) values ($1, 'ZZ TEST 696 ai rule migration')`, [operatorId]);

    const rule = (fields: { status?: string; askFirst?: string | null; intent?: string }) =>
      client.query(
        `insert into inbox.ai_rule (id, operator_id, intent, instruction, ask_first, status)
           values ($1, $2, $3, 'ZZ TEST first ask which park', $4::jsonb, $5)`,
        [newId(), operatorId, fields.intent ?? 'lost_item', fields.askFirst ?? null, fields.status ?? 'draft'],
      );

    await rule({});
    await rule({ intent: 'any', askFirst: '{"condition": "branch_unknown", "question": {"en": "Which park did you visit?"}}' });
    await rule({ askFirst: '{"condition": "always", "question": {"en": "What does it look like?", "th": "หน้าตาเป็นอย่างไรคะ"}}' });

    await expect(rule({ status: 'approved' })).rejects.toMatchObject({ code: '23514', constraint: 'ai_rule_approved_check' });
    await expect(rule({ status: 'live' })).rejects.toMatchObject({ code: '23514', constraint: 'ai_rule_status_check' });
    await expect(rule({ intent: 'Lost Item' })).rejects.toMatchObject({ code: '23514', constraint: 'ai_rule_intent_check' });
    await expect(rule({ askFirst: '{"condition": "later", "question": {"en": "Which park?"}}' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'ai_rule_ask_first_check',
    });
    await expect(rule({ askFirst: '{"condition": "always", "question": {"th": "สาขาไหนคะ"}}' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'ai_rule_ask_first_check',
    });
    await expect(rule({ askFirst: '[]' })).rejects.toMatchObject({ code: '23514', constraint: 'ai_rule_ask_first_check' });
  });
});
