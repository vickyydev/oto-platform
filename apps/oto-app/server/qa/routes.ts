import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { QaContext } from "../../shared/qa-reports";
import { addAttachment, appendMessage, createReport, getAttachment, getReportDetail, listReports, qaPool, QaStoreError, queueReport, type QaOwner } from "./store";
import { putQaAttachment, qaAttachmentKey, QA_CONTENT_TYPES, QA_MAX_ATTACHMENT_BYTES, readQaObject, validateQaAttachment } from "./media";

const messageSchema = z.object({ message: z.string().trim().min(1).max(12000), clientRequestId: z.string().uuid() });
const contextSchema = z.object({
  path: z.string().max(1000), branchId: z.string().uuid().optional(), role: z.string().max(80).optional(),
  browser: z.string().max(300).optional(), locale: z.string().max(40).optional(), timezone: z.string().max(80).optional(),
  viewport: z.object({ width: z.number().int().min(1).max(10000), height: z.number().int().min(1).max(10000) }).optional(),
});
const createSchema = messageSchema.extend({ context: contextSchema });
// Busboy counts the final boundary toward its parts threshold. The file and
// field limits still permit exactly one file and no form text fields.
export const qaEvidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: QA_MAX_ATTACHMENT_BYTES, files: 1, fields: 0, parts: 2 },
  fileFilter: (_req, file, cb) => {
    if (!(QA_CONTENT_TYPES as readonly string[]).includes(file.mimetype)) return cb(new QaStoreError(415, "Choose a PNG, JPEG, WebP screenshot or an MP4/WebM video"));
    cb(null, true);
  },
}).single("file");

export const qaEnabled = (): boolean => process.env.QA_REPORTS_ENABLED === "true";
const appVersion = () => /^[a-f0-9]{40}$/i.test(process.env.RENDER_GIT_COMMIT ?? "") ? process.env.RENDER_GIT_COMMIT! : "unknown";
const uuid = (id: unknown): string => {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new QaStoreError(404, "Report not found");
  return parsed.data;
};

/** The current app access record is loaded by the authenticated app middleware. */
function owner(req: Request): QaOwner {
  if (!req.isAuthenticated() || !req.user?.id) throw new QaStoreError(401, "Authentication required");
  const current = req.userWithAccess;
  if (!current?.tenantId || current.id !== req.user.id || !current.isActive) throw new QaStoreError(403, "Current park access is required");
  return { tenantId: current.tenantId, userId: req.user.id };
}

export function sameOriginQaWrite(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) { next(); return; }
  const origin = req.get("origin");
  if (req.get("sec-fetch-site") === "cross-site" || (origin && origin !== `${req.protocol}://${req.get("host")}`)) {
    res.status(403).json({ message: "Use the reporting assistant from this app" }); return;
  }
  next();
}

const safeName = (name: string) => [...name.split(/[\\/]/).pop()!].filter(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127).join("").slice(0, 180) || "Evidence";
const route = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res) => {
  void handler(req, res).catch(error => {
    if (error instanceof QaStoreError) { res.status(error.status).json({ message: error.message }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ message: "Check the report text and context, then try again" }); return; }
    // Provider and SQL details can contain private inputs; they never become an API message.
    res.status(503).json({ message: "The reporting service is temporarily unavailable. Your saved report remains available." });
  });
};

export function registerQaRoutes(app: Express, requireAuth: RequestHandler): void {
  app.use("/api/qa-reports", requireAuth, (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    try { owner(req); next(); } catch (error) {
      res.status(error instanceof QaStoreError ? error.status : 403).json({ message: "Current app access is required" });
    }
  }, sameOriginQaWrite);

  app.get("/api/qa-reports/config", (_req, res) => res.json({
    enabled: qaEnabled(), version: appVersion(), acceptsVideo: true, audioTranscription: false,
  }));
  app.get("/api/qa-reports", route(async (req, res) => res.json({ reports: await listReports(owner(req)) })));
  app.post("/api/qa-reports", route(async (req, res) => {
    const input = createSchema.parse(req.body);
    const path = input.context.path.split(/[?#]/)[0];
    if (!path.startsWith("/") || path.startsWith("//") || [...path].some(char => char.charCodeAt(0) < 32)) throw new QaStoreError(400, "Use an app page path in the report context");
    const caller = owner(req);
    if (input.context.branchId) {
      const branch = await qaPool.query("SELECT id FROM branches WHERE id=$1 AND tenant_id=$2", [input.context.branchId, caller.tenantId]);
      if (!branch.rows[0]) throw new QaStoreError(403, "Use a branch in your current park");
    }
    const context: QaContext = { ...input.context, path, role: req.userWithAccess!.role, appVersion: appVersion() };
    const saved = await createReport(caller, input.message, input.clientRequestId, context);
    res.status(201).json(saved);
  }));
  app.get("/api/qa-reports/:id", route(async (req, res) => res.json(await getReportDetail(owner(req), uuid(req.params.id)))));
  app.post("/api/qa-reports/:id/messages", route(async (req, res) => {
    const input = messageSchema.parse(req.body);
    res.json(await appendMessage(owner(req), uuid(req.params.id), input.message, input.clientRequestId));
  }));
  app.post("/api/qa-reports/:id/analyze", route(async (req, res) => {
    res.json(await queueReport(owner(req), uuid(req.params.id)));
  }));

  // Check report ownership before accepting even the multipart body into memory.
  app.post("/api/qa-reports/:id/attachments", route(async (req, res) => {
    const caller = owner(req);
    const id = uuid(req.params.id);
    await getReportDetail(caller, id);
    await new Promise<void>((resolve, reject) => qaEvidenceUpload(req, res, error => {
      if (error instanceof multer.MulterError) reject(new QaStoreError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "Upload one evidence file of up to 25 MiB"));
      else if (error) reject(error); else resolve();
    }));
    if (!req.file) throw new QaStoreError(400, "Choose an evidence file");
    try { validateQaAttachment(req.file.buffer, req.file.mimetype); } catch { throw new QaStoreError(415, "The evidence bytes do not match a supported image or video type"); }
    const attachmentId = uuid(req.get("X-QA-Attachment-Id"));
    const name = safeName(req.file.originalname);
    const objectKey = qaAttachmentKey(caller.tenantId, id, attachmentId);
    const sha256 = createHash("sha256").update(req.file.buffer).digest("hex");
    const file = req.file;
    const attachment = await addAttachment(caller, id, { id: attachmentId, name, contentType: file.mimetype, size: file.size, objectKey, sha256 }, async () => {
      await putQaAttachment({ tenantId: caller.tenantId, reportId: id, attachmentId, name, buffer: file.buffer, contentType: file.mimetype });
    });
    // A lost commit response may leave a durable row. Never remove its private object on an uncertain commit.
    res.status(201).json({ attachment });
  }));
  app.get("/api/qa-reports/:id/attachments/:attachmentId", route(async (req, res) => {
    const attachment = await getAttachment(owner(req), uuid(req.params.id), uuid(req.params.attachmentId));
    const buffer = await readQaObject(attachment.objectKey);
    if (buffer.length !== attachment.size || createHash("sha256").update(buffer).digest("hex") !== attachment.sha256) throw new QaStoreError(503, "This evidence is temporarily unavailable");
    validateQaAttachment(buffer, attachment.contentType);
    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/'/g, "%27")}`);
    res.send(buffer);
  }));

  if (qaEnabled()) {
    // This does not delay sign-in or expose storage configuration if publishing is unavailable.
    void import("./source-index").then(module => module.publishBundledSourceIndex()).catch(() => undefined);
  }
}
