import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-20 E4 (SCRUM-217) — the party tab migration (found by its tag, whatever
 * number it lands under), against a live database built from the committed
 * migrations (events-kiosk plan §8 "This ticket", the E4 row of §9, Q3):
 *
 *   - `pos.party_charge` — a charge on a party's tab is a ledger entry: kind
 *     ticket or fnb, its items an array, its total never negative;
 *   - `pos.party_payment` — a payment's money is one `pos.payment_attempt`,
 *     and an attempt is at most one payment;
 *   - `pos.party_edit` — a till's edit is the fields it changed, as an object,
 *     and is only synced once the OTO App answered;
 *   - every foreign key on the three leads an index.
 *
 * The writes themselves are exercised end to end in `apps/api/test/events-e4.test.ts`.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
const TABLES = ['party_charge', 'party_payment', 'party_edit'];

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

async function one<T = string>(text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query(text, values);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

/** The SQLSTATE a statement is refused with, or null when it is accepted. */
async function code(text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await client.query(text, values);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('the party tab migration — charges, payments and edits', () => {
  it('follows its predecessor in the journal, later than it, on its snapshot', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const mine = journal.entries.find((e) => e.tag.endsWith('_party_tab'));
    expect(mine).toBeDefined();
    const at = journal.entries.indexOf(mine!);
    const before = journal.entries[at - 1]!;
    expect(mine!.idx).toBe(before.idx + 1);
    expect(mine!.when).toBeGreaterThan(before.when);
    const snapshotOf = (idx: number) =>
      JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${String(idx).padStart(4, '0')}_snapshot.json`), 'utf8')) as {
        id: string;
        prevId: string;
      };
    expect(snapshotOf(mine!.idx).prevId).toBe(snapshotOf(before.idx).id);
  });

  it('adds the three tables, every foreign key indexed', async () => {
    const cols = async (table: string) =>
      (
        await client.query(
          `select column_name from information_schema.columns where table_schema = 'pos' and table_name = $1`,
          [table],
        )
      ).rows.map((r: { column_name: string }) => r.column_name).sort();
    expect(await cols('party_charge')).toEqual(
      [
        'id', 'operator_id', 'branch_id', 'otoapp_event_id', 'kind', 'items', 'total_satang', 'account_id',
        'station_id', 'box_id', 'action_id', 'charged_at', 'created_at', 'updated_at',
      ].sort(),
    );
    expect(await cols('party_payment')).toEqual(
      [
        'id', 'operator_id', 'branch_id', 'otoapp_event_id', 'payment_attempt_id', 'party_date', 'account_id',
        'station_id', 'box_id', 'action_id', 'created_at', 'updated_at',
      ].sort(),
    );
    expect(await cols('party_edit')).toEqual(
      [
        'id', 'operator_id', 'branch_id', 'otoapp_event_id', 'fields', 'sync_state', 'sync_attempts', 'sync_error',
        'last_sync_at', 'synced_at', 'account_id', 'station_id', 'box_id', 'action_id', 'created_at', 'updated_at',
      ].sort(),
    );
    const unindexed = (
      await client.query(
        `select t.relname || '.' || a.attname as fk
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           join pg_namespace n on n.oid = t.relnamespace
           join unnest(c.conkey) as k(attnum) on true
           join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
          where c.contype = 'f' and n.nspname = 'pos' and t.relname = any($1)
            and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
        [TABLES],
      )
    ).rows;
    expect(unindexed).toEqual([]);
  });

  it('holds a charge, a payment and an edit to what the writes promise', async () => {
    const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'E4 Op') returning id`);
    const branchId = await one(
      `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'E4 Park', 'e4-' || substr(md5(random()::text), 1, 8)) returning id`,
      [operatorId],
    );
    const party = '0190a0a0-0000-7000-8000-00000000e401';
    const insert = (table: string, fields: Record<string, unknown>) => {
      const all = { operator_id: operatorId, branch_id: branchId, otoapp_event_id: party, ...fields };
      const keys = Object.keys(all);
      return code(
        `insert into pos.${table} (id, ${keys.join(', ')}) values (gen_random_uuid(), ${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };

    // A charge: ticket or fnb, an array of items, never negative.
    const chargeOf = (fields: Record<string, unknown>) =>
      insert('party_charge', { kind: 'fnb', items: '[]', total_satang: 0, charged_at: new Date(), ...fields });
    expect(await chargeOf({ total_satang: 52_000, items: JSON.stringify([{ name: 'Pad Thai', qty: 2, lineTotalSatang: 52_000 }]) })).toBeNull();
    expect(await chargeOf({ kind: 'ticket' })).toBeNull();
    expect(await chargeOf({ kind: 'bar' })).toBe('23514');
    expect(await chargeOf({ total_satang: -1 })).toBe('23514');
    expect(await chargeOf({ items: '{}' })).toBe('23514');

    // A payment: one attempt, and an attempt is one payment.
    const attempt = await one(
      `insert into pos.payment_attempt (id, operator_id, branch_id, business_date, method, amount_satang, status)
       values (gen_random_uuid(), $1, $2, current_date, 'cash', 10000, 'approved') returning id`,
      [operatorId, branchId],
    );
    expect(await insert('party_payment', { payment_attempt_id: attempt, party_date: '2026-10-07' })).toBeNull();
    expect(await insert('party_payment', { payment_attempt_id: attempt, party_date: '2026-10-07' })).toBe('23505');
    expect(await insert('party_payment', { party_date: '2026-10-07' })).toBe('23502');
    // Its attempt cannot be deleted from under it.
    expect(await code(`delete from pos.payment_attempt where id = $1`, [attempt])).toBe('23503');

    // An edit: an object of fields, pending until the app answers.
    expect(await insert('party_edit', { fields: JSON.stringify({ decoration: 'Jungle' }) })).toBeNull();
    expect(await insert('party_edit', { fields: '[]' })).toBe('23514');
    expect(await insert('party_edit', { fields: '{}', sync_state: 'maybe' })).toBe('23514');
    expect(await insert('party_edit', { fields: '{}', sync_state: 'synced' })).toBe('23514');
    expect(await insert('party_edit', { fields: '{}', sync_state: 'synced', synced_at: new Date() })).toBeNull();
    expect(
      await one(`select sync_state from pos.party_edit where operator_id = $1 and fields ? 'decoration'`, [operatorId]),
    ).toBe('pending');
  });
});
