import { FnbOrderLine, ManualDiscount, Wristband } from '@/types';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { describeModifiers } from '@/lib/fnb';
import { computeFnbTotals } from '@/lib/fnb';
import { summarizeTax, roundTHB } from '@/lib/tax';
import { formatDiscountDetail, formatDiscountTarget } from '@/lib/manualDiscount';
import {
  ShoppingCart,
  ChevronUp,
  Trash2,
  Pencil,
  BadgePercent,
  StickyNote,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';

interface MobileFnbCartSheetProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  wristband: Wristband | null;
  lines: FnbOrderLine[];
  manualDiscounts: ManualDiscount[];
  manualAmounts: Record<string, number>;
  onChangeQty: (lineId: string, qty: number) => void;
  onEditLine: (line: FnbOrderLine) => void;
  onClear: () => void;
  onAddManualDiscount: () => void;
  onRemoveManualDiscount: (id: string) => void;
  onSwitchTab: () => void;
  onCheckout: () => void;
}

/**
 * Sticky cart bar + bottom sheet for the mobile F&B Order Station.
 * Bar shows item count + running total; tap opens the full sheet.
 */
export function MobileFnbCartSheet({
  open,
  onOpenChange,
  wristband,
  lines,
  manualDiscounts,
  manualAmounts,
  onChangeQty,
  onEditLine,
  onClear,
  onAddManualDiscount,
  onRemoveManualDiscount,
  onSwitchTab,
  onCheckout,
}: MobileFnbCartSheetProps) {
  const { total, taxBreakdown } = computeFnbTotals(lines, manualDiscounts);
  const itemCount = lines.length;
  const isEmpty = itemCount === 0;

  const lineDiscountsFor = (id: string) =>
    manualDiscounts.filter((md) => md.scope === 'line' && md.targetLineId === id);
  const orderDiscounts = manualDiscounts.filter((md) => md.scope === 'order');

  return (
    <>
      {/* Sticky cart bar */}
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="w-full flex items-center justify-between gap-3 bg-card border-t px-4 py-3 active:bg-muted transition-colors"
        aria-label="Open cart"
      >
        <div className="flex items-center gap-3">
          <div className="relative">
            <ShoppingCart className="w-5 h-5 text-primary" />
            {itemCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
                {itemCount}
              </span>
            )}
          </div>
          <span className="text-sm text-muted-foreground">
            {isEmpty ? 'No items yet' : `${itemCount} item${itemCount !== 1 ? 's' : ''}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tabular-nums">฿{total}</span>
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        </div>
      </button>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[88vh] flex flex-col px-0 pb-0">
          <SheetHeader className="px-4 pb-2 shrink-0">
            <SheetTitle>Current Order</SheetTitle>
          </SheetHeader>

          <div className="flex-1 min-h-0 flex flex-col px-4">
            {/* Wristband / guest header */}
            <div className="rounded-xl border bg-card p-3 mb-3 shrink-0">
              {wristband ? (
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0">
                    <UserRound className="w-5 h-5" />
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
                  <Button variant="ghost" size="icon" onClick={onSwitchTab} aria-label="Clear wristband">
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                    <UserRound className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold leading-tight">Guest order</div>
                    <div className="text-xs text-muted-foreground">No wristband — pay by cash or card</div>
                  </div>
                  <Button variant="ghost" size="icon" onClick={onSwitchTab} aria-label="Clear order">
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>

            {/* Lines */}
            <div className="flex items-center justify-between mb-2 shrink-0">
              <div className="flex items-center gap-2 text-sm font-bold">
                <ShoppingCart className="w-4 h-4" />
                Items
                {!isEmpty && (
                  <span className="text-muted-foreground font-medium">({lines.length})</span>
                )}
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
              <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground">
                <ShoppingCart className="w-10 h-10 mb-3 opacity-40" />
                <p className="text-sm">Tap menu items to add them here.</p>
              </div>
            ) : (
              <ScrollArea className="flex-1 -mx-2 px-2 [&_[data-radix-scroll-area-viewport]>div]:!block">
                <div className="space-y-2">
                  {lines.map((line) => {
                    const mods = describeModifiers(line.menuItem, line.selectedModifiers);
                    return (
                      <div key={line.id} className="rounded-xl border bg-background p-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onEditLine(line)}
                            className="min-w-0 flex-1 text-left group"
                            aria-label={`Edit ${line.menuItem.name}`}
                          >
                            <div className="font-bold leading-tight flex items-center gap-1.5">
                              <span className="truncate">{line.menuItem.name}</span>
                              <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary shrink-0" />
                            </div>
                            {mods.length > 0 ? (
                              <div className="text-xs text-primary/90 leading-snug truncate">
                                {mods.join(', ')}
                              </div>
                            ) : (
                              <div className="text-xs text-muted-foreground italic">Tap to add a note</div>
                            )}
                          </button>
                          <QuantityStepper
                            value={line.qty}
                            onChange={(q) => onChangeQty(line.id, q)}
                            size="sm"
                            ariaLabel={line.menuItem.name}
                          />
                          <div className="font-bold tabular-nums shrink-0 w-14 text-right text-sm">
                            ฿{line.lineTotal}
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
                            <div key={md.id} className="mt-2 flex items-center justify-between text-emerald-500 bg-emerald-500/10 px-3 py-2 rounded-lg">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <BadgePercent className="w-3.5 h-3.5 shrink-0" />
                                <span className="text-xs truncate">{formatDiscountDetail(md)}</span>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className="text-xs font-bold tabular-nums">-฿{amt}</span>
                                <button
                                  type="button"
                                  onClick={() => onRemoveManualDiscount(md.id)}
                                  className="text-emerald-500 hover:text-emerald-600"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}

            {/* Footer: order discounts + tax + actions */}
            <div className="shrink-0 pt-3 mt-2 border-t space-y-2 pb-4">
              {orderDiscounts.map((md) => {
                const amt = manualAmounts[md.id] ?? 0;
                if (amt <= 0) return null;
                return (
                  <div key={md.id} className="flex items-center justify-between text-emerald-500 bg-emerald-500/10 px-3 py-2 rounded-lg">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <BadgePercent className="w-3.5 h-3.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs truncate">{formatDiscountTarget(md)} · {formatDiscountDetail(md)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs font-bold tabular-nums">-฿{amt}</span>
                      <button
                        type="button"
                        onClick={() => onRemoveManualDiscount(md.id)}
                        className="text-emerald-500 hover:text-emerald-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}

              <Button
                variant="outline"
                className="w-full gap-2 border-dashed text-sm h-10"
                disabled={isEmpty}
                onClick={onAddManualDiscount}
              >
                <BadgePercent className="w-4 h-4" />
                Add manual discount
              </Button>

              {!isEmpty &&
                summarizeTax(taxBreakdown).map((row) => (
                  <div key={row.key} className="flex justify-between text-sm text-muted-foreground">
                    <span>{row.label}</span>
                    <span className="tabular-nums">฿{roundTHB(row.amount)}</span>
                  </div>
                ))}

              <Button
                size="lg"
                className="w-full h-14 text-lg font-bold"
                disabled={isEmpty}
                onClick={() => {
                  onOpenChange(false);
                  onCheckout();
                }}
              >
                Checkout · ฿{total}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
