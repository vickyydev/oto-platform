import { describe, expect, it } from 'vitest';
import {
  breakOpportunities,
  layoutDocument,
  render,
  renderJob,
  resolveCellWidths,
  wrapText,
  wrapTextDetailed,
} from '../src/index';
import type { PrintDocument, TextStyle } from '../src/index';
import { PROFILES, TEMPLATES } from './fixtures';

const escpos576 = PROFILES.escpos576!;
const escpos512 = PROFILES.escpos512!;
const tspl200 = PROFILES.tspl200!;
const style: TextStyle = { sizeDots: 22, weight: 'regular' };

describe('a receipt is a variable number of lines', () => {
  it('grows with the content rather than being clipped', () => {
    const short = receiptOf(5);
    const long = receiptOf(200);
    expect(long.bitmap.height).toBeGreaterThan(short.bitmap.height * 10);
    expect(long.overflow).toEqual([]);
    // 200 lines at 576 dots still fit inside one job; the emitter bands it.
    expect(long.bytes.length).toBeGreaterThan(200_000);
  });

  it('wraps a line longer than the paper instead of losing it off the edge', () => {
    const job = renderJob(
      {
        kind: 'receipt',
        data: {
          title: 'Receipt',
          lines: [{ qty: 1, name: 'A very long product name '.repeat(6).trim(), price: '฿10' }],
          total: '฿10',
        },
      },
      { device: escpos576, templates: TEMPLATES },
    );
    const lines = job.layout.items.filter((i) => i.k === 'text' && i.text.includes('long'));
    expect(lines.length).toBeGreaterThan(1);
    for (const item of job.layout.items) {
      if (item.k !== 'text') continue;
      expect(item.x + item.widthDots).toBeLessThanOrEqual(576);
    }
  });

  it('breaks an unbreakable token by measured character rather than clipping', () => {
    const token = 'X'.repeat(200);
    const lines = wrapText(token, style, 200);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(token);
  });
});

describe('a forced break is reported, because nothing else can report it', () => {
  // `forceBreak` splits by measured character, so every line it produces fits
  // the column and the width check downstream can never trip. Without the
  // signal from the wrapper, the commonest overflow there is — a value with no
  // break opportunity in a column too narrow for it — is silent.

  it('says which lines were cut mid-token', () => {
    const detailed = wrapTextDetailed('192.168.88.204:9100', style, 60);
    expect(detailed.lines.length).toBeGreaterThan(1);
    expect(detailed.forced.length).toBeGreaterThan(0);
    expect(detailed.lines.join('')).toBe('192.168.88.204:9100');
  });

  it('says nothing when the break was a real opportunity', () => {
    const detailed = wrapTextDetailed('one two three four five', style, 120);
    expect(detailed.lines.length).toBeGreaterThan(1);
    expect(detailed.forced).toEqual([]);
  });

  it('reaches the layout as an overflow note naming the value', () => {
    const doc: PrintDocument = {
      media: { kind: 'receipt', widthDots: 120, dpi: 203 },
      paddingDots: 4,
      blocks: [
        { k: 'text', runs: [{ text: '฿1,199.50' }], align: 'right', style: { sizeDots: 30, weight: 'bold' } },
      ],
      finish: {},
    };
    const model = layoutDocument(doc);
    // The line the layout produced fits the column, so the width check is
    // silent; this note is the only evidence the total was split in half.
    for (const item of model.items) {
      if (item.k === 'text') expect(item.widthDots).toBeLessThanOrEqual(112);
    }
    expect(model.overflow.join('\n')).toMatch(/"฿1,199\.50" does not fit 112 dots and was split mid-word/);
  });

  it('leaves the test page clean on the narrowest band stock', () => {
    // The 25 mm band is the case that shredded: a 130-dot label column and a
    // receipt-sized money column on 188 dots of content. It now stacks.
    for (const profile of ['tspl200', 'tspl400', 'escpos512', 'escpos576'] as const) {
      const job = renderJob(
        { kind: 'test_page', data: testPageData(PROFILES[profile]!.widthDots) },
        { device: PROFILES[profile]!, templates: TEMPLATES },
      );
      expect(job.overflow, profile).toEqual([]);
    }
  });
});

describe('the same document on a narrower head', () => {
  it('re-lays out rather than silently losing the price column', () => {
    const at576 = receiptOf(6, escpos576);
    const at512 = receiptOf(6, escpos512);
    expect(at576.bitmap.width).toBe(576);
    expect(at512.bitmap.width).toBe(512);
    // Right-aligned money stays inside the narrower head.
    for (const item of at512.layout.items) {
      if (item.k !== 'text') continue;
      expect(item.x + item.widthDots).toBeLessThanOrEqual(512);
    }
  });
});

