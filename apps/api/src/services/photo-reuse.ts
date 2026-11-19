import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { checkin, child, fileObject, member, registration } from '@oto/db';
import type { LastChildPhoto, ReuseRegistrationPhotoInput } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { getRegistration, type Actor, type RegistrationView } from './checkin';
import type { Exec, Tx } from './tx';

type RegistrationRow = typeof registration.$inferSelect;

/**
 * SCRUM-1018 — A RETURNING CHILD'S LAST PHOTO, AND ITS REUSE ON STAFF'S WORD.
 *
 * The owner's answer of 19 November: a returning family is asked only the
 * three agreement ticks, and the photo of child and guardian (what staff
 * compare at pickup) may be the last visit's when staff confirm it still
 * matches. A stay never goes without a photo: the till shows staff this one
 * with "Still matches" or "Take a new one", and a child with no earlier
 * photo has one taken as before.
 *
 * WHICH PHOTO. The newest stay of THIS child (by its saved record) at this
 * park that holds a photo and was not cancelled. Never another child's:
 * the stay is found by the child's own id, and the reuse below checks the
 * new stay is the same child. At this park only, so the photo is read
 * through the same `pos:checkin:read` check at the same park as every
 * stay photo is (`GET /files/:id/url`, access-logged). And only while the
 * photo is still kept: the registration that owns the stored file has not
 * passed its retention date (OD-C2: kept until `retention_until`), so a
 * reuse never keeps a photo longer than the park's retention rule says.
 */
export async function lastChildPhoto(
  db: Exec,
  operatorId: string,
  branchId: string,
  childId: string,
  now: Date = new Date(),
): Promise<LastChildPhoto> {
  const [owned] = await db
    .select({ id: child.id })
    .from(child)
    .innerJoin(member, eq(member.id, child.memberId))
    .where(and(eq(child.id, childId), eq(member.operatorId, operatorId)))
    .limit(1);
  if (!owned) throw errors.notFound('No such child');
  const [row] = await db
    .select({
      checkinId: checkin.id,
      registrationId: checkin.registrationId,
      fileId: checkin.photoFileId,
      takenAt: checkin.createdAt,
    })
    .from(checkin)
    .innerJoin(fileObject, eq(fileObject.id, checkin.photoFileId))
    .innerJoin(registration, eq(registration.id, fileObject.ownerEntityId))
    .where(
      and(
        eq(checkin.childId, childId),
        eq(checkin.operatorId, operatorId),
        eq(checkin.branchId, branchId),
        ne(checkin.status, 'cancelled'),
        isNotNull(checkin.photoFileId),
        eq(fileObject.operatorId, operatorId),
        eq(fileObject.ownerEntityType, 'registration'),
        eq(registration.operatorId, operatorId),
        or(isNull(registration.retentionUntil), gt(registration.retentionUntil, now)),
      ),
    )
    .orderBy(desc(checkin.createdAt), desc(checkin.id))
    .limit(1);
  if (!row?.fileId) return { photo: null };
  return {
    photo: {
      checkinId: row.checkinId,
      registrationId: row.registrationId,
      fileId: row.fileId,
      takenAt: row.takenAt.toISOString(),
    },
  };
}

/**
 * Staff confirmed the last photo still matches: each named child's new stay
 * on this registration points at the photo of that same child's earlier
 * stay (the one `lastChildPhoto` offered, or any earlier stay of the same
 * child at this park whose photo is still kept). Refused, in plain words,
 * when the earlier stay is another child's, another park's, has no photo,
 * or its photo has passed the retention date: the counter then takes a new
 * photo. A child whose stay already holds a photo keeps it (as attaching a
 * new photo does), so pressing twice changes nothing the second time. The
 * registration's own photo, when it has none yet, becomes this one, as a
 * newly attached photo does. One audit row on the registration names who
 * confirmed and which stay each photo came from.
 */
export async function reuseRegistrationPhoto(
  tx: Tx,
  actor: Actor,
  reg: RegistrationRow,
  input: ReuseRegistrationPhotoInput,
  now: Date = new Date(),
): Promise<RegistrationView> {
  const targetIds = input.children.map((item) => item.checkinId);
  const targets = await tx
    .select()
    .from(checkin)
    .where(and(inArray(checkin.id, targetIds), eq(checkin.registrationId, reg.id)));
  if (targets.length !== targetIds.length) throw errors.notFound('One or more children are not on this registration');
  const sources = await tx
    .select({
      id: checkin.id,
      childId: checkin.childId,
      branchId: checkin.branchId,
      status: checkin.status,
      photoFileId: checkin.photoFileId,
      ownerType: fileObject.ownerEntityType,
      contentType: fileObject.contentType,
      retentionUntil: registration.retentionUntil,
    })
    .from(checkin)
    .innerJoin(fileObject, eq(fileObject.id, checkin.photoFileId))
    .innerJoin(registration, eq(registration.id, fileObject.ownerEntityId))
    .where(
      and(
        inArray(checkin.id, input.children.map((item) => item.fromCheckinId)),
        eq(checkin.operatorId, actor.operatorId),
        eq(fileObject.operatorId, actor.operatorId),
        eq(registration.operatorId, actor.operatorId),
      ),
    );
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const before: { checkinId: string; photoFileId: string | null }[] = [];
  const after: { checkinId: string; photoFileId: string; reusedFromCheckinId: string }[] = [];
  for (const item of input.children) {
    const target = targets.find((t) => t.id === item.checkinId)!;
    const source = sourceById.get(item.fromCheckinId);
    const sameChild = !!target.childId && source?.childId === target.childId;
    const kept = !!source && (source.retentionUntil === null || source.retentionUntil > now);
    if (
      !source ||
      !sameChild ||
      source.id === target.id ||
      source.branchId !== reg.branchId ||
      source.status === 'cancelled' ||
      !source.photoFileId ||
      source.ownerType !== 'registration' ||
      !source.contentType.startsWith('image/') ||
      !kept
    ) {
      throw errors.badRequest(
        `The last photo of ${target.childName} cannot be used for this stay — take a new photo of the child with the guardian.`,
      );
    }
    if (target.photoFileId) continue;
    before.push({ checkinId: target.id, photoFileId: null });
    after.push({ checkinId: target.id, photoFileId: source.photoFileId, reusedFromCheckinId: source.id });
  }
  if (after.length === 0) return getRegistration(tx, actor.operatorId, reg.id);
  for (const item of after) {
    await tx
      .update(checkin)
      .set({ photoFileId: item.photoFileId, updatedAt: now })
      .where(and(eq(checkin.id, item.checkinId), isNull(checkin.photoFileId)));
  }
  const registrationPhoto = reg.photoFileId ?? after[0]!.photoFileId;
  if (!reg.photoFileId) {
    await tx
      .update(registration)
      .set({ photoFileId: registrationPhoto, updatedAt: now })
      .where(and(eq(registration.id, reg.id), isNull(registration.photoFileId)));
  }
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: reg.branchId,
    action: 'registration.photo_reused',
    entityType: 'registration',
    entityId: reg.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before: { photoFileId: reg.photoFileId, children: before },
    after: {
      photoFileId: registrationPhoto,
      children: after,
      // Staff's word that the stored photo still matches child and guardian.
      confirmation: 'still_matches',
      confirmedByAccountId: actor.accountId,
    },
  });
  return getRegistration(tx, actor.operatorId, reg.id);
}
