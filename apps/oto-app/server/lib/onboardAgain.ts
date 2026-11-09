import { and, desc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import {
  contractInstances,
  employeeEngagements,
  employeeOffboarding,
  employees,
  loginLifecycleEvents,
  users,
  type EmployeeEngagement,
} from "@shared/schema";
import { db, pool } from "../db";
import { storage, type DbExecutor } from "../storage";
import { bangkokToday } from "./engagementDates";
import { rematchUnscheduledWork, type RematchCounts } from "./reviewRematch";

/**
 * Onboard Again's start (SCRUM-794): a planned employment on a profile becomes
 * the profile's employment on its start date.
 *
 * The profile keeps everything it has — its login, its face enrolment, its
 * documents and its history — and takes the planned employment's department,
 * branch, position and basis. Its status and employment state read active
 * again; the employee record's last working day, end reason, notice date and
 * offboarding type are cleared (the offboarding row keeps them, marked
 * re-onboarded, as the record of the contract that ended). A login that was
 * switched off is switched back on: the users trigger (migration 0031)
 * withdraws a switch-off still waiting for the platform, the same channel the
 * switch-off used. A contract for the planned employment signed before the
 * start date becomes the active contract now, superseding the one before it.
 */

export type LoginOutcome = "reactivated" | "already_on" | "none" | "outside_park_group";

export interface ActivationResult {
  engagementId: string;
  employeeId: string;
  tenantId: string;
  createdBy: string | null;
  login: LoginOutcome;
  /** The platform was already told of a switch-off; reactivating there is a platform administrator's step. */
  platformDeactivationDelivered: boolean;
  contractActivated: boolean;
}

export interface ActivationOptions {
  /** Who started it: the manager at the route, nobody (the night batch) otherwise. */
  actorId: string | null;
  /** Whether the profile's login is one the app places in the profile's park group. */
  loginInParkGroup: (userId: string, tenantId: string) => Promise<boolean>;
  now?: Date;
}

/** The night batch's placement rule: every branch-access row of the login is in the park group. */
export async function loginRowsInParkGroup(userId: string, tenantId: string): Promise<boolean> {
  const access = await storage.getUserBranchAccess(userId);
  return access.length > 0 && access.every((row) => row.tenantId === tenantId);
}

/**
 * On the caller's transaction, under offboarding's own per-employee lock.
 * Answers null when the engagement is not (or no longer) planned.
 */
export async function activateEngagementWithin(
  tx: DbExecutor,
  engagementId: string,
  opts: ActivationOptions,
): Promise<ActivationResult | null> {
  const now = opts.now ?? new Date();
  const [first] = await tx.select({ employeeId: employeeEngagements.employeeId }).from(employeeEngagements)
    .where(eq(employeeEngagements.id, engagementId));
  if (!first) return null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('employee_offboarding'), hashtext(${first.employeeId}))`);
  const [engagement] = await tx.select().from(employeeEngagements)
    .where(eq(employeeEngagements.id, engagementId)).for("update");
  if (!engagement || engagement.status !== "planned") return null;
  const [current] = await tx.select().from(employees)
    .where(and(eq(employees.id, engagement.employeeId), eq(employees.tenantId, engagement.tenantId))).for("update");
  if (!current) return null;

  const [updated] = await tx.update(employees).set({
    status: "active",
    employmentState: "ACTIVE",
    primaryDepartmentId: engagement.departmentId,
    branchId: engagement.branchId,
    ...(engagement.positionTitle
      ? { defaultMergeData: { ...(current.defaultMergeData ?? {}), positionTitle: engagement.positionTitle } }
      : {}),
    ...(engagement.employmentBasis ? { employmentBasis: engagement.employmentBasis } : {}),
    lastWorkingDay: null,
    endReason: null,
    noticeDate: null,
    offboardingType: null,
    updatedAt: now,
    ...(opts.actorId ? { updatedBy: opts.actorId } : {}),
  }).where(eq(employees.id, current.id)).returning();
  const branchChanged = (updated.branchId ?? null) !== (current.branchId ?? null);

  // The login, kept on or switched back on.
  let login: LoginOutcome = "none";
  let platformDeactivationDelivered = false;
  if (current.userId) {
    if (!(await opts.loginInParkGroup(current.userId, current.tenantId))) {
      login = "outside_park_group";
    } else {
      const [account] = await tx.select({ isActive: users.isActive }).from(users)
        .where(eq(users.id, current.userId)).for("update");
      if (account) {
        login = account.isActive ? "already_on" : "reactivated";
        if (!account.isActive || branchChanged) {
          await tx.update(users).set({
            isActive: true,
            ...(branchChanged ? { permissionReviewRequired: true } : {}),
            updatedAt: now,
          }).where(eq(users.id, current.userId));
        }
        if (login === "reactivated") {
          const [last] = await tx.select({ state: loginLifecycleEvents.state }).from(loginLifecycleEvents)
            .where(eq(loginLifecycleEvents.userId, current.userId))
            .orderBy(desc(loginLifecycleEvents.createdAt)).limit(1);
          platformDeactivationDelivered = last?.state === "delivered";
        }
      }
    }
  }

  // An employment an earlier Onboard Again started has ended with the offboarding this one follows.
  await tx.update(employeeEngagements).set({ status: "ended" }).where(and(
    eq(employeeEngagements.employeeId, current.id),
    eq(employeeEngagements.status, "active"),
    ne(employeeEngagements.id, engagement.id),
  ));
  await tx.update(employeeEngagements).set({ status: "active", activatedAt: now })
    .where(eq(employeeEngagements.id, engagement.id));

  // The offboarding this employment follows stays as the record, marked re-onboarded.
  const offboardingId = engagement.offboardingId ?? (await tx.select({ id: employeeOffboarding.id }).from(employeeOffboarding)
    .where(and(eq(employeeOffboarding.employeeId, current.id), isNull(employeeOffboarding.reonboardedAt)))
    .orderBy(desc(employeeOffboarding.createdAt)).limit(1))[0]?.id;
  if (offboardingId) {
    await tx.update(employeeOffboarding).set({ reonboardedAt: now, updatedAt: now })
      .where(and(eq(employeeOffboarding.id, offboardingId), isNull(employeeOffboarding.reonboardedAt)));
  }

  // A contract for this employment signed before its start date is the active one from today.
  let contractActivated = false;
  if (engagement.contractInstanceId) {
    const [contract] = await tx.select({ status: contractInstances.status, signingStatus: contractInstances.signingStatus })
      .from(contractInstances).where(eq(contractInstances.id, engagement.contractInstanceId));
    if (contract?.signingStatus === "signed" && contract.status !== "active") {
      await tx.update(contractInstances).set({ status: "superseded" }).where(and(
        eq(contractInstances.employeeId, current.id),
        eq(contractInstances.status, "active"),
        ne(contractInstances.id, engagement.contractInstanceId),
      ));
      await tx.update(contractInstances).set({ status: "active" }).where(eq(contractInstances.id, engagement.contractInstanceId));
      contractActivated = true;
    }
  }

  await storage.logActivity({
    branchId: updated.branchId || undefined,
    employeeId: current.id,
    activityType: "employment_state_changed",
    summaryText: `Onboard Again: the new employment started on ${engagement.startDate}; employment state changed from ${current.employmentState} to ACTIVE`
      + (login === "reactivated" ? "; the login is switched on again" : "")
      + (platformDeactivationDelivered
        ? ". The suite sign-in had already been switched off on the platform; a platform administrator reactivates it there"
        : ""),
    createdBy: opts.actorId ?? undefined,
  }, tx);

  return {
    engagementId: engagement.id,
    employeeId: current.id,
    tenantId: current.tenantId,
    createdBy: engagement.createdBy,
    login,
    platformDeactivationDelivered,
    contractActivated,
  };
}

/**
 * The planned employment a contract from the wizard is made for: the one the
 * request names, or — when it names none — the profile's planned employment,
 * since a contract made while the profile has one is the new employment's
 * (Create Contract, Contract Sent, Contract Signed is how the new contract is
 * made); undefined when the profile has none (the wizard as it always was);
 * false when the id named is not this profile's planned employment.
 */
export async function plannedEngagementForContract(
  employeeId: string,
  engagementId: unknown,
): Promise<EmployeeEngagement | undefined | false> {
  if (engagementId === undefined || engagementId === null || engagementId === "") {
    return (await storage.getPlannedEngagements([employeeId])).get(employeeId);
  }
  if (typeof engagementId !== "string") return false;
  const [engagement] = await db.select().from(employeeEngagements).where(and(
    eq(employeeEngagements.id, engagementId),
    eq(employeeEngagements.employeeId, employeeId),
    eq(employeeEngagements.status, "planned"),
  ));
  return engagement ?? false;
}

/**
 * The planned employment's contract is now this one. The draft it replaces is
 * archived when it was never finalized nor sent (nothing of it left the
 * app); one that was is left as it is, in the contract history.
 */
export async function linkContractToEngagement(exec: DbExecutor, engagement: EmployeeEngagement, contractId: string): Promise<void> {
  const previous = engagement.contractInstanceId;
  await exec.update(employeeEngagements).set({ contractInstanceId: contractId }).where(eq(employeeEngagements.id, engagement.id));
  if (previous && previous !== contractId) {
    await exec.update(contractInstances).set({ archivedAt: new Date() }).where(and(
      eq(contractInstances.id, previous),
      eq(contractInstances.status, "draft"),
      eq(contractInstances.signingStatus, "not_sent"),
      isNull(contractInstances.signingToken),
      isNull(contractInstances.archivedAt),
    ));
  }
}

/**
 * At signing: the planned employment a contract belongs to, if the profile
 * has one. The contract linked to it is its own. A contract linked to none
 * that was made while the employment was planned (a door that did not link
 * it) is the new employment's as well, and is linked to it here, as the
 * contract routes link one. A contract made before the plan is the current
 * employment's (`ownContract: false`): it is signed as it always was, and the
 * profile's employment state is left for the plan's start date.
 */
export async function planOfSignedContract(contract: {
  id: string;
  employeeId: string;
  createdAt: Date | string;
}): Promise<{ engagement: EmployeeEngagement; ownContract: boolean } | null> {
  const [linked] = await db.select().from(employeeEngagements).where(and(
    eq(employeeEngagements.contractInstanceId, contract.id),
    eq(employeeEngagements.status, "planned"),
  )).limit(1);
  if (linked) return { engagement: linked, ownContract: true };
  const planned = (await storage.getPlannedEngagements([contract.employeeId])).get(contract.employeeId);
  if (!planned) return null;
  if (new Date(contract.createdAt).getTime() < new Date(planned.createdAt).getTime()) {
    return { engagement: planned, ownContract: false };
  }
  await linkContractToEngagement(db, planned, contract.id);
  return { engagement: { ...planned, contractInstanceId: contract.id }, ownContract: true };
}

/**
 * Whether the profile's login is off and the platform has been told
 * (SCRUM-794): its newest switch-off was delivered, so the platform account —
 * the launcher, the only way in while the app's own password sign-in is off —
 * is switched off too. Nothing in the app switches it back on: the platform
 * takes no reactivation from the app, so a platform administrator reactivates
 * the account (which switches this login back on as well). A switch-off still
 * pending is withdrawn when the employment starts, and needs nobody.
 */
export async function platformSignInSwitchedOff(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [account] = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, userId));
  if (!account || account.isActive) return false;
  const [last] = await db.select({ state: loginLifecycleEvents.state }).from(loginLifecycleEvents)
    .where(eq(loginLifecycleEvents.userId, userId))
    .orderBy(desc(loginLifecycleEvents.createdAt)).limit(1);
  return last?.state === "delivered";
}

/** The branches a user settles attendance review items in: the attendance review's own rule. */
export async function reviewReach(userId: string): Promise<string[] | null> {
  const access = await storage.getUserBranchAccess(userId);
  if (access.some((row) => row.accessScope === "all_branches")) return null;
  return access.flatMap((row) => (row.branchId ? [row.branchId] : []));
}

export type RematchAnswer = RematchCounts | { failed: true };

/** Run after a committed activation or fold; its failure leaves the items pending, never the commit undone. */
export async function rematchAfter(employee: { id: string; tenantId: string }, actorId: string): Promise<RematchAnswer> {
  try {
    return await rematchUnscheduledWork(pool, {
      tenantId: employee.tenantId,
      employeeId: employee.id,
      actorId,
      branchIds: await reviewReach(actorId),
    });
  } catch {
    console.warn("[REVIEW_REMATCH] Matching pending approvals did not finish; they stay pending");
    return { failed: true };
  }
}

export interface PlannedStartsSummary {
  onboarded: number;
  rematched: number;
}

/**
 * The night batch's step (the 03:00 batch's status transitions): every
 * planned employment whose start date has come — today in Bangkok, or one
 * already past when the batch first runs — is started, one transaction each,
 * and the stray "Unscheduled work" approvals of the profile are matched to its
 * shifts as the manager who planned it. A failure is logged (no names) and
 * told to `onError`; the others still run.
 */
export async function startPlannedEngagements(opts: {
  tenantId?: string;
  today?: string;
  onError?: (error: unknown) => void;
} = {}): Promise<PlannedStartsSummary> {
  const today = opts.today ?? bangkokToday();
  const due = await db.select({ id: employeeEngagements.id }).from(employeeEngagements).where(and(
    eq(employeeEngagements.status, "planned"),
    lte(employeeEngagements.startDate, today),
    opts.tenantId ? eq(employeeEngagements.tenantId, opts.tenantId) : undefined,
  ));
  const summary: PlannedStartsSummary = { onboarded: 0, rematched: 0 };
  for (const { id } of due) {
    try {
      const started = await db.transaction((tx) =>
        activateEngagementWithin(tx, id, { actorId: null, loginInParkGroup: loginRowsInParkGroup }));
      if (!started) continue;
      summary.onboarded += 1;
      if (started.createdBy) {
        const rematch = await rematchAfter({ id: started.employeeId, tenantId: started.tenantId }, started.createdBy);
        if (!("failed" in rematch)) summary.rematched += rematch.matched;
      }
    } catch (error) {
      console.error(`[ONBOARD_AGAIN] Planned employment ${id} could not be started:`, error);
      opts.onError?.(error);
    }
  }
  return summary;
}
