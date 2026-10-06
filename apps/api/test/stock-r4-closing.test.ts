import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, factStockDaily, product, sale, station, stockItem, stockLocation, stockMovement } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import { addDaysToIsoDate, businessDate, newId, parseDayStart, type BridgeSaleAnswer, type StockReports } from '@oto/shared';
import { ADMIN, BRANCH_MANAGER, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { refundSale } from '../src/services/refunds';
import { applyMovements, runStockDailyJob, stockDayFacts, writeStockDailyFacts } from '../src/services/stock';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-14b ROUND 4 — THE CLOSING AUDIT (plan docs/progress/plans/stock/PLAN.md
 * §2.5): the whole story of one item, the Oto Mascot Plush (seeded BOH 14,
 * FOH 4, ฿160 a piece), walked end to end through the real routes and a
 * virtual box running the code a Pi runs:
 *
 *   opening count → receive against an order → sale online → refund →
 *   transfer → count with a variance → offline sale on the box → sync →
 *   report figures and the daily fact.
 *
 * At EVERY step the plush's level is asserted equal to the sum of its
 * movements, place by place, and the whole ledger is checked to add up. At the
 * end every report figure is checked against the walk's own arithmetic, and the
 * day's fact reconciles: opening + the day's movements = closing = what the
 * shelves hold. Anything the walk found is recorded as a test below it.
 */

let ctx: TestContext;
let cookies: { till: string; manager: string; admin: string };
let operatorId: string;
let branchId: string;
let till1: string;
let receptionId: string;
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

/** What the plush holds, by place name. */
async function held(): Promise<Record<string, number>> {
  const { rows } = await ctx.db.execute<{ place: string; quantity: number }>(sql`
    select loc.name as place, l.quantity from pos.stock_level l
      join pos.stock_location loc on loc.id = l.stock_location_id
     where l.stock_item_id = ${plush}::uuid`);
  return Object.fromEntries(rows.map((r) => [r.place, r.quantity]));
}

/**
 * THE INVARIANT, at every step: the plush's level at each place is the sum of
 * its movements there; the whole ledger adds up; and nothing is below zero.
 */
async function expectLevelIsLedger(expected: Record<string, number>): Promise<void> {
  const { rows } = await ctx.db.execute<{ place: string; moved: string }>(sql`
    select loc.name as place, coalesce(sum(m.quantity), 0)::bigint as moved
      from pos.stock_location loc
      left join pos.stock_movement m on m.stock_location_id = loc.id and m.stock_item_id = ${plush}::uuid
     where loc.branch_id = ${branchId}::uuid
     group by loc.name`);
  const ledger = Object.fromEntries(rows.map((r) => [r.place, Number(r.moved)]));
  expect(ledger).toEqual(expected);
  expect(await held()).toEqual(expected);
  const { rows: off } = await ctx.db.execute(sql`
    select l.stock_item_id from pos.stock_level l
     where l.quantity < 0 or l.quantity <> coalesce((select sum(m.quantity) from pos.stock_movement m
                                 where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)`);
  expect(off).toEqual([]);
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

const walk: { orderId?: string; onlineSale?: string; offlineSale?: string } = {};

beforeAll(async () => {
  ctx = await createTestContext();
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  till1 = t1!.id;
  branchId = t1!.branchId;
  operatorId = t1!.operatorId;
  cookies = {
    till: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password),
    manager: await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password),
    admin: await signInAs(ctx.app, ADMIN.phone, ADMIN.password),
  };
  expect((await call(cookies.till, 'PUT', '/me/session/station', { stationId: till1 })).statusCode).toBe(200);
  const [r] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionId = r!.id;
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
  places = new Map(
    (await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))).map((l) => [l.name, l.id]),
  );
  const { rows } = await ctx.db.execute<{ timezone: string; day_start: string }>(sql`
    select timezone, business_day_start::text as day_start from core.branch where id = ${branchId}::uuid`);
  today = businessDate(new Date(), rows[0]!.timezone, parseDayStart(rows[0]!.day_start));
  const quoted = await call(cookies.till, 'POST', '/sales/quote', {
    stationId: till1,
    items: [{ id: newId(), productId: plushProduct, quantity: 1 }],
    channel: 'shop',
  });
  expect(quoted.statusCode, JSON.stringify(quoted.body)).toBe(200);
  unitSatang = (quoted.body.quote as { totals: { grossSatang: number } }).totals.grossSatang;

  agent = boxAgent(box1.id, 'closing-box-1');
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

