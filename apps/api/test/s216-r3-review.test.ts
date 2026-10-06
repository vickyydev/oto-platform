import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import {
  account,
  branch,
  dailySummary,
  hourlySummary,
  opsRun,
  paymentAttempt,
  receiptSeries,
  refund,
  role,
  roleAssignment,
  rolePermission,
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
import { DEMO_BRANCH_CODE, DemoBranchRefusedError, seedDemoDay } from '@oto/db/seed';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type AnalyticsDayFigures,
  type AnalyticsSummary,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
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
 * S2-15b (SCRUM-216) round 3 — REVIEW. Attacks on `GET /analytics/summary`
 * and the demo control, beyond the builder's own suite:
 *
 *   scope      grants that LOOK like access to Robinson Chalong — the Today
 *              permission scoped to a department or a record whose id is the
 *              branch's, an operator role without either summary permission at
 *              the branch, `staff` at another operator's branch — must open
 *              nothing; ids repeated or upper-cased must not count a park twice
 *              or slip past the check; a grant withdrawn is withdrawn on the
 *              next request; hours and ranges carry nothing of an unread park.
 *   figures    every figure of every row equals the stored `daily_summary`.
 *   freshness  a failed run, or another job's run, never makes a park look
 *              fresher; a stalled rollup is reported as stalled.
 *   demo       the control writes at Demo Branch 2 however it is called —
 *              body, query string, a counter role, a live park's code in any
 *              spelling, a live park renamed "Demo Branch 2" — and not one
 *              row of any money table lands at a live park.
 */

let ctx: TestContext;
let reception: string;
let admin: string;
let hkt: string;
let chalong: string;
let demo: string;
let foreign: string;
let receptionAccountId: string;
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

const get = (cookie: string, query: string) =>
  ctx.app.inject({ method: 'GET', url: `/analytics/summary?${query}`, headers: { cookie } });

async function summary(cookie: string, query: string): Promise<AnalyticsSummary> {
  const res = await get(cookie, query);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AnalyticsSummary;
}

const post = (cookie: string, url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });

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

