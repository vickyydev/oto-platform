import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, branch, product, stockItem, stockLocation } from '@oto/db';
import { businessDate, parseDayStart, type StockReports, type StockTakeResult } from '@oto/shared';
import { commitStockTake, type StockActor } from '../src/services/stock';
import { ADMIN, BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * GATE — the stock walkthrough fix round, F1 attacked (report truth).
 *
 * The per-place opening says "a place's first count is its opening". That is
 * right for a place nothing has ever moved through (staging's BOH: expected 0),
 * but a place added AFTER the branch's first count can hold stock the ledger
 * put there — a transfer in, a delivery — before anybody counts it. Its first
 * count then has a real expected figure, and a shortfall against it is a
 * genuine loss. These tests pin that a genuine variance is never hidden as an
 * opening, alongside the cases that hold (a re-activated counted place).
 *
 * THE INVARIANT after every flow: each level is exactly the sum of its movements.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let admin: string;
let operatorId: string;
let branchId: string;
let managerId: string;
let today: string;
const productIds = new Map<string, string>();
const places = new Map<string, string>();

const stockUrl = (path: string) => `/branches/${branchId}/stock${path}`;

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

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

async function newPlace(name: string): Promise<string> {
  const res = await call('POST', stockUrl('/locations'), admin, { name, type: 'rotation' });
  expect(res.statusCode, res.body).toBe(200);
  const id = (res.json() as { id: string }).id;
  places.set(name, id);
  return id;
}

async function count(lines: Array<{ stockItemId: string; locationId: string; countedQuantity: number }>): Promise<StockTakeResult> {
  const res = await call('POST', stockUrl('/stock-takes'), reception, { lines });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as StockTakeResult;
}

async function reportsToday(): Promise<StockReports> {
  const res = await call('GET', stockUrl(`/reports?from=${today}&to=${today}`), manager);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as StockReports;
}

const actor = (): StockActor => ({ operatorId, branchId, accountId: managerId, requestId: null, stationId: null });

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const hkt = (await ctx.db.select().from(branch)).find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  today = businessDate(new Date(), hkt.timezone, parseDayStart(hkt.businessDayStart));
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code && (p.branchId === branchId || p.branchId === null)) productIds.set(p.code, p.id);
  }
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) {
    places.set(l.name, l.id);
  }
  managerId = (await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone)))[0]!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('GATE F1 — a place added after the branch’s first count, stocked before its first count', () => {
  let cap: string;
  let store: string;

  beforeAll(async () => {
    cap = await itemIdOf('MR-CAP');
    store = await newPlace('Gate Store');
    // The ledger puts 10 caps on the new place: a transfer in from BOH (seeded 18).
    const bohCaps = await ctx.db.execute<{ quantity: number }>(sql`
      select quantity from pos.stock_level where stock_item_id = ${cap}::uuid and stock_location_id = ${places.get('BOH')!}::uuid`);
    expect(bohCaps.rows[0]!.quantity).toBeGreaterThanOrEqual(10);
    const res = await call('POST', stockUrl('/transfers'), reception, {
      fromLocationId: places.get('BOH')!,
      toLocationId: store,
      lines: [{ stockItemId: cap, quantity: 10 }],
    });
    expect(res.statusCode, res.body).toBe(200);
    await expectLedgerAddsUp();
  });

  it('its first count finding 6 of the 10 the ledger put there is a genuine loss: flagged, not an opening', async () => {
    const take = await count([{ stockItemId: cap, locationId: store, countedQuantity: 6 }]);
    expect(take.lines).toEqual([
      expect.objectContaining({ expectedQuantity: 10, countedQuantity: 6, difference: -4, flagged: true, opening: false }),
    ]);
    await expectLedgerAddsUp();
  });

  it('the loss of 4 is in Discrepancies and Shrinkage', async () => {
    const reports = await reportsToday();
    expect(reports.discrepancies.filter((d) => d.locationId === store).map((d) => [d.stockItemId, d.difference])).toEqual([
      [cap, -4],
    ]);
    expect(reports.shrinkage.find((s) => s.stockItemId === cap)).toMatchObject({ countVariance: -4, countedShort: 1 });
    await expectLedgerAddsUp();
  });
});

describe('GATE F1 — a counted place retired and re-activated is not at its opening again', () => {
  it('its next count is ordinary: flagged above three and reported', async () => {
    const shirt = await itemIdOf('MR-TSHIRT');
    const shed = await newPlace('Gate Shed');
    const first = await count([{ stockItemId: shirt, locationId: shed, countedQuantity: 12 }]);
    expect(first.lines[0]).toMatchObject({ opening: true, flagged: false });
    for (const active of [false, true]) {
      const res = await call('PATCH', stockUrl(`/locations/${shed}`), admin, { active });
      expect(res.statusCode, res.body).toBe(200);
    }
    const again = await count([{ stockItemId: shirt, locationId: shed, countedQuantity: 5 }]);
    expect(again.lines[0]).toMatchObject({ expectedQuantity: 12, difference: -7, flagged: true, opening: false });
    const reports = await reportsToday();
    expect(reports.discrepancies.filter((d) => d.locationId === shed).map((d) => d.difference)).toEqual([-7]);
    await expectLedgerAddsUp();
  });
});

describe('GATE F1 — commit order and read order agree on which count was the opening', () => {
  it('two first counts at one new place, the later-committed one stamped earlier: the reports judge them as the commit did', async () => {
    const plush = await itemIdOf('MR-PLUSH');
    const booth = await newPlace('Gate Booth');
    // Two counters commit at once: request Y stamps `now` after X but takes the
    // branch's count lock first, so Y is recorded as the opening; X, committed
    // second, is an ordinary count with a genuine -5 against Y's figure.
    const tY = new Date();
    const tX = new Date(tY.getTime() - 50);
    const y = await ctx.db.transaction((tx) =>
      commitStockTake(tx, actor(), { lines: [{ stockItemId: plush, locationId: booth, countedQuantity: 10 }] }, tY),
    );
    const x = await ctx.db.transaction((tx) =>
      commitStockTake(tx, actor(), { lines: [{ stockItemId: plush, locationId: booth, countedQuantity: 5 }] }, tX),
    );
    expect(y.lines[0]).toMatchObject({ opening: true, flagged: false });
    expect(x.lines[0]).toMatchObject({ expectedQuantity: 10, difference: -5, flagged: true, opening: false });
    const reports = await reportsToday();
    // The genuine -5 is reported; the opening's +10 is not.
    expect(reports.discrepancies.filter((d) => d.locationId === booth).map((d) => d.difference)).toEqual([-5]);
    await expectLedgerAddsUp();
  });
});
