import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  account,
  branch,
  dailyCategorySummary,
  dailyDiscountSummary,
  dailyItemSummary,
  dailyTenderSummary,
  dailyTicketSummary,
  dimDate,
  paymentAttempt,
  product,
  refund,
  sale,
  saleDiscount,
  saleLine,
  station,
  stockMovement,
  ticketPackage,
  voucher,
  voucherDefinition,
} from '@oto/db';
import {
  businessDate,
  mintBoothCode,
  newId,
  parseDayStart,
  reportTaxSummaryLabel,
  type DiscountReport,
  type DiscountTransactions,
  type ProfitabilityReport,
  type SalesReport,
  type TaxBreakdown,
  type TaxReceipts,
  type VatReport,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
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
import { openBookingCheckout } from '../src/services/booking-checkout';
import { pressSimulatorHostedPage } from '../src/services/payments/gateway';
import { runDailyRollupJob, runHourlyRollupJob } from '../src/services/analytics-rollup';

/**
 * S2-15b (SCRUM-216) round 4 — Admin > Reports on the platform (plan
 * docs/progress/plans/analytics/PLAN.md §3, §7, §8 round 4).
 *
 * A trading day is made through the REAL routes, as lane G's review made its
 * day (s216-review): the till's commit and finalise, a keyed-in card, the
 * wallet tender, refunds, a void and an unpaid cart, a booth voucher, an
 * online booking and its redemption, two drop-off stays, and two manual
 * discounts. The rollup writes the report rows; then every panel's figures
 * are compared with sums made here by hand from the ledger rows, sale by sale.
 *
 * Then: every new route's branch scope (analytics:read per branch, omitted,
 * 403, 404, 401), the per-transaction lists, and a replayed rollup that writes
 * nothing.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let admin: string;
let operatorId: string;
let central: string;
let chalong: string;
let tillId: string;
let oneHourId: string;
let twoHoursId: string;
let juiceId: string;
let padThaiId: string;
let plushId: string;
let boothDefinitionId: string;
let bookingPackageId: string;
let T: string;

const PAD_THAI_COST = 6_000;

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  central = hkt!.id;
  operatorId = hkt!.operatorId;
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  await takeStation(ctx.app, reception, tillId);
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, central));
  oneHourId = pkgs.find((p) => p.name === '1 Hour Play')!.id;
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
  const products = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  const atCentral = (code: string) => products.find((p) => p.code === code && (p.branchId === central || p.branchId === null))!;
  juiceId = atCentral('FB-JUICE').id;
  padThaiId = atCentral('FB-PADTHAI').id;
  plushId = atCentral('MR-PLUSH').id;
  // Pad Thai is on no stock shelf: its cost is the catalogue's.
  await ctx.db.update(product).set({ costSatang: PAD_THAI_COST }).where(eq(product.id, padThaiId));
  const [def] = await ctx.db
    .select({ id: voucherDefinition.id })
    .from(voucherDefinition)
    .where(and(eq(voucherDefinition.operatorId, operatorId), eq(voucherDefinition.code, 'spin-voucher-150')));
  boothDefinitionId = def!.id;
  const catalog = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  bookingPackageId = (catalog.json() as { packages: Array<{ id: string }> }).packages[0]!.id;
  await rollAll();
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Calling the real routes -------------------------------------------------------------

async function post(cookie: string, url: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

async function commit(payload: Record<string, unknown>): Promise<string> {
  const id = newId();
  const res = await post(reception, '/sales', { id, stationId: tillId, ...payload });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

async function finalise(saleId: string, payload: Record<string, unknown> = {}) {
  const res = await post(reception, `/sales/${saleId}/finalise`, { actionId: newId(), ...payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { finalised: boolean; grants: Array<{ qrCode: string; creditSatang: number }>; redeemedVoucherIds: string[] };
}

async function manualCard(saleId: string, amountSatang: number): Promise<void> {
  const res = await post(reception, '/payments/manual', {
    saleId,
    amountSatang,
    approvalCode: '123456',
    tid: '12345678',
    last4: '4242',
    actionId: newId(),
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function refundOf(saleId: string, payload: Record<string, unknown>): Promise<void> {
  const res = await post(manager, `/sales/${saleId}/refunds`, { reason: 'Report refund', actionId: newId(), ...payload });
  expect(res.statusCode, res.body).toBe(200);
}

let booked = 0;

async function bookOnline(kids: number, adults: number): Promise<{ id: string; totalSatang: number }> {
  booked += 1;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: `10.217.0.${booked}`,
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345217',
      parentName: 'Khun Ploy',
      tier: 'tourist',
      lines: [{ packageId: bookingPackageId, kids, adults }],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const made = res.json() as { id: string; totalSatang: number };
  const checkout = await openBookingCheckout(ctx.db, ctx.app.env, ctx.app.log, {}, { bookingId: made.id, method: 'promptpay' });
  const pressed = await pressSimulatorHostedPage(ctx.db, ctx.app.env, ctx.app.log, { attemptId: checkout.attemptId, action: 'pay' });
  expect(pressed?.webhookOutcome).toBe('settled');
  return made;
}

async function registerStay(): Promise<string> {
  const checkinId = newId();
  const res = await post(reception, '/checkin/registrations', {
    id: newId(),
    branchId: central,
    stationId: tillId,
    guardianName: 'Ploy',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
    children: [
      {
        checkinId,
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

async function rollAll(now = new Date()) {
  const daily = await runDailyRollupJob(ctx.db, now);
  await runHourlyRollupJob(ctx.db, now);
  return daily;
}

async function read<T>(cookie: string, path: string, query: string): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url: `/analytics/${path}?${query}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as T;
}

// --- The day -------------------------------------------------------------------------------

interface Day {
  ticket: string[];
  fnb: string[];
  merch: string[];
  /**
   * Cart lines sold as tickets, with their participants — a child's stay too:
   * it is the child's own play ticket (`ticketTypeSalesRows`), its fee apart.
   */
  ticketLines: Array<{ saleId: string; cartLineId: string | null; packageId: string; kids: number; adults: number }>;
  stays: Array<{ saleId: string; cartLineId: string }>;
  voucherCode: string;
  juiceUnits: number;
}

