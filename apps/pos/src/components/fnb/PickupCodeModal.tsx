import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NumberKeypad } from '@/components/till/NumberKeypad';
import { Hash } from 'lucide-react';

interface PickupCodeModalProps {
  open: boolean;
  total: number;
  initialCode?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (code: string) => void;
}

export function PickupCodeModal({
  open,
  total,
  initialCode = '',
  onOpenChange,
  onConfirm,
}: PickupCodeModalProps) {
  const [code, setCode] = useState(initialCode);

  useEffect(() => {
    if (open) setCode(initialCode);
  }, [open, initialCode]);

  const canConfirm = code.trim().length > 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(code.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl">Pick-up Code</DialogTitle>
          <DialogDescription>
            Key in the pick-up code for this order. It prints on the receipt and goes to the
            kitchen &amp; bar.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center my-2">
          <div className="flex items-center gap-2 min-h-16 px-6 rounded-2xl border bg-background min-w-[160px] justify-center">
            <Hash className="w-6 h-6 text-muted-foreground shrink-0" />
            {code ? (
              <span className="text-4xl font-bold tabular-nums tracking-widest">{code}</span>
            ) : (
              <span className="text-2xl text-muted-foreground">enter code</span>
            )}
          </div>
        </div>

        <NumberKeypad value={code} onChange={setCode} maxLength={6} />

        <div className="flex gap-3 mt-2 min-w-0">
          <Button
            variant="outline"
            size="lg"
            className="h-14 px-6 shrink-0"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="lg"
            className="flex-1 min-w-0 h-14 text-lg font-bold whitespace-normal leading-tight"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            Continue to Payment • ฿{total}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
