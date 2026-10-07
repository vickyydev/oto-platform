import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-20 E5 (SCRUM-217) — the booked event pass migration (found by its tag,
 * whatever number it lands under), against a live database built from the
 * committed migrations (consistency #21; the E5 row of the events-kiosk plan):
 *
 *   - `pos.event_attendee_link` takes a pass bought online: `billing =
 *     'booking'`, naming the booking that paid (`booking_id`, indexed);
 *   - the sale check is split: a till's `sale` pass always names its sale, a
 *     party walk-up and a free event never do, and a booked pass names none
 *     until its booking is redeemed, then the redemption sale.
 *
 * The writes are exercised end to end in `apps/api/test/events-e5.test.ts`.
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

async function code(text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await client.query(text, values);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('the booked event pass migration', () => {
  it('follows its predecessor in the journal, later than it, on its snapshot', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const mine = journal.entries.find((e) => e.tag.endsWith('_event_booking_pass'));
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

  it('adds the booking column, nullable, its foreign key indexed', async () => {
    expect(
      await one(
        `select is_nullable from information_schema.columns where table_schema = 'pos' and table_name = 'event_attendee_link' and column_name = 'booking_id'`,
      ),
    ).toBe('YES');
    const unindexed = (
      await client.query(
        `select a.attname as fk
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           join pg_namespace n on n.oid = t.relnamespace
           join unnest(c.conkey) as k(attnum) on true
           join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
          where c.contype = 'f' and n.nspname = 'pos' and t.relname = 'event_attendee_link'
            and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
      )
    ).rows;
    expect(unindexed).toEqual([]);
  });

  it('holds a booked pass to what the registration and the redemption promise', async () => {
    const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'E5 Op') returning id`);
    const branchId = await one(
      `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'E5 Park', 'e5-' || substr(md5(random()::text), 1, 8)) returning id`,
      [operatorId],
    );
    const bookingId = await one(
      `insert into pos.booking (id, operator_id, branch_id, reference, booking_date, status)
       values (gen_random_uuid(), $1, $2, 'OTO-E5E5-0001', '2026-11-02', 'paid') returning id`,
      [operatorId, branchId],
    );
    const link = (fields: Record<string, unknown>) => {
      const base: Record<string, unknown> = {
        operator_id: operatorId,
        branch_id: branchId,
        otoapp_event_id: '0190a0a0-0000-7000-8000-00000000e501',
        event_type: 'camp',
        source: 'booking',
      };
      const all = { ...base, ...fields };
      const keys = Object.keys(all);
      return code(
        `insert into pos.event_attendee_link (id, ${keys.join(', ')}) values (gen_random_uuid(), ${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };
    // A pass the booking paid for, registered at payment: no sale yet.
    expect(await link({ billing: 'booking', booking_id: bookingId, price_snapshot_satang: 60_000 })).toBeNull();
    // A booked pass names its booking.
    expect(await link({ billing: 'booking' })).toBe('23514');
    // A free pass from a booking names the booking too, and no sale ever.
    expect(await link({ billing: 'free', booking_id: bookingId, event_type: 'event' })).toBeNull();
    // The till's rules stand: a paid pass names its sale; a walk-up and a free child never do.
    expect(await link({ billing: 'sale', source: 'till' })).toBe('23514');
    // A sale a walk-up may not name (any uuid: the check refuses before the foreign key is asked).
    const saleLike = '0190a0a0-0000-7000-8000-00000000e5ff';
    expect(await link({ billing: 'party_tab', source: 'till', event_type: 'party', sale_id: saleLike })).toBe('23514');
    expect(await link({ billing: 'free', source: 'till', event_type: 'event', sale_id: saleLike })).toBe('23514');
    // Words the table does not know.
    expect(await link({ billing: 'online', booking_id: bookingId })).toBe('23514');
    // Expand-only: every link that was valid stays valid (the counts above wrote two).
    expect(
      await one(`select count(*)::int from pos.event_attendee_link where operator_id = $1`, [operatorId]),
    ).toBe(2);
  });
});
