import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  branch,
  product,
  sale,
  saleLine,
  stockAttention,
  stockItem,
  stockLevel,
  stockLocation,
  stockMovement,
  station,
  ticketPackage,
} from '@oto/db';
import { newId } from '@oto/shared';
import { finaliseSale } from '../src/services/sale';
import { refundSale } from '../src/services/refunds';
import { applyMovements, restockForRefund } from '../src/services/stock';
import {
  ADMIN,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-14b round 1 — the ledger and sales (plan docs/progress/plans/stock/PLAN.md
 * §2.1-2.2, §5), through the real routes with a real reception session, and the
 * database read back after every flow.
 *
 * THE FIXTURES are the seeded opening count — the prototype's own figures
 * (`catalogStore.ts:571-650`, OD-S2), each place counted (OD-S5):
 *   Grip Socks (shop and add-on)  S 18 BOH + 7 FOH, M 28 + 12, L 14 + 6
 *   Oto Cap                       18 BOH + 7 FOH
 *   Mascot Keyring                out everywhere
 *   Oto Mascot Plush              14 BOH + 4 FOH
 *   Water Bottle                  22 BOH + 8 FOH
 *   Sticker Pack                  60 BOH + 20 FOH
 *   Slushie                       Red 15 + 5, Blue 12 + 3, Green 2 + 2
 * Nothing starts in the Store (bulk). Each test uses its own items so the
 * figures stay readable in sequence.
 */

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let receptionId: string;
let twoHoursId: string;
const productIds = new Map<string, string>();
const places = new Map<string, string>();

const itemLine = (code: string, quantity: number, variantId?: string) => ({
  id: newId(),
  productId: productIds.get(code)!,
  quantity,
  ...(variantId ? { variant: { variantId, variantLabel: variantId.toUpperCase() } } : {}),
});

async function commit(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { stationId, ...payload },
  });
}

async function finalise(saleId: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

/** What one size of a product holds, by place name. */
async function held(code: string, variantId: string | null = null): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ place: stockLocation.name, quantity: stockLevel.quantity })
    .from(stockLevel)
    .innerJoin(stockItem, eq(stockItem.id, stockLevel.stockItemId))
    .innerJoin(stockLocation, eq(stockLocation.id, stockLevel.stockLocationId))
    .where(
      and(
        eq(stockItem.productId, productIds.get(code)!),
        eq(stockItem.branchId, branchId),
        variantId === null ? sql`${stockItem.variantId} is null` : eq(stockItem.variantId, variantId),
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.place, r.quantity]));
}

async function itemIdOf(code: string, variantId: string | null = null): Promise<string> {
  const [row] = await ctx.db
    .select({ id: stockItem.id })
    .from(stockItem)
    .where(
      and(
        eq(stockItem.productId, productIds.get(code)!),
        eq(stockItem.branchId, branchId),
        variantId === null ? sql`${stockItem.variantId} is null` : eq(stockItem.variantId, variantId),
      ),
    );
  return row!.id;
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
  // And no movement exists without its level row.
  const { rows: orphans } = await ctx.db.execute(sql`
    select 1 from pos.stock_movement m
     where not exists (select 1 from pos.stock_level l
                        where l.stock_item_id = m.stock_item_id and l.stock_location_id = m.stock_location_id)`);
  expect(orphans).toEqual([]);
}

async function movementsOfSale(saleId: string) {
  return ctx.db
    .select({
      kind: stockMovement.kind,
      quantity: stockMovement.quantity,
      shortfall: stockMovement.shortfall,
      place: stockLocation.name,
    })
    .from(stockMovement)
    .innerJoin(stockLocation, eq(stockLocation.id, stockMovement.stockLocationId))
    .where(and(eq(stockMovement.saleId, saleId), sql`${stockMovement.kind} in ('sale','offline_sale')`));
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  const products = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  for (const p of products) if (p.code) productIds.set(p.code, p.id);
  for (const l of await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId))) {
    places.set(l.name, l.id);
  }
  const [reception] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionId = reception!.id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the opening (OD-S2, OD-S5)', () => {
  it('opens from the prototype’s figures, as count movements, and the ledger adds up', async () => {
    expect(await held('MR-SOCKS', 's')).toEqual({ Store: 0, BOH: 18, FOH: 7 });
    expect(await held('AO-GRIPSOCKS', 'm')).toEqual({ Store: 0, BOH: 28, FOH: 12 });
    expect(await held('MR-KEYRING')).toEqual({ Store: 0, BOH: 0, FOH: 0 });
    expect(await held('FB-SLUSHIE', 'green')).toEqual({ Store: 0, BOH: 2, FOH: 2 });
    const [sellPoint] = await ctx.db
      .select()
      .from(stockLocation)
      .where(and(eq(stockLocation.branchId, branchId), eq(stockLocation.sellPoint, true)));
    expect(sellPoint).toMatchObject({ name: 'FOH', type: 'rotation' });
    await expectLedgerAddsUp();
  });
});

