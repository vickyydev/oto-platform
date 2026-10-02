import { verify as verifyArgon } from '@node-rs/argon2';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  auditLog,
  box,
  product,
  sale,
  station,
  stockAttention,
  stockItem,
  stockLevel,
  stockLocation,
  stockMovement,
  syncAnomaly,
  syncCursor,
  syncEvent,
} from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import { newId, type BridgeSaleAnswer, type StockSnapshotItem } from '@oto/shared';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { applyMovements } from '../src/services/stock';
import { catalogueVersionOf } from '../src/services/sync';
import { stockOversoldAlertKey } from '../src/services/sync-stock';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-14b ROUND 3 — STOCK OFFLINE, THE CLOSING WALK (plan
 * docs/progress/plans/stock/PLAN.md §2.4, §5).
 *
 * Two virtual boxes — Reception Till 1 on box 1, Counter 2 on box 2 — run the
 * code a Pi runs over the platform's own `edge` store, joined to the api by a
 * link the test cuts. The branch holds the LAST TWO Oto Caps, on the counter
 * shelf. Both boxes take the stock snapshot online; the mall's link goes down;
 * each counter sells the same last two caps (box 1 is refused a third, in the
 * counter's words, against its own sales since the snapshot); the link comes
 * back and each box syncs ONCE — box 1's answer is lost on the way back and it
 * sends again, a restart mid-queue. Box 1's sale is within stock and raises
 * nothing; box 2's is filed with what the record held (nothing) plus the
 * shortfall, the level floors at zero, and ONE `stock_oversold` anomaly with
 * ONE critical alert names the item, size, place, box, station and the short
 * quantity. Replaying either push, or the same sale under a new envelope,
 * moves nothing twice. Throughout, every level equals the sum of its
 * movements, and the catalogue's version never moves for a sale.
 */

let ctx: TestContext;
let cookies: { till1: string; counter2: string; admin: string };
let operatorId: string;
let branchId: string;
let till1: string;
let counter2: string;
let box1Id: string;
let box2Id: string;
let capId: string;
let capItemId: string;
let fohId: string;
let capUnitSatang: number;
let catalogueBefore: string;
let agent1: BoxAgent;
let agent2: BoxAgent;
const link1: CuttableLink = { cut: false };
const link2: CuttableLink = { cut: false };
/** Box 1's next push is applied and its answer lost on the way back — a restart mid-queue. */
const dropAnswer = { box1: false };
const sales: { box1?: string; box2?: string } = {};

function stockAgent(boxId: string, name: string, link: CuttableLink, drop?: () => boolean): BoxAgent {
  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = async (url, init) => {
    const res = await through(url, init);
    if (url.includes('/box/v1/sync/push') && drop?.()) throw new Error('ECONNRESET: the answer was lost on the way back');
    return res;
  };
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

async function call(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

async function onBox<T = BridgeSaleAnswer>(
  cookie: string,
  stationId: string,
  type: string,
  payload: Record<string, unknown>,
  expected = 200,
): Promise<{ statusCode: number; body: Record<string, unknown>; result: T }> {
  const res = await call(cookie, 'POST', `/box/v1/station/${stationId}/intents`, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `s-${newId().slice(-12)}`,
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(expected);
  return { ...res, result: res.body.result as T };
}

/** `quantity` caps, as the till rings them up at the shop, paid in cash. */
function capOrder(quantity: number) {
  const total = quantity * capUnitSatang;
  return {
    saleId: newId(),
    actionId: `pay-${newId().slice(-12)}`,
    staffName: 'Nok',
    cart: { items: [{ id: newId(), productId: capId, quantity }], channel: 'shop', expectedTotalSatang: total },
    tender: {
      actionId: `cash-${newId().slice(-12)}`,
      method: 'cash',
      kind: 'cash',
      amountSatang: total,
      tenderedSatang: total,
      changeSatang: 0,
    },
  };
}

async function flush(agent: BoxAgent): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    const outcome = await agent.outbox()!.flush().catch(() => ({ state: 'deferred' as const }));
    if (outcome.state !== 'pushed') break;
  }
}

/** Send until the queue is empty, waiting out the backoff a lost answer leaves. */
async function drain(agent: BoxAgent): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await flush(agent);
    if ((await agent.outbox()!.depth()).queued === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** What the cap holds, by place name. */
async function capLevels(): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ place: stockLocation.name, quantity: stockLevel.quantity })
    .from(stockLevel)
    .innerJoin(stockLocation, eq(stockLocation.id, stockLevel.stockLocationId))
    .where(eq(stockLevel.stockItemId, capItemId));
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

const oversold = () => ctx.db.select().from(syncAnomaly).where(eq(syncAnomaly.kind, 'stock_oversold'));
const saleMovements = (saleId: string) =>
  ctx.db
    .select()
    .from(stockMovement)
    .where(and(eq(stockMovement.saleId, saleId), eq(stockMovement.kind, 'offline_sale')))
    .orderBy(asc(stockMovement.stockLocationId));

/** Where a counted box sale sits in its box's journal, as the box kept it beside its shares. */
async function keptPosition(boxId: string, saleId: string): Promise<{ journalEpoch: number; boxSeq: number }> {
  const raw = await boxStoreFor(ctx.db).readRuntimeValue(boxId, `stock_taken:${saleId}`);
  expect(raw, 'the box kept the sale’s share').toBeTruthy();
  const kept = JSON.parse(raw!) as { journalEpoch: number; boxSeq: number };
  return { journalEpoch: kept.journalEpoch, boxSeq: kept.boxSeq };
}

async function heldSnapshot(boxId: string): Promise<StockSnapshotItem> {
  const held = await boxStoreFor(ctx.db).readBundle(boxId, 'stock');
  expect(held, 'the box holds a stock snapshot').toBeTruthy();
  return (held!.payload as { items: StockSnapshotItem[] }).items[0]!;
}

beforeAll(async () => {
  ctx = await createTestContext();
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const box2 = await boxBySlot(ctx.db, 'virtual-2');
  box1Id = box1.id;
  box2Id = box2.id;
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  const [c2] = await ctx.db.select().from(station).where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')));
  till1 = t1!.id;
  counter2 = c2!.id;
  branchId = t1!.branchId;
  operatorId = t1!.operatorId;
  cookies = {
    till1: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password),
    counter2: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password),
    admin: await signInAs(ctx.app, ADMIN.phone, ADMIN.password),
  };
  expect((await call(cookies.till1, 'PUT', '/me/session/station', { stationId: till1 })).statusCode).toBe(200);
  expect((await call(cookies.counter2, 'PUT', '/me/session/station', { stationId: counter2 })).statusCode).toBe(200);

  // The seeded Oto Cap (prototype figures: 18 BOH + 7 FOH), one size.
  const [cap] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'MR-CAP'), isNull(product.archivedAt)));
  capId = cap!.id;
  const quoted = await call(cookies.till1, 'POST', '/sales/quote', {
    stationId: till1,
    items: [{ id: newId(), productId: capId, quantity: 1 }],
    channel: 'shop',
  });
  expect(quoted.statusCode, JSON.stringify(quoted.body)).toBe(200);
  capUnitSatang = (quoted.body.quote as { totals: { grossSatang: number } }).totals.grossSatang;
  const [item] = await ctx.db
    .select()
    .from(stockItem)
    .where(and(eq(stockItem.branchId, branchId), eq(stockItem.productId, capId), isNull(stockItem.archivedAt)));
  capItemId = item!.id;
  const places = await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId));
  fohId = places.find((p) => p.sellPoint)!.id;

  // THE LAST TWO CAPS, on the counter shelf: the rest counted away, as a stock
  // take would (through the one writer of a level).
  const levels = await ctx.db.select().from(stockLevel).where(eq(stockLevel.stockItemId, capItemId));
  await ctx.db.transaction((tx) =>
    applyMovements(
      tx,
      { operatorId, branchId, businessDate: '2026-10-02', occurredAt: new Date(), actorAccountId: null },
      levels
        .map((l) => ({ l, target: l.stockLocationId === fohId ? 2 : 0 }))
        .filter(({ l, target }) => l.quantity !== target)
        .map(({ l, target }) => ({
          stockItemId: capItemId,
          stockLocationId: l.stockLocationId,
          kind: 'adjust' as const,
          quantity: target - l.quantity,
          actionId: `test:stock-r3:last-two:${l.stockLocationId}`,
          reason: 'stock round 3 walk: the last two caps',
        })),
    ),
  );
  expect((await capLevels())[places.find((p) => p.sellPoint)!.name]).toBe(2);
  catalogueBefore = await catalogueVersionOf(ctx.db, operatorId, branchId);

  agent1 = stockAgent(box1.id, 'stock-box-1', link1, () => {
    if (!dropAnswer.box1) return false;
    dropAnswer.box1 = false;
    return true;
  });
  agent2 = stockAgent(box2.id, 'stock-box-2', link2);
  for (const agent of [agent1, agent2]) {
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    await agent.syncCache();
    attachInProcessBox(agent);
  }
}, 240_000);

