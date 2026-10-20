import type { UserWithBranchAccess } from "../../shared/schema";
import { resolveSelfEmployeeId } from "./selfEmployee";

/**
 * The ranks that read a branch's people (the app's own `requireManager`
 * notion in server/auth-middleware.ts): every other session is fenced to the
 * person on the reads that call `personFence` (SCRUM-595).
 */
const MANAGER_RANKS = new Set(["global_admin", "operator_admin", "admin", "manager"]);

export function isManagerRank(user: Pick<UserWithBranchAccess, "role"> | undefined | null): boolean {
  return !!user && MANAGER_RANKS.has(user.role);
}

/**
 * Whether the session reads only its own records, and whose they are.
 *  - a manager or admin session: `{ fenced: false }`, the branch rule alone;
 *  - any other session: `{ fenced: true, selfEmployeeId }`, its own employee
 *    record resolved as Today resolves it (login, then email, then phone,
 *    within the park group), or null when it has none.
 */
export type PersonFence = { fenced: false } | { fenced: true; selfEmployeeId: string | null };

export async function personFence(
  user: Pick<UserWithBranchAccess, "id" | "role" | "tenantId"> | undefined | null,
  tenantId?: string | null,
): Promise<PersonFence> {
  if (isManagerRank(user)) return { fenced: false };
  if (!user) return { fenced: true, selfEmployeeId: null };
  return { fenced: true, selfEmployeeId: await resolveSelfEmployeeId(user.id, tenantId ?? user.tenantId) };
}

/** True when a fenced session may read this employee's records. */
export function fenceAllows(fence: PersonFence, employeeId: string): boolean {
  return !fence.fenced || (fence.selfEmployeeId !== null && fence.selfEmployeeId === employeeId);
}

/** The rows a fenced session may see: its own only (none without a record). */
export function fenceRows<T extends { employeeId: string }>(fence: PersonFence, rows: T[]): T[] {
  return fence.fenced ? rows.filter((row) => fenceAllows(fence, row.employeeId)) : rows;
}

/** The refusal the employee reads use for another person's record. */
export const EMPLOYEE_DENIED = { message: "Access denied to this employee" } as const;
