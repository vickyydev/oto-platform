import { useEffect, useState } from 'react';
import { CalendarDays, Sun } from 'lucide-react';
import { todayRateMode } from '@/lib/pricingMode';
import { useBranch } from '@/branch/BranchContext';
import { catalogApi } from '@/api/platform';
import type { RateModeResult } from '@/lib/pricingMode';

/**
 * Small always-visible chip naming today's active pricing mode + reason
 * ("Weekend pricing — Songkran" / "Weekend pricing" / "Weekday pricing").
 *
 * Sprint 1 rebuild (SCRUM-36): the chip is driven by the API pricing
 * resolver for today's date at the active branch; the local ported
 * computation stays as the fallback while the fetch is in flight (its
 * holiday data is hydrated from the same API, so the two agree).
 */
export function PricingModeIndicator() {
  const { branch } = useBranch();
  const [remote, setRemote] = useState<RateModeResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRemote(null);
    if (!branch?.apiId) return;
    const load = () =>
      catalogApi
        .pricingMode(branch.apiId!)
        .then((r) => {
          if (!cancelled) setRemote({ mode: r.mode, reason: r.reason, overrideName: r.overrideName });
        })
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 60_000); // day/holiday rollovers
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [branch?.apiId]);

  const { mode, reason, overrideName } = remote ?? todayRateMode();
  const isWeekend = mode === 'weekend';
  return (
    <span
      title={reason}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
        isWeekend
          ? 'bg-amber-500/15 text-amber-500'
          : 'bg-foreground/5 text-foreground/50'
      }`}
    >
      {overrideName ? <CalendarDays className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
      <span className="hidden sm:inline">{reason}</span>
    </span>
  );
}
