import type { OtoEvent, EventAttendee, StationProfile } from '@/types';
import {
  addEventAttendee,
  addPartyExtraCharge,
  recordSale,
  checkInEventAttendee,
  getEventDropInPricing,
  getDefaultTier,
  type NewEventAttendeeInput,
  type EventCheckinResult,
} from '@/mockApi';
import { buildSale } from '@/lib/sale';
import { eventBraceletPrintJobs, dispatchPrintJobs } from '@/lib/printRouting';
import { resolveRate, todayRateMode } from '@/lib/pricingMode';
import { wwp } from '@/store/catalogStore';

export interface SellEventPassParams {
  event: OtoEvent;
  input: NewEventAttendeeInput;
  registerProperly: boolean;
  /**
   * Tender for a paid camp/event pass. Absent for a party (it rides the tab) or a
   * genuinely free event (entryPriceTHB 0). A paid pass without one is rejected.
   */
  paymentMethod?: string;
  today: string;
  operator: { operatorName: string; operatorId: string };
}

/**
 * Sell an event pass: create the attendee on the roster and bill it. This is the
 * create-and-bill HALF of the flow — check-in is a separate, later step
 * (`checkInSoldPass`) so a paid/sold pass is always persisted BEFORE the operator
 * chooses "check in now" vs "leave booked". (Dismissing that choice can therefore
 * never undo a completed payment.)
 *
 * Billing follows the event type:
 *   - party → appended to the party tab as an extra charge (partyGuestTHB).
 *   - camp / event → a one-kid admission sale priced at the event's flat
 *     `entryPriceTHB`, modelled as a synthetic day-pass ticket so the tax engine
 *     surfaces it under the 'tickets' category and the grand total equals the fee.
 *     `creditGrants: []` keeps it from minting a spurious F&B credit grant.
 *
 * Invariants:
 *   - A PAID pass (non-party with entryPriceTHB > 0) REQUIRES a paymentMethod;
 *     without one this returns null and creates nothing (no unpaid roster entry).
 *   - A FREE event (entryPriceTHB 0) creates the attendee with no sale.
 *
 * Returns the created attendee, or null if the paid invariant was violated or the
 * event was not found.
 */
export function sellEventPass(params: SellEventPassParams): EventAttendee | null {
  const { event, input, registerProperly, paymentMethod, today, operator } = params;

  const mode = todayRateMode().mode;
  const fee = resolveRate(event.entryPriceTHB, mode);
  // Never create an unpaid roster entry for a paid pass.
  if (event.type !== 'party' && fee > 0 && !paymentMethod) return null;

  const attendee = addEventAttendee(event.id, input, { registerProperly, today }, operator);
  if (!attendee) return null;

  if (event.type === 'party') {
    const guestFee = resolveRate(getEventDropInPricing().partyGuestTHB, mode);
    addPartyExtraCharge(event.id, {
      kind: 'ticket',
      items: [{ name: `Walk-up guest — ${attendee.name}`, qty: 1, lineTotal: guestFee }],
      total: guestFee,
      chargedBy: operator.operatorName,
      chargedById: operator.operatorId,
    });
  } else if (paymentMethod) {
    const defaultTierId = getDefaultTier().id;
    recordSale(
      buildSale({
        operatorId: operator.operatorId,
        operatorName: operator.operatorName,
        tier: defaultTierId,
        lines: [
          {
            id: `pass-${attendee.id}`,
            ticketType: {
              id: event.type === 'camp' ? 'svc-camp-pass' : 'svc-event-pass',
              name: event.type === 'camp' ? 'Camp day pass' : 'Event entry pass',
              durationLabel: 'One-time',
              hours: 0,
              prices: { [defaultTierId]: wwp(fee) },
            },
            tier: defaultTierId,
            kids: 1,
            adults: 0,
            socks: 0,
            addOns: [],
            lineTotal: fee,
          },
        ],
        creditGrants: [],
        paymentMethod,
        customerNickname: attendee.name,
      }),
    );
  }

  return attendee;
}

/**
 * Check a sold/booked attendee in: mint their band(s), mark attended, and print
 * through the active station. Separate from `sellEventPass` so the check-in choice
 * (now vs later) acts on an already-persisted attendee. Returns the check-in
 * result plus whether a band was actually printed (false = no station configured),
 * or null if the attendee could not be checked in (e.g. already in).
 */
export function checkInSoldPass(
  station: StationProfile | null,
  event: OtoEvent,
  attendeeId: string,
  today: string,
  operator: { operatorName: string; operatorId: string },
): { checkin: EventCheckinResult; printed: boolean } | null {
  const checkin = checkInEventAttendee(event.id, attendeeId, today, operator);
  if (!checkin) return null;
  const printed = dispatchEventBracelets(station, event, checkin, today);
  return { checkin, printed };
}

/**
 * Build + dispatch the attendee's bracelet jobs through the active station: always
 * a kid band, plus a parent band when the parent is attending. Shared by the
 * event-pass check-in and the roster check-in so the print mapping lives once.
 * Returns false when there is no station configured (nothing printed).
 */
export function dispatchEventBracelets(
  station: StationProfile | null,
  event: OtoEvent,
  checkin: EventCheckinResult,
  date: string,
): boolean {
  if (!station) return false;
  const a = checkin.attendee;
  dispatchPrintJobs(
    eventBraceletPrintJobs(station, {
      eventTitle: event.title,
      eventDate: date,
      startTime: event.startTime,
      endTime: event.endTime,
      kidName: a.name,
      wristbandCode: checkin.wristbandCode,
      dietaryDetail: a.dietaryFlag ? a.dietaryDetail : undefined,
      allergyDetail: a.allergyFlag ? a.allergyDetail : undefined,
      parentName: checkin.parentWristbandCode ? a.parentName : undefined,
      parentWristbandCode: checkin.parentWristbandCode,
    }),
  );
  return true;
}
