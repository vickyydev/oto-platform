import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

/**
 * A size the picker offers: an inventory variant with its count, or a size the
 * platform defines on the item (S2-09b), which has no count yet — stock per
 * size is S2-14b. A size with no count is offered with no badge and is never
 * greyed out, because "unknown" is not "none left".
 */
export interface PickableVariant {
  id: string;
  label: string;
  stock?: number;
  lowStockThreshold?: number;
}

interface VariantPickerModalProps {
  open: boolean;
  itemName: string;
  variants: PickableVariant[];
  onPick: (variantId: string) => void;
  onCancel: () => void;
}

function stockBadge(v: PickableVariant) {
  if (v.stock === undefined) return null;
  if (v.stock <= 0)
    return <Badge variant="destructive" className="text-xs">Out</Badge>;
  if (v.lowStockThreshold !== undefined && v.stock <= v.lowStockThreshold)
    return <Badge className="text-xs bg-amber-500 hover:bg-amber-500">{v.stock} left</Badge>;
  return <Badge variant="secondary" className="text-xs">{v.stock}</Badge>;
}

/**
 * Variant picker shown when an item has more than one size/type — the sizes
 * the platform defines on it (S2-09b), or a stocked item's inventory variants
 * (e.g. grip socks S/M/L). Staff taps a variant to select it; tapping a variant
 * counted out of stock is blocked.
 */
export function VariantPickerModal({
  open,
  itemName,
  variants,
  onPick,
  onCancel,
}: VariantPickerModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Choose size — {itemName}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {variants.map((v) => {
            const oos = v.stock !== undefined && v.stock <= 0;
            return (
              <button
                key={v.id}
                disabled={oos}
                onClick={() => onPick(v.id)}
                className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 p-5 transition-all
                  ${oos
                    ? 'opacity-40 cursor-not-allowed border-muted'
                    : 'cursor-pointer border-border hover:border-primary hover:bg-primary/10 active:scale-95'
                  }`}
              >
                <span className="text-2xl font-bold">{v.label}</span>
                {stockBadge(v)}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
