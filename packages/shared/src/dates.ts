/**
 * Branch-timezone date helpers (CLAUDE.md §3): storage is timestamptz UTC;
 * anything day-based (weekday/weekend pricing, holiday ranges, visit dates)
 * is evaluated in the branch's timezone (Asia/Bangkok for HKT Central).
 */

/** ISO calendar date (yyyy-mm-dd) of an instant, in a timezone. */
export function isoDateInTz(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Day of week (0=Sunday … 6=Saturday) of an instant, in a timezone. */
export function dayOfWeekInTz(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant);
  const idx = WEEKDAY_INDEX[name];
  if (idx === undefined) throw new Error(`Unresolvable weekday "${name}" for tz ${timeZone}`);
  return idx;
}

/** Day of week of a plain yyyy-mm-dd calendar date (timezone-independent). */
export function dayOfWeekOfIsoDate(isoDate: string): number {
  // Interpret at UTC noon so no timezone can shift the calendar day.
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

/** Saturday or Sunday — the prototype's weekend rule (`pricingMode.ts:49`). */
export function isWeekendIsoDate(isoDate: string): boolean {
  const d = dayOfWeekOfIsoDate(isoDate);
  return d === 0 || d === 6;
}

/** Today's calendar date in a branch's timezone. */
export function branchToday(timeZone: string, now: Date = new Date()): string {
  return isoDateInTz(now, timeZone);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value);
}
