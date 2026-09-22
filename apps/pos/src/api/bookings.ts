import type { Booking, CartLine, SelectedAddOn } from '@/types';
import { getTicketTypes } from '@/store/catalogStore';
import { toBaht } from '@/lib/cartWire';
import { api, ApiError, idemKey } from './client';

/**
 * ONLINE BOOKINGS, FROM THE TILL'S SIDE — SCRUM-234.
 *
 * `POST /public/bookings` has written the real `booking` table since S2-08, and
 * prices it server-side. The counter never read it: `RedeemBookingModal` called
 * `mockApi.getAllBookings` / `getBooking`, and `Till.handleRedeemConfirm` called
 * `mockApi.redeemBooking`, all of which live in the browser tab that made the
 * booking. A family who booked on their phone and walked in was unknown at the
 * desk. This file is the only place the till reads or writes a booking.
 *
 * THE WIRE SHAPE BELOW IS THE CONTRACT the counter needs from `GET /bookings`,
 * `GET /bookings/by-reference/:reference` and `POST /bookings/:id/redeem`. Every
 * field it reads is either a `pos.booking` column or a key `POST /public/bookings`
 * already writes into `payload` (`apps/api/src/routes/public.ts`), so the route
 * is a read over rows that exist.
 *
 * WHAT HAPPENS WHERE THOSE ROUTES ARE NOT DEPLOYED. The screen says the counter
 * cannot reach the booking list and names SCRUM-234. It does NOT fall back to
 * the mock list: a reference that reception can read out and hand wristbands
 * against must come from the row that took the money, and an invented one is
 * worse than an outage a person can act on.
 */

// --- The wire ---------------------------------------------------------------

