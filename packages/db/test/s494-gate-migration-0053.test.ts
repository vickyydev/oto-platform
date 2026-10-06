import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-494 register item 4 — each band's Gate access (migration 0053),
 * against a live database built from the committed migrations.
 *
 *   - `pos.band.gate_access`, not null, default false;
 *   - a kids band can never carry it (`band_gate_access_kind_check`);
 *   - the bands already issued take their line's ticket package setting; an
 *     adult band whose line names no package stays false;
 *   - 0053 is in the journal after 0052 and later than it.
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

interface World {
  operatorId: string;
  branchId: string;
  saleId: string;
  onPkg: string;
  offPkg: string;
}

async function world(): Promise<World> {
  const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'Gate Op') returning id`);
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Gate Park', 'gp-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const stationId = await one(
    `insert into core.station (id, operator_id, branch_id, name, kind)
     values (gen_random_uuid(), $1, $2, 'Till', 'till') returning id`,
    [operatorId, branchId],
  );
  const accountId = await one(
    `insert into core.account (id, operator_id, phone, status)
     values (gen_random_uuid(), $1, '+6682' || lpad(floor(random() * 10000000)::text, 7, '0'), 'active') returning id`,
    [operatorId],
  );
  const pkg = (name: string, gate: boolean) =>
    one(
      `insert into pos.ticket_package (id, operator_id, branch_id, name, duration_label, hours, prices, gate_access)
       values (gen_random_uuid(), $1, $2, $3, '2 Hours', 2, '{}', $4) returning id`,
      [operatorId, branchId, name, gate],
    );
  const onPkg = await pkg('On', true);
  const offPkg = await pkg('Off', false);
  const saleId = await one(
    `insert into pos.sale (id, operator_id, branch_id, station_id, business_date, business_day_start,
                           timezone, occurred_at, created_by_account_id, pricing_mode,
                           pricing_mode_reason, customer_tier, engine_version, tax_config, tax_breakdown)
     values (gen_random_uuid(), $1, $2, $3, '2026-10-02', '05:00', 'Asia/Bangkok', now(), $4,
             'weekday', 'test', 'tourist', 'test', '{}', '{}')
     returning id`,
    [operatorId, branchId, stationId, accountId],
  );
  return { operatorId, branchId, saleId, onPkg, offPkg };
}

async function line(w: World, lineNo: number, kind: string, pkg: string): Promise<string> {
  return one(
    `insert into pos.sale_line (id, sale_id, operator_id, branch_id, business_date, line_no, cart_line_id,
                                kind, ticket_package_id, label, taxable_category, customer_tier)
     values (gen_random_uuid(), $1, $2, $3, '2026-10-02', $4, gen_random_uuid(), $5, $6, 'Ticket', 'admission', 'tourist')
     returning id`,
    [w.saleId, w.operatorId, w.branchId, lineNo, kind, pkg],
  );
}

async function bandRow(w: World, kind: 'kid' | 'adult', saleLineId: string | null): Promise<string> {
  return one(
    `insert into pos.band (id, operator_id, branch_id, sale_id, sale_line_id, kind, code)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'T1' || md5(random()::text)) returning id`,
    [w.operatorId, w.branchId, w.saleId, saleLineId, kind],
  );
}

const gateOf = (id: string) => one<boolean>(`select gate_access from pos.band where id = $1`, [id]);

describe('migration 0053 — each band’s Gate access', () => {
  it('is in the journal after 0052 and later than it', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e52 = journal.entries.find((e) => e.tag === '0052_end_of_day')!;
    const e53 = journal.entries.find((e) => e.tag === '0053_band_gate_access')!;
    expect(e53.idx).toBe(53);
    expect(e53.when).toBeGreaterThan(e52.when);
    expect(journal.entries.indexOf(e53)).toBeGreaterThan(journal.entries.indexOf(e52));
  });

  it('defaults a new band to no Gate access, and refuses it on a kids band', async () => {
    const w = await world();
    const kids = await line(w, 1, 'kids', w.onPkg);
    const kid = await bandRow(w, 'kid', kids);
    expect(await gateOf(kid)).toBe(false);
    await expect(client.query(`update pos.band set gate_access = true where id = $1`, [kid])).rejects.toThrow(
      /band_gate_access_kind_check/,
    );
  });

  it('gives the bands already issued their line ticket setting', async () => {
    const w = await world();
    const kids = await line(w, 1, 'kids', w.onPkg);
    const onAdults = await line(w, 2, 'adults_paid', w.onPkg);
    const offAdults = await line(w, 3, 'adults_paid', w.offPkg);
    const kid = await bandRow(w, 'kid', kids);
    const onAdult = await bandRow(w, 'adult', onAdults);
    const offAdult = await bandRow(w, 'adult', offAdults);
    const lineless = await bandRow(w, 'adult', null);

    // The database as it stood before 0053, then 0053 itself, statement by statement.
    await client.query(`alter table pos.band drop constraint band_gate_access_kind_check`);
    await client.query(`alter table pos.band drop column gate_access`);
    const sql = readFileSync(join(MIGRATIONS, '0053_band_gate_access.sql'), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.query(statement);
    }

    expect(await gateOf(onAdult)).toBe(true);
    expect(await gateOf(offAdult)).toBe(false);
    expect(await gateOf(kid)).toBe(false);
    expect(await gateOf(lineless)).toBe(false);
  });
});
