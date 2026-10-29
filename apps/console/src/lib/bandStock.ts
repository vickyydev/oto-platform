import type { LabelDeviceSettings, LabelSensing } from '@oto/shared';

/**
 * What the band-printer form edits of `settings.label`: how the printer finds
 * the next band, and where on a pre-printed band it may print.
 *
 * Null in a number is "not set", which the saved row expresses by leaving the
 * key out — the settings document has no null (`device-settings.ts`), and an
 * absent key means "use the profile's default" on the box.
 */
export interface BandStock {
  sensing: LabelSensing;
  /** The gap between labels, or with `bline` the black mark's height. */
  gapMm: number | null;
  printOffsetMm: number | null;
  printLengthMm: number | null;
}

/** The form's starting state from a row, or from nothing. */
export function bandStockOf(label: LabelDeviceSettings | null | undefined): BandStock {
  return {
    sensing: label?.sensing ?? 'gap',
    gapMm: label?.gapMm ?? null,
    printOffsetMm: label?.printOffsetMm ?? null,
    printLengthMm: label?.printLengthMm ?? null,
  };
}

/**
 * The row's label section with the form's answers written over it. Whatever
 * else the section holds — the language, the stock width, darkness, speed —
 * rides along untouched; a number the form left empty is dropped rather than
 * written as null.
 */
export function withBandStock(
  label: LabelDeviceSettings | null | undefined,
  stock: BandStock,
): LabelDeviceSettings {
  const next: LabelDeviceSettings = { ...(label ?? {}), sensing: stock.sensing };
  setOrDrop(next, 'gapMm', stock.gapMm);
  setOrDrop(next, 'printOffsetMm', stock.printOffsetMm);
  setOrDrop(next, 'printLengthMm', stock.printLengthMm);
  return next;
}

function setOrDrop(
  target: LabelDeviceSettings,
  key: 'gapMm' | 'printOffsetMm' | 'printLengthMm',
  value: number | null,
): void {
  if (value === null) delete target[key];
  else target[key] = value;
}

/** The field label for the `gapMm` number, which means a different measurement per sensing. */
export function gapFieldLabel(sensing: LabelSensing): string {
  return sensing === 'bline' ? 'Mark height (mm)' : 'Gap (mm)';
}

export const SENSING_OPTIONS: { value: LabelSensing; label: string }[] = [
  { value: 'gap', label: 'Gap between labels' },
  { value: 'bline', label: 'Black mark on the band' },
];
