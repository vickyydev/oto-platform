import { useEffect, useState } from 'react';
import type { MerchItem } from '@/types';
import { useOperator } from '@/auth/OperatorContext';
import { recordMerchStockAdjustment } from '@/mockApi';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface MerchStockAdjustModalProps {
  open: boolean;
  item: MerchItem | null;
  onClose: () => void;
  /** Called after a successful, stamped adjustment so the panel can refresh. */
  onAdjusted: () => void;
}

type Direction = 'add' | 'remove';

/**
 * Stamped manual stock adjustment for one merch item (Admin). Writes through
 * mockApi.recordMerchStockAdjustment so the change is logged to the audit trail
 * AND applied to on-hand stock in the shared store. The operator (auth context)
 * is the single source of truth for "who" — adjustments are stamped with it.
 */
export function MerchStockAdjustModal({
  open,
  item,
  onClose,
  onAdjusted,
}: MerchStockAdjustModalProps) {
  const { operator } = useOperator();
  const [direction, setDirection] = useState<Direction>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDirection('add');
    setAmount('');
    setReason('');
    setError(null);
  }, [open, item]);

  if (!item) return null;

  const amountNum = Number(amount);
  const delta = direction === 'add' ? amountNum : -amountNum;
  const projected = Math.max(0, (item.stock ?? 0) + (Number.isFinite(delta) ? delta : 0));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!operator) {
      setError('You must be signed in to stamp a stock adjustment.');
      return;
    }
    if (amount.trim() === '' || Number.isNaN(amountNum) || amountNum <= 0) {
      setError('Enter a quantity greater than 0.');
      return;
    }
    if (!reason.trim()) {
      setError('A reason is required for the audit trail.');
      return;
    }
    recordMerchStockAdjustment({
      merchItemId: item.id,
      delta,
      reason: reason.trim(),
      adjustedBy: operator.name,
      adjustedById: operator.id,
    });
    onAdjusted();
    onClose();
  };

  const dirBtn = (val: Direction) =>
    cn(
      'flex-1 rounded-xl border px-4 py-3 text-sm font-semibold transition-all',
      direction === val
        ? 'border-primary bg-primary/15 text-primary ring-1 ring-primary'
        : 'border-foreground/10 bg-foreground/5 text-foreground/50 hover:border-foreground/20 hover:text-foreground/80'
    );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust stock — {item.name}</DialogTitle>
          <DialogDescription>
            Record a stamped correction (receiving stock, shrinkage, or a recount).
            On-hand is currently <span className="font-semibold">{item.stock}</span>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex gap-3">
            <button type="button" className={dirBtn('add')} onClick={() => setDirection('add')}>
              Add (received)
            </button>
            <button
              type="button"
              className={dirBtn('remove')}
              onClick={() => setDirection('remove')}
            >
              Remove (shrinkage)
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ms-amount">Quantity</Label>
            <Input
              id="ms-amount"
              type="number"
              inputMode="numeric"
              min={1}
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ms-reason">Reason</Label>
            <Input
              id="ms-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. New delivery, damaged units, recount"
            />
          </div>

          <p className="rounded-xl bg-foreground/5 px-3 py-2 text-sm text-foreground/60">
            New on-hand will be{' '}
            <span className="font-semibold tabular-nums text-foreground">{projected}</span>.
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Record adjustment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
