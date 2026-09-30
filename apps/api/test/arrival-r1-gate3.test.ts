import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booking, branch, ticketPackage } from '@oto/db';
import { addDaysToIsoDate, businessDate, parseDayStart } from '@oto/shared';
import { CENTRAL_BRANCH_CODE, createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-209 ROUND 1, THIRD GATE — reproduction V1: the visit date's bounds
 * live only in the browser.
 *
 * The second fix round added the visit-date step to /book with the rule
 * "today at the earliest, sixty days out at the latest"
 * (`apps/pos/src/lib/visitDate.ts` `visitDateBounds` / `clampVisitDate`). The
 * platform, which is what prices and takes the money, does not hold the same
 * rule: `createPublicBooking` (`apps/api/src/services/booking-checkout.ts`)
 * checks only that `visitDate` is shaped like a date. A caller of the OPEN
 * route `POST /public/bookings` can therefore write a pending booking — and
 * open a real payment for it — for a day that has already gone, or for a day
 * years away, priced at that day's rate. The round-1 redeem at the till does
 * not look at the booking's date, so a booking priced for a past weekday is
 * redeemable on any day.
 *
 * The two failing cases state the behaviour owed (the site's own bounds,
 * enforced where the price is decided); the control shows the same request
 * inside the window is accepted. Credentials here are minted in this process.
 */

const SECRET = randomBytes(32).toString('hex');

let ctx: TestContext;
let timezone: string;
let dayStart: string;
let oneHourId: string;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTOGATE3MERCHANT',
      PGW_SECRET_KEY: SECRET,
    },
  });
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  timezone = central!.timezone;
  dayStart = central!.businessDayStart;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, central!.id));
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

let caller = 0;
function address(): string {
  caller += 1;
  return `10.213.0.${caller}`;
}

const tradingDay = (): string => businessDate(new Date(), timezone, parseDayStart(dayStart));

async function bookFor(visitDate: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: address(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      parentName: 'Gate Three',
      tier: 'tourist',
      visitDate,
      lines: [{ packageId: oneHourId, kids: 1, adults: 1 }],
    },
  });
}

describe('V1 — the platform holds the visit-date step to the bounds the site offers', () => {
  it('refuses a visit date before the branch’s trading day', async () => {
    const past = addDaysToIsoDate(tradingDay(), -7);
    const res = await bookFor(past);
    if (res.statusCode === 200) {
      // What the platform does today: a pending booking for a day that has gone,
      // and a real payment page for it.
      const made = res.json() as { id: string; visitDate: string; status: string };
      const [row] = await ctx.db.select().from(booking).where(eq(booking.id, made.id));
      const checkout = await ctx.app.inject({
        method: 'POST',
        url: `/public/bookings/${made.id}/checkout`,
        remoteAddress: address(),
        payload: { method: 'card' },
      });
      expect.soft(row?.businessDate, 'the booking is written for the past day').toBe(past);
      expect.soft(checkout.statusCode, 'and a payment for it opens').toBe(200);
    }
    expect(res.statusCode, `a booking for ${past} (a week ago) was accepted: ${res.body}`).toBe(400);
  });

  it('refuses a visit date past the sixty days the site offers', async () => {
    const far = addDaysToIsoDate(tradingDay(), 400);
    const res = await bookFor(far);
    expect(res.statusCode, `a booking for ${far} was accepted: ${res.body}`).toBe(400);
  });

  it('(control) accepts tomorrow', async () => {
    const res = await bookFor(addDaysToIsoDate(tradingDay(), 1));
    expect(res.statusCode, res.body).toBe(200);
  });
});
