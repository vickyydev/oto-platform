// S2-20 E1 — the events, camps and parties the POS reads from the OTO App
// (plan docs/progress/plans/events-kiosk/PLAN.md §9 E1).
//
// The header Events tab, the Check-in board's Events tab, the mobile Events
// lists and the till's pass cards used to read the ported prototype's
// in-memory events (`mockApi.ts:getEventsForDate`, `getActiveEventPasses`).
// They read the platform now — `GET /events` and `GET /events/passes`, which
// read the OTO App through its views — and this maps the answer into the
// prototype's own `OtoEvent` shape, so every screen keeps its exact rendering
// path: the design, the words and the roster arithmetic in `lib/eventRoster.ts`
// are the prototype's, only the data source changed.
//
// S2-20 E2 adds the first writes: selling a pass and adding a walk-up
// (`sellOnPlatform`, the port of `sellEventPass`), and the branch's walk-up
// prices. S2-20 E4 puts the party tab on the platform (`api/parties.ts`).
// Checking a child in or out and a reprint are written by E3; until then
// those buttons answer with `EVENT_WRITE_PENDING` rather than act on an event
// the mock store has never heard of.

import { useEffect, useRef, useState } from 'react';
import type {
  EventAttendeeCreateBody,
  EventAttendeeInput,
  EventAttendeeView,
  EventAttendeeWriteAnswer,
  EventCheckinView,
  EventDayAnswer,
  EventDropInPricing,
  EventDropInPricingAnswer,
  EventPartyWalkUpCharge,
  EventPassSellBody,
  EventPassesAnswer,
  EventView,
  PartyChargeView,
  PartyPaymentView,
} from '@oto/shared';
import type { NewEventAttendeeInput } from '@/mockApi';
import type {
  EventAttendee,
  EventAttendeeCheckin,
  OtoEvent,
  PartyBooking,
  PartyExtraCharge,
  PartyPayment,
} from '@/types';
import { branchTradingDate, resolveRateToday, serverTradingDate } from '@/lib/pricingMode';
import { paymentMethodKind } from '@/lib/payments';
import { currentLane } from '@/lib/lane';
import { apiBranchIdForSlug } from './catalogBridge';
import { api, ApiError, NetworkError } from './client';

/** A till with no platform branch, in the counter's words (like the check-in board's). */
export const EVENTS_NOT_LINKED =
  "This till isn't linked to a park on the platform, so it has no events to show. Sign out and back in, or ask an administrator.";

/**
 * What a button on an event says until its write is on the platform (E2 to
 * E4). The event came from the OTO App, so the prototype's in-memory mutators
 * cannot find it; saying so beats a toast that claims the child is "already
 * checked in" when nothing happened.
 */
export const EVENT_WRITE_PENDING = {
  title: 'Not on the platform yet',
  description: 'This event comes from the OTO App, and the till cannot change it here yet. Use the OTO App for now.',
} as const;

/**
 * S2-20 E2 (review, finding 10) — what a pass or walk-up says when staff chose
 * "Check in now" (or a party's "Add & check in"). The child is added on the
 * platform, but checking in — the bands — is E3's, so the toast says the child
 * is not checked in and keeps the gate's own instruction for that half, rather
 * than the prototype's words for a check-in that ran and minted no band.
 */
export const EVENT_CHECKIN_NOT_YET = 'Checking in is not on the platform yet — use the OTO App for now.';

/** The branch's trading day: the platform's answer while it is live, else this device's clock on the branch's calendar. */
export function eventsToday(): string {
  return serverTradingDate() ?? branchTradingDate();
}

const baht = (satang: number | null | undefined): number => (satang ?? 0) / 100;

/**
 * One day's check-in, in the prototype's shape. The band codes are E3's — a
 * child checked in through the OTO App has none — so the badge reads "Band —"
 * rather than inventing one.
 */
