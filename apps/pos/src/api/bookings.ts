import type { Booking, CartLine, SelectedAddOn } from '@/types';
import { getTicketTypes } from '@/store/catalogStore';
import { SOCKS_ADDON_ID, SOCKS_LABEL, toBaht } from '@/lib/cartWire';
import {
  BRIDGE_BOOKING_INTENTS,
  parseBookingQr,
  type BridgeBookingRedeemAnswer,
  type BridgeBookingView,
} from '@oto/shared';
import type { StationScanEvent } from '@/lib/scanChannel';
import { viaLane } from '@/lib/lane';
import { api, ApiError, idemKey } from './client';
import { bridgeApi, bridgeStaffName } from './bridge';
import type { ApiSalePrintJob } from './history';

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
  /**
   * S2-12 — the socks and extras paid for online, at the prices paid. Optional
   * because a deployment whose API predates them does not send them.
   */
  socks?: number;
  socksUnitSatang?: number;
  addOns?: PlatformBookingAddOn[];
  lineTotalSatang: number;
}

/** One extra on a booking line, as the platform priced and stored it. */
export interface PlatformBookingAddOn {
  productId: string;
  name: string;
  unitSatang: number;
  quantity: number;
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

/** A band the redemption minted, as the platform reads it back — the short code, never the credential. */
export interface RedeemedBand {
  id: string;
  kind: 'kid' | 'adult';
  shortCode: string | null;
  childName: string | null;
  printedJobId: string | null;
}

/**
 * S2-12 round 3 — what redeeming answers: the booking, the sale the platform
 * recorded for it (the booking on it, the paid-online tender, the booking's
 * exact total), the bands it minted and the paper it queued — the same
 * printing answer a walk-in sale's finalisation gives.
 */
export interface BookingRedeemResult {
  booking: PlatformBooking;
  sale: { id: string; receiptNumber: string | null; totals: { grossSatang: number } };
  bands: RedeemedBand[];
  printing: { jobs: ApiSalePrintJob[]; notes: string[]; failed: { code: string; message: string } | null } | null;
  /**
   * S2-12 round 5 — set when the counter's BOX redeemed it, with the link
   * down: the box already printed the paper from its own queue, so the till
   * announces what it said rather than dispatching anything, and the
   * confirmation shows the band codes for reading aloud.
   */
  box?: { notes: string[] } | null;
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
  | {
      ok: true;
      /**
       * S2-12 round 5 — what the box issued when it redeemed the booking
       * offline: the receipt number and the SHORT band codes with the children
       * they name, which the dialog shows for reading aloud, as an offline
       * sale's confirmation does. Absent online, where the dialog just closes.
       */
      issued?: { receiptNumber: string | null; bands: RedeemedBand[]; notes: string[] } | null;
    }
  | { ok: false; redemption: PlatformRedemption }
  | { ok: false; message: string };

/** The box's booking, in the platform's shape the modal reads (the box adds only `source`). */
function platformOfBox(view: BridgeBookingView): PlatformBooking {
  const { source: _source, ...booking } = view;
  return booking;
}

/** What the box answered a redemption with, in the platform's redeem shape. */
function redeemResultOfBox(answer: BridgeBookingRedeemAnswer): BookingRedeemResult {
  return {
    booking: platformOfBox(answer.booking),
    sale: { id: answer.sale.id, receiptNumber: answer.sale.receiptNumber, totals: answer.sale.totals },
    bands: answer.bands.map((band) => ({
      id: band.id,
      kind: band.kind,
      shortCode: band.shortCode,
      childName: band.childName,
      printedJobId: null,
    })),
    // Printed by the box, from its own queue: nothing for the till to dispatch.
    printing: null,
    box: { notes: answer.printing.notes },
  };
}

/** Ask this counter's box for a booking from its own copy (S2-12 round 5). */
async function lookupOnBox(stationId: string, body: Record<string, unknown>): Promise<PlatformBooking> {
  const answer = await bridgeApi.intent<{ booking: BridgeBookingView }>(
    stationId,
    BRIDGE_BOOKING_INTENTS.lookup,
    body,
  );
  return platformOfBox(answer.result!.booking);
}

export const bookingsApi = {
  /**
   * Paid bookings not yet redeemed, for the branch the till is on. The list the
   * modal shows under "Paid bookings waiting at reception".
   */
  waiting: (branchId: string, limit = 25) =>
    api.get<{ bookings: PlatformBooking[] }>(
      `/bookings?branchId=${encodeURIComponent(branchId)}&status=paid&limit=${limit}`,
    ),

  /**
   * One booking by the reference printed on the customer's QR. 404 when there
   * is none. With the link down it comes from the counter's box (round 5).
   */
  byReference: (reference: string, branchId?: string) =>
    viaLane(
      () =>
        api.get<PlatformBooking>(
          `/bookings/by-reference/${encodeURIComponent(reference)}` +
            (branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''),
        ),
      (stationId) => lookupOnBox(stationId, { reference }),
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
    body: { stationId?: string; visitId?: string; visitChildIds?: string[] },
    key: string,
  ) =>
    viaLane(
      () =>
        api.post<BookingRedeemResult>(
          `/bookings/${encodeURIComponent(bookingId)}/redeem`,
          { ...(body.stationId ? { stationId: body.stationId } : {}), ...(body.visitId ? { visitId: body.visitId } : {}) },
          { idempotencyKey: key },
        ),
      /**
       * S2-12 round 5 — the link is down: the counter's box redeems it from
       * its own copy, the SAME three stages riding the bridge. The press's key
       * is the box's replay key, so a retried Confirm is answered with the one
       * sale; a second till on the box is told who redeemed it and when.
       */
      async (stationId) => {
        const staffName = bridgeStaffName();
        const answer = await bridgeApi.intent<BridgeBookingRedeemAnswer>(
          stationId,
          BRIDGE_BOOKING_INTENTS.redeem,
          {
            bookingId,
            actionId: key.slice(0, 200),
            ...(body.visitId ? { visitId: body.visitId } : {}),
            ...(body.visitChildIds && body.visitChildIds.length > 0 ? { visitChildIds: body.visitChildIds } : {}),
            ...(staffName ? { staffName } : {}),
          },
          { actionId: key },
        );
        return redeemResultOfBox(answer.result!);
      },
    ),

  newRedeemKey: idemKey,

  /**
   * One booking by the id the BOX named after checking the QR's signature
   * (S2-12 round 3). Only for a scan the box answered `handled`; a code this
   * device read itself goes through `byQr`. 404 when there is none.
   */
  byId: (bookingId: string) =>
    viaLane(
      () => api.get<PlatformBooking>(`/bookings/${encodeURIComponent(bookingId)}`),
      (stationId) => lookupOnBox(stationId, { bookingId }),
    ),

  /**
   * One booking by the whole QR a scanner on THIS device read, or the typed
   * field held. The till has no key, so the platform checks the signature
   * against the one it issued; a tampered or foreign code answers 422
   * `BOOKING_QR_SIGNATURE_INVALID` and nothing opens.
   */
  byQr: (code: string) =>
    viaLane(
      () => api.get<PlatformBooking>(`/bookings/by-qr?code=${encodeURIComponent(code)}`),
      (stationId) => lookupOnBox(stationId, { qr: code }),
    ),
};

/** The platform's refusal of a QR whose signature is not the park's. */
export const BOOKING_QR_SIGNATURE_INVALID = 'BOOKING_QR_SIGNATURE_INVALID';

/**
 * A scanned booking QR on its way to the redeem dialog: the id a box vouched
 * for, or the raw code this device read, which only the platform can vouch for.
 */
export type ScannedBooking = { bookingId: string } | { qr: string };

/** Read the booking a scan names — through the check that scan still needs. */
export function fetchScannedBooking(scan: ScannedBooking): Promise<PlatformBooking> {
  return 'bookingId' in scan ? bookingsApi.byId(scan.bookingId) : bookingsApi.byQr(scan.qr);
}

/** The name the box's booking handler goes by (`BOOKING_QR_HANDLER` in `@oto/box-agent`). */
export const BOOKING_QR_HANDLER = 'booking';

/**
 * Read a scan as the till reads a booking QR (S2-12 round 3): the booking the
 * box checked the signature of, or null when the scan is some other screen's.
 * The box answers `handled` with `detail.bookingId` and the action to take;
 * a refused or unchecked QR carries a sentence in `detail.message`.
 */
export function readBookingScan(
  event: StationScanEvent,
): { bookingId: string } | { refused: string } | null {
  if (event.codeKind !== 'booking') return null;
  if (event.outcome === 'handled' && event.handler === BOOKING_QR_HANDLER) {
    const id = event.detail?.bookingId;
    return typeof id === 'string' && id.length > 0 ? { bookingId: id } : null;
  }
  const message = event.detail?.message;
  return { refused: typeof message === 'string' ? message : 'That booking QR could not be checked.' };
}

/**
 * A booking QR typed in by a USB or Bluetooth scanner on this device, which no
 * box has seen: the code as the platform compares it, or null when the text is
 * not the shape of one. SHAPE ONLY — this routes the burst to the booking
 * lookup and never names a booking by itself: `parseBookingQr` is not a
 * signature check, so the id inside is not trusted until `bookingsApi.byQr`
 * has matched the signature on the platform.
 */
export function typedBookingQr(code: string): string | null {
  return parseBookingQr(code)?.code ?? null;
}

/** Whether a scanner burst is shaped like a booking QR — the till's `useScannerBurst` filter. */
export function looksLikeBookingQr(code: string): boolean {
  return typedBookingQr(code) !== null;
}

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
  /**
   * S2-12 — whether the platform says the money arrived. A booking found by
   * its reference can be one still waiting for payment, or one whose payment
   * failed or ran out; the counter must not read it as paid.
   */
  paid: boolean;
  /** Why nothing can be issued against it, in words for reception. Null when paid. */
  notPaidReason: string | null;
}

/** The platform's booking status, as reception reads it. */
function notPaidReasonFor(p: PlatformBooking): string | null {
  if (p.status === 'paid' || p.status === 'redeemed' || p.redemption) return null;
  if (p.status === 'pending') {
    return `Booking ${p.reference} is not paid yet — the family has not finished paying online. Nothing can be issued against it.`;
  }
  if (p.status === 'expired') {
    return `Booking ${p.reference} was never paid — its hold ran out. Nothing can be issued against it; the family can buy tickets here.`;
  }
  if (p.status === 'cancelled') {
    return `Booking ${p.reference} was not paid — its online payment did not go through. Nothing can be issued against it; the family can buy tickets here.`;
  }
  return `Booking ${p.reference} is ${p.status}, not paid. Nothing can be issued against it.`;
}

/**
 * The extras a booking line paid for, as the till's add-on shape, at the price
 * they were PAID at. The prototype's separate socks count, where a line has
 * one, becomes the Regular Socks extra it always was on the till.
 */
function paidAddOns(line: PlatformBookingLine): SelectedAddOn[] {
  const addOns: SelectedAddOn[] = (line.addOns ?? []).map((a) => ({
    id: a.productId,
    name: a.name,
    price: toBaht(a.unitSatang),
    quantity: a.quantity,
  }));
  if ((line.socks ?? 0) > 0) {
    addOns.push({
      id: SOCKS_ADDON_ID,
      name: SOCKS_LABEL,
      price: toBaht(line.socksUnitSatang ?? 0),
      quantity: line.socks ?? 0,
    });
  }
  return addOns;
}

/**
 * Rebuild the till's `Booking` from the platform row.
 *
 * Socks and extras ARE carried (S2-12): the platform prices them on the booking
 * and the family paid for them, so they are on the lines at the prices paid and
 * reception is told to hand them over.
 *
 * WHAT IT CANNOT KNOW, and so does not invent: drop-off children, event passes
 * and promo codes are not priced by `POST /public/bookings` — the booking site
 * does not send them. They stay empty here, so the summary shows what the
 * platform actually took money for. Drop-off and passes on a booking are S2-13
 * and S2-20.
 *
 * `willIssue.creditTotalTHB` is 0 for the same reason: the credit a ticket grants
 * is a catalogue rule the sale applies at redemption (`lib/sale.ts`), and stating
 * a figure here that the sale then disagrees with is worse than stating none.
 */
export function toPosBooking(p: PlatformBooking): MappedBooking {
  const catalogue = getTicketTypes();
  const lines: CartLine[] = [];
  const unmapped: UnmappedLine[] = [];

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
      addOns: paidAddOns(line),
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
      // The till's `Booking` knows two states; a booking that is not paid is
      // told apart by `paid` below, never shown as paid.
      status: p.redemption || p.status === 'redeemed' ? 'redeemed' : 'paid',
      redeemedAt: p.redemption?.at,
      issuedWristbandCodes: p.redemption?.bandCodes,
    },
    unmapped,
    paid: notPaidReasonFor(p) === null,
    notPaidReason: notPaidReasonFor(p),
  };
}
