/**
 * AN EVENT HAS A START TIME (SCRUM-836).
 *
 * `core_events.start_time` is NOT NULL and every screen that makes an event
 * asks for one (the Events forms, the inbox's Book Date: "Enter the start
 * time as HH:MM."). Two doors let it go all the same: the BEO form's cleared
 * Start Time was dropped from the save without a word (the old time stayed),
 * and the event routes wrote whatever they were sent — an empty string
 * emptied the column, a null answered 500.
 *
 * The rule, one place for the routes and the form: a start time that is
 * named must be a clock time, `HH:MM` on the 24-hour clock. Nothing, an empty
 * string and anything else are refused in plain words, and the column is
 * never emptied.
 *
 * One allowance: a value sent back exactly as the event holds it is no change
 * and is not refused. A row from before this rule can hold an empty or an
 * odd start; a form that echoes it while saving something else still saves,
 * and such a row is not migrated (the BEO's one-pass fill answers
 * `no_start_time` for it, SCRUM-827).
 */

export const START_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The line the BEO form and the routes say for a party. */
export const PARTY_NEEDS_START_TIME = "A party needs a start time";
/** The same, for an event that is no party (a camp, a workshop, a one-off). */
export const EVENT_NEEDS_START_TIME = "An event needs a start time";
export const START_TIME_NOT_A_TIME = "The start time must be a time as HH:MM on the 24-hour clock";

/** `HH:MM` on the 24-hour clock. */
export function isStartTime(value: unknown): value is string {
  return typeof value === "string" && START_TIME_PATTERN.test(value);
}

const blank = (value: unknown) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/** The kinds of event that are a party (as the directory's party writes name them). */
const PARTY_EVENT_TYPES = new Set(["birthday", "private_event", "school_group"]);

/** The "needs a start time" line for this kind of event. */
export function needsStartTimeLine(eventType?: string | null): string {
  return !eventType || PARTY_EVENT_TYPES.has(eventType) ? PARTY_NEEDS_START_TIME : EVENT_NEEDS_START_TIME;
}

/**
 * Why a start time sent for an event cannot be written, in one line; null
 * when it can. `sent` is the body's `startTime` (`undefined`: not named, so
 * nothing to refuse); `stored` is what the event holds now (`undefined` for an
 * event being made, which must name one).
 */
export function refuseStartTime(sent: unknown, stored: string | null | undefined, eventType?: string | null): string | null {
  if (sent === undefined) return stored === undefined ? needsStartTimeLine(eventType) : null;
  if (typeof sent === "string" && stored !== undefined && sent === stored) return null;
  if (isStartTime(sent)) return null;
  return blank(sent) ? needsStartTimeLine(eventType) : START_TIME_NOT_A_TIME;
}