describe('Thai line height is not a constant', () => {
  it('gives a three-level stack a taller line than Latin', () => {
    const latin = oneLine('Park Park Park');
    const thai = oneLine('ญี่ปุ่น น้ำ');
    expect(thai.heightDots).toBeGreaterThan(latin.heightDots);
  });

  it('never breaks a Thai base away from its combining marks', () => {
    // น้ำ is base + above-vowel + tone mark; a break inside it would strand a
    // mark at the start of the next line.
    const text = 'น้ำดื่ม';
    for (const at of breakOpportunities(text)) {
      const cp = text.codePointAt(at) ?? 0;
      const combining =
        cp === 0x0e31 || (cp >= 0x0e34 && cp <= 0x0e3a) || (cp >= 0x0e47 && cp <= 0x0e4e);
      expect(combining).toBe(false);
    }
  });

  it('never breaks after a leading vowel', () => {
    // เ แ โ ใ ไ are written before the consonant they are pronounced after.
    const text = 'เพื่อนของเรา';
    for (const at of breakOpportunities(text)) {
      const prev = text.codePointAt(at - 1) ?? 0;
      expect(prev >= 0x0e40 && prev <= 0x0e44).toBe(false);
    }
  });

  it('wraps a long Thai footer that has no spaces in it', () => {
    const footer =
      'ขอบคุณที่มาเยี่ยม' +
      'โอโตเพลย์ปาร์ค' +
      'เซ็นทรัลภูเก็ต';
    const lines = wrapText(footer, style, 160);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(footer);
  });
});

describe('a label is a fixed die-cut', () => {
  it('reports overflow rather than letting the head clip the band', () => {
    const doc: PrintDocument = {
      media: { kind: 'label', widthDots: 200, heightDots: 80, dpi: 203 },
      paddingDots: 4,
      blocks: Array.from({ length: 12 }, (_, i) => ({
        k: 'text' as const,
        runs: [{ text: `line ${i}` }],
        align: 'left' as const,
        style,
      })),
      finish: {},
    };
    const model = layoutDocument(doc);
    expect(model.heightDots).toBeGreaterThan(80);
    expect(model.overflow.join(' ')).toMatch(/but the label is 80/);
  });

  it('shrinks a QR that will not fit and says so', () => {
    const job = renderJob(
      {
        kind: 'kids_wristband',
        data: {
          holderName: 'Mali',
          // Long enough to need a high version on a 200-dot band.
          bandCode: 'HKT1:'.padEnd(220, 'A'),
          shortCode: 'HKT1-4821',
        },
      },
      { device: tspl200, templates: TEMPLATES },
    );
    expect(job.overflow.join(' ')).toMatch(/QR reduced from|at least 1 dot per module/);
  });

  it('keeps a QR on a whole number of dots per module', () => {
    const job = renderJob(
      {
        kind: 'kids_wristband',
        data: { holderName: 'Mali', bandCode: 'HKT1:01J8Z4M2QR', shortCode: 'HKT1-4821' },
      },
      { device: tspl200, templates: TEMPLATES },
    );
    const qr = job.layout.items.find((i) => i.k === 'qr');
    expect(qr && qr.k === 'qr' && Number.isInteger(qr.moduleDots)).toBe(true);
  });
});

describe('columns are measured, not padded', () => {
  it('right-aligns the money column by advance width', () => {
    const job = receiptOf(3);
    // Body-size money cells — "฿100" and "฿1,234.50" have very different digit
    // counts and must still end on the same right edge. TOTAL is excluded: it
    // is set larger and gets a wider value column of its own.
    const money = job.layout.items.filter(
      (i) => i.k === 'text' && i.text.startsWith('฿') && i.style.sizeDots === 22,
    );
    expect(money.length).toBeGreaterThan(3);
    const rights = money.map((i) => (i.k === 'text' ? i.x + i.widthDots : 0));
    expect(new Set(rights).size).toBe(1);
  });

  it('never starves a flex cell to zero, however wide the fixed cells ask to be', () => {
    // A zero-width flex cell is what puts "TOTAL" down the page one letter at a
    // time. The fixed cells give way instead.
    const cells = [
      { runs: [{ text: 'Address' }], align: 'left' as const, style, widthDots: 130 },
      { runs: [{ text: '192.168.88.210:9100' }], align: 'left' as const, style },
    ];
    const widths = resolveCellWidths(cells, 188, 8);
    expect(widths[0]).toBeLessThan(130);
    expect(widths[1]).toBeGreaterThan(40);
    expect((widths[0] ?? 0) + (widths[1] ?? 0)).toBeLessThanOrEqual(180);
  });
});

function receiptOf(n: number, device = escpos576) {
  return renderJob(
    {
      kind: 'receipt',
      data: {
        title: 'Receipt',
        lines: Array.from({ length: n }, (_, i) => ({
          qty: 1,
          name: `Item ${i + 1}`,
          price: i % 2 === 0 ? '฿100' : '฿1,234.50',
        })),
        subtotal: '฿1,000',
        vat: '฿65.42',
        total: '฿1,000',
      },
    },
    { device, templates: TEMPLATES },
  );
}

function testPageData(widthDots: number) {
  return {
    deviceLabel: 'Adult band printer',
    model: '4B-2082A',
    address: '192.168.88.204:9100',
    transport: 'TCP 9100, one session',
    widthDots,
    rendererVersion: 'oto-print/0.1.0',
    fontVersions: ['NotoSans', 'NotoSansThai', 'OtoPrintSC'],
    seededTemplates: TEMPLATES.map((t) => t.name),
    sampleCode: 'HKT1-4821',
  };
}

function oneLine(text: string) {
  const doc: PrintDocument = {
    media: { kind: 'receipt', widthDots: 576, dpi: 203 },
    paddingDots: 8,
    blocks: [{ k: 'text', runs: [{ text }], align: 'left', style: { sizeDots: 30, weight: 'regular' } }],
    finish: {},
  };
  const model = layoutDocument(doc);
  render(model);
  return model;
}
