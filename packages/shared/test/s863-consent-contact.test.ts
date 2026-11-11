import { describe, expect, it } from 'vitest';
import { ConsentActionSchema, ConsentAnswerSchema, ConsentDocumentPromptSchema, ConsentPromptSchema, consentActionAllowed } from '../src/display-consent';

/**
 * SCRUM-863 — THE DROP-OFF AND NANNY FORM CARRIES THE PARENT'S NUMBER AND
 * CHANNEL BOTH WAYS.
 *
 * The owner's ruling of 12 November: these forms ask the family to confirm or
 * change the number, with the WhatsApp, LINE or Telegram choice, as the
 * prototype's form does. The till sends the channel with the form; a filled
 * step brings the number and the channel back. Both are optional, so a
 * display or a till from before this change is read as it always was.
 */
const prompt = {
  kind: 'consent', requestId: 'request', visitorId: 'visitor',
  slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
  guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: false,
  confirmations: [], guardianPhone: '+66898020001', staffReady: false, canContinue: false, completed: false,
} as const;
const fill = {
  action: 'fill', requestId: 'request', visitorId: 'visitor',
  slots: [{ id: 'slot', name: 'ZZ TEST child', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: 'ZZ TEST guardian', consentAcknowledged: false, acknowledgedConfirmationIds: [],
} as const;

describe('the form the till publishes', () => {
  it.each(['whatsapp', 'telegram', 'line'] as const)('keeps the %s channel beside the number', (contactChannel) => {
    const parsed = ConsentPromptSchema.parse({ ...prompt, contactChannel });
    expect(parsed).toMatchObject({ guardianPhone: '+66898020001', contactChannel });
    // The station's stored copy, with an answer on it, keeps it too.
    expect(ConsentDocumentPromptSchema.parse({ ...prompt, contactChannel }).contactChannel).toBe(contactChannel);
  });

  it('is still valid without a channel, as an older till publishes it', () => {
    const parsed = ConsentPromptSchema.parse(prompt);
    expect('contactChannel' in parsed).toBe(false);
  });

  it('refuses a channel that is not one of the three', () => {
    expect(ConsentPromptSchema.safeParse({ ...prompt, contactChannel: 'sms' }).success).toBe(false);
    expect(ConsentPromptSchema.safeParse({ ...prompt, contactChannel: '' }).success).toBe(false);
  });
});

describe('a step of the form', () => {
  it('carries the number and the channel the family confirmed or changed', () => {
    const parsed = ConsentActionSchema.parse({ ...fill, guardianPhone: ' +66891112222 ', contactChannel: 'telegram' });
    expect(parsed).toMatchObject({ action: 'fill', guardianPhone: '+66891112222', contactChannel: 'telegram' });
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, contactChannel: 'whatsapp' }), parsed)).toBe(true);
    expect(ConsentAnswerSchema.safeParse({ type: 'consent', actionId: 'action', payload: parsed }).success).toBe(true);
  });

  it('may carry an empty number, when the family cleared the field', () => {
    expect(ConsentActionSchema.parse({ ...fill, guardianPhone: '', contactChannel: 'line' })).toMatchObject({ guardianPhone: '', contactChannel: 'line' });
  });

  it('from an older display, with neither field, is taken as it always was', () => {
    const parsed = ConsentActionSchema.parse(fill);
    expect('guardianPhone' in parsed).toBe(false);
    expect('contactChannel' in parsed).toBe(false);
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, contactChannel: 'whatsapp' }), parsed)).toBe(true);
    // And a number alone, sent when none was given at the start.
    expect(ConsentActionSchema.parse({ ...fill, guardianPhone: '0891112222' })).toMatchObject({ guardianPhone: '0891112222' });
  });

  it('refuses a channel that is not one of the three, a number too long to be one, and any field that is not the form’s', () => {
    expect(ConsentActionSchema.safeParse({ ...fill, contactChannel: 'sms' }).success).toBe(false);
    expect(ConsentActionSchema.safeParse({ ...fill, guardianPhone: '1'.repeat(33) }).success).toBe(false);
    expect(ConsentActionSchema.safeParse({ ...fill, contactChannel: 'line', customerPhone: '+66891112222' }).success).toBe(false);
  });

  it('the other answers take no number and no channel', () => {
    for (const action of ['done', 'staff_help'] as const) {
      expect(ConsentActionSchema.safeParse({ action, requestId: 'request', visitorId: 'visitor' }).success).toBe(true);
      expect(ConsentActionSchema.safeParse({ action, requestId: 'request', visitorId: 'visitor', contactChannel: 'line' }).success).toBe(false);
    }
  });
});
