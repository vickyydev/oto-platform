/**
 * Instancing a variable font at one weight, for the subsetter.
 *
 * Needed because the only Noto Sans SC that Google publishes is
 * `NotoSansSC[wght].ttf`, whose **default instance is wght 100** — Thin. Its
 * `glyf` outlines are therefore Thin, and Thin Chinese at 22 dots on a thermal
 * head comes out faint and broken next to the Latin and Thai around it. So the
 * subsetter applies the `gvar` deltas for wght 400 and writes out real Regular
 * outlines.
 *
 * Build-time only: nothing here runs on a box. Simple glyphs only, which is all
 * the subset repertoire contains — a composite would need the component-point
 * form of the same tables and there is no reason to carry code nothing calls.
 */

import { Reader } from '../src/fonts/sfnt';
import type { SfntFont } from '../src/fonts/sfnt';

export interface Point {
  x: number;
  y: number;
  on: boolean;
}

export interface SimpleGlyph {
  endPts: number[];
  points: Point[];
}

/** Decode a simple `glyf` record into points, keeping contour ends. */
export function readSimpleGlyph(bytes: Uint8Array): SimpleGlyph | undefined {
  if (bytes.length < 10) return { endPts: [], points: [] };
  const r = new Reader(bytes);
  const numberOfContours = r.i16();
  if (numberOfContours < 0) return undefined; // composite
  r.pos = 10;
  const endPts: number[] = [];
  for (let i = 0; i < numberOfContours; i++) endPts.push(r.u16());
  const numPoints = numberOfContours === 0 ? 0 : (endPts[numberOfContours - 1] ?? -1) + 1;
  // Read the length before advancing: `r.pos += r.u16()` would evaluate the
  // old `r.pos` first and lose the two bytes the length itself occupies.
  const instructionLength = r.u16();
  r.pos += instructionLength;

  const flags = new Uint8Array(numPoints);
  for (let i = 0; i < numPoints; ) {
    const f = r.u8();
    flags[i++] = f;
    if (f & 0x08) {
      let repeat = r.u8();
      while (repeat-- > 0 && i < numPoints) flags[i++] = f;
    }
  }
  const points: Point[] = [];
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i] ?? 0;
    if (f & 0x02) x += (f & 0x10 ? 1 : -1) * r.u8();
    else if (!(f & 0x10)) x += r.i16();
    points.push({ x, y: 0, on: (f & 0x01) !== 0 });
  }
  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i] ?? 0;
    if (f & 0x04) y += (f & 0x20 ? 1 : -1) * r.u8();
    else if (!(f & 0x20)) y += r.i16();
    const p = points[i];
    if (p) p.y = y;
  }
  return { endPts, points };
}

/**
 * Re-encode a simple glyph.
 *
 * Deliberately without the flag-repeat and short-coordinate compressions: this
 * runs on a few dozen glyphs at build time, and the uncompressed form is one
 * fewer thing to get wrong in a file nothing else can check.
 */
export function writeSimpleGlyph(glyph: SimpleGlyph): Uint8Array {
  const { endPts, points } = glyph;
  if (points.length === 0) return new Uint8Array(0);
  const size = 10 + endPts.length * 2 + 2 + points.length * 5;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  v.setInt16(0, endPts.length);
  v.setInt16(2, Math.min(...xs));
  v.setInt16(4, Math.min(...ys));
  v.setInt16(6, Math.max(...xs));
  v.setInt16(8, Math.max(...ys));
  let at = 10;
  for (const end of endPts) {
    v.setUint16(at, end);
    at += 2;
  }
  v.setUint16(at, 0); // no instructions
  at += 2;
  for (const p of points) out[at++] = p.on ? 0x01 : 0x00;
  let prev = 0;
  for (const p of points) {
    v.setInt16(at, p.x - prev);
    prev = p.x;
    at += 2;
  }
  prev = 0;
  for (const p of points) {
    v.setInt16(at, p.y - prev);
    prev = p.y;
    at += 2;
  }
  return out.subarray(0, at);
}

