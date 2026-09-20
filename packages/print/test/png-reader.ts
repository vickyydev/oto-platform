/**
 * A minimal PNG reader, for tests only.
 *
 * The committed `.png` fixtures cannot be compared byte for byte: DEFLATE
 * output is not byte-specified, Node has shipped several zlib builds, and the
 * same bitmap legitimately compresses to different bytes on two machines. The
 * pixels do not vary, so the fixture test decodes and compares those.
 *
 * It also checks something byte equality never did: that the preview a viewer
 * is shown *is* the bitmap the head would print, dot for dot.
 */

import { inflateSync } from 'node:zlib';
import { Bitmap1 } from '../src/raster/bitmap';

interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode a 1-bit greyscale PNG back into the `Bitmap1` it was made from. */
export function decodePreviewPng(bytes: Uint8Array): Bitmap1 {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG: bad signature');
  }

  let ihdr: Ihdr | undefined;
  const idat: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      ihdr = {
        width: d.getUint32(0),
        height: d.getUint32(4),
        bitDepth: data[8] ?? 0,
        colourType: data[9] ?? 0,
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + length;
  }

  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.bitDepth !== 1 || ihdr.colourType !== 0) {
    throw new Error(`expected 1-bit greyscale, got depth ${ihdr.bitDepth} type ${ihdr.colourType}`);
  }

  const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of idat) {
    joined.set(part, offset);
    offset += part.length;
  }
  const raw = new Uint8Array(inflateSync(joined));

  const stride = (ihdr.width + 7) >> 3;
  const out = new Bitmap1(ihdr.width, ihdr.height);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start] ?? 0;
    for (let i = 0; i < stride; i++) {
      line[i] = unfilter(filter, raw[start + 1 + i] ?? 0, line[i - 1] ?? 0, prev[i] ?? 0, prev[i - 1] ?? 0);
    }
    // PNG greyscale: 0 is black. `Bitmap1`: a set bit is ink. Hence the invert,
    // which is the same one `previewPng` applies on the way out.
    for (let i = 0; i < stride; i++) out.data[y * stride + i] = ~(line[i] ?? 0) & 0xff;
    prev.set(line);
  }
  return out;
}

function unfilter(type: number, x: number, a: number, b: number, c: number): number {
  switch (type) {
    case 0:
      return x;
    case 1:
      return (x + a) & 0xff;
    case 2:
      return (x + b) & 0xff;
    case 3:
      return (x + ((a + b) >> 1)) & 0xff;
    case 4:
      return (x + paeth(a, b, c)) & 0xff;
    default:
      throw new Error(`unknown PNG filter ${type}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
