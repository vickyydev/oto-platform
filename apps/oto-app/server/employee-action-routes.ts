import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { branches, contractInstances, departments, employeeActionReceipts, employeeChanges, employees, users, type ActivityType, type Employee } from "@shared/schema";
import { db } from "./db";
import { storage, type DbExecutor } from "./storage";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireManager } from "./auth-middleware";

type Result = { status: number; body: unknown };
type Action = (req: Request, employee: Employee, tx: DbExecutor) => Promise<Result>;
const answer = (status: number, body: unknown): Result => ({ status, body });
const failure = (status: number, message: string) => answer(status, { message });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

/** The employee lock covers the current values and every effect. Receipts are
 * private: ordinary history readers never receive response snapshots or keys.
 * Old clients can omit requestId; their explicit actions still work atomically. */
function managerAction(name: string, fields: string[], action: Action, afterCommit?: (employeeId: string) => void): RequestHandler {
  return async (req, res, next) => {
    try {
      const actor = req.userWithAccess;
      if (!actor?.tenantId) { res.status(403).json({ message: "Park context is required" }); return; }
      const employeeId = req.params.employeeId || req.params.id;
      const supplied = req.body?.requestId;
      if (supplied !== undefined && !z.string().uuid().safeParse(supplied).success) {
        res.status(400).json({ message: "Invalid request ID" }); return;
      }
      const requestId = supplied ?? randomUUID();
      const payload = Object.fromEntries(fields.map(key => [key, req.body?.[key]]));
      const payloadHash = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
      let committed = false;
      const result = await db.transaction(async tx => {
        // Serialize a reused key even when a caller substitutes another employee.
        await tx.execute(sql`select pg_advisory_xact_lock(516, hashtext(${requestId}))`);
        const [employee] = await tx.select().from(employees)
          .where(and(eq(employees.id, employeeId), eq(employees.tenantId, actor.tenantId!))).for("update");
        if (!employee) return failure(404, "Employee not found");
        const [receipt] = await tx.select().from(employeeActionReceipts).where(eq(employeeActionReceipts.id, requestId));
        if (receipt) {
          if (receipt.employeeId !== employee.id || receipt.tenantId !== actor.tenantId || receipt.actorId !== actor.id || receipt.action !== name || receipt.payloadHash !== payloadHash) {
            return failure(409, "Request ID already belongs to another action");
          }
          // Transfers retain their branch permission checks when returning a receipt.
          if (name === "transfer" && (!canUserAccessBranch(actor, employee.branchId) || receipt.responseBody.branchIds.some(id => !canUserAccessBranch(actor, id)))) return failure(403, "You do not have access to this employee branch");
          return answer(receipt.responseStatus, receipt.responseBody.result);
        }
        const outcome = await action(req, employee, tx);
        if (outcome.status >= 400) return outcome;
        await tx.insert(employeeActionReceipts).values({ id: requestId, tenantId: actor.tenantId!, employeeId: employee.id,
          actorId: actor.id, action: name, payloadHash, responseStatus: outcome.status,
          responseBody: { result: JSON.parse(JSON.stringify(outcome.body)), branchIds: name === "transfer" ? [employee.branchId, req.body.newBranchId].filter((id): id is string => typeof id === "string") : [] } });
        committed = true;
        return outcome;
      });
      if (committed) afterCommit?.(employeeId);
      res.status(result.status).json(result.body);
    } catch (error) { next(error); }
  };
}

