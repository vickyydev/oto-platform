import { and, eq, isNull } from 'drizzle-orm';
import { band, bandEvent, eventCheckin } from '@oto/db';
import {
  EVENT_FACTS,
  OfflineEventCheckedInSchema,
  OfflineEventCheckedOutSchema,
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
import { appDayOf, eventChildOf, posCheckinsOf, type EventChild } from './event-checkins';
import { staffNameOf } from './event-writes';
import { raiseAlert } from './ops';
import { getBranchEvent, type SeamEvent } from './otoapp-events';
import type { DirectoryCheckinBody } from './otoapp-directory';
import type { Tx } from './tx';
import type { BatchScope, EventHandler, PreparedEvent } from './sync';

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
 *   - ONE CHECK-IN PER CHILD PER DAY (H4): a child the platform already has in
 *     for the day — checked in at a till with the internet, at another box, or
 *     in the OTO App itself — RESOLVES TO THAT FIRST CHECK-IN. The box's fact
 *     is filed against it, NO SECOND BAND IS RECORDED (so the gate never admits
 *     the paper the box printed), and a warning alert names both so a person
 *     can check which band the child is wearing;
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

/** The child as the platform knows them now, or as the box's copy had them when the app no longer does. */
async function childOf(
  tx: Tx,
  scope: BatchScope,
  event: SeamEvent,
  payload: { attendeeId: string; date: string },
): Promise<Pick<EventChild, 'attendeeId' | 'link' | 'aliases'>> {
  const known = await eventChildOf(tx, scope.auth.branchId, event, payload.attendeeId, payload.date);
  const id = payload.attendeeId.toLowerCase();
  return known ?? { attendeeId: id, link: null, aliases: [id] };
}

async function alertCheckedInTwice(
  scope: BatchScope,
  event: PreparedEvent,
  payload: OfflineEventCheckedIn,
  first: { checkinId: string | null; at: string | null; where: 'pos' | 'otoapp' },
): Promise<void> {
  try {
    await raiseAlert(
      scope.db,
      {
        key: `event.checked_in_twice:${payload.eventId}:${payload.attendeeId}:${payload.date}`,
        category: 'event.checked_in_twice',
        severity: 'warning',
        subject: `Event check-in for ${payload.childName}`,
        summary:
          `${payload.childName} was checked in to ${payload.eventTitle} offline on ${scope.auth.name} (${scope.auth.slot}) ` +
          `at ${payload.at}, but was already checked in for ${payload.date}` +
          `${first.where === 'otoapp' ? ' in the OTO App' : ''}. The box's bands were not recorded — ` +
          'check which band the child is wearing.',
        detail: {
          eventId: payload.eventId,
          attendeeId: payload.attendeeId,
          date: payload.date,
          first,
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
  const child = await childOf(tx, scope, ev, payload);

  // ONE CHECK-IN PER CHILD PER DAY (H4): the first one stands.
  const [first] = await posCheckinsOf(tx, ev.id, child, payload.date);
  const appDay = first ? null : await appDayOf(tx, scope.auth.branchId, ev.id, child.aliases, payload.date);
  if (first || appDay) {
    const firstFacts = first
      ? { checkinId: first.id, at: first.checkedInAt.toISOString(), where: 'pos' as const }
      : { checkinId: null, at: appDay!.checkedInAt?.toISOString() ?? null, where: 'otoapp' as const };
    await alertCheckedInTwice(scope, event, payload, firstFacts);
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
      ...trail(scope, event, payload),
    },
  });
  return done(row.id);
}

export const EVENT_HANDLERS: Record<string, EventHandler> = {
  [EVENT_FACTS.checkedIn]: {
    schema: OfflineEventCheckedInSchema,
    apply: (tx, scope, event, payload: OfflineEventCheckedIn) => applyEventCheckedIn(tx, scope, event, payload),
  },
  [EVENT_FACTS.checkedOut]: {
    schema: OfflineEventCheckedOutSchema,
    apply: (tx, scope, event, payload: OfflineEventCheckedOut) => applyEventCheckedOut(tx, scope, event, payload),
  },
};
