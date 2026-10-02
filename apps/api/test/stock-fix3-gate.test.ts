import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, branch, product, station, stockItem, stockLevel, stockLocation, stockTakeLine } from '@oto/db';
import { businessDate, newId, parseDayStart, type StockReports } from '@oto/shared';
import { commitSale, finaliseSale } from '../src/services/sale';
import {
  commitStockTake,
  receiveStock,
  setSellPoint,
  transferStock,
  type StockActor,
} from '../src/services/stock';
import { ADMIN, BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * GATE (final check) — the stock fix round, F1 under concurrency, the races the
 * delivery reproduction (`stock-fix2-gate`) does not cover:
 *
 *   - a TRANSFER into a new place, still open while that place's first count
 *     waits on the same shelf;
 *   - a transfer of ANOTHER item into the new place, open while the count
 *     commits (no shared row: the count must not wait, and its answer must be
 *     the one the serial order gives it);
 *   - a SALE DECREMENT at a place, open while that place's first count waits;
 *   - a sale's SHORTFALL-ONLY row at a never-stocked sell point, open while
 *     that place's first count waits — the place genuinely never held anything,
 *     so the count IS its opening.
 *
 * The opening answer is false whenever stock moved to the place before the
 * count in the serial order, and true only for a never-stocked place.
 *
 * THE INVARIANT after every flow: each level is exactly the sum of its movements.
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let operatorId: string;
let branchId: string;
let managerId: string;
let receptionId: string;
let stationId: string;
let today: string;
const productIds = new Map<string, string>();

const stockUrl = (path: string) => `/branches/${branchId}/stock${path}`;

async function itemIdOf(code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: stockItem.id })
    .from(stockItem)
    .where(
      and(
        eq(stockItem.productId, productIds.get(code)!),
        eq(stockItem.branchId, branchId),
        isNull(stockItem.archivedAt),
        sql`${stockItem.variantId} is null`,
      ),
    );
  return row!.id;
}

async function placeId(name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: stockLocation.id })
    .from(stockLocation)
    .where(and(eq(stockLocation.branchId, branchId), eq(stockLocation.name, name)));
  return row!.id;
}

async function levelOf(itemId: string, locationId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ q: stockLevel.quantity })
    .from(stockLevel)
    .where(and(eq(stockLevel.stockItemId, itemId), eq(stockLevel.stockLocationId, locationId)));
  return row?.q ?? 0;
}

async function newPlace(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: stockUrl('/locations'),
    headers: { cookie: admin },
    payload: { name, type: 'rotation' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { id: string }).id;
}

