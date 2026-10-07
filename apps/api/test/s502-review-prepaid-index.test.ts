import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, box, product, sale, schema, session as sessionTable, station, ticketPackage, type Db } from '@oto/db';
import { seedDemoDay } from '@oto/db/seed';
import { newId } from '@oto/shared';
import { boxPrepaidFiled, prepaidHeldOnOpenOrders } from '../src/services/band-food';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-502 REVIEW — the prepaid stay index, against the SQL the platform
 * really sends.
 *
 * The builder's migration test plans a hand-written query on an empty table.
 * This one captures the statements `boxPrepaidFiled` (every box's check-in
 * copy) and `prepaidHeldOnOpenOrders` (every counter commit) actually emit,
 * gives `pos.sale_line` the shape of a park with history — thousands of food
 * lines, a handful naming a stay — and asks Postgres, with nothing forced,
 * how it would answer each. Then it drops the index inside a transaction and
 * shows both lookups answer exactly as they did with it.
 */

const INDEX = 'sale_line_prepaid_stay_idx';
const STAY_A = '018f0000-0000-7000-8000-00000000a502';
const STAY_B = '018f0000-0000-7000-8000-00000000b502';
const COPIES = 300;

let ctx: TestContext;
let pool: pg.Pool;
let operatorId: string;
let branchId: string;
let boxId: string;
let openSaleId: string;

/** The plan's index names and whether it read `sale_line` whole. */
function planOf(plan: unknown): { indexes: string[]; seqScans: string[] } {
  const indexes: string[] = [];
  const seqScans: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n['Index Name'] === 'string') indexes.push(n['Index Name']);
    if (n['Node Type'] === 'Seq Scan' && typeof n['Relation Name'] === 'string') seqScans.push(n['Relation Name']);
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(plan);
  return { indexes, seqScans };
}

/** The planner's total cost for the whole statement. */
function costOf(plan: unknown): number {
  return Number(((plan as Record<string, unknown>)['QUERY PLAN'] as Array<{ Plan: { 'Total Cost': number } }>)[0]!.Plan['Total Cost']);
}

/** The statements a lookup sends, captured on the way to the pool. */
async function captured(run: (db: Db) => Promise<unknown>): Promise<Array<{ query: string; params: unknown[] }>> {
  const out: Array<{ query: string; params: unknown[] }> = [];
  const logged = drizzle(pool, {
    schema,
    logger: { logQuery: (query: string, params: unknown[]) => out.push({ query, params }) },
  }) as unknown as Db;
  await run(logged);
  return out;
}

const lookups = {
  filed: (db: Db) => boxPrepaidFiled(db, operatorId, branchId, boxId, [STAY_A, STAY_B]),
  held: (db: Db) => prepaidHeldOnOpenOrders(db, operatorId, branchId, [STAY_A, STAY_B], null),
};

const quote = (column: string) => `"${column.replace(/"/g, '""')}"`;

