/**
 * Layout: a `PrintDocument` becomes absolutely-positioned primitives on an
 * integer dot grid.
 *
 * The one rule that shapes everything here is that a line's height is not a
 * constant. A Thai three-level stack reaches further above the baseline than
 * Latin caps and further below than a Latin descender, and how far depends on
 * the glyphs in that line, so each line is shaped, its ink measured, and the
 * next baseline placed from the measurement rather than from a fixed leading.
 *
 * Two consequences fall straight out of that. A receipt's total height is an
 * *output* — the document grows and `heightDots` is known only afterwards. A
 * label's height is an *input* — the band is a fixed die-cut — so overflow is
 * reported rather than silently clipped by the print head.
 */

import { describeCodePoint, shapeText } from '../fonts/shape';
import type { ShapedText } from '../fonts/shape';
import { wrapTextDetailed } from './wrap';
import type { WrapOptions } from './wrap';
import type { Align, Block, Cell, InlineRun, PrintDocument, TextStyle } from '../document';
import type { QrMatrix } from '../codes/qr';
import { encodeQr } from '../codes/qr';
import { encodeCode128 } from '../codes/code128';
import type { Bitmap1 } from '../raster/bitmap';

export type LayoutItem =
  | {
      k: 'text';
      x: number;
      baselineY: number;
      text: string;
      style: TextStyle;
      shaped: ShapedText;
      widthDots: number;
    }
  | { k: 'rect'; x: number; y: number; w: number; h: number }
  | { k: 'invert'; x: number; y: number; w: number; h: number }
  | { k: 'stroke'; x: number; y: number; w: number; h: number; thickness: number }
  | { k: 'dashes'; x: number; y: number; w: number; thickness: number }
  | { k: 'warning'; x: number; y: number; size: number }
  | { k: 'qr'; x: number; y: number; moduleDots: number; matrix: QrMatrix }
  | {
      k: 'barcode';
      x: number;
      y: number;
      moduleDots: number;
      heightDots: number;
      modules: boolean[];
    }
  | { k: 'image'; x: number; y: number; bitmap: Bitmap1 };

export interface LayoutModel {
  widthDots: number;
  /** Measured, not requested. For a label this may exceed the media height. */
  heightDots: number;
  items: LayoutItem[];
  /**
   * Human-readable problems, never an exception: a line too wide for its
   * column, text that had to be cut mid-word to fit, a character no bundled
   * font covers, a label taller than the stock, a QR that had to shrink.
   */
  overflow: string[];
}

export interface LayoutOptions extends WrapOptions {
  /** Dots between the ink of one line and the next. */
  lineGapDots?: number;
}

const DEFAULT_LINE_GAP = 3;

export function layoutDocument(doc: PrintDocument, options: LayoutOptions = {}): LayoutModel {
  const pad = doc.paddingDots ?? 0;
  const contentWidth = doc.media.widthDots - pad * 2;
  if (contentWidth <= 0) {
    throw new Error(
      `media is ${doc.media.widthDots} dots wide but padding takes ${pad * 2}; nothing left to print on`,
    );
  }
  const ctx: Ctx = {
    items: [],
    overflow: [],
    gap: options.lineGapDots ?? DEFAULT_LINE_GAP,
    wrap: options,
  };

  let y = pad;
  for (const block of doc.blocks) y = layoutBlock(ctx, block, pad, y, contentWidth);
  const heightDots = y + pad;

  if (doc.media.kind === 'label' && doc.media.heightDots !== undefined) {
    if (heightDots > doc.media.heightDots) {
      ctx.overflow.push(
        `content is ${heightDots} dots tall but the label is ${doc.media.heightDots}; ` +
          `shorten the band's content or fit a longer stock`,
      );
    }
  }

  // The bitmap is always the height of the content, label or not: TSPL places
  // a `BITMAP` at an origin inside a label whose length `SIZE` declares, so a
  // band's blank tail costs nothing to send. The label's height is still a
  // constraint — it is just reported rather than enforced by clipping.
  return {
    widthDots: doc.media.widthDots,
    heightDots,
    items: ctx.items,
    overflow: ctx.overflow,
  };
}

interface Ctx {
  items: LayoutItem[];
  overflow: string[];
  gap: number;
  wrap: WrapOptions;
}

