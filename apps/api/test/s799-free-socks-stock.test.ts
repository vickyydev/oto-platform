import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  branch,
  product,
  saleLine,
  station,
  stockItem,
  stockLevel,
  stockLocation,
  stockMovement,
  ticketPackage,
} from '@oto/db';
import { STOCK_ADJUST_QUICK_REASONS, STOCK_ADJUST_REASON_COMPLIMENTARY, newId } from '@oto/shared';
import { stockCacheItem } from '../src/services/sync-stock';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-799 — FREE SOCKS ARE FOR INVENTORY: "sometimes we give complimentary
 * socks, or staff/owners need it" (the owner, 9 November 2026).
 *
 * Two doors, both on the Regular Socks pool:
 *   - a 0-baht Free Socks add-on given with a ticket takes stock from the
 *     Regular Socks shelf ("takes stock from", `stockShareItemId` on the menu
 *     item write) and shows on the sale as its own line at ฿0 — guarded at
 *     commit and taken at finalise exactly like a priced pair, so out of stock
 *     refuses the free pair too;
 *   - a pair handed out with no sale is an Inventory Adjust with the reason
 *     "Complimentary / staff use", recorded on the movement as written.
 *
 * Fixture: the seeded Regular Socks (`AO-SOCKS`, ฿50, one size) at HKT Central,
 * BOH 80 + FOH 20, and a ZZ TEST Free Socks add-on at ฿0 made here.
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
let regularSocks: typeof product.$inferSelect;
let regularItemId: string;
let freeSocksId: string;

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** What the Regular Socks shelf holds, everywhere at the branch. */
async function socksHeld(): Promise<number> {
  const [row] = await ctx.db
    .select({ total: sql<number>`coalesce(sum(${stockLevel.quantity}), 0)::int` })
    .from(stockLevel)
    .where(eq(stockLevel.stockItemId, regularItemId));
  return row!.total;
}

/** A walk-in ticket for one kid with these add-ons on it. */
const ticket = (addOns: Array<{ id: string; quantity: number }>) => ({
  id: newId(),
  packageId: twoHoursId,
  kids: 1,
  adults: 1,
  addOns,
});

async function commit(lines: unknown[]) {
  return call('POST', '/sales', reception, { id: newId(), stationId, lines });
}

