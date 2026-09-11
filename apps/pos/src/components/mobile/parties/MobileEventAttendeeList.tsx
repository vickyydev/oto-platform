import { useMemo, useState } from 'react';
import { OtoEvent, EventAttendee, EventAttendeeCheckin } from '@/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PARTY_STATUS_LABELS } from '@/lib/party';
import {
  ROSTER_FILTERS,
  groupAttendees,
  computeRosterStats,
  type RosterFilter,
} from '@/lib/eventRoster';
import {
  ArrowLeft,
  CalendarDays,
  Clock,
  MapPin,
  Users,
  AlertTriangle,
  Salad,
  Phone,
  Contact,
  Globe,
  Search,
  LogIn,
  LogOut,
  CheckCircle2,
  Printer,
} from 'lucide-react';

const TYPE_BADGE_STYLE = {
  party: 'bg-violet-500/15 text-violet-400',
  camp: 'bg-emerald-500/15 text-emerald-400',
  event: 'bg-sky-500/15 text-sky-400',
};
const TYPE_LABEL = {
  party: 'Party',
  camp: 'Camp',
  event: 'Event',
};
const STATUS_STYLE = {
  upcoming: 'bg-sky-500/15 text-sky-400',
  in_progress: 'bg-emerald-500/15 text-emerald-400',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/15 text-destructive',
};

const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

interface MobileEventAttendeeListProps {
  event: OtoEvent;
  onBack: () => void;
  // When provided, enables check-in mode for this date (today's session).
  checkInDate?: string;
  onCheckIn?: (attendeeId: string) => void;
  onCheckOut?: (attendeeId: string) => void;
  // Re-dispatch the bracelet print for an already-checked-in attendee (lost band
  // / jammed printer) without touching the check-in record.
  onReprint?: (attendeeId: string) => void;
  // Increment to force re-render after an in-place mutation.
  refreshKey?: number;
}

