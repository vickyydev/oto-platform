/**
 * Shared pieces of a printout: the header, the footer, the dashed divider, the
 * money row and the allergy box.
 *
 * Sizes are in dots at 203 dpi. A 9 pt line is about 25 dots, so `BODY` at 22
 * is roughly 8 pt — the size the prototype's `text-[12px]` receipt reads at
 * once it is on 80 mm paper.
 */

import type { Align, Block, InlineRun, TextStyle } from '../document';
import type { PrintTemplate } from './model';

export const SIZE = {
  /** Footnotes, item notes, the caption under a QR. */
  small: 18,
  body: 22,
  strong: 22,
  /** The branch name at the top of a receipt. */
  header: 30,
  /** TOTAL, and the credit figure on a voucher. */
  total: 30,
  /** A band's holder name. */
  bandName: 26,
  bandBody: 18,
} as const;

export const body: TextStyle = { sizeDots: SIZE.body, weight: 'regular' };
export const bodyBold: TextStyle = { sizeDots: SIZE.body, weight: 'bold' };
export const small: TextStyle = { sizeDots: SIZE.small, weight: 'regular' };
export const smallBold: TextStyle = { sizeDots: SIZE.small, weight: 'bold' };

/**
 * One printout's type: the five styles its builder draws with and how thick
 * its rules are, so the same pieces can be drawn at the prep tickets' size or
 * at the receipt's.
 */
export interface TypeScale {
  /** Footnotes, item notes, the tax-invoice lines, the caption under a QR. */
  small: TextStyle;
  body: TextStyle;
  /** The caps sub-title under the header ("RECEIPT", "CREDIT VOUCHER"). */
  title: TextStyle;
  /** The header text at the top. */
  heading: TextStyle;
  /** TOTAL, and the credit figure on a voucher. */
  total: TextStyle;
  ruleDots: number;
}

/** What every printout drew with before the receipt had a scale of its own. */
export const STANDARD_TYPE: TypeScale = {
  small,
  body,
  title: { sizeDots: SIZE.small, weight: 'regular', tracking: 2 },
  heading: { sizeDots: SIZE.header, weight: 'bold' },
  total: { sizeDots: SIZE.total, weight: 'bold' },
  ruleDots: 1,
};

/**
 * The receipt's type: every line bold, the body half as big again and the
 * header and the total twice the body's old size.
 *
 * Text reaches the head as raster (`emit/escpos.ts`), so ESC/POS's own
 * emphasis and character-size commands (`ESC E`, `GS !`, `ESC G`) cannot
 * touch it: they act on the printer's resident fonts, which this package never
 * uses. Bigger, bolder and darker is decided here instead, as the em size and
 * the weight of the face the host rasterises.
 *
 * The sizes are chosen against the narrower head. At 32 a bold digit is 18
 * dots, so the price column (`valueColumnDots`, 198) holds "฿12,345.50"
 * (165) with room to spare and the label beside it keeps 290 dots on a
 * 512-dot unit; at 44 the TOTAL row's figure (227 on 273) still fits. Nothing
 * a receipt prints as a number is ever narrower than its column, so a figure
 * never wraps. Rules are two dots, not one, so the dividers survive a light
 * head as well as the text does.
 */
export const RECEIPT_TYPE: TypeScale = {
  small: { sizeDots: 24, weight: 'bold' },
  body: { sizeDots: 32, weight: 'bold' },
  title: { sizeDots: 24, weight: 'bold', tracking: 2 },
  heading: { sizeDots: 44, weight: 'bold' },
  total: { sizeDots: 44, weight: 'bold' },
  ruleDots: 2,
};

export function text(
  value: string,
  style: TextStyle = body,
  align: Align = 'left',
): Block {
  return { k: 'text', runs: [{ text: value }], align, style };
}

export function runsBlock(runs: InlineRun[], style: TextStyle, align: Align = 'left'): Block {
  return { k: 'text', runs, align, style };
}

/** The prototype's `Divider` — a dashed rule (`PrintTemplatePreview.tsx:13`). */
export function divider(thicknessDots = 1): Block {
  return { k: 'rule', style: 'dashed', thicknessDots };
}

