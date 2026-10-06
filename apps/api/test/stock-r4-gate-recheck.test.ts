import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, factStockDaily, product, station, stockAttention, stockItem, stockLocation, stockMovement } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  STOCK_RULE_REORDER_TREND,
  type BridgeSaleAnswer,
  type StockReports,
} from '@oto/shared';
import { BRANCH_MANAGER, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { refundSale } from '../src/services/refunds';
import {
  applyMovements,
  commitStockTake,
  runStockDailyJob,
  stockDayFacts,
  syncStockAttention,
  writeStockDailyFacts,
  type StockActor,
} from '../src/services/stock';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-14b ROUND 4 — GATE RE-CHECK (round 4 of the gate). Constructions of the
 * gate's own, independent of the builder's walk and the first gate:
 *
 *   A. an offline sale the record can only half fill (a count lands while the
 *      box is offline), synced with its shortfall, refunded whole, then counted
 *      again — every report, cost of goods and the day's fact against an
 *      independent per-kind hand-sum, sign-exact;
 *   B. a late offline sale that empties a size on an earlier day — the stored
 *      fact of the following (quiet) day must follow the ledger, so the chain
 *      opening(d) = closing(d − 1) holds for every stored day;
 *   C. the trend window's edges inside syncStockAttention: a sale 31 days back
 *      (history, not window), 30 days back (window), today (neither).
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

async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.stock_item_id, l.stock_location_id, l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  expect((rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved || r.quantity < 0)).toEqual([]);
}

async function heldBy(stockItemId: string): Promise<Record<string, number>> {
  const { rows } = await ctx.db.execute<{ place: string; quantity: number }>(sql`
    select loc.name as place, l.quantity from pos.stock_level l
      join pos.stock_location loc on loc.id = l.stock_location_id
     where l.stock_item_id = ${stockItemId}::uuid`);
  return Object.fromEntries(rows.map((r) => [r.place, r.quantity]));
}

/** Independent per-kind sums over a range of business dates. */
async function handSum(stockItemId: string, from: string, to: string): Promise<Record<string, number>> {
  const { rows } = await ctx.db.execute<{ kind: string; q: string; s: string; n: string }>(sql`
    select kind, sum(quantity)::bigint as q, sum(shortfall)::bigint as s,
           count(*) filter (where quantity < 0)::bigint as n
      from pos.stock_movement
     where stock_item_id = ${stockItemId}::uuid and business_date between ${from}::date and ${to}::date
     group by kind`);
  const out: Record<string, number> = { shortfall: 0 };
  for (const r of rows) {
    out[r.kind] = Number(r.q);
    out[`${r.kind}:neg`] = Number(r.n);
    out.shortfall! += Number(r.s);
  }
  return out;
}

async function itemIdOf(code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: stockItem.id })
    .from(stockItem)
    .innerJoin(product, eq(product.id, stockItem.productId))
    .where(and(eq(stockItem.branchId, branchId), eq(product.code, code), isNull(stockItem.archivedAt)));
  return row!.id;
}

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
  plush = await itemIdOf('MR-PLUSH');
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

  agent = boxAgent(box1.id, 'gate-r4-recheck-box-1');
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

