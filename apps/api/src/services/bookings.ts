import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { account, attendee, booking, branch, employee, member, station } from '@oto/db';
import { isoDateInTz, wallClockMinutesInTz } from '@oto/shared';
import { errors, type AppError } from '../lib/errors';
import { audit } from './audit';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-234 — the counter's half of an online booking.
 *
 * `POST /public/bookings` has written the real `booking` table since S2-12:
 * a reference, a branch, a date, a server-computed total and one `attendee`
 * row per child. Nothing read it. The till's redeem screen called
 * `getAllBookings` and `redeemBooking` in `apps/pos/src/mockApi.ts`, so a
 * family who booked and paid online arrived at a counter that had never heard
 * of them — and the "already redeemed" guard they were refused by lived in a
 * browser tab that forgets everything on reload.
 *
 * Two reads and one write live here:
 *
 *   - list what is waiting at ONE branch, optionally narrowed by the phone
 *     that made the booking;
 *   - fetch one by the reference printed on the customer's QR;
 *   - redeem it: once, at this station, at this moment, by this account.
 *
 * **The wire shape is the till's, not the table's.** `apps/pos/src/api/
 * bookings.ts` states what the counter needs and `apps/pos/src/dev/
 * driveBookingRedemption.ts` drives the till against a stand-in of it, so the
 * view built here answers that contract field for field. The row keeps IDs and
 * the wire carries NAMES: a station is renamed and a person leaves, so what
 * reception reads back to a family has to be resolved when it is read, while
 * the record of who did what stays an id.
 *
 * **Redemption is recorded on the row, not in a new table.** `booking.status`
 * carries the state and `booking.payload.redemption` carries when, where, by
 * whom and which bands went out. A redemption table with its own foreign keys
 * is the better home and it needs a migration; this ticket has none in it, and
 * the jsonb is the shape the row already has. What it costs is queryability —
 * reporting on redemptions means reading jsonb — and that is recorded here
 * rather than hidden.
 */

export type BookingRow = typeof booking.$inferSelect;
export type AttendeeRow = typeof attendee.$inferSelect;

/** How many bookings one list may answer with. */
export const BOOKING_PAGE_MAX = 100;
export const BOOKING_PAGE_DEFAULT = 25;

/** A booking a counter may still act on. Anything else is history. */
export const REDEEMABLE_STATUS = 'paid';
export const REDEEMED_STATUS = 'redeemed';
export const BOOKING_STATUSES = ['paid', 'redeemed', 'pending', 'cancelled'] as const;

// --- What is stored on the row ----------------------------------------------

/**
 * The redemption as the DATABASE holds it: ids, and the instant.
 *
 * Deliberately not names. A till is renamed, a member of staff leaves and is
 * archived, a branch is re-titled — and the record of who let a family through
 * the gate must not change when any of that happens.
 */
export interface StoredRedemption {
  /** ISO instant, UTC. */
  redeemedAt: string;
  branchId: string;
  stationId: string | null;
  accountId: string | null;
  bandCodes: string[];
}

function payloadOf(row: BookingRow): Record<string, unknown> {
  const raw = row.payload;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringsIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The redemption recorded on a row, or null when it has not been redeemed. */
export function storedRedemptionOf(row: BookingRow): StoredRedemption | null {
  const raw = payloadOf(row).redemption;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bag = raw as Record<string, unknown>;
  const redeemedAt = stringOrNull(bag.redeemedAt);
  if (!redeemedAt) return null;
  return {
    redeemedAt,
    branchId: stringOrNull(bag.branchId) ?? row.branchId,
    stationId: stringOrNull(bag.stationId),
    accountId: stringOrNull(bag.accountId),
    bandCodes: stringsIn(bag.bandCodes),
  };
}

// --- What goes on the wire ---------------------------------------------------

/** One priced line as `POST /public/bookings` computed and stored it. */
export interface BookingLineView {
  packageId: string;
  /** The package name frozen at booking time. */
  name: string;
  kids: number;
  adults: number;
  kidUnitSatang: number;
  adultsFree: number;
  adultUnitSatang: number;
  lineTotalSatang: number;
}

/** Where and by whom a redemption happened — what the counter shows on a second scan. */
export interface RedemptionView {
  at: string;
  branchName: string | null;
  stationName: string | null;
  staffName: string | null;
  bandCodes: string[];
}

export interface BookingView {
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
  /** Populated only where the booking site recorded one; payment is S2-10a. */
  paymentMethod: string | null;
  lines: BookingLineView[];
  redemption: RedemptionView | null;
}

function linesOf(row: BookingRow): BookingLineView[] {
  const raw = payloadOf(row).lines;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const bag = entry as Record<string, unknown>;
    return [
      {
        packageId: stringOrNull(bag.packageId) ?? '',
        name: stringOrNull(bag.name) ?? '',
        kids: numberOr(bag.kids, 0),
        adults: numberOr(bag.adults, 0),
        kidUnitSatang: numberOr(bag.kidUnitSatang, 0),
        adultsFree: numberOr(bag.adultsFree, 0),
        adultUnitSatang: numberOr(bag.adultUnitSatang, 0),
        lineTotalSatang: numberOr(bag.lineTotalSatang, 0),
      },
    ];
  });
}