let day: Day;

describe('S2-15b round 4 — a day made through the routes', () => {
  it('rings up the day', async () => {
    const ticketLines: Day['ticketLines'] = [];
    const line = (saleId: string, cartLineId: string | null, packageId: string, kids: number, adults: number) =>
      ticketLines.push({ saleId, cartLineId, packageId, kids, adults });

    // A — 2 Hours, a child and an adult, cash; the tickets grant credit.
    const lineA = newId();
    const A = await commit({ lines: [{ id: lineA, packageId: twoHoursId, kids: 1, adults: 1 }] });
    const grant = (await finalise(A, { method: 'cash' })).grants.find((g) => g.creditSatang > 0)!;
    line(A, lineA, twoHoursId, 1, 1);

    // B — 1 Hour, three children and an adult on one cart line; ฿500 card, the rest cash: a split tender.
    const lineB = newId();
    const B = await commit({ lines: [{ id: lineB, packageId: oneHourId, kids: 3, adults: 1 }] });
    await manualCard(B, 50_000);
    await finalise(B, { method: 'cash' });
    line(B, lineB, oneHourId, 3, 1);

    // C — F&B: credit first, cash for the rest, then a part refund (back to the wallet first).
    const juiceUnits = Math.floor(grant.creditSatang / 7_000) + 3;
    const C = await commit({ channel: 'fnb', pickupCode: '31', items: [{ id: newId(), productId: juiceId, quantity: juiceUnits }] });
    await finalise(C, { wallet: { key: grant.qrCode, useCredit: true }, method: 'cash' });
    await refundOf(C, { mode: 'custom', amountSatang: Math.min(15_000, grant.creditSatang) });

    // C2 — F&B, two juices and two Pad Thai; ฿50 card, the rest cash; a ฿60 refund.
    const C2 = await commit({
      channel: 'fnb',
      pickupCode: '32',
      items: [
        { id: newId(), productId: juiceId, quantity: 2 },
        { id: newId(), productId: padThaiId, quantity: 2 },
      ],
    });
    await manualCard(C2, 5_000);
    await finalise(C2, { method: 'cash' });
    await refundOf(C2, { mode: 'custom', amountSatang: 6_000 });

    // D — merch, cash, refunded whole: still a sale on the day, its item still sold.
    const D = await commit({ channel: 'shop', items: [{ id: newId(), productId: plushId, quantity: 1 }] });
    await finalise(D, { method: 'cash' });
    await refundOf(D, { mode: 'whole' });

    // E — voided; F — rung up, never paid. Neither counts anywhere.
    const E = await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 2, adults: 1 }] });
    expect((await post(reception, `/sales/${E}/void`, { reason: 'Guest walked away' })).statusCode).toBe(200);
    await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 2 }] });

    // G — a booth voucher spent at the till: a promo, its code masked in every report.
    const voucherCode = mintBoothCode('B1', (max) => randomInt(max));
    await ctx.db.insert(voucher).values({
      id: newId(),
      operatorId,
      branchId: central,
      voucherDefinitionId: boothDefinitionId,
      code: voucherCode,
      source: 'booth',
      status: 'issued',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    });
    const G = newId();
    expect((await post(reception, `/sales/${G}/vouchers`, { code: voucherCode })).statusCode).toBe(200);
    const lineG = newId();
    const rungG = await post(reception, '/sales', {
      id: G,
      stationId: tillId,
      lines: [{ id: lineG, packageId: twoHoursId, kids: 1, adults: 1 }],
      promoCodes: [voucherCode],
    });
    expect(rungG.statusCode, rungG.body).toBe(200);
    await finalise(G, { method: 'cash' });
    line(G, lineG, twoHoursId, 1, 1);

    // H — a booking paid online and redeemed at the till: the paid-online tender.
    const made = await bookOnline(2, 1);
    const redeemed = await post(reception, `/bookings/${made.id}/redeem`, { stationId: tillId });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const H = (redeemed.json() as { sale: { id: string } }).sale.id;
    line(H, null, bookingPackageId, 2, 1);

    // I — one child's drop-off stay; J — a family: a 2 Hours line and a second stay.
    const stayI = await registerStay();
    const fee = { label: 'Drop-off service', amountSatang: 22_500 };
    const I = await commit({ lines: [{ id: stayI, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: fee }] });
    await finalise(I, { method: 'cash' });
    line(I, stayI, twoHoursId, 1, 0);
    const stayJ = await registerStay();
    const lineJ = newId();
    const J = await commit({
      lines: [
        { id: lineJ, packageId: twoHoursId, kids: 1, adults: 1 },
        { id: stayJ, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: fee },
      ],
    });
    await finalise(J, { method: 'cash' });
    line(J, lineJ, twoHoursId, 1, 1);
    line(J, stayJ, twoHoursId, 1, 0);

    // K1 — a ฿50 manual discount; K2 — a comp on part of a cart.
    const lineK1 = newId();
    const K1 = await commit({
      lines: [{ id: lineK1, packageId: oneHourId, kids: 2, adults: 1 }],
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'fixed', value: 5_000, reason: 'Birthday' }],
    });
    await finalise(K1, { method: 'cash' });
    line(K1, lineK1, oneHourId, 2, 1);
    const lineK2 = newId();
    const lineK2b = newId();
    const K2 = await commit({
      lines: [
        { id: lineK2, packageId: oneHourId, kids: 1, adults: 1 },
        { id: lineK2b, packageId: twoHoursId, kids: 1, adults: 0 },
      ],
      manualDiscounts: [
        { id: newId(), scope: 'line', targetLineId: lineK2, type: 'comp', value: 0, reason: 'Staff / family', note: '=HYPERLINK("x")' },
      ],
    });
    await finalise(K2, { method: 'cash' });
    line(K2, lineK2, oneHourId, 1, 1);
    line(K2, lineK2b, twoHoursId, 1, 0);

    day = {
      ticket: [A, B, G, H, I, J, K1, K2],
      fnb: [C, C2],
      merch: [D],
      ticketLines,
      stays: [
        { saleId: I, cartLineId: stayI },
        { saleId: J, cartLineId: stayJ },
      ],
      voucherCode,
      juiceUnits,
    };
    const rolled = await rollAll();
    expect(rolled.reportRowsWritten).toBeGreaterThan(0);
  });

  const centralToday = () => `branches=${central}&from=${T}&to=${T}`;
  const counted = () => [...day.ticket, ...day.fnb, ...day.merch];
  const salesRows = async () => ctx.db.select().from(sale).where(inArray(sale.id, counted()));
  const breakdownOf = (row: { taxBreakdown: unknown }) => row.taxBreakdown as TaxBreakdown;

  it('Sales: revenue by category is every receipt’s category rows, summed', async () => {
    const report = await read<SalesReport>(manager, 'reports/sales', centralToday());
    const hand = new Map<string, { gross: number; tax: number; service: number; count: number }>();
    for (const row of await salesRows()) {
      for (const c of breakdownOf(row).categories) {
        const h = hand.get(c.category) ?? { gross: 0, tax: 0, service: 0, count: 0 };
        h.gross += c.gross;
        h.tax += c.tax + c.secondaryTax;
        h.service += c.serviceCharge;
        h.count += 1;
        hand.set(c.category, h);
      }
    }
    const total = [...hand.values()].reduce((s, h) => s + h.gross, 0);
    expect(new Map(report.categories.map((c) => [c.category, c]))).toEqual(
      new Map(
        [...hand].map(([category, h]) => [
          category,
          {
            category,
            grossRevenueSatang: h.gross,
            taxCollectedSatang: h.tax,
            serviceChargeSatang: h.service,
            count: h.count,
            pctShare: (h.gross / total) * 100,
          },
        ]),
      ),
    );
    // Largest first, as the prototype sorts it.
    const grosses = report.categories.map((c) => c.grossRevenueSatang);
    expect(grosses).toEqual([...grosses].sort((a, b) => b - a));
    expect(report).toMatchObject({ from: T, to: T, branches: [{ branchId: central }], omitted: [] });
  });

  it('Sales: the payment mix nets a ticket sale’s refunds per tender and leaves F&B as taken', async () => {
    const report = await read<SalesReport>(manager, 'reports/sales', centralToday());
    const attempts = await ctx.db.select().from(paymentAttempt).where(inArray(paymentAttempt.saleId, counted()));
    const refunds = await ctx.db.select().from(refund).where(inArray(refund.saleId, counted()));
    const hand = new Map<string, { amount: number; count: number }>();
    for (const id of counted()) {
      const taken = new Map<string, number>();
      for (const a of attempts.filter((x) => x.saleId === id && ['approved', 'awaiting_settlement'].includes(x.status))) {
        const code = a.methodCode ?? a.method;
        taken.set(code, (taken.get(code) ?? 0) + a.amountSatang);
      }
      const back = new Map<string, number>();
      for (const r of refunds.filter((x) => x.saleId === id)) {
        for (const slice of r.tenderAllocation) {
          const code = slice.methodCode ?? slice.method;
          back.set(code, (back.get(code) ?? 0) + slice.amountSatang);
        }
      }
      for (const [code, amount] of taken) {
        const figure = day.ticket.includes(id) ? Math.max(0, amount - (back.get(code) ?? 0)) : amount;
        if (figure <= 0) continue;
        const h = hand.get(code) ?? { amount: 0, count: 0 };
        h.amount += figure;
        h.count += 1;
        hand.set(code, h);
      }
    }
    expect(new Map(report.payments.map((p) => [p.method, { amount: p.amountSatang, count: p.count }]))).toEqual(hand);
    // The booking's money is the paid-online tender, once; the credit spent on C is its own line.
    expect(hand.has('paid_online')).toBe(true);
    expect(hand.has('wallet_credit')).toBe(true);
  });

  it('Sales: by tier, the ticket type breakdown, the weekday / weekend split and the drop-off sessions', async () => {
    const report = await read<SalesReport>(manager, 'reports/sales', centralToday());
    const rows = (await salesRows()).filter((r) => day.ticket.includes(r.id));
    const dropOffOf = (r: (typeof rows)[number]) =>
      breakdownOf(r).categories.filter((c) => c.category === 'drop_off').reduce((s, c) => s + c.gross, 0);
    const gross = rows.reduce((s, r) => s + r.grossSatang, 0);
    const dropOff = rows.reduce((s, r) => s + dropOffOf(r), 0);
    expect(dropOff).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.customerTier))).toEqual(new Set(['tourist']));
    expect(report.tiers).toEqual([
      { tier: 'tourist', ticketRevenueSatang: gross - dropOff, dropOffRevenueSatang: dropOff, saleCount: 8 },
    ]);

    // Each ticket line under its package: the units' list price, the participants once per line.
    // A stay counts its child's ticket and never its fee.
    const lines = await ctx.db.select().from(saleLine).where(inArray(saleLine.saleId, day.ticket));
    const ticketKinds = new Set(['kids', 'adults_paid', 'adults_free', 'socks', 'addon']);
    const bookingLine = lines.find((l) => l.saleId === day.ticket[3]! && l.ticketPackageId)!.cartLineId;
    for (const stay of day.stays) {
      const own = lines.filter((l) => l.saleId === stay.saleId && l.cartLineId === stay.cartLineId);
      expect(own.some((l) => l.kind === 'kids' && l.baseSatang > 0)).toBe(true);
      expect(own.some((l) => l.kind === 'service_fee' && l.baseSatang > 0)).toBe(true);
    }
    const hand = new Map<string, { lines: number; kids: number; adults: number; revenue: number }>();
    for (const t of day.ticketLines) {
      const cartLineId = t.cartLineId ?? bookingLine;
      const revenue = lines
        .filter((l) => l.saleId === t.saleId && l.cartLineId === cartLineId && ticketKinds.has(l.kind))
        .reduce((s, l) => s + l.baseSatang, 0);
      const h = hand.get(t.packageId) ?? { lines: 0, kids: 0, adults: 0, revenue: 0 };
      h.lines += 1;
      h.kids += t.kids;
      h.adults += t.adults;
      h.revenue += revenue;
      hand.set(t.packageId, h);
    }
    const names = new Map((await ctx.db.select().from(ticketPackage)).map((p) => [p.id, p.name]));
    expect(new Map(report.ticketTypes.map((t) => [t.ticketTypeId, t]))).toEqual(
      new Map(
        [...hand].map(([id, h]) => [
          id,
          { ticketTypeId: id, name: names.get(id), lineCount: h.lines, kids: h.kids, adults: h.adults, revenueSatang: h.revenue },
        ]),
      ),
    );

    // One trading day: its rate mode by the branch's calendar.
    const [cal] = await ctx.db.select().from(dimDate).where(and(eq(dimDate.branchId, central), eq(dimDate.date, T)));
    expect(report.weekdayWeekend).toEqual([
      { mode: cal!.rateMode === 'weekday' ? 'weekday' : 'weekend', saleCount: 8, revenueSatang: gross },
    ]);

    // The two stays: a session each, their play hours, their service fees.
    const fees = lines
      .filter((l) => l.kind === 'service_fee' && day.stays.some((s) => s.saleId === l.saleId && s.cartLineId === l.cartLineId))
      .reduce((s, l) => s + l.baseSatang, 0);
    expect(fees).toBeGreaterThan(0);
    expect(report.dropOffNanny).toEqual([{ service: 'drop_off', sessionCount: 2, totalHours: 4, feesSatang: fees }]);
  });

  it('Sales and Profitability: the items as sold, with the ledger’s cost, the catalogue’s, or none', async () => {
    const sales = await read<SalesReport>(manager, 'reports/sales', centralToday());
    const profit = await read<ProfitabilityReport>(manager, 'reports/profitability', centralToday());
    const lines = await ctx.db.select().from(saleLine).where(inArray(saleLine.saleId, counted()));
    const of = (productId: string) => lines.filter((l) => l.productId === productId && (l.kind === 'fnb_item' || l.kind === 'merch_item'));
    const sum = (productId: string) => ({
      qty: of(productId).reduce((s, l) => s + l.quantity, 0),
      revenue: of(productId).reduce((s, l) => s + l.baseSatang, 0),
    });
    const juice = sum(juiceId);
    const padThai = sum(padThaiId);
    const plush = sum(plushId);
    expect(juice.qty).toBe(day.juiceUnits + 2);
    expect(padThai.qty).toBe(2);
    expect(plush.qty).toBe(1);

    const [juiceRow] = await ctx.db.select({ name: product.name }).from(product).where(eq(product.id, juiceId));
    expect(new Map(sales.fnbItems.map((i) => [i.itemId, i]))).toEqual(
      new Map([
        [juiceId, { itemId: juiceId, name: of(juiceId)[0]!.label, qty: juice.qty, revenueSatang: juice.revenue }],
        [padThaiId, { itemId: padThaiId, name: of(padThaiId)[0]!.label, qty: 2, revenueSatang: padThai.revenue }],
      ]),
    );
    expect(juiceRow).toBeDefined();
    expect(sales.merchItems).toEqual([{ itemId: plushId, name: of(plushId)[0]!.label, qty: 1, revenueSatang: plush.revenue }]);

    // The plush's cost is frozen on its stock movement; the refund does not take it back here.
    const moves = await ctx.db
      .select()
      .from(stockMovement)
      .where(and(inArray(stockMovement.saleLineId, of(plushId).map((l) => l.id)), inArray(stockMovement.kind, ['sale', 'offline_sale'])));
    const plushCost = moves.reduce((s, m) => s + (-m.quantity + m.shortfall) * (m.unitCostSatang ?? 0), 0);
    expect(plushCost).toBe(16_000);
    const row = (itemId: string, qty: number, revenue: number, cogs: number, tracked: boolean) => ({
      itemId,
      name: of(itemId)[0]!.label,
      qty,
      revenueSatang: revenue,
      cogsSatang: cogs,
      marginSatang: revenue - cogs,
      marginPercent: revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0,
      costTracked: tracked,
    });
    expect(new Map(profit.fnb.map((r) => [r.itemId, r]))).toEqual(
      new Map([
        [juiceId, row(juiceId, juice.qty, juice.revenue, 0, false)],
        [padThaiId, row(padThaiId, 2, padThai.revenue, 2 * PAD_THAI_COST, true)],
      ]),
    );
    expect(profit.merch).toEqual([row(plushId, 1, plush.revenue, plushCost, true)]);
  });

  it('Discounts & Comps: the tiles, promo impact by type and by operator are the discount rows', async () => {
    const report = await read<DiscountReport>(manager, 'reports/discounts', centralToday());
    const rows = await ctx.db.select().from(saleDiscount).where(inArray(saleDiscount.saleId, counted()));
    const manual = rows.filter((r) => r.kind === 'manual');
    const promo = rows.filter((r) => r.kind === 'promo' && r.amountSatang > 0);
    const comp = manual.filter((r) => r.discountType === 'comp').reduce((s, r) => s + r.amountSatang, 0);
    const discount = manual.filter((r) => r.discountType !== 'comp').reduce((s, r) => s + r.amountSatang, 0);
    expect(comp).toBeGreaterThan(0);
    expect(discount).toBe(5_000);
    expect(promo.map((p) => p.amountSatang)).toEqual([15_000]);
    const [me] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
    expect(new Set(manual.map((m) => m.appliedByAccountId))).toEqual(new Set([me!.id]));
    expect(report).toMatchObject({
      compSatang: comp,
      manualDiscountSatang: discount,
      promoSatang: 15_000,
      freeItemBenefitSatang: 0,
      promoByType: [{ type: promo[0]!.discountType, count: 1, amountSatang: 15_000 }],
      byOperator: [
        {
          appliedBy: manual[0]!.appliedByName,
          compCount: 1,
          compTotalSatang: comp,
          discountCount: 1,
          discountTotalSatang: discount,
        },
      ],
    });
  });

  it('Discounts & Comps: the per-transaction lists, newest first, with a voucher’s code as its last four', async () => {
    const lists = await read<DiscountTransactions>(manager, 'reports/discounts/transactions', centralToday());
    const [K1, K2] = day.ticket.slice(6);
    const sales = new Map((await salesRows()).map((r) => [r.id, r]));
    expect(lists.rows.map((r) => [r.transactionId, r.type, r.reason, r.source])).toEqual([
      [sales.get(K2!)!.receiptNumber, 'comp', 'Staff / family', 'sale'],
      [sales.get(K1!)!.receiptNumber, 'fixed', 'Birthday', 'sale'],
    ]);
    expect(lists.rows[0]!.note).toBe('=HYPERLINK("x")');
    const G = day.ticket[2]!;
    expect(lists.promoRows).toEqual([
      {
        transactionId: sales.get(G)!.receiptNumber,
        createdAt: sales.get(G)!.occurredAt.toISOString(),
        operatorName: lists.rows[0]!.operatorName,
        code: `…${day.voucherCode.slice(-4)}`,
        label: expect.stringContaining(`…${day.voucherCode.slice(-4)}`),
        type: 'fixed',
        amountSatang: 15_000,
      },
    ]);
    expect(JSON.stringify(lists)).not.toContain(day.voucherCode);
    // Nor does the summary row keep the whole code.
    const stored = await ctx.db.select().from(dailyDiscountSummary).where(eq(dailyDiscountSummary.branchId, central));
    expect(JSON.stringify(stored)).not.toContain(day.voucherCode);
  });

  it('Tax & VAT: the VAT summary by range, day and month, and every receipt with its printed tax', async () => {
    const hand = new Map<string, { net: number; service: number; exclusive: number; inclusive: number; gross: number }>();
    for (const row of await salesRows()) {
      for (const c of breakdownOf(row).categories) {
        const h = hand.get(c.category) ?? { net: 0, service: 0, exclusive: 0, inclusive: 0, gross: 0 };
        h.net += c.base;
        h.service += c.serviceCharge;
        h.exclusive += (c.taxMode === 'exclusive' ? c.tax : 0) + (c.secondaryTaxMode === 'exclusive' ? c.secondaryTax : 0);
        h.inclusive += (c.taxMode === 'inclusive' ? c.tax : 0) + (c.secondaryTaxMode === 'inclusive' ? c.secondaryTax : 0);
        h.gross += c.gross;
        hand.set(c.category, h);
      }
    }
    for (const [period, key] of [
      ['range', null],
      ['day', T],
      ['month', T.slice(0, 7)],
    ] as const) {
      const vat = await read<VatReport>(manager, 'reports/tax/vat', `${centralToday()}&period=${period}`);
      expect(vat.period).toBe(period);
      expect(new Map(vat.rows.map((r) => [r.category, r]))).toEqual(
        new Map(
          [...hand].map(([category, h]) => [
            category,
            {
              category,
              period: key,
              netBaseSatang: h.net,
              serviceChargeSatang: h.service,
              exclusiveTaxSatang: h.exclusive,
              inclusiveTaxSatang: h.inclusive,
              grossSatang: h.gross,
            },
          ]),
        ),
      );
    }

    const receipts = await read<TaxReceipts>(manager, 'reports/tax/receipts', centralToday());
    const rows = await salesRows();
    expect(receipts.rows.map((r) => r.transactionId).sort()).toEqual(rows.map((r) => r.receiptNumber).sort());
    const byNumber = new Map(rows.map((r) => [r.receiptNumber, r]));
    const kindOf = (id: string) => (day.fnb.includes(id) ? 'fnb' : day.merch.includes(id) ? 'merch' : 'ticket');
    for (const r of receipts.rows) {
      const s = byNumber.get(r.transactionId)!;
      const b = breakdownOf(s);
      expect(r).toMatchObject({
        kind: kindOf(s.id),
        createdAt: s.occurredAt.toISOString(),
        branchId: central,
        netSubtotalSatang: b.netSubtotal,
        serviceChargeSatang: b.serviceChargeTotal,
        taxTotalSatang: b.taxTotal,
        grandTotalSatang: b.grandTotal,
        taxSummaryLabel: reportTaxSummaryLabel(b),
        categories: b.categories.map((c) => c.category),
      });
      expect(r.grandTotalSatang).toBe(s.grossSatang);
    }
    const method = (id: string) => receipts.rows.find((r) => r.transactionId === rows.find((x) => x.id === id)!.receiptNumber)!.paymentMethod;
    const [A, B, , H] = day.ticket;
    expect(method(A!)).toBe('cash');
    expect(method(B!)).toBe('split');
    expect(method(day.fnb[0]!)).toBe('split');
    expect(method(H!)).toBe('paid_online');
    // Newest first.
    const times = receipts.rows.map((r) => r.createdAt);
    expect(times).toEqual([...times].sort().reverse());
  });
});

