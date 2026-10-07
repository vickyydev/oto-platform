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
// It is a READ. Adding a walk-up, selling a pass, checking a child in or out
// and the party tab are written by E2 to E4; until then those buttons answer
// with `EVENT_WRITE_PENDING` rather than act on an event the mock store has
// never heard of.

import { useEffect, useRef, useState } from 'react';
import type {
  EventAttendeeView,
  EventCheckinView,
  EventDayAnswer,
  EventPassesAnswer,
  EventView,
} from '@oto/shared';
import type { EventAttendee, EventAttendeeCheckin, OtoEvent, PartyBooking } from '@/types';
import { branchTradingDate, serverTradingDate } from '@/lib/pricingMode';
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
  };
}

/**
 * An event in the prototype's `OtoEvent` shape, under the till's own branch
 * slug. A party carries the bill the OTO App holds — its total as the base,
 * its deposit — and empty POS ledgers until the party tab is on the platform
 * (E4); the kitchen plan, the run of show and the line items are not in the
 * views yet, so the party screen shows none.
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
    partyExtraCharges: [],
    partyPayments: [],
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
};

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
