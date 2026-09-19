import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  branch,
  branchHoliday,
  branchTaxConfig,
  product,
  productCategory,
  taxOverride,
  ticketPackage,
  tier,
} from '@oto/db';
import {
  TaxConfigSchema,
  TicketPackageBodySchema,
  getRateModeForDate,
  branchToday,
  isIsoDate,
  newId,
  type TaxConfigShape,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { resolveTax } from '../services/tax';
import { opCtx, withTx } from '../services/tx';

async function loadBranch(app: App, branchId: string, operatorId: string) {
  const [br] = await app.db
    .select()
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!br) throw errors.notFound('Branch not found');
  return br;
}

const BranchParams = z.object({ branchId: z.string().uuid() });

export async function catalogRoutes(app: App): Promise<void> {
  // Tiers (read path — SCRUM-35 packages reference them; CRUD stays mock, Q4).
  app.get('/tiers', { config: { permission: 'catalog:package:read' }, schema: { description: 'Operator tier definitions' } }, async (req) => {
    const auth = req.requireAuth();
    const rows = await app.db
      .select()
      .from(tier)
      .where(and(eq(tier.operatorId, auth.operatorId), isNull(tier.archivedAt)))
      .orderBy(asc(tier.sortOrder));
    return {
      tiers: rows.map((t) => ({
        id: t.code,
        name: t.name,
        isDefault: t.isDefault,
        requiresVerification: t.requiresVerification,
        sortOrder: t.sortOrder,
      })),
    };
  });

  // --- SCRUM-35: ticket packages -------------------------------------------
  app.get(
    '/branches/:branchId/ticket-packages',
    {
      config: { permission: 'catalog:package:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Ticket packages for a branch',
        params: BranchParams,
        querystring: z.object({ includeArchived: z.coerce.boolean().default(false) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const where = req.query.includeArchived
        ? eq(ticketPackage.branchId, req.params.branchId)
        : and(eq(ticketPackage.branchId, req.params.branchId), isNull(ticketPackage.archivedAt));
      const rows = await app.db.select().from(ticketPackage).where(where).orderBy(asc(ticketPackage.createdAt));
      return { packages: rows };
    },
  );

  app.post(
    '/branches/:branchId/ticket-packages',
    {
      config: { permission: 'catalog:package:create', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Create a ticket package',
        params: BranchParams,
        body: TicketPackageBodySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const id = newId();
      // Catalogue writes carry their audit row in the same transaction: a
      // price the tills start charging that nobody can account for is worse
      // than a price change that never landed.
      return withTx(app.db, opCtx(req), 'ticket_package.create', async (tx) => {
        await tx.insert(ticketPackage).values({
          id,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          ...req.body,
          gateAccess: req.body.gateAccess ?? false,
          active: req.body.active ?? true,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'ticket_package.create',
          entityType: 'ticket_package',
          entityId: id,
          after: req.body,
          requestId: req.id,
        });
        return { id };
      });
    },
  );

  app.patch(
    '/branches/:branchId/ticket-packages/:id',
    {
      config: { permission: 'catalog:package:update', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Update a ticket package',
        params: BranchParams.extend({ id: z.string().uuid() }),
        body: TicketPackageBodySchema.partial(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(ticketPackage)
        .where(and(eq(ticketPackage.id, req.params.id), eq(ticketPackage.branchId, req.params.branchId)))
        .limit(1);
      if (!before) throw errors.notFound('Ticket package not found');
      return withTx(app.db, opCtx(req), 'ticket_package.update', async (tx) => {
        const [after] = await tx
          .update(ticketPackage)
          .set(req.body)
          .where(eq(ticketPackage.id, req.params.id))
          .returning();
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'ticket_package.update',
          entityType: 'ticket_package',
          entityId: req.params.id,
          before,
          after,
          requestId: req.id,
        });
        return { ok: true };
      });
    },
  );

  app.delete(
    '/branches/:branchId/ticket-packages/:id',
    {
      config: { permission: 'catalog:package:update', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Archive a ticket package (soft delete)',
        params: BranchParams.extend({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(ticketPackage)
        .where(and(eq(ticketPackage.id, req.params.id), eq(ticketPackage.branchId, req.params.branchId)))
        .limit(1);
      if (!before) throw errors.notFound('Ticket package not found');
      return withTx(app.db, opCtx(req), 'ticket_package.archive', async (tx) => {
        await tx
          .update(ticketPackage)
          .set({ archivedAt: new Date(), active: false })
          .where(eq(ticketPackage.id, req.params.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'ticket_package.archive',
          entityType: 'ticket_package',
          entityId: req.params.id,
          before,
          requestId: req.id,
        });
        return { ok: true };
      });
    },
  );

  // --- SCRUM-36: holidays + the pricing-mode resolver ----------------------
  app.get(
    '/branches/:branchId/holidays',
    { config: { permission: 'catalog:holiday:read', target: { branchId: 'params.branchId' } }, schema: { description: 'Holiday (weekend-pricing) ranges', params: BranchParams } },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const rows = await app.db
        .select()
        .from(branchHoliday)
        .where(eq(branchHoliday.branchId, req.params.branchId))
        .orderBy(asc(branchHoliday.startsOn));
      return { holidays: rows.map((h) => ({ id: h.id, name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })) };
    },
  );

  app.post(
    '/branches/:branchId/holidays',
    {
      config: { permission: 'catalog:holiday:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Add a holiday range (inclusive, forces weekend pricing)',
        params: BranchParams,
        body: z
          .object({
            name: z.string().min(1),
            startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          })
          .refine((b) => b.startsOn <= b.endsOn, { message: 'startsOn must be <= endsOn' }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const id = newId();
      return withTx(app.db, opCtx(req), 'branch_holiday.create', async (tx) => {
        await tx.insert(branchHoliday).values({ id, branchId: req.params.branchId, ...req.body });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'branch_holiday.create',
          entityType: 'branch_holiday',
          entityId: id,
          after: req.body,
          requestId: req.id,
        });
        return { id };
      });
    },
  );

  app.delete(
    '/branches/:branchId/holidays/:id',
    { config: { permission: 'catalog:holiday:manage', target: { branchId: 'params.branchId' } }, schema: { description: 'Remove a holiday range', params: BranchParams.extend({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(branchHoliday)
        .where(and(eq(branchHoliday.id, req.params.id), eq(branchHoliday.branchId, req.params.branchId)))
        .limit(1);
      if (!before) throw errors.notFound('Holiday not found');
      return withTx(app.db, opCtx(req), 'branch_holiday.delete', async (tx) => {
        await tx.delete(branchHoliday).where(eq(branchHoliday.id, req.params.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'branch_holiday.delete',
          entityType: 'branch_holiday',
          entityId: req.params.id,
          before,
          requestId: req.id,
        });
        return { ok: true };
      });
    },
  );

  /**
   * The pricing resolver (SCRUM-36): branch + date → applicable rate mode,
   * holiday ranges treated as weekend (prototype pricingMode.ts, tz-aware).
   * Drives the POS header's "Weekday pricing" indicator.
   */
  app.get(
    '/branches/:branchId/pricing-mode',
    {
      config: { permission: 'catalog:package:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Rate mode for a date (default: today in the branch timezone)',
        params: BranchParams,
        querystring: z.object({ date: z.string().optional() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const br = await loadBranch(app, req.params.branchId, auth.operatorId);
      const date = req.query.date ?? branchToday(br.timezone);
      if (!isIsoDate(date)) throw errors.badRequest('date must be yyyy-mm-dd');
      const holidays = await app.db
        .select()
        .from(branchHoliday)
        .where(eq(branchHoliday.branchId, req.params.branchId));
      const result = getRateModeForDate(
        date,
        holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
      );
      return { date, ...result };
    },
  );

  // --- SCRUM-37: tax config + overrides + resolver -------------------------
  app.get(
    '/branches/:branchId/tax-config',
    { config: { permission: 'catalog:tax:read', target: { branchId: 'params.branchId' } }, schema: { description: 'Branch tax configuration', params: BranchParams } },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const [row] = await app.db
        .select()
        .from(branchTaxConfig)
        .where(eq(branchTaxConfig.branchId, req.params.branchId))
        .limit(1);
      return { config: (row?.config as TaxConfigShape | undefined) ?? null };
    },
  );

  app.put(
    '/branches/:branchId/tax-config',
    { config: { permission: 'catalog:tax:manage', target: { branchId: 'params.branchId' } }, schema: { description: 'Replace the branch tax configuration', params: BranchParams, body: TaxConfigSchema } },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const [existing] = await app.db
        .select()
        .from(branchTaxConfig)
        .where(eq(branchTaxConfig.branchId, req.params.branchId))
        .limit(1);
      return withTx(app.db, opCtx(req), 'branch_tax_config.update', async (tx) => {
        // An upsert rather than the read above deciding: PUT is idempotent by
        // definition, and two managers saving a branch's tax rules at once
        // should both succeed with the later one winning — not one of them
        // getting a unique violation off the branch_tax_config_unique index.
        await tx
          .insert(branchTaxConfig)
          .values({ id: existing?.id ?? newId(), branchId: req.params.branchId, config: req.body })
          .onConflictDoUpdate({
            target: branchTaxConfig.branchId,
            set: { config: req.body },
          });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'branch_tax_config.update',
          entityType: 'branch_tax_config',
          entityId: req.params.branchId,
          before: existing?.config ?? null,
          after: req.body,
          requestId: req.id,
        });
        return { ok: true };
      });
    },
  );

  app.get(
    '/branches/:branchId/tax-overrides',
    { config: { permission: 'catalog:tax:read', target: { branchId: 'params.branchId' } }, schema: { description: 'Category/product tax overrides', params: BranchParams } },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const rows = await app.db.select().from(taxOverride).where(eq(taxOverride.branchId, req.params.branchId));
      return { overrides: rows };
    },
  );

  app.post(
    '/branches/:branchId/tax-overrides',
    {
      config: { permission: 'catalog:tax:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Add a tax override (category- or product-scoped)',
        params: BranchParams,
        body: z
          .object({
            categoryId: z.string().uuid().nullable().optional(),
            productId: z.string().uuid().nullable().optional(),
            vatRateBp: z.number().int().min(0).max(10000).nullable().optional(),
            serviceChargeBp: z.number().int().min(0).max(10000).nullable().optional(),
          })
          .refine((b) => b.categoryId || b.productId, { message: 'categoryId or productId required' }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const id = newId();
      return withTx(app.db, opCtx(req), 'tax_override.create', async (tx) => {
        await tx.insert(taxOverride).values({
          id,
          branchId: req.params.branchId,
          categoryId: req.body.categoryId ?? null,
          productId: req.body.productId ?? null,
          vatRateBp: req.body.vatRateBp ?? null,
          serviceChargeBp: req.body.serviceChargeBp ?? null,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'tax_override.create',
          entityType: 'tax_override',
          entityId: id,
          after: req.body,
          requestId: req.id,
        });
        return { id };
      });
    },
  );

  /** The tax resolver (SCRUM-37): branch default → category override → product override. */
  app.get(
    '/branches/:branchId/tax-resolve',
    {
      config: { permission: 'catalog:tax:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Effective VAT + service charge for a taxable area / category / product',
        params: BranchParams,
        querystring: z.object({
          taxableCategory: z.string().default('tickets'),
          categoryId: z.string().uuid().optional(),
          productId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      return resolveTax(app.db, {
        branchId: req.params.branchId,
        taxableCategory: req.query.taxableCategory,
        categoryId: req.query.categoryId,
        productId: req.query.productId,
      });
    },
  );

  // Product categories/products read (targets for overrides).
  app.get('/product-categories', { config: { permission: 'catalog:tax:read' }, schema: { description: 'Product categories' } }, async (req) => {
    const auth = req.requireAuth();
    const cats = await app.db
      .select()
      .from(productCategory)
      .where(and(eq(productCategory.operatorId, auth.operatorId), isNull(productCategory.archivedAt)));
    const prods = await app.db
      .select()
      .from(product)
      .where(and(eq(product.operatorId, auth.operatorId), isNull(product.archivedAt)));
    return {
      categories: cats.map((c) => ({ id: c.id, name: c.name, taxableCategory: c.taxableCategory })),
      products: prods.map((p) => ({ id: p.id, name: p.name, categoryId: p.categoryId })),
    };
  });
}
