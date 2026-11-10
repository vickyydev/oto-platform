import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-824, a customer's voice note transcribed — one migration,
 * expand-only: four new columns on `inbox.message` (`transcript_status`,
 * `transcript_language`, `transcript_attempts` with a constant default, and
 * `transcript_next_attempt_at`), the transcription job's partial index and
 * three checks. Nothing is dropped, renamed or tightened; the words go in
 * `transcript`, which exists since the inbox began.
 *
 * The entry is found by its tag suffix, never by number, so a lane that lands
 * another migration first and renumbers this one does not break the test
 * (built as 0113 while three lanes were in flight, landed first as 0110; its
 * journal `idx` follows its predecessor's, as every entry's does). The writes are
 * exercised in `apps/api/test/inbox-voice-notes.test.ts`.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_inbox_voice_transcript$/.test(e.tag));
const entry = journal.entries[at];

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-824-voice-transcript-migration' });
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

describe('SCRUM-824 voice transcript migration', () => {
  it('is journalled after its predecessor, on its snapshot, and only adds', () => {
    expect(entry, 'a journalled *_inbox_voice_transcript migration').toBeDefined();
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

    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');
    expect(sqlText).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/);
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(new Set(['inbox.message']));
  });

  it('adds the four columns: three nullable, the attempts not null with a constant default', async () => {
    const { rows } = await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'inbox' and table_name = 'message' and column_name like 'transcript%'
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'transcript', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'transcript_attempts', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
      { column_name: 'transcript_language', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'transcript_next_attempt_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'transcript_status', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('holds the status to its five words and the language to a code; the sweep reads pending rows only', async () => {
    const { rows } = await client.query<{ name: string; def: string }>(
      `select c.conname as name, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'inbox' and t.relname = 'message' and c.conname like 'message_transcript%'
        order by c.conname`,
    );
    expect(rows.map((r) => r.name)).toEqual([
      'message_transcript_attempts_check',
      'message_transcript_language_check',
      'message_transcript_status_check',
    ]);
    for (const word of ['pending', 'done', 'failed', 'too_long', 'off']) expect(rows[2]!.def).toContain(`'${word}'`);
    expect(rows[1]!.def).toContain('^[a-z]{2,3}$');
    const index = await client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'inbox' and indexname = 'message_transcript_queue_idx'`,
    );
    expect(index.rows[0]?.indexdef).toMatch(/\(transcript_next_attempt_at\) WHERE \(transcript_status = 'pending'::text\)/);
  });
});
