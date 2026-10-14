import { wallClockMinutesInTz } from './business-date';
import { isoDateInTz } from './dates';

/**
 * SCRUM-421 — ONE WAY TO WRITE A DAY IN WORDS: "8 Oct 2026".
 *
 * The voucher refusals, the promo refusals, the voucher card on the till and
 * the platform's own alert sentences each kept a private month table and the
 * same three lines of assembly. They agreed by inspection only, so a change to
 * one would have left a till and the platform printing one date two ways.
 *
 * Assembled from fixed English parts, never from a locale's own pattern: a
 * locale's short month depends on the runtime (Node 22 prints "Sept" for
 * `en-GB`), so a box and the cloud would disagree. Translation belongs to the
 * i18n layer, not here.
 */
export const SHORT_MONTH_NAMES = [
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
] as const;

/**
 * "8 Oct 2026" from a `YYYY-MM-DD`. Anything that does not split into a year,
 * a known month and a day comes back unchanged, so a malformed value reads as
 * itself rather than as a wrong date.
 */
export function formatIsoDay(iso: string): string {
  const [year, month, day] = iso.split('-');
  const name = SHORT_MONTH_NAMES[Number(month) - 1];
  return name && day && year ? `${Number(day)} ${name} ${year}` : iso;
}

/** "8 Oct 2026" for an instant, on the given (branch) time zone's calendar. */
export function formatDayInTz(instant: Date, timeZone: string): string {
  return formatIsoDay(isoDateInTz(instant, timeZone));
}

/** "8 Oct 2026 15:02" for an instant, on the given (branch) time zone's clock. */
export function formatDayTimeInTz(instant: Date, timeZone: string): string {
  const minutes = wallClockMinutesInTz(instant, timeZone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${formatDayInTz(instant, timeZone)} ${hh}:${mm}`;
}
