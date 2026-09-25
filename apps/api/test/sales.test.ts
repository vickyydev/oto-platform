import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  account,
  auditLog,
  branch,
  branchHoliday,
  branchTaxConfig,
  member,
  paymentAttempt,
  product,
  receiptSeries,
  role,
  roleAssignment,
  sale,
  saleDiscount,
  saleLine,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
  voucherRedemption,
} from '@oto/db';
import {
  businessDate,
  mintBoothCode,
  newId,
  normalizePhone,
  parseDayStart,
  PRICING_ENGINE_VERSION,
} from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-09a (SCRUM-203) — the till's money path, driven through the REAL routes
 * with a REAL reception session, asserting the rows that land in Postgres.
 *
 * WHY IT IS WRITTEN THAT WAY. Five tickets on this project shipped a service
 * with no caller and tests that mirrored one side of the seam, so nothing
 * failed when the two halves did not meet. Every case below goes in through
 * `app.inject` on the route the till will call, and then reads the database
 * rather than the response. The one thing these cannot prove is that the TILL
 * calls them: `apps/pos` has no test runner at all. The last test in this file
 * is that tripwire, and it says what to do the day it turns red.
 *
 * THE FIXTURES are the seeded catalogue, so the numbers are the park's:
 *   2 Hours Play  tourist ฿890 flat · expat ฿623 weekday / ฿712 weekend
 *                 (expat derives −30 % weekday, −20 % weekend)
 *   adults        a set price of ฿350 weekday / ฿500 weekend on every tier
 *   Full Day Pass thai ฿620 weekday, and ONE FREE ADULT per line with the
 *                 overflow at the ฿350 admission
 *   VAT           7 %, inclusive, on every category; no service charge
 * James (+66822222222) is the seeded expat; Mali (+66811111111) is thai.
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let timezone: string;
let dayStart: string;
let stationId: string;
let twoHoursId: string;
let fullDayId: string;
let jamesId: string;
let maliId: string;

/** Satang from baht, so the fixtures read like the price list. */
const b = (baht: number): number => Math.round(baht * 100);

/** Today at the branch, on the branch's own day boundary. */
const today = (): string => businessDate(new Date(), timezone, parseDayStart(dayStart));

interface CartLine {
  id: string;
  packageId: string;
  kids: number;
  adults: number;
  socks?: number;
}

const line = (packageId: string, kids: number, adults: number): CartLine => ({
  id: newId(),
  packageId,
  kids,
  adults,
});

async function quote(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie }, payload });
}

async function commit(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie, ...headers },
    payload: { stationId, ...payload },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  timezone = hkt.timezone;
  dayStart = hkt.businessDayStart;

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  fullDayId = packages.find((p) => p.name === 'Full Day Pass')!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;
  maliId = members.find((m) => m.phone === '+66811111111')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the quote prices from the platform engine, not from the till', () => {
  it("prices James's cart at his tier, on the branch's own trading day", async () => {
    const res = await quote({ memberId: jamesId, lines: [line(twoHoursId, 2, 3)] });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The tier came from the member record, and the body never mentioned one.
    expect(body.tier).toBe('expat');
    expect(body.tierSource).toBe('member');
    expect(body.businessDate).toBe(today());
    expect(body.engineVersion).toBe(PRICING_ENGINE_VERSION);

    const weekend = body.pricingMode === 'weekend';
    // 2 kids at the expat rate + 3 adults at the flat admission.
    const expected = weekend ? 2 * b(712) + 3 * b(500) : 2 * b(623) + 3 * b(350);
    expect(body.totals.subtotalSatang).toBe(expected);
    expect(body.totals.grossSatang).toBe(expected);

    // VAT 7 % INSIDE the price: the guest pays the same, and the tax is
    // reported rather than added.
    expect(body.totals.taxInclusiveSatang).toBe(Math.round((expected * 7) / 107));
    expect(body.totals.taxExclusiveSatang).toBe(0);
    expect(body.totals.netSatang).toBe(expected - body.totals.taxInclusiveSatang);
    expect(
      body.totals.netSatang +
        body.totals.serviceChargeSatang +
        body.totals.taxInclusiveSatang +
        body.totals.taxExclusiveSatang,
    ).toBe(body.totals.grossSatang);
  });

  it('prices a walk-in at the default tier rather than refusing to price it', async () => {
    const res = await quote({ lines: [line(twoHoursId, 2, 3)] });
    const body = res.json();
    expect(body.tier).toBe('tourist');
    expect(body.tierSource).toBe('default');
    const weekend = body.pricingMode === 'weekend';
    expect(body.totals.grossSatang).toBe(2 * b(890) + 3 * (weekend ? b(500) : b(350)));
  });

  it('ignores a tier, a price or a total sent in the body', async () => {
    // The tier is the thing a visitor would most like to change, and a
    // client-set price is a discount anybody can give themselves. Both are
    // sent here and neither may reach the arithmetic.
    const res = await quote({
      memberId: jamesId,
      tier: 'thai',
      customerTier: 'thai',
      lines: [{ ...line(twoHoursId, 2, 3), unitSatang: 1, lineTotal: 1 }],
      totals: { grossSatang: 1 },
    });
    const body = res.json();
    expect(body.tier).toBe('expat');
    const weekend = body.pricingMode === 'weekend';
    expect(body.totals.grossSatang).toBe(
      weekend ? 2 * b(712) + 3 * b(500) : 2 * b(623) + 3 * b(350),
    );
  });

  it('charges weekend prices inside a holiday range, and names the range', async () => {
    const date = today();
    const holidayId = newId();
    await ctx.db
      .insert(branchHoliday)
      .values({ id: holidayId, branchId, name: 'Test Holiday', startsOn: date, endsOn: date });
    try {
      const res = await quote({ memberId: jamesId, lines: [line(twoHoursId, 2, 3)] });
      const body = res.json();
      expect(body.pricingMode).toBe('weekend');
      expect(body.pricingModeReason).toBe('Weekend pricing — Test Holiday');
      expect(body.holidayName).toBe('Test Holiday');
      expect(body.totals.grossSatang).toBe(2 * b(712) + 3 * b(500));
    } finally {
      await ctx.db.delete(branchHoliday).where(eq(branchHoliday.id, holidayId));
    }
  });

  it('gives the free adult away per line and shows the row at ฿0', async () => {
    // Full Day Pass, thai tier: one free adult per line, overflow at ฿350.
    const res = await quote({ memberId: maliId, lines: [line(fullDayId, 2, 3)] });
    const body = res.json();
    expect(body.tier).toBe('thai');
    const weekend = body.pricingMode === 'weekend';
    const kid = weekend ? b(720) : b(620);
    const adult = weekend ? b(500) : b(350);
    expect(body.totals.grossSatang).toBe(2 * kid + 2 * adult);

    const kinds = (body.lines as { kind: string; quantity: number; grossSatang: number }[]);
    const free = kinds.find((l) => l.kind === 'adults_free')!;
    expect(free.quantity).toBe(1);
    expect(free.grossSatang).toBe(0);
    expect(kinds.find((l) => l.kind === 'adults_paid')!.quantity).toBe(2);
  });

  it('refuses a package this branch does not sell', async () => {
    const res = await quote({ memberId: jamesId, lines: [line(newId(), 1, 0)] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no longer available/i);
  });
});

