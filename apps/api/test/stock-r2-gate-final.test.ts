import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, branch, purchaseOrder, stockItem, stockLevel, stockLocation } from '@oto/db';
import { StockItemBodySchema } from '@oto/shared';
import {
  addToPurchaseOrders,
  commitStockTake,
  markPurchaseOrderOrdered,
  receivePurchaseOrderLine,
  receiveStock,
  saveStockItem,
  transferStock,
} from '../src/services/stock';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14b round 2 — the FINAL gate re-check's own reproductions.
 *
 * A transfer and a PO receive racing a size removal, in both orders: whichever
 * commits first, no each may end on an archived stock item, and every level is
 * still the sum of its movements.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let receptionId: string;
let managerId: string;
const places = new Map<string, string>();

const base = () => `/branches/${branchId}/stock`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: 'POST' | 'PUT', url: string, cookie: string, payload: unknown) {
  return ctx.app.inject({ method, url, headers: { cookie }, payload: payload as Record<string, unknown> });
}

async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  expect((rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved)).toEqual([]);
}

async function stockOnArchivedItems(): Promise<Array<{ stockItemId: string; quantity: number }>> {
  return ctx.db
    .select({ stockItemId: stockLevel.stockItemId, quantity: stockLevel.quantity })
    .from(stockLevel)
    .innerJoin(stockItem, eq(stockItem.id, stockLevel.stockItemId))
    .where(and(isNotNull(stockItem.archivedAt), ne(stockLevel.quantity, 0)));
}

async function levelOf(stockItemId: string, place: string): Promise<number> {
  const [row] = await ctx.db
    .select({ quantity: stockLevel.quantity })
    .from(stockLevel)
    .where(and(eq(stockLevel.stockItemId, stockItemId), eq(stockLevel.stockLocationId, places.get(place)!)));
  return row?.quantity ?? 0;
}

async function archived(stockItemId: string): Promise<boolean> {
  return (await ctx.db.select().from(stockItem).where(eq(stockItem.id, stockItemId)))[0]!.archivedAt !== null;
}

async function twoSizeItem(name: string) {
  const res = await call('POST', `${base()}/items`, manager, {
    name,
    productId: null,
    unitCostSatang: 1000,
    reorder: null,
    units: [],
    sizes: [
      { variantId: null, label: 'A', lowStockThreshold: null, parByLocation: {} },
      { variantId: null, label: 'B', lowStockThreshold: null, parByLocation: {} },
    ],
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { groupId: string; stockItemIds: string[] };
  return { groupId: body.groupId, a: body.stockItemIds[0]!, b: body.stockItemIds[1]! };
}

const keepOnlyA = (name: string, a: string) => ({
  name,
  productId: null,
  unitCostSatang: 1000,
  reorder: null,
  units: [],
  sizes: [{ stockItemId: a, variantId: null, label: 'A', lowStockThreshold: null, parByLocation: {} }],
});

const mgr = () => ({ operatorId, branchId, accountId: managerId });
const desk = () => ({ operatorId, branchId, accountId: receptionId });

/** Hold a size removal open (B archived, uncommitted) until `release`. */
function holdRemoval(name: string, item: { groupId: string; a: string }) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let removed!: () => void;
  const inside = new Promise<void>((r) => (removed = r));
  const done = ctx.db.transaction(async (tx) => {
    await saveStockItem(tx, mgr(), item.groupId, StockItemBodySchema.parse(keepOnlyA(name, item.a)), new Date());
    removed();
    await gate;
  });
  return { inside, release: () => release(), done };
}

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const hkt = (await ctx.db.select().from(branch)).find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) {
    places.set(l.name, l.id);
  }
  receptionId = (await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)))[0]!.id;
  managerId = (await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone)))[0]!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('FINAL-1 — a transfer racing the removal of the size it moves', () => {
  it('removal first: a transfer and a delivery waiting on it are refused in plain words, nothing lands on the archived size', async () => {
    const item = await twoSizeItem('Final Rope');
    const removal = holdRemoval('Final Rope', item);
    await removal.inside;
    // Both wait on the removal's row lock.
    const receipt = call('POST', `${base()}/receipts`, reception, {
      stockItemId: item.b,
      locationId: places.get('BOH')!,
      quantity: 3,
      reason: 'Walk-in delivery',
    });
    const transfer = call('POST', `${base()}/transfers`, reception, {
      fromLocationId: places.get('BOH')!,
      toLocationId: places.get('FOH')!,
      lines: [{ stockItemId: item.b, quantity: 3 }],
    });
    await sleep(800);
    removal.release();
    await removal.done;
    const [r, t] = await Promise.all([receipt, transfer]);
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { code: string } }).error.code).toBe('STOCK_ITEM_REMOVED');
    expect(t.statusCode).toBe(409);
    expect((t.json() as { error: { code: string; message: string } }).error.code).toBe('STOCK_ITEM_REMOVED');
    expect((t.json() as { error: { message: string } }).error.message).toMatch(/was removed from stock — it cannot be moved/);
    expect(await archived(item.b)).toBe(true);
    expect(await stockOnArchivedItems()).toEqual([]);
    await expectLedgerAddsUp();
  });

  it('transfer first: the removal waits, sees the stock that arrived and refuses', async () => {
    const item = await twoSizeItem('Final Twine');
    await ctx.db.transaction((tx) =>
      receiveStock(tx, desk(), { stockItemId: item.b, locationId: places.get('BOH')!, quantity: 3, reason: 'Opening box' }, new Date()),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let moved!: () => void;
    const inside = new Promise<void>((r) => (moved = r));
    const transfer = ctx.db.transaction(async (tx) => {
      await transferStock(
        tx,
        desk(),
        { fromLocationId: places.get('BOH')!, toLocationId: places.get('FOH')!, lines: [{ stockItemId: item.b, quantity: 3 }] },
        new Date(),
      );
      moved();
      await gate;
    });
    await inside;
    const edit = call('PUT', `${base()}/items/${item.groupId}`, manager, keepOnlyA('Final Twine', item.a));
    await Promise.race([edit, sleep(1000)]);
    release();
    await transfer;
    const res = await edit;
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('STOCK_SIZE_HOLDS_STOCK');
    expect(await archived(item.b)).toBe(false);
    expect(await levelOf(item.b, 'FOH')).toBe(3);
    expect(await levelOf(item.b, 'BOH')).toBe(0);
    expect(await stockOnArchivedItems()).toEqual([]);
    await expectLedgerAddsUp();
  });
});

