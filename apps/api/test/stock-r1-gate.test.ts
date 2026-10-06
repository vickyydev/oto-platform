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
import { resetDemoData } from '../src/services/demo-reset';
import { commitSale } from '../src/services/sale';
import { takeStockForSale } from '../src/services/stock';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-14b round 1 — GATE REPRODUCTIONS (focused gate, round 1).
 *
 * Each test below is a defect the gate found: it asserts the behaviour the
 * plan and the prototype require. Each was an `it.fails` on the round-1 code
 * (R1 net movement 0 where -2, R2 a 400 where 200, R3 an AppError 400) and was
 * flipped to `it` by the fix round, which also added the low findings' checks
 * at the end (cost per each, the purge flag).
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

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const hkt = (await ctx.db.select().from(branch)).find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code) productIds.set(p.code, p.id);
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

describe('gate R1 — the ticket line socks count (prototype mockApi.ts:1304-1311)', () => {
  /**
   * The prototype decrements Regular Socks (`a-socks` → `inv-a-socks`) for every
   * ticket line's `socks` count. The till still sends the socks add-on as the
   * prototype id `a-socks` (`apps/pos/src/lib/cartWire.ts:173,221`), which is not
   * a uuid, so `priceCart` snapshot-prices it and the socks sale line carries no
   * product id — `takeStockForSale` never sees it. The till's own guard reads a
   * per-tab mock count for it (`Till.tsx:2402-2411`), never the platform.
   */
  it('a ticket sold with 2 socks at the till takes 2 Regular Socks off the shelf', async () => {
    const before = await held('AO-SOCKS');
    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: saleId,
        stationId,
        socks: { addOnId: 'a-socks', unitSatang: 5000, label: 'Regular Socks' },
        lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1, socks: 2, addOns: [] }],
      },
    });
    expect(res.statusCode).toBe(200);
    const fin = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie } });
    expect(fin.statusCode).toBe(200);
    const moved = await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, saleId));
    expect(moved.reduce((sum, m) => sum + m.quantity - m.shortfall, 0)).toBe(-2);
    const after = await held('AO-SOCKS');
    expect((after.FOH ?? 0) + (after.BOH ?? 0)).toBe((before.FOH ?? 0) + (before.BOH ?? 0) - 2);
  });
});