describe('the guard at commit — per size, honouring the breakdown, cascade-aware', () => {
  const cases: Array<{ name: string; items: () => unknown[]; message: string }> = [
    {
      name: 'one size beyond what the branch holds',
      items: () => [itemLine('MR-SOCKS', 26, 's')],
      message: 'Only 25 Grip Socks S left. Nothing was saved.',
    },
    {
      name: 'two lines of one size, together beyond it',
      items: () => [itemLine('MR-SOCKS', 15, 'l'), itemLine('MR-SOCKS', 6, 'l')],
      message: 'Only 20 Grip Socks L left. Nothing was saved.',
    },
    {
      name: 'an item out everywhere',
      items: () => [itemLine('MR-KEYRING', 1)],
      message: 'Mascot Keyring is out of stock. Nothing was saved.',
    },
  ];
  for (const c of cases) {
    it(`refuses ${c.name}, in the counter's words, and writes nothing`, async () => {
      const saleId = newId();
      const res = await commit({ id: saleId, items: c.items() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'STOCK_SHORT', message: c.message });
      expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    });
  }

  it('lets a sale through that the sell point alone cannot fill but the branch can', async () => {
    // Oto Cap: 7 at the counter, 18 behind. 10 is fine — the cascade reaches BOH.
    const res = await commit({ id: newId(), items: [itemLine('MR-CAP', 10)] });
    expect(res.statusCode).toBe(200);
  });

  it('honours an add-on’s split across sizes, which the prototype’s guard ignored', async () => {
    const ticket = (breakdown: Array<{ variantId: string; quantity: number }>, quantity: number) => ({
      id: newId(),
      packageId: twoHoursId,
      kids: 1,
      adults: 1,
      addOns: [
        {
          id: productIds.get('AO-GRIPSOCKS')!,
          quantity,
          variantBreakdown: breakdown.map((b) => ({ ...b, variantLabel: b.variantId.toUpperCase() })),
        },
      ],
    });
    // 42 socks is under the 85 the item holds — but 41 of them are M, of which there are 40.
    const tooMany = await commit({ id: newId(), lines: [ticket([{ variantId: 's', quantity: 1 }, { variantId: 'm', quantity: 41 }], 42)] });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error.message).toBe('Only 40 Grip Socks M left. Nothing was saved.');

    const noSize = await commit({ id: newId(), lines: [{ ...ticket([], 2), addOns: [{ id: productIds.get('AO-GRIPSOCKS')!, quantity: 2 }] }] });
    expect(noSize.statusCode).toBe(409);
    expect(noSize.json().error).toMatchObject({ code: 'STOCK_SIZE_REQUIRED' });
    expect(noSize.json().error.message).toContain('Choose a size for Grip Socks — it comes in');

    const fine = await commit({ id: newId(), lines: [ticket([{ variantId: 's', quantity: 1 }, { variantId: 'm', quantity: 2 }], 3)] });
    expect(fine.statusCode).toBe(200);
    const saleId = fine.json().sale.id as string;
    // The split rides the line now, not just its label.
    const [line] = await ctx.db
      .select()
      .from(saleLine)
      .where(and(eq(saleLine.saleId, saleId), eq(saleLine.kind, 'addon')));
    expect(line!.payload).toMatchObject({
      variantBreakdown: [
        { variantId: 's', quantity: 1 },
        { variantId: 'm', quantity: 2 },
      ],
      stock: [
        { variantId: 's', quantity: 1, unitCostSatang: 2800 },
        { variantId: 'm', quantity: 2, unitCostSatang: 2800 },
      ],
    });
    // The cost to the park is frozen on the line and never handed to the till.
    expect(JSON.stringify(fine.json())).not.toContain('unitCostSatang');

    // Paid: each size leaves its own shelf.
    expect((await finalise(saleId)).statusCode).toBe(200);
    expect(await held('AO-GRIPSOCKS', 's')).toEqual({ Store: 0, BOH: 18, FOH: 6 });
    expect(await held('AO-GRIPSOCKS', 'm')).toEqual({ Store: 0, BOH: 28, FOH: 10 });
    await expectLedgerAddsUp();
  });

  it('validates an F&B size against the catalogue, like a shop size', async () => {
    const purple = await commit({ id: newId(), pickupCode: 'A1', items: [itemLine('FB-SLUSHIE', 1, 'purple')] });
    expect(purple.statusCode).toBe(400);
    expect(purple.json().error.message).toBe('"Slushie" has no size "purple" — it comes in Red, Blue, Green');
    // Fix round (gate R2): an F&B size is asked for where the stock is kept in
    // sizes — by the stock guard, in the counter's words — not by the catalogue.
    const none = await commit({ id: newId(), pickupCode: 'A1', items: [itemLine('FB-SLUSHIE', 1)] });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatchObject({ code: 'STOCK_SIZE_REQUIRED' });
    expect(none.json().error.message).toBe('Choose a size for Slushie — it comes in Red, Blue, Green. Nothing was saved.');
    const green = await commit({ id: newId(), pickupCode: 'A1', items: [itemLine('FB-SLUSHIE', 5, 'green')] });
    expect(green.statusCode).toBe(409);
    expect(green.json().error.message).toBe('Only 4 Slushie Green left. Nothing was saved.');
  });
});

