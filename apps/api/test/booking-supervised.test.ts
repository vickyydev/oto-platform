import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, booking, branch, checkin, registration, station, syncChange, ticketPackage } from '@oto/db';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-496 entry 21 — A FAMILY BOOKS A SUPERVISED CHILD ONLINE.
 *
 * The approved design's createBooking (mockApi.ts:1045-1140) registers each
 * drop-off or nanny child with the booking's consent and confirmations, and
 * reception checks them in from the registration without a second payment.
 * Here the platform prices the service from the park's own drop-off pricing,
 * writes the registration only once the money is confirmed, files the child's
 * line on the redemption sale, and leaves the child booked for the board.
 */

const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';

/** A plain weekday a week out, skipping weekends and the seeded holiday range. */
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
let oneHourId: string;
let confirmationIds: string[];
let dropOffFeeWeekday: number;

let family = 0;
function familyAddress(): string {
  family += 1;
  return `10.231.${Math.floor(family / 250)}.${(family % 250) + 1}`;
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
    pricing: { oneTimeFee: { weekday: number } };
  };
  confirmationIds = supervision.policy.confirmations.filter((c) => c.required).map((c) => c.id);
  dropOffFeeWeekday = supervision.pricing.oneTimeFee.weekday;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const CHILD = { childName: 'Ploy', ageYears: 6, allergies: 'Peanuts' };

async function book(over: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345678',
      parentName: 'Khun Mali',
      tier: 'thai',
      visitDate: WEEKDAY,
      consentAck: true,
      acknowledgedConfirmationIds: confirmationIds,
      lines: [{ packageId: oneHourId, kids: 1, adults: 0, supervision: CHILD }],
      ...over,
    },
  });
}

async function payFor(bookingId: string) {
  const opened = await ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${bookingId}/checkout`,
    remoteAddress: familyAddress(),
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
}

describe('a supervised child booked online', () => {
  it('is refused without the guardian consent and the park confirmations', async () => {
    const noConsent = await book({ consentAck: false });
    expect(noConsent.statusCode).toBe(400);
    const noConfirmations = await book({ acknowledgedConfirmationIds: [] });
    expect(noConfirmations.statusCode).toBe(400);
    const withAdult = await book({ lines: [{ packageId: oneHourId, kids: 1, adults: 1, supervision: CHILD }] });
    expect(withAdult.statusCode).toBe(400);
  });

  it('is priced with the park drop-off fee and registered only once paid', async () => {
    const made = await book();
    expect(made.statusCode, made.body).toBe(200);
    // Thai 1 Hour Play kid on a weekday ฿420, plus the drop-off one-time fee.
    expect(made.json().totalSatang).toBe(42_000 + dropOffFeeWeekday);
    const id = made.json().id as string;

    const [pending] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    expect((pending!.payload as Record<string, unknown>).registrationId).toBeUndefined();

    await payFor(id);
    const [paid] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    expect(paid!.status).toBe('paid');
    const payload = paid!.payload as { registrationId: string; lines: Array<{ supervision: { checkinId: string } }> };
    expect(payload.registrationId).toMatch(/^[0-9a-f-]{36}$/);
    const checkinId = payload.lines[0]!.supervision.checkinId;

    const [reg] = await ctx.db.select().from(registration).where(eq(registration.id, payload.registrationId));
    expect(reg).toMatchObject({ source: 'booking', guardianName: 'Khun Mali', guardianPhone: '+66812345678' });
    expect(reg!.consentRecordedAt).not.toBeNull();
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay).toMatchObject({ status: 'registered', service: 'drop_off', bookedMinutes: 60, allergies: 'Peanuts', saleId: null });

    // One connection check for the registration, as at the gate.
    const contact = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, reg!.id), eq(auditLog.action, 'registration.contact')));
    expect(contact).toHaveLength(1);

    // An older box would treat a paid booking as ordinary bands; it is told otherwise.
    const changes = await ctx.db.select().from(syncChange).where(eq(syncChange.entityId, id));
    const last = changes.at(-1)!.payload as { status: string };
    expect(last.status).toBe('supervised_online_only');

    const view = await ctx.app.inject({ method: 'GET', url: `/bookings/${id}`, headers: { cookie: reception } });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().registrationId).toBe(payload.registrationId);
    expect(view.json().lines[0].supervision).toMatchObject({ checkinId, service: 'drop_off', serviceFeeSatang: dropOffFeeWeekday });
  });

  it('books a nanny child at the chosen start time, priced at the nanny hourly rate', async () => {
    const cat = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
    const hourly = (cat.json().supervision as { pricing: { nannyHourly: { weekday: number } } }).pricing.nannyHourly.weekday;
    const noStart = await book({ lines: [{ packageId: oneHourId, kids: 1, adults: 0, supervision: { childName: 'Tam', ageYears: 3 } }] });
    expect(noStart.statusCode).toBe(400);
    const made = await book({
      lines: [{ packageId: oneHourId, kids: 1, adults: 0, supervision: { childName: 'Tam', ageYears: 3, nannyStartTime: '10:00' } }],
    });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().totalSatang).toBe(42_000 + hourly);
    const id = made.json().id as string;
    await payFor(id);
    const [paid] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    const checkinId = (paid!.payload as { lines: Array<{ supervision: { checkinId: string } }> }).lines[0]!.supervision.checkinId;
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay!.service).toBe('nanny');
    // 10:00 in Bangkok on the visit day.
    expect(stay!.scheduledFor!.toISOString()).toBe(`${WEEKDAY}T03:00:00.000Z`);
  });

  it('is filed on the redemption sale with no band, then checked in from the board without paying again', async () => {
    const made = await book();
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().id as string;
    await payFor(id);
    const [paid] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    const checkinId = (paid!.payload as { lines: Array<{ supervision: { checkinId: string } }> }).lines[0]!.supervision.checkinId;

    const [till] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
    const stood = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/station',
      headers: { cookie: reception },
      payload: { stationId: till!.id },
    });
    expect(stood.statusCode, stood.body).toBe(200);

    const redeemed = await ctx.app.inject({ method: 'POST', url: `/bookings/${id}/redeem`, headers: { cookie: reception }, payload: {} });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const [booked] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(booked!.status).toBe('registered');
    expect(booked!.saleId).not.toBeNull();
    expect(booked!.scheduledFor).not.toBeNull();
    expect(await ctx.db.select().from(band).where(eq(band.saleId, booked!.saleId!))).toHaveLength(0);

    const checked = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId }] },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const [inPark] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(inPark!.status).toBe('in_park');
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, booked!.saleId!));
    expect(bands).toHaveLength(1);
    expect(bands[0]!.kind).toBe('kid');
  });
});
