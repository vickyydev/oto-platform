import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db } from "../../db";
import { eq, and, desc } from "drizzle-orm";
import {
  taskTemplates,
  taskTemplateQuestions,
  tasks,
} from "../../db/coreSchema";
import { branches, tenants, DEFAULT_TENANT_SLUG } from "../../../shared/schema";
import { requireAuth } from "../../auth";

function requireStudioAccess(req: Request, res: Response, next: NextFunction) {
  const user = req.user as any;
  const allowedRoles = ["admin", "manager", "global_admin", "operator_admin"];
  if (!user || !allowedRoles.includes(user.role)) {
    return res.status(403).json({ message: "Studio access requires admin or manager role" });
  }
  next();
}

const router = Router();

async function getDefaultTenantId(): Promise<string> {
  const tenant = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);

  if (tenant.length === 0) {
    const [newTenant] = await db
      .insert(tenants)
      .values({ name: "Default", slug: DEFAULT_TENANT_SLUG })
      .returning({ id: tenants.id });
    return newTenant.id;
  }
  return tenant[0].id;
}

router.get("/studio/task-templates", requireAuth, requireStudioAccess, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();

    const templates = await db
      .select({
        id: taskTemplates.id,
        title: taskTemplates.title,
        description: taskTemplates.description,
        branchScope: taskTemplates.branchScope,
        branchIds: taskTemplates.branchIds,
        departmentId: taskTemplates.departmentId,
        recurrence: taskTemplates.recurrence,
        preferredDueTime: taskTemplates.preferredDueTime,
        requiresPhotoEvidence: taskTemplates.requiresPhotoEvidence,
        requiresResponses: taskTemplates.requiresResponses,
        isActive: taskTemplates.isActive,
        createdBy: taskTemplates.createdBy,
        createdAt: taskTemplates.createdAt,
        updatedAt: taskTemplates.updatedAt,
      })
      .from(taskTemplates)
      .where(eq(taskTemplates.tenantId, tenantId))
      .orderBy(desc(taskTemplates.createdAt));

    res.json(templates);
  } catch (error) {
    console.error("Error fetching task templates:", error);
    res.status(500).json({ message: "Failed to fetch task templates" });
  }
});

router.get("/studio/task-templates/:id", requireAuth, requireStudioAccess, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [template] = await db
      .select()
      .from(taskTemplates)
      .where(and(eq(taskTemplates.id, id), eq(taskTemplates.tenantId, tenantId)));

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    const questions = await db
      .select()
      .from(taskTemplateQuestions)
      .where(eq(taskTemplateQuestions.templateId, id))
      .orderBy(taskTemplateQuestions.sortOrder);

    res.json({ ...template, questions });
  } catch (error) {
    console.error("Error fetching task template:", error);
    res.status(500).json({ message: "Failed to fetch task template" });
  }
});

const createTemplateSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  branchScope: z.enum(["ALL", "SELECTED"]).optional().default("ALL"),
  branchIds: z.array(z.string()).optional().default([]),
  departmentId: z.string().optional(),
  recurrence: z.enum(["once", "daily", "weekly", "monthly"]).optional().default("once"),
  weeklyDays: z.array(z.string()).optional().default([]),
  monthlyDay: z.number().min(1).max(31).optional().nullable(),
  preferredDueTime: z.string().optional(),
  requiresPhotoEvidence: z.boolean().optional().default(false),
  requiresResponses: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
  questions: z.array(z.object({
    prompt: z.string().min(1),
    questionType: z.enum(["text", "choice", "boolean"]).optional().default("text"),
    options: z.array(z.string()).optional(),
    isRequired: z.boolean().optional().default(true),
    sortOrder: z.number().optional().default(0),
  })).optional().default([]),
});

router.post("/studio/task-templates", requireAuth, requireStudioAccess, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const tenantId = await getDefaultTenantId();
    const body = createTemplateSchema.parse(req.body);

    const [template] = await db
      .insert(taskTemplates)
      .values({
        tenantId,
        title: body.title,
        description: body.description,
        branchScope: body.branchScope,
        branchIds: body.branchIds,
        departmentId: body.departmentId || null,
        recurrence: body.recurrence,
        weeklyDays: body.weeklyDays || [],
        monthlyDay: body.monthlyDay || null,
        preferredDueTime: body.preferredDueTime,
        requiresPhotoEvidence: body.requiresPhotoEvidence,
        requiresResponses: body.requiresResponses,
        isActive: body.isActive,
        createdBy: user.id,
      })
      .returning();

    if (body.questions && body.questions.length > 0) {
      await db.insert(taskTemplateQuestions).values(
        body.questions.map((q, idx) => ({
          tenantId,
          templateId: template.id,
          prompt: q.prompt,
          questionType: q.questionType as "text" | "choice" | "boolean",
          options: q.options,
          isRequired: q.isRequired,
          sortOrder: q.sortOrder ?? idx,
        }))
      );
    }

    res.status(201).json(template);
  } catch (error) {
    console.error("Error creating task template:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Validation error", errors: error.errors });
    }
    res.status(500).json({ message: "Failed to create task template" });
  }
});