describe('the decrement at finalise', () => {
  it('takes from the sell point first, then back of house, once — a replayed close takes nothing again', async () => {
    const saleId = newId();
    expect((await commit({ id: saleId, pickupCode: 'B2', items: [itemLine('FB-SLUSHIE', 7, 'red')] })).statusCode).toBe(200);
    // Committed is not sold: nothing has left a shelf yet.
    expect(await held('FB-SLUSHIE', 'red')).toEqual({ Store: 0, BOH: 15, FOH: 5 });
    expect((await finalise(saleId)).statusCode).toBe(200);
    expect(await held('FB-SLUSHIE', 'red')).toEqual({ Store: 0, BOH: 13, FOH: 0 });
    const replay = await finalise(saleId);
    expect(replay.statusCode).toBe(200);
    expect(await held('FB-SLUSHIE', 'red')).toEqual({ Store: 0, BOH: 13, FOH: 0 });
    expect((await movementsOfSale(saleId)).sort((a, b) => a.place.localeCompare(b.place))).toEqual([
      { kind: 'sale', quantity: -2, shortfall: 0, place: 'BOH' },
      { kind: 'sale', quantity: -5, shortfall: 0, place: 'FOH' },
    ]);
    await expectLedgerAddsUp();
  });

  it('cascades in the transfer-source order: sell point, back of house, then bulk', async () => {
    // Put 5 Water Bottles in the Store (bulk) through the one writer.
    const bottle = await itemIdOf('MR-BOTTLE');
    await ctx.db.transaction((tx) =>
      applyMovements(
        tx,
        { operatorId, branchId, businessDate: '2026-10-02', occurredAt: new Date(), actorAccountId: receptionId },
        [{ stockItemId: bottle, stockLocationId: places.get('Store')!, kind: 'receive', quantity: 5, actionId: `test-receive:${bottle}` }],
      ),
    );
    expect(await held('MR-BOTTLE')).toEqual({ Store: 5, BOH: 22, FOH: 8 });
    const saleId = newId();
    expect((await commit({ id: saleId, items: [itemLine('MR-BOTTLE', 32)] })).statusCode).toBe(200);
    expect((await finalise(saleId)).statusCode).toBe(200);
    expect(await held('MR-BOTTLE')).toEqual({ Store: 3, BOH: 0, FOH: 0 });
    const moved = Object.fromEntries((await movementsOfSale(saleId)).map((m) => [m.place, m.quantity]));
    expect(moved).toEqual({ FOH: -8, BOH: -22, Store: -2 });
    await expectLedgerAddsUp();
  });

  it('two tills, the last units: both commit, the first close takes them, the second is recorded with a shortfall — never refused', async () => {
    // Oto Mascot Plush: 18 in the branch. Till A sells all 18, till B one more.
    const a = newId();
    const b = newId();
    expect((await commit({ id: a, items: [itemLine('MR-PLUSH', 18)] })).statusCode).toBe(200);
    // B's guard runs before A is paid, so the 18 are still on record.
    expect((await commit({ id: b, items: [itemLine('MR-PLUSH', 1)] })).statusCode).toBe(200);
    expect((await finalise(a)).statusCode).toBe(200);
    const closed = await finalise(b);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().finalised).toBe(true);
    expect(await held('MR-PLUSH')).toEqual({ Store: 0, BOH: 0, FOH: 0 });
    expect(await movementsOfSale(b)).toEqual([{ kind: 'sale', quantity: 0, shortfall: 1, place: 'FOH' }]);
    const attention = await ctx.db.select().from(stockAttention).where(eq(stockAttention.saleId, b));
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ kind: 'stock_shortfall', quantity: 1 });
    expect(attention[0]!.summary).toContain('1 Oto Mascot Plush sold that the record did not hold');
    // A later till is refused at commit: there is nothing on record now.
    const later = await commit({ id: newId(), items: [itemLine('MR-PLUSH', 1)] });
    expect(later.json().error.message).toBe('Oto Mascot Plush is out of stock. Nothing was saved.');
    await expectLedgerAddsUp();
  });

  it('two tills closing at the same instant over the same shelves: no deadlock, no refusal, the ledger adds up', async () => {
    // T-shirts: 40 in the branch. X takes 20 then socks; Y takes socks then 25 —
    // the opposite order, and 45 between them. The locks are taken in one fixed
    // order whatever the cart says, so both close; one records a shortfall of 5.
    const x = newId();
    const y = newId();
    expect((await commit({ id: x, items: [itemLine('MR-TSHIRT', 20), itemLine('MR-SOCKS', 5, 'm')] })).statusCode).toBe(200);
    expect((await commit({ id: y, items: [itemLine('MR-SOCKS', 5, 'm'), itemLine('MR-TSHIRT', 25)] })).statusCode).toBe(200);
    const [fx, fy] = await Promise.all([finalise(x), finalise(y)]);
    expect([fx.statusCode, fy.statusCode]).toEqual([200, 200]);
    expect(await held('MR-TSHIRT')).toEqual({ Store: 0, BOH: 0, FOH: 0 });
    expect(await held('MR-SOCKS', 'm')).toEqual({ Store: 0, BOH: 28, FOH: 2 });
    const short = [...(await movementsOfSale(x)), ...(await movementsOfSale(y))].reduce((sum, m) => sum + m.shortfall, 0);
    expect(short).toBe(5);
    await expectLedgerAddsUp();
  });

  it('an offline replay never refuses on a shortfall: it records an offline sale, the shortfall and an attention row', async () => {
    // Commit 5 Sticker Packs while they are there, sell out the 80 online, then
    // close the first as a box's replay does (printing skipped, money taken).
    const offline = newId();
    expect((await commit({ id: offline, items: [itemLine('MR-STICKERS', 5)] })).statusCode).toBe(200);
    const online = newId();
    expect((await commit({ id: online, items: [itemLine('MR-STICKERS', 80)] })).statusCode).toBe(200);
    expect((await finalise(online)).statusCode).toBe(200);
    const result = await ctx.db.transaction((tx) =>
      finaliseSale(tx, { accountId: receptionId, operatorId, branchId }, offline, { printing: 'skip' }),
    );
    expect(result.finalised).toBe(true);
    const moved = await movementsOfSale(offline);
    expect(moved).toEqual([{ kind: 'offline_sale', quantity: 0, shortfall: 5, place: 'FOH' }]);
    const [flag] = await ctx.db.select().from(stockAttention).where(eq(stockAttention.saleId, offline));
    expect(flag).toMatchObject({ kind: 'stock_shortfall', quantity: 5 });
    expect(await held('MR-STICKERS')).toEqual({ Store: 0, BOH: 0, FOH: 0 });
    await expectLedgerAddsUp();
  });
});

