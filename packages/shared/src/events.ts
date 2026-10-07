import { z } from 'zod';
import { addDaysToIsoDate } from './business-date';
import { isIsoDate } from './dates';

/**
 * S2-20 E1 (SCRUM-217) — the events, camps and parties the POS reads from the
 * OTO App, as the api answers them and a box holds them (plan
 * docs/progress/plans/events-kiosk/PLAN.md §3, §4, §9 E1).
 *
 * The OTO App owns every event, registration and check-in (C10, Q1); the
 * platform reads them through the `otoapp_v` views and answers in these shapes.
 * The rules below are the prototype's, ported:
 *
 *   - **which events a day lists** — `getEventsForDate` (mockApi.ts:3608), with
 *     the one fix the plan makes on screen (§4, Q4's default): a camp is listed
 *     on EVERY day of its range, not on its first day only;
 *   - **which events are sold as passes** — `getActiveEventPasses`
 *     (mockApi.ts:3636): a camp whose range covers the day and a one-off event
 *     on the day or later; never a party, which has no flat price;
 *   - **where a child sits on a day's roster** — `bucketAttendee` and
 *     `computeRosterStats` (lib/eventRoster.ts): in, out, outstanding, and for
 *     a camp "not today" when the child is not registered for that day, which
 *     is left out of the totals.
 */

export const OTO_EVENT_TYPES = ['party', 'camp', 'event'] as const;
export type OtoEventType = (typeof OTO_EVENT_TYPES)[number];

/**
 * The prototype's four party statuses (`PartyStatus`), which are also the OTO
 * App's default event statuses. A tenant may add statuses of its own in the
 * app; one the POS has no label for is answered as `upcoming`, with the app's
 * own value beside it (`appStatus`).
 */
export const OTO_EVENT_STATUSES = ['upcoming', 'in_progress', 'completed', 'cancelled'] as const;
export type OtoEventStatus = (typeof OTO_EVENT_STATUSES)[number];

export function otoEventStatusOf(appStatus: string): OtoEventStatus {
  return (OTO_EVENT_STATUSES as readonly string[]).includes(appStatus)
    ? (appStatus as OtoEventStatus)
    : 'upcoming';
}

/** Where a child sits on a day's roster (`RosterBucket`, lib/eventRoster.ts). */
export const EVENT_ROSTER_BUCKETS = ['in', 'out', 'outstanding', 'notToday'] as const;
export type EventRosterBucket = (typeof EVENT_ROSTER_BUCKETS)[number];

/** The far end of "today or later": the passes list's upper bound. */
export const EVENTS_FAR_FUTURE = '9999-12-31';

/**
 * A camp longer than this is not a camp but bad data (a mistyped end year), and
 * is not expanded day by day: a registration that attends "every day" of it is
 * read as attending the first `CAMP_MAX_DAYS` days.
 */
export const CAMP_MAX_DAYS = 366;

/** Every day from `start` to `end`, both included — a camp's range (`campRangeDays`, mockApi.ts:3702). */
export function campDays(start: string, end: string): string[] {
  if (!isIsoDate(start) || !isIsoDate(end) || end < start) return [];
  const days: string[] = [];
  for (let d = start; d <= end && days.length < CAMP_MAX_DAYS; d = addDaysToIsoDate(d, 1)) {
    days.push(d);
  }
  return days;
}

interface DatedEvent {
  type: OtoEventType;
  startDate: string;
  /** A camp's last day, or null for an open-ended camp. A one-day event's own date. */
  endDate: string | null;
}

/**
 * Does the day's list show this event?
 *
 * One-off events and parties on their own day. A camp on EVERY day of its range
 * (Q4's default): the prototype matched a camp on its start date only
 * (`e.date === date`), so from its second day the Check-in board stopped
 * listing it — although its passes list, its roster's "not today" bucket, its
 * per-day check-in and its full-range walk-up all assume the camp is there each
 * day. An open-ended camp is listed from its first day on, as the OTO App's own
 * check-in screen reads it (`/api/core/camp-checkins/today`).
 */
