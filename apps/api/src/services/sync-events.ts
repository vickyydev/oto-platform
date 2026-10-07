import { and, eq, isNull } from 'drizzle-orm';
import { alert, band, bandEvent, eventCheckin } from '@oto/db';
import {
  EVENT_FACTS,
  OfflineEventCheckedInSchema,
  OfflineEventCheckedOutSchema,
  eventListedOn,
  newId,
  normaliseBandCode,
  parseBandCode,
  verifyBandCode,
  type OfflineEventCheckedIn,
  type OfflineEventCheckedOut,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { currentBandKey } from './bands';
import {
  appDayOf,
  eventChildOf,
  isDayTaken,
  posCheckinsOf,
  takenBackBy,
  undoTakenBack,
  type EventChild,
} from './event-checkins';
import { staffNameOf } from './event-writes';
import { raiseAlert } from './ops';
import { getBranchEvent, listEventAttendance, type SeamAttendance, type SeamEvent } from './otoapp-events';
import type { DirectoryCheckinBody } from './otoapp-directory';
import type { Tx } from './tx';
import type { BatchScope, EventHandler, PreparedEvent } from './sync';

type CheckinRow = typeof eventCheckin.$inferSelect;

/**
 * S2-20 E3 — THE CLOUD'S SIDE OF AN EVENT CHECK-IN ON THE BOX LANE (plan §5
 * "Offline": check-in and check-out are box facts, so they queue while the box
 * is offline).
 *
 * A counter with the link down checks a child in from its copy of today's
 * events (the `events` cache scope), mints the kid and parent bands with the
 * park's key and prints them, and queues `event.checked_in` on its outbox
 * (`events-desk.ts` in `@oto/box-agent`). When the link is back the fact
 * arrives here and is filed ONCE, as the drop-off path files its own
 * (`sync-checkin.ts`):
 *
 *   - idempotent on the check-in id the box minted: the same fact again meets
 *     the row it wrote and writes nothing;
 *   - tenancy from the box's credential, never the payload;
 *   - "NOT REGISTERED FOR TODAY" HOLDS ON THIS DOOR TOO (H5): the fact's day is
 *     checked against what the OTO App says NOW, not the box's copy — a day the
 *     event is not on, or a child the app moved off that day, is refused into
 *     quarantine as a `conflict`, with a warning alert, and the app is not told;
 *   - ONE CHECK-IN PER CHILD PER DAY (H4): a child the platform already has in
 *     for the day — checked in at a till with the internet, at another box, or
 *     in the OTO App itself — RESOLVES TO THAT FIRST CHECK-IN. The box's fact
 *     is filed against it, NO SECOND BAND IS RECORDED (so the gate never admits
 *     the paper the box printed), and a warning alert names both so a person
 *     can check which band the child is wearing. Two exceptions, both because
 *     the OTO App is the master (Q1): a first check-in the app took back (its
 *     own "Undo check-in") BEFORE the box checked the child in is set aside —
 *     its bands revoked, and the same alert raised, since the child may be
 *     wearing them — and the box's takes the day (a box check-in made while
 *     the first still stood is that day's second check-in, as above, and the
 *     app's later undo stands over it); and a child the app checked in at its
 *     own screen — which prints no band — has the app's check-in mirrored with
 *     the box's bands recorded on it, the only bands that child wears (H9);
 *   - the bands are recorded as the box minted them (OD-13), each verified
 *     against the park's key first;
 *   - the check-in is then owed to the OTO App, `pending`, and sent once the
 *     batch is filed (`sendFiledCheckins`, called by the box route) — and
 *     retried from the Failures page like any other.
 *
 * Refusals travel as `AppError` with the quarantine reason in
 * `details.quarantineReason`, as `sync-checkin.ts`'s do.
 */

const retry = (code: string, message: string): AppError =>
  new AppError(409, code, message, { quarantineReason: 'apply_failed' });
const conflict = (code: string, message: string, details: Record<string, unknown> = {}): AppError =>
  new AppError(409, code, message, { ...details, quarantineReason: 'conflict' });
const poison = (code: string, message: string): AppError =>
  new AppError(400, code, message, { quarantineReason: 'poison' });

function stationOf(scope: BatchScope, event: PreparedEvent): string | null {
  const id = event.envelope.stationId ?? null;
  return id && scope.stationIds.has(id) ? id : null;
}

function auditBase(scope: BatchScope, event: PreparedEvent) {
  return {
    actorAccountId: event.envelope.actorAccountId ?? null,
    operatorId: scope.auth.operatorId,
    branchId: scope.auth.branchId,
    requestId: null,
    actionId: event.envelope.actionId ?? null,
    sourceEventId: event.envelope.eventId,
  };
}

function trail(scope: BatchScope, event: PreparedEvent, payload: { offlineFresh?: boolean }) {
  return {
    boxId: scope.auth.boxId,
    stationId: stationOf(scope, event),
    offline: true,
    ...(payload.offlineFresh ? { offlineFresh: true } : {}),
  };
}

/** The event, at the box's own park. Not there: the OTO App's copy is not readable yet — a replay files it. */
async function eventAtPark(tx: Tx, scope: BatchScope, eventId: string): Promise<SeamEvent> {
  const event = await getBranchEvent(tx, { branchId: scope.auth.branchId, eventId });
  if (!event) throw retry('SYNC_EVENT_UNKNOWN', 'That event is not readable on the platform yet');
  return event;
}

/** A child the platform does not know on this event: as the box's copy named them. */
function unknownChild(payload: { attendeeId: string }): Pick<EventChild, 'attendeeId' | 'link' | 'aliases'> {
  const id = payload.attendeeId.toLowerCase();
  return { attendeeId: id, link: null, aliases: [id] };
}

/** The child as the platform knows them now, or as the box's copy had them when the app no longer does. */
async function childOf(
  tx: Tx,
  scope: BatchScope,
  event: SeamEvent,
  payload: { attendeeId: string; date: string },
): Promise<Pick<EventChild, 'attendeeId' | 'link' | 'aliases'>> {
  const known = await eventChildOf(tx, scope.auth.branchId, event, payload.attendeeId, payload.date);
  return known ?? unknownChild(payload);
}

/** The first check-in of the child's day, as the "checked in twice" alert and its audit name it. */
interface FirstCheckin {
  checkinId: string | null;
  at: string | null;
  where: 'pos' | 'otoapp';
  /** The OTO App took this check-in back (its own "Undo check-in"). */
  takenBack?: true;
}

/**
 * What the box's check-in did to the child's day: resolved to the first
 * check-in, its own bands not recorded (H4); or it took the day from a first
 * check-in the OTO App had undone before it, which was set aside with its
 * bands revoked.
 */
type TwiceOutcome =
  | { kind: 'duplicate' }
  | { kind: 'set_aside'; setAside: ReadonlyArray<{ checkinId: string; revokedBandIds: string[] }> };

/**
 * A person is told whenever a box's check-in meets another check-in of the
 * same child-day: the child wears paper from one of them, and only a person
 * can see which. Raised on every box-door set-aside too — it revokes bands the
 * child may be wearing.
 */
type SetAsideEntry = { checkinId: string; revokedBandIds: string[] };

/**
 * S2-20 E5 (closing audit, e; E3 R3-2) — the set-asides an OPEN "checked in
 * twice" alert already names. There is one alert per child-day and a repeat
 * overwrites its summary and detail (`raiseAlert`), so a later plain duplicate
 * — another box's older fact arriving after the one that set the till's
 * check-in aside — would otherwise wipe the check-in that was set aside and the
 * bands it revoked off the alert a person opens. They are carried forward.
 */
async function setAsidesOnAlert(scope: BatchScope, key: string): Promise<SetAsideEntry[]> {
  const [open] = await scope.db
    .select({ detail: alert.detail })
    .from(alert)
    .where(and(eq(alert.key, key), isNull(alert.resolvedAt)))
    .limit(1);
  const held = (open?.detail as { setAside?: unknown } | null | undefined)?.setAside;
  if (!Array.isArray(held)) return [];
  return held.flatMap((entry) => {
    const e = entry as Partial<SetAsideEntry> | null;
    return e && typeof e.checkinId === 'string' && Array.isArray(e.revokedBandIds)
      ? [{ checkinId: e.checkinId, revokedBandIds: e.revokedBandIds.filter((id): id is string => typeof id === 'string') }]
      : [];
  });
}

async function alertCheckedInTwice(
  scope: BatchScope,
  event: PreparedEvent,
  payload: OfflineEventCheckedIn,
  first: FirstCheckin,
  outcome: TwiceOutcome,
): Promise<void> {
  const key = `event.checked_in_twice:${payload.eventId}:${payload.attendeeId}:${payload.date}`;
  const offline =
    `${payload.childName} was checked in to ${payload.eventTitle} offline on ${scope.auth.name} (${scope.auth.slot}) ` +
    `at ${payload.at}`;
  try {
    // Every set-aside this child-day has seen, the earlier ones first.
    const earlier = await setAsidesOnAlert(scope, key);
    const now = outcome.kind === 'set_aside' ? outcome.setAside : [];
    const setAside = [...earlier.filter((e) => !now.some((n) => n.checkinId === e.checkinId)), ...now];
    const summary =
      outcome.kind === 'set_aside'
        ? `${offline}, after the OTO App had undone the check-in it held for ${payload.date}. That earlier check-in was ` +
          "set aside and its bands revoked; the box's bands were recorded — check which band the child is wearing."
        : `${offline}, but was already checked in for ${payload.date}` +
          `${first.where === 'otoapp' ? ' in the OTO App' : ''}` +
          `${first.takenBack ? "; the OTO App undid that check-in only later, so the box's does not check the child back in" : ''}. ` +
          "The box's bands were not recorded — check which band the child is wearing." +
          (setAside.length > 0
            ? ` Earlier today a check-in of this child was set aside and its bands revoked (${setAside.length}).`
            : '');
    await raiseAlert(
      scope.db,
      {
        key,
        category: 'event.checked_in_twice',
        severity: 'warning',
        subject: `Event check-in for ${payload.childName}`,
        summary,
        detail: {
          eventId: payload.eventId,
          attendeeId: payload.attendeeId,
          date: payload.date,
          first,
          bandsRecorded: outcome.kind === 'set_aside',
          ...(setAside.length > 0 ? { setAside } : {}),
          second: {
            boxId: scope.auth.boxId,
            checkinId: payload.checkinId,
            kidBandId: payload.kidBand?.id ?? null,
            parentBandId: payload.parentBand?.id ?? null,
            eventId: event.envelope.eventId,
          },
        },
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
      },
      { flapWindowSeconds: 0 },
    );
  } catch (err) {
    scope.log?.error({ err, checkinId: payload.checkinId }, 'a second event check-in could not be alerted; its audit row names it');
  }
}

/** One band the box minted, recorded as it is (OD-13), once. */
async function recordBoxBand(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  checkinId: string,
  minted: { id: string; code: string },
  kind: 'kid' | 'adult',
  detail: Record<string, unknown>,
): Promise<string> {
  const [held] = await tx.select().from(band).where(eq(band.id, minted.id)).limit(1);
  if (held) {
    if (held.eventCheckinId !== checkinId) throw conflict('SYNC_BAND_ID_TAKEN', 'That band id already names another band');
    return held.id;
  }
  const key = currentBandKey();
  if (!parseBandCode(minted.code) || (key && !verifyBandCode(minted.code, key).ok)) {
    throw poison('SYNC_BAND_CODE_INVALID', 'The band this box printed does not carry a code this park signs');
  }
  await tx.insert(band).values({
    id: minted.id,
    operatorId: scope.auth.operatorId,
    branchId: scope.auth.branchId,
    saleId: null,
    eventCheckinId: checkinId,
    kind,
    // The kid band never opens the gate; the parent band does.
    gateAccess: kind === 'adult',
    code: normaliseBandCode(minted.code),
    status: 'active',
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  });
  await tx.insert(bandEvent).values({
    id: newId(),
    bandId: minted.id,
    kind: 'minted',
    stationId: stationOf(scope, event),
    boxId: scope.auth.boxId,
    // The facts of the issue. Never the code: it is a gate credential.
    detail: { ...detail, eventCheckinId: checkinId, gateAccess: kind === 'adult', origin: 'box', sourceEventId: event.envelope.eventId },
    createdAt: event.occurredAt,
  });
  return minted.id;
}

/**
 * THE OTO APP'S OWN CHECK-IN, WEARING THE BOX'S BANDS (H9). The app's check-in
 * screen prints no band, so when a child it checked in is checked in again on
 * a box with the link down, the bands that box printed are the only ones the
 * child wears. The app's check-in is mirrored here under the box's check-in id
 * — `origin = 'otoapp'`, `synced`: the app has it, and is not told again — and
 * the box's bands are recorded on it, so the food counter reads the child's
 * allergy line and the gate admits the parent. The child's lines are what the
 * bands printed (the box's copy), frozen.
 */
async function mirrorWithBoxBands(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  payload: OfflineEventCheckedIn,
  ev: SeamEvent,
  child: Pick<EventChild, 'attendeeId' | 'link'>,
  appDay: SeamAttendance,
) {
  const id = payload.checkinId.toLowerCase();
  await tx.insert(eventCheckin).values({
    id,
    operatorId: scope.auth.operatorId,
    branchId: scope.auth.branchId,
    otoappEventId: ev.id,
    attendeeId: child.attendeeId,
    linkId: child.link?.id ?? null,
    eventType: ev.type,
    attendanceDate: payload.date,
    childName: payload.childName,
    parentName: payload.parentName ?? null,
    parentAttending: payload.parentAttending,
    allergy: payload.allergy?.trim() || null,
    dietary: payload.dietary?.trim() || null,
    eventTitle: payload.eventTitle || ev.title,
    startTime: payload.startTime ?? ev.startTime,
    endTime: payload.endTime ?? ev.endTime,
    // The app's check-in, as the app made it.
    checkedInAt: appDay.checkedInAt ?? new Date(payload.at),
    checkedInByName: appDay.checkedInBy,
    stationId: stationOf(scope, event),
    boxId: scope.auth.boxId,
    origin: 'otoapp',
    otoappCheckinId: appDay.id,
    sourceEventId: event.envelope.eventId,
    boxSeq: event.envelope.boxSeq,
    syncState: 'synced',
    syncedAt: event.receivedAt,
    actionId: event.envelope.actionId ?? null,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  });
  const detail = { eventId: ev.id, attendeeId: child.attendeeId, date: payload.date, mirrorOf: 'otoapp' };
  const kidBandId = payload.kidBand ? await recordBoxBand(tx, scope, event, id, payload.kidBand, 'kid', detail) : null;
  const parentBandId = payload.parentBand
    ? await recordBoxBand(tx, scope, event, id, payload.parentBand, 'adult', detail)
    : null;
  if (kidBandId || parentBandId) {
    await tx.update(eventCheckin).set({ kidBandId, parentBandId }).where(eq(eventCheckin.id, id));
  }
  await audit.record(tx, {
    ...auditBase(scope, event),
    action: 'event.checkin_duplicate',
    entityType: 'event_checkin',
    entityId: id,
    after: {
      eventId: ev.id,
      attendeeId: child.attendeeId,
      date: payload.date,
      duplicateOf: { checkinId: null, otoappCheckinId: appDay.id, at: appDay.checkedInAt?.toISOString() ?? null, where: 'otoapp' },
      boxCheckinId: id,
      // Recorded: the app's own check-in has no band, so these are the child's only ones.
      bandsRecorded: true,
      mirroredAs: id,
      kidBandId,
      parentBandId,
      ...trail(scope, event, payload),
    },
  });
  return { entityType: 'event_checkin', entityId: id };
}

/**
 * A box's check-in the platform cannot take as it stands, because the OTO App
 * — the master of who attends which day (Q1) — says the child is not on that
 * day, or the event is not: the box decided from a copy taken before the app
 * changed. The bands the box printed are not recorded and the app is not told;
 * a person decides (the fact waits on Failures > Quarantine), told here which
 * child it is and that the food counter will not read their band.
 */
async function refuseOffDay(
  scope: BatchScope,
  event: PreparedEvent,
  payload: OfflineEventCheckedIn,
  why: { code: string; message: string; reason: 'not_on_day' | 'not_registered' | 'archived' },
): Promise<never> {
  const because =
    why.reason === 'not_on_day'
      ? 'the event is not on that day'
      : why.reason === 'archived'
        ? 'the event has been archived'
        : 'is not registered for that day';
  try {
    await raiseAlert(
      scope.db,
      {
        key: `event.checkin_off_day:${payload.eventId}:${payload.attendeeId}:${payload.date}`,
        category: 'event.checkin_off_day',
        severity: 'warning',
        subject: `Event check-in for ${payload.childName}`,
        summary:
          `${payload.childName} was checked in to ${payload.eventTitle} offline on ${scope.auth.name} (${scope.auth.slot}) ` +
          `for ${payload.date}, but ${because} ` +
          'in the OTO App. The check-in was not filed and the OTO App was not told; the bands the box printed are not ' +
          'recorded, so the food counter will not read them — check the child and their allergy line.',
        detail: {
          eventId: payload.eventId,
          attendeeId: payload.attendeeId,
          date: payload.date,
          reason: why.reason,
          boxId: scope.auth.boxId,
          checkinId: payload.checkinId,
          kidBandId: payload.kidBand?.id ?? null,
          parentBandId: payload.parentBand?.id ?? null,
          eventIdOfFact: event.envelope.eventId,
        },
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
      },
      { flapWindowSeconds: 0 },
    );
  } catch (err) {
    scope.log?.error({ err, checkinId: payload.checkinId }, 'an off-day event check-in could not be alerted; its quarantine row names it');
  }
  throw conflict(why.code, why.message, { eventId: payload.eventId, attendeeId: payload.attendeeId, date: payload.date });
}

/**
 * WHEN THE BOX CHECKED THE CHILD IN, DID THE FIRST CHECK-IN STILL STAND? A
 * check-in the OTO App took back (`takenBackBy`) stood until the app's own
 * "Undo check-in": no earlier than the app had it (`synced_at`, itself after
 * `checked_in_at`), and no earlier than the app last changed the child's day
 * row (`updated_at`, which the undo stamps). A box check-in made before that
 * moment met the first check-in standing — the box's copy could not see it
 * with the link down — so it is that day's second check-in (H4), and the
 * app's later undo stands over it. Answers the taken-back row it met, or null
 * when the box's check-in came after the undo and takes the day.
 *
 * Read by the box's clock against the platform's and the app's: a fact that
 * cannot be shown to come after the undo is the second check-in, which takes
 * nothing from the child and tells a person.
 */
async function stoodWhenBoxCheckedIn(
  tx: Tx,
  branchId: string,
  eventId: string,
  aliases: readonly string[],
  date: string,
  back: readonly CheckinRow[],
  boxAt: Date,
): Promise<CheckinRow | null> {
  const appRows = (await listEventAttendance(tx, { branchId, eventId, date })).filter((r) => aliases.includes(r.attendeeId));
  const appChangedAt = Math.max(-Infinity, ...appRows.map((r) => r.updatedAt?.getTime() ?? -Infinity));
  return (
    back.find((r) => {
      const undoneNoEarlierThan = Math.max(r.checkedInAt.getTime(), r.syncedAt?.getTime() ?? -Infinity, appChangedAt);
      return !(boxAt.getTime() >= undoneNoEarlierThan);
    }) ?? null
  );
}

async function applyEventCheckedIn(tx: Tx, scope: BatchScope, event: PreparedEvent, payload: OfflineEventCheckedIn) {
  const id = payload.checkinId.toLowerCase();
  const done = (entityId: string) => ({ entityType: 'event_checkin', entityId });
  const [held] = await tx.select().from(eventCheckin).where(eq(eventCheckin.id, id)).limit(1);
  if (held) {
    // The same fact met again (a restored store, a re-sent batch): filed already.
    if (held.operatorId !== scope.auth.operatorId || held.otoappEventId !== payload.eventId.toLowerCase()) {
      throw conflict('SYNC_EVENT_CHECKIN_ID_TAKEN', 'That check-in id already names another child’s check-in');
    }
    return done(held.id);
  }
  const ev = await eventAtPark(tx, scope, payload.eventId);
  const known = await eventChildOf(tx, scope.auth.branchId, ev, payload.attendeeId, payload.date);
  const child = known ?? unknownChild(payload);

  // S2-20 E5 (closing audit, d) — AN ARCHIVED EVENT, as the till's own
  // check-in refuses it (`EVENT_ARCHIVED`): filing the fact would owe the OTO
  // App a check-in its directory then refuses (404) for ever. Refused into
  // quarantine with the alert, as an off-day fact is, and the app not told.
  if (ev.archived) {
    return refuseOffDay(scope, event, payload, {
      code: 'SYNC_EVENT_ARCHIVED',
      message: `${ev.title} has been archived in the OTO App, so nobody can be checked in to it`,
      reason: 'archived',
    });
  }
  // "NOT REGISTERED FOR TODAY" ON THE BOX DOOR TOO (H5): the online rules, on
  // the fact's own day, from what the OTO App says now — not the box's copy.
  if (!eventListedOn(ev, payload.date)) {
    return refuseOffDay(scope, event, payload, {
      code: 'SYNC_EVENT_NOT_ON_DAY',
      message: `${ev.title} is not on ${payload.date}, so nobody can be checked in to it that day`,
      reason: 'not_on_day',
    });
  }
  if (known && !known.attends) {
    return refuseOffDay(scope, event, payload, {
      code: 'SYNC_EVENT_NOT_REGISTERED',
      message: `${payload.childName} is not registered for ${payload.date} in the OTO App`,
      reason: 'not_registered',
    });
  }

  // ONE CHECK-IN PER CHILD PER DAY (H4): the first one stands — unless the
  // OTO App took it back (its own "Undo check-in") BEFORE the box checked the
  // child in, when the box's takes the day. The POS's rows are read before the
  // app's day (`takenBackBy`).
  const rows = await posCheckinsOf(tx, ev.id, child, payload.date);
  const appDay = await appDayOf(tx, scope.auth.branchId, ev.id, child.aliases, payload.date, id);
  const back = takenBackBy(rows, appDay);
  const standing = rows.find((r) => !back.includes(r));
  // A box's check-in made while the first one still stood — older than the
  // app's undo — is the second check-in of the day, not one after the undo:
  // it never overturns the undo, and never sets aside the paper the child got
  // at the first.
  const stoodThen =
    !standing && back.length > 0
      ? await stoodWhenBoxCheckedIn(tx, scope.auth.branchId, ev.id, child.aliases, payload.date, back, new Date(payload.at))
      : null;
  const first = standing ?? stoodThen;
  const setAside =
    !first && back.length > 0
      ? await undoTakenBack(tx, back, {
          operatorId: scope.auth.operatorId,
          branchId: scope.auth.branchId,
          actorAccountId: event.envelope.actorAccountId ?? null,
          actionId: event.envelope.actionId ?? null,
          sourceEventId: event.envelope.eventId,
          stationId: stationOf(scope, event),
          boxId: scope.auth.boxId,
          nextCheckinId: id,
          now: event.occurredAt,
        })
      : null;
  if (!first && appDay?.status === 'checked_in') {
    // Checked in at the OTO App's own screen, which prints no band: the bands
    // this box printed are the only ones the child wears, so they are recorded
    // on the app's check-in, mirrored here (H9) — the app is not told again.
    return mirrorWithBoxBands(tx, scope, event, payload, ev, child, appDay);
  }
  if (first || appDay) {
    const firstFacts: FirstCheckin = first
      ? {
          checkinId: first.id,
          at: first.checkedInAt.toISOString(),
          where: 'pos',
          ...(first === stoodThen ? { takenBack: true as const } : {}),
        }
      : { checkinId: null, at: appDay!.checkedInAt?.toISOString() ?? null, where: 'otoapp' };
    await alertCheckedInTwice(scope, event, payload, firstFacts, { kind: 'duplicate' });
    await audit.record(tx, {
      ...auditBase(scope, event),
      action: 'event.checkin_duplicate',
      entityType: 'event_checkin',
      entityId: first?.id ?? id,
      after: {
        eventId: ev.id,
        attendeeId: child.attendeeId,
        date: payload.date,
        duplicateOf: firstFacts,
        boxCheckinId: id,
        // Not recorded: the gate never admits a band the platform does not hold.
        bandsRecorded: false,
        ...trail(scope, event, payload),
      },
    });
    return done(first?.id ?? id);
  }

  const at = new Date(payload.at);
  const actor = event.envelope.actorAccountId ?? null;
  const staffName = actor ? await staffNameOf(tx, actor) : null;
  const writeback: DirectoryCheckinBody = {
    id,
    date: payload.date,
    checkedInAt: at.toISOString(),
    checkedInBy: staffName,
  };
  await tx.insert(eventCheckin).values({
    id,
    operatorId: scope.auth.operatorId,
    branchId: scope.auth.branchId,
    otoappEventId: ev.id,
    attendeeId: child.attendeeId,
    linkId: child.link?.id ?? null,
    eventType: ev.type,
    attendanceDate: payload.date,
    childName: payload.childName,
    parentName: payload.parentName ?? null,
    parentAttending: payload.parentAttending,
    allergy: payload.allergy?.trim() || null,
    dietary: payload.dietary?.trim() || null,
    eventTitle: payload.eventTitle || ev.title,
    startTime: payload.startTime ?? ev.startTime,
    endTime: payload.endTime ?? ev.endTime,
    checkedInAt: at,
    checkedInByAccountId: actor,
    checkedInByName: staffName,
    stationId: stationOf(scope, event),
    boxId: scope.auth.boxId,
    origin: 'box',
    sourceEventId: event.envelope.eventId,
    boxSeq: event.envelope.boxSeq,
    syncState: 'pending',
    writeback,
    actionId: event.envelope.actionId ?? null,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  });
  const detail = { eventId: ev.id, attendeeId: child.attendeeId, date: payload.date };
  const kidBandId = payload.kidBand ? await recordBoxBand(tx, scope, event, id, payload.kidBand, 'kid', detail) : null;
  const parentBandId = payload.parentBand
    ? await recordBoxBand(tx, scope, event, id, payload.parentBand, 'adult', detail)
    : null;
  if (kidBandId || parentBandId) {
    await tx.update(eventCheckin).set({ kidBandId, parentBandId }).where(eq(eventCheckin.id, id));
  }
  await audit.record(tx, {
    ...auditBase(scope, event),
    action: 'event.checkin',
    entityType: 'event_checkin',
    entityId: id,
    after: {
      eventId: ev.id,
      eventType: ev.type,
      attendeeId: child.attendeeId,
      linkId: child.link?.id ?? null,
      date: payload.date,
      checkedInAt: at.toISOString(),
      kidBandId,
      parentBandId,
      origin: 'box',
      ...trail(scope, event, payload),
    },
  });
  if (setAside) {
    // The paper the first check-in printed is revoked now, and the child may
    // be wearing it: a person checks which band they have on.
    const taken = back[0]!;
    await alertCheckedInTwice(
      scope,
      event,
      payload,
      { checkinId: taken.id, at: taken.checkedInAt.toISOString(), where: 'pos', takenBack: true },
      { kind: 'set_aside', setAside },
    );
  }
  return done(id);
}

async function applyEventCheckedOut(tx: Tx, scope: BatchScope, event: PreparedEvent, payload: OfflineEventCheckedOut) {
  const id = payload.checkinId.toLowerCase();
  const done = (entityId: string) => ({ entityType: 'event_checkin', entityId });
  const ev = await eventAtPark(tx, scope, payload.eventId);
  const child = await childOf(tx, scope, ev, payload);
  let [row] = await tx
    .select()
    .from(eventCheckin)
    .where(and(eq(eventCheckin.id, id), eq(eventCheckin.operatorId, scope.auth.operatorId)))
    .limit(1);
  row ??= (await posCheckinsOf(tx, ev.id, child, payload.date))[0];
  const at = new Date(payload.at);
  const actor = event.envelope.actorAccountId ?? null;
  const staffName = actor ? await staffNameOf(tx, actor) : null;
  if (!row) {
    // Checked in at the OTO App alone: mirrored now, as it checks out.
    const appDay = await appDayOf(tx, scope.auth.branchId, ev.id, child.aliases, payload.date);
    if (!appDay?.checkedInAt) {
      // The check-in this ends is another box's, still on its way: a replay files it.
      throw retry('SYNC_EVENT_CHECKIN_UNKNOWN', 'The check-in this check-out ends is not on the platform yet');
    }
    const known = await eventChildOf(tx, scope.auth.branchId, ev, payload.attendeeId, payload.date);
    const [mirror] = await tx
      .insert(eventCheckin)
      .values({
        id,
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
        otoappEventId: ev.id,
        attendeeId: child.attendeeId,
        linkId: child.link?.id ?? null,
        eventType: ev.type,
        attendanceDate: payload.date,
        childName: known?.childName ?? 'Child',
        parentName: known?.parentName ?? null,
        parentAttending: known?.parentAttending ?? false,
        allergy: known?.allergy ?? null,
        dietary: known?.dietary ?? null,
        eventTitle: ev.title,
        startTime: ev.startTime,
        endTime: ev.endTime,
        checkedInAt: appDay.checkedInAt,
        checkedInByName: appDay.checkedInBy,
        stationId: stationOf(scope, event),
        boxId: scope.auth.boxId,
        origin: 'otoapp',
        otoappCheckinId: appDay.id,
        sourceEventId: event.envelope.eventId,
        boxSeq: event.envelope.boxSeq,
        syncState: 'synced',
        syncedAt: event.receivedAt,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      })
      .returning();
    row = mirror!;
  }
  if (row.otoappEventId !== ev.id) throw poison('SYNC_EVENT_CHECKOUT_MISMATCH', 'That check-out names another event');
  /**
   * S2-20 E5 (closing audit, b) — THE CHECK-IN THIS ENDS WAS SET ASIDE. The
   * box checked the child out of the check-in it made, and since then the OTO
   * App undid that check-in and the child was checked in again (`undone_at`).
   * The check-out is the child leaving: when it came after the check-in that
   * stands now, it ends THAT one — closing only the set-aside row would leave
   * the child "in" on the roster and their working bands live after they left.
   * A check-out from before the child's new check-in belongs to the visit that
   * was set aside, and the standing check-in (the child came back) stays open.
   */
  let setAsideOf: CheckinRow | null = null;
  if (row.undoneAt) {
    const [standing] = await posCheckinsOf(
      tx,
      ev.id,
      { aliases: [...new Set([...child.aliases, row.attendeeId])], link: child.link },
      row.attendanceDate,
    );
    if (standing && standing.id !== row.id && standing.checkedInAt.getTime() <= at.getTime()) {
      setAsideOf = row;
      row = standing;
    }
  }
  if (row.checkedOutAt) return done(row.id);
  // Never before the check-in it ends: the two clocks may disagree.
  const outAt = at.getTime() < row.checkedInAt.getTime() ? row.checkedInAt : at;
  await tx
    .update(eventCheckin)
    .set({ checkedOutAt: outAt, checkedOutByAccountId: actor, checkedOutByName: staffName, updatedAt: event.occurredAt })
    .where(and(eq(eventCheckin.id, row.id), isNull(eventCheckin.checkedOutAt)));
  await audit.record(tx, {
    ...auditBase(scope, event),
    action: 'event.checkout',
    entityType: 'event_checkin',
    entityId: row.id,
    before: { checkedOutAt: null },
    after: {
      eventId: ev.id,
      attendeeId: row.attendeeId,
      date: payload.date,
      checkedOutAt: outAt.toISOString(),
      writtenBack: false,
      // The box's own check-in had been set aside; the check-out ended the one that stands.
      ...(setAsideOf ? { boxCheckinId: setAsideOf.id, endedStanding: true } : {}),
      ...trail(scope, event, payload),
    },
  });
  return done(row.id);
}

/**
 * S2-20 E5 (closing audit, c) — A ROW THE TILL FILED IN THE SAME INSTANT. The
 * box door decides a fact from the rows it reads; a till's check-in (or its
 * mirror of an OTO App check-in) committed between that read and this write
 * meets the one-check-in-per-child-per-day key first. The fact is then decided
 * once more, in a fresh savepoint, with that row standing — a duplicate filed
 * against it, H4 — rather than quarantined as a failure to apply.
 */
async function decidedOnceMore<T>(tx: Tx, apply: (sp: Tx) => Promise<T>): Promise<T> {
  try {
    return await tx.transaction((sp) => apply(sp));
  } catch (err) {
    if (!isDayTaken(err)) throw err;
    return tx.transaction((sp) => apply(sp));
  }
}

export const EVENT_HANDLERS: Record<string, EventHandler> = {
  [EVENT_FACTS.checkedIn]: {
    schema: OfflineEventCheckedInSchema,
    apply: (tx, scope, event, payload: OfflineEventCheckedIn) =>
      decidedOnceMore(tx, (sp) => applyEventCheckedIn(sp, scope, event, payload)),
  },
  [EVENT_FACTS.checkedOut]: {
    schema: OfflineEventCheckedOutSchema,
    apply: (tx, scope, event, payload: OfflineEventCheckedOut) =>
      decidedOnceMore(tx, (sp) => applyEventCheckedOut(sp, scope, event, payload)),
  },
};
