import { randomInt } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  product,
  sale,
  saleDiscount,
  saleLine,
  station,
  stockAttention,
  stockItem,
  stockLevel,
  stockMovement,
  ticketPackage,
  voucher,
  voucherDefinition,
  voucherStockLink,
} from '@oto/db';
import { mintBoothCode, newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import {
  OfflinePaymentPayloadSchema,
  replayOfflineTender,
  type ReplayScope,
} from '../src/services/payments/offline';

/**
 * SCRUM-1040 — MYSTERY BOX: A STOCK ITEM, AND SCANNING ITS VOUCHER TAKES ONE
 * OFF THE SHELF (owner's answer, 19 November 2026: "Build it: a stock item,
 * and the scan takes one off").
 *
 *   - The Mystery Box is a stock item of each park, made, received and
 *     corrected in the Console like any other (no product: counted, never sold).
 *   - A hand-over voucher type is linked, per park, to the stock item it takes
 *     one from (`PUT /voucher-definitions/:id/park-stock/:branchId`, the booth
 *     permission, as a free product's park product is).
 *   - When the voucher is used up at a till of that park — the ฿0 close, or the
 *     close of a sale it rides on — one unit leaves that park's count, in the
 *     same transaction, once per voucher; a retried press or a replayed box
 *     tender takes nothing twice.
 *   - At zero the prize is still handed over: the count stays at zero, the
 *     movement carries the unit as its shortfall and a person is asked to count
 *     the shelf; the scan tells the till the count says none are left.
 *   - A prize with no stock item at the park behaves exactly as before, and the
 *     bill is untouched either way.
 *
 * Fixtures: the seeded parks (Central Floresta's Reception Till 1, Robinson
 * Chalong's till), a ZZ TEST Mystery Box stock item made here at each park, and
 * vouchers written into `promo.voucher` as the booth sync files them.
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
/** Reception standing at Central Floresta's Reception Till 1. */
let tillA: string;
/** The Chalong manager standing at Chalong's till. */
let chalongTill: string;

let operatorId: string;
let hktId: string;
let chalongId: string;
let t1: typeof station.$inferSelect;
let t3: typeof station.$inferSelect;
let receptionAccountId: string;
let twoHoursHkt: string;

/** The hand-over prize the booth gives, linked below; and one nobody links. */
let mysteryDef: string;
let unlinkedDef: string;
let freeItemDef: string;
let hktBox: string;
let chalongBox: string;
let hktSellPoint: string;
let chalongSellPoint: string;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, cookie: string, payload?: object, key?: string) =>
  ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload === undefined ? {} : { payload }),
  });

async function define(values: Partial<typeof voucherDefinition.$inferInsert>): Promise<string> {
  const id = newId();
  await ctx.db.insert(voucherDefinition).values({
    id,
    operatorId,
    code: `zz-test-${id}`,
    nameEn: 'ZZ TEST voucher',
    kind: 'manual',
    valueType: 'none',
    ...values,
  } as typeof voucherDefinition.$inferInsert);
  return id;
}

/** A voucher as the booth sync files one: an eleven-character code, issued now, good for 14 days. */
async function issue(definitionId: string, branchId = hktId): Promise<{ id: string; code: string }> {
  const id = newId();
  const code = mintBoothCode('B1', (max) => randomInt(max));
  const issuedAt = new Date();
  await ctx.db.insert(voucher).values({
    id,
    operatorId,
    branchId,
    voucherDefinitionId: definitionId,
    code,
    source: 'booth',
    status: 'issued',
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 14 * 86_400_000),
  });
  return { id, code };
}

const lookup = (cookie: string, code: string) =>
  ctx.app.inject({ method: 'GET', url: `/vouchers/lookup?code=${encodeURIComponent(code)}`, headers: { cookie } });
const hold = (cookie: string, saleId: string, code: string) =>
  call('POST', `/sales/${saleId}/vouchers`, cookie, { code });
const commit = (cookie: string, payload: Record<string, unknown>) => call('POST', '/sales', cookie, payload);
const finalise = (cookie: string, saleId: string, key?: string) =>
  call('POST', `/sales/${saleId}/finalise`, cookie, undefined, key);
const quote = (cookie: string, payload: Record<string, unknown>) => call('POST', '/sales/quote', cookie, payload);