export function eventListedOn(event: DatedEvent, date: string): boolean {
  if (event.type === 'camp') {
    return event.startDate <= date && (event.endDate === null || event.endDate >= date);
  }
  return event.startDate === date;
}

/** A flat weekday/weekend pass price in satang, or null when the event has none. */
export interface EventEntryPrice {
  weekdaySatang: number;
  weekendSatang: number;
}

/**
 * Is this event sold as a pass at the till on `date`? (`getActiveEventPasses`)
 *
 * A camp whose range covers the day; a one-off event dated the day or later; a
 * party never. And only with a price: the prototype's camps and events all
 * carry one, while an OTO App event made before the entry price existed has
 * none — and a pass sold at no price is a free pass, which is not what an
 * unset price means. Such an event is still on the day's list; it is only not
 * offered for sale (QUESTIONS, E1 report).
 */
export function eventPassOfferedOn(
  event: DatedEvent & { entryPrice: EventEntryPrice | null },
  date: string,
): boolean {
  if (event.type === 'party' || event.entryPrice === null) return false;
  if (event.type === 'camp') return eventListedOn(event, date);
  return event.startDate >= date;
}

/**
 * The days a registration attends, as the prototype's `attendanceDays` holds
 * them. A camp registration that names no day attends every day of the camp —
 * the OTO App's own rule — so those are written out (through `asOf` for an
 * open-ended camp); a one-off event or a party is one day and carries none.
 */
export function attendanceDaysOf(
  event: DatedEvent,
  registration: { attendsAllDays: boolean; attendanceDays: readonly string[] },
  asOf: string,
): string[] {
  if (event.type !== 'camp') return [];
  if (!registration.attendsAllDays) return [...registration.attendanceDays].filter(isIsoDate).sort();
  const last = event.endDate ?? (asOf > event.startDate ? asOf : event.startDate);
  return campDays(event.startDate, last);
}

