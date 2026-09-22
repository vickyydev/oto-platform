import { TicketType, CustomerTier } from '@/types';
import { tierPriceTHB, unpricedReason } from '@/lib/pricing';
import { Card } from '@/components/ui/card';
import { Clock, AlertTriangle } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import { resolveName } from '@/i18n/resolveTranslation';

interface TicketCardProps {
  ticket: TicketType;
  tier: CustomerTier;
  onClick: () => void;
  selected?: boolean;
}

/**
 * Shared ticket card (staff till + customer /book picker). Customer-facing
 * surfaces select a language, so the name resolves through the catalog's
 * translations and the caption through the dictionary; staff surfaces never
 * change language (LanguageContext stays 'en'), so the till is unaffected.
 *
 * THE REFUSAL IS HERE — SCRUM-228. A tier nobody has priced on this ticket used
 * to draw ฿0 on a card that added itself to the cart like any other, and the
 * sale then travelled the whole way to "Please pay ฿0" on the visitor's screen,
 * where the only thing standing between it and a free day out was the
 * platform's generic price-mismatch check at the write. The choice is refused at
 * the moment it is made instead: the card carries no figure, says which price is
 * missing and where it is set, and does not answer a press.
 */
export function TicketCard({ ticket, tier, onClick, selected }: TicketCardProps) {
  const { t, lang } = useLanguage();
  const price = tierPriceTHB(ticket, tier);

  if (price === null) {
    return (
      <Card aria-disabled="true" className="p-6 border-dashed cursor-not-allowed opacity-70">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="font-bold text-xl">{resolveName(ticket, lang)}</h3>
            <div className="flex items-center text-muted-foreground text-sm mt-1 gap-1">
              <Clock className="h-4 w-4" />
              <span>{ticket.durationLabel}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="font-bold text-xl text-muted-foreground">—</div>
            <div className="text-xs text-muted-foreground">Not priced</div>
          </div>
        </div>
        <div className="flex items-start gap-2 text-xs font-medium text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{unpricedReason(ticket.name, tier)}</span>
        </div>
      </Card>
    );
  }

  return (
    <Card
      className={`p-6 cursor-pointer transition-all active:scale-[0.98] ${selected ? 'border-primary bg-primary/10 shadow-md ring-1 ring-primary' : 'hover:border-primary/50'}`}
      onClick={onClick}
    >
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="font-bold text-xl">{resolveName(ticket, lang)}</h3>
          <div className="flex items-center text-muted-foreground text-sm mt-1 gap-1">
            <Clock className="h-4 w-4" />
            <span>{ticket.durationLabel}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold text-xl text-primary">฿{price}</div>
          <div className="text-xs text-muted-foreground">{t('book.tickets.perPerson')}</div>
        </div>
      </div>
    </Card>
  );
}
