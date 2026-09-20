import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allFixtures } from './render-fixture';
import { shapeText } from '../src/index';
import { decodePreviewPng } from './png-reader';
import { FIXTURES } from './fixtures';

/**
 * The committed fixtures are the contract. A change to a template, a font or
 * the rasteriser moves them, and the diff is the review: a fixture that shifted
 * by a dot is usually a metric change worth understanding, and one that shifted
 * by a hundred is a mistake.
 *
 * Regenerate with `pnpm --filter @oto/print fixtures`.
 */

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const built = allFixtures();

describe('fixtures', () => {
  it('covers all nine printouts', () => {
    expect(FIXTURES.map((f) => f.job.kind).sort()).toEqual(
      [
        'adult_wristband',
        'bar_ticket',
        'booth_voucher',
        'credit_voucher',
        'item_voucher',
        'kids_wristband',
        'kitchen_ticket',
        'receipt',
        'test_page',
      ].sort(),
    );
  });

  for (const fixture of built) {
    describe(fixture.key, () => {
      it('emits the committed device bytes', () => {
        const expected = readFileSync(`${dir}${fixture.key}.bin`);
        expect(Buffer.from(fixture.job.bytes).equals(expected)).toBe(true);
      });

      it('renders the committed preview, pixel for pixel', () => {
        // Not byte equality: `deflateSync` output is not byte-specified and
        // Node has shipped different zlib builds, so the committed PNG's IDAT
        // is a property of the machine that wrote it. The pixels are the
        // contract, and comparing them against the *rendered bitmap* also
        // proves what byte equality never did — that the picture the admin
        // panel shows is the raster the head would lay down.
        const committed = decodePreviewPng(readFileSync(`${dir}${fixture.key}.png`));
        expect(committed.width).toBe(fixture.job.bitmap.width);
        expect(committed.height).toBe(fixture.job.bitmap.height);
        expect(Buffer.from(committed.data).equals(Buffer.from(fixture.job.bitmap.data))).toBe(true);
        // And the PNG this run produced decodes to the same thing.
        expect(
          Buffer.from(decodePreviewPng(fixture.png).data).equals(Buffer.from(committed.data)),
        ).toBe(true);
      });

      it('lays out as committed', () => {
        expect(fixture.layout).toBe(readFileSync(`${dir}${fixture.key}.layout.json`, 'utf8'));
      });

      it('puts ink on the page', () => {
        expect(fixture.job.bitmap.countInk()).toBeGreaterThan(200);
      });
    });
  }
});

describe('the acceptance strings render with no missing-glyph boxes', () => {
  // The criterion is about *these* strings, which the bundled faces cover, and
  // the check is that nothing in them came out as a box. Anything else a guest
  // types degrades to a box and a note instead of stopping the job — see
  // `fonts.test.ts` — so "no boxes" has to be asserted here rather than
  // inferred from the renderer refusing to draw one.
  for (const text of [
    'สวัสดี OTO Park',
    'Привет',
    '欢迎光临',
    'ใช้ได้ 1 ครั้ง',
    '฿1,090.50',
    '★ YOU WON ★',
  ]) {
    it(JSON.stringify(text), () => {
      for (const weight of ['regular', 'bold'] as const) {
        const shaped = shapeText(text, { sizeDots: 24, weight });
        expect(shaped.missing).toEqual([]);
        expect(shaped.glyphs.filter((g) => g.tofu ?? g.gid === 0)).toEqual([]);
        expect(shaped.width).toBeGreaterThan(0);
      }
    });
  }

  it('leaves no fixture printing a box', () => {
    for (const fixture of built) {
      const boxes = fixture.job.overflow.filter((note) => note.includes('printed as boxes'));
      expect(boxes, fixture.key).toEqual([]);
    }
  });
});
