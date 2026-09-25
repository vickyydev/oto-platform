import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-411 (booth audit L11) — the redemption ledger cannot be emptied
 * (migration 0023), asserted against a live database built from the committed
 * migrations.
 *
 * 0021 made `promo.voucher_redemption` append-only row by row, and its test
 * said "cannot be edited or pruned, by anybody". The audit's probe then took
 * the ledger from seven rows to none with one TRUNCATE, because a row trigger
 * never sees one. What the database itself has to hold now:
 *   - TRUNCATE on the ledger is refused, and the rows are still there;
 *   - TRUNCATE ... CASCADE from `promo.voucher` is refused with it, so the
 *     vouchers cannot be emptied around the ledger either;
 *   - the trigger is a statement-level one on TRUNCATE, beside 0021's row
 *     triggers, which still refuse an UPDATE and a DELETE;
 *   - the migration applied twice leaves the same database.
 *
 * What a trigger cannot hold is the table's owner dropping or disabling it.
 * That half of the rule is running the api as a role that does not own the
 * table, which is a deployment setting and not something this file can prove.
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
  voucherId: string;
}

/** A tenant with one till, one voucher and one ledger row on it. */
async function ledgerWithOneRow(): Promise<Fixture> {
  const operatorId = await one(
    `insert into core.operator (id, name) values (gen_random_uuid(), 'Ledger Op') returning id`,
  );
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Ledger Park', 'lp-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const stationId = await one(
    `insert into core.station (id, operator_id, branch_id, name, kind)
     values (gen_random_uuid(), $1, $2, 'Till', 'till') returning id`,
    [operatorId, branchId],
  );
  const definitionId = await one(
    `insert into promo.voucher_definition (id, operator_id, code, name_en, kind, value_type, value_satang)
     values (gen_random_uuid(), $1, 'd-' || md5(random()::text), '150 THB Voucher', 'discount', 'amount', 15000)
     returning id`,
    [operatorId],
  );
  const voucherId = await one(
    `insert into promo.voucher (id, operator_id, branch_id, voucher_definition_id, code, source, status, expires_at)
     values (gen_random_uuid(), $1, $2, $3, upper(substr(md5(random()::text), 1, 10)), 'booth', 'issued', now() + interval '14 days')
     returning id`,
    [operatorId, branchId, definitionId],
  );
  await client.query(
    `insert into promo.voucher_redemption (id, operator_id, voucher_id, kind, sale_id, branch_id, station_id)
     values (gen_random_uuid(), $1, $2, 'held', gen_random_uuid(), $3, $4)`,
    [operatorId, voucherId, branchId, stationId],
  );
  return { operatorId, branchId, stationId, voucherId };
}

const ledgerRows = (voucherId: string) =>
  one<number>(`select count(*)::int from promo.voucher_redemption where voucher_id = $1`, [
    voucherId,
  ]);

describe('promo.voucher_redemption cannot be emptied', () => {
  it('refuses TRUNCATE, and the rows are still there', async () => {
    const f = await ledgerWithOneRow();
    await expect(client.query(`truncate promo.voucher_redemption`)).rejects.toThrow(
      /append-only: TRUNCATE refused/,
    );
    expect(await ledgerRows(f.voucherId)).toBe(1);
  });

  it('refuses TRUNCATE ... CASCADE from the voucher table with it, so the vouchers stay too', async () => {
    const f = await ledgerWithOneRow();
    // CASCADE reaches every table with a key into promo.voucher, the ledger
    // among them, and one refusal rolls the whole statement back.
    await expect(client.query(`truncate promo.voucher cascade`)).rejects.toThrow(
      /append-only: TRUNCATE refused/,
    );
    expect(await ledgerRows(f.voucherId)).toBe(1);
    expect(
      await one<number>(`select count(*)::int from promo.voucher where id = $1`, [f.voucherId]),
    ).toBe(1);
  });

  it('is a statement-level trigger on TRUNCATE, beside the row triggers of 0021, which still hold', async () => {
    const definition = await one(
      `select pg_get_triggerdef(t.oid) from pg_trigger t
        join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'promo' and c.relname = 'voucher_redemption'
         and t.tgname = 'voucher_redemption_no_truncate'`,
    );
    expect(definition).toContain('BEFORE TRUNCATE');
    expect(definition).toContain('FOR EACH STATEMENT');
    expect(definition).toContain('promo.voucher_redemption_append_only()');

    const f = await ledgerWithOneRow();
    const rowId = await one(`select id from promo.voucher_redemption where voucher_id = $1`, [
      f.voucherId,
    ]);
    await expect(
      client.query(`update promo.voucher_redemption set kind = 'consumed' where id = $1`, [rowId]),
    ).rejects.toThrow(/append-only: UPDATE refused/);
    await expect(
      client.query(`delete from promo.voucher_redemption where id = $1`, [rowId]),
    ).rejects.toThrow(/append-only: DELETE refused/);
    expect(await ledgerRows(f.voucherId)).toBe(1);
  });
});

/**
 * Every column, constraint, index and trigger in the schema this migration
 * touches, as the catalogue describes it — the thing that must not move when
 * the migration runs again. Triggers are read from `pg_trigger` rather than
 * `information_schema.triggers`, which does not list TRUNCATE triggers at all.
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
     select 'trg ' || c.relname || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid)
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'promo' and not t.tgisinternal
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
      before.some((l) => l.startsWith('trg voucher_redemption.voucher_redemption_no_truncate ')),
    ).toBe(true);
    expect(
      before.some((l) => l.startsWith('trg voucher_redemption.voucher_redemption_append_only ')),
    ).toBe(true);
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
