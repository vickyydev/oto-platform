import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, factStockDaily, product, station, stockItem, stockLocation } from '@oto/db';
import { addDaysToIsoDate, businessDate, parseDayStart } from '@oto/shared';
import { RECEPTION, createTestContext, teardownAll, type TestContext } from './helpers';
import { applyMovements, runStockDailyJob, writeStockDailyFacts } from '../src/services/stock';

/**
 * S2-14b ROUND 4 — GATE, FINAL CHECK of the daily fact writer. The gate's own
 * construction beside recheck B (a late sale that EMPTIES a size):
 *
 *   1. a late receive that RAISES a size from nothing on an earlier day — the
 *      days from then on gain rows they never had;
 *   2. a late offline sale that changes a closing without emptying anything —
 *      nothing is deleted, the later stored days are rewritten;
 *
 * and after each job run: every stored day equals the ledger's own per-kind
 * arithmetic, opening(d) = closing(d − 1) along the chain, a day without a row
 * is one the ledger has nothing to say about, and a rerun writes nothing.
 */

let ctx: TestContext;
let operatorId: string;
let branchId: string;
let receptionId: string;
let boh: string;
let today: string;
let tshirt: string;
let bottle: string;

async function itemIdOf(code: string): Promise<string> {
  const rows = await ctx.db
    .select({ id: stockItem.id })
    .from(stockItem)
    .innerJoin(product, eq(product.id, stockItem.productId))
    .where(and(eq(stockItem.branchId, branchId), eq(product.code, code), isNull(stockItem.archivedAt)));
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

const day = (back: number) => addDaysToIsoDate(today, -back);

/** The ledger's own view of one size on one day, by kind, independent of stockDayFacts. */
async function ledgerDay(stockItemId: string, d: string) {
  const { rows } = await ctx.db.execute<Record<string, string>>(sql`
    select coalesce(sum(quantity) filter (where business_date < ${d}::date), 0)::bigint as opening,
           coalesce(sum(quantity) filter (where business_date <= ${d}::date), 0)::bigint as closing,
           coalesce(sum(quantity) filter (where business_date = ${d}::date and kind in ('sale','offline_sale')), 0)::bigint as sold,
           coalesce(sum(quantity) filter (where business_date = ${d}::date and kind = 'receive'), 0)::bigint as received,
           coalesce(sum(quantity) filter (where business_date = ${d}::date and kind = 'refund'), 0)::bigint as refunded,
           coalesce(sum(quantity) filter (where business_date = ${d}::date and kind = 'count'), 0)::bigint as counted,
           coalesce(sum(quantity) filter (where business_date = ${d}::date and kind = 'adjust'), 0)::bigint as adjusted,
           count(*) filter (where business_date = ${d}::date)::bigint as moves
      from pos.stock_movement where stock_item_id = ${stockItemId}::uuid`);
  return Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)])) as Record<
    'opening' | 'closing' | 'sold' | 'received' | 'refunded' | 'counted' | 'adjusted' | 'moves',
    number
  >;
}

/** Every ended day the job covers: a stored row equals the ledger; a missing row means the ledger is silent. */
async function expectStoredDaysAreTheLedger(stockItemId: string, cost: number): Promise<void> {
  const stored = new Map(
    (await ctx.db.select().from(factStockDaily).where(eq(factStockDaily.stockItemId, stockItemId))).map((f) => [f.businessDate, f]),
  );
  let prevClosing: number | null = null;
  for (let back = 7; back >= 1; back -= 1) {
    const d = day(back);
    const l = await ledgerDay(stockItemId, d);
    const row = stored.get(d);
    if (l.opening === 0 && l.moves === 0) {
      expect(row, `${d} should have no row`).toBeUndefined();
    } else {
      expect(row, `${d} should have a row`).toBeDefined();
      expect({
        d,
        opening: row!.opening,
        closing: row!.closing,
        sold: row!.sold,
        received: row!.received,
        refunded: row!.refunded,
        counted: row!.counted,
        adjusted: row!.adjusted,
        value: row!.valueSatang,
      }).toEqual({
        d,
        opening: l.opening,
        closing: l.closing,
        sold: l.sold,
        received: l.received,
        refunded: l.refunded,
        counted: l.counted,
        adjusted: l.adjusted,
        value: l.closing * cost,
      });
      expect(row!.opening + row!.sold + row!.refunded + row!.received + row!.adjusted + row!.counted).toBe(row!.closing);
    }
    const closing = row ? row.closing : 0;
    if (prevClosing !== null) expect(row ? row.opening : 0, `opening(${d}) = closing(${day(back + 1)})`).toBe(prevClosing);
    prevClosing = closing;
  }
}

