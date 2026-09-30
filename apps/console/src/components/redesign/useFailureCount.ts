import { useEffect, useState } from 'react';
import { failuresApi } from '@/api/observability';

/** The sidebar's reading of Failures: a count, or "more than the page held". */
export interface FailureCount {
  count: number;
  /** True when the answer had another page, so `count` is a floor. */
  more: boolean;
}

/**
 * A minute. The Health poll (30 s) is what decides whether something is wrong
 * right now; this badge only says there is something to go and read, and a
 * console left open all day should not double the load on `/ops/failures`.
 */
const POLL_MS = 60_000;
/** The same window the Failures page opens on, so the two numbers agree. */
const WINDOW_HOURS = 24;
const LIMIT = 50;

/**
 * How many failure groups the last day holds, for the sidebar's badge
 * (SCRUM-474). Read from the existing `GET /ops/failures` — the page's own
 * route and permission — and only while the tab is in front of somebody.
 *
 * Off (null) without `admin:health:read`, and null again on any failure: a
 * badge that guessed would be worse than no badge. Zero is also a reading the
 * caller renders as nothing.
 */
export function useFailureCount(enabled: boolean): FailureCount | null {
  const [reading, setReading] = useState<FailureCount | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReading(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;

    const read = async () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const page = await failuresApi.groups({ windowHours: WINDOW_HOURS, limit: LIMIT });
        if (!cancelled) setReading({ count: page.groups.length, more: Boolean(page.nextCursor) });
      } catch {
        if (!cancelled) setReading(null);
      } finally {
        inFlight = false;
      }
    };

    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  return reading;
}
