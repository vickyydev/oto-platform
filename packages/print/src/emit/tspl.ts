/**
 * TSPL2 for the 4B-2082A wristband printers.
 *
 * TSPL2 rather than the family's ZPL emulation (open decision D1) for three
 * reasons that hold whatever the bench test says: it is the family manual's own
 * native language; the status and immediate commands — `ESC ! ?`, `~!T`,
 * `SET RESPONSE` — exist only in TSPL, and losing them loses paper-out
 * detection, which is an acceptance criterion; and the translators on clones
 * are lossy, so a ZPL `^GF` would put a second translation layer between our
 * bitmap and the head for nothing. The emitter is behind an interface so a
 * `zpl.ts` sibling can be added if the bench test finds TSPL quirks.
 *
 * Commands are cited to the TSC TSPL/TSPL2 manual as recorded in
 * `docs/architecture/DEVICE_INVENTORY.md` §9.1.
 */

import type { Bitmap1 } from '../raster/bitmap';
import type { DeviceProfile, Finish } from '../document';
import { concat } from './escpos';

/** TSPL accepts \r\n or \n; the manual's examples and our adapter use \r\n. */
const EOL = '\r\n';

const ESC = 0x1b;

export const TSPL = {
  /** `ESC ! ?` — one status byte, answered even in an error state. §9.1 */
  statusQuery: Uint8Array.from([ESC, 0x21, 0x3f]),
  /** `ESC ! S` — extended status, firmware >= V6.29 EZ. Unconfirmed here. */
  statusExtended: Uint8Array.from([ESC, 0x21, 0x53]),
  /** `~!T` — model name, e.g. "4B-2082A\r". §9.1 */
  identify: new TextEncoder().encode('~!T' + EOL),
  /** `ESC ! F` feed one label, `ESC ! .` cancel all printing. §9.1 */
  feedOne: Uint8Array.from([ESC, 0x21, 0x46]),
  cancelAll: Uint8Array.from([ESC, 0x21, 0x2e]),
  pause: Uint8Array.from([ESC, 0x21, 0x50]),
  resume: Uint8Array.from([ESC, 0x21, 0x4f]),
  /** `ESC ! R` — reset; deletes downloaded files. §9.1 */
  reset: Uint8Array.from([ESC, 0x21, 0x52]),
} as const;

export interface LabelStatus {
  ready: boolean;
  headOpen: boolean;
  paperJam: boolean;
  paperOut: boolean;
  ribbonOut: boolean;
  paused: boolean;
  printing: boolean;
  otherError: boolean;
}

/** Decode the single bit-OR'd byte `ESC ! ?` returns. §9.1 */
export function decodeLabelStatus(byte: number): LabelStatus {
  return {
    ready: byte === 0x00,
    headOpen: (byte & 0x01) !== 0,
    paperJam: (byte & 0x02) !== 0,
    paperOut: (byte & 0x04) !== 0,
    ribbonOut: (byte & 0x08) !== 0,
    paused: (byte & 0x10) !== 0,
    printing: (byte & 0x20) !== 0,
    otherError: (byte & 0x80) !== 0,
  };
}

/**
 * `BITMAP x,y,widthBytes,height,mode,<raw>`.
 *
 * Two things about this command bite. First, the polarity is the exact inverse
 * of ESC/POS `GS v 0`: in mode 0 a **0** bit prints black and a 1 bit leaves
 * the dot white, so every byte is inverted on the way out. (Flagged "verify on
 * site" in §9.1; the manual and an independent implementation agree, and the
 * first band off the real printer settles it — if it comes out as a
 * photographic negative, this is the one line to change.) Second, the raw bytes
 * follow the comma with no separator and no escaping, so the stream can contain
 * 0x0D and 0x0A: this builds bytes, never a string.
 */
export function bitmapCommand(bitmap: Bitmap1, x = 0, y = 0, mode = 0): Uint8Array {
  const header = new TextEncoder().encode(
    `BITMAP ${x},${y},${bitmap.stride},${bitmap.height},${mode},`,
  );
  const payload = new Uint8Array(bitmap.data.length);
  for (let i = 0; i < bitmap.data.length; i++) payload[i] = ~(bitmap.data[i] ?? 0) & 0xff;
  const tail = new TextEncoder().encode(EOL);
  return concat([header, payload, tail]);
}

export interface TsplJobOptions {
  device: DeviceProfile;
  finish: Finish;
}

/** Turn one rendered bitmap into a complete TSPL2 label job. */
export function emitTspl(bitmap: Bitmap1, options: TsplJobOptions): Uint8Array {
  const { device, finish } = options;
  if (bitmap.width > device.widthDots) {
    throw new Error(
      `bitmap is ${bitmap.width} dots wide but ${device.label} (${device.model}) prints ` +
        `${device.widthDots}`,
    );
  }
  const media = device.media;
  if (!media) {
    throw new Error(`${device.label} is a label printer but its profile carries no media size`);
  }

  const setup: string[] = [
    `SIZE ${media.widthMm} mm,${media.lengthMm} mm`,
    media.sensing === 'bline'
      ? `BLINE ${media.gapMm} mm,0 mm`
      : `GAP ${media.gapMm} mm,0 mm`,
    'DIRECTION 1',
    'REFERENCE 0,0',
    `DENSITY ${device.density ?? 10}`,
    `SPEED ${device.speed ?? 4}`,
    'SET TEAR ON',
  ];
  // Only when the profile says the firmware has it: `SET RESPONSE` is >= V7.09
  // and unconfirmed on these units. Whether to poll `ESC ! ?` instead is the
  // adapter's decision, not this package's — here we emit bytes and stop.
  if (device.perLabelAck) setup.push('SET RESPONSE ON');
  setup.push('CLS');

  const encoder = new TextEncoder();
  return concat([
    encoder.encode(setup.join(EOL) + EOL),
    bitmapCommand(bitmap),
    encoder.encode(`PRINT ${Math.max(1, finish.copies ?? 1)},1${EOL}`),
  ]);
}
