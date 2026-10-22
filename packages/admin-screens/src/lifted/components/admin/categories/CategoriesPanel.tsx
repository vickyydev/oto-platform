import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useOperatorMenuCapability, type CategoriesPanelPorts } from '../../../runtime/menu';
import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2, Plus, Tags, ChevronUp, ChevronDown, CornerDownRight } from "lucide-react";
import { type MenuCategoryDef } from "../../../model/types";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";

import { Button } from "../../ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import { CategoryFormDialogWithPorts } from "./CategoryFormDialog";
import { PREP_STATION_LABELS, TAX_CATEGORY_LABELS } from "./categoryLabels";

/**
 * Admin editing screen for F&B menu categories. Categories are editable data
 * (not a hardcoded union) and form a two-level tree: top-level categories with
 * optional sub-categories. Each carries a default prep-station and tax category
 * inherited by its menu items; a sub-category may inherit those from its parent.
 * Reads the live shared store and writes back through its mutators, which since
 * SCRUM-341 save to `pos.product_category` and re-read the branch, so a change
 * reaches the POS order station and survives a reload.
 *
 * Deletion guards:
 * - A top-level category that still has sub-categories, items, or scoped
 *   discounts is blocked (resolve those first so nothing is orphaned).
 * - A sub-category with items is allowed: its items fall back to the parent
 *   top-level category rather than being orphaned. The platform refuses to
 *   withdraw a category that still holds items, so the re-homing has to land
 *   first — `api/menu.ts` runs the menu writes one at a time, in this order.
 */
export function CategoriesPanel() {
  const runtime = useAdminScreenRuntime();
  const { menuCategories, menuItems, discounts, mutators } = useCatalogStore();
  const scope = useOperatorMenuCapability(runtime.transport, runtime.session.operator?.id, Boolean(runtime.branch.branch.apiId), runtime.session.operator);
  return <CategoriesPanelWithPorts ports={{ menuCategories, menuItems, discounts, menuHelpers: runtime.domain.menu, ...mutators, ...scope }} />;
}

export function CategoriesPanelWithPorts({ ports }: { ports: CategoriesPanelPorts }) {
  const { topLevelCategories, subCategoriesOf, categoryPrepStation, categoryTaxCategory } = ports.menuHelpers;
  const { menuCategories, menuItems, discounts } = ports;
  const mutators = ports;

  const topLevels = topLevelCategories(menuCategories);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MenuCategoryDef | null>(null);
  const [addParentId, setAddParentId] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<MenuCategoryDef | null>(
    null
  );
  const canManage = ports.canManage !== false;
  const manageRef = useRef(canManage);
  manageRef.current = canManage;
  const [writeError, setWriteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deleteTarget = useRef(pendingDelete);
  deleteTarget.current = pendingDelete;
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

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

  const confirmDelete = async () => {
    if (!pendingDelete || isBlocked(pendingDelete) || deletingRef.current || !manageRef.current) return;
    const target = pendingDelete;
    deletingRef.current = true;
    setDeleting(true);
    setWriteError(null);
    try {
      // Re-home a sub-category's items onto its parent before removing it.
      if (isSub(target) && target.parentId) {
        for (const m of menuItems.filter(
          (i) => i.category === target.id
        )) {
          if (!mounted.current || !manageRef.current || deleteTarget.current !== target) return;
          await mutators.upsertMenuItem({ ...m, category: target.parentId });
        }
      }
      if (!mounted.current || !manageRef.current || deleteTarget.current !== target) return;
      await mutators.deleteMenuCategory(target.id);
      if (mounted.current && deleteTarget.current === target) setPendingDelete(null);
    } catch (failure) {
      if (mounted.current && deleteTarget.current === target) setWriteError(failure instanceof Error ? failure.message : 'The category could not be deleted.');
    } finally { deletingRef.current = false; if (mounted.current) setDeleting(false); }
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
  const moveSub = async (sub: MenuCategoryDef, dir: -1 | 1) => {
    if (!sub.parentId || movingRef.current || !manageRef.current) return;
    const siblings = subCategoriesOf(sub.parentId, menuCategories);
    const idx = siblings.findIndex((s) => s.id === sub.id);
    const target = siblings[idx + dir];
    if (!target) return;
    movingRef.current = true;
    setMoving(true);
    setWriteError(null);
    try {
      await mutators.upsertMenuCategory({ ...sub, sortOrder: target.sortOrder });
      if (mounted.current && manageRef.current) await mutators.upsertMenuCategory({ ...target, sortOrder: sub.sortOrder });
    } catch (failure) {
      if (mounted.current) setWriteError(failure instanceof Error ? failure.message : 'The categories could not be reordered.');
    } finally { movingRef.current = false; if (mounted.current) setMoving(false); }
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
      {ports.authorityMessage && <p className="text-sm text-foreground/50">{ports.authorityMessage}</p>}
      {writeError && !pendingDelete && <p role="alert" className="text-sm text-destructive">{writeError}</p>}
      {/* No notice: since SCRUM-341 everything on this screen — the category,
          its nesting, its prep station and its tax area — is written to
          `pos.product_category` and read back. */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Tags className="w-4 h-4 text-foreground/60" />
            <h2 className="text-lg font-bold">F&B Categories</h2>
            <span className="text-sm text-foreground/40">({totalCount})</span>
          </div>
          {canManage && <Button onClick={openAddTopLevel}>
            <Plus className="w-4 h-4" />
            Add category
          </Button>}
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
                    {canManage && <div className="flex shrink-0 items-center gap-2">
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
                    </div>}
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
                          {canManage && <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              variant="outline"
                              size="icon"
                              disabled={i === 0 || moving}
                              onClick={() => moveSub(sub, -1)}
                              aria-label={`Move ${sub.name} up`}
                            >
                              <ChevronUp className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              disabled={i === subs.length - 1 || moving}
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
                          </div>}
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
      {formOpen && canManage && <CategoryFormDialogWithPorts
        menuHelpers={ports.menuHelpers}
        open={formOpen}
        category={editing}
        categories={menuCategories}
        defaultParentId={addParentId}
        onOpenChange={setFormOpen}
        onSave={mutators.upsertMenuCategory}
      />}

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
          {writeError && <p role="alert" className="text-sm text-destructive">{writeError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>
              {pendingBlocked ? 'OK' : 'Cancel'}
            </AlertDialogCancel>
            {!pendingBlocked && (
              <AlertDialogAction
                onClick={event => { event.preventDefault(); void confirmDelete(); }}
                disabled={deleting || !canManage}
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