describe('gate R2 — an F&B item sold in sizes but not stock-tracked', () => {
  /**
   * The F&B counter can only offer a size from STOCK (`OrderStation.tsx:533-543`
   * shows the picker only when `inventoryFor` answers with more than one size;
   * `apiProductToMenuItem` maps no sizes onto a MenuItem). Round 1 now REQUIRES
   * a size on an F&B item sold in two or more (`resolveLineVariant`, sale.ts).
   * So switching Track stock off on the Slushie (the admin form sends
   * `stockLinks: []`, `api/menu.ts:470-473`) makes the Slushie unsellable at
   * the F&B counter: the till sends no size, the platform refuses.
   */
  it('the counter can still sell a Slushie after its stock tracking is switched off', async () => {
    const slushie = productIds.get('FB-SLUSHIE')!;
    const menu = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/menu`,
      headers: { cookie: adminCookie },
    });
    const links = (menu.json() as { products: Array<{ id: string; stockLinks: unknown[] }> }).products.find(
      (p) => p.id === slushie,
    )!.stockLinks;
    expect(links.length).toBe(3);
    const off = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/menu/products/${slushie}`,
      headers: { cookie: adminCookie },
      payload: { stockLinks: [] },
    });
    expect(off.statusCode).toBe(200);
    // What the till sends for an untracked item: no size (no picker was shown).
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: newId(),
        stationId,
        pickupCode: 'G1',
        items: [{ id: newId(), productId: slushie, quantity: 1 }],
      },
    });
    expect(res.statusCode).toBe(200);
    // Tracked again for R3, which needs the sizes' stock.
    const on = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/menu/products/${slushie}`,
      headers: { cookie: adminCookie },
      payload: { stockLinks: links },
    });
    expect(on.statusCode).toBe(200);
  });
});

describe('gate R3 — an offline F&B sale whose flavour the catalogue no longer lists', () => {
  /**
   * The offline replay commits with `printing: 'skip'` (`payments/offline.ts:573`,
   * `sync.ts:1267`): the money was taken hours ago. Before round 1 an F&B size
   * was the till's free text and was filed as sent; round 1 validates it against
   * the catalogue, so a box that sold a flavour the manager has since removed
   * is refused at replay (a 400, into quarantine) instead of filed with a
   * `size_unknown` attention as the stock service is built to do.
   */
  it('a replayed paid F&B sale with a retired flavour is filed, not refused', async () => {
    const slushie = productIds.get('FB-SLUSHIE')!;
    const actor = { accountId: receptionId, operatorId, branchId };
    const input = {
      id: newId(),
      branchId,
      stationId,
      pickupCode: 'H1',
      items: [{ id: newId(), productId: slushie, quantity: 1, variant: { variantId: 'purple', variantLabel: 'Purple' } }],
    };
    const result = await ctx.db.transaction((tx) =>
      commitSale(tx, actor, input as never, new Date(), { printing: 'skip' }),
    );
    expect(result.sale.id).toBe(input.id);
    // Filed with the size the box sent, and the line says so.
    const [line] = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, input.id));
    expect(line!.label).toBe('Slushie — Purple');
    expect(line!.payload).toMatchObject({ variant: { variantId: 'purple', variantLabel: 'Purple' } });
    // Its close takes nothing off a shelf it cannot name, and asks someone to look.
    const taken = await closeAsReplay(input.id);
    expect(taken.unsized).toEqual([{ saleLineId: line!.id, quantity: 1 }]);
    expect(taken.movements).toHaveLength(0);
    const flagged = await ctx.db.select().from(stockAttention).where(eq(stockAttention.saleLineId, line!.id));
    expect(flagged.map((a) => a.kind)).toEqual(['size_unknown']);
  });

  it('a replayed paid F&B sale with NO size on an item stocked in sizes is filed, and flagged', async () => {
    const slushie = productIds.get('FB-SLUSHIE')!;
    const actor = { accountId: receptionId, operatorId, branchId };
    const input = {
      id: newId(),
      branchId,
      stationId,
      pickupCode: 'H2',
      items: [{ id: newId(), productId: slushie, quantity: 2 }],
    };
    await ctx.db.transaction((tx) => commitSale(tx, actor, input as never, new Date(), { printing: 'skip' }));
    const taken = await closeAsReplay(input.id);
    expect(taken.unsized).toEqual([{ saleLineId: expect.any(String), quantity: 2 }]);
    const flagged = await ctx.db.select().from(stockAttention).where(eq(stockAttention.saleId, input.id));
    expect(flagged.map((a) => [a.kind, a.quantity])).toEqual([['size_unknown', 2]]);
  });

  it('a till ringing up a flavour the catalogue does not list is still told so', async () => {
    const slushie = productIds.get('FB-SLUSHIE')!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: newId(),
        stationId,
        pickupCode: 'H3',
        items: [{ id: newId(), productId: slushie, quantity: 1, variant: { variantId: 'purple', variantLabel: 'Purple' } }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('"Slushie" has no size "purple" — it comes in Red, Blue, Green');
  });
});

/** The finalise decrement as an offline replay runs it, on a sale already written. */
async function closeAsReplay(saleId: string) {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(sale).where(eq(sale.id, saleId));
    return takeStockForSale(tx, row!, { actorAccountId: receptionId, offline: true, now: new Date() });
  });
}

describe('gate lows — cost per each, and the purge flag', () => {
  it('the levels and the ledger answer the cost per each to a manager only (finding 11)', async () => {
    const asReception = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/stock/levels`,
      headers: { cookie },
    });
    expect(asReception.statusCode).toBe(200);
    const items = (asReception.json() as { items: Array<{ unitCostSatang: number | null }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.unitCostSatang === null)).toBe(true);
    const moves = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/stock/movements`,
      headers: { cookie },
    });
    expect(moves.statusCode).toBe(200);
    const rows = (moves.json() as { movements: Array<{ unitCostSatang: number | null }> }).movements;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => m.unitCostSatang === null)).toBe(true);

    const asAdmin = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/stock/levels`,
      headers: { cookie: adminCookie },
    });
    const adminItems = (asAdmin.json() as { items: Array<{ unitCostSatang: number | null }> }).items;
    expect(adminItems.some((i) => i.unitCostSatang !== null)).toBe(true);
  });

  it('a demo reset shuts the ledger purge door behind it (finding 14)', async () => {
    const rolledBack = new Error('roll back the reset');
    await expect(
      ctx.db.transaction(async (tx) => {
        await resetDemoData(tx);
        const { rows } = await tx.execute(sql`select current_setting('oto.stock_ledger_purge', true) as flag`);
        expect((rows[0] as { flag: string | null }).flag).not.toBe('on');
        // The append-only trigger holds again for the rest of the caller's transaction.
        await expect(tx.transaction((inner) => inner.delete(stockMovement))).rejects.toThrow();
        throw rolledBack;
      }),
    ).rejects.toBe(rolledBack);
  });
});
