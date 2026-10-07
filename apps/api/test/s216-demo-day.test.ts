import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  account,
  boothPrize,
  box,
  dailySummary,
  dirtyDate,
  factBoothDaily,
  sale,
  saleDiscount,
  spin,
  station,
  voucher,
  voucherDefinition,
  voucherPrint,
} from '@oto/db';
import { DEMO_BOOTH_NAME, DEMO_BRANCH_CODE, describeDemoDay, seedDemoDay } from '@oto/db/seed';
import {
  addDaysToIsoDate,
  businessDate,
  parseDayStart,
  type BoothReport,
  type DiscountReport,
  type DiscountTransactions,
} from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-15b (SCRUM-216) — the staging walkthrough's two demo-day gaps, closed
 * (plan docs/progress/plans/analytics/PLAN.md §5, §8 rounds 4-6, hazards H11,
 * H12).
 *
 *   discounts    the demo day's discounted sales carry the discount rows the
 *                till writes, equal to the sales' own figures, so the Discounts
 *                & Comps panel — tiles, by operator, transactions — carries the
 *                day's manual discount and agrees with the summary's
 *                discounts_satang (the walkthrough saw 200.00 there and Manual
 *                discounts 0.00 beside it)
 *   booth        the demo day files a small funnel at Demo Branch 2's own
 *                booth, shaped as the booth's box reports one and never
 *                simulated; the booth rollup fills the day's fact from it, and
 *                the report and its CSV show it (the walkthrough saw "No spins
 *                in these days")
 *   convergence  a second run adds nothing; a day pressed before this fix — no
 *                discount row, no presses, no frozen days — is topped up once,
 *                and says so honestly; no live park or live booth moves
 */

let ctx: TestContext;
let admin: string;
let hkt: string;
let chalong: string;
let demo: string;
let somId: string;
let T: string;
let pressMessage = '';
let liveBefore: unknown;

const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie: admin } });
const post = (url: string) => ctx.app.inject({ method: 'POST', url, headers: { cookie: admin } });

async function rollUp(): Promise<void> {
  const res = await post('/ops/test-controls/rollup.run');
  expect(res.statusCode, res.body).toBe(200);
}

