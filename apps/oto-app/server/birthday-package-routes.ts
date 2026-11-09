import { Express, Request, Response } from "express";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireManager } from "./auth-middleware";
import { db } from "./db";
import {
  birthdayPackageTemplates, insertBirthdayPackageTemplateSchema,
  packageLineItemTemplates, insertPackageLineItemTemplateSchema,
  entertainmentPackageTemplates, insertEntertainmentPackageTemplateSchema,
  beoPackageSnapshots,
  beoPackageSnapshotItems,
  beoEntertainmentSelections,
  beoSetMenuTemplates,
  branches,
  coreEvents,
  updateBeoPackageSnapshotSchema,
} from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import { ZodError } from "zod";
import { applyPackageSnapshot } from "./lib/packageSnapshot";

/** A template field out of range is the caller's mistake, said as such rather than as a server fault. */
const invalidTemplate = (res: Response, error: ZodError) =>
  res.status(400).json({ error: "Validation error", details: error.flatten() });

export function registerBirthdayPackageRoutes(app: Express) {
  /**
   * A package may name a park and a set menu only of its own park group: the
   * foreign keys alone would accept another tenant's row.
   */
  async function foreignPackageLink(
    tenantId: string,
    links: { branchId?: string | null; setMenuTemplateId?: string | null },
  ): Promise<string | null> {
    if (links.branchId) {
      const [branch] = await db.select({ id: branches.id }).from(branches)
        .where(and(eq(branches.id, links.branchId), eq(branches.tenantId, tenantId))).limit(1);
      if (!branch) return "Branch not found";
    }
    if (links.setMenuTemplateId) {
      const [menu] = await db.select({ id: beoSetMenuTemplates.id }).from(beoSetMenuTemplates)
        .where(and(eq(beoSetMenuTemplates.id, links.setMenuTemplateId), eq(beoSetMenuTemplates.tenantId, tenantId))).limit(1);
      if (!menu) return "Set menu template not found";
    }
    return null;
  }

  async function hasPackageAccess(req: Request, packageId: string): Promise<boolean> {
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return false;
    const [pkg] = await db.select({ id: birthdayPackageTemplates.id }).from(birthdayPackageTemplates)
      .where(and(eq(birthdayPackageTemplates.id, packageId), eq(birthdayPackageTemplates.tenantId, tenantId)))
      .limit(1);
    return !!pkg;
  }

  async function verifyEventAccess(req: Request, eventId: string): Promise<boolean> {
    const user = req.userWithAccess;
    if (!user?.tenantId) return false;
    const [event] = await db.select({ branchId: coreEvents.branchId }).from(coreEvents)
      .where(and(eq(coreEvents.id, eventId), eq(coreEvents.tenantId, user.tenantId!))).limit(1);
    return !!event && canUserAccessBranch(user, event.branchId);
  }

  // ============================================
  // BIRTHDAY PACKAGE TEMPLATES CRUD
  // ============================================

  app.get("/api/beo/birthday-packages", requireAuth, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const packages = await db.select().from(birthdayPackageTemplates)
        .where(eq(birthdayPackageTemplates.tenantId, user.tenantId!))
        .orderBy(asc(birthdayPackageTemplates.sortOrder));
      res.json(packages);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/beo/birthday-packages/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const { id } = req.params;
      const [pkg] = await db.select().from(birthdayPackageTemplates)
        .where(and(eq(birthdayPackageTemplates.id, id), eq(birthdayPackageTemplates.tenantId, user.tenantId!)));
      if (!pkg) return res.status(404).json({ error: "Package not found" });
      const lineItems = await db.select().from(packageLineItemTemplates)
        .where(eq(packageLineItemTemplates.packageTemplateId, id))
        .orderBy(asc(packageLineItemTemplates.sortOrder));
      res.json({ ...pkg, lineItems });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/birthday-packages", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const parsed = insertBirthdayPackageTemplateSchema.parse({ ...req.body, tenantId: user.tenantId!, createdByUserId: user.id });
      const foreign = await foreignPackageLink(user.tenantId!, parsed);
      if (foreign) return res.status(400).json({ error: foreign });
      const [pkg] = await db.insert(birthdayPackageTemplates).values(parsed).returning();
      res.status(201).json(pkg);
    } catch (error) {
      if (error instanceof ZodError) return invalidTemplate(res, error);
      next(error);
    }
  });

  app.patch("/api/beo/birthday-packages/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const { id } = req.params;
      const updates = insertBirthdayPackageTemplateSchema
        .omit({ tenantId: true, createdByUserId: true }).partial().parse(req.body);
      const foreign = await foreignPackageLink(user.tenantId!, updates);
      if (foreign) return res.status(400).json({ error: foreign });
      const [updated] = await db.update(birthdayPackageTemplates)
        .set({ ...updates, updatedAt: new Date() })
        .where(and(eq(birthdayPackageTemplates.id, id), eq(birthdayPackageTemplates.tenantId, user.tenantId!)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Package not found" });
      res.json(updated);
    } catch (error) {
      if (error instanceof ZodError) return invalidTemplate(res, error);
      next(error);
    }
  });

  app.delete("/api/beo/birthday-packages/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const { id } = req.params;
      await db.update(birthdayPackageTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(birthdayPackageTemplates.id, id), eq(birthdayPackageTemplates.tenantId, user.tenantId!)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/birthday-packages/:id/duplicate", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const { id } = req.params;
      const [original] = await db.select().from(birthdayPackageTemplates)
        .where(and(eq(birthdayPackageTemplates.id, id), eq(birthdayPackageTemplates.tenantId, user.tenantId!)));
      if (!original) return res.status(404).json({ error: "Package not found" });

      const [newPkg] = await db.insert(birthdayPackageTemplates).values({
        tenantId: original.tenantId,
        name: `${original.name} (Copy)`,
        description: original.description,
        isActive: true,
        basePrice: original.basePrice,
        pricingMode: original.pricingMode,
        includedSummary: original.includedSummary,
        excludedSummary: original.excludedSummary,
        tags: original.tags,
        sortOrder: original.sortOrder,
        kidsIncluded: original.kidsIncluded,
        adultsIncluded: original.adultsIncluded,
        socksIncluded: original.socksIncluded,
        hours: original.hours,
        priceWeekday: original.priceWeekday,
        priceWeekend: original.priceWeekend,
        extraChildWeekday: original.extraChildWeekday,
        extraChildWeekend: original.extraChildWeekend,
        extraAdultWeekday: original.extraAdultWeekday,
        extraAdultWeekend: original.extraAdultWeekend,
        setMenuTemplateId: original.setMenuTemplateId,
        slipsTime: original.slipsTime,
        branchId: original.branchId,
        createdByUserId: user.id,
      }).returning();

      const originalItems = await db.select().from(packageLineItemTemplates)
        .where(eq(packageLineItemTemplates.packageTemplateId, id))
        .orderBy(asc(packageLineItemTemplates.sortOrder));

      if (originalItems.length > 0) {
        await db.insert(packageLineItemTemplates).values(
          originalItems.map((item) => ({
            packageTemplateId: newPkg.id,
            category: item.category,
            label: item.label,
            description: item.description,
            qtyDefault: item.qtyDefault,
            qtyEditable: item.qtyEditable,
            unitLabel: item.unitLabel,
            included: item.included,
            defaultUnitPrice: item.defaultUnitPrice,
            billableByDefault: item.billableByDefault,
            sortOrder: item.sortOrder,
            fnbCredit: item.fnbCredit,
            printsVoucher: item.printsVoucher,
            priceIsFrom: item.priceIsFrom,
          }))
        );
      }

      const lineItems = await db.select().from(packageLineItemTemplates)
        .where(eq(packageLineItemTemplates.packageTemplateId, newPkg.id))
        .orderBy(asc(packageLineItemTemplates.sortOrder));

      res.status(201).json({ ...newPkg, lineItems });
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // PACKAGE LINE ITEM TEMPLATES CRUD
  // ============================================

  app.get("/api/beo/birthday-packages/:packageId/line-items", requireAuth, async (req, res, next) => {
    try {
      const { packageId } = req.params;
      if (!await hasPackageAccess(req, packageId)) return res.status(404).json({ error: "Package not found" });
      const items = await db.select().from(packageLineItemTemplates)
        .where(eq(packageLineItemTemplates.packageTemplateId, packageId))
        .orderBy(asc(packageLineItemTemplates.sortOrder));
      res.json(items);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/birthday-packages/:packageId/line-items", requireAuth, requireManager, async (req, res, next) => {
    try {
      const { packageId } = req.params;
      if (!await hasPackageAccess(req, packageId)) return res.status(404).json({ error: "Package not found" });
      const parsed = insertPackageLineItemTemplateSchema.parse({ ...req.body, packageTemplateId: packageId });
      const [item] = await db.insert(packageLineItemTemplates).values(parsed).returning();
      res.status(201).json(item);
    } catch (error) {
      if (error instanceof ZodError) return invalidTemplate(res, error);
      next(error);
    }
  });

  app.patch("/api/beo/birthday-packages/:packageId/line-items/:itemId", requireAuth, requireManager, async (req, res, next) => {
    try {
      const { packageId, itemId } = req.params;
      if (!await hasPackageAccess(req, packageId)) return res.status(404).json({ error: "Package not found" });
      const updates = insertPackageLineItemTemplateSchema
        .omit({ packageTemplateId: true }).partial().parse(req.body);
      const [updated] = await db.update(packageLineItemTemplates)
        .set(updates)
        .where(and(
          eq(packageLineItemTemplates.id, itemId),
          eq(packageLineItemTemplates.packageTemplateId, packageId)
        ))
        .returning();
      if (!updated) return res.status(404).json({ error: "Line item not found" });
      res.json(updated);
    } catch (error) {
      if (error instanceof ZodError) return invalidTemplate(res, error);
      next(error);
    }
  });

  app.delete("/api/beo/birthday-packages/:packageId/line-items/:itemId", requireAuth, requireManager, async (req, res, next) => {
    try {
      const { packageId, itemId } = req.params;
      if (!await hasPackageAccess(req, packageId)) return res.status(404).json({ error: "Package not found" });
      await db.delete(packageLineItemTemplates)
        .where(and(
          eq(packageLineItemTemplates.id, itemId),
          eq(packageLineItemTemplates.packageTemplateId, packageId)
        ));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/beo/birthday-packages/:packageId/line-items/reorder", requireAuth, requireManager, async (req, res, next) => {
    try {
      const { packageId } = req.params;
      if (!await hasPackageAccess(req, packageId)) return res.status(404).json({ error: "Package not found" });
      const { orderedIds } = req.body as { orderedIds: string[] };
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: "orderedIds must be an array of strings" });
      }
      for (let i = 0; i < orderedIds.length; i++) {
        await db.update(packageLineItemTemplates)
          .set({ sortOrder: i })
          .where(and(
            eq(packageLineItemTemplates.id, orderedIds[i]),
            eq(packageLineItemTemplates.packageTemplateId, packageId)
          ));
      }
      const items = await db.select().from(packageLineItemTemplates)
        .where(eq(packageLineItemTemplates.packageTemplateId, packageId))
        .orderBy(asc(packageLineItemTemplates.sortOrder));
      res.json(items);
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // ENTERTAINMENT PACKAGE TEMPLATES CRUD
  // ============================================

  app.get("/api/beo/entertainment-templates", requireAuth, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const templates = await db.select().from(entertainmentPackageTemplates)
        .where(eq(entertainmentPackageTemplates.tenantId, user.tenantId!))
        .orderBy(asc(entertainmentPackageTemplates.sortOrder));
      res.json(templates);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/entertainment-templates", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const parsed = insertEntertainmentPackageTemplateSchema.parse({ ...req.body, tenantId: user.tenantId!, createdByUserId: user.id });
      const [template] = await db.insert(entertainmentPackageTemplates).values(parsed).returning();
      res.status(201).json(template);
    } catch (error) {
      if (error instanceof ZodError) return invalidTemplate(res, error);
      next(error);
    }
  });

  app.patch("/api/beo/entertainment-templates/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const { id } = req.params;
      const updates = insertEntertainmentPackageTemplateSchema
        .omit({ tenantId: true, createdByUserId: true }).partial().parse(req.body);
      const [updated] = await db.update(entertainmentPackageTemplates)
        .set({ ...updates, updatedAt: new Date() })
        .where(and(eq(entertainmentPackageTemplates.id, id), eq(entertainmentPackageTemplates.tenantId, user.tenantId!)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Entertainment template not found" });
      res.json(updated);
    } catch (error) {
      if (error instanceof ZodError) return invalidTemplate(res, error);
      next(error);
    }
  });

  app.delete("/api/beo/entertainment-templates/:id", requireAuth, requireManager, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const { id } = req.params;
      await db.update(entertainmentPackageTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(entertainmentPackageTemplates.id, id), eq(entertainmentPackageTemplates.tenantId, user.tenantId!)));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // EVENT PACKAGE SNAPSHOT APIs
  // ============================================

  app.post("/api/beo/events/:eventId/package-snapshot", requireAuth, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const { eventId } = req.params;
      const { templateId } = req.body;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      const [template] = await db.select().from(birthdayPackageTemplates)
        .where(and(eq(birthdayPackageTemplates.id, templateId), eq(birthdayPackageTemplates.tenantId, user.tenantId!)));
      if (!template) return res.status(404).json({ error: "Package template not found" });

      // The copy, its lines and the kitchen plan's set menu as one write, as
      // the BEO AI Fill's approval applies a package (server/lib/packageSnapshot.ts).
      const { snapshot, items, setMenuTemplateId } = await db.transaction((tx) =>
        applyPackageSnapshot(tx, { eventId, template }),
      );

      res.status(201).json({ ...snapshot, items, setMenuTemplateId });
    } catch (error) {
      next(error);
    }
  });

  // The party's own slip time (SCRUM-803): the template's at apply, changed here.
  app.patch("/api/beo/events/:eventId/package-snapshot", requireAuth, async (req, res, next) => {
    try {
      const { eventId } = req.params;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      const parsed = updateBeoPackageSnapshotSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid package change", details: parsed.error.flatten() });

      const [updated] = await db.update(beoPackageSnapshots)
        .set({ slipsTime: parsed.data.slipsTime, updatedAt: new Date() })
        .where(eq(beoPackageSnapshots.eventId, eventId))
        .returning();
      if (!updated) return res.status(404).json({ error: "No package snapshot for this event" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/beo/events/:eventId/package-snapshot", requireAuth, async (req, res, next) => {
    try {
      const { eventId } = req.params;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      const [snapshot] = await db.select().from(beoPackageSnapshots)
        .where(eq(beoPackageSnapshots.eventId, eventId));
      if (!snapshot) return res.json(null);

      const items = await db.select().from(beoPackageSnapshotItems)
        .where(eq(beoPackageSnapshotItems.snapshotId, snapshot.id))
        .orderBy(asc(beoPackageSnapshotItems.sortOrder));

      res.json({ ...snapshot, items });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/beo/events/:eventId/package-snapshot/items/:itemId", requireAuth, async (req, res, next) => {
    try {
      const { eventId, itemId } = req.params;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      const [snapshot] = await db.select().from(beoPackageSnapshots)
        .where(eq(beoPackageSnapshots.eventId, eventId));
      if (!snapshot) return res.status(404).json({ error: "No package snapshot for this event" });

      const { qty, unitPrice, notes, billable } = req.body;
      const updateData: Record<string, any> = {};
      if (qty !== undefined) updateData.qty = qty;
      if (unitPrice !== undefined) updateData.unitPrice = unitPrice;
      if (notes !== undefined) updateData.notes = notes;
      if (billable !== undefined) updateData.billable = billable;

      const [updated] = await db.update(beoPackageSnapshotItems)
        .set(updateData)
        .where(and(
          eq(beoPackageSnapshotItems.id, itemId),
          eq(beoPackageSnapshotItems.snapshotId, snapshot.id)
        ))
        .returning();
      if (!updated) return res.status(404).json({ error: "Snapshot item not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/beo/events/:eventId/package-snapshot", requireAuth, async (req, res, next) => {
    try {
      const { eventId } = req.params;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      const [snapshot] = await db.select().from(beoPackageSnapshots)
        .where(eq(beoPackageSnapshots.eventId, eventId));
      if (snapshot) {
        await db.delete(beoPackageSnapshotItems)
          .where(eq(beoPackageSnapshotItems.snapshotId, snapshot.id));
        await db.delete(beoPackageSnapshots)
          .where(eq(beoPackageSnapshots.id, snapshot.id));
      }

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // EVENT ENTERTAINMENT SELECTION APIs
  // ============================================

  app.get("/api/beo/events/:eventId/entertainment-selections", requireAuth, async (req, res, next) => {
    try {
      const { eventId } = req.params;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      const selections = await db.select().from(beoEntertainmentSelections)
        .where(eq(beoEntertainmentSelections.eventId, eventId))
        .orderBy(asc(beoEntertainmentSelections.sortOrder));
      res.json(selections);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/beo/events/:eventId/entertainment-selections", requireAuth, async (req, res, next) => {
    try {
      const user = req.userWithAccess!;
      const { eventId } = req.params;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      let insertData: any = { eventId };

      if (req.body.templateId) {
        const [template] = await db.select().from(entertainmentPackageTemplates)
          .where(and(
            eq(entertainmentPackageTemplates.id, req.body.templateId),
            eq(entertainmentPackageTemplates.tenantId, user.tenantId!)
          ));
        if (!template) return res.status(404).json({ error: "Entertainment template not found" });

        insertData = {
          ...insertData,
          templateId: template.id,
          templateNameAtApply: template.name,
          templateUpdatedAtAtApply: template.updatedAt,
          name: template.name,
          description: template.description,
          durationMinutes: template.durationMinutes,
          price: template.defaultPrice,
          billable: template.billableByDefault,
        };
      } else {
        insertData = {
          ...insertData,
          name: req.body.name,
          description: req.body.description,
          durationMinutes: req.body.durationMinutes,
          price: req.body.price || 0,
          billable: req.body.billable !== undefined ? req.body.billable : true,
          notes: req.body.notes,
        };
      }

      const [selection] = await db.insert(beoEntertainmentSelections).values(insertData).returning();
      res.status(201).json(selection);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/beo/events/:eventId/entertainment-selections/:id", requireAuth, async (req, res, next) => {
    try {
      const { eventId, id } = req.params;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      const { name, description, durationMinutes, price, billable, notes, sortOrder } = req.body;
      const updates = Object.fromEntries(Object.entries({ name, description, durationMinutes, price, billable, notes, sortOrder })
        .filter(([, value]) => value !== undefined));
      const [updated] = await db.update(beoEntertainmentSelections)
        .set({ ...updates, updatedAt: new Date() })
        .where(and(
          eq(beoEntertainmentSelections.id, id),
          eq(beoEntertainmentSelections.eventId, eventId)
        ))
        .returning();
      if (!updated) return res.status(404).json({ error: "Entertainment selection not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/beo/events/:eventId/entertainment-selections/:id", requireAuth, async (req, res, next) => {
    try {
      const { eventId, id } = req.params;

      if (!await verifyEventAccess(req, eventId)) {
        return res.status(404).json({ error: "Event not found" });
      }

      await db.delete(beoEntertainmentSelections)
        .where(and(
          eq(beoEntertainmentSelections.id, id),
          eq(beoEntertainmentSelections.eventId, eventId)
        ));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });
}
