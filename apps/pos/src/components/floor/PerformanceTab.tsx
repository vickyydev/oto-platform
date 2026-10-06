import { useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/floor/StatCard';
import { RevenueBars } from '@/components/floor/RevenueBars';
import { PerformanceFreshness } from '@/components/floor/PerformanceFreshness';
import {
  useDropOffInPark,
  usePerformance,
  type PerformanceScope,
  type PerformanceState,
} from '@/components/floor/usePerformance';
import type { FloorReport } from '@/types';
import { Banknote, Users, PartyPopper, Baby, Ticket } from 'lucide-react';

/**
 * Performance tab of the "Today" section: a small, glanceable per-day snapshot for any
 * logged-in operator — revenue, guests, the revenue split, and live ops. Not an
 * analytics dashboard. (Date/branch are owned by the Today section, not this tab.)
 *
 * S2-15b round 3: the figures are the platform's rolled-up day for the section's date
 * and branch (`usePerformance`), the same on every till and phone, instead of this
 * browser's copy of the sales (`getFloorReport`). `scope` reads every branch this
 * account may read, added up on the platform; `onReadable` tells the section which
 * branches those are, so it offers "All branches" only to somebody with more than one.
 */
export function PerformanceTab({
  date,
  branch,
  isToday,
  scope = 'branch',
  onReadable,
}: {
  date: string;
  branch: string;
  isToday: boolean;
  scope?: PerformanceScope;
  onReadable?: (readable: PerformanceState['readable']) => void;
}) {
  const performance = usePerformance(date, branch, scope, isToday);
  // S2-13 round 2: the drop-off children in the park now are the platform's
  // check-ins, not the mock store's — live, not date-bound, as the card says.
  const dropOffInPark = useDropOffInPark(performance.branchIds);
  const { readable } = performance;
  useEffect(() => {
    onReadable?.(readable);
  }, [onReadable, readable]);
  return <PerformanceView performance={performance} dropOffInPark={dropOffInPark} isToday={isToday} />;
}

/**
 * What the drawn tab needs of `usePerformance`. `today` and `businessDayStart`
 * (the branch's trading day in progress, from the platform) let the freshness
 * line tell an update from earlier today from one left over from an earlier
 * day; without them, the date shown is taken as today when `isToday` says so.
 */
export type PerformanceViewState = Pick<PerformanceState, 'report' | 'provisional' | 'updatedAt' | 'timezone' | 'error'> &
  Partial<Pick<PerformanceState, 'today' | 'businessDayStart'>>;

/** The tab as drawn, from figures already read. */
export function PerformanceView({
  performance,
  dropOffInPark,
  isToday,
}: {
  performance: PerformanceViewState;
  dropOffInPark: number | null;
  isToday: boolean;
}) {
  const { report, error } = performance;
  if (!report) {
    return (
      <Card className="p-5 bg-card/50">
        <p role="status" className={error ? 'text-sm text-amber-600' : 'text-sm text-muted-foreground'}>
          {error ? `The figures could not be read from the platform — ${error}` : 'Loading Performance…'}
        </p>
      </Card>
    );
  }
  return (
    <div>
      <PerformanceFreshness
        provisional={performance.provisional}
        updatedAt={performance.updatedAt}
        timezone={performance.timezone}
        today={performance.today ?? (isToday ? report.date : null)}
        dayStart={performance.businessDayStart ?? null}
        className="mb-3"
      />
      <PerformanceFigures report={report} dropOffInPark={dropOffInPark} isToday={isToday} />
    </div>
  );
}

function PerformanceFigures({
  report,
  dropOffInPark,
  isToday,
}: {
  report: FloorReport;
  dropOffInPark: number | null;
  isToday: boolean;
}) {
  const { guests, ticketMix } = report;
  const totalGuests = guests.kids + guests.adults;
  const hasTicketMix = ticketMix.oneHour + ticketMix.twoHour + ticketMix.fullDay > 0;

  return (
    <div>
      {/* Headline: revenue + guests */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <StatCard
          className="sm:col-span-2"
          size="lg"
          icon={<Banknote className="w-5 h-5" />}
          label="Revenue"
          value={`฿${report.netRevenueTHB.toLocaleString()}`}
          sub={
            <span>
              {report.txnCount} {report.txnCount === 1 ? 'transaction' : 'transactions'}
              {report.creditPaidTHB > 0 && (
                <> · excl. ฿{report.creditPaidTHB.toLocaleString()} paid via credit</>
              )}
            </span>
          }
        />
        <StatCard
          icon={<Users className="w-5 h-5" />}
          label="Guests checked in"
          value={totalGuests.toLocaleString()}
          sub={`${guests.kids} kids · ${guests.adults} adults`}
        />
      </div>

      {/* Live operations */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <StatCard
          icon={<PartyPopper className="w-5 h-5" />}
          label={isToday ? 'Parties today' : 'Parties'}
          value={report.partiesToday.toLocaleString()}
          sub={report.partiesToday === 0 ? 'None booked' : 'Booked for this day'}
        />
        <StatCard
          icon={<Baby className="w-5 h-5" />}
          label="Drop-off kids in park"
          value={dropOffInPark === null ? '—' : dropOffInPark.toLocaleString()}
          sub="In the park right now"
        />
      </div>

      {/* Revenue split */}
      <div className="mb-4">
        <RevenueBars buckets={report.revenueSplit} />
      </div>

      {/* Ticket mix (optional) */}
      {hasTicketMix && (
        <Card className="p-5 bg-card/50">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-4">
            <Ticket className="w-4 h-4 text-primary" />
            Ticket mix
            <span className="font-normal">· guests by play length</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: '1 hour', value: ticketMix.oneHour },
              { label: '2 hours', value: ticketMix.twoHour },
              { label: 'Full day', value: ticketMix.fullDay },
            ].map((m) => (
              <div key={m.label} className="rounded-xl bg-muted/50 px-4 py-3 text-center">
                <div className="text-2xl font-bold tabular-nums">{m.value}</div>
                <div className="text-sm text-muted-foreground mt-0.5">{m.label}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {report.netRevenueTHB === 0 && report.txnCount === 0 && (
        <p className="text-center text-muted-foreground mt-6">
          No sales recorded for {isToday ? 'today' : 'this day'} yet.
        </p>
      )}
    </div>
  );
}
