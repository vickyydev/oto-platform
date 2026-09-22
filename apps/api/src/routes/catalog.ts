import { z } from 'zod';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import {
  branch,
  branchHoliday,
  branchTaxConfig,
  member,
  product,
  productCategory,
  sale,
  taxOverride,
  ticketPackage,
  tier,
} from '@oto/db';
import {
  TaxConfigSchema,
  TicketPackageBodySchema,
  getRateModeForDate,
  businessDate,
  isIsoDate,
  newId,
  parseDayStart,
  type TaxConfigShape,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { resolveTax } from '../services/tax';
import { opCtx, withTx } from '../services/tx';

/**
 * THE ONE DOOR INTO A BRANCH'S CATALOGUE (SCRUM-248).
 *
 * Every `/branches/:branchId/…` route IN THIS FILE calls this before it
 * touches a row, and it is the only thing in the request that establishes the
 * branch in the URL belongs to the caller's operator.
 *
 * The route guard does not establish it. When the caller's grant is
 * operator-scoped, `grantCovers` matches on the operator alone and says yes to
 * whatever branch id the target happens to name — it is a pure function over
 * ids and has no way to know which operator a branch belongs to. Three write
 * routes skipped this call and filtered by `id AND branchId` instead, which is
 * self-consistent and proves nothing: one operator's administrator renamed and
 * archived another operator's ticket package and deleted its holiday, 200 on
 * each, filing audit rows under their own operator carrying the other's branch
 * id.
 */
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

/**
 * A tier code is what a ticket package's price map is keyed by and what
 * `member.tier_code` holds, so it is minted from the name by the admin screen
 * and never changed afterwards — renaming a tier changes its name only.
 */
const TierCodeParams = z.object({ code: z.string().min(1).max(64) });

const TierBody = z.object({
  name: z.string().min(1).max(80),
  isDefault: z.boolean().default(false),
  requiresVerification: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
});

export async function catalogRoutes(app: App): Promise<void> {
  // Tiers (read path — SCRUM-35 packages reference them; writes below, SCRUM-228).
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

  // --- SCRUM-228: tier writes ----------------------------------------------
  // The tier list sets what a visitor can be priced at, so it is operator data
  // like any other and an admin screen that edits it has to reach the database.
  // These carry the package permissions rather than ones of their own: adding a
  // permission string would leave every seeded role without it until the roles
  // are re-seeded, and whoever may price a ticket is who may name the tiers it
  // is priced for.
  app.post(
    '/tiers',
    {
      config: { permission: 'catalog:package:create' },
      schema: {
        description: 'Create a customer tier',
        body: TierBody.extend({ code: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [clash] = await app.db
        .select()
        .from(tier)
        .where(and(eq(tier.operatorId, auth.operatorId), eq(tier.code, req.body.code)))
        .limit(1);
      if (clash) {
        throw errors.conflict('TIER_CODE_EXISTS', `A tier with the code "${req.body.code}" already exists`, {
          code: req.body.code,
          archived: clash.archivedAt !== null,
        });
      }
      const id = newId();
      const { code, name, isDefault, requiresVerification, sortOrder } = req.body;
      return withTx(app.db, opCtx(req), 'tier.create', async (tx) => {
        // Exactly one baseline per operator, and the baseline never asks for a
        // document — that is what being the baseline means.
        if (isDefault) {
          await tx.update(tier).set({ isDefault: false }).where(eq(tier.operatorId, auth.operatorId));
        }
        await tx.insert(tier).values({
          id,
          operatorId: auth.operatorId,
          code,
          name,
          isDefault,
          requiresVerification: isDefault ? false : requiresVerification,
          sortOrder,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'tier.create',
          entityType: 'tier',
          entityId: id,
          after: { code, name, isDefault, requiresVerification, sortOrder },
          requestId: req.id,
        });
        return { id: code };
      });
    },
  );

  app.patch(
    '/tiers/:code',
    {
      config: { permission: 'catalog:package:update' },
      schema: {
        description: 'Rename or re-rank a customer tier',
        params: TierCodeParams,
        body: TierBody.partial(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(tier)
        .where(
          and(
            eq(tier.operatorId, auth.operatorId),
            eq(tier.code, req.params.code),
            isNull(tier.archivedAt),
          ),
        )
        .limit(1);
      if (!before) throw errors.notFound('Tier not found');

      const b = req.body;
      const becomingDefault = b.isDefault === true;
      if (before.isDefault && b.isDefault === false) {
        throw errors.badRequest(
          'Make another tier the baseline instead — an operator always has exactly one',
        );
      }
      const patch: Partial<typeof tier.$inferInsert> = {};
      if (b.name !== undefined) patch.name = b.name;
      if (b.sortOrder !== undefined) patch.sortOrder = b.sortOrder;
      if (b.requiresVerification !== undefined) patch.requiresVerification = b.requiresVerification;
      if (becomingDefault) {
        patch.isDefault = true;
        patch.requiresVerification = false;
      }
      if (Object.keys(patch).length === 0) return { ok: true as const };

      return withTx(app.db, opCtx(req), 'tier.update', async (tx) => {
        if (becomingDefault) {
          await tx.update(tier).set({ isDefault: false }).where(eq(tier.operatorId, auth.operatorId));
        }
        await tx.update(tier).set(patch).where(eq(tier.id, before.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'tier.update',
          entityType: 'tier',
          entityId: before.id,
          before: {
            name: before.name,
            isDefault: before.isDefault,
            requiresVerification: before.requiresVerification,
            sortOrder: before.sortOrder,
          },
          after: patch,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  app.delete(
    '/tiers/:code',
    {
      config: { permission: 'catalog:package:update' },
      schema: {
        description: 'Archive a customer tier (refused while it prices anyone)',
        params: TierCodeParams,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(tier)
        .where(
          and(
            eq(tier.operatorId, auth.operatorId),
            eq(tier.code, req.params.code),
            isNull(tier.archivedAt),
          ),
        )
        .limit(1);
      if (!before) throw errors.notFound('Tier not found');
      if (before.isDefault) {
        throw errors.badRequest(
          'That is the baseline tier — make another tier the baseline before archiving it',
        );
      }
      // A member whose tier_code points at an archived tier would price against
      // a tier the catalog no longer offers, which is the ฿0 state this ticket
      // exists to close.
      const holders = await app.db
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.operatorId, auth.operatorId),
            eq(member.tierCode, req.params.code),
            isNull(member.archivedAt),
          ),
        )
        .limit(1);
      if (holders.length > 0) {
        throw errors.conflict(
          'TIER_IN_USE',
          'Members are priced at this tier — move them to another tier before archiving it',
          { code: req.params.code },
        );
      }
      return withTx(app.db, opCtx(req), 'tier.archive', async (tx) => {
        await tx.update(tier).set({ archivedAt: new Date() }).where(eq(tier.id, before.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'tier.archive',
          entityType: 'tier',
          entityId: before.id,
          before: { code: before.code, name: before.name },
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

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
      await loadBranch(app, req.params.branchId, auth.operatorId);
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
      await loadBranch(app, req.params.branchId, auth.operatorId);
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

  /**
   * SCRUM-258 — removing a holiday range once the day has been traded.
   *
   * `pos.sale.holiday_id` is ON DELETE RESTRICT, deliberately: a sale records
   * the range that put it on weekend prices, and a receipt has to go on saying
   * so years later even if next year's calendar is different. Deleting the row
   * out from under it was refused by Postgres as a raw 23503, which reached
   * the admin panel as an unexplained 500.
   *
   * SO THE REFUSAL IS MADE HERE, IN WORDS, AND ONLY WHEN IT IS EARNED: a range
   * nothing was sold under is removed as before, and one that priced real
   * sales is refused with the count. The alternative — archiving instead —
   * would have to be understood by every reader of this table before it
   * meant anything: the branch's own list, the pricing-mode indicator, the
   * public booking quote and the catalogue bundle a box runs offline all read
   * the ranges without a withdrawal filter, so an "archived" holiday would go
   * on setting weekend prices at the counter while the manager believed it was
   * gone. That is a wider change than this defect, and it is a backlog item
   * rather than something to slip in behind a delete button.
   */
  app.delete(
    '/branches/:branchId/holidays/:id',
    { config: { permission: 'catalog:holiday:manage', target: { branchId: 'params.branchId' } }, schema: { description: 'Remove a holiday range; refused once sales were priced by it', params: BranchParams.extend({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranch(app, req.params.branchId, auth.operatorId);
      const [before] = await app.db
        .select()
        .from(branchHoliday)
        .where(and(eq(branchHoliday.id, req.params.id), eq(branchHoliday.branchId, req.params.branchId)))
        .limit(1);
      if (!before) throw errors.notFound('Holiday not found');
      const [priced] = await app.db
        .select({ sales: count() })
        .from(sale)
        .where(eq(sale.holidayId, req.params.id));
      const sales = priced?.sales ?? 0;
      if (sales > 0) {
        throw errors.conflict(
          'HOLIDAY_HAS_SALES',
          `"${before.name}" set the prices on ${sales} sale${sales === 1 ? '' : 's'} that have ` +
            'already been taken, so it cannot be removed — those receipts have to keep saying ' +
            'which holiday priced them.',
          { saleCount: sales, startsOn: before.startsOn, endsOn: before.endsOn },
        );
      }
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
   *
   * The default date is the branch's TRADING day, not the calendar day
   * (SCRUM-308). A sale is priced on `business_day_start` — 05:00 by default —
   * through `resolvePricingScope`, so between midnight and five the calendar
   * has moved on and the till has not. Seen on staging: the chip said Weekday
   * at 00:20 while the same basket was priced Weekend for a holiday on the
   * 22nd, which was still the trading day. Same helper, same holiday filter
   * (a withdrawn range prices nothing), so the two cannot drift again.
   */
  app.get(
    '/branches/:branchId/pricing-mode',
    {
      config: { permission: 'catalog:package:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Rate mode for a date (default: the branch trading day — business_day_start in the branch timezone — which is the day a sale rung now would be priced on)',
        params: BranchParams,
        querystring: z.object({ date: z.string().optional() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const br = await loadBranch(app, req.params.branchId, auth.operatorId);
      const date =
        req.query.date ??
        businessDate(new Date(), br.timezone, parseDayStart(br.businessDayStart));
      if (!isIsoDate(date)) throw errors.badRequest('date must be yyyy-mm-dd');
      const holidays = await app.db
        .select()
        .from(branchHoliday)
        .where(and(eq(branchHoliday.branchId, req.params.branchId), isNull(branchHoliday.archivedAt)));
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
