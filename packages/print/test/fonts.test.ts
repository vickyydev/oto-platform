import { describe, expect, it } from 'vitest';
import { shapeText } from '../src/fonts/shape';
import { fontStack } from '../src/fonts/stack';
import { renderJob } from '../src/index';
import { PROFILES, TEMPLATES } from './fixtures';

describe('font stack', () => {
  it('picks the Thai face for Thai and for the baht sign', () => {
    const stack = fontStack('regular');
    expect(stack.fontFor(0x0e2a)?.id).toBe('thai'); // ส
    // formatTHB puts U+0E3F on every money row; it lives in the Thai block, so
    // it must resolve through the Thai face rather than fall off the chain.
    expect(stack.fontFor(0x0e3f)?.id).toBe('thai');
  });

  it('picks the Latin face for Latin and Cyrillic', () => {
    const stack = fontStack('regular');
    expect(stack.fontFor(0x0041)?.id).toBe('latin');
    expect(stack.fontFor(0x041f)?.id).toBe('latin'); // П
  });

  it('covers every code point in the acceptance fixtures', () => {
    for (const s of ['สวัสดี OTO Park', 'Привет', '฿1,090.50']) {
      expect(() => shapeText(s, { sizeDots: 24, weight: 'regular' })).not.toThrow();
    }
  });
});

describe('shaping', () => {
  it('gives a Thai three-level stack more ink above the baseline than Latin', () => {
    const style = { sizeDots: 24, weight: 'regular' as const };
    const latin = shapeText('Park', style);
    // ญี่ปุ่น: ญ carries a vowel with a tone mark above it, and ป carries a
    // below-vowel with a tone mark above. Three levels up, one down.
    const thai = shapeText('ญี่ปุ่น', style);
    expect(thai.inkAbove).toBeGreaterThan(latin.inkAbove);
    expect(thai.inkBelow).toBeGreaterThan(latin.inkBelow);
  });

  it('positions tone marks above vowels rather than at the glyph origin', () => {
    // น้ำ stacks a tone mark over a vowel over the base. Without GPOS mark and
    // mkmk the two marks would land at the same height.
    const glyphs = shapeText('น้ำ', { sizeDots: 48, weight: 'regular' }).glyphs;
    const ys = glyphs.map((g) => g.y).filter((y) => y !== 0);
    expect(ys.length).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeGreaterThan(0);
  });

  it('gives combining marks no advance of their own', () => {
    const style = { sizeDots: 24, weight: 'regular' as const };
    const bare = shapeText('นา', style).width;
    const marked = shapeText('น้า', style).width;
    expect(marked).toBeCloseTo(bare, 5);
  });

  it('measures mixed-script lines as the sum of their runs', () => {
    const style = { sizeDots: 24, weight: 'regular' as const };
    const mixed = shapeText('Nong Mai · น้องใหม่', style);
    expect(mixed.width).toBeGreaterThan(shapeText('Nong Mai · ', style).width);
    expect(mixed.glyphs.some((g) => g.font?.id === 'thai')).toBe(true);
    expect(mixed.glyphs.some((g) => g.font?.id === 'latin')).toBe(true);
  });
});

describe('nothing a guest can type stops a receipt', () => {
  const style = { sizeDots: 24, weight: 'regular' as const };

  // The bundled Chinese face is a 39-character subset, so a visitor's name is
  // the first caller-supplied string that leaves it. These are the cases a
  // reception desk in Phuket meets, plus one that no font would cover.
  for (const [what, text] of [
    ['a Chinese name outside the subset', '王明'],
    ['another Chinese name', '李伟'],
    ['Korean', '한국'],
    ['Japanese kana', 'さくら'],
    ['a symbol', '☺'],
    ['an unassigned plane', '\u{10FFFD}'],
  ] as const) {
    it(`draws a box for ${what} and says which character`, () => {
      const shaped = shapeText(text, style);
      expect(shaped.width).toBeGreaterThan(0);
      expect(shaped.glyphs.length).toBe([...text].length);
      expect(shaped.glyphs.every((g) => g.tofu !== undefined)).toBe(true);
      expect(shaped.missing).toEqual([...text].map((ch) => ch.codePointAt(0)));
      // A box has to reach above the baseline, or it is not visible ink.
      expect(shaped.inkAbove).toBeGreaterThan(0);
    });
  }

  it('keeps the covered part of a mixed name as real glyphs', () => {
    // 小 happens to be in the 39-character subset (it is in 收据小票) and 王 and
    // 明 are not, so this name degrades character by character rather than
    // falling back wholesale.
    const shaped = shapeText('Member: 王小明', style);
    expect(shaped.glyphs.filter((g) => g.tofu).length).toBe(2);
    expect(shaped.glyphs.some((g) => g.font?.id === 'latin')).toBe(true);
    expect(shaped.glyphs.some((g) => g.font?.id === 'sc')).toBe(true);
    expect(shaped.missing.map((cp) => cp.toString(16))).toEqual(['738b', '660e']);
  });

  it('renders a whole receipt for that member and reports it in overflow', () => {
    const job = renderJob(
      {
        kind: 'receipt',
        data: {
          title: 'Receipt',
          memberNickname: '王小明',
          lines: [{ qty: 1, name: 'Adult Pass', price: '฿150' }],
          total: '฿150',
        },
      },
      { device: PROFILES.escpos576!, templates: TEMPLATES },
    );
    expect(job.bytes.length).toBeGreaterThan(0);
    expect(job.bitmap.countInk()).toBeGreaterThan(200);
    expect(job.overflow.join('\n')).toMatch(/no bundled font covers U\+738B 王/);
  });
});
