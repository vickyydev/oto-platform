import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  factStockDaily,
  product,
  stockAttention,
  stockItem,
  stockLocation,
  stockMovement,
  station,
} from '@oto/db';
import { platformSync } from '@oto/db/seed';
import { addDaysToIsoDate, businessDate, newId, parseDayStart, type StockReports } from '@oto/shared';
import { refundSale } from '../src/services/refunds';
import { finaliseSale } from '../src/services/sale';
import {
  addToPurchaseOrders,
  adjustStock,
  applyMovements,
  commitStockTake,
  markPurchaseOrderOrdered,
  receivePurchaseOrderLine,
  runStockDailyJob,
  syncStockAttention,
  transferStock,
  writeStockDailyFacts,
  type StockActor,
} from '../src/services/stock';
import {
  ADMIN,
  BRANCH_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-14b ROUND 4 — reports, trend and the queued handovers (plan
 * docs/progress/plans/stock/PLAN.md §2.5, §4 OD-27), through the real routes
 * and services, the database read back after every flow.
 *
 * THE FIXTURES are the seeded opening count (the prototype's figures, OD-S2):
 *   Oto T-Shirt     BOH 28, FOH 12, cost ฿120 — the scripted week's item, nobody else's
 *   Oto Cap         BOH 18, FOH 7, par FOH 10 — the attention read
 *   Water Bottle    BOH 22, FOH 8, reorder 20, lead 10 days — the trend rule
 *   Sticker Pack    BOH 60, FOH 20 — a branch with no live place
 *   Old Lanyard     BOH 4 — a removed size on an order
 *
 * TIME. `base` is the real clock at start; day n is base + n days, and its
 * business date is today + n at the branch. The scripted week runs today to
 * today + 6 through the services with those clocks; sales go through the
 * routes, today.
 */

const DAY = 86_400_000;

let ctx: TestContext;
let reception: string;
let manager: string;
let admin: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let receptionId: string;
let managerId: string;
let base: number;
let today: string;
const productIds = new Map<string, string>();
const places = new Map<string, string>();

const at = (n: number) => new Date(base + n * DAY);
const dayOf = (n: number) => addDaysToIsoDate(today, n);

const itemLine = (code: string, quantity: number, variantId?: string) => ({
  id: newId(),
  productId: productIds.get(code)!,
  quantity,
  ...(variantId ? { variant: { variantId, variantLabel: variantId.toUpperCase() } } : {}),
});

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Ring up and close a sale at the counter, as the till does. */
async function sell(items: unknown[]): Promise<string> {
  const id = newId();
  const committed = await call('POST', '/sales', reception, { stationId, id, items });
  expect(committed.statusCode, committed.body).toBe(200);
  const closed = await call('POST', `/sales/${id}/finalise`, reception);
  expect(closed.statusCode, closed.body).toBe(200);
  return id;
}

async function itemIdOf(code: string, variantId: string | null = null): Promise<string> {
  const [row] = await ctx.db
    .select({ id: stockItem.id })
    .from(stockItem)
    .where(
      and(
        eq(stockItem.productId, productIds.get(code)!),
        eq(stockItem.branchId, branchId),
        isNull(stockItem.archivedAt),
        variantId === null ? sql`${stockItem.variantId} is null` : eq(stockItem.variantId, variantId),
      ),
    );
  return row!.id;
}

/** What one size holds, by place name. */
async function heldBy(stockItemId: string): Promise<Record<string, number>> {
  const { rows } = await ctx.db.execute<{ place: string; quantity: number }>(sql`
    select loc.name as place, l.quantity from pos.stock_level l
      join pos.stock_location loc on loc.id = l.stock_location_id
     where l.stock_item_id = ${stockItemId}::uuid`);
  return Object.fromEntries(rows.map((r) => [r.place, r.quantity]));
}

/** THE INVARIANT: every level is the sum of its movements, and none is below zero. */
async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.stock_item_id, l.stock_location_id, l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  const off = (rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved || r.quantity < 0);
  expect(off).toEqual([]);
}

/** A hand sum over the ledger, for one item and kinds, over business dates. */
async function ledgerSum(
  stockItemId: string,
  kinds: string[],
  from: string,
  to: string,
  expr: 'quantity' | 'sold' = 'quantity',
): Promise<number> {
  const value = expr === 'sold' ? sql.raw('-m.quantity + m.shortfall') : sql.raw('m.quantity');
  const { rows } = await ctx.db.execute<{ total: string | number | null }>(sql`
    select coalesce(sum(${value}), 0)::bigint as total from pos.stock_movement m
     where m.stock_item_id = ${stockItemId}::uuid
       and m.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
       and m.business_date between ${from}::date and ${to}::date`);
  return Number(rows[0]?.total ?? 0);
}

const actor = (): StockActor => ({ operatorId, branchId, accountId: managerId, requestId: null, stationId: null });

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  base = Date.now();
  today = businessDate(new Date(base), hkt.timezone, parseDayStart(hkt.businessDayStart));
  const stations = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code && (p.branchId === branchId || p.branchId === null)) productIds.set(p.code, p.id);
  }
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) {
    places.set(l.name, l.id);
  }
  const [r] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionId = r!.id;
  const [m] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  managerId = m!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Q4 --------------------------------------------------------------------------------

