import { z } from 'zod';
import { EventCheckinRecordViewSchema, EventPrintJobViewSchema } from './event-checkin';
import { EventAttendeeInputSchema, EventEntryPriceSchema } from './events';

/**
 * S2-20 E5 (SCRUM-217) — EVENT PASSES BOUGHT ONLINE (consistency #21; plan
 * docs/progress/plans/events-kiosk/PLAN.md §3 "Online passes", §4 "An online
 * pass on the wrong day", Q6, Q11 and the E5 row of §9).
 *
 * The prototype's rule, ported (`createBooking`, mockApi.ts 1085-1115, and the
 * redemption, Till.tsx 437-462):
 *
 *   - a paid online booking registers each pass's attendee — today only for a
 *     camp, stamped "Walk-up added by Online booking (today only)", never
 *     checked in;
 *   - redeeming the booking at the till checks each pass in and prints its
 *     bands, with no second payment; a child already checked in is skipped.
 *
 * What the platform adds, on its own authority (data reliability only):
 *
 *   - the pass is PRICED by the platform's own quote, at the event's flat
 *     weekday / weekend price for the VISIT date's rate, taxed as the till's
 *     pass is (one kid under `tickets`), and the figure shown is compared, not
 *     charged — the booking site's own figure never reaches the money;
 *   - "today" is the booking's visit date, not the day the booking was made
 *     (plan §4), and the attendee is registered when the gateway confirms the
 *     money, inside that transaction (the S2-12 checkout's shape), then
 *     written to the OTO App under the attendee id the site minted — so a
 *     retry is a replay there, never a second child;
 *   - the pass's money is filed on the booking's redemption sale, beside its
 *     tickets, so a booking is one sale for the sum the family paid;
 *   - the kiosk's redemption checks the passes in as the till's does (Q11).
 */

const Uuid = z.string().uuid();
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The synthetic operator the prototype stamps an online sign-up with (`createBooking`). */
export const ONLINE_BOOKING_OPERATOR = 'Online booking';

/** The most passes one booking carries. */
export const BOOKING_EVENT_PASSES_MAX = 10;

/**
 * How a box's copy of bookings names a paid booking that carries event passes
 * (`bookingChange`): it is redeemed with the link up only — its passes are
 * checked in against the OTO App, and its money is filed with its tickets on
 * the one sale the platform makes. Older boxes refuse every status but `paid`.
 */
export const BOOKING_EVENT_PASSES_ONLINE_ONLY = 'event_passes_online_only';

/** What a counter with the link down says of such a booking. */
export const BOOKING_EVENT_PASSES_NEED_INTERNET = {
  code: 'BOOKING_NEEDS_INTERNET',
  message:
    'This booking includes event passes and needs the internet. Reconnect at reception to redeem it and check the children in to their event.',
} as const;

/** One pass as the booking site sends it: the event, the attendee id it minted, and the child. */
export const BookingEventPassInputSchema = z.object({
  eventId: Uuid,
  /**
   * The attendee's id, minted by the site (UUIDv7) when the pass was added.
   * The OTO App keeps the child under it, so every write of it is a replay.
   */
  attendeeId: Uuid,
  attendee: EventAttendeeInputSchema,
});
export type BookingEventPassInput = z.infer<typeof BookingEventPassInputSchema>;

/**
 * One pass on a booking, as the platform priced it (`BookingEventPass`,
 * types.ts): what the till and the confirmation show. No allergy, no phone.
 */
