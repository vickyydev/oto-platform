import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booking, branch, product, sale, saleLine, station, ticketPackage } from '@oto/db';
import { newId, priceCartLine, salePrintDocumentOf, type TicketFreebieRule } from '@oto/shared';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-768 — THE FREE ITEMS SET ON A TICKET IN ADMIN ARE APPLIED AT THE TILL.
 *
 * Admin → Tickets saves "Free items in the rate" — a free adult, child or
 * add-on for chosen tiers — on the ticket package, and the platform priced the
 * sale as if there were none. These ring a walk-in family up at the till the
 * way the till does, with a ticket bundling one of each for the walk-in tier,
 * and read back what was charged, filed and printed. A booking paid online is
 * still redeemed for exactly what it was paid.
 */

const SECRET = randomBytes(32).toString('hex');
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
let stationId: string;
let twoHours: typeof ticketPackage.$inferSelect;
let oneHourId: string;
let grip: typeof product.$inferSelect;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTOTESTMERCHANT',
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = central!.id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHours = packages.find((p) => p.name === '2 Hours Play')!;
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
  // One size, so the counter is never asked which.
  const [glow] = await ctx.db.select().from(product).where(eq(product.code, 'AO-GLOW'));
  grip = glow!;
  const [till] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
  stationId = till!.id;
  const stood = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/station',
    headers: { cookie: reception },
    payload: { stationId },
  });
  expect(stood.statusCode, stood.body).toBe(200);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** Admin → Tickets saving the ticket's free items, as its form saves them. */
async function setFreebies(packageId: string, freebies: TicketFreebieRule[] | null) {
  await ctx.db.update(ticketPackage).set({ freebies: freebies as never }).where(eq(ticketPackage.id, packageId));
}

/** As Admin's form saves them: each with its own id. */
const bundle = (tiers: string[]): Array<TicketFreebieRule & { id: string }> => [
  { id: 'fb-adult', kind: 'adult', quantity: 1, tiers },
  { id: 'fb-child', kind: 'child', quantity: 1, tiers },
  { id: 'fb-addon', kind: 'addon', addOnId: grip.id, quantity: 1, tiers },
];

/** A walk-in family: two kids, two adults, two glow bands. */
const family = (lineId: string, lineTotalSatang?: number) => ({
  id: lineId,
  packageId: twoHours.id,
  kids: 2,
  adults: 2,
  addOns: [{ id: grip.id, quantity: 2 }],
  ...(lineTotalSatang !== undefined ? { lineTotalSatang } : {}),
});

/** The same line priced by the shared engine from the package row, with or without its free items. */
function engineTotal(mode: 'weekday' | 'weekend', tier: string, freebies: TicketFreebieRule[] | null): number {
  return priceCartLine(
    {
      id: 'probe',
      packageId: twoHours.id,
      package: {
        prices: twoHours.prices as Record<string, { weekday: number; weekend: number }>,
        adultRules: twoHours.adultRules as never,
        freebies,
      },
      tier,
      kids: 2,
      adults: 2,
      socks: 0,
      addOns: [{ id: grip.id, name: grip.name, price: mode === 'weekend' ? (grip.priceWeekendSatang ?? grip.priceSatang) : grip.priceSatang, quantity: 2 }],
      lineTotal: 0,
    },
    { mode, socks: { addOnId: 'socks-not-configured', price: 0, label: 'Socks' } },
  );
}

