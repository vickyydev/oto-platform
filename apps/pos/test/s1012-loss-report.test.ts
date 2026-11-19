import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StockLossEvent, StockReports, StockShrinkagePlace, StockShrinkageRow } from '@oto/shared';
import { ShrinkageReportBody, lossEventsCsv, shrinkageFiguresAt } from '@/components/mobile/stock/StockReports';

/**
 * SCRUM-1012 — the stock Reports' Shrinkage tab: today's figure kept, the six
 * additions beside it (plan docs/progress/plans/consistency/
 * RULINGS_BUILD_PLAN_2026-11-18.md, part E). Pure: the tab renders to markup
 * from a report the platform would send (no DOM, no fetch).
 */
// This runner compiles JSX to `React.createElement` (no React plugin, `vitest.config.ts`).
Object.assign(globalThis, { React });

const BRANCH = '0192f000-0000-7000-8000-00000000b012';
const FOH = '0192f000-0000-7000-8000-00000000c012';
const BOH = '0192f000-0000-7000-8000-00000000c013';
const STORE = '0192f000-0000-7000-8000-00000000c014';
const SHIRT = '0192f000-0000-7000-8000-00000000d012';
const CAP = '0192f000-0000-7000-8000-00000000d013';
const LOCKER = '0192f000-0000-7000-8000-00000000d014';
const BAND = '0192f000-0000-7000-8000-00000000d015';

const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const zero = {
  countVariance: 0, countedShort: 0, adjustedDown: 0, total: 0, lossSatang: 0, costMissing: false,
  correctedUp: 0, correctedUpSatang: 0, net: 0, opening: 0, openingCounted: 0, received: 0, sold: 0,
  closing: 0, notExplained: 0, soldBeyondRecord: 0, firstCountWithoutOpening: false, countedWithUnsentSales: false,
};
const place = (locationId: string, locationName: string, over: Partial<StockShrinkagePlace>): StockShrinkagePlace => ({
  locationId, locationName, ...zero, movedIn: 0, movedOut: 0, ...over,
});
const size = (stockItemId: string, name: string, over: Partial<StockShrinkageRow>): StockShrinkageRow => ({
  stockItemId, name, variantLabel: null, groupId: stockItemId, productKind: 'merch', ...zero, byPlace: [], byCause: [], ...over,
});

// The staging proof's week: 10 received, 3 sold, counted 2 short at the
// counter, 1 written down (damaged), 1 corrected up (found).
const shirt = size(SHIRT, 'ZZ TEST Loss Shirt', {
  countVariance: -2, countedShort: 1, adjustedDown: -1, total: -3, lossSatang: 36_000,
  correctedUp: 1, correctedUpSatang: 12_000, net: -2,
  opening: 0, received: 10, sold: 3, closing: 5, notExplained: 2,
  firstCountWithoutOpening: true,
  byPlace: [
    place(FOH, 'FOH', { countVariance: -2, countedShort: 1, total: -2, lossSatang: 24_000, correctedUp: 1, correctedUpSatang: 12_000, net: -1, sold: 3, movedIn: 7, closing: 3, notExplained: 1, firstCountWithoutOpening: true }),
    place(BOH, 'BOH', { adjustedDown: -1, total: -1, lossSatang: 12_000, net: -1, received: 10, movedOut: 7, closing: 2, notExplained: 1 }),
  ],
  byCause: [
    { cause: 'count', quantity: -2, lossSatang: 24_000 },
    { cause: 'damaged', quantity: -1, lossSatang: 12_000 },
  ],
});
const cap = size(CAP, 'ZZ TEST Cap', {
  countVariance: -1, countedShort: 1, total: -1, lossSatang: 9_000, net: -1, opening: 3, closing: 2, notExplained: 1,
  countedWithUnsentSales: true,
  byPlace: [place(STORE, 'ZZ TEST Store room', { countVariance: -1, countedShort: 1, total: -1, lossSatang: 9_000, net: -1, opening: 3, closing: 2, notExplained: 1, countedWithUnsentSales: true })],
  byCause: [{ cause: 'count', quantity: -1, lossSatang: 9_000 }],
});
const locker = size(LOCKER, 'ZZ TEST Locker', {
  adjustedDown: -1, total: -1, lossSatang: 0, costMissing: true, net: -1, opening: 15, closing: 14, notExplained: 1,
  byPlace: [place(BOH, 'BOH', { adjustedDown: -1, total: -1, lossSatang: 0, costMissing: true, net: -1, opening: 15, closing: 14, notExplained: 1 })],
  byCause: [{ cause: 'not_given', quantity: -1, lossSatang: 0 }],
});
// No loss, a correction up only — shown below the losses, never in today's tiles.
const band = size(BAND, 'ZZ TEST Glow Band', {
  correctedUp: 2, correctedUpSatang: 0, net: 2, opening: 5, closing: 7, notExplained: -2,
  byPlace: [place(FOH, 'FOH', { correctedUp: 2, net: 2, opening: 5, closing: 7, notExplained: -2 })],
});

