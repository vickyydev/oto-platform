import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  account,
  boothConfigVersion,
  boothDutyAssignment,
  boothPrize,
  box,
  employee,
  factBoothDaily,
  sale,
  saleDiscount,
  spin,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
  voucherPrint,
  voucherRedemption,
} from '@oto/db';
import { DEMO_BOOTH_NAME, DEMO_BOOTH_PREFIX, DEMO_BRANCH_CODE, describeDemoDay, seedDemoDay } from '@oto/db/seed';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  verifyBoothCode,
  type BoothReport,
  type DiscountReport,
} from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-15b (SCRUM-216) — REVIEW of the demo-day fix (the walkthrough's two gaps:
 * Manual discounts 0.00 beside a 200.00 summary, and "No spins in these days").
 *
 * The seed must write the rows the REAL paths write, never a private variant:
 *
 *   discount     a seeded manual discount is, column for column, the row the
 *                till's own commit writes for the same discount; a seeded
 *                booth voucher spent at the till leaves the promo row and the
 *                redemption ledger the till leaves for a real one
 *   booth        every seeded press would pass the checks `sync-booth.ts`
 *                makes of a box's report — its wheel, its prize, its voucher
 *                type on a published bundle, the prize's cost frozen, the
 *                box's expiry rule, the code's check character, the trading
 *                day, its paper and its roster row — and nothing is simulated
 *   convergence  a second and a third press, and two presses at once on a new
 *                day, write nothing twice and say so; every row the demo day
 *                owns keeps its bytes; the rollup run twice leaves the frozen
 *                legacy days, the booth fact and the discount report rows as
 *                they were (H10); no live park moves
 *   genuine      a seeded booth voucher is redeemed by the real till path, and
 *                the funnel then counts it on the day it was spun
 */

let ctx: TestContext;
let admin: string;
let reception: string;
let hkt: string;
let chalong: string;
let demo: string;
let operatorId: string;
let somId: string;
let T: string;
let firstMessage = '';

const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie: admin } });
const post = (cookie: string, url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function rollUp(): Promise<void> {
  const res = await post(admin, '/ops/test-controls/rollup.run');
  expect(res.statusCode, res.body).toBe(200);
}

async function pressDemoDay(): Promise<string> {
  const res = await post(admin, '/ops/test-controls/demo.day');
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ message: string }>().message;
}

async function demoBooth() {
  const [row] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, demo), eq(station.name, DEMO_BOOTH_NAME), isNull(station.archivedAt)));
  return row!;
}

async function demoSale(on: string, scenario: string) {
  const [row] = await ctx.db
    .select()
    .from(sale)
    .where(and(eq(sale.branchId, demo), eq(sale.businessDate, on), eq(sale.actionId, `demo-day/${on}/${DEMO_BRANCH_CODE}/${scenario}`)));
  return row!;
}

/** A row as Postgres holds it, and the transaction that last wrote it. */
async function rowsAsStored(table: string, where: string) {
  const { rows } = await ctx.db.execute<{ id: string; xmin: string; bytes: string }>(
    sql.raw(`select x.id::text as id, x.xmin::text as xmin, x::text as bytes from ${table} x where ${where} order by x.id`),
  );
  return rows;
}

/** Every row the demo day owns at Demo Branch 2, with its bytes and its xmin. */
async function demoDayRows() {
  const at = `branch_id = '${demo}'`;
  return {
    sale: await rowsAsStored('pos.sale', at),
    sale_line: await rowsAsStored('pos.sale_line', at),
    sale_discount: await rowsAsStored('pos.sale_discount', at),
    spin: await rowsAsStored('booth.spin', at),
    voucher: await rowsAsStored('promo.voucher', at),
    voucher_print: await rowsAsStored('booth.voucher_print', at),
    voucher_redemption: await rowsAsStored('promo.voucher_redemption', at),
    booth_duty_assignment: await rowsAsStored('booth.booth_duty_assignment', at),
    booth_prize: await rowsAsStored('booth.booth_prize', at),
    booth_config_version: await rowsAsStored('booth.booth_config_version', at),
    station: await rowsAsStored('core.station', at),
    box: await rowsAsStored('core.box', at),
    booth_staff_assignment: await rowsAsStored(
      'booth.booth_staff_assignment',
      `station_id in (select id from core.station where branch_id = '${demo}')`,
    ),
  };
}

