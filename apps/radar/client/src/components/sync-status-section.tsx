import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  RefreshCw,
  Database,
  FileSpreadsheet,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SyncSource {
  id: string;
  name: string;
  connected: boolean;
  lastSyncedAt: string | null;
  earliestDate: string | null;
  latestDate: string | null;
  syncType: string;
  cachedDays?: number;
  totalOrders?: number;
  lastSyncStatus?: string;
  subSources?: { name: string; connected: boolean }[];
}

interface CalendarCoverage {
  year: number;
  month: number;
  coverage: Record<string, string[]>;
}

const SOURCE_DISPLAY: Record<string, { label: string; color: string; icon: typeof Database }> = {
  funtopia: { label: "Floresta", color: "bg-blue-500", icon: Activity },
  papaya: { label: "Chalong", color: "bg-emerald-500", icon: Database },
  xero: { label: "Xero", color: "bg-violet-500", icon: FileSpreadsheet },
};

function SyncTypeBadge({ type }: { type: string }) {
  const variant =
    type === "Full"
      ? "default"
      : type === "Cached"
        ? "secondary"
        : type === "Partial"
          ? "outline"
          : "destructive";
  return (
    <Badge variant={variant} data-testid={`badge-sync-type-${type.toLowerCase()}`}>
      {type}
    </Badge>
  );
}

