import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import {
  band,
  bandEvent,
  checkin,
  child,
  fileObject,
  guardian,
  member,
  memberAlias,
  nanny,
  nannyShift,
  registration,
  release,
  sale,
  saleLine,
  supervisionWaiver,
  syncQuarantine,
  visit,
  type Db,
} from '@oto/db';
import {
  CHECKIN_FACTS,
  OfflineCheckinCreatedSchema,
  OfflineCheckinUpdatedSchema,
  OfflineGuardianCreatedSchema,
  OfflineReleaseCreatedSchema,
  OfflineWaiverCreatedSchema,
  PHOTO_TARGETS,
  newId,
  normaliseBandCode,
  normalizePhone,
  parseBandCode,
  prepaidPaidMismatchRefusal,
  verifyBandCode,
  type BridgeCheckinFamily,
  type BridgeGuardian,
  type BridgeReleaseRecord,
  type CheckinCacheItem,
  type OfflineCheckinCreated,
  type OfflineCheckinUpdated,
  type OfflineGuardianCreated,
  type OfflineReleaseCreated,
  type OfflineWaiverCreated,
  type PhotoTarget,
} from '@oto/shared';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { currentBandKey } from './bands';
import type { BoxAuth } from './box';
import { boardOf, supervisionConfigOf } from './checkin';
import type { FileStorage } from './files';
import { raiseAlert } from './ops';
import type { OpContext, Tx } from './tx';
import type { BatchScope, EventHandler, PreparedEvent } from './sync';

/**
 * THE CLOUD'S SIDE OF CHECK-IN ON THE BOX LANE (S2-13 round 4, plan §2.5).
 *
 * A counter with the link down registers a family, checks children in with
 * bands it mints itself, edits the board and releases children to their
 * collectors — each a fact on its outbox, written in one store transaction
 * with its overlay (`@oto/box-agent` `checkin-desk.ts`). When the link is
 * back those facts arrive here, in the order the box queued them, and are
 * filed ONCE:
 *
 *   - every handler is IDEMPOTENT on the till-minted id it carries — the same
 *     fact under a new envelope (a restored store, a replay from the Failures
 *     tab) meets the row it wrote the first time and writes nothing;
 *   - tenancy comes from the box's CREDENTIAL, never the payload;
 *   - every row is audited with `source_event_id`, `action_id`, the box and
 *     `offline: true`, so one press is findable from till to ledger;
 *   - a fact whose prerequisite has not arrived yet (another box's stay, a
 *     sale still on the queue) is refused `apply_failed`, which a replay fixes;
 *   - A RELEASE THAT CONFLICTS WITH ONE RECORDED ONLINE MEANWHILE — the child
 *     already collected at a counter with the internet, or at another box — is
 *     NEVER APPLIED BLIND: it is quarantined (`conflict`) with a critical alert
 *     naming both releases, exactly as the booking double is.
 *
 * Refusals travel as `AppError` with the quarantine reason in
 * `details.quarantineReason` (`classifyFailure` in `sync.ts`), because this
 * file must not import `sync.ts`'s `RefuseEvent` at runtime.
 *
 * PHOTOS taken offline arrive later, through the box's upload worker
 * (`presignBoxPhoto`, `linkBoxPhoto` below): each row's photo is linked
 * EXACTLY ONCE, and `photo_pending_upload` clears when it is.
 */

type StayRow = typeof checkin.$inferSelect;

const retry = (code: string, message: string): AppError =>
  new AppError(409, code, message, { quarantineReason: 'apply_failed' });
const conflict = (code: string, message: string, details: Record<string, unknown> = {}): AppError =>
  new AppError(409, code, message, { ...details, quarantineReason: 'conflict' });
const poison = (code: string, message: string): AppError =>
  new AppError(400, code, message, { quarantineReason: 'poison' });

function actorOf(event: PreparedEvent): string | null {
  return event.envelope.actorAccountId ?? null;
}

function stationOf(scope: BatchScope, event: PreparedEvent): string | null {
  const id = event.envelope.stationId ?? null;
  return id && scope.stationIds.has(id) ? id : null;
}

/** What every audit row this file writes carries beside its own fields. */
function trail(scope: BatchScope, event: PreparedEvent, payload: { offlineFresh?: boolean }) {
  return {
    boxId: scope.auth.boxId,
    stationId: stationOf(scope, event),
    offline: true,
    ...(payload.offlineFresh ? { offlineFresh: true } : {}),
  };
}

function auditBase(scope: BatchScope, event: PreparedEvent) {
  return {
    actorAccountId: actorOf(event),
    operatorId: scope.auth.operatorId,
    branchId: scope.auth.branchId,
    requestId: null,
    actionId: event.envelope.actionId ?? null,
    sourceEventId: event.envelope.eventId,
  };
}

async function survivingMember(tx: Tx, operatorId: string, memberId: string): Promise<string | null> {
  const [alias] = await tx
    .select({ memberId: memberAlias.memberId })
    .from(memberAlias)
    .where(and(eq(memberAlias.aliasMemberId, memberId), eq(memberAlias.operatorId, operatorId)))
    .limit(1);
  const id = alias?.memberId ?? memberId;
  const [row] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.id, id), eq(member.operatorId, operatorId)))
    .limit(1);
  return row?.id ?? null;
}

async function lockedStay(tx: Tx, scope: BatchScope, checkinId: string): Promise<StayRow> {
  const [stay] = await tx
    .select()
    .from(checkin)
    .where(and(eq(checkin.id, checkinId), eq(checkin.operatorId, scope.auth.operatorId)))
    .for('update')
    .limit(1);
  if (!stay) {
    // Another box's registration, still on its way: a replay files this.
    throw retry('SYNC_CHECKIN_UNKNOWN', 'That check-in is not on the platform yet');
  }
  if (stay.branchId !== scope.auth.branchId) {
    throw poison('SYNC_CHECKIN_NOT_OURS', 'That check-in is at another park than the box that sent it');
  }
  return stay;
}

// --- checkin.created: the registration from the gate -----------------------------------

