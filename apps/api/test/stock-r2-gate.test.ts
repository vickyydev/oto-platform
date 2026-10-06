import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, stockItem, stockLevel, stockLocation } from '@oto/db';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14b round 2 — the gate's reproductions (focused gate, round 2).
 *
 * GATE-1 and GATE-2 were defects found at the gate, first kept as `it.fails`
 * reproductions; both are fixed and now run as plain `it`s (with the safety
 * net's own test beside GATE-1). The last block holds attacks that held.
 *
 * THE INVARIANT the stock module promises (plan §2.1, §2.3): every level is the
 * sum of its movements, AND every each the ledger says the branch holds is
 * somewhere a person can see, count, move or sell. A level on an ARCHIVED stock
 * item satisfies the first and breaks the second: no screen lists it
 * (`stockLevelsOf`, `sellableStock` and `loadBranchItems` all skip archived
 * items), no count can reach it, and no un-archive exists.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let branchId: string;
const places = new Map<string, string>();

const base = () => `/branches/${branchId}/stock`;

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  expect((rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved)).toEqual([]);
}

/** Eaches the ledger holds on stock items no screen will ever show again. */
async function stockOnArchivedItems(): Promise<Array<{ stockItemId: string; quantity: number }>> {
  return ctx.db
    .select({ stockItemId: stockLevel.stockItemId, quantity: stockLevel.quantity })
    .from(stockLevel)
    .innerJoin(stockItem, eq(stockItem.id, stockLevel.stockItemId))
    .where(and(isNotNull(stockItem.archivedAt), ne(stockLevel.quantity, 0)));
}