describe('Q4 — the attention read writes nothing; the movement paths keep the rows', () => {
  it('a sale that takes the cap below par raises its row in the sale’s own transaction — no read needed', async () => {
    const cap = await itemIdOf('MR-CAP');
    const dedupe = `low_stock:${branchId}:${productIds.get('MR-CAP')}`;
    const openRow = async () =>
      (
        await ctx.db
          .select()
          .from(stockAttention)
          .where(and(eq(stockAttention.dedupeKey, dedupe), isNull(stockAttention.resolvedAt)))
      )[0];
    // The seed writes levels and no attention: nothing has re-read the cap yet.
    expect(await openRow()).toBeUndefined();
    await sell([itemLine('MR-CAP', 1)]);
    expect(await heldBy(cap)).toMatchObject({ FOH: 6, BOH: 18 });
    expect(await openRow()).toMatchObject({ kind: 'low_stock', rule: 'Below par at FOH', stockItemId: cap });
    await expectLedgerAddsUp();
  });

  it('GET /stock/attention answers the rows and changes none of them', async () => {
    const snapshot = async () =>
      (await ctx.db.execute(sql`select id, kind, rule, quantity, summary, occurrences, resolved_at, updated_at
                                  from pos.stock_attention order by id`)).rows;
    const before = await snapshot();
    const audits = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n;
    const res = await call('GET', `/branches/${branchId}/stock/attention`, reception);
    expect(res.statusCode).toBe(200);
    const listed = (res.json() as { attention: Array<{ rule: string | null }> }).attention;
    expect(listed.some((a) => a.rule === 'Below par at FOH')).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n).toBe(audits);
  });

  it('a refund that puts the cap back at par resolves its row, in the refund’s transaction', async () => {
    // FOH 6: four from the back brings it to its par of 10 (the transfer's own
    // re-read resolves the row); a sale of one takes it under again, and that
    // sale's refund puts it back.
    const cap = await itemIdOf('MR-CAP');
    await ctx.db.transaction((tx) =>
      transferStock(tx, actor(), { fromLocationId: places.get('BOH')!, toLocationId: places.get('FOH')!, lines: [{ stockItemId: cap, quantity: 4 }] }, new Date()),
    );
    const dedupe = `low_stock:${branchId}:${productIds.get('MR-CAP')}`;
    const open = () =>
      ctx.db.select().from(stockAttention).where(and(eq(stockAttention.dedupeKey, dedupe), isNull(stockAttention.resolvedAt)));
    expect(await open()).toEqual([]); // FOH 10: at par, the transfer resolved it
    const saleId = await sell([itemLine('MR-CAP', 1)]);
    expect(await open()).toHaveLength(1); // FOH 9: below par again, raised by the sale
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: receptionId, operatorId, stationId, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        saleId,
        { mode: 'whole', reason: 'Changed mind' },
      ),
    );
    expect(await open()).toEqual([]); // FOH 10 again: resolved by the restock itself
    await expectLedgerAddsUp();
  });
});