describe('committing a sale writes the ledger', () => {
  it('writes the sale, its lines and an audit row in one go', async () => {
    const cartLine = line(twoHoursId, 2, 3);
    const saleId = newId();
    const res = await commit({ id: saleId, memberId: jamesId, lines: [cartLine] });
    expect(res.statusCode).toBe(200);

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row).toBeDefined();
    expect(row!.branchId).toBe(branchId);
    expect(row!.stationId).toBe(stationId);
    expect(row!.customerTier).toBe('expat');
    expect(row!.businessDate).toBe(today());
    // The branch's day boundary and zone are frozen onto the row, so a branch
    // that later moves its day start cannot re-answer which day this was.
    expect(row!.businessDayStart).toBe(dayStart);
    expect(row!.timezone).toBe(timezone);
    expect(row!.engineVersion).toBe(PRICING_ENGINE_VERSION);
    expect(row!.origin).toBe('cloud');
    expect(row!.status).toBe('tendering'); // tenders are S2-10a
    expect(row!.receiptNumber).toBeNull();

    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    // One row per UNIT: the kids row and the paid-adults row.
    expect(lines.map((l) => l.kind).sort()).toEqual(['adults_paid', 'kids']);
    expect(lines.every((l) => l.cartLineId === cartLine.id)).toBe(true);
    expect(lines.every((l) => l.customerTier === 'expat')).toBe(true);
    expect(lines.every((l) => l.taxableCategory === 'tickets')).toBe(true);
    expect(lines.every((l) => l.stayDurationLabel === '2 Hours' && l.stayHours === 2)).toBe(true);
    expect(lines.every((l) => l.kidCount === 2 && l.adultCount === 3)).toBe(true);

    // The parts add up to the whole, which is the property that makes a
    // line-level report and the sale agree.
    const sum = (pick: (l: (typeof lines)[number]) => number): number =>
      lines.reduce((total, l) => total + pick(l), 0);
    expect(sum((l) => l.baseSatang)).toBe(row!.subtotalSatang);
    expect(sum((l) => l.grossSatang)).toBe(row!.grossSatang);
    expect(sum((l) => l.netSatang)).toBe(row!.netSatang);
    expect(sum((l) => l.taxSatang)).toBe(row!.taxInclusiveSatang + row!.taxExclusiveSatang);
    expect(sum((l) => l.serviceChargeSatang)).toBe(row!.serviceChargeSatang);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.create')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.branchId).toBe(branchId);
  });

  it('answers a retry of the same sale id with the sale that exists', async () => {
    const saleId = newId();
    const payload = { id: saleId, memberId: jamesId, lines: [line(twoHoursId, 1, 1)] };
    const first = await commit(payload);
    expect(first.statusCode).toBe(200);
    const second = await commit({ ...payload, lines: [line(twoHoursId, 9, 9)] });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(second.json().sale.totals.grossSatang).toBe(first.json().sale.totals.grossSatang);

    const rows = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a retry that minted a new id under the same action', async () => {
    // Pressing Pay twice through a dropped connection must not become two
    // sales just because the client minted a fresh id for the second attempt.
    const actionId = newId();
    const first = await commit(
      { id: newId(), memberId: jamesId, lines: [line(twoHoursId, 1, 0)] },
      { 'x-oto-action-id': actionId },
    );
    expect(first.statusCode).toBe(200);
    const second = await commit(
      { id: newId(), memberId: jamesId, lines: [line(twoHoursId, 1, 0)] },
      { 'x-oto-action-id': actionId },
    );
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('SALE_ACTION_REPLAY');

    const rows = await ctx.db
      .select()
      .from(sale)
      .where(and(eq(sale.stationId, stationId), eq(sale.actionId, actionId)));
    expect(rows).toHaveLength(1);
  });

  it('refuses a sale whose total the till disagrees with, and writes nothing', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      memberId: jamesId,
      lines: [line(twoHoursId, 2, 3)],
      expectedTotalSatang: 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SALE_TOTAL_MISMATCH');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
  });

  it('accepts the sale when the till and the platform agree', async () => {
    const cart = { memberId: jamesId, lines: [line(twoHoursId, 2, 3)] };
    const quoted = await quote(cart);
    const saleId = newId();
    const res = await commit({
      ...cart,
      id: saleId,
      expectedTotalSatang: quoted.json().totals.grossSatang,
    });
    expect(res.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.grossSatang).toBe(quoted.json().totals.grossSatang);
  });
});

describe('a ฿0 comp finalises like any other sale', () => {
  it('records the comp, its reason and a receipt number', async () => {
    const cartLine = line(twoHoursId, 2, 3);
    const saleId = newId();
    const res = await commit({
      id: saleId,
      memberId: jamesId,
      lines: [cartLine],
      manualDiscounts: [
        {
          id: newId(),
          scope: 'order',
          type: 'comp',
          value: 0,
          reason: 'Manager comp',
          note: 'Party went wrong',
        },
      ],
      finalise: true,
    });
    expect(res.statusCode).toBe(200);

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('finalised');
    expect(row!.grossSatang).toBe(0);
    // The comp is visible as a discount, not as a cart that was never rung up:
    // the subtotal still says what the visit was worth.
    expect(row!.subtotalSatang).toBeGreaterThan(0);
    expect(row!.manualDiscountSatang).toBe(row!.subtotalSatang);
    expect(row!.finalisedAt).not.toBeNull();
    expect(row!.receiptNumber).toMatch(/^T1-\d{6}$/);
    expect(row!.receiptSeries).toBe('T1');

    const [discount] = await ctx.db
      .select()
      .from(saleDiscount)
      .where(eq(saleDiscount.saleId, saleId));
    expect(discount!.kind).toBe('manual');
    expect(discount!.discountType).toBe('comp');
    expect(discount!.reason).toBe('Manager comp');
    expect(discount!.appliedByAccountId).not.toBeNull();
    expect(discount!.amountSatang).toBe(row!.subtotalSatang);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.finalise')));
    expect(audits).toHaveLength(1);
  });

  it('numbers receipts consecutively within the station series', async () => {
    const comp = (): Record<string, unknown> => ({
      id: newId(),
      lines: [line(twoHoursId, 1, 0)],
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Staff / family' }],
      finalise: true,
    });
    const first = await commit(comp());
    const second = await commit(comp());
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a = Number(first.json().sale.receiptSeq);
    const c = Number(second.json().sale.receiptSeq);
    expect(c).toBe(a + 1);

    const [series] = await ctx.db
      .select()
      .from(receiptSeries)
      .where(and(eq(receiptSeries.stationId, stationId), eq(receiptSeries.series, 'T1')));
    // The cloud's high-water mark is past everything it has issued.
    expect(series!.nextSeq).toBe(c + 1);
  });

  it('finalises a committed ฿0 sale, and a second finalise takes no second number', async () => {
    const saleId = newId();
    await commit({
      id: saleId,
      lines: [line(twoHoursId, 1, 0)],
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Service recovery' }],
    });
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const number = first.json().sale.receiptNumber as string;
    expect(number).toMatch(/^T1-\d{6}$/);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(second.json().sale.receiptNumber).toBe(number);
  });
});

/**
 * THE SEAM S2-10a BUILDS ON, and the defect that made this ticket undeployable.
 *
 * The till sent `finalise: true` on every commit and the platform refused to
 * finalise anything that still owed money, so a ฿1,440 admission — the park's
 * ordinary sale — came back 409 with no row written, and only a ฿0 comp could
 * be recorded at all. The decision: Pay COMMITS the sale unfinalised and
 * unnumbered; the tender that completes FINALISES it, in the transaction the
 * payment attempt reaches `approved`. Today that tender is the prototype's
 * "Confirm Payment Received"; S2-10a hangs the EDC and the QR on the same call.
 */