async function applyCheckinCreated(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  payload: OfflineCheckinCreated,
) {
  const operatorId = scope.auth.operatorId;
  const branchId = scope.auth.branchId;
  const [existing] = await tx.select().from(registration).where(eq(registration.id, payload.registrationId)).limit(1);
  if (existing && (existing.operatorId !== operatorId || existing.branchId !== branchId)) {
    throw conflict('SYNC_REGISTRATION_ID_TAKEN', 'That registration id already names another park’s registration');
  }

  let memberId: string | null = null;
  if (payload.memberId) {
    memberId = await survivingMember(tx, operatorId, payload.memberId);
    if (!memberId) throw retry('SYNC_CHECKIN_MEMBER_UNKNOWN', 'The guardian on this registration is not on the platform yet');
  }
  if (payload.visitId) {
    const [v] = await tx
      .select({ id: visit.id })
      .from(visit)
      .where(and(eq(visit.id, payload.visitId), eq(visit.operatorId, operatorId)))
      .limit(1);
    if (!v) throw retry('SYNC_CHECKIN_VISIT_UNKNOWN', 'The visit on this registration is not on the platform yet');
  }
  const savedIds = payload.children.map((c) => c.childId).filter((id): id is string => !!id);
  if (savedIds.length > 0) {
    const rows = await tx
      .select({ id: child.id, memberId: child.memberId })
      .from(child)
      .where(inArray(child.id, savedIds));
    if (rows.length !== new Set(savedIds).size || rows.some((r) => r.memberId !== memberId)) {
      throw retry('SYNC_CHECKIN_CHILD_UNKNOWN', 'A child on this registration is not on the guardian’s list on the platform yet');
    }
  }
  let guardianPhone: string | null = null;
  if (payload.guardianPhone?.trim()) {
    guardianPhone = normalizePhone(payload.guardianPhone);
    if (!guardianPhone) throw poison('SYNC_PHONE_INVALID', 'The guardian’s phone number is not usable');
  }
  const at = event.occurredAt;
  const base = auditBase(scope, event);
  const extra = trail(scope, event, payload);

  if (!existing) {
    await tx.insert(registration).values({
      id: payload.registrationId,
      operatorId,
      branchId,
      memberId,
      guardianName: payload.guardianName.trim(),
      guardianPhone,
      contactChannel: payload.contactChannel,
      consentRecordedAt: payload.consentRecordedAt ? new Date(payload.consentRecordedAt) : null,
      acknowledgedConfirmations: payload.acknowledgedConfirmations,
      source: 'till',
      stationId: stationOf(scope, event),
      createdByAccountId: actorOf(event),
      createdAt: at,
      updatedAt: at,
    });
    await audit.record(tx, {
      ...base,
      action: 'registration.create',
      entityType: 'registration',
      entityId: payload.registrationId,
      after: {
        memberId,
        guardianName: payload.guardianName.trim(),
        guardianPhone,
        contactChannel: payload.contactChannel,
        consentRecordedAt: payload.consentRecordedAt,
        acknowledgedConfirmations: payload.acknowledgedConfirmations,
        children: payload.children.map((c) => ({ checkinId: c.checkinId, name: c.name, service: c.service })),
        photoPendingUpload: !!payload.photoId,
        ...extra,
      },
    });
  }

  // The stays, each once: a replay under a new envelope finds them written.
  const ids = payload.children.map((c) => c.checkinId);
  const taken = await tx
    .select({ id: checkin.id, registrationId: checkin.registrationId })
    .from(checkin)
    .where(inArray(checkin.id, ids));
  for (const t of taken) {
    if (t.registrationId !== payload.registrationId) {
      throw conflict('SYNC_CHECKIN_ID_TAKEN', 'A check-in id on this registration already names another family’s child');
    }
  }
  const held = new Set(taken.map((t) => t.id));
  const setAside: PrepaidSetAside[] = [];
  for (const c of payload.children) {
    if (held.has(c.checkinId)) continue;
    const { provision, mismatch } = provisionOfReplay(c.foodProvision ?? null);
    if (mismatch) setAside.push({ checkinId: c.checkinId, childName: c.name.trim(), ...mismatch });
    const mayOrderFood = !!provision && provision.mode !== 'none' && provision.paidSatang > 0;
    await tx.insert(checkin).values({
      id: c.checkinId,
      operatorId,
      branchId,
      registrationId: payload.registrationId,
      childId: c.childId ?? null,
      childName: c.name.trim(),
      childAgeYears: c.ageYears,
      dateOfBirth: c.dateOfBirth ?? null,
      allergies: c.allergies?.trim() || null,
      foodRestrictions: c.foodRestrictions?.trim() || null,
      mayOrderFood,
      foodProvision: provision,
      service: c.service,
      status: 'registered',
      visitId: payload.visitId ?? null,
      offline: true,
      createdAt: at,
      updatedAt: at,
    });
    await audit.record(tx, {
      ...base,
      action: 'checkin.create',
      entityType: 'checkin',
      entityId: c.checkinId,
      after: {
        registrationId: payload.registrationId,
        childId: c.childId ?? null,
        childName: c.name.trim(),
        childAgeYears: c.ageYears,
        service: c.service,
        allergies: c.allergies?.trim() || null,
        foodRestrictions: c.foodRestrictions?.trim() || null,
        mayOrderFood,
        foodProvision: provision,
        ...(mismatch
          ? { prepaidSetAside: { itemsSatang: mismatch.itemsSatang, paidSatang: mismatch.paidSatang, provision: mismatch.provision } }
          : {}),
        ...extra,
      },
    });
  }
  if (setAside.length > 0) await fileSetAsidePrepaid(tx, scope, event, payload, setAside);
  return { entityType: 'registration', entityId: payload.registrationId };
}

/** A child's prepaid food the platform did not keep as their entitlement. */
interface PrepaidSetAside {
  checkinId: string;
  childName: string;
  itemsSatang: number;
  paidSatang: number;
  provision: NonNullable<OfflineCheckinCreated['children'][number]['foodProvision']>;
}

/**
 * The online registration's provision rules (`checkin.ts normaliseProvision`,
 * `assertPrepaidItems`) for a registration the box already recorded: a prepaid
 * mode that paid nothing is `none`, every prepaid item starts unserved, and
 * prepaid items whose sum is not what was paid are not kept as the child's
 * entitlement. The box refuses that mismatch at its counter; one that still
 * arrives cannot be refused after the fact, so the stay is stored without the
 * prepaid food and the mismatch is returned for quarantine.
 */
function provisionOfReplay(raw: OfflineCheckinCreated['children'][number]['foodProvision'] | null): {
  provision: OfflineCheckinCreated['children'][number]['foodProvision'] | null;
  mismatch: Omit<PrepaidSetAside, 'checkinId' | 'childName'> | null;
} {
  if (!raw) return { provision: null, mismatch: null };
  const paid = raw.mode !== 'none' && raw.paidSatang <= 0 ? { mode: 'none' as const, paidSatang: 0 } : raw;
  const provision =
    paid.mode === 'prepaid_items' && paid.items
      ? { ...paid, items: paid.items.map((it) => ({ ...it, redeemedQty: 0 })) }
      : paid;
  if (provision.mode !== 'prepaid_items') return { provision, mismatch: null };
  const itemsSatang = (provision.items ?? []).reduce((s, it) => s + it.unitSatang * it.qty, 0);
  if (itemsSatang === provision.paidSatang) return { provision, mismatch: null };
  return { provision: null, mismatch: { itemsSatang, paidSatang: provision.paidSatang, provision } };
}

/**
 * Files a registration whose prepaid food was set aside: the event itself is
 * applied (the family is registered), and it is also held in quarantine
 * (`conflict`) with a critical alert, so a person settles what the family paid
 * against what they chose. One row per event, as `sync.ts fileQuarantine`.
 */
