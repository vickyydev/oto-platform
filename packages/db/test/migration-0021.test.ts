import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { VOUCHER_REDEMPTION_KINDS, VOUCHER_RELEASE_REASONS } from '../src/schema/promo';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-10b (SCRUM-207) — voucher redemption (migration 0021), asserted against a
 * live database built from the committed migrations.
 *
 * What the database itself has to hold, whatever the api does:
 *   - a hold is all of its parts or none, and only on an unused voucher;
 *   - one voucher per sale, as a constraint;
 *   - the redemption ledger cannot be edited or pruned;
 *   - a voided sale holds no voucher, whichever path voided it;
 *   - the migration applied twice leaves the same database.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

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

interface Fixture {
  operatorId: string;
  branchId: string;
  stationId: string;
  accountId: string;
  definitionId: string;
}

/** A tenant with one till, one member of staff and one voucher definition. */
async function tenancy(): Promise<Fixture> {
  const operatorId = await one(
    `insert into core.operator (id, name) values (gen_random_uuid(), 'Voucher Op') returning id`,
  );
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Voucher Park', 'vp-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const stationId = await one(
    `insert into core.station (id, operator_id, branch_id, name, kind)
     values (gen_random_uuid(), $1, $2, 'Till', 'till') returning id`,
    [operatorId, branchId],
  );
  const accountId = await one(
    `insert into core.account (id, operator_id, phone, status)
     values (gen_random_uuid(), $1, '+6690' || lpad(floor(random() * 10000000)::text, 7, '0'), 'active') returning id`,
    [operatorId],
  );
  const definitionId = await one(
    `insert into promo.voucher_definition (id, operator_id, code, name_en, kind, value_type, value_satang)
     values (gen_random_uuid(), $1, 'd-' || md5(random()::text), '150 THB Voucher', 'discount', 'amount', 15000)
     returning id`,
    [operatorId],
  );
  return { operatorId, branchId, stationId, accountId, definitionId };
}

async function issue(f: Fixture): Promise<string> {
  return one(
    `insert into promo.voucher (id, operator_id, branch_id, voucher_definition_id, code)
     values (gen_random_uuid(), $1, $2, $3, 'B1' || upper(substr(md5(random()::text), 1, 9))) returning id`,
    [f.operatorId, f.branchId, f.definitionId],
  );
}

/** A sale as `commitSale` would have left it: tendering, no receipt. */
async function tenderingSale(f: Fixture): Promise<string> {
  return one(
    `insert into pos.sale (id, operator_id, branch_id, station_id, business_date, business_day_start,
                           timezone, occurred_at, created_by_account_id, pricing_mode,
                           pricing_mode_reason, customer_tier, engine_version, tax_config, tax_breakdown)
     values (gen_random_uuid(), $1, $2, $3, '2026-09-24', '05:00', 'Asia/Bangkok', now(), $4,
             'weekday', 'test', 'tourist', 'test', '{}', '{}')
     returning id`,
    [f.operatorId, f.branchId, f.stationId, f.accountId],
  );
}

async function hold(f: Fixture, voucherId: string, saleId: string): Promise<void> {
  await client.query(
    `update promo.voucher
        set held_sale_id = $2, held_station_id = $3, held_by_account_id = $4, held_at = now()
      where id = $1`,
    [voucherId, saleId, f.stationId, f.accountId],
  );
}

