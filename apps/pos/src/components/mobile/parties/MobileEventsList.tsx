import { useMemo, useState } from 'react';
import { OtoEvent, EventType, PartyBooking } from '@/types';
import { getEventsForDate } from '@/mockApi';
import { useBranch } from '@/branch/BranchContext';
import { computePartyOutstanding, PARTY_STATUS_LABELS } from '@/lib/party';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  PartyPopper,
  ChevronRight,
  ChevronLeft,
  Clock,
  MapPin,
  Users,
  CalendarDays,
} from 'lucide-react';

type TypeFilter = 'all' | EventType;

const TYPE_BADGE_STYLE: Record<EventType, string> = {
  party: 'bg-violet-500/15 text-violet-400',
  camp: 'bg-emerald-500/15 text-emerald-400',
  event: 'bg-sky-500/15 text-sky-400',
};
const TYPE_LABEL: Record<EventType, string> = {
  party: 'Party',
  camp: 'Camp',
  event: 'Event',
};

const STATUS_STYLE: Record<PartyBooking['status'], string> = {
  upcoming: 'bg-sky-500/15 text-sky-400',
  in_progress: 'bg-emerald-500/15 text-emerald-400',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/15 text-destructive',
};

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'party', label: 'Parties' },
  { value: 'camp', label: 'Camps' },
  { value: 'event', label: 'Events' },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

const shiftDate = (iso: string, days: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

interface MobileEventsListProps {
  version: number;
  onSelectEvent: (id: string, date: string) => void;
}

export function MobileEventsList({ version, onSelectEvent }: MobileEventsListProps) {
  const { branch } = useBranch();
  const [date, setDate] = useState(todayISO());
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  const allEvents = useMemo(
    () => getEventsForDate(date, branch.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [date, branch.id, version],
  );
  const events = useMemo(
    () => (typeFilter === 'all' ? allEvents : allEvents.filter((e) => e.type === typeFilter)),
    [allEvents, typeFilter],
  );

  const isToday = date === todayISO();

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Date navigator */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => setDate((d) => shiftDate(d, -1))}
            aria-label="Previous day"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="flex-1 flex items-center gap-2 px-3 h-9 rounded-lg bg-muted justify-center min-w-0">
            <CalendarDays className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="font-semibold text-sm truncate">{fmtDate(date)}</span>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => setDate((d) => shiftDate(d, 1))}
            aria-label="Next day"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          {!isToday && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 h-9"
              onClick={() => setDate(todayISO())}
            >
              Today
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          {allEvents.length} {allEvents.length === 1 ? 'event' : 'events'}
        </p>

        {/* Type filter */}
        <div className="flex items-center gap-1.5 mt-2">
          {TYPE_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={typeFilter === f.value ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs flex-1"
              onClick={() => setTypeFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Event list */}
      {events.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground p-8">
          <PartyPopper className="w-12 h-12 mb-3 opacity-40" />
          <p className="text-sm">No events for this day.</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
            {events.map((ev) => {
              const isParty = ev.type === 'party';
              const outstanding = isParty
                ? computePartyOutstanding(ev as unknown as PartyBooking)
                : null;
              const attendeeCount = ev.attendees?.length ?? 0;

              return (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => onSelectEvent(ev.id, date)}
                  className="w-full text-left"
                >
                  <Card className="p-4 bg-card/50 hover:bg-card transition-colors active:scale-[0.99]">
                    <div className="flex items-start gap-3">
                      {/* Time column */}
                      <div className="flex flex-col items-center justify-center w-14 shrink-0 pt-0.5">
                        <span className="text-base font-black tabular-nums leading-none">
                          {ev.startTime}
                        </span>
                        <span className="text-[10px] text-muted-foreground mt-0.5">
                          {ev.endTime}
                        </span>
                      </div>

                      {/* Main info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-bold truncate text-sm">{ev.title}</span>
                          <span
                            className={`text-[9px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 shrink-0 ${TYPE_BADGE_STYLE[ev.type]}`}
                          >
                            {TYPE_LABEL[ev.type]}
                          </span>
                          <span
                            className={`text-[9px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 shrink-0 ${STATUS_STYLE[ev.status]}`}
                          >
                            {PARTY_STATUS_LABELS[ev.status]}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          {isParty && ev.childName && (
                            <div className="truncate">
                              {ev.childName}
                              {ev.kidAge ? ` · ${ev.kidAge} yrs` : ''}
                            </div>
                          )}
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              {ev.location}
                            </span>
                            <span className="flex items-center gap-1">
                              <Users className="w-3 h-3" />
                              {isParty
                                ? `${ev.expectedKids}k · ${ev.expectedAdults}a`
                                : `${attendeeCount} registered`}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Balance / chevron */}
                      <div className="flex items-center gap-2 shrink-0">
                        {isParty && outstanding !== null ? (
                          outstanding > 0 ? (
                            <div className="text-right">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                Due
                              </div>
                              <div className="text-base font-bold tabular-nums text-amber-400">
                                ฿{outstanding}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs font-semibold text-emerald-400">Paid</span>
                          )
                        ) : null}
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </div>
                    </div>

                    {/* Timeline hint (party) / date range hint (camp) */}
                    {isParty && ev.timeline && ev.timeline.length > 0 && (
                      <div className="mt-2 pt-2 border-t flex items-center gap-2 text-xs text-muted-foreground overflow-hidden">
                        <Clock className="w-3 h-3 shrink-0" />
                        <span className="truncate">
                          {ev.timeline
                            .slice(0, 3)
                            .map((t) => `${t.time} ${t.label}`)
                            .join(' · ')}
                        </span>
                      </div>
                    )}
                    {!isParty && ev.dateRange && (
                      <div className="mt-2 pt-2 border-t flex items-center gap-2 text-xs text-muted-foreground">
                        <CalendarDays className="w-3 h-3 shrink-0" />
                        <span>
                          {ev.dateRange.start} – {ev.dateRange.end}
                        </span>
                      </div>
                    )}
                  </Card>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
