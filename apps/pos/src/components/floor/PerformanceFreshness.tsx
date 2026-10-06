import { Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * S2-15b round 3 — UI ADDITION. One small line above the Performance figures
 * saying how fresh they are: while the day is still trading they are
 * provisional and follow the rollup, so the line says so and when they were
 * last brought up to date; a day that has ended says when it was last
 * written. In the muted voice of the tab's own sub-lines, with the amber the
 * End of Day uses for "provisional".
 */
export function PerformanceFreshness({
  provisional,
  updatedAt,
  timezone,
  className,
}: {
  provisional: boolean;
  updatedAt: string | null;
  timezone: string | null;
  className?: string;
}) {
  const when = updatedAt ? whenOf(updatedAt, timezone, provisional) : null;
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

/** `14:05` for an open day; `6 Oct, 21:10` for one that has ended. In the branch's time. */
function whenOf(iso: string, timezone: string | null, timeOnly: boolean): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const options: Intl.DateTimeFormatOptions = timeOnly
    ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone ?? undefined }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(at);
  }
}
