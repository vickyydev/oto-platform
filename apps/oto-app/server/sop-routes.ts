import type { Express, Request } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { requireAuth } from "./auth";
import { requireAdmin, canUserAccessBranch } from "./auth-middleware";
import { insertSopArticleSchema, type UserWithBranchAccess } from "@shared/schema";
import { changeSopArticle, getSopRevision, listSopRevisions, SopChangeError } from "./sop-storage";

export const canReadSopArticle = (user: UserWithBranchAccess, article: Awaited<ReturnType<typeof storage.getSopArticle>>, tenantId: string) => {
    if (!article || article.tenantId !== tenantId) return false;
    const canSeeBranch = user.hasAllBranchesAccess || article.scope === 'GLOBAL' ||
      (article.branchIds || []).some(id => user.allowedBranchIds.includes(id));
    if (!canSeeBranch) return false;
    return ['admin', 'global_admin', 'operator_admin', 'manager'].includes(user.role) || article.status === 'published';
  };

export function registerSopRoutes(app: Express, resolveTenantId: (tenantId?: string | null) => Promise<string>) {
  const historyActor = (req: Request) => {
    const user = req.userWithAccess;
    if (!user?.tenantId) throw new SopChangeError(403, "Park access context is required");
    return { user, tenantId: user.tenantId };
  };
  const changeMetadata = z.object({
    expectedVersion: z.number().int().nonnegative().optional(),
    mutationId: z.string().uuid().optional(),
  }).refine(value => (value.expectedVersion === undefined) === (value.mutationId === undefined),
    { message: "Save version and identifier must be supplied together" });

  app.get("/api/sops/:id/revisions", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const before = req.query.beforeVersion === undefined ? undefined : Number(req.query.beforeVersion);
      if (before !== undefined && (!Number.isInteger(before) || before < 0))
        return res.status(400).json({ message: "Invalid history page" });
      res.json(await listSopRevisions(req.params.id, historyActor(req), before));
    } catch (error) {
      if (error instanceof SopChangeError) return res.status(error.status).json({ message: error.message });
      next(error);
    }
  });

  app.get("/api/sops/:id/revisions/:revisionId", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      res.json(await getSopRevision(req.params.id, req.params.revisionId, historyActor(req)));
    } catch (error) {
      if (error instanceof SopChangeError) return res.status(error.status).json({ message: error.message });
      next(error);
    }
  });

  app.post("/api/sops/:id/revisions/:revisionId/restore", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const metadata = changeMetadata.safeParse(req.body);
      if (!metadata.success || !metadata.data.mutationId)
        return res.status(400).json({ message: "Reload the SOP before restoring a version" });
      res.json(await changeSopArticle(req.params.id, historyActor(req),
        { ...metadata.data, restoreRevisionId: req.params.revisionId }));
    } catch (error) {
      if (error instanceof SopChangeError) return res.status(error.status).json({ message: error.message });
      next(error);
    }
  });

  // List SOP articles with branch filtering
  app.get("/api/sops", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as UserWithBranchAccess;
      const tenantId = await resolveTenantId(user.tenantId);
      const requestedBranchId = req.query.branchId;
      if (requestedBranchId != null && typeof requestedBranchId !== 'string') {
        return res.status(400).json({ message: "Invalid branch" });
      }
      if (requestedBranchId === 'all' && !user.hasAllBranchesAccess) {
        return res.status(403).json({ message: "All-branch access is not available" });
      }
      if (requestedBranchId && requestedBranchId !== 'all') {
        if (!canUserAccessBranch(user, requestedBranchId)) {
          return res.status(403).json({ message: "Access denied to this branch" });
        }
        const branch = await storage.getBranch(requestedBranchId);
        if (!branch || branch.tenantId !== tenantId) {
          return res.status(404).json({ message: "Branch not found" });
        }
      }
      const articles = (await storage.getSopArticles(tenantId)).filter(article =>
        canReadSopArticle(user, article, tenantId) &&
        (!requestedBranchId || requestedBranchId === 'all' || article.scope === 'GLOBAL' || (article.branchIds || []).includes(requestedBranchId))
      );
      res.json(articles);
    } catch (error) {
      next(error);
    }
  });

  // Get single SOP article
  app.get("/api/sops/:id", requireAuth, async (req, res, next) => {
    try {
      const { id } = req.params;
      const article = await storage.getSopArticle(id);
      if (!article) {
        return res.status(404).json({ message: "SOP article not found" });
      }
      const user = req.user as UserWithBranchAccess;
      const tenantId = await resolveTenantId(user.tenantId);
      if (!canReadSopArticle(user, article, tenantId)) {
        return res.status(404).json({ message: "SOP article not found" });
      }
      res.json(article);
    } catch (error) {
      next(error);
    }
  });

  // Server-side validation for structuredSteps to prevent DoS via oversized base64 payloads
  const validateStructuredSteps = (steps: unknown): { valid: boolean; error?: string } => {
    if (steps == null) return { valid: true };
    if (!Array.isArray(steps)) return { valid: false, error: 'Steps must be a list' };

    const maxImageSizeBytes = 3 * 1024 * 1024; // 3MB max per image (base64 is ~33% larger than binary)
    const maxSteps = 50; // Reasonable limit on number of steps

    if (steps.length > maxSteps) {
      return { valid: false, error: `Maximum ${maxSteps} steps allowed` };
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as { imageUrl?: string; title?: string };
      if (!step || typeof step !== 'object' || (step.title != null && typeof step.title !== 'string') ||
          (step.imageUrl != null && typeof step.imageUrl !== 'string')) {
        return { valid: false, error: `Step ${i + 1} is invalid` };
      }

      // Validate step title length
      if (step.title && step.title.length > 500) {
        return { valid: false, error: `Step ${i + 1} title too long (max 500 chars)` };
      }

      // Validate image size if present
      if (step.imageUrl && step.imageUrl.startsWith('data:')) {
        const base64Length = step.imageUrl.length;
        const estimatedBytes = (base64Length * 3) / 4;

        if (estimatedBytes > maxImageSizeBytes) {
          return { valid: false, error: `Step ${i + 1} image exceeds 3MB limit` };
        }

        // Validate image type
        const validPrefixes = ['data:image/jpeg', 'data:image/png', 'data:image/gif', 'data:image/webp'];
        if (!validPrefixes.some(p => step.imageUrl?.startsWith(p))) {
          return { valid: false, error: `Step ${i + 1} has invalid image type (JPEG, PNG, GIF, WebP only)` };
        }
      }
    }

    return { valid: true };
  };

  const validSopBranches = async (user: UserWithBranchAccess, tenantId: string, scope: string, branchIds: string[]) => {
    if (scope === 'GLOBAL') return branchIds.length === 0;
    if (scope !== 'BRANCHES' || branchIds.length === 0 || new Set(branchIds).size !== branchIds.length ||
        branchIds.some(id => !canUserAccessBranch(user, id))) return false;
    const branches = await Promise.all(branchIds.map(id => storage.getBranch(id)));
    return branches.every(branch => branch?.tenantId === tenantId);
  };

  // Create SOP article (admin only)
  app.post("/api/sops", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const user = req.user as UserWithBranchAccess;
      const tenantId = await resolveTenantId(user.tenantId);

      // Server-side validation for structuredSteps
      const stepsValidation = validateStructuredSteps(req.body.structuredSteps);
      if (!stepsValidation.valid) {
        return res.status(400).json({ message: stepsValidation.error });
      }

      const parsed = insertSopArticleSchema.safeParse({
        ...req.body,
        tenantId,
        scope: req.body.scope || 'GLOBAL',
        branchIds: req.body.branchIds || [],
      });
      if (!parsed.success || !Array.isArray(parsed.data.branchIds) ||
          !(await validSopBranches(user, tenantId, parsed.data.scope || 'GLOBAL', parsed.data.branchIds))) {
        return res.status(400).json({ message: 'Invalid SOP article or branch scope' });
      }
      const article = await storage.createSopArticle(parsed.data);
      res.status(201).json(article);
    } catch (error) {
      next(error);
    }
  });

  // Update SOP article (admin only)
  app.patch("/api/sops/:id", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const { id } = req.params;
      const actor = historyActor(req);
      const { user, tenantId } = actor;
      const existing = await storage.getSopArticle(id);
      if (!existing || existing.tenantId !== tenantId) {
        return res.status(404).json({ message: "SOP article not found" });
      }

      // Server-side validation for structuredSteps
      if (req.body.structuredSteps !== undefined) {
        const stepsValidation = validateStructuredSteps(req.body.structuredSteps);
        if (!stepsValidation.valid) {
          return res.status(400).json({ message: stepsValidation.error });
        }
      }

      const parsed = insertSopArticleSchema.partial().safeParse(req.body);
      if (!parsed.success || (parsed.data.tenantId && parsed.data.tenantId !== tenantId)) {
        return res.status(400).json({ message: 'Invalid SOP article' });
      }
      const changes = { ...parsed.data };
      delete changes.tenantId;
      const scope = changes.scope || existing.scope;
      const branchIds = changes.branchIds || existing.branchIds || [];
      if (!Array.isArray(branchIds) || !(await validSopBranches(user, tenantId, scope, branchIds))) {
        return res.status(400).json({ message: 'Invalid SOP branch scope' });
      }
      const metadata = changeMetadata.safeParse(req.body);
      if (!metadata.success) return res.status(400).json({ message: "Invalid SOP save version or identifier" });
      const article = await changeSopArticle(id, actor, { ...metadata.data, changes });
      res.json(article);
    } catch (error) {
      if (error instanceof SopChangeError) return res.status(error.status).json({ message: error.message });
      next(error);
    }
  });

  // Delete SOP article (admin only)
  app.delete("/api/sops/:id", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await storage.getSopArticle(id);
      const user = req.user as UserWithBranchAccess;
      const tenantId = await resolveTenantId(user.tenantId);
      if (!existing || existing.tenantId !== tenantId) {
        return res.status(404).json({ message: "SOP article not found" });
      }
      await storage.deleteSopArticle(id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

}
