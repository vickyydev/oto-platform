import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-15a round 1 — migration 0052 (cash sessions and the End of Day), against
 * live databases built from the committed migrations.
 *
 *   - it builds from empty TWICE (two fresh databases), a second `migrate` on a
 *     built one is a no-op, and 0052 is journal entry 52 after 0051;
 *   - refund.business_date is BACKFILLED in the branch's own business day for a
 *     refund written before 0052 (migrated to 0051, a row written, then 0052);
 *   - a writer that does not say gets the same answer from the trigger;
 *   - one open session per station; a closed session carries its whole close
 *     and an out-of-tolerance close a note;
 *   - the movement ledger is append-only, action-keyed, and a paid-out's
 *     approver / a safe drop's witness is never the actor.
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

async function one<T = string>(c: pg.Client, text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await c.query(text, values);
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
  stationId: string;
  a: string;
  b: string;
}

async function park(c: pg.Client = client): Promise<Park> {
  const operatorId = await one(c, `insert into core.operator (id, name) values (gen_random_uuid(), 'Cash Op') returning id`);
  const branchId = await one(
    c,
    `insert into core.branch (id, operator_id, name, code, timezone, business_day_start)
     values (gen_random_uuid(), $1, 'Cash Park', 'cash-' || substr(md5(random()::text), 1, 8), 'Asia/Bangkok', '05:00')
     returning id`,
    [operatorId],
  );
  const stationId = await one(
    c,
    `insert into core.station (id, operator_id, branch_id, name) values (gen_random_uuid(), $1, $2, 'Till ' || substr(md5(random()::text), 1, 6)) returning id`,
    [operatorId, branchId],
  );
  const acct = () =>
    one(
      c,
      `insert into core.account (id, operator_id, phone, status) values (gen_random_uuid(), $1, '+6681' || lpad((floor(random()*10000000))::text, 7, '0'), 'active') returning id`,
      [operatorId],
    );
  return { operatorId, branchId, stationId, a: await acct(), b: await acct() };
}

async function openSession(p: Park): Promise<string> {
  return one(
    client,
    `insert into pos.cash_session (id, operator_id, branch_id, station_id, business_date, opened_by_account_id, opening_float_satang)
     values (gen_random_uuid(), $1, $2, $3, '2026-10-02', $4, 600000) returning id`,
    [p.operatorId, p.branchId, p.stationId, p.a],
  );
}

