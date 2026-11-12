import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, booking, branch, checkin, registration, station, ticketPackage } from '@oto/db';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-886 — WAITING BOOKINGS FROM EARLIER DAYS CAN BE CANCELLED FROM THE
 * CHECK-IN BOARD.
 *
 * SCRUM-862 kept the board unfiltered: a family still waiting from an earlier
 * day stays on its Upcoming tab, where the till now offers the picker's
 * Cancel booking. The board's waiting child says which other day its stay is
 * for (`bookedForDate`, by the picker's own day rule: the online booking's
 * visit date, else the booked start, else the day it was registered, on the
 * branch's trading day), null when it is today's or not waiting. The cancel is
 * SCRUM-862's route, unchanged: an earlier day's waiting, unpaid booking goes,
 * leaves the board and its count; a paid one is refused and stays.
 */

let ctx: TestContext;
let reception: string;
let branchId: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;
let timezone: string;
let dayStart: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];
const DAY = 24 * 3_600_000;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
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

function childBody(name: string) {
  return {
    checkinId: newId(),
    name,
    ageYears: 6,
    service: 'drop_off',
    allergies: null,
    foodRestrictions: null,
    foodProvision: { mode: 'none', paidSatang: 0 },
  };
}

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
      guardianPhone: '0812345886',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; children: Array<{ id: string; childName: string }> };
}

const post = (url: string, payload: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie: reception, 'idempotency-key': newId() }, payload });