async function menuProduct(id: string) {
  const menu = (await call('GET', `/branches/${branchId}/menu`, admin)).json() as {
    products: Array<{ id: string; stockItemId: string | null; stockLinks: unknown[]; stockShareItemId: string | null }>;
  };
  return menu.products.find((p) => p.id === id)!;
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

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = central!.id;
  operatorId = central!.operatorId;
  const tills = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (tills.find((s) => s.codePrefix === 'T1') ?? tills[0]!).id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  const [socks] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.code, 'AO-SOCKS'), eq(product.branchId, branchId)));
  regularSocks = socks!;
  const [item] = await ctx.db
    .select()
    .from(stockItem)
    .where(and(eq(stockItem.productId, regularSocks!.id), eq(stockItem.branchId, branchId)));
  regularItemId = item!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('Free Socks takes stock from the Regular Socks shelf', () => {
  it('is set on the menu item write, read back on the menu, and audited', async () => {
    const made = await call('POST', `/branches/${branchId}/menu/products`, admin, {
      kind: 'addon',
      code: 'ZZ-AO-FREE-SOCKS',
      name: 'ZZ TEST Free Socks',
      categoryId: regularSocks.categoryId,
      priceSatang: 0,
      stockShareItemId: regularItemId,
    });
    expect(made.statusCode).toBe(200);
    freeSocksId = made.json().id as string;

    const read = await menuProduct(freeSocksId);
    // Its own stock links stay empty — the till and the Console still see an
    // add-on that counts no stock of its own — and the share names the shelf.
    expect(read).toMatchObject({ stockLinks: [], stockShareItemId: regularItemId, stockItemId: regularItemId });
    // Regular Socks is unchanged: still its own item, sharing nothing.
    expect(await menuProduct(regularSocks.id)).toMatchObject({
      stockLinks: [{ variantId: null, stockItemId: regularItemId }],
      stockShareItemId: null,
    });
    // No price changed: Regular Socks keeps its own.
    const [still] = await ctx.db.select().from(product).where(eq(product.id, regularSocks.id));
    expect(still!.priceSatang).toBe(regularSocks.priceSatang);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'product.stock_share'), eq(auditLog.entityId, freeSocksId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ stockItemId: regularItemId, sharesWithProductId: regularSocks.id });
  });

  it('refuses a shelf it cannot honestly share, in plain words', async () => {
    const [grip] = await ctx.db
      .select()
      .from(product)
      .where(and(eq(product.code, 'AO-GRIPSOCKS'), eq(product.branchId, branchId)));
    const [gripS] = await ctx.db
      .select()
      .from(stockItem)
      .where(and(eq(stockItem.productId, grip!.id), eq(stockItem.branchId, branchId), eq(stockItem.variantId, 's')));

    // A size of an item sold in sizes.
    const sized = await call('PATCH', `/branches/${branchId}/menu/products/${freeSocksId}`, admin, { stockShareItemId: gripS!.id });
    expect(sized.statusCode).toBe(400);
    expect(sized.json().error.message).toContain('is one size of an item sold in sizes');

    // An item that counts its own stock (the shop's Oto Cap, one size).
    const [cap] = await ctx.db
      .select()
      .from(product)
      .where(and(eq(product.code, 'MR-CAP'), eq(product.branchId, branchId)));
    const own = await call('PATCH', `/branches/${branchId}/menu/products/${cap!.id}`, admin, { stockShareItemId: regularItemId });
    expect(own.statusCode).toBe(409);
    expect(own.json().error).toMatchObject({ code: 'STOCK_SHARE_OWN_STOCK' });

    // An item sold in sizes (the add-on Grip Socks, S / M / L).
    const sizedItem = await call('PATCH', `/branches/${branchId}/menu/products/${grip!.id}`, admin, { stockShareItemId: regularItemId });
    expect(sizedItem.statusCode).toBe(400);
    expect(sizedItem.json().error.message).toContain('is sold in sizes');

    // Its own stock and another's in one write.
    const both = await call('POST', `/branches/${branchId}/menu/products`, admin, {
      kind: 'addon',
      name: 'ZZ TEST Both',
      categoryId: regularSocks.categoryId,
      priceSatang: 0,
      stockLinks: [{ variantId: null, stockItemId: regularItemId }],
      stockShareItemId: regularItemId,
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.message).toContain('not both');

    // Nothing moved: the share is still Regular Socks.
    expect((await menuProduct(freeSocksId)).stockShareItemId).toBe(regularItemId);
  });

  it('an edit that does not name the share leaves it alone', async () => {
    const edit = await call('PATCH', `/branches/${branchId}/menu/products/${freeSocksId}`, admin, { name: 'ZZ TEST Free Socks' });
    expect(edit.statusCode).toBe(200);
    expect((await menuProduct(freeSocksId)).stockShareItemId).toBe(regularItemId);
  });

  it('a free pair with a ticket shows on the sale at ฿0 and leaves the Regular Socks shelf', async () => {
    const before = await socksHeld();
    const res = await commit([ticket([{ id: freeSocksId, quantity: 2 }, { id: regularSocks.id, quantity: 1 }])]);
    expect(res.statusCode).toBe(200);
    const saleId = res.json().sale.id as string;

    const lines = await ctx.db
      .select()
      .from(saleLine)
      .where(and(eq(saleLine.saleId, saleId), eq(saleLine.kind, 'addon')))
      .orderBy(asc(saleLine.lineNo));
    const free = lines.find((l) => l.productId === freeSocksId)!;
    const paid = lines.find((l) => l.productId === regularSocks.id)!;
    expect(free).toMatchObject({ label: 'ZZ TEST Free Socks', quantity: 2, unitSatang: 0 });
    expect(paid).toMatchObject({ quantity: 1, unitSatang: regularSocks.priceSatang });
    // Both lines froze the same shelf at commit.
    expect(free.payload).toMatchObject({ stock: [{ stockItemId: regularItemId, variantId: null, quantity: 2 }] });
    expect(paid.payload).toMatchObject({ stock: [{ stockItemId: regularItemId, variantId: null, quantity: 1 }] });
    // Committed is not sold: nothing has left the shelf yet.
    expect(await socksHeld()).toBe(before);

    expect((await call('POST', `/sales/${saleId}/finalise`, reception)).statusCode).toBe(200);
    expect(await socksHeld()).toBe(before - 3);
    const moved = await ctx.db
      .select({ saleLineId: stockMovement.saleLineId, kind: stockMovement.kind, quantity: stockMovement.quantity })
      .from(stockMovement)
      .where(and(eq(stockMovement.saleId, saleId), eq(stockMovement.stockItemId, regularItemId)));
    const byLine = (id: string) => moved.filter((m) => m.saleLineId === id).reduce((n, m) => n + m.quantity, 0);
    expect(byLine(free.id)).toBe(-2);
    expect(byLine(paid.id)).toBe(-1);
    expect(moved.every((m) => m.kind === 'sale')).toBe(true);
    await expectLedgerAddsUp();
  });

  it('the box sells it from the same shelf with the link down: one more snapshot entry, the same stock item, after the owner', async () => {
    const snapshot = await stockCacheItem(ctx.db, { boxId: newId(), operatorId, branchId });
    const onShelf = snapshot.items.filter((e) => e.stockItemId === regularItemId);
    expect(onShelf.map((e) => e.productId)).toEqual([regularSocks.id, freeSocksId]);
    expect(onShelf[1]).toMatchObject({ itemName: 'ZZ TEST Free Socks', variantId: null, total: onShelf[0]!.total });
  });
});

