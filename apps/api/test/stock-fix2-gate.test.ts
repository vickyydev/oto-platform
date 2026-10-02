import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, branch, product, stockItem, stockTakeLine } from '@oto/db';
import { businessDate, parseDayStart, type StockReports } from '@oto/shared';
import { commitStockTake, receiveStock, type StockActor } from '../src/services/stock';
import { ADMIN, BRANCH_MANAGER, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * GATE (re-check) — the stock fix round's second pass, F1 attacked under
 * concurrency.
 *
 * The commit decides "is this place at its opening?" (`placeRecordStarts`)
 * BEFORE it locks the levels it counts against (`lockLevels`). Movement writers
 * (a delivery, a transfer, a sale) do not take the branch's count lock, so a
 * delivery into a new place that is still uncommitted when the count asks is
 * invisible to the question — and then, once it commits, the count's
 * `select … for update` returns the delivered level as the expected figure.
 * The line is stored as the place's opening (unflagged, "Opening count") with
 * an expected figure the ledger put there: a genuine shortfall against a
 * delivery is hidden from Discrepancies and Shrinkage.
 *
 * The commit's answer and its expected figure must come from the same point in
 * the serial order: the delivery committed first and the count read its level,
 * so the place had a record and the count is ordinary.
 *
 * THE INVARIANT after every flow: each level is exactly the sum of its movements.
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let operatorId: string;
let branchId: string;
let managerId: string;
let today: string;
const productIds = new Map<string, string>();

const stockUrl = (path: string) => `/branches/${branchId}/stock${path}`;

async function itemIdOf(code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: stockItem.id })
    .from(stockItem)
    .where(
      and(
        eq(stockItem.productId, productIds.get(code)!),
        eq(stockItem.branchId, branchId),
        isNull(stockItem.archivedAt),
        sql`${stockItem.variantId} is null`,
      ),
    );
  return row!.id;
}

async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.stock_item_id, l.stock_location_id, l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  const off = (rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved || r.quantity < 0);
  expect(off).toEqual([]);
}

/** Wait until some backend of this database is blocked on a row/tuple lock. */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
    if (rows[0]!.n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the count never waited on the delivery’s lock');
}

const actor = (): StockActor => ({ operatorId, branchId, accountId: managerId, requestId: null, stationId: null });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const hkt = (await ctx.db.select().from(branch)).find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  today = businessDate(new Date(), hkt.timezone, parseDayStart(hkt.businessDayStart));
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code && (p.branchId === branchId || p.branchId === null)) productIds.set(p.code, p.id);
  }
  managerId = (await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone)))[0]!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('GATE F1 — a delivery committing while a new place’s first count waits on its level', () => {
  it('the count reads the delivered 10 as expected, so finding 6 is a flagged loss of 4 — not an opening', async () => {
    const plush = await itemIdOf('MR-PLUSH');
    const res = await ctx.app.inject({
      method: 'POST',
      url: stockUrl('/locations'),
      headers: { cookie: admin },
      payload: { name: 'Gate Race Dock', type: 'rotation' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const dock = (res.json() as { id: string }).id;

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let delivered!: () => void;
    const deliveredInTx = new Promise<void>((r) => (delivered = r));
    // The delivery: written, not yet committed.
    const delivery = ctx.db.transaction(async (tx) => {
      await receiveStock(
        tx,
        actor(),
        { stockItemId: plush, locationId: dock, quantity: 10, reason: 'Delivery from the supplier' },
        new Date(),
      );
      delivered();
      await gate;
    });
    await deliveredInTx;
    // The count starts while the delivery is open, and waits on its level row.
    const counting = ctx.db.transaction((tx) =>
      commitStockTake(tx, actor(), { lines: [{ stockItemId: plush, locationId: dock, countedQuantity: 6 }] }, new Date()),
    );
    await waitForLockWait();
    release();
    await delivery;
    const take = await counting;

    // The level the count was measured against is the delivered 10 …
    expect(take.lines[0]).toMatchObject({ expectedQuantity: 10, countedQuantity: 6, difference: -4 });
    // … so the place already had a record: an ordinary, flagged count.
    expect(take.lines[0]).toMatchObject({ opening: false, flagged: true });
    const stored = await ctx.db
      .select({ opening: stockTakeLine.opening })
      .from(stockTakeLine)
      .where(eq(stockTakeLine.stockTakeId, take.id));
    expect(stored.map((r) => r.opening)).toEqual([false]);

    const rep = await ctx.app.inject({
      method: 'GET',
      url: stockUrl(`/reports?from=${today}&to=${today}`),
      headers: { cookie: manager },
    });
    expect(rep.statusCode, rep.body).toBe(200);
    const reports = rep.json() as StockReports;
    expect(reports.discrepancies.filter((d) => d.locationId === dock).map((d) => d.difference)).toEqual([-4]);
    await expectLedgerAddsUp();
  });
});
