import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, box, branch, product, stockItem, stockLocation, stockMovement, stockTake, station } from '@oto/db';
import { addDaysToIsoDate, businessDate, newId, parseDayStart, type StockReports, type StockShrinkageRow } from '@oto/shared';
import {
  adjustStock,
  applyMovements,
  commitStockTake,
  createLocation,
  receiveStock,
  transferStock,
  type StockActor,
} from '../src/services/stock';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1012 — THE LOSS REPORT: today's figure kept, six additions beside it
 * (plan docs/progress/plans/consistency/RULINGS_BUILD_PLAN_2026-11-18.md, part E).
 *
 * THE WEEK, on the seeded T-shirt (opening BOH 28, FOH 12, cost ฿120), through
 * the services with day clocks and the till's own sale route:
 *   day 0  three sold at the counter (FOH)
 *   day 1  ten delivered at BOH (Receive); four moved BOH → FOH
 *   day 2  FOH counted two short
 *   day 3  one written down at BOH (damaged); one corrected up at FOH (found);
 *          five entered as a correction typed "delivery" at BOH
 * Today's figure: −2 counted, −1 written down = −3, ฿360 at cost. The
 * correction up is +1; the delivery entered as a correction is received, never
 * a find.
 *
 * THE WARNINGS: the Locker (no cost) written down on day 4; the cap moved to a
 * new place and first counted there one short on day 2 while a counter box
 * held two unsent records; two water bottles sold beyond the record on day 2.
 */

const DAY = 86_400_000;

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let managerId: string;
let base: number;
let today: string;
const productIds = new Map<string, string>();
const places = new Map<string, string>();

const at = (n: number) => new Date(base + n * DAY);
const dayOf = (n: number) => addDaysToIsoDate(today, n);
const actor = (): StockActor => ({ operatorId, branchId, accountId: managerId, requestId: null, stationId: null });

async function call(method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) {
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

async function heldBy(stockItemId: string): Promise<Record<string, number>> {
  const { rows } = await ctx.db.execute<{ place: string; quantity: number }>(sql`
    select loc.name as place, l.quantity from pos.stock_level l
      join pos.stock_location loc on loc.id = l.stock_location_id
     where l.stock_item_id = ${stockItemId}::uuid`);
  return Object.fromEntries(rows.map((r) => [r.place, r.quantity]));
}

/** A hand sum over the ledger for one size (and one place), by kind and business dates. */
async function ledger(stockItemId: string, where: ReturnType<typeof sql>, locationId?: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ total: string | number | null }>(sql`
    select coalesce(sum(m.quantity), 0)::bigint as total from pos.stock_movement m
     where m.stock_item_id = ${stockItemId}::uuid ${locationId ? sql`and m.stock_location_id = ${locationId}::uuid` : sql``}
       and ${where}`);
  return Number(rows[0]?.total ?? 0);
}

async function reportsAs(cookie: string, from: string, to: string): Promise<StockReports> {
  const res = await call('GET', `/branches/${branchId}/stock/reports?from=${from}&to=${to}`, cookie);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as StockReports;
}

async function sell(code: string, quantity: number): Promise<void> {
  const id = newId();
  const committed = await call('POST', '/sales', reception, {
    stationId,
    id,
    items: [{ id: newId(), productId: productIds.get(code)!, quantity }],
  });
  expect(committed.statusCode, committed.body).toBe(200);
  const closed = await call('POST', `/sales/${id}/finalise`, reception);
  expect(closed.statusCode, closed.body).toBe(200);
}

