import { useState } from 'react';
import {
  Pencil,
  Trash2,
  Plus,
  Tags,
  ChevronUp,
  ChevronDown,
  CornerDownRight,
} from 'lucide-react';
import type { MenuCategoryDef } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import {
  topLevelCategories,
  subCategoriesOf,
  categoryPrepStation,
  categoryTaxCategory,
} from '@/lib/menu';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { NotSavedNotice } from '../NotSavedNotice';
import { CategoryFormDialog } from './CategoryFormDialog';
import { PREP_STATION_LABELS, TAX_CATEGORY_LABELS } from './categoryLabels';

/**
 * Admin editing screen for F&B menu categories. Categories are editable data
 * (not a hardcoded union) and form a two-level tree: top-level categories with
 * optional sub-categories. Each carries a default prep-station and tax category
 * inherited by its menu items; a sub-category may inherit those from its parent.
 * Reads the live shared store and writes back through its mutators, so changes
 * flow to the POS order station in-session.
 *
 * Deletion guards:
 * - A top-level category that still has sub-categories, items, or scoped
 *   discounts is blocked (resolve those first so nothing is orphaned).
 * - A sub-category with items is allowed: its items fall back to the parent
 *   top-level category rather than being orphaned.
 */
export function CategoriesPanel() {
  const { menuCategories, menuItems, discounts, mutators } = useCatalogStore();

  const topLevels = topLevelCategories(menuCategories);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MenuCategoryDef | null>(null);
  const [addParentId, setAddParentId] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<MenuCategoryDef | null>(
    null
  );

  // Count of menu items still pointing directly at a given category.
  const itemCount = (id: string) =>
    menuItems.filter((m) => m.category === id).length;

  // Count of discount codes scoped to a given category (blocks deletion —
  // otherwise the discount silently applies to nothing).
  const discountCount = (id: string) =>
    discounts.filter(
      (d) => d.target?.kind === 'fnbCategory' && d.target.category === id
    ).length;

  const subCount = (id: string) => subCategoriesOf(id, menuCategories).length;

  const isSub = (c: MenuCategoryDef) => !!c.parentId;

  const openAddTopLevel = () => {
    setEditing(null);
    setAddParentId(undefined);
    setFormOpen(true);
  };
  const openAddSub = (parentId: string) => {
    setEditing(null);
    setAddParentId(parentId);
    setFormOpen(true);
  };
  const openEdit = (category: MenuCategoryDef) => {
    setEditing(category);
    setAddParentId(undefined);
    setFormOpen(true);
  };

  // Top-level categories block on sub-categories / items / discounts.
  // Sub-categories only block on discounts — their items fall back to the parent.
  const isBlocked = (c: MenuCategoryDef) =>
    isSub(c)
      ? discountCount(c.id) > 0
      : subCount(c.id) > 0 || itemCount(c.id) > 0 || discountCount(c.id) > 0;

  const pendingBlocked = pendingDelete ? isBlocked(pendingDelete) : false;
  const pendingReassignCount =
    pendingDelete && isSub(pendingDelete) ? itemCount(pendingDelete.id) : 0;

  const confirmDelete = () => {
    if (pendingDelete && !isBlocked(pendingDelete)) {
      // Re-home a sub-category's items onto its parent before removing it.
      if (isSub(pendingDelete) && pendingDelete.parentId) {
        for (const m of menuItems.filter(
          (i) => i.category === pendingDelete.id
        )) {
          mutators.upsertMenuItem({ ...m, category: pendingDelete.parentId });
        }
      }
      mutators.deleteMenuCategory(pendingDelete.id);
    }
    setPendingDelete(null);
  };

  // Human-readable list of what still blocks the pending category.
  const blockingReasons = (c: MenuCategoryDef): string => {
    const parts: string[] = [];
    if (!isSub(c)) {
      const subs = subCount(c.id);
      const items = itemCount(c.id);
      if (subs > 0)
        parts.push(`${subs} sub-categor${subs === 1 ? 'y' : 'ies'}`);
      if (items > 0) parts.push(`${items} menu item${items === 1 ? '' : 's'}`);
    }
    const discs = discountCount(c.id);
    if (discs > 0) parts.push(`${discs} discount${discs === 1 ? '' : 's'}`);
    return parts.join(' and ');
  };

  // Swap a sub-category's sortOrder with its neighbour to reorder within parent.
  const moveSub = (sub: MenuCategoryDef, dir: -1 | 1) => {
    if (!sub.parentId) return;
    const siblings = subCategoriesOf(sub.parentId, menuCategories);
    const idx = siblings.findIndex((s) => s.id === sub.id);
    const target = siblings[idx + dir];
    if (!target) return;
    mutators.upsertMenuCategory({ ...sub, sortOrder: target.sortOrder });
    mutators.upsertMenuCategory({ ...target, sortOrder: sub.sortOrder });
  };

  const prepLabel = (c: MenuCategoryDef) => {
    const resolved = categoryPrepStation(c, menuCategories);
    const label = resolved ? PREP_STATION_LABELS[resolved] : '—';
    return isSub(c) && !c.defaultPrepStation ? `${label} (inherited)` : label;
  };
  const taxLabel = (c: MenuCategoryDef) => {
    const resolved = categoryTaxCategory(c, menuCategories);
    const label = resolved ? TAX_CATEGORY_LABELS[resolved] : '—';
    return isSub(c) && !c.defaultTaxCategory ? `${label} (inherited)` : label;
  };

  const totalCount = menuCategories.length;

  return (
    <div className="flex flex-col gap-6">
      <NotSavedNotice
        mutators={['upsertMenuCategory', 'deleteMenuCategory']}
        what="categories, their nesting, prep stations and tax categories"
      />

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Tags className="w-4 h-4 text-foreground/60" />
            <h2 className="text-lg font-bold">F&B Categories</h2>
            <span className="text-sm text-foreground/40">({totalCount})</span>
          </div>
          <Button onClick={openAddTopLevel}>
            <Plus className="w-4 h-4" />
            Add category
          </Button>
        </div>

        {topLevels.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
            No categories yet. Use “Add category” to create one.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {topLevels.map((top) => {
              const subs = subCategoriesOf(top.id, menuCategories);
              return (
                <div
                  key={top.id}
                  className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] overflow-hidden"
                >
                  {/* Top-level row */}
                  <div className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{top.name}</div>
                      <div className="text-sm text-foreground/60">
                        {prepLabel(top)} · {taxLabel(top)}
                      </div>
                      <div className="text-xs tabular-nums text-foreground/40">
                        {itemCount(top.id)} direct item
                        {itemCount(top.id) === 1 ? '' : 's'}
                        {subs.length > 0 &&
                          ` · ${subs.length} sub-categor${
                            subs.length === 1 ? 'y' : 'ies'
                          }`}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAddSub(top.id)}
                      >
                        <Plus className="w-4 h-4" />
                        Sub-category
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => openEdit(top)}
                        aria-label={`Edit ${top.name}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setPendingDelete(top)}
                        aria-label={`Delete ${top.name}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>

                  {/* Sub-category rows */}
                  {subs.length > 0 && (
                    <div className="flex flex-col border-t border-foreground/5 bg-foreground/[0.02]">
                      {subs.map((sub, i) => (
                        <div
                          key={sub.id}
                          className="flex items-center justify-between gap-3 px-4 py-3 pl-8 border-t border-foreground/5 first:border-t-0"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <CornerDownRight className="w-4 h-4 shrink-0 text-foreground/30" />
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {sub.name}
                              </div>
                              <div className="text-xs text-foreground/55">
                                {prepLabel(sub)} · {taxLabel(sub)} ·{' '}
                                <span className="tabular-nums">
                                  {itemCount(sub.id)} item
                                  {itemCount(sub.id) === 1 ? '' : 's'}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              variant="outline"
                              size="icon"
                              disabled={i === 0}
                              onClick={() => moveSub(sub, -1)}
                              aria-label={`Move ${sub.name} up`}
                            >
                              <ChevronUp className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              disabled={i === subs.length - 1}
                              onClick={() => moveSub(sub, 1)}
                              aria-label={`Move ${sub.name} down`}
                            >
                              <ChevronDown className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => openEdit(sub)}
                              aria-label={`Edit ${sub.name}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => setPendingDelete(sub)}
                              aria-label={`Delete ${sub.name}`}
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Form */}
      <CategoryFormDialog
        open={formOpen}
        category={editing}
        categories={menuCategories}
        defaultParentId={addParentId}
        onOpenChange={setFormOpen}
        onSave={mutators.upsertMenuCategory}
      />

      {/* Delete confirmation — blocked while the category is still referenced. */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingBlocked ? 'Can’t delete category' : 'Delete category?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {!pendingDelete
                ? ''
                : pendingBlocked
                  ? `“${pendingDelete.name}” is still used by ${blockingReasons(
                      pendingDelete
                    )}. Reassign or remove those first so nothing is left pointing at a missing category.`
                  : pendingReassignCount > 0 && pendingDelete.parentId
                    ? `“${pendingDelete.name}” will be removed and its ${pendingReassignCount} item${
                        pendingReassignCount === 1 ? '' : 's'
                      } will fall back to the parent category “${
                        menuCategories.find(
                          (c) => c.id === pendingDelete.parentId
                        )?.name ?? 'parent'
                      }”.`
                    : `“${pendingDelete.name}” will be removed and no longer available when categorising F&B items.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {pendingBlocked ? 'OK' : 'Cancel'}
            </AlertDialogCancel>
            {!pendingBlocked && (
              <AlertDialogAction
                onClick={confirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
