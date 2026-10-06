import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  account,
  branch,
  branchHoliday,
  checkin,
  dailySummary,
  dimDate,
  dirtyDate,
  factWalletLiabilityDaily,
  hourlySummary,
  opsRun,
  paymentAttempt,
  refund,
  registration,
  sale,
  saleDiscount,
  saleLine,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
  voucherRedemption,
  wallet,
  walletEntry,
  type AnalyticsSummarySource,
  type SaleLineKind,
  type SalesChannel,
} from '@oto/db';
import { ANALYTICS_FORMULA_VERSION, SALES_BOOTH_CHANNEL, addDaysToIsoDate, businessDate, newId, parseDayStart } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { loadEnv } from '../src/env';
import {
  ROLLUP_DAILY_JOB,
  ROLLUP_HOURLY_JOB,
  rollupDailyBranchDay,
  runDailyRollupJob,
  runHourlyRollupJob,
  type RollupBranchClock,
} from '../src/services/analytics-rollup';
import { createJobRunner } from '../src/services/jobs';
import { runWalletLiabilityJob } from '../src/services/wallet';

/**
 * S2-15b (SCRUM-216) round 2 — THE ROLLUP (plan
 * docs/progress/plans/analytics/PLAN.md §3, §4, §8 round 2).
 *
 * A trading day at Central Floresta built by hand, row by row, as the ledger
 * holds one — every figure of its `daily_summary` row and every hour of its
 * `hourly_summary` rows is summed by hand below and compared with what the
 * jobs wrote:
 *
 *   S1  2 Hours, a child and an adult, cash ฿1,240 (VAT ฿81.12)     10:15
 *   S2  1 Hour, three children on one cart line (three units), card ฿2,220
 *       (VAT ฿145.23)                                                   10:40
 *   S3  Full Day, a child and two adults, QR ฿1,790, a booth voucher 12:00
 *   S4  2 Hours and the drop-off service fee, cash ฿1,190            13:30
 *   S5  F&B ฿450: ฿200 credit and ฿250 cash; refunded ฿150, ฿50 of it
 *       back to the wallet                                            14:00
 *   S6  merch ฿120, card                                              14:30
 *   S7  1 Hour, a child, comped to ฿0                                 15:00
 *   S8  voided — never counted                                        11:00
 *   S9  still being paid for — never counted                          11:30
 *   S10 a booking's redemption, paid online ฿890 (the booking's own
 *       gateway payment, with no sale, is not counted again)          16:00
 *   S11 2 Hours for a child's drop-off stay, ฿0 service fee, cash ฿890 17:00
 *
 * and the day before it, whose sale is refunded ฿400 on the day above (the
 * refund lands on the day before), plus a sale at 01:30 that still belongs to
 * the day before.
 *
 * Then: a replay writes nothing; a late sale is corrected on the next run;
 * two runs racing write one row; a frozen day and a legacy row are never
 * written; the provisional flag clears once the day has ended; every run is
 * an operations record; the calendar follows the holidays; and the wallet
 * liability job recomputes a marked day older than its week.
 */

let ctx: TestContext;
let operatorId: string;
let branchId: string;
let clock: RollupBranchClock;
let tillId: string;
let receptionId: string;
let oneHourId: string;
let twoHoursId: string;
let fullDayId: string;
let today: string;
/** The hand-built day, and the day before it. */
let H: string;
let P: string;

const bkk = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