let shirt: string;
let cap: string;
let locker: string;
let bottle: string;
let plush: string;
let stickers: string;
let storeRoom: string;
let counterBox: string;
let week: StockReports;
let weekStatus: number;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const hkt = (await ctx.db.select().from(branch)).find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  base = Date.now();
  today = businessDate(new Date(base), hkt.timezone, parseDayStart(hkt.businessDayStart));
  const stations = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code && (p.branchId === branchId || p.branchId === null)) productIds.set(p.code, p.id);
  }
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) places.set(l.name, l.id);
  const [m] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  managerId = m!.id;
  shirt = await itemIdOf('MR-TSHIRT');
  cap = await itemIdOf('MR-CAP');
  locker = await itemIdOf('AO-LOCKER');
  bottle = await itemIdOf('MR-BOTTLE');
  plush = await itemIdOf('MR-PLUSH');
  stickers = await itemIdOf('MR-STICKERS');
  const FOH = places.get('FOH')!;
  const BOH = places.get('BOH')!;

  // Day 0: three T-shirts sold at the counter.
  await sell('MR-TSHIRT', 3);
  // Day 1: ten delivered at BOH; four to the counter. A new store room, stocked by a move.
  await ctx.db.transaction((t) => receiveStock(t, actor(), { stockItemId: shirt, locationId: BOH, quantity: 10, reason: 'ZZ TEST delivery' }, at(1)));
  await ctx.db.transaction((t) => transferStock(t, actor(), { fromLocationId: BOH, toLocationId: FOH, lines: [{ stockItemId: shirt, quantity: 4 }] }, at(1)));
  storeRoom = (await ctx.db.transaction((t) => createLocation(t, actor(), { name: 'ZZ TEST Store room', type: 'bulk' }, at(1)))).id;
  await ctx.db.transaction((t) => transferStock(t, actor(), { fromLocationId: BOH, toLocationId: storeRoom, lines: [{ stockItemId: cap, quantity: 3 }] }, at(1)));
  // Day 2: the counter counted two short — no box waiting.
  const held = await heldBy(shirt);
  await ctx.db.transaction((t) => commitStockTake(t, actor(), { lines: [{ stockItemId: shirt, locationId: FOH, countedQuantity: held.FOH! - 2 }] }, at(2)));
  // Day 2: a counter box holds two records it has not sent; the store room's
  // first count — no opening there (a move stocked it) — finds the cap one short.
  counterBox = newId();
  await ctx.db.insert(box).values({
    id: counterBox,
    operatorId,
    branchId,
    name: 'ZZ TEST Counter box',
    slot: `zz-test-${counterBox}`,
    role: 'counter',
    status: 'online',
    registeredAt: new Date(),
    lastHeartbeatAt: new Date(),
    lastStatus: { receivedAt: new Date().toISOString(), outboxDepth: 2, oldestUnackedAgeS: 30 },
  });
  await ctx.db.transaction((t) => commitStockTake(t, actor(), { lines: [{ stockItemId: cap, locationId: storeRoom, countedQuantity: 2 }] }, at(2)));
  await ctx.db.update(box).set({ archivedAt: new Date() }).where(eq(box.id, counterBox));
  // Day 2: two water bottles paid for that the record did not hold.
  await ctx.db.transaction((t) =>
    applyMovements(t, { operatorId, branchId, businessDate: dayOf(2), occurredAt: at(2), actorAccountId: managerId }, [
      { stockItemId: bottle, stockLocationId: FOH, kind: 'sale', quantity: 0, shortfall: 2, actionId: `s1012-beyond:${newId()}` },
    ]),
  );
  // Day 3: one damaged at BOH, one found at FOH, five entered as a correction typed "delivery".
  await ctx.db.transaction((t) => adjustStock(t, actor(), { stockItemId: shirt, locationId: BOH, delta: -1, reasonType: 'damaged', reason: 'ZZ TEST torn' }, at(3)));
  await ctx.db.transaction((t) => adjustStock(t, actor(), { stockItemId: shirt, locationId: FOH, delta: 1, reasonType: 'found', reason: 'ZZ TEST under the counter' }, at(3)));
  await ctx.db.transaction((t) => adjustStock(t, actor(), { stockItemId: shirt, locationId: BOH, delta: 5, reasonType: 'delivery', reason: 'ZZ TEST late box' }, at(3)));
  // Day 4: a Locker key written down — the Locker has no cost.
  await ctx.db.transaction((t) => adjustStock(t, actor(), { stockItemId: locker, locationId: BOH, delta: -1, reasonType: 'theft', reason: 'ZZ TEST key gone' }, at(4)));
  // Day 4: a sticker pack written down the way corrections were before types (0134): no type.
  await ctx.db.transaction((t) =>
    applyMovements(t, { operatorId, branchId, businessDate: dayOf(4), occurredAt: at(4), actorAccountId: managerId }, [
      { stockItemId: stickers, stockLocationId: BOH, kind: 'adjust', quantity: -1, reason: 'ZZ TEST old correction', unitCostSatang: 1_200, actionId: `s1012-old:${newId()}` },
    ]),
  );
  // Read without asserting here, so each check below fails on its own when it fails.
  weekStatus = (await call('GET', `/branches/${branchId}/stock/reports?from=${dayOf(0)}&to=${dayOf(6)}`, manager)).statusCode;
  week = weekStatus === 200 ? await reportsAs(manager, dayOf(0), dayOf(6)) : ({ shrinkage: [], shrinkageEvents: [] } as unknown as StockReports);
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const rowOf = (r: StockReports, id: string): StockShrinkageRow => r.shrinkage.find((s) => s.stockItemId === id)!;
const placeOf = (row: StockShrinkageRow, locationId: string) => row.byPlace.find((p) => p.locationId === locationId)!;

