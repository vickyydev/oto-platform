import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * SCRUM-859 — THE PAYMENT STAGE SHOWS THE WHOLE ORDER WITH THE AMOUNT.
 *
 * The owner, 8 and 12 November: "The customer-facing payment screen should
 * show the full order details, not just the final amount." Every customer
 * display drew the lines on its order stage and then, at the moment the family
 * paid, only "Please pay ฿X" or the QR: what they were paying for had just
 * left the screen.
 *
 * One frame for the four displays (ticket till, F&B, shop, tender), on the
 * split view's customer half and on a paired display alike. Each display puts
 * its own order stage's line cards and footer rows into `lines` and `summary`
 * (its own components and wording, so no list is written twice) and its
 * payment block into the three slots `lead`, `aside` and `children`: the words
 * above the figure, the QR card, and the figure with what follows it. A
 * display with nothing to put in `aside` (cash) leaves it out.
 *
 * THE FRAME HOLDS WHEREVER THE DISPLAY IS DRAWN. It follows its OWN width (a
 * container query, never the viewport: the split view's half is half a screen):
 * - 56rem and wider (a paired display in landscape, the half of a wide split
 *   view): two columns — the order on the left, scrolling inside itself, and
 *   the amount in a column of its own on the right;
 * - narrower: stacked — the lines scroll in their own area above the footer
 *   and the amount block, which keep their size, so a long order never pushes
 *   the amount or the QR off the screen. From 36rem (the half of a 1440 split
 *   view) the QR card sits beside its words so the lines keep more of the
 *   height; under that (the phone-width till) everything is in one column.
 * On a screen too short for even that, the amount block shrinks and scrolls
 * within itself rather than off the screen, and the lines keep a minimum of
 * their own.
 *
 * `data-testid`s: `payment-stage` (the frame), `payment-order-lines` (the
 * scrolling list), `payment-order-summary` (the footer rows) and
 * `payment-amount` (the block the family pays from).
 */
export function PaymentStageLayout({
  header,
  lines,
  summary,
  lead,
  aside,
  children,
}: {
  /** The order stage's own header row (the brand and "Your Order"). */
  header?: ReactNode;
  /** The order stage's own line cards. */
  lines: ReactNode;
  /** The order stage's own footer rows: discounts, tax and the total. */
  summary?: ReactNode;
  /** What stands above the figure: the "Scan to Pay" words, or the wallet icon. */
  lead?: ReactNode;
  /** The QR card. Left out for a payment with nothing to scan. */
  aside?: ReactNode;
  /** The figure and what follows it: the timer, the method, the waiting line. */
  children: ReactNode;
}) {
  return (
    <div className="@container flex-1 min-h-0 flex flex-col" data-testid="payment-stage">
      {header && <div className="shrink-0">{header}</div>}
      <div className="flex-1 min-h-0 flex flex-col @4xl:flex-row">
        <section className="flex-1 min-h-40 @4xl:min-h-0 min-w-0 flex flex-col" data-testid="payment-order">
          <div className="flex-1 min-h-0 overflow-y-auto p-8 space-y-4" data-testid="payment-order-lines">
            {lines}
          </div>
          {summary && (
            <div className="shrink-0 px-8 py-5 border-t border-foreground/10" data-testid="payment-order-summary">
              {summary}
            </div>
          )}
        </section>
        <section
          className="shrink min-h-0 overflow-y-auto @4xl:shrink-0 @4xl:w-[26rem] flex flex-col border-t border-foreground/10 @4xl:border-t-0 @4xl:border-l px-8 py-6 animate-in fade-in zoom-in-95 duration-500"
          data-testid="payment-amount"
        >
          <div
            className={cn(
              'my-auto w-full grid grid-cols-1 justify-items-center text-center',
              aside && '@xl:grid-cols-[auto_1fr] @xl:items-center @xl:gap-x-10 @4xl:grid-cols-1 @4xl:gap-x-0',
            )}
          >
            {lead && (
              <div className={cn('w-full flex flex-col items-center', aside && '@xl:col-start-2 @4xl:col-start-auto')}>{lead}</div>
            )}
            {aside && (
              <div className="flex flex-col items-center @xl:col-start-1 @xl:row-start-1 @xl:row-span-2 @4xl:col-start-auto @4xl:row-start-auto @4xl:row-span-1">
                {aside}
              </div>
            )}
            <div className={cn('w-full flex flex-col items-center min-w-0', aside && '@xl:col-start-2 @4xl:col-start-auto')}>{children}</div>
          </div>
        </section>
      </div>
    </div>
  );
}
