import { Check, UtensilsCrossed, Undo2, Ban, Wallet } from 'lucide-react';
import { type PrepaidFoodReconciliation } from '@/lib/dropoff';

interface FoodReconciliationSummaryProps {
  reconciliation: PrepaidFoodReconciliation;
  policy: 'refund' | 'forfeit';
  /**
   * SCRUM-1021 — what the child's band can still spend, from the platform
   * (`bandCreditSatang` on the release context, in baht here). Absent where
   * nobody answered it (the box's offline copy): the unused prepaid figure
   * stands in for it.
   */
  bandCreditTHB?: number | null;
}

/**
 * SCRUM-1021 — "You still have X baht remaining" (the owner's answer of 19
 * November), for staff to tell the parent at pickup. Wording and one figure:
 * nothing is printed or sent, and what happens to the money is the park's
 * refund-or-forfeit setting, unchanged. Shown on its own for a child whose
 * band holds credit but who prepaid no food (an Eat & Play ticket's credit).
 * No line about how long it lasts: that is the park's wallet expiry setting,
 * unchanged ("as today" in the owner's answer).
 */
export function BandCreditRemaining({ remainingTHB }: { remainingTHB: number }) {
  return (
    <div className="rounded-xl border bg-muted/30 px-4 py-3">
      <div className="rounded-lg px-3 py-2.5 flex items-center justify-between bg-sky-500/10 border border-sky-500/20">
        <span className="flex items-center gap-2 text-sm font-semibold text-sky-800 dark:text-sky-200">
          <Wallet className="w-4 h-4 text-sky-700 dark:text-sky-300 shrink-0" />
          You still have ฿{remainingTHB} remaining
        </span>
      </div>
    </div>
  );
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
  bandCreditTHB,
}: FoodReconciliationSummaryProps) {
  const isRefund = policy === 'refund';
  const hasUnused = reconciliation.totalUnusedTHB > 0;
  // SCRUM-1021 — where the park does not refund, the credit stays on the
  // band: staff say what is left, in place of "Forfeited".
  const remainingTHB = bandCreditTHB ?? reconciliation.totalUnusedTHB;
  const showRemaining = !isRefund && remainingTHB > 0;
  // Where the park refunds, the refund takes back the unused prepaid food and
  // the rest stays on the band (the ticket's own credit): staff say that too,
  // once the platform answered what the band holds.
  const leftAfterRefundTHB = isRefund && bandCreditTHB != null
    ? Math.max(0, bandCreditTHB - reconciliation.totalUnusedTHB) : 0;

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
        {showRemaining ? (
          <div className="rounded-lg px-3 py-2.5 flex items-center justify-between bg-amber-500/10 border border-amber-500/20">
            <span className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
              <Wallet className="w-4 h-4 text-amber-700 dark:text-amber-300 shrink-0" />
              You still have ฿{remainingTHB} remaining
            </span>
          </div>
        ) : hasUnused ? (
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

        {leftAfterRefundTHB > 0 && (
          <div className="rounded-lg px-3 py-2.5 flex items-center justify-between bg-sky-500/10 border border-sky-500/20">
            <span className="flex items-center gap-2 text-sm font-semibold text-sky-800 dark:text-sky-200">
              <Wallet className="w-4 h-4 text-sky-700 dark:text-sky-300 shrink-0" />
              You still have ฿{leftAfterRefundTHB} remaining
            </span>
          </div>
        )}

        {/* Policy note */}
        {!showRemaining && hasUnused && (
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