describe('pay commits the sale, the tender finalises it', () => {
  const paidCart = (saleId: string): Record<string, unknown> => ({
    id: saleId,
    memberId: jamesId,
    lines: [line(twoHoursId, 1, 1)],
    // Verbatim what the till has been sending. It must not lose the sale.
    finalise: true,
  });

  async function finalise(saleId: string, payload?: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
      ...(payload ? { payload } : {}),
    });
  }

  it('writes a paid cart as an open sale with no receipt number, and says what it owes', async () => {
    const saleId = newId();
    const res = await commit(paidCart(saleId));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.finalised).toBe(false);
    expect(body.outstandingSatang).toBe(body.sale.totals.grossSatang);
    expect(body.outstandingSatang).toBeGreaterThan(0);

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('tendering');
    // The document number is spent when the money is taken, not before.
    expect(row!.receiptNumber).toBeNull();
    expect(row!.finalisedAt).toBeNull();
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(0);
  });

  it('takes the cash at Confirm Payment Received, records it and numbers the receipt', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;

    const res = await finalise(saleId, { method: 'cash', tenderedSatang: owed + b(60) });
    expect(res.statusCode).toBe(200);
    expect(res.json().sale.receiptNumber).toMatch(/^T1-\d{6}$/);

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('finalised');
    expect(row!.finalisedAt).not.toBeNull();
    expect(row!.receiptNumber).toMatch(/^T1-\d{6}$/);

    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.method).toBe('cash');
    expect(attempts[0]!.status).toBe('approved');
    expect(attempts[0]!.amountSatang).toBe(owed);
    // S2-10a — what was handed over and what went back are COLUMNS, because
    // the cash-up adds them up. They were in the payload until this ticket.
    expect(attempts[0]!.tenderedSatang).toBe(owed + b(60));
    expect(attempts[0]!.changeSatang).toBe(b(60));
    // And the money has a time of its own, which the end of day groups by.
    expect(attempts[0]!.paidAt).not.toBeNull();

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.finalise')));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.after as { tender: { method: string; amountSatang: number } }).tender).toMatchObject({
      method: 'cash',
      amountSatang: owed,
    });
  });

  it('settles the balance in cash when the button is all that was pressed', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;

    const res = await finalise(saleId);
    expect(res.statusCode).toBe(200);
    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempt!.method).toBe('cash');
    expect(attempt!.amountSatang).toBe(owed);
    // Nothing was typed, so nothing is claimed about what was handed over.
    expect(attempt!.tenderedSatang).toBeNull();
    expect(attempt!.changeSatang).toBeNull();
  });

  /**
   * REWRITTEN BY S2-10a (decision O-5), and the meaning of the case is the
   * thing that changed rather than the assertion.
   *
   * It read "refuses a part payment, and leaves neither a number nor a tender
   * behind": the refusal rolled the attempt back with it, on the ground that a
   * sale which is not closed must not carry money the day's reconciliation
   * would count. That made a split tender impossible and an asynchronous QR
   * impossible with it — both need an approved attempt on an open sale — so
   * the rule is now the other way round and the reconciliation is where the
   * open balance shows. What has NOT changed, and is asserted here as firmly
   * as it was: no receipt number is spent on a sale that still owes money.
   */
  it('records a part payment, leaves the sale open, and spends no receipt number', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;
    const half = Math.floor(owed / 2);

    const res = await finalise(saleId, { method: 'cash', amountSatang: half });
    expect(res.statusCode).toBe(200);
    expect(res.json().finalised).toBe(false);
    expect(res.json().outstandingSatang).toBe(owed - half);
    expect(res.json().sale.receiptNumber).toBeNull();

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('tendering');
    expect(row!.receiptNumber).toBeNull();

    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('approved');
    expect(attempts[0]!.amountSatang).toBe(half);
  });

  it('refuses cash short of the amount being settled rather than giving negative change', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;

    const res = await finalise(saleId, { method: 'cash', tenderedSatang: owed - b(1) });
    expect(res.statusCode).toBe(400);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('tendering');
  });

  it('answers a second Confirm with the same receipt, and takes no second tender', async () => {
    const saleId = newId();
    await commit(paidCart(saleId));
    const first = await finalise(saleId, { method: 'cash' });
    expect(first.statusCode).toBe(200);
    const number = first.json().sale.receiptNumber as string;

    const second = await finalise(saleId, { method: 'cash' });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(second.json().sale.receiptNumber).toBe(number);
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
  });

  it('takes the till’s own finalise body, which rides nested and flat at once', async () => {
    // Verbatim from `apps/pos/src/api/sales.ts`: `{ ...tender, actionId, tender }`,
    // carrying the tender token, the kind, and the change the till showed.
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;
    const tender = {
      method: 'cash',
      kind: 'cash',
      amountSatang: owed,
      tenderedSatang: owed,
      changeSatang: 0,
    };
    const res = await finalise(saleId, { ...tender, actionId: newId(), tender });
    expect(res.statusCode).toBe(200);
    expect(res.json().sale.receiptNumber).toMatch(/^T1-\d{6}$/);

    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempt!.method).toBe('cash');
    expect(attempt!.amountSatang).toBe(owed);
    expect(attempt!.tenderedSatang).toBe(owed);
    expect(attempt!.changeSatang).toBe(0);
    // The till's own classification of its token still rides the payload.
    expect(attempt!.payload).toMatchObject({ kind: 'cash' });
    // The till and the platform agree on the change, so there is nothing to keep.
    expect(attempt!.payload).not.toHaveProperty('tillChangeSatang');
  });

  it('keeps the till’s change figure when it disagrees with the platform’s', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;
    const res = await finalise(saleId, {
      method: 'cash',
      tenderedSatang: owed + b(100),
      changeSatang: 0,
    });
    expect(res.statusCode).toBe(200);
    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    // ฿100 went back in the guest's hand whatever the screen said it did — and
    // the disagreement is kept beside it as evidence, not as a second figure.
    expect(attempt!.changeSatang).toBe(b(100));
    expect(attempt!.payload).toMatchObject({ tillChangeSatang: 0 });
  });

  it('takes the tender nested under `tender`, as the till may send it', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;
    const res = await finalise(saleId, { tender: { method: 'cash', tenderedSatang: owed } });
    expect(res.statusCode).toBe(200);
    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempt!.amountSatang).toBe(owed);
    expect(attempt!.changeSatang).toBe(0);
  });

  /**
   * S2-10a — TWO TENDERS ON ONE SALE, which is the point of letting a sale sit
   * part-paid at all. The second one closes it and takes the number.
   */
  it('closes the sale when a second tender covers the balance', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;
    const half = Math.floor(owed / 2);

    const first = await finalise(saleId, { method: 'cash', amountSatang: half });
    expect(first.statusCode).toBe(200);
    expect(first.json().finalised).toBe(false);

    const second = await finalise(saleId, { method: 'cash', amountSatang: owed - half });
    expect(second.statusCode).toBe(200);
    expect(second.json().finalised).toBe(true);
    expect(second.json().outstandingSatang).toBe(0);
    expect(second.json().sale.receiptNumber).toMatch(/^T1-\d{6}$/);

    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toHaveLength(2);
    expect(attempts.reduce((sum, a) => sum + a.amountSatang, 0)).toBe(owed);
    expect(attempts.every((a) => a.status === 'approved')).toBe(true);
  });

  /** A third tender on a settled sale has nothing to settle, and is refused. */
  it('refuses a tender over the balance and writes no attempt for it', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;

    const res = await finalise(saleId, { method: 'cash', amountSatang: owed + 1 });
    expect(res.statusCode).toBe(400);
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(0);

    // And once it IS settled, another tender finds the sale closed rather than
    // opening an attempt against it.
    expect((await finalise(saleId, { method: 'cash' })).statusCode).toBe(200);
    const third = await finalise(saleId, { method: 'cash', amountSatang: 100 });
    expect(third.statusCode).toBe(200);
    expect(third.headers['x-oto-replay']).toBe('true');
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
  });

  /**
   * THE REPLAY NET ON THE PRESS, not on the sale's status: a part payment
   * leaves the sale open, so `status = 'finalised'` no longer catches the
   * retry of a press that took money. `x-oto-action-id` does.
   */
  it('answers a replayed part payment with the attempt it already wrote', async () => {
    const saleId = newId();
    const committed = await commit(paidCart(saleId));
    const owed = committed.json().outstandingSatang as number;
    const actionId = newId();
    const tender = { method: 'cash', amountSatang: Math.floor(owed / 2), actionId };

    const first = await finalise(saleId, tender);
    expect(first.statusCode).toBe(200);
    const second = await finalise(saleId, tender);
    expect(second.statusCode).toBe(200);

    // The same answer, and the one attempt it describes.
    expect(second.json().attempt.id).toBe(first.json().attempt.id);
    expect(second.json().outstandingSatang).toBe(first.json().outstandingSatang);
    expect(second.json().sale.receiptNumber).toBeNull();
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
  });
});

/**
 * THE SCOPE HOLE THE INTEGRATION RUN FOUND: reception is assigned `reception`
 * scoped to HKT Central and nothing else, yet a cart naming another branch was
 * quoted, committed and written there — because the routes declared their
 * permission with no target, and `requirePermission` falls back to the
 * SESSION's branch when the target is empty. The proof it was wrong was that
 * reading the sale back afterwards returned 403 to the account that had just
 * written it.
 */
