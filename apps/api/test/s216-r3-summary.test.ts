import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull, like } from 'drizzle-orm';
import {
  account,
  branch,
  dailySummary,
  hourlySummary,
  opsRun,
  role,
  roleAssignment,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import { DEMO_BRANCH_CODE, DEMO_BRANCH_NAME, DemoBranchRefusedError, seedDemoDay } from '@oto/db/seed';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  sumAnalyticsDayFigures,
  type AnalyticsDayFigures,
  type AnalyticsSummary,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { ROLLUP_DAILY_JOB } from '../src/services/analytics-rollup';

/**
 * S2-15b (SCRUM-216) round 3 — `GET /analytics/summary`, the Health line per
 * park, and the demo control's branch (plan
 * docs/progress/plans/analytics/PLAN.md §5, §8 round 3, §9 questions 9 and
 * 12, hazards H2 and H11).
 *
 * Three OTO parks trade today — Central Floresta and Robinson Chalong through
 * the real till routes, Demo Branch 2 through the Health page's demo control —
 * and the rollup runs from the Health page. Then the summary is read by:
 *
 *   reception        the Today screen's permission at Central only: one park
 *   Khun Lek         a branch manager at Central, given `staff` at Demo
 *                    Branch 2: two parks, never Chalong
 *   the admin        the whole operator: three parks
 *   the second       another operator's administrator: its own branch, and a
 *   operator         404 for any of OTO's
 *
 * and every figure is compared with the `daily_summary` rows the rollup wrote.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let admin: string;
let foreignAdmin: string;
let hkt: string;
let chalong: string;
let demo: string;
let foreign: string;
/** Today, and a day three back that Demo Branch 2 also traded on. */
let T: string;
let P: string;

const get = (cookie: string, query: string) =>
  ctx.app.inject({ method: 'GET', url: `/analytics/summary?${query}`, headers: { cookie } });

async function summary(cookie: string, query: string): Promise<AnalyticsSummary> {
  const res = await get(cookie, query);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AnalyticsSummary;
}

async function post(cookie: string, url: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

/** A cash ticket sale through the till's own routes. */
async function cashSale(cookie: string, stationId: string, packageId: string, kids: number, adults: number) {
  const id = newId();
  const committed = await post(cookie, '/sales', { id, stationId, lines: [{ id: newId(), packageId, kids, adults }] });
  expect(committed.statusCode, committed.body).toBe(200);
  const paid = await post(cookie, `/sales/${id}/finalise`, { actionId: newId(), method: 'cash' });
  expect(paid.statusCode, paid.body).toBe(200);
  return id;
}

async function packageAt(branchId: string, name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: ticketPackage.id })
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, name)));
  return row!.id;
}

async function tillAt(branchId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: station.id })
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.name, 'Reception Till 1')));
  return row!.id;
}

async function rollUp(): Promise<void> {
  const res = await post(admin, '/ops/test-controls/rollup.run');
  expect(res.statusCode, res.body).toBe(200);
}

/** The stored row's figure set — what a summary row must equal. */
async function storedFigures(branchId: string, date: string): Promise<AnalyticsDayFigures & { provisional: boolean; formulaVersion: number; computedAt: Date }> {
  const [row] = await ctx.db
    .select()
    .from(dailySummary)
    .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, date), eq(dailySummary.source, 'oto_pos')));
  expect(row, `a stored day for ${branchId} on ${date}`).toBeDefined();
  return { ...figuresOf(row!), provisional: row!.provisional, formulaVersion: row!.formulaVersion, computedAt: row!.computedAt };
}

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

