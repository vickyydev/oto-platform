import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as applyMigrations } from 'drizzle-orm/node-postgres/migrator';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-433 — a sale's voucher line names the voucher by the last four
 * characters of its code, on the sales rung up before that rule too (migration
 * 0025), asserted against a live database built from the committed migrations.
 *
 * What the migration has to do, and nothing more:
 *   - a label in the old form, "<type name> (voucher <whole code>)", becomes
 *     "<type name> (voucher …XXXX)" — on a sale that is voided or finalised as
 *     much as on one still open, though the freeze guards those rows;
 *   - the row's `code` keeps the whole code;
 *   - a label already in the new form, a park code's row, a manual row, and a
 *     label naming some other code are left as they are;
 *   - the freeze is back in force afterwards;
 *   - its statements run again change nothing, the migration applied twice
 *     leaves the same database, and a database built from empty again is the
 *     same.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
const MIGRATION_0025 = join(MIGRATIONS, '0025_voucher_line_labels.sql');

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

async function one<T = string>(c: pg.Client, text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await c.query(text, values);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

function migrate(url: string): void {
  execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/**
 * A database on the same server with every migration BEFORE 0025 applied, by
 * the migrator `drizzle-kit migrate` itself uses: the committed SQL of 0000 to
 * 0024 and a journal that stops there. Rows can then be written the way the api
 * wrote them before 2246aef, and 0025 applied on top of them.
 */
async function databaseBefore0025(): Promise<{
  url: string;
  client: pg.Client;
  drop: () => Promise<void>;
}> {
  const name = `oto_test_pre0025_${Date.now()}`;
  await client.query(`create database ${name}`);
  const url = db.url.replace(/\/[^/]*$/, `/${name}`);

  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const before = journal.entries.filter((e) => e.idx < 25);
  const folder = mkdtempSync(join(tmpdir(), 'oto-pre0025-'));
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    mkdirSync(join(folder, 'meta'));
    for (const e of before) {
      copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    }
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: before }),
    );
    await applyMigrations(drizzle(c), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return {
    url,
    client: c,
    drop: async () => {
      await c.end();
      await client.query(`drop database if exists ${name} with (force)`);
    },
  };
}

interface Tenancy {
  operatorId: string;
  branchId: string;
  stationId: string;
  accountId: string;
}