/** Normalise a user-space axis value to -1..1, then through `avar`. */
export function normalizeAxis(font: SfntFont, value: number): number {
  const fvar = font.table('fvar');
  if (!fvar) return 0;
  const r = new Reader(font.data, fvar.offset);
  r.u32();
  const axesOffset = fvar.offset + r.u16();
  r.u16();
  const axisCount = r.u16();
  if (axisCount !== 1) {
    throw new Error(`instancing here handles a single-axis font; this one has ${axisCount}`);
  }
  r.seek(axesOffset + 4);
  const min = r.i32() / 65536;
  const def = r.i32() / 65536;
  const max = r.i32() / 65536;
  const clamped = Math.max(min, Math.min(max, value));
  let coord =
    clamped < def
      ? def === min
        ? 0
        : (clamped - def) / (def - min)
      : max === def
        ? 0
        : (clamped - def) / (max - def);

  const avar = font.table('avar');
  if (avar) {
    const a = new Reader(font.data, avar.offset + 6);
    const avarAxisCount = a.u16();
    if (avarAxisCount >= 1) {
      const count = a.u16();
      const maps: [number, number][] = [];
      for (let i = 0; i < count; i++) maps.push([a.f2dot14(), a.f2dot14()]);
      coord = piecewise(maps, coord);
    }
  }
  return coord;
}

function piecewise(maps: [number, number][], value: number): number {
  if (maps.length < 2) return value;
  for (let i = 1; i < maps.length; i++) {
    const prev = maps[i - 1];
    const cur = maps[i];
    if (!prev || !cur) continue;
    if (value < cur[0]) {
      if (value <= prev[0]) return prev[1];
      const t = (value - prev[0]) / (cur[0] - prev[0]);
      return prev[1] + t * (cur[1] - prev[1]);
    }
  }
  return maps[maps.length - 1]?.[1] ?? value;
}

/**
 * Apply `gvar` for one simple glyph at a normalised axis coordinate.
 *
 * Deltas are given for a subset of points; the rest are filled in by IUP —
 * each untouched point moves with its neighbours in contour order, which is
 * what stops an instanced glyph from tearing along the points nobody varied.
 */
export function applyGvar(
  font: SfntFont,
  gid: number,
  glyph: SimpleGlyph,
  coord: number,
): SimpleGlyph {
  const gvar = font.table('gvar');
  if (!gvar || glyph.points.length === 0) return glyph;

  const r = new Reader(font.data, gvar.offset);
  r.u32(); // version
  const axisCount = r.u16();
  const sharedTupleCount = r.u16();
  const sharedTuplesOffset = gvar.offset + r.u32();
  const glyphCount = r.u16();
  const longOffsets = (r.u16() & 1) !== 0;
  const dataArrayOffset = gvar.offset + r.u32();
  if (gid >= glyphCount) return glyph;

  r.seek(gvar.offset + 20 + gid * (longOffsets ? 4 : 2));
  const start = longOffsets ? r.u32() : r.u16() * 2;
  const end = longOffsets ? r.u32() : r.u16() * 2;
  if (end <= start) return glyph;

  const base = dataArrayOffset + start;
  const g = new Reader(font.data, base);
  const tupleCountRaw = g.u16();
  const tupleCount = tupleCountRaw & 0x0fff;
  const sharedPointNumbers = (tupleCountRaw & 0x8000) !== 0;
  let dataPos = base + g.u16();

  const pointCount = glyph.points.length + 4; // four phantom points
  let sharedPoints: number[] | undefined;
  if (sharedPointNumbers) {
    const pr = new Reader(font.data, dataPos);
    sharedPoints = readPointNumbers(pr, pointCount);
    dataPos = pr.pos;
  }

  const dx = new Float64Array(glyph.points.length);
  const dy = new Float64Array(glyph.points.length);

  for (let t = 0; t < tupleCount; t++) {
    const variationDataSize = g.u16();
    const tupleIndex = g.u16();
    const peak: number[] = [];
    if (tupleIndex & 0x8000) {
      for (let a = 0; a < axisCount; a++) peak.push(g.f2dot14());
    } else {
      const index = tupleIndex & 0x0fff;
      const sr = new Reader(font.data, sharedTuplesOffset + index * axisCount * 2);
      for (let a = 0; a < axisCount; a++) peak.push(sr.f2dot14());
      if (index >= sharedTupleCount) continue;
    }
    let interStart: number[] | undefined;
    let interEnd: number[] | undefined;
    if (tupleIndex & 0x4000) {
      interStart = [];
      interEnd = [];
      for (let a = 0; a < axisCount; a++) interStart.push(g.f2dot14());
      for (let a = 0; a < axisCount; a++) interEnd.push(g.f2dot14());
    }

    const scalar = tupleScalar(coord, peak[0] ?? 0, interStart?.[0], interEnd?.[0]);
    const tupleDataStart = dataPos;
    dataPos += variationDataSize;
    if (scalar === 0) continue;

    const tr = new Reader(font.data, tupleDataStart);
    const points =
      tupleIndex & 0x2000 ? readPointNumbers(tr, pointCount) : (sharedPoints ?? allPoints(pointCount));
    const deltaX = readDeltas(tr, points.length);
    const deltaY = readDeltas(tr, points.length);

    const touchedX = new Map<number, number>();
    const touchedY = new Map<number, number>();
    points.forEach((p, i) => {
      if (p >= glyph.points.length) return; // phantom point
      touchedX.set(p, (deltaX[i] ?? 0) * scalar);
      touchedY.set(p, (deltaY[i] ?? 0) * scalar);
    });
    interpolate(glyph, touchedX, touchedY, dx, dy);
  }

  return {
    endPts: glyph.endPts,
    points: glyph.points.map((p, i) => ({
      x: Math.round(p.x + (dx[i] ?? 0)),
      y: Math.round(p.y + (dy[i] ?? 0)),
      on: p.on,
    })),
  };
}

