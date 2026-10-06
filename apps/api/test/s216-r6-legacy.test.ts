import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  account,
  auditLog,
  branch,
  branchSourceSwitch,
  dailySummary,
  dirtyDate,
  opsRun,
  role,
  roleAssignment,
  rolePermission,
  station,
  ticketPackage,
} from '@oto/db';
import {
  DEMO_BRANCH_CODE,
  LEGACY_FIXTURE_DAYS,
  legacyFixtureFingerprint,
  seedDemoDay,
  seedLegacyFixtureDays,
  type LegacyFixtureDay,
} from '@oto/db/seed';
import {
  AnalyticsSummarySchema,
  businessDate,
  newId,
  parseDayStart,
  type AnalyticsDayFigures,
  type AnalyticsSummary,
  type BranchSource,
  type BranchSources,
  type Permission,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { ROLLUP_DAILY_JOB, ROLLUP_HOURLY_JOB, runDailyRollupJob, runHourlyRollupJob } from '../src/services/analytics-rollup';
import { ROLLUP_BOOTH_JOB } from '../src/services/analytics-booth';

/**
 * S2-15b (SCRUM-216) round 6 — the frozen legacy days, the source switch, and
 * the closing sweep's checks (plan docs/progress/plans/analytics/PLAN.md §5,
 * §7, §8 round 6, §9 question 9, §10 hazards H1, H2, H10, H14).
 *
 *   H10        the demo day loads two frozen days at Demo Branch 2 (Pisell,
 *              Papaya); re-running the loader and every rollup leaves them
 *              the same bytes, never rewritten
 *   the switch which source a branch reports: read per branch on
 *              analytics:read, written on admin:branch:update, recorded with
 *              who and when and audited; it decides which rows the summary
 *              serves, and an unpermitted branch stays omitted
 *   question 9 a total of several branches adds up only those held on
 *              analytics:read; the Today screen's permission opens one alone
 *   H1, H14    a merge carries each branch's own day start; no member field
 *              in the summary, counts only in the rollup's records
 *   Health     the day, the report rows and the booth fact each have a line
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let foreignAdmin: string;
let adminId: string;
let receptionId: string;
let operatorId: string;
let hkt: string;
let chalong: string;
let demo: string;
let T: string;

const PISELL = LEGACY_FIXTURE_DAYS.find((d) => d.source === 'pisell')!;
const PAPAYA = LEGACY_FIXTURE_DAYS.find((d) => d.source === 'papaya')!;

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

const figuresOf = (row: AnalyticsDayFigures): AnalyticsDayFigures =>
  Object.fromEntries(FIGURE_KEYS.map((k) => [k, row[k]])) as unknown as AnalyticsDayFigures;

const ZERO: AnalyticsDayFigures = figuresOf({
  ...Object.fromEntries(FIGURE_KEYS.map((k) => [k, 0])),
  byChannel: {},
} as unknown as AnalyticsDayFigures);

const get = (cookie: string, url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

async function summary(cookie: string, query: string): Promise<AnalyticsSummary> {
  const res = await get(cookie, `/analytics/summary?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AnalyticsSummary;
}

const put = (cookie: string, branchId: string, payload: unknown, key?: string) =>
  ctx.app.inject({
    method: 'PUT',
    url: `/analytics/sources/${branchId}`,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    payload: payload as Record<string, unknown>,
  });

async function switchTo(branchId: string, source: BranchSource['source'], preference: BranchSource['preference'] = 'oto_pos') {
  const res = await put(admin, branchId, { source, preference });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as BranchSource & { changed: boolean };
}

async function post(cookie: string, url: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

async function rollUp(): Promise<void> {
  const res = await post(admin, '/ops/test-controls/rollup.run');
  expect(res.statusCode, res.body).toBe(200);
}

/** The platform's own stored day at a branch. */
async function platformDay(branchId: string, date: string) {
  const [row] = await ctx.db
    .select()
    .from(dailySummary)
    .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, date), eq(dailySummary.source, 'oto_pos')));
  return row;
}

/** Every legacy row, as Postgres holds it: its bytes and the version it was last written in. */
async function legacyRowsAsStored() {
  const { rows } = await ctx.db.execute<{ id: string; xmin: string; bytes: string }>(
    sql`select d.id::text as id, d.xmin::text as xmin, d::text as bytes
          from analytics.daily_summary d
         where d.source <> 'oto_pos'
         order by d.id`,
  );
  return rows;
}

