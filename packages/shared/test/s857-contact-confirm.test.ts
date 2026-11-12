import { describe, expect, it } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed } from '../src/display-consent';
import { validateMessagingPhone } from '../src/phone';
import { CreateRegistrationSchema } from '../src/supervision';

/**
 * SCRUM-857 — THE FAMILY CONFIRMS THAT THE NUMBER IS THE ONE FOR THE CHANNEL.
 *
 * The owner's ruling of 8 November: the drop-off and nanny form shows the
 * number the child's messages go to, and the family must explicitly confirm
 * it is the one for WhatsApp, Telegram or LINE. The form the till publishes
 * carries the tick (`contactConfirmed`), a filled step brings it back, and the
 * form is never finished (`done`) while the till asks and the tick is not
 * given. All of it optional: a form from an older till, or one a station from
 * before the field has stripped, reads and finishes as it always did — and
 * `canContinue` keeps its old meaning, so an older station's cross-check of
 * it still passes.
 */
const prompt = {
  kind: 'consent', requestId: 'request', visitorId: 'visitor',
  slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
  guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: true,
  confirmations: [], guardianPhone: '+66898020001', contactChannel: 'whatsapp',
  staffReady: true, canContinue: true, completed: false,
} as const;
const fill = {
  action: 'fill', requestId: 'request', visitorId: 'visitor',
  slots: [{ id: 'slot', name: 'ZZ TEST child', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: 'ZZ TEST guardian', guardianPhone: '+66898020001', contactChannel: 'whatsapp',
  consentAcknowledged: true, acknowledgedConfirmationIds: [],
} as const;
const done = { action: 'done', requestId: 'request', visitorId: 'visitor' } as const;

describe('the form the till publishes', () => {
  it.each([true, false])('carries the tick as %s beside the number and channel', (contactConfirmed) => {
    const parsed = ConsentPromptSchema.parse({ ...prompt, contactConfirmed });
    expect(parsed).toMatchObject({ guardianPhone: '+66898020001', contactChannel: 'whatsapp', contactConfirmed });
  });

  it('is valid without the tick, as an older till publishes it', () => {
    expect('contactConfirmed' in ConsentPromptSchema.parse(prompt)).toBe(false);
  });

  it('keeps canContinue as it was: a form that is ready but unconfirmed still says so', () => {
    // An older station checks canContinue against the readiness it knows; a
    // form that lowered it for the tick would be refused there whole.
    expect(ConsentPromptSchema.safeParse({ ...prompt, canContinue: true, contactConfirmed: false }).success).toBe(true);
    expect(ConsentPromptSchema.safeParse({ ...prompt, canContinue: false, contactConfirmed: false }).success).toBe(false);
  });

  it('is never finished while the till asks and the tick is not given', () => {
    expect(ConsentPromptSchema.safeParse({ ...prompt, completed: true, contactConfirmed: false }).success).toBe(false);
    expect(ConsentPromptSchema.safeParse({ ...prompt, completed: true, contactConfirmed: true }).success).toBe(true);
    expect(ConsentPromptSchema.safeParse({ ...prompt, completed: true }).success).toBe(true);
  });

  it('refuses a tick that is not a boolean', () => {
    expect(ConsentPromptSchema.safeParse({ ...prompt, contactConfirmed: 'yes' }).success).toBe(false);
  });
});

describe('a step of the form', () => {
  it('carries the tick back with the number and the channel', () => {
    const parsed = ConsentActionSchema.parse({ ...fill, contactConfirmed: true });
    expect(parsed).toMatchObject({ action: 'fill', guardianPhone: '+66898020001', contactChannel: 'whatsapp', contactConfirmed: true });
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, contactConfirmed: false }), parsed)).toBe(true);
  });

  it('from an older display, without the tick, is taken as it always was', () => {
    const parsed = ConsentActionSchema.parse(fill);
    expect('contactConfirmed' in parsed).toBe(false);
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, contactConfirmed: false }), parsed)).toBe(true);
  });

  it('the other answers take no tick', () => {
    for (const action of ['done', 'staff_help'] as const) {
      expect(ConsentActionSchema.safeParse({ action, requestId: 'request', visitorId: 'visitor', contactConfirmed: true }).success).toBe(false);
    }
  });
});

describe('finishing the form', () => {
  it('is refused while the till asks and the family has not confirmed', () => {
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, contactConfirmed: false }), done)).toBe(false);
  });

  it('is allowed once they have, and on a form that never asked', () => {
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, contactConfirmed: true }), done)).toBe(true);
    expect(consentActionAllowed(ConsentPromptSchema.parse(prompt), done)).toBe(true);
  });

  it('still needs the staff checks', () => {
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, staffReady: false, canContinue: false, contactConfirmed: true }), done)).toBe(false);
  });
});

