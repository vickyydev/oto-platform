import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-20 E3 (SCRUM-217) — the event check-in migration (found by its tag,
 * whatever number it lands under), against a live database built from the
 * committed migrations (events-kiosk plan §8 "This ticket": `pos.event_checkin`
 * and the band change; the E3 row of §9):
 *
 *   - `pos.event_checkin` keeps one child's day at an event, keyed by the
 *     check-in id the till or the box minted; ONE CHECK-IN PER CHILD PER DAY is
 *     its unique key (H4); its CHECKs say a check-out is never before its
 *     check-in and a check-in is synced only once the OTO App answered;
 *   - `pos.band` takes event bands: `sale_id` nullable, `event_checkin_id`
 *     added, and exactly one of the two on every band (`band_owner_check`);
 *   - every foreign key on the new table and the new column leads an index.
 *
 * The writes are exercised end to end in `apps/api/test/events-e3.test.ts`.
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

describe('the event check-in migration — check-in, check-out and the event band', () => {
  it('follows its predecessor in the journal, later than it, on its snapshot', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const mine = journal.entries.find((e) => e.tag.endsWith('_event_checkin'));
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

  it('adds the table and the band column, every foreign key indexed, and relaxes the band sale', async () => {
    const nullable = await one(
      `select is_nullable from information_schema.columns where table_schema = 'pos' and table_name = 'band' and column_name = 'sale_id'`,
    );
    expect(nullable).toBe('YES');
    expect(
      await one(
        `select count(*)::int from information_schema.columns where table_schema = 'pos' and table_name = 'band' and column_name = 'event_checkin_id'`,
      ),
    ).toBe(1);
    const unindexed = (
      await client.query(
        `select t.relname || '.' || a.attname as fk
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           join pg_namespace n on n.oid = t.relnamespace
           join unnest(c.conkey) as k(attnum) on true
           join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
          where c.contype = 'f' and n.nspname = 'pos'
            and (t.relname = 'event_checkin' or (t.relname = 'band' and a.attname = 'event_checkin_id'))
            and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
      )
    ).rows;
    expect(unindexed).toEqual([]);
  });

  it('holds a check-in and an event band to what the write promises', async () => {
    const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'E3 Op') returning id`);
    const branchId = await one(
      `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'E3 Park', 'e3-' || substr(md5(random()::text), 1, 8)) returning id`,
      [operatorId],
    );
    const eventId = '0190a0a0-0000-7000-8000-00000000e301';
    const attendee = '0190a0a0-0000-7000-8000-00000000e302';
    const checkin = (fields: Record<string, unknown>) => {
      const base: Record<string, unknown> = {
        operator_id: operatorId,
        branch_id: branchId,
        otoapp_event_id: eventId,
        attendee_id: attendee,
        event_type: 'camp',
        attendance_date: '2026-11-02',
        child_name: 'Lin',
        event_title: 'Ocean camp',
        checked_in_at: '2026-11-02T03:00:00Z',
      };
      const all = { ...base, ...fields };
      const keys = Object.keys(all);
      return code(
        `insert into pos.event_checkin (id, ${keys.join(', ')}) values (gen_random_uuid(), ${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };
    expect(await checkin({})).toBeNull();
    // ONE CHECK-IN PER CHILD PER DAY.
    expect(await checkin({})).toBe('23505');
    // The next day is a check-in of its own.
    expect(await checkin({ attendance_date: '2026-11-03' })).toBeNull();
    // A check-out never before its check-in.
    expect(await checkin({ attendance_date: '2026-11-04', checked_out_at: '2026-11-04T01:00:00Z', checked_in_at: '2026-11-04T03:00:00Z' })).toBe('23514');
    // Words the table does not know.
    expect(await checkin({ attendance_date: '2026-11-05', origin: 'fax' })).toBe('23514');
    expect(await checkin({ attendance_date: '2026-11-05', sync_state: 'maybe' })).toBe('23514');
    // Synced means the app answered.
    expect(await checkin({ attendance_date: '2026-11-05', sync_state: 'synced' })).toBe('23514');
    expect(await checkin({ attendance_date: '2026-11-05', sync_state: 'synced', synced_at: new Date() })).toBeNull();
    // A new check-in is owed to the app until it answers.
    expect(
      await one(`select sync_state from pos.event_checkin where operator_id = $1 and attendance_date = '2026-11-02'`, [operatorId]),
    ).toBe('pending');

    const checkinId = await one(`select id from pos.event_checkin where operator_id = $1 and attendance_date = '2026-11-02'`, [operatorId]);
    const bandOf = (fields: Record<string, unknown>) => {
      const all: Record<string, unknown> = {
        operator_id: operatorId,
        branch_id: branchId,
        kind: 'kid',
        code: `E3${Math.random().toString(36).slice(2)}`,
        ...fields,
      };
      const keys = Object.keys(all);
      return code(
        `insert into pos.band (id, ${keys.join(', ')}) values (gen_random_uuid(), ${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };
    // An event band names its check-in and no sale.
    expect(await bandOf({ event_checkin_id: checkinId })).toBeNull();
    expect(await bandOf({ event_checkin_id: checkinId, kind: 'adult', gate_access: true })).toBeNull();
    // A band with neither owner, or with both, is refused.
    expect(await bandOf({})).toBe('23514');
    // The kid band still never opens the gate.
    expect(await bandOf({ event_checkin_id: checkinId, gate_access: true })).toBe('23514');
  });
});
