import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getCheckIns } from '@/mockApi';
import { remainingMinutes, dueState } from '@/lib/dropoff';

interface OverstayBannerProps {
  /** Tapped to review the overdue / due-soon children. */
  onReview: () => void;
  /** Extra classes for spacing in the host layout. */
  className?: string;
  /**
   * Bump to force an immediate recompute after a host mutation (e.g. a check-in
   * on the Drop-Off page). Otherwise the banner self-refreshes on a 10s tick.
   */
  refreshKey?: number;
}

/**
 * Sticky overstay summary across all in-park children ("N overdue · N due soon").
 * Self-contained: reads `getCheckIns()` and runs its own 10s clock tick so it can
 * live on any staff screen (Drop-Off and the Till). Renders nothing when no child
 * is overdue or due soon.
 */
export function OverstayBanner({ onReview, className = '', refreshKey = 0 }: OverstayBannerProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const { overdue, dueSoon, any } = useMemo(() => {
    let overdue = 0;
    let dueSoon = 0;
    for (const c of getCheckIns()) {
      const state = dueState(remainingMinutes(c, now));
      if (state === 'overdue') overdue += 1;
      else if (state === 'due_soon') dueSoon += 1;
    }
    return { overdue, dueSoon, any: overdue + dueSoon > 0 };
  }, [now, refreshKey]);

  if (!any) return null;

  return (
    <button
      type="button"
      onClick={onReview}
      className={`shrink-0 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 h-12 text-sm font-semibold text-amber-300 hover:bg-amber-500/15 transition-colors ${className}`}
    >
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span>
        {overdue > 0 && `${overdue} overdue`}
        {overdue > 0 && dueSoon > 0 && ' · '}
        {dueSoon > 0 && `${dueSoon} due soon`}
      </span>
      <span className="ml-auto text-xs font-medium opacity-80">Review →</span>
    </button>
  );
}
