import type { Express, RequestHandler } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { branches, employees, timeEntries, timekeepingIssues, type Employee } from "@shared/schema";
import type { db as appDb } from "./db";

interface ReviewDependencies {
  db: typeof appDb;
  requireAuth: RequestHandler;
  requireManager: RequestHandler;
  getUserBranchAccess: (userId: string) => Promise<{ accessScope: string; branchId: string | null }[]>;
  displayName: (employee: Employee) => string;
}

class ReviewRefusal extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function registerTimekeepingReviewRoutes(app: Express, dependencies: ReviewDependencies) {
  const { db, requireAuth, requireManager, getUserBranchAccess, displayName } = dependencies;
  app.get("/api/timekeeping/pending-issues", requireAuth, requireManager, async (req, res, next) => {
    try {
      const tenantId = req.userWithAccess?.tenantId;
      if (!tenantId) return res.status(403).json({ message: "Park group context required" });
      const access = await getUserBranchAccess(req.user!.id);
      const allBranches = access.some(row => row.accessScope === "all_branches");
      const branchIds = access.flatMap(row => row.branchId ? [row.branchId] : []);
      const selectedBranchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
      if (selectedBranchId && !allBranches && !branchIds.includes(selectedBranchId)) {
        return res.status(403).json({ message: "Access denied to selected branch" });
      }
      if (!allBranches && branchIds.length === 0) return res.json({ issues: [], count: 0 });

      const rows = await db.select({ issue: timekeepingIssues, employee: employees, branch: branches })
        .from(timekeepingIssues)
        .innerJoin(timeEntries, and(
          eq(timeEntries.id, timekeepingIssues.linkedTimeEntryId),
          eq(timeEntries.tenantId, tenantId),
          eq(timeEntries.employeeId, timekeepingIssues.employeeId),
          eq(timeEntries.branchId, timekeepingIssues.branchId),
          eq(timeEntries.status, "PENDING_APPROVAL"),
        ))
        .innerJoin(employees, and(eq(employees.id, timekeepingIssues.employeeId), eq(employees.tenantId, tenantId)))
        .innerJoin(branches, and(eq(branches.id, timekeepingIssues.branchId), eq(branches.tenantId, tenantId)))
        .where(and(
          eq(timekeepingIssues.tenantId, tenantId),
          eq(timekeepingIssues.status, "OPEN"),
          selectedBranchId ? eq(timekeepingIssues.branchId, selectedBranchId) : undefined,
          !allBranches ? inArray(timekeepingIssues.branchId, branchIds) : undefined,
        )).orderBy(desc(timekeepingIssues.issueDate));
      const issues = rows.map(({ issue, employee, branch }) => {
        const attachment = (issue as typeof issue & {
          attachment?: { fileName: string; mimeType: string; size: number } | null;
        }).attachment;
        return {
          ...issue,
          attachment: attachment ? { fileName: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size } : null,
          employeeName: displayName(employee),
          employeePhotoPath: employee.profilePhotoPath,
          branchName: branch.name,
        };
      });
      res.json({ issues, count: issues.length });
    } catch (error) { next(error); }
  });

  app.post("/api/timekeeping/issues/:issueId/resolve", requireAuth, requireManager, async (req, res, next) => {
    try {
      const { action, managerNote } = req.body;
      if (action !== "approve" && action !== "reject") {
        return res.status(400).json({ message: "Invalid action. Must be 'approve' or 'reject'" });
      }
      if (managerNote != null && typeof managerNote !== "string") {
        return res.status(400).json({ message: "Manager note must be text" });
      }
      const tenantId = req.userWithAccess?.tenantId;
      if (!tenantId) return res.status(403).json({ message: "Park group context required" });
      const actorId = req.user!.id;
      const access = await getUserBranchAccess(actorId);
      const allBranches = access.some(row => row.accessScope === "all_branches");
      const branchIds = access.flatMap(row => row.branchId ? [row.branchId] : []);
      const reviewed = await db.transaction(async tx => {
        const [issue] = await tx.select().from(timekeepingIssues).where(and(
          eq(timekeepingIssues.id, req.params.issueId), eq(timekeepingIssues.tenantId, tenantId),
        )).for("update");
        if (!issue) throw new ReviewRefusal(404, "Issue not found");
        if (!allBranches && !branchIds.includes(issue.branchId)) throw new ReviewRefusal(403, "Access denied");
        const [linked] = await tx.select({ entry: timeEntries, employee: employees })
          .from(timeEntries)
          .innerJoin(employees, and(eq(employees.id, timeEntries.employeeId), eq(employees.tenantId, tenantId)))
          .innerJoin(branches, and(eq(branches.id, timeEntries.branchId), eq(branches.tenantId, tenantId)))
          .where(and(
            eq(timeEntries.id, issue.linkedTimeEntryId ?? ""),
            eq(timeEntries.tenantId, tenantId), eq(timeEntries.employeeId, issue.employeeId),
            eq(timeEntries.branchId, issue.branchId),
          )).for("update", { of: timeEntries });
        if (!linked) throw new ReviewRefusal(404, "Time entry not found");
        const entryStatus = action === "approve" ? "APPROVED" : "REJECTED";
        const issueStatus = action === "approve" ? "RESOLVED" : "REJECTED";
        if (issue.status === issueStatus && linked.entry.status === entryStatus) {
          return { issue, employee: linked.employee };
        }
        if (issue.status !== "OPEN" || linked.entry.status !== "PENDING_APPROVAL") {
          throw new ReviewRefusal(409, "Issue is no longer pending review");
        }
        const now = new Date();
        await tx.update(timeEntries).set({
          status: entryStatus, approvedAt: action === "approve" ? now : null,
          approvedBy: action === "approve" ? actorId : null, updatedAt: now,
        }).where(eq(timeEntries.id, linked.entry.id));
        const [saved] = await tx.update(timekeepingIssues).set({
          status: issueStatus, resolvedAt: now, resolvedBy: actorId,
          resolutionNote: managerNote || null, updatedAt: now,
        }).where(eq(timekeepingIssues.id, issue.id)).returning();
        return { issue: saved, employee: linked.employee };
      });
      res.json({
        success: true,
        message: action === "approve" ? "Time entry approved" : "Time entry rejected",
        issue: {
          id: reviewed.issue.id, status: reviewed.issue.status,
          employeeName: displayName(reviewed.employee), resolvedAt: reviewed.issue.resolvedAt,
        },
      });
    } catch (error) {
      if (error instanceof ReviewRefusal) return res.status(error.status).json({ message: error.message });
      next(error);
    }
  });
}
