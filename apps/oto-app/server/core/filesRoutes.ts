import { Router, Request, Response } from "express";
import { db } from "../db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../auth";
import { canUserAccessBranch } from "../auth-middleware";
import { STORAGE_ENV_PREFIX } from "../config/env";
import { presignedUploadUrl } from "../storage/presignedUpload";
import { files } from "../../shared/schema";
import { tasks } from "../db/coreSchema";

const router = Router();

const uploadUrlSchema = z.object({
  taskId: z.string().uuid(),
  originalFilename: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
});

router.post("/upload-url", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = uploadUrlSchema.parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });
    const [task] = await db.select({ branchId: tasks.branchId }).from(tasks)
      .where(and(eq(tasks.id, body.taskId), eq(tasks.tenantId, tenantId))).limit(1);
    if (!task || !req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId)) {
      return res.status(404).json({ message: "Task not found" });
    }
    const safeFilename = body.originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

    const [file] = await db
      .insert(files)
      .values({
        tenantId,
        source: `core_task_evidence:${body.taskId}`,
        originalFilename: safeFilename,
        storageKey: "",
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
      })
      .returning();

    const storageKey = `${STORAGE_ENV_PREFIX}/tenants/${tenantId}/core/tasks/${body.taskId}/evidence/${file.id}/${safeFilename}`;

    await db.update(files).set({ storageKey }).where(eq(files.id, file.id));

    const uploadUrl = await presignedUploadUrl(storageKey, body.mimeType);

    res.json({
      uploadUrl,
      fileId: file.id,
      storageKey,
    });
  } catch (error: any) {
    console.error("[Core Files] POST /upload-url error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

export default router;
