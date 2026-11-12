import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CONSENT_FORM_STEPS, ConsentActionSchema, ConsentPromptSchema, consentActionAllowed } from '../src/display-consent';

/**
 * SCRUM-857 — STAFF WATCH THE FAMILY FILL THE FORM (the owner's ruling of 12
 * November). The family's screen now sends its `fill` as they type, not only
 * when a step is finished, and says which step they are on, so the till's
 * copy of the same form opens there for staff. Both fields are optional: the
 * till sends `familyStep` with the form, and only a form that saw it sends a
 * `step` back, so an older station — which strips the field it does not know
 * from the form and refuses a `fill` that carries it — is never tripped.
 */
const prompt = {
  kind: 'consent', requestId: 'request', visitorId: 'visitor',
  slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
  guardianName: '', consentRequired: true, consentAcknowledged: false,
  confirmations: [], guardianPhone: '+66898020001', contactChannel: 'whatsapp',
  staffReady: false, canContinue: false, completed: false,
} as const;
const fill = {
  action: 'fill', requestId: 'request', visitorId: 'visitor',
  slots: [{ id: 'slot', name: 'ZZ TEST child', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: 'ZZ TEST gua', guardianPhone: '+66898020001', contactChannel: 'whatsapp',
  consentAcknowledged: false, acknowledgedConfirmationIds: [],
} as const;

describe('the step the family is on', () => {
  it('is the three steps of the form, in order', () => {
    expect(CONSENT_FORM_STEPS).toEqual(['children', 'care', 'agreements']);
  });

  it.each(CONSENT_FORM_STEPS)('travels on the form the till publishes: %s', (familyStep) => {
    expect(ConsentPromptSchema.parse({ ...prompt, familyStep }).familyStep).toBe(familyStep);
  });

  it('is absent from an older till’s form, which stays valid', () => {
    expect('familyStep' in ConsentPromptSchema.parse(prompt)).toBe(false);
  });

  it('is one of the three steps, never anything else', () => {
    expect(ConsentPromptSchema.safeParse({ ...prompt, familyStep: 'payment' }).success).toBe(false);
    expect(ConsentActionSchema.safeParse({ ...fill, step: 'payment' }).success).toBe(false);
  });

  it.each(CONSENT_FORM_STEPS)('comes back with the family’s fill: %s', (step) => {
    const parsed = ConsentActionSchema.parse({ ...fill, step });
    expect(parsed).toMatchObject({ action: 'fill', step });
    expect(consentActionAllowed(ConsentPromptSchema.parse({ ...prompt, familyStep: 'children' }), parsed)).toBe(true);
  });

  it('a fill typed half way (a name still being typed) is a fill like any other', () => {
    const parsed = ConsentActionSchema.parse(fill);
    expect(consentActionAllowed(ConsentPromptSchema.parse(prompt), parsed)).toBe(true);
  });

  it('a fill without the step is still taken, as an older display sends it', () => {
    const parsed = ConsentActionSchema.parse(fill);
    expect('step' in parsed).toBe(false);
  });

  it('an older station strips the step from the form and refuses a fill that carries one', () => {
    // The station's reading from before this change: the same shapes, without the field.
    const { familyStep: _familyStep, ...olderPromptShape } = ConsentPromptSchema.innerType().shape;
    const olderPrompt = z.object(olderPromptShape);
    expect('familyStep' in olderPrompt.parse({ ...prompt, familyStep: 'care' })).toBe(false);
    const fillOption = ConsentActionSchema.optionsMap.get('fill')!;
    const { step: _step, ...olderFillShape } = fillOption.shape as typeof fillOption.shape & { step: unknown };
    const olderFill = z.object(olderFillShape).strict();
    expect(olderFill.safeParse({ ...fill, step: 'care' }).success).toBe(false);
    expect(olderFill.safeParse(fill).success).toBe(true);
  });
});
