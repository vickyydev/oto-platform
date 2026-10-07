import { describe, expect, it } from 'vitest';
import {
  KIOSK_DEVICE_SCOPES,
  KIOSK_PRIVATE_FIELD,
  KIOSK_REDEEM_SCOPE,
  KioskRedeemAnswerSchema,
  KioskRedeemRequestSchema,
  PERMISSIONS,
  ROLE_BUNDLES,
} from '../src';

/**
 * S2-20 K1 — the kiosk's contract: a device scope no person holds, a press
 * that names itself, and an answer that cannot carry a child's allergy, a
 * name or a phone onto a screen in a shopping centre (R-58, H15, H16).
 */

const ANSWER = {
  sessionId: '01a11111-0000-7000-8000-000000000001',
  outcome: 'issued',
  reason: null,
  replay: false,
  booking: { reference: 'OTO-ABCD-1234', kids: 2, adults: 1 },
  bands: [{ kind: 'kid', shortCode: 'K1-X3ABCD' }],
  walletCreditSatang: 89_000,
  desk: { required: false, supervisedChildren: 0 },
  alreadyRedeemed: null,
};

describe('the kiosk contract', () => {
  it('keeps the kiosk scope out of the human vocabulary and out of every role', () => {
    expect(KIOSK_DEVICE_SCOPES).toEqual([KIOSK_REDEEM_SCOPE]);
    expect((PERMISSIONS as readonly string[]).includes(KIOSK_REDEEM_SCOPE)).toBe(false);
    for (const bundle of Object.values(ROLE_BUNDLES)) {
      expect((bundle as readonly string[]).includes(KIOSK_REDEEM_SCOPE)).toBe(false);
    }
  });

  it('takes a press with its own id and the whole QR, and nothing else', () => {
    const press = { actionId: '01a11111-0000-7000-8000-000000000002', qr: 'OTO1.ABC.DEF' };
    expect(KioskRedeemRequestSchema.parse(press)).toEqual(press);
    expect(() => KioskRedeemRequestSchema.parse({ ...press, actionId: 'tap-1' })).toThrow();
    expect(() => KioskRedeemRequestSchema.parse({ ...press, reference: 'OTO-ABCD-1234' })).toThrow();
    expect(() => KioskRedeemRequestSchema.parse({ actionId: press.actionId })).toThrow();
  });

  it('answers with nothing private, and refuses an answer that would carry it', () => {
    expect(KioskRedeemAnswerSchema.parse(ANSWER)).toEqual(ANSWER);
    expect(() => KioskRedeemAnswerSchema.parse({ ...ANSWER, phone: '+66812345678' })).toThrow();
    expect(() =>
      KioskRedeemAnswerSchema.parse({ ...ANSWER, bands: [{ kind: 'kid', shortCode: null, allergies: 'Peanuts' }] }),
    ).toThrow();
    expect(() =>
      KioskRedeemAnswerSchema.parse({ ...ANSWER, booking: { ...ANSWER.booking, parentName: 'Khun Mali' } }),
    ).toThrow();
    for (const key of ['allergies', 'medicalNotes', 'dietary', 'phone', 'contactChannel', 'email', 'guardianName', 'parentName', 'childName', 'nickname', 'notes']) {
      expect(KIOSK_PRIVATE_FIELD.test(key), key).toBe(true);
    }
    for (const key of ['reference', 'kids', 'adults', 'shortCode', 'stationName', 'branchName', 'reason']) {
      expect(KIOSK_PRIVATE_FIELD.test(key), key).toBe(false);
    }
  });
});
