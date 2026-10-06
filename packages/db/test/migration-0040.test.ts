import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-473 — the day's booth staff (migration 0040), against a live database
 * built from the committed migrations.
 *
 * What the database itself has to hold, whatever the api does:
 *   - the match rule's two columns on `booth.booth_settings`, whose defaults
 *     ARE the recommended rule, so a booth row written without them matches
 *     the park's real rota;
 *   - one row per person per booth per day on `booth_duty_assignment`: by the
 *     account when there is one, else by the app's casual worker id (text,
 *     because the app's ids are varchar and one that is not a uuid is still
 *     an id), else by the lower-cased name (a name typed by hand), and a
 *     different day is a different row;
 *   - the four sources and nothing else, and a name that is not blank;
 *   - 0040 is journal entry 40, after 0039 and later than it, found by index.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

async function one<T = string>(text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query(text, values);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

async function booth(): Promise<{ operatorId: string; branchId: string; stationId: string; accountId: string }> {
  const operatorId = await one(
    `insert into core.operator (id, name) values (gen_random_uuid(), 'Duty Op') returning id`,
  );
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Duty Park', 'du-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const stationId = await one(
    `insert into core.station (id, operator_id, branch_id, name, kind)
     values (gen_random_uuid(), $1, $2, 'Booth', 'booth') returning id`,
    [operatorId, branchId],
  );
  const accountId = await one(
    `insert into core.account (id, operator_id, phone, status)
     values (gen_random_uuid(), $1, '+6681' || lpad((floor(random() * 10000000))::text, 7, '0'), 'active') returning id`,
    [operatorId],
  );
  return { operatorId, branchId, stationId, accountId };
}

const insertDuty = (
  b: { operatorId: string; branchId: string; stationId: string },
  date: string,
  accountId: string | null,
  name: string,
  source = 'app_schedule',
) =>
  client.query(
    `insert into booth.booth_duty_assignment
       (id, operator_id, branch_id, station_id, business_date, account_id, display_name, source)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
    [b.operatorId, b.branchId, b.stationId, date, accountId, name, source],
  );

describe('migration 0040 — the day’s booth staff', () => {
  it('is journal entry 40, after 0039 and later than it', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e39 = journal.entries.find((e) => e.idx === 39)!;
    const e40 = journal.entries.find((e) => e.idx === 40)!;
    expect(e40.tag).toBe('0040_booth_duty');
    expect(e40.when).toBeGreaterThan(e39.when);
  });

  it('gives a booth the recommended match rule by default', async () => {
    const b = await booth();
    await client.query(
      `insert into booth.booth_settings (station_id, operator_id, branch_id) values ($1, $2, $3)`,
      [b.stationId, b.operatorId, b.branchId],
    );
    const { rows } = await client.query(
      `select duty_group_text, duty_match_text from booth.booth_settings where station_id = $1`,
      [b.stationId],
    );
    expect(rows[0]).toEqual({ duty_group_text: 'Sale Booth', duty_match_text: 'booth' });
  });

  it('holds one row per person per booth per day — by account, or by name for a casual', async () => {
    const b = await booth();
    await insertDuty(b, '2026-10-01', b.accountId, 'Tom');
    await expect(insertDuty(b, '2026-10-01', b.accountId, 'Tommy', 'manual')).rejects.toThrow(
      /booth_duty_assignment_person_unique/,
    );
    await insertDuty(b, '2026-10-02', b.accountId, 'Tom');

    await insertDuty(b, '2026-10-01', null, 'Nok');
    await expect(insertDuty(b, '2026-10-01', null, 'NOK', 'manual')).rejects.toThrow(
      /booth_duty_assignment_person_unique/,
    );
    // A casual called Tom beside the account Tom: two different people.
    await insertDuty(b, '2026-10-01', null, 'Tom');
    expect(
      await one<number>(
        `select count(*)::int from booth.booth_duty_assignment where station_id = $1`,
        [b.stationId],
      ),
    ).toBe(4);
  });

  it('keys an app casual by the app’s casual worker id: two casuals called Nok are two rows', async () => {
    const b = await booth();
    const casual = (id: string, name: string) =>
      client.query(
        `insert into booth.booth_duty_assignment
           (id, operator_id, branch_id, station_id, business_date, casual_worker_id, display_name, source)
         values (gen_random_uuid(), $1, $2, $3, '2026-10-01', $4, $5, 'app_schedule')`,
        [b.operatorId, b.branchId, b.stationId, id, name],
      );
    const c1 = '0190a000-0000-7000-8000-000000000001';
    const c2 = '0190a000-0000-7000-8000-000000000002';
    await casual(c1, 'Nok');
    await casual(c2, 'nok');
    // The same casual twice is still one row.
    await expect(casual(c1, 'Nok')).rejects.toThrow(/booth_duty_assignment_person_unique/);
    // The app's ids are varchar: one that is not a uuid is held, and is a key
    // like any other. The column is text for exactly this row.
    expect(
      await one<string>(
        `select data_type from information_schema.columns
         where table_schema = 'booth' and table_name = 'booth_duty_assignment' and column_name = 'casual_worker_id'`,
      ),
    ).toBe('text');
    const legacy = 'cw-legacy-0007';
    await casual(legacy, 'Lek');
    await expect(casual(legacy, 'LEK')).rejects.toThrow(/booth_duty_assignment_person_unique/);
    expect(
      await one<number>(`select count(*)::int from booth.booth_duty_assignment where station_id = $1`, [b.stationId]),
    ).toBe(3);
    // A row is an account or an app casual, never both.
    await expect(
      client.query(
        `insert into booth.booth_duty_assignment
           (id, operator_id, branch_id, station_id, business_date, account_id, casual_worker_id, display_name, source)
         values (gen_random_uuid(), $1, $2, $3, '2026-10-03', $4, $5, 'Tom', 'app_schedule')`,
        [b.operatorId, b.branchId, b.stationId, b.accountId, c1],
      ),
    ).rejects.toThrow(/booth_duty_assignment_casual_check/);
  });

  it('refuses a source outside the four, and a blank name', async () => {
    const b = await booth();
    await expect(insertDuty(b, '2026-10-01', null, 'Ploy', 'guess')).rejects.toThrow(
      /booth_duty_assignment_source_check/,
    );
    await expect(insertDuty(b, '2026-10-01', null, '   ')).rejects.toThrow(
      /booth_duty_assignment_display_name_check/,
    );
  });

  it('keeps one sync record per booth per day', async () => {
    const b = await booth();
    const write = (state: string) =>
      client.query(
        `insert into booth.booth_duty_sync (operator_id, branch_id, station_id, business_date, synced_at, app_state)
         values ($1, $2, $3, '2026-10-01', now(), $4)`,
        [b.operatorId, b.branchId, b.stationId, state],
      );
    await write('ok');
    await expect(write('ok')).rejects.toThrow(/booth_duty_sync_station_id_business_date_pk/);
    await expect(
      client.query(
        `insert into booth.booth_duty_sync (operator_id, branch_id, station_id, business_date, synced_at, app_state)
         values ($1, $2, $3, '2026-10-02', now(), 'maybe')`,
        [b.operatorId, b.branchId, b.stationId],
      ),
    ).rejects.toThrow(/booth_duty_sync_app_state_check/);
  });
});
