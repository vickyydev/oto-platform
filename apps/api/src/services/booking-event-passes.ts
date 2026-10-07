import { and, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { band, booking, eventAttendeeLink, eventCheckin, saleLine, station, type Db } from '@oto/db';
import {
  BOOKING_EVENT_PASSES_MAX,
  EVENT_CHECKIN_REFUSALS,
  ONLINE_BOOKING_OPERATOR,
  bookingEventPassesOf,
  businessDate,
  storedEventPassesOf,
  eventListedOn,
  eventPassOfferedOn,
  eventPassService,
  newId,
  resolveRate,
  walkUpAttendanceDays,
  walkUpStamp,
  type BookingEventPassInput,
  type BookingPassCheckin,
  type StoredBookingEventPass,
  type TicketCartLine,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import {
  appDayOf,
  checkinViewOf,
  eventChildOf,
  isDayTaken,
  issueBands,
  lockChildDay,
  posCheckinsOf,
  pushCheckin,
  takenBackBy,
  undoTakenBack,
} from './event-checkins';
import {
  branchClockOf,
  directoryBodyOf,
  pushAttendee,
  seamRead,
  staffNameOf,
  type EventWriteDeps,
} from './event-writes';
import { getBranchEvent } from './otoapp-events';
import type { DirectoryCheckinBody, OtoAppDirectory } from './otoapp-directory';
import type { SalePrintJobView } from './sale-printing';
import type { Exec, Tx } from './tx';

/**
 * S2-20 E5 (SCRUM-217) — EVENT PASSES BOUGHT ONLINE, on the platform
 * (consistency #21; plan docs/progress/plans/events-kiosk/PLAN.md §3 "Online
 * passes", §4, Q6, Q11, the E5 row of §9).
 *
 * The prototype's `createBooking` (mockApi.ts 1085-1115) registered each pass's
 * attendee the moment the booking was made, and `handleRedeemConfirm`
 * (Till.tsx 437-462) checked each in when the booking QR was redeemed, with no
 * second payment, skipping a child already in. The platform keeps both rules
 * and runs them on the S2-12 checkout's own shape:
 *
 *   1. THE QUOTE (`quoteEventPasses`, called by `quoteBooking`): each pass at
 *      the event's flat weekday / weekend price for the VISIT date's rate,
 *      never tiered (R-98), as one kid under `tickets` (Q2) — the till's pass
 *      line exactly — so the booking's total is the platform's and the figure
 *      the site showed is only compared. A party is refused (no pass); an event
 *      with no price is refused; an event the till would not sell as a pass on
 *      the visit date is refused.
 *   2. REGISTERED AT PAYMENT (`registerPaidBookingEventPasses`), inside the
 *      settlement's transaction beside the supervised children
 *      (`registerPaidBookingChildren`): one `pos.event_attendee_link` per pass
 *      under the attendee id the site minted, `source = 'booking'`, billed to
 *      the booking, with the write-back body the OTO App is sent — the child
 *      registered for the visit date only, stamped "Walk-up added by Online
 *      booking (today only)" as the prototype stamps it.
 *   3. WRITTEN BACK after the commit (`writeBackBookingPasses`), through E2's
 *      directory pattern: `pushAttendee` under the link's own id, an `ops_run`
 *      under `otoapp:attendee.create`, `pending` until the app has it and
 *      retried from Failures like any till walk-up — a replay in the app.
 *   4. CHECKED IN AT REDEMPTION (`checkInBookingPasses`), inside the
 *      redemption's transaction, at the till and at the kiosk alike (Q11): the
 *      E3 rules (registered for today, one check-in per child per day, the OTO
 *      App's word first), the bands minted and printed — at the kiosk printed
 *      by the kiosk itself before it commits — and each check-in written back
 *      after the commit.
 *
 * The pass's money is filed on the booking's redemption sale, beside its
 * tickets (`CartInput.bookingPasses`): one booking, one sale, the sum the
 * family paid.
 *
 * The OTO App is read through the seam (`otoapp-events.ts`) and written only
 * through its directory: this file names no OTO App table and no view (H1).
 */

// --- 1 · The quote ------------------------------------------------------------------

/**
 * Price the passes a booking carries, for the visit date at its rate. Returns
 * them as the booking stores them, and the cart lines the quote totals them
 * with — only the passes with a price: a free pass owes no line, on the quote
 * or on the redemption sale.
 */
export async function quoteEventPasses(
  exec: Exec,
  br: { id: string },
  input: {
    tier: string;
    visitDate: string;
    mode: 'weekday' | 'weekend';
    passes: readonly BookingEventPassInput[];
  },
): Promise<{ passes: StoredBookingEventPass[]; cartLines: TicketCartLine[] }> {
  if (input.passes.length > BOOKING_EVENT_PASSES_MAX) {
    throw errors.badRequest(`A booking carries at most ${BOOKING_EVENT_PASSES_MAX} event passes`);
  }
  const passes: StoredBookingEventPass[] = [];
  const cartLines: TicketCartLine[] = [];
  const seen = new Set<string>();
  for (const p of input.passes) {
    const attendeeId = p.attendeeId.toLowerCase();
    if (seen.has(attendeeId)) throw errors.badRequest('Each event pass carries its own attendee id');
    seen.add(attendeeId);
    const event = await seamRead(() => getBranchEvent(exec, { branchId: br.id, eventId: p.eventId }));
    if (!event || event.archived) throw errors.badRequest('A selected event pass is no longer available');
    if (event.type === 'party') {
      throw errors.conflict('EVENT_PASS_NOT_FOR_PARTY', 'A party has no pass: its guests are booked with the party');
    }
    if (event.entryPriceWeekdaySatang === null || event.entryPriceWeekendSatang === null) {
      throw errors.conflict('EVENT_NOT_PRICED', `${event.title} has no entry price yet, so no pass can be booked for it`);
    }
    const pair = { weekday: event.entryPriceWeekdaySatang, weekend: event.entryPriceWeekendSatang };
    const offered = eventPassOfferedOn(
      {
        type: event.type,
        startDate: event.startDate,
        endDate: event.endDate,
        entryPrice: { weekdaySatang: pair.weekday, weekendSatang: pair.weekend },
      },
      input.visitDate,
    );
    if (!offered) {
      throw errors.badRequest(`${event.title} is not on sale as a pass for ${input.visitDate}`);
    }
    const fee = resolveRate(pair, input.mode);
    const service = eventPassService(event.type);
    passes.push({
      eventId: event.id,
      attendeeId,
      eventType: event.type,
      eventTitle: event.title,
      // A camp pass is for the visit date; a one-off event is on its own day.
      eventDate: event.type === 'camp' ? input.visitDate : event.startDate,
      startTime: event.startTime,
      endTime: event.endTime,
      attendeeName: p.attendee.name.trim(),
      parentAttending: p.attendee.parentAttending ?? false,
      priceSatang: fee,
      // `addEventAttendee` with `registerProperly: false`: today only — the
      // visit date, not the day the booking was made (plan §4).
      attendanceDays: walkUpAttendanceDays(event, false, input.visitDate),
      serviceId: service.serviceId,
      label: service.label,
      attendee: p.attendee,
    });
    if (fee > 0) {
      // The till's pass line (`CartInput.eventPass`): one kid at the flat pair,
      // the same at every tier.
      cartLines.push({
        id: attendeeId,
        packageId: service.serviceId,
        package: { prices: { [input.tier]: pair } },
        tier: input.tier,
        kids: 1,
        adults: 0,
        socks: 0,
        addOns: [],
        lineTotal: 0,
      });
    }
  }
  return { passes, cartLines };
}

export { bookingEventPassesOf, storedEventPassesOf };

/** What the redemption sale files a booking's paid passes as (`CartInput.bookingPasses`). */
export function bookingPassLinesOf(payload: unknown): Array<{
  lineId: string;
  serviceId: string;
  label: string;
  price: { weekday: number; weekend: number };
  eventId: string;
}> {
  return storedEventPassesOf(payload)
    .filter((p) => p.priceSatang > 0)
    .map((p) => ({
      lineId: p.attendeeId,
      serviceId: p.serviceId,
      label: p.label,
      // The figure the family paid, on any day: the booking already chose its rate.
      price: { weekday: p.priceSatang, weekend: p.priceSatang },
      eventId: p.eventId,
    }));
}

/**
 * An attendee id the booking site minted that already names a child the POS
 * holds: refused before the booking is written, so the registration at payment
 * never meets another child's row.
 */
export async function assertPassIdsFree(exec: Exec, passes: readonly StoredBookingEventPass[]): Promise<void> {
  for (const p of passes) {
    const [taken] = await exec
      .select({ id: eventAttendeeLink.id })
      .from(eventAttendeeLink)
      .where(eq(eventAttendeeLink.id, p.attendeeId))
      .limit(1);
    if (taken) {
      throw errors.conflict('ATTENDEE_ID_IN_USE', 'That attendee id already belongs to another child', {
        attendeeId: p.attendeeId,
      });
    }
  }
}

// --- 2 · Registered at payment ----------------------------------------------------

/**
 * REGISTER THE BOOKING'S PASSES, inside the settlement's transaction
 * (`confirmBookingPaid`) — the money and the registration commit together or
 * not at all. Once per booking: the booking is confirmed once, and a link that
 * is already there (a replayed confirmation reaching here is impossible, but a
 * restored database is not) is left as it is.
 */
export async function registerPaidBookingEventPasses(
  tx: Tx,
  row: typeof booking.$inferSelect,
  payload: unknown,
  now: Date,
  requestId: string | null,
): Promise<number> {
  const passes = storedEventPassesOf(payload);
  let registered = 0;
  for (const p of passes) {
    const billing = p.priceSatang > 0 ? ('booking' as const) : ('free' as const);
    const body = {
      ...directoryBodyOf(
        p.attendeeId,
        p.attendee,
        p.attendanceDays,
        walkUpStamp(ONLINE_BOOKING_OPERATOR, false),
        ONLINE_BOOKING_OPERATOR,
      ),
      // The app's own `bookingId` names ITS group bookings, not this one; the
      // platform booking is on the link.
      source: 'booking' as const,
    };
    const [inserted] = await tx
      .insert(eventAttendeeLink)
      .values({
        id: p.attendeeId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        otoappEventId: p.eventId,
        eventType: p.eventType,
        childId: null,
        memberId: row.memberId,
        saleId: null,
        saleLineId: null,
        billing,
        bookingId: row.id,
        priceSnapshotSatang: p.priceSatang,
        parentAttending: p.parentAttending,
        attendanceDays: p.attendanceDays,
        source: 'booking',
        syncState: 'pending',
        writeback: body,
        accountId: null,
        stationId: null,
        boxId: null,
        actionId: `booking.pay:${row.id}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: eventAttendeeLink.id })
      .returning({ id: eventAttendeeLink.id });
    if (!inserted) continue;
    registered += 1;
    await audit.record(tx, {
      // No person: the gateway's confirmation registered it.
      actorAccountId: null,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'event.attendee_create',
      entityType: 'event_attendee_link',
      entityId: p.attendeeId,
      actionId: `booking.pay:${row.id}`,
      requestId,
      after: {
        eventId: p.eventId,
        eventType: p.eventType,
        billing,
        priceSatang: p.priceSatang,
        source: 'booking',
        bookingId: row.id,
        reference: row.reference,
        attendanceDays: p.attendanceDays.length,
        stationId: null,
        boxId: null,
      },
    });
  }
  return registered;
}

// --- 3 · Written back after the commit ----------------------------------------------

/**
 * The OTO App's directory, as the api app holds it (`app.otoAppDirectory`),
 * read when it is needed — a test's stub replaces the decoration after the app
 * is built. Configured once by `app.ts`; until then, nothing is sent and the
 * passes wait, `pending`, for the Failures page or their redemption.
 */
let directoryOf: (() => OtoAppDirectory) | null = null;

export function configureBookingPassDirectory(resolve: (() => OtoAppDirectory) | null): void {
  directoryOf = resolve;
}

/**
 * Send every pass of a paid booking the OTO App does not have yet, under its
 * own id (a replay in the app). Never throws: the payment is committed, and a
 * write-back that fails is a `pending` link and an `ops_run` on Failures.
 */
export async function writeBackBookingPasses(
  db: Db,
  log: FastifyBaseLogger | undefined,
  bookingId: string,
): Promise<number> {
  const directory = directoryOf?.();
  if (!directory) return 0;
  const owed = await db
    .select({ id: eventAttendeeLink.id })
    .from(eventAttendeeLink)
    .where(and(eq(eventAttendeeLink.bookingId, bookingId), ne(eventAttendeeLink.syncState, 'synced')));
  let sent = 0;
  for (const { id } of owed) {
    try {
      await pushAttendee({ db, directory, ...(log ? { log } : {}) }, id);
      sent += 1;
    } catch (err) {
      log?.error({ err, linkId: id, bookingId }, 'a booked event pass could not be written back');
    }
  }
  return sent;
}

// --- 4 · Checked in at redemption ----------------------------------------------------

type BandRow = typeof band.$inferSelect;
type CheckinRow = typeof eventCheckin.$inferSelect;

export interface BookingPassCheckinResult {
  checkins: BookingPassCheckin[];
  /** The check-ins made now, to be written back to the OTO App after the commit. */
  checkinIds: string[];
  /** The bands those check-ins minted. */
  bands: BandRow[];
  /** Their paper: queued to the box, or — `dispatch: 'caller'` — written for the kiosk to print. */
  jobs: SalePrintJobView[];
}

export const NO_PASS_CHECKINS: BookingPassCheckinResult = { checkins: [], checkinIds: [], bands: [], jobs: [] };

/** The words a pass that was not checked in is shown with. */
const SKIPPED: Record<Exclude<BookingPassCheckin['outcome'], 'checked_in'>, string> = {
  already_in: EVENT_CHECKIN_REFUSALS.alreadyIn.message,
  not_today: 'This event is not on today: the child is checked in at the board on the day.',
  not_registered: EVENT_CHECKIN_REFUSALS.notRegistered.message,
  not_found: 'This pass is not on the event in the OTO App any more — ask a manager.',
  failed: 'This pass could not be checked in here — check the child in at the board.',
};

/**
 * CHECK IN THE PASSES OF A BOOKING BEING REDEEMED, inside the redemption's
 * transaction (Till.tsx 437-462; Q11 at the kiosk). Each pass in a savepoint
 * of its own: a pass that cannot be checked in is said, and the rest of the
 * booking — and the money — still stand. A pass already checked in is
 * skipped, as the prototype's `checkInSoldPass` returns null for it.
 *
 * Also files the redemption sale on each paid pass's link (`sale_id`,
 * `sale_line_id`), which is where its money now is.
 */
export async function checkInBookingPasses(
  tx: Tx,
  args: {
    booking: typeof booking.$inferSelect;
    operatorId: string;
    stationId: string;
    actorAccountId: string | null;
    requestId?: string | null;
    actionId: string | null;
    saleId: string;
    /** `caller`: the kiosk prints the bands itself before it commits. */
    dispatch: 'box' | 'caller';
    surface: 'counter' | 'kiosk';
    log?: FastifyBaseLogger;
    now: Date;
  },
): Promise<BookingPassCheckinResult> {
  const passes = storedEventPassesOf(args.booking.payload);
  if (passes.length === 0) return NO_PASS_CHECKINS;
  const clock = await branchClockOf(tx, args.operatorId, args.booking.branchId);
  const today = businessDate(args.now, clock.timezone, clock.dayStartMinutes);
  const [st] = await tx
    .select({ id: station.id, name: station.name, boxId: station.boxId, prefix: station.codePrefix })
    .from(station)
    .where(eq(station.id, args.stationId))
    .limit(1);
  const where = st ? { id: st.id, boxId: st.boxId, prefix: st.prefix } : null;
  // Who the OTO App is told checked the child in: the person at the till, or
  // the kiosk itself — nobody signs in there.
  const staffName = args.actorAccountId
    ? await staffNameOf(tx, args.actorAccountId)
    : (st?.name ?? 'Kiosk').slice(0, 120);

  const out: BookingPassCheckinResult = { checkins: [], checkinIds: [], bands: [], jobs: [] };
  for (const pass of passes) {
    const said = (outcome: Exclude<BookingPassCheckin['outcome'], 'checked_in'>, message?: string): void => {
      out.checkins.push({
        eventId: pass.eventId,
        attendeeId: pass.attendeeId,
        attendeeName: pass.attendeeName,
        eventTitle: pass.eventTitle,
        outcome,
        message: message ?? SKIPPED[outcome],
        checkin: null,
        printJobs: [],
        notes: [],
      });
    };

    // The pass's link, registered when the booking was paid.
    const [link] = await tx
      .select()
      .from(eventAttendeeLink)
      .where(and(eq(eventAttendeeLink.id, pass.attendeeId), eq(eventAttendeeLink.bookingId, args.booking.id)))
      .limit(1);
    if (!link) {
      said('not_found', 'This pass was never registered with the event — ask a manager.');
      continue;
    }
    // Its money is on this sale now.
    if (link.billing === 'booking' && !link.saleId) {
      const [line] = await tx
        .select({ id: saleLine.id })
        .from(saleLine)
        .where(and(eq(saleLine.saleId, args.saleId), eq(saleLine.cartLineId, pass.attendeeId)))
        .limit(1);
      await tx
        .update(eventAttendeeLink)
        .set({ saleId: args.saleId, saleLineId: line?.id ?? null, updatedAt: args.now })
        .where(and(eq(eventAttendeeLink.id, link.id), isNull(eventAttendeeLink.saleId)));
    }

    const event = await seamRead(() => getBranchEvent(tx, { branchId: clock.id, eventId: pass.eventId }));
    if (!event || event.archived) {
      said('not_found');
      continue;
    }
    if (!eventListedOn(event, today)) {
      said('not_today', `${event.title} is on ${event.startDate}: the child is checked in at the board that day.`);
      continue;
    }
    const child = await seamRead(() => eventChildOf(tx, clock.id, event, pass.attendeeId, today));
    if (!child) {
      said('not_found');
      continue;
    }
    if (!child.attends) {
      said('not_registered');
      continue;
    }
    // The OTO App is the master (Q1): a child it already has in is in.
    if (await seamRead(() => appDayOf(tx, clock.id, event.id, child.aliases, today))) {
      said('already_in');
      continue;
    }

    const checkinId = newId();
    try {
      const made = await tx.transaction(async (sp) => {
        await lockChildDay(sp, event.id, child, today);
        const held = await posCheckinsOf(sp, event.id, child, today);
        if (held.length > 0) {
          const appNow = await seamRead(() => appDayOf(sp, clock.id, event.id, child.aliases, today, checkinId));
          const back = takenBackBy(held, appNow);
          if (held.some((r) => !back.includes(r))) return null;
          await undoTakenBack(sp, back, {
            operatorId: args.operatorId,
            branchId: clock.id,
            actorAccountId: args.actorAccountId,
            requestId: args.requestId ?? null,
            actionId: args.actionId,
            stationId: where?.id ?? null,
            boxId: where?.boxId ?? null,
            nextCheckinId: checkinId,
            now: args.now,
          });
        }
        const writeback: DirectoryCheckinBody = {
          id: checkinId,
          date: today,
          checkedInAt: args.now.toISOString(),
          checkedInBy: staffName,
        };
        await sp.insert(eventCheckin).values({
          id: checkinId,
          operatorId: args.operatorId,
          branchId: clock.id,
          otoappEventId: event.id,
          attendeeId: child.attendeeId,
          linkId: child.link?.id ?? link.id,
          eventType: event.type,
          attendanceDate: today,
          childName: child.childName,
          parentName: child.parentName,
          parentAttending: child.parentAttending,
          allergy: child.allergy,
          dietary: child.dietary,
          eventTitle: event.title,
          startTime: event.startTime,
          endTime: event.endTime,
          checkedInAt: args.now,
          checkedInByAccountId: args.actorAccountId,
          checkedInByName: staffName,
          stationId: where?.id ?? null,
          boxId: where?.boxId ?? null,
          origin: 'till',
          syncState: 'pending',
          writeback,
          actionId: args.actionId,
          createdAt: args.now,
          updatedAt: args.now,
        });
        const issued = await issueBands(sp, {
          actor: {
            operatorId: args.operatorId,
            accountId: args.actorAccountId,
            ...(args.requestId ? { requestId: args.requestId } : {}),
          },
          clock,
          checkinId,
          child,
          where,
          now: args.now,
          actionId: args.actionId,
          detail: { eventId: event.id, attendeeId: child.attendeeId, date: today, bookingId: args.booking.id },
          dispatch: args.dispatch,
        });
        await audit.record(sp, {
          actorAccountId: args.actorAccountId,
          operatorId: args.operatorId,
          branchId: clock.id,
          action: 'event.checkin',
          entityType: 'event_checkin',
          entityId: checkinId,
          actionId: args.actionId,
          requestId: args.requestId ?? null,
          after: {
            eventId: event.id,
            eventType: event.type,
            attendeeId: child.attendeeId,
            linkId: child.link?.id ?? link.id,
            date: today,
            kidBandId: issued.bands.find((b) => b.kind === 'kid')?.id ?? null,
            parentBandId: issued.bands.find((b) => b.kind === 'adult')?.id ?? null,
            stationId: where?.id ?? null,
            boxId: where?.boxId ?? null,
            origin: 'till',
            // Checked in by the booking's redemption, at the counter or the kiosk.
            bookingId: args.booking.id,
            reference: args.booking.reference,
            surface: args.surface,
          },
        });
        const [row] = await sp.select().from(eventCheckin).where(eq(eventCheckin.id, checkinId)).limit(1);
        return { row: row as CheckinRow, issued };
      });
      if (!made) {
        said('already_in');
        continue;
      }
      out.checkinIds.push(checkinId);
      out.bands.push(...made.issued.bands);
      out.jobs.push(...made.issued.jobs);
      out.checkins.push({
        eventId: pass.eventId,
        attendeeId: pass.attendeeId,
        attendeeName: pass.attendeeName,
        eventTitle: pass.eventTitle,
        outcome: 'checked_in',
        message: null,
        checkin: await checkinViewOf(tx, made.row),
        printJobs: made.issued.jobs.map((j) => ({ ...j })),
        notes: made.issued.notes,
      });
    } catch (err) {
      if (isDayTaken(err)) {
        said('already_in');
        continue;
      }
      args.log?.error({ err, attendeeId: pass.attendeeId, bookingId: args.booking.id }, 'a booked event pass could not be checked in');
      said('failed');
    }
  }
  return out;
}

/**
 * Tell the OTO App of the check-ins a redemption made, after its commit —
 * `pushCheckin`, which writes the child first when the app does not hold them
 * yet. Never throws: what fails waits on Failures, `pending`.
 */
export async function sendBookingPassCheckins(
  deps: EventWriteDeps,
  checkinIds: readonly string[],
  meta: { requestId?: string | null } = {},
): Promise<void> {
  for (const id of checkinIds) {
    try {
      await pushCheckin(deps, id, meta);
    } catch (err) {
      deps.log?.error({ err, checkinId: id }, 'a booked pass check-in could not be written back');
    }
  }
}

/** The directory this process writes to, for a caller with no app at hand (the kiosk). */
export function bookingPassDirectory(): OtoAppDirectory | null {
  return directoryOf?.() ?? null;
}
