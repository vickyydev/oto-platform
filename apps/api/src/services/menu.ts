import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  discountDefinition,
  modifierGroup,
  modifierOption,
  product,
  productCategory,
  productModifierGroup,
  type Db,
} from '@oto/db';
import type { PrepStation, TaxableCategory } from '@oto/shared';
import { errors } from '../lib/errors';
import type { Exec } from './tx';

/**
 * The menu (SCRUM-232, SCRUM-204).
 *
 * Until this file existed the menu had no backend at all: `product` was a
 * five-field placeholder, the admin panels ran on `useCatalogStore` in the
 * browser and said so on the screen. What is here is the prototype's own
 * behaviour moved to the server — the inheritance rules in `lib/menu.ts`, the
 * two-level category tree in `types.ts:717-729`, the inline/library split in
 * `types.ts:742-762` — plus the two things persistence forces and the browser
 * never needed: a stable code to match a row on, and withdrawal instead of
 * deletion.
 *
 * **Who owns what, and why.** A category, a shared modifier group and a
 * discount definition are OPERATOR-wide: `product_category` and
 * `modifier_group` carry no `branch_id` at all, and a discount's branch is
 * nullable with null meaning every branch. An ITEM is branch-owned —
 * `product.branch_id` — because a price is a thing one park charges. So the
 * item routes hang off `/branches/:branchId/…` and take a branch target, and
 * the rest do not; each of those establishes the caller's operator itself
 * before it touches a row.
 */

export type CategoryRow = typeof productCategory.$inferSelect;
export type ItemRow = typeof product.$inferSelect;
export type GroupRow = typeof modifierGroup.$inferSelect;
export type OptionRow = typeof modifierOption.$inferSelect;
export type DiscountRow = typeof discountDefinition.$inferSelect;

// --- Loaders -----------------------------------------------------------------
// Every one takes the caller's operator and answers "not found" for a row
// outside it, so a by-id route cannot act on another tenant's menu (SCRUM-290).

