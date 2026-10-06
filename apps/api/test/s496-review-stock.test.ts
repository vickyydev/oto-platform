import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, product, stockAttention, stockItem, stockLevel, stockLocation, stockMovement } from '@oto/db';
import { newId } from '@oto/shared';
import { BRANCH_MANAGER, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-496 review — entries 31, 35, 36 and 37 attacked through the routes:
 * a named-place decrease cascades and clamps (catalogStore.ts:1219-1268), a new
 * item's typed stock opens at the sell point per size, a pack may hold one
 * each, and an open order never hides a row. Every level stays the sum of its
 * movements.
 */

let ctx: TestContext;
let manager: string;
let branchId: string;
const places = new Map<string, string>();
const productIds = new Map<string, string>();

const base = () => `/branches/${branchId}/stock`;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { cookie: manager }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

async function heldBy(stockItemId: string): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ place: stockLocation.name, quantity: stockLevel.quantity })
    .from(stockLevel)
    .innerJoin(stockLocation, eq(stockLocation.id, stockLevel.stockLocationId))
    .where(eq(stockLevel.stockItemId, stockItemId));
  return Object.fromEntries(rows.filter((r) => r.quantity !== 0).map((r) => [r.place, r.quantity]));
}

async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  expect((rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved || r.quantity < 0)).toEqual([]);
}

beforeAll(async () => {
  ctx = await createTestContext();
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) places.set(l.name, l.id);
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, hkt!.operatorId))) if (p.code) productIds.set(p.code, p.id);
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function newItem(sizes: Array<{ label: string; startingStock?: number }>, units = [{ label: 'Single', eaches: 1 }]) {
  const res = await call('POST', `${base()}/items`, {
    name: `Review item ${newId().slice(-6)}`,
    productId: null,
    unitCostSatang: 100,
    reorder: null,
    units,
    sizes: sizes.map((s) => ({ variantId: null, lowStockThreshold: null, parByLocation: {}, ...s })),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { groupId: string; stockItemIds: string[] };
}

describe('starting stock on a new item (entry 37) and a one-each pack (entry 36)', () => {
  it('opens every size at the sell point with one movement each', async () => {
    const made = await newItem([{ label: 'S', startingStock: 4 }, { label: 'M', startingStock: 0 }, { label: 'L', startingStock: 9 }]);
    const [s, m, l] = made.stockItemIds;
    expect(await heldBy(s!)).toEqual({ FOH: 4 });
    expect(await heldBy(m!)).toEqual({});
    expect(await heldBy(l!)).toEqual({ FOH: 9 });
    const moves = await ctx.db.select().from(stockMovement).where(sql`${stockMovement.stockItemId} in (${s}, ${m}, ${l})`);
    expect(moves.map((mv) => mv.quantity).sort()).toEqual([4, 9]);
    const levels = (await call('GET', `${base()}/levels`)).json() as { items: Array<{ id: string; units: Array<{ eaches: number }> }> };
    expect(levels.items.find((i) => i.id === s)!.units).toEqual([expect.objectContaining({ eaches: 1 })]);
    await expectLedgerAddsUp();
  });
});

describe('Adjust from a named place (entry 35)', () => {
  it('an increase lands at the named place; a decrease takes the named place first, then cascades, and clamps', async () => {
    const made = await newItem([{ label: 'Default', startingStock: 5 }]);
    const id = made.stockItemIds[0]!;
    const up = await call('POST', `${base()}/adjustments`, { stockItemId: id, locationId: places.get('BOH'), delta: 6, reason: 'Delivery' });
    expect(up.statusCode, up.body).toBe(200);
    expect(await heldBy(id)).toEqual({ FOH: 5, BOH: 6 });

    const down = await call('POST', `${base()}/adjustments`, { stockItemId: id, locationId: places.get('BOH'), delta: -8, reason: 'Recount' });
    expect(down.statusCode, down.body).toBe(200);
    // BOH first (6), then the cascade from the sell point (2).
    expect(down.json().movements).toEqual([
      { locationId: places.get('BOH'), quantity: -6, levelAfter: 0 },
      { locationId: places.get('FOH'), quantity: -2, levelAfter: 3 },
    ]);
    expect(await heldBy(id)).toEqual({ FOH: 3 });

    const past = await call('POST', `${base()}/adjustments`, { stockItemId: id, locationId: places.get('Store'), delta: -50, reason: 'Recount' });
    expect(past.statusCode, past.body).toBe(200);
    expect(past.json().delta).toBe(-3);
    expect(await heldBy(id)).toEqual({});
    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'stock.adjust'), eq(auditLog.entityId, id), sql`${auditLog.after}->>'requestedDelta' = '-50'`));
    expect(row!.after).toMatchObject({ requestedDelta: -50, delta: -3 });
    await expectLedgerAddsUp();
  });
});

describe('an open order never hides the row (entry 31)', () => {
  it('a size on order keeps the item listed while another size is out', async () => {
    const made = await newItem([{ label: 'S', startingStock: 0 }, { label: 'M', startingStock: 1 }]);
    const [s, mSize] = made.stockItemIds;
    const reorder = await call('PUT', `${base()}/items/${made.groupId}`, {
      name: 'Review reorder item',
      productId: null,
      unitCostSatang: 100,
      reorder: { reorderPoint: 5, reorderQuantity: 10, leadTimeDays: 3, supplierName: 'Supplier', supplierContact: null },
      units: [],
      sizes: [
        { stockItemId: s, variantId: null, label: 'S', lowStockThreshold: null, parByLocation: {} },
        { stockItemId: mSize, variantId: null, label: 'M', lowStockThreshold: null, parByLocation: {} },
      ],
    });
    expect(reorder.statusCode, reorder.body).toBe(200);
    const rowsBefore = await ctx.db.select().from(stockAttention).where(and(eq(stockAttention.branchId, branchId), sql`${stockAttention.resolvedAt} is null`));
    const listed = rowsBefore.filter((r) => r.stockItemId === s || r.stockItemId === mSize);
    expect(listed.length).toBeGreaterThan(0);
    const ordered = await call('POST', `${base()}/purchase-orders/lines`, { lines: [{ stockItemId: mSize, quantity: 10 }] });
    expect(ordered.statusCode, ordered.body).toBe(200);
    const rowsAfter = await ctx.db.select().from(stockAttention).where(and(eq(stockAttention.branchId, branchId), sql`${stockAttention.resolvedAt} is null`));
    expect(rowsAfter.filter((r) => r.stockItemId === s || r.stockItemId === mSize)).toHaveLength(listed.length);
    await expectLedgerAddsUp();
    expect(await ctx.db.select().from(stockItem).where(eq(stockItem.id, s!))).toHaveLength(1);
  });
});
