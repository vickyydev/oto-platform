import { useState } from 'react';
import { Plus, Pencil, Star, StarOff, ToggleLeft, ToggleRight } from 'lucide-react';
import { StockLocation, StockLocationType } from '@/types';
import { stockApi, stockErrorWords } from '@/api/stock';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

const TYPE_LABELS: Record<StockLocationType, string> = {
  bulk: 'Bulk store',
  back_of_house: 'Back of house',
  rotation: 'FOH rotation',
};

const TYPE_COLORS: Record<StockLocationType, string> = {
  bulk: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
  back_of_house: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  rotation: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

interface LocationFormState {
  name: string;
  type: StockLocationType;
}

interface LocationFormDialogProps {
  open: boolean;
  location: StockLocation | null;
  /** True when editing a location that is currently the active sell point. When
   *  true the type selector is locked to 'rotation' — changing type would
   *  invalidate the sell-point invariant (only rotation locations may be the
   *  sell point). Manager must reassign the sell point before changing type. */
  isSellPoint?: boolean;
  onClose: () => void;
  onSave: (patch: { name: string; type: StockLocationType }) => void;
}

function LocationFormDialog({ open, location, isSellPoint, onClose, onSave }: LocationFormDialogProps) {
  const [name, setName] = useState(location?.name ?? '');
  const [type, setType] = useState<StockLocationType>(location?.type ?? 'bulk');
  const [error, setError] = useState('');

  const handleOpen = (o: boolean) => {
    if (o) {
      setName(location?.name ?? '');
      setType(location?.type ?? 'bulk');
      setError('');
    } else {
      onClose();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    // Defensive guard: if editing the sell-point, type must stay 'rotation'.
    if (isSellPoint && type !== 'rotation') {
      setError('Cannot change the type of the active sell-point location. Assign another sell point first.');
      return;
    }
    onSave({ name: name.trim(), type });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{location ? 'Edit location' : 'New stock location'}</DialogTitle>
          <DialogDescription>
            Stock locations are shared by all inventory items at this branch.
          </DialogDescription>
        </DialogHeader>

        <form id="loc-form" onSubmit={handleSubmit} className="flex flex-col gap-4 pt-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loc-name">Location name *</Label>
            <Input
              id="loc-name"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="e.g. Front Counter"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loc-type">Type *</Label>
            <select
              id="loc-type"
              value={type}
              onChange={(e) => setType(e.target.value as StockLocationType)}
              disabled={!!isSellPoint}
              className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm disabled:opacity-50"
            >
              <option value="bulk">Bulk store — accounting/warehouse storage</option>
              <option value="back_of_house">Back of house — staging area</option>
              <option value="rotation">FOH rotation — front-of-house sell point</option>
            </select>
            {isSellPoint ? (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Type is locked — this is the active sell point. Assign another sell point before changing its type.
              </p>
            ) : (
              <p className="text-[11px] text-foreground/40">
                Only "rotation" locations can be set as the sell point (where sales decrement from).
              </p>
            )}
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="loc-form">
            {location ? 'Save changes' : 'Create location'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Manager-only stock locations admin panel. Lists all locations (active + retired),
 * supports add / rename / type-edit / toggle-active / set-sell-point.
 *
 * Sell-point rule: exactly one rotation location per branch should be the sell point —
 * the location from which sales decrement stock by default. Setting a new sell point
 * clears the flag from all other locations.
 */
export function StockLocationsPanel({
  branchId,
  locations: allLocations,
}: {
  /** The platform branch whose places these are (S2-14b round 2). */
  branchId: string | null;
  /** Every place of the branch, retired ones included, from the platform. */
  locations: StockLocation[];
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StockLocation | null>(null);

  /**
   * One write to the platform, which holds every rule below too — exactly one
   * active sell point, only a FOH rotation place, never retired or retyped — so
   * a refusal arrives in the same words whichever screen sent it.
   */
  const run = async (write: (branch: string) => Promise<unknown>): Promise<boolean> => {
    if (!branchId) return false;
    try {
      await write(branchId);
      return true;
    } catch (err) {
      alert(stockErrorWords(err));
      return false;
    }
  };

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (loc: StockLocation) => {
    setEditing(loc);
    setFormOpen(true);
  };

  const handleSave = async ({ name, type }: LocationFormState) => {
    let ok: boolean;
    if (editing) {
      // Sell-point invariant: if this location is the active sell point, its
      // type cannot be changed to non-rotation (the platform enforces this too,
      // but we guard here for a clear UX error rather than a round trip).
      if (editing.sellPoint && editing.active && type !== 'rotation') {
        // This branch should not be reachable: the dialog disables the type
        // select and validates before calling onSave. Abort defensively.
        return;
      }
      ok = await run((branch) => stockApi.updateLocation(branch, editing.id, { name, type }));
    } else {
      // The platform makes a new FOH rotation place the sell point when the
      // branch has none, so the branch is never left without one after the
      // first rotation location is configured.
      ok = await run((branch) => stockApi.createLocation(branch, { name, type }));
    }
    if (!ok) return;
    setFormOpen(false);
    setEditing(null);
  };

  const toggleActive = (loc: StockLocation) => {
    // Cannot retire the sell-point location — it must remain active.
    if (loc.sellPoint && loc.active) {
      alert('Cannot retire the active sell-point location. Assign another sell point first.');
      return;
    }
    void run((branch) => stockApi.updateLocation(branch, loc.id, { active: !loc.active }));
  };

  const setSellPoint = (loc: StockLocation) => {
    if (loc.type !== 'rotation') {
      alert('Only rotation (FOH) locations can be the sell point.');
      return;
    }
    if (!loc.active) {
      alert('Cannot set an inactive location as the sell point. Activate it first.');
      return;
    }
    void run((branch) => stockApi.setSellPoint(branch, loc.id));
  };

  const active = allLocations.filter((l) => l.active);
  const retired = allLocations.filter((l) => !l.active);
  const sellPointCount = allLocations.filter((l) => l.sellPoint && l.active).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-foreground/50">
            {active.length} active · {retired.length} retired
          </p>
          {sellPointCount === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
              No sell point set — sales cannot decrement stock by location until one is designated.
            </p>
          )}
          {sellPointCount > 1 && (
            <p className="text-xs text-destructive mt-0.5">
              {sellPointCount} sell points active — should be exactly one per branch.
            </p>
          )}
        </div>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4" />
          New location
        </Button>
      </div>

      {allLocations.length === 0 && (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          No stock locations configured yet.
        </div>
      )}

      {active.length > 0 && (
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-foreground/40">
            Active locations
          </h3>
          <div className="flex flex-col gap-2">
            {active.map((loc) => (
              <LocationRow
                key={loc.id}
                loc={loc}
                onEdit={() => openEdit(loc)}
                onToggle={() => toggleActive(loc)}
                onSetSellPoint={() => setSellPoint(loc)}
              />
            ))}
          </div>
        </section>
      )}

      {retired.length > 0 && (
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-foreground/40">
            Retired locations
          </h3>
          <div className="flex flex-col gap-2">
            {retired.map((loc) => (
              <LocationRow
                key={loc.id}
                loc={loc}
                onEdit={() => openEdit(loc)}
                onToggle={() => toggleActive(loc)}
                onSetSellPoint={() => setSellPoint(loc)}
              />
            ))}
          </div>
        </section>
      )}

      <p className="text-xs text-foreground/35 leading-relaxed">
        The <strong className="text-foreground/50">sell point</strong> is the FOH rotation location from which sales
        decrement stock by default. Exactly one should be active per branch. Retiring a location hides it from staff stock
        ops but keeps historical records intact.
      </p>

      <LocationFormDialog
        open={formOpen}
        location={editing}
        isSellPoint={!!(editing?.sellPoint && editing?.active)}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        onSave={(patch) => void handleSave(patch)}
      />
    </div>
  );
}

function LocationRow({
  loc,
  onEdit,
  onToggle,
  onSetSellPoint,
}: {
  loc: StockLocation;
  onEdit: () => void;
  onToggle: () => void;
  onSetSellPoint: () => void;
}) {
  const isRetired = !loc.active;

  return (
    <div
      className={`rounded-2xl border p-4 flex items-center gap-3 ${
        isRetired
          ? 'border-foreground/8 bg-foreground/[0.01] opacity-60'
          : 'border-foreground/10 bg-foreground/[0.02]'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`font-medium ${isRetired ? 'line-through text-foreground/50' : ''}`}>
            {loc.name}
          </span>
          <span className={`text-[11px] rounded-full px-2 py-0.5 font-medium ${TYPE_COLORS[loc.type]}`}>
            {TYPE_LABELS[loc.type]}
          </span>
          {loc.sellPoint && loc.active && (
            <Badge className="gap-1 text-[11px] bg-primary/10 text-primary hover:bg-primary/10 border border-primary/20">
              <Star className="w-3 h-3 fill-current" />
              Sell point
            </Badge>
          )}
          {isRetired && (
            <Badge variant="outline" className="text-[11px] text-foreground/40">
              Retired
            </Badge>
          )}
        </div>
        <p className="text-[11px] text-foreground/40 mt-0.5 font-mono">{loc.id}</p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Sell-point toggle — only for rotation locations */}
        {loc.type === 'rotation' && loc.active && !loc.sellPoint && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs text-foreground/50 hover:text-primary"
            onClick={onSetSellPoint}
            title="Set as sell point"
          >
            <StarOff className="w-3.5 h-3.5" />
            Set sell pt
          </Button>
        )}

        {/* Active toggle */}
        <Button
          variant="ghost"
          size="sm"
          className={`h-8 gap-1 text-xs ${loc.active ? 'text-foreground/50 hover:text-amber-500' : 'text-foreground/40 hover:text-emerald-500'}`}
          onClick={onToggle}
          title={loc.active ? 'Retire location' : 'Reactivate location'}
        >
          {loc.active ? (
            <ToggleRight className="w-4 h-4 text-emerald-500" />
          ) : (
            <ToggleLeft className="w-4 h-4" />
          )}
          {loc.active ? 'Active' : 'Retired'}
        </Button>

        {/* Edit */}
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={onEdit} aria-label={`Edit ${loc.name}`}>
          <Pencil className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