describe('a refund puts returned stock at the sell point, once', () => {
  it('returns every cascaded unit to the counter, and a second pass moves nothing', async () => {
    // Oto Cap: 7 at the counter, 18 behind. Sell 10 → 7 from FOH, 3 from BOH.
    const saleId = newId();
    expect((await commit({ id: saleId, items: [itemLine('MR-CAP', 10)] })).statusCode).toBe(200);
    expect((await finalise(saleId)).statusCode).toBe(200);
    expect(await held('MR-CAP')).toEqual({ Store: 0, BOH: 15, FOH: 0 });

    const actor = {
      accountId: receptionId,
      operatorId,
      stationId,
      assertBranchAllowed: async () => {},
      assertCanApprove: async () => {},
    };
    const refunded = await ctx.db.transaction((tx) =>
      refundSale(tx, actor, saleId, { mode: 'whole', reason: 'Wrong size' }),
    );
    expect(refunded.refund.lines.every((l) => l.restock)).toBe(true);
    // All 10 returned units go onto the counter shelf.
    expect(await held('MR-CAP')).toEqual({ Store: 0, BOH: 15, FOH: 10 });

    // Never twice: the restock is keyed by the sale line, whichever refund asks.
    const lineIds = refunded.refund.lines.map((l) => l.saleLineId);
    const again = await ctx.db.transaction((tx) =>
      restockForRefund(tx, {
        operatorId,
        branchId,
        saleId,
        refundId: refunded.refund.id,
        saleLineIds: lineIds,
        businessDate: '2026-10-02',
        stationId,
        actorAccountId: receptionId,
        now: new Date(),
      }),
    );
    expect(again).toEqual([]);
    expect(await held('MR-CAP')).toEqual({ Store: 0, BOH: 15, FOH: 10 });
    await expectLedgerAddsUp();
  });

  it('a unit sold past the record goes back where the shortfall was recorded', async () => {
    // The plush sold on till B above carried a shortfall of 1 at the counter.
    const [b] = await ctx.db
      .select({ saleId: stockMovement.saleId })
      .from(stockMovement)
      .where(and(eq(stockMovement.kind, 'sale'), eq(stockMovement.shortfall, 1)));
    const actor = {
      accountId: receptionId,
      operatorId,
      stationId,
      assertBranchAllowed: async () => {},
      assertCanApprove: async () => {},
    };
    await ctx.db.transaction((tx) => refundSale(tx, actor, b!.saleId!, { mode: 'whole', reason: 'Changed mind' }));
    expect(await held('MR-PLUSH')).toEqual({ Store: 0, BOH: 0, FOH: 1 });
    await expectLedgerAddsUp();
  });
});