async function report<R>(path: string, on: string): Promise<R> {
  const res = await get(`/analytics/${path}?branches=${demo}&from=${on}&to=${on}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as R;
}

/** Every booth and booth fact of the live parks, row for row: what the demo day must never move. */
async function liveBoothState(): Promise<unknown> {
  const { rows } = await ctx.db.execute<{ t: string; rows: unknown }>(sql`
    with parks(id) as (select unnest(array[${hkt}::uuid, ${chalong}::uuid]))
    select 'box' as t, (select count(*)::text::jsonb from core.box x where x.branch_id in (select id from parks)) as rows
    union all select 'booth', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from core.station x where x.branch_id in (select id from parks) and x.kind = 'booth')
    union all select 'booth_settings', (select coalesce(jsonb_agg(to_jsonb(x) order by x.station_id), '[]') from booth.booth_settings x where x.branch_id in (select id from parks))
    union all select 'booth_prize', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from booth.booth_prize x where x.branch_id in (select id from parks))
    union all select 'booth_config_version', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from booth.booth_config_version x where x.branch_id in (select id from parks))
    union all select 'booth_staff_assignment', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from booth.booth_staff_assignment x join core.station st on st.id = x.station_id where st.branch_id in (select id from parks))
    union all select 'booth_duty_assignment', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from booth.booth_duty_assignment x where x.branch_id in (select id from parks))
    union all select 'spin', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from booth.spin x where x.branch_id in (select id from parks))
    union all select 'voucher_print', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from booth.voucher_print x where x.branch_id in (select id from parks))
    union all select 'voucher', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from promo.voucher x where x.branch_id in (select id from parks))
    union all select 'sale_discount', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from pos.sale_discount x where x.branch_id in (select id from parks))
    union all select 'fact_booth_daily', (select count(*)::text::jsonb from analytics.fact_booth_daily x where x.branch_id in (select id from parks))`);
  return Object.fromEntries(rows.map((r) => [r.t, r.rows]));
}

/** Row counts of every table the demo day's discounts and booth write to. */
async function demoRowCounts(): Promise<Record<string, number>> {
  const { rows } = await ctx.db.execute<{ t: string; n: number }>(sql`
    select 'sale' as t, (select count(*) from pos.sale)::int as n
    union all select 'sale_discount', (select count(*) from pos.sale_discount)::int
    union all select 'spin', (select count(*) from booth.spin)::int
    union all select 'voucher', (select count(*) from promo.voucher)::int
    union all select 'voucher_print', (select count(*) from booth.voucher_print)::int
    union all select 'voucher_redemption', (select count(*) from promo.voucher_redemption)::int
    union all select 'booth_duty_assignment', (select count(*) from booth.booth_duty_assignment)::int
    union all select 'booth_staff_assignment', (select count(*) from booth.booth_staff_assignment)::int
    union all select 'booth_prize', (select count(*) from booth.booth_prize)::int
    union all select 'booth_config_version', (select count(*) from booth.booth_config_version)::int
    union all select 'box', (select count(*) from core.box)::int
    union all select 'station', (select count(*) from core.station)::int
    union all select 'legacy_days', (select count(*) from analytics.daily_summary where source <> 'oto_pos')::int`);
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}

/** Demo Branch 2's demo booth. */
async function demoBooth() {
  const [row] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, demo), eq(station.name, DEMO_BOOTH_NAME), isNull(station.archivedAt)));
  return row!;
}

/** The demo day's counted discounts: what the summary row's discounts_satang is made of. */
async function salesOn(on: string) {
  return ctx.db.select().from(sale).where(and(eq(sale.branchId, demo), eq(sale.businessDate, on)));
}

async function platformDay(on: string) {
  const [row] = await ctx.db
    .select()
    .from(dailySummary)
    .where(and(eq(dailySummary.branchId, demo), eq(dailySummary.businessDate, on), eq(dailySummary.source, 'oto_pos')));
  return row;
}

async function boothFacts(on: string) {
  const rows = await ctx.db
    .select()
    .from(factBoothDaily)
    .where(and(eq(factBoothDaily.branchId, demo), eq(factBoothDaily.businessDate, on)));
  const sum = (k: 'spins' | 'vouchersIssued' | 'vouchersRedeemed' | 'redemptionLagSumS' | 'prizeCostSatang') =>
    rows.reduce((acc, r) => acc + Number(r[k]), 0);
  return {
    rows,
    spins: sum('spins'),
    issued: sum('vouchersIssued'),
    redeemed: sum('vouchersRedeemed'),
    lag: sum('redemptionLagSumS'),
    cost: sum('prizeCostSatang'),
  };
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [som] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
  somId = som!.id;
  T = businessDate(new Date(), 'Asia/Bangkok', parseDayStart('05:00'));
  liveBefore = await liveBoothState();

  // The Health page's demo control, then the rollup's "Run now".
  const pressed = await post('/ops/test-controls/demo.day');
  expect(pressed.statusCode, pressed.body).toBe(200);
  pressMessage = pressed.json<{ message: string }>().message;
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  await rollUp();
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the demo day’s discounts are recorded as the till records them', () => {
  it('says what it wrote: eleven sales, six presses at the booth, the frozen days', () => {
    expect(pressMessage).toBe(
      `Demo day ${T} at Demo Branch 2: 11 sales added, 0 already present; booth: 6 spins added, 0 already present; ` +
        '2 frozen legacy days loaded. Existing records and closed-day totals were kept.',
    );
  });

  it('every demo sale’s discount rows equal its discount figures', async () => {
    const sales = await salesOn(T);
    expect(sales).toHaveLength(11);
    for (const s of sales) {
      const rows = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, s.id));
      const took = (kind: 'manual' | 'promo') =>
        rows.filter((r) => r.kind === kind).reduce((acc, r) => acc + r.amountSatang, 0);
      expect(took('manual'), s.actionId!).toBe(s.manualDiscountSatang);
      expect(took('promo'), s.actionId!).toBe(s.promoDiscountSatang);
      expect(took('manual') + took('promo'), s.actionId!).toBe(s.discountSatang);
    }
    // The staff discount, as the till writes it: a reason, who, their name as it was.
    const [split] = sales.filter((s) => s.actionId === `demo-day/${T}/${DEMO_BRANCH_CODE}/split-cash-card`);
    const [manual] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, split!.id));
    expect(manual).toMatchObject({
      kind: 'manual',
      discountType: 'fixed',
      sequence: 1,
      valueSatang: 10_000,
      amountSatang: 10_000,
      percentBp: null,
      scope: 'order',
      code: null,
      reason: 'Loyalty',
      appliedByAccountId: somId,
      appliedByName: 'Som (Reception)',
      businessDate: T,
      branchId: demo,
    });
    expect(manual!.appliedAt!.toISOString()).toBe(split!.occurredAt.toISOString());
    // The voucher's discount names the voucher by its code, and nobody.
    const [voucherSale] = sales.filter((s) => s.actionId === `demo-day/${T}/${DEMO_BRANCH_CODE}/voucher-discount`);
    const [promo] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, voucherSale!.id));
    const [spent] = await ctx.db.select().from(voucher).where(eq(voucher.saleId, voucherSale!.id));
    expect(spent).toMatchObject({ source: 'booth', status: 'redeemed', redeemedStationId: voucherSale!.stationId });
    expect(promo).toMatchObject({
      kind: 'promo',
      discountType: 'fixed',
      amountSatang: 10_000,
      code: spent!.code,
      label: `100 THB Voucher (voucher …${spent!.code.slice(-4)})`,
      appliedByAccountId: null,
    });
  });

  it('the Discounts & Comps panel carries the day’s manual discount and agrees with the summary row', async () => {
    const day = (await platformDay(T))!;
    const counted = (await salesOn(T)).filter((s) => s.status === 'finalised' || s.status === 'refunded');
    expect(day.discountsSatang + day.compsSatang).toBe(counted.reduce((acc, s) => acc + s.discountSatang, 0));
    expect(day.discountsSatang).toBe(20_000);

    const panel = await report<DiscountReport>('reports/discounts', T);
    expect(panel).toMatchObject({ manualDiscountSatang: 10_000, promoSatang: 10_000, compSatang: 0 });
    expect(panel.manualDiscountSatang + panel.promoSatang + panel.compSatang).toBe(day.discountsSatang + day.compsSatang);
    expect(panel.byOperator).toEqual([
      { appliedBy: 'Som (Reception)', compCount: 0, compTotalSatang: 0, discountCount: 1, discountTotalSatang: 10_000 },
    ]);

    const listed = await report<DiscountTransactions>('reports/discounts/transactions', T);
    const [split] = (await salesOn(T)).filter((s) => s.actionId === `demo-day/${T}/${DEMO_BRANCH_CODE}/split-cash-card`);
    expect(listed.rows).toEqual([
      expect.objectContaining({
        transactionId: split!.receiptNumber,
        type: 'fixed',
        reason: 'Loyalty',
        amountSatang: 10_000,
        appliedBy: 'Som (Reception)',
      }),
    ]);
    expect(listed.promoRows).toHaveLength(1);
    expect(listed.promoRows[0]).toMatchObject({ amountSatang: 10_000, type: 'fixed' });
    // The whole code never leaves the voucher row.
    expect(listed.promoRows[0]!.code.startsWith('…')).toBe(true);
  });
});

describe('the demo day files a funnel at Demo Branch 2’s own booth', () => {
  it('the booth stands on a box nobody can sign in as and Health never lists', async () => {
    const booth = await demoBooth();
    expect(booth).toMatchObject({ kind: 'booth', codePrefix: 'DB', accessScope: 'selected_staff', archivedAt: null });
    const [stand] = await ctx.db.select().from(box).where(eq(box.id, booth.boxId!));
    expect(stand).toMatchObject({ branchId: demo, role: 'booth', registeredAt: null, secretHash: null, claimCodeHash: null });
    expect(stand!.archivedAt).not.toBeNull();
    const health = await get('/ops/health');
    expect(health.statusCode, health.body).toBe(200);
    const boxes = health.json<{ boxes: Array<{ branchId: string }> }>().boxes;
    expect(boxes.filter((b) => b.branchId === demo)).toEqual([]);
  });

  it('every press is shaped as the booth’s box reports one: a prize, its voucher, its paper — never simulated', async () => {
    const booth = await demoBooth();
    const spins = await ctx.db.select().from(spin).where(and(eq(spin.stationId, booth.id), eq(spin.businessDate, T)));
    expect(spins).toHaveLength(6);
    const vouchers = await ctx.db
      .select()
      .from(voucher)
      .where(inArray(voucher.id, spins.map((s) => s.voucherId!)));
    expect(vouchers).toHaveLength(6);
    for (const s of spins) {
      expect(s).toMatchObject({ branchId: demo, boxId: booth.boxId, outcome: 'prize', simulated: false, staffAccountId: somId });
      expect(s.prizeId).not.toBeNull();
      const v = vouchers.find((x) => x.id === s.voucherId)!;
      expect(v).toMatchObject({ branchId: demo, source: 'booth', issuedByAccountId: somId, printCount: 1 });
      expect(v.code).toMatch(/^DB[0-9A-Z]{9}$/);
      expect(v.issuedAt.toISOString()).toBe(s.occurredAt.toISOString());
      expect(v.expiresAt!.getTime()).toBeGreaterThan(v.issuedAt.getTime());
      const prints = await ctx.db.select().from(voucherPrint).where(eq(voucherPrint.voucherId, v.id));
      expect(prints).toEqual([expect.objectContaining({ reason: 'initial', stationId: booth.id, boxId: booth.boxId, requestedByAccountId: null })]);
    }
    // One of them spent at the till that afternoon; the rest still in families' hands.
    expect(vouchers.filter((v) => v.status === 'redeemed')).toHaveLength(1);
    expect(vouchers.filter((v) => v.status === 'issued')).toHaveLength(5);
  });

  it('the booth rollup fills the day’s fact from the seeded presses', async () => {
    const booth = await demoBooth();
    const facts = await boothFacts(T);
    // From the rows themselves, not from the rollup's own query.
    const { rows } = await ctx.db.execute<{ spins: number; issued: number; redeemed: number; lag: string; cost: string }>(sql`
      select count(*)::int as spins, count(v.id)::int as issued,
             (count(*) filter (where v.status = 'redeemed'))::int as redeemed,
             coalesce(sum(extract(epoch from (v.redeemed_at - v.issued_at))) filter (where v.status = 'redeemed'), 0)::bigint::text as lag,
             coalesce(sum(v.cost_satang), 0)::bigint::text as cost
        from booth.spin s left join promo.voucher v on v.id = s.voucher_id
       where s.station_id = ${booth.id}::uuid and s.business_date = ${T}::date and not s.simulated`);
    const direct = rows[0]!;
    expect(facts).toMatchObject({
      spins: direct.spins,
      issued: direct.issued,
      redeemed: direct.redeemed,
      lag: Number(direct.lag),
      cost: Number(direct.cost),
    });
    // 150 + 100 + 200 + 100 + 150 at the booth, and the 100 the voucher sale spent.
    expect(facts).toMatchObject({ spins: 6, issued: 6, redeemed: 1, cost: 80_000 });
    // Won at 11:10, spent at 13:55.
    expect(facts.lag).toBe(2 * 3600 + 45 * 60);
    expect(new Set(facts.rows.map((r) => r.boothId))).toEqual(new Set([booth.id]));
    expect(new Set(facts.rows.map((r) => r.staffAccountId))).toEqual(new Set([somId]));
    expect(facts.rows).toHaveLength(3);
  });

  it('Console > Booths > Report shows the spins, the funnel, the rate and the prize cost, and its CSV has the rows', async () => {
    const answer = await report<BoothReport>('booths', T);
    expect(answer.booths).toEqual([
      expect.objectContaining({
        name: DEMO_BOOTH_NAME,
        branchName: 'Demo Branch 2',
        spins: 6,
        prizesWon: 6,
        vouchersIssued: 6,
        vouchersRedeemed: 1,
        redemptionRate: 1 / 6,
        meanRedemptionLagS: 2 * 3600 + 45 * 60,
        prizeCostSatang: 80_000,
        prizeCostIncomplete: false,
      }),
    ]);
    expect(answer.prizes.map((p) => [p.name, p.prizesWon]).sort()).toEqual([
      ['100 THB Voucher', 3],
      ['150 THB Voucher', 2],
      ['200 THB Voucher', 1],
    ]);
    expect(answer.staff).toEqual([expect.objectContaining({ name: 'Som (Reception)', spins: 6 })]);
    expect(answer.days).toEqual([expect.objectContaining({ businessDate: T, spins: 6 })]);

    const csv = await get(`/analytics/booths/export?branches=${demo}&from=${T}&to=${T}`);
    expect(csv.statusCode, csv.body).toBe(200);
    const lines = csv.body.replace(String.fromCharCode(0xfeff), '').trim().split('\r\n');
    expect(lines).toHaveLength(4);
    for (const line of lines.slice(1)) {
      expect(line.startsWith(`"${T}","Demo Branch 2","${DEMO_BOOTH_NAME}","Som (Reception)"`)).toBe(true);
    }
  });
});

describe('a re-press converges: it tops up what a day lacks and never writes anything twice', () => {
  it('a second run adds nothing new', async () => {
    const before = await demoRowCounts();
    const again = await seedDemoDay(ctx.db);
    expect(again).toMatchObject({
      businessDate: T,
      sales: 0,
      skipped: 11,
      discounts: 0,
      discountsToppedUp: 0,
      boothSpins: 0,
      boothSpinsPresent: 6,
      legacyFixtureDays: 0,
    });
    const pressed = await post('/ops/test-controls/demo.day');
    expect(pressed.json<{ message: string }>().message).toBe(
      `Demo day ${T} at Demo Branch 2: 0 sales added, 11 already present; booth: 0 spins added, 6 already present. ` +
        'Existing records and closed-day totals were kept.',
    );
    expect(await demoRowCounts()).toEqual(before);
  });

  it('a day pressed before the fix gets its discount row, its presses and the frozen days — once', async () => {
    const P = addDaysToIsoDate(T, -3);
    await seedDemoDay(ctx.db, { on: P });
    const booth = await demoBooth();

    // Back to what a press before this fix left: no manual discount row, no
    // presses but the voucher sale's, and no frozen legacy days.
    const sales = await salesOn(P);
    await ctx.db.delete(saleDiscount).where(and(inArray(saleDiscount.saleId, sales.map((s) => s.id)), eq(saleDiscount.kind, 'manual')));
    const unspent = await ctx.db
      .select({ spinId: spin.id, voucherId: voucher.id })
      .from(spin)
      .innerJoin(voucher, eq(voucher.id, spin.voucherId))
      .where(and(eq(spin.stationId, booth.id), eq(spin.businessDate, P), eq(voucher.status, 'issued')));
    expect(unspent).toHaveLength(5);
    await ctx.db.delete(voucherPrint).where(inArray(voucherPrint.voucherId, unspent.map((u) => u.voucherId)));
    await ctx.db.delete(spin).where(inArray(spin.id, unspent.map((u) => u.spinId)));
    await ctx.db.delete(voucher).where(inArray(voucher.id, unspent.map((u) => u.voucherId)));
    await ctx.db.delete(dailySummary).where(and(eq(dailySummary.branchId, demo), ne(dailySummary.source, 'oto_pos')));
    // The day as it was rolled then: the walkthrough's two gaps.
    const operatorId = sales[0]!.operatorId;
    await ctx.db.execute(sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${demo}::uuid, ${P}::date, 'sales', 'test')`);
    await rollUp();
    expect((await platformDay(P))!.discountsSatang).toBe(20_000);
    expect((await report<DiscountReport>('reports/discounts', P)).manualDiscountSatang).toBe(0);
    expect((await boothFacts(P)).spins).toBe(1);

    // The re-press: what is missing, once, and said honestly.
    const counts = await seedDemoDay(ctx.db, { on: P });
    expect(counts).toMatchObject({
      sales: 0,
      skipped: 11,
      discounts: 1,
      discountsToppedUp: 1,
      boothSpins: 5,
      boothSpinsPresent: 1,
      legacyFixtureDays: 2,
    });
    expect(describeDemoDay(counts)).toBe(
      `Demo day ${P} at Demo Branch 2: 0 sales added, 11 already present (1 manual discount row added to them); ` +
        'booth: 5 spins added, 1 already present; 2 frozen legacy days loaded.',
    );
    // A discount row marks no day by trigger; the top-up marked it for the rollup.
    const marks = await ctx.db
      .select()
      .from(dirtyDate)
      .where(and(eq(dirtyDate.branchId, demo), eq(dirtyDate.businessDate, P), inArray(dirtyDate.kind, ['sales', 'booth'])));
    expect(marks.map((m) => m.kind).sort()).toEqual(['booth', 'sales']);

    await rollUp();
    const day = (await platformDay(P))!;
    const panel = await report<DiscountReport>('reports/discounts', P);
    expect(panel.manualDiscountSatang).toBe(10_000);
    expect(panel.manualDiscountSatang + panel.promoSatang + panel.compSatang).toBe(day.discountsSatang + day.compsSatang);
    expect(await boothFacts(P)).toMatchObject({ spins: 6, issued: 6, redeemed: 1, cost: 80_000 });
    expect(await ctx.db.select().from(dailySummary).where(ne(dailySummary.source, 'oto_pos'))).toHaveLength(2);

    // And again: nothing.
    const before = await demoRowCounts();
    expect(await seedDemoDay(ctx.db, { on: P })).toMatchObject({
      sales: 0,
      skipped: 11,
      discounts: 0,
      discountsToppedUp: 0,
      boothSpins: 0,
      boothSpinsPresent: 6,
      legacyFixtureDays: 0,
    });
    expect(await demoRowCounts()).toEqual(before);
  });

  it('no live park, and no live park’s booth, was touched by any of it', async () => {
    expect(await liveBoothState()).toEqual(liveBefore);
  });
});

