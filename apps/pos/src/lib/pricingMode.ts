import type { WeekdayWeekendPrice } from '@/types';
import { getPricingOverrides } from '@/store/catalogStore';

/**
 * Which rate is active for a sale. Every price in the catalog stores a
 * {weekday, weekend} pair; this is the ONE resolver that turns "what day is
 * it" into "which of those two numbers applies" — see getRateModeForDate.
 */
export type RateMode = 'weekday' | 'weekend';

export interface RateModeResult {
  mode: RateMode;
  /** Human-readable reason shown on the POS indicator, e.g. "Weekend pricing — Songkran". */
  reason: string;
  /** Name of the matched holiday override, when the mode came from one. */
  overrideName?: string;
}

const toISODate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/**
 * Resolves the active rate mode for a given date, in order:
 *   1. Inside any named holiday override range (inclusive) → weekend.
 *   2. Saturday or Sunday → weekend.
 *   3. Otherwise → weekday.
 * Reads holiday overrides from the catalog store (never mockApi — see the
 * lib import-cycle rule) so it stays free of the seed-eval TDZ.
 */
export function getRateModeForDate(date: Date | string): RateModeResult {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00`) : date;
  const iso = toISODate(d);

  const override = getPricingOverrides().find(
    (o) => iso >= o.startDate && iso <= o.endDate
  );
  if (override) {
    return {
      mode: 'weekend',
      reason: `Weekend pricing — ${override.name}`,
      overrideName: override.name,
    };
  }

  const day = d.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) {
    return { mode: 'weekend', reason: 'Weekend pricing' };
  }
  return { mode: 'weekday', reason: 'Weekday pricing' };
}

/** The active rate mode for today (the till always sells "now"). */
export function todayRateMode(): RateModeResult {
  return getRateModeForDate(new Date());
}

/** Resolves a stored weekday/weekend price to a concrete ฿ number for a mode. */
export function resolveRate(
  price: WeekdayWeekendPrice | undefined,
  mode: RateMode
): number {
  if (!price) return 0;
  return mode === 'weekend' ? price.weekend : price.weekday;
}

/** Convenience: resolve a price using TODAY's active mode. */
export function resolveRateToday(price: WeekdayWeekendPrice | undefined): number {
  return resolveRate(price, todayRateMode().mode);
}

/**
 * Human-readable ฿ display for an admin list row: a single figure when
 * weekday and weekend match, otherwise both ("฿100 / ฿150 wknd").
 */
export function formatWWPrice(price: WeekdayWeekendPrice | undefined): string {
  if (!price) return '฿0';
  if (price.weekday === price.weekend) return `฿${price.weekday.toLocaleString()}`;
  return `฿${price.weekday.toLocaleString()} / ฿${price.weekend.toLocaleString()} wknd`;
}
