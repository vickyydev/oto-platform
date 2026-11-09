// Which of a checklist's runs Today shows, and the action it offers on it
// (SCRUM-751). One rule for the server (GET /api/checklists/today picks the
// run) and the Today page (the button), so the two cannot drift apart.
//
// A run is open while it can still be worked: pending, in progress, or
// completed with issues (the Ops board shows all three as work to do and
// opens them on /core/checklist/:id). Completed, missed and cancelled runs
// are closed; a missed run stays read-only, as the item route enforces.

export const OPEN_CHECKLIST_RUN_STATUSES = ["pending", "in_progress", "issues"] as const;

export function isOpenChecklistRun(status: string | null | undefined): boolean {
  return !!status && (OPEN_CHECKLIST_RUN_STATUSES as readonly string[]).includes(status);
}

type RunLike = { status: string | null; createdAt: Date | string };

/**
 * Today's run of a checklist among the runs it has today in the branch:
 * an open run first, then a completed one, then any other (missed,
 * cancelled); the newest within each. A run the recurring creator writes
 * today for an earlier, already missed period no longer hides the open run
 * of today's period.
 */
export function pickTodayChecklistRun<T extends RunLike>(runs: readonly T[]): T | null {
  const rank = (run: T) => (isOpenChecklistRun(run.status) ? 0 : run.status === "completed" ? 1 : 2);
  const time = (run: T) => new Date(run.createdAt).getTime();
  return [...runs].sort((a, b) => rank(a) - rank(b) || time(b) - time(a))[0] ?? null;
}

export type TodayChecklistAction =
  | { kind: "start" }
  | { kind: "continue"; href: string }
  | { kind: "view"; href: string };

/**
 * The button Today shows for a checklist: Start when it has no run today,
 * Continue on an open run whether or not it is overdue, View otherwise. Both
 * links open the run where the Ops module opens it.
 */
export function todayChecklistAction(todayRun: { id: string; status: string | null } | null | undefined): TodayChecklistAction {
  if (!todayRun) return { kind: "start" };
  const href = `/core/checklist/${todayRun.id}`;
  return isOpenChecklistRun(todayRun.status) ? { kind: "continue", href } : { kind: "view", href };
}
