import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, product, stockItem, stockLocation, stockMovement, stockTake, stockTakeLine } from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type SellableStock,
  type StockAttentionView,
  type StockPlaceOpenings,
  type StockReports,
  type StockTakeResult,
} from '@oto/shared';
import { addToPurchaseOrders, applyMovements, syncStockAttention, type StockActor } from '../src/services/stock';
import { ADMIN, BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * THE STOCK WALKTHROUGH FIXES (staging walkthrough 2026-10-02, findings F1-F4),
 * through the real routes and services, the database read back after each.
 *
 *   F1  the opening is PER PLACE: each place's first committed count is its
 *       opening — never flagged, never in Discrepancies or Shrinkage — and a
 *       count written before the fix (staging's BOH, saved flagged because FOH
 *       had been counted first) reads as the opening it was, with nothing in
 *       the append-only ledger rewritten;
 *   F2  the platform answers, before a commit, whether a place has been
 *       counted (`GET /stock/openings`) — the review screen's question;
 *   F3  a low-stock row carries the rule's figures (`lowStock`), so the Alerts
 *       screen reads the platform's rows rather than working its own out;
 *   F4  the till's sellable read — the header strip's source — leaves out a
 *       retired product (the seed's "Old Lanyard (retired)").
 *
 * THE INVARIANT after every flow: each level is exactly the sum of its movements.
 */

const DAY = 86_400_000;

let ctx: TestContext;
let reception: string;
let manager: string;
let admin: string;
let operatorId: string;
let branchId: string;
let managerId: string;
let receptionId: string;
let base: number;
let today: string;
const productIds = new Map<string, string>();
const places = new Map<string, string>();

const at = (n: number) => new Date(base + n * DAY);
const dayOf = (n: number) => addDaysToIsoDate(today, n);
const stockUrl = (path: string) => `/branches/${branchId}/stock${path}`;

async function call(method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) {
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

async function newPlace(name: string): Promise<string> {
  const res = await call('POST', stockUrl('/locations'), admin, { name, type: 'rotation' });
  expect(res.statusCode, res.body).toBe(200);
  const id = (res.json() as { id: string }).id;
  places.set(name, id);
  return id;
}

async function openings(): Promise<Map<string, boolean>> {
  const res = await call('GET', stockUrl('/openings'), reception);
  expect(res.statusCode, res.body).toBe(200);
  return new Map((res.json() as StockPlaceOpenings).places.map((p) => [p.locationId, p.opened]));
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

async function attention(): Promise<StockAttentionView[]> {
  const res = await call('GET', stockUrl('/attention'), reception);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { attention: StockAttentionView[] }).attention;
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
  base = Date.now();
  today = businessDate(new Date(base), hkt.timezone, parseDayStart(hkt.businessDayStart));
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code && (p.branchId === branchId || p.branchId === null)) productIds.set(p.code, p.id);
  }
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) {
    places.set(l.name, l.id);
  }
  managerId = (await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone)))[0]!.id;
  receptionId = (await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)))[0]!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- F1 / F2 -----------------------------------------------------------------------------