/** The names a stored redemption is read back with, looked up once per request. */
export interface NameBook {
  branches: Map<string, string>;
  stations: Map<string, string>;
  staff: Map<string, string>;
}

const EMPTY_NAMES: NameBook = { branches: new Map(), stations: new Map(), staff: new Map() };

/**
 * Resolve every name a set of bookings will be read back with, in three
 * queries rather than three per row.
 */
export async function namesFor(exec: Exec, rows: BookingRow[]): Promise<NameBook> {
  const branchIds = new Set<string>();
  const stationIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const row of rows) {
    branchIds.add(row.branchId);
    const redemption = storedRedemptionOf(row);
    if (!redemption) continue;
    branchIds.add(redemption.branchId);
    if (redemption.stationId) stationIds.add(redemption.stationId);
    if (redemption.accountId) accountIds.add(redemption.accountId);
  }
  const names: NameBook = { branches: new Map(), stations: new Map(), staff: new Map() };
  if (branchIds.size > 0) {
    const found = await exec
      .select({ id: branch.id, name: branch.name })
      .from(branch)
      .where(inArray(branch.id, [...branchIds]));
    for (const b of found) names.branches.set(b.id, b.name);
  }
  if (stationIds.size > 0) {
    const found = await exec
      .select({ id: station.id, name: station.name })
      .from(station)
      .where(inArray(station.id, [...stationIds]));
    for (const s of found) names.stations.set(s.id, s.name);
  }
  if (accountIds.size > 0) {
    // Through the employee, because an account is a phone and a password and
    // has no name of its own. An account with no employee record stays absent
    // rather than being read back as a blank.
    const found = await exec
      .select({ id: account.id, name: employee.name, nickname: employee.nickname })
      .from(account)
      .leftJoin(employee, eq(account.employeeId, employee.id))
      .where(inArray(account.id, [...accountIds]));
    for (const a of found) {
      const label = a.nickname ?? a.name;
      if (label) names.staff.set(a.id, label);
    }
  }
  return names;
}

export function redemptionView(stored: StoredRedemption, names: NameBook): RedemptionView {
  return {
    at: stored.redeemedAt,
    branchName: names.branches.get(stored.branchId) ?? null,
    stationName: stored.stationId ? (names.stations.get(stored.stationId) ?? null) : null,
    staffName: stored.accountId ? (names.staff.get(stored.accountId) ?? null) : null,
    bandCodes: stored.bandCodes,
  };
}

export function bookingView(row: BookingRow, names: NameBook = EMPTY_NAMES): BookingView {
  const payload = payloadOf(row);
  const stored = storedRedemptionOf(row);
  return {
    id: row.id,
    reference: row.reference,
    branchId: row.branchId,
    branchName: names.branches.get(row.branchId) ?? null,
    memberId: row.memberId,
    bookingDate: row.bookingDate,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    totalSatang: row.totalSatang,
    tier: stringOrNull(payload.tier) ?? '',
    rateMode: stringOrNull(payload.rateMode),
    parentName: stringOrNull(payload.parentName),
    phone: stringOrNull(payload.phone),
    paymentMethod: stringOrNull(payload.paymentMethod),
    lines: linesOf(row),
    redemption: stored ? redemptionView(stored, names) : null,
  };
}