/** One day's check-in, as the roster reads it: present only once the child arrived. */
export interface EventDayCheckin {
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

/**
 * `bucketAttendee` (lib/eventRoster.ts), on the platform's facts: checked out,
 * checked in, and otherwise outstanding — unless the child is on a camp and not
 * registered for the day, which is "not today".
 *
 * `attendsOnDate` is decided by the caller from the written-out days
 * (`attendanceDaysOf`). The one place this departs from the prototype is a
 * camp registration whose day list the OTO App could not read at all — the
 * views read that as attending NO day, so it is "not today" here rather than
 * the prototype's "an empty list is every day".
 */
export function eventRosterBucket(
  checkin: EventDayCheckin | null | undefined,
  isCamp: boolean,
  attendsOnDate: boolean,
): EventRosterBucket {
  if (checkin?.checkedOutAt) return 'out';
  if (checkin?.checkedInAt) return 'in';
  if (isCamp && !attendsOnDate) return 'notToday';
  return 'outstanding';
}

export interface EventRosterStats {
  /** Checked in + checked out: everybody who showed up. */
  arrived: number;
  /** Arrived + still outstanding: today's session only. */
  expected: number;
  /** Still on the premises. */
  currentlyIn: number;
  /** Not yet checked in. */
  outstanding: number;
  /** Every bucket, "not today" included. */
  all: number;
}

/** `computeRosterStats` (lib/eventRoster.ts) over the buckets of a full roster. */
export function eventRosterStats(buckets: readonly EventRosterBucket[]): EventRosterStats {
  let inN = 0;
  let outN = 0;
  let outstandingN = 0;
  let notTodayN = 0;
  for (const b of buckets) {
    if (b === 'in') inN += 1;
    else if (b === 'out') outN += 1;
    else if (b === 'notToday') notTodayN += 1;
    else outstandingN += 1;
  }
  return {
    arrived: inN + outN,
    expected: inN + outN + outstandingN,
    currentlyIn: inN,
    outstanding: outstandingN,
    all: inN + outN + outstandingN + notTodayN,
  };
}

/** Whole years of age on `date` for a `yyyy-mm-dd` date of birth; null when either is not a date. */
export function ageOnDate(dateOfBirth: string | null, date: string): number | null {
  if (!dateOfBirth || !isIsoDate(dateOfBirth) || !isIsoDate(date) || dateOfBirth > date) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

// --- What the api answers ----------------------------------------------------

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const EventCheckinViewSchema = z.object({
  date: IsoDate,
  status: z.enum(['checked_in', 'checked_out']),
  checkedInAt: z.string().nullable(),
  /** Whoever the OTO App or the till recorded: a name as typed, not an account. */
  checkedInBy: z.string().nullable(),
  checkedOutAt: z.string().nullable(),
  checkedOutBy: z.string().nullable(),
  /** The id a directory caller minted for the check-in; null for one made in the OTO App. */
  checkinRef: z.string().nullable(),
});
export type EventCheckinView = z.infer<typeof EventCheckinViewSchema>;

export const EventAttendeeViewSchema = z.object({
  id: z.string(),
  /** The registration, which is the OTO App's child (`otoapp_v.children` is keyed by it). */
  childId: z.string(),
  recordKind: z.enum(['camp_registration', 'event_attendee']),
  name: z.string(),
  age: z.number().int().nullable(),
  dateOfBirth: z.string().nullable(),
  language: z.string().nullable(),
  /** Allergy and medical text, staff-only (R-58); null when none was given. */
  allergy: z.string().nullable(),
  /** Food restrictions; null when none were given. */
  dietary: z.string().nullable(),
  parentName: z.string().nullable(),
  parentPhone: z.string().nullable(),
  parentAttending: z.boolean(),
  /** A camp's days, written out (`attendanceDaysOf`); empty for a one-off event or a party. */
  attendanceDays: z.array(IsoDate),
  attendsAllDays: z.boolean(),
  /** Registered for the day asked about. Always true off a camp. */
  attendsOnDate: z.boolean(),
  notes: z.string().nullable(),
  isOneTime: z.boolean(),
  source: z.string().nullable(),
  /** The day asked about's check-in only (a day's list, a roster), or every day's (one event). */
  checkins: z.array(EventCheckinViewSchema),
  /** Where the child sits on the day asked about. */
  bucket: z.enum(EVENT_ROSTER_BUCKETS),
  /**
   * S2-20 E2 — for a child the POS added, whether the OTO App has them yet;
   * null for one registered in the OTO App itself. A `pending` or `failed`
   * child is on the roster from the POS's own record (plan §4: "a failed write
   * shows pending on the roster instead of disappearing").
   */
  syncState: z.enum(['synced', 'pending', 'failed']).nullable(),
});
export type EventAttendeeView = z.infer<typeof EventAttendeeViewSchema>;

export const EventRosterStatsSchema = z.object({
  arrived: z.number().int(),
  expected: z.number().int(),
  currentlyIn: z.number().int(),
  outstanding: z.number().int(),
  all: z.number().int(),
});

export const EventEntryPriceSchema = z.object({
  weekdaySatang: z.number().int(),
  weekendSatang: z.number().int(),
});

/**
 * S2-20 E2 — a walk-up guest the till added to a party: the "Walk-up guest —
 * name" ticket charge `sellEventPass` puts on the party's tab at the
 * party-guest price (lib/eventPass.ts 63-71). Read from the POS's own record
 * until the party tab is on the platform (E4).
 */
export const EventPartyWalkUpChargeSchema = z.object({
  /** The attendee link: the walk-up's own id. */
  id: z.string(),
  name: z.string(),
  amountSatang: z.number().int(),
  chargedBy: z.string().nullable(),
  chargedById: z.string().nullable(),
  chargedAt: z.string(),
});
export type EventPartyWalkUpCharge = z.infer<typeof EventPartyWalkUpChargeSchema>;

// --- The party tab (S2-20 E4) ------------------------------------------------------

/** What a party charge was for (`PartyExtraCharge.kind`): extra play tickets or F&B. */
export const PARTY_CHARGE_KINDS = ['ticket', 'fnb'] as const;
export type PartyChargeKind = (typeof PARTY_CHARGE_KINDS)[number];

/** One line of a charge's breakdown, as the till listed it (descriptive: the charge's total is what is owed). */
export const PartyChargeItemSchema = z.object({
  name: z.string().trim().min(1).max(300),
  qty: z.number().int().min(0).max(10_000),
  lineTotalSatang: z.number().int().min(0).max(10_000_000_000),
});
export type PartyChargeItem = z.infer<typeof PartyChargeItemSchema>;

/**
 * S2-20 E4 — a charge the till put on a party's tab (`PartyExtraCharge`): a
 * ledger entry, never a sale — no kitchen ticket, no stock, no bands (Q3).
 */
export const PartyChargeViewSchema = z.object({
  id: z.string(),
  kind: z.enum(PARTY_CHARGE_KINDS),
  items: z.array(PartyChargeItemSchema),
  totalSatang: z.number().int(),
  chargedBy: z.string().nullable(),
  chargedById: z.string().nullable(),
  chargedAt: z.string(),
});
export type PartyChargeView = z.infer<typeof PartyChargeViewSchema>;

/**
 * S2-20 E4 — a payment taken against a party's balance (`PartyPayment`). The
 * money is a real tender (`pos.payment_attempt`, no sale behind it): `method`
 * is the token the till chose, `kind` the ledger's word for the money.
 */
export const PartyPaymentViewSchema = z.object({
  id: z.string(),
  amountSatang: z.number().int(),
  method: z.string(),
  kind: z.string(),
  takenBy: z.string().nullable(),
  takenById: z.string().nullable(),
  takenAt: z.string(),
  /** The trading day the money was taken on. */
  businessDate: IsoDate,
  /** The party's day when the money was taken: End of Day counts it when the two are the same day. */
  partyDate: IsoDate,
  attemptId: z.string(),
});
export type PartyPaymentView = z.infer<typeof PartyPaymentViewSchema>;

/** The stamp `updateParty` leaves: who edited the party at a till, and when. */
export const PartyLastEditedSchema = z.object({
  by: z.string().nullable(),
  byId: z.string().nullable(),
  at: z.string(),
});

/**
 * S2-20 E4 — an edit made at a till that the OTO App has not taken yet:
 * `pending` (no answer yet — shown on the party meanwhile) or `failed` (the app
 * refused it — not shown, and retried from Failures once the cause is fixed).
 */
export const PartyEditStateSchema = z.object({
  editId: z.string(),
  state: z.enum(['pending', 'failed']),
  error: z.string().nullable(),
  at: z.string(),
});
export type PartyEditState = z.infer<typeof PartyEditStateSchema>;

/**
 * The party's bill as the platform works it out (`computePartyTotal`,
 * `computePartyOutstanding`, lib/party.ts), in satang: total = base + line
 * items + charges (walk-ups included); outstanding = max(0, total − deposit −
 * payments).
 */
export const PartyBillSchema = z.object({
  baseSatang: z.number().int(),
  chargesSatang: z.number().int(),
  totalSatang: z.number().int(),
  depositSatang: z.number().int(),
  paidSatang: z.number().int(),
  outstandingSatang: z.number().int(),
});
export type PartyBill = z.infer<typeof PartyBillSchema>;

/** `computePartyTotal` and `computePartyOutstanding` (lib/party.ts), in satang. */
export function partyBillOf(input: {
  baseSatang: number;
  lineItemsSatang?: number;
  chargesSatang: number;
  depositSatang: number;
  paidSatang: number;
}): PartyBill {
  const totalSatang = input.baseSatang + (input.lineItemsSatang ?? 0) + input.chargesSatang;
  return {
    baseSatang: input.baseSatang,
    chargesSatang: input.chargesSatang,
    totalSatang,
    depositSatang: input.depositSatang,
    paidSatang: input.paidSatang,
    outstandingSatang: Math.max(0, totalSatang - input.depositSatang - input.paidSatang),
  };
}

export const EventPartyViewSchema = z.object({
  childName: z.string().nullable(),
  kidTurningAge: z.number().int().nullable(),
  bookingName: z.string().nullable(),
  parentName: z.string().nullable(),
  parentPhone: z.string().nullable(),
  activities: z.string().nullable(),
  decoration: z.string().nullable(),
  /** The OTO App's bill total, in satang. */
  totalValueSatang: z.number().int().nullable(),
  depositSatang: z.number().int().nullable(),
  depositDate: z.string().nullable(),
  /** S2-20 E2 — the walk-ups the till charged to this party's tab, oldest first. */
  walkUpCharges: z.array(EventPartyWalkUpChargeSchema),
  /**
   * S2-20 E4 — the party tab's POS ledgers and the till's edits. Optional in
   * the shape only so an answer from before E4 still reads; the api always
   * sends them for a party.
   */
  charges: z.array(PartyChargeViewSchema).optional(),
  payments: z.array(PartyPaymentViewSchema).optional(),
  lastEdited: PartyLastEditedSchema.nullable().optional(),
  editSync: PartyEditStateSchema.nullable().optional(),
  bill: PartyBillSchema.optional(),
});

export const EventViewSchema = z.object({
  id: z.string(),
  branchId: z.string(),
  type: z.enum(OTO_EVENT_TYPES),
  /** The OTO App's own type: birthday, private_event, school_group, other, studio_event, workshop or camp. */
  appEventType: z.string(),
  status: z.enum(OTO_EVENT_STATUSES),
  appStatus: z.string(),
  archived: z.boolean(),
  title: z.string(),
  startDate: IsoDate,
  endDate: IsoDate.nullable(),
  cancelledDays: z.array(z.string()),
  startTime: z.string(),
  endTime: z.string().nullable(),
  location: z.string().nullable(),
  expectedKids: z.number().int().nullable(),
  expectedAdults: z.number().int().nullable(),
  /** The flat pass price, or null when the OTO App has not set both halves. */
  entryPrice: EventEntryPriceSchema.nullable(),
  /** The party's own fields; null on a camp or an event. */
  party: EventPartyViewSchema.nullable(),
  /** Null where the attendees were not read (the passes list). */
  attendeeCount: z.number().int().nullable(),
  attendees: z.array(EventAttendeeViewSchema).optional(),
  /** The day asked about's roster counts; null where the attendees were not read. */
  roster: EventRosterStatsSchema.nullable(),
});
export type EventView = z.infer<typeof EventViewSchema>;

export const EventDayAnswerSchema = z.object({
  branchId: z.string(),
  /** The branch's business date the list is for — today's, unless a date was asked for. */
  date: IsoDate,
  events: z.array(EventViewSchema),
});
export type EventDayAnswer = z.infer<typeof EventDayAnswerSchema>;

export const EventPassesAnswerSchema = z.object({
  branchId: z.string(),
  date: IsoDate,
  passes: z.array(EventViewSchema),
});
export type EventPassesAnswer = z.infer<typeof EventPassesAnswerSchema>;

export const EventDetailAnswerSchema = z.object({
  branchId: z.string(),
  /** The day the attendees' buckets and the roster counts are for. */
  date: IsoDate,
  event: EventViewSchema,
});
export type EventDetailAnswer = z.infer<typeof EventDetailAnswerSchema>;

export const EventRosterAnswerSchema = z.object({
  branchId: z.string(),
  date: IsoDate,
  event: EventViewSchema,
  stats: EventRosterStatsSchema,
  /** Attendee ids per bucket, in the roster's order. */
  groups: z.object({
    in: z.array(z.string()),
    out: z.array(z.string()),
    outstanding: z.array(z.string()),
    notToday: z.array(z.string()),
  }),
});
export type EventRosterAnswer = z.infer<typeof EventRosterAnswerSchema>;

export const EventsDayQuerySchema = z.object({
  branchId: z.string().uuid(),
  date: IsoDate.optional(),
  type: z.enum(OTO_EVENT_TYPES).optional(),
});
export const EventsDateQuerySchema = z.object({
  branchId: z.string().uuid(),
  date: IsoDate.optional(),
});

// --- What a box holds --------------------------------------------------------

/**
 * One child on the box's copy of today's events: what a counter needs to find
 * a child, refuse a second check-in and print the bands with no internet, and
 * nothing more. No phone and no emergency contact — a box is a Pi in a mall
 * (`cacheBundle`'s doctrine) — but the allergy and diet lines, because a band
 * printed offline must still carry them (R-50, R-68).
 */
export const EventsCacheAttendeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().int().nullable(),
  allergy: z.string().nullable(),
  dietary: z.string().nullable(),
  parentName: z.string().nullable(),
  parentAttending: z.boolean(),
  attendsOnDate: z.boolean(),
  bucket: z.enum(EVENT_ROSTER_BUCKETS),
  checkin: z
    .object({
      status: z.enum(['checked_in', 'checked_out']),
      checkedInAt: z.string().nullable(),
      checkedOutAt: z.string().nullable(),
    })
    .nullable(),
});