async function fileSetAsidePrepaid(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  payload: OfflineCheckinCreated,
  setAside: readonly PrepaidSetAside[],
): Promise<void> {
  const env = event.envelope;
  const alertKey = `checkin.prepaid_paid_mismatch:${payload.registrationId}`;
  const message = setAside.map((s) => prepaidPaidMismatchRefusal(s.childName, s.itemsSatang, s.paidSatang)).join(' ');
  const errorMessage =
    `Registered offline, but the prepaid food was not kept: ${message} ` +
    'The children are registered without prepaid food — settle what the family paid with them.';
  const [open] = await tx
    .select({ id: syncQuarantine.id })
    .from(syncQuarantine)
    .where(
      and(
        eq(syncQuarantine.boxId, scope.auth.boxId),
        eq(syncQuarantine.eventId, env.eventId),
        eq(syncQuarantine.journalEpoch, env.journalEpoch),
        eq(syncQuarantine.status, 'open'),
      ),
    )
    .limit(1);
  if (!open) {
    await tx.insert(syncQuarantine).values({
      id: newId(),
      boxId: scope.auth.boxId,
      eventId: env.eventId,
      journalEpoch: env.journalEpoch,
      boxSeq: env.boxSeq,
      type: env.type,
      schemaVersion: env.schemaVersion,
      reason: 'conflict',
      status: 'open',
      errorCode: 'SYNC_PREPAID_PAID_MISMATCH',
      errorMessage,
      payload: env as never,
      payloadHash: env.payloadHash,
      sig: env.sig,
      occurredAt: event.occurredAt,
      actionId: env.actionId ?? null,
      alertKey,
    });
  }
  for (const s of setAside) {
    await audit.record(tx, {
      ...auditBase(scope, event),
      action: 'checkin.prepaid_set_aside',
      entityType: 'checkin',
      entityId: s.checkinId,
      after: {
        registrationId: payload.registrationId,
        childName: s.childName,
        itemsSatang: s.itemsSatang,
        paidSatang: s.paidSatang,
        provision: s.provision,
        quarantined: true,
        ...trail(scope, event, payload),
      },
    });
  }
  try {
    await raiseAlert(
      scope.db,
      {
        key: alertKey,
        category: 'checkin.prepaid_paid_mismatch',
        severity: 'critical',
        subject: `Prepaid food for ${setAside.map((s) => s.childName).join(', ')}`,
        summary:
          `A registration recorded offline on ${scope.auth.name} (${scope.auth.slot}) carried prepaid food whose amount paid ` +
          `is not the items' sum. ${message} The children are registered without the prepaid food; the registration is held ` +
          'in quarantine — settle what the family paid with them.',
        detail: {
          registrationId: payload.registrationId,
          eventId: env.eventId,
          boxId: scope.auth.boxId,
          children: setAside.map((s) => ({
            checkinId: s.checkinId,
            childName: s.childName,
            itemsSatang: s.itemsSatang,
            paidSatang: s.paidSatang,
          })),
        },
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
      },
      { flapWindowSeconds: 0 },
    );
  } catch (err) {
    scope.log?.error({ err, registrationId: payload.registrationId }, 'a prepaid mismatch could not be alerted; its quarantine row names it');
  }
}

// --- checkin.updated: check in now, leave as booked, the board's edits -------------------

/** The band the box minted at "Check in now", recorded as it is (OD-13), once. */
async function recordCheckinBand(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  stay: StayRow,
  saleRow: typeof sale.$inferSelect,
  minted: NonNullable<OfflineCheckinUpdated['band']>,
): Promise<{ bandId: string; stayHours: number | null }> {
  const [kidsLine] = await tx
    .select()
    .from(saleLine)
    .where(and(eq(saleLine.saleId, saleRow.id), eq(saleLine.cartLineId, stay.id), eq(saleLine.kind, 'kids')))
    .orderBy(asc(saleLine.lineNo))
    .limit(1);
  const stayHours = kidsLine?.stayHours ?? null;
  const [held] = await tx.select().from(band).where(eq(band.id, minted.id)).limit(1);
  if (held) {
    if (held.saleId !== saleRow.id) throw conflict('SYNC_BAND_ID_TAKEN', 'That band id already names another sale’s band');
    return { bandId: held.id, stayHours };
  }
  const parsed = parseBandCode(minted.code);
  const key = currentBandKey();
  if (!parsed || (key && !verifyBandCode(minted.code, key).ok)) {
    throw poison('SYNC_BAND_CODE_INVALID', 'The band this box printed does not carry a code this park signs');
  }
  let childId: string | null = null;
  if (stay.childId) {
    const [c] = await tx.select({ id: child.id }).from(child).where(eq(child.id, stay.childId)).limit(1);
    childId = c?.id ?? null;
  }
  await tx.insert(band).values({
    id: minted.id,
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    saleId: saleRow.id,
    saleLineId: kidsLine?.id ?? null,
    memberId: saleRow.memberId,
    childId,
    kind: 'kid',
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
    detail: {
      saleId: saleRow.id,
      saleLineId: kidsLine?.id ?? null,
      childId,
      checkinId: stay.id,
      origin: 'box',
      sourceEventId: event.envelope.eventId,
    },
    createdAt: event.occurredAt,
  });
  return { bandId: minted.id, stayHours };
}

async function finalisedSale(tx: Tx, scope: BatchScope, saleId: string): Promise<typeof sale.$inferSelect> {
  const [row] = await tx
    .select()
    .from(sale)
    .where(and(eq(sale.id, saleId), eq(sale.operatorId, scope.auth.operatorId)))
    .limit(1);
  if (!row || row.status !== 'finalised') {
    throw retry('SYNC_CHECKIN_SALE_PENDING', 'The sale these children were paid on is not filed yet');
  }
  return row;
}

async function nannyAtBranch(tx: Tx, branchId: string, nannyId: string): Promise<string> {
  const [row] = await tx
    .select({ id: nanny.id, name: nanny.name })
    .from(nanny)
    .where(and(eq(nanny.id, nannyId), eq(nanny.branchId, branchId)))
    .limit(1);
  if (!row) throw poison('SYNC_NANNY_UNKNOWN', 'That nanny is not on this park’s roster');
  return row.name;
}

