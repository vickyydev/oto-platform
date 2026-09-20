/**
 * Outline filling: glyph contours and vector primitives become dots.
 *
 * Coverage is accumulated with four vertical subsamples and exact horizontal
 * span ends, then thresholded at 50%. The anti-alias step matters more than it
 * sounds at 203 dpi: a 9 pt receipt line is about 25 dots tall, so filling
 * straight to binary loses the thin stems of Thai consonants and the crossbar
 * of a 4. Thresholding afterwards gives the head a clean edge to work with.
 */

import type { Contour, Glyph } from '../fonts/sfnt';
import { Bitmap1 } from './bitmap';

const SUBSAMPLES = 4;

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Accumulates coverage for one page, then hands over a 1-bpp bitmap. */
export class CoverageCanvas {
  private readonly cov: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cov = new Float32Array(width * height);
  }

  /** Fill a closed polygon set with the nonzero winding rule. */
  fillPolygons(polys: number[][]): void {
    const edges: Edge[] = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const poly of polys) {
      const n = poly.length / 2;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = poly[i * 2] ?? 0;
        const y0 = poly[i * 2 + 1] ?? 0;
        const x1 = poly[j * 2] ?? 0;
        const y1 = poly[j * 2 + 1] ?? 0;
        if (y0 === y1) continue;
        edges.push({ x0, y0, x1, y1 });
        if (Math.min(y0, y1) < minY) minY = Math.min(y0, y1);
        if (Math.max(y0, y1) > maxY) maxY = Math.max(y0, y1);
      }
    }
    if (edges.length === 0) return;

    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height - 1, Math.ceil(maxY));
    const weight = 1 / SUBSAMPLES;
    const xs: { x: number; dir: number }[] = [];

    for (let row = yStart; row <= yEnd; row++) {
      for (let s = 0; s < SUBSAMPLES; s++) {
        const y = row + (s + 0.5) / SUBSAMPLES;
        xs.length = 0;
        for (const e of edges) {
          const lo = Math.min(e.y0, e.y1);
          const hi = Math.max(e.y0, e.y1);
          if (y < lo || y >= hi) continue;
          const t = (y - e.y0) / (e.y1 - e.y0);
          xs.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.y1 > e.y0 ? 1 : -1 });
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a.x - b.x);
        let winding = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          winding += xs[i]?.dir ?? 0;
          if (winding === 0) continue;
          this.addSpan(row, xs[i]?.x ?? 0, xs[i + 1]?.x ?? 0, weight);
        }
      }
    }
  }

  private addSpan(row: number, xa: number, xb: number, weight: number): void {
    if (xb <= xa) return;
    const left = Math.max(0, xa);
    const right = Math.min(this.width, xb);
    if (right <= left) return;
    const base = row * this.width;
    const firstPixel = Math.floor(left);
    const lastPixel = Math.min(this.width - 1, Math.ceil(right) - 1);
    for (let px = firstPixel; px <= lastPixel; px++) {
      const overlap = Math.min(right, px + 1) - Math.max(left, px);
      if (overlap <= 0) continue;
      this.cov[base + px] = (this.cov[base + px] ?? 0) + overlap * weight;
    }
  }

  /** Solid rectangle in dot coordinates; fractional edges are anti-aliased. */
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fillPolygons([[x, y, x + w, y, x + w, y + h, x, y + h]]);
  }

  /** Threshold at 50% coverage — the only path from coverage to dots. */
  toBitmap(): Bitmap1 {
    const bmp = new Bitmap1(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      const base = y * this.width;
      for (let x = 0; x < this.width; x++) {
        if ((this.cov[base + x] ?? 0) >= 0.5) bmp.set(x, y, true);
      }
    }
    return bmp;
  }
}

/**
 * A glyph outline flattened into polygons, in device dots.
 *
 * `originX`/`baselineY` are the pen position in dots; font units go up from the
 * baseline and device rows go down, so y is negated on the way through.
 */
export function glyphPolygons(
  glyph: Glyph,
  unitsPerEm: number,
  sizeDots: number,
  originX: number,
  baselineY: number,
  yShiftDots = 0,
): number[][] {
  const scale = sizeDots / unitsPerEm;
  const out: number[][] = [];
  for (const contour of glyph.contours) {
    const points = contourPoints(contour);
    const poly: number[] = [];
    flatten(points, scale, originX, baselineY - yShiftDots, poly);
    if (poly.length >= 6) out.push(poly);
  }
  return out;
}

