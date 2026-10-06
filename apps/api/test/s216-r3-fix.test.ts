import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { branch, dailySummary, opsRun, refund, sale, station } from '@oto/db';
import { DEMO_BRANCH_CODE, demoStableId, seedDemoDay } from '@oto/db/seed';
import { addDaysToIsoDate, businessDate, newId, parseDayStart, type AnalyticsSummary } from '@oto/shared';
import { ADMIN, CENTRAL_BRANCH_CODE, branchIdByCode, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { ROLLUP_DAILY_JOB } from '../src/services/analytics-rollup';

/**
 * S2-15b (SCRUM-216) round 3, FIX ROUND — the review's non-blocking findings
 * on the summary and the demo control:
 *
 *   freshness  (finding 2) a run that rewrites an older day and fails before
 *              today's write leaves the park as fresh as it was; only today's
 *              row, or a successful run, moves it.
 *   queued     (finding 3) an ended day with no stored row that the rollup's
 *              queue still holds reads provisional, not as a final empty day.
 *   demo       (finding 6) on a date the pre-round-3 control wrote demo sales
 *              at Central Floresta, a press at Demo Branch 2 writes Demo Branch
 *              2's own day and says so; Central's rows are not touched.
 */

let ctx: TestContext;
let admin: string;
let hkt: string;
let demo: string;
let T: string;
let P: string;

const post = (cookie: string, url: string) => ctx.app.inject({ method: 'POST', url, headers: { cookie } });

async function summary(query: string): Promise<AnalyticsSummary> {
  const res = await ctx.app.inject({ method: 'GET', url: `/analytics/summary?${query}`, headers: { cookie: admin } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AnalyticsSummary;
}

async function rollUp(): Promise<void> {
  const res = await post(admin, '/ops/test-controls/rollup.run');
  expect(res.statusCode, res.body).toBe(200);
}

async function tillAt(branchId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: station.id })
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.name, 'Reception Till 1')));
  return row!.id;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, hkt));
  T = businessDate(new Date(), central!.timezone, parseDayStart(central!.businessDayStart));
  P = addDaysToIsoDate(T, -3);
  await seedDemoDay(ctx.db, { on: T });
  await seedDemoDay(ctx.db, { on: P });
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  await rollUp();
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('fix round — freshness is today’s, not the newest rewrite of any day (finding 2)', () => {
  it('a failed run that rewrote an older day leaves the park as fresh as it was; a write of today moves it', async () => {
    const before = (await summary(`branches=${demo}&from=${T}&to=${T}`)).branches[0]!.lastRolledUpAt!;
    expect(before).not.toBeNull();
    // The run: P (a late refund, say) rewritten, then a failure before today.
    const later = new Date(Date.parse(before) + 5 * 60_000);
    await ctx.db
      .update(dailySummary)
      .set({ computedAt: later, updatedAt: later })
      .where(and(eq(dailySummary.branchId, demo), eq(dailySummary.businessDate, P)));
    await ctx.db
      .insert(opsRun)
      .values({ id: newId(), kind: 'job', name: ROLLUP_DAILY_JOB, outcome: 'failed', startedAt: later, finishedAt: later, durationMs: 1 });

    const after = await summary(`branches=${demo}&from=${T}&to=${T}`);
    expect(after.branches[0]!.lastRolledUpAt).toBe(before);
    expect(after.lastRolledUpAt).toBe(before);
    const health = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: admin } });
    expect(health.statusCode, health.body).toBe(200);
    const rollups = health.json<{ rollups: Array<{ branchId: string; lastRolledUpAt: string | null }> }>().rollups;
    expect(rollups.find((r) => r.branchId === demo)!.lastRolledUpAt).toBe(before);

    // Had the run written today's row before failing, today WAS brought up to date then.
    await ctx.db
      .update(dailySummary)
      .set({ computedAt: later, updatedAt: later })
      .where(and(eq(dailySummary.branchId, demo), eq(dailySummary.businessDate, T)));
    expect((await summary(`branches=${demo}&from=${T}&to=${T}`)).branches[0]!.lastRolledUpAt).toBe(later.toISOString());
  });
});

describe('fix round — an ended day the rollup still owes is provisional (finding 3)', () => {
  it('traded, queued and not yet written: provisional with nothing rolled; written: final with its figures', async () => {
    const Q = addDaysToIsoDate(T, -5);
    await seedDemoDay(ctx.db, { on: Q });
    const queued = await summary(`branches=${demo}&from=${Q}&to=${Q}`);
    expect(queued.merged[0]).toMatchObject({ provisional: true, rolledDays: 0, revenueSatang: 0, computedAt: null });
    // In a range by day, only that day is still moving.
    const range = await summary(`branches=${demo}&from=${addDaysToIsoDate(Q, -1)}&to=${Q}&group=day`);
    expect(range.merged.map((r) => r.provisional)).toEqual([false, true]);

    await rollUp();
    const written = await summary(`branches=${demo}&from=${Q}&to=${Q}`);
    expect(written.merged[0]).toMatchObject({ provisional: false, rolledDays: 1 });
    expect(written.merged[0]!.revenueSatang).toBeGreaterThan(0);

    // A quiet ended day with nothing queued had no sale: final.
    const quiet = addDaysToIsoDate(T, -9);
    expect((await summary(`branches=${demo}&from=${quiet}&to=${quiet}`)).merged[0]).toMatchObject({
      provisional: false,
      rolledDays: 0,
      revenueSatang: 0,
    });
  });
});

