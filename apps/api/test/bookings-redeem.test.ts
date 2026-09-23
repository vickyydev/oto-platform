import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  booking,
  bookingRedemption,
  box,
  branch,
  employee,
  role,
  roleAssignment,
  rolePermission,
  station,
  syncChange,
} from '@oto/db';
import { platformSync } from '@oto/db/seed';
import { newId, type Permission } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { cacheBundle, pullChanges } from '../src/services/sync';
import type { BoxAuth } from '../src/services/box';

/**
 * SCRUM-234 — a booking made online is found and redeemed at the counter.
 *
 * Every case goes through the REAL public route to make the booking, so what
 * the till reads is the row the booking site wrote and not a fixture shaped to
 * match. That is the whole of the defect: `POST /public/bookings` has written
 * `pos.booking` since S2-12 and the till read `mockApi`, so a family who
 * booked and paid online arrived at a counter that had never heard of them.
 *
 * The shapes asserted here are the ones `apps/pos/src/api/bookings.ts`
 * declares and `apps/pos/src/dev/driveBookingRedemption.ts` drives the till
 * against a stand-in of. A disagreement between the two halves is a
 * disagreement about the contract, and it should fail in one of those two
 * places rather than at a counter.
 *
 * The two that matter most:
 *
 *   - a second redemption is refused BY NAME — when, where and by whom the
 *     first happened. A booking redeemed twice is two families through the
 *     gate on one payment, and a silent success is how the second one gets in;
 *   - the same booking is invisible to the other park. A reference is eight
 *     typed characters, so an unscoped lookup is also a way to read the other
 *     park's arrivals by guessing.
 */

let ctx: TestContext;
let centralId: string;
let centralOperatorId: string;
let chalongId: string;
let centralTillId: string;
let chalongTillId: string;
let centralName: string;
let centralTillName: string;
let receptionAccountId: string;
let receptionStaffName: string;
let som: string;
let dao: string;
let packageId: string;
/** The box standing behind Central's reception till, as its own credential sees it. */
let centralBox: BoxAuth;

interface Res {
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
}

const call = async (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  opts: { cookie?: string; payload?: unknown; key?: string } = {},
): Promise<Res> => {
  const res = await ctx.app.inject({
    method,
    url,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.key ? { 'idempotency-key': opts.key } : {}),
    },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { statusCode: res.statusCode, body: body as Record<string, unknown>, headers: res.headers };
};

const errorOf = (res: Res): { code?: string; message?: string; details?: Record<string, unknown> } =>
  (res.body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })
    .error ?? {};

/** The wire shape `apps/pos/src/api/bookings.ts` calls `PlatformRedemption`. */
interface RedemptionView {
  at: string;
  branchName: string | null;
  stationName: string | null;
  staffName: string | null;
  bandCodes: string[];
}

/** The wire shape it calls `PlatformBooking`. */
interface BookingView {
  id: string;
  reference: string;
  branchId: string;
  branchName: string | null;
  memberId: string | null;
  bookingDate: string;
  createdAt: string;
  status: string;
  totalSatang: number;
  tier: string;
  rateMode: string | null;
  parentName: string | null;
  phone: string | null;
  paymentMethod: string | null;
  lines: Array<{
    packageId: string;
    name: string;
    kids: number;
    adults: number;
    kidUnitSatang: number;
    adultsFree: number;
    adultUnitSatang: number;
    lineTotalSatang: number;
  }>;
  redemption: RedemptionView | null;
}

const listed = (res: Res): BookingView[] => (res.body.bookings ?? []) as BookingView[];

/** Make a booking the way a customer does: the public route, priced server-side. */
async function bookOnline(opts: {
  phone?: string;
  kids: number;
  adults: number;
  branchCode?: string;
}): Promise<{ id: string; reference: string; totalSatang: number }> {
  const res = await call('POST', '/public/bookings', {
    payload: {
      branchCode: opts.branchCode ?? CENTRAL_BRANCH_CODE,
      phone: opts.phone,
      parentName: 'Khun Ploy',
      tier: 'tourist',
      lines: [{ packageId, kids: opts.kids, adults: opts.adults }],
    },
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as { id: string; reference: string; totalSatang: number };
}

let planted = 0;

/**
 * A booking row as a release left it, written straight into the table.
 *
 * Everything else in this file goes through the real public route, and says
 * why. These do not, for two reasons. `POST /public/bookings` is rate-limited
 * to twenty a minute from one address — it is a customer-facing route and that
 * cap is the point — and this file already spends nearly all of them. And the
 * cases that use this are about rows that ALREADY EXIST when a release ships:
 * a redemption written into the jsonb before there was a table, a stale block
 * the migration left behind. Planting one is what those are.
 */
async function plantBooking(opts: {
  status?: string;
  payloadRedemption?: Record<string, unknown> | null;
  /** Central unless another park is named — both are the same operator's. */
  branchId?: string;
}): Promise<{ id: string; reference: string }> {
  const id = newId();
  const reference = `OTO-PLANT-${String(++planted).padStart(4, '0')}`;
  await ctx.db.insert(booking).values({
    id,
    operatorId: centralOperatorId,
    branchId: opts.branchId ?? centralId,
    reference,
    bookingDate: new Date().toISOString().slice(0, 10),
    status: opts.status ?? 'paid',
    totalSatang: 120000,
    payload: {
      tier: 'tourist',
      rateMode: 'weekday',
      parentName: 'Khun Ploy',
      phone: '+66812229900',
      contactChannel: 'whatsapp',
      locale: 'en',
      lines: [
        {
          packageId,
          name: 'Planted package',
          kids: 1,
          adults: 1,
          kidUnitSatang: 80000,
          adultsFree: 1,
          adultUnitSatang: 40000,
          lineTotalSatang: 120000,
        },
      ],
      clientSnapshot: null,
      ...(opts.payloadRedemption ? { redemption: opts.payloadRedemption } : {}),
    },
  });
  return { id, reference };
}

/**
 * The redemption as the database holds it, not as a response described it —
 * `pos.booking_redemption` since SCRUM-304.
 */
async function redemptionRows(id: string): Promise<Array<typeof bookingRedemption.$inferSelect>> {
  return ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, id));
}

