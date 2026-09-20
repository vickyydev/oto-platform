/**
 * ESC/POS for the Welltech G4 (Xprinter XP-C260 family) and the XP-80 family.
 *
 * Every byte sequence below is cited to the Xprinter 80XX programmer manual as
 * recorded in `docs/architecture/DEVICE_INVENTORY.md` §9.3 and §9.4, so a later
 * reader can check it against the manual rather than against our own output.
 *
 * Text is never sent as characters. There is no Thai code page on this
 * hardware — the published lists for both families omit it — and even with
 * TIS-620 a single-byte page has one glyph per byte and no substitution table,
 * so Thai tone marks would collide with the vowels they sit above. The host
 * shapes and rasterises; the printer receives dots. Chinese and Cyrillic follow
 * the same path, which leaves one text path with one failure mode instead of
 * three.
 */

import type { Bitmap1 } from '../raster/bitmap';
import type { DeviceProfile, Finish } from '../document';

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;

/** Default `GS v 0` slice height. See `bandRows` on the device profile. */
export const DEFAULT_BAND_ROWS = 128;

/** Feed before the cut when the finish does not say: 4 lines' worth of paper. */
export const DEFAULT_FEED_DOTS = 135;

export const ESCPOS = {
  /** `ESC @` — reset modes and clear the print buffer. §9.3 */
  initialise: Uint8Array.from([ESC, 0x40]),
  /**
   * `ESC = 1` — select the printer. While deselected the unit ignores
   * everything except `DLE EOT`, `ENQ` and `DC4`, so a stray deselect from a
   * previous job would swallow this one silently. §9.3
   */
  selectPrinter: Uint8Array.from([ESC, 0x3d, 0x01]),
  /** `ESC 3 0` — line spacing 0, so raster bands butt together. */
  lineSpacingZero: Uint8Array.from([ESC, 0x33, 0x00]),
  /** `ESC 2` — back to the default 1/6 inch line spacing. */
  lineSpacingDefault: Uint8Array.from([ESC, 0x32]),
  /**
   * `GS V 66 0` — feed to the cut position, then partial cut.
   * The manual is explicit that only a partial cut exists on this hardware;
   * `GS V 0` ("full cut") must never be offered. §9.3
   */
  partialCut: Uint8Array.from([GS, 0x56, 0x42, 0x00]),
  /** `DLE ENQ 1` / `DLE ENQ 2` — recover after an auto-cutter error. §9.3 */
  recoverAndRetry: Uint8Array.from([DLE, 0x05, 0x01]),
  recoverAfterClear: Uint8Array.from([DLE, 0x05, 0x02]),
  /** BEL. Some kitchen firmwares beep; unconfirmed on these units. §9.4 */
  bell: Uint8Array.from([0x07]),
} as const;

/** `ESC d n` — feed n lines. §9.3 lists it among the commands these units take. */
export function feedLines(n: number): Uint8Array {
  return Uint8Array.from([ESC, 0x64, Math.max(0, Math.min(255, Math.round(n)))]);
}

/**
 * `ESC J n` — feed n dots. Clears the blade, which sits above the head.
 *
 * This is what `Finish.feedDots` means and `ESC d` is not it: `ESC d` feeds
 * *lines*, and a line at the default 1/6 inch spacing is about 33.8 dots at
 * 203 dpi, so `feedDots: 96` came out as 4 lines and roughly 135 dots. The
 * blade clears either way, which is exactly why it went unnoticed; the field's
 * name is a promise and this keeps it.
 *
 * `ESC J` takes one byte, so a longer feed is several commands. The vertical
 * motion unit on this hardware is one dot; if a unit ever turns out to differ,
 * this is the single place that changes.
 *
 * Note for the simulator: §9.3's "must reproduce" command list names `ESC d`
 * and not `ESC J`. `ESC J` is standard ESC/POS and the manual for the XP-80
 * family carries it, but it is **[unconfirmed]** on the units in the park, so
 * the bench check should print a known feed and measure it — and the
 * simulator's parser must accept `ESC J` as well as `ESC d`.
 */
export function feedDots(n: number): Uint8Array {
  const total = Math.max(0, Math.round(n));
  const parts: Uint8Array[] = [];
  for (let left = total; left > 0; left -= 255) {
    parts.push(Uint8Array.from([ESC, 0x4a, Math.min(255, left)]));
  }
  return concat(parts);
}

/**
 * `ESC p m t1 t2` — cash drawer kick.
 *
 * m = 0/48 is drawer pin 2 and 1/49 is pin 5; on-time is `t1 x 2 ms` and
 * off-time `t2 x 2 ms`, and if t2 < t1 the off-time becomes `t1 x 2 ms`. The
 * park's drawer is 24 V / 1 A on RJ11. §9.3
 */
export function drawerKick(pin: 0 | 1, onMs: number, offMs: number): Uint8Array {
  const clamp = (ms: number) => Math.max(0, Math.min(255, Math.round(ms / 2)));
  return Uint8Array.from([ESC, 0x70, pin, clamp(onMs), clamp(offMs)]);
}

