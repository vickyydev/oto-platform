// SCRUM-777 — what one schedule action wrote, row by row, as its own inserts,
// updates and deletes returned the rows. The change set "Undo this action"
// reverses is built from this alone (server/lib/scheduleChangeSet.ts), so a
// write somebody else makes to the same branch and week while the action runs
// is never counted as the action's.
//
// The writers (the template applies in storage.ts, the department clear and
// the whole-week delete in routes.ts) take one of these optionally and note
// into it; without one they write exactly as before.
import type { ChangeSetGroup } from "./scheduleChangeSet";

export interface ScheduleWriteLog {
  /** Rows the action inserted, as the insert returned them. */
  created: Partial<Record<ChangeSetGroup, object[]>>;
  /** Rows the action changed: as it read them before, and as the update returned them. */
  updated: Partial<Record<ChangeSetGroup, Array<{ before: object; after: object }>>>;
  /** Rows the action deleted, as the delete returned them (or as read just before a cascade). */
  deleted: Partial<Record<ChangeSetGroup, object[]>>;
}

export const newScheduleWriteLog = (): ScheduleWriteLog => ({ created: {}, updated: {}, deleted: {} });

/** Notes rows one write of the action inserted or deleted. */
export function noteScheduleWrites(
  log: ScheduleWriteLog | undefined,
  part: "created" | "deleted",
  group: ChangeSetGroup,
  rows: readonly object[],
): void {
  if (!log || rows.length === 0) return;
  (log[part][group] ??= []).push(...rows);
}

/**
 * Notes a row the action changed. A row it changes twice keeps the first
 * reading as its before and the last as its after.
 */
export function noteScheduleUpdate(
  log: ScheduleWriteLog | undefined,
  group: ChangeSetGroup,
  before: object,
  after: object,
): void {
  if (!log) return;
  const entries = (log.updated[group] ??= []);
  const id = (after as { id?: unknown }).id;
  const earlier = entries.find((entry) => (entry.after as { id?: unknown }).id === id);
  if (earlier) earlier.after = after;
  else entries.push({ before, after });
}