describe('a complimentary pair with no sale is an Inventory Adjust', () => {
  it('offers "Complimentary / staff use" after the four prototype reasons', () => {
    expect(STOCK_ADJUST_QUICK_REASONS.map((r) => r.label)).toEqual([
      'Received shipment',
      'Inventory recount',
      'Damaged / shrinkage',
      'Staff use',
      'Complimentary / staff use',
    ]);
    expect(STOCK_ADJUST_QUICK_REASONS.find((r) => r.code === 'complimentary')!.label).toBe(STOCK_ADJUST_REASON_COMPLIMENTARY);
  });

  it('records the reason on the movement and the audit row, and the movements read answers it', async () => {
    const before = await socksHeld();
    const res = await call('POST', `/branches/${branchId}/stock/adjustments`, manager, {
      stockItemId: regularItemId,
      delta: -2,
      reason: STOCK_ADJUST_REASON_COMPLIMENTARY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delta).toBe(-2);
    expect(await socksHeld()).toBe(before - 2);

    const rows = await ctx.db
      .select()
      .from(stockMovement)
      .where(and(eq(stockMovement.stockItemId, regularItemId), eq(stockMovement.kind, 'adjust'), eq(stockMovement.reason, 'Complimentary / staff use')));
    expect(rows.reduce((n, m) => n + m.quantity, 0)).toBe(-2);
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'stock.adjust'), eq(auditLog.entityId, regularItemId)));
    expect(audit!.after).toMatchObject({ delta: -2, reason: 'Complimentary / staff use' });

    const read = await call('GET', `/branches/${branchId}/stock/movements?stockItemId=${regularItemId}&limit=5`, manager);
    expect(read.statusCode).toBe(200);
    const reasons = (read.json() as { movements: Array<{ kind: string; reason: string | null }> }).movements
      .filter((m) => m.kind === 'adjust')
      .map((m) => m.reason);
    expect(reasons).toContain('Complimentary / staff use');
    await expectLedgerAddsUp();
  });
});

describe('out of stock refuses the free pair too', () => {
  it('refuses a Free Socks line in the Regular Socks words once the shelf is empty, and writes nothing', async () => {
    // Every pair left goes out as complimentary.
    const left = await socksHeld();
    expect(left).toBeGreaterThan(0);
    const emptied = await call('POST', `/branches/${branchId}/stock/adjustments`, manager, {
      stockItemId: regularItemId,
      delta: -left,
      reason: STOCK_ADJUST_REASON_COMPLIMENTARY,
    });
    expect(emptied.statusCode).toBe(200);
    expect(await socksHeld()).toBe(0);

    const saleId = newId();
    const res = await call('POST', '/sales', reception, { id: saleId, stationId, lines: [ticket([{ id: freeSocksId, quantity: 1 }])] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'STOCK_SHORT', message: 'Regular Socks is out of stock. Nothing was saved.' });
    expect(await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId))).toEqual([]);

    // A ticket with no socks still sells.
    expect((await commit([ticket([])])).statusCode).toBe(200);
  });
});

