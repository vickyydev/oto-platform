import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsSummaryRow } from '@oto/shared';
import { floorReportOf } from '@/api/analytics';
import { PerformanceView, type PerformanceViewState } from '@/components/floor/PerformanceTab';
import { MobilePerformanceView } from '@/components/mobile/today/MobilePerformanceTab';
import { PerformanceFreshness } from '@/components/floor/PerformanceFreshness';

/**
 * S2-15b round 3, FIX ROUND — the last-updated line is honest about an
 * update from an earlier day (review finding 1). A bare time reads as
 * "earlier today", so it is printed bare only when it is one: on the trading
 * day the platform says is in progress at the branch (`branches[].today`,
 * with its day start) and, when this device's clock agrees on that day, on
 * the clock's calendar date. Anything older names its day.
 *
 * Times below are Asia/Bangkok (UTC+7), day start 05:00.
 */

Object.assign(globalThis, { React });

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ZERO: Partial<AnalyticsSummaryRow> = {
  ticketsSatang: 0,
  fnbSatang: 0,
  merchSatang: 0,
  partiesSatang: 0,
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
};

function row(over: Partial<AnalyticsSummaryRow> = {}): AnalyticsSummaryRow {
  return {
    ticketsSatang: 0,
    fnbSatang: 0,
    merchSatang: 0,
    partiesSatang: 0,
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
    refundsSatang: 0,
    discountsSatang: 0,
    compsSatang: 0,
    vatSatang: 0,
    serviceSatang: 0,
    byChannel: {},
    businessDate: null,
    provisional: true,
    rolledDays: 0,
    computedAt: null,
    formulaVersion: null,
    ...over,
  };
}

/** The state `usePerformance` hands the tab for today's date, as the platform answered. */
function state(date: string, today: string, updatedAt: string | null, over: Partial<AnalyticsSummaryRow> = ZERO): PerformanceViewState {
  const r = row(over);
  return {
    report: floorReportOf(r, date, 'hkt-central'),
    provisional: r.provisional,
    updatedAt,
    timezone: 'Asia/Bangkok',
    error: null,
    today,
    businessDayStart: '05:00',
  };
}

afterEach(() => vi.useRealTimers());

describe('fix round — the freshness line after a stalled rollup', () => {
  it('the review’s case on the tab: at 03:42 on the 7th, an update from 01:42 on the 6th names the 6th', () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T20:42:00.000Z') }); // 03:42, 7 Oct
    // 03:42 is before the 05:00 day start, so the trading day is still the 6th.
    const performance = state('2026-10-06', '2026-10-06', '2026-10-05T18:42:00.000Z');
    for (const page of [
      text(React.createElement(PerformanceView, { performance, dropOffInPark: 0, isToday: true })),
      text(React.createElement(MobilePerformanceView, { performance, dropOffInPark: 0, isToday: true })),
    ]) {
      expect(page).toContain('Provisional — still being added up · Updated 6 Oct, 01:42');
      expect(page).not.toMatch(/Updated 01:42/);
      expect(page).toContain('No sales recorded for today yet.');
    }
  });

  it('a stall from earlier in the same trading day still names its day once the calendar has moved on', () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T20:42:00.000Z') }); // 03:42, 7 Oct; trading day the 6th
    const page = text(
      React.createElement(PerformanceView, {
        performance: state('2026-10-06', '2026-10-06', '2026-10-05T23:00:00.000Z'), // 06:00, 6 Oct
        dropOffInPark: 0,
        isToday: true,
      }),
    );
    expect(page).toContain('Updated 6 Oct, 06:00');
  });

  it('an update from earlier today is a bare time, as before', () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T07:30:00.000Z') }); // 14:30, 7 Oct
    const performance = state('2026-10-07', '2026-10-07', '2026-10-07T07:05:00.000Z');
    const page = text(React.createElement(PerformanceView, { performance, dropOffInPark: 0, isToday: true }));
    expect(page).toContain('Provisional — still being added up · Updated 14:05');
  });

  it('after midnight, before the day start, an update from the evening before is still this trading day’s', () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T18:30:00.000Z') }); // 01:30, 7 Oct; trading day the 6th
    const late = text(
      React.createElement(PerformanceFreshness, {
        provisional: true,
        updatedAt: '2026-10-06T18:25:00.000Z', // 01:25, 7 Oct
        timezone: 'Asia/Bangkok',
        today: '2026-10-06',
        dayStart: '05:00',
      }),
    );
    expect(late).toBe('Provisional — still being added up · Updated 01:25');
    const evening = text(
      React.createElement(PerformanceFreshness, {
        provisional: true,
        updatedAt: '2026-10-06T16:50:00.000Z', // 23:50, 6 Oct
        timezone: 'Asia/Bangkok',
        today: '2026-10-06',
        dayStart: '05:00',
      }),
    );
    // Same trading day, but an earlier calendar date than the clock's: named.
    expect(evening).toBe('Provisional — still being added up · Updated 6 Oct, 23:50');
  });

  it('a till clock on the wrong date is not believed: the platform’s trading day decides', () => {
    vi.useFakeTimers({ now: new Date('2026-10-09T03:00:00.000Z') }); // the till thinks it is the 9th
    const today = text(
      React.createElement(PerformanceFreshness, {
        provisional: true,
        updatedAt: '2026-10-06T07:05:00.000Z', // 14:05, 6 Oct
        timezone: 'Asia/Bangkok',
        today: '2026-10-06',
        dayStart: '05:00',
      }),
    );
    expect(today).toBe('Provisional — still being added up · Updated 14:05');
    const stale = text(
      React.createElement(PerformanceFreshness, {
        provisional: true,
        updatedAt: '2026-10-05T07:05:00.000Z', // 14:05, 5 Oct
        timezone: 'Asia/Bangkok',
        today: '2026-10-06',
        dayStart: '05:00',
      }),
    );
    expect(stale).toBe('Provisional — still being added up · Updated 5 Oct, 14:05');
  });

  it('a day that has ended still always names its day; never updated is still "Not updated yet"', () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T07:30:00.000Z') });
    expect(
      text(React.createElement(PerformanceFreshness, { provisional: false, updatedAt: '2026-10-07T07:05:00.000Z', timezone: 'Asia/Bangkok' })),
    ).toBe('Updated 7 Oct, 14:05');
    expect(text(React.createElement(PerformanceFreshness, { provisional: true, updatedAt: null, timezone: 'Asia/Bangkok' }))).toBe(
      'Provisional — still being added up · Not updated yet',
    );
  });
});