async function applyCheckinUpdated(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  payload: OfflineCheckinUpdated,
) {
  const stay = await lockedStay(tx, scope, payload.checkinId);
  const base = auditBase(scope, event);
  const extra = trail(scope, event, payload);
  const at = new Date(payload.at);
  const done = { entityType: 'checkin', entityId: stay.id };

  if (payload.event === 'check_in_now') {
    // THE SAME FACT MET AGAIN (a restored store, a re-sent batch, a Failures-tab
    // replay): the band it carries is the band on the stay, paid on the same
    // sale, so this press was applied the first time. Whatever has happened to
    // the child since — collected, even — nothing is written and nothing is
    // raised. Only a check-in the platform does NOT already hold under this
    // band is "checked in twice" (gate r4, finding 1).
    if (payload.band && stay.bandId === payload.band.id && stay.saleId === payload.saleId) return done;
    if (stay.status !== 'registered') {
      await alertCheckinTwice(scope, event, stay, payload);
      throw conflict(
        'SYNC_CHECKIN_TWICE',
        `${stay.childName} was already ${stay.status === 'in_park' ? 'checked in' : 'collected'} on the platform; this box's check-in was not applied`,
        { checkinId: stay.id },
      );
    }
    if (!payload.saleId) throw poison('SYNC_CHECKIN_SALE_MISSING', 'A check-in names the sale it was paid on');
    const saleRow = await finalisedSale(tx, scope, payload.saleId);
    const issued = payload.band ? await recordCheckinBand(tx, scope, event, stay, saleRow, payload.band) : null;
    const bookedMinutes =
      payload.bookedMinutes ?? (issued?.stayHours && issued.stayHours > 0 ? issued.stayHours * 60 : stay.bookedMinutes);
    // The service the box checked the child in on (the paid line's Drop-Off /
    // Nanny switch); a fact without one keeps the stay's own.
    const service = payload.service ?? stay.service;
    const nannyId = service === 'nanny' ? (payload.nannyId ?? stay.nannyId) : null;
    if (nannyId) await nannyAtBranch(tx, stay.branchId, nannyId);
    await tx
      .update(checkin)
      .set({
        status: 'in_park',
        checkedInAt: at,
        checkedInByAccountId: actorOf(event),
        scheduledFor: null,
        bookedMinutes,
        service,
        nannyId,
        saleId: saleRow.id,
        bandId: issued?.bandId ?? stay.bandId,
        offline: true,
        updatedAt: event.occurredAt,
      })
      .where(eq(checkin.id, stay.id));
    await audit.record(tx, {
      ...base,
      action: 'checkin.update',
      entityType: 'checkin',
      entityId: stay.id,
      before: {
        status: stay.status,
        saleId: stay.saleId,
        service: stay.service,
        nannyId: stay.nannyId,
        scheduledFor: stay.scheduledFor?.toISOString() ?? null,
        bookedMinutes: stay.bookedMinutes,
      },
      after: {
        status: 'in_park',
        saleId: saleRow.id,
        service,
        nannyId,
        scheduledFor: null,
        bookedMinutes,
        checkedInAt: at.toISOString(),
        bandId: issued?.bandId ?? null,
        event: 'check_in_now',
        ...extra,
      },
    });
    return done;
  }

  if (payload.event === 'leave_as_booked') {
    // Checked in already (online, meanwhile): a booking for a child in the
    // park changes nothing worth a person's time.
    if (stay.status !== 'registered') return done;
    const saleRow = payload.saleId ? await finalisedSale(tx, scope, payload.saleId) : null;
    const scheduledFor = payload.scheduledFor ? new Date(payload.scheduledFor) : at;
    if (stay.scheduledFor?.getTime() === scheduledFor.getTime() && stay.saleId === (saleRow?.id ?? stay.saleId)) return done;
    const bookedMinutes = payload.bookedMinutes ?? stay.bookedMinutes;
    await tx
      .update(checkin)
      .set({ scheduledFor, bookedMinutes, saleId: saleRow?.id ?? stay.saleId, updatedAt: event.occurredAt })
      .where(eq(checkin.id, stay.id));
    await audit.record(tx, {
      ...base,
      action: 'checkin.update',
      entityType: 'checkin',
      entityId: stay.id,
      before: { scheduledFor: stay.scheduledFor?.toISOString() ?? null, saleId: stay.saleId, bookedMinutes: stay.bookedMinutes },
      after: {
        scheduledFor: scheduledFor.toISOString(),
        saleId: saleRow?.id ?? stay.saleId,
        bookedMinutes,
        event: 'leave_as_booked',
        ...extra,
      },
    });
    return done;
  }

  // edit / assign_nanny — the board's audited edit, as the box made it.
  const f = payload.fields ?? {};
  const next = {
    childName: f.childName !== undefined ? f.childName.trim() : stay.childName,
    childAgeYears: f.childAgeYears ?? stay.childAgeYears,
    service: payload.event === 'assign_nanny' ? 'nanny' : (f.service ?? stay.service),
    bookedMinutes: f.bookedMinutes !== undefined ? f.bookedMinutes : stay.bookedMinutes,
    mayOrderFood: f.mayOrderFood ?? stay.mayOrderFood,
    foodRestrictions: f.foodRestrictions !== undefined ? f.foodRestrictions?.trim() || null : stay.foodRestrictions,
    allergies: f.allergies !== undefined ? f.allergies?.trim() || null : stay.allergies,
    nannyId: payload.nannyId !== undefined ? payload.nannyId : stay.nannyId,
  } as const;
  const resolved = { ...next, nannyId: next.service === 'nanny' ? next.nannyId : null };
  if (resolved.nannyId && resolved.nannyId !== stay.nannyId) await nannyAtBranch(tx, stay.branchId, resolved.nannyId);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of Object.keys(resolved) as Array<keyof typeof resolved>) {
    if (resolved[k] !== stay[k]) {
      before[k] = stay[k];
      after[k] = resolved[k];
    }
  }
  if (Object.keys(after).length === 0) return done;
  await tx
    .update(checkin)
    .set({ ...resolved, updatedAt: event.occurredAt })
    .where(eq(checkin.id, stay.id));
  await audit.record(tx, {
    ...base,
    action: 'checkin.update',
    entityType: 'checkin',
    entityId: stay.id,
    before,
    after: { ...after, event: payload.event === 'assign_nanny' ? 'assign_nanny' : 'edit', ...extra },
  });
  // The saved child follows the edit, as online (`editCheckin`).
  if (stay.childId && ['childName', 'childAgeYears', 'allergies', 'foodRestrictions'].some((k) => k in after)) {
    const [saved] = await tx.select().from(child).where(eq(child.id, stay.childId)).for('update').limit(1);
    if (saved) {
      const patch: Partial<typeof child.$inferInsert> = {};
      const was: Record<string, unknown> = {};
      if ('childName' in after && saved.name !== resolved.childName) {
        patch.name = resolved.childName;
        was.name = saved.name;
      }
      if ('childAgeYears' in after && saved.ageYears !== resolved.childAgeYears) {
        patch.ageYears = resolved.childAgeYears;
        was.ageYears = saved.ageYears;
      }
      if ('allergies' in after && saved.allergies !== resolved.allergies) {
        patch.allergies = resolved.allergies;
        was.allergies = saved.allergies;
      }
      if ('foodRestrictions' in after && saved.foodRestrictions !== resolved.foodRestrictions) {
        patch.foodRestrictions = resolved.foodRestrictions;
        was.foodRestrictions = saved.foodRestrictions;
      }
      if (Object.keys(patch).length > 0) {
        await tx.update(child).set({ ...patch, updatedAt: event.occurredAt }).where(eq(child.id, saved.id));
        await audit.record(tx, {
          ...base,
          action: 'child.update',
          entityType: 'child',
          entityId: saved.id,
          before: was,
          after: { ...patch, source: 'checkin_board', checkinId: stay.id, ...extra },
        });
      }
    }
  }
  return done;
}

