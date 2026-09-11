import { branchToday, isWeekendIsoDate } from './dates';
import type { WWPrice, Satang } from './money';

/**
 * Weekday/weekend rate resolution — a faithful port of the prototype's
 * `lib/pricingMode.ts` (the approved rule set), made pure and tz-aware:
 *   1. Inside any named holiday range (inclusive) → weekend pricing.
 *   2. Saturday or Sunday (in the branch timezone) → weekend pricing.
 *   3. Otherwise → weekday pricing.
 * The API's pricing resolver (SCRUM-36) feeds this from `branch_holiday` rows.
 */
export type RateMode = 'weekday' | 'weekend';

export interface HolidayRange {
  name: string;
  /** yyyy-mm-dd, inclusive. */
  startsOn: string;
  /** yyyy-mm-dd, inclusive. */
  endsOn: string;
}

export interface RateModeResult {
  mode: RateMode;
  /** Human-readable reason for the POS indicator, e.g. "Weekend pricing — Songkran". */
  reason: string;
  overrideName?: string;
}

export function getRateModeForDate(isoDate: string, holidays: HolidayRange[]): RateModeResult {
  const override = holidays.find((h) => isoDate >= h.startsOn && isoDate <= h.endsOn);
  if (override) {
    return {
      mode: 'weekend',
      reason: `Weekend pricing — ${override.name}`,
      overrideName: override.name,
    };
  }
  if (isWeekendIsoDate(isoDate)) {
    return { mode: 'weekend', reason: 'Weekend pricing' };
  }
  return { mode: 'weekday', reason: 'Weekday pricing' };
}

/** Rate mode for "now" at a branch. */
export function rateModeToday(
  timeZone: string,
  holidays: HolidayRange[],
  now: Date = new Date(),
): RateModeResult {
  return getRateModeForDate(branchToday(timeZone, now), holidays);
}

/** Resolve a stored weekday/weekend price to a concrete satang amount. */
export function resolveRate(price: WWPrice | undefined, mode: RateMode): Satang {
  if (!price) return 0;
  return mode === 'weekend' ? price.weekend : price.weekday;
}
