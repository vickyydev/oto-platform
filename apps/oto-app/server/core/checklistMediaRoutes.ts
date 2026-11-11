import { Router, Request, Response } from "express";
import type { S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "../db";
import { eq, and, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requireManager } from "../auth-middleware";
import { checklistAttachments, checklistTemplates, checklistTemplateItems } from "../db/coreSchema";
import multer from "multer";
import { fixMulterFilenames } from "../middleware/fixMulterFilenames";
import { randomUUID } from "crypto";
import { createS3Client, s3Bucket } from "../storage/s3Client";

const router = Router();

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE },
});
const PRESIGN_EXPIRY = 3600; // 1 hour for upload/download URLs

/**
 * Checklist media used to address a bucket of its own — AWS_S3_BUCKET,
 * defaulting to "oto-studio-files", in a region of its own. One bucket now
 * (intake note 01, §10 item 3): two variables naming one thing is how photos
 * end up somewhere nobody looks for them.
 */
let s3: S3Client | undefined;
function getS3Client(): S3Client {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS credentials not configured");
  }
  if (!s3) s3 = createS3Client();
  return s3;
}

function canAccessTemplate(user: any, template: { branchId?: string | null; branchIds?: string[] | null }): boolean {
  if (user?.hasAllBranchesAccess) return true;
  const allowed = new Set<string>([
    ...(user?.allowedBranchIds || []),
    ...((user?.branchAccess || []).map((access: any) => access.branchId)),
  ]);
  const templateBranches = template.branchIds?.length
    ? template.branchIds
    : template.branchId
      ? [template.branchId]
      : [];
  return templateBranches.length === 0 || templateBranches.some((branchId) => allowed.has(branchId));
}

async function getAuthorizedTemplate(req: Request, templateId: string, tenantId: string) {
  const [template] = await db.select({
    id: checklistTemplates.id,
    branchId: checklistTemplates.branchId,
    branchIds: checklistTemplates.branchIds,
  })
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.id, templateId), eq(checklistTemplates.tenantId, tenantId)))
    .limit(1);
  return template && canAccessTemplate(req.user, template) ? template : null;
}

const getS3Bucket = s3Bucket;

/**
 * Deleting a whole checklist (SCRUM-750). Its media rows go with it, cascading
 * from the checklist and its items; this then removes each stored file that no
 * row names any more, the same way removing one file does. A copied checklist's
 * media shares the stored file (SCRUM-659), so a file another checklist still
 * names stays where it is. Call it once the rows are gone. It never throws:
 * the checklist is already deleted, so a refused bucket delete is logged and
 * the rest carry on, as with one file.
 */
export async function deleteUnusedChecklistMedia(s3Keys: readonly string[]): Promise<void> {
  const keys = [...new Set(s3Keys)];
  if (keys.length === 0) return;
  let unused: string[];
  let s3Client: S3Client;
  let bucket: string;
  try {
    const stillNamed = new Set((await db
      .select({ s3Key: checklistAttachments.s3Key })
      .from(checklistAttachments)
      .where(inArray(checklistAttachments.s3Key, keys))).map((row) => row.s3Key));
    unused = keys.filter((key) => !stillNamed.has(key));
    if (unused.length === 0) return;
    s3Client = getS3Client();
    bucket = getS3Bucket();
  } catch (s3Error) {
    console.error("[ChecklistMedia] S3 delete error (continuing):", s3Error);
    return;
  }
  for (const key of unused) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (s3Error) {
      console.error("[ChecklistMedia] S3 delete error (continuing):", s3Error);
    }
  }
}

async function verifyTemplateAccess(req: Request, templateId: string, userTenantId: string): Promise<boolean> {
  return !!await getAuthorizedTemplate(req, templateId, userTenantId);
}

async function verifyItemAccess(req: Request, itemId: string, userTenantId: string): Promise<boolean> {
  const [item] = await db
    .select({ templateId: checklistTemplateItems.templateId })
    .from(checklistTemplateItems)
    .innerJoin(checklistTemplates, eq(checklistTemplateItems.templateId, checklistTemplates.id))
    .where(and(eq(checklistTemplateItems.id, itemId), eq(checklistTemplates.tenantId, userTenantId)))
    .limit(1);
  return !!item && !!await getAuthorizedTemplate(req, item.templateId, userTenantId);
}

