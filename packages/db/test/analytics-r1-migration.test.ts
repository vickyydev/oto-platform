import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-15b (SCRUM-216) round 1 — migration 0064, against live databases built
 * from the committed migrations (plan docs/progress/plans/analytics/PLAN.md
 * §7, §8 round 1):
 *
 *   - it builds from empty twice, applies again as a no-op, and is journal
 *     entry 64 after 0063;
 *   - the summaries' tables carry the plan's columns and keys, and every
 *     foreign key is indexed;
 *   - every sale line has a revenue category: written without one, it takes
 *     its taxable category; the backfill gives existing lines theirs under the
 *     freeze; a null is refused;
 *   - a fact marks its day in `analytics.dirty_date` AT COMMIT, not before, and
 *     on the fact's own business date: a finalised, voided or refunded sale, a
 *     refund of an older sale, money taken, a wallet movement; a second mark
 *     bumps the count and clears a claim;
 *   - the existing days are marked once, and the calendar is filled from the
 *     branch's holidays.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
const SQL_0064 = readFileSync(join(MIGRATIONS, '0064_analytics_summaries.sql'), 'utf8');
const STATEMENTS = SQL_0064.split('--> statement-breakpoint').map((s) => s.trim());
const BACKFILL = STATEMENTS.filter(
  (s) =>
    s.includes('DISABLE TRIGGER "sale_line_freeze"') ||
    s.includes('UPDATE "pos"."sale_line" SET "revenue_category"') ||
    s.includes('ENABLE TRIGGER "sale_line_freeze"') ||
    s.includes('ADD CONSTRAINT "sale_line_revenue_category_check"'),
);
const MARK_EXISTING = STATEMENTS.find((s) => s.includes("'migration:0064'"))!;
const FILL_CALENDAR = STATEMENTS.find((s) => s.includes('INSERT INTO "analytics"."dim_date"'))!;

let first: { url: string; drop: () => Promise<void> };
let second: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  first = await createTestDatabase();
  // From empty a second time: nothing in 0064 depends on what the first left.
  second = await createTestDatabase();
  client = new pg.Client({ connectionString: second.url });
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.end();
  await first?.drop();
  await second?.drop();
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

interface Park {
  operatorId: string;
  branchId: string;
  accountId: string;
  stationId: string;
}

async function park(): Promise<Park> {
  const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'R1 Op') returning id`);
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'R1 Park', 'an1-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const accountId = await one(
    `insert into core.account (id, operator_id, phone, status) values (gen_random_uuid(), $1, $2, 'active') returning id`,
    [operatorId, `+66834${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`],
  );
  const stationId = await one(
    `insert into core.station (id, operator_id, branch_id, name, kind) values (gen_random_uuid(), $1, $2, 'R1 till', 'till') returning id`,
    [operatorId, branchId],
  );
  return { operatorId, branchId, accountId, stationId };
}

let receipt = 0;

/** A sale on `date`, in `status`. A finalised one is numbered. */
async function saleOn(p: Park, date: string, status: string, grossSatang = 10_000): Promise<string> {
  const numbered = status === 'finalised' || status === 'refunded';
  receipt += 1;
  return one(
    `insert into pos.sale (id, operator_id, branch_id, station_id, business_date, business_day_start, timezone,
       occurred_at, created_by_account_id, pricing_mode, pricing_mode_reason, customer_tier, engine_version,
       tax_config, tax_breakdown, subtotal_satang, net_satang, gross_satang,
       receipt_series, receipt_seq, receipt_number, status, finalised_at, voided_at, void_reason, refunded_at)
     values (gen_random_uuid(), $1, $2, $3, $4::date, '05:00', 'Asia/Bangkok',
       ($4::date + time '12:00') at time zone 'Asia/Bangkok', $5, 'weekday', 'Weekday pricing', 'tourist', 'r1',
       '{}'::jsonb, '{}'::jsonb, $6, $6, $6,
       $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      p.operatorId, p.branchId, p.stationId, date, p.accountId, grossSatang,
      numbered ? 'R1' : null, numbered ? receipt : null, numbered ? `R1-${receipt}` : null,
      status,
      numbered ? new Date() : null,
      status === 'voided' ? new Date() : null,
      status === 'voided' ? 'test' : null,
      status === 'refunded' ? new Date() : null,
    ],
  );
}

