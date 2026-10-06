import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { businessDate, isoDateInTz, parseDayStart } from '@oto/shared';
import { PerformanceView } from '@/components/floor/PerformanceTab';
import { MobilePerformanceView } from '@/components/mobile/today/MobilePerformanceTab';
import { PerformanceFreshness } from '@/components/floor/PerformanceFreshness';
import { floorReportOf } from '@/api/analytics';
import type { AnalyticsSummaryRow } from '@oto/shared';

/**
 * S2-15b round 3 — RE-CHECK of the fix round (review finding 1, the blocker).
 *
 *   rule       with the device clock agreeing with the platform, the line
 *              prints a bare time exactly when the update is on the trading day
 *              in progress AND on today's calendar date; otherwise it names the
 *              update's own day. Checked over three days of clocks and updates
 *              (every 41 min x every 89 min back to 50 h), day start 05:00 (the
 *              branch default) and 00:00, so a bare time is never more than a
 *              day old and never from another calendar date.
 *   small hours  the real clock this review ran at (04:17 on the 7th, before
 *              the 05:00 day start), on the tab and the phone.
 */

Object.assign(globalThis, { React });

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const TZ = 'Asia/Bangkok';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `6 Oct, 01:42` as the line names a day, from the instant itself. */
function namedOf(at: Date): string {
  const [, month, day] = isoDateInTz(at, TZ).split('-').map(Number) as [number, number, number];
  const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(at);
  return `${day} ${MONTHS[month - 1]}, ${hm}`;
}

const bareOf = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(at);

afterEach(() => vi.useRealTimers());

describe('re-check — a bare time on the freshness line always means earlier today', () => {
  for (const dayStart of ['05:00', '00:00']) {
    it(`three days of clocks and updates, day start ${dayStart}: bare only for today's own updates, else the day is named`, () => {
      vi.useFakeTimers();
      const start = Date.parse('2026-10-05T00:00:00.000Z');
      let bare = 0;
      let named = 0;
      for (let n = 0; n < 72 * 60; n += 41) {
        const now = new Date(start + n * 60_000);
        vi.setSystemTime(now);
        const today = businessDate(now, TZ, parseDayStart(dayStart));
        for (let back = 0; back <= 50 * 60; back += 89) {
          const at = new Date(now.getTime() - back * 60_000);
          const line = text(
            React.createElement(PerformanceFreshness, {
              provisional: true,
              updatedAt: at.toISOString(),
              timezone: TZ,
              today,
              dayStart,
            }),
          );
          const earlierToday =
            businessDate(at, TZ, parseDayStart(dayStart)) === today && isoDateInTz(at, TZ) === isoDateInTz(now, TZ);
          const where = `now ${now.toISOString()}, update ${at.toISOString()}`;
          if (earlierToday) {
            bare += 1;
            expect(line, where).toBe(`Provisional — still being added up · Updated ${bareOf(at)}`);
            expect(now.getTime() - at.getTime(), where).toBeLessThan(24 * 3_600_000);
          } else {
            named += 1;
            expect(line, where).toBe(`Provisional — still being added up · Updated ${namedOf(at)}`);
          }
        }
      }
      expect(bare).toBeGreaterThan(100);
      expect(named).toBeGreaterThan(100);
    }, 60_000);
  }

  it('at 04:17 on the 7th (trading day the 6th), the tab and the phone: minutes ago is bare, last evening and a day ago are named', () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T21:17:00.000Z') }); // 04:17, 7 Oct, Bangkok
    const row: AnalyticsSummaryRow = {
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
    };
    const lineOn = (updatedAt: string) => {
      const performance = {
        report: floorReportOf(row, '2026-10-06', 'hkt-central'),
        provisional: true,
        updatedAt,
        timezone: TZ,
        error: null,
        today: '2026-10-06',
        businessDayStart: '05:00',
      };
      const pages = [
        text(React.createElement(PerformanceView, { performance, dropOffInPark: 0, isToday: true })),
        text(React.createElement(MobilePerformanceView, { performance, dropOffInPark: 0, isToday: true })),
      ];
      expect(pages[0]!.split(' Revenue ')[0]).toBe(pages[1]!.split(' Revenue ')[0]);
      return pages[0]!.split(' Revenue ')[0];
    };
    expect(lineOn('2026-10-06T21:10:00.000Z')).toBe('Provisional — still being added up · Updated 04:10');
    expect(lineOn('2026-10-06T16:00:00.000Z')).toBe('Provisional — still being added up · Updated 6 Oct, 23:00');
    expect(lineOn('2026-10-05T21:10:00.000Z')).toBe('Provisional — still being added up · Updated 6 Oct, 04:10');
  });
});
