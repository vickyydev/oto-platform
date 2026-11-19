import { describe, expect, it } from 'vitest';
import { ConsentPromptSchema, consentActionAllowed, type ConsentPrompt } from '../src/display-consent';
import { LastChildPhotoSchema, ReuseRegistrationPhotoSchema } from '../src/supervision';

/**
 * SCRUM-1018 — A RETURNING FAMILY IN THREE STEPS (the owner's answers of 19
 * November). The form the till publishes says what is shown and not asked:
 * the number (`phoneFixed`, replacing the tick of SCRUM-863), the parent's
 * name from the profile (`guardianFixed`), and a returning family's form of
 * agreements alone (`agreementsOnly`). All optional, so a till or station
 * from before them reads the form as it always did. And the reuse of a
 * returning child's last photo names each child once.
 */

const ZZ_PHONE = '+66898020001'; // ZZ TEST number, used only by this fixture.
const prompt = (extra: Partial<ConsentPrompt> = {}) => ({
  kind: 'consent' as const, requestId: 'zz-request', visitorId: 'zz-visitor',
  slots: [{ id: 'zz-mai', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off' as const, saved: true }],
  guardianName: 'ZZ TEST Ploy', guardianPhone: ZZ_PHONE, contactChannel: 'whatsapp' as const, consentRequired: true,
  consentAcknowledged: true, confirmations: [], staffReady: true, canContinue: true, completed: false, ...extra,
});

describe('the form for a returning family', () => {
  it('carries what is shown, not asked', () => {
    const parsed = ConsentPromptSchema.parse(prompt({ phoneFixed: true, guardianFixed: true, agreementsOnly: true }));
    expect(parsed).toMatchObject({ phoneFixed: true, guardianFixed: true, agreementsOnly: true });
    expect(parsed.contactConfirmed).toBeUndefined();
  });

  it('is finished, and its Done taken, with no number tick', () => {
    const shown = ConsentPromptSchema.parse(prompt({ phoneFixed: true }));
    expect(consentActionAllowed(shown, { requestId: 'zz-request', visitorId: 'zz-visitor', action: 'done' })).toBe(true);
    expect(ConsentPromptSchema.safeParse(prompt({ phoneFixed: true, completed: true })).success).toBe(true);
  });

  it('a form without the fields is read as before', () => {
    const parsed = ConsentPromptSchema.parse(prompt());
    expect(parsed.phoneFixed).toBeUndefined();
    expect(parsed.agreementsOnly).toBeUndefined();
  });
});

describe('the last photo and its reuse', () => {
  const stay = '0193a4f0-0000-7000-8000-000000000001';
  const earlier = '0193a4f0-0000-7000-8000-000000000002';

  it('names each child once, at least one', () => {
    expect(ReuseRegistrationPhotoSchema.safeParse({ children: [{ checkinId: stay, fromCheckinId: earlier }] }).success).toBe(true);
    expect(ReuseRegistrationPhotoSchema.safeParse({ children: [] }).success).toBe(false);
    expect(ReuseRegistrationPhotoSchema.safeParse({ children: [
      { checkinId: stay, fromCheckinId: earlier }, { checkinId: stay, fromCheckinId: earlier },
    ] }).success).toBe(false);
    expect(ReuseRegistrationPhotoSchema.safeParse({ children: [{ checkinId: stay, fromCheckinId: earlier, fileId: earlier }] }).success).toBe(false);
  });

  it('the last photo is a stay or nothing', () => {
    expect(LastChildPhotoSchema.parse({ photo: null })).toEqual({ photo: null });
    expect(LastChildPhotoSchema.safeParse({ photo: { checkinId: earlier, registrationId: stay, fileId: stay, takenAt: '2026-11-10T03:00:00.000Z' } }).success).toBe(true);
  });
});