function figuresOf(row: AnalyticsDayFigures): AnalyticsDayFigures {
  return Object.fromEntries(FIGURE_KEYS.map((k) => [k, row[k]])) as unknown as AnalyticsDayFigures;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  foreign = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, hkt));
  T = businessDate(new Date(), central!.timezone, parseDayStart(central!.businessDayStart));
  P = addDaysToIsoDate(T, -3);

  // Central Floresta: two cash sales at the counter, rung up by reception.
  const hktTill = await tillAt(hkt);
  await takeStation(ctx.app, reception, hktTill);
  await cashSale(reception, hktTill, await packageAt(hkt, '2 Hours Play'), 1, 1);
  await cashSale(reception, hktTill, await packageAt(hkt, '1 Hour Play'), 2, 1);
  // Robinson Chalong: one, by its own manager — figures nobody at Central may read.
  const chalongTill = await tillAt(chalong);
  await takeStation(ctx.app, chalongManager, chalongTill);
  await cashSale(chalongManager, chalongTill, await packageAt(chalong, 'Full Day Pass'), 1, 2);

  // Demo Branch 2: today from the Health page's control, and a day three back.
  const pressed = await post(admin, '/ops/test-controls/demo.day');
  expect(pressed.statusCode, pressed.body).toBe(200);
  expect(pressed.json<{ message: string }>().message).toContain(`at ${DEMO_BRANCH_NAME}`);
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  await seedDemoDay(ctx.db, { on: P });

  await rollUp();

  // Khun Lek, branch manager at Central, is also `staff` at Demo Branch 2:
  // two parks he may read, and Chalong is not one of them.
  const [lek] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  const [staffRole] = await ctx.db.select({ id: role.id }).from(role).where(and(eq(role.name, 'staff'), isNull(role.operatorId)));
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId: lek!.id,
    roleId: staffRole!.id,
    scopeType: 'branch',
    scopeId: demo,
  });
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('S2-15b round 3 — who reads which park', () => {
  it('a one-branch caller reads its own park, on the Today screen’s permission alone', async () => {
    const own = await summary(reception, `from=${T}&to=${T}`);
    expect(own.branches.map((b) => b.branchId)).toEqual([hkt]);
    expect(own.readable.map((b) => b.branchId)).toEqual([hkt]);
    expect(own.omitted).toEqual([]);
    expect(figuresOf(own.merged[0]!)).toEqual(figuresOf(await storedFigures(hkt, T)));
    expect(own.merged[0]!.revenueSatang).toBeGreaterThan(0);

    // Asking for more does not widen it: the others are named and left out.
    const asked = await summary(reception, `branches=${hkt},${chalong},${demo}&from=${T}&to=${T}`);
    expect(asked.branches.map((b) => b.branchId)).toEqual([hkt]);
    expect(asked.omitted).toEqual([chalong, demo]);
    expect(figuresOf(asked.merged[0]!)).toEqual(figuresOf(await storedFigures(hkt, T)));

    // Only parks it may not read: refused, not an empty success.
    expect((await get(reception, `branches=${chalong}&from=${T}&to=${T}`)).statusCode).toBe(403);
  });

  it('a two-branch caller: All branches is the sum of exactly its two parks, never the third', async () => {
    const all = await summary(manager, `from=${T}&to=${T}`);
    expect(all.branches.map((b) => b.branchId).sort()).toEqual([hkt, demo].sort());
    expect(all.readable.map((b) => b.branchId).sort()).toEqual([hkt, demo].sort());
    const both = sumAnalyticsDayFigures([await storedFigures(hkt, T), await storedFigures(demo, T)]);
    expect(figuresOf(all.merged[0]!)).toEqual(figuresOf(both));

    // Chalong traded today, so leaving it out is visible in the total.
    const chalongDay = await storedFigures(chalong, T);
    expect(chalongDay.revenueSatang).toBeGreaterThan(0);
    const everyone = await summary(admin, `from=${T}&to=${T}`);
    expect(everyone.branches).toHaveLength(3);
    expect(everyone.merged[0]!.revenueSatang).toBe(both.revenueSatang + chalongDay.revenueSatang);
    expect(all.merged[0]!.revenueSatang).not.toBe(everyone.merged[0]!.revenueSatang);

    const named = await summary(manager, `branches=${hkt},${demo},${chalong}&from=${T}&to=${T}&group=total`);
    expect(named.omitted).toEqual([chalong]);
    expect(named.branches.map((b) => b.branchId)).toEqual([hkt, demo]);
    expect(figuresOf(named.merged[0]!)).toEqual(figuresOf(both));
    expect(JSON.stringify(named)).not.toContain('"name":"Oto Play Park, Robinson Chalong"');
  });

  it('a branch of another operator is refused, and the other operator sees only its own', async () => {
    expect((await get(admin, `branches=${foreign}&from=${T}&to=${T}`)).statusCode).toBe(404);
    expect((await get(admin, `branches=${hkt},${foreign}&from=${T}&to=${T}`)).statusCode).toBe(404);
    expect((await get(foreignAdmin, `branches=${hkt}&from=${T}&to=${T}`)).statusCode).toBe(404);
    // An id that is no branch at all reads exactly the same.
    expect((await get(admin, `branches=${newId()}&from=${T}&to=${T}`)).statusCode).toBe(404);

    const theirs = await summary(foreignAdmin, `from=${T}&to=${T}`);
    expect(theirs.branches.map((b) => b.branchId)).toEqual([foreign]);
    expect(theirs.readable.map((b) => b.branchId)).toEqual([foreign]);
    const body = JSON.stringify(theirs);
    for (const id of [hkt, chalong, demo]) expect(body).not.toContain(id);
  });

  it('refuses a range backwards, too long, or a list that is not branch ids', async () => {
    expect((await get(admin, `from=${T}&to=${addDaysToIsoDate(T, -1)}`)).statusCode).toBe(400);
    expect((await get(admin, `from=${addDaysToIsoDate(T, -400)}&to=${T}`)).statusCode).toBe(400);
    expect((await get(admin, `branches=central&from=${T}&to=${T}`)).statusCode).toBe(400);
    expect((await get(admin, `from=2026-02-30&to=2026-03-01`)).statusCode).toBe(400);
  });

  it('is in the OpenAPI document, guarded in the handler, and refuses a caller with no session', async () => {
    const docs = await ctx.app.inject({ method: 'GET', url: '/docs/json', headers: { cookie: admin } });
    expect(docs.statusCode).toBe(200);
    const path = (docs.json() as { paths: Record<string, { get?: { description?: string } }> }).paths['/analytics/summary'];
    expect(path?.get?.description).toContain('never the sales tables');
    const entry = ctx.app.routeRegistry.find((r) => r.url === '/analytics/summary' && r.method === 'GET');
    expect(entry?.config.dynamicPermission).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: `/analytics/summary?from=${T}&to=${T}` })).statusCode).toBe(401);
  });
});