export const EventsCacheEventSchema = z.object({
  id: z.string(),
  type: z.enum(OTO_EVENT_TYPES),
  status: z.enum(OTO_EVENT_STATUSES),
  title: z.string(),
  startDate: IsoDate,
  endDate: IsoDate.nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  location: z.string().nullable(),
  entryPrice: EventEntryPriceSchema.nullable(),
  attendees: z.array(EventsCacheAttendeeSchema),
});

/**
 * The `events` cache scope's one item: the branch's events on its business
 * day, applied whole. Volatile — every check-in moves it — so it is outside the
 * bundle's version and carries its own (`version`, over `date` and `events`).
 */
export const EventsCacheItemSchema = z.object({
  branchId: z.string(),
  date: IsoDate,
  version: z.string(),
  generatedAt: z.string(),
  events: z.array(EventsCacheEventSchema),
});
export type EventsCacheItem = z.infer<typeof EventsCacheItemSchema>;

// --- Writes: walk-ups and passes (S2-20 E2) --------------------------------------

/**
 * The note a walk-up is stamped with (`addEventAttendee`, mockApi.ts:3745):
 * who added the child, and whether "Also register for the full camp" was on.
 */
export function walkUpStamp(operatorName: string, registerProperly: boolean): string {
  return `Walk-up added by ${operatorName}${registerProperly ? ' (registered for full range)' : ' (today only)'}`;
}