describe('the closing audit: one item, the whole story, the level the sum of its movements throughout', () => {
  it('1. the opening count: BOH 14, FOH 4, as count movements of the opening take', async () => {
    await expectLevelIsLedger({ Store: 0, BOH: 14, FOH: 4 });
    const opening = await ctx.db.execute<{ opening: boolean; quantity: number }>(sql`
      select t.opening, m.quantity from pos.stock_movement m
        join pos.stock_take_line l on l.id = m.stock_take_line_id join pos.stock_take t on t.id = l.stock_take_id
       where m.stock_item_id = ${plush}::uuid order by m.quantity`);
    expect(opening.rows).toEqual([{ opening: true, quantity: 4 }, { opening: true, quantity: 14 }]);
  });

  it('2. receive against an order: 12 on order, placed, all 12 into BOH — the order closes', async () => {
    const added = await call(cookies.manager, 'POST', `/branches/${branchId}/stock/purchase-orders/lines`, {
      lines: [{ stockItemId: plush, quantity: 12 }],
    });
    expect(added.statusCode, JSON.stringify(added.body)).toBe(200);
    const order = (added.body.orders as Array<{ id: string; lines: Array<{ id: string; stockItemId: string }> }>)[0]!;
    walk.orderId = order.id;
    expect((await call(cookies.manager, 'POST', `/branches/${branchId}/stock/purchase-orders/${order.id}/ordered`, {})).statusCode).toBe(200);
    const line = order.lines.find((l) => l.stockItemId === plush)!;
    const got = await call(cookies.till, 'POST', `/branches/${branchId}/stock/purchase-orders/${order.id}/lines/${line.id}/receive`, {
      quantity: 12,
      locationId: places.get('BOH'),
    });
    expect(got.statusCode, JSON.stringify(got.body)).toBe(200);
    expect((got.body.order as { state: string }).state).toBe('received');
    await expectLevelIsLedger({ Store: 0, BOH: 26, FOH: 4 });
  });

  it('3. a sale online: 3 from the counter shelf first', async () => {
    const id = newId();
    expect((await call(cookies.till, 'POST', '/sales', { stationId: till1, id, items: [{ id: newId(), productId: plushProduct, quantity: 3 }] })).statusCode).toBe(200);
    expect((await call(cookies.till, 'POST', `/sales/${id}/finalise`)).statusCode).toBe(200);
    walk.onlineSale = id;
    await expectLevelIsLedger({ Store: 0, BOH: 26, FOH: 1 });
  });

  it('4. its refund: the 3 go back where they came from, once', async () => {
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: receptionId, operatorId, stationId: till1, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        walk.onlineSale!,
        { mode: 'whole', reason: 'Gift, wrong colour' },
      ),
    );
    await expectLevelIsLedger({ Store: 0, BOH: 26, FOH: 4 });
  });

  it('5. a transfer: 6 from the back to the counter, one out-and-in pair', async () => {
    const moved = await call(cookies.till, 'POST', `/branches/${branchId}/stock/transfers`, {
      fromLocationId: places.get('BOH'),
      toLocationId: places.get('FOH'),
      lines: [{ stockItemId: plush, quantity: 6 }],
    });
    expect(moved.statusCode, JSON.stringify(moved.body)).toBe(200);
    await expectLevelIsLedger({ Store: 0, BOH: 20, FOH: 10 });
  });

  it('6. a count with a variance: the counter one short, the back as recorded', async () => {
    const counted = await call(cookies.till, 'POST', `/branches/${branchId}/stock/stock-takes`, {
      lines: [
        { stockItemId: plush, locationId: places.get('FOH'), countedQuantity: 9 },
        { stockItemId: plush, locationId: places.get('BOH'), countedQuantity: 20 },
      ],
    });
    expect(counted.statusCode, JSON.stringify(counted.body)).toBe(200);
    expect((counted.body.lines as Array<{ difference: number; flagged: boolean }>).map((l) => [l.difference, l.flagged])).toEqual([
      [-1, false],
      [0, false],
    ]);
    await expectLevelIsLedger({ Store: 0, BOH: 20, FOH: 9 });
  });

  it('7. an offline sale on the box: the link down, 2 sold from its snapshot — nothing on the ledger yet', async () => {
    expect(await agent.syncStock()).toBe(true);
    await agent.setOffline(true, { reason: 'closing audit' });
    link.cut = true;
    const total = 2 * unitSatang;
    const order = {
      saleId: newId(),
      actionId: `pay-${newId().slice(-12)}`,
      staffName: 'Nok',
      cart: { items: [{ id: newId(), productId: plushProduct, quantity: 2 }], channel: 'shop', expectedTotalSatang: total },
      tender: { actionId: `cash-${newId().slice(-12)}`, method: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total, changeSatang: 0 },
    };
    const sold = await call(cookies.till, 'POST', `/box/v1/station/${till1}/intents`, {
      type: 'sale.finalise',
      lastSeenSequence: 0,
      payload: order,
      actionId: `s-${newId().slice(-12)}`,
    });
    expect(sold.statusCode, JSON.stringify(sold.body)).toBe(200);
    expect((sold.body.result as BridgeSaleAnswer).finalised).toBe(true);
    walk.offlineSale = order.saleId;
    expect(await ctx.db.select().from(sale).where(eq(sale.id, order.saleId))).toHaveLength(0);
    await expectLevelIsLedger({ Store: 0, BOH: 20, FOH: 9 });
  });

  it('8. sync: the box’s sale lands once, as an offline sale off the counter shelf', async () => {
    link.cut = false;
    await agent.setOffline(false);
    await drain();
    expect((await agent.outbox()!.depth()).queued).toBe(0);
    const moved = await ctx.db
      .select()
      .from(stockMovement)
      .where(and(eq(stockMovement.saleId, walk.offlineSale!), eq(stockMovement.kind, 'offline_sale')));
    expect(moved.map((m) => [m.stockLocationId, m.quantity, m.shortfall, m.offline])).toEqual([[places.get('FOH'), -2, 0, true]]);
    await expectLevelIsLedger({ Store: 0, BOH: 20, FOH: 7 });
    // A second push moves nothing twice.
    await drain();
    await expectLevelIsLedger({ Store: 0, BOH: 20, FOH: 7 });
  });

  it('9. the reports say exactly what the walk did', async () => {
    const res = await call(cookies.manager, 'GET', `/branches/${branchId}/stock/reports?from=${today}&to=${today}`);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const r = res.body as unknown as StockReports;
    expect(r.usage.find((u) => u.stockItemId === plush)).toMatchObject({ sold: 5, refunded: 3, net: 2, soldOffline: 2, costSatang: 2 * 16_000 });
    expect(r.shrinkage.find((s) => s.stockItemId === plush)).toMatchObject({ countVariance: -1, countedShort: 1, adjustedDown: 0, total: -1, lossSatang: 16_000 });
    expect(
      r.discrepancies.filter((d) => d.stockItemId === plush).map((d) => [d.locationName, d.difference]).sort(),
    ).toEqual([['BOH', 0], ['FOH', -1]]);
    const order = r.purchases.find((o) => o.id === walk.orderId)!;
    expect(order.lines.find((l) => l.stockItemId === plush)).toMatchObject({ orderedQuantity: 12, receivedQuantity: 12, receivedInLedger: 12, receivedCostSatang: 12 * 16_000 });
    expect(r.value.find((v) => v.stockItemId === plush)).toMatchObject({ onHand: 27, valueSatang: 27 * 16_000, noCostSet: false });

    const cogs = await call(cookies.admin, 'GET', `/branches/${branchId}/stock/reports/cost-of-goods?from=${today}&to=${today}`);
    expect((cogs.body.rows as Array<{ productId: string }>).find((c) => c.productId === plushProduct)).toMatchObject({
      quantity: 2,
      cogsSatang: 2 * 16_000,
      costTracked: true,
    });
  });

  it('10. the day’s fact reconciles: 0 + 17 counted + 12 received − 5 sold + 3 refunded = 27, the shelves’ own figure; a rerun writes nothing', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    await runStockDailyJob(ctx.db, tomorrow);
    const [fact] = await ctx.db
      .select()
      .from(factStockDaily)
      .where(and(eq(factStockDaily.stockItemId, plush), eq(factStockDaily.businessDate, today)));
    expect(fact).toMatchObject({
      opening: 0,
      counted: 17,
      received: 12,
      sold: -5,
      refunded: 3,
      transferred: 6,
      adjusted: 0,
      shortfall: 0,
      closing: 27,
      valueSatang: 27 * 16_000,
    });
    expect(fact!.opening + fact!.counted + fact!.received + fact!.sold + fact!.refunded + fact!.adjusted).toBe(fact!.closing);
    const shelves = Object.values(await held()).reduce((a, b) => a + b, 0);
    expect(fact!.closing).toBe(shelves);
    expect((await writeStockDailyFacts(ctx.db, branchId, today, tomorrow)).written).toBe(0);
    expect((await runStockDailyJob(ctx.db, tomorrow)).rowsWritten).toBe(0);
  });
});