async function lineOf(p: Park, saleId: string, date: string, opts: { kind: string; taxable: string; category?: string | null }) {
  return code(
    `insert into pos.sale_line (id, sale_id, operator_id, branch_id, business_date, line_no, cart_line_id, kind, label,
       taxable_category, customer_tier ${opts.category === undefined ? '' : ', revenue_category'})
     values (gen_random_uuid(), $1, $2, $3, $4::date,
       (select coalesce(max(line_no), 0) + 1 from pos.sale_line where sale_id = $1), gen_random_uuid(), $5, 'A line', $6, 'tourist'
       ${opts.category === undefined ? '' : ', $7'})`,
    opts.category === undefined
      ? [saleId, p.operatorId, p.branchId, date, opts.kind, opts.taxable]
      : [saleId, p.operatorId, p.branchId, date, opts.kind, opts.taxable, opts.category],
  );
}

async function marks(branchId: string): Promise<Array<{ date: string; kind: string; reason: string; count: number }>> {
  const { rows } = await client.query(
    `select business_date::text as date, kind, reason, mark_count::int as count
       from analytics.dirty_date where branch_id = $1 order by business_date, kind`,
    [branchId],
  );
  return rows as Array<{ date: string; kind: string; reason: string; count: number }>;
}

describe('migration 0064 — analytics round 1', () => {
  it('is journal entry 64, after 0063 and later than it', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e63 = journal.entries.find((e) => e.idx === 63)!;
    const e64 = journal.entries.find((e) => e.idx === 64)!;
    expect(e64.tag).toBe('0064_analytics_summaries');
    expect(e64.when).toBeGreaterThan(e63.when);
    expect(journal.entries.indexOf(e64)).toBe(journal.entries.indexOf(e63) + 1);
    const snapshot = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '0064_snapshot.json'), 'utf8')) as { prevId: string };
    const previous = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '0063_snapshot.json'), 'utf8')) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
  });

  it('applies again over a migrated database as a no-op', async () => {
    const before = await one<number>(`select count(*)::int from drizzle.__drizzle_migrations`);
    execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL: second.url },
      stdio: 'pipe',
    });
    expect(await one<number>(`select count(*)::int from drizzle.__drizzle_migrations`)).toBe(before);
  });

  it('builds the tables the plan names, with their keys', async () => {
    const cols = async (table: string) =>
      (
        await client.query(
          `select column_name from information_schema.columns where table_schema = 'analytics' and table_name = $1`,
          [table],
        )
      ).rows.map((r: { column_name: string }) => r.column_name);
    expect(await cols('daily_summary')).toEqual(
      expect.arrayContaining([
        'operator_id', 'branch_id', 'business_date', 'source', 'formula_version', 'provisional', 'computed_at',
        'tickets_satang', 'fnb_satang', 'merch_satang', 'parties_satang', 'dropoff_satang', 'revenue_satang',
        'txn_count', 'credit_paid_satang', 'guests_kids', 'guests_adults', 'mix_1h', 'mix_2h', 'mix_full_day',
        'parties_count', 'refunds_satang', 'discounts_satang', 'comps_satang', 'vat_satang', 'service_satang',
        'by_channel', 'input_fingerprint', 'frozen', 'created_at', 'updated_at',
      ]),
    );
    expect(await cols('hourly_summary')).toEqual(
      expect.arrayContaining(['business_date', 'hour', 'source', 'revenue_satang', 'txn_count', 'guests']),
    );
    for (const table of ['daily_category_summary', 'daily_tender_summary', 'daily_item_summary', 'daily_discount_summary']) {
      expect(await cols(table)).toEqual(expect.arrayContaining(['branch_id', 'business_date', 'source', 'key']));
    }
    expect(await cols('fact_booth_daily')).toEqual(
      expect.arrayContaining([
        'booth_id', 'staff_account_id', 'prize_id', 'spins', 'vouchers_issued', 'vouchers_redeemed',
        'redemption_lag_sum_s', 'uptime_s', 'prize_cost_satang',
      ]),
    );
    expect(await cols('dim_date')).toEqual(expect.arrayContaining(['branch_id', 'date', 'weekday', 'rate_mode', 'holiday_name']));
    expect(await cols('dirty_date')).toEqual(
      expect.arrayContaining(['branch_id', 'business_date', 'kind', 'marked_at', 'reason', 'claimed_at', 'claimed_by', 'mark_count']),
    );
    expect(await cols('branch_source_switch')).toEqual(
      expect.arrayContaining(['branch_id', 'source', 'preference', 'switched_at', 'actor_account_id']),
    );

    const p = await park();
    const day = (date: string, source = 'oto_pos') =>
      code(
        `insert into analytics.daily_summary (id, operator_id, branch_id, business_date, source, formula_version, computed_at,
           tickets_satang, revenue_satang, input_fingerprint)
         values (gen_random_uuid(), $1, $2, $3::date, $4, 1, now(), 500, 500, 'x')`,
        [p.operatorId, p.branchId, date, source],
      );
    expect(await day('2026-09-01')).toBeNull();
    expect(await day('2026-09-01')).toBe('23505');
    expect(await day('2026-09-01', 'pisell')).toBeNull();
    expect(await day('2026-09-02', 'radar')).toBe('23514');
    // Revenue is the five bars on a platform row.
    expect(
      await code(
        `insert into analytics.daily_summary (id, operator_id, branch_id, business_date, formula_version, computed_at,
           tickets_satang, revenue_satang, input_fingerprint)
         values (gen_random_uuid(), $1, $2, '2026-09-03', 1, now(), 500, 600, 'x')`,
        [p.operatorId, p.branchId],
      ),
    ).toBe('23514');
    // An unattributed booth row and another of the same booth's day are one row.
    const prize = (staff: string | null) =>
      code(
        `insert into analytics.fact_booth_daily (id, operator_id, branch_id, business_date, booth_id, staff_account_id, computed_at)
         values (gen_random_uuid(), $1, $2, '2026-09-01', $3, $4, now())`,
        [p.operatorId, p.branchId, p.stationId, staff],
      );
    expect(await prize(null)).toBeNull();
    expect(await prize(null)).toBe('23505');
    expect(await prize(p.accountId)).toBeNull();
  });

  it('indexes every foreign key of the new tables', async () => {
    const { rows } = await client.query<{ table: string; column: string }>(
      `select n.nspname || '.' || t.relname as table, a.attname as column
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join unnest(c.conkey) as k(attnum) on true
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f' and n.nspname = 'analytics'
          and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
    );
    expect(rows).toEqual([]);
  });

  it('gives every sale line a revenue category, filling a missing one from its taxable category', async () => {
    const p = await park();
    const open = await saleOn(p, '2026-09-10', 'tendering');
    expect(await lineOf(p, open, '2026-09-10', { kind: 'kids', taxable: 'tickets' })).toBeNull();
    expect(await lineOf(p, open, '2026-09-10', { kind: 'service_fee', taxable: 'drop_off', category: null })).toBeNull();
    expect(await lineOf(p, open, '2026-09-10', { kind: 'fnb_item', taxable: 'fnb', category: 'fnb' })).toBeNull();
    const { rows } = await client.query(`select kind, revenue_category from pos.sale_line where sale_id = $1 order by line_no`, [open]);
    expect(rows).toEqual([
      { kind: 'kids', revenue_category: 'tickets' },
      { kind: 'service_fee', revenue_category: 'drop_off' },
      { kind: 'fnb_item', revenue_category: 'fnb' },
    ]);
    // Taken away afterwards: refused.
    expect(await code(`update pos.sale_line set revenue_category = null where sale_id = $1`, [open])).toBe('23514');
  });

  it('backfills the lines of a closed sale under the freeze, and leaves the freeze on', async () => {
    const p = await park();
    const closed = await saleOn(p, '2026-09-11', 'finalised');
    await client.query('begin');
    try {
      // The shape of a line written before 0064: no category, nothing to fill it.
      await client.query(`alter table pos.sale_line disable trigger sale_line_revenue_category`);
      await client.query(`alter table pos.sale_line drop constraint sale_line_revenue_category_check`);
      for (const [kind, taxable] of [
        ['kids', 'tickets'],
        ['service_fee', 'drop_off'],
        ['merch_item', 'merch'],
        ['food_provision', 'stored_value'],
      ] as const) {
        expect(await lineOf(p, closed, '2026-09-11', { kind, taxable })).toBeNull();
      }
      await client.query(`alter table pos.sale_line enable trigger sale_line_revenue_category`);
      expect(await one<number>(`select count(*)::int from pos.sale_line where sale_id = $1 and revenue_category is null`, [closed])).toBe(4);
      for (const statement of BACKFILL) await client.query(statement);
      const { rows } = await client.query(`select kind, revenue_category from pos.sale_line where sale_id = $1 order by line_no`, [closed]);
      expect(rows).toEqual([
        { kind: 'kids', revenue_category: 'tickets' },
        { kind: 'service_fee', revenue_category: 'drop_off' },
        { kind: 'merch_item', revenue_category: 'merch' },
        { kind: 'food_provision', revenue_category: 'stored_value' },
      ]);
      // The freeze is back: a closed sale's line cannot be rewritten.
      await client.query('savepoint frozen');
      await expect(client.query(`update pos.sale_line set label = 'x' where sale_id = $1`, [closed])).rejects.toMatchObject({
        code: '23514',
      });
      await client.query('rollback to savepoint frozen');
    } finally {
      await client.query('rollback');
    }
    expect(await one<number>(`select count(*)::int from pos.sale_line where revenue_category is null`)).toBe(0);
  });

  it('marks a sale’s day at commit, not before, and only for a counted state', async () => {
    const p = await park();
    await client.query('begin');
    const saleId = await saleOn(p, '2026-09-12', 'finalised');
    expect(await marks(p.branchId)).toEqual([]);
    await client.query('commit');
    expect(await marks(p.branchId)).toEqual([{ date: '2026-09-12', kind: 'sales', reason: 'sale:finalised', count: 1 }]);

    // A cart still being paid for is not a fact of any day.
    const p2 = await park();
    const open = await saleOn(p2, '2026-09-12', 'tendering');
    expect(await marks(p2.branchId)).toEqual([]);
    await client.query(
      `update pos.sale set status = 'voided', voided_at = now(), void_reason = 'test' where id = $1`,
      [open],
    );
    expect(await marks(p2.branchId)).toEqual([{ date: '2026-09-12', kind: 'sales', reason: 'sale:voided', count: 1 }]);

    // A second mark of the same day bumps the count and clears a claim.
    await client.query(`update analytics.dirty_date set claimed_at = now(), claimed_by = 'run-1' where branch_id = $1`, [p.branchId]);
    await client.query(`update pos.sale set status = 'voided', voided_at = now(), void_reason = 'test' where id = $1`, [saleId]);
    const { rows } = await client.query(
      `select mark_count::int as count, reason, claimed_at, claimed_by from analytics.dirty_date where branch_id = $1`,
      [p.branchId],
    );
    expect(rows).toEqual([{ count: 2, reason: 'sale:voided', claimed_at: null, claimed_by: null }]);
  });

  it('marks the refunded sale’s own day, money taken on its sale’s day, and a wallet movement’s day', async () => {
    const p = await park();
    const old = await saleOn(p, '2026-09-01', 'finalised');
    await client.query(`delete from analytics.dirty_date where branch_id = $1`, [p.branchId]);

    // A refund made today of a sale from the first.
    await client.query(
      `insert into pos.refund (id, operator_id, branch_id, sale_id, station_id, number, amount_satang, mode, reason,
         approved_by_account_id, created_by_account_id)
       values (gen_random_uuid(), $1, $2, $3, $4, 'R1-R-1', 2000, 'custom', 'test', $5, $5)`,
      [p.operatorId, p.branchId, old, p.stationId, p.accountId],
    );
    expect(await marks(p.branchId)).toEqual([{ date: '2026-09-01', kind: 'sales', reason: 'refund', count: 1 }]);

    // A tender opened, then approved: the approval is the fact.
    await client.query(`delete from analytics.dirty_date where branch_id = $1`, [p.branchId]);
    const attempt = await one(
      `insert into pos.payment_attempt (id, operator_id, branch_id, sale_id, business_date, method, method_code, amount_satang, status)
       values (gen_random_uuid(), $1, $2, $3, '2026-09-05', 'card', 'card', 1000, 'created') returning id`,
      [p.operatorId, p.branchId, old],
    );
    expect(await marks(p.branchId)).toEqual([]);
    await client.query(`update pos.payment_attempt set status = 'approved', paid_at = now() where id = $1`, [attempt]);
    expect(await marks(p.branchId)).toEqual([{ date: '2026-09-01', kind: 'sales', reason: 'payment:approved', count: 1 }]);

    // A wallet spend on that sale: the wallet's day and the sale's day.
    await client.query(`delete from analytics.dirty_date where branch_id = $1`, [p.branchId]);
    const wallet = await one(
      `insert into pos.wallet (id, operator_id, branch_id, holder_name, balance_satang) values (gen_random_uuid(), $1, $2, 'Guest', 0) returning id`,
      [p.operatorId, p.branchId],
    );
    await client.query(
      `insert into pos.wallet_entry (id, wallet_id, operator_id, action_id, amount_satang, kind, source, sale_id, branch_id, business_date, balance_after)
       values (gen_random_uuid(), $1, $2, 'grant-1', 5000, 'grant', 'ticket_sale', $3, $4, '2026-09-04', 5000)`,
      [wallet, p.operatorId, old, p.branchId],
    );
    expect(await marks(p.branchId)).toEqual([
      { date: '2026-09-01', kind: 'sales', reason: 'wallet_entry:grant', count: 1 },
      { date: '2026-09-04', kind: 'wallet', reason: 'wallet_entry:grant', count: 1 },
    ]);
  });

  it('marks every existing day once, and fills the calendar from the branch’s holidays', async () => {
    const p = await park();
    await saleOn(p, '2026-08-20', 'finalised');
    await saleOn(p, '2026-08-20', 'refunded');
    await saleOn(p, '2026-08-21', 'tendering');
    await client.query(`delete from analytics.dirty_date where branch_id = $1`, [p.branchId]);
    await client.query(MARK_EXISTING);
    await client.query(MARK_EXISTING);
    expect((await marks(p.branchId)).map((m) => [m.date, m.kind, m.reason])).toEqual([
      ['2026-08-20', 'sales', 'migration:0064'],
    ]);

    await client.query(
      `insert into pos.branch_holiday (id, branch_id, name, starts_on, ends_on)
       values (gen_random_uuid(), $1, 'Songkran', '2027-04-13', '2027-04-15')`,
      [p.branchId],
    );
    await client.query(FILL_CALENDAR);
    await client.query(`delete from analytics.dim_date where branch_id = $1`, [p.branchId]);
    await client.query(FILL_CALENDAR);
    await client.query(FILL_CALENDAR);
    const { rows } = await client.query(
      `select date::text as date, weekday, rate_mode, holiday_name from analytics.dim_date
        where branch_id = $1 and date in ('2026-08-20', '2026-08-22', '2027-04-12', '2027-04-13', '2027-04-15', '2027-04-16')
        order by date`,
      [p.branchId],
    );
    expect(rows).toEqual([
      { date: '2026-08-20', weekday: 4, rate_mode: 'weekday', holiday_name: null },
      { date: '2026-08-22', weekday: 6, rate_mode: 'weekend', holiday_name: null },
      { date: '2027-04-12', weekday: 1, rate_mode: 'weekday', holiday_name: null },
      { date: '2027-04-13', weekday: 2, rate_mode: 'holiday', holiday_name: 'Songkran' },
      { date: '2027-04-15', weekday: 4, rate_mode: 'holiday', holiday_name: 'Songkran' },
      { date: '2027-04-16', weekday: 5, rate_mode: 'weekday', holiday_name: null },
    ]);
    expect(
      await one<number>(
        `select count(*)::int from (select date from analytics.dim_date where branch_id = $1 group by date having count(*) > 1) d`,
        [p.branchId],
      ),
    ).toBe(0);
  });
});
