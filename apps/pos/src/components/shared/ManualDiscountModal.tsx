import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { TouchKeypad } from '@/components/shared/TouchKeypad';
import { ManualDiscount, DiscountComponentTarget } from '@/types';
import { resolveDiscountAmount } from '@/lib/manualDiscount';
import { componentKey } from '@/lib/pricing';
import { BadgePercent, Gift } from 'lucide-react';

/** A single discountable component of a line (kids/adults/socks/an add-on). */
export interface DiscountComponentOption {
  target: DiscountComponentTarget;
  label: string;
  amount: number;
}

export interface DiscountLineOption {
  id: string;
  label: string;
  amount: number;
  /** Present on ticket lines that can be broken into component targets. */
  components?: DiscountComponentOption[];
}

interface ManualDiscountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subtotal: number;
  lines: DiscountLineOption[];
  reasons: string[];
  operatorId: string;
  operatorName: string;
  onApply: (discount: ManualDiscount) => void;
}

type Scope = 'order' | 'line';
type DiscType = 'percent' | 'fixed' | 'comp';

export function ManualDiscountModal({
  open,
  onOpenChange,
  subtotal,
  lines,
  reasons,
  operatorId,
  operatorName,
  onApply,
}: ManualDiscountModalProps) {
  const [scope, setScope] = useState<Scope>('order');
  const [targetLineId, setTargetLineId] = useState<string | null>(null);
  // Null = the whole line; otherwise a specific component of the selected line.
  const [targetComponent, setTargetComponent] = useState<DiscountComponentTarget | null>(null);
  const [type, setType] = useState<DiscType>('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  // Reset to a clean slate each time the modal opens.
  useEffect(() => {
    if (open) {
      setScope('order');
      setTargetLineId(null);
      setTargetComponent(null);
      setType('percent');
      setValue('');
      setReason('');
      setNote('');
    }
  }, [open]);

  const selectedLine = lines.find((l) => l.id === targetLineId) ?? null;
  const selectedComponent =
    targetComponent && selectedLine?.components
      ? selectedLine.components.find(
          (c) => componentKey(c.target) === componentKey(targetComponent),
        ) ?? null
      : null;
  const base =
    scope === 'order'
      ? subtotal
      : selectedComponent
        ? selectedComponent.amount
        : selectedLine?.amount ?? 0;

  // Select either a whole line (component = null) or one of its components.
  const selectTarget = (lineId: string, component: DiscountComponentTarget | null) => {
    setTargetLineId(lineId);
    setTargetComponent(component);
  };
  const isSelected = (lineId: string, component: DiscountComponentTarget | null) =>
    targetLineId === lineId &&
    (component === null
      ? targetComponent === null
      : targetComponent !== null &&
        componentKey(targetComponent) === componentKey(component));

  const numericValue = Number(value) || 0;
  const draft: ManualDiscount = {
    id: '',
    scope,
    targetLineId: scope === 'line' ? targetLineId ?? undefined : undefined,
    targetComponent: scope === 'line' ? targetComponent ?? undefined : undefined,
    targetLabel:
      scope === 'line'
        ? selectedComponent?.label ?? selectedLine?.label
        : undefined,
    type,
    value: type === 'comp' ? 0 : numericValue,
    reason,
    note: note.trim() || undefined,
    amountTHB: 0,
    appliedBy: operatorName,
    appliedById: operatorId,
    appliedAt: '',
  };
  const previewAmount = resolveDiscountAmount(draft, base);

  const needsLine = scope === 'line';
  const needsValue = type !== 'comp';
  const valueValid = !needsValue || numericValue > 0;
  const lineValid = !needsLine || !!selectedLine;
  const canApply = !!reason && valueValid && lineValid && base > 0;

  const handleApply = () => {
    if (!canApply) return;
    const discount: ManualDiscount = {
      ...draft,
      id: `md-${Math.random().toString(36).substring(2, 9)}`,
      amountTHB: previewAmount,
      appliedAt: new Date().toISOString(),
    };
    onApply(discount);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgePercent className="w-5 h-5 text-primary" />
            Manual discount
          </DialogTitle>
          <DialogDescription>
            Applied by {operatorName} · logged for the discounts report.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Scope */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Apply to</p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={scope === 'order' ? 'default' : 'outline'}
                className="h-12"
                onClick={() => {
                  setScope('order');
                  setTargetLineId(null);
                }}
              >
                Whole order
              </Button>
              <Button
                type="button"
                variant={scope === 'line' ? 'default' : 'outline'}
                className="h-12"
                disabled={lines.length === 0}
                onClick={() => setScope('line')}
              >
                Single item
              </Button>
            </div>
          </div>

          {/* Line picker — ticket lines expand into their component rows */}
          {scope === 'line' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Choose item</p>
              <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                {lines.map((l) => {
                  const hasComponents = !!l.components && l.components.length > 0;
                  return (
                    <div key={l.id} className={hasComponents ? 'space-y-1' : ''}>
                      <button
                        type="button"
                        onClick={() => selectTarget(l.id, null)}
                        className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                          isSelected(l.id, null)
                            ? 'border-primary ring-1 ring-primary bg-primary/5'
                            : 'hover:bg-muted'
                        }`}
                      >
                        <span className="truncate pr-2">
                          {l.label}
                          {hasComponents && (
                            <span className="text-muted-foreground text-xs ml-1.5">
                              · whole line
                            </span>
                          )}
                        </span>
                        <span className="font-bold tabular-nums shrink-0">฿{l.amount}</span>
                      </button>
                      {hasComponents && (
                        <div className="ml-3 pl-3 border-l space-y-1">
                          {l.components!.map((c) => (
                            <button
                              key={componentKey(c.target)}
                              type="button"
                              onClick={() => selectTarget(l.id, c.target)}
                              className={`w-full flex items-center justify-between rounded-lg border p-2.5 text-left text-sm transition-colors ${
                                isSelected(l.id, c.target)
                                  ? 'border-primary ring-1 ring-primary bg-primary/5'
                                  : 'hover:bg-muted'
                              }`}
                            >
                              <span className="truncate pr-2">{c.label}</span>
                              <span className="font-bold tabular-nums shrink-0">฿{c.amount}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Type */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Type</p>
            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                variant={type === 'percent' ? 'default' : 'outline'}
                className="h-12"
                onClick={() => setType('percent')}
              >
                Percent %
              </Button>
              <Button
                type="button"
                variant={type === 'fixed' ? 'default' : 'outline'}
                className="h-12"
                onClick={() => setType('fixed')}
              >
                Fixed ฿
              </Button>
              <Button
                type="button"
                variant={type === 'comp' ? 'default' : 'outline'}
                className="h-12 gap-1.5"
                onClick={() => setType('comp')}
              >
                <Gift className="w-4 h-4" />
                Comp
              </Button>
            </div>
          </div>

          {/* Value */}
          {needsValue && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                {type === 'percent' ? 'Percent off' : 'Amount off (฿)'}
              </p>
              <div className="flex items-baseline justify-between rounded-lg border bg-muted/40 px-4 h-14">
                <span className="text-3xl font-bold tabular-nums">
                  {type === 'percent'
                    ? `${value || '0'}%`
                    : `฿${value || '0'}`}
                </span>
                {value !== '' && previewAmount > 0 && (
                  <span className="text-lg font-semibold text-emerald-500 tabular-nums">
                    = −฿{previewAmount}
                  </span>
                )}
              </div>
              <TouchKeypad
                value={value}
                onChange={setValue}
                maxLength={type === 'percent' ? 3 : 6}
              />
            </div>
          )}

          {/* Reason */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              Reason <span className="text-destructive">*</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {reasons.map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={reason === r ? 'default' : 'outline'}
                  onClick={() => setReason(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          </div>

          {/* Note */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Note (optional)</p>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add context for the report…"
              rows={2}
            />
          </div>

          {/* Preview + apply */}
          <div className="flex items-center justify-between rounded-lg bg-muted p-4">
            <span className="text-muted-foreground">Discount</span>
            <span className="text-2xl font-black text-emerald-500 tabular-nums">
              −฿{previewAmount}
            </span>
          </div>

          <Button className="w-full h-14 text-lg" disabled={!canApply} onClick={handleApply}>
            {reason ? `Apply −฿${previewAmount}` : 'Choose a reason to apply'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
