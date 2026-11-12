import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { fileObject, type Db } from '@oto/db';
import {
  ConsentDocumentPromptSchema, DISPLAY_CONSENT_PHOTO_MAX_BYTES,
  type DisplayConsentPhotoUpload,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { claimClientId } from './client-id';
import type { DisplayDeviceAuth } from './display';
import type { FileStorage } from './files';
import { managerForStation } from './station-session';
import { withTx, type OpContext } from './tx';

/**
 * SCRUM-857 — THE FAMILY TAKES THE CHILD'S PHOTO ON THE PAIRED DISPLAY.
 *
 * The owner's ruling of 8 November: on the drop-off and nanny form the family
 * takes the photo themselves, with a button, instead of reception. On the
 * till's own split screen the photo is already the family's (one React state);
 * on a separate paired display it has to travel, and it must never travel
 * anywhere but to THIS sale's form:
 *
 *   - **Written by the display's own credential**, never a staff cookie, and
 *     only to the station that credential is paired to — the station is read
 *     from the credential, never from the body.
 *   - **Only while that station's form asks for that photo**: the station's
 *     live document must be the drop-off/nanny form (step 7, input), for the
 *     same visitor, not finished, with that child marked `photo` by the till.
 *     Another sale's visitor, another child, a finished form or no form at all
 *     is refused before anything is stored. A station whose document lives on
 *     a counter box (not here) has no such form on the platform and is
 *     refused too; the display then falls back to "reception will take the
 *     photo", as it does through a box from before the mark.
 *   - **A photo, and a small one**: JPEG, PNG or WebP by its bytes, at most
 *     `DISPLAY_CONSENT_PHOTO_MAX_BYTES`, private in the photo bucket.
 *   - **Once**: the display mints the file id per picture; the same id again
 *     is the same file (nothing stored twice), and an id naming any other
 *     file is refused `ID_IN_USE`.
 *   - **Recorded**: the file row and its audit row commit together.
 *
 * The till then collects the picture (`readDisplayConsentPhoto`, the staff
 * session standing at that station) and keeps it exactly where a photo staff
 * take is kept: on the slot, uploaded to the registration when it is written.
 * Nothing here writes a consent, a registration or a child — the form is not
 * finished by a photo.
 */
export const DISPLAY_CONSENT_PHOTO_OWNER = 'display.consent_photo';

/** The form and child a picture belongs to, as one opaque key part (no raw ids in the object key). */
function formKey(visitorId: string, slotId: string): string {
  return createHash('sha256').update(`${visitorId}\n${slotId}`).digest('hex').slice(0, 40);
}

function objectPrefix(operatorId: string, stationId: string, visitorId: string, slotId: string): string {
  return `${operatorId}/${DISPLAY_CONSENT_PHOTO_OWNER}/${stationId}/${formKey(visitorId, slotId)}/`;
}

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

/** The bytes are the type they claim — the same check the check-in photo upload makes (routes/files.ts). */
export function photoBytesMatch(bytes: Buffer, contentType: string): boolean {
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

const notAsked = (): AppError => errors.conflict('DISPLAY_PHOTO_NOT_ASKED',
  'The form on this screen is not asking for that photo. Reception will take it at the till.');
const notConfigured = (): AppError => new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured');

/** Whether the display's own station is showing this visitor's form, asking for this child's photo. */
async function formAsksPhoto(db: Db, auth: DisplayDeviceAuth, visitorId: string, slotId: string): Promise<boolean> {
  if (!auth.station.boxId) return false;
  const { manager } = managerForStation(db, auth.station);
  const document = await manager.open(auth.station.id);
  if (document.stage !== 'input' || document.step !== 7 || document.prompt?.kind !== 'consent') return false;
  const prompt = ConsentDocumentPromptSchema.safeParse(document.prompt);
  return prompt.success && prompt.data.visitorId === visitorId && !prompt.data.completed
    && prompt.data.slots.some((slot) => slot.id === slotId && slot.photo !== undefined);
}

export async function storeDisplayConsentPhoto(
  db: Db,
  storage: FileStorage | null,
  ctx: OpContext,
  auth: DisplayDeviceAuth,
  input: DisplayConsentPhotoUpload,
): Promise<{ fileId: string; replay: boolean }> {
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.length === 0 || bytes.length > DISPLAY_CONSENT_PHOTO_MAX_BYTES || !photoBytesMatch(bytes, input.contentType)) {
    throw errors.badRequest('Send a JPEG, PNG or WebP photo of at most 512 KB.');
  }
  const { operatorId, branchId, id: stationId } = auth.station;
  const prefix = objectPrefix(operatorId, stationId, input.visitorId, input.slotId);
  const claim = await claimClientId(
    input.id,
    async (id) => (await db.select().from(fileObject).where(eq(fileObject.id, id)).limit(1))[0],
    (row) => row.operatorId === operatorId && row.ownerEntityType === DISPLAY_CONSENT_PHOTO_OWNER
      && row.ownerEntityId === stationId && row.objectKey.startsWith(prefix),
  );
  // The same picture resent through a dropped connection: stored once, answered again.
  if (claim.replay) return { fileId: claim.id, replay: true };
  if (!await formAsksPhoto(db, auth, input.visitorId, input.slotId)) throw notAsked();
  if (!storage) throw notConfigured();
  const objectKey = `${prefix}${claim.id}.${EXTENSION[input.contentType]}`;
  // The object first: a row is never written for a picture that was not kept.
  await storage.put(objectKey, bytes, input.contentType);
  await withTx(db, { ...ctx, operatorId, branchId }, 'display.consent_photo', async (tx) => {
    await tx.insert(fileObject).values({
      id: claim.id, operatorId, bucket: storage.bucket, objectKey, contentType: input.contentType,
      size: bytes.length, ownerEntityType: DISPLAY_CONSENT_PHOTO_OWNER, ownerEntityId: stationId,
      uploadedByAccountId: null,
    });
    await audit.record(tx, {
      actorAccountId: null, operatorId, branchId,
      action: 'display.consent_photo', entityType: 'file_object', entityId: claim.id,
      after: { stationId, deviceId: auth.credentialId, slotId: input.slotId, contentType: input.contentType, size: bytes.length },
      requestId: ctx.requestId,
    });
  });
  return { fileId: claim.id, replay: false };
}

/**
 * The till collects the family's picture, to keep it where a staff-taken
 * photo is kept. Only the staff session standing at the station the display
 * is paired to, for the visitor and child the picture was taken for; any
 * other file — another station's, another form's, a check-in photo — is 404.
 * Every read is access-logged before the picture leaves, as a check-in
 * photo's is (R-94).
 */
export async function readDisplayConsentPhoto(
  db: Db,
  storage: FileStorage | null,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string; stationId: string | null },
  target: { id: string; branchId: string; operatorId: string },
  query: { fileId: string; visitorId: string; slotId: string },
): Promise<{ dataUrl: string; contentType: string }> {
  const [row] = await db.select().from(fileObject).where(and(
    eq(fileObject.id, query.fileId), eq(fileObject.operatorId, actor.operatorId),
    eq(fileObject.ownerEntityType, DISPLAY_CONSENT_PHOTO_OWNER), eq(fileObject.ownerEntityId, target.id),
  )).limit(1);
  if (!row || !row.objectKey.startsWith(objectPrefix(target.operatorId, target.id, query.visitorId, query.slotId))) {
    throw errors.notFound('File not found');
  }
  if (!storage?.get) throw notConfigured();
  await withTx(db, { ...ctx, branchId: target.branchId }, 'file.read', async (tx) => {
    await audit.record(tx, {
      actorAccountId: actor.accountId, operatorId: actor.operatorId, branchId: target.branchId,
      action: 'file.read', entityType: 'file_object', entityId: row.id,
      after: { ownerEntityType: row.ownerEntityType, ownerEntityId: row.ownerEntityId, stationId: actor.stationId },
      requestId: ctx.requestId,
    });
  });
  const bytes = await storage.get(row.objectKey);
  return { dataUrl: `data:${row.contentType};base64,${bytes.toString('base64')}`, contentType: row.contentType };
}
