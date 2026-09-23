import { useState, type ReactNode } from 'react';
import { ChargeTarget, FnbOrderLine, ManualDiscount, Wristband } from '@/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { describeModifiers } from '@/lib/fnb';
import { summarizeTax, roundTHB, type TaxBreakdown } from '@/lib/tax';
import { formatDiscountDetail, formatDiscountTarget } from '@/lib/manualDiscount';
import { StaffBenefitBreakdown, type StaffBenefitBreakdownData } from '@/components/fnb/StaffBenefitBreakdown';
import { Wallet, UserRound, ShoppingCart, Trash2, X, Pencil, BadgePercent, StickyNote, Gift, ChevronDown, ChevronUp, History, QrCode as QrCodeIcon } from 'lucide-react';

/** The synthetic order-scope ManualDiscount id the staff-benefit preview is folded into (see pages/OrderStation.tsx). */
const STAFF_BENEFIT_DISCOUNT_ID = 'staff-benefit';

interface FnbCartProps {
  wristband: Wristband | null;
  chargeTarget?: ChargeTarget;
  lines: FnbOrderLine[];
  total: number;
  manualDiscounts: ManualDiscount[];
  manualAmounts: Record<string, number>;
  taxBreakdown: TaxBreakdown;
  /** Per-primitive relief breakdown for the currently-scanned staff benefit, if any. */
  benefitBreakdown?: StaffBenefitBreakdownData | null;
  /**
   * WHERE THE FIGURES ON THIS PANEL CAME FROM (S2-09b) — drawn just above the
   * charge button, where the person taking the money is already looking.
   *
   * Passed in rather than decided here: this component draws an order, and
   * which engine priced it is the station's business. It renders nothing when
   * the platform priced the order and agreed with the till, so the approved
   * layout is unchanged in ordinary use.
   */
  priceNote?: ReactNode;
  /**
   * WHY THE CHARGE BUTTON IS OFF, beyond an empty order — SCRUM-342.
   *
   * Set when the order as it stands cannot be sold: the platform refused to
   * price it, so the press could only carry the guest to the payment screen and
   * meet the same rule at commit. Null when there is no such reason, which
   * includes an order this till priced on its own — that figure is the
   * documented fallback and the panel says whose it is.
   *
   * Passed in rather than decided here, for the reason `priceNote` is: this
   * component draws an order, and whether the platform will take it is the
   * station's business. The reason is not drawn twice — `priceNote` above the
   * button already names it — it rides the button as its title.
   */
  chargeBlockedReason?: string | null;
  onChangeQty: (lineId: string, qty: number) => void;
  onEditLine: (line: FnbOrderLine) => void;
  onClear: () => void;
  onCheckout: () => void;
  onSwitchTab: () => void;
  onAddManualDiscount: () => void;
  onRemoveManualDiscount: (id: string) => void;
  onScanStaffBenefit?: () => void;
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

export function FnbCart({
  wristband,
  chargeTarget,
  lines,
  total,
  manualDiscounts,
  manualAmounts,
  taxBreakdown,
  benefitBreakdown,
  priceNote,
  chargeBlockedReason,
  onChangeQty,
  onEditLine,
  onClear,
  onCheckout,
  onSwitchTab,
  onAddManualDiscount,
  onRemoveManualDiscount,
  onScanStaffBenefit,
}: FnbCartProps) {
  const isEmpty = lines.length === 0;
  const chargeBlocked = Boolean(chargeBlockedReason);
  const [showLedger, setShowLedger] = useState(false);
  const ledger = wristband?.ledger;

  const lineDiscountsFor = (id: string) =>
    manualDiscounts.filter((md) => md.scope === 'line' && md.targetLineId === id);
  // The staff-benefit relief gets its own per-primitive breakdown card below
  // (via `benefitBreakdown`) instead of the generic aggregate discount row.
  const orderDiscounts = manualDiscounts.filter(
    (md) => md.scope === 'order' && md.id !== STAFF_BENEFIT_DISCOUNT_ID
  );

  return (
    <div className="flex flex-col h-full">
      {/* Tab header */}
      <div className="rounded-xl border bg-card p-4 mb-4 shrink-0">
        {wristband ? (
          <div>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0">
                <UserRound className="w-6 h-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold leading-tight truncate">{wristband.customerNickname}</div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Wallet className="w-3 h-3" />
                  <span className="tabular-nums">฿{wristband.creditBalanceTHB} credit</span>
                  <span className="opacity-50">•</span>
                  <span className="font-mono">#{wristband.code}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {ledger && ledger.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={() => setShowLedger((v) => !v)}
                    aria-label={showLedger ? 'Hide ledger' : 'Show wallet history'}
                    title="Wallet history"
                  >
                    <History className="w-4 h-4" />
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={onSwitchTab} aria-label="Switch tab">
                  <X className="w-5 h-5" />
                </Button>
              </div>
            </div>
            {showLedger && ledger && ledger.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2">
                  <History className="w-3 h-3" />
                  Wallet history
                  <button
                    type="button"
                    className="ml-auto flex items-center gap-0.5 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowLedger(false)}
                  >
                    <ChevronUp className="w-3 h-3" />
                    Hide
                  </button>
                </div>
                <div className="space-y-1">
                  {ledger.slice().reverse().map((entry, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="capitalize text-muted-foreground">
                        {entry.kind}
                        <span className="opacity-70"> · {entry.source.replace(/_/g, ' ')}</span>
                        {entry.by && <span className="opacity-60"> · {entry.by}</span>}
                        <span className="opacity-40 ml-1">{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                      <span className={`tabular-nums font-semibold ${entry.amountTHB < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                        {entry.amountTHB > 0 ? '+' : ''}฿{entry.amountTHB}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : chargeTarget ? (
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0">
              <UserRound className="w-6 h-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold leading-tight truncate">{chargeTarget.parentName}</div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {chargeTarget.phone && <span className="font-mono">{chargeTarget.phone}</span>}
                {chargeTarget.phone && <span className="opacity-50">•</span>}
                <span className="truncate">{chargeTarget.partyTitle}</span>
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
              <div className="font-bold leading-tight">Guest order</div>
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
          <ShoppingCart className="w-5 h-5" />
          Order
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
          <ShoppingCart className="w-10 h-10 mb-3 opacity-40" />
          <p>Tap menu items to add them to the order.</p>
        </div>
      ) : (
        <ScrollArea className="flex-1 -mx-2 px-2 [&_[data-radix-scroll-area-viewport]>div]:!block">
          <div className="space-y-2">
            {lines.map((line) => {
              const mods = describeModifiers(line.menuItem, line.selectedModifiers);
              const isPrepaid = !!line.isPrepaid;
              return (
                <div
                  key={line.id}
                  className={`rounded-xl border p-2.5 ${isPrepaid ? 'bg-violet-500/10 border-violet-500/40' : 'bg-background'}`}
                >
                  <div className="flex items-center gap-2">
                    {isPrepaid ? (
                      <div className="min-w-0 flex-1">
                        <div className="font-bold leading-tight flex items-center gap-1.5">
                          <Gift className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                          <span className="truncate text-violet-100">{line.menuItem.name}</span>
                          <span className="ml-1 rounded px-1.5 py-0.5 bg-violet-500/30 text-violet-300 text-[10px] font-bold uppercase tracking-wide shrink-0">
                            Prepaid
                          </span>
                        </div>
                        <div className="text-xs text-violet-400/70 italic mt-0.5">Already paid at check-in</div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onEditLine(line)}
                        className="min-w-0 flex-1 text-left group"
                        aria-label={`Edit ${line.menuItem.name}`}
                      >
                        <div className="font-bold leading-tight flex items-center gap-1.5">
                          <span className="truncate">{line.menuItem.name}</span>
                          {line.variantLabel && (
                            <span className="shrink-0 rounded px-1.5 py-0.5 bg-primary/15 text-primary text-[10px] font-bold uppercase tracking-wide">
                              {line.variantLabel}
                            </span>
                          )}
                          <Pencil className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
                        </div>
                        {mods.length > 0 ? (
                          <div className="text-xs text-primary/90 leading-snug truncate">{mods.join(', ')}</div>
                        ) : (
                          <div className="text-xs text-muted-foreground italic truncate">Tap to add a note</div>
                        )}
                      </button>
                    )}
                    {isPrepaid ? (
                      <button
                        type="button"
                        onClick={() => onChangeQty(line.id, 0)}
                        className="h-7 w-7 flex items-center justify-center rounded-lg text-violet-400 hover:bg-violet-500/20 transition-colors shrink-0"
                        aria-label={`Remove ${line.menuItem.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <QuantityStepper
                        value={line.qty}
                        onChange={(q) => onChangeQty(line.id, q)}
                        size="sm"
                        ariaLabel={line.menuItem.name}
                      />
                    )}
                    <div className={`font-bold tabular-nums shrink-0 w-16 text-right ${isPrepaid ? 'text-violet-300' : ''}`}>
                      {isPrepaid ? '฿0' : `฿${line.lineTotal}`}
                    </div>
                  </div>
                  {line.note && (
                    <div className="flex items-start gap-1.5 mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
                      <StickyNote className="w-3.5 h-3.5 shrink-0 mt-px" />
                      <span className="leading-snug">{line.note}</span>
                    </div>
                  )}
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
              );
            })}
          </div>
        </ScrollArea>
      )}

      <div className="shrink-0 pt-4 mt-2 border-t">
        {benefitBreakdown && (
          <div className="mb-3">
            <StaffBenefitBreakdown
              data={benefitBreakdown}
              onRemove={() => onRemoveManualDiscount(STAFF_BENEFIT_DISCOUNT_ID)}
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
          className="w-full gap-2 border-dashed mb-2"
          disabled={isEmpty}
          onClick={onAddManualDiscount}
        >
          <BadgePercent className="w-4 h-4" />
          Add manual discount
        </Button>

        {onScanStaffBenefit && (
          <Button
            variant="outline"
            className="w-full gap-2 border-dashed mb-4"
            disabled={isEmpty}
            onClick={onScanStaffBenefit}
          >
            <QrCodeIcon className="w-4 h-4" />
            Scan staff benefit
          </Button>
        )}

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
