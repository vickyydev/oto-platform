/**
 * Who a leave type is for (SCRUM-1037, the owner's answer of 19 November
 * 2026): a type marked "managers only" is not shown to staff. "Manager" is
 * the app's own rule for leave: the roles `requireManager` lets through, the
 * people who record and approve time off (`isManagerRank` in
 * server/core/personScope.ts).
 *
 * Recording needs nothing more: POST and PATCH /api/time-off are
 * `requireManager` already, the same four roles, so only a manager records
 * any type for a person, as before. Records and balances are not held to
 * this: a person's own leave of any type, and payroll's figures, read as
 * before.
 */
import type { LeaveType } from "@shared/schema";

/** The types a caller is shown: every type for a manager; for anyone else, not the managers-only ones. */
export function leaveTypesShownTo<T extends Pick<LeaveType, "managersOnly">>(types: T[], manager: boolean): T[] {
  return manager ? types : types.filter((type) => !type.managersOnly);
}
