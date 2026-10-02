import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-15a round 1 — the End of Day (migration 0052), against live databases
 * built from the committed migrations.
 *
 *   - it builds from empty TWICE (two fresh databases), a second `migrate` on a
 *     built one is a no-op, and 0052 is journal entry 52 after 0051;
 *   - one closed day per branch and business date;
 *   - a paid-out names an approver and a safe drop a witness, never the person
 *     who took the cash out; amounts are positive; a press records once;
 *   - both tables refuse UPDATE, and DELETE except under the demo reset's
 *     purge flag.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');

let first: { url: string; drop: () => Promise<void> };
let second: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  first = await createTestDatabase();
  second = await createTestDatabase();
  client = new pg.Client({ connectionString: first.url });
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

async function park(): Promise<{ operatorId: string; branchId: string; a: string; b: string }> {
  const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'Cash Op') returning id`);
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Cash Park', 'eod-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const account = (phone: string) =>
    one(`insert into core.account (id, operator_id, phone, status) values (gen_random_uuid(), $1, $2, 'active') returning id`, [
      operatorId,
      phone,
    ]);
  const suffix = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  return { operatorId, branchId, a: await account(`+66811${suffix}`), b: await account(`+66822${suffix}`) };
}

const closeDay = (p: { operatorId: string; branchId: string; a: string }, date: string) =>
  code(
    `insert into pos.end_of_day (id, operator_id, branch_id, business_date, lines, float_satang, total_expected_satang,
       total_actual_satang, total_difference_satang, closed_by_account_id, closed_at)
     values (gen_random_uuid(), $1, $2, $3, '[]'::jsonb, 600000, 0, 0, 0, $4, now())`,
    [p.operatorId, p.branchId, date, p.a],
  );

const movement = (
  p: { operatorId: string; branchId: string; a: string },
  fields: { kind: string; amount: number; approver?: string | null; witness?: string | null; actionId: string },
) =>
  code(
    `insert into pos.cash_movement (id, operator_id, branch_id, business_date, kind, amount_satang, reason,
       actor_account_id, approver_account_id, witness_account_id, action_id)
     values (gen_random_uuid(), $1, $2, '2026-10-02', $3, $4, 'Ice', $5, $6, $7, $8)`,
    [p.operatorId, p.branchId, fields.kind, fields.amount, p.a, fields.approver ?? null, fields.witness ?? null, fields.actionId],
  );

describe('migration 0052 — the End of Day', () => {
  it('is journal entry 52, after 0051', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e51 = journal.entries.find((e) => e.idx === 51)!;
    const e52 = journal.entries.find((e) => e.idx === 52)!;
    expect(e52.tag).toBe('0052_end_of_day');
    expect(e52.when).toBeGreaterThan(e51.when);
    expect(Math.max(...journal.entries.map((e) => e.idx))).toBe(52);
  });

  it('builds from empty twice, and migrating a built database again is a no-op', async () => {
    const other = new pg.Client({ connectionString: second.url });
    await other.connect();
    try {
      const { rows } = await other.query(
        `select count(*)::int as n from information_schema.tables
          where table_schema = 'pos' and table_name in ('end_of_day','cash_movement')`,
      );
      expect(rows[0].n).toBe(2);
    } finally {
      await other.end();
    }
    expect(() =>
      execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
        cwd: PKG,
        env: { ...process.env, DATABASE_URL: first.url },
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('one closed day per branch and business date', async () => {
    const p = await park();
    expect(await closeDay(p, '2026-10-01')).toBeNull();
    expect(await closeDay(p, '2026-10-01')).toBe('23505');
    expect(await closeDay(p, '2026-10-02')).toBeNull();
  });

  it('the second person is the right one for the kind and never the actor; amounts are positive; one press records once', async () => {
    const p = await park();
    expect(await movement(p, { kind: 'paid_out', amount: 100, approver: null, actionId: 'm1' })).toBe('23514');
    expect(await movement(p, { kind: 'paid_out', amount: 100, approver: p.a, actionId: 'm2' })).toBe('23514');
    expect(await movement(p, { kind: 'paid_out', amount: 100, approver: p.b, witness: p.b, actionId: 'm3' })).toBe('23514');
    expect(await movement(p, { kind: 'safe_drop', amount: 100, witness: p.a, actionId: 'm4' })).toBe('23514');
    expect(await movement(p, { kind: 'safe_drop', amount: 0, witness: p.b, actionId: 'm5' })).toBe('23514');
    expect(await movement(p, { kind: 'paid_in', amount: 100, approver: p.b, actionId: 'm6' })).toBe('23514');
    expect(await movement(p, { kind: 'paid_out', amount: 100, approver: p.b, actionId: 'ok-1' })).toBeNull();
    expect(await movement(p, { kind: 'safe_drop', amount: 100, witness: p.b, actionId: 'ok-2' })).toBeNull();
    expect(await movement(p, { kind: 'safe_drop', amount: 100, witness: p.b, actionId: 'ok-2' })).toBe('23505');
  });

  it('both tables refuse UPDATE, and DELETE except under the purge flag', async () => {
    const p = await park();
    await closeDay(p, '2026-09-30');
    await movement(p, { kind: 'paid_out', amount: 500, approver: p.b, actionId: 'frozen' });
    expect(await code(`update pos.end_of_day set notes = 'x' where branch_id = $1`, [p.branchId])).toBe('P0001');
    expect(await code(`update pos.cash_movement set amount_satang = 1 where branch_id = $1`, [p.branchId])).toBe('P0001');
    expect(await code(`delete from pos.end_of_day where branch_id = $1`, [p.branchId])).toBe('P0001');
    expect(await code(`delete from pos.cash_movement where branch_id = $1`, [p.branchId])).toBe('P0001');
    await client.query('begin');
    await client.query(`select set_config('oto.cash_ledger_purge', 'on', true)`);
    await client.query(`delete from pos.cash_movement where branch_id = $1`, [p.branchId]);
    await client.query(`delete from pos.end_of_day where branch_id = $1`, [p.branchId]);
    await client.query('commit');
    expect(await one<number>(`select count(*)::int from pos.end_of_day where branch_id = $1`, [p.branchId])).toBe(0);
    // The flag was local to that transaction.
    await closeDay(p, '2026-09-29');
    expect(await code(`delete from pos.end_of_day where branch_id = $1`, [p.branchId])).toBe('P0001');
  });
});