export function space(dots: number): Block {
  return { k: 'space', dots };
}

/**
 * The logo mark. The prototype draws a black circle with "oto" knocked out
 * (`PrintTemplatePreview.tsx:106-110`); on a monochrome head that is an
 * inverted badge, which is the same idea with the same ink.
 */
export function logoBlock(sizeDots: number = SIZE.body): Block {
  return {
    k: 'invert',
    inline: true,
    padDots: 4,
    children: [text('oto', { sizeDots, weight: 'bold', tracking: 1 }, 'center')],
  };
}

/**
 * Logo and header text, centred.
 *
 * Never called for a wristband: `TemplateEditor.tsx:29-32` hides the Show-logo
 * and Header-text controls for the two band types because "OTO name + logo are
 * pre-printed on the band" (`PrintTemplatePreview.tsx:46-47`).
 */
export function headerBlocks(
  template: PrintTemplate | undefined,
  title?: string,
  type: TypeScale = STANDARD_TYPE,
): Block[] {
  const out: Block[] = [];
  if (template?.showLogo) {
    out.push({ k: 'group', children: [centre(logoBlock(type.body.sizeDots))] });
    out.push(space(4));
  }
  if (template?.headerText) {
    out.push(text(template.headerText, type.heading, 'center'));
  }
  if (title) {
    out.push(text(title.toUpperCase(), type.title, 'center'));
  }
  return out;
}

/** Footer text under a dashed rule, centred (`PrintTemplatePreview.tsx:272-279`). */
export function footerBlocks(
  template: PrintTemplate | undefined,
  type: TypeScale = STANDARD_TYPE,
): Block[] {
  if (!template?.footerText) return [];
  return [divider(type.ruleDots), text(template.footerText, type.small, 'center')];
}

function centre(block: Block): Block {
  // `invert` has no align of its own; wrapping it in a group with a centred
  // child is how the badge ends up in the middle of an 80 mm receipt.
  return { k: 'group', children: [block] };
}

/**
 * A label/value row. The value is right-aligned by *measured* advance width,
 * not by padding a string: with proportional glyphs `'฿1,234'.padStart(10)`
 * means nothing, and the price column is the part of a receipt that has to line
 * up.
 */
export function moneyRow(
  label: string,
  value: string,
  strong = false,
  type: TypeScale = STANDARD_TYPE,
): Block {
  const style: TextStyle = strong ? type.total : type.body;
  return {
    k: 'columns',
    gapDots: 8,
    cells: [
      { runs: [{ text: label }], align: 'left', style, flex: 1 },
      { runs: [{ text: value }], align: 'right', style, widthDots: valueColumnDots(style.sizeDots) },
    ],
  };
}

/** Enough for "฿12,345.50" at the given size, with a little slack. */
export function valueColumnDots(sizeDots: number): number {
  return Math.round(sizeDots * 6.2);
}

/**
 * The boxed allergy alert.
 *
 * The prototype's routing string is
 * `⚠ ALLERGY${holderName ? ` (${holderName})` : ''}: ${allergiesMedical}`
 * (`printRouting.tsx:206`). The triangle is drawn as vectors, so a leading
 * U+26A0 in the caller's string is stripped rather than looked up in a font
 * that does not have it.
 */
export function allergyBlock(alert: string): Block {
  const stripped = alert.replace(/^\s*⚠\s*/u, '');
  return {
    k: 'frame',
    border: 'box',
    padDots: 4,
    children: [
      {
        k: 'warning',
        sizeDots: SIZE.body,
        runs: [{ text: stripped }],
        style: bodyBold,
      },
    ],
  };
}

/** "⚠ ALLERGY (name): text", composed the way the prototype composes it. */
export function allergyText(allergiesMedical: string, holderName?: string): string {
  return `⚠ ALLERGY${holderName ? ` (${holderName})` : ''}: ${allergiesMedical}`;
}

/** Join the parts the prototype joins with " · " (`PrintTemplatePreview.tsx:69`). */
export function joinDot(parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' · ');
}
