import { describe, expect, it } from 'vitest';
import { bandStockOf, gapFieldLabel, withBandStock } from '@/lib/bandStock';

/**
 * The band printer's settings form: what it reads from the row and what it
 * writes back, with the rest of the label section carried along.
 */

describe('bandStockOf', () => {
  it('starts from gap sensing and nothing set when the row has no label section', () => {
    expect(bandStockOf(undefined)).toEqual({ sensing: 'gap', gapMm: null, printOffsetMm: null, printLengthMm: null });
    expect(bandStockOf(null)).toEqual({ sensing: 'gap', gapMm: null, printOffsetMm: null, printLengthMm: null });
  });

  it('reads what the row says', () => {
    expect(bandStockOf({ sensing: 'bline', gapMm: 3, printOffsetMm: 60, printLengthMm: 120 })).toEqual({
      sensing: 'bline',
      gapMm: 3,
      printOffsetMm: 60,
      printLengthMm: 120,
    });
  });
});

describe('withBandStock', () => {
  it('writes the form over the row and keeps the rest of the section', () => {
    expect(
      withBandStock(
        { labelWidthMm: 25, labelHeightMm: 254, darkness: 9 },
        { sensing: 'bline', gapMm: 3, printOffsetMm: 60, printLengthMm: 120 },
      ),
    ).toEqual({ labelWidthMm: 25, labelHeightMm: 254, darkness: 9, sensing: 'bline', gapMm: 3, printOffsetMm: 60, printLengthMm: 120 });
  });

  it('drops a number the form left empty rather than writing null', () => {
    const next = withBandStock(
      { gapMm: 3, printOffsetMm: 60, printLengthMm: 120 },
      { sensing: 'gap', gapMm: null, printOffsetMm: null, printLengthMm: null },
    );
    expect(next).toEqual({ sensing: 'gap' });
    expect('gapMm' in next).toBe(false);
  });
});

describe('gapFieldLabel', () => {
  it('names the measurement the number means under each sensing', () => {
    expect(gapFieldLabel('gap')).toBe('Gap (mm)');
    expect(gapFieldLabel('bline')).toBe('Mark height (mm)');
  });
});