export const BookingEventPassSchema = z.object({
  eventId: z.string(),
  attendeeId: z.string(),
  eventType: z.enum(['camp', 'event']),
  eventTitle: z.string(),
  /** The day the pass is for: the camp day (the visit date), or the one-off event's own day. */
  eventDate: IsoDate,
  startTime: z.string(),
  endTime: z.string().nullable(),
  attendeeName: z.string(),
  parentAttending: z.boolean(),
  /** What the pass cost, at the visit date's rate (never tiered, R-98). */
  priceSatang: z.number().int().nonnegative(),
  /** A camp's day (the visit date); empty for a one-off event. */
  attendanceDays: z.array(IsoDate),
  /** `svc-camp-pass` / `svc-event-pass`, as the till's pass line is keyed (Q2). */
  serviceId: z.string(),
  /** "Camp day pass" / "Event entry pass". */
  label: z.string(),
});
export type BookingEventPass = z.infer<typeof BookingEventPassSchema>;

/** A pass as the booking stores it: the view, and the child as the site captured them for the write-back. */
export const StoredBookingEventPassSchema = BookingEventPassSchema.extend({
  attendee: EventAttendeeInputSchema,
});
export type StoredBookingEventPass = z.infer<typeof StoredBookingEventPassSchema>;

/** The passes a booking's payload stored, each read through its schema; anything else is skipped. */
export function storedEventPassesOf(payload: unknown): StoredBookingEventPass[] {
  const raw = payload && typeof payload === 'object' ? (payload as { eventPasses?: unknown }).eventPasses : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = StoredBookingEventPassSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The passes as the counter and the confirmation show them: no allergy, no phone. */
export function bookingEventPassesOf(payload: unknown): BookingEventPass[] {
  return storedEventPassesOf(payload).map(({ attendee: _attendee, ...view }) => view);
}

/**
 * What became of one pass when its booking was redeemed (Till.tsx 437-462):
 *
 *   - `checked_in`     — checked in now, bands minted and queued;
 *   - `already_in`     — already checked in for the day (skipped, as the
 *                        prototype's `checkInSoldPass` returns null);
 *   - `not_today`      — the event is not on today (a pass for a later event):
 *                        left booked, checked in on its day at the board;
 *   - `not_registered` — a camp child not registered for today (H5);
 *   - `not_found`      — the OTO App no longer holds the child or the event;
 *   - `failed`         — the check-in could not be made; nothing of it stands.
 */
export const BOOKING_PASS_CHECKIN_OUTCOMES = [
  'checked_in',
  'already_in',
  'not_today',
  'not_registered',
  'not_found',
  'failed',
] as const;
export type BookingPassCheckinOutcome = (typeof BOOKING_PASS_CHECKIN_OUTCOMES)[number];

export const BookingPassCheckinSchema = z.object({
  eventId: z.string(),
  attendeeId: z.string(),
  attendeeName: z.string(),
  eventTitle: z.string(),
  outcome: z.enum(BOOKING_PASS_CHECKIN_OUTCOMES),
  /** Why it was not checked in, in the counter's words; null when it was. */
  message: z.string().nullable(),
  checkin: EventCheckinRecordViewSchema.nullable(),
  printJobs: z.array(EventPrintJobViewSchema),
  notes: z.array(z.string()),
});
export type BookingPassCheckin = z.infer<typeof BookingPassCheckinSchema>;

/**
 * An event the booking site offers as a pass on a day (`getActiveEventPasses`):
 * what a stranger may read — its title, its day and times, where, and its flat
 * price. No roster, no party, nothing of anybody.
 */
export const PublicEventPassSchema = z.object({
  id: z.string(),
  type: z.enum(['camp', 'event']),
  title: z.string(),
  startDate: IsoDate,
  endDate: IsoDate.nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  location: z.string().nullable(),
  entryPrice: EventEntryPriceSchema,
});
export type PublicEventPass = z.infer<typeof PublicEventPassSchema>;

export const PublicEventPassesAnswerSchema = z.object({
  branchCode: z.string(),
  /** The day the passes are offered for: the visit date asked about, or the branch's trading day. */
  date: IsoDate,
  passes: z.array(PublicEventPassSchema),
});
export type PublicEventPassesAnswer = z.infer<typeof PublicEventPassesAnswerSchema>;