// --- Q5 --------------------------------------------------------------------------------

describe('Q5 — a size removed under an order is refused in the counter’s words', () => {
  it('STOCK_ITEM_REMOVED, "it cannot be ordered" — not a 404', async () => {
    const lanyard = await itemIdOf('MR-LANYARD');
    // The removal won the race: the size is archived when the add reads it.
    await ctx.db.update(stockItem).set({ archivedAt: new Date(), active: false }).where(eq(stockItem.id, lanyard));
    const res = await call('POST', `/branches/${branchId}/stock/purchase-orders/lines`, manager, {
      lines: [{ stockItemId: lanyard, quantity: 6 }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'STOCK_ITEM_REMOVED',
      message: 'Old Lanyard (retired) was removed from stock — it cannot be ordered; add the size back under Inventory first',
    });
    // Nothing was ordered.
    const { rows } = await ctx.db.execute(sql`select 1 from pos.purchase_order_line where stock_item_id = ${lanyard}::uuid`);
    expect(rows).toEqual([]);
  });
});

// --- The scripted week -------------------------------------------------------------------

describe('a scripted week of T-shirts: every report equals the hand-summed movements', () => {
  let shirt: string;
  let orderId: string;
  let lineId: string;
  let reports: StockReports;

  beforeAll(async () => {
    shirt = await itemIdOf('MR-TSHIRT');
    // Day 0, today: the opening (seed) — BOH 28, FOH 12 — then two sales; the
    // second is refunded whole and put back.
    await sell([itemLine('MR-TSHIRT', 5)]);
    const two = await sell([itemLine('MR-TSHIRT', 2)]);
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: receptionId, operatorId, stationId, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        two,
        { mode: 'whole', reason: 'Wrong size' },
      ),
    );
    // Day 1: 48 on order to Bangkok Merch Co., placed, 30 in at BOH.
    const orders = await ctx.db.transaction((tx) =>
      addToPurchaseOrders(tx, actor(), { lines: [{ stockItemId: shirt, quantity: 48 }] }, at(1)),
    );
    orderId = orders[0]!.id;
    lineId = orders[0]!.lines.find((l) => l.stockItemId === shirt)!.id;
    await ctx.db.transaction((tx) => markPurchaseOrderOrdered(tx, actor(), orderId, {}, at(1)));
    await ctx.db.transaction((tx) =>
      receivePurchaseOrderLine(tx, actor(), orderId, lineId, { quantity: 30, locationId: places.get('BOH')! }, at(1)),
    );
    // Day 2: 10 to the counter.
    await ctx.db.transaction((tx) =>
      transferStock(tx, actor(), { fromLocationId: places.get('BOH')!, toLocationId: places.get('FOH')!, lines: [{ stockItemId: shirt, quantity: 10 }] }, at(2)),
    );
    // Day 3: a count — the counter two short, back of house one over.
    const held = await heldBy(shirt);
    await ctx.db.transaction((tx) =>
      commitStockTake(
        tx,
        actor(),
        {
          lines: [
            { stockItemId: shirt, locationId: places.get('FOH')!, countedQuantity: held.FOH! - 2 },
            { stockItemId: shirt, locationId: places.get('BOH')!, countedQuantity: held.BOH! + 1 },
          ],
        },
        at(3),
      ),
    );
    // Day 4: one damaged, written off at BOH.
    await ctx.db.transaction((tx) =>
      adjustStock(tx, actor(), { stockItemId: shirt, locationId: places.get('BOH')!, delta: -1, reason: 'Damaged' }, at(4)),
    );
    // Day 5: the other 18 arrive; the order closes.
    await ctx.db.transaction((tx) =>
      receivePurchaseOrderLine(tx, actor(), orderId, lineId, { quantity: 18, locationId: places.get('BOH')! }, at(5)),
    );
    const res = await call('GET', `/branches/${branchId}/stock/reports?from=${dayOf(0)}&to=${dayOf(6)}`, manager);
    expect(res.statusCode, res.body).toBe(200);
    reports = res.json() as StockReports;
  });

  it('the ledger adds up and the T-shirt holds 81: 40 − 7 + 2 + 30 − 1 − 1 + 18', async () => {
    await expectLedgerAddsUp();
    const held = await heldBy(shirt);
    expect(Object.values(held).reduce((a, b) => a + b, 0)).toBe(81);
  });

  it('Usage: sold 7, refunded 2, net 5 — the sale and refund movements, hand-summed', async () => {
    const row = reports.usage.find((u) => u.stockItemId === shirt)!;
    expect(row).toMatchObject({ name: 'Oto T-Shirt', sold: 7, refunded: 2, net: 5, soldOffline: 0, costSatang: 5 * 12_000 });
    expect(row.sold).toBe(await ledgerSum(shirt, ['sale', 'offline_sale'], dayOf(0), dayOf(6), 'sold'));
    expect(row.refunded).toBe(await ledgerSum(shirt, ['refund'], dayOf(0), dayOf(6)));
  });

  it('Shrinkage: counted −2 and +1, one write-off — total −2, ฿240 lost at cost', async () => {
    const row = reports.shrinkage.find((s) => s.stockItemId === shirt)!;
    expect(row).toMatchObject({ countVariance: -1, countedShort: 1, adjustedDown: -1, total: -2, lossSatang: 24_000, costMissing: false });
    // The opening count (day 0, +40) is a starting figure, not a variance.
    const { rows } = await ctx.db.execute<{ total: string }>(sql`
      select coalesce(sum(m.quantity), 0)::bigint as total from pos.stock_movement m
        join pos.stock_take_line l on l.id = m.stock_take_line_id join pos.stock_take t on t.id = l.stock_take_id
       where m.stock_item_id = ${shirt}::uuid and m.kind = 'count' and not t.opening`);
    expect(row.countVariance).toBe(Number(rows[0]!.total));
    expect(row.adjustedDown).toBe(await ledgerSum(shirt, ['adjust'], dayOf(0), dayOf(6)));
  });

  it('Discrepancies: the two counted shelves, from the take — each difference its count movement', async () => {
    const rows = reports.discrepancies.filter((d) => d.stockItemId === shirt);
    expect(rows.map((r) => [r.locationName, r.difference, r.flagged, r.businessDate]).sort()).toEqual([
      ['BOH', 1, false, dayOf(3)],
      ['FOH', -2, false, dayOf(3)],
    ]);
    expect(rows.reduce((n, r) => n + r.difference, 0)).toBe(await ledgerSum(shirt, ['count'], dayOf(1), dayOf(6)));
  });

  it('Purchases: one order, 48 ordered, 48 received — the receipts in the ledger, at the frozen cost', async () => {
    const order = reports.purchases.find((o) => o.id === orderId)!;
    expect(order).toMatchObject({ supplierName: 'Bangkok Merch Co.', state: 'received' });
    expect(order.lines).toEqual([
      expect.objectContaining({ stockItemId: shirt, orderedQuantity: 48, receivedQuantity: 48, receivedInLedger: 48, unitCostSatang: 12_000, receivedCostSatang: 48 * 12_000 }),
    ]);
    expect(await ledgerSum(shirt, ['receive'], dayOf(0), dayOf(6))).toBe(48);
  });

  it('Value: 81 on hand × ฿120 = ฿9,720; a size with no cost is flagged, not valued at nothing', async () => {
    // The value is "now", whatever the range.
    const row = reports.value.find((v) => v.stockItemId === shirt)!;
    expect(row).toMatchObject({ onHand: 81, unitCostSatang: 12_000, valueSatang: 972_000, noCostSet: false });
    expect(row.onHand).toBe(await ledgerSum(shirt, ['sale', 'offline_sale', 'refund', 'receive', 'transfer_out', 'transfer_in', 'adjust', 'count'], '2000-01-01', '2999-12-31'));
    const locker = reports.value.find((v) => v.name === 'Locker Rental')!;
    expect(locker).toMatchObject({ unitCostSatang: null, valueSatang: null, noCostSet: true });
  });

  it('to reception the same reports carry no cost', async () => {
    const res = await call('GET', `/branches/${branchId}/stock/reports?from=${dayOf(0)}&to=${dayOf(6)}`, reception);
    expect(res.statusCode).toBe(200);
    const body = res.json() as StockReports;
    expect(body.withCost).toBe(false);
    expect(body.usage.find((u) => u.stockItemId === shirt)).toMatchObject({ net: 5, costSatang: null });
    expect(body.value.find((v) => v.stockItemId === shirt)).toMatchObject({ onHand: 81, unitCostSatang: null, valueSatang: null });
    expect(body.shrinkage.find((s) => s.stockItemId === shirt)!.lossSatang).toBeNull();
  });

  it('cost of goods: 5 T-shirts net at the ฿120 frozen on each sale line — the profitability seam', async () => {
    const res = await call('GET', `/branches/${branchId}/stock/reports/cost-of-goods?from=${dayOf(0)}&to=${dayOf(6)}`, admin);
    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json() as { rows: Array<{ productId: string; quantity: number; cogsSatang: number; costTracked: boolean }> }).rows.find(
      (r) => r.productId === productIds.get('MR-TSHIRT'),
    );
    expect(row).toEqual(expect.objectContaining({ quantity: 5, cogsSatang: 60_000, costTracked: true }));
    // Frozen: a cost changed today does not move what was sold.
    await ctx.db.update(stockItem).set({ unitCostSatang: 99_900 }).where(eq(stockItem.id, shirt));
    const again = await call('GET', `/branches/${branchId}/stock/reports/cost-of-goods?from=${dayOf(0)}&to=${dayOf(6)}`, admin);
    expect((again.json() as { rows: Array<{ productId: string; cogsSatang: number }> }).rows.find((r) => r.productId === productIds.get('MR-TSHIRT'))!.cogsSatang).toBe(60_000);
    await ctx.db.update(stockItem).set({ unitCostSatang: 12_000 }).where(eq(stockItem.id, shirt));
    // Reception does not read analytics.
    expect((await call('GET', `/branches/${branchId}/stock/reports/cost-of-goods?from=${dayOf(0)}&to=${dayOf(6)}`, reception)).statusCode).toBe(403);
  });

  // --- The daily fact -----------------------------------------------------------------

  it('the daily fact, day by day: opening + movements = closing, sign-exact', async () => {
    const expected = [
      { day: 0, opening: 0, counted: 40, sold: -7, refunded: 2, received: 0, transferred: 0, adjusted: 0, closing: 35 },
      { day: 1, opening: 35, counted: 0, sold: 0, refunded: 0, received: 30, transferred: 0, adjusted: 0, closing: 65 },
      { day: 2, opening: 65, counted: 0, sold: 0, refunded: 0, received: 0, transferred: 10, adjusted: 0, closing: 65 },
      { day: 3, opening: 65, counted: -1, sold: 0, refunded: 0, received: 0, transferred: 0, adjusted: 0, closing: 64 },
      { day: 4, opening: 64, counted: 0, sold: 0, refunded: 0, received: 0, transferred: 0, adjusted: -1, closing: 63 },
      { day: 5, opening: 63, counted: 0, sold: 0, refunded: 0, received: 18, transferred: 0, adjusted: 0, closing: 81 },
      { day: 6, opening: 81, counted: 0, sold: 0, refunded: 0, received: 0, transferred: 0, adjusted: 0, closing: 81 },
    ];
    for (const e of expected) {
      const { facts } = await writeStockDailyFacts(ctx.db, branchId, dayOf(e.day), at(7));
      const fact = facts.find((f) => f.stockItemId === shirt)!;
      const { day, ...figures } = e;
      expect({ ...fact, day }).toMatchObject({ ...figures, day, valueSatang: e.closing * 12_000 });
      // Every size of the branch, every day: the identity holds exactly.
      for (const f of facts) {
        expect(f.opening + f.sold + f.refunded + f.received + f.adjusted + f.counted).toBe(f.closing);
      }
    }
    // The closing is the ledger's: the level the projection holds.
    const [last] = await ctx.db
      .select()
      .from(factStockDaily)
      .where(and(eq(factStockDaily.stockItemId, shirt), eq(factStockDaily.businessDate, dayOf(6))));
    expect(last).toMatchObject({ closing: 81, opening: 81 });
  });

  it('a rerun writes nothing; the job writes the ended days once and then nothing', async () => {
    for (let d = 0; d <= 6; d += 1) {
      expect((await writeStockDailyFacts(ctx.db, branchId, dayOf(d), at(8))).written).toBe(0);
    }
    const stamp = async () =>
      (await ctx.db.execute(sql`select max(updated_at)::text as at, count(*)::int as n from analytics.fact_stock_daily`)).rows[0];
    // A week later: days 0..6 have ended, across every live branch.
    const run = await runStockDailyJob(ctx.db, at(7));
    expect(run.days).toBeGreaterThanOrEqual(7);
    const shirtDays = await ctx.db.select().from(factStockDaily).where(eq(factStockDaily.stockItemId, shirt));
    expect(shirtDays.map((d) => d.businessDate).sort()).toEqual([0, 1, 2, 3, 4, 5, 6].map(dayOf));
    const settled = await stamp();
    const again = await runStockDailyJob(ctx.db, at(7));
    expect(again.rowsWritten).toBe(0);
    expect(await stamp()).toEqual(settled);
  });
});