describe('S2-15b round 4 — branch scope on every report route', () => {
  const ROUTES = [
    'reports/sales',
    'reports/profitability',
    'reports/discounts',
    'reports/discounts/transactions',
    'reports/tax/vat',
    'reports/tax/receipts',
    'booths',
    'booths/export',
  ];
  const get = (cookie: string | null, path: string, query: string) =>
    ctx.app.inject({ method: 'GET', url: `/analytics/${path}?${query}`, ...(cookie ? { headers: { cookie } } : {}) });

  it('a manager reads their own park; another park they may not read is omitted, never added in', async () => {
    for (const path of ROUTES) {
      const own = await get(manager, path, `from=${T}&to=${T}`);
      expect(own.statusCode, `${path}: ${own.body}`).toBe(200);
      if (path.endsWith('export')) continue;
      expect((own.json() as { branches: Array<{ branchId: string }> }).branches.map((b) => b.branchId), path).toEqual([central]);
      const both = await get(manager, path, `branches=${central},${chalong}&from=${T}&to=${T}`);
      expect(both.statusCode, path).toBe(200);
      expect(both.json(), path).toMatchObject({ branches: [{ branchId: central }], omitted: [chalong] });
      expect((await get(manager, path, `branches=${chalong}&from=${T}&to=${T}`)).statusCode, path).toBe(403);
    }
    // The figures with Chalong omitted are Central's alone.
    const alone = await read<SalesReport>(manager, 'reports/sales', `branches=${central}&from=${T}&to=${T}`);
    const both = await read<SalesReport>(manager, 'reports/sales', `branches=${central},${chalong}&from=${T}&to=${T}`);
    expect({ ...both, branches: [], omitted: [] }).toEqual({ ...alone, branches: [], omitted: [] });
  });

  it('refuses a counter account, a branch of no operator of the caller’s, no session, and a range backwards or too long', async () => {
    for (const path of ROUTES) {
      expect((await get(reception, path, `from=${T}&to=${T}`)).statusCode, path).toBe(403);
      expect((await get(admin, path, `branches=${newId()}&from=${T}&to=${T}`)).statusCode, path).toBe(404);
      expect((await get(null, path, `from=${T}&to=${T}`)).statusCode, path).toBe(401);
      expect((await get(admin, path, `from=${T}&to=2020-01-01`)).statusCode, path).toBe(400);
      expect((await get(admin, path, `from=2020-01-01&to=${T}`)).statusCode, path).toBe(400);
    }
  });

  it('an administrator reads every park, and are in the OpenAPI document as handler-guarded routes', async () => {
    const all = await read<SalesReport>(admin, 'reports/sales', `from=${T}&to=${T}`);
    expect(all.branches.map((b) => b.branchId)).toEqual(expect.arrayContaining([central, chalong]));
    const docs = await ctx.app.inject({ method: 'GET', url: '/docs/json', headers: { cookie: admin } });
    const paths = (docs.json() as { paths: Record<string, { get?: { description?: string } }> }).paths;
    for (const path of ROUTES) {
      expect(paths[`/analytics/${path}`]?.get?.description, path).toMatch(/analytics:read/);
      const entry = ctx.app.routeRegistry.find((r) => r.url === `/analytics/${path}` && r.method === 'GET');
      expect(entry?.config.dynamicPermission, path).toBe(true);
    }
  });
});

