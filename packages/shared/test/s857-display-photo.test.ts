import { describe, expect, it } from 'vitest';
import {
  ConsentActionSchema, ConsentPromptSchema, DISPLAY_CONSENT_PHOTO_MAX_BYTES, DisplayConsentPhotoUploadSchema,
  consentActionAllowed,
} from '../src/display-consent';

/**
 * SCRUM-857 — THE FAMILY TAKES THE CHILD'S PHOTO ON THEIR OWN SCREEN.
 *
 * The owner's ruling of 8 November: on the drop-off and nanny form the family
 * takes the photo with a button, instead of reception. The till marks each
 * child the photo is asked for (`photo`: needed or taken); the display sends
 * the picture to the platform and then names the stored file to the till
 * (`photo` action). Both optional and additive: a form without the mark is
 * the form as it was, and no photo can be sent for it.
 */
const FILE_ID = '0190f0a4-7b7e-7c3a-9f1e-1a2b3c4d5e6f';
const prompt = {
  kind: 'consent', requestId: 'request', visitorId: 'visitor',
  slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off', photo: 'needed' }],
  guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: true,
  confirmations: [], staffReady: false, canContinue: false, completed: false,
} as const;
const photo = { action: 'photo', requestId: 'request', visitorId: 'visitor', slotId: 'slot', fileId: FILE_ID } as const;

describe('the form the till publishes', () => {
  it.each(['needed', 'taken'] as const)('carries the photo mark %s on a child', (mark) => {
    const parsed = ConsentPromptSchema.parse({ ...prompt, slots: [{ ...prompt.slots[0], photo: mark }] });
    expect(parsed.slots[0]!.photo).toBe(mark);
  });

  it('is valid without the mark, as an older till publishes it', () => {
    const { photo: _mark, ...older } = prompt.slots[0];
    expect(ConsentPromptSchema.parse({ ...prompt, slots: [older] }).slots[0]!.photo).toBeUndefined();
  });

  it('refuses a mark that is neither', () => {
    expect(ConsentPromptSchema.safeParse({ ...prompt, slots: [{ ...prompt.slots[0], photo: 'yes' }] }).success).toBe(false);
  });
});

describe('the photo the family sends', () => {
  it('names the slot and the stored file, and nothing else', () => {
    expect(ConsentActionSchema.parse(photo)).toEqual(photo);
    expect(ConsentActionSchema.safeParse({ ...photo, dataUrl: 'data:image/jpeg;base64,AAAA' }).success).toBe(false);
    expect(ConsentActionSchema.safeParse({ ...photo, fileId: 'not-a-file' }).success).toBe(false);
  });

  it('is taken only for a child whose form asks the display for a photo', () => {
    const parsed = ConsentPromptSchema.parse(prompt);
    expect(consentActionAllowed(parsed, ConsentActionSchema.parse(photo))).toBe(true);
    expect(consentActionAllowed(parsed, ConsentActionSchema.parse({ ...photo, slotId: 'other' }))).toBe(false);
    const { photo: _mark, ...older } = prompt.slots[0];
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, slots: [older] }), ConsentActionSchema.parse(photo))).toBe(false);
  });

  it('is refused for another visitor, another request or a finished form', () => {
    const parsed = ConsentPromptSchema.parse(prompt);
    expect(consentActionAllowed(parsed, ConsentActionSchema.parse({ ...photo, visitorId: 'someone-else' }))).toBe(false);
    expect(consentActionAllowed(parsed, ConsentActionSchema.parse({ ...photo, requestId: 'older' }))).toBe(false);
    const finished = ConsentPromptSchema.parse({ ...prompt, staffReady: true, canContinue: true, completed: true,
      slots: [{ ...prompt.slots[0], photo: 'taken' }] });
    expect(consentActionAllowed(finished, ConsentActionSchema.parse(photo))).toBe(false);
  });
});

describe('the upload from the display', () => {
  const upload = { id: FILE_ID, visitorId: 'visitor', slotId: 'slot', contentType: 'image/jpeg', data: '/9j/4AAQ' } as const;

  it('takes a small base64 photo', () => {
    expect(DisplayConsentPhotoUploadSchema.parse(upload)).toEqual(upload);
  });

  it('refuses a body that is not a photo, too large, or carries more', () => {
    expect(DisplayConsentPhotoUploadSchema.safeParse({ ...upload, contentType: 'image/svg+xml' }).success).toBe(false);
    expect(DisplayConsentPhotoUploadSchema.safeParse({ ...upload, data: 'not base64!' }).success).toBe(false);
    expect(DisplayConsentPhotoUploadSchema.safeParse({ ...upload,
      data: 'A'.repeat(Math.ceil(DISPLAY_CONSENT_PHOTO_MAX_BYTES / 3) * 4 + 4) }).success).toBe(false);
    expect(DisplayConsentPhotoUploadSchema.safeParse({ ...upload, stationId: 'another' }).success).toBe(false);
    expect(DisplayConsentPhotoUploadSchema.safeParse({ ...upload, id: 'not-a-uuid' }).success).toBe(false);
  });
});