describe("today's figure is kept", () => {
  it('the reports answer the week', () => {
    expect(weekStatus).toBe(200);
  });

  it('the T-shirt: counted −2, written down −1 — total −3, ฿360 at cost, the correction up and the delivery left out', () => {
    expect(rowOf(week, shirt)).toMatchObject({
      countVariance: -2,
      countedShort: 1,
      adjustedDown: -1,
      total: -3,
      lossSatang: 36_000,
      costMissing: false,
    });
  });
});

describe('E1 — corrections up and the net', () => {
  it('corrected up +1 (the find), the delivery typed as one is not a find; net −2', () => {
    expect(rowOf(week, shirt)).toMatchObject({ correctedUp: 1, correctedUpSatang: 12_000, net: -2 });
  });

  it('the correction up is the ledger’s adjust up typed other than delivery', async () => {
    const ups = await ledger(shirt, sql`m.kind = 'adjust' and m.quantity > 0 and m.reason_type is distinct from 'delivery' and m.business_date between ${dayOf(0)}::date and ${dayOf(6)}::date`);
    expect(rowOf(week, shirt).correctedUp).toBe(ups);
  });
});

describe('E2 — the period columns add up to the ledger', () => {
  it('opening + received − sold − closing = not explained = −net', async () => {
    const row = rowOf(week, shirt);
    const before = await ledger(shirt, sql`m.business_date < ${dayOf(0)}::date`);
    const closing = await ledger(shirt, sql`m.business_date <= ${dayOf(6)}::date`);
    expect(row.opening - row.openingCounted).toBe(before);
    expect(row.opening).toBe(40);
    expect(row.received).toBe(15);
    expect(row.sold).toBe(3);
    expect(row.closing).toBe(closing);
    expect(row.closing).toBe(50);
    expect(row.notExplained).toBe(row.opening + row.received - row.sold - row.closing);
    expect(row.notExplained).toBe(2);
    expect(row.notExplained).toBe(-row.net);
  });

  it('the closing is what the shelves hold now', async () => {
    const held = await heldBy(shirt);
    expect(Object.values(held).reduce((a, b) => a + b, 0)).toBe(rowOf(week, shirt).closing);
  });
});

describe('E3 — per storage place, summing to the size', () => {
  it('FOH and BOH, with moves in and out; each place’s not explained counts its moves', () => {
    const row = rowOf(week, shirt);
    const FOH = places.get('FOH')!;
    const BOH = places.get('BOH')!;
    expect(placeOf(row, FOH)).toMatchObject({ opening: 12, sold: 3, movedIn: 4, movedOut: 0, countVariance: -2, correctedUp: 1, total: -2, net: -1, closing: 12, notExplained: 1, lossSatang: 24_000 });
    expect(placeOf(row, BOH)).toMatchObject({ opening: 28, received: 15, movedIn: 0, movedOut: 4, adjustedDown: -1, total: -1, net: -1, closing: 38, notExplained: 1, lossSatang: 12_000 });
  });

  it('every figure of the places adds up to the size', () => {
    expect(week.shrinkage.length).toBeGreaterThan(3);
    for (const row of week.shrinkage) {
      for (const key of ['countVariance', 'countedShort', 'adjustedDown', 'total', 'correctedUp', 'net', 'opening', 'openingCounted', 'received', 'sold', 'closing', 'notExplained', 'soldBeyondRecord', 'lossSatang'] as const) {
        expect(row.byPlace.reduce((n, p) => n + (p[key] ?? 0), 0), `${row.name} ${key}`).toBe(row[key] ?? 0);
      }
      expect(row.byPlace.reduce((n, p) => n + p.movedIn - p.movedOut, 0)).toBe(0);
    }
  });

  it('a loss at one place and a find at another no longer cancel out of sight', async () => {
    // The cap: −1 at the store room. Nothing else was counted; the size is reported.
    expect(rowOf(week, cap)).toMatchObject({ countVariance: -1, total: -1 });
    expect(placeOf(rowOf(week, cap), storeRoom)).toMatchObject({ locationName: 'ZZ TEST Store room', movedIn: 3, countVariance: -1, closing: 2 });
  });
});