/** The slip on its own: a ฿0 sale with no line, rung up and closed at the confirm press. */
async function handOver(cookie: string, stationId: string, code: string, finaliseKey?: string): Promise<string> {
  const saleId = newId();
  const held = await hold(cookie, saleId, code);
  expect(held.statusCode, held.body).toBe(200);
  const rung = await commit(cookie, { id: saleId, stationId, lines: [], items: [], promoCodes: [code], expectedTotalSatang: 0 });
  expect(rung.statusCode, rung.body).toBe(200);
  const closed = await finalise(cookie, saleId, finaliseKey);
  expect(closed.statusCode, closed.body).toBe(200);
  expect(closed.json()).toMatchObject({ finalised: true });
  return saleId;
}

/** A ZZ TEST Mystery Box stock item made in the Console at a park, with this many received at its sell point. */
async function mysteryBoxAt(branchId: string, sellPoint: string, received: number): Promise<string> {
  const made = await call('POST', `/branches/${branchId}/stock/items`, admin, {
    name: 'ZZ TEST Mystery Box',
    productId: null,
    unitCostSatang: 15_000,
    reorder: null,
    units: [],
    sizes: [{ variantId: null, label: 'Default', lowStockThreshold: null, parByLocation: {} }],
  });
  expect(made.statusCode, made.body).toBe(200);
  const [itemId] = (made.json() as { stockItemIds: string[] }).stockItemIds;
  if (received > 0) {
    const got = await call('POST', `/branches/${branchId}/stock/receipts`, admin, {
      stockItemId: itemId,
      locationId: sellPoint,
      quantity: received,
      reason: 'ZZ TEST delivery of Mystery Boxes',
    });
    expect(got.statusCode, got.body).toBe(200);
  }
  return itemId!;
}

/** The park's sell point; a park with no place yet gets its FOH in the Console, as a manager would add it. */
async function sellPointOf(branchId: string): Promise<string> {
  const res = await call('GET', `/branches/${branchId}/stock/locations`, admin);
  expect(res.statusCode, res.body).toBe(200);
  const place = (res.json() as { locations: Array<{ id: string; sellPoint: boolean }> }).locations.find((l) => l.sellPoint);
  if (place) return place.id;
  const made = await call('POST', `/branches/${branchId}/stock/locations`, admin, { name: 'ZZ TEST FOH', type: 'rotation' });
  expect(made.statusCode, made.body).toBe(200);
  expect(made.json()).toMatchObject({ sellPoint: true });
  return (made.json() as { id: string }).id;
}

/** What the count says a park holds of an item, every place together. */
async function held(itemId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ total: sql<number>`coalesce(sum(${stockLevel.quantity}), 0)::int` })
    .from(stockLevel)
    .where(eq(stockLevel.stockItemId, itemId));
  return row!.total;
}

/** Every level of every item, summed — "nothing else on any shelf moved". */
async function everyLevel(): Promise<number> {
  const [row] = await ctx.db.select({ total: sql<number>`coalesce(sum(${stockLevel.quantity}), 0)::int` }).from(stockLevel);
  return row!.total;
}

async function prizeMovements(voucherId: string) {
  return ctx.db.select().from(stockMovement).where(eq(stockMovement.actionId, `prize:${voucherId}`));
}

async function prizeAudits(voucherId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'stock.prize_hand_over'), sql`${auditLog.after}->>'voucherId' = ${voucherId}`));
}

/** THE INVARIANT: every level is the sum of its movements, and none is below zero. */
async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  expect((rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved || r.quantity < 0)).toEqual([]);
}

const setParkStock = (cookie: string, definitionId: string, branchId: string, stockItemId: string | null, key?: string) =>
  call('PUT', `/voucher-definitions/${definitionId}/park-stock/${branchId}`, cookie, { stockItemId }, key);