router.patch("/studio/task-templates/:id", requireAuth, requireStudioAccess, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();
    const body = createTemplateSchema.partial().parse(req.body);

    const [existing] = await db
      .select({ id: taskTemplates.id })
      .from(taskTemplates)
      .where(and(eq(taskTemplates.id, id), eq(taskTemplates.tenantId, tenantId)));

    if (!existing) {
      return res.status(404).json({ message: "Template not found" });
    }

    const updateData: any = { updatedAt: new Date() };
    if (body.title !== undefined) updateData.title = body.title;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.branchScope !== undefined) updateData.branchScope = body.branchScope;
    if (body.branchIds !== undefined) updateData.branchIds = body.branchIds;
    if (body.departmentId !== undefined) updateData.departmentId = body.departmentId;
    if (body.recurrence !== undefined) updateData.recurrence = body.recurrence;
    if (body.preferredDueTime !== undefined) updateData.preferredDueTime = body.preferredDueTime;
    if (body.requiresPhotoEvidence !== undefined) updateData.requiresPhotoEvidence = body.requiresPhotoEvidence;
    if (body.requiresResponses !== undefined) updateData.requiresResponses = body.requiresResponses;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;

    const [updated] = await db
      .update(taskTemplates)
      .set(updateData)
      .where(eq(taskTemplates.id, id))
      .returning();

    if (body.questions !== undefined) {
      await db.delete(taskTemplateQuestions).where(eq(taskTemplateQuestions.templateId, id));
      if (body.questions.length > 0) {
        await db.insert(taskTemplateQuestions).values(
          body.questions.map((q, idx) => ({
            tenantId,
            templateId: id,
            prompt: q.prompt,
            questionType: q.questionType as "text" | "choice" | "boolean",
            options: q.options,
            isRequired: q.isRequired,
            sortOrder: q.sortOrder ?? idx,
          }))
        );
      }
    }

    res.json(updated);
  } catch (error) {
    console.error("Error updating task template:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Validation error", errors: error.errors });
    }
    res.status(500).json({ message: "Failed to update task template" });
  }
});

router.delete("/studio/task-templates/:id", requireAuth, requireStudioAccess, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [existing] = await db
      .select({ id: taskTemplates.id })
      .from(taskTemplates)
      .where(and(eq(taskTemplates.id, id), eq(taskTemplates.tenantId, tenantId)));

    if (!existing) {
      return res.status(404).json({ message: "Template not found" });
    }

    await db.delete(taskTemplates).where(eq(taskTemplates.id, id));
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting task template:", error);
    res.status(500).json({ message: "Failed to delete task template" });
  }
});

const generateTasksSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  branchId: z.string().optional(),
});

router.post("/studio/task-generator", requireAuth, requireStudioAccess, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const tenantId = await getDefaultTenantId();
    const body = generateTasksSchema.parse(req.body);

    const activeTemplates = await db
      .select()
      .from(taskTemplates)
      .where(and(
        eq(taskTemplates.tenantId, tenantId),
        eq(taskTemplates.isActive, true)
      ));

    const allBranches = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.tenantId, tenantId));

    let created = 0;
    let skipped = 0;

    for (const template of activeTemplates) {
      let targetBranches: { id: string; name: string }[] = [];

      if (template.branchScope === "ALL") {
        targetBranches = body.branchId
          ? allBranches.filter(b => b.id === body.branchId)
          : allBranches;
      } else if (template.branchScope === "SELECTED" && template.branchIds) {
        const selectedIds = template.branchIds as string[];
        targetBranches = body.branchId
          ? allBranches.filter(b => b.id === body.branchId && selectedIds.includes(b.id))
          : allBranches.filter(b => selectedIds.includes(b.id));
      }

      for (const branch of targetBranches) {
        const [existing] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(
            eq(tasks.tenantId, tenantId),
            eq(tasks.templateId, template.id),
            eq(tasks.branchId, branch.id),
            eq(tasks.generatedForDate, body.date)
          ))
          .limit(1);

        if (existing) {
          skipped++;
          continue;
        }

        let dueAt: Date | null = null;
        if (template.preferredDueTime) {
          const [hours, minutes] = template.preferredDueTime.split(":").map(Number);
          dueAt = new Date(`${body.date}T00:00:00`);
          dueAt.setHours(hours || 0, minutes || 0, 0, 0);
        }

        await db.insert(tasks).values({
          tenantId,
          templateId: template.id,
          generatedForDate: body.date,
          branchId: branch.id,
          departmentId: template.departmentId,
          title: template.title,
          description: template.description,
          status: "pending",
          priority: "medium",
          recurrence: template.recurrence,
          dueAt,
          requiresPhotoEvidence: template.requiresPhotoEvidence,
          requiresResponses: template.requiresResponses,
          createdBy: user.id,
        });

        created++;
      }
    }

    res.json({ created, skipped, date: body.date });
  } catch (error) {
    console.error("Error generating tasks:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Validation error", errors: error.errors });
    }
    res.status(500).json({ message: "Failed to generate tasks" });
  }
});

router.get("/studio/branches", requireAuth, requireStudioAccess, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();

    const allBranches = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.tenantId, tenantId))
      .orderBy(branches.name);

    res.json(allBranches);
  } catch (error) {
    console.error("Error fetching branches:", error);
    res.status(500).json({ message: "Failed to fetch branches" });
  }
});

export default router;
