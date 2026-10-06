import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsSummaryRow } from '@oto/shared';
import { floorReportOf } from '@/api/analytics';
import { PerformanceView } from '@/components/floor/PerformanceTab';
import { MobilePerformanceView } from '@/components/mobile/today/MobilePerformanceTab';
import { PerformanceFreshness } from '@/components/floor/PerformanceFreshness';

/**
 * S2-15b round 3 — REVIEW of Today > Performance against the prototype
 * (imports/oto-pos/artifacts/oto-till/src/components/floor/PerformanceTab.tsx,
 * mobile/today/MobilePerformanceTab.tsx, RevenueBars.tsx, StatCard.tsx).
 *
 *   wording    every word the prototype's cards, bars and mix print, in order,
 *              on the iPad and the phone.
 *   figures    a day of awkward satang is drawn exactly as the row holds it:
 *              the headline is the row's revenue, the five bars its buckets,
 *              their shares the prototype's rounding.
 *   invented   no number on the screen that the row (or the live drop-off
 *              read, or the freshness time) does not carry.
 *   freshness  the last-updated line after a stalled rollup (a defect found
 *              here, pinned with `it.fails` until the fix round flipped it).
 */

Object.assign(globalThis, { React });

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Every bucket a different, awkward satang amount; every count distinct. */
function awkwardRow(over: Partial<AnalyticsSummaryRow> = {}): AnalyticsSummaryRow {
  const buckets = { ticketsSatang: 1_234_567, fnbSatang: 78_901, merchSatang: 5, partiesSatang: 0, dropoffSatang: 430_013 };
  return {
    ...buckets,
    revenueSatang: buckets.ticketsSatang + buckets.fnbSatang + buckets.merchSatang + buckets.partiesSatang + buckets.dropoffSatang,
    txnCount: 37,
    creditPaidSatang: 10_050,
    guestsKids: 41,
    guestsAdults: 29,
    mix1h: 13,
    mix2h: 17,
    mixFullDay: 23,
    partiesCount: 3,
    refundsSatang: 999_999,
    discountsSatang: 888_888,
    compsSatang: 777_777,
    vatSatang: 666_666,
    serviceSatang: 555_555,
    byChannel: { 'Sales Booth': { revenue: 444_444, txn_count: 97 } },
    businessDate: null,
    provisional: true,
    rolledDays: 1,
    computedAt: '2026-10-06T07:00:00.000Z',
    formulaVersion: 1,
    ...over,
  };
}

const view = (row: AnalyticsSummaryRow, updatedAt: string | null = '2026-10-06T07:05:00.000Z') => ({
  report: floorReportOf(row, '2026-10-06', 'hkt-central'),
  provisional: row.provisional,
  updatedAt,
  timezone: 'Asia/Bangkok',
  error: null,
});

const baht = (satang: number) => (satang / 100).toLocaleString();

