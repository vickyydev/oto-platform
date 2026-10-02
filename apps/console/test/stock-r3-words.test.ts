import { describe, expect, it } from 'vitest';
import { SYNC_ANOMALY_KINDS } from '@oto/shared';
import { anomalyFacts, anomalyWords } from '@/lib/syncWords';

/**
 * THE FAILURES SURFACE'S WORDS FOR AN OFFLINE OVERSELL — S2-14b round 3 (plan
 * docs/progress/plans/stock/PLAN.md §2.4).
 *
 * Two counters sold the same last caps with the internet down, and when the
 * second sale reached the platform the record held fewer than it sold. The row
 * is read by somebody who is not an engineer, so it has to say what happened,
 * that the sale stands, that the record is at zero and not below, and what the
 * row names — in plain words, not the column's.
 */
describe('stock_oversold on Failures', () => {
  it('is a kind the console has a sentence for, not the fallback', () => {
    expect(SYNC_ANOMALY_KINDS).toContain('stock_oversold');
    const words = anomalyWords('stock_oversold');
    expect(words.label).toBe('Sold offline more than the shelves held');
    expect(words.what).toMatch(/two counters sold the same last ones while both were offline/);
    expect(words.what).toMatch(/The sale is filed as it was taken, because the guest paid/);
    expect(words.what).toMatch(/at zero, not below it/);
    expect(words.what).toMatch(/names the item, its size, the place, the box, the counter and how many were short/);
    expect(words.what).not.toMatch(/has not been taught/);
    expect(words.what).not.toMatch(/sync_anomaly|stock_movement|shortfall|level_after/);
  });

  it('lays the row’s evidence out as labelled facts, the readable ones first', () => {
    const facts = anomalyFacts({
      itemName: 'Oto Cap',
      sizeLabel: null,
      placeName: 'FOH',
      shortQuantity: 1,
      boxName: 'Virtual box 2 (virtual-2)',
      stationName: 'Counter 2',
      takenQuantity: 0,
      saleId: '018f0000-0000-7000-8000-00000000aa77',
    });
    // `sizeLabel` is null for a one-size item and is skipped, not printed as "null".
    expect(facts.map((f) => f.label)).toEqual([
      'Item name',
      'Place name',
      'Short quantity',
      'Box name',
      'Station name',
      'Taken quantity',
    ]);
    expect(facts.find((f) => f.label === 'Short quantity')?.value).toBe('1');
    expect(facts.find((f) => f.label === 'Station name')?.value).toBe('Counter 2');
  });
});