async function grant(roleId: string, scopeType: 'operator' | 'branch' | 'department' | 'record', scopeId: string) {
  const id = newId();
  await ctx.db.insert(roleAssignment).values({ id, accountId: receptionAccountId, roleId, scopeType, scopeId });
  return id;
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

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  foreign = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, hkt));
  T = businessDate(new Date(), central!.timezone, parseDayStart(central!.businessDayStart));
  const [me] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
  receptionAccountId = me!.id;

  const hktTill = await tillAt(hkt);
  await takeStation(ctx.app, reception, hktTill);
  await cashSale(reception, hktTill, await packageAt(hkt, '2 Hours Play'), 2, 1);
  // Chalong trades more than Central, so a leak of it into any figure shows.
  const chalongTill = await tillAt(chalong);
  await takeStation(ctx.app, chalongManager, chalongTill);
  await cashSale(chalongManager, chalongTill, await packageAt(chalong, 'Full Day Pass'), 3, 2);
  await cashSale(chalongManager, chalongTill, await packageAt(chalong, '1 Hour Play'), 1, 1);

  const pressed = await post(admin, '/ops/test-controls/demo.day');
  expect(pressed.statusCode, pressed.body).toBe(200);
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  await rollUp();

  // Grants that name Chalong's id but must not open it.
  const [staffRole] = await ctx.db.select({ id: role.id }).from(role).where(and(eq(role.name, 'staff'), isNull(role.operatorId)));
  await grant(staffRole!.id, 'department', chalong);
  await grant(staffRole!.id, 'record', chalong);
  // `staff` at the other operator's branch: not OTO's business at all.
  await grant(staffRole!.id, 'branch', foreign);
  // An operator role at Chalong that carries neither summary permission.
  const floorRole = newId();
  await ctx.db.insert(role).values({
    id: floorRole,
    operatorId: await operatorIdByName(ctx.db, OTO_OPERATOR_NAME),
    name: 'Review floor reader',
  });
  await ctx.db.insert(rolePermission).values(
    ['pos:member:read', 'pos:sale:read', 'pos:checkin:read', 'admin:branch:read'].map((permission) => ({
      id: newId(),
      roleId: floorRole,
      permission,
    })),
  );
  await grant(floorRole, 'branch', chalong);
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('review — a caller who must not see Robinson Chalong never does', () => {
  it('department, record and foreign-branch grants and a role without the permission open nothing', async () => {
    const own = await summary(reception, `from=${T}&to=${T}`);
    expect(own.branches.map((b) => b.branchId)).toEqual([hkt]);
    expect(own.readable.map((b) => b.branchId)).toEqual([hkt]);
    expect(figuresOf(own.merged[0]!)).toEqual(figuresOf((await stored(hkt, T))!));

    expect((await get(reception, `branches=${chalong}&from=${T}&to=${T}`)).statusCode).toBe(403);
    expect((await get(reception, `branches=${chalong.toUpperCase()}&from=${T}&to=${T}`)).statusCode).toBe(403);
    // Another operator's branch is not a branch here at all, grant or no grant.
    expect((await get(reception, `branches=${foreign}&from=${T}&to=${T}`)).statusCode).toBe(404);
  });

  it('an upper-cased or repeated id neither slips past the check nor counts a park twice', async () => {
    const hktDay = (await stored(hkt, T))!;
    const mixed = await summary(reception, `branches=${hkt},${chalong.toUpperCase()},${hkt.toUpperCase()},${hkt}&from=${T}&to=${T}`);
    expect(mixed.branches.map((b) => b.branchId)).toEqual([hkt]);
    expect(mixed.omitted).toEqual([chalong]);
    expect(figuresOf(mixed.merged[0]!)).toEqual(figuresOf(hktDay));

    // The admin reads both: a repeated id is still one park in the total.
    const twice = await summary(admin, `branches=${hkt},${hkt.toUpperCase()},${chalong}&from=${T}&to=${T}`);
    expect(twice.branches.map((b) => b.branchId)).toEqual([hkt, chalong]);
    expect(twice.merged[0]!.revenueSatang).toBe(hktDay.revenueSatang + (await stored(chalong, T))!.revenueSatang);
  });

  it('the hours, a range by day and a range in total carry nothing of the unread park', async () => {
    const hktDay = (await stored(hkt, T))!;
    const chalongDay = (await stored(chalong, T))!;
    expect(chalongDay.revenueSatang).toBeGreaterThan(hktDay.revenueSatang);

    const one = await summary(reception, `branches=${hkt},${chalong}&from=${T}&to=${T}`);
    const hktHours = await ctx.db
      .select()
      .from(hourlySummary)
      .where(and(eq(hourlySummary.branchId, hkt), eq(hourlySummary.businessDate, T)));
    expect(one.hours!.reduce((s, h) => s + h.revenueSatang, 0)).toBe(hktHours.reduce((s, h) => s + h.revenueSatang, 0));
    expect(one.hours!.reduce((s, h) => s + h.revenueSatang, 0)).toBe(hktDay.revenueSatang);
    expect(one.hours!.reduce((s, h) => s + h.guests, 0)).toBe(hktDay.guestsKids + hktDay.guestsAdults);

    const from = addDaysToIsoDate(T, -6);
    const byDay = await summary(reception, `branches=${chalong},${hkt}&from=${from}&to=${T}&group=day`);
    expect(byDay.omitted).toEqual([chalong]);
    expect(byDay.merged).toHaveLength(7);
    expect(byDay.merged.reduce((s, r) => s + r.revenueSatang, 0)).toBe(hktDay.revenueSatang);
    const total = await summary(reception, `branches=${chalong},${hkt}&from=${from}&to=${T}&group=total`);
    expect(figuresOf(total.merged[0]!)).toEqual(figuresOf(hktDay));

    // Nothing in any answer names the park or carries its figures.
    for (const body of [one, byDay, total].map((a) => JSON.stringify({ ...a, omitted: [] }))) {
      expect(body).not.toContain(chalong);
      expect(body).not.toContain('Robinson Chalong');
      expect(body).not.toContain(`"revenueSatang":${chalongDay.revenueSatang}`);
    }
  });

  it('a Today grant at Chalong opens it on the next request, and withdrawing it closes it on the next', async () => {
    const [staffRole] = await ctx.db.select({ id: role.id }).from(role).where(and(eq(role.name, 'staff'), isNull(role.operatorId)));
    const assignment = await grant(staffRole!.id, 'branch', chalong);
    const both = await summary(reception, `from=${T}&to=${T}`);
    expect(both.readable.map((b) => b.branchId).sort()).toEqual([hkt, chalong].sort());
    expect(both.merged[0]!.revenueSatang).toBe((await stored(hkt, T))!.revenueSatang + (await stored(chalong, T))!.revenueSatang);

    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.id, assignment));
    const back = await summary(reception, `from=${T}&to=${T}`);
    expect(back.readable.map((b) => b.branchId)).toEqual([hkt]);
    expect(back.branches.map((b) => b.branchId)).toEqual([hkt]);
    expect(figuresOf(back.merged[0]!)).toEqual(figuresOf((await stored(hkt, T))!));
  });
});