async function grant(accountId: string, roleId: string, branchId: string): Promise<string> {
  const id = newId();
  await ctx.db.insert(roleAssignment).values({ id, accountId, roleId, scopeType: 'branch', scopeId: branchId });
  return id;
}

async function operatorRole(name: string, permissions: Permission[]): Promise<string> {
  const id = newId();
  await ctx.db.insert(role).values({ id, operatorId, name });
  for (const permission of permissions) await ctx.db.insert(rolePermission).values({ id: newId(), roleId: id, permission });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [a] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  const [r] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  adminId = a!.id;
  receptionId = r!.id;
  operatorId = r!.operatorId;
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, hkt));
  T = businessDate(new Date(), central!.timezone, parseDayStart(central!.businessDayStart));

  // Central Floresta trades today through the till.
  const [till] = await ctx.db
    .select({ id: station.id })
    .from(station)
    .where(and(eq(station.branchId, hkt), eq(station.name, 'Reception Till 1')));
  const [pkg] = await ctx.db
    .select({ id: ticketPackage.id })
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, hkt), eq(ticketPackage.name, '2 Hours Play')));
  await takeStation(ctx.app, reception, till!.id);
  const saleId = newId();
  const committed = await post(reception, '/sales', { id: saleId, stationId: till!.id, lines: [{ id: newId(), packageId: pkg!.id, kids: 1, adults: 1 }] });
  expect(committed.statusCode, committed.body).toBe(200);
  const paid = await post(reception, `/sales/${saleId}/finalise`, { actionId: newId(), method: 'cash' });
  expect(paid.statusCode, paid.body).toBe(200);

  // Demo Branch 2: the Health page's demo control — today's sales, and the
  // frozen legacy days loaded beside them.
  const pressed = await post(admin, '/ops/test-controls/demo.day');
  expect(pressed.statusCode, pressed.body).toBe(200);
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  await rollUp();
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- H10 -----------------------------------------------------------------------------------