describe('E4 — the four warnings, raised and not raised', () => {
  it('(a) the sizes with no cost: the Locker’s loss in the range, not before it', async () => {
    expect(rowOf(week, locker)).toMatchObject({ total: -1, costMissing: true, lossSatang: 0 });
    expect(week.shrinkageSummary.sizesWithoutCost).toBe(1);
    expect((await reportsAs(manager, dayOf(0), dayOf(3))).shrinkageSummary.sizesWithoutCost).toBe(0);
  });

  it('(b) first count at a place with no opening: the store room, not the counter', () => {
    expect(rowOf(week, cap)).toMatchObject({ firstCountWithoutOpening: true });
    expect(placeOf(rowOf(week, cap), storeRoom).firstCountWithoutOpening).toBe(true);
    expect(rowOf(week, shirt).firstCountWithoutOpening).toBe(false);
  });

  it('(c) counted while a counter box had sales it had not sent: stored at the commit, read by the report', async () => {
    expect(rowOf(week, cap).countedWithUnsentSales).toBe(true);
    expect(rowOf(week, shirt).countedWithUnsentSales).toBe(false);
    const takes = await ctx.db.select({ unsentBoxes: stockTake.unsentBoxes, committedAt: stockTake.committedAt }).from(stockTake).where(eq(stockTake.branchId, branchId));
    const capTake = takes.find((t) => t.committedAt?.getTime() === at(2).getTime() && (t.unsentBoxes ?? []).length > 0)!;
    expect(capTake.unsentBoxes).toEqual([expect.objectContaining({ boxId: counterBox, name: 'ZZ TEST Counter box', role: 'counter', waiting: 2 })]);
    expect(takes.filter((t) => t.committedAt?.getTime() === at(2).getTime() && (t.unsentBoxes ?? []).length === 0)).toHaveLength(1);
  });

  it('(d) sold beyond the record: 2 water bottles in the range, none before day 2', async () => {
    expect(week.shrinkageSummary).toMatchObject({ soldBeyondRecord: 2, soldBeyondRecordSizes: 1 });
    expect((await reportsAs(manager, dayOf(0), dayOf(1))).shrinkageSummary).toMatchObject({ soldBeyondRecord: 0, soldBeyondRecordSizes: 0 });
  });
});

describe('E5 — a reason type on every correction', () => {
  it('the api refuses a correction with no type, or a type not on the list', async () => {
    const none = await call('POST', `/branches/${branchId}/stock/adjustments`, manager, { stockItemId: plush, delta: -1, reason: 'ZZ TEST' });
    expect(none.statusCode).toBe(400);
    const odd = await call('POST', `/branches/${branchId}/stock/adjustments`, manager, { stockItemId: plush, delta: -1, reasonType: 'lost', reason: 'ZZ TEST' });
    expect(odd.statusCode).toBe(400);
  });

  it('the type is stored on the movement and the losses split by cause', async () => {
    const ok = await call('POST', `/branches/${branchId}/stock/adjustments`, manager, { stockItemId: plush, delta: -1, reasonType: 'expired', reason: 'ZZ TEST faded' });
    expect(ok.statusCode, ok.body).toBe(200);
    const [moved] = await ctx.db.select().from(stockMovement).where(and(eq(stockMovement.stockItemId, plush), eq(stockMovement.kind, 'adjust')));
    expect(moved).toMatchObject({ reasonType: 'expired', reason: 'ZZ TEST faded', quantity: -1 });
    expect(rowOf(week, shirt).byCause).toEqual([
      { cause: 'count', quantity: -2, lossSatang: 24_000 },
      { cause: 'damaged', quantity: -1, lossSatang: 12_000 },
    ]);
    const now = await reportsAs(manager, dayOf(0), dayOf(6));
    expect(rowOf(now, plush).byCause).toEqual([{ cause: 'expired', quantity: -1, lossSatang: 16_000 }]);
  });

  it('a correction recorded before types reads as "not given" — the stored row untouched', () => {
    expect(rowOf(week, stickers).byCause).toEqual([{ cause: 'not_given', quantity: -1, lossSatang: 1_200 }]);
    expect(week.shrinkageEvents.find((e) => e.stockItemId === stickers)).toMatchObject({ kind: 'write_down', reasonType: 'not_given', reason: 'ZZ TEST old correction' });
  });
});

