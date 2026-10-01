import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useBranch } from '@/branch/BranchContext';
import { boardApi, boardChildToCheckIn, requirePlatformBranchId } from '@/api/checkin';
import { remainingMinutes, dueState } from '@/lib/dropoff';
import type { CheckIn } from '@/types';

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

/** How often the banner re-reads the board from the platform; the timers tick locally every 10 s. */
const RELOAD_MS = 60_000;

/**
 * Sticky overstay summary across all in-park children ("N overdue · N due soon").
 * Self-contained: reads the park's board from the platform (S2-13 round 2 —
 * the prototype read `getCheckIns()`) and runs its own 10s clock tick so it can
 * live on any staff screen (Drop-Off and the Till). Renders nothing when no child
 * is overdue or due soon, and nothing when the board cannot be read.
 */
export function OverstayBanner({ onReview, className = '', refreshKey = 0 }: OverstayBannerProps) {
  const { branch } = useBranch();
  const [now, setNow] = useState(Date.now());
  const [inPark, setInPark] = useState<CheckIn[]>([]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let platformId: string;
    try {
      platformId = requirePlatformBranchId(branch.id);
    } catch {
      setInPark([]);
      return;
    }
    let live = true;
    const load = () =>
      boardApi
        .board(platformId)
        .then((b) => {
          if (!live) return;
          setInPark(
            b.families.flatMap((f) => f.children.filter((c) => c.status === 'in_park').map((c) => boardChildToCheckIn(c, f))),
          );
        })
        .catch(() => {
          // A board that cannot be read shows no banner rather than a wrong one.
          if (live) setInPark([]);
        });
    void load();
    const id = window.setInterval(() => void load(), RELOAD_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [branch.id, refreshKey]);

  const { overdue, dueSoon, any } = useMemo(() => {
    let overdue = 0;
    let dueSoon = 0;
    for (const c of inPark) {
      const state = dueState(remainingMinutes(c, now));
      if (state === 'overdue') overdue += 1;
      else if (state === 'due_soon') dueSoon += 1;
    }
    return { overdue, dueSoon, any: overdue + dueSoon > 0 };
  }, [now, inPark]);

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