describe('a branch-scoped account cannot sell at another branch', () => {
  let otherBranchId: string;
  let otherStationId: string;
  let otherPackageId: string;
  let adminCookie: string;

  beforeAll(async () => {
    otherBranchId = newId();
    await ctx.db.insert(branch).values({
      id: otherBranchId,
      operatorId,
      name: 'HKT Lagoon',
      code: 'hkt-lagoon',
      timezone,
      businessDayStart: dayStart,
    });
    otherStationId = newId();
    await ctx.db.insert(station).values({
      id: otherStationId,
      operatorId,
      branchId: otherBranchId,
      name: 'Lagoon Till 1',
      kind: 'till',
      codePrefix: 'L1',
    });
    // The second branch has to be able to price a cart, or a refusal could be
    // "this branch sells nothing" rather than "you may not sell here".
    const [cfg] = await ctx.db
      .select()
      .from(branchTaxConfig)
      .where(eq(branchTaxConfig.branchId, branchId));
    await ctx.db
      .insert(branchTaxConfig)
      .values({ id: newId(), branchId: otherBranchId, config: cfg!.config });
    const [pkg] = await ctx.db
      .select()
      .from(ticketPackage)
      .where(eq(ticketPackage.id, twoHoursId));
    otherPackageId = newId();
    await ctx.db
      .insert(ticketPackage)
      .values({ ...pkg!, id: otherPackageId, branchId: otherBranchId });
    adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  });

  it('refuses to price a cart for a branch the account is not scoped to', async () => {
    const res = await quote({
      branchId: otherBranchId,
      memberId: jamesId,
      lines: [line(otherPackageId, 1, 1)],
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses the sale, and writes nothing, when the cart names the other branch', async () => {
    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: saleId,
        branchId: otherBranchId,
        stationId: otherStationId,
        lines: [line(otherPackageId, 1, 1)],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
  });

  it('refuses it when only the STATION gives the other branch away', async () => {
    // Nothing in this body names a branch, so a route guard reading the
    // request cannot see one: the branch arrives with the station, and the
    // check has to happen where that is resolved.
    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: { id: saleId, stationId: otherStationId, lines: [line(otherPackageId, 1, 1)] },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
  });

  it('refuses to finalise a sale belonging to the other branch', async () => {
    // Written by an operator-wide administrator, which is who may sell at
    // either branch — the same call that reception is refused.
    const saleId = newId();
    const written = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: adminCookie },
      payload: {
        id: saleId,
        branchId: otherBranchId,
        stationId: otherStationId,
        lines: [line(otherPackageId, 1, 0)],
      },
    });
    expect(written.statusCode).toBe(200);
    expect(written.json().sale.branchId).toBe(otherBranchId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
      payload: { method: 'cash' },
    });
    expect(res.statusCode).toBe(403);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('tendering');
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(0);
  });

  it('still sells at the branch the account IS scoped to', async () => {
    const res = await quote({ memberId: jamesId, lines: [line(twoHoursId, 1, 1)] });
    expect(res.statusCode).toBe(200);
    expect(res.json().branchId).toBe(branchId);
  });
});

describe('a manual discount', () => {
  it('comes off before tax and is recorded with who gave it and why', async () => {
    const saleId = newId();
    const cartLine = line(twoHoursId, 2, 3);
    const res = await commit({
      id: saleId,
      memberId: jamesId,
      lines: [cartLine],
      manualDiscounts: [
        { id: newId(), scope: 'order', type: 'fixed', value: b(100), reason: 'Loyalty' },
      ],
    });
    expect(res.statusCode).toBe(200);

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.manualDiscountSatang).toBe(b(100));
    expect(row!.discountSatang).toBe(b(100));
    expect(row!.grossSatang).toBe(row!.subtotalSatang - b(100));
    // Inclusive VAT is recomputed on what is left, not carried over from the
    // undiscounted bill.
    expect(row!.taxInclusiveSatang).toBe(Math.round((row!.grossSatang * 7) / 107));

    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const discounted = lines.reduce((total, l) => total + l.discountSatang, 0);
    expect(discounted).toBe(b(100));
  });

  it('is refused to an account that may sell but not discount', async () => {
    // `staff` is the read-mostly bundle: it holds no pos:sale:create either,
    // so this proves the guard on the route AND the separate discount check
    // are both reachable by a real session.
    const [staffRole] = await ctx.db.select().from(role).where(eq(role.name, 'staff')).limit(1);
    const staffId = newId();
    await ctx.db.insert(account).values({
      id: staffId,
      operatorId,
      phone: normalizePhone('+66900000077')!,
      passwordHash: await hash('floorstaff1234'),
      phoneVerifiedAt: new Date(),
      status: 'active',
    });
    await ctx.db.insert(roleAssignment).values({
      id: newId(),
      accountId: staffId,
      roleId: staffRole!.id,
      scopeType: 'branch',
      scopeId: branchId,
    });
    const staffCookie = await signInAs(ctx.app, '+66900000077', 'floorstaff1234');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: staffCookie },
      payload: { stationId, lines: [line(twoHoursId, 1, 0)] },
    });
    expect(res.statusCode).toBe(403);

    // The same account may read the day's sales, which is what `staff` is for.
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/sales?limit=5',
      headers: { cookie: staffCookie },
    });
    expect(read.statusCode).toBe(200);
  });
});