beforeAll(async () => {
  // The jobs role and the staging controls, for the Health page's "Run now".
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  clock = {
    id: branchId,
    operatorId,
    timezone: hkt!.timezone,
    dayStartMinutes: parseDayStart(hkt!.businessDayStart),
    live: true,
  };
  today = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  H = addDaysToIsoDate(today, -2);
  P = addDaysToIsoDate(today, -3);
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  const [me] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionId = me!.id;
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  oneHourId = pkgs.find((p) => p.name === '1 Hour Play')!.id;
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
  fullDayId = pkgs.find((p) => p.name === 'Full Day Pass')!.id;
  await buildTheDay();
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Writing a sale as the ledger holds one ---------------------------------------------

interface UnitSpec {
  kind: SaleLineKind;
  cartLineId: string;
  grossSatang: number;
  taxable: string;
  packageId?: string | null;
  hours?: number | null;
  kids?: number;
  adults?: number;
  quantity?: number;
  componentKey?: string | null;
}

interface TenderSpec {
  method: 'cash' | 'card' | 'qr' | 'wallet' | 'transfer';
  methodCode: string;
  amountSatang: number;
}

let receipt = 0;

async function ring(opts: {
  date: string;
  at: Date;
  status?: 'finalised' | 'voided' | 'tendering';
  channel?: SalesChannel;
  units: UnitSpec[];
  tenders?: TenderSpec[];
  taxSatang?: number;
  compSatang?: number;
  origin?: 'box' | 'cloud';
}): Promise<{ saleId: string; attemptIds: string[] }> {
  const saleId = newId();
  const status = opts.status ?? 'finalised';
  const gross = opts.units.reduce((sum, u) => sum + u.grossSatang, 0);
  const comp = opts.compSatang ?? 0;
  const tax = opts.taxSatang ?? 0;
  const numbered = status === 'finalised';
  receipt += 1;
  await ctx.db.insert(sale).values({
    id: saleId,
    operatorId,
    branchId,
    stationId: tillId,
    businessDate: opts.date,
    businessDayStart: '05:00',
    timezone: 'Asia/Bangkok',
    occurredAt: opts.at,
    origin: opts.origin ?? 'cloud',
    salesChannel: opts.channel ?? 'till',
    createdByAccountId: receptionId,
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    customerTier: 'tourist',
    engineVersion: 'analytics-r2',
    taxConfig: {},
    taxBreakdown: {},
    subtotalSatang: gross + comp,
    manualDiscountSatang: comp,
    discountSatang: comp,
    netSatang: gross - tax,
    taxInclusiveSatang: tax,
    grossSatang: gross,
    ...(numbered
      ? { receiptSeries: 'AN2', receiptSeq: receipt, receiptNumber: `AN2-${receipt}`, finalisedAt: opts.at }
      : {}),
    ...(status === 'voided' ? { voidedAt: opts.at, voidedByAccountId: receptionId, voidReason: 'Guest walked away' } : {}),
    status,
  });
  let lineNo = 0;
  for (const u of opts.units) {
    lineNo += 1;
    await ctx.db.insert(saleLine).values({
      id: newId(),
      saleId,
      operatorId,
      branchId,
      businessDate: opts.date,
      lineNo,
      cartLineId: u.cartLineId,
      kind: u.kind,
      componentKey: u.componentKey ?? null,
      ticketPackageId: u.packageId ?? null,
      label: 'A line',
      taxableCategory: u.taxable,
      quantity: u.quantity ?? 1,
      unitSatang: u.grossSatang,
      baseSatang: u.grossSatang,
      netSatang: u.grossSatang,
      grossSatang: u.grossSatang,
      customerTier: 'tourist',
      kidCount: u.kids ?? 0,
      adultCount: u.adults ?? 0,
      stayHours: u.hours ?? null,
    });
  }
  if (comp > 0) {
    await ctx.db.insert(saleDiscount).values({
      id: newId(),
      saleId,
      operatorId,
      branchId,
      businessDate: opts.date,
      sequence: 1,
      kind: 'manual',
      discountType: 'comp',
      amountSatang: comp,
      reason: 'Birthday',
      appliedByAccountId: receptionId,
    });
  }
  const attemptIds: string[] = [];
  for (const t of opts.tenders ?? []) {
    const id = newId();
    attemptIds.push(id);
    await ctx.db.insert(paymentAttempt).values({
      id,
      operatorId,
      branchId,
      saleId,
      stationId: tillId,
      businessDate: opts.date,
      method: t.method,
      methodCode: t.methodCode,
      status: 'approved',
      amountSatang: t.amountSatang,
      paidAt: opts.at,
      createdAt: opts.at,
    });
  }
  return { saleId, attemptIds };
}

let refundNo = 0;

/** A refund of `saleId` made at `at`, with the sale's running total moved as the refund service moves it. */
async function refundOf(saleId: string, amountSatang: number, at: Date): Promise<string> {
  const id = newId();
  refundNo += 1;
  await ctx.db.insert(refund).values({
    id,
    operatorId,
    branchId,
    saleId,
    stationId: tillId,
    number: `AN2-R-${refundNo}`,
    amountSatang,
    mode: 'custom',
    reason: 'Left early',
    approvedByAccountId: receptionId,
    createdByAccountId: receptionId,
    createdAt: at,
  });
  await ctx.db.execute(sql`update pos.sale set refunded_satang = refunded_satang + ${amountSatang} where id = ${saleId}::uuid`);
  return id;
}

async function walletEntryOf(opts: {
  walletId: string;
  kind: 'grant' | 'spend' | 'refund';
  source: 'ticket_sale' | 'fnb_order' | 'refund';
  amountSatang: number;
  balanceAfter: number;
  date: string;
  saleId?: string;
  refundId?: string;
  attemptId?: string;
}): Promise<void> {
  await ctx.db.insert(walletEntry).values({
    id: newId(),
    walletId: opts.walletId,
    operatorId,
    actionId: `an2:${newId()}`,
    amountSatang: opts.amountSatang,
    kind: opts.kind,
    source: opts.source,
    saleId: opts.saleId ?? null,
    refundId: opts.refundId ?? null,
    paymentAttemptId: opts.attemptId ?? null,
    branchId,
    businessDate: opts.date,
    balanceAfter: opts.balanceAfter,
  });
}

async function walletOf(balance: number): Promise<string> {
  const id = newId();
  await ctx.db.insert(wallet).values({ id, operatorId, branchId, holderName: 'Walk-in guest', balanceSatang: balance });
  return id;
}

const cart = (): string => newId();

async function buildTheDay(): Promise<void> {
  // S1 — 2 Hours, a child and an adult, cash; the adult's ticket credit granted.
  const l1 = cart();
  const s1 = await ring({
    date: H,
    at: bkk(H, '10:15'),
    taxSatang: 8_112,
    units: [
      { kind: 'kids', cartLineId: l1, grossSatang: 89_000, taxable: 'tickets', packageId: twoHoursId, hours: 2, kids: 1, adults: 1 },
      { kind: 'adults_paid', cartLineId: l1, grossSatang: 35_000, taxable: 'tickets', packageId: twoHoursId, hours: 2, kids: 1, adults: 1 },
    ],
    tenders: [{ method: 'cash', methodCode: 'cash', amountSatang: 124_000 }],
  });
  const granted = await walletOf(35_000);
  await walletEntryOf({ walletId: granted, kind: 'grant', source: 'ticket_sale', amountSatang: 35_000, balanceAfter: 35_000, date: H, saleId: s1.saleId });

  // S2 — 1 Hour, three children on ONE cart line, as three units carrying the line's count.
  const l2 = cart();
  await ring({
    date: H,
    at: bkk(H, '10:40'),
    taxSatang: 14_523,
    units: [
      { kind: 'kids', cartLineId: l2, grossSatang: 207_000, taxable: 'tickets', packageId: oneHourId, hours: 1, kids: 3, quantity: 3 },
      { kind: 'socks', cartLineId: l2, grossSatang: 9_000, taxable: 'addons', packageId: oneHourId, hours: 1, kids: 3, quantity: 3 },
      { kind: 'addon', cartLineId: l2, grossSatang: 6_000, taxable: 'addons', packageId: oneHourId, hours: 1, kids: 3, componentKey: 'a-locker' },
    ],
    tenders: [{ method: 'card', methodCode: 'card', amountSatang: 222_000 }],
  });

  // S3 — Full Day, a child and two adults, QR, and it redeemed a booth voucher.
  const l3 = cart();
  const s3 = await ring({
    date: H,
    at: bkk(H, '12:00'),
    units: [
      { kind: 'kids', cartLineId: l3, grossSatang: 109_000, taxable: 'tickets', packageId: fullDayId, hours: 8, kids: 1, adults: 2 },
      { kind: 'adults_paid', cartLineId: l3, grossSatang: 70_000, taxable: 'tickets', packageId: fullDayId, hours: 8, kids: 1, adults: 2, quantity: 2 },
    ],
    tenders: [{ method: 'qr', methodCode: 'promptpay', amountSatang: 179_000 }],
  });
  const [definition] = await ctx.db.select({ id: voucherDefinition.id }).from(voucherDefinition).where(eq(voucherDefinition.operatorId, operatorId)).limit(1);
  const voucherId = newId();
  await ctx.db.insert(voucher).values({
    id: voucherId,
    operatorId,
    branchId,
    voucherDefinitionId: definition!.id,
    code: 'B1AN2TEST1',
    source: 'booth',
    status: 'redeemed',
    issuedAt: bkk(P, '15:00'),
    redeemedAt: bkk(H, '12:00'),
    redeemedBranchId: branchId,
    saleId: s3.saleId,
  });
  await ctx.db.insert(voucherRedemption).values({
    id: newId(),
    operatorId,
    voucherId,
    kind: 'consumed',
    saleId: s3.saleId,
    branchId,
    stationId: tillId,
    accountId: receptionId,
    occurredAt: bkk(H, '12:00'),
  });

  // S4 — a ticket line and the drop-off service on one sale: all of it Drop-off.
  const l4 = cart();
  await ring({
    date: H,
    at: bkk(H, '13:30'),
    units: [
      { kind: 'kids', cartLineId: l4, grossSatang: 89_000, taxable: 'tickets', packageId: twoHoursId, hours: 2, kids: 1 },
      { kind: 'service_fee', cartLineId: l4, grossSatang: 30_000, taxable: 'drop_off', packageId: twoHoursId, hours: 2, kids: 1, componentKey: 'dropoff-service' },
    ],
    tenders: [{ method: 'cash', methodCode: 'cash', amountSatang: 119_000 }],
  });

  // S5 — F&B ฿450: ฿200 credit, ฿250 cash; refunded ฿150 that day, ฿50 back to the wallet.
  const s5 = await ring({
    date: H,
    at: bkk(H, '14:00'),
    channel: 'fnb',
    units: [{ kind: 'fnb_item', cartLineId: cart(), grossSatang: 45_000, taxable: 'fnb' }],
    tenders: [
      { method: 'wallet', methodCode: 'wallet_credit', amountSatang: 20_000 },
      { method: 'cash', methodCode: 'cash', amountSatang: 25_000 },
    ],
  });
  const spender = await walletOf(30_000);
  await walletEntryOf({ walletId: spender, kind: 'grant', source: 'ticket_sale', amountSatang: 50_000, balanceAfter: 50_000, date: H });
  await walletEntryOf({
    walletId: spender, kind: 'spend', source: 'fnb_order', amountSatang: -20_000, balanceAfter: 30_000, date: H,
    saleId: s5.saleId, attemptId: s5.attemptIds[0],
  });
  const r5 = await refundOf(s5.saleId, 15_000, bkk(H, '14:20'));
  await walletEntryOf({
    walletId: spender, kind: 'refund', source: 'refund', amountSatang: 5_000, balanceAfter: 35_000, date: H,
    saleId: s5.saleId, refundId: r5, attemptId: s5.attemptIds[0],
  });

  // S6 — merch, card.
  await ring({
    date: H,
    at: bkk(H, '14:30'),
    channel: 'shop',
    units: [{ kind: 'merch_item', cartLineId: cart(), grossSatang: 12_000, taxable: 'merch' }],
    tenders: [{ method: 'card', methodCode: 'card', amountSatang: 12_000 }],
  });

  // S7 — 1 Hour comped to ฿0: a transaction, a guest, no money.
  await ring({
    date: H,
    at: bkk(H, '15:00'),
    compSatang: 69_000,
    units: [{ kind: 'kids', cartLineId: cart(), grossSatang: 0, taxable: 'tickets', packageId: oneHourId, hours: 1, kids: 1 }],
  });

  // S8 voided and S9 still being paid for: never counted.
  await ring({
    date: H,
    at: bkk(H, '11:00'),
    status: 'voided',
    units: [{ kind: 'kids', cartLineId: cart(), grossSatang: 99_900, taxable: 'tickets', packageId: twoHoursId, hours: 2, kids: 5 }],
  });
  await ring({
    date: H,
    at: bkk(H, '11:30'),
    status: 'tendering',
    units: [{ kind: 'kids', cartLineId: cart(), grossSatang: 69_000, taxable: 'tickets', packageId: oneHourId, hours: 1, kids: 2 }],
  });

  // S10 — a booking's redemption, settled by the paid-online tender; its online payment carries no sale.
  await ring({
    date: H,
    at: bkk(H, '16:00'),
    channel: 'booking',
    units: [{ kind: 'kids', cartLineId: cart(), grossSatang: 89_000, taxable: 'tickets', packageId: twoHoursId, hours: 2, kids: 1 }],
    tenders: [{ method: 'transfer', methodCode: 'paid_online', amountSatang: 89_000 }],
  });
  await ctx.db.insert(paymentAttempt).values({
    id: newId(),
    operatorId,
    branchId,
    businessDate: H,
    method: 'qr',
    methodCode: 'promptpay',
    provider: '2c2p',
    status: 'approved',
    amountSatang: 89_000,
    paidAt: bkk(H, '09:00'),
    payload: { bookingId: newId() },
  });

  // S11 — a child's drop-off stay: the stay's id is its cart line, with no fee.
  const [reg] = await ctx.db
    .insert(registration)
    .values({ id: newId(), operatorId, branchId, guardianName: 'Khun Malee' })
    .returning({ id: registration.id });
  const stayId = newId();
  await ctx.db.insert(checkin).values({
    id: stayId,
    operatorId,
    branchId,
    registrationId: reg!.id,
    childName: 'Ploy',
    childAgeYears: 6,
    service: 'drop_off',
  });
  await ring({
    date: H,
    at: bkk(H, '17:00'),
    units: [{ kind: 'kids', cartLineId: stayId, grossSatang: 89_000, taxable: 'tickets', packageId: twoHoursId, hours: 2, kids: 1 }],
    tenders: [{ method: 'cash', methodCode: 'cash', amountSatang: 89_000 }],
  });

  // The day before: ฿1,000 at 11:00, refunded ฿400 on the day above; ฿500 at 01:30 the next morning.
  const y1 = await ring({
    date: P,
    at: bkk(P, '11:00'),
    units: [{ kind: 'adults_paid', cartLineId: cart(), grossSatang: 100_000, taxable: 'tickets', packageId: twoHoursId, hours: 2, adults: 1 }],
    tenders: [{ method: 'cash', methodCode: 'cash', amountSatang: 100_000 }],
  });
  await refundOf(y1.saleId, 40_000, bkk(H, '13:00'));
  await ring({
    date: P,
    at: bkk(H, '01:30'),
    units: [{ kind: 'adults_paid', cartLineId: cart(), grossSatang: 50_000, taxable: 'tickets', packageId: oneHourId, hours: 1, adults: 1 }],
    tenders: [{ method: 'cash', methodCode: 'cash', amountSatang: 50_000 }],
  });
}

// --- Reading the rows back --------------------------------------------------------------

async function dayRow(date: string, source: AnalyticsSummarySource = 'oto_pos') {
  const [row] = await ctx.db
    .select()
    .from(dailySummary)
    .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, date), eq(dailySummary.source, source)));
  return row;
}

