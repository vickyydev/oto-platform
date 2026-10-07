import { describe, expect, it } from 'vitest';
import {
  ageOnDate,
  attendanceDaysOf,
  campDays,
  eventListedOn,
  eventPassOfferedOn,
  eventRosterBucket,
  eventRosterStats,
  otoEventStatusOf,
} from '../src/events';

/**
 * S2-20 E1 — the prototype's event rules, ported (plan
 * docs/progress/plans/events-kiosk/PLAN.md §3, §4): which events a day lists
 * (a camp on every day of its range, Q4), which are sold as passes
 * (`getActiveEventPasses`), and where a child sits on a day's roster
 * (`bucketAttendee`, `computeRosterStats`).
 */

const camp = { type: 'camp' as const, startDate: '2026-11-02', endDate: '2026-11-06' };
const openCamp = { type: 'camp' as const, startDate: '2026-11-02', endDate: null };
const workshop = { type: 'event' as const, startDate: '2026-11-04', endDate: '2026-11-04' };
const party = { type: 'party' as const, startDate: '2026-11-04', endDate: '2026-11-04' };
const price = { weekdaySatang: 35_000, weekendSatang: 40_000 };

describe('which events a day lists', () => {
  it('a camp on every day of its range, from the first to the last, and on none outside (Q4)', () => {
    for (const d of campDays('2026-11-02', '2026-11-06')) expect(eventListedOn(camp, d), d).toBe(true);
    expect(eventListedOn(camp, '2026-11-01')).toBe(false);
    expect(eventListedOn(camp, '2026-11-07')).toBe(false);
  });

  it('an open-ended camp from its first day on, as the OTO App reads it', () => {
    expect(eventListedOn(openCamp, '2026-11-01')).toBe(false);
    expect(eventListedOn(openCamp, '2027-03-01')).toBe(true);
  });

  it('a one-off event and a party on their own day only', () => {
    expect(eventListedOn(workshop, '2026-11-04')).toBe(true);
    expect(eventListedOn(workshop, '2026-11-05')).toBe(false);
    expect(eventListedOn(party, '2026-11-03')).toBe(false);
  });
});

describe('which events are sold as passes', () => {
  it('a running camp, an event today or later; never a party; never an unpriced event', () => {
    expect(eventPassOfferedOn({ ...camp, entryPrice: price }, '2026-11-04')).toBe(true);
    expect(eventPassOfferedOn({ ...camp, entryPrice: price }, '2026-11-01')).toBe(false);
    expect(eventPassOfferedOn({ ...camp, entryPrice: price }, '2026-11-07')).toBe(false);
    expect(eventPassOfferedOn({ ...workshop, entryPrice: price }, '2026-11-01')).toBe(true);
    expect(eventPassOfferedOn({ ...workshop, entryPrice: price }, '2026-11-05')).toBe(false);
    expect(eventPassOfferedOn({ ...party, entryPrice: price }, '2026-11-04')).toBe(false);
    expect(eventPassOfferedOn({ ...workshop, entryPrice: null }, '2026-11-04')).toBe(false);
  });
});

describe("a registration's days", () => {
  it('a camp registration naming no day attends every day of the camp, written out', () => {
    expect(attendanceDaysOf(camp, { attendsAllDays: true, attendanceDays: [] }, '2026-11-03')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    // Open-ended: through the day asked about.
    expect(attendanceDaysOf(openCamp, { attendsAllDays: true, attendanceDays: [] }, '2026-11-04')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('named days are kept, sorted, and a one-off event carries none', () => {
    expect(
      attendanceDaysOf(camp, { attendsAllDays: false, attendanceDays: ['2026-11-05', '2026-11-03', 'junk'] }, '2026-11-03'),
    ).toEqual(['2026-11-03', '2026-11-05']);
    expect(attendanceDaysOf(workshop, { attendsAllDays: true, attendanceDays: [] }, '2026-11-04')).toEqual([]);
  });

  it('a range that is not a range is no days, and a mistyped year is cut off', () => {
    expect(campDays('2026-11-06', '2026-11-02')).toEqual([]);
    expect(campDays('2026-11-02', '2036-11-02')).toHaveLength(366);
  });
});

describe('the roster (bucketAttendee, computeRosterStats)', () => {
  it('out, in, not today on a camp, otherwise outstanding', () => {
    expect(eventRosterBucket({ checkedInAt: 'x', checkedOutAt: 'y' }, true, true)).toBe('out');
    expect(eventRosterBucket({ checkedInAt: 'x', checkedOutAt: null }, true, false)).toBe('in');
    expect(eventRosterBucket(null, true, false)).toBe('notToday');
    expect(eventRosterBucket(null, true, true)).toBe('outstanding');
    expect(eventRosterBucket(undefined, false, false)).toBe('outstanding');
  });

  it('arrived = in + out; expected = arrived + outstanding; all counts not today too', () => {
    expect(eventRosterStats(['in', 'out', 'outstanding', 'outstanding', 'notToday'])).toEqual({
      arrived: 2,
      expected: 4,
      currentlyIn: 1,
      outstanding: 2,
      all: 5,
    });
  });
});

describe('the small conversions', () => {
  it('whole years on the day', () => {
    expect(ageOnDate('2019-11-04', '2026-11-03')).toBe(6);
    expect(ageOnDate('2019-11-04', '2026-11-04')).toBe(7);
    expect(ageOnDate(null, '2026-11-04')).toBeNull();
    expect(ageOnDate('2027-01-01', '2026-11-04')).toBeNull();
  });

  it("an app status the POS has no label for reads as upcoming", () => {
    expect(otoEventStatusOf('cancelled')).toBe('cancelled');
    expect(otoEventStatusOf('confirmed')).toBe('upcoming');
  });
});