const event = (over: Partial<StockLossEvent> & Pick<StockLossEvent, 'id' | 'kind' | 'quantity'>): StockLossEvent => ({
  stockItemId: SHIRT, name: 'ZZ TEST Loss Shirt', variantLabel: null, groupId: SHIRT, productKind: 'merch',
  locationId: FOH, locationName: 'FOH', expectedQuantity: null, countedQuantity: null, reasonType: null, reason: null,
  by: 'Mai', occurredAt: '2026-11-19T07:30:00.000Z', businessDate: '2026-11-19', lossSatang: null, costMissing: false,
  firstCountWithoutOpening: false, countedWithUnsentSales: false, ...over,
});
const events: StockLossEvent[] = [
  event({ id: '0192f000-0000-7000-8000-00000000e001', kind: 'write_down', quantity: -1, locationId: BOH, locationName: 'BOH', reasonType: 'damaged', reason: 'ZZ TEST torn, "box 2"', lossSatang: 12_000 }),
  event({ id: '0192f000-0000-7000-8000-00000000e002', kind: 'count', quantity: -2, expectedQuantity: 5, countedQuantity: 3, reason: 'Stock take — expected 5, counted 3', lossSatang: 24_000, firstCountWithoutOpening: true }),
];

const report = (withCost: boolean): StockReports => {
  const strip = <T extends { lossSatang: number | null }>(x: T): T => (withCost ? x : { ...x, lossSatang: null });
  const rows = [shirt, cap, locker, band].map((r) => ({
    ...strip(r),
    correctedUpSatang: withCost ? r.correctedUpSatang : null,
    byPlace: r.byPlace.map((p) => ({ ...strip(p), correctedUpSatang: withCost ? p.correctedUpSatang : null })),
    byCause: r.byCause.map(strip),
  }));
  return {
    branchId: BRANCH, from: '2026-11-19', to: '2026-11-19', withCost,
    discrepancies: [], usage: [], purchases: [], value: [],
    shrinkage: rows,
    shrinkageSummary: { sizesWithoutCost: 1, soldBeyondRecord: 2, soldBeyondRecordSizes: 1 },
    shrinkageEvents: events.map(strip),
  };
};

describe("today's figure is kept", () => {
  it('the tiles and the card read as before: 3 items with shrinkage, ฿450 lost at cost, the shirt −3 ea', () => {
    const html = markup(React.createElement(ShrinkageReportBody, { data: report(true), loading: false }));
    expect(html).toContain('Items with shrinkage');
    expect(html).toMatch(/>3<\/p><p[^>]*>Items with shrinkage/);
    expect(html).toContain('-฿450');
    expect(html).toContain('-3 ea');
    expect(html).toContain('Counted short 1× · corrections -1');
    expect(html).toContain('-฿360 at cost');
  });
});

