/**
 * Shaping: text plus a style becomes positioned glyphs, measured in dots.
 *
 * The output carries *ink* extents rather than the font's global ascender and
 * descender, because a Thai line's height is not a constant. `น้ำ` rises well
 * above the Latin cap height and `ปุ่` drops below the Latin descender, and how
 * far depends on which glyphs are in the line. Everything downstream — line
 * height, the allergy frame, the label-overflow check — measures rather than
 * counts.
 *
 * **Nothing a guest can type may stop a receipt.** Member names, nicknames and
 * order notes are free text, the park serves Chinese, Japanese and Korean
 * tourists, and the bundled faces cover a fixed repertoire. So a code point no
 * face covers is drawn as a hollow box and recorded in `ShapedText.missing`,
 * which the layout turns into an `overflow` note. It is never thrown: a receipt
 * with a box in the name is a receipt, and a till that stops mid-sale is not.
 * A box is also the honest degradation — dropping the run would leave
 * "Member:" with nothing after it and no sign that anything was lost.
 */

import type { LoadedFont } from './stack';
import { fontStack } from './stack';
import type { FontWeight } from './stack';
import type { ShapedGlyph } from './otl';

export interface TextStyle {
  /** Em size in dots. At 203 dpi a 9 pt receipt line is about 25 dots. */
  sizeDots: number;
  weight: FontWeight;
  /** Extra dots between glyphs; negative tightens. */
  tracking?: number;
}

/**
 * A code point no bundled face covers, drawn as a hollow box.
 *
 * Nothing a guest can type may stop a receipt (see `notFound` below), so an
 * uncovered character becomes a box of its own rather than an exception. The
 * box sits on the baseline and is sized from the em, so it lines up with the
 * text around it instead of looking like a printer fault.
 */
export interface TofuBox {
  codePoint: number;
  widthDots: number;
  heightDots: number;
}

export interface PlacedGlyph {
  /** The face that draws it. Absent on a tofu box: no face covers it. */
  font?: LoadedFont;
  gid: number;
  /** Baseline-origin position, in dots, relative to the run's start. */
  x: number;
  /** Dots above the baseline; positive is up, matching font units. */
  y: number;
  sizeDots: number;
  /** Set when this is a box standing in for an uncovered character. */
  tofu?: TofuBox;
}

export interface ShapedText {
  glyphs: PlacedGlyph[];
  /** Total advance in dots. */
  width: number;
  /** Ink reach above the baseline, in dots. 0 for an empty or blank run. */
  inkAbove: number;
  /** Ink reach below the baseline, in dots, positive downwards. */
  inkBelow: number;
  /**
   * Code points no bundled face covered, in order of first appearance. Each
   * was drawn as a box; the layout turns this into an `overflow` note so a
   * missing name is visible to a human and not only on the paper.
   */
  missing: number[];
}

/**
 * Tofu geometry, as fractions of the em.
 *
 * A box at roughly cap height and half an em wide reads as a placeholder
 * beside Latin and Thai at 203 dpi. It is deliberately narrower than a CJK
 * ideograph — the line's width is a guess either way, and a guess that is too
 * narrow wraps, while one that is too wide runs off the paper.
 */
const TOFU_WIDTH_EM = 0.52;
const TOFU_HEIGHT_EM = 0.7;
const TOFU_SIDE_BEARING_EM = 0.1;

/** The box for one uncovered code point at one size. */
export function tofuBox(codePoint: number, sizeDots: number): TofuBox {
  return {
    codePoint,
    widthDots: Math.max(3, Math.round(sizeDots * TOFU_WIDTH_EM)),
    heightDots: Math.max(4, Math.round(sizeDots * TOFU_HEIGHT_EM)),
  };
}

/** `U+738B 王`, for an overflow note or a log line. */
export function describeCodePoint(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
  return `U+${hex} ${String.fromCodePoint(codePoint)}`;
}

const NO_MISSING: number[] = [];

/**
 * Feature order per script. Thai needs mark and mkmk — without them a tone mark
 * sits at the glyph origin instead of above the vowel it belongs to.
 */
const SUBSTITUTION_FEATURES = ['ccmp', 'locl', 'liga'];
const POSITIONING_FEATURES_THAI = ['kern', 'mark', 'mkmk'];
const POSITIONING_FEATURES_DEFAULT = ['kern', 'mark', 'mkmk'];