async function alertCheckinTwice(
  scope: BatchScope,
  event: PreparedEvent,
  stay: StayRow,
  payload: OfflineCheckinUpdated,
): Promise<void> {
  try {
    await raiseAlert(
      scope.db,
      {
        key: `checkin.checked_in_twice:${stay.id}`,
        category: 'checkin.checked_in_twice',
        severity: 'critical',
        subject: `Check-in for ${stay.childName}`,
        summary:
          `${stay.childName} was checked in offline on ${scope.auth.name} (${scope.auth.slot}) at ${payload.at}, ` +
          `but the platform already has them ${stay.status === 'in_park' ? 'in the park' : 'collected'}. ` +
          'The box’s check-in and its band were not applied — check which band the child is wearing.',
        detail: {
          checkinId: stay.id,
          first: { status: stay.status, bandId: stay.bandId, saleId: stay.saleId, checkedInAt: stay.checkedInAt?.toISOString() ?? null },
          second: { boxId: scope.auth.boxId, bandId: payload.band?.id ?? null, saleId: payload.saleId ?? null, eventId: event.envelope.eventId },
        },
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
      },
      { flapWindowSeconds: 0 },
    );
  } catch (err) {
    scope.log?.error({ err, checkinId: stay.id }, 'a second check-in could not be alerted; its quarantine row names it');
  }
}

// --- supervision_waiver.created -----------------------------------------------------------

async function applyWaiver(tx: Tx, scope: BatchScope, event: PreparedEvent, payload: OfflineWaiverCreated) {
  const [held] = await tx.select({ id: supervisionWaiver.id }).from(supervisionWaiver).where(eq(supervisionWaiver.id, payload.waiverId)).limit(1);
  if (held) return { entityType: 'supervision_waiver', entityId: held.id };
  const actor = actorOf(event);
  if (!actor) throw poison('SYNC_WAIVER_NO_STAFF', 'A waiver is accepted by a member of staff (OD-C3)');
  let registrationId: string | null = null;
  if (payload.registrationId) {
    const [r] = await tx
      .select({ id: registration.id })
      .from(registration)
      .where(and(eq(registration.id, payload.registrationId), eq(registration.operatorId, scope.auth.operatorId)))
      .limit(1);
    registrationId = r?.id ?? null;
  }
  await tx.insert(supervisionWaiver).values({
    id: payload.waiverId,
    operatorId: scope.auth.operatorId,
    branchId: scope.auth.branchId,
    registrationId,
    childId: null,
    childName: payload.child.name.trim(),
    childAgeYears: payload.child.ageYears,
    waivedRequirement: payload.waivedRequirement,
    siblingChildId: null,
    siblingName: payload.sibling.name.trim(),
    siblingAgeYears: payload.sibling.ageYears,
    acceptedByAccountId: actor,
    stationId: stationOf(scope, event),
    createdAt: event.occurredAt,
  });
  await audit.record(tx, {
    ...auditBase(scope, event),
    action: 'supervision_waiver.create',
    entityType: 'supervision_waiver',
    entityId: payload.waiverId,
    after: {
      childName: payload.child.name.trim(),
      childAgeYears: payload.child.ageYears,
      waivedRequirement: payload.waivedRequirement,
      siblingName: payload.sibling.name.trim(),
      siblingAgeYears: payload.sibling.ageYears,
      acceptedByAccountId: actor,
      ...trail(scope, event, payload),
    },
  });
  return { entityType: 'supervision_waiver', entityId: payload.waiverId };
}

// --- guardian.created ----------------------------------------------------------------

async function registrationOf(tx: Tx, scope: BatchScope, registrationId: string) {
  const [reg] = await tx
    .select()
    .from(registration)
    .where(and(eq(registration.id, registrationId), eq(registration.operatorId, scope.auth.operatorId)))
    .limit(1);
  if (!reg) throw retry('SYNC_REGISTRATION_UNKNOWN', 'That registration is not on the platform yet');
  if (reg.branchId !== scope.auth.branchId) throw poison('SYNC_REGISTRATION_NOT_OURS', 'That registration is at another park');
  return reg;
}

async function applyGuardian(tx: Tx, scope: BatchScope, event: PreparedEvent, payload: OfflineGuardianCreated) {
  const reg = await registrationOf(tx, scope, payload.registrationId);
  const [held] = await tx.select().from(guardian).where(eq(guardian.id, payload.guardianId)).limit(1);
  if (held) {
    if (held.registrationId !== reg.id) throw conflict('SYNC_GUARDIAN_ID_TAKEN', 'That id already names someone on another pickup list');
    return { entityType: 'guardian', entityId: held.id };
  }
  let phone: string | null = null;
  if (payload.phone?.trim()) {
    phone = normalizePhone(payload.phone);
    if (!phone) throw poison('SYNC_PHONE_INVALID', 'The collector’s phone number is not usable');
  }
  await tx.insert(guardian).values({
    id: payload.guardianId,
    operatorId: scope.auth.operatorId,
    registrationId: reg.id,
    name: payload.name.trim(),
    relationship: payload.relationship?.trim() || null,
    phone,
    photoFileId: null,
    source: payload.source,
    addedByAccountId: actorOf(event),
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  });
  await audit.record(tx, {
    ...auditBase(scope, event),
    action: 'guardian.create',
    entityType: 'guardian',
    entityId: payload.guardianId,
    after: {
      registrationId: reg.id,
      name: payload.name.trim(),
      relationship: payload.relationship?.trim() || null,
      phone,
      photoFileId: null,
      photoPendingUpload: !!payload.photoId,
      source: payload.source,
      ...trail(scope, event, payload),
    },
  });
  return { entityType: 'guardian', entityId: payload.guardianId };
}

// --- release.created: and the one conflict that is quarantined -------------------------------

/**
 * A RELEASE ALREADY ON THE PLATFORM for this child — at a counter online, or
 * at another box — and this box released them too. Two adults walked out with
 * one child's record, or one walked out twice: either way a person decides,
 * so the box's release is held in quarantine (`conflict`) and a CRITICAL alert
 * names both, raised on the pool so it outlives the savepoint the refusal
 * rolls back (the booking double's reasoning, `refuseSecondRedemption`).
 */