describe('fix round — the demo control on a date the old control wrote at Central (finding 6)', () => {
  /**
   * The rows the pre-round-3 control left on `on`: each scenario's sale under
   * its old key (`demo-day/<on>/<scenario>`, id hashed from `<on>/<scenario>`)
   * and the open-cash refund, at `branchId`'s till. Cloned from a real demo
   * day one date earlier, moved a day on.
   */
  async function plantOldDay(on: string, branchId: string, refundNumber: string): Promise<string[]> {
    const src = addDaysToIsoDate(on, -1);
    await seedDemoDay(ctx.db, { on: src });
    const till = await tillAt(branchId);
    const prefix = `demo-day/${src}/${DEMO_BRANCH_CODE}/`;
    const shapes = await ctx.db
      .select()
      .from(sale)
      .where(and(eq(sale.branchId, demo), eq(sale.businessDate, src), like(sale.actionId, `${prefix}%`)));
    expect(shapes).toHaveLength(11);
    const planted: string[] = [];
    let openCash: string | null = null;
    for (const shape of shapes) {
      const key = shape.actionId!.slice(prefix.length);
      const occurredAt = new Date(shape.occurredAt.getTime() + 86_400_000);
      const id = demoStableId(`${on}/${key}`, occurredAt);
      await ctx.db.insert(sale).values({
        ...shape,
        id,
        branchId,
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
      planted.push(id);
      if (key === 'open-cash') openCash = id;
    }
    const [shapeRefund] = await ctx.db
      .select()
      .from(refund)
      .where(and(eq(refund.branchId, demo), eq(refund.actionId, `${prefix}open-cash/refund`)));
    await ctx.db.insert(refund).values({
      ...shapeRefund!,
      id: newId(),
      branchId,
      saleId: openCash!,
      stationId: till,
      number: refundNumber,
      actionId: `demo-day/${on}/open-cash/refund`,
    });
    return planted;
  }

  const salesOn = (branchId: string, on: string) =>
    ctx.db
      .select({ id: sale.id, status: sale.status, stationId: sale.stationId, actionId: sale.actionId })
      .from(sale)
      .where(and(eq(sale.branchId, branchId), eq(sale.businessDate, on)));

  it('writes Demo Branch 2’s own day, counts it honestly, and leaves Central’s old rows alone', async () => {
    const on = addDaysToIsoDate(T, -20);
    const planted = await plantOldDay(on, hkt, 'OLD-DEMO-R-1');
    const centralBefore = await salesOn(hkt, on);
    expect(centralBefore.map((s) => s.id).sort()).toEqual([...planted].sort());

    const counts = await seedDemoDay(ctx.db, { on });
    expect(counts).toMatchObject({ branchCode: DEMO_BRANCH_CODE, sales: 11, skipped: 0 });
    const demoTill = await tillAt(demo);
    const written = await salesOn(demo, on);
    expect(written).toHaveLength(11);
    for (const s of written) {
      expect(s.stationId).toBe(demoTill);
      expect(s.actionId!.startsWith(`demo-day/${on}/${DEMO_BRANCH_CODE}/`)).toBe(true);
    }
    const refunds = await ctx.db
      .select({ branchId: refund.branchId })
      .from(refund)
      .where(eq(refund.actionId, `demo-day/${on}/${DEMO_BRANCH_CODE}/open-cash/refund`));
    expect(refunds).toEqual([{ branchId: demo }]);
    expect(await salesOn(hkt, on)).toEqual(centralBefore);

    // A second press finds the day it wrote — and says so truthfully now.
    expect(await seedDemoDay(ctx.db, { on })).toMatchObject({ sales: 0, attempts: 0, skipped: 11 });
    expect(await salesOn(hkt, on)).toEqual(centralBefore);
  });

  it('a demo day already written at Demo Branch 2 under the old keys is found, not written twice', async () => {
    const on = addDaysToIsoDate(T, -25);
    const planted = await plantOldDay(on, demo, 'OLD-DEMO-R-2');
    const again = await seedDemoDay(ctx.db, { on });
    expect(again).toMatchObject({ sales: 0, skipped: 11 });
    expect((await salesOn(demo, on)).map((s) => s.id).sort()).toEqual([...planted].sort());
  });
});
