import { Express } from "express";
import { requireAuth } from "./auth";
import { requireManager, requireRole } from "./auth-middleware";
import { db } from "./db";
import { 
  beoLocations, insertBeoLocationSchema,
  beoPartyHostAssignments, insertBeoPartyHostAssignmentSchema,
  beoEntertainmentAssignments, insertBeoEntertainmentAssignmentSchema,
  beoSetupPlans, insertBeoSetupPlanSchema,
  beoKitchenPlans, insertBeoKitchenPlanSchema,
  beoBarPlans, insertBeoBarPlanSchema,
  beoEventBilling, insertBeoEventBillingSchema,
  beoTimelineItems, insertBeoTimelineItemSchema,
  beoEntertainmentOptions, insertBeoEntertainmentOptionSchema,
  beoSetupItemOptions, insertBeoSetupItemOptionSchema,
  beoAssignmentTargets, insertBeoAssignmentTargetSchema,
  beoSetupItems, insertBeoSetupItemSchema,
  beoEntertainmentItems, insertBeoEntertainmentItemSchema,
  eventLineItemTemplates, insertEventLineItemTemplateSchema,
  eventLineItems, insertEventLineItemSchema,
  beoPackageSnapshots,
  beoPackageSnapshotItems,
  beoEntertainmentSelections,
  beoSetMenuTemplates,
  beoSetMenuSelections,
  coreEvents,
  users,
  roles,
  branches,
  employees,
  tasks,
  type BeoEventWithDetails,
} from "@shared/schema";
import crypto from "crypto";
import { eq, and, asc, desc, sql, inArray } from "drizzle-orm";
import { generateBeoPdf, type BeoPdfData } from "./pdf";

type KitchenMenuBucket = "kids" | "adults";
type KitchenMenuLine = { source?: string; [key: string]: unknown };
type KitchenMenuCollection = Record<string, unknown>;

function asMenuCollection(value: unknown): KitchenMenuCollection {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as KitchenMenuCollection
    : {};
}

function asMenuItems(value: unknown): KitchenMenuLine[] {
  return Array.isArray(value) ? value as KitchenMenuLine[] : [];
}

function withoutSetMenuItems(value: unknown): KitchenMenuCollection {
  const menus = asMenuCollection(value);
  return {
    ...menus,
    kids: asMenuItems(menus.kids).filter((item) => item.source !== "set_menu"),
    adults: asMenuItems(menus.adults).filter((item) => item.source !== "set_menu"),
  };
}

function replaceSetMenuItems(
  value: unknown,
  bucket: KitchenMenuBucket,
  resolvedItems: KitchenMenuLine[],
): KitchenMenuCollection {
  const menus = asMenuCollection(value);
  const additionalItems = asMenuItems(menus[bucket])
    .filter((item) => item.source !== "set_menu");
  return {
    ...menus,
    [bucket]: [...resolvedItems, ...additionalItems],
  };
}

function preserveServerSetMenuItems(
  staffValue: unknown,
  persistedValue: unknown,
  preserveSubmittedItems: boolean,
): KitchenMenuCollection {
  const staffMenus = asMenuCollection(staffValue);
  if (!preserveSubmittedItems) return staffMenus;

  const persistedMenus = asMenuCollection(persistedValue);
  const mergeBucket = (bucket: KitchenMenuBucket) => {
    const staffItems = asMenuItems(staffMenus[bucket]);
    const persistedSetItems = asMenuItems(persistedMenus[bucket])
      .filter((item) => item.source === "set_menu");
    return [...persistedSetItems, ...staffItems.filter((item) => item.source !== "set_menu")];
  };

  return {
    ...staffMenus,
    kids: mergeBucket("kids"),
    adults: mergeBucket("adults"),
  };
}

function isStaleSetMenuSubmission(
  selection: { isSubmitted: boolean; submittedAt: Date | null } | undefined,
  clientSubmittedAt: unknown,
): boolean {
  if (!selection?.isSubmitted || !selection.submittedAt) return false;
  if (typeof clientSubmittedAt !== "string") return true;
  const parsedClientDate = new Date(clientSubmittedAt);
  return Number.isNaN(parsedClientDate.getTime()) ||
    selection.submittedAt.toISOString() !== parsedClientDate.toISOString();
}

function resolveSetMenuBucket(value: unknown): KitchenMenuBucket {
  const menus = asMenuCollection(value);
  const kidsItems = asMenuItems(menus.kids);
  const adultsItems = asMenuItems(menus.adults);
  return adultsItems.length > 0 && kidsItems.length === 0 ? "adults" : "kids";
}

