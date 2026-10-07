import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { band, bandEvent, eventAttendeeLink, eventCheckin, station } from '@oto/db';
import {
  EVENT_CHECKIN_REFUSALS,
  attendsOn,
  bandShortCode,
  businessDate,
  eventAllergyOf,
  eventListedOn,
  eventText,
  newId,
  type EventCheckinAnswer,
  type EventCheckinBody,
  type EventCheckinRecordView,
  type EventCheckinRefusal,
  type EventCheckoutBody,
  type EventPrintJobView,
  type EventReprintBody,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import type { BranchReach } from './access-control';
import { audit } from './audit';
import { BandKeyMissingError, mintEventBands } from './bands';
import {
  branchClockOf,
  pushAttendee,
  seamRead,
  staffNameOf,
  type BranchClock,
  type EventWriteDeps,
} from './event-writes';
import { recordRun } from './ops';
import {
  getBranchEvent,
  listEventAttendance,
  listEventAttendees,
  listSeamChildren,
  type SeamAttendance,
  type SeamEvent,
} from './otoapp-events';
import type { DirectoryAttendeeBody, DirectoryCheckinAnswer, DirectoryCheckinBody, DirectoryOutcome } from './otoapp-directory';
import type { ActorContext } from './sale';
import { queueEventBandPrints, type SalePrintJobView } from './sale-printing';
import { withTx, type Exec, type OpContext, type Tx } from './tx';

/**
 * S2-20 E3 — CHECK-IN, CHECK-OUT AND REPRINT AT AN EVENT (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md §3, §4, §8, Q1 and the E3 row of §9).
 *
 * The port of `checkInEventAttendee` and `checkOutEventAttendee`
 * (mockApi.ts:3785-3870) and of DropOff.tsx's `handleEventReprint`, on the
 * platform. The rules are the prototype's (`@oto/shared` `event-checkin.ts`
 * says them); the platform adds only what keeps them true with two tills, a
 * box with the link down and an OTO App that stays the master:
 *
 *   - ONE CHECK-IN PER CHILD PER DAY, held by a row lock and the unique key on
 *     (event, child, day) — a second till, or a box's fact from the link-down
 *     hours, is refused "Already checked in" and mints no second band (H4);
 *     a child the OTO App already has in for the day is refused too, because
 *     the app is the master of attendance (Q1) — and a POS check-in the app
 *     had and took back (its own "Undo check-in") no longer holds the day: it
 *     is set aside (`undone_at`, its bands revoked) when the child is next
 *     checked in;
 *   - THE APP'S WORD, WHATEVER ID NAMES THE CHILD: the till's own link id for a
 *     child the app merged into a registration of its own reads that
 *     registration — its days, its allergy line, its id (`eventChildOf`);
 *   - "NOT REGISTERED FOR TODAY" IS THE PLATFORM'S REFUSAL, not only the
 *     disabled button the prototype had (H5, plan §4) — the day is the
 *     branch's business date, never the device's;
 *   - THE BANDS are minted and signed by the S2-11 band service and printed
 *     through the S2-06 pipeline (`mintEventBands`, `queueEventBandPrints`): a
 *     kid band always, a parent band when the parent is attending. No sale, no
 *     credit, and NO SUPERVISION GATE — events are not drop-off (R-97, H6);
 *   - THE OTO APP IS TOLD, AFTER THE COMMIT, under the check-in id the till
 *     minted (`POST /api/directory/events/:id/attendees/:attendeeId/checkins`):
 *     an `ops_run` of kind `integration` named `otoapp:attendee.checkin`, the
 *     row `pending` or `failed` until the app has it, and a Retry on the
 *     Failures page that sends every check-in an outage left waiting — E2's
 *     write-back pattern, unchanged. A child the till added that the app does
 *     not have yet is written first, under the till's attendee id.
 *
 * The OTO App's directory has no check-out write yet, so a check-out is kept
 * on the POS's mirror and not written back (E3 report, QUESTIONS).
 *
 * The event and its children are read through the seam (`otoapp-events.ts`)
 * and nothing else: this file names no OTO App table and no view (H1).
 */

/** The ops run every check-in write-back is recorded under — the Failures page's name for it. */
export const ATTENDEE_CHECKIN_RUN = 'otoapp:attendee.checkin';

type CheckinRow = typeof eventCheckin.$inferSelect;
type LinkRow = typeof eventAttendeeLink.$inferSelect;
type BandRow = typeof band.$inferSelect;

/** A refusal in the counter's words, with its code. */
function refuse(status: number, r: EventCheckinRefusal, details?: Record<string, unknown>): AppError {
  return new AppError(status, r.code, r.message, details);
}

// --- Who is being checked in --------------------------------------------------------

/**
 * One child on one event, as a check-in needs them: what the bands print,
 * whether they attend the day, and every id the roster may name them by.
 */
export interface EventChild {
  /** The id the roster named them by — what the check-in is stored under. */
  attendeeId: string;
  /** The till's link, when the POS added the child. */
  link: LinkRow | null;
  /** Every id this child is known by: the roster's, the till's, the app's. */
  aliases: string[];
  childName: string;
  parentName: string | null;
  parentAttending: boolean;
  allergy: string | null;
  dietary: string | null;
  /** Registered for the day asked about (`attendsOn`, from the camp's range). */
  attends: boolean;
}

/** The till's links for an event that name this child, by the till's id or the app's. */
export async function linksNaming(db: Exec, eventId: string, attendeeId: string): Promise<LinkRow[]> {
  return db
    .select()
    .from(eventAttendeeLink)
    .where(
      and(
        eq(eventAttendeeLink.otoappEventId, eventId),
        isNull(eventAttendeeLink.archivedAt),
        or(eq(eventAttendeeLink.id, attendeeId), eq(eventAttendeeLink.otoappAttendeeId, attendeeId)),
      ),
    )
    .orderBy(asc(eventAttendeeLink.createdAt));
}

/**
 * The child, from the OTO App's registration when the app has them, else from
 * the till's own record of what it sent (a write-back still pending). Null when
 * neither knows them on this event.
 *
 * The app is the master of who the child is and which days they attend (Q1),
 * WHATEVER ID NAMES THEM: the roster names a child by the app's id, while the
 * till's "Check in now" after a pass sale names them by the till's own link id
 * — and for a child the app merged into a registration it already had (E2: the
 * same name and phone) those differ. A synced link is therefore read through to
 * the app's registration: its allergy line, its days, and its id, which the
 * check-in is stored under.
 */
export async function eventChildOf(
  db: Exec,
  branchId: string,
  event: SeamEvent,
  attendeeId: string,
  date: string,
): Promise<EventChild | null> {
  const id = attendeeId.toLowerCase();
  let links = await linksNaming(db, event.id, id);
  const registrations = await listEventAttendees(db, { branchId, eventId: event.id });
  const own = links.find((l) => l.id === id) ?? null;
  const appId = registrations.some((r) => r.id === id)
    ? id
    : own?.syncState === 'synced' && own.otoappAttendeeId
      ? own.otoappAttendeeId
      : null;
  const seam = appId ? (registrations.find((r) => r.id === appId) ?? null) : null;
  if (seam && seam.id !== id) {
    // Every link the app's registration is known by, so one child's day is one
    // day whichever of their ids the press named.
    const known = new Set(links.map((l) => l.id));
    links = [...links, ...(await linksNaming(db, event.id, seam.id)).filter((l) => !known.has(l.id))].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }
  const link = own ?? links[0] ?? null;
  const aliases = [
    ...new Set([id, ...(seam ? [seam.id] : []), ...links.flatMap((l) => [l.id, l.otoappAttendeeId ?? l.id])]),
  ];
  if (seam) {
    const [child] = await listSeamChildren(db, { branchId, ids: [seam.childId] });
    return {
      attendeeId: seam.id,
      link,
      aliases,
      childName: seam.childName,
      parentName: eventText(seam.parentName),
      parentAttending: seam.parentAttending,
      allergy: eventAllergyOf(child?.allergies, child?.allergyNotes),
      dietary: eventText(child?.foodRestrictions),
      attends: attendsOn(event, seam, date),
    };
  }
  // S2-20 E5 (closing audit, g) — a child the app HAD (the till's link is
  // `synced`) and no longer shows: the OTO App is the master of who is on the
  // event (Q1), and its registration is gone. Named by the till's link id or by
  // the app's own id, the answer is the same — not on this event — exactly as
  // the roster, which no longer lists them, says it.
  if (own?.syncState === 'synced') return null;
  // A child the till added that the app does not hold yet: from the body the
  // till sent.
  const sent = own?.writeback as DirectoryAttendeeBody | null | undefined;
  if (!own || !sent) return null;
  return {
    attendeeId: id,
    link: own,
    aliases,
    childName: sent.childFullName,
    parentName: eventText(sent.parentName),
    parentAttending: sent.parentAttending,
    allergy: eventText(sent.allergies),
    dietary: eventText(sent.foodRestrictions),
    attends: attendsOn(event, { attendsAllDays: false, attendanceDays: own.attendanceDays }, date),
  };
}

/**
 * The POS's check-ins of this child on this day, by any id the child is known
 * by — not one the OTO App took back (`undone_at`), which is history.
 */
export async function posCheckinsOf(
  db: Exec,
  eventId: string,
  child: Pick<EventChild, 'aliases' | 'link'>,
  date: string,
): Promise<CheckinRow[]> {
  return db
    .select()
    .from(eventCheckin)
    .where(
      and(
        eq(eventCheckin.otoappEventId, eventId),
        eq(eventCheckin.attendanceDate, date),
        isNull(eventCheckin.undoneAt),
        child.link
          ? or(inArray(eventCheckin.attendeeId, child.aliases), eq(eventCheckin.linkId, child.link.id))
          : inArray(eventCheckin.attendeeId, child.aliases),
      ),
    )
    .orderBy(asc(eventCheckin.checkedInAt));
}

/**
 * The OTO App's own record of this child on this day, when it has one that is
 * more than "waiting". `exceptCheckinId`: the app's row holding THIS check-in
 * id is this very press landed already (a copy of it got there first), not
 * another check-in.
 */
export async function appDayOf(
  db: Exec,
  branchId: string,
  eventId: string,
  aliases: readonly string[],
  date: string,
  exceptCheckinId?: string,
): Promise<SeamAttendance | null> {
  const rows = await listEventAttendance(db, { branchId, eventId, date });
  return (
    rows.find(
      (r) =>
        aliases.includes(r.attendeeId) &&
        r.status !== 'waiting' &&
        (exceptCheckinId === undefined || r.checkinRef !== exceptCheckinId),
    ) ?? null
  );
}

/**
 * The POS's rows for the day that the OTO App had and has taken back: each one
 * the app holds (`synced`) while the app's day no longer reads in or out — its
 * own "Undo check-in" set it back to "waiting". The app is the master (Q1), so
 * such a row no longer stands for the child's day. A row the app does not have
 * yet (`pending`, `failed`) is the POS's word until it does, and stands.
 *
 * Read the POS's rows BEFORE the app's day: a row turns `synced` only after the
 * app answered, so a row read as synced is one whose check-in the app's read
 * that follows can see.
 */
export function takenBackBy(rows: readonly CheckinRow[], appDay: SeamAttendance | null): CheckinRow[] {
  return appDay ? [] : rows.filter((r) => r.syncState === 'synced');
}

/**
 * The child's day as a check-out or a reprint decides it, under the day's
 * lock: the POS's check-in that stands for it (none when the app took it
 * back), and the OTO App's own day, read after the POS's rows (`takenBackBy`).
 */
async function standingDayOf(
  tx: Tx,
  branchId: string,
  eventId: string,
  child: EventChild,
  date: string,
): Promise<{ row: CheckinRow | null; appDay: SeamAttendance | null }> {
  const rows = await posCheckinsOf(tx, eventId, child, date);
  const appDay = await seamRead(() => appDayOf(tx, branchId, eventId, child.aliases, date));
  const back = takenBackBy(rows, appDay);
  return { row: rows.find((r) => !back.includes(r)) ?? null, appDay };
}

/**
 * Set aside the POS's check-ins the OTO App took back (`takenBackBy`), before
 * the child's next check-in for the day: each row is marked undone and its
 * active bands are revoked (S2-11's `revoked`: the paper the child may still
 * wear opens no gate and reads no stay), one audit row each. Answers the rows
 * this call set aside, with the bands it revoked.
 */
export async function undoTakenBack(
  tx: Tx,
  rows: readonly CheckinRow[],
  input: {
    operatorId: string;
    branchId: string;
    actorAccountId: string | null;
    requestId?: string | null;
    actionId: string | null;
    sourceEventId?: string | null;
    stationId: string | null;
    boxId: string | null;
    /** The check-in that takes the day now. */
    nextCheckinId: string;
    now: Date;
  },
): Promise<Array<{ checkinId: string; revokedBandIds: string[] }>> {
  const setAside: Array<{ checkinId: string; revokedBandIds: string[] }> = [];
  for (const row of rows) {
    const [undone] = await tx
      .update(eventCheckin)
      .set({ undoneAt: input.now, updatedAt: input.now })
      .where(and(eq(eventCheckin.id, row.id), isNull(eventCheckin.undoneAt)))
      .returning({ id: eventCheckin.id });
    if (!undone) continue;
    const live = await tx
      .select({ id: band.id })
      .from(band)
      .where(and(eq(band.eventCheckinId, row.id), eq(band.status, 'active')));
    for (const b of live) {
      await tx.update(band).set({ status: 'revoked', updatedAt: input.now }).where(eq(band.id, b.id));
      await tx.insert(bandEvent).values({
        id: newId(),
        bandId: b.id,
        kind: 'revoked',
        stationId: input.stationId,
        boxId: input.boxId,
        // Why it died. Never the code: it is a gate credential.
        detail: { eventCheckinId: row.id, reason: 'undone_in_otoapp', nextCheckinId: input.nextCheckinId },
        createdAt: input.now,
      });
    }
    await audit.record(tx, {
      actorAccountId: input.actorAccountId,
      operatorId: input.operatorId,
      branchId: input.branchId,
      action: 'event.checkin_undone',
      entityType: 'event_checkin',
      entityId: row.id,
      actionId: input.actionId,
      requestId: input.requestId ?? null,
      ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
      before: { undoneAt: null, syncState: row.syncState },
      after: {
        eventId: row.otoappEventId,
        attendeeId: row.attendeeId,
        date: row.attendanceDate,
        undoneAt: input.now.toISOString(),
        // The OTO App's own "Undo check-in" took the day back; the child is checked in again.
        reason: 'undone_in_otoapp',
        nextCheckinId: input.nextCheckinId,
        revokedBandIds: live.map((b) => b.id),
        stationId: input.stationId,
        boxId: input.boxId,
      },
    });
    setAside.push({ checkinId: row.id, revokedBandIds: live.map((b) => b.id) });
  }
  return setAside;
}

// --- Views ----------------------------------------------------------------------------

async function bandsOf(db: Exec, row: CheckinRow): Promise<{ kid: BandRow | null; parent: BandRow | null }> {
  const ids = [row.kidBandId, row.parentBandId].filter((id): id is string => !!id);
  const rows = ids.length ? await db.select().from(band).where(inArray(band.id, ids)) : [];
  return {
    kid: rows.find((b) => b.id === row.kidBandId) ?? null,
    parent: rows.find((b) => b.id === row.parentBandId) ?? null,
  };
}

export async function checkinViewOf(db: Exec, row: CheckinRow): Promise<EventCheckinRecordView> {
  const { kid, parent } = await bandsOf(db, row);
  // S2-20 E5 (closing audit, a) — a check-in the OTO App took back is history:
  // its bands were revoked when it was set aside, so their codes are never
  // read back as if the child wore working paper.
  const bandView = (b: BandRow | null) =>
    b && !row.undoneAt ? { id: b.id, kind: b.kind, shortCode: bandShortCode(b.code) } : null;
  return {
    id: row.id,
    eventId: row.otoappEventId,
    attendeeId: row.attendeeId,
    date: row.attendanceDate,
    status: row.checkedOutAt ? 'checked_out' : 'checked_in',
    checkedInAt: row.checkedInAt.toISOString(),
    checkedInBy: row.checkedInByName,
    checkedOutAt: row.checkedOutAt?.toISOString() ?? null,
    checkedOutBy: row.checkedOutByName,
    kidBand: bandView(kid),
    parentBand: bandView(parent),
    origin: row.origin,
    syncState: row.syncState,
    syncError: row.syncError,
    undoneAt: row.undoneAt?.toISOString() ?? null,
  };
}

function printJobView(j: SalePrintJobView): EventPrintJobView {
  return { ...j };
}

// --- The write ------------------------------------------------------------------------

export interface EventCheckinResult {
  answer: EventCheckinAnswer;
}

interface Where {
  clock: BranchClock;
  event: SeamEvent;
  today: string;
}

async function whereOf(
  deps: EventWriteDeps,
  actor: ActorContext,
  branchId: string,
  eventId: string,
  now: Date,
): Promise<Where> {
  const clock = await branchClockOf(deps.db, actor.operatorId, branchId);
  await actor.assertBranchAllowed?.(clock.id);
  const event = await seamRead(() => getBranchEvent(deps.db, { branchId: clock.id, eventId }));
  if (!event) throw errors.notFound('Event not found');
  const today = businessDate(now, clock.timezone, clock.dayStartMinutes);
  return { clock, event, today };
}

/** The station, inside the caller's operator and at this branch; its box and code prefix. */
async function stationAt(
  db: Exec,
  operatorId: string,
  branchId: string,
  stationId: string | undefined,
): Promise<{ id: string; boxId: string | null; prefix: string | null } | null> {
  if (!stationId) return null;
  const [st] = await db
    .select({ id: station.id, branchId: station.branchId, boxId: station.boxId, prefix: station.codePrefix, archivedAt: station.archivedAt })
    .from(station)
    .where(and(eq(station.id, stationId), eq(station.operatorId, operatorId)))
    .limit(1);
  if (!st || st.archivedAt) throw errors.notFound('Station not found');
  if (st.branchId !== branchId) throw errors.badRequest('That station belongs to another branch');
  return { id: st.id, boxId: st.boxId, prefix: st.prefix };
}

/**
 * Take the locks one child's day is decided under: one per id the child is
 * known by, in one order for every caller (so two presses never wait on each
 * other crosswise). Two presses for the same child share at least one id —
 * the app's, or the till's link — whichever id each named them by.
 */
export async function lockChildDay(tx: Tx, eventId: string, child: Pick<EventChild, 'aliases'>, date: string): Promise<void> {
  for (const alias of [...new Set(child.aliases)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`event-checkin:${eventId}:${alias}:${date}`}, 0))`);
  }
}

/** A second check-in of one child-day that met the unique key (a racing box fact): "Already checked in". */
export function isDayTaken(err: unknown): boolean {
  const pg = pgErrorOf(err);
  return pg?.code === '23505' && pg.constraint === 'event_checkin_attendee_day_unique';
}

/**
 * `POST /events/:id/attendees/:attendeeId/checkin` — check a child in for the
 * branch's business date, mint their bands and print them, then tell the OTO
 * App. The same check-in id again answers what it made (`replayed`).
 */
export async function checkInEventAttendee(
  deps: EventWriteDeps,
  ctx: OpContext,
  actor: ActorContext,
  eventId: string,
  attendeeId: string,
  body: EventCheckinBody & { actionId?: string },
  now: Date = new Date(),
): Promise<EventCheckinResult> {
  const db = deps.db;
  const { clock, event, today } = await whereOf(deps, actor, body.branchId, eventId, now);
  const checkinId = body.checkinId.toLowerCase();

  // The same check-in id again: the press that made it, answered again —
  // before any rule that moves with the clock.
  const [prior] = await db.select().from(eventCheckin).where(eq(eventCheckin.id, checkinId)).limit(1);
  if (prior) return replayOf(deps, actor, prior, event.id, attendeeId);

  if (event.archived) throw errors.conflict('EVENT_ARCHIVED', 'This event has been archived in the OTO App');
  if (!eventListedOn(event, today)) throw refuse(409, EVENT_CHECKIN_REFUSALS.notToday);
  const child = await seamRead(() => eventChildOf(db, clock.id, event, attendeeId, today));
  if (!child) throw refuse(404, EVENT_CHECKIN_REFUSALS.attendeeUnknown);
  if (!child.attends) throw refuse(409, EVENT_CHECKIN_REFUSALS.notRegistered);
  // The OTO App is the master (Q1): a child it already has in for the day is
  // in — under another check-in id. Its row under THIS id is a copy of this
  // press that landed first, answered below as this press.
  const appDay = await seamRead(() => appDayOf(db, clock.id, event.id, child.aliases, today, checkinId));
  if (appDay) {
    throw refuse(409, EVENT_CHECKIN_REFUSALS.alreadyIn, { checkedInAt: appDay.checkedInAt?.toISOString() ?? null });
  }
  const where = await stationAt(db, actor.operatorId, clock.id, body.stationId);
  const staffName = await staffNameOf(db, actor.accountId);
  const actionId = body.actionId ?? null;
  const writeback: DirectoryCheckinBody = {
    id: checkinId,
    date: today,
    checkedInAt: now.toISOString(),
    checkedInBy: staffName,
  };

  const done: { raced: CheckinRow | null; notes: string[]; bandRows: BandRow[] } = {
    raced: null,
    notes: [],
    bandRows: [],
  };
  let jobs: SalePrintJobView[] = [];
  await withTx(db, ctx, 'event.checkin', async (tx) => {
    // Two presses for one child's day at once: the second waits for the first.
    await lockChildDay(tx, event.id, child, today);
    const [again] = await tx.select().from(eventCheckin).where(eq(eventCheckin.id, checkinId)).limit(1);
    if (again) {
      done.raced = again;
      return undefined;
    }
    const held = await posCheckinsOf(tx, event.id, child, today);
    if (held.length > 0) {
      // A check-in the app had and took back (its own "Undo check-in") no
      // longer holds the day: the app is the master (Q1). Any other stands.
      const appNow = await seamRead(() => appDayOf(tx, clock.id, event.id, child.aliases, today, checkinId));
      const back = takenBackBy(held, appNow);
      const standing = held.find((r) => !back.includes(r));
      if (standing) throw refuse(409, EVENT_CHECKIN_REFUSALS.alreadyIn, { checkinId: standing.id });
      await undoTakenBack(tx, back, {
        operatorId: actor.operatorId,
        branchId: clock.id,
        actorAccountId: actor.accountId,
        requestId: actor.requestId ?? null,
        actionId,
        stationId: where?.id ?? null,
        boxId: where?.boxId ?? null,
        nextCheckinId: checkinId,
        now,
      });
    }
    await tx.insert(eventCheckin).values({
      id: checkinId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      otoappEventId: event.id,
      attendeeId: child.attendeeId,
      linkId: child.link?.id ?? null,
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
      checkedInAt: now,
      checkedInByAccountId: actor.accountId,
      checkedInByName: staffName,
      stationId: where?.id ?? null,
      boxId: where?.boxId ?? null,
      origin: 'till',
      syncState: 'pending',
      writeback,
      actionId,
      createdAt: now,
      updatedAt: now,
    });
    const issued = await issueBands(tx, {
      actor,
      clock,
      checkinId,
      child,
      where,
      now,
      actionId,
      detail: { eventId: event.id, attendeeId: child.attendeeId, date: today },
    });
    done.bandRows = issued.bands;
    done.notes.push(...issued.notes);
    jobs = issued.jobs;
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      action: 'event.checkin',
      entityType: 'event_checkin',
      entityId: checkinId,
      actionId,
      requestId: actor.requestId,
      // The station and box ride in the row's detail (plan §10): the audit
      // table has no column for either.
      after: {
        eventId: event.id,
        eventType: event.type,
        attendeeId: child.attendeeId,
        linkId: child.link?.id ?? null,
        date: today,
        kidBandId: issued.bands.find((b) => b.kind === 'kid')?.id ?? null,
        parentBandId: issued.bands.find((b) => b.kind === 'adult')?.id ?? null,
        stationId: where?.id ?? null,
        boxId: where?.boxId ?? null,
        origin: 'till',
      },
    });
    return undefined;
  }).catch((err: unknown) => {
    // A box's fact for the same child-day filed between the read and the
    // write (it takes no lock of the till's): the unique key held, and the
    // counter is told what it would have been told a moment later.
    if (isDayTaken(err)) throw refuse(409, EVENT_CHECKIN_REFUSALS.alreadyIn);
    throw err;
  });

  if (done.raced) return replayOf(deps, actor, done.raced, event.id, attendeeId);
  const pushed = await pushCheckin(deps, checkinId, { requestId: actor.requestId ?? null });
  return {
    answer: {
      checkin: await checkinViewOf(db, pushed),
      replayed: false,
      printJobs: jobs.map(printJobView),
      notes: done.notes,
    },
  };
}

/**
 * Mint the check-in's bands and queue their paper, without ever undoing the
 * check-in: a deployment with no band key, a device that is no station, a
 * station with no box — each is a note, and the child is in (the prototype's
 * "Checked in — no printer … bracelet not printed").
 */
export async function issueBands(
  tx: Tx,
  input: {
    /** Who checked the child in: a person at a till, or nobody (the kiosk, S2-20 E5). */
    actor: { operatorId: string; accountId: string | null; requestId?: string };
    clock: BranchClock;
    checkinId: string;
    child: Pick<EventChild, 'parentAttending' | 'link'>;
    where: { id: string; boxId: string | null; prefix: string | null } | null;
    now: Date;
    actionId: string | null;
    detail: Record<string, unknown>;
    /**
     * S2-20 E5 — `caller`: the band jobs are written and no box command is
     * queued for them; the kiosk prints them itself, inside its redemption,
     * before anything commits (as it prints a booking's ticket bands).
     */
    dispatch?: 'box' | 'caller';
  },
): Promise<{ bands: BandRow[]; jobs: SalePrintJobView[]; notes: string[] }> {
  if (!input.where) {
    return { bands: [], jobs: [], notes: ['Checked in — no printer: this device is not a station, so no band was printed'] };
  }
  if (!input.where.prefix) {
    return { bands: [], jobs: [], notes: ['Bands not issued — this station has no code prefix. Reprint the band once it is set'] };
  }
  let minted: { kid: BandRow; parent: BandRow | null } | null = null;
  const notes: string[] = [];
  try {
    minted = await tx.transaction((sp) =>
      mintEventBands(sp, {
        operatorId: input.actor.operatorId,
        branchId: input.clock.id,
        eventCheckinId: input.checkinId,
        childId: input.child.link?.childId ?? null,
        memberId: input.child.link?.memberId ?? null,
        parentAttending: input.child.parentAttending,
        stationPrefix: input.where!.prefix!,
        stationId: input.where!.id,
        boxId: input.where!.boxId,
        now: input.now,
        detail: input.detail,
      }),
    );
  } catch (err) {
    notes.push(
      err instanceof BandKeyMissingError
        ? 'Bands not issued — this deployment has no band key'
        : 'Bands not issued — reprint them from the roster once it is put right',
    );
    return { bands: [], jobs: [], notes };
  }
  const bands = [minted.kid, ...(minted.parent ? [minted.parent] : [])];
  await tx
    .update(eventCheckin)
    .set({ kidBandId: minted.kid.id, parentBandId: minted.parent?.id ?? null, updatedAt: input.now })
    .where(eq(eventCheckin.id, input.checkinId));
  const printed = await queueEventBandPrints(tx, {
    operatorId: input.actor.operatorId,
    branchId: input.clock.id,
    stationId: input.where.id,
    bands,
    actorAccountId: input.actor.accountId,
    actionId: input.actionId ?? newId(),
    requestId: input.actor.requestId,
    now: input.now,
    ...(input.dispatch ? { dispatch: input.dispatch } : {}),
  });
  return { bands, jobs: printed.jobs, notes: [...notes, ...printed.notes] };
}

/** The answer for a check-in id that already exists: the same press, answered again. */
async function replayOf(
  deps: EventWriteDeps,
  actor: ActorContext,
  row: CheckinRow,
  eventId: string,
  attendeeId: string,
): Promise<EventCheckinResult> {
  if (row.operatorId !== actor.operatorId || row.otoappEventId !== eventId.toLowerCase()) {
    throw refuse(409, EVENT_CHECKIN_REFUSALS.checkinIdInUse, { checkinId: row.id });
  }
  const id = attendeeId.toLowerCase();
  if (row.attendeeId !== id && row.linkId !== id) {
    const links = row.linkId
      ? await deps.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, row.linkId)).limit(1)
      : [];
    if (links[0]?.otoappAttendeeId !== id) throw refuse(409, EVENT_CHECKIN_REFUSALS.checkinIdInUse, { checkinId: row.id });
  }
  await actor.assertBranchAllowed?.(row.branchId);
  // S2-20 E5 (closing audit, a) — the press came back after the OTO App took
  // its check-in back and the child was checked in since (`undoneAt`): that
  // check-in no longer stands and its bands are revoked. Answering "checked
  // in" with their codes would send the counter to hand over paper the gate
  // refuses; the counter is told what happened instead.
  if (row.undoneAt) {
    throw refuse(409, EVENT_CHECKIN_REFUSALS.takenBack, {
      checkinId: row.id,
      undoneAt: row.undoneAt.toISOString(),
    });
  }
  // A retry after a lost answer is also the till's chance to finish a write
  // the OTO App never confirmed. The same id, so the app replays it.
  const current = row.syncState === 'synced' || !row.writeback ? row : await pushCheckin(deps, row.id, { requestId: actor.requestId ?? null });
  return { answer: { checkin: await checkinViewOf(deps.db, current), replayed: true, printJobs: [], notes: [] } };
}

// --- Check-out ------------------------------------------------------------------------

/**
 * `POST /events/:id/attendees/:attendeeId/checkout` — the branch's business
 * date. Refused unless the child is in and not yet out (`checkOutEventAttendee`,
 * mockApi.ts:3855). A child the OTO App checked in is mirrored here as it
 * checks out. Kept on the POS's mirror: the directory has no check-out write.
 */
export async function checkOutEventAttendee(
  deps: EventWriteDeps,
  ctx: OpContext,
  actor: ActorContext,
  eventId: string,
  attendeeId: string,
  body: EventCheckoutBody & { actionId?: string },
  now: Date = new Date(),
): Promise<EventCheckinResult> {
  const db = deps.db;
  const { clock, event, today } = await whereOf(deps, actor, body.branchId, eventId, now);
  const child = await seamRead(() => eventChildOf(db, clock.id, event, attendeeId, today));
  if (!child) throw refuse(404, EVENT_CHECKIN_REFUSALS.attendeeUnknown);
  const where = await stationAt(db, actor.operatorId, clock.id, body.stationId);
  const staffName = await staffNameOf(db, actor.accountId);
  const actionId = body.actionId ?? null;

  // The answer is built after the commit, so nothing is returned from the
  // transaction: the idempotency store keeps the route's answer (onSend).
  const held: { row: CheckinRow | null } = { row: null };
  await onceMoreIfDayTaken(() => withTx(db, ctx, 'event.checkout', async (tx) => {
    await lockChildDay(tx, event.id, child, today);
    const { row: standing, appDay } = await standingDayOf(tx, clock.id, event.id, child, today);
    let row = standing;
    if (!row) {
      // Checked in at the OTO App alone: mirrored now, as it checks out.
      if (!appDay || appDay.status !== 'checked_in' || !appDay.checkedInAt) {
        throw refuse(
          409,
          appDay?.status === 'checked_out' ? EVENT_CHECKIN_REFUSALS.alreadyOut : EVENT_CHECKIN_REFUSALS.notIn,
        );
      }
      row = await mirrorAppCheckin(tx, { actor, clock, event, child, today, appDay, now, where, actionId });
    }
    if (row.checkedOutAt) throw refuse(409, EVENT_CHECKIN_REFUSALS.alreadyOut);
    const [updated] = await tx
      .update(eventCheckin)
      .set({
        checkedOutAt: now,
        checkedOutByAccountId: actor.accountId,
        checkedOutByName: staffName,
        updatedAt: now,
      })
      .where(and(eq(eventCheckin.id, row.id), isNull(eventCheckin.checkedOutAt)))
      .returning();
    if (!updated) throw refuse(409, EVENT_CHECKIN_REFUSALS.alreadyOut);
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      action: 'event.checkout',
      entityType: 'event_checkin',
      entityId: updated.id,
      actionId,
      requestId: actor.requestId,
      before: { checkedOutAt: null },
      after: {
        eventId: event.id,
        attendeeId: updated.attendeeId,
        date: today,
        checkedOutAt: now.toISOString(),
        stationId: where?.id ?? null,
        boxId: where?.boxId ?? null,
        // The OTO App's directory has no check-out write yet.
        writtenBack: false,
      },
    });
    held.row = updated;
    return undefined;
  }));
  return { answer: { checkin: await checkinViewOf(db, held.row!), replayed: false, printJobs: [], notes: [] } };
}

/**
 * S2-20 E5 (closing audit, c) — THE MIRROR THAT MET A BOX'S ROW. A check-out or
 * a reprint of a child checked in at the OTO App alone writes the app's
 * check-in into the POS's mirror; a box's fact for the same child-day may be
 * filed in the same instant. Two presses at the till take the child-day's
 * locks (`lockChildDay`), so they are decided one after the other; the box
 * door takes no lock of the till's — it decides from the rows it reads and,
 * should the unique key meet the till's row first, decides its fact once more
 * itself (`decidedOnceMore`, sync-events.ts). Should the till's write meet the
 * box's row first instead, the press is decided once more here, with that row
 * standing, rather than ending in a 500.
 */
async function onceMoreIfDayTaken<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!isDayTaken(err)) throw err;
    return work();
  }
}

/** A mirror of a check-in the OTO App made itself: nothing to tell the app, so it is `synced`. */
async function mirrorAppCheckin(
  tx: Tx,
  input: {
    actor: ActorContext;
    clock: BranchClock;
    event: SeamEvent;
    child: EventChild;
    today: string;
    appDay: SeamAttendance;
    now: Date;
    where: { id: string; boxId: string | null } | null;
    actionId: string | null;
  },
): Promise<CheckinRow> {
  const [row] = await tx
    .insert(eventCheckin)
    .values({
      id: newId(),
      operatorId: input.actor.operatorId,
      branchId: input.clock.id,
      otoappEventId: input.event.id,
      attendeeId: input.child.attendeeId,
      linkId: input.child.link?.id ?? null,
      eventType: input.event.type,
      attendanceDate: input.today,
      childName: input.child.childName,
      parentName: input.child.parentName,
      parentAttending: input.child.parentAttending,
      allergy: input.child.allergy,
      dietary: input.child.dietary,
      eventTitle: input.event.title,
      startTime: input.event.startTime,
      endTime: input.event.endTime,
      checkedInAt: input.appDay.checkedInAt ?? input.now,
      checkedInByName: input.appDay.checkedInBy,
      stationId: input.where?.id ?? null,
      boxId: input.where?.boxId ?? null,
      origin: 'otoapp',
      otoappCheckinId: input.appDay.id,
      syncState: 'synced',
      syncedAt: input.now,
      actionId: input.actionId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!row) throw new Error('the check-in mirror was not written');
  return row;
}

// --- Reprint --------------------------------------------------------------------------

/**
 * `POST /events/:id/attendees/:attendeeId/reprint` — fresh paper for today's
 * bands, only while the child is in and not out (DropOff.tsx
 * `handleEventReprint`). The bands, their ids and their codes are unchanged; a
 * check-in that has none yet (no key or no station when the child arrived, or
 * a check-in made in the OTO App) is issued them here, once.
 */
export async function reprintEventBands(
  deps: EventWriteDeps,
  ctx: OpContext,
  actor: ActorContext,
  eventId: string,
  attendeeId: string,
  body: EventReprintBody & { actionId?: string },
  now: Date = new Date(),
): Promise<EventCheckinResult> {
  const db = deps.db;
  const { clock, event, today } = await whereOf(deps, actor, body.branchId, eventId, now);
  const child = await seamRead(() => eventChildOf(db, clock.id, event, attendeeId, today));
  if (!child) throw refuse(404, EVENT_CHECKIN_REFUSALS.attendeeUnknown);
  const where = await stationAt(db, actor.operatorId, clock.id, body.stationId);
  if (!where) throw errors.badRequest('A reprint names the station it prints at');
  const actionId = body.actionId ?? newId();
  const reason = body.reason?.trim() || 'Lost band';

  const result: { row: CheckinRow | null; printed: { jobs: SalePrintJobView[]; notes: string[] } } = {
    row: null,
    printed: { jobs: [], notes: [] },
  };
  await onceMoreIfDayTaken(() => withTx(db, ctx, 'event.band_reprint', async (tx) => {
    await lockChildDay(tx, event.id, child, today);
    const { row: standing, appDay } = await standingDayOf(tx, clock.id, event.id, child, today);
    let row = standing;
    if (!row) {
      if (!appDay || appDay.status !== 'checked_in' || !appDay.checkedInAt) throw refuse(409, EVENT_CHECKIN_REFUSALS.notIn);
      row = await mirrorAppCheckin(tx, { actor, clock, event, child, today, appDay, now, where, actionId });
    }
    if (row.checkedOutAt) throw refuse(409, EVENT_CHECKIN_REFUSALS.notIn);
    let bands = await tx
      .select()
      .from(band)
      .where(and(eq(band.eventCheckinId, row.id), eq(band.status, 'active')))
      .orderBy(asc(band.createdAt));
    if (bands.length === 0) {
      if (!where.prefix) throw errors.conflict('STATION_NO_PREFIX', 'This station has no code prefix, so it cannot issue a band');
      const minted = await mintEventBands(tx, {
        operatorId: actor.operatorId,
        branchId: clock.id,
        eventCheckinId: row.id,
        childId: child.link?.childId ?? null,
        memberId: child.link?.memberId ?? null,
        parentAttending: row.parentAttending,
        stationPrefix: where.prefix,
        stationId: where.id,
        boxId: where.boxId,
        now,
        detail: { eventId: event.id, attendeeId: row.attendeeId, date: today, onReprint: true },
      }).catch((err: unknown) => {
        if (err instanceof BandKeyMissingError) {
          throw new AppError(503, 'BAND_KEY_MISSING', 'This deployment has no band key, so no band can be issued');
        }
        throw err;
      });
      bands = [minted.kid, ...(minted.parent ? [minted.parent] : [])];
      await tx
        .update(eventCheckin)
        .set({ kidBandId: minted.kid.id, parentBandId: minted.parent?.id ?? null, updatedAt: now })
        .where(eq(eventCheckin.id, row.id));
    }
    const printed = await queueEventBandPrints(tx, {
      operatorId: actor.operatorId,
      branchId: clock.id,
      stationId: where.id,
      bands,
      actorAccountId: actor.accountId,
      actionId,
      requestId: actor.requestId,
      now,
      reprint: { reason, accountId: actor.accountId },
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      action: 'event.band_reprint',
      entityType: 'event_checkin',
      entityId: row.id,
      actionId,
      requestId: actor.requestId,
      after: {
        eventId: event.id,
        attendeeId: row.attendeeId,
        date: today,
        reason,
        bandIds: bands.map((b) => b.id),
        printJobIds: printed.jobs.map((j) => j.id),
        stationId: where.id,
        boxId: where.boxId,
      },
    });
    const [now2] = await tx.select().from(eventCheckin).where(eq(eventCheckin.id, row.id)).limit(1);
    result.row = now2 ?? row;
    result.printed = printed;
    return undefined;
  }));
  return {
    answer: {
      checkin: await checkinViewOf(db, result.row!),
      replayed: false,
      printJobs: result.printed.jobs.map(printJobView),
      notes: result.printed.notes,
    },
  };
}

// --- The write-back -------------------------------------------------------------------

/**
 * WRITE ONE CHECK-IN TO THE OTO APP — the first time, and every retry.
 *
 * E2's `pushAttendee`, for a check-in: reads the row, sends its stored body
 * under its own id, and records what happened on the row (`sync_state`, the
 * attempt count, the error) and as an `ops_run` of kind `integration` the
 * Failures page groups and offers to retry. A child the till added that the
 * app does not have yet is written first (`pushAttendee`), because the app
 * cannot check in a child it does not hold; while it still does not, the
 * check-in waits, `pending`. Never throws for the app's answer: the check-in
 * and its bands are committed before this runs.
 */
export async function pushCheckin(
  deps: EventWriteDeps,
  checkinId: string,
  meta: { requestId?: string | null } = {},
): Promise<CheckinRow> {
  return (await sendCheckin(deps, checkinId, meta)).row;
}

type SendOutcome = DirectoryOutcome<DirectoryCheckinAnswer> | null;

async function sendCheckin(
  deps: EventWriteDeps,
  checkinId: string,
  meta: { requestId?: string | null },
): Promise<{ row: CheckinRow; outcome: SendOutcome }> {
  const db = deps.db;
  const [row] = await db.select().from(eventCheckin).where(eq(eventCheckin.id, checkinId)).limit(1);
  if (!row) throw errors.notFound('That check-in is not on record');
  if (row.syncState === 'synced') return { row, outcome: null };
  const body = row.writeback as DirectoryCheckinBody | null;
  if (!body) throw new Error(`event check-in ${row.id} is not synced and holds no write-back body`);

  const startedAt = new Date();
  let outcome: DirectoryOutcome<DirectoryCheckinAnswer>;
  let appAttendeeId: string = row.attendeeId;
  if (row.linkId) {
    // The child the till added: the app holds them under the id it answered
    // with (the till's own, or a registration it merged them into).
    let [link] = await db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, row.linkId)).limit(1);
    if (link && link.syncState !== 'synced') link = await pushAttendee(deps, link.id, meta);
    if (!link || link.syncState !== 'synced' || !link.otoappAttendeeId) {
      outcome = {
        ok: false,
        status: null,
        code: 'OTOAPP_ATTENDEE_NOT_SYNCED',
        message: 'The child is not in the OTO App yet, so their check-in waits for them',
        retryable: true,
      };
    } else {
      appAttendeeId = link.otoappAttendeeId;
      outcome = await deps.directory.checkinAttendee(row.otoappEventId, appAttendeeId, body);
    }
  } else {
    outcome = await deps.directory.checkinAttendee(row.otoappEventId, appAttendeeId, body);
  }
  const finishedAt = new Date();
  const attempts = row.syncAttempts + 1;
  const detail = {
    checkinId: row.id,
    eventId: row.otoappEventId,
    eventType: row.eventType,
    date: row.attendanceDate,
    attempt: attempts,
    status: outcome.status,
    origin: row.origin,
    ...(outcome.ok ? { replayed: outcome.body.replayed } : {}),
  };
  const runBase = {
    kind: 'integration' as const,
    name: ATTENDEE_CHECKIN_RUN,
    startedAt,
    finishedAt,
    detail,
    requestId: meta.requestId ?? null,
    actionId: row.actionId,
    operatorId: row.operatorId,
    branchId: row.branchId,
    stationId: row.stationId,
  };

  if (outcome.ok) {
    const [updated] = await db
      .update(eventCheckin)
      .set({
        syncState: 'synced',
        otoappCheckinId: outcome.body.checkin.id,
        syncAttempts: attempts,
        syncError: null,
        lastSyncAt: finishedAt,
        syncedAt: finishedAt,
        updatedAt: finishedAt,
      })
      .where(and(eq(eventCheckin.id, row.id), ne(eventCheckin.syncState, 'synced')))
      .returning();
    await recordRun(db, { ...runBase, outcome: 'ok' }).catch((err: unknown) =>
      deps.log?.error({ err, checkinId: row.id }, 'the check-in write-back ran but its ops run could not be written'),
    );
    if (updated) return { row: updated, outcome };
    const [now] = await db.select().from(eventCheckin).where(eq(eventCheckin.id, row.id)).limit(1);
    return { row: now ?? row, outcome };
  }

  const state = outcome.retryable ? 'pending' : 'failed';
  const [updated] = await db
    .update(eventCheckin)
    .set({
      syncState: state,
      syncAttempts: attempts,
      syncError: `${outcome.code}: ${outcome.message}`.slice(0, 500),
      lastSyncAt: finishedAt,
      updatedAt: finishedAt,
    })
    .where(and(eq(eventCheckin.id, row.id), ne(eventCheckin.syncState, 'synced')))
    .returning();
  await recordRun(db, {
    ...runBase,
    outcome: 'failed',
    error: new AppError(outcome.status ?? 503, outcome.code, outcome.message),
  }).catch((err: unknown) =>
    deps.log?.error({ err, checkinId: row.id }, 'the check-in write-back failed and its ops run could not be written'),
  );
  if (updated) return { row: updated, outcome };
  const [now] = await db.select().from(eventCheckin).where(eq(eventCheckin.id, row.id)).limit(1);
  return { row: now ?? row, outcome };
}

/** The most check-ins one press of Retry sends; the rest wait for the next press. */
export const CHECKIN_WRITE_BACK_SWEEP_LIMIT = 50;

export interface CheckinWriteBackSweep {
  checkin: CheckinRow;
  sent: number;
  synced: number;
  waiting: number;
  stoppedEarly: boolean;
}

const stopsTheSweep = (outcome: SendOutcome): boolean =>
  outcome !== null &&
  !outcome.ok &&
  outcome.code !== 'OTOAPP_ATTENDEE_NOT_SYNCED' &&
  (outcome.retryable || outcome.status === 401 || outcome.status === 403);

/**
 * THE FAILURES PAGE'S RETRY of a check-in write-back — `retryAttendeeWriteBack`
 * (E2), for check-ins: the pressed run's check-in first, then — oldest first and
 * bounded — every other check-in of the caller's operator, within the caller's
 * reach, still owed to the app: each one `pending`, and each one `failed` with
 * the pressed group's own error code. It stops at the first the app does not
 * answer, or whose key it refuses. A check-in waiting for its child to reach
 * the app does not stop it: that child's own write is sent first, each time.
 */
export async function retryCheckinWriteBack(
  deps: EventWriteDeps,
  q: {
    operatorId: string;
    checkinId: string;
    errorCode: string | null;
    reach: BranchReach;
    requestId?: string | null;
    limit?: number;
  },
): Promise<CheckinWriteBackSweep> {
  const db = deps.db;
  const limit = Math.max(1, q.limit ?? CHECKIN_WRITE_BACK_SWEEP_LIMIT);
  const meta = { requestId: q.requestId ?? null };
  const [row] = await db
    .select({ id: eventCheckin.id, operatorId: eventCheckin.operatorId })
    .from(eventCheckin)
    .where(eq(eventCheckin.id, q.checkinId))
    .limit(1);
  if (!row || row.operatorId !== q.operatorId) throw errors.notFound('That check-in is not on record');

  let sent = 0;
  let synced = 0;
  const own = await sendCheckin(deps, row.id, meta);
  if (own.outcome) {
    sent += 1;
    if (own.row.syncState === 'synced') synced += 1;
  }
  let stoppedEarly = stopsTheSweep(own.outcome);

  const reachClause =
    q.reach.kind === 'operator'
      ? undefined
      : q.reach.branchIds.length === 0
        ? sql`false`
        : inArray(eventCheckin.branchId, q.reach.branchIds);
  const sameGroupRefusal = q.errorCode
    ? and(eq(eventCheckin.syncState, 'failed'), sql`starts_with(${eventCheckin.syncError}, ${`${q.errorCode}:`})`)
    : undefined;
  const waitingClause = and(
    eq(eventCheckin.operatorId, q.operatorId),
    sql`${eventCheckin.syncState} <> 'synced'`,
    sameGroupRefusal ? or(eq(eventCheckin.syncState, 'pending'), sameGroupRefusal) : eq(eventCheckin.syncState, 'pending'),
    reachClause,
  );

  if (!stoppedEarly && sent < limit) {
    const others = await db
      .select({ id: eventCheckin.id })
      .from(eventCheckin)
      .where(and(waitingClause, ne(eventCheckin.id, row.id), isNotNull(eventCheckin.writeback)))
      .orderBy(asc(eventCheckin.createdAt), asc(eventCheckin.id))
      .limit(limit - sent);
    for (const other of others) {
      const pushed = await sendCheckin(deps, other.id, meta);
      if (!pushed.outcome) continue;
      sent += 1;
      if (pushed.row.syncState === 'synced') synced += 1;
      if (stopsTheSweep(pushed.outcome)) {
        stoppedEarly = true;
        break;
      }
    }
  }

  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(eventCheckin)
    .where(waitingClause);
  return { checkin: own.row, sent, synced, waiting: left?.n ?? 0, stoppedEarly };
}

/**
 * The check-ins a box handed over that nobody has sent to the OTO App yet —
 * sent once its batch is filed (`routes/box.ts`), so a check-in made with the
 * link down reaches the app the moment the link is back. Bounded; whatever is
 * left, and whatever fails, waits on the Failures page like any other.
 */
export async function sendFiledCheckins(
  deps: EventWriteDeps,
  q: { boxId: string; limit?: number; requestId?: string | null },
): Promise<number> {
  const rows = await deps.db
    .select({ id: eventCheckin.id })
    .from(eventCheckin)
    .where(
      and(
        eq(eventCheckin.boxId, q.boxId),
        eq(eventCheckin.origin, 'box'),
        eq(eventCheckin.syncState, 'pending'),
        eq(eventCheckin.syncAttempts, 0),
        isNotNull(eventCheckin.writeback),
      ),
    )
    .orderBy(asc(eventCheckin.createdAt))
    .limit(q.limit ?? 25);
  let sent = 0;
  for (const r of rows) {
    const done = await sendCheckin(deps, r.id, { requestId: q.requestId ?? null });
    if (done.outcome) sent += 1;
    if (stopsTheSweep(done.outcome)) break;
  }
  return sent;
}

// --- Reads for the roster, the box and the food counter -------------------------------

/** One POS check-in as the roster lays it over the OTO App's day. */
export interface RosterCheckin {
  row: CheckinRow;
  kidShortCode: string | null;
  parentShortCode: string | null;
  /** Every id the child may be named by on the roster: the stored one, and the app's for a merged link. */
  names: string[];
}

/**
 * The POS's check-ins of some events — of one day, or of every day — with their
 * bands' short codes. Not one the OTO App took back (`undone_at`).
 */
export async function checkinsOfEvents(
  db: Exec,
  q: { branchId: string; eventIds: readonly string[]; date?: string },
): Promise<RosterCheckin[]> {
  if (q.eventIds.length === 0) return [];
  const rows = await db
    .select({ c: eventCheckin, otoappAttendeeId: eventAttendeeLink.otoappAttendeeId })
    .from(eventCheckin)
    .leftJoin(eventAttendeeLink, eq(eventAttendeeLink.id, eventCheckin.linkId))
    .where(
      and(
        eq(eventCheckin.branchId, q.branchId),
        inArray(eventCheckin.otoappEventId, [...q.eventIds]),
        isNull(eventCheckin.undoneAt),
        q.date ? eq(eventCheckin.attendanceDate, q.date) : undefined,
      ),
    )
    .orderBy(asc(eventCheckin.attendanceDate), asc(eventCheckin.checkedInAt));
  const bandIds = rows.flatMap((r) => [r.c.kidBandId, r.c.parentBandId]).filter((id): id is string => !!id);
  const codes = bandIds.length
    ? new Map(
        (await db.select({ id: band.id, code: band.code }).from(band).where(inArray(band.id, bandIds))).map((b) => [
          b.id,
          bandShortCode(b.code),
        ]),
      )
    : new Map<string, string | null>();
  return rows.map(({ c, otoappAttendeeId }) => ({
    row: c,
    kidShortCode: c.kidBandId ? (codes.get(c.kidBandId) ?? null) : null,
    parentShortCode: c.parentBandId ? (codes.get(c.parentBandId) ?? null) : null,
    names: [...new Set([c.attendeeId, ...(c.linkId ? [c.linkId] : []), ...(otoappAttendeeId ? [otoappAttendeeId] : [])])],
  }));
}

/**
 * THE EVENT CHILD A SCANNED BAND BELONGS TO, at this park, checked in and not
 * out — the food counter's lookup for an event band (plan §8: "The F&B lookup
 * learns the event band"). The KID band only: the parent band is the parent's
 * (mockApi.ts:3829-3838 — the parent's name, no allergy line). Null when the
 * key names no event kid band of a child in the park here.
 */
export async function eventStayForBandIds(
  db: Exec,
  operatorId: string,
  branchId: string,
  bandIds: readonly string[],
): Promise<CheckinRow | null> {
  if (bandIds.length === 0) return null;
  const [row] = await db
    .select({ c: eventCheckin })
    .from(band)
    .innerJoin(eventCheckin, eq(eventCheckin.id, band.eventCheckinId))
    .where(
      and(
        inArray(band.id, [...bandIds]),
        eq(band.operatorId, operatorId),
        eq(band.kind, 'kid'),
        eq(band.status, 'active'),
        eq(eventCheckin.branchId, branchId),
        isNull(eventCheckin.checkedOutAt),
        isNull(eventCheckin.undoneAt),
      ),
    )
    .orderBy(sql`${eventCheckin.checkedInAt} desc`)
    .limit(1);
  return row?.c ?? null;
}

/** An event check-in at this park, checked in and not out — a food order's band holder. */
export async function eventStayById(
  db: Exec,
  operatorId: string,
  branchId: string,
  checkinId: string,
): Promise<CheckinRow | null> {
  const [row] = await db
    .select()
    .from(eventCheckin)
    .where(and(eq(eventCheckin.id, checkinId), eq(eventCheckin.operatorId, operatorId), eq(eventCheckin.branchId, branchId)))
    .limit(1);
  return row ?? null;
}

