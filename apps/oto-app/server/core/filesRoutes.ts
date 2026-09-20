import { Router, Request, Response } from "express";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../auth";
import { STORAGE_ENV_PREFIX } from "../config/env";
import { presignedUploadUrl } from "../storage/presignedUpload";
import { tenants, files, DEFAULT_TENANT_SLUG } from "../../shared/schema";

const router = Router();

async function getDefaultTenantId(): Promise<string> {
  const result = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  if (!result.length) throw new Error(`Default tenant ${DEFAULT_TENANT_SLUG} not found`);
  return result[0].id;
}

const uploadUrlSchema = z.object({
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});

router.post("/upload-url", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = uploadUrlSchema.parse(req.body);
    const tenantId = await getDefaultTenantId();

    const [file] = await db
      .insert(files)
      .values({
        tenantId,
        source: "core_task_evidence",
        originalFilename: body.originalFilename,
        storageKey: "",
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
      })
      .returning();

    const storageKey = `${STORAGE_ENV_PREFIX}/tenants/${tenantId}/core/tasks/evidence/${file.id}/${body.originalFilename}`;

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
