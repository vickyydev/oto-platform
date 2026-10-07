import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  account,
  attendee,
  booking,
  bookingRedemption,
  branch,
  employee,
  kioskSession,
  member,
  paymentAttempt,
  station,
} from '@oto/db';
import {
  BookingSupervisionSnapshotSchema,
  bookingEventPassesOf,
  isoDateInTz,
  newId,
  parseBookingQr,
  wallClockMinutesInTz,
  type BookingEventPass,
  type BookingSupervisionSnapshot,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { audit } from './audit';
import { bookingChange, recordChange } from './sync';
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
 * **Redemption has its own table** — `pos.booking_redemption`, SCRUM-304.
 * `booking.status` still carries the state, and when, where, by whom and which
 * bands went out are a row with foreign keys and a unique on the booking. This
 * paragraph used to say the opposite and say why: SCRUM-234 had no migration in
 * it, so the claim went into `booking.payload.redemption` and the cost was
 * written down rather than hidden. All three parts of that cost are now paid —
 * the ids are constrained, "once" is a unique index rather than a promise the
 * service keeps, and a report can ask which till redeemed what without reading
 * jsonb.
 *
 * Nothing about the WIRE changed with it. The till's `PlatformBooking` and
 * `PlatformRedemption` (`apps/pos/src/api/bookings.ts`) are the same fields in
 * the same shape; only where they are read from moved. The old payload blocks
 * are left where they are — the migration copies them into the table and
 * deletes nothing — but nothing here reads them any more, so the table is the
 * one answer to "was this redeemed".
 */

export type BookingRow = typeof booking.$inferSelect;
export type AttendeeRow = typeof attendee.$inferSelect;
export type BookingRedemptionRow = typeof bookingRedemption.$inferSelect;

/** How many bookings one list may answer with. */
export const BOOKING_PAGE_MAX = 100;
export const BOOKING_PAGE_DEFAULT = 25;

/** A booking a counter may still act on. Anything else is history. */
export const REDEEMABLE_STATUS = 'paid';
export const REDEEMED_STATUS = 'redeemed';
/**
 * Every word `pos.booking_status_check` allows (S2-12). `pending` is a booking
 * written by the site and not yet paid; `expired` one whose hold ran out
 * unpaid; `cancelled` one whose payment failed. None of the three is redeemable.
 */
export const BOOKING_STATUSES = ['paid', 'redeemed', 'pending', 'expired', 'cancelled'] as const;

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

/** The redemption row as the rest of this file speaks of it. */
export function storedRedemptionOf(row: BookingRedemptionRow): StoredRedemption {
  return {
    redeemedAt: row.redeemedAt.toISOString(),
    branchId: row.branchId,
    stationId: row.stationId,
    accountId: row.accountId,
    bandCodes: stringsIn(row.bandCodes),
  };
}

/**
 * The redemptions of a set of bookings, keyed by booking id — one query for a
 * whole list rather than one per row.
 *
 * A booking with no entry here has not been redeemed. That is the whole of the
 * question now: the payload blocks SCRUM-234 wrote are still in the rows and
 * are deliberately not consulted, because two places to look is how a booking
 * comes to be redeemed in one of them and not the other.
 */
export async function loadRedemptions(
  exec: Exec,
  bookingIds: string[],
): Promise<Map<string, StoredRedemption>> {
  const found = new Map<string, StoredRedemption>();
  if (bookingIds.length === 0) return found;
  const rows = await exec
    .select()
    .from(bookingRedemption)
    .where(inArray(bookingRedemption.bookingId, bookingIds));
  for (const row of rows) found.set(row.bookingId, storedRedemptionOf(row));
  return found;
}

// --- What goes on the wire ---------------------------------------------------

/** One priced line as `POST /public/bookings` computed and stored it. */
export interface BookingLineView {
  supervision?: BookingSupervisionSnapshot;
  packageId: string;
  /** The package name frozen at booking time. */
  name: string;
  kids: number;
  adults: number;
  kidUnitSatang: number;
  adultsFree: number;
  adultUnitSatang: number;
  /**
   * S2-12 — the socks and extras the family paid for online, so reception is
   * told to hand them over. Zero and empty on a booking written before the
   * booking site priced them.
   */
  socks: number;
  socksUnitSatang: number;
  addOns: BookingLineAddOnView[];
  lineTotalSatang: number;
}

/** One extra on a booking line: what it was, how many, at the price it was paid at. */
export interface BookingLineAddOnView {
  productId: string;
  name: string;
  unitSatang: number;
  quantity: number;
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
  registrationId?: string;
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
  /** The verified paid attempt method, with the recorded payload for box reads. */
  paymentMethod: string | null;
  lines: BookingLineView[];
  /**
   * S2-20 E5 — the event passes the booking paid for (consistency #21): the
   * counter's redeem dialog names them, and redeeming checks them in.
   */
  eventPasses: BookingEventPass[];
  redemption: RedemptionView | null;
}

export function linesOf(row: BookingRow): BookingLineView[] {
  const raw = payloadOf(row).lines;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const bag = entry as Record<string, unknown>;
    const child = BookingSupervisionSnapshotSchema.safeParse(bag.supervision);
    return [
      {
        packageId: stringOrNull(bag.packageId) ?? '',
        name: stringOrNull(bag.name) ?? '',
        kids: numberOr(bag.kids, 0),
        adults: numberOr(bag.adults, 0),
        kidUnitSatang: numberOr(bag.kidUnitSatang, 0),
        adultsFree: numberOr(bag.adultsFree, 0),
        adultUnitSatang: numberOr(bag.adultUnitSatang, 0),
        socks: numberOr(bag.socks, 0),
        socksUnitSatang: numberOr(bag.socksUnitSatang, 0),
        addOns: addOnsOf(bag.addOns),
        lineTotalSatang: numberOr(bag.lineTotalSatang, 0),
        ...(child.success ? { supervision: child.data } : {}),
      },
    ];
  });
}

