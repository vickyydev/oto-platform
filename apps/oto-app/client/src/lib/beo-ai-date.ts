/**
 * THE PARTY'S DATE AN AI FILL READ, BESIDE THE BOOKED ONE (SCRUM-814).
 *
 * The BEO's AI Fill answers the date the message names (`event.eventDate`,
 * with the message's own words in `event.eventDateText`). The event already
 * has a date — Book Date set it in the inbox, or a person did here — and that
 * date is never changed silently: the review step shows the read date beside
 * the booked one, marks the line when they differ, and Load into Editor
 * applies the read date only when the person ticked it. Pure, so the app's
 * check holds it.
 */

export interface AiFillDateLine {
  /** The date the message names, `YYYY-MM-DD`. */
  read: string;
  /** The message's own words for it, when the answer gave them. */
  readText: string | null;
  /** The date the form holds now, `YYYY-MM-DD`, or null when it holds none. */
  booked: string | null;
  /** The two are not the same day: the line is marked, and the read date waits for a tick. */
  differs: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The date line of an AI Fill answer against the form's date; null when the answer names no date. */
export function aiFillDateLine(fill: unknown, booked: string | null | undefined): AiFillDateLine | null {
  const event = fill && typeof fill === "object" ? (fill as Record<string, unknown>).event : undefined;
  if (!event || typeof event !== "object") return null;
  const { eventDate, eventDateText } = event as Record<string, unknown>;
  if (typeof eventDate !== "string" || !DAY.test(eventDate)) return null;
  const bookedDay = typeof booked === "string" && DAY.test(booked.slice(0, 10)) ? booked.slice(0, 10) : null;
  return {
    read: eventDate,
    readText: typeof eventDateText === "string" && eventDateText.trim() ? eventDateText.trim() : null,
    booked: bookedDay,
    differs: eventDate !== bookedDay,
  };
}

/** "Sat 21 Nov 2026", the way the line shows a day (no locale's pattern). */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[2]! - 1];
  return `${weekday} ${+m[3]!} ${month} ${m[1]}`;
}