export async function loadMenuCategory(
  db: Exec,
  operatorId: string,
  id: string,
): Promise<CategoryRow> {
  const [row] = await db
    .select()
    .from(productCategory)
    .where(and(eq(productCategory.id, id), eq(productCategory.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Menu category not found');
  return row;
}

export async function loadMenuItem(db: Exec, operatorId: string, id: string): Promise<ItemRow> {
  const [row] = await db
    .select()
    .from(product)
    .where(and(eq(product.id, id), eq(product.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Menu item not found');
  return row;
}

export async function loadModifierGroup(
  db: Exec,
  operatorId: string,
  id: string,
): Promise<GroupRow> {
  const [row] = await db
    .select()
    .from(modifierGroup)
    .where(and(eq(modifierGroup.id, id), eq(modifierGroup.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Modifier group not found');
  return row;
}

export async function loadDiscountDefinition(
  db: Exec,
  operatorId: string,
  id: string,
): Promise<DiscountRow> {
  const [row] = await db
    .select()
    .from(discountDefinition)
    .where(and(eq(discountDefinition.id, id), eq(discountDefinition.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Discount code not found');
  return row;
}

// --- The prototype's resolvers, ported ---------------------------------------
// `imports/oto-pos/artifacts/oto-till/src/lib/menu.ts:52-136`. Pure functions
// over rows, so the read model, the import validator and a later print-routing
// ticket all resolve a station the same way rather than three ways.

/** Top-level categories (no parent), in tab order. */
export function topLevelCategories(categories: CategoryRow[]): CategoryRow[] {
  return categories.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** The sub-categories of one parent, in their per-parent order. */
export function subCategoriesOf(parentId: string, categories: CategoryRow[]): CategoryRow[] {
  return categories.filter((c) => c.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * A category's effective prep station: its own when set, else its parent's.
 * Undefined only when nothing in the chain sets one.
 */
export function categoryPrepStation(
  category: CategoryRow | undefined,
  categories: CategoryRow[],
): PrepStation | undefined {
  if (!category) return undefined;
  if (category.defaultPrepStation) return category.defaultPrepStation;
  if (category.parentId) {
    return categories.find((c) => c.id === category.parentId)?.defaultPrepStation ?? undefined;
  }
  return undefined;
}

/** The same walk for the taxable area (`lib/menu.ts:68-78`). */
export function categoryTaxCategory(
  category: CategoryRow | undefined,
  categories: CategoryRow[],
): TaxableCategory | undefined {
  if (!category) return undefined;
  if (category.taxableCategory) return category.taxableCategory;
  if (category.parentId) {
    return categories.find((c) => c.id === category.parentId)?.taxableCategory ?? undefined;
  }
  return undefined;
}

/**
 * Where this item's prep ticket prints: the item's override, else its
 * (sub)category's, else its parent's, else `kitchen` — the prototype's own
 * fallback at `lib/menu.ts:85-94`.
 */
export function effectivePrepStation(item: ItemRow, categories: CategoryRow[]): PrepStation {
  return (
    item.prepStationOverride ??
    categoryPrepStation(
      categories.find((c) => c.id === item.categoryId),
      categories,
    ) ??
    'kitchen'
  );
}

/**
 * Which taxable area the item falls under, same walk, falling back to `fnb`
 * (`lib/menu.ts:101-110`).
 *
 * `services/tax.ts` resolves the same chain from the database for a single
 * product, because the tax route is given one id and no snapshot. This is the
 * snapshot form, for the menu read and the import — the two of them agree
 * because they are the same three steps in the same order.
 */
export function effectiveTaxCategory(item: ItemRow, categories: CategoryRow[]): TaxableCategory {
  return (
    item.taxCategoryOverride ??
    categoryTaxCategory(
      categories.find((c) => c.id === item.categoryId),
      categories,
    ) ??
    'fnb'
  );
}

/**
 * Every modifier group that applies to an item: its INLINE groups first, then
 * the shared library groups it links, de-duplicated with inline winning
 * (`lib/menu.ts:120-136`).
 */
export function effectiveModifierGroups(
  itemId: string,
  inline: GroupRow[],
  links: Array<{ productId: string; modifierGroupId: string; sortOrder: number }>,
  library: GroupRow[],
): GroupRow[] {
  const own = inline.filter((g) => g.productId === itemId).sort((a, b) => a.sortOrder - b.sortOrder);
  const seen = new Set(own.map((g) => g.id));
  const linked: GroupRow[] = [];
  for (const link of links
    .filter((l) => l.productId === itemId)
    .sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (seen.has(link.modifierGroupId)) continue;
    const group = library.find((g) => g.id === link.modifierGroupId);
    if (group) {
      linked.push(group);
      seen.add(group.id);
    }
  }
  return [...own, ...linked];
}

// --- The read model ----------------------------------------------------------

export interface MenuReadOptions {
  operatorId: string;
  /** Items for this branch, plus any that belong to no branch in particular. */
  branchId: string;
  includeArchived?: boolean;
}

export interface MenuSnapshot {
  categories: CategoryRow[];
  items: ItemRow[];
  /** Groups inline to an item, plus the shared library (`productId` null). */
  groups: GroupRow[];
  options: OptionRow[];
  links: Array<{ productId: string; modifierGroupId: string; sortOrder: number }>;
}

/**
 * Every row the menu screens, the export and the import validator read.
 *
 * `includeArchived` widens the categories and the items. The modifier library
 * is always live rows only: a withdrawn group is offered on no screen, and a
 * group's options are replaced as a set when it is edited — so the archived
 * ones are previous versions of the same question rather than answers anybody
 * can still choose.
 */
export async function readMenu(db: Db, opts: MenuReadOptions): Promise<MenuSnapshot> {
  const categories = await db
    .select()
    .from(productCategory)
    .where(
      opts.includeArchived
        ? eq(productCategory.operatorId, opts.operatorId)
        : and(eq(productCategory.operatorId, opts.operatorId), isNull(productCategory.archivedAt)),
    )
    .orderBy(asc(productCategory.sortOrder), asc(productCategory.name));

  const branchScope = or(eq(product.branchId, opts.branchId), isNull(product.branchId));
  const items = await db
    .select()
    .from(product)
    .where(
      opts.includeArchived
        ? and(eq(product.operatorId, opts.operatorId), branchScope)
        : and(eq(product.operatorId, opts.operatorId), branchScope, isNull(product.archivedAt)),
    )
    .orderBy(asc(product.sortOrder), asc(product.name));

  const groups = await db
    .select()
    .from(modifierGroup)
    .where(and(eq(modifierGroup.operatorId, opts.operatorId), isNull(modifierGroup.archivedAt)))
    .orderBy(asc(modifierGroup.sortOrder), asc(modifierGroup.name));

  const groupIds = groups.map((g) => g.id);
  const options = groupIds.length
    ? await db
        .select()
        .from(modifierOption)
        .where(
          and(inArray(modifierOption.modifierGroupId, groupIds), isNull(modifierOption.archivedAt)),
        )
        .orderBy(asc(modifierOption.sortOrder), asc(modifierOption.name))
    : [];

  const itemIds = items.map((i) => i.id);
  const links = itemIds.length
    ? await db
        .select({
          productId: productModifierGroup.productId,
          modifierGroupId: productModifierGroup.modifierGroupId,
          sortOrder: productModifierGroup.sortOrder,
        })
        .from(productModifierGroup)
        .where(
          and(
            eq(productModifierGroup.operatorId, opts.operatorId),
            inArray(productModifierGroup.productId, itemIds),
          ),
        )
    : [];

  return { categories, items, groups, options, links };
}

/**
 * The shape the admin catalogue screens read, in one round trip.
 *
 * Flat rather than nested, mirroring the tables: `modifierGroups` carries the
 * shared library AND every item's inline groups, told apart by `productId`,
 * and a product names the library groups it links by id. That is the contract
 * `apps/pos/src/api/menu.ts` was written against, and the resolved values the
 * prototype computes in the browser are added beside each row rather than
 * instead of it.
 */
export function presentMenu(snapshot: MenuSnapshot) {
  const { categories, items, groups, options, links } = snapshot;
  const optionsOf = (groupId: string) => options.filter((o) => o.modifierGroupId === groupId);
  const presentGroup = (g: GroupRow) => ({
    id: g.id,
    productId: g.productId,
    name: g.name,
    required: g.required,
    selectionType: g.selectionType,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    sortOrder: g.sortOrder,
    translations: g.translations,
    options: optionsOf(g.id).map((o) => ({
      id: o.id,
      name: o.name,
      priceSatang: o.priceSatang,
      priceWeekendSatang: o.priceWeekendSatang,
      costSatang: o.costSatang,
      sortOrder: o.sortOrder,
      translations: o.translations,
    })),
  });

  return {
    categories: categories.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      parentId: c.parentId,
      taxableCategory: c.taxableCategory,
      defaultPrepStation: c.defaultPrepStation,
      /** What the category resolves to once inheritance is applied. */
      effectiveTaxCategory: categoryTaxCategory(c, categories) ?? null,
      effectivePrepStation: categoryPrepStation(c, categories) ?? null,
      sortOrder: c.sortOrder,
      translations: c.translations,
      archivedAt: c.archivedAt,
    })),
    modifierGroups: groups.map(presentGroup),
    products: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      code: i.code,
      name: i.name,
      description: i.description,
      categoryId: i.categoryId,
      branchId: i.branchId,
      priceSatang: i.priceSatang,
      /** Null on the row means "the same as weekday"; the resolved figure is here. */
      priceWeekendSatang: i.priceWeekendSatang,
      effectiveWeekendSatang: i.priceWeekendSatang ?? i.priceSatang,
      costSatang: i.costSatang,
      prepStationOverride: i.prepStationOverride,
      taxCategoryOverride: i.taxCategoryOverride,
      effectivePrepStation: effectivePrepStation(i, categories),
      effectiveTaxCategory: effectiveTaxCategory(i, categories),
      sku: i.sku,
      stockItemId: i.stockItemId,
      sortOrder: i.sortOrder,
      active: i.active,
      translations: i.translations,
      archivedAt: i.archivedAt,
      /** The shared library groups this item asks, in order (`lib/menu.ts:120-136`). */
      linkedModifierGroupIds: effectiveModifierGroups(
        i.id,
        groups.filter((g) => g.productId !== null),
        links,
        groups.filter((g) => g.productId === null),
      )
        .filter((g) => g.productId === null)
        .map((g) => g.id),
    })),
  };
}

// --- Rules -------------------------------------------------------------------

/**
 * Two levels, never three (`types.ts:717-729`).
 *
 * The database refuses only a category that parents itself, because a depth
 * rule is a walk the schema cannot express as a check. This is where it is
 * held: the named parent must exist inside the caller's operator and must
 * itself be top-level, and a category that already has children cannot be
 * given a parent of its own.
 */
export async function assertCategoryDepth(
  db: Exec,
  operatorId: string,
  categoryId: string | null,
  parentId: string | null | undefined,
): Promise<void> {
  if (!parentId) return;
  if (categoryId && parentId === categoryId) {
    throw errors.badRequest('A category cannot be its own parent');
  }
  const parent = await loadMenuCategory(db, operatorId, parentId);
  if (parent.parentId) {
    throw errors.badRequest(
      `"${parent.name}" is already a sub-category, and the menu is two levels deep — ` +
        'pick one of the top-level tabs as the parent',
    );
  }
  if (!categoryId) return;
  const children = await db
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(
      and(
        eq(productCategory.operatorId, operatorId),
        eq(productCategory.parentId, categoryId),
        isNull(productCategory.archivedAt),
      ),
    )
    .limit(1);
  if (children.length > 0) {
    throw errors.badRequest(
      'This category has sub-categories of its own, so it cannot become a sub-category — ' +
        'move or withdraw its children first',
    );
  }
}

/**
 * A top-level category carries a concrete taxable area; a sub-category may
 * leave it blank to inherit. The database holds the same line — this is the
 * half that can say which field and why.
 */
export function assertTopLevelHasTaxableArea(input: {
  parentId?: string | null;
  taxableCategory?: string | null;
}): void {
  if (!input.parentId && !input.taxableCategory) {
    throw errors.badRequest(
      'A top-level category sets the taxable area its items fall under — ' +
        'only a sub-category may leave it blank to inherit its parent’s',
    );
  }
}

/** What still points at a category, so archiving it can refuse rather than orphan. */
export async function categoryDependants(
  db: Exec,
  operatorId: string,
  categoryId: string,
): Promise<{ items: number; children: number }> {
  const items = await db
    .select({ id: product.id })
    .from(product)
    .where(
      and(
        eq(product.operatorId, operatorId),
        eq(product.categoryId, categoryId),
        isNull(product.archivedAt),
      ),
    );
  const children = await db
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(
      and(
        eq(productCategory.operatorId, operatorId),
        eq(productCategory.parentId, categoryId),
        isNull(productCategory.archivedAt),
      ),
    );
  return { items: items.length, children: children.length };
}

/**
 * The code is free, or it belongs to the row being edited.
 *
 * `product_code_unique` is partial on `code is not null and archived_at is
 * null`, so Postgres would refuse a live duplicate with a constraint violation
 * that reaches the screen as an unexplained 500. This turns it into a sentence
 * naming the item already holding it.
 */
export async function assertItemCodeFree(
  db: Exec,
  operatorId: string,
  code: string | null | undefined,
  exceptId?: string,
): Promise<void> {
  if (!code) return;
  const rows = await db
    .select({ id: product.id, name: product.name, kind: product.kind })
    .from(product)
    .where(
      and(eq(product.operatorId, operatorId), eq(product.code, code), isNull(product.archivedAt)),
    );
  const clash = rows.find((r) => r.id !== exceptId);
  if (clash) {
    throw errors.conflict(
      'MENU_CODE_IN_USE',
      `The code ${code} already belongs to "${clash.name}"`,
      { code, itemId: clash.id, kind: clash.kind },
    );
  }
}

/** The same, for a category code. */
export async function assertCategoryCodeFree(
  db: Exec,
  operatorId: string,
  code: string | null | undefined,
  exceptId?: string,
): Promise<void> {
  if (!code) return;
  const rows = await db
    .select({ id: productCategory.id, name: productCategory.name })
    .from(productCategory)
    .where(
      and(
        eq(productCategory.operatorId, operatorId),
        eq(productCategory.code, code),
        isNull(productCategory.archivedAt),
      ),
    );
  const clash = rows.find((r) => r.id !== exceptId);
  if (clash) {
    throw errors.conflict(
      'CATEGORY_CODE_IN_USE',
      `The code ${code} already belongs to the category "${clash.name}"`,
      { code, categoryId: clash.id },
    );
  }
}

/**
 * Library groups an item may link, by id, inside the caller's operator.
 *
 * A group with a `product_id` is inline to THAT item and is not the library's
 * to hand out, so linking one is refused rather than silently ignored.
 */
export async function assertLibraryGroups(
  db: Exec,
  operatorId: string,
  groupIds: string[],
): Promise<void> {
  if (groupIds.length === 0) return;
  const rows = await db
    .select({ id: modifierGroup.id, productId: modifierGroup.productId })
    .from(modifierGroup)
    .where(
      and(
        eq(modifierGroup.operatorId, operatorId),
        inArray(modifierGroup.id, groupIds),
        isNull(modifierGroup.archivedAt),
      ),
    );
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of groupIds) {
    const row = found.get(id);
    if (!row) throw errors.notFound(`Modifier group ${id} not found`);
    if (row.productId) {
      throw errors.badRequest(
        'That modifier group belongs to one item and is not in the shared library',
      );
    }
  }
}

/** Replace an item's links into the shared library with exactly this set. */
export async function setItemModifierGroups(
  tx: Exec,
  operatorId: string,
  productId: string,
  groupIds: string[],
): Promise<void> {
  await tx.delete(productModifierGroup).where(eq(productModifierGroup.productId, productId));
  if (groupIds.length === 0) return;
  await tx.insert(productModifierGroup).values(
    groupIds.map((modifierGroupId, sortOrder) => ({
      operatorId,
      productId,
      modifierGroupId,
      sortOrder,
    })),
  );
}
