import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { db } from "./db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  parentPortalTokens,
  guestInviteTokens,
  invitationDesigns,
  rsvpEntries,
  parentMessageLogs,
  coreEvents,
  beoLocations,
  insertParentPortalTokenSchema,
  insertGuestInviteTokenSchema,
  insertInvitationDesignSchema,
  insertRsvpEntrySchema,
  insertParentMessageLogSchema,
} from "./db/coreSchema";
import { branches } from "@shared/schema";
import { generateSecureToken, INVITATION_TEMPLATES, formatDateForLanguage, formatTimeForLanguage, type ParentExperienceLanguage } from "../shared/localization";
import puppeteer from "puppeteer";
import { uploadToObjectStorage } from "./file-storage";
import multer from "multer";

const router = Router();

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

async function verifyEventTenant(eventId: string, tenantId: string): Promise<boolean> {
  const event = await db.query.coreEvents.findFirst({
    where: and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, tenantId)),
  });
  return !!event;
}

async function getEventByToken(tokenValue: string, tokenType: "parent" | "guest"): Promise<{
  event: typeof coreEvents.$inferSelect | null;
  token: typeof parentPortalTokens.$inferSelect | typeof guestInviteTokens.$inferSelect | null;
}> {
  const table = tokenType === "parent" ? parentPortalTokens : guestInviteTokens;
  
  const tokenRecord = await db.query[tokenType === "parent" ? "parentPortalTokens" : "guestInviteTokens"].findFirst({
    where: eq(table.token, tokenValue),
  });
  
  if (!tokenRecord || tokenRecord.revokedAt) {
    return { event: null, token: null };
  }
  
  const event = await db.query.coreEvents.findFirst({
    where: eq(coreEvents.id, tokenRecord.eventId),
  });
  
  if (tokenRecord) {
    await db.update(table).set({ lastAccessedAt: new Date() }).where(eq(table.id, tokenRecord.id));
  }
  
  return { event: event || null, token: tokenRecord };
}

router.post("/api/events/:eventId/parent-portal-token", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const existing = await db.query.parentPortalTokens.findFirst({
      where: and(eq(parentPortalTokens.eventId, eventId), sql`${parentPortalTokens.revokedAt} IS NULL`),
    });
    
    if (existing) {
      return res.json(existing);
    }
    
    const token = generateSecureToken(32);
    const [newToken] = await db.insert(parentPortalTokens).values({
      eventId,
      token,
      createdByUserId: user.id,
    }).returning();
    
    res.json(newToken);
  } catch (error) {
    console.error("Error creating parent portal token:", error);
    res.status(500).json({ error: "Failed to create parent portal token" });
  }
});

router.get("/api/events/:eventId/parent-portal-token", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const token = await db.query.parentPortalTokens.findFirst({
      where: and(eq(parentPortalTokens.eventId, eventId), sql`${parentPortalTokens.revokedAt} IS NULL`),
    });
    
    res.json(token || null);
  } catch (error) {
    console.error("Error fetching parent portal token:", error);
    res.status(500).json({ error: "Failed to fetch parent portal token" });
  }
});

router.delete("/api/parent-portal-tokens/:tokenId", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { tokenId } = req.params;
    
    const tokenRecord = await db.query.parentPortalTokens.findFirst({
      where: eq(parentPortalTokens.id, tokenId),
    });
    
    if (!tokenRecord) {
      return res.status(404).json({ error: "Token not found" });
    }
    
    const isValid = await verifyEventTenant(tokenRecord.eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    await db.update(parentPortalTokens)
      .set({ revokedAt: new Date() })
      .where(eq(parentPortalTokens.id, tokenId));
    
    res.json({ success: true });
  } catch (error) {
    console.error("Error revoking parent portal token:", error);
    res.status(500).json({ error: "Failed to revoke token" });
  }
});

