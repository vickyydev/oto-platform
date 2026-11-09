import type { Express, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  branches,
  departments,
  employeeOffboarding,
  employees,
  employmentBasisTypes,
  loginLifecycleEvents,
  users,
  type Employee,
} from "@shared/schema";
import { roleCanPerformAction } from "@shared/permissions";
import { hrPayResponse } from "@shared/hr-salary-permission";
import { db } from "./db";
import { storage } from "./storage";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireAction, requireAdmin, requireManager } from "./auth-middleware";
import { foldEmployeeInto, type FoldInput } from "./lib/employeeFold";

/**
 * SCRUM-794: one person, two profiles. A staff member was offboarded, so her
 * original profile reads Left and its login was switched off, but she still
 * signs in and clocks in with it (the login was switched on again by hand, and
 * her face enrolment is on it); a second profile was made only to put her on
 * the rota in a new position, and carries her shifts, checklists and tasks.
 * Two doors put her back together:
 *
 *  - POST /api/employees/:id/rehire — the Left profile active again in its
 *    new position, its login back on;
 *  - POST /api/employees/:id/fold-into/:targetId (and GET .../preview) — the
 *    duplicate's assignments moved onto the original and the duplicate deleted.
 */

export interface EmployeeRehireDependencies {
  pool: Pool;
  employeeOfParkGroup: (req: Request, employeeId: string) => Promise<Employee | undefined>;
  userManagementTenant: (req: Request) => Promise<string | undefined>;
  managedUserTenant: (userId: string) => Promise<string | undefined>;
  employeeDeletionInput: (
    employee: Employee,
    tenantId: string,
  ) => Promise<{ employeeId: string; tenantId: string; personId: string | null; leavingUserId: string | null }>;
  employeeDeleteOutsideParkGroup: (employee: Employee, tenantId: string) => Promise<{ message: string } | null>;
  /** After a commit that changed an employee: the attention engine's trigger. */
  committed: (employeeId: string) => void;
}

const isLeft = (status: string | null | undefined) => status === "resigned" || status === "terminated";

const rehireBody = z.object({
  startDate: z.string().min(1, "Start date is required")
    .refine((value) => Number.isFinite(Date.parse(value)), "Start date is not a date"),
  positionTitle: z.string().trim().min(1).max(200).nullish(),
  departmentId: z.string().min(1).nullish(),
  branchId: z.string().min(1).nullish(),
  employmentBasis: z.enum(employmentBasisTypes).nullish(),
}).strict();