/** The one redemption row, or null. Fails loudly if a booking ever has two. */
async function storedRedemption(
  id: string,
): Promise<typeof bookingRedemption.$inferSelect | null> {
  const rows = await redemptionRows(id);
  expect(rows.length, 'a booking may be redeemed once').toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

/** What the booking's own jsonb holds — where the redemption used to live. */
async function payloadRedemption(id: string): Promise<unknown> {
  const [row] = await ctx.db.select().from(booking).where(eq(booking.id, id)).limit(1);
  return ((row?.payload ?? {}) as Record<string, unknown>).redemption ?? null;
}

async function redeemAuditRows(id: string): Promise<Array<typeof auditLog.$inferSelect>> {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'booking.redeem')));
}

beforeAll(async () => {
  ctx = await createTestContext();
  centralId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, centralId)).limit(1);
  centralName = central!.name;
  centralOperatorId = central!.operatorId;
  const tills = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
  const centralTill = tills.find((s) => s.branchId === centralId)!;
  centralTillId = centralTill.id;
  centralTillName = centralTill.name;
  chalongTillId = tills.find((s) => s.branchId === chalongId)!.id;

  const [who] = await ctx.db
    .select({ id: account.id, name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(eq(account.phone, RECEPTION.phone))
    .limit(1);
  receptionAccountId = who!.id;
  receptionStaffName = who!.nickname ?? who!.name!;

  som = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  dao = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);

  const catalog = await call('GET', `/public/branches/${CENTRAL_BRANCH_CODE}/catalog`);
  packageId = (catalog.body.packages as Array<{ id: string }>)[0]!.id;

  const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, centralTill.boxId!)).limit(1);
  centralBox = {
    boxId: boxRow!.id,
    operatorId: boxRow!.operatorId,
    branchId: boxRow!.branchId,
    name: boxRow!.name,
    slot: boxRow!.slot,
    role: boxRow!.role,
    status: boxRow!.status,
    currentEpoch: boxRow!.currentEpoch,
    syncPublicKey: boxRow!.syncPublicKey,
    lastStatus: boxRow!.lastStatus as Record<string, unknown> | null,
  };
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// ---------------------------------------------------------------------------