/** A manager's unlinked two-size item with a supplier, created through the route. */
async function twoSizeItem(name: string, supplierName: string) {
  const res = await call('POST', `${base()}/items`, manager, {
    name,
    productId: null,
    unitCostSatang: 1000,
    reorder: { reorderPoint: 2, reorderQuantity: 10, leadTimeDays: 3, supplierName },
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

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const hkt = (await ctx.db.select().from(branch)).find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) {
    places.set(l.name, l.id);
  }
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('GATE-1 — a delivery against an order lands on a size the manager has since removed', () => {
  it('a received order line never puts stock on an archived item (size removed while on order)', async () => {
    const item = await twoSizeItem('Gate Tape', 'Gate Supplies Co.');
    // The manager orders 10 of size B and places the order.
    const add = await call('POST', `${base()}/purchase-orders/lines`, manager, { lines: [{ stockItemId: item.b, quantity: 10 }] });
    expect(add.statusCode).toBe(200);
    const order = (add.json() as { orders: Array<{ id: string; lines: Array<{ id: string; stockItemId: string }> }> }).orders[0]!;
    const lineId = order.lines.find((l) => l.stockItemId === item.b)!.id;
    expect((await call('POST', `${base()}/purchase-orders/${order.id}/ordered`, manager, {})).statusCode).toBe(200);
    // Then removes size B from the item: it holds nothing, so the form lets it go.
    const edit = await call('PUT', `${base()}/items/${item.groupId}`, manager, {
      name: 'Gate Tape',
      productId: null,
      unitCostSatang: 1000,
      reorder: { reorderPoint: 2, reorderQuantity: 10, leadTimeDays: 3, supplierName: 'Gate Supplies Co.' },
      units: [],
      sizes: [{ stockItemId: item.a, variantId: null, label: 'A', lowStockThreshold: null, parByLocation: {} }],
    });
    // The delivery arrives and reception receives it against the order.
    const got = await call('POST', `${base()}/purchase-orders/${order.id}/lines/${lineId}/receive`, reception, {
      quantity: 10,
      locationId: places.get('BOH'),
    });
    // EITHER refusal is a fix: the size cannot go while an open order wants it,
    // or the receipt is refused in words. What may not happen is both succeeding.
    expect(edit.statusCode === 200 && got.statusCode === 200).toBe(false);
    // The fix chosen: the size stays while the order wants it, in words.
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.message).toBe('Gate Tape B is on the open order to Gate Supplies Co. — receive or remove that line first');
    expect(got.statusCode).toBe(200);
    expect(await stockOnArchivedItems()).toEqual([]);
    await expectLedgerAddsUp();
  });

  it('a size still wanted on an order that is not placed yet cannot be removed either', async () => {
    const item = await twoSizeItem('Gate Twine', 'Twine Ltd.');
    const add = await call('POST', `${base()}/purchase-orders/lines`, manager, { lines: [{ stockItemId: item.b, quantity: 2 }] });
    expect(add.statusCode).toBe(200);
    const edit = await call('PUT', `${base()}/items/${item.groupId}`, manager, {
      name: 'Gate Twine',
      productId: null,
      unitCostSatang: 1000,
      reorder: { reorderPoint: 2, reorderQuantity: 10, leadTimeDays: 3, supplierName: 'Twine Ltd.' },
      units: [],
      sizes: [{ stockItemId: item.a, variantId: null, label: 'A', lowStockThreshold: null, parByLocation: {} }],
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.code).toBe('STOCK_SIZE_ON_ORDER');
  });

  it('safety net: a line whose size was archived anyway is refused at receive, in words', async () => {
    const item = await twoSizeItem('Gate Wire', 'Wire Ltd.');
    const add = await call('POST', `${base()}/purchase-orders/lines`, manager, { lines: [{ stockItemId: item.b, quantity: 3 }] });
    const order = (add.json() as { orders: Array<{ id: string; lines: Array<{ id: string; stockItemId: string }> }> }).orders[0]!;
    const lineId = order.lines.find((l) => l.stockItemId === item.b)!.id;
    expect((await call('POST', `${base()}/purchase-orders/${order.id}/ordered`, manager, {})).statusCode).toBe(200);
    // Reach past the form's guard, as a pre-fix row would have.
    await ctx.db.update(stockItem).set({ archivedAt: new Date(), active: false }).where(eq(stockItem.id, item.b));
    const got = await call('POST', `${base()}/purchase-orders/${order.id}/lines/${lineId}/receive`, reception, {
      quantity: 3,
      locationId: places.get('BOH'),
    });
    expect(got.statusCode).toBe(409);
    expect(got.json().error.message).toBe('Gate Wire B was removed from stock — it cannot be received; add the size back and order it again');
    expect(await stockOnArchivedItems()).toEqual([]);
    await expectLedgerAddsUp();
  });
});

describe('GATE-2 — "a size that still holds stock cannot be removed" is passed by retiring the place first', () => {
  it('removing a size is refused while any place, retired or not, holds it', async () => {
    const item = await twoSizeItem('Gate Rope', 'Gate Supplies Co.');
    const shed = await call('POST', `${base()}/locations`, manager, { name: 'Gate Shed', type: 'bulk' });
    expect(shed.statusCode).toBe(200);
    const shedId = (shed.json() as { id: string }).id;
    const got = await call('POST', `${base()}/receipts`, reception, {
      stockItemId: item.b,
      locationId: shedId,
      quantity: 5,
      reason: 'Delivery with no order',
    });
    expect(got.statusCode).toBe(200);
    // Retiring a place that holds stock is allowed (the prototype allows it).
    expect((await call('PATCH', `${base()}/locations/${shedId}`, manager, { active: false })).statusCode).toBe(200);
    // Now the size-removal guard reads 0 (it sums ACTIVE places only) and lets B go.
    const edit = await call('PUT', `${base()}/items/${item.groupId}`, manager, {
      name: 'Gate Rope',
      productId: null,
      unitCostSatang: 1000,
      reorder: { reorderPoint: 2, reorderQuantity: 10, leadTimeDays: 3, supplierName: 'Gate Supplies Co.' },
      units: [],
      sizes: [{ stockItemId: item.a, variantId: null, label: 'A', lowStockThreshold: null, parByLocation: {} }],
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.message).toBe(
      'Gate Rope B still holds 5 (5 at Gate Shed, retired) — reactivate the place, then count it out or move it before removing the size',
    );
    expect(await stockOnArchivedItems()).toEqual([]);
  });
});

describe('ATTACKS THAT HELD', () => {
  it('reception is refused every purchase-order and setup write the first suite did not try', async () => {
    const item = await twoSizeItem('Gate Chalk', 'Chalk Ltd.');
    const add = await call('POST', `${base()}/purchase-orders/lines`, manager, { lines: [{ stockItemId: item.a, quantity: 4 }] });
    const order = (add.json() as { orders: Array<{ id: string; lines: Array<{ id: string }> }> }).orders[0]!;
    const lineId = order.lines[0]!.id;
    const refused = [
      await call('PATCH', `${base()}/purchase-orders/${order.id}/lines/${lineId}`, reception, { quantity: 9 }),
      await call('DELETE', `${base()}/purchase-orders/${order.id}/lines/${lineId}`, reception),
      await call('POST', `${base()}/purchase-orders/${order.id}/ordered`, reception, {}),
      await call('PATCH', `${base()}/locations/${places.get('Store')}`, reception, { name: 'Renamed' }),
      await call('PUT', `${base()}/items/${item.groupId}`, reception, {
        name: 'Gate Chalk',
        productId: null,
        unitCostSatang: null,
        reorder: null,
        units: [],
        sizes: [{ stockItemId: item.a, variantId: null, label: 'A', lowStockThreshold: null, parByLocation: {} }],
      }),
    ];
    expect(refused.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403]);
    // Reception may receive against a placed order (OD-S4).
    expect((await call('POST', `${base()}/purchase-orders/${order.id}/ordered`, manager, {})).statusCode).toBe(200);
    const got = await call('POST', `${base()}/purchase-orders/${order.id}/lines/${lineId}/receive`, reception, {
      quantity: 4,
      locationId: places.get('BOH'),
    });
    expect(got.json()).toMatchObject({ received: 4, order: { state: 'received' } });
    await expectLedgerAddsUp();
  });

  it('a transfer never moves more than the source held, even when one item is named on several lines', async () => {
    const item = await twoSizeItem('Gate Pegs', 'Pegs Ltd.');
    await call('POST', `${base()}/receipts`, reception, { stockItemId: item.a, locationId: places.get('BOH'), quantity: 3, reason: 'Found' });
    const res = await call('POST', `${base()}/transfers`, reception, {
      fromLocationId: places.get('BOH'),
      toLocationId: places.get('FOH'),
      lines: [
        { stockItemId: item.a, quantity: 2 },
        { stockItemId: item.a, quantity: 2 },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { lines: Array<{ requested: number; moved: number; fromLevel: number }> }).lines).toEqual([
      expect.objectContaining({ requested: 4, moved: 3, fromLevel: 0 }),
    ]);
    await expectLedgerAddsUp();
  });

  it('a count into a retired place is refused in words', async () => {
    const item = await twoSizeItem('Gate Flags', 'Flags Ltd.');
    const loft = await call('POST', `${base()}/locations`, manager, { name: 'Gate Loft', type: 'bulk' });
    const loftId = (loft.json() as { id: string }).id;
    await call('PATCH', `${base()}/locations/${loftId}`, manager, { active: false });
    const count = await call('POST', `${base()}/stock-takes`, reception, {
      lines: [{ stockItemId: item.a, locationId: loftId, countedQuantity: 4 }],
    });
    expect(count.statusCode).toBe(409);
    expect(count.json().error.message).toBe('Gate Loft is retired — reactivate it first');
    await expectLedgerAddsUp();
  });
});
