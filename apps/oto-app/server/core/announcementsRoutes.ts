import { Router, Request, Response } from "express";
import { db } from "../db";
import { announcements } from "../db/coreSchema";
import { users, employees, branches, departments, type UserWithBranchAccess } from "../../shared/schema";
import { eq, and, desc, lte, gte, inArray } from "drizzle-orm";
import { requireAuth } from "../auth";
import { requireManager } from "../auth-middleware";
import { z } from "zod";

const router = Router();

function canManage(user: UserWithBranchAccess, announcement: { showToEveryone: boolean; branchIds: string[] | null }): boolean {
  return user.hasAllBranchesAccess || (!announcement.showToEveryone && !!announcement.branchIds?.length
    && announcement.branchIds.every(id => user.allowedBranchIds.includes(id)));
}

async function validAudience(user: UserWithBranchAccess, audience: { showToEveryone: boolean; branchIds: string[] | null; departmentIds: string[] | null }): Promise<boolean> {
  if (!canManage(user, audience)) return false;
  const branchIds = [...new Set(audience.branchIds || [])];
  const departmentIds = [...new Set(audience.departmentIds || [])];
  if (!audience.showToEveryone && branchIds.length === 0 && departmentIds.length === 0) return false;
  if (branchIds.length) {
    const found = await db.select({ id: branches.id }).from(branches)
      .where(and(eq(branches.tenantId, user.tenantId!), inArray(branches.id, branchIds)));
    if (found.length !== branchIds.length) return false;
  }
  if (departmentIds.length) {
    const found = await db.select({ id: departments.id }).from(departments)
      .where(and(eq(departments.tenantId, user.tenantId!), inArray(departments.id, departmentIds)));
    if (found.length !== departmentIds.length) return false;
  }
  return true;
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

router.get("/", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const user = req.userWithAccess!;
    if (!user.tenantId) return res.status(403).json({ message: "Tenant access required" });
    const tenantId = user.tenantId;
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
    for (const a of result.filter(a => canManage(user, a))) {
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
    const user = req.userWithAccess;
    if (!user?.tenantId) return res.status(403).json({ message: "Tenant access required" });
    const tenantId = user.tenantId;
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

    const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
    if (branchId) {
      const [branch] = await db.select({ id: branches.id }).from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).limit(1);
      if (!branch) return res.status(404).json({ message: "Branch not found" });
      if (!user.hasAllBranchesAccess && !user.allowedBranchIds.includes(branchId)) {
        return res.status(403).json({ message: "Branch access denied" });
      }
    }
    const [employee] = await db.select({ departmentId: employees.primaryDepartmentId })
      .from(employees)
      .where(and(eq(employees.userId, user.id), eq(employees.tenantId, tenantId), eq(employees.status, "active")))
      .limit(1);
    const userDepartmentId = employee?.departmentId || null;

    const filtered = result.filter(a => {
      if (a.showToEveryone) return true;

      const branchMatch = !a.branchIds?.length || (branchId
        ? a.branchIds.includes(branchId)
        : user.hasAllBranchesAccess || a.branchIds.some(id => user.allowedBranchIds.includes(id)));
      const deptMatch = !a.departmentIds?.length || (!!userDepartmentId && a.departmentIds.includes(userDepartmentId));

      return branchMatch && deptMatch;
    });

    res.json(filtered);
  } catch (error: any) {
    console.error("[Announcements] GET active error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post("/", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const user = req.userWithAccess!;
    if (!user.tenantId) return res.status(403).json({ message: "Tenant access required" });
    const tenantId = user.tenantId;
    const data = createAnnouncementSchema.parse(req.body);
    if (!await validAudience(user, { showToEveryone: data.showToEveryone, branchIds: data.branchIds || null, departmentIds: data.departmentIds || null })) {
      return res.status(403).json({ message: "Announcement audience is outside your branches" });
    }

    const [created] = await db
      .insert(announcements)
      .values({
        tenantId,
        title: data.title,
        body: data.body,
        priority: data.priority,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        branchIds: data.showToEveryone ? null : data.branchIds || null,
        departmentIds: data.showToEveryone ? null : data.departmentIds || null,
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

router.patch("/:id", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const user = req.userWithAccess!;
    if (!user.tenantId) return res.status(403).json({ message: "Tenant access required" });
    const tenantId = user.tenantId;
    const { id } = req.params;
    const [current] = await db.select().from(announcements)
      .where(and(eq(announcements.id, id), eq(announcements.tenantId, tenantId))).limit(1);
    if (!current || !canManage(user, current)) return res.status(404).json({ message: "Not found" });
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
    if (updates.showToEveryone === true) {
      updates.branchIds = null;
      updates.departmentIds = null;
    }
    updates.updatedAt = new Date();

    if (!await validAudience(user, {
      showToEveryone: updates.showToEveryone ?? current.showToEveryone,
      branchIds: updates.branchIds === undefined ? current.branchIds : updates.branchIds,
      departmentIds: updates.departmentIds === undefined ? current.departmentIds : updates.departmentIds,
    })) return res.status(403).json({ message: "Announcement audience is outside your branches" });

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

router.delete("/:id", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const user = req.userWithAccess!;
    if (!user.tenantId) return res.status(403).json({ message: "Tenant access required" });
    const tenantId = user.tenantId;
    const { id } = req.params;
    const [current] = await db.select().from(announcements)
      .where(and(eq(announcements.id, id), eq(announcements.tenantId, tenantId))).limit(1);
    if (!current || !canManage(user, current)) return res.status(404).json({ message: "Not found" });

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
