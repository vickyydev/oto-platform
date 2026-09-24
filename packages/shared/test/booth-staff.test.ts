import { describe, expect, it } from 'vitest';
import {
  BOOTH_SIGN_IN_REFUSALS,
  BOOTH_STAFF_SESSION_DEFAULT_MINUTES,
  BOOTH_STAFF_SESSION_MAX_MINUTES,
  BOOTH_STAFF_VERIFY_ERRORS,
  BoothConfigBundleSchema,
  BoothStaffVerifyRequestSchema,
  boothStaffCode,
  boothStaffLabel,
  boothStaffSessionMinutes,
} from '../src/booth';
import { ROLE_BUNDLES } from '../src/permissions';

/**
 * SCRUM-223 — what the booth, the box and the cloud agree on about the person
 * signed in at a booth: how long they stay signed in, the code on the slip,
 * and which roles may sign in at all.
 */

const bundle = {
  schemaVersion: 1,
  settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
  layout: { id: '018f1d2c-0000-7000-8000-00000000fa00', name: 'Classic', version: 1, design: {}, assetManifest: {} },
  prizes: [],
};

describe('the booth session length (staffSessionMinutes)', () => {
  it('a bundle published before the field existed still parses, and runs on the default', () => {
    const parsed = BoothConfigBundleSchema.parse(bundle);
    expect(parsed.settings.staffSessionMinutes).toBeUndefined();
    expect(boothStaffSessionMinutes(parsed.settings)).toBe(BOOTH_STAFF_SESSION_DEFAULT_MINUTES);
    expect(BOOTH_STAFF_SESSION_DEFAULT_MINUTES).toBe(720);
  });

  it('a bundle that names one is honoured, and kept through the parse', () => {
    const parsed = BoothConfigBundleSchema.parse({
      ...bundle,
      settings: { ...bundle.settings, staffSessionMinutes: 90 },
    });
    expect(parsed.settings.staffSessionMinutes).toBe(90);
    expect(boothStaffSessionMinutes(parsed.settings)).toBe(90);
  });

  it('null means the default; a day is the ceiling', () => {
    expect(boothStaffSessionMinutes({ staffSessionMinutes: null })).toBe(720);
    expect(boothStaffSessionMinutes({ staffSessionMinutes: 5000 })).toBe(BOOTH_STAFF_SESSION_MAX_MINUTES);
  });

  it('refuses a length that is not a positive whole number of minutes', () => {
    for (const bad of [0, -5, 1.5]) {
      expect(
        BoothConfigBundleSchema.safeParse({
          ...bundle,
          settings: { ...bundle.settings, staffSessionMinutes: bad },
        }).success,
      ).toBe(false);
    }
  });
});

describe('the staff code on a booth voucher', () => {
  const a = '01a0bbdc-8ca5-7f31-b1cc-feac984d9f72';
  const b = '01a0bbdc-8ca5-7f31-b1cc-feac984d9f73';

  it('is S- and four characters from the booth alphabet, and the same every time', () => {
    const code = boothStaffCode(a);
    expect(code).toMatch(/^S-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    expect(boothStaffCode(a)).toBe(code);
    expect(boothStaffCode(a.toUpperCase())).toBe(code);
  });

  it('two accounts one apart get two codes', () => {
    expect(boothStaffCode(a)).not.toBe(boothStaffCode(b));
  });

  it('labels the Staff row with what is known, and nothing when nothing is', () => {
    expect(boothStaffLabel('Nok', 'S-7KMQ')).toBe('Nok (S-7KMQ)');
    expect(boothStaffLabel(null, 'S-7KMQ')).toBe('S-7KMQ');
    expect(boothStaffLabel('Nok', null)).toBe('Nok');
    expect(boothStaffLabel('  ', null)).toBeNull();
  });
});

describe('the verify request a box sends', () => {
  it('names a station by id and bounds what it carries', () => {
    expect(
      BoothStaffVerifyRequestSchema.safeParse({
        stationId: '01a0bbdc-8ca5-7f31-b1cc-feac984d9f72',
        phone: '0812345678',
        password: 'x',
      }).success,
    ).toBe(true);
    expect(
      BoothStaffVerifyRequestSchema.safeParse({ stationId: 'booth-1', phone: '081', password: 'x' })
        .success,
    ).toBe(false);
    expect(
      BoothStaffVerifyRequestSchema.safeParse({
        stationId: '01a0bbdc-8ca5-7f31-b1cc-feac984d9f72',
        phone: '0812345678',
        password: 'p'.repeat(257),
      }).success,
    ).toBe(false);
  });
});

describe('what a refused account sign-in can say', () => {
  it('tells a box the cloud refused, and a booth it moved, apart from no internet', () => {
    expect(BOOTH_SIGN_IN_REFUSALS).toContain('offline');
    expect(BOOTH_SIGN_IN_REFUSALS).toContain('box_refused');
    expect(BOOTH_SIGN_IN_REFUSALS).toContain('booth_not_on_box');
    // The codes the box reads them from, as the api answers them.
    expect(BOOTH_STAFF_VERIFY_ERRORS.boothNotOnBox).toBe('BOOTH_NOT_ON_THIS_BOX');
    expect(BOOTH_STAFF_VERIFY_ERRORS.boxDisabled).toBe('BOX_DISABLED');
    expect(BOOTH_STAFF_VERIFY_ERRORS.invalid).toBe('INVALID_CREDENTIALS');
  });
});

describe('who may sign in at a booth (booth:staff:sign_in)', () => {
  it('every counter role carries it, and so do both administrator roles', () => {
    for (const role of ['staff', 'reception', 'branch_manager', 'operator_admin', 'platform_admin'] as const) {
      expect(ROLE_BUNDLES[role]).toContain('booth:staff:sign_in');
    }
  });
});