describe('the routes', () => {
  it('GET sellable answers every tracked product with its sizes, for the counter', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/stock/sellable`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sellPointId: string;
      products: Array<{ productId: string; name: string; sizes: Array<{ variantId: string | null; available: number; atSellPoint: number; status: string }> }>;
    };
    expect(body.sellPointId).toBe(places.get('FOH'));
    const socks = body.products.find((p) => p.productId === productIds.get('MR-SOCKS'))!;
    expect(socks.sizes.map((s) => s.variantId)).toEqual(['s', 'm', 'l']);
    expect(socks.sizes[0]).toMatchObject({ available: 25, atSellPoint: 7, status: 'ok' });
    const keyring = body.products.find((p) => p.productId === productIds.get('MR-KEYRING'))!;
    expect(keyring.sizes).toEqual([expect.objectContaining({ variantId: null, available: 0, status: 'out' })]);
  });

  it('GET levels and movements answer the branch’s ledger', async () => {
    const levels = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/stock/levels`, headers: { cookie } });
    expect(levels.statusCode).toBe(200);
    expect(levels.json().locations.map((l: { name: string }) => l.name)).toEqual(['FOH', 'BOH', 'Store']);
    const cap = await itemIdOf('MR-CAP');
    const moves = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/stock/movements?stockItemId=${cap}`,
      headers: { cookie },
    });
    expect(moves.statusCode).toBe(200);
    expect(moves.json().movements.map((m: { kind: string }) => m.kind)).toContain('refund');
  });

  it('refuses another operator’s administrator', async () => {
    const foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/stock/sellable`,
      headers: { cookie: foreign },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('the catalogue carries the stock link both ways, and writes it', async () => {
    const water = productIds.get('FB-WATER')!;
    const menu = async () =>
      (
        await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/menu`, headers: { cookie: adminCookie } })
      ).json() as { products: Array<{ id: string; stockItemId: string | null; stockLinks: Array<{ variantId: string | null; stockItemId: string }> }> };
    const before = (await menu()).products.find((p) => p.id === water)!;
    expect(before.stockLinks).toHaveLength(1);
    expect(before.stockItemId).toBe(before.stockLinks[0]!.stockItemId);

    const unlink = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/menu/products/${water}`,
      headers: { cookie: adminCookie },
      payload: { stockLinks: [] },
    });
    expect(unlink.statusCode).toBe(200);
    const untracked = (await menu()).products.find((p) => p.id === water)!;
    expect(untracked).toMatchObject({ stockItemId: null, stockLinks: [] });

    const relink = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/menu/products/${water}`,
      headers: { cookie: adminCookie },
      payload: { stockLinks: [{ variantId: null, stockItemId: before.stockLinks[0]!.stockItemId }] },
    });
    expect(relink.statusCode).toBe(200);
    expect((await menu()).products.find((p) => p.id === water)!.stockLinks).toEqual(before.stockLinks);

    // A size the item does not have is refused.
    const wrong = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/menu/products/${water}`,
      headers: { cookie: adminCookie },
      payload: { stockLinks: [{ variantId: 'xl', stockItemId: before.stockLinks[0]!.stockItemId }] },
    });
    expect(wrong.statusCode).toBe(400);
  });
});
