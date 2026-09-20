import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db } from "./db";
import { casualWorkers, branches, departments, roles, tenants, insertCasualWorkerSchema, DEFAULT_TENANT_SLUG } from "@shared/schema";
import { eq, and, desc, lte, gte, or } from "drizzle-orm";
import { requireAuth } from "./auth";
import { requireManager } from "./auth-middleware";

const router = Router();

async function getDefaultTenantId(): Promise<string> {
  const result = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  if (result.length > 0) {
    return result[0].id;
  }
  const anyTenant = await db
    .select({ id: tenants.id })
    .from(tenants)
    .limit(1);
  if (anyTenant.length > 0) {
    return anyTenant[0].id;
  }
  throw new Error("No tenant found");
}

router.get("/casual-workers", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { branchId, departmentId, status, includeExpired } = req.query;
    const tenantId = await getDefaultTenantId();

    const conditions = [eq(casualWorkers.tenantId, tenantId)];

    if (branchId && branchId !== "all") {
      conditions.push(eq(casualWorkers.branchId, branchId as string));
    }

    if (departmentId && departmentId !== "all") {
      conditions.push(eq(casualWorkers.departmentId, departmentId as string));
    }

    if (status && status !== "all") {
      conditions.push(eq(casualWorkers.status, status as "active" | "inactive" | "expired"));
    } else if (includeExpired !== "true") {
      conditions.push(or(
        eq(casualWorkers.status, "active"),
        eq(casualWorkers.status, "inactive")
      )!);
    }

    const results = await db
      .select({
        worker: casualWorkers,
        branch: {
          id: branches.id,
          name: branches.name,
        },
        department: {
          id: departments.id,
          name: departments.name,
        },
        role: {
          id: roles.id,
          name: roles.name,
        },
      })
      .from(casualWorkers)
      .leftJoin(branches, eq(casualWorkers.branchId, branches.id))
      .leftJoin(departments, eq(casualWorkers.departmentId, departments.id))
      .leftJoin(roles, eq(casualWorkers.roleId, roles.id))
      .where(and(...conditions))
      .orderBy(desc(casualWorkers.createdAt));

    const workers = results.map(r => ({
      ...r.worker,
      branch: r.branch,
      department: r.department,
      role: r.role,
    }));

    res.json(workers);
  } catch (error) {
    next(error);
  }
});

router.get("/casual-workers/for-scheduling", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { branchId, date, startDate, endDate } = req.query;
    const tenantId = await getDefaultTenantId();

    if (!branchId) {
      return res.status(400).json({ message: "branchId is required" });
    }

    const conditions = [
      eq(casualWorkers.tenantId, tenantId),
      eq(casualWorkers.branchId, branchId as string),
      eq(casualWorkers.status, "active"),
    ];

    // Support date range for employee view (casual workers whose contract overlaps the visible period)
    if (startDate && endDate) {
      // Overlap condition: worker.startDate <= endDate AND worker.endDate >= startDate
      conditions.push(lte(casualWorkers.startDate, endDate as string));
      conditions.push(gte(casualWorkers.endDate, startDate as string));
    } else if (date) {
      // Single date for shift assignment (existing behavior)
      conditions.push(lte(casualWorkers.startDate, date as string));
      conditions.push(gte(casualWorkers.endDate, date as string));
    }

    const results = await db
      .select({
        worker: casualWorkers,
        role: {
          id: roles.id,
          name: roles.name,
        },
        department: {
          id: departments.id,
          name: departments.name,
        },
      })
      .from(casualWorkers)
      .leftJoin(roles, eq(casualWorkers.roleId, roles.id))
      .leftJoin(departments, eq(casualWorkers.departmentId, departments.id))
      .where(and(...conditions))
      .orderBy(casualWorkers.nickname);

    const workers = results.map(r => ({
      ...r.worker,
      role: r.role,
      department: r.department,
    }));

    res.json(workers);
  } catch (error) {
    next(error);
  }
});

