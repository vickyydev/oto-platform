
import { useEffect, useRef, useState } from "react";
import type { AddOnsPanelPorts } from '../../../runtime/catalogue';
import { Pencil, Trash2, Plus } from "lucide-react";
import { type AddOn, INVENTORY_DEFAULT_VARIANT_ID } from "../../../model/types";

import { useAdminScreenRuntime, useCatalogStore } from "../../../runtime/AdminScreenRuntime";
import { Button } from "../../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import { AdminNoticeBanner } from "../NotSavedNotice";
import { AddOnFormDialog } from "./AddOnFormDialog";

/**
 * Admin editing screen for the park's add-ons (extras). Reads the live shared
 * catalog store and writes back through its mutators, so edits flow to the POS
 * till in-session.
 */
export function AddOnsPanel() {
  const runtime = useAdminScreenRuntime();
  const { addOns, mutators } = useCatalogStore();
  return <AddOnsPanelWithPorts ports={{ addOns, formatWWPrice: runtime.domain.pricingMode.formatWWPrice, upsertAddOn: mutators.upsertAddOn, deleteAddOn: mutators.deleteAddOn, upsertInventoryItem: mutators.upsertInventoryItem, deleteInventoryItem: mutators.deleteInventoryItem }} />;
}

export function AddOnsPanelWithPorts({ ports }: { ports: AddOnsPanelPorts }) {
  const { addOns } = ports;
  const formatPrice = ports.formatWWPrice;
  const canManage = (addOn: AddOn) => ports.canManage !== false && (ports.canManageAddOn?.(addOn) ?? true);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AddOn | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AddOn | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deleteTarget = useRef(pendingDelete);
  deleteTarget.current = pendingDelete;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (addOn: AddOn) => {
    setEditing(addOn);
    setFormOpen(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deletingRef.current || !canManage(pendingDelete)) return;
    const target = pendingDelete;
    deletingRef.current = true;
    setDeleting(true);
    setWriteError(null);
    try {
      await ports.deleteAddOn(target.id);
      if (mounted.current && deleteTarget.current === target) setPendingDelete(null);
    } catch (failure) {
      if (mounted.current) setWriteError(failure instanceof Error ? failure.message : 'The add-on could not be deleted.');
    } finally { deletingRef.current = false; if (mounted.current) setDeleting(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <AdminNoticeBanner>
        To start stock tracking, link the item in Inventory. Turning Track stock
        on here alone does not create that link. Manage stock counts in Inventory.
      </AdminNoticeBanner>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground/50">
          {addOns.length} {addOns.length === 1 ? 'add-on' : 'add-ons'}
        </p>
        {ports.canManage !== false && <Button onClick={openAdd}>
          <Plus className="w-4 h-4" />
          Add add-on
        </Button>}
      </div>

      {writeError && !pendingDelete && <p role="alert" className="text-sm text-destructive">{writeError}</p>}
      {addOns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          No add-ons yet. Use “Add add-on” to create one.
        </div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden md:block overflow-hidden rounded-2xl border border-foreground/10">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead className="w-32 text-right">Price</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {addOns.map((addOn) => (
                  <TableRow key={addOn.id}>
                    <TableCell className="font-medium">{addOn.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPrice(addOn.price)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        {canManage(addOn) && <Button
                          variant="outline"
                          size="icon"
                          onClick={() => openEdit(addOn)}
                          aria-label={`Edit ${addOn.name}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>}
                        {canManage(addOn) && <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setPendingDelete(addOn)}
                          aria-label={`Delete ${addOn.name}`}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="flex flex-col gap-2 md:hidden">
            {addOns.map((addOn) => (
              <div
                key={addOn.id}
                className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{addOn.name}</div>
                  <div className="text-sm tabular-nums text-foreground/60">
                    {formatPrice(addOn.price)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {canManage(addOn) && <Button
                    variant="outline"
                    size="icon"
                    onClick={() => openEdit(addOn)}
                    aria-label={`Edit ${addOn.name}`}
                  >
                    <Pencil className="w-4 h-4" />
                    </Button>}
                    {canManage(addOn) && <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setPendingDelete(addOn)}
                    aria-label={`Delete ${addOn.name}`}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}


      {formOpen && <AddOnFormDialog
        key={editing?.id ?? 'add'}
        open={formOpen}
        addOn={editing}
        onOpenChange={setFormOpen}
        onSave={async (addOn, trackStock) => {
          if (ports.canManage === false || (editing && !canManage(editing))) throw new Error('This add-on is read-only with the current access.');
          // Reconcile the inventory link to match the "Track stock" toggle.
          // Non-stocked add-ons stay non-stocked by design (lockers, digital
          // extras); only create a linked inventory item when the admin opts in.
          let next = addOn;
          const hasLink = !!addOn.inventoryItemId;
          if (trackStock && !hasLink) {
            const invId = `inv-${addOn.id}`;
            await ports.upsertInventoryItem({
              id: invId,
              name: addOn.name,
              linkedKind: 'addon',
              linkedId: addOn.id,
              variants: [
                { id: INVENTORY_DEFAULT_VARIANT_ID, label: 'Default', stock: 0 },
              ],
            });
            next = { ...addOn, inventoryItemId: invId };
          } else if (!trackStock && hasLink) {
            await ports.deleteInventoryItem(addOn.inventoryItemId!);
            next = { ...addOn, inventoryItemId: undefined };
          }
          await ports.upsertAddOn(next);
        }}
      />}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete add-on?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `“${pendingDelete.name}” will be removed and no longer available in the till.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {writeError && <p role="alert" className="text-sm text-destructive">{writeError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => { event.preventDefault(); void confirmDelete(); }}
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
