import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { branch } from '@oto/db';
import {
  EVENTS_FAR_FUTURE,
  ageOnDate,
  attendanceDaysOf,
  businessDate,
  parseDayStart,
  eventListedOn,
  eventPassOfferedOn,
  eventRosterBucket,
  eventRosterStats,
  otoEventStatusOf,
  type EventAttendeeView,
  type EventCheckinView,
  type EventDayAnswer,
  type EventDetailAnswer,
  type EventEntryPrice,
  type EventPartyWalkUpCharge,
  type EventPassesAnswer,
  type EventRosterAnswer,
  type EventRosterBucket,
  type EventView,
  type EventsCacheItem,
  type OtoEventType,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import {
  OtoAppSeamNotGrantedError,
  getBranchEvent,
  listAttendanceOfEvents,
  listAttendeesOfEvents,
  listBranchEvents,
  listSeamChildren,
  type SeamAttendance,
  type SeamAttendee,
  type SeamChild,
  type SeamEvent,
} from './otoapp-events';
import type { Exec } from './tx';
import { linksOfEvents, walkUpChargeOf } from './event-writes';
import type { DirectoryAttendeeBody } from './otoapp-directory';
import {
  billOfParty,
  editSyncOf,
  lastEditedOf,
  overlayPartyEdits,
  partyLedgersOf,
  type PartyLedgers,
} from './party-tab';

/** A link the POS wrote for a child it added, with who added them (S2-20 E2). */
type LinkWithStaff = Awaited<ReturnType<typeof linksOfEvents>>[number];

/**
 * S2-20 E1 — THE EVENTS READ SEAM (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md §9 E1).
 *
 * The day's events, one event, the passes the till sells and a day's roster,
 * read from the OTO App through the read-only repository
 * (`otoapp-events.ts`) and nothing else — this file names no OTO App table
 * and no view; the H1 grep holds it to that. The prototype's rules are ported
 * in `@oto/shared` (`events.ts`): which events a day lists (a camp on every
 * day of its range, Q4), which are sold as passes, and where each child sits
 * on a day's roster.
 *
 * "Today" is the branch's business date, never the UTC date the prototype
 * read (`toISOString().slice(0, 10)`, plan §4): between midnight and the
 * branch's day start the trading day is still yesterday's, exactly as the End
 * of Day and the sale service count it.
 *
 * Every read is branch-scoped twice: the route's guard checks
 * `pos:event:read` at the branch in the query, and the branch is loaded here
 * inside the caller's operator (404 for anybody else's) before the
 * repository — which fences every view by that platform branch — is asked.
 */

export const EVENTS_CACHE_REFRESH_JOB = 'job:events.cache_refresh';

interface BranchClock {
  id: string;
  timezone: string;
  dayStartMinutes: number;
}

/** The branch, inside the caller's operator — 404 for anybody else's, as `branchClockFor` answers. */
async function branchClockOf(db: Exec, operatorId: string, branchId: string): Promise<BranchClock> {
  const [row] = await db
    .select({ id: branch.id, timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return { id: row.id, timezone: row.timezone, dayStartMinutes: parseDayStart(row.dayStart) };
}

/** The day asked about, or the branch's business date now. */
const dayOf = (clock: BranchClock, date: string | undefined, now: Date): string =>
  date ?? businessDate(now, clock.timezone, clock.dayStartMinutes);

/**
 * The OTO App's seam is installed but this database role may not read it — a
 * deployment missing the post-import grants. Answered as a 503 that says so,
 * never as "no events": an empty list would tell a till there is nothing on
 * today when there is.
 */
async function seamRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof OtoAppSeamNotGrantedError) {
      throw new AppError(503, 'EVENTS_SEAM_NOT_GRANTED', err.message, { missing: err.missing });
    }
    throw err;
  }
}

function entryPriceOf(e: SeamEvent): EventEntryPrice | null {
  // Both halves or none: a pass priced on one kind of day only cannot be sold
  // on the other, and the POS has no rule for which half to borrow.
  if (e.entryPriceWeekdaySatang === null || e.entryPriceWeekendSatang === null) return null;
  return { weekdaySatang: e.entryPriceWeekdaySatang, weekendSatang: e.entryPriceWeekendSatang };
}

