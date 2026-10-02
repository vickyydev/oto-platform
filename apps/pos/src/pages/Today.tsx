import { useState } from 'react';
import { StationHeader } from '@/components/shared/StationHeader';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PerformanceTab } from '@/components/floor/PerformanceTab';
import { EndOfDayTab } from '@/components/eod/EndOfDayTab';
import { useBranch } from '@/branch/BranchContext';
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
 * "Today" — one section, two tabs over the SAME selected day + branch:
 *   • Performance — the glanceable floor report (default).
 *   • End of Day  — the full reconciliation + Close Day.
 * The date picker and branch live here at the section level so both tabs always read
 * the same day; each tab derives its own view from the shared in-memory ledger (no
 * revenue logic is duplicated — one getFloorReport, one getEndOfDay).
 */
export default function Today({ initialTab = 'performance' }: { initialTab?: TodayTab }) {
  const { branch } = useBranch();
  const [date, setDate] = useState<string>(todayKey());
  const [tab, setTab] = useState<TodayTab>(initialTab);
  const isToday = date === todayKey();

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden">
      <StationHeader active="today" />

      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto max-w-5xl p-6">
          {/* Section header: title + branch + shared date picker */}
          <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Today</h1>
              <p className="text-muted-foreground mt-1">{branch.name}</p>
            </div>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              Date
              <input
                type="date"
                value={date}
                max={todayKey()}
                onChange={(e) => setDate(e.target.value || todayKey())}
                className="h-11 rounded-xl bg-muted/50 border border-border px-4 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 [color-scheme:dark]"
              />
            </label>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as TodayTab)}>
            <TabsList className="h-11 mb-4">
              <TabsTrigger value="performance" className="h-9 gap-2 px-4 text-sm">
                <LineChart className="w-4 h-4" />
                Performance
              </TabsTrigger>
              <TabsTrigger value="eod" className="h-9 gap-2 px-4 text-sm">
                <Calculator className="w-4 h-4" />
                End of Day
              </TabsTrigger>
            </TabsList>

            <TabsContent value="performance">
              <PerformanceTab date={date} branch={branch.id} isToday={isToday} />
            </TabsContent>
            <TabsContent value="eod">
              <EndOfDayTab date={date} branch={branch.id} />
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}