router.get("/casual-workers/:id", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [result] = await db
      .select({
        worker: casualWorkers,
        branch: {
          id: branches.id,
          name: branches.name,
        },
        department: {
          id: departments.id,
          name: departments.name,
        },
        role: {
          id: roles.id,
          name: roles.name,
        },
      })
      .from(casualWorkers)
      .leftJoin(branches, eq(casualWorkers.branchId, branches.id))
      .leftJoin(departments, eq(casualWorkers.departmentId, departments.id))
      .leftJoin(roles, eq(casualWorkers.roleId, roles.id))
      .where(and(eq(casualWorkers.id, id), eq(casualWorkers.tenantId, tenantId)));

    if (!result) {
      return res.status(404).json({ message: "Casual worker not found" });
    }

    res.json({
      ...result.worker,
      branch: result.branch,
      department: result.department,
      role: result.role,
    });
  } catch (error) {
    next(error);
  }
});

const createCasualWorkerSchema = z.object({
  fullName: z.string().min(1, "Full name is required"),
  nickname: z.string().min(1, "Nickname is required"),
  jobTitle: z.string().optional().nullable(),
  branchId: z.string().min(1, "Branch is required"),
  departmentId: z.string().min(1, "Department is required"),
  roleId: z.string().min(1, "Role is required"),
  startDate: z.string().min(1, "Start date is required"),
  endDate: z.string().min(1, "End date is required"),
  dailyRate: z.number().positive("Daily rate must be positive"),
});

router.post("/casual-workers", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = await getDefaultTenantId();
    const userId = (req.user as any)?.id;

    const parsed = createCasualWorkerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ 
        message: "Validation failed", 
        errors: parsed.error.errors 
      });
    }

    const data = parsed.data;
    if (new Date(data.endDate) < new Date(data.startDate)) {
      return res.status(400).json({ message: "End date must be after start date" });
    }

    const [created] = await db
      .insert(casualWorkers)
      .values({
        tenantId,
        fullName: data.fullName,
        nickname: data.nickname,
        jobTitle: data.jobTitle || null,
        branchId: data.branchId,
        departmentId: data.departmentId,
        roleId: data.roleId,
        startDate: data.startDate,
        endDate: data.endDate,
        dailyRate: data.dailyRate,
        rateType: "daily",
        status: "active",
        createdBy: userId,
      })
      .returning();

    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

const updateCasualWorkerSchema = z.object({
  fullName: z.string().min(1).optional(),
  nickname: z.string().min(1).optional(),
  jobTitle: z.string().optional().nullable(),
  branchId: z.string().optional(),
  departmentId: z.string().optional(),
  roleId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  dailyRate: z.number().positive().optional(),
  status: z.enum(["active", "inactive", "expired"]).optional(),
});

router.patch("/casual-workers/:id", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const parsed = updateCasualWorkerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ 
        message: "Validation failed", 
        errors: parsed.error.errors 
      });
    }

    const data = parsed.data;
    
    if (data.startDate && data.endDate && new Date(data.endDate) < new Date(data.startDate)) {
      return res.status(400).json({ message: "End date must be after start date" });
    }

    const [existing] = await db
      .select()
      .from(casualWorkers)
      .where(and(eq(casualWorkers.id, id), eq(casualWorkers.tenantId, tenantId)));

    if (!existing) {
      return res.status(404).json({ message: "Casual worker not found" });
    }

    const [updated] = await db
      .update(casualWorkers)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(casualWorkers.id, id))
      .returning();

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post("/casual-workers/:id/deactivate", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [existing] = await db
      .select()
      .from(casualWorkers)
      .where(and(eq(casualWorkers.id, id), eq(casualWorkers.tenantId, tenantId)));

    if (!existing) {
      return res.status(404).json({ message: "Casual worker not found" });
    }

    const [updated] = await db
      .update(casualWorkers)
      .set({
        status: "inactive",
        updatedAt: new Date(),
      })
      .where(eq(casualWorkers.id, id))
      .returning();

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete("/casual-workers/:id", requireAuth, requireManager, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [existing] = await db
      .select()
      .from(casualWorkers)
      .where(and(eq(casualWorkers.id, id), eq(casualWorkers.tenantId, tenantId)));

    if (!existing) {
      return res.status(404).json({ message: "Casual worker not found" });
    }

    await db.delete(casualWorkers).where(eq(casualWorkers.id, id));

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
