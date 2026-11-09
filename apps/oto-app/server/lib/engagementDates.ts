/**
 * The calendar-day rules of offboarding and Onboard Again (SCRUM-794), with
 * no imports so the storage layer, the routes and the night batch can all
 * read the same ones. Days are `YYYY-MM-DD`, in Bangkok time, the day the park
 * keeps.
 */

/** Today's calendar day in Bangkok, as the offboarding route compares last working days. */
export function bangkokToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(now);
}

/** The status an ended employment takes from its offboarding's type ("resignation" or "termination", any case). */
export function leaverStatusOf(offboardingType: string | null | undefined): "resigned" | "terminated" {
  return String(offboardingType ?? "").toLowerCase().startsWith("termin") ? "terminated" : "resigned";
}

const DAY_MS = 86_400_000;

/** The calendar day before a `YYYY-MM-DD` day. */
export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

export interface PlannedPlacement {
  startDate: string;
  departmentId: string;
  branchId: string;
}

/**
 * Where a profile works on a day. A profile offboarded and onboarded again
 * works under two employments: the current one up to and including the
 * offboarding's last working day, and the planned one from its start date
 * (always after the last day). Before the start date: the profile's current
 * department and branch; on and after it: the planned employment's, and
 * `planned` says so.
 */
export function placementOn(
  current: { primaryDepartmentId: string | null; branchId: string | null },
  planned: PlannedPlacement | undefined,
  day: string,
): { departmentId: string | null; branchId: string | null; planned: boolean } {
  if (planned && day >= planned.startDate) {
    return { departmentId: planned.departmentId, branchId: planned.branchId, planned: true };
  }
  return { departmentId: current.primaryDepartmentId, branchId: current.branchId, planned: false };
}
