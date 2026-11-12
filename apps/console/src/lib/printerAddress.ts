import {
  PRINTER_ADDRESS_EXAMPLE,
  PRINTER_ADDRESS_HINT,
  isPrinterKind,
  printerAddressProblem,
  printerAddressWords,
} from '@oto/shared';
import type { Tone } from '@/components/Status';
import { toneForReachability } from '@/lib/fleetWords';

/**
 * SCRUM-899 — THE CONSOLE ASKS FOR A PRINTER'S ADDRESS.
 *
 * A printer saved with no address took a till's print jobs and the box skipped
 * every one `DEVICE_NO_ADDRESS`, so nothing came out. The rule itself — the
 * forms the box prints to — is `printerAddressProblem` in `@oto/shared`, the
 * one the api refuses with; these are the words and the hold-backs the device
 * forms, the box's device list and the station drawer draw from it.
 */

/** What a form's Address field says under it, how loudly, and whether it holds the form back. */
export interface AddressField {
  hint: string;
  tone: 'plain' | 'warn' | 'down';
  blocks: boolean;
}

/**
 * The Address field's hint before this ticket, for every device that is not a
 * printer — its network example nobody's address since SCRUM-932.
 */
const OTHER_DEVICE_HINT = `For example ${PRINTER_ADDRESS_EXAMPLE}, or /dev/ttyACM0.`;

/**
 * SCRUM-932 — the Add a device form's grey Address placeholder. It read
 * "192.168.88.204:9100", the park's kids band printer, as if already filled
 * in; it is an example, and says so.
 */
export const ADDRESS_PLACEHOLDER = `e.g. ${PRINTER_ADDRESS_EXAMPLE}`;

/**
 * SCRUM-932 — a printer with no address cannot be healthy, whatever the box
 * last said about its reachability or its paper: nothing is ever sent to it.
 * The device list shows it as not set up, in the "down" tone its
 * `NO_ADDRESS_LINE` is written in, instead of a green dot and "paper ok".
 */
export const NOT_SET_UP = 'not set up';

/** Adding a device: a printer cannot be added without an address the box can open. */
export function newDeviceAddress(kind: string, address: string): AddressField {
  if (!isPrinterKind(kind)) return { hint: OTHER_DEVICE_HINT, tone: 'plain', blocks: false };
  const problem = printerAddressProblem(address);
  if (problem === 'missing') return { hint: `Required for a printer. ${PRINTER_ADDRESS_HINT}`, tone: 'down', blocks: true };
  if (problem === 'invalid') return { hint: printerAddressWords(problem), tone: 'down', blocks: true };
  return { hint: PRINTER_ADDRESS_HINT, tone: 'plain', blocks: false };
}

/**
 * Editing one: only a CHANGED address is judged, as the api judges it, so a
 * printer saved without one before this rule still renames and archives — and
 * is told, without being held back, that nothing prints on it until it has one.
 */
export function editedDeviceAddress(device: { kind: string; address?: string | null }, address: string): AddressField {
  if (!isPrinterKind(device.kind)) return { hint: '', tone: 'plain', blocks: false };
  const changed = address.trim() !== (device.address ?? '').trim();
  if (changed) {
    const problem = printerAddressProblem(address);
    if (problem) return { hint: printerAddressWords(problem), tone: 'down', blocks: true };
    return { hint: PRINTER_ADDRESS_HINT, tone: 'plain', blocks: false };
  }
  if (!device.address?.trim()) {
    return { hint: `No address yet, so nothing prints on it. ${PRINTER_ADDRESS_HINT}`, tone: 'warn', blocks: false };
  }
  return { hint: PRINTER_ADDRESS_HINT, tone: 'plain', blocks: false };
}

/** A printer the box cannot print to, because it has no address: not to be given a job. */
export function printerWithoutAddress(device: { kind: string; address?: string | null }): boolean {
  return isPrinterKind(device.kind) && !device.address?.trim();
}

/** The line under such a printer in the box's device list, in place of the box's bare `DEVICE_NO_ADDRESS`. */
export const NO_ADDRESS_LINE = 'No address, so nothing prints on it. Edit it and enter the address the box prints to.';

/**
 * SCRUM-932 — the dot a device's row draws: its reachability, except that a
 * printer without an address is never "Healthy" (`NOT_SET_UP`).
 */
export function deviceDotTone(device: { kind: string; address?: string | null; reachability?: string | null }): Tone {
  return printerWithoutAddress(device) ? 'down' : toneForReachability(device.reachability);
}

/** The colour each tone is drawn in, as the station drawer draws its own warnings. */
export const toneColor = (tone: AddressField['tone']): string | undefined =>
  tone === 'down' ? 'hsl(var(--status-down))' : tone === 'warn' ? 'hsl(var(--status-warn))' : undefined;
