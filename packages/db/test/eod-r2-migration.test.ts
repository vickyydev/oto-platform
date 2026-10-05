import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-15a round 2 — migration 0058 (the provisional close, stranded occupancy
 * and the End of Day receipt), against a live database built from the
 * committed migrations.
 *
 *   - 0058 is journal entry 58 after 0057;
 *   - a manual resolution names a band or a check-in, never both, with one of
 *     the three reasons; a press records once; it refuses UPDATE, and DELETE
 *     except under the demo reset's purge flag;
 *   - a closed day's override is whole or absent, and its receipt number and
 *     counter go together;
 *   - the receipt series and a print job's subject each take 'end_of_day'.
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

async function park() {
  const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'R2 Op') returning id`);
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'R2 Park', 'eodr2-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const accountId = await one(
    `insert into core.account (id, operator_id, phone, status) values (gen_random_uuid(), $1, $2, 'active') returning id`,
    [operatorId, `+66833${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`],
  );
  const stationId = await one(
    `insert into core.station (id, operator_id, branch_id, name, kind) values (gen_random_uuid(), $1, $2, 'R2 till', 'till') returning id`,
    [operatorId, branchId],
  );
  return { operatorId, branchId, accountId, stationId };
}

describe('migration 0058 — eod-r2', () => {
  it('is journal entry 58, after 0057', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e57 = journal.entries.find((e) => e.idx === 57)!;
    const e58 = journal.entries.find((e) => e.idx === 58)!;
    expect(e58.tag).toBe('0058_end_of_day_round_2');
    expect(e58.when).toBeGreaterThan(e57.when);
    expect(journal.entries.indexOf(e58)).toBe(journal.entries.indexOf(e57) + 1);
  });

  it('a resolution names one subject with one of the three reasons, records a press once, and is append-only', async () => {
    const p = await park();
    const insert = (fields: { kind: string; band?: string | null; checkin?: string | null; reason: string; actionId: string }) =>
      code(
        `insert into pos.occupancy_resolution (id, operator_id, branch_id, business_date, kind, band_id, checkin_id, reason,
           resolved_by_account_id, resolved_at, action_id)
         values (gen_random_uuid(), $1, $2, '2026-10-02', $3, $4, $5, $6, $7, now(), $8)`,
        [p.operatorId, p.branchId, fields.kind, fields.band ?? null, fields.checkin ?? null, fields.reason, p.accountId, fields.actionId],
      );
    const registrationId = await one(
      `insert into crm.registration (id, operator_id, branch_id, guardian_name, acknowledged_confirmations)
       values (gen_random_uuid(), $1, $2, 'Khun Malee', '[]'::jsonb) returning id`,
      [p.operatorId, p.branchId],
    );
    const checkinId = await one(
      `insert into pos.checkin (id, operator_id, branch_id, registration_id, child_name, child_age_years, service, status, checked_in_at)
       values (gen_random_uuid(), $1, $2, $3, 'Ploy', 6, 'drop_off', 'in_park', now()) returning id`,
      [p.operatorId, p.branchId, registrationId],
    );
    expect(await insert({ kind: 'band', reason: 'band_lost', actionId: 'a1' })).toBe('23514');
    expect(await insert({ kind: 'band', checkin: checkinId, reason: 'band_lost', actionId: 'a2' })).toBe('23514');
    expect(await insert({ kind: 'checkin', checkin: checkinId, reason: 'wandered_off', actionId: 'a3' })).toBe('23514');
    expect(await insert({ kind: 'checkin', checkin: checkinId, reason: 'left_without_scanning', actionId: 'ok-1' })).toBeNull();
    expect(await insert({ kind: 'checkin', checkin: checkinId, reason: 'left_without_scanning', actionId: 'ok-1' })).toBe('23505');

    expect(await code(`update pos.occupancy_resolution set note = 'x' where branch_id = $1`, [p.branchId])).toBe('P0001');
    expect(await code(`delete from pos.occupancy_resolution where branch_id = $1`, [p.branchId])).toBe('P0001');
    await client.query('begin');
    await client.query(`select set_config('oto.cash_ledger_purge', 'on', true)`);
    await client.query(`delete from pos.occupancy_resolution where branch_id = $1`, [p.branchId]);
    await client.query('commit');
    expect(await one<number>(`select count(*)::int from pos.occupancy_resolution where branch_id = $1`, [p.branchId])).toBe(0);
  });

  it('a closed day carries its override whole or not at all, and its receipt number with its counter', async () => {
    const p = await park();
    const close = (date: string, extra: string, values: unknown[]) =>
      code(
        `insert into pos.end_of_day (id, operator_id, branch_id, business_date, lines, float_satang, total_expected_satang,
           total_actual_satang, total_difference_satang, closed_by_account_id, closed_at${extra ? `, ${extra}` : ''})
         values (gen_random_uuid(), $1, $2, $3, '[]'::jsonb, 600000, 0, 0, 0, $4, now()${values.map((_, i) => `, $${i + 5}`).join('')})`,
        [p.operatorId, p.branchId, date, p.accountId, ...values],
      );
    expect(await close('2026-10-01', 'override_by_account_id', [p.accountId])).toBe('23514');
    expect(await close('2026-10-01', 'override_reason', ['Gate down'])).toBe('23514');
    expect(await close('2026-10-01', 'receipt_number', ['T1-EOD-000001'])).toBe('23514');
    expect(
      await close('2026-10-01', 'override_by_account_id, override_reason, override_stranded, receipt_number, receipt_station_id', [
        p.accountId,
        'Gate down',
        '[]',
        'T1-EOD-000001',
        p.stationId,
      ]),
    ).toBeNull();
    expect(await code(`update pos.end_of_day set override_reason = 'x' where branch_id = $1`, [p.branchId])).toBe('P0001');
  });

  it('the receipt series and a print job’s subject take end_of_day', async () => {
    const p = await park();
    expect(
      await code(
        `insert into pos.receipt_series (id, operator_id, branch_id, station_id, series, kind) values (gen_random_uuid(), $1, $2, $3, 'T1-EOD', 'end_of_day')`,
        [p.operatorId, p.branchId, p.stationId],
      ),
    ).toBeNull();
    expect(
      await code(
        `insert into pos.receipt_series (id, operator_id, branch_id, station_id, series, kind) values (gen_random_uuid(), $1, $2, $3, 'T1-X', 'z_report')`,
        [p.operatorId, p.branchId, p.stationId],
      ),
    ).toBe('23514');
    const constraint = await one<string>(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'print_job_subject_check'`,
    );
    expect(constraint).toContain("'end_of_day'");
  });
});