describe('promo.voucher — the hold', () => {
  it('adds the hold columns and the till a voucher was redeemed at', async () => {
    const { rows } = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'promo' and table_name = 'voucher'
          and column_name in ('held_sale_id','held_station_id','held_by_account_id','held_at','redeemed_station_id')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'held_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'held_by_account_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'held_sale_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'held_station_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'redeemed_station_id', data_type: 'uuid', is_nullable: 'YES' },
    ]);
  });

  it('names the sale with no foreign key — a hold comes before the sale is written', async () => {
    const f = await tenancy();
    const voucherId = await issue(f);
    // A sale id nobody has written yet: exactly what a till holds before Pay.
    await hold(f, voucherId, '01a0d2d0-0000-7000-8000-000000000001');
    const held = await one(`select held_sale_id from promo.voucher where id = $1`, [voucherId]);
    expect(held).toBe('01a0d2d0-0000-7000-8000-000000000001');
  });

  it('PLANT — refuses half a hold', async () => {
    const f = await tenancy();
    const voucherId = await issue(f);
    await expect(
      client.query(`update promo.voucher set held_sale_id = gen_random_uuid() where id = $1`, [
        voucherId,
      ]),
    ).rejects.toThrow(/voucher_hold_check/);
  });

  it('PLANT — refuses a hold on a voucher that is already used up', async () => {
    const f = await tenancy();
    const voucherId = await issue(f);
    await client.query(
      `update promo.voucher set status = 'redeemed', redeemed_at = now() where id = $1`,
      [voucherId],
    );
    await expect(hold(f, voucherId, '01a0d2d0-0000-7000-8000-000000000002')).rejects.toThrow(
      /voucher_hold_check/,
    );
  });

  it('PLANT — refuses a second voucher on one sale', async () => {
    const f = await tenancy();
    const first = await issue(f);
    const second = await issue(f);
    const saleId = '01a0d2d0-0000-7000-8000-000000000003';
    await hold(f, first, saleId);
    await expect(hold(f, second, saleId)).rejects.toThrow(/voucher_held_sale_unique/);
  });
});

