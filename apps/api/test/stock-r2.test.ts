import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  branch,
  product,
  purchaseOrder,
  stockAttention,
  stockItem,
  stockLevel,
  stockLocation,
  stockMovement,
  stockTake,
} from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-14b round 2 — the stock module live (plan docs/progress/plans/stock/PLAN.md
 * §2.3, OD-S1, OD-S4, OD-S5), through the real routes with real sessions, and
 * the database read back after every flow.
 *
 * THE FIXTURES are the seeded opening count (the prototype's own figures,
 * OD-S2), at HKT Central:
 *   Oto Cap            BOH 18, FOH 7   par FOH 10, reorder 15, Bangkok Merch Co. (7 days)
 *   Oto T-Shirt        BOH 28, FOH 12  par FOH 15, reorder 20, Bangkok Merch Co.
 *   Water Bottle       BOH 22, FOH 8   Bottle House TH (10 days)
 *   Mascot Keyring     out everywhere  par FOH 8, reorder 5
 *   Grip Socks (shop)  S 18+7, M 28+12, L 14+6
 * Nothing starts in the Store (bulk). Robinson Chalong has no stock at all,
 * which is what the opening-count test needs.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let admin: string;
let branchId: string;
let chalongId: string;
const productIds = new Map<string, string>();
const places = new Map<string, string>();

const base = () => `/branches/${branchId}/stock`;

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie, ...headers },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function itemIdOf(code: string, variantId: string | null = null, atBranch = branchId): Promise<string> {
  const [row] = await ctx.db
    .select({ id: stockItem.id })
    .from(stockItem)
    .where(
      and(
        eq(stockItem.productId, productIds.get(code)!),
        eq(stockItem.branchId, atBranch),
        isNull(stockItem.archivedAt),
        variantId === null ? sql`${stockItem.variantId} is null` : eq(stockItem.variantId, variantId),
      ),
    );
  return row!.id;
}

/** What one stock item holds, by place name. */
async function heldBy(stockItemId: string): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ place: stockLocation.name, quantity: stockLevel.quantity })
    .from(stockLevel)
    .innerJoin(stockLocation, eq(stockLocation.id, stockLevel.stockLocationId))
    .where(eq(stockLevel.stockItemId, stockItemId));
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
  const { rows: orphans } = await ctx.db.execute(sql`
    select 1 from pos.stock_movement m
     where not exists (select 1 from pos.stock_level l
                        where l.stock_item_id = m.stock_item_id and l.stock_location_id = m.stock_location_id)`);
  expect(orphans).toEqual([]);
}

