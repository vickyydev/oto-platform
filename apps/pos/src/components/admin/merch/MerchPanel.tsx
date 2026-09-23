import { useState } from 'react';
import { Pencil, Trash2, Plus, Info, AlertTriangle, Eye, EyeOff, Package } from 'lucide-react';
import type { MerchItem } from '@/types';
import { INVENTORY_DEFAULT_VARIANT_ID } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { isLowStock, isOutOfStock } from '@/lib/merch';
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
import { AdminNoticeBanner } from '../NotSavedNotice';
import { MerchItemForm } from './MerchItemForm';
import { formatPrice } from '../menu/menuItem';
import { formatWWPrice } from '@/lib/pricingMode';

/**
 * Admin editing screen for the retail/merch catalog. Handles item CRUD
 * (name, price, SKU, category, active flag). Stock is now managed in the
 * unified Inventory panel — there are no stock fields here.
 */
export function MerchPanel() {
  const { merchItems, mutators } = useCatalogStore();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MerchItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MerchItem | null>(null);

  const lowStock = merchItems.filter((m) => isLowStock(m) || isOutOfStock(m));

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (item: MerchItem) => {
    setEditing(item);
    setFormOpen(true);
  };

  const confirmDelete = () => {
    if (pendingDelete) mutators.deleteMerchItem(pendingDelete.id);
    setPendingDelete(null);
  };

  const toggleActive = (item: MerchItem) =>
    mutators.upsertMerchItem({ ...item, active: !item.active });

  const stockBadge = (item: MerchItem) => {
    if (isOutOfStock(item)) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
          <AlertTriangle className="h-3 w-3" />
          Out of stock
        </span>
      );
    }
    if (isLowStock(item)) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600">
          <AlertTriangle className="h-3 w-3" />
          Low · {item.stock} left
        </span>
      );
    }
    if (item.stock !== undefined) {
      return (
        <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 tabular-nums">
          {item.stock} in stock
        </span>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      {/* The item, its price and its barcode persist (SCRUM-204). What is on
          the shelf does not: the stock tables have no routes yet, so the
          banner is about that half and says which half it is. It is written
          out rather than using `NotSavedNotice`, whose sentence ends "a page
          reload discards them" — true of the counts, and the opposite of true
          of the item beside them. */}
      <AdminNoticeBanner>
        <strong className="font-semibold">Stock counts are this tab only — SCRUM-204.</strong>{' '}
        The item, its price, its category and its barcode save to the database and
        survive a reload. What is on the shelf, and the Track stock switch that
        starts counting it, stay in this browser tab.
      </AdminNoticeBanner>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground/50">
          {merchItems.length} {merchItems.length === 1 ? 'item' : 'items'}
        </p>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4" />
          Add item
        </Button>
      </div>

      {/* Low-stock / out-of-stock summary — manage stock in the Inventory panel */}
      {lowStock.length > 0 && (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs font-semibold uppercase tracking-wider">
                Needs restocking ({lowStock.length})
              </span>
            </div>
            <span className="flex items-center gap-1 text-xs text-amber-700/80">
              <Package className="w-3.5 h-3.5" />
              Adjust in Inventory panel
            </span>
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {lowStock.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="truncate">{item.name}</span>
                {stockBadge(item)}
              </div>
            ))}
          </div>
        </div>
      )}

      {merchItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          No merch items yet. Use "Add item" to create one.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {merchItems.map((item) => (
            <div
              key={item.id}
              className={`flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4 ${
                item.active ? '' : 'opacity-60'
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{item.name}</span>
                  {item.category && (
                    <span className="shrink-0 rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/45">
                      {item.category}
                    </span>
                  )}
                  {!item.active && (
                    <span className="shrink-0 rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-foreground/60">
                      Retired
                    </span>
                  )}
                  {stockBadge(item)}
                </div>
                <div className="text-sm tabular-nums text-foreground/60">
                  {formatWWPrice(item.price)}
                  {item.cost != null && (
                    <span className="ml-2 text-foreground/35">cost {formatPrice(item.cost)}</span>
                  )}
                  {item.sku && <span className="ml-2 text-foreground/35">SKU {item.sku}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => toggleActive(item)}
                  aria-label={item.active ? `Retire ${item.name}` : `Restore ${item.name}`}
                  title={item.active ? 'Retire (hide from shop)' : 'Restore to shop'}
                >
                  {item.active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
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
          ))}
        </div>
      )}

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Stock levels are managed in the Inventory panel.
      </p>

      <MerchItemForm
        open={formOpen}
        item={editing}
        onClose={() => setFormOpen(false)}
        onSave={(savedItem, trackStock) => {
          // Reconcile the inventory link to match the "Track stock" toggle:
          // create+link when turned on, unlink+delete when turned off.
          let item = savedItem;
          const hasLink = !!item.inventoryItemId;
          if (trackStock && !hasLink) {
            const invId = `inv-m-${item.id}`;
            mutators.upsertInventoryItem({
              id: invId,
              name: item.name,
              linkedKind: 'merch',
              linkedId: item.id,
              variants: [{ id: INVENTORY_DEFAULT_VARIANT_ID, label: 'Default', stock: 0 }],
            });
            item = { ...item, inventoryItemId: invId };
          } else if (!trackStock && hasLink) {
            mutators.deleteInventoryItem(item.inventoryItemId!);
            item = { ...item, inventoryItemId: undefined };
          }
          mutators.upsertMerchItem(item);
          setFormOpen(false);
        }}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete merch item?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will be removed and no longer available in the shop.`
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
