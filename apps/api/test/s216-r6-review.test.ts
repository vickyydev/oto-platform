import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, ne, sql } from 'drizzle-orm';
import { account, auditLog, branch, branchSourceSwitch, dailySummary } from '@oto/db';
import { DEMO_BRANCH_CODE, LEGACY_FIXTURE_DAYS, seedDemoDay, seedLegacyFixtureDays } from '@oto/db/seed';
import {
  addDaysToIsoDate,
  businessDate,
  parseDayStart,
  type AnalyticsDayFigures,
  type AnalyticsSummary,
  type BranchSource,
  type BranchSources,
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
  teardownAll,
  type TestContext,
} from './helpers';
import {
  rollupDailyBranchDay,
  rollupHourlyBranchDay,
  runDailyRollupJob,
  runHourlyRollupJob,
  type RollupBranchClock,
} from '../src/services/analytics-rollup';

/**
 * S2-15b (SCRUM-216) round 6 — the reviewer's own attack on the round
 * (plan docs/progress/plans/analytics/PLAN.md §5, §7, §8 round 6, §10 H10).
 *
 *   the switch   flipped to a legacy source and back, the summary follows it
 *                every time; a live park switched to a source it never ran
 *                gets none of the demo branch's frozen days; every change is
 *                audited once with a chained before/after, a no-op and a
 *                replay are not; a key reused with another body is refused;
 *                five switches at once are applied one after another; every
 *                caller without admin:branch:update is refused and another
 *                operator's branch is a 404 from either side
 *   the guards   every /analytics route declares a guard, refuses a signed-out
 *                caller, refuses a caller without analytics:read, and answers
 *                404 for another operator's branch
 *   H10          the loader and every rollup path, twice over, with real sales
 *                landing beside and on the frozen days and the demo reset in
 *                between: the frozen rows keep their bytes, their xmin and
 *                their ctid; a frozen row deleted by hand comes back the same
 *                bytes from the fixture alone
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let chalongManager: string;
let reception: string;
let foreignAdmin: string;
let adminId: string;
let operatorId: string;
let hkt: string;
let chalong: string;
let demo: string;
let foreignBranch: string;
let T: string;

const PISELL = LEGACY_FIXTURE_DAYS.find((d) => d.source === 'pisell')!;
const PAPAYA = LEGACY_FIXTURE_DAYS.find((d) => d.source === 'papaya')!;

const FIGURES = [
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

const figuresOf = (row: AnalyticsDayFigures): Record<string, unknown> =>
  Object.fromEntries(FIGURES.map((k) => [k, row[k]]));

const ZERO = Object.fromEntries(FIGURES.map((k) => [k, k === 'byChannel' ? {} : 0]));

const get = (cookie: string | null, url: string) =>
  ctx.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

const put = (cookie: string | null, branchId: string, payload: Record<string, unknown>, key?: string) =>
  ctx.app.inject({
    method: 'PUT',
    url: `/analytics/sources/${branchId}`,
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  });

async function summary(cookie: string, query: string): Promise<AnalyticsSummary> {
  const res = await get(cookie, `/analytics/summary?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AnalyticsSummary;
}

async function switchTo(branchId: string, source: BranchSource['source'], preference: BranchSource['preference']) {
  const res = await put(admin, branchId, { source, preference });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as BranchSource & { changed: boolean };
}

async function rollUp(): Promise<void> {
  const res = await ctx.app.inject({ method: 'POST', url: '/ops/test-controls/rollup.run', headers: { cookie: admin } });
  expect(res.statusCode, res.body).toBe(200);
}

async function switchAudit(branchId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'analytics.branch_source.switch'), eq(auditLog.entityId, branchId)));
}

/** Every non-platform row as Postgres holds it: the row's text, the version that wrote it, and where it sits. */
async function legacyAsStored() {
  const { rows } = await ctx.db.execute<{ id: string; xmin: string; ctid: string; bytes: string }>(sql`
    select d.id::text as id, d.xmin::text as xmin, d.ctid::text as ctid, d::text as bytes
      from analytics.daily_summary d
     where d.source <> 'oto_pos'
     order by d.id`);
  return rows;
}