interface Run {
  /** The face that draws this run, or undefined when none covers it. */
  font?: LoadedFont;
  codePoints: number[];
  /** Index in the source string of each code point, for cluster reporting. */
  clusters: number[];
}

function splitRuns(text: string, weight: FontWeight): Run[] {
  const stack = fontStack(weight);
  const runs: Run[] = [];
  let current: Run | undefined;
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // Undefined here is not an error: consecutive uncovered code points share
    // one run and come out as boxes.
    const font = stack.fontFor(cp);
    if (!current || current.font !== font) {
      current = { font, codePoints: [], clusters: [] };
      runs.push(current);
    }
    current.codePoints.push(cp);
    current.clusters.push(index);
    index += ch.length;
  }
  return runs;
}

/** Shape one string in one style. Pure: no clock, no locale, no I/O. */
export function shapeText(text: string, style: TextStyle): ShapedText {
  if (text.length === 0) {
    return { glyphs: [], width: 0, inkAbove: 0, inkBelow: 0, missing: NO_MISSING };
  }

  const tracking = style.tracking ?? 0;
  const out: PlacedGlyph[] = [];
  let penDots = 0;
  let inkAbove = 0;
  let inkBelow = 0;
  let missing: number[] | undefined;

  for (const run of splitRuns(text, style.weight)) {
    const { font } = run;

    if (!font) {
      // No face covers these. One box per code point, on the baseline, with a
      // side bearing so a run of them does not read as a solid bar.
      const bearing = Math.max(1, Math.round(style.sizeDots * TOFU_SIDE_BEARING_EM));
      for (const cp of run.codePoints) {
        const box = tofuBox(cp, style.sizeDots);
        out.push({ gid: 0, x: penDots, y: 0, sizeDots: style.sizeDots, tofu: box });
        penDots += box.widthDots + bearing + tracking;
        if (box.heightDots > inkAbove) inkAbove = box.heightDots;
        missing ??= [];
        if (!missing.includes(cp)) missing.push(cp);
      }
      continue;
    }

    const scale = style.sizeDots / font.sfnt.unitsPerEm;

    let buf: ShapedGlyph[] = run.codePoints.map((cp, i) => {
      const gid = font.sfnt.glyphFor(cp);
      return {
        gid,
        cluster: run.clusters[i] ?? 0,
        xAdvance: font.sfnt.advanceOf(gid),
        xOffset: 0,
        yOffset: 0,
        attachTo: -1,
      };
    });

    buf = font.layout.substitute(buf, font.scriptTag, SUBSTITUTION_FEATURES);
    font.layout.position(
      buf,
      font.scriptTag,
      font.scriptTag === 'thai' ? POSITIONING_FEATURES_THAI : POSITIONING_FEATURES_DEFAULT,
    );

    // Resolve attachments into absolute baseline-relative positions, in font
    // units, then scale once. Marks attach to a glyph earlier in the buffer, so
    // one forward pass is enough.
    const drawX = new Float64Array(buf.length);
    const drawY = new Float64Array(buf.length);
    let unitPen = 0;
    for (let i = 0; i < buf.length; i++) {
      const g = buf[i];
      if (!g) continue;
      const hostX = g.attachTo >= 0 ? (drawX[g.attachTo] ?? 0) : unitPen;
      const hostY = g.attachTo >= 0 ? (drawY[g.attachTo] ?? 0) : 0;
      drawX[i] = hostX + g.xOffset;
      drawY[i] = hostY + g.yOffset;
      unitPen += g.xAdvance;
      if (g.xAdvance !== 0 && i < buf.length - 1) unitPen += tracking / scale;
    }

    for (let i = 0; i < buf.length; i++) {
      const g = buf[i];
      if (!g) continue;
      const x = penDots + (drawX[i] ?? 0) * scale;
      const y = (drawY[i] ?? 0) * scale;
      out.push({ font, gid: g.gid, x, y, sizeDots: style.sizeDots });
      const outline = font.sfnt.glyph(g.gid);
      if (outline.contours.length === 0) continue;
      const above = y + outline.yMax * scale;
      const below = -(y + outline.yMin * scale);
      if (above > inkAbove) inkAbove = above;
      if (below > inkBelow) inkBelow = below;
    }

    penDots += unitPen * scale;
  }

  return { glyphs: out, width: penDots, inkAbove, inkBelow, missing: missing ?? NO_MISSING };
}

/** Advance width only — the cheap path for column fitting and wrapping. */
export function measureText(text: string, style: TextStyle): number {
  return shapeText(text, style).width;
}
