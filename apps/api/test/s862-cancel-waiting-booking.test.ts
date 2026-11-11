import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, booking, branch, checkin, registration, station, ticketPackage } from '@oto/db';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import { registrationsAwaitingCheckIn } from '../src/services/checkin';
import { CHALONG_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-862 — A WAITING DROP-OFF OR NANNY BOOKING CAN BE CANCELLED, AND
 * YESTERDAY'S WAITING BOOKINGS LEAVE THE LIST.
 *
 * The till's Add drop-off picker listed every registration with a child still
 * `registered`, whatever the day, and nothing could take one off: signed
 * registrations nobody paid for (test leftovers among them) stayed on the
 * list for good. Now:
 *
 *   - `POST /checkin/registrations/:id/cancel` moves every waiting, unpaid,
 *     not-checked-in child to `cancelled` with the reason given, audited,
 *     idempotent; a paid or checked-in child refuses the whole press (that is
 *     the sale's refund or void path); the permission is the one that
 *     registers a child; a cancelled stay is never sold or checked in;
 *   - the picker lists a waiting child on the day their stay is FOR — the
 *     booked start, the online booking's visit date, else the day they were
 *     registered — on the branch's trading day (05:00 Bangkok, the day the
 *     board's Out tab and the cash day use). Yesterday's leave by themselves;
 *     an advance booking appears on its date. Nothing is deleted.
 */

let ctx: TestContext;
let reception: string;
let chalongManager: string;
let branchId: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;
let timezone: string;
let dayStart: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  timezone = hkt!.timezone;
  dayStart = hkt!.businessDayStart;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers --------------------------------------------------------------------

function childBody(name: string, over: Record<string, unknown> = {}) {
  return {
    checkinId: newId(),
    name,
    ageYears: 6,
    service: 'drop_off',
    allergies: null,
    foodRestrictions: null,
    foodProvision: { mode: 'none', paidSatang: 0 },
    ...over,
  };
}

/** A ZZ TEST family registered at the till, waiting and unpaid. */
async function register(children: Record<string, unknown>[], guardianName = 'ZZ TEST Ploy') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: reception },
    payload: {
      id: newId(),
      branchId,
      stationId,
      guardianName,
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; children: Array<{ id: string; childName: string; status: string }> };
}

function cancel(registrationId: string, reason: string, cookie = reception, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/checkin/registrations/${registrationId}/cancel`,
    headers: { cookie, 'idempotency-key': newId(), ...headers },
    payload: { reason },
  });
}

/** What the till's picker reads, as the route answers it now. */
async function listed(): Promise<Array<{ id: string; children: Array<{ id: string; status: string }> }>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/checkin/registrations?branchId=${branchId}`,
    headers: { cookie: reception },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().registrations;
}