/** A priced line as `POST /public/bookings` computed and stored it. */
export interface PlatformBookingLine {
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

/** Where and by whom a redemption happened — what the counter has to show on a second scan. */
export interface PlatformRedemption {
  /** ISO timestamp. */
  at: string;
  branchName: string | null;
  stationName: string | null;
  staffName: string | null;
  bandCodes: string[];
}

export interface PlatformBooking {
  id: string;
  reference: string;
  branchId: string;
  branchName: string | null;
  memberId: string | null;
  /** yyyy-mm-dd, the branch-local date the visit is booked for. */
  bookingDate: string;
  /** ISO timestamp — `pos.booking.created_at`, when the family booked. */
  createdAt: string;
  status: string;
  totalSatang: number;
  tier: string;
  rateMode: string | null;
  parentName: string | null;
  phone: string | null;
  /** Populated only where the booking site recorded one; payment is S2-10a. */
  paymentMethod: string | null;
  lines: PlatformBookingLine[];
  redemption: PlatformRedemption | null;
}

export interface BookingRedeemResult {
  booking: PlatformBooking;
}

/** The route's own error code for a second redemption, carrying the first one. */
export const ALREADY_REDEEMED = 'BOOKING_ALREADY_REDEEMED';

/**
 * What the till tells the modal after "Confirm & Issue".
 *
 * Three outcomes, because the counter does three different things with them:
 * close and hand over the bands; show who redeemed it first; or stay on the
 * summary with a reason nothing was issued.
 */
export type RedeemOutcome =
  | { ok: true }
  | { ok: false; redemption: PlatformRedemption }
  | { ok: false; message: string };

export const bookingsApi = {
  /**
   * Paid bookings not yet redeemed, for the branch the till is on. The list the
   * modal shows under "Paid bookings waiting at reception".
   */
  waiting: (branchId: string, limit = 25) =>
    api.get<{ bookings: PlatformBooking[] }>(
      `/bookings?branchId=${encodeURIComponent(branchId)}&status=paid&limit=${limit}`,
    ),

  /** One booking by the reference printed on the customer's QR. 404 when there is none. */
  byReference: (reference: string, branchId?: string) =>
    api.get<PlatformBooking>(
      `/bookings/by-reference/${encodeURIComponent(reference)}` +
        (branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''),
    ),

  /**
   * CLAIM the booking for this station, before anything is minted or printed.
   *
   * The till calls this FIRST and mints wristbands only if it answers. Two
   * counters scanning the same QR at once is a real event at a school-holiday
   * queue, and the losing one must find out before it has printed a band, not
   * after: the server's row is what makes redemption once-only, so it is asked
   * first. Who redeemed it is the session's to record. `bandCodes` is for a
   * surface that mints before it can reach the platform — the offline box —
   * and the counter does not send them, because it has not minted yet.
   *
   * Carries an idempotency key so a retried press of "Confirm & Issue" is the
   * same redemption. A booking already claimed answers 409
   * `BOOKING_ALREADY_REDEEMED`, whose `details.redemption` is the first one —
   * that is the "when and where" the counter reads back to the family.
   */
  redeem: (
    bookingId: string,
    body: { stationId?: string; bandCodes?: string[] },
    key: string,
  ) =>
    api.post<BookingRedeemResult>(`/bookings/${encodeURIComponent(bookingId)}/redeem`, body, {
      idempotencyKey: key,
    }),

  newRedeemKey: idemKey,
};

/**
 * The first redemption carried on a 409, where the route sent one.
 *
 * Returns null when the error is not that, or when it is but the details are not
 * the shape below — a partial answer is not turned into a confident sentence
 * about a time and a branch.
 */
export function redemptionFromConflict(err: unknown): PlatformRedemption | null {
  if (!(err instanceof ApiError) || err.code !== ALREADY_REDEEMED) return null;
  const d = err.details as { redemption?: unknown } | null | undefined;
  const r = d?.redemption as Partial<PlatformRedemption> | undefined;
  if (!r || typeof r.at !== 'string') return null;
  return {
    at: r.at,
    branchName: typeof r.branchName === 'string' ? r.branchName : null,
    stationName: typeof r.stationName === 'string' ? r.stationName : null,
    staffName: typeof r.staffName === 'string' ? r.staffName : null,
    bandCodes: Array.isArray(r.bandCodes) ? r.bandCodes.filter((c): c is string => typeof c === 'string') : [],
  };
}

/** "on 22 Sep 2026, 14:03 at HKT Central (Till 1), by Ploy" — with only the parts we were told. */
export function describeRedemption(r: PlatformRedemption): string {
  const when = new Date(r.at);
  const time = Number.isNaN(when.getTime()) ? r.at : when.toLocaleString();
  const place = r.stationName && r.branchName
    ? `${r.branchName} (${r.stationName})`
    : r.branchName ?? r.stationName;
  return [
    `on ${time}`,
    place ? `at ${place}` : null,
    r.staffName ? `by ${r.staffName}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(' ');
}

// --- Platform shape → the shape the till's redemption flow already speaks ----

/**
 * A line the till could not rebuild, because the package it was sold from is not
 * in this branch's catalogue any more. Named rather than dropped: issuing three
 * wristbands against a booking that paid for four is the failure that matters.
 */
export interface UnmappedLine {
  packageId: string;
  name: string;
  kids: number;
  adults: number;
}

export interface MappedBooking {
  booking: Booking;
  unmapped: UnmappedLine[];
}

/**
 * Rebuild the till's `Booking` from the platform row.
 *
 * WHAT IT CANNOT KNOW, and so does not invent: add-ons, socks, drop-off children,
 * event passes and promo codes are not columns on `pos.booking` and are not
 * priced by `POST /public/bookings` — the booking site records them in its own
 * memory only (`pages/Book.tsx`). They stay empty here, so the summary shows
 * admissions and the money the platform actually took. Drop-off and passes on a
 * booking are S2-13 and S2-20.
 *
 * `willIssue.creditTotalTHB` is 0 for the same reason: the credit a ticket grants
 * is a catalogue rule the sale applies at redemption (`lib/sale.ts`), and stating
 * a figure here that the sale then disagrees with is worse than stating none.
 */
export function toPosBooking(p: PlatformBooking): MappedBooking {
  const catalogue = getTicketTypes();
  const lines: CartLine[] = [];
  const unmapped: UnmappedLine[] = [];
  const noAddOns: SelectedAddOn[] = [];

  for (const line of p.lines) {
    const ticketType = catalogue.find((t) => t.id === line.packageId);
    if (!ticketType) {
      unmapped.push({
        packageId: line.packageId,
        name: line.name,
        kids: line.kids,
        adults: line.adults,
      });
      continue;
    }
    lines.push({
      id: `bk-${p.reference}-${line.packageId}`,
      ticketType,
      tier: p.tier,
      kids: line.kids,
      adults: line.adults,
      socks: 0,
      addOns: noAddOns,
      lineTotal: toBaht(line.lineTotalSatang),
    });
  }

  const childBracelets = p.lines.reduce((s, l) => s + l.kids, 0);
  const adultBracelets = p.lines.reduce((s, l) => s + l.adults, 0);

  return {
    booking: {
      id: p.id,
      reference: p.reference,
      memberId: p.memberId ?? undefined,
      tier: p.tier,
      lines,
      total: toBaht(p.totalSatang),
      // The booking site does not record a tender yet (S2-10a owns that), and
      // the modal's payment row is hidden when this is empty.
      paymentMethod: p.paymentMethod ?? '',
      willIssue: { childBracelets, adultBracelets, creditTotalTHB: 0 },
      createdAt: p.createdAt,
      status: p.redemption ? 'redeemed' : 'paid',
      redeemedAt: p.redemption?.at,
      issuedWristbandCodes: p.redemption?.bandCodes,
    },
    unmapped,
  };
}
