/**
 * Branch-timezone date helpers (CLAUDE.md §3): storage is timestamptz UTC;
 * anything day-based (weekday/weekend pricing, holiday ranges, visit dates)
 * is evaluated in the branch's timezone (Asia/Bangkok for HKT Central).
 *
 * NOTHING HERE MAY DEPEND ON A LOCALE'S DATE PATTERN. An earlier draft asked
 * `Intl.DateTimeFormat` for `en-CA` because that locale's numeric pattern
 * happens to be yyyy-mm-dd and formatted the whole date in one call. `en-CA` is
 * exactly the kind of locale data a small-icu Node build drops, and the
 * fallback is silent: the runtime resolves to `en-US`, whose pattern is
 * MM/DD/YYYY, and every date this module produces changes shape with no error.
 * Downstream that is not cosmetic — `addDaysToIsoDate('09/23/2026', -1)` throws
 * and takes the till down at the day boundary; a `business_date` written before
 * it throws is stored as '09/23/2026'; and every consumer compares dates as raw
 * strings, where an MM/DD/YYYY date sorts BEFORE every ISO one, because '0' <
 * '2' at the first character: `'09/23/2026' < '2026-04-11'`. (An earlier
 * version of this paragraph stated that comparison the other way round. The
 * consequence is real but it is the opposite one.) So such a date reads as
 * EARLIER than every `validFrom` and every `startsOn`: `validatePromoCode`
 * refuses every dated promo with "is not valid until …" and never expires one,
 * and `getRateModeForDate` never matches a holiday range, so Songkran silently
 * prices at weekday rates.
 *
 * So the date is assembled from `formatToParts` with explicit part reads — the
 * technique `business-date.ts` `wallClockMinutesInTz` uses — and the calendar
 * and numbering system are pinned. No locale's pattern, era or digits are
 * depended on at all, and the locale tag below is only a label for a format
 * whose every field is specified.
 */

// Formatter construction is the expensive part of Intl and a box prices a sale
// on every tap, so formatters are cached per timezone. The cache holds no state
// beyond the formatter, so it cannot make two calls disagree.
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The pinned field set every calendar-date read uses. Exported so a test can
 * assert the pins themselves rather than the host's default locale, which Node
 * fixes at startup and no test can move: drop `calendar` and the same options
 * under `th-TH-u-ca-buddhist` return 2569 for 2026; drop `numberingSystem` and
 * `ar-EG-u-nu-arab` returns digits `Number()` cannot read. The locale tag is
 * supplied per call and is only a label — every field that could vary is here.
 */
export const ISO_DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = DATE_FORMATTERS.get(timeZone);
  if (cached) return cached;
  // `en-US` is named only because a tag is required; it is the one locale a
  // small-icu build always carries, so naming any other invites a silent
  // fallback. The pattern it would produce is never read — only parts are.
  const created = new Intl.DateTimeFormat('en-US', { timeZone, ...ISO_DATE_FORMAT_OPTIONS });
  DATE_FORMATTERS.set(timeZone, created);
  return created;
}

/** ISO calendar date (yyyy-mm-dd) of an instant, in a timezone. */
export function isoDateInTz(instant: Date, timeZone: string): string {
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  for (const part of dateFormatter(timeZone).formatToParts(instant)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Unresolvable calendar date for tz ${timeZone}`);
  }
  // `2-digit` already pads month and day; padding again costs nothing and means
  // a runtime that ignores the option cannot produce a mis-shaped date.
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Day of week (0=Sunday … 6=Saturday) of an instant, in a timezone.
 *
 * Derived from the calendar date rather than from a `weekday: 'short'` format,
 * so this depends on no locale's weekday names either — the same reason
 * `isoDateInTz` reads parts.
 */
export function dayOfWeekInTz(instant: Date, timeZone: string): number {
  return dayOfWeekOfIsoDate(isoDateInTz(instant, timeZone));
}

/** Day of week of a plain yyyy-mm-dd calendar date (timezone-independent). */
export function dayOfWeekOfIsoDate(isoDate: string): number {
  // Interpret at UTC noon so no timezone can shift the calendar day.
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  if (Number.isNaN(day)) throw new Error(`Unparseable ISO date "${isoDate}"`);
  return day;
}

/** Saturday or Sunday — the prototype's weekend rule (`lib/pricingMode.ts:49-51`). */
export function isWeekendIsoDate(isoDate: string): boolean {
  const d = dayOfWeekOfIsoDate(isoDate);
  return d === 0 || d === 6;
}

/**
 * Today's calendar date in a branch's timezone.
 *
 * READS THE CLOCK when `now` is omitted. That default is the whole of this
 * module's impurity and it is deliberate — see the boundary note in engine.ts.
 * Anything that prices money should pass the instant.
 */
export function branchToday(timeZone: string, now: Date = new Date()): string {
  return isoDateInTz(now, timeZone);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value);
}
