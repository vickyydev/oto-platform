import { Hourglass } from 'lucide-react';
import { businessDate, isoDateInTz, parseDayStart } from '@oto/shared';
import { cn } from '@/lib/utils';

/**
 * S2-15b round 3 — UI ADDITION. One small line above the Performance figures
 * saying how fresh they are: while the day is still trading they are
 * provisional and follow the rollup, so the line says so and when they were
 * last brought up to date; a day that has ended says when it was last
 * written. In the muted voice of the tab's own sub-lines, with the amber the
 * End of Day uses for "provisional".
 *
 * A bare time reads as "earlier today", so it is printed bare only when it is
 * one: on the trading day in progress at the branch and, as far as this
 * device's clock can tell, on today's calendar date. Anything older names its
 * day — after a stalled rollup, `Updated 6 Oct, 01:42`, never `Updated 01:42`.
 */
export function PerformanceFreshness({
  provisional,
  updatedAt,
  timezone,
  today = null,
  dayStart = null,
  className,
}: {
  provisional: boolean;
  updatedAt: string | null;
  timezone: string | null;
  /**
   * The business date in progress at the branch, as the platform answered it
   * (`branches[].today`). Without it, this device's clock decides.
   */
  today?: string | null;
  /** The branch's business day start, `HH:MM`. Without it, midnight. */
  dayStart?: string | null;
  className?: string;
}) {
  const when = updatedAt ? whenOf(updatedAt, timezone, provisional, today, dayStart) : null;
  return (
    <p role="status" className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      {provisional && <Hourglass className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
      <span>
        {provisional && 'Provisional — still being added up · '}
        {when ? `Updated ${when}` : 'Not updated yet'}
      </span>
    </p>
  );
}

const TIME_ONLY: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
const WITH_DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...TIME_ONLY };

/**
 * `14:05` for an update earlier on the open day; `6 Oct, 21:10` for anything
 * else — a day that has ended, or an open day whose last update is from an
 * earlier day. In the branch's time.
 */
function whenOf(
  iso: string,
  timezone: string | null,
  provisional: boolean,
  today: string | null,
  dayStart: string | null,
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const timeZone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const options = provisional && isEarlierToday(at, timeZone, today, dayStart) ? TIME_ONLY : WITH_DAY;
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(at);
  }
}

/**
 * Is `at` earlier today at the branch? It must fall on the trading day in
 * progress (`today`, from the platform; this device's clock when absent). And
 * when the clock agrees with the platform on that day, it must also fall on
 * the clock's calendar date: at 03:42 a time from 06:00 the previous morning
 * is the same trading day but would still read as today's. A clock that
 * disagrees with the platform (a till set to the wrong date) is not believed.
 */
function isEarlierToday(at: Date, timeZone: string, today: string | null, dayStart: string | null): boolean {
  try {
    const startMinutes = dayStart ? parseDayStart(dayStart) : 0;
    const now = new Date();
    const clockDay = businessDate(now, timeZone, startMinutes);
    const tradingDay = today ?? clockDay;
    if (businessDate(at, timeZone, startMinutes) !== tradingDay) return false;
    return clockDay !== tradingDay || isoDateInTz(at, timeZone) === isoDateInTz(now, timeZone);
  } catch {
    // An unreadable zone or day start: name the day rather than guess.
    return false;
  }
}