export function toEventCheckin(c: EventCheckinView): EventAttendeeCheckin {
  return {
    checkedInAt: c.checkedInAt ?? c.checkedOutAt ?? '',
    ...(c.status === 'checked_out' && c.checkedOutAt ? { checkedOutAt: c.checkedOutAt } : {}),
    wristbandCode: '—',
    operatorName: c.checkedInBy ?? '—',
    operatorId: '',
  };
}

/**
 * A registered child, in the prototype's shape. The flags are the OTO App's:
 * any allergy or diet text at all raises them. A camp's `attendanceDays` are
 * written out by the platform — a registration naming no day carries every day
 * of the camp — so `bucketAttendee` places the child exactly as the platform
 * does; a one-off event or a party carries none, as in the prototype.
 */
export function toEventAttendee(a: EventAttendeeView, type: OtoEvent['type']): EventAttendee {
  return {
    id: a.id,
    name: a.name,
    ...(a.age !== null ? { age: a.age } : {}),
    ...(a.dateOfBirth ? { dateOfBirth: a.dateOfBirth } : {}),
    ...(a.language ? { language: a.language } : {}),
    allergyFlag: a.allergy !== null,
    ...(a.allergy ? { allergyDetail: a.allergy } : {}),
    dietaryFlag: a.dietary !== null,
    ...(a.dietary ? { dietaryDetail: a.dietary } : {}),
    ...(type === 'camp' ? { attendanceDays: a.attendanceDays } : {}),
    parentName: a.parentName ?? '',
    ...(a.parentPhone ? { parentPhone: a.parentPhone } : {}),
    ...(a.notes ? { notes: a.notes } : {}),
    parentAttending: a.parentAttending,
    checkinByDate: Object.fromEntries(a.checkins.map((c) => [c.date, toEventCheckin(c)])),
    // S2-20 E2 — a child the till added, and whether the OTO App has them yet.
    ...(a.syncState ? { syncState: a.syncState } : {}),
  };
}

/**
 * S2-20 E2 — a party walk-up as the party's bill shows it: the "Walk-up guest —
 * name" ticket charge `sellEventPass` puts on the tab (lib/eventPass.ts 65-71),
 * so `partyExtraChargeGroups` lists it under "Extra tickets" and the
 * outstanding balance counts it.
 */
export function walkUpChargeToExtra(c: EventPartyWalkUpCharge): PartyExtraCharge {
  const amount = baht(c.amountSatang);
  return {
    id: c.id,
    kind: 'ticket',
    items: [{ name: `Walk-up guest — ${c.name}`, qty: 1, lineTotal: amount }],
    total: amount,
    chargedBy: c.chargedBy ?? '—',
    chargedById: c.chargedById ?? '',
    chargedAt: c.chargedAt,
  };
}

/**
 * S2-20 E4 — a charge the till put on a party's tab, as the bill shows it
 * (`PartyExtraCharge`): its items and total in baht, who and when.
 */
export function partyChargeToExtra(c: PartyChargeView): PartyExtraCharge {
  return {
    id: c.id,
    kind: c.kind,
    items: c.items.map((it) => ({ name: it.name, qty: it.qty, lineTotal: baht(it.lineTotalSatang) })),
    total: baht(c.totalSatang),
    chargedBy: c.chargedBy ?? '—',
    chargedById: c.chargedById ?? '',
    chargedAt: c.chargedAt,
  };
}

/** S2-20 E4 — a payment taken against a party's balance (`PartyPayment`), its tender's token kept. */
export function partyPaymentToPrototype(p: PartyPaymentView): PartyPayment {
  return {
    id: p.id,
    amount: baht(p.amountSatang),
    method: p.method,
    takenBy: p.takenBy ?? '—',
    takenById: p.takenById ?? '',
    takenAt: p.takenAt,
  };
}

/**
 * An event in the prototype's `OtoEvent` shape, under the till's own branch
 * slug. A party carries the bill the OTO App holds — its total as the base,
 * its deposit — as the till last edited it, and the POS's tab (E4): the
 * walk-up charges (E2) and the till's charges in the order they were made,
 * the payments taken, and the `updateParty` stamp. The kitchen plan, the run
 * of show and the line items are not in the views yet, so the party screen
 * shows none.
 */
