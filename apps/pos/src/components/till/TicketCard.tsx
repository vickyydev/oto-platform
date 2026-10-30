import { TicketType, CustomerTier } from '@/types';
import { tierPriceTHB, unpricedReason } from '@/lib/pricing';
import { Card } from '@/components/ui/card';
import { Clock, AlertTriangle } from 'lucide-react';
import type { SupportedLang } from '@/i18n/types';
import { ticketCardCopy } from '@/lib/ticketCardCopy';

interface TicketCardProps {
  ticket: TicketType;
  tier: CustomerTier;
  onClick: () => void;
  selected?: boolean;
  /**
   * The customer's language, on a customer-facing surface only (the /book
   * picker). Left out on the staff till, which shows the original name and
   * English captions whatever the customer display panel beside it is set to:
   * the till and that panel share one LanguageProvider, so reading the context
   * here turned the staff cards Russian with the display (SCRUM-698).
   */
  lang?: SupportedLang;
}

/**
 * Shared ticket card (staff till + customer /book picker). The words come
 * from `ticketCardCopy`: translated for a customer surface that names its
 * language, the original name and English for staff.
 *
 * THE REFUSAL IS HERE — SCRUM-228. A tier nobody has priced on this ticket used
 * to draw ฿0 on a card that added itself to the cart like any other, and the
 * sale then travelled the whole way to "Please pay ฿0" on the visitor's screen,
 * where the only thing standing between it and a free day out was the
 * platform's generic price-mismatch check at the write. The choice is refused at
 * the moment it is made instead: the card carries no figure, says which price is
 * missing and where it is set, and does not answer a press.
 */
export function TicketCard({ ticket, tier, onClick, selected, lang }: TicketCardProps) {
  const copy = ticketCardCopy(ticket, lang);
  const price = tierPriceTHB(ticket, tier);

  if (price === null) {
    return (
      <Card aria-disabled="true" className="p-6 border-dashed cursor-not-allowed opacity-70">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="font-bold text-xl">{copy.name}</h3>
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
          <h3 className="font-bold text-xl">{copy.name}</h3>
          <div className="flex items-center text-muted-foreground text-sm mt-1 gap-1">
            <Clock className="h-4 w-4" />
            <span>{ticket.durationLabel}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold text-xl text-primary">฿{price}</div>
          <div className="text-xs text-muted-foreground">{copy.perPerson}</div>
        </div>
      </div>
    </Card>
  );
}
