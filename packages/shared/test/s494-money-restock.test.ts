import { describe, expect, it } from 'vitest';
import { refundScopeOf, restockLineIds } from '../src/index';

/**
 * SCRUM-494 register entry 3 — the restock trigger is the approved design's
 * full-scope rule (RefundModal.tsx:95-97, mockApi.ts:2884-2950): a refund that
 * takes everything still left is full-scope in any mode, and the first one
 * returns every line not already returned.
 */
describe('s494 money — refund scope', () => {
  it('is full whenever the amount reaches what is left, in any mode', () => {
    expect(refundScopeOf(500_00, 500_00)).toBe('full');
    expect(refundScopeOf(499_99, 500_00)).toBe('partial');
    expect(refundScopeOf(0, 0)).toBe('full');
  });
});

describe('s494 money — restock on the first full-scope refund', () => {
  const all = ['kids', 'socks', 'addon'];
  const base = {
    allLineIds: all,
    alreadyRestocked: new Set<string>(),
    earlierFullScope: false,
  };

  it('a by-item ticket refund that takes the whole remainder returns every line', () => {
    expect(
      restockLineIds({ ...base, saleKind: 'ticket', mode: 'items', scope: 'full', coveredLineIds: ['kids'] }),
    ).toEqual(all);
  });

  it('a custom F&B refund of the full remainder returns every line', () => {
    expect(
      restockLineIds({ ...base, saleKind: 'fnb', mode: 'custom', scope: 'full', coveredLineIds: [] }),
    ).toEqual(all);
  });

  it('a custom shop refund of the full remainder returns every line not yet returned', () => {
    expect(
      restockLineIds({
        ...base,
        saleKind: 'merch',
        mode: 'custom',
        scope: 'full',
        coveredLineIds: [],
        alreadyRestocked: new Set(['socks']),
      }),
    ).toEqual(['kids', 'addon']);
  });

  it('a whole refund after a by-item ticket refund returns the lines the earlier one covered', () => {
    // The earlier by-item refund covered `socks` but, being partial, returned nothing.
    expect(
      restockLineIds({ ...base, saleKind: 'ticket', mode: 'whole', scope: 'full', coveredLineIds: ['kids', 'addon'] }),
    ).toEqual(all);
  });

  it('a partial ticket refund returns nothing, whatever mode', () => {
    for (const mode of ['items', 'custom'] as const) {
      expect(
        restockLineIds({ ...base, saleKind: 'ticket', mode, scope: 'partial', coveredLineIds: ['socks'] }),
      ).toEqual([]);
    }
  });

  it('never returns a line twice, nor after an earlier full-scope refund', () => {
    expect(
      restockLineIds({
        ...base,
        saleKind: 'merch',
        mode: 'items',
        scope: 'full',
        coveredLineIds: ['socks'],
        alreadyRestocked: new Set(all),
      }),
    ).toEqual([]);
    expect(
      restockLineIds({ ...base, saleKind: 'fnb', mode: 'custom', scope: 'full', coveredLineIds: [], earlierFullScope: true }),
    ).toEqual([]);
  });
});
