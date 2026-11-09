import type { Express, Request } from "express";
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
import { canUserAccessBranch, requireManager } from "./auth-middleware";

/**
 * SCRUM-794: one person, two profiles. A staff member was offboarded, so her
 * original profile reads Left and its login was switched off, but she still
 * signs in and clocks in with it (the login was switched on again by hand, and
 * her face enrolment is on it); a second profile was made only to put her on
 * the rota in a new position, and carries her shifts, checklists and tasks.
 *
 *  - POST /api/employees/:id/rehire — the Left profile active again in its
 *    new position, its login back on.
 */

export interface EmployeeRehireDependencies {
  employeeOfParkGroup: (req: Request, employeeId: string) => Promise<Employee | undefined>;
  managedUserTenant: (userId: string) => Promise<string | undefined>;
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
}