describe('E6 — the write-downs and count differences, who, when, where and why', () => {
  it('the T-shirt’s two: the count at FOH and the write-down at BOH, newest first', () => {
    const rows = week.shrinkageEvents.filter((e) => e.stockItemId === shirt);
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'write_down', locationName: 'BOH', quantity: -1, reasonType: 'damaged', reason: 'ZZ TEST torn', businessDate: dayOf(3), lossSatang: 12_000, expectedQuantity: null }),
      expect.objectContaining({ kind: 'count', locationName: 'FOH', quantity: -2, expectedQuantity: 13, countedQuantity: 11, reasonType: null, businessDate: dayOf(2), lossSatang: 24_000 }),
    ]);
    for (const e of rows) expect(e.by).toEqual(expect.any(String));
  });

  it('the list holds exactly today’s figure: every size’s events add up to its total', () => {
    expect(week.shrinkage.length).toBeGreaterThan(3);
    for (const row of week.shrinkage) {
      expect(week.shrinkageEvents.filter((e) => e.stockItemId === row.stockItemId).reduce((n, e) => n + e.quantity, 0)).toBe(row.total);
    }
  });
});

describe('the money stays a manager’s', () => {
  it('to reception: no loss, no correction cost, no cause cost, no event cost', async () => {
    const r = await reportsAs(reception, dayOf(0), dayOf(6));
    expect(r.withCost).toBe(false);
    const row = rowOf(r, shirt);
    expect(row).toMatchObject({ total: -3, correctedUp: 1, net: -2, notExplained: 2, lossSatang: null, correctedUpSatang: null });
    expect(row.byPlace.every((p) => p.lossSatang === null && p.correctedUpSatang === null)).toBe(true);
    expect(row.byCause.every((c) => c.lossSatang === null)).toBe(true);
    expect(r.shrinkageEvents.every((e) => e.lossSatang === null)).toBe(true);
  });
});

describe('review pins', () => {
  it('a correction DOWN typed "delivery" stays in today’s figure (the method is unchanged) and is never received', async () => {
    const cup = await itemIdOf('AO-CUP');
    await ctx.db.transaction((t) =>
      adjustStock(t, actor(), { stockItemId: cup, locationId: places.get('BOH')!, delta: -1, reasonType: 'delivery', reason: 'ZZ TEST sent back' }, at(5)),
    );
    const r = await reportsAs(manager, dayOf(0), dayOf(6));
    expect(rowOf(r, cup)).toMatchObject({ adjustedDown: -1, total: -1, correctedUp: 0, received: 0, net: -1, notExplained: 1 });
    expect(rowOf(r, cup).byCause).toEqual([{ cause: 'delivery', quantity: -1, lossSatang: 6_500 }]);
  });

  it('the ledger refuses a type on anything but a correction', async () => {
    await expect(
      ctx.db.transaction((t) =>
        applyMovements(t, { operatorId, branchId, businessDate: dayOf(5), occurredAt: at(5), actorAccountId: managerId }, [
          { stockItemId: plush, stockLocationId: places.get('BOH')!, kind: 'receive', quantity: 1, reasonType: 'found', actionId: `s1012-typed-receive:${newId()}` },
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe('a new size’s starting stock', () => {
  it('is its opening, never a correction up: a size started with 4, one written down, reads −1 and net −1', async () => {
    const made = await call('POST', `/branches/${branchId}/stock/items`, manager, {
      name: 'ZZ TEST Starter', productId: null, unitCostSatang: 1_000, reorder: null, units: [],
      sizes: [{ variantId: null, label: 'Default', lowStockThreshold: null, startingStock: 4, parByLocation: {} }],
    });
    expect(made.statusCode, made.body).toBe(200);
    const starter = (made.json() as { stockItemIds: string[] }).stockItemIds[0]!;
    const down = await call('POST', `/branches/${branchId}/stock/adjustments`, manager, { stockItemId: starter, delta: -1, reasonType: 'damaged', reason: 'ZZ TEST dropped' });
    expect(down.statusCode, down.body).toBe(200);
    const r = await reportsAs(manager, dayOf(0), dayOf(6));
    expect(rowOf(r, starter)).toMatchObject({ total: -1, correctedUp: 0, net: -1, opening: 4, openingCounted: 4, received: 0, closing: 3, notExplained: 1 });
  });
});
