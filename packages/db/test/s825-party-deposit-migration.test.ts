import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INBOX_EVENT_KINDS, INBOX_TEMPLATE_KEYS } from '../src/schema/inbox';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-825, a party's deposit asked from the BEO — one migration,
 * expand-only: the table `pos.party_deposit_request` (one row per "Request
 * deposit" press, one open request per party), and three CHECK swaps that
 * only WIDEN a list: the inbox event kinds by the eight party pills, the
 * template key CHECK and the out-of-hours key CHECK by the five party lines.
 * No row is written here; platform-sync lays the lines (`inbox-i1.test.ts`).
 *
 * The entry is found by its tag suffix, never by number: built as 0115 while
 * other lanes were in flight, it is renumbered at landing if one lands first.
 * Drizzle's migrator applies a migration only when its journal time is later
 * than the last one applied, so its time must be later than the entry just
 * before it, whichever that is, and its snapshot must chain onto that entry's.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_party_deposit_request$/.test(e.tag));
const entry = journal.entries[at];
const NEW_TEMPLATE_KEYS = ['party_deposit_request', 'party_deposit_reminder', 'party_deposit_received', 'party_menu_link', 'party_menu_received'];
const NEW_EVENT_KINDS = [
  'deposit_requested',
  'deposit_reminded',
  'deposit_paid',
  'deposit_expired',
  'deposit_cancelled',
  'deposit_overdue',
  'menu_link_sent',
  'menu_received',
];

type Snapshot = { id: string; prevId: string; tables: Record<string, { checkConstraints?: Record<string, { value: string }> }> };
const snapshotOf = (tag: string) =>
  JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as Snapshot;
const keysIn = (check: string) => [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-825-party-deposit-migration' });
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

describe('SCRUM-825 party deposit migration', () => {
  it('is journalled after its predecessor, later than it, on its snapshot', () => {
    expect(entry, 'a journalled *_party_deposit_request migration').toBeDefined();
    const before = journal.entries[at - 1]!;
    expect(entry!.idx).toBe(before.idx + 1);
    expect(entry!.when, `after ${before.tag}`).toBeGreaterThan(before.when);
    expect(journal.entries.findIndex((e) => e.tag === '0114_inbox_advice_opener')).toBeLessThan(at);
    expect(snapshotOf(entry!.tag).prevId).toBe(snapshotOf(before.tag).id);
  });

  it('creates one table and only widens the three CHECKs; nothing is dropped, renamed, tightened or written', () => {
    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');
    const statements = sqlText.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    const created = statements.flatMap((s) => [...s.matchAll(/CREATE TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`));
    expect(created).toEqual(['pos.party_deposit_request']);
    const dropped = statements.flatMap((s) => [...s.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]));
    expect(new Set(dropped)).toEqual(new Set(['template_key_check', 'channel_account_out_of_hours_key_check', 'event_kind_check']));
    const swappedBack = statements.flatMap((s) =>
      [...s.matchAll(/ADD CONSTRAINT "([a-z_]+)" CHECK/g)].map((m) => m[1]).filter((name) => dropped.includes(name)),
    );
    expect(new Set(swappedBack)).toEqual(new Set(dropped));
    // The new table's FKs say "ON DELETE restrict ON UPDATE no action": not a DML statement.
    const ddl = sqlText.replace(/ON (?:DELETE|UPDATE) [a-z ]+?(?= ON | REFERENCES|;|$)/gim, '');
    expect(ddl).not.toMatch(/\bRENAME\b|ALTER COLUMN|DROP COLUMN|DROP TABLE|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    // The alters touch only the new table (its FKs) and the three inbox CHECKs.
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(new Set(['pos.party_deposit_request', 'inbox.template', 'inbox.channel_account', 'inbox.event']));

    // Against the snapshot before it: each old list, and exactly the new words more.
    const before = snapshotOf(journal.entries[at - 1]!.tag).tables;
    const after = snapshotOf(entry!.tag).tables;
    for (const [table, check] of [
      ['inbox.template', 'template_key_check'],
      ['inbox.channel_account', 'channel_account_out_of_hours_key_check'],
    ] as const) {
      const was = keysIn(before[table]!.checkConstraints![check]!.value);
      const now = keysIn(after[table]!.checkConstraints![check]!.value);
      expect(now, check).toEqual([...was, ...NEW_TEMPLATE_KEYS]);
      expect(now, check).toEqual([...INBOX_TEMPLATE_KEYS]);
    }
    const kindsWere = keysIn(before['inbox.event']!.checkConstraints!.event_kind_check!.value);
    const kindsNow = keysIn(after['inbox.event']!.checkConstraints!.event_kind_check!.value);
    expect(kindsNow).toEqual([...kindsWere, ...NEW_EVENT_KINDS]);
    expect(kindsNow).toEqual([...INBOX_EVENT_KINDS]);
    expect(before['pos.party_deposit_request']).toBeUndefined();
    expect(after['pos.party_deposit_request']).toBeDefined();
  });

  it('the table holds the request as designed: its states, a positive amount, one open request per party, a paid or closed row dated', async () => {
    const { rows: columns } = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'pos' and table_name = 'party_deposit_request' order by ordinal_position`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).toEqual([
      'id', 'operator_id', 'branch_id', 'otoapp_event_id', 'conversation_id', 'amount_satang', 'currency', 'state',
      'payment_attempt_id', 'invoice_no', 'payment_link', 'link_expires_at', 'requested_at', 'reminded_at', 'handed_over_at',
      'paid_at', 'closed_at', 'close_reason', 'request_message_id', 'reminder_message_id', 'paid_message_id',
      'deposit_before_satang', 'deposit_after_satang', 'write_back_edit_id', 'account_id', 'actor_app_user_id',
      'idempotency_key', 'created_at', 'updated_at',
    ]);
    const notNull = columns.filter((c) => c.is_nullable === 'NO').map((c) => c.column_name);
    expect(notNull).toEqual([
      'id', 'operator_id', 'branch_id', 'otoapp_event_id', 'conversation_id', 'amount_satang', 'currency', 'state',
      'payment_attempt_id', 'invoice_no', 'requested_at', 'idempotency_key', 'created_at', 'updated_at',
    ]);
    for (const stamp of ['link_expires_at', 'requested_at', 'reminded_at', 'handed_over_at', 'paid_at', 'closed_at', 'created_at', 'updated_at']) {
      expect(columns.find((c) => c.column_name === stamp)!.data_type, stamp).toBe('timestamp with time zone');
    }
    expect(columns.find((c) => c.column_name === 'amount_satang')!.data_type).toBe('bigint');

    const { rows: checks } = await client.query<{ name: string; def: string }>(
      `select c.conname as name, pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'pos' and t.relname = 'party_deposit_request' and c.contype = 'c' order by c.conname`,
    );
    expect(checks.map((c) => c.name)).toEqual([
      'party_deposit_request_amount_check',
      'party_deposit_request_closed_check',
      'party_deposit_request_currency_check',
      'party_deposit_request_paid_check',
      'party_deposit_request_state_check',
    ]);
    for (const word of ['requested', 'paid', 'expired', 'cancelled']) expect(checks[4]!.def).toContain(`'${word}'`);
    expect(checks[0]!.def).toContain('> 0');

    const { rows: fks } = await client.query<{ name: string; def: string }>(
      `select c.conname as name, pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'pos' and t.relname = 'party_deposit_request' and c.contype = 'f' order by c.conname`,
    );
    // The app's event and the inbox's conversation are soft links (C10; the inbox owns its rows): no FK on either.
    expect(fks.map((f) => f.name)).toEqual([
      'party_deposit_request_account_id_account_id_fk',
      'party_deposit_request_branch_id_branch_id_fk',
      'party_deposit_request_operator_id_operator_id_fk',
      'party_deposit_request_payment_attempt_id_payment_attempt_id_fk',
      'party_deposit_request_write_back_edit_id_party_edit_id_fk',
    ]);
    for (const f of fks) expect(f.def, f.name).toContain('ON DELETE RESTRICT');

    const { rows: indexes } = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'pos' and tablename = 'party_deposit_request' order by indexname`,
    );
    const def = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
    expect([...def.keys()]).toEqual([
      'party_deposit_request_account_idx',
      'party_deposit_request_attempt_unique',
      'party_deposit_request_branch_idx',
      'party_deposit_request_conversation_idx',
      'party_deposit_request_event_idx',
      'party_deposit_request_open_idx',
      'party_deposit_request_open_unique',
      'party_deposit_request_operator_idx',
      'party_deposit_request_pkey',
      'party_deposit_request_write_back_idx',
    ]);
    expect(def.get('party_deposit_request_attempt_unique')).toMatch(/UNIQUE INDEX/);
    expect(def.get('party_deposit_request_open_unique')).toMatch(/UNIQUE INDEX .* \(otoapp_event_id\) WHERE \(state = 'requested'::text\)/);
    expect(def.get('party_deposit_request_open_idx')).toMatch(/\(requested_at\) WHERE \(state = 'requested'::text\)/);
  });

  it('the database takes the party keys on a template and as an out-of-hours key, and the eight party kinds on an event', async () => {
    const { rows } = await client.query<{ name: string; def: string }>(
      `select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('template_key_check', 'channel_account_out_of_hours_key_check', 'event_kind_check') order by conname`,
    );
    expect(rows.map((r) => r.name)).toEqual(['channel_account_out_of_hours_key_check', 'event_kind_check', 'template_key_check']);
    for (const r of rows.filter((x) => x.name !== 'event_kind_check')) for (const key of NEW_TEMPLATE_KEYS) expect(r.def, r.name).toContain(`'${key}'`);
    for (const kind of NEW_EVENT_KINDS) expect(rows[1]!.def).toContain(`'${kind}'`);
  });
});
