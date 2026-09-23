import { CartLine, CustomerTier, Discount, ManualDiscount } from '@/types';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { OrderSummary } from '@/components/till/OrderSummary';
import { computeTotals } from '@/lib/sale';
import { unpricedCartLines } from '@/lib/pricing';
import { ShoppingCart, ChevronUp } from 'lucide-react';

interface MobileCartSheetProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tier: CustomerTier | null;
  customerName?: string;
  lines: CartLine[];
  activeLineId?: string | null;
  discounts: Discount[];
  manualDiscounts: ManualDiscount[];
  onUpdateLine: (id: string, updates: Partial<Pick<CartLine, 'kids' | 'adults' | 'socks'>>) => void;
  onConfigureLine?: (id: string) => void;
  onRemoveLine: (id: string) => void;
  onRemoveDiscount: (code: string) => void;
  onApplyPromoCode?: (code: string) => void;
  promoError?: string;
  onAddManualDiscount: () => void;
  onRemoveManualDiscount: (id: string) => void;
  onPay: () => void;
  onCancel: () => void;
  canPay: boolean;
  /**
   * A DISCOUNT THE PLATFORM WOULD NOT HONOUR ON THIS CART (SCRUM-311/329).
   *
   * The same sentence the Review step's panel is given, handed on to the
   * panel inside this sheet. Without it the phone's cart said nothing about
   * why the discounted rate had gone while the Review step explained it.
   */
  tierClaimRefusal?: string | null;
}

/**
 * Sticky cart bar + bottom sheet for the mobile Till. The bar shows a compact
 * item count + running total; tapping opens a full-height bottom sheet with
 * the complete OrderSummary.
 */
export function MobileCartSheet({
  open,
  onOpenChange,
  tier,
  customerName,
  lines,
  activeLineId,
  discounts,
  manualDiscounts,
  onUpdateLine,
  onConfigureLine,
  onRemoveLine,
  onRemoveDiscount,
  onApplyPromoCode,
  promoError,
  onAddManualDiscount,
  onRemoveManualDiscount,
  onPay,
  onCancel,
  canPay,
  tierClaimRefusal,
}: MobileCartSheetProps) {
  const { total } = computeTotals(lines, discounts, manualDiscounts);
  const itemCount = lines.length;
  /**
   * WHAT THIS CART CANNOT BE PRICED AT (SCRUM-316/329).
   *
   * Read from the same `unpricedCartLines(lines)` the panel in the sheet
   * reads, so the bar and the panel above it agree: a line at a tier nobody
   * priced totals ฿0 through `computeTotals`, and the bar printed that ฿0 as
   * the amount due while the panel printed dashes.
   */
  const unpriced = unpricedCartLines(lines).length > 0;

  return (
    <>
      {/* Sticky cart bar — always visible at bottom of the step content */}
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
            {itemCount === 0 ? 'No items yet' : `${itemCount} item${itemCount !== 1 ? 's' : ''}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tabular-nums">{unpriced ? '—' : `฿${total}`}</span>
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        </div>
      </button>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[88vh] flex flex-col px-0 pb-0">
          <SheetHeader className="px-4 pb-2 shrink-0">
            <SheetTitle>Current Order</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden px-4 pb-4">
            <OrderSummary
              tier={tier}
              customerName={customerName}
              lines={lines}
              activeLineId={activeLineId}
              discounts={discounts}
              manualDiscounts={manualDiscounts}
              onUpdateLine={onUpdateLine}
              onConfigureLine={onConfigureLine}
              onRemoveLine={onRemoveLine}
              onRemoveDiscount={onRemoveDiscount}
              onApplyPromoCode={onApplyPromoCode}
              promoError={promoError}
              onAddManualDiscount={onAddManualDiscount}
              onRemoveManualDiscount={onRemoveManualDiscount}
              onPay={() => { onOpenChange(false); onPay(); }}
              onCancel={() => { onOpenChange(false); onCancel(); }}
              canPay={canPay}
              tierClaimRefusal={tierClaimRefusal}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
