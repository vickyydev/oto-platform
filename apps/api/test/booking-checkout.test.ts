import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  alert,
  auditLog,
  booking,
  branch,
  paymentAttempt,
  paymentNotification,
  station,
  ticketPackage,
} from '@oto/db';
import {
  businessDate,
  isBandCodeShape,
  newId,
  parseDayStart,
  verifyBookingQr,
} from '@oto/shared';
import { signFrontendReturn, signJwt } from '@oto/payments-2c2p';
import { DEV_BAND_HMAC_KEY } from '../src/env';
import { createJobRunner } from '../src/services/jobs';
import { buildAlertChannels } from '../src/services/ops';
import { openAttempt } from '../src/services/payments/attempt';
import { gatewayFor, mintWebInvoiceNo } from '../src/services/payments/gateway';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-12 (SCRUM-209), ARRIVAL ROUND 1 — A BOOKING IS PAID FOR REAL.
 *
 * Beside `payments-2c2p.test.ts`, which owns the gateway's own rules, this file
 * owns what the booking site depends on:
 *
 *   - the server quotes the booking itself — the visit date's rate (the seeded
 *     holiday is weekend pricing), the adult rule, socks from the catalogue;
 *   - the booking is PAID ONLY when the gateway's backend notification and a
 *     Payment Inquiry agree, or when the inquiry poller finds the money;
 *   - a browser return — forged, or genuine and optimistic — changes NOTHING;
 *   - a replayed notification pays once;
 *   - a failed payment and an expired hold stay unpaid, and the till's redeem
 *     refuses them with "booking not paid";
 *   - a payment after the hold still confirms the booking, with an alert (OD-A11);
 *   - the payment is a station-less attempt on the `WEB` invoice segment,
 *     dated the day it is paid (OD-A10);
 *   - the paid booking carries a QR the park signed, which no band code can
 *     imitate;
 *   - create, pay and expire are audited; the Console lists the bookings.
 *
 * EVERY CREDENTIAL HERE IS MINTED IN THIS PROCESS. No `PGW_*` value of the
 * park's, of its sandbox merchant or of 2C2P's public demo pair appears here.
 */

const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';
const WEBHOOK_TOKEN = 'a-path-filter-not-a-credential';
/** The seeded Loy Krathong range — a Tuesday, priced as a weekend. */
const HOLIDAY = '2026-11-24';
/**
 * A plain weekday inside the bookable window, computed so this file never goes
 * stale: the server refuses a visit date before the branch's trading day or
 * past sixty days out (gate finding 4), so a fixed calendar date would start
 * failing the moment it slipped into the past. Seven days out, skipping
 * weekends and the seeded Loy Krathong range.
 */
const WEEKDAY = (() => {
  const day = new Date(Date.now() + 7 * 86_400_000);
  for (;;) {
    const iso = new Date(day.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const nearHoliday = iso >= '2026-11-23' && iso <= '2026-11-25';
    if (dow !== 0 && dow !== 6 && !nearHoliday) return iso;
    day.setUTCDate(day.getUTCDate() + 1);
  }
})();

let ctx: TestContext;
let reception: string;
let branchId: string;
let operatorId: string;
let timezone: string;
let dayStart: string;
let oneHourId: string;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: MERCHANT,
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: WEBHOOK_TOKEN,
    },
  });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = central!.id;
  operatorId = central!.operatorId;
  timezone = central!.timezone;
  dayStart = central!.businessDayStart;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
}, 180_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers ----------------------------------------------------------------------

/** 2 kids + 2 adults on the 1 Hour Play, Thai rate, two pairs of socks. */
const FAMILY = { packageId: '', kids: 2, adults: 2, socks: 2 };

/**
 * Each booking from its own address. The open booking routes allow twenty a
 * minute from one connection (`rate-limit-public.test.ts` owns that rule), and
 * this file makes more than twenty families' bookings inside a minute.
 */
let family = 0;
function familyAddress(): string {
  family += 1;
  return `10.209.${Math.floor(family / 250)}.${(family % 250) + 1}`;
}