/** The roster note: staff's own note, then the stamp (`notes ? notes + ' — ' + stamp : stamp`). */
export function walkUpNotes(notes: string | null | undefined, stamp: string): string {
  const own = notes?.trim();
  return own ? `${own} — ${stamp}` : stamp;
}

/**
 * The days a walk-up is registered for (`addEventAttendee`, mockApi.ts:3737):
 *
 *   - a camp, "Also register for the full camp" on, with a last day: every
 *     REMAINING day, today to the end — what the switch's own words say ("added
 *     to every remaining camp day"); the prototype's code added every day from
 *     the camp's first (Q5's default takes the label);
 *   - any other camp walk-up — the switch off, or an open-ended camp, which
 *     the prototype could only add for today (`registerProperly && dateRange`):
 *     today only;
 *   - a one-off event or a party: no days, they are one day.
 */
export function walkUpAttendanceDays(event: DatedEvent, registerProperly: boolean, today: string): string[] {
  if (event.type !== 'camp') return [];
  if (registerProperly && event.endDate !== null) {
    return campDays(today > event.startDate ? today : event.startDate, event.endDate);
  }
  return [today];
}

/**
 * How a walk-up is paid for (`sellEventPass`, lib/eventPass.ts 55-72):
 *
 *   - a party: the branch's party-guest walk-up price, on the party's tab, with
 *     no door payment;
 *   - a camp or an event: its own flat entry price, as a pass sale — or, at ฿0,
 *     the attendee with no sale.
 *
 * Both are resolved at the day's rate mode and never tiered (R-98).
 */
