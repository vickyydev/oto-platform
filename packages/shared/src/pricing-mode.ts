import { isWeekendIsoDate } from './dates';
import { businessDate, DEFAULT_BUSINESS_DAY_START_MINUTES } from './business-date';
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

/**
 * Rate mode for the trading day in progress at a branch.
 *
 * RULING 3, 2026-09-20, AND IT IS A DECISION OF OURS, NOT A RULE WE FOUND.
 * A sale is PRICED BY THE BUSINESS DATE, not by the calendar date — the same
 * date the ledger, the till roll and the cash-up answer to. So a cart rung up
 * at 00:30 on Saturday, while Friday's session is still being closed, is
 * charged FRIDAY's prices, because Friday is the day printed on its receipt.
 *
 * THE REASONING, recorded because it is ours. Nothing in the repository ruled
 * on it: the prototype prices from LOCAL midnight (`lib/pricingMode.ts:19-24`)
 * and has no business date at all, and the plan defines the business date
 * without saying it governs price. The park trades 10:00–20:00 (its own SOP,
 * and Radar has watched the live tills against a 20:00 close for months) and
 * the business day starts at 05:00, so NO GUEST SALE falls in the window where
 * the two candidate rules disagree — only staff actions do: a cash count, a
 * late party settling, a correction. One sentence therefore covers pricing,
 * promo expiry, the till roll and the cash-up, and it is the sentence a guest
 * can check: everything answers to the day printed on your receipt.
 *
 * `dayStartMinutes` is the branch's `business_day_start` (default 05:00). Pass
 * the branch's own value; the default is the plan's.
 *
 * READS THE CLOCK when `now` is omitted, and this function decides which of two
 * prices a guest pays. On a box whose clock has drifted across midnight into a
 * Saturday, every ticket sold until the clock is corrected is charged the
 * weekend price with nothing in the sale to show it was wrong. A till must pass
 * the same instant it stamps on the sale; the default is for a convenience
 * caller such as an admin screen. See the clock-seam note in engine.ts.
 */
export function rateModeToday(
  timeZone: string,
  holidays: HolidayRange[],
  now: Date = new Date(),
  dayStartMinutes: number = DEFAULT_BUSINESS_DAY_START_MINUTES,
): RateModeResult {
  return getRateModeForDate(businessDate(now, timeZone, dayStartMinutes), holidays);
}

/** Resolve a stored weekday/weekend price to a concrete satang amount. */
export function resolveRate(price: WWPrice | undefined, mode: RateMode): Satang {
  if (!price) return 0;
  return mode === 'weekend' ? price.weekend : price.weekday;
}
