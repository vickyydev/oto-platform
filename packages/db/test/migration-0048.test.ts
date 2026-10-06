import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-14b round 1 — the stock ledger (migration 0048), against live databases
 * built from the committed migrations.
 *
 *   - it builds from empty TWICE (two fresh databases), a second `migrate` on a
 *     built one is a no-op, and 0048 is journal entry 48 after 0047;
 *   - a level is never below zero, and one (place, item) pair has one level;
 *   - exactly one active sell point per branch, and only a rotation shelf;
 *   - one live stock item per branch, product and size;
 *   - the ledger is append-only (a trigger), its action id unique per operator,
 *     its signs and its shortfall held by checks — and the demo reset's purge
 *     flag is the one way a movement is deleted.
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

async function park(): Promise<{ operatorId: string; branchId: string }> {
  const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'Stock Op') returning id`);
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Stock Park', 'st-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  return { operatorId, branchId };
}

async function place(operatorId: string, branchId: string, name: string, type: string, sellPoint = false) {
  return one(
    `insert into pos.stock_location (id, operator_id, branch_id, name, type, sell_point)
     values (gen_random_uuid(), $1, $2, $3, $4, $5) returning id`,
    [operatorId, branchId, name, type, sellPoint],
  );
}

async function item(operatorId: string, branchId: string, name = 'Cap') {
  return one(
    `insert into pos.stock_item (id, operator_id, branch_id, name) values (gen_random_uuid(), $1, $2, $3) returning id`,
    [operatorId, branchId, name],
  );
}

describe('migration 0048 — the stock ledger', () => {
  it('is journal entry 48, after 0047', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e47 = journal.entries.find((e) => e.idx === 47)!;
    const e48 = journal.entries.find((e) => e.idx === 48)!;
    expect(e48.tag).toBe('0048_stock_ledger');
    expect(e48.when).toBeGreaterThan(e47.when);
  });

  it('builds from empty twice, and migrating a built database again is a no-op', async () => {
    const other = new pg.Client({ connectionString: second.url });
    await other.connect();
    try {
      const { rows } = await other.query(
        `select count(*)::int as n from information_schema.tables
          where table_schema in ('pos','analytics')
            and table_name in ('stock_item','stock_unit','stock_location','stock_level','stock_movement',
                               'stock_take','stock_take_line','purchase_order','purchase_order_line',
                               'stock_attention','fact_stock_daily')`,
      );
      expect(rows[0].n).toBe(11);
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

  it('a level is never below zero, and a place holds one level per item', async () => {
    const { operatorId, branchId } = await park();
    const foh = await place(operatorId, branchId, 'FOH', 'rotation', true);
    const cap = await item(operatorId, branchId);
    const level = (q: number) =>
      code(`insert into pos.stock_level (id, stock_location_id, stock_item_id, quantity) values (gen_random_uuid(), $1, $2, $3)`, [
        foh,
        cap,
        q,
      ]);
    expect(await level(-1)).toBe('23514');
    expect(await level(5)).toBeNull();
    expect(await level(6)).toBe('23505');
  });

  it('one active sell point per branch, and only a rotation shelf can be it', async () => {
    const { operatorId, branchId } = await park();
    await place(operatorId, branchId, 'FOH', 'rotation', true);
    expect(await code(`insert into pos.stock_location (id, operator_id, branch_id, name, type, sell_point) values (gen_random_uuid(), $1, $2, 'Counter 2', 'rotation', true)`, [operatorId, branchId])).toBe('23505');
    expect(await code(`insert into pos.stock_location (id, operator_id, branch_id, name, type, sell_point) values (gen_random_uuid(), $1, $2, 'Store', 'bulk', true)`, [operatorId, branchId])).toBe('23514');
    expect(await code(`insert into pos.stock_location (id, operator_id, branch_id, name, type) values (gen_random_uuid(), $1, $2, 'Attic', 'loft')`, [operatorId, branchId])).toBe('23514');
    // A retired sell point frees the role for its replacement.
    await client.query(`update pos.stock_location set active = false where branch_id = $1 and sell_point`, [branchId]);
    expect(await code(`insert into pos.stock_location (id, operator_id, branch_id, name, type, sell_point) values (gen_random_uuid(), $1, $2, 'Counter 2', 'rotation', true)`, [operatorId, branchId])).toBeNull();
  });

  it('one live stock item per branch, product and size', async () => {
    const { operatorId, branchId } = await park();
    const productId = await one(
      `insert into pos.product (id, operator_id, branch_id, name, kind) values (gen_random_uuid(), $1, $2, 'Socks', 'merch') returning id`,
      [operatorId, branchId],
    );
    const link = (variant: string | null) =>
      code(`insert into pos.stock_item (id, operator_id, branch_id, name, product_id, variant_id) values (gen_random_uuid(), $1, $2, 'Socks', $3, $4)`, [
        operatorId,
        branchId,
        productId,
        variant,
      ]);
    expect(await link('s')).toBeNull();
    expect(await link('s')).toBe('23505');
    expect(await link('m')).toBeNull();
    expect(await link(null)).toBeNull();
    expect(await link(null)).toBe('23505');
    expect(await code(`insert into pos.stock_item (id, operator_id, branch_id, name, variant_id) values (gen_random_uuid(), $1, $2, 'Orphan', 'x')`, [operatorId, branchId])).toBe('23514');
  });

  it('the ledger is append-only, keyed once per operator, and its signs hold', async () => {
    const { operatorId, branchId } = await park();
    const foh = await place(operatorId, branchId, 'FOH', 'rotation', true);
    const cap = await item(operatorId, branchId);
    const move = (kind: string, quantity: number, action: string, shortfall = 0) =>
      code(
        `insert into pos.stock_movement (id, operator_id, branch_id, stock_item_id, stock_location_id, kind, quantity, level_after, shortfall, action_id, business_date, occurred_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 0, $7, $8, current_date, now())`,
        [operatorId, branchId, cap, foh, kind, quantity, shortfall, action],
      );
    expect(await move('count', 5, 'a1')).toBeNull();
    expect(await move('count', 5, 'a1')).toBe('23505');
    expect(await move('sale', 2, 'a2')).toBe('23514');
    expect(await move('receive', -2, 'a3')).toBe('23514');
    expect(await move('sale', 0, 'a4')).toBe('23514');
    expect(await move('sale', 0, 'a5', 2)).toBeNull();
    expect(await move('receive', 3, 'a6', 1)).toBe('23514');
    expect(await move('teleport', 1, 'a7')).toBe('23514');
    expect(await code(`update pos.stock_movement set quantity = 9 where action_id = 'a1'`)).toBe('P0001');
    expect(await code(`delete from pos.stock_movement where action_id = 'a1'`)).toBe('P0001');
    await client.query('begin');
    await client.query(`select set_config('oto.stock_ledger_purge', 'on', true)`);
    expect(await code(`delete from pos.stock_movement where action_id = 'a1'`)).toBeNull();
    await client.query('commit');
    // The flag was local to that transaction: the trigger is back.
    expect(await code(`delete from pos.stock_movement where action_id = 'a5'`)).toBe('P0001');
  });
});