async function canAccessAttachment(
  req: Request,
  attachment: typeof checklistAttachments.$inferSelect,
  tenantId: string,
): Promise<boolean> {
  if (attachment.tenantId !== tenantId) return false;
  if (attachment.checklistTemplateId) {
    return !!await getAuthorizedTemplate(req, attachment.checklistTemplateId, tenantId);
  }
  if (attachment.checklistTemplateItemId) {
    return verifyItemAccess(req, attachment.checklistTemplateItemId, tenantId);
  }
  return !!attachment.pendingChecklistId && attachment.createdByUserId === req.user?.id;
}

const presignRequestSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().positive(),
  target: z.enum(["checklist", "item"]),
  checklistTemplateId: z.string().uuid().optional(),
  checklistTemplateItemId: z.string().uuid().optional(),
  pendingChecklistId: z.string().uuid().optional(), // For uploads during checklist creation
  pendingItemIndex: z.number().int().min(0).optional(), // Item index for pending uploads
});

router.post("/presign", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const body = presignRequestSchema.parse(req.body);
    const { fileName, mimeType, size, target, checklistTemplateId, checklistTemplateItemId, pendingChecklistId, pendingItemIndex } = body;

    const isImage = ALLOWED_IMAGE_TYPES.includes(mimeType);
    const isVideo = ALLOWED_VIDEO_TYPES.includes(mimeType);

    if (!isImage && !isVideo) {
      return res.status(400).json({ 
        error: "Invalid file type", 
        allowedTypes: [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES] 
      });
    }

    if (isImage && size > MAX_IMAGE_SIZE) {
      return res.status(400).json({ 
        error: `Image too large. Maximum size is ${MAX_IMAGE_SIZE / (1024 * 1024)}MB` 
      });
    }

    if (isVideo && size > MAX_VIDEO_SIZE) {
      return res.status(400).json({ 
        error: `Video too large. Maximum size is ${MAX_VIDEO_SIZE / (1024 * 1024)}MB` 
      });
    }

    // Support for pending uploads during checklist creation
    const isPending = !!pendingChecklistId;
    
    if (!isPending) {
      if (target === "checklist" && !checklistTemplateId) {
        return res.status(400).json({ error: "checklistTemplateId required for checklist target" });
      }
      if (target === "item" && !checklistTemplateItemId) {
        return res.status(400).json({ error: "checklistTemplateItemId required for item target" });
      }
    }

    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });

    // Only verify access for non-pending uploads
    if (!isPending) {
      if (target === "checklist" && checklistTemplateId) {
        const hasAccess = await verifyTemplateAccess(req, checklistTemplateId, tenantId);
        if (!hasAccess) {
          return res.status(404).json({ error: "Checklist template not found or access denied" });
        }
      }

      if (target === "item" && checklistTemplateItemId) {
        const hasAccess = await verifyItemAccess(req, checklistTemplateItemId, tenantId);
        if (!hasAccess) {
          return res.status(404).json({ error: "Checklist item not found or access denied" });
        }
      }
    }

    const fileExt = fileName.split(".").pop() || (isImage ? "jpg" : "mp4");
    const uuid = randomUUID();
    
    let s3Key: string;
    if (isPending) {
      // Pending uploads use a special path that will be associated later
      if (target === "checklist") {
        s3Key = `checklists/pending-${pendingChecklistId}/header/${uuid}.${fileExt}`;
      } else {
        s3Key = `checklists/pending-${pendingChecklistId}/items/pending-item-${pendingItemIndex}/${uuid}.${fileExt}`;
      }
    } else if (target === "checklist") {
      s3Key = `checklists/${checklistTemplateId}/header/${uuid}.${fileExt}`;
    } else {
      const item = await db.select().from(checklistTemplateItems).where(eq(checklistTemplateItems.id, checklistTemplateItemId!)).limit(1);
      const templateId = item[0]?.templateId || "unknown";
      s3Key = `checklists/${templateId}/items/${checklistTemplateItemId}/${uuid}.${fileExt}`;
    }

    const s3Client = getS3Client();
    const bucket = getS3Bucket();

    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(s3Client, putCommand, { expiresIn: PRESIGN_EXPIRY });

    res.json({
      uploadUrl,
      s3Key,
      expiresIn: PRESIGN_EXPIRY,
    });
  } catch (error: any) {
    console.error("[ChecklistMedia] POST /presign error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message });
  }
});