describe('a database whose voucher types were since re-coded still gets a booth day', () => {
  it('the wheel is made of the types it has, re-weighted to 10,000, and a press of a missing one draws the first', async () => {
    // A fresh booth on such a database: the old one retired, the 200 type re-coded.
    const old = await demoBooth();
    await ctx.db.update(station).set({ archivedAt: new Date() }).where(eq(station.id, old.id));
    await ctx.db.update(voucherDefinition).set({ code: 'spin-voucher-200-recoded' }).where(eq(voucherDefinition.code, 'spin-voucher-200'));
    try {
      const Q = addDaysToIsoDate(T, -9);
      expect(await seedDemoDay(ctx.db, { on: Q })).toMatchObject({ sales: 11, boothSpins: 6, boothSpinsPresent: 0 });
      const booth = await demoBooth();
      expect(booth.id).not.toBe(old.id);
      const prizes = await ctx.db.select().from(boothPrize).where(eq(boothPrize.stationId, booth.id));
      expect(prizes.map((p) => [p.nameEn, p.weightBp]).sort()).toEqual([
        ['100 THB Voucher', 6250],
        ['150 THB Voucher', 3750],
      ]);
      const won = await ctx.db
        .select({ name: boothPrize.nameEn })
        .from(spin)
        .innerJoin(boothPrize, eq(boothPrize.id, spin.prizeId))
        .where(and(eq(spin.stationId, booth.id), eq(spin.businessDate, Q)));
      // The 12:40 press would have drawn the 200: it drew the 100.
      expect(won.map((w) => w.name).sort()).toEqual([
        '100 THB Voucher',
        '100 THB Voucher',
        '100 THB Voucher',
        '100 THB Voucher',
        '150 THB Voucher',
        '150 THB Voucher',
      ]);
    } finally {
      await ctx.db.update(voucherDefinition).set({ code: 'spin-voucher-200' }).where(eq(voucherDefinition.code, 'spin-voucher-200-recoded'));
    }
  });
});
