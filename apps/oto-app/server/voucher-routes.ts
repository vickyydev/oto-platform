import { Router, Request, Response } from "express";
import { db } from "./db";
import { eq, and, or, isNull, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "./auth";
import { requireRole, requireManager } from "./auth-middleware";
import {
  voucherTemplates,
  userVouchers,
  voucherRedemptions,
  insertVoucherTemplateSchema,
} from "./db/coreSchema";
import { tenants, employees, users, DEFAULT_TENANT_SLUG } from "../shared/schema";
import crypto from "crypto";

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

function generateToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

// ============================================
// STUDIO: Voucher Template Management
// ============================================

router.get("/studio/voucher-templates", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const templates = await db
      .select()
      .from(voucherTemplates)
      .where(eq(voucherTemplates.tenantId, tenantId))
      .orderBy(desc(voucherTemplates.createdAt));
    res.json(templates);
  } catch (error: any) {
    console.error("[Voucher] GET /studio/voucher-templates error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post("/studio/voucher-templates", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const userId = (req.user as any)?.id;

    const data = insertVoucherTemplateSchema.parse({
      ...req.body,
      tenantId,
      createdByUserId: userId,
    });

    const [template] = await db.insert(voucherTemplates).values(data).returning();
    res.status(201).json(template);
  } catch (error: any) {
    console.error("[Voucher] POST /studio/voucher-templates error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.patch("/studio/voucher-templates/:id", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [template] = await db
      .update(voucherTemplates)
      .set({
        ...req.body,
        updatedAt: new Date(),
      })
      .where(and(eq(voucherTemplates.id, id), eq(voucherTemplates.tenantId, tenantId)))
      .returning();

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.json(template);
  } catch (error: any) {
    console.error("[Voucher] PATCH /studio/voucher-templates/:id error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.delete("/studio/voucher-templates/:id", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    await db
      .delete(voucherTemplates)
      .where(and(eq(voucherTemplates.id, id), eq(voucherTemplates.tenantId, tenantId)));

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Voucher] DELETE /studio/voucher-templates/:id error:", error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// HR: Employee Voucher Assignment
// ============================================

router.get("/hr/employees/:employeeId/vouchers", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { employeeId } = req.params;
    const tenantId = await getDefaultTenantId();

    const vouchers = await db
      .select({
        voucher: userVouchers,
        template: voucherTemplates,
      })
      .from(userVouchers)
      .leftJoin(voucherTemplates, eq(userVouchers.templateId, voucherTemplates.id))
      .where(and(eq(userVouchers.employeeId, employeeId), eq(userVouchers.tenantId, tenantId)))
      .orderBy(desc(userVouchers.assignedAt));

    const result = vouchers.map((v) => ({
      ...v.voucher,
      template: v.template,
    }));

    res.json(result);
  } catch (error: any) {
    console.error("[Voucher] GET /hr/employees/:employeeId/vouchers error:", error);
    res.status(500).json({ message: error.message });
  }
});

const assignVoucherSchema = z.object({
  templateId: z.string().uuid(),
  remainingUses: z.number().int().min(1).optional(),
  customImageUrl: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  validFromOverride: z.string().optional().nullable(),
  validToOverride: z.string().optional().nullable(),
});

router.post("/hr/employees/:employeeId/vouchers", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { employeeId } = req.params;
    const tenantId = await getDefaultTenantId();
    const data = assignVoucherSchema.parse(req.body);

    const [template] = await db
      .select()
      .from(voucherTemplates)
      .where(eq(voucherTemplates.id, data.templateId))
      .limit(1);

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    const [employee] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    let userId: string | null = null;
    if (employee.personId) {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.personId, employee.personId))
        .limit(1);
      if (user) userId = user.id;
    }

    const [voucher] = await db
      .insert(userVouchers)
      .values({
        tenantId,
        employeeId,
        userId,
        templateId: data.templateId,
        token: generateToken(),
        remainingUses: data.remainingUses ?? template.maxUses,
        status: "active",
        customImageUrl: data.customImageUrl,
        notes: data.notes,
        validFromOverride: data.validFromOverride ? new Date(data.validFromOverride) : null,
        validToOverride: data.validToOverride ? new Date(data.validToOverride) : null,
      })
      .returning();

    res.status(201).json(voucher);
  } catch (error: any) {
    console.error("[Voucher] POST /hr/employees/:employeeId/vouchers error:", error);
    res.status(500).json({ message: error.message });
  }
});