describe('S2-15b round 3 — the figures are the rolled rows', () => {
  it('each park’s row is its stored day, field by field, and its hours add up to the merged day', async () => {
    const all = await summary(admin, `from=${T}&to=${T}`);
    for (const b of all.branches) {
      const stored = await storedFigures(b.branchId, T);
      const row = b.rows[0]!;
      expect(figuresOf(row)).toEqual(figuresOf(stored));
      expect(row.provisional).toBe(stored.provisional);
      expect(row.formulaVersion).toBe(stored.formulaVersion);
      expect(row.computedAt).toBe(stored.computedAt.toISOString());
      expect(row.rolledDays).toBe(1);
    }
    expect(figuresOf(all.merged[0]!)).toEqual(figuresOf(sumAnalyticsDayFigures(all.branches.map((b) => b.rows[0]!))));
    // The demo day's stays are sold under the demo branch's own packages, so
    // its ticket mix is counted like a real sale's.
    const demoRow = all.branches.find((b) => b.branchId === demo)!.rows[0]!;
    expect(demoRow.mix2h).toBeGreaterThan(0);
    expect(demoRow.mixFullDay).toBeGreaterThan(0);

    const hours = all.hours!;
    expect(hours.length).toBeGreaterThan(0);
    expect(hours.reduce((s, h) => s + h.revenueSatang, 0)).toBe(all.merged[0]!.revenueSatang);
    expect(hours.reduce((s, h) => s + h.txnCount, 0)).toBe(all.merged[0]!.txnCount);
    const stored = await ctx.db.select().from(hourlySummary).where(eq(hourlySummary.businessDate, T));
    const ours = stored.filter((h) => [hkt, chalong, demo].includes(h.branchId));
    expect(hours.reduce((s, h) => s + h.revenueSatang, 0)).toBe(ours.reduce((s, h) => s + h.revenueSatang, 0));
  });

  it('reads the summaries, not the sales: a sale shows only once the rollup has run', async () => {
    const before = await summary(reception, `from=${T}&to=${T}`);
    const till = await tillAt(hkt);
    await cashSale(reception, till, await packageAt(hkt, '2 Hours Play'), 1, 1);
    const unrolled = await summary(reception, `from=${T}&to=${T}`);
    expect(figuresOf(unrolled.merged[0]!)).toEqual(figuresOf(before.merged[0]!));
    await rollUp();
    const rolled = await summary(reception, `from=${T}&to=${T}`);
    expect(rolled.merged[0]!.txnCount).toBe(before.merged[0]!.txnCount + 1);
    expect(figuresOf(rolled.merged[0]!)).toEqual(figuresOf(await storedFigures(hkt, T)));
  });

  it('by day and in total over a range: zero-filled days, one total equal to the days', async () => {
    const byDay = await summary(admin, `branches=${demo},${hkt}&from=${P}&to=${T}&group=day`);
    expect(byDay.merged.map((r) => r.businessDate)).toEqual([P, addDaysToIsoDate(P, 1), addDaysToIsoDate(P, 2), T]);
    expect(byDay.hours).toBeNull();
    const demoRows = byDay.branches.find((b) => b.branchId === demo)!.rows;
    expect(figuresOf(demoRows[0]!)).toEqual(figuresOf(await storedFigures(demo, P)));
    expect(demoRows[1]).toMatchObject({ rolledDays: 0, revenueSatang: 0, provisional: false, computedAt: null, formulaVersion: null });

    const total = await summary(admin, `branches=${demo},${hkt}&from=${P}&to=${T}&group=total`);
    expect(total.merged).toHaveLength(1);
    expect(total.merged[0]!.businessDate).toBeNull();
    expect(figuresOf(total.merged[0]!)).toEqual(figuresOf(sumAnalyticsDayFigures(byDay.merged)));
    expect(total.merged[0]!.rolledDays).toBe(3); // Demo on P and today, Central today
    // The two demo days are the same scenarios, so the total is twice one of them plus Central.
    const demoP = await storedFigures(demo, P);
    expect(total.merged[0]!.revenueSatang).toBe(
      demoP.revenueSatang + (await storedFigures(demo, T)).revenueSatang + (await storedFigures(hkt, T)).revenueSatang,
    );
  });
});