async function platformDay(branchId: string, date: string) {
  const [row] = await ctx.db
    .select()
    .from(dailySummary)
    .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, date), eq(dailySummary.source, 'oto_pos')));
  return row ?? null;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [a] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  adminId = a!.id;
  const [r] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  operatorId = r!.operatorId;
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  foreignBranch = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, hkt));
  T = businessDate(new Date(), central!.timezone, parseDayStart(central!.businessDayStart));

  // The Health page's demo control: today's demo sales and the two frozen days.
  const pressed = await ctx.app.inject({ method: 'POST', url: '/ops/test-controls/demo.day', headers: { cookie: admin } });
  expect(pressed.statusCode, pressed.body).toBe(200);
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  await rollUp();
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- The switch -----------------------------------------------------------------------------

describe('review — the source switch drives the summary, and only the right people move it', () => {
  it('flipped to pisell and back, the summary follows each time, and each change is audited once', async () => {
    const pisellRange = `branches=${demo}&from=${PISELL.businessDate}&to=${PAPAYA.businessDate}&group=day`;
    const platformToday = (await platformDay(demo, T))!;
    expect(platformToday.revenueSatang).toBeGreaterThan(0);

    // Never switched: the platform's own day, and nothing on the fixture days.
    const before = await summary(admin, pisellRange);
    expect(before.source).toBe('oto_pos');
    expect(before.branches[0]!.rows.map(figuresOf)).toEqual([ZERO, ZERO]);

    // To Pisell, under a key.
    const first = await put(admin, demo, { source: 'pisell', preference: 'legacy' }, 'review-r6-flip-1');
    expect(first.statusCode, first.body).toBe(200);
    const flipped = first.json() as BranchSource & { changed: boolean };
    expect(flipped).toMatchObject({ source: 'pisell', preference: 'legacy', actorAccountId: adminId, changed: true });

    const onPisell = await summary(admin, pisellRange);
    expect(onPisell.source).toBe('pisell');
    expect(onPisell.branches[0]!.source).toBe('pisell');
    expect(figuresOf(onPisell.branches[0]!.rows[0]!)).toEqual(figuresOf(PISELL.figures));
    expect(onPisell.branches[0]!.rows[0]).toMatchObject({ formulaVersion: 30, provisional: false });
    // The Papaya day is not Pisell's: zero, final.
    expect(figuresOf(onPisell.branches[0]!.rows[1]!)).toEqual(ZERO);
    expect(onPisell.branches[0]!.rows[1]!.provisional).toBe(false);
    // Today the branch traded on the platform, but it reports Pisell: nothing, no hours.
    const todayOnPisell = await summary(admin, `branches=${demo}&from=${T}&to=${T}`);
    expect(figuresOf(todayOnPisell.merged[0]!)).toEqual(ZERO);
    expect(todayOnPisell.hours).toEqual([]);

    // Replayed: the same answer, no second switch, no second audit row.
    const replay = await put(admin, demo, { source: 'pisell', preference: 'legacy' }, 'review-r6-flip-1');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(flipped);
    // The same key with another body: refused, nothing moves.
    const misuse = await put(admin, demo, { source: 'papaya', preference: 'legacy' }, 'review-r6-flip-1');
    expect(misuse.statusCode, misuse.body).toBe(409);
    expect((await summary(admin, pisellRange)).source).toBe('pisell');
    // A no-op: changed false, the first switch's time and actor kept.
    expect(await switchTo(demo, 'pisell', 'legacy')).toMatchObject({ changed: false, switchedAt: flipped.switchedAt });
    expect(await switchAudit(demo)).toHaveLength(1);

    // And back to the platform: today's own row again, the fixture days empty.
    const back = await switchTo(demo, 'oto_pos', 'oto_pos');
    expect(back.changed).toBe(true);
    const onPlatform = await summary(admin, pisellRange);
    expect(onPlatform.source).toBe('oto_pos');
    expect(onPlatform.branches[0]!.rows.map(figuresOf)).toEqual([ZERO, ZERO]);
    expect(figuresOf((await summary(admin, `branches=${demo}&from=${T}&to=${T}`)).merged[0]!)).toEqual(
      figuresOf(platformToday),
    );

    const trail = await switchAudit(demo);
    expect(trail).toHaveLength(2);
    const byBefore = new Map(trail.map((t) => [(t.before as BranchSource).source, t]));
    expect(byBefore.get('oto_pos')!.after).toMatchObject({ source: 'pisell', preference: 'legacy', actorAccountId: adminId });
    expect(byBefore.get('pisell')!.after).toMatchObject({ source: 'oto_pos', preference: 'oto_pos', actorAccountId: adminId });
    for (const t of trail) expect(t).toMatchObject({ actorAccountId: adminId, operatorId, branchId: demo, entityType: 'branch_source_switch' });
    // One row per branch, whatever was switched.
    expect(await ctx.db.select().from(branchSourceSwitch).where(eq(branchSourceSwitch.branchId, demo))).toHaveLength(1);
  });

  it('a live park switched to a source it never ran serves none of another branch’s frozen days', async () => {
    await switchTo(chalong, 'pisell', 'legacy');
    try {
      const own = await summary(admin, `branches=${chalong}&from=${PISELL.businessDate}&to=${PAPAYA.businessDate}&group=day`);
      expect(own.branches[0]!.source).toBe('pisell');
      expect(own.branches[0]!.rows.map(figuresOf)).toEqual([ZERO, ZERO]);
      expect(own.branches[0]!.lastRolledUpAt).toBeNull();
      // Beside the demo branch on Pisell too: the total is the demo branch's frozen day alone.
      await switchTo(demo, 'pisell', 'legacy');
      const both = await summary(admin, `branches=${chalong},${demo}&from=${PISELL.businessDate}&to=${PISELL.businessDate}&group=total`);
      expect(both.source).toBe('pisell');
      expect(figuresOf(both.merged[0]!)).toEqual(figuresOf(PISELL.figures));
      // Beside Central on the platform: mixed, so no single source, and the total still only the frozen day.
      const mixed = await summary(admin, `branches=${hkt},${demo}&from=${PISELL.businessDate}&to=${PISELL.businessDate}&group=total`);
      expect(mixed.source).toBeNull();
      const centralThen = await platformDay(hkt, PISELL.businessDate);
      expect(mixed.merged[0]!.revenueSatang).toBe(PISELL.figures.revenueSatang + (centralThen?.revenueSatang ?? 0));
      expect(mixed.merged[0]!.txnCount).toBe(PISELL.figures.txnCount + (centralThen?.txnCount ?? 0));
    } finally {
      await switchTo(chalong, 'oto_pos', 'oto_pos');
      await switchTo(demo, 'oto_pos', 'oto_pos');
    }
  });

  it('five switches at once are applied one after another: one row, five audit rows in one unbroken chain', async () => {
    const asks: Array<{ source: BranchSource['source']; preference: BranchSource['preference'] }> = [
      { source: 'pisell', preference: 'legacy' },
      { source: 'papaya', preference: 'legacy' },
      { source: 'pisell', preference: 'both' },
      { source: 'papaya', preference: 'both' },
      { source: 'oto_pos', preference: 'both' },
    ];
    const seen = new Set((await switchAudit(demo)).map((t) => t.id));
    const answers = await Promise.all(asks.map((ask) => put(admin, demo, ask)));
    for (const res of answers) expect(res.statusCode, res.body).toBe(200);
    // Every ask differs from every other and from where the branch stood, so each changed it.
    expect(answers.map((r) => (r.json() as { changed: boolean }).changed)).toEqual([true, true, true, true, true]);
    const rows = await ctx.db.select().from(branchSourceSwitch).where(eq(branchSourceSwitch.branchId, demo));
    expect(rows).toHaveLength(1);

    const recent = (await switchAudit(demo)).filter((t) => !seen.has(t.id));
    expect(recent).toHaveLength(5);
    // Walk the chain from where the branch stood (oto_pos / oto_pos): each step's
    // "before" is exactly the state the previous step left. Two switches that
    // read the same "before" would leave a fork, and the walk would stop short.
    const key = (s: { source: string; preference: string }) => `${s.source}/${s.preference}`;
    const states = new Map(recent.map((t) => [key(t.before as BranchSource), key(t.after as BranchSource)]));
    expect(states.size).toBe(5);
    let at = 'oto_pos/oto_pos';
    const walked: string[] = [];
    while (states.has(at)) {
      at = states.get(at)!;
      walked.push(at);
    }
    expect(walked).toHaveLength(5);
    expect(new Set(walked)).toEqual(new Set(asks.map(key)));
    expect(key(rows[0]!)).toBe(walked[walked.length - 1]);
    await switchTo(demo, 'oto_pos', 'oto_pos');
  });

  it('refuses every caller without admin:branch:update, and another operator’s branch is a 404 from either side', async () => {
    const stood = await ctx.db.select().from(branchSourceSwitch).orderBy(branchSourceSwitch.branchId);
    const auditBefore = (await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'analytics.branch_source.switch'))).length;
    const ask = { source: 'papaya', preference: 'legacy' };

    expect((await put(null, demo, ask)).statusCode).toBe(401);
    expect((await put(reception, hkt, ask)).statusCode).toBe(403);
    expect((await put(manager, hkt, ask)).statusCode).toBe(403);
    expect((await put(manager, demo, ask)).statusCode).toBe(403);
    expect((await put(chalongManager, chalong, ask)).statusCode).toBe(403);
    // Another operator's administrator on OTO's park, and OTO's on theirs.
    expect((await put(foreignAdmin, demo, ask)).statusCode).toBe(404);
    expect((await put(foreignAdmin, hkt, ask)).statusCode).toBe(404);
    expect((await put(admin, foreignBranch, ask)).statusCode).toBe(404);
    // No such branch anywhere, and nonsense in the body.
    expect((await put(admin, '0192f000-0000-7000-8000-0000000000ff', ask)).statusCode).toBe(404);
    expect((await put(admin, demo, { source: 'oto_pos' })).statusCode).toBe(400);
    expect((await put(admin, demo, { ...ask, source: 'radar' })).statusCode).toBe(400);

    expect(await ctx.db.select().from(branchSourceSwitch).orderBy(branchSourceSwitch.branchId)).toEqual(stood);
    expect((await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'analytics.branch_source.switch'))).length).toBe(
      auditBefore,
    );

    // The other operator switches its own park, and it never shows in OTO's list.
    const theirs = await put(foreignAdmin, foreignBranch, { source: 'papaya', preference: 'both' });
    expect(theirs.statusCode, theirs.body).toBe(200);
    const listed = (await get(admin, '/analytics/sources')).json() as BranchSources;
    expect(listed.branches.map((b) => b.branchId)).not.toContain(foreignBranch);
    expect(listed.branches.every((b) => b.source === 'oto_pos')).toBe(true);
    const theirList = (await get(foreignAdmin, '/analytics/sources')).json() as BranchSources;
    expect(theirList.branches.map((b) => [b.branchId, b.source])).toEqual([[foreignBranch, 'papaya']]);
    expect((await get(foreignAdmin, `/analytics/sources?branches=${hkt}`)).statusCode).toBe(404);
    expect((await get(reception, '/analytics/sources')).statusCode).toBe(403);
  });
});