describe('A — offline sale half-filled (shortfall) + its refund + two counts: every figure is the ledger', () => {
  const walk: { saleId?: string } = {};

  it('the box sells 3 plush offline; a count empties the shelves before it syncs; the sync records 2 taken and 1 short', async () => {
    await agent.syncStock();
    expect(await heldBy(plush)).toMatchObject({ BOH: 14, FOH: 4 });
    await agent.setOffline(true, { reason: 'gate r4 recheck' });
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
    walk.saleId = order.saleId;
    // While the box is offline, the platform's count finds FOH 1, BOH 1 (−3, −13).
    await ctx.db.transaction((tx) =>
      commitStockTake(
        tx,
        actor(),
        {
          lines: [
            { stockItemId: plush, locationId: places.get('FOH')!, countedQuantity: 1 },
            { stockItemId: plush, locationId: places.get('BOH')!, countedQuantity: 1 },
          ],
        },
        new Date(),
      ),
    );
    link.cut = false;
    await agent.setOffline(false);
    await drain();
    const moved = await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, order.saleId));
    expect(moved.every((m) => m.kind === 'offline_sale')).toBe(true);
    expect(moved.reduce((n, m) => n + m.quantity, 0)).toBe(-2);
    expect(moved.reduce((n, m) => n + m.shortfall, 0)).toBe(1);
    expect(await heldBy(plush)).toMatchObject({ BOH: 0, FOH: 0 });
    await expectLedgerAddsUp();
  });

  it('refunded whole: all 3 the guest hands back go on a shelf (2 taken + 1 short, round 1’s restock); a second count FOH 2, BOH 0', async () => {
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: receptionId, operatorId, stationId: till1, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        walk.saleId!,
        { mode: 'whole', reason: 'Gate r4 recheck' },
      ),
    );
    const refunds = await ctx.db
      .select()
      .from(stockMovement)
      .where(and(eq(stockMovement.saleId, walk.saleId!), eq(stockMovement.kind, 'refund')));
    expect(refunds.reduce((n, m) => n + m.quantity, 0)).toBe(3);
    const held = await heldBy(plush);
    await ctx.db.transaction((tx) =>
      commitStockTake(
        tx,
        actor(),
        {
          lines: [
            { stockItemId: plush, locationId: places.get('FOH')!, countedQuantity: 2 },
            { stockItemId: plush, locationId: places.get('BOH')!, countedQuantity: 0 },
          ],
        },
        new Date(),
      ),
    );
    expect(held.FOH! + held.BOH!).toBe(3);
    expect(await heldBy(plush)).toMatchObject({ BOH: 0, FOH: 2 });
    await expectLedgerAddsUp();
  });

  it('every report, cost of goods and the day’s fact equal the independent hand-sum, sign-exact', async () => {
    const hand = await handSum(plush, today, today);
    expect(hand.offline_sale).toBe(-2);
    expect(hand.shortfall).toBe(1);
    expect(hand.refund).toBe(3);
    const res = await call(managerCookie, 'GET', `/branches/${branchId}/stock/reports?from=${today}&to=${today}`);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const r = res.body as unknown as StockReports;
    const usage = r.usage.find((u) => u.stockItemId === plush)!;
    // Sold = taken + taken past the record; refunded = what went back on a shelf.
    expect(usage).toMatchObject({ sold: 3, soldOffline: 3, refunded: 3, net: 0, costSatang: 0 });
    const { rows: openingRows } = await ctx.db.execute<{ q: string }>(sql`
      select coalesce(sum(m.quantity), 0)::bigint as q from pos.stock_movement m
        join pos.stock_take_line l on l.id = m.stock_take_line_id join pos.stock_take t on t.id = l.stock_take_id
       where m.stock_item_id = ${plush}::uuid and t.opening and m.business_date = ${today}::date`);
    const openingCount = Number(openingRows[0]!.q);
    const variance = hand.count! - openingCount;
    const shrink = r.shrinkage.find((s) => s.stockItemId === plush)!;
    expect(shrink).toMatchObject({ countVariance: variance, adjustedDown: 0, total: variance, lossSatang: -variance * 16_000 });
    const disc = r.discrepancies.filter((d) => d.stockItemId === plush);
    expect(disc.reduce((n, d) => n + d.difference, 0)).toBe(variance);
    expect(disc.filter((d) => d.difference < 0).length).toBe(shrink.countedShort);
    const value = r.value.find((v) => v.stockItemId === plush)!;
    const onHand = hand.count! + hand.offline_sale! + hand.refund!;
    expect(value).toMatchObject({ onHand, valueSatang: onHand * 16_000, retiredOnHand: 0 });
    const cogs = await call(managerCookie, 'GET', `/branches/${branchId}/stock/reports/cost-of-goods?from=${today}&to=${today}`);
    expect(cogs.statusCode, JSON.stringify(cogs.body)).toBe(200);
    expect((cogs.body.rows as Array<{ productId: string }>).find((c) => c.productId === plushProduct)).toMatchObject({
      quantity: usage.net,
      cogsSatang: usage.costSatang,
      costTracked: true,
    });
    const fact = (await stockDayFacts(ctx.db, branchId, today)).find((f) => f.stockItemId === plush)!;
    expect(fact).toMatchObject({
      opening: 0,
      sold: hand.offline_sale,
      refunded: hand.refund,
      counted: hand.count,
      shortfall: hand.shortfall,
      adjusted: 0,
      received: 0,
      closing: onHand,
    });
    // Usage and the fact tell the same story in their own signs.
    expect(usage.sold).toBe(-fact.sold + fact.shortfall);
    expect(usage.refunded).toBe(fact.refunded);
    await expectLedgerAddsUp();
  });
});