async function book(over: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345678',
      parentName: 'Khun Mali',
      tier: 'thai',
      visitDate: HOLIDAY,
      lines: [{ ...FAMILY, packageId: oneHourId }],
      ...over,
    },
  });
  return res;
}

async function bookOk(over: Record<string, unknown> = {}) {
  const res = await book(over);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; reference: string; totalSatang: number; status: string; expiresAt: string };
}

async function checkout(bookingId: string, method: 'card' | 'promptpay' = 'promptpay') {
  return ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${bookingId}/checkout`,
    remoteAddress: familyAddress(),
    payload: { method },
  });
}

async function checkoutOk(bookingId: string, method: 'card' | 'promptpay' = 'promptpay') {
  const res = await checkout(bookingId, method);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { bookingId: string; attemptId: string; redirectUrl: string; expiresAt: string };
}

/** The simulated hosted page's button, pressed the way the guest's browser presses it. */
async function press(attemptId: string, action: 'pay' | 'fail') {
  return ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/hosted/${attemptId}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `action=${action}`,
  });
}

async function bookingRow(id: string) {
  const [row] = await ctx.db.select().from(booking).where(eq(booking.id, id));
  return row!;
}

async function attemptRow(id: string) {
  const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id));
  return row!;
}

async function audits(entityId: string, action: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)));
}

async function status(id: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/public/bookings/${id}/status` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { status: string; qr: string | null; paidAt: string | null } & Record<string, unknown>;
}

function simulator() {
  const { qr } = gatewayFor(ctx.app.env);
  return qr as unknown as {
    apply: (invoiceNo: string, event: string, opts?: { amountSatang?: number }) => { tranRef: string | null } | null;
  };
}

function wire(amountSatang: number): string {
  return `${Math.trunc(amountSatang / 100)}.${String(amountSatang % 100).padStart(2, '0')}000`;
}

function notification(over: Record<string, unknown>, secret = SECRET): { payload: string } {
  return {
    payload: signJwt(
      {
        merchantID: MERCHANT,
        currencyCode: 'THB',
        transactionDateTime: '20261124101500',
        agentCode: 'SCB',
        channelCode: 'PPQR',
        respCode: '0000',
        respDesc: 'Successful',
        ...over,
      },
      secret,
    ),
  };
}

async function postNotification(body: unknown) {
  return ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/payment?t=${WEBHOOK_TOKEN}`,
    payload: body as never,
  });
}

async function redeem(id: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/bookings/${id}/redeem`,
    headers: { cookie: reception },
    payload: {},
  });
}

function runner() {
  return createJobRunner({
    db: ctx.db,
    env: ctx.app.env,
    log: ctx.app.log,
    channels: buildAlertChannels('console', ctx.app.log),
  });
}

const today = (): string => businessDate(new Date(), timezone, parseDayStart(dayStart));

// --- The quote -------------------------------------------------------------------

