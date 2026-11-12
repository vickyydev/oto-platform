import { DISPLAY_CONSENT_PHOTO_TYPES, type DisplayConsentPhotoUpload } from '@oto/shared';
import { api } from './client';
import { DisplayError, displayRequest } from './display';

/**
 * SCRUM-857 — THE FAMILY'S PHOTO OF A CHILD, FROM THE PAIRED DISPLAY.
 *
 * The display sends the picture with its own credential (never a staff
 * cookie) to the platform, which keeps it only while the form on the
 * display's station asks for that child's photo; the till standing at that
 * station then collects it and keeps it on the child's slot, exactly where a
 * photo staff take is kept, so it is uploaded to the registration when the
 * registration is written (`checkinApi.uploadPhoto`).
 */

type PhotoType = (typeof DISPLAY_CONSENT_PHOTO_TYPES)[number];

/** A picture as `<img>` and the camera hand it over, split into its type and bytes. */
export function photoOfDataUrl(dataUrl: string): { contentType: PhotoType; data: string } | null {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  return { contentType: match[1] as PhotoType, data: match[2]! };
}

/** Which picture, of which child, on which form: `id` is minted once per picture, so a resend is the same file. */
export interface DisplayPhotoForm { id: string; visitorId: string; slotId: string }

/** The display's side: store the picture, answered with the stored file's id. */
export async function sendDisplayConsentPhoto(bearer: string, form: DisplayPhotoForm, dataUrl: string): Promise<string> {
  const photo = photoOfDataUrl(dataUrl);
  if (!photo) throw new DisplayError(400, 'BAD_REQUEST', 'The photo could not be read. Please take it again.');
  const body: DisplayConsentPhotoUpload = { ...form, ...photo };
  const answer = await displayRequest<{ fileId: string }>(bearer, 'POST', '/consent-photos', body);
  return answer.fileId;
}

/** The till's side: collect the family's picture for the form and child it was taken for. */
export async function collectDisplayConsentPhoto(
  stationId: string,
  form: { fileId: string; visitorId: string; slotId: string },
): Promise<string> {
  const query = new URLSearchParams({ visitorId: form.visitorId, slotId: form.slotId });
  const answer = await api.get<{ dataUrl: string }>(
    `/stations/${encodeURIComponent(stationId)}/consent-photos/${encodeURIComponent(form.fileId)}?${query.toString()}`,
  );
  if (!photoOfDataUrl(answer.dataUrl)) throw new Error('The photo from the display could not be read.');
  return answer.dataUrl;
}
