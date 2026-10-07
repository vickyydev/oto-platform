import { describe, expect, it } from 'vitest';
import {
  KIOSK_DESK_STATES,
  KIOSK_DEVICE_SCOPES,
  KIOSK_IDLE_TIMEOUT_MS,
  KIOSK_PRIVATE_FIELD,
  KIOSK_REASONS,
  KIOSK_REDEEM_SCOPE,
  KIOSK_SIMULATOR_CONTROLS,
  KioskAbandonAnswerSchema,
  KioskAbandonRequestSchema,
  KioskDeskEntrySchema,
  KioskPairingCodeSchema,
  KioskRedeemAnswerSchema,
  KioskRedeemRequestSchema,
  KioskSessionAnswerSchema,
  KioskSessionStartRequestSchema,
  KioskStateSchema,
  PERMISSIONS,
  ROLE_BUNDLES,
  formatKioskPairingCode,
  normaliseKioskPairingCode,
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

/**
 * S2-20 K2 — the kiosk's own screen: Q9's timeout, a guest's session, the K
 * pairing code that keeps a kiosk's code apart from a display's, and the
 * staff-side shapes, none of which can carry a private field to a kiosk.
 */
describe('the kiosk surface contract (K2)', () => {
  it('times a guest out after 60 seconds of nothing (Q9)', () => {
    expect(KIOSK_IDLE_TIMEOUT_MS).toBe(60_000);
    expect(KIOSK_REASONS.idle).toBe('KIOSK_IDLE_TIMEOUT');
  });

  it('reads a kiosk pairing code however a person typed it, and never a display code as one', () => {
    expect(normaliseKioskPairingCode('K482913')).toBe('K482913');
    expect(normaliseKioskPairingCode(' k-482 913 ')).toBe('K482913');
    expect(normaliseKioskPairingCode('482913')).toBe('K482913');
    expect(normaliseKioskPairingCode('K48291')).toBeNull();
    expect(normaliseKioskPairingCode('D482913')).toBeNull();
    expect(KioskPairingCodeSchema.safeParse('482913').success).toBe(false);
    expect(KioskPairingCodeSchema.safeParse('K482913').success).toBe(true);
    expect(formatKioskPairingCode('K482913')).toBe('K 482 913');
  });

  it('takes the screen session on the press, and nothing else new', () => {
    const press = {
      actionId: '01a11111-0000-7000-8000-000000000002',
      qr: 'OTO1.ABC.DEF',
      sessionId: '01a11111-0000-7000-8000-000000000003',
    };
    expect(KioskRedeemRequestSchema.parse(press)).toEqual(press);
    expect(() => KioskSessionStartRequestSchema.parse({ sessionId: 'not-a-uuid' })).toThrow();
    expect(() => KioskAbandonRequestSchema.parse({ cause: 'bored' })).toThrow();
    expect(KioskAbandonRequestSchema.parse({ cause: 'idle' })).toEqual({ cause: 'idle' });
  });

  it('tells the kiosk nothing private about itself or a session', () => {
    const state = { station: { id: ANSWER.sessionId, name: 'Kiosk 1' }, branchName: 'HKT', idleTimeoutMs: 60_000 };
    expect(KioskStateSchema.parse(state)).toEqual(state);
    expect(() => KioskStateSchema.parse({ ...state, staffName: 'Ploy' })).toThrow();
    const ended = {
      sessionId: ANSWER.sessionId,
      startedAt: '2026-10-07T03:00:00.000Z',
      endedAt: '2026-10-07T03:01:00.000Z',
      outcome: 'abandoned',
      abandoned: true,
    };
    expect(KioskAbandonAnswerSchema.parse(ended)).toEqual(ended);
    expect(() => KioskAbandonAnswerSchema.parse({ ...ended, phone: '+66812345678' })).toThrow();
    for (const shape of [KioskStateSchema, KioskSessionAnswerSchema, KioskAbandonAnswerSchema]) {
      const keys = Object.keys(shape.shape);
      expect(keys.filter((k) => KIOSK_PRIVATE_FIELD.test(k))).toEqual([]);
    }
  });

  it('keeps the staff desk and the Kiosk tile to bookings, states and counts', () => {
    expect(KIOSK_DESK_STATES).toEqual(['to_redeem', 'to_check_in', 'done']);
    const entry = KioskDeskEntrySchema.shape;
    expect(Object.keys(entry).filter((k) => KIOSK_PRIVATE_FIELD.test(k))).toEqual([]);
    expect(Object.keys(entry.booking.shape).filter((k) => KIOSK_PRIVATE_FIELD.test(k))).toEqual([]);
    expect(KIOSK_SIMULATOR_CONTROLS).toEqual(['printer_offline', 'paper_out', 'box_offline', 'clear']);
  });
});