describe('a catalogue clone copies Free Socks without its share', () => {
  // "Takes stock from" is one park's setting, made by a person at each park
  // and audited there (`product.stock_share`); a clone copies the add-on and
  // leaves the share for an admin at the new park. It is never the add-on's
  // own stock definition, so it never leaves the add-on out of the copy.
  let ordinal = 0;
  async function newPark(): Promise<string> {
    const id = newId();
    ordinal += 1;
    await ctx.db.insert(branch).values({
      id,
      operatorId,
      name: `ZZ TEST SCRUM-799 park ${ordinal}`,
      code: `Z799-${ordinal}`,
      timezone: 'Asia/Bangkok',
      country: 'TH',
    });
    return id;
  }
  const cloneInto = (target: string) => call('POST', `/branches/${target}/clone`, admin, { sourceBranchId: branchId });
  const atPark = async (park: string, name: string) =>
    (await ctx.db.select().from(product).where(and(eq(product.branchId, park), eq(product.name, name))))[0];

  it('into a park without Regular Socks: copies both, Regular Socks keeps its own shelf, Free Socks takes from nothing', async () => {
    // The share is set at HKT Central as the clone runs.
    expect((await menuProduct(freeSocksId)).stockShareItemId).toBe(regularItemId);
    const park = await newPark();
    const res = await cloneInto(park);
    expect(res.statusCode, res.body).toBe(200);
    const plan = res.json().plan as { products: { blocked: Array<{ name: string }> } };
    expect(plan.products.blocked.map((b) => b.name)).not.toContain('ZZ TEST Free Socks');

    const copiedRegular = (await atPark(park, regularSocks.name))!;
    const [copiedShelf] = await ctx.db
      .select()
      .from(stockItem)
      .where(and(eq(stockItem.branchId, park), eq(stockItem.productId, copiedRegular.id)));
    expect(copiedRegular.stockItemId).toBe(copiedShelf!.id);

    const copiedFree = (await atPark(park, 'ZZ TEST Free Socks'))!;
    expect(copiedFree).toMatchObject({ priceSatang: 0, stockItemId: null });
    const shares = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'product.stock_share'), eq(auditLog.entityId, copiedFree.id)));
    expect(shares).toEqual([]);
    // The source keeps its share.
    expect((await menuProduct(freeSocksId)).stockShareItemId).toBe(regularItemId);
  });

  it('into a park whose Regular Socks has no stock item: Free Socks is still copied, with no share', async () => {
    const park = await newPark();
    await ctx.db.insert(product).values({
      id: newId(),
      operatorId,
      branchId: park,
      kind: 'addon',
      name: regularSocks.name,
      categoryId: regularSocks.categoryId,
      priceSatang: regularSocks.priceSatang,
    });
    const res = await cloneInto(park);
    expect(res.statusCode, res.body).toBe(200);
    const plan = res.json().plan as {
      products: { exists: string[]; blocked: Array<{ name: string; reason: string }> };
    };
    expect(plan.products.blocked.find((b) => b.name === 'ZZ TEST Free Socks')).toBeUndefined();
    expect(plan.products.exists.some((name) => name.startsWith(regularSocks.name))).toBe(true);

    const copiedFree = (await atPark(park, 'ZZ TEST Free Socks'))!;
    expect(copiedFree).toMatchObject({ priceSatang: 0, stockItemId: null });
    // The park's own Regular Socks keeps its inventory choice: no shelf is attached to it.
    expect((await atPark(park, regularSocks.name))!.stockItemId).toBeNull();
  });
});

describe('a share whose shelf has gone is released, never left counting nothing', () => {
  it('unlinking Regular Socks from its stock item clears the Free Socks share, with an audit row saying why', async () => {
    const unlink = await call('PATCH', `/branches/${branchId}/menu/products/${regularSocks.id}`, admin, { stockLinks: [] });
    expect(unlink.statusCode).toBe(200);
    const read = await menuProduct(freeSocksId);
    expect(read).toMatchObject({ stockShareItemId: null, stockItemId: null });
    const released = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'product.stock_share'), eq(auditLog.entityId, freeSocksId)))
      .orderBy(asc(auditLog.createdAt));
    expect(released.at(-1)!.after).toMatchObject({ stockItemId: null, released: 'the stock item no longer stocks an item on the menu' });
    // And the place the shelf was is untouched.
    const places = await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId));
    expect(places.length).toBeGreaterThan(0);
  });
});