describe('review — every figure is the stored row', () => {
  it('each branch row and the merged row, figure by figure, for every park the admin reads', async () => {
    const all = await summary(admin, `from=${T}&to=${T}`);
    expect(all.branches.map((b) => b.branchId).sort()).toEqual([hkt, chalong, demo].sort());
    const sums = Object.fromEntries(FIGURE_KEYS.filter((k) => k !== 'byChannel').map((k) => [k, 0])) as Record<string, number>;
    for (const b of all.branches) {
      const row = (await stored(b.branchId, T))!;
      expect(figuresOf(b.rows[0]!)).toEqual(figuresOf(row));
      for (const k of Object.keys(sums)) sums[k]! += row[k as keyof typeof row] as number;
      // Revenue is the five bars, as the prototype's headline is.
      expect(row.revenueSatang).toBe(row.ticketsSatang + row.fnbSatang + row.merchSatang + row.partiesSatang + row.dropoffSatang);
    }
    for (const [k, v] of Object.entries(sums)) expect(all.merged[0]![k as keyof AnalyticsDayFigures], k).toBe(v);
  });
});

describe('review — how fresh, honestly', () => {
  async function newestOk() {
    const [run] = await ctx.db
      .select({ startedAt: opsRun.startedAt })
      .from(opsRun)
      .where(and(eq(opsRun.name, ROLLUP_DAILY_JOB), eq(opsRun.outcome, 'ok')))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    return run!.startedAt;
  }

  it('a failed daily run, or a newer run of another job, does not make a park look fresher', async () => {
    const before = await newestOk();
    const later = new Date(before.getTime() + 60_000);
    await ctx.db.insert(opsRun).values([
      { id: newId(), kind: 'job', name: ROLLUP_DAILY_JOB, outcome: 'failed', startedAt: later, finishedAt: later, durationMs: 1 },
      { id: newId(), kind: 'job', name: 'job:rollup.hourly', outcome: 'ok', startedAt: later, finishedAt: later, durationMs: 1 },
    ]);
    const answer = await summary(reception, `from=${T}&to=${T}`);
    expect(answer.branches[0]!.lastRolledUpAt).toBe(before.toISOString());
    expect(answer.lastRolledUpAt).toBe(before.toISOString());
  });

  it('a stalled rollup reads as stalled: today has no row, is provisional, and the last run is a day old', async () => {
    // As if the jobs process stopped yesterday: every successful run is a day
    // older, and today's rows were never written. The park has traded for a
    // month (a run older than a branch never counts for it).
    await ctx.db.execute(sql`update core.branch set created_at = created_at - interval '30 days' where id = ${hkt}`);
    await ctx.db.execute(
      sql`update core.ops_run set started_at = started_at - interval '26 hours', finished_at = finished_at - interval '26 hours' where name = ${ROLLUP_DAILY_JOB}`,
    );
    await ctx.db.execute(
      sql`update analytics.daily_summary set computed_at = computed_at - interval '26 hours' where business_date < ${T}`,
    );
    const todayRows = await ctx.db.select().from(dailySummary).where(eq(dailySummary.businessDate, T));
    await ctx.db.delete(dailySummary).where(eq(dailySummary.businessDate, T));
    try {
      const answer = await summary(reception, `from=${T}&to=${T}`);
      const row = answer.merged[0]!;
      expect(row).toMatchObject({ provisional: true, rolledDays: 0, computedAt: null, revenueSatang: 0 });
      // The answer says the last run is older than the start of today's
      // trading day, so a reader can be told the figures are stale.
      const last = Date.parse(answer.lastRolledUpAt!);
      expect(Date.now() - last).toBeGreaterThan(24 * 3_600_000);
      expect(answer.branches[0]!.today).toBe(T);
    } finally {
      await ctx.db.insert(dailySummary).values(todayRows);
    }
  });
});

