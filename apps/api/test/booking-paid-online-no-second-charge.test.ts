import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, booking, branch, checkin, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { registrationsAwaitingCheckIn } from '../src/services/checkin';
import { checkinCacheItem } from '../src/services/sync-checkin';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-730 — A FAMILY WHO PAID ONLINE FOR DROP-OFF IS NEVER CHARGED AGAIN.
 *
 * A child booked and paid online waits on the board with no sale of its own,
 * and only a nanny child has a booked time. The approved design
 * (`mockApi.ts:1147-1153`, `checkInFamilyBooked`) never takes a payment for
 * such a child. These walk the board's check-in the way the till walks it:
 * read the waiting list, ring the child up, check them in, then the booking.
 */

const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';

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
let stationId: string;
let oneHourId: string;
let confirmationIds: string[];

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
  operatorId = central!.operatorId;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
  const cat = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  expect(cat.statusCode, cat.body).toBe(200);
  const supervision = cat.json().supervision as { policy: { confirmations: Array<{ id: string; required: boolean }> } };
  confirmationIds = supervision.policy.confirmations.filter((c) => c.required).map((c) => c.id);
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

const DROP_OFF = { childName: 'Ploy', ageYears: 6, allergies: 'Peanuts' };
const NANNY = { childName: 'Tam', ageYears: 3, nannyStartTime: '10:00' };

/** A booking paid through the gateway; the stay ids it bought, in line order. */
async function paidBooking(
  ...children: Array<Record<string, unknown>>
): Promise<{ id: string; reference: string; stayIds: string[]; registrationId: string }> {
  const made = await ctx.app.inject({
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
      lines: children.map((supervision) => ({ packageId: oneHourId, kids: 1, adults: 0, supervision })),
    },
  });
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().id as string;
  const opened = await ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${id}/checkout`,
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
  const [paid] = await ctx.db.select().from(booking).where(eq(booking.id, id));
  expect(paid!.status).toBe('paid');
  const payload = paid!.payload as { registrationId: string; lines: Array<{ supervision: { checkinId: string } }> };
  return {
    id,
    reference: paid!.reference,
    registrationId: payload.registrationId,
    stayIds: payload.lines.map((l) => l.supervision.checkinId),
  };
}

/**
 * What the till's `waitingStaysOf` reads: a family's waiting children, read
 * on the booking's VISIT DAY. SCRUM-862: the picker lists a booking on the day
 * it is for, so a visit booked for next week is not on today's list; this
 * reads the route's own service with that day as now (the route itself is
 * covered by checkin.test.ts and s862-cancel-waiting-booking.test.ts).
 */
async function waitingList(registrationId: string) {
  const regs = await registrationsAwaitingCheckIn(ctx.db, operatorId, branchId, new Date(`${WEEKDAY}T12:00:00+07:00`));
  return regs.find((r) => r.id === registrationId)?.children ?? [];
}

async function boardFamily(registrationId: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/checkin/board?branchId=${branchId}`,
    headers: { cookie: reception },
  });
  expect(res.statusCode, res.body).toBe(200);
  const families = res.json().families as Array<{
    registrationId: string;
    source: string;
    children: Array<Record<string, unknown>>;
  }>;
  return families.find((f) => f.registrationId === registrationId)!;
}

/** The till's cart for a drop-off line: the line takes the stay's id (`stayLine`). */
function ringUp(stayIds: readonly string[]) {
  const saleId = newId();
  return {
    saleId,
    request: ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: {
        id: saleId,
        stationId,
        lines: stayIds.map((id) => ({
          id,
          packageId: oneHourId,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: 5_000 },
        })),
      },
    }),
  };
}

async function finalisedWalkUpSale(): Promise<string> {
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: {
      id: saleId,
      stationId,
      lines: [{ id: newId(), packageId: oneHourId, kids: 1, adults: 1, serviceFee: null }],
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception },
    payload: {},
  });
  expect(fin.statusCode, fin.body).toBe(200);
  return saleId;
}

const redeem = (bookingId: string) =>
  ctx.app.inject({ method: 'POST', url: `/bookings/${bookingId}/redeem`, headers: { cookie: reception }, payload: {} });

const checkInBooked = (entries: Array<Record<string, unknown>>) =>
  ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-booked',
    headers: { cookie: reception },
    payload: { entries },
  });

