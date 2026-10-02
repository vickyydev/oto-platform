import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, factStockDaily, product, sale, station, stockAttention, stockItem, stockLocation, stockMovement } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  reorderPointFor,
  type BridgeSaleAnswer,
  type StockReports,
} from '@oto/shared';
import { BRANCH_MANAGER, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { refundSale } from '../src/services/refunds';
import {
  adjustStock,
  applyMovements,
  commitStockTake,
  runStockDailyJob,
  stockDayFacts,
  syncStockAttention,
  transferStock,
  updateLocation,
  writeStockDailyFacts,
  type StockActor,
} from '../src/services/stock';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-14b ROUND 4 — THE GATE'S OWN CONSTRUCTIONS (independent of the builder's
 * walk): an offline sale on the box, synced, then refunded, then a count and a
 * correction up — every report and the day's fact hand-summed from the ledger
 * by an independent query; the low-stock row raised by the sync without any
 * read; the trend rule with a window of refunds only; and a place retired while
 * it still holds stock, against the Value report.
 */

let ctx: TestContext;
let tillCookie: string;
let managerCookie: string;
let operatorId: string;
let branchId: string;
let till1: string;
let receptionId: string;
let managerId: string;
let plushProduct: string;
let plush: string;
let places: Map<string, string>;
let today: string;
let unitSatang: number;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };

function boxAgent(boxId: string, name: string): BoxAgent {
  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = (url, init) => through(url, init);
  return createBoxAgent({
    apiBaseUrl: `http://${name}.test`,
    credentials: memoryCredentialStore(),
    hostname: name,
    fetch,
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { enabled: false },
    bands: { key: currentBandKey },
  });
}

async function call(cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    for (let j = 0; j < 10; j += 1) {
      const outcome = await agent.outbox()!.flush().catch(() => ({ state: 'deferred' as const }));
      if (outcome.state !== 'pushed') break;
    }
    if ((await agent.outbox()!.depth()).queued === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const actor = (): StockActor => ({ operatorId, branchId, accountId: managerId, requestId: null, stationId: null });

/** Every level is the sum of its movements and none is below zero — the round 1 invariant. */
async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.stock_item_id, l.stock_location_id, l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  expect((rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved || r.quantity < 0)).toEqual([]);
}

/** An independent hand-sum per kind for one item and one business date. */
async function handSum(stockItemId: string, day: string): Promise<Record<string, number>> {
  const { rows } = await ctx.db.execute<{ kind: string; q: string; s: string }>(sql`
    select kind, sum(quantity)::bigint as q, sum(shortfall)::bigint as s from pos.stock_movement
     where stock_item_id = ${stockItemId}::uuid and business_date = ${day}::date group by kind`);
  const out: Record<string, number> = { shortfall: 0 };
  for (const r of rows) {
    out[r.kind] = Number(r.q);
    out.shortfall! += Number(r.s);
  }
  return out;
}

const walk: { offlineSale?: string } = {};

beforeAll(async () => {
  ctx = await createTestContext();
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  till1 = t1!.id;
  branchId = t1!.branchId;
  operatorId = t1!.operatorId;
  tillCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  expect((await call(tillCookie, 'PUT', '/me/session/station', { stationId: till1 })).statusCode).toBe(200);
  receptionId = (await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)))[0]!.id;
  managerId = (await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone)))[0]!.id;
  const [p] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'MR-PLUSH'), isNull(product.archivedAt)));
  plushProduct = p!.id;
  const [item] = await ctx.db
    .select()
    .from(stockItem)
    .where(and(eq(stockItem.branchId, branchId), eq(stockItem.productId, plushProduct), isNull(stockItem.archivedAt)));
  plush = item!.id;
  places = new Map((await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))).map((l) => [l.name, l.id]));
  const { rows } = await ctx.db.execute<{ timezone: string; day_start: string }>(sql`
    select timezone, business_day_start::text as day_start from core.branch where id = ${branchId}::uuid`);
  today = businessDate(new Date(), rows[0]!.timezone, parseDayStart(rows[0]!.day_start));
  const quoted = await call(tillCookie, 'POST', '/sales/quote', {
    stationId: till1,
    items: [{ id: newId(), productId: plushProduct, quantity: 1 }],
    channel: 'shop',
  });
  expect(quoted.statusCode, JSON.stringify(quoted.body)).toBe(200);
  unitSatang = (quoted.body.quote as { totals: { grossSatang: number } }).totals.grossSatang;

  agent = boxAgent(box1.id, 'gate-r4-box-1');
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  attachInProcessBox(agent);
}, 240_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
});

