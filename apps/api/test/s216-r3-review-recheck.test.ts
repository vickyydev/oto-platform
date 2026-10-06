import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
  branch,
  dailySummary,
  paymentAttempt,
  receiptSeries,
  refund,
  sale,
  saleDiscount,
  saleLine,
  station,
  ticketPackage,
  voucher,
  voucherRedemption,
  wallet,
  walletEntry,
} from '@oto/db';
import { DEMO_BRANCH_CODE, demoStableId, seedDemoDay } from '@oto/db/seed';
import { addDaysToIsoDate, businessDate, newId, parseDayStart, type AnalyticsDayFigures, type AnalyticsSummary } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { ROLLUP_DAILY_JOB } from '../src/services/analytics-rollup';

/**
 * S2-15b (SCRUM-216) round 3 — RE-CHECK of the fix round, through the route:
 *
 *   demo       (finding 6) the PRESS itself, on a today the pre-round-3 control
 *              already wrote at Central Floresta: the message tells the truth
 *              about Demo Branch 2, and not one row of any money table at a
 *              live park moves; Central's figures carry none of it.
 *   queue      (finding 3) the rollup's queue is read only for parks the
 *              caller may read: a day queued at Robinson Chalong never turns a
 *              reception account's day provisional, alone or among the
 *              requested ids; only a `sales` mark counts.
 *   freshness  (finding 2) each park's time is its own today's write, and the
 *              summary's own time is the oldest of the parks the caller reads —
 *              never a park it may not read.
 */

let ctx: TestContext;
let reception: string;
let admin: string;
let operatorId: string;
let hkt: string;
let chalong: string;
let demo: string;
let T: string;

const FIGURE_KEYS = [
  'ticketsSatang',
  'fnbSatang',
  'merchSatang',
  'partiesSatang',
  'dropoffSatang',
  'revenueSatang',
  'txnCount',
  'creditPaidSatang',
  'guestsKids',
  'guestsAdults',
  'mix1h',
  'mix2h',
  'mixFullDay',
  'partiesCount',
  'refundsSatang',
  'discountsSatang',
  'compsSatang',
  'vatSatang',
  'serviceSatang',
  'byChannel',
] as const satisfies ReadonlyArray<keyof AnalyticsDayFigures>;

const figuresOf = (row: AnalyticsDayFigures) =>
  Object.fromEntries(FIGURE_KEYS.map((k) => [k, row[k]])) as unknown as AnalyticsDayFigures;