async function refuseSecondRelease(
  scope: BatchScope,
  event: PreparedEvent,
  stay: StayRow,
  first: typeof release.$inferSelect,
  payload: OfflineReleaseCreated,
): Promise<never> {
  const boxName = `${scope.auth.name} (${scope.auth.slot})`;
  const firstWhere = first.offline ? (first.stationId ? 'at another counter offline' : 'offline') : 'at a counter online';
  try {
    await raiseAlert(
      scope.db,
      {
        key: `checkin.released_twice:${stay.id}`,
        category: 'checkin.released_twice',
        severity: 'critical',
        subject: `Release of ${stay.childName}`,
        summary:
          `${stay.childName} was released twice: first ${firstWhere} to ${first.collectorName} at ${first.createdAt.toISOString()}, ` +
          `then offline on ${boxName} to ${payload.collectorName} at ${payload.releasedAt}. ` +
          'The second was not applied — it is held in quarantine for a person to look at. Call the family.',
        detail: {
          checkinId: stay.id,
          registrationId: stay.registrationId,
          first: {
            releaseId: first.id,
            collectorName: first.collectorName,
            guardianId: first.guardianId,
            stationId: first.stationId,
            at: first.createdAt.toISOString(),
            offline: first.offline,
          },
          second: {
            releaseId: payload.releaseId,
            collectorName: payload.collectorName,
            guardianId: payload.collector.kind === 'guardian' ? payload.collector.guardianId : null,
            boxId: scope.auth.boxId,
            stationId: event.envelope.stationId ?? null,
            actorAccountId: event.envelope.actorAccountId ?? null,
            at: payload.releasedAt,
            eventId: event.envelope.eventId,
          },
        },
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
      },
      { flapWindowSeconds: 0 },
    );
  } catch (err) {
    scope.log?.error({ err, checkinId: stay.id }, 'a second release could not be alerted; its quarantine row names it');
  }
  throw conflict(
    'SYNC_RELEASE_CONFLICT',
    `${stay.childName} was already released ${firstWhere} to ${first.collectorName}; this box's release was not applied`,
    { checkinId: stay.id, firstReleaseId: first.id },
  );
}

async function applyRelease(tx: Tx, scope: BatchScope, event: PreparedEvent, payload: OfflineReleaseCreated) {
  const stay = await lockedStay(tx, scope, payload.checkinId);
  const [byId] = await tx.select().from(release).where(eq(release.id, payload.releaseId)).limit(1);
  if (byId) {
    if (byId.checkinId !== stay.id) throw conflict('SYNC_RELEASE_ID_TAKEN', 'That release id already names another child’s release');
    return { entityType: 'release', entityId: byId.id };
  }
  const [first] = await tx.select().from(release).where(eq(release.checkinId, stay.id)).limit(1);
  if (first) return refuseSecondRelease(scope, event, stay, first, payload);
  if (stay.status === 'registered') {
    // The check-in this box saw has not reached the platform yet.
    throw retry('SYNC_RELEASE_NOT_IN_PARK', `${stay.childName} is not checked in on the platform yet`);
  }
  if (stay.status === 'out') {
    throw conflict('SYNC_RELEASE_ALREADY_OUT', `${stay.childName} has already left the park on the platform`);
  }
  const reg = await registrationOf(tx, scope, stay.registrationId);
  const actor = actorOf(event);
  if (!actor) throw poison('SYNC_RELEASE_NO_VERIFIER', 'A release names the member of staff who verified the collector');

  let guardianId: string | null = null;
  let collectorSource = 'dropper_off';
  if (payload.collector.kind === 'guardian') {
    const [g] = await tx.select().from(guardian).where(eq(guardian.id, payload.collector.guardianId)).limit(1);
    if (!g) throw retry('SYNC_RELEASE_COLLECTOR_UNKNOWN', 'The collector on this release is not on the platform’s list yet');
    if (g.registrationId !== reg.id) throw poison('SYNC_RELEASE_COLLECTOR_NOT_LISTED', 'The collector is on another family’s list');
    guardianId = g.id;
    collectorSource = g.source;
  }
  const config = await supervisionConfigOf(tx, stay.branchId);
  const unused = payload.prepaid?.unusedSatang ?? 0;
  const policy = payload.prepaid?.policy ?? config.pricing.prepaidFoodUnused;
  // Refunds are online only: a refund-policy release taken offline is refunded
  // by hand — the platform's `refund_no_sale`, with a warning for a manager.
  const refundNoSale = unused > 0 && policy === 'refund';
  const releasedAt = new Date(payload.releasedAt);
  await tx.insert(release).values({
    id: payload.releaseId,
    operatorId: scope.auth.operatorId,
    branchId: stay.branchId,
    checkinId: stay.id,
    guardianId,
    collectorName: payload.collectorName.trim(),
    verifiedByAccountId: actor,
    pickupPhotoFileId: null,
    offline: true,
    photoPendingUpload: !!payload.pickupPhotoId,
    prepaidPolicy: unused > 0 ? policy : null,
    prepaidUnusedSatang: unused,
    refundId: null,
    refundNoSale,
    stationId: stationOf(scope, event),
    createdAt: releasedAt,
    updatedAt: event.occurredAt,
  });
  await tx
    .update(checkin)
    .set({ status: 'out', checkedOutAt: releasedAt, checkedOutByAccountId: actor, updatedAt: event.occurredAt })
    .where(eq(checkin.id, stay.id));
  const stillHere = await tx
    .select({ id: checkin.id })
    .from(checkin)
    .where(and(eq(checkin.registrationId, reg.id), ne(checkin.status, 'out')))
    .limit(1);
  let retentionUntil: Date | null = null;
  if (stillHere.length === 0) {
    retentionUntil = new Date(releasedAt.getTime() + config.photoRetentionDays * 86_400_000);
    await tx.update(registration).set({ retentionUntil, updatedAt: event.occurredAt }).where(eq(registration.id, reg.id));
  }
  const base = auditBase(scope, event);
  const extra = trail(scope, event, payload);
  await audit.record(tx, {
    ...base,
    action: 'checkin.update',
    entityType: 'checkin',
    entityId: stay.id,
    before: { status: stay.status, nannyId: stay.nannyId },
    after: { status: 'out', checkedOutAt: releasedAt.toISOString(), releaseId: payload.releaseId, event: 'release', ...extra },
  });
  await audit.record(tx, {
    ...base,
    action: 'release.create',
    entityType: 'release',
    entityId: payload.releaseId,
    after: {
      checkinId: stay.id,
      registrationId: reg.id,
      childName: stay.childName,
      guardianId,
      collectorName: payload.collectorName.trim(),
      collectorSource,
      verifiedByAccountId: actor,
      pickupPhotoFileId: null,
      photoPendingUpload: !!payload.pickupPhotoId,
      nannyFreed: stay.nannyId,
      prepaid: unused > 0 ? { policy, unusedSatang: unused, refundId: null, refundedSatang: 0, refundNoSale, refundFailure: refundNoSale ? 'OFFLINE_RELEASE' : null } : null,
      retentionUntil: retentionUntil?.toISOString() ?? null,
      ...extra,
    },
  });
  if (refundNoSale) {
    try {
      await raiseAlert(
        scope.db,
        {
          key: `checkin.refund_by_hand:${payload.releaseId}`,
          category: 'checkin.refund_by_hand',
          severity: 'warning',
          subject: `Prepaid food for ${stay.childName}`,
          summary: `${stay.childName} was collected while the counter was offline with ฿${(unused / 100).toFixed(2)} of prepaid food unused. Refund it to the family by hand.`,
          detail: { releaseId: payload.releaseId, checkinId: stay.id, unusedSatang: unused, saleId: stay.saleId },
          operatorId: scope.auth.operatorId,
          branchId: scope.auth.branchId,
        },
        { flapWindowSeconds: 0 },
      );
    } catch (err) {
      scope.log?.error({ err, releaseId: payload.releaseId }, 'a by-hand refund could not be alerted; the release names it');
    }
  }
  return { entityType: 'release', entityId: payload.releaseId };
}