/** The OTO App's free text, or null when nothing was written. */
const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * The allergy and medical line, as the OTO App itself flags it: any text in
 * either field (`hasAllergy = !!(reg.allergiesNotes || reg.allergies)`,
 * camp-detail.tsx). Nothing is second-guessed — a parent who wrote "None" is
 * shown "None", because a missed allergy costs more than a read one.
 */
function allergyOf(child: SeamChild | undefined): string | null {
  const parts = [text(child?.allergies), text(child?.allergyNotes)].filter(
    (p): p is string => p !== null,
  );
  return parts.length > 0 ? [...new Set(parts)].join(' — ') : null;
}

const instant = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function checkinOf(row: SeamAttendance): EventCheckinView | null {
  // A row the OTO App seeded as `waiting` is a child expected, not one who
  // arrived: the roster has no check-in for them.
  if (row.status === 'waiting') return null;
  return {
    date: row.attendanceDate,
    status: row.status,
    checkedInAt: instant(row.checkedInAt),
    checkedInBy: row.checkedInBy,
    checkedOutAt: instant(row.checkedOutAt),
    checkedOutBy: row.checkedOutBy,
    checkinRef: row.checkinRef,
  };
}

function attendeeView(
  event: SeamEvent,
  a: SeamAttendee,
  child: SeamChild | undefined,
  rows: readonly SeamAttendance[],
  date: string,
): EventAttendeeView {
  const isCamp = event.type === 'camp';
  const attendanceDays = attendanceDaysOf(event, a, date);
  const attendsOnDate = isCamp ? attendanceDays.includes(date) : true;
  const checkins = rows.map(checkinOf).filter((c): c is EventCheckinView => c !== null);
  const onDate = checkins.find((c) => c.date === date) ?? null;
  return {
    id: a.id,
    childId: a.childId,
    recordKind: a.recordKind,
    name: a.childName,
    age: child?.ageYears ?? ageOnDate(child?.dateOfBirth ?? null, date),
    dateOfBirth: child?.dateOfBirth ?? null,
    language: text(child?.language),
    allergy: allergyOf(child),
    dietary: text(child?.foodRestrictions),
    parentName: text(a.parentName),
    parentPhone: text(a.parentPhone),
    parentAttending: a.parentAttending,
    attendanceDays,
    attendsAllDays: a.attendsAllDays,
    attendsOnDate,
    notes: text(a.notes),
    isOneTime: a.isOneTime,
    source: a.source,
    checkins,
    bucket: eventRosterBucket(onDate, isCamp, attendsOnDate),
    syncState: null,
  };
}

/**
 * S2-20 E2 — A CHILD THE POS ADDED THAT THE OTO APP DOES NOT HAVE YET: the
 * write-back is pending or was refused. The roster shows them from the POS's
 * own record of what it sent, marked, rather than leaving them off the list
 * (plan §4) — a child with a paid pass is at the door either way. No check-in
 * is read for them: the app has none to give.
 */
function unsyncedAttendeeView(
  event: SeamEvent,
  link: LinkWithStaff,
  date: string,
): EventAttendeeView | null {
  const sent = link.writeback as DirectoryAttendeeBody | null;
  if (!sent || link.syncState === 'synced') return null;
  const isCamp = event.type === 'camp';
  const attendanceDays = isCamp ? [...link.attendanceDays].sort() : [];
  const attendsOnDate = isCamp ? attendanceDays.includes(date) : true;
  const dateOfBirth = sent.dateOfBirth ?? null;
  return {
    id: link.id,
    childId: link.id,
    recordKind: isCamp ? 'camp_registration' : 'event_attendee',
    name: sent.childFullName,
    age: sent.ageYears ?? ageOnDate(dateOfBirth, date),
    dateOfBirth,
    language: text(sent.primaryLanguage),
    allergy: text(sent.allergies),
    dietary: text(sent.foodRestrictions),
    parentName: text(sent.parentName),
    parentPhone: text(sent.parentPhone),
    parentAttending: sent.parentAttending,
    attendanceDays,
    attendsAllDays: false,
    attendsOnDate,
    notes: text(sent.notes),
    isOneTime: true,
    source: 'pos',
    checkins: [],
    bucket: eventRosterBucket(null, isCamp, attendsOnDate),
    syncState: link.syncState,
  };
}