describe('B — a late offline sale empties a size on an earlier day: the stored quiet day follows', () => {
  it('fact(d) for every stored day d satisfies opening(d) = closing(d − 1) = Σ movements before d', async () => {
    const cap = await itemIdOf('MR-CAP');
    const boh = places.get('BOH')!;
    const d3 = addDaysToIsoDate(today, -3);
    const d2 = addDaysToIsoDate(today, -2);
    const d1 = addDaysToIsoDate(today, -1);
    // Three days ago, 5 caps were received at BOH (the seed's opening is dated today).
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: d3, occurredAt: new Date(), actorAccountId: receptionId }, [
        { stockItemId: cap, stockLocationId: boh, kind: 'receive', quantity: 5, actionId: 'gate-r4-recheck:cap-receive', unitCostSatang: 9_000 },
      ]),
    );
    // The job closes yesterday: the cap opened and closed it at 5, with no movement of its own.
    await writeStockDailyFacts(ctx.db, branchId, d2);
    await writeStockDailyFacts(ctx.db, branchId, d1);
    const [before] = await ctx.db
      .select()
      .from(factStockDaily)
      .where(and(eq(factStockDaily.stockItemId, cap), eq(factStockDaily.businessDate, d1)));
    expect(before).toMatchObject({ opening: 5, closing: 5 });

    // A box that was offline two days ago sold those 5; it syncs now.
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: d2, occurredAt: new Date(), actorAccountId: null, offline: true }, [
        { stockItemId: cap, stockLocationId: boh, kind: 'offline_sale', quantity: -5, actionId: 'gate-r4-recheck:cap-late', unitCostSatang: 9_000 },
      ]),
    );
    // The job runs again (it rewrites the last seven ended days).
    await runStockDailyJob(ctx.db, new Date());
    const stored = (await ctx.db.select().from(factStockDaily).where(eq(factStockDaily.stockItemId, cap))).sort((a, b) =>
      a.businessDate.localeCompare(b.businessDate),
    );
    for (const f of stored) {
      const { rows } = await ctx.db.execute<{ q: string }>(sql`
        select coalesce(sum(quantity), 0)::bigint as q from pos.stock_movement
         where stock_item_id = ${cap}::uuid and business_date < ${f.businessDate}::date`);
      const { rows: through } = await ctx.db.execute<{ q: string }>(sql`
        select coalesce(sum(quantity), 0)::bigint as q from pos.stock_movement
         where stock_item_id = ${cap}::uuid and business_date <= ${f.businessDate}::date`);
      // The stored row must say what the ledger says of that day — or not exist.
      expect({ day: f.businessDate, opening: f.opening, closing: f.closing }).toEqual({
        day: f.businessDate,
        opening: Number(rows[0]!.q),
        closing: Number(through[0]!.q),
      });
    }
    const d2Row = stored.find((f) => f.businessDate === d2);
    expect(d2Row).toMatchObject({ opening: 5, sold: -5, closing: 0 });
    await expectLedgerAddsUp();
  });
});

describe('C — the trend window’s edges inside the attention re-read', () => {
  it('a sale 31 days back is history only, 30 days back is in the window, today is not; the row names the trend rule', async () => {
    const keyring = await itemIdOf('MR-KEYRING');
    const foh = places.get('FOH')!;
    // Seed: keyring holds nothing, static point 5, lead 14 days. Stock it, then sell.
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: addDaysToIsoDate(today, -40), occurredAt: new Date(), actorAccountId: receptionId }, [
        { stockItemId: keyring, stockLocationId: foh, kind: 'receive', quantity: 100, actionId: 'gate-r4-recheck:key-receive' },
      ]),
    );
    const sell = async (back: number, q: number) =>
      ctx.db.transaction((tx) =>
        applyMovements(tx, { operatorId, branchId, businessDate: addDaysToIsoDate(today, -back), occurredAt: new Date(), actorAccountId: receptionId }, [
          { stockItemId: keyring, stockLocationId: foh, kind: 'sale', quantity: -q, actionId: `gate-r4-recheck:key-sale:${back}` },
        ]),
      );
    await sell(31, 10);
    await sell(30, 30);
    await sell(0, 60);
    expect((await heldBy(keyring)).FOH).toBe(0);
    await ctx.db.transaction((tx) => syncStockAttention(tx, { operatorId, branchId }, new Date(), [keyring]));
    const [row] = await ctx.db
      .select()
      .from(stockAttention)
      .where(and(eq(stockAttention.stockItemId, keyring), isNull(stockAttention.resolvedAt), eq(stockAttention.kind, 'reorder')));
    // used 30 (only the day-30 sale), lead 14 → ceil(30 × 14 / 30) = 14.
    expect(row).toBeDefined();
    expect(row!.rule?.startsWith(STOCK_RULE_REORDER_TREND)).toBe(true);
    expect(row!.detail).toMatchObject({ reorderRule: 'trend', reorderPoint: 14, staticReorderPoint: 5, usedInWindow: 30, total: 0 });
    expect(row!.quantity).toBe(14);
    // The read is a read: nothing changes under GET.
    const before = row!.updatedAt.getTime();
    const got = await call(managerCookie, 'GET', `/branches/${branchId}/stock/attention`);
    expect(got.statusCode).toBe(200);
    const [again] = await ctx.db.select().from(stockAttention).where(eq(stockAttention.id, row!.id));
    expect(again!.updatedAt.getTime()).toBe(before);
    await expectLedgerAddsUp();
  });
});
