import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface StockAdjustModalProps {
  open: boolean;
  itemName: string;
  variantLabel: string;
  currentStock: number;
  onClose: () => void;
  /** Called with the signed delta and a required reason note. */
  onAdjust: (delta: number, reason: string) => void;
}

const QUICK_REASONS = [
  'Received shipment',
  'Inventory recount',
  'Damaged / shrinkage',
  'Staff use',
];

/**
 * Stamped stock adjustment modal for the Inventory admin panel. Supports both
 * positive (receive) and negative (shrinkage / correction) deltas. The reason
 * is required and logged with the operator name.
 */
export function StockAdjustModal({
  open,
  itemName,
  variantLabel,
  currentStock,
  onClose,
  onAdjust,
}: StockAdjustModalProps) {
  const [deltaStr, setDeltaStr] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const reset = () => {
    setDeltaStr('');
    setReason('');
    setError('');
  };

  const handleOpenChange = (o: boolean) => {
    if (!o) { reset(); onClose(); }
  };

  const delta = Number(deltaStr);
  const newStock = Math.max(0, currentStock + delta);
  const isValid = deltaStr.trim() !== '' && !isNaN(delta) && delta !== 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) { setError('Enter a non-zero adjustment amount.'); return; }
    if (!reason.trim()) { setError('A reason is required.'); return; }
    onAdjust(delta, reason.trim());
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Adjust stock — {itemName}</DialogTitle>
          <DialogDescription>
            Variant: <strong>{variantLabel}</strong> · Current: <strong>{currentStock}</strong>
          </DialogDescription>
        </DialogHeader>

        <form id="stock-adj-form" onSubmit={handleSubmit} className="flex flex-col gap-5 pt-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adj-delta">Adjustment (+/−) *</Label>
            <Input
              id="adj-delta"
              type="number"
              placeholder="e.g. +24 or -3"
              value={deltaStr}
              onChange={(e) => { setDeltaStr(e.target.value); setError(''); }}
            />
            {isValid && (
              <p className="text-xs text-foreground/50">
                New stock after adjustment: <strong className="text-foreground">{newStock}</strong>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Reason *</Label>
            <div className="flex flex-wrap gap-2">
              {QUICK_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => { setReason(r); setError(''); }}
                  className={`rounded-full border px-3 py-1 text-xs transition-all ${
                    reason === r
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-foreground/20 text-foreground/60 hover:border-foreground/40'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <Input
              placeholder="Or type a custom reason…"
              value={reason}
              onChange={(e) => { setReason(e.target.value); setError(''); }}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button type="submit" form="stock-adj-form">
            Apply adjustment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