export function registerEmployeeActionRoutes(app: Express, options: {
  attentionWritesReady: boolean;
  displayName: (employee: Employee) => string;
  reviewCommitted: (employeeId: string) => void;
}) {
  const { attentionWritesReady, displayName } = options;
  app.post("/api/employees/:id/complete-probation-review", requireAuth, requireManager,
    managerAction("complete-review", [], async (req, employee, tx) => {
      const updated = await storage.updateEmployee(employee.id, { probationReviewCompletedAt: new Date() }, tx);
      if (attentionWritesReady) {
        await storage.deleteAttentionItemsByType("PROBATION_REVIEW_DUE_SOON", employee.id, tx);
        await storage.deleteAttentionItemsByType("PROBATION_REVIEW_OVERDUE", employee.id, tx);
      }
      await storage.createActivityLog({ branchId: employee.branchId || null, employeeId: employee.id,
        contractInstanceId: null, activityType: "probation_completed",
        summaryText: `Probation review completed for ${displayName(employee)}`, createdBy: req.userWithAccess!.id }, tx);
      return answer(200, updated);
    }, options.reviewCommitted));

  app.post("/api/employees/:employeeId/changes", requireAuth, requireManager,
    managerAction("change-terms", ["changeType", "effectiveDate", "newTitle", "newSalary", "newIncentiveClause", "newBranchId", "note"], async (req, employee, tx) => {
      const { changeType, effectiveDate, newTitle, newSalary, newIncentiveClause, newBranchId, note } = req.body;
      if (!["salary_adjustment", "title_change", "incentive_change", "branch_transfer"].includes(changeType)) return failure(400, "Invalid change type");
      if (!effectiveDate) return failure(400, "Effective date is required");
      if (!Number.isFinite(new Date(effectiveDate).getTime())) return failure(400, "Invalid effective date");
      if (changeType === "salary_adjustment" && (newSalary === undefined || newSalary === null || typeof newSalary !== "number")) return failure(400, "New salary is required for salary adjustments");
      if (changeType === "title_change" && (!newTitle || typeof newTitle !== "string" || newTitle.trim() === "")) return failure(400, "New title is required for title changes");
      if (changeType === "branch_transfer" && (!newBranchId || typeof newBranchId !== "string")) return failure(400, "New branch is required for branch transfers");
      if (typeof newBranchId === "string" && newBranchId !== "") {
        const [branch] = await tx.select().from(branches).where(and(eq(branches.id, newBranchId), eq(branches.tenantId, employee.tenantId)));
        if (!branch) return failure(404, "Branch not found");
      }
      const oldTitle = employee.defaultMergeData?.positionTitle || null;
      const oldSalary = employee.defaultMergeData?.salaryThb || null;
      const oldIncentiveClause = employee.incentiveClauseText || null;
      const oldBranchId = employee.branchId || null;
      const change = await storage.createEmployeeChange({ employeeId: employee.id, changeType,
        effectiveDate: new Date(effectiveDate), oldTitle, oldSalary, oldIncentiveClause, oldBranchId,
        newTitle: newTitle || oldTitle, newSalary: newSalary || oldSalary,
        newIncentiveClause: newIncentiveClause || oldIncentiveClause, newBranchId: newBranchId || oldBranchId,
        note, contractGenerated: false, createdBy: req.userWithAccess!.id }, tx);
      const updates: Partial<Employee> = {};
      if (changeType === "salary_adjustment" && newSalary) updates.defaultMergeData = { ...employee.defaultMergeData, salaryThb: newSalary };
      if (changeType === "title_change" && newTitle) updates.defaultMergeData = { ...employee.defaultMergeData, positionTitle: newTitle };
      if (changeType === "incentive_change") {
        updates.incentiveClauseText = newIncentiveClause;
        updates.defaultMergeData = { ...employee.defaultMergeData, incentiveClause: newIncentiveClause };
      }
      if (changeType === "branch_transfer" && newBranchId) updates.branchId = newBranchId;
      if (Object.keys(updates).length) await storage.updateEmployee(employee.id, updates, tx);
      const activityTypes: Record<string, ActivityType> = { salary_adjustment: "salary_change", title_change: "promotion", incentive_change: "incentive_change", branch_transfer: "branch_transfer" };
      const summaries: Record<string, string> = {
        salary_adjustment: `${displayName(employee)} salary changed from ?${oldSalary?.toLocaleString() || 0} to ?${newSalary?.toLocaleString() || 0}`,
        title_change: `${displayName(employee)} position changed from "${oldTitle || 'N/A'}" to "${newTitle}"`,
        incentive_change: `${displayName(employee)} incentive clause updated`, branch_transfer: `${displayName(employee)} transferred to new branch`,
      };
      await storage.createActivityLog({ branchId: employee.branchId || null, employeeId: employee.id, contractInstanceId: null,
        activityType: activityTypes[changeType], summaryText: summaries[changeType], createdBy: req.userWithAccess!.id }, tx);
      if (attentionWritesReady) await storage.createAttentionItem({ tenantId: employee.tenantId, type: "CHANGE_NO_CONTRACT", severity: "medium",
        employeeId: employee.id, branchId: employee.branchId || null, title: "Employment terms changed - no updated contract",
        description: `${employee.fullName}'s ${changeType.replace("_", " ")} requires a new contract` }, tx);
      return answer(201, change);
    }));

  app.patch("/api/employees/:employeeId/changes/:changeId", requireAuth, requireManager, async (req, res, next) => {
    try {
      const tenantId = req.userWithAccess?.tenantId;
      if (!tenantId) { res.status(403).json({ message: "Park context is required" }); return; }
      const parsed = z.object({ contractGenerated: z.boolean().optional(), contractInstanceId: z.string().min(1).nullable().optional() }).strict().safeParse(req.body);
      if (!parsed.success || !Object.keys(parsed.data).length) { res.status(400).json({ message: "Only contract status and contract link can be updated" }); return; }
      const result = await db.transaction(async tx => {
        const [employee] = await tx.select().from(employees).where(and(eq(employees.id, req.params.employeeId), eq(employees.tenantId, tenantId))).for("update");
        if (!employee) return failure(404, "Employee not found");
        const [change] = await tx.select().from(employeeChanges).where(and(eq(employeeChanges.id, req.params.changeId), eq(employeeChanges.employeeId, employee.id))).for("update");
        if (!change) return failure(404, "Change not found");
        if (parsed.data.contractInstanceId) {
          const [contract] = await tx.select().from(contractInstances).where(and(eq(contractInstances.id, parsed.data.contractInstanceId), eq(contractInstances.employeeId, employee.id)));
          if (!contract) return failure(404, "Contract not found");
        }
        const [updated] = await tx.update(employeeChanges).set(parsed.data).where(eq(employeeChanges.id, change.id)).returning();
        return answer(200, updated);
      });
      res.status(result.status).json(result.body);
    } catch (error) { next(error); }
  });

  app.post("/api/employees/:employeeId/transfer", requireAuth, requireManager,
    managerAction("transfer", ["effectiveDate", "newBranchId", "newDepartmentId", "note"], async (req, employee, tx) => {
      const actor = req.userWithAccess!;
      const { effectiveDate, newBranchId, newDepartmentId, note } = req.body;
      if (!effectiveDate) return failure(400, "Effective date is required");
      if (!newBranchId) return failure(400, "New branch is required");
      const effectiveDateObj = new Date(effectiveDate), todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      if (!Number.isFinite(effectiveDateObj.getTime())) return failure(400, "Invalid effective date");
      if (effectiveDateObj < todayStart) return failure(400, "Effective date cannot be in the past");
      if (newBranchId === employee.branchId && (!newDepartmentId || newDepartmentId === employee.primaryDepartmentId)) return failure(400, "No changes detected. Select a different branch or department.");
      const [newBranch] = await tx.select().from(branches).where(and(eq(branches.id, newBranchId), eq(branches.tenantId, employee.tenantId)));
      if (!newBranch) return failure(400, "Invalid destination branch");
      if (!canUserAccessBranch(actor, employee.branchId) || !canUserAccessBranch(actor, newBranchId)) return failure(403, "You do not have access to both branches");
      const [newDepartment] = newDepartmentId ? await tx.select().from(departments).where(and(eq(departments.id, newDepartmentId), eq(departments.tenantId, employee.tenantId))) : [];
      if (newDepartmentId && !newDepartment) return failure(400, "Invalid destination department");
      const oldBranchId = employee.branchId, oldDepartmentId = employee.primaryDepartmentId;
      const [oldBranch] = oldBranchId ? await tx.select().from(branches).where(eq(branches.id, oldBranchId)) : [];
      const [oldDepartment] = oldDepartmentId ? await tx.select().from(departments).where(eq(departments.id, oldDepartmentId)) : [];
      const effectiveDateStr = effectiveDateObj.toISOString().split("T")[0];
      await storage.createEmployeeChange({ employeeId: employee.id, changeType: "branch_transfer", effectiveDate: effectiveDateObj,
        oldBranchId, newBranchId, oldDepartmentId, newDepartmentId: newDepartmentId || null,
        note: note || `Transfer from ${oldBranch?.name || 'Unknown'} to ${newBranch.name}`, contractGenerated: false, createdBy: actor.id }, tx);
      await storage.updateEmployee(employee.id, { branchId: newBranchId, primaryDepartmentId: newDepartmentId || null }, tx);
      const futureEndDate = new Date(); futureEndDate.setFullYear(futureEndDate.getFullYear() + 1);
      const deletedAssignments = await storage.deleteAssignmentsByEmployeeAndDateRange(employee.id, effectiveDateStr, futureEndDate.toISOString().split("T")[0], tx);
      const deletedTimeOff = oldBranchId ? await storage.deleteTimeOffByEmployeeAndDateRange(employee.id, oldBranchId, effectiveDateStr, tx) : [];
      if (employee.userId) {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, employee.userId)).for("update");
        await storage.setUserBranchAccess(employee.userId, "selected_branches", [newBranchId], employee.tenantId, tx);
      }
      await storage.createActivityLog({ branchId: newBranchId, employeeId: employee.id, contractInstanceId: null, activityType: "branch_transfer",
        summaryText: `${displayName(employee)} permanently transferred from ${oldBranch?.name || 'Unknown'} to ${newBranch.name}${newDepartment ? ` (${newDepartment.name})` : ''}`, createdBy: actor.id }, tx);
      if (attentionWritesReady) await storage.createAttentionItem({ tenantId: employee.tenantId, type: "CHANGE_NO_CONTRACT", severity: "medium", employeeId: employee.id,
        branchId: newBranchId, title: "Employee transferred - contract update needed",
        description: `${employee.fullName} was transferred to ${newBranch.name}. An updated employment contract may be required.` }, tx);
      return answer(200, { success: true, message: "Employee transferred successfully", deletedAssignments: deletedAssignments.length, deletedTimeOff: deletedTimeOff.length,
        transfer: { employeeId: employee.id, employeeName: employee.fullName, effectiveDate: effectiveDateStr,
          fromBranch: oldBranch?.name || null, toBranch: newBranch.name, fromDepartment: oldDepartment?.name || null, toDepartment: newDepartment?.name || null } });
    }));
}
