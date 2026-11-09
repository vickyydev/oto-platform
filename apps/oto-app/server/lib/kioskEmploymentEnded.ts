import type { Response } from "express";
import { and, eq, lte } from "drizzle-orm";
import { employeeEngagements, type AuthMethod, type Employee } from "@shared/schema";
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