describe('S2-15b round 6 — the frozen legacy days (H10)', () => {
  it('H10 — the demo day loads two frozen days at Demo Branch 2, Pisell’s and Papaya’s, each under its own formula', async () => {
    const rows = await ctx.db.select().from(dailySummary).where(ne(dailySummary.source, 'oto_pos'));
    expect(rows.map((r) => r.source).sort()).toEqual(['papaya', 'pisell']);
    // Never at a live park: only at the demo branch.
    expect(new Set(rows.map((r) => r.branchId))).toEqual(new Set([demo]));
    for (const fixture of [PISELL, PAPAYA] as LegacyFixtureDay[]) {
      const row = rows.find((r) => r.source === fixture.source)!;
      expect(row).toMatchObject({
        operatorId,
        businessDate: fixture.businessDate,
        formulaVersion: fixture.source === 'pisell' ? 30 : 21,
        frozen: true,
        provisional: false,
        inputFingerprint: legacyFixtureFingerprint(fixture),
      });
      expect(row.computedAt.toISOString()).toBe(fixture.importedAt);
      expect(figuresOf(row)).toEqual(figuresOf(fixture.figures));
      // Revenue is the five buckets, as on the platform's own rows.
      expect(row.revenueSatang).toBe(row.ticketsSatang + row.fnbSatang + row.merchSatang + row.partiesSatang + row.dropoffSatang);
    }
  });

  it('H10 — re-running the loader and the rollup leaves the fixture rows byte-identical', async () => {
    const before = await legacyRowsAsStored();
    expect(before).toHaveLength(2);

    // The loader, again: directly, through the demo day for today, through the
    // Health control, and on the Pisell day itself, which puts sales there.
    expect(await seedLegacyFixtureDays(ctx.db, { id: demo, operatorId })).toBe(0);
    expect(await seedDemoDay(ctx.db)).toMatchObject({ legacyFixtureDays: 0 });
    expect((await post(admin, '/ops/test-controls/demo.day')).statusCode).toBe(200);
    const onFixtureDay = await seedDemoDay(ctx.db, { on: PISELL.businessDate });
    expect(onFixtureDay).toMatchObject({ legacyFixtureDays: 0, sales: 11 });

    // Both fixture days marked as if late facts had landed on them.
    for (const fixture of LEGACY_FIXTURE_DAYS) {
      for (const kind of ['sales', 'hourly'] as const) {
        await ctx.db.execute(
          sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${demo}::uuid, ${fixture.businessDate}::date, ${kind}, 'h10')`,
        );
      }
    }
    // The rollup, every way it runs.
    await rollUp();
    await runDailyRollupJob(ctx.db, new Date());
    await runHourlyRollupJob(ctx.db, new Date());
    await rollUp();

    expect(await legacyRowsAsStored()).toEqual(before);

    // The rollup did go over both days — their marks are spent — and the
    // platform's own row for the Pisell day is there beside the frozen one.
    expect((await platformDay(demo, PISELL.businessDate))!.txnCount).toBeGreaterThan(0);
    expect(
      await ctx.db
        .select()
        .from(dirtyDate)
        .where(
          and(
            eq(dirtyDate.branchId, demo),
            inArray(dirtyDate.kind, ['sales', 'hourly']),
            inArray(dirtyDate.businessDate, LEGACY_FIXTURE_DAYS.map((d) => d.businessDate)),
          ),
        ),
    ).toEqual([]);
    // No legacy source ever gains an hour or a report row.
    const { rows: written } = await ctx.db.execute<{ n: number }>(sql`
      select (select count(*) from analytics.hourly_summary where source <> 'oto_pos')
           + (select count(*) from analytics.daily_category_summary where source <> 'oto_pos')
           + (select count(*) from analytics.daily_tender_summary where source <> 'oto_pos')
           + (select count(*) from analytics.daily_item_summary where source <> 'oto_pos')
           + (select count(*) from analytics.daily_ticket_summary where source <> 'oto_pos')
           + (select count(*) from analytics.daily_discount_summary where source <> 'oto_pos') as n`);
    expect(Number(written[0]!.n)).toBe(0);
  });
});

// --- The switch ------------------------------------------------------------------------------

describe('S2-15b round 6 — which source a branch reports', () => {
  it('is read per branch on analytics:read; a park never switched reports oto_pos', async () => {
    const all = await get(admin, '/analytics/sources');
    expect(all.statusCode, all.body).toBe(200);
    const answer = all.json() as BranchSources;
    expect(answer.branches.map((b) => b.branchId).sort()).toEqual([hkt, chalong, demo].sort());
    for (const b of answer.branches) {
      expect(b).toMatchObject({ source: 'oto_pos', preference: 'oto_pos', switchedAt: null, actorAccountId: null });
    }
    // Khun Lek reads Central; Demo Branch 2 is named back as omitted.
    const his = (await get(manager, `/analytics/sources?branches=${hkt},${demo}`)).json() as BranchSources;
    expect(his.branches.map((b) => b.branchId)).toEqual([hkt]);
    expect(his.omitted).toEqual([demo]);
    // Reception holds analytics:read nowhere; another operator's branch is not a branch here.
    expect((await get(reception, '/analytics/sources')).statusCode).toBe(403);
    expect((await get(foreignAdmin, `/analytics/sources?branches=${demo}`)).statusCode).toBe(404);
  });

  it('is switched on admin:branch:update at the branch, with who and when, audited before and after, and replayed not repeated', async () => {
    expect((await put(reception, demo, { source: 'pisell', preference: 'legacy' })).statusCode).toBe(403);
    expect((await put(manager, hkt, { source: 'pisell', preference: 'legacy' })).statusCode).toBe(403);
    expect((await put(foreignAdmin, demo, { source: 'pisell', preference: 'legacy' })).statusCode).toBe(404);
    expect((await put(admin, demo, { source: 'square', preference: 'legacy' })).statusCode).toBe(400);
    expect((await put(admin, demo, { source: 'pisell', preference: 'radar' })).statusCode).toBe(400);
    expect(await ctx.db.select().from(branchSourceSwitch)).toEqual([]);

    const first = await put(admin, demo, { source: 'pisell', preference: 'legacy' }, 'r6-switch-demo');
    expect(first.statusCode, first.body).toBe(200);
    const switched = first.json() as BranchSource & { changed: boolean };
    expect(switched).toMatchObject({ branchId: demo, source: 'pisell', preference: 'legacy', actorAccountId: adminId, changed: true });
    expect(switched.switchedAt).not.toBeNull();

    // The same request again is the same answer, not a second switch.
    const replay = await put(admin, demo, { source: 'pisell', preference: 'legacy' }, 'r6-switch-demo');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(switched);
    // Asking for what the branch already has changes and records nothing.
    const again = (await switchTo(demo, 'pisell', 'legacy'));
    expect(again).toMatchObject({ changed: false, switchedAt: switched.switchedAt });

    const rows = await ctx.db.select().from(branchSourceSwitch).where(eq(branchSourceSwitch.branchId, demo));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operatorId, source: 'pisell', preference: 'legacy', actorAccountId: adminId });
    const trail = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'analytics.branch_source.switch'), eq(auditLog.entityId, demo)));
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      actorAccountId: adminId,
      operatorId,
      branchId: demo,
      entityType: 'branch_source_switch',
      before: { source: 'oto_pos', preference: 'oto_pos', switchedAt: null, actorAccountId: null },
      after: { source: 'pisell', preference: 'legacy', switchedAt: switched.switchedAt, actorAccountId: adminId },
    });

    const read = (await get(admin, `/analytics/sources?branches=${demo}`)).json() as BranchSources;
    expect(read.branches[0]).toMatchObject({ source: 'pisell', preference: 'legacy', switchedAt: switched.switchedAt });
    // The OpenAPI document carries both routes.
    const docs = (await get(admin, '/docs/json')).json() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(docs.paths['/analytics/sources'] ?? {})).toContain('get');
    expect(Object.keys(docs.paths['/analytics/sources/{branchId}'] ?? {})).toContain('put');
  });

  it('decides which rows the summary serves: the legacy source’s frozen days, then the other’s, then the platform’s again', async () => {
    const range = `branches=${demo}&from=${PISELL.businessDate}&to=${PAPAYA.businessDate}&group=day`;

    // On Pisell (switched above).
    const onPisell = await summary(admin, range);
    expect(onPisell.source).toBe('pisell');
    expect(onPisell.branches[0]).toMatchObject({ source: 'pisell', lastRolledUpAt: PISELL.importedAt });
    const [pisellDay, papayaDay] = onPisell.branches[0]!.rows;
    expect(figuresOf(pisellDay!)).toEqual(figuresOf(PISELL.figures));
    expect(pisellDay).toMatchObject({ formulaVersion: 30, provisional: false, rolledDays: 1, computedAt: PISELL.importedAt });
    expect(figuresOf(papayaDay!)).toEqual(ZERO);
    expect(papayaDay).toMatchObject({ provisional: false, rolledDays: 0, formulaVersion: null });

    // Today the demo branch traded on the platform, but it reports Pisell: no
    // frozen day today, so nothing — final, and no hours.
    expect((await platformDay(demo, T))!.revenueSatang).toBeGreaterThan(0);
    const today = await summary(admin, `branches=${demo}&from=${T}&to=${T}`);
    expect(figuresOf(today.merged[0]!)).toEqual(ZERO);
    expect(today.merged[0]!.provisional).toBe(false);
    expect(today.hours).toEqual([]);

    // Beside Central, the total is Central's own day and its hours only.
    const both = await summary(admin, `branches=${hkt},${demo}&from=${T}&to=${T}&group=total`);
    expect(both.source).toBeNull();
    expect(both.branches.map((b) => [b.branchId, b.source])).toEqual([
      [hkt, 'oto_pos'],
      [demo, 'pisell'],
    ]);
    const central = (await platformDay(hkt, T))!;
    expect(figuresOf(both.merged[0]!)).toEqual(figuresOf(central));
    expect(both.hours!.reduce((s, h) => s + h.revenueSatang, 0)).toBe(central.revenueSatang);

    // On Papaya: the other day, under its formula.
    await switchTo(demo, 'papaya', 'legacy');
    const onPapaya = await summary(admin, range);
    expect(figuresOf(onPapaya.branches[0]!.rows[0]!)).toEqual(ZERO);
    expect(figuresOf(onPapaya.branches[0]!.rows[1]!)).toEqual(figuresOf(PAPAYA.figures));
    expect(onPapaya.branches[0]!.rows[1]).toMatchObject({ formulaVersion: 21, rolledDays: 1 });

    // Back on the platform: its own rolled days, never the frozen ones.
    await switchTo(demo, 'oto_pos', 'both');
    const onPlatform = await summary(admin, range);
    expect(onPlatform.source).toBe('oto_pos');
    const own = (await platformDay(demo, PISELL.businessDate))!;
    expect(figuresOf(onPlatform.branches[0]!.rows[0]!)).toEqual(figuresOf(own));
    expect(onPlatform.branches[0]!.rows[0]!.formulaVersion).toBe(1);
    expect(figuresOf(onPlatform.branches[0]!.rows[0]!)).not.toEqual(figuresOf(PISELL.figures));
    expect(figuresOf((await summary(admin, `branches=${demo}&from=${T}&to=${T}`)).merged[0]!)).toEqual(
      figuresOf((await platformDay(demo, T))!),
    );

    // Every switch is on the record, each "before" the one the last left.
    const trail = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'analytics.branch_source.switch'), eq(auditLog.entityId, demo)))
      .orderBy(auditLog.createdAt, auditLog.id);
    expect(trail.map((t) => [(t.before as BranchSource).source, (t.after as BranchSource).source])).toEqual([
      ['oto_pos', 'pisell'],
      ['pisell', 'papaya'],
      ['papaya', 'oto_pos'],
    ]);
    // The frozen rows were served, never touched.
    expect(await legacyRowsAsStored()).toHaveLength(2);
  });

  it('an unpermitted branch stays omitted, whatever source it reports', async () => {
    await switchTo(demo, 'pisell', 'legacy');
    try {
      // Khun Lek reads Central only.
      const his = await summary(manager, `branches=${hkt},${demo}&from=${PISELL.businessDate}&to=${PISELL.businessDate}`);
      expect(his.branches.map((b) => b.branchId)).toEqual([hkt]);
      expect(his.omitted).toEqual([demo]);
      expect(his.merged[0]!.revenueSatang).not.toBe(PISELL.figures.revenueSatang);
      const body = JSON.stringify({ ...his, omitted: [] });
      expect(body).not.toContain(demo);
      expect(body).not.toContain(`"revenueSatang":${PISELL.figures.revenueSatang}`);
      expect((await get(manager, `/analytics/summary?branches=${demo}&from=${T}&to=${T}`)).statusCode).toBe(403);
      // Nor may he switch it, or his own park.
      expect((await put(manager, demo, { source: 'oto_pos', preference: 'oto_pos' })).statusCode).toBe(403);
    } finally {
      await switchTo(demo, 'oto_pos', 'oto_pos');
    }
  });
});

// --- Question 9 ------------------------------------------------------------------------------

describe('S2-15b round 6 — a total adds up only branches held on analytics:read (plan §9 question 9)', () => {
  it('H2 — the Today screen’s permission opens a park on its own, never into a total; analytics:read opens the total', async () => {
    const [staffRole] = await ctx.db.select({ id: role.id }).from(role).where(and(eq(role.name, 'staff'), eq(role.isSystem, true)));
    const readerRole = await operatorRole('Analytics reader (r6 test)', ['analytics:read']);
    const assignments: string[] = [];
    try {
      // Reception, Today at Central (its own) and now at Demo Branch 2.
      assignments.push(await grant(receptionId, staffRole!.id, demo));
      const alone = await summary(reception, `branches=${demo}&from=${T}&to=${T}`);
      expect(alone.branches.map((b) => b.branchId)).toEqual([demo]);
      expect(alone.readable.map((b) => b.branchId).sort()).toEqual([hkt, demo].sort());
      expect(alone.mergeable).toEqual([]);
      for (const query of [`from=${T}&to=${T}`, `branches=${hkt},${demo}&from=${T}&to=${T}`]) {
        const refused = await get(reception, `/analytics/summary?${query}`);
        expect(refused.statusCode, query).toBe(403);
        expect(refused.body).toContain('analytics:read');
      }

      // analytics:read at Demo Branch 2: the total is that park; Central, read
      // only on the Today screen's permission, is named back as omitted.
      assignments.push(await grant(receptionId, readerRole, demo));
      const one = await summary(reception, `branches=${hkt},${demo}&from=${T}&to=${T}`);
      expect(one.branches.map((b) => b.branchId)).toEqual([demo]);
      expect(one.omitted).toEqual([hkt]);
      expect(figuresOf(one.merged[0]!)).toEqual(figuresOf((await platformDay(demo, T))!));

      // And at Central too: All branches is both, added up.
      assignments.push(await grant(receptionId, readerRole, hkt));
      const all = await summary(reception, `from=${T}&to=${T}`);
      expect(all.branches.map((b) => b.branchId).sort()).toEqual([hkt, demo].sort());
      expect(all.mergeable.map((b) => b.branchId).sort()).toEqual([hkt, demo].sort());
      const [c, d] = [(await platformDay(hkt, T))!, (await platformDay(demo, T))!];
      expect(all.merged[0]!.revenueSatang).toBe(c.revenueSatang + d.revenueSatang);
      expect(all.merged[0]!.txnCount).toBe(c.txnCount + d.txnCount);
    } finally {
      await ctx.db.delete(roleAssignment).where(inArray(roleAssignment.id, assignments));
    }
    // Back to its one park.
    const own = await summary(reception, `from=${T}&to=${T}`);
    expect(own.branches.map((b) => b.branchId)).toEqual([hkt]);
  });
});

// --- H1, H14 ---------------------------------------------------------------------------------

describe('S2-15b round 6 — the merge’s day starts, and no member data (H1, H14)', () => {
  it('H1 — a merge of parks with different day starts carries each park’s own timezone, day start and today', async () => {
    await ctx.db.update(branch).set({ businessDayStart: '06:00:00' }).where(eq(branch.id, demo));
    try {
      const both = await summary(admin, `branches=${hkt},${demo}&from=${T}&to=${T}`);
      const now = new Date();
      const byId = Object.fromEntries(both.branches.map((b) => [b.branchId, b]));
      expect(byId[hkt]).toMatchObject({ timezone: 'Asia/Bangkok', businessDayStart: '05:00' });
      expect(byId[demo]).toMatchObject({ timezone: 'Asia/Bangkok', businessDayStart: '06:00' });
      expect(byId[hkt]!.today).toBe(businessDate(now, 'Asia/Bangkok', parseDayStart('05:00')));
      expect(byId[demo]!.today).toBe(businessDate(now, 'Asia/Bangkok', parseDayStart('06:00')));
    } finally {
      await ctx.db.update(branch).set({ businessDayStart: '05:00:00' }).where(eq(branch.id, demo));
    }
  });

  it('H14 — the summary carries no member field, and the rollup jobs record counts only', async () => {
    const keys = new Set<string>();
    const walk = (schema: z.ZodTypeAny): void => {
      const s = schema as unknown as {
        shape?: Record<string, z.ZodTypeAny>;
        element?: z.ZodTypeAny;
        valueSchema?: z.ZodTypeAny;
        unwrap?: () => z.ZodTypeAny;
        _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
      };
      if (s.shape) {
        for (const [key, value] of Object.entries(s.shape)) {
          keys.add(key);
          walk(value);
        }
      } else if (s.element) walk(s.element);
      else if (s.valueSchema) walk(s.valueSchema);
      else if (s._def?.innerType) walk(s._def.innerType);
      else if (s._def?.schema) walk(s._def.schema);
      else if (typeof s.unwrap === 'function') walk(s.unwrap());
    };
    walk(AnalyticsSummarySchema);
    expect(keys.has('merged')).toBe(true);
    expect(keys.has('guestsKids')).toBe(true);
    expect([...keys].filter((k) => /member|phone|email|guardian|child|nickname|allerg|medical|birth|customer/i.test(k))).toEqual([]);

    const runs = await ctx.db
      .select({ name: opsRun.name, detail: opsRun.detail })
      .from(opsRun)
      .where(inArray(opsRun.name, [ROLLUP_DAILY_JOB, ROLLUP_HOURLY_JOB, ROLLUP_BOOTH_JOB]));
    expect(new Set(runs.map((r) => r.name))).toEqual(new Set([ROLLUP_DAILY_JOB, ROLLUP_HOURLY_JOB, ROLLUP_BOOTH_JOB]));
    for (const run of runs) {
      const detail = (run.detail ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(detail)) expect(typeof value, `${run.name}.${key}`).toBe('number');
    }
  });
});

// --- Health ----------------------------------------------------------------------------------

describe('S2-15b round 6 — Health names every analytics figure set’s freshness', () => {
  it('per park: the day, the report rows and the booth figures, each brought up to date by the last run', async () => {
    await rollUp();
    const res = await get(admin, '/ops/health');
    expect(res.statusCode, res.body).toBe(200);
    const rollups = res.json<{
      rollups: Array<{
        branchId: string;
        lastRolledUpAt: string | null;
        reportsLastRolledUpAt: string | null;
        boothLastRolledUpAt: string | null;
      }>;
    }>().rollups;
    expect(rollups.map((r) => r.branchId).sort()).toEqual([hkt, chalong, demo].sort());
    for (const r of rollups) {
      expect(r.lastRolledUpAt, r.branchId).not.toBeNull();
      expect(r.boothLastRolledUpAt, r.branchId).not.toBeNull();
      // Written by the daily run in the transaction that writes the day.
      expect(r.reportsLastRolledUpAt, r.branchId).toBe(r.lastRolledUpAt);
    }
  });
});
