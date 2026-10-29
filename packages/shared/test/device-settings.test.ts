import { describe, expect, it } from 'vitest';
import { DeviceSettingsSchema, LABEL_SENSING, LabelDeviceSettingsSchema } from '../src/device-settings';

/**
 * The band printer's roll, as the unit's row describes it: how the printer
 * finds the next band, and where on a pre-printed band it may print.
 */

describe('LabelDeviceSettingsSchema sensing', () => {
  it('takes black-mark sensing, with the mark height in gapMm', () => {
    const parsed = LabelDeviceSettingsSchema.parse({ sensing: 'bline', gapMm: 3 });
    expect(parsed).toEqual({ sensing: 'bline', gapMm: 3 });
    expect(LABEL_SENSING).toEqual(['gap', 'bline']);
  });

  it('leaves sensing absent when it was not given: the profile default stands', () => {
    expect(LabelDeviceSettingsSchema.parse({ gapMm: 3 })).toEqual({ gapMm: 3 });
    expect(LabelDeviceSettingsSchema.parse({})).toEqual({});
  });

  it('refuses a sensing it does not know and a key it does not have', () => {
    expect(LabelDeviceSettingsSchema.safeParse({ sensing: 'mark' }).success).toBe(false);
    expect(LabelDeviceSettingsSchema.safeParse({ sensing: 'bline', blackMark: true }).success).toBe(false);
  });

  it('is read through the whole settings document', () => {
    const parsed = DeviceSettingsSchema.parse({ label: { sensing: 'bline', gapMm: 3, labelWidthMm: 25 } });
    expect(parsed.label?.sensing).toBe('bline');
    expect(DeviceSettingsSchema.safeParse({ label: { sensing: 'bline', blackMark: true } }).success).toBe(false);
  });
});

describe('LabelDeviceSettingsSchema print window', () => {
  it('takes a window that lies within the band', () => {
    const parsed = LabelDeviceSettingsSchema.parse({ labelHeightMm: 254, printOffsetMm: 60, printLengthMm: 120 });
    expect(parsed).toEqual({ labelHeightMm: 254, printOffsetMm: 60, printLengthMm: 120 });
    // The boundary is allowed: a window that ends exactly at the band's end.
    expect(
      LabelDeviceSettingsSchema.safeParse({ labelHeightMm: 254, printOffsetMm: 100, printLengthMm: 154 }).success,
    ).toBe(true);
  });

  it('refuses a window that runs past the end of the band, naming the length field', () => {
    const result = LabelDeviceSettingsSchema.safeParse({ labelHeightMm: 254, printOffsetMm: 200, printLengthMm: 100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['printLengthMm']);
      expect(result.error.issues[0]?.message).toMatch(/runs past the end of the band/);
    }
  });

  it('only checks the window against the band when all three are given', () => {
    expect(LabelDeviceSettingsSchema.safeParse({ printOffsetMm: 200, printLengthMm: 100 }).success).toBe(true);
    expect(LabelDeviceSettingsSchema.safeParse({ labelHeightMm: 254, printOffsetMm: 300 }).success).toBe(true);
    expect(LabelDeviceSettingsSchema.safeParse({ labelHeightMm: 254, printLengthMm: 300 }).success).toBe(true);
  });

  it('keeps each number in range on its own', () => {
    expect(LabelDeviceSettingsSchema.safeParse({ printOffsetMm: -1 }).success).toBe(false);
    expect(LabelDeviceSettingsSchema.safeParse({ printOffsetMm: 401 }).success).toBe(false);
    expect(LabelDeviceSettingsSchema.safeParse({ printLengthMm: 9 }).success).toBe(false);
    expect(LabelDeviceSettingsSchema.safeParse({ printLengthMm: 401 }).success).toBe(false);
    expect(LabelDeviceSettingsSchema.safeParse({ printOffsetMm: 0, printLengthMm: 10 }).success).toBe(true);
  });
});