describe('the server quotes the booking itself', () => {
  it('prices 2 kids + 2 adults on the seeded holiday at weekend prices, socks included', async () => {
    const made = await bookOk();
    // Thai 1 Hour Play: kid ฿520 at the weekend (฿420 on a weekday); adults at
    // the weekend admission ฿500 (฿350); two pairs of socks at ฿50.
    // 2 × 520 + 2 × 500 + 2 × 50 = ฿2,140. VAT is inclusive, so it adds nothing.
    expect(made.totalSatang).toBe(214_000);
    expect(made.status).toBe('pending');
    expect(made.expiresAt).not.toBeNull();

    const row = await bookingRow(made.id);
    expect(row.status).toBe('pending');
    expect(row.paidAt).toBeNull();
    expect(row.bookingDate).toBe(HOLIDAY);
    expect(row.businessDate).toBe(HOLIDAY);
    expect(row.kidsCount).toBe(2);
    expect(row.adultsCount).toBe(2);
    expect(row.packageId).toBe(oneHourId);
    expect(row.channel).toBe('web');
    expect(row.qrSignature).toBeNull();
    const snapshot = row.pricingSnapshot as Record<string, unknown>;
    expect(snapshot).toMatchObject({ rateMode: 'weekend', holidayName: 'Loy Krathong', tier: 'thai', totalSatang: 214_000 });
    const line = (snapshot.lines as Array<Record<string, unknown>>)[0]!;
    expect(line).toMatchObject({ kidUnitSatang: 52_000, adultUnitSatang: 50_000, socks: 2, socksUnitSatang: 5_000 });
    expect(await audits(made.id, 'booking.create')).toHaveLength(1);
  });

  it('prices the same family on a weekday at weekday prices', async () => {
    const made = await bookOk({ visitDate: WEEKDAY });
    // 2 × 420 + 2 × 350 + 2 × 50 = ฿1,640.
    expect(made.totalSatang).toBe(164_000);
  });

  it('prices an extra from the branch catalogue, never from the caller', async () => {
    const made = await bookOk({
      visitDate: WEEKDAY,
      lines: [{ packageId: oneHourId, kids: 1, adults: 0, addOns: [{ id: 'a-locker', quantity: 1 }] }],
    });
    // Kid ฿420 + the seeded locker ฿100.
    expect(made.totalSatang).toBe(52_000);
    const refused = await book({
      visitDate: WEEKDAY,
      lines: [{ packageId: oneHourId, kids: 1, adults: 0, addOns: [{ id: 'a-made-up', quantity: 1 }] }],
    });
    expect(refused.statusCode).toBe(400);
  });

  it("quotes the branch's TRADING day when no date is sent, and the catalogue answers for the same day (fix round 2)", async () => {
    // Saturday 2026-10-03, 02:30 in Bangkok: the calendar says Saturday, the
    // trading day (05:00 start) is still Friday. Both public answers say Friday.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T19:30:00Z'));
    const cat = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
    expect(cat.statusCode, cat.body).toBe(200);
    expect(cat.json().rateMode).toMatchObject({ date: '2026-10-02', mode: 'weekday' });
    const made = await bookOk({ visitDate: undefined });
    expect(made.status).toBe('pending');
    expect((await bookingRow(made.id)).bookingDate).toBe('2026-10-02');
    // 2 × 420 + 2 × 350 + 2 × 50 = ฿1,640, Friday's weekday rate.
    expect(made.totalSatang).toBe(164_000);
  });

  it('honours a date the site sends, on the catalogue and on the quote alike (fix round 2)', async () => {
    const holiday = await ctx.app.inject({
      method: 'GET',
      url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog?date=${HOLIDAY}`,
    });
    expect(holiday.statusCode, holiday.body).toBe(200);
    expect(holiday.json().rateMode).toMatchObject({ date: HOLIDAY, mode: 'weekend', overrideName: 'Loy Krathong' });
    const weekday = await ctx.app.inject({
      method: 'GET',
      url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog?date=${WEEKDAY}`,
    });
    expect(weekday.json().rateMode).toMatchObject({ date: WEEKDAY, mode: 'weekday' });
    const bad = await ctx.app.inject({
      method: 'GET',
      url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog?date=24-11-2026`,
    });
    expect(bad.statusCode).toBe(400);
    // At 02:30 on the Saturday, a family that chose the Saturday is quoted the Saturday.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T19:30:00Z'));
    const made = await bookOk({ visitDate: '2026-10-03' });
    expect((await bookingRow(made.id)).bookingDate).toBe('2026-10-03');
    // 2 × 520 + 2 × 500 + 2 × 50 = ฿2,140, the weekend rate.
    expect(made.totalSatang).toBe(214_000);
  });

  it('refuses to take a family to pay a figure they were not shown', async () => {
    const id = newId();
    const res = await book({ id, displayedTotalSatang: 200_000 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BOOKING_TOTAL_CHANGED');
    expect(res.json().error.details).toMatchObject({ displayedTotalSatang: 200_000, totalSatang: 214_000 });
    expect(await ctx.db.select().from(booking).where(eq(booking.id, id))).toHaveLength(0);
  });
});

// --- Checkout --------------------------------------------------------------------

describe('checkout opens one station-less payment on the WEB segment', () => {
  it('mints a WEB invoice dated the day it is paid, not the visit day (OD-A10)', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    // The simulator's page is the api's own; the site reaches it through /api.
    expect(opened.redirectUrl).toBe(`/webhooks/2c2p/hosted/${opened.attemptId}`);

    const attempt = await attemptRow(opened.attemptId);
    expect(attempt.stationId).toBeNull();
    expect(attempt.deviceId).toBeNull();
    expect(attempt.saleId).toBeNull();
    expect(attempt.provider).toBe('simulator');
    expect(attempt.method).toBe('qr');
    expect(attempt.amountSatang).toBe(made.totalSatang);
    expect(attempt.status).toBe('sent_to_terminal');
    expect(attempt.businessDate).toBe(today());
    const yymmdd = today().slice(2).replace(/-/g, '');
    expect(attempt.invoiceNo).toMatch(new RegExp(`^WEB${yymmdd}\\d{6}$`));
    expect((await bookingRow(made.id)).paymentAttemptId).toBe(opened.attemptId);
    expect(await audits(opened.attemptId, 'payment.hosted.open')).toHaveLength(1);

    // A second press finds the same attempt and the same page.
    const again = await checkoutOk(made.id);
    expect(again.attemptId).toBe(opened.attemptId);
    expect(again.redirectUrl).toBe(opened.redirectUrl);
    expect(
      await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.invoiceNo, attempt.invoiceNo!)),
    ).toHaveLength(1);
  });

  it('files a card booking as a card, and numbers the next WEB invoice after the last', async () => {
    const first = await checkoutOk((await bookOk()).id);
    const second = await checkoutOk((await bookOk()).id, 'card');
    const a = await attemptRow(first.attemptId);
    const b = await attemptRow(second.attemptId);
    expect(b.method).toBe('card');
    expect(Number(b.invoiceNo!.slice(-6))).toBeGreaterThan(Number(a.invoiceNo!.slice(-6)));
  });

  it('counts a stem ending in 9 by its range, and only its own numbers (fix round 2, the invoice counter)', async () => {
    // `WEB260929…`: a stem whose "next stem" would end in `:`, which the
    // database's en_US collation ignores. The counter reads the closed range
    // `stem000000`..`stem999999` instead, and still counts every number.
    const day = '2026-09-29';
    const mint = () =>
      ctx.db.transaction((tx) => mintWebInvoiceNo(tx, { businessDate: day, prefix: ctx.app.env.PGW_INVOICE_PREFIX }));
    const open = (invoiceNo: string) =>
      ctx.db.transaction((tx) =>
        openAttempt(tx, {
          operatorId,
          branchId,
          saleId: null,
          stationId: null,
          businessDate: day,
          method: 'qr',
          methodCode: 'promptpay',
          provider: 'simulator',
          status: 'created',
          amountSatang: 100,
          invoiceNo,
          payload: {},
        }),
      );
    const first = await mint();
    expect(first).toMatch(/^WEB260929\d{6}$/);
    await open(first);
    const second = await mint();
    expect(Number(second.slice(-6))).toBe(Number(first.slice(-6)) + 1);
    await open(second);
    // The next day's stem and a longer number sharing the prefix are not this stem's.
    await open(`WEB260930${String(Number(second.slice(-6)) + 50).padStart(6, '0')}`);
    await open(`${second}9`);
    const third = await mint();
    expect(Number(third.slice(-6))).toBe(Number(second.slice(-6)) + 1);
  });

  it('refuses to open a payment for a booking whose hold has run out', async () => {
    const made = await bookOk();
    await ctx.db
      .update(booking)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(booking.id, made.id));
    const res = await checkout(made.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BOOKING_EXPIRED');
    expect((await bookingRow(made.id)).paymentAttemptId).toBeNull();
  });
});

// --- Paid only by the gateway -------------------------------------------------------

describe('a booking is paid only by the notification and its inquiry, or by the poller', () => {
  it('pay on the hosted page: signed notification → inquiry → paid, with a signed QR', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    expect((await status(made.id)).qr).toBeNull();

    const page = await ctx.app.inject({ method: 'GET', url: opened.redirectUrl });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('฿2,140');

    const res = await press(opened.attemptId, 'pay');
    expect(res.statusCode, res.body).toBe(200);
    // The page sends the browser back through the return route with a signed hint.
    expect(res.body).toContain('name="paymentResponse"');
    expect(res.body).toContain('action="../../../public/bookings/return"');

    const row = await bookingRow(made.id);
    expect(row.status).toBe('paid');
    expect(row.paidAt).not.toBeNull();
    expect((await attemptRow(opened.attemptId)).status).toBe('approved');
    // It went through the REAL webhook: there is a notification row for it.
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    expect(
      await ctx.db.select().from(paymentNotification).where(eq(paymentNotification.invoiceNo, invoiceNo)),
    ).toHaveLength(1);

    const view = await status(made.id);
    expect(view.status).toBe('paid');
    const verified = verifyBookingQr(view.qr!, DEV_BAND_HMAC_KEY);
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.bookingId).toBe(made.id);
    // No band code can be this, and this is no band code.
    expect(isBandCodeShape(view.qr!)).toBe(false);
    // OD-A14 and the open route's reach: the state and the QR, no person.
    expect(JSON.stringify(view)).not.toMatch(/Mali|\+66812345678|parentName|phone/);

    const paidAudit = await audits(made.id, 'booking.pay');
    expect(paidAudit).toHaveLength(1);
    expect(paidAudit[0]!.actorAccountId).toBeNull();
    expect(paidAudit[0]!.after).toMatchObject({ status: 'paid', paymentAttemptId: opened.attemptId, qrSigned: true });
  });

  it('with the webhook suppressed, the inquiry poller finds the money', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    // The gateway's record says paid and NOTHING is posted.
    simulator().apply(invoiceNo, 'suppress_webhook');
    expect((await bookingRow(made.id)).status).toBe('pending');

    expect(await runner().runJob('job:payments.inquiry', { force: true })).toBe('ok');

    const row = await bookingRow(made.id);
    expect(row.status).toBe('paid');
    expect(row.qrSignature).not.toBeNull();
    expect(
      await ctx.db.select().from(paymentNotification).where(eq(paymentNotification.invoiceNo, invoiceNo)),
    ).toHaveLength(0);
    expect((await audits(made.id, 'booking.pay'))[0]!.after).toMatchObject({ source: 'inquiry' });
  });

  it('a notification the inquiry does not agree with pays nothing', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    // Signed with the right key, the right amount — and the gateway's own
    // record still says pending.
    const res = await postNotification(
      notification({ invoiceNo, amount: wire(made.totalSatang), tranRef: 'TR-BOOK-LIE' }),
    );
    expect(res.json().outcome).toBe('inquiry_disagreed');
    expect((await bookingRow(made.id)).status).toBe('pending');
  });
});

// --- The browser's return -----------------------------------------------------------

describe('the browser return changes nothing', () => {
  it('a forged return is answered like any other and pays nothing', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    const forged = signFrontendReturn(
      { invoiceNo, channelCode: 'PPQR', respCode: '0000', respDesc: 'Successful' },
      randomBytes(32).toString('hex'),
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings/return',
      // From another site, as 2C2P's page is: the Origin check lets this one route through.
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://pgw-ui.invalid' },
      payload: `paymentResponse=${encodeURIComponent(forged)}`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/book?payment=unknown');
    expect((await bookingRow(made.id)).status).toBe('pending');
    expect(await audits(made.id, 'booking.pay')).toHaveLength(0);
  });

  it('a GENUINE return saying completed is a hint for the page — the booking stays unpaid', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    // Signed with the merchant key, claiming success, while the gateway has
    // seen no money. It could be yesterday's, replayed by the browser.
    const genuine = signFrontendReturn({ invoiceNo, channelCode: 'PPQR', respCode: '0000' }, SECRET);
    for (const request of [
      {
        method: 'POST' as const,
        url: '/public/bookings/return',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `paymentResponse=${encodeURIComponent(genuine)}`,
      },
      { method: 'GET' as const, url: `/public/bookings/return?paymentResponse=${encodeURIComponent(genuine)}` },
    ]) {
      const res = await ctx.app.inject(request);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/book?payment=completed&booking=${made.id}`);
    }
    const row = await bookingRow(made.id);
    expect(row.status).toBe('pending');
    expect(row.paidAt).toBeNull();
    expect((await attemptRow(opened.attemptId)).status).toBe('sent_to_terminal');
    expect((await status(made.id)).qr).toBeNull();
  });
});

