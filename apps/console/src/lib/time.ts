/** A timestamp as the branch would read it, never as the device's clock. */
export function formatWhen(iso: string | null | undefined, timezone?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone ?? undefined,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/**
 * The same instant to the second, with the zone named. Used where a reader is
 * lining two records up against each other and a minute is not fine enough.
 */
export function formatExact(iso: string | null | undefined, timezone?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
      timeZone: timezone ?? undefined,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * How long ago, in the shortest form that is still true. "3 min ago" is what a
 * person reading a failure list actually wants; the exact stamp is one hover
 * away.
 */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  return seconds < 10 ? 'just now' : `${elapsed(seconds)} ago`;
}

/**
 * Seconds as a duration a person reads at a glance: 45s, 4m, 2h 10m, 3d 4h.
 * The second unit is dropped when it is zero — "every 1h 0m" is noise where
 * "every 1h" is the fact.
 */
export function elapsed(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h < 6 && m % 60 !== 0 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** Milliseconds, for latencies where the digits themselves are the point. */
export function millis(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** An ISO instant this many hours before now, for a date-range preset. */
export function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}