// --- The handlers, registered by `sync.ts` ------------------------------------------------

export const CHECKIN_HANDLERS: Record<string, EventHandler> = {
  [CHECKIN_FACTS.created]: {
    schema: OfflineCheckinCreatedSchema,
    apply: (tx, scope, event, payload: OfflineCheckinCreated) => applyCheckinCreated(tx, scope, event, payload),
  },
  [CHECKIN_FACTS.updated]: {
    schema: OfflineCheckinUpdatedSchema,
    apply: (tx, scope, event, payload: OfflineCheckinUpdated) => applyCheckinUpdated(tx, scope, event, payload),
  },
  [CHECKIN_FACTS.waiver]: {
    schema: OfflineWaiverCreatedSchema,
    apply: (tx, scope, event, payload: OfflineWaiverCreated) => applyWaiver(tx, scope, event, payload),
  },
  [CHECKIN_FACTS.guardian]: {
    schema: OfflineGuardianCreatedSchema,
    apply: (tx, scope, event, payload: OfflineGuardianCreated) => applyGuardian(tx, scope, event, payload),
  },
  [CHECKIN_FACTS.release]: {
    schema: OfflineReleaseCreatedSchema,
    apply: (tx, scope, event, payload: OfflineReleaseCreated) => applyRelease(tx, scope, event, payload),
  },
};

// --- The `checkin` cache scope ------------------------------------------------------------

/**
 * THE BOARD A COUNTER WORKS FROM WITH THE LINK DOWN: the families in the park
 * or awaiting check-in and today's collected (`boardOf`, the board's own
 * choice), each with its pickup list; today's releases; the supervision
 * config the gate resolves from; the nanny roster with the shifts that answer
 * "on shift" offline. One item, applied whole, with a version of its own.
 *
 * What it carries that is personal — names, phones, allergies, the people
 * allowed to collect — is exactly what a counter must read to hand a child to
 * the right adult with no internet, under the bundle's doctrine for members
 * (`cacheBundle`). Photos are never in it: a box holds file ids, not images.
 */
export async function checkinCacheItem(db: Db, operatorId: string, branchId: string, now: Date = new Date()): Promise<CheckinCacheItem> {
  const board = await boardOf(db, operatorId, branchId, now);
  const config = await supervisionConfigOf(db, branchId);
  const regIds = board.families.map((f) => f.registrationId);
  const stayIds = board.families.flatMap((f) => f.children.map((c) => c.id));
  const guardians = regIds.length
    ? await db.select().from(guardian).where(inArray(guardian.registrationId, regIds)).orderBy(asc(guardian.createdAt), asc(guardian.id))
    : [];
  const releases = stayIds.length ? await db.select().from(release).where(inArray(release.checkinId, stayIds)) : [];
  const nannies = await db
    .select({ id: nanny.id, name: nanny.name })
    .from(nanny)
    .where(and(eq(nanny.branchId, branchId), isNull(nanny.archivedAt)))
    .orderBy(asc(nanny.name));
  const shifts = nannies.length
    ? await db
        .select({ nannyId: nannyShift.nannyId, startsAt: nannyShift.startsAt, endsAt: nannyShift.endsAt })
        .from(nannyShift)
        .where(
          and(
            inArray(nannyShift.nannyId, nannies.map((n) => n.id)),
            eq(nannyShift.branchId, branchId),
            gt(nannyShift.endsAt, new Date(now.getTime() - 86_400_000)),
            lt(nannyShift.startsAt, new Date(now.getTime() + 2 * 86_400_000)),
          ),
        )
        .orderBy(asc(nannyShift.startsAt))
    : [];
  const byReg = new Map<string, BridgeGuardian[]>();
  for (const g of guardians) {
    byReg.set(g.registrationId, [
      ...(byReg.get(g.registrationId) ?? []),
      {
        id: g.id,
        registrationId: g.registrationId,
        name: g.name,
        relationship: g.relationship,
        phone: g.phone,
        photoFileId: g.photoFileId,
        source: g.source,
        revoked: !!g.revokedAt,
        createdAt: g.createdAt.toISOString(),
      },
    ]);
  }
  const stayOf = new Map(board.families.flatMap((f) => f.children.map((c) => [c.id, { c, f }] as const)));
  const families: Array<Omit<BridgeCheckinFamily, 'origin'>> = board.families.map((f) => ({
    ...f,
    tab: f.tab,
    children: f.children,
    guardians: byReg.get(f.registrationId) ?? [],
  }));
  const releaseRecords: BridgeReleaseRecord[] = releases.map((r) => ({
    id: r.id,
    checkinId: r.checkinId,
    registrationId: stayOf.get(r.checkinId)?.f.registrationId ?? '',
    guardianId: r.guardianId,
    collectorName: r.collectorName,
    verifiedByAccountId: r.verifiedByAccountId,
    pickupPhotoFileId: r.pickupPhotoFileId,
    photoPendingUpload: r.photoPendingUpload,
    stationId: r.stationId,
    checkedOutAt: (stayOf.get(r.checkinId)?.c.checkedOutAt ?? r.createdAt.toISOString()) as string,
    prepaid: r.prepaidPolicy && r.prepaidUnusedSatang > 0 ? { policy: r.prepaidPolicy, unusedSatang: r.prepaidUnusedSatang } : null,
  }));
  const body = {
    branchId,
    config: { policy: config.policy, pricing: config.pricing, photoRetentionDays: config.photoRetentionDays },
    nannies: nannies.map((n) => ({
      id: n.id,
      name: n.name,
      shifts: shifts
        .filter((s) => s.nannyId === n.id)
        .map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })),
    })),
    families,
    releases: releaseRecords,
  };
  const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { version, generatedAt: now.toISOString(), ...body };
}

// --- Photos taken offline: upload once, link once ---------------------------------------------

export const BoxPhotoBodySchema = z.object({
  target: z.object({ kind: z.enum(PHOTO_TARGETS), id: z.string().uuid() }),
  contentType: z.string().min(6).max(80).optional(),
  size: z.number().int().min(1).max(5_000_000).optional(),
});
export type BoxPhotoBody = z.infer<typeof BoxPhotoBodySchema>;

