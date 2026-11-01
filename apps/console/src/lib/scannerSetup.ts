import {
  SCANNER_USB_DEFAULTS,
  type ScannerDeviceSettings,
  type ScannerMode,
} from '@oto/shared';
import type { Tone } from '@/components/Status';

/**
 * What the scanner form edits of `settings.scanner` (SCRUM-700): how the box
 * reads the cradle, which USB device it is, and — rarely — where it is.
 *
 * The ids and the path are strings, empty meaning "not set": the saved row
 * expresses that by leaving the key out, and the box then uses the park's
 * Zebra cradle (`SCANNER_USB_DEFAULTS`) and finds the node itself.
 */
export interface ScannerSetup {
  mode: ScannerMode;
  vendorId: string;
  productId: string;
  devicePath: string;
}

export const SCANNER_MODE_OPTIONS: { value: ScannerMode; label: string }[] = [
  { value: 'hid', label: 'USB keyboard (HID) — the cradle as it ships' },
  { value: 'cdc', label: 'USB serial (CDC) — after scanning the CDC bar code' },
];

/** The transport a scanner in this mode is reached over, for a new row. */
export function transportForScannerMode(mode: ScannerMode): 'usb' | 'serial' {
  return mode === 'cdc' ? 'serial' : 'usb';
}

/**
 * The form's starting state from a row, or from nothing. A row that names no
 * mode reads by its transport, as the box does: `serial` is CDC, anything
 * else HID.
 */
export function scannerSetupOf(
  scanner: ScannerDeviceSettings | null | undefined,
  transport?: string | null,
): ScannerSetup {
  return {
    mode: scanner?.mode ?? (transport === 'serial' ? 'cdc' : 'hid'),
    vendorId: scanner?.vendorId ?? '',
    productId: scanner?.productId ?? '',
    devicePath: scanner?.devicePath ?? '',
  };
}

/** The ids the box uses for this mode when the form leaves them empty. */
export function scannerDefaultIds(mode: ScannerMode): { vendorId: string; productId: string } {
  return { vendorId: SCANNER_USB_DEFAULTS.vendorId, productId: SCANNER_USB_DEFAULTS.productId[mode] };
}

/**
 * The row's scanner section with the form's answers written over it. The
 * suffix, the burst gap and the button key — which this form does not edit —
 * ride along untouched; an empty field is dropped rather than written.
 */
export function withScannerSetup(
  scanner: ScannerDeviceSettings | null | undefined,
  setup: ScannerSetup,
): ScannerDeviceSettings {
  const next: ScannerDeviceSettings = { ...(scanner ?? {}), mode: setup.mode };
  const vendorId = setup.vendorId.trim().toLowerCase();
  const productId = setup.productId.trim().toLowerCase();
  const devicePath = setup.devicePath.trim();
  if (vendorId) next.vendorId = vendorId;
  else delete next.vendorId;
  if (productId) next.productId = productId;
  else delete next.productId;
  if (devicePath) next.devicePath = devicePath;
  else delete next.devicePath;
  return next;
}

/** Why the form cannot be saved as it stands, in words, or null. */
export function scannerSetupProblem(setup: ScannerSetup): string | null {
  for (const [name, value] of [
    ['vendor id', setup.vendorId],
    ['product id', setup.productId],
  ] as const) {
    const v = value.trim();
    if (v && !/^[0-9a-fA-F]{4}$/.test(v)) return `The ${name} is four hex digits, such as 05e0.`;
  }
  const path = setup.devicePath.trim();
  if (path && !path.startsWith('/dev/')) return 'The path is a device on the box, under /dev/.';
  return null;
}

/** What the box last said about one scanner it reads (`ScannerHealth` on the heartbeat). */
export interface ScannerHealthView {
  mode: ScannerMode;
  present: boolean;
  open: boolean;
  path: string | null;
  lastScanAt: string | null;
  scans: number | null;
  dropped: number | null;
}

/**
 * The scanner block the box's newest heartbeat carried for this device, read
 * defensively out of `last_status` the way the box's other vitals are. Null
 * when there is none: an older agent, a simulated scanner, or a box that does
 * not read this one itself.
 */
export function scannerHealthOf(
  lastStatus: Record<string, unknown> | null | undefined,
  deviceId: string,
): ScannerHealthView | null {
  const devices = lastStatus?.devices;
  if (!Array.isArray(devices)) return null;
  const entry = devices.find(
    (d): d is Record<string, unknown> =>
      typeof d === 'object' && d !== null && (d as Record<string, unknown>).id === deviceId,
  );
  const block = entry?.scanner;
  if (typeof block !== 'object' || block === null) return null;
  const b = block as Record<string, unknown>;
  if (typeof b.present !== 'boolean' || typeof b.open !== 'boolean') return null;
  return {
    mode: b.mode === 'cdc' ? 'cdc' : 'hid',
    present: b.present,
    open: b.open,
    path: typeof b.path === 'string' ? b.path : null,
    lastScanAt: typeof b.lastScanAt === 'string' ? b.lastScanAt : null,
    scans: typeof b.scans === 'number' ? b.scans : null,
    dropped: typeof b.dropped === 'number' ? b.dropped : null,
  };
}

/**
 * The scanner's line on the device panel: the state as a person says it, and
 * its colour. "Reading /dev/input/event4", "Plugged in at /dev/ttyACM0 but not
 * open", "Not plugged into this box". The last scan and its age are shown
 * beside it by the panel.
 */
export function scannerHealthWords(health: ScannerHealthView): { words: string; tone: Tone } {
  if (health.open) {
    return { words: `Reading ${health.path ?? 'the scanner'}`, tone: 'ok' };
  }
  if (health.present) {
    return {
      words: `Plugged in${health.path ? ` at ${health.path}` : ''} but not open`,
      tone: 'down',
    };
  }
  return { words: 'Not plugged into this box', tone: 'down' };
}