const bulkAssignSchema = z.object({
  templateId: z.string().uuid(),
  scope: z.enum(["everyone", "management", "selected_branches", "selected_employees"]),
  branchIds: z.array(z.string()).optional(),
  employeeIds: z.array(z.string()).optional(),
  remainingUses: z.number().int().min(1).optional(),
  skipExisting: z.boolean().default(false),
});

router.post("/hr/vouchers/bulk-assign", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const data = bulkAssignSchema.parse(req.body);

    const [template] = await db
      .select()
      .from(voucherTemplates)
      .where(eq(voucherTemplates.id, data.templateId))
      .limit(1);

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    let targetEmployees: typeof employees.$inferSelect[] = [];

    if (data.scope === "everyone") {
      targetEmployees = await db
        .select()
        .from(employees)
        .where(and(eq(employees.tenantId, tenantId), eq(employees.status, "active")));
    } else if (data.scope === "selected_branches" && data.branchIds?.length) {
      targetEmployees = await db
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.tenantId, tenantId),
            eq(employees.status, "active"),
            sql`${employees.branchId} = ANY(${data.branchIds})`
          )
        );
    } else if (data.scope === "selected_employees" && data.employeeIds?.length) {
      targetEmployees = await db
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.tenantId, tenantId),
            sql`${employees.id} = ANY(${data.employeeIds})`
          )
        );
    } else if (data.scope === "management") {
      const managerUsers = await db
        .select()
        .from(users)
        .where(eq(users.role, "manager"));

      const personIds = managerUsers.map((u) => u.personId).filter(Boolean);
      if (personIds.length > 0) {
        targetEmployees = await db
          .select()
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, tenantId),
              eq(employees.status, "active"),
              sql`${employees.personId} = ANY(${personIds})`
            )
          );
      }
    }

    let created = 0;
    let skipped = 0;

    for (const employee of targetEmployees) {
      if (data.skipExisting) {
        const existing = await db
          .select()
          .from(userVouchers)
          .where(
            and(
              eq(userVouchers.employeeId, employee.id),
              eq(userVouchers.templateId, data.templateId),
              eq(userVouchers.status, "active")
            )
          )
          .limit(1);

        if (existing.length > 0) {
          skipped++;
          continue;
        }
      }

      let userId: string | null = null;
      if (employee.personId) {
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.personId, employee.personId))
          .limit(1);
        if (user) userId = user.id;
      }

      await db.insert(userVouchers).values({
        tenantId,
        employeeId: employee.id,
        userId,
        templateId: data.templateId,
        token: generateToken(),
        remainingUses: data.remainingUses ?? template.maxUses,
        status: "active",
      });
      created++;
    }

    res.json({ created, skipped, total: targetEmployees.length });
  } catch (error: any) {
    console.error("[Voucher] POST /hr/vouchers/bulk-assign error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.delete("/hr/vouchers/:voucherId", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { voucherId } = req.params;
    const tenantId = await getDefaultTenantId();

    await db
      .update(userVouchers)
      .set({ status: "revoked" })
      .where(and(eq(userVouchers.id, voucherId), eq(userVouchers.tenantId, tenantId)));

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Voucher] DELETE /hr/vouchers/:voucherId error:", error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// CORE: My Vouchers (Staff)
// ============================================

router.get("/core/my-vouchers", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const tenantId = await getDefaultTenantId();

    const vouchers = await db
      .select({
        voucher: userVouchers,
        template: voucherTemplates,
      })
      .from(userVouchers)
      .leftJoin(voucherTemplates, eq(userVouchers.templateId, voucherTemplates.id))
      .where(and(eq(userVouchers.userId, userId), eq(userVouchers.tenantId, tenantId)))
      .orderBy(desc(userVouchers.assignedAt));

    const now = new Date();
    const result = vouchers
      .map((v) => {
        const validFrom = v.voucher.validFromOverride || v.template?.validFrom;
        const validTo = v.voucher.validToOverride || v.template?.validTo;

        let effectiveStatus = v.voucher.status;
        if (effectiveStatus === "active") {
          if (validTo && new Date(validTo) < now) {
            effectiveStatus = "expired";
          }
          if (validFrom && new Date(validFrom) > now) {
            effectiveStatus = "active";
          }
        }

        return {
          id: v.voucher.id,
          token: v.voucher.token,
          remainingUses: v.voucher.remainingUses,
          status: effectiveStatus,
          assignedAt: v.voucher.assignedAt,
          lastRedeemedAt: v.voucher.lastRedeemedAt,
          validFrom,
          validTo,
          customImageUrl: v.voucher.customImageUrl,
          notes: v.voucher.notes,
          template: v.template
            ? {
                id: v.template.id,
                name: v.template.name,
                imageUrl: v.template.imageUrl,
                description: v.template.description,
              }
            : null,
          imageUrl: v.voucher.customImageUrl || v.template?.imageUrl,
          name: v.template?.name || "Personal Voucher",
        };
      })
      .filter((v) => v.status === "active" && v.remainingUses > 0);

    res.json(result);
  } catch (error: any) {
    console.error("[Voucher] GET /core/my-vouchers error:", error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// CORE: Redeem Voucher (Cashier/Manager)
// ============================================

const redeemVoucherSchema = z.object({
  token: z.string().min(1),
  notes: z.string().optional().nullable(),
  branchId: z.string().optional().nullable(),
});

router.post("/core/vouchers/redeem", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    const tenantId = await getDefaultTenantId();
    const data = redeemVoucherSchema.parse(req.body);

    const [voucher] = await db
      .select({
        voucher: userVouchers,
        template: voucherTemplates,
      })
      .from(userVouchers)
      .leftJoin(voucherTemplates, eq(userVouchers.templateId, voucherTemplates.id))
      .where(and(eq(userVouchers.token, data.token), eq(userVouchers.tenantId, tenantId)))
      .limit(1);

    if (!voucher) {
      return res.status(404).json({ message: "Voucher not found" });
    }

    const v = voucher.voucher;
    const t = voucher.template;

    if (v.status !== "active") {
      return res.status(400).json({ message: `Voucher is ${v.status}` });
    }

    if (v.remainingUses <= 0) {
      return res.status(400).json({ message: "Voucher has no remaining uses" });
    }

    const now = new Date();
    const validFrom = v.validFromOverride || t?.validFrom;
    const validTo = v.validToOverride || t?.validTo;

    if (validFrom && new Date(validFrom) > now) {
      return res.status(400).json({ message: "Voucher is not yet valid" });
    }

    if (validTo && new Date(validTo) < now) {
      return res.status(400).json({ message: "Voucher has expired" });
    }

    const newRemainingUses = v.remainingUses - 1;
    const newStatus = newRemainingUses === 0 ? "used_up" : "active";

    await db
      .update(userVouchers)
      .set({
        remainingUses: newRemainingUses,
        status: newStatus,
        lastRedeemedAt: now,
      })
      .where(eq(userVouchers.id, v.id));

    await db.insert(voucherRedemptions).values({
      tenantId,
      voucherId: v.id,
      branchId: data.branchId || null,
      redeemedBy: userId,
      notes: data.notes,
    });

    res.json({
      success: true,
      voucherId: v.id,
      remainingUses: newRemainingUses,
      status: newStatus,
      templateName: t?.name || "Personal Voucher",
    });
  } catch (error: any) {
    console.error("[Voucher] POST /core/vouchers/redeem error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/core/vouchers/lookup/:token", requireAuth, requireManager, async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const tenantId = await getDefaultTenantId();

    const [result] = await db
      .select({
        voucher: userVouchers,
        template: voucherTemplates,
        employee: employees,
      })
      .from(userVouchers)
      .leftJoin(voucherTemplates, eq(userVouchers.templateId, voucherTemplates.id))
      .leftJoin(employees, eq(userVouchers.employeeId, employees.id))
      .where(and(eq(userVouchers.token, token), eq(userVouchers.tenantId, tenantId)))
      .limit(1);

    if (!result) {
      return res.status(404).json({ message: "Voucher not found" });
    }

    const now = new Date();
    const v = result.voucher;
    const t = result.template;
    const validFrom = v.validFromOverride || t?.validFrom;
    const validTo = v.validToOverride || t?.validTo;

    let effectiveStatus = v.status;
    if (effectiveStatus === "active") {
      if (validTo && new Date(validTo) < now) {
        effectiveStatus = "expired";
      }
    }

    res.json({
      id: v.id,
      token: v.token,
      remainingUses: v.remainingUses,
      status: effectiveStatus,
      validFrom,
      validTo,
      templateName: t?.name || "Personal Voucher",
      templateImage: v.customImageUrl || t?.imageUrl,
      employeeName: result.employee?.fullName,
    });
  } catch (error: any) {
    console.error("[Voucher] GET /core/vouchers/lookup/:token error:", error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