async function auditRows(action: string, entityId?: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), entityId ? eq(auditLog.entityId, entityId) : undefined));
}

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  chalongId = branches.find((row) => row.code === 'robinson-chalong')!.id;
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, hkt.operatorId))) {
    if (p.code) productIds.set(p.code, p.id);
  }
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) {
    places.set(l.name, l.id);
  }
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('transfers clamp to what the source holds and log what moved', () => {
  it('moves stock between two places as one out-and-in pair', async () => {
    const cap = await itemIdOf('MR-CAP');
    const res = await call('POST', `${base()}/transfers`, reception, {
      fromLocationId: places.get('BOH'),
      toLocationId: places.get('FOH'),
      lines: [{ stockItemId: cap, quantity: 5 }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transferId: string; lines: Array<{ moved: number; fromLevel: number; toLevel: number }> };
    expect(body.lines).toEqual([{ stockItemId: cap, requested: 5, moved: 5, fromLevel: 13, toLevel: 12 }]);
    expect(await heldBy(cap)).toMatchObject({ BOH: 13, FOH: 12 });
    const moves = await ctx.db.select().from(stockMovement).where(eq(stockMovement.transferId, body.transferId));
    expect(moves.map((m) => [m.kind, m.quantity]).sort()).toEqual([
      ['transfer_in', 5],
      ['transfer_out', -5],
    ]);
    expect(await auditRows('stock.transfer', body.transferId)).toHaveLength(1);
    await expectLedgerAddsUp();
  });

  it('clamps a request past what the source holds, and says what moved', async () => {
    const cap = await itemIdOf('MR-CAP');
    const res = await call('POST', `${base()}/transfers`, reception, {
      fromLocationId: places.get('FOH'),
      toLocationId: places.get('Store'),
      lines: [{ stockItemId: cap, quantity: 100 }],
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { lines: Array<{ moved: number }> }).lines[0]).toMatchObject({ requested: 100, moved: 12 });
    expect(await heldBy(cap)).toMatchObject({ FOH: 0, Store: 12, BOH: 13 });
    await expectLedgerAddsUp();
  });

  it('refuses, in plain words, a transfer in which nothing could move', async () => {
    const keyring = await itemIdOf('MR-KEYRING');
    const res = await call('POST', `${base()}/transfers`, reception, {
      fromLocationId: places.get('Store'),
      toLocationId: places.get('FOH'),
      lines: [{ stockItemId: keyring, quantity: 3 }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Store holds no Mascot Keyring — nothing was moved');
    const same = await call('POST', `${base()}/transfers`, reception, {
      fromLocationId: places.get('FOH'),
      toLocationId: places.get('FOH'),
      lines: [{ stockItemId: keyring, quantity: 1 }],
    });
    expect(same.statusCode).toBe(400);
    expect(same.json().error.message).toBe('From and To must be different');
  });

  it('a replay with the same idempotency key moves nothing twice', async () => {
    const cap = await itemIdOf('MR-CAP');
    const before = await heldBy(cap);
    const payload = { fromLocationId: places.get('Store'), toLocationId: places.get('FOH'), lines: [{ stockItemId: cap, quantity: 2 }] };
    const headers = { 'idempotency-key': `stock-r2-transfer-${newId()}` };
    const first = await call('POST', `${base()}/transfers`, reception, payload, headers);
    const second = await call('POST', `${base()}/transfers`, reception, payload, headers);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await heldBy(cap)).toMatchObject({ Store: before.Store! - 2, FOH: (before.FOH ?? 0) + 2 });
    await expectLedgerAddsUp();
  });
});

describe('receiving with no order needs a reason', () => {
  it('takes a delivery into the place chosen, with the reason on the movement and an audit row', async () => {
    const bottle = await itemIdOf('MR-BOTTLE');
    const blank = await call('POST', `${base()}/receipts`, reception, {
      stockItemId: bottle,
      locationId: places.get('BOH'),
      quantity: 24,
      reason: '   ',
    });
    expect(blank.statusCode).toBe(400);
    const res = await call('POST', `${base()}/receipts`, reception, {
      stockItemId: bottle,
      locationId: places.get('BOH'),
      quantity: 24,
      reason: 'Supplier top-up',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: 24, levelAfter: 46 });
    const [move] = await ctx.db
      .select()
      .from(stockMovement)
      .where(and(eq(stockMovement.stockItemId, bottle), eq(stockMovement.kind, 'receive')));
    expect(move).toMatchObject({ quantity: 24, reason: 'Supplier top-up' });
    expect(await auditRows('stock.receive', bottle)).toHaveLength(1);
    await expectLedgerAddsUp();
  });
});

describe('purchase orders: to order → ordered → received', () => {
  let capOrderId: string;
  let capLineId: string;

  it('one open order per supplier; a repeat size merges into its line', async () => {
    const cap = await itemIdOf('MR-CAP');
    const tshirt = await itemIdOf('MR-TSHIRT');
    const bottle = await itemIdOf('MR-BOTTLE');
    const first = await call('POST', `${base()}/purchase-orders/lines`, manager, {
      lines: [
        { stockItemId: cap, quantity: 24 },
        { stockItemId: bottle, quantity: 48 },
      ],
    });
    expect(first.statusCode).toBe(200);
    const orders = (first.json() as { orders: Array<{ id: string; supplierName: string; state: string }> }).orders;
    expect(orders.map((o) => [o.supplierName, o.state]).sort()).toEqual([
      ['Bangkok Merch Co.', 'to_order'],
      ['Bottle House TH', 'to_order'],
    ]);
    const again = await call('POST', `${base()}/purchase-orders/lines`, manager, {
      lines: [
        { stockItemId: cap, quantity: 10 },
        { stockItemId: tshirt, quantity: 48 },
      ],
    });
    const merch = (again.json() as { orders: Array<{ id: string; lines: Array<{ id: string; stockItemId: string; orderedQuantity: number }> }> }).orders;
    expect(merch).toHaveLength(1);
    expect(merch[0]!.id).toBe(orders.find((o) => o.supplierName === 'Bangkok Merch Co.')!.id);
    expect(merch[0]!.lines.map((l) => [l.stockItemId, l.orderedQuantity])).toEqual([
      [cap, 34],
      [tshirt, 48],
    ]);
    const open = await ctx.db
      .select()
      .from(purchaseOrder)
      .where(and(eq(purchaseOrder.branchId, branchId), eq(purchaseOrder.state, 'to_order')));
    expect(open).toHaveLength(2);
    capOrderId = merch[0]!.id;
    capLineId = merch[0]!.lines[0]!.id;
  });

  it('lines change only while to order, one each at least; removing the last line deletes the order', async () => {
    const zero = await call('PATCH', `${base()}/purchase-orders/${capOrderId}/lines/${capLineId}`, manager, { quantity: 0 });
    expect(zero.statusCode).toBe(400);
    const set = await call('PATCH', `${base()}/purchase-orders/${capOrderId}/lines/${capLineId}`, manager, { quantity: 30 });
    expect(set.statusCode).toBe(200);
    const lines = (set.json() as { order: { lines: Array<{ id: string; orderedQuantity: number }> } }).order.lines;
    expect(lines.find((l) => l.id === capLineId)!.orderedQuantity).toBe(30);
    // The bottle order has one line: removing it deletes the order.
    const orders = (await call('GET', `${base()}/purchase-orders`, reception)).json() as {
      orders: Array<{ id: string; supplierName: string; lines: Array<{ id: string }> }>;
    };
    const bottleOrder = orders.orders.find((o) => o.supplierName === 'Bottle House TH')!;
    const removed = await call('DELETE', `${base()}/purchase-orders/${bottleOrder.id}/lines/${bottleOrder.lines[0]!.id}`, manager);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ order: null });
    expect(await ctx.db.select().from(purchaseOrder).where(eq(purchaseOrder.id, bottleOrder.id))).toEqual([]);
    expect(await auditRows('purchase_order.delete', bottleOrder.id)).toHaveLength(1);
  });

  it('placing it stamps the date and the expected arrival, today + the largest lead time; then lines are fixed', async () => {
    const res = await call('POST', `${base()}/purchase-orders/${capOrderId}/ordered`, manager, { notes: 'PO-1001' });
    expect(res.statusCode).toBe(200);
    const order = (res.json() as { order: { state: string; orderedAt: string; orderedBy: string; expectedArrivalDate: string; notes: string } }).order;
    expect(order.state).toBe('ordered');
    expect(order.orderedBy).toBeTruthy();
    expect(order.notes).toBe('PO-1001');
    // Bangkok Merch Co. items carry a 7-day lead time.
    const { rows } = await ctx.db.execute(
      sql`select ((now() at time zone 'Asia/Bangkok' - interval '5 hours')::date + 7)::text as d`,
    );
    expect(order.expectedArrivalDate).toBe((rows[0] as { d: string }).d);
    const late = await call('PATCH', `${base()}/purchase-orders/${capOrderId}/lines/${capLineId}`, manager, { quantity: 5 });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toBe(
      'The order to Bangkok Merch Co. is already placed — its lines can no longer change',
    );
  });

  it('receives against a line, clamped to what is outstanding, and closes when every line is in', async () => {
    const cap = await itemIdOf('MR-CAP');
    const tshirt = await itemIdOf('MR-TSHIRT');
    const capBefore = (await heldBy(cap)).BOH ?? 0;
    const orders = (await call('GET', `${base()}/purchase-orders`, reception)).json() as {
      orders: Array<{ id: string; lines: Array<{ id: string; stockItemId: string }> }>;
    };
    const order = orders.orders.find((o) => o.id === capOrderId)!;
    const tshirtLine = order.lines.find((l) => l.stockItemId === tshirt)!;
    // Reception receives (OD-S4): 20 of 30 caps into BOH, then 50 more — clamped to the 10 outstanding.
    const part = await call('POST', `${base()}/purchase-orders/${capOrderId}/lines/${capLineId}/receive`, reception, {
      quantity: 20,
      locationId: places.get('BOH'),
    });
    expect(part.statusCode).toBe(200);
    expect(part.json()).toMatchObject({ requested: 20, received: 20, order: { state: 'ordered' } });
    const rest = await call('POST', `${base()}/purchase-orders/${capOrderId}/lines/${capLineId}/receive`, reception, {
      quantity: 50,
      locationId: places.get('BOH'),
    });
    expect(rest.json()).toMatchObject({ requested: 50, received: 10, order: { state: 'ordered' } });
    expect((await heldBy(cap)).BOH).toBe(capBefore + 30);
    const done = await call('POST', `${base()}/purchase-orders/${capOrderId}/lines/${capLineId}/receive`, reception, {
      quantity: 1,
      locationId: places.get('BOH'),
    });
    expect(done.statusCode).toBe(409);
    expect(done.json().error.message).toBe('All 30 Oto Cap on this order are already in');
    // The last line in closes the order.
    const last = await call('POST', `${base()}/purchase-orders/${capOrderId}/lines/${tshirtLine.id}/receive`, reception, {
      quantity: 48,
      locationId: places.get('Store'),
    });
    expect(last.json()).toMatchObject({ received: 48, order: { state: 'received' } });
    const [row] = await ctx.db.select().from(purchaseOrder).where(eq(purchaseOrder.id, capOrderId));
    expect(row!.receivedAt).not.toBeNull();
    const after = await call('POST', `${base()}/purchase-orders/${capOrderId}/lines/${tshirtLine.id}/receive`, reception, {
      quantity: 1,
      locationId: places.get('Store'),
    });
    expect(after.json().error.message).toBe('The order to Bangkok Merch Co. is already received in full');
    const moves = await ctx.db.select().from(stockMovement).where(eq(stockMovement.purchaseOrderLineId, capLineId));
    expect(moves.map((m) => m.quantity).sort((a, b) => a - b)).toEqual([10, 20]);
    await expectLedgerAddsUp();
  });

  it('cannot receive against an order that is not placed yet', async () => {
    const plush = await itemIdOf('MR-PLUSH');
    const add = await call('POST', `${base()}/purchase-orders/lines`, manager, { lines: [{ stockItemId: plush, quantity: 6 }] });
    const order = (add.json() as { orders: Array<{ id: string; supplierName: string; lines: Array<{ id: string }> }> }).orders[0]!;
    // No supplier set on the plush: the prototype's "Unknown supplier".
    expect(order.supplierName).toBe('Unknown supplier');
    const res = await call('POST', `${base()}/purchase-orders/${order.id}/lines/${order.lines[0]!.id}/receive`, reception, {
      quantity: 6,
      locationId: places.get('BOH'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('The order to Unknown supplier is not placed yet — mark it ordered first');
    await call('DELETE', `${base()}/purchase-orders/${order.id}/lines/${order.lines[0]!.id}`, manager);
  });
});

describe('a stock take adjusts to the count, flags above three, and is audited (OD-S1)', () => {
  it('sets each counted shelf, flags a big difference, and leaves an exact count unmoved', async () => {
    const s = await itemIdOf('MR-SOCKS', 's');
    const m = await itemIdOf('MR-SOCKS', 'm');
    const l = await itemIdOf('MR-SOCKS', 'l');
    const foh = places.get('FOH')!;
    const res = await call('POST', `${base()}/stock-takes`, reception, {
      lines: [
        { stockItemId: s, locationId: foh, countedQuantity: 2 },
        { stockItemId: m, locationId: foh, countedQuantity: 13 },
        { stockItemId: l, locationId: foh, countedQuantity: 6 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const take = res.json() as { id: string; opening: boolean; lines: Array<{ stockItemId: string; expectedQuantity: number; difference: number; flagged: boolean; status: string }> };
    // The seed's opening count was HKT Central's first: this is not.
    expect(take.opening).toBe(false);
    const byItem = new Map(take.lines.map((x) => [x.stockItemId, x]));
    expect(byItem.get(s)).toMatchObject({ expectedQuantity: 7, difference: -5, flagged: true, status: 'adjusted' });
    expect(byItem.get(m)).toMatchObject({ expectedQuantity: 12, difference: 1, flagged: false, status: 'adjusted' });
    expect(byItem.get(l)).toMatchObject({ expectedQuantity: 6, difference: 0, flagged: false, status: 'confirmed' });
    expect((await heldBy(s)).FOH).toBe(2);
    expect((await heldBy(m)).FOH).toBe(13);
    const moves = await ctx.db.select().from(stockMovement).where(eq(stockMovement.kind, 'count'));
    const mine = moves.filter((x) => [s, m, l].includes(x.stockItemId) && x.stockTakeLineId && x.reason?.startsWith('Stock take'));
    expect(mine.map((x) => x.quantity).sort((a, b) => a - b)).toEqual([-5, 1]);
    const [auditRow] = await auditRows('stock.count', take.id);
    expect((auditRow!.after as { flagged: Array<{ stockItemId: string }> }).flagged.map((f) => f.stockItemId)).toEqual([s]);
    await expectLedgerAddsUp();
  });

  it('refuses a shelf counted twice in one take', async () => {
    const s = await itemIdOf('MR-SOCKS', 's');
    const res = await call('POST', `${base()}/stock-takes`, reception, {
      lines: [
        { stockItemId: s, locationId: places.get('FOH'), countedQuantity: 1 },
        { stockItemId: s, locationId: places.get('FOH'), countedQuantity: 2 },
      ],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('places: exactly one active sell point, which cannot be retired or retyped', () => {
  const at = () => `/branches/${chalongId}/stock`;
  let foh: string;
  let back: string;
  let counter2: string;

  it('the first FOH rotation place becomes the sell point; the next one does not', async () => {
    const a = await call('POST', `${at()}/locations`, admin, { name: 'FOH', type: 'rotation' });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ name: 'FOH', sellPoint: true, active: true });
    foh = (a.json() as { id: string }).id;
    const b = await call('POST', `${at()}/locations`, admin, { name: 'Back', type: 'back_of_house' });
    back = (b.json() as { id: string }).id;
    expect(b.json()).toMatchObject({ sellPoint: false });
    const c = await call('POST', `${at()}/locations`, admin, { name: 'Counter 2', type: 'rotation' });
    counter2 = (c.json() as { id: string }).id;
    expect(c.json()).toMatchObject({ sellPoint: false });
    const clash = await call('POST', `${at()}/locations`, admin, { name: 'foh', type: 'bulk' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toBe('There is already a place called "foh" here');
  });

  it('refuses to retire or retype the sell point, or make a non-rotation place the sell point', async () => {
    const retire = await call('PATCH', `${at()}/locations/${foh}`, admin, { active: false });
    expect(retire.statusCode).toBe(409);
    expect(retire.json().error.message).toBe('FOH is the sell point — set another sell point before retiring it');
    const retype = await call('PATCH', `${at()}/locations/${foh}`, admin, { type: 'bulk' });
    expect(retype.statusCode).toBe(409);
    expect(retype.json().error.code).toBe('STOCK_SELL_POINT_TYPE');
    const wrong = await call('POST', `${at()}/locations/${back}/sell-point`, admin);
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.message).toBe('Only a FOH rotation place can be the sell point');
  });

  it('moves the sell point, keeping exactly one, and then the old one may retire', async () => {
    const moved = await call('POST', `${at()}/locations/${counter2}/sell-point`, admin);
    expect(moved.statusCode).toBe(200);
    const sellPoints = await ctx.db
      .select()
      .from(stockLocation)
      .where(and(eq(stockLocation.branchId, chalongId), eq(stockLocation.sellPoint, true), eq(stockLocation.active, true)));
    expect(sellPoints.map((p) => p.id)).toEqual([counter2]);
    const retire = await call('PATCH', `${at()}/locations/${foh}`, admin, { active: false });
    expect(retire.statusCode).toBe(200);
    const onRetired = await call('POST', `${at()}/locations/${foh}/sell-point`, admin);
    expect(onRetired.statusCode).toBe(409);
    expect(onRetired.json().error.message).toBe('FOH is retired — reactivate it before making it the sell point');
    const list = (await call('GET', `${at()}/locations?all=true`, admin)).json() as { locations: Array<{ id: string; active: boolean }> };
    expect(list.locations.find((l) => l.id === foh)).toMatchObject({ active: false });
    const live = (await call('GET', `${at()}/locations`, admin)).json() as { locations: Array<{ id: string }> };
    expect(live.locations.map((l) => l.id)).not.toContain(foh);
  });

  it("a branch's FIRST count is its opening (OD-S5)", async () => {
    const created = await call('POST', `${at()}/items`, admin, {
      name: 'Chalong Socks',
      productId: null,
      unitCostSatang: 2000,
      reorder: null,
      units: [{ label: 'Dozen', eaches: 12 }],
      sizes: [{ variantId: null, label: 'Default', lowStockThreshold: 5, parByLocation: { [counter2]: 10 } }],
    });
    expect(created.statusCode).toBe(200);
    const [itemId] = (created.json() as { stockItemIds: string[] }).stockItemIds;
    const first = await call('POST', `${at()}/stock-takes`, admin, {
      lines: [{ stockItemId: itemId, locationId: counter2, countedQuantity: 24 }],
    });
    expect(first.json()).toMatchObject({ opening: true, lines: [{ expectedQuantity: 0, difference: 24, flagged: false }] });
    expect(await auditRows('stock.opening_count', (first.json() as { id: string }).id)).toHaveLength(1);
    const second = await call('POST', `${at()}/stock-takes`, admin, {
      lines: [{ stockItemId: itemId!, locationId: counter2, countedQuantity: 24 }],
    });
    expect(second.json()).toMatchObject({ opening: false, lines: [{ difference: 0, status: 'confirmed' }] });
    const takes = await ctx.db.select().from(stockTake).where(eq(stockTake.branchId, chalongId));
    expect(takes.filter((t) => t.opening)).toHaveLength(1);
    await expectLedgerAddsUp();
  });
});

describe('low-stock attention: one per item and branch, the rule that fired, quiet while an order covers it', () => {
  async function attention() {
    const res = await call('GET', `${base()}/attention`, reception);
    expect(res.statusCode).toBe(200);
    return (res.json() as { attention: Array<{ id: string; kind: string; stockItemId: string | null; rule: string | null; summary: string }> }).attention;
  }

  it('the keyring, out everywhere, is ≤ reorder point AND below par at FOH — one row carrying both', async () => {
    const keyring = await itemIdOf('MR-KEYRING');
    const rows = (await attention()).filter((a) => a.stockItemId === keyring);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'reorder', rule: '≤ reorder point · Below par at FOH' });
    // Read again: still one open row, the same one.
    const again = (await attention()).filter((a) => a.stockItemId === keyring);
    expect(again.map((a) => a.id)).toEqual([rows[0]!.id]);
    const open = await ctx.db
      .select()
      .from(stockAttention)
      .where(and(eq(stockAttention.stockItemId, keyring), isNull(stockAttention.resolvedAt)));
    expect(open).toHaveLength(1);
  });

  it('the sizes of one item are one row (the grip socks: S, M and L below par)', async () => {
    const sizes = await Promise.all(['s', 'm', 'l'].map((v) => itemIdOf('MR-SOCKS', v)));
    const rows = (await attention()).filter((a) => a.stockItemId && sizes.includes(a.stockItemId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rule).toContain('Below par at FOH');
  });

  it('keeps an alert while an open purchase order covers the item', async () => {
    const keyring = await itemIdOf('MR-KEYRING');
    const add = await call('POST', `${base()}/purchase-orders/lines`, manager, { lines: [{ stockItemId: keyring, quantity: 24 }] });
    const order = (add.json() as { orders: Array<{ id: string; lines: Array<{ id: string; stockItemId: string }> }> }).orders[0]!;
    expect((await attention()).filter((a) => a.stockItemId === keyring)).toHaveLength(1);
    const line = order.lines.find((l) => l.stockItemId === keyring)!;
    await call('DELETE', `${base()}/purchase-orders/${order.id}/lines/${line.id}`, manager);
    expect((await attention()).filter((a) => a.stockItemId === keyring)).toHaveLength(1);
  });

  it('resolves when the rule stops firing: a transfer brings the plush up to par', async () => {
    const plush = await itemIdOf('MR-PLUSH');
    const before = (await attention()).filter((a) => a.stockItemId === plush);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ kind: 'low_stock', rule: 'Below par at FOH' });
    await call('POST', `${base()}/transfers`, reception, {
      fromLocationId: places.get('BOH'),
      toLocationId: places.get('FOH'),
      lines: [{ stockItemId: plush, quantity: 4 }],
    });
    expect((await attention()).filter((a) => a.stockItemId === plush)).toEqual([]);
    const [row] = await ctx.db.select().from(stockAttention).where(eq(stockAttention.id, before[0]!.id));
    expect(row!.resolvedAt).not.toBeNull();
  });

  it("lists the round-1 rows too, and a person can close one", async () => {
    const id = newId();
    const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
    await ctx.db.insert(stockAttention).values({
      id,
      operatorId: hkt!.operatorId,
      branchId,
      kind: 'stock_shortfall',
      dedupeKey: `shortfall:test:${id}`,
      quantity: 2,
      summary: '2 Oto Cap sold that the record did not hold — count the shelf',
    });
    expect((await attention()).find((a) => a.id === id)).toMatchObject({ kind: 'stock_shortfall' });
    const closed = await call('POST', `${base()}/attention/${id}/resolve`, reception);
    expect(closed.statusCode).toBe(200);
    expect((await attention()).find((a) => a.id === id)).toBeUndefined();
    expect(await auditRows('stock_attention.resolve', id)).toHaveLength(1);
  });
});

describe('who may do what (OD-S4): staff move, receive and count; orders and setup are a manager’s', () => {
  it('refuses reception every order and setup write', async () => {
    const cap = await itemIdOf('MR-CAP');
    const refused = [
      await call('POST', `${base()}/purchase-orders/lines`, reception, { lines: [{ stockItemId: cap, quantity: 1 }] }),
      await call('POST', `${base()}/adjustments`, reception, { stockItemId: cap, delta: -1, reason: 'Damaged' }),
      await call('POST', `${base()}/locations`, reception, { name: 'Kiosk', type: 'rotation' }),
      await call('POST', `${base()}/items`, reception, {
        name: 'Thing',
        productId: null,
        unitCostSatang: null,
        reorder: null,
        units: [],
        sizes: [{ variantId: null, label: 'Default', lowStockThreshold: null, parByLocation: {} }],
      }),
      await call('POST', `${base()}/locations/${places.get('FOH')}/sell-point`, reception),
    ];
    expect(refused.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403]);
  });
});

describe("a manager's correction, and setup", () => {
  it('a decrease takes from the sell point first, then the cascade, never past what is there', async () => {
    const tshirt = await itemIdOf('MR-TSHIRT');
    const before = await heldBy(tshirt);
    const res = await call('POST', `${base()}/adjustments`, manager, { stockItemId: tshirt, delta: -14, reason: 'Damaged / shrinkage' });
    expect(res.statusCode).toBe(200);
    const after = await heldBy(tshirt);
    expect(after.FOH).toBe(0);
    expect(after.BOH).toBe((before.BOH ?? 0) - (14 - (before.FOH ?? 0)));
    const tooMany = await call('POST', `${base()}/adjustments`, manager, { stockItemId: tshirt, delta: -100000, reason: 'x' });
    expect(tooMany.statusCode).toBe(200);
    expect(tooMany.json().delta).toBe(-Object.values(after).reduce((sum, count) => sum + count, 0));
    expect(Object.values(await heldBy(tshirt)).every((quantity) => quantity === 0)).toBe(true);
    await expectLedgerAddsUp();
  });

  it('edits an item: thresholds and packs land on every size, and a size holding stock cannot be dropped', async () => {
    const capGroup = productIds.get('MR-CAP')!;
    const cap = await itemIdOf('MR-CAP');
    const res = await call('PUT', `${base()}/items/${capGroup}`, manager, {
      name: 'Oto Cap',
      productId: capGroup,
      unitCostSatang: 9000,
      reorder: { reorderPoint: 15, reorderQuantity: 24, leadTimeDays: 7, supplierName: 'Bangkok Merch Co.', supplierContact: '02-555-0100' },
      units: [{ label: 'Box', eaches: 6 }],
      sizes: [{ stockItemId: cap, variantId: null, label: 'Default', lowStockThreshold: 4, parByLocation: { [places.get('FOH')!]: 10 } }],
    });
    expect(res.statusCode).toBe(200);
    const levels = (await call('GET', `${base()}/levels`, manager)).json() as {
      items: Array<{ id: string; groupId: string; lowStockThreshold: number; units: Array<{ label: string; eaches: number }>; productKind: string }>;
    };
    const row = levels.items.find((i) => i.id === cap)!;
    expect(row).toMatchObject({ groupId: capGroup, lowStockThreshold: 4, productKind: 'merch', units: [{ label: 'Box', eaches: 6 }] });

    const socksGroup = productIds.get('MR-SOCKS')!;
    const s = await itemIdOf('MR-SOCKS', 's');
    const drop = await call('PUT', `${base()}/items/${socksGroup}`, manager, {
      name: 'Grip Socks (Merch)',
      productId: null,
      unitCostSatang: null,
      reorder: null,
      units: [],
      sizes: [{ stockItemId: s, variantId: null, label: 'S', lowStockThreshold: 8, parByLocation: {} }],
    });
    expect(drop.statusCode).toBe(409);
    expect(drop.json().error.message).toMatch(/^Grip Socks \(Merch\) M still holds \d+ \(\d+ at [^)]+\) — count it out or move it before removing the size$/);
  });

  it('creates starting stock once at the sell point with its operator and audit, and refuses starting stock on edits', async () => {
    const key = `stock-opening-${newId()}`;
    const body = { name: 'Opening test item', productId: null, unitCostSatang: 25, reorder: null,
      units: [{ label: 'Each pack', eaches: 1 }], sizes: [{ variantId: null, label: 'Default', lowStockThreshold: null, parByLocation: {}, startingStock: 7 }] };
    const headers = { 'idempotency-key': key };
    const first = await call('POST', `${base()}/items`, manager, body, headers);
    expect(first.statusCode).toBe(200);
    const replay = await call('POST', `${base()}/items`, manager, body, headers);
    expect(replay.json()).toEqual(first.json());
    const created = first.json() as { groupId: string; stockItemIds: string[] };
    expect(await heldBy(created.stockItemIds[0]!)).toEqual({ FOH: 7 });
    const moves = await ctx.db.select().from(stockMovement).where(eq(stockMovement.stockItemId, created.stockItemIds[0]!));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ quantity: 7, kind: 'adjust', reason: 'Starting stock' });
    expect(moves[0]!.actorAccountId).toBeTruthy();
    expect(await auditRows('stock_item.create', created.stockItemIds[0])).toHaveLength(1);
    const edited = await call('PUT', `${base()}/items/${created.groupId}`, manager,
      { ...body, sizes: [{ ...body.sizes[0], stockItemId: created.stockItemIds[0], startingStock: 99 }] });
    expect(edited.statusCode).toBe(400);
    expect(await heldBy(created.stockItemIds[0]!)).toEqual({ FOH: 7 });
    const down = await call('POST', `${base()}/adjustments`, manager, { stockItemId: created.stockItemIds[0], locationId: places.get('BOH'), delta: -99, reason: 'Count correction' });
    expect(down.statusCode).toBe(200);
    expect(down.json().delta).toBe(-7);
    expect(Object.values(await heldBy(created.stockItemIds[0]!)).every((quantity) => quantity === 0)).toBe(true);
    await expectLedgerAddsUp();
  });

  it('creates an unlinked item with no stock: it opens with a delivery, not with a typed figure', async () => {
    const created = await call('POST', `${base()}/items`, manager, {
      name: 'Cleaning spray',
      productId: null,
      unitCostSatang: null,
      reorder: null,
      units: [],
      sizes: [{ variantId: null, label: 'Default', lowStockThreshold: 2, parByLocation: {} }],
    });
    expect(created.statusCode).toBe(200);
    const [id] = (created.json() as { stockItemIds: string[] }).stockItemIds;
    expect(await heldBy(id!)).toEqual({});
    const got = await call('POST', `${base()}/receipts`, reception, { stockItemId: id, locationId: places.get('BOH'), quantity: 6, reason: 'Opening stock' });
    expect(got.json()).toMatchObject({ levelAfter: 6 });
    await expectLedgerAddsUp();
  });
});

describe('H3 — a sized product links all of its sizes or none', () => {
  it('the menu write refuses a partial link in plain words, and takes none or all', async () => {
    const socks = productIds.get('MR-SOCKS')!;
    const links = await Promise.all(['s', 'm', 'l'].map(async (v) => ({ variantId: v, stockItemId: await itemIdOf('MR-SOCKS', v) })));
    const partial = await call('PATCH', `/branches/${branchId}/menu/products/${socks}`, admin, { stockLinks: links.slice(0, 1) });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().error.message).toBe('"Grip Socks" comes in S, M, L — link all of its sizes or none (M, L are not linked)');
    const oneForAll = await call('PATCH', `/branches/${branchId}/menu/products/${socks}`, admin, {
      stockLinks: [{ variantId: null, stockItemId: links[0]!.stockItemId }],
    });
    expect(oneForAll.statusCode).toBe(400);
    expect(oneForAll.json().error.message).toBe(
      '"Grip Socks" comes in S, M, L — link each size to its own stock item, not one for the whole item',
    );
    expect((await call('PATCH', `/branches/${branchId}/menu/products/${socks}`, admin, { stockLinks: [] })).statusCode).toBe(200);
    expect((await call('PATCH', `/branches/${branchId}/menu/products/${socks}`, admin, { stockLinks: links })).statusCode).toBe(200);
  });

  it('the inventory form refuses it the same way', async () => {
    const socks = productIds.get('MR-SOCKS')!;
    const s = await itemIdOf('MR-SOCKS', 's');
    const m = await itemIdOf('MR-SOCKS', 'm');
    const l = await itemIdOf('MR-SOCKS', 'l');
    const res = await call('PUT', `${base()}/items/${socks}`, manager, {
      name: 'Grip Socks (Merch)',
      productId: socks,
      unitCostSatang: 3500,
      reorder: null,
      units: [],
      sizes: [
        { stockItemId: s, variantId: 's', label: 'S', lowStockThreshold: 8, parByLocation: {} },
        { stockItemId: m, variantId: 'm', label: 'M', lowStockThreshold: 8, parByLocation: {} },
        { stockItemId: l, variantId: null, label: 'L', lowStockThreshold: 8, parByLocation: {} },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('"Grip Socks" comes in S, M, L');
  });
});
