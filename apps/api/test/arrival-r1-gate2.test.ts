import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { alert, booking, branch, paymentAttempt, ticketPackage } from '@oto/db';
import {
  businessDate,
  computeTicketCartTotals,
  getRateModeForDate,
  parseDayStart,
  priceCartLine,
  type PricingContext,
  type TaxConfigShape,
  type TicketCartLine,
} from '@oto/shared';
import { createJobRunner } from '../src/services/jobs';
import { buildAlertChannels } from '../src/services/ops';
import { CENTRAL_BRANCH_CODE, createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-209 ROUND 1, RE-CHECK GATE — reproduction R1, the platform's half.
 *
 * The booking site sends NO `visitDate` (`pages/Book.tsx`), so the platform
 * quotes the booking at `branchToday(tz)` — the CALENDAR date in Bangkok —
 * and, since this round, refuses a shown total that is not that quote
 * (409 `BOOKING_TOTAL_CHANGED`). The site prices at its `todayRateMode()`,
 * which trusts the catalogue's `rateMode` only while the catalogue's date is
 * the branch's TRADING date (`businessDate`, 05:00 day start) — see
 * `apps/pos/src/lib/pricingMode.ts` `liveServerAnswer` — and otherwise uses the
 * trading date's own mode. `apps/pos/test/arrival-r1-gate2.test.ts` shows the
 * site doing exactly that; this file shows the platform then refusing it.
 *
 * Between 00:00 and 05:00 Bangkok on a Saturday (and a Monday, and either side
 * of a holiday range) every booking made on the site is refused. The `it`
 * states the behaviour owed: the family is not refused for the figure the site
 * showed them. Credentials here are minted in this process.
 *
 * FIXED IN THE SECOND FIX ROUND. The public catalogue's `rateMode` and the
 * quote's default date are both the branch's TRADING day now
 * (`bookingToday`), the rule the till's own pricing-mode route uses. The one
 * change to this file is the precondition line in the Saturday and Monday
 * cases that pinned the catalogue answering the CALENDAR date: that answer was
 * the defect, and the decided fix is what changes it. Every behavioural
 * assertion is as the gate wrote it.
 */

const SECRET = randomBytes(32).toString('hex');

let ctx: TestContext;
let branchId: string;
let timezone: string;
let dayStart: string;
let twoHoursId: string;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTOGATE2MERCHANT',
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = central!.id;
  timezone = central!.timezone;
  dayStart = central!.businessDayStart;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, central!.id));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
}, 180_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

type PublicCatalogBody = {
  branch: { timezone: string; businessDayStart: string };
  rateMode: { date: string; mode: 'weekday' | 'weekend' };
  holidays: Array<{ name: string; startsOn: string; endsOn: string }>;
  packages: Array<{
    id: string;
    prices: Record<string, { weekday: number; weekend: number }>;
    adultRules: unknown;
  }>;
  taxConfig: TaxConfigShape | null;
};

/** The booking site's `todayRateMode()` over the catalogue it loaded (pricingMode.ts:164-185, :236-238). */
function siteRateMode(cat: PublicCatalogBody): 'weekday' | 'weekend' {
  const trading = businessDate(new Date(), cat.branch.timezone, parseDayStart(cat.branch.businessDayStart));
  if (cat.rateMode.date === trading) return cat.rateMode.mode;
  return getRateModeForDate(trading, cat.holidays).mode;
}

/** The total the site shows for one kid and one adult on 2 Hours Play, tourist, at a mode. */
function siteTotal(cat: PublicCatalogBody, mode: 'weekday' | 'weekend'): number {
  const pkg = cat.packages.find((p) => p.id === twoHoursId)!;
  const pricing: PricingContext = { mode, socks: { addOnId: 'a-socks', price: 0, label: 'Regular Socks' } };
  const line: TicketCartLine = {
    id: 'site-line-1',
    packageId: pkg.id,
    package: { prices: pkg.prices, adultRules: pkg.adultRules as never },
    tier: 'tourist',
    kids: 1,
    adults: 1,
    socks: 0,
    addOns: [],
    lineTotal: 0,
  };
  line.lineTotal = priceCartLine(line, pricing);
  return computeTicketCartTotals([line], [], [], cat.taxConfig!, pricing).total;
}

async function bookAsTheSiteDoes(at: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  const catRes = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  expect(catRes.statusCode, catRes.body).toBe(200);
  const cat = catRes.json() as PublicCatalogBody;
  const mode = siteRateMode(cat);
  const shown = siteTotal(cat, mode);
  // Exactly the body `Book.tsx` posts: no visitDate, the total it showed.
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      parentName: 'Night Owl Family',
      tier: 'tourist',
      lines: [{ packageId: twoHoursId, kids: 1, adults: 1 }],
      locale: 'en',
      displayedTotalSatang: shown,
    },
  });
  return { cat, mode, shown, res };
}

