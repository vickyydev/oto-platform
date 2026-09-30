import { Router, Request, Response, NextFunction } from "express";
import { db } from "./db";
import { eq, and, desc, sql, gte, or, ilike, inArray } from "drizzle-orm";
import { serviceCheckins, dropoffCheckins, nannyReservations, employeeRoleAvailability } from "./db/coreSchema";
import { employees, employeePresence, branches, roles, employeeRoles, tenants, DEFAULT_TENANT_SLUG } from "@shared/schema";
import { requireAuth } from "./auth";
import { requireManager, getAllowedOperatorAndBranchIds } from "./auth-middleware";
import type { UserWithBranchAccess } from "@shared/schema";
import { z } from "zod";
import crypto from "crypto";
import QRCode from "qrcode";
import multer from "multer";
import path from "path";
import fs from "fs";
import { uploadToObjectStorage, getFileFromObjectStorage } from "./file-storage";
import { getEmployeeDisplayName } from "./lib/employeeDisplayName";
import { hashSessionToken, validateKioskSession } from "./kiosk-auth";

async function requireAuthOrKiosk(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const tokenHash = hashSessionToken(token);
    const session = await validateKioskSession(tokenHash);
    if (session) {
      req.kioskSession = session;
      return next();
    }
  }
  
  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    return next();
  }
  
  return res.status(401).json({ message: "Authentication required" });
}

// Legacy: local storage fallback for uploads
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Use memory storage for dropoff checkin photos (upload to object storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  },
});

async function getDefaultTenantId(): Promise<string> {
  const result = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  if (!result.length) throw new Error(`Default tenant ${DEFAULT_TENANT_SLUG} not found`);
  return result[0].id;
}

async function canAccessCheckinBranch(req: Request, branchId: string): Promise<boolean> {
  if (req.kioskSession) return req.kioskSession.branchId === branchId;
  if (!req.user) return false;
  const scope = await getAllowedOperatorAndBranchIds(req.user as UserWithBranchAccess);
  return scope.branchIds === null || scope.branchIds.includes(branchId);
}

async function requireCheckinBranch(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = await getDefaultTenantId();
    const [checkin] = await db.select({ branchId: serviceCheckins.branchId })
      .from(serviceCheckins)
      .where(and(eq(serviceCheckins.id, req.params.id), eq(serviceCheckins.tenantId, tenantId)));
    if (!checkin) return res.status(404).json({ message: "Check-in not found" });
    if (!await canAccessCheckinBranch(req, checkin.branchId)) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }
    next();
  } catch (error) {
    next(error);
  }
}

function generateBranchToken(branchId: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is required for token generation");
  }
  return crypto.createHmac("sha256", secret).update(`checkin:${branchId}`).digest("hex").substring(0, 16);
}

