import { useEffect } from 'react';
import { ArrowLeft, Receipt } from 'lucide-react';
import { useOperator } from '@/auth/OperatorContext';
import {
  KEPT_SALE_RUNG_UP_LINE,
  keptSaleElsewhere,
  keptSaleOfferAsk,
  keptSaleOfferLine,
  type KeptSaleOffer,
} from '@/auth/sessionEnd';
import { Button } from '@/components/ui/button';
import { InactivityWarning } from '@/components/auth/InactivityWarning';
import { useStation } from '@/station/StationContext';

/**
 * SCRUM-878 — A SALE KEPT FROM AN ENDED SESSION, OFFERED TO THE NEXT PERSON.
 *
 * A staff session ended on the platform with a sale on this till's screen, and
 * a different person has now signed in here. The sale is theirs only if they
 * say so: who started it and when is said plainly, and they continue it or
 * discard it. Until they answer, the till stays locked over it and shows none
 * of it (`auth/sessionEnd.ts`).
 *
 * Drawn in the lock screen's own layout and styles (its icon tile, title,
 * notice line, primary button and dashed button), as one more state of it.
 *
 * A sale already rung up is offered to continue only, with a second line
 * saying a payment may be waiting on the customer display: discarding it here
 * would clear the display's QR and leave the sale open on the platform, where
 * the new person could neither finish it (only the one who rang it up may
 * resume it as a left-behind sale) nor void it once money is taken.
 *
 * Only ever at the station the sale was on: if the station is let go while
 * the platform is asked to seat this session there (`StationContext`'s
 * `reseat`), the sale is dropped and the picker asks, as for any sign-in.
 *
 * The person who signed in is signed in, so the offer locks after the same
 * inactivity as any signed-in screen, with the same "Locking soon" warning
 * (`InactivityWarning`): the till locks in the ordinary way, and the offer is
 * shown again after the password (`auth/OperatorContext.tsx`).
 */
export function KeptSaleOfferScreen({ offer }: { offer: KeptSaleOffer }) {
  const { continueKept, discardKept } = useOperator();
  const { station, resolved } = useStation();
  const elsewhere = keptSaleElsewhere(offer, { stationId: station?.stationId ?? null, resolved });
  useEffect(() => {
    if (elsewhere) discardKept();
  }, [elsewhere, discardKept]);

  return (
    <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-background text-foreground px-6 overflow-y-auto">
      <div className="w-full max-w-md flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-500 py-8">
        <div className="relative w-24 h-24 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-6 shadow-2xl shadow-primary/30">
          <Receipt className="w-12 h-12" />
        </div>
        <h1 className="text-4xl font-black tracking-tight mb-2">A sale is open on this till</h1>
        <p className="text-lg text-foreground/60 mb-8">{keptSaleOfferAsk(offer)}</p>
        <p role="status" data-testid="kept-sale-offer"
          className="-mt-4 mb-6 w-full rounded-2xl border border-amber-500/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300 text-left">
          {keptSaleOfferLine(offer)}
        </p>
        {/* Rung up: a payment may be waiting on the customer display, so the
            sale is continued and its payment read back, never discarded here. */}
        {offer.rungUpSaleId && (
          <p role="status" data-testid="kept-sale-rung-up"
            className="-mt-2 mb-6 w-full rounded-2xl border border-amber-500/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300 text-left">
            {KEPT_SALE_RUNG_UP_LINE}
          </p>
        )}
        <Button type="button" size="lg" className="h-16 text-lg gap-3 rounded-2xl w-full mt-2" onClick={continueKept}>
          <Receipt className="w-6 h-6" />
          Continue this sale
        </Button>
        {!offer.rungUpSaleId && (
          <button
            type="button"
            onClick={discardKept}
            className="mt-8 inline-flex items-center justify-center gap-2 w-full h-12 rounded-2xl border border-dashed border-foreground/20 text-foreground/60 hover:text-foreground hover:border-foreground/40 transition-colors text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Discard it and start a new sale
          </button>
        )}
      </div>
      <InactivityWarning />
    </div>
  );
}
