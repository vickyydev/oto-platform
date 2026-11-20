import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { beoClockOf } from "@shared/beoClock";

/** What a stored time shows in the box: the clock it is ("9:30" and "09:30:00" read 09:30), else empty. */
export function beoTimeBoxValueOf(stored: string | null | undefined): string {
  return beoClockOf(stored)?.time ?? "";
}

/**
 * SCRUM-1029 (the brief's E1): one plain time box for each time of the BEO editor, in place of the
 * clock chip, its gear and its Confirm row. The box holds what is typed or picked and hands it over
 * when the person leaves the box or presses Enter, as Confirm did; Escape puts back what it showed,
 * as Cancel did. An emptied box hands over "" (what the chip's clear did); a box left as it showed
 * hands over nothing, so a time the person did not touch is saved exactly as stored. `onCommit`
 * answers false when it refuses the time (an end before the start): the box shows the stored time
 * again.
 *
 * A stored time the box cannot show as a clock (words typed before this box) is said beside the
 * empty box, as stored, and kept until the person types a time.
 */
export function BeoTimeBox({
  value,
  onCommit,
  disabled = false,
  label,
  className,
  testId,
}: {
  value: string | null | undefined;
  onCommit: (next: string) => boolean | void;
  disabled?: boolean;
  /** The box's name for a screen reader (the label beside it names it on screen). */
  label: string;
  className?: string;
  testId: string;
}) {
  const shown = beoTimeBoxValueOf(value);
  const [draft, setDraft] = useState(shown);
  // A time changed from outside the box (the BEO read, AI Fill, Fetch from chat) is shown at once.
  useEffect(() => setDraft(shown), [shown]);
  const asStored = typeof value === "string" && value.trim() !== "" && shown === "" ? value.trim() : null;

  const commit = () => {
    if (disabled || draft === shown) return;
    if (onCommit(draft) === false) setDraft(shown);
  };

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <input
        type="time"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(shown);
          }
        }}
        disabled={disabled}
        aria-label={label}
        className={cn(
          "h-9 w-32 shrink-0 rounded-md border border-input bg-background px-3 font-mono text-sm tabular-nums ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        data-testid={testId}
      />
      {asStored && (
        <span className="text-xs text-muted-foreground" data-testid={`${testId}-as-stored`}>
          Stored as “{asStored}”
        </span>
      )}
    </span>
  );
}
