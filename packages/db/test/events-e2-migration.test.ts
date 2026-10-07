import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-20 E2 (SCRUM-217) — the attendee link migration (found by its tag, whatever
 * number it lands under), against a live database built from the committed
 * migrations (events-kiosk plan §8 "This ticket" and the E2 row of §9):
 *
 *   - `pos.event_attendee_link` holds one row per child the POS added to an OTO
 *     App event, keyed by the till's own attendee id, and its CHECKs say what
 *     the write promises: a paid pass names its sale and nothing else does, and
 *     a link is only synced once the app answered with an attendee;
 *   - `pos.event_drop_in_pricing` holds one row of three weekday/weekend pairs
 *     per branch, never negative;
 *   - every foreign key on both leads an index, and the unused `pos.attendee`
 *     placeholder is untouched.
 *
 * The writes themselves are exercised end to end in `apps/api/test/events-e2.test.ts`.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');

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

describe('the attendee link migration — walk-ups and event passes', () => {
  it('follows its predecessor in the journal, later than it, on its snapshot', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const mine = journal.entries.find((e) => e.tag.endsWith('_event_attendee_link'));
    expect(mine).toBeDefined();
    const at = journal.entries.indexOf(mine!);
    const before = journal.entries[at - 1]!;
    expect(mine!.idx).toBe(before.idx + 1);
    expect(mine!.when).toBeGreaterThan(before.when);
    const snapshot = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${mine!.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { prevId: string };
    const previous = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${before.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
  });

  it('adds both tables, every foreign key indexed, and leaves the placeholder alone', async () => {
    const cols = async (table: string) =>
      (
        await client.query(
          `select column_name from information_schema.columns where table_schema = 'pos' and table_name = $1`,
          [table],
        )
      ).rows.map((r: { column_name: string }) => r.column_name).sort();
    expect(await cols('event_attendee_link')).toEqual(
      [
        'account_id', 'archived_at', 'attendance_days', 'billing', 'box_id', 'branch_id', 'child_id',
        'created_at', 'event_type', 'id', 'last_sync_at', 'member_id', 'merged', 'operator_id',
        'otoapp_attendee_id', 'otoapp_event_id', 'parent_attending', 'price_snapshot_satang', 'sale_id',
        'sale_line_id', 'source', 'station_id', 'sync_attempts', 'sync_error', 'sync_state', 'synced_at',
        'updated_at', 'writeback', 'action_id',
      ].sort(),
    );
    expect(await cols('event_drop_in_pricing')).toEqual(
      [
        'branch_id', 'camp_day_weekday_satang', 'camp_day_weekend_satang', 'created_at',
        'event_day_weekday_satang', 'event_day_weekend_satang', 'operator_id', 'party_guest_weekday_satang',
        'party_guest_weekend_satang', 'updated_at', 'updated_by_account_id',
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
          where c.contype = 'f' and n.nspname = 'pos'
            and t.relname in ('event_attendee_link', 'event_drop_in_pricing')
            and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
      )
    ).rows;
    expect(unindexed).toEqual([]);
    expect(await cols('attendee')).toContain('booking_id');
  });

  it('holds a link and the walk-up prices to what the write promises', async () => {
    const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'E2 Op') returning id`);
    const branchId = await one(
      `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'E2 Park', 'e2-' || substr(md5(random()::text), 1, 8)) returning id`,
      [operatorId],
    );
    const link = (fields: Record<string, unknown>) => {
      const base: Record<string, unknown> = {
        operator_id: operatorId,
        branch_id: branchId,
        otoapp_event_id: '0190a0a0-0000-7000-8000-00000000e001',
        event_type: 'party',
        billing: 'party_tab',
      };
      const all = { ...base, ...fields };
      const keys = Object.keys(all);
      return code(
        `insert into pos.event_attendee_link (id, ${keys.join(', ')}) values (gen_random_uuid(), ${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };
    // A party walk-up, a free child, a camp's days.
    expect(await link({ price_snapshot_satang: 45_000 })).toBeNull();
    expect(await link({ event_type: 'event', billing: 'free' })).toBeNull();
    expect(await link({ event_type: 'camp', billing: 'free', attendance_days: '{2026-11-02,2026-11-03}' })).toBeNull();
    // A paid pass names its sale; nothing else may.
    expect(await link({ event_type: 'event', billing: 'sale' })).toBe('23514');
    // Words the table does not know.
    expect(await link({ event_type: 'wedding' })).toBe('23514');
    expect(await link({ sync_state: 'maybe' })).toBe('23514');
    expect(await link({ source: 'fax' })).toBe('23514');
    expect(await link({ price_snapshot_satang: -1 })).toBe('23514');
    // Synced means the app answered with an attendee.
    expect(await link({ sync_state: 'synced' })).toBe('23514');
    expect(
      await link({ sync_state: 'synced', otoapp_attendee_id: '0190a0a0-0000-7000-8000-00000000e002', synced_at: new Date() }),
    ).toBeNull();
    // A new link is pending until the app has it.
    expect(
      await one(
        `select sync_state from pos.event_attendee_link where operator_id = $1 and price_snapshot_satang = 45000`,
        [operatorId],
      ),
    ).toBe('pending');

    const price = (fields: Record<string, unknown>) => {
      const keys = Object.keys(fields);
      return code(
        `insert into pos.event_drop_in_pricing (branch_id, operator_id${keys.map((k) => `, ${k}`).join('')})
         values ($1, $2${keys.map((_, i) => `, $${i + 3}`).join('')})`,
        [branchId, operatorId, ...Object.values(fields)],
      );
    };
    expect(await price({ party_guest_weekday_satang: -100 })).toBe('23514');
    expect(await price({ party_guest_weekday_satang: 45_000, party_guest_weekend_satang: 45_000 })).toBeNull();
    // One row per branch.
    expect(await price({})).toBe('23505');
  });
});