function validateBranchToken(branchId: string, token: string): boolean {
  try {
    const expected = generateBranchToken(branchId);
    if (expected.length !== token.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

const router = Router();

const PRIVATE_DROPOFF_PHOTOS = "dropoff-photos-private";
const PRIVATE_DROPOFF_SIGNATURES = "dropoff-signatures-private";
const PHOTO_SHARE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function photoShareSignature(checkinId: string, photoUrl: string, expires: number): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for photo sharing");
  return crypto.createHmac("sha256", secret)
    .update(`dropoff-photo:${checkinId}:${photoUrl}:${expires}`)
    .digest("hex");
}

function sharedCheckinPhotoUrl(checkin: typeof serviceCheckins.$inferSelect): string | null {
  const photoUrl = checkin.photoUrl;
  if (!photoUrl) return null;
  if (!photoUrl.startsWith(`/api/files/${PRIVATE_DROPOFF_PHOTOS}/`)) return photoUrl;
  const expires = Date.now() + PHOTO_SHARE_LIFETIME_MS;
  const signature = photoShareSignature(checkin.id, photoUrl, expires);
  return `/api/public/dropoff-photo/${checkin.id}?expires=${expires}&sig=${signature}`;
}

router.get("/api/public/dropoff-photo/:id", async (req: Request, res: Response) => {
  const expiresRaw = req.query.expires;
  const signature = req.query.sig;
  const expires = typeof expiresRaw === "string" ? Number(expiresRaw) : NaN;
  if (!Number.isSafeInteger(expires) || expires <= Date.now() ||
      expires > Date.now() + PHOTO_SHARE_LIFETIME_MS + 60_000 ||
      typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) {
    return res.status(404).json({ message: "Photo link unavailable" });
  }
  try {
    const [checkin] = await db.select({ id: serviceCheckins.id, photoUrl: serviceCheckins.photoUrl })
      .from(serviceCheckins).where(eq(serviceCheckins.id, req.params.id)).limit(1);
    const filename = /^\/api\/files\/dropoff-photos-private\/([a-zA-Z0-9._-]+)$/.exec(checkin?.photoUrl || "")?.[1];
    if (!checkin?.photoUrl || !filename) return res.status(404).json({ message: "Photo link unavailable" });
    const expected = photoShareSignature(checkin.id, checkin.photoUrl, expires);
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(404).json({ message: "Photo link unavailable" });
    }
    const photo = await getFileFromObjectStorage(PRIVATE_DROPOFF_PHOTOS, filename);
    if (!photo) return res.status(404).json({ message: "Photo link unavailable" });
    res.setHeader("Content-Type", photo.contentType);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    photo.stream.pipe(res);
  } catch (error) {
    console.error("[Checkin] Failed to serve shared photo", error);
    res.status(500).json({ message: "Photo unavailable" });
  }
});

async function serveDropoffSignature(req: Request, res: Response, folder: string) {
  const filename = req.params.filename;
  if (!["dropoff-signatures", PRIVATE_DROPOFF_SIGNATURES].includes(folder) ||
      !/^[a-zA-Z0-9._-]+$/.test(filename) || filename === "." || filename === "..") {
    return res.status(404).json({ message: "Signature not found" });
  }
  const tenantId = req.kioskSession?.tenantId ?? (req.user as UserWithBranchAccess | undefined)?.tenantId;
  if (!tenantId) return res.status(403).json({ message: "Access denied" });
  const paths = [`/api/files/${folder}/${filename}`, `/uploads/${folder}/${filename}`];
  try {
    const [serviceRows, dropoffRows] = await Promise.all([
      db.select({ branchId: serviceCheckins.branchId }).from(serviceCheckins)
        .where(and(eq(serviceCheckins.tenantId, tenantId), inArray(serviceCheckins.consentSignature, paths))).limit(1),
      db.select({ branchId: dropoffCheckins.branchId }).from(dropoffCheckins)
        .where(and(eq(dropoffCheckins.tenantId, tenantId), inArray(dropoffCheckins.signatureUrl, paths))).limit(1),
    ]);
    const branchId = serviceRows[0]?.branchId ?? dropoffRows[0]?.branchId;
    if (!branchId || !await canAccessCheckinBranch(req, branchId)) {
      return res.status(404).json({ message: "Signature not found" });
    }
    const signature = await getFileFromObjectStorage(folder, filename);
    if (!signature) return res.status(404).json({ message: "Signature not found" });
    res.setHeader("Content-Type", signature.contentType);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    signature.stream.pipe(res);
  } catch (error) {
    console.error("[Checkin] Failed to serve signature", error);
    res.status(500).json({ message: "Signature unavailable" });
  }
}

router.get("/api/files/dropoff-signatures/:filename", requireAuthOrKiosk,
  (req, res) => serveDropoffSignature(req, res, "dropoff-signatures"));
router.get("/api/files/dropoff-signatures-private/:filename", requireAuthOrKiosk,
  (req, res) => serveDropoffSignature(req, res, PRIVATE_DROPOFF_SIGNATURES));

const publicCheckinSchema = z.object({
  branchId: z.string(),
  branchToken: z.string().min(16).max(16),
  serviceType: z.enum(["dropoff", "nanny"]),
  parentFullName: z.string().min(1),
  whatsappPhoneRaw: z.string().min(1),
  childFullName: z.string().min(1),
  childAge: z.number().optional(),
  requestedDurationMinutes: z.number().min(30).max(480),
  allergiesMedicalDetails: z.string().optional(),
  foodNotesRestrictions: z.string().optional(),
  consentSigned: z.literal(true, { message: "Consent is required" }),
  consentSignature: z.string().optional(),
  consentSignedName: z.string().min(1, "Signature name is required"),
});

router.post("/api/public/checkins", async (req: Request, res: Response) => {
  try {
    const parsed = publicCheckinSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", errors: parsed.error.errors });
    }

    const { branchId, branchToken, serviceType, parentFullName, whatsappPhoneRaw, childFullName, childAge, requestedDurationMinutes, allergiesMedicalDetails, foodNotesRestrictions, consentSigned, consentSignature, consentSignedName } = parsed.data;

    if (!validateBranchToken(branchId, branchToken)) {
      return res.status(403).json({ message: "Invalid branch token" });
    }

    const branch = await db.select().from(branches).where(eq(branches.id, branchId)).limit(1);
    if (!branch.length) {
      return res.status(404).json({ message: "Branch not found" });
    }

    const tenantId = branch[0].tenantId;
    const requestedEndAt = new Date(Date.now() + requestedDurationMinutes * 60 * 1000);

    const [checkin] = await db.insert(serviceCheckins).values({
      tenantId,
      branchId,
      status: "registered",
      serviceType,
      parentFullName,
      whatsappPhoneRaw,
      childFullName,
      childAge: childAge || null,
      requestedDurationMinutes,
      requestedEndAt,
      allergiesMedicalDetails: allergiesMedicalDetails || null,
      foodNotesRestrictions: foodNotesRestrictions || null,
      consentSigned: consentSigned || false,
      consentSignature: consentSignature || null,
      consentSignedName: consentSignedName || null,
      consentSignedAt: consentSigned ? new Date() : null,
    }).returning();

    res.status(201).json(checkin);
  } catch (error: any) {
    console.error("[Checkin] POST /api/public/checkins error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/api/core/branches/:branchId/checkin-token", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { branchId } = req.params;
    if (!await canAccessCheckinBranch(req, branchId)) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }
    const token = generateBranchToken(branchId);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const checkinUrl = `${baseUrl}/checkin/${branchId}/${token}`;
    res.json({ token, checkinUrl });
  } catch (error: any) {
    console.error("[Checkin] GET /api/core/branches/:branchId/checkin-token error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/api/admin/branches/:branchId/qr", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { branchId } = req.params;
    if (!await canAccessCheckinBranch(req, branchId)) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }
    const token = generateBranchToken(branchId);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const formUrl = `${baseUrl}/checkin/${branchId}/${token}`;
    
    const qrDataUrl = await QRCode.toDataURL(formUrl, {
      width: 512,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
    
    res.json({ qrDataUrl, formUrl });
  } catch (error: any) {
    console.error("[Checkin] GET /api/admin/branches/:branchId/qr error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/api/public/branch-info/:branchId", async (req: Request, res: Response) => {
  try {
    const { branchId } = req.params;
    const branch = await db.select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);
    
    if (!branch.length) {
      return res.status(404).json({ message: "Branch not found" });
    }
    
    res.json(branch[0]);
  } catch (error: any) {
    console.error("[Checkin] GET /api/public/branch-info error:", error);
    res.status(500).json({ message: error.message });
  }
});

const dropoffCheckinSchema = z.object({
  branchId: z.string().min(1, "Branch ID is required"),
  branchToken: z.string().min(16).max(16, "Invalid token"),
  parentFullName: z.string().min(2, "Parent name is required"),
  contactMethod: z.enum(["whatsapp", "telegram"]).optional().default("whatsapp"),
  whatsappPhone: z.string().optional(),
  telegramPhone: z.string().optional(),
  children: z.string().min(1, "Children data is required"),
  hasAllergiesOrMedical: z.enum(["true", "false"]),
  allergiesMedicalDetails: z.string().optional(),
  allowStaffOrderFood: z.enum(["true", "false"]),
  foodNotesRestrictions: z.string().optional(),
  confirmMall15min: z.literal("true"),
  confirmEarlyPickupRefund: z.literal("true"),
  confirmEvacLoadingBay: z.literal("true"),
  signature: z.string().min(1, "Signature is required"),
}).refine((data) => {
  // Conditional validation: require whatsapp phone if contact method is whatsapp
  if (data.contactMethod === "whatsapp") {
    return data.whatsappPhone && data.whatsappPhone.length >= 5;
  }
  return true;
}, { message: "WhatsApp phone number is required", path: ["whatsappPhone"] })
.refine((data) => {
  // Conditional validation: require telegram phone if contact method is telegram
  if (data.contactMethod === "telegram") {
    return data.telegramPhone && data.telegramPhone.length >= 5;
  }
  return true;
}, { message: "Telegram phone number is required", path: ["telegramPhone"] })
.refine((data) => data.hasAllergiesOrMedical !== "true" || !!data.allergiesMedicalDetails?.trim(),
  { message: "Allergy or medical details are required", path: ["allergiesMedicalDetails"] });

const childSchema = z.object({
  name: z.string().min(1, "Child name is required"),
  age: z.string().min(1, "Child age is required"),
});

function runMulterSingle(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single("photo")(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

router.post("/api/public/dropoff-checkin", async (req: Request, res: Response) => {
  // Run multer inside the async handler so errors return a proper JSON response
  // instead of dropping the TCP connection (which causes "Failed to fetch" on the client)
  try {
    await runMulterSingle(req, res);
  } catch (multerErr: any) {
    console.error("[Checkin] Multer error on dropoff-checkin upload:", multerErr.message);
    return res.status(400).json({ message: multerErr.message || "File upload error. Please check the photo and try again." });
  }

  try {
    // Check if this is a schema-based form submission (has formData JSON field)
    let requestBody = req.body;
    if (req.body.formData) {
      try {
        const schemaFormData = JSON.parse(req.body.formData);
        // Map schema form field IDs to expected field names
        // Note: branchToken must be provided by client - no fallback to prevent bypass
        // Get children from either req.body.children (sent as separate FormData field) 
        // or from schemaFormData (when embedded in the form data JSON)
        let childrenValue = req.body.children;
        if (!childrenValue && (schemaFormData.children_section || schemaFormData.children_group)) {
          childrenValue = JSON.stringify(
            (schemaFormData.children_section || schemaFormData.children_group || []).map((c: any) => ({
              name: c.child_name || c.name || "",
              age: c.child_age || c.age || ""
            }))
          );
        }
        
        requestBody = {
          branchId: req.body.branchId,
          branchToken: req.body.branchToken,
          parentFullName: schemaFormData.parent_full_name || schemaFormData.parent_name || schemaFormData.guardian_name || "",
          contactMethod: schemaFormData.contact_method || "whatsapp",
          whatsappPhone: schemaFormData.whatsapp_phone || schemaFormData.whatsapp_number || req.body.whatsappPhone || "",
          telegramPhone: schemaFormData.telegram_phone || req.body.telegramPhone || "",
          children: childrenValue,
          hasAllergiesOrMedical: (schemaFormData.has_allergies_or_medical ?? schemaFormData.has_allergies_medical ?? schemaFormData.allergies_medical) === "yes" ? "true" : "false",
          allergiesMedicalDetails: schemaFormData.allergies_medical_details || schemaFormData.allergies_details || "",
          allowStaffOrderFood: (schemaFormData.allow_staff_order_food ?? schemaFormData.allow_food_order) === "yes" ? "true" : "false",
          foodNotesRestrictions: schemaFormData.food_notes_restrictions || schemaFormData.food_restrictions || "",
          confirmMall15min: (schemaFormData.confirm_mall_15min ?? schemaFormData.confirm_15min ?? (req.body.confirmMall15min === "true")) === true ? "true" : "false",
          confirmEarlyPickupRefund: (schemaFormData.confirm_early_pickup_refund ?? schemaFormData.confirm_refund ?? (req.body.confirmEarlyPickupRefund === "true")) === true ? "true" : "false",
          confirmEvacLoadingBay: (schemaFormData.confirm_evac_loading_bay ?? schemaFormData.confirm_evac ?? (req.body.confirmEvacLoadingBay === "true")) === true ? "true" : "false",
          signature: schemaFormData.consent_signature || schemaFormData.signature || req.body.signature || "",
        };
      } catch (e) {
        console.warn("[Checkin] Failed to parse formData JSON, using req.body directly");
      }
    }
    
    const parsed = dropoffCheckinSchema.safeParse(requestBody);
    if (!parsed.success) {
      const errorMessages = parsed.error.errors.map(e => e.message).join(", ");
      return res.status(400).json({ message: errorMessages });
    }

    const { branchId, branchToken, parentFullName, contactMethod, whatsappPhone, telegramPhone, children, hasAllergiesOrMedical, allergiesMedicalDetails, allowStaffOrderFood, foodNotesRestrictions, signature } = parsed.data;

    // Normalize telegram phone
    const normalizedTelegramPhone = telegramPhone?.trim() || null;

    if (!validateBranchToken(branchId, branchToken)) {
      return res.status(403).json({ message: "Invalid link. Please scan the QR code at reception." });
    }

    const branch = await db.select().from(branches).where(eq(branches.id, branchId)).limit(1);
    if (!branch.length) {
      return res.status(400).json({ message: "Invalid branch" });
    }

    let childrenData: Array<{ name: string; age: string }>;
    try {
      childrenData = JSON.parse(children);
      if (!Array.isArray(childrenData) || childrenData.length === 0) {
        return res.status(400).json({ message: "At least one child is required" });
      }
      for (const child of childrenData) {
        const childParsed = childSchema.safeParse(child);
        if (!childParsed.success) {
          return res.status(400).json({ message: "Invalid child data: name and age are required" });
        }
      }
    } catch {
      return res.status(400).json({ message: "Invalid children data format" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Photo is required" });
    }

    const tenantId = branch[0].tenantId;

    let signatureUrl: string | null = null;
    if (signature && signature.startsWith("data:image")) {
      const base64Data = signature.replace(/^data:image\/\w+;base64,/, "");
      const signatureBuffer = Buffer.from(base64Data, "base64");
      const signatureFilename = `sig-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
      try {
        signatureUrl = await uploadToObjectStorage(signatureBuffer, PRIVATE_DROPOFF_SIGNATURES, signatureFilename, "image/png");
        console.log(`[Checkin] Signature uploaded for branch ${branchId}: ${signatureFilename}`);
      } catch (uploadErr: any) {
        console.error(`[Checkin] Signature upload failed — branchId=${branchId} file=${signatureFilename} error=${uploadErr.message}`, uploadErr.stack);
        return res.status(500).json({ message: "Failed to save signature. Please try again." });
      }
    } else {
      return res.status(400).json({ message: "Valid signature image is required" });
    }

    // Upload photo to object storage
    const photoExtension = req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
    const photoFilename = `dropoff_${Date.now()}_${Math.round(Math.random() * 1e9)}.${photoExtension}`;
    let photoUrl: string;
    try {
      photoUrl = await uploadToObjectStorage(req.file.buffer, PRIVATE_DROPOFF_PHOTOS, photoFilename, req.file.mimetype);
      console.log(`[Checkin] Photo uploaded for branch ${branchId}: ${photoFilename} (${req.file.size} bytes)`);
    } catch (uploadErr: any) {
      console.error(`[Checkin] Photo upload failed — branchId=${branchId} file=${photoFilename} size=${req.file.size} error=${uploadErr.message}`, uploadErr.stack);
      return res.status(500).json({ message: "Failed to save photo. Please try again." });
    }

    const [checkin] = await db.insert(dropoffCheckins).values({
      tenantId,
      branchId,
      parentFullName,
      whatsappPhone: whatsappPhone || "",
      contactMethod: contactMethod || "whatsapp",
      whatsappPhoneE164: contactMethod === "whatsapp" ? whatsappPhone : null,
      telegramUsername: normalizedTelegramPhone,
      children: childrenData,
      hasAllergiesOrMedical: hasAllergiesOrMedical === "true",
      allergiesMedicalDetails: allergiesMedicalDetails || null,
      allowStaffOrderFood: allowStaffOrderFood === "true",
      foodNotesRestrictions: foodNotesRestrictions || null,
      photoUrl,
      signatureUrl,
    }).returning();

    // Create serviceCheckins entries for each child so staff can manage them in Core
    const serviceCheckinIds: string[] = [];
    for (const child of childrenData) {
      const childAge = parseInt(child.age);
      if (isNaN(childAge) || childAge < 3 || childAge > 8) {
        console.warn(`[Checkin] Invalid child age: ${child.age}, defaulting to 5`);
      }
      const validAge = isNaN(childAge) ? 5 : Math.max(3, Math.min(8, childAge));
      // Suggest service type based on age: 3-5 = nanny, 6-8 = dropoff
      const suggestedServiceType = validAge <= 5 ? "nanny" : "dropoff";
      
      const [sc] = await db.insert(serviceCheckins).values({
        tenantId,
        branchId,
        status: "registered",
        serviceType: suggestedServiceType,
        parentFullName,
        contactMethod: contactMethod || "whatsapp",
        whatsappPhoneRaw: whatsappPhone || "",
        whatsappPhoneE164: contactMethod === "whatsapp" ? whatsappPhone : null,
        telegramUsername: normalizedTelegramPhone,
        childFullName: child.name,
        childAge: validAge,
        allergiesMedicalDetails: (hasAllergiesOrMedical === "true" && allergiesMedicalDetails) ? allergiesMedicalDetails : null,
        foodNotesRestrictions: (allowStaffOrderFood === "true" && foodNotesRestrictions) ? foodNotesRestrictions : null,
        photoUrl,
        consentSigned: true,
        consentSignature: signatureUrl,
        consentSignedAt: new Date(),
      }).returning();
      serviceCheckinIds.push(sc.id);
    }

    res.json({ success: true, id: checkin.id, serviceCheckinIds });
  } catch (error: any) {
    console.error("[Checkin] POST /api/public/dropoff-checkin error:", error);
    res.status(500).json({ message: error.message || "Server error" });
  }
});

router.get("/api/core/checkins", requireAuthOrKiosk, async (req: Request, res: Response) => {
  try {
    const tenantId = req.kioskSession?.tenantId ?? (req.user as UserWithBranchAccess | undefined)?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Tenant access required" });
    const { branchId, status, type, q } = req.query;

    const conditions = [eq(serviceCheckins.tenantId, tenantId)];

    if (branchId && typeof branchId !== "string") {
      return res.status(400).json({ message: "Invalid branch" });
    }
    if (req.kioskSession) {
      if (branchId && branchId !== req.kioskSession.branchId) {
        return res.status(403).json({ message: "Access denied to this branch" });
      }
      conditions.push(eq(serviceCheckins.branchId, req.kioskSession.branchId));
    } else {
      const scope = await getAllowedOperatorAndBranchIds(req.user as UserWithBranchAccess);
      if (scope.branchIds !== null) {
        if (branchId && !scope.branchIds.includes(branchId)) {
          return res.status(403).json({ message: "Access denied to this branch" });
        }
        if (scope.branchIds.length === 0) return res.json([]);
        conditions.push(inArray(serviceCheckins.branchId, scope.branchIds));
      }
      if (branchId) conditions.push(eq(serviceCheckins.branchId, branchId));
    }
    
    if (status && typeof status === "string") {
      conditions.push(eq(serviceCheckins.status, status));
    }
    
    if (type && typeof type === "string" && type !== "all") {
      conditions.push(eq(serviceCheckins.serviceType, type));
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    conditions.push(gte(serviceCheckins.registeredAt, todayStart));

    const results = await db.select().from(serviceCheckins)
      .where(and(...conditions))
      .orderBy(desc(serviceCheckins.registeredAt));

    let filtered = results;
    if (q && typeof q === "string") {
      const searchLower = q.toLowerCase();
      filtered = results.filter(c => 
        c.parentFullName?.toLowerCase().includes(searchLower) ||
        c.childFullName?.toLowerCase().includes(searchLower) ||
        c.whatsappPhoneRaw?.includes(q)
      );
    }

    res.json(filtered.map(checkin => ({ ...checkin, photoUrl: sharedCheckinPhotoUrl(checkin) })));
  } catch (error: any) {
    console.error("[Checkin] GET /api/core/checkins error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.patch("/api/core/checkins/:id/status", requireAuthOrKiosk, requireCheckinBranch, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = (req.user as any)?.id;
    const tenantId = await getDefaultTenantId();

    if (!["registered", "in_park", "checked_out"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const updates: Record<string, any> = { status };
    
    if (status === "in_park") {
      updates.checkedInAt = new Date();
      updates.checkedInBy = userId;
    } else if (status === "checked_out") {
      updates.checkedOutAt = new Date();
      updates.checkedOutBy = userId;
    }

    const [updated] = await db.update(serviceCheckins)
      .set(updates)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)))
      .returning();

    if (!updated) {
      return res.status(404).json({ message: "Check-in not found" });
    }

    res.json(updated);
  } catch (error: any) {
    console.error("[Checkin] PATCH /api/core/checkins/:id/status error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Checkout with photo - releases nanny reservation
router.post("/api/core/checkins/:id/checkout", requireAuthOrKiosk, requireCheckinBranch, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { outPhotoData } = req.body;
    const userId = (req.user as any)?.id;
    const tenantId = await getDefaultTenantId();

    // Get the check-in first to find any associated nanny
    const [checkin] = await db.select()
      .from(serviceCheckins)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)));

    if (!checkin) {
      return res.status(404).json({ message: "Check-in not found" });
    }

    // Save pickup photo if provided (max 5MB base64) - upload to object storage
    let outPhotoUrl: string | undefined;
    if (outPhotoData && outPhotoData.startsWith("data:image")) {
      // Validate size (5MB limit for base64 string ~ 6.6MB)
      if (outPhotoData.length > 7 * 1024 * 1024) {
        return res.status(400).json({ message: "Photo too large (max 5MB)" });
      }
      
      const base64Data = outPhotoData.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const fileName = `checkout_${id}_${Date.now()}.jpg`;
      
      // Upload to object storage (permanent cloud storage)
      outPhotoUrl = await uploadToObjectStorage(buffer, "checkin-photos", fileName, "image/jpeg");
    }

    // Update the check-in to checked_out
    const updates: Record<string, any> = {
      status: "checked_out",
      checkedOutAt: new Date(),
      checkedOutBy: userId,
    };
    if (outPhotoUrl) {
      updates.outPhotoUrl = outPhotoUrl;
    }

    const [updated] = await db.update(serviceCheckins)
      .set(updates)
      .where(eq(serviceCheckins.id, id))
      .returning();

    // If the child had a nanny assigned, complete/cancel any reservations
    if (checkin.nannyEmployeeId) {
      const today = new Date().toISOString().split("T")[0];
      await db.update(nannyReservations)
        .set({ status: "completed" })
        .where(and(
          eq(nannyReservations.serviceCheckinId, id),
          eq(nannyReservations.reservationDate, today),
          inArray(nannyReservations.status, ["reserved", "active"])
        ));
    }

    res.json(updated);
  } catch (error: any) {
    console.error("[Checkin] POST /api/core/checkins/:id/checkout error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Revert checkout - put child back in park
router.post("/api/core/checkins/:id/revert-checkout", requireAuthOrKiosk, requireCheckinBranch, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [checkin] = await db.select()
      .from(serviceCheckins)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)));

    if (!checkin) {
      return res.status(404).json({ message: "Check-in not found" });
    }

    if (checkin.status !== "checked_out") {
      return res.status(400).json({ message: "Can only revert checked-out children" });
    }

    // Revert to in_park status
    const [updated] = await db.update(serviceCheckins)
      .set({
        status: "in_park",
        checkedOutAt: null,
        checkedOutBy: null,
        outPhotoUrl: null,
      })
      .where(eq(serviceCheckins.id, id))
      .returning();

    // If there was a nanny, re-activate the reservation
    if (checkin.nannyEmployeeId && checkin.requestedEndAt) {
      const today = new Date().toISOString().split("T")[0];
      const endTime = new Date(checkin.requestedEndAt);
      
      // Only re-activate if the original end time hasn't passed
      if (endTime > new Date()) {
        await db.update(nannyReservations)
          .set({ status: "active" })
          .where(and(
            eq(nannyReservations.serviceCheckinId, id),
            eq(nannyReservations.reservationDate, today),
            eq(nannyReservations.status, "completed")
          ));
      }
    }

    res.json(updated);
  } catch (error: any) {
    console.error("[Checkin] POST /api/core/checkins/:id/revert-checkout error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/api/core/nannies/available", requireAuthOrKiosk, async (req: Request, res: Response) => {
  try {
    const { branchId } = req.query;
    const tenantId = await getDefaultTenantId();

    if (!branchId || typeof branchId !== "string") {
      return res.status(400).json({ message: "branchId is required" });
    }
    if (!await canAccessCheckinBranch(req, branchId)) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }

    console.log("[Nannies Available] tenantId:", tenantId, "branchId:", branchId);

    const nannyRoles = await db.select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(and(
        eq(roles.tenantId, tenantId),
        or(
          ilike(roles.name, "%nanny%"),
          ilike(roles.name, "%caretaker%")
        )
      ));

    console.log("[Nannies Available] nannyRoles:", nannyRoles);

    const nannyRoleIds = nannyRoles.map(r => r.id);

    let eligibleEmployeeIds: string[] = [];

    if (nannyRoleIds.length > 0) {
      const employeesWithRole = await db.select({ employeeId: employeeRoles.employeeId })
        .from(employeeRoles)
        .where(inArray(employeeRoles.roleId, nannyRoleIds));
      eligibleEmployeeIds = employeesWithRole.map(e => e.employeeId);
    }

    console.log("[Nannies Available] eligibleEmployeeIds:", eligibleEmployeeIds);

    if (eligibleEmployeeIds.length === 0) {
      console.log("[Nannies Available] No employees with nanny roles found");
      return res.json([]);
    }

    // Only consider clock-ins from today (Bangkok timezone) to avoid stale data
    const todayBangkok = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const todayStartBangkok = new Date(todayBangkok + "T00:00:00+07:00");
    
    const presence = await db.select()
      .from(employeePresence)
      .where(and(
        eq(employeePresence.isClockedIn, true),
        eq(employeePresence.currentWorkBranchId, branchId),
        inArray(employeePresence.employeeId, eligibleEmployeeIds),
        gte(employeePresence.lastInAt, todayStartBangkok) // Only today's clock-ins
      ));

    console.log("[Nannies Available] presence records (today only):", presence);

    const clockedInEmployeeIds = presence.map(p => p.employeeId);

    if (clockedInEmployeeIds.length === 0) {
      console.log("[Nannies Available] No clocked-in nannies at branch", branchId);
      return res.json([]);
    }

    // Find nannies assigned to active nanny services that haven't ended yet
    const now = new Date();
    const activeAssignments = await db.select({ 
      nannyEmployeeId: serviceCheckins.nannyEmployeeId,
      requestedEndAt: serviceCheckins.requestedEndAt,
    })
      .from(serviceCheckins)
      .where(and(
        eq(serviceCheckins.tenantId, tenantId),
        eq(serviceCheckins.status, "in_park"),
        eq(serviceCheckins.serviceType, "nanny"),
        sql`${serviceCheckins.nannyEmployeeId} IS NOT NULL`
      ));

    // A nanny is busy if they're assigned to an in_park service AND:
    // - The service has no end time (indefinite), OR
    // - The end time is in the future
    const assignedNannyIds = new Set(
      activeAssignments
        .filter(a => !a.requestedEndAt || new Date(a.requestedEndAt) > now)
        .map(a => a.nannyEmployeeId)
        .filter(Boolean)
    );

    // Check for nannies marked as unavailable today (use Bangkok timezone)
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(now);
    const unavailableNannies = await db.select()
      .from(employeeRoleAvailability)
      .where(and(
        eq(employeeRoleAvailability.unavailableDate, today),
        inArray(employeeRoleAvailability.roleId, nannyRoleIds),
        inArray(employeeRoleAvailability.employeeId, clockedInEmployeeIds)
      ));
    const unavailableNannyIds = new Set(unavailableNannies.map(u => u.employeeId));

    const currentTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    const currentReservations = await db.select({
      nannyEmployeeId: nannyReservations.nannyEmployeeId,
      startTime: nannyReservations.startTime,
      endTime: nannyReservations.endTime,
    }).from(nannyReservations).where(and(
      eq(nannyReservations.tenantId, tenantId),
      eq(nannyReservations.reservationDate, today),
      inArray(nannyReservations.status, ["reserved", "active"]),
      inArray(nannyReservations.nannyEmployeeId, clockedInEmployeeIds)
    ));
    const reservedNannyIds = new Set(currentReservations
      .filter(reservation => reservation.startTime <= currentTime && currentTime < reservation.endTime)
      .map(reservation => reservation.nannyEmployeeId));

    // Filter out assigned AND unavailable nannies
    const availableEmployeeIds = clockedInEmployeeIds.filter(id => 
      !assignedNannyIds.has(id) && !unavailableNannyIds.has(id) && !reservedNannyIds.has(id)
    );

    if (availableEmployeeIds.length === 0) {
      return res.json([]);
    }

    const availableNannies = await db.select()
      .from(employees)
      .where(and(
        inArray(employees.id, availableEmployeeIds),
        eq(employees.employmentState, "ACTIVE")
      ));

    // Log warning for inactive employees who are clocked in
    if (availableNannies.length < availableEmployeeIds.length) {
      const activeSet = new Set(availableNannies.map(e => e.id));
      for (const id of availableEmployeeIds) {
        if (!activeSet.has(id)) {
          console.warn(`[Nannies Available] WARNING: Inactive/terminated employee ${id} has active clock-in. Excluding.`);
        }
      }
    }

    res.json(availableNannies);
  } catch (error: any) {
    console.error("[Checkin] GET /api/core/nannies/available error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post("/api/core/checkins/:id/assign-nanny", requireAuthOrKiosk, requireCheckinBranch, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { nannyEmployeeId } = req.body;
    const userId = (req.user as any)?.id;
    const tenantId = await getDefaultTenantId();

    if (typeof nannyEmployeeId !== "string" || !nannyEmployeeId) {
      return res.status(400).json({ message: "nannyEmployeeId is required" });
    }

    const checkin = await db.select().from(serviceCheckins)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)))
      .limit(1);

    if (!checkin.length) {
      return res.status(404).json({ message: "Check-in not found" });
    }

    if (checkin[0].serviceType !== "nanny" || !["registered", "in_park"].includes(checkin[0].status)) {
      return res.status(409).json({ message: "Only active nanny check-ins can be assigned" });
    }
    if (checkin[0].nannyEmployeeId) {
      return res.status(409).json({ message: "A nanny is already assigned" });
    }

    const nanny = await db.select().from(employees)
      .where(and(eq(employees.id, nannyEmployeeId), eq(employees.tenantId, tenantId)))
      .limit(1);

    if (!nanny.length) {
      return res.status(404).json({ message: "Nanny not found" });
    }
    if (nanny[0].employmentState !== "ACTIVE") {
      return res.status(409).json({ message: "Nanny is not an active employee" });
    }

    const nannyRoles = await db.select({ id: roles.id }).from(roles).where(and(
      eq(roles.tenantId, tenantId),
      or(ilike(roles.name, "%nanny%"), ilike(roles.name, "%caretaker%"))
    ));
    const roleIds = nannyRoles.map(role => role.id);
    if (roleIds.length === 0) {
      return res.status(409).json({ message: "Employee does not have a nanny role" });
    }
    const assignedRoles = await db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(and(
      eq(employeeRoles.employeeId, nannyEmployeeId), inArray(employeeRoles.roleId, roleIds)
    ));
    if (assignedRoles.length === 0) {
      return res.status(409).json({ message: "Employee does not have a nanny role" });
    }

    const now = new Date();
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(now);
    const dayStart = new Date(`${today}T00:00:00+07:00`);
    const [presence] = await db.select().from(employeePresence).where(and(
      eq(employeePresence.employeeId, nannyEmployeeId),
      eq(employeePresence.tenantId, tenantId),
      eq(employeePresence.isClockedIn, true),
      eq(employeePresence.currentWorkBranchId, checkin[0].branchId),
      gte(employeePresence.lastInAt, dayStart)
    ));
    if (!presence) {
      return res.status(409).json({ message: "Nanny is not on duty at this branch" });
    }
    const unavailable = await db.select({ id: employeeRoleAvailability.id }).from(employeeRoleAvailability).where(and(
      eq(employeeRoleAvailability.tenantId, tenantId),
      eq(employeeRoleAvailability.employeeId, nannyEmployeeId),
      eq(employeeRoleAvailability.unavailableDate, today),
      inArray(employeeRoleAvailability.roleId, assignedRoles.map(role => role.roleId))
    )).limit(1);
    if (unavailable.length > 0) {
      return res.status(409).json({ message: "Nanny is unavailable today" });
    }
    const currentTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    const updated = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${nannyEmployeeId}:${today}`}))`);
      const activeAssignments = await tx.select({ id: serviceCheckins.id, requestedEndAt: serviceCheckins.requestedEndAt })
        .from(serviceCheckins).where(and(
          eq(serviceCheckins.tenantId, tenantId),
          eq(serviceCheckins.nannyEmployeeId, nannyEmployeeId),
          eq(serviceCheckins.serviceType, "nanny"),
          eq(serviceCheckins.status, "in_park")
        ));
      if (activeAssignments.some(assignment => assignment.id !== id && (!assignment.requestedEndAt || assignment.requestedEndAt > now))) {
        return null;
      }
      const reservations = await tx.select({
        serviceCheckinId: nannyReservations.serviceCheckinId,
        startTime: nannyReservations.startTime,
        endTime: nannyReservations.endTime,
      }).from(nannyReservations).where(and(
        eq(nannyReservations.tenantId, tenantId),
        eq(nannyReservations.nannyEmployeeId, nannyEmployeeId),
        eq(nannyReservations.reservationDate, today),
        inArray(nannyReservations.status, ["reserved", "active"])
      ));
      if (reservations.some(reservation => reservation.serviceCheckinId !== id &&
          reservation.startTime <= currentTime && currentTime < reservation.endTime)) {
        return null;
      }
      const [assigned] = await tx.update(serviceCheckins).set({
        nannyEmployeeId,
        nannyAssigned: getEmployeeDisplayName(nanny[0]),
        nannyAssignedByUserId: userId,
        nannyAssignedAt: now,
      }).where(and(
        eq(serviceCheckins.id, id),
        eq(serviceCheckins.tenantId, tenantId),
        eq(serviceCheckins.serviceType, "nanny"),
        inArray(serviceCheckins.status, ["registered", "in_park"]),
        sql`${serviceCheckins.nannyEmployeeId} IS NULL`
      )).returning();
      return assigned || null;
    });
    if (!updated) return res.status(409).json({ message: "Nanny or check-in is no longer available" });

    res.json(updated);
  } catch (error: any) {
    console.error("[Checkin] POST /api/core/checkins/:id/assign-nanny error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Update service type and duration
router.patch("/api/core/checkins/:id/service", requireAuthOrKiosk, requireCheckinBranch, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { serviceType, durationHours, startTime } = req.body;
    const user = req.user as UserWithBranchAccess;
    const tenantId = await getDefaultTenantId();

    if (!serviceType || !["nanny", "dropoff"].includes(serviceType)) {
      return res.status(400).json({ message: "Invalid service type" });
    }

    // Get the existing check-in
    const [checkin] = await db.select().from(serviceCheckins)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)));
    
    if (!checkin) {
      return res.status(404).json({ message: "Check-in not found" });
    }

    const minutes = durationHours === undefined ? null : Number(durationHours) * 60;
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 30 || minutes > 480)) {
      return res.status(400).json({ message: "Duration must be between 30 and 480 minutes" });
    }
    if (startTime && (typeof startTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime))) {
      return res.status(400).json({ message: "Invalid start time" });
    }
    if (serviceType === "nanny" && minutes !== null && checkin.nannyEmployeeId && !startTime) {
      return res.status(400).json({ message: "Start time is required for a nanny reservation" });
    }

    const updates: Record<string, any> = { serviceType };
    
    if (serviceType === "nanny" && minutes !== null) {
      updates.requestedDurationMinutes = minutes;

      // If child is already in park, recalculate end time based on actual check-in time
      if (checkin.status === "in_park" && checkin.checkedInAt) {
        const checkInTime = new Date(checkin.checkedInAt);
        const newEndAt = new Date(checkInTime.getTime() + minutes * 60 * 1000);
        updates.requestedEndAt = newEndAt;
      }

      // If start time is provided and nanny is assigned, create/update reservation
      if (startTime && checkin.nannyEmployeeId) {
        const targetDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(checkin.checkedInAt || new Date());
        
        // Calculate end time
        const [startHour, startMinute] = startTime.split(":").map(Number);
        const startTotalMinutes = startHour * 60 + startMinute;
        const endTotalMinutes = startTotalMinutes + minutes;
        const actualStartTime = checkin.status === "in_park" && checkin.checkedInAt
          ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(checkin.checkedInAt)
          : startTime;
        const [actualStartHour, actualStartMinute] = actualStartTime.split(":").map(Number);
        const effectiveStart = actualStartHour * 60 + actualStartMinute;
        const effectiveEnd = effectiveStart + minutes;
        if (effectiveEnd > 1440) return res.status(400).json({ message: "Reservation must end on the same day" });
        const endHour = Math.floor(endTotalMinutes / 60);
        const endMinute = endTotalMinutes % 60;
        const endTime = `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;
        
        // For in_park children, recalculate end time based on CHECK-IN TIME + new duration
        // This is more accurate than using the reservation start time
        if (checkin.status === "in_park" && checkin.checkedInAt) {
          const checkInTime = new Date(checkin.checkedInAt);
          const newEndAt = new Date(checkInTime.getTime() + minutes * 60 * 1000);
          updates.requestedEndAt = newEndAt;
        } else if (checkin.status === "in_park") {
          // Fallback: use reservation end time if no check-in time
          updates.requestedEndAt = new Date(new Date(`${targetDate}T${startTime}:00+07:00`).getTime() + minutes * 60000);
        }

        // Get nanny name
        const [nanny] = await db.select().from(employees)
          .where(eq(employees.id, checkin.nannyEmployeeId));

        // For in_park children, use actual check-in time for reservation start
        const reservationStartTime = actualStartTime;
        let reservationEndTime = endTime;
        if (checkin.status === "in_park" && checkin.checkedInAt) {
          reservationEndTime = `${String(Math.floor(effectiveEnd / 60)).padStart(2, "0")}:${String(effectiveEnd % 60).padStart(2, "0")}`;
        }

        const replacement = await db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${checkin.nannyEmployeeId}:${targetDate}`}))`);
          const activeAssignments = await tx.select({
            id: serviceCheckins.id,
            checkedInAt: serviceCheckins.checkedInAt,
            requestedEndAt: serviceCheckins.requestedEndAt,
          }).from(serviceCheckins).where(and(
            eq(serviceCheckins.tenantId, tenantId),
            eq(serviceCheckins.nannyEmployeeId, checkin.nannyEmployeeId!),
            eq(serviceCheckins.serviceType, "nanny"),
            eq(serviceCheckins.status, "in_park")
          ));
          const bookingStart = new Date(`${targetDate}T${reservationStartTime}:00+07:00`).getTime();
          const bookingEnd = bookingStart + minutes * 60000;
          if (activeAssignments.some(assignment => assignment.id !== id &&
              bookingStart < (assignment.requestedEndAt?.getTime() ?? Number.POSITIVE_INFINITY) &&
              bookingEnd > (assignment.checkedInAt?.getTime() ?? Date.now()))) return null;
          const existingReservations = await tx.select().from(nannyReservations).where(and(
            eq(nannyReservations.tenantId, tenantId),
            eq(nannyReservations.nannyEmployeeId, checkin.nannyEmployeeId!),
            eq(nannyReservations.reservationDate, targetDate),
            inArray(nannyReservations.status, ["reserved", "active"])
          ));
          const conflict = existingReservations.some(existing => {
            if (existing.serviceCheckinId === id) return false;
            const [existStartH, existStartM] = existing.startTime.split(":").map(Number);
            const [existEndH, existEndM] = existing.endTime.split(":").map(Number);
            return effectiveStart < existEndH * 60 + existEndM && effectiveEnd > existStartH * 60 + existStartM;
          });
          if (conflict) return null;

          await tx.update(nannyReservations)
            .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: "Replaced by new reservation" })
            .where(and(
              eq(nannyReservations.serviceCheckinId, id),
              inArray(nannyReservations.status, ["reserved", "active"])
            ));
          await tx.insert(nannyReservations).values({
            tenantId,
            branchId: checkin.branchId,
            nannyEmployeeId: checkin.nannyEmployeeId!,
            nannyFullName: nanny ? getEmployeeDisplayName(nanny) : (checkin.nannyAssigned || ""),
            serviceCheckinId: id,
            childFullName: checkin.childFullName,
            parentFullName: checkin.parentFullName,
            reservationDate: targetDate,
            startTime: reservationStartTime,
            endTime: reservationEndTime,
            durationMinutes: minutes,
            status: checkin.status === "in_park" ? "active" : "reserved",
            activatedAt: checkin.status === "in_park" ? new Date() : null,
            notes: null,
            reservedByUserId: user?.id || null,
          });
          const [updatedCheckin] = await tx.update(serviceCheckins).set(updates)
            .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)))
            .returning();
          return updatedCheckin;
        });
        if (!replacement) return res.status(409).json({ message: "Nanny is already reserved for this time" });
        return res.json(replacement);
      }
    } else if (serviceType === "dropoff") {
      updates.nannyEmployeeId = null;
      updates.nannyAssigned = null;

      if (minutes !== null) {
        updates.requestedDurationMinutes = minutes;

        if (checkin.status === "in_park" && checkin.checkedInAt) {
          const checkInTime = new Date(checkin.checkedInAt);
          updates.requestedEndAt = new Date(checkInTime.getTime() + minutes * 60 * 1000);
        } else if (startTime) {
          const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
          updates.requestedEndAt = new Date(new Date(`${today}T${startTime}:00+07:00`).getTime() + minutes * 60000);
        }
      } else {
        updates.requestedDurationMinutes = null;
        updates.requestedEndAt = null;
      }

      const updated = await db.transaction(async tx => {
        await tx.update(nannyReservations)
          .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: "Service changed to dropoff" })
          .where(and(
            eq(nannyReservations.serviceCheckinId, id),
            inArray(nannyReservations.status, ["reserved", "active"])
          ));
        const [changed] = await tx.update(serviceCheckins).set(updates)
          .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)))
          .returning();
        return changed;
      });
      return res.json(updated);
    }

    const [updated] = await db.update(serviceCheckins)
      .set(updates)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)))
      .returning();

    res.json(updated);
  } catch (error: any) {
    console.error("[Checkin] PATCH /api/core/checkins/:id/service error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Extend time for in_park children
router.post("/api/core/checkins/:id/extend-time", requireAuthOrKiosk, requireCheckinBranch, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { additionalMinutes } = req.body;
    const tenantId = await getDefaultTenantId();

    if (!additionalMinutes || additionalMinutes < 15) {
      return res.status(400).json({ message: "Invalid extension time" });
    }

    const [checkin] = await db.select()
      .from(serviceCheckins)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)));

    if (!checkin) {
      return res.status(404).json({ message: "Check-in not found" });
    }

    if (checkin.status !== "in_park") {
      return res.status(400).json({ message: "Can only extend time for children currently in park" });
    }

    // Calculate new duration and end time
    const currentDuration = checkin.requestedDurationMinutes || 60;
    const newDuration = currentDuration + additionalMinutes;
    
    let newEndAt: Date;
    if (checkin.requestedEndAt) {
      newEndAt = new Date(new Date(checkin.requestedEndAt).getTime() + additionalMinutes * 60 * 1000);
    } else if (checkin.checkedInAt) {
      newEndAt = new Date(new Date(checkin.checkedInAt).getTime() + newDuration * 60 * 1000);
    } else {
      newEndAt = new Date(Date.now() + newDuration * 60 * 1000);
    }

    // Update the service checkin
    const [updated] = await db.update(serviceCheckins)
      .set({
        requestedDurationMinutes: newDuration,
        requestedEndAt: newEndAt,
      })
      .where(eq(serviceCheckins.id, id))
      .returning();

    // Update linked nanny reservation if exists
    if (checkin.nannyEmployeeId) {
      const endTimeStr = `${String(newEndAt.getHours()).padStart(2, "0")}:${String(newEndAt.getMinutes()).padStart(2, "0")}`;
      
      await db.update(nannyReservations)
        .set({ 
          endTime: endTimeStr,
          durationMinutes: newDuration,
        })
        .where(and(
          eq(nannyReservations.serviceCheckinId, id),
          inArray(nannyReservations.status, ["reserved", "active"])
        ));
    }

    res.json(updated);
  } catch (error: any) {
    console.error("[Checkin] POST /api/core/checkins/:id/extend-time error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Enter park - start the service
router.post("/api/core/checkins/:id/enter-park", requireAuthOrKiosk, requireCheckinBranch, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req.user as any)?.id;
    const tenantId = await getDefaultTenantId();

    const checkin = await db.select().from(serviceCheckins)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)))
      .limit(1);

    if (!checkin.length) {
      return res.status(404).json({ message: "Check-in not found" });
    }

    const now = new Date();
    const updates: Record<string, any> = {
      status: "in_park",
      checkedInAt: now,
      checkedInBy: userId,
      serviceStartedAt: now,
    };

    // Calculate end time based on requested duration
    if (checkin[0].requestedDurationMinutes) {
      const endAt = new Date(now.getTime() + checkin[0].requestedDurationMinutes * 60 * 1000);
      updates.requestedEndAt = endAt;
      
      // Update linked nanny reservation to reflect actual check-in times
      if (checkin[0].nannyEmployeeId) {
        const startTimeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const endTimeStr = `${String(endAt.getHours()).padStart(2, "0")}:${String(endAt.getMinutes()).padStart(2, "0")}`;
        
        await db.update(nannyReservations)
          .set({ 
            startTime: startTimeStr,
            endTime: endTimeStr,
            status: "active",
          })
          .where(and(
            eq(nannyReservations.serviceCheckinId, id),
            inArray(nannyReservations.status, ["reserved", "active"])
          ));
      }
    }

    const [updated] = await db.update(serviceCheckins)
      .set(updates)
      .where(eq(serviceCheckins.id, id))
      .returning();

    res.json(updated);
  } catch (error: any) {
    console.error("[Checkin] POST /api/core/checkins/:id/enter-park error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get checkin details
router.get("/api/core/checkins/:id", requireAuthOrKiosk, requireCheckinBranch, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [checkin] = await db.select().from(serviceCheckins)
      .where(and(eq(serviceCheckins.id, id), eq(serviceCheckins.tenantId, tenantId)));

    if (!checkin) {
      return res.status(404).json({ message: "Check-in not found" });
    }

    res.json(checkin);
  } catch (error: any) {
    console.error("[Checkin] GET /api/core/checkins/:id error:", error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// NANNY RESERVATIONS
// ============================================

// Get today's nanny schedule with reservations and availability
router.get("/api/core/nanny-schedule", requireAuthOrKiosk, async (req: Request, res: Response) => {
  try {
    const { branchId, date } = req.query;
    const tenantId = await getDefaultTenantId();
    const targetDate = (date as string) || new Date().toISOString().split("T")[0];

    if (!branchId) {
      return res.status(400).json({ message: "Branch ID required" });
    }

    // For kiosk auth, validate that branchId matches the kiosk's branchId
    if (req.kioskSession) {
      if (req.kioskSession.branchId !== branchId) {
        return res.status(403).json({ message: "Access denied to this branch" });
      }
    }
    // For regular auth, validate branch access
    else {
      const user = req.user as UserWithBranchAccess;
      if (!user) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const allowedScope = await getAllowedOperatorAndBranchIds(user);
      if (!allowedScope.isGlobalAdmin && allowedScope.branchIds !== null) {
        if (!allowedScope.branchIds.includes(branchId as string)) {
          return res.status(403).json({ message: "Access denied to this branch" });
        }
      }
    }

    // Verify branch exists and belongs to tenant
    const [branch] = await db.select().from(branches)
      .where(and(eq(branches.id, branchId as string), eq(branches.tenantId, tenantId)));
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    // Get all nannies for this branch (employees with nanny role)
    const nannyRoles = await db.select()
      .from(roles)
      .where(and(
        eq(roles.tenantId, tenantId),
        or(
          ilike(roles.name, "%nanny%"),
          ilike(roles.name, "%พี่เลี้ยง%")
        )
      ));

    const nannyRoleIds = nannyRoles.map(r => r.id);
    if (nannyRoleIds.length === 0) {
      return res.json({ nannies: [], reservations: [] });
    }

    const employeesWithRole = await db.select({ employeeId: employeeRoles.employeeId, roleId: employeeRoles.roleId })
      .from(employeeRoles)
      .where(inArray(employeeRoles.roleId, nannyRoleIds));

    const eligibleEmployeeIds = employeesWithRole.map(e => e.employeeId);
    if (eligibleEmployeeIds.length === 0) {
      return res.json({ nannies: [], reservations: [] });
    }

    // Get employees who marked themselves unavailable for nanny roles today
    const unavailableNannies = await db.select()
      .from(employeeRoleAvailability)
      .where(and(
        eq(employeeRoleAvailability.unavailableDate, targetDate),
        inArray(employeeRoleAvailability.roleId, nannyRoleIds),
        inArray(employeeRoleAvailability.employeeId, eligibleEmployeeIds)
      ));
    
    const unavailableEmployeeIds = new Set(unavailableNannies.map(u => u.employeeId));

    // SOURCE OF TRUTH: Clock-in presence data determines who is "on shift"
    // Get presence records for nanny-role employees who are CLOCKED IN AT THIS BRANCH TODAY
    const todayStartBangkok = new Date(targetDate + "T00:00:00+07:00");
    const presenceData = await db.select()
      .from(employeePresence)
      .where(and(
        inArray(employeePresence.employeeId, eligibleEmployeeIds),
        eq(employeePresence.isClockedIn, true),
        eq(employeePresence.currentWorkBranchId, branchId as string),
        gte(employeePresence.lastInAt, todayStartBangkok)
      ));

    const clockedInEmployeeIds = presenceData.map(p => p.employeeId);

    // Also include unavailable employees (to allow toggling back) even if not clocked in
    const allRelevantIds = [...new Set([...clockedInEmployeeIds, ...Array.from(unavailableEmployeeIds)])];

    if (allRelevantIds.length === 0) {
      const todayReservations = await db.select()
        .from(nannyReservations)
        .where(and(
          eq(nannyReservations.branchId, branchId as string),
          eq(nannyReservations.reservationDate, targetDate),
          inArray(nannyReservations.status, ["reserved", "active"])
        ));
      return res.json({ date: targetDate, nannies: [], reservations: todayReservations });
    }

    // Get employee data for clocked-in nannies (filtered by ACTIVE employment state)
    const allNannyEmployees = await db.select()
      .from(employees)
      .where(and(
        inArray(employees.id, allRelevantIds),
        eq(employees.employmentState, "ACTIVE")
      ));

    // Log warning for inactive employees who are clocked in
    const activeIds = new Set(allNannyEmployees.map(e => e.id));
    for (const id of clockedInEmployeeIds) {
      if (!activeIds.has(id)) {
        console.warn(`[Nanny Schedule] WARNING: Inactive/terminated employee ${id} has active clock-in at branch ${branchId}. Excluding from nanny list.`);
      }
    }

    // Get today's reservations BEFORE filtering nannies
    const todayReservations = await db.select()
      .from(nannyReservations)
      .where(and(
        eq(nannyReservations.branchId, branchId as string),
        eq(nannyReservations.reservationDate, targetDate),
        inArray(nannyReservations.status, ["reserved", "active"])
      ));

    // Get service check-ins with assigned nannies (registered, in_park, and checked_out for today)
    const activeServiceCheckins = await db.select()
      .from(serviceCheckins)
      .where(and(
        eq(serviceCheckins.branchId, branchId as string),
        inArray(serviceCheckins.status, ["registered", "in_park"]),
        sql`${serviceCheckins.nannyEmployeeId} IS NOT NULL`
      ));
    
    // Get today's checked-out services with nannies (for schedule display)
    const todayStart = new Date(targetDate + "T00:00:00");
    const todayEnd = new Date(targetDate + "T23:59:59");
    const checkedOutServices = await db.select()
      .from(serviceCheckins)
      .where(and(
        eq(serviceCheckins.branchId, branchId as string),
        eq(serviceCheckins.status, "checked_out"),
        sql`${serviceCheckins.nannyEmployeeId} IS NOT NULL`,
        sql`${serviceCheckins.checkedOutAt} >= ${todayStart}`,
        sql`${serviceCheckins.checkedOutAt} <= ${todayEnd}`
      ));

    // Build nanny data with status - only include nannies clocked in at THIS branch TODAY
    const nanniesWithStatus = allNannyEmployees
      .map(nanny => {
        const presence = presenceData.find(p => p.employeeId === nanny.id);
        const isClockedIn = !!presence && presence.isClockedIn === true && 
          presence.currentWorkBranchId === (branchId as string) &&
          !!presence.lastInAt && presence.lastInAt >= todayStartBangkok;
        const clockInTime = isClockedIn && presence?.lastInAt ? presence.lastInAt.toISOString() : null;
        const isManuallyUnavailable = unavailableEmployeeIds.has(nanny.id);
        
        const activeService = activeServiceCheckins.find(c => c.nannyEmployeeId === nanny.id);
        const nannyCheckedOutServices = checkedOutServices.filter(c => c.nannyEmployeeId === nanny.id);
        const nannyReservationsList = todayReservations.filter(r => r.nannyEmployeeId === nanny.id);
        
        let currentStatus: "available" | "busy" | "reserved" | "offline" | "unavailable" = "offline";
        if (isManuallyUnavailable) {
          currentStatus = "unavailable";
        } else if (isClockedIn) {
          if (activeService) {
            currentStatus = "busy";
          } else {
            currentStatus = "available";
          }
        }

        return {
          ...nanny,
          isClockedIn,
          clockInTime,
          isManuallyUnavailable,
          currentStatus,
          activeService: activeService ? {
            childName: activeService.childFullName,
            status: activeService.status,
            startTime: activeService.checkedInAt || activeService.serviceStartedAt || 
              (activeService.requestedEndAt && activeService.requestedDurationMinutes 
                ? new Date(new Date(activeService.requestedEndAt).getTime() - activeService.requestedDurationMinutes * 60000).toISOString()
                : null),
            endTime: activeService.requestedEndAt,
          } : null,
          completedServices: nannyCheckedOutServices.map(s => ({
            childName: s.childFullName,
            status: "checked_out",
            startTime: s.checkedInAt || s.serviceStartedAt,
            endTime: s.checkedOutAt,
          })),
          reservations: nannyReservationsList,
        };
      })
      .filter(nanny => nanny.isClockedIn || nanny.isManuallyUnavailable)
      .sort((a, b) => {
        if (a.clockInTime && b.clockInTime) return a.clockInTime.localeCompare(b.clockInTime);
        if (a.clockInTime) return -1;
        return 1;
      });

    res.json({
      date: targetDate,
      nannies: nanniesWithStatus,
      reservations: todayReservations,
    });
  } catch (error: any) {
    console.error("[Checkin] GET /api/core/nanny-schedule error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Create a nanny reservation
router.post("/api/core/nanny-reservations", requireAuthOrKiosk, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const { 
      branchId, 
      nannyEmployeeId, 
      startTime, 
      durationMinutes,
      childFullName,
      parentFullName,
      serviceCheckinId,
      notes,
      reservationDate
    } = req.body;

    if (typeof branchId !== "string" || typeof nannyEmployeeId !== "string" || !branchId || !nannyEmployeeId || !startTime || !durationMinutes) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    if (serviceCheckinId && !z.string().uuid().safeParse(serviceCheckinId).success) {
      return res.status(400).json({ message: "Invalid check-in ID" });
    }

    let userId: string | null = null;
    
    // For kiosk auth, validate that branchId matches the kiosk's branchId
    if (req.kioskSession) {
      if (req.kioskSession.branchId !== branchId) {
        return res.status(403).json({ message: "Access denied to this branch" });
      }
    }
    // For regular auth, validate branch access
    else {
      const user = req.user as UserWithBranchAccess;
      if (!user) {
        return res.status(401).json({ message: "Authentication required" });
      }
      userId = user.id;
      const allowedScope = await getAllowedOperatorAndBranchIds(user);
      if (!allowedScope.isGlobalAdmin && allowedScope.branchIds !== null) {
        if (!allowedScope.branchIds.includes(branchId as string)) {
          return res.status(403).json({ message: "Access denied to this branch" });
        }
      }
    }

    // Verify branch exists and belongs to tenant
    const [branch] = await db.select().from(branches)
      .where(and(eq(branches.id, branchId as string), eq(branches.tenantId, tenantId)));
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    // Validate required fields format
    if (typeof startTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
      return res.status(400).json({ message: "Invalid startTime format (HH:MM required)" });
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 480) {
      return res.status(400).json({ message: "Duration must be between 30 and 480 minutes" });
    }

    // Get nanny info
    const [nanny] = await db.select()
      .from(employees)
      .where(and(eq(employees.id, nannyEmployeeId), eq(employees.tenantId, tenantId)));

    if (!nanny) {
      return res.status(404).json({ message: "Nanny not found" });
    }
    if (nanny.employmentState !== "ACTIVE") {
      return res.status(409).json({ message: "Nanny is not an active employee" });
    }

    const nannyRoles = await db.select({ id: roles.id }).from(roles).where(and(
      eq(roles.tenantId, tenantId),
      or(ilike(roles.name, "%nanny%"), ilike(roles.name, "%caretaker%"))
    ));
    const roleIds = nannyRoles.map(role => role.id);
    const assignedRoles = roleIds.length > 0
      ? await db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(and(
          eq(employeeRoles.employeeId, nannyEmployeeId), inArray(employeeRoles.roleId, roleIds)
        ))
      : [];
    if (assignedRoles.length === 0) {
      return res.status(409).json({ message: "Employee does not have a nanny role" });
    }

    // Calculate end time
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const startTotalMinutes = startHour * 60 + startMinute;
    const endTotalMinutes = startTotalMinutes + durationMinutes;
    if (endTotalMinutes > 1440) {
      return res.status(400).json({ message: "Reservation must end on the same day" });
    }
    const endHour = Math.floor(endTotalMinutes / 60);
    const endMinute = endTotalMinutes % 60;
    const endTime = `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;

    const targetDate = reservationDate || new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
    if (typeof targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
        Number.isNaN(Date.parse(`${targetDate}T00:00:00Z`)) ||
        new Date(`${targetDate}T00:00:00Z`).toISOString().slice(0, 10) !== targetDate) {
      return res.status(400).json({ message: "Invalid reservation date" });
    }
    if (serviceCheckinId) {
      const [linkedCheckin] = await db.select().from(serviceCheckins).where(and(
        eq(serviceCheckins.id, serviceCheckinId), eq(serviceCheckins.tenantId, tenantId)
      ));
      if (!linkedCheckin) return res.status(404).json({ message: "Check-in not found" });
      if (linkedCheckin.branchId !== branchId) return res.status(403).json({ message: "Check-in belongs to another branch" });
      if (linkedCheckin.serviceType !== "nanny" || !["registered", "in_park"].includes(linkedCheckin.status) ||
          (linkedCheckin.nannyEmployeeId && linkedCheckin.nannyEmployeeId !== nannyEmployeeId)) {
        return res.status(409).json({ message: "Check-in is not eligible for this nanny reservation" });
      }
    }
    const unavailable = await db.select({ id: employeeRoleAvailability.id }).from(employeeRoleAvailability).where(and(
      eq(employeeRoleAvailability.tenantId, tenantId),
      eq(employeeRoleAvailability.employeeId, nannyEmployeeId),
      eq(employeeRoleAvailability.unavailableDate, targetDate),
      inArray(employeeRoleAvailability.roleId, assignedRoles.map(role => role.roleId))
    )).limit(1);
    if (unavailable.length > 0) {
      return res.status(409).json({ message: "Nanny is unavailable on this date" });
    }

    const reservation = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${nannyEmployeeId}:${targetDate}`}))`);
      const activeAssignments = await tx.select({
        id: serviceCheckins.id,
        checkedInAt: serviceCheckins.checkedInAt,
        requestedEndAt: serviceCheckins.requestedEndAt,
      }).from(serviceCheckins).where(and(
        eq(serviceCheckins.tenantId, tenantId),
        eq(serviceCheckins.nannyEmployeeId, nannyEmployeeId),
        eq(serviceCheckins.serviceType, "nanny"),
        eq(serviceCheckins.status, "in_park")
      ));
      const bookingStart = new Date(`${targetDate}T${startTime}:00+07:00`);
      const bookingEnd = new Date(bookingStart.getTime() + durationMinutes * 60000);
      if (activeAssignments.some(assignment => assignment.id !== serviceCheckinId &&
          bookingStart.getTime() < (assignment.requestedEndAt?.getTime() ?? Number.POSITIVE_INFINITY) &&
          bookingEnd.getTime() > (assignment.checkedInAt?.getTime() ?? Date.now()))) return null;
      const existingReservations = await tx.select().from(nannyReservations).where(and(
        eq(nannyReservations.tenantId, tenantId),
        eq(nannyReservations.nannyEmployeeId, nannyEmployeeId),
        eq(nannyReservations.reservationDate, targetDate),
        inArray(nannyReservations.status, ["reserved", "active"])
      ));
      const overlap = existingReservations.some(existing => {
        const [existStartH, existStartM] = existing.startTime.split(":").map(Number);
        const [existEndH, existEndM] = existing.endTime.split(":").map(Number);
        return startTotalMinutes < existEndH * 60 + existEndM && endTotalMinutes > existStartH * 60 + existStartM;
      });
      if (overlap) return null;
      const [created] = await tx.insert(nannyReservations).values({
        tenantId,
        branchId,
        nannyEmployeeId,
        nannyFullName: getEmployeeDisplayName(nanny),
        serviceCheckinId: serviceCheckinId || null,
        childFullName: childFullName || null,
        parentFullName: parentFullName || null,
        reservationDate: targetDate,
        startTime,
        endTime,
        durationMinutes,
        status: "reserved",
        reservedByUserId: userId,
        notes: notes || null,
      })
      .returning();
      return created;
    });
    if (!reservation) return res.status(409).json({ message: "Nanny is already reserved for this time" });

    res.status(201).json(reservation);
  } catch (error: any) {
    console.error("[Checkin] POST /api/core/nanny-reservations error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Update reservation status
router.patch("/api/core/nanny-reservations/:id", requireAuthOrKiosk, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, cancellationReason } = req.body;
    if (!z.enum(["active", "completed", "cancelled"]).safeParse(status).success) {
      return res.status(400).json({ message: "Invalid reservation status" });
    }
    const tenantId = await getDefaultTenantId();

    // Fetch reservation first to check branch access
    const [existing] = await db.select().from(nannyReservations)
      .where(and(eq(nannyReservations.id, id), eq(nannyReservations.tenantId, tenantId)));
    
    if (!existing) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    // For kiosk auth, validate that branchId matches the kiosk's branchId
    if (req.kioskSession) {
      if (req.kioskSession.branchId !== existing.branchId) {
        return res.status(403).json({ message: "Access denied to this reservation" });
      }
    }
    // For regular auth, validate branch access
    else {
      const user = req.user as UserWithBranchAccess;
      if (!user) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const allowedScope = await getAllowedOperatorAndBranchIds(user);
      if (!allowedScope.isGlobalAdmin && allowedScope.branchIds !== null) {
        if (!allowedScope.branchIds.includes(existing.branchId)) {
          return res.status(403).json({ message: "Access denied to this reservation" });
        }
      }
    }

    if (status === existing.status) return res.json(existing);
    if (["completed", "cancelled"].includes(existing.status) ||
        (existing.status === "reserved" && status === "completed")) {
      return res.status(409).json({ message: "Reservation cannot move to this status" });
    }
    if (status === "active") {
      const now = new Date();
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(now);
      if (existing.reservationDate !== today) {
        return res.status(409).json({ message: "Reservation is not for today" });
      }
      const dayStart = new Date(`${today}T00:00:00+07:00`);
      const [presence] = await db.select().from(employeePresence).where(and(
        eq(employeePresence.employeeId, existing.nannyEmployeeId),
        eq(employeePresence.tenantId, tenantId),
        eq(employeePresence.isClockedIn, true),
        eq(employeePresence.currentWorkBranchId, existing.branchId),
        gte(employeePresence.lastInAt, dayStart)
      ));
      if (!presence) return res.status(409).json({ message: "Nanny is not on duty at this branch" });
      const [nanny] = await db.select({ employmentState: employees.employmentState }).from(employees).where(and(
        eq(employees.id, existing.nannyEmployeeId), eq(employees.tenantId, tenantId)
      ));
      if (!nanny || nanny.employmentState !== "ACTIVE") {
        return res.status(409).json({ message: "Nanny is not an active employee" });
      }
      const nannyRoles = await db.select({ id: roles.id }).from(roles).where(and(
        eq(roles.tenantId, tenantId),
        or(ilike(roles.name, "%nanny%"), ilike(roles.name, "%caretaker%"))
      ));
      const roleIds = nannyRoles.map(role => role.id);
      const assignedRoles = roleIds.length > 0
        ? await db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(and(
            eq(employeeRoles.employeeId, existing.nannyEmployeeId), inArray(employeeRoles.roleId, roleIds)
          ))
        : [];
      if (assignedRoles.length === 0) return res.status(409).json({ message: "Employee does not have a nanny role" });
      const unavailable = await db.select({ id: employeeRoleAvailability.id }).from(employeeRoleAvailability).where(and(
        eq(employeeRoleAvailability.tenantId, tenantId),
        eq(employeeRoleAvailability.employeeId, existing.nannyEmployeeId),
        eq(employeeRoleAvailability.unavailableDate, today),
        inArray(employeeRoleAvailability.roleId, assignedRoles.map(role => role.roleId))
      )).limit(1);
      if (unavailable.length > 0) return res.status(409).json({ message: "Nanny is unavailable today" });
    }

    const updates: Record<string, any> = { status };
    
    if (status === "active") {
      updates.activatedAt = new Date();
    } else if (status === "completed") {
      updates.completedAt = new Date();
    } else if (status === "cancelled") {
      updates.cancelledAt = new Date();
      if (cancellationReason) {
        updates.cancellationReason = cancellationReason;
      }
    }

    const [updated] = await db.update(nannyReservations)
      .set(updates)
      .where(and(eq(nannyReservations.id, id), eq(nannyReservations.tenantId, tenantId), eq(nannyReservations.status, existing.status)))
      .returning();

    if (!updated) return res.status(409).json({ message: "Reservation changed while updating" });
    res.json(updated);
  } catch (error: any) {
    console.error("[Checkin] PATCH /api/core/nanny-reservations/:id error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Delete reservation
router.delete("/api/core/nanny-reservations/:id", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user as UserWithBranchAccess;

    // Fetch reservation first to check branch access
    const [existing] = await db.select().from(nannyReservations)
      .where(eq(nannyReservations.id, id));
    
    if (!existing) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    // Validate branch access
    const allowedScope = await getAllowedOperatorAndBranchIds(user);
    if (!allowedScope.isGlobalAdmin && allowedScope.branchIds !== null) {
      if (!allowedScope.branchIds.includes(existing.branchId)) {
        return res.status(403).json({ message: "Access denied to this reservation" });
      }
    }

    await db.delete(nannyReservations)
      .where(eq(nannyReservations.id, id));

    res.json({ message: "Reservation deleted" });
  } catch (error: any) {
    console.error("[Checkin] DELETE /api/core/nanny-reservations/:id error:", error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// EMPLOYEE ROLE AVAILABILITY
// ============================================

// Admin toggle nanny availability (for managers to toggle any nanny)
const adminToggleAvailabilitySchema = z.object({
  employeeId: z.string().uuid(),
  unavailable: z.boolean(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post("/api/core/nanny-availability/toggle", requireAuthOrKiosk, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    
    const parsed = adminToggleAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    }
    
    const { employeeId, unavailable, date } = parsed.data;
    // Use Bangkok timezone for date
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const targetDate = date || today;

    // Get the employee record
    const [employee] = await db.select()
      .from(employees)
      .where(and(
        eq(employees.id, employeeId),
        eq(employees.tenantId, tenantId)
      ));

    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    let userId: string | null = null;
    
    // For kiosk auth, validate that employee's branch matches the kiosk's branch
    if (req.kioskSession) {
      if (!employee.branchId || req.kioskSession.branchId !== employee.branchId) {
        return res.status(403).json({ message: "Access denied to this employee's branch" });
      }
    }
    // For regular auth, verify manager has access to this employee's branch
    else {
      const user = req.user as UserWithBranchAccess;
      if (!user) {
        return res.status(401).json({ message: "Authentication required" });
      }
      userId = user.id;
      const allowedScope = await getAllowedOperatorAndBranchIds(user);
      if (!allowedScope.isGlobalAdmin && allowedScope.branchIds !== null) {
        if (!employee.branchId || !allowedScope.branchIds.includes(employee.branchId)) {
          return res.status(403).json({ message: "Access denied to this employee's branch" });
        }
      }
    }

    // Find nanny roles
    const nannyRoles = await db.select()
      .from(roles)
      .where(and(
        eq(roles.tenantId, tenantId),
        or(
          ilike(roles.name, "%nanny%"),
          ilike(roles.name, "%พี่เลี้ยง%")
        )
      ));

    if (nannyRoles.length === 0) {
      return res.status(400).json({ message: "No nanny roles configured" });
    }

    // Check if employee has a nanny role
    const employeeNannyRoles = await db.select()
      .from(employeeRoles)
      .where(and(
        eq(employeeRoles.employeeId, employeeId),
        inArray(employeeRoles.roleId, nannyRoles.map(r => r.id))
      ));

    if (employeeNannyRoles.length === 0) {
      return res.status(400).json({ message: "Employee does not have a nanny role" });
    }

    const nannyRoleId = employeeNannyRoles[0].roleId;
    const nannyRoleName = nannyRoles.find(r => r.id === nannyRoleId)?.name || "Nanny";

    if (unavailable) {
      // Check if already marked unavailable
      const [existing] = await db.select()
        .from(employeeRoleAvailability)
        .where(and(
          eq(employeeRoleAvailability.employeeId, employeeId),
          eq(employeeRoleAvailability.roleId, nannyRoleId),
          eq(employeeRoleAvailability.unavailableDate, targetDate)
        ));

      if (!existing) {
        await db.insert(employeeRoleAvailability).values({
          tenantId,
          employeeId,
          roleId: nannyRoleId,
          roleName: nannyRoleName,
          unavailableDate: targetDate,
          createdByUserId: userId || null,
        });
      }
    } else {
      // Remove unavailability for all nanny roles
      await db.delete(employeeRoleAvailability)
        .where(and(
          eq(employeeRoleAvailability.employeeId, employeeId),
          inArray(employeeRoleAvailability.roleId, nannyRoles.map(r => r.id)),
          eq(employeeRoleAvailability.unavailableDate, targetDate)
        ));
    }

    res.json({ success: true, unavailable });
  } catch (error: any) {
    console.error("[Checkin] POST /api/core/nanny-availability/toggle error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get current user's roles and availability status for a date (or today)
router.get("/api/core/my-role-availability/:date?", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as UserWithBranchAccess;
    const tenantId = await getDefaultTenantId();
    const today = new Date().toISOString().split("T")[0];
    const targetDate = (req.params.date as string) || (req.query.date as string) || today;

    // Get the employee record for this user
    const [employee] = await db.select()
      .from(employees)
      .where(and(
        eq(employees.userId, user.id),
        eq(employees.tenantId, tenantId)
      ));

    if (!employee) {
      return res.json({ roles: [], unavailableRoles: [] });
    }

    // Get the employee's roles
    const userRoles = await db.select({
      roleId: employeeRoles.roleId,
      roleName: roles.name,
      isPrimary: employeeRoles.isPrimary,
    })
      .from(employeeRoles)
      .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
      .where(eq(employeeRoles.employeeId, employee.id));

    // Get unavailable roles for today
    const unavailable = await db.select()
      .from(employeeRoleAvailability)
      .where(and(
        eq(employeeRoleAvailability.employeeId, employee.id),
        eq(employeeRoleAvailability.unavailableDate, targetDate)
      ));

    res.json({
      employeeId: employee.id,
      roles: userRoles,
      unavailableRoles: unavailable.map(u => u.roleId),
      date: targetDate,
    });
  } catch (error: any) {
    console.error("[Checkin] GET /api/core/my-role-availability error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Toggle role availability for current user
const toggleAvailabilitySchema = z.object({
  roleId: z.string().uuid(),
  roleName: z.string().min(1),
  unavailable: z.boolean(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post("/api/core/my-role-availability", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as UserWithBranchAccess;
    const tenantId = await getDefaultTenantId();
    
    const parsed = toggleAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    }
    
    const { roleId, roleName, unavailable, date } = parsed.data;
    const today = new Date().toISOString().split("T")[0];
    const targetDate = date || today;

    // Get the employee record for this user
    const [employee] = await db.select()
      .from(employees)
      .where(and(
        eq(employees.userId, user.id),
        eq(employees.tenantId, tenantId)
      ));

    if (!employee) {
      return res.status(404).json({ message: "Employee record not found" });
    }

    // Verify the employee actually has this role
    const [hasRole] = await db.select()
      .from(employeeRoles)
      .where(and(
        eq(employeeRoles.employeeId, employee.id),
        eq(employeeRoles.roleId, roleId)
      ));

    if (!hasRole) {
      return res.status(403).json({ message: "You don't have this role assigned" });
    }

    if (unavailable) {
      // Check if already marked unavailable
      const [existing] = await db.select()
        .from(employeeRoleAvailability)
        .where(and(
          eq(employeeRoleAvailability.employeeId, employee.id),
          eq(employeeRoleAvailability.roleId, roleId),
          eq(employeeRoleAvailability.unavailableDate, targetDate)
        ));

      if (!existing) {
        await db.insert(employeeRoleAvailability).values({
          tenantId,
          employeeId: employee.id,
          roleId,
          roleName,
          unavailableDate: targetDate,
          createdByUserId: user.id,
        });
      }
    } else {
      // Remove unavailability
      await db.delete(employeeRoleAvailability)
        .where(and(
          eq(employeeRoleAvailability.employeeId, employee.id),
          eq(employeeRoleAvailability.roleId, roleId),
          eq(employeeRoleAvailability.unavailableDate, targetDate)
        ));
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Checkin] POST /api/core/my-role-availability error:", error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