describe('FINAL-2 — a PO receive racing the removal of the size it delivers', () => {
  it('receive first: the removal waits, sees the delivery and refuses; the order closes received', async () => {
    const item = await twoSizeItem('Final Glue');
    const [po] = await ctx.db.transaction((tx) => addToPurchaseOrders(tx, mgr(), { lines: [{ stockItemId: item.b, quantity: 4 }] }, new Date()));
    const line = po!.lines.find((l) => l.stockItemId === item.b)!;
    await ctx.db.transaction((tx) => markPurchaseOrderOrdered(tx, mgr(), po!.id, {}, new Date()));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let received!: () => void;
    const inside = new Promise<void>((r) => (received = r));
    const receipt = ctx.db.transaction(async (tx) => {
      await receivePurchaseOrderLine(tx, desk(), po!.id, line.id, { quantity: 4, locationId: places.get('BOH')! }, new Date());
      received();
      await gate;
    });
    await inside;
    const edit = call('PUT', `${base()}/items/${item.groupId}`, manager, keepOnlyA('Final Glue', item.a));
    await Promise.race([edit, sleep(1000)]);
    release();
    await receipt;
    const res = await edit;
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('STOCK_SIZE_HOLDS_STOCK');
    expect(await archived(item.b)).toBe(false);
    expect(await levelOf(item.b, 'BOH')).toBe(4);
    expect((await ctx.db.select().from(purchaseOrder).where(eq(purchaseOrder.id, po!.id)))[0]!.state).toBe('received');
    expect(await stockOnArchivedItems()).toEqual([]);
    await expectLedgerAddsUp();
  });

  it('an outstanding line blocks the removal outright; once the stock is counted out, a new order line waiting on the removal is refused', async () => {
    const item = await twoSizeItem('Final Tack');
    const [po] = await ctx.db.transaction((tx) => addToPurchaseOrders(tx, mgr(), { lines: [{ stockItemId: item.b, quantity: 2 }] }, new Date()));
    const line = po!.lines.find((l) => l.stockItemId === item.b)!;
    await ctx.db.transaction((tx) => markPurchaseOrderOrdered(tx, mgr(), po!.id, {}, new Date()));
    // While the line is outstanding the size cannot go.
    const blocked = await call('PUT', `${base()}/items/${item.groupId}`, manager, keepOnlyA('Final Tack', item.a));
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('STOCK_SIZE_ON_ORDER');
    // Deliver it, then count it out, so the size is removable.
    await ctx.db.transaction((tx) =>
      receivePurchaseOrderLine(tx, desk(), po!.id, line.id, { quantity: 2, locationId: places.get('BOH')! }, new Date()),
    );
    await ctx.db.transaction((tx) =>
      commitStockTake(tx, desk(), { lines: [{ stockItemId: item.b, locationId: places.get('BOH')!, countedQuantity: 0 }] }, new Date()),
    );
    // Removal held open; a till puts the size on a new order meanwhile.
    const removal = holdRemoval('Final Tack', item);
    await removal.inside;
    const add = ctx.db.transaction((tx) => addToPurchaseOrders(tx, mgr(), { lines: [{ stockItemId: item.b, quantity: 5 }] }, new Date()));
    const addSettled = add.then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    await sleep(800);
    removal.release();
    await removal.done;
    const err = await addSettled;
    // Refused: addToPurchaseOrders reads live sizes only, so the removed size is
    // "not one of this branch's" (its own comment: "no longer finds the size").
    expect(err?.code).toBe('NOT_FOUND');
    const { rows: openLines } = await ctx.db.execute(sql`
      select 1 from pos.purchase_order_line l join pos.purchase_order o on o.id = l.purchase_order_id
       where l.stock_item_id = ${item.b} and o.state in ('to_order', 'ordered') and l.ordered_quantity > l.received_quantity`);
    expect(openLines).toEqual([]);
    // A receive on the old, closed line delivers nothing.
    await expect(
      ctx.db.transaction((tx) =>
        receivePurchaseOrderLine(tx, desk(), po!.id, line.id, { quantity: 1, locationId: places.get('BOH')! }, new Date()),
      ),
    ).rejects.toMatchObject({ code: 'PURCHASE_ORDER_RECEIVED' });
    expect(await archived(item.b)).toBe(true);
    expect(await stockOnArchivedItems()).toEqual([]);
    await expectLedgerAddsUp();
  });
});
