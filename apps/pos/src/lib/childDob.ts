// Low-tap child date-of-birth helpers.
//
// The till captures a child's age in three taps (Age → Month → Day) but stores a
// real date of birth so the age is always *derived* against the visit/attendance
// date — supervision rules stay accurate as time passes and a saved child's
// requirement updates automatically (no stale numeric age). Existing records that
// only carry a numeric age keep working: callers fall back to the stored number
// whenever no DOB is present.

// Oldest age the low-tap picker offers (the park is a kids' play park).
export const MAX_CHILD_AGE = 12;

const pad = (n: number) => String(n).padStart(2, '0');

// Days in a given month (1-12) for a specific year (handles leap Februaries).
export function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

// Local date-only midnight (avoids UTC drift from new Date(iso)).
function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Derive an ISO `YYYY-MM-DD` date of birth from a picked age + birthday month/day.
 *
 * The picker feels like choosing an age, so we infer the birth *year*: if the
 * child's birthday (month/day) has already occurred (or is) on `today` this year
 * they were born `thisYear - age`; if it is still ahead this year they must have
 * turned `age` last year, so they were born `thisYear - age - 1`. Either way the
 * resulting DOB reads back as `age` today.
 *
 * The day is clamped to the chosen month's real length in the derived birth year
 * (e.g. Feb 29 picked for a non-leap birth year clamps to Feb 28).
 */
export function dobFromPickedAge(
  age: number,
  month: number,
  day: number,
  today: Date = new Date(),
): string {
  const t = dateOnly(today);
  const thisYear = t.getFullYear();
  const birthdayThisYear = new Date(thisYear, month - 1, day);
  const occurred = birthdayThisYear <= t;
  const birthYear = occurred ? thisYear - age : thisYear - age - 1;
  const clampedDay = Math.min(day, daysInMonth(month, birthYear));
  return `${birthYear}-${pad(month)}-${pad(clampedDay)}`;
}

/**
 * Whole-years age for an ISO `YYYY-MM-DD` date of birth as of `asOf` (default:
 * now). Returns null for an unparseable / empty DOB so callers can fall back to a
 * stored numeric age.
 */
export function ageFromDob(dateOfBirth: string, asOf: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ref = dateOnly(asOf);
  let age = ref.getFullYear() - year;
  const beforeBirthday =
    ref.getMonth() + 1 < month ||
    (ref.getMonth() + 1 === month && ref.getDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : 0;
}

// Short month labels for the month-pick grid (Jan…Dec).
export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// Format an ISO DOB for display, e.g. "14 Mar 2020". Falls back to the raw string.
export function formatDob(dateOfBirth: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth.trim());
  if (!m) return dateOfBirth;
  const month = Number(m[2]);
  return `${Number(m[3])} ${MONTH_LABELS[month - 1]} ${m[1]}`;
}