const notReady = (): AppError =>
  new AppError(409, 'PHOTO_TARGET_NOT_READY', 'The row this photo belongs to is not on the platform yet — the box tries again later');

/** The row a photo is for, inside the box's own operator and park; null when it has not arrived. */
async function photoRow(
  db: Db | Tx,
  auth: BoxAuth,
  target: { kind: PhotoTarget; id: string },
  lock = false,
): Promise<{ photoFileId: string | null; pending: boolean } | null> {
  if (target.kind === 'release') {
    const q = db
      .select({ photo: release.pickupPhotoFileId, pending: release.photoPendingUpload, operatorId: release.operatorId, branchId: release.branchId })
      .from(release)
      .where(eq(release.id, target.id));
    const [row] = lock ? await q.for('update').limit(1) : await q.limit(1);
    if (!row || row.operatorId !== auth.operatorId || row.branchId !== auth.branchId) return null;
    return { photoFileId: row.photo, pending: row.pending };
  }
  if (target.kind === 'registration') {
    const q = db
      .select({ photo: registration.photoFileId, operatorId: registration.operatorId, branchId: registration.branchId })
      .from(registration)
      .where(eq(registration.id, target.id));
    const [row] = lock ? await q.for('update').limit(1) : await q.limit(1);
    if (!row || row.operatorId !== auth.operatorId || row.branchId !== auth.branchId) return null;
    return { photoFileId: row.photo, pending: !row.photo };
  }
  const q = db
    .select({ photo: guardian.photoFileId, operatorId: guardian.operatorId, registrationId: guardian.registrationId })
    .from(guardian)
    .where(eq(guardian.id, target.id));
  const [row] = lock ? await q.for('update').limit(1) : await q.limit(1);
  if (!row || row.operatorId !== auth.operatorId) return null;
  const [reg] = await db.select({ branchId: registration.branchId }).from(registration).where(eq(registration.id, row.registrationId)).limit(1);
  if (!reg || reg.branchId !== auth.branchId) return null;
  return { photoFileId: row.photo, pending: !row.photo };
}

/**
 * Step 1 of the upload worker: a presigned PUT for a photo this box took
 * offline. The photo's id IS the `file_object` id, so asking again is a fresh
 * URL for the same object — never a second file. A row already linked to it
 * answers `linked: true` and no URL: there is nothing to send.
 */
export async function presignBoxPhoto(
  db: Db,
  storage: FileStorage | null,
  auth: BoxAuth,
  photoId: string,
  body: BoxPhotoBody,
  ctx: OpContext,
): Promise<{ uploadUrl: string | null; linked: boolean }> {
  if (!storage) throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured');
  const contentType = body.contentType ?? 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new AppError(400, 'PHOTO_NOT_AN_IMAGE', 'Only photos are kept for check-in — never a document');
  }
  const row = await photoRow(db, auth, body.target);
  if (!row) throw notReady();
  if (row.photoFileId === photoId) return { uploadUrl: null, linked: true };
  const [held] = await db.select().from(fileObject).where(eq(fileObject.id, photoId)).limit(1);
  if (held) {
    if (held.operatorId !== auth.operatorId || held.ownerEntityType !== body.target.kind || held.ownerEntityId !== body.target.id) {
      throw new AppError(409, 'ID_IN_USE', 'That photo id already names another file');
    }
    return { uploadUrl: await storage.presignedPut(held.objectKey), linked: false };
  }
  const objectKey = `${auth.operatorId}/${body.target.kind}/${body.target.id}/${photoId}.jpg`;
  const uploadUrl = await storage.presignedPut(objectKey);
  await db.transaction(async (tx) => {
    await tx.insert(fileObject).values({
      id: photoId,
      operatorId: auth.operatorId,
      bucket: storage.bucket,
      objectKey,
      contentType,
      ownerEntityType: body.target.kind,
      ownerEntityId: body.target.id,
      uploadedByAccountId: null,
    });
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: auth.operatorId,
      branchId: auth.branchId,
      action: 'file.create',
      entityType: 'file_object',
      entityId: photoId,
      after: { objectKey, ownerEntityType: body.target.kind, ownerEntityId: body.target.id, boxId: auth.boxId, offline: true },
      requestId: ctx.requestId,
    });
  });
  return { uploadUrl, linked: false };
}

/**
 * Step 3: link the uploaded photo to its row, EXACTLY ONCE. The same photo
 * again is a replay that writes nothing; another photo on that row is refused
 * (`PHOTO_TARGET_TAKEN`) and the first stands. A release's
 * `photo_pending_upload` clears here, in the same transaction as its audit
 * row.
 */
export async function linkBoxPhoto(
  db: Db,
  auth: BoxAuth,
  photoId: string,
  body: BoxPhotoBody,
  ctx: OpContext,
): Promise<{ linked: boolean; replay: boolean }> {
  return db.transaction(async (tx) => {
    const [file] = await tx.select().from(fileObject).where(eq(fileObject.id, photoId)).limit(1);
    if (!file || file.operatorId !== auth.operatorId || file.ownerEntityType !== body.target.kind || file.ownerEntityId !== body.target.id) {
      throw new AppError(409, 'PHOTO_NOT_REGISTERED', 'That photo has not been registered for this row — ask for an upload URL first');
    }
    const row = await photoRow(tx, auth, body.target, true);
    if (!row) throw notReady();
    if (row.photoFileId === photoId) return { linked: true, replay: true };
    if (row.photoFileId) {
      throw new AppError(409, 'PHOTO_TARGET_TAKEN', 'That row already has its photo; the first one stands', {
        photoFileId: row.photoFileId,
      });
    }
    const now = new Date();
    if (body.target.kind === 'release') {
      await tx
        .update(release)
        .set({ pickupPhotoFileId: photoId, photoPendingUpload: false, updatedAt: now })
        .where(eq(release.id, body.target.id));
    } else if (body.target.kind === 'registration') {
      await tx.update(registration).set({ photoFileId: photoId, updatedAt: now }).where(eq(registration.id, body.target.id));
      await tx
        .update(checkin)
        .set({ photoFileId: photoId, updatedAt: now })
        .where(and(eq(checkin.registrationId, body.target.id), isNull(checkin.photoFileId)));
    } else {
      await tx.update(guardian).set({ photoFileId: photoId, updatedAt: now }).where(eq(guardian.id, body.target.id));
    }
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: auth.operatorId,
      branchId: auth.branchId,
      action: `${body.target.kind}.photo_linked`,
      entityType: body.target.kind,
      entityId: body.target.id,
      before: { photoFileId: null, photoPendingUpload: true },
      after: { photoFileId: photoId, photoPendingUpload: false, boxId: auth.boxId, offline: true },
      requestId: ctx.requestId,
    });
    return { linked: true, replay: false };
  });
}
