import {
  MenuCategoryDef,
  MenuItem,
  ModifierGroup,
  PrepStation,
  TaxableCategory,
} from '@/types';
import { getMenuCategories, getModifierGroups } from '@/store/catalogStore';

// Single place that resolves an F&B item's effective prep-station + tax category.
// Each is the item's own override when set, otherwise the category default.
// Categories can be passed in (e.g. a snapshot held by a screen) or default to
// the live store, so this works in both React and non-React call sites.

/** The category def a menu item belongs to (by id), or undefined if missing. */
export function findMenuCategory(
  categoryId: string,
  categories: MenuCategoryDef[] = getMenuCategories()
): MenuCategoryDef | undefined {
  return categories.find((c) => c.id === categoryId);
}

/** Top-level categories only (no parent), in tab order. */
export function topLevelCategories(
  categories: MenuCategoryDef[] = getMenuCategories()
): MenuCategoryDef[] {
  return categories
    .filter((c) => !c.parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** The sub-categories of a given parent id, in their per-parent sort order. */
export function subCategoriesOf(
  parentId: string,
  categories: MenuCategoryDef[] = getMenuCategories()
): MenuCategoryDef[] {
  return categories
    .filter((c) => c.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** True when the category is a sub-category (has a parent). */
export function isSubCategory(c: MenuCategoryDef): boolean {
  return !!c.parentId;
}

/**
 * A category's effective default prep station: its own value when set, else its
 * parent top-level category's value (for sub-categories that inherit). Undefined
 * only when nothing in the chain sets it.
 */
export function categoryPrepStation(
  category: MenuCategoryDef | undefined,
  categories: MenuCategoryDef[] = getMenuCategories()
): PrepStation | undefined {
  if (!category) return undefined;
  if (category.defaultPrepStation) return category.defaultPrepStation;
  if (category.parentId) {
    return findMenuCategory(category.parentId, categories)?.defaultPrepStation;
  }
  return undefined;
}

/**
 * A category's effective default tax category: its own value when set, else its
 * parent top-level category's value (for sub-categories that inherit).
 */
export function categoryTaxCategory(
  category: MenuCategoryDef | undefined,
  categories: MenuCategoryDef[] = getMenuCategories()
): TaxableCategory | undefined {
  if (!category) return undefined;
  if (category.defaultTaxCategory) return category.defaultTaxCategory;
  if (category.parentId) {
    return findMenuCategory(category.parentId, categories)?.defaultTaxCategory;
  }
  return undefined;
}

/**
 * Where this item's prep ticket prints, resolving item override → its own
 * (sub)category value → parent category value. Falls back to 'kitchen' if
 * nothing in the chain is set.
 */
export function effectivePrepStation(
  item: MenuItem,
  categories: MenuCategoryDef[] = getMenuCategories()
): PrepStation {
  return (
    item.prepStationOverride ??
    categoryPrepStation(findMenuCategory(item.category, categories), categories) ??
    'kitchen'
  );
}

/**
 * Which taxable area this item falls under, resolving item override → its own
 * (sub)category value → parent category value. Falls back to 'fnb' if nothing
 * in the chain is set.
 */
export function effectiveTaxCategory(
  item: MenuItem,
  categories: MenuCategoryDef[] = getMenuCategories()
): TaxableCategory {
  return (
    item.taxCategoryOverride ??
    categoryTaxCategory(findMenuCategory(item.category, categories), categories) ??
    'fnb'
  );
}

/**
 * The full set of modifier groups that apply to a menu item: its INLINE
 * `modifierGroups` (item-specific) plus the groups resolved from its
 * `linkedModifierGroupIds` (the shared library). Inline groups come first, then
 * linked ones, de-duped by id (an inline group with the same id wins, and a
 * linked id that doesn't resolve is skipped). The library defaults to the live
 * store but can be passed in (e.g. a screen's snapshot) for non-React callers.
 */
export function getEffectiveModifierGroups(
  item: MenuItem,
  library: ModifierGroup[] = getModifierGroups()
): ModifierGroup[] {
  const inline = item.modifierGroups ?? [];
  const seen = new Set(inline.map((g) => g.id));
  const linked: ModifierGroup[] = [];
  for (const id of item.linkedModifierGroupIds ?? []) {
    if (seen.has(id)) continue; // inline takes precedence; skip dupes
    const group = library.find((g) => g.id === id);
    if (group) {
      linked.push(group);
      seen.add(id);
    }
  }
  return [...inline, ...linked];
}