function layoutBlock(ctx: Ctx, block: Block, x: number, y: number, width: number): number {
  switch (block.k) {
    case 'space':
      return y + block.dots;

    case 'rule': {
      const t = block.thicknessDots ?? 1;
      ctx.items.push(
        block.style === 'dashed'
          ? { k: 'dashes', x, y, w: width, thickness: t }
          : { k: 'rect', x, y, w: width, h: t },
      );
      return y + t + ctx.gap;
    }

    case 'text':
      return layoutText(ctx, block.runs, block.style, block.align, x, y, width, block.leading);

    case 'columns':
      return layoutColumns(ctx, block.cells, block.gapDots ?? 8, x, y, width);

    case 'warning': {
      const size = block.sizeDots;
      const indent = size + Math.round(size * 0.35);
      ctx.items.push({ k: 'warning', x, y: y + 1, size });
      const after = layoutText(
        ctx,
        block.runs,
        block.style,
        'left',
        x + indent,
        y,
        width - indent,
      );
      return Math.max(after, y + size + ctx.gap);
    }

    case 'frame': {
      const p = block.padDots;
      const start = y;
      let inner = y + p;
      for (const child of block.children) {
        inner = layoutBlock(ctx, child, x + p, inner, width - p * 2);
      }
      const h = inner - start + p;
      ctx.items.push({ k: 'stroke', x, y: start, w: width, h, thickness: 1 });
      return start + h + ctx.gap;
    }

    case 'invert': {
      const p = block.padDots ?? 2;
      const start = y;
      const first = ctx.items.length;
      let inner = y + p;
      for (const child of block.children) {
        inner = layoutBlock(ctx, child, x + p, inner, width - p * 2);
      }
      const h = inner - start + p;
      // An inline badge hugs its content wherever the content ended up — a
      // centred child sits in the middle of the column, so the badge has to
      // follow the ink rather than start at the column's left edge.
      const bounds = inkBounds(ctx.items, first);
      const inline = block.inline && bounds !== undefined;
      ctx.items.push({
        k: 'invert',
        x: inline && bounds ? Math.max(x, bounds.left - p) : x,
        y: start,
        w: inline && bounds ? bounds.right - bounds.left + p * 2 : width,
        h,
      });
      return start + h + ctx.gap;
    }

    case 'group': {
      let inner = y;
      for (const child of block.children) inner = layoutBlock(ctx, child, x, inner, width);
      return inner;
    }

    case 'image': {
      const bmp = block.source;
      const drawX = alignedX(x, width, bmp.width, block.align);
      ctx.items.push({ k: 'image', x: drawX, y, bitmap: bmp });
      return y + bmp.height + ctx.gap;
    }

    case 'barcode': {
      const { modules } = encodeCode128(block.value);
      const w = modules.length * block.moduleDots;
      if (w > width) {
        ctx.overflow.push(
          `barcode "${block.value}" needs ${w} dots at module size ${block.moduleDots} ` +
            `but only ${width} are available; shorten the code or drop to 1 dot per module`,
        );
      }
      const drawX = alignedX(x, width, w, block.align);
      ctx.items.push({
        k: 'barcode',
        x: drawX,
        y,
        moduleDots: block.moduleDots,
        heightDots: block.heightDots,
        modules,
      });
      let after = y + block.heightDots + ctx.gap;
      if (block.hri === 'below') {
        after = layoutText(
          ctx,
          [{ text: block.value }],
          { sizeDots: Math.max(14, Math.round(block.moduleDots * 7)), weight: 'regular' },
          block.align,
          x,
          after,
          width,
        );
      }
      return after;
    }

    case 'qr': {
      const matrix = encodeQr(block.value, block.ecc);
      // Modules are drawn at a whole number of dots and the image is never
      // resampled. A QR scaled by a non-integer factor at 203 dpi does not
      // scan, and it looks like a printer fault rather than a renderer one.
      const moduleDots = Math.max(1, Math.floor(block.moduleDots));
      let size = matrix.size * moduleDots;
      if (size > width) {
        const fit = Math.floor(width / matrix.size);
        if (fit < 1) {
          ctx.overflow.push(
            `QR payload needs version ${matrix.version} (${matrix.size} modules) but the media ` +
              `is ${width} dots wide; at least 1 dot per module is ${matrix.size} dots. ` +
              `Shorten the payload or use a wider band.`,
          );
        } else {
          ctx.overflow.push(
            `QR reduced from ${moduleDots} to ${fit} dots per module to fit ${width} dots`,
          );
        }
        size = Math.max(1, fit) * matrix.size;
      }
      const drawX = alignedX(x, width, size, block.align);
      ctx.items.push({
        k: 'qr',
        x: drawX,
        y,
        moduleDots: Math.max(1, Math.min(moduleDots, Math.floor(width / matrix.size))),
        matrix,
      });
      let after = y + size + ctx.gap;
      if (block.caption) {
        after = layoutText(
          ctx,
          block.caption,
          { sizeDots: 18, weight: 'regular' },
          block.align,
          x,
          after,
          width,
        );
      }
      return after;
    }
  }
}