/** Every row the live parks hold in the tables the demo day writes to. */
async function liveParkRows() {
  const at = `branch_id in ('${hkt}', '${chalong}')`;
  return {
    sale: await rowsAsStored('pos.sale', at),
    sale_discount: await rowsAsStored('pos.sale_discount', at),
    spin: await rowsAsStored('booth.spin', at),
    voucher: await rowsAsStored('promo.voucher', at),
    voucher_print: await rowsAsStored('booth.voucher_print', at),
    booth_duty_assignment: await rowsAsStored('booth.booth_duty_assignment', at),
    booth_prize: await rowsAsStored('booth.booth_prize', at),
    booth_config_version: await rowsAsStored('booth.booth_config_version', at),
    station: await rowsAsStored('core.station', at),
    box: await rowsAsStored('core.box', at),
  };
}

/** The analytics rows of Demo Branch 2 the rollup must not rewrite when nothing moved. */
async function demoAnalyticsRows() {
  const at = `branch_id = '${demo}'`;
  return {
    legacy: await rowsAsStored('analytics.daily_summary', `${at} and source <> 'oto_pos'`),
    platform: await rowsAsStored('analytics.daily_summary', `${at} and source = 'oto_pos'`),
    booth: await rowsAsStored('analytics.fact_booth_daily', at),
    discounts: await rowsAsStored('analytics.daily_discount_summary', at),
  };
}

/** What the till records that the seed cannot share: ids, the sale it hangs off, and clocks. */
function shapeOf<R extends Record<string, unknown>>(row: R, drop: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)));
}
const PER_SALE = ['id', 'saleId', 'branchId', 'businessDate', 'appliedAt', 'createdAt', 'updatedAt'];

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [som] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  somId = som!.id;
  operatorId = som!.operatorId;
  T = businessDate(new Date(), 'Asia/Bangkok', parseDayStart('05:00'));
  firstMessage = await pressDemoDay();
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  await rollUp();
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- (2) The booth activity against what the booth's sync files --------------------------

