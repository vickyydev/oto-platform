import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alert, auditLog, band, booking, branch, branchTaxConfig, sale, saleLine, station, ticketPackage } from '@oto/db';
import { TAXABLE_CATEGORIES, formatTHB, newId, type TaxConfigShape } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { sameTaxRule } from '../src/services/booking-redemption';

/**
 * SCRUM-1013 — A PAID ONLINE BOOKING AFTER A TAX CHANGE: let the family in at
 * what they paid, flagged for a manager (the owner's ruling of 19 November).
 *
 * The park keeps one tax rule per branch and edits it in place, and a booking
 * kept its paid total but not the rule: a redemption after a change priced the
 * lines under the new rule, met a different sum and refused, so a family that
 * had paid was turned away. These pin, in the order of the brief's checks:
 *   - a booking stores the park's rule at the moment it is priced;
 *   - booked under 7% inclusive, the rule changed, redeemed: bands issued, the
 *     sale at the paid sum with the booked tax on its lines, the flag present
 *     (audit row with both figures and both rules, the sale's note, the
 *     Console alert), and a replay makes one sale;
 *   - with no tax change: unchanged, no flag;
 *   - an older booking that stored no rule: refused as today, nothing written.
 */

const SECRET = randomBytes(32).toString('hex');

let ctx: TestContext;
let reception: string;
let branchId: string;
let tillId: string;
let twoHoursId: string;
let seededRule: TaxConfigShape;

/** Exclusive VAT with a service charge on every area: the same lines cost more. */
const EXCLUSIVE_WITH_SERVICE: TaxConfigShape = {
  rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
  categoryRules: TAXABLE_CATEGORIES.map((category) =>
    category === 'stored_value'
      ? { category, taxMode: 'none' as const, serviceChargePercent: 0, taxOnServiceCharge: false }
      : { category, taxRateId: 'vat', taxMode: 'exclusive' as const, serviceChargePercent: 10, taxOnServiceCharge: true },
  ),
  discountPlacement: 'before_tax',
};

let caller = 0;
const address = (): string => {
  caller += 1;
  return `10.213.${Math.floor(caller / 250)}.${(caller % 250) + 1}`;
};