/** Rows and their names together, which is how every read here answers. */
export async function viewBookings(exec: Exec, rows: BookingRow[]): Promise<BookingView[]> {
  if (rows.length === 0) return [];
  const names = await namesFor(exec, rows);
  return rows.map((row) => bookingView(row, names));
}

// --- Reads -------------------------------------------------------------------

/** Typed, trimmed and upper-cased, the way the prototype's lookup box was. */
export function normalizeReference(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * One booking inside the caller's operator, by id.
 *
 * Operator-scoped rather than by id alone: the id is all the caller sends, so
 * this is the only place the tenant can be established, and a route that acts
 * on the row it returns has then established it (SCRUM-290).
 */
export async function loadBookingForOperator(
  exec: Exec,
  operatorId: string,
  id: string,
): Promise<BookingRow | null> {
  const [row] = await exec
    .select()
    .from(booking)
    .where(and(eq(booking.id, id), eq(booking.operatorId, operatorId)))
    .limit(1);
  return row ?? null;
}

export async function loadAttendees(exec: Exec, bookingIds: string[]): Promise<AttendeeRow[]> {
  if (bookingIds.length === 0) return [];
  return exec.select().from(attendee).where(inArray(attendee.bookingId, bookingIds));
}

/** The member id a normalised phone belongs to, inside one operator. */
export async function memberIdForPhone(
  exec: Exec,
  operatorId: string,
  phone: string,
): Promise<string | null> {
  const [row] = await exec
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.operatorId, operatorId), eq(member.phone, phone)))
    .limit(1);
  return row?.id ?? null;
}

export interface FindBookingsArgs {
  operatorId: string;
  /**
   * The branch the booking was made at. Never optional: a reference is eight
   * typed characters, so an unscoped search on one is also a way to read the
   * other park's arrivals by guessing.
   */
  branchId: string;
  reference?: string;
  /** E.164, already normalised by the caller. */
  phone?: string;
  /** Resolved from the phone, so a booking made before the member existed still matches. */
  memberId?: string | null;
  statuses?: string[];
  bookingDate?: string;
  limit?: number;
}

/**
 * Bookings at one branch, newest first — the order the prototype's
 * `getAllBookings` used, which is the order reception is used to reading.
 *
 * The phone match is deliberately two-sided. `POST /public/bookings` links a
 * booking to a member only when that phone was already registered, so a first
 * visit booked online carries the number in its payload and no `member_id` at
 * all — which is exactly the booking whose owner is standing at the counter
 * having never been here before.
 */
export async function findBookings(exec: Exec, args: FindBookingsArgs): Promise<BookingRow[]> {
  const where: SQL[] = [
    eq(booking.operatorId, args.operatorId),
    eq(booking.branchId, args.branchId),
  ];
  if (args.reference) where.push(eq(booking.reference, normalizeReference(args.reference)));
  if (args.bookingDate) where.push(eq(booking.bookingDate, args.bookingDate));
  if (args.statuses && args.statuses.length > 0) {
    where.push(inArray(booking.status, args.statuses));
  }
  if (args.phone) {
    const byPhone = sql`${booking.payload} ->> 'phone' = ${args.phone}`;
    const clause = args.memberId ? or(eq(booking.memberId, args.memberId), byPhone) : byPhone;
    if (clause) where.push(clause);
  }
  return exec
    .select()
    .from(booking)
    .where(and(...where))
    .orderBy(desc(booking.createdAt))
    .limit(Math.min(args.limit ?? BOOKING_PAGE_DEFAULT, BOOKING_PAGE_MAX));
}

// --- The refusal -------------------------------------------------------------