function eventView(
  e: SeamEvent,
  attendees: EventAttendeeView[] | null,
  walkUpCharges: EventPartyWalkUpCharge[] = [],
  tab: PartyLedgers | null = null,
): EventView {
  return {
    id: e.id,
    branchId: e.branchId,
    type: e.type,
    appEventType: e.appEventType,
    status: otoEventStatusOf(e.status),
    appStatus: e.status,
    archived: e.archived,
    title: e.title,
    startDate: e.startDate,
    endDate: e.endDate,
    cancelledDays: e.cancelledDays,
    startTime: e.startTime,
    endTime: e.endTime,
    location: e.location,
    expectedKids: e.expectedKids,
    expectedAdults: e.expectedAdults,
    entryPrice: entryPriceOf(e),
    party:
      e.type === 'party'
        ? {
            childName: e.childName,
            kidTurningAge: e.kidTurningAge,
            bookingName: e.bookingName,
            parentName: e.parentName,
            parentPhone: e.parentPhone,
            activities: e.activities,
            decoration: e.decoration,
            totalValueSatang: e.totalValueSatang,
            depositSatang: e.depositSatang,
            depositDate: e.depositDate,
            walkUpCharges,
            // S2-20 E4 — the party tab: the POS's ledgers, the till's edit
            // stamp and the bill. Read wherever the attendees are (a day's
            // list, one event, a roster); the passes list reads neither.
            ...(tab
              ? {
                  charges: tab.charges,
                  payments: tab.payments,
                  lastEdited: lastEditedOf(tab.edits),
                  editSync: editSyncOf(tab.edits),
                  bill: billOfParty(
                    e,
                    walkUpCharges.reduce((sum, c) => sum + c.amountSatang, 0),
                    tab,
                  ),
                }
              : {}),
          }
        : null,
    attendeeCount: attendees === null ? null : attendees.length,
    ...(attendees === null ? {} : { attendees }),
    roster: attendees === null ? null : eventRosterStats(attendees.map((a) => a.bucket)),
  };
}

/**
 * The events with their children: three reads for all of them together — the
 * registrations, the check-ins (of `date` only, or of every day) and the
 * children behind the registrations — never a round per event.
 */
async function withAttendees(
  db: Exec,
  branchId: string,
  events: readonly SeamEvent[],
  q: { date: string; checkinsOf: 'date' | 'all' },
): Promise<EventView[]> {
  if (events.length === 0) return [];
  const eventIds = events.map((e) => e.id);
  const registrations = await listAttendeesOfEvents(db, { branchId, eventIds });
  const attendance = await listAttendanceOfEvents(db, {
    branchId,
    eventIds,
    ...(q.checkinsOf === 'date' ? { date: q.date } : {}),
  });
  const children = await listSeamChildren(db, {
    branchId,
    ids: [...new Set(registrations.map((r) => r.childId))],
  });
  const childById = new Map(children.map((c) => [c.id, c]));
  const rowsOf = new Map<string, SeamAttendance[]>();
  for (const row of attendance) {
    rowsOf.set(row.attendeeId, [...(rowsOf.get(row.attendeeId) ?? []), row]);
  }
  // S2-20 E2 — the POS's own record of the children it added.
  const links = await linksOfEvents(db, { branchId, eventIds });
  // S2-20 E4 — the parties' tabs: the till's charges, payments and edits.
  const tabs = await partyLedgersOf(db, {
    branchId,
    eventIds: events.filter((e) => e.type === 'party').map((e) => e.id),
  });
  return events.map((seamEvent) => {
    const tab = seamEvent.type === 'party' ? (tabs.get(seamEvent.id) ?? null) : null;
    // A party is shown as the till last edited it, until the OTO App takes the edit.
    const e = tab ? overlayPartyEdits(seamEvent, tab.edits) : seamEvent;
    const own = links.filter((l) => l.otoappEventId === e.id);
    const seam = registrations.filter((r) => r.eventId === e.id);
    const inApp = new Set(seam.map((r) => r.id));
    // The link's state for a child the app does hold: by the app's id (a
    // merged registration's is not the till's), and by the till's own id for
    // a write the app took but whose answer never came back.
    const stateOf = new Map<string, EventAttendeeView['syncState']>();
    for (const l of own) {
      if (l.otoappAttendeeId && inApp.has(l.otoappAttendeeId)) stateOf.set(l.otoappAttendeeId, 'synced');
      else if (inApp.has(l.id)) stateOf.set(l.id, l.syncState);
    }
    const attendees = [
      ...seam.map((r) => ({
        ...attendeeView(e, r, childById.get(r.childId), rowsOf.get(r.id) ?? [], q.date),
        syncState: stateOf.get(r.id) ?? null,
      })),
      ...own
        .filter((l) => !inApp.has(l.id) && !(l.otoappAttendeeId && inApp.has(l.otoappAttendeeId)))
        .map((l) => unsyncedAttendeeView(e, l, q.date))
        .filter((a): a is EventAttendeeView => a !== null),
    ];
    const nameOf = new Map(attendees.map((a) => [a.id, a.name]));
    const charges =
      e.type === 'party'
        ? own
            .filter((l) => l.billing === 'party_tab')
            .map((l) =>
              walkUpChargeOf(
                l,
                (l.writeback as DirectoryAttendeeBody | null)?.childFullName ??
                  nameOf.get(l.otoappAttendeeId ?? l.id) ??
                  'Guest',
              ),
            )
        : [];
    return eventView(e, attendees, charges, tab);
  });
}

