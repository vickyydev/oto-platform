import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-14a round 1 — stored value (migration 0045), against live databases
 * built from the committed migrations.
 *
 * What the database itself has to hold, whatever the api does:
 *   - it builds from empty, twice, and 0045 is journal entry 45 after 0044;
 *   - a key names one wallet per operator (kind, value), and two operators
 *     may each hold the same value;
 *   - an action key is written once per operator — the double-spend defence;
 *   - an entry's sign follows its kind, the balance never goes below zero,
 *     and kinds and sources are the plan's words and nothing else;
 *   - the policy row: one per branch, `days_n` needs a day count, the seeded
 *     statement gives every branch same-day / ฿300 / its drop-off rule, and
 *     running it again adds nothing;
 *   - a print job may name a wallet as its subject;
 *   - the reshape refuses to run over a wallet that holds a row.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SQL_0045 = readFileSync(join(MIGRATIONS, '0045_wallet_ledger.sql'), 'utf8');
const statements = SQL_0045.split('--> statement-breakpoint').map((s) => s.trim());
const GUARD = statements.find((s) => s.includes('DO $$'))!;
const SEED = statements.find((s) => s.startsWith('INSERT INTO "pos"."wallet_policy"') || s.includes('INSERT INTO "pos"."wallet_policy"'))!;

let first: { url: string; drop: () => Promise<void> };
let second: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  first = await createTestDatabase();
  // From empty a second time: nothing in 0045 depends on state the first left.
  second = await createTestDatabase();
  client = new pg.Client({ connectionString: second.url });
  await client.connect();
}, 240_000);

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

