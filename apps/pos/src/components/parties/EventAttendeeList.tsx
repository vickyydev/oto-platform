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
  type RosterGroups,
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
  Tent,
  Sparkles,
  Search,
  LogIn,
  LogOut,
  CheckCircle2,
  UserPlus,
  StickyNote,
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
const RSVP_STYLE: Record<string, string> = {
  attending: 'bg-emerald-500/15 text-emerald-400',
  maybe: 'bg-amber-500/15 text-amber-400',
  declined: 'bg-muted text-muted-foreground line-through',
};
const RSVP_LABEL: Record<string, string> = {
  attending: 'Attending',
  maybe: 'Maybe',
  declined: 'Declined',
};

const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

const fmtShortDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

interface EventAttendeeListProps {
  event: OtoEvent;
  onBack: () => void;
  // When provided, enables check-in mode for this date (today for events/parties;
  // today's date for multi-day camps to scope per-session check-in).
  checkInDate?: string;
  onCheckIn?: (attendeeId: string) => void;
  onCheckOut?: (attendeeId: string) => void;
  // When provided, exposes a "Reprint band" action on already-checked-in rows.
  onReprint?: (attendeeId: string) => void;
  // When provided (check-in mode), shows an "Add attendee" action for walk-ups.
  onAddAttendee?: () => void;
  // Increment to force list re-render after an in-place mutation.
  refreshKey?: number;
}

