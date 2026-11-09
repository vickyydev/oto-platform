import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { employees, users, type UserAccessMode } from "@shared/schema";
import { db } from "../db";
import type { DbExecutor } from "../storage";

/**
 * "Pay only" (SCRUM-769): what a login reaches once its employment has ended.
 *
 * The owner's rule (SCRUM-794) stands: through the notice period, up to and
 * including the last working day, everything works as usual. From the day
 * after, the person reaches no schedule, no clock-in and no internal data,
 * and may still read their own pay information while the final salary is
 * settled. So the 03:00 batch no longer switches the login off on that night;
 * it puts the login in pay only (`users.access_mode`, migration 0040):
 *
 *  - the login stays active, so the launcher hand-off and the app's own sign-in
 *    still let the person in, and `is_active` — the switch the platform's
 *    lifecycle trigger (0031) reports — does not change: no switch-off is
 *    queued for the platform while the person is in pay only;
 *  - the app then answers My pay alone, and addresses no notification to
 *    the login;
 *  - a login an administrator switches off is a different switch: it is off,
 *    and pay only changes nothing about that;
 *  - Offboard itself never sets it; Onboard Again's start lifts it
 *    (`lib/onboardAgain.ts`).
 *
 * How long pay only lasts is not decided: nothing here ends it but Onboard
 * Again or an administrator switching the login off.
 */

export const PAY_ONLY: UserAccessMode = "pay_only";
export const FULL_ACCESS: UserAccessMode = "full";

/**
 * The night batch's step (the 03:00 batch's `departedLogins`): the login of
 * every profile whose last working day is before today in Bangkok
 * (`bangkokMidnight`, the batch's own instant) and which has no Onboard Again
 * employment planned goes to pay only — the people the step switched off
 * before SCRUM-769, by the same rule; one park group's when `tenantId` is
 * given. Answers how many logins it moved.
 *
 * Only `access_mode` is written, never `is_active`. A login that is already
 * off (an administrator switched it off, or Offboard did for a last day
 * already past) stays off, and is marked too: switched back on later, by an
 * administrator here or on the platform, it reaches My pay and nothing more.
 */
export async function restrictDepartedLogins(opts: { bangkokMidnight: Date; tenantId?: string }): Promise<number> {
  const departed = db
    .select({ userId: employees.userId })
    .from(employees)
    .where(and(
      isNotNull(employees.lastWorkingDay),
      lt(employees.lastWorkingDay, opts.bangkokMidnight),
      isNotNull(employees.userId),
      opts.tenantId ? eq(employees.tenantId, opts.tenantId) : undefined,
      // SCRUM-794: an Onboard Again employment planned on the profile keeps
      // its login as it is between the two employments.
      sql`not exists (select 1 from employee_engagements g
                       where g.employee_id = ${employees.id} and g.status = 'planned')`,
    ));
  const moved = await db
    .update(users)
    .set({ accessMode: PAY_ONLY, updatedAt: new Date() })
    .where(and(
      inArray(users.id, departed),
      eq(users.accessMode, FULL_ACCESS),
    ))
    .returning({ id: users.id });
  return moved.length;
}

/**
 * Onboard Again's start: the login of the profile whose new employment has
 * started reaches the whole app again. On the caller's transaction; answers
 * whether the login was in pay only.
 */
export async function liftPayOnlyWithin(tx: DbExecutor, userId: string, now: Date = new Date()): Promise<boolean> {
  const lifted = await tx
    .update(users)
    .set({ accessMode: FULL_ACCESS, updatedAt: now })
    .where(and(eq(users.id, userId), eq(users.accessMode, PAY_ONLY)))
    .returning({ id: users.id });
  return lifted.length > 0;
}
