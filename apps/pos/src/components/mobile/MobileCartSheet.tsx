import type { ReactNode } from 'react';
import { CartLine, CustomerTier, Discount, ManualDiscount } from '@/types';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { OrderSummary } from '@/components/till/OrderSummary';
import { computeTotals } from '@/lib/sale';
import { unpricedCartLines } from '@/lib/pricing';
import type { OrderTotals } from '@/api/sales';
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
  /**
   * WHETHER PAY OPENS, decided by the caller and passed straight to the panel.
   *
   * The till's own completeness checks are in it — a cart with someone on it,
   * every drop-off length chosen, every nanny assigned — and since SCRUM-366 so
   * is the platform's verdict: a cart the platform refused to price cannot be
   * charged, and the refusal note this sheet draws beneath the total says why.
   */
  canPay: boolean;
  /**
   * A DISCOUNT THE PLATFORM WOULD NOT HONOUR ON THIS CART (SCRUM-311/329).
   *
   * The same sentence the Review step's panel is given, handed on to the
   * panel inside this sheet. Without it the phone's cart said nothing about
   * why the discounted rate had gone while the Review step explained it.
   */
  tierClaimRefusal?: string | null;
  /**
   * THE FIGURES TO SHOW, as the platform quoted them (S2-09a / SCRUM-349).
   *
   * The same object the Review step's panel is given (`cart.totals`), handed to
   * the panel inside this sheet and to the bar above it. Absent means "price it
   * here", which is what this sheet did for every cart before this ticket: the
   * phone showed its own arithmetic on the bar and in the sheet while the
   * Review step one tap away showed the platform's, so a cart the two priced
   * differently read as two different amounts due.
   */
  totals?: OrderTotals;
  /**
   * Shown under the total in the sheet, as on Review — whose figure this is,
   * and since SCRUM-366 what the platform said about the cart when it was asked:
   * the refusal that turns Pay off, or the fault that leaves it on. The caller
   * composes the notes and hands the same node to both screens, so the sheet
   * and the Review step a tap away cannot say different things about one cart.
   */
  priceNote?: ReactNode;
}

/**
 * Sticky cart bar + bottom sheet for the mobile Till. The bar shows a compact
 * item count + the amount due; tapping opens a full-height bottom sheet with
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
  totals,
  priceNote,
}: MobileCartSheetProps) {
  /**
   * WHAT THE BAR PRINTS (SCRUM-349).
   *
   * The quoted total when the caller passes one, so the bar, the panel in the
   * sheet and the Review step all print the one figure. `computeTotals` is the
   * fallback for a caller that quotes nothing; it is the till's own arithmetic,
   * and the sheet's `priceNote` says so beneath the total.
   */
  const total = totals ? totals.total : computeTotals(lines, discounts, manualDiscounts).total;
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
              totals={totals}
              priceNote={priceNote}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