describe('S2-15b round 3 — provisional, and how fresh', () => {
  it('today is provisional; a rolled past day is final; a day with no sale reads as zero and final', async () => {
    const today = await summary(admin, `branches=${demo}&from=${T}&to=${T}`);
    expect(today.merged[0]!.provisional).toBe(true);
    expect(today.branches[0]!.today).toBe(T);

    const past = await summary(admin, `branches=${demo}&from=${P}&to=${P}`);
    expect(past.merged[0]!).toMatchObject({ provisional: false, rolledDays: 1, formulaVersion: 1 });
    expect(past.merged[0]!.revenueSatang).toBeGreaterThan(0);

    const quiet = addDaysToIsoDate(T, -10);
    const nothing = await summary(admin, `branches=${hkt}&from=${quiet}&to=${quiet}`);
    expect(nothing.merged[0]!).toMatchObject({ provisional: false, rolledDays: 0, revenueSatang: 0, txnCount: 0 });

    // A range reaching today is still moving.
    const range = await summary(admin, `branches=${demo}&from=${P}&to=${T}&group=total`);
    expect(range.merged[0]!.provisional).toBe(true);
  });

  it('each park says when the rollup last brought it up to date: the newest successful run', async () => {
    const [run] = await ctx.db
      .select({ startedAt: opsRun.startedAt })
      .from(opsRun)
      .where(and(eq(opsRun.name, ROLLUP_DAILY_JOB), eq(opsRun.outcome, 'ok')))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    expect(run).toBeDefined();
    const all = await summary(admin, `from=${T}&to=${T}`);
    for (const b of all.branches) expect(b.lastRolledUpAt).toBe(run!.startedAt.toISOString());
    expect(all.lastRolledUpAt).toBe(run!.startedAt.toISOString());
  });

  it('Health lists the last rollup per park, for the parks in the caller’s reach only', async () => {
    const estate = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: admin } });
    expect(estate.statusCode, estate.body).toBe(200);
    const rollups = estate.json<{ rollups: Array<{ branchId: string; name: string; today: string; lastRolledUpAt: string | null }> }>().rollups;
    expect(rollups.map((r) => r.branchId).sort()).toEqual([hkt, chalong, demo].sort());
    for (const r of rollups) {
      expect(r.lastRolledUpAt).not.toBeNull();
      expect(r.today).toBe(T);
    }
    expect(rollups.find((r) => r.branchId === demo)!.name).toBe(DEMO_BRANCH_NAME);

    // Khun Lek reads Health at Central (his `staff` grant at the demo branch carries no Health).
    const own = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: manager } });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json<{ rollups: Array<{ branchId: string }> }>().rollups.map((r) => r.branchId)).toEqual([hkt]);
  });
});