describe('F1 — the opening is per place: each place’s first count is its opening', () => {
  let kiosk: string;
  let cap: string;
  let shirt: string;
  let openingTakeId: string;

  beforeAll(async () => {
    cap = await itemIdOf('MR-CAP');
    shirt = await itemIdOf('MR-TSHIRT');
  });

  it('F2 — the platform answers whether each place has been counted: the seeded places have, a new place has not', async () => {
    kiosk = await newPlace('Kiosk');
    const opened = await openings();
    expect(opened.get(places.get('FOH')!)).toBe(true);
    expect(opened.get(places.get('BOH')!)).toBe(true);
    expect(opened.get(kiosk)).toBe(false);
  });

  it('the first count at a second place is its opening: unflagged, worded and audited as one — like the branch’s first', async () => {
    // Staging's shape: the branch already has its opening (the seed's, at FOH
    // and BOH); a place counted for the first time now — 15 and 25 against an
    // expected 0, differences far over the flag threshold.
    const take = await count([
      { stockItemId: cap, locationId: kiosk, countedQuantity: 15 },
      { stockItemId: shirt, locationId: kiosk, countedQuantity: 25 },
    ]);
    openingTakeId = take.id;
    expect(take.opening).toBe(true);
    expect(take.lines.map((l) => [l.expectedQuantity, l.countedQuantity, l.flagged, l.opening])).toEqual(
      expect.arrayContaining([
        [0, 15, false, true],
        [0, 25, false, true],
      ]),
    );
    const moves = await ctx.db
      .select({ reason: stockMovement.reason })
      .from(stockMovement)
      .where(and(eq(stockMovement.stockLocationId, kiosk), eq(stockMovement.kind, 'count')));
    expect(moves.map((m) => m.reason).sort()).toEqual([
      'Opening count — expected 0, counted 15',
      'Opening count — expected 0, counted 25',
    ]);
    const audits = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, take.id));
    expect(audits.map((a) => a.action)).toEqual(['stock.opening_count']);
    const [row] = await ctx.db.select().from(stockTake).where(eq(stockTake.id, take.id));
    expect(row).toMatchObject({ opening: true, note: 'Opening count' });
    expect((await openings()).get(kiosk)).toBe(true);
    expect(await heldBy(cap)).toMatchObject({ Kiosk: 15 });
    await expectLedgerAddsUp();
  });

  it('a second count at the same place is an ordinary count, flagged as usual', async () => {
    const take = await count([{ stockItemId: cap, locationId: kiosk, countedQuantity: 8 }]);
    expect(take.opening).toBe(false);
    expect(take.lines).toEqual([
      expect.objectContaining({ expectedQuantity: 15, countedQuantity: 8, difference: -7, flagged: true, opening: false }),
    ]);
    const audits = await ctx.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, take.id));
    expect(audits.map((a) => a.action)).toEqual(['stock.count']);
    await expectLedgerAddsUp();
  });

  it('one take over a new place and a counted one: each line is judged by its own place', async () => {
    const annex = await newPlace('Annex');
    const fohBefore = (await heldBy(shirt)).FOH!;
    const take = await count([
      { stockItemId: shirt, locationId: annex, countedQuantity: 30 },
      { stockItemId: shirt, locationId: places.get('FOH')!, countedQuantity: fohBefore + 6 },
    ]);
    expect(take.opening).toBe(false);
    const byPlace = new Map(take.lines.map((l) => [l.locationId, l]));
    expect(byPlace.get(annex)).toMatchObject({ difference: 30, flagged: false, opening: true });
    expect(byPlace.get(places.get('FOH')!)).toMatchObject({ difference: 6, flagged: true, opening: false });
    await expectLedgerAddsUp();
  });

  it('the reports leave every place’s opening out: Discrepancies, Shrinkage and the loss figure', async () => {
    const reports = await reportsToday();
    const kioskRows = reports.discrepancies.filter((d) => d.locationId === kiosk);
    // Only the second count at the Kiosk — never its opening.
    expect(kioskRows.map((d) => [d.stockItemId, d.expectedQuantity, d.countedQuantity, d.flagged])).toEqual([[cap, 15, 8, true]]);
    expect(reports.discrepancies.some((d) => d.locationId === places.get('Annex'))).toBe(false);
    expect(reports.discrepancies.find((d) => d.locationId === places.get('FOH') && d.stockItemId === shirt)).toMatchObject({
      difference: 6,
      flagged: true,
    });
    // Shrinkage: the cap lost 7 at its second Kiosk count — the opening's +15 is no variance.
    expect(reports.shrinkage.find((s) => s.stockItemId === cap)).toMatchObject({ countVariance: -7, countedShort: 1, total: -7 });
    // The shirt: +6 found at FOH; the Kiosk's +25 and the Annex's +30 openings are not "found units".
    const shirtRow = reports.shrinkage.find((s) => s.stockItemId === shirt)!;
    expect(shirtRow).toMatchObject({ countVariance: 6, countedShort: 0 });
    const [shirtItem] = await ctx.db.select().from(stockItem).where(eq(stockItem.id, shirt));
    expect(shirtRow.lossSatang).toBe(-6 * shirtItem!.unitCostSatang!);
    // The opening's take is still exactly what it was written as.
    const lines = await ctx.db.select().from(stockTakeLine).where(eq(stockTakeLine.stockTakeId, openingTakeId));
    expect(lines.every((l) => !l.flagged)).toBe(true);
    await expectLedgerAddsUp();
  });
});

