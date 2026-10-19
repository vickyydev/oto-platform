/**
 * A CHANNEL ACCOUNT'S OPENING HOURS (S2-19 I2d, SCRUM-583; plan §3.4 step 6).
 *
 * `inbox.channel_account.opening_hours` is
 * `{ mon: { open: "10:00", close: "20:00" }, … }` in the branch's timezone.
 * Null means always open. A day that is absent is closed all day. A shape
 * this cannot read is treated as ALWAYS OPEN: a typo in a setting must never
 * make the park answer every customer with "we are closed".
 *
 * Two questions only: is the account open at this instant, and when did the
 * closed period this instant sits in begin — which is what "send the
 * out-of-hours reply at most once per closed period" counts from.
 */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type Day = (typeof DAYS)[number];

interface DayHours {
  /** Minutes after local midnight. */
  open: number;
  close: number;
}

export type OpeningHours = Partial<Record<Day, DayHours>>;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The stored jsonb as hours, or null for "always open" (unset or unreadable). */
export function readOpeningHours(raw: unknown): OpeningHours | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: OpeningHours = {};
  let any = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const day = key.toLowerCase().slice(0, 3) as Day;
    if (!DAYS.includes(day)) return null;
    if (value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const open = minutesOf(v['open']);
    const close = minutesOf(v['close']);
    if (open === null || close === null || close <= open) return null;
    out[day] = { open, close };
    any = true;
  }
  // `{}` would mean "closed every day", which is never what an empty object
  // typed into a settings page means.
  return any ? out : null;
}

/** The local calendar fields of an instant in a timezone. */
function localParts(at: Date, timeZone: string): { y: number; m: number; d: number; day: Day; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    day: get('weekday').toLowerCase().slice(0, 3) as Day,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** The instant a local wall-clock time names in a timezone. */
function instantOf(y: number, m: number, d: number, minutes: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const seen = localParts(new Date(guess), timeZone);
  const seenAsUtc = Date.UTC(seen.y, seen.m - 1, seen.d, Math.floor(seen.minutes / 60), seen.minutes % 60);
  return new Date(guess - (seenAsUtc - guess));
}

export function isOpenAt(hours: OpeningHours | null, timeZone: string, at: Date): boolean {
  if (!hours) return true;
  const p = localParts(at, timeZone);
  const today = hours[p.day];
  return Boolean(today && p.minutes >= today.open && p.minutes < today.close);
}

/**
 * When the closed period that `at` sits in began: the most recent closing
 * time at or before `at`, looking back a week. Null when there is none in
 * that week (closed every day) — the period then has no start, and the
 * caller counts from the beginning of time.
 */
export function closedSince(hours: OpeningHours, timeZone: string, at: Date): Date | null {
  const p = localParts(at, timeZone);
  for (let back = 0; back <= 7; back += 1) {
    // Step back whole local days from today's local date.
    const noon = instantOf(p.y, p.m, p.d, 12 * 60, timeZone).getTime() - back * 86_400_000;
    const local = localParts(new Date(noon), timeZone);
    const h = hours[local.day];
    if (!h) continue;
    const close = instantOf(local.y, local.m, local.d, h.close, timeZone);
    if (close.getTime() <= at.getTime()) return close;
  }
  return null;
}