async function park(): Promise<{ operatorId: string; branchId: string }> {
  const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'Wallet Op') returning id`);
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Wallet Park', 'wl-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  return { operatorId, branchId };
}

async function walletOf(operatorId: string, branchId: string): Promise<string> {
  return one(
    `insert into pos.wallet (id, operator_id, branch_id, holder_name) values (gen_random_uuid(), $1, $2, 'Walk-in guest') returning id`,
    [operatorId, branchId],
  );
}

describe('migration 0045 — the wallet ledger', () => {
  it('is journal entry 45, after 0044 and later than it', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const e44 = journal.entries.find((e) => e.idx === 44)!;
    const e45 = journal.entries.find((e) => e.idx === 45)!;
    expect(e45.tag).toBe('0045_wallet_ledger');
    expect(e45.when).toBeGreaterThan(e44.when);
  });

  it('builds the tables and columns the plan names', async () => {
    const cols = async (schema: string, table: string) =>
      (
        await client.query(
          `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
          [schema, table],
        )
      ).rows.map((r: { column_name: string }) => r.column_name);
    expect(await cols('pos', 'wallet')).toEqual(
      expect.arrayContaining(['operator_id', 'branch_id', 'member_id', 'holder_name', 'balance_satang', 'status']),
    );
    expect(await cols('pos', 'wallet_entry')).toEqual(
      expect.arrayContaining([
        'action_id', 'kind', 'source', 'sale_id', 'refund_id', 'payment_attempt_id', 'branch_id',
        'station_id', 'box_id', 'offline', 'business_date', 'actor_account_id', 'expires_at', 'balance_after',
      ]),
    );
    expect(await cols('pos', 'wallet_key')).toEqual(expect.arrayContaining(['wallet_id', 'kind', 'value']));
    expect(await cols('pos', 'wallet_policy')).toEqual(
      expect.arrayContaining(['branch_id', 'expiry', 'expiry_days', 'offline_cap_satang', 'prepaid_unused']),
    );
    expect(await cols('analytics', 'fact_wallet_liability_daily')).toEqual(
      expect.arrayContaining(['granted_satang', 'spent_satang', 'refunded_satang', 'expired_satang', 'outstanding_satang']),
    );
  });

  it('a key names one wallet per operator; another operator may hold the same value', async () => {
    const a = await park();
    const b = await park();
    const w1 = await walletOf(a.operatorId, a.branchId);
    const w2 = await walletOf(a.operatorId, a.branchId);
    const w3 = await walletOf(b.operatorId, b.branchId);
    const insertKey = (op: string, w: string, kind: string, value: string) =>
      code(`insert into pos.wallet_key (id, operator_id, wallet_id, kind, value) values (gen_random_uuid(), $1, $2, $3, $4)`, [op, w, kind, value]);
    expect(await insertKey(a.operatorId, w1, 'voucher_qr', 'QR-SAME')).toBeNull();
    expect(await insertKey(a.operatorId, w2, 'voucher_qr', 'QR-SAME')).toBe('23505');
    expect(await insertKey(b.operatorId, w3, 'voucher_qr', 'QR-SAME')).toBeNull();
    // Another kind with the same text is another key.
    expect(await insertKey(a.operatorId, w2, 'band', 'QR-SAME')).toBeNull();
    expect(await insertKey(a.operatorId, w2, 'card', 'X')).toBe('23514');
  });

  it('an action key is written once per operator; signs follow kinds; balances never go negative', async () => {
    const a = await park();
    const w = await walletOf(a.operatorId, a.branchId);
    const entry = (action: string, amount: number, kind: string, source: string, after: number) =>
      code(
        `insert into pos.wallet_entry (id, wallet_id, operator_id, action_id, amount_satang, kind, source, balance_after)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
        [w, a.operatorId, action, amount, kind, source, after],
      );
    expect(await entry('sale:1:grant:0', 35000, 'grant', 'ticket_sale', 35000)).toBeNull();
    expect(await entry('sale:1:grant:0', 35000, 'grant', 'ticket_sale', 70000)).toBe('23505');
    expect(await entry('spend:1', 5000, 'spend', 'fnb_order', 30000)).toBe('23514');
    expect(await entry('spend:1', -5000, 'spend', 'fnb_order', 30000)).toBeNull();
    expect(await entry('grant:neg', -1, 'grant', 'ticket_sale', 0)).toBe('23514');
    expect(await entry('spend:over', -1, 'spend', 'fnb_order', -1)).toBe('23514');
    expect(await entry('odd', 1, 'gift', 'ticket_sale', 1)).toBe('23514');
    expect(await entry('odd2', 1, 'grant', 'lottery', 1)).toBe('23514');
    expect(await code(`update pos.wallet set balance_satang = -1 where id = $1`, [w])).toBe('23514');
    expect(await code(`update pos.wallet set status = 'frozen' where id = $1`, [w])).toBe('23514');
  });

  it('the seeded policy: every branch gets same-day, ฿300 and its drop-off rule, once', async () => {
    const a = await park();
    const b = await park();
    // b's drop-off pricing says forfeit; a has none and falls back to refund.
    await client.query(
      `insert into pos.drop_off_pricing (id, operator_id, branch_id,
         one_time_fee_weekday_satang, one_time_fee_weekend_satang, nanny_hourly_weekday_satang,
         nanny_hourly_weekend_satang, extra_hour_weekday_satang, extra_hour_weekend_satang, prepaid_food_unused)
       values (gen_random_uuid(), $1, $2, 22500, 22500, 33000, 33000, 30000, 30000, 'forfeit')`,
      [b.operatorId, b.branchId],
    );
    await client.query(SEED);
    await client.query(SEED);
    const rows = (
      await client.query(
        `select branch_id, expiry, expiry_days, offline_cap_satang, prepaid_unused from pos.wallet_policy where branch_id = any($1)`,
        [[a.branchId, b.branchId]],
      )
    ).rows as { branch_id: string; expiry: string; expiry_days: number | null; offline_cap_satang: string; prepaid_unused: string }[];
    expect(rows).toHaveLength(2);
    const ofA = rows.find((r) => r.branch_id === a.branchId)!;
    const ofB = rows.find((r) => r.branch_id === b.branchId)!;
    expect(ofA).toMatchObject({ expiry: 'same_day', expiry_days: null, prepaid_unused: 'refund' });
    expect(Number(ofA.offline_cap_satang)).toBe(30000);
    expect(ofB.prepaid_unused).toBe('forfeit');
    expect(await code(`update pos.wallet_policy set expiry = 'days_n' where branch_id = $1`, [a.branchId])).toBe('23514');
    expect(
      await code(`update pos.wallet_policy set expiry = 'days_n', expiry_days = 3 where branch_id = $1`, [a.branchId]),
    ).toBeNull();
    expect(await code(`update pos.wallet_policy set offline_cap_satang = -1 where branch_id = $1`, [a.branchId])).toBe('23514');
  });

  it('a print job may name a wallet as its subject', async () => {
    const def = await one<string>(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'print_job_subject_check'`,
    );
    expect(def).toContain("'wallet'");
  });

  it('the reshape refuses to run over a wallet that already holds a row', async () => {
    const a = await park();
    await walletOf(a.operatorId, a.branchId);
    expect(await code(GUARD)).toBe('P0001');
  });
});
