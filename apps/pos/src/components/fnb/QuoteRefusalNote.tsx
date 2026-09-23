import { AlertTriangle } from 'lucide-react';

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
 */
export function QuoteRefusalNote({
  error,
  blocking = false,
}: {
  error: string | null;
  blocking?: boolean;
}) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-semibold">The platform refused this order:</span> {error}
        {blocking && (
          <span className="mt-1 block text-rose-200/80">
            Fix this to charge — the sale would be refused for the same reason.
          </span>
        )}
      </span>
    </div>
  );
}
