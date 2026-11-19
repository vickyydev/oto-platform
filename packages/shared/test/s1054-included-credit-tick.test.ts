import { describe, expect, it } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed, type ConsentPrompt } from '../src/display-consent';
import { BridgeCheckinCreateSchema, OfflineCheckinCreatedSchema } from '../src/checkin-offline';
import { CreateRegistrationSchema, PlatformRegistrationChildSchema, RegistrationChildSchema } from '../src/supervision';

/**
 * SCRUM-1054 — THE PARENT'S TICK: "MAY ORDER FOOD WITH THE INCLUDED CREDIT"
 * (the owner's answer of 19 November 2026, R3). The form the till publishes
 * carries the tick for a child whose ticket includes credit and whose form
 * asks the family's extra credit; the family's step carries it back only for
 * such a child. The platform's registration takes it; the counter box's
 * registration and its replayed fact do not know it, so the till never sends
 * it there. Every field optional, so a till, station or display from before
 * it reads the form as it always did.
 */

const form = (slot: Partial<ConsentPrompt['slots'][number]> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-request', visitorId: 'zz-visitor',
  slots: [{ id: 'zz-mint', name: 'ZZ TEST Mint', ageYears: 6, requirement: 'drop_off',
    includedCreditTHB: 1300, extraCreditTHB: 0, orderWithIncludedCredit: false, ...slot }],
  guardianName: 'ZZ TEST Ploy', consentRequired: true, consentAcknowledged: false, confirmations: [],
  staffReady: true, canContinue: false, completed: false,
});
const fill = (tick?: boolean) => ({ action: 'fill', requestId: 'zz-request', visitorId: 'zz-visitor',
  slots: [{ id: 'zz-mint', name: 'ZZ TEST Mint', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '',
    extraCreditTHB: 0, ...(tick !== undefined ? { orderWithIncludedCredit: tick } : {}) }],
  guardianName: 'ZZ TEST Ploy', consentAcknowledged: false, acknowledgedConfirmationIds: [] });

const child = { checkinId: '0192f000-0000-7000-8000-000000001054', name: 'ZZ TEST Mint', ageYears: 6, service: 'drop_off' as const,
  foodProvision: { mode: 'none' as const, paidSatang: 0 } };

describe('SCRUM-1054 — the tick on the form', () => {
  it('the prompt carries it; a form without it is valid as before', () => {
    expect(ConsentPromptSchema.parse(form({ orderWithIncludedCredit: true })).slots[0]).toMatchObject({ orderWithIncludedCredit: true });
    expect(ConsentPromptSchema.safeParse(form({ orderWithIncludedCredit: undefined })).success).toBe(true);
  });

  it('the step carries the family’s yes or no, only for a child whose form asks it', () => {
    const ticked = ConsentActionSchema.parse(fill(true));
    expect(consentActionAllowed(form(), ticked)).toBe(true);
    expect(consentActionAllowed(form(), ConsentActionSchema.parse(fill(false)))).toBe(true);
    expect(consentActionAllowed(form({ orderWithIncludedCredit: undefined }), ticked)).toBe(false);
    // A step without it is taken as before, on either form.
    expect(consentActionAllowed(form({ orderWithIncludedCredit: undefined }), ConsentActionSchema.parse(fill()))).toBe(true);
    expect(ConsentActionSchema.safeParse({ ...fill(), slots: [{ ...fill().slots[0], orderWithIncludedCredit: 'yes' }] }).success).toBe(false);
  });
});

describe('SCRUM-1054 — the tick on the registration', () => {
  it('the platform’s registration takes it', () => {
    expect(PlatformRegistrationChildSchema.parse({ ...child, orderWithIncludedCredit: true })).toMatchObject({ orderWithIncludedCredit: true });
    const reg = CreateRegistrationSchema.safeParse({ branchId: '0192f000-0000-7000-8000-000000000001', guardianName: 'ZZ TEST Ploy',
      consentAcknowledged: true, children: [{ ...child, orderWithIncludedCredit: true }] });
    expect(reg.success).toBe(true);
  });

  it('the counter box’s registration and its fact do not know it: the till leaves it off there', () => {
    expect(RegistrationChildSchema.safeParse({ ...child, orderWithIncludedCredit: true }).success).toBe(false);
    expect(BridgeCheckinCreateSchema.safeParse({ registrationId: '0192f000-0000-7000-8000-000000000002', guardianName: 'ZZ TEST Ploy',
      consentAcknowledged: true, children: [{ ...child, orderWithIncludedCredit: true }] }).success).toBe(false);
    expect(OfflineCheckinCreatedSchema.shape.children.element).toBe(RegistrationChildSchema);
  });
});
