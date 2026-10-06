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
import { Banknote, Users, PartyPopper, Baby, Ticket } from 'lucide-react';

/**
 * Portrait-phone version of the Performance floor-report tab.
 * Renders the same figures as the iPad PerformanceTab but stacked vertically
 * as single-column cards — no grid breakpoints, no horizontal scrolling.
 * No logic is re-derived here.
 *
 * S2-15b round 3: the figures are the platform's rolled-up day (`usePerformance`),
 * the same ones the iPad tab reads, instead of this browser's copy of the sales.
 */
export function MobilePerformanceTab({
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
  const dropOffInPark = useDropOffInPark(performance.branchIds);
  const { readable } = performance;
  useEffect(() => {
    onReadable?.(readable);
  }, [onReadable, readable]);
  return <MobilePerformanceView performance={performance} dropOffInPark={dropOffInPark} isToday={isToday} />;
}

/** The phone tab as drawn, from figures already read. */
export function MobilePerformanceView({
  performance,
  dropOffInPark,
  isToday,
}: {
  performance: Pick<PerformanceState, 'report' | 'provisional' | 'updatedAt' | 'timezone' | 'error'>;
  dropOffInPark: number | null;
  isToday: boolean;
}) {
  const { report, error } = performance;
  if (!report) {
    return (
      <Card className="p-4 bg-card/50">
        <p role="status" className={error ? 'text-sm text-amber-600' : 'text-sm text-muted-foreground'}>
          {error ? `The figures could not be read from the platform — ${error}` : 'Loading Performance…'}
        </p>
      </Card>
    );
  }
  const { guests, ticketMix } = report;
  const totalGuests = guests.kids + guests.adults;
  const hasTicketMix = ticketMix.oneHour + ticketMix.twoHour + ticketMix.fullDay > 0;

  return (
    <div className="space-y-3">
      <PerformanceFreshness
        provisional={performance.provisional}
        updatedAt={performance.updatedAt}
        timezone={performance.timezone}
      />

      {/* Hero: revenue */}
      <StatCard
        size="lg"
        icon={<Banknote className="w-5 h-5" />}
        label="Revenue"
        value={`฿${report.netRevenueTHB.toLocaleString()}`}
        sub={
          <span>
            {report.txnCount} {report.txnCount === 1 ? 'transaction' : 'transactions'}
            {report.creditPaidTHB > 0 && (
              <> · excl. ฿{report.creditPaidTHB.toLocaleString()} via credit</>
            )}
          </span>
        }
      />

      {/* Guests */}
      <StatCard
        icon={<Users className="w-5 h-5" />}
        label="Guests checked in"
        value={totalGuests.toLocaleString()}
        sub={`${guests.kids} kids · ${guests.adults} adults`}
      />

      {/* Revenue split bars */}
      <RevenueBars buckets={report.revenueSplit} />

      {/* Parties */}
      <StatCard
        icon={<PartyPopper className="w-5 h-5" />}
        label={isToday ? 'Parties today' : 'Parties'}
        value={report.partiesToday.toLocaleString()}
        sub={report.partiesToday === 0 ? 'None booked' : 'Booked for this day'}
      />

      {/* Drop-off */}
      <StatCard
        icon={<Baby className="w-5 h-5" />}
        label="Drop-off kids in park"
        value={dropOffInPark === null ? '—' : dropOffInPark.toLocaleString()}
        sub="In the park right now"
      />

      {/* Ticket mix (optional) */}
      {hasTicketMix && (
        <Card className="p-5 bg-card/50">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-4">
            <Ticket className="w-4 h-4 text-primary" />
            Ticket mix
            <span className="font-normal">· guests by play length</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: '1 hour', value: ticketMix.oneHour },
              { label: '2 hours', value: ticketMix.twoHour },
              { label: 'Full day', value: ticketMix.fullDay },
            ].map((m) => (
              <div key={m.label} className="rounded-xl bg-muted/50 px-3 py-3 text-center">
                <div className="text-2xl font-bold tabular-nums">{m.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{m.label}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {report.netRevenueTHB === 0 && report.txnCount === 0 && (
        <p className="text-center text-muted-foreground py-4">
          No sales recorded for {isToday ? 'today' : 'this day'} yet.
        </p>
      )}
    </div>
  );
}