export type EventWalkUpBilling = 'sale' | 'party_tab' | 'free';

export function walkUpBillingOf(type: OtoEventType, feeSatang: number): EventWalkUpBilling {
  if (type === 'party') return 'party_tab';
  return feeSatang > 0 ? 'sale' : 'free';
}

/** The pass's line on the sale (`sellEventPass` 82-86): the svc ids kept for reports (Q2). */
export function eventPassService(type: 'camp' | 'event'): { serviceId: string; label: string } {
  return type === 'camp'
    ? { serviceId: 'svc-camp-pass', label: 'Camp day pass' }
    : { serviceId: 'svc-event-pass', label: 'Event entry pass' };
}

/** The pass's duration, as the prototype's synthetic ticket type carried it. */
export const EVENT_PASS_DURATION_LABEL = 'One-time';

/**
 * The child as the till captured them (`NewEventAttendeeInput`,
 * mockApi.ts:3685; `buildAttendeeInput`, AttendeeFormFields.tsx). A child's
 * name and a guardian's name are the two the form insists on.
 */
export const EventAttendeeInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  age: z.number().int().min(0).max(30).optional(),
  dateOfBirth: IsoDate.optional(),
  language: z.string().trim().max(100).optional(),
  allergyFlag: z.boolean().optional(),
  allergyDetail: z.string().trim().max(1500).optional(),
  dietaryFlag: z.boolean().optional(),
  dietaryDetail: z.string().trim().max(1500).optional(),
  notes: z.string().trim().max(1000).optional(),
  parentName: z.string().trim().min(1).max(200),
  parentPhone: z.string().trim().max(50).optional(),
  emergencyContact: z.string().trim().max(200).optional(),
  parentAttending: z.boolean().optional(),
});
export type EventAttendeeInput = z.infer<typeof EventAttendeeInputSchema>;

