import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "./db";
import { casualWorkers, branches, departments, roles, type UserWithBranchAccess } from "@shared/schema";
import { eq, and, desc, lte, gte, or, inArray } from "drizzle-orm";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireManager } from "./auth-middleware";

const router = Router();

function requestScope(req: Request, res: Response): { user: UserWithBranchAccess; tenantId: string } | null {
  const user = req.userWithAccess;
  if (!user?.tenantId) {
    res.status(403).json({ message: "Tenant access is not configured" });
    return null;
  }
  return { user, tenantId: user.tenantId };
}

async function validBranch(user: UserWithBranchAccess, tenantId: string, branchId: string) {
  if (!canUserAccessBranch(user, branchId)) return false;
  const [branch] = await db.select({ tenantId: branches.tenantId }).from(branches)
    .where(eq(branches.id, branchId)).limit(1);
  return branch?.tenantId === tenantId;
}

async function validReferences(
  user: UserWithBranchAccess,
  tenantId: string,
  branchId: string,
  departmentId: string,
  roleId: string,
) {
  if (!(await validBranch(user, tenantId, branchId))) return false;
  const [[department], [role]] = await Promise.all([
    db.select({ tenantId: departments.tenantId }).from(departments)
      .where(eq(departments.id, departmentId)).limit(1),
    db.select({ tenantId: roles.tenantId }).from(roles)
      .where(eq(roles.id, roleId)).limit(1),
  ]);
  return department?.tenantId === tenantId && role?.tenantId === tenantId;
}

async function scopedWorker(id: string, user: UserWithBranchAccess, tenantId: string) {
  const [worker] = await db.select().from(casualWorkers)
    .where(and(eq(casualWorkers.id, id), eq(casualWorkers.tenantId, tenantId))).limit(1);
  if (!worker || !(await validBranch(user, tenantId, worker.branchId))) return null;
  return worker;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const dateSchema = z.string().refine(validDate, "Use a valid YYYY-MM-DD date");
const createSchema = z.object({
  fullName: z.string().trim().min(1),
  nickname: z.string().trim().min(1),
  jobTitle: z.string().trim().optional().nullable(),
  branchId: z.string().min(1),
  departmentId: z.string().min(1),
  roleId: z.string().min(1),
  startDate: dateSchema,
  endDate: dateSchema,
  dailyRate: z.number().int().positive(),
});
const updateSchema = createSchema.partial().extend({
  status: z.enum(["active", "inactive", "expired"]).optional(),
});

router.get("/casual-workers", requireAuth, requireManager, async (req, res, next) => {
  try {
    const scope = requestScope(req, res);
    if (!scope) return;
    const { user, tenantId } = scope;
    const { branchId, departmentId, status, includeExpired } = req.query;
    if ([branchId, departmentId, status, includeExpired].some(value => value !== undefined && typeof value !== "string") ||
        (status && !["all", "active", "inactive", "expired"].includes(status as string)) ||
        (includeExpired && !["true", "false"].includes(includeExpired as string))) {
      return res.status(400).json({ message: "Invalid casual-worker filter" });
    }
    if (branchId && branchId !== "all" && !(await validBranch(user, tenantId, branchId as string))) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }
    if (departmentId && departmentId !== "all") {
      const [department] = await db.select({ tenantId: departments.tenantId }).from(departments)
        .where(eq(departments.id, departmentId as string)).limit(1);
      if (department?.tenantId !== tenantId) {
        return res.status(404).json({ message: "Department not found" });
      }
    }
    if (!user.hasAllBranchesAccess && user.allowedBranchIds.length === 0) return res.json([]);

    const conditions = [eq(casualWorkers.tenantId, tenantId)];
    if (!user.hasAllBranchesAccess) conditions.push(inArray(casualWorkers.branchId, user.allowedBranchIds));
    if (branchId && branchId !== "all") conditions.push(eq(casualWorkers.branchId, branchId as string));
    if (departmentId && departmentId !== "all") conditions.push(eq(casualWorkers.departmentId, departmentId as string));
    if (status && status !== "all") {
      conditions.push(eq(casualWorkers.status, status as "active" | "inactive" | "expired"));
    } else if (includeExpired !== "true") {
      conditions.push(or(eq(casualWorkers.status, "active"), eq(casualWorkers.status, "inactive"))!);
    }

    const results = await db.select({
      worker: casualWorkers,
      branch: { id: branches.id, name: branches.name },
      department: { id: departments.id, name: departments.name },
      role: { id: roles.id, name: roles.name },
    }).from(casualWorkers)
      .innerJoin(branches, and(eq(casualWorkers.branchId, branches.id), eq(branches.tenantId, tenantId)))
      .leftJoin(departments, and(eq(casualWorkers.departmentId, departments.id), eq(departments.tenantId, tenantId)))
      .leftJoin(roles, and(eq(casualWorkers.roleId, roles.id), eq(roles.tenantId, tenantId)))
      .where(and(...conditions)).orderBy(desc(casualWorkers.createdAt));
    res.json(results.map(row => ({ ...row.worker, branch: row.branch, department: row.department, role: row.role })));
  } catch (error) {
    next(error);
  }
});

