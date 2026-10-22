import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useOperatorMenuCapability, type MenuPanelPorts } from '../../../runtime/menu';
import { useEffect, useRef, useState } from "react";
import { Download, Pencil, Trash2, Plus, SlidersHorizontal, Upload } from "lucide-react";
import { type MenuItem, INVENTORY_DEFAULT_VARIANT_ID } from "../../../model/types";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";




import { Button } from "../../ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import { AdminNoticeBanner } from "../NotSavedNotice";
import { MenuItemFormWithPorts } from "./MenuItemForm";
import { ImportMenuDialogWithPorts } from "./ImportMenuDialog";
import { formatPrice } from "./menuItem";


const groupCount = (item: MenuItem) => item.modifierGroups?.length ?? 0;

/**
 * Admin editing screen for the F&B menu.
 *
 * The list is the shared catalog store, which `loadMenuFromApi` fills from the
 * branch's `pos.product` rows, and everything on this screen writes back to
 * them: Export and Import go through the platform, and since SCRUM-341 so do
 * Add item, the pencil and the bin. Each save re-reads the branch's menu
 * (`reloadMenuInto`), so what is on the list is what the database holds and a
 * refused save leaves the refusal's own answer on screen rather than the edit.
 *
 * The one part that reaches no route is Track stock — see the banner.
 */
export function MenuPanel() {
  const runtime = useAdminScreenRuntime();
  const branch = runtime.reads.getActiveBranch();
  const apiBranchId = runtime.api.catalogBridge.apiBranchIdForSlug(branch.id);
  const scope = useOperatorMenuCapability(runtime.transport, runtime.session.operator?.id, apiBranchId !== null, runtime.session.operator, apiBranchId ?? undefined);
  const { menuItems, menuCategories, modifierGroups, mutators } = useCatalogStore();
  return <MenuPanelWithPorts ports={{ menuItems, menuCategories, modifierGroups, menuHelpers: runtime.domain.menu, branch, apiBranchId,
    fileApi: runtime.api.menu.menuApi, onImported: async () => { await runtime.api.catalogBridge.loadMenuFromApi(branch.id); }, toast: runtime.toast,
    formatWWPrice: runtime.domain.pricingMode.formatWWPrice, ...mutators, canManageInlineGroups: scope.canManage,
    canCreate: scope.canManageBranch, canExport: scope.canManageBranch, canImport: scope.canImport,
    canManageItem: item => scope.canManageProduct(runtime.api.menu.serverFieldsFor(item.id)?.branchId) }} />;
}

export function MenuPanelWithPorts({ ports }: { ports: MenuPanelPorts }) {
  const { menuItems, menuCategories, branch, apiBranchId, toast, formatWWPrice, fileApi: menuApi } = ports;
  const mutators = ports;
  const orderedCategories = [...menuCategories].sort(
    (a, b) => a.sortOrder - b.sortOrder
  );

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MenuItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deleteTarget = useRef(pendingDelete);
  deleteTarget.current = pendingDelete;
  const currentBranch = useRef(apiBranchId);
  currentBranch.current = apiBranchId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canManage = (item: MenuItem) => ports.canManageItem?.(item) ?? true;

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
    if (!apiBranchId || exportingRef.current || ports.canExport === false) return;
    const targetBranch = apiBranchId;
    exportingRef.current = true;
    setExporting(true);
    try {
      const { blob, filename } = await menuApi.exportWorkbook(apiBranchId);
      if (!mounted.current || currentBranch.current !== targetBranch) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (mounted.current && currentBranch.current === targetBranch) toast({
        title: 'Could not export the menu',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      exportingRef.current = false;
      if (mounted.current) setExporting(false);
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

  const confirmDelete = async () => {
    if (!pendingDelete || deletingRef.current || !canManage(pendingDelete)) return;
    const target = pendingDelete;
    deletingRef.current = true;
    setDeleting(true);
    setWriteError(null);
    try {
      await mutators.deleteMenuItem(target.id);
      if (mounted.current && deleteTarget.current === target) setPendingDelete(null);
    } catch (failure) {
      if (mounted.current && deleteTarget.current === target) setWriteError(failure instanceof Error ? failure.message : 'The menu item could not be deleted.');
    } finally { deletingRef.current = false; if (mounted.current) setDeleting(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <AdminNoticeBanner>
        To start stock tracking, link the item in Inventory. Turning Track stock
        on here alone does not create that link. Manage stock counts in Inventory.
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
            disabled={!apiBranchId || exporting || ports.canExport === false}
          >
            <Download className="w-4 h-4" />
            Export
          </Button>
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => setImportOpen(true)}
            disabled={!apiBranchId || ports.canImport === false}
          >
            <Upload className="w-4 h-4" />
            Import
          </Button>
          {ports.canCreate !== false && <Button onClick={openAdd}>
            <Plus className="w-4 h-4" />
            Add item
          </Button>}
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
              disabled={!apiBranchId || exporting || ports.canExport === false}
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
                        {canManage(item) && <div className="flex shrink-0 items-center gap-2">
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
                        </div>}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {formOpen && <MenuItemFormWithPorts
        ports={ports}
        open={formOpen}
        item={editing}
        onClose={() => setFormOpen(false)}
        onSave={async (item, trackStock) => {
          // Reconcile the inventory link to match the "Track stock" toggle. Turning
          // it on links a single Default-variant inventory item (size variants are
          // added in the Inventory panel); turning it off removes the link.
          // Both halves of this are the browser tab's: the item body carries no
          // stock field (`api/menu.ts:menuItemToApiBody`), so the re-read after
          // the save drops the link again. The banner above says so.
          let next = item;
          const hasLink = !!item.inventoryItemId;
          if (trackStock && !hasLink) {
            const invId = `inv-${item.id}`;
            await mutators.upsertInventoryItem({
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
            await mutators.deleteInventoryItem(item.inventoryItemId!);
            next = { ...item, inventoryItemId: undefined };
          }
          if (!mounted.current) throw new Error('The menu screen changed before the item could be saved.');
          await mutators.upsertMenuItem(next);
        }}
      />}

      {importOpen && <ImportMenuDialogWithPorts
        api={menuApi}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        branchId={apiBranchId}
        // The commit wrote to the database; the store still holds what was on
        // screen before it. Re-reading is what puts the new prices on this list
        // and on the F&B grid.
        onApplied={async () => {
          try { await ports.onImported(); } catch (err: unknown) {
            if (mounted.current && currentBranch.current === apiBranchId) toast({
              title: 'Imported, but the screen could not be refreshed',
              description: err instanceof Error ? err.message : 'Reload the page to see it.',
              variant: 'destructive',
            });
          }
        }}
      />}

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
