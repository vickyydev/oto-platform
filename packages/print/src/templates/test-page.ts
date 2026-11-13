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
 *
 * **SCRUM-971 — and on a band it fits the band's print window.** A pre-printed
 * band is white for only part of its length (the park's: 80 mm from 50 mm on
 * a 246 mm band), and a real band is laid out to that window (`buildBand`).
 * The test page was not: 1,108 dots (138.5 mm) ran off the window onto the
 * pre-printed artwork. On a label it is now composed for the same window a
 * band is: it keeps the title and the rows that identify the printer (Device,
 * Model, Address, Station, Box, Time), and drops the rest in this order until
 * it fits — the dot ruler, the scripts, the money column, the codes, the
 * template list, then Fonts, Renderer, Dots/line and Transport. A label with
 * no window has its whole length to fill, as a band does. The receipt page is
 * not measured and does not change.
 */

import type { Block, DeviceProfile, PrintDocument, TextStyle } from '../document';
import type { TestPageData } from './data';
import { Bitmap1 } from '../raster/bitmap';
import { layoutDocument, lineDots } from '../layout/layout';
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
  /**
   * SCRUM-971 — the station, box and time rows at the pitch of the Device and
   * Model rows. A row's height is its own ink, so a row with no descender
   * ("ZZ TEST 952 till", a time, an address) sat about 21 dots under the one
   * before it against the 25 to 27 of the rows whose values reach below the
   * line. Only on a page that carries those rows, so the committed fixture's
   * page, which has none, is the page it was.
   */
  const placed = [data.station, data.box, data.time].some((value) => value?.trim());
  const rowDots = placed && !narrow ? lineDots(ROW_SAMPLE, bodyBold) : undefined;

  /** The rows that say which printer this is: never dropped to fit a band. */
  const identity: Block[] = [
    text('PRINTER TEST', { sizeDots: titleSize, weight: 'bold', tracking: 2 }, 'center'),
    divider(),
    ...fact(narrow, 'Device', data.deviceLabel),
    ...fact(narrow, 'Model', data.model),
    ...fact(narrow, 'Address', data.address, rowDots),
    // SCRUM-952 — the station, box and time of the printer it ran on, when the
    // platform composed the page for it; absent on the committed fixture.
    ...optionalFact(narrow, 'Station', data.station, rowDots),
    ...optionalFact(narrow, 'Box', data.box, rowDots),
    ...optionalFact(narrow, 'Time', data.time, rowDots),
  ];
  /** The facts about how it is driven, dropped last and from the bottom up. */
  const driven: Block[][] = [
    fact(narrow, 'Transport', data.transport),
    fact(narrow, 'Dots/line', `${data.widthDots} (as rendered)`),
    fact(narrow, 'Renderer', data.rendererVersion),
    fact(narrow, 'Fonts', data.fontVersions.join(', ')),
  ];
  const ruler: Block[] = [
    divider(),
    text(narrow ? 'Dot ruler' : 'Dot ruler — marks every 100 dots', small),
    { k: 'image', source: rulerBitmap(rulerDots), align: 'left', halftone: 'threshold' },
    rulerLabels(rulerDots),
  ];
  const scripts: Block[] = [
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
  ];
  const money: Block[] = [
    divider(),
    text(narrow ? 'Money column' : 'Money column (right-aligned by measured width)', small),
    ...moneyRows(narrow),
  ];
  const codes: Block[] = [
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
  ];
  const templates: Block[] = [
    divider(),
    text(narrow ? 'Seeded templates' : 'Templates seeded for this branch', smallBold),
  ];
  for (const name of data.seededTemplates) templates.push(text(`• ${name}`, small));
  if (data.seededTemplates.length === 0) {
    // A new branch has no templates at all (`catalogStore.ts:900`) and then
    // every printout shows everything. Saying so on the page saves an hour.
    templates.push(text('none — every printout shows all sections', small));
  }

  // The height a band is laid out to (`buildBand`): its white window where
  // the stock has one, its whole length otherwise.
  const media = label ? device.media : undefined;
  const page = (blocks: Block[]): PrintDocument => ({
    media: {
      kind: label ? 'label' : 'receipt',
      widthDots: device.widthDots,
      heightDots: media ? Math.round((media.printLengthMm ?? media.lengthMm) * 8) : undefined,
      dpi: 203,
    },
    paddingDots: pad,
    blocks,
    finish: label ? { copies: 1, cut: 'none' } : { feedDots: 96, cut: 'partial' },
  });

  // The whole page, in its order; on a receipt that is the page.
  const sections: Block[][] = [ruler, scripts, money, codes, templates];
  const whole = page([...identity, ...driven.flat(), ...sections.flat()]);
  const window = whole.media.heightDots;
  if (window === undefined) return whole;

  // On a label: the first page, dropping in that order, whose content fits.
  const fits = (doc: PrintDocument) => layoutDocument(doc).heightDots <= window;
  if (fits(whole)) return whole;
  for (let dropped = 1; dropped <= sections.length; dropped += 1) {
    const doc = page([...identity, ...driven.flat(), ...sections.slice(dropped).flat()]);
    if (fits(doc)) return doc;
  }
  for (let kept = driven.length - 1; kept >= 0; kept -= 1) {
    const doc = page([...identity, ...driven.slice(0, kept).flat()]);
    if (fits(doc)) return doc;
  }
  // The rows that say which printer it is, whatever they measure: the layout
  // reports the overflow rather than the page naming nothing.
  return page(identity);
}

/**
 * SCRUM-971 — a value line that reaches as high and as low as a row of text
 * does: an ascender, the dot of an i and a descender, as "…receipt printer"
 * and "Xprinter XP-80" do on the Device and Model rows.
 */
const ROW_SAMPLE = 'lip';

/** Value style on a band: small and bold, so a device label fits 188 dots. */
const narrowValue: TextStyle = { sizeDots: 16, weight: 'bold' };

/**
 * One label/value fact.
 *
 * On a receipt it is a row. On a band the label goes above the value: a fixed
 * 130-dot label column on a 188-dot page leaves 50 dots for the value, and 50
 * dots of "Adult band printer" is "Adult" / "band" / "print" / "er".
 */
function fact(narrow: boolean, label: string, value: string, leading?: number): Block[] {
  if (narrow) return [text(label, small), text(value, narrowValue)];
  // `leading` is left off a row drawn at its own height, so its cells are the
  // cells every page has always had (SCRUM-971).
  const at = leading === undefined ? {} : { leading };
  return [
    {
      k: 'columns',
      gapDots: 8,
      cells: [
        { runs: [{ text: label }], align: 'left', style: small, widthDots: 130, ...at },
        { runs: [{ text: value }], align: 'left', style: bodyBold, flex: 1, ...at },
      ],
    },
  ];
}

/** A fact the page carries only when it was given one: no row, rather than an empty one. */
function optionalFact(narrow: boolean, label: string, value: string | undefined, leading?: number): Block[] {
  return value?.trim() ? fact(narrow, label, value, leading) : [];
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
