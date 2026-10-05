import { Check, UtensilsCrossed, Undo2, Ban } from 'lucide-react';
import { type PrepaidFoodReconciliation } from '@/lib/dropoff';

interface FoodReconciliationSummaryProps {
  reconciliation: PrepaidFoodReconciliation;
  policy: 'refund' | 'forfeit';
}

/**
 * Prepaid food reconciliation card shown at pickup checkout.
 * Renders item-by-item redemption status for `prepaid_items` mode or the
 * loaded/remaining balance for `prepaid_credit` mode, then shows the policy
 * outcome (refund or forfeit) for any unused amount.
 *
 * Used in both the desktop `CheckOutModal` and mobile `MobileCheckOutView`.
 */
export function FoodReconciliationSummary({
  reconciliation,
  policy,
}: FoodReconciliationSummaryProps) {
  const isRefund = policy === 'refund';
  const hasUnused = reconciliation.totalUnusedTHB > 0;

  return (
    <div className="rounded-xl border bg-muted/30 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-muted/40">
        <UtensilsCrossed className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold">Prepaid food reconciliation</span>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Item breakdown for prepaid_items */}
        {reconciliation.mode === 'prepaid_items' && reconciliation.itemBreakdown.length > 0 && (
          <div className="space-y-1.5">
            {reconciliation.itemBreakdown.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground min-w-0 truncate pr-2">
                  {item.menuItemName}
                </span>
                <span className="shrink-0 tabular-nums">
                  {item.redeemedQty}/{item.qty} redeemed
                  {item.unredeemedQty > 0 && (
                    <span className={isRefund ? 'text-rose-700 dark:text-rose-300 ml-1' : 'text-amber-700 dark:text-amber-300 ml-1'}>
                      · ฿{item.unredeemedValueTHB} unused
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Credit balance for prepaid_credit */}
        {reconciliation.mode === 'prepaid_credit' && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Loaded credit</span>
            <span className="tabular-nums font-medium">฿{reconciliation.paidTHB}</span>
          </div>
        )}

        {/* Redeemed total */}
        <div className="flex items-center justify-between text-sm border-t pt-2.5">
          <span className="text-muted-foreground">Redeemed</span>
          <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
            ฿{reconciliation.totalRedeemedTHB}
          </span>
        </div>

        {/* Unused amount + outcome */}
        {hasUnused ? (
          <div
            className={`rounded-lg px-3 py-2.5 flex items-center justify-between ${
              isRefund
                ? 'bg-rose-500/10 border border-rose-500/20'
                : 'bg-amber-500/10 border border-amber-500/20'
            }`}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              {isRefund ? (
                <Undo2 className="w-4 h-4 text-rose-700 dark:text-rose-300 shrink-0" />
              ) : (
                <Ban className="w-4 h-4 text-amber-700 dark:text-amber-300 shrink-0" />
              )}
              <span className={isRefund ? 'text-rose-800 dark:text-rose-200' : 'text-amber-800 dark:text-amber-200'}>
                {isRefund ? 'Refund to parent' : 'Forfeited'}
              </span>
            </span>
            <span
              className={`text-xl font-black tabular-nums ${isRefund ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300'}`}
            >
              {isRefund ? '−' : ''}฿{reconciliation.totalUnusedTHB}
            </span>
          </div>
        ) : (
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-200">
            <Check className="w-4 h-4 shrink-0" />
            All prepaid food was fully redeemed — no outstanding balance.
          </div>
        )}

        {/* Policy note */}
        {hasUnused && (
          <p className="text-xs text-muted-foreground">
            {isRefund
              ? 'A refund will be recorded in Order History and returned to the original payment method.'
              : 'The unused amount is forfeited per venue policy and recorded for the end-of-day report.'}
          </p>
        )}
      </div>
    </div>
  );
}