async function lockKitchenPlanMutation(tx: any, eventId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`);
}

async function generateTimelineFromBeo(eventId: string): Promise<void> {
  const [event] = await db.select().from(coreEvents)
    .where(eq(coreEvents.id, eventId));

  if (!event) return;

  const suppressed = new Set<string>(event.suppressedTimelineSources || []);

  const [setupPlan] = await db.select().from(beoSetupPlans)
    .where(eq(beoSetupPlans.eventId, eventId));
  const [kitchenPlan] = await db.select().from(beoKitchenPlans)
    .where(eq(beoKitchenPlans.eventId, eventId));
  const [barPlan] = await db.select().from(beoBarPlans)
    .where(eq(beoBarPlans.eventId, eventId));
  const entertainmentItems = await db.select().from(beoEntertainmentItems)
    .where(eq(beoEntertainmentItems.eventId, eventId))
    .orderBy(asc(beoEntertainmentItems.sortOrder));

  const startTimeParts = event.startTime?.split(":").map(Number) || [14, 0];
  const startTotalMin = startTimeParts[0] * 60 + startTimeParts[1];
  function timeToOffset(timeStr: string): number | null {
    if (!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr)) return null;
    const [h, m] = timeStr.split(":").map(Number);
    const result = (h * 60 + m) - startTotalMin;
    return isNaN(result) ? null : result;
  }

  // Build source key → {label, offset} map for all timed sources
  const sourceMap = new Map<string, { label: string; offsetMinutes: number; assignedToType: string }>();

  // Setup Plan items
  if (setupPlan?.setupRequired) {
    const setupTasksRaw = setupPlan.setupTasks as any;
    const oldSetupItems = (setupPlan.setupItems as string[]) || [];
    const simplifiedTasks: any[] = Array.isArray(setupTasksRaw)
      ? setupTasksRaw
      : (setupTasksRaw?.simplifiedTasks && Array.isArray(setupTasksRaw.simplifiedTasks)
        ? setupTasksRaw.simplifiedTasks
        : []);
    const readyBy: string = (!Array.isArray(setupTasksRaw) && setupTasksRaw?.readyBy) || "";

    if (simplifiedTasks.length > 0) {
      simplifiedTasks.forEach((task: any, idx: number) => {
        const key = `setup_task::${idx}`;
        const deadlineOffset = -(task.deadlineOffsetMin || 30);
        sourceMap.set(key, {
          label: task.itemLabel || task.itemKey || "Setup task",
          offsetMinutes: deadlineOffset,
          assignedToType: "SETUP_RESPONSIBLE",
        });
      });
    } else if (readyBy) {
      const readyByOffset = timeToOffset(readyBy);
      if (readyByOffset !== null) {
        sourceMap.set("setup_ready", {
          label: "Setup ready",
          offsetMinutes: readyByOffset,
          assignedToType: "SETUP_RESPONSIBLE",
        });
      }
    } else if (oldSetupItems.length > 0) {
      const setupDeadlineOffset = -(setupPlan.setupDeadlineOffsetMinutes || 30);
      oldSetupItems.forEach((itemName: string, idx: number) => {
        sourceMap.set(`setup_item::${idx}`, {
          label: itemName,
          offsetMinutes: setupDeadlineOffset,
          assignedToType: "SETUP_RESPONSIBLE",
        });
      });
    }
  }

  // Guests arrive (always present)
  sourceMap.set("guests_arrive", {
    label: "Guests arrive",
    offsetMinutes: 0,
    assignedToType: "PARTY_HOST",
  });

  // Kitchen Plan service schedule blocks
  if (kitchenPlan?.foodRequired) {
    const schedule = (kitchenPlan.serviceSchedule as any[]) || [];
    const seenServiceBlocks = new Set<string>();
    schedule.forEach((block: any, idx: number) => {
      if (block.label || block.time) {
        const dedupeKey = `${block.label || ""}::${block.time || ""}`;
        if (seenServiceBlocks.has(dedupeKey)) return;
        seenServiceBlocks.add(dedupeKey);
        let offset = 15;
        if (block.time) {
          offset = timeToOffset(block.time) ?? 15;
        }
        const itemNames = (block.items as any[] || [])
          .filter((i: any) => i.itemName)
          .map((i: any) => `${i.quantity}x ${i.itemName}`)
          .slice(0, 3);
        const suffix = itemNames.length > 0 ? ` (${itemNames.join(", ")})` : "";
        sourceMap.set(`kitchen_service::${idx}`, {
          label: `${block.label || "F&B Service"}${suffix}`,
          offsetMinutes: offset,
          assignedToType: "KITCHEN_RESPONSIBLE",
        });
      }
    });
  }

  // Kitchen Plan cake moment
  if (kitchenPlan?.cakeMode && kitchenPlan.cakeMode !== "NONE") {
    const cakeTime = (kitchenPlan as any).cakeTime;
    if (cakeTime) {
      const cakeOffset = timeToOffset(cakeTime);
      if (cakeOffset !== null) {
        const cakeLabel = kitchenPlan.cakeMode === "EXTERNAL"
          ? `Cake moment (own cake${(kitchenPlan as any).cakeNotes ? `: ${(kitchenPlan as any).cakeNotes}` : ""})`
          : "Cake moment";
        sourceMap.set("cake", {
          label: cakeLabel,
          offsetMinutes: cakeOffset,
          assignedToType: "PARTY_HOST",
        });
      }
    }
  }

  // Bar Plan service time
  if (barPlan?.serviceTime) {
    const barOffset = timeToOffset(barPlan.serviceTime);
    if (barOffset !== null) {
      sourceMap.set("bar_service", {
        label: "Drinks Service",
        offsetMinutes: barOffset,
        assignedToType: "PARTY_HOST",
      });
    }
  }

  // Entertainment items with a start time
  for (const ei of entertainmentItems) {
    if (ei.startTime) {
      const entOffset = timeToOffset(ei.startTime);
      if (entOffset !== null) {
        const entLabel = ei.customName || "Entertainment";
        sourceMap.set(`entertainment::${ei.id}`, {
          label: entLabel,
          offsetMinutes: entOffset,
          assignedToType: "PARTY_HOST",
        });
      }
    }
  }

  // Fetch all existing system-generated timeline items for this event
  const existingSystemItems = await db.select().from(beoTimelineItems)
    .where(and(
      eq(beoTimelineItems.eventId, eventId),
      eq(beoTimelineItems.isSystemGenerated, true)
    ));

  const existingBySourceKey = new Map<string, typeof existingSystemItems[number]>();
  const existingNoSourceKey: typeof existingSystemItems = [];
  for (const item of existingSystemItems) {
    if (item.sourceKey) {
      existingBySourceKey.set(item.sourceKey, item);
    } else {
      existingNoSourceKey.push(item);
    }
  }

  // Delete legacy system-generated items that have no sourceKey (old purge-and-recreate leftovers)
  if (existingNoSourceKey.length > 0) {
    await db.delete(beoTimelineItems)
      .where(inArray(beoTimelineItems.id, existingNoSourceKey.map(i => i.id)));
  }

  // Process each source key
  for (const [sourceKey, { label, offsetMinutes, assignedToType }] of sourceMap.entries()) {
    // Skip suppressed sources
    if (suppressed.has(sourceKey)) continue;

    const existing = existingBySourceKey.get(sourceKey);
    if (existing) {
      // Update if label or offset changed (never touch isCompleted or sortOrder)
      if (existing.label !== label || existing.offsetFromStartMinutes !== offsetMinutes) {
        await db.update(beoTimelineItems)
          .set({ label, offsetFromStartMinutes: offsetMinutes, updatedAt: new Date() })
          .where(eq(beoTimelineItems.id, existing.id));
      }
      existingBySourceKey.delete(sourceKey); // Mark as handled
    } else {
      // Insert new system-generated item
      await db.insert(beoTimelineItems).values({
        eventId,
        label,
        offsetFromStartMinutes: offsetMinutes,
        assignedToType: assignedToType as any,
        isSystemGenerated: true,
        sourceKey,
        sortOrder: 0,
      });
    }
  }

  // Delete system-generated rows whose sourceKey is no longer in the generated map
  // (source was removed from BEO, or is suppressed and already in DB from before suppression)
  const orphanedIds = [...existingBySourceKey.values()]
    .filter(item => !suppressed.has(item.sourceKey!))
    .map(item => item.id);
  if (orphanedIds.length > 0) {
    await db.delete(beoTimelineItems)
      .where(inArray(beoTimelineItems.id, orphanedIds));
  }
}

export function registerBeoRoutes(app: Express) {
  // Helper to verify event belongs to tenant
  async function verifyEventTenant(eventId: string, tenantId: string): Promise<boolean> {
    const [event] = await db.select().from(coreEvents)
      .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, tenantId)));
    return !!event;
  }

  // ---
  // BEO LOCATIONS
  // ---
  
  app.get("/api/beo/locations", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const branchId = req.query.branchId as string | undefined;
      
      if (branchId) {
        const locations = await db.select().from(beoLocations)
          .where(and(
            eq(beoLocations.tenantId, user.tenantId),
            eq(beoLocations.isActive, true),
            sql`(${beoLocations.branchId} = ${branchId} OR ${branchId} = ANY(${beoLocations.branchIds}))`
          ))
          .orderBy(asc(beoLocations.sortOrder));
        return res.json(locations);
      }
      
      const locations = await db.select().from(beoLocations)
        .where(eq(beoLocations.tenantId, user.tenantId))
        .orderBy(asc(beoLocations.sortOrder));
      res.json(locations);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/locations", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const parsed = insertBeoLocationSchema.parse({ ...req.body, tenantId: user.tenantId });
      const [location] = await db.insert(beoLocations).values(parsed).returning();
      res.status(201).json(location);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/beo/locations/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const [updated] = await db.update(beoLocations)
        .set(req.body)
        .where(and(eq(beoLocations.id, id), eq(beoLocations.tenantId, user.tenantId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Location not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/beo/locations/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      await db.update(beoLocations)
        .set({ isActive: false })
        .where(and(eq(beoLocations.id, id), eq(beoLocations.tenantId, user.tenantId)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO ENTERTAINMENT OPTIONS (configurable)
  // ---

  app.get("/api/beo/entertainment-options", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const activeOnly = req.query.activeOnly === "true";
      
      let query = db.select().from(beoEntertainmentOptions)
        .where(eq(beoEntertainmentOptions.tenantId, user.tenantId));
      
      if (activeOnly) {
        const options = await db.select().from(beoEntertainmentOptions)
          .where(and(
            eq(beoEntertainmentOptions.tenantId, user.tenantId),
            eq(beoEntertainmentOptions.isActive, true)
          ))
          .orderBy(asc(beoEntertainmentOptions.sortOrder));
        return res.json(options);
      }
      
      const options = await db.select().from(beoEntertainmentOptions)
        .where(eq(beoEntertainmentOptions.tenantId, user.tenantId))
        .orderBy(asc(beoEntertainmentOptions.sortOrder));
      res.json(options);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/entertainment-options", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const parsed = insertBeoEntertainmentOptionSchema.parse({ ...req.body, tenantId: user.tenantId });
      const [option] = await db.insert(beoEntertainmentOptions).values(parsed).returning();
      res.status(201).json(option);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/beo/entertainment-options/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const [updated] = await db.update(beoEntertainmentOptions)
        .set(req.body)
        .where(and(eq(beoEntertainmentOptions.id, id), eq(beoEntertainmentOptions.tenantId, user.tenantId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Entertainment option not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/beo/entertainment-options/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      await db.update(beoEntertainmentOptions)
        .set({ isActive: false })
        .where(and(eq(beoEntertainmentOptions.id, id), eq(beoEntertainmentOptions.tenantId, user.tenantId)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO SETUP ITEM OPTIONS (configurable)
  // ---

  app.get("/api/beo/setup-item-options", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const activeOnly = req.query.activeOnly === "true";
      
      if (activeOnly) {
        const options = await db.select().from(beoSetupItemOptions)
          .where(and(
            eq(beoSetupItemOptions.tenantId, user.tenantId),
            eq(beoSetupItemOptions.isActive, true)
          ))
          .orderBy(asc(beoSetupItemOptions.sortOrder));
        return res.json(options);
      }
      
      const options = await db.select().from(beoSetupItemOptions)
        .where(eq(beoSetupItemOptions.tenantId, user.tenantId))
        .orderBy(asc(beoSetupItemOptions.sortOrder));
      res.json(options);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/setup-item-options", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const parsed = insertBeoSetupItemOptionSchema.parse({ ...req.body, tenantId: user.tenantId });
      const [option] = await db.insert(beoSetupItemOptions).values(parsed).returning();
      res.status(201).json(option);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/beo/setup-item-options/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const [updated] = await db.update(beoSetupItemOptions)
        .set(req.body)
        .where(and(eq(beoSetupItemOptions.id, id), eq(beoSetupItemOptions.tenantId, user.tenantId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Setup item option not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/beo/setup-item-options/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      await db.update(beoSetupItemOptions)
        .set({ isActive: false })
        .where(and(eq(beoSetupItemOptions.id, id), eq(beoSetupItemOptions.tenantId, user.tenantId)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO ASSIGNMENT TARGETS
  // ---

  app.get("/api/beo/assignment-targets", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const targets = await db.select().from(beoAssignmentTargets)
        .where(eq(beoAssignmentTargets.tenantId, user.tenantId));
      res.json(targets);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/assignment-targets", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const parsed = insertBeoAssignmentTargetSchema.parse({ ...req.body, tenantId: user.tenantId });
      const [target] = await db.insert(beoAssignmentTargets).values(parsed).returning();
      res.status(201).json(target);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/beo/assignment-targets/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const [updated] = await db.update(beoAssignmentTargets)
        .set({ ...req.body, updatedAt: new Date() })
        .where(and(eq(beoAssignmentTargets.id, id), eq(beoAssignmentTargets.tenantId, user.tenantId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Assignment target not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/beo/assignment-targets/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      await db.delete(beoAssignmentTargets)
        .where(and(eq(beoAssignmentTargets.id, id), eq(beoAssignmentTargets.tenantId, user.tenantId)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO SETUP ITEMS (per-event setup tasks)
  // ---

  app.get("/api/events/:eventId/beo/setup-items", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const items = await db.select().from(beoSetupItems)
        .where(eq(beoSetupItems.eventId, eventId))
        .orderBy(asc(beoSetupItems.sortOrder));
      res.json(items);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/beo/setup-items", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const parsed = insertBeoSetupItemSchema.parse({ 
        ...req.body, 
        eventId, 
        tenantId: user.tenantId 
      });
      const [item] = await db.insert(beoSetupItems).values(parsed).returning();
      res.status(201).json(item);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/beo/setup-items/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, id } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const [updated] = await db.update(beoSetupItems)
        .set({ ...req.body, updatedAt: new Date() })
        .where(and(eq(beoSetupItems.id, id), eq(beoSetupItems.eventId, eventId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Setup item not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/events/:eventId/beo/setup-items/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, id } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      await db.delete(beoSetupItems)
        .where(and(eq(beoSetupItems.id, id), eq(beoSetupItems.eventId, eventId)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO ENTERTAINMENT ITEMS (per-event)
  // ---

  app.get("/api/events/:eventId/beo/entertainment-items", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const items = await db.select().from(beoEntertainmentItems)
        .where(eq(beoEntertainmentItems.eventId, eventId))
        .orderBy(asc(beoEntertainmentItems.sortOrder));
      res.json(items);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/beo/entertainment-items", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const parsed = insertBeoEntertainmentItemSchema.parse({ 
        ...req.body, 
        eventId, 
        tenantId: user.tenantId 
      });
      const [item] = await db.insert(beoEntertainmentItems).values(parsed).returning();
      res.status(201).json(item);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/beo/entertainment-items/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, id } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const [updated] = await db.update(beoEntertainmentItems)
        .set({ ...req.body, updatedAt: new Date() })
        .where(and(eq(beoEntertainmentItems.id, id), eq(beoEntertainmentItems.eventId, eventId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Entertainment item not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/events/:eventId/beo/entertainment-items/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, id } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      await db.delete(beoEntertainmentItems)
        .where(and(eq(beoEntertainmentItems.id, id), eq(beoEntertainmentItems.eventId, eventId)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO EVENT DETAILS (combined endpoint)
  // ---

  app.get("/api/events/:eventId/beo", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      const [event] = await db.select().from(coreEvents)
        .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, user.tenantId)));
      
      if (!event) return res.status(404).json({ error: "Event not found" });
      
      const [partyHost] = await db.select().from(beoPartyHostAssignments)
        .where(eq(beoPartyHostAssignments.eventId, eventId));
      
      const [entertainment] = await db.select().from(beoEntertainmentAssignments)
        .where(eq(beoEntertainmentAssignments.eventId, eventId));
      
      const [setupPlan] = await db.select().from(beoSetupPlans)
        .where(eq(beoSetupPlans.eventId, eventId));
      
      const [kitchenPlan] = await db.select().from(beoKitchenPlans)
        .where(eq(beoKitchenPlans.eventId, eventId));

      const [barPlan] = await db.select().from(beoBarPlans)
        .where(eq(beoBarPlans.eventId, eventId));
      
      const [billing] = await db.select().from(beoEventBilling)
        .where(eq(beoEventBilling.eventId, eventId));
      
      const timeline = await db.select().from(beoTimelineItems)
        .where(eq(beoTimelineItems.eventId, eventId))
        .orderBy(asc(beoTimelineItems.sortOrder));
      
      const lineItems = await db.select().from(eventLineItems)
        .where(eq(eventLineItems.eventId, eventId))
        .orderBy(asc(eventLineItems.sortOrder));

      const [packageSnapshot] = await db.select().from(beoPackageSnapshots)
        .where(eq(beoPackageSnapshots.eventId, eventId));
      
      let packageSnapshotWithItems = null;
      if (packageSnapshot) {
        const snapshotItems = await db.select().from(beoPackageSnapshotItems)
          .where(eq(beoPackageSnapshotItems.snapshotId, packageSnapshot.id))
          .orderBy(asc(beoPackageSnapshotItems.sortOrder));
        packageSnapshotWithItems = { ...packageSnapshot, items: snapshotItems };
      }

      const entertainmentSelectionsData = await db.select().from(beoEntertainmentSelections)
        .where(eq(beoEntertainmentSelections.eventId, eventId))
        .orderBy(asc(beoEntertainmentSelections.sortOrder));

      let location = null;
      if (event.locationId) {
        const [loc] = await db.select().from(beoLocations)
          .where(eq(beoLocations.id, event.locationId));
        location = loc;
      }

      let branchData = null;
      if (event.branchId) {
        const [b] = await db.select().from(branches)
          .where(eq(branches.id, event.branchId));
        branchData = b;
      }

      // Resolve party host names
      let partyHostWithNames = partyHost ? { ...partyHost } as any : null;
      if (partyHost?.assignedEmployeeId) {
        const [employee] = await db.select().from(employees).where(eq(employees.id, partyHost.assignedEmployeeId));
        if (partyHostWithNames) {
          partyHostWithNames.assignedEmployeeName = employee?.nickname || employee?.fullName || "";
          partyHostWithNames.resolvedUserName = employee?.nickname || employee?.fullName || "";
        }
      } else if (partyHost?.resolvedUserId) {
        const [user] = await db.select().from(users).where(eq(users.id, partyHost.resolvedUserId));
        if (partyHostWithNames) {
          partyHostWithNames.resolvedUserName = user?.fullName || "";
        }
      }
      if (partyHost?.backupEmployeeId) {
        const [backupEmployee] = await db.select().from(employees).where(eq(employees.id, partyHost.backupEmployeeId));
        if (partyHostWithNames) {
          partyHostWithNames.backupEmployeeName = backupEmployee?.nickname || backupEmployee?.fullName || "";
        }
      }
      if (partyHost?.assignedRoleId) {
        const [role] = await db.select().from(roles).where(eq(roles.id, partyHost.assignedRoleId));
        if (partyHostWithNames) {
          partyHostWithNames.assignedRoleName = role?.name || "";
        }
      }
      
      const billingAddOns = (billing as any)?.addOns;
      const partyDetails = billingAddOns?.partyDetails || null;

      const beoTasks = await db.select().from(tasks)
        .where(and(
          eq(tasks.eventId, eventId),
          eq(tasks.tenantId, user.tenantId),
          sql`(title LIKE '🔧 Setup:%' OR title LIKE '🍽️ Kitchen:%' OR title LIKE '💰 POS Setup:%')`,
        ));

      const [setMenuSel] = await db.select({
        isSubmitted: beoSetMenuSelections.isSubmitted,
        submittedAt: beoSetMenuSelections.submittedAt,
        templateId: beoSetMenuSelections.templateId,
      }).from(beoSetMenuSelections)
        .where(eq(beoSetMenuSelections.eventId, eventId));

      const resolvedSetMenuTemplateId = setMenuSel?.templateId || kitchenPlan?.setMenuTemplateId;
      const [setMenuTemplate] = resolvedSetMenuTemplateId
        ? await db.select({
            id: beoSetMenuTemplates.id,
            name: beoSetMenuTemplates.name,
            items: beoSetMenuTemplates.items,
          }).from(beoSetMenuTemplates)
            .where(and(
              eq(beoSetMenuTemplates.id, resolvedSetMenuTemplateId),
              eq(beoSetMenuTemplates.tenantId, user.tenantId),
            ))
        : [undefined];

      const result: BeoEventWithDetails = {
        ...event,
        partyHost: partyHostWithNames || null,
        entertainment: entertainment || null,
        setupPlan: setupPlan || null,
        kitchenPlan: kitchenPlan ? {
          ...kitchenPlan,
          setMenuSelectionStatus: setMenuSel || null,
          setMenuTemplate: setMenuTemplate || null,
        } : null,
        barPlan: barPlan || null,
        billing: billing || null,
        timeline: timeline || [],
        lineItems: lineItems || [],
        location: location,
        branch: branchData,
        packageSnapshot: packageSnapshotWithItems || null,
        entertainmentSelections: entertainmentSelectionsData || [],
        partyDetails: partyDetails,
        beoTasks: beoTasks || [],
      };
      
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO PARTY HOST ASSIGNMENT
  // ---

  app.get("/api/events/:eventId/beo/party-host", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [partyHost] = await db.select().from(beoPartyHostAssignments)
        .where(eq(beoPartyHostAssignments.eventId, eventId));
      res.json(partyHost || null);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/beo/party-host", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [existing] = await db.select().from(beoPartyHostAssignments)
        .where(eq(beoPartyHostAssignments.eventId, eventId));
      
      if (existing) {
        const [updated] = await db.update(beoPartyHostAssignments)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(beoPartyHostAssignments.eventId, eventId))
          .returning();
        return res.json(updated);
      }
      
      const parsed = insertBeoPartyHostAssignmentSchema.parse({ ...req.body, eventId });
      const [created] = await db.insert(beoPartyHostAssignments).values(parsed).returning();
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/beo/party-host/resolve", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      const { resolvedUserId } = req.body;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [updated] = await db.update(beoPartyHostAssignments)
        .set({ resolvedUserId, resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(beoPartyHostAssignments.eventId, eventId))
        .returning();
      
      if (!updated) return res.status(404).json({ error: "Party host assignment not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO ENTERTAINMENT ASSIGNMENT
  // ---

  app.get("/api/events/:eventId/beo/entertainment", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [entertainment] = await db.select().from(beoEntertainmentAssignments)
        .where(eq(beoEntertainmentAssignments.eventId, eventId));
      res.json(entertainment || null);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/beo/entertainment", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [existing] = await db.select().from(beoEntertainmentAssignments)
        .where(eq(beoEntertainmentAssignments.eventId, eventId));
      
      if (existing) {
        const [updated] = await db.update(beoEntertainmentAssignments)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(beoEntertainmentAssignments.eventId, eventId))
          .returning();
        return res.json(updated);
      }
      
      const parsed = insertBeoEntertainmentAssignmentSchema.parse({ ...req.body, eventId });
      const [created] = await db.insert(beoEntertainmentAssignments).values(parsed).returning();
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO SETUP PLAN
  // ---

  app.get("/api/events/:eventId/beo/setup-plan", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [setupPlan] = await db.select().from(beoSetupPlans)
        .where(eq(beoSetupPlans.eventId, eventId));
      res.json(setupPlan || null);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/beo/setup-plan", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [existing] = await db.select().from(beoSetupPlans)
        .where(eq(beoSetupPlans.eventId, eventId));
      
      if (existing) {
        const [updated] = await db.update(beoSetupPlans)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(beoSetupPlans.eventId, eventId))
          .returning();
        return res.json(updated);
      }
      
      const parsed = insertBeoSetupPlanSchema.parse({ ...req.body, eventId });
      const [created] = await db.insert(beoSetupPlans).values(parsed).returning();
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/beo/setup-plan/resolve", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      const { resolvedUserId } = req.body;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [updated] = await db.update(beoSetupPlans)
        .set({ setupResolvedUserId: resolvedUserId, setupResolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(beoSetupPlans.eventId, eventId))
        .returning();
      
      if (!updated) return res.status(404).json({ error: "Setup plan not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO KITCHEN PLAN
  // ---

  app.get("/api/events/:eventId/beo/kitchen-plan", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [kitchenPlan] = await db.select().from(beoKitchenPlans)
        .where(eq(beoKitchenPlans.eventId, eventId));
      res.json(kitchenPlan || null);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/beo/kitchen-plan", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const result = await db.transaction(async (tx) => {
        await lockKitchenPlanMutation(tx, eventId);
        const [existing] = await tx.select().from(beoKitchenPlans)
          .where(eq(beoKitchenPlans.eventId, eventId));

        if (existing) {
          const { setMenuSelectionSubmittedAt, ...updates } = req.body;
          const [selection] = await tx.select({
            isSubmitted: beoSetMenuSelections.isSubmitted,
            submittedAt: beoSetMenuSelections.submittedAt,
          }).from(beoSetMenuSelections)
            .where(eq(beoSetMenuSelections.eventId, eventId));
          const preserveSubmittedItems = isStaleSetMenuSubmission(selection, setMenuSelectionSubmittedAt);
          const menus = preserveServerSetMenuItems(updates.menus ?? existing.menus, existing.menus, preserveSubmittedItems);
          const simplifiedMenus = preserveServerSetMenuItems(
            updates.simplifiedMenus ?? updates.menus ?? existing.simplifiedMenus ?? existing.menus,
            existing.simplifiedMenus ?? existing.menus,
            preserveSubmittedItems,
          );
          const [updated] = await tx.update(beoKitchenPlans)
            .set({ ...updates, menus, simplifiedMenus, updatedAt: new Date() })
            .where(eq(beoKitchenPlans.eventId, eventId))
            .returning();
          return { status: 200, kitchenPlan: updated };
        }

        const parsed = insertBeoKitchenPlanSchema.parse({ ...req.body, eventId });
        const [created] = await tx.insert(beoKitchenPlans).values(parsed).returning();
        return { status: 201, kitchenPlan: created };
      });
      res.status(result.status).json(result.kitchenPlan);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/beo/kitchen-plan/resolve", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      const { resolvedUserId } = req.body;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [updated] = await db.update(beoKitchenPlans)
        .set({ kitchenResolvedUserId: resolvedUserId, kitchenResolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(beoKitchenPlans.eventId, eventId))
        .returning();
      
      if (!updated) return res.status(404).json({ error: "Kitchen plan not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO EVENT BILLING
  // ---

  app.get("/api/events/:eventId/beo/billing", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [billing] = await db.select().from(beoEventBilling)
        .where(eq(beoEventBilling.eventId, eventId));
      res.json(billing || null);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/beo/billing", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [existing] = await db.select().from(beoEventBilling)
        .where(eq(beoEventBilling.eventId, eventId));
      
      if (existing) {
        const [updated] = await db.update(beoEventBilling)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(beoEventBilling.eventId, eventId))
          .returning();
        return res.json(updated);
      }
      
      const parsed = insertBeoEventBillingSchema.parse({ ...req.body, eventId });
      const [created] = await db.insert(beoEventBilling).values(parsed).returning();
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO TIMELINE ITEMS
  // ---

  app.get("/api/events/:eventId/beo/timeline", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const timeline = await db.select().from(beoTimelineItems)
        .where(eq(beoTimelineItems.eventId, eventId))
        .orderBy(asc(beoTimelineItems.offsetFromStartMinutes), asc(beoTimelineItems.sortOrder));
      res.json(timeline);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/beo/timeline", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const parsed = insertBeoTimelineItemSchema.parse({ ...req.body, eventId });
      const [created] = await db.insert(beoTimelineItems).values(parsed).returning();
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/events/:eventId/beo/timeline/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, id } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [updated] = await db.update(beoTimelineItems)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(beoTimelineItems.id, id))
        .returning();
      if (!updated) return res.status(404).json({ error: "Timeline item not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/beo/timeline/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, id } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [updated] = await db.update(beoTimelineItems)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(beoTimelineItems.id, id))
        .returning();
      if (!updated) return res.status(404).json({ error: "Timeline item not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/events/:eventId/beo/timeline/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, id } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [item] = await db.select().from(beoTimelineItems)
        .where(and(eq(beoTimelineItems.id, id), eq(beoTimelineItems.eventId, eventId)));
      
      if (!item) return res.status(404).json({ error: "Timeline item not found" });

      // For system-generated items with a sourceKey, record suppression so they don't regenerate
      if (item.isSystemGenerated && item.sourceKey) {
        const [currentEvent] = await db.select({ suppressedTimelineSources: coreEvents.suppressedTimelineSources })
          .from(coreEvents).where(eq(coreEvents.id, eventId));
        const existing = currentEvent?.suppressedTimelineSources || [];
        if (!existing.includes(item.sourceKey)) {
          await db.update(coreEvents)
            .set({ suppressedTimelineSources: [...existing, item.sourceKey], updatedAt: new Date() })
            .where(eq(coreEvents.id, eventId));
        }
      }

      await db.delete(beoTimelineItems).where(eq(beoTimelineItems.id, id));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // Clear suppressed timeline sources and regenerate
  app.delete("/api/events/:eventId/beo/timeline-suppressions", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;

      const [event] = await db.select().from(coreEvents)
        .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, user.tenantId)));
      if (!event) return res.status(404).json({ error: "Event not found" });

      await db.update(coreEvents)
        .set({ suppressedTimelineSources: [], updatedAt: new Date() })
        .where(eq(coreEvents.id, eventId));

      await generateTimelineFromBeo(eventId);

      const timeline = await db.select().from(beoTimelineItems)
        .where(eq(beoTimelineItems.eventId, eventId))
        .orderBy(asc(beoTimelineItems.offsetFromStartMinutes), asc(beoTimelineItems.sortOrder));
      res.json(timeline);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/beo/timeline/:id/complete", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, id } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [existing] = await db.select().from(beoTimelineItems)
        .where(eq(beoTimelineItems.id, id));
      if (!existing) return res.status(404).json({ error: "Timeline item not found" });

      const newCompleted = !existing.isCompleted;
      const [updated] = await db.update(beoTimelineItems)
        .set({ 
          isCompleted: newCompleted, 
          completedAt: newCompleted ? new Date() : null, 
          completedByUserId: newCompleted ? user.id : null,
          updatedAt: new Date() 
        })
        .where(eq(beoTimelineItems.id, id))
        .returning();
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Auto-generate timeline based on event settings
  app.post("/api/events/:eventId/beo/timeline/generate", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      const [event] = await db.select().from(coreEvents)
        .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, user.tenantId)));
      
      if (!event) return res.status(404).json({ error: "Event not found" });
      
      await generateTimelineFromBeo(eventId);
      const timeline = await db.select().from(beoTimelineItems)
        .where(eq(beoTimelineItems.eventId, eventId))
        .orderBy(asc(beoTimelineItems.offsetFromStartMinutes), asc(beoTimelineItems.sortOrder));
      res.json(timeline);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BULK SAVE BEO DATA
  // ---

  // Helper to strip timestamp and id fields from incoming data
  const sanitizeBeoData = <T extends Record<string, unknown>>(data: T | undefined): Partial<T> | undefined => {
    if (!data) return undefined;
    const { id, eventId, createdAt, updatedAt, ...rest } = data as Record<string, unknown>;
    return rest as Partial<T>;
  };

  app.put("/api/events/:eventId/beo", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      const rawBody = req.body;
      const partyHost = sanitizeBeoData(rawBody.partyHost);
      const entertainment = sanitizeBeoData(rawBody.entertainment);
      const setupPlan = sanitizeBeoData(rawBody.setupPlan);
      const kitchenPlan = sanitizeBeoData(rawBody.kitchenPlan);
      const barPlan = sanitizeBeoData(rawBody.barPlan);
      const billing = sanitizeBeoData(rawBody.billing);
      const eventUpdates = sanitizeBeoData(rawBody.event);
      
      // Verify event belongs to user's tenant
      const [existingEvent] = await db.select().from(coreEvents)
        .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, user.tenantId)));
      
      if (!existingEvent) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      // Validate times: endTime must be after startTime
      if (eventUpdates?.startTime && eventUpdates?.endTime) {
        const timeToMinutes = (time: string): number => {
          const [hours, minutes] = time.split(":").map(Number);
          return hours * 60 + minutes;
        };
        const startMinutes = timeToMinutes(eventUpdates.startTime);
        const endMinutes = timeToMinutes(eventUpdates.endTime);
        if (endMinutes <= startMinutes) {
          return res.status(400).json({ error: "End time must be after start time" });
        }
      }
      
      // Update event if provided
      if (eventUpdates) {
        await db.update(coreEvents)
          .set({ ...eventUpdates, updatedAt: new Date() })
          .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, user.tenantId)));
      }
      
      // Upsert party host
      if (partyHost !== undefined) {
        const [existingHost] = await db.select().from(beoPartyHostAssignments)
          .where(eq(beoPartyHostAssignments.eventId, eventId));
        
        if (existingHost) {
          await db.update(beoPartyHostAssignments)
            .set({ ...partyHost, updatedAt: new Date() })
            .where(eq(beoPartyHostAssignments.eventId, eventId));
        } else if (partyHost) {
          await db.insert(beoPartyHostAssignments)
            .values({ ...partyHost, eventId });
        }
      }
      
      // Upsert entertainment
      if (entertainment !== undefined) {
        const [existingEnt] = await db.select().from(beoEntertainmentAssignments)
          .where(eq(beoEntertainmentAssignments.eventId, eventId));
        
        if (existingEnt) {
          await db.update(beoEntertainmentAssignments)
            .set({ ...entertainment, updatedAt: new Date() })
            .where(eq(beoEntertainmentAssignments.eventId, eventId));
        } else if (entertainment) {
          await db.insert(beoEntertainmentAssignments)
            .values({ ...entertainment, eventId });
        }
      }
      
      // Upsert setup plan - map frontend fields to valid DB columns
      if (setupPlan !== undefined) {
        const sp = setupPlan as Record<string, any>;
        const setupDbData: Record<string, any> = {
          setupRequired: sp.setupRequired ?? true,
          setupNotes: sp.setupNotes || null,
          setupTasks: {
            readyBy: sp.readyBy || "",
            responsible: sp.responsible || "",
            responsibleId: sp.responsibleId || null,
            responsibleType: sp.responsibleType || null,
            simplifiedTasks: sp.simplifiedTasks || [],
          },
        };
        const [existingSetup] = await db.select().from(beoSetupPlans)
          .where(eq(beoSetupPlans.eventId, eventId));
        
        if (existingSetup) {
          await db.update(beoSetupPlans)
            .set({ ...setupDbData, updatedAt: new Date() })
            .where(eq(beoSetupPlans.eventId, eventId));
        } else {
          await db.insert(beoSetupPlans)
            .values({ ...setupDbData, eventId });
        }
      }
      
      // Upsert kitchen plan - map frontend fields to valid DB columns
      if (kitchenPlan !== undefined) {
        const kp = kitchenPlan as Record<string, any>;
        const kitchenDbData: Record<string, any> = {
          foodRequired: kp.foodRequired ?? true,
          cakeMode: kp.cakeMode || "NONE",
          cakeNotes: kp.cakeNotes || null,
          cakeTime: kp.cakeTime || null,
          serviceSchedule: kp.serviceSchedule || [],
          setMenuEnabled: kp.setMenuEnabled ?? false,
          setMenuTemplateId: kp.setMenuTemplateId || null,
          menus: {
            // Canonical menus preserve the parent-resolved group identity;
            // simplifiedMenus remains a compatibility fallback for old clients.
            kids: kp.menus?.kids ?? kp.simplifiedMenus?.kids ?? [],
            adults: kp.menus?.adults ?? kp.simplifiedMenus?.adults ?? [],
            cakePrice: kp.cakePrice || 0,
            cakeIncluded: kp.cakeIncluded !== false,
            kidsFoodTime: kp.menus?.kidsFoodTime || "",
            adultsFoodTime: kp.menus?.adultsFoodTime || "",
          },
          simplifiedMenus: kp.simplifiedMenus || {
            kids: kp.menus?.kids || [],
            adults: kp.menus?.adults || [],
          },
        };
        await db.transaction(async (tx) => {
          await lockKitchenPlanMutation(tx, eventId);
          const [existingKitchen] = await tx.select().from(beoKitchenPlans)
            .where(eq(beoKitchenPlans.eventId, eventId));

          if (existingKitchen) {
            const [selection] = await tx.select({
              isSubmitted: beoSetMenuSelections.isSubmitted,
              submittedAt: beoSetMenuSelections.submittedAt,
            }).from(beoSetMenuSelections)
              .where(eq(beoSetMenuSelections.eventId, eventId));
            const preserveSubmittedItems = isStaleSetMenuSubmission(selection, kp.setMenuSelectionSubmittedAt);
            const menus = preserveServerSetMenuItems(kitchenDbData.menus, existingKitchen.menus, preserveSubmittedItems);
            const simplifiedMenus = preserveServerSetMenuItems(
              kitchenDbData.simplifiedMenus,
              existingKitchen.simplifiedMenus ?? existingKitchen.menus,
              preserveSubmittedItems,
            );
            await tx.update(beoKitchenPlans)
              .set({ ...kitchenDbData, menus, simplifiedMenus, updatedAt: new Date() })
              .where(eq(beoKitchenPlans.eventId, eventId));
          } else {
            await tx.insert(beoKitchenPlans)
              .values({ ...kitchenDbData, eventId });
          }
        });
      }
      
      // Upsert bar plan
      if (barPlan !== undefined) {
        const bp = barPlan as Record<string, any>;
        const barDbData: Record<string, any> = {
          serviceTime: bp.serviceTime || null,
          items: bp.items || [],
        };
        const [existingBar] = await db.select().from(beoBarPlans)
          .where(eq(beoBarPlans.eventId, eventId));
        if (existingBar) {
          await db.update(beoBarPlans)
            .set({ ...barDbData, updatedAt: new Date() })
            .where(eq(beoBarPlans.eventId, eventId));
        } else {
          await db.insert(beoBarPlans)
            .values({ ...barDbData, eventId });
        }
      }

      // Upsert billing (also stores partyDetails in addOns)
      const partyDetails = rawBody.partyDetails;
      if (billing !== undefined || partyDetails !== undefined) {
        const billingData = { ...(billing || {}) } as Record<string, unknown>;
        if (billingData.depositPaidAt && typeof billingData.depositPaidAt === "string") {
          billingData.depositPaidAt = new Date(billingData.depositPaidAt as string);
        }
        if (billingData.depositPaidAt === null) {
          billingData.depositPaidAt = null;
        }
        if (partyDetails !== undefined) {
          billingData.addOns = { partyDetails };
        }
        const [existingBilling] = await db.select().from(beoEventBilling)
          .where(eq(beoEventBilling.eventId, eventId));
        
        if (existingBilling) {
          await db.update(beoEventBilling)
            .set({ ...billingData, updatedAt: new Date() })
            .where(eq(beoEventBilling.eventId, eventId));
        } else if (Object.keys(billingData).length > 0) {
          await db.insert(beoEventBilling)
            .values({ ...billingData, eventId } as any);
        }
      }

      await generateTimelineFromBeo(eventId);

      const [event] = await db.select().from(coreEvents).where(eq(coreEvents.id, eventId));
      const [ph] = await db.select().from(beoPartyHostAssignments).where(eq(beoPartyHostAssignments.eventId, eventId));
      const [ent] = await db.select().from(beoEntertainmentAssignments).where(eq(beoEntertainmentAssignments.eventId, eventId));
      const [sp2] = await db.select().from(beoSetupPlans).where(eq(beoSetupPlans.eventId, eventId));
      const [kp2] = await db.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, eventId));
      const [bp2] = await db.select().from(beoBarPlans).where(eq(beoBarPlans.eventId, eventId));
      const [bl] = await db.select().from(beoEventBilling).where(eq(beoEventBilling.eventId, eventId));
      const tl = await db.select().from(beoTimelineItems).where(eq(beoTimelineItems.eventId, eventId)).orderBy(asc(beoTimelineItems.sortOrder));

      let location = null;
      if (event?.locationId) {
        const [loc] = await db.select().from(beoLocations).where(eq(beoLocations.id, event.locationId));
        location = loc;
      }
      
      const result = {
        ...event,
        partyHost: ph || null,
        entertainment: ent || null,
        setupPlan: sp2 || null,
        kitchenPlan: kp2 || null,
        barPlan: bp2 || null,
        billing: bl || null,
        timeline: tl || [],
        location,
        beoTasks: [],
      };
      
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // GET STAFF FOR ASSIGNMENT (for picker UI)
  // ---

  app.get("/api/beo/staff", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      
      // Get all active users
      const staffList = await db.select({
        id: users.id,
        username: users.username,
        displayName: users.fullName,
        role: users.role,
      }).from(users)
        .where(eq(users.isActive, true));
      
      res.json(staffList);
    } catch (error) {
      next(error);
    }
  });

  // Get roles for assignment
  app.get("/api/beo/roles", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const rolesList = await db.select().from(roles)
        .where(eq(roles.tenantId, user.tenantId));
      res.json(rolesList);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/beo/party-hosts", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      
      const activeEmployees = await db.select({
        id: employees.id,
        fullName: employees.fullName,
        nickname: employees.nickname,
      })
        .from(employees)
        .where(and(
          eq(employees.tenantId, user.tenantId),
          eq(employees.employmentState, "ACTIVE")
        ))
        .orderBy(asc(employees.fullName));
      
      if (activeEmployees.length > 0) {
        res.json({ source: "employee", items: activeEmployees });
        return;
      }

      const activeUsers = await db.select({
        id: users.id,
        fullName: users.fullName,
        nickname: users.preferredName,
      })
        .from(users)
        .where(and(
          eq(users.operatorId, user.operatorId),
          eq(users.isActive, true)
        ))
        .orderBy(asc(users.fullName));
      
      res.json({ source: "user", items: activeUsers });
    } catch (error) {
      next(error);
    }
  });

  // ---
  // EVENT LINE ITEM TEMPLATES (Settings)
  // ---

  app.get("/api/settings/line-item-templates", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const includeInactive = req.query.includeInactive === "true";
      const category = req.query.category as string | undefined;
      
      let query = db.select().from(eventLineItemTemplates)
        .where(eq(eventLineItemTemplates.tenantId, user.tenantId));
      
      const templates = await query.orderBy(asc(eventLineItemTemplates.name));
      
      let filtered = templates;
      if (!includeInactive) {
        filtered = filtered.filter(t => t.isActive);
      }
      if (category) {
        filtered = filtered.filter(t => t.category === category);
      }
      
      res.json(filtered);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/settings/line-item-templates", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const parsed = insertEventLineItemTemplateSchema.parse({
        ...req.body,
        tenantId: user.tenantId,
        createdByUserId: user.id,
        updatedByUserId: user.id,
      });
      
      const [created] = await db.insert(eventLineItemTemplates)
        .values(parsed)
        .returning();
      
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/settings/line-item-templates/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      
      const [existing] = await db.select().from(eventLineItemTemplates)
        .where(and(
          eq(eventLineItemTemplates.id, id),
          eq(eventLineItemTemplates.tenantId, user.tenantId)
        ));
      
      if (!existing) {
        return res.status(404).json({ error: "Template not found" });
      }
      
      const { tenantId, createdByUserId, createdAt, ...updateData } = req.body;
      
      const [updated] = await db.update(eventLineItemTemplates)
        .set({ ...updateData, updatedByUserId: user.id, updatedAt: new Date() })
        .where(eq(eventLineItemTemplates.id, id))
        .returning();
      
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/settings/line-item-templates/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      
      const [existing] = await db.select().from(eventLineItemTemplates)
        .where(and(
          eq(eventLineItemTemplates.id, id),
          eq(eventLineItemTemplates.tenantId, user.tenantId)
        ));
      
      if (!existing) {
        return res.status(404).json({ error: "Template not found" });
      }
      
      // Soft delete by setting isActive to false
      const [updated] = await db.update(eventLineItemTemplates)
        .set({ isActive: false, updatedByUserId: user.id, updatedAt: new Date() })
        .where(eq(eventLineItemTemplates.id, id))
        .returning();
      
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // EVENT LINE ITEMS (Per-event billing)
  // ---

  app.get("/api/events/:eventId/line-items", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const items = await db.select().from(eventLineItems)
        .where(eq(eventLineItems.eventId, eventId))
        .orderBy(asc(eventLineItems.sortOrder));
      
      res.json(items);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/:eventId/line-items", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      // Get max sort order
      const existing = await db.select().from(eventLineItems)
        .where(eq(eventLineItems.eventId, eventId))
        .orderBy(desc(eventLineItems.sortOrder));
      
      const maxSort = existing.length > 0 ? existing[0].sortOrder : -1;
      
      const parsed = insertEventLineItemSchema.parse({
        ...req.body,
        eventId,
        sortOrder: req.body.sortOrder ?? maxSort + 1,
        createdByUserId: user.id,
        updatedByUserId: user.id,
      });
      
      const [created] = await db.insert(eventLineItems)
        .values(parsed)
        .returning();
      
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/events/:eventId/line-items/:itemId", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, itemId } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const [existing] = await db.select().from(eventLineItems)
        .where(and(
          eq(eventLineItems.id, itemId),
          eq(eventLineItems.eventId, eventId)
        ));
      
      if (!existing) {
        return res.status(404).json({ error: "Line item not found" });
      }
      
      const { eventId: _, createdByUserId, createdAt, id, ...updateData } = req.body;
      
      const [updated] = await db.update(eventLineItems)
        .set({ ...updateData, updatedByUserId: user.id, updatedAt: new Date() })
        .where(eq(eventLineItems.id, itemId))
        .returning();
      
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/events/:eventId/line-items/:itemId", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, itemId } = req.params;
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const [deleted] = await db.delete(eventLineItems)
        .where(and(
          eq(eventLineItems.id, itemId),
          eq(eventLineItems.eventId, eventId)
        ))
        .returning();
      
      if (!deleted) {
        return res.status(404).json({ error: "Line item not found" });
      }
      
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // Bulk add line items from templates
  app.post("/api/events/:eventId/line-items/from-templates", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      const { templateIds } = req.body as { templateIds: string[] };
      
      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      // Get templates
      const templates = await db.select().from(eventLineItemTemplates)
        .where(eq(eventLineItemTemplates.tenantId, user.tenantId));
      
      const selectedTemplates = templates.filter(t => templateIds.includes(t.id));
      
      // Get max sort order
      const existing = await db.select().from(eventLineItems)
        .where(eq(eventLineItems.eventId, eventId))
        .orderBy(desc(eventLineItems.sortOrder));
      
      let sortOrder = existing.length > 0 ? existing[0].sortOrder + 1 : 0;
      
      const created = [];
      for (const template of selectedTemplates) {
        const [item] = await db.insert(eventLineItems)
          .values({
            eventId,
            templateId: template.id,
            name: template.name,
            category: template.category,
            qty: template.defaultQty,
            unitPriceIncVat: template.defaultUnitPriceIncVat,
            isIncluded: template.isIncludedByDefault,
            isManual: false,
            sortOrder: sortOrder++,
            createdByUserId: user.id,
            updatedByUserId: user.id,
          })
          .returning();
        created.push(item);
      }
      
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // GENERATE BILLING FROM BEO DATA
  // ---

  app.post("/api/events/:eventId/line-items/generate-from-beo", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      const { mode } = req.body as { mode?: "merge" | "replace" };

      if (!await verifyEventTenant(eventId, user.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const [event] = await db.select().from(coreEvents).where(eq(coreEvents.id, eventId));
      if (!event) return res.status(404).json({ error: "Event not found" });

      const [setupPlan] = await db.select().from(beoSetupPlans).where(eq(beoSetupPlans.eventId, eventId));
      const setupItemsList = await db.select().from(beoSetupItems).where(eq(beoSetupItems.eventId, eventId)).orderBy(asc(beoSetupItems.sortOrder));
      const [entAssignment] = await db.select().from(beoEntertainmentAssignments).where(eq(beoEntertainmentAssignments.eventId, eventId));
      const entItems = await db.select().from(beoEntertainmentItems).where(eq(beoEntertainmentItems.eventId, eventId)).orderBy(asc(beoEntertainmentItems.sortOrder));
      const [kitchenPlan] = await db.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, eventId));

      const [packageSnapshot] = await db.select().from(beoPackageSnapshots).where(eq(beoPackageSnapshots.eventId, eventId));
      let pkgSnapshotItems: any[] = [];
      if (packageSnapshot) {
        pkgSnapshotItems = await db.select().from(beoPackageSnapshotItems)
          .where(eq(beoPackageSnapshotItems.snapshotId, packageSnapshot.id))
          .orderBy(asc(beoPackageSnapshotItems.sortOrder));
      }

      const entSelections = await db.select().from(beoEntertainmentSelections)
        .where(eq(beoEntertainmentSelections.eventId, eventId))
        .orderBy(asc(beoEntertainmentSelections.sortOrder));

      if (mode === "replace") {
        await db.delete(eventLineItems)
          .where(and(
            eq(eventLineItems.eventId, eventId),
            eq(eventLineItems.autoGenerated, true)
          ));
      }

      const existing = await db.select().from(eventLineItems)
        .where(eq(eventLineItems.eventId, eventId))
        .orderBy(desc(eventLineItems.sortOrder));
      let sortOrder = existing.length > 0 ? existing[0].sortOrder + 1 : 0;

      const existingSourceIds = new Set(existing.map(e => e.sourceId).filter(Boolean));
      const created: any[] = [];

      const chargeMode = setupPlan?.setupChargeMode || "included";

      if (chargeMode === "total" && setupPlan?.setupTotalPrice) {
        const sourceKey = `setup_total`;
        if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
          const [item] = await db.insert(eventLineItems).values({
            eventId,
            name: "Setup Plan (Total)",
            category: "SERVICE",
            qty: 1,
            unitPriceIncVat: setupPlan.setupTotalPrice,
            isIncluded: false,
            isManual: false,
            autoGenerated: true,
            sourceType: "setup",
            sourceId: sourceKey,
            sortOrder: sortOrder++,
            createdByUserId: user.id,
            updatedByUserId: user.id,
          }).returning();
          created.push(item);
        }
      } else if (chargeMode === "per_item") {
        const setupTasks = (setupPlan?.setupTasks as any[]) || [];
        if (setupTasks.length > 0) {
          for (const task of setupTasks) {
            if (task.priceAmount && task.priceAmount > 0) {
              const sourceKey = `setup_task_${task.id}`;
              if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
                const [item] = await db.insert(eventLineItems).values({
                  eventId,
                  name: `Setup: ${task.itemLabel || task.itemKey}`,
                  category: "SERVICE",
                  qty: 1,
                  unitPriceIncVat: task.priceAmount,
                  isIncluded: false,
                  isManual: false,
                  autoGenerated: true,
                  sourceType: "setup",
                  sourceId: sourceKey,
                  sortOrder: sortOrder++,
                  createdByUserId: user.id,
                  updatedByUserId: user.id,
                }).returning();
                created.push(item);
              }
            }
          }
        } else {
          for (const si of setupItemsList) {
            if (si.priceAmount && si.priceAmount > 0) {
              const sourceKey = `setup_item_${si.id}`;
              if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
                const [item] = await db.insert(eventLineItems).values({
                  eventId,
                  name: `Setup: ${si.title}`,
                  category: "SERVICE",
                  qty: 1,
                  unitPriceIncVat: si.priceAmount,
                  isIncluded: false,
                  isManual: false,
                  autoGenerated: true,
                  sourceType: "setup",
                  sourceId: sourceKey,
                  sortOrder: sortOrder++,
                  createdByUserId: user.id,
                  updatedByUserId: user.id,
                }).returning();
                created.push(item);
              }
            }
          }
        }
      }

      // Birthday package snapshot items (breakdown + add-ons)
      if (packageSnapshot && pkgSnapshotItems.length > 0) {
        for (const pi of pkgSnapshotItems) {
          const sourceKey = `package_item_${pi.id}`;
          if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
            const prefix = pi.included ? "Package" : "Add-on";
            const [item] = await db.insert(eventLineItems).values({
              eventId,
              name: `${prefix}: ${pi.label}`,
              category: "SERVICE",
              qty: pi.qty || 1,
              unitPriceIncVat: pi.unitPrice || 0,
              isIncluded: pi.included,
              isManual: false,
              autoGenerated: true,
              sourceType: "package",
              sourceId: sourceKey,
              notes: pi.notes || undefined,
              sortOrder: sortOrder++,
              createdByUserId: user.id,
              updatedByUserId: user.id,
            }).returning();
            created.push(item);
          }
        }
      }

      // Entertainment selections (with actual prices)
      if (entSelections.length > 0) {
        for (const es of entSelections) {
          const sourceKey = `entertainment_sel_${es.id}`;
          if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
            const [item] = await db.insert(eventLineItems).values({
              eventId,
              name: `Entertainment: ${es.name}`,
              category: "SERVICE",
              qty: 1,
              unitPriceIncVat: es.price || 0,
              isIncluded: !es.billable,
              isManual: false,
              autoGenerated: true,
              sourceType: "entertainment",
              sourceId: sourceKey,
              notes: es.notes || undefined,
              sortOrder: sortOrder++,
              createdByUserId: user.id,
              updatedByUserId: user.id,
            }).returning();
            created.push(item);
          }
        }
      } else {
        // Fallback to old entertainment items if no selections exist
        for (const ei of entItems) {
          const sourceKey = `entertainment_${ei.id}`;
          if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
            const [item] = await db.insert(eventLineItems).values({
              eventId,
              name: `Entertainment: ${ei.title}`,
              category: "SERVICE",
              qty: 1,
              unitPriceIncVat: 0,
              isIncluded: false,
              isManual: false,
              autoGenerated: true,
              sourceType: "entertainment",
              sourceId: sourceKey,
              notes: ei.notes || undefined,
              sortOrder: sortOrder++,
              createdByUserId: user.id,
              updatedByUserId: user.id,
            }).returning();
            created.push(item);
          }
        }
      }

      if (kitchenPlan) {
        const menus = kitchenPlan.menus as any;
        const allMenuItems: { itemName: string; quantity: number; notes?: string; unitPrice: number; includedInPackage?: boolean; category: string }[] = [];

        if (menus?.kids && Array.isArray(menus.kids)) {
          for (const mi of menus.kids) {
            if (mi.itemName) allMenuItems.push({ ...mi, category: "Kids" });
          }
        }
        if (menus?.adults && Array.isArray(menus.adults)) {
          for (const mi of menus.adults) {
            if (mi.itemName) allMenuItems.push({ ...mi, category: "Adults" });
          }
        }

        const schedule = kitchenPlan.serviceSchedule as any[];
        if (Array.isArray(schedule)) {
          for (const block of schedule) {
            if (block.items && Array.isArray(block.items)) {
              for (const mi of block.items) {
                if (mi.itemName && (mi.unitPrice > 0 || mi.includedInPackage)) {
                  allMenuItems.push({ ...mi, category: "F&B" });
                }
              }
            }
          }
        }

        if (allMenuItems.length > 0) {
          for (const mi of allMenuItems) {
            const sourceKey = `food_menu_${mi.category.toLowerCase()}_${mi.itemName.replace(/\s+/g, '_').toLowerCase()}`;
            if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
              const itemName = `${mi.category}: ${mi.itemName}${mi.notes ? ` (${mi.notes})` : ""}`;
              const [item] = await db.insert(eventLineItems).values({
                eventId,
                name: itemName,
                category: "FOOD",
                qty: mi.quantity || 1,
                unitPriceIncVat: mi.includedInPackage ? 0 : (mi.unitPrice || 0),
                isIncluded: mi.includedInPackage || false,
                isManual: false,
                autoGenerated: true,
                sourceType: "food",
                sourceId: sourceKey,
                sortOrder: sortOrder++,
                createdByUserId: user.id,
                updatedByUserId: user.id,
              }).returning();
              created.push(item);
            }
          }
        } else {
          const sourceKey = `food_kitchen`;
          if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
            const [item] = await db.insert(eventLineItems).values({
              eventId,
              name: kitchenPlan.foodPackageName || "Food & Kitchen",
              category: "FOOD",
              qty: event.guestCount || 1,
              unitPriceIncVat: 0,
              isIncluded: false,
              isManual: false,
              autoGenerated: true,
              sourceType: "food",
              sourceId: sourceKey,
              notes: (kitchenPlan as any).kitchenNotes || undefined,
              sortOrder: sortOrder++,
              createdByUserId: user.id,
              updatedByUserId: user.id,
            }).returning();
            created.push(item);
          }
        }

        const cakeMode = kitchenPlan.cakeMode;
        const cakeCharge = kitchenPlan.ownCakeCharge;
        if (cakeMode && cakeMode !== "NONE") {
          const sourceKey = `food_cake`;
          if (mode === "replace" || !existingSourceIds.has(sourceKey)) {
            const cakeLabel = cakeMode === "EXTERNAL" ? "Cake (Own)" : "Cake (Provided)";
            const cakeNotes = (kitchenPlan as any).cakeNotes || undefined;
            const [item] = await db.insert(eventLineItems).values({
              eventId,
              name: cakeLabel,
              category: "FOOD",
              qty: 1,
              unitPriceIncVat: cakeCharge || 0,
              isIncluded: cakeMode === "INTERNAL",
              isManual: false,
              autoGenerated: true,
              sourceType: "food",
              sourceId: sourceKey,
              notes: cakeNotes,
              sortOrder: sortOrder++,
              createdByUserId: user.id,
              updatedByUserId: user.id,
            }).returning();
            created.push(item);
          }
        }
      }

      res.status(201).json({ created, count: created.length });
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO PDF GENERATION
  // ---

  app.get("/api/events/:eventId/beo/pdf", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      
      if (!(await verifyEventTenant(eventId, user.tenantId))) {
        return res.status(404).json({ error: "Event not found" });
      }
      
      const [event] = await db.select().from(coreEvents)
        .where(eq(coreEvents.id, eventId));
      
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }

      const [partyHost] = await db.select().from(beoPartyHostAssignments)
        .where(eq(beoPartyHostAssignments.eventId, eventId));
      
      const [entertainment] = await db.select().from(beoEntertainmentAssignments)
        .where(eq(beoEntertainmentAssignments.eventId, eventId));
      
      const entertainmentItems = await db.select().from(beoEntertainmentItems)
        .where(eq(beoEntertainmentItems.eventId, eventId))
        .orderBy(asc(beoEntertainmentItems.sortOrder));
      
      const [setupPlan] = await db.select().from(beoSetupPlans)
        .where(eq(beoSetupPlans.eventId, eventId));
      
      const setupItems = await db.select().from(beoSetupItems)
        .where(eq(beoSetupItems.eventId, eventId))
        .orderBy(asc(beoSetupItems.sortOrder));
      
      const [kitchenPlan] = await db.select().from(beoKitchenPlans)
        .where(eq(beoKitchenPlans.eventId, eventId));

      const [pdfBarPlan] = await db.select().from(beoBarPlans)
        .where(eq(beoBarPlans.eventId, eventId));

      const [pdfSetMenuSel] = await db.select({
        isSubmitted: beoSetMenuSelections.isSubmitted,
        submittedAt: beoSetMenuSelections.submittedAt,
        templateId: beoSetMenuSelections.templateId,
      }).from(beoSetMenuSelections)
        .where(eq(beoSetMenuSelections.eventId, eventId));

      let pdfSetMenuTemplateName: string | undefined;
      const resolvedSetMenuTemplateId = pdfSetMenuSel?.templateId || kitchenPlan?.setMenuTemplateId;
      if (resolvedSetMenuTemplateId) {
        const [tmpl] = await db.select({ name: beoSetMenuTemplates.name })
          .from(beoSetMenuTemplates)
          .where(eq(beoSetMenuTemplates.id, resolvedSetMenuTemplateId));
        pdfSetMenuTemplateName = tmpl?.name;
      }

      const [billing] = await db.select().from(beoEventBilling)
        .where(eq(beoEventBilling.eventId, eventId));
      
      const timeline = await db.select().from(beoTimelineItems)
        .where(eq(beoTimelineItems.eventId, eventId))
        .orderBy(asc(beoTimelineItems.sortOrder));

      let location = null;
      if (event.locationId) {
        const [loc] = await db.select().from(beoLocations)
          .where(eq(beoLocations.id, event.locationId));
        location = loc;
      }

      let branch = null;
      if (event.branchId) {
        const [b] = await db.select().from(branches)
          .where(eq(branches.id, event.branchId));
        branch = b;
      }

      let partyHostUserName = "";
      let partyHostRoleName = "";
      let partyHostEmployeeName = "";
      let backupHostEmployeeName = "";
      if (partyHost?.resolvedUserId) {
        const [resolvedUser] = await db.select().from(users).where(eq(users.id, partyHost.resolvedUserId));
        partyHostUserName = resolvedUser?.fullName || "";
      }
      if (partyHost?.assignedRoleId) {
        const [role] = await db.select().from(beoRoles).where(eq(beoRoles.id, partyHost.assignedRoleId));
        partyHostRoleName = role?.name || "";
      }
      if (partyHost?.assignedEmployeeId) {
        const [employee] = await db.select().from(employees).where(eq(employees.id, partyHost.assignedEmployeeId));
        partyHostEmployeeName = employee?.nickname || employee?.fullName || "";
      }
      if (partyHost?.backupEmployeeId) {
        const [backupEmployee] = await db.select().from(employees).where(eq(employees.id, partyHost.backupEmployeeId));
        backupHostEmployeeName = backupEmployee?.nickname || backupEmployee?.fullName || "";
      }

      let entertainmentUserName = "";
      let entertainmentRoleName = "";
      if (entertainment?.resolvedUserId) {
        const [resolvedUser] = await db.select().from(users).where(eq(users.id, entertainment.resolvedUserId));
        entertainmentUserName = resolvedUser?.fullName || "";
      }
      if (entertainment?.assignedRoleId) {
        const [role] = await db.select().from(beoRoles).where(eq(beoRoles.id, entertainment.assignedRoleId));
        entertainmentRoleName = role?.name || "";
      }

      let setupUserName = "";
      if (setupPlan?.resolvedUserId) {
        const [resolvedUser] = await db.select().from(users).where(eq(users.id, setupPlan.resolvedUserId));
        setupUserName = resolvedUser?.fullName || "";
      }

      const lineItems = await db.select().from(eventLineItems)
        .where(eq(eventLineItems.eventId, eventId))
        .orderBy(asc(eventLineItems.sortOrder));

      const [pdfPkgSnapshot] = await db.select().from(beoPackageSnapshots)
        .where(eq(beoPackageSnapshots.eventId, eventId));
      let pdfPkgSnapshotWithItems = null;
      if (pdfPkgSnapshot) {
        const items = await db.select().from(beoPackageSnapshotItems)
          .where(eq(beoPackageSnapshotItems.snapshotId, pdfPkgSnapshot.id))
          .orderBy(asc(beoPackageSnapshotItems.sortOrder));
        pdfPkgSnapshotWithItems = { ...pdfPkgSnapshot, items };
      }

      const pdfEntSelections = await db.select().from(beoEntertainmentSelections)
        .where(eq(beoEntertainmentSelections.eventId, eventId))
        .orderBy(asc(beoEntertainmentSelections.sortOrder));

      const startTimeParts = (event.startTime || "14:00").split(":").map(Number);
      const startTotalMin = startTimeParts[0] * 60 + startTimeParts[1];
      function offsetToTime(offsetMin: number): string {
        const total = startTotalMin + offsetMin;
        const h = Math.floor(total / 60) % 24;
        const m = total % 60;
        return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
      }

      const billingAddOns = (billing as any)?.addOns;
      const partyDetails = billingAddOns?.partyDetails || null;

      const setupTasksData = setupPlan?.setupTasks as any;
      const simplifiedTasks = setupTasksData?.simplifiedTasks || [];
      const setupResponsible = setupTasksData?.responsible || setupUserName || "";

      const pdfData: BeoPdfData = {
        eventTitle: event.title,
        eventDate: event.eventDate,
        startTime: event.startTime || "",
        endTime: event.endTime || undefined,
        status: event.status,
        childName: event.childName || undefined,
        parentName: event.parentName || undefined,
        bookingName: (event as any).bookingName || undefined,
        whatsappPhone: event.whatsappPhoneRaw || undefined,
        kidTurningAge: event.kidTurningAge ?? undefined,
        numChildren: event.numChildren || undefined,
        numAdults: event.numAdults || undefined,
        programName: event.programName || undefined,
        programDetails: event.programDetails || undefined,
        activities: event.activities || undefined,
        decoration: event.decoration || undefined,
        location: location?.name || undefined,
        locationText: (event as any).locationText || location?.name || undefined,
        allergiesNotes: event.allergiesNotes || undefined,
        cakeNotes: event.cakeNotes || undefined,
        specialRequests: event.specialRequests || undefined,
        internalStaffNotes: event.internalStaffNotes || undefined,
        partyHost: partyHost ? {
          assignedName: partyHostEmployeeName || partyHostUserName || undefined,
          backupName: backupHostEmployeeName || undefined,
          roleName: partyHostRoleName || undefined,
          responsibilities: (partyHost.responsibilities as string[]) || undefined,
          notes: partyHost.notes || undefined,
        } : undefined,
        setupPlan: setupPlan ? {
          readyBy: setupTasksData?.readyBy || undefined,
          responsible: setupResponsible || undefined,
          tasks: simplifiedTasks.length > 0
            ? simplifiedTasks.map((t: any) => ({
                itemLabel: t.itemLabel || t.label || "",
                notes: t.notes || undefined,
              }))
            : undefined,
          notes: setupPlan.setupNotes || undefined,
        } : undefined,
        kitchenPlan: kitchenPlan ? {
          required: kitchenPlan.foodRequired ?? true,
          menus: kitchenPlan.menus as any || undefined,
          setMenuEnabled: kitchenPlan.setMenuEnabled,
          setMenuTemplateName: pdfSetMenuTemplateName,
          setMenuSelectionStatus: pdfSetMenuSel
            ? { isSubmitted: pdfSetMenuSel.isSubmitted, submittedAt: pdfSetMenuSel.submittedAt ? String(pdfSetMenuSel.submittedAt) : null }
            : null,
          cakeMode: kitchenPlan.cakeMode || undefined,
          cakeQuantity: kitchenPlan.cakeQuantity,
          cakeTime: kitchenPlan.cakeTime || undefined,
          cakeNotes: kitchenPlan.cakeNotes || undefined,
          cakePrice: (kitchenPlan.menus as any)?.cakePrice ?? undefined,
          cakeIncluded: (kitchenPlan.menus as any)?.cakeIncluded ?? undefined,
          notes: kitchenPlan.kitchenNotes || undefined,
        } : undefined,
        barPlan: pdfBarPlan ? {
          serviceTime: pdfBarPlan.serviceTime || undefined,
          items: (pdfBarPlan.items as any[]) || [],
        } : undefined,
        partyDetails: partyDetails ? {
          packageName: partyDetails.packageName || undefined,
          packageBasePrice: partyDetails.packageBasePrice ?? undefined,
          items: partyDetails.items || undefined,
          prepaymentReceived: partyDetails.prepaymentReceived ?? undefined,
          depositDate: partyDetails.depositDate || undefined,
          notes: partyDetails.notes || undefined,
        } : undefined,
        timeline: timeline.map(t => ({
          time: offsetToTime(t.offsetFromStartMinutes),
          description: t.label,
        })),
        branchName: branch?.name || undefined,
        branchAddress: branch?.address || undefined,
        branchLogoUrl: branch?.logoUrl || undefined,
      };

      const pdfBuffer = await generateBeoPdf(pdfData);

      const filename = `BEO_${event.title.replace(/[^a-zA-Z0-9]/g, '_')}_${event.eventDate}.pdf`;
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO SET MENU TEMPLATES (CRUD)
  // ---

  app.get("/api/beo/set-menu-templates", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const templates = await db.select().from(beoSetMenuTemplates)
        .where(eq(beoSetMenuTemplates.tenantId, user.tenantId))
        .orderBy(asc(beoSetMenuTemplates.createdAt));
      res.json(templates);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/set-menu-templates", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { name, items } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "Name is required" });
      const [template] = await db.insert(beoSetMenuTemplates)
        .values({ tenantId: user.tenantId, name: name.trim(), items: items || [] })
        .returning();
      res.status(201).json(template);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/beo/set-menu-templates/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const { name, items, isActive } = req.body;
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) updates.name = name;
      if (items !== undefined) updates.items = items;
      if (isActive !== undefined) updates.isActive = isActive;
      const [updated] = await db.update(beoSetMenuTemplates)
        .set(updates)
        .where(and(eq(beoSetMenuTemplates.id, id), eq(beoSetMenuTemplates.tenantId, user.tenantId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Template not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/beo/set-menu-templates/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      await db.update(beoSetMenuTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(beoSetMenuTemplates.id, id), eq(beoSetMenuTemplates.tenantId, user.tenantId)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ---
  // BEO SET MENU SELECTIONS (Parent link / token)
  // ---

  // Manager: generate / get selection state for an event
  app.get("/api/beo/set-menu-selections/:eventId", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      const ok = await verifyEventTenant(eventId, user.tenantId);
      if (!ok) return res.status(404).json({ error: "Event not found" });
      const [sel] = await db.select().from(beoSetMenuSelections)
        .where(eq(beoSetMenuSelections.eventId, eventId));
      res.json(sel || null);
    } catch (error) {
      next(error);
    }
  });

  // Manager: create / regenerate a selection token
  app.post("/api/beo/set-menu-selections", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId, templateId } = req.body;
      if (!eventId || !templateId) return res.status(400).json({ error: "eventId and templateId are required" });
      const ok = await verifyEventTenant(eventId, user.tenantId);
      if (!ok) return res.status(404).json({ error: "Event not found" });
      const [tmpl] = await db.select().from(beoSetMenuTemplates)
        .where(and(eq(beoSetMenuTemplates.id, templateId), eq(beoSetMenuTemplates.tenantId, user.tenantId)));
      if (!tmpl) return res.status(404).json({ error: "Template not found" });

      const token = crypto.randomBytes(24).toString("hex");
      const sel = await db.transaction(async (tx) => {
        await lockKitchenPlanMutation(tx, eventId);
        const [existing] = await tx.select().from(beoSetMenuSelections)
          .where(eq(beoSetMenuSelections.eventId, eventId));

        if (!existing) {
          const [created] = await tx.insert(beoSetMenuSelections)
            .values({ eventId, templateId, token, isSubmitted: false })
            .returning();
          return created;
        }

        const [updated] = await tx.update(beoSetMenuSelections)
          .set({ templateId, token, isSubmitted: false, submittedAt: null, selections: null, updatedAt: new Date() })
          .where(eq(beoSetMenuSelections.eventId, eventId))
          .returning();

        const [kitchenPlan] = await tx.select().from(beoKitchenPlans)
          .where(eq(beoKitchenPlans.eventId, eventId));
        if (kitchenPlan) {
          await tx.update(beoKitchenPlans)
            .set({
              menus: withoutSetMenuItems(kitchenPlan.menus),
              simplifiedMenus: withoutSetMenuItems(kitchenPlan.simplifiedMenus ?? kitchenPlan.menus),
              updatedAt: new Date(),
            })
            .where(eq(beoKitchenPlans.eventId, eventId));
        }

        return updated;
      });
      res.status(201).json(sel);
    } catch (error) {
      next(error);
    }
  });

  // Manager: reset selections (unlock the link, clear resolved set_menu items from kitchen plan)
  app.post("/api/beo/set-menu-selections/:eventId/reset", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.user!;
      const { eventId } = req.params;
      const ok = await verifyEventTenant(eventId, user.tenantId);
      if (!ok) return res.status(404).json({ error: "Event not found" });

      const token = crypto.randomBytes(24).toString("hex");
      const updated = await db.transaction(async (tx) => {
        await lockKitchenPlanMutation(tx, eventId);
        const [selection] = await tx.update(beoSetMenuSelections)
          .set({ isSubmitted: false, submittedAt: null, selections: null, token, updatedAt: new Date() })
          .where(eq(beoSetMenuSelections.eventId, eventId))
          .returning();
        if (!selection) return null;

        const [kitchenPlan] = await tx.select().from(beoKitchenPlans)
          .where(eq(beoKitchenPlans.eventId, eventId));
        if (kitchenPlan) {
          await tx.update(beoKitchenPlans)
            .set({
              menus: withoutSetMenuItems(kitchenPlan.menus),
              simplifiedMenus: withoutSetMenuItems(kitchenPlan.simplifiedMenus ?? kitchenPlan.menus),
              updatedAt: new Date(),
            })
            .where(eq(beoKitchenPlans.eventId, eventId));
        }

        return selection;
      });
      if (!updated) return res.status(404).json({ error: "No selection record found" });

      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Public (no auth): get template items for parent
  app.get("/api/beo/set-menu-selections/public/:token", async (req, res, next) => {
    try {
      const { token } = req.params;
      const [sel] = await db.select().from(beoSetMenuSelections)
        .where(eq(beoSetMenuSelections.token, token));
      if (!sel) return res.status(404).json({ error: "Invalid or expired link" });

      const [tmpl] = await db.select().from(beoSetMenuTemplates)
        .where(eq(beoSetMenuTemplates.id, sel.templateId));
      if (!tmpl) return res.status(404).json({ error: "Template not found" });

      const [event] = await db.select({ title: coreEvents.title, childName: coreEvents.childName, eventDate: coreEvents.eventDate })
        .from(coreEvents).where(eq(coreEvents.id, sel.eventId));

      res.json({
        isSubmitted: sel.isSubmitted,
        submittedAt: sel.submittedAt,
        selections: sel.selections,
        template: { id: tmpl.id, name: tmpl.name, items: tmpl.items },
        event: event || null,
      });
    } catch (error) {
      next(error);
    }
  });

  // Public (no auth): submit parent selections
  app.post("/api/beo/set-menu-selections/public/:token/submit", async (req, res, next) => {
    try {
      const { token } = req.params;
      const { selections } = req.body;

      const [sel] = await db.select().from(beoSetMenuSelections)
        .where(eq(beoSetMenuSelections.token, token));
      if (!sel) return res.status(404).json({ error: "Invalid or expired link" });
      if (sel.isSubmitted) return res.status(409).json({ error: "Selections already submitted" });

      const [tmpl] = await db.select().from(beoSetMenuTemplates)
        .where(eq(beoSetMenuTemplates.id, sel.templateId));
      if (!tmpl) return res.status(404).json({ error: "Template not found" });

      const templateItems = (tmpl.items as any[]) || [];

      // Server-side validation: verify selections against template constraints
      if (!Array.isArray(selections)) {
        return res.status(400).json({ error: "selections must be an array" });
      }
      const choiceGroups = templateItems.filter((i: any) => i.type === "choice_group");
      const validGroupIds = new Set(choiceGroups.map((g: any) => g.id));

      // Reject duplicate groupId entries
      const seenGroupIds = new Set<string>();
      for (const s of selections) {
        if (s?.groupId) {
          if (seenGroupIds.has(s.groupId)) {
            return res.status(400).json({ error: `Duplicate groupId "${s.groupId}" in selections` });
          }
          seenGroupIds.add(s.groupId);
        }
      }

      for (const s of selections) {
        if (!s || typeof s !== "object" || !s.groupId) {
          return res.status(400).json({ error: "Invalid selection entry" });
        }
        if (!validGroupIds.has(s.groupId)) {
          return res.status(400).json({ error: `Unknown group id: ${s.groupId}` });
        }
        const group = choiceGroups.find((g: any) => g.id === s.groupId);
        const validOptions = new Set<string>(group.options || []);
        if (!Array.isArray(s.chosenOptions)) {
          return res.status(400).json({ error: `chosenOptions must be an array for group ${s.groupId}` });
        }
        if (s.chosenOptions.length === 0) {
          return res.status(400).json({ error: `Group "${group.label}" requires at least one selection` });
        }
        for (const opt of s.chosenOptions) {
          if (!validOptions.has(opt)) {
            return res.status(400).json({ error: `Invalid option "${opt}" for group ${s.groupId}` });
          }
        }
        if (!group.allowMultiple && s.chosenOptions.length > 1) {
          return res.status(400).json({ error: `Group ${s.groupId} only allows one selection` });
        }
      }

      // Ensure every choice group has a corresponding selection entry
      for (const group of choiceGroups) {
        const found = selections.find((s: any) => s.groupId === group.id);
        if (!found || !found.chosenOptions || found.chosenOptions.length === 0) {
          return res.status(400).json({ error: `Group "${group.label}" requires at least one selection` });
        }
      }

      // Build resolved menu items from template + validated selections
      const resolvedItems: any[] = [];
      for (const item of templateItems) {
        if (item.type === "always_included") {
          resolvedItems.push({
            id: `set_${item.id}`,
            itemName: item.label,
            quantity: 1,
            notes: "",
            included: true,
            price: 0,
            source: "set_menu",
            groupId: item.id,
          });
        } else if (item.type === "choice_group") {
          const groupSel = selections.find((s: any) => s.groupId === item.id);
          const chosen: string[] = groupSel?.chosenOptions || [];
          for (const opt of chosen) {
            resolvedItems.push({
              id: `set_${item.id}_${opt.replace(/\s+/g, "_")}`,
              itemName: opt,
              quantity: 1,
              notes: `(${item.label})`,
              included: true,
              price: 0,
              source: "set_menu",
              groupId: item.id,
            });
          }
        }
      }

      const submission = await db.transaction(async (tx) => {
        await lockKitchenPlanMutation(tx, sel.eventId);
        // Single-use update and kitchen-plan persistence must succeed together.
        const [atomicUpdate] = await tx.update(beoSetMenuSelections)
          .set({ isSubmitted: true, submittedAt: new Date(), selections, updatedAt: new Date() })
          .where(and(eq(beoSetMenuSelections.token, token), eq(beoSetMenuSelections.isSubmitted, false)))
          .returning({ id: beoSetMenuSelections.id });
        if (!atomicUpdate) return { alreadySubmitted: true };

        const [kitchenPlan] = await tx.select().from(beoKitchenPlans)
          .where(eq(beoKitchenPlans.eventId, sel.eventId));

        if (kitchenPlan) {
          const bucket = resolveSetMenuBucket(kitchenPlan.menus);
          const menus = replaceSetMenuItems(kitchenPlan.menus, bucket, resolvedItems);
          const simplifiedMenus = replaceSetMenuItems(
            kitchenPlan.simplifiedMenus ?? kitchenPlan.menus,
            bucket,
            resolvedItems,
          );
          const [updatedKitchenPlan] = await tx.update(beoKitchenPlans)
            .set({ menus, simplifiedMenus, updatedAt: new Date() })
            .where(eq(beoKitchenPlans.eventId, sel.eventId))
            .returning({ id: beoKitchenPlans.id });
          if (!updatedKitchenPlan) {
            throw new Error("Kitchen plan disappeared while saving set-menu selections");
          }
        } else {
          const [createdKitchenPlan] = await tx.insert(beoKitchenPlans)
            .values({
              eventId: sel.eventId,
              menus: { kids: resolvedItems, adults: [] },
              simplifiedMenus: { kids: resolvedItems, adults: [] },
            })
            .returning({ id: beoKitchenPlans.id });
          if (!createdKitchenPlan) {
            throw new Error("Failed to create kitchen plan for set-menu selections");
          }
        }

        return { alreadySubmitted: false };
      });
      if (submission.alreadySubmitted) {
        return res.status(409).json({ error: "Selections already submitted" });
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });
}
