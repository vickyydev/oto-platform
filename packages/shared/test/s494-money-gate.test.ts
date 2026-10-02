import { describe, expect, it } from 'vitest';
import { restockLineIds } from '../src/index';

/**
 * SCRUM-494 unit "money" — gate reproduction. In the approved design a SHOP
 * by-item refund restocks the lines it picks, full scope or not
 * (mockApi.ts:2881-2886: `refundedLineIds` wins whenever it is non-empty; only
 * a bare full-scope refund with no line ids returns every line).
 */
describe('s494 money gate — shop by-item refund that empties the sale', () => {
  it('returns only the picked line, not a line an earlier custom amount left with the customer', () => {
    expect(
      restockLineIds({
        saleKind: 'merch',
        mode: 'items',
        scope: 'full',
        coveredLineIds: ['bottle'],
        allLineIds: ['cap', 'bottle'],
        alreadyRestocked: new Set(),
        earlierFullScope: false,
      }),
    ).toEqual(['bottle']);
  });

  it('a whole or custom full-scope shop refund still returns every line not yet returned', () => {
    for (const mode of ['whole', 'custom'] as const) {
      expect(
        restockLineIds({
          saleKind: 'merch',
          mode,
          scope: 'full',
          coveredLineIds: mode === 'whole' ? ['bottle'] : [],
          allLineIds: ['cap', 'bottle'],
          alreadyRestocked: new Set(['cap']),
          earlierFullScope: false,
        }),
      ).toEqual(['bottle']);
    }
  });
});
