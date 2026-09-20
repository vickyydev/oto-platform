/**
 * A minimal ESC/POS reader, for tests only.
 *
 * It closes the transport half of the loop: `emit.test.ts` parses the emitted
 * bytes back into a bitmap with this and asserts it is identical to what
 * `render()` produced, so the emitters provably carry the rendered dots and
 * nothing else. It does **not** prove there is only one renderer — a second
 * drawing path would leave every test here green. That claim is enforced
 * structurally by `single-renderer.test.ts`.
 *
 * It is also the shape the S2-06 printer simulator's parser needs, so it is
 * written to be lifted. Note `ESC J` below: the simulator's command list in
 * DEVICE_INVENTORY §9.3 names `ESC d` only, and the emitter sends `ESC J`
 * because `Finish.feedDots` is dots.
 */

import { Bitmap1 } from '../src/raster/bitmap';

export interface ParsedEscpos {
  bitmap: Bitmap1;
  bands: number;
  initialised: boolean;
  cuts: number;
  drawerKicks: { pin: number; onMs: number; offMs: number }[];
  /** `ESC d n` — lines fed. */
  feeds: number[];
  /** `ESC J n` — dots fed, one entry per command. */
  dotFeeds: number[];
  /** Any byte sequence the reader did not recognise, as hex. */
  unknown: string[];
}

export function parseEscpos(bytes: Uint8Array, widthDots: number): ParsedEscpos {
  const rows: Uint8Array[] = [];
  const stride = (widthDots + 7) >> 3;
  const out: ParsedEscpos = {
    bitmap: new Bitmap1(widthDots, 0),
    bands: 0,
    initialised: false,
    cuts: 0,
    drawerKicks: [],
    feeds: [],
    dotFeeds: [],
    unknown: [],
  };

  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x1b) {
      const n = bytes[i + 1];
      if (n === 0x40) {
        out.initialised = true;
        i += 2;
      } else if (n === 0x3d) i += 3; // ESC = n, select printer
      else if (n === 0x33) i += 3; // ESC 3 n, line spacing
      else if (n === 0x32) i += 2; // ESC 2, default line spacing
      else if (n === 0x64) {
        out.feeds.push(bytes[i + 2] ?? 0);
        i += 3;
      } else if (n === 0x4a) {
        out.dotFeeds.push(bytes[i + 2] ?? 0);
        i += 3;
      } else if (n === 0x70) {
        out.drawerKicks.push({
          pin: bytes[i + 2] ?? 0,
          onMs: (bytes[i + 3] ?? 0) * 2,
          offMs: (bytes[i + 4] ?? 0) * 2,
        });
        i += 5;
      } else {
        out.unknown.push(hex(bytes, i, 3));
        i += 2;
      }
      continue;
    }
    if (b === 0x1d) {
      const n = bytes[i + 1];
      if (n === 0x56) {
        // GS V 66 n (feed then partial cut) or GS V m.
        out.cuts++;
        i += bytes[i + 2] === 0x42 ? 4 : 3;
        continue;
      }
      if (n === 0x76 && bytes[i + 2] === 0x30) {
        const widthBytes = (bytes[i + 4] ?? 0) | ((bytes[i + 5] ?? 0) << 8);
        const height = (bytes[i + 6] ?? 0) | ((bytes[i + 7] ?? 0) << 8);
        const start = i + 8;
        const length = widthBytes * height;
        if (widthBytes !== stride) {
          throw new Error(`band is ${widthBytes} bytes wide, expected ${stride}`);
        }
        rows.push(bytes.subarray(start, start + length));
        out.bands++;
        i = start + length;
        continue;
      }
      out.unknown.push(hex(bytes, i, 3));
      i += 2;
      continue;
    }
    out.unknown.push(hex(bytes, i, 1));
    i += 1;
  }

  let totalRows = 0;
  for (const band of rows) totalRows += band.length / stride;
  const bitmap = new Bitmap1(widthDots, totalRows);
  let at = 0;
  for (const band of rows) {
    bitmap.data.set(band, at);
    at += band.length;
  }
  out.bitmap = bitmap;
  return out;
}

function hex(bytes: Uint8Array, at: number, n: number): string {
  return [...bytes.subarray(at, at + n)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/** Pull the `BITMAP` payload out of a TSPL job and undo its polarity. */
export function parseTsplBitmap(bytes: Uint8Array, widthDots: number): Bitmap1 {
  const marker = new TextEncoder().encode('BITMAP ');
  let at = -1;
  outer: for (let i = 0; i + marker.length < bytes.length; i++) {
    for (let k = 0; k < marker.length; k++) if (bytes[i + k] !== marker[k]) continue outer;
    at = i;
    break;
  }
  if (at < 0) throw new Error('no BITMAP command in the job');
  let comma = at + marker.length;
  const fields: number[] = [];
  let current = '';
  while (fields.length < 5) {
    const ch = String.fromCharCode(bytes[comma] ?? 0);
    comma++;
    if (ch === ',') {
      fields.push(Number(current));
      current = '';
    } else current += ch;
  }
  const [, , widthBytes = 0, height = 0] = fields;
  const stride = (widthDots + 7) >> 3;
  if (widthBytes !== stride) throw new Error(`BITMAP is ${widthBytes} bytes wide, expected ${stride}`);
  const bitmap = new Bitmap1(widthDots, height);
  for (let i = 0; i < widthBytes * height; i++) {
    bitmap.data[i] = ~(bytes[comma + i] ?? 0) & 0xff;
  }
  return bitmap;
}

/** The TSPL setup lines that precede the bitmap, as text. */
export function tsplSetupLines(bytes: Uint8Array): string[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const upTo = text.indexOf('BITMAP ');
  return text
    .slice(0, upTo < 0 ? undefined : upTo)
    .split('\r\n')
    .filter((line) => line.length > 0);
}
