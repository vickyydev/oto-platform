import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  branch,
  product,
  stockAttention,
  stockItem,
  stockLevel,
  stockLocation,
  stockMovement,
  station,
} from '@oto/db';
import { newId } from '@oto/shared';
import { commitSale, finaliseSale } from '../src/services/sale';
import { refundSale } from '../src/services/refunds';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14b round 1 — RE-CHECK gate reproductions (invariants 1-3): the ledger adds
 * up after every flow below, a paid sale is never refused for stock on any
 * finalise point or replay, and the guard refuses in the counter's words with
 * nothing written. Each `it` here PASSED on the round-1 fix code; they are kept
 * as regression locks for rounds 2-4.
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let receptionId: string;
const productIds = new Map<string, string>();

const itemLine = (code: string, quantity: number, variantId?: string) => ({
  id: newId(),
  productId: productIds.get(code)!,
  quantity,
  ...(variantId ? { variant: { variantId, variantLabel: variantId.toUpperCase() } } : {}),
});

async function commit(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie }, payload: { stationId, ...payload } });
}

async function finalise(saleId: string) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie } });
}

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

async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  expect((rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved || r.quantity < 0)).toEqual([]);
}

const total = (h: Record<string, number>) => Object.values(h).reduce((a, b) => a + b, 0);

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
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
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('re-check (2) — the paid sale is never refused for stock', () => {
  it('a ฿0 close at commit (the other finalise point) takes its stock', async () => {
    // Oto Cap: 25 in the branch. Comped whole: closed at commit.
    const saleId = newId();
    const lineId = newId();
    const res = await commit({
      id: saleId,
      finalise: true,
      items: [{ ...itemLine('MR-CAP', 2), id: lineId }],
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Birthday child' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().finalised).toBe(true);
    expect(total(await held('MR-CAP'))).toBe(23);
    const moved = await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, saleId));
    expect(moved.map((m) => [m.kind, m.quantity])).toEqual([['sale', -2]]);
    await expectLedgerAddsUp();
  });

  it('a commit replayed after another till emptied the shelf is answered as the replay, and its close is not refused', async () => {
    // Oto Mascot Plush: 18. A commits 18, B commits and closes 18, A's commit is retried, then A is paid.
    const a = newId();
    const aLines = [itemLine('MR-PLUSH', 18)];
    expect((await commit({ id: a, items: aLines })).statusCode).toBe(200);
    const b = newId();
    expect((await commit({ id: b, items: [itemLine('MR-PLUSH', 18)] })).statusCode).toBe(200);
    expect((await finalise(b)).statusCode).toBe(200);
    const retried = await commit({ id: a, items: aLines });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().replay).toBe(true);
    const closed = await finalise(a);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().finalised).toBe(true);
    const shortfall = (await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, a))).reduce(
      (sum, m) => sum + m.shortfall,
      0,
    );
    expect(shortfall).toBe(18);
    await expectLedgerAddsUp();
  });

  it('an offline replay commits a cart past the record (no guard) and closes it with the shortfall recorded', async () => {
    // Mascot Keyring is out everywhere; the box sold 3 while the platform could not see it.
    const actor = { accountId: receptionId, operatorId, branchId };
    const input = { id: newId(), branchId, stationId, items: [itemLine('MR-KEYRING', 3)] };
    await ctx.db.transaction((tx) => commitSale(tx, actor, input as never, new Date(), { printing: 'skip' }));
    const result = await ctx.db.transaction((tx) => finaliseSale(tx, actor, input.id, { printing: 'skip' }));
    expect(result.finalised).toBe(true);
    const moved = await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleId, input.id));
    expect(moved.map((m) => [m.kind, m.quantity, m.shortfall, m.offline])).toEqual([['offline_sale', 0, 3, true]]);
    const flags = await ctx.db.select().from(stockAttention).where(eq(stockAttention.saleId, input.id));
    expect(flags.map((f) => [f.kind, f.quantity])).toEqual([['stock_shortfall', 3]]);
    await expectLedgerAddsUp();
  });
});

describe('re-check (1) — a refund replayed restocks once', () => {
  it('the same refund press twice puts the stock back once', async () => {
    const saleId = newId();
    expect((await commit({ id: saleId, items: [itemLine('MR-BOTTLE', 10)] })).statusCode).toBe(200);
    expect((await finalise(saleId)).statusCode).toBe(200);
    expect(await held('MR-BOTTLE')).toEqual({ Store: 0, BOH: 20, FOH: 0 });
    const actor = {
      accountId: receptionId,
      operatorId,
      stationId,
      assertBranchAllowed: async () => {},
      assertCanApprove: async () => {},
    };
    const actionId = `refund-press:${saleId}`;
    const first = await ctx.db.transaction((tx) =>
      refundSale(tx, actor, saleId, { mode: 'whole', reason: 'Leaking', actionId }),
    );
    const second = await ctx.db.transaction((tx) =>
      refundSale(tx, actor, saleId, { mode: 'whole', reason: 'Leaking', actionId }),
    );
    expect(second.replay).toBe(true);
    expect(second.refund.id).toBe(first.refund.id);
    // Returned goods go back to the sell point, whichever place the sale drew from.
    expect(await held('MR-BOTTLE')).toEqual({ Store: 0, BOH: 20, FOH: 10 });
    await expectLedgerAddsUp();
  });
});

describe('re-check (3) — the guard', () => {
  it('counts the ticket socks and the socks add-on on one shelf, refuses in the counter’s words, and writes nothing', async () => {
    // Regular Socks: 100 in the branch (80 BOH + 20 FOH). 60 on the ticket line + 41 from the grid = 101.
    const packages = await ctx.db.execute(sql`select id from pos.ticket_package where branch_id = ${branchId} and name = '2 Hours Play'`);
    const packageId = (packages.rows[0] as { id: string }).id;
    const saleId = newId();
    const res = await commit({
      id: saleId,
      socks: { addOnId: 'a-socks', unitSatang: 5000, label: 'Regular Socks' },
      lines: [
        {
          id: newId(),
          packageId,
          kids: 1,
          adults: 1,
          socks: 50,
          addOns: [{ id: productIds.get('AO-SOCKS')!, quantity: 51 }],
        },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'STOCK_SHORT', message: 'Only 100 Regular Socks left. Nothing was saved.' });
    const { rows } = await ctx.db.execute(sql`select count(*)::int as n from pos.sale where id = ${saleId}`);
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});
