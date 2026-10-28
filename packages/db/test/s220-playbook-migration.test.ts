import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-220, the inbox playbook build — the shared contract's one migration.
 * Expand-only: CHECK swaps that only widen a list (the GM category and team
 * kind, the three closing-line template keys) and one nullable jsonb column
 * (`channel_account.silence_policy`) with its own shape CHECK.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const entry = journal.entries.find((e) => /_inbox_playbook$/.test(e.tag));

const SWAPPED = [
  'channel_account_default_category_check',
  'channel_account_out_of_hours_key_check',
  'conversation_category_check',
  'routing_rule_category_check',
  'team_key_check',
  'template_key_check',
];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-220-playbook-migration' });
  await client.connect();
}, 300_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

describe('SCRUM-220 inbox playbook migration', () => {
  it('is journalled, and is expand-only: it widens six CHECKs and adds one nullable column', () => {
    expect(entry, 'a journalled *_inbox_playbook migration').toBeDefined();
    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8');
    const dropped = [...sqlText.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(dropped).toEqual([...SWAPPED].sort());
    for (const name of SWAPPED) expect(sqlText).toMatch(new RegExp(`ADD CONSTRAINT "${name}" CHECK`));
    expect(sqlText).toMatch(/ADD COLUMN "silence_policy" jsonb;/);
    expect(sqlText).not.toMatch(/DROP (TABLE|COLUMN|INDEX)/i);
    expect(sqlText).not.toMatch(/ALTER COLUMN/i);
    expect(sqlText).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('adds silence_policy as a nullable jsonb column', async () => {
    const { rows } = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'inbox' and table_name = 'channel_account' and column_name = 'silence_policy'`,
    );
    expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
  });

  it('takes the GM category and team kind and the closing keys, refuses an unknown one, and holds the policy shape', async () => {
    const operatorId = newId();
    await client.query(`insert into core.operator (id, name) values ($1, 'ZZ TEST 220 playbook migration')`, [operatorId]);

    const teamId = newId();
    await client.query(
      `insert into inbox.team (id, operator_id, key, name, colour) values ($1, $2, 'gm', 'GM', 'amber')`,
      [teamId, operatorId],
    );
    await expect(
      client.query(`insert into inbox.team (id, operator_id, key, name, colour) values ($1, $2, 'ceo', 'X', 'x')`, [newId(), operatorId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'team_key_check' });

    await client.query(
      `insert into inbox.routing_rule (id, operator_id, team_id, category, primary_kind) values ($1, $2, $3, 'gm', 'team')`,
      [newId(), operatorId, teamId],
    );
    await expect(
      client.query(
        `insert into inbox.routing_rule (id, operator_id, team_id, category, primary_kind) values ($1, $2, $3, 'ceo', 'team')`,
        [newId(), operatorId, teamId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'routing_rule_category_check' });

    for (const key of ['closing_birthday', 'closing_gm', 'closing_branch']) {
      await client.query(
        `insert into inbox.template (id, operator_id, key, language, body) values ($1, $2, $3, 'en', 'ZZ TEST')`,
        [newId(), operatorId, key],
      );
    }
    await expect(
      client.query(`insert into inbox.template (id, operator_id, key, language, body) values ($1, $2, 'closing_ceo', 'en', 'x')`, [newId(), operatorId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'template_key_check' });

    const account = (policy: string | null, category = 'gm', outOfHours: string | null = 'closing_branch') =>
      client.query(
        `insert into inbox.channel_account (id, operator_id, channel, provider, external_id, display_name, default_category, out_of_hours_template_key, silence_policy)
           values ($1, $2, 'whatsapp', 'simulator', $3, 'ZZ TEST Reception', $4, $5, $6::jsonb)`,
        [newId(), operatorId, `zz-test-${newId()}`, category, outOfHours, policy],
      );
    await account(null);
    await account('{"silentIntents": []}');
    await account('{"silentIntents": ["drop_off_care", "nanny_booking"]}');
    await expect(account('[]')).rejects.toMatchObject({ code: '23514', constraint: 'channel_account_silence_policy_check' });
    await expect(account('{"silentIntents": "drop_off_care"}')).rejects.toMatchObject({
      code: '23514',
      constraint: 'channel_account_silence_policy_check',
    });
    await expect(account('{}')).rejects.toMatchObject({ code: '23514', constraint: 'channel_account_silence_policy_check' });
    await expect(account(null, 'ceo')).rejects.toMatchObject({ code: '23514', constraint: 'channel_account_default_category_check' });
    await expect(account(null, 'gm', 'closing_ceo')).rejects.toMatchObject({
      code: '23514',
      constraint: 'channel_account_out_of_hours_key_check',
    });
  });
});