function inkBounds(items: LayoutItem[], from: number): { left: number; right: number } | undefined {
  let maxRight = 0;
  let minLeft = Infinity;
  for (let i = from; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const left = it.x;
    const right =
      it.k === 'text'
        ? it.x + it.widthDots
        : it.k === 'qr'
          ? it.x + it.matrix.size * it.moduleDots
          : it.k === 'barcode'
            ? it.x + it.modules.length * it.moduleDots
            : it.k === 'image'
              ? it.x + it.bitmap.width
              : it.k === 'warning'
                ? it.x + it.size
                : it.x + ('w' in it ? it.w : 0);
    if (left < minLeft) minLeft = left;
    if (right > maxRight) maxRight = right;
  }
  return minLeft === Infinity ? undefined : { left: minLeft, right: maxRight };
}

/**
 * Measured widths are fractional and dots are not. Rounding the *width* before
 * subtracting keeps every right-aligned cell on the same right edge whatever
 * its digits measure, which is the whole point of a price column.
 */
function alignedX(x: number, width: number, itemWidth: number, align: Align): number {
  if (align === 'center') return x + Math.round((width - itemWidth) / 2);
  if (align === 'right') return x + Math.max(0, width - Math.round(itemWidth));
  return x;
}

interface Segment {
  text: string;
  style: TextStyle;
}

function segmentsOf(runs: InlineRun[], base: TextStyle): Segment[] {
  return runs.map((r) => ({ text: r.text, style: { ...base, ...r.style } }));
}

function widestStyle(segments: Segment[], base: TextStyle): TextStyle {
  let style = base;
  for (const s of segments) if (s.style.sizeDots > style.sizeDots) style = s.style;
  return style;
}

/**
 * Lay out one text block, wrapping to `width` and measuring each line's ink.
 */
function layoutText(
  ctx: Ctx,
  runs: InlineRun[],
  base: TextStyle,
  align: Align,
  x: number,
  y: number,
  width: number,
  leading?: number,
): number {
  const segments = segmentsOf(runs, base);
  const full = segments.map((s) => s.text).join('');
  if (full.length === 0) return y;

  // Wrapping measures with the widest style present, which never overflows and
  // only costs a little on the rare mixed-size line.
  const wrapped = wrapTextDetailed(full, widestStyle(segments, base), width, ctx.wrap);
  const lines = wrapped.lines;
  if (wrapped.forced.length > 0) {
    // A forced break is the only evidence that something did not fit: every
    // line it produces is narrower than the column, so the width check below
    // can never catch it. Without this note a shredded total prints silently.
    ctx.overflow.push(
      `${quoteForNote(full)} does not fit ${width} dots and was split mid-word ` +
        `across ${wrapped.forced.length + 1} lines; widen the column or shorten the value`,
    );
  }
  const missing: number[] = [];

  let cursor = y;
  let offset = 0;
  for (const line of lines) {
    const start = full.indexOf(line, offset);
    const at = start < 0 ? offset : start;
    const pieces = slicePieces(segments, at, at + line.length);
    offset = at + line.length;

    const shapedPieces = pieces.map((p) => ({
      piece: p,
      shaped: shapeText(p.text, p.style),
    }));
    const lineWidth = shapedPieces.reduce((n, p) => n + p.shaped.width, 0);
    if (lineWidth > width + 0.5) {
      ctx.overflow.push(
        `line ${JSON.stringify(line)} measures ${Math.ceil(lineWidth)} dots on ${width}`,
      );
    }
    for (const p of shapedPieces) {
      for (const cp of p.shaped.missing) if (!missing.includes(cp)) missing.push(cp);
    }
    const inkAbove = Math.max(0, ...shapedPieces.map((p) => p.shaped.inkAbove));
    const inkBelow = Math.max(0, ...shapedPieces.map((p) => p.shaped.inkBelow));
    const minAscent = Math.round(base.sizeDots * 0.72);
    const ascent = Math.ceil(Math.max(inkAbove, minAscent));
    const descent = Math.ceil(inkBelow);
    const baselineY = cursor + ascent;

    let penX = alignedX(x, width, lineWidth, align);
    for (const { piece, shaped } of shapedPieces) {
      if (piece.text.length > 0) {
        ctx.items.push({
          k: 'text',
          x: Math.round(penX),
          baselineY,
          text: piece.text,
          style: piece.style,
          shaped,
          widthDots: Math.round(shaped.width),
        });
      }
      penX += shaped.width;
    }

    const natural = ascent + descent + ctx.gap;
    cursor += leading !== undefined ? Math.max(leading, ascent + descent) : natural;
  }

  if (missing.length > 0) {
    const shown = missing.slice(0, 8).map(describeCodePoint).join(', ');
    const rest = missing.length > 8 ? ` and ${missing.length - 8} more` : '';
    ctx.overflow.push(
      `no bundled font covers ${shown}${rest} in ${quoteForNote(full)}; ` +
        `printed as boxes. Widen the repertoire in scripts/subset-cjk.ts if this is common`,
    );
  }
  return cursor;
}

