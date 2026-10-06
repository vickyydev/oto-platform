import { AlertTriangle, CloudOff, Loader2, ReceiptText, RefreshCw, ServerCrash } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { SaleFailureCause, SaleWriteState } from '@/lib/saleWriter';
import { isStockRefusalCode, stockRefusalAdvice } from '@/lib/stockRefusal';
import type { CartQuote } from '@/api/sales';

/**
 * WHAT THE SCREEN SAYS WHEN A SALE DOES NOT SAVE — S2-09a (SCRUM-203).
 *
 * "Failed" with money on the counter is the worst moment in this product, and
 * the thing that makes it worse is ambiguity: reception cannot tell whether to
 * charge again, and a toast that has already faded tells them nothing. So these
 * are panels, they stay on screen, and each one says the same three things —
 * what happened, whether the visitor has been charged twice, and what to press.
 *
 * Design: the prototype's own vocabulary — a tinted rounded panel with a border
 * and an icon, the same shape as the QR-pending note in `StepPayment` and the
 * harness banner in `Till`. Nothing here is a new visual idea.
 *
 * The tints are the prototype's, but its inks were not: it rendered on a dark
 * surface, so `rose-200` and `amber-200` on a 10% tint of the same hue were
 * legible there and pale-on-pale once this port went light — the failure
 * headline and `PriceSourceNote` measured 1.13:1 and 1.07:1 against their own
 * panels. Both now take the light back office's deep ink (SCRUM-346's recipe)
 * with the prototype's shade kept behind `dark:`, so the dark theme is
 * untouched (SCRUM-359). Amber goes a step deeper than rose because it is the
 * lighter hue: measured on the cream ground, `amber-700` on this tint reaches
 * only 4.33:1 where `rose-700` reaches 4.83:1, so the source note takes
 * `amber-800` and the pair reads alike. `SaleNotSavedNotice` below still
 * carries the pale pair and wants the same treatment; it was outside that
 * ticket.
 */

/**
 * WHAT TO DO ABOUT THIS FAILURE, in the words the cause earns.
 *
 * Three of these four were one sentence before — "trying again will not help,
 * go back, check the order, call a manager" — said to reception whenever the
 * platform answered 409, including the two 409s that mean the opposite of a
 * judgement about the cart. A person sent to a manager over a burnt
 * idempotency key learns to distrust the panel, and the one refusal that really
 * does need a manager then reads like all the others.
 */
function advice(cause: SaleFailureCause): ReactNode {
  switch (cause) {
    case 'connection':
      return (
        <>
          <span className="font-semibold text-foreground">Try again.</span> Nothing answered, so
          this sale may already be saved — trying again finishes that same one. The till sends the
          same sale number every time, so the visitor cannot be charged twice however many times
          this is pressed.
        </>
      );
    case 'in-flight':
      return (
        <>
          <span className="font-semibold text-foreground">Wait a moment, then try again.</span> The
          platform is still working on the first attempt of this sale; the next press shows that
          attempt&apos;s answer rather than starting anything new.
        </>
      );
    case 'stale-key':
      return (
        <>
          <span className="font-semibold text-foreground">Try again.</span> This sale&apos;s number
          was already spent on a different version of the order. The next attempt goes under a new
          number and carries the same press with it, so if the first one did land, the platform
          refuses the second rather than recording two sales.
        </>
      );
    case 'refused':
      return (
        <>
          <span className="font-semibold text-foreground">Trying again will not help</span> — the
          platform looked at this sale and refused it. Go back, check the order, and call a manager
          if it still refuses.
        </>
      );
  }
}

