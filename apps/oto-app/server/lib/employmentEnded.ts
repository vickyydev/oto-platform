import type { Employee } from "@shared/schema";

/**
 * When an employment has ended, as the kiosk measures it (SCRUM-769), with no
 * runtime imports so the kiosk doors (`./kioskEmploymentEnded.ts`) and the
 * checks read the same rule.
 */

/** Midnight of a Bangkok calendar day, as an instant: the 03:00 batch's "today". */
export const bangkokMidnight = (day: string): Date => new Date(`${day}T00:00:00+07:00`);

/**
 * Whether a profile's employment has ended by `today` (a Bangkok day), on the
 * profile alone. Ended: resigned or terminated, or Left — and past its last
 * working day, by the 03:00 batch's own measure (a last working day before
 * today's Bangkok midnight). A profile resigned with its last day today or
 * later is still working out its notice (SCRUM-794: everything works as usual
 * until then). A profile Onboard Again has started reads active again (its
 * start sets the status and clears the last day), so it is not ended; nor is
 * one whose planned employment starts today before the night batch has
 * started it (`newEmploymentStarted`).
 */
export function employmentEndedOn(
  profile: Pick<Employee, "status" | "employmentState" | "lastWorkingDay">,
  today: string,
  newEmploymentStarted = false,
): boolean {
  if (newEmploymentStarted) return false;
  const ended = profile.status === "resigned" || profile.status === "terminated" || profile.employmentState === "LEFT";
  if (!ended) return false;
  if (!profile.lastWorkingDay) return true;
  return new Date(profile.lastWorkingDay).getTime() < bangkokMidnight(today).getTime();
}
