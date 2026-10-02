import { useMemo, useState } from 'react';
import { SelectedAddOn, AddOnVariantQty, type AddOn, type InventoryItem } from '@/types';
import { getAddOns } from '@/mockApi';
import { inventoryFor, useSellableStockVersion } from '@/api/stock';
import { catalogueSizesOf } from '@/api/menu';
import { addOnVariantSummary } from '@/lib/pricing';
import { resolveRateToday } from '@/lib/pricingMode';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { AddOnVariantQtyModal } from '@/components/shared/AddOnVariantQtyModal';
import { Button } from '@/components/ui/button';
import { Ruler } from 'lucide-react';

interface AddOnsGridProps {
  /** Add-ons currently on the line (with their quantities). */
  selected: SelectedAddOn[];
  /**
   * Set the quantity of a single add-on on the line (0 removes it).
   * variantId is set when the add-on is single-variant stocked.
   */
  onSetQuantity: (addOnId: string, quantity: number, variantId?: string) => void;
  /**
   * Set the per-size breakdown of a multi-variant stocked add-on (e.g. grip socks
   * S/M/L), so different kids on one ticket can take different sizes.
   */
  onSetVariants: (addOnId: string, breakdown: AddOnVariantQty[]) => void;
}

/**
 * The most of one size the picker offers when its count is not known — the
 * grid's own cap for an add-on that is not stock-tracked.
 */
const UNCOUNTED_CAP = 99;

/**
 * What the grid knows about a stocked add-on's sizes (S2-14b round 2, H2).
 *
 * The platform's counts when it has answered (`inventoryFor`). When it has not —
 * the sellable-stock read failed or has not come back — a tracked add-on sold
 * in sizes still has its sizes in the CATALOGUE (`catalogueSizesOf`), so the
 * till offers those, uncounted, rather than a stepper with no size: a line
 * with no size is refused at commit (`STOCK_SIZE_REQUIRED`), which left the
 * counter with nothing it could press. "Unknown" is not "none left"; the
 * platform's guard at commit is still the rule.
 */
export function addOnStockView(addon: Pick<AddOn, 'id' | 'inventoryItemId'>): { inv: InventoryItem | null; counted: boolean } {
  if (!addon.inventoryItemId) return { inv: null, counted: false };
  const inv = inventoryFor(addon.inventoryItemId);
  if (inv) return { inv, counted: true };
  const sizes = catalogueSizesOf(addon.id);
  if (sizes.length === 0) return { inv: null, counted: false };
  return {
    counted: false,
    inv: {
      id: addon.inventoryItemId,
      name: '',
      linkedKind: 'addon',
      linkedId: addon.id,
      variants: sizes.map((s) => ({ id: s.id, label: s.label, stock: UNCOUNTED_CAP })),
    },
  };
}

/**
 * The shared "Extras & Add-ons" grid. Reused by StepAddTicket and DropOffLineConfig
 * so both surfaces offer the SAME list from getAddOns() (including Regular Socks
 * which moved here from the Participants section). Each add-on takes any quantity;
 * stocked multi-variant add-ons (e.g. grip socks) open a per-size quantity editor
 * so one ticket can mix sizes, each decrementing its own stock.
 */
export function AddOnsGrid({ selected, onSetQuantity, onSetVariants }: AddOnsGridProps) {
  const allAddOns = useMemo(() => getAddOns(), []);
  // S2-14b — the counts are the platform's (`api/stock.ts`): re-draw when they move.
  useSellableStockVersion();

  // Which add-on's per-size editor is open
  const [sizeAddOnId, setSizeAddOnId] = useState<string | null>(null);

  const sizeAddOn = sizeAddOnId ? allAddOns.find((a) => a.id === sizeAddOnId) ?? null : null;
  const sizeInvItem = sizeAddOn ? addOnStockView(sizeAddOn).inv : null;
  const sizeInitial = sizeAddOnId
    ? selected.find((a) => a.id === sizeAddOnId)?.variantBreakdown ?? []
    : [];

  const handleChange = (addOnId: string, next: number) => {
    const addOn = allAddOns.find((a) => a.id === addOnId);
    if (!addOn) return;

    if (addOn.inventoryItemId) {
      const invItem = addOnStockView(addOn).inv;
      if (invItem && invItem.variants.length === 1) {
        // Single-variant: enforce stock limit before delegating.
        const singleVar = invItem.variants[0];
        if (singleVar && next > singleVar.stock) return;
        onSetQuantity(addOnId, next, singleVar?.id);
        return;
      }
    }

    onSetQuantity(addOnId, next);
  };

  const handleConfirmSizes = (breakdown: AddOnVariantQty[]) => {
    if (!sizeAddOnId) return;
    onSetVariants(sizeAddOnId, breakdown);
    setSizeAddOnId(null);
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        {allAddOns.map((addon) => {
          const selectedEntry = selected.find((a) => a.id === addon.id);
          const qty = selectedEntry?.quantity ?? 0;

          // Resolve stock from inventory for display (if linked); the catalogue's
          // sizes, uncounted, when the platform's counts have not answered (H2).
          const { inv: invItem, counted } = addOnStockView(addon);
          const isMultiVariant = (invItem?.variants.length ?? 0) > 1;
          const totalStock = invItem && counted
            ? invItem.variants.reduce((sum, v) => sum + v.stock, 0)
            : null;
          const isOos = totalStock !== null && totalStock <= 0;
          const breakdown = selectedEntry?.variantBreakdown ?? [];

          return (
            <div
              key={addon.id}
              className={`flex items-center justify-between gap-3 p-4 rounded-xl border transition-all ${
                qty > 0 ? 'bg-primary/10 border-primary' : ''
              } ${isOos ? 'opacity-50' : ''}`}
            >
              <div className="min-w-0">
                <div className="font-medium text-lg truncate">{addon.name}</div>
                <div className="text-primary font-semibold text-sm">+฿{resolveRateToday(addon.price)}</div>
                {isMultiVariant && breakdown.length > 0 && (
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">
                    {addOnVariantSummary(breakdown)}
                  </div>
                )}
                {isOos && <div className="text-xs text-destructive mt-0.5">Out of stock</div>}
              </div>
              {isMultiVariant ? (
                <Button
                  variant={qty > 0 ? 'default' : 'outline'}
                  size="sm"
                  className="gap-1.5 shrink-0"
                  disabled={isOos}
                  onClick={() => setSizeAddOnId(addon.id)}
                >
                  <Ruler className="w-4 h-4" />
                  {qty > 0 ? `${qty} · sizes` : 'Sizes'}
                </Button>
              ) : (
                <QuantityStepper
                  value={qty}
                  onChange={(next) => handleChange(addon.id, next)}
                  ariaLabel={addon.name}
                  max={isOos ? 0 : 99}
                />
              )}
            </div>
          );
        })}
      </div>

      {sizeAddOn && sizeInvItem && (
        <AddOnVariantQtyModal
          open={!!sizeAddOnId}
          itemName={sizeAddOn.name}
          variants={sizeInvItem.variants}
          initial={sizeInitial}
          onConfirm={handleConfirmSizes}
          onCancel={() => setSizeAddOnId(null)}
        />
      )}
    </>
  );
}