/** `DLE EOT n`, n = 1..4 — answered even off-line or mid-error. §9.3 */
export function statusQuery(n: 1 | 2 | 3 | 4): Uint8Array {
  return Uint8Array.from([DLE, 0x04, n]);
}

export interface PrinterStatus {
  offline?: boolean;
  drawerOpen?: boolean;
  coverOpen?: boolean;
  paperEnd?: boolean;
  paperNearEnd?: boolean;
  error?: boolean;
  cutterError?: boolean;
  unrecoverableError?: boolean;
}

/**
 * Decode one `DLE EOT n` reply byte.
 *
 * Bits 1 and 4 are always set and bits 0 and 7 always clear, so an idle n=1
 * reply is 0x12. A byte that does not match that frame is not a status byte —
 * usually it is the tail of some other reply — and is reported as such. §9.3
 */
export function decodeStatus(n: 1 | 2 | 3 | 4, byte: number): PrinterStatus {
  if ((byte & 0x93) !== 0x12) {
    throw new Error(
      `0x${byte.toString(16).padStart(2, '0')} is not a DLE EOT reply ` +
        `(bits 1 and 4 must be set, bits 0 and 7 clear)`,
    );
  }
  switch (n) {
    case 1:
      return { drawerOpen: (byte & 0x04) !== 0, offline: (byte & 0x08) !== 0 };
    case 2:
      return {
        coverOpen: (byte & 0x04) !== 0,
        paperEnd: (byte & 0x20) !== 0,
        error: (byte & 0x40) !== 0,
      };
    case 3:
      return {
        cutterError: (byte & 0x08) !== 0,
        unrecoverableError: (byte & 0x20) !== 0,
        error: (byte & 0x40) !== 0,
      };
    case 4:
      return {
        paperNearEnd: (byte & 0x0c) === 0x0c,
        paperEnd: (byte & 0x60) === 0x60,
      };
  }
}

/**
 * `GS v 0 m xL xH yL yH d1..dk` — print raster bit image.
 *
 * m = 0 (no scaling; the bitmap is already at device resolution), width in
 * bytes, height in dots, a set bit prints a black dot, MSB first. That is
 * `Bitmap1`'s own layout, so this is a slice rather than a conversion.
 *
 * The standard-mode restriction matters: data exceeding one line of the print
 * area is **silently ignored**. That is why `widthDots` is a property of the
 * device and never of the template — a 576-dot layout on a 512-dot unit loses
 * its right-hand 8 mm, price column included, with nothing in any log. §9.3
 */
export function rasterBand(band: Bitmap1): Uint8Array {
  const widthBytes = band.stride;
  const height = band.height;
  const header = Uint8Array.from([
    GS,
    0x76,
    0x30,
    0x00,
    widthBytes & 0xff,
    (widthBytes >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
  ]);
  const out = new Uint8Array(header.length + band.data.length);
  out.set(header);
  out.set(band.data, header.length);
  return out;
}

export interface EscposJobOptions {
  finish: Finish;
  device: DeviceProfile;
}

/** Turn one rendered bitmap into a complete, self-contained ESC/POS job. */
export function emitEscpos(bitmap: Bitmap1, options: EscposJobOptions): Uint8Array {
  const { device, finish } = options;
  if (bitmap.width > device.widthDots) {
    throw new Error(
      `bitmap is ${bitmap.width} dots wide but ${device.label} (${device.model}) prints ` +
        `${device.widthDots}; GS v 0 would discard the overflow without an error`,
    );
  }
  const parts: Uint8Array[] = [
    ESCPOS.initialise,
    ESCPOS.selectPrinter,
    ESCPOS.lineSpacingZero,
  ];

  // Band the image so one write stays well inside the input buffer (128 KB on
  // the G4, 64 or 256 KB across the XP-80 family). Slicing GS v 0 is the
  // established practice for these units; the exact ceiling per unit is
  // unconfirmed, which is why this is a device parameter and not a constant.
  const bandRows = Math.max(1, device.bandRows ?? DEFAULT_BAND_ROWS);
  for (let top = 0; top < bitmap.height; top += bandRows) {
    const rows = Math.min(bandRows, bitmap.height - top);
    parts.push(rasterBand(bitmap.slice(top, rows)));
  }

  parts.push(ESCPOS.lineSpacingDefault);
  // 135 dots is the default 4 lines at 1/6 inch on a 203 dpi head — the same
  // paper this used to feed, now said in the unit the field is named for.
  parts.push(feedDots(finish.feedDots ?? DEFAULT_FEED_DOTS));

  // The kick goes before the cut so a cutter error cannot swallow it. Nothing
  // in the prototype or the device notes settles this; see the report.
  if (finish.drawerKick && device.hasDrawer !== false) {
    parts.push(
      drawerKick(finish.drawerKick.pin, finish.drawerKick.onMs, finish.drawerKick.offMs),
    );
  }
  if (finish.cut === 'partial' && device.hasCutter !== false) parts.push(ESCPOS.partialCut);

  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