export function toOtoEvent(v: EventView, branchSlug: string): OtoEvent {
  const event: OtoEvent = {
    id: v.id,
    branchId: branchSlug,
    type: v.type,
    status: v.status,
    title: v.title,
    date: v.startDate,
    startTime: v.startTime,
    endTime: v.endTime ?? '',
    location: v.location ?? '',
    expectedKids: v.expectedKids ?? 0,
    expectedAdults: v.expectedAdults ?? 0,
    ...(v.type === 'camp' && v.endDate ? { dateRange: { start: v.startDate, end: v.endDate } } : {}),
    ...(v.entryPrice
      ? { entryPriceTHB: { weekday: baht(v.entryPrice.weekdaySatang), weekend: baht(v.entryPrice.weekendSatang) } }
      : {}),
    ...(v.attendees ? { attendees: v.attendees.map((a) => toEventAttendee(a, v.type)) } : {}),
  };
  if (!v.party) return event;
  const party: Partial<PartyBooking> = {
    childName: v.party.childName ?? '',
    ...(v.party.kidTurningAge !== null ? { kidAge: v.party.kidTurningAge } : {}),
    parentName: v.party.parentName ?? v.party.bookingName ?? '',
    ...(v.party.parentPhone ? { whatsapp: v.party.parentPhone } : {}),
    ...(v.party.decoration ? { decoration: v.party.decoration } : {}),
    ...(v.party.activities ? { activities: v.party.activities } : {}),
    basePrice: baht(v.party.totalValueSatang),
    lineItems: [],
    deposit: baht(v.party.depositSatang),
    ...(v.party.depositDate ? { depositDate: v.party.depositDate } : {}),
    kitchen: { needed: false, kidsMenu: [], adultsMenu: [], foodItems: [], cake: { type: 'none' } },
    timeline: [],
    // The walk-ups and the till's charges share one ledger, as in the
    // prototype, in the order they went on the tab.
    partyExtraCharges: [
      ...(v.party.walkUpCharges ?? []).map(walkUpChargeToExtra),
      ...(v.party.charges ?? []).map(partyChargeToExtra),
    ].sort((a, b) => a.chargedAt.localeCompare(b.chargedAt)),
    partyPayments: (v.party.payments ?? []).map(partyPaymentToPrototype),
    ...(v.party.lastEdited
      ? {
          lastEditedBy: v.party.lastEdited.by ?? '—',
          lastEditedById: v.party.lastEdited.byId ?? '',
          lastEditedAt: v.party.lastEdited.at,
        }
      : {}),
    ...(v.party.editSync ? { editSync: { state: v.party.editSync.state, error: v.party.editSync.error } } : {}),
  };
  return { ...event, ...party };
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export const eventsApi = {
  day: (branchId: string, date?: string) =>
    api.get<EventDayAnswer>(`/events?branchId=${branchId}${date ? `&date=${date}` : ''}`),
  passes: (branchId: string, date?: string) =>
    api.get<EventPassesAnswer>(`/events/passes?branchId=${branchId}${date ? `&date=${date}` : ''}`),
  /**
   * S2-20 E2 — a party walk-up or a child on a free event. Keyed by the
   * till's attendee id, so a retry through a dropped connection replays.
   */
  addAttendee: (eventId: string, body: EventAttendeeCreateBody) =>
    api.post<EventAttendeeWriteAnswer>(`/events/${encodeURIComponent(eventId)}/attendees`, body, {
      idempotencyKey: `event-attendee:${body.attendeeId}`,
      ...(body.actionId ? { headers: { 'x-oto-action-id': body.actionId } } : {}),
    }),
  /**
   * S2-20 E2 — a paid pass, sold and paid in one press. The tender is in the
   * key, as the sales finalise's is: the same tender retried replays, and a
   * corrected one is a new request (which the platform answers from the
   * attendee id if the first one did land).
   */
  sellPass: (eventId: string, body: EventPassSellBody) =>
    api.post<EventAttendeeWriteAnswer>(`/events/${encodeURIComponent(eventId)}/passes`, body, {
      idempotencyKey: `event-pass:${body.attendeeId}:${body.tender.method}:${body.tender.tenderedSatang ?? ''}`,
      ...(body.actionId ? { headers: { 'x-oto-action-id': body.actionId } } : {}),
    }),
  /** S2-20 E2 — the branch's walk-up prices (camp day, event day, party guest), in satang. */
  dropInPricing: (branchId: string) =>
    api.get<EventDropInPricingAnswer>(`/branches/${encodeURIComponent(branchId)}/event-drop-in-pricing`),
  saveDropInPricing: (branchId: string, pricing: EventDropInPricing) =>
    api.put<EventDropInPricingAnswer>(`/branches/${encodeURIComponent(branchId)}/event-drop-in-pricing`, pricing),
};

// --- Writes (S2-20 E2) -------------------------------------------------------------

/**
 * WHAT STOPS A WALK-UP OR A PASS BEFORE ITS FORM OPENS (E1 review, finding 2).
 *
 * Everything the till can know before anybody is asked for a name or a payment
 * is asked here, by the till's pass card and the board's Add attendee alike —
 * so a refusal never arrives after staff confirmed money they had taken. What
 * only the platform can say (a price changed under the till, a camp that ended
 * a minute ago) is still refused there, with nothing written.
 */
export function eventWriteBlocker(
  event: OtoEvent,
  ctx: {
    branchSlug: string;
    stationId: string | null | undefined;
    /** The station's sell lanes; absent or empty is "does everything". */
    capabilities?: readonly string[] | null;
    today: string;
    online?: boolean;
  },
): { title: string; description: string } | null {
  if (!apiBranchIdForSlug(ctx.branchSlug)) {
    return { title: 'Not linked to the platform', description: EVENTS_NOT_LINKED };
  }
  const online = ctx.online ?? globalThis.navigator?.onLine !== false;
  if (!online || currentLane() === 'box') {
    return {
      title: 'No connection',
      description: 'Adding a child to an event needs the platform. Try again when this till is back online.',
    };
  }
  if (event.type === 'camp') {
    const end = event.dateRange?.end ?? null;
    const start = event.dateRange?.start ?? event.date;
    if (ctx.today < start || (end !== null && ctx.today > end)) {
      return { title: 'Camp not running today', description: 'This camp is not running today, so nobody can be added to it here.' };
    }
  }
  if (event.type !== 'party') {
    if (!event.entryPriceTHB) {
      return {
        title: 'No entry price',
        description: 'This event has no entry price in the OTO App yet, so nobody can be added to it at the till.',
      };
    }
    const paid = resolveRateToday(event.entryPriceTHB) > 0;
    const caps = ctx.capabilities ?? [];
    if (paid && (!ctx.stationId || (caps.length > 0 && !caps.includes('tickets')))) {
      return {
        title: 'Not a ticket till',
        description: 'This device is not set up as a ticket till, so it cannot take the payment for a pass.',
      };
    }
  }
  return null;
}

/** The ids one sale of a pass is made under, minted when its form opens and kept for every retry. */
export interface EventWriteIds {
  attendeeId: string;
  saleId: string;
  actionId: string;
}

/** The child as the platform takes them: the till's captured input, with nothing empty sent. */
export function toAttendeeInput(input: NewEventAttendeeInput): EventAttendeeInput {
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  const out: EventAttendeeInput = { name: input.name.trim(), parentName: input.parentName.trim() };
  if (input.age !== undefined && Number.isInteger(input.age)) out.age = input.age;
  if (input.dateOfBirth) out.dateOfBirth = input.dateOfBirth;
  const fields = {
    language: clean(input.language),
    allergyDetail: clean(input.allergyDetail),
    dietaryDetail: clean(input.dietaryDetail),
    notes: clean(input.notes),
    parentPhone: clean(input.parentPhone),
    emergencyContact: clean(input.emergencyContact),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  if (input.allergyFlag) out.allergyFlag = true;
  if (input.dietaryFlag) out.dietaryFlag = true;
  if (input.parentAttending) out.parentAttending = true;
  return out;
}

export type PlatformSellOutcome =
  | { ok: true; attendee: EventAttendee; answer: EventAttendeeWriteAnswer }
  | {
      ok: false;
      message: string;
      /**
       * Nothing answered, or the platform faulted: the same ids may be sent
       * again, and are a replay if the first one landed. A definite refusal is
       * not: the next press asks afresh, under new ids.
       */
      retryable: boolean;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `sellEventPass` (lib/eventPass.ts), ON THE PLATFORM. A paid camp or event
 * pass goes to `POST /events/:id/passes` with its tender — the sale and the
 * child in one transaction, so nothing is created without the payment; a party
 * walk-up and a free event go to `POST /events/:id/attendees`. Either way the
 * attendee exists before the "check in now / leave booked" choice is asked, as
 * the prototype's flow requires, and the answer says whether the OTO App has
 * the child yet.
 */
export async function sellOnPlatform(args: {
  event: OtoEvent;
  branchSlug: string;
  stationId: string | null | undefined;
  input: NewEventAttendeeInput;
  registerProperly: boolean;
  /** The tender for a paid pass; absent for a party walk-up or a free event. */
  paymentMethod?: string;
  /** The fee the till showed, baht. Sent so a price that moved is refused, never charged. */
  doorFeeTHB: number;
  ids: EventWriteIds;
  memberId?: string | null;
  childId?: string | null;
}): Promise<PlatformSellOutcome> {
  const branchId = apiBranchIdForSlug(args.branchSlug);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED, retryable: false };
  // A member or saved child the platform knows carries its id; one from the
  // prototype's in-memory store does not, and is simply not named.
  const memberId = args.memberId && UUID.test(args.memberId) ? args.memberId : null;
  const childId = memberId && args.childId && UUID.test(args.childId) ? args.childId : null;
  const base: EventAttendeeCreateBody = {
    branchId,
    attendeeId: args.ids.attendeeId,
    actionId: args.ids.actionId,
    attendee: toAttendeeInput(args.input),
    registerProperly: args.event.type === 'camp' ? args.registerProperly : false,
    ...(args.stationId ? { stationId: args.stationId } : {}),
    ...(memberId ? { memberId } : {}),
    ...(childId ? { childId } : {}),
  };
  try {
    const answer =
      args.paymentMethod && args.event.type !== 'party'
        ? await eventsApi.sellPass(args.event.id, {
            ...base,
            stationId: args.stationId ?? '',
            saleId: args.ids.saleId,
            tender: { method: args.paymentMethod, kind: paymentMethodKind(args.paymentMethod) },
            expectedTotalSatang: Math.round(args.doorFeeTHB * 100),
          })
        : await eventsApi.addAttendee(args.event.id, base);
    const attendee: EventAttendee = {
      ...args.input,
      id: answer.attendee.id,
      ...(args.event.type === 'camp' ? { attendanceDays: answer.attendee.attendanceDays } : {}),
      syncState: answer.attendee.syncState,
    };
    return { ok: true, attendee, answer };
  } catch (err) {
    const retryable =
      err instanceof NetworkError ||
      !(err instanceof ApiError) ||
      err.status >= 500 ||
      err.code === 'IDEMPOTENCY_IN_FLIGHT';
    return { ok: false, message: messageOf(err), retryable };
  }
}

/**
 * THE BRANCH'S WALK-UP PRICES (`getEventDropInPricing`), in baht as the
 * prototype's screens hold them: what a party walk-up adds to the tab. ฿0
 * everywhere until the answer is in, which is also what an unpriced branch
 * answers.
 */
export function useEventDropInPricing(branchSlug: string, refreshKey: unknown = 0): {
  campDayTHB: { weekday: number; weekend: number };
  eventDayTHB: { weekday: number; weekend: number };
  partyGuestTHB: { weekday: number; weekend: number };
} {
  const [pricing, setPricing] = useState<EventDropInPricing | null>(null);
  useEffect(() => {
    const branchId = apiBranchIdForSlug(branchSlug);
    if (!branchId) {
      setPricing(null);
      return;
    }
    let live = true;
    eventsApi
      .dropInPricing(branchId)
      .then((answer) => {
        if (live) setPricing(answer.pricing);
      })
      .catch(() => {
        // Kept as it was: the walk-up form still opens; the platform prices the charge itself.
      });
    return () => {
      live = false;
    };
  }, [branchSlug, refreshKey]);
  const pair = (p: { weekday: number; weekend: number } | undefined) => ({
    weekday: baht(p?.weekday),
    weekend: baht(p?.weekend),
  });
  return {
    campDayTHB: pair(pricing?.campDay),
    eventDayTHB: pair(pricing?.eventDay),
    partyGuestTHB: pair(pricing?.partyGuest),
  };
}

export interface EventsForDate {
  /** The day's events, in the prototype's shape; the last answer while a new one loads. */
  events: OtoEvent[];
  /** False until the first answer (or refusal) for this branch and day has come back. */
  loaded: boolean;
  /** Why there is no list, in the counter's words; null when there is one. */
  error: string | null;
}

/**
 * THE DAY'S EVENTS (`getEventsForDate`, now `GET /events`), for the till's
 * branch on `date`. Read again whenever `refreshKey` changes — the screens bump
 * it where the prototype re-read its store — and an answer that arrives after
 * a newer question is dropped.
 */
export function useEventsForDate(branchSlug: string, date: string, refreshKey: unknown = 0): EventsForDate {
  const [state, setState] = useState<EventsForDate & { key: string }>({
    key: '',
    events: [],
    loaded: false,
    error: null,
  });
  const asked = useRef(0);
  useEffect(() => {
    const key = `${branchSlug}|${date}`;
    const branchId = apiBranchIdForSlug(branchSlug);
    const ask = ++asked.current;
    if (!branchId) {
      setState({ key, events: [], loaded: true, error: EVENTS_NOT_LINKED });
      return;
    }
    // Another day starts empty; the same day keeps its list while it refreshes.
    setState((s) => (s.key === key ? s : { key, events: [], loaded: false, error: null }));
    eventsApi
      .day(branchId, date)
      .then((answer) => {
        if (ask !== asked.current) return;
        setState({ key, events: answer.events.map((e) => toOtoEvent(e, branchSlug)), loaded: true, error: null });
      })
      .catch((err: unknown) => {
        if (ask !== asked.current) return;
        setState((s) => ({ ...s, key, loaded: true, error: messageOf(err) }));
      });
  }, [branchSlug, date, refreshKey]);
  return { events: state.events, loaded: state.loaded, error: state.error };
}

/**
 * THE TILL'S PASS CARDS (`getActiveEventPasses`, now `GET /events/passes`):
 * each camp running today and each event today or later, at its flat price.
 * Today is the platform's business date. No passes, rather than an error on
 * the sell screen, when the till has no platform branch — the cards are an
 * offer, and the till sells tickets without them — and the last list kept
 * when one read fails.
 */
export function useEventPasses(branchSlug: string, refreshKey: unknown = 0): OtoEvent[] {
  const [passes, setPasses] = useState<OtoEvent[]>([]);
  const asked = useRef(0);
  useEffect(() => {
    const branchId = apiBranchIdForSlug(branchSlug);
    const ask = ++asked.current;
    if (!branchId) {
      setPasses([]);
      return;
    }
    eventsApi
      .passes(branchId)
      .then((answer) => {
        if (ask === asked.current) setPasses(answer.passes.map((e) => toOtoEvent(e, branchSlug)));
      })
      .catch(() => {
        // Kept as it was: a blip in the mall's link must not empty the cards.
      });
  }, [branchSlug, refreshKey]);
  return passes;
}