// --- Once ---------------------------------------------------------------------------

describe('a replayed notification pays once', () => {
  it('the same delivery twice, then another delivery of the same payment: one paid, one audit, one message', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    simulator().apply(invoiceNo, 'paid');
    const body = notification({ invoiceNo, amount: wire(made.totalSatang), tranRef: 'TR-BOOK-ONCE' });

    const first = await postNotification(body);
    const second = await postNotification(body);
    expect(first.json().outcome).toBe('settled');
    expect(second.json().outcome).toBe('duplicate');
    const paidAt = (await bookingRow(made.id)).paidAt;

    // A second, different delivery of the same payment (a retry after a slow 200).
    const third = await postNotification(
      notification({ invoiceNo, amount: wire(made.totalSatang), tranRef: 'TR-BOOK-ONCE-2' }),
    );
    expect(third.json().outcome).toBe('already_settled');

    const row = await bookingRow(made.id);
    expect(row.status).toBe('paid');
    expect(row.paidAt).toEqual(paidAt);
    expect(await audits(made.id, 'booking.pay')).toHaveLength(1);
    // And pressing the page again sends the browser back without a second payment.
    const again = await press(opened.attemptId, 'pay');
    expect(again.statusCode).toBe(200);
    expect(await audits(made.id, 'booking.pay')).toHaveLength(1);
  });
});

