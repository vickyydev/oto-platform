import type { Express, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  branches,
  contractInstances,
  departments,
  employeeEngagements,
  employeeOffboarding,
  employees,
  employmentBasisTypes,
  type Employee,
} from "@shared/schema";
import { roleCanPerformAction } from "@shared/permissions";
import { db } from "./db";
import { storage } from "./storage";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireAction, requireAdmin, requireManager } from "./auth-middleware";
import { faceRecognitionService } from "./face-recognition";
import { foldEmployeeInto, type FoldInput } from "./lib/employeeFold";
import { rematchUnscheduledWork } from "./lib/reviewRematch";
import {
  activateEngagementWithin,
  platformSignInSwitchedOff,
  rematchAfter,
  reviewReach,
  type ActivationResult,
  type RematchAnswer,
} from "./lib/onboardAgain";
import { bangkokToday } from "./lib/engagementDates";

/**
 * SCRUM-794: one person, one profile, across two contracts.
 *
 *  - POST /api/employees/:id/onboard-again (GET to read it, DELETE
 *    .../:engagementId to cancel it before its start date) — Onboard Again: a
 *    new employment planned on the profile that is ending (or has ended) its
 *    current contract, with its start date, department, branch, position and
 *    basis, and a draft contract for it made the way the contract wizard's
 *    "Save draft" makes one. The profile keeps its login, face enrolment and
 *    history; the new department schedules it from the start date while the
 *    current one still does up to the last working day; the 03:00 batch starts
 *    it on its start date (lib/onboardAgain.ts), or this door does at once
 *    when the start date is today or already past.
 *  - POST /api/employees/:id/fold-into/:targetId (and GET .../preview) — a
 *    duplicate profile made for the same person folded into the one that
 *    holds the login: its shifts, checklists, tasks, contracts, time records,
 *    face, documents, letters, company property, leave, payroll profile,
 *    history and org chart entries moved, the duplicate deleted, and — when the original has left
 *    or is leaving and the duplicate is the one working — the original
 *    onboarded again into the duplicate's employment, on its terms.
 *  - POST /api/employees/:id/review/rematch — the profile's pending
 *    "Unscheduled work" approvals matched to the shifts it now has; run after a
 *    fold and after an Onboard Again start as well.
 */

type Template = NonNullable<Awaited<ReturnType<typeof storage.getTemplateInParkGroup>>>;

export interface EmployeeOnboardAgainDependencies {
  pool: Pool;
  employeeOfParkGroup: (req: Request, employeeId: string) => Promise<Employee | undefined>;
  userManagementTenant: (req: Request) => Promise<string | undefined>;
  managedUserTenant: (userId: string) => Promise<string | undefined>;
  employeeDeletionInput: (
    employee: Employee,
    tenantId: string,
  ) => Promise<{ employeeId: string; tenantId: string; personId: string | null; leavingUserId: string | null }>;
  employeeDeleteOutsideParkGroup: (employee: Employee, tenantId: string) => Promise<{ message: string } | null>;
  /** POST /api/contracts' own compile of a contract's snapshot and merge data. */
  compileContractDraft: (
    employee: Employee,
    template: Template,
    mergeDataJson: Record<string, unknown>,
    language: string | undefined,
  ) => Promise<{ templateSnapshotHtml: string; enhancedMergeData: Record<string, unknown> }>;
  /** After a commit that changed an employee: the attention engine's trigger. */
  committed: (employeeId: string) => void;
}

const isLeft = (status: string | null | undefined) => status === "resigned" || status === "terminated";
const dayOf = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString().slice(0, 10) : null;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const onboardAgainBody = z.object({
  startDate: z.string().min(1, "Start date is required")
    .transform((value) => value.split("T")[0]!)
    .refine((value) => ISO_DAY.test(value) && Number.isFinite(Date.parse(value)), "Start date is not a date"),
  departmentId: z.string().min(1, "Department is required"),
  branchId: z.string().min(1).nullish(),
  positionTitle: z.string().trim().min(1).max(200).nullish(),
  employmentBasis: z.enum(employmentBasisTypes).nullish(),
  templateId: z.string().min(1).nullish(),
  language: z.enum(["en", "th"]).nullish(),
}).strict();

