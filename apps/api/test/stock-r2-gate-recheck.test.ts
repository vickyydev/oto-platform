import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, product, stockItem, stockLevel, stockLocation, station } from '@oto/db';
import { newId } from '@oto/shared';
import { refundSale } from '../src/services/refunds';
import { commitStockTake, receiveStock } from '../src/services/stock';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14b round 2 — the gate RE-CHECK's reproductions.
 *
 * The invariant (stock-r2-gate.test.ts): every level is the sum of its
 * movements, AND every each the ledger says the branch holds is on a stock item
 * a person can see, count, move or sell. The round-2 fix guarded the size
 * removal against levels and open orders, and the PO receive against an
 * archived item. These are the paths it did not close.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let receptionId: string;
let managerId: string;
const places = new Map<string, string>();
const productIds = new Map<string, string>();

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

async function stockOnArchivedItems(): Promise<Array<{ stockItemId: string; quantity: number }>> {
  return ctx.db
    .select({ stockItemId: stockLevel.stockItemId, quantity: stockLevel.quantity })
    .from(stockLevel)
    .innerJoin(stockItem, eq(stockItem.id, stockLevel.stockItemId))
    .where(and(isNotNull(stockItem.archivedAt), ne(stockLevel.quantity, 0)));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code) productIds.set(p.code, p.id);
  }
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  receptionId = (await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)))[0]!.id;
  managerId = (await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone)))[0]!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('RECHECK-1 — a refund restocks a size the manager has since removed (sequential, no race)', () => {
  // FIXED: restockForRefund reads the items FOR SHARE and skips a size since
  // removed (as a line sold before the ledger puts nothing back); the refund
  // completes and its stock.refund audit names the units not restocked.
  it('a refunded unit never lands on an archived stock item', async () => {
    const slushie = productIds.get('FB-SLUSHIE')!;
    const sizes = await ctx.db
      .select()
      .from(stockItem)
      .where(and(eq(stockItem.productId, slushie), eq(stockItem.branchId, branchId)));
    const byVariant = new Map(sizes.map((s) => [s.variantId, s]));
    const green = byVariant.get('green')!;
    // Sell every Green there is (2 FOH + 2 BOH).
    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: {
        stationId,
        id: saleId,
        pickupCode: 'R1',
        items: [{ id: newId(), productId: slushie, quantity: 4, variant: { variantId: 'green', variantLabel: 'GREEN' } }],
      },
    });
    expect(committed.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception } })).statusCode).toBe(200);
    // Green now holds nothing anywhere and no order wants it: the manager drops it.
    const edit = await call('PUT', `${base()}/items/${slushie}`, manager, {
      name: 'Slushie',
      productId: null,
      unitCostSatang: null,
      reorder: null,
      units: [],
      sizes: ['red', 'blue'].map((v) => ({
        stockItemId: byVariant.get(v)!.id,
        variantId: null,
        label: v === 'red' ? 'Red' : 'Blue',
        lowStockThreshold: null,
        parByLocation: {},
      })),
    });
    expect(edit.statusCode).toBe(200);
    expect((await ctx.db.select().from(stockItem).where(eq(stockItem.id, green.id)))[0]!.archivedAt).not.toBeNull();
    // The guest returns the four drinks.
    const actor = {
      accountId: managerId,
      operatorId,
      stationId,
      assertBranchAllowed: async () => {},
      assertCanApprove: async () => {},
    };
    const refunded = await ctx.db.transaction((tx) => refundSale(tx, actor, saleId, { mode: 'whole', reason: 'Wrong flavour' }));
    await expectLedgerAddsUp();
    expect(await stockOnArchivedItems()).toEqual([]);
    // The refund itself completed, and the office can see what was not put back.
    const [row] = await ctx.db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'stock.refund'), eq(auditLog.entityId, refunded.refund.id)));
    const notRestocked = (row?.after as { notRestocked?: Array<{ stockItemId: string; quantity: number }> } | null)?.notRestocked ?? [];
    expect(notRestocked.every((s) => s.stockItemId === green.id)).toBe(true);
    expect(notRestocked.reduce((sum, s) => sum + s.quantity, 0)).toBe(4);
  });
});

describe('RECHECK-2 — an ad hoc receive or a count racing the size removal (only the PO receive locks the item)', () => {
  // FIXED: a receive, a count and an upward correction now read the item FOR
  // SHARE (loadBranchItems `lockFor`), which saveStockItem's FOR NO KEY UPDATE
  // waits on: the removal then sees the level and refuses.
  it('a delivery booked while the size is being removed never lands on an archived item', async () => {
    const item = await twoSizeItem('Recheck Tape');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let received!: () => void;
    const inside = new Promise<void>((r) => (received = r));
    const actor = { operatorId, branchId, accountId: receptionId };
    const receipt = ctx.db.transaction(async (tx) => {
      await receiveStock(tx, actor, { stockItemId: item.b, locationId: places.get('BOH')!, quantity: 5, reason: 'Walk-in delivery' }, new Date());
      received();
      await gate;
    });
    await inside;
    const edit = call('PUT', `${base()}/items/${item.groupId}`, manager, keepOnlyA('Recheck Tape', item.a));
    await Promise.race([edit, sleep(1500)]);
    release();
    const [editRes, receiptRes] = await Promise.allSettled([edit, receipt]);
    // Either refusal is a fix; both succeeding is the defect.
    const removed = editRes.status === 'fulfilled' && editRes.value.statusCode === 200;
    expect(removed && receiptRes.status === 'fulfilled').toBe(false);
    expect(await stockOnArchivedItems()).toEqual([]);
    await expectLedgerAddsUp();
  });

  it('a count committed while the size is being removed never lands on an archived item', async () => {
    const item = await twoSizeItem('Recheck Cord');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let counted!: () => void;
    const inside = new Promise<void>((r) => (counted = r));
    const actor = { operatorId, branchId, accountId: receptionId };
    const take = ctx.db.transaction(async (tx) => {
      await commitStockTake(tx, actor, { lines: [{ stockItemId: item.b, locationId: places.get('BOH')!, countedQuantity: 6 }] }, new Date());
      counted();
      await gate;
    });
    await inside;
    const edit = call('PUT', `${base()}/items/${item.groupId}`, manager, keepOnlyA('Recheck Cord', item.a));
    await Promise.race([edit, sleep(1500)]);
    release();
    const [editRes, takeRes] = await Promise.allSettled([edit, take]);
    const removed = editRes.status === 'fulfilled' && editRes.value.statusCode === 200;
    expect(removed && takeRes.status === 'fulfilled').toBe(false);
    expect(await stockOnArchivedItems()).toEqual([]);
    await expectLedgerAddsUp();
  });
});