/** The prototype's day order: by start time (`getEventsForDate`), then title for a stable tie. */
const byStartTime = (a: EventView, b: EventView) =>
  a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title);

/**
 * `GET /events` — the branch's events on a day (`getEventsForDate`): every
 * type, a camp on every day of its range (Q4), each with its children and the
 * day's check-in state and roster counts. Archived events are not listed.
 */
export async function eventsForDay(
  db: Exec,
  q: { operatorId: string; branchId: string; date?: string; type?: OtoEventType; now: Date },
): Promise<EventDayAnswer> {
  const clock = await branchClockOf(db, q.operatorId, q.branchId);
  const date = dayOf(clock, q.date, q.now);
  return seamRead(async () => {
    const events = (await listBranchEvents(db, { branchId: clock.id, from: date, to: date })).filter(
      (e) => eventListedOn(e, date) && (q.type === undefined || e.type === q.type),
    );
    const views = await withAttendees(db, clock.id, events, { date, checkinsOf: 'date' });
    return { branchId: clock.id, date, events: views.sort(byStartTime) };
  });
}

/**
 * `GET /events/passes` — what the till sells as an event pass on a day
 * (`getActiveEventPasses`): a camp running that day and a one-off event that
 * day or later, never a party, and only at a price. Sorted by date, then start
 * time. The children are not read: a pass card shows none.
 */
export async function eventPassesFor(
  db: Exec,
  q: { operatorId: string; branchId: string; date?: string; now: Date },
): Promise<EventPassesAnswer> {
  const clock = await branchClockOf(db, q.operatorId, q.branchId);
  const date = dayOf(clock, q.date, q.now);
  return seamRead(async () => {
    const events = await listBranchEvents(db, {
      branchId: clock.id,
      from: date,
      to: EVENTS_FAR_FUTURE,
    });
    const passes = events
      .map((e) => eventView(e, null))
      .filter((v) => eventPassOfferedOn(v, date))
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || byStartTime(a, b));
    return { branchId: clock.id, date, passes };
  });
}

/**
 * `GET /events/:id` — one of the branch's events with every child and every
 * day's check-ins (`getEventById`); the buckets and counts are for `date`,
 * today's by default. An archived event is still answered by its id, marked.
 */
export async function eventById(
  db: Exec,
  q: { operatorId: string; branchId: string; eventId: string; date?: string; now: Date },
): Promise<EventDetailAnswer> {
  const clock = await branchClockOf(db, q.operatorId, q.branchId);
  const date = dayOf(clock, q.date, q.now);
  return seamRead(async () => {
    const event = await getBranchEvent(db, { branchId: clock.id, eventId: q.eventId });
    if (!event) throw errors.notFound('Event not found');
    const [view] = await withAttendees(db, clock.id, [event], { date, checkinsOf: 'all' });
    return { branchId: clock.id, date, event: view! };
  });
}

/**
 * `GET /events/:id/roster` — one event's roster on a day: its children with
 * that day's check-ins, the headline counts and the four groups, in the
 * roster's order (`groupAttendees`, `computeRosterStats`).
 */
