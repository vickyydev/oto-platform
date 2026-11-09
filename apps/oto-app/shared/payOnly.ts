/**
 * The words and the code of an ended employment (SCRUM-769), shared by the
 * server's refusals and the client's screens so the two never say it
 * differently. No imports: the client bundle and the server both read it.
 */

/** The refusal's code: the app's fence for a login in pay only. */
export const EMPLOYMENT_ENDED = "EMPLOYMENT_ENDED";

/** What a login in pay only is told, on My pay and in every refusal of the app's fence. */
export const PAY_ONLY_MESSAGE = "Your employment has ended; your pay information stays available here.";

/** Whether a signed-in user is in pay only (`users.access_mode`). */
export function isPayOnly(user: { accessMode?: string | null } | null | undefined): boolean {
  return user?.accessMode === "pay_only";
}