beforeAll(async () => {
  ctx = await createTestContext();
  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central')!;
  const chalong = branches.find((row) => row.code === 'robinson-chalong')!;
  hktId = hkt.id;
  chalongId = chalong.id;
  operatorId = hkt.operatorId;

  const stations = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  t1 = stations.find((s) => s.branchId === hktId && s.codePrefix === 'T1')!;
  t3 = stations.find((s) => s.branchId === chalongId && s.codePrefix === 'T3')!;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.operatorId, operatorId));
  twoHoursHkt = packages.find((p) => p.branchId === hktId && p.name === '2 Hours Play')!.id;
  const [receptionRow] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionAccountId = receptionRow!.id;

  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  tillA = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await takeStation(ctx.app, tillA, t1.id);
  chalongTill = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  await takeStation(ctx.app, chalongTill, t3.id);

  mysteryDef = await define({ nameEn: 'ZZ TEST Mystery Box' });
  unlinkedDef = await define({ nameEn: 'ZZ TEST Mystery Gift (no shelf)' });
  const [anyProduct] = await ctx.db.execute<{ id: string }>(
    sql`select id from pos.product where operator_id = ${operatorId}::uuid and active and archived_at is null limit 1`,
  ).then((r) => r.rows);
  freeItemDef = await define({ nameEn: 'ZZ TEST free item', kind: 'free_item', valueType: 'item', productId: anyProduct!.id });

  hktSellPoint = await sellPointOf(hktId);
  chalongSellPoint = await sellPointOf(chalongId);
  hktBox = await mysteryBoxAt(hktId, hktSellPoint, 10);
  chalongBox = await mysteryBoxAt(chalongId, chalongSellPoint, 5);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the Console links a hand-over prize to the stock item it takes one from, per park', () => {
  it('offers each park’s counted stock items, saves the link, reads it back and audits it once', async () => {
    const options = await call('GET', '/voucher-definitions/link-options', admin);
    expect(options.statusCode, options.body).toBe(200);
    const items = (options.json() as { stockItems: Array<{ id: string; name: string; branchId: string }> }).stockItems;
    expect(items).toContainEqual(expect.objectContaining({ id: hktBox, name: 'ZZ TEST Mystery Box', branchId: hktId }));
    expect(items).toContainEqual(expect.objectContaining({ id: chalongBox, branchId: chalongId }));

    const key = newId();
    const set = await setParkStock(admin, mysteryDef, hktId, hktBox, key);
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().definition.parkStock).toEqual([
      { branchId: hktId, branchName: expect.any(String), stockItemId: hktBox, stockItemName: 'ZZ TEST Mystery Box', live: true },
    ]);
    // The same press again under its key: the same answer, and nothing written twice.
    const again = await setParkStock(admin, mysteryDef, hktId, hktBox, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(set.json());
    // The same link set again under a new key changes nothing and records nothing.
    expect((await setParkStock(admin, mysteryDef, hktId, hktBox)).statusCode).toBe(200);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'voucher_definition.park_stock'), eq(auditLog.entityId, mysteryDef)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      branchId: hktId,
      before: { branchId: hktId, stockItemId: null },
      after: { branchId: hktId, stockItemId: hktBox },
    });

    const list = await call('GET', '/voucher-definitions', admin);
    const rows = (list.json() as { definitions: Array<{ id: string; parkStock: unknown[] }> }).definitions;
    expect(rows.find((d) => d.id === mysteryDef)!.parkStock).toHaveLength(1);
    expect(rows.find((d) => d.id === freeItemDef)!.parkStock).toEqual([]);
  });

  it('refuses another park’s item, a kind that is not a hand-over prize, and anyone without the booth permission', async () => {
    const elsewhere = await setParkStock(admin, mysteryDef, hktId, chalongBox);
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json().error).toMatchObject({
      code: 'VOUCHER_PARK_STOCK_NOT_HERE',
      message: 'That stock item is not counted at this park — pick one of the park’s own stock items.',
    });
    const wrongKind = await setParkStock(admin, freeItemDef, hktId, hktBox);
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().error.code).toBe('VOUCHER_PARK_STOCK_KIND');
    // Reception and a branch manager redeem and count stock, but do not set up prizes.
    expect((await setParkStock(reception, mysteryDef, hktId, null)).statusCode).toBe(403);
    expect((await setParkStock(manager, mysteryDef, hktId, null)).statusCode).toBe(403);
    // Nothing moved: the link is still the one set above.
    const links = await ctx.db.select().from(voucherStockLink).where(eq(voucherStockLink.voucherDefinitionId, mysteryDef));
    expect(links.map((l) => [l.branchId, l.stockItemId])).toEqual([[hktId, hktBox]]);
  });
});

