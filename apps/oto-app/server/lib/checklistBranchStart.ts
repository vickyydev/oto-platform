/**
 * When a recurring checklist's runs start at a branch (SCRUM-749).
 *
 * The run creator catches up every period a branch missed, up to 370 days
 * back. A branch's first run is for the latest of three days: the day the
 * checklist was made, the day the branch opened, and the day an edit added the
 * branch to the checklist (`checklist_templates.branch_added_at`). A branch
 * opened today, or shared onto an older checklist today, starts with today's
 * run, not with every run it would have had since the checklist was made.
 *
 * A branch that already has runs carries on from its latest one, as before,
 * unless an edit added it again after that run: a branch taken off a checklist
 * and put back later starts again from the day it was put back, and the days it
 * was off the checklist are not filled in.
 *
 * Dates are the branch's local calendar days, `YYYY-MM-DD`, so they compare as
 * strings.
 */

const later = (day: string, other: string | null | undefined): string => (other && other > day ? other : day);

export function checklistRunStartDate(days: {
  /** The local day of the branch's latest run at this checklist, if it has one. */
  latestRunDate: string | null;
  checklistMadeDate: string;
  /** The local day the branch opened, if known. */
  branchOpenedDate: string | null;
  /** The local day an edit last added the branch to this checklist, if one did. */
  branchAddedDate: string | null;
}): string {
  if (days.latestRunDate) return later(days.latestRunDate, days.branchAddedDate);
  return later(later(days.checklistMadeDate, days.branchOpenedDate), days.branchAddedDate);
}

/**
 * The branches an edit adds to a checklist. `before` and `after` are the
 * branches it runs at, as the run creator reads them: an empty list is every
 * branch. A checklist that already ran at every branch has nothing added to
 * it; one that goes from named branches to every branch adds each branch of the
 * park group it did not name.
 */
export function branchesAddedByEdit(
  before: readonly string[],
  after: readonly string[],
  parkGroupBranchIds: readonly string[],
): string[] {
  if (before.length === 0) return [];
  const now = after.length === 0 ? parkGroupBranchIds : after;
  return [...new Set(now.filter((id) => !before.includes(id)))];
}

/** The local day an edit added this branch, read from the stored map; null if none did or the entry is unreadable. */
export function branchAddedAt(map: unknown, branchId: string): Date | null {
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const value = (map as Record<string, unknown>)[branchId];
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}