/** A tenant with one till and one member of staff. */
async function tenancy(c: pg.Client): Promise<Tenancy> {
  const operatorId = await one(
    c,
    `insert into core.operator (id, name) values (gen_random_uuid(), 'Label Op') returning id`,
  );
  const branchId = await one(
    c,
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Label Park', 'lp-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const stationId = await one(
    c,
    `insert into core.station (id, operator_id, branch_id, name, kind)
     values (gen_random_uuid(), $1, $2, 'Till', 'till') returning id`,
    [operatorId, branchId],
  );
  const accountId = await one(
    c,
    `insert into core.account (id, operator_id, phone, status)
     values (gen_random_uuid(), $1, '+6690' || lpad(floor(random() * 10000000)::text, 7, '0'), 'active') returning id`,
    [operatorId],
  );
  return { operatorId, branchId, stationId, accountId };
}

/** A sale as `commitSale` leaves it: tendering, no receipt. */
async function tenderingSale(c: pg.Client, t: Tenancy): Promise<string> {
  return one(
    c,
    `insert into pos.sale (id, operator_id, branch_id, station_id, business_date, business_day_start,
                           timezone, occurred_at, created_by_account_id, pricing_mode,
                           pricing_mode_reason, customer_tier, engine_version, tax_config, tax_breakdown)
     values (gen_random_uuid(), $1, $2, $3, '2026-09-25', '05:00', 'Asia/Bangkok', now(), $4,
             'weekday', 'test', 'tourist', 'test', '{}', '{}')
     returning id`,
    [t.operatorId, t.branchId, t.stationId, t.accountId],
  );
}

/** A discount row on a sale, as the commit writes one. Answers its id. */
async function discountRow(
  c: pg.Client,
  t: Tenancy,
  saleId: string,
  row: { sequence: number; kind: 'promo' | 'manual'; code: string | null; label: string | null },
): Promise<string> {
  return one(
    c,
    `insert into pos.sale_discount (id, sale_id, operator_id, branch_id, business_date, sequence,
                                    kind, discount_type, value_satang, amount_satang, code, label,
                                    reason, applied_by_account_id)
     values (gen_random_uuid(), $1, $2, $3, '2026-09-25', $4, $5, 'fixed', 15000, 15000, $6, $7,
             $8, $9)
     returning id`,
    [
      saleId,
      t.operatorId,
      t.branchId,
      row.sequence,
      row.kind,
      row.code,
      row.label,
      row.kind === 'manual' ? 'Service recovery' : null,
      row.kind === 'manual' ? t.accountId : null,
    ],
  );
}

async function discountOf(
  c: pg.Client,
  id: string,
): Promise<{ code: string | null; label: string | null }> {
  const { rows } = await c.query(`select code, label from pos.sale_discount where id = $1`, [id]);
  return rows[0] as { code: string | null; label: string | null };
}

/** The statements of 0025 itself, as the migrator splits them. */
function statementsOf0025(): string[] {
  return readFileSync(MIGRATION_0025, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Eleven characters, as a booth prints them; the last four are what the line keeps. */
const VOIDED_CODE = 'B1K7Q2M4W9X';
const FINALISED_CODE = 'B2P8R3T5Y6Z';
const OPEN_CODE = 'B1C4D6F8H2J';
const NAMED_CODE = 'B4V6X8Z2C3D';
const NEW_FORM_CODE = 'B3L5N7Q9S2U';

describe('0025 — the voucher lines written before the rule', () => {
  it('rewrites the old label to the last four on open, voided and finalised sales, and leaves every other row', async () => {
    const old = await databaseBefore0025();
    try {
      const t = await tenancy(old.client);

      // A sale voided after it was rung up with a voucher: its voucher is free again.
      const voided = await tenderingSale(old.client, t);
      const voidedLine = await discountRow(old.client, t, voided, {
        sequence: 1,
        kind: 'promo',
        code: VOIDED_CODE,
        label: `150 THB Voucher (voucher ${VOIDED_CODE})`,
      });
      await old.client.query(
        `update pos.sale set status = 'voided', voided_at = now(), voided_by_account_id = $2,
                             void_reason = 'Cancelled at the till'
          where id = $1`,
        [voided, t.accountId],
      );

      // A sale paid and closed with a hand-over prize on it.
      const finalised = await tenderingSale(old.client, t);
      const finalisedLine = await discountRow(old.client, t, finalised, {
        sequence: 1,
        kind: 'promo',
        code: FINALISED_CODE,
        label: `Free Bracelet Workshop (voucher ${FINALISED_CODE})`,
      });
      await old.client.query(
        `update pos.sale set status = 'finalised', receipt_series = 'T1', receipt_seq = 1,
                             receipt_number = 'T1-000001', finalised_at = now()
          where id = $1`,
        [finalised],
      );

      // A type name that says "(voucher" itself, and in Thai: only the ending
      // that names the row's own code is rewritten, counted in characters.
      const named = await tenderingSale(old.client, t);
      const namedLine = await discountRow(old.client, t, named, {
        sequence: 1,
        kind: 'promo',
        code: NAMED_CODE,
        label: `Gift (voucher pack) บัตรกำนัล (voucher ${NAMED_CODE})`,
      });
      await old.client.query(
        `update pos.sale set status = 'finalised', receipt_series = 'T1', receipt_seq = 2,
                             receipt_number = 'T1-000002', finalised_at = now()
          where id = $1`,
        [named],
      );

      // A sale still open, and beside it every row the migration must not touch.
      const open = await tenderingSale(old.client, t);
      const openLine = await discountRow(old.client, t, open, {
        sequence: 1,
        kind: 'promo',
        code: OPEN_CODE,
        label: `Mystery Gift (voucher ${OPEN_CODE})`,
      });
      const others = await tenderingSale(old.client, t);
      const untouched = {
        // Labelled since 2246aef: already the last four.
        newForm: await discountRow(old.client, t, others, {
          sequence: 1,
          kind: 'promo',
          code: NEW_FORM_CODE,
          label: `150 THB Voucher (voucher …${NEW_FORM_CODE.slice(-4)})`,
        }),
        // A park code's row: its definition's label.
        parkCode: await discountRow(old.client, t, others, {
          sequence: 2,
          kind: 'promo',
          code: 'SONGKRAN25',
          label: 'Songkran',
        }),
        // "(voucher " in a park code's label, not followed by the row's own code.
        otherCode: await discountRow(old.client, t, others, {
          sequence: 3,
          kind: 'promo',
          code: 'GIFT10',
          label: 'Gift card promotion (voucher PROGRAMME)',
        }),
        // A staff member's discount: no code, no label.
        manual: await discountRow(old.client, t, others, {
          sequence: 4,
          kind: 'manual',
          code: null,
          label: null,
        }),
      };
      const before = {
        newForm: await discountOf(old.client, untouched.newForm),
        parkCode: await discountOf(old.client, untouched.parkCode),
        otherCode: await discountOf(old.client, untouched.otherCode),
        manual: await discountOf(old.client, untouched.manual),
      };

      // The freeze is what the migration has to step round: the voided and the
      // finalised sale's rows refuse an ordinary update.
      await expect(
        old.client.query(`update pos.sale_discount set label = 'x' where id = $1`, [voidedLine]),
      ).rejects.toThrow(/pos\.sale_child_freeze/);
      await expect(
        old.client.query(`update pos.sale_discount set label = 'x' where id = $1`, [finalisedLine]),
      ).rejects.toThrow(/pos\.sale_child_freeze/);

      migrate(old.url);

      // The label names the last four; the code column keeps the whole code.
      expect(await discountOf(old.client, voidedLine)).toEqual({
        code: VOIDED_CODE,
        label: '150 THB Voucher (voucher …4W9X)',
      });
      expect(await discountOf(old.client, finalisedLine)).toEqual({
        code: FINALISED_CODE,
        label: 'Free Bracelet Workshop (voucher …5Y6Z)',
      });
      expect(await discountOf(old.client, openLine)).toEqual({
        code: OPEN_CODE,
        label: 'Mystery Gift (voucher …8H2J)',
      });
      expect(await discountOf(old.client, namedLine)).toEqual({
        code: NAMED_CODE,
        label: 'Gift (voucher pack) บัตรกำนัล (voucher …2C3D)',
      });
      for (const [name, id] of Object.entries(untouched)) {
        expect(await discountOf(old.client, id), name).toEqual(before[name as keyof typeof before]);
      }
      // Nowhere does a label still carry a whole code.
      const whole = await one<number>(
        old.client,
        `select count(*)::int from pos.sale_discount
          where kind = 'promo' and code is not null and label like '%(voucher ' || code || ')'`,
      );
      expect(whole).toBe(0);

      // The freeze is back: the same ordinary update is refused again.
      await expect(
        old.client.query(`update pos.sale_discount set label = 'x' where id = $1`, [voidedLine]),
      ).rejects.toThrow(/pos\.sale_child_freeze/);
      expect(
        await one(
          old.client,
          `select tgenabled from pg_trigger
            where tgrelid = 'pos.sale_discount'::regclass and tgname = 'sale_discount_freeze'`,
        ),
      ).toBe('O');

      // Its statements run again, as the migrator would run them: nothing matches.
      const labels = async () =>
        (await old.client.query(`select id, code, label from pos.sale_discount order by id`)).rows;
      const afterOnce = await labels();
      await old.client.query('begin');
      const counts: number[] = [];
      for (const statement of statementsOf0025()) {
        counts.push((await old.client.query(statement)).rowCount ?? 0);
      }
      await old.client.query('commit');
      // ALTER, UPDATE, ALTER: the UPDATE found no row in the old form.
      expect(counts).toEqual([0, 0, 0]);
      expect(await labels()).toEqual(afterOnce);
    } finally {
      await old.drop();
    }
  }, 240_000);
});

/**
 * Every column, constraint, index and trigger in the schema this migration
 * touches, as the catalogue describes them — the thing that must not move when
 * the migration runs again.
 */
async function fingerprint(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ line: string }>(
    `select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || udt_name
              || ' ' || is_nullable || ' ' || coalesce(column_default, '') as line
       from information_schema.columns where table_schema = 'pos'
     union all
     select 'con ' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid)
       from pg_constraint c join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'pos'
     union all
     select 'idx ' || tablename || '.' || indexname || ' ' || indexdef
       from pg_indexes where schemaname = 'pos'
     union all
     select 'trg ' || t.relname || '.' || g.tgname || ' ' || g.tgenabled::text
       from pg_trigger g join pg_class t on t.oid = g.tgrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'pos' and not g.tgisinternal
     order by 1`,
  );
  return rows.map((r) => r.line);
}

describe('the migration, run twice', () => {
  it('leaves the same database when it is applied again', async () => {
    const before = await fingerprint(client);
    expect(before).toContain('trg sale_discount.sale_discount_freeze O');
    const applied = () =>
      one<number>(client, `select count(*)::int from drizzle.__drizzle_migrations`);
    const count = await applied();
    migrate(db.url);
    expect(await fingerprint(client)).toEqual(before);
    expect(await applied()).toBe(count);
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
