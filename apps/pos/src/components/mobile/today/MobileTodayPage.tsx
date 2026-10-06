import { useCallback, useEffect, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useBranch } from '@/branch/BranchContext';
import { PerformanceScopePicker } from '@/components/floor/PerformanceScopePicker';
import type { PerformanceScope, PerformanceState } from '@/components/floor/usePerformance';
import { MobilePerformanceTab } from './MobilePerformanceTab';
import { MobileEndOfDayTab } from './MobileEndOfDayTab';
import { LineChart, Calculator } from 'lucide-react';
import { branchTradingDate, serverTradingDate } from '@/lib/pricingMode';

// S2-15a — the day the picker opens on is the branch's BUSINESS date (its trading day,
// `business_day_start` in its timezone), the date the End of Day is recorded under:
// the platform's answer for today when the till has one, else this device's clock
// placed on the branch's calendar. Not a UTC slice, which put 00:00-07:00 in Thailand
// on the wrong day.
const todayKey = (): string => serverTradingDate() ?? branchTradingDate();

type TodayTab = 'performance' | 'eod';

/**
 * Portrait-phone Today surface — two-tab segmented control switching between:
 *   • Performance — glanceable floor-report cards for the selected date.
 *   • End of Day  — per-channel cash-up + Close Day for the selected date.
 *
 * The date picker and branch live here at the page level so both tabs read the
 * exact same day (same pattern as the iPad Today.tsx, restacked for portrait).
 * No logic is duplicated — the figures come from the platform (the rolled-up
 * day for Performance, the End of Day record).
 *
 * S2-15b round 3 — UI ADDITION: the same Branch choice as the iPad (this
 * branch or "All branches"), on its own row under the title, on Performance
 * only and only for somebody who may read more than one branch.
 */
export function MobileTodayPage() {
  const { branch } = useBranch();
  const [date, setDate] = useState<string>(todayKey());
  const [tab, setTab] = useState<TodayTab>('performance');
  const [scope, setScope] = useState<PerformanceScope>('branch');
  const [readable, setReadable] = useState<PerformanceState['readable']>([]);
  const onReadable = useCallback((list: PerformanceState['readable']) => setReadable(list), []);
  const isToday = date === todayKey();
  const canPickAll = readable.length > 1;
  useEffect(() => {
    if (!canPickAll) setScope('branch');
  }, [canPickAll]);
  const allBranches = tab === 'performance' && scope === 'all';

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Compact page header: title + date picker */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b bg-card/20 space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Today</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{allBranches ? 'All branches' : branch.name}</p>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Date
            <input
              type="date"
              value={date}
              max={todayKey()}
              onChange={(e) => setDate(e.target.value || todayKey())}
              className="h-9 rounded-xl bg-muted/50 border border-border px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 [color-scheme:dark]"
            />
          </label>
        </div>

        {tab === 'performance' && canPickAll && (
          <PerformanceScopePicker branchName={branch.name} scope={scope} onScope={setScope} compact />
        )}

        {/* Segmented control */}
        <div className="flex rounded-xl bg-muted/60 p-1 gap-1">
          <button
            type="button"
            onClick={() => setTab('performance')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-semibold transition-colors ${
              tab === 'performance'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <LineChart className="w-4 h-4" />
            Performance
          </button>
          <button
            type="button"
            onClick={() => setTab('eod')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-semibold transition-colors ${
              tab === 'eod'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Calculator className="w-4 h-4" />
            End of Day
          </button>
        </div>
      </div>

      {/* Scrollable tab content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4">
          {tab === 'performance' ? (
            <MobilePerformanceTab
              date={date}
              branch={branch.id}
              isToday={isToday}
              scope={canPickAll ? scope : 'branch'}
              onReadable={onReadable}
            />
          ) : (
            <MobileEndOfDayTab date={date} branch={branch.id} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