describe('a ticket bundling a free adult, child and add-on for the walk-in tier', () => {
  it('charges the family less the bundled units, each filed as a ฿0 line, and prints them', async () => {
    await setFreebies(twoHours.id, bundle(['tourist']));
    const saleId = newId();
    const lineId = newId();
    const commit = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: saleId, stationId, lines: [family(lineId)] },
    });
    expect(commit.statusCode, commit.body).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const mode = row!.pricingMode as 'weekday' | 'weekend';
    const kid = (twoHours.prices as Record<string, { weekday: number; weekend: number }>).tourist![mode];
    const gripUnit = mode === 'weekend' ? (grip.priceWeekendSatang ?? grip.priceSatang) : grip.priceSatang;

    const full = engineTotal(mode, 'tourist', null);
    const charged = engineTotal(mode, 'tourist', bundle(['tourist']));
    expect(charged).toBeLessThan(full);
    // One child, one adult (the seeded Tourist adult is a set price) and one glow band came off.
    const adultRule = (twoHours.adultRules as Record<string, { kind: string; price?: { weekday: number; weekend: number } }>).tourist!;
    const adult = adultRule.kind === 'set_price' ? adultRule.price![mode] : kid;
    expect(full - charged).toBe(kid + adult + gripUnit);

    const lines = await ctx.db
      .select()
      .from(saleLine)
      .where(eq(saleLine.saleId, saleId))
      .orderBy(asc(saleLine.lineNo));
    const filed = lines.map((l) => [l.kind, l.componentKey, l.label, l.quantity, l.grossSatang]);
    expect(filed).toContainEqual(['kids', 'kids', 'Kids', 1, expect.any(Number)]);
    expect(filed).toContainEqual(['kids', 'kids-free', 'Kids (free)', 1, 0]);
    expect(filed).toContainEqual(['addon', grip.id, 'Glow Band', 1, expect.any(Number)]);
    expect(filed).toContainEqual(['addon', grip.id, 'Glow Band (free)', 1, 0]);
    const freeAdults = lines.find((l) => l.kind === 'adults_free');
    expect(freeAdults?.grossSatang).toBe(0);
    expect(freeAdults?.quantity).toBeGreaterThanOrEqual(1);
    // The free band is handed over: its line names the product, so its stock is taken.
    expect(lines.filter((l) => l.productId === grip.id).map((l) => l.quantity)).toEqual([1, 1]);
    expect(lines.reduce((sum, l) => sum + l.grossSatang, 0)).toBe(charged);

    const fin = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
    expect(fin.statusCode, fin.body).toBe(200);
    const [closed] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const receipt = salePrintDocumentOf(await salePrintSnapshotOf(ctx.db, closed!), {
      kind: 'receipt',
      subjectType: 'sale',
      subjectId: saleId,
    });
    const printed = (receipt!.data as { lines: Array<{ qty: number; name: string; price: string }> }).lines;
    expect(printed.find((l) => l.name.includes('Kids (free)'))).toMatchObject({ qty: 1 });
    expect(printed.find((l) => l.name.includes('Kids (free)'))!.price).toBe('฿0');
    expect(printed.find((l) => l.name.includes('Glow Band (free)'))).toMatchObject({ qty: 1 });
  });

  it("refuses a till still charging the free items, so the guest is never quoted the old figure", async () => {
    await setFreebies(twoHours.id, bundle(['tourist']));
    const quote = await ctx.app.inject({
      method: 'POST',
      url: '/sales/quote',
      headers: { cookie: reception },
      payload: { stationId, lines: [family('0190a0a0-0000-7000-8000-00000000d768')] },
    });
    expect(quote.statusCode, quote.body).toBe(200);
    const quoted = quote.json().quote as { pricingMode: 'weekday' | 'weekend'; lineTotals: Record<string, number> };
    const mode = quoted.pricingMode;
    expect(quoted.lineTotals['0190a0a0-0000-7000-8000-00000000d768']).toBe(engineTotal(mode, 'tourist', bundle(['tourist'])));

    const stale = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: newId(), stationId, lines: [family(newId(), engineTotal(mode, 'tourist', null))] },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('SALE_LINE_PRICE_MISMATCH');
  });

  it('gives nothing free at a tier the items were not set for', async () => {
    await setFreebies(twoHours.id, bundle(['thai']));
    const saleId = newId();
    const commit = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: saleId, stationId, lines: [family(newId())] },
    });
    expect(commit.statusCode, commit.body).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines.some((l) => l.label.endsWith('(free)') && l.kind !== 'adults_free')).toBe(false);
    expect(lines.reduce((sum, l) => sum + l.grossSatang, 0)).toBe(
      engineTotal(row!.pricingMode as 'weekday' | 'weekend', 'tourist', null),
    );
  });
});

describe('a booking paid online', () => {
  it('is redeemed for exactly what it was paid, free items on the ticket or not', async () => {
    await setFreebies(oneHourId, bundle(['tourist', 'thai', 'expat']));
    const cat = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
    expect(cat.statusCode, cat.body).toBe(200);
    const made = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      remoteAddress: '10.233.0.1',
      payload: {
        branchCode: CENTRAL_BRANCH_CODE,
        phone: '0812345678',
        parentName: 'ZZ TEST Khun Mali',
        tier: 'tourist',
        visitDate: WEEKDAY,
        lines: [{ packageId: oneHourId, kids: 2, adults: 2 }],
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().id as string;
    const opened = await ctx.app.inject({
      method: 'POST',
      url: `/public/bookings/${id}/checkout`,
      remoteAddress: '10.233.0.1',
      payload: { method: 'card' },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const pressed = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/2c2p/hosted/${opened.json().attemptId as string}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=pay',
    });
    expect(pressed.statusCode, pressed.body).toBe(200);
    const [paid] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    expect(paid!.status).toBe('paid');

    const redeemed = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${id}/redeem`,
      headers: { cookie: reception },
      payload: {},
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const [filed] = await ctx.db
      .select()
      .from(sale)
      .where(and(eq(sale.bookingId, id), eq(sale.branchId, branchId)));
    expect(filed!.grossSatang).toBe(paid!.totalSatang);
  });
});
