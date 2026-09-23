import { AlertTriangle } from 'lucide-react';
import type { QuoteError } from '@/lib/cartQuote';

/**
 * THE PLATFORM LOOKED AT THIS ORDER AND OBJECTED — S2-09b.
 *
 * A refusal at the quote is not a plumbing failure and must not be drawn as
 * one: it means the order as it stands cannot be sold, and the reason is
 * usually something staff can fix in a tap — a required choice nobody made, a
 * menu price that moved while the order was being taken, an item withdrawn from
 * the catalogue. The figure beside it is then this till's own, which
 * `PriceSourceNote` says directly underneath.
 *
 * Drawn in the same vocabulary as the rest of the station's notices: a tinted
 * rounded panel with a border and an icon. Nothing here is a new visual idea.
 *
 * `blocking` says the charge button is off while this stands (SCRUM-342), so
 * the note tells the person at the counter what the disabled button is waiting
 * for instead of leaving them to guess. The caller decides: the station that
 * turns the button off passes it, one that only reports the refusal does not.
 *
 * The ink is the light back office's (`text-rose-700`, the recipe SCRUM-346
 * took for the same reason) with the prototype's `rose-200` kept behind
 * `dark:`. The prototype rendered on a dark surface and this port renders
 * light, so pale rose on a rose tint was pale-on-pale here — measured at 1.13:1
 * against the panel, which is no contrast at all. Rose stays: it is the colour
 * of an order that cannot be sold, and `QuoteFaultNote` beside it is neutral
 * for the opposite reason (SCRUM-359).
 *
 * SCRUM-351 gave the hook a typed error, and this note prints `.message` — the
 * platform's own words, the string this prop used to be — so its wording is
 * what it was before that ticket. It draws whatever it is handed and does not
 * read the kind: the F&B station (`pages/OrderStation.tsx`) hands it refusals
 * only and draws a fault in `QuoteFaultNote` beside it, while the shop station
 * (`pages/MerchStation.tsx`) still hands over both, unchanged by that ticket and
 * with a fault still shown here as a refusal until it is given the same
 * treatment.
 */
export function QuoteRefusalNote({
  error,
  blocking = false,
}: {
  error: QuoteError | null;
  blocking?: boolean;
}) {
  if (!error) return null;
  const message = error.message;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-semibold">The platform refused this order:</span> {message}
        {blocking && (
          <span className="mt-1 block text-rose-700/80 dark:text-rose-200/80">
            Fix this to charge — the sale would be refused for the same reason.
          </span>
        )}
      </span>
    </div>
  );
}
