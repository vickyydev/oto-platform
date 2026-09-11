import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/floor/StatCard';
import { RevenueBars } from '@/components/floor/RevenueBars';
import { getFloorReport } from '@/mockApi';
import { Banknote, Users, PartyPopper, Baby, Ticket } from 'lucide-react';

/**
 * Performance tab of the "Today" section: a small, glanceable per-day snapshot for any
 * logged-in operator — revenue, guests, the revenue split, and live ops. Reads the
 * in-memory ledger via getFloorReport for the section's selected date + branch. Not an
 * analytics dashboard. (Date/branch are owned by the Today section, not this tab.)
 */
export function PerformanceTab({
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
          value={report.dropOffInParkNow.toLocaleString()}
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
