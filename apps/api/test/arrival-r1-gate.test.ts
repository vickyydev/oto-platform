import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  booking,
  bookingRedemption,
  branch,
  branchTaxConfig,
  member,
  paymentAttempt,
  product,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import {
  TAXABLE_CATEGORIES,
  businessDate,
  computeTicketCartTotals,
  newId,
  parseDayStart,
  priceCartLine,
  resolveRate,
  type CartAddOn,
  type PricingContext,
  type TaxConfigShape,
  type TicketCartLine,
} from '@oto/shared';
import { signJwt } from '@oto/payments-2c2p';
import { resetDemoData } from '../src/services/demo-reset';
import {
  OPENING_GRACE_MS,
  gatewayFor,
  openQrAttempt,
  pollPendingAttempts,
} from '../src/services/payments/gateway';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-209 ROUND 1 — THE ADVERSARIAL GATE'S REPRODUCTIONS.
 *
 * Each `it` states the behaviour the round owes. Where the round does not
 * deliver it the test fails, and the failure is the reproduction; the gate
 * report numbers each one. Credentials here are minted in this process.
 *
 * Order matters: the WEB-segment collision runs before any booking has minted
 * a WEB invoice today, and the demo reset runs last because it wipes the day.
 */

const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOGATEMERCHANT';
const WEBHOOK_TOKEN = 'a-path-filter-not-a-credential';
const CONFIRM = 'RESET DEMO DATA';

let ctx: TestContext;
let reception: string;
let admin: string;
let accountId: string;
let branchId: string;
let operatorId: string;
let timezone: string;
let dayStart: string;
let twoHoursId: string;
let jamesId: string;

const today = (): string => businessDate(new Date(), timezone, parseDayStart(dayStart));

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      OPS_TEST_CONTROLS: 'true',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: MERCHANT,
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: WEBHOOK_TOKEN,
    },
  });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = central!.id;
  operatorId = central!.operatorId;
  timezone = central!.timezone;
  dayStart = central!.businessDayStart;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;
  const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: reception } });
  accountId = me.json().account.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers ----------------------------------------------------------------------

async function bookOk(over: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      parentName: 'Gate Family',
      tier: 'tourist',
      visitDate: today(),
      lines: [{ packageId: twoHoursId, kids: 1, adults: 1 }],
      ...over,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; reference: string; totalSatang: number; status: string };
}

async function checkout(bookingId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${bookingId}/checkout`,
    payload: { method: 'promptpay' },
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

function simulator() {
  return gatewayFor(ctx.app.env).qr as unknown as {
    apply: (invoiceNo: string, event: string, opts?: { amountSatang?: number }) => { tranRef: string | null } | null;
    createHostedPayment: (input: unknown) => Promise<unknown>;
  };
}

function wire(amountSatang: number): string {
  return `${Math.trunc(amountSatang / 100)}.${String(amountSatang % 100).padStart(2, '0')}000`;
}

async function postNotification(claims: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/payment?t=${WEBHOOK_TOKEN}`,
    payload: {
      payload: signJwt(
        {
          merchantID: MERCHANT,
          currencyCode: 'THB',
          transactionDateTime: '20260930101500',
          agentCode: 'SCB',
          channelCode: 'PPQR',
          respCode: '0000',
          respDesc: 'Successful',
          ...claims,
        },
        SECRET,
      ),
    },
  });
}

async function productIdByCode(code: string): Promise<string> {
  const [row] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, code)));
  return row!.id;
}

// --- G1 · The WEB invoice segment is not reserved --------------------------------------

