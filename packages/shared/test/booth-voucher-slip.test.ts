import { describe, expect, it } from 'vitest';
import {
  BOOTH_VOUCHER_SLIP_DEFAULTS,
  BoothConfigBundleSchema,
  boothVoucherSlip,
  boothVoucherSlipBundleFields,
  boothVoucherText,
} from '../src/booth';

/**
 * SCRUM-471 — the booth's own voucher slip, as the published wheel carries it.
 *
 * The first invariant of the round: a booth nobody has customised publishes
 * the document it always did, so its hash does not move and its box prints
 * the slip it always printed.
 */

const historical = {
  schemaVersion: 1,
  settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
  layout: { id: '018f1d2c-0000-7000-8000-00000000fa00', name: 'Classic', version: 1, design: {}, assetManifest: {} },
  prizes: [],
};

describe('the voucher slip in the published wheel', () => {
  it('parses a bundle from before the fields existed unchanged, and resolves it to today’s slip', () => {
    const parsed = BoothConfigBundleSchema.parse(historical);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(historical));
    expect(boothVoucherSlip(parsed.settings)).toEqual({
      showLogo: true,
      headerText: null,
      footerText: null,
      showStaff: true,
      showTerms: true,
    });
  });

  it('writes nothing into the bundle for the defaults', () => {
    expect(boothVoucherSlipBundleFields({ ...BOOTH_VOUCHER_SLIP_DEFAULTS })).toEqual({});
    // Blank text is "not set", not a line of spaces on the paper.
    expect(
      boothVoucherSlipBundleFields({ ...BOOTH_VOUCHER_SLIP_DEFAULTS, headerText: '   ', footerText: '' }),
    ).toEqual({});
  });

  it('round-trips a customised slip through the bundle schema', () => {
    const slip = {
      showLogo: false,
      headerText: 'Lucky Wheel · Central Floresta',
      footerText: 'Thank you for playing!\nขอบคุณที่ร่วมสนุก',
      showStaff: false,
      showTerms: false,
    };
    const bundle = {
      ...historical,
      settings: { ...historical.settings, ...boothVoucherSlipBundleFields(slip) },
    };
    const parsed = BoothConfigBundleSchema.parse(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.settings).toEqual(bundle.settings);
    expect(boothVoucherSlip(parsed.settings)).toEqual(slip);
  });

  it('carries only the fields that differ from their defaults', () => {
    expect(
      boothVoucherSlipBundleFields({ ...BOOTH_VOUCHER_SLIP_DEFAULTS, showStaff: false, footerText: ' Bye ' }),
    ).toEqual({ voucherShowStaff: false, voucherFooterText: 'Bye' });
  });

  it('refuses a bundle whose slip fields have the wrong type', () => {
    expect(
      BoothConfigBundleSchema.safeParse({
        ...historical,
        settings: { ...historical.settings, voucherShowLogo: 'no' },
      }).success,
    ).toBe(false);
  });

  it('trims texts and spells nothing as null', () => {
    expect(boothVoucherText('  Hello  ')).toBe('Hello');
    expect(boothVoucherText('   ')).toBeNull();
    expect(boothVoucherText(undefined)).toBeNull();
    expect(boothVoucherText(null)).toBeNull();
  });
});
