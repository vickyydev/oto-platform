import { CloudOff } from 'lucide-react';
import type { QuoteError } from '@/lib/cartQuote';

/**
 * THE PLATFORM BROKE WHILE PRICING THIS ORDER, WHICH IS NOT A JUDGEMENT ON IT —
 * SCRUM-351.
 *
 * The other half of `QuoteRefusalNote`. A refusal is about the order and turns
 * the charge button off; this is the platform's own failure — its 5xx envelope,
 * a status text from a proxy when nothing of ours ran — and it stops nothing.
 * The order keeps this till's figures and can still be charged, which is the
 * whole point of having them.
 *
 * WHY IT IS DRAWN AT ALL, with `PriceSourceNote` (components/till/
 * SaleWriteStatus.tsx) directly beneath it: that note says the figure on the
 * screen is this till's, and it says that for every order the platform did not
 * price, the ordinary ones included — no station on this device yet, no pricing
 * route on this deployment. What it cannot say is that the platform was asked
 * and broke, and it never carries the platform's own words. Only that case is
 * somebody's to fix, and those words are the thing to read out when reporting
 * it. So this note says what happened and the note below says whose figure is
 * on the screen; neither repeats the other's sentence.
 *
 * Quiet on purpose, in the panel's own vocabulary for a fact that needs no
 * action at the counter — the neutral tint of the "recorded, unpaid" note in
 * `components/till/SaleWriteStatus.tsx`. Rose is the colour of an order that
 * cannot be sold, and this one can.
 */
export function QuoteFaultNote({ error }: { error: QuoteError | null }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-foreground/15 bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">
      <CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-semibold text-foreground">The platform failed, not this order.</span>{' '}
        {error.status !== null ? `${error.message} (${error.status})` : error.message}
        <span className="mt-1 block">Charge as normal.</span>
      </span>
    </div>
  );
}