export function SaleWriteFailure({
  state,
  onRetry,
  onDismiss,
}: {
  state: SaleWriteState;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (state.kind === 'writing' || state.kind === 'finalising') {
    return (
      <div className="mt-6 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/10 p-4 text-sm">
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
        <span className="text-muted-foreground">
          <span className="font-bold text-foreground">
            {state.kind === 'writing' ? 'Saving the sale…' : 'Recording the payment…'}
          </span>{' '}
          Don&apos;t hand over the receipt until this is confirmed.
        </span>
      </div>
    );
  }

  /**
   * The order is on the platform and the money is not. It is the ordinary state
   * of the payment screen from now on, so it is said quietly — but it is said,
   * because it is the difference between "nothing is recorded" and "everything
   * is recorded except that they paid", and only one of those needs chasing if
   * the till dies at this moment.
   */
  if (state.kind === 'committed') {
    return (
      <div className="mt-6 flex items-center gap-3 rounded-xl border border-foreground/15 bg-foreground/5 p-4 text-sm">
        <ReceiptText className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          <span className="font-bold text-foreground">This order is recorded, unpaid.</span>{' '}
          Confirming the money is what gives it a receipt number.
        </span>
      </div>
    );
  }

  if (state.kind !== 'failed') return null;

  // S2-14b round 4 (Q1): a refusal of the cart's stock — the platform's at
  // commit, or the counter's box at the money press — took nothing and saved
  // nothing anywhere, whichever call it answered. Its words stand as they came.
  const stockRefused = isStockRefusalCode(state.code);
  const headline =
    state.stage === 'commit' || stockRefused
      ? 'This sale has not been saved.'
      : 'The payment has not been recorded.';

  return (
    <div className="mt-6 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
      <div className="flex items-start gap-3">
        <ServerCrash className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-bold text-rose-700 dark:text-rose-200">{headline}</div>
          {state.stage === 'finalise' && !stockRefused && (
            <p className="mt-1 text-sm text-muted-foreground">
              The order itself is saved on the platform, as unpaid and without a receipt number.
            </p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {stockRefused && state.code ? stockRefusalAdvice(state.code) : advice(state.cause)}
          </p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">Sale {state.saleId}</p>
          <div className="mt-4 flex items-center gap-3">
            {state.retryable && (
              <Button size="lg" className="gap-2 font-bold" onClick={onRetry}>
                <RefreshCw className="h-4 w-4" />
                Try again
              </Button>
            )}
            <Button variant="outline" size="lg" onClick={onDismiss}>
              Back to the order
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The sale was taken while this deployment has no sales ledger.
 *
 * It is a certainty, not a doubt — the route does not exist, so nothing was
 * half-written and no retry can change it. The alternative to saying so is a
 * confirmation screen that looks exactly like a saved sale, which is what the
 * till did before this ticket.
 */
export function SaleNotSavedNotice({ state }: { state: SaleWriteState }) {
  if (state.kind !== 'unwritten') return null;
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      <CloudOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0">
        <div className="font-bold text-amber-800 dark:text-amber-200">Saved on this till only.</div>
        <p className="mt-1 text-muted-foreground">
          {state.reason} The order below is real and the visitor has been served, but it is not in
          the platform&apos;s sales ledger and a refresh of this browser loses it.
        </p>
      </div>
    </div>
  );
}

/**
 * WHERE THE FIGURE ON THIS SCREEN CAME FROM, and what the platform changed
 * about it.
 *
 * Nothing is drawn when the platform priced the cart and agreed with
 * everything the till sent, so the approved layout is unchanged in normal use.
 * Two things break that silence, and both are things the person taking the
 * money would otherwise have no way of knowing:
 *
 *   - the figure was worked out HERE, not by the platform;
 *   - the platform priced it, but not the way this screen describes it — a
 *     promo code it would not honour, a tier or a rate mode it resolved
 *     differently. The amount shown is the platform's either way.
 */
export function PriceSourceNote({ quote, pending }: { quote: CartQuote; pending: boolean }) {
  if (quote.source === 'platform') {
    if (!quote.platformNotice) return null;
    return (
      <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">
          <span className="font-semibold">The platform priced this differently:</span>{' '}
          {quote.platformNotice}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-semibold">Priced on this till.</span>{' '}
        {pending ? 'Checking with the platform…' : (quote.reason ?? 'The platform did not price this cart.')}
      </span>
    </div>
  );
}
