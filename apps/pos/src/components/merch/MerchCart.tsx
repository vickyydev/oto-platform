import type { ReactNode } from 'react';
import { ManualDiscount, MerchOrderLine, Wristband } from '@/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { resolveRateToday } from '@/lib/pricingMode';
import { taxRowsOf, type TaxBreakdownBaht } from '@/lib/cartWire';
import { formatDiscountDetail, formatDiscountTarget } from '@/lib/manualDiscount';
import { PromoCodeEntry, type PromoCodeRow } from '@/components/fnb/PromoCodeEntry';
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
  taxBreakdown: TaxBreakdownBaht;
  /**
   * WHERE THE FIGURES ON THIS PANEL CAME FROM (S2-09b), drawn just above the
   * charge button. Passed in, because which engine priced the sale is the
   * station's business and not this panel's; it renders nothing when the
   * platform priced it and agreed with the till.
   */
  priceNote?: ReactNode;
  /**
   * WHY THE CHARGE BUTTON IS OFF, beyond an empty sale — SCRUM-352, the same
   * prop the F&B panel takes (`components/fnb/FnbCart.tsx`, SCRUM-342).
   *
   * Set when the sale as it stands cannot be sold: the platform refused to
   * price it, so the press could only carry the guest to the payment screen and
   * meet the same rule at commit. Null when there is no such reason, which
   * includes a sale this till priced on its own — that figure is the documented
   * fallback and the panel says whose it is.
   *
   * Passed in rather than decided here, for the reason `priceNote` is: this
   * component draws a sale, and whether the platform will take it is the
   * station's business. The reason is not drawn twice — `priceNote` above the
   * button already names it — it rides the button as its title.
   */
  chargeBlockedReason?: string | null;
  /**
   * THE PROMO CODES ON THIS SALE, as the quote reports them (SCRUM-362) — the
   * same prop the F&B panel takes, drawn by the same component, so a code reads
   * identically at either counter. Absent leaves the entry off.
   */
  promoCodes?: PromoCodeRow[];
  /** The refusal for the last code staff entered, shown under the field. */
  promoError?: string;
  onChangeQty: (lineId: string, qty: number) => void;
  onClear: () => void;
  onCheckout: () => void;
  onSwitchTab: () => void;
  onAddManualDiscount: () => void;
  onRemoveManualDiscount: (id: string) => void;
  onApplyPromoCode?: (code: string) => void;
  onRemovePromoCode?: (code: string) => void;
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
  priceNote,
  chargeBlockedReason,
  promoCodes,
  promoError,
  onChangeQty,
  onClear,
  onCheckout,
  onSwitchTab,
  onAddManualDiscount,
  onRemoveManualDiscount,
  onApplyPromoCode,
  onRemovePromoCode,
}: MerchCartProps) {
  const isEmpty = lines.length === 0;
  const chargeBlocked = Boolean(chargeBlockedReason);

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
        {/* Promo codes above the manual discounts — the order the till's panel
            puts them in. */}
        {onApplyPromoCode && onRemovePromoCode && (
          <div className="mb-3">
            <PromoCodeEntry
              applied={promoCodes ?? []}
              {...(promoError ? { error: promoError } : {})}
              disabled={isEmpty}
              onApply={onApplyPromoCode}
              onRemove={onRemovePromoCode}
            />
          </div>
        )}

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
          taxRowsOf(taxBreakdown).map((row) => (
            <div
              key={row.key}
              className="flex justify-between text-sm text-muted-foreground mb-1"
            >
              <span>{row.label}</span>
              <span className="tabular-nums">฿{row.amount}</span>
            </div>
          ))}

        {priceNote && <div className="mt-3">{priceNote}</div>}

        <Button
          size="lg"
          className="w-full h-16 text-xl font-bold mt-3"
          disabled={isEmpty || chargeBlocked}
          title={chargeBlockedReason ?? undefined}
          onClick={onCheckout}
        >
          Charge ฿{total}
        </Button>
      </div>
    </div>
  );
}