describe('SCRUM-234 — the till reads the booking the booking site wrote', () => {
  it('by its reference, with the money and the lines the public route computed', async () => {
    const made = await bookOnline({ phone: '0812223344', kids: 2, adults: 1 });

    const res = await call('GET', `/bookings/by-reference/${made.reference}`, { cookie: som });
    expect(res.statusCode).toBe(200);
    const found = res.body as unknown as BookingView;
    expect(found.id).toBe(made.id);
    expect(found.branchId).toBe(centralId);
    expect(found.branchName).toBe(centralName);
    expect(found.status).toBe('paid');
    expect(found.tier).toBe('tourist');
    expect(found.parentName).toBe('Khun Ploy');
    expect(found.redemption).toBeNull();
    // The money is the server's, carried through unchanged: nothing here
    // re-prices, and a figure that drifted would mean the till was quoting.
    expect(found.totalSatang).toBe(made.totalSatang);
    // The till rebuilds its cart from these, so every field it reads is here
    // and none of them is null: `toPosBooking` sums kids and adults for the
    // wristband counts and converts `lineTotalSatang` to baht.
    expect(found.lines).toHaveLength(1);
    expect(found.lines[0]).toMatchObject({ packageId, kids: 2, adults: 1 });
    expect(typeof found.lines[0]!.lineTotalSatang).toBe('number');
    expect(typeof found.lines[0]!.name).toBe('string');
  });

  /**
   * The contract itself, compared mechanically rather than by eye.
   *
   * `PlatformBooking` and `PlatformBookingLine` in `apps/pos/src/api/
   * bookings.ts` are what the till reads; a field renamed or dropped on this
   * side arrives there as `undefined` and shows up at a counter as a blank
   * summary. This is the one assertion that fails in CI instead.
   */
  it('answers exactly the fields the till declares, and no others', async () => {
    const made = await bookOnline({ phone: '0812223399', kids: 1, adults: 1 });
    const res = await call('GET', `/bookings/by-reference/${made.reference}`, { cookie: som });
    const found = res.body as unknown as BookingView;
    expect(Object.keys(found).sort()).toEqual(
      [
        'bookingDate',
        'branchId',
        'branchName',
        'createdAt',
        'id',
        'lines',
        'memberId',
        'parentName',
        'paymentMethod',
        'phone',
        'rateMode',
        'redemption',
        'reference',
        'status',
        'tier',
        'totalSatang',
      ].sort(),
    );
    expect(Object.keys(found.lines[0]!).sort()).toEqual(
      [
        'adultUnitSatang',
        'adults',
        'adultsFree',
        'kidUnitSatang',
        'kids',
        'lineTotalSatang',
        'name',
        'packageId',
      ].sort(),
    );

    const redeemed = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId },
    });
    const redemption = (redeemed.body.booking as BookingView).redemption!;
    expect(Object.keys(redemption).sort()).toEqual(
      ['at', 'bandCodes', 'branchName', 'staffName', 'stationName'].sort(),
    );
  });

  it('however reception types the reference', async () => {
    const made = await bookOnline({ phone: '0812223355', kids: 1, adults: 1 });
    const typed = encodeURIComponent(`  ${made.reference.toLowerCase()} `);
    const res = await call('GET', `/bookings/by-reference/${typed}`, { cookie: som });
    expect((res.body as unknown as BookingView).id).toBe(made.id);
  });

  it('a reference nobody has heard of is our own 404, not Fastify’s', async () => {
    const res = await call('GET', '/bookings/by-reference/OTO-9999-9999', { cookie: som });
    expect(res.statusCode).toBe(404);
    // The till tells "no such booking" from "this deployment has no such
    // route" by the code: `isMissingRoute` reads a 404 carrying UNKNOWN as an
    // undeployed route, and telling reception that would send them to the
    // wrong person.
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });

  it('lists what is waiting at this branch, newest first, in the same shape', async () => {
    const made = await bookOnline({ phone: '0812223377', kids: 1, adults: 1 });
    const res = await call('GET', `/bookings?branchId=${centralId}&status=paid&limit=25`, {
      cookie: som,
    });
    expect(res.statusCode).toBe(200);
    const row = listed(res).find((b) => b.id === made.id);
    expect(row, 'the booking just made is waiting at reception').toBeTruthy();
    // The modal picks a row straight off this list and shows it without
    // fetching again, so a list row has to carry everything the summary reads.
    expect(row!.lines.length).toBeGreaterThan(0);
    expect(row!.tier).toBe('tourist');
    expect(row!.parentName).toBe('Khun Ploy');
    expect(row!.branchName).toBe(centralName);
    expect(listed(res)[0]!.id).toBe(made.id);
  });

  it('and a redeemed booking is not on the waiting list', async () => {
    const made = await bookOnline({ phone: '0812223388', kids: 1, adults: 0 });
    await call('POST', `/bookings/${made.id}/redeem`, { cookie: som, payload: {} });
    const waiting = await call('GET', `/bookings?branchId=${centralId}&status=paid`, {
      cookie: som,
    });
    expect(listed(waiting).map((b) => b.id)).not.toContain(made.id);
    const done = await call('GET', `/bookings?branchId=${centralId}&status=redeemed`, {
      cookie: som,
    });
    expect(listed(done).map((b) => b.id)).toContain(made.id);
  });

  it('narrows to the number that made the booking, member or not', async () => {
    const stranger = await bookOnline({ phone: '0812223366', kids: 1, adults: 2 });
    // Mali is seeded with +66811111111, so this one links to her member row.
    const known = await bookOnline({ phone: '+66811111111', kids: 1, adults: 1 });

    const byStranger = await call('GET', '/bookings?phone=0812223366', { cookie: som });
    expect(listed(byStranger).map((b) => b.id)).toEqual([stranger.id]);
    // The link this one does NOT have: the number was not registered, so the
    // row carries it in the payload and no member at all. That is the first
    // visit booked online, and the one a member-only lookup would miss.
    expect(listed(byStranger)[0]!.memberId).toBeNull();

    const byMember = await call('GET', '/bookings?phone=0811111111', { cookie: som });
    const hers = listed(byMember).find((b) => b.id === known.id);
    expect(hers, 'a member’s booking, found by the number she typed').toBeTruthy();
    expect(hers!.memberId).toBeTruthy();
  });

  it('a phone that is not a phone matches nothing rather than everything', async () => {
    const res = await call('GET', '/bookings?phone=not-a-number', { cookie: som });
    expect(res.statusCode).toBe(200);
    expect(listed(res)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('SCRUM-234 — redemption happens once', () => {
  it('stamps when, where, by whom, and reads them back by name', async () => {
    const made = await bookOnline({ phone: '0812224400', kids: 2, adults: 1 });
    const before = Date.now();
    const res = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const redeemed = (res.body.booking ?? {}) as BookingView;
    expect(redeemed.status).toBe('redeemed');
    // What reception reads back to a family: names, not ids.
    expect(redeemed.redemption).toMatchObject({
      branchName: centralName,
      stationName: centralTillName,
      staffName: receptionStaffName,
      bandCodes: [],
    });
    expect(new Date(redeemed.redemption!.at).getTime()).toBeGreaterThanOrEqual(before - 1000);

    // The row, not the answer. A response can describe a write that did not
    // commit; this is what the next shift reads. It keeps IDS — a till renamed
    // or a member of staff who leaves must not change the record.
    const stored = await storedRedemption(made.id);
    expect(stored, 'one row in pos.booking_redemption').toMatchObject({
      bookingId: made.id,
      operatorId: (await ctx.db.select().from(booking).where(eq(booking.id, made.id)).limit(1))[0]!
        .operatorId,
      stationId: centralTillId,
      accountId: receptionAccountId,
      branchId: centralId,
      bandCodes: [],
    });
    // The instant is the row's own column, and it is what the wire said.
    expect(stored!.redeemedAt.toISOString()).toBe(redeemed.redemption!.at);

    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, made.id)).limit(1);
    expect(row!.status).toBe('redeemed');
    // Everything the booking site wrote is still there, and the counter added
    // nothing to it: since SCRUM-304 the payload is the booking site's alone.
    expect((row!.payload as { parentName?: string }).parentName).toBe('Khun Ploy');
    expect(await payloadRedemption(made.id)).toBeNull();
    expect(await redeemAuditRows(made.id)).toHaveLength(1);
  });

  it('falls back to the station the session is standing at', async () => {
    const made = await bookOnline({ phone: '0812224455', kids: 1, adults: 0 });
    const picked = await call('PUT', '/me/session/station', {
      cookie: som,
      payload: { stationId: centralTillId },
    });
    expect(picked.statusCode).toBe(200);
    const res = await call('POST', `/bookings/${made.id}/redeem`, { cookie: som, payload: {} });
    expect(res.statusCode).toBe(200);
    expect((res.body.booking as BookingView).redemption!.stationName).toBe(centralTillName);
  });

  it('refuses a station at another park rather than recording it', async () => {
    const made = await bookOnline({ phone: '0812224466', kids: 1, adults: 0 });
    const res = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: chalongTillId },
    });
    expect(res.statusCode).toBe(400);
    // Nothing written: the record of which counter let a family in must not be
    // able to name a till in the other park.
    expect(await storedRedemption(made.id)).toBeNull();
    expect(await redeemAuditRows(made.id)).toHaveLength(0);
  });

  it('refuses the second one by name — when, where and by whom', async () => {
    const made = await bookOnline({ phone: '0812224411', kids: 1, adults: 1 });
    const first = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId, bandCodes: ['B-1111'] },
    });
    expect(first.statusCode).toBe(200);
    const firstAt = (first.body.booking as BookingView).redemption!.at;

    const second = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId, bandCodes: ['B-2222'] },
    });
    expect(second.statusCode).toBe(409);
    const err = errorOf(second);
    expect(err.code).toBe('BOOKING_ALREADY_REDEEMED');
    // `redemptionFromConflict` reads exactly this, and `describeRedemption`
    // turns it into the sentence reception says out loud. A partial answer is
    // read as none, so every field has to be here.
    expect(err.details!.redemption).toMatchObject({
      at: firstAt,
      branchName: centralName,
      stationName: centralTillName,
      staffName: receptionStaffName,
      bandCodes: ['B-1111'],
    });
    // The message carries the same facts for anyone reading the response by
    // hand, with the time in the park's own clock rather than UTC.
    expect(err.message).toContain(made.reference);
    expect(err.message).toContain(centralName);
    expect(err.message).toContain(centralTillName);

    // And nothing moved: the first redemption is still the only one.
    expect(await storedRedemption(made.id)).toMatchObject({ bandCodes: ['B-1111'] });
    expect(await redeemAuditRows(made.id)).toHaveLength(1);
  });

  it('a retry on the same key is a retry, not a second redemption', async () => {
    const made = await bookOnline({ phone: '0812224422', kids: 1, adults: 0 });
    const key = `redeem-${made.id}`;
    const first = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId },
      key,
    });
    expect(first.statusCode).toBe(200);

    const again = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId },
      key,
    });
    // The flaky mall connection this exists for: the till never learned the
    // first answer and sent it again. It gets the stored one, and the counter
    // is not asked to explain a 409 for something that worked.
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await redeemAuditRows(made.id)).toHaveLength(1);
  });

  it('refuses a booking that is not paid', async () => {
    const made = await bookOnline({ phone: '0812224433', kids: 1, adults: 1 });
    await ctx.db.update(booking).set({ status: 'cancelled' }).where(eq(booking.id, made.id));
    const res = await call('POST', `/bookings/${made.id}/redeem`, { cookie: som, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('BOOKING_NOT_REDEEMABLE');
    expect(await redeemAuditRows(made.id)).toHaveLength(0);
  });

  it('a booking that does not exist is a 404, not a write', async () => {
    const res = await call('POST', '/bookings/00000000-0000-7000-8000-000000000000/redeem', {
      cookie: som,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------

/**
 * SCRUM-305 — and the boxes at that park are told.
 *
 * `bookings` has been a cache scope since S2-05, so a box holds today's and
 * tomorrow's arrivals in order to greet a family with no internet. A counter
 * redemption wrote nothing to the change feed, so that copy said "paid" for as
 * long as it stood — and a box that believes a booking unredeemed is a box with
 * no reason to refuse the second family arriving on one payment.
 *
 * Both halves are asserted, and the last assertion is the one that keeps them
 * honest: the delta and the bundle item are compared to each other, because a
 * box learns about a booking through whichever of the two arrives first and the
 * copy it ends up holding must not depend on which.
 */
describe('SCRUM-305 — a box that cached the booking learns it was redeemed', () => {
  /** Where the change feed stands now, so a pull reads this case and no other. */
  async function feedHead(): Promise<number> {
    const [row] = await ctx.db
      .select({ seq: sql<number>`coalesce(max(${syncChange.seq}), 0)::bigint` })
      .from(syncChange);
    return Number(row?.seq ?? 0);
  }

  it('publishes the redemption to its branch, in the shape the bundle carries', async () => {
    const made = await bookOnline({ phone: '0812226600', kids: 1, adults: 1 });
    const from = await feedHead();

    const redeemed = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId, bandCodes: ['B-3030'] },
    });
    expect(redeemed.statusCode, JSON.stringify(redeemed.body)).toBe(200);

    const pulled = await pullChanges(ctx.db, centralBox, {
      cursorSeq: from,
      limit: 100,
      scopes: ['bookings'],
    });
    const delta = pulled.changes.find((c) => c.entityId === made.id);
    expect(delta, 'the boxes holding this booking were never told').toBeTruthy();
    expect(delta!.op).toBe('upsert');
    expect(delta!.entityType).toBe('booking');

    const sent = delta!.payload as {
      status: string;
      reference: string;
      payload: { redemption?: { stationId: string; accountId: string; bandCodes: string[] } };
    };
    expect(sent.status).toBe('redeemed');
    expect(sent.reference).toBe(made.reference);
    // Ids, as the row holds them: a till renamed or a member of staff who
    // leaves must not change what the box was told happened.
    expect(sent.payload.redemption).toMatchObject({
      stationId: centralTillId,
      accountId: receptionAccountId,
      bandCodes: ['B-3030'],
    });
    // And it came from `pos.booking_redemption`, not from the booking's jsonb:
    // since SCRUM-304 nothing writes a redemption block there, so a box that
    // is told one has been told what the table says.
    expect(await payloadRedemption(made.id)).toBeNull();
    expect((await storedRedemption(made.id))!.bandCodes).toEqual(['B-3030']);

    const bundle = await cacheBundle(ctx.db, centralBox, { scopes: ['bookings'] });
    const items = (bundle.scopes.bookings?.items ?? []) as Array<{ id: string }>;
    const item = items.find((b) => b.id === made.id);
    expect(item, 'a box pulling the bundle whole gets the same booking').toBeTruthy();
    // Field for field. One function shapes both, and this is what says so.
    expect(item).toEqual(sent);
  });

  it('a refused redemption publishes nothing', async () => {
    const made = await bookOnline({ phone: '0812226611', kids: 1, adults: 0 });
    const from = await feedHead();
    // The other park's till: refused before anything is written, so there is
    // nothing for a box to be told about.
    const res = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: chalongTillId },
    });
    expect(res.statusCode).toBe(400);
    const pulled = await pullChanges(ctx.db, centralBox, {
      cursorSeq: from,
      limit: 100,
      scopes: ['bookings'],
    });
    expect(pulled.changes.map((c) => c.entityId)).not.toContain(made.id);
  });
});