// --- OD-27 ---------------------------------------------------------------------------------

describe('OD-27 — the trend rule takes over at day 30, and the row says which rule fired', () => {
  let bottle: string;
  const dedupe = () => `low_stock:${branchId}:${productIds.get('MR-BOTTLE')}`;
  const openRow = async () =>
    (await ctx.db.select().from(stockAttention).where(and(eq(stockAttention.dedupeKey, dedupe()), isNull(stockAttention.resolvedAt))))[0];

  beforeAll(async () => {
    bottle = await itemIdOf('MR-BOTTLE');
    // 25 sold over the 30 days before today, the first exactly 30 days ago:
    // F = today − 30: 1; today − 20: 8; today − 10: 8; today − 2: 5 + 3.
    const sales: Array<[number, Array<[string, number]>]> = [
      [-30, [['BOH', 1]]],
      [-20, [['BOH', 8]]],
      [-10, [['BOH', 8]]],
      [-2, [['BOH', 5], ['FOH', 3]]],
    ];
    for (const [n, takes] of sales) {
      await ctx.db.transaction((tx) =>
        applyMovements(
          tx,
          { operatorId, branchId, businessDate: dayOf(n), occurredAt: at(n), actorAccountId: receptionId },
          takes.map(([place, q]) => ({
            stockItemId: bottle,
            stockLocationId: places.get(place)!,
            kind: 'sale' as const,
            quantity: -q,
            actionId: `r4-trend:${n}:${place}`,
          })),
        ),
      );
    }
    expect(await heldBy(bottle)).toMatchObject({ BOH: 0, FOH: 5 });
  });

  it('day 29 of history: the static point of 20 fires — "≤ reorder point"', async () => {
    await ctx.db.transaction((tx) => syncStockAttention(tx, { operatorId, branchId }, at(-1), [bottle]));
    const row = await openRow();
    expect(row).toMatchObject({ kind: 'reorder', rule: '≤ reorder point · Below par at FOH', quantity: 15 });
    expect(row!.detail).toMatchObject({ reorderRule: 'static', reorderPoint: 20, staticReorderPoint: 20, usedInWindow: null });
  });

  it('day 30: the point is ceil(25 × 10 / 30) = 9 — "≤ reorder point (30-day usage)"', async () => {
    await ctx.db.transaction((tx) => syncStockAttention(tx, { operatorId, branchId }, at(0), [bottle]));
    const row = await openRow();
    expect(row).toMatchObject({ kind: 'reorder', rule: '≤ reorder point (30-day usage) · Below par at FOH', quantity: 4 });
    expect(row!.detail).toMatchObject({ reorderRule: 'trend', reorderPoint: 9, staticReorderPoint: 20, usedInWindow: 25 });
    expect(row!.summary).toBe(
      "Water Bottle: 5 on hand, at or below its reorder point of 9 — 25 used in the last 30 days, 10 days' lead time",
    );
  });

  it('the usage the trend reads is the Usage report’s: net 25 over the same 30 days', async () => {
    const res = await call('GET', `/branches/${branchId}/stock/reports?from=${dayOf(-30)}&to=${dayOf(-1)}`, manager);
    expect((res.json() as StockReports).usage.find((u) => u.stockItemId === bottle)).toMatchObject({ sold: 25, refunded: 0, net: 25 });
  });
});

