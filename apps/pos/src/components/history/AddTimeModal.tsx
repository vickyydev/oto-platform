import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import type { ExtensionOption } from '@/mockApi';
import { Clock } from 'lucide-react';
import { getEnabledPaymentMethods, paymentMethodIcon } from '@/lib/payments';

export interface AddTimeResult {
  label: string;
  minutesAdded: number;
  amountTHB: number;
  braceletCount: number;
  paymentMethod: string;
}

interface AddTimeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Total bracelets on the booking; staff can extend some or all. */
  braceletCount: number;
  options: ExtensionOption[];
  operatorName: string;
  onConfirm: (result: AddTimeResult) => void;
}

export function AddTimeModal({
  open,
  onOpenChange,
  braceletCount,
  options,
  operatorName,
  onConfirm,
}: AddTimeModalProps) {
  const methods = getEnabledPaymentMethods();
  const [optionId, setOptionId] = useState('');
  const [count, setCount] = useState(braceletCount);
  const [method, setMethod] = useState<string>('');

  useEffect(() => {
    if (open) {
      setOptionId('');
      setCount(braceletCount);
      setMethod('');
    }
  }, [open, braceletCount]);

  const option = options.find((o) => o.id === optionId) ?? null;
  const amountTHB = option ? option.pricePerBracelet * count : 0;
  const canConfirm = !!option && !!method && count > 0 && amountTHB > 0;
  const allSelected = count >= braceletCount;

  const handleConfirm = () => {
    if (!option || !method || count < 1) return;
    onConfirm({
      label: option.label,
      minutesAdded: option.minutes,
      amountTHB,
      braceletCount: count,
      paymentMethod: method,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Add time
          </DialogTitle>
          <DialogDescription>
            By {operatorName} · extend some or all of the {braceletCount} bracelet
            {braceletCount > 1 ? 's' : ''} on this booking.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* How many bracelets */}
          {braceletCount > 1 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">How many bracelets?</p>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <QuantityStepper
                    value={count}
                    onChange={setCount}
                    min={1}
                    max={braceletCount}
                    ariaLabel="bracelet"
                  />
                  <span className="text-sm text-muted-foreground">
                    of {braceletCount}
                  </span>
                </div>
                <Button
                  type="button"
                  variant={allSelected ? 'default' : 'outline'}
                  className="h-11"
                  onClick={() => setCount(braceletCount)}
                >
                  All {braceletCount}
                </Button>
              </div>
            </div>
          )}

          {/* Duration */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">How much time?</p>
            <div className="space-y-2">
              {options.map((o) => {
                const active = o.id === optionId;
                const lineTotal = o.pricePerBracelet * count;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setOptionId(o.id)}
                    className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                      active ? 'border-primary ring-1 ring-primary bg-primary/5' : 'hover:bg-muted'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold">{o.label}</span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        ฿{o.pricePerBracelet} × {count} bracelet
                        {count > 1 ? 's' : ''}
                      </span>
                    </span>
                    <span className="font-bold tabular-nums shrink-0">฿{lineTotal}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Payment method */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              Payment <span className="text-destructive">*</span>
            </p>
            <div className="grid grid-cols-3 gap-2">
              {methods.map((m) => {
                const Icon = paymentMethodIcon(m.kind);
                return (
                  <Button
                    key={m.id}
                    type="button"
                    variant={method === m.id ? 'default' : 'outline'}
                    className="h-14 flex-col gap-1"
                    onClick={() => setMethod(m.id)}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-xs">{m.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Summary */}
          <div className="rounded-lg bg-muted p-4 flex items-center justify-between">
            <span className="text-muted-foreground">Amount to charge</span>
            <span className="text-2xl font-black tabular-nums">฿{amountTHB}</span>
          </div>

          <Button className="w-full h-14 text-lg" disabled={!canConfirm} onClick={handleConfirm}>
            {!option
              ? 'Choose a duration'
              : !method
                ? 'Choose a payment method'
                : `Charge ฿${amountTHB} & extend ${count} bracelet${count > 1 ? 's' : ''}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
