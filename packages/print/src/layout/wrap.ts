/**
 * Line breaking, including the part Thai makes hard.
 *
 * Thai has no inter-word spaces, so a space-based wrap puts a whole Thai
 * sentence on one line and runs it off the side of the paper. The rule here is
 * the minimum that is never *wrong*: a break may fall before a Thai base
 * character, never between a base and the combining marks that belong to it,
 * and never after a leading vowel (เ แ โ ใ ไ), which is written before the
 * consonant it is pronounced after.
 *
 * A dictionary breaker would place these better. `Intl.Segmenter` is exactly
 * that and is available behind `useIcuLineBreaking`, but it is not the default
 * and the reason is reproducibility: ICU's Thai dictionary differs between Node
 * builds — a small-icu build has none at all — so the same receipt would wrap
 * differently on the box and in the cloud, and the fixtures would only hold on
 * the machine that generated them. Byte-for-byte agreement between the Pi and
 * Render is the property this package is here to provide, so the rule wins and
 * the dictionary is opt-in.
 */

import { measureText } from '../fonts/shape';
import type { TextStyle } from '../document';
import type { FontWeight } from '../fonts/stack';

const THAI_START = 0x0e00;
const THAI_END = 0x0e7f;

/** Zero-advance marks: upper and lower vowels, tone marks, thanthakhat, phinthu. */
function isThaiCombining(cp: number): boolean {
  return (
    cp === 0x0e31 ||
    (cp >= 0x0e34 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e)
  );
}

/** เ แ โ ใ ไ — written first, pronounced after the consonant that follows. */
function isThaiLeadingVowel(cp: number): boolean {
  return cp >= 0x0e40 && cp <= 0x0e44;
}

function isThai(cp: number): boolean {
  return cp >= THAI_START && cp <= THAI_END;
}

/** CJK ideographs and kana, which break between any two characters. */
function isIdeograph(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}

export interface WrapOptions {
  /** Use ICU word segmentation for Thai instead of the rule above. */
  useIcuLineBreaking?: boolean;
}

/**
 * Indices at which a line may be broken, ascending, never including 0.
 * A break at index i puts text[0..i) on this line and text[i..] on the next.
 */
export function breakOpportunities(text: string, options: WrapOptions = {}): number[] {
  const out: number[] = [];
  const chars = [...text];
  const offsets: number[] = [];
  let at = 0;
  for (const ch of chars) {
    offsets.push(at);
    at += ch.length;
  }

  if (options.useIcuLineBreaking && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
    for (const seg of segmenter.segment(text)) {
      if (seg.index > 0) out.push(seg.index);
    }
    return out;
  }

  for (let i = 1; i < chars.length; i++) {
    const prev = chars[i - 1]?.codePointAt(0) ?? 0;
    const cur = chars[i]?.codePointAt(0) ?? 0;
    const index = offsets[i] ?? 0;
    if (prev === 0x20) {
      out.push(index);
      continue;
    }
    if (cur === 0x20) continue;
    if (isThai(cur)) {
      if (isThaiCombining(cur)) continue;
      if (isThaiLeadingVowel(prev)) continue;
      // A Thai character that follows a non-Thai one, or another cluster.
      out.push(index);
      continue;
    }
    if (isIdeograph(cur) || isIdeograph(prev)) {
      out.push(index);
      continue;
    }
    if (prev === 0x2d || prev === 0x2f) out.push(index); // after a hyphen or slash
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface WrapStyle {
  sizeDots: number;
  weight: FontWeight;
  tracking?: number;
}

export interface WrappedText {
  lines: string[];
  /**
   * Indices into `lines` of lines that had to be cut mid-token.
   *
   * This is the only signal that something did not fit. `forceBreak` splits by
   * measured character, so every line it produces is narrower than the column
   * — a width check downstream can therefore never trip, however shredded the
   * result. "฿1,199." / "50" is a broken total, not a wrap, and the caller has
   * to hear about it.
   */
  forced: number[];
}

/**
 * Break `text` into lines no wider than `maxWidthDots`, and say which lines
 * had to be cut mid-token.
 *
 * Measured, not counted: with proportional glyphs a character budget is
 * meaningless, and `'฿1,234'.padStart(10)` even more so.
 */
export function wrapTextDetailed(
  text: string,
  style: TextStyle,
  maxWidthDots: number,
  options: WrapOptions = {},
): WrappedText {
  if (text.length === 0) return { lines: [''], forced: [] };
  const hard = text.split('\n');
  if (hard.length > 1) {
    const out: WrappedText = { lines: [], forced: [] };
    for (const part of hard) {
      const piece = wrapTextDetailed(part, style, maxWidthDots, options);
      for (const at of piece.forced) out.forced.push(out.lines.length + at);
      out.lines.push(...piece.lines);
    }
    return out;
  }
  if (measureText(text, style) <= maxWidthDots) return { lines: [text], forced: [] };

  const breaks = breakOpportunities(text, options);
  const lines: string[] = [];
  const forced: number[] = [];
  let lineStart = 0;

  while (lineStart < text.length) {
    // The end of the text is a candidate like any break opportunity. Without
    // it a remainder that fits whole still gets cut at its last internal break
    // — "shellfish · สวัสดี OTO" and then "Park" alone on the next line.
    const candidates = [...breaks.filter((b) => b > lineStart), text.length];
    let chosen = -1;
    for (const b of candidates) {
      const slice = text.slice(lineStart, b).replace(/\s+$/u, '');
      if (measureText(slice, style) <= maxWidthDots) chosen = b;
      else break;
    }
    if (chosen < 0) {
      // No break opportunity fits: a single long token, a URL, or one Thai
      // cluster wider than the paper. Break it by measured character so the
      // text is still readable rather than silently clipped by the head.
      chosen = forceBreak(text, lineStart, style, maxWidthDots);
      forced.push(lines.length);
    }
    const line = text.slice(lineStart, chosen).replace(/\s+$/u, '');
    lines.push(line);
    lineStart = chosen;
    while (text[lineStart] === ' ') lineStart++;
  }
  return lines.length > 0 ? { lines, forced } : { lines: [''], forced: [] };
}

/** Lines only, for a caller that does not care how they were arrived at. */
export function wrapText(
  text: string,
  style: TextStyle,
  maxWidthDots: number,
  options: WrapOptions = {},
): string[] {
  return wrapTextDetailed(text, style, maxWidthDots, options).lines;
}

/**
 * Nothing fits: break by measured character.
 *
 * Binary search over the character offsets rather than measuring one more
 * character at a time — a 200-dot band and a long unbreakable string turn the
 * naive loop into thousands of shaping calls, which is slow enough to notice on
 * a box.
 */
function forceBreak(text: string, from: number, style: TextStyle, maxWidthDots: number): number {
  const offsets: number[] = [];
  let at = from;
  for (const ch of text.slice(from)) {
    at += ch.length;
    offsets.push(at);
  }
  if (offsets.length === 0) return text.length;

  let lo = 0;
  let hi = offsets.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const end = offsets[mid] ?? from;
    if (measureText(text.slice(from, end), style) <= maxWidthDots) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Always consume at least one character, or the caller never terminates.
  return offsets[best < 0 ? 0 : best] ?? text.length;
}
