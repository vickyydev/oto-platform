import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { 
  Calendar, 
  List, 
  Search, 
  Clock, 
  Users, 
  Cake, 
  PartyPopper, 
  GraduationCap, 
  CalendarDays,
  ChevronRight 
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { Link } from "wouter";
import { format, isToday, parseISO } from "date-fns";
import type { Event } from "@shared/schema";

type ViewMode = "list" | "calendar";
type TabType = "today" | "upcoming" | "completed";

const eventTypeIcons: Record<string, typeof Cake> = {
  birthday: Cake,
  private_event: PartyPopper,
  school_group: GraduationCap,
  other: CalendarDays,
};

const eventTypeColors: Record<string, string> = {
  birthday: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  private_event: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  school_group: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  other: "bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-300",
};

function EventCard({ event, compact = false }: { event: Event; compact?: boolean }) {
  const { t } = useI18n();
  const Icon = eventTypeIcons[event.eventType] || CalendarDays;
  const colorClass = eventTypeColors[event.eventType] || eventTypeColors.other;
  
  const eventTypeLabels: Record<string, string> = {
    birthday: t.events.birthday,
    private_event: t.events.privateEvent,
    school_group: t.events.schoolGroup,
    other: t.events.other,
  };

  const eventDate = parseISO(event.eventDate);
  const eventIsToday = isToday(eventDate);
  
  const statusLabels: Record<string, string> = {
    upcoming: t.events.status.upcoming,
    in_progress: t.events.status.inProgress,
    completed: t.events.status.completed,
    cancelled: t.events.status.cancelled,
  };

  const statusColors: Record<string, string> = {
    upcoming: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    today: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    in_progress: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    completed: "bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-300",
    cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  };

  const displayStatus = eventIsToday && event.status === "upcoming" ? "today" : event.status;
  const displayLabel = eventIsToday && event.status === "upcoming" ? t.common.today : statusLabels[event.status];

  return (
    <Link href={`/events/${event.id}`}>
      <Card 
        className={`hover-elevate active-elevate-2 cursor-pointer overflow-visible ${event.status === "completed" ? "opacity-60" : ""}`} 
        data-testid={`card-event-${event.id}`}
      >
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-md ${colorClass} shrink-0`}>
              <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <h3 className={`font-semibold truncate ${compact ? "text-sm" : ""}`}>{event.title}</h3>
                {!compact && (
                  <Badge variant="secondary" className={`text-xs ${statusColors[displayStatus]}`}>
                    {displayLabel}
                  </Badge>
                )}
              </div>
              <div className={`flex items-center gap-3 text-muted-foreground flex-wrap ${compact ? "text-xs" : "text-sm"}`}>
                {!eventIsToday && (
                  <span className="flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {format(parseISO(event.eventDate), "MMM d")}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  {event.startTime}
                  {event.endTime && !compact && ` - ${event.endTime}`}
                </span>
                {!compact && (event.numChildren || event.numAdults) && (
                  <span className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    {event.numChildren && `${event.numChildren} ${t.events.children.toLowerCase()}`}
                    {event.numChildren && event.numAdults && ", "}
                    {event.numAdults && `${event.numAdults} ${t.events.adults.toLowerCase()}`}
                  </span>
                )}
              </div>
              {!compact && event.programName && (
                <p className="text-xs text-muted-foreground mt-1">{event.programName}</p>
              )}
            </div>
            {compact && <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function CalendarView({ events }: { events: Event[] }) {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const { t } = useI18n();
  
  const selectedDateStr = format(selectedDate, "yyyy-MM-dd");
  const eventsOnDate = events.filter(e => e.eventDate === selectedDateStr);

  const daysInMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0).getDate();
  const firstDayOfMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1).getDay();
  
  const eventDates = new Set(events.map(e => e.eventDate));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1, 1))}
          data-testid="button-prev-month"
        >
          Previous
        </Button>
        <span className="font-semibold">
          {format(selectedDate, "MMMM yyyy")}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1))}
          data-testid="button-next-month"
        >
          Next
        </Button>
      </div>
      
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => (
          <div key={day} className="p-2">{day}</div>
        ))}
      </div>
      
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstDayOfMonth }).map((_, i) => (
          <div key={`empty-${i}`} className="p-2" />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const dateStr = format(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day), "yyyy-MM-dd");
          const hasEvents = eventDates.has(dateStr);
          const isSelected = dateStr === selectedDateStr;
          const isTodayDate = dateStr === format(new Date(), "yyyy-MM-dd");
          
          return (
            <button
              key={day}
              onClick={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day))}
              className={`p-2 text-sm rounded-md relative transition-colors ${
                isSelected ? "bg-primary text-primary-foreground" : 
                isTodayDate ? "bg-accent" : "hover:bg-muted"
              }`}
              data-testid={`calendar-day-${day}`}
            >
              {day}
              {hasEvents && (
                <span className={`absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${
                  isSelected ? "bg-primary-foreground" : "bg-primary"
                }`} />
              )}
            </button>
          );
        })}
      </div>
      
      <div className="space-y-2 mt-4">
        <h3 className="font-semibold text-sm">
          {format(selectedDate, "EEEE, MMMM d")}
        </h3>
        {eventsOnDate.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.events.noEvents}</p>
        ) : (
          <div className="space-y-2">
            {eventsOnDate.map(event => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function EventsPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [activeTab, setActiveTab] = useState<TabType>("today");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: todayEvents, isLoading: loadingToday } = useQuery<Event[]>({
    queryKey: ["/api/events?range=today"],
    enabled: !!user,
  });

  const { data: upcomingEvents, isLoading: loadingUpcoming } = useQuery<Event[]>({
    queryKey: ["/api/events?range=upcoming"],
    enabled: !!user,
  });

  const { data: completedEvents, isLoading: loadingCompleted } = useQuery<Event[]>({
    queryKey: ["/api/events?range=past"],
    enabled: !!user,
  });

  const isLoading = loadingToday || loadingUpcoming || loadingCompleted;

  const filterEvents = (events: Event[] | undefined) => {
    if (!events) return [];
    if (!searchQuery) return events;
    const query = searchQuery.toLowerCase();
    return events.filter(event =>
      event.title.toLowerCase().includes(query) ||
      event.childName?.toLowerCase().includes(query) ||
      event.parentName?.toLowerCase().includes(query) ||
      event.bookingName?.toLowerCase().includes(query) ||
      event.whatsappPhoneRaw?.includes(query)
    );
  };

  const filteredToday = filterEvents(todayEvents);
  const filteredUpcoming = filterEvents(upcomingEvents);
  const filteredCompleted = filterEvents(completedEvents)?.slice(0, 20) || [];
  const allFilteredEvents = [...filteredToday, ...filteredUpcoming, ...filteredCompleted];

  const tabCounts = {
    today: filteredToday.length,
    upcoming: filteredUpcoming.length,
    completed: filteredCompleted.length,
  };

  const currentEvents = activeTab === "today" 
    ? filteredToday 
    : activeTab === "upcoming" 
    ? filteredUpcoming 
    : filteredCompleted;

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold">{t.events.title}</h1>
            <p className="text-sm text-muted-foreground">Manage upcoming events</p>
          </div>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant={viewMode === "list" ? "default" : "ghost"}
              onClick={() => setViewMode("list")}
              data-testid="button-view-list"
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant={viewMode === "calendar" ? "default" : "ghost"}
              onClick={() => setViewMode("calendar")}
              data-testid="button-view-calendar"
            >
              <Calendar className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t.common.search + "..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-events"
          />
        </div>

        {viewMode === "list" ? (
          <>
            <div className="flex gap-2 mb-4">
              <Button
                variant={activeTab === "today" ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveTab("today")}
                className="flex-1"
                data-testid="button-tab-today"
              >
                Today
                {tabCounts.today > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-xs">{tabCounts.today}</Badge>
                )}
              </Button>
              <Button
                variant={activeTab === "upcoming" ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveTab("upcoming")}
                className="flex-1"
                data-testid="button-tab-upcoming"
              >
                Upcoming
                {tabCounts.upcoming > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-xs">{tabCounts.upcoming}</Badge>
                )}
              </Button>
              <Button
                variant={activeTab === "completed" ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveTab("completed")}
                className="flex-1"
                data-testid="button-tab-completed"
              >
                Completed
                {tabCounts.completed > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-xs">{tabCounts.completed}</Badge>
                )}
              </Button>
            </div>

            {currentEvents.length === 0 ? (
              <Card className="p-6">
                <p className="text-sm text-muted-foreground text-center">
                  {activeTab === "today" && t.events.noEvents}
                  {activeTab === "upcoming" && "No upcoming events"}
                  {activeTab === "completed" && "No completed events"}
                </p>
              </Card>
            ) : (
              <div className="space-y-2">
                {currentEvents.map((event) => (
                  <EventCard key={event.id} event={event} compact />
                ))}
              </div>
            )}
          </>
        ) : (
          <CalendarView events={allFilteredEvents} />
        )}
      </div>
    </AppLayout>
  );
}