afterAll(async () => {
  for (const agent of [agent1, agent2]) {
    agent?.stop();
    if (agent) detachInProcessBox(agent);
  }
  await ctx?.close();
  await teardownAll();
});

describe('stock offline: snapshot online, two boxes sell the same last caps, sync once each, one anomaly (plan §2.4)', () => {
  it('both boxes hold the snapshot: two caps at the counter shelf, none of their own sales filed yet', async () => {
    for (const [agent, id] of [[agent1, box1Id], [agent2, box2Id]] as const) {
      // Written by the cache pull at start; this tick finds the same copy and rewrites nothing.
      expect(await agent.syncStock()).toBe(false);
      const snap = await heldSnapshot(id);
      const capEntry = snap.items.find((e) => e.stockItemId === capItemId)!;
      expect(capEntry).toMatchObject({ productId: capId, itemName: 'Oto Cap', variantId: null, total: 2 });
      // The filed mark of THIS box's journal, on its current epoch: no sale of its own above it yet.
      const [own] = await ctx.db.select({ epoch: box.currentEpoch }).from(box).where(eq(box.id, id));
      expect(snap.boxFiled).toMatchObject({ journalEpoch: own!.epoch });
      expect(snap.boxFiled!.boxSeq).toBeGreaterThanOrEqual(0);
      expect(capEntry.levels[fohId]).toBe(2);
      expect(snap.sellPointId).toBe(fohId);
      // Every place of the branch is named, and the sizes of a sized item are separate rows.
      expect(snap.places.map((p) => p.name).sort()).toEqual(['BOH', 'FOH', 'Store']);
      expect(snap.items.filter((e) => e.itemName === 'Grip Socks' && e.variantId).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('with the link down, Reception Till 1 sells the last two and is refused a third; Counter 2 sells the same two', async () => {
    for (const agent of [agent1, agent2]) await agent.setOffline(true, { reason: 'stock round 3' });
    link1.cut = true;
    link2.cut = true;

    const first = capOrder(2);
    const sold1 = await onBox(cookies.till1, till1, 'sale.finalise', first);
    expect(sold1.result.finalised).toBe(true);
    sales.box1 = first.saleId;

    // Its own sale since the snapshot comes off: nothing left on this box.
    const refused = await onBox(cookies.till1, till1, 'sale.finalise', capOrder(1), 409);
    expect(refused.body.error).toMatchObject({ code: 'STOCK_SHORT', message: 'Oto Cap is out of stock. Nothing was saved.' });

    // Counter 2's snapshot still says two: it cannot know what box 1 sold.
    const second = capOrder(2);
    const sold2 = await onBox(cookies.counter2, counter2, 'sale.finalise', second);
    expect(sold2.result.finalised).toBe(true);
    sales.box2 = second.saleId;

    // Nothing reached the ledger yet.
    expect(await ctx.db.select().from(sale).where(eq(sale.id, first.saleId))).toHaveLength(0);
    expect((await capLevels()).FOH).toBe(2);
  });

  it('box 1 reconnects, its answer is lost and it sends again: two caps taken once, offline, at its box — and nothing raised', async () => {
    link1.cut = false;
    dropAnswer.box1 = true;
    await agent1.setOffline(false);
    await flush(agent1);
    expect(dropAnswer.box1, 'the answer to the first push was lost').toBe(false);
    await drain(agent1);
    expect((await agent1.outbox()!.depth()).queued).toBe(0);

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, sales.box1!));
    expect(row).toMatchObject({ status: 'finalised', boxId: box1Id, origin: 'box' });
    const moved = await saleMovements(sales.box1!);
    expect(moved.map((m) => [m.stockLocationId, m.quantity, m.shortfall, m.offline, m.boxId, m.stationId])).toEqual([
      [fohId, -2, 0, true, box1Id, till1],
    ]);
    expect(await capLevels()).toMatchObject({ FOH: 0, BOH: 0, Store: 0 });
    expect(await oversold(), 'a within-stock replay raises nothing').toHaveLength(0);
    await expectLedgerAddsUp();

    // Box 1's next snapshot reflects what it filed — its mark is at or past
    // the sale's own journal position — so it is not taken off twice.
    expect(await agent1.syncStock()).toBe(true);
    const held1 = await heldSnapshot(box1Id);
    expect(held1.items.find((e) => e.stockItemId === capItemId)).toMatchObject({ total: 0 });
    const pos1 = await keptPosition(box1Id, sales.box1!);
    expect(held1.boxFiled!.journalEpoch).toBe(pos1.journalEpoch);
    expect(held1.boxFiled!.boxSeq).toBeGreaterThanOrEqual(pos1.boxSeq);
    // The mark is this box's own: box 2's journal is not in it.
    const [cursor1] = await ctx.db
      .select({ lastBoxSeq: syncCursor.lastBoxSeq })
      .from(syncCursor)
      .where(and(eq(syncCursor.boxId, box1Id), eq(syncCursor.journalEpoch, pos1.journalEpoch)));
    expect(held1.boxFiled!.boxSeq).toBe(cursor1!.lastBoxSeq);
  });

  it('box 2 reconnects: its two caps land on none — filed, the level at zero, ONE stock_oversold anomaly and ONE critical alert', async () => {
    link2.cut = false;
    await agent2.setOffline(false);
    await drain(agent2);

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, sales.box2!));
    expect(row).toMatchObject({ status: 'finalised', boxId: box2Id });
    const moved = await saleMovements(sales.box2!);
    expect(moved.map((m) => [m.stockLocationId, m.quantity, m.shortfall, m.levelAfter])).toEqual([[fohId, 0, 2, 0]]);
    expect(await capLevels()).toMatchObject({ FOH: 0, BOH: 0, Store: 0 });
    await expectLedgerAddsUp();
    // Round 1's attention for someone to count the shelf stands beside it.
    const attention = await ctx.db.select().from(stockAttention).where(eq(stockAttention.saleId, sales.box2!));
    expect(attention.map((a) => [a.kind, a.quantity])).toEqual([['stock_shortfall', 2]]);

    const anomalies = await oversold();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.boxId).toBe(box2Id);
    expect(anomalies[0]!.detail).toMatchObject({
      itemName: 'Oto Cap',
      sizeLabel: null,
      placeName: 'FOH',
      shortQuantity: 2,
      takenQuantity: 0,
      soldQuantity: 2,
      stationName: 'Counter 2',
      saleId: sales.box2,
      stockItemId: capItemId,
      stockLocationId: fohId,
      boxId: box2Id,
      stationId: counter2,
    });
    const lineId = (anomalies[0]!.detail as { saleLineId: string }).saleLineId;
    const alerts = await ctx.db.select().from(alert).where(eq(alert.key, stockOversoldAlertKey(operatorId, lineId, capItemId)));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', category: 'stock.offline_oversold', occurrences: 1 });
    expect(alerts[0]!.summary).toMatch(/2 Oto Cap sold offline at Counter 2/);
    expect(alerts[0]!.summary).toMatch(/FOH is at zero/);

    // On the Failures surface, with its kind.
    const page = await call(cookies.admin, 'GET', '/ops/anomalies?kind=stock_oversold');
    expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
    const listed = page.body.anomalies as Array<{ kind: string; detail: Record<string, unknown> }>;
    expect(listed.some((a) => a.kind === 'stock_oversold' && a.detail.shortQuantity === 2 && a.detail.itemName === 'Oto Cap')).toBe(true);

    // Box 2's snapshot now says none left, its own sale under its mark.
    expect(await agent2.syncStock()).toBe(true);
    const held2 = await heldSnapshot(box2Id);
    expect(held2.items.find((e) => e.stockItemId === capItemId)).toMatchObject({ total: 0 });
    expect(held2.boxFiled!.boxSeq).toBeGreaterThanOrEqual((await keptPosition(box2Id, sales.box2!)).boxSeq);
  });

  it('replaying either push, or the same sale under a new envelope, moves nothing twice and raises nothing again', async () => {
    const movementsBefore = await ctx.db.select().from(stockMovement).where(eq(stockMovement.stockItemId, capItemId));
    expect(await agent1.outbox()!.replayLastBatch(50)).toBeGreaterThan(0);
    expect(await agent2.outbox()!.replayLastBatch(50)).toBeGreaterThan(0);
    await flush(agent1);
    await flush(agent2);

    // The same `sale.finalised` again under a new envelope — a restored store, a re-queue.
    const [event] = await ctx.db
      .select()
      .from(syncEvent)
      .where(and(eq(syncEvent.boxId, box2Id), eq(syncEvent.type, 'sale.finalised')));
    await agent2.outbox()!.queue({
      type: 'sale.finalised',
      payload: event!.payload as Record<string, unknown>,
      stationId: counter2,
      actorKind: 'account',
      actorAccountId: event!.actorAccountId,
      actionId: event!.actionId,
    });
    await drain(agent2);

    const movementsAfter = await ctx.db.select().from(stockMovement).where(eq(stockMovement.stockItemId, capItemId));
    expect(movementsAfter).toHaveLength(movementsBefore.length);
    expect(await capLevels()).toMatchObject({ FOH: 0, BOH: 0, Store: 0 });
    await expectLedgerAddsUp();
    expect(await oversold()).toHaveLength(1);
    const lineId = ((await oversold())[0]!.detail as { saleLineId: string }).saleLineId;
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, stockOversoldAlertKey(operatorId, lineId, capItemId)));
    expect(raised!.occurrences).toBe(1);
    const marks = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'stock.offline_oversold'), eq(auditLog.entityId, `${lineId}:${capItemId}`)));
    expect(marks).toHaveLength(1);
  });

  it('the catalogue’s version never moved for any of it: stock rides its own scope', async () => {
    expect(await catalogueVersionOf(ctx.db, operatorId, branchId)).toBe(catalogueBefore);
  });
});
