import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, booking, branch, checkin, sale, station, ticketPackage } from '@oto/db';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-496 review — entries 21, 23 and 24 attacked from outside the builder's
 * own suite: a basket that mixes a supervised child with an ordinary line, two
 * nanny children sharing one nanny, a replayed payment notice, a tampered
 * service, and the booking reference format (mockApi.ts:1054-1057).
 */

const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';

const WEEKDAY = (() => {
  const day = new Date(Date.now() + 8 * 86_400_000);
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
let oneHourId: string;
let confirmationIds: string[];
let dropOffFee: number;
let nannyHourly: number;

let family = 0;
function familyAddress(): string {
  family += 1;
  return `10.232.${Math.floor(family / 250)}.${(family % 250) + 1}`;
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: MERCHANT,
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = central!.id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
  const cat = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  expect(cat.statusCode, cat.body).toBe(200);
  const supervision = cat.json().supervision as {
    policy: { confirmations: Array<{ id: string; required: boolean }> };
    pricing: { oneTimeFee: { weekday: number }; nannyHourly: { weekday: number } };
  };
  confirmationIds = supervision.policy.confirmations.filter((c) => c.required).map((c) => c.id);
  dropOffFee = supervision.pricing.oneTimeFee.weekday;
  nannyHourly = supervision.pricing.nannyHourly.weekday;

  const [till] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
  const stood = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/station',
    headers: { cookie: reception },
    payload: { stationId: till!.id },
  });
  expect(stood.statusCode, stood.body).toBe(200);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function book(lines: unknown[], over: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345679',
      parentName: 'Khun Dao',
      tier: 'thai',
      visitDate: WEEKDAY,
      consentAck: true,
      acknowledgedConfirmationIds: confirmationIds,
      lines,
      ...over,
    },
  });
}

async function payFor(bookingId: string): Promise<string> {
  const opened = await ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${bookingId}/checkout`,
    remoteAddress: familyAddress(),
    payload: { method: 'card' },
  });
  expect(opened.statusCode, opened.body).toBe(200);
  const attemptId = opened.json().attemptId as string;
  const pressed = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/hosted/${attemptId}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'action=pay',
  });
  expect(pressed.statusCode, pressed.body).toBe(200);
  return attemptId;
}

const dropOffChild = { childName: 'Nok', ageYears: 6 };
const regular = { packageId: '', kids: 1, adults: 1 };

describe('the booking reference (entry 24)', () => {
  it('is OTO- and two groups of four base-36 upper-case characters', async () => {
    for (let i = 0; i < 6; i++) {
      const made = await book([{ ...regular, packageId: oneHourId }], { consentAck: undefined, acknowledgedConfirmationIds: undefined });
      expect(made.statusCode, made.body).toBe(200);
      expect(made.json().reference).toMatch(/^OTO-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
  });
});

describe('a supervised child mixed with an ordinary line (entry 21)', () => {
  it('prices both, registers once, files both on one sale, and bands the supervised child only at the board', async () => {
    const plain = await book([{ ...regular, packageId: oneHourId }], { consentAck: undefined, acknowledgedConfirmationIds: undefined });
    expect(plain.statusCode, plain.body).toBe(200);
    const plainTotal = plain.json().totalSatang as number;

    const made = await book([
      { packageId: oneHourId, kids: 1, adults: 0, supervision: dropOffChild },
      { ...regular, packageId: oneHourId },
    ]);
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().totalSatang).toBe(plainTotal + 42_000 + dropOffFee);
    const id = made.json().id as string;

    const attemptId = await payFor(id);
    // A replayed notice for the same attempt must not register the family twice.
    await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/2c2p/hosted/${attemptId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=pay',
    });
    const [paid] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    const payload = paid!.payload as { registrationId: string; lines: Array<{ supervision?: { checkinId: string } }> };
    const created = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'registration.create'), sql`${auditLog.after}->>'bookingId' = ${id}`));
    expect(created).toHaveLength(1);
    const contacts = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, payload.registrationId), eq(auditLog.action, 'registration.contact')));
    expect(contacts).toHaveLength(1);
    const stays = await ctx.db.select().from(checkin).where(eq(checkin.registrationId, payload.registrationId));
    expect(stays).toHaveLength(1);
    const checkinId = payload.lines.find((l) => l.supervision)!.supervision!.checkinId;

    // Entry 23: the paid method reaches the booking view.
    const view = await ctx.app.inject({ method: 'GET', url: `/bookings/${id}`, headers: { cookie: reception } });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().paymentMethod).toBe('card');

    const redeemed = await ctx.app.inject({ method: 'POST', url: `/bookings/${id}/redeem`, headers: { cookie: reception }, payload: {} });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay!.status).toBe('registered');
    const saleId = stay!.saleId!;
    const [rung] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(rung!.bookingId).toBe(id);
    expect(rung!.grossSatang).toBe(made.json().totalSatang);
    const salesBefore = await ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.branchId, branchId));
    const bandsAtRedeem = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    expect(bandsAtRedeem.map((b) => b.kind).sort()).toEqual(['adult', 'kid']);

    const checked = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId }] },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const bandsAfter = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    expect(bandsAfter).toHaveLength(3);
    // No second sale: the board check-in takes no money.
    const salesAfter = await ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.branchId, branchId));
    expect(salesAfter).toHaveLength(salesBefore.length);
  });
});

describe('two nanny children on one booking (entry 21)', () => {
  it('charge one shared nanny, as the till does, and redeem without drift', async () => {
    const made = await book([
      { packageId: oneHourId, kids: 1, adults: 0, supervision: { childName: 'Tam', ageYears: 3, nannyStartTime: '10:00' } },
      { packageId: oneHourId, kids: 1, adults: 0, supervision: { childName: 'Tim', ageYears: 2, nannyStartTime: '10:00' } },
    ]);
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().totalSatang).toBe(2 * 42_000 + nannyHourly);
    const id = made.json().id as string;
    await payFor(id);
    const redeemed = await ctx.app.inject({ method: 'POST', url: `/bookings/${id}/redeem`, headers: { cookie: reception }, payload: {} });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
  });
});

describe('what the family cannot set (entry 21)', () => {
  it('refuses a service or fee sent by the browser, and a supervised line naming two children', async () => {
    const tampered = await book([{ packageId: oneHourId, kids: 1, adults: 0, supervision: { ...dropOffChild, service: 'none' } }]);
    expect(tampered.statusCode).toBe(400);
    const fee = await book([{ packageId: oneHourId, kids: 1, adults: 0, supervision: { ...dropOffChild, serviceFeeSatang: 0 } }]);
    expect(fee.statusCode).toBe(400);
    const two = await book([{ packageId: oneHourId, kids: 2, adults: 0, supervision: dropOffChild }]);
    expect(two.statusCode).toBe(400);
  });
});