function SourceCard({ source }: { source: SyncSource }) {
  const display = SOURCE_DISPLAY[source.id];
  const Icon = display?.icon || Cloud;
  const colorClass = display?.color || "bg-gray-500";
  const label = display?.label || source.name;

  return (
    <div
      className="flex items-start gap-3 rounded-lg border p-3 bg-card"
      data-testid={`card-sync-source-${source.id}`}
    >
      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white", colorClass)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium truncate">{label}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {source.connected ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className={cn("text-xs", source.connected ? "text-green-600 dark:text-green-400" : "text-muted-foreground")}>
              {source.connected ? "Connected" : "Not configured"}
            </span>
          </div>
        </div>

        {source.connected && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <SyncTypeBadge type={source.syncType} />
              {source.lastSyncedAt && (
                <span className="text-xs text-muted-foreground">
                  Last synced: {new Date(source.lastSyncedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
            {source.earliestDate && source.latestDate && (
              <p className="text-xs text-muted-foreground">
                Coverage: {source.earliestDate} &ndash; {source.latestDate}
              </p>
            )}
            {source.subSources && (
              <div className="flex gap-2 mt-0.5">
                {source.subSources.map((sub) => (
                  <span key={sub.name} className="text-xs text-muted-foreground flex items-center gap-1">
                    {sub.connected ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : (
                      <XCircle className="h-3 w-3 text-muted-foreground" />
                    )}
                    {sub.name}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

function getMonthOffset(year: number, month: number, offset: number): { year: number; month: number } {
  let m = month + offset;
  let y = year;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return { year: y, month: m };
}

function formatSyncTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function MonthGrid({
  year,
  month,
  sourceFilter,
  today,
  syncTimes,
}: {
  year: number;
  month: number;
  sourceFilter: string | null;
  today: Date;
  syncTimes: Record<string, string | null>;
}) {
  const { data: calendarData, isLoading } = useQuery<CalendarCoverage>({
    queryKey: ["/api/sync-status/calendar", year, month],
    queryFn: async () => {
      const res = await fetch(`/api/sync-status/calendar?year=${year}&month=${month}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch calendar data");
      return res.json();
    },
    staleTime: 60_000,
  });

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDayOfWeek = new Date(year, month - 1, 1).getDay();
  const adjustedFirstDay = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;

  const cells: (number | null)[] = [];
  for (let i = 0; i < adjustedFirstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const getDaySources = (day: number): string[] => {
    if (!calendarData?.coverage) return [];
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return calendarData.coverage[dateStr] || [];
  };

  const isToday = (day: number) =>
    year === today.getFullYear() && month === today.getMonth() + 1 && day === today.getDate();

  const isFuture = (day: number) => {
    const d = new Date(year, month - 1, day);
    return d > today;
  };

  return (
    <div className="space-y-1">
      <div className="text-center text-[10px] font-medium text-muted-foreground pb-0.5">
        {MONTH_NAMES[month - 1]} {year}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {DAY_LABELS.map((label, idx) => (
          <div key={idx} className="text-center text-[8px] font-medium text-muted-foreground/60 leading-none pb-0.5">
            {label}
          </div>
        ))}
        {isLoading
          ? cells.map((_, i) => <Skeleton key={i} className="h-[18px] w-full rounded-[2px]" />)
          : cells.map((day, i) => {
              if (day === null) return <div key={i} className="h-[18px]" />;
              const sources = getDaySources(day);
              const filtered = sourceFilter
                ? sources.filter((s) => s === sourceFilter)
                : sources;
              const hasData = filtered.length > 0;
              const future = isFuture(day);

              const hasFuntopia = filtered.includes("funtopia");
              const hasPapaya = filtered.includes("papaya");
              const hasXero = filtered.includes("xero");

              return (
                <div
                  key={i}
                  className={cn(
                    "h-[22px] rounded-[2px] flex flex-col items-center justify-center text-[9px] leading-none transition-colors relative",
                    future
                      ? "text-muted-foreground/30"
                      : hasData
                        ? "text-foreground font-medium"
                        : "bg-muted/40 text-muted-foreground/60",
                    isToday(day) && "ring-1 ring-primary ring-offset-1 ring-offset-background"
                  )}
                  data-testid={`calendar-day-${year}-${month}-${day}`}
                  title={
                    hasData
                      ? `${day} ${MONTH_NAMES[month - 1]}\n${filtered.map(s => {
                          const label = SOURCE_DISPLAY[s]?.label || s;
                          const synced = syncTimes[s];
                          return synced ? `${label} (synced ${formatSyncTime(synced)})` : label;
                        }).join("\n")}`
                      : future
                        ? `${day} ${MONTH_NAMES[month - 1]}: Future`
                        : `${day} ${MONTH_NAMES[month - 1]}: No data`
                  }
                >
                  <span>{day}</span>
                  {hasData && !future && (
                    <div className="flex gap-[2px] mt-[1px]">
                      {hasFuntopia && <div className="h-[3px] w-[3px] rounded-full bg-blue-500" />}
                      {hasPapaya && <div className="h-[3px] w-[3px] rounded-full bg-emerald-500" />}
                      {hasXero && <div className="h-[3px] w-[3px] rounded-full bg-violet-500" />}
                    </div>
                  )}
                </div>
              );
            })}
      </div>
    </div>
  );
}

function CalendarHeatmap({ sourceFilter, syncTimes }: { sourceFilter: string | null; syncTimes: Record<string, string | null> }) {
  const queryClient = useQueryClient();
  const today = new Date();
  const [baseYear, setBaseYear] = useState(today.getFullYear());
  const [baseMonth, setBaseMonth] = useState(today.getMonth() + 1);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    queryClient.invalidateQueries({ queryKey: ["/api/sync-status/calendar"] });
    queryClient.invalidateQueries({ queryKey: ["/api/sync-status/overview"] });
    setTimeout(() => setRefreshing(false), 1000);
  };

  const goToPrev = () => {
    const prev = getMonthOffset(baseYear, baseMonth, -1);
    setBaseYear(prev.year);
    setBaseMonth(prev.month);
  };

  const goToNext = () => {
    const next = getMonthOffset(baseYear, baseMonth, 1);
    setBaseYear(next.year);
    setBaseMonth(next.month);
  };

  const m0 = getMonthOffset(baseYear, baseMonth, -2);
  const m1 = getMonthOffset(baseYear, baseMonth, -1);
  const m2 = { year: baseYear, month: baseMonth };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between max-w-[680px]">
        <button onClick={goToPrev} className="p-0.5 rounded hover:bg-muted" data-testid="button-calendar-prev">
          <ChevronLeft className="h-3 w-3 text-muted-foreground" />
        </button>
        <div className="flex items-center gap-1">
          <button onClick={handleRefresh} className="p-0.5 rounded hover:bg-muted" data-testid="button-calendar-refresh" title="Refresh coverage data">
            <RefreshCw className={cn("h-3 w-3 text-muted-foreground", refreshing && "animate-spin")} />
          </button>
          <button onClick={goToNext} className="p-0.5 rounded hover:bg-muted" data-testid="button-calendar-next">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          </button>
        </div>
      </div>

      <div className="hidden md:grid md:grid-cols-3 gap-4 max-w-[680px]">
        <MonthGrid year={m0.year} month={m0.month} sourceFilter={sourceFilter} today={today} syncTimes={syncTimes} />
        <MonthGrid year={m1.year} month={m1.month} sourceFilter={sourceFilter} today={today} syncTimes={syncTimes} />
        <MonthGrid year={m2.year} month={m2.month} sourceFilter={sourceFilter} today={today} syncTimes={syncTimes} />
      </div>

      <div className="md:hidden max-w-[220px]">
        <MonthGrid year={m2.year} month={m2.month} sourceFilter={sourceFilter} today={today} syncTimes={syncTimes} />
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(SOURCE_DISPLAY).map(([id, { label, color }]) => (
          <div key={id} className="flex items-center gap-1">
            <div className={cn("h-1.5 w-1.5 rounded-full", color)} />
            <span className="text-[8px] text-muted-foreground">
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SyncStatusSection() {
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ sources: SyncSource[] }>({
    queryKey: ["/api/sync-status/overview"],
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  const sources = (data?.sources || []).filter((s) => s.id !== "google_drive");

  return (
    <Card data-testid="card-sync-status">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Sync Status
        </CardTitle>
        <CardDescription>
          Overview of all data sync sources and their coverage
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
        </div>

        <div className="border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-medium text-muted-foreground" data-testid="text-heatmap-title">Coverage</h4>
            <div className="flex gap-0.5">
              <button
                className={cn("px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors", sourceFilter === null ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
                onClick={() => setSourceFilter(null)}
                data-testid="button-filter-all"
              >
                All
              </button>
              {sources
                .filter((s) => s.connected)
                .map((s) => (
                  <button
                    key={s.id}
                    className={cn("px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors", sourceFilter === s.id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
                    onClick={() => setSourceFilter(sourceFilter === s.id ? null : s.id)}
                    data-testid={`button-filter-${s.id}`}
                  >
                    {SOURCE_DISPLAY[s.id]?.label || s.name.split(" ")[0]}
                  </button>
                ))}
            </div>
          </div>
          <CalendarHeatmap sourceFilter={sourceFilter} syncTimes={Object.fromEntries(sources.map(s => [s.id, s.lastSyncedAt]))} />
        </div>
      </CardContent>
    </Card>
  );
}