function AttendeeCheckinBadge({ record }: { record: EventAttendeeCheckin }) {
  if (record.checkedOutAt) {
    return (
      <span className="flex flex-col gap-0.5 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground font-semibold">
          <LogOut className="w-3.5 h-3.5" />
          Out · {fmtTime(record.checkedOutAt)}
        </span>
        <span className="text-[11px] text-muted-foreground/80">
          In · {fmtTime(record.checkedInAt)} · by {record.operatorName}
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold flex-wrap">
      <CheckCircle2 className="w-3.5 h-3.5" />
      In · {fmtTime(record.checkedInAt)} · Band {record.wristbandCode}
      {record.parentWristbandCode && ` · Parent ${record.parentWristbandCode}`}
      <span className="text-muted-foreground font-medium">· by {record.operatorName}</span>
    </span>
  );
}

function AttendeeCard({
  attendee,
  isCamp,
  checkInDate,
  onCheckIn,
  onCheckOut,
  onReprint,
}: {
  attendee: EventAttendee;
  isCamp: boolean;
  isParty: boolean;
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

  return (
    <Card className={`p-4 bg-card/50 ${isDeclined ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-base">{attendee.name}</span>
            {attendee.rsvpStatus && (
              <span
                className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${RSVP_STYLE[attendee.rsvpStatus] ?? 'bg-muted text-muted-foreground'}`}
              >
                {RSVP_LABEL[attendee.rsvpStatus] ?? attendee.rsvpStatus}
              </span>
            )}
            {attendee.parentAttending && (
              <span className="text-[10px] font-bold rounded-full px-2 py-0.5 bg-violet-500/15 text-violet-400">
                Parent attending
              </span>
            )}
          </div>
          <div className="text-sm text-muted-foreground flex items-center gap-3 mt-0.5 flex-wrap">
            {attendee.age != null && <span>{attendee.age} yrs</span>}
            {attendee.language && (
              <span className="flex items-center gap-1">
                <Globe className="w-3 h-3" />
                {attendee.language}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {attendee.allergyFlag && (
            <span className="flex items-center gap-1 text-xs font-bold rounded-full px-2.5 py-1 bg-red-500/15 text-red-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              Allergy / Medical
            </span>
          )}
          {attendee.dietaryFlag && (
            <span className="flex items-center gap-1 text-xs font-bold rounded-full px-2.5 py-1 bg-amber-500/15 text-amber-400">
              <Salad className="w-3.5 h-3.5" />
              Dietary
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {attendee.allergyFlag && attendee.allergyDetail && (
          <div className="md:col-span-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-red-300 text-xs">
            <span className="font-semibold">Medical/allergy: </span>
            {attendee.allergyDetail}
          </div>
        )}

        {attendee.dietaryFlag && attendee.dietaryDetail && (
          <div className="md:col-span-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-amber-300 text-xs">
            <span className="font-semibold">Dietary: </span>
            {attendee.dietaryDetail}
          </div>
        )}

        {isCamp && attendee.attendanceDays && attendee.attendanceDays.length > 0 && (
          <div className="md:col-span-2">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <CalendarDays className="w-3.5 h-3.5" />
              Attendance days ({attendee.attendanceDays.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {attendee.attendanceDays.map((d) => (
                <span
                  key={d}
                  className={`text-[11px] font-medium px-2 py-0.5 rounded-md ${
                    checkInDate === d
                      ? 'bg-primary/20 text-primary font-bold'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {fmtShortDate(d)}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
            <Contact className="w-3.5 h-3.5" />
            Parent / guardian
          </div>
          <div className="font-medium">{attendee.parentName}</div>
          {attendee.parentPhone && (
            <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Phone className="w-3 h-3" />
              {attendee.parentPhone}
            </div>
          )}
        </div>

        {attendee.emergencyContact && (
          <div>
            <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              Emergency contact
            </div>
            <div className="font-medium text-xs">{attendee.emergencyContact}</div>
          </div>
        )}

        {attendee.notes && (
          <div className="md:col-span-2">
            <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
              <StickyNote className="w-3.5 h-3.5" />
              Notes
            </div>
            <div className="text-xs">{attendee.notes}</div>
          </div>
        )}
      </div>

      {/* Check-in state or actions */}
      {showCheckInActions && (
        <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            {checkinRecord ? (
              <AttendeeCheckinBadge record={checkinRecord} />
            ) : (
              <span className="text-xs text-muted-foreground">
                {isCamp && checkInDate && !attendee.attendanceDays?.includes(checkInDate)
                  ? 'Not registered for today'
                  : 'Not yet checked in'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!checkinRecord && !isDeclined && (
              <Button
                size="sm"
                className="h-9 gap-1.5"
                onClick={onCheckIn}
                disabled={
                  isCamp &&
                  checkInDate != null &&
                  !(attendee.attendanceDays?.includes(checkInDate) ?? true)
                }
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
              <span className="text-xs font-semibold text-muted-foreground">Checked out</span>
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
  isParty,
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
  isParty: boolean;
  checkInDate?: string;
  onCheckIn?: (attendeeId: string) => void;
  onCheckOut?: (attendeeId: string) => void;
  onReprint?: (attendeeId: string) => void;
}) {
  if (attendees.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className={`flex items-center gap-1.5 text-sm font-bold ${accent}`}>
          {icon}
          {title}
        </span>
        <span className="text-xs font-bold tabular-nums rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="space-y-3">
        {attendees.map((att, i) => (
          <div key={att.id} className="flex gap-3">
            <div className="w-8 shrink-0 flex items-start justify-center pt-4">
              <span className="text-sm font-bold text-muted-foreground">{i + 1}</span>
            </div>
            <div className="flex-1 min-w-0">
              <AttendeeCard
                attendee={att}
                isCamp={isCamp}
                isParty={isParty}
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

function RosterSections({
  groups,
  rosterFilter,
  isCamp,
  isParty,
  checkInDate,
  onCheckIn,
  onCheckOut,
  onReprint,
  hasAttendees,
}: {
  groups: RosterGroups;
  rosterFilter: RosterFilter;
  isCamp: boolean;
  isParty: boolean;
  checkInDate?: string;
  onCheckIn?: (attendeeId: string) => void;
  onCheckOut?: (attendeeId: string) => void;
  onReprint?: (attendeeId: string) => void;
  hasAttendees: boolean;
}) {
  const { inList, outList, outstandingList, notTodayList } = groups;
  const showIn = rosterFilter === 'all' || rosterFilter === 'in';
  const showOutstanding = rosterFilter === 'all' || rosterFilter === 'outstanding';
  const showOut = rosterFilter === 'all';
  const showNotToday = rosterFilter === 'all';

  const visibleCount =
    (showIn ? inList.length : 0) +
    (showOutstanding ? outstandingList.length : 0) +
    (showOut ? outList.length : 0) +
    (showNotToday ? notTodayList.length : 0);

  if (visibleCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm">
        {!hasAttendees ? 'No registered attendees yet.' : 'No attendees match this view.'}
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-2">
      {showOutstanding && (
        <RosterSection
          title="Outstanding"
          count={outstandingList.length}
          accent="text-amber-400"
          icon={<Clock className="w-4 h-4" />}
          attendees={outstandingList}
          isCamp={isCamp}
          isParty={isParty}
          checkInDate={checkInDate}
          onCheckIn={onCheckIn}
          onCheckOut={onCheckOut}
          onReprint={onReprint}
        />
      )}
      {showIn && (
        <RosterSection
          title="Checked in"
          count={inList.length}
          accent="text-emerald-400"
          icon={<CheckCircle2 className="w-4 h-4" />}
          attendees={inList}
          isCamp={isCamp}
          isParty={isParty}
          checkInDate={checkInDate}
          onCheckIn={onCheckIn}
          onCheckOut={onCheckOut}
          onReprint={onReprint}
        />
      )}
      {showOut && (
        <RosterSection
          title="Checked out"
          count={outList.length}
          accent="text-muted-foreground"
          icon={<LogOut className="w-4 h-4" />}
          attendees={outList}
          isCamp={isCamp}
          isParty={isParty}
          checkInDate={checkInDate}
          onCheckIn={onCheckIn}
          onCheckOut={onCheckOut}
          onReprint={onReprint}
        />
      )}
      {showNotToday && (
        <RosterSection
          title="Not in today's session"
          count={notTodayList.length}
          accent="text-muted-foreground"
          icon={<CalendarDays className="w-4 h-4" />}
          attendees={notTodayList}
          isCamp={isCamp}
          isParty={isParty}
          checkInDate={checkInDate}
          onCheckIn={onCheckIn}
          onCheckOut={onCheckOut}
          onReprint={onReprint}
        />
      )}
    </div>
  );
}

export function EventAttendeeList({
  event,
  onBack,
  checkInDate,
  onCheckIn,
  onCheckOut,
  onReprint,
  onAddAttendee,
  refreshKey: _refreshKey,
}: EventAttendeeListProps) {
  const [query, setQuery] = useState('');
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>('all');
  const attendees = useMemo(() => event.attendees ?? [], [event.attendees]);
  const isCamp = event.type === 'camp';
  const isParty = event.type === 'party';
  const TypeIcon = isCamp ? Tent : Sparkles;
  const isCheckInMode = !!checkInDate;

  // Overall progress over the FULL roster (independent of search/filter), so the
  // headline count stays stable while staff search. Camps reflect today's
  // session only — kids not registered for today are excluded from the total.
  const rosterStats = useMemo(
    () =>
      checkInDate
        ? computeRosterStats(attendees, checkInDate, isCamp)
        : { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- _refreshKey is the host's bump: a check-in is written onto the attendee in place, so the roster is recounted when it changes
    [attendees, checkInDate, isCamp, _refreshKey],
  );

  const filteredAttendees = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return attendees;
    return attendees.filter((a) =>
      `${a.name} ${a.parentName} ${a.parentPhone ?? ''}`.toLowerCase().includes(q),
    );
  }, [attendees, query]);

  // Search-scoped buckets used for rendering + per-section counts.
  const groups: RosterGroups = useMemo(
    () =>
      checkInDate
        ? groupAttendees(filteredAttendees, checkInDate, isCamp)
        : { inList: [], outList: [], outstandingList: [], notTodayList: [] },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- _refreshKey is the host's bump: a check-in is written onto the attendee in place, so the lists are regrouped when it changes
    [filteredAttendees, checkInDate, isCamp, _refreshKey],
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 mb-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          {isCheckInMode ? 'All events' : 'All events'}
        </button>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-2xl font-black tracking-tight">{event.title}</h2>
              <span
                className={`text-xs font-bold uppercase tracking-wide rounded-full px-2.5 py-1 ${TYPE_BADGE_STYLE[event.type]}`}
              >
                <span className="flex items-center gap-1">
                  <TypeIcon className="w-3.5 h-3.5" />
                  {TYPE_LABEL[event.type]}
                </span>
              </span>
              <span
                className={`text-xs font-bold uppercase tracking-wide rounded-full px-2.5 py-1 ${STATUS_STYLE[event.status]}`}
              >
                {PARTY_STATUS_LABELS[event.status]}
              </span>
            </div>

            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1.5">
                <CalendarDays className="w-4 h-4" />
                {isCamp && event.dateRange
                  ? `${fmtDate(event.dateRange.start)} – ${fmtDate(event.dateRange.end)}`
                  : fmtDate(event.date)}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="w-4 h-4" />
                {event.startTime} – {event.endTime}
              </span>
              <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4" />
                {event.location}
              </span>
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4" />
                {attendees.length} registered
                {isCheckInMode && (
                  <span className="text-emerald-400 font-semibold ml-1">
                    · {rosterStats.currentlyIn} in
                  </span>
                )}
                {event.expectedKids > 0 && !isCheckInMode && ` · ${event.expectedKids} expected kids`}
              </span>
            </div>
          </div>

          {isCheckInMode && onAddAttendee && (
            <Button className="gap-2 shrink-0" onClick={onAddAttendee}>
              <UserPlus className="w-4 h-4" />
              Add attendee
            </Button>
          )}
        </div>

        {/* Flags summary */}
        {attendees.length > 0 && (
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            {attendees.some((a) => a.allergyFlag) && (
              <span className="flex items-center gap-1.5 text-xs font-semibold text-red-400">
                <AlertTriangle className="w-4 h-4" />
                {attendees.filter((a) => a.allergyFlag).length} with allergy/medical note
              </span>
            )}
            {attendees.some((a) => a.dietaryFlag) && (
              <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                <Salad className="w-4 h-4" />
                {attendees.filter((a) => a.dietaryFlag).length} with dietary restriction
              </span>
            )}
          </div>
        )}

        {/* Search */}
        {attendees.length > 0 && (
          <div className="mt-3 relative">
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
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-sm font-semibold">
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
                      className={`h-8 px-3 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                        isActive
                          ? 'bg-background shadow text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {f.label}
                      <span
                        className={`text-[11px] tabular-nums rounded-full px-1.5 ${
                          isActive ? 'bg-muted text-foreground' : 'bg-background/60 text-muted-foreground'
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
      <ScrollArea className="flex-1 -mx-1 px-1">
        {isCheckInMode ? (
          <RosterSections
            groups={groups}
            rosterFilter={rosterFilter}
            isCamp={isCamp}
            isParty={isParty}
            checkInDate={checkInDate}
            onCheckIn={onCheckIn}
            onCheckOut={onCheckOut}
            onReprint={onReprint}
            hasAttendees={attendees.length > 0}
          />
        ) : filteredAttendees.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm">
            {attendees.length === 0 ? 'No registered attendees yet.' : 'No attendees match the search.'}
          </div>
        ) : (
          <div className="space-y-3 pb-2">
            {filteredAttendees.map((att, i) => (
              <div key={att.id} className="flex gap-3">
                <div className="w-8 shrink-0 flex items-start justify-center pt-4">
                  <span className="text-sm font-bold text-muted-foreground">{i + 1}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <AttendeeCard
                    attendee={att}
                    isCamp={isCamp}
                    isParty={isParty}
                    checkInDate={checkInDate}
                    onCheckIn={onCheckIn ? () => onCheckIn(att.id) : undefined}
                    onCheckOut={onCheckOut ? () => onCheckOut(att.id) : undefined}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Footer */}
      <div className="shrink-0 pt-3 border-t mt-2">
        <Button variant="outline" className="gap-2" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
          Back to events
        </Button>
      </div>
    </div>
  );
}
