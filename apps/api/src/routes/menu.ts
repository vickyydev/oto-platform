import { z } from 'zod';
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import {
  branch,
  discountDefinition,
  modifierGroup,
  modifierOption,
  product,
  productCategory,
} from '@oto/db';
import {
  branchToday,
  DiscountDefinitionBodySchema,
  MenuCategoryBodySchema,
  MenuItemBodySchema,
  ModifierGroupBodySchema,
  newId,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import {
  assertCategoryCodeFree,
  assertCategoryDepth,
  assertItemCodeFree,
  assertLibraryGroups,
  assertTopLevelHasTaxableArea,
  categoryDependants,
  clearModifierGroupLinks,
  loadDiscountDefinition,
  loadMenuCategory,
  loadMenuItem,
  loadModifierGroup,
  presentMenu,
  readMenu,
  setItemModifierGroups,
} from '../services/menu';
import {
  applyMenuImport,
  assertPreviewStillTrue,
  buildMenuWorkbook,
  menuDigest,
  parseMenuWorkbook,
  planMenuImport,
} from '../services/menu-sheet';
import {
  assertBarcodesFree,
  assertVariantsWellFormed,
  normaliseVariants,
} from '../services/product-variants';
import { productStockLinks, setProductStockLinks } from '../services/stock';
import { opCtx, withTx } from '../services/tx';

/**
 * The menu, the shared modifier library and the discount codes (SCRUM-232,
 * SCRUM-204, SCRUM-230), plus the spreadsheet the owner asked for at the first
 * demo: an Export whose output doubles as the Import's template.
 *
 * **Which routes take a branch, and why.** An ITEM is branch-owned —
 * `product.branch_id` — because a price is what one park charges, so every
 * item route hangs off `/branches/:branchId/…` and declares that branch as its
 * scope target. A CATEGORY, a shared modifier group and a discount definition
 * are operator-wide: `product_category` and `modifier_group` carry no branch
 * column at all, and a discount's branch is nullable with null meaning every
 * branch. Those routes declare no target and each loads the row inside the
 * caller's operator first, which is the other half of SCRUM-290.
 *
 * The import is branch-scoped for the same reason: its items land on that
 * branch. Its Categories sheet writes operator-wide rows, and the preview says
 * so before anything is written.
 */

const BranchParams = z.object({ branchId: z.string().uuid() });
const IdParams = z.object({ id: z.string().uuid() });

/** A workbook of a few hundred rows, base64, with room to spare. */
const IMPORT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The branch in the URL belongs to the caller's operator, or it is not found.
 *
 * The same door `routes/catalog.ts` opens with, and for the reason written
 * there: an operator-scoped grant matches on the operator alone, so the guard
 * says yes to whatever branch id the path happens to name.
 */
async function loadMenuBranch(app: App, branchId: string, operatorId: string) {
  const [row] = await app.db
    .select()
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return row;
}

const ImportBody = z.object({
  /** What the file was called, for the audit row. */
  filename: z.string().min(1).max(255),
  /** The .xlsx itself. There is no multipart parser on this api, and a menu
   *  workbook is small enough that adding one would be the larger change. */
  contentBase64: z.string().min(1),
});

/**
 * An item belongs to a category, and the API says so rather than storing one
 * that cannot be reached.
 *
 * `product.category_id` is nullable — the sale ledger points at rows that
 * predate the menu, and a withdrawn category has to leave its items
 * referenceable — but the sell surface is built from the category tree: an item
 * with none appears under no tab on the till, in no section of the shop and in
 * no export row, so creating one through the form was a silent way of making an
 * item nobody could find. The import has always required it
 * (`menu-sheet.ts`: "A category is required on a new item"); this is the same
 * rule on the other door.
 */
function requireItemCategory(categoryId: string | null | undefined): string {
  if (!categoryId) {
    throw errors.badRequest(
      'An item needs a category — it is the tab it appears under on the till, ' +
        'and an item without one is on no tab at all',
      { field: 'categoryId' },
    );
  }
  return categoryId;
}

function decodeWorkbook(contentBase64: string): Buffer {
  const file = Buffer.from(contentBase64, 'base64');
  if (file.length === 0) throw errors.badRequest('That file is empty');
  // `PK` — every .xlsx is a zip archive. A .csv or a .xls saved with the wrong
  // extension is the likely case, and it deserves the sentence rather than a
  // parser stack trace.
  if (file[0] !== 0x50 || file[1] !== 0x4b) {
    throw errors.badRequest(
      'That file is not an .xlsx workbook. Export the menu, edit that file and save it as .xlsx — a .csv will not do.',
    );
  }
  return file;
}

export async function menuRoutes(app: App): Promise<void> {
  // --- The menu, whole ------------------------------------------------------
  app.get(
    '/branches/:branchId/menu',
    {
      config: { permission: 'catalog:menu:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'The branch menu: categories, items and the modifier library',
        params: BranchParams,
        querystring: z.object({ includeArchived: z.coerce.boolean().default(false) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadMenuBranch(app, req.params.branchId, auth.operatorId);
      const snapshot = await readMenu(app.db, {
        operatorId: auth.operatorId,
        branchId: req.params.branchId,
        includeArchived: req.query.includeArchived,
      });
      const menu = presentMenu(snapshot);
      // S2-14b — each item's stock links at THIS branch, both ways: the item
      // names the stock items that stock it, one per size.
      const links = await productStockLinks(
        app.db,
        req.params.branchId,
        menu.products.map((p) => p.id),
      );
      return {
        ...menu,
        products: menu.products.map((p) => ({ ...p, stockLinks: links.get(p.id) ?? [] })),
      };
    },
  );

  // --- Categories (operator-wide) -------------------------------------------
  app.post(
    '/menu/categories',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: { description: 'Create a menu category', body: MenuCategoryBodySchema },
    },
    async (req) => {
      const auth = req.requireAuth();
      const body = req.body;
      assertTopLevelHasTaxableArea(body);
      await assertCategoryDepth(app.db, auth.operatorId, null, body.parentId ?? null);
      await assertCategoryCodeFree(app.db, auth.operatorId, body.code);
      const id = newId();
      return withTx(app.db, opCtx(req), 'menu_category.create', async (tx) => {
        await tx.insert(productCategory).values({
          id,
          operatorId: auth.operatorId,
          code: body.code ?? null,
          name: body.name,
          parentId: body.parentId ?? null,
          taxableCategory: body.taxableCategory ?? null,
          defaultPrepStation: body.defaultPrepStation ?? null,
          sortOrder: body.sortOrder,
          translations: body.translations ?? null,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'menu_category.create',
          entityType: 'product_category',
          entityId: id,
          after: body,
          requestId: req.id,
        });
        return { id };
      });
    },
  );

  app.patch(
    '/menu/categories/:id',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: {
        description: 'Update a menu category',
        params: IdParams,
        body: MenuCategoryBodySchema.partial(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadMenuCategory(app.db, auth.operatorId, req.params.id);
      const body = req.body;
      const parentId = body.parentId === undefined ? before.parentId : (body.parentId ?? null);
      assertTopLevelHasTaxableArea({
        parentId,
        taxableCategory:
          body.taxableCategory === undefined ? before.taxableCategory : body.taxableCategory,
      });
      if (body.parentId !== undefined) {
        await assertCategoryDepth(app.db, auth.operatorId, before.id, parentId);
      }
      if (body.code !== undefined) {
        await assertCategoryCodeFree(app.db, auth.operatorId, body.code, before.id);
      }
      return withTx(app.db, opCtx(req), 'menu_category.update', async (tx) => {
        const [after] = await tx
          .update(productCategory)
          .set({
            ...(body.code !== undefined ? { code: body.code } : {}),
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.parentId !== undefined ? { parentId } : {}),
            ...(body.taxableCategory !== undefined
              ? { taxableCategory: body.taxableCategory }
              : {}),
            ...(body.defaultPrepStation !== undefined
              ? { defaultPrepStation: body.defaultPrepStation }
              : {}),
            ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
            ...(body.translations !== undefined ? { translations: body.translations } : {}),
          })
          .where(eq(productCategory.id, before.id))
          .returning();
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'menu_category.update',
          entityType: 'product_category',
          entityId: before.id,
          before,
          after,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  app.delete(
    '/menu/categories/:id',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: {
        description: 'Withdraw a menu category (refused while items still sit in it)',
        params: IdParams,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadMenuCategory(app.db, auth.operatorId, req.params.id);
      const held = await categoryDependants(app.db, auth.operatorId, before.id);
      if (held.items > 0 || held.children > 0) {
        throw errors.conflict(
          'CATEGORY_IN_USE',
          `"${before.name}" still holds ${held.items} item${held.items === 1 ? '' : 's'} and ` +
            `${held.children} sub-categor${held.children === 1 ? 'y' : 'ies'} — move or withdraw those first`,
          held,
        );
      }
      return withTx(app.db, opCtx(req), 'menu_category.archive', async (tx) => {
        await tx
          .update(productCategory)
          .set({ archivedAt: new Date() })
          .where(eq(productCategory.id, before.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'menu_category.archive',
          entityType: 'product_category',
          entityId: before.id,
          before,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  // --- Items (branch-owned) -------------------------------------------------
  app.post(
    '/branches/:branchId/menu/products',
    {
      config: { permission: 'catalog:menu:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Create a menu item, shop item or ticket add-on',
        params: BranchParams,
        body: MenuItemBodySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadMenuBranch(app, req.params.branchId, auth.operatorId);
      const body = req.body;
      const categoryId = requireItemCategory(body.categoryId);
      await loadMenuCategory(app.db, auth.operatorId, categoryId);
      await assertItemCodeFree(app.db, auth.operatorId, body.code);
      await assertLibraryGroups(app.db, auth.operatorId, body.modifierGroupIds ?? []);
      // The sizes (S2-09b): the rules about the item itself first, then — in
      // the transaction, behind the barcode lock — whether a barcode on it is
      // already on another live item.
      const variants = normaliseVariants(body.variants ?? []);
      assertVariantsWellFormed(body.name, variants, body.sku ?? null);
      const id = newId();
      return withTx(app.db, opCtx(req), 'menu_item.create', async (tx) => {
        await assertBarcodesFree(tx, auth.operatorId, { id: null, sku: body.sku ?? null, variants });
        await tx.insert(product).values({
          id,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          categoryId,
          kind: body.kind,
          code: body.code ?? null,
          name: body.name,
          description: body.description ?? null,
          priceSatang: body.priceSatang,
          priceWeekendSatang: body.priceWeekendSatang ?? null,
          costSatang: body.costSatang ?? null,
          prepStationOverride: body.prepStationOverride ?? null,
          taxCategoryOverride: body.taxCategoryOverride ?? null,
          translations: body.translations ?? null,
          sku: body.sku ?? null,
          variants,
          sortOrder: body.sortOrder,
          active: body.active,
        });
        if (body.modifierGroupIds) {
          await setItemModifierGroups(tx, auth.operatorId, id, body.modifierGroupIds);
        }
        if (body.stockLinks) {
          const [created] = await tx.select().from(product).where(eq(product.id, id)).limit(1);
          await setProductStockLinks(
            tx,
            { operatorId: auth.operatorId, branchId: req.params.branchId, accountId: auth.accountId, requestId: req.id },
            created!,
            body.stockLinks,
          );
        }
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'menu_item.create',
          entityType: 'product',
          entityId: id,
          after: body,
          requestId: req.id,
        });
        return { id };
      });
    },
  );

  app.patch(
    '/branches/:branchId/menu/products/:id',
    {
      config: { permission: 'catalog:menu:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Update a menu item',
        params: BranchParams.extend({ id: z.string().uuid() }),
        body: MenuItemBodySchema.partial(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadMenuBranch(app, req.params.branchId, auth.operatorId);
      const before = await loadMenuItem(app.db, auth.operatorId, req.params.id);
      const body = req.body;
      // The same rule as the create: an item may be MOVED between categories,
      // never emptied out of one, because an item in no category is on no tab.
      if (body.categoryId !== undefined) {
        await loadMenuCategory(app.db, auth.operatorId, requireItemCategory(body.categoryId));
      }
      if (body.code !== undefined) {
        await assertItemCodeFree(app.db, auth.operatorId, body.code, before.id);
      }
      if (body.modifierGroupIds) {
        await assertLibraryGroups(app.db, auth.operatorId, body.modifierGroupIds);
      }
      // The sizes and the item's own barcode are checked as the row WILL be:
      // what the body changes, over what the row already holds. Either one
      // changing can make a barcode name two things, so either triggers it.
      const variants = body.variants !== undefined ? normaliseVariants(body.variants) : null;
      const barcodesMove = variants !== null || body.sku !== undefined;
      const skuAfter = body.sku !== undefined ? (body.sku ?? null) : before.sku;
      const variantsAfter = variants ?? before.variants;
      if (barcodesMove) {
        assertVariantsWellFormed(body.name ?? before.name, variantsAfter, skuAfter);
      }
      return withTx(app.db, opCtx(req), 'menu_item.update', async (tx) => {
        if (barcodesMove) {
          await assertBarcodesFree(tx, auth.operatorId, {
            id: before.id,
            sku: skuAfter,
            variants: variantsAfter,
          });
        }
        const [after] = await tx
          .update(product)
          .set({
            // Always set, so a body carrying only modifierGroupIds is still a
            // statement with a column in it: Drizzle refuses an empty SET with a
            // 500, and the row WAS touched — its links changed.
            updatedAt: new Date(),
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.code !== undefined ? { code: body.code } : {}),
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
            ...(body.priceSatang !== undefined ? { priceSatang: body.priceSatang } : {}),
            ...(body.priceWeekendSatang !== undefined
              ? { priceWeekendSatang: body.priceWeekendSatang }
              : {}),
            ...(body.costSatang !== undefined ? { costSatang: body.costSatang } : {}),
            ...(body.prepStationOverride !== undefined
              ? { prepStationOverride: body.prepStationOverride }
              : {}),
            ...(body.taxCategoryOverride !== undefined
              ? { taxCategoryOverride: body.taxCategoryOverride }
              : {}),
            ...(body.translations !== undefined ? { translations: body.translations } : {}),
            ...(body.sku !== undefined ? { sku: body.sku } : {}),
            ...(variants !== null ? { variants } : {}),
            ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
            ...(body.active !== undefined ? { active: body.active } : {}),
          })
          .where(eq(product.id, before.id))
          .returning();
        if (body.modifierGroupIds) {
          await setItemModifierGroups(tx, auth.operatorId, before.id, body.modifierGroupIds);
        }
        // S2-14b — the stock links at this branch, when the body carries them;
        // checked against the sizes the row holds now.
        if (body.stockLinks && after) {
          await setProductStockLinks(
            tx,
            { operatorId: auth.operatorId, branchId: req.params.branchId, accountId: auth.accountId, requestId: req.id },
            after,
            body.stockLinks,
          );
        }
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'menu_item.update',
          entityType: 'product',
          entityId: before.id,
          before,
          after,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  app.delete(
    '/branches/:branchId/menu/products/:id',
    {
      config: { permission: 'catalog:menu:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Withdraw a menu item — it stays readable by the orders that sold it',
        params: BranchParams.extend({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadMenuBranch(app, req.params.branchId, auth.operatorId);
      const before = await loadMenuItem(app.db, auth.operatorId, req.params.id);
      return withTx(app.db, opCtx(req), 'menu_item.archive', async (tx) => {
        await tx
          .update(product)
          .set({ archivedAt: new Date(), active: false })
          .where(eq(product.id, before.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          action: 'menu_item.archive',
          entityType: 'product',
          entityId: before.id,
          before,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  // --- The shared modifier library (operator-wide) --------------------------
  app.post(
    '/menu/modifier-groups',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: {
        description: 'Create a modifier group and its options',
        body: ModifierGroupBodySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const body = req.body;
      if (body.productId) await loadMenuItem(app.db, auth.operatorId, body.productId);
      const id = newId();
      return withTx(app.db, opCtx(req), 'modifier_group.create', async (tx) => {
        await tx.insert(modifierGroup).values({
          id,
          operatorId: auth.operatorId,
          productId: body.productId ?? null,
          name: body.name,
          required: body.required,
          selectionType: body.selectionType,
          minSelect: body.minSelect ?? null,
          maxSelect: body.maxSelect ?? null,
          sortOrder: body.sortOrder,
          translations: body.translations ?? null,
        });
        await replaceOptions(tx, auth.operatorId, id, body.options ?? []);
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'modifier_group.create',
          entityType: 'modifier_group',
          entityId: id,
          after: body,
          requestId: req.id,
        });
        return { id };
      });
    },
  );

  app.patch(
    '/menu/modifier-groups/:id',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: {
        description: 'Update a modifier group; `options` replaces the whole answer list',
        params: IdParams,
        body: ModifierGroupBodySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadModifierGroup(app.db, auth.operatorId, req.params.id);
      const body = req.body;
      return withTx(app.db, opCtx(req), 'modifier_group.update', async (tx) => {
        const [after] = await tx
          .update(modifierGroup)
          .set({
            name: body.name,
            required: body.required,
            selectionType: body.selectionType,
            minSelect: body.minSelect ?? null,
            maxSelect: body.maxSelect ?? null,
            sortOrder: body.sortOrder,
            translations: body.translations ?? null,
          })
          .where(eq(modifierGroup.id, before.id))
          .returning();
        if (body.options) await replaceOptions(tx, auth.operatorId, before.id, body.options);
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'modifier_group.update',
          entityType: 'modifier_group',
          entityId: before.id,
          before,
          after,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  app.delete(
    '/menu/modifier-groups/:id',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: { description: 'Withdraw a modifier group', params: IdParams },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadModifierGroup(app.db, auth.operatorId, req.params.id);
      return withTx(app.db, opCtx(req), 'modifier_group.archive', async (tx) => {
        const now = new Date();
        await tx
          .update(modifierGroup)
          .set({ archivedAt: now })
          .where(eq(modifierGroup.id, before.id));
        await tx
          .update(modifierOption)
          .set({ archivedAt: now })
          .where(eq(modifierOption.modifierGroupId, before.id));
        // The links are configuration rather than a business record, so they go
        // rather than linger pointing at a group no screen will offer. Keyed on
        // the GROUP: `setItemModifierGroups` deletes `where product_id = …`, so
        // handing it a group id matched nothing and every link stayed.
        await clearModifierGroupLinks(tx, auth.operatorId, before.id);
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'modifier_group.archive',
          entityType: 'modifier_group',
          entityId: before.id,
          before,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  // --- Discount codes (operator-wide) ---------------------------------------
  app.get(
    '/menu/discounts',
    {
      config: { permission: 'catalog:menu:read' },
      schema: {
        description:
          'Discount code definitions, each with `usedCount`: the finalised sales that carried the code since the ' +
          'definition was created — the count its usage limit is held to.',
        querystring: z.object({ includeArchived: z.coerce.boolean().default(false) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const d = discountDefinition;
      const rows = await app.db
        .select({
          ...getTableColumns(d),
          // S2-15b round 6 closing sweep: the prototype's catalog counter
          // (`Discount.usedCount`), which the Wallet & Promo report shows beside
          // the limit. Counted from the sales as the limit is
          // (`promo-codes.ts` finalisedUses), never kept as a counter.
          // Named in full: drizzle writes a column of a one-table select
          // unqualified, which the subquery's own tables would capture.
          usedCount: sql<number>`(
            select count(distinct sd.sale_id)::int
              from pos.sale_discount sd
              join pos.sale s on s.id = sd.sale_id
             where sd.operator_id = "discount_definition"."operator_id"
               and sd.kind = 'promo'
               and sd.code = "discount_definition"."code"
               and sd.created_at >= "discount_definition"."created_at"
               and s.status = 'finalised')`.mapWith(Number),
        })
        .from(d)
        .where(
          req.query.includeArchived
            ? eq(d.operatorId, auth.operatorId)
            : and(eq(d.operatorId, auth.operatorId), isNull(d.archivedAt)),
        );
      return { discounts: rows };
    },
  );

  app.post(
    '/menu/discounts',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: { description: 'Create a discount code', body: DiscountDefinitionBodySchema },
    },
    async (req) => {
      const auth = req.requireAuth();
      const body = req.body;
      if (body.branchId) await loadMenuBranch(app, body.branchId, auth.operatorId);
      if (body.freeProductId) await loadMenuItem(app.db, auth.operatorId, body.freeProductId);
      const id = newId();
      return withTx(app.db, opCtx(req), 'discount_definition.create', async (tx) => {
        await tx.insert(discountDefinition).values({
          id,
          operatorId: auth.operatorId,
          branchId: body.branchId ?? null,
          code: body.code,
          label: body.label,
          kind: body.kind,
          valueBp: body.valueBp ?? null,
          valueSatang: body.valueSatang ?? null,
          freeProductId: body.freeProductId ?? null,
          target: body.target ?? null,
          validFrom: body.validFrom ?? null,
          validUntil: body.validUntil ?? null,
          usageLimit: body.usageLimit ?? null,
          perCustomerLimit: body.perCustomerLimit ?? null,
          stackable: body.stackable,
          active: body.active,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'discount_definition.create',
          entityType: 'discount_definition',
          entityId: id,
          after: body,
          requestId: req.id,
        });
        return { id };
      });
    },
  );

  app.patch(
    '/menu/discounts/:id',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: {
        description: 'Update a discount code',
        params: IdParams,
        body: DiscountDefinitionBodySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadDiscountDefinition(app.db, auth.operatorId, req.params.id);
      const body = req.body;
      if (body.branchId) await loadMenuBranch(app, body.branchId, auth.operatorId);
      if (body.freeProductId) await loadMenuItem(app.db, auth.operatorId, body.freeProductId);
      return withTx(app.db, opCtx(req), 'discount_definition.update', async (tx) => {
        const [after] = await tx
          .update(discountDefinition)
          .set({
            branchId: body.branchId ?? null,
            code: body.code,
            label: body.label,
            kind: body.kind,
            valueBp: body.valueBp ?? null,
            valueSatang: body.valueSatang ?? null,
            freeProductId: body.freeProductId ?? null,
            target: body.target ?? null,
            validFrom: body.validFrom ?? null,
            validUntil: body.validUntil ?? null,
            usageLimit: body.usageLimit ?? null,
            perCustomerLimit: body.perCustomerLimit ?? null,
            stackable: body.stackable,
            active: body.active,
          })
          .where(eq(discountDefinition.id, before.id))
          .returning();
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'discount_definition.update',
          entityType: 'discount_definition',
          entityId: before.id,
          before,
          after,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  app.delete(
    '/menu/discounts/:id',
    {
      config: { permission: 'catalog:menu:manage' },
      schema: { description: 'Withdraw a discount code', params: IdParams },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadDiscountDefinition(app.db, auth.operatorId, req.params.id);
      return withTx(app.db, opCtx(req), 'discount_definition.archive', async (tx) => {
        await tx
          .update(discountDefinition)
          .set({ archivedAt: new Date(), active: false })
          .where(eq(discountDefinition.id, before.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'discount_definition.archive',
          entityType: 'discount_definition',
          entityId: before.id,
          before,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  // --- Export ---------------------------------------------------------------
  /**
   * Guarded by `manage` rather than `read`: the workbook carries the `cost`
   * column, which is the park's margin on every line, and it exists to be
   * edited. Reading the menu to sell from it is `GET …/menu` above, which
   * reception holds.
   */
  app.get(
    '/branches/:branchId/menu/export.xlsx',
    {
      config: { permission: 'catalog:menu:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'The menu as an .xlsx workbook — and, on an empty menu, the blank template',
        params: BranchParams,
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const br = await loadMenuBranch(app, req.params.branchId, auth.operatorId);
      const snapshot = await readMenu(app.db, {
        operatorId: auth.operatorId,
        branchId: req.params.branchId,
      });
      const file = await buildMenuWorkbook(snapshot);
      const slug = br.code || 'menu';
      // The branch's own calendar day, not UTC. A download at 8am in Phuket is
      // still the previous date in UTC, so two mornings' exports would land in
      // the same folder under one filename and the second would overwrite the
      // first — and the file would be dated the day before the menu it holds.
      const day = branchToday(br.timezone);
      return reply
        .header('content-disposition', `attachment; filename="oto-menu-${slug}-${day}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(file);
    },
  );

  // --- Import, in two steps -------------------------------------------------
  /**
   * Step one. Parses, validates and diffs, and **writes nothing** — which is
   * why this route is named in the no-write list of
   * `test/route-write-conformance.test.ts` beside the cart quote and the print
   * preview. Nothing is applied without the second call.
   */
  app.post(
    '/branches/:branchId/menu/import/preview',
    {
      bodyLimit: IMPORT_MAX_BYTES,
      config: { permission: 'catalog:menu:import', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'What this workbook would do to the menu. Writes nothing.',
        params: BranchParams,
        body: ImportBody,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadMenuBranch(app, req.params.branchId, auth.operatorId);
      const file = decodeWorkbook(req.body.contentBase64);
      const parsed = await parseMenuWorkbook(file);
      const snapshot = await readMenu(app.db, {
        operatorId: auth.operatorId,
        branchId: req.params.branchId,
        includeArchived: true,
      });
      const plan = planMenuImport(
        parsed,
        snapshot,
        { operatorId: auth.operatorId, branchId: req.params.branchId },
        req.body.filename,
      );
      return plan.preview;
    },
  );

  /**
   * Step two. The same file, plus the token the preview answered with.
   *
   * A bad row refuses the whole file: a menu is one document, and a
   * half-applied import leaves nobody able to say which four prices landed and
   * which three did not.
   */
  app.post(
    '/branches/:branchId/menu/import/commit',
    {
      bodyLimit: IMPORT_MAX_BYTES,
      config: { permission: 'catalog:menu:import', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Apply a previewed workbook, in one transaction',
        params: BranchParams,
        body: ImportBody.extend({ previewToken: z.string().min(1).max(128) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadMenuBranch(app, req.params.branchId, auth.operatorId);
      const file = decodeWorkbook(req.body.contentBase64);
      const parsed = await parseMenuWorkbook(file);
      const scope = { operatorId: auth.operatorId, branchId: req.params.branchId };
      const snapshot = await readMenu(app.db, { ...scope, includeArchived: true });
      const plan = planMenuImport(parsed, snapshot, scope, req.body.filename);

      if (plan.preview.errors.length > 0) {
        throw errors.badRequest(
          `This workbook has ${plan.preview.errors.length} problem${
            plan.preview.errors.length === 1 ? '' : 's'
          }, so none of it was applied. Fix the rows listed and import it again.`,
          { errors: plan.preview.errors },
        );
      }
      assertPreviewStillTrue(req.body.previewToken, plan.preview.previewToken);

      return withTx(app.db, opCtx(req), 'menu.import', async (tx) => {
        // Re-read inside the transaction and check the menu again: between the
        // read above and this line somebody else's write can land, and the
        // counts being confirmed would then describe a menu that no longer
        // exists. `MENU_CHANGED` is the honest answer to that, not a merge.
        const fresh = await readMenu(app.db, { ...scope, includeArchived: true });
        if (menuDigest(fresh) !== menuDigest(snapshot)) {
          assertPreviewStillTrue(
            req.body.previewToken,
            planMenuImport(parsed, fresh, scope, req.body.filename).preview.previewToken,
          );
        }
        const result = await applyMenuImport(
          tx,
          {
            operatorId: auth.operatorId,
            branchId: req.params.branchId,
            actorAccountId: auth.accountId,
            requestId: req.id,
            filename: req.body.filename,
          },
          plan,
          snapshot,
        );
        return result;
      });
    },
  );
}

/** A group's answers are edited as a set, the way the prototype's form does. */
async function replaceOptions(
  tx: Parameters<Parameters<App['db']['transaction']>[0]>[0],
  operatorId: string,
  groupId: string,
  options: Array<{
    name: string;
    priceSatang: number;
    priceWeekendSatang?: number | null;
    costSatang?: number | null;
    sortOrder: number;
    translations?: unknown;
  }>,
): Promise<void> {
  await tx
    .update(modifierOption)
    .set({ archivedAt: new Date() })
    .where(
      and(eq(modifierOption.modifierGroupId, groupId), isNull(modifierOption.archivedAt)),
    );
  if (options.length === 0) return;
  await tx.insert(modifierOption).values(
    options.map((o, index) => ({
      id: newId(),
      operatorId,
      modifierGroupId: groupId,
      name: o.name,
      priceSatang: o.priceSatang,
      priceWeekendSatang: o.priceWeekendSatang ?? null,
      costSatang: o.costSatang ?? null,
      sortOrder: o.sortOrder || index,
      translations: (o.translations ?? null) as never,
    })),
  );
}