describe('a child booked and paid online, before the booking is redeemed', () => {
  it('is named paid online on the board and on the waiting list', async () => {
    const paid = await paidBooking(DROP_OFF);
    const stayId = paid.stayIds[0]!;
    const board = await boardFamily(paid.registrationId);
    expect(board.source).toBe('booking');
    expect(board.children.find((c) => c.id === stayId)).toMatchObject({
      status: 'registered',
      saleId: null,
      scheduledFor: null,
      paidOnline: { bookingId: paid.id, reference: paid.reference },
    });
    const [waiting] = await waitingList(paid.registrationId);
    expect(waiting).toMatchObject({
      id: stayId,
      saleId: null,
      paidOnline: { bookingId: paid.id, reference: paid.reference },
    });
  });

  it("is named paid online on the box's copy of the board", async () => {
    const paid = await paidBooking(DROP_OFF);
    const cached = await checkinCacheItem(ctx.db, operatorId, branchId);
    const stay = cached.families.flatMap((f) => f.children).find((c) => c.id === paid.stayIds[0]);
    expect(stay).toMatchObject({ saleId: null, paidOnline: { bookingId: paid.id, reference: paid.reference } });
  });

  it('cannot be rung up on a sale', async () => {
    const paid = await paidBooking(DROP_OFF);
    const { saleId, request } = ringUp(paid.stayIds);
    const res = await request;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_PAID_ONLINE');
    expect(res.json().error.message).toContain(paid.reference);
    expect(res.json().error.message).toContain('Ploy');
    // Nothing was written, and the booking still redeems.
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'sale'), eq(auditLog.entityId, saleId)));
    expect(rows).toHaveLength(0);
    const redeemed = await redeem(paid.id);
    expect(redeemed.statusCode, redeemed.body).toBe(200);
  });

  it('cannot be rung up beside a walk-up family on one sale', async () => {
    const paid = await paidBooking(DROP_OFF);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: {
        id: newId(),
        stationId,
        lines: [
          { id: newId(), packageId: oneHourId, kids: 1, adults: 1, serviceFee: null },
          { id: paid.stayIds[0], packageId: oneHourId, kids: 1, adults: 0, serviceFee: null },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_PAID_ONLINE');
  });

  it("cannot be checked in or left as booked on a sale that is not its booking's", async () => {
    const paid = await paidBooking(DROP_OFF);
    const stayId = paid.stayIds[0]!;
    const saleId = await finalisedWalkUpSale();
    const now = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-now',
      headers: { cookie: reception },
      payload: { saleId, entries: [{ checkinId: stayId }] },
    });
    expect(now.statusCode, now.body).toBe(409);
    expect(now.json().error.code).toBe('CHECKIN_PAID_ONLINE');
    const left = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/leave-as-booked',
      headers: { cookie: reception },
      payload: { saleId, entries: [{ checkinId: stayId }] },
    });
    expect(left.statusCode, left.body).toBe(409);
    expect(left.json().error.code).toBe('CHECKIN_PAID_ONLINE');
    const [held] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayId));
    expect(held).toMatchObject({ status: 'registered', saleId: null });
  });

  it('is not called unpaid at the board: the refusal names the booking to redeem', async () => {
    const drop = await paidBooking(DROP_OFF);
    const dropRes = await checkInBooked([{ checkinId: drop.stayIds[0] }]);
    expect(dropRes.statusCode, dropRes.body).toBe(409);
    expect(dropRes.json().error.code).toBe('CHECKIN_BOOKING_NOT_REDEEMED');
    expect(dropRes.json().error.message).toContain(drop.reference);
    expect(dropRes.json().error.message).not.toMatch(/not been paid/);
    expect(dropRes.json().error.details).toMatchObject({ bookingId: drop.id, reference: drop.reference });

    const nanny = await paidBooking(NANNY);
    const [booked] = await ctx.db.select().from(checkin).where(eq(checkin.id, nanny.stayIds[0]!));
    expect(booked!.scheduledFor).not.toBeNull();
    const nannyRes = await checkInBooked([{ checkinId: nanny.stayIds[0] }]);
    expect(nannyRes.statusCode, nannyRes.body).toBe(409);
    expect(nannyRes.json().error.code).toBe('CHECKIN_BOOKING_NOT_REDEEMED');
    expect(nannyRes.json().error.message).not.toMatch(/not been paid/);
  });
});

describe('the same child once the booking is redeemed', () => {
  it('still names the booking, carries its sale, and the board checks in with no payment', async () => {
    const paid = await paidBooking(DROP_OFF);
    const stayId = paid.stayIds[0]!;
    const redeemed = await redeem(paid.id);
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const [filed] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayId));
    const saleId = filed!.saleId!;
    expect(saleId).toBeTruthy();

    const board = await boardFamily(paid.registrationId);
    expect(board.children.find((c) => c.id === stayId)).toMatchObject({ saleId, paidOnline: { bookingId: paid.id } });

    // A second charge is still refused after the redemption.
    const again = await ringUp(paid.stayIds).request;
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('CHECKIN_PAID_ONLINE');

    const checked = await checkInBooked([{ checkinId: stayId }]);
    expect(checked.statusCode, checked.body).toBe(200);
    const [inPark] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayId));
    expect(inPark).toMatchObject({ status: 'in_park', saleId });
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(1);
  });

  it('asks a nanny child only for the nanny, never refused as not paid', async () => {
    const paid = await paidBooking(NANNY);
    const redeemed = await redeem(paid.id);
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const res = await checkInBooked([{ checkinId: paid.stayIds[0] }]);
    // The refusal that is left is the design's own: pick the nanny first.
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NANNY_REQUIRED');
  });
});

describe('what stays as it was', () => {
  it('a sibling added at the door under a paid booking is charged like any walk-up', async () => {
    const paid = await paidBooking(DROP_OFF);
    const siblingId = newId();
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${paid.registrationId}/children`,
      headers: { cookie: reception },
      payload: { children: [{ checkinId: siblingId, name: 'Nok', ageYears: 7, service: 'drop_off' }] },
    });
    expect(added.statusCode, added.body).toBe(200);

    const waiting = await waitingList(paid.registrationId);
    expect(waiting.find((c) => c.id === siblingId)).toMatchObject({ saleId: null, paidOnline: null });
    expect(waiting.find((c) => c.id === paid.stayIds[0])).toMatchObject({ paidOnline: { bookingId: paid.id } });

    const { saleId, request } = ringUp([siblingId]);
    const rung = await request;
    expect(rung.statusCode, rung.body).toBe(200);
    const fin = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: {},
    });
    expect(fin.statusCode, fin.body).toBe(200);
    const now = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-now',
      headers: { cookie: reception },
      payload: { saleId, entries: [{ checkinId: siblingId }] },
    });
    expect(now.statusCode, now.body).toBe(200);
    const [inPark] = await ctx.db.select().from(checkin).where(eq(checkin.id, siblingId));
    expect(inPark).toMatchObject({ status: 'in_park', saleId });
    // The child the family paid for online is untouched, and the booking redeems.
    const redeemed = await redeem(paid.id);
    expect(redeemed.statusCode, redeemed.body).toBe(200);
  });
});