describe('the scan says what the count holds', () => {
  it('a linked prize names its item and the count at this park; an unlinked one and another park say nothing', async () => {
    const v = await issue(mysteryDef);
    const looked = await lookup(tillA, v.code);
    expect(looked.statusCode, looked.body).toBe(200);
    expect(looked.json().voucher).toMatchObject({
      effect: { type: 'hand_over' },
      prizeStock: { name: 'ZZ TEST Mystery Box', available: await held(hktBox) },
    });
    // Chalong has no link for this type yet.
    expect((await lookup(chalongTill, v.code)).json().voucher.prizeStock).toBeNull();
    const plain = await issue(unlinkedDef);
    expect((await lookup(tillA, plain.code)).json().voucher.prizeStock).toBeNull();
  });
});

describe('a hand-over takes one off the shelf, once', () => {
  it('the slip on its own: one unit leaves the sell point with the ฿0 close, on the record, and nothing on the bill', async () => {
    const before = await held(hktBox);
    const v = await issue(mysteryDef);
    const saleId = await handOver(tillA, t1.id, v.code);

    expect((await ctx.db.select().from(voucher).where(eq(voucher.id, v.id)))[0]!.status).toBe('redeemed');
    expect(await held(hktBox)).toBe(before - 1);
    const moved = await prizeMovements(v.id);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      branchId: hktId,
      stockItemId: hktBox,
      stockLocationId: hktSellPoint,
      kind: 'sale',
      quantity: -1,
      shortfall: 0,
      saleId,
      saleLineId: null,
      reason: `Prize handed over: ZZ TEST Mystery Box (voucher …${v.code.slice(-4)})`,
      stationId: t1.id,
      offline: false,
      unitCostSatang: 15_000,
    });
    // Never the whole code on the movement.
    expect(moved[0]!.reason).not.toContain(v.code);

    // The bill as before: a ฿0 sale with no line and the voucher's ฿0 row.
    expect((await ctx.db.select().from(sale).where(eq(sale.id, saleId)))[0]).toMatchObject({ grossSatang: 0, status: 'finalised' });
    expect(await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId))).toEqual([]);
    const discounts = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(discounts.map((d) => d.amountSatang)).toEqual([0]);

    const audits = await prizeAudits(v.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorAccountId: receptionAccountId,
      branchId: hktId,
      entityType: 'stock_item',
      entityId: hktBox,
      before: { held: before },
      after: { held: before - 1, voucherId: v.id, saleId, shortfall: 0, offline: false },
    });
    await expectLedgerAddsUp();
  });

  it('a retried confirm press — under its key, and again without one — takes nothing twice', async () => {
    const before = await held(hktBox);
    const v = await issue(mysteryDef);
    const key = newId();
    const saleId = await handOver(tillA, t1.id, v.code, key);
    const retried = await finalise(tillA, saleId, key);
    expect(retried.statusCode, retried.body).toBe(200);
    const pressedAgain = await finalise(tillA, saleId);
    expect(pressedAgain.statusCode, pressedAgain.body).toBe(200);
    expect(pressedAgain.json()).toMatchObject({ replay: true, finalised: true });
    expect(await held(hktBox)).toBe(before - 1);
    expect(await prizeMovements(v.id)).toHaveLength(1);
    expect(await prizeAudits(v.id)).toHaveLength(1);
  });

  it('beside a ticket: the ticket is billed as without the slip, and one unit leaves when the sale is paid', async () => {
    const before = await held(hktBox);
    const cart = { stationId: t1.id, lines: [{ id: newId(), packageId: twoHoursHkt, kids: 1, adults: 1 }] };
    const plain = await quote(tillA, cart);
    expect(plain.statusCode, plain.body).toBe(200);
    const v = await issue(mysteryDef);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const rung = await commit(tillA, { id: saleId, ...cart, promoCodes: [v.code] });
    expect(rung.statusCode, rung.body).toBe(200);
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(written!.grossSatang).toBe(plain.json().totals.grossSatang);
    // Rung up, not paid: nothing has left the shelf yet.
    expect(await held(hktBox)).toBe(before);
    // An empty confirm settles the balance in cash.
    const paid = await finalise(tillA, saleId);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id] });
    expect(await held(hktBox)).toBe(before - 1);
    expect(await prizeMovements(v.id)).toEqual([expect.objectContaining({ saleId, saleLineId: null, quantity: -1 })]);
  });

  it('beside a pair of socks: each shelf gives exactly its own unit when the sale is paid', async () => {
    const [socks] = await ctx.db
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.code, 'AO-SOCKS'), eq(product.branchId, hktId)));
    const [socksItem] = await ctx.db
      .select({ id: stockItem.id })
      .from(stockItem)
      .where(and(eq(stockItem.productId, socks!.id), eq(stockItem.branchId, hktId)));
    const boxesBefore = await held(hktBox);
    const socksBefore = await held(socksItem!.id);
    const v = await issue(mysteryDef);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const rung = await commit(tillA, {
      id: saleId,
      stationId: t1.id,
      lines: [{ id: newId(), packageId: twoHoursHkt, kids: 1, adults: 1, addOns: [{ id: socks!.id, quantity: 1 }] }],
      promoCodes: [v.code],
    });
    expect(rung.statusCode, rung.body).toBe(200);
    const paid = await finalise(tillA, saleId);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(await held(hktBox)).toBe(boxesBefore - 1);
    expect(await held(socksItem!.id)).toBe(socksBefore - 1);
    const moved = await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, saleId));
    expect(moved.map((m) => [m.stockItemId, m.quantity]).sort()).toEqual(
      [
        [hktBox, -1],
        [socksItem!.id, -1],
      ].sort(),
    );
    await expectLedgerAddsUp();
  });

  it('a sale rung up online and paid at a box with the link down: one unit, offline, and a replayed tender takes nothing twice', async () => {
    const before = await held(hktBox);
    const v = await issue(mysteryDef);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const rung = await commit(tillA, {
      id: saleId,
      stationId: t1.id,
      lines: [{ id: newId(), packageId: twoHoursHkt, kids: 1, adults: 1 }],
      promoCodes: [v.code],
    });
    expect(rung.statusCode, rung.body).toBe(200);
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const scope: ReplayScope = {
      operatorId,
      branchId: hktId,
      boxId: t1.boxId!,
      stationId: t1.id,
      actorAccountId: receptionAccountId,
      occurredAt: new Date(),
      boxSeq: 1,
      eventId: newId(),
      actionId: newId(),
    };
    const payload = OfflinePaymentPayloadSchema.parse({
      saleId,
      tender: { actionId: newId(), methodCode: 'cash', amountSatang: written!.grossSatang },
    });
    await ctx.db.transaction((tx) => replayOfflineTender(tx, scope, payload));
    // The same event again — a re-send, or a replay from the Failures tab.
    await ctx.db.transaction((tx) => replayOfflineTender(tx, scope, payload));

    expect((await ctx.db.select().from(sale).where(eq(sale.id, saleId)))[0]!.status).toBe('finalised');
    expect(await held(hktBox)).toBe(before - 1);
    const moved = await prizeMovements(v.id);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ kind: 'offline_sale', offline: true, quantity: -1, saleId });
    expect(await prizeAudits(v.id)).toHaveLength(1);
    await expectLedgerAddsUp();
  });

  it('a slip rung up and then voided was never handed over: nothing leaves the shelf', async () => {
    const before = await held(hktBox);
    const v = await issue(mysteryDef);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const rung = await commit(tillA, { id: saleId, stationId: t1.id, lines: [], items: [], promoCodes: [v.code], expectedTotalSatang: 0 });
    expect(rung.statusCode, rung.body).toBe(200);
    const voided = await call('POST', `/sales/${saleId}/void`, tillA, { reason: 'ZZ TEST guest changed their mind' });
    expect(voided.statusCode, voided.body).toBe(200);
    expect((await ctx.db.select().from(voucher).where(eq(voucher.id, v.id)))[0]).toMatchObject({ status: 'issued', heldSaleId: null });
    expect(await held(hktBox)).toBe(before);
    expect(await prizeMovements(v.id)).toEqual([]);
  });
});

