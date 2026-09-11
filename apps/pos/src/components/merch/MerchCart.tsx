import { ManualDiscount, MerchOrderLine, Wristband } from '@/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { resolveRateToday } from '@/lib/pricingMode';
import { summarizeTax, roundTHB, type TaxBreakdown } from '@/lib/tax';
import { formatDiscountDetail, formatDiscountTarget } from '@/lib/manualDiscount';
import {
  Wallet,
  UserRound,
  ShoppingBag,
  Trash2,
  X,
  BadgePercent,
} from 'lucide-react';

interface MerchCartProps {
  wristband: Wristband | null;
  lines: MerchOrderLine[];
  total: number;
  manualDiscounts: ManualDiscount[];
  manualAmounts: Record<string, number>;
  taxBreakdown: TaxBreakdown;
  onChangeQty: (lineId: string, qty: number) => void;
  onClear: () => void;
  onCheckout: () => void;
  onSwitchTab: () => void;
  onAddManualDiscount: () => void;
  onRemoveManualDiscount: (id: string) => void;
}

function ManualDiscountRow({
  label,
  amount,
  reason,
  appliedBy,
  onRemove,
}: {
  label: string;
  amount: number;
  reason: string;
  appliedBy: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between text-emerald-500 bg-emerald-500/10 p-3 rounded-lg">
      <div className="flex items-center gap-2 min-w-0">
        <BadgePercent className="w-4 h-4 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{label}</div>
          <div className="text-xs text-emerald-500/70 truncate">
            {reason} · {appliedBy}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-bold tabular-nums">-฿{amount}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-emerald-500 hover:bg-emerald-500/20 hover:text-emerald-600"
          onClick={onRemove}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

export function MerchCart({
  wristband,
  lines,
  total,
  manualDiscounts,
  manualAmounts,
  taxBreakdown,
  onChangeQty,
  onClear,
  onCheckout,
  onSwitchTab,
  onAddManualDiscount,
  onRemoveManualDiscount,
}: MerchCartProps) {
  const isEmpty = lines.length === 0;

  const lineDiscountsFor = (id: string) =>
    manualDiscounts.filter((md) => md.scope === 'line' && md.targetLineId === id);
  const orderDiscounts = manualDiscounts.filter((md) => md.scope === 'order');

  return (
    <div className="flex flex-col h-full">
      {/* Tab header */}
      <div className="rounded-xl border bg-card p-4 mb-4 shrink-0">
        {wristband ? (
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0">
              <UserRound className="w-6 h-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold leading-tight truncate">
                {wristband.customerNickname}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Wallet className="w-3 h-3" />
                <span className="tabular-nums">฿{wristband.creditBalanceTHB ?? 0} credit</span>
                <span className="opacity-50">•</span>
                <span className="font-mono">#{wristband.code}</span>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onSwitchTab} aria-label="Switch tab">
              <X className="w-5 h-5" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-muted text-muted-foreground flex items-center justify-center shrink-0">
              <UserRound className="w-6 h-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold leading-tight">Guest sale</div>
              <div className="text-xs text-muted-foreground">No wristband — pay by cash or card</div>
            </div>
            <Button variant="ghost" size="icon" onClick={onSwitchTab} aria-label="Scan wristband">
              <X className="w-5 h-5" />
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-2 font-bold">
          <ShoppingBag className="w-5 h-5" />
          Sale
          {!isEmpty && <span className="text-muted-foreground font-medium">({lines.length})</span>}
        </div>
        {!isEmpty && (
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        )}
      </div>

      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground px-4">
          <ShoppingBag className="w-10 h-10 mb-3 opacity-40" />
          <p>Tap shop items to add them to the sale.</p>
        </div>
      ) : (
        <ScrollArea className="flex-1 -mx-2 px-2 [&_[data-radix-scroll-area-viewport]>div]:!block">
          <div className="space-y-2">
            {lines.map((line) => (
              <div key={line.id} className="rounded-xl border p-2.5 bg-background">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-bold leading-tight truncate">
                      {line.merchItem.name}
                      {line.variantLabel && (
                        <span className="ml-1 text-sm font-normal text-muted-foreground">
                          ({line.variantLabel})
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      ฿{resolveRateToday(line.merchItem.price)} each
                    </div>
                  </div>
                  <QuantityStepper
                    value={line.qty}
                    max={line.merchItem.stock}
                    onChange={(q) => onChangeQty(line.id, q)}
                    size="sm"
                    ariaLabel={line.merchItem.name}
                  />
                  <div className="font-bold tabular-nums shrink-0 w-16 text-right">
                    ฿{line.lineTotal}
                  </div>
                </div>
                {lineDiscountsFor(line.id).map((md) => {
                  const amt = manualAmounts[md.id] ?? 0;
                  if (amt <= 0) return null;
                  return (
                    <div key={md.id} className="mt-2">
                      <ManualDiscountRow
                        label={formatDiscountDetail(md)}
                        amount={amt}
                        reason={md.reason}
                        appliedBy={md.appliedBy}
                        onRemove={() => onRemoveManualDiscount(md.id)}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      <div className="shrink-0 pt-4 mt-2 border-t">
        {orderDiscounts.map((md) => {
          const amt = manualAmounts[md.id] ?? 0;
          if (amt <= 0) return null;
          return (
            <div key={md.id} className="mb-3">
              <ManualDiscountRow
                label={`${formatDiscountTarget(md)} · ${formatDiscountDetail(md)}`}
                amount={amt}
                reason={md.reason}
                appliedBy={md.appliedBy}
                onRemove={() => onRemoveManualDiscount(md.id)}
              />
            </div>
          );
        })}

        <Button
          variant="outline"
          className="w-full gap-2 border-dashed mb-4"
          disabled={isEmpty}
          onClick={onAddManualDiscount}
        >
          <BadgePercent className="w-4 h-4" />
          Add manual discount
        </Button>

        {!isEmpty &&
          summarizeTax(taxBreakdown).map((row) => (
            <div
              key={row.key}
              className="flex justify-between text-sm text-muted-foreground mb-1"
            >
              <span>{row.label}</span>
              <span className="tabular-nums">฿{roundTHB(row.amount)}</span>
            </div>
          ))}

        <Button
          size="lg"
          className="w-full h-16 text-xl font-bold mt-3"
          disabled={isEmpty}
          onClick={onCheckout}
        >
          Charge ฿{total}
        </Button>
      </div>
    </div>
  );
}
