import { describe, expect, it } from 'vitest';
import {
  BOOTH_SPIN_DURATION_DEFAULT_SECONDS,
  BOOTH_SPIN_DURATION_MIN_SECONDS,
  BOOTH_SPIN_DURATION_MAX_SECONDS,
  BoothConfigBundleSchema,
  boothStaffCode,
  boothStaffLabel,
  boothSpinDurationSeconds,
} from '../src/booth';
import { ROLE_BUNDLES } from '../src/permissions';

/**
 * SCRUM-223, SCRUM-694 — what the booth, the box and the cloud agree on about
 * a booth's settings and the Staff row: the spin duration, a bundle published
 * while the booth still had a staff session length, the staff code an older
 * slip carried, and that nobody signs in at a booth any more.
 */

const bundle = {
  schemaVersion: 1,
  settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
  layout: { id: '018f1d2c-0000-7000-8000-00000000fa00', name: 'Classic', version: 1, design: {}, assetManifest: {} },
  prizes: [],
};

describe('the published spin duration', () => {
  it('leaves a historical bundle unchanged and resolves its absent duration as ten seconds', () => {
    const parsed = BoothConfigBundleSchema.parse(bundle);
    expect(parsed).toEqual(bundle);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(bundle));
    expect(parsed.settings.spinDurationSeconds).toBeUndefined();
    expect(boothSpinDurationSeconds(parsed.settings)).toBe(10);
    expect(BOOTH_SPIN_DURATION_DEFAULT_SECONDS).toBe(10);
  });

  it('retains configured whole seconds, including both bounds', () => {
    expect(BOOTH_SPIN_DURATION_MIN_SECONDS).toBe(2);
    expect(BOOTH_SPIN_DURATION_MAX_SECONDS).toBe(20);
    for (const seconds of [2, 12, 20]) {
      const parsed = BoothConfigBundleSchema.parse({
        ...bundle, settings: { ...bundle.settings, spinDurationSeconds: seconds },
      });
      expect(boothSpinDurationSeconds(parsed.settings)).toBe(seconds);
      expect(parsed.settings.spinDurationSeconds).toBe(seconds);
    }
  });

  it('refuses a duration outside the range or a fraction and safely falls back at runtime', () => {
    for (const bad of [0, 1, 21, 12.5, NaN]) {
      expect(BoothConfigBundleSchema.safeParse({
        ...bundle, settings: { ...bundle.settings, spinDurationSeconds: bad },
      }).success).toBe(false);
      expect(boothSpinDurationSeconds({ spinDurationSeconds: bad })).toBe(10);
    }
  });
});

describe('a bundle published before SCRUM-694', () => {
  it('still parses with its retired staffSessionMinutes, and the parsed settings drop it', () => {
    const older = { ...bundle, settings: { ...bundle.settings, staffSessionMinutes: 600 } };
    const parsed = BoothConfigBundleSchema.safeParse(older);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'staffSessionMinutes' in parsed.data.settings).toBe(false);
    // Nothing a box needs is lost with it.
    expect(parsed.success && parsed.data.settings.buttonKey).toBe('Space');
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

describe('nobody signs in at a booth (SCRUM-694)', () => {
  it('no role carries the retired booth sign-in permission', () => {
    for (const role of ['staff', 'reception', 'branch_manager', 'operator_admin', 'platform_admin'] as const) {
      expect(ROLE_BUNDLES[role] as readonly string[]).not.toContain('booth:staff:sign_in');
    }
  });
});