router.post("/api/events/:eventId/guest-invite-token", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const existing = await db.query.guestInviteTokens.findFirst({
      where: and(eq(guestInviteTokens.eventId, eventId), sql`${guestInviteTokens.revokedAt} IS NULL`),
    });
    
    if (existing) {
      return res.json(existing);
    }
    
    const token = generateSecureToken(32);
    const [newToken] = await db.insert(guestInviteTokens).values({
      eventId,
      token,
      createdByUserId: user.id,
    }).returning();
    
    res.json(newToken);
  } catch (error) {
    console.error("Error creating guest invite token:", error);
    res.status(500).json({ error: "Failed to create guest invite token" });
  }
});

router.get("/api/events/:eventId/guest-invite-token", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const token = await db.query.guestInviteTokens.findFirst({
      where: and(eq(guestInviteTokens.eventId, eventId), sql`${guestInviteTokens.revokedAt} IS NULL`),
    });
    
    res.json(token || null);
  } catch (error) {
    console.error("Error fetching guest invite token:", error);
    res.status(500).json({ error: "Failed to fetch guest invite token" });
  }
});

router.get("/api/events/:eventId/invitation-design", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const design = await db.query.invitationDesigns.findFirst({
      where: eq(invitationDesigns.eventId, eventId),
    });
    
    res.json(design || null);
  } catch (error) {
    console.error("Error fetching invitation design:", error);
    res.status(500).json({ error: "Failed to fetch invitation design" });
  }
});

router.post("/api/events/:eventId/invitation-design", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const validatedData = insertInvitationDesignSchema.parse({ ...req.body, eventId });
    
    const existing = await db.query.invitationDesigns.findFirst({
      where: eq(invitationDesigns.eventId, eventId),
    });
    
    let design;
    if (existing) {
      [design] = await db.update(invitationDesigns)
        .set({ ...validatedData, updatedAt: new Date() })
        .where(eq(invitationDesigns.id, existing.id))
        .returning();
    } else {
      [design] = await db.insert(invitationDesigns).values(validatedData).returning();
    }
    
    res.json(design);
  } catch (error) {
    console.error("Error saving invitation design:", error);
    res.status(500).json({ error: "Failed to save invitation design" });
  }
});

router.get("/api/events/:eventId/rsvp-entries", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const entries = await db.query.rsvpEntries.findMany({
      where: and(eq(rsvpEntries.eventId, eventId), eq(rsvpEntries.isDeleted, false)),
      orderBy: desc(rsvpEntries.createdAt),
    });
    
    res.json(entries);
  } catch (error) {
    console.error("Error fetching RSVP entries:", error);
    res.status(500).json({ error: "Failed to fetch RSVP entries" });
  }
});

router.get("/api/events/:eventId/rsvp-summary", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const entries = await db.query.rsvpEntries.findMany({
      where: and(eq(rsvpEntries.eventId, eventId), eq(rsvpEntries.isDeleted, false)),
    });
    
    const summary = {
      total: entries.length,
      attending: entries.filter(e => e.attendingStatus === "yes").length,
      declined: entries.filter(e => e.attendingStatus === "no").length,
      maybe: entries.filter(e => e.attendingStatus === "maybe").length,
      totalKids: entries.filter(e => e.attendingStatus === "yes").reduce((sum, e) => sum + e.numberOfKids, 0),
      totalAdults: entries.filter(e => e.attendingStatus === "yes").reduce((sum, e) => sum + e.numberOfAdults, 0),
    };
    
    res.json(summary);
  } catch (error) {
    console.error("Error fetching RSVP summary:", error);
    res.status(500).json({ error: "Failed to fetch RSVP summary" });
  }
});

router.post("/api/events/:eventId/message-logs", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const validatedData = insertParentMessageLogSchema.parse({
      ...req.body,
      eventId,
      sentByUserId: user.id,
    });
    
    const [log] = await db.insert(parentMessageLogs).values(validatedData).returning();
    res.json(log);
  } catch (error) {
    console.error("Error creating message log:", error);
    res.status(500).json({ error: "Failed to create message log" });
  }
});

router.get("/api/events/:eventId/message-logs", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    
    const { eventId } = req.params;
    const isValid = await verifyEventTenant(eventId, user.tenantId);
    if (!isValid) return res.status(403).json({ error: "Access denied" });
    
    const logs = await db.query.parentMessageLogs.findMany({
      where: eq(parentMessageLogs.eventId, eventId),
      orderBy: desc(parentMessageLogs.sentAt),
    });
    
    res.json(logs);
  } catch (error) {
    console.error("Error fetching message logs:", error);
    res.status(500).json({ error: "Failed to fetch message logs" });
  }
});