describe('reading a sale back', () => {
  it('shows the lines a receipt and a report are rebuilt from', async () => {
    const saleId = newId();
    await commit({ id: saleId, memberId: maliId, lines: [line(fullDayId, 2, 3)] });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/sales/${saleId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sale.id).toBe(saleId);
    expect(body.sale.customerTier).toBe('thai');
    expect(body.taxBreakdown.categories.length).toBeGreaterThan(0);
    const lines = body.lines as {
      kind: string;
      kidCount: number;
      adultCount: number;
      freeAdultCount: number;
      stayDurationLabel: string;
      customerTier: string;
      revenueCategory: string | null;
      taxableCategory: string;
    }[];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // The detail view's grouping: every line says which revenue it was.
    expect(lines.every((l) => l.revenueCategory === 'tickets')).toBe(true);
    expect(lines.every((l) => l.customerTier === 'thai')).toBe(true);
    expect(lines.every((l) => l.kidCount === 2 && l.adultCount === 3)).toBe(true);
    expect(lines.every((l) => l.stayDurationLabel === 'All Day')).toBe(true);
    expect(lines.find((l) => l.kind === 'adults_free')!.freeAdultCount).toBe(1);
  });

  /**
   * S2-10a — the detail read answers HOW the money was taken, which is what
   * `SaleDetail.tsx` says on the screen. Before this ticket it answered the
   * sale, its lines and its discounts and nothing at all about the tender.
   */
  it('answers the sale’s tenders, in the order they were taken', async () => {
    const saleId = newId();
    const committed = await commit({
      id: saleId,
      memberId: jamesId,
      lines: [line(twoHoursId, 1, 1)],
      finalise: true,
    });
    const owed = committed.json().outstandingSatang as number;
    const half = Math.floor(owed / 2);
    await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
      payload: { method: 'cash', amountSatang: half },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
      payload: { method: 'card', kind: 'card', amountSatang: owed - half },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/sales/${saleId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const attempts = res.json().attempts as {
      method: string;
      status: string;
      amountSatang: number;
      paidAt: string | null;
    }[];
    expect(attempts.map((a) => a.method)).toEqual(['cash', 'card']);
    expect(attempts.every((a) => a.status === 'approved' && a.paidAt !== null)).toBe(true);
    expect(attempts.reduce((sum, a) => sum + a.amountSatang, 0)).toBe(owed);
  });

  it('lists the day’s sales for the branch', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/sales?from=${today()}&to=${today()}&limit=100`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const sales = res.json().sales as { branchId: string; businessDate: string }[];
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.every((s) => s.branchId === branchId && s.businessDate === today())).toBe(true);
  });

  /**
   * SCRUM-238 — the list answers in NAMES, not only in ids.
   *
   * History's card shows a receipt number, a time, who rang it up, which
   * counter, the guest and what kind of sale it was. Every one of those has to
   * come out of this one call: the page that could not get them is the page
   * that showed eight invented transactions instead.
   */
  it('carries every field the History card reads', async () => {
    const saleId = newId();
    const committed = await commit({ id: saleId, memberId: jamesId, lines: [line(twoHoursId, 1, 1)] });
    expect(committed.statusCode).toBe(200);
    await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
      payload: { method: 'cash' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/sales?businessDate=${today()}&limit=200`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const row = (
      res.json().sales as {
        id: string;
        occurredAt: string;
        status: string;
        receiptNumber: string | null;
        customerTier: string;
        stationName: string | null;
        soldBy: { accountId: string; name: string | null } | null;
        member: { id: string; nickname: string; phone: string } | null;
        lineKinds: string[];
        revenueCategories: string[];
        totals: { grossSatang: number; refundedSatang: number };
      }[]
    ).find((s) => s.id === saleId)!;

    // The visible id on the card, and never the uuid.
    expect(row.receiptNumber).toMatch(/^T1-\d+$/);
    expect(row.status).toBe('finalised');
    expect(Date.parse(row.occurredAt)).not.toBeNaN();
    expect(row.totals.grossSatang).toBeGreaterThan(0);
    expect(row.totals.refundedSatang).toBe(0);
    // Who sold it and where — the card's operator line.
    expect(row.soldBy?.name).toBeTruthy();
    expect(row.stationName).toBeTruthy();
    // The guest, for the card's label and the page's search by phone.
    expect(row.member?.id).toBe(jamesId);
    expect(row.member?.phone).toBe('+66822222222');
    expect(row.member?.nickname).toBeTruthy();
    expect(row.customerTier).toBe('expat');
    // What it was made of: the card's icon and the Tickets / F&B tabs.
    expect(row.lineKinds).toContain('kids');
    expect(row.revenueCategories).toContain('tickets');
  });

  it('names no member on a walk-in rather than inventing one', async () => {
    const saleId = newId();
    await commit({ id: saleId, lines: [line(twoHoursId, 1, 0)] });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/sales?businessDate=${today()}&limit=200`,
      headers: { cookie },
    });
    const row = (res.json().sales as { id: string; member: unknown }[]).find((s) => s.id === saleId)!;
    expect(row.member).toBeNull();
  });

  /**
   * SCRUM-430 — a voided sale says WHY when it is READ, not only in the void's
   * own answer. History shows "Voided … — <reason>" off the read, and a sale
   * voided at the till — the payment screen's Cancel, a voucher refusal's
   * offer — has no void answer on the History page to take the reason from,
   * so before this it showed "Voided" and nothing else. And it says by WHOM
   * by name: the page shows "by Som", and had only the account id to show it
   * with.
   */
  it('carries the void — when, by whom and why — on the detail and on the list', async () => {
    const saleId = newId();
    const committed = await commit({ id: saleId, memberId: jamesId, lines: [line(twoHoursId, 1, 1)] });
    expect(committed.statusCode, committed.body).toBe(200);
    const voided = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/void`,
      headers: { cookie },
      payload: { reason: 'Guest walked away before paying' },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    // By the account that is signed in, not whatever the void's answer echoed.
    const [reception] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(
        and(eq(account.operatorId, operatorId), eq(account.phone, normalizePhone(RECEPTION.phone)!)),
      );
    const recorded = {
      status: 'voided',
      voidedAt: voided.json().void.voidedAt as string,
      voidedByAccountId: reception!.id,
      // The seeded reception person, named the way a list row names its seller.
      voidedByName: 'Som (Reception)',
      voidReason: 'Guest walked away before paying',
    };
    expect(Date.parse(recorded.voidedAt)).not.toBeNaN();

    const detail = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().sale).toMatchObject(recorded);

    // The History drawer opens a sale out of the LIST row, so the list says it too.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/sales?businessDate=${today()}&status=voided&limit=200`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const row = (list.json().sales as { id: string }[]).find((s) => s.id === saleId);
    expect(row).toMatchObject(recorded);
  });

  it('answers null for all four on a sale that was never voided', async () => {
    const saleId = newId();
    const committed = await commit({ id: saleId, lines: [line(twoHoursId, 1, 0)] });
    expect(committed.statusCode, committed.body).toBe(200);
    // Present and null — not missing: `toMatchObject` fails on an absent key.
    const never = { voidedAt: null, voidedByAccountId: null, voidedByName: null, voidReason: null };

    const detail = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().sale).toMatchObject(never);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/sales?businessDate=${today()}&limit=200`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const row = (list.json().sales as { id: string }[]).find((s) => s.id === saleId);
    expect(row).toMatchObject(never);
  });

  it('answers with nothing for a sale belonging to another operator', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/sales/${newId()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('the payload the till actually sends', () => {
  /**
   * `apps/pos/src/api/sales.ts` posts the cart nested under `cart`, with the
   * action id in the body, the tier and rate mode it believed, a socks block,
   * add-ons carrying their own ids and prices, and a `lineTotalSatang` per
   * line. All of it has to validate here, and none of the money in it may
   * decide what the guest is charged.
   */
  const tillCart = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    branchId,
    stationId,
    tier: 'expat',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    socks: { addOnId: 'a-socks', unitSatang: b(50), label: 'Regular Socks' },
    memberId: jamesId,
    customerPhone: '+66822222222',
    customerNickname: 'James',
    lines: [],
    promos: [],
    manualDiscounts: [],
    expectedTotalSatang: 0,
    ...over,
  });

  it('takes the nested cart, the body action id and the till’s clock', async () => {
    const cartLine = { ...line(twoHoursId, 1, 1), packageName: '2 Hours Play', tier: 'expat' };
    const quoted = await quote(tillCart({ lines: [cartLine] }));
    expect(quoted.statusCode).toBe(200);
    // The till's client reads `quote`; a terminal reads the flat copy.
    expect(quoted.json().quote.totals.grossSatang).toBe(quoted.json().totals.grossSatang);

    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: saleId,
        actionId: newId(),
        occurredAt: new Date().toISOString(),
        finalise: false,
        cart: tillCart({
          lines: [{ ...cartLine, lineTotalSatang: quoted.json().quote.lineTotals[cartLine.id] }],
          expectedTotalSatang: quoted.json().quote.totals.grossSatang,
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().replay).toBe(false);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.clockTrust).toBe('trusted');
    expect(row!.actionId).not.toBeNull();
  });

  it('refuses a line the till priced differently, and writes nothing', async () => {
    const cartLine = line(twoHoursId, 1, 1);
    const saleId = newId();
    const res = await commit({
      id: saleId,
      memberId: jamesId,
      lines: [{ ...cartLine, lineTotalSatang: 1 }],
      socks: { addOnId: 'a-socks', unitSatang: b(50), label: 'Regular Socks' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SALE_LINE_PRICE_MISMATCH');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
  });

  it('records a till-priced add-on as one, and a catalogue add-on as the catalogue’s', async () => {
    // `a-locker` is the prototype's id and resolves to no platform product, so
    // the till's price is used — and the row says so. The seeded ice cream is
    // a real `pos.product`, so its price and its F&B tax category are the
    // platform's whatever the till sent.
    const [iceCream] = await ctx.db
      .select()
      .from(product)
      .where(eq(product.name, 'Ice Cream Cone'))
      .limit(1);
    expect(iceCream).toBeDefined();

    const cartLine = line(twoHoursId, 1, 0);
    const saleId = newId();
    const res = await commit({
      id: saleId,
      memberId: jamesId,
      socks: { addOnId: 'a-socks', unitSatang: b(50), label: 'Regular Socks' },
      lines: [
        {
          ...cartLine,
          socks: 1,
          addOns: [
            { id: 'a-locker', name: 'Locker Rental', unitSatang: b(50), quantity: 1 },
            { id: iceCream!.id, name: 'Whatever the till called it', unitSatang: 1, quantity: 1 },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(200);

    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const locker = lines.find((l) => l.componentKey === 'a-locker')!;
    expect(locker.unitSatang).toBe(b(50));
    expect(locker.payload).toEqual({ priceSource: 'till_snapshot' });
    expect(locker.taxableCategory).toBe('addons');

    const socksLine = lines.find((l) => l.kind === 'socks')!;
    expect(socksLine.payload).toEqual({ priceSource: 'till_snapshot' });

    const cataloguePriced = lines.find((l) => l.componentKey === iceCream!.id)!;
    // The platform's price, not the ฿0.01 the till sent, and its own category.
    expect(cataloguePriced.unitSatang).toBe(iceCream!.priceSatang);
    expect(cataloguePriced.label).toBe('Ice Cream Cone');
    expect(cataloguePriced.taxableCategory).toBe('fnb');
    expect(cataloguePriced.payload).toBeNull();
    expect(cataloguePriced.productId).toBe(iceCream!.id);

    // S2-09a's own criterion: the Sale detail view groups by revenue category,
    // so no line may land without one. It is the engine's own category for the
    // unit — the ice cream's money reports as F&B, the locker's as an add-on,
    // the admission's as a ticket — and the day it comes from the catalogue
    // instead (S2-09b) these rows keep the same meaning.
    expect(lines.every((l) => l.revenueCategory !== null)).toBe(true);
    expect(cataloguePriced.revenueCategory).toBe('fnb');
    expect(locker.revenueCategory).toBe('addons');
    expect(socksLine.revenueCategory).toBe('addons');
    expect(lines.find((l) => l.kind === 'kids')!.revenueCategory).toBe('tickets');
  });

  it('calls a wildly wrong till clock skewed rather than trusting it', async () => {
    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: saleId,
        stationId,
        memberId: jamesId,
        lines: [line(twoHoursId, 1, 0)],
        occurredAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.clockTrust).toBe('skewed');
    // The trading day is the platform's, so a wrong clock cannot move a sale
    // onto another day's takings.
    expect(row!.businessDate).toBe(today());
  });
});

describe('discounts in the prototype’s order', () => {
  it('takes the manual discount first and the code against what is left', async () => {
    // Reversing the two moves the bill, so the assertion is on the ORDER and
    // not only on the total: a ฿100 manual then 10 % is not 10 % then ฿100.
    // STAFF10 is the park's own seeded code, 10 % off: since SCRUM-401 a code
    // is priced from its definition, so it has to be one the park set up.
    const cartLine = line(twoHoursId, 2, 3);
    const cart = {
      memberId: jamesId,
      lines: [cartLine],
      manualDiscounts: [
        { id: newId(), scope: 'order', type: 'fixed', value: b(100), reason: 'Loyalty' },
      ],
      promos: [{ code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10 }],
    };
    const quoted = await quote(cart);
    expect(quoted.statusCode, quoted.body).toBe(200);
    const totals = quoted.json().quote.totals;
    const subtotal = totals.subtotalSatang;
    const promoExpected = Math.round(((subtotal - b(100)) * 10) / 100);
    expect(totals.manualDiscountSatang).toBe(b(100));
    expect(totals.promoDiscountSatang).toBe(promoExpected);
    expect(totals.grossSatang).toBe(subtotal - b(100) - promoExpected);

    const saleId = newId();
    const res = await commit({ ...cart, id: saleId });
    expect(res.statusCode).toBe(200);
    const discounts = await ctx.db
      .select()
      .from(saleDiscount)
      .where(eq(saleDiscount.saleId, saleId));
    const manual = discounts.find((d) => d.kind === 'manual')!;
    const promo = discounts.find((d) => d.kind === 'promo')!;
    // The sequence IS the money: a refund has to undo them in this order.
    expect(manual.sequence).toBe(1);
    expect(promo.sequence).toBe(2);
    expect(promo.code).toBe('STAFF10');
    expect(promo.percentBp).toBe(1000);
    expect(promo.amountSatang).toBe(promoExpected);
  });
});

describe('promo codes', () => {
  it('refuses a code by name rather than pricing one the body defined', async () => {
    // A code is never accepted as a DEFINITION from the request: that would be
    // a discount anybody can write. Named alone, or sent with a value the till
    // made up, a code the park has not set up is refused by name and nothing
    // comes off (SCRUM-401 prices every code from `pos.discount_definition`).
    const res = await quote({
      memberId: jamesId,
      lines: [line(twoHoursId, 1, 0)],
      promoCodes: ['KIDS23'],
      promos: [{ code: 'KIDS24', label: '24% off', type: 'percent', value: 24 }],
    });
    const body = res.json();
    expect(body.rejectedPromoCodes).toEqual([
      { code: 'KIDS23', reason: 'Code "KIDS23" was not found.' },
      { code: 'KIDS24', reason: 'Code "KIDS24" was not found.' },
    ]);
    expect(body.appliedPromos).toEqual([]);
    expect(body.totals.promoDiscountSatang).toBe(0);
    expect(body.totals.grossSatang).toBe(body.totals.subtotalSatang);
  });
});

/**
 * S2-10b (SCRUM-207) — A CART OF ONE VOUCHER'S FREE ITEM.
 *
 * A guest who brings only the slip from the wheel — a Kids Pizza, a bracelet
 * workshop — is a cart with no line on it: the till sends none, because the
 * platform puts the free item on the bill from the voucher's definition. The
 * route used to refuse that cart as empty before the service could read the
 * code, so the one voucher that needs no ticket could not be redeemed alone.
 *
 * Such a sale owes ฿0, and the two tills that redeem vouchers no longer close
 * it at Pay: it is rung up like any other sale and closed by the confirm press
 * (`POST /sales/:id/finalise`, which records no tender when nothing is owed),
 * so the payment screen's Cancel can still void it and give the voucher back.
 */
describe('a cart of one voucher’s free item', () => {
  /** Reception, standing at Reception Till 1: the voucher routes act at the session's till. */
  let till: string;
  let pizzaId: string;
  let definitionId: string;

  beforeAll(async () => {
    till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const picked = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/station',
      headers: { cookie: till },
      payload: { stationId },
    });
    expect(picked.statusCode, picked.body).toBe(200);
    const [pizza] = await ctx.db
      .select()
      .from(product)
      .where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-PIZZA')));
    pizzaId = pizza!.id;
    definitionId = newId();
    await ctx.db.insert(voucherDefinition).values({
      id: definitionId,
      operatorId,
      code: `test-free-${definitionId}`,
      nameEn: 'Kids Pizza',
      kind: 'free_item',
      valueType: 'item',
      productId: pizzaId,
    });
  });

  /** A Kids Pizza voucher as the booth sync files one, held for a fresh cart at the till. */
  async function heldPizza(): Promise<{ voucherId: string; code: string; saleId: string }> {
    const voucherId = newId();
    const code = mintBoothCode('B1', (max) => randomInt(max));
    await ctx.db.insert(voucher).values({
      id: voucherId,
      operatorId,
      branchId,
      voucherDefinitionId: definitionId,
      code,
      source: 'booth',
      status: 'issued',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    });
    const saleId = newId();
    const held = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/vouchers`,
      headers: { cookie: till },
      payload: { code },
    });
    expect(held.statusCode, held.body).toBe(200);
    return { voucherId, code, saleId };
  }

  /** The code alone: no ticket line and no item line. */
  const ringUp = (saleId: string, code: string, finalise: boolean) =>
    ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: till },
      payload: { id: saleId, stationId, lines: [], items: [], promoCodes: [code], finalise },
    });

  /** The voucher's ledger, oldest first, as `kind` or `kind/reason`. */
  const ledgerOf = async (voucherId: string): Promise<string[]> =>
    (
      await ctx.db
        .select({ kind: voucherRedemption.kind, reason: voucherRedemption.reason })
        .from(voucherRedemption)
        .where(eq(voucherRedemption.voucherId, voucherId))
        .orderBy(voucherRedemption.createdAt, voucherRedemption.id)
    ).map((r) => (r.reason ? `${r.kind}/${r.reason}` : r.kind));

  it('commits, closes at ฿0 and uses the voucher up; codes that add nothing are still an empty cart', async () => {
    const { voucherId, code, saleId } = await heldPizza();

    const rung = await ringUp(saleId, code, true);
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json().finalised).toBe(true);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row).toMatchObject({ status: 'finalised', grossSatang: 0 });
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'promo_item',
      productId: pizzaId,
      cartLineId: voucherId,
      grossSatang: 0,
    });
    const [used] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(used).toMatchObject({ status: 'redeemed', saleId });

    // A code that puts nothing on the bill is still an empty cart — refused by
    // the service now rather than the route, in the same words.
    const noLine = await commit({ lines: [], items: [], promoCodes: ['KIDS23'] });
    expect(noLine.statusCode).toBe(400);
    expect(noLine.json().error.message).toBe('The cart is empty');
    // And a cart of nothing at all is refused where it always was.
    const nothing = await commit({ lines: [], items: [] });
    expect(nothing.statusCode).toBe(400);
    expect(nothing.json().error.message).toBe('The cart is empty');
  });

  it('rung up at ฿0 without closing, it keeps the voucher until the confirm press closes the sale', async () => {
    const { voucherId, code, saleId } = await heldPizza();

    // Pay: the payment screen opens on a sale the platform holds, unclosed.
    const rung = await ringUp(saleId, code, false);
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json().finalised).toBe(false);
    const [open] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(open).toMatchObject({ status: 'tendering', grossSatang: 0, receiptNumber: null });
    const [kept] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(kept).toMatchObject({ status: 'issued', heldSaleId: saleId, saleId: null });
    expect(await ledgerOf(voucherId)).toEqual(['held', 'applied']);

    // Confirm: the till's tender names ฿0. Nothing is owed, so no payment is
    // recorded; the close numbers the receipt and uses the voucher up.
    const tender = { method: 'cash', kind: 'cash', amountSatang: 0, tenderedSatang: 0, changeSatang: 0 };
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: till },
      payload: { actionId: newId(), ...tender, tender },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [voucherId] });
    const [done] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(done!.status).toBe('finalised');
    expect(done!.receiptNumber).toBeTruthy();
    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toEqual([]);
    const [used] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(used).toMatchObject({ status: 'redeemed', saleId, heldSaleId: null });
    expect(await ledgerOf(voucherId)).toEqual(['held', 'applied', 'consumed']);
  });

  it('rung up at ฿0 without closing, it is voided by the till’s Cancel and the voucher is free again', async () => {
    const { voucherId, code, saleId } = await heldPizza();
    expect((await ringUp(saleId, code, false)).statusCode).toBe(200);

    const voided = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/void`,
      headers: { cookie: till },
      payload: { reason: 'Cancelled at the till' },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().releasedVoucherIds).toEqual([voucherId]);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row).toMatchObject({
      status: 'voided',
      voidReason: 'Cancelled at the till',
      receiptNumber: null,
    });
    const [free] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(free).toMatchObject({ status: 'issued', heldSaleId: null, saleId: null });
    expect(await ledgerOf(voucherId)).toEqual(['held', 'applied', 'released/sale_voided']);

    // Free for the next cart: held again, rung up again, closed at the confirm.
    const nextSale = newId();
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${nextSale}/vouchers`,
      headers: { cookie: till },
      payload: { code },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect((await ringUp(nextSale, code, false)).statusCode).toBe(200);
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${nextSale}/finalise`,
      headers: { cookie: till },
      payload: {},
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const [used] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(used).toMatchObject({ status: 'redeemed', saleId: nextSale });
  });
});

/**
 * C2 of the booth's closing audit — the free item's twin for a hand-over prize.
 * The family brings only the slip; the prize has no product and no price. It
 * is rung up as a ฿0 sale with no line at all, and the sale closing is what
 * uses the voucher up, exactly as it is for the free item on its own above.
 */
describe('a cart of one hand-over prize', () => {
  /** Reception, standing at Reception Till 1: the voucher routes act at the session's till. */
  let till: string;
  let definitionId: string;

  beforeAll(async () => {
    till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const picked = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/station',
      headers: { cookie: till },
      payload: { stationId },
    });
    expect(picked.statusCode, picked.body).toBe(200);
    // What the Console's "Hand-over prize" saves: kind manual, no value.
    definitionId = newId();
    await ctx.db.insert(voucherDefinition).values({
      id: definitionId,
      operatorId,
      code: `test-hand-over-${definitionId}`,
      nameEn: 'Mystery Gift',
      kind: 'manual',
      valueType: 'none',
    });
  });

  /** A Mystery Gift voucher as the booth sync files one, held for a fresh cart at the till. */
  async function heldGift(): Promise<{ voucherId: string; code: string; saleId: string }> {
    const voucherId = newId();
    const code = mintBoothCode('B1', (max) => randomInt(max));
    await ctx.db.insert(voucher).values({
      id: voucherId,
      operatorId,
      branchId,
      voucherDefinitionId: definitionId,
      code,
      source: 'booth',
      status: 'issued',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    });
    const saleId = newId();
    const held = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/vouchers`,
      headers: { cookie: till },
      payload: { code },
    });
    expect(held.statusCode, held.body).toBe(200);
    return { voucherId, code, saleId };
  }

  /** The code alone: no ticket line and no item line. */
  const ringUp = (saleId: string, code: string, finalise: boolean) =>
    ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: till },
      payload: { id: saleId, stationId, lines: [], items: [], promoCodes: [code], finalise },
    });

  /** The voucher's ledger, oldest first, as `kind` or `kind/reason`. */
  const ledgerOf = async (voucherId: string): Promise<string[]> =>
    (
      await ctx.db
        .select({ kind: voucherRedemption.kind, reason: voucherRedemption.reason })
        .from(voucherRedemption)
        .where(eq(voucherRedemption.voucherId, voucherId))
        .orderBy(voucherRedemption.createdAt, voucherRedemption.id)
    ).map((r) => (r.reason ? `${r.kind}/${r.reason}` : r.kind));

  it('commits, closes at ฿0 and uses the voucher up, with no line made up for the prize', async () => {
    const { voucherId, code, saleId } = await heldGift();

    const rung = await ringUp(saleId, code, true);
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json().finalised).toBe(true);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row).toMatchObject({ status: 'finalised', subtotalSatang: 0, grossSatang: 0 });
    expect(row!.receiptNumber).toBeTruthy();
    // No sale line: the prize has no product and no taxable category to book.
    expect(await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId))).toEqual([]);
    // The discount row is what names the voucher on the sale, at ฿0 and with no
    // "doesn't apply" note: the prize was handed over.
    const discounts = await ctx.db
      .select()
      .from(saleDiscount)
      .where(eq(saleDiscount.saleId, saleId));
    expect(discounts).toHaveLength(1);
    expect(discounts[0]).toMatchObject({
      kind: 'promo',
      code,
      label: `Mystery Gift (voucher …${code.slice(-4)})`,
      amountSatang: 0,
      exhaustedReason: null,
    });
    const [used] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(used).toMatchObject({ status: 'redeemed', saleId });
    expect(await ledgerOf(voucherId)).toEqual(['held', 'applied', 'consumed']);

    // A code that puts nothing on the bill is still an empty cart, as before.
    const noLine = await commit({ lines: [], items: [], promoCodes: ['KIDS23'] });
    expect(noLine.statusCode).toBe(400);
    expect(noLine.json().error.message).toBe('The cart is empty');
  });

  it('rung up at ฿0 without closing, it keeps the voucher until the confirm press closes the sale', async () => {
    const { voucherId, code, saleId } = await heldGift();

    // Pay: the payment screen opens on a sale the platform holds, unclosed.
    const rung = await ringUp(saleId, code, false);
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json()).toMatchObject({ finalised: false, outstandingSatang: 0 });
    const [open] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(open).toMatchObject({ status: 'tendering', grossSatang: 0, receiptNumber: null });
    const [kept] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(kept).toMatchObject({ status: 'issued', heldSaleId: saleId, saleId: null });
    expect(await ledgerOf(voucherId)).toEqual(['held', 'applied']);

    // Confirm: the till's tender names ฿0. Nothing is owed, so no payment is
    // recorded; the close numbers the receipt and uses the voucher up.
    const tender = {
      method: 'cash',
      kind: 'cash',
      amountSatang: 0,
      tenderedSatang: 0,
      changeSatang: 0,
    };
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: till },
      payload: { actionId: newId(), ...tender, tender },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [voucherId] });
    const [done] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(done!.status).toBe('finalised');
    expect(done!.receiptNumber).toBeTruthy();
    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toEqual([]);
    const [used] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(used).toMatchObject({ status: 'redeemed', saleId, heldSaleId: null });
    expect(await ledgerOf(voucherId)).toEqual(['held', 'applied', 'consumed']);

    // Used once: the next scan of the same slip says so.
    const again = await ctx.app.inject({
      method: 'GET',
      url: `/vouchers/lookup?code=${encodeURIComponent(code)}`,
      headers: { cookie: till },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REDEEMED');
  });

  it('rung up at ฿0 without closing, it is voided by the till’s Cancel and the voucher is free again', async () => {
    const { voucherId, code, saleId } = await heldGift();
    expect((await ringUp(saleId, code, false)).statusCode).toBe(200);

    const voided = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/void`,
      headers: { cookie: till },
      payload: { reason: 'Cancelled at the till' },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().releasedVoucherIds).toEqual([voucherId]);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row).toMatchObject({
      status: 'voided',
      voidReason: 'Cancelled at the till',
      receiptNumber: null,
    });
    const [free] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(free).toMatchObject({ status: 'issued', heldSaleId: null, saleId: null });
    expect(await ledgerOf(voucherId)).toEqual(['held', 'applied', 'released/sale_voided']);

    // SCRUM-433 — the slip is live again, so the voided sale names it by the
    // last four only: in the void's answer and in the sale read back.
    const tail = `…${code.slice(-4)}`;
    expect(voided.body).not.toContain(code);
    const readBack = await ctx.app.inject({
      method: 'GET',
      url: `/sales/${saleId}`,
      headers: { cookie: till },
    });
    expect(readBack.statusCode, readBack.body).toBe(200);
    expect(readBack.body).not.toContain(code);
    expect(readBack.json().discounts).toEqual([
      expect.objectContaining({ code: tail, label: `Mystery Gift (voucher ${tail})` }),
    ]);

    // Free for the next cart: held again, rung up again, closed at the confirm.
    const nextSale = newId();
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${nextSale}/vouchers`,
      headers: { cookie: till },
      payload: { code },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect((await ringUp(nextSale, code, false)).statusCode).toBe(200);
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${nextSale}/finalise`,
      headers: { cookie: till },
      payload: {},
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const [used] = await ctx.db.select().from(voucher).where(eq(voucher.id, voucherId));
    expect(used).toMatchObject({ status: 'redeemed', saleId: nextSale });
  });
});

/**
 * SCRUM-258 — the admin panel raised an unexplained 500 when a manager removed
 * a holiday range the park had already traded on. `pos.sale.holiday_id` is ON
 * DELETE RESTRICT on purpose: the sale names the range that put it on weekend
 * prices, and the receipt has to go on saying so. The refusal is now made in
 * words, and only when a sale is actually pointing at the range.
 */
describe('removing a holiday range the park has traded on', () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  });

  const addHoliday = async (name: string, startsOn: string, endsOn: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/holidays`,
      headers: { cookie: adminCookie },
      payload: { name, startsOn, endsOn },
    });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  };

  const removeHoliday = async (id: string) =>
    ctx.app.inject({
      method: 'DELETE',
      url: `/branches/${branchId}/holidays/${id}`,
      headers: { cookie: adminCookie },
    });

  it('removes a range nothing was sold under', async () => {
    const id = await addHoliday('Provisional Closure', '2031-01-02', '2031-01-03');
    const res = await removeHoliday(id);
    expect(res.statusCode).toBe(200);
    expect(await ctx.db.select().from(branchHoliday).where(eq(branchHoliday.id, id))).toHaveLength(0);
  });

  it('refuses in words once a sale was priced by it, and keeps the sale pointing at it', async () => {
    const date = today();
    const holidayId = await addHoliday('Traded Holiday', date, date);
    const saleId = newId();
    try {
      const written = await commit({ id: saleId, memberId: jamesId, lines: [line(twoHoursId, 1, 0)] });
      expect(written.statusCode).toBe(200);
      const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      expect(row!.holidayId).toBe(holidayId);
      expect(row!.holidayName).toBe('Traded Holiday');

      const res = await removeHoliday(holidayId);
      // Not a 500 from a raw foreign-key violation, and not a silent success
      // that would strip a receipt of the reason it charged weekend prices.
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('HOLIDAY_HAS_SALES');
      expect(res.json().error.message).toContain('Traded Holiday');
      expect(res.json().error.details.saleCount).toBe(1);

      const [still] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      expect(still!.holidayId).toBe(holidayId);
      expect(await ctx.db.select().from(branchHoliday).where(eq(branchHoliday.id, holidayId))).toHaveLength(1);
    } finally {
      // Put the calendar back: a range covering today would put every later
      // test in this file on weekend prices.
      await ctx.db.delete(saleLine).where(eq(saleLine.saleId, saleId));
      await ctx.db.delete(saleDiscount).where(eq(saleDiscount.saleId, saleId));
      await ctx.db.delete(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
      await ctx.db.delete(sale).where(eq(sale.id, saleId));
      await ctx.db.delete(branchHoliday).where(eq(branchHoliday.id, holidayId));
    }
  });
});

