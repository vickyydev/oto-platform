import { describe, expect, it } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed, type ConsentPrompt } from '../src/display-consent';

/**
 * SCRUM-1020 — A SAVED CHILD'S CARE NOTES ON THE CUSTOMER DISPLAY (the
 * owner's answer of 19 November). The form the till publishes marks each
 * saved child whose allergy and medical notes the family may see and update
 * (`careShown`), with the note the till holds and whether it holds the
 * family's "no allergies" (`allergiesNone`). The family's step carries their
 * tick only for such a child. Every field optional, so a till, station or
 * display from before them reads the form as it always did.
 */

const form = (slot: Partial<ConsentPrompt['slots'][number]> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-request', visitorId: 'zz-visitor',
  slots: [{ id: 'zz-mai', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off', saved: true, careShown: true,
    allergiesMedical: 'ZZ TEST peanuts', ...slot }],
  guardianName: 'ZZ TEST Ploy', consentRequired: true, consentAcknowledged: false, confirmations: [],
  staffReady: true, canContinue: false, completed: false,
});
const fill = (allergiesNone?: true) => ({ action: 'fill', requestId: 'zz-request', visitorId: 'zz-visitor',
  slots: [{ id: 'zz-mai', name: 'ZZ TEST Mai', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '',
    ...(allergiesNone ? { allergiesNone } : {}) }],
  guardianName: 'ZZ TEST Ploy', consentAcknowledged: false, acknowledgedConfirmationIds: [] });

describe('SCRUM-1020 — the care notes on the form', () => {
  it('the prompt carries the mark, the note and the family\'s "none"; a form without them is valid as before', () => {
    expect(ConsentPromptSchema.parse(form())).toMatchObject({ slots: [{ careShown: true, allergiesMedical: 'ZZ TEST peanuts' }] });
    expect(ConsentPromptSchema.safeParse(form({ allergiesMedical: '', allergiesNone: true })).success).toBe(true);
    expect(ConsentPromptSchema.safeParse(form({ careShown: undefined, allergiesMedical: undefined })).success).toBe(true);
  });

  it('the step carries "no allergies" as a plain yes, and only for a saved child the form shows the notes of', () => {
    const ticked = ConsentActionSchema.parse(fill(true));
    expect(consentActionAllowed(form(), ticked)).toBe(true);
    expect(consentActionAllowed(form({ careShown: undefined }), ticked)).toBe(false);
    expect(consentActionAllowed(form({ saved: undefined }), ticked)).toBe(false);
    expect(consentActionAllowed(form({ careShown: undefined }), ConsentActionSchema.parse(fill()))).toBe(true);
    expect(ConsentActionSchema.safeParse({ ...fill(), slots: [{ ...fill().slots[0], allergiesNone: false }] }).success).toBe(false);
    expect(ConsentActionSchema.safeParse({ ...fill(), slots: [{ ...fill().slots[0], medicalNotes: 'x' }] }).success).toBe(false);
  });
});
