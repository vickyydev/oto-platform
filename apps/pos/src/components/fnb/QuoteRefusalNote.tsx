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
 */
export function QuoteRefusalNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-semibold">The platform refused this order:</span> {error}
      </span>
    </div>
  );
}