/** `POST /events/:id/attendees` — a party walk-up or a child on a free event. */
export const EventAttendeeCreateBodySchema = z.object({
  branchId: z.string().uuid(),
  /**
   * The attendee's id, minted by the till (UUIDv7). The OTO App stores the
   * child under it, so a retry with it is a replay, here and there.
   */
  attendeeId: z.string().uuid(),
  attendee: EventAttendeeInputSchema,
  /** "Also register for the full camp" (camps only). */
  registerProperly: z.boolean().default(false),
  /** The station the till is, when it has one. */
  stationId: z.string().uuid().optional(),
  /** The member the till identified, and the saved child it pre-filled from. */
  memberId: z.string().uuid().optional(),
  childId: z.string().uuid().optional(),
  actionId: z.string().min(1).max(200).optional(),
});
export type EventAttendeeCreateBody = z.infer<typeof EventAttendeeCreateBodySchema>;

/** The tender a pass is paid with — the till's "Confirm Payment Received". */
export const EventPassTenderSchema = z.object({
  /** The payment method's token, as configured for the branch. */
  method: z.string().min(1).max(40),
  kind: z.string().max(20).optional(),
  /** What this tender settles; the whole fee when absent. A pass is paid in one tender. */
  amountSatang: z.number().int().min(0).optional(),
  tenderedSatang: z.number().int().min(0).optional(),
  changeSatang: z.number().int().min(0).optional(),
  reference: z.string().max(120).optional(),
});
export type EventPassTender = z.infer<typeof EventPassTenderSchema>;