describe('S2-15b round 3 — the demo control never writes to a live park (H11)', () => {
  it('wrote every demo sale at Demo Branch 2, says so, and offers no live park', async () => {
    const demoSales = await ctx.db.select({ branchId: sale.branchId }).from(sale).where(like(sale.actionId, 'demo-day/%'));
    expect(demoSales.length).toBe(22); // eleven today, eleven three days back
    expect(new Set(demoSales.map((s) => s.branchId))).toEqual(new Set([demo]));

    const listed = await ctx.app.inject({ method: 'GET', url: '/ops/test-controls', headers: { cookie: admin } });
    const control = listed.json<{ controls: Array<{ key: string; label: string; description: string }> }>().controls.find((c) => c.key === 'demo.day')!;
    expect(control.label).toBe('Add demo sales to Demo Branch 2 (today)');
    expect(`${control.label} ${control.description}`).not.toMatch(/Central|Chalong/);
  });

  it('refuses a live park by name, before anything is written', async () => {
    const before = await ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.branchId, hkt));
    for (const code of [CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE]) {
      await expect(seedDemoDay(ctx.db, { on: addDaysToIsoDate(T, -20), branchCode: code })).rejects.toBeInstanceOf(DemoBranchRefusedError);
    }
    const after = await ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.branchId, hkt));
    expect(after.length).toBe(before.length);
    const [count] = await ctx.db.select({ id: sale.id }).from(sale).where(like(sale.actionId, `demo-day/${addDaysToIsoDate(T, -20)}/%`));
    expect(count).toBeUndefined();
  });

  it('pressed again, adds nothing and still names the demo branch', async () => {
    const again = await post(admin, '/ops/test-controls/demo.day');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<{ message: string }>().message).toMatch(new RegExp(`at ${DEMO_BRANCH_NAME}: 0 sales added, 11 already present`));
  });
});