router.get("/api/public/parent-portal/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { event, token: tokenRecord } = await getEventByToken(token, "parent");
    
    if (!event || !tokenRecord) {
      return res.status(404).json({ error: "Invalid or expired link" });
    }
    
    const design = await db.query.invitationDesigns.findFirst({
      where: eq(invitationDesigns.eventId, event.id),
    });
    
    const rsvpSummary = await db.query.rsvpEntries.findMany({
      where: and(eq(rsvpEntries.eventId, event.id), eq(rsvpEntries.isDeleted, false)),
    });
    
    const summary = {
      total: rsvpSummary.length,
      attending: rsvpSummary.filter(e => e.attendingStatus === "yes").length,
      declined: rsvpSummary.filter(e => e.attendingStatus === "no").length,
      maybe: rsvpSummary.filter(e => e.attendingStatus === "maybe").length,
      totalKids: rsvpSummary.filter(e => e.attendingStatus === "yes").reduce((sum, e) => sum + e.numberOfKids, 0),
      totalAdults: rsvpSummary.filter(e => e.attendingStatus === "yes").reduce((sum, e) => sum + e.numberOfAdults, 0),
    };
    
    const location = event.locationId 
      ? await db.query.beoLocations.findFirst({ where: eq(beoLocations.id, event.locationId) })
      : null;
    
    const branch = event.branchId
      ? await db.query.branches.findFirst({ where: eq(branches.id, event.branchId) })
      : null;
    
    const fullLocationName = [branch?.name, location?.name].filter(Boolean).join(" - ") || null;
    
    res.json({
      event: {
        id: event.id,
        name: event.title,
        childName: event.childName,
        description: event.programDetails,
        eventDate: event.eventDate,
        startTime: event.startTime,
        endTime: event.endTime,
        status: event.status,
        locationName: fullLocationName,
      },
      design,
      rsvpSummary: summary,
      rsvpEntries: rsvpSummary,
    });
  } catch (error) {
    console.error("Error fetching parent portal:", error);
    res.status(500).json({ error: "Failed to fetch parent portal" });
  }
});

router.get("/api/public/guest-invite/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { event, token: tokenRecord } = await getEventByToken(token, "guest");
    
    if (!event || !tokenRecord) {
      return res.status(404).json({ error: "Invalid or expired invitation link" });
    }
    
    const design = await db.query.invitationDesigns.findFirst({
      where: eq(invitationDesigns.eventId, event.id),
    });
    
    const location = event.locationId 
      ? await db.query.beoLocations.findFirst({ where: eq(beoLocations.id, event.locationId) })
      : null;
    
    const branch = event.branchId
      ? await db.query.branches.findFirst({ where: eq(branches.id, event.branchId) })
      : null;
    
    const fullLocationName = [branch?.name, location?.name].filter(Boolean).join(" - ") || null;
    
    const guestIdentifier = typeof req.query.guestIdentifier === "string" ? req.query.guestIdentifier : null;
    let myRsvp = null;
    if (guestIdentifier) {
      myRsvp = await db.query.rsvpEntries.findFirst({
        where: and(
          eq(rsvpEntries.eventId, event.id),
          eq(rsvpEntries.guestIdentifier, guestIdentifier),
          eq(rsvpEntries.isDeleted, false)
        ),
        orderBy: desc(rsvpEntries.createdAt),
      });
    }
    
    res.json({
      event: {
        id: event.id,
        name: event.title,
        childName: event.childName,
        childAgeTurning: event.kidTurningAge ?? null,
        description: event.programDetails,
        eventDate: event.eventDate,
        startTime: event.startTime,
        endTime: event.endTime,
        locationName: fullLocationName,
      },
      design,
      myRsvp: myRsvp || null,
    });
  } catch (error) {
    console.error("Error fetching guest invite:", error);
    res.status(500).json({ error: "Failed to fetch invitation" });
  }
});