// ---------------------------------------------------------------------------

/**
 * SCRUM-304 — the redemption moves into a table, and nothing else moves.
 *
 * SCRUM-234 wrote the claim into `booking.payload.redemption` and said in the
 * service what that cost: no foreign keys behind the two ids that say who let a
 * family in, "once" resting entirely on the service taking a row lock, and no
 * way to report on redemptions without reading jsonb. `pos.booking_redemption`
 * is those three sentences withdrawn.
 *
 * The risk in the move is the till, which has not changed and must not have to:
 * `PlatformBooking` and `PlatformRedemption` in `apps/pos/src/api/bookings.ts`
 * are read field by field by `toPosBooking` and `describeRedemption`. So the
 * first test here is a DEEP COMPARE of the whole answer rather than a field
 * check — a renamed key, a dropped field or a null that used to be a string
 * fails here instead of at a counter.
 */
describe('SCRUM-304 — redemption lives in its own table', () => {
  /** The backfill statement, taken out of the committed migration itself. */
  function backfillStatement(): string {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'packages',
      'db',
      'migrations',
      '0018_booking_redemption.sql',
    );
    const chunk = readFileSync(file, 'utf8')
      .split('--> statement-breakpoint')
      .find((s) => s.includes('INSERT INTO "pos"."booking_redemption"'));
    expect(chunk, 'migration 0018 has no backfill in it').toBeTruthy();
    return chunk!;
  }

  it('the redeem answer is the read answer plus a status and a redemption, field for field', async () => {
    const made = await bookOnline({ phone: '0812227700', kids: 2, adults: 1 });
    const before = await call('GET', `/bookings/by-reference/${made.reference}`, { cookie: som });
    const was = before.body as unknown as BookingView;
    expect(was.redemption).toBeNull();

    const res = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId, bandCodes: ['B-4040'] },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const now = res.body.booking as BookingView;
    const stored = await storedRedemption(made.id);

    // Everything the till reads, pinned: the same object it had before the
    // claim, with exactly two things different.
    expect(now).toEqual({
      ...was,
      status: 'redeemed',
      redemption: {
        at: stored!.redeemedAt.toISOString(),
        branchName: centralName,
        stationName: centralTillName,
        staffName: receptionStaffName,
        bandCodes: ['B-4040'],
      },
    });

    // And the same object comes back on the next read, from the table rather
    // than from the transaction that wrote it.
    const again = await call('GET', `/bookings/by-reference/${made.reference}`, { cookie: som });
    expect(again.body).toEqual(now);

    // A list row carries it too: the modal shows a redeemed booking straight
    // off the list without fetching it again.
    const listed = await call('GET', `/bookings?branchId=${centralId}&status=redeemed`, {
      cookie: som,
    });
    const fromList = (listed.body.bookings as BookingView[]).find((b) => b.id === made.id);
    expect(fromList).toEqual(now);
  });

  it('the second claim is refused with what the TABLE holds, not what the jsonb holds', async () => {
    // Paid, and carrying a leftover block of the shape SCRUM-234 used to
    // write. A reader still looking there would answer the counter with this,
    // and the family would be told a time and a place that never happened.
    const made = await plantBooking({
      payloadRedemption: {
        redeemedAt: '2020-01-01T00:00:00.000Z',
        branchId: chalongId,
        stationId: chalongTillId,
        accountId: null,
        bandCodes: ['B-GHOST'],
      },
    });
    const first = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId, bandCodes: ['B-5050'] },
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    // The stale block is not what the first claim answered with either.
    expect((first.body.booking as BookingView).redemption!.bandCodes).toEqual(['B-5050']);

    const second = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId },
    });
    expect(second.statusCode).toBe(409);
    const err = errorOf(second);
    expect(err.code).toBe('BOOKING_ALREADY_REDEEMED');
    const stored = await storedRedemption(made.id);
    expect(err.details!.redemption).toEqual({
      at: stored!.redeemedAt.toISOString(),
      branchName: centralName,
      stationName: centralTillName,
      staffName: receptionStaffName,
      bandCodes: ['B-5050'],
    });
    expect(JSON.stringify(err.details)).not.toContain('B-GHOST');
    // Still one redemption, and the refused claim wrote nothing.
    expect(await redemptionRows(made.id)).toHaveLength(1);
    expect(await redeemAuditRows(made.id)).toHaveLength(1);
  });

  it('a box is told what the table says, and a stale jsonb block does not reach it', async () => {
    // Never redeemed — and carrying exactly the block the old release would
    // have written. The bundle must call this booking unredeemed.
    const made = await plantBooking({
      payloadRedemption: {
        redeemedAt: '2020-01-01T00:00:00.000Z',
        branchId: centralId,
        stationId: centralTillId,
        accountId: receptionAccountId,
        bandCodes: ['B-GHOST'],
      },
    });

    const bundle = await cacheBundle(ctx.db, centralBox, { scopes: ['bookings'] });
    const items = (bundle.scopes.bookings?.items ?? []) as Array<{
      id: string;
      status: string;
      payload: Record<string, unknown> | null;
    }>;
    const item = items.find((b) => b.id === made.id);
    expect(item, 'the booking is in the branch’s cache bundle').toBeTruthy();
    expect(item!.status).toBe('paid');
    expect(item!.payload!.redemption).toBeUndefined();
    // The rest of what the booking site wrote still travels.
    expect(item!.payload!.parentName).toBe('Khun Ploy');

    // Take the stale block away again, so the backfill below meets only the
    // row it plants itself. Nothing in the release writes one any more.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, made.id)).limit(1);
    const payload = { ...(row!.payload as Record<string, unknown>) };
    delete payload.redemption;
    await ctx.db.update(booking).set({ payload }).where(eq(booking.id, made.id));
  });

  it('the migration’s backfill copies a payload redemption into the table', async () => {
    const redeemedAt = new Date('2026-09-01T08:15:00.000Z');
    // A booking as the deployed release left it: redeemed, with the claim in
    // the jsonb and no row in the table. This is what staging holds.
    const made = await plantBooking({
      status: 'redeemed',
      payloadRedemption: {
        redeemedAt: redeemedAt.toISOString(),
        branchId: centralId,
        stationId: centralTillId,
        accountId: receptionAccountId,
        bandCodes: ['B-6060', 'B-6061'],
      },
    });
    expect(await redemptionRows(made.id)).toHaveLength(0);

    await ctx.db.execute(sql.raw(backfillStatement()));

    const stored = await storedRedemption(made.id);
    expect(stored, 'the redemption staging holds was left behind').toBeTruthy();
    expect(stored).toMatchObject({
      operatorId: centralOperatorId,
      branchId: centralId,
      stationId: centralTillId,
      accountId: receptionAccountId,
      bandCodes: ['B-6060', 'B-6061'],
    });
    expect(stored!.redeemedAt.toISOString()).toBe(redeemedAt.toISOString());

    // And the counter reads it back by name, the same as one redeemed today.
    const res = await call('GET', `/bookings/by-reference/${made.reference}`, { cookie: som });
    expect((res.body as unknown as BookingView).redemption).toEqual({
      at: redeemedAt.toISOString(),
      branchName: centralName,
      stationName: centralTillName,
      staffName: receptionStaffName,
      bandCodes: ['B-6060', 'B-6061'],
    });

    // Re-runnable: a migration that is applied twice, or a backfill re-run by
    // hand, must not give one booking two redemptions.
    await ctx.db.execute(sql.raw(backfillStatement()));
    expect(await redemptionRows(made.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('SCRUM-234 — a booking belongs to the park it was booked at', () => {
  it('the other park’s counter cannot find it', async () => {
    const made = await bookOnline({ phone: '0812225500', kids: 1, adults: 1 });

    // Dao is seated at Robinson Chalong and holds branch_manager there, so she
    // holds every permission these routes ask for — at her own park.
    const byReference = await call('GET', `/bookings/by-reference/${made.reference}`, {
      cookie: dao,
    });
    expect(byReference.statusCode).toBe(404);

    const byPhone = await call('GET', '/bookings?phone=0812225500', { cookie: dao });
    expect(listed(byPhone)).toEqual([]);

    const list = await call('GET', '/bookings', { cookie: dao });
    expect(listed(list).map((b) => b.id)).not.toContain(made.id);
  });

  it('and naming Central on the query is refused rather than answered', async () => {
    const list = await call('GET', `/bookings?branchId=${centralId}`, { cookie: dao });
    expect(list.statusCode).toBe(403);
    const one = await call('GET', `/bookings/by-reference/OTO-1234-5678?branchId=${centralId}`, {
      cookie: dao,
    });
    expect(one.statusCode).toBe(403);
  });

  it('and cannot redeem it, though it holds the permission at its own park', async () => {
    const made = await bookOnline({ phone: '0812225511', kids: 1, adults: 1 });
    const res = await call('POST', `/bookings/${made.id}/redeem`, { cookie: dao, payload: {} });
    expect(res.statusCode).toBe(403);

    // Refused before anything was written: the booking is still waiting for
    // the park it was booked at.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, made.id)).limit(1);
    expect(row!.status).toBe('paid');
    expect(await storedRedemption(made.id)).toBeNull();
    expect(await redeemAuditRows(made.id)).toHaveLength(0);
  });

  it('answers nobody without a session', async () => {
    const made = await bookOnline({ phone: '0812225522', kids: 1, adults: 1 });
    for (const url of ['/bookings', `/bookings/by-reference/${made.reference}`]) {
      expect((await call('GET', url)).statusCode).toBe(401);
    }
    const redeem = await call('POST', `/bookings/${made.id}/redeem`, { payload: {} });
    expect(redeem.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------

/**
 * SCRUM-306 — the booking routes ask for booking permissions.
 *
 * SCRUM-234 guarded reading with `pos:visit:read` and redeeming with
 * `pos:voucher:redeem` and said why in the route file: a permission minted on
 * the day its route is written is grantable to nobody until the roles are
 * synced. The pair exists now, `reception` and `branch_manager` carry it, and
 * these are the assertions that say the borrowing is actually over rather than
 * renamed — an account holding EXACTLY what the routes used to ask for is
 * refused by both of them.
 *
 * The bookings here are planted rather than booked: `POST /public/bookings` is
 * rate-limited to twenty a minute from one address and this file has already
 * spent them. Nothing in this section is about how the row was made.
 */
describe('SCRUM-306 — the booking pair is its own permission', () => {
  /** What the two routes used to ask for, and nothing else. */
  const BORROWED: Permission[] = ['pos:visit:read', 'pos:voucher:redeem'];
  const PAIR: Permission[] = ['pos:booking:read', 'pos:booking:redeem'];

  /** Signed in holding the borrowed pair at Central, through an operator role. */
  const BORROWER = { phone: '+66899000306', password: 'borrowed1234' };
  let borrower: string;
  /** The seeded `reception` system role — the rows the sync owns. */
  let receptionRoleId: string;

  /** The permissions one role carries, as the database holds them. */
  const bundleRows = async (roleId: string): Promise<string[]> => {
    const rows = await ctx.db
      .select({ permission: rolePermission.permission })
      .from(rolePermission)
      .where(eq(rolePermission.roleId, roleId));
    return rows.map((r) => r.permission).sort();
  };

  beforeAll(async () => {
    const roleId = newId();
    await ctx.db
      .insert(role)
      .values({ id: roleId, operatorId: centralOperatorId, name: 'arrivals desk', isSystem: false });
    for (const permission of BORROWED) {
      await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission });
    }

    const accountId = newId();
    await ctx.db.insert(account).values({
      id: accountId,
      operatorId: centralOperatorId,
      phone: BORROWER.phone,
      passwordHash: await hash(BORROWER.password),
      phoneVerifiedAt: new Date(),
      status: 'active',
    });
    await ctx.db.insert(roleAssignment).values({
      id: newId(),
      accountId,
      roleId,
      scopeType: 'branch',
      scopeId: centralId,
    });

    borrower = await signInAs(ctx.app, BORROWER.phone, BORROWER.password);
    const moved = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/branch',
      headers: { cookie: borrower },
      payload: { branchId: centralId },
    });
    expect(moved.statusCode).toBe(200);

    const [rec] = await ctx.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.name, 'reception'), isNull(role.operatorId)))
      .limit(1);
    receptionRoleId = rec!.id;
    expect(await bundleRows(receptionRoleId)).toEqual(expect.arrayContaining(PAIR));
  });

  it('refuses the waiting list to an account holding only the old read permission', async () => {
    const made = await plantBooking({});
    const list = await call('GET', `/bookings?branchId=${centralId}`, { cookie: borrower });
    expect(list.statusCode).toBe(403);
    // A reference that really is at this branch, so the refusal is the guard's
    // and not a 404 wearing its clothes.
    const one = await call('GET', `/bookings/by-reference/${made.reference}?branchId=${centralId}`, {
      cookie: borrower,
    });
    expect(one.statusCode).toBe(403);
  });

  it('refuses the claim to an account holding only pos:voucher:redeem, and writes nothing', async () => {
    const made = await plantBooking({});
    const res = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: borrower,
      payload: { stationId: centralTillId },
    });
    expect(res.statusCode).toBe(403);
    expect(await storedRedemption(made.id)).toBeNull();
    expect(await redeemAuditRows(made.id)).toHaveLength(0);
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, made.id)).limit(1);
    expect(row!.status).toBe('paid');

    // And it is still there for somebody who holds the pair: reception, as the
    // seed grants it, redeems the same booking.
    const ok = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId },
    });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body.booking as BookingView).status).toBe('redeemed');
  });

  it('reception holds both at its own branch, and the resolver says so', async () => {
    const res = await call('GET', '/me/permissions', { cookie: som });
    expect(res.statusCode).toBe(200);
    const effective = res.body.permissions as Array<{
      permission: string;
      scopeType: string;
      scopeId: string | null;
    }>;
    for (const permission of PAIR) {
      expect(
        effective.some(
          (p) => p.permission === permission && p.scopeType === 'branch' && p.scopeId === centralId,
        ),
        `reception holds ${permission} at Central`,
      ).toBe(true);
    }
  });

  it('a branch manager lists and redeems at the park she manages', async () => {
    const made = await plantBooking({ branchId: chalongId });
    const list = await call('GET', `/bookings?branchId=${chalongId}`, { cookie: dao });
    expect(list.statusCode).toBe(200);
    expect(listed(list).map((b) => b.id)).toContain(made.id);

    const res = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: dao,
      payload: { stationId: chalongTillId },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body.booking as BookingView).status).toBe('redeemed');
  });

  /**
   * The deployment hazard the ticket is about, driven rather than argued: the
   * routes are only as good as the rows the sync writes. Staging runs
   * `platformSync` as its pre-deploy step, so this is that step, against a real
   * database, proving the reception role comes back holding exactly the two.
   */
  it('the sync is what grants them — removed, reception is refused; re-synced, it is not', async () => {
    const made = await plantBooking({});
    const before = await bundleRows(receptionRoleId);

    await ctx.db
      .delete(rolePermission)
      .where(
        and(eq(rolePermission.roleId, receptionRoleId), inArray(rolePermission.permission, PAIR)),
      );
    const without = await bundleRows(receptionRoleId);
    expect(without).toHaveLength(before.length - 2);

    const refusedList = await call('GET', `/bookings?branchId=${centralId}`, { cookie: som });
    expect(refusedList.statusCode).toBe(403);
    const refusedClaim = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId },
    });
    expect(refusedClaim.statusCode).toBe(403);
    expect(await storedRedemption(made.id)).toBeNull();

    await platformSync(ctx.db);

    const after = await bundleRows(receptionRoleId);
    expect(after).toHaveLength(without.length + 2);
    // Exactly the two, and nothing else moved in the bundle.
    expect(after).toEqual(before);

    const ok = await call('POST', `/bookings/${made.id}/redeem`, {
      cookie: som,
      payload: { stationId: centralTillId },
    });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  });
});
