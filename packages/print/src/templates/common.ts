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
export function divider(): Block {
  return { k: 'rule', style: 'dashed', thicknessDots: 1 };
}

export function space(dots: number): Block {
  return { k: 'space', dots };
}

/**
 * The logo mark. The prototype draws a black circle with "oto" knocked out
 * (`PrintTemplatePreview.tsx:106-110`); on a monochrome head that is an
 * inverted badge, which is the same idea with the same ink.
 */
export function logoBlock(): Block {
  return {
    k: 'invert',
    inline: true,
    padDots: 4,
    children: [text('oto', { sizeDots: SIZE.body, weight: 'bold', tracking: 1 }, 'center')],
  };
}

/**
 * Logo and header text, centred.
 *
 * Never called for a wristband: `TemplateEditor.tsx:29-32` hides the Show-logo
 * and Header-text controls for the two band types because "OTO name + logo are
 * pre-printed on the band" (`PrintTemplatePreview.tsx:46-47`).
 */
export function headerBlocks(template: PrintTemplate | undefined, title?: string): Block[] {
  const out: Block[] = [];
  if (template?.showLogo) {
    out.push({ k: 'group', children: [centre(logoBlock())] });
    out.push(space(4));
  }
  if (template?.headerText) {
    out.push(text(template.headerText, { sizeDots: SIZE.header, weight: 'bold' }, 'center'));
  }
  if (title) {
    out.push(
      text(title.toUpperCase(), { sizeDots: SIZE.small, weight: 'regular', tracking: 2 }, 'center'),
    );
  }
  return out;
}

/** Footer text under a dashed rule, centred (`PrintTemplatePreview.tsx:272-279`). */
export function footerBlocks(template: PrintTemplate | undefined): Block[] {
  if (!template?.footerText) return [];
  return [divider(), text(template.footerText, small, 'center')];
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
export function moneyRow(label: string, value: string, strong = false): Block {
  const style: TextStyle = { sizeDots: strong ? SIZE.total : SIZE.body, weight: strong ? 'bold' : 'regular' };
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
