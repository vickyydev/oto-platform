import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/floor/StatCard';
import { RevenueBars } from '@/components/floor/RevenueBars';
import { getFloorReport } from '@/mockApi';
import { Banknote, Users, PartyPopper, Baby, Ticket } from 'lucide-react';

/**
 * Portrait-phone version of the Performance floor-report tab.
 * Renders the same figures as the iPad PerformanceTab but stacked vertically
 * as single-column cards — no grid breakpoints, no horizontal scrolling.
 * All data comes from getFloorReport; no logic is re-derived here.
 */
export function MobilePerformanceTab({
  date,
  branch,
  isToday,
}: {
  date: string;
  branch: string;
  isToday: boolean;
}) {
  const report = useMemo(() => getFloorReport(date, branch), [date, branch]);
  const { guests, ticketMix } = report;
  const totalGuests = guests.kids + guests.adults;
  const hasTicketMix = ticketMix.oneHour + ticketMix.twoHour + ticketMix.fullDay > 0;

  return (
    <div className="space-y-3">
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
        value={report.dropOffInParkNow.toLocaleString()}
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
