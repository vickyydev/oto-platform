import { isoDateInTz } from './dates';

/**
 * The business date — which trading day a sale belongs to.
 *
 * NO PROTOTYPE LOGIC EXISTS. Searching the prototype for `businessDay`,
 * `business_day`, `businessDate`, `dayStart`, `operatingDay` and `cutoff`
 * returns nothing, and its six day-boundaries disagree with each other: rate
 * mode and the mobile history use LOCAL midnight (`lib/pricingMode.ts:19-24`,
 * `components/mobile/history/MobileHistory.tsx:47`) while sale timestamps,
 * report filtering, promo validity and the seeded "today" use the UTC date
 * (`lib/sale.ts:316`, `lib/reporting.ts:65-68`, `pages/Till.tsx:560`,
 * `mockApi.ts:3182`). In Bangkok those disagree for seven hours of every day.
 *
 * So the plan owns this rule, and states it: every ledger row stores
 * `business_date` computed from `branch.business_day_start` (default 05:00
 * Asia/Bangkok) plus `occurred_at` (SPRINT_2_PLAN.md "Money and time", and
 * `branch.business_day_start` (time, default 05:00) in the S2-04 table list).
 * The park closes after midnight, so a sale at 00:30 belongs to the day that
 * started the previous morning.
 *
 * WHAT IT DOES NOT GOVERN, TODAY: pricing. The prototype prices from the
 * CALENDAR day (`todayRateMode()` → `getRateModeForDate(new Date())`), so a
 * 01:00 Saturday sale is priced at weekend rates even though it belongs to
 * Friday's business date. The prototype has logic here and the plan does not
 * contradict it, so the calendar day still decides the rate mode — pass
 * `branchToday(...)` to the rate resolver, not `businessDate(...)`. Whether
 * the owner wants the two aligned is an open question, recorded for S2-09a.
 */

/** 05:00, the plan's default `branch.business_day_start`. */
export const DEFAULT_BUSINESS_DAY_START_MINUTES = 5 * 60;

const HHMM = /^(\d{2}):(\d{2})(?::\d{2})?$/;

/** Parse a `branch.business_day_start` time ("05:00", or "05:00:00" from PG) to minutes. */
export function parseDayStart(time: string): number {
  const match = HHMM.exec(time);
  const hour = match?.[1];
  const minute = match?.[2];
  if (hour === undefined || minute === undefined) {
    throw new Error(`Unparseable business day start "${time}" (expected HH:MM)`);
  }
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) throw new Error(`Out-of-range business day start "${time}"`);
  return h * 60 + m;
}

// Intl.DateTimeFormat construction is the expensive part and a box prices a
// sale on every tap, so formatters are cached per timezone. The cache holds no
// state beyond the formatter itself, so it cannot make two calls disagree.
const TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The pinned field set every wall-clock read uses, exported for the same reason
 * as `ISO_DATE_FORMAT_OPTIONS`: h23 pins midnight to "00" rather than the "24"
 * some locales emit, and latn pins the digits `Number()` has to read. A test
 * drives these options under hostile locales; the host's own default locale is
 * fixed at startup and cannot be moved from inside a test.
 */
export const WALL_CLOCK_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  numberingSystem: 'latn',
  hour: '2-digit',
  minute: '2-digit',
};

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = TIME_FORMATTERS.get(timeZone);
  if (cached) return cached;
  // `en-US` is named only because a tag is required — it is the one locale a
  // small-icu build always carries, so naming any other invites a silent
  // fallback (see the note at the top of dates.ts).
  const created = new Intl.DateTimeFormat('en-US', { timeZone, ...WALL_CLOCK_FORMAT_OPTIONS });
  TIME_FORMATTERS.set(timeZone, created);
  return created;
}

/** Minutes past midnight on the wall clock of `timeZone` at `instant`. */
export function wallClockMinutesInTz(instant: Date, timeZone: string): number {
  let hour: number | undefined;
  let minute: number | undefined;
  for (const part of timeFormatter(timeZone).formatToParts(instant)) {
    if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  if (
    hour === undefined ||
    minute === undefined ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    throw new Error(`Unresolvable wall clock for tz ${timeZone}`);
  }
  return hour * 60 + minute;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Shift a yyyy-mm-dd calendar date by whole days, with no timezone involved. */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-');
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`Unparseable ISO date "${isoDate}"`);
  }
  // Arithmetic at UTC so no host timezone can pull the result onto another day.
  const shifted = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * The business date of an instant at a branch.
 *
 * Before the day start on the branch's wall clock, the instant still belongs to
 * the previous business date. At exactly the day start it belongs to the new
 * one. Both `timeZone` and `dayStartMinutes` are arguments and there is no
 * clock read here, so the boundary can be tested from any machine at any hour.
 *
 * DST. The rule is "what does the clock on the wall say", which is the answer a
 * manager closing the till would give, and both DST transitions bend it:
 *
 *   - SPRING FORWARD skips an hour of wall clock entirely. A day start inside
 *     the skipped hour is never shown on the wall, so the boundary is crossed
 *     by a jump: no sale ever lands exactly on it, and the business date still
 *     advances exactly once.
 *   - FALL BACK REPEATS an hour, and this one is not benign: THE BUSINESS DATE
 *     CAN GO BACKWARDS. With a day start inside the repeated hour, a sale
 *     rung up LATER in real time can show an EARLIER wall clock and so be
 *     stamped with the PREVIOUS business date. Fixture BD-DST-2 pins a
 *     measured pair thirty minutes apart in real time whose business dates run
 *     backwards. Half-hour-offset zones shift the boundary by thirty minutes
 *     rather than an hour and hit it the same way — Australia/Lord_Howe moves
 *     between +11:00 and +10:30 and repeats 01:30–02:00 (fixture BD-DST-4).
 *
 * WHICH RULE SHOULD WIN IS NOT DECIDED HERE. Monotonic business dates would
 * need the instant, not the wall clock, to break the tie, and that is a choice
 * about what a trading day means, not a bug to patch. What is written down is
 * the current behaviour, pinned by fixtures, so a later ruling shows up as a
 * changed number in a diff someone reads.
 *
 * None of it arises at HKT Central: Asia/Bangkok has no DST, and even in a DST
 * zone the plan's default 05:00 start sits clear of both US and EU transition
 * hours. It is recorded because a second branch in another country would
 * inherit this function unchanged.
 */
export function businessDate(
  instant: Date,
  timeZone: string,
  dayStartMinutes: number = DEFAULT_BUSINESS_DAY_START_MINUTES,
): string {
  const calendarDate = isoDateInTz(instant, timeZone);
  const minutes = wallClockMinutesInTz(instant, timeZone);
  return minutes < dayStartMinutes ? addDaysToIsoDate(calendarDate, -1) : calendarDate;
}
