import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, branch, product, stockItem, stockLocation, stockTake, stockTakeLine } from '@oto/db';
import {
  businessDate,
  newId,
  parseDayStart,
  type StockAttentionView,
  type StockLevels,
  type StockPlaceOpenings,
  type StockReports,
  type StockTakeResult,
} from '@oto/shared';
import { applyMovements } from '../src/services/stock';
import { ADMIN, BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * THE STOCK FIX ROUND, SECOND PASS (gate findings on F1 and F3).
 *
 *   F1  a place's first count is its OPENING only when the place has nothing on
 *       record — never counted AND no movement ever changed what it holds. A
 *       place stocked by a transfer or a delivery before its first count is
 *       counted against the record: a shortfall there is a real loss, flagged,
 *       in Discrepancies and Shrinkage. The commit stores each line's answer
 *       (`stock_take_line.opening`, 0051) and the reports read it; a line
 *       written before 0051 (NULL) is judged at read time by the same rule.
 *       `GET /stock/openings` answers by the same rule before the commit.
 *   F3  the levels read carries each item's reorder point TODAY by the
 *       platform's rule (`reorderPointNow`), the figure its low-stock rows
 *       fire on, so the Stock tab's "Low" filter agrees with the Alerts tab.
 *
 * THE INVARIANT after every flow: each level is exactly the sum of its movements.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let admin: string;
let operatorId: string;
let branchId: string;
let receptionId: string;
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

/** The place holding the most of one size — the source of a transfer. */
async function fullestPlace(stockItemId: string): Promise<{ locationId: string; quantity: number }> {
  const { rows } = await ctx.db.execute<{ stock_location_id: string; quantity: number }>(sql`
    select stock_location_id, quantity from pos.stock_level
     where stock_item_id = ${stockItemId}::uuid order by quantity desc limit 1`);
  return { locationId: rows[0]!.stock_location_id, quantity: rows[0]!.quantity };
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

async function transfer(stockItemId: string, from: string, to: string, quantity: number): Promise<void> {
  const res = await call('POST', stockUrl('/transfers'), reception, {
    fromLocationId: from,
    toLocationId: to,
    lines: [{ stockItemId, quantity }],
  });
  expect(res.statusCode, res.body).toBe(200);
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

async function openings(): Promise<Map<string, boolean>> {
  const res = await call('GET', stockUrl('/openings'), reception);
  expect(res.statusCode, res.body).toBe(200);
  return new Map((res.json() as StockPlaceOpenings).places.map((p) => [p.locationId, p.opened]));
}

async function storedOpening(takeId: string): Promise<Array<boolean | null>> {
  return (await ctx.db.select({ opening: stockTakeLine.opening }).from(stockTakeLine).where(eq(stockTakeLine.stockTakeId, takeId))).map(
    (r) => r.opening,
  );
}

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
  receptionId = (await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)))[0]!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('F1 — a place stocked before its first count is counted against the record', () => {
  it('a delivery into a new place: openings says it has a record; its first count finding 7 of 12 is a flagged loss of 5, reported', async () => {
    const keyring = await itemIdOf('MR-KEYRING');
    const dock = await newPlace('Fix2 Dock');
    expect((await openings()).get(dock)).toBe(false);
    const res = await call('POST', stockUrl('/receipts'), reception, {
      stockItemId: keyring,
      locationId: dock,
      quantity: 12,
      reason: 'Delivery from the supplier',
    });
    expect(res.statusCode, res.body).toBe(200);
    // Before the commit, the review screen is told this count is NOT an opening.
    expect((await openings()).get(dock)).toBe(true);

    const take = await count([{ stockItemId: keyring, locationId: dock, countedQuantity: 7 }]);
    expect(take.opening).toBe(false);
    expect(take.lines).toEqual([
      expect.objectContaining({ expectedQuantity: 12, countedQuantity: 7, difference: -5, flagged: true, opening: false }),
    ]);
    expect(await storedOpening(take.id)).toEqual([false]);
    const { rows } = await ctx.db.execute<{ reason: string }>(sql`
      select m.reason from pos.stock_movement m join pos.stock_take_line l on l.id = m.stock_take_line_id
       where l.stock_take_id = ${take.id}::uuid`);
    expect(rows.map((r) => r.reason)).toEqual(['Stock take — expected 12, counted 7 (flagged)']);

    const reports = await reportsToday();
    expect(reports.discrepancies.filter((d) => d.locationId === dock).map((d) => [d.stockItemId, d.difference, d.flagged])).toEqual([
      [keyring, -5, true],
    ]);
    expect(reports.shrinkage.find((s) => s.stockItemId === keyring)).toMatchObject({ countVariance: -5, countedShort: 1 });
    await expectLedgerAddsUp();
  });

  it('a place stocked by a transfer, never counted, retired and brought back: its count of 3 against 8 is a flagged loss of 5', async () => {
    const shirt = await itemIdOf('MR-TSHIRT');
    const loft = await newPlace('Fix2 Loft');
    const source = await fullestPlace(shirt);
    expect(source.quantity).toBeGreaterThanOrEqual(8);
    await transfer(shirt, source.locationId, loft, 8);
    for (const active of [false, true]) {
      const res = await call('PATCH', stockUrl(`/locations/${loft}`), admin, { active });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect((await openings()).get(loft)).toBe(true);
    const take = await count([{ stockItemId: shirt, locationId: loft, countedQuantity: 3 }]);
    expect(take.lines[0]).toMatchObject({ expectedQuantity: 8, difference: -5, flagged: true, opening: false });
    const reports = await reportsToday();
    expect(reports.discrepancies.filter((d) => d.locationId === loft).map((d) => d.difference)).toEqual([-5]);
    expect(reports.shrinkage.find((s) => s.stockItemId === shirt)).toMatchObject({ countVariance: -5, countedShort: 1 });
    await expectLedgerAddsUp();
  });

  it('a place stock has moved through, now empty, is not at its opening: its count of 0 is an ordinary, reported line', async () => {
    const plush = await itemIdOf('MR-PLUSH');
    const pass = await newPlace('Fix2 Pass');
    const source = await fullestPlace(plush);
    await transfer(plush, source.locationId, pass, 2);
    await transfer(plush, pass, source.locationId, 2);
    expect((await openings()).get(pass)).toBe(true);
    const take = await count([{ stockItemId: plush, locationId: pass, countedQuantity: 0 }]);
    expect(take.lines[0]).toMatchObject({ expectedQuantity: 0, difference: 0, flagged: false, opening: false });
    const reports = await reportsToday();
    expect(reports.discrepancies.filter((d) => d.locationId === pass).map((d) => d.difference)).toEqual([0]);
    await expectLedgerAddsUp();
  });

  it('a new place nothing has touched is still at its opening: unflagged, stored as such, left out of the reports', async () => {
    const socksS = await itemIdOf('MR-SOCKS', 's');
    const nook = await newPlace('Fix2 Nook');
    expect((await openings()).get(nook)).toBe(false);
    const take = await count([{ stockItemId: socksS, locationId: nook, countedQuantity: 9 }]);
    expect(take.opening).toBe(true);
    expect(take.lines[0]).toMatchObject({ expectedQuantity: 0, difference: 9, flagged: false, opening: true });
    expect(await storedOpening(take.id)).toEqual([true]);
    expect((await openings()).get(nook)).toBe(true);
    const reports = await reportsToday();
    expect(reports.discrepancies.some((d) => d.locationId === nook)).toBe(false);
    expect(reports.shrinkage.find((s) => s.stockItemId === socksS)).toBeUndefined();
    // Its next count is ordinary.
    const again = await count([{ stockItemId: socksS, locationId: nook, countedQuantity: 4 }]);
    expect(again.lines[0]).toMatchObject({ expectedQuantity: 9, difference: -5, flagged: true, opening: false });
    await expectLedgerAddsUp();
  });
});

describe('F1 — a line written before 0051 (no stored answer) is judged at read time by the same rule', () => {
  it('a take saved as an "opening" at a place a transfer had stocked reads as the real loss it was; one at an untouched place stays an opening', async () => {
    const cap = await itemIdOf('MR-CAP');
    const stocked = await newPlace('Fix2 Legacy Stocked');
    const untouched = await newPlace('Fix2 Legacy Untouched');
    const source = await fullestPlace(cap);
    expect(source.quantity).toBeGreaterThanOrEqual(10);
    await transfer(cap, source.locationId, stocked, 10);

    // Exactly what the per-place code before 0051 wrote: the take marked
    // `opening`, the lines unflagged, the movement worded "Opening count", and
    // no per-line answer (NULL).
    const takeId = newId();
    const now = new Date();
    await ctx.db.transaction(async (tx) => {
      await tx.insert(stockTake).values({
        id: takeId,
        operatorId,
        branchId,
        status: 'committed',
        opening: true,
        countedByAccountId: receptionId,
        committedAt: now,
        note: 'Opening count',
      });
      const drafts = [];
      for (const [locationId, expected, counted] of [
        [stocked, 10, 6],
        [untouched, 0, 4],
      ] as const) {
        const lineId = newId();
        await tx.insert(stockTakeLine).values({
          id: lineId,
          operatorId,
          stockTakeId: takeId,
          stockItemId: cap,
          stockLocationId: locationId,
          expectedQuantity: expected,
          countedQuantity: counted,
          difference: counted - expected,
          flagged: false,
          status: 'adjusted',
          countedByAccountId: receptionId,
          countedAt: now,
        });
        drafts.push({
          stockItemId: cap,
          stockLocationId: locationId,
          kind: 'count' as const,
          quantity: counted - expected,
          actionId: `count:${lineId}`,
          stockTakeLineId: lineId,
          reason: `Opening count — expected ${expected}, counted ${counted}`,
          unitCostSatang: 9000,
        });
      }
      await applyMovements(tx, { operatorId, branchId, businessDate: today, occurredAt: now, actorAccountId: receptionId }, drafts);
    });
    expect(await storedOpening(takeId)).toEqual([null, null]);

    const reports = await reportsToday();
    expect(reports.discrepancies.filter((d) => d.locationId === stocked).map((d) => [d.expectedQuantity, d.countedQuantity, d.difference])).toEqual([
      [10, 6, -4],
    ]);
    expect(reports.discrepancies.some((d) => d.locationId === untouched)).toBe(false);
    // The cap's shrinkage is the stocked place's real -4 only — the untouched place's +4 opening is no "found" unit.
    expect(reports.shrinkage.find((s) => s.stockItemId === cap)).toMatchObject({ countVariance: -4, countedShort: 1 });
    // The seed's own opening take (stored answers) is still left out entirely.
    expect(reports.discrepancies.some((d) => d.locationId === places.get('FOH') && d.expectedQuantity === 0 && d.countedQuantity > 0)).toBe(false);
    await expectLedgerAddsUp();
  });
});

describe('F3 — the levels read carries the reorder point the Alerts rows fire on', () => {
  it('every item’s reorderPointNow is the platform’s point for today; a low-stock row names the same figure', async () => {
    const levelsRes = await call('GET', stockUrl('/levels'), manager);
    expect(levelsRes.statusCode, levelsRes.body).toBe(200);
    const levels = levelsRes.json() as StockLevels;
    expect(levels.items.length).toBeGreaterThan(0);
    // Sizes of one item agree, and with no 30 days of sales the point is the static one.
    const byGroup = new Map<string, Set<number | null>>();
    for (const i of levels.items) byGroup.set(i.groupId, (byGroup.get(i.groupId) ?? new Set()).add(i.reorderPointNow));
    for (const points of byGroup.values()) expect(points.size).toBe(1);
    for (const i of levels.items.filter((x) => x.active)) {
      const staticPoint = levels.items.filter((x) => x.groupId === i.groupId && x.active).find((x) => x.reorderPoint !== null)?.reorderPoint ?? null;
      expect(i.reorderPointNow).toBe(staticPoint);
    }
    const attentionRes = await call('GET', stockUrl('/attention'), manager);
    expect(attentionRes.statusCode, attentionRes.body).toBe(200);
    const rows = (attentionRes.json() as { attention: StockAttentionView[] }).attention.filter((r) => r.lowStock);
    for (const r of rows) {
      const item = levels.items.find((i) => i.groupId === r.lowStock!.groupId)!;
      expect(item.reorderPointNow).toBe(r.lowStock!.reorderPoint);
    }
  });
});