describe('the six additions, beside it', () => {
  const html = markup(React.createElement(ShrinkageReportBody, { data: report(true), loading: false }));

  it('E1 — "Corrected up" and "Net" tiles, and the card’s corrected up and net', () => {
    expect(html).toMatch(/>\+3<\/p><p[^>]*>Corrected up · \+฿120/);
    expect(html).toMatch(/>-2 ea<\/p><p[^>]*>Net · -฿330/);
    expect(html).toContain('Corrected up +1 · net -2');
  });

  it('E2 — the period columns: opening, received, sold, closing, not explained', () => {
    for (const label of ['Opening', 'Received', 'Sold', 'Closing', 'Not explained']) expect(html).toContain(`>${label}</p>`);
    expect(html).toMatch(/>10<\/p><p[^>]*>Received/);
    expect(html).toMatch(/>2<\/p><p[^>]*>Not explained/);
  });

  it('E3 — each place with moves in and out, and the place filter', () => {
    expect(html).toMatch(/<option value=""[^>]*>All places<\/option>/);
    expect(html).not.toContain('-฿0 at cost');
    expect(html).toContain('ZZ TEST Store room');
    expect(html).toContain('-2 ea · up +1 · in 7');
    expect(html).toContain('-1 ea · out 7');
    const atFoh = markup(React.createElement(ShrinkageReportBody, { data: report(true), loading: false, initialPlaceId: FOH }));
    expect(atFoh).toContain('-2 ea');
    expect(atFoh).not.toContain('ZZ TEST Cap');
    expect(atFoh).toContain('-฿240');
    expect(shrinkageFiguresAt(shirt, BOH)).toMatchObject({ total: -1, received: 10, movedOut: 7 });
    expect(shrinkageFiguresAt(cap, FOH)).toBeNull();
  });

  it('E4 — the four warnings', () => {
    expect(html).toContain('1 size has no cost: the loss leaves it out');
    expect(html).toContain('FOH: First count at this place, with no opening count before it');
    expect(html).toContain('Counted while a counter box had sales it had not sent');
    expect(html).toContain('Sold beyond the record: 2 (1 size)');
  });

  it('E5 — the losses by cause, a correction recorded before types as "not given"', () => {
    expect(html).toContain('By cause: counts -2 · damaged -1');
    expect(html).toContain('By cause: not given -1');
  });

  it('E6 — the list of write-downs and count differences, with a download', () => {
    expect(html).toContain('Write-downs and count differences (2)');
    expect(html).toContain('Download CSV');
    expect(html).toContain('Write-down · Damaged — ZZ TEST torn, "box 2"');
    expect(html).toContain('Count · exp 5 → got 3');
  });

  it('a size with no loss but a correction up sits below the losses, out of today’s tiles', () => {
    expect(html).toContain('Corrected up or found, no loss');
    expect(html.indexOf('ZZ TEST Glow Band')).toBeGreaterThan(html.indexOf('Corrected up or found, no loss'));
  });
});

describe('the money stays a manager’s', () => {
  it('to anyone else: no baht anywhere, the loss tile a dash, no "no cost" warning', () => {
    const html = markup(React.createElement(ShrinkageReportBody, { data: report(false), loading: false }));
    expect(html).not.toContain('฿');
    expect(html).toMatch(/>—<\/p><p[^>]*>Est\. loss at cost/);
    expect(html).not.toContain('no cost: the loss');
    expect(html).toContain('-3 ea');
  });

  it('the download: the loss column only with the cost', () => {
    const withCost = lossEventsCsv(report(true).shrinkageEvents, true);
    expect(withCost.headers).toEqual(['Business date', 'When', 'Item', 'Size', 'Place', 'What', 'Quantity', 'Expected', 'Counted', 'Type', 'Reason', 'By', 'Loss at cost (THB)']);
    expect(withCost.rows[0]).toEqual(['2026-11-19', expect.stringMatching(/^2026-11-19 \d\d:30$/), 'ZZ TEST Loss Shirt', '', 'BOH', 'Write-down', -1, '', '', 'Damaged', 'ZZ TEST torn, "box 2"', 'Mai', 120]);
    expect(withCost.rows[1]).toEqual(['2026-11-19', expect.any(String), 'ZZ TEST Loss Shirt', '', 'FOH', 'Count difference', -2, 5, 3, '', 'Stock take — expected 5, counted 3', 'Mai', 240]);
    const without = lossEventsCsv(report(false).shrinkageEvents, false);
    expect(without.headers).not.toContain('Loss at cost (THB)');
    expect(without.rows.every((r) => r.length === 12)).toBe(true);
  });
});
