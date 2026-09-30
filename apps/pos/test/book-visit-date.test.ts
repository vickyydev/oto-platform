import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  branchTradingDate,
  getPricingDate,
  resolveRateToday,
  setBranchDayStart,
  setBranchRateMode,
  setBranchTimezone,
  setPricingDate,
  todayRateMode,
} from '@/lib/pricingMode';
import { clampVisitDate, formatVisitDate, visitDateBounds, VISIT_DATE_MAX_DAYS_AHEAD } from '@/lib/visitDate';
import { hydrateFromApi } from '@/store/catalogStore';

/**
 * S2-12 (SCRUM-209) FIX ROUND 2 — the booking site's visit date.
 *
 *   - The date step offers today through sixty days out, "today" being the
 *     branch's trading day; a typed date outside is brought back inside.
 *   - Every price on /book is the CHOSEN day's (`setPricingDate`): a weekend,
 *     or a weekday inside one of the catalogue's holiday ranges, is priced at
 *     weekend rates, by the same rule the platform quotes the booking with.
 *   - The platform's own answer is used while it is about the chosen day, and
 *     an answer is stale only when its day is BEHIND this device's trading day.
 *   - Clearing the date hands every other screen back to today.
 */

const WW = { weekday: 100, weekend: 150 };

beforeEach(() => {
  setBranchTimezone('Asia/Bangkok');
  setBranchDayStart('05:00:00');
  // The catalogue's holiday ranges, as `loadPublicCatalog` hydrates them.
  hydrateFromApi({
    perBranch: {},
    pricingOverrides: [{ id: 'pub-0', name: 'Loy Krathong', startDate: '2026-11-24', endDate: '2026-11-25' }],
  });
});

afterEach(() => {
  setPricingDate(null);
  setBranchRateMode(null);
  vi.useRealTimers();
});

describe('the date step’s bounds', () => {
  it('offers today through sixty days out', () => {
    expect(VISIT_DATE_MAX_DAYS_AHEAD).toBe(60);
    expect(visitDateBounds('2026-10-01')).toEqual({ min: '2026-10-01', max: '2026-11-30' });
    // Across a month and a year end.
    expect(visitDateBounds('2026-12-15').max).toBe('2027-02-13');
  });

  it('brings a typed date outside the window back to its nearest end', () => {
    expect(clampVisitDate('2026-09-30', '2026-10-01')).toBe('2026-10-01');
    expect(clampVisitDate('2027-01-15', '2026-10-01')).toBe('2026-11-30');
    expect(clampVisitDate('2026-11-24', '2026-10-01')).toBe('2026-11-24');
    expect(clampVisitDate('24/11/2026', '2026-10-01')).toBe('2026-10-01');
  });

  it('shows the day booked as a calendar day, whatever the phone’s timezone', () => {
    expect(formatVisitDate('2026-11-24', 'en')).toContain('24');
    expect(formatVisitDate('2026-11-24', 'en')).toMatch(/Tuesday/);
    expect(formatVisitDate('not-a-date', 'en')).toBe('not-a-date');
  });
});

describe('every price on /book is the chosen day’s', () => {
  it('a weekday, a Saturday and a weekday inside a holiday range', () => {
    setPricingDate('2026-10-07'); // Wednesday
    expect(todayRateMode().mode).toBe('weekday');
    expect(resolveRateToday(WW)).toBe(100);

    setPricingDate('2026-10-10'); // Saturday
    expect(todayRateMode().mode).toBe('weekend');
    expect(resolveRateToday(WW)).toBe(150);

    setPricingDate('2026-11-24'); // Tuesday, Loy Krathong
    expect(todayRateMode()).toMatchObject({ mode: 'weekend', overrideName: 'Loy Krathong' });
    expect(resolveRateToday(WW)).toBe(150);

    setPricingDate('2026-11-26'); // the day after the range
    expect(todayRateMode().mode).toBe('weekday');
  });

  it('uses the platform’s answer while it is about the chosen day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T03:00:00Z')); // Wednesday 10:00 Bangkok
    setBranchRateMode({ date: '2026-10-07', mode: 'weekend', reason: 'Weekend pricing — a closure the platform knows' });
    setPricingDate('2026-10-07');
    expect(todayRateMode().reason).toBe('Weekend pricing — a closure the platform knows');
    // Another day is priced by the rule, not by today's answer.
    setPricingDate('2026-10-08');
    expect(todayRateMode()).toMatchObject({ mode: 'weekday', reason: 'Weekday pricing' });
  });

  it('clearing the date hands the rest of the app back to today', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T03:00:00Z')); // Wednesday
    setPricingDate('2026-10-10');
    expect(getPricingDate()).toBe('2026-10-10');
    expect(todayRateMode().mode).toBe('weekend');
    setPricingDate(null);
    expect(getPricingDate()).toBeNull();
    expect(todayRateMode().mode).toBe('weekday');
    // Garbage is not a date to price.
    setPricingDate('10/10/2026');
    expect(getPricingDate()).toBeNull();
  });
});

describe('the platform’s answer goes stale only when its day is behind this device’s', () => {
  it('an answer from before the trading day rolled is ignored', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T21:55:00Z')); // Sat 04:55 Bangkok: trading day Friday
    setBranchRateMode({ date: '2026-10-02', mode: 'weekday', reason: 'Weekday pricing' });
    expect(todayRateMode().mode).toBe('weekday');
    vi.setSystemTime(new Date('2026-10-02T22:05:00Z')); // Sat 05:05: trading day Saturday
    expect(branchTradingDate()).toBe('2026-10-03');
    expect(todayRateMode().mode).toBe('weekend');
  });

  it('an answer dated ahead of a slow device is the platform’s, and is used', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T21:58:00Z')); // this device: Sat 04:58, trading day Friday
    setBranchRateMode({ date: '2026-10-03', mode: 'weekend', reason: 'Weekend pricing' });
    expect(branchTradingDate()).toBe('2026-10-02');
    expect(todayRateMode().mode).toBe('weekend');
  });
});