describe('a prize with no stock item at the park, and the other park', () => {
  it('an unlinked hand-over prize moves no shelf at all, as before', async () => {
    const before = await everyLevel();
    const v = await issue(unlinkedDef);
    await handOver(tillA, t1.id, v.code);
    expect(await everyLevel()).toBe(before);
    expect(await prizeMovements(v.id)).toEqual([]);
    expect(await prizeAudits(v.id)).toEqual([]);
  });

  it('the same type with no link at Chalong takes nothing there; linked there, it takes Chalong’s and never Central’s', async () => {
    const hktBefore = await held(hktBox);
    const chalongBefore = await held(chalongBox);
    const first = await issue(mysteryDef);
    await handOver(chalongTill, t3.id, first.code);
    expect(await held(chalongBox)).toBe(chalongBefore);
    expect(await held(hktBox)).toBe(hktBefore);
    expect(await prizeMovements(first.id)).toEqual([]);

    expect((await setParkStock(admin, mysteryDef, chalongId, chalongBox)).statusCode).toBe(200);
    const second = await issue(mysteryDef);
    await handOver(chalongTill, t3.id, second.code);
    expect(await held(chalongBox)).toBe(chalongBefore - 1);
    expect(await held(hktBox)).toBe(hktBefore);
    expect(await prizeMovements(second.id)).toEqual([
      expect.objectContaining({ branchId: chalongId, stockItemId: chalongBox, stationId: t3.id, quantity: -1 }),
    ]);
  });
});