/** A quoted excerpt short enough to sit in an overflow note. */
function quoteForNote(text: string): string {
  const chars = [...text];
  return JSON.stringify(chars.length > 48 ? `${chars.slice(0, 48).join('')}…` : text);
}

function slicePieces(segments: Segment[], from: number, to: number): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const seg of segments) {
    const segStart = at;
    const segEnd = at + seg.text.length;
    at = segEnd;
    const lo = Math.max(from, segStart);
    const hi = Math.min(to, segEnd);
    if (hi <= lo) continue;
    out.push({ text: seg.text.slice(lo - segStart, hi - segStart), style: seg.style });
  }
  return out;
}

/**
 * Column widths: fixed cells take theirs, the rest share what is left.
 *
 * On a narrow band the fixed money column can ask for more than the media has,
 * and a flex cell left with 0 dots wraps its label one character per line —
 * "TOTAL" down the page. So the fixed cells are scaled back rather than
 * allowed to starve the rest, and `FLEX_FLOOR` of the row always stays with the
 * flex cells. The row will still be too narrow for its text, and the layout
 * will say so in `overflow`; it just says it about a readable line.
 */
const FLEX_FLOOR = 0.35;

export function resolveCellWidths(cells: Cell[], width: number, gap: number): number[] {
  const gaps = gap * Math.max(0, cells.length - 1);
  const available = Math.max(0, width - gaps);
  let fixedTotal = 0;
  let flexTotal = 0;
  for (const c of cells) {
    if (c.widthDots !== undefined) fixedTotal += c.widthDots;
    else flexTotal += c.flex ?? 1;
  }

  let scale = 1;
  if (flexTotal > 0 && fixedTotal > 0) {
    const fixedCeiling = Math.floor(available * (1 - FLEX_FLOOR));
    if (fixedTotal > fixedCeiling) scale = Math.max(0, fixedCeiling / fixedTotal);
  } else if (fixedTotal > available) {
    scale = available / fixedTotal;
  }

  const scaled = cells.map((c) =>
    c.widthDots === undefined ? undefined : Math.max(0, Math.floor(c.widthDots * scale)),
  );
  const remaining = available - scaled.reduce<number>((n, w) => n + (w ?? 0), 0);

  return cells.map((c, i) => {
    const fixed = scaled[i];
    if (fixed !== undefined) return fixed;
    if (flexTotal === 0) return 0;
    return Math.max(0, Math.floor((remaining * (c.flex ?? 1)) / flexTotal));
  });
}

function layoutColumns(
  ctx: Ctx,
  cells: Cell[],
  gap: number,
  x: number,
  y: number,
  width: number,
): number {
  const widths = resolveCellWidths(cells, width, gap);
  let cellX = x;
  let maxY = y;
  cells.forEach((cell, i) => {
    const w = widths[i] ?? 0;
    const end = layoutText(ctx, cell.runs, cell.style, cell.align, cellX, y, w);
    if (end > maxY) maxY = end;
    cellX += w + gap;
  });
  return maxY;
}
