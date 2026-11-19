/**
 * Who a leave type is for (SCRUM-1037, the owner's answer of 19 November
 * 2026): a type marked "managers only" is not shown to staff, and only a
 * manager records it for a person. "Manager" is the app's own rule for leave:
 * the roles `requireManager` lets through, the people who record and approve
 * time off (`isManagerRank` in server/core/personScope.ts).
 *
 * Only the catalogue a caller is shown and the choice of type on a new or
 * changed record are held to this. Records and balances are not: a person's
 * own leave of any type, and payroll's figures, read as before.
 */
import type { LeaveType } from "@shared/schema";

/** The types a caller is shown: every type for a manager; for anyone else, not the managers-only ones. */
export function leaveTypesShownTo<T extends Pick<LeaveType, "managersOnly">>(types: T[], manager: boolean): T[] {
  return manager ? types : types.filter((type) => !type.managersOnly);
}

/**
 * Why a new or changed time-off record may not take this type, or null when
 * it may: an unknown or switched-off type is refused for everyone (the rule
 * since SCRUM-560, its words kept); a managers-only type is refused for
 * anyone below manager.
 */
export function leaveTypeRefusal(
  type: Pick<LeaveType, "name" | "isActive" | "managersOnly"> | undefined,
  manager: boolean,
): { status: 400 | 403; message: string } | null {
  if (!type || !type.isActive) return { status: 400, message: "Unknown or inactive leave type" };
  if (type.managersOnly && !manager) {
    return { status: 403, message: `${type.name} is for managers only: ask your manager to record it for you` };
  }
  return null;
}