describe('at zero the prize is still handed over', () => {
  it('the scan says none are left; the hand-over goes through, the count stays at zero and the shortfall is on the record', async () => {
    // A manager's recount brings Central's count to nothing.
    const left = await held(hktBox);
    if (left > 0) {
      const corrected = await call('POST', `/branches/${hktId}/stock/adjustments`, admin, {
        stockItemId: hktBox,
        delta: -left,
        reasonType: 'recount',
        reason: 'ZZ TEST recount: the shelf is empty',
      });
      expect(corrected.statusCode, corrected.body).toBe(200);
    }
    expect(await held(hktBox)).toBe(0);

    const v = await issue(mysteryDef);
    expect((await lookup(tillA, v.code)).json().voucher.prizeStock).toEqual({ name: 'ZZ TEST Mystery Box', available: 0 });
    const saleId = await handOver(tillA, t1.id, v.code);

    expect((await ctx.db.select().from(voucher).where(eq(voucher.id, v.id)))[0]!.status).toBe('redeemed');
    expect(await held(hktBox)).toBe(0);
    const moved = await prizeMovements(v.id);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      stockItemId: hktBox,
      stockLocationId: hktSellPoint,
      kind: 'sale',
      quantity: 0,
      shortfall: 1,
      levelAfter: 0,
      saleId,
    });
    const attention = await ctx.db
      .select()
      .from(stockAttention)
      .where(and(eq(stockAttention.stockItemId, hktBox), like(stockAttention.dedupeKey, `shortfall:prize:${v.id}:%`)));
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      kind: 'stock_shortfall',
      quantity: 1,
      saleId,
      resolvedAt: null,
      summary: '1 ZZ TEST Mystery Box handed over as a prize that the record did not hold — count the shelf',
    });
    const audits = await prizeAudits(v.id);
    expect(audits[0]).toMatchObject({ before: { held: 0 }, after: { held: 0, shortfall: 1 } });
    await expectLedgerAddsUp();

    // Received again in the Console, the next prize takes from the delivery.
    const got = await call('POST', `/branches/${hktId}/stock/receipts`, admin, {
      stockItemId: hktBox,
      locationId: hktSellPoint,
      quantity: 2,
      reason: 'ZZ TEST delivery of Mystery Boxes',
    });
    expect(got.statusCode, got.body).toBe(200);
    const next = await issue(mysteryDef);
    await handOver(tillA, t1.id, next.code);
    expect(await held(hktBox)).toBe(1);
  });
});

describe('a link cleared in the Console', () => {
  it('stops the take at that park and is audited', async () => {
    const cleared = await setParkStock(admin, mysteryDef, hktId, null);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().definition.parkStock.map((p: { branchId: string }) => p.branchId)).toEqual([chalongId]);
    const before = await held(hktBox);
    const v = await issue(mysteryDef);
    await handOver(tillA, t1.id, v.code);
    expect(await held(hktBox)).toBe(before);
    expect(await prizeMovements(v.id)).toEqual([]);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'voucher_definition.park_stock'), eq(auditLog.entityId, mysteryDef), eq(auditLog.branchId, hktId)));
    expect(audits.map((a) => (a.after as { stockItemId: string | null }).stockItemId)).toEqual([hktBox, null]);
    // The stock item itself is untouched by the link going.
    expect((await ctx.db.select().from(stockItem).where(eq(stockItem.id, hktBox)))[0]).toMatchObject({ active: true, archivedAt: null });
  });
});