/** `2026-09-22 14:05` in the branch's own timezone, for a message read at a counter. */
function branchWallClock(instant: Date, timeZone: string): string {
  const minutes = wallClockMinutesInTz(instant, timeZone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${isoDateInTz(instant, timeZone)} ${hh}:${mm}`;
}

/**
 * Why a second redemption is refused BY NAME.
 *
 * A booking redeemed twice is two families through the gate on one payment, so
 * the refusal has to tell the person at the counter what already happened —
 * when, at which park, on which till, by whom — or they will assume the system
 * is wrong and wave the second family through. `details.redemption` is the
 * shape `redemptionFromConflict` in `apps/pos/src/api/bookings.ts` reads; the
 * message carries the same facts for anyone reading the response by hand.
 */
async function alreadyRedeemed(exec: Exec, row: BookingRow): Promise<AppError> {
  const stored = storedRedemptionOf(row);
  const names = await namesFor(exec, [row]);
  const view = stored ? redemptionView(stored, names) : null;
  const [br] = await exec
    .select({ timezone: branch.timezone })
    .from(branch)
    .where(eq(branch.id, stored?.branchId ?? row.branchId))
    .limit(1);
  const when =
    view && br ? branchWallClock(new Date(view.at), br.timezone) : (view?.at ?? 'an earlier visit');
  const where = [view?.branchName, view?.stationName, view?.staffName].filter(Boolean).join(', ');
  return errors.conflict(
    'BOOKING_ALREADY_REDEEMED',
    `Booking ${row.reference} was already redeemed on ${when}${where ? ` at ${where}` : ''}.`,
    { reference: row.reference, redemption: view },
  );
}

// --- The write ---------------------------------------------------------------

export interface RedeemBookingArgs {
  bookingId: string;
  operatorId: string;
  actorAccountId: string;
  /** The station the till is standing at, already checked to be at this branch. */
  stationId: string | null;
  /**
   * Bands handed over, where the surface minting them cannot ask first — the
   * offline box. The counter claims BEFORE it mints, so it sends none.
   */
  bandCodes: string[];
  requestId?: string | null;
  now?: Date;
}

/**
 * Redeem a booking once.
 *
 * Two things make "once" true rather than likely: the row is taken `FOR
 * UPDATE`, so a second request on another connection waits and then reads the
 * redeemed row rather than the paid one it started from; and the update itself
 * still carries `status = 'paid'` in its predicate, so if that lock is ever
 * lost — a future caller that reads the row some other way — the write applies
 * to nothing and this throws rather than overwriting the first redemption. The
 * audit row is written with the same handle, so it commits with the change or
 * not at all.
 */
export async function redeemBooking(tx: Tx, args: RedeemBookingArgs): Promise<BookingRow> {
  const [row] = await tx
    .select()
    .from(booking)
    .where(and(eq(booking.id, args.bookingId), eq(booking.operatorId, args.operatorId)))
    .for('update')
    .limit(1);
  if (!row) throw errors.notFound('Booking not found');
  if (row.status === REDEEMED_STATUS) throw await alreadyRedeemed(tx, row);
  if (row.status !== REDEEMABLE_STATUS) {
    throw errors.conflict(
      'BOOKING_NOT_REDEEMABLE',
      `Booking ${row.reference} is ${row.status} and cannot be redeemed at the counter.`,
      { reference: row.reference, status: row.status },
    );
  }

  const now = args.now ?? new Date();
  const stored: StoredRedemption = {
    redeemedAt: now.toISOString(),
    branchId: row.branchId,
    stationId: args.stationId,
    accountId: args.actorAccountId,
    bandCodes: args.bandCodes,
  };
  const updated = await tx
    .update(booking)
    .set({ status: REDEEMED_STATUS, payload: { ...payloadOf(row), redemption: stored } })
    .where(and(eq(booking.id, row.id), eq(booking.status, REDEEMABLE_STATUS)))
    .returning();
  const after = updated[0];
  if (!after) throw await alreadyRedeemed(tx, row);

  await audit.record(tx, {
    actorAccountId: args.actorAccountId,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: 'booking.redeem',
    entityType: 'booking',
    entityId: row.id,
    before: { status: row.status, reference: row.reference },
    after: {
      status: REDEEMED_STATUS,
      reference: row.reference,
      redeemedAt: stored.redeemedAt,
      stationId: stored.stationId,
      bandCodes: stored.bandCodes,
      totalSatang: row.totalSatang,
    },
    requestId: args.requestId ?? null,
  });
  return after;
}

/**
 * The station a redemption may be stamped with: one at the booking's own
 * branch, or none.
 *
 * The till names the station it is holding, and an id from anywhere else is
 * refused rather than recorded — otherwise the record of which counter let a
 * family in could name a till in the other park.
 */
export async function stationAtBranch(
  exec: Exec,
  branchId: string,
  stationId: string,
): Promise<string | null> {
  const [row] = await exec
    .select({ id: station.id })
    .from(station)
    .where(and(eq(station.id, stationId), eq(station.branchId, branchId)))
    .limit(1);
  return row?.id ?? null;
}