describe('the registration carries the confirmation', () => {
  const body = {
    branchId: '0192f5b0-7c3a-7a1b-9a3e-000000000001',
    guardianName: 'ZZ TEST guardian', guardianPhone: '+66898020001', contactChannel: 'telegram',
    consentAcknowledged: true, acknowledgedConfirmationIds: [],
    children: [{ checkinId: '0192f5b0-7c3a-7a1b-9a3e-000000000002', name: 'ZZ TEST child', ageYears: 6, service: 'drop_off' }],
  } as const;

  it.each(['family', 'staff'] as const)('as when it was given and that %s gave it', (by) => {
    const parsed = CreateRegistrationSchema.parse({ ...body, contactConfirmation: { confirmedAt: '2026-11-12T03:00:00.000Z', by } });
    expect(parsed.contactConfirmation).toEqual({ confirmedAt: '2026-11-12T03:00:00.000Z', by });
  });

  it('or not at all, as a station’s offline path and the booking site send it', () => {
    expect(CreateRegistrationSchema.parse(body).contactConfirmation).toBeUndefined();
    expect(CreateRegistrationSchema.parse({ ...body, contactConfirmation: null }).contactConfirmation).toBeNull();
  });

  it('refuses a confirmation that is not a time with a giver', () => {
    expect(CreateRegistrationSchema.safeParse({ ...body, contactConfirmation: { confirmedAt: 'today', by: 'family' } }).success).toBe(false);
    expect(CreateRegistrationSchema.safeParse({ ...body, contactConfirmation: { confirmedAt: '2026-11-12T03:00:00.000Z', by: 'guardian' } }).success).toBe(false);
    expect(CreateRegistrationSchema.safeParse({ ...body, contactConfirmation: { confirmedAt: '2026-11-12T03:00:00.000Z', by: 'family', phone: '+66898020001' } }).success).toBe(false);
    expect(CreateRegistrationSchema.safeParse({ ...body, contactConfirmation: true }).success).toBe(false);
  });
});

describe('a number the park can message a family on', () => {
  it('is a mobile in its stored form: Thai local, Thai international, abroad', () => {
    expect(validateMessagingPhone('0898020001')).toEqual({ ok: true, e164: '+66898020001' });
    expect(validateMessagingPhone('+660898020001')).toEqual({ ok: true, e164: '+66898020001' });
    expect(validateMessagingPhone(' +66 89 802 0001 ')).toEqual({ ok: true, e164: '+66898020001' });
    expect(validateMessagingPhone('0612345678')).toEqual({ ok: true, e164: '+66612345678' });
    expect(validateMessagingPhone('+447911123456')).toEqual({ ok: true, e164: '+447911123456' });
    expect(validateMessagingPhone('+8613800138000')).toEqual({ ok: true, e164: '+8613800138000' });
    expect(validateMessagingPhone('+79161234567')).toEqual({ ok: true, e164: '+79161234567' });
  });

  it('is not an empty field', () => {
    expect(validateMessagingPhone('')).toEqual({ ok: false, problem: 'empty' });
    expect(validateMessagingPhone('   ')).toEqual({ ok: false, problem: 'empty' });
  });

  it('is not something that cannot be a phone number', () => {
    expect(validateMessagingPhone('abc')).toEqual({ ok: false, problem: 'not_a_number' });
    expect(validateMessagingPhone('+6689')).toEqual({ ok: false, problem: 'not_a_number' });
  });

  it('is not a number of the right length with digits no country issues', () => {
    // Possible by length (what normalizePhone checks) but not a Thai number.
    expect(validateMessagingPhone('0112345678')).toEqual({ ok: false, problem: 'not_valid' });
  });

  it('is not a landline or a toll-free line, where the library can tell', () => {
    expect(validateMessagingPhone('021234567')).toEqual({ ok: false, problem: 'not_mobile' });
    expect(validateMessagingPhone('+442079460958')).toEqual({ ok: false, problem: 'not_mobile' });
    expect(validateMessagingPhone('+18002345678')).toEqual({ ok: false, problem: 'not_mobile' });
  });

  it('lets a number through whose type the library cannot tell', () => {
    // US numbers are fixed-line-or-mobile: no way to tell, so not refused.
    expect(validateMessagingPhone('+12025550123')).toEqual({ ok: true, e164: '+12025550123' });
  });
});
