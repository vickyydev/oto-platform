import { useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { beoClockOf } from "@shared/beoClock";
import {
  SERVING_GROUP_MAX,
  lineServingOf,
  sameServingGroup,
  servingGroupsOf,
  withLineServing,
  type ServingLine,
} from "@shared/beoServingTimes";

/** A line's own serving in the editor's words: "13:00", or its group and time "Dessert · 13:00"; none: null. */
function servingWordsOf(line: ServingLine | undefined): string | null {
  const own = lineServingOf(line);
  // As stored: the editor shows a dish's own time even when it is the menu's (the print leaves that out).
  return own ? (own.group ? `${own.group} · ${own.time}` : own.time) : null;
}

/**
 * SCRUM-1033: under a dish's or a drink's row, the time it is served at when it has one of its own
 * ("Served at 13:00 · Dessert"); nothing for a dish served with its menu. The row keeps its width:
 * the time is read here, the clock on the row (ServingTimeButton) sets it.
 */
export function ServingTimeLine({ line, className = "", testId }: { line: ServingLine | undefined; className?: string; testId: string }) {
  const own = lineServingOf(line);
  if (!own) return null;
  return (
    <p className={`flex items-center gap-1 text-[11px] text-sky-700 dark:text-sky-300 ${className}`} data-testid={testId}>
      <Clock className="h-3 w-3 shrink-0" />
      <span>Served at <span className="font-mono font-medium">{own.time}</span>{own.group ? <> · {own.group}</> : null}</span>
    </p>
  );
}

/**
 * SCRUM-1033: a dish's or a drink's own serving time, and the group it is served under, set from its
 * row in Food & Drinks (shared/beoServingTimes.ts). On the row a clock, the size of the row's other
 * buttons, tinted when the dish has a time of its own (read under the row: ServingTimeLine). Open:
 * the time, an optional group name with the list's groups to pick from (a group's dishes share one
 * time), and Clear, which serves the dish with its menu again. Written into the form's list; the
 * BEO's Save stores it.
 */
export function ServingTimeButton<T extends ServingLine>({
  lines,
  index,
  menuTime,
  onLines,
  disabled = false,
  testId,
}: {
  lines: readonly T[];
  index: number;
  /** The menu's own service time, for the words: a dish with none of its own is served then. */
  menuTime?: string;
  onLines: (next: T[]) => void;
  disabled?: boolean;
  testId: string;
}) {
  const line = lines[index];
  const own = lineServingOf(line);
  const tag = servingWordsOf(line);
  const menu = beoClockOf(menuTime)?.time ?? null;
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState("");
  const [group, setGroup] = useState("");
  const groups = servingGroupsOf(lines).filter((g) => !(own?.group && sameServingGroup(g.name, own.group)));

  const start = (next: boolean) => {
    if (next) {
      setTime(own?.time ?? "");
      setGroup(own?.group ?? "");
    }
    setOpen(next);
  };
  const apply = (next: { time: string; group: string }) => {
    onLines(withLineServing(lines, index, next));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && start(next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`flex h-7 w-7 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9 shrink-0 items-center justify-center rounded-md transition-colors ${
            tag ? "bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300" : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
          title={tag ? `Served at ${tag}` : menu ? `Served with the menu at ${menu}; set a time of its own` : "Set a serving time of its own"}
          aria-label={tag ? `Serving time ${tag}` : "Serving time"}
          data-serving={tag ?? undefined}
          data-testid={testId}
        >
          <Clock className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3" data-testid={`${testId}-panel`}>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground" htmlFor={`${testId}-time`}>Served at</Label>
          <input
            id={`${testId}-time`}
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="block h-9 w-36 rounded-md border border-input bg-background px-3 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`${testId}-time`}
          />
          <p className="text-[11px] text-muted-foreground">
            {menu ? `Empty: served with the menu at ${menu}.` : "Empty: served with the menu."}
          </p>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground" htmlFor={`${testId}-group`}>Group (optional)</Label>
          <Input
            id={`${testId}-group`}
            value={group}
            maxLength={SERVING_GROUP_MAX}
            placeholder="e.g., Dessert"
            onChange={(e) => setGroup(e.target.value)}
            className="h-9"
            data-testid={`${testId}-group`}
          />
          {groups.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  className="h-7 rounded-full border px-2 text-[11px] hover:bg-accent [@media(pointer:coarse)]:h-9"
                  onClick={() => { setGroup(g.name); setTime(g.time); }}
                  data-testid={`${testId}-join`}
                >
                  {g.name} · <span className="font-mono">{g.time}</span>
                </button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">A group's dishes are served together, at one time.</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          {own && (
            <Button type="button" variant="ghost" size="sm" className="mr-auto h-8 text-xs [@media(pointer:coarse)]:h-9" onClick={() => apply({ time: "", group: "" })} data-testid={`${testId}-clear`}>
              Clear
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs [@media(pointer:coarse)]:h-9" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" className="h-8 text-xs [@media(pointer:coarse)]:h-9" onClick={() => apply({ time, group })} data-testid={`${testId}-done`}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