const confirmSchema = z.object({
  type: z.enum(["image", "video"]),
  s3Key: z.string().min(1),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
  originalFilename: z.string().optional(),
  checklistTemplateId: z.string().uuid().optional(),
  checklistTemplateItemId: z.string().uuid().optional(),
  pendingChecklistId: z.string().uuid().optional(), // For uploads during checklist creation
  pendingItemIndex: z.number().int().min(0).optional(), // Item index for pending uploads
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().int().positive().optional(),
  sortOrder: z.number().int().default(0),
});

router.post("/confirm", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const body = confirmSchema.parse(req.body);
    const userId = req.user?.id;
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });

    const isPending = !!body.pendingChecklistId;

    if (!isPending && !body.checklistTemplateId && !body.checklistTemplateItemId) {
      return res.status(400).json({ error: "Either checklistTemplateId, checklistTemplateItemId, or pendingChecklistId is required" });
    }

    if (!isPending && body.checklistTemplateId && body.checklistTemplateItemId) {
      return res.status(400).json({ error: "Only one of checklistTemplateId or checklistTemplateItemId should be provided" });
    }

    // Validate s3Key follows expected patterns to prevent arbitrary key injection
    // Support both regular and pending patterns
    const regularPattern = /^checklists\/[a-f0-9-]+\/(header|items\/[a-f0-9-]+)\/[a-f0-9-]+\.\w+$/;
    const pendingPattern = /^checklists\/pending-[a-f0-9-]+\/(header|items\/pending-item-\d+)\/[a-f0-9-]+\.\w+$/;
    
    if (!regularPattern.test(body.s3Key) && !pendingPattern.test(body.s3Key)) {
      console.error("[ChecklistMedia] Invalid s3Key pattern:", body.s3Key);
      return res.status(400).json({ error: "Invalid file path" });
    }

    // Validate s3Key matches the claimed template/item/pending
    if (body.pendingChecklistId) {
      const expectedPrefix = `checklists/pending-${body.pendingChecklistId}/`;
      if (!body.s3Key.startsWith(expectedPrefix)) {
        console.error("[ChecklistMedia] s3Key doesn't match pending:", body.s3Key, "expected:", expectedPrefix);
        return res.status(400).json({ error: "File path mismatch" });
      }
    } else if (body.checklistTemplateId) {
      const expectedPrefix = `checklists/${body.checklistTemplateId}/header/`;
      if (!body.s3Key.startsWith(expectedPrefix)) {
        console.error("[ChecklistMedia] s3Key doesn't match template:", body.s3Key, "expected:", expectedPrefix);
        return res.status(400).json({ error: "File path mismatch" });
      }
    } else if (body.checklistTemplateItemId) {
      if (!body.s3Key.includes(`/items/${body.checklistTemplateItemId}/`)) {
        console.error("[ChecklistMedia] s3Key doesn't match item:", body.s3Key, "expected item:", body.checklistTemplateItemId);
        return res.status(400).json({ error: "File path mismatch" });
      }
    }

    // Only verify access for non-pending uploads
    if (!isPending) {
      if (body.checklistTemplateId) {
        const hasAccess = await verifyTemplateAccess(req, body.checklistTemplateId, tenantId);
        if (!hasAccess) {
          return res.status(404).json({ error: "Checklist template not found or access denied" });
        }
      }

      if (body.checklistTemplateItemId) {
        const hasAccess = await verifyItemAccess(req, body.checklistTemplateItemId, tenantId);
        if (!hasAccess) {
          return res.status(404).json({ error: "Checklist item not found or access denied" });
        }
      }
    }

    const [attachment] = await db
      .insert(checklistAttachments)
      .values({
        tenantId,
        checklistTemplateId: body.checklistTemplateId || null,
        checklistTemplateItemId: body.checklistTemplateItemId || null,
        pendingChecklistId: body.pendingChecklistId || null,
        pendingItemIndex: body.pendingItemIndex ?? null,
        type: body.type,
        s3Key: body.s3Key,
        mimeType: body.mimeType,
        fileSize: body.fileSize,
        originalFilename: body.originalFilename,
        width: body.width,
        height: body.height,
        durationSeconds: body.durationSeconds,
        sortOrder: body.sortOrder,
        createdByUserId: userId,
      })
      .returning();

    res.json({ attachment });
  } catch (error: any) {
    console.error("[ChecklistMedia] POST /confirm error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message });
  }
});

