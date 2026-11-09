import type { NextFunction, Request, Response } from "express";
import { and, desc, eq, inArray, isNotNull, lt, not, sql, type SQL } from "drizzle-orm";
import { employees, loginLifecycleEvents, users, type UserAccessMode } from "@shared/schema";
import { EMPLOYMENT_ENDED, PAY_ONLY_MESSAGE } from "@shared/payOnly";
import { db } from "../db";
import type { DbExecutor } from "../storage";
import { payOnlyRefuses } from "./payOnlyRoutes";
import { bangkokMidnight } from "./employmentEnded";
import { bangkokToday } from "./engagementDates";

/**
 * "Pay only" (SCRUM-769): what a login reaches once its employment has ended.
 *
 * The owner's rule (SCRUM-794) stands: through the notice period, up to and
 * including the last working day, everything works as usual. From the day
 * after, the person reaches no schedule, no clock-in and no internal data,
 * and may still read their own pay information while the final salary is
 * settled. So the 03:00 batch no longer switches the login off on that night;
 * it puts the login in pay only (`users.access_mode`, migration 0043):
 *
 *  - the login stays active, so the launcher hand-off and the app's own sign-in
 *    still let the person in, and `is_active` does not change: no switch-off is
 *    queued for the platform (0031);
 *  - the platform is told instead that the login is restricted (migration
 *    0044's trigger on `access_mode`, delivered by `./platformLifecycle.ts`):
 *    it keeps the account on with its road to the OTO App, ends its sessions
 *    and withdraws every other role it holds — the till, the booth, the
 *    console — so the person's suite access outside My pay ends that night, as
 *    the switch-off ended it before;
 *  - the app then answers My pay alone (the fence below and the client's
 *    pay-only shell), addresses no notification to the login, and leaves it
 *    out of the lists of people still on staff (`onStaff`);
 *  - a login an administrator switches off is a different switch: it is off,
 *    and pay only changes nothing about that;
 *  - Offboard never switches the login off. With a last working day already
 *    past it puts the login in pay only at once (`restrictLoginWithin`), the
 *    state the batch would put it in that night.
 *
 * Pay only ends when the person works here again: Onboard Again's start
 * (`lib/onboardAgain.ts`), or a last working day moved to today or later
 * (`liftPayOnlyIfWorkingWithin`, and the batch's own two-way step). Otherwise
 * nothing ends it but an administrator switching the login off.
 */

export const PAY_ONLY: UserAccessMode = "pay_only";
export const FULL_ACCESS: UserAccessMode = "full";

/** Whether the profile has an Onboard Again employment planned (SCRUM-794): its login is held as it is. */
const planned = (employeeId: SQL | string) =>
  sql`exists (select 1 from employee_engagements g where g.employee_id = ${employeeId} and g.status = 'planned')`;

/**
 * Whether one of the login's profiles has a last working day before the
 * instant (the batch's Bangkok midnight): the departed rule's own half, so the
 * restriction and its lifting never disagree about the same login.
 */
const endedProfileOf = (instant: Date) =>
  sql`exists (select 1 from employees e
               where e.user_id = ${users.id} and e.last_working_day is not null and e.last_working_day < ${instant})`;

/**
 * The night batch's step (the 03:00 batch's `departedLogins`), both ways:
 *
 *  - the login of every profile whose last working day is before today in
 *    Bangkok (`bangkokMidnight`, the batch's own instant) and which has no
 *    Onboard Again employment planned goes to pay only — the people the step
 *    switched off before SCRUM-769, by the same rule;
 *  - a login in pay only none of whose profiles has a last working day before
 *    today any more (the day was moved later, or cleared) reaches the whole app
 *    again. A profile with Onboard Again planned keeps its last day until the
 *    start, so its login stays as it is until Onboard Again's start lifts it.
 *
 * One park group's when `tenantId` is given. Answers how many logins moved each
 * way. Only `access_mode` is written, never `is_active`: a login that is
 * already off stays off, and is marked too, so switched back on later, by an
 * administrator here or on the platform, it reaches My pay and nothing more.
 */
export async function restrictDepartedLogins(
  opts: { bangkokMidnight: Date; tenantId?: string },
): Promise<{ payOnly: number; fullAgain: number }> {
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
      not(planned(sql`${employees.id}`)),
    ));
  const moved = await db
    .update(users)
    .set({ accessMode: PAY_ONLY, updatedAt: new Date() })
    .where(and(
      inArray(users.id, departed),
      eq(users.accessMode, FULL_ACCESS),
    ))
    .returning({ id: users.id });
  const lifted = await db
    .update(users)
    .set({ accessMode: FULL_ACCESS, updatedAt: new Date() })
    .where(and(
      eq(users.accessMode, PAY_ONLY),
      sql`exists (select 1 from employees e where e.user_id = ${users.id}
                   ${opts.tenantId ? sql`and e.tenant_id = ${opts.tenantId}` : sql``})`,
      not(endedProfileOf(opts.bangkokMidnight)),
    ))
    .returning({ id: users.id });
  return { payOnly: moved.length, fullAgain: lifted.length };
}