describe('promo.voucher_redemption — the ledger', () => {
  it('knows the four kinds and the five reasons, word for word', async () => {
    const def = await one(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'voucher_redemption_kind_check'`,
    );
    expect([...String(def).matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([
      ...VOUCHER_REDEMPTION_KINDS,
    ]);
    const reasons = await one(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'voucher_redemption_reason_check'`,
    );
    const words = [...String(reasons).matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(words.filter((w) => w !== 'released')).toEqual([...VOUCHER_RELEASE_REASONS]);
  });

  it('refuses a release with no reason, and a reason on anything but a release', async () => {
    const f = await tenancy();
    const voucherId = await issue(f);
    const insert = (kind: string, reason: string | null) =>
      client.query(
        `insert into promo.voucher_redemption (id, operator_id, voucher_id, kind, sale_id, branch_id, station_id, reason)
         values (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), $4, $5, $6)`,
        [f.operatorId, voucherId, kind, f.branchId, f.stationId, reason],
      );
    await expect(insert('released', null)).rejects.toThrow(/voucher_redemption_reason_check/);
    await expect(insert('held', 'moved')).rejects.toThrow(/voucher_redemption_reason_check/);
    await expect(insert('released', 'because')).rejects.toThrow(/voucher_redemption_reason_check/);
    await insert('released', 'line_removed');
    await insert('held', null);
  });

  it('PLANT — cannot be edited or pruned, by anybody', async () => {
    const f = await tenancy();
    const voucherId = await issue(f);
    const rowId = await one(
      `insert into promo.voucher_redemption (id, operator_id, voucher_id, kind, sale_id, branch_id, station_id)
       values (gen_random_uuid(), $1, $2, 'held', gen_random_uuid(), $3, $4) returning id`,
      [f.operatorId, voucherId, f.branchId, f.stationId],
    );
    await expect(
      client.query(`update promo.voucher_redemption set kind = 'consumed' where id = $1`, [rowId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query(`delete from promo.voucher_redemption where id = $1`, [rowId]),
    ).rejects.toThrow(/append-only/);
    expect(await one(`select kind from promo.voucher_redemption where id = $1`, [rowId])).toBe(
      'held',
    );
  });
});

describe('a voided sale holds no voucher', () => {
  it('releases the held voucher in the same statement, and writes why', async () => {
    const f = await tenancy();
    const voucherId = await issue(f);
    const saleId = await tenderingSale(f);
    await hold(f, voucherId, saleId);

    await client.query(
      `update pos.sale set status = 'voided', voided_at = now(), voided_by_account_id = $2, void_reason = 'guest left'
        where id = $1`,
      [saleId, f.accountId],
    );

    const { rows } = await client.query(
      `select held_sale_id, held_station_id, held_at, held_by_account_id, status from promo.voucher where id = $1`,
      [voucherId],
    );
    expect(rows[0]).toEqual({
      held_sale_id: null,
      held_station_id: null,
      held_at: null,
      held_by_account_id: null,
      status: 'issued',
    });
    const ledger = await client.query(
      `select kind, reason, sale_id, station_id, branch_id, account_id from promo.voucher_redemption
        where voucher_id = $1`,
      [voucherId],
    );
    expect(ledger.rows).toEqual([
      {
        kind: 'released',
        reason: 'sale_voided',
        sale_id: saleId,
        station_id: f.stationId,
        branch_id: f.branchId,
        account_id: f.accountId,
      },
    ]);
  });

  it('leaves a used-up voucher used up — giving it back is the refund ticket’s decision', async () => {
    const f = await tenancy();
    const voucherId = await issue(f);
    const saleId = await tenderingSale(f);
    await client.query(
      `update promo.voucher set status = 'redeemed', redeemed_at = now(), sale_id = $2 where id = $1`,
      [voucherId, saleId],
    );
    await client.query(
      `update pos.sale set status = 'voided', voided_at = now(), void_reason = 'test' where id = $1`,
      [saleId],
    );
    expect(await one(`select status from promo.voucher where id = $1`, [voucherId])).toBe(
      'redeemed',
    );
    expect(
      await one(`select count(*)::int from promo.voucher_redemption where voucher_id = $1`, [
        voucherId,
      ]),
    ).toBe(0);
  });

  it('touches nothing when a sale changes to anything but voided', async () => {
    const f = await tenancy();
    const voucherId = await issue(f);
    const saleId = await tenderingSale(f);
    await hold(f, voucherId, saleId);
    await client.query(`update pos.sale set status = 'paid' where id = $1`, [saleId]);
    expect(await one(`select held_sale_id from promo.voucher where id = $1`, [voucherId])).toBe(
      saleId,
    );
  });
});

describe('promo.redemption_throttle', () => {
  it('starts a till with no misses and no lock', async () => {
    const f = await tenancy();
    await client.query(
      `insert into promo.redemption_throttle (station_id, operator_id, branch_id) values ($1, $2, $3)`,
      [f.stationId, f.operatorId, f.branchId],
    );
    const { rows } = await client.query(
      `select recent_misses, locked_until, lock_count from promo.redemption_throttle where station_id = $1`,
      [f.stationId],
    );
    expect(rows[0]).toEqual({ recent_misses: [], locked_until: null, lock_count: 0 });
  });
});

/**
 * Every column, constraint, index and trigger this migration owns, as the
 * catalogue describes it — the thing that must not move when the migration
 * runs again.
 */
async function fingerprint(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ line: string }>(
    `select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable
              || ' ' || coalesce(column_default, '') as line
       from information_schema.columns where table_schema = 'promo'
     union all
     select 'con ' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid)
       from pg_constraint c join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'promo'
     union all
     select 'idx ' || tablename || '.' || indexname || ' ' || indexdef
       from pg_indexes where schemaname = 'promo'
     union all
     select 'trg ' || event_object_schema || '.' || event_object_table || '.' || trigger_name
              || ' ' || action_timing || ' ' || event_manipulation
       from information_schema.triggers
      where trigger_name in ('voucher_redemption_append_only', 'sale_void_releases_vouchers')
     order by 1`,
  );
  return rows.map((r) => r.line);
}

function migrate(url: string): void {
  execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

describe('the migration, run twice', () => {
  it('leaves the same database when it is applied again', async () => {
    const before = await fingerprint(client);
    expect(
      before.some((l) =>
        l.startsWith('trg promo.voucher_redemption.voucher_redemption_append_only'),
      ),
    ).toBe(true);
    expect(before.some((l) => l.startsWith('trg pos.sale.sale_void_releases_vouchers'))).toBe(true);
    migrate(db.url);
    expect(await fingerprint(client)).toEqual(before);
    expect(
      await one(
        `select count(*)::int from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`,
      ),
    ).toBe(1);
  }, 120_000);

  it('builds the same database from empty a second time', async () => {
    const second = await createTestDatabase();
    const other = new pg.Client({ connectionString: second.url });
    await other.connect();
    try {
      expect(await fingerprint(other)).toEqual(await fingerprint(client));
    } finally {
      await other.end();
      await second.drop();
    }
  }, 180_000);
});