const TERMINATE_RIGHT = "Onboard Again needs the hr.terminate_employee right, the right offboarding a termination needs";

export function registerEmployeeOnboardAgainRoutes(app: Express, deps: EmployeeOnboardAgainDependencies) {
  const { pool } = deps;

  const holdsTerminateRight = (req: Request) =>
    roleCanPerformAction(req.userWithAccess?.role ?? req.user?.role, "hr.terminate_employee", "hr");

  /** The planned employment of a profile, with the names the profile page shows. */
  const plannedView = async (employeeId: string, userId: string | null) => {
    const [engagement] = await db.select().from(employeeEngagements)
      .where(and(eq(employeeEngagements.employeeId, employeeId), eq(employeeEngagements.status, "planned"))).limit(1);
    if (!engagement) return null;
    const [department] = await db.select({ id: departments.id, name: departments.name }).from(departments)
      .where(eq(departments.id, engagement.departmentId));
    const [branch] = await db.select({ id: branches.id, name: branches.name }).from(branches)
      .where(eq(branches.id, engagement.branchId));
    const [contract] = engagement.contractInstanceId
      ? await db.select({
        id: contractInstances.id,
        status: contractInstances.status,
        signingStatus: contractInstances.signingStatus,
        sentAt: contractInstances.sentAt,
        signedAt: contractInstances.signedAt,
      }).from(contractInstances).where(eq(contractInstances.id, engagement.contractInstanceId))
      : [];
    return {
      id: engagement.id,
      startDate: engagement.startDate,
      positionTitle: engagement.positionTitle,
      employmentBasis: engagement.employmentBasis,
      status: engagement.status,
      createdAt: engagement.createdAt,
      department: department ?? null,
      branch: branch ?? null,
      contract: contract ?? null,
      // The platform switched the sign-in off when the last contract ended:
      // a platform administrator reactivates it before the start date.
      platformSignInOff: await platformSignInSwitchedOff(userId),
    };
  };

  // ── Onboard Again ─────────────────────────────────────────────────────────

  app.get("/api/employees/:id/onboard-again", requireAuth, requireManager, async (req, res, next) => {
    try {
      const actor = req.userWithAccess;
      const employee = await deps.employeeOfParkGroup(req, req.params.id);
      if (!actor || !employee) return res.status(404).json({ message: "Employee not found" });
      if (!canUserAccessBranch(actor, employee.branchId)) return res.status(403).json({ message: "Access denied to this employee" });
      res.json({ engagement: await plannedView(employee.id, employee.userId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/employees/:id/onboard-again", requireAuth, requireManager, async (req, res, next) => {
    try {
      // Ending one contract and starting another is the termination right's (SCRUM-605).
      if (!holdsTerminateRight(req)) return res.status(403).json({ message: TERMINATE_RIGHT });
      const parsed = onboardAgainBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Validation failed", errors: parsed.error.errors });
      }
      const body = parsed.data;
      const actor = req.userWithAccess;
      const employee = await deps.employeeOfParkGroup(req, req.params.id);
      if (!actor || !employee) return res.status(404).json({ message: "Employee not found" });
      if (!canUserAccessBranch(actor, employee.branchId)) {
        return res.status(403).json({ message: "Access denied to this employee" });
      }
      const branchId = body.branchId ?? employee.branchId;
      if (!branchId) return res.status(400).json({ message: "Choose the branch of the new employment" });
      const [branch] = await db.select({ id: branches.id }).from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.tenantId, employee.tenantId)));
      if (!branch) return res.status(404).json({ message: "Branch not found" });
      if (!canUserAccessBranch(actor, branchId)) return res.status(403).json({ message: "Access denied to the selected branch" });
      const [department] = await db.select({ id: departments.id }).from(departments)
        .where(and(eq(departments.id, body.departmentId), eq(departments.tenantId, employee.tenantId)));
      if (!department) return res.status(404).json({ message: "Department not found" });

      // The new contract's template: the one named, or the one the profile's
      // latest contract was made from, as the wizard would be started with.
      let templateId = body.templateId ?? null;
      if (!templateId) {
        const [latest] = await db.select({ templateId: contractInstances.templateId }).from(contractInstances)
          .where(and(eq(contractInstances.employeeId, employee.id), isNull(contractInstances.archivedAt)))
          .orderBy(desc(contractInstances.createdAt)).limit(1);
        templateId = latest?.templateId ?? null;
      }
      const template = templateId ? await storage.getTemplateInParkGroup(templateId, employee.tenantId) : undefined;
      if (!template) {
        return res.status(400).json({ message: "Choose the contract template for the new contract" });
      }

      // The login switched back on (when it is off) is only one the app's
      // strict placement puts in the profile's park group, as offboarding
      // switches off only that one.
      const loginInParkGroup = !!employee.userId && (await deps.managedUserTenant(employee.userId)) === employee.tenantId;
      const today = bangkokToday();

      type Planned = {
        engagementId: string;
        contract: { id: string; status: string; signingStatus: string };
        activation: ActivationResult | null;
      };
      const done = await db.transaction(async (tx): Promise<Planned | { status: number; message: string }> => {
        // Offboarding's own per-employee lock, so a plan and an offboarding queue.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('employee_offboarding'), hashtext(${employee.id}))`);
        const [current] = await tx.select().from(employees)
          .where(and(eq(employees.id, employee.id), eq(employees.tenantId, employee.tenantId))).for("update");
        if (!current) return { status: 404, message: "Employee not found" };
        const [offboarding] = await tx.select({ id: employeeOffboarding.id, lastWorkingDay: employeeOffboarding.lastWorkingDay })
          .from(employeeOffboarding)
          .where(and(eq(employeeOffboarding.employeeId, current.id), isNull(employeeOffboarding.reonboardedAt)))
          .orderBy(desc(employeeOffboarding.createdAt)).limit(1);
        const lastDay = dayOf(offboarding?.lastWorkingDay) ?? dayOf(current.lastWorkingDay);
        if (!(offboarding && lastDay) && !isLeft(current.status)) {
          return { status: 409, message: "Onboard Again follows an offboarding: set the last working day of the current contract first" };
        }
        const [already] = await tx.select({ startDate: employeeEngagements.startDate }).from(employeeEngagements)
          .where(and(eq(employeeEngagements.employeeId, current.id), eq(employeeEngagements.status, "planned"))).limit(1);
        if (already) {
          return { status: 409, message: `An Onboard Again employment is already planned for this profile, from ${already.startDate}` };
        }
        if (lastDay && body.startDate <= lastDay) {
          return { status: 409, message: `The new start date must be after the last working day (${lastDay})` };
        }

        // The draft contract, made the way the wizard's "Save draft" makes it,
        // in the new department and branch, prefilled from the profile.
        const defaults = (current.defaultMergeData ?? {}) as Record<string, unknown>;
        const positionTitle = body.positionTitle ?? (typeof defaults.positionTitle === "string" ? defaults.positionTitle : "");
        const compiled = await deps.compileContractDraft(
          { ...current, primaryDepartmentId: body.departmentId, branchId },
          template,
          {
            positionTitle,
            salaryThb: defaults.salaryThb,
            startDate: body.startDate,
            incentiveClause: current.incentiveClauseText ?? undefined,
            customClauses: Array.isArray(defaults.customClauses) ? defaults.customClauses : [],
          },
          body.language ?? undefined,
        );
        const [contract] = await tx.insert(contractInstances).values({
          employeeId: current.id,
          templateId: template.id,
          templateSnapshotHtml: compiled.templateSnapshotHtml,
          templateSnapshotVersion: template.version,
          // The merge data as the wizard's draft stores it.
          mergeDataJson: compiled.enhancedMergeData as typeof contractInstances.$inferInsert.mergeDataJson,
          status: "draft",
          createdBy: actor.id,
          pdfPath: null,
          sentToEmail: null,
        }).returning();

        const [engagement] = await tx.insert(employeeEngagements).values({
          tenantId: current.tenantId,
          employeeId: current.id,
          startDate: body.startDate,
          departmentId: body.departmentId,
          branchId,
          positionTitle: body.positionTitle ?? null,
          employmentBasis: body.employmentBasis ?? null,
          contractInstanceId: contract!.id,
          offboardingId: offboarding?.id ?? null,
          status: "planned",
          createdBy: actor.id,
        }).returning();

        // The staff movement entry: the planned employment beside the offboarding.
        const departmentIds = [current.primaryDepartmentId, body.departmentId].filter((value): value is string => !!value);
        const knownDepartments = await tx.select({ id: departments.id }).from(departments)
          .where(and(eq(departments.tenantId, current.tenantId), inArray(departments.id, departmentIds)));
        const known = (value: string | null) => (value && knownDepartments.some((d) => d.id === value) ? value : null);
        const oldTitle = typeof defaults.positionTitle === "string" && defaults.positionTitle ? defaults.positionTitle : null;
        await storage.createEmployeeChange({
          employeeId: current.id,
          changeType: "onboard_again",
          effectiveDate: new Date(`${body.startDate}T00:00:00Z`),
          oldTitle,
          newTitle: positionTitle || oldTitle,
          oldBranchId: current.branchId,
          newBranchId: branchId,
          oldDepartmentId: known(current.primaryDepartmentId),
          newDepartmentId: known(body.departmentId),
          note: lastDay
            ? `Onboard again planned from ${body.startDate}; the current contract ends on its last working day ${lastDay}`
            : `Onboard again planned from ${body.startDate}`,
          contractGenerated: true,
          contractInstanceId: contract!.id,
          createdBy: actor.id,
        }, tx);
        await storage.logActivity({
          branchId: current.branchId || undefined,
          employeeId: current.id,
          contractInstanceId: contract!.id,
          activityType: "employee_updated",
          summaryText: `Onboard again planned: a new employment from ${body.startDate}, with a draft contract`,
          createdBy: actor.id,
        }, tx);

        // A start date of today or one already past starts it now; a later one
        // is the 03:00 batch's on its day.
        const activation = body.startDate <= today
          ? await activateEngagementWithin(tx, engagement!.id, { actorId: actor.id, loginInParkGroup: async () => loginInParkGroup })
          : null;
        return {
          engagementId: engagement!.id,
          contract: { id: contract!.id, status: contract!.status, signingStatus: contract!.signingStatus },
          activation,
        };
      });
      if ("message" in done) return res.status(done.status).json({ message: done.message });
      deps.committed(employee.id);
      const rematch: RematchAnswer | undefined = done.activation ? await rematchAfter(employee, req.user!.id) : undefined;
      res.status(201).json({
        engagementId: done.engagementId,
        startDate: body.startDate,
        contract: done.contract,
        started: !!done.activation,
        ...(done.activation ? {} : { platformSignInOff: await platformSignInSwitchedOff(employee.userId) }),
        ...(done.activation ? {
          login: done.activation.login,
          platformDeactivationDelivered: done.activation.platformDeactivationDelivered,
          rematch,
        } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/employees/:id/onboard-again/:engagementId", requireAuth, requireManager, async (req, res, next) => {
    try {
      if (!holdsTerminateRight(req)) return res.status(403).json({ message: TERMINATE_RIGHT });
      const actor = req.userWithAccess;
      const employee = await deps.employeeOfParkGroup(req, req.params.id);
      if (!actor || !employee) return res.status(404).json({ message: "Employee not found" });
      if (!canUserAccessBranch(actor, employee.branchId)) return res.status(403).json({ message: "Access denied to this employee" });
      const today = bangkokToday();
      const done = await db.transaction(async (tx): Promise<{ status: number; message: string } | { contractId: string | null; contractDeleted: boolean }> => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('employee_offboarding'), hashtext(${employee.id}))`);
        const [engagement] = await tx.select().from(employeeEngagements).where(and(
          eq(employeeEngagements.id, req.params.engagementId),
          eq(employeeEngagements.employeeId, employee.id),
          eq(employeeEngagements.status, "planned"),
        )).for("update");
        if (!engagement) return { status: 404, message: "Planned employment not found" };
        if (engagement.startDate <= today) {
          return { status: 409, message: "This employment has reached its start date, so it can no longer be cancelled" };
        }
        await tx.update(employeeEngagements).set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(employeeEngagements.id, engagement.id));
        // The plan's draft goes with it, as the app deletes a draft rather
        // than archiving it, so the profile reads as before the plan. A
        // contract that was finalized, sent or signed stays in its history.
        // The offboarding, the login and the shifts stay as they are.
        let contractDeleted = false;
        if (engagement.contractInstanceId) {
          const [draft] = await tx.select({ id: contractInstances.id }).from(contractInstances).where(and(
            eq(contractInstances.id, engagement.contractInstanceId),
            eq(contractInstances.employeeId, employee.id),
            eq(contractInstances.status, "draft"),
            eq(contractInstances.signingStatus, "not_sent"),
            isNull(contractInstances.signingToken),
            isNull(contractInstances.sentAt),
          )).for("update");
          if (draft) {
            await storage.deleteContract(draft.id, tx);
            contractDeleted = true;
          }
        }
        await storage.logActivity({
          branchId: employee.branchId || undefined,
          employeeId: employee.id,
          activityType: "employee_updated",
          summaryText: `Onboard again cancelled: the employment planned from ${engagement.startDate} will not start`
            + (contractDeleted ? "; its draft contract is deleted" : ""),
          createdBy: actor.id,
        }, tx);
        return { contractId: engagement.contractInstanceId, contractDeleted };
      });
      if ("message" in done) return res.status(done.status).json({ message: done.message });
      deps.committed(employee.id);
      res.json({ cancelled: true, contractId: done.contractId, contractDeleted: done.contractDeleted });
    } catch (error) {
      next(error);
    }
  });

  // ── Fold a duplicate into the original ───────────────────────────────────

  /** Both profiles in the caller's park group and branches; what the duplicate's delete may take. */
  const foldInput = async (req: Request, res: Response, write: boolean): Promise<FoldInput | null> => {
    const tenantId = await deps.userManagementTenant(req);
    const actor = req.userWithAccess;
    if (!tenantId || !actor) {
      res.status(403).json({ message: "Access denied" });
      return null;
    }
    if (req.params.id === req.params.targetId) {
      res.status(400).json({ message: "A profile cannot be folded into itself" });
      return null;
    }
    const duplicate = await storage.getEmployeeInTenant(req.params.id, tenantId);
    const target = await storage.getEmployeeInTenant(req.params.targetId, tenantId);
    if (!duplicate || !target) {
      res.status(404).json({ message: "Employee not found" });
      return null;
    }
    const outside = await deps.employeeDeleteOutsideParkGroup(duplicate, tenantId);
    if (outside) {
      res.status(404).json(outside);
      return null;
    }
    if (!canUserAccessBranch(actor, duplicate.branchId) || !canUserAccessBranch(actor, target.branchId)) {
      res.status(403).json({ message: "Both profiles must be in a branch you manage" });
      return null;
    }
    // The profile kept is the one the person signs in with. A face enrolment
    // moves with the fold when the profile kept has none (lib/employeeFold.ts).
    if (duplicate.userId && !target.userId) {
      res.status(409).json({
        message: "This profile holds the login and the one chosen does not. Fold the other way round: keep the profile the person signs in and scans their face with.",
      });
      return null;
    }
    // The duplicate's delete takes what the employee delete would take with
    // it, never the original's person record or login (a duplicate made with
    // the same email finds those by email).
    const own = await deps.employeeDeletionInput(duplicate, tenantId);
    const original = await deps.employeeDeletionInput(target, tenantId);
    const personId = own.personId && own.personId !== original.personId && own.personId !== target.personId ? own.personId : null;
    const leavingUserId = own.leavingUserId && own.leavingUserId !== original.leavingUserId && own.leavingUserId !== target.userId
      ? own.leavingUserId : null;
    return {
      duplicateId: duplicate.id,
      targetId: target.id,
      tenantId,
      deletion: { personId, leavingUserId },
      // The login a re-onboarding switches back on is only one the app's strict
      // placement puts in the park group, as Onboard Again's own door decides.
      loginInParkGroup: !!target.userId && (await deps.managedUserTenant(target.userId)) === tenantId,
      actorId: actor.id,
      write,
    };
  };

  const foldDoor = (write: boolean): RequestHandler => async (req, res, next) => {
    try {
      const input = await foldInput(req, res, write);
      if (!input) return;
      const outcome = await foldEmployeeInto(pool, input);
      if (!outcome.folded) {
        const { folded: _folded, status, ...refusal } = outcome;
        return res.status(status).json(refusal);
      }
      const answer = {
        moved: outcome.moved,
        skipped: outcome.skipped,
        face: outcome.face,
        supersededContracts: outcome.supersededContracts,
        replaced: outcome.replaced,
        clockedOnBoth: outcome.clockedOnBoth,
        orgChartMoved: outcome.orgChartMoved,
        orgChartDropped: outcome.orgChartDropped,
        reonboard: outcome.reonboard,
        deleted: outcome.deleted,
      };
      if (!write) return res.json(answer);
      deps.committed(input.targetId);
      // The folded profile's face leaves the face collection once the fold has
      // committed: the collection is outside the transaction, and a face whose
      // profile is gone must not be the one a scan matches.
      let faceRemovedFromCollection: boolean | undefined;
      if (outcome.faceToRemove) {
        try {
          // The face service's own removal, as a reset uses it: it matches nobody.
          faceRemovedFromCollection = await faceRecognitionService.deleteFace(outcome.faceToRemove);
        } catch {
          faceRemovedFromCollection = false;
        }
        if (!faceRemovedFromCollection) {
          console.warn(`[FOLD] The folded profile's face ${outcome.faceToRemove} could not be removed from the face collection`);
        }
      }
      const rematch = await rematchAfter({ id: input.targetId, tenantId: input.tenantId }, req.user!.id);
      res.json({ ...answer, ...(faceRemovedFromCollection === undefined ? {} : { faceRemovedFromCollection }), rematch });
    } catch (error) {
      next(error);
    }
  };

  const foldGate = [requireAuth, requireAdmin, requireAction("settings.delete_data", "settings")];
  app.get("/api/employees/:id/fold-into/:targetId/preview", ...foldGate, foldDoor(false));
  app.post("/api/employees/:id/fold-into/:targetId", ...foldGate, foldDoor(true));

  // ── Match stray approvals ────────────────────────────────────────────────

  app.post("/api/employees/:id/review/rematch", requireAuth, requireManager, async (req, res, next) => {
    try {
      const employee = await deps.employeeOfParkGroup(req, req.params.id);
      if (!employee) return res.status(404).json({ message: "Employee not found" });
      const counts = await rematchUnscheduledWork(pool, {
        tenantId: employee.tenantId,
        employeeId: employee.id,
        actorId: req.user!.id,
        branchIds: await reviewReach(req.user!.id),
      });
      res.json(counts);
    } catch (error) {
      next(error);
    }
  });
}