describe('gate r4 — offline sale, its refund, a count and a correction up: every figure is the ledger hand-summed', () => {
  it('the box sells 3 plush offline; sync lands one offline_sale and raises the plush’s low-stock row without any read', async () => {
    // False when the snapshot syncCache took is still current — either way the box holds it.
    await agent.syncStock();
    await agent.setOffline(true, { reason: 'gate r4' });
    link.cut = true;
    const total = 3 * unitSatang;
    const order = {
      saleId: newId(),
      actionId: `pay-${newId().slice(-12)}`,
      staffName: 'Nok',
      cart: { items: [{ id: newId(), productId: plushProduct, quantity: 3 }], channel: 'shop', expectedTotalSatang: total },
      tender: { actionId: `cash-${newId().slice(-12)}`, method: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total, changeSatang: 0 },
    };
    const sold = await call(tillCookie, 'POST', `/box/v1/station/${till1}/intents`, {
      type: 'sale.finalise',
      lastSeenSequence: 0,
      payload: order,
      actionId: `s-${newId().slice(-12)}`,
    });
    expect(sold.statusCode, JSON.stringify(sold.body)).toBe(200);
    expect((sold.body.result as BridgeSaleAnswer).finalised).toBe(true);
    walk.offlineSale = order.saleId;
    link.cut = false;
    await agent.setOffline(false);
    await drain();
    expect(await ctx.db.select().from(sale).where(eq(sale.id, order.saleId))).toHaveLength(1);
    const moved = await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, order.saleId));
    expect(moved.map((m) => [m.kind, m.stockLocationId, m.quantity, m.shortfall])).toEqual([['offline_sale', places.get('FOH'), -3, 0]]);
    // FOH 1, par 8: the sync's own decrement re-read the plush (Q4) — no GET was made.
    const [row] = await ctx.db
      .select()
      .from(stockAttention)
      .where(and(eq(stockAttention.dedupeKey, `low_stock:${branchId}:${plushProduct}`), isNull(stockAttention.resolvedAt)));
    expect(row).toMatchObject({ kind: 'low_stock', rule: 'Below par at FOH' });
    await expectLedgerAddsUp();
  });

  it('the synced offline sale is refunded whole; a count finds FOH 2 short; a correction up of 1 at BOH', async () => {
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: receptionId, operatorId, stationId: till1, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        walk.offlineSale!,
        { mode: 'whole', reason: 'Gate r4' },
      ),
    );
    const refund = await ctx.db
      .select()
      .from(stockMovement)
      .where(and(eq(stockMovement.saleId, walk.offlineSale!), eq(stockMovement.kind, 'refund')));
    expect(refund.map((m) => [m.stockLocationId, m.quantity])).toEqual([[places.get('FOH'), 3]]);
    // FOH back at 4: still below par 8, row stays open.
    const now = new Date();
    await ctx.db.transaction((tx) =>
      commitStockTake(
        tx,
        actor(),
        {
          lines: [
            { stockItemId: plush, locationId: places.get('FOH')!, countedQuantity: 2 },
            { stockItemId: plush, locationId: places.get('BOH')!, countedQuantity: 14 },
          ],
        },
        now,
      ),
    );
    await ctx.db.transaction((tx) =>
      adjustStock(tx, actor(), { stockItemId: plush, locationId: places.get('BOH')!, delta: 1, reason: 'Found one' }, now),
    );
    await expectLedgerAddsUp();
  });

  it('every report equals the hand-summed ledger, sign-exact', async () => {
    const res = await call(managerCookie, 'GET', `/branches/${branchId}/stock/reports?from=${today}&to=${today}`);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const r = res.body as unknown as StockReports;
    const hand = await handSum(plush, today);
    // Opening take 18 + variance −2 on the counted shelf.
    expect(hand).toMatchObject({ count: 16, offline_sale: -3, refund: 3, adjust: 1, shortfall: 0 });
    expect(r.usage.find((u) => u.stockItemId === plush)).toMatchObject({
      sold: -hand.offline_sale!,
      refunded: hand.refund,
      net: 0,
      soldOffline: 3,
      costSatang: 0,
    });
    // A correction UP is not shrinkage; the count's −2 is.
    expect(r.shrinkage.find((s) => s.stockItemId === plush)).toMatchObject({
      countVariance: -2,
      countedShort: 1,
      adjustedDown: 0,
      total: -2,
      lossSatang: 2 * 16_000,
      costMissing: false,
    });
    expect(r.discrepancies.filter((d) => d.stockItemId === plush).map((d) => [d.locationName, d.difference]).sort()).toEqual([
      ['BOH', 0],
      ['FOH', -2],
    ]);
    const onHand = hand.count! + hand.offline_sale! + hand.refund! + hand.adjust!;
    expect(onHand).toBe(17);
    expect(r.value.find((v) => v.stockItemId === plush)).toMatchObject({ onHand: 17, valueSatang: 17 * 16_000 });
    const cogs = await call(managerCookie, 'GET', `/branches/${branchId}/stock/reports/cost-of-goods?from=${today}&to=${today}`);
    expect(cogs.statusCode, JSON.stringify(cogs.body)).toBe(200);
    expect((cogs.body.rows as Array<{ productId: string }>).find((c) => c.productId === plushProduct)).toMatchObject({
      quantity: 0,
      cogsSatang: 0,
      costTracked: true,
    });
  });

  it('the day’s fact: every size, every figure, equals an independent per-kind hand-sum; closing = the shelves; a rerun writes nothing', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    await runStockDailyJob(ctx.db, tomorrow);
    const facts = await ctx.db.select().from(factStockDaily).where(and(eq(factStockDaily.branchId, branchId), eq(factStockDaily.businessDate, today)));
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      const hand = await handSum(f.stockItemId, today);
      const { rows } = await ctx.db.execute<{ q: string }>(sql`
        select coalesce(sum(quantity), 0)::bigint as q from pos.stock_movement
         where stock_item_id = ${f.stockItemId}::uuid and business_date < ${today}::date`);
      const opening = Number(rows[0]!.q);
      expect({
        opening: f.opening,
        sold: f.sold,
        refunded: f.refunded,
        received: f.received,
        adjusted: f.adjusted,
        counted: f.counted,
        shortfall: f.shortfall,
        transferred: f.transferred,
      }).toEqual({
        opening,
        sold: (hand.sale ?? 0) + (hand.offline_sale ?? 0),
        refunded: hand.refund ?? 0,
        received: hand.receive ?? 0,
        adjusted: hand.adjust ?? 0,
        counted: hand.count ?? 0,
        shortfall: hand.shortfall,
        transferred: hand.transfer_in ?? 0,
      });
      expect(f.opening + f.sold + f.refunded + f.received + f.adjusted + f.counted).toBe(f.closing);
      const { rows: lvl } = await ctx.db.execute<{ q: string }>(sql`
        select coalesce(sum(quantity), 0)::bigint as q from pos.stock_level where stock_item_id = ${f.stockItemId}::uuid`);
      expect(f.closing).toBe(Number(lvl[0]!.q));
    }
    const mine = facts.find((f) => f.stockItemId === plush)!;
    expect(mine).toMatchObject({ opening: 0, counted: 16, sold: -3, refunded: 3, adjusted: 1, closing: 17, valueSatang: 17 * 16_000 });
    expect((await writeStockDailyFacts(ctx.db, branchId, today, tomorrow)).written).toBe(0);
    expect((await runStockDailyJob(ctx.db, tomorrow)).rowsWritten).toBe(0);
  });

  it('a late offline sale dated yesterday corrects yesterday AND moves today’s opening; the next run rewrites exactly the three days it moved', async () => {
    const yesterday = addDaysToIsoDate(today, -1);
    const dayAfter = new Date(Date.now() + 2 * 86_400_000);
    await runStockDailyJob(ctx.db, dayAfter);
    expect((await runStockDailyJob(ctx.db, dayAfter)).rowsWritten).toBe(0);
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: yesterday, occurredAt: new Date(), actorAccountId: null, offline: true }, [
        { stockItemId: plush, stockLocationId: places.get('FOH')!, kind: 'offline_sale', quantity: -1, actionId: 'gate-r4:late' },
      ]),
    );
    const run = await runStockDailyJob(ctx.db, dayAfter);
    // yesterday (new row), today (opening and closing moved), tomorrow (opening moved — the job writes the last 7 ended days)
    const plushDays = (await ctx.db.select().from(factStockDaily).where(eq(factStockDaily.stockItemId, plush))).sort((a, b) =>
      a.businessDate.localeCompare(b.businessDate),
    );
    expect(plushDays.map((d) => [d.businessDate, d.opening, d.closing])).toEqual([
      [yesterday, 0, -1],
      [today, -1, 16],
      [addDaysToIsoDate(today, 1), 16, 16],
    ]);
    expect(run.rowsWritten).toBe(3);
    for (const d of plushDays) expect(d.opening + d.sold + d.refunded + d.received + d.adjusted + d.counted).toBe(d.closing);
    await expectLedgerAddsUp();
  });
});