describe('every seeded press is one sync-booth would have filed from a box', () => {
  it('the first press says what it wrote, and the booth is Demo Branch 2’s own', async () => {
    expect(firstMessage).toBe(
      `Demo day ${T} at Demo Branch 2: 11 sales added, 0 already present; booth: 6 spins added, 0 already present; ` +
        '2 frozen legacy days loaded. Existing records and closed-day totals were kept.',
    );
    const booth = await demoBooth();
    expect(booth).toMatchObject({ branchId: demo, operatorId, kind: 'booth', codePrefix: DEMO_BOOTH_PREFIX });
    const [stand] = await ctx.db.select().from(box).where(eq(box.id, booth.boxId!));
    expect(stand).toMatchObject({ branchId: demo, operatorId, role: 'booth' });
    // No other booth of the operator prints under the same prefix (the Console's own rule).
    const sharing = await ctx.db
      .select({ id: station.id })
      .from(station)
      .where(and(eq(station.operatorId, operatorId), eq(station.kind, 'booth'), eq(station.codePrefix, DEMO_BOOTH_PREFIX), isNull(station.archivedAt)));
    expect(sharing.map((s) => s.id)).toEqual([booth.id]);
  });

  it('wheel, prize, voucher type, cost, expiry, code, trading day, paper and roster all hold as the handlers require', async () => {
    const booth = await demoBooth();
    const [where] = (
      await ctx.db.execute<{ timezone: string; day_start: string }>(
        sql`select timezone, business_day_start::text as day_start from core.branch where id = ${demo}::uuid`,
      )
    ).rows;
    expect(where!.timezone).toBe('Asia/Bangkok');
    const spins = await ctx.db.select().from(spin).where(eq(spin.stationId, booth.id)).orderBy(asc(spin.occurredAt));
    expect(spins).toHaveLength(6);
    const [som] = await ctx.db
      .select({ name: employee.name, nickname: employee.nickname })
      .from(account)
      .innerJoin(employee, eq(employee.id, account.employeeId))
      .where(eq(account.id, somId));
    for (const s of spins) {
      const label = `spin ${s.id} at ${s.occurredAt.toISOString()}`;
      // H12: a child at the wheel, never the #debug run; a prize, with its voucher.
      expect(s, label).toMatchObject({ simulated: false, clockSuspect: false, outcome: 'prize', operatorId, branchId: demo, boxId: booth.boxId, staffAccountId: somId });
      // The trading day as `prepareEvent` resolves it from the branch's own day start.
      expect(s.businessDate, label).toBe(businessDate(s.occurredAt, where!.timezone, parseDayStart(where!.day_start)));
      expect(s.businessDate, label).toBe(T);

      // BOOTH_CONFIG_VERSION_UNKNOWN: the wheel that drew is this booth's.
      const [version] = await ctx.db.select().from(boothConfigVersion).where(eq(boothConfigVersion.id, s.boothConfigVersionId));
      expect(version!.stationId, label).toBe(booth.id);
      // BOOTH_PRIZE_NOT_ON_BOOTH, and more: the slice is on the very bundle that drew.
      const [prize] = await ctx.db.select().from(boothPrize).where(eq(boothPrize.id, s.prizeId!));
      expect(prize!.stationId, label).toBe(booth.id);
      const bundle = version!.bundle as { prizes: Array<{ id: string; costSatang: number; voucherDefinitionId: string }> };
      expect(bundle.prizes.map((p) => p.id), label).toContain(prize!.id);

      const [v] = await ctx.db.select().from(voucher).where(eq(voucher.id, s.voucherId!));
      expect(v, label).toMatchObject({
        operatorId,
        branchId: demo,
        source: 'booth',
        voucherDefinitionId: prize!.voucherDefinitionId,
        issuedByAccountId: somId,
        memberId: null,
      });
      // BOOTH_VOUCHER_TYPE_NOT_ON_WHEEL: the type is on a published bundle of this booth.
      const onWheel = await ctx.db
        .select({ id: boothConfigVersion.id })
        .from(boothConfigVersion)
        .where(
          and(
            eq(boothConfigVersion.stationId, booth.id),
            sql`${boothConfigVersion.bundle} @> ${JSON.stringify({ prizes: [{ voucherDefinitionId: v!.voucherDefinitionId }] })}::jsonb`,
          ),
        );
      expect(onWheel.length, label).toBeGreaterThan(0);
      // The prize's cost, frozen on the voucher as the box sends it; a real figure.
      expect(v!.costSatang, label).toBe(prize!.costSatang);
      expect(v!.costSatang, label).toBe(bundle.prizes.find((p) => p.id === prize!.id)!.costSatang);
      expect(v!.costSatang, label).toBeGreaterThan(0);
      // Issued at the press, by the person signed in at the booth.
      expect(v!.issuedAt.toISOString(), label).toBe(s.occurredAt.toISOString());
      // The box's expiry: the end of (the day it was won + the prize's days, else its type's), Bangkok time.
      const [type] = await ctx.db.select().from(voucherDefinition).where(eq(voucherDefinition.id, v!.voucherDefinitionId));
      const days = prize!.expiryDays ?? type!.expiryDays ?? null;
      if (days === null) {
        expect(v!.expiresAt, label).toBeNull();
      } else {
        const wonOn = new Date(v!.issuedAt.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
        expect(v!.expiresAt!.getTime(), label).toBe(Date.parse(`${addDaysToIsoDate(wonOn, days)}T23:59:59.999+07:00`));
      }
      // A code the booth could have printed: its prefix, the alphabet, the check character.
      expect(verifyBoothCode(v!.code), `${label} ${v!.code}`).toEqual({ ok: true, prefix: DEMO_BOOTH_PREFIX });

      // The paper: the automatic first print, nobody asked for it, and the count says one copy.
      const prints = await ctx.db.select().from(voucherPrint).where(eq(voucherPrint.voucherId, v!.id));
      expect(prints, label).toHaveLength(1);
      expect(prints[0], label).toMatchObject({ reason: 'initial', requestedByAccountId: null, stationId: booth.id, boxId: booth.boxId, branchId: demo, operatorId });
      expect(prints[0]!.printJobId, label).not.toBeNull();
      expect(v!.printCount, label).toBe(prints.length);
      // One spin per voucher (spin_voucher_unique), and that spin is this booth's (BOOTH_VOUCHER_NOT_THIS_BOOTHS).
      const claims = await ctx.db.select({ id: spin.id, stationId: spin.stationId }).from(spin).where(eq(spin.voucherId, v!.id));
      expect(claims, label).toEqual([{ id: s.id, stationId: booth.id }]);
    }

    // The roster: the person signed in joins the day once, named as `selfAssignBoothDuty` names her.
    const roster = await ctx.db
      .select()
      .from(boothDutyAssignment)
      .where(and(eq(boothDutyAssignment.stationId, booth.id), eq(boothDutyAssignment.businessDate, T)));
    expect(roster).toEqual([
      expect.objectContaining({ accountId: somId, source: 'self_assigned', displayName: som!.nickname?.trim() || som!.name.trim(), branchId: demo }),
    ]);
  });

  it('the one redeemed voucher was spent as the till spends one: held, applied, consumed, then named by its sale', async () => {
    const booth = await demoBooth();
    const redeemed = await ctx.db
      .select({ v: voucher })
      .from(spin)
      .innerJoin(voucher, eq(voucher.id, spin.voucherId))
      .where(and(eq(spin.stationId, booth.id), eq(voucher.status, 'redeemed')));
    expect(redeemed).toHaveLength(1);
    const v = redeemed[0]!.v;
    const spent = await demoSale(T, 'voucher-discount');
    expect(v).toMatchObject({
      saleId: spent.id,
      redeemedBranchId: demo,
      redeemedStationId: spent.stationId,
      redeemedByAccountId: spent.createdByAccountId,
      heldSaleId: null,
      heldStationId: null,
      heldByAccountId: null,
      heldAt: null,
    });
    expect(v.redeemedAt!.toISOString()).toBe(spent.occurredAt.toISOString());
    expect(v.redeemedAt!.getTime()).toBeGreaterThan(v.issuedAt.getTime());
    expect(v.expiresAt === null || v.redeemedAt!.getTime() <= v.expiresAt.getTime()).toBe(true);
    const ledger = await ctx.db
      .select()
      .from(voucherRedemption)
      .where(eq(voucherRedemption.voucherId, v.id))
      .orderBy(asc(voucherRedemption.occurredAt), asc(voucherRedemption.kind));
    expect(ledger.map((r) => r.kind).sort()).toEqual(['applied', 'consumed', 'held']);
    for (const r of ledger) {
      expect(r).toMatchObject({ saleId: spent.id, branchId: demo, stationId: spent.stationId, accountId: spent.createdByAccountId, operatorId });
    }
    const at = (kind: string) => ledger.find((r) => r.kind === kind)!.occurredAt.getTime();
    expect(at('held')).toBeLessThan(at('applied'));
    expect(at('consumed')).toBe(v.redeemedAt!.getTime());
  });

  it('the booth fact equals the rows, the report serves it, and no spin or voucher was filed at a live park', async () => {
    const booth = await demoBooth();
    const facts = await ctx.db.select().from(factBoothDaily).where(and(eq(factBoothDaily.branchId, demo), eq(factBoothDaily.businessDate, T)));
    const sum = (k: 'spins' | 'vouchersIssued' | 'vouchersRedeemed' | 'redemptionLagSumS' | 'prizeCostSatang') =>
      facts.reduce((acc, r) => acc + Number(r[k]), 0);
    // By hand, from the vouchers, never through the rollup's own query.
    const vouchers = await ctx.db
      .select({ v: voucher })
      .from(spin)
      .innerJoin(voucher, eq(voucher.id, spin.voucherId))
      .where(and(eq(spin.stationId, booth.id), eq(spin.businessDate, T), eq(spin.simulated, false)));
    const redeemed = vouchers.filter((r) => r.v.status === 'redeemed');
    expect({
      spins: sum('spins'),
      issued: sum('vouchersIssued'),
      redeemed: sum('vouchersRedeemed'),
      lag: sum('redemptionLagSumS'),
      cost: sum('prizeCostSatang'),
    }).toEqual({
      spins: vouchers.length,
      issued: vouchers.length,
      redeemed: redeemed.length,
      lag: redeemed.reduce((acc, r) => acc + Math.round((r.v.redeemedAt!.getTime() - r.v.issuedAt.getTime()) / 1000), 0),
      cost: vouchers.reduce((acc, r) => acc + r.v.costSatang, 0),
    });
    expect(facts.every((f) => f.boothId === booth.id && f.operatorId === operatorId)).toBe(true);
    const res = await get(`/analytics/booths?branches=${demo}&from=${T}&to=${T}`);
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json() as BoothReport;
    expect(report.booths).toEqual([
      expect.objectContaining({ boothId: booth.id, spins: 6, vouchersIssued: 6, vouchersRedeemed: 1, prizeCostSatang: sum('prizeCostSatang'), prizeCostIncomplete: false }),
    ]);
    // The live parks' booths were never pressed: no spin, voucher or print there at all.
    const { rows } = await ctx.db.execute<{ n: number }>(sql`
      select (select count(*) from booth.spin where branch_id in (${hkt}::uuid, ${chalong}::uuid))
           + (select count(*) from booth.voucher_print where branch_id in (${hkt}::uuid, ${chalong}::uuid))
           + (select count(*) from promo.voucher where branch_id in (${hkt}::uuid, ${chalong}::uuid) and source = 'booth') as n`);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

// --- (3) Convergence -------------------------------------------------------------------------

describe('a re-press writes nothing twice, keeps every byte, and says so; the rollup twice leaves the frozen rows alone', () => {
  it('a second press, direct and through Health, moves no row the demo day owns and no live park row', async () => {
    const before = await demoDayRows();
    const parks = await liveParkRows();
    const again = await seedDemoDay(ctx.db);
    expect(again).toMatchObject({
      businessDate: T,
      sales: 0,
      skipped: 11,
      lines: 0,
      attempts: 0,
      discounts: 0,
      discountsToppedUp: 0,
      boothSpins: 0,
      boothSpinsPresent: 6,
      legacyFixtureDays: 0,
    });
    expect(describeDemoDay(again)).toBe(`Demo day ${T} at Demo Branch 2: 0 sales added, 11 already present; booth: 0 spins added, 6 already present.`);
    expect(await pressDemoDay()).toBe(
      `Demo day ${T} at Demo Branch 2: 0 sales added, 11 already present; booth: 0 spins added, 6 already present. ` +
        'Existing records and closed-day totals were kept.',
    );
    // Not one row rewritten, let alone duplicated.
    expect(await demoDayRows()).toEqual(before);
    expect(await liveParkRows()).toEqual(parks);
  });

  it('no sale carries two manual discount rows, no voucher two spins or two first prints', async () => {
    const { rows } = await ctx.db.execute<{ what: string; n: number }>(sql`
      select 'manual' as what, count(*)::int as n from (
        select sale_id from pos.sale_discount where kind = 'manual' group by sale_id having count(*) > 1) x
      union all select 'promo', count(*)::int from (
        select sale_id from pos.sale_discount where kind = 'promo' group by sale_id having count(*) > 1) x
      union all select 'sequence', count(*)::int from (
        select sale_id, sequence from pos.sale_discount group by sale_id, sequence having count(*) > 1) x
      union all select 'spin', count(*)::int from (
        select voucher_id from booth.spin where voucher_id is not null group by voucher_id having count(*) > 1) x
      union all select 'print', count(*)::int from (
        select voucher_id from booth.voucher_print where reason = 'initial' group by voucher_id having count(*) > 1) x
      union all select 'action', count(*)::int from (
        select station_id, action_id from pos.sale where action_id is not null group by station_id, action_id having count(*) > 1) x
      union all select 'redemption', count(*)::int from (
        select voucher_id, kind from promo.voucher_redemption group by voucher_id, kind having count(*) > 1) x`);
    expect(Object.fromEntries(rows.map((r) => [r.what, Number(r.n)]))).toEqual({
      manual: 0,
      promo: 0,
      sequence: 0,
      spin: 0,
      print: 0,
      action: 0,
      redemption: 0,
    });
  });

  it('H10 rerun: the rollup twice more leaves the frozen days, the booth fact and the discount rows byte-identical', async () => {
    const before = await demoAnalyticsRows();
    expect(before.legacy).toHaveLength(2);
    expect(before.booth.length).toBeGreaterThan(0);
    expect(before.discounts.length).toBeGreaterThan(0);
    await rollUp();
    await rollUp();
    const after = await demoAnalyticsRows();
    expect(after.legacy).toEqual(before.legacy);
    expect(after.booth).toEqual(before.booth);
    expect(after.discounts).toEqual(before.discounts);
    expect(after.platform).toEqual(before.platform);
  });

  it('the panel and the summary row still agree for the day, to the satang', async () => {
    const { rows } = await ctx.db.execute<{ discounts: string; comps: string }>(sql`
      select discounts_satang::text as discounts, comps_satang::text as comps from analytics.daily_summary
       where branch_id = ${demo}::uuid and business_date = ${T}::date and source = 'oto_pos'`);
    const res = await get(`/analytics/reports/discounts?branches=${demo}&from=${T}&to=${T}`);
    expect(res.statusCode, res.body).toBe(200);
    const panel = res.json() as DiscountReport;
    expect(panel.manualDiscountSatang + panel.promoSatang + panel.compSatang).toBe(Number(rows[0]!.discounts) + Number(rows[0]!.comps));
    expect(panel).toMatchObject({ manualDiscountSatang: 10_000, promoSatang: 10_000, compSatang: 0 });
    // The panel's by-operator total is the manual rows' own sum, applied by whoever rang the sale.
    const split = await demoSale(T, 'split-cash-card');
    expect(panel.byOperator).toEqual([
      expect.objectContaining({ appliedBy: 'Som (Reception)', discountCount: 1, discountTotalSatang: split.manualDiscountSatang }),
    ]);
  });

  it('two presses at once on a new day write each sale, discount row and press exactly once, and their counts add up', async () => {
    const P = addDaysToIsoDate(T, -5);
    const parks = await liveParkRows();
    const [a, b] = await Promise.all([seedDemoDay(ctx.db, { on: P }), seedDemoDay(ctx.db, { on: P })]);
    expect(a.sales + b.sales).toBe(11);
    expect(a.sales + a.skipped).toBe(11);
    expect(b.sales + b.skipped).toBe(11);
    expect(a.discounts + b.discounts).toBe(1);
    expect(a.discountsToppedUp + b.discountsToppedUp).toBe(0);
    expect(a.boothSpins + b.boothSpins).toBe(6);
    expect(a.boothSpins + a.boothSpinsPresent).toBe(6);
    expect(b.boothSpins + b.boothSpinsPresent).toBe(6);

    const booth = await demoBooth();
    const sales = await ctx.db.select().from(sale).where(and(eq(sale.branchId, demo), eq(sale.businessDate, P)));
    expect(sales).toHaveLength(11);
    const manual = await ctx.db
      .select()
      .from(saleDiscount)
      .where(and(inArray(saleDiscount.saleId, sales.map((s) => s.id)), eq(saleDiscount.kind, 'manual')));
    expect(manual).toHaveLength(1);
    const spins = await ctx.db.select().from(spin).where(and(eq(spin.stationId, booth.id), eq(spin.businessDate, P)));
    expect(spins).toHaveLength(6);
    expect(new Set(spins.map((s) => s.voucherId)).size).toBe(6);
    const prints = await ctx.db.select().from(voucherPrint).where(inArray(voucherPrint.voucherId, spins.map((s) => s.voucherId!)));
    expect(prints).toHaveLength(6);
    const roster = await ctx.db
      .select()
      .from(boothDutyAssignment)
      .where(and(eq(boothDutyAssignment.stationId, booth.id), eq(boothDutyAssignment.businessDate, P)));
    expect(roster).toHaveLength(1);
    // One booth, one wheel, one staff row, however many presses raced to make them.
    expect(await ctx.db.select().from(station).where(and(eq(station.branchId, demo), eq(station.kind, 'booth')))).toHaveLength(1);
    expect(await ctx.db.select().from(boothPrize).where(eq(boothPrize.stationId, booth.id))).toHaveLength(3);
    expect(await ctx.db.select().from(boothConfigVersion).where(eq(boothConfigVersion.stationId, booth.id))).toHaveLength(1);
    expect(await liveParkRows()).toEqual(parks);
  });
});

// --- (1) The discount rows against the till's own ----------------------------------------

describe('the seeded discount rows are the till’s own rows', () => {
  let tillId: string;
  let packageId: string;

  beforeAll(async () => {
    const [till] = await ctx.db
      .select({ id: station.id })
      .from(station)
      .where(and(eq(station.branchId, hkt), eq(station.name, 'Reception Till 1')));
    tillId = till!.id;
    const [pkg] = await ctx.db
      .select({ id: ticketPackage.id })
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, hkt), eq(ticketPackage.name, '2 Hours Play')));
    packageId = pkg!.id;
    await takeStation(ctx.app, reception, tillId);
  });

  it('a manual discount: the same columns as the till writes for 100.00 off the order for Loyalty, by the same person', async () => {
    const realId = newId();
    const rung = await post(reception, '/sales', {
      id: realId,
      stationId: tillId,
      lines: [{ id: newId(), packageId, kids: 1, adults: 1 }],
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'fixed', value: 10_000, reason: 'Loyalty' }],
    });
    expect(rung.statusCode, rung.body).toBe(200);
    const paid = await post(reception, `/sales/${realId}/finalise`, { actionId: newId(), method: 'cash' });
    expect(paid.statusCode, paid.body).toBe(200);

    const real = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, realId));
    const split = await demoSale(T, 'split-cash-card');
    const seeded = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, split.id));
    expect(real).toHaveLength(1);
    expect(seeded).toHaveLength(1);
    expect(shapeOf(seeded[0]!, PER_SALE)).toEqual(shapeOf(real[0]!, PER_SALE));
    // Each row hangs off its own sale's branch, day and seller, as the till's does.
    const [realSale] = await ctx.db.select().from(sale).where(eq(sale.id, realId));
    for (const [row, of] of [
      [seeded[0]!, split],
      [real[0]!, realSale!],
    ] as const) {
      expect(row.branchId).toBe(of.branchId);
      expect(row.businessDate).toBe(of.businessDate);
      expect(row.appliedByAccountId).toBe(of.createdByAccountId);
      expect(row.amountSatang).toBe(of.manualDiscountSatang);
    }
  });

  it('a booth voucher spent at the till: the seeded voucher sale’s promo row and ledger are the ones the till leaves', async () => {
    const booth = await demoBooth();
    // An unspent 100 THB voucher the demo booth printed this morning, spent through the real path.
    const [unspent] = await ctx.db
      .select({ v: voucher })
      .from(spin)
      .innerJoin(voucher, eq(voucher.id, spin.voucherId))
      .innerJoin(voucherDefinition, eq(voucherDefinition.id, voucher.voucherDefinitionId))
      .where(
        and(
          eq(spin.stationId, booth.id),
          eq(spin.businessDate, T),
          eq(voucher.status, 'issued'),
          eq(voucherDefinition.code, 'spin-voucher-100'),
        ),
      )
      .limit(1);
    expect(unspent, 'the demo booth printed no unspent 100 THB voucher today').toBeTruthy();
    const code = unspent!.v.code;
    const realId = newId();
    const held = await post(reception, `/sales/${realId}/vouchers`, { code });
    expect(held.statusCode, held.body).toBe(200);
    const rung = await post(reception, '/sales', {
      id: realId,
      stationId: tillId,
      lines: [{ id: newId(), packageId, kids: 1, adults: 1 }],
      promoCodes: [code],
    });
    expect(rung.statusCode, rung.body).toBe(200);
    const paid = await post(reception, `/sales/${realId}/finalise`, { actionId: newId(), method: 'cash' });
    expect(paid.statusCode, paid.body).toBe(200);

    const real = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, realId));
    const spent = await demoSale(T, 'voucher-discount');
    const seeded = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, spent.id));
    expect(real).toHaveLength(1);
    expect(seeded).toHaveLength(1);
    const drop = [...PER_SALE, 'code', 'label'];
    expect(shapeOf(seeded[0]!, drop)).toEqual(shapeOf(real[0]!, drop));
    // Named by its own voucher's code, labelled as the till labels one.
    const [seededVoucher] = await ctx.db.select().from(voucher).where(eq(voucher.saleId, spent.id));
    const [realVoucher] = await ctx.db.select().from(voucher).where(eq(voucher.id, unspent!.v.id));
    for (const [row, v] of [
      [seeded[0]!, seededVoucher!],
      [real[0]!, realVoucher!],
    ] as const) {
      expect(row.code).toBe(v.code);
      expect(row.label).toBe(`100 THB Voucher (voucher …${v.code.slice(-4)})`);
    }
    // The voucher ends as the till leaves one, and so does its ledger.
    const voucherDrop = ['id', 'code', 'saleId', 'issuedAt', 'expiresAt', 'redeemedAt', 'redeemedBranchId', 'redeemedStationId', 'createdAt', 'updatedAt'];
    expect(shapeOf(seededVoucher!, voucherDrop)).toEqual(shapeOf(realVoucher!, voucherDrop));
    expect(realVoucher).toMatchObject({ status: 'redeemed', saleId: realId });
    const kinds = async (voucherId: string) =>
      (await ctx.db.select({ kind: voucherRedemption.kind }).from(voucherRedemption).where(eq(voucherRedemption.voucherId, voucherId)))
        .map((r) => r.kind)
        .sort();
    expect(await kinds(seededVoucher!.id)).toEqual(await kinds(realVoucher!.id));
  });

  it('the funnel then counts the real redemption on the day the voucher was spun, beside the seeded one', async () => {
    await rollUp();
    const res = await get(`/analytics/booths?branches=${demo}&from=${T}&to=${T}`);
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json() as BoothReport;
    expect(report.booths).toEqual([expect.objectContaining({ spins: 6, vouchersIssued: 6, vouchersRedeemed: 2, redemptionRate: 2 / 6 })]);
  });
});