describe('R1 — a booking made on the site between 00:00 and 05:00 Bangkok', () => {
  it('Saturday 02:30: the family is not refused for the total the site showed', async () => {
    const { cat, mode, res } = await bookAsTheSiteDoes('2026-10-02T19:30:00Z'); // Sat 2026-10-03 02:30
    expect(timezone).toBe('Asia/Bangkok');
    expect(parseDayStart(dayStart)).toBeGreaterThan(0);
    // The basket is priced differently on a weekday and at the weekend.
    expect(siteTotal(cat, 'weekday')).not.toBe(siteTotal(cat, 'weekend'));
    // The catalogue answers for the trading day, Friday / weekday, as the site reads it.
    expect(cat.rateMode).toMatchObject({ date: '2026-10-02', mode: 'weekday' });
    expect(mode).toBe('weekday');
    expect(res.statusCode, res.body).toBe(200);
  });

  it('Monday 02:30: the family is not refused for the total the site showed', async () => {
    const { cat, mode, res } = await bookAsTheSiteDoes('2026-10-04T19:30:00Z'); // Mon 2026-10-05 02:30
    // The trading day is still Sunday / weekend.
    expect(cat.rateMode).toMatchObject({ date: '2026-10-04', mode: 'weekend' });
    expect(mode).toBe('weekend');
    expect(res.statusCode, res.body).toBe(200);
  });

  it('(control) Saturday 10:30: the same request is accepted', async () => {
    const { cat, mode, res } = await bookAsTheSiteDoes('2026-10-03T03:30:00Z'); // Sat 2026-10-03 10:30
    expect(cat.rateMode).toMatchObject({ date: '2026-10-03', mode: 'weekend' });
    expect(mode).toBe('weekend');
    expect(res.statusCode, res.body).toBe(200);
  });
});

/**
 * R2 — `flagPendingPayments` counts EVERY `sent_to_terminal` attempt older than
 * `PAYMENT_PENDING_MIN` (gateway.ts, the sweeper's query has no station filter),
 * and this round made that same number the booking's hold and its hosted
 * page's expiry. A page the family walked away from is still
 * `sent_to_terminal` from the moment the hold ends until the poller closes it a
 * minute after the page's expiry (`isExhausted`), so every abandoned online
 * checkout opens the branch's "Tenders with no outcome" alert — a counter
 * signal about the till's tenders, on Health, that nobody at the counter can
 * act on. The `it` states the behaviour owed.
 */
describe('R2 — an online checkout the family walked away from', () => {
  it('ends the booking but does not open the branch alert "Tenders with no outcome"', async () => {
    const today = businessDate(new Date(), timezone, parseDayStart(dayStart));
    const made = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        branchCode: CENTRAL_BRANCH_CODE,
        parentName: 'Walked Away Family',
        tier: 'tourist',
        visitDate: today,
        lines: [{ packageId: twoHoursId, kids: 1, adults: 1 }],
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const bookingId = (made.json() as { id: string }).id;
    const opened = await ctx.app.inject({
      method: 'POST',
      url: `/public/bookings/${bookingId}/checkout`,
      payload: { method: 'card' },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const attemptId = (opened.json() as { attemptId: string }).attemptId;

    // The timeline of a page left open: checkout half a minute after the
    // booking; the hold and the page have just run out; the poller would
    // close the page a minute after its expiry.
    const now = Date.now();
    const holdMs = ctx.app.env.PAYMENT_PENDING_MIN * 60_000;
    await ctx.db.update(booking).set({ expiresAt: new Date(now - 36_000) }).where(eq(booking.id, bookingId));
    await ctx.db
      .update(paymentAttempt)
      .set({ createdAt: new Date(now - holdMs - 6_000), expiresAt: new Date(now - 6_000) })
      .where(eq(paymentAttempt.id, attemptId));

    const runner = createJobRunner({
      db: ctx.db,
      env: ctx.app.env,
      log: ctx.app.log,
      channels: buildAlertChannels('console', ctx.app.log),
    });
    await runner.runJob('job:payments.pending', { force: true });

    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, bookingId));
    expect(row!.status).toBe('expired');
    const open = await ctx.db
      .select()
      .from(alert)
      .where(and(eq(alert.key, `payments.pending:${branchId}`), eq(alert.status, 'open')));
    const naming = open.filter((a) =>
      ((a.detail as { attemptIds?: string[] } | null)?.attemptIds ?? []).includes(attemptId),
    );
    expect(naming).toHaveLength(0);
  });
});
