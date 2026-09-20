/**
 * PNG preview — the same bitmap the head prints, wrapped for a screen.
 *
 * The admin panel and the printer simulator both display this. They do not
 * re-draw anything: there is one renderer, and this is a 30-line container
 * around its output. The corollary is easy to get wrong, so it is worth saying
 * plainly — the preview must be rendered for the *device the test print will go
 * to*. Previewing a receipt at 576 dots and printing it to a 512-dot XP-80
 * produces exactly the receipt nobody can read.
 *
 * Two constraints follow from this file and both belong to the rest of S2-06:
 *
 *  1. **`node:zlib` means Node only.** The admin console cannot call this; it
 *     fetches the PNG from the API or the box. See `README.md`.
 *  2. **The compressed bytes are not part of any contract.** DEFLATE output is
 *     not byte-specified and Node has shipped different zlib builds, so the
 *     same bitmap can produce two different valid PNGs on two machines. The
 *     *pixels* are reproducible and the device bytes are reproducible; the
 *     IDAT payload is not. `fixtures.test.ts` therefore decodes the committed
 *     PNG and compares pixels, never bytes.
 */

import { deflateSync } from 'node:zlib';
import type { Bitmap1 } from '../raster/bitmap';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A 1-bit greyscale PNG. In PNG greyscale a 0 bit is black and a 1 bit is
 * white, the opposite of `Bitmap1` where a set bit is ink, so rows are
 * inverted on the way out.
 */
export function previewPng(bitmap: Bitmap1): Uint8Array {
  const raw = new Uint8Array((bitmap.stride + 1) * bitmap.height);
  for (let y = 0; y < bitmap.height; y++) {
    const at = y * (bitmap.stride + 1);
    raw[at] = 0; // filter: None
    for (let b = 0; b < bitmap.stride; b++) {
      raw[at + 1 + b] = ~(bitmap.data[y * bitmap.stride + b] ?? 0) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, bitmap.width);
  view.setUint32(4, bitmap.height);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = deflateSync(raw, { level: 9 });
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(idat.buffer, idat.byteOffset, idat.byteLength)),
    chunk('IEND', new Uint8Array(0)),
  ];
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