describe('F1 — staging-shaped data written before the fix reads correctly, nothing rewritten', () => {
  let cellar: string;
  let socks: { s: string; m: string; l: string };
  let preFixTakeId: string;
  const snapshot = async () =>
    (
      await ctx.db.execute(sql`
        select t.id as take, t.opening, l.id as line, l.flagged, l.difference, m.id as movement, m.quantity, m.reason, m.level_after
          from pos.stock_take t
          join pos.stock_take_line l on l.stock_take_id = t.id
          left join pos.stock_movement m on m.stock_take_line_id = l.id
         where t.id = ${preFixTakeId}::uuid
         order by l.id`)
    ).rows;

  beforeAll(async () => {
    socks = { s: await itemIdOf('MR-SOCKS', 's'), m: await itemIdOf('MR-SOCKS', 'm'), l: await itemIdOf('MR-SOCKS', 'l') };
    cellar = await newPlace('Cellar');
    // Exactly what the old commit wrote for staging's BOH: the branch had
    // already counted (here: the seed's opening, and every count above), so
    // this place's first count was an ORDINARY take — `opening` false, each
    // line flagged, each movement worded "Stock take … (flagged)".
    preFixTakeId = newId();
    const now = new Date();
    await ctx.db.transaction(async (tx) => {
      await tx.insert(stockTake).values({
        id: preFixTakeId,
        operatorId,
        branchId,
        status: 'committed',
        opening: false,
        countedByAccountId: receptionId,
        committedAt: now,
      });
      const drafts = [];
      for (const [stockItemId, counted] of [
        [socks.s, 15],
        [socks.m, 25],
        [socks.l, 10],
      ] as const) {
        const lineId = newId();
        await tx.insert(stockTakeLine).values({
          id: lineId,
          operatorId,
          stockTakeId: preFixTakeId,
          stockItemId,
          stockLocationId: cellar,
          expectedQuantity: 0,
          countedQuantity: counted,
          difference: counted,
          flagged: true,
          status: 'adjusted',
          countedByAccountId: receptionId,
          countedAt: now,
        });
        drafts.push({
          stockItemId,
          stockLocationId: cellar,
          kind: 'count' as const,
          quantity: counted,
          actionId: `count:${lineId}`,
          stockTakeLineId: lineId,
          reason: `Stock take — expected 0, counted ${counted} (flagged)`,
          unitCostSatang: 3500,
        });
      }
      await applyMovements(tx, { operatorId, branchId, businessDate: today, occurredAt: now, actorAccountId: receptionId }, drafts);
    });
    await expectLedgerAddsUp();
  });

  it('reads as the Cellar’s opening: no Discrepancies, no Shrinkage, no negative loss — and the stored rows are untouched', async () => {
    const before = await snapshot();
    expect(before).toHaveLength(3);
    const reports = await reportsToday();
    expect(reports.discrepancies.filter((d) => d.locationId === cellar)).toEqual([]);
    for (const id of Object.values(socks)) {
      expect(reports.shrinkage.find((s) => s.stockItemId === id)).toBeUndefined();
    }
    // Staging showed these as +50 found units, a loss of −฿1,750: now nothing.
    expect(reports.shrinkage.some((s) => Object.values(socks).includes(s.stockItemId))).toBe(false);
    // The ledger and the take were read, never written: the old words and flags stand.
    expect(await snapshot()).toEqual(before);
    expect(before.every((r) => r.flagged === true && r.opening === false)).toBe(true);
    // The place has had its opening.
    expect((await openings()).get(cellar)).toBe(true);
    await expectLedgerAddsUp();
  });

  it('the Cellar’s next count is an ordinary one: flagged above three, in Discrepancies and Shrinkage', async () => {
    const take = await count([{ stockItemId: socks.m, locationId: cellar, countedQuantity: 20 }]);
    expect(take.lines).toEqual([expect.objectContaining({ expectedQuantity: 25, difference: -5, flagged: true, opening: false })]);
    const reports = await reportsToday();
    expect(reports.discrepancies.filter((d) => d.locationId === cellar).map((d) => [d.stockItemId, d.difference, d.flagged])).toEqual([
      [socks.m, -5, true],
    ]);
    expect(reports.shrinkage.find((s) => s.stockItemId === socks.m)).toMatchObject({ countVariance: -5, total: -5, lossSatang: 5 * 3500 });
    await expectLedgerAddsUp();
  });
});

// --- F3 --------------------------------------------------------------------------------------

