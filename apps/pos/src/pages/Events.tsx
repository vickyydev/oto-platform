import { useMemo, useState } from 'react';
import { useSearch } from 'wouter';
import { StationHeader } from '@/components/shared/StationHeader';
import { EventType, PartyBooking } from '@/types';
import { getEventsForDate } from '@/mockApi';
import { useBranch } from '@/branch/BranchContext';
import { computePartyOutstanding, PARTY_STATUS_LABELS } from '@/lib/party';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { EventAttendeeList } from '@/components/parties/EventAttendeeList';
import {
  PartyPopper,
  ChevronRight,
  ChevronLeft,
  CalendarDays,
  MapPin,
  Users,
  Tent,
  Sparkles,
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

const todayISO = () => new Date().toISOString().slice(0, 10);

const shiftDate = (iso: string, days: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'party', label: 'Parties' },
  { value: 'camp', label: 'Camps' },
  { value: 'event', label: 'Events' },
];

export default function Events() {
  const search = useSearch();
  const surface: 'till' | 'fnb' = search.includes('surface=fnb') ? 'fnb' : 'till';
  const { branch } = useBranch();

  const [date, setDate] = useState(todayISO());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [version, setVersion] = useState(0);

  const allEvents = useMemo(
    () => getEventsForDate(date, branch.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is bumped by onChanged to re-read the events store after a change
    [date, branch.id, version],
  );
  const events = useMemo(
    () => (typeFilter === 'all' ? allEvents : allEvents.filter((e) => e.type === typeFilter)),
    [allEvents, typeFilter],
  );
  const selected = selectedId ? allEvents.find((e) => e.id === selectedId) ?? null : null;
  const isToday = date === todayISO();

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden">
      <StationHeader active="parties" />

      <div className="flex-1 min-h-0 p-6">
        <div className="mx-auto h-full max-w-5xl flex flex-col min-h-0">
          {selected ? (
            selected.type === 'party' ? (
              <PartyDetail
                party={selected as unknown as PartyBooking}
                surface={surface}
                onBack={() => setSelectedId(null)}
                onChanged={() => setVersion((v) => v + 1)}
              />
            ) : (
              <EventAttendeeList
                event={selected}
                onBack={() => setSelectedId(null)}
              />
            )
          ) : (
            <>
              {/* Date navigator */}
              <div className="shrink-0 mb-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10"
                    onClick={() => setDate((d) => shiftDate(d, -1))}
                    aria-label="Previous day"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </Button>
                  <div className="flex items-center gap-2 px-3 h-10 rounded-lg bg-muted min-w-[260px] justify-center">
                    <CalendarDays className="w-4 h-4 text-muted-foreground" />
                    <span className="font-semibold">{fmtDate(date)}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10"
                    onClick={() => setDate((d) => shiftDate(d, 1))}
                    aria-label="Next day"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </Button>
                  {!isToday && (
                    <Button variant="ghost" className="h-10" onClick={() => setDate(todayISO())}>
                      Today
                    </Button>
                  )}
                </div>
                <span className="text-sm text-muted-foreground">
                  {allEvents.length} {allEvents.length === 1 ? 'event' : 'events'}
                </span>
              </div>

              {/* Type filter */}
              <div className="shrink-0 mb-4 flex items-center gap-2">
                {TYPE_FILTERS.map((f) => (
                  <Button
                    key={f.value}
                    variant={typeFilter === f.value ? 'default' : 'outline'}
                    size="sm"
                    className="h-8"
                    onClick={() => setTypeFilter(f.value)}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>

              {events.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground">
                  <PartyPopper className="w-12 h-12 mb-3 opacity-40" />
                  <p>No events booked for this day.</p>
                </div>
              ) : (
                <ScrollArea className="flex-1 -mx-1 px-1">
                  <div className="space-y-2">
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
                          onClick={() => setSelectedId(ev.id)}
                          className="w-full text-left"
                        >
                          <Card className="p-4 flex items-center gap-4 bg-card/50 hover:bg-card transition-colors">
                            {/* Time */}
                            <div className="flex flex-col items-center justify-center w-16 shrink-0">
                              <span className="text-lg font-black tabular-nums leading-none">
                                {ev.startTime}
                              </span>
                              <span className="text-xs text-muted-foreground mt-0.5">{ev.endTime}</span>
                            </div>

                            {/* Info */}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 font-bold flex-wrap">
                                <span className="truncate">{ev.title}</span>
                                <span
                                  className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${TYPE_BADGE_STYLE[ev.type]}`}
                                >
                                  {TYPE_LABEL[ev.type]}
                                </span>
                                <span
                                  className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${STATUS_STYLE[ev.status]}`}
                                >
                                  {PARTY_STATUS_LABELS[ev.status]}
                                </span>
                              </div>
                              <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap mt-0.5">
                                {isParty && ev.childName && (
                                  <span>
                                    {ev.childName}
                                    {ev.kidAge ? ` · ${ev.kidAge} yrs` : ''}
                                  </span>
                                )}
                                {!isParty && ev.dateRange && (
                                  <span className="flex items-center gap-1">
                                    <CalendarDays className="w-3 h-3" />
                                    {ev.dateRange.start} – {ev.dateRange.end}
                                  </span>
                                )}
                                <span className="flex items-center gap-1">
                                  <MapPin className="w-3 h-3" />
                                  {ev.location}
                                </span>
                                <span className="flex items-center gap-1">
                                  <Users className="w-3 h-3" />
                                  {isParty
                                    ? `${ev.expectedKids} kids · ${ev.expectedAdults} adults`
                                    : `${attendeeCount} registered`}
                                </span>
                              </div>
                            </div>

                            {/* Right side */}
                            <div className="flex items-center gap-3 shrink-0">
                              {isParty && outstanding !== null ? (
                                outstanding > 0 ? (
                                  <span className="text-right">
                                    <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                                      Outstanding
                                    </span>
                                    <span className="block text-lg font-bold tabular-nums text-amber-400">
                                      ฿{outstanding}
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-xs font-semibold text-emerald-400">Paid</span>
                                )
                              ) : !isParty ? (
                                <span className="text-xs text-muted-foreground">
                                  {ev.type === 'camp' ? (
                                    <Tent className="w-4 h-4" />
                                  ) : (
                                    <Sparkles className="w-4 h-4" />
                                  )}
                                </span>
                              ) : null}
                              <ChevronRight className="w-5 h-5 text-muted-foreground" />
                            </div>
                          </Card>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