// Get pending attachments for a pending checklist (used during creation)
router.get("/pending/:pendingChecklistId", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { pendingChecklistId } = req.params;
    const tenantId = req.userWithAccess?.tenantId;
    const userId = req.user?.id;
    if (!tenantId || !userId) return res.status(403).json({ error: "Tenant access denied" });
    
    const attachments = await db
      .select()
      .from(checklistAttachments)
      .where(and(
        eq(checklistAttachments.pendingChecklistId, pendingChecklistId),
        eq(checklistAttachments.tenantId, tenantId),
        eq(checklistAttachments.createdByUserId, userId),
      ));
    
    res.json({ attachments });
  } catch (error: any) {
    console.error("[ChecklistMedia] GET /pending/:pendingChecklistId error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Associate pending media with the actual checklist after creation
const associatePendingSchema = z.object({
  pendingChecklistId: z.string().uuid(),
  checklistTemplateId: z.string().uuid(),
  itemIdMappings: z.array(z.object({
    pendingItemIndex: z.number().int().min(0),
    checklistTemplateItemId: z.string().uuid(),
  })).optional(),
});

router.post("/associate-pending", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const body = associatePendingSchema.parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    const userId = req.user?.id;
    if (!tenantId || !userId) return res.status(403).json({ error: "Tenant access denied" });
    
    // Verify the new checklist exists
    const hasAccess = await verifyTemplateAccess(req, body.checklistTemplateId, tenantId);
    if (!hasAccess) {
      return res.status(404).json({ error: "Checklist template not found or access denied" });
    }
    
    // Get all pending attachments for this pendingChecklistId
    const pendingAttachments = await db
      .select()
      .from(checklistAttachments)
      .where(and(
        eq(checklistAttachments.pendingChecklistId, body.pendingChecklistId),
        eq(checklistAttachments.tenantId, tenantId),
        eq(checklistAttachments.createdByUserId, userId),
      ));
    
    if (pendingAttachments.length === 0) {
      return res.json({ message: "No pending attachments to associate", updated: 0 });
    }
    
    // Create a mapping from pendingItemIndex to actual item ID
    const itemIdMap = new Map<number, string>();
    if (body.itemIdMappings) {
      for (const mapping of body.itemIdMappings) {
        const [item] = await db.select({ id: checklistTemplateItems.id })
          .from(checklistTemplateItems)
          .where(and(
            eq(checklistTemplateItems.id, mapping.checklistTemplateItemId),
            eq(checklistTemplateItems.templateId, body.checklistTemplateId),
            eq(checklistTemplateItems.tenantId, tenantId),
          )).limit(1);
        if (!item) return res.status(404).json({ error: "Checklist item not found or access denied" });
        itemIdMap.set(mapping.pendingItemIndex, mapping.checklistTemplateItemId);
      }
    }
    
    let updated = 0;
    
    for (const attachment of pendingAttachments) {
      if (attachment.pendingItemIndex !== null && attachment.pendingItemIndex !== undefined) {
        // This is an item-level attachment
        const actualItemId = itemIdMap.get(attachment.pendingItemIndex);
        if (actualItemId) {
          await db
            .update(checklistAttachments)
            .set({
              checklistTemplateItemId: actualItemId,
              pendingChecklistId: null,
              pendingItemIndex: null,
            })
            .where(and(eq(checklistAttachments.id, attachment.id), eq(checklistAttachments.tenantId, tenantId)));
          updated++;
        }
      } else {
        // This is a header-level attachment
        await db
          .update(checklistAttachments)
          .set({
            checklistTemplateId: body.checklistTemplateId,
            pendingChecklistId: null,
            pendingItemIndex: null,
          })
          .where(and(eq(checklistAttachments.id, attachment.id), eq(checklistAttachments.tenantId, tenantId)));
        updated++;
      }
    }
    
    res.json({ message: "Pending attachments associated", updated });
  } catch (error: any) {
    console.error("[ChecklistMedia] POST /associate-pending error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message });
  }
});

router.get("/url", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });
    const s3Key = req.query.s3Key as string;
    if (!s3Key) {
      return res.status(400).json({ error: "s3Key query parameter required" });
    }

    // A copied checklist's media shares the original's stored object, one row per
    // checklist (SCRUM-659): the file opens for anyone who can reach any of them.
    const attachments = await db
      .select()
      .from(checklistAttachments)
      .where(and(eq(checklistAttachments.s3Key, s3Key), eq(checklistAttachments.tenantId, tenantId)));
    let attachment: (typeof attachments)[number] | undefined;
    for (const candidate of attachments) {
      if (await canAccessAttachment(req, candidate, tenantId)) {
        attachment = candidate;
        break;
      }
    }

    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found" });
    }
    let linkedTemplateId = attachment.checklistTemplateId;
    if (!linkedTemplateId && attachment.checklistTemplateItemId) {
      const [item] = await db.select({ templateId: checklistTemplateItems.templateId })
        .from(checklistTemplateItems)
        .where(and(
          eq(checklistTemplateItems.id, attachment.checklistTemplateItemId),
          eq(checklistTemplateItems.tenantId, tenantId),
        ))
        .limit(1);
      linkedTemplateId = item?.templateId || null;
    }
    if (linkedTemplateId && !await getAuthorizedTemplate(req, linkedTemplateId, tenantId)) {
      return res.status(404).json({ error: "Attachment not found or access denied" });
    }

    const s3Client = getS3Client();
    const bucket = getS3Bucket();

    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
    });

    const downloadUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: PRESIGN_EXPIRY });

    res.json({ url: downloadUrl, expiresIn: PRESIGN_EXPIRY });
  } catch (error: any) {
    console.error("[ChecklistMedia] GET /url error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/by-template/:templateId", requireAuth, async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });
    if (!await getAuthorizedTemplate(req, templateId, tenantId)) {
      return res.status(404).json({ error: "Checklist template not found or access denied" });
    }
    
    const attachments = await db
      .select()
      .from(checklistAttachments)
      .where(and(eq(checklistAttachments.checklistTemplateId, templateId), eq(checklistAttachments.tenantId, tenantId)))
      .orderBy(checklistAttachments.sortOrder);

    res.json({ attachments });
  } catch (error: any) {
    console.error("[ChecklistMedia] GET /by-template error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/by-item/:itemId", requireAuth, async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });
    const [item] = await db.select({ templateId: checklistTemplateItems.templateId })
      .from(checklistTemplateItems)
      .where(and(eq(checklistTemplateItems.id, itemId), eq(checklistTemplateItems.tenantId, tenantId)))
      .limit(1);
    if (!item || !await getAuthorizedTemplate(req, item.templateId, tenantId)) {
      return res.status(404).json({ error: "Checklist item not found or access denied" });
    }
    
    const attachments = await db
      .select()
      .from(checklistAttachments)
      .where(and(eq(checklistAttachments.checklistTemplateItemId, itemId), eq(checklistAttachments.tenantId, tenantId)))
      .orderBy(checklistAttachments.sortOrder);

    res.json({ attachments });
  } catch (error: any) {
    console.error("[ChecklistMedia] GET /by-item error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/items-by-template/:templateId", requireAuth, async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });
    if (!await getAuthorizedTemplate(req, templateId, tenantId)) {
      return res.status(404).json({ error: "Checklist template not found or access denied" });
    }
    
    const items = await db
      .select()
      .from(checklistTemplateItems)
      .where(and(eq(checklistTemplateItems.templateId, templateId), eq(checklistTemplateItems.tenantId, tenantId)));

    const itemIds = items.map(i => i.id);
    
    if (itemIds.length === 0) {
      return res.json({ attachmentsByItem: {} });
    }

    const itemAttachments = await db
      .select()
      .from(checklistAttachments)
      .where(and(
        eq(checklistAttachments.tenantId, tenantId),
        inArray(checklistAttachments.checklistTemplateItemId, itemIds),
      ))
      .orderBy(checklistAttachments.sortOrder);

    const attachmentsByItem: Record<string, typeof itemAttachments> = {};
    for (const att of itemAttachments) {
      const itemId = att.checklistTemplateItemId!;
      if (!attachmentsByItem[itemId]) {
        attachmentsByItem[itemId] = [];
      }
      attachmentsByItem[itemId].push(att);
    }

    res.json({ attachmentsByItem });
  } catch (error: any) {
    console.error("[ChecklistMedia] GET /items-by-template error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/:id", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });
    
    const attachment = await db
      .select()
      .from(checklistAttachments)
      .where(and(eq(checklistAttachments.id, id), eq(checklistAttachments.tenantId, tenantId)))
      .limit(1);

    if (!attachment.length || !await canAccessAttachment(req, attachment[0], tenantId)) {
      return res.status(404).json({ error: "Attachment not found or access denied" });
    }

    const s3Key = attachment[0].s3Key;

    // A copied checklist's media shares the stored object (SCRUM-659): removing
    // it from one checklist leaves it on the other, so the object goes only with
    // the last row that names it.
    const otherUses = await db
      .select({ id: checklistAttachments.id })
      .from(checklistAttachments)
      .where(and(
        eq(checklistAttachments.s3Key, s3Key),
        eq(checklistAttachments.tenantId, tenantId),
        ne(checklistAttachments.id, id),
      ))
      .limit(1);

    if (otherUses.length === 0) {
      try {
        const s3Client = getS3Client();
        const bucket = getS3Bucket();

        const deleteCommand = new DeleteObjectCommand({
          Bucket: bucket,
          Key: s3Key,
        });

        await s3Client.send(deleteCommand);
      } catch (s3Error) {
        console.error("[ChecklistMedia] S3 delete error (continuing):", s3Error);
      }
    }

    await db.delete(checklistAttachments).where(and(
      eq(checklistAttachments.id, id),
      eq(checklistAttachments.tenantId, tenantId),
    ));

    res.json({ success: true });
  } catch (error: any) {
    console.error("[ChecklistMedia] DELETE /:id error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/reorder", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { attachmentIds } = req.body as { attachmentIds: string[] };
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });
    
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 100 ||
        attachmentIds.some(id => typeof id !== "string") || new Set(attachmentIds).size !== attachmentIds.length) {
      return res.status(400).json({ error: "attachmentIds must be an array" });
    }
    if (attachmentIds.length === 0) return res.json({ success: true });

    const attachments = await db.select().from(checklistAttachments).where(and(
      eq(checklistAttachments.tenantId, tenantId),
      inArray(checklistAttachments.id, attachmentIds),
    ));
    if (attachments.length !== attachmentIds.length) {
      return res.status(404).json({ error: "Attachment not found or access denied" });
    }
    for (const attachment of attachments) {
      if (!await canAccessAttachment(req, attachment, tenantId)) {
        return res.status(404).json({ error: "Attachment not found or access denied" });
      }
    }

    for (let i = 0; i < attachmentIds.length; i++) {
      await db
        .update(checklistAttachments)
        .set({ sortOrder: i })
        .where(and(eq(checklistAttachments.id, attachmentIds[i]), eq(checklistAttachments.tenantId, tenantId)));
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[ChecklistMedia] PATCH /reorder error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Direct upload route - proxies through backend to avoid CORS issues
router.post("/upload", requireAuth, requireManager, upload.single("file"), fixMulterFilenames, async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // SCRUM-748: validate multipart targets before writing a stored object.
    const parsed = presignRequestSchema.safeParse({
      ...req.body,
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      pendingItemIndex: req.body.pendingItemIndex === undefined ? undefined
        : typeof req.body.pendingItemIndex === "string" && /^\d+$/.test(req.body.pendingItemIndex)
          ? Number(req.body.pendingItemIndex) : NaN,
    });
    if (!parsed.success) return res.status(400).json({ error: "Invalid upload target" });
    const { target, checklistTemplateId, checklistTemplateItemId, pendingChecklistId, pendingItemIndex } = parsed.data;
    const { width, height, durationSeconds } = req.body;
    const isPending = !!pendingChecklistId;
    if (isPending && (checklistTemplateId || checklistTemplateItemId)) {
      return res.status(400).json({ error: "Pending and saved targets cannot be combined" });
    }
    if (isPending && target === "item" && pendingItemIndex === undefined) {
      return res.status(400).json({ error: "pendingItemIndex required for pending item target" });
    }

    const mimeType = file.mimetype;
    const size = file.size;

    const isImage = ALLOWED_IMAGE_TYPES.includes(mimeType);
    const isVideo = ALLOWED_VIDEO_TYPES.includes(mimeType);

    if (!isImage && !isVideo) {
      return res.status(400).json({ 
        error: "Invalid file type", 
        allowedTypes: [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES] 
      });
    }

    if (isImage && size > MAX_IMAGE_SIZE) {
      return res.status(400).json({ 
        error: `Image too large. Maximum size is ${MAX_IMAGE_SIZE / (1024 * 1024)}MB` 
      });
    }

    if (isVideo && size > MAX_VIDEO_SIZE) {
      return res.status(400).json({ 
        error: `Video too large. Maximum size is ${MAX_VIDEO_SIZE / (1024 * 1024)}MB` 
      });
    }

    if (!isPending && target === "checklist" && !checklistTemplateId) {
      return res.status(400).json({ error: "checklistTemplateId required for checklist target" });
    }
    if (!isPending && target === "item" && !checklistTemplateItemId) {
      return res.status(400).json({ error: "checklistTemplateItemId required for item target" });
    }

    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ error: "Tenant access denied" });

    if (target === "checklist" && checklistTemplateId) {
      const hasAccess = await verifyTemplateAccess(req, checklistTemplateId, tenantId);
      if (!hasAccess) {
        return res.status(404).json({ error: "Checklist template not found or access denied" });
      }
    }

    if (target === "item" && checklistTemplateItemId) {
      const hasAccess = await verifyItemAccess(req, checklistTemplateItemId, tenantId);
      if (!hasAccess) {
        return res.status(404).json({ error: "Checklist item not found or access denied" });
      }
    }

    const fileExt = file.originalname.split(".").pop() || (isImage ? "jpg" : "mp4");
    const uuid = randomUUID();
    
    let s3Key: string;
    if (isPending) {
      const destination = target === "checklist" ? "header" : `items/pending-item-${pendingItemIndex}`;
      s3Key = `checklists/pending-${pendingChecklistId}/${destination}/${uuid}.${fileExt}`;
    } else if (target === "checklist") {
      s3Key = `checklists/${checklistTemplateId}/header/${uuid}.${fileExt}`;
    } else {
      const item = await db.select().from(checklistTemplateItems).where(eq(checklistTemplateItems.id, checklistTemplateItemId!)).limit(1);
      const templateId = item[0]?.templateId || "unknown";
      s3Key = `checklists/${templateId}/items/${checklistTemplateItemId}/${uuid}.${fileExt}`;
    }

    const s3Client = getS3Client();
    const bucket = getS3Bucket();

    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: mimeType,
      Body: file.buffer,
    });

    await s3Client.send(putCommand);

    const userId = req.user?.id;
    const type = isImage ? "image" : "video";

    const [attachment] = await db
      .insert(checklistAttachments)
      .values({
        tenantId,
        checklistTemplateId: target === "checklist" ? checklistTemplateId : null,
        checklistTemplateItemId: target === "item" ? checklistTemplateItemId : null,
        pendingChecklistId: pendingChecklistId ?? null,
        pendingItemIndex: isPending && target === "item" ? pendingItemIndex : null,
        type,
        s3Key,
        mimeType,
        fileSize: size,
        originalFilename: file.originalname,
        width: width ? parseInt(width) : null,
        height: height ? parseInt(height) : null,
        durationSeconds: durationSeconds ? parseInt(durationSeconds) : null,
        sortOrder: 0,
        createdByUserId: userId,
      })
      .returning();

    res.json(attachment);
  } catch (error: any) {
    console.error("[ChecklistMedia] POST /upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
