/**
 * The test page — the acceptance evidence for this whole package.
 *
 * It has no prototype equivalent (`testPrint` only raises a toast,
 * `printRouting.tsx:388-398`) and it is deliberately **code-only and not
 * admin-editable**: its job is to prove the renderer, and an editable test page
 * can be edited into passing.
 *
 * What it must carry, and why each part earns its place:
 *   - the device's label, model, address, transport and `dotsPerLine` **as
 *     rendered**, so a page that came off a 512-dot unit says 512;
 *   - a dot ruler with marks every 100 dots, so a 512-dot unit visibly
 *     truncates a 576-dot layout instead of silently dropping the right-hand
 *     8 mm the way `GS v 0` does;
 *   - the three script fixtures, because the acceptance criterion names Thai
 *     and Cyrillic and PROJECT_CONTEXT §7.3 also names Chinese;
 *   - a Thai three-level stack, because a tone mark above a vowel above a
 *     consonant is the case a code page cannot do;
 *   - a money column, because right alignment here is measured, not padded;
 *   - a QR and a Code 128 at the configured module size, because a code that
 *     does not scan is the failure that looks like a broken printer.
 *
 * **It lays out twice, because 25 mm is not 80 mm.** A 200-dot band has 188
 * dots of content column, which is a third of a receipt's, and the first
 * version of this page kept the receipt's two-column facts and receipt-sized
 * money rows on it. The result shredded: the TOTAL came out as "฿1,199." above
 * "50", the address as four fragments, and the page passed its "puts ink on
 * the page" test while being unreadable. So `narrow` below stacks the facts,
 * drops to band sizes and shortens the headings. Everything the page is for
 * still fits on a band; only the receipt's *shape* does not.
 */

import type { Block, DeviceProfile, PrintDocument, TextStyle } from '../document';
import type { TestPageData } from './data';
import { Bitmap1 } from '../raster/bitmap';
import { SIZE, body, bodyBold, divider, moneyRow, small, smallBold, space, text } from './common';

export interface TestPageInput {
  data: TestPageData;
  device: DeviceProfile;
}

/**
 * Below this, the content column is too narrow for a receipt's two-column
 * rows. 384 dots is 48 mm of paper: wider than every band stock in §9.1 and
 * far narrower than the 512- and 576-dot receipt heads in §9.3 and §9.4.
 */
const NARROW_DOTS = 384;

export function buildTestPage({ data, device }: TestPageInput): PrintDocument {
  const label = device.language === 'tspl2';
  const pad = label ? 6 : 8;
  const narrow = device.widthDots < NARROW_DOTS;
  // The ruler measures the column the layout actually has, not the head's
  // full width: drawn at full width it would run under the right-hand padding
  // and lose its end marker — the exact silent truncation it exists to show.
  const rulerDots = device.widthDots - pad * 2;
  const titleSize = narrow ? SIZE.body : SIZE.header;
  const stackSize = narrow ? SIZE.body : SIZE.header;

  const blocks: Block[] = [
    text('PRINTER TEST', { sizeDots: titleSize, weight: 'bold', tracking: 2 }, 'center'),
    divider(),
    ...fact(narrow, 'Device', data.deviceLabel),
    ...fact(narrow, 'Model', data.model),
    ...fact(narrow, 'Address', data.address),
    ...fact(narrow, 'Transport', data.transport),
    ...fact(narrow, 'Dots/line', `${data.widthDots} (as rendered)`),
    ...fact(narrow, 'Renderer', data.rendererVersion),
    ...fact(narrow, 'Fonts', data.fontVersions.join(', ')),
    divider(),
    text(narrow ? 'Dot ruler' : 'Dot ruler — marks every 100 dots', small),
    { k: 'image', source: rulerBitmap(rulerDots), align: 'left', halftone: 'threshold' },
    rulerLabels(rulerDots),
    divider(),
    text('Scripts', smallBold),
    text('สวัสดี OTO Park', body),
    text('Привет', body),
    text('欢迎光临', body),
    space(2),
    text('Thai stacks', smallBold),
    // ญี่ปุ่น — ญ carries a vowel and a tone mark above it while its descending
    // tail is clipped for the below-vowel on ป; น้ำ is three levels on one base.
    text('ญี่ปุ่น · น้ำ · เพื่อน', { sizeDots: stackSize, weight: 'regular' }),
    divider(),
    text(narrow ? 'Money column' : 'Money column (right-aligned by measured width)', small),
    ...moneyRows(narrow),
    divider(),
    text('Codes', smallBold),
    {
      k: 'qr',
      value: data.sampleCode,
      moduleDots: label ? 4 : 6,
      ecc: 'M',
      align: 'center',
      caption: [{ text: data.sampleCode }],
    },
    {
      k: 'barcode',
      symbology: 'code128',
      value: data.sampleCode,
      heightDots: 56,
      moduleDots: label ? 1 : 2,
      hri: 'below',
      align: 'center',
    },
    divider(),
    text(narrow ? 'Seeded templates' : 'Templates seeded for this branch', smallBold),
  ];

  for (const name of data.seededTemplates) blocks.push(text(`• ${name}`, small));
  if (data.seededTemplates.length === 0) {
    // A new branch has no templates at all (`catalogStore.ts:900`) and then
    // every printout shows everything. Saying so on the page saves an hour.
    blocks.push(text('none — every printout shows all sections', small));
  }

  return {
    media: {
      kind: label ? 'label' : 'receipt',
      widthDots: device.widthDots,
      heightDots: label && device.media ? Math.round(device.media.lengthMm * 8) : undefined,
      dpi: 203,
    },
    paddingDots: pad,
    blocks,
    finish: label ? { copies: 1, cut: 'none' } : { feedDots: 96, cut: 'partial' },
  };
}

