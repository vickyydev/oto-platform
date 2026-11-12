import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Narrower than a paired display (56rem), the amount block is drawn a step
 * smaller: the same components with the spacing scale at four-fifths (so the
 * w-64 QR stays 204px, a size any banking app scans) and each text size one
 * step down the theme's own scale. A paired display is never touched.
 */
const COMPACT_AMOUNT = [
  '@max-4xl:[--spacing:0.2rem]',
  '@max-4xl:[--text-7xl:3rem]',
  '@max-4xl:[--text-6xl:3rem]',
  '@max-4xl:[--text-5xl:2.25rem]',
  '@max-4xl:[--text-4xl:1.875rem]',
  '@max-4xl:[--text-3xl:1.5rem]',
  '@max-4xl:[--text-2xl:1.25rem]',
  '@max-4xl:[--text-xl:1.125rem]',
  '@max-4xl:[--text-lg:1rem]',
].join(' ');

/**
 * SCRUM-859 — THE PAYMENT STAGE SHOWS THE WHOLE ORDER WITH THE AMOUNT.
 *
 * The owner, 8 and 12 November: "The customer-facing payment screen should
 * show the full order details, not just the final amount." Every customer
 * display drew the lines on its order stage and then, at the moment the family
 * paid, only "Please pay ฿X" or the QR: what they were paying for had just
 * left the screen.
 *
 * One frame for the displays that take a payment (ticket till, F&B, shop,
 * tender, the event pass), on the split view's customer half, a paired display
 * and the phone-width till alike. Each display puts its own order stage's line
 * cards and footer rows into `lines` and `summary` (its own components and
 * wording, so no list is written twice) and its payment block into the three
 * slots `lead`, `aside` and `children`: the words above the figure, the QR
 * card, and the figure with what follows it. A display with nothing to put in
 * `aside` (cash) leaves it out.
 *
 * THE FAMILY READS THE ORDER AND THE AMOUNT AT ONCE, wherever the display is
 * drawn. The frame follows its OWN width (a container query, never the
 * viewport: the split view's half is half a screen):
 * - 56rem and wider (a paired display in landscape, the half of a wide split
 *   view): two columns — the order on the left, scrolling inside itself, and
 *   the amount in a 26rem column of its own on the right;
 * - 42rem to 56rem (the half of a 1440 split view): the same two columns, the
 *   amount's a 20rem one drawn compact (`COMPACT_AMOUNT`). Stacked, a QR and
 *   the order's footer left the lines a strip under one card high on a 900px
 *   screen (the staging proof of 12 November);
 * - narrower: stacked — the lines scroll in their own area, never less than
 *   one card high from 36rem and 6rem under it, above the footer and the
 *   compact amount block. From 36rem the QR card sits beside its words; under
 *   that (the phone-width till) everything is in one column and the header
 *   row's padding is halved.
 * On a screen too short for all of it, the amount block scrolls within itself
 * from the top (its words, the QR, the figure first) rather than off the
 * screen, and the lines keep their minimum.
 *
 * `data-testid`s: `customer-payment` (the frame), `payment-order-lines` (the
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
    <div className="@container flex-1 min-h-0 flex flex-col" data-testid="customer-payment">
      {/* The phone-width till: the header row keeps half its height of padding,
          so the QR and the figure stand above the hand-back bar. */}
      {header && <div className="shrink-0 @max-xl:[&>*]:py-4!">{header}</div>}
      <div className="flex-1 min-h-0 flex flex-col @2xl:flex-row">
        {/* Stacked, the order's box steps aside (`contents`) so its list, its
            footer and the amount block share one column: the list keeps its
            minimum, the footer its height, and only the amount block gives
            way (scrolling within itself) on a screen too short for all three. */}
        <section className="contents @2xl:flex @2xl:flex-1 @2xl:min-h-0 min-w-0 @2xl:flex-col" data-testid="payment-order">
          {/* Narrower than a paired display a card's long option name wraps
              rather than ending in "…": the family reads the whole order. */}
          <div
            className="flex-1 min-h-24 @xl:min-h-56 @2xl:min-h-0 overflow-y-auto px-8 py-4 @2xl:py-8 space-y-4 @max-4xl:[&_.truncate]:whitespace-normal"
            data-testid="payment-order-lines"
          >
            {lines}
          </div>
          {summary && (
            <div className="shrink-0 px-8 py-3 @2xl:py-5 border-t border-foreground/10" data-testid="payment-order-summary">
              {summary}
            </div>
          )}
        </section>
        <section
          className={cn(
            'shrink min-h-0 overflow-y-auto @2xl:shrink-0 @2xl:w-[20rem] @4xl:w-[26rem] flex flex-col border-t border-foreground/10 @2xl:border-t-0 @2xl:border-l px-8 @2xl:px-6 @4xl:px-8 py-6 animate-in fade-in zoom-in-95 duration-500',
            COMPACT_AMOUNT,
          )}
          data-testid="payment-amount"
        >
          <div
            className={cn(
              'my-auto w-full grid grid-cols-1 justify-items-center text-center',
              aside && '@xl:grid-cols-[auto_1fr] @xl:items-center @xl:gap-x-10 @2xl:grid-cols-1 @2xl:gap-x-0',
            )}
          >
            {lead && (
              <div className={cn('w-full flex flex-col items-center', aside && '@xl:col-start-2 @2xl:col-start-auto')}>{lead}</div>
            )}
            {aside && (
              <div className="flex flex-col items-center @xl:col-start-1 @xl:row-start-1 @xl:row-span-2 @2xl:col-start-auto @2xl:row-start-auto @2xl:row-span-1">
                {aside}
              </div>
            )}
            <div className={cn('w-full flex flex-col items-center min-w-0', aside && '@xl:col-start-2 @2xl:col-start-auto')}>{children}</div>
          </div>
        </section>
      </div>
    </div>
  );
}
