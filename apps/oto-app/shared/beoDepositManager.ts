/**
 * THE DEPOSIT TYPED BY HAND IS A MANAGER'S (SCRUM-1034).
 *
 * The owner kept the BEO's hand-typed deposit for a deposit taken in cash,
 * for managers only. "Manager" is the app's own check for it: the roles
 * `requireManager` lets through (server/auth-middleware.ts), the same list the
 * BEO editor already reads for the Billing section's money (`canManageBilling`).
 * The screen shows the deposit read-only to anyone else, and the BEO's Save
 * refuses a deposit changed by anyone else (server/lib/depositSaveGuard.ts,
 * `depositChangeRefused`). No deposit rule and no amount changes here.
 */
export const BEO_DEPOSIT_ROLES = ["global_admin", "operator_admin", "admin", "manager"] as const;

/** Whether this role may type or change the BEO's deposit by hand. */
export function mayChangeBeoDeposit(role: string | null | undefined): boolean {
  return typeof role === "string" && (BEO_DEPOSIT_ROLES as readonly string[]).includes(role);
}

/** What the screen says beside the read-only deposit, and the Save's refusal. */
export const BEO_DEPOSIT_MANAGERS_ONLY = "Only a manager can type or change the deposit.";
