import { useState } from 'react';
import { Operator } from '@/types';
import { findOperatorByBenefitQrCode, getEffectiveBenefitProfile } from '@/mockApi';
import { isEmptyBenefitProfile } from '@/lib/benefits';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, ArrowRight, Gift, ScanLine } from 'lucide-react';

/** Scan (or type) a staff benefit QR code to apply that operator's benefit to the cart. */
export function BenefitScanModal({
  open,
  onOpenChange,
  onScanned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScanned: (operator: Operator) => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const value = code.trim();
    if (!value) return;
    const op = findOperatorByBenefitQrCode(value);
    if (!op) {
      setError(`No staff benefit found for "${value}".`);
      return;
    }
    if (isEmptyBenefitProfile(getEffectiveBenefitProfile(op))) {
      setError(`${op.name} has no benefit configured.`);
      return;
    }
    setError(null);
    setCode('');
    onScanned(op);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCode('');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Gift className="w-5 h-5 text-primary" />
            <DialogTitle>Scan staff benefit</DialogTitle>
          </div>
          <DialogDescription>
            Scan or type the staff member's benefit QR code to apply their comp,
            free items, credit, or discount to this order.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex gap-2"
        >
          <Input
            autoFocus
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Benefit QR code"
            className="h-12 text-lg"
          />
          <Button type="submit" size="lg" disabled={!code.trim()}>
            Apply
            <ArrowRight className="w-4 h-4" />
          </Button>
        </form>

        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-foreground/40">
          <ScanLine className="w-3.5 h-3.5 shrink-0" />
          Look up the staff member's QR in Admin → Staff Benefits.
        </div>
      </DialogContent>
    </Dialog>
  );
}