// --- Every analytics route guarded --------------------------------------------------------

describe('review — every /analytics route is guarded per branch', () => {
  it('declares a guard, refuses a signed-out caller, a caller without analytics:read, and another operator’s branch', async () => {
    const routes = ctx.app.routeRegistry.filter((r) => r.url.startsWith('/analytics') && r.method !== 'HEAD');
    const urls = routes.map((r) => `${r.method} ${r.url}`).sort();
    expect(urls).toEqual(
      [
        'GET /analytics/booths',
        'GET /analytics/booths/export',
        'GET /analytics/reports/discounts',
        'GET /analytics/reports/discounts/transactions',
        'GET /analytics/reports/profitability',
        'GET /analytics/reports/sales',
        'GET /analytics/reports/tax/receipts',
        'GET /analytics/reports/tax/vat',
        'GET /analytics/sources',
        'GET /analytics/summary',
        'PUT /analytics/sources/:branchId',
      ].sort(),
    );
    for (const r of routes) {
      expect(r.config.public, r.url).toBeUndefined();
      expect(r.config.auth, r.url).toBeUndefined();
      expect(Boolean(r.config.permission) || r.config.dynamicPermission === true, r.url).toBe(true);
    }

    const reads = routes.filter((r) => r.method === 'GET');
    const range = `from=${T}&to=${T}`;
    for (const r of reads) {
      const url = r.url;
      expect((await get(null, `${url}?branches=${hkt}&${range}`)).statusCode, url).toBe(401);
      expect((await get(admin, `${url}?branches=${foreignBranch}&${range}`)).statusCode, url).toBe(404);
      // Chalong: reception holds nothing there at all.
      expect((await get(reception, `${url}?branches=${chalong}&${range}`)).statusCode, url).toBe(403);
      if (url === '/analytics/summary') {
        // The Today screen's permission opens Central on its own, never into a total.
        expect((await get(reception, `${url}?branches=${hkt}&${range}`)).statusCode, url).toBe(200);
        const pair = await summary(reception, `branches=${hkt},${chalong}&${range}`);
        expect(pair.branches.map((b) => b.branchId)).toEqual([hkt]);
        expect(pair.omitted).toEqual([chalong]);
      } else {
        // Everything else asks analytics:read, which reception holds nowhere.
        const refused = await get(reception, `${url}?branches=${hkt}&${range}`);
        expect(refused.statusCode, `${url} ${refused.body}`).toBe(403);
        // Khun Lek holds it at Central only: Chalong is never in his answer.
        const his = await get(manager, `${url}?branches=${chalong}&${range}`);
        expect(his.statusCode, url).toBe(403);
      }
    }
  });
});