// --- Q2 --------------------------------------------------------------------------------------

describe('Q2 — a branch with no live place still tracks its stock: the shortfall is recorded', () => {
  it('the guard refuses at commit (round 1’s "out of stock"); a sale already committed records its shortfall at the retired sell point', async () => {
    const stickers = await itemIdOf('MR-STICKERS');
    const before = await heldBy(stickers);
    const committed = newId();
    expect((await call('POST', '/sales', reception, { stationId, id: committed, items: [itemLine('MR-STICKERS', 2)] })).statusCode).toBe(200);
    const offline = newId();
    expect((await call('POST', '/sales', reception, { stationId, id: offline, items: [itemLine('MR-STICKERS', 3)] })).statusCode).toBe(200);

    // Every place retired between commit and close.
    await ctx.db.update(stockLocation).set({ active: false }).where(eq(stockLocation.branchId, branchId));
    try {
      const refused = await call('POST', '/sales', reception, { stationId, id: newId(), items: [itemLine('MR-STICKERS', 1)] });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({ code: 'STOCK_SHORT', message: 'Sticker Pack is out of stock. Nothing was saved.' });

      expect((await call('POST', `/sales/${committed}/finalise`, reception)).statusCode).toBe(200);
      const moved = await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, committed));
      expect(moved.map((m) => [m.kind, m.stockLocationId, m.quantity, m.shortfall])).toEqual([['sale', places.get('FOH'), 0, 2]]);
      const [flag] = await ctx.db.select().from(stockAttention).where(eq(stockAttention.saleId, committed));
      expect(flag).toMatchObject({ kind: 'stock_shortfall', quantity: 2 });

      // A box's replay of a paid sale lands the same way — the offline-sale
      // movement with its shortfall is what the oversold check reads.
      const result = await ctx.db.transaction((tx) =>
        finaliseSale(tx, { accountId: receptionId, operatorId, branchId }, offline, { printing: 'skip' }),
      );
      expect(result.finalised).toBe(true);
      const off = await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, offline));
      expect(off.map((m) => [m.stockLocationId, m.quantity, m.shortfall])).toEqual([[places.get('FOH'), 0, 3]]);
    } finally {
      await ctx.db.update(stockLocation).set({ active: true }).where(eq(stockLocation.branchId, branchId));
    }
    // The shelves were not touched: the record held what it held.
    expect(await heldBy(stickers)).toEqual(before);
    await expectLedgerAddsUp();
  });
});