describe('review — Performance in the prototype’s words, from the stored row', () => {
  const row = awkwardRow();
  const ipad = text(React.createElement(PerformanceView, { performance: view(row), dropOffInPark: 11, isToday: true }));
  const phone = text(React.createElement(MobilePerformanceView, { performance: view(row), dropOffInPark: 11, isToday: true }));

  it('the iPad prints the prototype’s cards, bars and mix in its order, with the row’s figures', () => {
    const total = row.revenueSatang;
    const pct = (s: number) => Math.round((s / total) * 100);
    expect(ipad).toBe(
      [
        `Provisional — still being added up · Updated 14:05`,
        `Revenue ฿${baht(total)} 37 transactions · excl. ฿${baht(10_050)} paid via credit`,
        `Guests checked in 70 41 kids · 29 adults`,
        `Parties today 3 Booked for this day`,
        `Drop-off kids in park 11 In the park right now`,
        `Revenue split`,
        `Tickets ฿${baht(row.ticketsSatang)} ${pct(row.ticketsSatang)}%`,
        `F&B ฿${baht(row.fnbSatang)} ${pct(row.fnbSatang)}%`,
        `Merch ฿${baht(row.merchSatang)} ${pct(row.merchSatang)}%`,
        `Parties ฿0 0%`,
        `Drop-off ฿${baht(row.dropoffSatang)} ${pct(row.dropoffSatang)}%`,
        `Ticket mix · guests by play length 13 1 hour 17 2 hours 23 Full day`,
      ].join(' '),
    );
    // The headline is the sum of the bars, to the satang.
    expect(ipad).toContain('Revenue ฿17,434.86 ');
    expect(ipad).toContain('Tickets ฿12,345.67 71%');
    expect(ipad).toContain('Merch ฿0.05 0%');
  });

  it('the phone prints the same figures in the prototype’s phone words and order', () => {
    expect(phone).toBe(
      [
        `Provisional — still being added up · Updated 14:05`,
        `Revenue ฿17,434.86 37 transactions · excl. ฿100.5 via credit`,
        `Guests checked in 70 41 kids · 29 adults`,
        `Revenue split`,
        `Tickets ฿12,345.67 71% F&B ฿789.01 5% Merch ฿0.05 0% Parties ฿0 0% Drop-off ฿4,300.13 25%`,
        `Parties today 3 Booked for this day`,
        `Drop-off kids in park 11 In the park right now`,
        `Ticket mix · guests by play length 13 1 hour 17 2 hours 23 Full day`,
      ].join(' '),
    );
  });

  it('draws no number the row does not carry: refunds, discounts, VAT, service and channels stay off the tab', () => {
    const allowed = new Set<string>([
      // The row, as the prototype's cards and bars print it.
      baht(row.revenueSatang),
      baht(row.creditPaidSatang),
      baht(row.ticketsSatang),
      baht(row.fnbSatang),
      baht(row.merchSatang),
      baht(row.partiesSatang),
      baht(row.dropoffSatang),
      ...[row.ticketsSatang, row.fnbSatang, row.merchSatang, row.partiesSatang, row.dropoffSatang].map((s) =>
        String(Math.round((s / row.revenueSatang) * 100)),
      ),
      ...[row.txnCount, row.guestsKids, row.guestsAdults, row.guestsKids + row.guestsAdults, row.partiesCount].map(String),
      ...[row.mix1h, row.mix2h, row.mixFullDay].map(String),
      // The live drop-off read, the mix labels ("1 hour", "2 hours"), the time.
      '11',
      '1',
      '2',
      '14',
      '05',
    ]);
    for (const page of [ipad, phone]) {
      const numbers = page.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
      for (const n of numbers) expect(allowed, `${n} on: ${page}`).toContain(n);
      for (const hidden of [row.refundsSatang, row.discountsSatang, row.compsSatang, row.vatSatang, row.serviceSatang, 444_444]) {
        expect(page).not.toContain(baht(hidden));
      }
    }
  });

  it('the live drop-off read is the only drop-off figure: unread is "—", never the report’s placeholder 0', () => {
    const page = text(React.createElement(PerformanceView, { performance: view(row), dropOffInPark: null, isToday: false }));
    expect(page).toContain('Drop-off kids in park — In the park right now');
    expect(page).toContain('Parties 3 Booked for this day');
    const phonePage = text(React.createElement(MobilePerformanceView, { performance: view(row), dropOffInPark: null, isToday: false }));
    expect(phonePage).toContain('Drop-off kids in park — In the park right now');
  });

  it('an ended day with no stored row reads as the prototype’s empty day, final, and never updated', () => {
    const none = awkwardRow({
      ticketsSatang: 0,
      fnbSatang: 0,
      merchSatang: 0,
      dropoffSatang: 0,
      revenueSatang: 0,
      txnCount: 0,
      creditPaidSatang: 0,
      guestsKids: 0,
      guestsAdults: 0,
      mix1h: 0,
      mix2h: 0,
      mixFullDay: 0,
      partiesCount: 0,
      provisional: false,
      rolledDays: 0,
      computedAt: null,
      formulaVersion: null,
    });
    const page = text(React.createElement(PerformanceView, { performance: view(none, none.computedAt), dropOffInPark: 0, isToday: false }));
    expect(page.startsWith('Not updated yet Revenue ฿0 0 transactions')).toBe(true);
    expect(page).not.toContain('Provisional');
    expect(page).not.toContain('Ticket mix');
    expect(page.endsWith('No sales recorded for this day yet.')).toBe(true);
  });
});

describe('review — the last-updated line after a stalled rollup', () => {
  afterEach(() => vi.useRealTimers());

  it('a day still being added up, rolled within the hour, says the time alone', () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T07:30:00.000Z') });
    const page = text(React.createElement(PerformanceFreshness, { provisional: true, updatedAt: '2026-10-06T07:05:00.000Z', timezone: 'Asia/Bangkok' }));
    expect(page).toBe('Provisional — still being added up · Updated 14:05');
  });

  /**
   * DEFECT FOUND IN REVIEW OF ROUND 3, FIXED IN THE FIX ROUND. When the rollup
   * has stalled since an earlier day — every daily run failing, or none run —
   * the API answers today as provisional with `lastRolledUpAt` a day old
   * (apps/api/test/s216-r3-review.test.ts, "a stalled rollup reads as
   * stalled"), and the line printed that instant as a bare time: at 03:42 on
   * 7 Oct a run from 01:42 on 6 Oct read "Updated 01:42", two hours old to
   * anyone looking. Was `it.fails`; the line now names the day.
   */
  it('an update from an earlier day names its day, not a bare time that reads as today', () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T20:42:00.000Z') }); // 03:42, 7 Oct, Bangkok
    const page = text(
      React.createElement(PerformanceFreshness, { provisional: true, updatedAt: '2026-10-05T18:42:00.000Z', timezone: 'Asia/Bangkok' }),
    );
    expect(page).toContain('6 Oct');
  });
});
