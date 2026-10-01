import { and, asc, eq, ne } from 'drizzle-orm';
import { checkin, fileObject, guardian, refund, registration, release, sale, station } from '@oto/db';
import {
  DROPPER_OFF_PICKUP_ID,
  RELEASE_REFUSALS,
  newId,
  normalizePhone,
  prepaidReconciliationOf,
  revokedCollectorRefusal,
  type AddGuardianInput,
  type CreateReleaseInput,
  type EditGuardianInput,
  type PickupSource,
  type PickupView,
  type PrepaidReconciliation,
  type PrepaidSettlementView,
  type ReleaseView,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { supervisionConfigOf } from './checkin';
import { accountNames } from './refund-slices';
import { refundSale, type RefundSaleResult } from './refunds';
import type { Exec, Tx } from './tx';

/**
 * S2-13 round 3 — PICKUPS AND RELEASE, online (plan docs/progress/plans/
 * checkin/PLAN.md §2.4).
 *
 * The prototype's mutators, ported one by one from `mockApi.ts`:
 *
 *   - `getAuthorizedPickups` (4552-4582) → `pickupsOf`: the dropper-off FIRST,
 *     always present and read-only, carrying the sign-up photo; then everyone
 *     added, oldest first;
 *   - `addGuardianToRegistration` (4589-4616) and `addPickupFromChatPhoto`
 *     (4646-4667) → `addGuardian`, with the chat promotion kept as it was (a
 *     name and the photo, source `from_chat`, photo required) and the on-the-
 *     spot addition requiring the name AND the photo (R-92);
 *   - `editGuardian` (4623-4638) → `editGuardian`, the same four fields;
 *   - a REVOKE the prototype did not have (R-91 asks for auditable change,
 *     never deletion): `revokeGuardian` sets `revoked_at`, nothing is deleted;
 *   - `checkOut` (5259-5339) → `releaseChild`, with R-92 enforced HERE rather
 *     than only by the modal: the collector is the dropper-off, a listed and
 *     unrevoked guardian, or someone added on the spot with their name and
 *     photo — anything else is refused; the live pickup photo is mandatory;
 *     the verifier is the signed-in account. The stay goes `out`, which is
 *     what frees the nanny (her load is derived from status, as the
 *     prototype's was). Unused prepaid food is settled by the branch's policy:
 *     refunded against the LINKED sale through the landed refund path, or
 *     recorded `refund_no_sale` when there is nothing to refund against.
 *
 * THE PHOTOS ride `core.file_object` through the landed presigned paths. A
 * photo is uploaded before the row it belongs to exists (a release is one
 * press), so it is uploaded under the REGISTRATION and re-owned to the
 * guardian or the release when that row is written — the owner type then says
 * what the photo is, and reading it stays behind `pos:checkin:read` at the
 * stay's park either way, access-logged (routes/files.ts, R-94).
 *
 * NEVER, under any flow, is a photo of an identity document taken (C9).
 */

type CheckinRow = typeof checkin.$inferSelect;
type RegistrationRow = typeof registration.$inferSelect;
type GuardianRow = typeof guardian.$inferSelect;
type ReleaseRow = typeof release.$inferSelect;

export interface ReleaseActor {
  accountId: string;
  operatorId: string;
  /** The till the release was pressed at (OD-C5), already checked to be at the stay's park. */
  stationId: string | null;
  requestId?: string;
  actionId?: string | null;
}

// --- Loaders (inside the caller's operator; 404 for anybody else's) ---------------

export async function loadRegistrationForPickups(db: Exec, operatorId: string, id: string): Promise<RegistrationRow> {
  const [row] = await db
    .select()
    .from(registration)
    .where(and(eq(registration.id, id), eq(registration.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('No such registration');
  return row;
}

export async function loadGuardianForPickups(
  db: Exec,
  operatorId: string,
  id: string,
): Promise<{ guardian: GuardianRow; registration: RegistrationRow }> {
  const [row] = await db
    .select({ g: guardian, r: registration })
    .from(guardian)
    .innerJoin(registration, eq(registration.id, guardian.registrationId))
    .where(and(eq(guardian.id, id), eq(guardian.operatorId, operatorId)))
    .limit(1);
  if (!row || row.r.operatorId !== operatorId) throw errors.notFound('No such person on a pickup list');
  return { guardian: row.g, registration: row.r };
}

export async function loadStayForRelease(db: Exec, operatorId: string, id: string): Promise<CheckinRow> {
  const [row] = await db
    .select()
    .from(checkin)
    .where(and(eq(checkin.id, id), eq(checkin.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('No such check-in');
  return row;
}

// --- The list ---------------------------------------------------------------------

function sourceOf(row: GuardianRow): PickupSource {
  return row.source;
}

function guardianViewOf(row: GuardianRow, nameOf: (id: string) => string | null): PickupView {
  return {
    id: row.id,
    registrationId: row.registrationId,
    name: row.name,
    phone: row.phone,
    relationship: row.relationship,
    photoFileId: row.photoFileId,
    isDropperOff: false,
    source: sourceOf(row),
    addedByName: row.addedByAccountId ? nameOf(row.addedByAccountId) : null,
    addedAt: row.createdAt.toISOString(),
  };
}

/**
 * The authorised-pickup list (prototype `getAuthorizedPickups`): the
 * dropper-off first — the registration's own guardian, with the sign-up photo
 * (the child and the guardian together, OD-C2) — then every unrevoked person
 * added, oldest first. A revoked person is not on the list (R-91).
 */
export async function pickupsOf(db: Exec, reg: RegistrationRow, signUpPhotoFileId?: string | null): Promise<PickupView[]> {
  const rows = await db
    .select()
    .from(guardian)
    .where(eq(guardian.registrationId, reg.id))
    .orderBy(asc(guardian.createdAt), asc(guardian.id));
  const listed = rows.filter((g) => !g.revokedAt);
  const nameOf = await accountNames(
    db,
    listed.flatMap((g) => (g.addedByAccountId ? [g.addedByAccountId] : [])),
  );
  return [
    {
      id: DROPPER_OFF_PICKUP_ID,
      registrationId: reg.id,
      name: reg.guardianName,
      phone: reg.guardianPhone,
      relationship: null,
      photoFileId: signUpPhotoFileId ?? reg.photoFileId,
      isDropperOff: true,
      source: 'dropper_off',
      addedByName: null,
      addedAt: reg.createdAt.toISOString(),
    },
    ...listed.map((g) => guardianViewOf(g, nameOf)),
  ];
}

// --- Photos -------------------------------------------------------------------------

/**
 * A photo the counter just uploaded, checked before it is attached: this
 * operator's, an image, and uploaded under this registration (or already
 * owned by the row it is being attached to). Anything else is "no such photo",
 * never a hint at whose it might be.
 *
 * A STORED sign-up photo stays owned by the registration for good
 * (`attachRegistrationPhoto` never re-owns it), so ownership alone does not
 * say "fresh from the camera". A registration-owned file that any row on the
 * registration already references — `registration.photo_file_id`, or a
 * sibling's `checkin.photo_file_id` — is the child-and-dropper-off sign-up
 * photo and can never stand in for a photo taken at the counter (R-92): not
 * as the live pickup photo, not as a collector's or a listed person's own
 * photo. Refused in the counter's words for the photo that was asked for.
 * Photos attached to a guardian or a release are re-owned on attach, so the
 * owner check above already stops those being reused.
 */
async function assertPhoto(
  tx: Tx,
  operatorId: string,
  fileId: string,
  owners: { registrationId: string; selfType?: 'guardian' | 'release'; selfId?: string },
  purpose: 'pickup' | 'collector',
): Promise<typeof fileObject.$inferSelect> {
  const [file] = await tx.select().from(fileObject).where(eq(fileObject.id, fileId)).limit(1);
  const ownedHere =
    !!file &&
    ((file.ownerEntityType === 'registration' && file.ownerEntityId === owners.registrationId) ||
      (!!owners.selfType && file.ownerEntityType === owners.selfType && file.ownerEntityId === owners.selfId));
  if (!file || file.operatorId !== operatorId || !ownedHere) {
    throw errors.notFound('No such photo on this registration — take the photo again.');
  }
  if (!file.contentType.startsWith('image/')) {
    throw errors.badRequest('That file is not a photo — take the photo again.');
  }
  if (file.ownerEntityType === 'registration' && (await isSignUpPhoto(tx, owners.registrationId, file.id))) {
    throw purpose === 'pickup'
      ? new AppError(400, 'PICKUP_PHOTO_REQUIRED', RELEASE_REFUSALS.PICKUP_PHOTO_REQUIRED)
      : new AppError(400, 'COLLECTOR_PHOTO_REQUIRED', RELEASE_REFUSALS.COLLECTOR_PHOTO_REQUIRED);
  }
  return file;
}

/** Is this file already a sign-up photo on the registration — its own, or any of its stays'? */
async function isSignUpPhoto(tx: Tx, registrationId: string, fileId: string): Promise<boolean> {
  const [reg] = await tx
    .select({ id: registration.id })
    .from(registration)
    .where(and(eq(registration.id, registrationId), eq(registration.photoFileId, fileId)))
    .limit(1);
  if (reg) return true;
  const [stay] = await tx
    .select({ id: checkin.id })
    .from(checkin)
    .where(and(eq(checkin.registrationId, registrationId), eq(checkin.photoFileId, fileId)))
    .limit(1);
  return !!stay;
}

/** The photo now belongs to the row it shows: its owner type says what it is. */
async function reown(tx: Tx, fileId: string, type: 'guardian' | 'release', id: string): Promise<void> {
  await tx.update(fileObject).set({ ownerEntityType: type, ownerEntityId: id }).where(eq(fileObject.id, fileId));
}

function phoneOf(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const e164 = normalizePhone(raw);
  if (!e164) throw errors.badRequest("That phone number doesn't look right — check it with the collector.");
  return e164;
}

// --- Adding, editing, revoking ----------------------------------------------------------

/**
 * Add someone to the list. The name always; the photo when they were added on
 * the spot (R-92: someone not on the list is released only with their photo)
 * or promoted from a chat photo (the prototype required the image); optional
 * when added in person from the sheet, as the prototype's sheet had it.
 */
export async function addGuardian(
  tx: Tx,
  actor: ReleaseActor,
  reg: RegistrationRow,
  input: AddGuardianInput & { id: string },
  now: Date = new Date(),
): Promise<PickupView> {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'COLLECTOR_NAME_REQUIRED', RELEASE_REFUSALS.COLLECTOR_NAME_REQUIRED);
  const source = input.source ?? 'in_person';
  if (!input.photoFileId && source === 'on_the_spot') {
    throw new AppError(400, 'COLLECTOR_PHOTO_REQUIRED', RELEASE_REFUSALS.COLLECTOR_PHOTO_REQUIRED);
  }
  if (!input.photoFileId && source === 'from_chat') {
    throw new AppError(400, 'CHAT_PHOTO_REQUIRED', 'Pick the chat photo to promote — a pickup from chat is added with that photo.');
  }
  if (input.photoFileId) {
    await assertPhoto(
      tx,
      actor.operatorId,
      input.photoFileId,
      { registrationId: reg.id, selfType: 'guardian', selfId: input.id },
      'collector',
    );
  }
  const [row] = await tx
    .insert(guardian)
    .values({
      id: input.id,
      operatorId: actor.operatorId,
      registrationId: reg.id,
      name,
      relationship: input.relationship?.trim() || null,
      phone: phoneOf(input.phone),
      photoFileId: input.photoFileId ?? null,
      source,
      addedByAccountId: actor.accountId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('the guardian was not written');
  if (input.photoFileId) await reown(tx, input.photoFileId, 'guardian', row.id);
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: reg.branchId,
    action: 'guardian.create',
    entityType: 'guardian',
    entityId: row.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    after: {
      registrationId: reg.id,
      name: row.name,
      relationship: row.relationship,
      phone: row.phone,
      photoFileId: row.photoFileId,
      source: row.source,
      stationId: actor.stationId,
    },
  });
  return guardianViewOf(row, await accountNames(tx, [actor.accountId]));
}

/** Edit a listed person: name, phone, relationship, photo (prototype `editGuardian`). */
export async function editGuardian(
  tx: Tx,
  actor: ReleaseActor,
  found: { guardian: GuardianRow; registration: RegistrationRow },
  input: EditGuardianInput,
  now: Date = new Date(),
): Promise<PickupView> {
  const g = found.guardian;
  if (g.revokedAt) {
    throw errors.conflict('GUARDIAN_REVOKED', `${g.name} was taken off the pickup list — add them again instead of editing.`);
  }
  const patch: Partial<typeof guardian.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new AppError(400, 'COLLECTOR_NAME_REQUIRED', RELEASE_REFUSALS.COLLECTOR_NAME_REQUIRED);
    patch.name = name;
  }
  if (input.relationship !== undefined) patch.relationship = input.relationship?.trim() || null;
  if (input.phone !== undefined) patch.phone = phoneOf(input.phone);
  if (input.photoFileId !== undefined) {
    if (input.photoFileId === null) {
      if (g.source === 'on_the_spot' || g.source === 'from_chat') {
        throw new AppError(400, 'COLLECTOR_PHOTO_REQUIRED', RELEASE_REFUSALS.COLLECTOR_PHOTO_REQUIRED);
      }
    } else {
      await assertPhoto(
        tx,
        actor.operatorId,
        input.photoFileId,
        { registrationId: found.registration.id, selfType: 'guardian', selfId: g.id },
        'collector',
      );
    }
    patch.photoFileId = input.photoFileId;
  }
  const changed = Object.keys(patch) as (keyof typeof patch)[];
  if (changed.length === 0) return guardianViewOf(g, await accountNames(tx, g.addedByAccountId ? [g.addedByAccountId] : []));
  const [after] = await tx
    .update(guardian)
    .set({ ...patch, updatedAt: now })
    .where(eq(guardian.id, g.id))
    .returning();
  if (!after) throw new Error('the guardian was not updated');
  if (input.photoFileId) await reown(tx, input.photoFileId, 'guardian', g.id);
  const before: Record<string, unknown> = {};
  const afterFields: Record<string, unknown> = {};
  for (const k of changed) {
    before[k] = g[k as keyof GuardianRow] ?? null;
    afterFields[k] = after[k as keyof GuardianRow] ?? null;
  }
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: found.registration.branchId,
    action: 'guardian.update',
    entityType: 'guardian',
    entityId: g.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before,
    after: { ...afterFields, stationId: actor.stationId },
  });
  return guardianViewOf(after, await accountNames(tx, after.addedByAccountId ? [after.addedByAccountId] : []));
}

/**
 * Take someone off the list (R-91): `revoked_at` and who did it, never a
 * delete. Revoking twice answers the first revocation.
 */
export async function revokeGuardian(
  tx: Tx,
  actor: ReleaseActor,
  found: { guardian: GuardianRow; registration: RegistrationRow },
  now: Date = new Date(),
): Promise<PickupView & { revokedAt: string }> {
  const g = found.guardian;
  const nameOf = await accountNames(tx, g.addedByAccountId ? [g.addedByAccountId] : []);
  if (g.revokedAt) return { ...guardianViewOf(g, nameOf), revokedAt: g.revokedAt.toISOString() };
  const [after] = await tx
    .update(guardian)
    .set({ revokedAt: now, revokedByAccountId: actor.accountId, updatedAt: now })
    .where(eq(guardian.id, g.id))
    .returning();
  if (!after) throw new Error('the guardian was not revoked');
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: found.registration.branchId,
    action: 'guardian.revoke',
    entityType: 'guardian',
    entityId: g.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before: { revokedAt: null },
    after: { revokedAt: now.toISOString(), revokedByAccountId: actor.accountId, name: g.name, stationId: actor.stationId },
  });
  return { ...guardianViewOf(after, nameOf), revokedAt: now.toISOString() };
}

// --- The release ----------------------------------------------------------------------

/**
 * What is left on the band of a prepaid-credit child. Spending against a
 * band's prepaid credit is not on the platform yet (the F&B redemption and
 * the wallet are later stories), so nothing has been recorded as spent and
 * the remaining credit is what was loaded. A prepaid-items child's
 * redemptions ride the stay's own snapshot (`redeemedQty`).
 */
function remainingCreditOf(stay: CheckinRow): number {
  const fp = stay.foodProvision;
  if (!fp || fp.mode !== 'prepaid_credit') return 0;
  return fp.creditSatang ?? fp.paidSatang;
}

export function reconciliationOf(stay: CheckinRow): PrepaidReconciliation | null {
  const fp = stay.foodProvision;
  if (!fp || fp.mode === 'none') return null;
  return prepaidReconciliationOf(fp, remainingCreditOf(stay));
}

export interface ReleaseContext {
  checkinId: string;
  registrationId: string;
  branchId: string;
  childName: string;
  childAgeYears: number;
  guardianName: string;
  status: CheckinRow['status'];
  /** The stored sign-up photo the live one is compared with, side by side. */
  signUpPhotoFileId: string | null;
  pickups: PickupView[];
  reconciliation: PrepaidReconciliation | null;
  prepaidPolicy: 'refund' | 'forfeit';
  /** Set once the child has been released. */
  release: ReleaseView | null;
}

/** Everything the release modal shows, from the platform. */
export async function releaseContextOf(db: Exec, stay: CheckinRow): Promise<ReleaseContext> {
  const [reg] = await db.select().from(registration).where(eq(registration.id, stay.registrationId)).limit(1);
  if (!reg) throw errors.notFound('No such registration');
  const config = await supervisionConfigOf(db, stay.branchId);
  const signUp = stay.photoFileId ?? reg.photoFileId;
  const [existing] = await db.select().from(release).where(eq(release.checkinId, stay.id)).limit(1);
  return {
    checkinId: stay.id,
    registrationId: reg.id,
    branchId: stay.branchId,
    childName: stay.childName,
    childAgeYears: stay.childAgeYears,
    guardianName: reg.guardianName,
    status: stay.status,
    signUpPhotoFileId: signUp,
    pickups: await pickupsOf(db, reg, signUp),
    reconciliation: reconciliationOf(stay),
    prepaidPolicy: config.pricing.prepaidFoodUnused,
    release: existing ? await releaseViewOf(db, existing) : null,
  };
}

export async function releaseViewOf(db: Exec, row: ReleaseRow): Promise<ReleaseView> {
  const [stay] = await db.select().from(checkin).where(eq(checkin.id, row.checkinId)).limit(1);
  let collectorSource: PickupSource = 'dropper_off';
  if (row.guardianId) {
    const [g] = await db.select({ source: guardian.source }).from(guardian).where(eq(guardian.id, row.guardianId)).limit(1);
    collectorSource = g?.source ?? 'in_person';
  }
  let refundedSatang = 0;
  if (row.refundId) {
    const [r] = await db.select({ amountSatang: refund.amountSatang }).from(refund).where(eq(refund.id, row.refundId)).limit(1);
    refundedSatang = r?.amountSatang ?? 0;
  }
  const nameOf = await accountNames(db, [row.verifiedByAccountId]);
  const settlement: PrepaidSettlementView | null =
    row.prepaidPolicy && row.prepaidUnusedSatang > 0
      ? {
          policy: row.prepaidPolicy,
          unusedSatang: row.prepaidUnusedSatang,
          refundId: row.refundId,
          refundedSatang,
          settlementError: row.refundNoSale ? 'refund_no_sale' : null,
        }
      : null;
  return {
    id: row.id,
    checkinId: row.checkinId,
    registrationId: stay?.registrationId ?? '',
    childName: stay?.childName ?? '',
    guardianId: row.guardianId,
    collectorName: row.collectorName,
    collectorSource,
    verifiedByAccountId: row.verifiedByAccountId,
    verifiedByName: nameOf(row.verifiedByAccountId),
    pickupPhotoFileId: row.pickupPhotoFileId,
    stationId: row.stationId,
    checkedOutAt: (stay?.checkedOutAt ?? row.createdAt).toISOString(),
    settlement,
  };
}

export interface ReleaseResult {
  replay: boolean;
  release: ReleaseView;
  /** The refund the prepaid settlement wrote, for the route to finish a gateway slice after the commit. */
  refund: RefundSaleResult | null;
}

/**
 * Release a child to the collector (prototype `checkOut`), ONE transaction:
 * R-92 checked, the on-the-spot collector added to the list, the prepaid food
 * settled, the release written with collector, verifier and photo, the stay
 * `out` (which frees the nanny), the registration's retention clock started
 * when its last child leaves, and the audit rows.
 */
export async function releaseChild(
  tx: Tx,
  actor: ReleaseActor,
  checkinId: string,
  input: CreateReleaseInput & { id: string },
  now: Date = new Date(),
): Promise<ReleaseResult> {
  // Locked: two counters releasing the same child get one release and one refusal.
  const [stay] = await tx
    .select()
    .from(checkin)
    .where(and(eq(checkin.id, checkinId), eq(checkin.operatorId, actor.operatorId)))
    .for('update')
    .limit(1);
  if (!stay) throw errors.notFound('No such check-in');

  const [already] = await tx.select().from(release).where(eq(release.checkinId, stay.id)).limit(1);
  if (already) {
    if (already.id === input.id) return { replay: true, release: await releaseViewOf(tx, already), refund: null };
    const view = await releaseViewOf(tx, already);
    throw errors.conflict(
      'ALREADY_RELEASED',
      `${stay.childName} was already collected by ${view.collectorName}.`,
      { releaseId: already.id },
    );
  }
  if (stay.status !== 'in_park') {
    throw errors.conflict(
      'CHECKIN_NOT_IN_PARK',
      stay.status === 'registered'
        ? `${stay.childName} has not been checked in yet — only a child in the park can be collected.`
        : `${stay.childName} has already left the park.`,
    );
  }
  const [reg] = await tx.select().from(registration).where(eq(registration.id, stay.registrationId)).limit(1);
  if (!reg) throw errors.notFound('No such registration');

  // --- R-92: who is collecting ------------------------------------------------------
  const collector = input.collector;
  let guardianId: string | null = null;
  let collectorName: string;
  let collectorSource: PickupSource;
  // The live pickup photo is checked before the collector is written, so a
  // refusal never leaves an on-the-spot person on the list.
  if (!input.pickupPhotoFileId) {
    throw new AppError(400, 'PICKUP_PHOTO_REQUIRED', RELEASE_REFUSALS.PICKUP_PHOTO_REQUIRED);
  }
  // The LIVE photo: the sign-up photo it is compared with can never stand in
  // for it — this stay's, the registration's, or a sibling's (assertPhoto
  // checks every stay on the registration).
  if (input.pickupPhotoFileId === reg.photoFileId || input.pickupPhotoFileId === stay.photoFileId) {
    throw new AppError(400, 'PICKUP_PHOTO_REQUIRED', RELEASE_REFUSALS.PICKUP_PHOTO_REQUIRED);
  }
  await assertPhoto(
    tx,
    actor.operatorId,
    input.pickupPhotoFileId,
    { registrationId: reg.id, selfType: 'release', selfId: input.id },
    'pickup',
  );

  if (collector.kind === 'dropper_off') {
    collectorName = reg.guardianName;
    collectorSource = 'dropper_off';
  } else if (collector.kind === 'guardian') {
    if (collector.guardianId === DROPPER_OFF_PICKUP_ID) {
      collectorName = reg.guardianName;
      collectorSource = 'dropper_off';
    } else {
      const [g] = /^[0-9a-f-]{36}$/i.test(collector.guardianId)
        ? await tx.select().from(guardian).where(eq(guardian.id, collector.guardianId)).limit(1)
        : [];
      if (!g || g.registrationId !== reg.id || g.operatorId !== actor.operatorId) {
        throw errors.conflict('COLLECTOR_NOT_LISTED', RELEASE_REFUSALS.COLLECTOR_NOT_LISTED);
      }
      if (g.revokedAt) throw errors.conflict('COLLECTOR_REVOKED', revokedCollectorRefusal(g.name));
      guardianId = g.id;
      collectorName = g.name;
      collectorSource = g.source;
    }
  } else {
    const name = collector.name?.trim() ?? '';
    if (!name) throw new AppError(400, 'COLLECTOR_NAME_REQUIRED', RELEASE_REFUSALS.COLLECTOR_NAME_REQUIRED);
    if (!collector.photoFileId) {
      throw new AppError(400, 'COLLECTOR_PHOTO_REQUIRED', RELEASE_REFUSALS.COLLECTOR_PHOTO_REQUIRED);
    }
    if (collector.photoFileId === input.pickupPhotoFileId) {
      // Two different photos: the person as they were added, and the handover.
      throw new AppError(400, 'COLLECTOR_PHOTO_REQUIRED', RELEASE_REFUSALS.COLLECTOR_PHOTO_REQUIRED);
    }
    const added = await addGuardian(
      tx,
      actor,
      reg,
      {
        id: collector.guardianId ?? newId(),
        name,
        relationship: collector.relationship ?? null,
        phone: collector.phone ?? null,
        photoFileId: collector.photoFileId,
        source: 'on_the_spot',
      },
      now,
    );
    guardianId = added.id;
    collectorName = added.name;
    collectorSource = 'on_the_spot';
  }

  // --- The prepaid food, by the branch's policy ---------------------------------------
  const config = await supervisionConfigOf(tx, stay.branchId);
  const reconciliation = reconciliationOf(stay);
  const unusedSatang = reconciliation?.totalUnusedSatang ?? 0;
  const policy = config.pricing.prepaidFoodUnused;
  let refundResult: RefundSaleResult | null = null;
  let refundNoSale = false;
  let refundFailure: string | null = null;
  if (unusedSatang > 0 && policy === 'refund') {
    const [linked] = stay.saleId
      ? await tx.select().from(sale).where(and(eq(sale.id, stay.saleId), eq(sale.operatorId, actor.operatorId))).limit(1)
      : [];
    if (!linked || linked.status !== 'finalised') {
      refundNoSale = true;
      refundFailure = linked ? `SALE_${linked.status.toUpperCase()}` : 'NO_LINKED_SALE';
    } else {
      try {
        // A savepoint: a refund that cannot be written never takes the
        // child's release back with it — the release stands, and staff refund
        // by hand (the prototype's `refund_no_sale` toast).
        refundResult = await tx.transaction((sp) =>
          refundSale(
            sp,
            {
              accountId: actor.accountId,
              operatorId: actor.operatorId,
              stationId: actor.stationId,
              requestId: actor.requestId,
              assertBranchAllowed: async (branchId) => {
                if (branchId !== stay.branchId) {
                  throw errors.conflict('CHECKIN_OTHER_PARK', 'The sale for this stay was taken at another park.');
                }
              },
              // The branch's seeded policy IS the approval: the prototype's
              // checkOut refunds unused prepaid food at pickup with no manager
              // (mockApi.ts:5293-5318), and the policy is a manager's setting.
              assertCanApprove: async () => undefined,
            },
            linked.id,
            { mode: 'custom', amountSatang: unusedSatang, reason: 'Unused prepaid food at pickup', note: null },
            now,
          ),
        );
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        refundNoSale = true;
        refundFailure = err.code;
      }
    }
  }

  // --- The release, the stay, the registration ------------------------------------------
  const [written] = await tx
    .insert(release)
    .values({
      id: input.id,
      operatorId: actor.operatorId,
      branchId: stay.branchId,
      checkinId: stay.id,
      guardianId,
      collectorName,
      verifiedByAccountId: actor.accountId,
      pickupPhotoFileId: input.pickupPhotoFileId,
      offline: false,
      photoPendingUpload: false,
      prepaidPolicy: unusedSatang > 0 ? policy : null,
      prepaidUnusedSatang: unusedSatang,
      refundId: refundResult?.refund.id ?? null,
      refundNoSale,
      stationId: actor.stationId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!written) throw new Error('the release was not written');
  await reown(tx, input.pickupPhotoFileId, 'release', written.id);

  await tx
    .update(checkin)
    .set({ status: 'out', checkedOutAt: now, checkedOutByAccountId: actor.accountId, updatedAt: now })
    .where(eq(checkin.id, stay.id));

  // The retention clock starts when the registration's last child leaves (OD-C2).
  const stillHere = await tx
    .select({ id: checkin.id })
    .from(checkin)
    .where(and(eq(checkin.registrationId, reg.id), ne(checkin.status, 'out')))
    .limit(1);
  let retentionUntil: Date | null = null;
  if (stillHere.length === 0) {
    retentionUntil = new Date(now.getTime() + config.photoRetentionDays * 86_400_000);
    await tx.update(registration).set({ retentionUntil, updatedAt: now }).where(eq(registration.id, reg.id));
  }

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: stay.branchId,
    action: 'checkin.update',
    entityType: 'checkin',
    entityId: stay.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before: { status: stay.status, nannyId: stay.nannyId },
    after: { status: 'out', checkedOutAt: now.toISOString(), releaseId: written.id, event: 'release' },
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: stay.branchId,
    action: 'release.create',
    entityType: 'release',
    entityId: written.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    after: {
      checkinId: stay.id,
      registrationId: reg.id,
      childName: stay.childName,
      guardianId,
      collectorName,
      collectorSource,
      verifiedByAccountId: actor.accountId,
      pickupPhotoFileId: input.pickupPhotoFileId,
      stationId: actor.stationId,
      boxId: null,
      offline: false,
      nannyFreed: stay.nannyId,
      prepaid:
        unusedSatang > 0
          ? {
              policy,
              unusedSatang,
              refundId: refundResult?.refund.id ?? null,
              refundedSatang: refundResult?.refund.amountSatang ?? 0,
              refundNoSale,
              refundFailure,
            }
          : null,
      retentionUntil: retentionUntil?.toISOString() ?? null,
    },
  });

  return { replay: false, release: await releaseViewOf(tx, written), refund: refundResult };
}

/** The station a release names, checked to be at the stay's park; otherwise none. */
export async function stationAtBranch(db: Exec, stationId: string | null | undefined, branchId: string): Promise<string | null> {
  if (!stationId) return null;
  const [row] = await db.select({ id: station.id, branchId: station.branchId }).from(station).where(eq(station.id, stationId)).limit(1);
  return row && row.branchId === branchId ? row.id : null;
}