describe('the seam between this and the till', () => {
  /**
   * THE TILL HAS A CALLER, and this is the assertion that says so rather than
   * a sentence in a report. `apps/pos/src/api/sales.ts` posts to `/sales/quote`
   * and `/sales`; `apps/pos` has no test runner of its own, so this is the only
   * place in the repository where the two halves of SCRUM-203 are checked to
   * still be pointing at each other.
   *
   * IF IT GOES RED, the till stopped calling the platform — which is the state
   * the audit found and this ticket exists to end. Do not delete it: find out
   * what happened to the caller.
   */
  it('is called by apps/pos, and the route it calls exists here', () => {
    const root = fileURLToPath(new URL('../../pos/src', import.meta.url));
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const text = readFileSync(full, 'utf8');
        if (/['"`]\/sales(\/quote|\/|['"`?])/.test(text)) callers.push(full);
      }
    };
    walk(root);
    expect(
      callers.length,
      'nothing in apps/pos calls the sales API any more — the till has gone back to ' +
        'pricing in the browser, which is the defect SCRUM-203 exists to fix',
    ).toBeGreaterThan(0);

    const urls = new Set(ctx.app.routeRegistry.map((r) => `${r.method} ${r.url}`));
    expect(urls.has('POST /sales/quote')).toBe(true);
    expect(urls.has('POST /sales')).toBe(true);
  });

  it('still renders in the OpenAPI document reception reads the API from', async () => {
    // The finalise body is nullish — a press of the button with nothing typed
    // into it — and a schema the generator cannot convert takes the whole
    // document down, not just this route.
    //
    // Read with an administrator's cookie: the document takes
    // `admin:health:read` since SCRUM-254, where it used to answer anyone.
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/json', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const paths = res.json().paths as Record<string, unknown>;
    expect(Object.keys(paths).filter((p) => p.startsWith('/sales'))).toEqual([
      '/sales/quote',
      '/sales/',
      '/sales/{id}/finalise',
      // S2-10b — the till's cancel of a sale that took no money.
      '/sales/{id}/void',
      '/sales/{id}',
      // SCRUM-307 — the document check that prices a walk-in's cart.
      '/sales/tier-claims',
      // S2-10b — a voucher held on the cart the till is ringing up, and taken
      // off it again (`routes/vouchers.ts`).
      '/sales/{id}/vouchers',
      '/sales/{id}/vouchers/{voucherId}',
    ]);
  });

  it('registers every sales route with a guard, and the writes with a branch target', () => {
    const routes = ctx.app.routeRegistry.filter((r) => r.url.startsWith('/sales'));
    const guards = routes
      .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .map((r) => {
        // `dynamic` and `NONE` are different answers: one is a guard the
        // handler makes, the other is a route nobody guarded at all.
        const guard = r.config.permission ?? (r.config.dynamicPermission ? 'dynamic' : 'NONE');
        return `${r.method} ${r.url} ${guard} ${r.config.target?.branchId ?? 'no-target'}`;
      })
      .sort();
    // The two cart routes declare where the branch is in the request. The
    // finalise route cannot — the branch is the SALE's, not the URL's — so its
    // scope check is made in the service when the row is loaded, and the test
    // above proves it refuses. The list is dynamic for the same kind of
    // reason (SCRUM-297): with no branch in the request the question is not
    // "may you act on this branch" but "which branches do you hold", and a
    // route-level permission with no target cannot ask that one.
    // The tier claim (SCRUM-307) is guarded on the permission that records a
    // verification against a member, because it is the same act one step
    // earlier — and it declares its branch for the same reason the cart routes
    // do, the handler re-checking the branch it settles on.
    // S2-10b — the two voucher routes are dynamic for the finalise route's
    // reason, sharpened: the branch is neither in the request nor on a sale row
    // that may not exist yet, but on the TILL the session is standing at, which
    // is loaded first and checked for `pos:voucher:redeem` there. The void
    // (S2-10b) is the finalise route's twin: `pos:sale:void`, and the branch
    // checked on the sale row once it is loaded.
    expect(guards).toEqual([
      'DELETE /sales/:id/vouchers/:voucherId dynamic no-target',
      'GET /sales dynamic no-target',
      'GET /sales/:id pos:sale:read no-target',
      'POST /sales pos:sale:create body.branchId',
      'POST /sales/:id/finalise pos:sale:update no-target',
      'POST /sales/:id/void pos:sale:void no-target',
      'POST /sales/:id/vouchers dynamic no-target',
      'POST /sales/quote pos:sale:create body.branchId',
      'POST /sales/tier-claims pos:member:update body.branchId',
    ]);
  });
});