describe('review — the demo control never writes at a live park, however it is called (H11)', () => {
  it('a body or query string naming Central is ignored: the day still goes to Demo Branch 2', async () => {
    const before = await liveParkMoneyRows();
    const viaBody = await post(admin, '/ops/test-controls/demo.day', { branchCode: CENTRAL_BRANCH_CODE, branchId: hkt });
    expect(viaBody.statusCode, viaBody.body).toBe(200);
    expect(viaBody.json<{ message: string }>().message).toContain('at Demo Branch 2');
    const viaQuery = await ctx.app.inject({
      method: 'POST',
      url: `/ops/test-controls/demo.day?branchCode=${CENTRAL_BRANCH_CODE}&branchId=${hkt}`,
      headers: { cookie: admin },
    });
    expect(viaQuery.statusCode, viaQuery.body).toBe(200);
    expect(await liveParkMoneyRows()).toEqual(before);
  });

  it('a counter role or a branch manager cannot press it at all', async () => {
    const before = await liveParkMoneyRows();
    const manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    for (const cookie of [reception, manager]) {
      expect((await post(cookie, '/ops/test-controls/demo.day')).statusCode).toBe(403);
    }
    expect(await liveParkMoneyRows()).toEqual(before);
  });

  it('a live park’s code in any spelling, or no code at all, is refused before anything is written', async () => {
    const on = addDaysToIsoDate(T, -30);
    const before = await liveParkMoneyRows();
    const allSales = async () => Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(sale))[0]!.n);
    const salesBefore = await allSales();
    for (const code of [
      CENTRAL_BRANCH_CODE,
      CENTRAL_BRANCH_CODE.toUpperCase(),
      ` ${CENTRAL_BRANCH_CODE}`,
      `${CENTRAL_BRANCH_CODE} `,
      CHALONG_BRANCH_CODE,
      SECOND_OPERATOR_BRANCH_CODE,
      '',
      'Demo Branch 2',
      `${DEMO_BRANCH_CODE} `,
    ]) {
      await expect(seedDemoDay(ctx.db, { on, branchCode: code }), JSON.stringify(code)).rejects.toBeInstanceOf(
        DemoBranchRefusedError,
      );
    }
    expect(await allSales()).toBe(salesBefore);
    expect(await ctx.db.select({ id: sale.id }).from(sale).where(like(sale.actionId, `demo-day/${on}/%`))).toEqual([]);
    expect(await liveParkMoneyRows()).toEqual(before);
  });

  it('Central renamed "Demo Branch 2" is still not the demo branch: the code decides', async () => {
    const [central] = await ctx.db.select({ name: branch.name }).from(branch).where(eq(branch.id, hkt));
    const before = await liveParkMoneyRows();
    await ctx.db.update(branch).set({ name: 'Demo Branch 2' }).where(eq(branch.id, hkt));
    try {
      const on = addDaysToIsoDate(T, -31);
      const counts = await seedDemoDay(ctx.db, { on });
      expect(counts.sales).toBe(11);
      expect(counts.branchCode).toBe(DEMO_BRANCH_CODE);
      const written = await ctx.db.select({ branchId: sale.branchId }).from(sale).where(like(sale.actionId, `demo-day/${on}/%`));
      expect(new Set(written.map((w) => w.branchId))).toEqual(new Set([demo]));
    } finally {
      await ctx.db.update(branch).set({ name: central!.name }).where(eq(branch.id, hkt));
    }
    expect(await liveParkMoneyRows()).toEqual(before);
  });

  it('every demo row in every money table sits at Demo Branch 2, and its receipts are the D2 series', async () => {
    const demoSales = await ctx.db
      .select({ id: sale.id, branchId: sale.branchId, stationId: sale.stationId, series: sale.receiptSeries })
      .from(sale)
      .where(like(sale.actionId, 'demo-day/%'));
    expect(demoSales.length).toBeGreaterThanOrEqual(22);
    const demoTill = await tillAt(demo);
    for (const s of demoSales) {
      expect(s.branchId).toBe(demo);
      expect(s.stationId).toBe(demoTill);
      if (s.series !== null) expect(s.series).toBe('D2');
    }
    const ids = demoSales.map((s) => s.id);
    const lines = await ctx.db.select({ b: saleLine.branchId }).from(saleLine).where(inArray(saleLine.saleId, ids));
    const attempts = await ctx.db.select({ b: paymentAttempt.branchId }).from(paymentAttempt).where(inArray(paymentAttempt.saleId, ids));
    const refunds = await ctx.db.select({ b: refund.branchId }).from(refund).where(inArray(refund.saleId, ids));
    expect(lines.length).toBeGreaterThan(0);
    expect(attempts.length).toBeGreaterThan(0);
    expect(refunds.length).toBeGreaterThan(0);
    for (const r of [...lines, ...attempts, ...refunds]) expect(r.b).toBe(demo);
    // A card attempt at the demo branch never carries a live terminal's TID.
    const tids = await ctx.db
      .select({ tid: paymentAttempt.tid })
      .from(paymentAttempt)
      .where(and(inArray(paymentAttempt.saleId, ids), eq(paymentAttempt.method, 'card')));
    for (const t of tids) expect(['DEMONEX1', 'DEMOPAX1', null]).toContain(t.tid);
  });
});
