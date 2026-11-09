import type { Response } from "express";
import { and, asc, eq, lte, ne, or } from "drizzle-orm";
import { employeeEngagements, employees, type AuthMethod, type Employee } from "@shared/schema";
import { EMPLOYMENT_ENDED, KIOSK_EMPLOYMENT_ENDED_MESSAGE } from "@shared/payOnly";
import { db } from "../db";
import { storage } from "../storage";
import { bangkokToday } from "./engagementDates";
import { employmentEndedOn } from "./employmentEnded";

/**
 * The kiosk refuses a clock-in or clock-out for an ended employment (SCRUM-769).
 *
 * The owner's rule (SCRUM-794): during the notice — up to and including the
 * last working day — everything works as usual, the kiosk included. From the
 * day after, the person no longer works here, so a scan or a phone number at
 * the kiosk writes nothing and the tablet says why in one line.
 *
 * Every kiosk door that writes a time record for an employee asks this before
 * it writes: the face road (`identify-face`, `clock` and its three
 * follow-ups) and the phone and PIN roads, which are the tablet's fallback
 * while face clock-in is off (`lib/faceOff.ts`). The refused attempt is kept
 * as a failed kiosk attempt, `employment_ended`, so a manager can see it.
 */

export const KIOSK_EMPLOYMENT_ENDED_FAIL_REASON = "employment_ended";

/** What the kiosk is answered: 403, in words the tablet shows as they are. */
export const KIOSK_EMPLOYMENT_ENDED_REFUSAL = {
  success: false,
  reason: EMPLOYMENT_ENDED,
  reasonCode: EMPLOYMENT_ENDED,
  message: KIOSK_EMPLOYMENT_ENDED_MESSAGE,
} as const;

/** `employmentEndedOn` for today in Bangkok, with the profile's planned employments read. */
export async function kioskEmploymentEnded(
  profile: Pick<Employee, "id" | "status" | "employmentState" | "lastWorkingDay">,
  now: Date = new Date(),
): Promise<boolean> {
  const today = bangkokToday(now);
  if (!employmentEndedOn(profile, today)) return false;
  // An Onboard Again employment whose start date has come, which the night
  // batch has not started yet: the person starts work today.
  const [due] = await db.select({ id: employeeEngagements.id }).from(employeeEngagements).where(and(
    eq(employeeEngagements.employeeId, profile.id),
    eq(employeeEngagements.status, "planned"),
    lte(employeeEngagements.startDate, today),
  )).limit(1);
  return employmentEndedOn(profile, today, !!due);
}

/**
 * The profile a phone number names at the kiosk's park group: of every profile
 * there carrying the number (`employees.phone_e164` is not unique), the first
 * whose employment has not ended, and only when every one of them has ended,
 * the first of those — which the kiosk then refuses. A person whose old
 * profile has ended and who works under a second one (the duplicate shape
 * SCRUM-794's fold resolves) clocks in on the one they work under, as they
 * did before the kiosk refused ended profiles. In a fixed order, so one number
 * names the same profile every time.
 */
export async function kioskProfileByPhone(phoneE164: string, tenantId: string, now: Date = new Date()): Promise<Employee | undefined> {
  const profiles = await db.select().from(employees)
    .where(and(eq(employees.phoneE164, phoneE164), eq(employees.tenantId, tenantId)))
    .orderBy(asc(employees.createdAt), asc(employees.id));
  for (const profile of profiles) {
    if (!(await kioskEmploymentEnded(profile, now))) return profile;
  }
  return profiles[0];
}

/**
 * Whether a face matched an ended profile of somebody who still works here
 * under another one: a profile in the same park group sharing its phone number
 * or its login whose employment has not ended. The face road then answers as
 * for no match, so the tablet falls to the phone road, which clocks the profile
 * the person works under (`kioskProfileByPhone`); the ended profile is refused
 * only when it is the person's last.
 */
export async function workingProfileBesides(
  profile: Pick<Employee, "id" | "tenantId" | "phoneE164" | "userId">,
  now: Date = new Date(),
): Promise<boolean> {
  const same = [
    profile.phoneE164 ? eq(employees.phoneE164, profile.phoneE164) : undefined,
    profile.userId ? eq(employees.userId, profile.userId) : undefined,
  ].filter((c) => c !== undefined);
  if (same.length === 0) return false;
  const others = await db.select().from(employees)
    .where(and(eq(employees.tenantId, profile.tenantId), ne(employees.id, profile.id), or(...same)));
  for (const other of others) {
    if (!(await kioskEmploymentEnded(other, now))) return true;
  }
  return false;
}

/**
 * The refusal: the failed attempt kept (no time record, no entry, no issue
 * written), then 403 in words.
 */
export async function refuseEndedEmployment(
  res: Response,
  attempt: {
    employeeId: string;
    branchId: string;
    kioskDeviceId?: string;
    method: AuthMethod;
    photoEvidenceUrl?: string | null;
    sessionId?: string;
  },
): Promise<void> {
  await storage.createKioskAuthAttempt({
    employeeId: attempt.employeeId,
    branchId: attempt.branchId,
    kioskDeviceId: attempt.kioskDeviceId,
    attemptTime: new Date(),
    method: attempt.method,
    outcome: "FAIL",
    failReason: KIOSK_EMPLOYMENT_ENDED_FAIL_REASON,
    photoEvidenceUrl: attempt.photoEvidenceUrl ?? undefined,
    sessionId: attempt.sessionId,
  });
  res.status(403).json(KIOSK_EMPLOYMENT_ENDED_REFUSAL);
}