router.get("/casual-workers/for-scheduling", requireAuth, requireManager, async (req, res, next) => {
  try {
    const scope = requestScope(req, res);
    if (!scope) return;
    const { user, tenantId } = scope;
    const { branchId, date, startDate, endDate } = req.query;
    if (typeof branchId !== "string" || !(await validBranch(user, tenantId, branchId))) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }
    const hasDay = typeof date === "string" && validDate(date) && !startDate && !endDate;
    const hasRange = typeof startDate === "string" && typeof endDate === "string" &&
      validDate(startDate) && validDate(endDate) && startDate <= endDate && !date;
    if (!hasDay && !hasRange) {
      return res.status(400).json({ message: "Valid date or date range is required" });
    }
    const from = typeof date === "string" ? date : startDate as string;
    const to = typeof date === "string" ? date : endDate as string;
    const results = await db.select({
      worker: casualWorkers,
      role: { id: roles.id, name: roles.name },
      department: { id: departments.id, name: departments.name },
    }).from(casualWorkers)
      .leftJoin(roles, and(eq(casualWorkers.roleId, roles.id), eq(roles.tenantId, tenantId)))
      .leftJoin(departments, and(eq(casualWorkers.departmentId, departments.id), eq(departments.tenantId, tenantId)))
      .where(and(
        eq(casualWorkers.tenantId, tenantId),
        eq(casualWorkers.branchId, branchId),
        eq(casualWorkers.status, "active"),
        lte(casualWorkers.startDate, to),
        gte(casualWorkers.endDate, from),
      )).orderBy(casualWorkers.nickname);
    res.json(results.map(row => ({ ...row.worker, role: row.role, department: row.department })));
  } catch (error) {
    next(error);
  }
});

router.get("/casual-workers/:id", requireAuth, requireManager, async (req, res, next) => {
  try {
    const scope = requestScope(req, res);
    if (!scope) return;
    const worker = await scopedWorker(req.params.id, scope.user, scope.tenantId);
    if (!worker) return res.status(404).json({ message: "Casual worker not found" });
    const [[branch], [department], [role]] = await Promise.all([
      db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.id, worker.branchId)).limit(1),
      db.select({ id: departments.id, name: departments.name }).from(departments)
        .where(and(eq(departments.id, worker.departmentId), eq(departments.tenantId, scope.tenantId))).limit(1),
      db.select({ id: roles.id, name: roles.name }).from(roles)
        .where(and(eq(roles.id, worker.roleId), eq(roles.tenantId, scope.tenantId))).limit(1),
    ]);
    res.json({ ...worker, branch, department, role });
  } catch (error) {
    next(error);
  }
});

router.post("/casual-workers", requireAuth, requireManager, async (req, res, next) => {
  try {
    const scope = requestScope(req, res);
    if (!scope) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid casual worker" });
    const data = parsed.data;
    if (data.endDate < data.startDate) {
      return res.status(400).json({ message: "End date must be on or after start date" });
    }
    if (!(await validReferences(scope.user, scope.tenantId, data.branchId, data.departmentId, data.roleId))) {
      return res.status(400).json({ message: "Invalid branch, department or role" });
    }
    const [created] = await db.insert(casualWorkers).values({
      ...data, tenantId: scope.tenantId, jobTitle: data.jobTitle || null,
      rateType: "daily", status: "active", createdBy: scope.user.id,
    }).returning();
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

router.patch("/casual-workers/:id", requireAuth, requireManager, async (req, res, next) => {
  try {
    const scope = requestScope(req, res);
    if (!scope) return;
    const existing = await scopedWorker(req.params.id, scope.user, scope.tenantId);
    if (!existing) return res.status(404).json({ message: "Casual worker not found" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid casual worker" });
    const data = parsed.data;
    const startDate = data.startDate ?? existing.startDate;
    const endDate = data.endDate ?? existing.endDate;
    if (endDate < startDate) return res.status(400).json({ message: "End date must be on or after start date" });
    if (!(await validReferences(scope.user, scope.tenantId,
      data.branchId ?? existing.branchId, data.departmentId ?? existing.departmentId,
      data.roleId ?? existing.roleId))) {
      return res.status(400).json({ message: "Invalid branch, department or role" });
    }
    const [updated] = await db.update(casualWorkers).set({ ...data, updatedAt: new Date() })
      .where(and(eq(casualWorkers.id, req.params.id), eq(casualWorkers.tenantId, scope.tenantId))).returning();
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post("/casual-workers/:id/deactivate", requireAuth, requireManager, async (req, res, next) => {
  try {
    const scope = requestScope(req, res);
    if (!scope) return;
    const existing = await scopedWorker(req.params.id, scope.user, scope.tenantId);
    if (!existing) return res.status(404).json({ message: "Casual worker not found" });
    const [updated] = await db.update(casualWorkers).set({ status: "inactive", updatedAt: new Date() })
      .where(and(eq(casualWorkers.id, req.params.id), eq(casualWorkers.tenantId, scope.tenantId))).returning();
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete("/casual-workers/:id", requireAuth, requireManager, async (req, res, next) => {
  try {
    const scope = requestScope(req, res);
    if (!scope) return;
    const existing = await scopedWorker(req.params.id, scope.user, scope.tenantId);
    if (!existing) return res.status(404).json({ message: "Casual worker not found" });
    await db.delete(casualWorkers)
      .where(and(eq(casualWorkers.id, req.params.id), eq(casualWorkers.tenantId, scope.tenantId)));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