/** `POST /events/:id/passes` — a paid camp or event pass, sold and paid in one press. */
export const EventPassSellBodySchema = EventAttendeeCreateBodySchema.extend({
  stationId: z.string().uuid(),
  /** The pass sale's id, minted by the till. */
  saleId: z.string().uuid(),
  tender: EventPassTenderSchema,
  /** The fee the till showed. Compared, never charged: a stale price is refused. */
  expectedTotalSatang: z.number().int().min(0).optional(),
});
export type EventPassSellBody = z.infer<typeof EventPassSellBodySchema>;

export const EVENT_ATTENDEE_SYNC_STATE_VALUES = ['synced', 'pending', 'failed'] as const;
export type EventAttendeeSyncStateValue = (typeof EVENT_ATTENDEE_SYNC_STATE_VALUES)[number];

/** A child the POS added, as the till is answered. */
export const EventAttendeeLinkViewSchema = z.object({
  /** The till's attendee id. */
  id: z.string(),
  eventId: z.string(),
  eventType: z.enum(OTO_EVENT_TYPES),
  /** The OTO App's attendee once it answered — the same id, unless the app merged the child (its camp rule). */
  otoappAttendeeId: z.string().nullable(),
  merged: z.boolean(),
  billing: z.enum(['sale', 'party_tab', 'free']),
  priceSatang: z.number().int(),
  attendanceDays: z.array(IsoDate),
  parentAttending: z.boolean(),
  syncState: z.enum(EVENT_ATTENDEE_SYNC_STATE_VALUES),
  /** Why the OTO App does not have the child yet; null once it does. */
  syncError: z.string().nullable(),
  createdAt: z.string(),
});
export type EventAttendeeLinkView = z.infer<typeof EventAttendeeLinkViewSchema>;

export const EventAttendeeWriteAnswerSchema = z.object({
  attendee: EventAttendeeLinkViewSchema,
  /** The same attendee id was sent before; this is what that request made. */
  replayed: z.boolean(),
  /** The pass sale, when there is one. */
  sale: z
    .object({
      id: z.string(),
      receiptNumber: z.string().nullable(),
      grossSatang: z.number().int(),
      status: z.string(),
    })
    .nullable(),
  /** What closing the sale did not put on paper; empty when everything printed. */
  printingNotes: z.array(z.string()),
});
export type EventAttendeeWriteAnswer = z.infer<typeof EventAttendeeWriteAnswerSchema>;

// --- The branch's walk-up prices (Q8) ---------------------------------------------

const SatangPair = z.object({
  weekday: z.number().int().min(0).max(100_000_000),
  weekend: z.number().int().min(0).max(100_000_000),
});

/**
 * `EventDropInPricing` (types.ts:1876), in satang: three weekday/weekend pairs.
 * Only `partyGuest` is read anywhere — a pass is priced from its own event —
 * but all three are stored and shown on the Admin Events panel (Q8's default).
 */
export const EventDropInPricingSchema = z.object({
  campDay: SatangPair,
  eventDay: SatangPair,
  partyGuest: SatangPair,
});
export type EventDropInPricing = z.infer<typeof EventDropInPricingSchema>;

export const EventDropInPricingAnswerSchema = z.object({
  branchId: z.string(),
  pricing: EventDropInPricingSchema,
  /** False for a branch nobody has priced: every price is then ฿0, the prototype's own unpriced branch. */
  configured: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type EventDropInPricingAnswer = z.infer<typeof EventDropInPricingAnswerSchema>;

/** A branch nobody priced: ฿0 everywhere (catalogStore.ts, the second branch's seed). */
export const EVENT_DROP_IN_PRICING_NONE: EventDropInPricing = {
  campDay: { weekday: 0, weekend: 0 },
  eventDay: { weekday: 0, weekend: 0 },
  partyGuest: { weekday: 0, weekend: 0 },
};
