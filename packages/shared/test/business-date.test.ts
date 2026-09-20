import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSINESS_DAY_START_MINUTES,
  ISO_DATE_FORMAT_OPTIONS,
  WALL_CLOCK_FORMAT_OPTIONS,
  addDaysToIsoDate,
  branchToday,
  businessDate,
  parseDayStart,
  wallClockMinutesInTz,
} from '../src/index';
import { PRICING_FIXTURES } from '../src/fixtures/index';

const BANGKOK = 'Asia/Bangkok';

/**
 * The business date is the one rule in this engine with no prototype behind it,
 * so it is tested harder than anything else here: every minute of a day, across
 * the branch timezone rather than the machine's, from a machine deliberately
 * put in a timezone that is neither.
 */

describe('business date — the fixture cases', () => {
  for (const testCase of PRICING_FIXTURES.businessDateCases) {
    it(`${testCase.id} — ${testCase.title}`, () => {
      const instant = new Date(testCase.instant);
      expect(branchToday(testCase.timeZone, instant)).toBe(testCase.expect.branchDate);
      expect(businessDate(instant, testCase.timeZone, parseDayStart(testCase.dayStart))).toBe(
        testCase.expect.businessDate,
      );
    });
  }
});

describe('business date — the boundary, minute by minute', () => {
  it('every minute before 05:00 Bangkok belongs to the previous business date, and 05:00 starts the new one', () => {
    // 2026-09-23 00:00 Bangkok is 2026-09-22 17:00 UTC.
    const midnightBangkokUtc = Date.UTC(2026, 8, 22, 17, 0, 0);
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const instant = new Date(midnightBangkokUtc + minute * 60_000);
      expect(wallClockMinutesInTz(instant, BANGKOK), `minute ${minute}`).toBe(minute);
      const expected = minute < DEFAULT_BUSINESS_DAY_START_MINUTES ? '2026-09-22' : '2026-09-23';
      expect(businessDate(instant, BANGKOK), `minute ${minute}`).toBe(expected);
    }
  });

  it('the answer does not depend on the machine the engine runs on', () => {
    // 00:30 Bangkok on 2026-09-23.
    const instant = new Date('2026-09-22T17:30:00Z');
    const originalTz = process.env.TZ;
    try {
      for (const hostZone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Bangkok']) {
        process.env.TZ = hostZone;
        expect(businessDate(instant, BANGKOK), `host ${hostZone}`).toBe('2026-09-22');
        expect(branchToday(BANGKOK, instant), `host ${hostZone}`).toBe('2026-09-23');
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('a branch in another timezone gets its own answer for the same instant', () => {
    const instant = new Date('2026-09-22T17:30:00Z');
    expect(businessDate(instant, BANGKOK)).toBe('2026-09-22'); // 00:30 next day, before the start
    expect(businessDate(instant, 'UTC')).toBe('2026-09-22'); // 17:30 same day
    expect(businessDate(instant, 'America/Los_Angeles')).toBe('2026-09-22'); // 10:30 same day
    expect(businessDate(instant, 'Pacific/Kiritimati')).toBe('2026-09-23'); // 07:30 next day
  });
});

describe('business date — DST, pinned rather than ruled on', () => {
  const NY = 'America/New_York';
  const LORD_HOWE = 'Australia/Lord_Howe';

  it('goes BACKWARDS across a fall-back transition, when the day start sits in the repeated hour', () => {
    // 2026-11-01 is the US fall-back Sunday: 02:00 EDT becomes 01:00 EST, so
    // the wall clock runs 01:00–02:00 twice.
    const firstPass = new Date('2026-11-01T05:45:00Z'); // 01:45 EDT
    const secondPass = new Date('2026-11-01T06:15:00Z'); // 01:15 EST, 30 min LATER
    expect(secondPass.getTime()).toBeGreaterThan(firstPass.getTime());

    const dayStart = parseDayStart('01:45');
    expect(businessDate(firstPass, NY, dayStart)).toBe('2026-11-01');
    expect(businessDate(secondPass, NY, dayStart)).toBe('2026-10-31');
    // Stated plainly: a later sale carries an earlier business date.
    expect(businessDate(secondPass, NY, dayStart) < businessDate(firstPass, NY, dayStart)).toBe(
      true,
    );
  });

  it('a half-hour-offset zone shifts the trap without removing it', () => {
    // Lord Howe moves between +11:00 and +10:30, repeating 01:30–02:00.
    const firstPass = new Date('2026-04-04T14:50:00Z'); // 01:50 +11
    const secondPass = new Date('2026-04-04T15:10:00Z'); // 01:40 +10:30
    const dayStart = parseDayStart('01:45');
    expect(businessDate(firstPass, LORD_HOWE, dayStart)).toBe('2026-04-05');
    expect(businessDate(secondPass, LORD_HOWE, dayStart)).toBe('2026-04-04');
  });

  it('spring-forward skips the hour, so the boundary is crossed by a jump and never landed on', () => {
    // 02:00 EST jumps to 03:00 EDT on 2026-03-08; a 02:30 day start is never
    // shown on the wall clock.
    const dayStart = parseDayStart('02:30');
    const before = new Date('2026-03-08T06:59:00Z'); // 01:59 EST
    const after = new Date('2026-03-08T07:00:00Z'); // 03:00 EDT
    expect(wallClockMinutesInTz(before, NY)).toBe(1 * 60 + 59);
    expect(wallClockMinutesInTz(after, NY)).toBe(3 * 60);
    expect(businessDate(before, NY, dayStart)).toBe('2026-03-07');
    expect(businessDate(after, NY, dayStart)).toBe('2026-03-08');
    // The business date still advances exactly once across the transition.
  });

  it('the plan default of 05:00 clears both transitions, which is why this is latent', () => {
    const dayStart = DEFAULT_BUSINESS_DAY_START_MINUTES;
    for (const instant of ['2026-11-01T05:45:00Z', '2026-11-01T06:15:00Z']) {
      expect(businessDate(new Date(instant), NY, dayStart)).toBe('2026-10-31');
    }
    // And Asia/Bangkok has no DST at all, so HKT Central cannot reach any of it.
    expect(businessDate(new Date('2026-11-01T05:45:00Z'), BANGKOK, dayStart)).toBe('2026-11-01');
  });
});

describe('business date — the calendar date does not depend on a locale pattern', () => {
  /**
   * THE TRAP THIS GUARDS: asking Intl for `en-CA` because its numeric pattern
   * happens to be yyyy-mm-dd. On a build without that locale the fallback is
   * `en-US` — MM/DD/YYYY — with no error, and every date in the engine silently
   * changes shape.
   *
   * HOW IT IS GUARDED, AND HOW IT WAS NOT. An earlier version of this block
   * looped over `process.env.LANG` values. Node resolves ICU's default locale
   * once at startup, so `new Intl.DateTimeFormat().resolvedOptions().locale`
   * reads `en-US` before and after every one of those assignments: the loop
   * asserted the same thing four times and would not have failed if
   * `isoDateInTz` were replaced with a bare `toLocaleDateString()`. What CAN be
   * moved is the locale handed to a formatter, so the guard drives the module's
   * own pinned options under hostile locale tags.
   */
  it('reports the default locale it cannot move, so the next reader does not retry that', () => {
    expect(new Intl.DateTimeFormat().resolvedOptions().locale).toBe(
      new Intl.DateTimeFormat().resolvedOptions().locale,
    );
    const before = new Intl.DateTimeFormat().resolvedOptions().locale;
    const originalLang = process.env.LANG;
    try {
      process.env.LANG = 'th_TH.UTF-8';
      expect(new Intl.DateTimeFormat().resolvedOptions().locale, 'LANG is read at startup').toBe(
        before,
      );
    } finally {
      if (originalLang === undefined) delete process.env.LANG;
      else process.env.LANG = originalLang;
    }
  });

  it('pins every field a locale could otherwise decide', () => {
    // Delete `calendar` and a Buddhist-calendar locale returns 2569 for 2026;
    // delete `numberingSystem` and an arab-digit locale returns characters
    // `Number()` cannot read. These are the two pins the module depends on.
    expect(ISO_DATE_FORMAT_OPTIONS).toMatchObject({
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    expect(WALL_CLOCK_FORMAT_OPTIONS).toMatchObject({
      hourCycle: 'h23',
      numberingSystem: 'latn',
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  it('reads the same y/m/d from those options under every hostile locale, however differently they PRINT', () => {
    const instant = new Date('2026-09-22T17:30:00Z'); // 2026-09-23 00:30 Bangkok
    const hostile = ['en-US', 'en-GB', 'en-CA', 'th-TH-u-ca-buddhist', 'ar-EG-u-nu-arab', 'ja-JP'];

    const read = (locale: string): string => {
      const parts = new Intl.DateTimeFormat(locale, {
        timeZone: BANGKOK,
        ...ISO_DATE_FORMAT_OPTIONS,
      }).formatToParts(instant);
      const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
      return `${at('year').padStart(4, '0')}-${at('month').padStart(2, '0')}-${at('day').padStart(2, '0')}`;
    };
    for (const locale of hostile) expect(read(locale), `locale ${locale}`).toBe('2026-09-23');

    // And the counter-example that makes the point: the same options formatted
    // as ONE STRING are not the same string, which is the route the module
    // deliberately does not take.
    const printed = new Set(
      hostile.map((locale) =>
        new Intl.DateTimeFormat(locale, { timeZone: BANGKOK, ...ISO_DATE_FORMAT_OPTIONS }).format(
          instant,
        ),
      ),
    );
    expect(printed.size, 'whole-string formatting differs by locale').toBeGreaterThan(1);
  });

  it('produces yyyy-mm-dd, which is what every downstream comparison depends on', () => {
    const instant = new Date('2026-09-22T17:30:00Z');
    expect(branchToday(BANGKOK, instant)).toBe('2026-09-23');
    expect(branchToday(BANGKOK, instant)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(addDaysToIsoDate(branchToday(BANGKOK, instant), -1)).toBe('2026-09-22');
    // A bare `toLocaleDateString()` on this host produces '9/23/2026', which
    // fails all three of the above — that much the shape assertions do catch.
    expect(instant.toLocaleDateString()).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('business date — inputs', () => {
  it('parses a day start, in either of the shapes a branch row can hold', () => {
    expect(parseDayStart('05:00')).toBe(300);
    expect(parseDayStart('05:00:00')).toBe(300);
    expect(parseDayStart('00:00')).toBe(0);
    expect(parseDayStart('23:59')).toBe(1439);
    expect(DEFAULT_BUSINESS_DAY_START_MINUTES).toBe(300);
  });

  it('refuses a day start it cannot read rather than guessing one', () => {
    expect(() => parseDayStart('5am')).toThrow(/Unparseable business day start/);
    expect(() => parseDayStart('')).toThrow(/Unparseable business day start/);
    expect(() => parseDayStart('25:00')).toThrow(/Out-of-range business day start/);
  });

  it('shifts calendar dates across month, year and leap-day boundaries', () => {
    expect(addDaysToIsoDate('2026-09-01', -1)).toBe('2026-08-31');
    expect(addDaysToIsoDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDaysToIsoDate('2028-03-01', -1)).toBe('2028-02-29'); // 2028 is a leap year
    expect(addDaysToIsoDate('2026-09-22', 0)).toBe('2026-09-22');
    expect(addDaysToIsoDate('2026-09-22', 10)).toBe('2026-10-02');
  });

  it('a later day start moves more of the morning onto the previous day', () => {
    // 10:00 Bangkok on 2026-09-23.
    const instant = new Date('2026-09-23T03:00:00Z');
    expect(businessDate(instant, BANGKOK, parseDayStart('05:00'))).toBe('2026-09-23');
    expect(businessDate(instant, BANGKOK, parseDayStart('11:00'))).toBe('2026-09-22');
    expect(businessDate(instant, BANGKOK, parseDayStart('10:00'))).toBe('2026-09-23');
  });
});