describe('gate r4 — the trend rule edges', () => {
  it('reorderPointFor: day 29 static, day 30 trend; zero usage is a point of 0; net-negative usage clamps to 0; lead 0 still has a day of cover', () => {
    const base = { staticPoint: 20, leadTimeDays: 10, firstSaleDate: '2026-01-01' };
    expect(reorderPointFor({ ...base, today: addDaysToIsoDate('2026-01-01', 29), usedInWindow: 99 })).toMatchObject({ rule: 'static', reorderPoint: 20 });
    expect(reorderPointFor({ ...base, today: addDaysToIsoDate('2026-01-01', 30), usedInWindow: 30 })).toMatchObject({ rule: 'trend', reorderPoint: 11 });
    expect(reorderPointFor({ ...base, today: '2026-03-01', usedInWindow: 0 })).toMatchObject({ rule: 'trend', reorderPoint: 0 });
    expect(reorderPointFor({ ...base, today: '2026-03-01', usedInWindow: -12 })).toMatchObject({ rule: 'trend', reorderPoint: 0, usedInWindow: 0 });
    expect(reorderPointFor({ ...base, leadTimeDays: 0, today: '2026-03-01', usedInWindow: 31 })).toMatchObject({ rule: 'trend', reorderPoint: 2 });
    expect(reorderPointFor({ ...base, firstSaleDate: null, today: '2026-03-01', usedInWindow: 0 })).toMatchObject({ rule: 'static', reorderPoint: 20 });
  });

  it('the cap: sold 40 days ago, all refunded inside the window — trend, point 0, never negative; the row is below par only', async () => {
    const [cap] = await ctx.db
      .select({ id: stockItem.id })
      .from(stockItem)
      .innerJoin(product, eq(product.id, stockItem.productId))
      .where(and(eq(stockItem.branchId, branchId), eq(product.code, 'MR-CAP'), isNull(stockItem.archivedAt)));
    const capId = cap!.id;
    const boh = places.get('BOH')!;
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: addDaysToIsoDate(today, -40), occurredAt: new Date(), actorAccountId: receptionId }, [
        { stockItemId: capId, stockLocationId: boh, kind: 'sale', quantity: -6, actionId: 'gate-r4:cap-sale' },
      ]),
    );
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: addDaysToIsoDate(today, -5), occurredAt: new Date(), actorAccountId: receptionId }, [
        { stockItemId: capId, stockLocationId: boh, kind: 'refund', quantity: 6, actionId: 'gate-r4:cap-refund' },
      ]),
    );
    await ctx.db.transaction((tx) => syncStockAttention(tx, { operatorId, branchId }, new Date(), [capId]));
    const [row] = await ctx.db
      .select()
      .from(stockAttention)
      .where(and(eq(stockAttention.stockItemId, capId), isNull(stockAttention.resolvedAt)));
    // Trend governs (first sale 40 days back), the window nets to −6 → clamped to 0 → point 0:
    // 25 on hand is above it, so the reorder rule does not fire; FOH 7 < par 10 does.
    expect(row).toMatchObject({ kind: 'low_stock', rule: 'Below par at FOH' });
    expect(row!.quantity).toBeGreaterThanOrEqual(0);
    // Fix-round finding 2: the row was written under the static rule by the whole-branch
    // re-read of the count/adjust above; its kind/rule/quantity/summary are unchanged, but
    // its detail follows the trend now — it no longer goes stale.
    expect(row!.detail).toMatchObject({ reorderRule: 'trend', reorderPoint: 0, usedInWindow: 0 });
    // And a re-read with nothing changed writes nothing (jsonb key order does not count as a change).
    const later = new Date(Date.now() + 60_000);
    await ctx.db.transaction((tx) => syncStockAttention(tx, { operatorId, branchId }, later, [capId]));
    await ctx.db.transaction((tx) => syncStockAttention(tx, { operatorId, branchId }, later));
    const [again] = await ctx.db.select().from(stockAttention).where(eq(stockAttention.id, row!.id));
    expect(again!.updatedAt.getTime()).toBe(row!.updatedAt.getTime());
    await expectLedgerAddsUp();
  });
});