async function hourRows(date: string) {
  return ctx.db
    .select()
    .from(hourlySummary)
    .where(and(eq(hourlySummary.branchId, branchId), eq(hourlySummary.businessDate, date)))
    .orderBy(hourlySummary.hour);
}

/** The hand-built day, summed by hand. */
const HAND = {
  formulaVersion: ANALYTICS_FORMULA_VERSION,
  provisional: false,
  frozen: false,
  // S1 1,240 + S2 2,220 + S3 1,790 + S7 0 + S10 890
  ticketsSatang: 614_000,
  // S5: ฿250 cash less the cash part of its refund (฿150 − ฿50)
  fnbSatang: 15_000,
  merchSatang: 12_000,
  partiesSatang: 0,
  // S4 1,190 + S11 890
  dropoffSatang: 208_000,
  revenueSatang: 849_000,
  // S1-S7, S10, S11; not S8, not S9
  txnCount: 9,
  // S5: ฿200 credit less ฿50 restored
  creditPaidSatang: 15_000,
  // S1 1 + S2 3 + S3 1 + S4 1 + S7 1 + S10 1 + S11 1; adults S1 1 + S3 2
  guestsKids: 9,
  guestsAdults: 3,
  // 1h: S2 3 + S7 1 · 2h: S1 2 + S4 1 + S10 1 + S11 1 · full day: S3 3
  mix1h: 4,
  mix2h: 5,
  mixFullDay: 3,
  partiesCount: 0,
  refundsSatang: 15_000,
  discountsSatang: 0,
  compsSatang: 69_000,
  vatSatang: 22_635,
  serviceSatang: 0,
  byChannel: { [SALES_BOOTH_CHANNEL]: { revenue: 179_000, txn_count: 1 } },
};