/** The extras a stored line carries (`QuotedLine.addOns`), skipping anything not that shape. */
function addOnsOf(raw: unknown): BookingLineAddOnView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const bag = entry as Record<string, unknown>;
    const quantity = numberOr(bag.quantity, 0);
    if (quantity <= 0) return [];
    return [
      {
        productId: stringOrNull(bag.productId) ?? stringOrNull(bag.id) ?? '',
        name: stringOrNull(bag.name) ?? '',
        unitSatang: numberOr(bag.unitSatang, 0),
        quantity,
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
 * Everything one batch of bookings is read back with: their redemptions, and
 * the names those redemptions carry.
 *
 * One object rather than two arguments because the two are fetched together and
 * the names depend on the redemptions — a station is only looked up because a
 * redemption named it.
 */
export interface BookingReadModel {
  /** Keyed by booking id. Absent means "not redeemed". */
  redemptions: Map<string, StoredRedemption>;
  names: NameBook;
  paymentMethods?: Map<string, string | null>;
}

const EMPTY_READ: BookingReadModel = { redemptions: new Map(), names: EMPTY_NAMES };

/**
 * Resolve every name a set of bookings will be read back with, in three
 * queries rather than three per row.
 */
export async function namesFor(
  exec: Exec,
  rows: BookingRow[],
  redemptions: Map<string, StoredRedemption>,
): Promise<NameBook> {
  const branchIds = new Set<string>();
  const stationIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const row of rows) {
    branchIds.add(row.branchId);
    const redemption = redemptions.get(row.id);
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

/**
 * The redemptions of a set of bookings and the names they read back with —
 * what every read here answers through.
 */
export async function readBookings(exec: Exec, rows: BookingRow[]): Promise<BookingReadModel> {
  if (rows.length === 0) return EMPTY_READ;
  const redemptions = await loadRedemptions(
    exec,
    rows.map((row) => row.id),
  );
  const ids = rows.flatMap((row) => row.paymentAttemptId ? [row.paymentAttemptId] : []);
  const paid = ids.length ? await exec.select({ id: paymentAttempt.id, method: paymentAttempt.methodCode }).from(paymentAttempt)
    .where(and(inArray(paymentAttempt.id, ids), eq(paymentAttempt.status, 'approved'))) : [];
  const paymentMethods = new Map(paid.map((attempt) => [attempt.id, attempt.method]));
  return { redemptions, names: await namesFor(exec, rows, redemptions), paymentMethods };
}

export function bookingView(row: BookingRow, read: BookingReadModel = EMPTY_READ): BookingView {
  const payload = payloadOf(row);
  const stored = read.redemptions.get(row.id) ?? null;
  const names = read.names;
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
    ...(typeof payload.registrationId === 'string' ? { registrationId: payload.registrationId } : {}),
    paymentMethod: (row.paymentAttemptId ? read.paymentMethods?.get(row.paymentAttemptId) : null) ?? stringOrNull(payload.paymentMethod),
    lines: linesOf(row),
    eventPasses: bookingEventPassesOf(payload),
    redemption: stored ? redemptionView(stored, names) : null,
  };
}

/** Rows, their redemptions and their names together, which is how every read here answers. */
export async function viewBookings(exec: Exec, rows: BookingRow[]): Promise<BookingView[]> {
  if (rows.length === 0) return [];
  const read = await readBookings(exec, rows);
  return rows.map((row) => bookingView(row, read));
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

/** The code a booking QR the park did not sign is refused with — the box's own name for it. */
export const BOOKING_QR_SIGNATURE_INVALID = 'BOOKING_QR_SIGNATURE_INVALID';

/**
 * A booking QR the till read itself — a USB scanner or the typed field — checked
 * on the platform before anything opens (S2-12 round 3 fix: a tampered code
 * opened the redeem dialog because the till only parsed its shape).
 *
 * The signature is compared with the one the platform STORED when the booking
 * was paid (`booking.qr_signature`, `booking-payment.ts`), not recomputed: the
 * stored one is the QR the family was actually given, so a later key rotation
 * does not strand it, and a booking never paid has none and opens nothing.
 * Every refusal after the shape check is the same answer — an unknown booking,
 * an unsigned one and a wrong signature are all "not a booking this park
 * issued" — so the route is not a way to probe which ids exist.
 *
 * The comparison runs over every character whatever the first difference.
 */
export async function loadBookingByQr(
  exec: Exec,
  operatorId: string,
  code: string,
): Promise<BookingRow> {
  const parsed = parseBookingQr(code);
  if (!parsed) throw errors.badRequest('That is not a booking QR.');
  const row = await loadBookingForOperator(exec, operatorId, parsed.bookingId);
  const stored = row?.qrSignature ?? '';
  let difference = stored.length === parsed.signature.length ? 0 : 1;
  for (let i = 0; i < parsed.signature.length; i += 1) {
    difference |= (stored.charCodeAt(i) || 0) ^ parsed.signature.charCodeAt(i);
  }
  if (!row || difference !== 0) {
    throw new AppError(422, BOOKING_QR_SIGNATURE_INVALID, 'Not a booking QR this park issued. Look the booking up by its reference instead.');
  }
  return row;
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
 *
 * Read from `pos.booking_redemption`, which is where the first claim wrote it
 * (SCRUM-304). A redeemed booking with no row there answers with the facts it
 * has — the reference and the refusal — rather than inventing a time.
 */
async function alreadyRedeemed(exec: Exec, row: BookingRow): Promise<AppError> {
  const read = await readBookings(exec, [row]);
  const stored = read.redemptions.get(row.id) ?? null;
  const view = stored ? redemptionView(stored, read.names) : null;
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
  /**
   * Who claimed it. Null when nobody was signed in — the self-service kiosk
   * (S2-20 K1), whose credential the redemption's sale names instead; the
   * claim row then names the kiosk's station and no account.
   */
  actorAccountId: string | null;
  /** The station the till is standing at, already checked to be at this branch. */
  stationId: string | null;
  /**
   * Bands handed over, where the surface minting them cannot ask first — the
   * offline box. The counter claims BEFORE it mints, so it sends none.
   */
  bandCodes: string[];
  requestId?: string | null;
  now?: Date;
  /**
   * S2-12 round 3 — leave the box delta to the caller, which publishes it once
   * the bands it mints in the same transaction are on the redemption row.
   */
  deferPublish?: boolean;
  /**
   * SCRUM-504 — how long to wait behind another claim holding the booking's
   * row before answering `BOOKING_REDEMPTION_IN_PROGRESS` instead. Unset: wait
   * as long as the statement may (the box's replay of an offline redemption).
   * The counter and the kiosk set it (`BOOKING_CLAIM_WAIT_MS`): a self-service
   * kiosk holds the row while its bands print, which may outlast the
   * statement timeout, and a person at a till is owed an answer, not a 500.
   */
  claimWaitMs?: number;
}

/** SCRUM-504 — the counter's and the kiosk's bound on waiting behind another claim on the same booking. */
export const BOOKING_CLAIM_WAIT_MS = 5_000;

/**
 * How far back a kiosk press can have started and still be running: the
 * guest's idle minute on the scan screen, the print's budget, and room to
 * spare. A press older than this was left open by a stopped process.
 */
const CLAIM_PRESS_WINDOW_MS = 5 * 60 * 1000;

/**
 * Take the booking's row lock, waiting at most `waitMs` behind another claim.
 *
 * The bound is the STATEMENT's (`statement_timeout`), not `lock_timeout`:
 * Postgres times each lock acquisition separately, and a claim queued behind
 * another waiting claim takes two in turn (the row's tuple lock, then the
 * holder's transaction), so a lock timeout of five seconds is ten for the
 * second in line and more for the third. It is set for this statement alone,
 * inside a savepoint, and put back as it was: everything else the caller's
 * transaction does keeps its own limits. A wait that runs out rolls the
 * savepoint back (the caller's transaction stays usable) and answers who
 * holds the booking, read from the claim a kiosk press writes before it locks
 * (`kiosk_session.booking_id` on a press still running) — a plain read,
 * which no row lock blocks.
 *
 * `FOR NO KEY UPDATE`, the strength Postgres's own update of a non-key column
 * takes: two claims still queue on it, and so does every `FOR UPDATE` and
 * `FOR SHARE` elsewhere, but a row that merely REFERENCES the booking (a
 * foreign-key check's `FOR KEY SHARE`) is not held up behind a kiosk that
 * keeps its claim open while its bands print — the second kiosk's own
 * session row naming the booking, its failed ending, a payment attempt.
 */
async function lockForClaim(tx: Tx, args: RedeemBookingArgs, waitMs: number): Promise<BookingRow | undefined> {
  const prior = (await tx.execute(sql`select current_setting('statement_timeout') as v`)).rows[0] as { v: string };
  try {
    return await tx.transaction(async (sp) => {
      await sp.execute(sql`select set_config('statement_timeout', ${`${Math.max(1, Math.round(waitMs))}ms`}, true)`);
      const [row] = await sp
        .select()
        .from(booking)
        .where(and(eq(booking.id, args.bookingId), eq(booking.operatorId, args.operatorId)))
        .for('no key update')
        .limit(1);
      await sp.execute(sql`select set_config('statement_timeout', ${prior.v}, true)`);
      return row;
    });
  } catch (err) {
    // 57014: this statement's own bound ran out; 55P03: a lock timeout the role or caller set.
    const code = pgErrorOf(err)?.code;
    if (code !== '57014' && code !== '55P03') throw err;
    throw await claimInProgress(tx, args);
  }
}

/**
 * When a kiosk press arrived: `detail.pressedAt` on a session the guest opened
 * before they scanned (S2-20 K2), else the session's start, which is the press.
 * Here rather than in `services/kiosk.ts`, which imports this module and reads
 * a press's age the same way.
 */
export function kioskPressedAtOf(row: { startedAt: Date; detail: unknown }): Date {
  const pressed = (row.detail as { pressedAt?: unknown } | null)?.pressedAt;
  if (typeof pressed === 'string') {
    const at = new Date(pressed);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return row.startedAt;
}

/**
 * The refusal for a booking another claim holds right now: by name, so the
 * person at the till knows to wait or walk over, rather than a timeout.
 * Nothing about that claim is known to have finished, so the booking is
 * neither redeemed nor refused here — the next try reads how it ended.
 */
async function claimInProgress(exec: Exec, args: RedeemBookingArgs): Promise<AppError> {
  const [row] = await exec
    .select({ reference: booking.reference })
    .from(booking)
    .where(and(eq(booking.id, args.bookingId), eq(booking.operatorId, args.operatorId)))
    .limit(1);
  // The press that arrived first among those still running on this booking is
  // the one that took the lock first: the others queued behind it, as this
  // claim did. Ordered by when the PRESS arrived (`detail.pressedAt`), not by
  // when the session started — since K2 a session starts when the guest first
  // touches the screen, so a guest who touched first and pressed second is
  // waiting, not holding. A press left open by a stopped process is long past
  // the window.
  const since = Date.now() - CLAIM_PRESS_WINDOW_MS;
  const running = await exec
    .select({ stationName: station.name, startedAt: kioskSession.startedAt, detail: kioskSession.detail })
    .from(kioskSession)
    .innerJoin(station, eq(station.id, kioskSession.stationId))
    .where(
      and(
        eq(kioskSession.bookingId, args.bookingId),
        eq(kioskSession.operatorId, args.operatorId),
        isNull(kioskSession.outcome),
        isNotNull(kioskSession.actionId),
      ),
    );
  const [press] = running
    .map((p) => ({ stationName: p.stationName, pressedAt: kioskPressedAtOf(p).getTime() }))
    .filter((p) => p.pressedAt > since)
    .sort((a, b) => a.pressedAt - b.pressedAt);
  const reference = row?.reference ?? 'This booking';
  return errors.conflict(
    'BOOKING_REDEMPTION_IN_PROGRESS',
    press
      ? `${reference} is being redeemed right now at ${press.stationName} — its wristbands are printing. Nothing was issued here: try again in a moment.`
      : `${reference} is being redeemed right now at another counter. Nothing was issued here: try again in a moment.`,
    { reference: row?.reference ?? null, stationName: press?.stationName ?? null },
  );
}

/**
 * Redeem a booking once.
 *
 * Two things make "once" true rather than likely: the row is taken `FOR
 * UPDATE` (`FOR NO KEY UPDATE` with a bounded wait, `claimWaitMs`, SCRUM-504),
 * so a second request on another connection waits and then reads the
 * redeemed row rather than the paid one it started from; and the update itself
 * still carries `status = 'paid'` in its predicate, so if that lock is ever
 * lost — a future caller that reads the row some other way — the write applies
 * to nothing and this throws rather than overwriting the first redemption. The
 * audit row is written with the same handle, so it commits with the change or
 * not at all.
 *
 * Since SCRUM-304 there is a third: the redemption is a row in
 * `pos.booking_redemption` with a unique on `booking_id`, written in this same
 * transaction. Where the first two are the service keeping a promise, that one
 * is the database refusing — so a second claim through a path that never took
 * the lock is a constraint violation rather than a second family through the
 * gate.
 */
export async function redeemBooking(tx: Tx, args: RedeemBookingArgs): Promise<BookingRow> {
  const [row] =
    args.claimWaitMs !== undefined
      ? [await lockForClaim(tx, args, args.claimWaitMs)]
      : await tx
          .select()
          .from(booking)
          .where(and(eq(booking.id, args.bookingId), eq(booking.operatorId, args.operatorId)))
          .for('update')
          .limit(1);
  if (!row) throw errors.notFound('Booking not found');
  if (row.status === REDEEMED_STATUS) throw await alreadyRedeemed(tx, row);
  if (row.status !== REDEEMABLE_STATUS) {
    /**
     * S2-12 — "booking not paid", in those words (the acceptance's own). Since
     * the booking site stopped writing `paid` on its own say-so, a booking
     * reaches a counter `pending`, `expired` or `cancelled` whenever the
     * gateway never confirmed the money — and the person at the counter has to
     * be told that plainly, not that a status word is wrong.
     */
    throw errors.conflict(
      'BOOKING_NOT_REDEEMABLE',
      `Booking ${row.reference}: booking not paid. It is ${row.status}, so it cannot be redeemed at the counter.`,
      { reference: row.reference, status: row.status, reason: 'not_paid' },
    );
  }

  const now = args.now ?? new Date();
  const updated = await tx
    .update(booking)
    .set({ status: REDEEMED_STATUS })
    .where(and(eq(booking.id, row.id), eq(booking.status, REDEEMABLE_STATUS)))
    .returning();
  const after = updated[0];
  if (!after) throw await alreadyRedeemed(tx, row);

  /**
   * The redemption itself, beside the status and inside the same transaction.
   *
   * The payload is no longer touched: `booking.payload` is what the booking
   * site wrote and priced, and a counter now adds nothing to it. The blocks
   * written before SCRUM-304 stay in the rows they are in — migration 0018
   * copies them here and deletes nothing — and nothing reads them.
   */
  const inserted = await tx
    .insert(bookingRedemption)
    .values({
      id: newId(),
      operatorId: row.operatorId,
      branchId: row.branchId,
      bookingId: row.id,
      stationId: args.stationId,
      accountId: args.actorAccountId,
      redeemedAt: now,
      bandCodes: args.bandCodes,
    })
    .returning();
  const stored = storedRedemptionOf(inserted[0]!);

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

  /**
   * Tell the boxes at this branch (SCRUM-305).
   *
   * `bookings` has been a cache scope since S2-05, so a box holds the arrivals
   * for today and tomorrow in order to greet a family with no internet — and
   * nothing here published the redemption. That box went on believing the
   * booking unredeemed for as long as its copy stood, which is the state in
   * which a second family walks in on one payment and the counter has no reason
   * to refuse them.
   *
   * In the same transaction as the row and the audit line, on the same handle:
   * a delta that committed without the redemption would be a box told the
   * opposite of what happened, and one that was rolled back with it leaves the
   * box exactly where it was — stale, which is what the next bundle repairs.
   *
   * The box-side offline redeem, where two boxes each claim the same booking
   * and the second claim has to be quarantined, is S2-12. This is the half that
   * makes the first one possible: the boxes now know.
   *
   * The redemption is handed to the shaper rather than read back off the row:
   * since SCRUM-304 it is a row of its own, and what a box is told has to be
   * what this transaction wrote.
   */
  if (!args.deferPublish) await publishRedemption(tx, after, stored);
  return after;
}

/**
 * The redemption's delta to the boxes at the booking's branch (SCRUM-305).
 * `redeemBookingAtCounter` defers it until the bands are minted, so a box is
 * told the band codes the counter handed over rather than an empty list.
 */
export async function publishRedemption(
  tx: Tx,
  after: BookingRow,
  stored: StoredRedemption,
): Promise<void> {
  await recordChange(
    tx,
    { operatorId: after.operatorId, branchId: after.branchId },
    {
      scope: 'bookings',
      entityType: 'booking',
      entityId: after.id,
      payload: bookingChange(after, stored),
    },
  );
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
