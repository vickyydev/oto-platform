import { useState } from 'react';
import { Pencil, Trash2, Plus, SlidersHorizontal } from 'lucide-react';
import type { ModifierGroup } from '@/types';
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
import { NotSavedNotice } from '../NotSavedNotice';
import { ModifierGroupFormDialog } from './ModifierGroupFormDialog';

// Short human label for a group's selection rule (mirrors the order-station hint).
const ruleLabel = (g: ModifierGroup): string => {
  if (g.selectionType === 'single') {
    return g.required ? 'Choose one (required)' : 'Choose one (optional)';
  }
  const min = g.required ? (g.min ?? 1) : (g.min ?? 0);
  const max = g.max;
  if (max != null) return `Choose ${min}–${max}`;
  return min > 0 ? `Choose ${min}+` : 'Choose any';
};

/**
 * Admin editing screen for the SHARED modifier-group library. A group defined
 * here can be attached to many menu items (via the item editor), so a question
 * like “Spice level” lives in one place. Reads/writes the live shared store, so
 * edits flow to the POS order station in-session.
 *
 * Distinct from the inline per-item groups configured inside a menu item — those
 * stay item-specific. Deletion is blocked while any item still links the group.
 */
export function ModifiersPanel() {
  const { modifierGroups, menuItems, mutators } = useCatalogStore();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModifierGroup | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ModifierGroup | null>(null);

  // Count of menu items linking a given shared group (blocks deletion).
  const linkCount = (id: string) =>
    menuItems.filter((m) => m.linkedModifierGroupIds?.includes(id)).length;

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (group: ModifierGroup) => {
    setEditing(group);
    setFormOpen(true);
  };

  const pendingLinks = pendingDelete ? linkCount(pendingDelete.id) : 0;
  const pendingBlocked = pendingLinks > 0;

  const confirmDelete = () => {
    if (pendingDelete && linkCount(pendingDelete.id) === 0) {
      mutators.deleteModifierGroup(pendingDelete.id);
    }
    setPendingDelete(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <NotSavedNotice
        mutators={['upsertModifierGroup', 'deleteModifierGroup']}
        what="modifier groups, their options and their prices"
      />

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-foreground/60" />
            <h2 className="text-lg font-bold">Shared modifier groups</h2>
            <span className="text-sm text-foreground/40">
              ({modifierGroups.length})
            </span>
          </div>
          <Button onClick={openAdd}>
            <Plus className="w-4 h-4" />
            Add group
          </Button>
        </div>

        {modifierGroups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
            No shared groups yet. Use “Add group” to create one, then attach it to
            menu items from the item editor.
          </div>
        ) : (
          <>
            {/* Desktop: table */}
            <div className="hidden md:block overflow-hidden rounded-2xl border border-foreground/10">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Name</TableHead>
                    <TableHead className="w-48">Rule</TableHead>
                    <TableHead className="w-24 text-right">Options</TableHead>
                    <TableHead className="w-28 text-right">Used by</TableHead>
                    <TableHead className="w-32 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modifierGroups.map((group) => (
                    <TableRow key={group.id}>
                      <TableCell className="font-medium">{group.name}</TableCell>
                      <TableCell className="text-foreground/70">
                        {ruleLabel(group)}
                      </TableCell>
                      <TableCell className="tabular-nums text-right text-foreground/70">
                        {group.options.length}
                      </TableCell>
                      <TableCell className="tabular-nums text-right text-foreground/70">
                        {linkCount(group.id)} item
                        {linkCount(group.id) === 1 ? '' : 's'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => openEdit(group)}
                            aria-label={`Edit ${group.name}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setPendingDelete(group)}
                            aria-label={`Delete ${group.name}`}
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
              {modifierGroups.map((group) => (
                <div
                  key={group.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{group.name}</div>
                    <div className="text-sm text-foreground/60">
                      {ruleLabel(group)} · {group.options.length} option
                      {group.options.length === 1 ? '' : 's'}
                    </div>
                    <div className="text-xs tabular-nums text-foreground/40">
                      Used by {linkCount(group.id)} item
                      {linkCount(group.id) === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => openEdit(group)}
                      aria-label={`Edit ${group.name}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPendingDelete(group)}
                      aria-label={`Delete ${group.name}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* Form */}
      <ModifierGroupFormDialog
        open={formOpen}
        group={editing}
        onOpenChange={setFormOpen}
        onSave={mutators.upsertModifierGroup}
      />

      {/* Delete confirmation — blocked while any menu item still links it. */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingBlocked ? 'Can’t delete group' : 'Delete group?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {!pendingDelete
                ? ''
                : pendingBlocked
                  ? `“${pendingDelete.name}” is still linked by ${pendingLinks} menu item${
                      pendingLinks === 1 ? '' : 's'
                    }. Unlink it from those items first so nothing is left pointing at a missing group.`
                  : `“${pendingDelete.name}” will be removed and no longer available to attach to menu items.`}
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
