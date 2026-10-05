import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocument, emitEscpos, layoutDocument, render, renderJob } from '../src/index';
import type { Block, BoothVoucherData, DeviceProfile, PrintDocument, PrintJob } from '../src/index';
import { buildBoothVoucherBefore471 } from './booth-voucher-pre471';
import { FIXTURES, PROFILES } from './fixtures';

/**
 * SCRUM-471 — the booth's own voucher slip.
 *
 * The round's first invariant is that a booth nobody has customised prints
 * exactly what it printed before: the committed `booth-voucher` fixture is the
 * current expected render, and the all-defaults slip has to match it byte for
 * byte. Then each choice has to do its one thing and nothing else.
 */

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const device = PROFILES.escpos576!;

const fixture = FIXTURES.find((f) => f.name === 'booth-voucher');
if (!fixture || fixture.job.kind !== 'booth_voucher') throw new Error('booth-voucher fixture missing');
const base: BoothVoucherData = fixture.job.data;

function job(data: Partial<BoothVoucherData>): PrintJob {
  return { kind: 'booth_voucher', data: { ...base, ...data } };
}

/** Every piece of text the document lays down, in order, with its block kind. */
function texts(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.k === 'text') out.push(block.runs.map((r) => r.text).join(''));
    else if (block.k === 'columns') out.push(block.cells.map((c) => c.runs.map((r) => r.text).join('')).join(' | '));
    else if ('children' in block && Array.isArray(block.children)) out.push(...texts(block.children as Block[]));
  }
  return out;
}

function documentTexts(data: Partial<BoothVoucherData>): string[] {
  return texts(buildDocument(job(data), undefined, device).blocks);
}

function hasLogo(data: Partial<BoothVoucherData>): boolean {
  return buildDocument(job(data), undefined, device).blocks.some((b) => b.k === 'invert');
}

describe('the booth voucher slip, customised per booth', () => {
  it('replaces only the QR for an existing POS and keeps the platform reference', () => {
    const legacyQrPayload = 'https://example.invalid/Claim?Prize=200&Code=Ab%2Bc';
    const doc = buildDocument(job({ legacyQrPayload }), undefined, device);
    expect(doc.blocks.find((b) => b.k === 'qr')).toMatchObject({ value: legacyQrPayload });
    expect(texts(doc.blocks)).toContain(base.voucherCode);
    expect(texts(doc.blocks).some((line) => line.includes('Single use'))).toBe(false);
    for (const profile of [PROFILES.escpos512!, device]) {
      expect(renderJob(job({ legacyQrPayload }), { device: profile }).bitmap.height).toBeGreaterThan(0);
    }
  });
  it('prints byte for byte the committed voucher when every choice is its default', () => {
    const expected = readFileSync(`${dir}booth-voucher.escpos576.bin`);
    const explicitDefaults = renderJob(
      job({ showLogo: true, headerLine: null, showStaff: true, showTerms: true }),
      { device },
    );
    expect(Buffer.from(explicitDefaults.bytes).equals(expected)).toBe(true);
    // An empty or blank header is "no header", not a blank line.
    const blankHeader = renderJob(job({ headerLine: '   ' }), { device });
    expect(Buffer.from(blankHeader.bytes).equals(expected)).toBe(true);
  });

  it('prints the same without the fields at all — a job stored before they existed', () => {
    const expected = readFileSync(`${dir}booth-voucher.escpos576.bin`);
    expect(Buffer.from(renderJob(job({}), { device }).bytes).equals(expected)).toBe(true);
  });

  it('leaves the logo off when the booth says so, and nothing else', () => {
    expect(hasLogo({})).toBe(true);
    expect(hasLogo({ showLogo: false })).toBe(false);
    // `texts` walks into the logo's children, so drop its one word to compare
    // the rest of the slip.
    expect(documentTexts({ showLogo: false })).toEqual(documentTexts({}).filter((t) => t !== 'oto'));
    const plain = renderJob(job({}), { device });
    const bare = renderJob(job({ showLogo: false }), { device });
    expect(bare.bitmap.height).toBeLessThan(plain.bitmap.height);
  });

  it('adds the header as its own line under the venue line, never in its place', () => {
    const lines = documentTexts({ headerLine: 'Lucky Wheel · spin to win' });
    const venue = lines.indexOf(base.venueLine);
    expect(venue).toBeGreaterThanOrEqual(0);
    expect(lines[venue + 1]).toBe('Lucky Wheel · spin to win');
    expect(lines.filter((l) => l !== 'Lucky Wheel · spin to win')).toEqual(documentTexts({}));
  });

  it('puts the header above a reprint note, which stays at the top of the rest', () => {
    const lines = documentTexts({ headerLine: 'Header', reprintNote: 'Reprint · 24 Sep 2026 16:40' });
    expect(lines.indexOf('Header')).toBe(lines.indexOf(base.venueLine) + 1);
    expect(lines.indexOf('Reprint · 24 Sep 2026 16:40')).toBe(lines.indexOf('Header') + 1);
  });

  it('leaves the Staff row off when the booth says so — not even "unattributed"', () => {
    expect(documentTexts({}).some((l) => l.startsWith('Staff | '))).toBe(true);
    const off = documentTexts({ showStaff: false });
    expect(off.some((l) => l.startsWith('Staff'))).toBe(false);
    expect(documentTexts({ showStaff: false, staff: null }).some((l) => l.includes('unattributed'))).toBe(
      false,
    );
    // The rows either side are untouched.
    expect(off.some((l) => l.startsWith('Booth | '))).toBe(true);
    expect(off.some((l) => l.startsWith('Expires | '))).toBe(true);
  });

  it('leaves the terms off when the booth says so, keeping "Single use" and the footer', () => {
    const off = documentTexts({ showTerms: false });
    for (const term of base.terms) expect(off).not.toContain(term);
    expect(off).toContain('Single use · ใช้ได้ 1 ครั้ง');
    expect(off[off.length - 1]).toBe(base.footerLine);
  });

  it('prints the booth’s footer as the last line, and none when it is empty', () => {
    const withFooter = documentTexts({ footerLine: 'Thank you for playing!' });
    expect(withFooter[withFooter.length - 1]).toBe('Thank you for playing!');
    const none = documentTexts({ footerLine: '' });
    expect(none[none.length - 1]).toBe(base.terms[base.terms.length - 1]);
  });

  it('does not promise one use per paper copy when the code is shared', () => {
    expect(documentTexts({ codeMode: 'generated' })).toContain('Single use · ใช้ได้ 1 ครั้ง');
    expect(documentTexts({ codeMode: 'fixed' })).not.toContain('Single use · ใช้ได้ 1 ครั้ง');
    const shared = buildDocument(job({ codeMode: 'fixed', voucherCode: 'ZZ-SHARED' }), undefined, device);
    const qr = shared.blocks.find((block) => block.k === 'qr');
    expect(qr).toMatchObject({ value: 'ZZ-SHARED' });
    expect(texts(shared.blocks)).toContain('ZZ-SHARED');
  });

  it('lays out the bilingual showcase with matching QR, dates and prize terms', () => {
    const design = {
      layout: 'showcase' as const,
      venueLine: 'OTO PLAY PARK CENTRAL',
      winnerLine: '★ YOU WON ★',
      winnerLineThai: 'คุณได้รับรางวัล',
      codeLabel: 'VOUCHER CODE',
      issuedLabel: 'Issued / วันที่ออก',
      expiresLabel: 'Expires / วันหมดอายุ',
      termsLabel: 'TERMS / เงื่อนไข',
      singleUseLabel: 'Voucher can be used only once. / คูปองสามารถใช้ได้เพียง 1 ครั้ง',
    };
    const data: Partial<BoothVoucherData> = {
      design, codeMode: 'fixed', voucherCode: 'ZZ-SHARED',
      prizeLine: '100 THB DISCOUNT', prizeLineThai: 'ส่วนลด 100 บาท',
      redemptionLine: 'Show this QR at OTO Reception.\nแสดงคิวอาร์โค้ดนี้ที่เคาน์เตอร์ OTO',
      issuedDate: '01 Jan 2026', expiresAt: '01 Feb 2026',
      termsEn: ['Valid only at OTO Play Park Central.'],
      termsTh: ['คูปองใช้ได้เฉพาะที่ OTO Play Park Central เท่านั้น'],
    };
    const doc = buildDocument(job(data), undefined, device);
    const lines = texts(doc.blocks);
    expect(doc.blocks.find((block) => block.k === 'qr')).toMatchObject({ value: 'ZZ-SHARED' });
    expect(lines).toContain('ZZ-SHARED');
    expect(lines).toContain('100 THB DISCOUNT');
    expect(lines).toContain('ส่วนลด 100 บาท');
    expect(lines.some((line) => line.includes('Issued / วันที่ออก\n01 Jan 2026'))).toBe(true);
    expect(lines.some((line) => line.includes('Expires / วันหมดอายุ\n01 Feb 2026'))).toBe(true);
    expect(lines.some((line) => line.includes('Voucher can be used only once'))).toBe(false);
    expect(lines).toContain('1. Valid only at OTO Play Park Central.');
    expect(lines).toContain('คูปองใช้ได้เฉพาะที่ OTO Play Park Central เท่านั้น');
    expect(renderJob(job(data), { device }).bitmap.height).toBeGreaterThan(0);
    expect(renderJob(job(data), { device: PROFILES.escpos512! }).bitmap.height).toBeGreaterThan(0);
  });
});