async function bookAndPay(): Promise<{ id: string; reference: string; totalSatang: number }> {
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: address(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      parentName: 'ZZ TEST Tax Family',
      tier: 'tourist',
      lines: [{ packageId: twoHoursId, kids: 2, adults: 1 }],
    },
  });
  expect(made.statusCode, made.body).toBe(200);
  const body = made.json() as { id: string; reference: string; totalSatang: number };
  const opened = await ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${body.id}/checkout`,
    remoteAddress: address(),
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
  return body;
}

function redeem(id: string, key: string = newId()) {
  return ctx.app.inject({
    method: 'POST',
    url: `/bookings/${id}/redeem`,
    headers: { cookie: reception, 'idempotency-key': key },
    payload: { stationId: tillId },
  });
}

async function withRule<T>(rule: TaxConfigShape, run: () => Promise<T>): Promise<T> {
  await ctx.db.update(branchTaxConfig).set({ config: rule }).where(eq(branchTaxConfig.branchId, branchId));
  try {
    return await run();
  } finally {
    await ctx.db.update(branchTaxConfig).set({ config: seededRule }).where(eq(branchTaxConfig.branchId, branchId));
  }
}

const salesOf = (bookingId: string) => ctx.db.select().from(sale).where(eq(sale.bookingId, bookingId));

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
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  const [cfg] = await ctx.db.select().from(branchTaxConfig).where(eq(branchTaxConfig.branchId, branchId));
  seededRule = cfg!.config as TaxConfigShape;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-1013 — a booking keeps the tax rule it was priced under', () => {
  it('stores the park rule in its pricing snapshot', async () => {
    const made = await bookAndPay();
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, made.id));
    const snapshot = row!.pricingSnapshot as { taxConfig?: TaxConfigShape };
    expect(snapshot.taxConfig).toBeDefined();
    expect(sameTaxRule(snapshot.taxConfig!, seededRule)).toBe(true);
  });

  it('the seeded rule is 7% inclusive on tickets, the case the owner named', () => {
    const tickets = seededRule.categoryRules.find((r) => r.category === 'tickets')!;
    expect(tickets.taxMode).toBe('inclusive');
    expect(seededRule.rates.find((r) => r.id === tickets.taxRateId)!.percent).toBe(7);
  });

  it('two rules listing the same rates in another order are the same rule', () => {
    const reordered: TaxConfigShape = { ...seededRule, categoryRules: [...seededRule.categoryRules].reverse() };
    expect(sameTaxRule(reordered, seededRule)).toBe(true);
    expect(sameTaxRule(EXCLUSIVE_WITH_SERVICE, seededRule)).toBe(false);
  });
});

describe('SCRUM-1013 — redeemed after the park changed its tax', () => {
  it('issues the bands, files the sale at the paid sum under the booked tax, and flags it for a manager', async () => {
    const made = await bookAndPay();
    const [booked] = await ctx.db.select().from(booking).where(eq(booking.id, made.id));
    const snapshot = booked!.pricingSnapshot as { taxSatang: number; serviceChargeSatang: number };
    const key = newId();

    await withRule(EXCLUSIVE_WITH_SERVICE, async () => {
      const res = await redeem(made.id, key);
      expect(res.statusCode, res.body).toBe(200);

      const sales = await salesOf(made.id);
      expect(sales).toHaveLength(1);
      const row = sales[0]!;
      expect(row.status).toBe('finalised');
      expect(row.grossSatang).toBe(made.totalSatang);
      // The booked tax: 7% inside the price, no service charge — the booking's own split.
      expect(sameTaxRule(row.taxConfig as TaxConfigShape, seededRule)).toBe(true);
      expect(row.taxInclusiveSatang).toBe(snapshot.taxSatang);
      expect(row.taxExclusiveSatang).toBe(0);
      expect(row.serviceChargeSatang).toBe(snapshot.serviceChargeSatang);
      const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, row.id));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines.filter((l) => l.taxableCategory === 'tickets')) {
        expect(line.taxMode).toBe('inclusive');
        expect(line.taxRateBp).toBe(700);
        expect(line.serviceChargeSatang).toBe(0);
      }
      // Bands issued: two kids and one adult.
      const bands = await ctx.db.select().from(band).where(eq(band.saleId, row.id));
      expect(bands.map((b) => b.kind).sort()).toEqual(['adult', 'kid', 'kid']);

      // The flag: both figures and both rules on the booking's audit row.
      const [flag] = await ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, made.id), eq(auditLog.action, 'booking.redeem.tax_drift')));
      const after = flag!.after as {
        paidTotalSatang: number;
        filedTotalSatang: number;
        currentRuleTotalSatang: number;
        bookedTaxConfig: TaxConfigShape;
        currentTaxConfig: TaxConfigShape;
        saleId: string;
      };
      expect(after.paidTotalSatang).toBe(made.totalSatang);
      expect(after.filedTotalSatang).toBe(made.totalSatang);
      expect(after.currentRuleTotalSatang).toBeGreaterThan(made.totalSatang);
      expect(after.saleId).toBe(row.id);
      expect(sameTaxRule(after.bookedTaxConfig, seededRule)).toBe(true);
      expect(sameTaxRule(after.currentTaxConfig, EXCLUSIVE_WITH_SERVICE)).toBe(true);

      // The note History shows on the sale, with both figures.
      expect(row.note).toContain(`Online booking ${made.reference}.`);
      expect(row.note).toContain('tax set-up changed after this was booked');
      expect(row.note).toContain(formatTHB(made.totalSatang));
      expect(row.note).toContain(formatTHB(after.currentRuleTotalSatang));

      // The Console's open alert, for a manager at this park.
      const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `bookings.tax_drift:${made.id}`));
      expect(raised).toMatchObject({ category: 'bookings.tax_drift', status: 'open', branchId });
      expect(raised!.summary).toContain(made.reference);

      // A replay of the press is the same answer; a second press is refused. One sale.
      const replay = await redeem(made.id, key);
      expect(replay.statusCode, replay.body).toBe(200);
      const second = await redeem(made.id);
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('BOOKING_ALREADY_REDEEMED');
      expect(await salesOf(made.id)).toHaveLength(1);
    });
  });
});

describe('SCRUM-1013 — with no tax change, nothing changes', () => {
  it('redeems under the park rule, with no flag', async () => {
    const made = await bookAndPay();
    const res = await redeem(made.id);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await salesOf(made.id);
    expect(row!.grossSatang).toBe(made.totalSatang);
    expect(row!.note).toBe(`Online booking ${made.reference}`);
    const flags = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, made.id), eq(auditLog.action, 'booking.redeem.tax_drift')));
    expect(flags).toHaveLength(0);
    expect(await ctx.db.select().from(alert).where(eq(alert.key, `bookings.tax_drift:${made.id}`))).toHaveLength(0);
  });
});

describe('SCRUM-1013 — an older booking that stored no rule', () => {
  it('is refused as today when the tax changed, and nothing is written', async () => {
    const made = await bookAndPay();
    // A booking made before this change: its snapshot carries no rule.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, made.id));
    const { taxConfig: _dropped, ...older } = row!.pricingSnapshot as Record<string, unknown>;
    await ctx.db.update(booking).set({ pricingSnapshot: older }).where(eq(booking.id, made.id));

    await withRule(EXCLUSIVE_WITH_SERVICE, async () => {
      const res = await redeem(made.id);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('BOOKING_TOTAL_DRIFT');
      expect(await salesOf(made.id)).toHaveLength(0);
      const [still] = await ctx.db.select().from(booking).where(eq(booking.id, made.id));
      expect(still!.status).toBe('paid');
    });
  });
});