describe('G1 — a station coded WEB and the booking site share one invoice namespace', () => {
  it('a booking checkout still opens after a till whose code prefix is WEB showed a QR today', async () => {
    const tills = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
    const t2 = tills.find((s) => s.codePrefix === 'T2')!;
    // `assertStationCodePrefix` accepts any 1-6 upper-case letters or digits for a till.
    await ctx.db.update(station).set({ codePrefix: 'WEB' }).where(eq(station.id, t2.id));
    let tillAttemptId: string | null = null;
    try {
      const saleId = newId();
      const rung = await ctx.app.inject({
        method: 'POST',
        url: '/sales',
        headers: { cookie: reception },
        payload: {
          id: saleId,
          stationId: t2.id,
          memberId: jamesId,
          lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
        },
      });
      expect(rung.statusCode, rung.body).toBe(200);
      const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      const shown = await openQrAttempt(
        ctx.db,
        ctx.app.env,
        ctx.app.log,
        { operatorId, branchId, requestId: 'gate-web-till' },
        {
          operatorId,
          branchId,
          saleId,
          stationId: t2.id,
          businessDate: today(),
          amountSatang: saleRow!.grossSatang,
          methodCode: 'promptpay',
          actionId: newId(),
          accountId,
          description: 'OTO Park admission',
        },
      );
      tillAttemptId = shown.attempt.id;
      expect(shown.attempt.invoiceNo).toMatch(/^WEB\d{12}$/);

      // The booking site now mints its first WEB invoice of the day — and,
      // because `mintWebInvoiceNo` reads only station-less rows, every later
      // one too: each checkout of the day re-mints ...000001 and is refused.
      for (let i = 0; i < 2; i += 1) {
        const made = await bookOk();
        const opened = await checkout(made.id);
        expect(opened.statusCode, opened.body).toBe(200);
      }
    } finally {
      // Undo the collision so the rest of this file runs on a clean day.
      if (tillAttemptId) await ctx.db.delete(paymentAttempt).where(eq(paymentAttempt.id, tillAttemptId));
      await ctx.db.update(station).set({ codePrefix: 'T2' }).where(eq(station.id, t2.id));
    }
  });
});

// --- G1 fix · WEB is the booking site's ------------------------------------------------

