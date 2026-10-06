import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  account,
  boothConfigVersion,
  boothPrize,
  branch,
  dailyCategorySummary,
  dailyDiscountSummary,
  dailyItemSummary,
  dailySummary,
  dailyTenderSummary,
  dailyTicketSummary,
  dirtyDate,
  employee,
  factBoothDaily,
  sale,
  saleDiscount,
  saleLine,
  spin,
  station,
  ticketPackage,
  voucher,
} from '@oto/db';
import {
  businessDate,
  mintBoothCode,
  newId,
  parseDayStart,
  type BoothReport,
  type DiscountTransactions,
  type SalesReport,
  type TaxBreakdown,
  type TaxReceipts,
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
import { runDailyRollupJob, runHourlyRollupJob } from '../src/services/analytics-rollup';
import { runBoothRollupJob } from '../src/services/analytics-booth';

/**
 * S2-15b (SCRUM-216) rounds 4-5 — THE REVIEW (lane G, focused).
 *
 * A day is rung up through the real routes at TWO parks — Central Floresta
 * (reception at T1: a plain ticket sale, a child's drop-off stay, a booth
 * voucher spent at home) and Robinson Chalong (its manager at T3: a ticket
 * sale, and a voucher spun at Central's booth and spent at Chalong) — then the
 * Reports panels, the booth fact, the booth report and its CSV are attacked.
 *
 * Kept as `it.fails` by the review (the repo's gate convention: each states
 * the CORRECT behaviour and failed until the fix round flipped it to `it`;
 * both hold since):
 *
 *   (R1) THE TICKET TYPE BREAKDOWN LEAVES OUT A CHILD'S STAY. The prototype's
 *        live drop-off line (`lib/dropoff.ts` makeDropOffLine) is the child's
 *        own play ticket (`ticketType` = the 2 Hours ticket, kids 1) carrying a
 *        `dropOff` block, and `ticketTypeSalesRows` counts it under that ticket
 *        — it leaves out only the seed's synthetic `svc-dropoff` SERVICE line
 *        and event passes. `summariseReportDayV1` skips the whole stay cart
 *        line instead, so the child, the line and the ticket's own price are
 *        missing from "Ticket type breakdown" (the drop-off FEE stays out, as
 *        the prototype's row comment says).
 *   (R2) A VOUCHER LABEL IN THE OLD FORM REACHES THE REPORT WHOLE. A sale's
 *        read rewrites a label that still names the whole code
 *        (`maskedVoucherLineLabel`, SCRUM-433: "no answer carries the whole
 *        code whatever a row says"); the report rollup stores the label as it
 *        is in `daily_discount_summary` (label and key) and the transactions
 *        list answers it as it is.
 *
 * Attacks that held (`it`): branch scope on every route and the export with
 * real rows at both parks and a foreign operator; the booth fact against the
 * spins and vouchers written, with a voucher redeemed at another park; the
 * booth CSV's guard on + - @ and a tab; a frozen day never rewritten; two
 * concurrent rollups; a day that ends rewrites no report row.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let chalongManager: string;
let admin: string;
let foreignAdmin: string;
let operatorId: string;
let central: string;
let chalong: string;
let foreign: string;
let centralTill: string;
let chalongTill: string;
let boothId: string;
let boxId: string;
let versionId: string;
let receptionAccountId: string;
let managerAccountId: string;
let T: string;
let TC: string;
type Prize = typeof boothPrize.$inferSelect;
let p100: Prize;
let p150: Prize;

const centralSales: string[] = [];
const chalongSales: string[] = [];
let stayCartLineId: string;
let homeVoucher: { id: string; code: string };
let awayVoucher: { id: string; code: string };

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  foreign = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  const parks = await ctx.db.select().from(branch).where(inArray(branch.id, [central, chalong]));
  const clockOf = (id: string) => parks.find((p) => p.id === id)!;
  T = businessDate(new Date(), clockOf(central).timezone, parseDayStart(clockOf(central).businessDayStart));
  TC = businessDate(new Date(), clockOf(chalong).timezone, parseDayStart(clockOf(chalong).businessDayStart));
  operatorId = clockOf(central).operatorId;
  centralTill = await tillAt(central);
  chalongTill = await tillAt(chalong);
  await takeStation(ctx.app, reception, centralTill);
  await takeStation(ctx.app, chalongManager, chalongTill);
  const [booth] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.name, 'Booth 1')));
  boothId = booth!.id;
  boxId = booth!.boxId!;
  const [version] = await ctx.db
    .select()
    .from(boothConfigVersion)
    .where(eq(boothConfigVersion.stationId, boothId))
    .orderBy(desc(boothConfigVersion.version))
    .limit(1);
  versionId = version!.id;
  const prizes = await ctx.db.select().from(boothPrize).where(eq(boothPrize.stationId, boothId));
  p100 = prizes.find((p) => p.nameEn === '100 THB Voucher')!;
  p150 = prizes.find((p) => p.nameEn === '150 THB Voucher')!;
  const [a] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  const [m] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  receptionAccountId = a!.id;
  managerAccountId = m!.id;
  await rollAll();
  await runBoothRollupJob(ctx.db, new Date());

  // --- The day ---------------------------------------------------------------
  // Central: a plain 2 Hours sale; a child's drop-off stay on its own sale.
  centralSales.push(await cashSale(reception, centralTill, [{ id: newId(), packageId: await packageAt(central, '2 Hours Play'), kids: 2, adults: 1 }]));
  stayCartLineId = await registerStay();
  centralSales.push(
    await cashSale(reception, centralTill, [
      {
        id: stayCartLineId,
        packageId: await packageAt(central, '2 Hours Play'),
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
      },
    ]),
  );
  // Chalong: a Full Day sale.
  chalongSales.push(await cashSale(chalongManager, chalongTill, [{ id: newId(), packageId: await packageAt(chalong, 'Full Day Pass'), kids: 3, adults: 2 }]));

  // The booth at Central: two wins and a miss today, one win by nobody signed in.
  homeVoucher = await press(receptionAccountId, p150);
  awayVoucher = await press(managerAccountId, p100);
  await press(receptionAccountId, null);
  await press(null, p100);
  // One spent at home, one spent at Chalong.
  centralSales.push(await voucherSale(reception, centralTill, central, homeVoucher.code));
  chalongSales.push(await voucherSale(chalongManager, chalongTill, chalong, awayVoucher.code));

  await rollAll();
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers -----------------------------------------------------------------------------

const post = (cookie: string, url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });

const get = (cookie: string, path: string, query: string) =>
  ctx.app.inject({ method: 'GET', url: `/analytics/${path}?${query}`, headers: { cookie } });

/** A CSV body without the byte-order mark the export opens with. */
const unBom = (body: string): string => (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);

async function read<T>(cookie: string, path: string, query: string): Promise<T> {
  const res = await get(cookie, path, query);
  expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
  return res.json() as T;
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

async function cashSale(cookie: string, stationId: string, lines: Array<Record<string, unknown>>): Promise<string> {
  const id = newId();
  const committed = await post(cookie, '/sales', { id, stationId, lines });
  expect(committed.statusCode, committed.body).toBe(200);
  const paid = await post(cookie, `/sales/${id}/finalise`, { actionId: newId(), method: 'cash' });
  expect(paid.statusCode, paid.body).toBe(200);
  return id;
}

async function voucherSale(cookie: string, stationId: string, branchId: string, code: string): Promise<string> {
  const id = newId();
  const held = await post(cookie, `/sales/${id}/vouchers`, { code });
  expect(held.statusCode, held.body).toBe(200);
  const committed = await post(cookie, '/sales', {
    id,
    stationId,
    lines: [{ id: newId(), packageId: await packageAt(branchId, '2 Hours Play'), kids: 1, adults: 1 }],
    promoCodes: [code],
  });
  expect(committed.statusCode, committed.body).toBe(200);
  const paid = await post(cookie, `/sales/${id}/finalise`, { actionId: newId(), method: 'cash' });
  expect(paid.statusCode, paid.body).toBe(200);
  return id;
}

async function registerStay(): Promise<string> {
  const res = await post(reception, '/checkin/registrations', {
    id: newId(),
    branchId: central,
    stationId: centralTill,
    guardianName: 'Ploy',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
    children: [
      {
        checkinId: newId(),
        name: 'Mint',
        ageYears: 6,
        service: 'drop_off',
        allergies: null,
        foodRestrictions: null,
        foodProvision: { mode: 'none', paidSatang: 0 },
      },
    ],
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { children: Array<{ id: string }> }).children[0]!.id;
}

/** A press of Central's Booth 1, filed as the sync path files one: the voucher, then the spin. */
async function press(staff: string | null, prize: Prize | null): Promise<{ id: string; code: string }> {
  const issuedAt = new Date(Date.now() - 60_000);
  let voucherId: string | null = null;
  let code = '';
  if (prize) {
    voucherId = newId();
    code = mintBoothCode('B1', (max) => randomInt(max));
    await ctx.db.insert(voucher).values({
      id: voucherId,
      operatorId,
      branchId: central,
      voucherDefinitionId: prize.voucherDefinitionId!,
      code,
      source: 'booth',
      status: 'issued',
      costSatang: prize.costSatang,
      issuedByAccountId: staff,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 14 * 86_400_000),
    });
  }
  await ctx.db.insert(spin).values({
    id: newId(),
    operatorId,
    branchId: central,
    stationId: boothId,
    boxId,
    boothConfigVersionId: versionId,
    outcome: prize ? 'prize' : 'no_prize',
    prizeId: prize?.id ?? null,
    voucherId,
    staffAccountId: staff,
    simulated: false,
    occurredAt: issuedAt,
    businessDate: T,
  });
  return { id: voucherId ?? '', code };
}

async function rollAll(now = new Date()) {
  const daily = await runDailyRollupJob(ctx.db, now);
  await runHourlyRollupJob(ctx.db, now);
  return daily;
}

async function receiptsOf(ids: string[]): Promise<string[]> {
  const rows = await ctx.db.select({ receiptNumber: sale.receiptNumber }).from(sale).where(inArray(sale.id, ids));
  return rows.map((r) => r.receiptNumber!).sort();
}

const REPORT_ROUTES = [
  'reports/sales',
  'reports/profitability',
  'reports/discounts',
  'reports/discounts/transactions',
  'reports/tax/vat',
  'reports/tax/receipts',
  'booths',
  'booths/export',
];

const reportTables = [dailyCategorySummary, dailyTenderSummary, dailyTicketSummary, dailyItemSummary, dailyDiscountSummary] as const;

/** Every report row of one branch-day, whole. */
async function reportRows(branchId: string, date: string) {
  return Promise.all(
    reportTables.map((t) =>
      ctx.db
        .select()
        .from(t)
        .where(and(eq(t.branchId, branchId), eq(t.businessDate, date)))
        .orderBy(t.id),
    ),
  );
}

// --- (1) The panels against the prototype ------------------------------------------------

describe('the Sales panel against the prototype’s rules', () => {
  /**
   * `ticketTypeSalesRows` (prototype lib/reporting.ts:309-331) with the
   * platform's units: every cart line of a ticket sale under its package —
   * leaving out a free-item stub and event passes, nothing else — counting the
   * line once, its participants once, and its ticket units' list price
   * (tickets, socks, add-ons; never the drop-off fee).
   */
  async function prototypeTicketTypes(saleIds: string[]) {
    const lines = await ctx.db.select().from(saleLine).where(inArray(saleLine.saleId, saleIds));
    const ticketKinds = new Set(['kids', 'adults_paid', 'adults_free', 'socks', 'addon']);
    const groups = new Map<string, typeof lines>();
    for (const l of lines) {
      if (l.kind === 'fnb_item' || l.kind === 'merch_item') continue;
      const key = `${l.saleId}|${l.cartLineId}`;
      groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    const out = new Map<string, { lineCount: number; kids: number; adults: number; revenueSatang: number }>();
    for (const group of groups.values()) {
      if (group.some((l) => l.kind === 'promo_item')) continue;
      const packageId = [...group].sort((a, b) => a.lineNo - b.lineNo).find((l) => l.ticketPackageId)?.ticketPackageId;
      if (!packageId) continue;
      const row = out.get(packageId) ?? { lineCount: 0, kids: 0, adults: 0, revenueSatang: 0 };
      row.lineCount += 1;
      row.kids += Math.max(...group.map((l) => l.kidCount));
      row.adults += Math.max(...group.map((l) => l.adultCount));
      row.revenueSatang += group.filter((l) => ticketKinds.has(l.kind)).reduce((s, l) => s + l.baseSatang, 0);
      out.set(packageId, row);
    }
    return out;
  }

  it('the drop-off stay is a real ticket line, with a child and a ticket price (fixture check)', async () => {
    const lines = await ctx.db
      .select()
      .from(saleLine)
      .where(and(eq(saleLine.saleId, centralSales[1]!), eq(saleLine.cartLineId, stayCartLineId)));
    expect(lines.some((l) => l.kind === 'kids' && l.baseSatang > 0 && l.ticketPackageId)).toBe(true);
    expect(lines.some((l) => l.kind === 'service_fee')).toBe(true);
  });

  it('(R1) the ticket type breakdown counts a drop-off child under their ticket, as the prototype does', async () => {
    const report = await read<SalesReport>(manager, 'reports/sales', `branches=${central}&from=${T}&to=${T}`);
    const expected = await prototypeTicketTypes(centralSales);
    expect(
      new Map(report.ticketTypes.map((t) => [t.ticketTypeId, { lineCount: t.lineCount, kids: t.kids, adults: t.adults, revenueSatang: t.revenueSatang }])),
    ).toEqual(expected);
  });

  it('the drop-off session keeps its fee and play hours (dropOffNannyRevenueRows)', async () => {
    const report = await read<SalesReport>(manager, 'reports/sales', `branches=${central}&from=${T}&to=${T}`);
    const fee = await ctx.db
      .select()
      .from(saleLine)
      .where(and(eq(saleLine.saleId, centralSales[1]!), eq(saleLine.kind, 'service_fee')));
    expect(report.dropOffNanny).toEqual([
      { service: 'drop_off', sessionCount: 1, totalHours: 2, feesSatang: fee.reduce((s, l) => s + l.baseSatang, 0) },
    ]);
  });

  it('the payment mix, by tier and the category rows are Central’s sales alone, summed by hand', async () => {
    const report = await read<SalesReport>(manager, 'reports/sales', `from=${T}&to=${T}`);
    const rows = await ctx.db.select().from(sale).where(inArray(sale.id, centralSales));
    const gross = rows.reduce((s, r) => s + r.grossSatang, 0);
    const categoryGross = rows.reduce(
      (s, r) => s + (r.taxBreakdown as TaxBreakdown).categories.reduce((c, x) => c + x.gross, 0),
      0,
    );
    expect(report.branches.map((b) => b.branchId)).toEqual([central]);
    expect(report.categories.reduce((s, c) => s + c.grossRevenueSatang, 0)).toBe(categoryGross);
    expect(report.tiers.reduce((s, t) => s + t.ticketRevenueSatang + t.dropOffRevenueSatang, 0)).toBe(gross);
    expect(report.tiers.reduce((s, t) => s + t.saleCount, 0)).toBe(centralSales.length);
    expect(report.weekdayWeekend.reduce((s, w) => s + w.revenueSatang, 0)).toBe(gross);
    // Every sale was cash: the mix is the cash taken.
    expect(report.payments).toEqual([{ method: 'cash', amountSatang: gross, count: centralSales.length }]);
  });
});

// --- (3) Branch scope, with rows at both parks and a foreign operator -----------------------

describe('branch scope on every report route and the export', () => {
  it('Central’s manager never receives Chalong’s rows, asked for all parks, for both, or by the CSV', async () => {
    const chalongReceipts = await receiptsOf(chalongSales);
    expect(chalongReceipts).toHaveLength(2);
    for (const path of REPORT_ROUTES) {
      for (const query of [`from=${T}&to=${T}`, `branches=${central},${chalong}&from=${T}&to=${T}`]) {
        const res = await get(manager, path, query);
        expect(res.statusCode, `${path}?${query}: ${res.body}`).toBe(200);
        for (const receipt of chalongReceipts) expect(res.body, `${path}?${query}`).not.toContain(receipt);
        if (path.endsWith('export')) continue;
        expect((res.json() as { branches: Array<{ branchId: string }> }).branches.map((b) => b.branchId), path).toEqual([central]);
      }
    }
    const receipts = await read<TaxReceipts>(manager, 'reports/tax/receipts', `from=${T}&to=${T}`);
    expect(receipts.rows.map((r) => r.transactionId).sort()).toEqual(await receiptsOf(centralSales));
    expect(new Set(receipts.rows.map((r) => r.branchId))).toEqual(new Set([central]));
  });

  it('Chalong’s manager reads Chalong alone: its receipts, and no booth (Central’s booth voucher spent there stays Central’s)', async () => {
    const centralReceipts = await receiptsOf(centralSales);
    for (const path of REPORT_ROUTES) {
      const res = await get(chalongManager, path, `from=${TC}&to=${TC}`);
      expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      for (const receipt of centralReceipts) expect(res.body, path).not.toContain(receipt);
      expect(res.body, path).not.toContain(boothId);
      expect(res.body, path).not.toContain('Booth 1');
      expect((await get(chalongManager, path, `branches=${central}&from=${T}&to=${T}`)).statusCode, path).toBe(403);
    }
    const receipts = await read<TaxReceipts>(chalongManager, 'reports/tax/receipts', `from=${TC}&to=${TC}`);
    expect(receipts.rows.map((r) => r.transactionId).sort()).toEqual(await receiptsOf(chalongSales));
    const booths = await read<BoothReport>(chalongManager, 'booths', `from=${TC}&to=${TC}`);
    expect([booths.booths, booths.prizes, booths.staff, booths.days]).toEqual([[], [], [], []]);
    const csv = await get(chalongManager, 'booths/export', `from=${TC}&to=${TC}`);
    expect(unBom(csv.body).trim().split('\r\n')).toHaveLength(1);
    // The voucher spun at Central and spent at Chalong is masked in Chalong's list too.
    const lists = await read<DiscountTransactions>(chalongManager, 'reports/discounts/transactions', `from=${TC}&to=${TC}`);
    expect(lists.promoRows.map((r) => r.code)).toEqual([`…${awayVoucher.code.slice(-4)}`]);
    expect(JSON.stringify(lists)).not.toContain(awayVoucher.code);
  });

  it('another operator’s administrator: OTO’s parks are a 404 by id, and absent from every “all parks” answer', async () => {
    const otoReceipts = [...(await receiptsOf(centralSales)), ...(await receiptsOf(chalongSales))];
    for (const path of REPORT_ROUTES) {
      for (const id of [central, chalong]) {
        expect((await get(foreignAdmin, path, `branches=${id}&from=${T}&to=${T}`)).statusCode, path).toBe(404);
        expect((await get(foreignAdmin, path, `branches=${foreign},${id}&from=${T}&to=${T}`)).statusCode, path).toBe(404);
      }
      const all = await get(foreignAdmin, path, `from=${T}&to=${T}`);
      expect([200, 403], `${path}: ${all.body}`).toContain(all.statusCode);
      for (const marker of [central, chalong, boothId, ...otoReceipts]) expect(all.body, path).not.toContain(marker);
    }
    // And OTO's administrator cannot name the foreign park.
    for (const path of REPORT_ROUTES) {
      expect((await get(admin, path, `branches=${foreign}&from=${T}&to=${T}`)).statusCode, path).toBe(404);
    }
  });
});

// --- (4) The booth fact against what was written -------------------------------------------

describe('the booth fact against the spins and vouchers written', () => {
  it('a voucher spun at Central and redeemed at Chalong marks Central’s spin day, never Chalong’s', async () => {
    // The redemptions above were committed after the booth's last run: their marks wait for it.
    const marks = await ctx.db
      .select({ branchId: dirtyDate.branchId, date: dirtyDate.businessDate })
      .from(dirtyDate)
      .where(eq(dirtyDate.kind, 'booth'));
    expect(marks).toEqual([{ branchId: central, date: T }]);
    const [away] = await ctx.db.select().from(voucher).where(eq(voucher.id, awayVoucher.id));
    expect(away).toMatchObject({ status: 'redeemed', branchId: central, redeemedBranchId: chalong });
  });

  it('equals the spins and vouchers, per booth, staff member and prize, the away redemption included', async () => {
    await runBoothRollupJob(ctx.db, new Date());
    const spins = await ctx.db.select().from(spin).where(and(eq(spin.branchId, central), eq(spin.simulated, false)));
    const vouchers = new Map((await ctx.db.select().from(voucher)).map((v) => [v.id, v]));
    const hand = new Map<string, { spins: number; issued: number; redeemed: number; lag: number; cost: number }>();
    for (const s of spins) {
      const key = `${s.businessDate}|${s.stationId}|${s.staffAccountId ?? '-'}|${s.prizeId ?? '-'}`;
      const row = hand.get(key) ?? { spins: 0, issued: 0, redeemed: 0, lag: 0, cost: 0 };
      row.spins += 1;
      const v = s.voucherId ? vouchers.get(s.voucherId) : undefined;
      if (v) {
        row.issued += 1;
        if (s.prizeId) row.cost += v.costSatang;
        if (v.status === 'redeemed' && v.redeemedAt) {
          row.redeemed += 1;
          row.lag += Math.max(0, Math.round((v.redeemedAt.getTime() - v.issuedAt.getTime()) / 1000));
        }
      }
      hand.set(key, row);
    }
    const fact = await ctx.db.select().from(factBoothDaily);
    expect(fact.every((r) => r.branchId === central && r.operatorId === operatorId)).toBe(true);
    expect(
      new Map(
        fact.map((r) => [
          `${r.businessDate}|${r.boothId}|${r.staffAccountId ?? '-'}|${r.prizeId ?? '-'}`,
          { spins: r.spins, issued: r.vouchersIssued, redeemed: r.vouchersRedeemed, lag: r.redemptionLagSumS, cost: r.prizeCostSatang },
        ]),
      ),
    ).toEqual(hand);
    // The away redemption is on the manager's p100 row, with its lag.
    const awayRow = hand.get(`${T}|${boothId}|${managerAccountId}|${p100.id}`)!;
    expect(awayRow).toMatchObject({ spins: 1, issued: 1, redeemed: 1, cost: p100.costSatang });
    expect(awayRow.lag).toBeGreaterThan(0);
    // And the report adds them up: 4 spins, 3 prizes won, 3 issued, 2 redeemed.
    const report = await read<BoothReport>(manager, 'booths', `from=${T}&to=${T}`);
    expect(report.booths).toHaveLength(1);
    expect(report.booths[0]).toMatchObject({
      boothId,
      spins: 4,
      prizesWon: 3,
      vouchersIssued: 3,
      vouchersRedeemed: 2,
      redemptionRate: 2 / 3,
      prizeCostSatang: p150.costSatang + 2 * p100.costSatang,
    });
  });

  it('a redemption undone by a void re-marks the spin day and the fact follows the voucher', async () => {
    // A voucher held on a sale that is voided before payment never counts as redeemed.
    const v = await press(receptionAccountId, p150);
    const id = newId();
    expect((await post(reception, `/sales/${id}/vouchers`, { code: v.code })).statusCode).toBe(200);
    const committed = await post(reception, '/sales', {
      id,
      stationId: centralTill,
      lines: [{ id: newId(), packageId: await packageAt(central, '2 Hours Play'), kids: 1, adults: 1 }],
      promoCodes: [v.code],
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect((await post(reception, `/sales/${id}/void`, { reason: 'Guest walked away' })).statusCode).toBe(200);
    await runBoothRollupJob(ctx.db, new Date());
    const [row] = await ctx.db
      .select()
      .from(factBoothDaily)
      .where(and(eq(factBoothDaily.businessDate, T), eq(factBoothDaily.staffAccountId, receptionAccountId), eq(factBoothDaily.prizeId, p150.id)));
    const [stored] = await ctx.db.select().from(voucher).where(eq(voucher.id, v.id));
    expect(stored!.status).not.toBe('redeemed');
    // Two p150 wins by reception now; only the one spent at home is redeemed.
    expect(row).toMatchObject({ spins: 2, vouchersIssued: 2, vouchersRedeemed: 1 });
  });
});

// --- (2) The booth CSV's formula guard ------------------------------------------------------

describe('the booth CSV guards every text cell', () => {
  it('a booth, prize or staff name starting with +, -, @ or a tab is written as text', async () => {
    const [emp] = await ctx.db.select({ id: account.employeeId }).from(account).where(eq(account.id, managerAccountId));
    const [before] = await ctx.db.select().from(employee).where(eq(employee.id, emp!.id!));
    const [boothBefore] = await ctx.db.select().from(station).where(eq(station.id, boothId));
    await ctx.db.update(station).set({ name: '+SUM(1,2)' }).where(eq(station.id, boothId));
    await ctx.db.update(boothPrize).set({ nameEn: '-2+3' }).where(eq(boothPrize.id, p100.id));
    await ctx.db.update(boothPrize).set({ nameEn: '\t=cmd' }).where(eq(boothPrize.id, p150.id));
    await ctx.db.update(employee).set({ nickname: '@Nok' }).where(eq(employee.id, emp!.id!));
    try {
      const res = await get(manager, 'booths/export', `from=${T}&to=${T}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = unBom(res.body);
      expect(body).toContain(`"'+SUM(1,2)"`);
      expect(body).toContain(`"'-2+3"`);
      expect(body).toContain(`"'\t=cmd"`);
      expect(body).toContain(`"'@Nok"`);
      // No cell of any row opens with a formula character.
      const cells = body
        .trim()
        .split('\r\n')
        .flatMap((line) => line.match(/"(?:[^"]|"")*"/g) ?? []);
      expect(cells.length).toBeGreaterThan(12);
      expect(cells.filter((c) => /^"[=+\-@\t\r]/.test(c))).toEqual([]);
    } finally {
      await ctx.db.update(station).set({ name: boothBefore!.name }).where(eq(station.id, boothId));
      await ctx.db.update(boothPrize).set({ nameEn: p100.nameEn }).where(eq(boothPrize.id, p100.id));
      await ctx.db.update(boothPrize).set({ nameEn: p150.nameEn }).where(eq(boothPrize.id, p150.id));
      await ctx.db.update(employee).set({ nickname: before!.nickname }).where(eq(employee.id, emp!.id!));
    }
  });
});

// --- (5) Idempotent rollups, frozen days ---------------------------------------------------

describe('the report rows are written once, and a frozen day never', () => {
  it('a frozen day keeps every report row while its sales move, and the claim is consumed', async () => {
    // A frozen row is a final one (`daily_summary_frozen_check`): Chalong's
    // today is frozen as final for this test, and both flags are put back.
    await ctx.db
      .update(dailySummary)
      .set({ frozen: true, provisional: false })
      .where(and(eq(dailySummary.branchId, chalong), eq(dailySummary.businessDate, TC), eq(dailySummary.source, 'oto_pos')));
    try {
      const before = await reportRows(chalong, TC);
      expect(before.some((rows) => rows.length > 0)).toBe(true);
      chalongSales.push(await cashSale(chalongManager, chalongTill, [{ id: newId(), packageId: await packageAt(chalong, '1 Hour Play'), kids: 1, adults: 1 }]));
      const rolled = await rollAll();
      expect(rolled.frozen).toBeGreaterThanOrEqual(1);
      expect(await reportRows(chalong, TC)).toEqual(before);
      const left = await ctx.db
        .select()
        .from(dirtyDate)
        .where(and(eq(dirtyDate.branchId, chalong), eq(dirtyDate.businessDate, TC), eq(dirtyDate.kind, 'sales')));
      expect(left).toEqual([]);
    } finally {
      await ctx.db
        .update(dailySummary)
        .set({ frozen: false, provisional: true })
        .where(and(eq(dailySummary.branchId, chalong), eq(dailySummary.businessDate, TC), eq(dailySummary.source, 'oto_pos')));
    }
    // Thawed and marked: the new sale reaches the rows.
    await ctx.db.execute(sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${chalong}::uuid, ${TC}::date, 'sales', 'review')`);
    const thawed = await rollAll();
    expect(thawed.reportRowsWritten).toBeGreaterThan(0);
    const receipts = await read<TaxReceipts>(chalongManager, 'reports/tax/receipts', `from=${TC}&to=${TC}`);
    const sales = await read<SalesReport>(chalongManager, 'reports/sales', `from=${TC}&to=${TC}`);
    expect(sales.tiers.reduce((s, t) => s + t.saleCount, 0)).toBe(receipts.rows.length);
  });

  it('two rollups at once write one set of rows, and a third writes nothing', async () => {
    centralSales.push(await cashSale(reception, centralTill, [{ id: newId(), packageId: await packageAt(central, '1 Hour Play'), kids: 1, adults: 2 }]));
    const now = new Date();
    const [a, b] = await Promise.all([runDailyRollupJob(ctx.db, now), runDailyRollupJob(ctx.db, now)]);
    expect(a.reportRowsWritten + b.reportRowsWritten).toBeGreaterThan(0);
    const rows = await reportRows(central, T);
    for (const [i, t] of reportTables.entries()) {
      const keys = rows[i]!.map((r) => ('kind' in r && t === dailyTicketSummary ? `${r.kind}|${r.key}` : r.key));
      expect(new Set(keys).size, `table ${i}`).toBe(keys.length);
    }
    const third = await runDailyRollupJob(ctx.db, new Date());
    expect([third.reportRowsWritten, third.reportRowsRemoved]).toEqual([0, 0]);
    expect(await reportRows(central, T)).toEqual(rows);
    const report = await read<SalesReport>(manager, 'reports/sales', `from=${T}&to=${T}`);
    expect(report.tiers.reduce((s, t) => s + t.saleCount, 0)).toBe(centralSales.length);
  });
});

// --- (R2) A voucher label in the old form ----------------------------------------------------

describe('a voucher’s whole code never reaches the report', () => {
  it('(R2) a discount row labelled with the whole code (a row an older api wrote) is masked as a sale read masks it', async () => {
    const homeSale = centralSales[2]!;
    const [row] = await ctx.db
      .select()
      .from(saleDiscount)
      .where(and(eq(saleDiscount.saleId, homeSale), eq(saleDiscount.code, homeVoucher.code)));
    expect(row).toBeDefined();
    const oldLabel = `${row!.label!.replace(/ \(voucher …[^)]*\)$/, '')} (voucher ${homeVoucher.code})`;
    await ctx.db.execute(sql`alter table pos.sale_discount disable trigger sale_discount_freeze`);
    try {
      await ctx.db.update(saleDiscount).set({ label: oldLabel }).where(eq(saleDiscount.id, row!.id));
    } finally {
      await ctx.db.execute(sql`alter table pos.sale_discount enable trigger sale_discount_freeze`);
    }
    // The sale's own read masks it.
    const read1 = await ctx.app.inject({ method: 'GET', url: `/sales/${homeSale}`, headers: { cookie: manager } });
    expect(read1.statusCode, read1.body).toBe(200);
    expect(read1.body).not.toContain(homeVoucher.code);

    await ctx.db.execute(sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${central}::uuid, ${T}::date, 'sales', 'review')`);
    await rollAll();
    const stored = await ctx.db.select().from(dailyDiscountSummary).where(eq(dailyDiscountSummary.branchId, central));
    expect(JSON.stringify(stored)).not.toContain(homeVoucher.code);
    const lists = await read<DiscountTransactions>(manager, 'reports/discounts/transactions', `from=${T}&to=${T}`);
    expect(JSON.stringify(lists)).not.toContain(homeVoucher.code);
  });
});

// --- (5) A day that ends ---------------------------------------------------------------------

describe('a day that ends', () => {
  it('rewrites no report row when its trading is unchanged', async () => {
    const before = await reportRows(central, T);
    // A day and a half on: T is an ended day, rolled once more as final.
    const later = await rollAll(new Date(Date.now() + 36 * 3_600_000));
    expect(later.reportRowsWritten).toBe(0);
    expect(later.reportRowsRemoved).toBe(0);
    expect(await reportRows(central, T)).toEqual(before);
  });
});
