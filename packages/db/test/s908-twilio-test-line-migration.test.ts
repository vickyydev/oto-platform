import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-908, the WhatsApp test line on Twilio's sandbox — one migration,
 * expand-only in effect: `twilio` added to the channel account's provider
 * CHECK (a swap that only widens it), two nullable columns on
 * `inbox.conversation` (`archived_at`, `archived_by_account_id` with its
 * foreign key, index and a both-or-neither check) for Start over, and the
 * thread key narrowed to the live threads so a cleared one stands aside.
 *
 * The entry is found by its tag suffix, never by number: built as 0121, it
 * may land under another number. The writes are exercised in
 * `apps/api/test/inbox-twilio-test-line.test.ts`.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_inbox_twilio_test_line$/.test(e.tag));
const entry = journal.entries[at];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

const OPERATOR = '00000000-0000-7000-8908-000000000001';
const CONTACT = '00000000-0000-7000-8908-000000000003';
const LINE = '00000000-0000-7000-8908-000000000004';
const PERSON = '00000000-0000-7000-8908-000000000005';

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-908-twilio-migration' });
  await client.connect();
  await client.query(`insert into core.operator (id, name) values ($1, 'ZZ TEST 908')`, [OPERATOR]);
  await client.query(
    `insert into core.account (id, operator_id, phone, password_hash, status) values ($1, $2, '+66898700050', 'x', 'active')`,
    [PERSON, OPERATOR],
  );
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

describe('SCRUM-908 Twilio test line migration', () => {
  it('is journalled after its predecessor, on its snapshot, and drops nothing for good', () => {
    expect(entry, 'a journalled *_inbox_twilio_test_line migration').toBeDefined();
    const before = journal.entries[at - 1]!;
    expect(entry!.idx).toBe(before.idx + 1);
    expect(entry!.when).toBeGreaterThan(before.when);
    const snapshot = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${entry!.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { prevId: string };
    const previous = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${before.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);

    const raw = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8');
    expect(raw, 'the header carries the reverse recipe').toMatch(/^-- TO REVERSE:/m);
    const sqlText = raw
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');
    expect(sqlText).not.toMatch(/\bRENAME\b|ALTER COLUMN|DROP COLUMN|DROP TABLE/);
    // No row is written: no statement is an UPDATE or a DELETE.
    expect(sqlText).not.toMatch(/(^|breakpoint\s*)(UPDATE|DELETE FROM)\b/m);
    // The one CHECK dropped is re-added wider; the one index dropped is re-made over the live threads.
    expect([...sqlText.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1])).toEqual(['channel_account_provider_check']);
    expect(sqlText).toMatch(/ADD CONSTRAINT "channel_account_provider_check"/);
    expect([...sqlText.matchAll(/DROP INDEX "inbox"\."([a-z_]+)"/g)].map((m) => m[1])).toEqual(['conversation_thread_unique']);
    expect(sqlText).toMatch(/CREATE UNIQUE INDEX "conversation_thread_unique"[^;]*WHERE archived_at is null;/);
  });

  it('accepts a twilio channel account, and still refuses a provider nobody named', async () => {
    await client.query(
      `insert into inbox.channel_account (id, operator_id, channel, provider, external_id, display_name, credential_ref)
       values ($1, $2, 'whatsapp', 'twilio', '+14155238886', 'ZZ TEST line', 'SANDBOX')`,
      [LINE, OPERATOR],
    );
    await expect(
      client.query(
        `insert into inbox.channel_account (id, operator_id, channel, provider, external_id, display_name)
         values (gen_random_uuid(), $1, 'whatsapp', 'nope', 'x', 'x')`,
        [OPERATOR],
      ),
    ).rejects.toThrow(/channel_account_provider_check/);
  });

  it('keeps ONE live thread per contact per number, and lets a cleared one stand aside', async () => {
    await client.query(
      `insert into inbox.contact (id, operator_id, channel, external_handle, phone) values ($1, $2, 'whatsapp', '+66898700001', '+66898700001')`,
      [CONTACT, OPERATOR],
    );
    const thread = (id: string) =>
      client.query(
        `insert into inbox.conversation (id, operator_id, contact_id, channel_account_id) values ($1, $2, $3, $4)`,
        [id, OPERATOR, CONTACT, LINE],
      );
    await thread('00000000-0000-7000-8908-0000000000a1');
    await expect(thread('00000000-0000-7000-8908-0000000000a2')).rejects.toThrow(/conversation_thread_unique/);
    await client.query(
      `update inbox.conversation set archived_at = now(), archived_by_account_id = $2 where id = $1`,
      ['00000000-0000-7000-8908-0000000000a1', PERSON],
    );
    await thread('00000000-0000-7000-8908-0000000000a2');
    const { rows } = await client.query<{ live: number }>(
      `select count(*) filter (where archived_at is null)::int as live from inbox.conversation where contact_id = $1`,
      [CONTACT],
    );
    expect(rows[0]!.live).toBe(1);
  });

  it('names who cleared a thread, both or neither, with the foreign key and its index', async () => {
    await expect(
      client.query(`update inbox.conversation set archived_at = now() where id = $1`, ['00000000-0000-7000-8908-0000000000a2']),
    ).rejects.toThrow(/conversation_archived_check/);
    const { rows } = await client.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `select column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'inbox' and table_name = 'conversation' and column_name in ('archived_at', 'archived_by_account_id')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'archived_at', is_nullable: 'YES', column_default: null },
      { column_name: 'archived_by_account_id', is_nullable: 'YES', column_default: null },
    ]);
    const fk = await client.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'inbox' and t.relname = 'conversation' and c.conname = 'conversation_archived_by_account_id_account_id_fk'`,
    );
    expect(fk.rows[0]?.def).toMatch(/FOREIGN KEY \(archived_by_account_id\) REFERENCES core\.account\(id\) ON DELETE RESTRICT/);
    const index = await client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'inbox' and indexname = 'conversation_archived_by_idx'`,
    );
    expect(index.rows[0]?.indexdef).toMatch(/\(archived_by_account_id\)/);
  });
});
