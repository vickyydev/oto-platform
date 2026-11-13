import { SETTINGS_SECTION_FOR_KIND, type DeviceSettings, type EscposDotsPerLine } from '@oto/shared';
import type { DeviceRow } from '@/api/fleet';
import { bandStockOf, withBandStock, type BandStock } from '@/lib/bandStock';
import { scannerSetupOf, withScannerSetup, type ScannerSetup } from '@/lib/scannerSetup';

/**
 * SCRUM-971 — THE CONSOLE SAVES ONLY WHAT WAS CHANGED ON A DEVICE.
 *
 * The Edit form sent every field on every save, settings included: a printer
 * whose row has no settings was written `{"escpos":{"dotsPerLine":576}}` or
 * `{"label":{"sensing":"gap"}}` — the defaults the form SHOWS for a row with
 * none — whenever anybody saved it, even when only its address had changed
 * (SCRUM-952 proof, step 5). A row with no settings follows the box's profile
 * for its model; a written default does not, and nobody chose it.
 *
 * So a save sends a field only when the form's value differs from the row's,
 * and a settings section only when something in it was changed. An untouched
 * form sends nothing at all. The form still shows the box's defaults for a row
 * without settings; they are only not written back.
 */

/** What the Edit form holds, as it holds it. */
export interface DeviceEditForm {
  label: string;
  address: string;
  model: string;
  protocol: string;
  terminalId: string;
  merchantId: string;
  dotsPerLine: EscposDotsPerLine;
  bandStock: BandStock;
  scanner: ScannerSetup;
}

/** The PATCH body: only what changed. Left out keeps what the row has. */
export interface DeviceEdits {
  label?: string;
  address?: string | null;
  model?: string | null;
  protocol?: string | null;
  terminalId?: string | null;
  merchantId?: string | null;
  settings?: DeviceSettings;
}

/** The paper width an ESC/POS printer's form shows when its row names none: the box's own default. */
export const DEFAULT_DOTS_PER_LINE: EscposDotsPerLine = 576;

/** The form as it opens on this row. */
export function deviceEditFormOf(device: DeviceRow): DeviceEditForm {
  return {
    label: device.label,
    address: device.address ?? '',
    model: device.model ?? '',
    protocol: device.protocol ?? '',
    terminalId: device.terminalId ?? '',
    merchantId: device.merchantId ?? '',
    dotsPerLine: device.settings?.escpos?.dotsPerLine ?? DEFAULT_DOTS_PER_LINE,
    bandStock: bandStockOf(device.settings?.label),
    scanner: scannerSetupOf(device.settings?.scanner, device.transport),
  };
}

const sameBandStock = (a: BandStock, b: BandStock): boolean =>
  a.sensing === b.sensing && a.gapMm === b.gapMm && a.printOffsetMm === b.printOffsetMm && a.printLengthMm === b.printLengthMm;

const sameScanner = (a: ScannerSetup, b: ScannerSetup): boolean =>
  a.mode === b.mode &&
  a.vendorId.trim().toLowerCase() === b.vendorId.trim().toLowerCase() &&
  a.productId.trim().toLowerCase() === b.productId.trim().toLowerCase() &&
  a.devicePath.trim() === b.devicePath.trim();

/**
 * What a save sends: each text field whose trimmed value differs from the
 * row's, as the form sent it before (blank is null), and the settings section
 * of this kind of device only when it was changed — written over the row's
 * settings, so whatever else they hold rides along untouched.
 */
export function deviceEdits(device: DeviceRow, form: DeviceEditForm): DeviceEdits {
  const was = deviceEditFormOf(device);
  const edits: DeviceEdits = {};
  if (form.label.trim() !== was.label.trim()) edits.label = form.label.trim();
  for (const key of ['address', 'model', 'protocol', 'terminalId', 'merchantId'] as const) {
    if (form[key].trim() !== was[key].trim()) edits[key] = form[key].trim() || null;
  }

  const settings = device.settings ?? {};
  const section = SETTINGS_SECTION_FOR_KIND[device.kind];
  if (section === 'escpos' && form.dotsPerLine !== was.dotsPerLine) {
    edits.settings = { ...settings, escpos: { ...(settings.escpos ?? {}), dotsPerLine: form.dotsPerLine } };
  } else if (section === 'label' && !sameBandStock(form.bandStock, was.bandStock)) {
    edits.settings = { ...settings, label: withBandStock(settings.label, form.bandStock) };
  } else if (section === 'scanner' && !sameScanner(form.scanner, was.scanner)) {
    edits.settings = { ...settings, scanner: withScannerSetup(settings.scanner, form.scanner) };
  }
  return edits;
}

/** Whether a save has anything to send. */
export const hasEdits = (edits: DeviceEdits): boolean => Object.keys(edits).length > 0;