// --- Q3 --------------------------------------------------------------------------------------

describe('Q3 — the deploy’s stock setup audits the sizes it gives a product', () => {
  it('one audit row, actor the platform sync, sizes before and after; a rerun adds none', async () => {
    // The second operator's park has no stocked items; give it Grip Socks with
    // no sizes yet (a code is unique per operator, so not at Chalong).
    const [other] = await ctx.db.select().from(branch).where(eq(branch.code, 'second-operator-1'));
    const socks = newId();
    await ctx.db.insert(product).values({ id: socks, operatorId: other!.operatorId, branchId: other!.id, kind: 'addon', code: 'AO-GRIPSOCKS', name: 'Grip Socks', priceSatang: 5_000 });
    await platformSync(ctx.db);
    const [row] = await ctx.db.select().from(product).where(eq(product.id, socks));
    expect(row!.variants.map((v) => v.id)).toEqual(['s', 'm', 'l']);
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'product'), eq(auditLog.entityId, socks)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'product.sizes_seeded',
      actorAccountId: null,
      requestId: 'platform:sync',
      operatorId: other!.operatorId,
      branchId: other!.id,
      before: { variants: [] },
      after: { by: 'platform sync', code: 'AO-GRIPSOCKS', variants: [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }] },
    });
    await platformSync(ctx.db);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'product'), eq(auditLog.entityId, socks)))).toHaveLength(1);
  });
});
