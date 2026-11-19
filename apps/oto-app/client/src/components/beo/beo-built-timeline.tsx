import { useQuery } from "@tanstack/react-query";
import { timelineStepLine, untimedBesideTimeline, type BeoTimeline } from "@shared/beoTimeline";

/**
 * SCRUM-1027: the party's one timeline, made by the system from the stored BEO
 * (shared/beoTimeline.ts, `GET /api/events/:eventId/beo/timeline/built`), as
 * the PDF prints it. Its key sits under the timeline's own, so every change to
 * the timeline's rows, and every Save of the BEO, reads it again.
 */
export const builtTimelineKey = (eventId: string) => ["/api/events", eventId, "beo", "timeline", "built"] as const;

export function useBuiltTimeline(eventId: string, options: { refetchInterval?: number } = {}) {
  return useQuery<BeoTimeline>({
    queryKey: builtTimelineKey(eventId),
    enabled: !!eventId,
    ...(options.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}

/** The timeline read-only: each step's time, what happens, what is served and its person; then the steps with no time. */
export function BeoBuiltTimelineList({ timeline, testId = "built-timeline" }: { timeline: BeoTimeline | undefined; testId?: string }) {
  const steps = timeline?.steps ?? [];
  const untimed = timeline?.untimed ? untimedBesideTimeline(timeline) : [];
  if (steps.length === 0 && untimed.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid={`${testId}-empty`}>No timed steps yet.</p>;
  }
  return (
    <div className="space-y-1" data-testid={testId}>
      {steps.map((step) => (
        <div key={step.key} className="flex items-start gap-3 py-1" data-testid={`${testId}-step`}>
          <span className="text-sm font-mono font-medium text-primary w-16 shrink-0">{step.time}</span>
          <span className="text-sm flex-1 min-w-0">
            {step.label}
            {step.detail && <span className="text-muted-foreground"> {step.detail}</span>}
            {step.person && <span className="text-muted-foreground"> · {step.person}</span>}
          </span>
        </div>
      ))}
      {untimed.length > 0 && (
        <p className="text-xs text-muted-foreground pt-1" data-testid={`${testId}-untimed`}>
          No time set: {untimed.map(timelineStepLine).join("; ")}
        </p>
      )}
    </div>
  );
}