async function expectLedgerAddsUp(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select l.stock_item_id, l.stock_location_id, l.quantity,
           coalesce((select sum(m.quantity) from pos.stock_movement m
                      where m.stock_item_id = l.stock_item_id and m.stock_location_id = l.stock_location_id), 0)::int as moved
      from pos.stock_level l`);
  const off = (rows as Array<{ quantity: number; moved: number }>).filter((r) => r.quantity !== r.moved || r.quantity < 0);
  expect(off).toEqual([]);
}

/** Wait until some backend of this database is blocked on a lock. */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
    if (rows[0]!.n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the count never waited on the other writer’s lock');
}

async function storedOpening(takeId: string): Promise<boolean[]> {
  const rows = await ctx.db
    .select({ opening: stockTakeLine.opening })
    .from(stockTakeLine)
    .where(eq(stockTakeLine.stockTakeId, takeId));
  return rows.map((r) => r.opening!);
}

async function reports(): Promise<StockReports> {
  const rep = await ctx.app.inject({
    method: 'GET',
    url: stockUrl(`/reports?from=${today}&to=${today}`),
    headers: { cookie: manager },
  });
  expect(rep.statusCode, rep.body).toBe(200);
  return rep.json() as StockReports;
}

/** Hold `work` open inside a transaction until the returned `release` is called. */
function heldOpen(work: (tx: Parameters<Parameters<TestContext['db']['transaction']>[0]>[0]) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let written!: () => void;
  const wrote = new Promise<void>((r) => (written = r));
  const done = ctx.db.transaction(async (tx) => {
    await work(tx);
    written();
    await gate;
  });
  return { wrote, release, done };
}

const actor = (): StockActor => ({ operatorId, branchId, accountId: managerId, requestId: null, stationId: null });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const hkt = (await ctx.db.select().from(branch)).find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  today = businessDate(new Date(), hkt.timezone, parseDayStart(hkt.businessDayStart));
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code && (p.branchId === branchId || p.branchId === null)) productIds.set(p.code, p.id);
  }
  managerId = (await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone)))[0]!.id;
  receptionId = (await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)))[0]!.id;
  const tills = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (tills.find((s) => s.codePrefix === 'T1') ?? tills[0]!).id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('GATE F1 — a transfer into a new place racing its first count', () => {
  it('same shelf: the count waits, reads the transferred 5, and finding 1 is a flagged loss of 4 — not an opening', async () => {
    const plush = await itemIdOf('MR-PLUSH');
    const boh = await placeId('BOH');
    const dock = await newPlace('Race Transfer Dock');
    expect(await levelOf(plush, boh)).toBeGreaterThanOrEqual(5);

    const transfer = heldOpen((tx) =>
      transferStock(tx, actor(), { fromLocationId: boh, toLocationId: dock, lines: [{ stockItemId: plush, quantity: 5 }] }, new Date()),
    );
    await transfer.wrote;
    const counting = ctx.db.transaction((tx) =>
      commitStockTake(tx, actor(), { lines: [{ stockItemId: plush, locationId: dock, countedQuantity: 1 }] }, new Date()),
    );
    await waitForLockWait();
    transfer.release();
    await transfer.done;
    const take = await counting;

    expect(take.lines[0]).toMatchObject({ expectedQuantity: 5, countedQuantity: 1, difference: -4, opening: false, flagged: true });
    expect(take.opening).toBe(false);
    expect(await storedOpening(take.id)).toEqual([false]);
    const rep = await reports();
    expect(rep.discrepancies.filter((d) => d.locationId === dock).map((d) => d.difference)).toEqual([-4]);
    await expectLedgerAddsUp();
  });

  it('another item: the count does not wait, so it is first in the serial order and IS the opening; the next count is ordinary', async () => {
    const plush = await itemIdOf('MR-PLUSH');
    const cap = await itemIdOf('MR-CAP');
    const boh = await placeId('BOH');
    const dock = await newPlace('Race Other Item Dock');

    const transfer = heldOpen((tx) =>
      transferStock(tx, actor(), { fromLocationId: boh, toLocationId: dock, lines: [{ stockItemId: cap, quantity: 4 }] }, new Date()),
    );
    await transfer.wrote;
    // The count shares no row with the open transfer: it must commit on its own.
    const first = await ctx.db.transaction((tx) =>
      commitStockTake(tx, actor(), { lines: [{ stockItemId: plush, locationId: dock, countedQuantity: 0 }] }, new Date()),
    );
    expect(first.lines[0]).toMatchObject({ expectedQuantity: 0, difference: 0, opening: true, flagged: false });
    transfer.release();
    await transfer.done;

    // The cap arrived after the opening: counting 1 of the 4 is a loss of 3.
    const second = await ctx.db.transaction((tx) =>
      commitStockTake(tx, actor(), { lines: [{ stockItemId: cap, locationId: dock, countedQuantity: 1 }] }, new Date()),
    );
    expect(second.lines[0]).toMatchObject({ expectedQuantity: 4, difference: -3, opening: false });
    expect(await storedOpening(second.id)).toEqual([false]);
    const rep = await reports();
    expect(rep.discrepancies.filter((d) => d.locationId === dock).map((d) => d.difference)).toEqual([-3]);
    await expectLedgerAddsUp();
  });
});

describe('GATE F1 — a sale at a place racing its first count', () => {
  it('a sale decrement open at the place: the count waits, reads what the sale left, and its shortfall is a real loss', async () => {
    const keyring = await itemIdOf('MR-KEYRING');
    const dock = await newPlace('Race Sale Dock');
    // The keyring is out everywhere; only the dock holds it — so a sale takes it from there.
    await ctx.db.transaction((tx) =>
      receiveStock(tx, actor(), { stockItemId: keyring, locationId: dock, quantity: 5, reason: 'Delivery from the supplier' }, new Date()),
    );
    const saleActor = { accountId: receptionId, operatorId, branchId };
    const input = { id: newId(), branchId, stationId, items: [{ id: newId(), productId: productIds.get('MR-KEYRING')!, quantity: 1 }] };
    await ctx.db.transaction((tx) => commitSale(tx, saleActor, input as never, new Date(), { printing: 'skip' }));

    const sale = heldOpen((tx) => finaliseSale(tx, saleActor, input.id, { printing: 'skip' }));
    await sale.wrote;
    const counting = ctx.db.transaction((tx) =>
      commitStockTake(tx, actor(), { lines: [{ stockItemId: keyring, locationId: dock, countedQuantity: 0 }] }, new Date()),
    );
    await waitForLockWait();
    sale.release();
    await sale.done;
    const take = await counting;

    expect(take.lines[0]).toMatchObject({ expectedQuantity: 4, countedQuantity: 0, difference: -4, opening: false, flagged: true });
    expect(await storedOpening(take.id)).toEqual([false]);
    const rep = await reports();
    expect(rep.discrepancies.filter((d) => d.locationId === dock).map((d) => d.difference)).toEqual([-4]);
    await expectLedgerAddsUp();
  });

  it('a sale shortfall at a never-stocked sell point: nothing moved there, so its first count IS the opening', async () => {
    const keyring = await itemIdOf('MR-KEYRING');
    const counter = await newPlace('Race Never Stocked Counter');
    await ctx.db.transaction((tx) => setSellPoint(tx, actor(), counter, new Date()));
    expect(await levelOf(keyring, counter)).toBe(0);
    // Sell two more keyrings than the whole branch holds: the rest is a
    // shortfall, recorded at the sell point — the never-stocked counter.
    const saleActor = { accountId: receptionId, operatorId, branchId };
    const held = (await ctx.db.select({ q: stockLevel.quantity }).from(stockLevel).where(eq(stockLevel.stockItemId, keyring))).reduce(
      (s, r) => s + r.q,
      0,
    );
    const input = {
      id: newId(),
      branchId,
      stationId,
      items: [{ id: newId(), productId: productIds.get('MR-KEYRING')!, quantity: held + 2 }],
    };
    await ctx.db.transaction((tx) => commitSale(tx, saleActor, input as never, new Date(), { printing: 'skip' }));

    const sale = heldOpen((tx) => finaliseSale(tx, saleActor, input.id, { printing: 'skip' }));
    await sale.wrote;
    const counting = ctx.db.transaction((tx) =>
      commitStockTake(tx, actor(), { lines: [{ stockItemId: keyring, locationId: counter, countedQuantity: 6 }] }, new Date()),
    );
    await waitForLockWait();
    sale.release();
    await sale.done;
    const take = await counting;

    // The sale's row here moved nothing (quantity 0, shortfall 2): the place never held a keyring.
    const { rows } = await ctx.db.execute<{ quantity: number; shortfall: number }>(sql`
      select quantity, shortfall from pos.stock_movement
       where sale_id = ${input.id}::uuid and stock_location_id = ${counter}::uuid`);
    expect(rows.map((r) => [r.quantity, r.shortfall])).toEqual([[0, 2]]);
    expect(take.lines[0]).toMatchObject({ expectedQuantity: 0, countedQuantity: 6, difference: 6, opening: true, flagged: false });
    expect(await storedOpening(take.id)).toEqual([true]);
    const rep = await reports();
    expect(rep.discrepancies.filter((d) => d.locationId === counter)).toEqual([]);
    await expectLedgerAddsUp();
  });
});