describe('S2-15b round 4 — the report rows are written once', () => {
  const tables = [dailyCategorySummary, dailyTenderSummary, dailyTicketSummary, dailyItemSummary, dailyDiscountSummary] as const;
  const snapshot = async () =>
    Promise.all(
      tables.map((t) =>
        ctx.db
          .select({ id: t.id, updatedAt: t.updatedAt })
          .from(t)
          .where(and(eq(t.branchId, central), eq(t.businessDate, T)))
          .orderBy(t.id),
      ),
    );

  it('a replayed rollup writes and removes nothing', async () => {
    const before = await snapshot();
    expect(before.every((rows) => rows.length > 0)).toBe(true);
    const again = await rollAll();
    expect(again.reportRowsWritten).toBe(0);
    expect(again.reportRowsRemoved).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('a late fact moves only the rows it touches, and a key the day no longer has is removed', async () => {
    // A refund today of C2's card money: the payment mix does not net F&B (the prototype's rule),
    // so the tender row keeps its amount and records the refund beside it.
    const [cardBefore] = await ctx.db
      .select()
      .from(dailyTenderSummary)
      .where(and(eq(dailyTenderSummary.branchId, central), eq(dailyTenderSummary.businessDate, T), eq(dailyTenderSummary.key, 'card')));
    await refundOf(day.fnb[1]!, { mode: 'custom', amountSatang: 1_000 });
    const rolled = await rollAll();
    expect(rolled.reportRowsWritten).toBeGreaterThan(0);
    const [cardAfter] = await ctx.db
      .select()
      .from(dailyTenderSummary)
      .where(and(eq(dailyTenderSummary.branchId, central), eq(dailyTenderSummary.businessDate, T), eq(dailyTenderSummary.key, 'card')));
    expect(cardAfter!.amountSatang).toBe(cardBefore!.amountSatang);

    // A row the facts no longer support is removed on the next rollup.
    await ctx.db.insert(dailyItemSummary).values({
      id: newId(),
      operatorId,
      branchId: central,
      businessDate: T,
      source: 'oto_pos',
      key: 'stale-item',
      kind: 'fnb',
      label: 'Stale',
      quantity: 1,
      revenueSatang: 100,
      computedAt: new Date(),
    });
    await ctx.db.execute(sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${central}::uuid, ${T}::date, 'sales', 'test')`);
    const cleaned = await rollAll();
    expect(cleaned.reportRowsRemoved).toBe(1);
    const left = await ctx.db.select().from(dailyItemSummary).where(eq(dailyItemSummary.key, 'stale-item'));
    expect(left).toEqual([]);
  });
});