export function registerEmployeeRehireRoutes(app: Express, deps: EmployeeRehireDependencies) {
  const { pool } = deps;

  // ── Rehire ────────────────────────────────────────────────────────────────

  app.post("/api/employees/:id/rehire", requireAuth, requireManager, async (req, res, next) => {
    try {
      // Rehiring reverses offboarding, so it needs the right terminating needs (SCRUM-605).
      if (!roleCanPerformAction(req.userWithAccess?.role ?? req.user?.role, "hr.terminate_employee", "hr")) {
        return res.status(403).json({ message: "Rehiring an employee needs the hr.terminate_employee right" });
      }
      const parsed = rehireBody.safeParse(req.body ?? {});
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
      if (!isLeft(employee.status)) {
        return res.status(409).json({ message: "Only a profile that has left (resigned or terminated) can be rehired" });
      }
      if (body.branchId && body.branchId !== employee.branchId) {
        const [branch] = await db.select({ id: branches.id }).from(branches)
          .where(and(eq(branches.id, body.branchId), eq(branches.tenantId, employee.tenantId)));
        if (!branch) return res.status(404).json({ message: "Branch not found" });
        if (!canUserAccessBranch(actor, body.branchId)) {
          return res.status(403).json({ message: "Access denied to the selected branch" });
        }
      }
      if (body.departmentId) {
        const [department] = await db.select({ id: departments.id }).from(departments)
          .where(and(eq(departments.id, body.departmentId), eq(departments.tenantId, employee.tenantId)));
        if (!department) return res.status(404).json({ message: "Department not found" });
      }
      // The login switched back on is only one the app's strict placement puts
      // in the employee's park group, as offboarding switches off only that one.
      const loginInParkGroup = !!employee.userId && (await deps.managedUserTenant(employee.userId)) === employee.tenantId;
      const startDate = new Date(body.startDate);

      const done = await db.transaction(async (tx) => {
        // Offboarding's own per-employee lock, so a rehire and an offboarding queue.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('employee_offboarding'), hashtext(${employee.id}))`);
        const [current] = await tx.select().from(employees)
          .where(and(eq(employees.id, employee.id), eq(employees.tenantId, employee.tenantId))).for("update");
        if (!current || !isLeft(current.status)) return null;
        const [offboarding] = await tx.select({ id: employeeOffboarding.id, lastWorkingDay: employeeOffboarding.lastWorkingDay })
          .from(employeeOffboarding).where(eq(employeeOffboarding.employeeId, current.id)).limit(1);

        const oldTitle = current.defaultMergeData?.positionTitle || null;
        const updated = await storage.updateEmployee(current.id, {
          status: "active",
          employmentState: "ACTIVE",
          endReason: null,
          lastWorkingDay: null,
          noticeDate: null,
          startDate,
          ...(body.positionTitle ? { defaultMergeData: { ...(current.defaultMergeData ?? {}), positionTitle: body.positionTitle } } : {}),
          ...(body.departmentId ? { primaryDepartmentId: body.departmentId } : {}),
          ...(body.branchId ? { branchId: body.branchId } : {}),
          ...(body.employmentBasis ? { employmentBasis: body.employmentBasis } : {}),
          updatedBy: actor.id,
        }, tx);
        const branchChanged = (updated.branchId ?? null) !== (current.branchId ?? null);

        // The login, back on. The users trigger (migration 0031) supersedes a
        // deactivation still waiting for the platform: the same channel
        // offboarding's switch-off used, in reverse.
        let login: "reactivated" | "already_on" | "none" | "outside_park_group" = "none";
        let platformDeactivationDelivered = false;
        if (current.userId && !loginInParkGroup) login = "outside_park_group";
        else if (current.userId) {
          const [account] = await tx.select({ isActive: users.isActive }).from(users)
            .where(eq(users.id, current.userId)).for("update");
          if (account) {
            login = account.isActive ? "already_on" : "reactivated";
            await tx.update(users).set({
              isActive: true,
              ...(branchChanged ? { permissionReviewRequired: true } : {}),
              updatedAt: new Date(),
            }).where(eq(users.id, current.userId));
            const [last] = await tx.select({ state: loginLifecycleEvents.state }).from(loginLifecycleEvents)
              .where(eq(loginLifecycleEvents.userId, current.userId))
              .orderBy(desc(loginLifecycleEvents.createdAt)).limit(1);
            platformDeactivationDelivered = last?.state === "delivered";
          }
        }

        // The staff movement entry, which is also the offboarding's reversal:
        // the offboarding row has no state to mark, so it stays as the record.
        const departmentIds = [current.primaryDepartmentId, updated.primaryDepartmentId].filter((value): value is string => !!value);
        const knownDepartments = departmentIds.length === 0 ? [] : await tx.select({ id: departments.id }).from(departments)
          .where(and(eq(departments.tenantId, current.tenantId), inArray(departments.id, departmentIds)));
        const known = (value: string | null) => (value && knownDepartments.some((d) => d.id === value) ? value : null);
        const newTitle = body.positionTitle || oldTitle;
        const lastDay = offboarding?.lastWorkingDay ? offboarding.lastWorkingDay.toISOString().slice(0, 10) : null;
        const movement = await storage.createEmployeeChange({
          employeeId: current.id,
          changeType: "rehired",
          effectiveDate: startDate,
          oldTitle,
          newTitle,
          oldBranchId: current.branchId,
          newBranchId: updated.branchId,
          oldDepartmentId: known(current.primaryDepartmentId),
          newDepartmentId: known(updated.primaryDepartmentId),
          note: lastDay ? `Rehired; reverses the offboarding with last working day ${lastDay}` : "Rehired",
          contractGenerated: false,
          createdBy: actor.id,
        }, tx);
        await storage.logActivity({
          branchId: updated.branchId || undefined,
          employeeId: current.id,
          activityType: "employment_state_changed",
          summaryText: `Rehired${newTitle ? ` as ${newTitle}` : ""}: employment state changed from ${current.employmentState} to ACTIVE`,
          createdBy: actor.id,
        }, tx);
        return { updated, login, platformDeactivationDelivered, movementId: movement.id, offboardingId: offboarding?.id ?? null };
      });
      if (!done) return res.status(409).json({ message: "Only a profile that has left (resigned or terminated) can be rehired" });
      deps.committed(employee.id);
      res.json({
        employee: hrPayResponse(done.updated, req.userWithAccess ?? req.user),
        login: done.login,
        platformDeactivationDelivered: done.platformDeactivationDelivered,
        offboarding: done.offboardingId ? { id: done.offboardingId, reversal: "movement_log" } : null,
        movementId: done.movementId,
      });
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
      const answer = { moved: outcome.moved, skipped: outcome.skipped, deleted: outcome.deleted };
      if (!write) return res.json(answer);
      deps.committed(input.targetId);
      res.json(answer);
    } catch (error) {
      next(error);
    }
  };

  const foldGate = [requireAuth, requireAdmin, requireAction("settings.delete_data", "settings")];
  app.get("/api/employees/:id/fold-into/:targetId/preview", ...foldGate, foldDoor(false));
  app.post("/api/employees/:id/fold-into/:targetId", ...foldGate, foldDoor(true));
}