const post = (cookie: string, url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function summary(cookie: string, query: string): Promise<AnalyticsSummary> {
  const res = await ctx.app.inject({ method: 'GET', url: `/analytics/summary?${query}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AnalyticsSummary;
}

async function stored(branchId: string, date: string) {
  const [row] = await ctx.db
    .select()
    .from(dailySummary)
    .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, date), eq(dailySummary.source, 'oto_pos')));
  return row ?? null;
}

async function tillAt(branchId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: station.id })
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.name, 'Reception Till 1')));
  return row!.id;
}

async function packageAt(branchId: string, name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: ticketPackage.id })
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, name)));
  return row!.id;
}

async function cashSale(cookie: string, stationId: string, packageId: string, kids: number, adults: number) {
  const id = newId();
  const committed = await post(cookie, '/sales', { id, stationId, lines: [{ id: newId(), packageId, kids, adults }] });
  expect(committed.statusCode, committed.body).toBe(200);
  const paid = await post(cookie, `/sales/${id}/finalise`, { actionId: newId(), method: 'cash' });
  expect(paid.statusCode, paid.body).toBe(200);
}

async function rollUp(): Promise<void> {
  const res = await post(admin, '/ops/test-controls/rollup.run');
  expect(res.statusCode, res.body).toBe(200);
}

/** Rows of every money table at a live park: what the demo control must never add to. */
async function liveParkMoneyRows(): Promise<Record<string, number>> {
  const parks = [hkt, chalong];
  const count = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]!.n);
  const n = sql<number>`count(*)`;
  return {
    sale: await count(ctx.db.select({ n }).from(sale).where(inArray(sale.branchId, parks))),
    saleLine: await count(ctx.db.select({ n }).from(saleLine).where(inArray(saleLine.branchId, parks))),
    paymentAttempt: await count(ctx.db.select({ n }).from(paymentAttempt).where(inArray(paymentAttempt.branchId, parks))),
    refund: await count(ctx.db.select({ n }).from(refund).where(inArray(refund.branchId, parks))),
    saleDiscount: await count(ctx.db.select({ n }).from(saleDiscount).where(inArray(saleDiscount.branchId, parks))),
    wallet: await count(ctx.db.select({ n }).from(wallet).where(inArray(wallet.branchId, parks))),
    walletEntry: await count(ctx.db.select({ n }).from(walletEntry).where(inArray(walletEntry.branchId, parks))),
    voucher: await count(ctx.db.select({ n }).from(voucher).where(inArray(voucher.branchId, parks))),
    voucherRedemption: await count(
      ctx.db.select({ n }).from(voucherRedemption).where(inArray(voucherRedemption.branchId, parks)),
    ),
    receiptSeqs: await count(
      ctx.db
        .select({ n: sql<number>`coalesce(sum(${receiptSeries.nextSeq}), 0)` })
        .from(receiptSeries)
        .where(inArray(receiptSeries.branchId, parks)),
    ),
  };
}

/**
 * The rows the pre-round-3 control left at Central on `on`: each scenario's
 * sale under its old key (`demo-day/<on>/<scenario>`, id hashed from
 * `<on>/<scenario>`) and the open-cash refund, at Central's till — cloned
 * from Demo Branch 2's real demo day one date earlier, moved a day on.
 */
async function plantOldCentralDay(on: string): Promise<void> {
  const src = addDaysToIsoDate(on, -1);
  await seedDemoDay(ctx.db, { on: src });
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  const till = await tillAt(hkt);
  const prefix = `demo-day/${src}/${DEMO_BRANCH_CODE}/`;
  const shapes = await ctx.db
    .select()
    .from(sale)
    .where(and(eq(sale.branchId, demo), eq(sale.businessDate, src), like(sale.actionId, `${prefix}%`)));
  expect(shapes).toHaveLength(11);
  let openCash: string | null = null;
  for (const shape of shapes) {
    const key = shape.actionId!.slice(prefix.length);
    const occurredAt = new Date(shape.occurredAt.getTime() + 86_400_000);
    const id = demoStableId(`${on}/${key}`, occurredAt);
    await ctx.db.insert(sale).values({
      ...shape,
      id,
      branchId: hkt,
      stationId: till,
      businessDate: on,
      occurredAt,
      receivedAt: occurredAt,
      actionId: `demo-day/${on}/${key}`,
      status: 'tendering',
      receiptSeries: null,
      receiptSeq: null,
      receiptNumber: null,
      finalisedAt: null,
      refundedSatang: 0,
    });
    if (key === 'open-cash') openCash = id;
  }
  const [shapeRefund] = await ctx.db
    .select()
    .from(refund)
    .where(and(eq(refund.branchId, demo), eq(refund.actionId, `${prefix}open-cash/refund`)));
  await ctx.db.insert(refund).values({
    ...shapeRefund!,
    id: newId(),
    branchId: hkt,
    saleId: openCash!,
    stationId: till,
    number: 'OLD-CENTRAL-DEMO-R-1',
    actionId: `demo-day/${on}/open-cash/refund`,
  });
}

let pressMessage = '';
let moneyBefore: Record<string, number>;
let moneyAfter: Record<string, number>;

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, hkt));
  T = businessDate(new Date(), central!.timezone, parseDayStart(central!.businessDayStart));

  // One real sale at each park today, Chalong the bigger, so a leak shows.
  const hktTill = await tillAt(hkt);
  await takeStation(ctx.app, reception, hktTill);
  await cashSale(reception, hktTill, await packageAt(hkt, '2 Hours Play'), 1, 1);
  const chalongTill = await tillAt(chalong);
  await takeStation(ctx.app, chalongManager, chalongTill);
  await cashSale(chalongManager, chalongTill, await packageAt(chalong, 'Full Day Pass'), 3, 2);

  // Today, the old control already wrote its day at Central. Then the press.
  await plantOldCentralDay(T);
  moneyBefore = await liveParkMoneyRows();
  const pressed = await post(admin, '/ops/test-controls/demo.day');
  expect(pressed.statusCode, pressed.body).toBe(200);
  pressMessage = pressed.json<{ message: string }>().message;
  moneyAfter = await liveParkMoneyRows();
  // So Chalong has an older stored day for the freshness check to rewrite.
  await ctx.db.execute(
    sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${chalong}::uuid, ${addDaysToIsoDate(T, -1)}::date, 'sales', 'review')`,
  );
  await rollUp();
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('re-check — the press on a today the old control wrote at Central (finding 6)', () => {
  it('says truthfully that Demo Branch 2 got its eleven sales, and moves nothing at a live park', async () => {
    expect(pressMessage).toBe(
      `Demo day ${T} at Demo Branch 2: 11 sales added, 0 already present. Existing records and closed-day totals were kept.`,
    );
    expect(moneyAfter).toEqual(moneyBefore);
    const demoTill = await tillAt(demo);
    const written = await ctx.db
      .select({ branchId: sale.branchId, stationId: sale.stationId, actionId: sale.actionId })
      .from(sale)
      .where(and(eq(sale.businessDate, T), like(sale.actionId, `demo-day/${T}/${DEMO_BRANCH_CODE}/%`)));
    expect(written).toHaveLength(11);
    for (const s of written) expect([s.branchId, s.stationId]).toEqual([demo, demoTill]);
    // A second press finds them and says so.
    const again = await post(admin, '/ops/test-controls/demo.day');
    expect(again.json<{ message: string }>().message).toContain('0 sales added, 11 already present');
    expect(await liveParkMoneyRows()).toEqual(moneyBefore);
  });

  it('Central’s figures for today are its one real sale: neither the old rows nor the demo day reach them', async () => {
    const central = (await stored(hkt, T))!;
    expect(central.txnCount).toBe(1);
    const own = await summary(reception, `from=${T}&to=${T}`);
    expect(own.branches.map((b) => b.branchId)).toEqual([hkt]);
    expect(figuresOf(own.merged[0]!)).toEqual(figuresOf(central));
    const all = await summary(admin, `from=${T}&to=${T}`);
    const demoRow = (await stored(demo, T))!;
    expect(demoRow.txnCount).toBeGreaterThan(0);
    expect(all.merged[0]!.revenueSatang).toBe(
      central.revenueSatang + (await stored(chalong, T))!.revenueSatang + demoRow.revenueSatang,
    );
  });
});

describe('re-check — the rollup’s queue is read only for parks the caller may read (finding 3)', () => {
  const mark = (branchId: string, date: string, kind: string) =>
    ctx.db.execute(sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${branchId}::uuid, ${date}::date, ${kind}, 'review')`);
  const unmark = (date: string) => ctx.db.execute(sql`delete from analytics.dirty_date where business_date = ${date}::date`);

  it('a day queued at Chalong is provisional for the admin, never for reception, alone or among the ids', async () => {
    const Q = addDaysToIsoDate(T, -12);
    await mark(chalong, Q, 'sales');
    try {
      const own = await summary(reception, `from=${Q}&to=${Q}`);
      expect(own.branches.map((b) => b.branchId)).toEqual([hkt]);
      expect(own.merged[0]).toMatchObject({ provisional: false, rolledDays: 0, revenueSatang: 0 });
      const asked = await summary(reception, `branches=${hkt},${chalong}&from=${Q}&to=${Q}`);
      expect(asked.omitted).toEqual([chalong]);
      expect(asked.merged[0]!.provisional).toBe(false);
      const range = await summary(reception, `from=${addDaysToIsoDate(Q, -1)}&to=${addDaysToIsoDate(Q, 1)}&group=day`);
      expect(range.merged.map((r) => r.provisional)).toEqual([false, false, false]);

      const all = await summary(admin, `branches=${hkt},${chalong}&from=${Q}&to=${Q}`);
      expect(all.merged[0]).toMatchObject({ provisional: true, rolledDays: 0, revenueSatang: 0 });
      expect(Object.fromEntries(all.branches.map((b) => [b.branchId, b.rows[0]!.provisional]))).toEqual({
        [hkt]: false,
        [chalong]: true,
      });
    } finally {
      await unmark(Q);
    }
  });

  it('only a `sales` mark makes an unwritten ended day provisional; the hourly and wallet queues do not', async () => {
    const Q = addDaysToIsoDate(T, -14);
    await mark(hkt, Q, 'hourly');
    await mark(hkt, Q, 'wallet');
    try {
      expect((await summary(reception, `from=${Q}&to=${Q}`)).merged[0]!.provisional).toBe(false);
      await mark(hkt, Q, 'sales');
      expect((await summary(reception, `from=${Q}&to=${Q}`)).merged[0]).toMatchObject({ provisional: true, revenueSatang: 0 });
    } finally {
      await unmark(Q);
    }
  });
});

describe('re-check — freshness is per park, and the summary’s is the oldest the caller reads (finding 2)', () => {
  it('in a stall, reception’s time is Central’s own; the admin’s is the oldest park’s; no answer carries an unread park’s', async () => {
    // As if every daily run since yesterday failed but still wrote today's
    // rows: the successful runs are older than every park, so each park's time
    // is when its own today's row was last written.
    await ctx.db.execute(
      sql`update core.ops_run set started_at = started_at - interval '400 days', finished_at = finished_at - interval '400 days' where name = ${ROLLUP_DAILY_JOB}`,
    );
    const now = Date.now();
    const at = {
      [hkt]: new Date(now - 2 * 60_000),
      [chalong]: new Date(now - 3 * 3_600_000 - 7_000),
      [demo]: new Date(now - 3_600_000),
    };
    const original = await ctx.db
      .select({ id: dailySummary.id, computedAt: dailySummary.computedAt })
      .from(dailySummary)
      .where(inArray(dailySummary.businessDate, [T, addDaysToIsoDate(T, -1)]));
    try {
      for (const [branchId, when] of Object.entries(at)) {
        await ctx.db
          .update(dailySummary)
          .set({ computedAt: when })
          .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, T)));
      }
      // An older day at Chalong rewritten just now (a late refund, say) does not count.
      const rewritten = await ctx.db
        .update(dailySummary)
        .set({ computedAt: new Date(now) })
        .where(and(eq(dailySummary.branchId, chalong), eq(dailySummary.businessDate, addDaysToIsoDate(T, -1))))
        .returning({ id: dailySummary.id });
      expect(rewritten).toHaveLength(1);

      const own = await summary(reception, `branches=${hkt},${chalong}&from=${T}&to=${T}`);
      expect(own.branches.map((b) => [b.branchId, b.lastRolledUpAt])).toEqual([[hkt, at[hkt]!.toISOString()]]);
      expect(own.lastRolledUpAt).toBe(at[hkt]!.toISOString());
      expect(JSON.stringify(own)).not.toContain(at[chalong]!.toISOString());

      const all = await summary(admin, `from=${T}&to=${T}`);
      const byPark = Object.fromEntries(all.branches.map((b) => [b.branchId, b.lastRolledUpAt]));
      expect(byPark).toEqual({
        [hkt]: at[hkt]!.toISOString(),
        [chalong]: at[chalong]!.toISOString(),
        [demo]: at[demo]!.toISOString(),
      });
      expect(all.lastRolledUpAt).toBe(at[chalong]!.toISOString());
    } finally {
      for (const row of original) {
        await ctx.db.update(dailySummary).set({ computedAt: row.computedAt }).where(eq(dailySummary.id, row.id));
      }
      await ctx.db.execute(
        sql`update core.ops_run set started_at = started_at + interval '400 days', finished_at = finished_at + interval '400 days' where name = ${ROLLUP_DAILY_JOB}`,
      );
    }
  });
});
