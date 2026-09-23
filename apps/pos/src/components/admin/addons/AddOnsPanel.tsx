import { useState } from 'react';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { AddOn, INVENTORY_DEFAULT_VARIANT_ID } from '@/types';
import { formatWWPrice } from '@/lib/pricingMode';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { AddOnFormDialog } from './AddOnFormDialog';

const formatPrice = formatWWPrice;

/**
 * Admin editing screen for the park's add-ons (extras). Reads the live shared
 * catalog store and writes back through its mutators, so edits flow to the POS
 * till in-session.
 */
export function AddOnsPanel() {
  const { addOns, mutators } = useCatalogStore();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AddOn | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AddOn | null>(null);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (addOn: AddOn) => {
    setEditing(addOn);
    setFormOpen(true);
  };

  const confirmDelete = () => {
    if (pendingDelete) mutators.deleteAddOn(pendingDelete.id);
    setPendingDelete(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* The add-on and its price persist (SCRUM-204); the Track stock switch
          mints an inventory item, and that half is still in this tab. Written
          out for the reason given on the Merch panel. */}
      <AdminNoticeBanner>
        <strong className="font-semibold">Stock counts are this tab only — SCRUM-204.</strong>{' '}
        The add-on and its weekday and weekend prices save to the database and
        survive a reload. The Track stock switch, and the counts behind it, stay
        in this browser tab.
      </AdminNoticeBanner>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground/50">
          {addOns.length} {addOns.length === 1 ? 'add-on' : 'add-ons'}
        </p>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4" />
          Add add-on
        </Button>
      </div>

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
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => openEdit(addOn)}
                          aria-label={`Edit ${addOn.name}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setPendingDelete(addOn)}
                          aria-label={`Delete ${addOn.name}`}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
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
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => openEdit(addOn)}
                    aria-label={`Edit ${addOn.name}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setPendingDelete(addOn)}
                    aria-label={`Delete ${addOn.name}`}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}


      <AddOnFormDialog
        open={formOpen}
        addOn={editing}
        onOpenChange={setFormOpen}
        onSave={(addOn, trackStock) => {
          // Reconcile the inventory link to match the "Track stock" toggle.
          // Non-stocked add-ons stay non-stocked by design (lockers, digital
          // extras); only create a linked inventory item when the admin opts in.
          let next = addOn;
          const hasLink = !!addOn.inventoryItemId;
          if (trackStock && !hasLink) {
            const invId = `inv-${addOn.id}`;
            mutators.upsertInventoryItem({
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
            mutators.deleteInventoryItem(addOn.inventoryItemId!);
            next = { ...addOn, inventoryItemId: undefined };
          }
          mutators.upsertAddOn(next);
        }}
      />

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
