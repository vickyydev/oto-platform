import { TicketType, CustomerTier } from '@/types';
import { priceForTier } from '@/lib/pricing';
import { Card } from '@/components/ui/card';
import { Clock } from 'lucide-react';
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
 */
export function TicketCard({ ticket, tier, onClick, selected }: TicketCardProps) {
  const { t, lang } = useLanguage();
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
          <div className="font-bold text-xl text-primary">฿{priceForTier(ticket, tier)}</div>
          <div className="text-xs text-muted-foreground">{t('book.tickets.perPerson')}</div>
        </div>
      </div>
    </Card>
  );
}