function CheckinBadge({ record }: { record: EventAttendeeCheckin }) {
  if (record.checkedOutAt) {
    return (
      <span className="flex flex-col gap-0.5 text-[11px]">
        <span className="flex items-center gap-1 text-muted-foreground font-semibold">
          <LogOut className="w-3 h-3" />
          Out · {fmtTime(record.checkedOutAt)}
        </span>
        <span className="text-[10px] text-muted-foreground/80">
          In · {fmtTime(record.checkedInAt)} · {record.operatorName}
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-semibold flex-wrap">
      <CheckCircle2 className="w-3 h-3" />
      In · {fmtTime(record.checkedInAt)} · Band {record.wristbandCode}
      {record.parentWristbandCode && ` · Parent ${record.parentWristbandCode}`}
      <span className="text-muted-foreground font-medium">· {record.operatorName}</span>
    </span>
  );
}

function AttendeeRow({
  attendee,
  isCamp,
  checkInDate,
  onCheckIn,
  onCheckOut,
  onReprint,
}: {
  attendee: EventAttendee;
  isCamp: boolean;
  checkInDate?: string;
  onCheckIn?: () => void;
  onCheckOut?: () => void;
  onReprint?: () => void;
}) {
  const checkinRecord = checkInDate ? attendee.checkinByDate?.[checkInDate] : undefined;
  const isCheckedIn = !!checkinRecord?.checkedInAt && !checkinRecord?.checkedOutAt;
  const isCheckedOut = !!checkinRecord?.checkedOutAt;
  const showCheckInActions = !!checkInDate && !!onCheckIn;
  const isDeclined = attendee.rsvpStatus === 'declined';
  const notRegisteredToday =
    isCamp &&
    checkInDate != null &&
    !(attendee.attendanceDays?.includes(checkInDate) ?? true);

  return (
    <Card className={`p-3 bg-card/50 ${isDeclined ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="font-semibold text-sm">{attendee.name}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
            {attendee.age != null && <span>{attendee.age} yrs</span>}
            {attendee.language && (
              <span className="flex items-center gap-1">
                <Globe className="w-3 h-3" />
                {attendee.language}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          {attendee.allergyFlag && (
            <span className="flex items-center gap-1 text-[9px] font-bold rounded-full px-1.5 py-0.5 bg-red-500/15 text-red-400">
              <AlertTriangle className="w-3 h-3" />
              Allergy
            </span>
          )}
          {attendee.dietaryFlag && (
            <span className="flex items-center gap-1 text-[9px] font-bold rounded-full px-1.5 py-0.5 bg-amber-500/15 text-amber-400">
              <Salad className="w-3 h-3" />
              Dietary
            </span>
          )}
        </div>
      </div>

      {attendee.allergyFlag && attendee.allergyDetail && (
        <div className="mb-2 rounded-md bg-red-500/10 border border-red-500/20 px-2.5 py-1.5 text-[11px] text-red-300">
          <span className="font-semibold">Medical: </span>{attendee.allergyDetail}
        </div>
      )}
      {attendee.dietaryFlag && attendee.dietaryDetail && (
        <div className="mb-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 text-[11px] text-amber-300">
          <span className="font-semibold">Dietary: </span>{attendee.dietaryDetail}
        </div>
      )}

      {isCamp && attendee.attendanceDays && attendee.attendanceDays.length > 0 && (
        <div className="mb-2">
          <div className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
            <CalendarDays className="w-3 h-3" />
            Attendance ({attendee.attendanceDays.length} days)
          </div>
          <div className="flex flex-wrap gap-1">
            {attendee.attendanceDays.map((d) => (
              <span
                key={d}
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                  checkInDate === d
                    ? 'bg-primary/20 text-primary font-bold'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {fmtDate(d)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-start gap-4 text-xs">
        <div className="flex-1 min-w-0">
          <div className="text-muted-foreground flex items-center gap-1 mb-0.5">
            <Contact className="w-3 h-3" />
            Guardian
          </div>
          <div className="font-medium truncate">{attendee.parentName}</div>
          {attendee.parentPhone && (
            <div className="text-muted-foreground flex items-center gap-1">
              <Phone className="w-3 h-3" />
              {attendee.parentPhone}
            </div>
          )}
        </div>
        {attendee.emergencyContact && (
          <div className="flex-1 min-w-0">
            <div className="text-muted-foreground flex items-center gap-1 mb-0.5">
              <AlertTriangle className="w-3 h-3" />
              Emergency
            </div>
            <div className="font-medium text-[11px] break-words">{attendee.emergencyContact}</div>
          </div>
        )}
      </div>

      {/* Check-in state or actions */}
      {showCheckInActions && (
        <div className="mt-2.5 pt-2.5 border-t border-border flex items-center justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            {checkinRecord ? (
              <CheckinBadge record={checkinRecord} />
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {notRegisteredToday ? 'Not registered for today' : 'Not yet checked in'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!checkinRecord && !isDeclined && (
              <Button
                size="sm"
                className="h-9 gap-1.5"
                onClick={onCheckIn}
                disabled={notRegisteredToday}
              >
                <LogIn className="w-4 h-4" />
                Check in
              </Button>
            )}
            {isCheckedIn && onReprint && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                onClick={onReprint}
              >
                <Printer className="w-4 h-4" />
                Reprint band
              </Button>
            )}
            {isCheckedIn && onCheckOut && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 text-muted-foreground"
                onClick={onCheckOut}
              >
                <LogOut className="w-4 h-4" />
                Check out
              </Button>
            )}
            {isCheckedOut && (
              <span className="text-[11px] font-semibold text-muted-foreground">Checked out</span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function RosterSection({
  title,
  count,
  accent,
  icon,
  attendees,
  isCamp,
  checkInDate,
  onCheckIn,
  onCheckOut,
  onReprint,
}: {
  title: string;
  count: number;
  accent: string;
  icon: React.ReactNode;
  attendees: EventAttendee[];
  isCamp: boolean;
  checkInDate?: string;
  onCheckIn?: (attendeeId: string) => void;
  onCheckOut?: (attendeeId: string) => void;
  onReprint?: (attendeeId: string) => void;
}) {
  if (attendees.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className={`flex items-center gap-1.5 text-xs font-bold ${accent}`}>
          {icon}
          {title}
        </span>
        <span className="text-[10px] font-bold tabular-nums rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="space-y-2.5">
        {attendees.map((att, i) => (
          <div key={att.id} className="flex gap-2">
            <div className="w-6 shrink-0 flex items-start justify-center pt-3">
              <span className="text-xs font-bold text-muted-foreground">{i + 1}</span>
            </div>
            <div className="flex-1 min-w-0">
              <AttendeeRow
                attendee={att}
                isCamp={isCamp}
                checkInDate={checkInDate}
                onCheckIn={onCheckIn ? () => onCheckIn(att.id) : undefined}
                onCheckOut={onCheckOut ? () => onCheckOut(att.id) : undefined}
                onReprint={onReprint ? () => onReprint(att.id) : undefined}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MobileEventAttendeeList({
  event,
  onBack,
  checkInDate,
  onCheckIn,
  onCheckOut,
  onReprint,
  refreshKey: _refreshKey,
}: MobileEventAttendeeListProps) {
  const [query, setQuery] = useState('');
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>('all');
  const attendees = event.attendees ?? [];
  const isCamp = event.type === 'camp';
  const isCheckInMode = !!checkInDate;

  const rosterStats = useMemo(
    () =>
      checkInDate
        ? computeRosterStats(attendees, checkInDate, isCamp)
        : { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attendees, checkInDate, isCamp, _refreshKey],
  );

  const filteredAttendees = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return attendees;
    return attendees.filter((a) =>
      `${a.name} ${a.parentName} ${a.parentPhone ?? ''}`.toLowerCase().includes(q),
    );
  }, [attendees, query]);

  const groups = useMemo(
    () =>
      checkInDate
        ? groupAttendees(filteredAttendees, checkInDate, isCamp)
        : { inList: [], outList: [], outstandingList: [], notTodayList: [] },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredAttendees, checkInDate, isCamp, _refreshKey],
  );

  const showIn = rosterFilter === 'all' || rosterFilter === 'in';
  const showOutstanding = rosterFilter === 'all' || rosterFilter === 'outstanding';
  const showOut = rosterFilter === 'all';
  const showNotToday = rosterFilter === 'all';

  const visibleCount =
    (showIn ? groups.inList.length : 0) +
    (showOutstanding ? groups.outstandingList.length : 0) +
    (showOut ? groups.outList.length : 0) +
    (showNotToday ? groups.notTodayList.length : 0);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 pt-3 pb-3 border-b">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All events
        </button>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-black tracking-tight leading-tight truncate">{event.title}</h2>
              <span
                className={`text-[9px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0 ${TYPE_BADGE_STYLE[event.type]}`}
              >
                {TYPE_LABEL[event.type]}
              </span>
              <span
                className={`text-[9px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0 ${STATUS_STYLE[event.status]}`}
              >
                {PARTY_STATUS_LABELS[event.status]}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {event.startTime} – {event.endTime}
              </span>
              <span className="flex items-center gap-1">
                <MapPin className="w-3 h-3" />
                {event.location}
              </span>
              <span className="flex items-center gap-1">
                <Users className="w-3 h-3" />
                {attendees.length} registered
                {isCheckInMode && (
                  <span className="text-emerald-400 font-semibold ml-1">
                    · {rosterStats.currentlyIn} in
                  </span>
                )}
              </span>
            </div>
            {isCamp && event.dateRange && (
              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                <CalendarDays className="w-3 h-3" />
                {event.dateRange.start} – {event.dateRange.end}
              </div>
            )}
          </div>
        </div>

        {/* Flag summary */}
        {attendees.length > 0 && (
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {attendees.some((a) => a.allergyFlag) && (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-red-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                {attendees.filter((a) => a.allergyFlag).length} allergy/medical
              </span>
            )}
            {attendees.some((a) => a.dietaryFlag) && (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-400">
                <Salad className="w-3.5 h-3.5" />
                {attendees.filter((a) => a.dietaryFlag).length} dietary
              </span>
            )}
          </div>
        )}

        {/* Search */}
        {attendees.length > 0 && (
          <div className="mt-2.5 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search attendee or parent…"
              className="h-10 pl-10 text-sm"
            />
          </div>
        )}

        {/* Roster progress + filter (check-in mode only) */}
        {isCheckInMode && attendees.length > 0 && (
          <div className="mt-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold">
                <span className="text-emerald-400 tabular-nums">{rosterStats.arrived}</span>
                <span className="text-muted-foreground"> / {rosterStats.expected} checked in</span>
              </span>
              <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
                {ROSTER_FILTERS.map((f) => {
                  const isActive = rosterFilter === f.value;
                  const count =
                    f.value === 'in'
                      ? rosterStats.currentlyIn
                      : f.value === 'outstanding'
                        ? rosterStats.outstanding
                        : rosterStats.all;
                  return (
                    <button
                      key={f.value}
                      type="button"
                      onClick={() => setRosterFilter(f.value)}
                      className={`h-7 px-2 rounded-md text-[11px] font-semibold transition-colors flex items-center gap-1 ${
                        isActive
                          ? 'bg-background shadow text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {f.label}
                      <span
                        className={`text-[10px] tabular-nums rounded-full px-1.5 ${
                          isActive
                            ? 'bg-muted text-foreground'
                            : 'bg-background/60 text-muted-foreground'
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{
                  width: `${rosterStats.expected > 0 ? (rosterStats.arrived / rosterStats.expected) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Attendee list */}
      {attendees.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground p-8">
          <p className="text-sm">No registered attendees yet.</p>
        </div>
      ) : isCheckInMode ? (
        visibleCount === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground p-8">
            <p className="text-sm">No attendees match this view.</p>
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-5">
              {showOutstanding && (
                <RosterSection
                  title="Outstanding"
                  count={groups.outstandingList.length}
                  accent="text-amber-400"
                  icon={<Clock className="w-3.5 h-3.5" />}
                  attendees={groups.outstandingList}
                  isCamp={isCamp}
                  checkInDate={checkInDate}
                  onCheckIn={onCheckIn}
                  onCheckOut={onCheckOut}
                  onReprint={onReprint}
                />
              )}
              {showIn && (
                <RosterSection
                  title="Checked in"
                  count={groups.inList.length}
                  accent="text-emerald-400"
                  icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                  attendees={groups.inList}
                  isCamp={isCamp}
                  checkInDate={checkInDate}
                  onCheckIn={onCheckIn}
                  onCheckOut={onCheckOut}
                  onReprint={onReprint}
                />
              )}
              {showOut && (
                <RosterSection
                  title="Checked out"
                  count={groups.outList.length}
                  accent="text-muted-foreground"
                  icon={<LogOut className="w-3.5 h-3.5" />}
                  attendees={groups.outList}
                  isCamp={isCamp}
                  checkInDate={checkInDate}
                  onCheckIn={onCheckIn}
                  onCheckOut={onCheckOut}
                  onReprint={onReprint}
                />
              )}
              {showNotToday && (
                <RosterSection
                  title="Not in today's session"
                  count={groups.notTodayList.length}
                  accent="text-muted-foreground"
                  icon={<CalendarDays className="w-3.5 h-3.5" />}
                  attendees={groups.notTodayList}
                  isCamp={isCamp}
                  checkInDate={checkInDate}
                  onCheckIn={onCheckIn}
                  onCheckOut={onCheckOut}
                  onReprint={onReprint}
                />
              )}
            </div>
          </ScrollArea>
        )
      ) : filteredAttendees.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground p-8">
          <p className="text-sm">No attendees match the search.</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
            {filteredAttendees.map((att, i) => (
              <div key={att.id} className="flex gap-2">
                <div className="w-6 shrink-0 flex items-start justify-center pt-3">
                  <span className="text-xs font-bold text-muted-foreground">{i + 1}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <AttendeeRow attendee={att} isCamp={isCamp} />
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      {/* Back button */}
      <div className="shrink-0 border-t p-4">
        <Button variant="outline" className="w-full h-11 gap-2" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
          Back to events
        </Button>
      </div>
    </div>
  );
}