describe('F3 — the attention rows carry what the Alerts screen shows', () => {
  it('a below-par row names the place by id, with its level and par; an open order keeps the row listed', async () => {
    const plush = await itemIdOf('MR-PLUSH');
    const keyring = await itemIdOf('MR-KEYRING');
    await ctx.db.transaction((tx) => syncStockAttention(tx, { operatorId, branchId }, new Date()));
    const rows = await attention();
    const low = rows.filter((r) => r.kind === 'low_stock' || r.kind === 'reorder');
    expect(low.length).toBeGreaterThan(0);
    for (const r of low) {
      expect(r.lowStock).not.toBeNull();
      for (const b of r.lowStock!.belowPar) {
        expect(b.locationId).toBe(places.get(b.place));
        expect(b.level).toBeLessThan(b.par);
      }
      expect(r.lowStock!.reorder).toBe(r.kind === 'reorder');
    }
    expect(rows.filter((r) => r.kind === 'stock_shortfall' || r.kind === 'size_unknown').every((r) => r.lowStock === null)).toBe(true);

    // The plush is under its FOH par (4 of 8): flagged, and still listed once an
    // open order covers it, so the card can show the order beside the transfer.
    const flagged = low.find((r) => r.stockItemId === plush || r.stockItemId === keyring);
    expect(flagged).toBeDefined();
    await ctx.db.transaction((tx) => addToPurchaseOrders(tx, actor(), { lines: [{ stockItemId: flagged!.stockItemId!, quantity: 6 }] }, new Date()));
    const after = await attention();
    expect(after.some((r) => r.id === flagged!.id)).toBe(true);
    expect(after.filter((r) => r.kind === 'low_stock' || r.kind === 'reorder')).toHaveLength(low.length);
  });

  it('the 30-day usage rule reaches the row: reorderRule "trend", the point and the usage', async () => {
    const bottle = await itemIdOf('MR-BOTTLE');
    // 25 sold over the 30 days before today, the first exactly 30 days ago (BOH 22, FOH 8 → BOH 0, FOH 5).
    for (const [n, place, q] of [
      [-30, 'BOH', 1],
      [-20, 'BOH', 8],
      [-10, 'BOH', 8],
      [-2, 'BOH', 5],
      [-2, 'FOH', 3],
    ] as const) {
      await ctx.db.transaction((tx) =>
        applyMovements(
          tx,
          { operatorId, branchId, businessDate: dayOf(n), occurredAt: at(n), actorAccountId: receptionId },
          [{ stockItemId: bottle, stockLocationId: places.get(place)!, kind: 'sale', quantity: -q, actionId: `fix-trend:${n}:${place}` }],
        ),
      );
    }
    await ctx.db.transaction((tx) => syncStockAttention(tx, { operatorId, branchId }, at(0), [bottle]));
    const row = (await attention()).find((r) => r.stockItemId === bottle)!;
    expect(row.rule).toContain('≤ reorder point (30-day usage)');
    expect(row.lowStock).toMatchObject({ reorder: true, reorderRule: 'trend', staticReorderPoint: 20, usedInWindow: 25, reorderPoint: 9 });
    await expectLedgerAddsUp();
  });
});

// --- F4 --------------------------------------------------------------------------------------

describe('F4 — the till’s strip never counts a retired item', () => {
  it('GET sellable leaves out a retired product, so "N out of stock" never names it', async () => {
    const lanyard = productIds.get('MR-LANYARD')!;
    const [row] = await ctx.db.select().from(product).where(eq(product.id, lanyard));
    expect(row!.active).toBe(false);
    // Its stock item is live (the stock screens still count it) and holds stock.
    expect(await heldBy(await itemIdOf('MR-LANYARD'))).toMatchObject({ BOH: 4 });
    const res = await call('GET', stockUrl('/sellable'), reception);
    expect(res.statusCode).toBe(200);
    const body = res.json() as SellableStock;
    expect(body.products.some((p) => p.productId === lanyard)).toBe(false);
    expect(body.products.some((p) => p.name.includes('(retired)'))).toBe(false);
    // An archived product too.
    const keyring = productIds.get('MR-KEYRING')!;
    expect((res.json() as SellableStock).products.some((p) => p.productId === keyring)).toBe(true);
    await ctx.db.update(product).set({ archivedAt: new Date() }).where(eq(product.id, keyring));
    const after = (await call('GET', stockUrl('/sellable'), reception)).json() as SellableStock;
    expect(after.products.some((p) => p.productId === keyring)).toBe(false);
    await ctx.db.update(product).set({ archivedAt: null }).where(eq(product.id, keyring));
  });
});
