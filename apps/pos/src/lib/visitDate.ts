import { addDaysToIsoDate, isIsoDate } from '@oto/shared';

/**
 * THE BOOKING SITE'S VISIT DATE (S2-12, SCRUM-209 fix round 2).
 *
 * The sprint plan asks for the booking's business date to come from the
 * CHOSEN visit date; the prototype had no control for it, so `/book` booked
 * "today" only. The date step is a UI addition (CLAUDE.md section 7 rule 2):
 * today by default, today at the earliest, and at most sixty days out.
 * "Today" is the branch's TRADING day as the platform reports it (the public
 * catalogue's `rateMode.date`), the same day a booking sent without a visit
 * date is quoted for, so the two can never name different days.
 */
export const VISIT_DATE_MAX_DAYS_AHEAD = 60;

/** The dates the step offers: today through sixty days out. */
export function visitDateBounds(today: string): { min: string; max: string } {
  return { min: today, max: addDaysToIsoDate(today, VISIT_DATE_MAX_DAYS_AHEAD) };
}

/**
 * A date the step may hold. A browser enforces `min`/`max` in its picker but
 * not on a date typed into the field, so anything outside is brought back to
 * the nearest end, and anything that is not a date at all to today.
 */
export function clampVisitDate(date: string, today: string): string {
  if (!isIsoDate(date)) return today;
  const { min, max } = visitDateBounds(today);
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

/**
 * A visit date as the family reads it, in the page's language. The date is a
 * calendar day, not an instant, so it is formatted at UTC midnight in UTC:
 * whatever timezone the phone is in, the day shown is the day booked.
 */
export function formatVisitDate(date: string, lang: string): string {
  if (!isIsoDate(date)) return date;
  try {
    return new Intl.DateTimeFormat(lang, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
}