/** Value style on a band: small and bold, so a device label fits 188 dots. */
const narrowValue: TextStyle = { sizeDots: 16, weight: 'bold' };

/**
 * One label/value fact.
 *
 * On a receipt it is a row. On a band the label goes above the value: a fixed
 * 130-dot label column on a 188-dot page leaves 50 dots for the value, and 50
 * dots of "Adult band printer" is "Adult" / "band" / "print" / "er".
 */
function fact(narrow: boolean, label: string, value: string): Block[] {
  if (narrow) return [text(label, small), text(value, narrowValue)];
  return [
    {
      k: 'columns',
      gapDots: 8,
      cells: [
        { runs: [{ text: label }], align: 'left', style: small, widthDots: 130 },
        { runs: [{ text: value }], align: 'left', style: bodyBold, flex: 1 },
      ],
    },
  ];
}

const MONEY: [string, string, boolean][] = [
  ['Subtotal', '฿1,090', false],
  ['Service', '฿109.50', false],
  ['VAT (incl.)', '฿78.47', false],
  ['TOTAL', '฿1,199.50', true],
];

/**
 * The money column, which is here to show that right alignment is measured
 * rather than padded — four values of four different widths ending on one
 * right edge.
 *
 * A band gets its own sizing. The receipt's value column is `6.2 x` the em,
 * enough for "฿12,345.50"; at body size that is 136 of a band's 188 dots and
 * leaves the label 44, which wraps "Subtotal" in half. Band money is four
 * figures, not six, so the column is `4.8 x` a small em and the TOTAL is set
 * bold at the same size instead of at heading size.
 */
function moneyRows(narrow: boolean): Block[] {
  if (!narrow) return MONEY.map(([label, value, strong]) => moneyRow(label, value, strong));
  const valueDots = Math.round(SIZE.small * 4.8);
  return MONEY.map(([label, value, strong]) => ({
    k: 'columns' as const,
    gapDots: 8,
    cells: [
      {
        runs: [{ text: label }],
        align: 'left' as const,
        style: { sizeDots: SIZE.small, weight: strong ? ('bold' as const) : ('regular' as const) },
        flex: 1,
      },
      {
        runs: [{ text: value }],
        align: 'right' as const,
        style: { sizeDots: SIZE.small, weight: strong ? ('bold' as const) : ('regular' as const) },
        widthDots: valueDots,
      },
    ],
  }));
}

/** A tick every 10 dots, taller every 50, tallest every 100. */
function rulerBitmap(widthDots: number): Bitmap1 {
  const height = 20;
  const bmp = new Bitmap1(widthDots, height);
  bmp.fillRect(0, height - 1, widthDots, 1);
  for (let x = 0; x < widthDots; x += 10) {
    const h = x % 100 === 0 ? 18 : x % 50 === 0 ? 11 : 6;
    bmp.fillRect(x, height - h, 1, h);
  }
  // The last dot of the content column, marked so a truncated page is obvious.
  bmp.fillRect(widthDots - 1, 0, 1, height);
  return bmp;
}

function rulerLabels(widthDots: number): Block {
  const marks: string[] = [];
  for (let x = 0; x < widthDots; x += 100) marks.push(String(x));
  marks.push(String(widthDots));
  return text(marks.join('  '), { sizeDots: 14, weight: 'regular' });
}