describe('what the audit found, kept as tests', () => {
  it('a movement that ARRIVES after a later-dated one leaves its own day short — the fact records it signed (0050)', async () => {
    // The keyring is out everywhere. Today's delivery of 5 lands first; then a
    // box's sale from YESTERDAY syncs, taking 2 from what the record now holds.
    const [keyringRow] = await ctx.db
      .select({ id: stockItem.id })
      .from(stockItem)
      .innerJoin(product, eq(product.id, stockItem.productId))
      .where(and(eq(stockItem.branchId, branchId), eq(product.code, 'MR-KEYRING'), isNull(stockItem.archivedAt)));
    const keyring = keyringRow!.id;
    const yesterday = addDaysToIsoDate(today, -1);
    const foh = places.get('FOH')!;
    await ctx.db.transaction((tx) =>
      applyMovements(tx, { operatorId, branchId, businessDate: today, occurredAt: new Date(), actorAccountId: receptionId }, [
        { stockItemId: keyring, stockLocationId: foh, kind: 'receive', quantity: 5, actionId: 'r4-found:receive', reason: 'Delivery' },
      ]),
    );
    await ctx.db.transaction((tx) =>
      applyMovements(
        tx,
        { operatorId, branchId, businessDate: yesterday, occurredAt: new Date(), actorAccountId: null, offline: true },
        [{ stockItemId: keyring, stockLocationId: foh, kind: 'offline_sale', quantity: -2, actionId: 'r4-found:offline' }],
      ),
    );
    const before = (await stockDayFacts(ctx.db, branchId, yesterday)).find((f) => f.stockItemId === keyring)!;
    expect(before).toMatchObject({ opening: 0, sold: -2, closing: -2 });
    const day = (await stockDayFacts(ctx.db, branchId, today)).find((f) => f.stockItemId === keyring)!;
    expect(day).toMatchObject({ opening: -2, received: 5, closing: 3 });
    // The level never went below zero — it moved in arrival order — and it is
    // the closing of the latest day.
    const { rows } = await ctx.db.execute<{ q: number }>(sql`
      select coalesce(sum(quantity), 0)::int as q from pos.stock_level where stock_item_id = ${keyring}::uuid`);
    expect(rows[0]!.q).toBe(3);
    // Written without a refusal: the old CHECK would have refused yesterday's row.
    expect((await writeStockDailyFacts(ctx.db, branchId, yesterday)).written).toBeGreaterThan(0);
    const [stored] = await ctx.db
      .select()
      .from(factStockDaily)
      .where(and(eq(factStockDaily.stockItemId, keyring), eq(factStockDaily.businessDate, yesterday)));
    expect(stored).toMatchObject({ closing: -2 });
  });
});
