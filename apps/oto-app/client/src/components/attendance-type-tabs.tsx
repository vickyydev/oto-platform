export const ATTENDANCE_TYPES = [
  { key: "late", label: "Late" },
  { key: "early-leave", label: "Early leave" },
  { key: "missed-punch", label: "Missed punch" },
  { key: "no-show", label: "No-show" },
  { key: "overtime", label: "Overtime" },
  { key: "unscheduled-shifts", label: "Unscheduled shifts" },
  { key: "clock-time-requests", label: "Clock-time requests" },
  { key: "leave-conflicts", label: "Leave conflicts" },
] as const;

export type AttendanceTypeKey = typeof ATTENDANCE_TYPES[number]["key"];
export type AttendanceTabKey = AttendanceTypeKey | "all";
export type AttendanceTypeCounts = Partial<Record<AttendanceTypeKey, number>>;

export function AttendanceTypeTabs({
  counts,
  value,
  onChange,
  label = "Attendance item types",
}: {
  counts: AttendanceTypeCounts;
  value: AttendanceTabKey;
  onChange: (value: AttendanceTabKey) => void;
  label?: string;
}) {
  const total = ATTENDANCE_TYPES.reduce((sum, type) => sum + (counts[type.key] ?? 0), 0);
  const tabs: { key: AttendanceTabKey; label: string; count: number }[] = [
    { key: "all", label: "All", count: total },
    ...ATTENDANCE_TYPES.map((type) => ({ ...type, count: counts[type.key] ?? 0 })),
  ];

  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const active = tab.key === value;
        const empty = tab.count === 0 && tab.key !== "all";
        return (
          <button
            key={tab.key}
            type="button"
            disabled={empty}
            aria-pressed={active}
            onClick={() => onChange(tab.key)}
            data-testid={`attendance-type-${tab.key}`}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              active ? "border-foreground bg-foreground text-background" :
              empty ? "cursor-not-allowed border-border bg-muted/50 text-muted-foreground opacity-55" :
              "border-border bg-card text-foreground hover:bg-accent"
            }`}
          >
            {tab.label}
            <span className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${
              active ? "bg-background/20 text-current" : "bg-muted text-muted-foreground"
            }`}>{tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}