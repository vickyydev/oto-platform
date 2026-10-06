import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-15b (SCRUM-216) rounds 4 and 5 — migration 0065, against live databases
 * built from the committed migrations (plan docs/progress/plans/analytics/
 * PLAN.md §7, §8 rounds 4-5):
 *
 *   - it builds from empty twice and is journal entry 65 after 0064;
 *   - the report tables gain what the panels show (the VAT split, the items'
 *     untracked cost, who applied a manual discount, a promo's label) and the
 *     ticket side gets its table, with keys and CHECKs;
 *   - the booth's dirty-day marks are wired (spins and booth vouchers), and the
 *     backlog statements queue every day that already traded.
 *
 * The marks themselves are exercised with real spins and a real redemption in
 * `apps/api/test/s216-r5-booth.test.ts`.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
const SQL_0065 = readFileSync(join(MIGRATIONS, '0065_analytics_reports.sql'), 'utf8');
const STATEMENTS = SQL_0065.split('--> statement-breakpoint').map((s) => s.trim());
const REQUEUE_SALES = STATEMENTS.find((s) => s.includes("'migration:0065'") && s.includes('"pos"."sale"'))!;
const REQUEUE_BOOTH = STATEMENTS.find((s) => s.includes("'migration:0065'") && s.includes('"booth"."spin"'))!;

let first: { url: string; drop: () => Promise<void> };
let second: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  first = await createTestDatabase();
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

const cols = async (table: string) =>
  (
    await client.query(
      `select column_name from information_schema.columns where table_schema = 'analytics' and table_name = $1`,
      [table],
    )
  ).rows.map((r: { column_name: string }) => r.column_name);

describe('migration 0065 — analytics rounds 4 and 5', () => {
  it('is journal entry 65, after 0064 and later than it, on 0064’s snapshot', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e64 = journal.entries.find((e) => e.idx === 64)!;
    const e65 = journal.entries.find((e) => e.idx === 65)!;
    expect(e65.tag).toBe('0065_analytics_reports');
    expect(e65.when).toBeGreaterThan(e64.when);
    expect(journal.entries.indexOf(e65)).toBe(journal.entries.indexOf(e64) + 1);
    const snapshot = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '0065_snapshot.json'), 'utf8')) as { prevId: string };
    const previous = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '0064_snapshot.json'), 'utf8')) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
  });

  it('gives the report tables the columns the panels show, and the ticket side its table', async () => {
    expect(await cols('daily_category_summary')).toEqual(expect.arrayContaining(['tax_inclusive_satang', 'tax_exclusive_satang']));
    expect(await cols('daily_item_summary')).toEqual(expect.arrayContaining(['cost_untracked_quantity']));
    expect(await cols('daily_discount_summary')).toEqual(
      expect.arrayContaining(['label', 'applied_by_account_id', 'applied_by_name']),
    );
    expect(await cols('daily_ticket_summary')).toEqual(
      expect.arrayContaining([
        'operator_id', 'branch_id', 'business_date', 'source', 'kind', 'key', 'label', 'sale_count', 'line_count',
        'kids', 'adults', 'hours', 'revenue_satang', 'dropoff_satang', 'computed_at', 'created_at', 'updated_at',
      ]),
    );
    const indexes = (
      await client.query(`select indexname, indexdef from pg_indexes where schemaname = 'analytics'`)
    ).rows as Array<{ indexname: string; indexdef: string }>;
    const def = (name: string) => indexes.find((i) => i.indexname === name)?.indexdef ?? '';
    expect(def('daily_ticket_summary_unique')).toMatch(/UNIQUE.*\(branch_id, business_date, source, kind, key\)/);
    expect(def('daily_ticket_summary_operator_date_idx')).toMatch(/\(operator_id, business_date\)/);
    expect(def('daily_discount_summary_applied_by_idx')).toMatch(/\(applied_by_account_id\)/);
  });

  it('holds the new rows to their words', async () => {
    const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'R4 Op') returning id`);
    const branchId = await one(
      `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'R4 Park', 'r4-' || substr(md5(random()::text), 1, 8)) returning id`,
      [operatorId],
    );
    const item = (kind: string, quantity: number, untracked: number) =>
      code(
        `insert into analytics.daily_item_summary (id, operator_id, branch_id, business_date, key, kind, label, quantity, cost_untracked_quantity, computed_at)
         values (gen_random_uuid(), $1, $2, current_date, gen_random_uuid()::text, $3, 'x', $4, $5, now())`,
        [operatorId, branchId, kind, quantity, untracked],
      );
    expect(await item('fnb', 2, 2)).toBeNull();
    expect(await item('merch', 2, 0)).toBeNull();
    expect(await item('ticket', 2, 0)).toBe('23514');
    expect(await item('fnb', 2, 3)).toBe('23514');
    const ticket = (kind: string, key: string) =>
      code(
        `insert into analytics.daily_ticket_summary (id, operator_id, branch_id, business_date, kind, key, label, computed_at)
         values (gen_random_uuid(), $1, $2, current_date, $3, $4, 'x', now())`,
        [operatorId, branchId, kind, key],
      );
    expect(await ticket('tier', 'tourist')).toBeNull();
    expect(await ticket('tier', 'tourist')).toBe('23505');
    expect(await ticket('ticket_type', 'tourist')).toBeNull();
    expect(await ticket('party', 'x')).toBe('23514');
    expect(
      await code(
        `insert into analytics.daily_category_summary (id, operator_id, branch_id, business_date, key, tax_inclusive_satang, computed_at)
         values (gen_random_uuid(), $1, $2, current_date, 'tickets', -1, now())`,
        [operatorId, branchId],
      ),
    ).toBe('23514');
  });

  it('wires the booth’s dirty-day marks: spins and booth vouchers, at commit', async () => {
    const triggers = (
      await client.query(
        `select tgname, tgdeferrable, tginitdeferred from pg_trigger where not tgisinternal and tgname = any($1)`,
        [['spin_insert_marks_dirty_date', 'spin_update_marks_dirty_date', 'spin_delete_marks_dirty_date', 'voucher_marks_booth_dirty_date']],
      )
    ).rows as Array<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>;
    expect(triggers.map((t) => t.tgname).sort()).toEqual(
      ['spin_delete_marks_dirty_date', 'spin_insert_marks_dirty_date', 'spin_update_marks_dirty_date', 'voucher_marks_booth_dirty_date'],
    );
    for (const t of triggers) expect([t.tgname, t.tgdeferrable, t.tginitdeferred]).toEqual([t.tgname, true, true]);
  });

  it('queues every traded day again for the report rows, and every spun day for the booth figures', async () => {
    const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'R4 Q Op') returning id`);
    const branchId = await one(
      `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'R4 Q Park', 'r4q-' || substr(md5(random()::text), 1, 8)) returning id`,
      [operatorId],
    );
    const accountId = await one(
      `insert into core.account (id, operator_id, phone, status) values (gen_random_uuid(), $1, $2, 'active') returning id`,
      [operatorId, `+66835${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`],
    );
    const stationId = await one(
      `insert into core.station (id, operator_id, branch_id, name, kind) values (gen_random_uuid(), $1, $2, 'R4 till', 'till') returning id`,
      [operatorId, branchId],
    );
    await client.query(
      `insert into pos.sale (id, operator_id, branch_id, station_id, business_date, business_day_start, timezone,
         occurred_at, created_by_account_id, pricing_mode, pricing_mode_reason, customer_tier, engine_version,
         tax_config, tax_breakdown, subtotal_satang, net_satang, gross_satang,
         receipt_series, receipt_seq, receipt_number, status, finalised_at)
       values (gen_random_uuid(), $1, $2, $3, '2026-09-01', '05:00', 'Asia/Bangkok', now(), $4, 'weekday', 'Weekday pricing',
         'tourist', 'r4', '{}'::jsonb, '{}'::jsonb, 100, 100, 100, 'R4', 1, 'R4-1', 'finalised', now())`,
      [operatorId, branchId, stationId, accountId],
    );
    // The sale marked its own day at commit; the mark is spent, then the backlog statement queues it again.
    await client.query(`delete from analytics.dirty_date where branch_id = $1`, [branchId]);
    await client.query(REQUEUE_SALES);
    await client.query(REQUEUE_BOOTH);
    const { rows } = await client.query(
      `select business_date::text as date, kind, reason from analytics.dirty_date where branch_id = $1`,
      [branchId],
    );
    expect(rows).toEqual([{ date: '2026-09-01', kind: 'sales', reason: 'migration:0065' }]);
    // Twice is once.
    await client.query(REQUEUE_SALES);
    expect(await one<number>(`select count(*)::int from analytics.dirty_date where branch_id = $1`, [branchId])).toBe(1);
  });
});