/**
 * Offboard with a last working day already past (SCRUM-769): the employment
 * has ended, so the login goes to pay only now, as the 03:00 batch would put
 * it that night — never switched off. A profile with Onboard Again planned is
 * held as the batch holds it. On the caller's transaction; answers whether the
 * login moved.
 */
export async function restrictLoginWithin(
  tx: DbExecutor,
  profile: { id: string; userId: string },
  now: Date = new Date(),
): Promise<boolean> {
  const moved = await tx
    .update(users)
    .set({ accessMode: PAY_ONLY, updatedAt: now })
    .where(and(eq(users.id, profile.userId), eq(users.accessMode, FULL_ACCESS), not(planned(profile.id))))
    .returning({ id: users.id });
  return moved.length > 0;
}

/**
 * Onboard Again's start: the login of the profile whose new employment has
 * started reaches the whole app again. On the caller's transaction; answers
 * whether the login was in pay only. Lifting it withdraws a restriction still
 * waiting for the platform (0044's trigger).
 */
export async function liftPayOnlyWithin(tx: DbExecutor, userId: string, now: Date = new Date()): Promise<boolean> {
  const lifted = await tx
    .update(users)
    .set({ accessMode: FULL_ACCESS, updatedAt: now })
    .where(and(eq(users.id, userId), eq(users.accessMode, PAY_ONLY)))
    .returning({ id: users.id });
  return lifted.length > 0;
}

/**
 * A last working day moved to today or later (the offboarding's edit): the
 * person is working out their notice again, so a login in pay only reaches the
 * whole app again — when none of the login's profiles still has a last working
 * day before today, the batch's own rule. On the caller's transaction, after
 * the profile's new last day is written; answers whether the login moved.
 */
export async function liftPayOnlyIfWorkingWithin(tx: DbExecutor, userId: string, now: Date = new Date()): Promise<boolean> {
  const lifted = await tx
    .update(users)
    .set({ accessMode: FULL_ACCESS, updatedAt: now })
    .where(and(
      eq(users.id, userId),
      eq(users.accessMode, PAY_ONLY),
      not(endedProfileOf(bangkokMidnight(bangkokToday(now)))),
    ))
    .returning({ id: users.id });
  return lifted.length > 0;
}

/**
 * Whether the platform has had this login's newest restriction (0044): its
 * roles outside the OTO App were withdrawn there, and nothing in the app gives
 * them back — a platform administrator does, on the Console's Login users page.
 */
export async function platformRestrictionDelivered(exec: DbExecutor, userId: string): Promise<boolean> {
  const [last] = await exec.select({ state: loginLifecycleEvents.state }).from(loginLifecycleEvents)
    .where(and(eq(loginLifecycleEvents.userId, userId), eq(loginLifecycleEvents.kind, "restrict")))
    .orderBy(desc(loginLifecycleEvents.createdAt)).limit(1);
  return last?.state === "delivered";
}

/**
 * A login still on staff: switched on and reaching the whole app. A login in
 * pay only is switched on (so its owner can read their pay) but its employment
 * has ended, so the lists of people to assign work to, to staff an event with
 * or to alert leave it out beside the logins that are off: anything addressed
 * to it would reach nobody.
 */
export const onStaff = (): SQL => and(eq(users.isActive, true), eq(users.accessMode, FULL_ACCESS))!;

// ─── What a login in pay only reaches ────────────────────────────────────────

/**
 * The fence, registered after the session is read (`server/routes.ts`, after
 * `loadUserWithAccess`): a signed-in login in pay only is answered 403
 * EMPLOYMENT_ENDED, in words, everywhere but the routes `./payOnlyRoutes.ts`
 * names. Read from the session's user, which is read from the database on
 * every request, so a login the night batch moves is fenced from its next
 * request on. Anybody else passes untouched.
 */
export function payOnlyFence(req: Request, res: Response, next: NextFunction): void {
  const user = req.user as { accessMode?: string } | undefined;
  if (!req.isAuthenticated?.() || user?.accessMode !== PAY_ONLY || !payOnlyRefuses(req.method, req.path)) return next();
  res.setHeader("Cache-Control", "private, no-store");
  res.status(403).json({ reason: EMPLOYMENT_ENDED, reasonCode: EMPLOYMENT_ENDED, message: PAY_ONLY_MESSAGE });
}

/**
 * Whether a notification addressed to this login should be dropped: a login in
 * pay only reads no inbox (the fence refuses it), so nothing is addressed to it.
 */
export async function inPayOnly(userId: string | null | undefined, exec: DbExecutor = db): Promise<boolean> {
  if (!userId) return false;
  const [row] = await exec.select({ accessMode: users.accessMode }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.accessMode === PAY_ONLY;
}
