/**
 * A BEO's clock times (SCRUM-1027), on their own so every part of the BEO that reads a time reads
 * it the same way: the timeline (shared/beoTimeline.ts, which re-exports these) and a dish's own
 * serving time (shared/beoServingTimes.ts). Times are the park's clock as stored: no time zone is
 * applied.
 */

const DAY = 24 * 60;

/** A minute of the day as HH:MM, wrapped onto the clock as the stored offsets always were. */
export function clockAtMinute(minute: number): string {
  const m = ((minute % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** A stored clock time ("9:30", "09:30", "14:00:00") as HH:MM and its minute of the day; null when it is none. */
export function beoClockOf(value: unknown): { time: string; minute: number } | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { time: clockAtMinute(h * 60 + min), minute: h * 60 + min };
}