export async function eventRoster(
  db: Exec,
  q: { operatorId: string; branchId: string; eventId: string; date?: string; now: Date },
): Promise<EventRosterAnswer> {
  const clock = await branchClockOf(db, q.operatorId, q.branchId);
  const date = dayOf(clock, q.date, q.now);
  return seamRead(async () => {
    const event = await getBranchEvent(db, { branchId: clock.id, eventId: q.eventId });
    if (!event) throw errors.notFound('Event not found');
    const [view] = await withAttendees(db, clock.id, [event], { date, checkinsOf: 'date' });
    const attendees = view!.attendees ?? [];
    const idsIn = (bucket: EventRosterBucket) =>
      attendees.filter((a) => a.bucket === bucket).map((a) => a.id);
    return {
      branchId: clock.id,
      date,
      event: view!,
      stats: view!.roster ?? eventRosterStats([]),
      groups: {
        in: idsIn('in'),
        out: idsIn('out'),
        outstanding: idsIn('outstanding'),
        notToday: idsIn('notToday'),
      },
    };
  });
}

// --- The box's copy -------------------------------------------------------------

/**
 * THE `events` CACHE SCOPE'S ONE ITEM: the branch's events on its business day,
 * as a box holds them for the offline path — the same day's list the till
 * reads (`eventsForDay`), cut down to what a counter needs to find a child,
 * refuse a second check-in and print the bands with no internet. No phone, no
 * emergency contact, no party bill. Its version is over the day and the
 * events, never over when it was built, so an unchanged day is an unchanged
 * copy.
 */
export async function eventsCacheItem(
  db: Exec,
  scope: { operatorId: string; branchId: string },
  now: Date,
): Promise<EventsCacheItem> {
  const day = await eventsForDay(db, { operatorId: scope.operatorId, branchId: scope.branchId, now });
  const events: EventsCacheItem['events'] = day.events.map((e) => ({
    id: e.id,
    type: e.type,
    status: e.status,
    title: e.title,
    startDate: e.startDate,
    endDate: e.endDate,
    startTime: e.startTime,
    endTime: e.endTime,
    location: e.location,
    entryPrice: e.entryPrice,
    attendees: (e.attendees ?? []).map((a) => {
      const onDate = a.checkins.find((c) => c.date === day.date) ?? null;
      return {
        id: a.id,
        name: a.name,
        age: a.age,
        allergy: a.allergy,
        dietary: a.dietary,
        parentName: a.parentName,
        parentAttending: a.parentAttending,
        attendsOnDate: a.attendsOnDate,
        bucket: a.bucket,
        checkin: onDate
          ? { status: onDate.status, checkedInAt: onDate.checkedInAt, checkedOutAt: onDate.checkedOutAt }
          : null,
      };
    }),
  }));
  const version = createHash('sha256')
    .update(JSON.stringify({ date: day.date, events }))
    .digest('hex')
    .slice(0, 16);
  return { branchId: day.branchId, date: day.date, version, generatedAt: now.toISOString(), events };
}

export interface EventsCacheRefreshDetail extends Record<string, unknown> {
  branches: number;
  events: number;
  attendees: number;
}

/**
 * `job:events.cache_refresh` — TODAY'S EVENTS, BUILT FOR THE BOXES (plan §5,
 * §10, hazard H19).
 *
 * On the rollup cadence, every live branch's box copy is built exactly as a
 * box is served it (`eventsCacheItem`), from the OTO App's seam. A box serves
 * its counter from the copy it last pulled; what makes that copy stale is the
 * seam it is built from failing — a view dropped by an app release, the
 * post-import grants missing — and the box's own pull leaves the scope out
 * rather than failing a whole cache pull over it (`cacheBundle`). This job is
 * where that failure is loud: it fails, the watchdog raises `ops.failing`
 * after three ticks in a row, and a job that stops running at all raises
 * `ops.missing` against the expectation registering it wrote. Counts only in
 * its detail, never a name.
 */
export async function runEventsCacheRefresh(db: Exec, now: Date): Promise<EventsCacheRefreshDetail> {
  const branches = await db
    .select({ id: branch.id, operatorId: branch.operatorId })
    .from(branch)
    .where(isNull(branch.archivedAt));
  const detail: EventsCacheRefreshDetail = { branches: 0, events: 0, attendees: 0 };
  for (const b of branches) {
    const item = await eventsCacheItem(db, { operatorId: b.operatorId, branchId: b.id }, now);
    detail.branches += 1;
    detail.events += item.events.length;
    detail.attendees += item.events.reduce((n, e) => n + e.attendees.length, 0);
  }
  return detail;
}
