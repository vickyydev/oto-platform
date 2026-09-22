import { useState } from 'react';
import { Download, Pencil, Trash2, Plus, SlidersHorizontal, Upload } from 'lucide-react';
import { type MenuItem, INVENTORY_DEFAULT_VARIANT_ID } from '@/types';
import { MOCK_MUTATOR_TICKETS, useCatalogStore } from '@/store/CatalogStoreContext';
import { getActiveBranch } from '@/store/catalogStore';
import { apiBranchIdForSlug, loadMenuFromApi } from '@/api/catalogBridge';
import { menuApi } from '@/api/menu';
import { toast } from '@/hooks/use-toast';
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
import { MenuItemForm } from './MenuItemForm';
import { ImportMenuDialog } from './ImportMenuDialog';
import { formatPrice } from './menuItem';
import { formatWWPrice } from '@/lib/pricingMode';

const groupCount = (item: MenuItem) => item.modifierGroups?.length ?? 0;

/**
 * Admin editing screen for the F&B menu.
 *
 * The list is the shared catalog store, which `loadMenuFromApi` fills from the
 * branch's `pos.product` rows. Two things write, and they write to different
 * places: Export and Import go to the platform, and an applied import is
 * re-read into the store here; Add item, edit and delete still go through the
 * store's mutators alone, so those reach the F&B order station on its next
 * mount and no further. The banner says as much, and says it in those terms.
 */
export function MenuPanel() {
  const { menuItems, menuCategories, mutators } = useCatalogStore();
  const orderedCategories = [...menuCategories].sort(
    (a, b) => a.sortOrder - b.sortOrder
  );

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MenuItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const branch = getActiveBranch();
  const apiBranchId = apiBranchIdForSlug(branch.id);

  /**
   * The export is the platform's, and there is only one writer of this file.
   *
   * There were two for a while — one here and one in the API — and they did not
   * agree: this one wrote seven category columns where the file has nine, and
   * filled a missing code from the row's own key, which became a UUID the moment
   * the menu was read from the database and was then refused by the import's own
   * code rule. A workbook the Import cannot read is not an export. So the button
   * downloads what the Import parses, and the browser keeps no opinion about the
   * format at all.
   *
   * It still doubles as the template on an empty menu: the platform writes the
   * headers, the help sheet and three example rows marked `example`, which its
   * own parser skips.
   */
  const exportMenu = async () => {
    if (!apiBranchId) return;
    setExporting(true);
    try {
      const { blob, filename } = await menuApi.exportWorkbook(apiBranchId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        title: 'Could not export the menu',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  };

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
      {/* NOT the shared `NotSavedNotice`: on this panel that sentence would read
          "the database never does" directly above an Import that writes to it.
          Half of this screen is real and half is not, and the notice has to say
          which half is which. The ticket is still read from the classification
          in `CatalogStoreContext`, so a mutator that gets wired and leaves that
          map stops this compiling. */}
      <AdminNoticeBanner>
        <strong className="font-semibold">
          Half saved — {MOCK_MUTATOR_TICKETS.upsertMenuItem}.
        </strong>{' '}
        The list below is read from the database. Export hands you that same data as a
        spreadsheet and Import writes it back — an import you apply is stored and
        survives a reload. Add item, the pencil and the bin are not wired yet: those
        three stay in this browser tab, and a reload discards them.
      </AdminNoticeBanner>

      {!apiBranchId && (
        <AdminNoticeBanner>
          <strong className="font-semibold">This branch is not on the platform.</strong>{' '}
          “{branch.name}” has no record in the database, so there is no menu to export
          and nowhere to import into. Create the branch under Branches first.
        </AdminNoticeBanner>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground/50">
          {menuItems.length} {menuItems.length === 1 ? 'item' : 'items'}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => void exportMenu()}
            disabled={!apiBranchId || exporting}
          >
            <Download className="w-4 h-4" />
            Export
          </Button>
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => setImportOpen(true)}
            disabled={!apiBranchId}
          >
            <Upload className="w-4 h-4" />
            Import
          </Button>
          <Button onClick={openAdd}>
            <Plus className="w-4 h-4" />
            Add item
          </Button>
        </div>
      </div>

      {menuItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          No menu items yet. Use “Add item” to create one.
          <span className="mt-2 block text-foreground/40">
            Or press{' '}
            <button
              type="button"
              onClick={() => void exportMenu()}
              disabled={!apiBranchId || exporting}
              className="font-medium text-foreground/70 underline underline-offset-4 hover:text-foreground disabled:no-underline disabled:opacity-50"
            >
              Export
            </button>{' '}
            for a spreadsheet to fill in — it comes with the columns, an example of
            each and a sheet explaining them — then Import it back.
          </span>
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

      <ImportMenuDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        branchId={apiBranchId}
        // The commit wrote to the database; the store still holds what was on
        // screen before it. Re-reading is what puts the new prices on this list
        // and on the F&B grid.
        onApplied={() => {
          void loadMenuFromApi(branch.id).catch((err: unknown) => {
            toast({
              title: 'Imported, but the screen could not be refreshed',
              description: err instanceof Error ? err.message : 'Reload the page to see it.',
              variant: 'destructive',
            });
          });
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