function tupleScalar(
  coord: number,
  peak: number,
  interStart?: number,
  interEnd?: number,
): number {
  if (peak === 0) return 1;
  if (coord === peak) return 1;
  const start = interStart ?? Math.min(0, peak);
  const end = interEnd ?? Math.max(0, peak);
  if (coord <= start || coord >= end) return 0;
  if (coord < peak) return peak === start ? 0 : (coord - start) / (peak - start);
  return end === peak ? 0 : (end - coord) / (end - peak);
}

function allPoints(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

function readPointNumbers(r: Reader, pointCount: number): number[] {
  let count = r.u8();
  if (count & 0x80) count = ((count & 0x7f) << 8) | r.u8();
  if (count === 0) return allPoints(pointCount);
  const out: number[] = [];
  let value = 0;
  while (out.length < count) {
    const control = r.u8();
    const runLength = (control & 0x7f) + 1;
    const words = (control & 0x80) !== 0;
    for (let i = 0; i < runLength && out.length < count; i++) {
      value += words ? r.u16() : r.u8();
      out.push(value);
    }
  }
  return out;
}

function readDeltas(r: Reader, count: number): number[] {
  const out: number[] = [];
  while (out.length < count) {
    const control = r.u8();
    const runLength = (control & 0x3f) + 1;
    if (control & 0x80) {
      for (let i = 0; i < runLength && out.length < count; i++) out.push(0);
    } else if (control & 0x40) {
      for (let i = 0; i < runLength && out.length < count; i++) out.push(r.i16());
    } else {
      for (let i = 0; i < runLength && out.length < count; i++) out.push((r.u8() << 24) >> 24);
    }
  }
  return out;
}

/** IUP: untouched points follow their touched neighbours, per contour. */
function interpolate(
  glyph: SimpleGlyph,
  touchedX: Map<number, number>,
  touchedY: Map<number, number>,
  dx: Float64Array,
  dy: Float64Array,
): void {
  let first = 0;
  for (const end of glyph.endPts) {
    const indices: number[] = [];
    for (let i = first; i <= end; i++) indices.push(i);
    const touched = indices.filter((i) => touchedX.has(i));
    if (touched.length === 0) {
      first = end + 1;
      continue;
    }
    for (const i of touched) {
      dx[i] = (dx[i] ?? 0) + (touchedX.get(i) ?? 0);
      dy[i] = (dy[i] ?? 0) + (touchedY.get(i) ?? 0);
    }
    if (touched.length === indices.length) {
      first = end + 1;
      continue;
    }
    for (let k = 0; k < touched.length; k++) {
      const a = touched[k] ?? 0;
      const b = touched[(k + 1) % touched.length] ?? 0;
      let i = a + 1 > end ? first : a + 1;
      while (i !== b) {
        const p = glyph.points[i];
        const pa = glyph.points[a];
        const pb = glyph.points[b];
        if (p && pa && pb) {
          dx[i] =
            (dx[i] ?? 0) +
            iup(p.x, pa.x, pb.x, touchedX.get(a) ?? 0, touchedX.get(b) ?? 0);
          dy[i] =
            (dy[i] ?? 0) +
            iup(p.y, pa.y, pb.y, touchedY.get(a) ?? 0, touchedY.get(b) ?? 0);
        }
        i = i + 1 > end ? first : i + 1;
      }
    }
    first = end + 1;
  }
}

function iup(v: number, a: number, b: number, da: number, db: number): number {
  let lo = a;
  let hi = b;
  let dlo = da;
  let dhi = db;
  if (lo > hi) {
    [lo, hi] = [hi, lo];
    [dlo, dhi] = [dhi, dlo];
  }
  if (lo === hi) return dlo === dhi ? dlo : 0;
  if (v <= lo) return dlo;
  if (v >= hi) return dhi;
  const t = (v - lo) / (hi - lo);
  return dlo + t * (dhi - dlo);
}
