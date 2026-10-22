import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useOperatorMenuCapability, type MerchPanelPorts } from '../../../runtime/menu';
import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Trash2, Plus, Info, AlertTriangle, Eye, EyeOff, Package } from "lucide-react";
import { type MerchItem } from "../../../model/types";
import { INVENTORY_DEFAULT_VARIANT_ID } from "../../../model/types";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";

import { isLowStock, isOutOfStock } from "../../../lib/merch";
import { Button } from "../../ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import { AdminNoticeBanner } from "../NotSavedNotice";
import { MerchItemForm } from "./MerchItemForm";
import { formatPrice } from "../menu/menuItem";


/**
 * Admin editing screen for the retail/merch catalog. Handles item CRUD
 * (name, price, SKU, category, active flag). Stock is now managed in the
 * unified Inventory panel — there are no stock fields here.
 */
export function MerchPanel() {
  const runtime = useAdminScreenRuntime();
  const merchItemsWithStock = runtime.api.stock.merchItemsWithStock;
  const refreshSellableStock = runtime.api.stock.refreshSellableStock;
  const useSellableStockVersion = runtime.api.stock.useSellableStockVersion;
  const formatWWPrice = runtime.domain.pricingMode.formatWWPrice;

  const { merchItems, inventory, mutators } = useCatalogStore();
  const branch = runtime.reads.getActiveBranch();
  const apiBranchId = runtime.api.catalogBridge.apiBranchIdForSlug(branch.id);
  const scope = useOperatorMenuCapability(runtime.transport, runtime.session.operator?.id, apiBranchId !== null, runtime.session.operator, apiBranchId ?? undefined);

  /**
   * SCRUM-379 — THE ROWS ON SCREEN CARRY STOCK, read the way the shop grid
   * reads it (`pages/MerchStation.tsx`): the ported inventory's figures for a
   * local link, the platform's for a product it tracks
   * (`merchItemsWithStock`, `api/stock.ts`). The store's raw list carries no
   * stock, which left the badge and the restocking notice with nothing to show.
   * Edits still go through the raw rows, so no figure is written back.
   */
  const stockVersion = useSellableStockVersion();
  const shownItems = useMemo(
    () => merchItemsWithStock(),
    // Recomputed when any of what it reads moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [merchItems, inventory, stockVersion],
  );
  // The counts as they stand now, not as they stood at sign-in.
  useEffect(() => {
    void refreshSellableStock();
  }, [refreshSellableStock]);

  return <MerchPanelWithPorts ports={{ merchItems, shownItems, formatWWPrice, ...mutators, canCreate: scope.canManageBranch,
    canManageItem: item => scope.canManageProduct(runtime.api.menu.serverFieldsFor(item.id)?.branchId) }} />;
}

export function MerchPanelWithPorts({ ports }: { ports: MerchPanelPorts }) {
  const { merchItems, shownItems, formatWWPrice } = ports;
  const mutators = ports;
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MerchItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MerchItem | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deleteTarget = useRef(pendingDelete);
  deleteTarget.current = pendingDelete;
  const [toggling, setToggling] = useState<string | null>(null);
  const togglingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canManage = (item: MerchItem) => ports.canManageItem?.(item) ?? true;
  const rawById = useMemo(() => new Map(merchItems.map((m) => [m.id, m])), [merchItems]);
  const raw = (item: MerchItem): MerchItem => rawById.get(item.id) ?? item;

  const lowStock = shownItems.filter((m) => isLowStock(m) || isOutOfStock(m));

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (item: MerchItem) => {
    setEditing(raw(item));
    setFormOpen(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deletingRef.current || !canManage(pendingDelete)) return;
    const target = pendingDelete;
    deletingRef.current = true;
    setDeleting(true);
    setWriteError(null);
    try {
      await mutators.deleteMerchItem(target.id);
      if (mounted.current && deleteTarget.current === target) setPendingDelete(null);
    } catch (failure) {
      if (mounted.current && deleteTarget.current === target) setWriteError(failure instanceof Error ? failure.message : 'The merch item could not be deleted.');
    } finally { deletingRef.current = false; if (mounted.current) setDeleting(false); }
  };

  const toggleActive = async (item: MerchItem) => {
    if (togglingRef.current || !canManage(item)) return;
    togglingRef.current = true;
    setToggling(item.id);
    setWriteError(null);
    try { await mutators.upsertMerchItem({ ...raw(item), active: !item.active }); }
    catch (failure) { if (mounted.current) setWriteError(failure instanceof Error ? failure.message : 'The merch item could not be saved.'); }
    finally { togglingRef.current = false; if (mounted.current) setToggling(null); }
  };

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
      <AdminNoticeBanner>
        To start stock tracking, link the item in Inventory. Turning Track stock
        on here alone does not create that link. Manage stock counts in Inventory.
      </AdminNoticeBanner>

      {writeError && !pendingDelete && <p role="alert" className="text-sm text-destructive">{writeError}</p>}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground/50">
          {merchItems.length} {merchItems.length === 1 ? 'item' : 'items'}
        </p>
        {ports.canCreate !== false && <Button onClick={openAdd}>
          <Plus className="w-4 h-4" />
          Add item
        </Button>}
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
          {shownItems.map((item) => (
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
                  {item.variants && item.variants.length > 0 && (
                    <span className="ml-2 text-foreground/35">
                      Sizes {item.variants.map((v) => v.label).join(' · ')}
                    </span>
                  )}
                </div>
              </div>
              {canManage(item) && <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => toggleActive(item)}
                  disabled={toggling === item.id}
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
                  onClick={() => setPendingDelete(raw(item))}
                  aria-label={`Delete ${item.name}`}
                >
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>}
            </div>
          ))}
        </div>
      )}

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Stock levels are managed in the Inventory panel.
      </p>

      {formOpen && <MerchItemForm
        open={formOpen}
        item={editing}
        onClose={() => setFormOpen(false)}
        onSave={async (savedItem, trackStock) => {
          // Reconcile the inventory link to match the "Track stock" toggle:
          // create+link when turned on, unlink+delete when turned off.
          let item = savedItem;
          const hasLink = !!item.inventoryItemId;
          if (trackStock && !hasLink) {
            const invId = `inv-m-${item.id}`;
            await mutators.upsertInventoryItem({
              id: invId,
              name: item.name,
              linkedKind: 'merch',
              linkedId: item.id,
              variants: [{ id: INVENTORY_DEFAULT_VARIANT_ID, label: 'Default', stock: 0 }],
            });
            item = { ...item, inventoryItemId: invId };
          } else if (!trackStock && hasLink) {
            await mutators.deleteInventoryItem(item.inventoryItemId!);
            item = { ...item, inventoryItemId: undefined };
          }
          if (!mounted.current) throw new Error('The merch screen changed before the item could be saved.');
          await mutators.upsertMerchItem(item);
        }}
      />}

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
          {writeError && <p role="alert" className="text-sm text-destructive">{writeError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={event => { event.preventDefault(); void confirmDelete(); }}
              disabled={deleting}
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