interface CurvePoint {
  x: number;
  y: number;
  on: boolean;
}

/** Normalise a TrueType contour so it starts on-curve. */
function contourPoints(contour: Contour): CurvePoint[] {
  const pts: CurvePoint[] = contour.map((p) => ({ x: p.x, y: p.y, on: p.on }));
  if (pts.length === 0) return pts;
  const first = pts[0];
  if (first && !first.on) {
    const last = pts[pts.length - 1];
    if (last && last.on) {
      pts.unshift(pts.pop() as CurvePoint);
    } else if (last) {
      // Every point is off-curve: the implied start is the midpoint.
      pts.unshift({ x: (first.x + last.x) / 2, y: (first.y + last.y) / 2, on: true });
    }
  }
  return pts;
}

function flatten(
  pts: CurvePoint[],
  scale: number,
  ox: number,
  oy: number,
  out: number[],
): void {
  if (pts.length === 0) return;
  const dx = (p: CurvePoint) => ox + p.x * scale;
  const dy = (p: CurvePoint) => oy - p.y * scale;
  const start = pts[0];
  if (!start) return;
  let cx = dx(start);
  let cy = dy(start);
  out.push(cx, cy);

  const n = pts.length;
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n];
    if (!p) continue;
    if (p.on) {
      cx = dx(p);
      cy = dy(p);
      out.push(cx, cy);
      continue;
    }
    // Off-curve control. The following on-curve point ends the curve; two
    // off-curve points in a row imply an on-curve midpoint between them.
    const next = pts[(i + 1) % n];
    const endX = next ? (next.on ? dx(next) : (dx(p) + dx(next)) / 2) : out[0] ?? cx;
    const endY = next ? (next.on ? dy(next) : (dy(p) + dy(next)) / 2) : out[1] ?? cy;
    quadTo(cx, cy, dx(p), dy(p), endX, endY, out);
    cx = endX;
    cy = endY;
    if (next?.on) i++;
  }
}

function quadTo(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  out: number[],
): void {
  const span = Math.abs(x1 - x0) + Math.abs(y1 - y0) + Math.abs(cx - x0) + Math.abs(cy - y0);
  const steps = Math.min(24, Math.max(2, Math.ceil(span / 1.2)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
}

/**
 * The allergy warning triangle, drawn as vectors rather than a glyph.
 *
 * U+26A0 is not in Noto Sans — it lives in Noto Sans Symbols — and the
 * prototype already disagrees with itself about it (the routing string uses the
 * character, the preview draws an icon). Three polygons cost nothing, render
 * crisply at 25 dots where a symbol-font glyph does not, and keep a fourth font
 * out of the bundle.
 */
export function warningTrianglePolygons(x: number, y: number, size: number): number[][] {
  const t = Math.max(1.5, size * 0.12);
  const outer: number[] = [x + size / 2, y, x + size, y + size, x, y + size];
  const inset = t * 1.9;
  const inner: number[] = [
    x + size / 2,
    y + inset * 1.15,
    x + inset * 0.95,
    y + size - inset * 0.6,
    x + size - inset * 0.95,
    y + size - inset * 0.6,
  ];
  const barW = Math.max(1.5, size * 0.11);
  const barX = x + size / 2 - barW / 2;
  const bar: number[] = [
    barX,
    y + size * 0.34,
    barX + barW,
    y + size * 0.34,
    barX + barW,
    y + size * 0.64,
    barX,
    y + size * 0.64,
  ];
  const dotY = y + size * 0.72;
  const dot: number[] = [
    barX,
    dotY,
    barX + barW,
    dotY,
    barX + barW,
    dotY + barW,
    barX,
    dotY + barW,
  ];
  // Winding matters here. `outer` runs clockwise in device coordinates and
  // `inner` runs the other way, so the nonzero rule hollows the triangle out;
  // `bar` and `dot` run clockwise again, so they fill back in inside the
  // hollow. Reverse `inner` and the whole thing comes out as a black triangle
  // with no exclamation mark in it.
  return [outer, inner, bar, dot];
}
