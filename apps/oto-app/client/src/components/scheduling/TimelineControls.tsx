import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type TimelineMode = "day" | "3day" | "week" | "month";

interface TimelineControlsProps {
  mode: TimelineMode;
  onModeChange: (mode: TimelineMode) => void;
  dateRangeLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}

export function TimelineControls({
  mode,
  onModeChange,
  dateRangeLabel,
  onPrev,
  onNext,
  onToday,
}: TimelineControlsProps) {
  const modes: { key: TimelineMode; label: string; shortLabel: string }[] = [
    { key: "day", label: "Day", shortLabel: "1D" },
    { key: "3day", label: "3 Days", shortLabel: "3D" },
    { key: "week", label: "Week", shortLabel: "W" },
    { key: "month", label: "Month", shortLabel: "M" },
  ];

  return (
    <div className="flex items-center gap-1.5">
      <div className="inline-flex rounded-md border bg-muted/30 p-0.5" data-testid="timeline-mode-toggle">
        {modes.map((m) => (
          <button
            key={m.key}
            onClick={() => onModeChange(m.key)}
            className={cn(
              "px-2.5 py-1.5 text-sm font-medium rounded-sm transition-colors",
              mode === m.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            data-testid={`button-mode-${m.key}`}
          >
            <span className="hidden sm:inline">{m.label}</span>
            <span className="sm:hidden">{m.shortLabel}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onPrev}
          data-testid="button-nav-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <button
          onClick={onToday}
          className="text-sm font-medium text-primary hover:underline px-1.5"
          data-testid="button-nav-today"
        >
          Today
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onNext}
          data-testid="button-nav-next"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <span className="text-sm font-medium text-muted-foreground hidden sm:inline" data-testid="text-date-range">
        {dateRangeLabel}
      </span>
    </div>
  );
}