router.post("/api/public/guest-invite/:token/rsvp", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { event, token: tokenRecord } = await getEventByToken(token, "guest");
    
    if (!event || !tokenRecord) {
      return res.status(404).json({ error: "Invalid or expired invitation link" });
    }
    
    const { guestIdentifier } = req.body;
    
    const validatedData = insertRsvpEntrySchema.parse({
      ...req.body,
      eventId: event.id,
      source: "guest_link",
    });
    
    let rsvp;
    if (guestIdentifier) {
      const existing = await db.query.rsvpEntries.findFirst({
        where: and(
          eq(rsvpEntries.eventId, event.id),
          eq(rsvpEntries.guestIdentifier, guestIdentifier),
          eq(rsvpEntries.isDeleted, false)
        ),
        orderBy: desc(rsvpEntries.createdAt),
      });
      
      if (existing) {
        [rsvp] = await db.update(rsvpEntries)
          .set({ ...validatedData, updatedAt: new Date() })
          .where(eq(rsvpEntries.id, existing.id))
          .returning();
      }
    }
    
    if (!rsvp) {
      [rsvp] = await db.insert(rsvpEntries).values(validatedData).returning();
    }
    
    res.json(rsvp);
  } catch (error) {
    console.error("Error submitting RSVP:", error);
    res.status(500).json({ error: "Failed to submit RSVP" });
  }
});

router.get("/api/invitation-templates", async (_req: Request, res: Response) => {
  res.json(INVITATION_TEMPLATES);
});

router.get("/api/public/parent-portal/:token/full", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { event, token: tokenRecord } = await getEventByToken(token, "parent");
    
    if (!event || !tokenRecord) {
      return res.status(404).json({ error: "Invalid or expired link" });
    }
    
    const design = await db.query.invitationDesigns.findFirst({
      where: eq(invitationDesigns.eventId, event.id),
    });
    
    const rsvpList = await db.query.rsvpEntries.findMany({
      where: and(eq(rsvpEntries.eventId, event.id), eq(rsvpEntries.isDeleted, false)),
      orderBy: desc(rsvpEntries.createdAt),
    });
    
    const summary = {
      total: rsvpList.length,
      attending: rsvpList.filter(e => e.attendingStatus === "yes").length,
      declined: rsvpList.filter(e => e.attendingStatus === "no").length,
      maybe: rsvpList.filter(e => e.attendingStatus === "maybe").length,
      totalKids: rsvpList.filter(e => e.attendingStatus === "yes").reduce((sum, e) => sum + e.numberOfKids, 0),
      totalAdults: rsvpList.filter(e => e.attendingStatus === "yes").reduce((sum, e) => sum + e.numberOfAdults, 0),
    };
    
    let guestToken = await db.query.guestInviteTokens.findFirst({
      where: and(eq(guestInviteTokens.eventId, event.id), sql`${guestInviteTokens.revokedAt} IS NULL`),
    });
    
    if (!guestToken) {
      const newToken = generateSecureToken(32);
      [guestToken] = await db.insert(guestInviteTokens).values({
        eventId: event.id,
        token: newToken,
      }).returning();
    }
    
    const location = event.locationId 
      ? await db.query.beoLocations.findFirst({ where: eq(beoLocations.id, event.locationId) })
      : null;
    
    const branch = event.branchId
      ? await db.query.branches.findFirst({ where: eq(branches.id, event.branchId) })
      : null;
    
    const fullLocationName = [branch?.name, location?.name].filter(Boolean).join(" - ") || null;
    
    res.json({
      event: {
        id: event.id,
        name: event.title,
        childName: event.childName,
        childAgeTurning: event.kidTurningAge ?? null,
        description: event.programDetails,
        eventDate: event.eventDate,
        startTime: event.startTime,
        endTime: event.endTime,
        status: event.status,
        locationName: fullLocationName,
      },
      design,
      rsvpSummary: summary,
      rsvpEntries: rsvpList,
      guestInviteToken: guestToken.token,
      templates: INVITATION_TEMPLATES,
    });
  } catch (error) {
    console.error("Error fetching parent portal full data:", error);
    res.status(500).json({ error: "Failed to fetch parent portal data" });
  }
});