// --- Failure and expiry ---------------------------------------------------------------

describe('failure and expiry stay unpaid, and the till says "booking not paid"', () => {
  /** Run the page's own expiry out, as the clock would. */
  async function pageRunsOut(attemptId: string) {
    await ctx.db
      .update(paymentAttempt)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(paymentAttempt.id, attemptId));
  }

  it('a failed payment on a page that is still open is recorded; the booking still waits, unpaid (fix round 2)', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const res = await press(opened.attemptId, 'fail');
    expect(res.statusCode).toBe(200);

    // Recorded on the attempt and in the audit trail...
    const attempt = await attemptRow(opened.attemptId);
    expect(attempt.status).toBe('sent_to_terminal');
    expect(attempt.payload).toMatchObject({ declines: 1, lastDecline: { respCode: '0003', state: 'cancelled' } });
    expect(await audits(opened.attemptId, 'payment.hosted.declined')).toHaveLength(1);
    // ...and the booking is neither paid nor closed: the page's window is still open.
    const row = await bookingRow(made.id);
    expect(row.status).toBe('pending');
    expect(row.paidAt).toBeNull();
    expect(await audits(made.id, 'booking.cancel')).toHaveLength(0);
    expect((await status(made.id)).qr).toBeNull();

    // The poller keeps watching it, and asking again about the same decline adds nothing.
    expect(await runner().runJob('job:payments.inquiry', { force: true })).toBe('ok');
    expect((await attemptRow(opened.attemptId)).status).toBe('sent_to_terminal');
    expect(await audits(opened.attemptId, 'payment.hosted.declined')).toHaveLength(1);

    const refused = await redeem(made.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('BOOKING_NOT_REDEEMABLE');
    expect(refused.json().error.message).toContain('booking not paid');

    // Opening the payment again returns the same page, not a second payment.
    const again = await checkoutOk(made.id);
    expect(again.attemptId).toBe(opened.attemptId);
  });

  it('a payment after a decline, inside the window, confirms the booking exactly once (fix round 2)', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    await press(opened.attemptId, 'fail');
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;

    // The guest tries again on the page and it goes through: the gateway's
    // record says paid, and its notification arrives.
    simulator().apply(invoiceNo, 'paid');
    const body = notification({ invoiceNo, amount: wire(made.totalSatang), tranRef: 'TR-BOOK-RETRY' });
    const first = await postNotification(body);
    expect(first.json().outcome).toBe('settled');
    expect((await postNotification(body)).json().outcome).toBe('duplicate');
    expect(await runner().runJob('job:payments.inquiry', { force: true })).toBe('ok');

    const row = await bookingRow(made.id);
    expect(row.status).toBe('paid');
    expect(row.qrSignature).not.toBeNull();
    expect((await attemptRow(opened.attemptId)).status).toBe('approved');
    const paid = await audits(made.id, 'booking.pay');
    expect(paid).toHaveLength(1);
    // Paid inside its window: not late, and nobody is told it was.
    expect(paid[0]!.after).toMatchObject({ late: false });
    expect(await ctx.db.select().from(alert).where(eq(alert.key, `bookings.late_payment:${made.id}`))).toHaveLength(0);
    expect(await audits(made.id, 'booking.cancel')).toHaveLength(0);
  });

  it('a payment after a decline is found by the poller too, with no notification at all (fix round 2)', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    await press(opened.attemptId, 'fail');
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    simulator().apply(invoiceNo, 'suppress_webhook');

    expect(await runner().runJob('job:payments.inquiry', { force: true })).toBe('ok');
    const row = await bookingRow(made.id);
    expect(row.status).toBe('paid');
    expect(await audits(made.id, 'booking.pay')).toHaveLength(1);
    expect((await audits(made.id, 'booking.pay'))[0]!.after).toMatchObject({ source: 'inquiry', late: false });
  });

  it('once the page has run out, the failed payment closes the attempt and the booking, and the till refuses it', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    await press(opened.attemptId, 'fail');
    expect((await bookingRow(made.id)).status).toBe('pending');
    await pageRunsOut(opened.attemptId);

    // The poller's next answer about it is the same decline — now final.
    expect(await runner().runJob('job:payments.inquiry', { force: true })).toBe('ok');
    const row = await bookingRow(made.id);
    expect(row.status).toBe('cancelled');
    expect(row.paidAt).toBeNull();
    expect((await attemptRow(opened.attemptId)).status).toBe('cancelled');
    expect(await audits(made.id, 'booking.cancel')).toHaveLength(1);
    expect((await status(made.id)).qr).toBeNull();

    const refused = await redeem(made.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('BOOKING_NOT_REDEEMABLE');
    expect(refused.json().error.message).toContain('booking not paid');

    // And its payment cannot be reopened: the family books again.
    const reopen = await checkout(made.id);
    expect(reopen.statusCode).toBe(409);
  });

  it('a decline that arrives after the page has run out closes it at once', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    await pageRunsOut(opened.attemptId);
    const res = await press(opened.attemptId, 'fail');
    expect(res.statusCode).toBe(200);
    expect((await attemptRow(opened.attemptId)).status).toBe('cancelled');
    expect((await bookingRow(made.id)).status).toBe('cancelled');
    expect(await audits(opened.attemptId, 'payment.hosted.declined')).toHaveLength(0);
  });

  it('the pending sweeper expires an unpaid hold, audited, and the till refuses it', async () => {
    const made = await bookOk();
    await checkoutOk(made.id);
    await ctx.db
      .update(booking)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(booking.id, made.id));

    expect(await runner().runJob('job:payments.pending', { force: true })).toBe('ok');

    const row = await bookingRow(made.id);
    expect(row.status).toBe('expired');
    const expired = await audits(made.id, 'booking.expire');
    expect(expired).toHaveLength(1);
    expect(expired[0]!.after).toMatchObject({ status: 'expired', reason: 'hold_elapsed' });

    const refused = await redeem(made.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain('booking not paid');
  });

  it('the gateway running the payment out expires the booking', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    const facts = simulator().apply(invoiceNo, 'expire')!;
    const res = await postNotification(
      notification({ invoiceNo, amount: wire(made.totalSatang), tranRef: facts.tranRef, respCode: '9020' }),
    );
    expect(res.json().outcome).toBe('not_paid');
    expect((await bookingRow(made.id)).status).toBe('expired');
  });

  it('a payment after the hold ran out still confirms the booking, and raises an alert (OD-A11)', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    await ctx.db
      .update(booking)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(booking.id, made.id));
    await runner().runJob('job:payments.pending', { force: true });
    expect((await bookingRow(made.id)).status).toBe('expired');

    simulator().apply(invoiceNo, 'paid');
    const res = await postNotification(
      notification({ invoiceNo, amount: wire(made.totalSatang), tranRef: 'TR-BOOK-LATE' }),
    );
    expect(res.json().outcome).toBe('settled');
    const row = await bookingRow(made.id);
    expect(row.status).toBe('paid');
    expect(row.qrSignature).not.toBeNull();
    expect((await audits(made.id, 'booking.pay'))[0]!.after).toMatchObject({ late: true });
    const alerts = await ctx.db.select().from(alert).where(eq(alert.key, `bookings.late_payment:${made.id}`));
    expect(alerts).toHaveLength(1);
  });

  it('the gateway\'s own late-payment code confirms a booking too, through the inquiry', async () => {
    const made = await bookOk();
    const opened = await checkoutOk(made.id);
    const invoiceNo = (await attemptRow(opened.attemptId)).invoiceNo!;
    simulator().apply(invoiceNo, 'late_paid');
    const res = await postNotification(
      notification({ invoiceNo, amount: wire(made.totalSatang), tranRef: 'TR-BOOK-5017', respCode: '5017' }),
    );
    expect(res.json().outcome).toBe('settled');
    expect((await bookingRow(made.id)).status).toBe('paid');
    expect(await ctx.db.select().from(alert).where(eq(alert.key, `bookings.late_payment:${made.id}`))).toHaveLength(1);
  });
});