beforeAll(async () => {
  ctx = await createTestContext();
  pool = (ctx.db as unknown as { $client: pg.Pool }).$client;
  // A day of play to copy lines from.
  await seedDemoDay(ctx.db);

  // An open order at the park the counter is at: committed, not yet paid.
  const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [staff] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
  const [seat] = await ctx.db.select({ branchId: sessionTable.branchId }).from(sessionTable).where(eq(sessionTable.accountId, staff!.id));
  branchId = seat!.branchId!;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.name, 'Reception Till 1')));
  operatorId = till!.operatorId;
  boxId = till!.boxId!;
  const picked = await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId: till!.id } });
  expect(picked.statusCode, picked.body).toBe(200);
  const [pkg] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId)).limit(1);
  openSaleId = newId();
  const committed = await ctx.app.inject({
    method: 'POST', url: '/sales', headers: { cookie },
    payload: { id: openSaleId, stationId: till!.id, finalise: false, lines: [{ id: newId(), packageId: pkg!.id, kids: 1, adults: 1 }] },
  });
  expect(committed.statusCode, committed.body).toBe(200);
  const [open] = await ctx.db.select({ status: sale.status }).from(sale).where(eq(sale.id, openSaleId));
  expect(['tendering', 'paid']).toContain(open!.status);
  expect(await ctx.db.select({ id: box.id }).from(box).where(eq(box.id, boxId))).toHaveLength(1);

  // A park with history: every line copied COPIES times as a food line that names no stay.
  const columns = (
    await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pos' and table_name = 'sale_line' and is_generated = 'NEVER'
        order by ordinal_position`,
    )
  ).rows.map((r) => r.column_name);
  const copyOf = (overrides: Record<string, string>) =>
    columns.map((c) => overrides[c] ?? `l.${quote(c)}`).join(', ');
  await pool.query(
    `insert into pos.sale_line (${columns.map(quote).join(', ')})
     select ${copyOf({ id: 'gen_random_uuid()', line_no: 'l.line_no + g * 1000', kind: `'fnb_item'`, payload: `(coalesce(l.payload, '{}'::jsonb) - 'prepaid')` })}
       from pos.sale_line l cross join generate_series(1, ${COPIES}) g`,
  );

  // A handful that do name a stay: three on the open order, two on closed sales.
  const [hotdog] = await ctx.db.select({ id: product.id }).from(product).where(eq(product.operatorId, operatorId)).limit(1);
  const prepaid = (stay: string) => `jsonb_build_object('prepaid', jsonb_build_object('checkinId', '${stay}', 'menuItemId', '${hotdog!.id}'))`;
  const [template] = (await pool.query<{ id: string }>(`select id from pos.sale_line where sale_id = $1 order by line_no limit 1`, [openSaleId])).rows;
  for (const [i, stay] of [STAY_A, STAY_A, STAY_B].entries()) {
    await pool.query(
      `insert into pos.sale_line (${columns.map(quote).join(', ')})
       select ${copyOf({ id: 'gen_random_uuid()', line_no: String(900 + i), kind: `'fnb_item'`, quantity: '1', product_id: `'${hotdog!.id}'`, payload: prepaid(stay) })}
         from pos.sale_line l where l.id = $1`,
      [template!.id],
    );
  }
  await pool.query(
    `insert into pos.sale_line (${columns.map(quote).join(', ')})
     select ${copyOf({ id: 'gen_random_uuid()', line_no: 'l.line_no + 500000', kind: `'fnb_item'`, payload: prepaid(STAY_B) })}
       from pos.sale_line l where l.sale_id <> $1 and l.line_no < 1000 order by l.id limit 2`,
    [openSaleId],
  );
  await pool.query('analyze pos.sale_line');
  await pool.query('analyze pos.sale');
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the prepaid stay index — SCRUM-502 review', () => {
  it('the park has history: thousands of food lines, five that name a stay', async () => {
    const { rows } = await pool.query<{ food: number; named: number }>(
      `select count(*) filter (where kind = 'fnb_item')::int as food,
              count(*) filter (where (payload -> 'prepaid' ->> 'checkinId') is not null)::int as named
         from pos.sale_line`,
    );
    expect(rows[0]!.food).toBeGreaterThan(2_000);
    expect(rows[0]!.named).toBe(5);
  });

  it.each(Object.keys(lookups) as Array<keyof typeof lookups>)(
    'the %s lookup, as the platform sends it, is answered from the index without reading sale_line whole',
    async (name) => {
      const statements = await captured(lookups[name]);
      expect(statements).toHaveLength(1);
      const { query, params } = statements[0]!;
      expect(query).toContain(`("pos"."sale_line"."payload" -> 'prepaid' ->> 'checkinId') in (`);
      const { rows } = await pool.query(`explain (format json) ${query}`, params);
      const plan = planOf(rows[0]);
      expect(plan.indexes, JSON.stringify(rows[0])).toContain(INDEX);
      expect(plan.seqScans).not.toContain('sale_line');

      // Without the index the same statement can only reach the lines through
      // their sales, every food line of them read and filtered: dearer by the
      // planner's own reckoning.
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`drop index pos.${INDEX}`);
        const bare = (await client.query(`explain (format json) ${query}`, params)).rows[0];
        expect(planOf(bare).indexes).not.toContain(INDEX);
        expect(costOf(rows[0]), `${JSON.stringify(rows[0])}\n${JSON.stringify(bare)}`).toBeLessThan(costOf(bare));
      } finally {
        await client.query('rollback');
        client.release();
      }
    },
  );

  it('both lookups answer exactly as they did before the index', async () => {
    const withIndex = { filed: await lookups.filed(ctx.db), held: await lookups.held(ctx.db) };
    // The open order holds two of A's and one of B's; no box filed any of them.
    const hotdogKey = (stay: string) => [...withIndex.held.keys()].find((k) => k.startsWith(`${stay}|`));
    expect(withIndex.held.get(hotdogKey(STAY_A)!)).toEqual({ qty: 2, saleIds: [openSaleId] });
    expect(withIndex.held.get(hotdogKey(STAY_B)!)).toEqual({ qty: 1, saleIds: [openSaleId] });
    expect(withIndex.filed.size).toBe(0);

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`drop index pos.${INDEX}`);
      const bare = drizzle(client, { schema }) as unknown as Db;
      const withoutIndex = { filed: await lookups.filed(bare), held: await lookups.held(bare) };
      expect([...withoutIndex.held.entries()]).toEqual([...withIndex.held.entries()]);
      expect([...withoutIndex.filed.entries()]).toEqual([...withIndex.filed.entries()]);
    } finally {
      await client.query('rollback');
      client.release();
    }
    // The rollback kept the index.
    const { rows } = await pool.query(`select 1 from pg_indexes where schemaname = 'pos' and indexname = $1`, [INDEX]);
    expect(rows).toHaveLength(1);
    // And excluding the order being committed still excludes it.
    expect((await prepaidHeldOnOpenOrders(ctx.db, operatorId, branchId, [STAY_A, STAY_B], openSaleId)).size).toBe(0);
    expect(await ctx.db.select({ id: sale.id }).from(sale).where(inArray(sale.id, [openSaleId]))).toHaveLength(1);
  });
});