router.post("/api/public/parent-portal/:token/upload-photo", photoUpload.single("photo"), async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { event, token: tokenRecord } = await getEventByToken(token, "parent");
    
    if (!event || !tokenRecord) {
      return res.status(404).json({ error: "Invalid or expired link" });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: "No photo file provided" });
    }
    
    const ext = req.file.originalname.split(".").pop() || "jpg";
    const fileName = `child-photo-${event.id}-${Date.now()}.${ext}`;
    
    const photoUrl = await uploadToObjectStorage(
      req.file.buffer,
      "invitations",
      fileName,
      req.file.mimetype
    );
    
    res.json({ photoUrl });
  } catch (error: any) {
    console.error("Error uploading invitation photo:", error);
    res.status(500).json({ error: "Failed to upload photo" });
  }
});

router.post("/api/public/parent-portal/:token/invitation-design", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { event, token: tokenRecord } = await getEventByToken(token, "parent");
    
    if (!event || !tokenRecord) {
      return res.status(404).json({ error: "Invalid or expired link" });
    }
    
    const validatedData = insertInvitationDesignSchema.parse({ ...req.body, eventId: event.id });
    
    const existing = await db.query.invitationDesigns.findFirst({
      where: eq(invitationDesigns.eventId, event.id),
    });
    
    let design;
    if (existing) {
      [design] = await db.update(invitationDesigns)
        .set({ ...validatedData, updatedAt: new Date() })
        .where(eq(invitationDesigns.id, existing.id))
        .returning();
    } else {
      [design] = await db.insert(invitationDesigns).values(validatedData).returning();
    }
    
    res.json(design);
  } catch (error: any) {
    console.error("Error saving invitation design:", error);
    if (error.issues) {
      console.error("Zod validation errors:", JSON.stringify(error.issues, null, 2));
    }
    res.status(500).json({ error: "Failed to save invitation design", details: error.message });
  }
});