/**
 * The gate's differential, kept: the template as it stands against the
 * template as it was before SCRUM-471 (`booth-voucher-pre471.ts`), on both
 * heads, across data shapes the committed fixture alone does not cover. A
 * booth that makes no choice — the fields absent, or set to their defaults —
 * gets the same document and the same bytes as before, whatever the rest of
 * the voucher holds.
 */
describe('the booth voucher, untouched, is the pre-471 voucher on every shape (gate differential)', () => {
  function bytes(doc: PrintDocument, head: DeviceProfile): Buffer {
    return Buffer.from(emitEscpos(render(layoutDocument(doc, {})), { device: head, finish: doc.finish }));
  }

  const shapes: Record<string, Partial<BoothVoucherData>> = {
    plain: {},
    'no staff': { staff: null },
    reprint: { reprintNote: 'Reprint · 24 Sep 2026 16:40' },
    'no terms': { terms: [] },
    'no expiry': { expiresAt: null },
    'empty footer': { footerLine: '' },
    'blank footer': { footerLine: '   ' },
    'long venue': { venueLine: 'A very long venue line '.repeat(8) },
    'no Thai': { prizeLineThai: null },
    'explicit defaults': { showLogo: true, showStaff: true, showTerms: true, headerLine: null },
    'empty header': { headerLine: '' },
  };

  for (const profile of ['escpos576', 'escpos512'] as const) {
    const head = PROFILES[profile]!;
    for (const [name, shape] of Object.entries(shapes)) {
      it(`${profile}: ${name}`, () => {
        const data = { ...base, ...shape } as BoothVoucherData;
        const before = buildBoothVoucherBefore471({ data, device: head });
        const now = buildDocument({ kind: 'booth_voucher', data }, undefined, head);
        expect(JSON.stringify(now)).toBe(JSON.stringify(before));
        expect(bytes(now, head).equals(bytes(before, head))).toBe(true);
      });
    }
  }
});