/** The same day, hour by hour: [hour, tickets, fnb, merch, dropoff, revenue, txn, guests]. */
const HAND_HOURS = [
  [10, 346_000, 0, 0, 0, 346_000, 2, 5],
  [12, 179_000, 0, 0, 0, 179_000, 1, 3],
  [13, 0, 0, 0, 119_000, 119_000, 1, 1],
  [14, 0, 15_000, 12_000, 0, 27_000, 2, 0],
  [15, 0, 0, 0, 0, 0, 1, 1],
  [16, 89_000, 0, 0, 0, 89_000, 1, 1],
  [17, 0, 0, 0, 89_000, 89_000, 1, 1],
];

const hoursAsRows = (rows: Awaited<ReturnType<typeof hourRows>>) =>
  rows.map((r) => [r.hour, r.ticketsSatang, r.fnbSatang, r.merchSatang, r.dropoffSatang, r.revenueSatang, r.txnCount, r.guests]);

// --- The rollup ---------------------------------------------------------------------------

describe('the daily and hourly rollup (SCRUM-216 round 2)', () => {
  it('writes the hand-built day exactly as summed by hand, and its hours add up to it', async () => {
    const now = new Date();
    const daily = await runDailyRollupJob(ctx.db, now);
    expect(daily.claimed).toBeGreaterThanOrEqual(2);
    const hourly = await runHourlyRollupJob(ctx.db, now);
    expect(hourly.claimed).toBeGreaterThanOrEqual(2);

    expect(await dayRow(H)).toMatchObject({ ...HAND, source: 'oto_pos', operatorId });
    expect(hoursAsRows(await hourRows(H))).toEqual(HAND_HOURS);

    // The day before: ฿1,000 less the ฿400 refunded on the day above, and the 01:30 sale.
    expect(await dayRow(P)).toMatchObject({
      ticketsSatang: 110_000,
      revenueSatang: 110_000,
      txnCount: 2,
      refundsSatang: 40_000,
      guestsAdults: 2,
      mix1h: 1,
      mix2h: 1,
      provisional: false,
    });
    expect(hoursAsRows(await hourRows(P))).toEqual([
      [1, 50_000, 0, 0, 0, 50_000, 1, 1],
      [11, 60_000, 0, 0, 0, 60_000, 1, 1],
    ]);

    // Every dirty day of sales was taken off the queue.
    const left = await ctx.db.select().from(dirtyDate).where(eq(dirtyDate.kind, 'sales'));
    expect(left).toEqual([]);
  });

  it('writes today at every live branch as a provisional formula-1 row', async () => {
    const row = await dayRow(today);
    expect(row).toMatchObject({ formulaVersion: 1, provisional: true, source: 'oto_pos', revenueSatang: 0, txnCount: 0 });
    const branches = await ctx.db.select({ id: branch.id }).from(branch).where(sql`archived_at is null`);
    const todays = await ctx.db.select().from(dailySummary).where(eq(dailySummary.businessDate, today));
    expect(todays.map((r) => r.branchId).sort()).toEqual(branches.map((b) => b.id).sort());
  });

  it('a replay writes nothing: the rows and their timestamps are as they were', async () => {
    const before = await ctx.db.select().from(dailySummary).orderBy(dailySummary.id);
    const hoursBefore = await ctx.db.select().from(hourlySummary).orderBy(hourlySummary.id);
    const later = new Date(Date.now() + 1000);
    const daily = await runDailyRollupJob(ctx.db, later);
    expect(daily.written).toBe(0);
    const hourly = await runHourlyRollupJob(ctx.db, later);
    expect(hourly.hoursWritten).toBe(0);
    expect(hourly.hoursRemoved).toBe(0);
    expect(await ctx.db.select().from(dailySummary).orderBy(dailySummary.id)).toEqual(before);
    expect(await ctx.db.select().from(hourlySummary).orderBy(hourlySummary.id)).toEqual(hoursBefore);
  });

  it('a late box sale is corrected on the next run, on its own day and hour', async () => {
    const late = await ring({
      date: H,
      at: bkk(H, '18:10'),
      origin: 'box',
      units: [{ kind: 'kids', cartLineId: cart(), grossSatang: 69_000, taxable: 'tickets', packageId: oneHourId, hours: 1, kids: 1 }],
      tenders: [{ method: 'cash', methodCode: 'cash', amountSatang: 69_000 }],
    });
    const marked = await ctx.db.select().from(dirtyDate).where(and(eq(dirtyDate.kind, 'sales'), eq(dirtyDate.businessDate, H)));
    expect(marked).toHaveLength(1);
    await runDailyRollupJob(ctx.db, new Date());
    await runHourlyRollupJob(ctx.db, new Date());
    expect(await dayRow(H)).toMatchObject({
      ticketsSatang: HAND.ticketsSatang + 69_000,
      revenueSatang: HAND.revenueSatang + 69_000,
      txnCount: HAND.txnCount + 1,
      guestsKids: HAND.guestsKids + 1,
      mix1h: HAND.mix1h + 1,
    });
    expect(hoursAsRows(await hourRows(H)).at(-1)).toEqual([18, 69_000, 0, 0, 0, 69_000, 1, 1]);
    // Taken back out, the day returns to its hand sum and the hour goes.
    await ctx.db.delete(paymentAttempt).where(eq(paymentAttempt.saleId, late.saleId));
    await ctx.db.delete(saleLine).where(eq(saleLine.saleId, late.saleId));
    await ctx.db.delete(sale).where(eq(sale.id, late.saleId));
    await runDailyRollupJob(ctx.db, new Date());
    await runHourlyRollupJob(ctx.db, new Date());
    expect(await dayRow(H)).toMatchObject(HAND);
    expect(hoursAsRows(await hourRows(H))).toEqual(HAND_HOURS);
  });

  it('two rollups racing write one row with the right figures', async () => {
    await ctx.db.delete(dailySummary).where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, H)));
    await ctx.db.delete(hourlySummary).where(and(eq(hourlySummary.branchId, branchId), eq(hourlySummary.businessDate, H)));
    const now = new Date();
    const outcomes = await Promise.all([
      rollupDailyBranchDay(ctx.db, clock, H, now),
      rollupDailyBranchDay(ctx.db, clock, H, now),
      rollupDailyBranchDay(ctx.db, clock, H, now),
    ]);
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'unchanged')).toHaveLength(2);
    // Two whole runs at once, too.
    await ctx.db.execute(sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${branchId}::uuid, ${H}::date, 'sales', 'test')`);
    await Promise.all([runDailyRollupJob(ctx.db, now), runDailyRollupJob(ctx.db, now)]);
    await Promise.all([runHourlyRollupJob(ctx.db, now), runHourlyRollupJob(ctx.db, now)]);
    const rows = await ctx.db
      .select()
      .from(dailySummary)
      .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, H)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(HAND);
    expect(hoursAsRows(await hourRows(H))).toEqual(HAND_HOURS);
  });

  it('never writes a frozen day or another source’s row, and spends the frozen day’s mark', async () => {
    const F = addDaysToIsoDate(today, -6);
    await ctx.db.insert(dailySummary).values({
      id: newId(),
      operatorId,
      branchId,
      businessDate: F,
      source: 'oto_pos',
      formulaVersion: 1,
      frozen: true,
      computedAt: new Date('2026-01-01T00:00:00Z'),
      ticketsSatang: 12_345,
      revenueSatang: 12_345,
      txnCount: 3,
      inputFingerprint: 'frozen',
    });
    await ctx.db.insert(dailySummary).values({
      id: newId(),
      operatorId,
      branchId,
      businessDate: H,
      source: 'pisell',
      formulaVersion: 30,
      frozen: true,
      computedAt: new Date('2026-01-01T00:00:00Z'),
      revenueSatang: 777_700,
      inputFingerprint: 'legacy',
    });
    const frozenBefore = await dayRow(F);
    const legacyBefore = await dayRow(H, 'pisell');
    await ring({
      date: F,
      at: bkk(F, '12:00'),
      units: [{ kind: 'kids', cartLineId: cart(), grossSatang: 89_000, taxable: 'tickets', packageId: twoHoursId, hours: 2, kids: 1 }],
      tenders: [{ method: 'cash', methodCode: 'cash', amountSatang: 89_000 }],
    });
    const detail = await runDailyRollupJob(ctx.db, new Date());
    expect(detail.frozen).toBe(1);
    await runHourlyRollupJob(ctx.db, new Date());
    expect(await dayRow(F)).toEqual(frozenBefore);
    expect(await dayRow(H, 'pisell')).toEqual(legacyBefore);
    expect(await hourRows(F)).toEqual([]);
    expect(await ctx.db.select().from(dirtyDate).where(eq(dirtyDate.businessDate, F))).toEqual([]);
  });

  it('clears the provisional flag once the day has ended at its branch', async () => {
    expect(await dayRow(today)).toMatchObject({ provisional: true });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await runDailyRollupJob(ctx.db, tomorrow);
    expect(await dayRow(today)).toMatchObject({ provisional: false, formulaVersion: 1 });
    expect(await dayRow(addDaysToIsoDate(today, 1))).toMatchObject({ provisional: true });
  });

  it('records every run as an operations job with its outcome and counts', async () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused', PROCESS_ROLES: 'api,jobs' });
    const runner = createJobRunner({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    expect(runner.jobs.map((j) => j.name)).toEqual(expect.arrayContaining([ROLLUP_DAILY_JOB, ROLLUP_HOURLY_JOB]));
    const daily = runner.jobs.findIndex((j) => j.name === ROLLUP_DAILY_JOB);
    expect(runner.jobs[daily + 1]?.name).toBe(ROLLUP_HOURLY_JOB);
    expect(runner.jobs[daily]!.intervalSeconds).toBe(env.ROLLUP_INTERVAL_S);
    expect(await runner.runJob(ROLLUP_DAILY_JOB, { force: true })).toBe('ok');
    expect(await runner.runJob(ROLLUP_HOURLY_JOB, { force: true })).toBe('ok');
    const runs = await ctx.db.select().from(opsRun).where(eq(opsRun.kind, 'job'));
    const dailyRun = runs.find((r) => r.name === ROLLUP_DAILY_JOB);
    expect(dailyRun).toMatchObject({ outcome: 'ok' });
    expect(Object.keys(dailyRun!.detail as Record<string, unknown>).sort()).toEqual(
      [
        'branches',
        'calendarDays',
        'claimed',
        'days',
        'frozen',
        'reportRowsRemoved',
        'reportRowsWritten',
        'unchanged',
        'written',
      ].sort(),
    );
    expect(runs.find((r) => r.name === ROLLUP_HOURLY_JOB)).toMatchObject({ outcome: 'ok' });
  });

  it('runs from the Health page: the daily rollup, then the hourly', async () => {
    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const listed = await ctx.app.inject({ method: 'GET', url: '/ops/test-controls', headers: { cookie: admin } });
    expect((listed.json() as { controls: Array<{ key: string }> }).controls.map((c) => c.key)).toContain('rollup.run');
    const res = await ctx.app.inject({ method: 'POST', url: '/ops/test-controls/rollup.run', headers: { cookie: admin } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { message: string }).message).toBe('The analytics rollup ran (daily ok, hourly ok, booth ok).');
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await ctx.app.inject({ method: 'POST', url: '/ops/test-controls/rollup.run', headers: { cookie: reception } })).statusCode).toBe(403);
  });

  it('keeps the calendar on the branch’s holidays', async () => {
    const day = addDaysToIsoDate(today, 40);
    const [added] = await ctx.db
      .insert(branchHoliday)
      .values({ id: newId(), branchId, name: 'Analytics Day', startsOn: day, endsOn: day })
      .returning({ id: branchHoliday.id });
    await runDailyRollupJob(ctx.db, new Date());
    const read = async () =>
      (await ctx.db.select().from(dimDate).where(and(eq(dimDate.branchId, branchId), eq(dimDate.date, day))))[0];
    expect(await read()).toMatchObject({ rateMode: 'holiday', holidayName: 'Analytics Day' });
    await ctx.db.update(branchHoliday).set({ archivedAt: new Date() }).where(eq(branchHoliday.id, added!.id));
    await runDailyRollupJob(ctx.db, new Date());
    const after = await read();
    expect(after!.holidayName).toBeNull();
    expect(after!.rateMode).toBe(after!.weekday >= 6 ? 'weekend' : 'weekday');
  });

  it('the wallet liability job recomputes a marked day older than its week, and every day after it', async () => {
    const old = addDaysToIsoDate(today, -10);
    const w = await walletOf(0);
    await walletEntryOf({ walletId: w, kind: 'grant', source: 'ticket_sale', amountSatang: 12_300, balanceAfter: 12_300, date: old });
    const marked = await ctx.db.select().from(dirtyDate).where(and(eq(dirtyDate.kind, 'wallet'), eq(dirtyDate.businessDate, old)));
    expect(marked).toHaveLength(1);
    const job = await runWalletLiabilityJob(ctx.db, new Date());
    expect(job.marked).toBeGreaterThanOrEqual(1);
    const [fact] = await ctx.db
      .select()
      .from(factWalletLiabilityDaily)
      .where(and(eq(factWalletLiabilityDaily.branchId, branchId), eq(factWalletLiabilityDaily.businessDate, old)));
    expect(fact).toMatchObject({ grantedSatang: 12_300 });
    const between = await ctx.db
      .select({ date: factWalletLiabilityDaily.businessDate })
      .from(factWalletLiabilityDaily)
      .where(and(eq(factWalletLiabilityDaily.branchId, branchId), sql`business_date > ${old}::date and business_date < ${today}::date`));
    expect(between.length).toBe(9);
    expect(await ctx.db.select().from(dirtyDate).where(and(eq(dirtyDate.kind, 'wallet'), eq(dirtyDate.businessDate, old)))).toEqual([]);
  });
});