describe('G1 fix — no station may take the WEB code', () => {
  it('refuses WEB on a new till and on an edit, and leaves the prefix as it was', async () => {
    const [t2] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T2')));
    const edited = await ctx.app.inject({
      method: 'PATCH',
      url: `/stations/${t2!.id}`,
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { codePrefix: 'WEB' },
    });
    expect(edited.statusCode, edited.body).toBe(400);
    expect(edited.json().error.code).toBe('STATION_CODE_PREFIX_RESERVED');
    const [after] = await ctx.db.select().from(station).where(eq(station.id, t2!.id));
    expect(after!.codePrefix).toBe('T2');

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/stations`,
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: {
        name: `Web Till ${Math.random().toString(36).slice(2, 8)}`,
        kind: 'till',
        boxId: t2!.boxId,
        codePrefix: 'WEB',
        capabilities: ['tickets'],
        accessScope: 'all_staff',
        staffAccountIds: [],
        devices: [],
      },
    });
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json().error.code).toBe('STATION_CODE_PREFIX_RESERVED');
  });
});

// --- G2 · Money: the amount the gateway saw ---------------------------------------------

describe('G2 — an amount that is not the booking total pays nothing', () => {
  it('a notification and inquiry for less than the booking total leave it unpaid', async () => {
    const made = await bookOk();
    const opened = await checkout(made.id);
    expect(opened.statusCode, opened.body).toBe(200);
    const { attemptId } = opened.json() as { attemptId: string };
    const invoiceNo = (await attemptRow(attemptId)).invoiceNo!;
    simulator().apply(invoiceNo, 'paid', { amountSatang: made.totalSatang - 100 });
    const res = await postNotification({ invoiceNo, amount: wire(made.totalSatang - 100), tranRef: 'TR-GATE-SHORT' });
    expect(res.json().outcome).toBe('amount_mismatch');
    const row = await bookingRow(made.id);
    expect(row.status).toBe('pending');
    expect(row.qrSignature).toBeNull();
  });

  it('a notification claiming the right amount over an inquiry that says less pays nothing', async () => {
    const made = await bookOk();
    const opened = await checkout(made.id);
    const { attemptId } = opened.json() as { attemptId: string };
    const invoiceNo = (await attemptRow(attemptId)).invoiceNo!;
    simulator().apply(invoiceNo, 'paid', { amountSatang: made.totalSatang - 1 });
    const res = await postNotification({ invoiceNo, amount: wire(made.totalSatang), tranRef: 'TR-GATE-LIE' });
    expect(res.json().outcome).toBe('amount_mismatch');
    expect((await bookingRow(made.id)).status).toBe('pending');
  });

  it('a paid booking cannot be checked out a second time', async () => {
    const made = await bookOk();
    const opened = await checkout(made.id);
    const { attemptId } = opened.json() as { attemptId: string };
    const press = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/2c2p/hosted/${attemptId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=pay',
    });
    expect(press.statusCode).toBe(200);
    expect((await bookingRow(made.id)).status).toBe('paid');
    const again = await checkout(made.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('BOOKING_ALREADY_PAID');
  });
});

// --- G1 fix · the other order ------------------------------------------------------------

describe('G1 fix — a till still coded WEB after the booking site has minted today', () => {
  it("numbers its QR after the booking site's, and the next checkout after the till's", async () => {
    // Bookings above have minted WEB invoices today. A till saved with the
    // code before it was reserved (written straight to the row, as the old
    // rule allowed) now shares the booking site's counter instead of
    // starting its own at 000001.
    const seqOf = (invoiceNo: string) => Number(invoiceNo.slice(-6));
    const before = await bookOk();
    const first = await checkout(before.id);
    expect(first.statusCode, first.body).toBe(200);
    const firstInvoice = (await attemptRow((first.json() as { attemptId: string }).attemptId)).invoiceNo!;

    const tills = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
    const t2 = tills.find((s) => s.codePrefix === 'T2')!;
    await ctx.db.update(station).set({ codePrefix: 'WEB' }).where(eq(station.id, t2.id));
    let tillAttemptId: string | null = null;
    try {
      const saleId = newId();
      const rung = await ctx.app.inject({
        method: 'POST',
        url: '/sales',
        headers: { cookie: reception },
        payload: {
          id: saleId,
          stationId: t2.id,
          memberId: jamesId,
          lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
        },
      });
      expect(rung.statusCode, rung.body).toBe(200);
      const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      const shown = await openQrAttempt(
        ctx.db,
        ctx.app.env,
        ctx.app.log,
        { operatorId, branchId, requestId: 'gate-web-till-after' },
        {
          operatorId,
          branchId,
          saleId,
          stationId: t2.id,
          businessDate: today(),
          amountSatang: saleRow!.grossSatang,
          methodCode: 'promptpay',
          actionId: newId(),
          accountId,
          description: 'OTO Park admission',
        },
      );
      tillAttemptId = shown.attempt.id;
      expect(shown.attempt.invoiceNo!.slice(0, -6)).toBe(firstInvoice.slice(0, -6));
      expect(seqOf(shown.attempt.invoiceNo!)).toBe(seqOf(firstInvoice) + 1);

      const after = await bookOk();
      const next = await checkout(after.id);
      expect(next.statusCode, next.body).toBe(200);
      const nextInvoice = (await attemptRow((next.json() as { attemptId: string }).attemptId)).invoiceNo!;
      expect(seqOf(nextInvoice)).toBe(seqOf(firstInvoice) + 2);
    } finally {
      if (tillAttemptId) await ctx.db.delete(paymentAttempt).where(eq(paymentAttempt.id, tillAttemptId));
      await ctx.db.update(station).set({ codePrefix: 'T2' }).where(eq(station.id, t2.id));
    }
  });
});

// --- G3 · Satang exactness against the till's own quote ----------------------------------

describe('G3 — the booking quote and the till quote agree to the satang', () => {
  async function tillQuote(lines: unknown[]) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales/quote',
      headers: { cookie: reception },
      payload: { memberId: jamesId, lines },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { tier: string; totals: { grossSatang: number } };
  }

  async function bothFor(config?: TaxConfigShape) {
    const [before] = await ctx.db.select().from(branchTaxConfig).where(eq(branchTaxConfig.branchId, branchId));
    if (config) await ctx.db.update(branchTaxConfig).set({ config }).where(eq(branchTaxConfig.branchId, branchId));
    try {
      const locker = await productIdByCode('AO-LOCKER');
      const cup = await productIdByCode('AO-CUP');
      const till = await tillQuote([
        {
          id: newId(),
          packageId: twoHoursId,
          kids: 2,
          adults: 3,
          addOns: [
            { id: locker, quantity: 1 },
            { id: cup, quantity: 2 },
          ],
        },
      ]);
      expect(till.tier).toBe('expat');
      const made = await bookOk({
        tier: 'expat',
        lines: [
          {
            packageId: twoHoursId,
            kids: 2,
            adults: 3,
            addOns: [
              { id: 'a-locker', quantity: 1 },
              { id: 'a-cup', quantity: 2 },
            ],
          },
        ],
      });
      return { till: till.totals.grossSatang, booked: made.totalSatang };
    } finally {
      await ctx.db
        .update(branchTaxConfig)
        .set({ config: before!.config })
        .where(eq(branchTaxConfig.branchId, branchId));
    }
  }

  it('under the seeded tax configuration', async () => {
    const { till, booked } = await bothFor();
    expect(booked).toBe(till);
  });

  it('under exclusive VAT with a service charge on every area', async () => {
    const config: TaxConfigShape = {
      rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
      categoryRules: TAXABLE_CATEGORIES.map((category) =>
        category === 'stored_value'
          ? { category, taxMode: 'none' as const, serviceChargePercent: 0, taxOnServiceCharge: false }
          : {
              category,
              taxRateId: 'vat',
              taxMode: 'exclusive' as const,
              serviceChargePercent: 10,
              taxOnServiceCharge: true,
            },
      ),
      discountPlacement: 'before_tax',
    };
    const { till, booked } = await bothFor(config);
    expect(booked).toBe(till);
  });
});

// --- G4 · The poller and a checkout in flight ------------------------------------------

describe('G4 — an inquiry tick landing while the hosted page is being opened', () => {
  it('does not cancel the booking the guest is about to pay', async () => {
    const made = await bookOk();
    const sim = simulator();
    const original = sim.createHostedPayment.bind(sim);
    // The job runner's inquiry tick (every PGW_INQUIRY_INTERVAL_S, 3 s by
    // default) lands between act 1 (the attempt committed `created`) and the
    // gateway's answer to the Payment Token call — the ordinary case on a
    // slow link, since the token call is a network round trip.
    sim.createHostedPayment = async (input: unknown) => {
      await pollPendingAttempts(ctx.db, ctx.app.env, ctx.app.log);
      return original(input);
    };
    let attemptId: string;
    try {
      const opened = await checkout(made.id);
      expect(opened.statusCode, opened.body).toBe(200);
      attemptId = (opened.json() as { attemptId: string }).attemptId;
    } finally {
      sim.createHostedPayment = original;
    }
    // The guest is on the hosted page now. The booking must still be waiting.
    expect((await bookingRow(made.id)).status).toBe('pending');

    // The guest pays; that is an on-time payment, not a late one.
    const press = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/2c2p/hosted/${attemptId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=pay',
    });
    expect(press.statusCode).toBe(200);
    expect((await bookingRow(made.id)).status).toBe('paid');
    const late = await ctx.db.select().from(alert).where(eq(alert.key, `bookings.late_payment:${made.id}`));
    expect(late).toHaveLength(0);
  });
});

// --- G4 fix · a payment that is over stays over -----------------------------------------

describe('G4 fix — an attempt closed while its page was opening is never shown', () => {
  it('past the grace the poller may close a stuck opening, and the checkout then refuses', async () => {
    const made = await bookOk();
    const sim = simulator();
    const original = sim.createHostedPayment.bind(sim);
    // A tick a full grace later: the attempt is still `created` (the token
    // call has not come back) and the gateway has never heard of it.
    sim.createHostedPayment = async (input: unknown) => {
      await pollPendingAttempts(
        ctx.db,
        ctx.app.env,
        ctx.app.log,
        new Date(Date.now() + OPENING_GRACE_MS + 1_000),
      );
      return original(input);
    };
    let res;
    try {
      res = await checkout(made.id);
    } finally {
      sim.createHostedPayment = original;
    }
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('BOOKING_PAYMENT_CLOSED');
    const row = await bookingRow(made.id);
    expect(row.status).toBe('cancelled');
    // Not put back on a display: the attempt stays closed.
    expect((await attemptRow(row.paymentAttemptId!)).status).toBe('not_found');
  });
});

// --- G6 · 2002 about a hosted page that is still open ------------------------------------

describe('G6 — a hosted page the gateway says it has not heard of', () => {
  it('keeps waiting while the page is open, and expires the booking once it has run out', async () => {
    const made = await bookOk();
    const opened = await checkout(made.id);
    expect(opened.statusCode, opened.body).toBe(200);
    const { attemptId } = opened.json() as { attemptId: string };
    // An invoice the simulator never recorded answers 2002 to an inquiry —
    // what 2C2P may say about a token nobody has paid on yet.
    const unknownInvoice = `ZZ${Date.now()}`;
    await ctx.db
      .update(paymentAttempt)
      .set({ invoiceNo: unknownInvoice })
      .where(eq(paymentAttempt.id, attemptId));

    await pollPendingAttempts(ctx.db, ctx.app.env, ctx.app.log);
    expect((await attemptRow(attemptId)).status).toBe('sent_to_terminal');
    expect((await bookingRow(made.id)).status).toBe('pending');

    const expiresAt = (await attemptRow(attemptId)).expiresAt!;
    await pollPendingAttempts(ctx.db, ctx.app.env, ctx.app.log, new Date(expiresAt.getTime() + 61_000));
    const closed = await attemptRow(attemptId);
    expect(closed.status).toBe('cancelled');
    expect((closed.payload as { expired?: boolean }).expired).toBe(true);
    expect((await bookingRow(made.id)).status).toBe('expired');
  });
});

// --- G7 · The site's basket inputs come from the platform -------------------------------

describe("G7 — the booking site prices its basket with the platform's numbers", () => {
  type PublicCatalogBody = {
    rateMode: { mode: 'weekday' | 'weekend' };
    packages: Array<{
      id: string;
      prices: Record<string, { weekday: number; weekend: number }>;
      adultRules: unknown;
    }>;
    addOns: Array<{
      id: string;
      name: string;
      priceSatang: number;
      priceWeekendSatang: number | null;
      taxCategory: string | null;
    }>;
    taxConfig: TaxConfigShape | null;
  };

  async function publicCatalog(): Promise<PublicCatalogBody> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as PublicCatalogBody;
  }

  /**
   * The total the site shows, from nothing but the public catalogue: the
   * package, the extras at their catalogue prices by the rate mode, the socks
   * extra by its id, and the branch's tax configuration — the inputs
   * `cartWire.ticketTotals` totals on the booking site.
   */
  function siteTotal(cat: PublicCatalogBody, picks: Array<{ id: string; quantity: number }>): number {
    const mode = cat.rateMode.mode;
    const priced = (id: string) => {
      const a = cat.addOns.find((x) => x.id === id)!;
      return {
        a,
        unit: resolveRate({ weekday: a.priceSatang, weekend: a.priceWeekendSatang ?? a.priceSatang }, mode),
      };
    };
    const socks = cat.addOns.find((x) => x.id === 'a-socks');
    const pricing: PricingContext = {
      mode,
      socks: { addOnId: 'a-socks', price: socks ? priced('a-socks').unit : 0, label: 'Regular Socks' },
    };
    const pkg = cat.packages.find((p) => p.id === twoHoursId)!;
    const addOns: CartAddOn[] = picks.map((pick) => {
      const { a, unit } = priced(pick.id);
      return {
        id: a.id,
        name: a.name,
        price: unit,
        quantity: pick.quantity,
        ...(a.taxCategory
          ? { taxCategoryOverride: a.taxCategory as NonNullable<CartAddOn['taxCategoryOverride']> }
          : {}),
      };
    });
    const line: TicketCartLine = {
      id: 'site-line-1',
      packageId: pkg.id,
      package: { prices: pkg.prices, adultRules: pkg.adultRules as never },
      tier: 'tourist',
      kids: 2,
      adults: 2,
      socks: 0,
      addOns,
      lineTotal: 0,
    };
    line.lineTotal = priceCartLine(line, pricing);
    return computeTicketCartTotals([line], [], [], cat.taxConfig!, pricing).total;
  }

  it('answers the extras and the tax configuration, and a Console edit of either reaches the site', async () => {
    const socksId = await productIdByCode('AO-SOCKS');
    const lockerId = await productIdByCode('AO-LOCKER');
    const [socksBefore] = await ctx.db.select().from(product).where(eq(product.id, socksId));
    const [lockerBefore] = await ctx.db.select().from(product).where(eq(product.id, lockerId));
    const [taxBefore] = await ctx.db
      .select()
      .from(branchTaxConfig)
      .where(eq(branchTaxConfig.branchId, branchId));

    const seeded = await publicCatalog();
    expect(seeded.taxConfig).toEqual(taxBefore!.config);
    expect(seeded.addOns.find((a) => a.id === 'a-socks')!.priceSatang).toBe(socksBefore!.priceSatang);
    expect(seeded.addOns.find((a) => a.id === 'a-locker')!.priceSatang).toBe(lockerBefore!.priceSatang);

    const changedTax: TaxConfigShape = {
      rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
      categoryRules: TAXABLE_CATEGORIES.map((category) =>
        category === 'stored_value'
          ? { category, taxMode: 'none' as const, serviceChargePercent: 0, taxOnServiceCharge: false }
          : {
              category,
              taxRateId: 'vat',
              taxMode: 'exclusive' as const,
              serviceChargePercent: 10,
              taxOnServiceCharge: true,
            },
      ),
      discountPlacement: 'before_tax',
    };
    try {
      // What an edit in the Console writes: new prices, a weekend price on the
      // locker, and exclusive VAT with a service charge.
      await ctx.db
        .update(product)
        .set({ priceSatang: socksBefore!.priceSatang + 1_000 })
        .where(eq(product.id, socksId));
      await ctx.db
        .update(product)
        .set({
          priceSatang: lockerBefore!.priceSatang + 2_500,
          priceWeekendSatang: lockerBefore!.priceSatang + 4_000,
        })
        .where(eq(product.id, lockerId));
      await ctx.db
        .update(branchTaxConfig)
        .set({ config: changedTax })
        .where(eq(branchTaxConfig.branchId, branchId));

      const cat = await publicCatalog();
      expect(cat.taxConfig).toEqual(changedTax);
      expect(cat.addOns.find((a) => a.id === 'a-socks')!.priceSatang).toBe(socksBefore!.priceSatang + 1_000);
      expect(cat.addOns.find((a) => a.id === 'a-locker')!.priceWeekendSatang).toBe(
        lockerBefore!.priceSatang + 4_000,
      );

      // The site's total, built from that answer alone, is the platform's quote.
      const picks = [
        { id: 'a-socks', quantity: 2 },
        { id: 'a-locker', quantity: 1 },
      ];
      const shown = siteTotal(cat, picks);
      const made = await bookOk({
        lines: [{ packageId: twoHoursId, kids: 2, adults: 2, addOns: picks }],
        displayedTotalSatang: shown,
      });
      expect(made.totalSatang).toBe(shown);
    } finally {
      await ctx.db
        .update(product)
        .set({ priceSatang: socksBefore!.priceSatang })
        .where(eq(product.id, socksId));
      await ctx.db
        .update(product)
        .set({ priceSatang: lockerBefore!.priceSatang, priceWeekendSatang: lockerBefore!.priceWeekendSatang })
        .where(eq(product.id, lockerId));
      await ctx.db
        .update(branchTaxConfig)
        .set({ config: taxBefore!.config })
        .where(eq(branchTaxConfig.branchId, branchId));
    }
  });
});

// --- G5 · The demo reset, last: it wipes the day ---------------------------------------

describe('G5 — the staging demo reset after a booking reached checkout', () => {
  it('(set-up) a booking paid online and redeemed at the counter is on the day', async () => {
    const made = await bookOk();
    const opened = await checkout(made.id);
    const { attemptId } = opened.json() as { attemptId: string };
    const press = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/2c2p/hosted/${attemptId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=pay',
    });
    expect(press.statusCode).toBe(200);
    const [t1] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
    const redeemed = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${made.id}/redeem`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { stationId: t1!.id },
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(
      await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, made.id)),
    ).toHaveLength(1);
  });

  it('still resets (booking.payment_attempt_id restricts the attempt delete)', async () => {
    const made = await bookOk();
    const opened = await checkout(made.id);
    expect(opened.statusCode, opened.body).toBe(200);
    // The service, in a transaction rolled back afterwards, so the refusal's
    // own words are the failure message.
    const rehearsal = await ctx.db
      .transaction(async (tx) => {
        await resetDemoData(tx);
        tx.rollback();
      })
      .then(
        () => 'ok',
        (err: Error) => (err.message.includes('Rollback') ? 'ok' : `${err.message} ${(err as { cause?: Error }).cause?.message ?? ''}`),
      );
    expect(rehearsal).toBe('ok');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ops/demo-reset',
      headers: { cookie: admin },
      payload: { confirm: CONFIRM },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await ctx.db.select().from(booking)).toHaveLength(0);
    // The counter's claim went with its booking (it restricts the delete).
    expect(await ctx.db.select().from(bookingRedemption)).toHaveLength(0);
  });
});
