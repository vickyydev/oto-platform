/**
 * The bundled font stack and its per-code-point fallback.
 *
 * No single open font covers Thai, Chinese and Cyrillic, so this is a chain and
 * a coverage test, not one file. The order matters: Noto Sans Thai carries a
 * Latin subset and the baht sign U+0E3F, and `formatTHB` puts a baht sign on
 * every money row, so Thai is consulted for it before the SC face is reached.
 *
 * A code point no face in the chain covers is not an error: `fontFor` returns
 * undefined, the shaper draws a box and the layout records a note. See
 * `fonts/LICENSES.md`.
 *
 * **The faces are read from disk at runtime, through `import.meta.url`.** They
 * are not imported, not inlined and not resolved by a bundler, so a bundled
 * build that does not copy `fonts/` next to the emitted file loses all three
 * and every printout comes out as boxes — silently, because a missing optional
 * face is not fatal here. Whatever builds the box agent must copy
 * `packages/print/fonts/` beside its bundle and keep the relative path
 * `<bundle>/../../fonts/` intact, or set the loader up to resolve it. See
 * `README.md` in this package.
 *
 * Licensing (this is an obligation, not a formality): the Noto files ship
 * unmodified under OFL 1.1 with `fonts/OFL.txt` beside them. The Simplified
 * Chinese face is a *subset*, which counts as modification, so it is renamed —
 * "Noto" is a Reserved Font Name and a modified version may not carry it. See
 * `fonts/LICENSES.md`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SfntFont } from './sfnt';
import { OtLayout } from './otl';

export type FontWeight = 'regular' | 'bold';

export interface LoadedFont {
  readonly id: string;
  readonly sfnt: SfntFont;
  readonly layout: OtLayout;
  /** OpenType script tag this face is consulted under. */
  readonly scriptTag: string;
}

interface FontSlot {
  id: string;
  file: string;
  scriptTag: string;
  /** Code-point ranges this slot claims, tested before its cmap. */
  claims?: [number, number][];
}

const THAI_BLOCK: [number, number] = [0x0e00, 0x0e7f];

/**
 * Chain order per weight. Thai first so the baht sign and Thai text both land
 * in the face that shapes them; Latin next; the CJK subset last.
 */
const SLOTS: Record<FontWeight, FontSlot[]> = {
  regular: [
    {
      id: 'thai',
      file: 'NotoSansThai-Regular.ttf',
      scriptTag: 'thai',
      claims: [THAI_BLOCK],
    },
    { id: 'latin', file: 'NotoSans-Regular.ttf', scriptTag: 'DFLT' },
    { id: 'sc', file: 'OtoPrintSC-Regular.ttf', scriptTag: 'hani' },
  ],
  bold: [
    { id: 'thai', file: 'NotoSansThai-Bold.ttf', scriptTag: 'thai', claims: [THAI_BLOCK] },
    { id: 'latin', file: 'NotoSans-Bold.ttf', scriptTag: 'DFLT' },
    // The SC subset ships in one weight; bold Chinese falls back to it rather
    // than carrying a second 17 MB source file through the build.
    { id: 'sc', file: 'OtoPrintSC-Regular.ttf', scriptTag: 'hani' },
  ],
};

const FONT_DIR = new URL('../../fonts/', import.meta.url);

const loaded = new Map<string, LoadedFont>();

function load(slot: FontSlot): LoadedFont | undefined {
  const cached = loaded.get(slot.file);
  if (cached) return cached;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(fileURLToPath(new URL(slot.file, FONT_DIR)));
  } catch {
    // A missing optional face is not fatal here: the shaper reports the
    // uncovered code point, which is a far more useful message than a stack
    // trace out of readFileSync at import time.
    return undefined;
  }
  const sfnt = new SfntFont(bytes, slot.file);
  const font: LoadedFont = { id: slot.id, sfnt, layout: new OtLayout(sfnt), scriptTag: slot.scriptTag };
  loaded.set(slot.file, font);
  return font;
}

export interface FontStack {
  readonly weight: FontWeight;
  /** The face that should draw this code point, or undefined if none covers it. */
  fontFor(codePoint: number): LoadedFont | undefined;
  /** Every face in the chain, for diagnostics. */
  chain(): LoadedFont[];
}

const stacks = new Map<FontWeight, FontStack>();

export function fontStack(weight: FontWeight): FontStack {
  const cached = stacks.get(weight);
  if (cached) return cached;
  const fonts: { font: LoadedFont; slot: FontSlot }[] = [];
  for (const slot of SLOTS[weight]) {
    const font = load(slot);
    if (font) fonts.push({ font, slot });
  }
  const cache = new Map<number, LoadedFont | undefined>();
  const stack: FontStack = {
    weight,
    fontFor(codePoint) {
      if (cache.has(codePoint)) return cache.get(codePoint);
      let found: LoadedFont | undefined;
      for (const { font, slot } of fonts) {
        const claimed = slot.claims?.some(([lo, hi]) => codePoint >= lo && codePoint <= hi) ?? false;
        if (claimed && font.sfnt.covers(codePoint)) {
          found = font;
          break;
        }
      }
      if (!found) {
        for (const { font } of fonts) {
          if (font.sfnt.covers(codePoint)) {
            found = font;
            break;
          }
        }
      }
      cache.set(codePoint, found);
      return found;
    },
    chain: () => fonts.map((f) => f.font),
  };
  stacks.set(weight, stack);
  return stack;
}

/** Which faces are actually present on disk — the test page prints this. */
export function bundledFontIds(weight: FontWeight): string[] {
  return fontStack(weight)
    .chain()
    .map((f) => f.id);
}
