import { describe, expect, it } from 'vitest';
import {
  STOCK_RULE_REORDER,
  STOCK_RULE_REORDER_TREND,
  STOCK_TREND_HISTORY_DAYS,
  StockReportQuerySchema,
  reorderPointFor,
} from '../src/stock';

/**
 * S2-14b round 4 — OD-27, the consumption-trend reorder rule
 * (docs/progress/plans/stock/PLAN.md §2.5, §4): the static reorder point until
 * the item has 30 days of sale history, then its 30-day usage × (lead time + a
 * safety day), rounded up to a whole each.
 */
describe('reorderPointFor (OD-27)', () => {
  const base = { staticPoint: 20, leadTimeDays: 10, usedInWindow: 25 };

  it('the static point while the first sale is 29 days old', () => {
    expect(reorderPointFor({ ...base, firstSaleDate: '2026-09-01', today: '2026-09-30' })).toEqual({
      rule: 'static',
      reorderPoint: 20,
      staticPoint: 20,
      usedInWindow: null,
    });
  });

  it('the trend point from the day the first sale is 30 days old: ceil(25 × 11 / 30) = 10', () => {
    expect(reorderPointFor({ ...base, firstSaleDate: '2026-09-01', today: '2026-10-01' })).toEqual({
      rule: 'trend',
      reorderPoint: 10,
      staticPoint: 20,
      usedInWindow: 25,
    });
    expect(STOCK_TREND_HISTORY_DAYS).toBe(30);
  });

  it('rounds UP to a whole each, and exactly on a whole figure stays there', () => {
    expect(reorderPointFor({ ...base, usedInWindow: 30, firstSaleDate: '2026-01-01', today: '2026-10-01' }).reorderPoint).toBe(11);
    expect(reorderPointFor({ ...base, usedInWindow: 1, firstSaleDate: '2026-01-01', today: '2026-10-01' }).reorderPoint).toBe(1);
  });

  it('a window where refunds outweigh sales is no usage, not a negative point', () => {
    expect(reorderPointFor({ ...base, usedInWindow: -4, firstSaleDate: '2026-01-01', today: '2026-10-01' })).toMatchObject({
      rule: 'trend',
      reorderPoint: 0,
      usedInWindow: 0,
    });
  });

  it('an item that never sold, or has no reorder settings, keeps the static answer', () => {
    expect(reorderPointFor({ ...base, firstSaleDate: null, today: '2026-10-01' }).rule).toBe('static');
    expect(reorderPointFor({ ...base, staticPoint: null, firstSaleDate: '2026-01-01', today: '2026-10-01' })).toMatchObject({
      rule: 'static',
      reorderPoint: null,
    });
    expect(reorderPointFor({ ...base, leadTimeDays: null, firstSaleDate: '2026-01-01', today: '2026-10-01' })).toMatchObject({
      rule: 'static',
      reorderPoint: 20,
    });
  });

  it('the two rules are worded apart on an attention row', () => {
    expect(STOCK_RULE_REORDER).toBe('≤ reorder point');
    expect(STOCK_RULE_REORDER_TREND).toBe('≤ reorder point (30-day usage)');
  });
});

describe('the report range', () => {
  it('takes inclusive business dates, yyyy-mm-dd', () => {
    expect(StockReportQuerySchema.safeParse({ from: '2026-09-26', to: '2026-10-02' }).success).toBe(true);
    expect(StockReportQuerySchema.safeParse({ from: '26/09/2026', to: '2026-10-02' }).success).toBe(false);
  });
});
