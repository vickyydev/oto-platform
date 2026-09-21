import { useState } from 'react';
import { Pencil, Trash2, Plus, SlidersHorizontal } from 'lucide-react';
import { type MenuItem, INVENTORY_DEFAULT_VARIANT_ID } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
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
import { MenuItemForm } from './MenuItemForm';
import { formatPrice } from './menuItem';
import { formatWWPrice } from '@/lib/pricingMode';

const groupCount = (item: MenuItem) => item.modifierGroups?.length ?? 0;

/**
 * Admin editing screen for the F&B menu. Reads the live shared catalog store
 * and writes back through its mutators, so edits flow to the F&B order station
 * on its next mount.
 */
export function MenuPanel() {
  const { menuItems, menuCategories, mutators } = useCatalogStore();
  const orderedCategories = [...menuCategories].sort(
    (a, b) => a.sortOrder - b.sortOrder
  );

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MenuItem | null>(null);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (item: MenuItem) => {
    setEditing(item);
    setFormOpen(true);
  };

  const confirmDelete = () => {
    if (pendingDelete) mutators.deleteMenuItem(pendingDelete.id);
    setPendingDelete(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <NotSavedNotice
        mutators={['upsertMenuItem', 'deleteMenuItem']}
        what="menu items, their prices and their categories"
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground/50">
          {menuItems.length} {menuItems.length === 1 ? 'item' : 'items'}
        </p>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4" />
          Add item
        </Button>
      </div>

      {menuItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          No menu items yet. Use “Add item” to create one.
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {orderedCategories.map((category) => {
            const items = menuItems.filter((m) => m.category === category.id);
            if (items.length === 0) return null;
            return (
              <section key={category.id} className="flex flex-col gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground/40">
                  {category.name}
                  <span className="ml-2 font-normal normal-case text-foreground/30">
                    {items.length}
                  </span>
                </h2>
                <div className="flex flex-col gap-2">
                  {items.map((item) => {
                    const groups = groupCount(item);
                    return (
                      <div
                        key={item.id}
                        className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">
                              {item.name}
                            </span>
                            {groups > 0 && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
                                <SlidersHorizontal className="h-3 w-3" />
                                {groups}{' '}
                                {groups === 1 ? 'group' : 'groups'}
                              </span>
                            )}
                          </div>
                          <div className="text-sm tabular-nums text-foreground/60">
                            {formatWWPrice(item.price)}
                            {item.cost != null && (
                              <span className="ml-2 text-foreground/35">
                                cost {formatPrice(item.cost)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => openEdit(item)}
                            aria-label={`Edit ${item.name}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setPendingDelete(item)}
                            aria-label={`Delete ${item.name}`}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <MenuItemForm
        open={formOpen}
        item={editing}
        onClose={() => setFormOpen(false)}
        onSave={(item, trackStock) => {
          // Reconcile the inventory link to match the "Track stock" toggle. Turning
          // it on links a single Default-variant inventory item (size variants are
          // added in the Inventory panel); turning it off removes the link.
          let next = item;
          const hasLink = !!item.inventoryItemId;
          if (trackStock && !hasLink) {
            const invId = `inv-${item.id}`;
            mutators.upsertInventoryItem({
              id: invId,
              name: item.name,
              linkedKind: 'menu',
              linkedId: item.id,
              variants: [
                { id: INVENTORY_DEFAULT_VARIANT_ID, label: 'Default', stock: 0 },
              ],
            });
            next = { ...item, inventoryItemId: invId };
          } else if (!trackStock && hasLink) {
            mutators.deleteInventoryItem(item.inventoryItemId!);
            next = { ...item, inventoryItemId: undefined };
          }
          mutators.upsertMenuItem(next);
          setFormOpen(false);
        }}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete menu item?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `“${pendingDelete.name}” will be removed and no longer available in the F&B order station.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
