import { Router, Request, Response } from "express";
import { db } from "../db";
import { announcements } from "../db/coreSchema";
import { tenants, users, employees } from "../../shared/schema";
import { eq, and, desc, lte, gte, or, sql } from "drizzle-orm";
import { requireAuth } from "../auth";
import { z } from "zod";

const router = Router();

async function getDefaultTenantId(): Promise<string> {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1);
  if (!tenant) throw new Error("No tenant found");
  return tenant.id;
}

const createAnnouncementSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  priority: z.enum(["info", "warning", "urgent"]).default("info"),
  startDate: z.string(),
  endDate: z.string(),
  branchIds: z.array(z.string()).nullable().optional(),
  departmentIds: z.array(z.string()).nullable().optional(),
  showToEveryone: z.boolean().default(true),
});

router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const result = await db
      .select({
        id: announcements.id,
        title: announcements.title,
        body: announcements.body,
        priority: announcements.priority,
        startDate: announcements.startDate,
        endDate: announcements.endDate,
        branchIds: announcements.branchIds,
        departmentIds: announcements.departmentIds,
        showToEveryone: announcements.showToEveryone,
        isActive: announcements.isActive,
        createdBy: announcements.createdBy,
        createdAt: announcements.createdAt,
        creatorName: users.fullName,
      })
      .from(announcements)
      .leftJoin(users, eq(announcements.createdBy, users.id))
      .where(eq(announcements.tenantId, tenantId))
      .orderBy(desc(announcements.createdAt));

    const enriched = [];
    for (const a of result) {
      let creatorDisplay = a.creatorName || "Unknown";
      if (a.createdBy) {
        const emp = await db
          .select({ nickname: employees.nickname, fullName: employees.fullName })
          .from(employees)
          .where(and(eq(employees.userId, a.createdBy), eq(employees.tenantId, tenantId), eq(employees.status, "active")))
          .limit(1);
        if (emp.length > 0) {
          creatorDisplay = emp[0].nickname || emp[0].fullName || creatorDisplay;
        }
      }
      enriched.push({ ...a, creatorDisplay });
    }

    res.json(enriched);
  } catch (error: any) {
    console.error("[Announcements] GET error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/active", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const user = req.user as any;
    const now = new Date();
    const bangkokDateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(now);
    const [year, month, day] = bangkokDateStr.split('-').map(Number);
    const startOfTodayBangkok = new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));

    const result = await db
      .select()
      .from(announcements)
      .where(and(
        eq(announcements.tenantId, tenantId),
        eq(announcements.isActive, true),
        lte(announcements.startDate, now),
        gte(announcements.endDate, startOfTodayBangkok),
      ))
      .orderBy(desc(announcements.createdAt));

    const branchId = req.query.branchId as string | undefined;
    const userDepartmentId = user.departmentId || null;

    const filtered = result.filter(a => {
      if (a.showToEveryone) return true;

      let branchMatch = true;
      if (a.branchIds && a.branchIds.length > 0 && branchId) {
        branchMatch = a.branchIds.includes(branchId);
      } else if (a.branchIds && a.branchIds.length > 0 && !branchId) {
        branchMatch = true;
      }

      let deptMatch = true;
      if (a.departmentIds && a.departmentIds.length > 0 && userDepartmentId) {
        deptMatch = a.departmentIds.includes(userDepartmentId);
      } else if (a.departmentIds && a.departmentIds.length > 0 && !userDepartmentId) {
        deptMatch = true;
      }

      return branchMatch && deptMatch;
    });

    res.json(filtered);
  } catch (error: any) {
    console.error("[Announcements] GET active error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const user = req.user as any;
    const data = createAnnouncementSchema.parse(req.body);

    const [created] = await db
      .insert(announcements)
      .values({
        tenantId,
        title: data.title,
        body: data.body,
        priority: data.priority,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        branchIds: data.branchIds || null,
        departmentIds: data.departmentIds || null,
        showToEveryone: data.showToEveryone,
        createdBy: user.id,
      })
      .returning();

    res.json(created);
  } catch (error: any) {
    console.error("[Announcements] POST error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const { id } = req.params;
    const updates: any = {};

    if (req.body.title !== undefined) updates.title = req.body.title;
    if (req.body.body !== undefined) updates.body = req.body.body;
    if (req.body.priority !== undefined) updates.priority = req.body.priority;
    if (req.body.startDate !== undefined) updates.startDate = new Date(req.body.startDate);
    if (req.body.endDate !== undefined) updates.endDate = new Date(req.body.endDate);
    if (req.body.branchIds !== undefined) updates.branchIds = req.body.branchIds;
    if (req.body.departmentIds !== undefined) updates.departmentIds = req.body.departmentIds;
    if (req.body.showToEveryone !== undefined) updates.showToEveryone = req.body.showToEveryone;
    if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
    updates.updatedAt = new Date();

    const [updated] = await db
      .update(announcements)
      .set(updates)
      .where(and(eq(announcements.id, id), eq(announcements.tenantId, tenantId)))
      .returning();

    if (!updated) return res.status(404).json({ message: "Not found" });
    res.json(updated);
  } catch (error: any) {
    console.error("[Announcements] PATCH error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const { id } = req.params;

    const [deleted] = await db
      .delete(announcements)
      .where(and(eq(announcements.id, id), eq(announcements.tenantId, tenantId)))
      .returning();

    if (!deleted) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Announcements] DELETE error:", error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