// --- H10, for real --------------------------------------------------------------------------

describe('review — H10: the frozen legacy days never move', () => {
  it('H10 — two rounds of loader and every rollup path, real sales beside and on the frozen days, a demo reset between: same bytes, same xmin, same ctid', async () => {
    const before = await legacyAsStored();
    expect(before.map((r) => r.bytes.includes(demo))).toEqual([true, true]);
    expect(before).toHaveLength(2);
    const [pisellRow] = await ctx.db.select().from(dailySummary).where(eq(dailySummary.source, 'pisell'));
    const [papayaRow] = await ctx.db.select().from(dailySummary).where(eq(dailySummary.source, 'papaya'));
    expect(pisellRow).toMatchObject({ frozen: true, provisional: false, formulaVersion: 30, branchId: demo, businessDate: PISELL.businessDate });
    expect(papayaRow).toMatchObject({ frozen: true, provisional: false, formulaVersion: 21, branchId: demo, businessDate: PAPAYA.businessDate });
    expect(figuresOf(pisellRow!)).toEqual(figuresOf(PISELL.figures));
    expect(figuresOf(papayaRow!)).toEqual(figuresOf(PAPAYA.figures));

    const clock: RollupBranchClock = { id: demo, operatorId, timezone: 'Asia/Bangkok', dayStartMinutes: parseDayStart('05:00'), live: true };
    const adjacent = [addDaysToIsoDate(PISELL.businessDate, -1), addDaysToIsoDate(PAPAYA.businessDate, 1)];
    const rounds: string[][] = [adjacent, [PISELL.businessDate, PAPAYA.businessDate]];

    for (const [round, dates] of rounds.entries()) {
      // The loader, three ways, twice.
      for (let i = 0; i < 2; i++) {
        expect(await seedLegacyFixtureDays(ctx.db, { id: demo, operatorId })).toBe(0);
        expect((await seedDemoDay(ctx.db)).legacyFixtureDays).toBe(0);
      }
      // Real sales at the demo branch on this round's days: adjacent first, then
      // the frozen days themselves.
      for (const on of dates) {
        const day = await seedDemoDay(ctx.db, { on });
        expect(day.legacyFixtureDays).toBe(0);
        expect(day.sales, `${round} ${on}`).toBe(11);
      }
      // Every day near the fixtures marked late, both kinds.
      for (const date of [...adjacent, PISELL.businessDate, PAPAYA.businessDate]) {
        for (const kind of ['sales', 'hourly'] as const) {
          await ctx.db.execute(
            sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${demo}::uuid, ${date}::date, ${kind}, 'review-h10')`,
          );
        }
      }
      // Every rollup path, twice.
      for (let i = 0; i < 2; i++) {
        await rollUp();
        await runDailyRollupJob(ctx.db, new Date());
        await runHourlyRollupJob(ctx.db, new Date());
        for (const date of [PISELL.businessDate, PAPAYA.businessDate, ...adjacent]) {
          await rollupDailyBranchDay(ctx.db, clock, date, new Date());
          await rollupHourlyBranchDay(ctx.db, clock, date, new Date());
        }
      }
      // The rollup did write this round's real days.
      for (const on of dates) {
        const own = await platformDay(demo, on);
        expect(own, `${round} ${on}`).not.toBeNull();
        expect(own!.txnCount, `${round} ${on}`).toBeGreaterThan(0);
        expect(own!.formulaVersion).toBe(1);
        expect(own!.frozen).toBe(false);
      }
      expect(await legacyAsStored(), `round ${round}`).toEqual(before);
    }

    // The demo reset deletes every sale; the rollup then empties the platform's
    // own days there. The frozen days are not facts and are not touched.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/ops/demo-reset',
      headers: { cookie: admin },
      payload: { confirm: 'RESET DEMO DATA' },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    await rollUp();
    await runDailyRollupJob(ctx.db, new Date());
    expect((await platformDay(demo, PISELL.businessDate))!.txnCount).toBe(0);
    expect(await legacyAsStored()).toEqual(before);

    // The summary serves the frozen day as stored, and the read moves nothing.
    await switchTo(demo, 'papaya', 'legacy');
    const served = await summary(admin, `branches=${demo}&from=${PAPAYA.businessDate}&to=${PAPAYA.businessDate}`);
    expect(figuresOf(served.merged[0]!)).toEqual(figuresOf(PAPAYA.figures));
    expect(served.branches[0]!.lastRolledUpAt).toBe(PAPAYA.importedAt);
    await switchTo(demo, 'oto_pos', 'oto_pos');
    expect(await legacyAsStored()).toEqual(before);

    // Written from the fixture alone: a frozen row deleted by hand comes back
    // byte for byte (a new row version, the same row).
    await ctx.db.delete(dailySummary).where(and(eq(dailySummary.branchId, demo), eq(dailySummary.source, 'papaya')));
    expect(await seedLegacyFixtureDays(ctx.db, { id: demo, operatorId })).toBe(1);
    const reloaded = await legacyAsStored();
    expect(reloaded.map((r) => [r.id, r.bytes])).toEqual(before.map((r) => [r.id, r.bytes]));
    // Never anywhere but the demo branch.
    expect(
      (await ctx.db.select({ branchId: dailySummary.branchId }).from(dailySummary).where(ne(dailySummary.source, 'oto_pos'))).every(
        (r) => r.branchId === demo,
      ),
    ).toBe(true);
  });
});