// --- The confirmation, reopened ------------------------------------------------------

describe('the confirmation can be reopened while the booking is paid and unredeemed (fix round 2)', () => {
  it('the status answer carries the QR while paid, and stops once reception has redeemed it', async () => {
    const made = await bookOk({ visitDate: today() });
    const opened = await checkoutOk(made.id);
    await press(opened.attemptId, 'pay');

    // Asked twice, as a reopened page asks: the same QR both times, no person.
    const first = await status(made.id);
    const second = await status(made.id);
    expect(first.status).toBe('paid');
    expect(first.qr).not.toBeNull();
    expect(second.qr).toBe(first.qr);
    expect(first.visitDate).toBe(today());
    expect(JSON.stringify(second)).not.toMatch(/Mali|\+66812345678|parentName|phone/);

    // Round 3: redemption happens AT a till, so the session stands at one first.
    const [till] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
    const stood = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/station',
      headers: { cookie: reception },
      payload: { stationId: till!.id },
    });
    expect(stood.statusCode, stood.body).toBe(200);

    const redeemed = await redeem(made.id);
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const after = await status(made.id);
    expect(after.status).toBe('redeemed');
    expect(after.qr).toBeNull();
  });
});

// --- The Console's list ---------------------------------------------------------------

describe('the Console lists the bookings, with the payment behind each', () => {
  it('shows every state, filters by one, and names the WEB invoice', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bookings/ledger?branchId=${branchId}&limit=100`,
      headers: { cookie: reception },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      total: number;
      rows: Array<{ status: string; payment: { invoiceNo: string | null; status: string } | null; qrIssued: boolean }>;
    };
    expect(body.total).toBeGreaterThan(5);
    const statuses = new Set(body.rows.map((r) => r.status));
    for (const s of ['pending', 'paid', 'expired', 'cancelled']) expect(statuses.has(s), s).toBe(true);
    const paid = body.rows.find((r) => r.status === 'paid' && r.payment)!;
    expect(paid.payment!.invoiceNo).toMatch(/^WEB/);
    expect(paid.payment!.status).toBe('approved');
    expect(paid.qrIssued).toBe(true);

    const onlyPaid = await ctx.app.inject({
      method: 'GET',
      url: `/bookings/ledger?branchId=${branchId}&status=paid`,
      headers: { cookie: reception },
    });
    expect((onlyPaid.json().rows as Array<{ status: string }>).every((r) => r.status === 'paid')).toBe(true);

    // A booking list names families: an anonymous caller is refused.
    const anonymous = await ctx.app.inject({ method: 'GET', url: `/bookings/ledger?branchId=${branchId}` });
    expect(anonymous.statusCode).toBe(401);
    void operatorId;
  });
});