describe('migration 0052 — cash sessions and the End of Day', () => {
  it('is journal entry 52, after 0051, with a later timestamp', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const e51 = journal.entries.find((e) => e.idx === 51)!;
    const e52 = journal.entries.find((e) => e.idx === 52)!;
    expect(e52.tag).toBe('0052_cash_sessions');
    expect(e52.when).toBeGreaterThan(e51.when);
    expect(journal.entries.at(-1)!.idx).toBe(52);
  });

  it('builds from empty twice, and a second migrate is a no-op', async () => {
    for (const db of [first, second]) {
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        const tables = await c.query(
          `select table_schema || '.' || table_name as t from information_schema.tables
            where (table_schema, table_name) in (('pos','cash_session'),('pos','cash_movement'),('pos','end_of_day'),
              ('pos','recon_line'),('pos','eod_correction'),('pos','settlement_batch'),('pos','settlement_line'),
              ('analytics','fact_cash_daily'))`,
        );
        expect(tables.rows).toHaveLength(8);
        expect(
          await one(c, `select is_nullable from information_schema.columns where table_schema='pos' and table_name='refund' and column_name='business_date'`),
        ).toBe('NO');
      } finally {
        await c.end();
      }
    }
    const before = await one<string>(client, `select count(*)::text from drizzle.__drizzle_migrations`);
    execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL: first.url },
      stdio: 'pipe',
    });
    expect(await one<string>(client, `select count(*)::text from drizzle.__drizzle_migrations`)).toBe(before);
  });

  it('backfills refund.business_date from created_at in the branch business day', async () => {
    // A database migrated to 0051, a refund written there, then 0052 applied.
    const built = await createEmptyDatabase();
    const folder = mkdtempSync(join(tmpdir(), 'oto-0051-'));
    try {
      cpSync(MIGRATIONS, folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number }> };
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 51) }));
      const c = new pg.Client({ connectionString: built.url });
      await c.connect();
      try {
        await migrate(drizzle(c), { migrationsFolder: folder });
        const p = await park(c);
        // Only the refund row's own columns matter to the backfill: the foreign
        // rows it names are not what is under test, so their triggers are off.
        await c.query(`set session_replication_role = replica`);
        const insert = (at: string) =>
          one(
            c,
            `insert into pos.refund (id, operator_id, branch_id, sale_id, station_id, number, amount_satang, mode, reason,
                                     approved_by_account_id, created_by_account_id, created_at, updated_at)
             values (gen_random_uuid(), $1, $2, gen_random_uuid(), $3, 'T1-R-' || substr(md5(random()::text), 1, 6), 100, 'custom',
                     'test', $4, $4, $5, $5) returning id`,
            [p.operatorId, p.branchId, p.stationId, p.a, at],
          );
        // 03:00 Bangkok on the 2nd is still the 1st's trading day (05:00 start);
        // 06:00 Bangkok is the 2nd. 23:30 UTC on the 1st is 06:30 on the 2nd.
        const early = await insert('2026-10-01T20:00:00Z');
        const late = await insert('2026-10-01T23:30:00Z');
        await c.query(`set session_replication_role = origin`);
        await migrate(drizzle(c), { migrationsFolder: MIGRATIONS });
        const dateOf = (id: string) => one(c, `select business_date::text from pos.refund where id = $1`, [id]);
        expect(await dateOf(early)).toBe('2026-10-01');
        expect(await dateOf(late)).toBe('2026-10-02');
      } finally {
        await c.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await built.drop();
    }
  });

  it('a writer that does not name the business date gets the branch day from the trigger', async () => {
    const p = await park();
    // Replica mode switches the foreign keys off for this throwaway row — and
    // ordinary triggers with them, so the one under test is told to fire anyway.
    await client.query(`alter table pos.refund enable always trigger refund_business_date_default`);
    await client.query(`set session_replication_role = replica`);
    const id = await one(
      client,
      `insert into pos.refund (id, operator_id, branch_id, sale_id, station_id, number, amount_satang, mode, reason,
                               approved_by_account_id, created_by_account_id, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, gen_random_uuid(), $3, 'T9-R-1', 100, 'custom', 'test', $4, $4,
               '2026-10-01T21:59:00Z', '2026-10-01T21:59:00Z') returning id`,
      [p.operatorId, p.branchId, p.stationId, p.a],
    );
    await client.query(`set session_replication_role = origin`);
    // 04:59 in Bangkok: the previous trading day.
    expect(await one(client, `select business_date::text from pos.refund where id = $1`, [id])).toBe('2026-10-01');
  });

  it('the branch gains the drawer settings with the prototype defaults (฿6,000 float, ฿1 tolerance)', async () => {
    const p = await park();
    const row = (await client.query(`select cash_default_float_satang::int f, cash_tolerance_satang::int t from core.branch where id = $1`, [p.branchId])).rows[0];
    expect(row).toEqual({ f: 600_000, t: 100 });
    expect(await code(`update core.branch set cash_tolerance_satang = -1 where id = $1`, [p.branchId])).toBe('23514');
  });

  it('one open session per station; a second drawer at another station is fine', async () => {
    const p = await park();
    await openSession(p);
    expect(await code(
      `insert into pos.cash_session (id, operator_id, branch_id, station_id, business_date, opened_by_account_id, opening_float_satang)
       values (gen_random_uuid(), $1, $2, $3, '2026-10-02', $4, 0)`,
      [p.operatorId, p.branchId, p.stationId, p.b],
    )).toBe('23505');
  });

  it('a closed session carries its whole close, and an out-of-tolerance close needs a note', async () => {
    const p = await park();
    const id = await openSession(p);
    const close = (counted: number, expected: number, notes: string | null) =>
      code(
        `update pos.cash_session set status = 'closed', closed_at = now(), closed_by_account_id = $2,
                counted_satang = $3, expected_satang = $4, variance_satang = $3::bigint - $4::bigint,
                tolerance_satang = 100, float_left_satang = 0, notes = $5,
                signed_off_by_account_id = $2, signed_off_at = now()
          where id = $1`,
        [id, p.a, counted, expected, notes],
      );
    expect(await code(`update pos.cash_session set status = 'closed' where id = $1`, [id])).toBe('23514');
    expect(await close(700_000, 600_000, null)).toBe('23514');
    expect(await close(700_000, 600_000, '  ')).toBe('23514');
    expect(await close(600_050, 600_000, null)).toBeNull();
  });

  it('the movement ledger is append-only, action-keyed, and the second person is never the actor', async () => {
    const p = await park();
    const sessionId = await openSession(p);
    const move = (kind: string, actionId: string, extra: { approver?: string; witness?: string; reason?: string | null } = {}) =>
      code(
        `insert into pos.cash_movement (id, operator_id, branch_id, session_id, station_id, kind, amount_satang, reason,
                                        actor_account_id, approver_account_id, witness_account_id, business_date, action_id)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, 5000, $6, $7, $8, $9, '2026-10-02', $10)`,
        [p.operatorId, p.branchId, sessionId, p.stationId, kind, extra.reason === undefined ? 'ice' : extra.reason, p.a,
          extra.approver ?? null, extra.witness ?? null, actionId],
      );
    expect(await move('paid_out', 'a1')).toBe('23514');
    expect(await move('paid_out', 'a2', { approver: p.a })).toBe('23514');
    expect(await move('paid_out', 'a3', { approver: p.b })).toBeNull();
    expect(await move('paid_out', 'a3', { approver: p.b })).toBe('23505');
    expect(await move('safe_drop', 'a4', { witness: p.a })).toBe('23514');
    expect(await move('safe_drop', 'a5', { witness: p.b })).toBeNull();
    expect(await move('top_up', 'a6', { reason: '' })).toBe('23514');
    expect(await move('refund_out', 'a7')).toBe('23514');
    expect(await code(`update pos.cash_movement set amount_satang = 1 where session_id = $1`, [sessionId])).toBe('P0001');
    expect(await code(`delete from pos.cash_movement where session_id = $1`, [sessionId])).toBe('P0001');
  });
});

/** A database with nothing applied, for the partial-migration test. */
async function createEmptyDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const server = first.url.replace(/\/[^/]*$/, '/postgres');
  const name = `oto_cash_r1_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return {
    url: server.replace(/\/[^/]*$/, `/${name}`),
    drop: async () => {
      const c = new pg.Client({ connectionString: server });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