describe('gate r4 — a place retired while it holds stock', () => {
  it('Value counts what the record holds — the fact’s closing — not only the live places', async () => {
    await ctx.db.transaction((tx) =>
      transferStock(
        tx,
        actor(),
        { fromLocationId: places.get('BOH')!, toLocationId: places.get('Store')!, lines: [{ stockItemId: plush, quantity: 2 }] },
        new Date(),
      ),
    );
    await ctx.db.transaction((tx) => updateLocation(tx, actor(), places.get('Store')!, { active: false }, new Date()));
    const { rows } = await ctx.db.execute<{ q: string }>(sql`
      select coalesce(sum(quantity), 0)::bigint as q from pos.stock_level where stock_item_id = ${plush}::uuid`);
    const held = Number(rows[0]!.q);
    const fact = (await stockDayFacts(ctx.db, branchId, today)).find((f) => f.stockItemId === plush)!;
    expect(fact.closing).toBe(held);
    const res = await call(managerCookie, 'GET', `/branches/${branchId}/stock/reports?from=${today}&to=${today}`);
    const value = (res.body as unknown as StockReports).value.find((v) => v.stockItemId === plush)!;
    // The day's fact values the same size at what the record holds (17 × ฿160) ...
    expect(fact.valueSatang).toBe(held * 16_000);
    // ... the Value report must say the same of the same moment; it leaves out the 2 on the retired Store shelf.
    expect(value.onHand).toBe(held);
    expect(value.valueSatang).toBe(fact.valueSatang);
    // The retired shelf is listed and its units told apart; the sum of the places is onHand.
    expect(value.byLocation[places.get('Store')!]).toBe(2);
    expect(value.retiredOnHand).toBe(2);
    expect(Object.values(value.byLocation).reduce((n, q) => n + q, 0)).toBe(value.onHand);
    // A retired place holding nothing is left out of byLocation.
    const other = (res.body as unknown as StockReports).value.find((v) => v.stockItemId !== plush && v.retiredOnHand === 0);
    expect(other).toBeDefined();
    expect(Object.keys(other!.byLocation)).not.toContain(places.get('Store'));
  });
});