// --- After a demo reset -----------------------------------------------------------------------

describe('after Reset demo data, a re-press is truthful and duplicates nothing', () => {
  it('the sales come back once, the booth keeps its record, and the voucher sale wins a voucher of its own', async () => {
    const booth = await demoBooth();
    const reset = await post(admin, '/ops/demo-reset', { confirm: 'RESET DEMO DATA' });
    expect(reset.statusCode, reset.body).toBe(200);
    const spinsBefore = await ctx.db.select().from(spin).where(and(eq(spin.stationId, booth.id), eq(spin.businessDate, T)));
    expect(spinsBefore).toHaveLength(6);

    const counts = await seedDemoDay(ctx.db);
    expect(counts).toMatchObject({ sales: 11, skipped: 0, discounts: 1, discountsToppedUp: 0, boothSpins: 1, boothSpinsPresent: 6 });
    const spins = await ctx.db.select().from(spin).where(and(eq(spin.stationId, booth.id), eq(spin.businessDate, T)));
    expect(spins).toHaveLength(7);
    expect(new Set(spins.map((s) => s.voucherId)).size).toBe(7);
    const spent = await demoSale(T, 'voucher-discount');
    const [won] = await ctx.db.select().from(voucher).where(eq(voucher.saleId, spent.id));
    expect(won).toMatchObject({ source: 'booth', status: 'redeemed' });
    expect(spins.map((s) => s.voucherId)).toContain(won!.id);
    const again = await seedDemoDay(ctx.db);
    expect(again).toMatchObject({ sales: 0, skipped: 11, discounts: 0, boothSpins: 0, boothSpinsPresent: 7 });
  });
});