interface BoardAnswer {
  counts: { registered: number; in_park: number; out: number };
  families: Array<{ registrationId: string; children: Array<{ id: string; status: string; bookedForDate?: string | null }> }>;
}
async function board(): Promise<BoardAnswer> {
  const res = await ctx.app.inject({ method: 'GET', url: `/checkin/board?branchId=${branchId}`, headers: { cookie: reception } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const childOn = (b: BoardAnswer, id: string) => b.families.flatMap((f) => f.children).find((c) => c.id === id);

/** Asia/Bangkok has no DST: the branch's trading-day start today, as an instant. */
function todayTradingDayStart(now = new Date()): Date {
  expect(timezone).toBe('Asia/Bangkok');
  const date = businessDate(now, timezone, parseDayStart(dayStart));
  return new Date(`${date}T${dayStart.slice(0, 5)}:00+07:00`);
}
const bangkokDateOf = (instant: Date) => businessDate(instant, timezone, parseDayStart(dayStart));

async function backdate(registrationId: string, at: Date) {
  await ctx.db.update(checkin).set({ createdAt: at }).where(eq(checkin.registrationId, registrationId));
}

describe("the board's waiting child says which other day it is for", () => {
  it('an earlier day, a later booked start and an online visit date; null for today and once in the park', async () => {
    const start = todayTradingDayStart();
    const old = await register([childBody('ZZ TEST Old')]);
    const fiveWeeksAgo = new Date(start.getTime() - 38 * DAY + 9 * 3_600_000);
    await backdate(old.id, fiveWeeksAgo);
    const today = await register([childBody('ZZ TEST Today')]);
    const later = await register([childBody('ZZ TEST Tomorrow')]);
    const tomorrowTen = new Date(start.getTime() + DAY + 5 * 3_600_000);
    await ctx.db.update(checkin).set({ scheduledFor: tomorrowTen }).where(eq(checkin.registrationId, later.id));
    const online = await register([childBody('ZZ TEST Online')], 'ZZ TEST Online Parent');
    const visit = bangkokDateOf(new Date(start.getTime() + 3 * DAY + 6 * 3_600_000));
    await ctx.db.update(registration).set({ source: 'booking' }).where(eq(registration.id, online.id));
    await ctx.db.insert(booking).values({
      id: newId(),
      operatorId,
      branchId,
      reference: `ZZ-${newId().slice(0, 8)}`,
      bookingDate: visit,
      status: 'paid',
      payload: { registrationId: online.id, lines: [] },
    });

    const b = await board();
    expect(childOn(b, old.children[0]!.id)?.bookedForDate).toBe(bangkokDateOf(fiveWeeksAgo));
    expect(bangkokDateOf(fiveWeeksAgo)).not.toBe(bangkokDateOf(new Date()));
    expect(childOn(b, today.children[0]!.id)?.bookedForDate).toBeNull();
    expect(childOn(b, later.children[0]!.id)?.bookedForDate).toBe(bangkokDateOf(tomorrowTen));
    expect(childOn(b, online.children[0]!.id)?.bookedForDate).toBe(visit);

    // Checked in, a stay is no longer waiting for any day.
    const inPark = await register([childBody('ZZ TEST In park')]);
    await backdate(inPark.id, fiveWeeksAgo);
    const saleId = await paidSaleFor(inPark.children[0]!.id);
    const checkedIn = await post('/checkin/check-in-now', { saleId, entries: [{ checkinId: inPark.children[0]!.id }] });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);
    const after = await board();
    expect(childOn(after, inPark.children[0]!.id)).toMatchObject({ status: 'in_park', bookedForDate: null });
  });
});

/** A ticket sale carrying the stay on its own drop-off line, finalised. */
async function paidSaleFor(stayId: string): Promise<string> {
  const saleId = newId();
  const commit = await post('/sales', {
    id: saleId,
    stationId,
    lines: [{ id: stayId, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 5_000 } }],
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await post(`/sales/${saleId}/finalise`);
  expect(fin.statusCode, fin.body).toBe(200);
  return saleId;
}

describe("an earlier day's booking is cancelled from the board", () => {
  it('a waiting, unpaid family from five weeks ago: cancelled, off the board, its count gone, audited', async () => {
    const old = await register([childBody('ZZ TEST Mint'), childBody('ZZ TEST Bua')]);
    await backdate(old.id, new Date(todayTradingDayStart().getTime() - 38 * DAY + 9 * 3_600_000));
    const before = await board();
    expect(before.families.some((f) => f.registrationId === old.id)).toBe(true);

    const res = await post(`/checkin/registrations/${old.id}/cancel`, { reason: 'ZZ TEST leftover from October' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { children: Array<{ status: string }> }).children.map((c) => c.status)).toEqual(['cancelled', 'cancelled']);

    const after = await board();
    expect(after.families.some((f) => f.registrationId === old.id)).toBe(false);
    expect(after.counts.registered).toBe(before.counts.registered - 2);
    for (const c of old.children) {
      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, c.id), eq(auditLog.action, 'checkin.update')));
      expect(rows.map((r) => r.after)).toContainEqual(
        expect.objectContaining({ status: 'cancelled', cancelReason: 'ZZ TEST leftover from October', event: 'cancel' }),
      );
    }
  });

  it('a paid family from an earlier day is refused and stays on the board', async () => {
    const paid = await register([childBody('ZZ TEST Paid')]);
    await paidSaleFor(paid.children[0]!.id);
    await backdate(paid.id, new Date(todayTradingDayStart().getTime() - 3 * DAY));
    const res = await post(`/checkin/registrations/${paid.id}/cancel`, { reason: 'ZZ TEST tidy' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_CANCEL_PAID');
    expect((await board()).families.some((f) => f.registrationId === paid.id)).toBe(true);
  });
});

describe('a family one child of which came and left on an earlier day', () => {
  it("names the collected child on the board, whatever the day, and the cancel's refusal is unchanged", async () => {
    const fam = await register([childBody('ZZ TEST Came'), childBody('ZZ TEST Never')]);
    const [came, never] = fam.children;
    const saleId = await paidSaleFor(came!.id);
    const checkedIn = await post('/checkin/check-in-now', { saleId, entries: [{ checkinId: came!.id }] });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);
    const fiveWeeksAgo = new Date(todayTradingDayStart().getTime() - 38 * DAY + 9 * 3_600_000);
    await backdate(fam.id, fiveWeeksAgo);
    await ctx.db
      .update(checkin)
      .set({ status: 'out', checkedInAt: fiveWeeksAgo, checkedOutAt: new Date(fiveWeeksAgo.getTime() + 2 * 3_600_000) })
      .where(eq(checkin.id, came!.id));

    const b = await board();
    const onBoard = b.families.find((f) => f.registrationId === fam.id) as
      | (BoardAnswer['families'][number] & { checkedInChildNames?: string[] })
      | undefined;
    // The card holds only the waiting child (the Out tab is today's pickups)…
    expect(onBoard?.children.map((c) => [c.id, c.status])).toEqual([[never!.id, 'registered']]);
    // …and names the one who came, so the till disables its Cancel booking.
    expect(onBoard?.checkedInChildNames).toEqual(['ZZ TEST Came']);

    // SCRUM-862's refusal stands (an owner rule question, not changed here).
    const res = await post(`/checkin/registrations/${fam.id}/cancel`, { reason: 'ZZ TEST tidy' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_CANCEL_CHECKED_IN');
    expect((await board()).families.some((f) => f.registrationId === fam.id)).toBe(true);
  });

  it('a family nobody on which was checked in names nobody', async () => {
    const fam = await register([childBody('ZZ TEST Waiting')]);
    const onBoard = (await board()).families.find((f) => f.registrationId === fam.id) as { checkedInChildNames?: string[] } | undefined;
    expect(onBoard?.checkedInChildNames).toEqual([]);
  });
});
