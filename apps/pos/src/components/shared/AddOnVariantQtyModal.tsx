import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { InventoryVariant, AddOnVariantQty } from '@/types';

interface AddOnVariantQtyModalProps {
  open: boolean;
  itemName: string;
  variants: InventoryVariant[];
  /** The breakdown already on the line (so re-opening keeps prior picks). */
  initial: AddOnVariantQty[];
  onConfirm: (breakdown: AddOnVariantQty[]) => void;
  onCancel: () => void;
}

function stockBadge(v: InventoryVariant) {
  if (v.stock <= 0) return <Badge variant="destructive" className="text-xs">Out</Badge>;
  if (v.lowStockThreshold !== undefined && v.stock <= v.lowStockThreshold)
    return <Badge className="text-xs bg-amber-500 hover:bg-amber-500">{v.stock} left</Badge>;
  return <Badge variant="secondary" className="text-xs">{v.stock} in stock</Badge>;
}

/**
 * Per-size quantity editor for a multi-variant stocked add-on (e.g. grip socks
 * S/M/L), so different kids on one ticket can take different sizes. Each row is
 * clamped to that variant's remaining stock — no oversell. Confirming returns the
 * non-zero breakdown; clearing all sizes removes the add-on.
 */
export function AddOnVariantQtyModal({
  open,
  itemName,
  variants,
  initial,
  onConfirm,
  onCancel,
}: AddOnVariantQtyModalProps) {
  const [qty, setQty] = useState<Record<string, number>>({});

  // Seed from the existing breakdown each time the modal opens.
  useEffect(() => {
    if (!open) return;
    const seed: Record<string, number> = {};
    for (const b of initial) seed[b.variantId] = b.quantity;
    setQty(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const total = Object.values(qty).reduce((sum, n) => sum + n, 0);

  const handleConfirm = () => {
    const breakdown: AddOnVariantQty[] = variants
      .filter((v) => (qty[v.id] ?? 0) > 0)
      .map((v) => ({ variantId: v.id, variantLabel: v.label, quantity: qty[v.id] }));
    onConfirm(breakdown);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Choose sizes — {itemName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 mt-2">
          {variants.map((v) => {
            const current = qty[v.id] ?? 0;
            return (
              <div
                key={v.id}
                className="flex items-center justify-between gap-3 rounded-xl border p-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xl font-bold w-10 text-center">{v.label}</span>
                  {stockBadge(v)}
                </div>
                <QuantityStepper
                  value={current}
                  onChange={(n) => setQty((prev) => ({ ...prev, [v.id]: Math.min(n, v.stock) }))}
                  max={v.stock}
                  size="sm"
                  ariaLabel={`${itemName} ${v.label}`}
                />
              </div>
            );
          })}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>{total > 0 ? `Add ${total}` : 'Clear'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