beforeAll(async () => {
  ctx = await createTestContext();
  const [t1] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
  branchId = t1!.branchId;
  operatorId = t1!.operatorId;
  receptionId = (await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)))[0]!.id;
  const [b] = await ctx.db.select().from(stockLocation).where(and(eq(stockLocation.branchId, branchId), eq(stockLocation.name, 'BOH')));
  boh = b!.id;
  const { rows } = await ctx.db.execute<{ timezone: string; day_start: string }>(sql`
    select timezone, business_day_start::text as day_start from core.branch where id = ${branchId}::uuid`);
  today = businessDate(new Date(), rows[0]!.timezone, parseDayStart(rows[0]!.day_start));
  tshirt = await itemIdOf('MR-TSHIRT');
  bottle = await itemIdOf('MR-BOTTLE');
}, 240_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the daily fact follows every late movement, and a rerun writes nothing', () => {
  it('a quiet week: the seed opening is dated today, so the job has nothing to write', async () => {
    expect((await runStockDailyJob(ctx.db, new Date())).rowsWritten).toBe(0);
  });

  it('a receive six days back: six stored days, then a rerun writes nothing', async () => {
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: day(6), occurredAt: new Date(), actorAccountId: receptionId }, [
        { stockItemId: tshirt, stockLocationId: boh, kind: 'receive', quantity: 10, actionId: 'gate-r4-facts:tee-receive', unitCostSatang: 12_000 },
      ]),
    );
    expect((await runStockDailyJob(ctx.db, new Date())).rowsWritten).toBe(6);
    expect((await runStockDailyJob(ctx.db, new Date())).rowsWritten).toBe(0);
    await expectStoredDaysAreTheLedger(tshirt, 12_000);
    await expectStoredDaysAreTheLedger(bottle, 6_000);
  });

  it('late movements: a receive raises the bottle from 0 four days back; an offline sale takes the tee from 10 to 7 three days back', async () => {
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: day(4), occurredAt: new Date(), actorAccountId: receptionId }, [
        { stockItemId: bottle, stockLocationId: boh, kind: 'receive', quantity: 4, actionId: 'gate-r4-facts:bottle-late', unitCostSatang: 6_000 },
      ]),
    );
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: day(3), occurredAt: new Date(), actorAccountId: null, offline: true }, [
        { stockItemId: tshirt, stockLocationId: boh, kind: 'offline_sale', quantity: -3, actionId: 'gate-r4-facts:tee-late', unitCostSatang: 12_000 },
      ]),
    );
    const before = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(factStockDaily);
    // Bottle gains d4..d1 (4 inserts); the tee's d3, d2, d1 are rewritten (3 updates); nothing is deleted.
    expect((await runStockDailyJob(ctx.db, new Date())).rowsWritten).toBe(7);
    const after = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(factStockDaily);
    expect(after[0]!.n - before[0]!.n).toBe(4);
    await expectStoredDaysAreTheLedger(tshirt, 12_000);
    await expectStoredDaysAreTheLedger(bottle, 6_000);
    const tee = (await ctx.db.select().from(factStockDaily).where(eq(factStockDaily.stockItemId, tshirt))).sort((a, b) =>
      a.businessDate.localeCompare(b.businessDate),
    );
    expect(tee.map((f) => [f.businessDate, f.opening, f.closing])).toEqual([
      [day(6), 0, 10],
      [day(5), 10, 10],
      [day(4), 10, 10],
      [day(3), 10, 7],
      [day(2), 7, 7],
      [day(1), 7, 7],
    ]);
    const bot = (await ctx.db.select().from(factStockDaily).where(eq(factStockDaily.stockItemId, bottle))).sort((a, b) =>
      a.businessDate.localeCompare(b.businessDate),
    );
    expect(bot.map((f) => [f.businessDate, f.opening, f.received, f.closing])).toEqual([
      [day(4), 0, 4, 4],
      [day(3), 4, 0, 4],
      [day(2), 4, 0, 4],
      [day(1), 4, 0, 4],
    ]);
    // A rerun, by the job and by the writer alone, writes nothing.
    expect((await runStockDailyJob(ctx.db, new Date())).rowsWritten).toBe(0);
    for (let back = 7; back >= 1; back -= 1) {
      expect((await writeStockDailyFacts(ctx.db, branchId, day(back))).written).toBe(0);
    }
  });

  it('then the tee is emptied late on day 5 and refilled on day 2: deletions and inserts in one run, the chain still holds', async () => {
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: day(5), occurredAt: new Date(), actorAccountId: null, offline: true }, [
        { stockItemId: tshirt, stockLocationId: boh, kind: 'offline_sale', quantity: -7, actionId: 'gate-r4-facts:tee-empty', unitCostSatang: 12_000 },
      ]),
    );
    // The day-3 sale of 3 now meets 3 on the shelf (10 − 7); after it the tee holds 0.
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: day(2), occurredAt: new Date(), actorAccountId: receptionId }, [
        { stockItemId: tshirt, stockLocationId: boh, kind: 'receive', quantity: 2, actionId: 'gate-r4-facts:tee-refill', unitCostSatang: 12_000 },
      ]),
    );
    await runStockDailyJob(ctx.db, new Date());
    await expectStoredDaysAreTheLedger(tshirt, 12_000);
    const tee = (await ctx.db.select().from(factStockDaily).where(eq(factStockDaily.stockItemId, tshirt))).sort((a, b) =>
      a.businessDate.localeCompare(b.businessDate),
    );
    expect(tee.map((f) => [f.businessDate, f.opening, f.closing])).toEqual([
      [day(6), 0, 10],
      [day(5), 10, 3],
      [day(4), 3, 3],
      [day(3), 3, 0],
      [day(2), 0, 2],
      [day(1), 2, 2],
    ]);
    expect((await runStockDailyJob(ctx.db, new Date())).rowsWritten).toBe(0);
  });
});
