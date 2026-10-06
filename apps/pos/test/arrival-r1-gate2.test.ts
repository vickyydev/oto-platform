import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  branchTradingDate,
  setBranchDayStart,
  setBranchRateMode,
  setBranchTimezone,
  todayRateMode,
} from '@/lib/pricingMode';

/**
 * SCRUM-209 ROUND 1, RE-CHECK GATE — reproduction R1, the booking site's half.
 *
 * Since this round the platform REFUSES a booking whose shown total is not its
 * own quote (`createPublicBooking`, 409 `BOOKING_TOTAL_CHANGED`). The platform
 * quotes the booking at the rate of `branchToday(tz)` — the CALENDAR date in
 * Bangkok — and the public catalogue answers `rateMode` for that same calendar
 * date (`routes/public.ts`). The booking site prices the basket with
 * `todayRateMode()`, which keeps the catalogue's answer only while its date is
 * the branch's TRADING date (`businessDate` with the 05:00 day start) and
 * otherwise falls back to the trading date's own mode.
 *
 * Between 00:00 and 05:00 Bangkok the two dates differ. On a Saturday night the
 * site shows Friday's weekday total while the platform quotes Saturday's
 * weekend one (and the reverse early on a Monday), so every online booking in
 * those hours is refused. Each `it` states the behaviour owed: the site prices
 * at the rate the platform will quote.
 */

// What `loadPublicCatalog` hands the site: the branch's clock and the catalogue's rateMode.
function loadCatalogueAnswer(answer: { date: string; mode: 'weekday' | 'weekend' }): void {
  setBranchTimezone('Asia/Bangkok');
  setBranchDayStart('05:00:00');
  setBranchRateMode({
    date: answer.date,
    mode: answer.mode,
    reason: answer.mode === 'weekend' ? 'Weekend pricing' : 'Weekday pricing',
  });
}

afterEach(() => {
  setBranchRateMode(null);
  vi.useRealTimers();
});

describe('R1 — the booking site prices at the rate the platform quotes, at any hour', () => {
  it('Saturday 02:30 Bangkok: the catalogue says weekend (2026-10-03), so the site must too', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T19:30:00Z')); // Sat 2026-10-03 02:30 Asia/Bangkok
    // Exactly what GET /public/branches/:code/catalog answers at this instant.
    loadCatalogueAnswer({ date: '2026-10-03', mode: 'weekend' });
    // The precondition of the defect: the site's trading date is still Friday.
    expect(branchTradingDate()).toBe('2026-10-02');
    expect(todayRateMode().mode).toBe('weekend');
  });

  it('Monday 02:30 Bangkok: the catalogue says weekday (2026-10-05), so the site must too', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T19:30:00Z')); // Mon 2026-10-05 02:30 Asia/Bangkok
    loadCatalogueAnswer({ date: '2026-10-05', mode: 'weekday' });
    expect(branchTradingDate()).toBe('2026-10-04');
    expect(todayRateMode().mode).toBe('weekday');
  });
});