async function boardFamilies(): Promise<Array<{ registrationId: string }>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/checkin/board?branchId=${branchId}`,
    headers: { cookie: reception },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().families;
}

async function stay(id: string) {
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, id));
  return row!;
}

async function cancelAuditRows(stayId: string) {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, stayId), eq(auditLog.action, 'checkin.update')));
  return rows.filter((r) => (r.after as { status?: string } | null)?.status === 'cancelled');
}

/** A ticket sale carrying the stay on its own drop-off line; finalised when `finalise`. */
async function saleFor(stayId: string, finalise: boolean): Promise<string> {
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception, 'idempotency-key': newId() },
    payload: {
      id: saleId,
      stationId,
      lines: [{ id: stayId, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 5_000 } }],
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  if (finalise) {
    const fin = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: {},
    });
    expect(fin.statusCode, fin.body).toBe(200);
  }
  return saleId;
}

/** Asia/Bangkok has no DST: the branch's trading-day start today, as an instant. */
function todayTradingDayStart(now = new Date()): Date {
  expect(timezone).toBe('Asia/Bangkok');
  const date = businessDate(now, timezone, parseDayStart(dayStart));
  return new Date(`${date}T${dayStart.slice(0, 5)}:00+07:00`);
}

function bangkokDateOf(instant: Date): string {
  return businessDate(instant, timezone, parseDayStart(dayStart));
}

// --- Cancel -----------------------------------------------------------------------

describe('cancelling a waiting booking', () => {
  it('moves every waiting child to cancelled with the reason, off the picker and the board, audited', async () => {
    const reg = await register([childBody('ZZ TEST Mint'), childBody('ZZ TEST Bua', { ageYears: 3, service: 'nanny' })]);
    expect((await listed()).some((r) => r.id === reg.id)).toBe(true);

    const res = await cancel(reg.id, 'Family did not come');
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json() as { id: string; consentRecordedAt: string | null; children: Array<{ id: string; status: string }> };
    expect(answer.id).toBe(reg.id);
    expect(answer.children.map((c) => c.status)).toEqual(['cancelled', 'cancelled']);
    // The signed consent stays on the registration, for the record.
    expect(answer.consentRecordedAt).not.toBeNull();

    for (const c of reg.children) {
      const row = await stay(c.id);
      expect(row.status).toBe('cancelled');
      expect(row.cancelReason).toBe('Family did not come');
      expect(row.cancelledAt).not.toBeNull();
      expect(row.cancelledByAccountId).not.toBeNull();
      expect(row.checkedInAt).toBeNull();
      const rows = await cancelAuditRows(c.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.before).toMatchObject({ status: 'registered', cancelReason: null });
      expect(rows[0]!.after).toMatchObject({ status: 'cancelled', cancelReason: 'Family did not come', event: 'cancel' });
    }
    const [regRow] = await ctx.db.select().from(registration).where(eq(registration.id, reg.id));
    expect(regRow!.consentRecordedAt).not.toBeNull();

    expect((await listed()).some((r) => r.id === reg.id)).toBe(false);
    expect((await boardFamilies()).some((f) => f.registrationId === reg.id)).toBe(false);
  });

  it('cancelled twice is one audit row and the same answer, with the same key or a new one', async () => {
    const reg = await register([childBody('ZZ TEST Mint')]);
    const key = newId();
    const first = await cancel(reg.id, 'Left before paying', reception, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await cancel(reg.id, 'Left before paying', reception, { 'idempotency-key': key });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const again = await cancel(reg.id, 'Pressed again');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await cancelAuditRows(reg.children[0]!.id)).toHaveLength(1);
    expect((await stay(reg.children[0]!.id)).cancelReason).toBe('Left before paying');
  });

  it('refuses a booking a till sale already paid for, and changes nothing', async () => {
    const reg = await register([childBody('ZZ TEST Mint')]);
    await saleFor(reg.children[0]!.id, true);
    const res = await cancel(reg.id, 'Oops');
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_CANCEL_PAID');
    expect(res.json().error.message).toContain('already paid for at the till');
    expect((await stay(reg.children[0]!.id)).status).toBe('registered');
    expect(await cancelAuditRows(reg.children[0]!.id)).toHaveLength(0);
  });

  it('refuses a booking with a child already checked in', async () => {
    const reg = await register([childBody('ZZ TEST Mint'), childBody('ZZ TEST Bua')]);
    const mint = reg.children[0]!;
    const saleId = await saleFor(mint.id, true);
    const checkedIn = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-now',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { saleId, entries: [{ checkinId: mint.id }] },
    });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);
    const res = await cancel(reg.id, 'Oops');
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_CANCEL_CHECKED_IN');
    expect(res.json().error.message).toContain('ZZ TEST Mint was already checked in');
    expect((await stay(mint.id)).status).toBe('in_park');
    expect((await stay(reg.children[1]!.id)).status).toBe('registered');
  });

  it("is refused for staff without the branch's register permission", async () => {
    const reg = await register([childBody('ZZ TEST Mint')]);
    const res = await cancel(reg.id, 'Not mine', chalongManager);
    expect(res.statusCode, res.body).toBe(403);
    expect((await stay(reg.children[0]!.id)).status).toBe('registered');
  });

  it('needs a reason', async () => {
    const reg = await register([childBody('ZZ TEST Mint')]);
    const res = await cancel(reg.id, '   ');
    expect(res.statusCode, res.body).toBe(400);
    expect((await stay(reg.children[0]!.id)).status).toBe('registered');
  });

  it('a cancelled booking cannot be put on a sale, and a sale already begun cannot check it in', async () => {
    const reg = await register([childBody('ZZ TEST Mint')]);
    const stayId = reg.children[0]!.id;
    expect((await cancel(reg.id, 'Family left')).statusCode).toBe(200);

    const sale = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: {
        id: newId(),
        stationId,
        lines: [{ id: stayId, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 5_000 } }],
      },
    });
    expect(sale.statusCode, sale.body).toBe(409);
    expect(sale.json().error.code).toBe('CHECKIN_CANCELLED');
    expect(sale.json().error.message).toContain("ZZ TEST Mint's drop-off booking was cancelled");

    // Begun before the cancel (Pay pressed, not yet paid): the money press goes
    // through, the check-in after it does not.
    const other = await register([childBody('ZZ TEST Bua')]);
    const otherStay = other.children[0]!.id;
    const saleId = await saleFor(otherStay, false);
    expect((await cancel(other.id, 'Changed their mind')).statusCode).toBe(200);
    const fin = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: {},
    });
    expect(fin.statusCode, fin.body).toBe(200);
    for (const url of ['/checkin/check-in-now', '/checkin/leave-as-booked']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url,
        headers: { cookie: reception, 'idempotency-key': newId() },
        payload: { saleId, entries: [{ checkinId: otherStay }] },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('CHECKIN_NOT_REGISTERED');
      expect(res.json().error.message).toContain('booking was cancelled');
    }
    expect((await stay(otherStay)).status).toBe('cancelled');
  });
});

// --- The day boundary ---------------------------------------------------------------

describe("the picker lists only bookings for the branch's trading day", () => {
  it("drops yesterday's waiting booking across the Bangkok day boundary, and keeps today's", async () => {
    const start = todayTradingDayStart();
    const lastEvening = await register([childBody('ZZ TEST Yesterday')]);
    // Registered at 19:00 Bangkok the evening before (the owner's case).
    const evening = new Date(start.getTime() - 10 * 3_600_000);
    expect(bangkokDateOf(evening)).not.toBe(bangkokDateOf(new Date()));
    await ctx.db.update(checkin).set({ createdAt: evening }).where(eq(checkin.registrationId, lastEvening.id));
    const justBefore = await register([childBody('ZZ TEST Just before')]);
    await ctx.db.update(checkin).set({ createdAt: new Date(start.getTime() - 60_000) }).where(eq(checkin.registrationId, justBefore.id));
    const onTheDot = await register([childBody('ZZ TEST On the dot')]);
    await ctx.db.update(checkin).set({ createdAt: start }).where(eq(checkin.registrationId, onTheDot.id));
    const today = await register([childBody('ZZ TEST Today')]);

    const ids = (await listed()).map((r) => r.id);
    expect(ids).not.toContain(lastEvening.id);
    expect(ids).not.toContain(justBefore.id);
    expect(ids).toContain(onTheDot.id);
    expect(ids).toContain(today.id);
    // Nothing was deleted or changed: the rows are still registered.
    expect((await stay(lastEvening.children[0]!.id)).status).toBe('registered');
    // The board is not the picker: yesterday's family still waits there.
    expect((await boardFamilies()).some((f) => f.registrationId === lastEvening.id)).toBe(true);
  });

  it('a booking left as booked for tomorrow appears on its day, not today', async () => {
    const reg = await register([childBody('ZZ TEST Tomorrow')]);
    const tomorrowTen = new Date(todayTradingDayStart().getTime() + 24 * 3_600_000 + 5 * 3_600_000);
    await ctx.db.update(checkin).set({ scheduledFor: tomorrowTen }).where(eq(checkin.registrationId, reg.id));

    expect((await listed()).map((r) => r.id)).not.toContain(reg.id);
    const tomorrowNoon = new Date(tomorrowTen.getTime() + 2 * 3_600_000);
    const onItsDay = await registrationsAwaitingCheckIn(ctx.db, operatorId, branchId, tomorrowNoon);
    expect(onItsDay.map((r) => r.id)).toContain(reg.id);
    const dayAfter = await registrationsAwaitingCheckIn(ctx.db, operatorId, branchId, new Date(tomorrowNoon.getTime() + 24 * 3_600_000));
    expect(dayAfter.map((r) => r.id)).not.toContain(reg.id);
  });

  it("an online booking appears on its visit date, whatever day it was paid", async () => {
    const reg = await register([childBody('ZZ TEST Online')], 'ZZ TEST Online Parent');
    const inThreeDays = new Date(todayTradingDayStart().getTime() + 3 * 24 * 3_600_000 + 6 * 3_600_000);
    const visitDate = bangkokDateOf(inThreeDays);
    await ctx.db.update(registration).set({ source: 'booking' }).where(eq(registration.id, reg.id));
    await ctx.db.insert(booking).values({
      id: newId(),
      operatorId,
      branchId,
      reference: `ZZ-${newId().slice(0, 8)}`,
      bookingDate: visitDate,
      status: 'paid',
      payload: { registrationId: reg.id, lines: [] },
    });

    expect((await listed()).map((r) => r.id)).not.toContain(reg.id);
    const onVisitDay = await registrationsAwaitingCheckIn(ctx.db, operatorId, branchId, inThreeDays);
    expect(onVisitDay.map((r) => r.id)).toContain(reg.id);
  });
});