router.post("/api/public/parent-portal/:token/generate-invitation", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { event, token: tokenRecord } = await getEventByToken(token, "parent");
    
    if (!event || !tokenRecord) {
      return res.status(404).json({ error: "Invalid or expired link" });
    }
    
    const design = await db.query.invitationDesigns.findFirst({
      where: eq(invitationDesigns.eventId, event.id),
    });
    
    if (!design) {
      return res.status(400).json({ error: "Invitation design not found. Please save design first." });
    }
    
    const lang = (design.language || "en") as ParentExperienceLanguage;
    const eventDate = new Date(design.eventDate);
    const formattedDate = formatDateForLanguage(eventDate, lang);
    const formattedTime = formatTimeForLanguage(design.startTime, lang) + (design.endTime ? ` – ${formatTimeForLanguage(design.endTime, lang)}` : "");

    // Derive ordinal age label from childAge (stored as numeric string or ordinal string)
    const rawAge = design.childAge;
    let ordinalAge = "";
    if (rawAge) {
      const num = parseInt(rawAge, 10);
      if (!isNaN(num)) {
        const s = ["th", "st", "nd", "rd"];
        const v = num % 100;
        ordinalAge = num + (s[(v - 20) % 10] || s[v] || s[0]);
      } else {
        ordinalAge = rawAge;
      }
    }

    const birthdayLine = ordinalAge
      ? `${design.childName}'s ${ordinalAge} Birthday Party`
      : `${design.childName}'s Birthday Party`;

    const OTO = {
      orange: "#E8734A",
      pink: "#D95BA3",
      lightPink: "#E8A8C8",
      yellow: "#F2D94E",
      teal: "#4AABBF",
      lime: "#A3B832",
      bg: "#FDF8F2",
    };

    // Read OTO shape assets as base64 data URIs for Puppeteer rendering
    const assetsDir = path.join(process.cwd(), "client/public/oto-assets");
    const readAsDataUri = (file: string, mime: string) => {
      try {
        const buf = fs.readFileSync(path.join(assetsDir, file));
        return `data:${mime};base64,${buf.toString("base64")}`;
      } catch {
        return "";
      }
    };
    const imgPink   = readAsDataUri("shape-pink.png",   "image/png");
    const imgYellow = readAsDataUri("shape-yellow.png", "image/png");
    const imgBlue   = readAsDataUri("shape-blue.png",   "image/png");
    const imgGreen  = readAsDataUri("shape-green.png",  "image/png");
    const imgOrange = readAsDataUri("shape-orange.png", "image/png");
    const imgDragon = readAsDataUri("dragon-2.jpg",     "image/jpeg");

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 800px;
            height: 800px;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #FFE8F4 0%, #FFF4DC 40%, #E8F6FF 100%);
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }
          .top-band {
            height: 18px;
            background: linear-gradient(90deg, ${OTO.orange} 0%, ${OTO.pink} 25%, ${OTO.yellow} 50%, ${OTO.teal} 75%, ${OTO.lime} 100%);
            flex-shrink: 0;
          }
          .bottom-band {
            height: 18px;
            background: linear-gradient(90deg, ${OTO.lime} 0%, ${OTO.teal} 25%, ${OTO.yellow} 50%, ${OTO.pink} 75%, ${OTO.orange} 100%);
            flex-shrink: 0;
            margin-top: auto;
          }
          .content {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 28px 40px;
            position: relative;
          }
          /* Decorative corner shapes */
          .shape { position: absolute; pointer-events: none; }
          .shape-tl { width: 110px; top: 8px;  left: 8px;  transform: rotate(-12deg); opacity: 0.95; }
          .shape-tr { width: 90px;  top: 10px; right: 8px; transform: rotate(8deg);   opacity: 0.95; }
          .shape-bl { width: 82px; bottom: 8px;  left: 6px;  transform: rotate(10deg);  opacity: 0.9; }
          .shape-br { width: 82px; bottom: 8px;  right: 6px; transform: rotate(-8deg);  opacity: 0.9; }
          /* Confetti dots */
          .dot { position: absolute; border-radius: 50%; pointer-events: none; opacity: 0.35; }
          /* Headline badge */
          .headline {
            font-size: 48px;
            font-weight: 900;
            color: #fff;
            background: ${OTO.orange};
            border-radius: 16px;
            padding: 10px 36px;
            letter-spacing: -0.5px;
            line-height: 1;
            margin-bottom: 20px;
            box-shadow: 0 6px 20px ${OTO.orange}55;
          }
          /* Gradient photo ring outer wrapper */
          .photo-outer {
            width: 168px;
            height: 168px;
            border-radius: 50%;
            background: conic-gradient(${OTO.orange}, ${OTO.pink}, ${OTO.yellow}, ${OTO.teal}, ${OTO.lime}, ${OTO.orange});
            padding: 5px;
            margin-bottom: 20px;
            box-shadow: 0 6px 20px rgba(0,0,0,0.12);
            flex-shrink: 0;
          }
          .photo-inner {
            width: 100%;
            height: 100%;
            border-radius: 50%;
            overflow: hidden;
            background: #F9DDEF;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .photo-inner img { width: 100%; height: 100%; object-fit: cover; }
          /* Birthday line badge */
          .birthday-line {
            font-size: 24px;
            font-weight: 700;
            color: #fff;
            background: ${OTO.pink};
            border-radius: 12px;
            padding: 8px 24px;
            text-align: center;
            max-width: 500px;
            line-height: 1.25;
            margin-bottom: 22px;
            box-shadow: 0 4px 14px ${OTO.pink}44;
          }
          /* Details box — solid white */
          .details-box {
            background: #fff;
            border: 2px solid ${OTO.lightPink};
            border-radius: 16px;
            padding: 18px 30px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-width: 360px;
            box-shadow: 0 2px 12px rgba(217,91,163,0.08);
          }
          .detail-row {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 18px;
            color: #333;
            font-weight: 500;
          }
          .dot-icon {
            width: 22px; height: 22px;
            border-radius: 50%;
            flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
            font-size: 12px;
          }
          .icon-date { background: ${OTO.orange}22; color: ${OTO.orange}; }
          .icon-time { background: ${OTO.teal}22;   color: ${OTO.teal}; }
          .icon-loc  { background: ${OTO.pink}22;   color: ${OTO.pink}; }
          .footer-text {
            margin-top: 16px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.2em;
            color: ${OTO.orange};
            opacity: 0.8;
          }
          /* Dragon mascot */
          .dragon-mascot {
            position: absolute;
            width: 96px;
            bottom: 26px;
            right: 12px;
            border-radius: 14px;
            opacity: 0.92;
            pointer-events: none;
            z-index: 0;
          }
        </style>
      </head>
      <body>
        <div class="top-band"></div>
        <div class="content">
          ${imgPink   ? `<img class="shape shape-tl" src="${imgPink}"   alt="" />` : ""}
          ${imgYellow ? `<img class="shape shape-tr" src="${imgYellow}" alt="" />` : ""}
          ${imgBlue   ? `<img class="shape shape-bl" src="${imgBlue}"   alt="" />` : ""}
          ${imgGreen  ? `<img class="shape shape-br" src="${imgGreen}"  alt="" />` : ""}
          ${imgDragon ? `<img class="dragon-mascot" src="${imgDragon}" alt="" />` : ""}

          <!-- Confetti dots -->
          <div class="dot" style="width:12px;height:12px;background:${OTO.orange};top:52px;left:28%"></div>
          <div class="dot" style="width:10px;height:10px;background:${OTO.pink};top:70px;right:28%"></div>
          <div class="dot" style="width:9px;height:9px;background:${OTO.yellow};top:110px;left:22%"></div>
          <div class="dot" style="width:11px;height:11px;background:${OTO.teal};top:90px;right:22%"></div>
          <div class="dot" style="width:10px;height:10px;background:${OTO.lime};bottom:65px;left:26%"></div>
          <div class="dot" style="width:12px;height:12px;background:${OTO.orange};bottom:85px;right:26%"></div>
          <div class="dot" style="width:8px;height:8px;background:${OTO.pink};top:140px;left:18%"></div>
          <div class="dot" style="width:8px;height:8px;background:${OTO.teal};top:125px;right:18%"></div>

          <div class="headline">You're Invited</div>

          <div class="photo-outer">
            <div class="photo-inner">
              ${design.photoUrl
                ? `<img src="${design.photoUrl}" alt="${design.childName}" />`
                : (imgOrange ? `<img src="${imgOrange}" alt="" style="width:100%;height:100%;object-fit:contain;padding:24px;opacity:0.75;" />` : "")
              }
            </div>
          </div>

          <div class="birthday-line">${birthdayLine}</div>

          <div class="details-box">
            <div class="detail-row">
              <div class="dot-icon icon-date"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/><line x1="8" x2="8" y1="14" y2="18"/><line x1="12" x2="12" y1="14" y2="18"/><line x1="16" x2="16" y1="14" y2="18"/></svg></div>
              <span>${formattedDate}</span>
            </div>
            <div class="detail-row">
              <div class="dot-icon icon-time"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16.5 12"/></svg></div>
              <span>${formattedTime}</span>
            </div>
            ${design.locationName
              ? `<div class="detail-row"><div class="dot-icon icon-loc"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></div><span>${design.locationName}</span></div>`
              : ""}
          </div>
          <div class="footer-text">OTO BIRTHDAY EXPERIENCE</div>
        </div>
        <div class="bottom-band"></div>
      </body>
      </html>
    `;
    
    const browser = await puppeteer.launch({ 
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 800 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 90 });
    await browser.close();
    
    const fileName = `invitation-${event.id}-${Date.now()}.jpg`;
    const imageUrl = await uploadToObjectStorage(
      Buffer.from(screenshotBuffer),
      'invitations',
      fileName,
      'image/jpeg'
    );
    
    const [updatedDesign] = await db.update(invitationDesigns)
      .set({ generatedImageUrl: imageUrl, updatedAt: new Date() })
      .where(eq(invitationDesigns.id, design.id))
      .returning();
    
    res.json({ 
      success: true, 
      imageUrl,
      design: updatedDesign,
    });
  } catch (error) {
    console.error("Error generating invitation:", error);
    res.status(500).json({ error: "Failed to generate invitation" });
  }
});

export default router;
